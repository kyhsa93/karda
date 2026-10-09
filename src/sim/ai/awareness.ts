import { Vector3 } from 'three';
import { detectRange, DETECT_RATE, revealedByFire, soldierTarget } from '../infantry/awareness';
import { clamp } from '../../core/math';
import type { LosCache } from '../los';
import type { Terrain } from '../terrain';
import type { Unit } from '../units';
import type { World } from '../world';
import { litBy, SEARCHLIGHT_RANGE } from './searchlight';

export const AI_TICK = 0.1;
export const BASE_RATE = 0.6;
export const VIS_RANGE_DAY = 4000;
export const VIS_RANGE_NIGHT = 1500;
export const VIS_RANGE_TWILIGHT = 3000;
export const LOW_AGL = 30 * 0.3048;
export const SLOW = 10 * 0.514444;
export const LOW_EXPOSURE = 0.35;
export const SKYLINE = 1.5;
export const NOISE_RANGE = 1500;
export const NOISE = 1.5;
export const NOISE_SUSPECT_RATE = 0.1;
export const SUSPECT = 0.3;
export const FOG = 0.5;
export const DECAY = 0.15;
export const MEMORY = 20;
export const ALERT_RADIUS = 1000;
export const ALERT_LEVEL = 0.5;
export const RADAR_CLUTTER_AGL = 50 * 0.3048;
export const RADAR_P_LOW = 0.05;
export const RADAR_P = 0.5;
export const RADAR_ACQUIRE = 2;
export const SAM_LINK_RANGE = 6000;
export const RADAR_LOST_FACTOR = 0.5;

export function linkedRadars(world: World, u: Unit) {
  return world.units.filter(o => o.defId === 'sam_radar' && o.side === u.side && o.pos.distanceTo(u.pos) <= SAM_LINK_RANGE);
}

export type TimeOfDay = 'day' | 'dusk' | 'dawn' | 'night';
export interface Conditions { night: boolean; fog: boolean; playerRadar: boolean; time?: TimeOfDay }

export function visualRange(cond: Conditions) {
  const time = cond.time ?? (cond.night ? 'night' : 'day');
  const range = time === 'night' ? VIS_RANGE_NIGHT : time === 'day' ? VIS_RANGE_DAY : VIS_RANGE_TWILIGHT;
  return cond.fog ? range * FOG : range;
}

export function eyeOf(u: Unit, out = new Vector3()) {
  return out.set(u.pos.x, u.pos.y + u.def.size[1] + 2, u.pos.z);
}

export function skylined(t: Terrain, eye: Vector3, target: Vector3, reach = 3000) {
  const d = target.clone().sub(eye).normalize();
  for (let s = 50; s <= reach; s += 50) {
    const p = target.clone().addScaledVector(d, s);
    if (t.surfaceAt(p.x, p.z) > p.y) return false;
  }
  return true;
}

export function visualRate(world: World, eye: Vector3, occlusion: number, cond: Conditions, range = visualRange(cond)) {
  const h = world.playerBody();
  const dist = eye.distanceTo(h.pos);
  const distF = Math.pow(clamp(1 - dist / range, 0, 1), 1.5);
  if (distF <= 0) return 0;
  const low = h.agl <= LOW_AGL && Math.hypot(h.vel.x, h.vel.z) <= SLOW;
  let exposure = low ? LOW_EXPOSURE : 1;
  if (skylined(world.terrain, eye, h.pos)) exposure *= SKYLINE;
  const noise = dist <= NOISE_RANGE ? NOISE : 1;
  return BASE_RATE * distF * exposure * noise * (1 - occlusion) * world.difficulty.detection;
}

function detect(world: World, u: Unit, by: 'visual' | 'radar') {
  const ai = u.ai;
  ai.awareness = 1;
  ai.lastSeen = world.playerBody().pos.clone();
  ai.lastSeenAt = world.time;
  if (ai.detected) return;
  ai.detected = true;
  world.emit({ t: 'detected', id: u.id, by });
  for (const o of world.units) {
    if (o === u || !o.alive || o.side !== u.side || o.def.detect === 'none') continue;
    if (o.pos.distanceTo(u.pos) <= ALERT_RADIUS && o.ai.awareness < ALERT_LEVEL) o.ai.awareness = ALERT_LEVEL;
  }
}

