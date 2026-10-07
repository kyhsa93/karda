import type { BattleHooks, World } from '../world';
import { stepCombat } from './combat';
import type { Intel } from './intel';
import { Targeting } from './targeting';

export type BattleSystem = (world: World, dt: number) => void;

export interface BattleSystems {
  tick10Hz: BattleSystem[];
  tick1Hz: BattleSystem[];
}

export function composeHooks(systems: BattleSystems): BattleHooks {
  return {
    tick10Hz(world, dt) { for (const s of systems.tick10Hz) s(world, dt); },
    tick1Hz(world, dt) { for (const s of systems.tick1Hz) s(world, dt); },
  };
}

export function brainSystems(intel: Intel | null = null, lethality = 1): BattleSystems {
  const targeting = new Targeting(intel);
  return { tick10Hz: [targeting.step, (w, dt) => stepCombat(w, dt, lethality)], tick1Hz: [] };
}

export { createBattleSession, type SpawnPoint } from './runtime';
export { KITS, KIT_IDS, type KitId } from './kits';
export { CLASS_IDS, CLASS_KITS } from '../infantry/arms';
export type { BattleMapDef } from './schema';

export const MAP_IDS = ['harek'] as const;
export type MapId = (typeof MAP_IDS)[number];

export async function loadMap(id: MapId) {
  const m = await import('../../content/battle/maps/harek.json');
  void id;
  return m.default as unknown as import('./schema').BattleMapDef;
}
