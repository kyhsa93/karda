import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import harekRaw from '../content/battle/maps/harek.json?raw';
import { FlightInput } from '../input/input';
import { STANDARD_LOADOUT } from '../sim/heli/loadout';
import { ProxyPilot } from '../sim/battle/proxy';
import { createBattleSession } from '../sim/battle/runtime';
import type { BattleMapDef } from '../sim/battle/schema';
import { SoldierProxy } from '../sim/battle/soldierProxy';
import { farpUnder } from '../sim/farp';
import { damageWarnings } from '../sim/heli/damage';
import { aseThreats, missileInbound } from '../sim/sensors/ase';
import { gunAim, predictGunImpact } from '../sim/weapons/ballistics';
import { hellfireSolution, longbowSolution } from '../sim/weapons/hellfire';
import { rocketSolution, rocketTarget } from '../sim/weapons/rockets';
import { STEP } from '../sim/world';
import { Effects } from './effects';
import { SearchlightBeams } from './searchlights';
import { UnitRenderer } from './unitRenderer';

const harek = JSON.parse(harekRaw) as BattleMapDef;
const SEED = 1;
const SECONDS = 260;
const SOLVER_EVERY = 16;

const IDLE_HASH = -1611976901;
const SOLDIER_HASH = -1449285965;
const HELI_HASH = -1436715582;

const IRREGULAR = [2, 2, 3, 0, 6, 1, 2, 7];
const GROUPINGS: Record<string, (frame: number) => number> = {
  '1': () => 1,
  '2': () => 2,
  '3': () => 3,
  '6': () => 6,
  irregular: frame => IRREGULAR[frame % IRREGULAR.length],
};

type Scenario = 'idle' | 'soldier' | 'heli';
type Battle = ReturnType<typeof createBattleSession>;
type Field = number | string | boolean | null | undefined;

const NOTHING = -1e300, NOT_A_NUMBER = -2e300, TEXT_END = -3e300;
const slot = new Float64Array(1), words = new Uint32Array(slot.buffer);

function digest(fields: readonly Field[]) {
  let x = 0x811c9dc5;
  const eat = (n: number) => {
    slot[0] = Number.isNaN(n) ? NOT_A_NUMBER : n;
    x = Math.imul(x ^ words[0], 0x01000193);
    x = Math.imul(x ^ words[1], 0x01000193);
    x ^= x >>> 13;
  };
  for (const f of fields) {
    if (typeof f === 'string') {
      for (let i = 0; i < f.length; i++) eat(f.charCodeAt(i));
      eat(TEXT_END);
    } else if (typeof f === 'number') eat(f);
    else if (typeof f === 'boolean') eat(f ? 1 : 0);
    else eat(NOTHING);
  }
  return x | 0;
}

function battleState({ session, runtime }: Battle): Field[] {
  const w = session.world, c = runtime.conquest, h = w.player, s = w.soldier, o: Field[] = [];
  o.push(w.time, session.mode, w.avatar.kind, session.deployReadyAt);
  o.push(c.tickets.coalition, c.tickets.veros, c.elapsed, c.winner);
  for (const p of c.points) o.push(p.id, p.owner, p.v, p.contested, p.strength.coalition, p.strength.veros);
  for (const cmd of runtime.commanders) for (const pl of cmd.platoons) o.push(pl.state, pl.order?.kind, pl.order?.point);
  o.push(w.units.length, w.groups.size, w.retired.length);
  for (const u of w.units) {
    o.push(u.id, u.defId, u.side, u.pos.x, u.pos.y, u.pos.z, u.vel.x, u.vel.y, u.vel.z, u.yaw, u.hp, u.alive, u.weaponCooldown, u.identified, u.diedAt);
    o.push(u.ai.state, u.ai.awareness, u.ai.detected, u.ai.fireAcc);
    o.push(u.battle?.target?.kind, u.battle?.target?.kind === 'unit' ? u.battle.target.id : null, u.battle?.aim, u.battle?.firedAt);
    for (const m of u.members ?? []) o.push(m.hp, m.alive);
  }
  o.push(w.projectiles.length, w.missiles.length, w.enemyMissiles.length, w.aams.length, w.flares.length);
  for (const p of w.projectiles) o.push(p.id, p.owner, p.pos.x, p.pos.y, p.pos.z);
  o.push(h.pos.x, h.pos.y, h.pos.z, h.vel.x, h.vel.y, h.vel.z, h.yaw, h.pitch, h.roll, h.rpm, h.fuel, h.alive, h.landed, ...Object.values(h.damage));
  o.push(w.arms.gunAmmo, w.controls.cyclicX, w.controls.cyclicY, w.controls.pedal, w.controls.collective);
  if (s) o.push(s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.yaw, s.pitch, s.stance, s.hp, s.alive, w.soldierArms.selected, w.soldierArms.shots);
  return o;
}

function fingerprint(battle: Battle) {
  const w = battle.session.world;
  return digest([w.rng(), w.fxRng(), w.playerRng(), ...battleState(battle)]);
}

function openBattle(): Battle {
  const battle = createBattleSession(harek, 'quick', { side: 'coalition', seed: SEED });
  battle.session.start();
  battle.session.frozen = false;
  return battle;
}

