import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { assets } from '../../assets/loader';
import { HELI_GROUP } from '../../assets/manifest';
import { t, tList } from '../../content/strings';
import { cardDevice, Coach, deathTip, type CoachFacts } from './coach';
import type { Settings } from '../../save/save';
import { DIFFICULTIES } from '../../sim/difficulty';
import type { FlightSession } from '../../sim/session';
import { Flight } from '../screens/Flight';
import type { BattleChoice } from './BattleSetup';
import { loadBattle } from './loadBattle';
import { BattleHud } from './hud/BattleHud';
import { sideSymbol } from './hud/symbols';
import type { FlightRenderer } from '../../render/renderer';

type BattleModule = Awaited<ReturnType<typeof loadBattle>>;
type Runtime = ReturnType<BattleModule['createBattleSession']>['runtime'];
type KitId = BattleModule['KIT_IDS'][number];
type ClassId = BattleModule['CLASS_IDS'][number];

export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Battle({ choice, touch, settings, onSettings, onSetup, onTitle, tips, onTip }: {
  choice: BattleChoice; touch: boolean; settings: Settings; onSettings: (s: Settings) => void; onSetup: () => void; onTitle: () => void; tips: readonly string[]; onTip: (id: string) => void;
}) {
  const [game, setGame] = useState<{ mod: BattleModule; session: FlightSession; runtime: Runtime } | null>(null);
  const [round, setRound] = useState(0);
  const [renderer, setRenderer] = useState<FlightRenderer | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const mod = await loadBattle();
      const map = await mod.loadMap('harek');
      if (!alive) return;
      const { session, runtime } = mod.createBattleSession(map, 'quick', { side: choice.side, seed: (Date.now() & 0xffff) + round });
      session.world.difficulty = DIFFICULTIES[settings.difficulty];
      session.world.conditions.time = choice.time;
      session.start();
      setGame({ mod, session, runtime });
    })();
    return () => { alive = false; };
  }, [choice, round]);
  if (!game) return <div className="menu"><div className="card"><p className="sub">{t('battle.deploy.loading')}</p></div></div>;
  return (
    <Flight key={round} session={game.session} touch={touch} settings={settings} onSettings={onSettings} onExit={onSetup} onRenderer={setRenderer}>
      <BattleHud session={game.session} runtime={game.runtime} side={choice.side} renderer={renderer} touch={touch} />
      <BattleOverlays game={game} side={choice.side} touch={touch} tips={tips} onTip={onTip} onAgain={() => setRound(r => r + 1)} onSetup={onSetup} onTitle={onTitle} />
    </Flight>
  );
}

const MISSILES = new Set(['sa_ir', 'sam_radar', 'heli_aam', 'jet_aam']);

function squadLabel(label: string) {
  const [, id, n] = label.split(':');
  return n ? t('battle.deploy.spawnSquadN', { id, n }) : t('battle.deploy.spawnSquad', { id });
}

