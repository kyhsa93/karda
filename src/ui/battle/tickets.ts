import { t } from '../../content/strings';
import type { TicketCauses } from '../../sim/battle/conquest';

type Side = 'coalition' | 'veros';

export function withTickets(line: string, spent: number) {
  const n = Math.round(spent);
  return n > 0 ? `${line} · ${t('battle.death.tickets', { n })}` : line;
}

export function behind(points: readonly { owner: string }[], side: Side) {
  let own = 0, enemy = 0;
  for (const p of points) if (p.owner === side) own++; else if (p.owner !== 'neutral') enemy++;
  return own < enemy;
}

export class BehindCall {
  private pending = false;

  constructor(private was: boolean) {}

  step(now: boolean, free: boolean) {
    if (now && !this.was) this.pending = true;
    if (!now) this.pending = false;
    this.was = now;
    if (!this.pending || !free) return false;
    this.pending = false;
    return true;
  }
}

export const lostTickets = (k: TicketCauses): TicketCauses => ({ bleed: k.bleed, person: k.person, vehicle: k.vehicle, player: k.player });

export function lostText(k: TicketCauses) {
  return t('battle.report.lost', { bleed: Math.floor(k.bleed), person: Math.floor(k.person), vehicle: Math.floor(k.vehicle), player: Math.floor(k.player) });
}
