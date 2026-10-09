import { Vector3 } from 'three';
import { clamp } from '../../core/math';
import { soldierTarget } from '../infantry/awareness';
import { scatter, volleyAt } from '../infantry/incoming';
import { SOLDIER_DAMAGE_SCALE } from '../infantry/soldier';
import { hitsAir, hitsGround, type Unit, type UnitWeaponDef } from '../units';
import type { World } from '../world';
import { AI_TICK, eyeOf, SUSPECT } from './awareness';

export const LOS_LOST_SECONDS = 3;
export const SEARCH_SECONDS = 20;
export const ALERT_FORGET = 20;
export const RETREAT_HP = 0.3;
export const FAST = 60 * 0.514444;
export const FAST_FACTOR = 0.6;
export const COVER_RANGE = 600;

export const REACTION: Record<string, number> = { infantry: 2, vehicle: 1.5, tracked: 1.5, airDefense: 1, air: 1.5, structure: 2 };
export const SAM_REACTION = 3;

export function reactionTime(u: Unit) {
  if (u.def.weapons.some(w => hitsAir(w) && (w.kind === 'missileRadar' || w.kind === 'missileIR')) && u.def.category === 'airDefense') return SAM_REACTION;
  return REACTION[u.def.category] ?? 1.5;
}

export function onFoot(world?: World) {
  return world?.avatar.kind === 'soldier';
}

export function hitsPlayer(w: UnitWeaponDef, world?: World) {
  return onFoot(world) ? hitsGround(w) && w.kind === 'bullet' : hitsAir(w);
}

export function directWeapons(u: Unit, world?: World) {
  return u.def.weapons.filter(w => hitsPlayer(w, world) && (w.kind === 'bullet' || w.kind === 'rocket'));
}

export function hitChance(world: World, w: UnitWeaponDef, dist: number) {
  const v = world.playerBody().vel, wind = world.wind;
  const speed = Math.hypot(v.x - wind.x, v.y - wind.y, v.z - wind.z);
  return clamp((w.accuracy ?? 0) * (1 - (dist / w.range) ** 2) * (speed >= FAST ? FAST_FACTOR : 1) * world.difficulty.enemyAccuracy, 0, 1);
}

export function unitHitChance(world: World, u: Unit, w: UnitWeaponDef, dist: number) {
  return clamp(hitChance(world, w, dist) * (u.skill ?? 1), 0, 1);
}

function inRange(world: World, u: Unit, dist: number) {
  return u.def.weapons.some(w => hitsPlayer(w, world) && (!onFoot(world) || w.kind === 'bullet') && dist <= w.range && dist >= w.minRange);
}

function sees(world: World, u: Unit, eye: Vector3) {
  const p = onFoot(world) && world.soldier ? soldierTarget(world.soldier) : world.playerBody().pos;
  return u.def.detect === 'radar' && !onFoot(world) ? world.los.radar(u.id, eye, p, world.time) : world.los.visual(u.id, eye, p, world.time).clear;
}

function nearestCover(world: World, u: Unit): Vector3 | null {
  let best: Vector3 | null = null, bestD = COVER_RANGE;
  const threat = world.playerBody().pos;
  for (const t of world.terrain.trees) {
    const d = Math.hypot(t.x - u.pos.x, t.z - u.pos.z);
    if (d < bestD && Math.hypot(t.x - threat.x, t.z - threat.z) > Math.hypot(u.pos.x - threat.x, u.pos.z - threat.z) - 50) { bestD = d; best = new Vector3(t.x, 0, t.z); }
  }
  for (const b of world.terrain.buildings) {
    const d = Math.hypot(b.x - u.pos.x, b.z - u.pos.z);
    if (d < bestD) { bestD = d; best = new Vector3(b.x, 0, b.z); }
  }
  return best;
}

function moveToward(world: World, u: Unit, to: Vector3, dt: number) {
  const m = u.def.move;
  if (!m || m.air) return true;
  const speed = m.offroad ? (m.offroadSpeed ?? m.speed * 0.6) : m.speed * 0.5;
  const dx = to.x - u.pos.x, dz = to.z - u.pos.z, d = Math.hypot(dx, dz);
  if (d < 8) { u.vel.set(0, 0, 0); return true; }
  const step = Math.min(d, speed * dt);
  u.pos.x += dx / d * step; u.pos.z += dz / d * step;
  u.pos.y = world.terrain.surfaceAt(u.pos.x, u.pos.z);
  u.vel.set(dx / d * speed, 0, dz / d * speed);
  u.yaw = Math.atan2(-dx, -dz);
  return false;
}

function enter(u: Unit, state: Unit['ai']['state']) {
  u.ai.state = state;
  u.ai.stateTimer = 0;
  if (state === 'engage') { u.ai.blindTimer = 0; u.ai.fireAcc = 0; }
}

