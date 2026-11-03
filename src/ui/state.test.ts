import { describe, expect, it } from 'vitest';
import { isBattleRoute, parseHash, toHash, UiState } from './state';

describe('screen routing', () => {
  it.each([
    ['', { name: 'title' }],
    ['#/title', { name: 'title' }],
    ['#/settings', { name: 'settings' }],
    ['#/credits', { name: 'credits' }],
    ['#/campaign/m05', { name: 'title' }],
    ['#/battle', { name: 'battleSetup' }],
    ['#/battle/harek/quick', { name: 'battleSetup' }],
    ['#/flight/t1', { name: 'title' }],
    ['#/nonsense', { name: 'title' }],
  ])('%s', (hash, screen) => {
    expect(parseHash(hash)).toEqual(screen);
  });

  it('tells a battle route, which a reload lands on, from the setup route', () => {
    expect(isBattleRoute(toHash({ name: 'battle', map: 'harek', mode: 'quick' }))).toBe(true);
    for (const hash of ['', '#/title', toHash({ name: 'battleSetup' }), '#/battle/', '#/battlefield/x']) expect(isBattleRoute(hash)).toBe(false);
  });

  it('round-trips every screen', () => {
    for (const s of [{ name: 'title' }, { name: 'settings' }, { name: 'credits' }, { name: 'battleSetup' }] as const) expect(parseHash(toHash(s))).toEqual(s);
    expect(toHash({ name: 'battle', map: 'harek', mode: 'quick' })).toBe('#/battle/harek/quick');
  });

  it('writes the hash on navigation and follows external hash changes', () => {
    const loc = { hash: '#/settings' };
    const ui = new UiState(loc);
    expect(ui.getSnapshot()).toEqual({ name: 'settings' });
    ui.go({ name: 'credits' });
    expect(loc.hash).toBe('#/credits');
    loc.hash = '#/title';
    ui.syncFromLocation();
    expect(ui.getSnapshot()).toEqual({ name: 'title' });
  });

  it('sends a reload during a battle back to the battle setup (wiki 8.1)', () => {
    const loc = { hash: '' };
    const ui = new UiState(loc);
    ui.go({ name: 'battleSetup' });
    ui.go({ name: 'battle', map: 'harek', mode: 'quick' });
    expect(loc.hash).toBe('#/battle/harek/quick');
    expect(new UiState(loc).getSnapshot()).toEqual({ name: 'battleSetup' });
    ui.syncFromLocation();
    expect(ui.getSnapshot()).toEqual({ name: 'battle', map: 'harek', mode: 'quick' });
  });
});
