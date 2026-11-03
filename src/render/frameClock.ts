import { STEP } from '../sim/world';

export const MAX_FRAME_DT = 0.05;

export function frameDt(now: number, last: number) {
  return Math.min(MAX_FRAME_DT, (now - last) / 1000);
}

export function drainSteps(acc: number) {
  let steps = 0;
  while (acc >= STEP) { acc -= STEP; steps++; }
  return { steps, acc };
}
