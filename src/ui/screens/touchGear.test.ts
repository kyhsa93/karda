import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import harekRaw from '../../content/battle/maps/harek.json?raw';
import { t } from '../../content/strings';
import type { BattleMapDef } from '../../sim/battle/schema';
import type { SoldierClass } from '../../sim/infantry/soldier';
import { STEP } from '../../sim/world';
import { loadBattle } from '../battle/loadBattle';
import { Flight } from './Flight';

vi.mock('../../assets/loader', () => ({ assets: { loadGroup: async () => ({ loaded: [] }), get: () => null } }));
vi.mock('../../render/renderer', () => ({
  FlightRenderer: class {
    constructor(opts: unknown) { (globalThis as Record<string, unknown>).__rendererOpts = opts; }
    applySettings() {}
    dispose() {}
  },
}));

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  style: Record<string, unknown> = { setProperty() {} };
  attrs: Record<string, string> = {};
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: unknown, public nodeValue = '') {}
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
  replaceChildren(...c: FakeNode[]) { this.childNodes = []; for (const n of c) this.appendChild(n); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
  getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
}

function all(node: FakeNode, cls: string): FakeNode[] {
  return node.childNodes.flatMap(c => [...((c.attrs.class ?? '').split(' ').includes(cls) ? [c] : []), ...all(c, cls)]);
}

const harek = JSON.parse(harekRaw) as BattleMapDef;

describe('touch gear buttons through the real Flight render (#233)', () => {
  let root: Root;
  let container: FakeNode;

  beforeEach(() => {
    const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
    doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
    doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
    doc.documentElement = (doc.createElement as (t: string) => FakeNode)('html');
    doc.body = (doc.createElement as (t: string) => FakeNode)('body');
    const win = { document: doc, location: { hash: '', search: '' }, HTMLIFrameElement: class {}, devicePixelRatio: 1, innerWidth: 844, innerHeight: 390, addEventListener() {}, removeEventListener() {}, scrollTo() {} };
    doc.defaultView = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('location', win.location);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    container = (doc.createElement as (t: string) => FakeNode)('div');
  });

  afterEach(async () => {
    root.unmount();
    await new Promise(done => setTimeout(done, 20));
    vi.unstubAllGlobals();
  });

  async function flight(cls: SoldierClass) {
    const mod = await loadBattle();
    const { session } = mod.createBattleSession(harek, 'quick', { side: 'coalition', seed: 1 });
    session.start();
    session.deploy({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls });
    const world = session.world;
    root = createRoot(container as unknown as HTMLElement);
    root.render(createElement(Flight, { session, touch: true, onExit: () => {} }));
    await vi.waitFor(() => expect(all(container, 'soldier-gear')).toHaveLength(1));
    const opts = (globalThis as Record<string, unknown>).__rendererOpts as { onFrame: (f: { simDt: number; cockpit: boolean; agl: number }) => void };
    const frame = async () => { opts.onFrame({ simDt: STEP, cockpit: false, agl: 0 }); await new Promise(done => setTimeout(done, 20)); };
    const labels = () => all(container, 'soldier-gear')[0].childNodes.map(n => n.textContent);
    const steps = (sec: number) => { for (let i = 0; i < Math.round(sec / STEP); i++) session.step(STEP); };
    await frame();
    return { world, frame, labels, steps };
  }

  it('shows the assault counts and medkit state on the buttons', async () => {
    const { labels } = await flight('assault');
    expect(labels()).toEqual(['유탄 6', '재장전', '구급 상자 준비', '연막 2']);
  });

  it('marks the buttons whose width is held while their state changes', async () => {
    await flight('assault');
    const classes = () => all(container, 'soldier-gear')[0].childNodes.map(n => n.attrs.class);
    expect(classes()).toEqual(['tbtn swap', 'tbtn', 'tbtn medkit', 'tbtn']);
    root.unmount();
    await flight('engineer');
    expect(classes()).toEqual(['tbtn swap', 'tbtn', 'tbtn repair', 'tbtn']);
  });

  it('keeps the medkit and smoke names the control card checks (#301, #302)', async () => {
    const { labels } = await flight('assault');
    expect(labels().find(l => l.startsWith(`${t('touch.medkit')} `))).toBeDefined();
    expect(labels().find(l => l.startsWith(`${t('touch.smoke')} `))).toBeDefined();
  });

  it('updates the grenade count after a grenade is fired without touching the button', async () => {
    const { world, frame, labels, steps } = await flight('assault');
    world.selectSoldierWeapon('grenade');
    steps(0.5);
    await frame();
    expect(labels()[0]).toBe('소총');
    world.soldierCommands.fire = true;
    steps(0.1);
    world.soldierCommands.fire = false;
    expect(world.soldierArms.ammo.grenade!.mag + world.soldierArms.ammo.grenade!.reserve).toBe(5);
    world.selectSoldierWeapon('rifle');
    await frame();
    expect(labels()[0]).toBe('유탄 5');
  });

  it('shows the placed medkit time and the redeploy wait, ticking each second', async () => {
    const { world, frame, labels, steps } = await flight('assault');
    expect(world.placeMedkit()).toBe(true);
    await frame();
    expect(labels()[2]).toBe('구급 상자 작동 60초');
    steps(1.5);
    await frame();
    expect(labels()[2]).toBe('구급 상자 작동 59초');
    steps(59);
    await frame();
    expect(world.soldierGear.medkit).toBeNull();
    expect(labels()[2]).toBe('구급 상자 재배치 30초');
  });

  it('drops the smoke button when the last smoke is thrown', async () => {
    const { world, frame, labels } = await flight('assault');
    world.throwSmoke();
    await frame();
    expect(labels()[3]).toBe('연막 1');
    world.throwSmoke();
    await frame();
    expect(labels()).toEqual(['유탄 6', '재장전', '구급 상자 준비']);
  });

  it('shows the engineer rocket and mine counts and the repair overheat', async () => {
    const { world, frame, labels } = await flight('engineer');
    expect(labels()).toEqual(['로켓 3', '재장전', '수리', '지뢰 2']);
    world.placeMine();
    await frame();
    expect(labels()[3]).toBe('지뢰 1');
    world.placeMine();
    await frame();
    expect(labels()).toEqual(['로켓 3', '재장전', '수리']);
    world.soldierGear.overheatUntil = world.time + 3;
    await frame();
    expect(labels()[2]).toBe('수리 과열 3초');
  });
});