function fireAtSoldier(world: World, u: Unit, eye: Vector3, dist: number, dt: number) {
  const s = world.soldier;
  if (!s) return;
  const target = soldierTarget(s);
  const partial = world.los.visual(u.id, eye, target, world.time).occlusion > 0;
  const w = u.def.squad ? null : directWeapons(u, world).find(x => dist <= x.range && dist >= x.minRange) ?? null;
  const v = volleyAt(u, w, s, dist, partial, world.difficulty.enemyAccuracy * (u.skill ?? 1));
  if (!v) return;
  if (u.battle) u.battle.firedAt = world.time;
  u.ai.fireAcc += v.rate * dt;
  while (u.ai.fireAcc >= 1) {
    u.ai.fireAcc -= 1;
    const hit = world.playerRng() < v.p;
    const to = hit ? target.clone() : scatter(target, dist, world.fxRng);
    world.emit({ t: 'fire', weapon: w?.id ?? 'g_rifle', pos: eye.clone(), dir: to.sub(eye).normalize(), owner: u.id, tracer: true });
    if (hit) world.emit({ t: 'playerHit', by: u.id, weapon: w?.id ?? 'g_rifle', damage: v.damage / SOLDIER_DAMAGE_SCALE });
  }
}

function fire(world: World, u: Unit, eye: Vector3, dist: number, dt: number) {
  if (onFoot(world)) { fireAtSoldier(world, u, eye, dist, dt); return; }
  const range = dist;
  for (const w of directWeapons(u, world)) {
    if (range > w.range || range < w.minRange) continue;
    u.ai.fireAcc += w.rate * dt;
    while (u.ai.fireAcc >= 1) {
      u.ai.fireAcc -= 1;
      const hit = world.playerRng() < unitHitChance(world, u, w, range);
      const target = world.playerBody().pos.clone();
      if (!hit) target.add(new Vector3(world.fxRng() - 0.5, world.fxRng() - 0.5, world.fxRng() - 0.5).multiplyScalar(30 + range * 0.02));
      const dir = target.sub(eye).normalize();
      world.emit({ t: 'fire', weapon: w.id, pos: eye.clone(), dir, owner: u.id, tracer: true });
      if (hit) world.emit({ t: 'playerHit', by: u.id, weapon: w.id, damage: w.damage });
    }
    break;
  }
}

export function missileWeapons(u: Unit, world?: World) {
  if (onFoot(world)) return [];
  return u.def.weapons.filter(w => hitsAir(w) && (w.kind === 'missileIR' || w.kind === 'missileRadar'));
}

function launchMissiles(world: World, u: Unit, dist: number, dt: number) {
  u.weaponCooldown = Math.max(0, u.weaponCooldown - dt);
  if (u.weaponCooldown > 0) return;
  for (const w of missileWeapons(u, world)) {
    if (dist > w.range || dist < w.minRange) continue;
    if (w.kind === 'missileRadar' && u.ai.radar !== 'track') continue;
    if (w.kind === 'missileIR' && u.def.move?.air && !u.aam) continue;
    if (u.def.move?.stationaryToFire && u.vel.lengthSq() > 0.01) continue;
    world.launchEnemyMissile(u, w.id);
    u.weaponCooldown = 1 / w.rate;
    return;
  }
}

export function stepBrain(world: World, u: Unit, dt = AI_TICK) {
  const ai = u.ai, h = world.playerBody();
  ai.stateTimer += dt;
  if (ai.state !== 'retreat' && u.def.move && !u.def.move.air && u.hp < u.def.hp * RETREAT_HP && u.def.weapons.length >= 0) {
    enter(u, 'retreat');
    ai.cover = nearestCover(world, u);
  }
  const eye = eyeOf(u);
  const dist = eye.distanceTo(h.pos);
  switch (ai.state) {
    case 'idle':
      if (ai.awareness >= SUSPECT) enter(u, 'alert');
      break;
    case 'alert':
      if (ai.detected && h.alive && inRange(world, u, dist)) { enter(u, 'engage'); ai.aimTimer = reactionTime(u) * world.difficulty.enemyReaction / (u.skill ?? 1); }
      else if (ai.awareness < SUSPECT && (!ai.lastSeen || world.time - ai.lastSeenAt > ALERT_FORGET) && ai.stateTimer > ALERT_FORGET) enter(u, 'idle');
      break;
    case 'engage': {
      const visible = h.alive && sees(world, u, eye) && inRange(world, u, dist);
      if (!visible) {
        ai.blindTimer += dt;
        if (ai.blindTimer >= LOS_LOST_SECONDS) enter(u, 'search');
        break;
      }
      ai.blindTimer = 0;
      if (ai.aimTimer > 0) { ai.aimTimer -= dt; break; }
      fire(world, u, eye, dist, dt);
      launchMissiles(world, u, dist, dt);
      break;
    }
    case 'search':
      if (ai.detected && h.alive && inRange(world, u, dist) && sees(world, u, eye)) { enter(u, 'engage'); ai.aimTimer = reactionTime(u) * world.difficulty.enemyReaction * 0.5; }
      else if (ai.stateTimer >= SEARCH_SECONDS) enter(u, ai.awareness >= SUSPECT ? 'alert' : 'idle');
      break;
    case 'retreat':
      if (ai.cover) moveToward(world, u, ai.cover, dt);
      if (ai.detected && h.alive && sees(world, u, eye) && inRange(world, u, dist)) fire(world, u, eye, dist, dt);
      break;
  }
}

export function stepBrains(world: World, dt = AI_TICK) {
  for (const u of world.units) {
    if (u.alive && world.huntsPlayer(u) && u.def.detect !== 'none' && !u.passive && u.battle?.target?.kind !== 'unit') stepBrain(world, u, dt);
  }
}
