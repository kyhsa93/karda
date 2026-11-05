import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPTURED } from '../../../sim/battle/conquest';
import { CaptureMarks, CHANGE_HOLD, drawRing, FULL, markText, markTextY, RING_BACKING, RING_RADIUS, RING_WIDTH, type MarkPoint } from './captureMark';

const point = (over: Partial<MarkPoint> = {}): MarkPoint => ({ id: 'D', x: 0, z: 0, radius: 50, v: 24, contested: false, ...over });

function watched(before: Partial<MarkPoint>, after: Partial<MarkPoint>, now = 10) {
  const marks = new CaptureMarks();
  marks.update([point(before)], now - 0.1);
  const p = point(after);
  marks.update([p], now);
  return { marks, p, mark: marks.of(p, now) };
}

describe('capture mark state (#228)', () => {
  it('fills as v rises from 24 to 62', () => {
    const a = watched({ v: 20 }, { v: 24 }).mark!;
    const b = watched({ v: 58 }, { v: 62 }).mark!;
    expect(a.progress).toBeCloseTo(0.24);
    expect(b.progress).toBeCloseTo(0.62);
    expect(b.progress).toBeGreaterThan(a.progress);
  });

  it('scales by the sim capture limit', () => {
    expect(FULL).toBe(CAPTURED);
  });

  it('gives each sign of v its side symbol and owner, so side is not told by colour alone', () => {
    expect(markText(watched({ v: 61 }, { v: 62 }).mark!)).toBe('■ D 62%');
    expect(watched({ v: 61 }, { v: 62 }).mark!.owner).toBe('coalition');
    expect(markText(watched({ v: -61 }, { v: -62 }).mark!)).toBe('▲ D 62%');
    expect(watched({ v: -61 }, { v: -62 }).mark!.owner).toBe('veros');
    expect(markText(watched({ v: 1 }, { v: 0 }).mark!)).toBe('○ D 0%');
    expect(watched({ v: 1 }, { v: 0 }).mark!.owner).toBe('neutral');
  });

  it('never reads 100% before the point is captured', () => {
    expect(markText(watched({ v: 99 }, { v: 99.9 }).mark!)).toBe('■ D 99%');
    expect(markText(watched({ v: 21 }, { v: 23.999999999 }).mark!)).toBe('■ D 24%');
    expect(markText(watched({ v: 99 }, { v: 100 }).mark!)).toBe('■ D 100%');
  });

  it('shows a stopped mark while contested, for either sign, without v changing', () => {
    const marks = new CaptureMarks();
    const p = point({ v: 62, contested: true });
    marks.update([p], 0);
    const first = marks.of(p, 0)!;
    marks.update([p], 30);
    const later = marks.of(p, 30)!;
    expect(first.contested).toBe(true);
    expect(later.progress).toBe(first.progress);
    expect(markText(later)).toBe('× D 62%');
    const q = point({ v: -62, contested: true });
    marks.update([q], 31);
    expect(markText(marks.of(q, 31)!)).toBe('× D 62%');
    expect(marks.of(q, 31)!.owner).toBe('veros');
  });

  it('draws nothing while v holds and the point is not contested', () => {
    const marks = new CaptureMarks();
    const p = point({ v: 100 });
    marks.update([p], 0);
    expect(marks.of(p, 0)).toBeNull();
    marks.update([p], 5);
    expect(marks.of(p, 5)).toBeNull();
  });

  it('holds the mark between sim ticks and drops it once v has stayed still', () => {
    const { marks, p } = watched({ v: 61 }, { v: 62 }, 10);
    marks.update([p], 10 + CHANGE_HOLD - 0.01);
    expect(marks.of(p, 10 + CHANGE_HOLD - 0.01)).not.toBeNull();
    marks.update([p], 10 + CHANGE_HOLD + 0.01);
    expect(marks.of(p, 10 + CHANGE_HOLD + 0.01)).toBeNull();
  });

  it('stays up on every frame while the sim moves v once a second', () => {
    const marks = new CaptureMarks();
    const p = point({ v: 0 });
    marks.update([p], 0);
    const shown: boolean[] = [];
    for (let frame = 1; frame <= 60 * 5; frame++) {
      const now = frame / 60;
      if (frame % 60 === 0) p.v += 2.4;
      marks.update([p], now);
      if (frame > 60) shown.push(marks.of(p, now) !== null);
    }
    expect(shown).not.toContain(false);
  });

  it('finds the point the player stands in, on the same edge rule as the sim', () => {
    const { marks, p } = watched({ v: 61 }, { v: 62 }, 10);
    expect(marks.inside([p], 50, 0, 10)?.id).toBe('D');
    expect(marks.inside([p], 50.01, 0, 10)).toBeNull();
  });

  it('does not throw when point values are missing', () => {
    const marks = new CaptureMarks();
    const holes = [undefined, {}, { id: 'D' }, { id: 'D', v: NaN }, { id: 'D', v: undefined, contested: true }, { id: 'D', v: 1, x: 0, z: 0 }] as unknown as MarkPoint[];
    expect(() => {
      marks.update(undefined, 0);
      marks.update([], 0);
      marks.update(holes, 0);
      marks.update(holes, 1);
    }).not.toThrow();
    expect(marks.of(undefined, 1)).toBeNull();
    for (const h of holes.slice(0, 5)) expect(marks.of(h, 1)).toBeNull();
    expect(marks.inside(undefined, 0, 0, 1)).toBeNull();
    expect(marks.inside([], 0, 0, 1)).toBeNull();
    expect(marks.inside(holes, 0, 0, 1)).toBeNull();
  });
});

