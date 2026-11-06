import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { t } from '../../content/strings';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STANDARD_LOADOUT } from '../../sim/heli/loadout';
import type { FlightSession } from '../../sim/session';
import { STEP } from '../../sim/world';
import { BattleOverlays } from './Battle';
import { coachText, PointMarkBoard } from './coach';
import { DeathReport } from './deathReport';
import { BattleHud, RADIO_SECONDS, TICKET_WARN } from './hud/BattleHud';
import { loadBattle } from './loadBattle';

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: any, public nodeValue = '') {}
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
  get tagName() { return this.nodeName; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): FakeNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v: string) {
    this.childNodes = [];
    if (v) this.appendChild(new FakeNode(3, '#text', this.ownerDocument, v));
  }
  appendChild(c: FakeNode) { return this.insertBefore(c, null); }
  insertBefore(c: FakeNode, before: FakeNode | null) {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, c);
    return c;
  }
  removeChild(c: FakeNode) {
    this.childNodes.splice(this.childNodes.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
  getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
}

function all(node: FakeNode, cls: string): FakeNode[] {
  return node.childNodes.flatMap(c => [...((c.attrs.class ?? '').split(' ').includes(cls) ? [c] : []), ...all(c, cls)]);
}

function press(node: FakeNode) {
  const key = Object.keys(node).find(k => k.startsWith('__reactProps'))!;
  (node as any)[key].onClick();
}

function fakeDom() {
  const doc: any = new FakeNode(9, '#document', null);
  doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
  doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
  doc.body = doc.createElement('body');
  doc.documentElement = doc.createElement('html');
  doc.activeElement = doc.body;
  const win: any = { document: doc, location: { hash: '', search: '' }, HTMLIFrameElement: class {}, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return doc.createElement('div') as FakeNode;
}

const harek = JSON.parse(harekRaw) as BattleMapDef;
const SOLDIER = { kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' } as const;
const noop = () => {};

describe('death line on screen (#227)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function game(tips: readonly string[] = ['card.soldier', 'rules.dead']) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 7 });
    session.start();
    const death = new DeathReport(session);
    const onTip = vi.fn();
    root = createRoot(container as unknown as HTMLElement);
    root.render([
      createElement(BattleHud, { key: 'hud', session, runtime, side: 'coalition', renderer: null, touch: false, death, marks: new PointMarkBoard() }),
      createElement(BattleOverlays, { key: 'overlays', game: { mod, session, runtime, death, marks: new PointMarkBoard() }, side: 'coalition', touch: false, tips, onTip, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }),
    ]);
    await vi.waitFor(() => expect(all(container, 'battle-canvas').length).toBe(1));
    const enemy = session.world.units.find(u => u.defId === 'aaa_light' && u.side === 'veros')!;
    const steps = (n = 2) => { for (let i = 0; i < n; i++) session.step(STEP); };
    const die = () => {
      session.deploy(SOLDIER);
      session.world.emit({ t: 'playerHit', by: enemy.id, weapon: 'g_rifle', damage: 1000 });
      steps();
      expect(session.mode).toBe('crashed');
    };
    const radio = () => all(container, 'battle-radio').map(n => n.textContent);
    const redeploy = async () => {
      while (session.mode !== 'deploy' || session.deployIn() > 0) session.step(STEP);
      await vi.waitFor(() => expect(all(container, 'tip').length).toBeGreaterThan(0));
    };
    const go = async () => {
      const button = () => all(container, 'go').find(b => b.attrs.class === 'go')!;
      await vi.waitFor(() => expect(button().textContent).toBe(`${t('battle.deploy.go')} ▶`));
      press(button());
      expect(session.mode).toBe('play');
    };
    const cards = () => all(container, 'control-card').length;
    const deadTip = () => container.textContent.includes(t('battle.tips.dead'));
    return { session, runtime, enemy, steps, die, radio, onTip, redeploy, go, cards, deadTip };
  }

  const LINE = /^▲ VPA 대공 기관포 진지 · 소총 · [\d.]+k?m$/;

  it('puts the line in the radio slot while crashed', async () => {
    const g = await game();
    g.die();
    await vi.waitFor(() => expect(g.radio()).toHaveLength(1));
    expect(g.radio()[0]).toMatch(LINE);
  });

  it('is not overwritten by a point change during crashed', async () => {
    const g = await game();
    await vi.waitFor(() => expect(g.radio()).toEqual([]));
    g.die();
    g.session.world.emit({ t: 'pointOwner', id: 'A', owner: 'veros', from: 'coalition' });
    g.steps();
    await new Promise(done => setTimeout(done, 250));
    expect(g.session.mode).toBe('crashed');
    expect(g.radio()[0]).toMatch(LINE);
  });

  it('is not overwritten by a ticket warning during crashed', async () => {
    const g = await game();
    await vi.waitFor(() => expect(g.radio()).toEqual([]));
    g.die();
    g.runtime.conquest.tickets.coalition = TICKET_WARN.at(-1)!;
    await new Promise(done => setTimeout(done, 250));
    expect(g.session.mode).toBe('crashed');
    expect(g.radio()[0]).toMatch(LINE);
  });

  it('gives the radio back in the next life', async () => {
    const g = await game();
    g.die();
    while (g.session.mode === 'crashed' || g.session.deployIn() > 0) g.session.step(STEP);
    expect(g.session.deploy(SOLDIER)).toBe(true);
    g.session.world.emit({ t: 'pointOwner', id: 'A', owner: 'veros', from: 'coalition' });
    g.steps();
    await vi.waitFor(() => expect(g.radio()).toEqual([t('battle.hud.point.lost', { id: 'A' })]));
  });

  it('shows the line as a tip on the deploy screen, and none before the first death', async () => {
    const g = await game();
    await vi.waitFor(() => expect(container.textContent).toContain(t('battle.deploy.title')));
    expect(all(container, 'tip')).toEqual([]);
    g.die();
    while (g.session.mode === 'crashed') g.session.step(STEP);
    await vi.waitFor(() => expect(all(container, 'tip').length).toBeGreaterThan(0));
    expect(all(container, 'tip')[0].textContent).toMatch(LINE);
    expect(container.textContent).toContain(t('battle.tips.soldier'));
    const flat = (n: FakeNode): FakeNode[] => n.childNodes.flatMap(c => [c, ...flat(c)]);
    const order = flat(container);
    expect(order.indexOf(all(container, 'tip').at(-1)!)).toBeLessThan(order.indexOf(all(container, 'setting-row')[0]));
  });

  it('hides the dead tip under the control card and leaves rules.dead for later (#312)', async () => {
    const g = await game([]);
    g.die();
    await g.redeploy();
    expect(g.cards()).toBe(1);
    expect(g.deadTip()).toBe(false);
    await g.go();
    expect(g.onTip).toHaveBeenCalledWith('card.soldier');
    expect(g.onTip).not.toHaveBeenCalledWith('rules.dead');
  });

  it('shows the dead tip and records rules.dead once no card shows (#312)', async () => {
    const g = await game(['card.soldier']);
    g.die();
    await g.redeploy();
    expect(g.cards()).toBe(0);
    expect(g.deadTip()).toBe(true);
    await g.go();
    expect(g.onTip).toHaveBeenCalledWith('rules.dead');
  });

  it('shows and records no dead tip once rules.dead is recorded (#312)', async () => {
    const g = await game(['card.soldier', 'rules.dead']);
    g.die();
    await g.redeploy();
    expect(g.cards()).toBe(0);
    expect(g.deadTip()).toBe(false);
    await g.go();
    expect(g.onTip).not.toHaveBeenCalledWith('rules.dead');
  });

  it('shows and records no dead tip before the first death (#312)', async () => {
    const g = await game(['card.soldier']);
    await vi.waitFor(() => expect(container.textContent).toContain(t('battle.deploy.title')));
    expect(g.cards()).toBe(0);
    expect(g.deadTip()).toBe(false);
    await g.go();
    expect(g.onTip).not.toHaveBeenCalledWith('rules.dead');
  });
});

describe('death tip on the deploy screen (#298)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function die(mode: 'quick' | 'conquest', kill: (world: FlightSession['world']) => void, heli = true) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, mode, { side: 'coalition', seed: 7 });
    session.start();
    const death = new DeathReport(session);
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleOverlays, { game: { mod, session, runtime, death, marks: new PointMarkBoard() }, side: 'coalition', touch: false, tips: ['card.soldier', 'card.apache', 'rules.dead'], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }));
    await vi.waitFor(() => expect(container.textContent).toContain(t('battle.deploy.title')));
    const pad = session.world.pads[0];
    session.deploy(heli ? { kind: 'heli', at: 'air', x: pad.x, z: pad.z, agl: 150, headingDeg: 0, kit: STANDARD_LOADOUT, speed: 0 } : SOLDIER);
    await vi.waitFor(() => expect(container.textContent).not.toContain(t('battle.deploy.title')));
    kill(session.world);
    for (let i = 0; i < 2; i++) session.step(STEP);
    expect(session.mode).toBe('crashed');
    while (session.mode !== 'deploy') session.step(STEP);
    await vi.waitFor(() => expect(all(container, 'tip')).toHaveLength(2));
    const [line, tip] = all(container, 'tip').map(n => n.textContent);
    return { line, tip };
  }

  const launch = (world: FlightSession['world'], weapon: string) => {
    const by = world.units.find(u => u.side === 'veros' && u.alive && u.def.weapons.some(w => w.id === weapon))
      ?? world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
    const m = world.launchEnemyMissile(by, weapon);
    world.enemyMissiles.splice(world.enemyMissiles.indexOf(m), 1);
    return m;
  };
  const missile = (weapon: string) => (world: FlightSession['world']) => {
    const m = launch(world, weapon);
    world.killPlayer('crewKilled');
    world.emit({ t: 'missileEnd', id: m.id, hit: true });
  };

  it.each<[string, 'quick' | 'conquest']>([['sa_ir', 'quick'], ['heli_aam', 'quick'], ['jet_aam', 'quick']])('tells a %s death to flare, not chaff', async (weapon, mode) => {
    const { line, tip } = await die(mode, missile(weapon));
    expect(line.split(' · ')[1]).toBe('적외선 미사일');
    expect(tip).toBe(t('battle.tips.missile'));
    expect(tip).toContain('플레어');
    expect(tip).not.toContain('채프');
  }, 20000);

  it('tells a radar SAM death to chaff, not flare', async () => {
    const { line, tip } = await die('conquest', missile('sam_radar'));
    expect(line).toMatch(/^▲ VPA 단거리 지대공미사일 · 레이더 미사일 · /);
    expect(tip).toBe(t('battle.tips.missileRadar'));
    expect(tip).toContain('채프');
    expect(tip).not.toContain('플레어');
  }, 20000);

  it('gives no missile tip for a gun that finishes after a missile hit', async () => {
    const gun = await die('quick', world => {
      const aaa = world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
      world.emit({ t: 'missileEnd', id: launch(world, 'sa_ir').id, hit: true });
      world.emit({ t: 'playerHit', by: aaa.id, weapon: 'zu23x2', damage: 0.1 });
      world.killPlayer('crewKilled');
    });
    expect(gun.line).toMatch(/ · 대공 기관포 · /);
    expect(gun.tip).toBe(t('battle.tips.fire'));
    expect(gun.tip).not.toMatch(/미사일|플레어|채프/);
  }, 20000);

  it('gives no missile tip for the ground that finishes after a missile hit', async () => {
    const ground = await die('quick', world => {
      world.emit({ t: 'missileEnd', id: launch(world, 'sam_radar').id, hit: true });
      world.emit({ t: 'crash', reason: 'terrain' });
    });
    expect(ground.line).toBe('기체가 지형에 충돌했습니다');
    expect(ground.tip).toBe(t('battle.tips.terrain'));
    expect(ground.tip).not.toMatch(/미사일|플레어|채프/);
  }, 20000);

  it('gives no missile tip for a rifle', async () => {
    const rifle = await die('quick', world => {
      const inf = world.units.find(u => u.side === 'veros' && u.def.weapons.some(w => w.id === 'g_rifle'))!;
      world.emit({ t: 'playerHit', by: inf.id, weapon: 'g_rifle', damage: 1000 });
    }, false);
    expect(rifle.line).toMatch(/ · 소총 · /);
    expect(rifle.tip).toBe(t('battle.tips.soldier'));
    expect(rifle.tip).not.toMatch(/미사일|플레어|채프/);
  }, 20000);
});

