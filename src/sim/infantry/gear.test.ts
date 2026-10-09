import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../events';
import { DIFFICULTIES } from '../difficulty';
import { ofSide } from '../testing';
import { STEP, World } from '../world';
import { CLASS_KITS, createArms } from './arms';
import { createGear, MEDKIT, SMOKE } from './gear';
import { SOLDIER_HP } from './soldier';

function scene(cls: 'assault' | 'engineer' = 'assault') {
  const world = new World({ seed: 11, terrain: { features: [{ kind: 'flatten', center: [0, 0], radius: 700 }], pads: [{ x: -1500, z: -1500, name: 'H' }] } });
  world.active = true;
  world.playerSide = 'coalition';
  world.difficulty = DIFFICULTIES.normal;
  world.spawnAvatar({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls });
  return world;
}

const run = (w: World, seconds: number) => { for (let i = 0; i < Math.round(seconds / STEP); i++) w.step(STEP); };

describe('assault gear (wiki 12.4): medkit and smoke', () => {
  it('gives only the assault class the medkit and two smoke grenades within its gear slots', () => {
    expect(CLASS_KITS.assault.tools).toEqual(['medkit', 'smoke']);
    expect(CLASS_KITS.assault.gear.length + CLASS_KITS.assault.tools.length).toBeLessThanOrEqual(CLASS_KITS.assault.gearSlots);
    expect(createGear('assault')).toMatchObject({ medkitLeft: 1, smokeLeft: 2 });
    expect(createGear('engineer')).toMatchObject({ medkitLeft: 0, smokeLeft: 0 });
    expect(Object.keys(createArms('assault').ammo)).toEqual(['rifle', 'grenade']);
  });

  it('heals the player 10 HP/s inside 5 m, not outside, and expires after 60 s with a 30 s redeploy wait', () => {
    const w = scene();
    const s = w.soldier!;
    expect(w.placeMedkit()).toBe(true);
    expect(w.placeMedkit()).toBe(false);
    w.soldierHurtAt = w.time + 1e6;
    s.hp = 20;
    run(w, 2);
    expect(s.hp).toBeCloseTo(40, 0);
    s.pos.x += MEDKIT.radius + 3;
    run(w, 2);
    expect(s.hp).toBeCloseTo(40, 0);
    s.pos.x -= MEDKIT.radius + 3;
    s.hp = 1;
    run(w, 20);
    expect(s.hp).toBe(SOLDIER_HP);
    run(w, MEDKIT.duration);
    expect(w.soldierGear.medkit).toBe(null);
    expect(w.placeMedkit()).toBe(false);
    run(w, MEDKIT.redeployCooldown + 1);
    expect(w.placeMedkit()).toBe(true);
  });

  it('brings one downed squad member back every 15 s (squad HP +8) only to friendly squads in range', () => {
    const w = scene();
    const friend = w.spawnUnit(ofSide('inf', 'coalition'), 2, 0);
    const far = w.spawnUnit(ofSide('inf', 'coalition'), 60, 0);
    const foe = w.spawnUnit(ofSide('inf', 'veros'), 3, 0, 0, { passive: true });
    for (const u of [friend, far, foe]) {
      u.passive = true;
      for (const m of u.members!.slice(0, 3)) m.alive = false;
      u.hp -= 3 * (u.def.hp / u.members!.length);
    }
    const full = friend.def.hp;
    const before = friend.hp;
    expect(w.placeMedkit()).toBe(true);
    run(w, MEDKIT.returnEvery - 1);
    expect(friend.members!.filter(m => m.alive)).toHaveLength(2);
    run(w, 2);
    expect(friend.members!.filter(m => m.alive)).toHaveLength(3);
    expect(friend.hp).toBeCloseTo(before + MEDKIT.returnHp, 6);
    run(w, MEDKIT.returnEvery);
    expect(friend.members!.filter(m => m.alive)).toHaveLength(4);
    expect(friend.hp).toBeCloseTo(before + 2 * MEDKIT.returnHp, 6);
    expect(friend.hp).toBeLessThanOrEqual(full);
    expect(far.members!.filter(m => m.alive)).toHaveLength(2);
    expect(foe.members!.filter(m => m.alive)).toHaveLength(2);
  });

  it('lands a thrown smoke grenade as a 8 m cloud for 20 s and counts the throws', () => {
    const w = scene();
    w.soldierCommands.pitch = 0.2;
    expect(w.throwSmoke()).toBe(true);
    expect(w.soldierGear.smokeLeft).toBe(1);
    run(w, SMOKE.flightMax + 0.5);
    expect(w.soldierGear.clouds).toHaveLength(1);
    const c = w.soldierGear.clouds[0];
    expect(c.r).toBe(SMOKE.radius);
    expect(Math.hypot(c.x, c.z)).toBeGreaterThan(10);
    run(w, SMOKE.duration + 0.5);
    expect(w.soldierGear.clouds).toHaveLength(0);
    expect(w.throwSmoke()).toBe(true);
    expect(w.throwSmoke()).toBe(false);
  });

  it('blocks bot sight through the cloud so a bot squad cannot fire at the player behind it', () => {
    const hits = (smoke: boolean) => {
      const w = scene();
      w.soldier!.pos.set(0, w.terrain.surfaceAt(0, 120), 120);
      const foe = w.spawnUnit(ofSide('inf', 'veros'), 0, 0);
      const events: SimEvent[] = [];
      w.events.onAny(e => events.push(e));
      const eye = foe.pos.clone().setY(foe.pos.y + foe.def.size[1] + 2);
      const gear = w.soldierGear;
      if (smoke) { gear.clouds.push({ x: 0, y: w.terrain.surfaceAt(0, 60), z: 60, r: SMOKE.radius, until: 1e9 }); w.los.clear(); }
      expect(w.los.visual(1, eye, new Vector3(0, w.soldier!.pos.y + 1.65, 120), w.time).clear).toBe(!smoke);
      w.soldier!.hp = 1e6;
      for (let i = 0; i < 20 / STEP; i++) { w.soldierLastShot = w.time; w.step(STEP); }
      return events.filter(e => e.t === 'fire' && e.owner === foe.id).length;
    };
    expect(hits(false)).toBeGreaterThan(5);
    expect(hits(true)).toBe(0);
  });
});
