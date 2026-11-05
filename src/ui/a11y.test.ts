import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_FONT } from '../render/ihadss';

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

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

  it('gives touch buttons and campaign nodes at least 44px on touch screens', () => {
    expect(css).toMatch(/\.tbtn \{ min-width: 48px; min-height: 48px; \}/);
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).toMatch(/\.campaign-map \.node \{ width: 44px; height: 44px; \}/);
    expect(coarse).toMatch(/min-height: 44px/);
    expect(css).toMatch(/\.radio-menu button \{ min-height: 44px; \}/);
  });
});
