import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import harekRaw from '../content/battle/maps/harek.json?raw';
import { FlightInput } from '../input/input';
import { createBattleSession } from '../sim/battle/runtime';
import type { BattleMapDef } from '../sim/battle/schema';
import { FlightRenderer } from './renderer';

const calls: string[] = [];
const gl = { lost: false, asyncLoss: false };

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
      const fire = () => { for (const fn of this.domElement.listeners.webglcontextlost) fn(); };
      if (gl.asyncLoss) queueMicrotask(fire);
      else fire();
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
  const listeners = { webglcontextlost: new Set<() => void>(), webglcontextrestored: new Set<() => void>() };
  type Kind = keyof typeof listeners;
  return {
    ...fakeCanvas(),
    listeners,
    remove() { calls.push('remove'); },
    addEventListener(type: string, fn: () => void) { listeners[type as Kind]?.add(fn); },
    removeEventListener(type: string, fn: () => void) { listeners[type as Kind]?.delete(fn); },
  };
}

const harek = JSON.parse(harekRaw) as BattleMapDef;

describe('disposing the renderer (#266)', () => {
  let crashes: unknown[];
  let context: string[];
  let renderer: FlightRenderer;
  let scheduled: FrameRequestCallback[];
  const canvas = () => (renderer as unknown as { renderer: { domElement: ReturnType<typeof glCanvas> } }).renderer.domElement;
  const fire = (type: 'webglcontextlost' | 'webglcontextrestored') => { for (const fn of canvas().listeners[type]) fn(); };

  beforeEach(() => {
    calls.length = 0;
    gl.lost = false;
    gl.asyncLoss = false;
    crashes = [];
    context = [];
    scheduled = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, scrollTo() {} });
    vi.stubGlobal('document', { createElement: fakeCanvas, createElementNS: fakeCanvas });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => scheduled.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { session } = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const overlay = fakeCanvas() as unknown as HTMLCanvasElement;
    const mount = { clientWidth: 640, clientHeight: 360, appendChild() {} } as unknown as HTMLElement;
    renderer = new FlightRenderer({ mount, overlay, session, input: new FlightInput(), onCrash: e => crashes.push(e), onContextLost: () => context.push('lost'), onContextRestored: () => context.push('restored') });
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

  it('reports a real context loss and its restoration, without a crash (#268)', () => {
    fire('webglcontextlost');
    expect(context).toEqual(['lost']);
    fire('webglcontextrestored');
    expect(context).toEqual(['lost', 'restored']);
    expect(crashes).toEqual([]);
  });

  it('drops its listeners before causing a loss whose event comes at once (#268)', () => {
    renderer.dispose();
    expect(context).toEqual([]);
    expect(canvas().listeners.webglcontextlost.size).toBe(0);
    expect(canvas().listeners.webglcontextrestored.size).toBe(0);
  });

  it('does not report its own loss when the event arrives after dispose has returned (#268)', async () => {
    gl.asyncLoss = true;
    renderer.dispose();
    await new Promise<void>(done => queueMicrotask(done));
    expect(calls).toContain('forceContextLoss');
    expect(context).toEqual([]);
  });
});
