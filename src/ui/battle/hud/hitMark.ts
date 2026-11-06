import type { SimEvent } from '../../../sim/events';

export const HIT_MARK = 0.3;

export interface HitMark { until: number; killUntil: number }

export const NO_HIT_MARK: HitMark = { until: -1, killUntil: -1 };

export function nextHitMark(mark: HitMark, e: SimEvent, now: number): HitMark {
  const killed = (e.t === 'unitDestroyed' && e.byPlayer) || (e.t === 'memberHit' && e.byPlayer && e.killed);
  if (killed) return { until: now + HIT_MARK, killUntil: now + HIT_MARK };
  if ((e.t === 'memberHit' && e.byPlayer) || e.t === 'unitHit') return { until: now + HIT_MARK, killUntil: mark.killUntil };
  return mark;
}

export function hitMarkColor(mark: HitMark, now: number): 'kill' | 'hit' | null {
  if (mark.until <= now) return null;
  return mark.killUntil > now ? 'kill' : 'hit';
}
