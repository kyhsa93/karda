import { t } from '../../content/strings';
import type { SortieRole } from '../../save/save';
import type { CrashReason } from '../../sim/events';
import { sideSymbol } from './hud/symbols';

export const STEP_TIMEOUT = 20;
export const MIN_SHOW = 3;

export interface CoachFacts {
  agl: number;
  tads: boolean;
  identified: number;
  flips: number;
  detected: number;
  deaths: number;
  playing: boolean;
  foot: boolean;
  walked: number;
  shots: number;
  inPoint: boolean;
}

export interface CoachStep { id: string; ready: (f: CoachFacts, start: CoachFacts) => boolean; done: (f: CoachFacts, start: CoachFacts) => boolean }

export const WALK_STEP = 10;

const flying = (f: CoachFacts) => f.playing && !f.foot;
const walking = (f: CoachFacts) => f.playing && f.foot;

export const COACH_STEPS: CoachStep[] = [
  { id: 'rules.points', ready: f => f.playing, done: () => false },
  { id: 'soldier.move', ready: walking, done: (f, s) => f.walked - s.walked >= WALK_STEP },
  { id: 'soldier.shoot', ready: walking, done: (f, s) => f.shots > s.shots },
  { id: 'soldier.captureZone', ready: f => walking(f) && f.inPoint, done: f => !f.inPoint },
  { id: 'apache.collective', ready: flying, done: (f, s) => Math.abs(f.agl - s.agl) > 15 },
  { id: 'apache.tads', ready: flying, done: f => f.tads },
  { id: 'apache.identify', ready: flying, done: (f, s) => f.identified > s.identified },
  { id: 'rules.tickets', ready: f => f.playing && f.flips > 0, done: () => false },
  { id: 'apache.popup', ready: f => flying(f) && f.detected > 0, done: () => false },
];

export class Coach {
  current: CoachStep | null = null;
  private start: CoachFacts | null = null;
  private shown = 0;

  constructor(readonly seen: Set<string>, readonly steps: CoachStep[] = COACH_STEPS, readonly onSeen: (id: string) => void = () => {}) {}

  update(f: CoachFacts, dt: number): string | null {
    if (this.current) {
      this.shown += dt;
      const finished = this.shown >= STEP_TIMEOUT || (this.shown >= MIN_SHOW && this.current.done(f, this.start!));
      if (!finished) return this.current.id;
      this.seen.add(this.current.id);
      this.onSeen(this.current.id);
      this.current = null;
    }
    const next = this.steps.find(s => !this.seen.has(s.id) && s.ready(f, f));
    if (!next) return null;
    this.current = next;
    this.start = { ...f };
    this.shown = 0;
    return next.id;
  }
}

export const MARK_FONT_PX = 13;
export const MARK_BORDER_PX = 3;
export const MARK_STALE_MS = 2000;
export const MARK_OVERLAP_MIN_PX = 5;

export interface Box { left: number; right: number; top: number; bottom: number }

export function pointMarkBox(x: number, y: number, textWidth: number): Box {
  const half = (MARK_FONT_PX + MARK_BORDER_PX) / 2;
  return { left: x - textWidth / 2, right: x + textWidth / 2, top: y - half, bottom: y + half };
}

export const MARK_PANEL_GAP_PX = 4;

export function clearOf(x: number, y: number, textWidth: number, panel: Box | null) {
  if (!panel) return x;
  const m = pointMarkBox(x, y, textWidth), gap = MARK_PANEL_GAP_PX;
  const hit = Math.min(m.right, panel.right + gap) - Math.max(m.left, panel.left - gap) > 0 && Math.min(m.bottom, panel.bottom + gap) - Math.max(m.top, panel.top - gap) > 0;
  return hit ? panel.left - textWidth / 2 - MARK_PANEL_GAP_PX : x;
}

export class PointMarkBoard {
  boxes: readonly Box[] = [];
  at = -Infinity;

  publish(boxes: readonly Box[], now: number) {
    this.boxes = boxes;
    this.at = now;
  }

  clear() {
    this.boxes = [];
    this.at = -Infinity;
  }
}

export function coachDimmed(coach: Box | null | undefined, marks: PointMarkBoard, now: number) {
  if (!coach || now - marks.at > MARK_STALE_MS) return false;
  return marks.boxes.some(m =>
    Math.min(m.right, coach.right) - Math.max(m.left, coach.left) >= MARK_OVERLAP_MIN_PX
    && Math.min(m.bottom, coach.bottom) - Math.max(m.top, coach.top) >= MARK_OVERLAP_MIN_PX);
}

export const DEATH_TIPS: Record<CrashReason, string> = {
  crewKilled: 'battle.tips.fire', rotorLoss: 'battle.tips.fire', terrain: 'battle.tips.terrain', tree: 'battle.tips.terrain', building: 'battle.tips.terrain',
  rotorStrike: 'battle.tips.terrain', water: 'battle.tips.terrain', outOfBounds: 'battle.tips.zone', hardLanding: 'battle.tips.landing',
  slideLanding: 'battle.tips.landing', tiltLanding: 'battle.tips.landing', slope: 'battle.tips.landing', ditched: 'battle.tips.terrain',
  killed: 'battle.tips.soldier', fall: 'battle.tips.fall',
};
const ON_FOOT = new Set<CrashReason>(['killed', 'fall']);

export function inCapturablePoint(points: readonly { x: number; z: number; radius: number; owner: string }[], side: string, x: number, z: number) {
  return points.some(p => p.owner !== side && Math.hypot(x - p.x, z - p.z) <= p.radius);
}

export function nearestOpenPoint(points: readonly { id: string; x: number; z: number; owner: string }[], side: string, x: number, z: number) {
  let nearest: string | null = null, best = Infinity;
  for (const p of points) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (p.owner !== side && d < best) { best = d; nearest = p.id; }
  }
  return nearest;
}

export function coachText(line: string, side: 'coalition' | 'veros', target: string | null) {
  const key = line === 'rules.points' && !target ? 'rules.pointsHeld' : line;
  return t(`battle.coach.${key}`, { own: sideSymbol(side), enemy: sideSymbol(side === 'coalition' ? 'veros' : 'coalition'), target: target ?? '' });
}

export function deathTip(reason: CrashReason | undefined, missile: boolean) {
  if (reason && ON_FOOT.has(reason)) return DEATH_TIPS[reason];
  if (missile) return 'battle.tips.missile';
  return reason ? DEATH_TIPS[reason] : 'battle.tips.fire';
}

export function controlCard(role: SortieRole, tips: readonly string[]) {
  return !tips.includes(role === 'heli' ? 'card.apache' : 'card.soldier');
}

export function deadTip(deaths: number, seen: boolean, card: boolean) {
  return deaths > 0 && !seen && !card;
}

export function cardDevice(touch: boolean, pads: readonly ({ connected: boolean } | null)[]) {
  return touch ? 'touch' : pads.some(p => p?.connected) ? 'pad' : 'keyboard';
}

export function initialRole(side: 'coalition' | 'veros', lastRole: SortieRole | undefined): SortieRole {
  return side === 'coalition' && lastRole === 'heli' ? 'heli' : 'soldier';
}
