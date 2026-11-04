import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import harekRaw from '../content/battle/maps/harek.json?raw';
import type { GameAudio } from '../audio/game';
import { FlightInput } from '../input/input';
import { createBattleSession } from '../sim/battle/runtime';
import type { BattleMapDef } from '../sim/battle/schema';
import { STANDARD_LOADOUT } from '../sim/heli/loadout';
import { STEP } from '../sim/world';
import { FlightRenderer, type FrameInfo } from './renderer';
import type { TadsView } from './tadsView';

vi.mock('three', async original => {
  const three = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = fakeCanvas();
    info = { autoReset: false, reset() {}, render: { calls: 0, triangles: 0 } };
    outputColorSpace = '';
    render = () => {};
    constructor() {
      return new Proxy(this, { get: (o, k) => (k in o ? o[k as keyof typeof o] : () => {}) });
    }
  }
  return { ...three, WebGLRenderer: FakeWebGLRenderer };
});
vi.mock('../assets/loader', () => ({ assets: { get: () => null, loadGroup: () => Promise.resolve({ loaded: [], failed: [] }) } }));

function fakeCanvas() {
  const calls: Record<string, () => unknown> = {
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  const ctx = new Proxy({}, { get: (_, k) => calls[String(k)] ?? (() => {}), set: () => true });
  return { width: 1, height: 1, style: {}, getContext: () => ctx, remove() {}, addEventListener() {}, removeEventListener() {}, setTransform() {} };
}

const harek = JSON.parse(harekRaw) as BattleMapDef;
const FRAME_MS = 50;
const SIX_SECONDS = 120;

vi.setConfig({ testTimeout: 60_000 });

interface Part { alive: boolean; life: number; pos: THREE.Vector3 }
type Layers = { glow: { parts: Part[] }; smoke: { parts: Part[] } };

describe('pausing stops visual time (#269)', () => {
  let clock: number;
  let scheduled: FrameRequestCallback[];
  let frames: FrameInfo[];
  let audio: { soldier?: { dt: number } | null }[];
  let battle: ReturnType<typeof createBattleSession>;
  let input: FlightInput;
  let renderer: FlightRenderer;

  const run = (n: number) => { for (let i = 0; i < n; i++) scheduled.shift()!(clock += FRAME_MS); };
  const layers = () => renderer.effects as unknown as Layers;
  const live = (layer: 'glow' | 'smoke') => layers()[layer].parts.filter(p => p.alive);
  const particles = () => (['glow', 'smoke'] as const).map(l => live(l).map(p => [p.life, p.pos.x, p.pos.y, p.pos.z]));
  const lifeSum = () => [...live('glow'), ...live('smoke')].reduce((s, p) => s + p.life, 0);

  function fireUntilBothLayersLive() {
    const { session } = battle;
    input.mouseFire = true;
    for (let i = 0; i < 2400 && (live('glow').length === 0 || live('smoke').length === 0); i++) {
      input.update(session.world, STEP);
      session.step(STEP);
    }
    input.mouseFire = false;
    expect(live('glow').length).toBeGreaterThan(0);
    expect(live('smoke').length).toBeGreaterThan(0);
  }

  beforeEach(() => {
    scheduled = [];
    frames = [];
    audio = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, scrollTo() {} });
    vi.stubGlobal('document', { createElement: fakeCanvas, createElementNS: fakeCanvas });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => scheduled.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    battle = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    const { session, runtime } = battle;
    session.start();
    const spawn = runtime.spawnPoints(session.world).find(p => p.role === 'soldier')!;
    expect(session.deploy(runtime.spawnFor(spawn, STANDARD_LOADOUT, 'assault'))).toBe(true);
    input = new FlightInput();
    const overlay = fakeCanvas() as unknown as HTMLCanvasElement;
    const mount = { clientWidth: 640, clientHeight: 360, appendChild() {} } as unknown as HTMLElement;
    renderer = new FlightRenderer({ mount, overlay, session, input, onCrash: e => { throw e; }, onFrame: f => frames.push(f) });
    renderer.audio = { update: (s: (typeof audio)[number]) => audio.push(s), onEvent() {} } as unknown as GameAudio;
    clock = Math.ceil(performance.now());
    run(2);
    fireUntilBothLayersLive();
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('holds puppet time and every live particle for six seconds of paused frames', () => {
    const { session } = battle;
    session.paused = true;
    const world = session.world.time, puppets = renderer.units.puppets.time, before = particles();
    run(SIX_SECONDS);
    expect(session.world.time).toBe(world);
    expect(renderer.units.puppets.time).toBe(puppets);
    expect(particles()).toEqual(before);
  });

  it('spawns no trail from what is still in flight while paused', () => {
    const { session } = battle;
    const at = session.world.playerBody().pos.clone().setY(200);
    session.world.flares.push({ pos: at, vel: new THREE.Vector3(0, -1, 0), life: 5 });
    session.paused = true;
    const before = particles();
    run(SIX_SECONDS);
    expect(particles()).toEqual(before);
  });

  it('carries on from the held values when resumed', () => {
    const { session } = battle;
    session.paused = true;
    run(SIX_SECONDS);
    const world = session.world.time, puppets = renderer.units.puppets.time, life = lifeSum();
    const moving = [...live('glow'), ...live('smoke')].find(p => p.life > 0.2)!;
    const from = moving.pos.clone();
    session.paused = false;
    run(1);
    const stepped = session.world.time - world;
    expect(stepped).toBeGreaterThan(0);
    expect(renderer.units.puppets.time - puppets).toBeCloseTo(stepped, 9);
    expect(lifeSum()).toBeLessThan(life);
    expect(moving.alive).toBe(true);
    expect(moving.pos.equals(from)).toBe(false);
  });

  it('reports no elapsed time to the message log and footsteps while paused', () => {
    run(1);
    expect(frames.at(-1)!.simDt).toBeGreaterThan(0);
    expect(audio.at(-1)!.soldier!.dt).toBeGreaterThan(0);
    battle.session.paused = true;
    run(3);
    expect(frames.slice(-3).map(f => f.simDt)).toEqual([0, 0, 0]);
    expect(audio.slice(-3).map(s => s.soldier!.dt)).toEqual([0, 0, 0]);
  });

  it('keeps the frame pace measurement independent of pausing', () => {
    renderer.measurePace();
    run(SIX_SECONDS);
    const running = renderer.paceRatio!;
    expect(running).toBeCloseTo(1, 1);
    battle.session.paused = true;
    run(SIX_SECONDS);
    expect(renderer.paceRatio).toBeCloseTo(running, 6);
  });
});

describe('the PNVS pass adds no visual time (#271)', () => {
  let clock: number;
  let scheduled: FrameRequestCallback[];
  let session: ReturnType<typeof createBattleSession>['session'];
  let renderer: FlightRenderer;
  let passes: { mock: { calls: unknown[] } };

  const run = (n: number, frameMs: number) => { for (let i = 0; i < n; i++) scheduled.shift()!(clock += frameMs); };
  const advance = (n: number, frameMs: number) => {
    const world = session.world.time, puppets = renderer.units.puppets.time, drawn = passes.mock.calls.length;
    run(n, frameMs);
    return { world: session.world.time - world, puppets: renderer.units.puppets.time - puppets, drawn: passes.mock.calls.length - drawn };
  };

  function fly(seed: number) {
    const battle = createBattleSession(harek, 'quick', { side: 'coalition', seed });
    session = battle.session;
    session.start();
    const pad = battle.runtime.spawnPoints(session.world).find(p => p.id === 'base')!;
    expect(session.deploy(battle.runtime.spawnFor(pad, STANDARD_LOADOUT))).toBe(true);
    const overlay = fakeCanvas() as unknown as HTMLCanvasElement;
    const mount = { clientWidth: 640, clientHeight: 360, appendChild() {} } as unknown as HTMLElement;
    renderer = new FlightRenderer({ mount, overlay, session, input: new FlightInput(), onCrash: e => { throw e; } });
    passes = vi.spyOn((renderer as unknown as { pnvsView: TadsView }).pnvsView, 'renderImage');
    clock = performance.now();
    run(2, FRAME_MS);
    expect(renderer.view).toBe('cockpit');
    expect(session.world.avatar.kind).toBe('heli');
  }

  beforeEach(() => {
    scheduled = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, scrollTo() {} });
    vi.stubGlobal('document', { createElement: fakeCanvas, createElementNS: fakeCanvas });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => scheduled.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([[1, FRAME_MS], [2, FRAME_MS], [1, 1000 / 60]])('keeps puppet time on game time with PNVS on and off (seed %i, %f ms frames)', (seed, frameMs) => {
    fly(seed);
    const frames = Math.ceil(1000 / frameMs);
    renderer.pnvs = true;
    const on = advance(frames, frameMs);
    renderer.pnvs = false;
    const off = advance(frames, frameMs);
    expect(on.drawn).toBe(frames);
    expect(off.drawn).toBe(0);
    for (const window of [on, off]) {
      expect(window.world).toBeGreaterThanOrEqual(0.5);
      expect(window.puppets / window.world).toBeCloseTo(1, 6);
    }
  });

  it('holds puppet time for six seconds of paused frames with PNVS on and carries on when resumed', () => {
    fly(1);
    renderer.pnvs = true;
    session.paused = true;
    const paused = advance(SIX_SECONDS, FRAME_MS);
    expect(paused.drawn).toBe(SIX_SECONDS);
    expect(paused.world).toBe(0);
    expect(paused.puppets).toBe(0);
    session.paused = false;
    const resumed = advance(20, FRAME_MS);
    expect(resumed.drawn).toBe(20);
    expect(resumed.world).toBeGreaterThanOrEqual(0.5);
    expect(resumed.puppets / resumed.world).toBeCloseTo(1, 6);
  });
});
