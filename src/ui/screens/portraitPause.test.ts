import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { t } from '../../content/strings';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STEP } from '../../sim/world';
import { BattleOverlays } from '../battle/Battle';
import { PointMarkBoard, STEP_TIMEOUT } from '../battle/coach';
import { DeathReport } from '../battle/deathReport';
import { loadBattle } from '../battle/loadBattle';
import { Flight } from './Flight';

vi.mock('../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));
vi.mock('../../audio/game', () => ({ GameAudio: class { voice = { enabled: false }; setVolume() {} async loadSamples() {} async resume() {} dispose() {} } }));
vi.mock('../../render/renderer', () => ({
  FlightRenderer: class {
    constructor(opts: unknown) { (globalThis as Record<string, unknown>).__rendererOpts = opts; }
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
const settle = (ms = 20) => new Promise(done => setTimeout(done, ms));
const ROTATE = '가로로 돌려 주세요 — 그동안 전장은 멈춰 있습니다';

describe('portrait notice pauses the match (#235)', () => {
  let root: Root | undefined;
  let container: FakeNode;
  let win: { innerWidth: number; innerHeight: number };
  let resize: Set<() => void>;

  beforeEach(() => {
    resize = new Set();
    root = undefined;
    const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
    doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
    doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
    doc.documentElement = (doc.createElement as (t: string) => FakeNode)('html');
    doc.body = (doc.createElement as (t: string) => FakeNode)('body');
    win = {
      document: doc, location: { hash: '', search: '' }, HTMLIFrameElement: class {}, devicePixelRatio: 1, innerWidth: 390, innerHeight: 844, scrollTo() {},
      addEventListener: (type: string, fn: () => void) => { if (type === 'resize') resize.add(fn); },
      removeEventListener: (type: string, fn: () => void) => { if (type === 'resize') resize.delete(fn); },
    } as unknown as typeof win;
    (doc as Record<string, unknown>).defaultView = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('location', (win as unknown as { location: unknown }).location);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    container = (doc.createElement as (t: string) => FakeNode)('div');
  });

  afterEach(async () => {
    root?.unmount();
    await settle();
    vi.unstubAllGlobals();
  });

  async function battle({ touch = true, role = 'soldier' as 'soldier' | 'heli', deploy = true, coach = false } = {}) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const world = session.world;
    const pad = runtime.spawnPoints(world).find(p => p.role === 'heli' && p.kind === 'pad')!;
    const spawn = () => session.deploy(role === 'heli' ? runtime.spawnFor(pad, mod.KITS.closeSupport) : { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' });
    if (deploy) spawn();
    const game = { mod, session, runtime, death: new DeathReport(session), marks: new PointMarkBoard() };
    const children = coach ? createElement(BattleOverlays, { game, side: 'coalition', touch, tips: [], onTip: () => {}, onRole: () => {}, onAgain: () => {}, onSetup: () => {}, onTitle: () => {} }) : undefined;
    const r = createRoot(container as unknown as HTMLElement);
    root = r;
    r.render(createElement(Flight, { session, touch, onExit: () => {} }, children));
    await vi.waitFor(() => expect(resize.size).toBeGreaterThan(0));
    await settle();
    const turn = async (w: number, h: number) => { win.innerWidth = w; win.innerHeight = h; for (const fn of resize) fn(); await settle(); };
    const steps = (sec: number) => { for (let i = 0; i < Math.round(sec / STEP); i++) session.step(STEP); };
    const notice = () => all(container, 'overlay').filter(o => o.textContent.includes(t('flight.rotate')));
    const rootClass = () => container.childNodes[0].attrs.class.split(' ');
    const renderer = () => (globalThis as Record<string, unknown>).__rendererOpts as { onContextLost: () => void; onContextRestored: () => void };
    return { session, world, spawn, turn, steps, notice, rootClass, renderer };
  }

  it('tells a battle player, soldier or pilot, to turn the phone and that the match waits', () => {
    expect(t('flight.rotate')).toBe(ROTATE);
  });

  it.each(['soldier', 'heli'] as const)('pauses the %s under the portrait notice and resumes the same clock after turning', async role => {
    const { session, world, turn, steps, notice, rootClass } = await battle({ role });
    expect(world.avatar.kind).toBe(role);
    expect(notice()).toHaveLength(1);
    expect(notice()[0].textContent).toContain(ROTATE);
    expect(session.paused).toBe(true);
    expect(rootClass()).toContain('rotate');
    const t0 = world.time;
    steps(3);
    expect(world.time).toBe(t0);
    await turn(844, 390);
    expect(notice()).toHaveLength(0);
    expect(rootClass()).not.toContain('rotate');
    expect(session.paused).toBe(false);
    steps(3);
    expect(world.time).toBeCloseTo(t0 + 3, 6);
  });

  it('keeps the pause through a turn while the menu is open, until the menu is closed', async () => {
    const { session, world, turn, steps } = await battle();
    await turn(844, 390);
    expect(session.paused).toBe(false);
    reactProps(all(container, 'pause')[0]).onPointerDown({ preventDefault() {}, stopPropagation() {} });
    await vi.waitFor(() => expect(all(container, 'pause-buttons')).toHaveLength(1));
    await turn(390, 844);
    expect(session.paused).toBe(true);
    await turn(844, 390);
    expect(session.paused).toBe(true);
    const t0 = world.time;
    steps(1);
    expect(world.time).toBe(t0);
    reactProps(all(container, 'pause-buttons')[0].childNodes.find(b => b.textContent === t('brief.continue'))!).onClick();
    await settle();
    expect(session.paused).toBe(false);
  });

  it('draws no portrait notice under the open menu, and shows it once the menu closes, paused throughout', async () => {
    const { session, world, steps, notice, rootClass } = await battle();
    expect(notice()).toHaveLength(1);
    reactProps(all(container, 'pause')[0]).onPointerDown({ preventDefault() {}, stopPropagation() {} });
    await vi.waitFor(() => expect(all(container, 'pause-buttons')).toHaveLength(1));
    expect(notice()).toHaveLength(0);
    expect(session.paused).toBe(true);
    expect(rootClass()).toContain('rotate');
    const t0 = world.time;
    steps(1);
    expect(world.time).toBe(t0);
    reactProps(all(container, 'pause-buttons')[0].childNodes.find(b => b.textContent === t('brief.continue'))!).onClick();
    await settle();
    expect(all(container, 'pause-buttons')).toHaveLength(0);
    expect(notice()).toHaveLength(1);
    expect(session.paused).toBe(true);
    steps(1);
    expect(world.time).toBe(t0);
  });

  it('draws no portrait notice when turned to portrait with the menu already open', async () => {
    const { session, turn, notice, rootClass } = await battle();
    await turn(844, 390);
    reactProps(all(container, 'pause')[0]).onPointerDown({ preventDefault() {}, stopPropagation() {} });
    await vi.waitFor(() => expect(all(container, 'pause-buttons')).toHaveLength(1));
    await turn(390, 844);
    expect(notice()).toHaveLength(0);
    expect(rootClass()).toContain('rotate');
    expect(session.paused).toBe(true);
  });

  it('keeps the pause through a turn while the GL context is lost, until it comes back', async () => {
    const { session, turn, renderer } = await battle();
    renderer().onContextLost();
    await settle();
    expect(session.paused).toBe(true);
    await turn(844, 390);
    expect(session.paused).toBe(true);
    renderer().onContextRestored();
    await settle();
    expect(session.paused).toBe(false);
  });

  it('leaves the portrait deploy screen alone and pauses with the notice right on sortie', async () => {
    const { session, spawn, notice } = await battle({ deploy: false });
    expect(session.mode).toBe('deploy');
    expect(notice()).toHaveLength(0);
    expect(session.paused).toBe(false);
    expect(spawn()).toBe(true);
    await settle();
    expect(notice()).toHaveLength(1);
    expect(session.paused).toBe(true);
  });

  it('leaves a narrow desktop window running with no notice', async () => {
    const { session, notice, rootClass } = await battle({ touch: false });
    expect(notice()).toHaveLength(0);
    expect(rootClass()).not.toContain('rotate');
    expect(session.paused).toBe(false);
  });

  it('hides the coach under the notice without spending its time, and brings back the same line', async () => {
    const { world, turn, steps, rootClass } = await battle({ coach: true });
    await turn(844, 390);
    await vi.waitFor(() => expect(all(container, 'coach')).toHaveLength(1));
    const box = all(container, 'coach')[0];
    const line = box.textContent;
    steps(2);
    await settle(150);
    await turn(390, 844);
    expect(rootClass()).toContain('rotate');
    steps(STEP_TIMEOUT * 2);
    await settle(250);
    await turn(844, 390);
    await settle(150);
    expect(all(container, 'coach')).toEqual([box]);
    expect(box.textContent).toBe(line);
    steps(STEP_TIMEOUT - 2 - 1);
    await settle(150);
    expect(all(container, 'coach')[0]?.textContent).toBe(line);
    steps(2);
    await settle(150);
    expect(all(container, 'coach')[0]?.textContent).not.toBe(line);
    expect(world.time).toBeGreaterThan(STEP_TIMEOUT);
  });

  it('hides the coach only while the portrait notice is up', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.flight3d\.rotate \.coach\s*\{\s*display:\s*none;?\s*\}/);
  });
});
