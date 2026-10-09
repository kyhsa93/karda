import { Vector3 } from 'three';
import { STANDARD_LOADOUT } from '../heli/loadout';
import { visualSight } from '../los';
import { memberPos } from '../infantry/squad';
import { footWalk } from '../infantry/movement';
import { soldierEye } from '../infantry/soldier';
import type { FlightSession } from '../session';
import type { Unit } from '../units';
import type { World } from '../world';
import type { ControlPoint } from './conquest';
import { FOOT_AHEAD, FOOT_CELL, FootField, type FootBounds } from './footpath';
import type { BattleRuntime } from './runtime';
import type { BattleSide } from './schema';

export type ProxyStance = 'cover' | 'exposed';

export const ENGAGE_RANGE = 300;
export const COVER_SEARCH = 30;
export const COVER_OFFSET = 1.2;
export const SPRINT_OVER = 120;
export const HOLD_RADIUS = 20;
export const STUCK_TIME = 5;
export const BURST = 0.4;
export const BURST_GAP = 0.6;
export const SCAN_EVERY = 0.5;
export const RIFLE_SPEED = 850;
export const STEER_STEPS = 8;
export const STEER_ANGLE = Math.PI / 12;
export const PROBE = 4;
export const FAR_SPAWN = 2000;
export const SPAWN_WAIT = 30;
export const FIELD_MARGIN = 1000;
export const APPROACH = 500;
export const HURT_MEMORY = 15;
export const DUCK_TIME = 4;
export const WOBBLE_EVERY = 0.25;

export interface SkillLevel { aimMrad: number; reactSec: number; scanSec: number }

export const SKILL_LEVELS: readonly SkillLevel[] = [
  { aimMrad: 100, reactSec: 0.8, scanSec: 1.0 },
  { aimMrad: 30, reactSec: 0.5, scanSec: 0.5 },
  { aimMrad: 10, reactSec: 0.3, scanSec: 0.25 },
  { aimMrad: 3, reactSec: 0.15, scanSec: 0.1 },
];

export function skillLevel(level: number): SkillLevel {
  const s = SKILL_LEVELS[level];
  if (!s) throw new Error(`skill level ${level}: expected 0..${SKILL_LEVELS.length - 1}`);
  return s;
}

export class SoldierProxy {
  kills = 0;
  deaths = 0;
  aliveTime = 0;
  lives = 0;
  private listening = false;
  private enemy: Unit | null = null;
  private cover: [number, number] | null = null;
  private scanIn = 0;
  private reactIn = 0;
  private wobbleIn = 0;
  private readonly wobble = { yaw: 0, pitch: 0 };
  private readonly skill: SkillLevel | null;
  private burst = 0;
  private stuckAt: [number, number, number] | null = null;
  private detour = 0;
  private lean = 1;
  private goal: string | null = null;
  private hurtAt = -Infinity;
  private shooter: Unit | null = null;
  private at: [number, number] | null = null;
  private readonly fields = new Map<string, FootField>();
  private waitedFrom: number | null = null;
  private readonly eye = new Vector3();
  private readonly aim = new Vector3();

  constructor(readonly runtime: BattleRuntime, readonly side: BattleSide, readonly stance: ProxyStance = 'cover', readonly level: number | null = null) {
    this.skill = level === null ? null : skillLevel(level);
  }

