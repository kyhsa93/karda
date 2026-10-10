import { Vector3 } from 'three';
import { EventBus } from '../core/events';
import { rng } from '../core/math';
import type { SimEvent } from './events';
import { BASE_REFUEL_RATE, EYE, GEAR_Y } from './heli/airframe';
import { autoHover, createHold, type Hold } from './heli/autohover';
import { clampToArea, collide, stepFlight } from './heli/flight';
import { createLoadout, grossWeight, hoverCollective, STANDARD_LOADOUT, thrustScale, type Loadout, type LoadoutDef } from './heli/loadout';
import { agl, createHeli, toWorld, updateQ, type Controls, type HeliState } from './heli/state';
import type { Avatar, AvatarSpawn, PlayerBody } from './avatar';
import type { Obstacle } from './obstacles';
import { createMembers, HEADSHOT, MEMBER_LOD, segmentHitsMember, syncMembers, type Member } from './infantry/squad';
import { createSoldier, createSoldierCommands, REGEN_DELAY, REGEN_RATE, SOLDIER_DAMAGE_SCALE, SOLDIER_HP, SOLDIER_RADIUS, type SoldierCommands, type SoldierState, type Stance } from './infantry/soldier';
import { createMotion, setStance, sprinting, stepSoldier, type SoldierMotion } from './infantry/movement';
import { createArms as createSoldierArms, select, startReload, stepArms, type InfantryWeaponId, type SoldierArms } from './infantry/arms';
import { soldierEye } from './infantry/soldier';
import { createGear, placeMedkit, placeMine, stepGear, throwSmoke, type SoldierGear } from './infantry/gear';
import { toggleEngine } from './heli/systems';
import { blastShares, DAMAGED, hitSystem, randomHitPoint, ROTOR_FAIL_SECONDS, systemAt, type SystemId } from './heli/damage';
import type { CrashReason } from './events';
import { AI_TICK, stepAwareness, type Conditions } from './ai/awareness';
import { stepBrains } from './ai/brain';
import { stepAir } from './ai/air';
import { stepSearchlights } from './ai/searchlight';
import { stepService, type FarpService } from './farp';
import { RoadGraph, stepGroups, type GroupState } from './ai/movement';
import { DEFAULT_ASSISTS, type Assists } from './assists';
import { DIFFICULTIES, type Difficulty } from './difficulty';
import { LosCache } from './los';
import { castRay, createLaser, crosshairUnit, identifyRange, unitCenter, DESIGNATION_SECONDS, IDENTIFY_FOV_DEG, IDENTIFY_SECONDS, type Laser } from './sensors/laser';
import { CHAFF_JAM, createCountermeasures, decoyChaff, decoyFlare, FLARE_LIFE, FLARE_PER_DROP, type Countermeasures, type Flare } from './sensors/ase';
import { constrainTads, createTads, lookAngles, tadsDirection, tadsFovDeg, tadsLocal, tadsPosition, type Tads } from './sensors/tads';
import { PAD_R, Terrain, type Pad3, type TerrainOptions } from './terrain';
import { createAiState, hostile, UNIT_DEFS, type Side, type Unit } from './units';
import { aimDirection, createArms, GUN_INTERVAL, gunInLimits, muzzlePosition, SALVOS, type Aim, type Arms, type WeaponId } from './weapons/arms';
import { aspectMultiplier, explode, explodeWeapon, falloffDamage, hitUnit, WEAPONS } from './weapons/damage';
import { integrate, PLAYER_OWNER, segmentHitsTerrain, segmentHitsUnit, type Projectile } from './weapons/projectile';
import { gunAim } from './weapons/ballistics';
import { hellfireSolution, launchHellfire, longbowSolution } from './weapons/hellfire';
import { createFcr, cycleTarget, FCR_SCAN_SECONDS, scanTargets, type Fcr, type FcrMode } from './sensors/fcr';
import { stepEnemyMissile, threatDef, type EnemyMissile } from './weapons/enemyMissile';
import { HELLFIRE, hellfireLaunchers, stepMissile, type LaserSpot, type Missile } from './weapons/missile';
import { createSeeker, launchStinger, seekerTarget, STINGER, stepSeeker, type Aam, type StingerSeeker } from './weapons/stinger';
import { boresight, HYDRA, nextPod, podMuzzle, rocketPods, rocketProjectile, SALVO_INTERVAL } from './weapons/rockets';

export const STEP = 1 / 120;
export const PLAYER_RADIUS = 8;

export const BATTLE_TICK = 0.1;
export const BATTLE_SLOW_TICK = 1;

export interface BattleHooks {
  tick10Hz(world: World, dt: number): void;
  tick1Hz(world: World, dt: number): void;
}

export interface NavTarget { x: number; y: number; z: number; name: string; area?: boolean; raw?: boolean }

export const FX_SALT = 0x5bd1e995;
export const PLAYER_SALT = 0x27d4eb2f;

