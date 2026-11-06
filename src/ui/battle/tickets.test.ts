import { describe, expect, it } from 'vitest';
import { behind, BehindCall, lostTickets, lostText, withTickets } from './tickets';

const pts = (...owners: string[]) => owners.map(owner => ({ owner }));

describe('why the tickets fell (#238)', () => {
  it('puts the ticket cost last on the death line, as a whole number', () => {
    expect(withTickets('전사했습니다', 1)).toBe('전사했습니다 · 티켓 -1');
    expect(withTickets('▲ VPA 단거리 지대공미사일 · 레이더 미사일 · 2.1km', 6)).toBe('▲ VPA 단거리 지대공미사일 · 레이더 미사일 · 2.1km · 티켓 -6');
    expect(withTickets('지형·장애물 충돌', 6.0000001)).toBe('지형·장애물 충돌 · 티켓 -6');
  });

  it('adds nothing for a death that cost no tickets', () => {
    expect(withTickets('전사했습니다', 0)).toBe('전사했습니다');
  });

  it('is behind only while holding fewer points than the enemy', () => {
    expect(behind(pts('coalition', 'neutral', 'veros'), 'coalition')).toBe(false);
    expect(behind(pts('coalition', 'veros', 'veros'), 'coalition')).toBe(true);
    expect(behind(pts('coalition', 'veros', 'veros'), 'veros')).toBe(false);
    expect(behind(pts('neutral', 'neutral', 'veros'), 'coalition')).toBe(true);
    expect(behind(pts('coalition', 'coalition', 'veros'), 'veros')).toBe(true);
  });

  it('calls the bleed once when it turns on us, and again after we drew level or led', () => {
    const call = new BehindCall(false);
    const run = (states: boolean[]) => states.map(s => call.step(s, true));
    expect(run([false, true, true, true])).toEqual([false, true, false, false]);
    expect(run([false, true])).toEqual([false, true]);
    expect(run([true, false, false, true, true])).toEqual([false, false, false, true, false]);
  });

  it('does not call a bleed that was already on when the HUD came up', () => {
    const call = new BehindCall(true);
    expect([true, true].map(s => call.step(s, true))).toEqual([false, false]);
  });

  it('waits for the radio slot, and drops the call if we are level again first', () => {
    const call = new BehindCall(false);
    expect(call.step(true, false)).toBe(false);
    expect(call.step(true, false)).toBe(false);
    expect(call.step(true, true)).toBe(true);
    expect(call.step(true, true)).toBe(false);
    const late = new BehindCall(false);
    expect(late.step(true, false)).toBe(false);
    expect(late.step(false, false)).toBe(false);
    expect(late.step(false, true)).toBe(false);
  });

  it('copies the losses so later changes do not reach the report', () => {
    const live = { bleed: 12.7, person: 30, vehicle: 18, player: 7 };
    const copy = lostTickets(live);
    live.person += 50;
    expect(copy).toEqual({ bleed: 12.7, person: 30, vehicle: 18, player: 7 });
  });

  it('writes the four losses rounded down', () => {
    expect(lostText({ bleed: 12.99, person: 30, vehicle: 18, player: 7 })).toBe('잃은 티켓: 거점 열세 12 · 병력 30 · 탈것 18 · 나 7');
    expect(lostText({ bleed: 0, person: 0, vehicle: 0, player: 0 })).toBe('잃은 티켓: 거점 열세 0 · 병력 0 · 탈것 0 · 나 0');
  });
});
