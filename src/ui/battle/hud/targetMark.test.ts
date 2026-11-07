import { describe, expect, it } from 'vitest';
import { MARK_ROW_PX, pointMarkBox, type Box } from '../coach';
import { buttonTextBoxes, CENTER_BOX_PX, centerDim, grow, MARK_CENTER_DIM, MARK_TARGET_DIM, overlapArea, PILL_PAD, PILL_TIGHT_PX, planTargetMark, TARGET_ROWS } from './targetMark';

const X = 300, Y = 200, TW = 60, H = 390;
const mark = (y = Y) => pointMarkBox(X, y, TW);
const at = (y: number, l = X - 10, r = X + 10): Box => ({ left: l, right: r, top: y - 4, bottom: y + 4 });

describe('target mark step (#340)', () => {
  it('keeps the wide pill when nothing touches it (step 1)', () => {
    const plan = planTargetMark(X, Y, TW, [at(Y + 40)], [], H);
    expect(plan).toEqual({ step: 1, x: X, y: Y, rows: 0, pill: grow(mark(), PILL_PAD.x, PILL_PAD.y) });
  });

  it('shrinks the pill when only its padding reaches a button text (step 2)', () => {
    const text: Box = { left: mark().right + 3, right: mark().right + 30, top: Y - 4, bottom: Y + 4 };
    expect(overlapArea(grow(mark(), PILL_PAD.x, PILL_PAD.y), text)).toBeGreaterThan(0);
    const plan = planTargetMark(X, Y, TW, [text], [], H);
    expect(plan).toEqual({ step: 2, x: X, y: Y, rows: 0, pill: grow(mark(), PILL_TIGHT_PX, PILL_TIGHT_PX) });
  });

  it('lifts the mark one row when its text sits on a button text (step 3)', () => {
    const plan = planTargetMark(X, Y, TW, [at(Y)], [], H);
    expect(plan.step).toBe(3);
    expect(plan.rows).toBe(-1);
    expect(plan.y).toBe(Y - MARK_ROW_PX);
    expect(plan.x).toBe(X);
    expect(plan.pill).toEqual(grow(mark(Y - MARK_ROW_PX), PILL_PAD.x, PILL_PAD.y));
  });

  it('shrinks the pill again in the lifted row when the wide one still reaches the text', () => {
    const plan = planTargetMark(X, Y, TW, [{ left: X - 10, right: X + 10, top: Y - 9, bottom: Y + 4 }], [], H);
    expect(plan).toMatchObject({ step: 3, rows: -1, x: X, pill: grow(mark(Y - MARK_ROW_PX), PILL_TIGHT_PX, PILL_TIGHT_PX) });
  });

  it('lifts two rows when the first row is on a button text too', () => {
    const plan = planTargetMark(X, Y, TW, [at(Y), at(Y - MARK_ROW_PX)], [], H);
    expect(plan).toMatchObject({ step: 3, rows: -2, x: X, y: Y - 2 * MARK_ROW_PX });
  });

  it('drops one row when both rows above are taken', () => {
    const plan = planTargetMark(X, Y, TW, [at(Y), at(Y - MARK_ROW_PX), at(Y - 2 * MARK_ROW_PX)], [], H);
    expect(plan).toMatchObject({ step: 3, rows: 1, x: X, y: Y + MARK_ROW_PX });
  });

  it('gives up without a pill when every row is taken (step 4)', () => {
    const texts = [at(Y), ...TARGET_ROWS.map(r => at(Y + r * MARK_ROW_PX))];
    const plan = planTargetMark(X, Y, TW, texts, [], H);
    expect(plan).toEqual({ step: 4, x: X, y: Y + MARK_ROW_PX, rows: 1, pill: null });
  });

  it('skips a row held by another point mark and takes the next one', () => {
    const plan = planTargetMark(X, Y, TW, [at(Y)], [pointMarkBox(X + 20, Y - MARK_ROW_PX, 50)], H);
    expect(plan).toMatchObject({ step: 3, rows: -2, x: X });
  });

  it('gives up when the free rows hold other point marks (step 4)', () => {
    const others = TARGET_ROWS.map(r => pointMarkBox(X, Y + r * MARK_ROW_PX, 40));
    const plan = planTargetMark(X, Y, TW, [at(Y)], others, H);
    expect(plan).toMatchObject({ step: 4, x: X, pill: null });
  });

  it('lifts the mark one row when it only overlaps another front mark', () => {
    const other = pointMarkBox(X + 30, Y + 4, 60);
    const plan = planTargetMark(X, Y, TW, [], [other], H);
    expect(plan).toEqual({ step: 3, x: X, y: Y - MARK_ROW_PX, rows: -1, pill: grow(mark(Y - MARK_ROW_PX), PILL_PAD.x, PILL_PAD.y) });
    expect(overlapArea(mark(plan.y), other)).toBe(0);
  });

  it('gives up when it overlaps another front mark and every row above and below is held', () => {
    const others = [pointMarkBox(X + 30, Y + 4, 60), ...TARGET_ROWS.map(r => pointMarkBox(X - 20, Y + r * MARK_ROW_PX, 40))];
    const plan = planTargetMark(X, Y, TW, [], others, H);
    expect(plan).toMatchObject({ step: 4, x: X, pill: null });
  });

  it('never leaves the screen', () => {
    expect(planTargetMark(X, 20, TW, [at(20)], [], H)).toMatchObject({ step: 3, rows: 1, y: 20 + MARK_ROW_PX });
    expect(planTargetMark(X, H - 10, TW, [at(H - 10), at(H - 28), at(H - 46)], [], H)).toMatchObject({ step: 4, rows: -2, y: H - 46, pill: null });
  });

  it('never changes x, whatever the step', () => {
    const cases: [Box[], Box[]][] = [[[], []], [[at(Y)], []], [[at(Y), at(Y - 18)], []], [[at(Y), at(Y - 18), at(Y - 36)], []], [[at(Y), at(Y - 18), at(Y - 36), at(Y + 18)], []], [[], [pointMarkBox(X, Y, 40)]]];
    for (const [texts, others] of cases) for (const x of [60, X, 780]) expect(planTargetMark(x, Y, TW, texts, others, H).x).toBe(x);
  });
});

