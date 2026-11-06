import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Suspense, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { t } from '../../content/strings';
import { SAVE_KEY } from '../../save/save';
import { memoryStorage, type KeyValue } from '../../save/storage';
import { BattleLoadBoundary } from './BattleLoadBoundary';
import { DEFAULT_CHOICE, loadChoice, storeChoice, type BattleChoice } from './BattleSetup';

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
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join(' '); }
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
}

function fakeDom(hash: string) {
  const reload = vi.fn();
  const doc: any = new FakeNode(9, '#document', null);
  doc.createElement = (type: string) => new FakeNode(1, type.toUpperCase(), doc);
  doc.createTextNode = (text: string) => new FakeNode(3, '#text', doc, text);
  doc.body = doc.createElement('body');
  doc.documentElement = doc.createElement('html');
  doc.activeElement = doc.body;
  const win: any = {
    document: doc, location: { hash, search: '', reload }, screen: { width: 1280, height: 720 }, HTMLIFrameElement: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
  };
  doc.defaultView = win;
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  return { container: doc.createElement('div') as FakeNode, reload, location: win.location as { hash: string; search: string } };
}

function buttons(node: FakeNode): FakeNode[] {
  return node.childNodes.flatMap(c => (c.nodeName === 'BUTTON' ? [c] : buttons(c)));
}

function press(node: FakeNode) {
  const key = Object.keys(node).find(k => k.startsWith('__reactProps'))!;
  (node as any)[key].onClick();
}

const TEXT = t('battle.loadError.text');
const RETRY = t('battle.loadError.retry');
const DEPLOY = t('battle.setup.deploy');
const boom = new Error('chunk 404');
const causedByBoom = (e: unknown): boolean => e instanceof Error && (e === boom || e.message.includes(boom.message) || causedByBoom(e.cause));

async function importFails(): Promise<Record<string, unknown>> {
  throw boom;
}

describe('battle chunk load failure (#218)', () => {
  let root: Root;
  let dom: ReturnType<typeof fakeDom>;
  let logged: ReturnType<typeof vi.spyOn>;
  const mount = (el: ReactElement) => {
    root = createRoot(dom.container as unknown as HTMLElement);
    root.render(el);
  };
  const expectErrorScreen = async () => {
    await vi.waitFor(() => expect(dom.container.textContent).toContain(TEXT));
    expect(buttons(dom.container).map(b => b.textContent)).toEqual([RETRY]);
    expect(logged.mock.calls.flat().some(causedByBoom)).toBe(true);
    expect(dom.reload).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.resetModules();
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    root?.unmount();
    vi.doUnmock('../../assets/loader');
    vi.doUnmock('./Battle');
    vi.doUnmock('./loadBattle');
    vi.restoreAllMocks();
    vi.stubGlobal('sessionStorage', undefined);
  });

  async function app(hash: string, battle: () => Promise<Record<string, unknown>>) {
    dom = fakeDom(hash);
    vi.doMock('../../assets/loader', () => ({ assets: { loadGroup: async () => {} } }));
    vi.doMock('./Battle', battle);
    const { App } = await import('../../App');
    mount(createElement(App));
  }

  it('shows the retry screen when the screen chunk fails, and only reloads on the press', async () => {
    await app('#/battle', importFails);
    await vi.waitFor(() => expect(dom.container.textContent).toContain(DEPLOY));
    press(buttons(dom.container).find(b => b.textContent.includes(DEPLOY))!);
    await expectErrorScreen();
    press(buttons(dom.container)[0]);
    expect(dom.reload).toHaveBeenCalledTimes(1);
  });

  it('lands on the same error screen after a reload while the chunk is still missing', async () => {
    await app('#/battle/harek/quick', importFails);
    await expectErrorScreen();
  });

  it('lands on the error screen after a reload while only the map chunk is missing', async () => {
    await app('#/battle/harek/quick', async () => ({ checkBattleLoads: () => Promise.reject(boom) }));
    await expectErrorScreen();
  });

  it('returns to the setup screen after a reload once the chunks load', async () => {
    await app('#/battle/harek/quick', async () => ({ checkBattleLoads: async () => {} }));
    await vi.waitFor(() => expect(dom.container.textContent).toContain(DEPLOY));
    expect(dom.container.textContent).not.toContain(TEXT);
  });

  it.each([
    ['battle code', () => Promise.reject(boom)],
    ['map', () => Promise.resolve({ loadMap: () => Promise.reject(boom) })],
  ])('sends a %s failure inside the battle screen to the boundary', async (_, loadBattle) => {
    dom = fakeDom('#/battle/harek/quick');
    vi.doMock('./loadBattle', () => ({ loadBattle }));
    const { Battle } = await vi.importActual<typeof import('./Battle')>('./Battle');
    const props = { choice: { mode: 'quick', map: 'harek', side: 'coalition', time: 'day' }, touch: false, settings: {}, onSettings() {}, onSetup() {}, onTitle() {}, tips: [], onTip() {}, onRole() {} } as unknown as Parameters<typeof Battle>[0];
    mount(createElement(BattleLoadBoundary, null, createElement(Suspense, null, createElement(Battle, props))));
    await expectErrorScreen();
  });

  it('keeps the chosen side through a reload of the app', async () => {
    const VPA = t('battle.sides.veros');
    vi.stubGlobal('sessionStorage', memoryStorage());
    await app('#/battle', async () => ({}));
    await vi.waitFor(() => expect(dom.container.textContent).toContain(VPA));
    press(buttons(dom.container).find(b => b.textContent === VPA)!);
    await vi.waitFor(() => expect(loadChoice(sessionStorage).side).toBe('veros'));
    root.unmount();
    vi.resetModules();
    await app('#/battle', async () => ({}));
    await vi.waitFor(() => expect(buttons(dom.container).find(b => b.textContent === VPA)?.attrs.class).toBe('on'));
  });
});

