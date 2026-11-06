import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import type { BattleMapDef } from '../../sim/battle/schema';
import { loadBattle } from '../battle/loadBattle';
import { Flight } from './Flight';

vi.mock('../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));
vi.mock('../../audio/game', () => ({
  GameAudio: class {
    voice = { enabled: false };
    suspended = true;
    resume = vi.fn(async () => {});
    constructor() { (globalThis as Record<string, unknown>).__audio = this; }
    setVolume() {} async loadSamples() {} dispose() {}
  },
}));
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

const reactProps = (node: FakeNode) => (node as unknown as Record<string, Record<string, (e?: unknown) => void>>)[Object.keys(node).find(k => k.startsWith('__reactProps'))!];
const harek = JSON.parse(harekRaw) as BattleMapDef;
const settle = () => new Promise(done => setTimeout(done, 20));
type Audio = { suspended: boolean; resume: ReturnType<typeof vi.fn> };

describe('audio unlock on the first input (#239)', () => {
  let root: Root;
  let container: FakeNode;
  let keydown: Set<(e: unknown) => void>;

  beforeEach(() => {
    keydown = new Set();
    delete (globalThis as Record<string, unknown>).__audio;
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

  // A quick sortie deploys after an async load, so the play-mode resume runs outside any gesture.
  async function deployedWithoutGesture(touch: boolean) {
    const mod = await loadBattle();
    const { session } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    session.deploy({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' });
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(Flight, { session, touch, onExit: () => {} }));
    await vi.waitFor(() => expect((globalThis as Record<string, unknown>).__audio).toBeDefined());
    await vi.waitFor(() => expect(keydown.size).toBeGreaterThan(0));
    const audio = (globalThis as Record<string, unknown>).__audio as Audio;
    const shell = container.childNodes[0];
    expect((shell.attrs.class ?? '').split(' ')).toContain('flight3d');
    const pointer = (phase: 'onPointerDownCapture' | 'onPointerUpCapture') => reactProps(shell)[phase]({ pointerType: touch ? 'touch' : 'mouse', preventDefault() {}, stopPropagation() {} });
    const key = () => { for (const fn of keydown) fn({ code: 'KeyW', repeat: false, preventDefault() {} }); };
    return { audio, pointer, key };
  }

  it('resumes a suspended context on the first pointerdown', async () => {
    const g = await deployedWithoutGesture(true);
    const before = g.audio.resume.mock.calls.length;
    g.pointer('onPointerDownCapture');
    expect(g.audio.resume.mock.calls.length).toBe(before + 1);
  });

  it('resumes a suspended context on the first pointerup, where a touch gesture becomes a user activation', async () => {
    const g = await deployedWithoutGesture(true);
    const before = g.audio.resume.mock.calls.length;
    g.pointer('onPointerUpCapture');
    expect(g.audio.resume.mock.calls.length).toBe(before + 1);
  });

  it('resumes a suspended context on the first keydown', async () => {
    const g = await deployedWithoutGesture(false);
    const before = g.audio.resume.mock.calls.length;
    g.key();
    expect(g.audio.resume.mock.calls.length).toBe(before + 1);
  });

  it('does nothing once the context is running', async () => {
    const g = await deployedWithoutGesture(true);
    g.audio.suspended = false;
    const before = g.audio.resume.mock.calls.length;
    g.pointer('onPointerDownCapture');
    g.pointer('onPointerUpCapture');
    g.key();
    await settle();
    expect(g.audio.resume.mock.calls.length).toBe(before);
  });
});
