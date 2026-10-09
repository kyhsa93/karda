import { Vector3 } from 'three';
import { eyeOf } from '../ai/awareness';
import { pairKey } from '../los';
import { squadMembers, type Unit, type UnitWeaponDef } from '../units';
import { armorMultiplier } from '../weapons/damage';
import type { World } from '../world';
import { targetClass, usableWeapons } from './targeting';

export const FIRE_EVENT_RADIUS = 2000;
export const SPLASH_MEMBERS = 2;

export function botFire(w: UnitWeaponDef) {
  const v = w.vsUnits ?? {};
  return { damage: v.damage ?? w.damage, rate: v.rate ?? w.rate, accuracy: v.accuracy ?? w.accuracy ?? 0, penetration: v.penetration ?? w.penetration };
}

export const guided = (w: UnitWeaponDef) => w.kind === 'missileIR' || w.kind === 'missileRadar';

export function hitChance(w: UnitWeaponDef, dist: number, skill = 1) {
  const acc = botFire(w).accuracy;
  const p = guided(w) ? acc : acc * (1 - (dist / w.range) ** 2);
  return Math.max(0, Math.min(1, p * skill));
}

export function manpower(u: Unit) {
  const n = u.def.squad;
  return n ? squadMembers(u) / n : 1;
}

export function hitDamage(w: UnitWeaponDef, target: Unit) {
  const f = botFire(w);
  const raw = f.damage * armorMultiplier(f.penetration, target.def.armor);
  const n = target.def.squad;
  if (!n) return raw;
  return Math.min(raw, (target.def.hp / n) * (w.kind === 'bullet' ? 1 : SPLASH_MEMBERS));
}

const eye = new Vector3(), at = new Vector3(), dir = new Vector3();

export function stepCombat(world: World, dt: number, lethality = 1) {
  const list = world.units, n = list.length, back = (Math.round(world.time * 10) & 1) === 1;
  for (let k = 0; k < n; k++) {
    const u = list[back ? n - 1 - k : k];
    const b = u.battle;
    if (!u.alive || !b?.target || b.target.kind !== 'unit') continue;
    const o = world.unit(b.target.id);
    if (!o || !o.alive) { b.target = null; continue; }
    if (b.aim > 0) { b.aim -= dt; continue; }
    fireAt(world, u, o, dt, lethality);
  }
}

function fireAt(world: World, u: Unit, o: Unit, dt: number, lethality: number) {
  eyeOf(u, eye); eyeOf(o, at);
  if (!world.los.visual(pairKey(u.id, o.id), eye, at, world.time).clear) return;
  const d = Math.hypot(o.pos.x - u.pos.x, o.pos.z - u.pos.z);
  const b = u.battle!;
  const crew = manpower(u);
  const seen = eye.distanceTo(world.player.pos) <= FIRE_EVENT_RADIUS;
  for (const w of usableWeapons(u, targetClass(o.def), d)) {
    let acc = (b.fire[w.id] ?? 0) + botFire(w).rate * crew * dt;
    while (acc >= 1 && o.alive) {
      acc -= 1;
      const hit = world.rng() < hitChance(w, d, (u.skill ?? 1) * lethality);
      if (seen) {
        dir.copy(at);
        if (!hit) dir.add(new Vector3(world.fxRng() - 0.5, world.fxRng() - 0.5, world.fxRng() - 0.5).multiplyScalar(10 + d * 0.02));
        dir.sub(eye).normalize();
        world.emit({ t: 'fire', weapon: w.id, pos: eye.clone(), dir: dir.clone(), owner: u.id, tracer: w.kind === 'bullet' });
      }
      b.firedAt = world.time;
      if (hit) world.damageUnit(o, hitDamage(w, o), false, u.id);
    }
    b.fire[w.id] = acc;
  }
}
