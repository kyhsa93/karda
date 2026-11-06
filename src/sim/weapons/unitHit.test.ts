import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../events';
import { STEP, World } from '../world';
import { explodeWeapon, WEAPONS } from './damage';
import { PLAYER_OWNER } from './projectile';

function scene() {
  const world = new World({ seed: 3, terrain: { features: [{ kind: 'flatten', center: [0, 0], radius: 500 }] } });
  world.active = true;
  world.playerSide = 'coalition';
  const events: SimEvent[] = [];
  world.events.onAny(e => events.push(e));
  world.spawnAvatar({ kind: 'soldier', x: 0, z: 30, headingDeg: 0, cls: 'assault' });
  return { world, events };
}

function shoot(world: World, weapon: string, to: Vector3) {
  const from = world.soldier!.pos.clone().setY(world.soldier!.pos.y + 1.6);
  const dir = to.clone().sub(from).normalize();
  world.projectiles.push({ id: 9000 + world.projectiles.length, weapon, pos: from.clone(), origin: from.clone(), vel: dir.multiplyScalar(WEAPONS[weapon].speed), owner: PLAYER_OWNER, life: 3, drag: 0, tracer: false });
  for (let i = 0; i < 60; i++) world.step(STEP);
}

const center = (u: { pos: Vector3; def: { size: number[] } }) => u.pos.clone().setY(u.pos.y + u.def.size[1] / 2);
const of = (events: SimEvent[], t: SimEvent['t']) => events.filter(e => e.t === t);

describe('unitHit: the player damaged a unit that survived (#273)', () => {
  it('fires once when a rifle round takes 2.5 HP off a technical', () => {
    const { world, events } = scene();
    const car = world.spawnUnit('technical', 0, 0, Math.PI);
    shoot(world, 'rifle', center(car));
    expect(car.hp).toBeCloseTo(57.5, 5);
    expect(of(events, 'unitHit')).toEqual([{ t: 'unitHit', unit: car.id }]);
    expect(of(events, 'memberHit')).toEqual([]);
    expect(of(events, 'unitDestroyed')).toEqual([]);
  });

  it('fires when an anti-tank rocket leaves an APC standing', () => {
    const { world, events } = scene();
    const apc = world.spawnUnit('apc', 0, 0, Math.PI);
    shoot(world, 'at_rocket', center(apc));
    expect(apc.alive).toBe(true);
    expect(apc.hp).toBeLessThan(150);
    expect(of(events, 'unitHit')).toEqual([{ t: 'unitHit', unit: apc.id }]);
  });

  it('fires for every unit a grenade blast hurts, with no member hit', () => {
    const { world, events } = scene();
    const a = world.spawnUnit('inf', 0, 0), b = world.spawnUnit('apc', 4, -2);
    explodeWeapon(world, new Vector3(2, world.terrain.surfaceAt(2, 3), 3), WEAPONS.grenade, true);
    world.step(STEP);
    expect(a.hp).toBeLessThan(40);
    expect(b.alive).toBe(true);
    expect(b.hp).toBeLessThan(150);
    expect(of(events, 'unitHit').map(e => e.t === 'unitHit' && e.unit).sort()).toEqual([a.id, b.id].sort());
    expect(of(events, 'memberHit')).toEqual([]);
  });

  it('leaves a kill to unitDestroyed alone', () => {
    const { world, events } = scene();
    const car = world.spawnUnit('technical', 0, 0);
    world.damageUnit(car, 1000, true);
    world.step(STEP);
    expect(of(events, 'unitDestroyed')).toHaveLength(1);
    expect(of(events, 'unitHit')).toEqual([]);
  });

  it('stays silent for bot damage', () => {
    const { world, events } = scene();
    const car = world.spawnUnit('technical', 0, 0), bot = world.spawnUnit('c_inf', 0, 50);
    world.damageUnit(car, 5, false, bot.id);
    explodeWeapon(world, car.pos.clone(), WEAPONS.grenade, false);
    world.step(STEP);
    expect(car.hp).toBeLessThan(55);
    expect(of(events, 'unitHit')).toEqual([]);
  });

  it('adds nothing a kill tally reads and draws no random numbers', () => {
    const run = (byPlayer: boolean) => {
      const { world, events } = scene();
      const car = world.spawnUnit('technical', 0, 0), squad = world.spawnUnit('inf', 20, 0);
      world.damageUnit(car, 10, byPlayer);
      world.damageMember(squad, squad.members![0], 3, byPlayer);
      world.step(STEP);
      return { events, rng: [world.rng(), world.fxRng(), world.playerRng()] };
    };
    const player = run(true), bot = run(false);
    expect(player.rng).toEqual(bot.rng);
    expect(of(player.events, 'unitHit')).toHaveLength(2);
    expect(player.events.filter(e => e.t === 'unitDestroyed' || (e.t === 'memberHit' && e.killed))).toEqual([]);
  });
});