describe('center dimming (#340)', () => {
  const W = 844, CH = 390, cx = W / 2, cy = CH / 2, half = CENTER_BOX_PX / 2;
  it('dims a mark crossing the center box by at least 5px each way, the target less', () => {
    const box = pointMarkBox(cx, cy, 60);
    expect(centerDim(box, W, CH, false)).toBe(MARK_CENTER_DIM);
    expect(centerDim(box, W, CH, true)).toBe(MARK_TARGET_DIM);
    expect(MARK_TARGET_DIM).toBeGreaterThan(MARK_CENTER_DIM);
  });

  it('leaves a mark that only grazes the center box', () => {
    expect(centerDim({ left: cx + half - 4, right: cx + half + 60, top: cy - 8, bottom: cy + 8 }, W, CH, false)).toBe(1);
    expect(centerDim({ left: cx + half - 5, right: cx + half + 60, top: cy - 8, bottom: cy + 8 }, W, CH, false)).toBe(MARK_CENTER_DIM);
    expect(centerDim({ left: cx - 30, right: cx + 30, top: cy + half - 4, bottom: cy + half + 12 }, W, CH, true)).toBe(1);
    expect(centerDim(pointMarkBox(100, 100, 60), W, CH, true)).toBe(1);
  });
});

describe('button text boxes (#340)', () => {
  it('reads every text node of buttons and stick labels with a 1px margin, and nothing without a document', () => {
    const rects = new Map<unknown, Box[]>();
    const text = (t: string, r: Box[]) => { const n = { nodeType: 3, textContent: t }; rects.set(n, r); return n; };
    let asked = '';
    const doc = {
      querySelectorAll: (sel: string) => { asked = sel; return [{ childNodes: [text('발사', [{ left: 10, right: 30, top: 5, bottom: 20 }])] }, { childNodes: [{ nodeType: 1, textContent: 'x' }, text(' ', [{ left: 0, right: 5, top: 0, bottom: 5 }])] }, { childNodes: [text('왼쪽', [{ left: 50, right: 70, top: 5, bottom: 20 }, { left: 50, right: 50, top: 5, bottom: 20 }])] }]; },
      createRange: () => { let node: unknown; return { selectNodeContents: (n: unknown) => { node = n; }, getClientRects: () => rects.get(node) ?? [] }; },
    };
    expect(buttonTextBoxes(doc)).toEqual([{ left: 9, right: 31, top: 4, bottom: 21 }, { left: 49, right: 71, top: 4, bottom: 21 }]);
    expect(asked).toBe('.sticks .tbtn, .sticks .stick span');
    expect(buttonTextBoxes(null)).toEqual([]);
    expect(buttonTextBoxes({ querySelectorAll: doc.querySelectorAll })).toEqual([]);
  });
});
