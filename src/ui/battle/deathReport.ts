import type { Vector3 } from 'three';
import { hasString, t } from '../../content/strings';
import type { CrashReason, SimEvent } from '../../sim/events';
import type { FlightSession } from '../../sim/session';
import type { Unit } from '../../sim/units';
import type { ThreatKind } from '../../sim/weapons/enemyMissile';
import { crashText } from '../flight/messages';
import { sideSymbol } from './hud/symbols';
import { withTickets } from './tickets';

export interface DeathHit { side?: string; defId?: string; weapon?: string; dist?: number }

const BY_ENEMY = new Set<CrashReason>(['killed', 'crewKilled', 'rotorLoss']);
const MISSILE_WEAPONS: Record<string, ThreatKind> = { missile_ir: 'ir', missile_radar: 'radar' };

const label = (key: string) => (hasString(key) ? t(key) : '');

function shooterText({ side, defId }: DeathHit) {
  const name = defId ? label(`units.${defId}`) : '';
  const sideName = side ? label(`battle.death.side.${side}`) : '';
  return [side ? sideSymbol(side) : '', name.startsWith(sideName) ? '' : sideName, name].filter(Boolean).join(' ');
}

function distText(dist?: number) {
  if (dist === undefined || !Number.isFinite(dist)) return '';
  return dist >= 1000 ? `${(dist / 1000).toFixed(1)}km` : `${Math.round(dist)}m`;
}

export function deathLine(reason: CrashReason, value?: number, hit?: DeathHit | null) {
  const cause = crashText(reason, value);
  if (!hit || !BY_ENEMY.has(reason)) return cause;
  return [shooterText(hit) || cause, hit.weapon ? label(`battle.death.weapon.${hit.weapon}`) : '', distText(hit.dist)].filter(Boolean).join(' · ');
}

export function lineMissile(reason: CrashReason, hit?: DeathHit | null): ThreatKind | null {
  return hit?.weapon && BY_ENEMY.has(reason) ? MISSILE_WEAPONS[hit.weapon] ?? null : null;
}

export function firedWeapon(u: Pick<Unit, 'def'>, weapon: string) {
  if (weapon !== 'g_rifle' || !u.def.squad) return weapon;
  return u.def.weapons.find(w => w.id === 'g_sniper' || w.id === 'g_lmg')?.id ?? weapon;
}

export function radioLine(mode: string, death: string | null, radio: { text: string; until: number } | null, now: number) {
  if (mode === 'crashed' && death) return death;
  return radio && radio.until > now ? radio.text : null;
}

export class DeathReport {
  private hit: DeathHit | null = null;
  private fatal = false;
  private crash: { reason: CrashReason; value?: number; at: number } | null = null;
  private launches = new Map<number, { side?: string; defId?: string; weapon: string; from: Vector3 }>();
  private paidBefore: number;

  constructor(private readonly session: FlightSession, private readonly paid: () => number = () => 0) {
    this.paidBefore = paid();
    session.world.events.onAny(e => this.onEvent(e));
    session.subscribe(() => { if (session.crash === null) this.clear(); });
  }

  line() {
    return this.crash ? withTickets(deathLine(this.crash.reason, this.crash.value, this.hit), this.paid() - this.paidBefore) : null;
  }

  missile() {
    return this.crash ? lineMissile(this.crash.reason, this.hit) : null;
  }

  private clear() {
    this.hit = null;
    this.fatal = false;
    this.crash = null;
    this.paidBefore = this.paid();
  }

  private onEvent(e: SimEvent) {
    const world = this.session.world;
    if (e.t === 'playerHit') {
      if (this.fatal || this.crash) return;
      const u = world.unit(e.by), body = world.playerBody();
      this.hit = u ? { side: u.side, defId: u.defId, weapon: firedWeapon(u, e.weapon), dist: u.pos.distanceTo(body.pos) } : { weapon: e.weapon };
      this.fatal = !body.alive;
    } else if (e.t === 'missileWarning') {
      const u = world.unit(e.owner);
      this.launches.set(e.id, { side: u?.side, defId: u?.defId, weapon: `missile_${e.kind}`, from: e.from });
    } else if (e.t === 'missileEnd') {
      const launch = this.launches.get(e.id);
      this.launches.delete(e.id);
      if (!launch || !e.hit || world.avatar.kind !== 'heli' || this.fatal || (this.crash && this.crash.at !== world.time)) return;
      this.hit = { side: launch.side, defId: launch.defId, weapon: launch.weapon, dist: launch.from.distanceTo(world.playerBody().pos) };
    } else if (e.t === 'crash') {
      this.crash = { reason: e.reason, value: e.value, at: world.time };
      if (e.reason === 'killed' && !this.fatal) this.hit = null;
    }
  }
}
