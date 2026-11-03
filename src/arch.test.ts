import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const all = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const simTests = import.meta.glob('./sim/**/*.test.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const inDir = (dir: string) => Object.entries(all).filter(([f]) => f.startsWith(`./${dir}/`));

const SIM_FORBIDDEN: [RegExp, string][] = [
  [/from ['"](\.\.\/)+(render|ui|audio|input)\//, 'imports render/ui/audio/input'],
  [/from ['"]react/, 'imports react'],
  [/\bdocument\./, 'touches document'],
  [/\bwindow\./, 'touches window'],
  [/\blocalStorage\b/, 'touches localStorage'],
];

const SIM_TEST_CLOCK_EXCEPTIONS: Record<string, string[]> = {
  './sim/terrain.test.ts': ['performance.now'],
};

type AstNode = { type: string; start: number; name?: string; computed?: boolean; [key: string]: unknown };

const ANY_REFERENCE = new Set(['Date', 'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame', 'requestIdleCallback', 'globalThis', 'self']);
const BANNED_MEMBER: Record<string, string> = { Math: 'random', performance: 'now' };
const TYPE_DECLARATIONS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'ImportDeclaration']);
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'implements']);
const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);

const isNode = (v: unknown): v is AstNode => typeof (v as AstNode | null)?.type === 'string';
const unwrap = (n: AstNode): AstNode => (WRAPPERS.has(n.type) ? unwrap(n.expression as AstNode) : n);

function nondeterminism(code: string) {
  const found: { what: string; line: number }[] = [];
  const report = (what: string, n: AstNode) => found.push({ what, line: code.slice(0, n.start).split('\n').length });
  const visit = (n: AstNode): void => {
    if (TYPE_DECLARATIONS.has(n.type)) return;
    if (n.type === 'Identifier') {
      if (ANY_REFERENCE.has(n.name!)) report(n.name!, n);
      else if (n.name === 'Math') report('Math.random', n);
      return;
    }
    if (n.type === 'MemberExpression') {
      const object = unwrap(n.object as AstNode);
      const banned = object.type === 'Identifier' ? BANNED_MEMBER[object.name!] : undefined;
      if (banned) {
        if (n.computed || (n.property as AstNode).name === banned) report(`${object.name}.${banned}`, n);
        return;
      }
    }
    const assigned = n.type === 'VariableDeclarator' ? n.init : n.type === 'AssignmentExpression' ? n.right : null;
    if (isNode(assigned) && unwrap(assigned).name === 'performance') report('performance.now', assigned);
    for (const [key, value] of Object.entries(n)) {
      if (TYPE_KEYS.has(key) || (!n.computed && (key === 'key' || key === 'property'))) continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child);
    }
  };
  visit(parseAst(code, { lang: 'ts' }) as unknown as AstNode);
  return found;
}

function resolve(from: string, spec: string) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const THREE_MATH = new Set(['Vector3', 'Vector2', 'Quaternion', 'Euler', 'Matrix4', 'MathUtils']);

