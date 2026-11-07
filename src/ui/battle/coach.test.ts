import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardDevice, cardKey, clearOfAll, Coach, coachDimmed, COACH_STEPS, coachText, controlCard, DEATH_TIPS, deadTip, deathTip, inCapturablePoint, initialRole, MARK_OVERLAP_MIN_PX, MARK_PANEL_GAP_PX, MARK_ROW_PX, MARK_STALE_MS, MIN_SHOW, nearestOpenPoint, pointMarkBox, PointMarkBoard, STEP_TIMEOUT, WALK_STEP, type Box, type CoachFacts } from './coach';
import { hasString, t, tList } from '../../content/strings';
import { SOLDIER_COMMANDS, SOLDIER_KEYS } from '../../input/roles';
import { CLASS_KITS } from '../../sim/infantry/arms';
import { gearButtons } from './hud/soldierStatus';
import type { World } from '../../sim/world';
import type { Command } from '../../input/bindings';
import harek from '../../content/battle/maps/harek.json';
import strings from '../../content/strings.ko.json';
import type { CrashReason } from '../../sim/events';
import { deathLine, type DeathHit } from './deathReport';

const KINDS = ['ir', 'radar'] as const;
const MISSILE_TIP = { ir: 'battle.tips.missile', radar: 'battle.tips.missileRadar' } as const;

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
    for (const r of ['crewKilled', 'terrain', 'outOfBounds', 'hardLanding', undefined] as const) expect(hasString(deathTip(r, null))).toBe(true);
    for (const k of KINDS) expect(hasString(deathTip('crewKilled', k)), k).toBe(true);
  });

  it('gives a soldier killed by enemy fire an infantry tip, even right after a missile hit', () => {
    expect(deathTip('killed', null)).toBe('battle.tips.soldier');
    for (const k of KINDS) expect(deathTip('killed', k), k).toBe('battle.tips.soldier');
    const line = t(deathTip('killed', null));
    expect(line).not.toBe('battle.tips.soldier');
    expect(line).not.toMatch(/대공|팝업/);
  });

  it('gives a soldier who dies from a fall a fall tip, not an air-defense one (#296)', () => {
    expect(deathTip('fall', null)).toBe('battle.tips.fall');
    for (const k of KINDS) expect(deathTip('fall', k), k).toBe('battle.tips.fall');
    expect(t('battle.tips.fall')).toBe('가파른 내리막은 돌아서 내려가세요 — 체력이 적으면 낮은 곳도 치명적입니다');
    expect(t(deathTip('fall', null))).not.toMatch(/대공|팝업|미사일|플레어|추락/);
  });

  it('names a tip for every crash reason and keeps the others as they were (#296)', () => {
    const reasons = Object.keys(strings.crash).filter(k => k !== 'title' && k !== 'retry') as CrashReason[];
    expect(Object.keys(DEATH_TIPS).sort()).toEqual([...reasons].sort());
    for (const r of reasons) expect(hasString(DEATH_TIPS[r]), r).toBe(true);
    expect(DEATH_TIPS).toEqual({
      crewKilled: 'battle.tips.fire', rotorLoss: 'battle.tips.fire', terrain: 'battle.tips.terrain', tree: 'battle.tips.terrain', building: 'battle.tips.terrain',
      rotorStrike: 'battle.tips.terrain', water: 'battle.tips.terrain', outOfBounds: 'battle.tips.zone', hardLanding: 'battle.tips.landing',
      slideLanding: 'battle.tips.landing', tiltLanding: 'battle.tips.landing', slope: 'battle.tips.landing', ditched: 'battle.tips.terrain',
      killed: 'battle.tips.soldier', fall: 'battle.tips.fall',
    });
    for (const r of reasons) expect(deathTip(r, null), r).toBe(DEATH_TIPS[r]);
    for (const k of KINDS) for (const r of reasons) expect(deathTip(r, k), `${r}/${k}`).toBe(r === 'killed' || r === 'fall' ? DEATH_TIPS[r] : MISSILE_TIP[k]);
    expect(deathTip(undefined, null)).toBe('battle.tips.fire');
    for (const k of KINDS) expect(deathTip(undefined, k), k).toBe(MISSILE_TIP[k]);
  });

  it('never opens a death tip with any piece of the death line it sits under (#313, #298)', () => {
    const values: Record<CrashReason, number | undefined> = {
      rotorStrike: undefined, terrain: undefined, water: undefined, tree: undefined, building: undefined, ditched: undefined,
      hardLanding: 4.2, slideLanding: 3.1, tiltLanding: undefined, slope: undefined, rotorLoss: undefined, crewKilled: undefined,
      outOfBounds: undefined, killed: undefined, fall: undefined,
    };
    const reasons = Object.keys(values) as CrashReason[];
    expect(reasons.sort()).toEqual(Object.keys(strings.crash).filter(k => k !== 'title' && k !== 'retry').sort());
    const hits: [string, DeathHit | null][] = [
      ['none', null],
      ['shooter', { side: 'veros', defId: 'inf', weapon: 'g_rifle', dist: 120 }],
      ['weapon', { weapon: 'g_rifle', dist: 120 }],
      ['ir', { side: 'veros', defId: 'manpads', weapon: 'missile_ir', dist: 1300 }],
      ['radar', { side: 'veros', defId: 'sam_short', weapon: 'missile_radar', dist: 1500 }],
      ...Object.keys(strings.battle.death.weapon).map(weapon => [weapon, { weapon, dist: 120 }] as [string, DeathHit]),
    ];
    const head = (tip: string) => tip.split('—')[0].replace(/\s+/g, ' ').trim();
    const repeats: string[] = [];
    for (const reason of reasons) for (const [hit, info] of hits) for (const missile of [null, ...KINDS]) {
      const pieces = deathLine(reason, values[reason], info).split(' · ').map(p => p.trim());
      const tip = head(t(deathTip(reason, missile)));
      for (const piece of pieces) if (tip.includes(piece)) repeats.push(`${reason}/${hit}/${missile}: ${piece}`);
    }
    expect(repeats).toEqual([]);
  });

  it('keeps the helicopter death tips', () => {
    expect(deathTip('crewKilled', null)).toBe('battle.tips.fire');
    expect(deathTip('rotorLoss', null)).toBe('battle.tips.fire');
    expect(deathTip('crewKilled', 'ir')).toBe('battle.tips.missile');
    expect(deathTip('rotorLoss', 'ir')).toBe('battle.tips.missile');
    expect(deathTip('crewKilled', 'radar')).toBe('battle.tips.missileRadar');
    expect(deathTip('rotorLoss', 'radar')).toBe('battle.tips.missileRadar');
    expect(t('battle.tips.fire')).toBe('적 대공에 맞았습니다 — 거점 위에서 오래 떠 있지 말고 능선 뒤에서 팝업하세요');
  });

  it('tells an infrared missile death to flare and a radar one to chaff, never the other (#298)', () => {
    expect(t('battle.tips.missile')).toBe('미사일 경보가 울리면 바로 플레어(F · 플레어 버튼)');
    expect(t('battle.tips.missileRadar')).toBe('미사일 경보가 울리면 바로 채프(X · 채프 버튼)');
    for (const r of ['crewKilled', 'rotorLoss', undefined] as const) {
      expect(t(deathTip(r, 'ir'))).not.toContain('채프');
      expect(t(deathTip(r, 'radar'))).not.toContain('플레어');
      expect(t(deathTip(r, null))).not.toMatch(/플레어|채프/);
    }
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

describe('control card follows the class (#304)', () => {
  const CLASSES = ['assault', 'engineer', 'support', 'recon'] as const;
  type Cls = typeof CLASSES[number];
  const DEVICES = ['keyboard', 'touch', 'pad'] as const;
  const TITLES: Record<Cls, string> = { assault: '돌격병 조작', engineer: '공병 조작', support: '지원병 조작', recon: '정찰병 조작' };
  const GEAR_NAME: Record<string, string> = {
    grenade: t('touch.toGrenade'), at_rocket: t('touch.toRocket'),
    medkit: t('touch.medkit'), smoke: t('touch.smoke'), repair: t('touch.repair'), mine: t('touch.mine'),
  };
  const HOLD = '누른 채 ';
  const HELD_TOOLS = new Set(['repair']);
  const lines = (cls: Cls, device: string) => tList(`battle.card.${cardKey('soldier', cls)}.${device}`);
  const items = (cls: Cls, device: string) => lines(cls, device).flatMap(l => l.split(' · '));
  const kit = (cls: Cls) => CLASS_KITS[cls];
  const carried = (cls: Cls) => [...kit(cls).gear, ...kit(cls).tools] as string[];
  const gearItem = (id: string) => `${HELD_TOOLS.has(id) ? HOLD : ''}${GEAR_NAME[id]}`;
  const pressedLabels = (cls: Cls): Record<string, Command> => ({
    '앉기': 'crouch', '엎드리기': 'prone', '재장전': 'reload', '적 표시': 'spot',
    ...(kit(cls).gear.length ? { [t(`battle.hud.weapon.${kit(cls).primary}`)]: 'weapon1', [GEAR_NAME[kit(cls).gear[0]]]: 'weapon2' } : {}),
    ...Object.fromEntries(kit(cls).tools.filter(id => !HELD_TOOLS.has(id)).map(id => [GEAR_NAME[id], id as Command])),
  });
  const heldTools = (cls: Cls) => kit(cls).tools.filter(id => HELD_TOOLS.has(id)).map(id => GEAR_NAME[id]);

  const worlds = new Map<Cls, World>();
  async function soldier(cls: Cls) {
    const { World } = await import('../../sim/world');
    if (!worlds.has(cls)) {
      const w = new World({ seed: 3 });
      w.active = true;
      w.spawnAvatar({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls });
      worlds.set(cls, w);
    }
    return worlds.get(cls)!;
  }

  it('titles the card with the class and leaves the helicopter card alone', () => {
    for (const cls of CLASSES) {
      expect(t(`battle.card.${cardKey('soldier', cls)}.title`)).toBe(TITLES[cls]);
      expect(cardKey('heli', cls)).toBe('apache');
    }
    expect(cardKey('soldier', 'assault')).toBe('soldier');
  });

  it('keeps three lines on every device, with the movement and look lines the same for every class', () => {
    for (const cls of CLASSES) for (const d of DEVICES) {
      expect(lines(cls, d), `${cls} ${d}`).toHaveLength(3);
      expect(lines(cls, d).slice(0, 2), `${cls} ${d}`).toEqual(lines('assault', d).slice(0, 2));
    }
  });

  it('names the gear the class carries and none it does not, for 4 classes × 3 inputs', () => {
    for (const cls of CLASSES) for (const d of DEVICES) {
      const text = lines(cls, d).join(' · '), on = items(cls, d);
      for (const id of carried(cls)) expect(on.some(i => i === gearItem(id) || i.endsWith(` ${gearItem(id)}`)), `${cls} ${d} ${id}`).toBe(true);
      for (const id of Object.keys(GEAR_NAME).filter(id => !carried(cls).includes(id))) expect(text, `${cls} ${d} ${id}`).not.toContain(GEAR_NAME[id]);
      if (d !== 'touch') expect(on.some(i => i.endsWith(` ${t(`battle.hud.weapon.${kit(cls).primary}`)}`)), `${cls} ${d} primary`).toBe(kit(cls).gear.length > 0);
    }
  });

  it('prints every keyboard key the way SOLDIER_COMMANDS and SOLDIER_KEYS bind it, for every class', () => {
    for (const cls of CLASSES) {
      const printed = items(cls, 'keyboard').flatMap(i => /^\S /.test(i) ? [[i[0], i.slice(2)]] : []);
      const pressed = printed.filter(([, label]) => !label.startsWith(HOLD)), held = printed.filter(([, label]) => label.startsWith(HOLD));
      expect(pressed.map(([, label]) => label).sort(), cls).toEqual(Object.keys(pressedLabels(cls)).sort());
      expect(held.map(([, label]) => label.slice(HOLD.length)), cls).toEqual(heldTools(cls));
      for (const [key, label] of pressed) expect(SOLDIER_COMMANDS[`${/\d/.test(key) ? 'Digit' : 'Key'}${key}`], `${cls} ${key} ${label}`).toBe(pressedLabels(cls)[label]);
      for (const [key] of held) expect(SOLDIER_KEYS.repair as readonly string[], `${cls} ${key}`).toContain(`Key${key}`);
    }
  });

  describe('pad card matches the pad bindings of each class (#302)', () => {
    const PAD_BUTTONS: Readonly<Record<string, number>> = { A: 0, B: 1, X: 2, LB: 4, RB: 5, LT: 6, RT: 7, L3: 10, '십자 ↑': 12, '←': 14, '→': 15 };
    const PAD_HELD: Readonly<Record<string, 'sprint' | 'jump' | 'fire' | 'ads' | 'repair'>> = { '질주': 'sprint', '넘기': 'jump', '사격': 'fire', '조준': 'ads', [`${HOLD}${t('touch.repair')}`]: 'repair' };
    const printed = (cls: Cls) => items(cls, 'pad').filter(i => !i.includes('스틱')).map(i => {
      const [, key, label] = /^(십자 \S+|\S+) (.+)$/.exec(i) ?? [];
      return [key, label] as const;
    });

    async function press(cls: Cls, button: number) {
      const w = await soldier(cls);
      const { FlightInput } = await import('../../input/input');
      const input = new FlightInput();
      const commands: Command[] = [];
      input.onCommand = c => commands.push(c);
      input.gamepads = () => [{ connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === button })) }];
      input.update(w, 0.05);
      const switches = Object.keys(w.soldierArms.ammo).length > 1;
      return { commands: commands.filter(c => switches || (c !== 'weapon1' && c !== 'weapon2')), soldier: w.soldierCommands };
    }

    it('does what each printed pad item says, and prints no tool the class lacks', async () => {
      for (const cls of CLASSES) {
        const labels = printed(cls).map(([, label]) => label);
        expect(labels.filter(l => !PAD_HELD[l]).sort(), cls).toEqual(Object.keys(pressedLabels(cls)).filter(l => l !== '엎드리기').sort());
        expect(labels.filter(l => l.startsWith(HOLD)).map(l => l.slice(HOLD.length)), cls).toEqual(heldTools(cls));
        for (const [key, label] of printed(cls)) {
          const button = PAD_BUTTONS[key];
          expect(button, `${cls} ${key}`).toBeTypeOf('number');
          const { commands, soldier: s } = await press(cls, button);
          if (PAD_HELD[label]) expect(s[PAD_HELD[label]], `${cls} ${key} ${label}`).toBe(true);
          else expect(commands, `${cls} ${key} ${label}`).toEqual([pressedLabels(cls)[label]]);
        }
      }
    });

    it('prints every pad button that does something for the class, except pause and the unused enter', async () => {
      for (const cls of CLASSES) {
        const onCard = new Set(printed(cls).map(([key]) => PAD_BUTTONS[key]));
        for (let i = 0; i < 17; i++) {
          const { commands, soldier: s } = await press(cls, i);
          const acts = commands.length > 0 || Object.values(PAD_HELD).some(f => s[f]);
          if (i === 3) expect(commands).toEqual(['enter']);
          else if (i === 9) expect(commands).toEqual(['pause']);
          else expect(onCard.has(i), `${cls} button ${i} ${commands}`).toBe(acts);
        }
      }
    });
  });

  it('names the touch gear buttons as they are labelled and drawn for each class (#233)', async () => {
    for (const cls of CLASSES) {
      const w = await soldier(cls), b = gearButtons(w), switches = Object.keys(w.soldierArms.ammo).length > 1;
      const drawn = [
        ...(switches ? [b.swap.replace(/ \d+$/, '')] : []),
        t('touch.reload'),
        ...(b.medkit ? [t('touch.medkit')] : []),
        ...(b.repair ? [`${HOLD}${t('touch.repair')}`] : []),
        ...(b.mine ? [t('touch.mine')] : []),
        ...(b.smoke ? [t('touch.smoke')] : []),
      ];
      for (const name of drawn.filter(n => n !== t('touch.reload'))) {
        const label = [b.swap, b.medkit, b.repair, b.mine, b.smoke].find(l => l?.startsWith(name.replace(HOLD, '')));
        expect(label, `${cls} ${name}`).toBeTruthy();
      }
      const third = lines(cls, 'touch')[2].split(' · ');
      expect(third.slice(0, 2), cls).toEqual(lines('assault', 'touch')[2].split(' · ').slice(0, 2));
      expect(third.slice(2), cls).toEqual(drawn);
    }
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

describe('respawn line next to the first control card (#307)', () => {
  it('shows the line after a death until it has been seen, and records it on that sortie', () => {
    expect(deadTip(0, false, false)).toBe(false);
    expect(deadTip(1, false, false)).toBe(true);
    expect(deadTip(3, false, false)).toBe(true);
    expect(deadTip(1, true, false)).toBe(false);
  });

  it('leaves the line out and unrecorded while a control card is on screen', () => {
    expect(deadTip(1, false, true)).toBe(false);
    expect(deadTip(0, false, true)).toBe(false);
    expect(deadTip(1, true, true)).toBe(false);
  });

  it('shows the card for a role not flown yet', () => {
    expect(controlCard('heli', [])).toBe(true);
    expect(controlCard('soldier', [])).toBe(true);
    expect(controlCard('heli', ['card.apache'])).toBe(false);
    expect(controlCard('soldier', ['card.soldier'])).toBe(false);
    expect(controlCard('heli', ['card.soldier'])).toBe(true);
  });

  it('brings the line back when a role switch takes the card away, and drops it again on switching back', () => {
    for (const [tips, fresh, flown] of [[['card.apache'], 'soldier', 'heli'], [['card.soldier'], 'heli', 'soldier']] as const) {
      expect(deadTip(1, false, controlCard(fresh, tips))).toBe(false);
      expect(deadTip(1, false, controlCard(flown, tips))).toBe(true);
      expect(deadTip(1, false, controlCard(fresh, tips))).toBe(false);
    }
  });

  it('shows the line at the next death, once the card was seen on the sortie before', () => {
    const tips = ['card.apache', 'card.soldier'];
    expect(deadTip(2, tips.includes('rules.dead'), controlCard('soldier', tips))).toBe(true);
    expect(deadTip(2, tips.includes('rules.dead'), controlCard('heli', tips))).toBe(true);
  });
});

describe('coach over a point mark (#295)', () => {
  const COACH: Box = { left: 290, right: 480, top: 116, bottom: 160 };
  const board = (boxes: Box[], at = 1000) => {
    const b = new PointMarkBoard();
    b.publish(boxes, at);
    return b;
  };

  it('boxes a mark from its drawn x, y and text width with the 13px font and 3px border', () => {
    expect(pointMarkBox(422, 165.2, 66)).toEqual({ left: 389, right: 455, top: 157.2, bottom: 173.2 });
  });

  it.each([
    ['667x375 helicopter first view, 9.2px over', 333.5, 158.8, 66, true],
    ['844x390 helicopter first view, 2.8px over', 422, 165.2, 66, false],
    ['932x430 helicopter with the head down, 4.0px over', 466, 164, 66, false],
    ['932x430 helicopter first view', 466, 182.1, 66, false],
    ['667x375 soldier facing D', 333.5, 136.1, 64, true],
    ['844x390 soldier facing D', 422, 141.6, 64, true],
    ['932x430 soldier facing D', 466, 156.1, 64, true],
    ['844x390 soldier first view', 638.3, 126.4, 64, false],
  ])('judges the measured %s', (_, x, y, width, dims) => {
    expect(coachDimmed(COACH, board([pointMarkBox(x, y, width)]), 1000)).toBe(dims);
  });

  it('dims for any mark on the coach and not for marks that only touch its edge', () => {
    const away = pointMarkBox(100, 300, 60);
    expect(coachDimmed(COACH, board([away, pointMarkBox(400, 140, 60)]), 1000)).toBe(true);
    expect(coachDimmed(COACH, board([{ left: 480, right: 540, top: 120, bottom: 136 }, { left: 300, right: 360, top: 160, bottom: 176 }]), 1000)).toBe(false);
  });

  it('dims only when the overlap reaches 5px both ways', () => {
    const dims = (mark: Box) => coachDimmed(COACH, board([mark]), 1000);
    expect(MARK_OVERLAP_MIN_PX).toBe(5);
    expect(dims({ left: 300, right: 360, top: 155.01, bottom: 171.01 })).toBe(false);
    expect(dims({ left: 300, right: 360, top: 155, bottom: 171 })).toBe(true);
    expect(dims({ left: 300, right: 360, top: 104, bottom: 120 })).toBe(false);
    expect(dims({ left: 300, right: 360, top: 105, bottom: 121 })).toBe(true);
    expect(dims({ left: 476, right: 540, top: 130, bottom: 146 })).toBe(false);
    expect(dims({ left: 475, right: 540, top: 130, bottom: 146 })).toBe(true);
    expect(dims({ left: 230, right: 294, top: 130, bottom: 146 })).toBe(false);
    expect(dims({ left: 230, right: 295, top: 130, bottom: 146 })).toBe(true);
  });

  it('stays plain with no marks, no coach or nothing published yet', () => {
    expect(coachDimmed(COACH, board([]), 1000)).toBe(false);
    expect(coachDimmed(null, board([pointMarkBox(400, 140, 60)]), 1000)).toBe(false);
    expect(coachDimmed(COACH, new PointMarkBoard(), 0)).toBe(false);
  });

  it('comes back when the mark leaves the coach', () => {
    const b = board([pointMarkBox(400, 140, 60)]);
    expect(coachDimmed(COACH, b, 1000)).toBe(true);
    b.publish([pointMarkBox(100, 300, 60)], 1016);
    expect(coachDimmed(COACH, b, 1016)).toBe(false);
  });

  it('comes back when the HUD stops updating the marks', () => {
    const b = board([pointMarkBox(400, 140, 60)]);
    expect(coachDimmed(COACH, b, 1000 + MARK_STALE_MS)).toBe(true);
    expect(coachDimmed(COACH, b, 1000 + MARK_STALE_MS + 1)).toBe(false);
  });

  it('comes back at once when the HUD clears the marks outside play', () => {
    const b = board([pointMarkBox(400, 140, 60)]);
    b.clear();
    expect(coachDimmed(COACH, b, 1000)).toBe(false);
  });

  it('fades over 150 ms to a lower opacity and never takes pointer input', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8');
    const coach = css.match(/\.coach \{[^}]*\}/)![0];
    expect(coach).toMatch(/pointer-events: none;/);
    expect(coach).toMatch(/transition: opacity 150ms;/);
    expect(css).toMatch(/\.coach\.dimmed \{ opacity: \.5; \}/);
  });
});

describe('edge marks stacked on one side (#315)', () => {
  const overlap = (a: Box, b: Box, gap = 0) => Math.min(a.right, b.right + gap) - Math.max(a.left, b.left - gap) > 0 && Math.min(a.bottom, b.bottom + gap) - Math.max(a.top, b.top - gap) > 0;

  it('climbs one 18px row, x kept, when only a nearer mark is in the way', () => {
    const near = pointMarkBox(400, 342, 64);
    expect(MARK_ROW_PX).toBe(18);
    expect(clearOfAll(410, 342, 70, [], 844, 48, [near])).toEqual({ x: 410, y: 324 });
    expect(overlap(near, pointMarkBox(410, 324, 70))).toBe(false);
  });

  it('keeps a mark where it is when nothing is in the way', () => {
    expect(clearOfAll(410, 342, 70, [{ left: 0, right: 100, top: 0, bottom: 390 }], 844, 48, [pointMarkBox(600, 342, 64)])).toEqual({ x: 410, y: 342 });
  });

  it('still slides sideways off a control on its own row before it climbs (#274)', () => {
    const stick: Box = { left: 360, right: 470, top: 300, bottom: 380 };
    expect(clearOfAll(410, 342, 70, [stick], 844, 48)).toEqual({ x: 360 - MARK_PANEL_GAP_PX - 35, y: 342 });
  });

  it('stays on its row when sliding off a control already clears the nearer mark', () => {
    const stick: Box = { left: 1124, right: 1260, top: 560, bottom: 696 };
    const front = pointMarkBox(1232, 672, 65);
    expect(clearOfAll(1150, 672, 66, [stick], 1280, 48, [front])).toEqual({ x: 1124 - MARK_PANEL_GAP_PX - 33, y: 672 });
  });

  it('slides a stacked mark off a control met on a higher row', () => {
    const radio: Box = { left: 300, right: 520, top: 300, bottom: 330 };
    const r = clearOfAll(410, 342, 70, [radio], 844, 48, [pointMarkBox(410, 342, 70)]);
    expect(r.y).toBe(324);
    expect(overlap(pointMarkBox(r.x, r.y, 70), radio, MARK_PANEL_GAP_PX)).toBe(false);
  });

  const WIDEST = 90;
  const RADIO_1280: Box = { left: 558, right: 722, top: 520, bottom: 550 }, STATUS_1280: Box = { left: 1050, right: 1264, top: 653, bottom: 704 };
  const RADIO_844: Box = { left: 340, right: 504, top: 190, bottom: 220 }, STATUS_844: Box = { left: 614, right: 828, top: 323, bottom: 374 };
  const LAYOUTS = [
    ['1280x720 desktop', 1280, 720, [{ left: 16, right: 196, top: 524, bottom: 704 }, RADIO_1280, STATUS_1280]],
    ['844x390 desktop', 844, 390, [{ left: 16, right: 196, top: 194, bottom: 374 }, RADIO_844, STATUS_844]],
  ] as const;

  it.each(LAYOUTS)('fits all seven points stacked on one side at %s on screen, off the minimap, radio and status panel', (_, w, h, blocks) => {
    for (let x0 = 48; x0 <= w - 48; x0 += 4) {
      const placed: Box[] = [];
      for (let k = 0; k < 7; k++) {
        const r = clearOfAll(x0, h - 48, WIDEST, blocks, w, 48, placed);
        const m = pointMarkBox(r.x, r.y, WIDEST);
        expect(m.left >= 0 && m.right <= w && m.top >= 0 && m.bottom <= h).toBe(true);
        for (const b of blocks) expect(overlap(m, b, MARK_PANEL_GAP_PX)).toBe(false);
        for (const p of placed) expect(overlap(m, p)).toBe(false);
        placed.push(m);
      }
    }
  });
});

describe('desktop radio line', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8');
  const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.()]/g, '\\$&')} \\{[^}]*\\}`))![0];
  const px = (block: string, prop: string) => Number(block.match(new RegExp(`(^|[ ;{])${prop}: (?:calc\\()?(\\d+)px`))![2]);
  const LINE_PX = 18;

  it('sits above a two-line coach so both stay readable together', () => {
    const coach = rule('.coach'), radio = rule('.battle-hud .battle-radio');
    const pad = Number(coach.match(/padding: (\d+)px/)![1]);
    const twoLineTop = px(coach, 'bottom') + 2 * LINE_PX + 2 * pad + 2;
    expect(px(radio, 'bottom')).toBeGreaterThanOrEqual(twoLineTop + 4);
  });

  it('keeps the touch radio where the touch layout put it', () => {
    expect(px(rule('.battle-hud.touch .battle-radio'), 'bottom')).toBe(150);
  });

  it('drops the heli touch radio under every heli touch button (#331)', () => {
    const radio = px(rule('.battle-hud.touch.heli .battle-radio'), 'bottom');
    const lowest = Math.min(...['.tcm', '.tbtn.engine', '.tads-row', '.tbtn.laser', '.tbtn.fire'].map(s => px(rule(s), 'bottom')));
    const pad = Number(rule('.battle-hud .battle-radio').match(/padding: (\d+)px/)![1]);
    expect(radio + 2 * pad + LINE_PX + 4).toBeLessThanOrEqual(lowest);
  });
});