function renderReads({ session, runtime }: Battle) {
  const world = session.world, units = new UnitRenderer(), beams = new SearchlightBeams(), fx = new Effects(new THREE.Texture());
  const view = { pos: new THREE.Vector3(), fovDeg: 72 };
  world.events.onAny(e => fx.onEvent(e, world));
  return {
    units,
    read(dt: number, frame: number) {
      view.pos.copy(world.playerBody().pos);
      units.update(world, false, view, dt);
      beams.update(world);
      fx.update(dt, world);
      hellfireSolution(world);
      longbowSolution(world);
      gunAim(world);
      if (frame % SOLVER_EVERY === 0) {
        const rocket = rocketTarget(world);
        if (rocket) rocketSolution(world, rocket.point);
        predictGunImpact(world);
      }
      aseThreats(world);
      missileInbound(world);
      farpUnder(world);
      damageWarnings(world.player.damage);
      world.laserSpots();
      runtime.spotting.markers(world);
      runtime.spawnPoints(world);
    },
  };
}

function play(scenario: Scenario, stepsInFrame: (frame: number) => number, withReads: boolean) {
  const battle = openBattle(), { session, runtime } = battle, world = session.world;
  const input = new FlightInput();
  const pilot = scenario === 'heli' ? new ProxyPilot(runtime, 'coalition') : scenario === 'soldier' ? new SoldierProxy(runtime, 'coalition') : null;
  const reads = withReads ? renderReads(battle) : null;
  const total = SECONDS * 120;
  for (let frame = 0, done = 0; done < total; frame++) {
    const steps = Math.min(stepsInFrame(frame), total - done);
    if (!pilot) input.update(world, steps * STEP);
    for (let i = 0; i < steps; i++) { pilot?.step(session, STEP); session.step(STEP); }
    done += steps;
    reads?.read(steps * STEP, frame);
  }
  const { tickets } = runtime.conquest;
  return {
    hash: fingerprint(battle),
    time: world.time,
    botsFired: world.units.filter(u => u.battle?.firedAt !== undefined).length,
    ticketsLost: runtime.rules.tickets * 2 - tickets.coalition - tickets.veros,
    drawCalls: reads?.units.drawCalls ?? 0,
  };
}

let matrix: Record<string, ReturnType<typeof play>> | null = null;
function idleMatrix() {
  if (matrix) return matrix;
  matrix = {};
  for (const [name, grouping] of Object.entries(GROUPINGS)) {
    for (const withReads of [false, true]) matrix[`${name} steps, reads ${withReads ? 'on' : 'off'}`] = play('idle', grouping, withReads);
  }
  return matrix;
}

function expectCombat(run: ReturnType<typeof play>, name: string) {
  expect(run.time, name).toBeGreaterThanOrEqual(200);
  expect(run.botsFired, name).toBeGreaterThan(0);
  expect(run.ticketsLost, name).toBeGreaterThan(0);
}

describe('battle frame invariance (#220)', () => {
  it('ends in the same state for every frame grouping with render reads on or off', () => {
    const runs = idleMatrix(), names = Object.keys(runs);
    expect(names.length).toBe(10);
    const hashes = Object.fromEntries(names.map(n => [n, runs[n].hash]));
    expect(hashes).toEqual(Object.fromEntries(names.map(n => [n, hashes[names[0]]])));
    for (const n of names) {
      expectCombat(runs[n], n);
      if (n.endsWith('on')) expect(runs[n].drawCalls, n).toBeGreaterThan(0);
    }
  }, 120000);

  it('keeps the idle fixed value', () => {
    for (const [name, run] of Object.entries(idleMatrix())) expect(run.hash, name).toBe(IDLE_HASH);
  }, 120000);

  it.each([
    ['soldier', SOLDIER_HASH],
    ['heli', HELI_HASH],
  ] as const)('keeps the %s proxy fixed value with render reads on', (scenario, fixed) => {
    const run = play(scenario, GROUPINGS['2'], true);
    expectCombat(run, scenario);
    expect(run.drawCalls).toBeGreaterThan(0);
    expect(run.hash).toBe(fixed);
  }, 120000);

  it('fingerprints all RNG streams, tickets, capture values, every unit and the player', () => {
    const battle = openBattle(), { session, runtime } = battle, w = session.world, c = runtime.conquest;
    const spawn = runtime.spawnPoints(w).find(p => p.id === 'soldierBase')!;
    expect(session.deploy(runtime.spawnFor(spawn, STANDARD_LOADOUT))).toBe(true);
    const changes: [string, () => void][] = [
      ['ticket', () => { c.tickets.veros -= 1e-9; }],
      ['capture value', () => { c.points[0].v += 1e-9; }],
      ['point owner', () => { c.points[0].owner = 'neutral'; }],
      ['last unit position', () => { w.units[w.units.length - 1].pos.x += 1e-9; }],
      ['first unit hp', () => { w.units[0].hp -= 1e-9; }],
      ['unit count', () => { w.units.pop(); }],
      ['helicopter', () => { w.player.pos.y += 1e-9; }],
      ['soldier', () => { w.soldier!.pos.x += 1e-9; }],
    ];
    let before = digest(battleState(battle));
    for (const [name, change] of changes) {
      change();
      const after = digest(battleState(battle));
      expect(after, name).not.toBe(before);
      before = after;
    }
    const streams = [vi.spyOn(w, 'rng'), vi.spyOn(w, 'fxRng'), vi.spyOn(w, 'playerRng')];
    fingerprint(battle);
    for (const s of streams) expect(s).toHaveBeenCalledOnce();
  });
});
