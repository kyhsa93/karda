import type { Vector3 } from 'three';
import type { SimEvent } from '../sim/events';
import { distanceGain, distanceLowpass } from './mixer';
import { SOUND_SPEED, type SampleId, type SfxPlayer } from './sfx';

export type FireClass = 'small' | 'heavy' | 'cannon';

export const FIRE_CLASS: Readonly<Record<string, FireClass>> = {
  rifle: 'small', g_rifle: 'small', lmg: 'small', g_lmg: 'small', g_coax: 'small', g_sniper: 'small',
  hmg: 'heavy', g_hmg: 'heavy', aa_mg: 'heavy', ac30: 'heavy', g_ac30: 'heavy', g_aaa: 'heavy', zu23x2: 'heavy', zu23x4: 'heavy', heli_gun: 'heavy', jet_gun: 'heavy',
  g_main: 'cannon', g_at: 'cannon',
};

export const FIRE_RANGE: Readonly<Record<FireClass, { ref: number; max: number }>> = {
  small: { ref: 40, max: 1500 },
  heavy: { ref: 80, max: 3000 },
  cannon: { ref: 150, max: 6000 },
};

export const BOT_CLIP: Readonly<Record<string, SampleId>> = {
  rifle: 'rifle_enemy', g_rifle: 'rifle_enemy', g_sniper: 'sniper_shot',
  lmg: 'mg_shot', g_lmg: 'mg_shot', g_coax: 'mg_shot', hmg: 'mg_shot', g_hmg: 'mg_shot', aa_mg: 'mg_shot',
};

export const BOT_FIRE_GAP = 0.05;

export const STEP_LENGTH = { stand: 1.5, crouch: 1.0, prone: 0.7 } as const;
export const STEP_GAIN = { stand: 0.22, crouch: 0.12, prone: 0.07 } as const;
export const STEP_MIN_SPEED = 0.5;

export interface FootState { dt: number; speed: number; stance: keyof typeof STEP_LENGTH; onGround: boolean; reloading: boolean }

export class InfantryAudio {
  private botFireAt: Record<FireClass, number> = { small: -1, heavy: -1, cannon: -1 };
  private stepDist = 0;
  private reloading = false;
  private step = 0;

  constructor(private sfx: SfxPlayer, private now: () => number, private rnd: () => number = Math.random) {}

  onEvent(e: SimEvent, listener: Vector3, foot: boolean) {
    if (e.t === 'fire') {
      if (e.owner === 0) {
        if (e.weapon === 'rifle' || e.weapon === 'carbine') {
          if (this.sfx.has('rifle_shot')) this.sfx.clip('rifle_shot', { gain: 0.55, rate: 0.97 + this.rnd() * 0.06, length: 0.85 });
          else this.sfx.clip('gun_shot', { gain: 0.5, rate: 1.65 + this.rnd() * 0.1, length: 0.16, highpass: 400 });
        } else if (e.weapon === 'at_rocket') {
          this.sfx.clip('rocket_launch', { gain: 0.5, rate: 1.1, length: 0.5 });
        } else if (e.weapon === 'grenade') {
          if (this.sfx.has('grenade_launch')) this.sfx.clip('grenade_launch', { gain: 0.5, length: 0.44 });
          else this.sfx.clip('rocket_launch', { gain: 0.45, rate: 1.9, length: 0.25, lowpass: 3000 });
        }
        return;
      }
      const cls = FIRE_CLASS[e.weapon];
      if (!cls) return;
      const t = this.now();
      if (t - this.botFireAt[cls] < BOT_FIRE_GAP) return;
      const d = e.pos.distanceTo(listener), r = FIRE_RANGE[cls];
      const gain = distanceGain(d, r.ref, 1, r.max);
      if (gain <= 0) return;
      this.botFireAt[cls] = t;
      const delay = d / SOUND_SPEED, lowpass = distanceLowpass(d, 16000, 500);
      const clip = BOT_CLIP[e.weapon];
      if (cls === 'cannon') this.sfx.clip('explosion_near', { gain: gain, rate: 1.5, length: 0.5, delay, lowpass });
      else if (clip && this.sfx.has(clip)) this.sfx.clip(clip, { gain: (clip === 'mg_shot' && cls === 'heavy' ? 1 : 0.8) * gain, rate: (cls === 'heavy' ? 0.8 : 0.95) + this.rnd() * 0.1, length: clip === 'sniper_shot' ? 1.2 : clip === 'mg_shot' ? 0.12 : 0.6, delay, lowpass });
      else this.sfx.clip('gun_shot', { gain: (cls === 'small' ? 0.8 : 1) * gain, rate: cls === 'small' ? 1.5 + this.rnd() * 0.15 : 1, length: cls === 'small' ? 0.15 : 0.2, delay, lowpass, highpass: cls === 'small' ? 300 : 0 });
      return;
    }
    if (!foot) return;
    if (e.t === 'playerHit') {
      const gain = Math.min(1, 0.4 + e.damage / 40);
      if (this.sfx.has('impact_body')) this.sfx.clip('impact_body', { gain, rate: 0.9 + this.rnd() * 0.2, length: 0.46 });
      else this.sfx.clip('impact_ground', { gain, rate: 0.6, length: 0.25, lowpass: 900 });
    } else if (e.t === 'memberHit' && e.byPlayer) {
      if (this.sfx.has('hit_marker')) this.sfx.clip('hit_marker', { gain: e.killed ? 0.45 : 0.3, rate: e.killed ? 0.8 : 1, length: 0.19 });
      else this.sfx.clip('hit_metal_2', e.killed ? { gain: 0.35, rate: 1.6, length: 0.1 } : { gain: 0.25, rate: 2.4, length: 0.06 });
    }
  }

  update(s: FootState | null) {
    if (!s) { this.stepDist = 0; this.reloading = false; return; }
    if (s.reloading !== this.reloading) {
      this.reloading = s.reloading;
      if (this.sfx.has('reload')) { if (s.reloading) this.sfx.clip('reload', { gain: 0.45, length: 1.2 }); }
      else this.sfx.clip('impact_metal', { gain: 0.3, rate: s.reloading ? 2.2 : 2.6, length: 0.06, highpass: 800 });
    }
    if (!s.onGround || s.speed < STEP_MIN_SPEED) { this.stepDist = Math.min(this.stepDist, STEP_LENGTH[s.stance] * 0.5); return; }
    this.stepDist += s.speed * s.dt;
    if (this.stepDist < STEP_LENGTH[s.stance]) return;
    this.stepDist -= STEP_LENGTH[s.stance];
    const gain = STEP_GAIN[s.stance] * Math.min(1.5, s.speed / 3);
    const step: SampleId = this.step++ % 2 ? 'footstep_1' : 'footstep_0';
    if (this.sfx.has(step)) this.sfx.clip(step, { gain: gain * 1.6, rate: 0.95 + this.rnd() * 0.1, length: 0.3 });
    else this.sfx.clip('impact_ground', { gain, rate: 1.9 + this.rnd() * 0.3, length: 0.09, lowpass: 1800, highpass: 150 });
  }
}