function streamSeed(seed: number, salt: number) {
  let x = (seed ^ salt) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export class World {
  time = 0;
  readonly rng: () => number;
  readonly fxRng: () => number;
  readonly playerRng: () => number;
  readonly terrain: Terrain;
  player!: HeliState;
  avatar: Avatar = { kind: 'heli' };
  soldier: SoldierState | null = null;
  soldierCommands: SoldierCommands = createSoldierCommands();
  soldierMotion: SoldierMotion = createMotion();
  soldierArms: SoldierArms = createSoldierArms('assault');
  soldierGear: SoldierGear = createGear('assault');
  soldierLastShot = -Infinity;
  soldierHurtAt = -Infinity;
  spotRequest = false;
  private tmpEye = new Vector3();
  private body: PlayerBody = { kind: 'heli', pos: new Vector3(), vel: new Vector3(), alive: false, agl: 0, heat: 1, radius: PLAYER_RADIUS };
  controls: Controls = { cyclicX: 0, cyclicY: 0, pedal: 0, collective: 0 };
  wind = new Vector3();
  target: NavTarget | null = null;
  playerSide: Side = 'coalition';
  active = false;
  readonly events = new EventBus<SimEvent>();
  units: Unit[] = [];
  projectiles: Projectile[] = [];
  missiles: Missile[] = [];
  groups = new Map<string, GroupState>();
  farpService: FarpService | null = null;
  private graph: RoadGraph | null = null;
  enemyMissiles: EnemyMissile[] = [];
  aams: Aam[] = [];
  stinger: StingerSeeker = createSeeker();
  flares: Flare[] = [];
  cm: Countermeasures = createCountermeasures();
  fcr: Fcr = createFcr();
  remoteLasers: { unitId: number; until: number }[] = [];
  arms: Arms = createArms();
  loadoutDef: LoadoutDef = STANDARD_LOADOUT;
  loadout: Loadout = createLoadout(STANDARD_LOADOUT);
  commands = { fire: false, laser: false, aim: { yaw: 0, pitch: 0 } as Aim };
  laser: Laser = createLaser();
  identify: { unitId: number | null; time: number } = { unitId: null, time: 0 };
  assists: Assists = { ...DEFAULT_ASSISTS };
  conditions: Conditions = { night: false, fog: false, playerRadar: false, time: 'day' };
  difficulty: Difficulty = DIFFICULTIES.normal;
  readonly los: LosCache;
  private aiClock = 0;
  battleHooks: BattleHooks | null = null;
  obstacles: Obstacle[] = [];
  retireAfter: number | null = null;
  retired: { id: number; defId: string; side: Side; diedAt: number }[] = [];
  private retireClock = 0;
  private battleClock = 0;
  private battleSlowClock = 0;
  tads: Tads = createTads();
  hold: Hold | null = null;
  private nextUnitId = 1;
  private nextProjectileId = 1;
  private nextMissileId = 1;
  private atBoundary = false;
  private refuelNoted = false;

  constructor(opts: { seed: number; terrain?: TerrainOptions; terrainSeed?: number }) {
    this.rng = rng(opts.seed);
    this.fxRng = rng(streamSeed(opts.seed, FX_SALT));
    this.playerRng = rng(streamSeed(opts.seed, PLAYER_SALT));
    this.terrain = new Terrain(opts.terrainSeed ?? opts.seed, opts.terrain);
    this.los = new LosCache(this.terrain);
    this.events.on('playerHit', e => this.hitPlayer(e.by, e.damage));
    this.resetPlayer();
  }

  get pads() { return this.terrain.pads; }

  playerBody(): PlayerBody {
    const b = this.body, h = this.player, s = this.soldier;
    b.kind = this.avatar.kind;
    if (this.avatar.kind === 'soldier' && s) {
      b.pos = s.pos; b.vel = s.vel; b.alive = s.alive; b.agl = 0; b.radius = SOLDIER_RADIUS; b.heat = 0.7;
      return b;
    }
    b.pos = h.pos;
    b.vel = h.vel;
    b.alive = this.avatar.kind === 'heli' && h.alive;
    b.agl = agl(h, this.terrain);
    b.radius = PLAYER_RADIUS; b.heat = 1;
    return b;
  }

  spawnAvatar(s: AvatarSpawn) {
    if (s.kind === 'soldier') {
      this.soldier = createSoldier(new Vector3(s.x, this.terrain.surfaceAt(s.x, s.z), s.z), -(s.headingDeg * Math.PI) / 180, s.cls);
      this.soldierCommands = createSoldierCommands();
      this.soldierCommands.yaw = this.soldier.yaw;
      this.soldierMotion = createMotion();
      this.soldierArms = createSoldierArms(s.cls);
      const carried = this.soldierGear.mines;
      this.soldierGear = createGear(s.cls);
      this.soldierGear.mines = carried.filter(m => m.until > this.time);
      this.los.smokes = this.soldierGear.clouds;
      this.los.clear();
      this.commands.fire = false;
      this.avatar = { kind: 'soldier' };
      return;
    }
    this.loadoutDef = s.kit;
    this.resetPlayer(s.at === 'pad' ? s.pad : 0);
    const h = this.player;
    if (s.at === 'air') {
      h.pos.set(s.x, this.terrain.surfaceAt(s.x, s.z) - GEAR_Y + s.agl, s.z);
      h.yaw = -(s.headingDeg * Math.PI) / 180;
      h.pitch = h.roll = 0;
      updateQ(h);
      const v = s.speed ?? 0;
      h.vel.set(-Math.sin(h.yaw) * v, 0, -Math.cos(h.yaw) * v);
    }
    if (s.at === 'air' || s.running) { h.engineOn = true; h.rpm = 1; h.landed = s.at === 'pad'; }
    if (s.at === 'air') { h.collective = this.controls.collective = hoverCollective(this.grossWeight); }
    this.avatar = { kind: 'heli' };
  }

  reloadSoldier() {
    if (this.soldier?.alive) startReload(this.soldierArms);
  }

  selectSoldierWeapon(id: InfantryWeaponId) {
    if (this.soldier?.alive) select(this.soldierArms, id);
  }

  placeMedkit() {
    return !!this.soldier?.alive && placeMedkit(this.soldierGear, this.soldier, this.terrain, this.time);
  }

  placeMine() {
    return !!this.soldier?.alive && placeMine(this.soldierGear, this.soldier, this.terrain);
  }

  throwSmoke() {
    const s = this.soldier;
    return !!s?.alive && this.active && throwSmoke(this.soldierGear, s, soldierEye(s, this.tmpEye));
  }

  setStance(next: Stance) {
    if (this.soldier?.alive) setStance(this.soldier, this.soldierMotion, next);
  }

  private stepSoldier(s: SoldierState, dt: number) {
    const c = this.soldierCommands, a = this.soldierArms;
    const out = stepSoldier(s, c, this.soldierMotion, this.terrain, this.units, dt, this.obstacles);
    s.yaw = c.yaw + a.recoilYaw;
    s.pitch = c.pitch + a.recoilPitch;
    const canFire = s.alive && !sprinting(s, c, this.soldierMotion) && this.soldierMotion.stanceTimer === 0 && !this.soldierMotion.vault;
    const shots = stepArms(s, a, c.fire, soldierEye(s, this.tmpEye), { rng: this.playerRng, nextId: () => this.nextProjectileId++, ads: c.ads, canFire }, dt);
    if (shots.length) this.soldierLastShot = this.time;
    if (s.alive && this.time - this.soldierHurtAt >= REGEN_DELAY) s.hp = Math.min(SOLDIER_HP, s.hp + REGEN_RATE * dt);
    for (const p of shots) {
      this.projectiles.push(p);
      this.emit({ t: 'fire', weapon: p.weapon, pos: p.pos.clone(), dir: p.vel.clone().normalize(), owner: PLAYER_OWNER, tracer: p.tracer });
    }
    s.yaw = c.yaw + a.recoilYaw;
    s.pitch = c.pitch + a.recoilPitch;
    if (out?.t === 'runOver') this.killPlayer('killed');
    else if (out?.t === 'fall') {
      s.hp = Math.max(0, s.hp - out.damage);
      if (s.hp === 0) this.killPlayer('fall');
    }
  }

  damageSoldier(amount: number) {
    const s = this.soldier;
    if (!s || !s.alive || amount <= 0) return;
    s.hp = Math.max(0, s.hp - amount);
    this.soldierHurtAt = this.time;
    if (s.hp === 0) this.killPlayer('killed');
  }

  killAvatar() {
    this.avatar = { kind: 'dead' };
    this.commands.fire = false;
  }

  resetPlayer(padIndex = 0) {
    const pad = this.pads[padIndex];
    this.player = createHeli(new Vector3(pad.x, pad.y - GEAR_Y, pad.z), this.rng() * Math.PI * 2);
    this.controls = { cyclicX: 0, cyclicY: 0, pedal: 0, collective: 0 };
    this.atBoundary = false;
    this.refuelNoted = false;
    this.applyLoadout(this.loadoutDef);
    this.commands = { fire: false, laser: false, aim: { yaw: 0, pitch: 0 } };
    this.laser = createLaser();
    this.identify = { unitId: null, time: 0 };
    this.tads = createTads();
    this.hold = null;
    this.farpService = null;
    this.flares = [];
    this.cm = { ...createCountermeasures(), chaffUnlocked: this.cm.chaffUnlocked };
    this.fcr = { ...createFcr(), unlocked: this.fcr.unlocked, mode: this.fcr.mode };
    this.conditions.playerRadar = false;
  }

  rearm(def: LoadoutDef) {
    this.loadoutDef = def;
    this.loadout = createLoadout(def);
    this.arms = { ...createArms(def.gunRounds), selected: this.availableWeaponsFor(def).includes(this.arms.selected) ? this.arms.selected : 'gun30' };
    this.updateWeight();
  }

  private availableWeaponsFor(def: LoadoutDef) {
    const list = ['gun30'];
    if (Object.values(def.pylons).includes('hydra70')) list.push('hydra70');
    if (Object.values(def.pylons).includes('agm114k')) list.push('agm114k');
    if (Object.values(def.pylons).includes('agm114l')) list.push('agm114l');
    if (def.stingers) list.push('stinger');
    return list;
  }

  applyLoadout(def: LoadoutDef) {
    this.loadoutDef = def;
    this.loadout = createLoadout(def);
    this.arms = createArms(def.gunRounds);
    this.player.fuel = def.fuel;
    this.updateWeight();
  }

  get grossWeight() {
    return grossWeight(this.loadout, this.player.fuel, this.arms.gunAmmo);
  }

  updateWeight() {
    this.player.thrustScale = thrustScale(this.grossWeight);
  }

  emit = (e: SimEvent) => { this.events.emit(e); };

  toggleEngine() {
    if (this.active) toggleEngine(this.player, this.emit);
  }

  padUnder(): number {
    const h = this.player;
    return this.pads.findIndex(p => Math.hypot(p.x - h.pos.x, p.z - h.pos.z) < PAD_R && Math.abs(h.pos.y + GEAR_Y - p.y) < 1);
  }

  padAt(i: number): Pad3 | undefined { return this.pads[i]; }

  spawnUnit(defId: string, x: number, z: number, yaw = 0, opts: { missionId?: string; group?: string; passive?: boolean; skill?: number; aam?: boolean } = {}): Unit {
    const def = UNIT_DEFS[defId];
    if (!def) throw new Error(`unknown unit ${defId}`);
    const y = def.move?.air ? this.terrain.surfaceAt(x, z) + 60 : this.terrain.surfaceAt(x, z);
    const u: Unit = {
      id: this.nextUnitId++, defId, def, side: def.side, missionId: opts.missionId, group: opts.group,
      pos: new Vector3(x, y, z), yaw, vel: new Vector3(), hp: def.hp, alive: true,
      ai: createAiState(), weaponCooldown: 0, identified: false, passive: opts.passive, skill: opts.skill, aam: opts.aam,
    };
    if (def.squad) u.members = createMembers(u);
    this.units.push(u);
    return u;
  }

  availableWeapons(): WeaponId[] {
    const list: WeaponId[] = ['gun30'];
    if (rocketPods(this.loadout).length) list.push('hydra70');
    if (hellfireLaunchers(this.loadout).length) list.push('agm114k');
    if (hellfireLaunchers(this.loadout, 'agm114l').length) list.push('agm114l');
    if (this.loadout.def.stingers) list.push('stinger');
    return list;
  }

  selectWeapon(slot: 1 | 2 | 3 | 4) {
    const a = this.arms;
    if (slot === 1) this.setWeapon('gun30');
    else if (slot === 2 && this.availableWeapons().includes('hydra70')) {
      if (a.selected === 'hydra70') a.salvo = SALVOS[(SALVOS.indexOf(a.salvo) + 1) % SALVOS.length];
      else this.setWeapon('hydra70');
    } else if (slot === 3) {
      const missiles = this.availableWeapons().filter(w => w === 'agm114k' || w === 'agm114l');
      if (missiles.length) this.setWeapon(missiles[(missiles.indexOf(a.selected as 'agm114k') + 1) % missiles.length]);
    } else if (slot === 4 && this.availableWeapons().includes('stinger')) this.setWeapon('stinger');
  }

  fcrScan(): boolean {
    const f = this.fcr, h = this.player;
    if (!this.active || !h.alive || !f.unlocked || f.scanning || h.damage.sensors <= 0) return false;
    f.scanning = true;
    f.scanT = 0;
    this.conditions.playerRadar = true;
    this.emit({ t: 'fcr', state: 'scan', mode: f.mode, count: 0 });
    return true;
  }

  setFcrMode(mode?: FcrMode) {
    const f = this.fcr;
    if (!f.unlocked || f.scanning) return;
    f.mode = mode ?? (f.mode === 'ground' ? 'air' : 'ground');
    this.emit({ t: 'fcr', state: 'mode', mode: f.mode, count: f.targets.length });
  }

  nextFcrTarget() {
    cycleTarget(this.fcr);
  }

  private stepFcr(dt: number) {
    const f = this.fcr, h = this.player;
    if (!f.scanning) return;
    if (!h.alive || h.damage.sensors <= 0) { f.scanning = false; this.conditions.playerRadar = false; return; }
    f.scanT += dt;
    if (f.scanT < FCR_SCAN_SECONDS - 1e-9) return;
    f.scanning = false;
    f.scans++;
    this.conditions.playerRadar = false;
    f.targets = scanTargets(this.terrain, h, this.units, f.mode, this.time);
    f.selected = 0;
    this.emit({ t: 'fcr', state: 'done', mode: f.mode, count: f.targets.length });
  }

  nextWeapon(step: 1 | -1 = 1) {
    const list = this.availableWeapons();
    this.setWeapon(list[(list.indexOf(this.arms.selected) + step + list.length) % list.length]);
  }

  private setWeapon(id: WeaponId) {
    if (this.arms.selected === id) return;
    this.arms.selected = id;
    this.arms.salvoLeft = 0;
    this.stinger = createSeeker();
  }

  toggleTads() {
    if (!this.active || (!this.tads.active && this.player.damage.sensors <= 0)) return;
    this.tads.active = !this.tads.active;
    if (this.tads.active) lookAngles(aimDirection(this.player, this.commands.aim), this.tads);
    this.hold = this.tads.active ? createHold(this.player) : null;
  }

  remoteLaser(unitId: number, seconds: number) {
    this.remoteLasers = this.remoteLasers.filter(r => r.unitId !== unitId);
    this.remoteLasers.push({ unitId, until: this.time + seconds });
  }

  laserSpots(): LaserSpot[] {
    const spots: LaserSpot[] = [];
    if (this.laser.on && this.laser.point) spots.push({ pos: this.laser.point, source: 'player' });
    for (const r of this.remoteLasers) {
      const u = this.unit(r.unitId);
      if (u?.alive && this.time <= r.until) spots.push({ pos: unitCenter(u), source: 'remote' });
    }
    return spots;
  }

  hitPlayer(byUnit: number, amount: number) {
    if (this.avatar.kind === 'soldier') { this.damageSoldier(amount * SOLDIER_DAMAGE_SCALE); return; }
    if (this.avatar.kind !== 'heli') return;
    const h = this.player;
    if (!h.alive || amount <= 0) return;
    const u = this.unit(byUnit);
    const from = u ? u.pos.clone().sub(h.pos).applyQuaternion(h.q.clone().invert()) : new Vector3(1, 0, 0);
    this.damageSystem(systemAt(randomHitPoint(this.playerRng, from)), amount);
  }

  blastPlayer(at: Vector3, amount: number) {
    const h = this.player;
    if (!h.alive) return;
    const local = at.clone().sub(h.pos).applyQuaternion(h.q.clone().invert());
    for (const [id, share] of blastShares(local, amount)) if (share > 0) this.damageSystem(id, share);
  }

  damageSystem(id: SystemId, amount: number) {
    const h = this.player, d = h.damage;
    if (!h.alive) return;
    const before = hitSystem(d, id, amount * this.difficulty.damageTaken);
    const now = d[id];
    if (before > 0 && now <= 0) this.emit({ t: 'systemDamaged', system: id, level: 'destroyed' });
    else if (before > DAMAGED && now <= DAMAGED) this.emit({ t: 'systemDamaged', system: id, level: 'damaged' });
    if (now > 0) return;
    if ((id === 'engine1' || id === 'engine2') && d.engine1 <= 0 && d.engine2 <= 0 && h.engineOn) {
      h.engineOn = false;
      this.emit({ t: 'engine', on: false, cause: 'damage' });
    } else if (id === 'rotor' && h.rotorFailIn === null) h.rotorFailIn = ROTOR_FAIL_SECONDS;
    else if (id === 'sensors' && this.tads.active) { this.tads.active = false; this.hold = null; }
    else if (id === 'cockpit') this.killPlayer('crewKilled');
  }

  killPlayer(reason: CrashReason) {
    if (this.avatar.kind === 'soldier' && this.soldier) {
      if (!this.soldier.alive) return;
      this.soldier.alive = false; this.soldier.hp = 0;
      this.emit({ t: 'crash', reason });
      return;
    }
    const h = this.player;
    if (!h.alive) return;
    h.alive = false; h.engineOn = false;
    this.emit({ t: 'crash', reason });
  }

  private stepRotorFailure(dt: number) {
    const h = this.player;
    if (h.rotorFailIn === null || h.rotorFailIn <= 0 || !h.alive) return;
    h.rotorFailIn = Math.max(0, h.rotorFailIn - dt);
    if (h.rotorFailIn > 0) return;
    if (!h.landed) this.killPlayer('rotorLoss');
    else { h.engineOn = false; h.rpm = 0; }
  }

  get roads() {
    this.graph ??= new RoadGraph(this.terrain.roads);
    return this.graph;
  }

  clearCombat() {
    this.groups.clear();
    this.los.clear();
    this.aiClock = 0;
    this.battleClock = 0;
    this.battleSlowClock = 0;
    this.units = [];
    this.retired = [];
    this.retireClock = 0;
    this.projectiles = [];
    this.missiles = [];
    this.enemyMissiles = [];
    this.aams = [];
    this.flares = [];
    this.remoteLasers = [];
  }

  huntsPlayer(u: Unit) {
    return hostile(u.side, this.playerSide);
  }

  unit(id: number) {
    return this.units.find(u => u.id === id);
  }

  damageMember(u: Unit, m: Member, amount: number, byPlayer: boolean) {
    if (!u.alive || !m.alive || amount <= 0) return;
    const take = Math.min(m.hp, amount);
    m.hp -= take;
    if (m.hp <= 1e-9) { m.hp = 0; m.alive = false; }
    this.emit({ t: 'memberHit', unit: u.id, killed: !m.alive, byPlayer });
    this.damageUnit(u, take, byPlayer);
  }

  damageUnit(u: Unit, amount: number, byPlayer: boolean, by?: number) {
    if (!u.alive || u.def.indestructible || amount <= 0) return;
    u.hp = Math.max(0, u.hp - amount);
    syncMembers(u);
    if (u.hp === 0) {
      u.alive = false;
      u.diedAt = this.time;
      if (!u.def.move?.air) u.vel.set(0, 0, 0);
      this.emit({ t: 'unitDestroyed', id: u.id, defId: u.defId, side: u.side, byPlayer, by });
      const sec = u.def.secondaryExplosion;
      if (sec) {
        explode(this, u.pos.clone().setY(u.pos.y + u.def.size[1] / 2), sec.damage, sec.radius, WEAPONS.secondary.penetration, byPlayer, u);
        if (sec.chain) {
          for (const o of this.units) {
            if (o.alive && o.def.secondaryExplosion?.chain && o.pos.distanceTo(u.pos) <= sec.radius) this.damageUnit(o, o.hp, byPlayer);
          }
        }
      }
    }
  }

  step(dt: number) {
    this.time += dt;
    const wa = this.time * 0.013;
    const ws = 4 + 2.5 * Math.sin(this.time * 0.05) + 1.5 * Math.sin(this.time * 0.37);
    this.wind.set(Math.cos(wa) * ws, 0, Math.sin(wa) * ws);

    const h = this.player;
    if (this.active && this.avatar.kind === 'soldier' && this.soldier?.alive) this.stepSoldier(this.soldier, dt);
    if (this.active) {
      const gear = this.soldierGear;
      stepGear(gear, { now: this.time, dt, terrain: this.terrain, units: this.units, playerSide: this.playerSide, soldier: this.avatar.kind === 'soldier' ? this.soldier : null, repair: this.soldierCommands.repair, playerDead: this.avatar.kind === 'soldier' && !!this.soldier && !this.soldier.alive, world: this });
      if (gear.dirty) { gear.dirty = false; this.los.clear(); }
    }
    if (this.active && this.avatar.kind === 'heli' && h.alive) {
      this.updateWeight();
      this.stepRotorFailure(dt);
      if (this.hold && !h.landed) autoHover(h, this.hold, this, dt, this.controls);
      else if (this.hold) this.hold = createHold(h);
      const phase = stepFlight(h, this.controls, this, dt, this.emit);
      if (phase === 'ground') this.onGround(dt);
      else {
        const hit = clampToArea(h, this.terrain.half);
        if (hit && !this.atBoundary) this.emit({ t: 'boundary' });
        this.atBoundary = hit;
        const wasLanded = h.landed;
        collide(h, this.terrain, this.emit);
        if (h.landed && !wasLanded) this.refuelNoted = false;
      }
      stepService(this, dt);
      if (!this.tads.active) lookAngles(aimDirection(h, this.commands.aim), this.tads);
      else {
        constrainTads(h, this.tads);
        const l = tadsLocal(h, this.tads);
        this.commands.aim.yaw = l.az; this.commands.aim.pitch = l.el;
      }
      if (this.conditions.time === 'night') this.tads.sensor = 'flir';
      this.stepSensors(dt);
      this.stepFcr(dt);
      const pressed = this.commands.fire && !this.arms.trigger;
      this.arms.trigger = this.commands.fire;
      this.stepGun(dt);
      this.stepRockets(dt, pressed);
      this.stepHellfire(dt, pressed);
      this.stepStinger(dt, pressed);
    }
    if (this.active) { stepGroups(this, this.groups.values(), dt); stepAir(this, dt); stepSearchlights(this, dt); }
    this.stepProjectiles(dt);
    this.stepMissiles(dt);
    this.stepEnemyMissiles(dt);
    this.stepAams(dt);
    this.stepCountermeasures(dt);
    if (this.active) {
      this.aiClock += dt;
      while (this.aiClock >= AI_TICK - 1e-9) { this.aiClock -= AI_TICK; stepAwareness(this, this.los, this.conditions); stepBrains(this); }
    }
    if (this.battleHooks) this.stepBattle(this.battleHooks, dt);
    if (this.retireAfter !== null) this.stepRetire(dt, this.retireAfter);
    this.events.flush();
  }

  private stepRetire(dt: number, after: number) {
    this.retireClock += dt;
    if (this.retireClock < 1 - 1e-9) return;
    this.retireClock -= 1;
    if (!this.units.some(u => !u.alive && u.diedAt !== undefined && this.time - u.diedAt >= after)) return;
    this.units = this.units.filter(u => {
      if (u.alive || u.diedAt === undefined || this.time - u.diedAt < after) return true;
      this.retired.push({ id: u.id, defId: u.defId, side: u.side, diedAt: u.diedAt });
      return false;
    });
  }

  private stepBattle(hooks: BattleHooks, dt: number) {
    this.battleClock += dt;
    while (this.battleClock >= BATTLE_TICK - 1e-9) { this.battleClock -= BATTLE_TICK; hooks.tick10Hz(this, BATTLE_TICK); }
    this.battleSlowClock += dt;
    while (this.battleSlowClock >= BATTLE_SLOW_TICK - 1e-9) { this.battleSlowClock -= BATTLE_SLOW_TICK; hooks.tick1Hz(this, BATTLE_SLOW_TICK); }
  }

  private stepGun(dt: number) {
    const a = this.arms, h = this.player;
    a.gunTimer = Math.max(0, a.gunTimer - dt);
    if (!this.commands.fire || a.selected !== 'gun30' || !h.alive) return;
    const aim = gunAim(this);
    if (!gunInLimits(aim)) return;
    const w = WEAPONS.gun30;
    while (a.gunTimer <= 0 && a.gunAmmo > 0) {
      const dir = aimDirection(h, aim);
      this.disperse(dir, w.dispersionMrad ?? 0);
      const pos = muzzlePosition(h);
      const tracer = a.shots % 5 === 0;
      this.projectiles.push({
        id: this.nextProjectileId++, weapon: 'gun30', pos, origin: pos.clone(), vel: dir.clone().multiplyScalar(w.speed).add(h.vel),
        owner: PLAYER_OWNER, life: (w.maxRange / w.speed) * 3, drag: w.drag ?? 0, tracer,
      });
      this.emit({ t: 'fire', weapon: 'gun30', pos: pos.clone(), dir: dir.clone(), owner: PLAYER_OWNER, tracer });
      a.gunAmmo--;
      a.shots++;
      a.gunTimer += GUN_INTERVAL;
    }
  }

  designation(): Vector3 | null {
    const l = this.laser;
    return l.designation && this.time - l.designatedAt <= DESIGNATION_SECONDS ? l.designation : null;
  }

  sensorDirection(out = new Vector3()) {
    return this.tads.active ? tadsDirection(this.tads, out) : aimDirection(this.player, this.commands.aim, out);
  }

  private stepSensors(dt: number) {
    const h = this.player, l = this.laser;
    const origin = tadsPosition(h), dir = this.sensorDirection();
    l.on = this.commands.laser && h.alive && h.damage.sensors > 0;
    if (l.on) {
      const hit = castRay(this.terrain, this.units.filter(u => u.alive), origin, dir);
      l.range = hit?.range ?? null;
      l.point = hit?.point ?? null;
      l.unitId = hit?.unit?.id ?? null;
      if (hit) { l.designation = hit.point.clone(); l.designatedAt = this.time; }
    } else {
      l.range = null; l.point = null; l.unitId = null;
    }

    const id = this.identify;
    const fov = tadsFovDeg(this.tads);
    const auto = this.assists.autoIdentify;
    const u = this.tads.active && (auto || fov <= IDENTIFY_FOV_DEG) ? crosshairUnit(this.terrain, this.units, origin, dir, fov, identifyRange(this.conditions.fog, this.tads.sensor)) : null;
    if (!u) { id.unitId = null; id.time = 0; return; }
    if (id.unitId !== u.id) { id.unitId = u.id; id.time = 0; }
    id.time += dt;
    if (!u.identified && (auto || id.time >= IDENTIFY_SECONDS)) {
      u.identified = true;
      this.emit({ t: 'identified', id: u.id, defId: u.defId, side: u.side });
    }
  }

  private disperse(dir: Vector3, mrad: number) {
    const h = this.player;
    const spread = mrad / 1000 * (Math.hypot(h.vel.x, h.vel.z) > 10.3 ? 1.5 : 1);
    const ang = this.playerRng() * Math.PI * 2, rad = Math.sqrt(this.playerRng()) * spread;
    const side = new Vector3(0, 1, 0).cross(dir).normalize();
    const up = dir.clone().cross(side).normalize();
    return dir.addScaledVector(side, Math.cos(ang) * rad).addScaledVector(up, Math.sin(ang) * rad).normalize();
  }

  private stepRockets(dt: number, pressed: boolean) {
    const a = this.arms, h = this.player;
    a.rocketTimer = Math.max(0, a.rocketTimer - dt);
    if (a.selected !== 'hydra70' || !h.alive) { a.salvoLeft = 0; return; }
    if (pressed && a.salvoLeft === 0) a.salvoLeft = a.salvo;
    while (a.salvoLeft > 0 && a.rocketTimer <= 1e-9) {
      const pod = nextPod(this.loadout, a.rocketsFired);
      if (!pod) { a.salvoLeft = 0; break; }
      const dir = this.disperse(boresight(h), HYDRA.dispersionMrad ?? 0);
      const pos = podMuzzle(h, pod);
      this.projectiles.push({ id: this.nextProjectileId++, owner: PLAYER_OWNER, ...rocketProjectile(h, pos, dir) });
      this.emit({ t: 'fire', weapon: 'hydra70', pos: pos.clone(), dir: dir.clone(), owner: PLAYER_OWNER, tracer: true });
      this.loadout.rounds[pod]--;
      a.rocketsFired++;
      a.salvoLeft--;
      a.rocketTimer += SALVO_INTERVAL;
    }
  }

  private stepHellfire(dt: number, pressed: boolean) {
    const a = this.arms;
    a.missileTimer = Math.max(0, a.missileTimer - dt);
    if (!pressed || (a.selected !== 'agm114k' && a.selected !== 'agm114l') || a.missileTimer > 1e-9 || !this.player.alive) return;
    const sol = a.selected === 'agm114l' ? longbowSolution(this) : hellfireSolution(this);
    if (!sol.mode) return;
    const m = launchHellfire(this, sol, this.nextMissileId++);
    if (!m) return;
    this.missiles.push(m);
    a.missilesFired++;
    a.missileTimer = HELLFIRE.minInterval ?? 0.8;
    this.emit({ t: 'fire', weapon: m.kind, pos: m.pos.clone(), dir: m.vel.clone().normalize(), owner: PLAYER_OWNER, tracer: false });
  }

  private stepStinger(dt: number, pressed: boolean) {
    const a = this.arms, h = this.player, lo = this.loadout;
    if (a.selected !== 'stinger' || !h.alive || lo.stingerRounds <= 0) { stepSeeker(this.stinger, null, dt); return; }
    const eye = toWorld(h, EYE, new Vector3());
    stepSeeker(this.stinger, seekerTarget(this.terrain, eye, aimDirection(h, this.commands.aim), this.units), dt);
    if (!pressed || !this.stinger.locked || a.missileTimer > 1e-9) return;
    const target = this.unit(this.stinger.unitId!);
    if (!target) return;
    const m = launchStinger(h, target, a.stingersFired, this.nextMissileId++, PLAYER_OWNER);
    this.aams.push(m);
    lo.stingerRounds--;
    a.stingersFired++;
    a.missileTimer = STINGER.minInterval ?? 1;
    this.stinger = createSeeker();
    this.emit({ t: 'fire', weapon: 'stinger', pos: m.pos.clone(), dir: m.vel.clone().normalize(), owner: PLAYER_OWNER, tracer: false });
  }

  private stepAams(dt: number) {
    const list = this.aams, c = new Vector3();
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const u = this.unit(m.targetUnit);
      if (u?.alive) unitCenter(u, c); else c.copy(m.pos).addScaledVector(m.vel, 10);
      const r = stepEnemyMissile(m, this.terrain, c, u?.alive ? u.vel : m.vel, dt);
      if (r.detonate && u?.alive) {
        const w = WEAPONS[m.weapon];
        this.emit({ t: 'impact', weapon: m.weapon, pos: m.pos.clone(), unit: u.id, ground: false, missile: m.id });
        hitUnit(this, u, w, true);
        explodeWeapon(this, m.pos, w, true, u);
      }
      if (r.detonate || r.miss) { this.emit({ t: 'missileEnd', id: m.id, hit: r.detonate }); list[i] = list[list.length - 1]; list.pop(); }
    }
  }

  private stepMissiles(dt: number) {
    const list = this.missiles, spots = this.laserSpots();
    const maxFlight = HELLFIRE.maxFlight ?? 30;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const a = m.pos.clone();
      const before = m.phase, locked = m.seekerLocked;
      stepMissile(m, this.terrain, spots, dt, this.units);
      if (before !== 'lost' && m.phase === 'lost') this.emit({ t: 'missileLost', id: m.id, owner: m.owner, reason: locked ? 'spotLost' : 'noLock' });
      const b = m.pos;
      let bestT = Infinity, bestUnit: Unit | null = null;
      for (const u of this.units) {
        if (!u.alive) continue;
        const k = segmentHitsUnit(a, b, u);
        if (k !== null && k < bestT) { bestT = k; bestUnit = u; }
      }
      const tg = segmentHitsTerrain(a, b, this.terrain);
      const w = WEAPONS[m.kind], byPlayer = m.owner === PLAYER_OWNER;
      let done = m.age > maxFlight;
      if (bestUnit && (tg === null || bestT <= tg)) {
        const at = a.clone().lerp(b, bestT);
        this.emit({ t: 'impact', weapon: m.kind, pos: at, unit: bestUnit.id, ground: false, missile: m.id });
        hitUnit(this, bestUnit, w, byPlayer);
        explodeWeapon(this, at, w, byPlayer, bestUnit);
        done = true;
      } else if (tg !== null) {
        const at = a.clone().lerp(b, tg);
        explodeWeapon(this, at, w, byPlayer);
        this.emit({ t: 'impact', weapon: m.kind, pos: at, ground: true, missile: m.id });
        done = true;
      }
      if (done) { list[i] = list[list.length - 1]; list.pop(); }
    }
  }

  launchEnemyMissile(u: Unit, weapon: string): EnemyMissile {
    const w = threatDef(weapon);
    const from = new Vector3(u.pos.x, u.pos.y + u.def.size[1] + 1, u.pos.z);
    const dir = this.player.pos.clone().sub(from).normalize();
    dir.y = Math.max(dir.y, 0.15);
    dir.normalize();
    const m: EnemyMissile = {
      id: this.nextMissileId++, weapon, kind: w.guidance === 'radar' ? 'radar' : 'ir', owner: u.id,
      pos: from.clone(), vel: dir.multiplyScalar(40), age: 0, guiding: true, blind: 0, launcher: from.clone(), target: null,
    };
    this.enemyMissiles.push(m);
    this.emit({ t: 'missileWarning', id: m.id, kind: m.kind, from: from.clone(), owner: u.id });
    this.emit({ t: 'fire', weapon, pos: from.clone(), dir: m.vel.clone().normalize(), owner: u.id, tracer: false });
    return m;
  }

  dropFlare(auto = false) {
    const h = this.player, cm = this.cm;
    if (!h.alive || !this.active || cm.flares < FLARE_PER_DROP) return false;
    cm.flares -= FLARE_PER_DROP;
    let decoyed = 0;
    const fresh: Flare[] = [];
    for (let i = 0; i < FLARE_PER_DROP; i++) {
      const side = i % 2 ? 1 : -1;
      const vel = new Vector3(side * 12, -4, 18).applyQuaternion(h.q).add(h.vel);
      const f = { pos: h.pos.clone().add(new Vector3(side * 1.5, -1, 2).applyQuaternion(h.q)), vel, life: FLARE_LIFE };
      fresh.push(f);
      this.flares.push(f);
    }
    for (const m of this.enemyMissiles) if (decoyFlare(this, m, fresh[decoyed % fresh.length])) decoyed++;
    this.emit({ t: 'countermeasure', kind: 'flare', decoyed, auto });
    return true;
  }

  dropChaff(auto = false) {
    const h = this.player, cm = this.cm;
    if (!h.alive || !this.active || !cm.chaffUnlocked || cm.chaff < 1) return false;
    cm.chaff--;
    let decoyed = 0;
    for (const m of this.enemyMissiles) if (decoyChaff(this, m)) decoyed++;
    for (const u of this.units) if (u.alive && u.def.radar && (u.ai.radar === 'track' || u.ai.radar === 'acquire')) u.ai.jammed = CHAFF_JAM;
    this.emit({ t: 'countermeasure', kind: 'chaff', decoyed, auto });
    return true;
  }

  private stepCountermeasures(dt: number) {
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life -= dt;
      f.vel.y -= 9.81 * dt;
      f.vel.multiplyScalar(1 - 0.4 * dt);
      f.pos.addScaledVector(f.vel, dt);
      if (f.life <= 0) this.flares.splice(i, 1);
    }
    for (const m of this.enemyMissiles) if (m.target && !this.flares.some(f => f.pos === m.target)) { m.target = null; m.guiding = false; }
    const cm = this.cm;
    if (!this.assists.autoCountermeasures) return;
    for (const m of this.enemyMissiles) {
      if (cm.handled.has(m.id) || !m.guiding || m.target) continue;
      cm.handled.add(m.id);
      if (m.kind === 'ir') this.dropFlare(true); else this.dropChaff(true);
    }
  }

  private stepEnemyMissiles(dt: number) {
    const list = this.enemyMissiles, h = this.player;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const r = stepEnemyMissile(m, this.terrain, h.pos, h.vel, dt);
      if (!r.detonate && !r.miss) continue;
      const w = threatDef(m.weapon);
      if (r.detonate && h.alive) this.blastPlayer(m.pos, w.damage);
      this.emit({ t: 'explosion', pos: m.pos.clone(), size: r.detonate ? 6 : 4 });
      this.emit({ t: 'missileEnd', id: m.id, hit: r.detonate });
      list[i] = list[list.length - 1]; list.pop();
    }
  }

  private stepProjectiles(dt: number) {
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const a = integrate(p, dt).clone();
      const b = p.pos;
      let bestT = Infinity, bestUnit: Unit | null = null, bestMember: { member: Member; head: boolean } | null = null;
      const me = this.playerBody().pos;
      for (const u of this.units) {
        if (!u.alive) continue;
        if (u.members && p.owner === PLAYER_OWNER && Math.hypot(u.pos.x - me.x, u.pos.z - me.z) <= MEMBER_LOD) {
          const hit = segmentHitsMember(a, b, u);
          if (hit && hit.t < bestT) { bestT = hit.t; bestUnit = u; bestMember = hit; }
          continue;
        }
        const t = segmentHitsUnit(a, b, u);
        if (t !== null && t < bestT) { bestT = t; bestUnit = u; bestMember = null; }
      }
      const tg = segmentHitsTerrain(a, b, this.terrain);
      let done = p.life <= 0;
      if (bestUnit && (tg === null || bestT <= tg)) {
        const at = a.clone().lerp(b, bestT);
        const w = WEAPONS[p.weapon];
        const byPlayer = p.owner === PLAYER_OWNER;
        if (at.distanceTo(p.origin) >= w.minRange) {
          if (bestMember) this.damageMember(bestUnit, bestMember.member, falloffDamage(w, at.distanceTo(p.origin)) * (bestMember.head ? HEADSHOT : 1) / (w.squadScale ?? 1), byPlayer);
          else hitUnit(this, bestUnit, w, byPlayer, at.distanceTo(p.origin), byPlayer ? aspectMultiplier(bestUnit, p.vel) : 1);
          explodeWeapon(this, at, w, byPlayer, bestUnit);
        }
        this.emit({ t: 'impact', weapon: p.weapon, pos: at, unit: bestUnit.id, ground: false });
        done = true;
      } else if (tg !== null) {
        const at = a.clone().lerp(b, tg);
        const w = WEAPONS[p.weapon];
        if (at.distanceTo(p.origin) >= w.minRange) explodeWeapon(this, at, w, p.owner === PLAYER_OWNER);
        this.emit({ t: 'impact', weapon: p.weapon, pos: at, ground: true });
        done = true;
      }
      if (done) { list[i] = list[list.length - 1]; list.pop(); }
    }
  }

  private onGround(dt: number) {
    const h = this.player;
    const pad = this.pads[this.padUnder()];
    if (pad?.base && h.fuel < 100) {
      h.fuel = Math.min(100, h.fuel + BASE_REFUEL_RATE * dt);
      if (!this.refuelNoted && h.fuel < 95) { this.emit({ t: 'refuel' }); this.refuelNoted = true; }
    }
  }
}
