import { describe, expect, it } from 'vitest';
import { BACKUP_KEY, freshSave, hasSave, loadSave, SAVE_KEY, storeSave, withDeviceDefaults, withFirstRun } from './save';
import { memoryStorage, type KeyValue } from './storage';

describe('settings save', () => {
  it('stores and reloads every settings group, clamping bad values', () => {
    const store = memoryStorage();
    const s = freshSave();
    s.settings.controls = { lookSensitivity: 1.6, invertLookY: true, tadsSensitivity: 0.6, touchStickSize: 'L', aimAssist: false };
    s.settings.display = { fov: 84, ihadssBrightness: 0.7, quality: 'medium', showFps: true };
    s.settings.audio = { master: 0.4 };
    s.settings.difficulty = 'hard';
    storeSave(s, store);
    expect(loadSave(store)).toEqual(s);
    store.setItem(SAVE_KEY, JSON.stringify({ version: 1, settings: { controls: { lookSensitivity: 99, touchStickSize: 'XL' }, display: { fov: 10, quality: 'ultra' }, audio: { master: -3 } } }));
    const back = loadSave(store).settings;
    expect(back.controls).toEqual({ lookSensitivity: 2, invertLookY: false, tadsSensitivity: 1, touchStickSize: 'M', aimAssist: true });
    expect(back.display).toMatchObject({ fov: 60, quality: 'high', showFps: false });
    expect(back.audio.master).toBe(0);
  });

  it('keeps the settings of an old campaign save and drops the rest', () => {
    const store = memoryStorage();
    store.setItem(SAVE_KEY, JSON.stringify({ version: 1, missions: { m01: { completed: true } }, settings: { difficulty: 'easy', voiceWarnings: false } }));
    const s = loadSave(store);
    expect(s.settings).toMatchObject({ difficulty: 'easy', voiceWarnings: false });
    expect(Object.keys(s)).toEqual(['version', 'settings', 'tips']);
  });

  it('keeps the last sortie role in the same v1 save and ignores anything else there (#226)', () => {
    const store = memoryStorage();
    storeSave({ ...freshSave(), lastRole: 'heli' }, store);
    expect(JSON.parse(store.getItem(SAVE_KEY)!).version).toBe(1);
    expect(loadSave(store).lastRole).toBe('heli');
    storeSave({ ...freshSave(), lastRole: 'soldier' }, store);
    expect(loadSave(store).lastRole).toBe('soldier');
    for (const bad of ['tank', 3, null]) {
      store.setItem(SAVE_KEY, JSON.stringify({ version: 1, settings: {}, lastRole: bad }));
      expect(Object.keys(loadSave(store))).toEqual(['version', 'settings', 'tips']);
    }
    expect(store.getItem(BACKUP_KEY)).toBeNull();
  });

  it('moves unreadable data to the backup key and survives a broken storage', () => {
    const store = memoryStorage();
    store.setItem(SAVE_KEY, '{nope');
    expect(loadSave(store)).toEqual(freshSave());
    expect(store.getItem(BACKUP_KEY)).toBe('{nope');
    const broken: KeyValue = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadSave(broken)).toEqual(freshSave());
    expect(storeSave(freshSave(), broken)).toBe(false);
  });

  it('picks low quality for a phone on first run only', () => {
    const store = memoryStorage();
    expect(hasSave(store)).toBe(false);
    expect(withDeviceDefaults(freshSave(), { mobile: true }).settings.display.quality).toBe('low');
    storeSave(freshSave(), store);
    expect(hasSave(store)).toBe(true);
  });

  it('remembers the coach tips already shown and uses the first-match defaults on a first run (wiki 8.10)', () => {
    const store = memoryStorage();
    storeSave({ ...freshSave(), tips: ['card.apache', 'rules.points'] }, store);
    expect(loadSave(store).tips).toEqual(['card.apache', 'rules.points']);
    store.setItem(SAVE_KEY, JSON.stringify({ version: 1, settings: {}, tips: ['ok', 3, null] }));
    expect(loadSave(store).tips).toEqual(['ok']);
    const first = withFirstRun(freshSave());
    expect(first.settings.difficulty).toBe('easy');
    expect(first.settings.assists).toEqual({ autoIdentify: true, autoCountermeasures: true });
  });
});
