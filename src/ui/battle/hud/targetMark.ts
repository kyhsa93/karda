import { MARK_OVERLAP_MIN_PX, MARK_ROW_PX, pointMarkBox, type Box } from '../coach';

export const MARK_CENTER_DIM = 0.35;
export const MARK_TARGET_DIM = 0.65;
export const CENTER_BOX_PX = 64;
export const PILL_PAD = { x: 6, y: 2 } as const;
export const PILL_TIGHT_PX = 1;
export const PILL_RADIUS = 6;
export const PILL_FILL = 'rgba(6, 12, 22, .85)';
export const TARGET_ROWS = [-1, -2, 1] as const;
export const BUTTON_TEXT = '.sticks .tbtn, .sticks .stick span';

export type TargetStep = 1 | 2 | 3 | 4;
export interface TargetPlan { step: TargetStep; x: number; y: number; rows: number; pill: Box | null }

export function overlapArea(a: Box, b: Box) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

export function grow(b: Box, x: number, y: number): Box {
  return { left: b.left - x, right: b.right + x, top: b.top - y, bottom: b.bottom + y };
}

const touches = (b: Box, list: readonly Box[]) => list.some(o => overlapArea(b, o) > 0);

export function centerBox(w: number, h: number): Box {
  const half = CENTER_BOX_PX / 2;
  return { left: w / 2 - half, right: w / 2 + half, top: h / 2 - half, bottom: h / 2 + half };
}

export function centerDim(mark: Box, w: number, h: number, target: boolean) {
  const c = centerBox(w, h);
  const hit = Math.min(mark.right, c.right) - Math.max(mark.left, c.left) >= MARK_OVERLAP_MIN_PX && Math.min(mark.bottom, c.bottom) - Math.max(mark.top, c.top) >= MARK_OVERLAP_MIN_PX;
  return hit ? (target ? MARK_TARGET_DIM : MARK_CENTER_DIM) : 1;
}

export function planTargetMark(x: number, y: number, textWidth: number, texts: readonly Box[], marks: readonly Box[], h: number): TargetPlan {
  const pillAt = (cy: number) => {
    const m = pointMarkBox(x, cy, textWidth);
    const wide = grow(m, PILL_PAD.x, PILL_PAD.y);
    if (!touches(wide, texts)) return { step: 1 as const, pill: wide };
    const tight = grow(m, PILL_TIGHT_PX, PILL_TIGHT_PX);
    if (!touches(tight, texts)) return { step: 2 as const, pill: tight };
    return null;
  };
  const here = touches(pointMarkBox(x, y, textWidth), marks) ? null : pillAt(y);
  if (here) return { step: here.step, x, y, rows: 0, pill: here.pill };
  let last = 0;
  for (const rows of TARGET_ROWS) {
    const cy = y + rows * MARK_ROW_PX, m = pointMarkBox(x, cy, textWidth);
    if (m.top < 0 || m.bottom > h) continue;
    last = rows;
    if (touches(m, marks)) continue;
    const p = pillAt(cy);
    if (p) return { step: 3, x, y: cy, rows, pill: p.pill };
  }
  return { step: 4, x, y: y + last * MARK_ROW_PX, rows: last, pill: null };
}

interface TextDoc { querySelectorAll?(sel: string): ArrayLike<{ childNodes?: ArrayLike<{ nodeType: number; textContent: string | null }> }>; createRange?(): { selectNodeContents(n: unknown): void; getClientRects(): ArrayLike<Box> } }

export function buttonTextBoxes(doc: TextDoc | null | undefined): Box[] {
  const found = doc?.querySelectorAll?.(BUTTON_TEXT);
  if (!found || !doc?.createRange) return [];
  const boxes: Box[] = [];
  for (const el of Array.from(found)) for (const n of Array.from(el.childNodes ?? [])) {
    if (n.nodeType !== 3 || !n.textContent?.trim()) continue;
    const r = doc.createRange();
    r.selectNodeContents(n);
    for (const q of Array.from(r.getClientRects())) if (q.right > q.left && q.bottom > q.top) boxes.push(grow(q, 1, 1));
  }
  return boxes;
}