describe('soldier control card on the deploy screen (#208)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function card(touch: boolean) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    const death = new DeathReport(session);
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleOverlays, { game: { mod, session, runtime, death, marks: new PointMarkBoard() }, side: 'coalition', touch, tips: [], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }));
    await vi.waitFor(() => expect(all(container, 'control-card')).toHaveLength(1));
    return all(container, 'control-card')[0].textContent;
  }

  it('shows the keys on the keyboard card', async () => {
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    const text = await card(false);
    expect(text).toContain('X 구급 상자');
    expect(text).toContain('F 연막');
  });

  it('shows the button names on the touch card', async () => {
    const text = await card(true);
    expect(text).toContain(`${t('touch.medkit')} · ${t('touch.smoke')}`);
    expect(text).not.toMatch(/[XF] (구급|연막)/);
  });

  it('shows the pad buttons on the pad card (#300)', async () => {
    vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true }] });
    const text = await card(false);
    expect(text).toContain(`← ${t('touch.medkit')}`);
    expect(text).toContain('→ 유탄');
    expect(text).toContain(`RB ${t('touch.smoke')}`);
    expect(text).not.toMatch(/[XF] (구급|연막)|←→/);
  });
});

describe('first coach line on screen (#230)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function deployed(side: 'coalition' | 'veros', at: readonly [number, number]) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side, seed: 1 });
    session.start();
    const death = new DeathReport(session);
    session.deploy({ ...SOLDIER, x: at[0], z: at[1] });
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleOverlays, { game: { mod, session, runtime, death, marks: new PointMarkBoard() }, side, touch: true, tips: [], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }));
    const coach = () => all(container, 'coach').map(n => n.textContent);
    await vi.waitFor(() => expect(coach()).toHaveLength(1));
    return { runtime, coach };
  }

  const RALLY = harek.modes.quick!.rally!;

  for (const side of ['coalition', 'veros'] as const) {
    it(`names the nearest open point for ${side}`, async () => {
      const g = await deployed(side, RALLY[side]!);
      expect(g.coach()[0]).toMatch(/^D 거점으로 /);
      expect(g.coach()[0]).toBe(coachText('rules.points', side, 'D'));
    });

    it(`drops the target once every point is held for ${side}`, async () => {
      const g = await deployed(side, RALLY[side]!);
      for (const p of g.runtime.conquest.points) p.owner = side;
      await vi.waitFor(() => expect(g.coach()[0]).toBe(coachText('rules.points', side, null)));
    });
  }
});

