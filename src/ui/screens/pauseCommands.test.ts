import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { t } from '../../content/strings';
import { COMMANDS, PAUSE_COMMANDS } from '../../input/bindings';
import type { FlightInput, PadLike } from '../../input/input';
import type { BattleMapDef } from '../../sim/battle/schema';
import type { SoldierClass } from '../../sim/infantry/soldier';
import type { World } from '../../sim/world';
import { loadBattle } from '../battle/loadBattle';
import { Flight } from './Flight';

vi.mock('../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));
vi.mock('../../audio/game', () => ({ GameAudio: class { voice = { enabled: false }; muted = false; setVolume() {} async loadSamples() {} async resume() {} dispose() {} toggleMute() { return (this.muted = !this.muted); } } }));
vi.mock('../../render/renderer', () => ({
  FlightRenderer: class {
    calls: string[] = [];
    mpd = { next: (side: string) => { this.calls.push(`mpd:${side}`); } };
    constructor(opts: unknown) { (globalThis as Record<string, unknown>).__rendererOpts = opts; (globalThis as Record<string, unknown>).__renderer = this; }
    set pnvs(v: boolean) { this.calls.push(`pnvs:${v}`); }
    get pnvs() { return false; }
    set hud(v: boolean) { this.calls.push(`hud:${v}`); }
    applySettings() {}
    toggleView() { this.calls.push('view'); }
    clickAt() { this.calls.push('click'); }
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

function buttons(node: FakeNode): FakeNode[] {
  return node.childNodes.flatMap(c => [...(c.nodeName === 'BUTTON' ? [c] : []), ...buttons(c)]);
}

const reactProps = (node: FakeNode) => (node as unknown as Record<string, Record<string, (e?: unknown) => void>>)[Object.keys(node).find(k => k.startsWith('__reactProps'))!];
const harek = JSON.parse(harekRaw) as BattleMapDef;
const settle = () => new Promise(done => setTimeout(done, 20));
const TAP = { preventDefault() {}, stopPropagation() {} };

const PAD_LEFT = 14, PAD_RB = 5, PAD_X = 2, PAD_B = 1, PAD_UP = 12, PAD_RIGHT = 15, PAD_Y = 3, PAD_LB = 4, PAD_A = 0, PAD_DOWN = 13, PAD_START = 9;

function state(w: World) {
  const g = w.soldierGear, a = w.soldierArms;
  return {
    time: w.time,
    medkit: !!g.medkit, medkitLeft: g.medkitLeft, smokeLeft: g.smokeLeft, canisters: g.canisters.length, mineLeft: g.mineLeft, mines: g.mines.length,
    reloading: a.reloading, soldierWeapon: a.selected, stance: w.soldier?.stance ?? null, spot: w.spotRequest,
    flares: w.cm.flares, chaff: w.cm.chaff, fcr: w.fcr.scanning, fcrMode: w.fcr.mode, fcrSelected: w.fcr.selected,
    tads: w.tads.active, tadsFov: w.tads.fov, sensor: w.tads.sensor, weapon: w.arms.selected, salvo: w.arms.salvo, engine: w.player.engineOn,
  };
}

describe('commands while paused (#303)', () => {
  let root: Root | undefined;
  let container: FakeNode;
  let keydown: Set<(e: unknown) => void>;
  let resize: Set<() => void>;
  let win: { innerWidth: number; innerHeight: number };

  beforeEach(() => {
    keydown = new Set();
    resize = new Set();
    root = undefined;
    const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
    doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
    doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
    doc.documentElement = (doc.createElement as (t: string) => FakeNode)('html');
    doc.body = (doc.createElement as (t: string) => FakeNode)('body');
    win = {
      document: doc, location: { hash: '', search: '' }, HTMLIFrameElement: class {}, devicePixelRatio: 1, innerWidth: 844, innerHeight: 390, scrollTo() {},
      setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') keydown.add(fn); if (type === 'resize') resize.add(fn as () => void); },
      removeEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') keydown.delete(fn); if (type === 'resize') resize.delete(fn as () => void); },
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

  async function mount({ touch = false, role = 'soldier' as 'soldier' | 'heli', cls = 'assault' as SoldierClass, portrait = false } = {}) {
    if (portrait) { win.innerWidth = 390; win.innerHeight = 844; }
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const world = session.world;
    const pad = runtime.spawnPoints(world).find(p => p.role === 'heli' && p.kind === 'pad')!;
    session.deploy(role === 'heli' ? runtime.spawnFor(pad, mod.KITS.closeSupport) : { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls });
    if (role === 'soldier') {
      const a = world.soldierArms, m = a.ammo[a.selected]!;
      m.mag -= 1;
    }
    const r = createRoot(container as unknown as HTMLElement);
    root = r;
    r.render(createElement(Flight, { session, touch, onExit: () => {} }));
    await vi.waitFor(() => expect(keydown.size).toBeGreaterThan(0));
    await settle();
    const opts = () => (globalThis as Record<string, unknown>).__rendererOpts as { input: FlightInput; onContextLost: () => void; onContextRestored: () => void };
    const renderer = () => (globalThis as Record<string, unknown>).__renderer as { calls: string[] };
    const key = async (code: string) => { for (const fn of [...keydown]) fn({ code, repeat: false, preventDefault() {} }); await settle(); };
    let held: number[] = [];
    const padFrame = (pressed: number[]) => {
      const p: PadLike = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })) };
      opts().input.gamepads = () => [p];
      opts().input.update(world, 1 / 60);
    };
    const padPress = async (button: number) => { padFrame([...held, button]); padFrame(held); await settle(); };
    const tap = async (node: FakeNode) => { const p = reactProps(node); p.onPointerDown(TAP); p.onPointerUp?.(); await settle(); };
    const touchButton = (text: string) => buttons(container).find(b => b.textContent.startsWith(text))!;
    const menu = () => all(container, 'pause-buttons');
    const turn = async (w: number, h: number) => { win.innerWidth = w; win.innerHeight = h; for (const fn of resize) fn(); await settle(); };
    return { session, world, opts, renderer, key, padPress, setHeld: (b: number[]) => { held = b; }, tap, touchButton, menu, turn };
  }

  const SOLDIER_KEYS = ['KeyX', 'KeyF', 'KeyR', 'KeyC', 'KeyZ', 'Digit2', 'KeyQ'];
  const SOLDIER_PAD = [PAD_LEFT, PAD_RB, PAD_X, PAD_B, PAD_RIGHT, PAD_Y, PAD_LB];
  const HELI_KEYS = ['KeyF', 'KeyX', 'KeyR', 'KeyE', 'KeyT', 'KeyQ', 'Digit2', 'KeyI', 'Equal', 'KeyV', 'KeyN', 'BracketLeft', 'KeyU', 'Tab'];
  const HELI_PAD = [PAD_B, PAD_X, PAD_DOWN, PAD_UP, PAD_RIGHT, PAD_LEFT, PAD_RB, PAD_LB, PAD_A, PAD_Y];

  it('runs the soldier keys, pad buttons and touch buttons when not paused, so the paused checks below can fail', async () => {
    const k = await mount({ cls: 'assault' });
    const s0 = state(k.world);
    await k.key('KeyX');
    await k.key('KeyF');
    await k.key('KeyR');
    await k.key('KeyC');
    const s1 = state(k.world);
    expect(s1.medkit).toBe(true);
    expect(s1.smokeLeft).toBe(s0.smokeLeft - 1);
    expect(s1.reloading).toBeGreaterThan(0);
    expect(s1.stance).toBe('crouch');
  });

  it('runs the pad medkit and smoke when not paused', async () => {
    const k = await mount({ cls: 'assault' });
    const s0 = state(k.world);
    await k.padPress(PAD_LEFT);
    await k.padPress(PAD_RB);
    await k.padPress(PAD_X);
    await k.padPress(PAD_B);
    const s1 = state(k.world);
    expect(s1.medkit).toBe(true);
    expect(s1.smokeLeft).toBe(s0.smokeLeft - 1);
    expect(s1.reloading).toBeGreaterThan(0);
    expect(s1.stance).toBe('crouch');
  });

  it('runs the engineer mine and the pilot flare, chaff and radar when not paused', async () => {
    const e = await mount({ cls: 'engineer' });
    const m0 = state(e.world).mineLeft;
    await e.key('KeyB');
    expect(state(e.world).mineLeft).toBe(m0 - 1);
    root!.unmount(); root = undefined; await settle();
    const h = await mount({ role: 'heli' });
    const s0 = state(h.world);
    await h.key('KeyF');
    await h.key('KeyX');
    await h.key('KeyR');
    const s1 = state(h.world);
    expect(s1.flares).toBeLessThan(s0.flares);
    expect(s1.chaff).toBe(s0.chaff - 1);
    expect(s1.fcr).toBe(true);
  });

  it('keeps the keyboard soldier gear, reload, stance and weapon as they are under Esc, and runs them again after Esc', async () => {
    const k = await mount({ cls: 'assault' });
    await k.key('Escape');
    expect(k.menu()).toHaveLength(1);
    expect(k.session.paused).toBe(true);
    const s0 = state(k.world);
    for (const code of SOLDIER_KEYS) { await k.key(code); expect(state(k.world), code).toEqual(s0); }
    expect(state(k.world)).toEqual(s0);
    await k.key('Escape');
    expect(k.menu()).toHaveLength(0);
    expect(k.session.paused).toBe(false);
    await k.key('KeyX');
    await k.key('KeyF');
    expect(state(k.world).medkit).toBe(true);
    expect(state(k.world).smokeLeft).toBe(s0.smokeLeft - 1);
  });

  it('keeps the engineer mine under Esc', async () => {
    const k = await mount({ cls: 'engineer' });
    await k.key('Escape');
    const s0 = state(k.world);
    await k.key('KeyB');
    await k.padPress(PAD_RB);
    expect(state(k.world)).toEqual(s0);
  });

  it('keeps the pad soldier medkit (left), smoke (RB), reload, stance and weapon under Start, and Start resumes', async () => {
    const k = await mount({ cls: 'assault' });
    await k.padPress(PAD_START);
    expect(k.menu()).toHaveLength(1);
    const s0 = state(k.world);
    for (const b of SOLDIER_PAD) { await k.padPress(b); expect(state(k.world), `pad ${b}`).toEqual(s0); }
    expect(state(k.world)).toEqual(s0);
    await k.padPress(PAD_START);
    expect(k.menu()).toHaveLength(0);
    await k.padPress(PAD_LEFT);
    expect(state(k.world).medkit).toBe(true);
  });

  it('keeps the keyboard and pad pilot flares, chaff, radar, sight, weapon and engine under Esc', async () => {
    const k = await mount({ role: 'heli' });
    await k.key('Escape');
    expect(k.session.paused).toBe(true);
    const s0 = state(k.world), calls0 = k.renderer().calls.length;
    for (const code of HELI_KEYS) { await k.key(code); expect(state(k.world), code).toEqual(s0); }
    for (const b of HELI_PAD) { await k.padPress(b); expect(state(k.world), `pad ${b}`).toEqual(s0); }
    expect(state(k.world)).toEqual(s0);
    expect(k.renderer().calls.slice(calls0)).toEqual([]);
    await k.key('Escape');
    await k.key('KeyF');
    expect(state(k.world).flares).toBeLessThan(s0.flares);
  });

  it('keeps the touch soldier buttons from acting under the menu, and they act after continue', async () => {
    const k = await mount({ touch: true, cls: 'assault' });
    await k.tap(all(container, 'pause')[0]);
    expect(k.menu()).toHaveLength(1);
    const s0 = state(k.world);
    const gear = all(container, 'soldier-gear')[0];
    for (const b of buttons(gear)) { const label = b.textContent; await k.tap(b); expect(state(k.world), label).toEqual(s0); }
    await k.tap(all(container, 'stance')[0]);
    await new Promise(done => setTimeout(done, 500));
    expect(state(k.world)).toEqual(s0);
    reactProps(buttons(k.menu()[0]).find(b => b.textContent === t('brief.continue'))!).onClick();
    await settle();
    expect(k.session.paused).toBe(false);
    await k.tap(k.touchButton(t('touch.medkit')));
    await k.tap(k.touchButton(t('touch.smoke')));
    expect(state(k.world).medkit).toBe(true);
    expect(state(k.world).smokeLeft).toBe(s0.smokeLeft - 1);
  });

  it('keeps the touch pilot buttons from acting under the menu, while the menu view and engine buttons still work', async () => {
    const k = await mount({ touch: true, role: 'heli' });
    await k.tap(all(container, 'pause')[0]);
    expect(k.menu()).toHaveLength(1);
    const s0 = state(k.world), calls0 = k.renderer().calls.length;
    for (const b of [...buttons(all(container, 'tcol')[0]), ...buttons(all(container, 'tcm')[0])]) { const label = b.textContent; await k.tap(b); expect(state(k.world), label).toEqual(s0); }
    const engine = all(container, 'engine')[0];
    if (engine) await k.tap(engine);
    expect(state(k.world)).toEqual(s0);
    const menuButton = (label: string) => buttons(k.menu()[0]).find(b => b.textContent === label)!;
    reactProps(menuButton(t(k.world.player.engineOn ? 'pause.engineOff' : 'pause.engineOn'))).onClick();
    await settle();
    expect(k.world.player.engineOn).toBe(!s0.engine);
    reactProps(menuButton(t('pause.view'))).onClick();
    await settle();
    expect(k.renderer().calls.slice(calls0)).toEqual(['view']);
    expect(k.session.paused).toBe(false);
    await k.tap(buttons(all(container, 'tcm')[0])[0]);
    expect(state(k.world).flares).toBeLessThan(s0.flares);
  });

  it('keeps the soldier and pilot keys and pad buttons from acting while the GL context is lost, and runs them after it comes back', async () => {
    const k = await mount({ cls: 'assault' });
    k.opts().onContextLost();
    await settle();
    expect(k.session.paused).toBe(true);
    const s0 = state(k.world);
    for (const code of SOLDIER_KEYS) { await k.key(code); expect(state(k.world), code).toEqual(s0); }
    for (const b of SOLDIER_PAD) { await k.padPress(b); expect(state(k.world), `pad ${b}`).toEqual(s0); }
    expect(state(k.world)).toEqual(s0);
    k.opts().onContextRestored();
    await settle();
    expect(k.session.paused).toBe(false);
    await k.key('KeyX');
    await k.padPress(PAD_RB);
    expect(state(k.world).medkit).toBe(true);
    expect(state(k.world).smokeLeft).toBe(s0.smokeLeft - 1);
  });

  it.each(['soldier', 'heli'] as const)('keeps the %s keys and pad buttons from acting under the portrait notice, and runs them after turning', async role => {
    const k = await mount({ touch: true, role, portrait: true });
    expect(k.session.paused).toBe(true);
    expect(k.menu()).toHaveLength(0);
    const s0 = state(k.world);
    for (const code of role === 'heli' ? HELI_KEYS : SOLDIER_KEYS) { await k.key(code); expect(state(k.world), code).toEqual(s0); }
    for (const b of role === 'heli' ? HELI_PAD : SOLDIER_PAD) { await k.padPress(b); expect(state(k.world), `pad ${b}`).toEqual(s0); }
    expect(state(k.world)).toEqual(s0);
    await k.turn(844, 390);
    expect(k.session.paused).toBe(false);
    if (role === 'heli') {
      await k.key('KeyF');
      expect(state(k.world).flares).toBeLessThan(s0.flares);
    } else {
      await k.key('KeyX');
      expect(state(k.world).medkit).toBe(true);
    }
  });

  it('lets mute work under the menu', async () => {
    const k = await mount({ cls: 'assault' });
    await k.key('Escape');
    expect(all(container, 'score3d')).toHaveLength(0);
    await k.key('KeyM');
    expect(all(container, 'score3d').map(n => n.textContent)).toEqual([t('hud.muted')]);
    expect(k.session.paused).toBe(true);
  });
  it('lets only pause, help and mute through a pause', () => {
    expect([...PAUSE_COMMANDS].sort()).toEqual(['help', 'mute', 'pause']);
    expect(COMMANDS.filter(c => PAUSE_COMMANDS.has(c)).sort()).toEqual(['help', 'mute', 'pause']);
  });

  it.each([['soldier', 'assault'], ['soldier', 'engineer'], ['heli', 'assault']] as const)('blocks every other command, new ones included, for the %s (%s) under the menu', async (role, cls) => {
    const k = await mount({ role, cls });
    await k.key('Escape');
    expect(k.menu()).toHaveLength(1);
    const input = k.opts().input;
    input.headYaw = 0.4; input.headPitch = 0.2;
    const s0 = state(k.world), calls0 = k.renderer().calls.length;
    const blocked = COMMANDS.filter(c => !PAUSE_COMMANDS.has(c));
    expect(blocked.length).toBe(COMMANDS.length - 3);
    for (const cmd of blocked) {
      input.onCommand!(cmd);
      await settle();
      expect(state(k.world), cmd).toEqual(s0);
      expect(k.renderer().calls.slice(calls0), cmd).toEqual([]);
      expect([input.headYaw, input.headPitch], cmd).toEqual([0.4, 0.2]);
      expect(k.menu(), cmd).toHaveLength(1);
      expect(all(container, 'score3d'), cmd).toHaveLength(0);
    }
    input.onCommand!('pause');
    await settle();
    expect(k.menu()).toHaveLength(0);
    expect(k.session.paused).toBe(false);
  });
});
