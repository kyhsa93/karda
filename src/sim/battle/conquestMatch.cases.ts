import { expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { SIDES } from '../testing';
import { STEP } from '../world';
import type { Conquest } from './conquest';
import { createBattleSession } from './runtime';
import type { BattleMapDef, BattleSide } from './schema';

const harek = JSON.parse(harekRaw) as BattleMapDef;

export const spent = (c: Conquest, side: BattleSide) => {
  const k = c.causes[side];
  return k.bleed + k.person + k.vehicle + k.player;
};

export function fullMatchCases(seeds: readonly number[]) {
  it.each(seeds)('accounts for every ticket a full match spends, seed %i, the rest being the end clamp', seed => {
    const { session, runtime } = createBattleSession(harek, 'quick', { side: 'coalition', seed });
    session.start();
    session.frozen = false;
    const c = runtime.conquest, start = runtime.rules.tickets;
    const limit = (runtime.rules.timeLimitSec + 30) * 120;
    let drift = 0;
    for (let i = 0; session.mode !== 'done' && i < limit; i++) {
      session.step(STEP);
      if (!c.winner) for (const s of SIDES) drift = Math.max(drift, Math.abs(start - c.tickets[s] - spent(c, s)));
    }
    expect(c.winner).not.toBeNull();
    expect(drift).toBeLessThan(1e-6);
    for (const s of SIDES) {
      const sum = spent(c, s), clamped = sum - (start - c.tickets[s]);
      expect(clamped, s).toBeCloseTo(Math.max(0, sum - start), 6);
      if (c.tickets[s] > 0) expect(clamped, s).toBeCloseTo(0, 6);
    }
    const loser = c.loser(c.winner!);
    if (loser) {
      expect(c.causes[loser].bleed).toBeGreaterThan(0);
      expect(c.causes[loser].person).toBeGreaterThan(0);
    }
  }, 60000);
}