describe('why the tickets fell, on screen (#238)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  const BEHIND = '거점 열세 — 우리 티켓이 계속 줄어드는 중';

  async function screen() {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 7 });
    session.start();
    const death = new DeathReport(session, () => runtime.conquest.causes.coalition.player);
    root = createRoot(container as unknown as HTMLElement);
    const draw = () => root.render([
      createElement(BattleHud, { key: 'hud', session, runtime, side: 'coalition', renderer: null, touch: false, death, marks: new PointMarkBoard() }),
      createElement(BattleOverlays, { key: 'overlays', game: { mod, session, runtime, death, marks: new PointMarkBoard() }, side: 'coalition', touch: false, tips: ['card.soldier', 'rules.dead'], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }),
    ]);
    draw();
    await vi.waitFor(() => expect(all(container, 'battle-canvas').length).toBe(1));
    const radio = () => all(container, 'battle-radio').map(n => n.textContent);
    const D = runtime.conquest.points.find(p => p.id === 'D')!;
    const take = (owner: 'coalition' | 'veros') => {
      const from = D.owner;
      D.owner = owner;
      D.v = owner === 'veros' ? -100 : 100;
      session.world.emit({ t: 'pointOwner', id: 'D', owner, from });
      session.world.events.flush();
    };
    const later = (s: number) => { session.world.time += s; };
    return { session, runtime, draw, radio, take, later };
  }

  it('calls the bleed once on the radio, after the point call that started it, and again after we led', async () => {
    const g = await screen();
    g.session.deploy(SOLDIER);
    g.take('veros');
    await vi.waitFor(() => expect(g.radio()).toEqual([t('battle.hud.point.enemy', { id: 'D' })]));
    g.later(RADIO_SECONDS + 0.1);
    await vi.waitFor(() => expect(g.radio()).toEqual([BEHIND]));
    g.later(RADIO_SECONDS + 0.1);
    await vi.waitFor(() => expect(g.radio()).toEqual([]));
    await new Promise(done => setTimeout(done, 300));
    expect(g.radio()).toEqual([]);
    g.take('coalition');
    await vi.waitFor(() => expect(g.radio()).toEqual([t('battle.hud.point.captured', { id: 'D' })]));
    g.later(RADIO_SECONDS + 0.1);
    await vi.waitFor(() => expect(g.radio()).toEqual([]));
    g.take('veros');
    await vi.waitFor(() => expect(g.radio()).toEqual([t('battle.hud.point.lost', { id: 'D' })]));
    g.later(RADIO_SECONDS + 0.1);
    await vi.waitFor(() => expect(g.radio()).toEqual([BEHIND]));
  }, 20000);

  it('holds a bleed that starts while dead until the next life', async () => {
    const g = await screen();
    g.session.deploy(SOLDIER);
    g.session.world.killPlayer('killed');
    for (let i = 0; i < 2; i++) g.session.step(STEP);
    g.take('veros');
    await vi.waitFor(() => expect(g.radio()).toEqual(['전사했습니다 · 티켓 -1']));
    g.later(RADIO_SECONDS + 0.1);
    await new Promise(done => setTimeout(done, 300));
    expect(g.radio()).toEqual(['전사했습니다 · 티켓 -1']);
    while (g.session.mode === 'crashed' || g.session.deployIn() > 0) g.session.step(STEP);
    expect(g.session.deploy(SOLDIER)).toBe(true);
    await vi.waitFor(() => expect(g.radio()).toEqual([BEHIND]));
  }, 20000);

  it('puts the ticket cost on the deploy screen death line too', async () => {
    const g = await screen();
    g.session.deploy(SOLDIER);
    g.session.world.killPlayer('killed');
    for (let i = 0; i < 2; i++) g.session.step(STEP);
    while (g.session.mode === 'crashed') g.session.step(STEP);
    await vi.waitFor(() => expect(all(container, 'tip')[0]?.textContent).toBe('전사했습니다 · 티켓 -1'));
  }, 20000);

  it('lists the tickets lost by cause on the report, copied at the end of the match', async () => {
    const g = await screen();
    const c = g.runtime.conquest, w = g.session.world, start = g.runtime.rules.tickets;
    let atEnd: typeof c.causes.coalition | null = null;
    w.events.on('battleEnd', () => { atEnd = { ...c.causes.coalition }; });
    g.session.frozen = false;
    g.take('veros');
    for (let i = 0; i < 3 / STEP; i++) g.session.step(STEP);
    const squad = w.units.find(u => u.side === 'coalition' && u.def.squad && u.alive)!;
    const car = w.units.find(u => u.side === 'coalition' && !u.def.squad && u.def.move && !u.def.move.air && u.alive)!;
    w.damageUnit(squad, squad.def.hp / 2, false);
    w.damageUnit(car, 1e9, false);
    while (c.tickets.coalition > 0) c.playerDied('coalition', 'attackHeli');
    for (let i = 0; g.session.mode !== 'done' && i < 10 / STEP; i++) g.session.step(STEP);
    expect(g.session.mode).toBe('done');
    expect(c.winner).toBe('veros');
    const end = atEnd!;
    for (const k of ['bleed', 'person', 'vehicle', 'player'] as const) expect(end[k], k).toBeGreaterThan(0);
    const sum = end.bleed + end.person + end.vehicle + end.player, clamp = sum - (start - c.tickets.coalition);
    expect(c.tickets.coalition).toBe(0);
    expect(clamp).toBeGreaterThan(0);
    expect(clamp).toBeCloseTo(sum - start, 9);
    const line = () => all(all(container, 'report')[0] ?? container, 'sub').map(n => n.textContent).find(s => s.startsWith('잃은 티켓'));
    const text = `잃은 티켓: 거점 열세 ${Math.floor(end.bleed)} · 병력 ${Math.floor(end.person)} · 탈것 ${Math.floor(end.vehicle)} · 나 ${Math.floor(end.player)}`;
    await vi.waitFor(() => expect(line()).toBe(text));
    c.causes.coalition.person += 50;
    c.causes.coalition.bleed += 50;
    g.draw();
    await new Promise(done => setTimeout(done, 200));
    expect(line()).toBe(text);
  }, 30000);
});

