import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ProxyPilot } from '../src/sim/battle/proxy';
import { SoldierProxy, type ProxyStance } from '../src/sim/battle/soldierProxy';
import { createBattleSession } from '../src/sim/battle/runtime';
import type { BattleMapDef, BattleSide } from '../src/sim/battle/schema';
import { STEP } from '../src/sim/world';

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const mapId = arg('map', 'harek');
const mode = arg('mode', 'quick') as 'quick' | 'conquest';
const side = arg('side', 'coalition') as BattleSide;
const player = arg('player', 'idle') as 'idle' | 'proxy' | 'soldier';
const stance = arg('stance', 'cover') as ProxyStance;
const seeds = Number(arg('seeds', '20'));
const first = Number(arg('seed', '1'));
const aimError = Number(arg('aim-error', '0'));
const trace = process.argv.includes('--trace');
const json = process.argv.includes('--json');
const overrides = process.argv.flatMap((a, i) => (a === '--set' ? [process.argv[i + 1]] : []));
const def = JSON.parse(readFileSync(`src/content/battle/maps/${mapId}.json`, 'utf8')) as BattleMapDef;

interface Run { starts: Record<string, string>; fell: string[]; seed: number; minutes: number; winner: string; tickets: string; flips: Record<string, number>; kills: number; proxyKills: number; proxyDeaths: number; life: number; inside: number; firstEntry: number | null; stalled: number; firstContact: number | null; endFlips: number; ms: number }

