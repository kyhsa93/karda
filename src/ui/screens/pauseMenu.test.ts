import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { hasString, t, tPairs } from '../../content/strings';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STEP } from '../../sim/world';
import { loadBattle } from '../battle/loadBattle';
import { Flight } from './Flight';

vi.mock('../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));
vi.mock('../../audio/game', () => ({ GameAudio: class { voice = { enabled: false }; setVolume() {} async loadSamples() {} async resume() {} dispose() {} } }));
vi.mock('../../render/renderer', () => ({
  FlightRenderer: class {
    applySettings() {}
    toggleView() {}
    dispose() {}
  },
}));

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style: Record<string, unknown> = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: unknown, public nodeValue = '') {}
  get tagName() { return this.nodeName; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): FakeNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join(''); }
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
  replaceChildren(...c: FakeNode[]) { this.childNodes = []; for (const n of c) this.appendChild(n); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
  getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
}

function all(node: FakeNode, cls: string): FakeNode[] {
  return node.childNodes.flatMap(c => [...((c.attrs.class ?? '').split(' ').includes(cls) ? [c] : []), ...all(c, cls)]);
}

const reactProps = (node: FakeNode) => (node as unknown as Record<string, Record<string, (e?: unknown) => void>>)[Object.keys(node).find(k => k.startsWith('__reactProps'))!];
const harek = JSON.parse(harekRaw) as BattleMapDef;
const settle = () => new Promise(done => setTimeout(done, 20));
const FOUR = [t('brief.continue'), t('pause.controls'), t('pause.settings'), t('pause.quit')];

describe('pause menu (#234)', () => {
  let root: Root;
  let container: FakeNode;
  let keydown: Set<(e: unknown) => void>;

  beforeEach(() => {
    keydown = new Set();
    const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
    doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
    doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
    doc.documentElement = (doc.createElement as (t: string) => FakeNode)('html');
    doc.body = (doc.createElement as (t: string) => FakeNode)('body');
    const win = {
      document: doc, location: { hash: '', search: '' }, HTMLIFrameElement: class {}, devicePixelRatio: 1, innerWidth: 844, innerHeight: 390, scrollTo() {},
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') keydown.add(fn); },
      removeEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') keydown.delete(fn); },
    };
    doc.defaultView = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('location', win.location);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    container = (doc.createElement as (t: string) => FakeNode)('div');
  });

  afterEach(async () => {
    root.unmount();
    await settle();
    vi.unstubAllGlobals();
  });

  async function paused(touch: boolean, role: 'soldier' | 'heli') {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const world = session.world;
    const pad = runtime.spawnPoints(world).find(p => p.role === 'heli' && p.kind === 'pad')!;
    session.deploy(role === 'heli' ? runtime.spawnFor(pad, mod.KITS.closeSupport) : { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' });
    const onExit = vi.fn();
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(Flight, { session, touch, onExit }));
    await vi.waitFor(() => expect(keydown.size).toBeGreaterThan(0));
    if (touch) reactProps(all(container, 'pause')[0]).onPointerDown({ preventDefault() {}, stopPropagation() {} });
    else for (const fn of keydown) fn({ code: 'Escape', repeat: false, preventDefault() {} });
    await vi.waitFor(() => expect(all(container, 'pause-buttons')).toHaveLength(1));
    const buttons = () => all(container, 'pause-buttons')[0].childNodes;
    const labels = () => buttons().map(b => b.textContent);
    const pressLabel = async (label: string) => { reactProps(buttons().find(b => b.textContent === label)!).onClick(); await settle(); };
    return { session, runtime, world, onExit, labels, pressLabel };
  }

  it('gives the keyboard soldier exactly continue, controls, settings and quit', async () => {
    const { labels, world } = await paused(false, 'soldier');
    expect(world.avatar.kind).toBe('soldier');
    expect(labels()).toEqual(FOUR);
  });

  it('gives the keyboard pilot the same four', async () => {
    const { labels, world } = await paused(false, 'heli');
    expect(world.avatar.kind).toBe('heli');
    expect(labels()).toEqual(FOUR);
  });

  it('gives the touch soldier the same four, with no view or engine button', async () => {
    const { labels, world } = await paused(true, 'soldier');
    expect(world.avatar.kind).toBe('soldier');
    expect(labels()).toEqual(FOUR);
    expect(world.player.engineOn).toBe(false);
  });

  it('adds view and engine before quit for the touch pilot, and the engine button still works', async () => {
    const { labels, world, pressLabel } = await paused(true, 'heli');
    expect(world.avatar.kind).toBe('heli');
    const engine = t(world.player.engineOn ? 'pause.engineOff' : 'pause.engineOn');
    expect(labels()).toEqual([...FOUR.slice(0, 3), t('pause.view'), engine, t('pause.quit')]);
    const before = world.player.engineOn;
    await pressLabel(engine);
    expect(world.player.engineOn).toBe(!before);
  });

  it('keeps the match as it is through the other buttons, and quits through the same exit', async () => {
    const { runtime, session, onExit, labels, pressLabel } = await paused(false, 'soldier');
    runtime.conquest.tickets.coalition = 179;
    for (let i = 0; i < 120; i++) session.step(STEP);
    const elapsed = runtime.conquest.elapsed;
    await pressLabel(t('pause.controls'));
    await pressLabel(t('pause.settings'));
    expect(labels()).toEqual(FOUR);
    expect(runtime.conquest.tickets.coalition).toBe(179);
    expect(runtime.conquest.elapsed).toBe(elapsed);
    expect(session.mode).toBe('play');
    expect(onExit).not.toHaveBeenCalled();
    await pressLabel(t('pause.quit'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('drops the restart and voice strings and the restart note on Esc', () => {
    expect(hasString('brief.restart')).toBe(false);
    expect(hasString('brief.voiceOn')).toBe(false);
    expect(hasString('brief.voiceOff')).toBe(false);
    expect(t('pause.quit')).toBe('경기 포기');
    expect(t('brief.toList')).toBe('나가기');
    const esc = tPairs('brief.keysKeyboard').find(([k]) => k === 'Esc')!;
    expect(esc[1]).not.toContain('다시 시작');
  });
});
