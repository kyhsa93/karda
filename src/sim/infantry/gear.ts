import { Vector3 } from 'three';
import classesJson from '../../content/battle/classes.json';
import type { Terrain } from '../terrain';
import type { Side, Unit } from '../units';
import { aimDir, CLASS_KITS } from './arms';
import { distanceToUnit, hitUnit, isGroundVehicle, WEAPONS } from '../weapons/damage';
import type { World } from '../world';
import type { SoldierClass, SoldierState } from './soldier';
import { SOLDIER_HP } from './soldier';

export interface MedkitDef { count: number; radius: number; healPerSec: number; returnEvery: number; returnHp: number; duration: number; redeployCooldown: number; placeDistance: number }
export interface SmokeDef { count: number; radius: number; duration: number; throwSpeed: number; throwLift: number; center: number; flightMax: number }

export interface RepairDef { healPerSec: number; maxUse: number; overheat: number; cool: number; range: number }
export interface MineDef { count: number; placeDistance: number; triggerRadius: number; afterDeath: number }

export const REPAIR = classesJson.tools.repair as RepairDef;
export const MINE = classesJson.tools.mine as MineDef;
export const MEDKIT = classesJson.tools.medkit as MedkitDef;
export const SMOKE = classesJson.tools.smoke as SmokeDef;
export const THROW_GRAVITY = 9.81;

export interface Medkit { pos: Vector3; until: number; timers: Map<number, number> }
export interface Canister { pos: Vector3; vel: Vector3; age: number }
export interface Mine { pos: Vector3; until: number }
export interface SmokeCloud { x: number; y: number; z: number; r: number; until: number }

export interface SoldierGear {
  medkit: Medkit | null;
  medkitLeft: number;
  readyAt: number;
  smokeLeft: number;
  canisters: Canister[];
  clouds: SmokeCloud[];
  dirty: boolean;
  repairable: boolean;
  repairHeat: number;
  overheatUntil: number;
  repairing: boolean;
  mineLeft: number;
  mines: Mine[];
}

export function createGear(cls: SoldierClass): SoldierGear {
  const tools = CLASS_KITS[cls]?.tools ?? [];
  return {
    medkit: null, medkitLeft: tools.includes('medkit') ? MEDKIT.count : 0, readyAt: 0,
    smokeLeft: tools.includes('smoke') ? SMOKE.count : 0, canisters: [], clouds: [], dirty: false,
    repairable: tools.includes('repair'), repairHeat: 0, overheatUntil: 0, repairing: false,
    mineLeft: tools.includes('mine') ? MINE.count : 0, mines: [],
  };
}

export function placeMedkit(g: SoldierGear, s: SoldierState, terrain: Terrain, now: number) {
  if (g.medkit || g.medkitLeft <= 0 || now < g.readyAt || !s.alive) return false;
  const x = s.pos.x - Math.sin(s.yaw) * MEDKIT.placeDistance, z = s.pos.z - Math.cos(s.yaw) * MEDKIT.placeDistance;
  g.medkit = { pos: new Vector3(x, terrain.surfaceAt(x, z), z), until: now + MEDKIT.duration, timers: new Map() };
  return true;
}

export function placeMine(g: SoldierGear, s: SoldierState, terrain: Terrain) {
  if (g.mineLeft <= 0 || !s.alive) return false;
  g.mineLeft--;
  const x = s.pos.x - Math.sin(s.yaw) * MINE.placeDistance, z = s.pos.z - Math.cos(s.yaw) * MINE.placeDistance;
  g.mines.push({ pos: new Vector3(x, terrain.surfaceAt(x, z), z), until: Infinity });
  return true;
}

export function throwSmoke(g: SoldierGear, s: SoldierState, eye: Vector3) {
  if (g.smokeLeft <= 0 || !s.alive) return false;
  g.smokeLeft--;
  const dir = aimDir(s.yaw, s.pitch + SMOKE.throwLift);
  g.canisters.push({ pos: eye.clone(), vel: dir.multiplyScalar(SMOKE.throwSpeed).add(s.vel), age: 0 });
  return true;
}

export interface GearContext {
  now: number;
  dt: number;
  terrain: Terrain;
  units: readonly Unit[];
  playerSide: Side;
  soldier: SoldierState | null;
  repair: boolean;
  playerDead: boolean;
  world: World;
}

export function smokeBlocks(clouds: readonly SmokeCloud[], a: Vector3, b: Vector3) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len2 = dx * dx + dy * dy + dz * dz;
  for (const c of clouds) {
    const cy = c.y + SMOKE.center;
    const k = len2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (cy - a.y) * dy + (c.z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * k - c.x, py = a.y + dy * k - cy, pz = a.z + dz * k - c.z;
    if (px * px + py * py + pz * pz <= c.r * c.r) return true;
  }
  return false;
}

