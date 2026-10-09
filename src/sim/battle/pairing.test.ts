import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { STEP } from '../world';
import { createBattleSession } from './runtime';
import type { BattleMapDef } from './schema';
import { SKILL_LEVELS, skillLevel, SoldierProxy } from './soldierProxy';

const harek = JSON.parse(harekRaw) as BattleMapDef;

interface Opts { level?: number | null; proxy?: boolean; away?: number; fire?: boolean }

function play(seed: number, seconds: number, { level = null, proxy = false, away = 0, fire = false }: Opts = {}) {
  const { session, runtime } = createBattleSession(harek, 'quick', { side: 'coalition', seed });
  const world = session.world;
  const log: string[] = [];
  const damage = world.damageUnit.bind(world);
  world.damageUnit = (u, amount, byPlayer, by) => {
    if (by !== undefined) log.push(`${world.time.toFixed(3)} ${by}>${u.id} ${amount.toFixed(3)} ${u.alive}`);
    damage(u, amount, byPlayer, by);
  };
  session.start();
  session.frozen = false;
  const points = runtime.conquest.points, mid = points[Math.floor(points.length / 2)];
  world.player.pos.x = mid.x + away;
  world.player.pos.z = mid.z;
  const pilot = proxy ? new SoldierProxy(runtime, 'coalition', 'cover', level) : null;
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    pilot?.step(session, STEP);
    if (fire && world.avatar.kind === 'soldier') world.soldierCommands.fire = true;
    session.step(STEP);
  }
  return { log, world, pilot, next: world.rng() };
}

describe('paired matches (#199)', () => {
  it('keeps bot-vs-bot fights identical for the first 60 s whatever the player proxy does', () => {
    for (const seed of [1, 2]) {
      const idle = play(seed, 60);
      for (const level of [null, 2]) {
        const soldier = play(seed, 60, { proxy: true, level });
        expect(soldier.world.avatar.kind).toBe('soldier');
        expect(soldier.log).toEqual(idle.log);
        expect(soldier.next).toBe(idle.next);
      }
    }
  }, 120000);

  it('does not let a firing player move the world RNG', () => {
    const idle = play(3, 30);
    const shooting = play(3, 30, { proxy: true, fire: true });
    expect(shooting.world.soldierArms.ammo.rifle?.mag ?? 0).toBeLessThan(idle.world.soldierArms.ammo.rifle?.mag ?? 99);
    expect(shooting.next).toBe(idle.next);
  }, 60000);

  it('draws miss scatter for display from its own stream, so watching a fight does not change it', () => {
    const near = play(1, 360), far = play(1, 360, { away: 6000 });
    expect(near.log.length).toBeGreaterThan(0);
    expect(far.log).toEqual(near.log);
    expect(far.next).toBe(near.next);
  }, 120000);

  it('plays the same match twice for the same seed and level', () => {
    const a = play(4, 90, { proxy: true, level: 1 }), b = play(4, 90, { proxy: true, level: 1 });
    expect(b.world.soldier?.pos.toArray()).toEqual(a.world.soldier?.pos.toArray());
    expect(b.log).toEqual(a.log);
  }, 60000);
});

describe('infantry proxy skill levels (#199)', () => {
  it('starts from the director table L0..L3', () => {
    expect(SKILL_LEVELS).toEqual([
      { aimMrad: 100, reactSec: 0.8, scanSec: 1.0 },
      { aimMrad: 30, reactSec: 0.5, scanSec: 0.5 },
      { aimMrad: 10, reactSec: 0.3, scanSec: 0.25 },
      { aimMrad: 3, reactSec: 0.15, scanSec: 0.1 },
    ]);
  });

  it('gets sharper with every step', () => {
    for (let i = 1; i < SKILL_LEVELS.length; i++) {
      expect(SKILL_LEVELS[i].aimMrad).toBeLessThan(SKILL_LEVELS[i - 1].aimMrad);
      expect(SKILL_LEVELS[i].reactSec).toBeLessThan(SKILL_LEVELS[i - 1].reactSec);
      expect(SKILL_LEVELS[i].scanSec).toBeLessThan(SKILL_LEVELS[i - 1].scanSec);
    }
  });

  it('rejects a level outside L0..L3', () => {
    expect(() => skillLevel(4)).toThrow();
    expect(() => skillLevel(-1)).toThrow();
  });
});