describe('architecture rules (08-technical-architecture.md 8.3)', () => {
  const sim = inDir('sim');

  it('finds the simulation sources', () => {
    expect(sim.length).toBeGreaterThan(8);
  });

  it('keeps the simulation free of rendering, DOM and React', () => {
    for (const [file, code] of sim) {
      for (const [re, why] of SIM_FORBIDDEN) {
        expect(re.test(code), `${file} ${why}`).toBe(false);
      }
    }
  });

  it('keeps wall clocks, timers and Math.random out of the simulation', () => {
    const uses = sim.flatMap(([file, code]) => nondeterminism(code).map(u => `${file}:${u.line} uses ${u.what}`));
    expect(uses).toEqual([]);
  });

  it('names every simulation test that reads a clock', () => {
    const uses = Object.entries(simTests)
      .map(([file, code]) => [file, [...new Set(nondeterminism(code).map(u => u.what))]] as const)
      .filter(([, what]) => what.length > 0);
    expect(Object.fromEntries(uses)).toEqual(SIM_TEST_CLOCK_EXCEPTIONS);
  });

  it.each([
    ['const r = Math.random;', 'Math.random'],
    ['Math.random();', 'Math.random'],
    ['Math?.random();', 'Math.random'],
    ["Math['random']();", 'Math.random'],
    ['const { random } = Math;', 'Math.random'],
    ['const M = Math;', 'Math.random'],
    ['(Math as any).random();', 'Math.random'],
    ['Date.now();', 'Date'],
    ['new Date();', 'Date'],
    ['const { now } = Date;', 'Date'],
    ['performance.now();', 'performance.now'],
    ['performance?.now();', 'performance.now'],
    ["performance['now']();", 'performance.now'],
    ['(performance as any).now();', 'performance.now'],
    ['const { now } = performance;', 'performance.now'],
    ['const p = performance;', 'performance.now'],
    ['setTimeout(f, 1);', 'setTimeout'],
    ['const t = setTimeout;', 'setTimeout'],
    ['setInterval(f, 1);', 'setInterval'],
    ['requestAnimationFrame(f);', 'requestAnimationFrame'],
    ['globalThis.setTimeout(f, 1);', 'globalThis'],
    ['self.Date.now();', 'self'],
    ['const s = `${Date.now()}`;', 'Date'],
    ['function f(t = Date.now()) { return t; }', 'Date'],
    ['class C { t = setTimeout; }', 'setTimeout'],
  ])('flags %s', (code, what) => {
    expect(nondeterminism(code).map(u => u.what)).toContain(what);
  });

  it.each([
    ['// Date.now() performance.now() setTimeout requestAnimationFrame Math.random()'],
    ['/* Date.now() performance.now() setTimeout requestAnimationFrame Math.random() */'],
    ["const s = 'Date.now() performance.now() setTimeout requestAnimationFrame Math.random()';"],
    ['const s = `Date.now() performance.now() setTimeout requestAnimationFrame Math.random()`;'],
    ['const r = /Date\\.now|performance\\.now|setTimeout|requestAnimationFrame|Math\\.random/;'],
    ['Math.floor(1.5);'],
    ['rng.random();'],
    ['myDate.now();'],
    ['clock.setTimeout(1);'],
    ['x.Date.now();'],
    ['const o = { Date: 1, setTimeout: 2, performance: 3 };'],
    ['interface I { performance: number; Date: string }'],
    ['const d: Date = x;'],
    ['const now = 1; f(now);'],
    ['const performance = aircraft.performance; f(performance.maxSpeed);'],
  ])('does not flag %s', code => {
    expect(nondeterminism(code)).toEqual([]);
  });

  it('reports the line of the offending code past non-ASCII text', () => {
    expect(nondeterminism("const a = '한글';\n\nDate.now();")).toEqual([{ what: 'Date', line: 3 }]);
  });

  it('lets the simulation use only math types from three', () => {
    for (const [file, code] of sim) {
      for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]three['"]/g)) {
        for (const name of m[2].split(',').map(s => s.trim().replace(/^type\s+/, '')).filter(Boolean)) {
          expect(THREE_MATH.has(name), `${file} imports ${name} from three`).toBe(true);
        }
      }
      expect(/import\s+\*\s+as\s+\w+\s+from\s+['"]three['"]/.test(code), `${file} imports all of three`).toBe(false);
    }
  });

  it('keeps Node built-ins out of browser code', () => {
    for (const [file, code] of Object.entries(all)) {
      expect(/from ['"]node:/.test(code), `${file} imports a Node built-in`).toBe(false);
    }
  });

  it('keeps core free of every other layer', () => {
    for (const [file, code] of inDir('core')) {
      expect(/from ['"]\.\.\/(sim|render|ui|audio|input|content)\//.test(code), `${file} depends on another layer`).toBe(false);
    }
  });

  it('keeps the world loop from importing the battle code (wiki 9.1)', () => {
    const world = all['./sim/world.ts'];
    expect(world).toBeDefined();
    expect(/from ['"]\.\/battle(\/|['"])/.test(world), 'sim/world.ts imports ./battle').toBe(false);
  });

  it('loads the battle code only as a lazy chunk (wiki 9.10)', () => {
    const offenders: string[] = [];
    for (const [file, code] of Object.entries(all)) {
      if (file.startsWith('./sim/battle/')) continue;
      for (const m of code.matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"](\.[^'"]+)['"]/gm)) {
        if (!m[1] && resolve(file, m[2]).startsWith('./sim/battle')) offenders.push(`${file} -> ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(resolve('./ui/battle/loadBattle.ts', '../../sim/battle')).toBe('./sim/battle');
  });

  it('keeps render from writing simulation state', () => {
    for (const [file, code] of inDir('render')) {
      const writes = [...code.matchAll(/\b(world|session|sim)\.(\w+)(\.\w+)*\s*(\+|-|\*)?=(?!=)/g)].map(m => m[0]);
      expect(writes, `${file} writes sim state`).toEqual([]);
    }
  });
});
