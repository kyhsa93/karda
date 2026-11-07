import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import harekRaw from '../../../content/battle/maps/harek.json?raw';
import type { FlightRenderer } from '../../../render/renderer';
import type { BattleMapDef } from '../../../sim/battle/schema';
import { STEP } from '../../../sim/world';
import { coachDimmed, MARK_PANEL_GAP_PX, MARK_ROW_PX, nearestOpenPoint, MARK_STALE_MS, pointMarkBox, PointMarkBoard, type Box } from '../coach';
import { CoachBox } from '../CoachBox';
import { DeathReport } from '../deathReport';
import { loadBattle } from '../loadBattle';
import { BattleHud, RADIO_SLOT, TOUCH_CONTROLS } from './BattleHud';
import { BUTTON_TEXT, grow, MARK_CENTER_DIM, MARK_TARGET_DIM, PILL_FILL, PILL_PAD } from './targetMark';
import { STANDARD_LOADOUT } from '../../../sim/heli/loadout';

vi.mock('../../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));

const W = 844, H = 390;

interface Drawn { arcs: { x: number; y: number; r: number; style: string; width: number; end: number }[]; texts: { text: string; x: number; y: number; style: string; alpha: number }[]; pills: (Box & { style: string })[]; lines: number; calls: number }

const newDrawn = (): Drawn => ({ arcs: [], texts: [], pills: [], lines: 0, calls: 0 });

function fakeContext(drawn: Drawn) {
  const state: Record<string, unknown> = { globalAlpha: 1 };
  let path: { x: number; y: number; r: number; end: number } | null = null;
  const fns: Record<string, (...a: never[]) => unknown> = {
    measureText: (text: string) => ({ width: text.length * 7 }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    beginPath: () => { path = null; },
    arc: (x: number, y: number, r: number, _s: number, end: number) => { path = { x, y, r, end }; },
    stroke: () => { if (path) drawn.arcs.push({ ...path, style: String(state.strokeStyle), width: Number(state.lineWidth) }); },
    lineTo: () => { drawn.lines++; },
    roundRect: (x: number, y: number, w: number, h: number) => { drawn.pills.push({ left: x, top: y, right: x + w, bottom: y + h, style: String(state.fillStyle) }); },
    fillText: (text: string, x: number, y: number) => { drawn.texts.push({ text, x, y, style: String(state.fillStyle), alpha: Number(state.globalAlpha) }); },
    clearRect: () => { drawn.arcs.length = 0; drawn.texts.length = 0; drawn.pills.length = 0; drawn.lines = 0; },
  };
  return new Proxy(state, {
    get: (s, k: string) => { const f = fns[k] ?? (k in s ? null : () => {}); return f ? (...a: never[]) => { drawn.calls++; return f(...a); } : s[k]; },
    set: (s, k: string, v) => { s[k] = v; return true; },
  });
}

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style: Record<string, unknown> = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  clientWidth = W;
  clientHeight = H;
  width = 0;
  height = 0;
  context: unknown = null;
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: { drawn: Drawn; top: Drawn } | null, public nodeValue = '') {}
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
  getBoundingClientRect() { return { left: 290, right: 480, top: 116, bottom: 160 }; }
  getContext() { return this.context ??= this.attrs.class === 'battle-canvas' ? fakeContext(this.ownerDocument!.drawn) : this.attrs.class === 'battle-top' ? fakeContext(this.ownerDocument!.top) : fakeContext(newDrawn()); }
}

