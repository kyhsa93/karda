import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import type { SimEvent } from '../events';
import { PLAYER_OWNER } from '../weapons/projectile';
import { STEP } from '../world';
import { ProxyPilot } from './proxy';
import { createBattleSession } from './runtime';
import type { BattleMapDef } from './schema';

const harek = JSON.parse(harekRaw) as BattleMapDef;

function fly(seconds: number, aimError = 0) {
  const { session, runtime } = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
  const fired: string[] = [];
  const events: SimEvent[] = [];
  session.world.events.onAny(e => { events.push(e); if (e.t === 'fire' && e.owner === PLAYER_OWNER) fired.push(e.weapon); });
  session.start();
  session.frozen = false;
  const pilot = new ProxyPilot(runtime, 'coalition');
  pilot.aimErrorMrad = aimError;
  const before = session.world.units.length;
  for (let i = 0; i < Math.round(seconds * 120); i++) { pilot.step(session, STEP); session.step(STEP); }
  return { session, pilot, fired, events, spawned: session.world.units.length - before };
}

describe('attack helicopter proxy (#198)', () => {
  it('flies the player avatar and shoots through the player weapon path', () => {
    const { session, pilot, fired } = fly(420);
    expect(pilot.sorties).toBeGreaterThanOrEqual(1);
    expect(session.world.avatar.kind === 'heli' || session.mode !== 'play').toBe(true);
    expect(session.world.units.some(u => u.defId === 'c_apache' && u.alive)).toBe(false);
    expect(fired.length).toBeGreaterThan(0);
  }, 60000);

  it('is deterministic for a seed', () => {
    const a = fly(90), b = fly(90);
    expect(b.session.world.player.pos.toArray()).toEqual(a.session.world.player.pos.toArray());
    expect(b.fired).toEqual(a.fired);
    expect(b.pilot.kills).toBe(a.pilot.kills);
  }, 60000);

  it('kills less when its aim gets worse (the failing-grade test)', () => {
    const exact = fly(420), blind = fly(420, 100);
    expect(exact.pilot.kills).toBeGreaterThan(blind.pilot.kills);
  }, 60000);
});
