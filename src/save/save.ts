import { isDifficulty, type DifficultyLevel } from '../sim/difficulty';
import { browserStorage, read, remove, write, type KeyValue } from './storage';

export const SAVE_KEY = 'heli-campaign-v1';
export const BACKUP_KEY = 'heli-campaign-backup';

export type Quality = 'low' | 'medium' | 'high';
export type StickSize = 'S' | 'M' | 'L';
export type SortieRole = 'heli' | 'soldier';

export interface Settings {
  difficulty: DifficultyLevel;
  voiceWarnings: boolean;
  assists: { autoIdentify: boolean; autoCountermeasures: boolean };
  controls: { lookSensitivity: number; invertLookY: boolean; tadsSensitivity: number; touchStickSize: StickSize; aimAssist: boolean };
  display: { fov: number; ihadssBrightness: number; quality: Quality; showFps: boolean };
  audio: { master: number };
}

export const RANGES = { lookSensitivity: [0.4, 2], tadsSensitivity: [0.4, 2], fov: [60, 90], ihadssBrightness: [0.4, 1], master: [0, 1] } as const;
const QUALITIES = new Set<Quality>(['low', 'medium', 'high']);
const STICKS = new Set<StickSize>(['S', 'M', 'L']);

export function defaultSettings(): Settings {
  return {
    difficulty: 'normal', voiceWarnings: true, assists: { autoIdentify: false, autoCountermeasures: false },
    controls: { lookSensitivity: 1, invertLookY: false, tadsSensitivity: 1, touchStickSize: 'M', aimAssist: true },
    display: { fov: 72, ihadssBrightness: 1, quality: 'high', showFps: false },
    audio: { master: 1 },
  };
}

const inRange = (v: unknown, [lo, hi]: readonly [number, number]) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;

export interface GameSave {
  version: 1;
  settings: Settings;
  tips: string[];
  lastRole?: SortieRole;
}

export function freshSave(): GameSave {
  return { version: 1, settings: defaultSettings(), tips: [] };
}

function sanitize(raw: unknown): GameSave | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  const save = freshSave();
  if (Array.isArray(r.tips)) save.tips = r.tips.filter((x): x is string => typeof x === 'string').slice(0, 200);
  if (r.lastRole === 'heli' || r.lastRole === 'soldier') save.lastRole = r.lastRole;
  const s = r.settings as Partial<Settings> | undefined;
  if (s) {
    if (isDifficulty(s.difficulty)) save.settings.difficulty = s.difficulty;
    if (typeof s.voiceWarnings === 'boolean') save.settings.voiceWarnings = s.voiceWarnings;
    if (s.assists) {
      save.settings.assists.autoIdentify = s.assists.autoIdentify === true;
      save.settings.assists.autoCountermeasures = s.assists.autoCountermeasures === true;
    }
    const c = s.controls, d = s.display, a = s.audio, out = save.settings;
    if (c) {
      out.controls.lookSensitivity = inRange(c.lookSensitivity, RANGES.lookSensitivity) ?? out.controls.lookSensitivity;
      out.controls.tadsSensitivity = inRange(c.tadsSensitivity, RANGES.tadsSensitivity) ?? out.controls.tadsSensitivity;
      out.controls.invertLookY = c.invertLookY === true;
      out.controls.aimAssist = c.aimAssist !== false;
      if (STICKS.has(c.touchStickSize)) out.controls.touchStickSize = c.touchStickSize;
    }
    if (d) {
      out.display.fov = inRange(d.fov, RANGES.fov) ?? out.display.fov;
      out.display.ihadssBrightness = inRange(d.ihadssBrightness, RANGES.ihadssBrightness) ?? out.display.ihadssBrightness;
      if (QUALITIES.has(d.quality)) out.display.quality = d.quality;
      out.display.showFps = d.showFps === true;
    }
    if (a) out.audio.master = inRange(a.master, RANGES.master) ?? out.audio.master;
  }
  return save;
}

export function loadSave(store: KeyValue | null = browserStorage()): GameSave {
  const raw = read(store, SAVE_KEY);
  if (raw === null) return freshSave();
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const save = sanitize(parsed);
  if (save) return save;
  write(store, BACKUP_KEY, raw);
  remove(store, SAVE_KEY);
  return freshSave();
}

export function hasSave(store: KeyValue | null = browserStorage()) {
  return read(store, SAVE_KEY) !== null;
}

export function withDeviceDefaults(save: GameSave, device: { mobile: boolean }): GameSave {
  return { ...save, settings: { ...save.settings, display: { ...save.settings.display, quality: device.mobile ? 'low' : 'high' } } };
}

export function withFirstRun(save: GameSave): GameSave {
  return { ...save, settings: { ...save.settings, difficulty: 'easy', assists: { autoIdentify: true, autoCountermeasures: true } } };
}

export function storeSave(save: GameSave, store: KeyValue | null = browserStorage()) {
  return write(store, SAVE_KEY, JSON.stringify(save));
}
