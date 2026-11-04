import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import harekRaw from '../content/battle/maps/harek.json?raw';
import { FlightInput } from '../input/input';
import { createBattleSession } from '../sim/battle/runtime';
import type { BattleMapDef } from '../sim/battle/schema';
import { FlightRenderer } from './renderer';

const calls: string[] = [];
const gl = { lost: false };

vi.mock('three', async original => {
  const three = await original<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = glCanvas();
    info = { autoReset: false, reset() {}, render: { calls: 0, triangles: 0 } };
    outputColorSpace = '';
    getContext = () => ({ isContextLost: () => gl.lost });
    dispose = () => { calls.push('dispose'); };
    forceContextLoss = () => {
      calls.push('forceContextLoss');
      for (const fn of this.domElement.lostListeners) fn();
    };
    constructor() {
      return new Proxy(this, { get: (o, k) => (k in o ? o[k as keyof typeof o] : () => {}) });
    }
  }
  return { ...three, WebGLRenderer: FakeWebGLRenderer };
});
vi.mock('../assets/loader', () => ({ assets: { get: () => null, loadGroup: () => Promise.resolve({ loaded: [], failed: [] }) } }));

function fakeCanvas() {
  const drawing: Record<string, () => unknown> = {
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  const ctx = new Proxy({}, { get: (_, k) => drawing[String(k)] ?? (() => {}), set: () => true });
  return { width: 1, height: 1, style: {}, getContext: () => ctx, remove() {}, addEventListener() {}, removeEventListener() {}, setTransform() {} };
}

function glCanvas() {
  const lostListeners = new Set<() => void>();
  return {
    ...fakeCanvas(),
    lostListeners,
    remove() { calls.push('remove'); },
    addEventListener(type: string, fn: () => void) { if (type === 'webglcontextlost') lostListeners.add(fn); },
    removeEventListener(type: string, fn: () => void) { if (type === 'webglcontextlost') lostListeners.delete(fn); },
  };
}

const harek = JSON.parse(harekRaw) as BattleMapDef;

describe('disposing the renderer (#266)', () => {
  let crashes: unknown[];
  let renderer: FlightRenderer;

  beforeEach(() => {
    calls.length = 0;
    gl.lost = false;
    crashes = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, scrollTo() {} });
    vi.stubGlobal('document', { createElement: fakeCanvas, createElementNS: fakeCanvas });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { session } = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const overlay = fakeCanvas() as unknown as HTMLCanvasElement;
    const mount = { clientWidth: 640, clientHeight: 360, appendChild() {} } as unknown as HTMLElement;
    renderer = new FlightRenderer({ mount, overlay, session, input: new FlightInput(), onCrash: e => crashes.push(e) });
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives the WebGL context back once, after three has dropped its listeners', () => {
    renderer.dispose();
    expect(calls).toEqual(['dispose', 'forceContextLoss', 'remove']);
  });

  it('does not report its own context loss as a crash', () => {
    renderer.dispose();
    expect(crashes).toEqual([]);
  });

  it('leaves an already lost context alone, where three would claim the extension is missing', () => {
    gl.lost = true;
    renderer.dispose();
    expect(calls).toEqual(['dispose', 'remove']);
  });
});