describe('heli touch radio slot (#331)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function hud(touch: boolean, heli: boolean) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 7 });
    session.start();
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleHud, { session, runtime, side: 'coalition', renderer: null, touch, death: new DeathReport(session), marks: new PointMarkBoard() }));
    await vi.waitFor(() => expect(all(container, 'battle-canvas').length).toBe(1));
    const pad = session.world.pads[0];
    session.deploy(heli ? { kind: 'heli', at: 'air', x: pad.x, z: pad.z, agl: 150, headingDeg: 0, kit: STANDARD_LOADOUT, speed: 0 } : SOLDIER);
    const cls = () => all(container, 'battle-hud')[0]?.attrs.class;
    await vi.waitFor(() => expect(cls()).toBeDefined());
    return { session, cls };
  }

  it('marks the touch hud only while flying the heli in play', async () => {
    const g = await hud(true, true);
    expect(g.cls()).toBe('battle-hud touch heli');
    g.session.world.killPlayer('rotorLoss');
    for (let i = 0; i < 2; i++) g.session.step(STEP);
    expect(g.session.mode).toBe('crashed');
    await vi.waitFor(() => expect(g.cls()).toBe('battle-hud touch'));
  });

  it.each([[true, false, 'battle-hud touch'], [false, true, 'battle-hud'], [false, false, 'battle-hud']])('touch %s heli %s keeps %s', async (touch, heli, want) => {
    const g = await hud(touch, heli);
    expect(g.cls()).toBe(want);
  });
});
