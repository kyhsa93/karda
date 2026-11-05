import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { t } from '../../content/strings';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STEP } from '../../sim/world';
import { BattleOverlays } from './Battle';
import { coachText } from './coach';
import { DeathReport } from './deathReport';
import { BattleHud, TICKET_WARN } from './hud/BattleHud';
import { loadBattle } from './loadBattle';

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: any, public nodeValue = '') {}
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

  async function game() {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 7 });
    session.start();
    const death = new DeathReport(session);
    root = createRoot(container as unknown as HTMLElement);
    root.render([
      createElement(BattleHud, { key: 'hud', session, runtime, side: 'coalition', renderer: null, touch: false, death }),
      createElement(BattleOverlays, { key: 'overlays', game: { mod, session, runtime, death }, side: 'coalition', touch: false, tips: ['card.soldier', 'rules.dead'], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }),
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
    return { session, runtime, enemy, steps, die, radio };
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
    root.render(createElement(BattleOverlays, { game: { mod, session, runtime, death }, side: 'coalition', touch, tips: [], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }));
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

  it('leaves them off the pad card', async () => {
    vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true }] });
    expect(await card(false)).not.toMatch(/구급|연막/);
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
    root.render(createElement(BattleOverlays, { game: { mod, session, runtime, death }, side, touch: true, tips: [], onTip: noop, onRole: noop, onAgain: noop, onSetup: noop, onTitle: noop }));
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