function forget(world: World, u: Unit, dt: number) {
  const ai = u.ai;
  ai.awareness = Math.max(0, ai.awareness - DECAY * dt);
  if (ai.detected && ai.awareness < 1) ai.detected = false;
  if (ai.lastSeen && world.time - ai.lastSeenAt > MEMORY) ai.lastSeen = null;
}

function setRadar(world: World, u: Unit, mode: Unit['ai']['radar']) {
  if (u.ai.radar === mode) return;
  const was = u.ai.radar;
  u.ai.radar = mode;
  if (mode === 'track' || was === 'track') world.emit({ t: 'radarTrack', id: u.id, on: mode === 'track' });
}

export function stepAwareness(world: World, los: LosCache, cond: Conditions, dt = AI_TICK) {
  const h = world.playerBody();
  if (!h.alive) return;
  const eye = new Vector3();
  for (const u of world.units) {
    if (!u.alive || !world.huntsPlayer(u) || u.def.detect === 'none' || u.passive) continue;
    eyeOf(u, eye);
    const dist = eye.distanceTo(h.pos);
    if (h.kind === 'soldier' && world.soldier) {
      const target = soldierTarget(world.soldier);
      const sight = los.visual(u.id, eye, target, world.time);
      if (revealedByFire(world.soldierLastShot, world.time, dist)) detect(world, u, 'visual');
      else if (sight.clear && dist <= detectRange(world.soldier, sight.occlusion > 0)) {
        u.ai.awareness = Math.min(1, u.ai.awareness + DETECT_RATE * world.difficulty.detection * dt);
        if (u.ai.awareness >= 1) detect(world, u, 'visual');
      } else forget(world, u, dt);
      continue;
    }
    if (u.def.detect === 'radar' && u.def.radar && h.kind !== 'soldier') {
      const r = u.def.radar;
      if (u.ai.jammed > 0) { u.ai.jammed = Math.max(0, u.ai.jammed - dt); setRadar(world, u, 'search'); continue; }
      const link = u.defId.endsWith('sam_short') ? linkedRadars(world, u) : [];
      const search = link.length && link.every(o => !o.alive) ? r.search * RADAR_LOST_FACTOR : r.search;
      const cued = link.some(o => o.alive && o.ai.radar !== 'search');
      const seen = dist <= search && los.radar(u.id, eye, h.pos, world.time);
      if (!seen) {
        setRadar(world, u, 'search');
        u.ai.radarTimer = 0;
        forget(world, u, dt);
        continue;
      }
      if (u.ai.radar === 'search') {
        const p = cond.playerRadar || cued ? 1 : Math.min(1, (h.agl < RADAR_CLUTTER_AGL ? RADAR_P_LOW : RADAR_P) * world.difficulty.detection);
        if (world.playerRng() < p) { setRadar(world, u, 'acquire'); u.ai.radarTimer = 0; detect(world, u, 'radar'); }
        else forget(world, u, dt);
      } else {
        detect(world, u, 'radar');
        u.ai.radarTimer += dt;
        if (u.ai.radar === 'acquire' && u.ai.radarTimer >= RADAR_ACQUIRE && dist <= (r.track ?? r.search)) setRadar(world, u, 'track');
      }
      continue;
    }
    const range = cond.time === 'night' && litBy(world, u) ? SEARCHLIGHT_RANGE : visualRange(cond);
    const sight = dist <= range ? los.visual(u.id, eye, h.pos, world.time) : { clear: false, occlusion: 1 };
    if (sight.clear) {
      u.ai.awareness = Math.min(1, u.ai.awareness + visualRate(world, eye, sight.occlusion, cond, range) * dt);
      if (u.ai.awareness >= 1) detect(world, u, 'visual');
    } else {
      forget(world, u, dt);
      if (dist <= NOISE_RANGE && u.ai.awareness < SUSPECT) u.ai.awareness = Math.min(SUSPECT, u.ai.awareness + (NOISE_SUSPECT_RATE + DECAY) * dt);
    }
  }
}
