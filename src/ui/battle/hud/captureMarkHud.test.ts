import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import harekRaw from '../../../content/battle/maps/harek.json?raw';
import type { FlightRenderer } from '../../../render/renderer';
import type { BattleMapDef } from '../../../sim/battle/schema';
import { STEP } from '../../../sim/world';
import { DeathReport } from '../deathReport';
import { loadBattle } from '../loadBattle';
import { BattleHud } from './BattleHud';

vi.mock('../../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));

const W = 844, H = 390;

interface Drawn { arcs: { x: number; y: number; r: number; style: string; width: number; end: number }[]; texts: { text: string; x: number; y: number; style: string }[] }

function fakeContext(drawn: Drawn) {
  const state: Record<string, unknown> = {};
  let path: { x: number; y: number; r: number; end: number } | null = null;
  const fns: Record<string, (...a: never[]) => unknown> = {
    measureText: (text: string) => ({ width: text.length * 7 }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    beginPath: () => { path = null; },
    arc: (x: number, y: number, r: number, _s: number, end: number) => { path = { x, y, r, end }; },
    stroke: () => { if (path) drawn.arcs.push({ ...path, style: String(state.strokeStyle), width: Number(state.lineWidth) }); },
    fillText: (text: string, x: number, y: number) => { drawn.texts.push({ text, x, y, style: String(state.fillStyle) }); },
    clearRect: () => { drawn.arcs.length = 0; drawn.texts.length = 0; },
  };
  return new Proxy(state, { get: (s, k: string) => fns[k] ?? (k in s ? s[k] : () => {}), set: (s, k: string, v) => { s[k] = v; return true; } });
}

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  clientWidth = W;
  clientHeight = H;
  width = 0;
  height = 0;
  context: unknown = null;
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: { drawn: Drawn } | null, public nodeValue = '') {}
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
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
  getContext() { return this.context ??= this.attrs.class === 'battle-canvas' ? fakeContext(this.ownerDocument!.drawn) : fakeContext({ arcs: [], texts: [] }); }
}

const harek = JSON.parse(harekRaw) as BattleMapDef;
const SOLDIER = { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' } as const;

describe('capture mark in the HUD frame (#228)', () => {
  let root: Root;
  let frame: () => void;
  let drawn: Drawn;

  beforeEach(() => {
    drawn = { arcs: [], texts: [] };
    const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
    doc.drawn = drawn;
    doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc as unknown as { drawn: Drawn });
    doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc as unknown as { drawn: Drawn }, text);
    doc.documentElement = (doc.createElement as (t: string) => FakeNode)('html');
    doc.body = (doc.createElement as (t: string) => FakeNode)('body');
    const win = { document: doc, location: { hash: '', search: '' }, HTMLIFrameElement: class {}, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
    doc.defaultView = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function game({ withCamera = true } = {}) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    session.deploy(SOLDIER);
    const world = session.world;
    const p = runtime.conquest.points.find(q => q.owner === 'neutral')!;
    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 5000);
    const y = world.terrain.surfaceAt(p.x, p.z) + 16;
    camera.position.set(p.x, y, p.z + 200);
    camera.lookAt(p.x, y, p.z);
    const renderer = withCamera ? { camera, scene: { scene: { add() {} } }, overview: null } as unknown as FlightRenderer : null;
    const container = (document as unknown as { createElement: (t: string) => FakeNode }).createElement('div');
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleHud, { session, runtime, side: 'coalition', renderer, touch: true, death: new DeathReport(session) }));
    await vi.waitFor(() => expect(frame).toBeTypeOf('function'));
    await new Promise(done => setTimeout(done, 20));
    return { session, runtime, world, p };
  }

  it('draws the ring and the in-circle text from the real capture of a point the player walked into', async () => {
    const { session, world, p } = await game();
    world.soldier!.pos.set(p.x, world.soldier!.pos.y, p.z);
    frame();
    expect(drawn.arcs.filter(a => a.r === 11)).toEqual([]);
    const start = p.v;
    for (let i = 0; i < 240; i++) session.step(STEP);
    frame();
    expect(p.v).toBeGreaterThan(start);
    const percent = Math.round(Math.abs(p.v));
    const rings = drawn.arcs.filter(a => a.r === 11);
    expect(rings.map(a => a.width)).toEqual([5, 3]);
    expect(rings[0].style).toBe('#000');
    expect(rings[1].end).toBeCloseTo(-Math.PI / 2 + Math.PI * 2 * Math.abs(p.v) / 100);
    expect(drawn.texts.find(x => x.text === `■ ${p.id} ${percent}%`)).toMatchObject({ x: W / 2, y: H / 2 - H * 0.22 - 18, style: '#4cc9f0' });
    const label = drawn.texts.find(x => x.text.startsWith(`○   ${p.id} `))!;
    expect(rings[0].x).toBeCloseTo(label.x - label.text.length * 7 / 2 + 7 / 2);
    expect(rings[0].y).toBeCloseTo(label.y);
  });

  it('draws no mark while v holds and nobody contests', async () => {
    const { world, runtime } = await game();
    const own = runtime.conquest.points.find(q => q.owner === 'coalition')!;
    world.soldier!.pos.set(own.x, world.soldier!.pos.y, own.z);
    frame();
    frame();
    expect(drawn.arcs.filter(a => a.r === 11)).toEqual([]);
    expect(drawn.texts.filter(x => x.text.endsWith('%'))).toEqual([]);
  });

  it('draws the stopped text for a contested point', async () => {
    const { world, p } = await game();
    world.soldier!.pos.set(p.x, world.soldier!.pos.y, p.z);
    p.v = 62;
    p.contested = true;
    frame();
    expect(drawn.texts.map(x => x.text)).toContain(`× ${p.id} 62%`);
    expect(drawn.arcs.filter(a => a.r === 11)).toHaveLength(2);
  });

  it('keeps the frame alive when point values are missing', async () => {
    const { runtime, world, p } = await game();
    world.soldier!.pos.set(p.x, world.soldier!.pos.y, p.z);
    (p as unknown as { v: unknown }).v = undefined;
    (p as unknown as { contested: boolean }).contested = true;
    expect(() => frame()).not.toThrow();
    expect(drawn.texts.filter(x => x.text.endsWith('%'))).toEqual([]);
    (p as unknown as { radius: unknown }).radius = undefined;
    p.v = NaN;
    expect(() => frame()).not.toThrow();
    expect(runtime.conquest.points).toContain(p);
  });

  it('keeps the frame alive with no points at all', async () => {
    const { runtime } = await game({ withCamera: false });
    runtime.conquest.points.length = 0;
    expect(() => frame()).not.toThrow();
  });
});
