import type { Vector3 } from 'three';
import weaponsJson from '../../content/weapons.json';
import type { Unit } from '../units';
import type { World } from '../world';

export interface WeaponDef {
  guidance: 'ballistic' | 'laser' | 'radar' | 'ir' | 'none';
  minRange: number;
  maxRange: number;
  speed: number;
  damage: number;
  splashRadius: number;
  splashDamage: number;
  penetration: number;
  squadScale?: number;
  falloff?: { near: number; far: number; min: number };
  effectiveRange?: number;
  drag?: number;
  rate?: number;
  dispersionMrad?: number;
  ammo?: number[];
  ammoPerPod?: number;
  ammoPerLauncher?: number;
  salvo?: number[];
  salvoInterval?: number;
  minInterval?: number;
  launchSpeed?: number;
  burnTime?: number;
  thrust?: number;
  accel?: number;
  maxSpeed?: number;
  turnRate?: number;
  seekerHalfAngleDeg?: number;
  loalWindow?: number;
  maxFlight?: number;
  fuse?: number;
  maxG?: number;
  navConstant?: number;
  irLostSeconds?: number;
}

export const WEAPONS = weaponsJson as unknown as Record<string, WeaponDef>;

export function armorMultiplier(penetration: number, armor: number) {
  if (penetration < armor) return 0.1;
  if (penetration > armor) return 1.2;
  return 1;
}

export function directDamage(w: WeaponDef, armor: number) {
  return w.damage * armorMultiplier(w.penetration, armor);
}

export function splashDamage(damage: number, radius: number, penetration: number, distance: number, armor: number) {
  if (radius <= 0 || distance >= radius) return 0;
  return damage * (1 - distance / radius) * armorMultiplier(penetration, armor);
}

export function distanceToUnit(u: Unit, p: Vector3) {
  const [w, h, l] = u.def.size;
  const r = Math.max(w, l) / 2;
  const dx = u.pos.x - p.x, dz = u.pos.z - p.z;
  const dy = Math.max(0, Math.abs(u.pos.y + h / 2 - p.y) - h / 2);
  return Math.max(0, Math.hypot(Math.max(0, Math.hypot(dx, dz) - r), dy));
}

export function falloffDamage(w: WeaponDef, dist: number) {
  const f = w.falloff;
  if (!f) return w.damage;
  const k = Math.max(0, Math.min(1, (dist - f.near) / (f.far - f.near)));
  return w.damage + (f.min - w.damage) * k;
}

export const SIDE_HIT = 1.2;
export const REAR_HIT = 1.5;

export function isGroundVehicle(u: Unit) {
  return u.def.category === 'tracked' || u.def.category === 'vehicle';
}

export function aspectMultiplier(u: Unit, vel: Vector3) {
  if (!isGroundVehicle(u)) return 1;
  const len = Math.hypot(vel.x, vel.z);
  if (len < 1e-6) return 1;
  const along = (vel.x * -Math.sin(u.yaw) + vel.z * -Math.cos(u.yaw)) / len;
  if (along > 0.5) return REAR_HIT;
  return along >= -0.5 ? SIDE_HIT : 1;
}

export function hitUnit(world: World, u: Unit, w: WeaponDef, byPlayer: boolean, dist = 0, aspect = 1) {
  const raw = falloffDamage(w, dist) * armorMultiplier(w.penetration, u.def.armor) * aspect;
  world.damageUnit(u, u.def.squad && w.squadScale ? raw / w.squadScale : raw, byPlayer);
}

export function explode(world: World, at: Vector3, damage: number, radius: number, penetration: number, byPlayer: boolean, skip?: Unit, squadScale?: number) {
  world.emit({ t: 'explosion', pos: at.clone(), size: radius });
  for (const u of world.units) {
    if (!u.alive || u === skip) continue;
    const dmg = splashDamage(damage, radius, penetration, distanceToUnit(u, at), u.def.armor);
    if (dmg > 0) world.damageUnit(u, u.def.squad && squadScale ? dmg / squadScale : dmg, byPlayer);
  }
}

export function explodeWeapon(world: World, at: Vector3, w: WeaponDef, byPlayer: boolean, skip?: Unit) {
  explode(world, at, w.splashDamage, w.splashRadius, w.penetration, byPlayer, skip, w.squadScale);
}
