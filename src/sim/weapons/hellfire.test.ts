import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../events';
import { updateQ } from '../heli/state';
import { lineOfSight, unitCenter } from '../sensors/laser';
import { lookAngles, tadsPosition } from '../sensors/tads';
import { airborneAt, makeWorld } from '../testing';
import { STEP, type World } from '../world';
import { hellfireSolution } from './hellfire';

function place(world: World, pos: Vector3, facing: Vector3) {
  airborneAt(world, pos.x, pos.z, pos.y);
  const h = world.player;
  h.yaw = Math.atan2(-(facing.x - pos.x), -(facing.z - pos.z));
  updateQ(h);
  world.clearCombat();
  world.selectWeapon(3);
}

function ground(world: World, x: number, z: number) {
  return new Vector3(x, world.terrain.surfaceAt(x, z), z);
}

function findOpen(world: World, dist: number) {
  const HALF = world.terrain.half;
  for (let i = 0; i < 400; i++) {
    const x = ((i * 7919) % 97) / 97 * HALF * 1.6 - HALF * 0.8, z = ((i * 104729) % 89) / 89 * HALF * 1.6 - HALF * 0.8;
    const from = ground(world, x, z).setY(world.terrain.surfaceAt(x, z) + 100);
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      const t = ground(world, x + Math.sin(a) * dist, z + Math.cos(a) * dist);
      if (world.terrain.heightAt(t.x, t.z) < 1 || Math.abs(t.x) > HALF - 200 || Math.abs(t.z) > HALF - 200) continue;
      if (lineOfSight(world.terrain, from, t.clone().setY(t.y + 1))) return { from, target: t };
    }
  }
  throw new Error('no open geometry');
}

function findHidden(world: World) {
  const HALF = world.terrain.half;
  for (let i = 0; i < 600; i++) {
    const x = ((i * 7919) % 101) / 101 * HALF * 1.6 - HALF * 0.8, z = ((i * 104729) % 103) / 103 * HALF * 1.6 - HALF * 0.8;
    const low = ground(world, x, z).setY(world.terrain.surfaceAt(x, z) + 30);
    if (world.terrain.heightAt(x, z) < 1) continue;
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, dist = 2500;
      const t = ground(world, x + Math.sin(a) * dist, z + Math.cos(a) * dist);
      if (world.terrain.heightAt(t.x, t.z) < 1 || Math.abs(t.x) > HALF - 200 || Math.abs(t.z) > HALF - 200) continue;
      const aim = t.clone().setY(t.y + 1.5);
      if (lineOfSight(world.terrain, low, aim)) continue;
      const high = low.clone().setY(low.y + 250);
      if (!lineOfSight(world.terrain, high, aim)) continue;
      return { low, high, target: t };
    }
  }
  throw new Error('no hidden geometry');
}

function lase(world: World, target: Vector3) {
  world.toggleTads();
  if (!world.tads.active) world.toggleTads();
  lookAngles(target.clone().sub(tadsPosition(world.player)).normalize(), world.tads);
  world.commands.laser = true;
}

function pull(world: World) {
  world.commands.fire = true; world.step(STEP);
  world.commands.fire = false; world.step(STEP);
}

function fly(world: World, seconds: number, each?: (t: number) => void) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    each?.(i * STEP);
    world.step(STEP);
  }
}

function track(world: World) {
  const events: SimEvent[] = [];
  world.events.onAny(e => events.push(e));
  return events;
}

