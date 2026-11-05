import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import type { SimEvent } from '../../sim/events';
import { createBattleSession } from '../../sim/battle/runtime';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STANDARD_LOADOUT } from '../../sim/heli/loadout';
import { STEP } from '../../sim/world';
import { eventMessage, MessageLog } from './messages';

const harek = JSON.parse(harekRaw) as BattleMapDef;

describe('MessageLog', () => {
  it('expires messages after three seconds of simulation time regardless of frame rate', () => {
    const log = new MessageLog();
    log.push(eventMessage({ t: 'refuel' })!);
    for (let i = 0; i < 359; i++) log.tick(STEP);
    expect(log.items).toHaveLength(1);
    log.tick(STEP * 2);
    expect(log.items).toHaveLength(0);
  });

  it('keeps a message alive when the frame rate is low but little simulation time passed', () => {
    const log = new MessageLog();
    log.push(eventMessage({ t: 'boundary' })!);
    for (let frame = 0; frame < 60; frame++) log.tick(0);
    expect(log.items).toHaveLength(1);
  });

  it('drops duplicates and keeps at most four', () => {
    const log = new MessageLog();
    log.push({ text: 'a', color: '' }); log.push({ text: 'a', color: '' });
    for (const t of ['b', 'c', 'd', 'e']) log.push({ text: t, color: '' });
    expect(log.items.map(m => m.text)).toEqual(['b', 'c', 'd', 'e']);
  });
});

describe('battle end', () => {
  for (const [outcome, emptied] of [['win', 'veros'], ['loss', 'coalition']] as const) {
    it(`reaches the report on a ${outcome} without leaving an objective message`, () => {
      const { session, runtime } = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
      expect(session.respawns).toBe(true);
      const log = new MessageLog();
      const objective: SimEvent[] = [];
      session.world.events.onAny(e => {
        if (e.t === 'objective') objective.push(e);
        const m = eventMessage(e);
        if (m) log.push(m);
      });
      session.start();
      const spawn = runtime.spawnPoints(session.world).find(p => p.role === 'soldier')!;
      expect(session.deploy(runtime.spawnFor(spawn, STANDARD_LOADOUT, 'assault'))).toBe(true);
      log.clear();
      runtime.conquest.tickets[emptied] = 0;
      for (let i = 0; i < 600 && session.mode !== 'done'; i++) { session.step(STEP); log.tick(STEP); }
      expect(session.mode).toBe('done');
      expect(runtime.result.winner).toBe(outcome === 'win' ? 1 : -1);
      expect(objective).toEqual([{ t: 'objective', id: runtime.id, state: 'done' }]);
      expect(log.items).toEqual([]);
    });
  }

  it('never turns an objective event into a message', () => {
    expect(eventMessage({ t: 'objective', id: 'battle', state: 'done' })).toBeNull();
    expect(eventMessage({ t: 'objective', id: 'battle', state: 'failed', reason: 'x' })).toBeNull();
  });
});
