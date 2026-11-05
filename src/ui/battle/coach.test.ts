import { describe, expect, it } from 'vitest';
import { cardDevice, Coach, COACH_STEPS, deathTip, inCapturablePoint, initialRole, MIN_SHOW, STEP_TIMEOUT, WALK_STEP, type CoachFacts } from './coach';
import { hasString, t, tList } from '../../content/strings';

const base: CoachFacts = { agl: 60, tads: false, identified: 0, flips: 0, detected: 0, deaths: 0, playing: true, foot: false, walked: 0, shots: 0, inPoint: false };
const foot: CoachFacts = { ...base, foot: true };

function run(c: Coach, f: CoachFacts, seconds: number) {
  let id: string | null = null;
  for (let t = 0; t < seconds; t += 0.1) id = c.update(f, 0.1);
  return id;
}

describe('battle coach (wiki 8.10)', () => {
  it('walks the steps, advancing on the action or after 20 s', () => {
    const seen: string[] = [];
    const c = new Coach(new Set(), COACH_STEPS, id => seen.push(id));
    expect(run(c, base, 1)).toBe('rules.points');
    expect(run(c, base, STEP_TIMEOUT)).toBe('apache.collective');
    expect(run(c, { ...base, agl: 90 }, MIN_SHOW + 0.5)).toBe('apache.tads');
    expect(run(c, { ...base, agl: 90, tads: true }, MIN_SHOW + 0.5)).toBe('apache.identify');
    expect(run(c, { ...base, identified: 1 }, MIN_SHOW + 0.5)).toBe(null);
    expect(run(c, { ...base, flips: 1 }, 1)).toBe('rules.tickets');
    expect(seen).toEqual(['rules.points', 'apache.collective', 'apache.tads', 'apache.identify']);
  });

  it('never shows a step again once seen (saved tips)', () => {
    const tips = new Set<string>();
    const a = new Coach(tips);
    run(a, { ...base, flips: 1, detected: 1 }, 200);
    run(a, { ...foot, flips: 1, inPoint: true }, 200);
    expect([...tips].sort()).toEqual(COACH_STEPS.map(s => s.id).sort());
    const b = new Coach(new Set(tips));
    expect(run(b, { ...base, flips: 1, detected: 1 }, 30)).toBe(null);
  });

  it('shows nothing while the player is not playing', () => {
    expect(run(new Coach(new Set()), { ...base, playing: false }, 5)).toBe(null);
  });

  it('walks a soldier through moving, shooting and capturing, then leaves the Apache steps for later', () => {
    const tips = new Set<string>();
    const seen: string[] = [];
    const c = new Coach(tips, COACH_STEPS, id => seen.push(id));
    expect(run(c, foot, 1)).toBe('rules.points');
    expect(run(c, foot, STEP_TIMEOUT)).toBe('soldier.move');
    expect(run(c, { ...foot, walked: WALK_STEP - 1 }, MIN_SHOW + 0.5)).toBe('soldier.move');
    expect(run(c, { ...foot, walked: WALK_STEP }, MIN_SHOW + 0.5)).toBe('soldier.shoot');
    expect(run(c, { ...foot, walked: WALK_STEP, shots: 1 }, MIN_SHOW + 0.5)).toBe(null);
    expect(run(c, { ...foot, walked: WALK_STEP, shots: 1, inPoint: true }, 1)).toBe('soldier.capture');
    expect(run(c, { ...foot, walked: WALK_STEP, shots: 1 }, MIN_SHOW + 0.5)).toBe(null);
    expect(run(c, { ...foot, detected: 1 }, 5)).toBe(null);
    expect(seen).toEqual(['rules.points', 'soldier.move', 'soldier.shoot', 'soldier.capture']);
    const later = new Coach(new Set(tips));
    expect(run(later, foot, 30)).toBe(null);
    expect(run(later, base, 1)).toBe('apache.collective');
  });

  describe('capture banner waits for the circle (#229)', () => {
    const outside = (t: number): CoachFacts => ({ ...foot, walked: t * 5, shots: Math.floor(t / 5) });

    function walkOutside(c: Coach, seconds: number) {
      let id: string | null = null;
      for (let t = 0; t < seconds; t += 0.1) id = c.update(outside(t), 0.1);
      return id;
    }

    it('shows on the first entry 90 s after the sortie', () => {
      const c = new Coach(new Set());
      expect(walkOutside(c, 90)).toBe(null);
      expect(c.update({ ...outside(90), inPoint: true }, 0.1)).toBe('soldier.capture');
    });

    it('records nothing until the player has been inside', () => {
      const recorded: string[] = [];
      const tips = new Set<string>();
      const c = new Coach(tips, COACH_STEPS, id => recorded.push(id));
      walkOutside(c, 600);
      expect(tips.has('soldier.capture')).toBe(false);
      expect(recorded).not.toContain('soldier.capture');
      c.update({ ...outside(600), inPoint: true }, 0.1);
      expect(tips.has('soldier.capture')).toBe(false);
      run(c, { ...outside(600), inPoint: true }, STEP_TIMEOUT + 1);
      expect(tips.has('soldier.capture')).toBe(true);
      expect(recorded).toContain('soldier.capture');
    });

    it('stays up while the player holds the circle, then times out', () => {
      const c = new Coach(new Set(['rules.points', 'soldier.move', 'soldier.shoot']));
      const inside = { ...foot, inPoint: true };
      expect(run(c, inside, STEP_TIMEOUT - 1)).toBe('soldier.capture');
      expect(run(c, inside, 2)).toBe(null);
    });

    it('stays up for the minimum when the player only passes through', () => {
      const c = new Coach(new Set(['rules.points', 'soldier.move', 'soldier.shoot']));
      expect(c.update({ ...foot, inPoint: true }, 0.1)).toBe('soldier.capture');
      expect(run(c, foot, MIN_SHOW - 0.5)).toBe('soldier.capture');
      expect(run(c, foot, 1)).toBe(null);
    });

    it('stays hidden on a save that already recorded it', () => {
      const c = new Coach(new Set(['rules.points', 'soldier.move', 'soldier.shoot', 'soldier.capture']));
      expect(run(c, { ...foot, inPoint: true }, 30)).toBe(null);
    });

    it('stays hidden in a helicopter over a circle', () => {
      const c = new Coach(new Set(['rules.points', 'apache.collective', 'apache.tads', 'apache.identify']));
      expect(run(c, { ...base, inPoint: true }, 30)).toBe(null);
    });

    it('counts only circles the side does not own yet', () => {
      const points = [
        { x: 0, z: 0, radius: 50, owner: 'coalition' },
        { x: 500, z: 0, radius: 50, owner: 'neutral' },
        { x: 1000, z: 0, radius: 50, owner: 'veros' },
      ] as const;
      expect(inCapturablePoint(points, 'coalition', 0, 0)).toBe(false);
      expect(inCapturablePoint(points, 'coalition', 500, 0)).toBe(true);
      expect(inCapturablePoint(points, 'coalition', 1000, 50)).toBe(true);
      expect(inCapturablePoint(points, 'coalition', 1000, 51)).toBe(false);
      expect(inCapturablePoint(points, 'veros', 0, 0)).toBe(true);
      expect(inCapturablePoint(points, 'veros', 500, 0)).toBe(true);
      expect(inCapturablePoint(points, 'veros', 1000, 0)).toBe(false);
    });
  });

  it('has a string for every step and tip', () => {
    for (const s of COACH_STEPS) expect(hasString(`battle.coach.${s.id}`), s.id).toBe(true);
    for (const r of ['crewKilled', 'terrain', 'outOfBounds', 'hardLanding', undefined]) expect(hasString(deathTip(r, false))).toBe(true);
    expect(hasString(deathTip('crewKilled', true))).toBe(true);
  });

  it('gives a soldier killed by enemy fire an infantry tip, even right after a missile hit', () => {
    expect(deathTip('killed', false)).toBe('battle.tips.soldier');
    expect(deathTip('killed', true)).toBe('battle.tips.soldier');
    const line = t(deathTip('killed', false));
    expect(line).not.toBe('battle.tips.soldier');
    expect(line).not.toMatch(/대공|팝업/);
  });

  it('keeps the helicopter death tips', () => {
    expect(deathTip('crewKilled', false)).toBe('battle.tips.fire');
    expect(deathTip('rotorLoss', false)).toBe('battle.tips.fire');
    expect(deathTip('crewKilled', true)).toBe('battle.tips.missile');
    expect(deathTip('rotorLoss', true)).toBe('battle.tips.missile');
    expect(t('battle.tips.fire')).toBe('적 대공에 맞았습니다 — 거점 위에서 오래 떠 있지 말고 능선 뒤에서 팝업하세요');
    expect(t('battle.tips.missile')).toBe('적외선 미사일 — 경보가 울리면 플레어(F · 플레어 버튼)');
  });

  it('picks the control card for the device in hand, with a line set for each', () => {
    expect(cardDevice(true, [{ connected: true }])).toBe('touch');
    expect(cardDevice(false, [null, { connected: true }])).toBe('pad');
    expect(cardDevice(false, [null, { connected: false }])).toBe('keyboard');
    for (const role of ['apache', 'soldier']) for (const d of ['keyboard', 'touch', 'pad']) expect(tList(`battle.card.${role}.${d}`)).toHaveLength(3);
  });
});

describe('initial role on the deploy screen (#226)', () => {
  it('starts on foot until a sortie says otherwise', () => {
    expect(initialRole('coalition', undefined)).toBe('soldier');
  });

  it('keeps the role of the last sortie', () => {
    expect(initialRole('coalition', 'soldier')).toBe('soldier');
    expect(initialRole('coalition', 'heli')).toBe('heli');
  });

  it('stays on foot for the VPA, which has no helicopter to choose', () => {
    expect(initialRole('veros', undefined)).toBe('soldier');
    expect(initialRole('veros', 'soldier')).toBe('soldier');
    expect(initialRole('veros', 'heli')).toBe('soldier');
  });
});
