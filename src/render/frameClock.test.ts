import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEP } from '../sim/world';
import { drainSteps, frameDt, PACE_WINDOW_MS, PaceMeter, paceLabel } from './frameClock';
import rendererSource from './renderer?raw';
import flightSource from '../ui/screens/Flight.tsx?raw';

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

function metered(intervals: number[], meter = new PaceMeter(), at = { now: 1000, last: 1000, acc: 0 }) {
  const readings: (number | null)[] = [];
  for (const ms of intervals) {
    at.now += ms;
    const dt = frameDt(at.now, at.last); at.last = at.now;
    const { steps, acc } = drainSteps(at.acc + dt);
    at.acc = acc;
    meter.record(at.now, steps);
    readings.push(meter.ratio);
  }
  return { readings, ratio: readings[readings.length - 1], meter, at };
}

const settled = (readings: (number | null)[]) => readings.filter((r): r is number => r !== null);
const lowest = (readings: number[]) => readings.reduce((a, b) => Math.min(a, b), Infinity);

describe('PaceMeter', () => {
  it('reads nothing until a full window has passed', () => {
    expect(new PaceMeter().ratio).toBeNull();
    const { readings } = metered(steady(60, 6));
    const first = readings.findIndex(r => r !== null);
    expect(first).toBeGreaterThanOrEqual(299);
    expect(first).toBeLessThanOrEqual(301);
    expect(settled(readings)).toHaveLength(readings.length - first);
  });

  it.each([[3, 0.15], [3.5, 0.175], [4, 0.2], [10, 0.5], [15, 0.75]])('reads a steady %f fps as %f', (fps, want) => {
    const { ratio } = metered(steady(fps));
    expect(Math.abs(ratio! - want)).toBeLessThan(0.01);
  });

  it.each([[20], [25], [30], [60], [120], [144]])('reads at least 0.98 at a steady %i fps', fps => {
    expect(lowest(settled(metered(steady(fps)).readings))).toBeGreaterThanOrEqual(0.98);
  });

  it('reads at least 0.98 whenever every interval is 50 ms or less, however uneven', () => {
    const r = rng(222);
    const intervals = Array.from({ length: 20000 }, () => 1 + 49 * r());
    const readings = settled(metered(intervals).readings);
    expect(readings.length).toBeGreaterThan(10000);
    expect(lowest(readings)).toBeGreaterThanOrEqual(0.98);
    expect(lowest(settled(metered(alternating(20, 50)).readings))).toBeGreaterThanOrEqual(0.98);
  });

  it('reads the slowdown from uneven frames at a 20 fps average', () => {
    expect(metered(alternating(40, 60)).ratio).toBeCloseTo(0.9, 2);
    expect(metered(alternating(30, 70)).ratio).toBeCloseTo(0.8, 2);
  });

  it.each([[20, 0.1, 0.96], [20, 0.25, 0.902], [25, 0.25, 0.972]])('averages about the slowdown at %i fps with coefficient of variation %f', (fps, cv, want) => {
    const readings = settled(metered(logNormal(fps, cv)).readings);
    expect(Math.abs(readings.reduce((a, b) => a + b, 0) / readings.length - want)).toBeLessThan(0.003);
    expect(lowest(readings)).toBeLessThan(1);
  });

  it('agrees with the game time the loop really ran over the window', () => {
    const r = rng(9), intervals = Array.from({ length: 30000 }, () => r() < 0.02 ? 300 * r() : 40 * r());
    const meter = new PaceMeter(), at = { now: 0, last: 0, acc: 0 }, frames: { now: number; steps: number }[] = [];
    for (const [i, ms] of intervals.entries()) {
      at.now += ms;
      const dt = frameDt(at.now, at.last); at.last = at.now;
      const { steps, acc } = drainSteps(at.acc + dt);
      at.acc = acc;
      meter.record(at.now, steps);
      frames.push({ now: at.now, steps });
      if (at.now < PACE_WINDOW_MS || i % 97) continue;
      let from = 0;
      for (let j = frames.length - 1; j >= 0; j--) if (frames[j].now <= at.now - PACE_WINDOW_MS) { from = j; break; }
      const game = frames.slice(from + 1).reduce((a, f) => a + f.steps * STEP, 0);
      expect(meter.ratio).toBeCloseTo(game / ((at.now - frames[from].now) / 1000), 9);
    }
  });

  it('forgets everything older than the window', () => {
    const slow = metered(steady(60, 30));
    const after = metered(steady(10, 6), slow.meter, slow.at);
    expect(after.ratio).toBeCloseTo(0.5, 2);
    const fast = metered(steady(60, 6), after.meter, after.at);
    expect(fast.ratio).toBeGreaterThanOrEqual(0.98);
  });

  it('still counts what is inside the window', () => {
    const slow = metered(steady(10, 30));
    expect(metered(steady(60, 2.5), slow.meter, slow.at).ratio).toBeCloseTo(0.75, 1);
  });

  it('shows a long stall for one window and then recovers', () => {
    const start = metered(steady(60, 6));
    const stalled = metered([5000], start.meter, start.at);
    expect(stalled.ratio).toBeLessThan(0.02);
    expect(metered(steady(60, 6), stalled.meter, stalled.at).ratio).toBeGreaterThanOrEqual(0.98);
  });
});

describe('paceLabel', () => {
  it('says the ratio in Korean with two decimals', () => {
    expect(paceLabel(0.1846)).toBe('게임 속도 0.18배');
    expect(paceLabel(1)).toBe('게임 속도 1.00배');
  });

  it('says it is still measuring before the first reading', () => {
    expect(paceLabel(null)).toBe('게임 속도 측정 중');
  });
});

describe('the ?fps pace display', () => {
  it('records the steps of every frame only when asked to measure', () => {
    const tick = rendererSource.slice(rendererSource.indexOf('private tick ='));
    expect(rendererSource).toContain('private pace: PaceMeter | null = null;');
    expect(rendererSource).toContain('measurePace() { this.pace = new PaceMeter(); }');
    expect(rendererSource.match(/new PaceMeter/g)).toHaveLength(1);
    expect(tick.match(/this\.pace\b/g)).toHaveLength(1);
    expect(tick).toContain('this.pace?.record(now, steps);');
    expect(tick.indexOf('this.pace?.record(now, steps);')).toBeGreaterThan(tick.indexOf('session.step(STEP)'));
  });

  it('is switched on only by the fps query', () => {
    expect(flightSource).toContain("const [measurePace] = useState(() => new URLSearchParams(location.search).has('fps'));");
    expect(flightSource).toContain('{measurePace && <div className="pace" ref={paceRef} />}');
    expect(flightSource).toContain('if (measurePace) { r.showFps = true; r.logStats = true; r.measurePace(); }');
    expect(flightSource.match(/measurePace\(\)/g)).toHaveLength(1);
    expect(flightSource.match(/paceLabel\(/g)).toHaveLength(1);
    expect(flightSource).toContain('if (paceRef.current) paceRef.current.textContent = paceLabel(');
  });

  it('sits in the gap under the status bar on the small screen and takes no taps', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
    const rule = css.slice(css.indexOf('.pace {'), css.indexOf('}', css.indexOf('.pace {')));
    expect(rule).toContain('left: 50%');
    expect(rule).toContain('top: calc(44px + env(safe-area-inset-top))');
    expect(rule).toContain('line-height: 18px');
    expect(rule).toContain('pointer-events: none');
  });
});
