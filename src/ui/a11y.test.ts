import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_FONT } from '../render/ihadss';

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
const setup = readFileSync(join(__dirname, 'battle', 'BattleSetup.tsx'), 'utf8');

describe('accessibility (07, M7-5)', () => {
  it('keeps every CSS font size at 12px or more', () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(20);
    expect(sizes.filter(s => s < 12)).toEqual([]);
  });

  it('never shrinks helmet symbology below 12px on a small screen', () => {
    expect(MIN_FONT).toBeGreaterThanOrEqual(12);
  });

  it('widens the deploy card on short screens so the kit row stays on one line above the button bar', () => {
    const short = css.slice(css.indexOf('@media (max-height: 480px)'));
    expect(short.slice(0, short.indexOf('\n}'))).toMatch(/\.overlay\.deploy \.card\.wide \{ max-width: 780px; \}/);
  });

  it('pins the battle setup button bar with the deploy rule and tightens the same rows on short screens', () => {
    const short = css.slice(css.indexOf('@media (max-height: 480px)'));
    const rules = short.slice(0, short.indexOf('\n}'));
    expect(rules).toMatch(/\.battle-setup \.pause-buttons \{ position: sticky; bottom: 0;/);
    expect(rules).toMatch(/\.overlay\.deploy, \.menu\.setup \{ padding-block: 6px; \}/);
    expect(rules).toMatch(/\.overlay\.deploy h1, \.battle-setup h1 \{ font-size: 22px; margin: 0; \}/);
    expect(rules).toMatch(/\.overlay\.deploy \.sub, \.battle-setup \.sub \{ margin: 2px 0; font-size: 13px; \}/);
    expect(rules).toMatch(/\.overlay\.deploy \.setting-row, \.battle-setup \.setting-row \{ padding: 3px 0; \}/);
    expect(setup).toMatch(/className="menu setup"/);
  });

  it('gives touch buttons at least 48px on touch screens, keeps the FARP menu at 44px and leaves fine pointers alone', () => {
    expect(css).toMatch(/\.tbtn \{ min-width: 48px; min-height: 48px; \}/);
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    const rules = coarse.slice(0, coarse.indexOf('\n}'));
    expect(rules).toMatch(/\.choice button, \.setting-row \.choice button, button\.go \{ min-height: 48px; min-width: 48px; \}\n  \.farp-menu button \{ min-height: 44px; min-width: 44px; \}/);
    const fine = css.replace(rules, '');
    expect(fine).toMatch(/\.setting-row \.choice button \{ padding: 6px 10px; min-height: 36px; \}/);
    expect(fine).not.toMatch(/button\.go \{[^}]*min-height/);
  });

  it('gives back the height of the 48px setup and deploy buttons in row padding on short touch screens only', () => {
    const start = css.indexOf('@media (max-height: 480px) and (pointer: coarse)');
    expect(start).toBeGreaterThan(css.indexOf('.overlay.deploy .setting-row, .battle-setup .setting-row { padding: 3px 0; }'));
    expect(css.slice(start, css.indexOf('\n}', start))).toMatch(/\.overlay\.deploy \.setting-row, \.battle-setup \.setting-row \{ padding: 1px 0; \}/);
  });
});
