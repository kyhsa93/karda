import { describe, expect, it } from 'vitest';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import units from '../../content/units.json';
import { hasString, t } from '../../content/strings';
import { createBattleSession } from '../../sim/battle/runtime';
import type { BattleMapDef } from '../../sim/battle/schema';
import type { CrashReason } from '../../sim/events';
import { STANDARD_LOADOUT } from '../../sim/heli/loadout';
import { STEP } from '../../sim/world';
import { deathLine, DeathReport, firedWeapon, radioLine } from './deathReport';

const harek = JSON.parse(harekRaw) as BattleMapDef;
const SOLDIER = { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' } as const;

function battle(side: 'coalition' | 'veros' = 'coalition', mode: 'quick' | 'conquest' = 'quick') {
  const { session, runtime } = createBattleSession(harek, mode, { side, seed: 7 });
  session.start();
  const report = new DeathReport(session);
  const world = session.world;
  const enemy = world.units.find(u => u.side !== side && u.def.weapons.some(w => w.id === 'g_rifle') && u.def.squad === 5)
    ?? world.units.find(u => u.side !== side)!;
  return { session, runtime, world, report, enemy };
}
type Game = ReturnType<typeof battle>;

const steps = (g: Game, n = 2) => { for (let i = 0; i < n; i++) g.session.step(STEP); };
const shoot = (g: Game, by: number, weapon: string, damage: number) => { g.world.emit({ t: 'playerHit', by, weapon, damage }); steps(g); };
const respawn = (g: Game, spawn: Parameters<Game['session']['deploy']>[0]) => {
  while (g.session.mode === 'crashed' || g.session.deployIn() > 0) g.session.step(STEP);
  expect(g.session.deploy(spawn)).toBe(true);
};
const heli = (g: Game) => {
  const pad = g.world.pads[0];
  return { kind: 'heli' as const, at: 'air' as const, x: pad.x, z: pad.z, agl: 150, headingDeg: 0, kit: STANDARD_LOADOUT, speed: 0 };
};

describe('death line (wiki 8.11, #227)', () => {
  it('names the shooter class, side, weapon and distance', () => {
    expect(deathLine('killed', undefined, { side: 'veros', defId: 'inf', weapon: 'g_rifle', dist: 61.6 })).toBe('▲ VPA 보병 분대 · 소총 · 62m');
    expect(deathLine('crewKilled', undefined, { side: 'veros', defId: 'aaa_light', weapon: 'zu23x2', dist: 1234 })).toBe('▲ VPA 대공 기관포 진지 · 대공 기관포 · 1.2km');
    expect(deathLine('killed', undefined, { side: 'coalition', defId: 'c_inf_mg', weapon: 'g_lmg', dist: 80 })).toBe('■ 연합 기관총 분대 · 기관총 · 80m');
    expect(deathLine('killed', undefined, { side: 'coalition', defId: 'c_inf', weapon: 'g_rifle', dist: 80 })).toBe('■ 연합군 보병 분대 · 소총 · 80m');
  });

  it.each<[CrashReason, number | undefined, string]>([
    ['terrain', undefined, '기체가 지형에 충돌했습니다'],
    ['water', undefined, '물에 추락했습니다'],
    ['tree', undefined, '나무에 부딪혔습니다'],
    ['building', undefined, '건물에 부딪혔습니다'],
    ['hardLanding', 3, '착륙 충격이 너무 큽니다 (591 fpm)'],
    ['outOfBounds', undefined, '전투 구역을 벗어났습니다'],
    ['fall', undefined, '추락해 전사했습니다'],
  ])('gives only the reason for %s, even after a hit', (reason, value, text) => {
    expect(deathLine(reason, value, { side: 'veros', defId: 'inf', weapon: 'g_rifle', dist: 62 })).toBe(text);
  });

  it('gives only the reason when nothing hit the player in this life', () => {
    expect(deathLine('crewKilled')).toBe(t('crash.crewKilled'));
    expect(deathLine('rotorLoss', undefined, null)).toBe(t('crash.rotorLoss'));
    expect(deathLine('killed')).toBe(t('crash.killed'));
  });

  it('drops an unlabelled weapon or class instead of showing its internal id', () => {
    expect(deathLine('killed', undefined, { side: 'veros', defId: 'inf', weapon: 'new_gun', dist: 62 })).toBe('▲ VPA 보병 분대 · 62m');
    expect(deathLine('killed', undefined, { side: 'veros', defId: 'new_unit', weapon: 'g_rifle', dist: 62 })).toBe('▲ VPA · 소총 · 62m');
    expect(deathLine('killed', undefined, { side: 'neutral', defId: 'new_unit', weapon: 'new_gun' })).toBe(t('crash.killed'));
  });

  it('falls back to the reason when the shooter was never known', () => {
    expect(deathLine('killed', undefined, { weapon: 'g_rifle' })).toBe(`${t('crash.killed')} · 소총`);
    expect(deathLine('killed', undefined, {})).toBe(t('crash.killed'));
    expect(deathLine('killed', undefined, { side: 'veros', defId: 'inf', dist: NaN })).toBe('▲ VPA 보병 분대');
  });

  it('has a Korean label for every class and every weapon that can emit playerHit', () => {
    const defs = Object.entries(units) as [string, { weapons?: { id: string; kind: string }[] }][];
    for (const [id, def] of defs) {
      expect(hasString(`units.${id}`), id).toBe(true);
      for (const w of def.weapons ?? []) if (w.kind === 'bullet' || w.kind === 'rocket') expect(hasString(`battle.death.weapon.${w.id}`), w.id).toBe(true);
      const line = deathLine('killed', undefined, { side: 'veros', defId: id, weapon: def.weapons?.[0]?.id, dist: 10 });
      expect(line).not.toMatch(/[a-z]+_|units\.|battle\./);
    }
    expect(t('battle.death.weapon.missile_ir')).toBe('적외선 미사일');
    expect(t('battle.death.weapon.missile_radar')).toBe('레이더 미사일');
  });

  it('names what a squad really fires, not the rifle the event always reports', () => {
    const squad = (ids: string[]) => ({ def: { squad: 5, weapons: ids.map(id => ({ id })) } }) as never;
    expect(firedWeapon(squad(['g_sniper']), 'g_rifle')).toBe('g_sniper');
    expect(firedWeapon(squad(['g_lmg', 'lmg']), 'g_rifle')).toBe('g_lmg');
    expect(firedWeapon(squad(['g_at', 'g_rifle']), 'g_rifle')).toBe('g_rifle');
    expect(firedWeapon({ def: { weapons: [{ id: 'g_hmg' }] } } as never, 'g_hmg')).toBe('g_hmg');
  });
});

describe('radio slot while dead (#227)', () => {
  const radio = { text: '거점 A 상실', until: 10 };

  it('keeps the death line over any radio call during crashed', () => {
    expect(radioLine('crashed', '▲ VPA 보병 분대 · 소총 · 62m', radio, 5)).toBe('▲ VPA 보병 분대 · 소총 · 62m');
  });

  it('shows the radio normally otherwise', () => {
    expect(radioLine('play', null, radio, 5)).toBe('거점 A 상실');
    expect(radioLine('play', null, radio, 11)).toBe(null);
    expect(radioLine('play', null, null, 5)).toBe(null);
    expect(radioLine('crashed', null, radio, 5)).toBe('거점 A 상실');
  });
});

describe('death report over real lives (#227)', () => {
  it('has no line before the first death', () => {
    const g = battle();
    expect(g.report.line()).toBe(null);
    g.session.deploy(SOLDIER);
    shoot(g, g.enemy.id, 'g_rifle', 1);
    expect(g.world.soldier!.alive).toBe(true);
    expect(g.report.line()).toBe(null);
  });

  it('uses the killing hit, measured from the shooter when it fired', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    const s = g.world.soldier!;
    g.enemy.pos.set(s.pos.x + 62, s.pos.y, s.pos.z);
    g.world.emit({ t: 'playerHit', by: g.enemy.id, weapon: 'g_rifle', damage: 1000 });
    steps(g);
    expect(g.session.mode).toBe('crashed');
    const line = g.report.line()!;
    expect(line).toMatch(/^▲ VPA .+ · 소총 · \d+m$/);
    g.enemy.pos.x += 500;
    steps(g, 20);
    expect(g.report.line()).toBe(line);
  });

  it('keeps the line through the deploy screen and clears it at the next sortie', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    shoot(g, g.enemy.id, 'g_rifle', 1000);
    const line = g.report.line();
    expect(line).toContain('소총');
    while (g.session.mode === 'crashed') g.session.step(STEP);
    expect(g.session.mode).toBe('deploy');
    expect(g.report.line()).toBe(line);
    respawn(g, SOLDIER);
    expect(g.report.line()).toBe(null);
  });

  it('does not carry a hit from the previous life into a hit-free helicopter death', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    shoot(g, g.enemy.id, 'g_rifle', 1000);
    respawn(g, heli(g));
    g.world.killPlayer('crewKilled');
    steps(g);
    expect(g.world.avatar.kind).toBe('heli');
    expect(g.session.mode).toBe('crashed');
    expect(g.report.line()).toBe(t('crash.crewKilled'));
  });

  it('ignores shots at the corpse, in the same step, during crashed and into the next life', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    const other = g.world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
    g.world.emit({ t: 'playerHit', by: g.enemy.id, weapon: 'g_rifle', damage: 1000 });
    g.world.emit({ t: 'playerHit', by: other.id, weapon: 'zu23x2', damage: 1000 });
    steps(g);
    const line = g.report.line();
    expect(line).toContain('소총');
    shoot(g, other.id, 'zu23x2', 1000);
    expect(g.report.line()).toBe(line);
    respawn(g, heli(g));
    g.world.killPlayer('rotorLoss');
    steps(g);
    expect(g.report.line()).toBe(t('crash.rotorLoss'));
  });

  it('does not blame the last shooter for a soldier death it did not cause', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    shoot(g, g.enemy.id, 'g_rifle', 1);
    g.world.killPlayer('killed');
    steps(g);
    expect(g.report.line()).toBe(t('crash.killed'));
  });

  it('gives only the reason when a shot helicopter hits the ground', () => {
    const g = battle();
    g.session.deploy(heli(g));
    g.world.emit({ t: 'playerHit', by: g.enemy.id, weapon: 'rifle', damage: 0.1 });
    steps(g);
    g.world.emit({ t: 'crash', reason: 'terrain' });
    steps(g);
    expect(g.report.line()).toBe('기체가 지형에 충돌했습니다');
  });

  it('survives a shooter that is gone at hit time and one retired before death', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    g.world.emit({ t: 'playerHit', by: -12345, weapon: 'g_rifle', damage: 1000 });
    steps(g);
    expect(g.session.mode).toBe('crashed');
    expect(g.report.line()).toBe(`${t('crash.killed')} · 소총`);

    const h = battle();
    h.session.deploy(heli(h));
    h.world.emit({ t: 'playerHit', by: h.enemy.id, weapon: 'rifle', damage: 0.1 });
    steps(h);
    h.world.units = h.world.units.filter(u => u !== h.enemy);
    h.world.killPlayer('rotorLoss');
    steps(h);
    expect(h.report.line()).toMatch(/^▲ VPA .+ · 소총 · .+$/);
  });

  it('credits a missile that kills the helicopter, even after an earlier bullet', () => {
    const g = battle();
    g.session.deploy(heli(g));
    const launcher = g.world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
    g.world.emit({ t: 'playerHit', by: g.enemy.id, weapon: 'rifle', damage: 0.1 });
    steps(g);
    g.world.emit({ t: 'missileWarning', id: 9001, kind: 'ir', from: launcher.pos.clone(), owner: launcher.id });
    steps(g);
    g.world.killPlayer('crewKilled');
    g.world.emit({ t: 'missileEnd', id: 9001, hit: true });
    steps(g);
    expect(g.report.line()).toMatch(/^▲ VPA 대공 기관포 진지 · 적외선 미사일 · /);
  });

  it('ignores a missile that detonates after the helicopter is already down', () => {
    const g = battle();
    g.session.deploy(heli(g));
    g.world.emit({ t: 'missileWarning', id: 9002, kind: 'radar', from: g.enemy.pos.clone(), owner: g.enemy.id });
    steps(g);
    g.world.killPlayer('crewKilled');
    steps(g, 3);
    g.world.emit({ t: 'missileEnd', id: 9002, hit: true });
    steps(g);
    expect(g.report.line()).toBe(t('crash.crewKilled'));
  });
});

