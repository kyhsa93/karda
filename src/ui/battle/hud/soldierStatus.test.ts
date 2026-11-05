import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import harekRaw from '../../../content/battle/maps/harek.json?raw';
import type { FlightRenderer } from '../../../render/renderer';
import type { BattleMapDef } from '../../../sim/battle/schema';
import type { SoldierClass } from '../../../sim/infantry/soldier';
import { STEP } from '../../../sim/world';
import { PointMarkBoard, type Box } from '../coach';
import { DeathReport } from '../deathReport';
import { loadBattle } from '../loadBattle';
import { BattleHud } from './BattleHud';

vi.mock('../../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));

const W = 1280, H = 720;
const PANEL: Box = { left: 1000, right: 1264, top: 640, bottom: 704 };

interface Drawn { arcs: { x: number; y: number; r: number }[]; texts: { text: string; x: number; y: number }[] }

function fakeContext(drawn: Drawn) {
  const state: Record<string, unknown> = {};
  let path: { x: number; y: number; r: number } | null = null;
  const fns: Record<string, (...a: never[]) => unknown> = {
    measureText: (text: string) => ({ width: text.length * 7 }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    beginPath: () => { path = null; },
    arc: (x: number, y: number, r: number) => { path = { x, y, r }; },
    stroke: () => { if (path) drawn.arcs.push({ ...path }); },
    fillText: (text: string, x: number, y: number) => { drawn.texts.push({ text, x, y }); },
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
  getBoundingClientRect() { return this.attrs.class === 'soldier-status' ? PANEL : { left: 0, right: 0, top: 0, bottom: 0 }; }
  getContext() { return this.context ??= this.attrs.class === 'battle-canvas' ? fakeContext(this.ownerDocument!.drawn) : fakeContext({ arcs: [], texts: [] }); }
}

function all(node: FakeNode, cls: string): FakeNode[] {
  return node.childNodes.flatMap(c => [...((c.attrs.class ?? '').split(' ').includes(cls) ? [c] : []), ...all(c, cls)]);
}

const harek = JSON.parse(harekRaw) as BattleMapDef;
const POINT_MARK = /^[■▲○×]\s+[A-Z] [\d.]+k?m$/;

describe('soldier status panel (#233)', () => {
  let root: Root;
  let frame: () => void;
  let drawn: Drawn;
  let container: FakeNode;

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
    container = (doc.createElement as (t: string) => FakeNode)('div');
  });

  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function game({ cls = 'assault' as SoldierClass, touch = false, camera = null as THREE.PerspectiveCamera | null } = {}) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    session.deploy({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls });
    const renderer = camera ? { camera, scene: { scene: { add() {} } }, overview: null } as unknown as FlightRenderer : null;
    const marks = new PointMarkBoard();
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleHud, { session, runtime, side: 'coalition', renderer, touch, death: new DeathReport(session), marks }));
    await vi.waitFor(() => expect(all(container, 'soldier-status')).toHaveLength(1));
    const lines = () => all(container, 'soldier-status')[0].childNodes.map(n => n.textContent);
    const tick = () => new Promise(done => setTimeout(done, 130));
    return { session, runtime, world: session.world, marks, lines, tick };
  }

  it('shows health and ammo on one line and the gear on a second line for the assault class', async () => {
    const { lines } = await game();
    expect(lines()).toEqual(['체력 100소총 30 / 150', '유탄 6 · 구급 상자 준비 · 연막탄 2']);
  });

  it('shows two lines for the engineer class', async () => {
    const { lines } = await game({ cls: 'engineer' });
    expect(lines()).toEqual(['체력 100카빈 30 / 150', '대전차 로켓 3 · 수리 도구 준비 · 지뢰 2']);
  });

  it('stays at two lines while reloading', async () => {
    const { session, world, lines, tick } = await game();
    world.soldierArms.ammo.rifle!.mag = 10;
    world.reloadSoldier();
    session.step(STEP);
    await tick();
    expect(world.soldierArms.reloading).toBeGreaterThan(0);
    expect(lines()).toEqual(['체력 100소총 재장전 중', '유탄 6 · 구급 상자 준비 · 연막탄 2']);
  });

  it('hides the stance only while standing', async () => {
    const { session, world, lines, tick } = await game();
    expect(lines().join('|')).not.toContain('서기');
    for (const [stance, text] of [['crouch', '앉기'], ['prone', '엎드림']] as const) {
      world.setStance(stance);
      for (let i = 0; i < 120; i++) session.step(STEP);
      await tick();
      expect(world.soldier!.stance).toBe(stance);
      expect(lines()[0]).toBe(`체력 100소총 30 / 150${text}`);
      expect(lines()).toHaveLength(2);
    }
  });

  it('keeps only health and ammo on the touch status line', async () => {
    for (const cls of ['assault', 'engineer'] as const) {
      const { lines } = await game({ cls, touch: true });
      expect(lines()).toEqual([cls === 'assault' ? '체력 100소총 30 / 150' : '체력 100카빈 30 / 150']);
      root.unmount();
    }
    root = createRoot(container as unknown as HTMLElement);
  });

  it('keeps every point mark and its ring off the panel in 24 head directions on the desktop', async () => {
    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 5000);
    const { runtime, world } = await game({ camera });
    for (const p of runtime.conquest.points) { p.v = 50; p.contested = true; }
    const d = runtime.conquest.points.find(p => p.id === 'D')!;
    const y = world.terrain.surfaceAt(d.x, d.z) + 2;
    let dodged = 0;
    for (let k = 0; k < 24; k++) {
      camera.position.set(d.x, y, d.z + 200);
      camera.rotation.set(0, (k * 15 * Math.PI) / 180, 0, 'YXZ');
      frame();
      const labels = drawn.texts.filter(t => POINT_MARK.test(t.text));
      expect(labels).toHaveLength(runtime.conquest.points.length);
      for (const l of labels) {
        const w = l.text.length * 7;
        const box = { left: l.x - w / 2, right: l.x + w / 2, top: l.y - 8, bottom: l.y + 8 };
        const hit = Math.min(box.right, PANEL.right) - Math.max(box.left, PANEL.left) > 0 && Math.min(box.bottom, PANEL.bottom) - Math.max(box.top, PANEL.top) > 0;
        expect(hit, `${k * 15}° ${l.text} @${l.x},${l.y}`).toBe(false);
        if (l.y + 8 > PANEL.top && l.x + w / 2 > PANEL.left - 8) dodged++;
        const ring = drawn.arcs.find(a => a.r === 11 && Math.abs(a.y - l.y) < 1e-6 && Math.abs(a.x - (l.x - w / 2 + 7 / 2)) < 1e-6);
        expect(ring, `${k * 15}° ring of ${l.text}`).toBeDefined();
      }
    }
    expect(dodged).toBeGreaterThan(0);
  });

  it('publishes the dodged x on the point mark board (#305)', async () => {
    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 5000);
    const { runtime, world, marks } = await game({ camera });
    const d = runtime.conquest.points.find(p => p.id === 'D')!;
    const y = world.terrain.surfaceAt(d.x, d.z) + 2;
    for (let k = 0; k < 24; k++) {
      camera.position.set(d.x, y, d.z + 200);
      camera.rotation.set(0, (k * 15 * Math.PI) / 180, 0, 'YXZ');
      frame();
      const labels = drawn.texts.filter(t => POINT_MARK.test(t.text));
      expect(marks.boxes).toHaveLength(labels.length);
      marks.boxes.forEach((b, i) => { expect((b.left + b.right) / 2).toBeCloseTo(labels[i].x, 6); expect((b.top + b.bottom) / 2).toBeCloseTo(labels[i].y, 6); });
      expect(marks.boxes.some(b => Math.min(b.right, PANEL.right) - Math.max(b.left, PANEL.left) > 0 && Math.min(b.bottom, PANEL.bottom) - Math.max(b.top, PANEL.top) > 0)).toBe(false);
    }
  });
});