describe('AGM-114K Hellfire (04-weapons-and-sensors.md 4.2, 4.3)', () => {
  it('LOBL: locks on the laser spot and kills the tank', () => {
    const { world } = makeWorld(7);
    const { from, target } = findOpen(world, 2500);
    place(world, from, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    expect(hellfireSolution(world).status).toBe('lobl');
    const events = track(world);
    pull(world);
    expect(world.missiles).toHaveLength(1);
    fly(world, 15, () => { lookAngles(unitCenter(tank).sub(tadsPosition(world.player)).normalize(), world.tads); });
    expect(world.missiles).toHaveLength(0);
    expect(tank.alive).toBe(false);
    expect(events.some(e => e.t === 'impact' && e.weapon === 'agm114k' && e.unit === tank.id)).toBe(true);
  });

  it('flies off to miss when the laser stops', () => {
    const { world } = makeWorld(7);
    const { from, target } = findOpen(world, 3000);
    place(world, from, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    const events = track(world);
    pull(world);
    fly(world, 1.5);
    world.commands.laser = false;
    fly(world, 20);
    expect(tank.alive).toBe(true);
    const hit = events.find(e => e.t === 'impact' && e.weapon === 'agm114k');
    expect(hit && hit.t === 'impact' && hit.pos.distanceTo(tank.pos)).toBeGreaterThan(30);
  });

  it('LOAL: fired from behind a ridge, locks when the laser comes on and hits', () => {
    const { world } = makeWorld(7);
    const { low, high, target } = findHidden(world);
    place(world, high, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    world.commands.laser = false;
    world.step(STEP);
    place(world, low, target);
    world.units.push(tank);
    world.toggleTads();
    if (!world.tads.active) world.toggleTads();
    const sol = hellfireSolution(world);
    expect(sol.status).toBe('loal');
    pull(world);
    expect(world.missiles[0].mode).toBe('loal');
    fly(world, 3);
    world.player.pos.copy(high);
    lase(world, unitCenter(tank));
    fly(world, 15, () => { world.player.pos.copy(high); world.player.vel.set(0, 0, 0); lookAngles(unitCenter(tank).sub(tadsPosition(world.player)).normalize(), world.tads); });
    expect(tank.alive).toBe(false);
  });

  it('LOAL without a laser inside 10 s goes stupid and misses', () => {
    const { world } = makeWorld(7);
    const { low, high, target } = findHidden(world);
    place(world, high, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    world.commands.laser = false;
    place(world, low, target);
    world.units.push(tank);
    pull(world);
    fly(world, 25);
    expect(tank.alive).toBe(true);
  });

  it('a remote laser guides the missile without the player seeing the target', () => {
    const { world } = makeWorld(8);
    const { low, high, target } = findHidden(world);
    place(world, high, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    world.commands.laser = false;
    place(world, low, target);
    world.units.push(tank);
    world.remoteLaser(tank.id, 30);
    expect(hellfireSolution(world).status).toBe('loal');
    pull(world);
    fly(world, 25);
    expect(tank.alive).toBe(false);
  });

  it('will not fire inside 500 m or beyond 8000 m', () => {
    const { world } = makeWorld(7);
    const { from, target } = findOpen(world, 300);
    place(world, from, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    expect(hellfireSolution(world).status).toBe('range');
    pull(world);
    expect(world.missiles).toHaveLength(0);
    world.commands.laser = false;
    const h = world.player;
    world.laser.designation = new Vector3(h.pos.x - Math.sin(h.yaw) * 9000, 0, h.pos.z - Math.cos(h.yaw) * 9000);
    world.laser.designatedAt = world.time;
    world.step(STEP);
    expect(hellfireSolution(world).status).toBe('range');
    pull(world);
    expect(world.missiles).toHaveLength(0);
  });

  it('keeps 0.8 s between launches and alternates launchers', () => {
    const { world } = makeWorld(7);
    const { from, target } = findOpen(world, 3000);
    place(world, from, target);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    pull(world);
    fly(world, 0.3);
    pull(world);
    expect(world.missiles).toHaveLength(1);
    fly(world, 0.6);
    pull(world);
    expect(world.missiles).toHaveLength(2);
    expect(world.loadout.rounds.L1).toBe(3);
    expect(world.loadout.rounds.R1).toBe(3);
  });

  it('refuses a target far off the nose', () => {
    const { world } = makeWorld(7);
    const { from, target } = findOpen(world, 3000);
    place(world, from, target);
    world.player.yaw += 1.2;
    updateQ(world.player);
    const tank = world.spawnUnit('tank', target.x, target.z);
    lase(world, unitCenter(tank));
    world.step(STEP);
    expect(hellfireSolution(world).status).toBe('align');
  });
});
