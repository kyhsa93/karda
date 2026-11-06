import { squadMembers, type Side, type UnitDef } from '../units';
import type { World } from '../world';
import type { ConquestRules, TicketClass } from './modes';
import { modePoints, type BattleMapDef, type BattleSide, type PointOwner } from './schema';

export const CAPTURED = 100;

export interface ControlPoint {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  value: number;
  asset?: 'farp' | 'radar' | 'artillery';
  owner: PointOwner;
  v: number;
  contested: boolean;
  strength: Record<BattleSide, number>;
}

export type Winner = BattleSide | 'draw';

export interface TicketCauses { bleed: number; person: number; vehicle: number; player: number }

const noCauses = (): TicketCauses => ({ bleed: 0, person: 0, vehicle: 0, player: 0 });

export function ticketClass(d: UnitDef): TicketClass | null {
  if (d.squad) return 'person';
  if (d.category === 'air') return d.carry ? 'transportHeli' : d.move && d.move.speed > 150 ? 'jet' : 'attackHeli';
  if (d.category === 'airDefense') return 'airDefense';
  if (d.category === 'tracked') return d.armor >= 4 ? 'tank' : 'apc';
  if (d.category === 'vehicle') return 'light';
  return null;
}

const other = (s: BattleSide): BattleSide => (s === 'coalition' ? 'veros' : 'coalition');
const battleSide = (s: Side): s is BattleSide => s === 'coalition' || s === 'veros';

export class Conquest {
  readonly points: ControlPoint[];
  readonly tickets: Record<BattleSide, number>;
  readonly causes: Record<BattleSide, TicketCauses> = { coalition: noCauses(), veros: noCauses() };
  elapsed = 0;
  winner: Winner | null = null;
  endReason: 'tickets' | 'time' | null = null;
  private members = new Map<number, number>();
  private counted = new Set<number>();

  constructor(map: BattleMapDef, mode: 'conquest' | 'quick', readonly rules: ConquestRules) {
    const start = map.modes[mode]!.start;
    this.points = modePoints(map, mode).map(p => {
      const owner = start[p.id];
      return {
        id: p.id, name: p.name, x: p.position[0], z: p.position[1], radius: p.radius, value: p.value, asset: p.asset,
        owner, v: owner === 'coalition' ? CAPTURED : owner === 'veros' ? -CAPTURED : 0, contested: false, strength: { coalition: 0, veros: 0 },
      };
    });
    this.tickets = { coalition: rules.tickets, veros: rules.tickets };
  }

  owned(side: BattleSide) {
    return this.points.filter(p => p.owner === side).length;
  }

  step = (world: World, dt: number) => {
    if (this.winner) return;
    this.elapsed += dt;
    this.capture(world, dt);
    this.bleed(dt);
    this.losses(world);
    this.checkEnd(world);
  };

  strengthOf(world: World, p: ControlPoint) {
    const s = p.strength, r = this.rules.strength;
    s.coalition = 0; s.veros = 0;
    for (const u of world.units) {
      if (!u.alive || !battleSide(u.side)) continue;
      if (Math.hypot(u.pos.x - p.x, u.pos.z - p.z) > p.radius) continue;
      const d = u.def;
      if (d.squad) s[u.side] += squadMembers(u) * r.squadPerMember;
      else if (d.move && !d.move.air) s[u.side] += r.groundVehicle;
      else if (d.move?.air) s[u.side] += r.air;
    }
    const body = world.playerBody();
    const side = world.playerSide;
    if (body.alive && (side === 'coalition' || side === 'veros') && Math.hypot(body.pos.x - p.x, body.pos.z - p.z) <= p.radius) {
      s[side] += body.kind === 'soldier' ? r.player : body.kind === 'heli' ? r.air : 0;
    }
    return s;
  }

  private capture(world: World, dt: number) {
    const r = this.rules;
    for (const p of this.points) {
      const s = this.strengthOf(world, p);
      const d = s.coalition - s.veros;
      p.contested = s.coalition > 0 && s.veros > 0 && Math.abs(d) < r.contestedBelow;
      if (p.contested || d === 0) continue;
      const before = p.v;
      p.v = Math.max(-CAPTURED, Math.min(CAPTURED, p.v + r.captureRatePerSec * Math.max(-r.captureCap, Math.min(r.captureCap, d)) * dt));
      const was = p.owner;
      if (p.v >= CAPTURED) p.owner = 'coalition';
      else if (p.v <= -CAPTURED) p.owner = 'veros';
      else if (p.owner !== 'neutral' && (p.v === 0 || Math.sign(p.v) !== Math.sign(before))) p.owner = 'neutral';
      if (p.owner !== was) world.emit({ t: 'pointOwner', id: p.id, owner: p.owner, from: was });
    }
  }

  private bleed(dt: number) {
    const c = this.owned('coalition'), v = this.owned('veros');
    if (c === v) return;
    const loser: BattleSide = c < v ? 'coalition' : 'veros';
    this.spend(loser, 'bleed', this.rules.bleedPerPointPerSec * Math.abs(c - v) * dt);
  }

  private losses(world: World) {
    const cost = this.rules.ticketCost;
    for (const u of world.units) {
      if (!battleSide(u.side) || this.counted.has(u.id)) continue;
      if (u.def.squad) {
        const now = squadMembers(u), was = this.members.get(u.id) ?? u.def.squad;
        if (now < was) this.spend(u.side, 'person', (was - now) * cost.person);
        this.members.set(u.id, now);
        if (!u.alive) { this.counted.add(u.id); this.members.delete(u.id); }
      } else if (!u.alive) {
        this.counted.add(u.id);
        const cls = ticketClass(u.def);
        if (cls) this.spend(u.side, 'vehicle', cost[cls]);
      }
    }
  }

  playerDied(side: BattleSide, vehicle: TicketClass | null) {
    if (this.winner) return;
    this.spend(side, 'player', this.rules.ticketCost.person + (vehicle ? this.rules.ticketCost[vehicle] : 0));
  }

  private spend(side: BattleSide, cause: keyof TicketCauses, n: number) {
    this.tickets[side] -= n;
    this.causes[side][cause] += n;
  }

  private checkEnd(world: World) {
    const t = this.tickets;
    if (t.coalition <= 0 || t.veros <= 0) {
      this.finish(world, t.coalition <= 0 && t.veros <= 0 ? 'draw' : t.coalition <= 0 ? 'veros' : 'coalition', 'tickets');
    } else if (this.elapsed >= this.rules.timeLimitSec) {
      const c = Math.floor(t.coalition), v = Math.floor(t.veros);
      const pc = this.owned('coalition'), pv = this.owned('veros');
      this.finish(world, c !== v ? (c > v ? 'coalition' : 'veros') : pc !== pv ? (pc > pv ? 'coalition' : 'veros') : 'draw', 'time');
    }
  }

  private finish(world: World, winner: Winner, reason: 'tickets' | 'time') {
    this.winner = winner;
    this.endReason = reason;
    for (const s of ['coalition', 'veros'] as const) this.tickets[s] = Math.max(0, this.tickets[s]);
    world.emit({ t: 'battleEnd', winner, reason });
  }

  loser(winner: Winner) {
    return winner === 'draw' ? null : other(winner);
  }
}