function BattleOverlays({ game, side, touch, tips, onTip, onAgain, onSetup, onTitle }: { game: { mod: BattleModule; session: FlightSession; runtime: Runtime }; side: 'coalition' | 'veros'; touch: boolean; tips: readonly string[]; onTip: (id: string) => void; onAgain: () => void; onSetup: () => void; onTitle: () => void }) {
  const { session, runtime, mod } = game;
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [, tick] = useState(0);
  const tally = useRef({ kills: 0, deaths: 0, identified: 0, flips: 0, detected: 0, missileAt: -99, reason: undefined as string | undefined, missile: false, walked: 0, shots: 0, lastShot: -Infinity, at: null as { x: number; z: number } | null });
  useEffect(() => session.world.events.onAny(e => {
    const T = tally.current, now = session.world.time;
    if (e.t === 'unitDestroyed' && e.byPlayer) T.kills++;
    else if (e.t === 'crash') { T.deaths++; T.reason = e.reason; T.missile = now - T.missileAt < 3; }
    else if (e.t === 'identified') T.identified++;
    else if (e.t === 'pointOwner') T.flips++;
    else if (e.t === 'detected') T.detected++;
    else if (e.t === 'playerHit' && MISSILES.has(e.weapon)) T.missileAt = now;
  }), [session]);
  const tipsRef = useRef(tips);
  tipsRef.current = tips;
  const [coach] = useState(() => new Coach(new Set(tips), undefined, onTip));
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let last = session.world.time;
    const id = setInterval(() => {
      const w = session.world, T = tally.current, body = w.playerBody();
      const dt = Math.max(0, w.time - last);
      last = w.time;
      const foot = body.kind === 'soldier';
      if (foot && body.alive) {
        if (T.at) T.walked += Math.hypot(body.pos.x - T.at.x, body.pos.z - T.at.z);
        T.at = { x: body.pos.x, z: body.pos.z };
      } else T.at = null;
      if (w.soldierLastShot > T.lastShot) { T.lastShot = w.soldierLastShot; T.shots++; }
      const inPoint = foot && runtime.conquest.points.some(p => Math.hypot(body.pos.x - p.x, body.pos.z - p.z) <= p.radius);
      const facts: CoachFacts = { agl: body.agl, tads: w.tads.active, identified: T.identified, flips: T.flips, detected: T.detected, deaths: T.deaths, playing: session.mode === 'play' && body.alive && !session.paused, foot, walked: T.walked, shots: T.shots, inPoint };
      setLine(coach.update(facts, facts.playing ? dt : 0));
    }, 100);
    return () => clearInterval(id);
  }, [session, runtime, coach]);
  useEffect(() => {
    if (snap.mode !== 'deploy') return;
    const id = setInterval(() => tick(n => n + 1), 250);
    return () => clearInterval(id);
  }, [snap.mode]);
  const firstSortie = !tips.includes('card.apache');
  const firstFoot = !tips.includes('card.soldier');
  const heliReady = side === 'coalition';
  const [role, setRole] = useState<'heli' | 'soldier'>(heliReady && !firstFoot ? 'heli' : 'soldier');
  const heliSpawn = firstSortie ? 'baseAir' : 'base';
  useEffect(() => { if (role === 'heli') void assets.loadGroup(HELI_GROUP); }, [role]);
  const home = runtime.conquest.points.find(p => p.owner === side);
  const hasRally = runtime.spawnPoints(session.world).some(p => p.id === 'rally');
  const soldierSpawn = hasRally ? 'rally' : firstFoot && home ? `point:${home.id}` : 'soldierBase';
  const [spawnId, setSpawnId] = useState(role === 'heli' ? heliSpawn : soldierSpawn);
  const [kit, setKit] = useState<KitId>('closeSupport');
  const [cls, setCls] = useState<ClassId>('assault');
  const c = runtime.conquest;
  const all = runtime.spawnPoints(session.world);
  const points = all.filter(p => p.role === role);
  const chosen = points.find(p => p.id === spawnId) ?? points[0];
  const spawnLabel = (p: typeof chosen) => p.role === 'heli' ? t(p.kind === 'pad' ? 'battle.deploy.spawnBase' : 'battle.deploy.spawnBaseAir') : p.label === 'base' ? t('battle.deploy.spawnSoldierBase') : p.label === 'rally' ? t('battle.deploy.spawnRally') : p.label.startsWith('squad:') ? squadLabel(p.label) : t('battle.deploy.spawnPoint', { id: p.label });
  if (snap.mode === 'deploy') {
    const wait = session.deployIn();
    return (
      <div className="overlay deploy">
        <div className="card wide">
          <h1>{t('battle.deploy.title')}</h1>
          <p className="sub">{t('battle.deploy.tickets', { c: Math.floor(c.tickets.coalition), v: Math.floor(c.tickets.veros) })} · {t('battle.deploy.elapsed', { t: clock(c.elapsed), limit: clock(runtime.rules.timeLimitSec) })}</p>
          <p className="sub">{t('battle.deploy.points', { list: c.points.map(p => `${p.id}${p.owner === 'coalition' ? '■' : p.owner === 'veros' ? '▲' : '○'}`).join(' ') })}</p>
          <div className="setting-row"><span>{t('battle.deploy.role')}</span>
            <div className="choice">{(['soldier', 'heli'] as const).map(r => <button key={r} className={r === role ? 'on' : ''} disabled={r === 'heli' && !heliReady} onClick={() => { setRole(r); setSpawnId(r === 'heli' ? heliSpawn : soldierSpawn); }}>{t(r === 'heli' && side === 'veros' ? 'battle.roles.vpaHeli' : `battle.roles.${r}`)}{r === 'heli' && !heliReady && <small>{t('battle.setup.soon')}</small>}</button>)}</div>
          </div>
          <div className="setting-row"><span>{t('battle.deploy.spawn')}</span>
            <div className="choice">{points.map(p => <button key={p.id} className={p === chosen ? 'on' : ''} onClick={() => setSpawnId(p.id)}>{spawnLabel(p)}</button>)}</div>
          </div>
          {role === 'soldier' && (
            <div className="setting-row"><span>{t('battle.deploy.class')}</span>
              <div className="choice">{mod.CLASS_IDS.map(k => <button key={k} className={k === cls ? 'on' : ''} onClick={() => setCls(k)}>{t(`battle.classes.${k}`)}</button>)}</div>
            </div>
          )}
          {role === 'soldier' && <p className="sub">{t(`battle.classDesc.${cls}`)}</p>}
          {role === 'heli' && (
            <div className="setting-row"><span>{t('battle.deploy.kit')}</span>
              <div className="choice">{mod.KIT_IDS.map(k => <button key={k} className={k === kit ? 'on' : ''} onClick={() => setKit(k)}>{t(`battle.kits.${k}`)}</button>)}</div>
            </div>
          )}
          {(role === 'heli' ? firstSortie : firstFoot) && (
            <div className="control-card">
              <b>{t(`battle.card.${role === 'heli' ? 'apache' : 'soldier'}.title`)}</b>
              {tList(`battle.card.${role === 'heli' ? 'apache' : 'soldier'}.${cardDevice(touch, typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [])}`).map(l => <span key={l}>{l}</span>)}
            </div>
          )}
          {tally.current.deaths > 0 && <p className="sub tip">{t(deathTip(tally.current.reason, tally.current.missile))}</p>}
          {tally.current.deaths > 0 && !tips.includes('rules.dead') && <p className="sub tip">{t('battle.tips.dead')}</p>}
          <div className="pause-buttons">
            <button className="go secondary" onClick={onSetup}>{t('battle.deploy.quit')}</button>
            <button className="go" disabled={wait > 0} onClick={() => { if (chosen && session.deploy(runtime.spawnFor(chosen, mod.KITS[kit], cls))) { if (role === 'heli' ? firstSortie : firstFoot) onTip(role === 'heli' ? 'card.apache' : 'card.soldier'); if (tally.current.deaths > 0 && !tips.includes('rules.dead')) onTip('rules.dead'); } }}>
              {wait > 0 ? t('battle.deploy.wait', { s: Math.ceil(wait) }) : `${t('battle.deploy.go')} ▶`}
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (snap.mode === 'done') {
    const r = runtime.result;
    const outcome = r.winner > 0 ? 'win' : r.winner < 0 ? 'loss' : 'draw';
    const own = side === 'coalition' ? r.coalition : r.veros, enemy = side === 'coalition' ? r.veros : r.coalition;
    return (
      <div className="overlay report">
        <div className="card">
          <h1>{t(`battle.report.${outcome}`)}</h1>
          <p className="sub">{r.byTime ? t('battle.report.time') : t(r.winner > 0 ? 'battle.report.ticketsWon' : 'battle.report.ticketsLost')}</p>
          <p className="sub">{t('battle.report.score', { own, enemy })} · {t('battle.report.length', { t: clock(r.seconds) })}</p>
          <p className="sub">{t('battle.report.kills', { n: tally.current.kills })} · {t('battle.report.deaths', { n: tally.current.deaths })}</p>
          <div className="pause-buttons">
            <button className="go" onClick={onAgain}>{t('battle.report.again')}</button>
            <button className="go secondary" onClick={onSetup}>{t('battle.report.setup')}</button>
            <button className="go secondary" onClick={onTitle}>{t('battle.report.title')}</button>
          </div>
        </div>
      </div>
    );
  }
  return line && (snap.mode === 'play') ? <div className="coach">{t(`battle.coach.${line}`, { own: sideSymbol(side), enemy: sideSymbol(side === 'coalition' ? 'veros' : 'coalition') })}</div> : null;
}
