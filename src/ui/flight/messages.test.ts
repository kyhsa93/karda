import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import type { SimEvent } from '../../sim/events';
import type { Mode } from '../../sim/session';
import { createBattleSession } from '../../sim/battle/runtime';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STANDARD_LOADOUT } from '../../sim/heli/loadout';
import { STEP } from '../../sim/world';
import { t } from '../../content/strings';
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

  it('never turns a hit confirmation into a message (#273)', () => {
    expect(eventMessage({ t: 'unitHit', unit: 3 })).toBeNull();
  });
});

describe('flight messages after the flight ends', () => {
  const sortie = () => {
    const { session, runtime } = createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    const world = session.world;
    const log = new MessageLog();
    world.events.onAny(e => {
      const m = eventMessage(e);
      if (m) log.push(m);
    });
    session.start();
    const fly = () => {
      for (let i = 0; i < 6000 && session.deployIn() > 0; i++) session.step(STEP);
      const pad = runtime.spawnPoints(world).find(p => p.id === 'base')!;
      expect(session.deploy(runtime.spawnFor(pad, STANDARD_LOADOUT))).toBe(true);
      for (let i = 0; i < 60; i++) frame();
    };
    const frame = () => {
      session.step(STEP);
      log.tick(STEP);
      log.follow(session.mode);
    };
    return { session, runtime, world, log, fly, frame };
  };

  it('keeps the damage messages through the death screen and clears them on the deploy screen', () => {
    const { session, world, log, fly, frame } = sortie();
    fly();
    log.clear();
    for (let i = 0; i < 10 && session.mode === 'play'; i++) {
      world.blastPlayer(world.player.pos.clone(), 350);
      frame();
    }
    expect(session.mode).toBe('crashed');
    const shown = log.items.map(m => m.text);
    expect(shown).toContain(t('msg.system.destroyed', { name: t('systems.cockpit') }));
    let crashedFrames = 0;
    for (let i = 0; i < 600 && session.mode === 'crashed'; i++) {
      expect(log.items.map(m => m.text)).toEqual(shown);
      crashedFrames++;
      frame();
    }
    expect(crashedFrames * STEP).toBeGreaterThan(2.1);
    expect(session.mode).toBe('deploy');
    expect(log.items).toEqual([]);
  });

  it('clears the messages of the last moment on the report screen', () => {
    const { session, runtime, world, log, fly, frame } = sortie();
    fly();
    log.clear();
    world.events.on('objective', e => {
      if (e.state === 'done') world.damageSystem('hydraulics', 100);
    });
    runtime.conquest.tickets.veros = 0;
    let lastPlay: string[] = [];
    for (let i = 0; i < 600 && session.mode === 'play'; i++) {
      lastPlay = log.items.map(m => m.text);
      frame();
    }
    expect(lastPlay).toContain(t('msg.system.destroyed', { name: t('systems.hydraulics') }));
    expect(session.mode).toBe('done');
    expect(log.items).toEqual([]);
  });

  it('shows new damage, FARP and identification messages on the next sortie', () => {
    const { session, world, log, fly, frame } = sortie();
    fly();
    world.killPlayer('crewKilled');
    for (let i = 0; i < 600 && session.mode !== 'deploy'; i++) frame();
    expect(session.mode).toBe('deploy');
    fly();
    expect(session.mode).toBe('play');
    world.damageSystem('hydraulics', 100);
    world.emit({ t: 'farp', state: 'started', repair: 0, rearm: 0 });
    world.emit({ t: 'identified', id: 0, defId: 'manpads', side: 'veros' });
    frame();
    expect(log.items.map(m => m.text)).toEqual([
      t('msg.system.destroyed', { name: t('systems.hydraulics') }),
      t('msg.farp.started'),
      t('msg.identified', { name: t('units.manpads'), side: t('sides.veros') }),
    ]);
  });

  it('keeps messages only while flying or on the death screen', () => {
    const kept = (['brief', 'deploy', 'play', 'crashed', 'over', 'done'] as Mode[]).filter(mode => {
      const log = new MessageLog();
      log.push({ text: 'a', color: '' });
      log.follow(mode);
      return log.items.length > 0;
    });
    expect(kept).toEqual(['play', 'crashed']);
  });
});
