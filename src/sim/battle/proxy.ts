import { Vector3 } from 'three';
import { clamp, wrapPi } from '../../core/math';
import { startService } from '../farp';
import { accelerate } from '../heli/autohover';
import { AIRCRAFT, EYE, GEAR_Y } from '../heli/airframe';
import { STANDARD_LOADOUT } from '../heli/loadout';
import { visualSight } from '../los';
import { aimToward, gunInLimits, type Aim } from '../weapons/arms';
import { hellfireSolution } from '../weapons/hellfire';
import { toWorld } from '../heli/state';
import { unitCenter } from '../sensors/laser';
import type { FlightSession } from '../session';
import type { Unit } from '../units';
import type { World } from '../world';
import type { ControlPoint } from './conquest';
import type { BattleRuntime } from './runtime';
import type { BattleSide } from './schema';

export const PROXY_STANDOFF = 1800;
export const PROXY_SPEED = 28;
export const PROXY_HOLD = 40;
export const PROXY_MIN_STANDOFF = 700;
export const PROXY_SEARCH = 10;
export const PROXY_ALTITUDE = 70;
export const PROXY_ACCEL = 1.5;
export const PROXY_SCAN = 0.5;
export const PROXY_RANGE = 3500;
export const GUN_RANGE = 1400;
export const ROCKET_RANGE = 2200;
export const HELLFIRE_MIN = 900;
export const HELLFIRE_MAX = 4500;
export const GUN_BURST = 1.2;
export const GUN_GAP = 0.6;
export const LOCK_TIME = 25;
export const LASE_TIME = 0.4;
export const RELOAD_GUN = 120;
export const LAND_RADIUS = 6;
export const LOOKAHEAD = 400;
export const LOOK_STEP = 40;
export const PROXY_CLEARANCE = 45;
export const PROXY_CLIMB = 2.5;

type Weapon = 'gun30' | 'hydra70' | 'agm114k';

export class ProxyPilot {
  kills = 0;
  deaths = 0;
  sorties = 0;
  rearms = 0;
  aimErrorMrad = 0;
  private listening = false;
  private standoff = PROXY_STANDOFF;
  private bearing = 0;
  private idle = 0;
  private aimed: string | null = null;
  private enemy: Unit | null = null;
  private weapon: Weapon = 'gun30';
  private scanIn = 0;
  private lockedAt = 0;
  private lased = 0;
  private burst = 0;
  private wobble: Aim = { yaw: 0, pitch: 0 };
  private wobbleIn = 0;
  private landing = false;
  private readonly eye = new Vector3();
  private readonly center = new Vector3();
  private readonly aim: Aim = { yaw: 0, pitch: 0 };

  constructor(readonly runtime: BattleRuntime, readonly side: BattleSide) {}

  step(session: FlightSession, dt: number) {
    const world = session.world;
    if (!this.listening) {
      this.listening = true;
      world.events.on('memberHit', e => { if (e.byPlayer && e.killed) this.kills++; });
      world.events.on('unitDestroyed', e => { if (e.byPlayer && !world.units.find(u => u.id === e.id)?.def.squad) this.kills++; });
      world.events.on('crash', () => { this.deaths++; this.landing = false; this.enemy = null; });
    }
    if (this.runtime.conquest.winner) return;
    if (session.mode === 'deploy') { this.deploy(session); return; }
    const h = world.player;
    if (session.mode !== 'play' || world.avatar.kind !== 'heli' || !h.alive) return;

    const point = this.target();
    if (this.aimed !== point.id) { this.aimed = point.id; this.standoff = PROXY_STANDOFF; this.bearing = 0; this.idle = 0; }
    if (this.enemy) this.idle = 0;
    else if ((this.idle += dt) >= PROXY_SEARCH) {
      this.idle = 0;
      this.standoff = Math.max(PROXY_MIN_STANDOFF, this.standoff - 250);
      this.bearing = this.bearing > 0 ? -this.bearing : -this.bearing + 0.5;
      if (this.standoff === PROXY_MIN_STANDOFF && Math.abs(this.bearing) > 1.5) { this.standoff = PROXY_STANDOFF; this.bearing = 0; }
    }

    const c = world.commands;
    c.fire = false; c.laser = false;
    if (world.arms.selected !== this.weapon && !this.landing) this.chooseWeapon(world);
    if (!this.landing && this.needsService(world)) this.landing = true;
    if (this.landing && !this.needsService(world) && h.landed && !world.farpService) this.landing = false;

    if (this.landing) {
      const pad = world.pads[this.runtime.spawnPoints(world).find(s => s.role === 'heli')!.pad];
      if (h.landed && !world.farpService && this.needsService(world) && startService(world, { repair: true, rearm: STANDARD_LOADOUT })) this.rearms++;
      this.fly(world, [pad.x, pad.z], null, false, pad.y);
      return;
    }

    if ((this.scanIn -= dt) <= 0) { this.scanIn = PROXY_SCAN; this.enemy = this.findEnemy(world); this.pickWeapon(world); }
    const e = this.enemy?.alive ? this.enemy : null;
    if (e && world.time - this.lockedAt > LOCK_TIME) { this.enemy = null; this.scanIn = 0; this.lockedAt = world.time; }
    let goal = this.goal(point), yaw: number | null = null, hold = false;
    if (e) {
      unitCenter(e, this.center);
      const dx = this.center.x - h.pos.x, dz = this.center.z - h.pos.z, range = Math.hypot(dx, dz);
      yaw = Math.atan2(-dx, -dz);
      const want = this.weapon === 'agm114k' ? HELLFIRE_MAX * 0.7 : this.weapon === 'hydra70' ? ROCKET_RANGE * 0.7 : GUN_RANGE * 0.6;
      if (range <= want) hold = true; else goal = [h.pos.x + dx, h.pos.z + dz];
      this.shoot(world, e, dt, Math.abs(wrapPi(yaw - h.yaw)));
    }
    this.fly(world, goal, yaw, hold, null);
  }

