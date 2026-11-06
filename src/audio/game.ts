import type { Vector3 } from 'three';
import type { SimEvent } from '../sim/events';
import { RotorAudio, type AudioState } from './rotor';
import { InfantryAudio, type FootState } from './infantry';
import { SfxPlayer, type SampleId } from './sfx';
import { speechBackend, VoiceWarnings, type VoiceBackend, type VoiceLine } from './voice';

export const BINGO = 10;
export const ALTITUDE_FT = 50;
export const ALTITUDE_SINK = 800;

export function voiceFor(e: SimEvent): VoiceLine | null {
  switch (e.t) {
    case 'missileWarning': return e.kind === 'radar' ? 'missileLaunch' : 'missile';
    case 'systemDamaged':
      if (e.system === 'engine1' && e.level === 'damaged') return 'engine1Fire';
      if (e.system === 'engine2' && e.level === 'damaged') return 'engine2Fire';
      if (e.system === 'rotor' && e.level === 'destroyed') return 'landNow';
      return null;
    case 'engine': return !e.on && (e.cause === 'damage' || e.cause === 'fuel') ? 'engineOut' : null;
    default: return null;
  }
}

export const AUDIO_ASSETS: Record<string, string> = {
  'audio.rotor_loop': 'rotor_interior_loop',
  'audio.engine_start': 'engine_start',
  'audio.gun_shot': 'gun_shot',
  'audio.rocket_launch': 'rocket_launch',
  'audio.hellfire_launch': 'hellfire_launch',
  'audio.explosion_near': 'explosion_near',
  'audio.explosion_fire': 'explosion_fire',
  'audio.impact_metal': 'impact_metal',
  'audio.impact_ground': 'impact_ground',
  'audio.hit_metal_0': 'hit_metal_0',
  'audio.hit_metal_1': 'hit_metal_1',
  'audio.hit_metal_2': 'hit_metal_2',
  'audio.radio_squelch': 'radio_squelch',
  'audio.rifle_shot': 'rifle_shot',
  'audio.rifle_enemy': 'rifle_enemy',
  'audio.mg_shot': 'mg_shot',
  'audio.sniper_shot': 'sniper_shot',
  'audio.grenade_launch': 'grenade_launch',
  'audio.reload': 'reload',
  'audio.hit_marker': 'hit_marker',
  'audio.footstep_0': 'footstep_0',
  'audio.footstep_1': 'footstep_1',
  'audio.impact_body': 'impact_body',
};

export const VOICE_DUCK = 1.6;
export const RADIO_DUCK = 0.8;

export class GameAudio {
  readonly rotor: RotorAudio;
  readonly sfx: SfxPlayer;
  readonly voice: VoiceWarnings;
  readonly infantry: InfantryAudio;
  private foot = false;
  private bingoSaid = false;
  private buffers: Record<string, AudioBuffer> = {};

  constructor(ctx?: AudioContext, voice?: VoiceBackend | null) {
    this.rotor = new RotorAudio(ctx);
    this.sfx = new SfxPlayer(this.rotor.context, this.rotor.output);
    this.sfx.radioOut = this.rotor.radioOutput;
    this.infantry = new InfantryAudio(this.sfx, () => this.rotor.context.currentTime);
    this.voice = new VoiceWarnings(voice === undefined ? speechBackend() : voice, () => this.rotor.beep(), () => this.rotor.context.currentTime);
  }

  async loadSamples(get: (id: string) => ArrayBuffer | undefined) {
    const ctx = this.rotor.context;
    await Promise.all(Object.entries(AUDIO_ASSETS).map(async ([id, name]) => {
      const raw = get(id);
      if (!raw) return;
      try { this.buffers[name] = await ctx.decodeAudioData(raw.slice(0)); } catch { /* keep synthesis fallback */ }
    }));
    if (this.buffers.rotor_interior_loop) this.rotor.setRotorLoop(this.buffers.rotor_interior_loop);
    const s: Partial<Record<SampleId, AudioBuffer>> = {};
    for (const k of ['gun_shot', 'rocket_launch', 'hellfire_launch', 'hit_metal_0', 'hit_metal_1', 'hit_metal_2', 'radio_squelch', 'impact_metal', 'impact_ground', 'explosion_near', 'explosion_fire', 'rifle_shot', 'rifle_enemy', 'mg_shot', 'sniper_shot', 'grenade_launch', 'reload', 'hit_marker', 'footstep_0', 'footstep_1', 'impact_body'] as SampleId[]) if (this.buffers[k]) s[k] = this.buffers[k];
    this.sfx.setSamples(s);
  }

  onEvent(e: SimEvent, listener: Vector3) {
    if (e.t === 'engine') {
      if (e.on) this.rotor.playEngineStart(this.buffers.engine_start);
      else this.rotor.stopEngineStart();
    }
    this.infantry.onEvent(e, listener, this.foot);
    if (!(this.foot && e.t === 'playerHit')) this.sfx.onEvent(e, listener);
    if (e.t === 'radio') { this.sfx.radio(); this.rotor.duckFor(RADIO_DUCK); }
    const line = voiceFor(e);
    if (line && this.voice.say(line)) this.rotor.duckFor(VOICE_DUCK);
  }

  update(s: AudioState & { fuel?: number; aglFt?: number; vsFpm?: number; flying?: boolean; soldier?: FootState | null }) {
    this.foot = !!s.soldier;
    this.infantry.update(s.soldier ?? null);
    this.rotor.update(s);
    if (s.fuel !== undefined) {
      if (s.fuel < BINGO && !this.bingoSaid) { this.bingoSaid = this.voice.say('bingoFuel'); }
      if (s.fuel > BINGO + 5) this.bingoSaid = false;
    }
    if (s.flying && s.aglFt !== undefined && s.vsFpm !== undefined && s.aglFt < ALTITUDE_FT && s.vsFpm < -ALTITUDE_SINK) this.voice.say('altitude');
  }
  get suspended() { const s = this.rotor.context.state; return s !== 'running' && s !== 'closed'; }
  resume() { return this.rotor.resume(); }
  toggleMute() { return this.rotor.toggleMute(); }
  setVolume(v: number) { this.rotor.setVolume(v); }
  dispose() { this.rotor.dispose(); }
}