function reviveOne(u: Unit) {
  const dead = u.members?.find(m => !m.alive);
  if (!dead) return false;
  dead.alive = true;
  dead.hp = u.def.hp / Math.max(1, u.def.squad ?? 1);
  u.hp = Math.min(u.def.hp, u.hp + MEDKIT.returnHp);
  return true;
}

function stepRepair(g: SoldierGear, c: GearContext) {
  const s = c.soldier;
  const using = g.repairable && c.repair && !!s?.alive && c.now >= g.overheatUntil;
  g.repairing = false;
  if (!using) { g.repairHeat = Math.max(0, g.repairHeat - REPAIR.cool * c.dt); return; }
  let best: Unit | null = null, bestD = REPAIR.range;
  for (const u of c.units) {
    if (!u.alive || u.side !== c.playerSide || !isGroundVehicle(u) || u.def.indestructible || u.hp >= u.def.hp) continue;
    const d = distanceToUnit(u, s!.pos);
    if (d <= bestD) { best = u; bestD = d; }
  }
  if (!best) { g.repairHeat = Math.max(0, g.repairHeat - REPAIR.cool * c.dt); return; }
  best.hp = Math.min(best.def.hp, best.hp + REPAIR.healPerSec * c.dt);
  g.repairing = true;
  g.repairHeat += c.dt;
  if (g.repairHeat >= REPAIR.maxUse) { g.repairHeat = 0; g.overheatUntil = c.now + REPAIR.overheat; g.repairing = false; }
}

function stepMines(g: SoldierGear, c: GearContext) {
  for (let i = g.mines.length - 1; i >= 0; i--) {
    const m = g.mines[i];
    if (c.playerDead && m.until === Infinity) m.until = c.now + MINE.afterDeath;
    if (m.until <= c.now) { g.mines.splice(i, 1); continue; }
    const foe = c.units.find(u => u.alive && u.side !== c.playerSide && u.side !== 'civilian' && isGroundVehicle(u) && Math.hypot(u.pos.x - m.pos.x, u.pos.z - m.pos.z) <= MINE.triggerRadius + Math.max(u.def.size[0], u.def.size[2]) / 2);
    if (!foe) continue;
    g.mines.splice(i, 1);
    c.world.emit({ t: 'explosion', pos: m.pos.clone(), size: 4 });
    hitUnit(c.world, foe, WEAPONS.at_mine, true);
  }
}

export function stepGear(g: SoldierGear, c: GearContext) {
  stepRepair(g, c);
  stepMines(g, c);
  for (let i = g.canisters.length - 1; i >= 0; i--) {
    const k = g.canisters[i];
    k.age += c.dt;
    k.vel.y -= THROW_GRAVITY * c.dt;
    k.pos.addScaledVector(k.vel, c.dt);
    const ground = c.terrain.surfaceAt(k.pos.x, k.pos.z);
    if (k.pos.y <= ground || k.age >= SMOKE.flightMax) {
      g.clouds.push({ x: k.pos.x, y: ground, z: k.pos.z, r: SMOKE.radius, until: c.now + SMOKE.duration });
      g.canisters.splice(i, 1);
      g.dirty = true;
    }
  }
  for (let i = g.clouds.length - 1; i >= 0; i--) {
    if (g.clouds[i].until <= c.now) { g.clouds.splice(i, 1); g.dirty = true; }
  }
  const m = g.medkit;
  if (!m) return;
  if (c.now >= m.until) { g.medkit = null; g.readyAt = c.now + MEDKIT.redeployCooldown; return; }
  const s = c.soldier;
  if (s?.alive && s.hp < SOLDIER_HP && s.pos.distanceTo(m.pos) <= MEDKIT.radius) s.hp = Math.min(SOLDIER_HP, s.hp + MEDKIT.healPerSec * c.dt);
  for (const u of c.units) {
    if (!u.alive || !u.def.squad || u.side !== c.playerSide) continue;
    const near = Math.hypot(u.pos.x - m.pos.x, u.pos.z - m.pos.z) <= MEDKIT.radius;
    if (!near || !u.members?.some(x => !x.alive)) { m.timers.delete(u.id); continue; }
    const t = (m.timers.get(u.id) ?? 0) + c.dt;
    if (t >= MEDKIT.returnEvery) { reviveOne(u); m.timers.set(u.id, t - MEDKIT.returnEvery); } else m.timers.set(u.id, t);
  }
}
