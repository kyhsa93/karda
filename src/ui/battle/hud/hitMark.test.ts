import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../sim/events';
import { STEP, World } from '../../../sim/world';
import { explodeWeapon, WEAPONS } from '../../../sim/weapons/damage';
import { HIT_MARK, hitMarkColor, nextHitMark, NO_HIT_MARK, type HitMark } from './hitMark';

const fold = (events: SimEvent[], now: number, start = NO_HIT_MARK) => events.reduce((m, e) => nextHitMark(m, e, now), start);
const destroyed = (byPlayer: boolean): SimEvent => ({ t: 'unitDestroyed', id: 1, defId: 'truck', side: 'veros', byPlayer });
const memberKilled: SimEvent = { t: 'memberHit', unit: 2, killed: true, byPlayer: true };
const vehicleHit: SimEvent = { t: 'unitHit', unit: 2 };
const memberHit: SimEvent = { t: 'memberHit', unit: 2, killed: false, byPlayer: true };

function streak(kill: SimEvent, hit: SimEvent) {
  let mark: HitMark = nextHitMark(NO_HIT_MARK, kill, 0);
  const seen: { at: number; color: ReturnType<typeof hitMarkColor> }[] = [];
  for (let k = 1; k <= 20; k++) {
    const at = k / 10;
    seen.push({ at, color: hitMarkColor(mark, at - 1e-6) });
    mark = nextHitMark(mark, hit, at);
    seen.push({ at, color: hitMarkColor(mark, at) });
  }
  return seen;
}

describe('hit mark (#273)', () => {
  it('turns white on a vehicle or blast hit that does not kill', () => {
    const mark = fold([vehicleHit], 10);
    expect(mark.until).toBe(10 + HIT_MARK);
    expect(hitMarkColor(mark, 10)).toBe('hit');
    expect(hitMarkColor(mark, 10 + HIT_MARK)).toBeNull();
  });

  it('shows one mark for many units hit in the same frame', () => {
    const many: SimEvent[] = [2, 3, 4, 5].map(unit => ({ t: 'unitHit', unit }));
    expect(fold(many, 10)).toEqual(fold(many.slice(0, 1), 10));
  });

  it('keeps a kill red when hits land in the same frame', () => {
    expect(hitMarkColor(fold([destroyed(true), vehicleHit], 10), 10)).toBe('kill');
    expect(hitMarkColor(fold([memberKilled, vehicleHit], 10), 10)).toBe('kill');
    expect(hitMarkColor(fold([memberKilled, memberHit], 10), 10)).toBe('kill');
  });

  it.each([
    ['vehicle kill, then vehicle hits', destroyed(true), vehicleHit],
    ['vehicle kill, then member hits', destroyed(true), memberHit],
    ['member kill, then member hits', memberKilled, memberHit],
    ['member kill, then vehicle hits', memberKilled, vehicleHit],
  ] as const)('holds red only 0.3 s from the kill: %s every 0.1 s for 2 s', (_, kill, hit) => {
    const seen = streak(kill, hit);
    expect(seen.filter(s => s.at < HIT_MARK - 1e-9).every(s => s.color === 'kill')).toBe(true);
    expect(seen.filter(s => s.at > HIT_MARK + 1e-9).map(s => s.color)).toEqual(seen.filter(s => s.at > HIT_MARK + 1e-9).map(() => 'hit'));
  });

  it('turns red again on a later kill', () => {
    const mark = fold([destroyed(true)], 1, fold([vehicleHit], 0.9, fold([destroyed(true)], 0)));
    expect(hitMarkColor(mark, 1.2)).toBe('kill');
    expect(hitMarkColor(mark, 1 + HIT_MARK)).toBeNull();
  });

  it('keeps the infantry marks as before and ignores bot hits', () => {
    expect(hitMarkColor(fold([memberHit], 5), 5)).toBe('hit');
    expect(hitMarkColor(fold([destroyed(true)], 5), 5)).toBe('kill');
    expect(fold([{ t: 'memberHit', unit: 2, killed: true, byPlayer: false }, destroyed(false)], 5)).toBe(NO_HIT_MARK);
  });

  it('lights up from the events a real grenade blast emits', () => {
    const world = new World({ seed: 3 });
    world.active = true;
    let mark = NO_HIT_MARK;
    world.events.onAny(e => { mark = nextHitMark(mark, e, world.time); });
    const a = world.spawnUnit('inf', 0, 0), b = world.spawnUnit('apc', 3, 0);
    explodeWeapon(world, new Vector3(1.5, world.terrain.surfaceAt(1.5, 0), 0), WEAPONS.grenade, true);
    world.step(STEP);
    expect(a.alive && b.alive).toBe(true);
    expect(mark.until).toBe(world.time + HIT_MARK);
    expect(hitMarkColor(mark, world.time)).toBe('hit');
  });
});
