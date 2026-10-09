import { describe, expect, it } from 'vitest';
import { makeWorld, openPair, putPlayer, run } from '../testing';
import { STEP, type World } from '../world';
import { composeHooks } from './index';

function scenario(install?: (w: World) => void) {
  const { world } = makeWorld(31);
  world.clearCombat();
  install?.(world);
  const g = openPair(world, 1400, 60);
  world.spawnUnit('spaag', g.unit.x, g.unit.z);
  world.spawnUnit('inf', g.unit.x + 40, g.unit.z + 10);
  world.spawnUnit('c_tank', g.player.x + 30, g.player.z);
  putPlayer(world, g.player.x, g.player.z, 60);
  const h = world.player;
  h.landed = false; h.engineOn = true; h.rpm = 1;
  world.controls.collective = 0.55;
  run(world, 20, () => { world.commands.fire = world.time > 4 && world.time < 6; });
  return world;
}

function hash(w: World) {
  const vals: number[] = [w.time, w.rng()];
  const h = w.player;
  vals.push(h.pos.x, h.pos.y, h.pos.z, h.vel.x, h.vel.y, h.vel.z, h.yaw, h.fuel, w.arms.gunAmmo, ...Object.values(h.damage));
  for (const u of w.units) vals.push(u.id, u.pos.x, u.pos.y, u.pos.z, u.hp, u.alive ? 1 : 0, u.ai.awareness, ['idle', 'alert', 'engage', 'search', 'retreat'].indexOf(u.ai.state));
  vals.push(w.projectiles.length, w.enemyMissiles.length);
  let x = 0;
  for (const v of vals) x = (Math.imul(x, 31) + Math.round(v * 1000)) | 0;
  return x;
}

describe('battle hooks (B1-2)', () => {
  it('leaves a world without hooks stepping exactly as before', () => {
    const w = scenario();
    expect(hash(w)).toBe(228720398);
  }, 60000);

  it('steps the same with empty hooks installed', () => {
    const w = scenario(world => { world.battleHooks = composeHooks({ tick10Hz: [], tick1Hz: [] }); });
    expect(hash(w)).toBe(228720398);
  }, 60000);

  it('calls the hooks at 10 Hz and 1 Hz in order, even while the player is not flying', () => {
    const { world } = makeWorld(3);
    world.active = false;
    const calls: string[] = [];
    world.battleHooks = composeHooks({
      tick10Hz: [(_, dt) => calls.push(`a${dt}`), () => calls.push('b')],
      tick1Hz: [(_, dt) => calls.push(`s${dt}`)],
    });
    for (let i = 0; i < 120 * 3; i++) world.step(STEP);
    expect(calls.filter(c => c === 'a0.1').length).toBe(30);
    expect(calls.filter(c => c === 'b').length).toBe(30);
    expect(calls.filter(c => c === 's1').length).toBe(3);
    expect(calls.slice(0, 2)).toEqual(['a0.1', 'b']);
  });

  it('delivers events emitted by the hooks in the same step', () => {
    const { world, events } = makeWorld(3);
    world.battleHooks = composeHooks({ tick10Hz: [], tick1Hz: [w => w.emit({ t: 'radio', from: 'hq', text: 'x' })] });
    for (let i = 0; i < 120; i++) world.step(STEP);
    expect(events.filter(e => e.t === 'radio').length).toBe(1);
  });
});
