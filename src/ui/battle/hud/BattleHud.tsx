import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { t } from '../../../content/strings';
import { Flags } from '../../../render/battle/flags';
import { BattleProps, type BattlePropKind } from '../../../render/battle/props';
import { assets } from '../../../assets/loader';
import { FARP_GROUP } from '../../../assets/manifest';
import type { FlightRenderer } from '../../../render/renderer';
import type { SimEvent } from '../../../sim/events';
import type { FlightSession } from '../../../sim/session';
import type { Unit } from '../../../sim/units';
import { shadeTerrain } from './minimap';
import { COLORS, pointColor, pointSymbol, sideSymbol } from './symbols';
import { INFANTRY_WEAPONS } from '../../../sim/infantry/arms';

type Side = 'coalition' | 'veros';

interface Point { id: string; x: number; z: number; owner: 'coalition' | 'veros' | 'neutral'; v: number; contested: boolean }
interface Runtime {
  conquest: { points: Point[]; tickets: Record<Side, number>; elapsed: number };
  rules: { timeLimitSec: number };
  spotting: { markers(world: FlightSession['world']): Unit[] };
  map: { bases: { side: Side; position: [number, number] }[]; points: { id: string; props: { kind: string }[] }[] };
}

export const FEED_LINES = 4;
export const FEED_SECONDS = 6;
export const FEED_RANGE = 1500;
export const RADIO_SECONDS = 4;
export const TICKET_WARN = [100, 50, 20];
export const MINIMAP = { desktop: 180, touch: 110 } as const;
export const MINIMAP_RANGE = 1500;
export const MINIMAP_RANGE_FOOT = 150;
export const HIT_MARK = 0.3;
export const HURT_MARK = 1.5;
export const ALLY_RANGE = 3000;
export const ALLY_INFANTRY_RANGE = 200;

export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function unitName(u: { defId: string; side: string }) {
  return `${sideSymbol(u.side)} ${t(`units.${u.defId}`)}`;
}

export const OVERVIEW_BACK = 400;

