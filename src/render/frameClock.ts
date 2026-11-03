import { t } from '../content/strings';
import { STEP } from '../sim/world';

export const MAX_FRAME_DT = 0.05;
export const PACE_WINDOW_MS = 5000;

export function frameDt(now: number, last: number) {
  return Math.min(MAX_FRAME_DT, (now - last) / 1000);
}

export function drainSteps(acc: number) {
  let steps = 0;
  while (acc >= STEP) { acc -= STEP; steps++; }
  return { steps, acc };
}

export class PaceMeter {
  private at: number[] = [];
  private steps: number[] = [];
  private head = 0;
  private total = 0;

  record(now: number, steps: number) {
    if (this.at.length > this.head) this.total += steps;
    this.at.push(now);
    this.steps.push(steps);
    while (this.head + 1 < this.at.length && this.at[this.head + 1] <= now - PACE_WINDOW_MS) {
      this.head++;
      this.total -= this.steps[this.head];
    }
    if (this.head >= 4096) {
      this.at.splice(0, this.head);
      this.steps.splice(0, this.head);
      this.head = 0;
    }
  }

  get ratio() {
    if (this.at.length === 0) return null;
    const elapsed = this.at[this.at.length - 1] - this.at[this.head];
    return elapsed < PACE_WINDOW_MS ? null : this.total * STEP / (elapsed / 1000);
  }
}

export function paceLabel(ratio: number | null) {
  return ratio === null ? t('flight.paceWait') : t('flight.pace', { ratio: ratio.toFixed(2) });
}
