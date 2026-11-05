import { pointSymbol, type Owner } from './symbols';

export const FULL = 100;
export const RING_RADIUS = 11;
export const RING_WIDTH = 3;
export const RING_BACKING = 5;
export const CHANGE_HOLD = 1.5;
export const RING_LABEL_GAP = '   ';

export interface MarkPoint { id: string; x: number; z: number; radius: number; v: number; contested: boolean }
export interface CaptureMark { id: string; owner: Owner; symbol: string; progress: number; percent: number; contested: boolean }

export class CaptureMarks {
  private seen = new Map<string, { v: number; until: number }>();

  update(points: readonly MarkPoint[] | undefined, now: number) {
    for (const p of points ?? []) {
      if (!Number.isFinite(p?.v)) continue;
      const was = this.seen.get(p.id);
      this.seen.set(p.id, { v: p.v, until: was && was.v !== p.v ? now + CHANGE_HOLD : was?.until ?? -Infinity });
    }
  }

  of(p: MarkPoint | undefined, now: number): CaptureMark | null {
    if (!p || !Number.isFinite(p.v)) return null;
    if (!p.contested && !(now < (this.seen.get(p.id)?.until ?? -Infinity))) return null;
    const owner: Owner = p.v > 0 ? 'coalition' : p.v < 0 ? 'veros' : 'neutral';
    const size = Math.min(FULL, Math.abs(p.v));
    return { id: p.id, owner, symbol: pointSymbol(owner, !!p.contested), progress: size / FULL, percent: size >= FULL ? FULL : Math.min(FULL - 1, Math.round(size)), contested: !!p.contested };
  }

  inside(points: readonly MarkPoint[] | undefined, x: number, z: number, now: number) {
    return this.of(points?.find(p => p && Math.hypot(p.x - x, p.z - z) <= p.radius), now);
  }
}

export function markText(m: CaptureMark) {
  return `${m.contested ? `× ${pointSymbol(m.owner, false)}` : m.symbol} ${m.id} ${m.percent}%`;
}

export function markTextY(w: number, h: number) {
  return h / 2 - Math.min(w, h) * 0.22 - 18;
}

type RingContext = Pick<CanvasRenderingContext2D, 'strokeStyle' | 'lineWidth' | 'beginPath' | 'arc' | 'stroke'>;

export function drawRing(g: RingContext, x: number, y: number, m: CaptureMark, color: string) {
  g.strokeStyle = '#000'; g.lineWidth = RING_BACKING;
  g.beginPath(); g.arc(x, y, RING_RADIUS, 0, Math.PI * 2); g.stroke();
  if (m.progress <= 0) return;
  g.strokeStyle = color; g.lineWidth = RING_WIDTH;
  g.beginPath(); g.arc(x, y, RING_RADIUS, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * m.progress); g.stroke();
}
