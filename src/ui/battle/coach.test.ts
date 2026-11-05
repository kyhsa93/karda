import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardDevice, Coach, COACH_STEPS, coachText, deathTip, inCapturablePoint, initialRole, MIN_SHOW, nearestOpenPoint, STEP_TIMEOUT, WALK_STEP, type CoachFacts } from './coach';
import { hasString, t, tList } from '../../content/strings';
import { SOLDIER_COMMANDS } from '../../input/roles';
import type { Command } from '../../input/bindings';
import harek from '../../content/battle/maps/harek.json';

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
    expect(run(c, { ...foot, walked: WALK_STEP, shots: 1, inPoint: true }, 1)).toBe('soldier.captureZone');
    expect(run(c, { ...foot, walked: WALK_STEP, shots: 1 }, MIN_SHOW + 0.5)).toBe(null);
    expect(run(c, { ...foot, detected: 1 }, 5)).toBe(null);
    expect(seen).toEqual(['rules.points', 'soldier.move', 'soldier.shoot', 'soldier.captureZone']);
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
      expect(c.update({ ...outside(90), inPoint: true }, 0.1)).toBe('soldier.captureZone');
    });

    it('records nothing until the player has been inside', () => {
      const recorded: string[] = [];
      const tips = new Set<string>();
      const c = new Coach(tips, COACH_STEPS, id => recorded.push(id));
      walkOutside(c, 600);
      expect(tips.has('soldier.captureZone')).toBe(false);
      expect(recorded).not.toContain('soldier.captureZone');
      c.update({ ...outside(600), inPoint: true }, 0.1);
      expect(tips.has('soldier.captureZone')).toBe(false);
      run(c, { ...outside(600), inPoint: true }, STEP_TIMEOUT + 1);
      expect(tips.has('soldier.captureZone')).toBe(true);
      expect(recorded).toContain('soldier.captureZone');
    });

    it('stays up while the player holds the circle, then times out', () => {
      const c = new Coach(new Set(['rules.points', 'soldier.move', 'soldier.shoot']));
      const inside = { ...foot, inPoint: true };
      expect(run(c, inside, STEP_TIMEOUT - 1)).toBe('soldier.captureZone');
      expect(run(c, inside, 2)).toBe(null);
    });

    it('stays up for the minimum when the player only passes through', () => {
      const c = new Coach(new Set(['rules.points', 'soldier.move', 'soldier.shoot']));
      expect(c.update({ ...foot, inPoint: true }, 0.1)).toBe('soldier.captureZone');
      expect(run(c, foot, MIN_SHOW - 0.5)).toBe('soldier.captureZone');
      expect(run(c, foot, 1)).toBe(null);
    });

    it('stays hidden on a save that already recorded it', () => {
      const c = new Coach(new Set(['rules.points', 'soldier.move', 'soldier.shoot', 'soldier.captureZone']));
      expect(run(c, { ...foot, inPoint: true }, 30)).toBe(null);
    });

    it('shows once more on a save that recorded the old id, then never again', () => {
      const tips = new Set(['rules.points', 'soldier.move', 'soldier.shoot', 'soldier.capture']);
      const recorded: string[] = [];
      const c = new Coach(tips, COACH_STEPS, id => recorded.push(id));
      const inside = { ...foot, inPoint: true };
      expect(run(c, foot, 30)).toBe(null);
      expect(c.update(inside, 0.1)).toBe('soldier.captureZone');
      run(c, inside, STEP_TIMEOUT + 1);
      expect(recorded).toEqual(['soldier.captureZone']);
      const next = new Coach(new Set(tips));
      expect(run(next, inside, 30)).toBe(null);
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

describe('first coach line says how to win and where to go (#230)', () => {
  type Mode = 'quick' | 'conquest';
  const open = (mode: Mode, overrides: Record<string, string> = {}) => harek.modes[mode].points.map(id => {
    const p = harek.points.find(q => q.id === id)!;
    return { id, x: p.position[0], z: p.position[1], owner: overrides[id] ?? (harek.modes[mode].start as Record<string, string>)[id] };
  });
  const at = (id: string) => { const p = harek.points.find(q => q.id === id)!; return { x: p.position[0], z: p.position[1] }; };
  const SIDES = ['coalition', 'veros'] as const;
  const MOBILE_LINE = 28;

  it('names the nearest point the side does not own, for both sides', () => {
    const quick = open('quick');
    expect(nearestOpenPoint(quick, 'coalition', at('A').x, at('A').z)).toBe('D');
    expect(nearestOpenPoint(quick, 'veros', at('G').x, at('G').z)).toBe('D');
    const rally = harek.modes.quick.rally;
    expect(nearestOpenPoint(quick, 'coalition', rally.coalition[0], rally.coalition[1])).toBe('D');
    expect(nearestOpenPoint(quick, 'veros', rally.veros[0], rally.veros[1])).toBe('D');
    const conquest = open('conquest');
    expect(nearestOpenPoint(conquest, 'coalition', at('A').x, at('A').z)).toBe('C');
    expect(nearestOpenPoint(conquest, 'veros', at('G').x, at('G').z)).toBe('E');
  });

  it('counts enemy and neutral points alike and skips the ones already held', () => {
    expect(nearestOpenPoint(open('quick', { D: 'coalition' }), 'coalition', at('D').x, at('D').z)).toBe('G');
    expect(nearestOpenPoint(open('quick', { D: 'veros' }), 'veros', at('D').x, at('D').z)).toBe('A');
    expect(nearestOpenPoint(open('quick', { D: 'veros' }), 'coalition', at('A').x, at('A').z)).toBe('D');
  });

  it('finds no target once every point is held, for both sides', () => {
    expect(nearestOpenPoint(open('quick', { A: 'coalition', D: 'coalition', G: 'coalition' }), 'coalition', 0, 0)).toBe(null);
    expect(nearestOpenPoint(open('quick', { A: 'veros', D: 'veros', G: 'veros' }), 'veros', 0, 0)).toBe(null);
  });

  for (const side of SIDES) {
    it(`puts the target first and the win condition after it for ${side}`, () => {
      const line = coachText('rules.points', side, 'D');
      expect(line.startsWith('D ')).toBe(true);
      expect(line).toContain('적 티켓 0이면 승리');
    });

    it(`still reads as a sentence with no target for ${side}`, () => {
      const line = coachText('rules.points', side, null);
      expect(line).not.toMatch(/[{}]|undefined|null/);
      expect(line.startsWith(' ')).toBe(false);
      expect(line.startsWith('거점을 지키세요')).toBe(true);
      expect(line).toContain('적 티켓 0이면 승리');
    });

    it(`keeps the point symbol legend with the sides the right way round for ${side}`, () => {
      const [own, enemy] = side === 'coalition' ? ['■', '▲'] : ['▲', '■'];
      for (const target of ['D', null]) {
        const line = coachText('rules.points', side, target);
        expect(line).toContain(`${own} 아군`);
        expect(line).toContain(`${enemy} 적`);
        expect(line).toContain('○ 중립');
        expect(line).toContain('× 교전');
      }
    });

    it(`breaks into two lines of at most 28 characters for ${side}`, () => {
      for (const target of ['D', null]) {
        const lines = coachText('rules.points', side, target).split('\n');
        expect(lines).toHaveLength(2);
        for (const l of lines) expect([...l].length).toBeLessThanOrEqual(MOBILE_LINE);
      }
    });
  }

  it('honours the line break in the coach box', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8');
    expect(css).toMatch(/(^|\n)\.coach \{[^}]*white-space: pre-line;/);
  });

  it('leaves every other step without a target untouched', () => {
    expect(coachText('soldier.move', 'coalition', null)).toBe(t('battle.coach.soldier.move'));
    expect(coachText('rules.tickets', 'veros', 'D')).toBe(t('battle.coach.rules.tickets'));
  });

  it('adds no step and keeps the rules line first', () => {
    expect(COACH_STEPS).toHaveLength(9);
    expect(COACH_STEPS[0].id).toBe('rules.points');
  });

  it('names the head control on the keyboard and pad soldier cards', () => {
    expect(tList('battle.card.soldier.keyboard').join(' ')).toContain('마우스로 고개');
    expect(tList('battle.card.soldier.pad').join(' ')).toContain('오른쪽 스틱 고개');
    expect(tList('battle.card.soldier.touch').join(' ')).toContain('화면 드래그로 고개');
  });
});

describe('soldier control card names the gear (#208)', () => {
  const items = (device: string) => tList(`battle.card.soldier.${device}`).flatMap(l => l.split(' · '));
  const KEY_ITEMS: Readonly<Record<string, Command>> = {
    '앉기': 'crouch', '엎드리기': 'prone', '재장전': 'reload', '소총': 'weapon1', '유탄': 'weapon2',
    '적 표시': 'spot', [t('touch.medkit')]: 'medkit', [t('touch.smoke')]: 'smoke',
  };

  it('lists the medkit and smoke keys on the keyboard card', () => {
    expect(items('keyboard')).toEqual(expect.arrayContaining(['X 구급 상자', 'F 연막']));
  });

  it('prints every single key the way SOLDIER_COMMANDS binds it', () => {
    const printed = items('keyboard').flatMap(i => /^\S /.test(i) ? [[i[0], i.slice(2)]] : []);
    expect(printed.map(([, label]) => label).sort()).toEqual(Object.keys(KEY_ITEMS).sort());
    for (const [key, label] of printed) {
      expect(SOLDIER_COMMANDS[`${/\d/.test(key) ? 'Digit' : 'Key'}${key}`], `${key} ${label}`).toBe(KEY_ITEMS[label]);
    }
  });

  it('names the touch buttons as they are labelled', () => {
    expect(items('touch')).toEqual(expect.arrayContaining([t('touch.medkit'), t('touch.smoke')]));
  });

  describe('pad card matches the pad bindings (#300)', () => {
    const PAD_BUTTONS: Readonly<Record<string, number>> = { A: 0, B: 1, X: 2, LB: 4, RB: 5, LT: 6, RT: 7, L3: 10, '십자 ↑': 12, '←': 14, '→': 15 };
    const PAD_COMMANDS: Readonly<Record<string, Command>> = {
      '재장전': 'reload', '앉기': 'crouch', '소총': 'weapon1', '유탄': 'weapon2', '적 표시': 'spot',
      [t('touch.medkit')]: 'medkit', [t('touch.smoke')]: 'smoke',
    };
    const PAD_HELD: Readonly<Record<string, 'sprint' | 'jump' | 'fire' | 'ads'>> = { '질주': 'sprint', '넘기': 'jump', '사격': 'fire', '조준': 'ads' };
    const printed = () => items('pad').filter(i => !i.includes('스틱')).map(i => {
      const [, key, label] = /^(십자 \S+|\S+) (.+)$/.exec(i) ?? [];
      return [key, label];
    });

    async function press(button: number) {
      const { World } = await import('../../sim/world');
      const { FlightInput } = await import('../../input/input');
      const w = new World({ seed: 3 });
      w.active = true;
      w.spawnAvatar({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' });
      const input = new FlightInput();
      const commands: Command[] = [];
      input.onCommand = c => commands.push(c);
      input.gamepads = () => [{ connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === button })) }];
      input.update(w, 0.05);
      return { commands, soldier: w.soldierCommands };
    }

    it('prints every item the pad card can name', () => {
      expect(printed().map(([, label]) => label).sort()).toEqual([...Object.keys(PAD_COMMANDS), ...Object.keys(PAD_HELD)].sort());
    });

    it('does what each printed pad item says', async () => {
      for (const [key, label] of printed()) {
        const button = PAD_BUTTONS[key];
        expect(button, key).toBeTypeOf('number');
        const { commands, soldier } = await press(button);
        if (PAD_HELD[label]) expect(soldier[PAD_HELD[label]], `${key} ${label}`).toBe(true);
        else expect(commands, `${key} ${label}`).toEqual([PAD_COMMANDS[label]]);
      }
    });

    it('prints every pad button that does something, except pause and the unused enter', async () => {
      const onCard = new Set(printed().map(([key]) => PAD_BUTTONS[key]));
      for (let i = 0; i < 17; i++) {
        const { commands } = await press(i);
        if (i === 3) expect(commands).toEqual(['enter']);
        else if (i === 9) expect(commands).toEqual(['pause']);
        else if (commands.length) expect(onCard.has(i), `button ${i} ${commands}`).toBe(true);
      }
    });
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
