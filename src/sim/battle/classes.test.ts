import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { CLASS_IDS, CLASS_KITS, createArms, INFANTRY_WEAPONS } from '../infantry/arms';
import { STANDARD_LOADOUT } from '../heli/loadout';
import { createBattleSession } from './runtime';
import type { BattleMapDef } from './schema';

const harek = JSON.parse(harekRaw) as BattleMapDef;

describe('soldier class frame (B3-1)', () => {
  it('defines the four classes with a primary weapon and gear slots', () => {
    expect(CLASS_IDS).toEqual(['assault', 'engineer', 'support', 'recon']);
    for (const id of CLASS_IDS) {
      const k = CLASS_KITS[id];
      expect(INFANTRY_WEAPONS[k.primary], id).toBeDefined();
      expect(k.gear.length, id).toBeLessThanOrEqual(k.gearSlots);
      expect(k.gear.length + k.pending.length, id).toBeGreaterThan(0);
      for (const g of k.gear) expect(INFANTRY_WEAPONS[g], `${id}:${g}`).toBeDefined();
      const arms = createArms(id);
      expect(arms.selected).toBe(k.primary);
      expect(Object.keys(arms.ammo).sort()).toEqual([k.primary, ...k.gear].sort());
    }
    expect(CLASS_KITS.assault.gear).toEqual(['grenade']);
  });

  it('spawns the soldier in the chosen class and rebuilds arms on a class switch', () => {
    const { session, runtime } = createBattleSession(harek, 'quick', { side: 'coalition', seed: 42 });
    session.start();
    const world = session.world;
    const point = runtime.spawnPoints(world).find(p => p.role === 'soldier')!;
    for (const cls of CLASS_IDS) {
      const spawn = runtime.spawnFor(point, STANDARD_LOADOUT, cls);
      expect(spawn).toMatchObject({ kind: 'soldier', cls });
      world.spawnAvatar(spawn);
      expect(world.soldier!.cls).toBe(cls);
      expect(world.soldierArms.selected).toBe(CLASS_KITS[cls].primary);
      expect(Object.keys(world.soldierArms.ammo).sort()).toEqual([CLASS_KITS[cls].primary, ...CLASS_KITS[cls].gear].sort());
    }
    expect((runtime.spawnFor(point, STANDARD_LOADOUT) as { cls: string }).cls).toBe('assault');
  });
});