describe('battle failure during the match (#264)', () => {
  const MATCH_TEXT = '오류로 이 경기를 이어갈 수 없습니다. 다시 불러오면 전장 설정으로 돌아갑니다.';
  const MATCH_RETRY = '다시 불러오기';
  const boom = new Error('frame boom');
  const VPA = t('battle.sides.veros');
  const BACK = t('battle.setup.back');
  let root: Root;
  let dom: ReturnType<typeof fakeDom>;
  let logged: ReturnType<typeof vi.spyOn>;
  let renderer: { opts: { onCrash: (error: unknown) => void }; dispose: ReturnType<typeof vi.fn> } | undefined;
  let breakHud: (() => void) | undefined;

  const start = async (hash: string) => {
    dom = fakeDom(hash);
    vi.stubGlobal('location', dom.location);
    const { App } = await import('../../App');
    root = createRoot(dom.container as unknown as HTMLElement);
    root.render(createElement(App));
  };
  const pressLabelled = (label: string) => press(buttons(dom.container).find(b => b.textContent === label)!);
  const pressDeploy = () => press(buttons(dom.container).find(b => b.textContent.includes(DEPLOY))!);
  const enterMatch = async () => {
    await start('#/battle');
    await vi.waitFor(() => expect(dom.container.textContent).toContain(DEPLOY));
    pressLabelled(VPA);
    await vi.waitFor(() => expect(buttons(dom.container).find(b => b.textContent === VPA)?.attrs.class).toBe('on'));
    pressDeploy();
    await vi.waitFor(() => { expect(renderer).toBeDefined(); expect(breakHud).toBeDefined(); }, { timeout: 30_000 });
    expect(dom.container.textContent).not.toContain(MATCH_TEXT);
  };
  const expectMatchError = async () => {
    await vi.waitFor(() => expect(dom.container.textContent).toContain(MATCH_TEXT));
    expect(dom.container.textContent).not.toContain(TEXT);
    expect(buttons(dom.container).map(b => b.textContent)).toEqual([MATCH_RETRY]);
    expect(logged.mock.calls.flat()).toContain(boom);
    expect(dom.reload).not.toHaveBeenCalled();
    expect(renderer!.dispose).toHaveBeenCalledTimes(1);
  };

  beforeEach(() => {
    vi.resetModules();
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderer = undefined;
    breakHud = undefined;
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.doMock('../../assets/loader', () => ({ assets: { get: () => null, loadGroup: async () => ({ loaded: [], failed: [] }) } }));
    vi.doMock('../../render/renderer', () => ({
      FlightRenderer: class {
        dispose = vi.fn();
        constructor(public opts: { onCrash: (error: unknown) => void }) { renderer = this; }
        applySettings() {}
      },
    }));
    vi.doMock('./hud/BattleHud', () => ({
      BattleHud: () => {
        const [broken, set] = useState(false);
        breakHud = () => set(true);
        if (broken) throw boom;
        return null;
      },
    }));
  });

  afterEach(() => {
    root?.unmount();
    vi.doUnmock('../../assets/loader');
    vi.doUnmock('../../render/renderer');
    vi.doUnmock('./hud/BattleHud');
    vi.restoreAllMocks();
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('location', undefined);
  });

  it('says the match cannot go on, in words apart from a load failure', () => {
    expect(t('battle.matchError.text')).toBe(MATCH_TEXT);
    expect(t('battle.matchError.retry')).toBe(MATCH_RETRY);
    expect(TEXT).toBe('전장을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.');
    expect(RETRY).toBe('다시 시도');
  });

  it('shows the match error when the frame loop reports a crash, and only reloads on the press', async () => {
    await enterMatch();
    renderer!.opts.onCrash(boom);
    await expectMatchError();
    press(buttons(dom.container)[0]);
    expect(dom.reload).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('shows the match error when React fails to render the match screen', async () => {
    await enterMatch();
    breakHud!();
    await expectMatchError();
  }, 60_000);

  it('keeps the old words when the map fails before the match screen is up', async () => {
    vi.doMock('./loadBattle', () => ({ loadBattle: () => Promise.resolve({ loadMap: () => Promise.reject(boom) }) }));
    await start('#/battle');
    await vi.waitFor(() => expect(dom.container.textContent).toContain(DEPLOY));
    pressDeploy();
    await vi.waitFor(() => expect(dom.container.textContent).toContain(TEXT));
    expect(dom.container.textContent).not.toContain(MATCH_TEXT);
    expect(buttons(dom.container).map(b => b.textContent)).toEqual([RETRY]);
    vi.doUnmock('./loadBattle');
  }, 60_000);

  it('reloads into the setup screen with the chosen side, and its back button reaches the title', async () => {
    await enterMatch();
    renderer!.opts.onCrash(boom);
    await expectMatchError();
    const hash = dom.location.hash;
    expect(hash).toBe('#/battle/harek/quick');
    root.unmount();
    vi.resetModules();
    await start(hash);
    await vi.waitFor(() => expect(buttons(dom.container).find(b => b.textContent === VPA)?.attrs.class).toBe('on'), { timeout: 30_000 });
    expect(dom.container.textContent).not.toContain(MATCH_TEXT);
    pressLabelled(BACK);
    await vi.waitFor(() => expect(dom.container.textContent).toContain(t('title.name')));
    expect(dom.location.hash).toBe('#/title');
  }, 90_000);
});

describe('play again (#265)', () => {
  const NOW = 1700000000000;
  const AGAIN = t('battle.report.again');
  const LOADING = t('battle.deploy.loading');
  const GO = t('battle.deploy.go');
  type FakeSession = { mode: string; step(dt: number): void; objective: { conquest: { tickets: { veros: number } } } };
  type FakeRenderer = { opts: { session: FakeSession }; dispose: ReturnType<typeof vi.fn> };
  let root: Root;
  let dom: ReturnType<typeof fakeDom>;
  let renderers: FakeRenderer[];
  let seeds: number[];
  let hold: Promise<void> | null;
  let frames: (() => void)[] | null;

  const shown = () => dom.container.textContent;
  const finishMatch = async () => {
    const session = renderers.at(-1)!.opts.session;
    await vi.waitFor(() => expect(shown()).toContain(GO));
    press(buttons(dom.container).find(b => b.textContent.includes(GO))!);
    session.objective.conquest.tickets.veros = 0;
    for (let i = 0; i < 2400 && session.mode !== 'done'; i++) session.step(1 / 120);
    await vi.waitFor(() => expect(shown()).toContain(AGAIN));
  };
  const pressAgain = () => press(buttons(dom.container).find(b => b.textContent === AGAIN)!);

  beforeEach(async () => {
    vi.resetModules();
    dom = fakeDom('#/battle/harek/quick');
    renderers = [];
    seeds = [];
    hold = null;
    frames = null;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal('requestAnimationFrame', (frame: () => void) => { if (frames) frames.push(frame); else setTimeout(frame); });
    vi.stubGlobal('location', dom.location);
    vi.doMock('../../assets/loader', () => ({ assets: { get: () => null, loadGroup: async () => ({ loaded: [], failed: [] }) } }));
    vi.doMock('../../render/renderer', () => ({
      FlightRenderer: class {
        dispose = vi.fn();
        constructor(public opts: { session: FakeSession }) { renderers.push(this); }
        applySettings() {}
      },
    }));
    vi.doMock('./hud/BattleHud', () => ({ BattleHud: () => null }));
    vi.doMock('./loadBattle', async () => {
      const real = await vi.importActual<typeof import('../../sim/battle')>('../../sim/battle');
      return {
        loadBattle: async () => ({
          ...real,
          loadMap: async (id: 'harek') => { await hold; return real.loadMap(id); },
          createBattleSession: (...args: Parameters<typeof real.createBattleSession>) => { seeds.push(args[2].seed!); return real.createBattleSession(...args); },
        }),
      };
    });
    const { Battle } = await import('./Battle');
    const { defaultSettings } = await import('../../save/save');
    const props = { choice: DEFAULT_CHOICE, touch: false, settings: defaultSettings(), onSettings() {}, onSetup() {}, onTitle() {}, tips: [], onTip() {}, onRole() {} } as unknown as Parameters<typeof Battle>[0];
    root = createRoot(dom.container as unknown as HTMLElement);
    root.render(createElement(BattleLoadBoundary, null, createElement(Suspense, null, createElement(Battle, props))));
    await vi.waitFor(() => expect(renderers).toHaveLength(1), { timeout: 30_000 });
  });

  afterEach(() => {
    root?.unmount();
    for (const m of ['../../assets/loader', '../../render/renderer', './hud/BattleHud', './loadBattle']) vi.doUnmock(m);
    vi.restoreAllMocks();
    vi.stubGlobal('location', undefined);
    vi.stubGlobal('requestAnimationFrame', undefined);
  });

  it('builds one renderer per press, for the new match, after the old one is gone', async () => {
    for (let press = 1; press <= 3; press++) {
      await finishMatch();
      const old = renderers.at(-1)!;
      pressAgain();
      await vi.waitFor(() => expect(renderers).toHaveLength(press + 1), { timeout: 30_000 });
      expect(old.dispose).toHaveBeenCalledTimes(1);
      expect(renderers.at(-1)!.opts.session).not.toBe(old.opts.session);
    }
    expect(new Set(renderers.map(r => r.opts.session)).size).toBe(renderers.length);
  }, 90_000);

  it('shows the loading card, not the old report, until the new match is ready', async () => {
    await finishMatch();
    let release = () => {};
    hold = new Promise(resolve => { release = resolve; });
    pressAgain();
    await vi.waitFor(() => expect(shown()).toContain(LOADING));
    expect(shown()).not.toContain(AGAIN);
    expect(renderers).toHaveLength(1);
    expect(renderers[0].dispose).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(renderers).toHaveLength(2), { timeout: 30_000 });
    expect(shown()).not.toContain(LOADING);
    expect(shown()).not.toContain(AGAIN);
  }, 90_000);

  it('lets the loading card reach the screen before the heavy build starts', async () => {
    await finishMatch();
    frames = [];
    pressAgain();
    for (let frame = 0; frame < 2; frame++) {
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(shown()).toContain(LOADING);
      expect(seeds).toHaveLength(1);
      frames.shift()!();
    }
    await vi.waitFor(() => expect(seeds).toHaveLength(2), { timeout: 30_000 });
    await vi.waitFor(() => expect(renderers).toHaveLength(2), { timeout: 30_000 });
  }, 90_000);

  it('starts the next match with no deaths or tips carried over from a death in the last one (#234)', async () => {
    type World = { units: { id: number; side: string; defId: string }[]; emit(e: unknown): void };
    const tips = () => {
      const all = (n: typeof dom.container): (typeof dom.container)[] => n.childNodes.flatMap(c => [...((c.attrs.class ?? '').split(' ').includes('tip') ? [c] : []), ...all(c)]);
      return all(dom.container).length;
    };
    const session = renderers.at(-1)!.opts.session as FakeSession & { world: World; deployIn(): number };
    await vi.waitFor(() => expect(shown()).toContain(GO));
    press(buttons(dom.container).find(b => b.textContent.includes(GO))!);
    const enemy = session.world.units.find(u => u.side === 'veros' && u.defId === 'aaa_light')!;
    session.world.emit({ t: 'playerHit', by: enemy.id, weapon: 'g_rifle', damage: 1000 });
    for (let i = 0; i < 40_000 && (session.mode !== 'deploy' || session.deployIn() > 0); i++) session.step(1 / 120);
    await vi.waitFor(() => expect(tips()).toBeGreaterThan(0));
    await finishMatch();
    expect(shown()).toContain(t('battle.report.deaths', { n: 1 }));
    pressAgain();
    await vi.waitFor(() => expect(renderers).toHaveLength(2), { timeout: 30_000 });
    await vi.waitFor(() => expect(shown()).toContain(GO));
    expect(tips()).toBe(0);
    await finishMatch();
    expect(shown()).toContain(t('battle.report.deaths', { n: 0 }));
  }, 90_000);

  it('keeps the seed at the clock plus the round', async () => {
    for (let press = 0; press < 2; press++) {
      await finishMatch();
      const old = renderers.at(-1)!.opts.session;
      pressAgain();
      await vi.waitFor(() => expect(renderers.at(-1)!.opts.session).not.toBe(old), { timeout: 30_000 });
    }
    expect(seeds).toEqual([0, 1, 2].map(round => (NOW & 0xffff) + round));
  }, 90_000);
});

describe('losing the WebGL context during the match (#268)', () => {
  const PAUSED = '그래픽 연결이 끊겨 화면을 표시할 수 없습니다. 경기를 멈추고 복구를 기다립니다.';
  const RUNNING = '그래픽 연결이 끊겨 화면을 표시할 수 없습니다. 복구를 기다리는 동안 경기는 계속됩니다.';
  const STUCK = '화면을 복구하지 못해 이 경기를 이어갈 수 없습니다. 다시 불러오면 전장 설정으로 돌아갑니다.';
  const RELOAD = '다시 불러오기';
  const STEP = 1 / 120;
  type Session = { mode: string; paused: boolean; frozen: boolean; world: { time: number }; step: (dt: number) => void; publish: () => void };
  let root: Root;
  let dom: ReturnType<typeof fakeDom>;
  let renderer: { opts: { session: Session; onCrash: (error: unknown) => void; onContextLost: () => void; onContextRestored: () => void }; dispose: ReturnType<typeof vi.fn> } | undefined;
  let keydown: Set<(e: unknown) => void>;
  let logged: ReturnType<typeof vi.spyOn>;

  const text = () => dom.container.textContent;
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)); };
  const labels = () => buttons(dom.container).map(b => b.textContent);
  const pressLabelled = (label: string) => press(buttons(dom.container).find(b => b.textContent.includes(label))!);
  const session = () => renderer!.opts.session;
  const advances = () => { const before = session().world.time; session().step(STEP); return session().world.time - before; };
  const key = (code: string) => { for (const fn of keydown) fn({ code, repeat: false, preventDefault() {} }); };
  const inSortie = async () => {
    dom = fakeDom('#/battle');
    vi.stubGlobal('location', dom.location);
    const win = window as unknown as { addEventListener: (type: string, fn: (e: unknown) => void) => void; removeEventListener: (type: string, fn: (e: unknown) => void) => void };
    win.addEventListener = (type, fn) => { if (type === 'keydown') keydown.add(fn); };
    win.removeEventListener = (type, fn) => { if (type === 'keydown') keydown.delete(fn); };
    const { App } = await import('../../App');
    root = createRoot(dom.container as unknown as HTMLElement);
    root.render(createElement(App));
    await vi.waitFor(() => expect(text()).toContain(DEPLOY));
    press(buttons(dom.container).find(b => b.textContent.includes(DEPLOY))!);
    await vi.waitFor(() => { expect(renderer).toBeDefined(); expect(text()).toContain(t('battle.deploy.go')); }, { timeout: 30_000 });
  };
  const inPlay = async () => {
    await inSortie();
    pressLabelled(t('battle.deploy.go'));
    await vi.waitFor(() => expect(session().mode).toBe('play'));
    await vi.waitFor(() => expect(text()).not.toContain(t('battle.deploy.go')));
  };
  const lose = async (expected: string) => {
    renderer!.opts.onContextLost();
    await vi.waitFor(() => expect(text()).toContain(expected));
  };
  const expectNoErrorScreen = () => {
    expect(text()).not.toContain(t('battle.matchError.text'));
    expect(dom.reload).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.resetModules();
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderer = undefined;
    keydown = new Set();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.doMock('../../assets/loader', () => ({ assets: { get: () => null, loadGroup: async () => ({ loaded: [], failed: [] }) } }));
    vi.doMock('../../audio/game', () => ({ GameAudio: class { voice = { enabled: false }; setVolume() {} async loadSamples() {} async resume() {} dispose() {} } }));
    vi.doMock('../../render/renderer', () => ({
      FlightRenderer: class {
        dispose = vi.fn();
        constructor(public opts: NonNullable<typeof renderer>['opts']) { renderer = this; }
        applySettings() {}
      },
    }));
    vi.doMock('./hud/BattleHud', () => ({ BattleHud: () => null }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    root?.unmount();
    vi.doUnmock('../../assets/loader');
    vi.doUnmock('../../audio/game');
    vi.doUnmock('../../render/renderer');
    vi.doUnmock('./hud/BattleHud');
    vi.restoreAllMocks();
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('location', undefined);
  });

  it('tells the player in Korean and stops the match while the context is gone', async () => {
    await inPlay();
    expect(text()).not.toContain(PAUSED);
    expect(session().paused).toBe(false);
    expect(advances()).toBeGreaterThan(0);
    await lose(PAUSED);
    await vi.waitFor(() => expect(session().paused).toBe(true));
    expect(advances()).toBe(0);
    expect(labels()).not.toContain(RELOAD);
    expectNoErrorScreen();
  }, 60_000);

  it('takes the notice away and resumes the match on restore', async () => {
    await inPlay();
    await lose(PAUSED);
    await vi.waitFor(() => expect(session().paused).toBe(true));
    renderer!.opts.onContextRestored();
    await vi.waitFor(() => expect(text()).not.toContain(PAUSED));
    await vi.waitFor(() => expect(session().paused).toBe(false));
    expect(advances()).toBeGreaterThan(0);
  }, 60_000);

  it('keeps a pause menu the player opened through a loss and restore', async () => {
    await inPlay();
    key('Escape');
    await vi.waitFor(() => expect(text()).toContain(t('pause.title')));
    await vi.waitFor(() => expect(session().paused).toBe(true));
    await lose(PAUSED);
    renderer!.opts.onContextRestored();
    await vi.waitFor(() => expect(text()).not.toContain(PAUSED));
    expect(text()).toContain(t('pause.title'));
    expect(session().paused).toBe(true);
    expect(advances()).toBe(0);
    pressLabelled(t('brief.continue'));
    await vi.waitFor(() => expect(session().paused).toBe(false));
  }, 60_000);

  it('after ten seconds says the match cannot go on and offers the reload', async () => {
    await inPlay();
    renderer!.opts.onContextLost();
    await settle();
    expect(text()).toContain(PAUSED);
    vi.advanceTimersByTime(9_999);
    await settle();
    expect(text()).not.toContain(STUCK);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(text()).toContain(STUCK));
    expect(text()).not.toContain(PAUSED);
    expect(labels()).toContain(RELOAD);
    expect(session().paused).toBe(true);
    expect(advances()).toBe(0);
    expect(dom.reload).not.toHaveBeenCalled();
    pressLabelled(RELOAD);
    expect(dom.reload).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('recovers from the stuck notice if the context comes back late, and never reports stuck again for the old loss', async () => {
    await inPlay();
    await lose(PAUSED);
    vi.advanceTimersByTime(10_000);
    await vi.waitFor(() => expect(text()).toContain(STUCK));
    renderer!.opts.onContextRestored();
    await vi.waitFor(() => expect(text()).not.toContain(STUCK));
    await vi.waitFor(() => expect(session().paused).toBe(false));
    expect(labels()).not.toContain(RELOAD);
    await lose(PAUSED);
    expect(text()).not.toContain(STUCK);
  }, 60_000);

  it('does not start a second timer from a restore before the deadline', async () => {
    await inPlay();
    await lose(PAUSED);
    vi.advanceTimersByTime(6_000);
    renderer!.opts.onContextRestored();
    await vi.waitFor(() => expect(text()).not.toContain(PAUSED));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    vi.advanceTimersByTime(12_000);
    await settle();
    expect(text()).not.toContain(STUCK);
    expect(session().paused).toBe(false);
  }, 60_000);

  it('clears the timer on leaving, so no notice or pause lands on what comes next', async () => {
    await inPlay();
    key('Escape');
    await vi.waitFor(() => expect(text()).toContain(t('pause.title')));
    await lose(PAUSED);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    pressLabelled(t('pause.quit'));
    await vi.waitFor(() => expect(text()).toContain(DEPLOY));
    expect(renderer!.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(12_000);
    await settle();
    expect(text()).not.toContain(STUCK);
    expect(text()).not.toContain(PAUSED);
  }, 60_000);

  it('calls the match stopped on the first deploy screen, where the clock has not started', async () => {
    await inSortie();
    expect(session().frozen).toBe(true);
    await lose(PAUSED);
    expect(session().paused).toBe(false);
    expect(advances()).toBe(0);
  }, 60_000);

  it('does not pause a later deploy screen, says the match runs on, and pauses as soon as play starts', async () => {
    await inSortie();
    session().frozen = false;
    await lose(RUNNING);
    expect(text()).not.toContain(PAUSED);
    expect(session().paused).toBe(false);
    expect(advances()).toBeGreaterThan(0);
    pressLabelled(t('battle.deploy.go'));
    await vi.waitFor(() => expect(session().mode).toBe('play'));
    await vi.waitFor(() => expect(text()).toContain(PAUSED));
    await vi.waitFor(() => expect(session().paused).toBe(true));
    expect(advances()).toBe(0);
  }, 60_000);

  it('leaves the match report usable, where nothing needs the context', async () => {
    await inPlay();
    await lose(PAUSED);
    session().mode = 'done';
    session().publish();
    await vi.waitFor(() => expect(text()).toContain(t('battle.report.again')));
    expect(text()).not.toContain(PAUSED);
    expect(text()).not.toContain(RUNNING);
    expect(session().paused).toBe(false);
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(text()).not.toContain(STUCK);
    expect(labels()).toEqual([t('battle.report.again'), t('battle.report.setup'), t('battle.report.title')]);
  }, 60_000);

  it('never reaches the error screen through a loss', async () => {
    await inPlay();
    await lose(PAUSED);
    vi.advanceTimersByTime(10_000);
    await vi.waitFor(() => expect(text()).toContain(STUCK));
    expectNoErrorScreen();
    expect(logged).not.toHaveBeenCalled();
  }, 60_000);
});

describe('battle choice across a reload (#218)', () => {
  const dusk: BattleChoice = { ...DEFAULT_CHOICE, side: 'veros', time: 'dusk' };

  it('restores the stored side and time', () => {
    const store = memoryStorage();
    storeChoice(dusk, store);
    expect(loadChoice(store)).toEqual(dusk);
  });

  it('falls back to the defaults on missing or broken data', () => {
    const store = memoryStorage();
    expect(loadChoice(store)).toEqual(DEFAULT_CHOICE);
    storeChoice(dusk, store);
    const [key] = store.data.keys();
    for (const bad of ['{', 'null', '[]', '{"side":"nato","time":3,"map":"moon","mode":"x"}']) {
      store.setItem(key, bad);
      expect(loadChoice(store), bad).toEqual(DEFAULT_CHOICE);
    }
  });

  it('survives storage that throws or is missing', () => {
    const broken: KeyValue = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
    expect(() => storeChoice(dusk, broken)).not.toThrow();
    expect(loadChoice(broken)).toEqual(DEFAULT_CHOICE);
    expect(() => storeChoice(dusk, null)).not.toThrow();
    expect(loadChoice(null)).toEqual(DEFAULT_CHOICE);
  });
});

describe('the role offered after a match (#226)', () => {
  const GO = t('battle.deploy.go');
  const AGAIN = t('battle.report.again');
  const SOLDIER = t('battle.roles.soldier');
  const HELI = t('battle.roles.heli');
  type Session = { mode: string; step: (dt: number) => void; objective: { conquest: { tickets: { veros: number } } } };
  let root: Root | undefined;
  let dom: ReturnType<typeof fakeDom>;
  let renderers: { opts: { session: Session } }[];
  let saved: ReturnType<typeof memoryStorage>;
  let tab: ReturnType<typeof memoryStorage>;

  const text = () => dom.container.textContent;
  const button = (label: string) => buttons(dom.container).find(b => b.textContent.includes(label))!;
  const role = () => [SOLDIER, HELI].filter(label => button(label)?.attrs.class === 'on');
  const lastRole = () => JSON.parse(saved.getItem(SAVE_KEY)!).lastRole;
  const inDeploy = async () => {
    root?.unmount();
    renderers = [];
    dom = fakeDom('#/battle');
    vi.stubGlobal('location', dom.location);
    const { App } = await import('../../App');
    root = createRoot(dom.container as unknown as HTMLElement);
    root.render(createElement(App));
    await vi.waitFor(() => expect(text()).toContain(DEPLOY));
    press(button(DEPLOY));
    await vi.waitFor(() => { expect(renderers).toHaveLength(1); expect(text()).toContain(GO); }, { timeout: 30_000 });
  };
  const playAndAgain = async () => {
    const count = renderers.length;
    const session = renderers.at(-1)!.opts.session;
    press(button(GO));
    await vi.waitFor(() => expect(session.mode).toBe('play'));
    session.objective.conquest.tickets.veros = 0;
    for (let i = 0; i < 2400 && session.mode !== 'done'; i++) session.step(1 / 120);
    await vi.waitFor(() => expect(text()).toContain(AGAIN));
    press(button(AGAIN));
    await vi.waitFor(() => { expect(renderers).toHaveLength(count + 1); expect(text()).toContain(GO); }, { timeout: 30_000 });
  };

  beforeEach(() => {
    vi.resetModules();
    saved = memoryStorage();
    tab = memoryStorage();
    vi.stubGlobal('localStorage', saved);
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('requestAnimationFrame', (frame: () => void) => { setTimeout(frame); });
    vi.doMock('../../assets/loader', () => ({ assets: { get: () => null, loadGroup: async () => ({ loaded: [], failed: [] }) } }));
    vi.doMock('../../audio/game', () => ({ GameAudio: class { voice = { enabled: false }; setVolume() {} async loadSamples() {} async resume() {} dispose() {} } }));
    vi.doMock('../../render/renderer', () => ({
      FlightRenderer: class {
        dispose = vi.fn();
        constructor(public opts: { session: Session }) { renderers.push(this); }
        applySettings() {}
      },
    }));
    vi.doMock('./hud/BattleHud', () => ({ BattleHud: () => null }));
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
    for (const m of ['../../assets/loader', '../../audio/game', '../../render/renderer', './hud/BattleHud']) vi.doUnmock(m);
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('location', undefined);
  });

  it('stays on foot after a match on foot, on play again and on coming back', async () => {
    await inDeploy();
    expect(role()).toEqual([SOLDIER]);
    await playAndAgain();
    expect(role()).toEqual([SOLDIER]);
    expect(lastRole()).toBe('soldier');
    await inDeploy();
    expect(role()).toEqual([SOLDIER]);
  }, 120_000);

  it('stays on the helicopter after a sortie in it, and follows the next sortie on foot', async () => {
    await inDeploy();
    press(button(HELI));
    await vi.waitFor(() => expect(role()).toEqual([HELI]));
    await playAndAgain();
    expect(role()).toEqual([HELI]);
    expect(lastRole()).toBe('heli');
    await inDeploy();
    expect(role()).toEqual([HELI]);
    press(button(SOLDIER));
    await vi.waitFor(() => expect(role()).toEqual([SOLDIER]));
    await playAndAgain();
    expect(role()).toEqual([SOLDIER]);
    expect(lastRole()).toBe('soldier');
  }, 180_000);

  it('does not remember a role that was only looked at', async () => {
    await inDeploy();
    press(button(HELI));
    await vi.waitFor(() => expect(role()).toEqual([HELI]));
    await inDeploy();
    expect(role()).toEqual([SOLDIER]);
  }, 120_000);

  it('offers the VPA on foot even when the last sortie was in the helicopter', async () => {
    storeChoice({ ...DEFAULT_CHOICE, side: 'veros' }, tab);
    saved.setItem(SAVE_KEY, JSON.stringify({ version: 1, settings: {}, tips: [], lastRole: 'heli' }));
    await inDeploy();
    expect(role()).toEqual([SOLDIER]);
  }, 120_000);
});
