import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import harekRaw from '../content/battle/maps/harek.json?raw';
import { FlightInput } from '../input/input';
import { createBattleSession } from '../sim/battle/runtime';
import type { BattleMapDef } from '../sim/battle/schema';
import { FlightRenderer } from './renderer';

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

describe('an exception in the frame loop (#264)', () => {
  let clock: number;
  let scheduled: FrameRequestCallback[];
  let crashes: unknown[];
  let gl: { render: () => void };
  let session: ReturnType<typeof createBattleSession>['session'];

  const nextFrame = () => scheduled.shift()!(clock += 50);

  beforeEach(() => {
    scheduled = [];
    crashes = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, scrollTo() {} });
    vi.stubGlobal('document', { createElement: fakeCanvas, createElementNS: fakeCanvas });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => scheduled.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    session = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 }).session;
    session.start();
    const overlay = fakeCanvas() as unknown as HTMLCanvasElement;
    const mount = { clientWidth: 640, clientHeight: 360, appendChild() {} } as unknown as HTMLElement;
    gl = (new FlightRenderer({ mount, overlay, session, input: new FlightInput(), onCrash: e => crashes.push(e) }) as unknown as { renderer: typeof gl }).renderer;
    clock = performance.now();
    nextFrame();
    nextFrame();
    expect(crashes).toEqual([]);
    expect(scheduled).toHaveLength(1);
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const inject = {
    'session.step': (boom: Error) => { const o = session.step; session.step = () => { session.step = o; throw boom; }; },
    'renderer.render': (boom: Error) => { const o = gl.render; gl.render = () => { gl.render = o; throw boom; }; },
  };

  it.each(Object.keys(inject) as (keyof typeof inject)[])('reports a %s failure once and stops the loop', name => {
    const boom = new Error(name);
    inject[name](boom);
    expect(() => nextFrame()).not.toThrow();
    expect(crashes).toEqual([boom]);
    expect(scheduled).toHaveLength(0);
  });
});
