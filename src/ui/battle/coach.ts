import type { SortieRole } from '../../save/save';

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
  { id: 'soldier.capture', ready: walking, done: f => f.inPoint },
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

export const DEATH_TIPS: Record<string, string> = {
  crewKilled: 'battle.tips.fire', rotorLoss: 'battle.tips.fire', terrain: 'battle.tips.terrain', tree: 'battle.tips.terrain', building: 'battle.tips.terrain',
  rotorStrike: 'battle.tips.terrain', water: 'battle.tips.terrain', outOfBounds: 'battle.tips.zone', hardLanding: 'battle.tips.landing',
  slideLanding: 'battle.tips.landing', tiltLanding: 'battle.tips.landing', slope: 'battle.tips.landing', ditched: 'battle.tips.terrain',
};

export function deathTip(reason: string | undefined, missile: boolean) {
  if (reason === 'killed') return 'battle.tips.soldier';
  if (missile) return 'battle.tips.missile';
  return (reason && DEATH_TIPS[reason]) || 'battle.tips.fire';
}

export function cardDevice(touch: boolean, pads: readonly ({ connected: boolean } | null)[]) {
  return touch ? 'touch' : pads.some(p => p?.connected) ? 'pad' : 'keyboard';
}

export function initialRole(side: 'coalition' | 'veros', lastRole: SortieRole | undefined): SortieRole {
  return side === 'coalition' && lastRole === 'heli' ? 'heli' : 'soldier';
}
