import { describe, expect, it } from 'vitest';
import { STEP } from '../sim/world';
import { drainSteps, frameDt } from './frameClock';
import rendererSource from './renderer?raw';

function play(intervals: number[]) {
  let now = 0, last = 0, acc = 0, total = 0, maxSteps = 0, maxAcc = 0;
  for (const ms of intervals) {
    now += ms;
    const dt = frameDt(now, last); last = now;
    const drained = drainSteps(acc + dt);
    acc = drained.acc;
    total += drained.steps;
    maxSteps = Math.max(maxSteps, drained.steps);
    maxAcc = Math.max(maxAcc, acc);
  }
  return { ratio: total * STEP / (now / 1000), maxSteps, maxAcc };
}

const steady = (fps: number, seconds = 60) => Array<number>(Math.round(fps * seconds)).fill(1000 / fps);
const alternating = (a: number, b: number, frames = 2400) => Array.from({ length: frames }, (_, i) => i % 2 ? b : a);

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function logNormal(fps: number, cv: number, frames = 200000, seed = 219) {
  const r = rng(seed), mean = 1000 / fps, sigma = Math.sqrt(Math.log(1 + cv * cv)), mu = Math.log(mean) - sigma * sigma / 2;
  return Array.from({ length: frames }, () => Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())));
}

describe('frameDt', () => {
  it('passes intervals up to 50 ms through in seconds', () => {
    expect(frameDt(1010, 1000)).toBeCloseTo(0.01, 12);
    expect(frameDt(49, 0)).toBeCloseTo(0.049, 12);
    expect(frameDt(50, 0)).toBe(0.05);
  });

  it('cuts anything longer to exactly 0.05 s', () => {
    expect(frameDt(50.001, 0)).toBe(0.05);
    expect(frameDt(100, 0)).toBe(0.05);
    expect(frameDt(5000, 0)).toBe(0.05);
  });
});

describe('drainSteps', () => {
  it('leaves less than a step alone', () => {
    expect(drainSteps(0)).toEqual({ steps: 0, acc: 0 });
    expect(drainSteps(STEP / 2)).toEqual({ steps: 0, acc: STEP / 2 });
  });

  it('takes a step at exactly one STEP and keeps the remainder', () => {
    expect(drainSteps(STEP)).toEqual({ steps: 1, acc: 0 });
    const { steps, acc } = drainSteps(STEP * 2.5);
    expect(steps).toBe(2);
    expect(acc).toBeCloseTo(STEP / 2, 12);
  });

  it('takes six steps from the longest frame', () => {
    expect(drainSteps(0.05).steps).toBe(6);
    expect(drainSteps(STEP / 2 + 0.05).steps).toBe(6);
  });

  it('can reach a seventh step only when rounding lands a nearly full accumulator on the seventh', () => {
    const justUnderStep = STEP * (1 - 2 ** -52);
    expect(justUnderStep).toBeLessThan(STEP);
    const { steps, acc } = drainSteps(justUnderStep + 0.05);
    expect(steps).toBe(7);
    expect(acc).toBeLessThan(STEP);
  });
});

describe('game time per real time', () => {
  it.each([[10, 0.5], [15, 0.75], [20, 1], [30, 1], [60, 1], [144, 1]])('at a steady %i fps runs at %f', (fps, want) => {
    const { ratio, maxSteps, maxAcc } = play(steady(fps));
    expect(ratio).toBeCloseTo(want, 3);
    expect(maxSteps).toBeLessThanOrEqual(6);
    expect(maxAcc).toBeLessThan(STEP);
  });

  it('stays at 1 when every interval is 50 ms or less, however uneven', () => {
    expect(play(alternating(20, 50)).ratio).toBeCloseTo(1, 3);
    expect(play(alternating(5, 45)).ratio).toBeCloseTo(1, 3);
  });

  it('drops below 1 at a 20 fps average once intervals pass 50 ms', () => {
    expect(play(alternating(40, 60)).ratio).toBeCloseTo(0.9, 3);
    expect(play(alternating(30, 70)).ratio).toBeCloseTo(0.8, 3);
    expect(play(alternating(49, 51)).ratio).toBeLessThan(1);
  });

  it.each([[20, 0.1, 0.96], [20, 0.25, 0.902], [25, 0.25, 0.972]])('at %i fps with coefficient of variation %f runs at about %f', (fps, cv, want) => {
    const { ratio, maxSteps, maxAcc } = play(logNormal(fps, cv));
    expect(Math.abs(ratio - want)).toBeLessThan(0.002);
    expect(maxSteps).toBeLessThanOrEqual(6);
    expect(maxAcc).toBeLessThan(STEP);
  });

  it('throws a long stall away instead of catching up', () => {
    const { ratio, maxSteps, maxAcc } = play([...steady(60, 5), 5000, ...steady(60, 5)]);
    expect(ratio).toBeCloseTo((5 + 0.05 + 5) / 15, 2);
    expect(maxSteps).toBeLessThanOrEqual(6);
    expect(maxAcc).toBeLessThan(STEP);
  });

  it('never leaves a full step behind under random intervals', () => {
    const r = rng(7), { ratio, maxSteps, maxAcc } = play(Array.from({ length: 100000 }, () => r() < 0.01 ? 2000 * r() : 120 * r()));
    expect(ratio).toBeLessThan(1);
    expect(maxSteps).toBeLessThanOrEqual(6);
    expect(maxAcc).toBeLessThan(STEP);
  });
});

describe('FlightRenderer.tick', () => {
  const tick = rendererSource.slice(rendererSource.indexOf('private tick ='));

  it('drives the simulation through these functions', () => {
    expect(tick).toContain('const dt = frameDt(now, this.last); this.last = now;');
    expect(tick).toContain('input.update(world, dt);');
    expect(tick).toContain('const { steps, acc } = drainSteps(this.acc + dt);');
    expect(tick).toContain('this.acc = acc;');
    expect(tick).toContain('for (let i = 0; i < steps; i++) session.step(STEP);');
    expect(rendererSource.match(/session\.step\(/g)).toHaveLength(1);
    expect(rendererSource).not.toMatch(/this\.acc\s*(\+=|-=)/);
  });
});
