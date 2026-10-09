import type { Vector3 } from 'three';
import { smokeBlocks, type SmokeCloud } from './infantry/gear';
import { segmentBlocked, type Obstacle } from './obstacles';
import type { Terrain, Tree } from './terrain';

export const LOS_STEP = 20;
export const TREE_OCCLUSION = 0.4;
export const CANOPY_BASE = 0.3;
export const LOS_CACHE_MOVE = 5;
export const LOS_CACHE_SECONDS = 0.5;

export interface Sight { clear: boolean; occlusion: number }

export function terrainClear(t: Terrain, a: Vector3, b: Vector3, step = LOS_STEP) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 1; i < n; i++) {
    const k = i / n;
    const x = a.x + dx * k, z = a.z + dz * k;
    if (t.surfaceAt(x, z) > a.y + dy * k) return false;
  }
  return true;
}

export function canopyHit(tree: Tree, a: Vector3, b: Vector3) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  let k = len2 > 1e-9 ? ((tree.x - a.x) * dx + (tree.z - a.z) * dz) / len2 : 0;
  k = Math.max(0, Math.min(1, k));
  const px = a.x + dx * k, pz = a.z + dz * k;
  if (Math.hypot(px - tree.x, pz - tree.z) > tree.r) return false;
  const y = a.y + (b.y - a.y) * k;
  return y >= tree.y + tree.h * CANOPY_BASE && y <= tree.y + tree.h;
}

export function treesAlong(t: Terrain, a: Vector3, b: Vector3): Tree[] {
  const seen = new Set<Tree>();
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / 50));
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    for (const tr of t.treesNear(a.x + (b.x - a.x) * k, a.z + (b.z - a.z) * k)) seen.add(tr);
  }
  return [...seen];
}

export function treeOcclusion(trees: readonly Tree[], a: Vector3, b: Vector3) {
  let hits = 0;
  for (const tr of trees) if (canopyHit(tr, a, b) && ++hits >= 2) return 1;
  return hits * TREE_OCCLUSION;
}

export function visualSight(t: Terrain, a: Vector3, b: Vector3): Sight {
  if (!terrainClear(t, a, b)) return { clear: false, occlusion: 1 };
  const occlusion = treeOcclusion(treesAlong(t, a, b), a, b);
  return { clear: occlusion < 1, occlusion };
}

export function radarSight(t: Terrain, a: Vector3, b: Vector3) {
  return terrainClear(t, a, b);
}

interface Entry { sight: Sight; radar: boolean; ox: number; oz: number; oy: number; tx: number; ty: number; tz: number; time: number }

export const LOS_PAIR_BASE = 1_000_000;
export const LOS_PRUNE_SECONDS = 2;
export const LOS_PRUNE_EVERY = 10;

export function pairKey(observer: number, target: number) {
  return (observer + 1) * LOS_PAIR_BASE + target;
}

export function obstacleBlocks(obstacles: readonly Obstacle[], a: Vector3, b: Vector3) {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
  for (const o of obstacles) {
    const r = Math.max(o.w, o.d);
    if (o.x + r < minX || o.x - r > maxX || o.z + r < minZ || o.z - r > maxZ) continue;
    if (segmentBlocked(o, a, b)) return true;
  }
  return false;
}

export class LosCache {
  private entries = new Map<number, Entry>();
  computed = 0;
  obstacles: readonly Obstacle[] = [];
  smokes: readonly SmokeCloud[] = [];

  constructor(private terrain: Terrain) {}

  private entry(key: number, observer: Vector3, target: Vector3, time: number) {
    const e = this.entries.get(key);
    const moved = (x: number, y: number, z: number, p: Vector3) => Math.hypot(p.x - x, p.y - y, p.z - z) >= LOS_CACHE_MOVE;
    if (e && time - e.time < LOS_CACHE_SECONDS && !moved(e.tx, e.ty, e.tz, target) && !moved(e.ox, e.oy, e.oz, observer)) return e;
    this.computed++;
    const blocked = this.obstacles.length > 0 && obstacleBlocks(this.obstacles, observer, target);
    const fresh: Entry = {
      sight: blocked || (this.smokes.length > 0 && smokeBlocks(this.smokes, observer, target)) ? { clear: false, occlusion: 1 } : visualSight(this.terrain, observer, target), radar: !blocked && radarSight(this.terrain, observer, target),
      ox: observer.x, oy: observer.y, oz: observer.z, tx: target.x, ty: target.y, tz: target.z, time,
    };
    this.entries.set(key, fresh);
    return fresh;
  }

  visual(key: number, observer: Vector3, target: Vector3, time: number) {
    return this.entry(key, observer, target, time).sight;
  }

  radar(key: number, observer: Vector3, target: Vector3, time: number) {
    return this.entry(key, observer, target, time).radar;
  }

  prune(time: number, maxAge = LOS_PRUNE_SECONDS) {
    for (const [k, e] of this.entries) if (time - e.time > maxAge) this.entries.delete(k);
  }

  get size() { return this.entries.size; }

  clear() { this.entries.clear(); }
}