function play(seed: number): Run {
  const { session, runtime } = createBattleSession(def, mode, { side, seed });
  for (const kv of overrides) {
    const [path, v] = kv.split('=');
    const keys = path.split('.');
    let at = runtime.rules as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      if (typeof at[k] !== 'object' || at[k] === null) throw new Error(`--set ${path}: no rule group ${k}`);
      at = at[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (typeof at[last] !== 'number') throw new Error(`--set ${path}: no numeric rule ${last}`);
    at[last] = Number(v);
  }
  session.start();
  session.frozen = false;
  const world = session.world;
  const flips: Record<string, number> = Object.fromEntries(runtime.conquest.points.map(p => [p.id, 0]));
  const starts = Object.fromEntries(runtime.conquest.points.filter(p => p.owner !== 'neutral').map(p => [p.owner, p.id]));
  const fell = new Set<string>();
  let kills = 0;
  const flipTimes: number[] = [];
  world.events.on('pointOwner', e => { flips[e.id]++; flipTimes.push(runtime.conquest.elapsed); if (e.from !== 'neutral' && starts[e.from] === e.id) fell.add(e.from); });
  world.events.on('unitDestroyed', () => { kills++; });
  const proxy = player === 'proxy' ? new ProxyPilot(runtime, side) : null;
  if (proxy) proxy.aimErrorMrad = aimError;
  const soldier = player === 'soldier' ? new SoldierProxy(runtime, side, stance) : null;
  const t0 = performance.now();
  let steps = 0;
  let inside = 0, firstEntry: number | null = null, stalled = 0, firstContact: number | null = null;
  let last: { x: number; z: number } | null = null;
  const limit = (runtime.rules.timeLimitSec + 30) * 120;
  while (session.mode !== 'done' && steps < limit) {
    proxy?.step(session, STEP);
    soldier?.step(session, STEP);
    session.step(STEP);
    steps++;
    const me = soldier ? world.soldier : null;
    if (me && me.alive) {
      const inEnemy = runtime.conquest.points.some(p => p.owner !== side && Math.hypot(me.pos.x - p.x, me.pos.z - p.z) <= p.radius);
      if (inEnemy) { inside += STEP; firstEntry ??= runtime.conquest.elapsed; }
      if (world.soldierCommands.fire) firstContact ??= runtime.conquest.elapsed;
      if (steps % 120 === 0) {
        const inAny = runtime.conquest.points.some(p => Math.hypot(me.pos.x - p.x, me.pos.z - p.z) <= p.radius);
        if (last && !inAny && Math.hypot(me.pos.x - last.x, me.pos.z - last.z) < 1) stalled += 1;
        last = { x: me.pos.x, z: me.pos.z };
      }
    } else if (steps % 120 === 0) last = null;
    if (trace && steps % (120 * 60) === 0) {
      const c = runtime.conquest;
      const alive = (s: BattleSide) => world.units.filter(u => u.alive && u.side === s && u.def.move).length;
      const orders = runtime.commanders.map(cmd => cmd.platoons.map(pl => `${pl.order?.kind[0] ?? '-'}${pl.order?.point ?? ''}:${pl.state[0]}`).join(' ')).join(' | ');
      const targeting = world.units.filter(u => u.alive && u.battle?.target?.kind === 'unit').length;
      const pts = c.points.map(p => `${p.id}:${p.strength.coalition.toFixed(1)}/${p.strength.veros.toFixed(1)}`).join(' ');
      console.log(`   engaged ${targeting}  strength ${pts}`);
      console.log(`${(steps / 7200).toFixed(0).padStart(2)}m  tickets ${c.tickets.coalition.toFixed(0)}:${c.tickets.veros.toFixed(0)}  points ${c.points.map(p => `${p.id}${p.owner[0]}${p.v.toFixed(0)}`).join(' ')}  alive ${alive('coalition')}:${alive('veros')}  kills ${kills}  ${orders}`);
    }
  }
  const c = runtime.conquest;
  return {
    starts, fell: [...fell], seed, minutes: c.elapsed / 60, winner: c.winner ?? 'none', tickets: `${Math.floor(c.tickets.coalition)}:${Math.floor(c.tickets.veros)}`,
    flips, kills, proxyKills: proxy?.kills ?? soldier?.kills ?? 0, proxyDeaths: proxy?.deaths ?? soldier?.deaths ?? 0, life: soldier ? soldier.aliveTime / Math.max(1, soldier.deaths) : 0, inside, firstEntry, stalled, firstContact, endFlips: flipTimes.filter(t => t >= c.elapsed - 180).length, ms: (performance.now() - t0) / Math.max(1, steps / 2),
  };
}

const runs: Run[] = [];
for (let s = first; s < first + seeds; s++) {
  const r = play(s);
  runs.push(r);
  if (json) { console.log(`RUN ${JSON.stringify({ ...r, side, player })}`); continue; }
  console.log(`seed ${String(r.seed).padStart(3)}  ${r.minutes.toFixed(1).padStart(5)} min  ${r.winner.padEnd(9)}  tickets ${r.tickets.padEnd(8)}  flips ${Object.entries(r.flips).map(([k, v]) => `${k}${v}`).join(' ')}  kills ${r.kills}${player !== 'idle' ? `  proxy ${r.proxyKills}/${r.proxyDeaths}` : ''}${player === 'soldier' ? `  life ${r.life.toFixed(0)}s  inside ${r.inside.toFixed(0)}s  entry ${r.firstEntry === null ? '-' : `${r.firstEntry.toFixed(0)}s`}  stalled ${r.stalled}s` : ''}`);
}
if (json) process.exit(0);
const sorted = runs.map(r => r.minutes).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const wins = runs.filter(r => r.winner === side).length;
const draws = runs.filter(r => r.winner === 'draw').length;
const everyFlip = runs.filter(r => Object.values(r.flips).every(v => v >= 1)).length;
const middle = runs.filter(r => Object.entries(r.flips).some(([id, v]) => !Object.values(r.starts).includes(id) && v >= 1)).length;
const decided = runs.filter(r => r.winner === 'coalition' || r.winner === 'veros');
const loserFell = decided.filter(r => r.fell.includes(r.winner === 'coalition' ? 'veros' : 'coalition')).length;
console.log('');
console.log(`| ${mapId} ${mode} · ${side} · ${player}${player === 'soldier' ? ` (${stance})` : ''} · ${runs.length} seeds | value |`);
console.log('| --- | --- |');
console.log(`| median length | ${median.toFixed(1)} min (min ${sorted[0].toFixed(1)}, max ${sorted[sorted.length - 1].toFixed(1)}) |`);
console.log(`| ${side} wins | ${wins}/${runs.length} (${((wins / runs.length) * 100).toFixed(0)}%), draws ${draws} |`);
console.log(`| seeds where every point changed owner | ${everyFlip}/${runs.length} (${((everyFlip / runs.length) * 100).toFixed(0)}%) |`);
console.log(`| seeds where a middle point changed owner | ${middle}/${runs.length} (${((middle / runs.length) * 100).toFixed(0)}%) |`);
console.log(`| decided seeds where the loser's start point fell | ${loserFell}/${decided.length} (${((loserFell / Math.max(1, decided.length)) * 100).toFixed(0)}%) |`);
console.log(`| mean kills | ${(runs.reduce((a, r) => a + r.kills, 0) / runs.length).toFixed(0)} |`);
if (player === 'soldier') {
  console.log(`| proxy seconds alive per death | ${(runs.reduce((a, r) => a + r.life, 0) / runs.length).toFixed(0)} |`);
  const entered = runs.filter(r => r.firstEntry !== null).map(r => r.firstEntry!).sort((a, b) => a - b);
  console.log(`| proxy seconds inside a point it does not hold | ${(runs.reduce((a, r) => a + r.inside, 0) / runs.length).toFixed(0)} |`);
  console.log(`| seeds where the proxy entered such a point (firstEntrySec median) | ${entered.length}/${runs.length}${entered.length ? ` (${entered[Math.floor(entered.length / 2)].toFixed(0)} s)` : ''} |`);
  console.log(`| proxy seconds stalled outside any point | ${(runs.reduce((a, r) => a + r.stalled, 0) / runs.length).toFixed(0)} |`);
}
if (player !== 'idle') console.log(`| proxy kills / deaths | ${(runs.reduce((a, r) => a + r.proxyKills, 0) / runs.length).toFixed(1)} / ${(runs.reduce((a, r) => a + r.proxyDeaths, 0) / runs.length).toFixed(1)} |`);
console.log(`| sim ms per 60 fps frame | ${(runs.reduce((a, r) => a + r.ms, 0) / runs.length).toFixed(3)} |`);
