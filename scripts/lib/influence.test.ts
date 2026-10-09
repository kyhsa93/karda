import { describe, expect, it } from 'vitest';
import { diffInterval, monotoneVerdict, pairedInterval, pairs, roleVerdict, seedsToVerdict, spreadVerdict, wilson } from './influence';

describe('P0 influence verdicts (#193)', () => {
  it('gives the Wilson interval for a win rate', () => {
    const [lo, hi] = wilson({ wins: 30, n: 100 });
    expect(lo).toBeCloseTo(0.219, 2);
    expect(hi).toBeCloseTo(0.396, 2);
  });

  it('cannot judge a 20pp gap from twenty seeds a side, and can from a hundred', () => {
    expect(roleVerdict({ wins: 10, n: 20 }, { wins: 6, n: 20 }).verdict).toBe('undecided');
    expect(roleVerdict({ wins: 65, n: 100 }, { wins: 30, n: 100 }).verdict).toBe('pass');
  });

  it('fails a role that plainly does not beat idle, and one that wins every time', () => {
    expect(roleVerdict({ wins: 30, n: 100 }, { wins: 30, n: 100 }).verdict).toBe('fail');
    expect(roleVerdict({ wins: 100, n: 100 }, { wins: 30, n: 100 }).verdict).toBe('fail');
  });

  it('fails roles that are far apart and passes roles that are close', () => {
    expect(spreadVerdict([{ wins: 90, n: 100 }, { wins: 50, n: 100 }]).verdict).toBe('fail');
    expect(spreadVerdict([{ wins: 60, n: 200 }, { wins: 62, n: 200 }]).verdict).toBe('pass');
  });

  it('gives a difference interval that contains the observed difference', () => {
    const [lo, hi] = diffInterval({ wins: 60, n: 100 }, { wins: 30, n: 100 });
    expect(lo).toBeLessThan(0.3);
    expect(hi).toBeGreaterThan(0.3);
  });
});

describe('paired comparison and level monotonicity (#199)', () => {
  const outcomes = (wins: number[], n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, wins.includes(i + 1)] as [number, boolean]));

  it('counts only the seeds where the two outcomes differ', () => {
    const p = pairs(outcomes([1, 2, 3, 4], 6), outcomes([3, 4, 5], 6));
    expect(p).toEqual({ n: 6, onlyRole: 2, onlyIdle: 1 });
  });

  it('narrows the interval when the matches line up and not when they do not', () => {
    const tight = pairedInterval({ n: 100, onlyRole: 25, onlyIdle: 2 });
    const loose = pairedInterval({ n: 100, onlyRole: 45, onlyIdle: 22 });
    expect(tight[1] - tight[0]).toBeLessThan(loose[1] - loose[0]);
    expect(tight[0]).toBeGreaterThan(0.1);
  });

  it('judges a role with the paired interval when it is given', () => {
    const role = { wins: 65, n: 100 }, idle = { wins: 35, n: 100 };
    expect(roleVerdict(role, idle).verdict).toBe('undecided');
    expect(roleVerdict(role, idle, pairedInterval({ n: 100, onlyRole: 30, onlyIdle: 0 })).verdict).toBe('pass');
  });

  it('flags a higher level that wins clearly less', () => {
    expect(monotoneVerdict([{ wins: 30, n: 100 }, { wins: 50, n: 100 }, { wins: 70, n: 100 }]).verdict).toBe('pass');
    expect(monotoneVerdict([{ wins: 70, n: 100 }, { wins: 30, n: 100 }]).verdict).toBe('fail');
    expect(monotoneVerdict([{ wins: 54, n: 100 }, { wins: 52, n: 100 }]).verdict).toBe('pass');
  });

  it('reports the first seed count that reaches the final verdict', () => {
    expect(seedsToVerdict(100, 10, k => (k >= 40 ? 'pass' : 'undecided'))).toBe(40);
    expect(seedsToVerdict(100, 10, () => 'undecided')).toBeNull();
  });
});
