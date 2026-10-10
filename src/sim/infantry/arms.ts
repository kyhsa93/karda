import { Vector3 } from 'three';
import classesJson from '../../content/battle/classes.json';
import { PLAYER_OWNER, type Projectile } from '../weapons/projectile';
import { WEAPONS } from '../weapons/damage';
import type { SoldierClass, SoldierState } from './soldier';

export type InfantryWeaponId = 'rifle' | 'carbine' | 'grenade' | 'at_rocket';

export interface InfantryWeaponDef {
  projectile: string; mag: number; reserve: number; rate: number; reload: number;
  spreadHipDeg: number; spreadAdsDeg: number; recoilDeg: number; recoilAdsDeg: number; recoilYawDeg: number;
  bloomMax: number; bloomPerShot: number; auto: boolean;
}

export const INFANTRY_WEAPONS = classesJson.weapons as Record<InfantryWeaponId, InfantryWeaponDef>;
export type ToolId = 'medkit' | 'smoke' | 'repair' | 'mine';
export interface ClassKit { primary: InfantryWeaponId; gear: InfantryWeaponId[]; tools: ToolId[]; gearSlots: number; pending: string[] }
export const CLASS_KITS = classesJson.classes as unknown as Record<SoldierClass, ClassKit>;
export const CLASS_IDS = Object.keys(CLASS_KITS) as SoldierClass[];

export const RECOVERY = 4.1;
export const BLOOM_DECAY = 2;
export const MUZZLE_DROP = 0.08;

export interface Magazine { mag: number; reserve: number }

export interface SoldierArms {
  selected: InfantryWeaponId;
  ammo: Partial<Record<InfantryWeaponId, Magazine>>;
  cooldown: number;
  reloading: number;
  recoilPitch: number;
  recoilYaw: number;
  bloom: number;
  trigger: boolean;
  shots: number;
}

export function createArms(cls: SoldierClass): SoldierArms {
  const kit = CLASS_KITS[cls] ?? CLASS_KITS.assault;
  const ammo: SoldierArms['ammo'] = {};
  for (const id of [kit.primary, ...kit.gear]) ammo[id] = { mag: INFANTRY_WEAPONS[id].mag, reserve: INFANTRY_WEAPONS[id].reserve };
  return { selected: kit.primary, ammo, cooldown: 0, reloading: 0, recoilPitch: 0, recoilYaw: 0, bloom: 1, trigger: false, shots: 0 };
}

export function startReload(a: SoldierArms) {
  const m = a.ammo[a.selected], w = INFANTRY_WEAPONS[a.selected];
  if (!m || a.reloading > 0 || m.reserve <= 0 || m.mag >= w.mag) return false;
  a.reloading = w.reload;
  return true;
}

export function select(a: SoldierArms, id: InfantryWeaponId) {
  if (!a.ammo[id] || a.selected === id) return false;
  a.selected = id;
  a.reloading = 0;
  a.cooldown = 0.3;
  return true;
}

export interface FireContext { rng: () => number; nextId: () => number; ads: boolean; canFire: boolean }

const dir = new Vector3(), right = new Vector3(), up = new Vector3();

export function aimDir(yaw: number, pitch: number, out = new Vector3()) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export function stepArms(s: SoldierState, a: SoldierArms, fire: boolean, eye: Vector3, ctx: FireContext, dt: number): Projectile[] {
  const w = INFANTRY_WEAPONS[a.selected], m = a.ammo[a.selected]!;
  const out: Projectile[] = [];
  a.cooldown = Math.max(0, a.cooldown - dt);
  if (a.reloading > 0) {
    a.reloading -= dt;
    if (a.reloading <= 0) { a.reloading = 0; const take = Math.min(w.mag - m.mag, m.reserve); m.mag += take; m.reserve -= take; }
  }
  const pressed = fire && !a.trigger;
  a.trigger = fire;
  const wants = w.auto ? fire : pressed;
  let fired = false;
  while (wants && ctx.canFire && a.reloading === 0 && a.cooldown <= 0 && m.mag > 0) {
    fired = true;
    m.mag--;
    a.cooldown += 1 / w.rate;
    const spread = ((ctx.ads ? w.spreadAdsDeg : w.spreadHipDeg) * a.bloom * Math.PI) / 180;
    aimDir(s.yaw, s.pitch, dir);
    right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
    up.crossVectors(right, dir).normalize();
    const r = spread * Math.sqrt(ctx.rng()), th = ctx.rng() * Math.PI * 2;
    dir.addScaledVector(right, Math.cos(th) * r).addScaledVector(up, Math.sin(th) * r).normalize();
    const def = WEAPONS[w.projectile];
    const pos = eye.clone().addScaledVector(up, -MUZZLE_DROP);
    out.push({ id: ctx.nextId(), weapon: w.projectile, pos, origin: pos.clone(), vel: dir.clone().multiplyScalar(def.speed).add(s.vel), owner: PLAYER_OWNER, life: (def.maxRange / def.speed) * 3, drag: def.drag ?? 0, tracer: a.shots % 4 === 0 });
    a.shots++;
    a.recoilPitch += ((ctx.ads ? w.recoilAdsDeg : w.recoilDeg) * Math.PI) / 180;
    a.recoilYaw += ((ctx.rng() * 2 - 1) * w.recoilYawDeg * Math.PI) / 180;
    a.bloom = Math.min(w.bloomMax, a.bloom + w.bloomPerShot);
    if (!w.auto) break;
  }
  if (!fired && !(w.auto && fire && m.mag > 0)) {
    const k = Math.exp(-RECOVERY * dt);
    a.recoilPitch *= k; a.recoilYaw *= k;
    a.bloom = Math.max(1, a.bloom - BLOOM_DECAY * dt);
  }
  if (m.mag === 0 && fire && a.reloading === 0) startReload(a);
  return out;
}
