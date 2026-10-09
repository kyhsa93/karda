import { Vector3 } from 'three';
import { radarSight } from '../los';
import type { EnemyMissile } from '../weapons/enemyMissile';
import type { World } from '../world';

export type ThreatSymbol = 'Z' | 'S' | 'M';
export type ThreatState = 'search' | 'track' | 'launch' | 'missile';

export interface Threat { id: string; symbol: ThreatSymbol; state: ThreatState; bearing: number; range: number }

export const CMWS_RANGE = 6000;
export const FLARE_PER_DROP = 2;
export const FLARE_P = 0.6;
export const FLARE_P_CLOSE = 0.3;
export const FLARE_CLOSE = 1000;
export const CHAFF_P = 0.5;
export const CHAFF_JAM = 2;
export const FLARE_LIFE = 4;

export interface Countermeasures { flares: number; chaff: number; chaffUnlocked: boolean; handled: Set<number> }

export function createCountermeasures(): Countermeasures {
  return { flares: 30, chaff: 30, chaffUnlocked: true, handled: new Set() };
}

export interface Flare { pos: Vector3; vel: Vector3; life: number }

export function relativeBearing(world: World, p: Vector3) {
  const h = world.player;
  const b = Math.atan2(-(p.x - h.pos.x), -(p.z - h.pos.z)) - h.yaw;
  return Math.atan2(Math.sin(b), Math.cos(b));
}

function symbolFor(defId: string): ThreatSymbol {
  return defId.endsWith('sam_short') || defId === 'sam_radar' ? 'S' : 'Z';
}

export function aseThreats(world: World): Threat[] {
  const h = world.player, out: Threat[] = [];
  if (!h.alive) return out;
  const launching = new Set(world.enemyMissiles.filter(m => m.kind === 'radar' && m.guiding).map(m => m.owner));
  for (const u of world.units) {
    if (!u.alive || !world.huntsPlayer(u) || !u.def.radar || u.passive) continue;
    const dist = u.pos.distanceTo(h.pos);
    if (dist > u.def.radar.search) continue;
    const eye = new Vector3(u.pos.x, u.pos.y + u.def.size[1] + 2, u.pos.z);
    if (!radarSight(world.terrain, eye, h.pos)) continue;
    const state: ThreatState = launching.has(u.id) ? 'launch' : u.ai.radar === 'track' ? 'track' : 'search';
    out.push({ id: `u${u.id}`, symbol: symbolFor(u.defId), state, bearing: relativeBearing(world, u.pos), range: dist });
  }
  for (const m of world.enemyMissiles) {
    if (m.kind !== 'ir' || !m.guiding || m.target) continue;
    const dist = m.pos.distanceTo(h.pos);
    if (dist > CMWS_RANGE) continue;
    const closing = m.vel.dot(h.pos.clone().sub(m.pos)) > 0;
    if (closing) out.push({ id: `m${m.id}`, symbol: 'M', state: 'missile', bearing: relativeBearing(world, m.pos), range: dist });
  }
  return out;
}

export function missileInbound(world: World) {
  return aseThreats(world).some(t => t.state === 'launch' || t.state === 'missile');
}

export function decoyFlare(world: World, m: EnemyMissile, flare: Flare) {
  if (m.kind !== 'ir' || !m.guiding || m.target) return false;
  const p = m.pos.distanceTo(world.player.pos) <= FLARE_CLOSE ? FLARE_P_CLOSE : FLARE_P;
  if (world.playerRng() >= p) return false;
  m.target = flare.pos;
  return true;
}

export function decoyChaff(world: World, m: EnemyMissile) {
  if (m.kind !== 'radar' || !m.guiding) return false;
  if (world.playerRng() >= CHAFF_P) return false;
  m.guiding = false;
  return true;
}
