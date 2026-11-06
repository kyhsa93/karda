import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../sim/events';
import { STEP, World } from '../../../sim/world';
import { explodeWeapon, WEAPONS } from '../../../sim/weapons/damage';
import { HIT_MARK, nextHitMark, type HitMark } from './hitMark';

const OFF: HitMark = { until: -1, kill: false };
const fold = (events: SimEvent[], now: number, start = OFF) => events.reduce((m, e) => nextHitMark(m, e, now), start);
const destroyed = (byPlayer: boolean): SimEvent => ({ t: 'unitDestroyed', id: 1, defId: 'truck', side: 'veros', byPlayer });

describe('hit mark (#273)', () => {
  it('turns white on a vehicle or blast hit that does not kill', () => {
    expect(fold([{ t: 'unitHit', unit: 4 }], 10)).toEqual({ until: 10 + HIT_MARK, kill: false });
  });

  it('shows one mark for many units hit in the same frame', () => {
    const many: SimEvent[] = [2, 3, 4, 5].map(unit => ({ t: 'unitHit', unit }));
    expect(fold(many, 10)).toEqual(fold(many.slice(0, 1), 10));
  });

  it('keeps a kill red when hits land in the same window', () => {
    expect(fold([destroyed(true), { t: 'unitHit', unit: 2 }], 10)).toEqual({ until: 10 + HIT_MARK, kill: true });
    expect(fold([{ t: 'memberHit', unit: 2, killed: true, byPlayer: true }, { t: 'unitHit', unit: 2 }], 10).kill).toBe(true);
    expect(fold([{ t: 'unitHit', unit: 2 }], 10 + HIT_MARK, { until: 10 + HIT_MARK, kill: true }).kill).toBe(false);
  });

  it('keeps the infantry marks as before and ignores bot hits', () => {
    expect(fold([{ t: 'memberHit', unit: 2, killed: false, byPlayer: true }], 5)).toEqual({ until: 5 + HIT_MARK, kill: false });
    expect(fold([destroyed(true)], 5)).toEqual({ until: 5 + HIT_MARK, kill: true });
    expect(fold([{ t: 'memberHit', unit: 2, killed: true, byPlayer: false }, destroyed(false)], 5)).toBe(OFF);
  });

  it('lights up from the events a real grenade blast emits', () => {
    const world = new World({ seed: 3 });
    world.active = true;
    let mark = OFF;
    world.events.onAny(e => { mark = nextHitMark(mark, e, world.time); });
    const a = world.spawnUnit('inf', 0, 0), b = world.spawnUnit('apc', 3, 0);
    explodeWeapon(world, new Vector3(1.5, world.terrain.surfaceAt(1.5, 0), 0), WEAPONS.grenade, true);
    world.step(STEP);
    expect(a.alive && b.alive).toBe(true);
    expect(mark).toEqual({ until: world.time + HIT_MARK, kill: false });
  });
});