  private deploy(session: FlightSession) {
    if (session.deployIn() > 0) return;
    const world = session.world;
    const air = this.runtime.spawnPoints(world).find(s => s.role === 'heli' && s.kind === 'air')!;
    if (session.deploy(this.runtime.spawnFor(air, STANDARD_LOADOUT))) { this.sorties++; this.enemy = null; this.landing = false; this.weapon = 'gun30'; this.burst = 0; }
  }

  private fly(world: World, goal: [number, number], yaw: number | null, hold: boolean, padY: number | null) {
    const h = world.player, ctl = world.controls;
    const dx = goal[0] - h.pos.x, dz = goal[1] - h.pos.z, d = Math.hypot(dx, dz);
    const terrain = world.terrain;
    let ground = terrain.surfaceAt(h.pos.x, h.pos.z), limit = PROXY_SPEED;
    if (d > 1) for (let k = LOOK_STEP; k <= LOOKAHEAD; k += LOOK_STEP) {
      const g = terrain.surfaceAt(h.pos.x + (dx / d) * k, h.pos.z + (dz / d) * k);
      ground = Math.max(ground, g);
      const need = g - GEAR_Y + PROXY_CLEARANCE - h.pos.y;
      if (need > 0) limit = Math.min(limit, Math.max(3, (PROXY_CLIMB * k) / need));
    }
    const speed = hold || d <= (padY === null ? PROXY_HOLD : LAND_RADIUS) ? 0 : Math.min(limit, 0.12 * d);
    const vx = d > 1 ? (dx / d) * speed : 0, vz = d > 1 ? (dz / d) * speed : 0;
    const ax = clamp(0.8 * (vx - h.vel.x), -PROXY_ACCEL, PROXY_ACCEL), az = clamp(0.8 * (vz - h.vel.z), -PROXY_ACCEL, PROXY_ACCEL);
    let ay: number;
    if (padY !== null && d <= LAND_RADIUS * 2 && Math.hypot(h.vel.x, h.vel.z) < 2) ay = h.landed ? -3 : clamp(1.5 * ((h.pos.y + GEAR_Y - padY < 4 ? -0.5 : -1.5) - h.vel.y), -3, 3);
    else if (h.landed) ay = 3;
    else ay = clamp(0.8 * (ground - GEAR_Y + PROXY_ALTITUDE - h.pos.y) - 1.6 * h.vel.y, -3, 3);
    accelerate(h, world, ax, az, ay, ctl);
    const face = yaw ?? (speed > 1 ? Math.atan2(-vx, -vz) : h.yaw);
    ctl.pedal = clamp(-1.5 * wrapPi(face - h.yaw) / AIRCRAFT.yaw.pedalRate, -1, 1);
  }

  private needsService(world: World) {
    const lo = world.loadout, a = world.arms;
    const missiles = lo.rounds.L1 * Number(lo.def.pylons.L1 === 'agm114k') + lo.rounds.R1 * Number(lo.def.pylons.R1 === 'agm114k');
    const rockets = lo.rounds.L2 * Number(lo.def.pylons.L2 === 'hydra70') + lo.rounds.R2 * Number(lo.def.pylons.R2 === 'hydra70');
    return a.gunAmmo < RELOAD_GUN && missiles + rockets === 0;
  }