  step(session: FlightSession, dt: number) {
    const world = session.world;
    if (!this.listening) {
      this.listening = true;
      world.events.on('memberHit', e => { if (e.byPlayer && e.killed) this.kills++; });
      world.events.on('unitDestroyed', e => { if (e.byPlayer && !world.units.find(u => u.id === e.id)?.def.squad) this.kills++; });
      world.events.on('crash', () => { this.deaths++; });
      world.events.on('playerHit', e => { if (world.avatar.kind === 'soldier') { this.hurtAt = world.time; this.shooter = world.units.find(u => u.id === e.by) ?? null; } });
    }
    if (this.runtime.conquest.winner) return;
    if (session.mode === 'deploy') { this.deploy(session); return; }
    const s = world.soldier;
    if (session.mode !== 'play' || world.avatar.kind !== 'soldier' || !s?.alive) return;
    this.aliveTime += dt;
    this.at = [s.pos.x, s.pos.z];
    const c = world.soldierCommands;
    c.forward = 0; c.right = 0; c.sprint = false; c.jump = false; c.fire = false; c.ads = false;
    if ((this.scanIn -= dt) <= 0) {
      this.scanIn = this.skill?.scanSec ?? SCAN_EVERY;
      const seen = this.enemy;
      this.enemy = this.findEnemy(world);
      if (this.enemy && this.enemy !== seen) this.reactIn = this.skill?.reactSec ?? 0;
      if (this.enemy && this.stance === 'cover') this.cover = this.findCover(world, this.enemy);
    }
    if (this.reactIn > 0) this.reactIn -= dt;
    const e = this.enemy?.alive && this.reactIn <= 0 ? this.enemy : null;
    if (e) {
      if (this.cover && Math.hypot(this.cover[0] - s.pos.x, this.cover[1] - s.pos.z) > 1.5) {
        this.walkTo(world, this.cover[0], this.cover[1], false);
        if (s.stance !== 'stand') world.setStance('stand');
        return;
      }
      const want = this.stance === 'cover' ? 'crouch' : 'stand';
      if (s.stance !== want) world.setStance(want);
      this.shoot(world, e, dt);
      return;
    }
    this.cover = null;
    const p = this.target();
    const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
    const careful = this.stance === 'cover' && (d < APPROACH || world.time - this.hurtAt < HURT_MEMORY);
    if (careful && world.time - this.hurtAt < DUCK_TIME && this.shooter) {
      const hide = this.findCover(world, this.shooter);
      if (hide && Math.hypot(hide[0] - s.pos.x, hide[1] - s.pos.z) > 1.5) { if (s.stance !== 'crouch') world.setStance('crouch'); this.walkTo(world, hide[0], hide[1], false); }
      else if (s.stance !== 'prone') world.setStance('prone');
      return;
    }
    if (d > HOLD_RADIUS) {
      const want = careful ? 'crouch' : 'stand';
      if (s.stance !== want) world.setStance(want);
      this.walkTo(world, p.x, p.z, !careful && d > SPRINT_OVER, true);
    } else if (this.stance === 'cover' && s.stance !== 'crouch') world.setStance('crouch');
  }

