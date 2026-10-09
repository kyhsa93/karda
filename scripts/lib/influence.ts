export const P0 = { margin: 0.2, ceiling: 0.95, spread: 0.25, z: 1.96 } as const;

export interface Rate { wins: number; n: number }

export function wilson({ wins, n }: Rate, z: number = P0.z): [number, number] {
  if (n === 0) return [0, 1];
  const p = wins / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function diffInterval(a: Rate, b: Rate, z: number = P0.z): [number, number] {
  const pa = a.wins / a.n, pb = b.wins / b.n;
  const [la, ua] = wilson(a, z), [lb, ub] = wilson(b, z);
  const d = pa - pb;
  return [d - Math.sqrt((pa - la) ** 2 + (ub - pb) ** 2), d + Math.sqrt((ua - pa) ** 2 + (pb - lb) ** 2)];
}

export type Verdict = 'pass' | 'fail' | 'undecided';

export interface Pairs { n: number; onlyRole: number; onlyIdle: number }

export function pairs(role: Map<number, boolean>, idle: Map<number, boolean>): Pairs {
  let n = 0, onlyRole = 0, onlyIdle = 0;
  for (const [seed, won] of role) {
    const other = idle.get(seed);
    if (other === undefined) continue;
    n++;
    if (won && !other) onlyRole++;
    else if (!won && other) onlyIdle++;
  }
  return { n, onlyRole, onlyIdle };
}

export function pairedInterval({ n, onlyRole, onlyIdle }: Pairs, z: number = P0.z): [number, number] {
  if (n === 0) return [-1, 1];
  const m = n + 2, b = onlyRole + 0.5, c = onlyIdle + 0.5;
  const d = (b - c) / m, h = z * Math.sqrt(Math.max(0, b + c - (b - c) ** 2 / m)) / m;
  return [Math.max(-1, d - h), Math.min(1, d + h)];
}

export function roleVerdict(role: Rate, idle: Rate, diff?: [number, number]): { verdict: Verdict; reason: string } {
  const [lo, hi] = diff ?? diffInterval(role, idle);
  const [, roleHi] = wilson(role);
  const [roleLo] = wilson(role);
  if (roleLo >= P0.ceiling) return { verdict: 'fail', reason: `wins too surely (${(roleLo * 100).toFixed(0)}% at least)` };
  if (hi < P0.margin) return { verdict: 'fail', reason: `beats idle by at most ${(hi * 100).toFixed(0)}pp` };
  if (lo >= P0.margin && roleHi < P0.ceiling) return { verdict: 'pass', reason: `beats idle by ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}pp` };
  return { verdict: 'undecided', reason: `beats idle by ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}pp — more seeds` };
}

export function spreadVerdict(rates: Rate[]): { verdict: Verdict; reason: string } {
  if (rates.length < 2) return { verdict: 'undecided', reason: 'one judged role' };
  let worstLo = 0, worstHi = 0;
  for (const a of rates) for (const b of rates) {
    const [lo, hi] = diffInterval(a, b);
    worstLo = Math.max(worstLo, lo); worstHi = Math.max(worstHi, hi);
  }
  if (worstLo > P0.spread) return { verdict: 'fail', reason: `roles differ by at least ${(worstLo * 100).toFixed(0)}pp` };
  if (worstHi <= P0.spread) return { verdict: 'pass', reason: `roles differ by at most ${(worstHi * 100).toFixed(0)}pp` };
  return { verdict: 'undecided', reason: `roles differ by up to ${(worstHi * 100).toFixed(0)}pp — more seeds` };
}

export function monotoneVerdict(levels: Rate[]): { verdict: Verdict; reason: string } {
  if (levels.length < 2) return { verdict: 'undecided', reason: 'one level' };
  let drop = 0;
  for (let i = 0; i < levels.length; i++) for (let j = i + 1; j < levels.length; j++) {
    const [, hi] = diffInterval(levels[j], levels[i]);
    if (hi < 0) drop = Math.max(drop, -hi);
  }
  if (drop > 0) return { verdict: 'fail', reason: `a higher level wins at least ${(drop * 100).toFixed(0)}pp less than a lower one` };
  return { verdict: 'pass', reason: 'no higher level wins less outside the 95% intervals' };
}

export function seedsToVerdict(n: number, step: number, verdictAt: (k: number) => Verdict): number | null {
  const final = verdictAt(n);
  if (final === 'undecided') return null;
  for (let k = step; k < n; k += step) if (verdictAt(k) === final) return k;
  return n;
}