const harek = JSON.parse(harekRaw) as BattleMapDef;
const SOLDIER = { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' } as const;

describe('capture mark in the HUD frame (#228)', () => {
  let root: Root;
  let frame: () => void;
  let drawn: Drawn;
  let top: Drawn;
  let topCanvas: () => FakeNode | undefined;

  beforeEach(() => {
    drawn = newDrawn();
    top = newDrawn();
    const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
    doc.drawn = drawn;
    doc.top = top;
    const made: FakeNode[] = [];
    topCanvas = () => made.find(n => n.attrs.class === 'battle-top' && n.parentNode);
    doc.createElement = (type: string) => { const n = new FakeNode(1, type.toUpperCase(), doc as unknown as { drawn: Drawn; top: Drawn }); made.push(n); return n; };
    doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc as unknown as { drawn: Drawn; top: Drawn }, text);
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

  const POINT_MARK = /^[■▲○×]\s+[A-Z] [\d.]+k?m$/;
  const COACH = { left: 290, right: 480, top: 116, bottom: 160 };
  const newNode = () => (document as unknown as { createElement: (t: string) => FakeNode }).createElement('div');

  async function game({ withCamera = true, marks = new PointMarkBoard(), touch = true, away = false, heli = false } = {}) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const pad = session.world.pads[0];
    session.deploy(heli ? { kind: 'heli', at: 'air', x: pad.x, z: pad.z, agl: 150, headingDeg: 0, kit: STANDARD_LOADOUT, speed: 0 } : SOLDIER);
    const world = session.world;
    const p = runtime.conquest.points.find(q => q.owner === 'neutral')!;
    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 5000);
    const y = world.terrain.surfaceAt(p.x, p.z) + 16;
    camera.position.set(p.x, y, p.z + 200);
    camera.lookAt(p.x, y, away ? p.z + 400 : p.z);
    const renderer = withCamera ? { camera, scene: { scene: { add() {} } }, overview: null } as unknown as FlightRenderer : null;
    root = createRoot(newNode() as unknown as HTMLElement);
    root.render(createElement(BattleHud, { session, runtime, side: 'coalition', renderer, touch, death: new DeathReport(session), marks }));
    await vi.waitFor(() => expect(frame).toBeTypeOf('function'));
    await new Promise(done => setTimeout(done, 20));
    return { session, runtime, world, p, camera };
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
    expect(drawn.texts.map(x => x.text)).toContain(`× ■ ${p.id} 62%`);
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

  it('publishes the box of every drawn point mark and of nothing else (#295)', async () => {
    const marks = new PointMarkBoard();
    await game({ marks });
    frame();
    const drawnMarks = drawn.texts.filter(x => POINT_MARK.test(x.text));
    expect(drawnMarks.length).toBeGreaterThan(0);
    expect(marks.boxes).toEqual(drawnMarks.map(x => pointMarkBox(x.x, x.y, x.text.length * 7)));
    expect(marks.at).toBeGreaterThan(0);
  });

  it('clears the published marks outside play (#295)', async () => {
    const marks = new PointMarkBoard();
    const { session } = await game({ marks });
    frame();
    expect(marks.boxes.length).toBeGreaterThan(0);
    (session as unknown as { mode: string }).mode = 'deploy';
    frame();
    expect(marks.boxes).toEqual([]);
    expect(coachDimmed(COACH, marks, performance.now())).toBe(false);
  });

  it('publishes nothing new when the HUD frame fails before the marks (#295)', async () => {
    const marks = new PointMarkBoard();
    const { world } = await game({ marks });
    frame();
    const { at } = marks;
    world.terrain.surfaceAt = () => { throw new Error('hud failed'); };
    expect(() => frame()).toThrow('hud failed');
    expect(marks.at).toBe(at);
  });

  it('changes the coach class only when the answer changes, however many frames publish (#295)', async () => {
    const marks = new PointMarkBoard();
    const container = newNode();
    root = createRoot(container as unknown as HTMLElement);
    let commits = 0;
    root.render(createElement(Profiler, { id: 'coach', onRender: () => { commits++; } }, createElement(CoachBox, { text: 'x', marks })));
    await vi.waitFor(() => expect(container.childNodes.length).toBe(1));
    const node = container.childNodes[0];
    expect(node.attrs.class).toBe('coach');
    expect(commits).toBeGreaterThan(0);
    const on = [pointMarkBox(400, 140, 60)];
    const publishFrames = async (boxes: typeof on) => { for (let i = 0; i < 25; i++) { marks.publish(boxes, performance.now()); await new Promise(done => setTimeout(done, 16)); } };
    const staysPut = async (boxes: typeof on, cls: string) => {
      await publishFrames(boxes);
      expect(node.attrs.class).toBe(cls);
      const settled = commits;
      await publishFrames(boxes);
      expect(node.attrs.class).toBe(cls);
      expect(commits).toBe(settled);
    };
    await staysPut(on, 'coach dimmed');
    await staysPut([pointMarkBox(100, 300, 60)], 'coach');
    await staysPut(on, 'coach dimmed');
    marks.publish(on, performance.now() - MARK_STALE_MS - 1);
    await new Promise(done => setTimeout(done, 200));
    expect(node.attrs.class).toBe('coach');
  });

  describe('rear point mark on touch (#274)', () => {
    const rear = (id: string) => drawn.texts.filter(x => POINT_MARK.test(x.text) && x.text.includes(` ${id} `));
    const controlsAt = (boxes: Box[]) => {
      const asked: string[] = [];
      (document as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll = (sel: string) => { asked.push(sel); return boxes.map(b => ({ getBoundingClientRect: () => b })); };
      return asked;
    };
    const gapHit = (m: Box, b: Box) => Math.min(m.right, b.right + MARK_PANEL_GAP_PX) - Math.max(m.left, b.left - MARK_PANEL_GAP_PX) > 0 && Math.min(m.bottom, b.bottom + MARK_PANEL_GAP_PX) - Math.max(m.top, b.top - MARK_PANEL_GAP_PX) > 0;

    it('draws the point behind the player on the bottom edge, mirrored, and publishes it', async () => {
      const marks = new PointMarkBoard();
      const { p } = await game({ marks, away: true });
      frame();
      const m = rear(p.id);
      expect(m).toHaveLength(1);
      expect(m[0].y).toBe(H - 48);
      expect(m[0].x).toBeCloseTo(W / 2, 0);
      expect(marks.boxes).toContainEqual(pointMarkBox(m[0].x, m[0].y, m[0].text.length * 7));
    });

    it('slides the rear mark clear of every touch control and the radio slot, and publishes where it went', async () => {
      const marks = new PointMarkBoard();
      const stick: Box = { left: 360, right: 470, top: 300, bottom: 380 };
      const radio: Box = { left: 200, right: 360, top: 330, bottom: 384 };
      const asked = controlsAt([stick, radio]);
      const { p } = await game({ marks, away: true });
      frame();
      expect(asked.length).toBeGreaterThan(0);
      expect(new Set(asked)).toEqual(new Set([TOUCH_CONTROLS]));
      const m = rear(p.id)[0];
      const box = pointMarkBox(m.x, m.y, m.text.length * 7);
      for (const b of [stick, radio, { left: 290, right: 480, top: 116, bottom: 160 }]) expect(gapHit(box, b)).toBe(false);
      expect(m.y).toBe(H - 48);
      expect(m.x).toBe(stick.right + MARK_PANEL_GAP_PX + m.text.length * 7 / 2);
      expect(marks.boxes).toContainEqual(box);
    });

    it('climbs a row when the whole bottom edge is taken', async () => {
      const asked = controlsAt([{ left: 0, right: W, top: H - 60, bottom: H }]);
      const marks = new PointMarkBoard();
      const { p } = await game({ away: true, marks });
      frame();
      expect(asked.length).toBeGreaterThan(0);
      const m = rear(p.id)[0];
      expect(m.y + 8).toBeLessThanOrEqual(H - 60 - MARK_PANEL_GAP_PX);
      expect(m.y).toBe(H - 48 - 2 * 18);
      expect(coachDimmed({ left: m.x - 40, right: m.x + 40, top: m.y - 20, bottom: m.y + 20 }, marks, performance.now())).toBe(true);
      expect(coachDimmed({ left: m.x - 40, right: m.x + 40, top: H - 48 - 20, bottom: H - 48 + 4 }, marks, performance.now())).toBe(false);
    });

    it('draws only the nearest open point behind the player on touch, every point on desktop', async () => {
      const { runtime, camera, world } = await game({ away: true });
      frame();
      const behind = (id: string) => { const q = runtime.conquest.points.find(o => o.id === id)!; return new THREE.Vector3(q.x, world.terrain.surfaceAt(q.x, q.z) + 16, q.z).project(camera).z >= 1; };
      const ids = () => drawn.texts.filter(x => POINT_MARK.test(x.text)).map(x => x.text.match(/ ([A-Z]) /)![1]);
      const me = world.playerBody().pos;
      const open = nearestOpenPoint(runtime.conquest.points, 'coalition', me.x, me.z);
      const rearIds = runtime.conquest.points.map(q => q.id).filter(behind);
      expect(rearIds.length).toBeGreaterThan(1);
      expect(rearIds).toContain(open);
      expect(ids().filter(behind)).toEqual([open]);
      root.unmount();
      await game({ away: true, touch: false });
      frame();
      expect(ids().filter(behind).sort()).toEqual([...rearIds].sort());
    });

    it('leaves the desktop rear mark where it was and asks only for the radio slot, never the touch controls', async () => {
      const asked: string[] = [];
      (document as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll = (sel: string) => { asked.push(sel); return sel === TOUCH_CONTROLS ? [{ getBoundingClientRect: () => ({ left: 0, right: W, top: 0, bottom: H }) }] : []; };
      const { p } = await game({ away: true, touch: false });
      frame();
      expect(new Set(asked)).toEqual(new Set([RADIO_SLOT]));
      const m = rear(p.id);
      expect(m).toHaveLength(1);
      expect(m[0].y).toBe(H - 48);
      expect(m[0].x).toBeCloseTo(W / 2, 0);
    });

    describe('edge marks on the same side (#315)', () => {
      const pointMarks = () => drawn.texts.filter(x => POINT_MARK.test(x.text)).map(x => ({ ...x, id: x.text.match(/ ([A-Z]) /)![1], box: pointMarkBox(x.x, x.y, x.text.length * 7) }));
      const overlap = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
      const noPairOverlaps = (boxes: Box[]) => { for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false); };

      async function allBehind(opts: { touch: boolean; marks?: PointMarkBoard }) {
        const g = await game({ ...opts, away: true });
        g.runtime.conquest.points.forEach((q, k) => { q.x = g.p.x; q.z = g.p.z + 150 - 120 * k; });
        return g;
      }

      it('keeps the nearest rear mark on the bottom edge and stacks the others 18px up on desktop', async () => {
        controlsAt([]);
        const marks = new PointMarkBoard();
        const { runtime, world } = await allBehind({ touch: false, marks });
        frame();
        const me = world.playerBody().pos;
        const order = [...runtime.conquest.points].sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z)).map(q => q.id);
        const m = pointMarks();
        expect(m.map(x => x.id).sort()).toEqual([...order].sort());
        expect(order.map(id => m.find(x => x.id === id)!.y)).toEqual(order.map((_, k) => H - 48 - k * MARK_ROW_PX));
        for (const x of m) expect(x.x).toBeCloseTo(W / 2, 0);
        noPairOverlaps(m.map(x => x.box));
        expect(marks.boxes).toEqual(m.map(x => x.box));
        const top = m.find(x => x.id === order.at(-1))!;
        expect(coachDimmed({ left: top.x - 40, right: top.x + 40, top: top.y - 10, bottom: top.y + 10 }, marks, performance.now())).toBe(true);
      });

      it('slides a stacked desktop mark off the radio slot instead of under it', async () => {
        const radio: Box = { left: W / 2 - 120, right: W / 2 + 120, top: H - 48 - 30, bottom: H - 48 - 12 };
        const asked: string[] = [];
        (document as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll = (sel: string) => { asked.push(sel); return sel === RADIO_SLOT ? [{ getBoundingClientRect: () => radio }] : []; };
        const marks = new PointMarkBoard();
        await allBehind({ touch: false, marks });
        frame();
        expect(new Set(asked)).toEqual(new Set([RADIO_SLOT]));
        const m = pointMarks();
        expect(m.length).toBe(3);
        for (const x of m) expect(gapHit(x.box, radio)).toBe(false);
        for (const x of m) expect(x.box.left >= 0 && x.box.right <= W && x.box.top >= 0 && x.box.bottom <= H).toBe(true);
        noPairOverlaps(m.map(x => x.box));
        expect(marks.boxes).toEqual(m.map(x => x.box));
      });

      it('lifts the touch rear mark off a front mark pinned to the same bottom edge, and the front mark stays', async () => {
        controlsAt([]);
        const marks = new PointMarkBoard();
        const { runtime, p, camera, world } = await game({ marks, away: true });
        const front = runtime.conquest.points.find(q => q.owner === 'coalition')!;
        const far = runtime.conquest.points.find(q => q.owner === 'veros')!;
        front.x = p.x; front.z = p.z + 260;
        far.x = p.x; far.z = p.z - 4000;
        const y = world.terrain.surfaceAt(p.x, p.z) + 16 + 400;
        camera.position.set(p.x, y, p.z + 200);
        camera.lookAt(p.x, y, p.z + 400);
        frame();
        const m = pointMarks();
        const f = m.find(x => x.id === front.id)!, r = m.find(x => x.id === p.id)!;
        expect(m.map(x => x.id).sort()).toEqual([front.id, p.id].sort());
        expect(f.y).toBe(H - 48);
        expect(f.x).toBeCloseTo(W / 2, 0);
        expect(r.y).toBe(H - 48 - MARK_ROW_PX);
        expect(r.x).toBeCloseTo(W / 2, 0);
        expect(overlap(f.box, r.box)).toBe(false);
        expect(marks.boxes).toEqual(m.map(x => x.box));
      });
    });

    it('keeps the front marks where they were on touch', async () => {
      controlsAt([{ left: 0, right: W, top: 0, bottom: H }]);
      const { p } = await game();
      frame();
      expect(rear(p.id)).toEqual([]);
      const m = top.texts.filter(x => POINT_MARK.test(x.text) && x.text.includes(` ${p.id} `));
      expect(m).toHaveLength(1);
      expect(m[0].x).toBeCloseTo(W / 2, 0);
      expect(m[0].y).toBeCloseTo(H / 2, 0);
    });
  });

  describe('target mark over the controls (#340)', () => {
    const named = (d: Drawn, id: string) => d.texts.filter(x => POINT_MARK.test(x.text) && x.text.includes(` ${id} `));
    const boxOf = (x: { x: number; y: number; text: string }) => pointMarkBox(x.x, x.y, x.text.length * 7);
    const visible = () => topCanvas()?.style.visibility;
    function dom(controls: Box[], texts: Box[] = [], radio: Box[] = []) {
      const asked: string[] = [];
      const d = document as unknown as Record<string, unknown>;
      d.querySelectorAll = (sel: string) => {
        asked.push(sel);
        if (sel === BUTTON_TEXT) return texts.map(r => ({ childNodes: [{ nodeType: 3, textContent: '발사', rect: r }] }));
        if (sel === RADIO_SLOT) return radio.map(b => ({ getBoundingClientRect: () => b }));
        return sel === TOUCH_CONTROLS ? controls.map(b => ({ getBoundingClientRect: () => b })) : [];
      };
      d.createRange = () => { let n: { rect: Box } | null = null; return { selectNodeContents: (x: { rect: Box }) => { n = x; }, getClientRects: () => (n ? [n.rect] : []) }; };
      return asked;
    }
    async function aside(opts: { touch?: boolean; heli?: boolean; marks?: PointMarkBoard } = {}) {
      const g = await game(opts);
      const me = g.world.playerBody().pos;
      const id = nearestOpenPoint(g.runtime.conquest.points, 'coalition', me.x, me.z)!;
      const q = g.runtime.conquest.points.find(o => o.id === id)!;
      for (const o of g.runtime.conquest.points) if (o !== q) { o.x = q.x + 3000; o.z = q.z; }
      const y = g.world.terrain.surfaceAt(q.x, q.z) + 16;
      g.camera.position.set(q.x, y, q.z + 200);
      g.camera.lookAt(q.x + 60, y, q.z);
      return { ...g, q };
    }

    it('draws only the target on the top layer with the wide pill when it sits on a touch control, and publishes it', async () => {
      const marks = new PointMarkBoard();
      dom([{ left: 0, right: W, top: 0, bottom: H }]);
      const { q } = await aside({ marks });
      frame();
      expect(named(drawn, q.id)).toEqual([]);
      const [m] = named(top, q.id);
      expect(m.x).toBeLessThan(W / 2 - 60);
      expect(m.alpha).toBe(1);
      expect(top.pills).toEqual([{ ...grow(boxOf(m), PILL_PAD.x, PILL_PAD.y), style: PILL_FILL }]);
      expect(top.texts.filter(x => POINT_MARK.test(x.text))).toHaveLength(1);
      expect(top.lines).toBe(0);
      expect(visible()).toBe('visible');
      expect(marks.boxes).toContainEqual(boxOf(m));
    });

    it('makes no top-layer call while the target touches nothing, and clears it once when the overlap ends', async () => {
      dom([]);
      await aside();
      frame();
      frame();
      expect(top.calls).toBe(0);
      expect(visible()).not.toBe('visible');
      dom([{ left: 0, right: W, top: 0, bottom: H }]);
      frame();
      expect(top.calls).toBeGreaterThan(0);
      expect(visible()).toBe('visible');
      dom([]);
      frame();
      const cleared = top.calls;
      expect(top.texts).toEqual([]);
      expect(visible()).toBe('hidden');
      frame();
      frame();
      expect(top.calls).toBe(cleared);
    });

    it('lifts the target a row off a button text, keeps x, and publishes where it went', async () => {
      const marks = new PointMarkBoard();
      dom([{ left: 0, right: W, top: 0, bottom: H }], []);
      const { q } = await aside({ marks });
      frame();
      const [m0] = named(top, q.id);
      dom([{ left: 0, right: W, top: 0, bottom: H }], [{ left: m0.x - 10, right: m0.x + 10, top: m0.y - 6, bottom: m0.y + 6 }]);
      frame();
      const [m] = named(top, q.id);
      expect(m.x).toBe(m0.x);
      expect(m.y).toBe(m0.y - MARK_ROW_PX);
      expect(top.pills).toHaveLength(1);
      expect(marks.boxes).toContainEqual(boxOf(m));
      expect(marks.boxes).not.toContainEqual(boxOf(m0));
    });

    it('draws the target above the controls without a pill when no row is free (step 4)', async () => {
      const full = [{ left: 0, right: W, top: 0, bottom: H }];
      dom(full);
      const { q } = await aside();
      frame();
      const [m0] = named(top, q.id);
      const text = (dy: number) => ({ left: m0.x - 10, right: m0.x + 10, top: m0.y + dy - 6, bottom: m0.y + dy + 6 });
      dom(full, [text(0), text(-MARK_ROW_PX), text(-2 * MARK_ROW_PX), text(MARK_ROW_PX)]);
      frame();
      const [m] = named(top, q.id);
      expect(m.x).toBe(m0.x);
      expect(m.y).toBe(m0.y + MARK_ROW_PX);
      expect(top.pills).toEqual([]);
      expect(named(drawn, q.id)).toEqual([]);
    });

    it('puts the desktop target above the radio slot with a pill', async () => {
      const asked = dom([], [], [{ left: 0, right: W, top: 0, bottom: H }]);
      const { q } = await aside({ touch: false });
      frame();
      expect(asked).not.toContain(TOUCH_CONTROLS);
      expect(named(top, q.id)).toHaveLength(1);
      expect(top.pills).toHaveLength(1);
    });

    it('dims the target to the target value in the center, other marks to the general value, and redraws the soldier crosshair above a top-layer target and its pill', async () => {
      dom([]);
      const { p, runtime, camera, world } = await game();
      frame();
      expect(named(drawn, p.id).map(x => x.alpha)).toEqual([MARK_TARGET_DIM]);
      const own = runtime.conquest.points.find(o => o.owner === 'coalition')!;
      const y = world.terrain.surfaceAt(own.x, own.z) + 16;
      camera.position.set(own.x, y, own.z + 200);
      camera.lookAt(own.x, y, own.z);
      frame();
      expect(named(drawn, own.id).map(x => x.alpha)).toEqual([MARK_CENTER_DIM]);
      expect(top.calls).toBe(0);
      camera.position.set(p.x, y, p.z + 200);
      camera.lookAt(p.x, world.terrain.surfaceAt(p.x, p.z) + 16, p.z);
      dom([{ left: 0, right: W, top: 0, bottom: H }]);
      world.emit({ t: 'unitHit', unit: 0 });
      world.events.flush();
      frame();
      const [m] = named(top, p.id);
      expect(m.alpha).toBe(MARK_TARGET_DIM);
      expect(top.pills).toEqual([{ ...grow(boxOf(m), PILL_PAD.x, PILL_PAD.y), style: PILL_FILL }]);
      expect(top.lines).toBe(8);
      expect(drawn.lines).toBeGreaterThanOrEqual(8);
    });

    it('draws a helicopter target in the center without a pill and without a crosshair', async () => {
      dom([{ left: 0, right: W, top: 0, bottom: H }]);
      const { q, camera, world } = await aside({ heli: true });
      const y = world.terrain.surfaceAt(q.x, q.z) + 16;
      camera.lookAt(q.x, y, q.z);
      frame();
      const [m] = named(top, q.id);
      expect(m.alpha).toBe(MARK_TARGET_DIM);
      expect(top.pills).toEqual([]);
      expect(top.lines).toBe(0);
    });

    it('lifts the target off another front mark on desktop and leaves the other mark where it was', async () => {
      dom([]);
      const { q, runtime, camera, world } = await aside({ touch: false });
      frame();
      const [m0] = named(drawn, q.id);
      const other = runtime.conquest.points.find(o => o !== q)!;
      other.x = q.x + 20; other.z = q.z;
      frame();
      const o = named(drawn, other.id)[0];
      const [m] = named(drawn, q.id);
      expect(m.x).toBe(m0.x);
      expect(m.y).toBe(m0.y - MARK_ROW_PX);
      const s = new THREE.Vector3(other.x, world.terrain.surfaceAt(other.x, other.z) + 16, other.z).project(camera);
      expect(o.x).toBeCloseTo((s.x + 1) / 2 * W, 3);
      expect(o.y).toBeCloseTo((1 - s.y) / 2 * H, 3);
      const a = boxOf(m), b = boxOf(o);
      expect(Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0).toBe(false);
      expect(top.calls).toBe(0);
    });
  });
});
