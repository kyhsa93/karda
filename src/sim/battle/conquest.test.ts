import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import type { SimEvent } from '../events';
import { STANDARD_LOADOUT } from '../heli/loadout';
import { makeWorld, ofSide, otherSide, SIDES } from '../testing';
import { UNIT_DEFS } from '../units';
import { STEP, type World } from '../world';
import { Conquest, ticketClass } from './conquest';
import { spent } from './conquestMatch.cases';
import { conquestRules, validateRules } from './modes';
import { createBattleSession } from './runtime';
import type { BattleMapDef } from './schema';

const harek = JSON.parse(harekRaw) as BattleMapDef;
const quick = conquestRules('quick');
const rules = { ...quick, tickets: 300, bleedPerPointPerSec: 0.1 };

function setup(mode: 'quick' | 'conquest' = 'quick') {
  const { world, events } = makeWorld(5);
  world.clearCombat();
  world.active = false;
  const c = new Conquest(harek, mode, mode === 'quick' ? rules : conquestRules('conquest'));
  return { world, events, c };
}

function tick(world: World, c: Conquest, seconds: number, each?: () => void) {
  for (let s = 0; s < seconds; s++) { each?.(); c.step(world, 1); world.events.flush(); }
}

const pointD = (c: Conquest) => c.points.find(p => p.id === 'D')!;

describe('modes.json (wiki 3.6)', () => {
  it('resolves quick conquest on top of conquest and validates', () => {
    expect(quick).toMatchObject({ tickets: 180, bleedPerPointPerSec: 0.3, timeLimitSec: 900, forces: 'quick', captureRatePerSec: 4, playerRespawnSec: 10 });
    expect(conquestRules('conquest').bleedPerPointPerSec).toBe(0.1);
    expect(conquestRules('conquest')).toMatchObject({ tickets: 800, timeLimitSec: 2100, forces: 'large' });
    expect(validateRules(quick)).toEqual([]);
    expect(validateRules({ ...rules, tickets: 0, ticketCost: { ...rules.ticketCost, tank: -1 } })).toEqual(['tickets must be > 0', 'ticketCost.tank must be > 0']);
  });
});

describe('conquest (wiki 3.3, 5.9-3)', () => {
  it('starts with the mode\'s owners', () => {
    const { c } = setup();
    expect(c.points.map(p => [p.id, p.owner, p.v])).toEqual([['A', 'coalition', 100], ['D', 'neutral', 0], ['G', 'veros', -100]]);
    expect(c.tickets).toEqual({ coalition: 300, veros: 300 });
  });

  it.each(SIDES)('5.9-3, 5.9-12: a full five-man squad takes a neutral point in 25 s; one squad each freezes it (player %s)', side => {
    const { world, events, c } = setup();
    world.playerSide = side;
    world.spawnUnit(ofSide('inf', side), 10, 10);
    let at = -1;
    for (let s = 1; s <= 40 && at < 0; s++) { c.step(world, 1); world.events.flush(); if (pointD(c).owner === side) at = s; }
    expect(at).toBeGreaterThanOrEqual(24);
    expect(at).toBeLessThanOrEqual(26);
    expect(events.some(e => e.t === 'pointOwner' && e.id === 'D' && e.owner === side)).toBe(true);
    const b = setup();
    b.world.playerSide = side;
    b.world.spawnUnit(ofSide('inf', side), 10, 10);
    tick(b.world, b.c, 5);
    const v = pointD(b.c).v;
    b.world.spawnUnit(ofSide('inf', otherSide(side)), -10, -10);
    tick(b.world, b.c, 20);
    expect(pointD(b.c).contested).toBe(true);
    expect(pointD(b.c).v).toBe(v);
  });

  it('turns an enemy point neutral at zero and then takes it in 50 s', () => {
    const { world, c } = setup();
    const g = c.points.find(p => p.id === 'G')!;
    world.spawnUnit('c_inf', g.x, g.z);
    tick(world, c, 24);
    expect(g.owner).toBe('veros');
    tick(world, c, 1);
    expect(g.owner).toBe('neutral');
    tick(world, c, 25);
    expect(g.owner).toBe('coalition');
  });

  it('counts squads by members, vehicles at 0.5 and aircraft not at all', () => {
    const { world, c } = setup();
    const d = pointD(c);
    const s = world.spawnUnit('c_inf', 5, 0);
    world.damageUnit(s, 16, false);
    world.spawnUnit('c_tank', -5, 0);
    world.spawnUnit('c_apache', 0, 5);
    expect(c.strengthOf(world, d).coalition).toBeCloseTo(3 * 0.2 + 0.5);
  });

  it('bleeds the side with fewer points at 6 tickets a minute per point', () => {
    const { world, c } = setup();
    const g = c.points.find(p => p.id === 'G')!;
    g.owner = 'neutral'; g.v = 0;
    tick(world, c, 60);
    expect(c.tickets.veros).toBeCloseTo(300 - 6, 5);
    expect(c.tickets.coalition).toBe(300);
  });

  it('charges tickets for every fallen squad member and each lost vehicle', () => {
    const { world, c } = setup();
    const squad = world.spawnUnit('inf', 3000, 3000);
    const tank = world.spawnUnit('tank', 3100, 3000);
    const truck = world.spawnUnit('c_truck', 3200, 3000);
    tick(world, c, 1);
    world.damageUnit(squad, 16, false);
    tick(world, c, 1);
    expect(c.tickets.veros).toBeCloseTo(298);
    world.damageUnit(squad, 100, false);
    world.damageUnit(tank, 1000, false);
    world.damageUnit(truck, 1000, false);
    tick(world, c, 1);
    expect(c.tickets.veros).toBeCloseTo(298 - 3 - 4);
    expect(c.tickets.coalition).toBeCloseTo(300 - 2);
    tick(world, c, 5);
    expect(c.tickets.veros).toBeCloseTo(298 - 3 - 4);
    expect(ticketClass(UNIT_DEFS.c_heli_transport)).toBe('transportHeli');
    expect(ticketClass(UNIT_DEFS.jet)).toBe('jet');
    expect(ticketClass(UNIT_DEFS.aaa_light)).toBe('airDefense');
    expect(ticketClass(UNIT_DEFS.apc)).toBe('apc');
  });

  it('ends when a side runs out of tickets', () => {
    const { world, events, c } = setup();
    c.tickets.veros = 3;
    c.playerDied('veros', 'attackHeli');
    tick(world, c, 1);
    expect(c.winner).toBe('coalition');
    expect(c.endReason).toBe('tickets');
    expect(c.tickets.veros).toBe(0);
    expect(events.filter(e => e.t === 'battleEnd')).toHaveLength(1);
    tick(world, c, 3);
    expect(events.filter(e => e.t === 'battleEnd')).toHaveLength(1);
  });

  it('decides at the time limit by tickets, then points, else a draw', () => {
    const a = setup();
    a.c.tickets.coalition = 200;
    a.c.elapsed = rules.timeLimitSec - 1;
    tick(a.world, a.c, 1);
    expect([a.c.winner, a.c.endReason]).toEqual(['veros', 'time']);
    const b = setup();
    b.c.points[1].owner = 'coalition';
    b.c.elapsed = rules.timeLimitSec - 1;
    tick(b.world, b.c, 1);
    expect(b.c.winner).toBe('coalition');
    const d = setup();
    d.c.elapsed = rules.timeLimitSec - 1;
    tick(d.world, d.c, 1);
    expect(d.c.winner).toBe('draw');
  });
});

