import { Vector3 } from 'three';
import { DEG } from '../../core/math';
import { castRay } from '../sensors/laser';
import { tadsPosition } from '../sensors/tads';
import type { World } from '../world';
import { PLAYER_OWNER } from './projectile';
import { selectedTarget } from '../sensors/fcr';
import { HELLFIRE, loftHeight, nextLauncher, railPosition, seekerSees, type LaserSpot, type Missile } from './missile';

export const LAUNCH_CONSTRAINT = 30 * DEG;
export const LOAL_CLIMB = 35 * DEG;
export const LOAL_NAV_ERROR = 0.03;
export const LOAL_NAV_ERROR_MIN = 40;

export type HellfireStatus = 'lobl' | 'loal' | 'rf' | 'range' | 'align' | 'empty' | 'noTarget';

export interface HellfireSolution {
  mode: 'lobl' | 'loal' | 'rf' | null;
  status: HellfireStatus;
  range: number | null;
  aim: Vector3 | null;
  spot: LaserSpot | null;
}

function offNose(world: World, p: Vector3) {
  const h = world.player;
  const dx = p.x - h.pos.x, dz = p.z - h.pos.z;
  const bearing = Math.atan2(-dx, -dz);
  let d = bearing - h.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d);
}

function inRange(r: number) {
  return r >= HELLFIRE.minRange && r <= HELLFIRE.maxRange;
}

export function hellfireSolution(world: World): HellfireSolution {
  const h = world.player;
  const pylon = nextLauncher(world.loadout, world.arms.missilesFired);
  const none = (status: HellfireStatus, range: number | null = null, aim: Vector3 | null = null): HellfireSolution => ({ mode: null, status, range, aim, spot: null });
  if (!pylon) return none('empty');
  const rail = railPosition(h, pylon);
  let blocked: HellfireSolution | null = null;
  for (const spot of world.laserSpots()) {
    const range = rail.distanceTo(spot.pos);
    const dir = spot.pos.clone().sub(rail).normalize();
    if (!seekerSees(world.terrain, rail, dir, spot.pos)) continue;
    if (!inRange(range)) { blocked ??= none('range', range, spot.pos); continue; }
    if (offNose(world, spot.pos) > LAUNCH_CONSTRAINT) { blocked ??= none('align', range, spot.pos); continue; }
    return { mode: 'lobl', status: 'lobl', range, aim: spot.pos.clone(), spot };
  }
  if (blocked) return blocked;
  const aim = world.designation()?.clone() ?? castRay(world.terrain, world.units.filter(u => u.alive), tadsPosition(h), world.sensorDirection())?.point ?? null;
  if (!aim) return none('noTarget');
  const range = rail.distanceTo(aim);
  if (!inRange(range)) return none('range', range, aim);
  if (offNose(world, aim) > LAUNCH_CONSTRAINT) return none('align', range, aim);
  return { mode: 'loal', status: 'loal', range, aim, spot: null };
}

export function longbowSolution(world: World): HellfireSolution {
  const none = (status: HellfireStatus, range: number | null = null, aim: Vector3 | null = null): HellfireSolution => ({ mode: null, status, range, aim, spot: null });
  const pylon = nextLauncher(world.loadout, world.arms.missilesFired, 'agm114l');
  if (!pylon) return none('empty');
  const target = selectedTarget(world.fcr);
  if (!target) return none('noTarget');
  const range = railPosition(world.player, pylon).distanceTo(target.pos);
  if (!inRange(range)) return none('range', range, target.pos);
  if (offNose(world, target.pos) > LAUNCH_CONSTRAINT) return none('align', range, target.pos);
  return { mode: 'rf', status: 'rf', range, aim: target.pos.clone(), spot: null };
}

export function launchHellfire(world: World, sol: HellfireSolution, id: number): Missile | null {
  const h = world.player, lo = world.loadout;
  const kind = sol.mode === 'rf' ? 'agm114l' : 'agm114k';
  const pylon = nextLauncher(lo, world.arms.missilesFired, kind);
  if (!pylon || !sol.mode || !sol.aim) return null;
  const pos = railPosition(h, pylon);
  const dir = sol.aim.clone().sub(pos).normalize();
  if (sol.mode === 'loal' || sol.mode === 'rf') {
    const flat = Math.hypot(dir.x, dir.z) || 1;
    dir.set(dir.x / flat * Math.cos(LOAL_CLIMB), Math.sin(LOAL_CLIMB), dir.z / flat * Math.cos(LOAL_CLIMB));
  }
  const aim = sol.aim.clone();
  if (sol.mode === 'loal') {
    const err = Math.max(LOAL_NAV_ERROR_MIN, (sol.range ?? 0) * LOAL_NAV_ERROR) * (0.7 + 0.6 * world.playerRng());
    const a = world.playerRng() * Math.PI * 2;
    aim.x += Math.sin(a) * err; aim.z += Math.cos(a) * err;
    aim.y = world.terrain.surfaceAt(aim.x, aim.z);
  }
  lo.rounds[pylon]--;
  return {
    id, kind, pos, vel: dir.multiplyScalar(HELLFIRE.launchSpeed ?? 60).add(h.vel), owner: PLAYER_OWNER,
    mode: sol.mode, phase: 'boost', age: 0, seekerLocked: sol.mode === 'lobl', aim,
    targetUnit: null,
    apex: sol.mode !== 'lobl'
      ? new Vector3((pos.x + aim.x) / 2, Math.max(pos.y, aim.y) + loftHeight(sol.range ?? 0), (pos.z + aim.z) / 2)
      : null,
  };
}
