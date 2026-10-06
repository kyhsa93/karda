import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { P0, roleVerdict, spreadVerdict, wilson, type Rate } from './lib/influence';

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
const aimError = arg('aim-error', '0');
const sets = process.argv.flatMap((a, i) => (a === '--set' ? ['--set', process.argv[i + 1]] : []));

interface Run { seed: number; side: string; player: string; winner: string; inside: number; firstEntry: number | null; firstContact: number | null; endFlips: number; proxyKills: number; proxyDeaths: number }

function chunk(side: string, role: string, from: number, count: number): Promise<Run[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', './scripts/lib/ts.mjs', 'scripts/battle-harness.ts',
      '--map', map, '--mode', mode, '--side', side, '--player', role, '--seed', String(from), '--seeds', String(count), '--json', '--aim-error', aimError, ...sets], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`${side} ${role} seeds ${from}+${count} exited ${code}`));
      resolve(out.split('\n').filter(l => l.startsWith('RUN ')).map(l => JSON.parse(l.slice(4)) as Run));
    });
  });
}

const tasks: (() => Promise<Run[]>)[] = [];
const per = Math.ceil(seeds / Math.max(1, Math.ceil((jobs * 2) / (sides.length * roles.length))));
for (const side of sides) for (const role of roles) for (let s = 1; s <= seeds; s += per) tasks.push(() => chunk(side, role, s, Math.min(per, seeds - s + 1)));

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
const rate = (side: string, role: string): Rate => {
  const r = runs.filter(x => x.side === side && x.player === role);
  return { wins: r.filter(x => x.winner === side).length, n: r.length };
};
const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

console.log(`\n## ${map} ${mode} · ${seeds} seeds a cell · P0 band: role − idle ≥ ${P0.margin * 100}pp, role < ${P0.ceiling * 100}%, roles within ${P0.spread * 100}pp (95% intervals)\n`);
console.log('| side | role | wins | 95% interval | − idle | verdict | entered a point | firstEntrySec | firstContactSec | flips in last 3 min | kills / deaths |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
let failed = false;
for (const side of sides) {
  const idle = rate(side, 'idle');
  const hasIdle = idle.n > 0;
  const judged: Rate[] = [];
  for (const role of roles) {
    const r = rate(side, role), rs = runs.filter(x => x.side === side && x.player === role);
    const [lo, hi] = wilson(r);
    let verdict = '—';
    if (role !== 'idle') {
      if (!hasIdle) verdict = 'no idle row to judge against';
      else { const v = roleVerdict(r, idle); verdict = `**${v.verdict}** — ${v.reason}`; judged.push(r); if (v.verdict === 'fail') failed = true; }
    }
    const entered = rs.filter(x => x.firstEntry !== null);
    console.log(`| ${side} | ${role} | ${r.wins}/${r.n} (${pct(r.wins / r.n)}) | ${pct(lo)}–${pct(hi)} | ${role === 'idle' || !hasIdle ? '' : `${((r.wins / r.n - idle.wins / idle.n) * 100).toFixed(0)}pp`} | ${verdict} | ${role === 'soldier' ? `${entered.length}/${rs.length}` : ''} | ${role === 'soldier' ? median(entered.map(x => x.firstEntry!)).toFixed(0) : ''} | ${role === 'soldier' ? median(rs.filter(x => x.firstContact !== null).map(x => x.firstContact!)).toFixed(0) : ''} | ${(rs.reduce((a, x) => a + x.endFlips, 0) / rs.length).toFixed(2)} | ${role === 'idle' ? '' : `${(rs.reduce((a, x) => a + x.proxyKills, 0) / rs.length).toFixed(1)} / ${(rs.reduce((a, x) => a + x.proxyDeaths, 0) / rs.length).toFixed(1)}`} |`);
  }
  const s = spreadVerdict(judged);
  console.log(`| ${side} | (spread) | | | | **${s.verdict}** — ${s.reason} | | | | | |`);
  if (s.verdict === 'fail') failed = true;
}
console.log(`\n${runs.length} matches in ${((Date.now() - t0) / 1000).toFixed(0)} s on ${jobs} processes.`);
if (check && failed) process.exit(1);