describe('battle end through the session', () => {
  it('reports the result and finishes the session, even from the deploy screen', () => {
    const { session, runtime } = createBattleSession(harek, 'quick', { side: 'veros', seed: 3 });
    const events: SimEvent[] = [];
    session.world.events.onAny(e => events.push(e));
    session.start();
    session.deploy(runtime.spawnFor(runtime.spawnPoints(session.world)[0], STANDARD_LOADOUT));
    session.world.killPlayer('crewKilled');
    for (let i = 0; i < 120 * 3; i++) session.step(STEP);
    expect(session.mode).toBe('deploy');
    const r = runtime.rules;
    expect(runtime.conquest.tickets.veros).toBeCloseTo(r.tickets - 6, 5);
    runtime.conquest.tickets.coalition = 0;
    for (let i = 0; i < 120 * 3; i++) session.step(STEP);
    expect(session.mode).toBe('done');
    expect(runtime.result).toMatchObject({ winner: 1, coalition: 0 });
  });
});

describe('ticket causes (#237)', () => {
  it('tallies bleed, squad members, vehicles and the player apart per side', () => {
    const { world, c } = setup();
    expect(c.causes).toEqual({
      coalition: { bleed: 0, person: 0, vehicle: 0, player: 0 },
      veros: { bleed: 0, person: 0, vehicle: 0, player: 0 },
    });
    const g = c.points.find(p => p.id === 'G')!;
    g.owner = 'neutral'; g.v = 0;
    tick(world, c, 60);
    expect(c.causes.veros.bleed).toBeCloseTo(6, 9);
    const squad = world.spawnUnit('inf', 3000, 3000);
    const tank = world.spawnUnit('tank', 3100, 3000);
    const truck = world.spawnUnit('c_truck', 3200, 3000);
    tick(world, c, 1);
    world.damageUnit(squad, 100, false);
    world.damageUnit(tank, 1000, false);
    world.damageUnit(truck, 1000, false);
    tick(world, c, 1);
    c.playerDied('coalition', 'attackHeli');
    c.playerDied('veros', null);
    expect(c.causes.veros).toMatchObject({ person: 5, vehicle: 4, player: 1 });
    expect(c.causes.coalition).toEqual({ bleed: 0, person: 0, vehicle: 2, player: 6 });
    for (const s of SIDES) expect(300 - c.tickets[s]).toBeCloseTo(spent(c, s), 9);
  });

  it('stops counting once the battle is over', () => {
    const { world, c } = setup();
    c.tickets.veros = 3;
    c.playerDied('veros', 'attackHeli');
    tick(world, c, 1);
    expect(c.winner).toBe('coalition');
    expect(c.causes.veros.player).toBe(6);
    const after = structuredClone(c.causes);
    c.playerDied('veros', 'attackHeli');
    tick(world, c, 3);
    expect(c.causes).toEqual(after);
  });

  it('carries the player\'s helicopter death through the session', () => {
    const { session, runtime } = createBattleSession(harek, 'quick', { side: 'veros', seed: 3 });
    session.start();
    session.deploy(runtime.spawnFor(runtime.spawnPoints(session.world)[0], STANDARD_LOADOUT));
    session.world.killPlayer('crewKilled');
    for (let i = 0; i < 120 * 3; i++) session.step(STEP);
    expect(runtime.conquest.causes.veros.player).toBe(runtime.rules.ticketCost.person + runtime.rules.ticketCost.attackHeli);
  });
});
