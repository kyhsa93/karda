import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { diffInterval, monotoneVerdict, P0, pairedInterval, pairs, roleVerdict, seedsToVerdict, spreadVerdict, wilson, type Rate } from './lib/influence';

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const map = arg('map', 'harek');
const mode = arg('mode', 'quick');
const sides = arg('sides', 'coalition,veros').split(',');
const seeds = Number(arg('seeds', '100'));
const jobs = Number(arg('jobs', String(Math.max(1, availableParallelism() - 1))));
const roles = arg('roles', 'idle,soldier,proxy').split(',');
const check = process.argv.includes('--check');
const paired = process.argv.includes('--paired');
const levels = arg('level', '') === '' ? [] : arg('level', '').split(',').map(Number);
if (levels.some(l => !Number.isInteger(l) || l < 0 || l > 3)) throw new Error('--level: expected a list of 0..3');
const STEP_SEEDS = 10;

interface Cell { role: string; level: number | null; label: string }
const cells: Cell[] = roles.flatMap((role): Cell[] => (role === 'soldier' && levels.length ? levels.map(level => ({ role, level, label: `soldier L${level}` })) : [{ role, level: null, label: role }]));
const aimError = arg('aim-error', '0');
const sets = process.argv.flatMap((a, i) => (a === '--set' ? ['--set', process.argv[i + 1]] : []));

interface Run { seed: number; side: string; player: string; label: string; winner: string; inside: number; firstEntry: number | null; firstContact: number | null; endFlips: number; proxyKills: number; proxyDeaths: number }

function chunk(side: string, cell: Cell, from: number, count: number): Promise<Run[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', './scripts/lib/ts.mjs', 'scripts/battle-harness.ts',
      '--map', map, '--mode', mode, '--side', side, '--player', cell.role, ...(cell.level === null ? [] : ['--level', String(cell.level)]), '--seed', String(from), '--seeds', String(count), '--json', '--aim-error', aimError, ...sets], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`${side} ${cell.label} seeds ${from}+${count} exited ${code}`));
      resolve(out.split('\n').filter(l => l.startsWith('RUN ')).map(l => ({ ...(JSON.parse(l.slice(4)) as Run), label: cell.label })));
    });
  });
}

const tasks: (() => Promise<Run[]>)[] = [];
const per = Math.ceil(seeds / Math.max(1, Math.ceil((jobs * 2) / (sides.length * cells.length))));
for (const side of sides) for (const cell of cells) for (let s = 1; s <= seeds; s += per) tasks.push(() => chunk(side, cell, s, Math.min(per, seeds - s + 1)));

const runs: Run[] = [];
let next = 0, done = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < tasks.length) {
    const task = tasks[next++];
    runs.push(...await task());
    process.stderr.write(`\r${++done}/${tasks.length} chunks, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}));
process.stderr.write('\n');

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const rate = (side: string, label: string): Rate => {
  const r = runs.filter(x => x.side === side && x.label === label);
  return { wins: r.filter(x => x.winner === side).length, n: r.length };
};
const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

const wonBy = (side: string, label: string, upTo: number) => new Map(runs.filter(x => x.side === side && x.label === label && x.seed <= upTo).map(x => [x.seed, x.winner === side]));
const rateAt = (side: string, label: string, upTo: number): Rate => { const m = wonBy(side, label, upTo); return { wins: [...m.values()].filter(Boolean).length, n: m.size }; };

console.log(`\n## ${map} ${mode} · ${seeds} seeds a cell${levels.length ? ` · levels ${levels.map(l => `L${l}`).join(' ')}` : ''}${paired ? ' · paired by seed' : ''} · P0 band: role − idle ≥ ${P0.margin * 100}pp, role < ${P0.ceiling * 100}%, roles within ${P0.spread * 100}pp (95% intervals)\n`);
console.log(`| side | role | wins | 95% interval | − idle | verdict | entered a point | firstEntrySec | firstContactSec | flips in last 3 min | kills / deaths |${paired ? ' seeds to verdict: independent / paired |' : ''}`);
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |${paired ? ' --- |' : ''}`);
let failed = false;
for (const side of sides) {
  const idle = rate(side, 'idle');
  const hasIdle = idle.n > 0;
  const judged: Rate[] = [];
  const soldierLevels: Rate[] = [];
  for (const cell of cells) {
    const { role, label } = cell;
    const r = rate(side, label), rs = runs.filter(x => x.side === side && x.label === label);
    const [lo, hi] = wilson(r);
    let verdict = '—', cost = '';
    if (role !== 'idle') {
      if (!hasIdle) verdict = 'no idle row to judge against';
      else {
        const diff = paired ? pairedInterval(pairs(wonBy(side, label, seeds), wonBy(side, 'idle', seeds))) : undefined;
        const v = roleVerdict(r, idle, diff);
        verdict = `**${v.verdict}** — ${v.reason}`;
        judged.push(r);
        if (cell.level !== null) soldierLevels.push(r);
        if (v.verdict === 'fail') failed = true;
        if (paired) {
          const need = (usePaired: boolean) => seedsToVerdict(seeds, STEP_SEEDS, k => roleVerdict(rateAt(side, label, k), rateAt(side, 'idle', k), usePaired ? pairedInterval(pairs(wonBy(side, label, k), wonBy(side, 'idle', k))) : undefined).verdict);
          const a = need(false), b = need(true);
          const half = ([x, y]: [number, number]) => `undecided (±${(((y - x) / 2) * 100).toFixed(0)}pp)`;
          cost = `${a ?? half(diffInterval(r, idle))} / ${b ?? half(pairedInterval(pairs(wonBy(side, label, seeds), wonBy(side, 'idle', seeds))))}`;
        }
      }
    }
    const entered = rs.filter(x => x.firstEntry !== null);
    console.log(`| ${side} | ${label} | ${r.wins}/${r.n} (${pct(r.wins / r.n)}) | ${pct(lo)}–${pct(hi)} | ${role === 'idle' || !hasIdle ? '' : `${((r.wins / r.n - idle.wins / idle.n) * 100).toFixed(0)}pp`} | ${verdict} | ${role === 'soldier' ? `${entered.length}/${rs.length}` : ''} | ${role === 'soldier' ? median(entered.map(x => x.firstEntry!)).toFixed(0) : ''} | ${role === 'soldier' ? median(rs.filter(x => x.firstContact !== null).map(x => x.firstContact!)).toFixed(0) : ''} | ${(rs.reduce((a, x) => a + x.endFlips, 0) / rs.length).toFixed(2)} | ${role === 'idle' ? '' : `${(rs.reduce((a, x) => a + x.proxyKills, 0) / rs.length).toFixed(1)} / ${(rs.reduce((a, x) => a + x.proxyDeaths, 0) / rs.length).toFixed(1)}`} |${paired ? ` ${cost} |` : ''}`);
  }
  const s = spreadVerdict(judged);
  console.log(`| ${side} | (spread) | | | | **${s.verdict}** — ${s.reason} | | | | | |${paired ? ' |' : ''}`);
  if (s.verdict === 'fail') failed = true;
  if (soldierLevels.length > 1) {
    const m = monotoneVerdict(soldierLevels);
    console.log(`| ${side} | (levels monotone) | | | | **${m.verdict}** — ${m.reason} | | | | | |${paired ? ' |' : ''}`);
    if (m.verdict === 'fail') failed = true;
  }
}
console.log(`\n${runs.length} matches in ${((Date.now() - t0) / 1000).toFixed(0)} s on ${jobs} processes.`);
if (check && failed) process.exit(1);