describe('missile kind behind the death tip (#298)', () => {
  const launch = (g: Game, weapon: string) => {
    const by = g.world.units.find(u => u.side === 'veros' && u.alive && u.def.weapons.some(w => w.id === weapon))
      ?? g.world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
    const m = g.world.launchEnemyMissile(by, weapon);
    g.world.enemyMissiles.splice(g.world.enemyMissiles.indexOf(m), 1);
    steps(g);
    return { by, m };
  };
  const missileKill = (g: Game, weapon: string) => {
    const { by, m } = launch(g, weapon);
    g.world.killPlayer('crewKilled');
    g.world.emit({ t: 'missileEnd', id: m.id, hit: true });
    steps(g);
    return by;
  };

  it.each<[string, 'quick' | 'conquest', 'ir' | 'radar', string]>([
    ['sa_ir', 'quick', 'ir', '적외선 미사일'],
    ['sam_radar', 'conquest', 'radar', '레이더 미사일'],
    ['heli_aam', 'quick', 'ir', '적외선 미사일'],
    ['jet_aam', 'quick', 'ir', '적외선 미사일'],
  ])('reads %s as the kind the death line names', (weapon, mode, kind, piece) => {
    const g = battle('coalition', mode);
    g.session.deploy(heli(g));
    expect(g.report.missile()).toBe(null);
    missileKill(g, weapon);
    expect(g.session.mode).toBe('crashed');
    expect(g.report.line()!.split(' · ')[1]).toBe(piece);
    expect(g.report.missile()).toBe(kind);
  });

  it('names the real launchers of the battle map with their kind', () => {
    const g = battle('coalition', 'conquest');
    g.session.deploy(heli(g));
    expect(missileKill(g, 'sam_radar').defId).toBe('sam_short');
    expect(g.report.line()).toMatch(/^▲ VPA 단거리 지대공미사일 · 레이더 미사일 · /);
    expect(g.report.missile()).toBe('radar');
    const h = battle();
    h.session.deploy(heli(h));
    expect(missileKill(h, 'sa_ir').defId).toBe('manpads');
    expect(h.report.line()).toMatch(/^▲ VPA 휴대용 대공미사일 조 · 적외선 미사일 · /);
    expect(h.report.missile()).toBe('ir');
  });

  it('has no missile once a later cause takes the death line', () => {
    const late = battle();
    late.session.deploy(heli(late));
    const { m } = launch(late, 'sa_ir');
    late.world.emit({ t: 'missileEnd', id: m.id, hit: true });
    steps(late);
    late.world.emit({ t: 'crash', reason: 'terrain' });
    steps(late);
    expect(late.report.line()).toBe('기체가 지형에 충돌했습니다');
    expect(late.report.missile()).toBe(null);

    const gun = battle();
    gun.session.deploy(heli(gun));
    const aaa = gun.world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
    const shot = launch(gun, 'sam_radar');
    gun.world.emit({ t: 'missileEnd', id: shot.m.id, hit: true });
    steps(gun);
    shoot(gun, aaa.id, 'zu23x2', 0.1);
    gun.world.killPlayer('crewKilled');
    steps(gun);
    expect(gun.report.line()).toMatch(/ · 대공 기관포 · /);
    expect(gun.report.missile()).toBe(null);
  });

  it('keeps the missile when the rotor it broke brings the helicopter down later', () => {
    const g = battle();
    g.session.deploy(heli(g));
    const { m } = launch(g, 'sam_radar');
    g.world.emit({ t: 'missileEnd', id: m.id, hit: true });
    steps(g, 20);
    g.world.killPlayer('rotorLoss');
    steps(g);
    expect(g.report.line()).toMatch(/ · 레이더 미사일 · /);
    expect(g.report.missile()).toBe('radar');
  });

  it('has no missile for a rifle, a gun or no hit at all', () => {
    const g = battle();
    g.session.deploy(SOLDIER);
    shoot(g, g.enemy.id, 'g_rifle', 1000);
    expect(g.report.missile()).toBe(null);
    respawn(g, heli(g));
    g.world.killPlayer('crewKilled');
    steps(g);
    expect(g.report.missile()).toBe(null);
  });
});
