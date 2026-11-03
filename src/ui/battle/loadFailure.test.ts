import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Suspense, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { t } from '../../content/strings';
import { memoryStorage, type KeyValue } from '../../save/storage';
import { BattleLoadBoundary } from './BattleLoadBoundary';
import { DEFAULT_CHOICE, loadChoice, storeChoice, type BattleChoice } from './BattleSetup';

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: any, public nodeValue = '') {}
  get tagName() { return this.nodeName; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): FakeNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join(' '); }
  set textContent(v: string) {
    this.childNodes = [];
    if (v) this.appendChild(new FakeNode(3, '#text', this.ownerDocument, v));
  }
  appendChild(c: FakeNode) { return this.insertBefore(c, null); }
  insertBefore(c: FakeNode, before: FakeNode | null) {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, c);
    return c;
  }
  removeChild(c: FakeNode) {
    this.childNodes.splice(this.childNodes.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
}

function fakeDom(hash: string) {
  const reload = vi.fn();
  const doc: any = new FakeNode(9, '#document', null);
  doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
  doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
  doc.body = doc.createElement('body');
  doc.documentElement = doc.createElement('html');
  doc.activeElement = doc.body;
  const win: any = {
    document: doc, location: { hash, search: '', reload }, screen: { width: 1280, height: 720 }, HTMLIFrameElement: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
  };
  doc.defaultView = win;
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  return { container: doc.createElement('div') as FakeNode, reload };
}

function buttons(node: FakeNode): FakeNode[] {
  return node.childNodes.flatMap(c => (c.nodeName === 'BUTTON' ? [c] : buttons(c)));
}

function press(node: FakeNode) {
  const key = Object.keys(node).find(k => k.startsWith('__reactProps'))!;
  (node as any)[key].onClick();
}

const TEXT = t('battle.loadError.text');
const RETRY = t('battle.loadError.retry');
const DEPLOY = t('battle.setup.deploy');
const boom = new Error('chunk 404');
const causedByBoom = (e: unknown): boolean => e instanceof Error && (e === boom || e.message.includes(boom.message) || causedByBoom(e.cause));

async function importFails(): Promise<Record<string, unknown>> {
  throw boom;
}

describe('battle chunk load failure (#218)', () => {
  let root: Root;
  let dom: ReturnType<typeof fakeDom>;
  let logged: ReturnType<typeof vi.spyOn>;
  const mount = (el: ReactElement) => {
    root = createRoot(dom.container as unknown as HTMLElement);
    root.render(el);
  };
  const expectErrorScreen = async () => {
    await vi.waitFor(() => expect(dom.container.textContent).toContain(TEXT));
    expect(buttons(dom.container).map(b => b.textContent)).toEqual([RETRY]);
    expect(logged.mock.calls.flat().some(causedByBoom)).toBe(true);
    expect(dom.reload).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.resetModules();
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    root?.unmount();
    vi.doUnmock('../../assets/loader');
    vi.doUnmock('./Battle');
    vi.doUnmock('./loadBattle');
    vi.restoreAllMocks();
    vi.stubGlobal('sessionStorage', undefined);
  });

  async function app(hash: string, battle: () => Promise<Record<string, unknown>>) {
    dom = fakeDom(hash);
    vi.doMock('../../assets/loader', () => ({ assets: { loadGroup: async () => {} } }));
    vi.doMock('./Battle', battle);
    const { App } = await import('../../App');
    mount(createElement(App));
  }

  it('shows the retry screen when the screen chunk fails, and only reloads on the press', async () => {
    await app('#/battle', importFails);
    await vi.waitFor(() => expect(dom.container.textContent).toContain(DEPLOY));
    press(buttons(dom.container).find(b => b.textContent.includes(DEPLOY))!);
    await expectErrorScreen();
    press(buttons(dom.container)[0]);
    expect(dom.reload).toHaveBeenCalledTimes(1);
  });

  it('lands on the same error screen after a reload while the chunk is still missing', async () => {
    await app('#/battle/harek/quick', importFails);
    await expectErrorScreen();
  });

  it('lands on the error screen after a reload while only the map chunk is missing', async () => {
    await app('#/battle/harek/quick', async () => ({ checkBattleLoads: () => Promise.reject(boom) }));
    await expectErrorScreen();
  });

  it('returns to the setup screen after a reload once the chunks load', async () => {
    await app('#/battle/harek/quick', async () => ({ checkBattleLoads: async () => {} }));
    await vi.waitFor(() => expect(dom.container.textContent).toContain(DEPLOY));
    expect(dom.container.textContent).not.toContain(TEXT);
  });

  it.each([
    ['battle code', () => Promise.reject(boom)],
    ['map', () => Promise.resolve({ loadMap: () => Promise.reject(boom) })],
  ])('sends a %s failure inside the battle screen to the boundary', async (_, loadBattle) => {
    dom = fakeDom('#/battle/harek/quick');
    vi.doMock('./loadBattle', () => ({ loadBattle }));
    const { Battle } = await vi.importActual<typeof import('./Battle')>('./Battle');
    const props = { choice: { mode: 'quick', map: 'harek', side: 'coalition', time: 'day' }, touch: false, settings: {}, onSettings() {}, onSetup() {}, onTitle() {}, tips: [], onTip() {} } as unknown as Parameters<typeof Battle>[0];
    mount(createElement(BattleLoadBoundary, null, createElement(Suspense, null, createElement(Battle, props))));
    await expectErrorScreen();
  });

  it('keeps the chosen side through a reload of the app', async () => {
    const VPA = t('battle.sides.veros');
    vi.stubGlobal('sessionStorage', memoryStorage());
    await app('#/battle', async () => ({}));
    await vi.waitFor(() => expect(dom.container.textContent).toContain(VPA));
    press(buttons(dom.container).find(b => b.textContent === VPA)!);
    await vi.waitFor(() => expect(loadChoice(sessionStorage).side).toBe('veros'));
    root.unmount();
    vi.resetModules();
    await app('#/battle', async () => ({}));
    await vi.waitFor(() => expect(buttons(dom.container).find(b => b.textContent === VPA)?.attrs.class).toBe('on'));
  });
});

describe('battle choice across a reload (#218)', () => {
  const dusk: BattleChoice = { ...DEFAULT_CHOICE, side: 'veros', time: 'dusk' };

  it('restores the stored side and time', () => {
    const store = memoryStorage();
    storeChoice(dusk, store);
    expect(loadChoice(store)).toEqual(dusk);
  });

  it('falls back to the defaults on missing or broken data', () => {
    const store = memoryStorage();
    expect(loadChoice(store)).toEqual(DEFAULT_CHOICE);
    storeChoice(dusk, store);
    const [key] = store.data.keys();
    for (const bad of ['{', 'null', '[]', '{"side":"nato","time":3,"map":"moon","mode":"x"}']) {
      store.setItem(key, bad);
      expect(loadChoice(store), bad).toEqual(DEFAULT_CHOICE);
    }
  });

  it('survives storage that throws or is missing', () => {
    const broken: KeyValue = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
    expect(() => storeChoice(dusk, broken)).not.toThrow();
    expect(loadChoice(broken)).toEqual(DEFAULT_CHOICE);
    expect(() => storeChoice(dusk, null)).not.toThrow();
    expect(loadChoice(null)).toEqual(DEFAULT_CHOICE);
  });
});