  private deploy(session: FlightSession) {
    if (session.deployIn() > 0) return;
    const world = session.world;
    const p = this.target();
    const spawns = this.runtime.spawnPoints(world).filter(sp => sp.role === 'soldier');
    const best = spawns.reduce((a, b) => (Math.hypot(b.x - p.x, b.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? b : a));
    if (Math.hypot(best.x - p.x, best.z - p.z) > FAR_SPAWN) {
      this.waitedFrom ??= world.time;
      if (world.time - this.waitedFrom < SPAWN_WAIT) return;
    }
    this.waitedFrom = null;
    if (session.deploy(this.runtime.spawnFor(best, STANDARD_LOADOUT))) { this.lives++; this.enemy = null; this.cover = null; this.stuckAt = null; }
  }

  private walkTo(world: World, x: number, z: number, sprint: boolean, path = false) {
    const s = world.soldier!, c = world.soldierCommands;
    if (!this.stuckAt || world.time - this.stuckAt[2] >= STUCK_TIME) {
      if (this.stuckAt && Math.hypot(s.pos.x - this.stuckAt[0], s.pos.z - this.stuckAt[1]) < 2) this.detour = this.detour > 0 ? -this.detour - 0.6 : -this.detour + 0.6;
      else this.detour = 0;
      this.stuckAt = [s.pos.x, s.pos.z, world.time];
    }
    const f = path ? this.field(world, x, z) : null;
    let via: [number, number] | null = null;
    if (f?.contains(s.pos.x, s.pos.z)) {
      for (let ahead = FOOT_AHEAD; ahead >= 1 && !via; ahead--) {
        const p = f.next(s.pos.x, s.pos.z, ahead);
        if (p && (ahead === 1 || footWalk(world.terrain, s.pos.x, s.pos.z, p[0], p[1]))) via = p;
      }
    }
    if (via && Math.hypot(x - s.pos.x, z - s.pos.z) > FOOT_CELL * FOOT_AHEAD) [x, z] = via;
    const goal = Math.atan2(-(x - s.pos.x), -(z - s.pos.z)) + this.detour;
    const yaw = this.walkable(world, goal);
    c.yaw = yaw; c.pitch = -0.05;
    c.forward = 1;
    c.sprint = sprint && Math.abs(yaw - goal) < 0.3;
  }

  private field(world: World, x: number, z: number) {
    const key = `${Math.round(x / FOOT_CELL)},${Math.round(z / FOOT_CELL)}`;
    let f = this.fields.get(key);
    if (!f) { f = new FootField(world.terrain, x, z, this.bounds()); this.fields.set(key, f); }
    return f;
  }

  private bounds(): FootBounds {
    const ps = this.runtime.conquest.points;
    return {
      minX: Math.min(...ps.map(p => p.x)) - FIELD_MARGIN, maxX: Math.max(...ps.map(p => p.x)) + FIELD_MARGIN,
      minZ: Math.min(...ps.map(p => p.z)) - FIELD_MARGIN, maxZ: Math.max(...ps.map(p => p.z)) + FIELD_MARGIN,
    };
  }

  private walkable(world: World, goal: number) {
    const s = world.soldier!, t = world.terrain;
    for (let k = 0; k <= STEER_STEPS; k++) {
      for (const sign of k === 0 ? [1] : [this.lean, -this.lean]) {
        const yaw = goal + sign * k * STEER_ANGLE;
        const fx = s.pos.x - Math.sin(yaw) * PROBE, fz = s.pos.z - Math.cos(yaw) * PROBE;
        if (footWalk(t, s.pos.x, s.pos.z, fx, fz)) { if (k > 0) this.lean = sign; return yaw; }
      }
    }
    return goal;
  }

  private shoot(world: World, e: Unit, dt: number) {
    const s = world.soldier!, c = world.soldierCommands, a = world.soldierArms;
    this.targetPoint(e, this.aim);
    soldierEye(s, this.eye);
    const dx = this.aim.x - this.eye.x, dy = this.aim.y - this.eye.y, dz = this.aim.z - this.eye.z;
    const h = Math.hypot(dx, dz);
    if (this.skill && (this.wobbleIn -= dt) <= 0) {
      this.wobbleIn = WOBBLE_EVERY;
      const m = this.skill.aimMrad / 1000;
      this.wobble.yaw = (world.playerRng() * 2 - 1) * m; this.wobble.pitch = (world.playerRng() * 2 - 1) * m;
    }
    c.yaw = Math.atan2(-dx, -dz) + this.wobble.yaw;
    c.pitch = Math.atan2(dy, h) + (4.9 * h) / RIFLE_SPEED ** 2 + this.wobble.pitch;
    c.ads = true;
    if (a.selected !== 'rifle') world.selectSoldierWeapon('rifle');
    if (a.ammo.rifle && a.ammo.rifle.mag === 0) world.reloadSoldier();
    this.burst = (this.burst + dt) % (BURST + BURST_GAP);
    c.fire = this.burst < BURST;
  }

  private targetPoint(e: Unit, out: Vector3) {
    const m = e.members?.find(x => x.alive);
    if (m) return memberPos(e, m, out).setY(e.pos.y + 1.2);
    return out.set(e.pos.x, e.pos.y + e.def.size[1] * 0.5, e.pos.z);
  }

  private findEnemy(world: World): Unit | null {
    const s = world.soldier!;
    soldierEye(s, this.eye);
    let best: Unit | null = null, bestD = ENGAGE_RANGE;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u.side === 'civilian' || !u.def.squad) continue;
      const d = Math.hypot(u.pos.x - s.pos.x, u.pos.z - s.pos.z);
      if (d >= bestD) continue;
      if (visualSight(world.terrain, this.eye, this.targetPoint(u, this.aim)).occlusion > 0) continue;
      best = u; bestD = d;
    }
    return best;
  }

  private findCover(world: World, e: Unit): [number, number] | null {
    const s = world.soldier!;
    let best: [number, number] | null = null, bestD = COVER_SEARCH;
    const consider = (x: number, z: number, r: number) => {
      const ex = e.pos.x - x, ez = e.pos.z - z, el = Math.hypot(ex, ez) || 1;
      const cx = x - (ex / el) * (r + COVER_OFFSET), cz = z - (ez / el) * (r + COVER_OFFSET);
      const d = Math.hypot(cx - s.pos.x, cz - s.pos.z);
      if (d < bestD) { bestD = d; best = [cx, cz]; }
    };
    for (const o of world.obstacles) if (o.h >= 0.8) consider(o.x, o.z, Math.max(o.w, o.d) / 2);
    for (const t of world.terrain.trees) if (Math.abs(t.x - s.pos.x) < COVER_SEARCH && Math.abs(t.z - s.pos.z) < COVER_SEARCH) consider(t.x, t.z, 0.6);
    return best;
  }

  private target(): ControlPoint {
    const c = this.runtime.conquest;
    const held = this.goal && c.points.find(p => p.id === this.goal && p.owner !== this.side);
    if (held) return held;
    const from = this.at ?? this.runtime.map.bases.find(b => b.side === this.side)!.position;
    const open = c.points.filter(p => p.owner !== this.side);
    const pool = open.length ? open : c.points;
    const best = pool.reduce((a, b) => (Math.hypot(b.x - from[0], b.z - from[1]) < Math.hypot(a.x - from[0], a.z - from[1]) ? b : a));
    this.goal = open.length ? best.id : null;
    return best;
  }
}