describe('capture ring drawing (#228)', () => {
  function recorder() {
    const calls: { strokeStyle: string; lineWidth: number; arc: number[] }[] = [];
    const g = { strokeStyle: '', lineWidth: 0, last: [] as number[], beginPath() {}, arc(x: number, y: number, r: number, from: number, to: number, ccw?: boolean) { this.last = [x, y, r, from, to, Number(!!ccw)]; }, stroke() { calls.push({ strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, arc: this.last }); } };
    return { g, calls };
  }

  it('lays a 5px black backing under a 3px arc going clockwise from the top', () => {
    const { g, calls } = recorder();
    drawRing(g, 100, 50, watched({ v: 61 }, { v: 62 }).mark!, '#4cc9f0');
    expect(RING_RADIUS).toBe(11);
    expect(RING_WIDTH).toBe(3);
    expect(RING_BACKING).toBe(5);
    expect(calls[0]).toMatchObject({ strokeStyle: '#000', lineWidth: 5 });
    expect(calls[0].arc.slice(0, 3)).toEqual([100, 50, 11]);
    expect(calls[1]).toMatchObject({ strokeStyle: '#4cc9f0', lineWidth: 3 });
    expect(calls[1].arc[3]).toBeCloseTo(-Math.PI / 2);
    expect(calls[1].arc[4]).toBeCloseTo(-Math.PI / 2 + Math.PI * 2 * 0.62);
    expect(calls[1].arc[5]).toBeFalsy();
  });

  it('draws only the backing at zero', () => {
    const { g, calls } = recorder();
    drawRing(g, 0, 0, watched({ v: 1 }, { v: 0 }).mark!, '#fff');
    expect(calls).toHaveLength(1);
  });

  it('places the in-circle text 18px above the hurt arc', () => {
    expect(markTextY(844, 390)).toBeCloseTo(390 / 2 - 390 * 0.22 - 18);
    expect(markTextY(390, 844)).toBeCloseTo(844 / 2 - 390 * 0.22 - 18);
  });

  it('keeps the touch coach below the in-circle text on short and tall screens', () => {
    const css = readFileSync(join(__dirname, '..', '..', '..', 'styles.css'), 'utf8');
    const m = css.match(/\.flight3d\.touch \.coach \{[^}]*top: calc\(max\((\d+)px, (\d+)vh - (\d+)px\)/);
    expect(m).not.toBeNull();
    const [floor, vh, less] = m!.slice(1).map(Number);
    const TEXT_HALF = 13 / 2 + 1.5;
    const HELI_TARGET_BUTTON_BOTTOM = 116;
    expect(floor).toBeGreaterThanOrEqual(HELI_TARGET_BUTTON_BOTTOM);
    for (const [w, h] of [[844, 390], [667, 375], [932, 430], [1024, 600], [1180, 820]]) {
      expect(Math.max(floor, (vh / 100) * h - less)).toBeGreaterThanOrEqual(markTextY(w, h) + TEXT_HALF);
    }
  });
});
