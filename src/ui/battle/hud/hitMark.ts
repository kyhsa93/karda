import type { SimEvent } from '../../../sim/events';

export const HIT_MARK = 0.3;

export interface HitMark { until: number; kill: boolean }

export function nextHitMark(mark: HitMark, e: SimEvent, now: number): HitMark {
  const killing = mark.kill && mark.until > now;
  if (e.t === 'unitDestroyed' && e.byPlayer) return { until: now + HIT_MARK, kill: true };
  if (e.t === 'memberHit' && e.byPlayer) return { until: now + HIT_MARK, kill: e.killed || killing };
  if (e.t === 'unitHit') return { until: now + HIT_MARK, kill: killing };
  return mark;
}