  private ammo(world: World, weapon: Weapon) {
    const lo = world.loadout;
    if (weapon === 'gun30') return world.arms.gunAmmo;
    const store = weapon === 'hydra70' ? 'hydra70' : 'agm114k';
    return (['L2', 'L1', 'R1', 'R2'] as const).reduce((n, p) => n + (lo.def.pylons[p] === store ? lo.rounds[p] : 0), 0);
  }

  private findEnemy(world: World): Unit | null {
    const h = world.player;
    toWorld(h, EYE, this.eye);
    let best: Unit | null = null, bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u.side === 'civilian') continue;
      const d = Math.hypot(u.pos.x - h.pos.x, u.pos.z - h.pos.z);
      if (d > PROXY_RANGE || d >= bestD) continue;
      if (!visualSight(world.terrain, this.eye, unitCenter(u, this.center)).clear) continue;
      best = u; bestD = d;
    }
    if (best?.id !== this.enemy?.id) { this.lockedAt = world.time; this.lased = 0; }
    return best;
  }

  private pickWeapon(world: World) {
    const e = this.enemy;
    if (!e) { this.weapon = 'gun30'; return; }
    const h = world.player, range = Math.hypot(e.pos.x - h.pos.x, e.pos.z - h.pos.z);
    const heavy = e.def.category === 'tracked' || e.def.category === 'airDefense' || e.def.category === 'vehicle';
    if (heavy && this.ammo(world, 'agm114k') > 0 && range >= HELLFIRE_MIN && range <= HELLFIRE_MAX) this.weapon = 'agm114k';
    else if (range > GUN_RANGE && range <= ROCKET_RANGE && this.ammo(world, 'hydra70') > 0) this.weapon = 'hydra70';
    else if (this.ammo(world, 'gun30') > 0 && range <= GUN_RANGE) this.weapon = 'gun30';
    else if (this.ammo(world, 'hydra70') > 0 && range <= ROCKET_RANGE) this.weapon = 'hydra70';
    else this.weapon = 'gun30';
  }

  private chooseWeapon(world: World) {
    const slot = this.weapon === 'gun30' ? 1 : this.weapon === 'hydra70' ? 2 : 3;
    world.selectWeapon(slot);
  }

  private shoot(world: World, e: Unit, dt: number, off: number) {
    const h = world.player, c = world.commands;
    if ((this.wobbleIn -= dt) <= 0) {
      this.wobbleIn = 0.25;
      const m = this.aimErrorMrad / 1000;
      this.wobble.yaw = (world.playerRng() * 2 - 1) * m; this.wobble.pitch = (world.playerRng() * 2 - 1) * m;
    }
    unitCenter(e, this.center);
    aimToward(h, this.center, this.aim);
    c.aim.yaw = this.aim.yaw + this.wobble.yaw;
    c.aim.pitch = this.aim.pitch + this.wobble.pitch;
    const range = Math.hypot(this.center.x - h.pos.x, this.center.z - h.pos.z);
    c.laser = this.weapon !== 'hydra70';
    if (c.laser) this.lased += dt; else this.lased = 0;
    if (world.arms.selected !== this.weapon || off > 0.2) return;
    if (this.weapon === 'gun30') {
      if (range > GUN_RANGE || !gunInLimits(this.aim)) return;
      this.burst += dt;
      if (this.burst < GUN_BURST) c.fire = true;
      else if (this.burst >= GUN_BURST + GUN_GAP) this.burst = 0;
    } else if (this.weapon === 'hydra70') {
      if (range > ROCKET_RANGE || range < 300 || off > 0.05) return;
      c.fire = world.arms.salvoLeft === 0 && !world.arms.trigger;
    } else {
      if (this.lased < LASE_TIME || world.laser.unitId !== e.id) return;
      c.fire = !world.arms.trigger && world.arms.missileTimer <= 0 && hellfireSolution(world).mode === 'lobl';
    }
  }

  private target(): ControlPoint {
    const c = this.runtime.conquest;
    const base = this.runtime.map.bases.find(b => b.side === this.side)!.position;
    const enemy = this.side === 'coalition' ? 'veros' : 'coalition';
    const ranked = [...c.points].sort((a, b) => {
      const pa = a.owner === this.side ? (a.strength[enemy] > 0 ? 1 : 3) : 0, pb = b.owner === this.side ? (b.strength[enemy] > 0 ? 1 : 3) : 0;
      return pa - pb || Math.hypot(a.x - base[0], a.z - base[1]) - Math.hypot(b.x - base[0], b.z - base[1]);
    });
    return ranked[0];
  }

  private goal(p: ControlPoint): [number, number] {
    const base = this.runtime.map.bases.find(b => b.side === this.side)!.position;
    const a = Math.atan2(base[0] - p.x, base[1] - p.z) + this.bearing;
    return [p.x + Math.sin(a) * this.standoff, p.z + Math.cos(a) * this.standoff];
  }
}
