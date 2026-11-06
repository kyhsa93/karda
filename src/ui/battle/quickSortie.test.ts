import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { t } from '../../content/strings';
import type { SortieRole } from '../../save/save';
import type { BattleMapDef } from '../../sim/battle/schema';
import { STEP } from '../../sim/world';
import { BattleOverlays } from './Battle';
import { DEFAULT_CHOICE } from './BattleSetup';
import { PointMarkBoard } from './coach';
import { DeathReport } from './deathReport';
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

const buttons = (node: FakeNode): FakeNode[] => node.childNodes.flatMap(c => [...(c.nodeName === 'BUTTON' ? [c] : []), ...buttons(c)]);

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
const RALLY = harek.modes.quick!.rally!.coalition;
const noop = () => {};

describe('quick sortie (#239)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => { container = fakeDom(); });
  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function mount({ quick, tips, lastRole }: { quick: boolean; tips: readonly string[]; lastRole?: SortieRole }) {
    const mod = await loadBattle();
    const { session, runtime } = mod.createBattleSession(harek, 'quick', { side: DEFAULT_CHOICE.side, seed: 7 });
    session.start();
    const death = new DeathReport(session);
    const onRole = vi.fn();
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(BattleOverlays, { game: { mod, session, runtime, death, marks: new PointMarkBoard() }, side: DEFAULT_CHOICE.side, quick, touch: false, tips, onTip: noop, lastRole, onRole, onAgain: noop, onSetup: noop, onTitle: noop }));
    await new Promise(done => setTimeout(done, 20));
    const picked = (row: number) => all(all(container, 'setting-row')[row], 'on')[0]?.textContent;
    return { session, onRole, picked };
  }

  it('deploys a seen profile at the forward rally as an assault soldier without recording it, even when the last role was the helicopter', async () => {
    const g = await mount({ quick: true, tips: ['card.soldier', 'card.apache'], lastRole: 'heli' });
    expect(g.session.mode).toBe('play');
    const body = g.session.world.playerBody();
    expect(body.kind).toBe('soldier');
    expect([body.pos.x, body.pos.z]).toEqual(RALLY);
    expect(g.session.world.soldier?.cls).toBe('assault');
    expect(g.onRole).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(t('battle.deploy.title'));
  });

  it('records the helicopter once it is picked on the deploy screen after a death in a quick sortie', async () => {
    const g = await mount({ quick: true, tips: ['card.soldier', 'card.apache'], lastRole: 'heli' });
    expect(g.session.mode).toBe('play');
    const enemy = g.session.world.units.find(u => u.alive && u.side === 'veros')!;
    g.session.world.emit({ t: 'playerHit', by: enemy.id, weapon: 'g_rifle', damage: 1000 });
    while (g.session.mode !== 'deploy' || g.session.deployIn() > 0) g.session.step(STEP);
    await vi.waitFor(() => expect(container.textContent).toContain(t('battle.deploy.title')));
    expect(g.picked(0)).toBe(t('battle.roles.soldier'));
    press(buttons(container).find(b => b.textContent === t('battle.roles.heli'))!);
    await vi.waitFor(() => expect(g.picked(0)).toBe(t('battle.roles.heli')));
    const go = () => buttons(container).find(b => b.attrs.class === 'go')!;
    await vi.waitFor(() => expect(go().textContent).toBe(`${t('battle.deploy.go')} ▶`));
    press(go());
    expect(g.session.mode).toBe('play');
    expect(g.session.world.playerBody().kind).toBe('heli');
    expect(g.onRole.mock.calls).toEqual([['heli']]);
  });

  it('stops a first visit on the deploy screen with the soldier control card, soldier and rally picked', async () => {
    const g = await mount({ quick: true, tips: [], lastRole: 'heli' });
    expect(g.session.mode).toBe('deploy');
    expect(all(container, 'control-card')).toHaveLength(1);
    expect(all(container, 'control-card')[0].textContent).toContain(t('battle.card.soldier.title'));
    expect(g.picked(0)).toBe(t('battle.roles.soldier'));
    expect(g.picked(1)).toBe(t('battle.deploy.spawnRally'));
    expect(g.onRole).not.toHaveBeenCalled();
  });

  it('leaves the battle path on the deploy screen with the last role', async () => {
    const g = await mount({ quick: false, tips: ['card.soldier', 'card.apache'], lastRole: 'heli' });
    expect(g.session.mode).toBe('deploy');
    expect(g.picked(0)).toBe(t('battle.roles.heli'));
    expect(g.onRole).not.toHaveBeenCalled();
  });
});