export function BattleHud({ session, runtime, side, renderer, touch }: { session: FlightSession; runtime: Runtime; side: Side; renderer: FlightRenderer | null; touch: boolean }) {
  const world = session.world;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setTick] = useState(0);
  const feed = useRef<{ text: string; mine: boolean; until: number }[]>([]);
  const radio = useRef<{ text: string; until: number } | null>(null);
  const warned = useRef(new Set<number>());
  const hitMark = useRef({ until: -1, kill: false });
  const hurt = useRef<{ x: number; z: number; until: number }[]>([]);

  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => world.events.onAny((e: SimEvent) => {
    const now = world.time;
    if (e.t === 'memberHit' && e.byPlayer) hitMark.current = { until: now + HIT_MARK, kill: e.killed || hitMark.current.kill && hitMark.current.until > now };
    if (e.t === 'unitDestroyed' && e.byPlayer) hitMark.current = { until: now + HIT_MARK, kill: true };
    if (e.t === 'playerHit' && world.avatar.kind === 'soldier') { const u = world.unit(e.by); if (u) hurt.current = [...hurt.current.filter(h => h.until > now), { x: u.pos.x, z: u.pos.z, until: now + HURT_MARK }].slice(-6); }
    if (e.t === 'unitDestroyed') {
      const victim = world.unit(e.id);
      const h = world.playerBody().pos;
      const near = victim && Math.hypot(victim.pos.x - h.x, victim.pos.z - h.z) <= FEED_RANGE;
      if (!e.byPlayer && !near) return;
      const killer = e.byPlayer ? t('battle.hud.you') : e.by !== undefined && world.unit(e.by) ? unitName(world.unit(e.by)!) : '?';
      feed.current = [...feed.current, { text: `${killer} → ${unitName(e)}`, mine: e.byPlayer, until: now + FEED_SECONDS }].slice(-FEED_LINES);
    } else if (e.t === 'pointOwner') {
      const key = e.owner === side ? 'captured' : e.from === side ? 'lost' : e.owner === 'neutral' ? 'neutral' : 'enemy';
      radio.current = { text: t(`battle.hud.point.${key}`, { id: e.id }), until: now + RADIO_SECONDS };
    }
  }), [world, side]);

  const flagsRef = useRef<Flags | null>(null);
  useEffect(() => {
    if (!renderer) return;
    const ground = (x: number, z: number) => world.terrain.surfaceAt(x, z);
    const flags = new Flags(runtime.conquest.points, ground);
    renderer.scene.scene.add(flags.group);
    flagsRef.current = flags;
    const ids = new Set(runtime.conquest.points.map(p => p.id));
    const kinds = runtime.map.points.filter(p => ids.has(p.id)).flatMap(p => p.props.map(pr => pr.kind as BattlePropKind));
    const props = new BattleProps(world.obstacles.map((box, i) => ({ kind: kinds[i] ?? 'wall', box })));
    renderer.scene.scene.add(props.group);
    let alive = true;
    void assets.loadGroup(FARP_GROUP).then(report => {
      if (!alive) return;
      const models: Record<string, THREE.Object3D> = {};
      for (const id of report.loaded) { const g = assets.get<{ scene: THREE.Object3D }>(id); if (g) models[id.replace('model.prop_', '')] = g.scene; }
      props.setModels(models);
    });
    const pts = runtime.conquest.points;
    const home = pts.find(p => p.owner === side) ?? pts[0];
    const mid = pts.find(p => p.owner === 'neutral') ?? pts[Math.floor(pts.length / 2)];
    const dx = home.x - mid.x, dz = home.z - mid.z, d = Math.hypot(dx, dz) || 1;
    const bx = home.x + (dx / d) * OVERVIEW_BACK, bz = home.z + (dz / d) * OVERVIEW_BACK;
    renderer.overview = { from: new THREE.Vector3(bx, 0, bz), look: new THREE.Vector3(mid.x, ground(mid.x, mid.z) + 20, mid.z) };
    return () => { alive = false; flags.dispose(); props.dispose(); flagsRef.current = null; renderer.overview = null; };
  }, [renderer, runtime, world, side]);

  const shade = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const v = new THREE.Vector3();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current;
      if (!c) return;
      const w = c.clientWidth, h = c.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      flagsRef.current?.update(runtime.conquest.points, (x, z) => world.terrain.surfaceAt(x, z), Math.atan2(world.wind.x, world.wind.z));
      if (session.mode !== 'play') return;
      const cam = renderer?.camera;
      const me = world.playerBody().pos;
      g.font = '600 13px "Karda Sans", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const label = (text: string, x: number, y: number, color: string) => {
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(text, x, y); g.fillStyle = color; g.fillText(text, x, y);
      };
      if (cam) {
        cam.updateMatrixWorld();
        const project = (x: number, y: number, z: number) => {
          v.set(x, y, z).project(cam);
          return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, front: v.z < 1 };
        };
        for (const p of runtime.conquest.points) {
          const s = project(p.x, world.terrain.surfaceAt(p.x, p.z) + 16, p.z);
          const edge = 48;
          let x = s.x, y = s.y;
          if (!s.front && touch) continue;
          if (!s.front) { x = w - x; y = h - edge; }
          x = Math.min(w - edge, Math.max(edge, x)); y = Math.min(h - edge, Math.max(edge, y));
          const minimapRight = (touch ? 0 : MINIMAP.desktop + 16) + 50;
          if (y > h - (touch ? 0 : MINIMAP.desktop + 16) && x < minimapRight) x = minimapRight;
          const d = Math.hypot(p.x - me.x, p.z - me.z);
          label(`${pointSymbol(p.owner, p.contested)} ${p.id} ${d >= 1000 ? `${(d / 1000).toFixed(1)}km` : `${Math.round(d)}m`}`, x, y, pointColor(p.owner, side));
        }
        for (const u of world.units) {
          if (!u.alive || u.side !== side || !u.def.move) continue;
          const d = Math.hypot(u.pos.x - me.x, u.pos.z - me.z);
          if (d > (u.def.category === 'infantry' ? ALLY_INFANTRY_RANGE : ALLY_RANGE)) continue;
          const s = project(u.pos.x, u.pos.y + u.def.size[1] + 3, u.pos.z);
          if (s.front && s.x > 0 && s.x < w && s.y > 0 && s.y < h) label('▼', s.x, s.y, COLORS.friend);
        }
        for (const u of runtime.spotting.markers(world)) {
          const s = project(u.pos.x, u.pos.y + u.def.size[1] + 4, u.pos.z);
          if (s.front && s.x > 0 && s.x < w && s.y > 0 && s.y < h) label('◆', s.x, s.y, COLORS.enemy);
        }
      }
      shade.current ??= shadeTerrain(world.terrain);
      const size = touch ? MINIMAP.touch : MINIMAP.desktop;
      const mx = touch ? 72 : 16, my = touch ? 12 : h - size - 16;
      const cx = mx + size / 2, cy = my + size / 2, r = size / 2;
      const scale = r / (world.avatar.kind === 'soldier' ? MINIMAP_RANGE_FOOT : MINIMAP_RANGE);
      const yaw = world.avatar.kind === 'soldier' && world.soldier ? world.soldier.yaw : world.player.yaw;
      g.save();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
      g.fillStyle = 'rgba(6,12,22,.8)'; g.fillRect(mx, my, size, size);
      g.translate(cx, cy);
      g.rotate(yaw);
      const cell = world.terrain.size / shade.current.width;
      g.globalAlpha = 0.9;
      g.drawImage(shade.current, (-world.terrain.half - me.x) * scale, (-world.terrain.half - me.z) * scale, world.terrain.size * scale, world.terrain.size * scale);
      g.globalAlpha = 1;
      void cell;
      const dot = (x: number, z: number, text: string, color: string) => {
        const px = (x - me.x) * scale, pz = (z - me.z) * scale;
        g.save(); g.translate(px, pz); g.rotate(-yaw); label(text, 0, 0, color); g.restore();
      };
      for (const b of runtime.map.bases) dot(b.position[0], b.position[1], sideSymbol(b.side), b.side === side ? COLORS.friend : COLORS.enemy);
      for (const p of runtime.conquest.points) dot(p.x, p.z, `${pointSymbol(p.owner, p.contested)}${p.id}`, pointColor(p.owner, side));
      g.font = '600 12px "Karda Sans", sans-serif';
      for (const u of world.units) if (u.alive && u.side === side && u.def.move) dot(u.pos.x, u.pos.z, '•', COLORS.friend);
      for (const u of runtime.spotting.markers(world)) dot(u.pos.x, u.pos.z, '◆', COLORS.enemy);
      g.restore();
      const s = world.avatar.kind === 'soldier' ? world.soldier : null;
      if (s && cam) {
        const cx0 = w / 2, cy0 = h / 2, arms = world.soldierArms, wd = INFANTRY_WEAPONS[arms.selected];
        const spread = ((world.soldierCommands.ads ? wd.spreadAdsDeg : wd.spreadHipDeg) * arms.bloom * Math.PI) / 180;
        const gap = Math.max(3, (Math.tan(spread) / Math.tan(((cam as THREE.PerspectiveCamera).fov * Math.PI) / 360)) * (h / 2));
        g.strokeStyle = 'rgba(232,238,247,.9)'; g.lineWidth = 2;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.beginPath(); g.moveTo(cx0 + dx * gap, cy0 + dy * gap); g.lineTo(cx0 + dx * (gap + 9), cy0 + dy * (gap + 9)); g.stroke(); }
        if (hitMark.current.until > world.time) {
          g.strokeStyle = hitMark.current.kill ? '#ff4d4d' : '#ffffff'; g.lineWidth = hitMark.current.kill ? 4 : 2;
          for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { g.beginPath(); g.moveTo(cx0 + dx * 6, cy0 + dy * 6); g.lineTo(cx0 + dx * 14, cy0 + dy * 14); g.stroke(); }
        }
        for (const hh of hurt.current) {
          if (hh.until <= world.time) continue;
          const bearing = Math.atan2(-(hh.x - s.pos.x), -(hh.z - s.pos.z)) - s.yaw;
          g.strokeStyle = `rgba(239,71,111,${Math.min(1, (hh.until - world.time) / HURT_MARK) * 0.9})`; g.lineWidth = 6;
          g.beginPath(); g.arc(cx0, cy0, Math.min(w, h) * 0.22, -Math.PI / 2 - bearing - 0.3, -Math.PI / 2 - bearing + 0.3); g.stroke();
        }
      }
      g.strokeStyle = 'rgba(232,238,247,.6)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      g.fillStyle = COLORS.text;
      g.beginPath(); g.moveTo(cx, cy - 6); g.lineTo(cx - 4, cy + 4); g.lineTo(cx + 4, cy + 4); g.closePath(); g.fill();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [renderer, runtime, session, world, side, touch]);

  const c = runtime.conquest;
  const own = c.tickets[side], enemy = c.tickets[side === 'coalition' ? 'veros' : 'coalition'];
  for (const n of TICKET_WARN) {
    if (own <= n && !warned.current.has(n)) { warned.current.add(n); radio.current = { text: t('battle.hud.tickets', { n }), until: world.time + RADIO_SECONDS }; }
  }
  const now = world.time;
  const lines = feed.current.filter(f => f.until > now);
  const total = Math.max(1, own + enemy);
  if (session.mode !== 'play' && session.mode !== 'crashed') return <canvas ref={canvasRef} className="battle-canvas" />;
  return (
    <>
      <canvas ref={canvasRef} className="battle-canvas" />
      <div className={touch ? 'battle-hud touch' : 'battle-hud'}>
        <div className="tickets">
          <div className="ticket-row">
            <b className="friend">{sideSymbol(side)} {Math.floor(own)}</b>
            <span className="bar"><i className="friend" style={{ width: `${(own / total) * 100}%` }} /><i className="enemy" style={{ width: `${(enemy / total) * 100}%` }} /></span>
            <b className="enemy">{Math.floor(enemy)} {sideSymbol(side === 'coalition' ? 'veros' : 'coalition')}</b>
            <span className="clock">{clock(c.elapsed)} / {clock(runtime.rules.timeLimitSec)}</span>
          </div>
          <div className="point-row">
            {c.points.map(p => <span key={p.id} style={{ color: pointColor(p.owner, side) }}>{p.id}{pointSymbol(p.owner, p.contested)}</span>)}
          </div>
        </div>
        <div className="killfeed">{lines.map((l, i) => <div key={i} className={l.mine ? 'mine' : ''}>{l.text}</div>)}</div>
        {radio.current && radio.current.until > now && <div className="battle-radio">{radio.current.text}</div>}
        {world.avatar.kind === 'soldier' && world.soldier && (() => {
          const s = world.soldier, a = world.soldierArms, m = a.ammo[a.selected]!, g = a.ammo.grenade ?? a.ammo.at_rocket, gear = world.soldierGear;
          const medkit = gear.medkit ? t('battle.hud.medkitActive', { n: Math.ceil(gear.medkit.until - world.time) }) : world.time < gear.readyAt ? t('battle.hud.medkitWait', { n: Math.ceil(gear.readyAt - world.time) }) : t('battle.hud.medkitReady');
          return (
            <div className="soldier-status">
              <b className={s.hp < 35 ? 'low' : ''}>{t('battle.hud.hp', { n: Math.ceil(s.hp) })}</b>
              <span>{t(`battle.hud.weapon.${a.selected}`)} {a.reloading > 0 ? t('battle.hud.reloading') : `${m.mag} / ${m.reserve}`}</span>
              {g && a.selected !== 'grenade' && a.selected !== 'at_rocket' && <span>{t(`battle.hud.weapon.${a.ammo.grenade ? 'grenade' : 'at_rocket'}`)} {g.mag + g.reserve}</span>}
              {gear.medkitLeft > 0 && <span>{t('battle.hud.medkit', { state: medkit })}</span>}
              {gear.repairable && <span>{t('battle.hud.repair', { state: gear.overheatUntil > world.time ? t('battle.hud.repairHot', { n: Math.ceil(gear.overheatUntil - world.time) }) : gear.repairing ? t('battle.hud.repairing') : t('battle.hud.medkitReady') })}</span>}
              {(gear.mineLeft > 0 || gear.mines.length > 0) && <span>{t('battle.hud.mine', { n: gear.mineLeft })}</span>}
              {gear.smokeLeft > 0 && <span>{t('battle.hud.smoke', { n: gear.smokeLeft })}</span>}
              <span>{t(`battle.hud.stance.${s.stance}`)}</span>
            </div>
          );
        })()}
      </div>
    </>
  );
}
