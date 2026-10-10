import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../events';
import { DIFFICULTIES } from '../difficulty';
import { ofSide } from '../testing';
import { STEP, World } from '../world';
import { CLASS_KITS, createArms } from './arms';
import { createGear, MEDKIT, MINE, SMOKE } from './gear';
import type { Unit } from '../units';
import { aspectMultiplier, WEAPONS } from '../weapons/damage';
import { integrate } from '../weapons/projectile';
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

describe('engineer gear (wiki 12.4): carbine, anti-tank rocket, repair tool, mine', () => {
  const tank = (w: World, side: 'coalition' | 'veros', x: number, z: number, yaw = 0) => {
    const u = w.spawnUnit(ofSide('tank', side), x, z, yaw, { passive: true });
    u.passive = true;
    return u;
  };
  const shoot = (w: World, from: Vector3, dir: Vector3, weapon = 'at_rocket') => {
    const def = WEAPONS[weapon];
    w.projectiles.push({ id: 9999, weapon, pos: from.clone(), origin: from.clone(), vel: dir.clone().normalize().multiplyScalar(def.speed), owner: 0, life: 20, drag: def.drag ?? 0, tracer: false });
    for (let i = 0; i < 4 / STEP && w.projectiles.length; i++) w.step(STEP);
  };

  it('equips the engineer with carbine, three rockets (1 loaded + 2), repair tool and two mines in 3 slots', () => {
    const k = CLASS_KITS.engineer;
    expect(k.primary).toBe('carbine');
    expect(k.gear.length + k.tools.length).toBeLessThanOrEqual(k.gearSlots);
    const a = createArms('engineer');
    expect(a.ammo.at_rocket!.mag + a.ammo.at_rocket!.reserve).toBe(3);
    expect(createGear('engineer')).toMatchObject({ repairable: true, mineLeft: 2 });
    expect(createGear('assault')).toMatchObject({ repairable: false, mineLeft: 0 });
  });

  it('flies the rocket on a 150 m/s parabola and kills a tank in 3 frontal or 2 rear hits (wiki 12.5)', () => {
    const w = scene('engineer');
    const rocket = WEAPONS.at_rocket;
    expect(rocket.speed).toBe(150);
    const from = new Vector3(0, w.terrain.surfaceAt(0, 0) + 1.65, 0);
    const front = tank(w, 'veros', 0, -40, Math.PI);
    shoot(w, from, new Vector3(0, 0.012, -1));
    expect(front.hp).toBeCloseTo(300 - 120, 3);
    shoot(w, from, new Vector3(0, 0.012, -1));
    expect(front.alive).toBe(true);
    shoot(w, from, new Vector3(0, 0.012, -1));
    expect(front.alive).toBe(false);
    const rear = tank(w, 'veros', 80, -40, 0);
    shoot(w, from.clone().setX(80), new Vector3(0, 0.012, -1));
    expect(rear.hp).toBeCloseTo(300 - 180, 3);
    shoot(w, from.clone().setX(80), new Vector3(0, 0.012, -1));
    expect(rear.alive).toBe(false);
  });

  it('applies x1.2 on the side and x1.5 behind only from the player, and drops the shot with gravity', () => {
    const w = scene('engineer');
    const from = new Vector3(0, w.terrain.surfaceAt(0, 0) + 1.65, 0);
    const side = tank(w, 'veros', 0, -40, Math.PI / 2);
    shoot(w, from, new Vector3(0, 0, -1));
    expect(side.hp).toBeCloseTo(300 - 144, 3);
    const a = new Vector3(0, 100, 0), b = a.clone();
    const p = { id: 1, weapon: 'at_rocket', pos: a, origin: a.clone(), vel: new Vector3(0, 0, -150), owner: 0, life: 9, drag: 0, tracer: false };
    for (let i = 0; i < 2 / STEP; i++) integrate(p, STEP);
    expect(p.pos.y).toBeLessThan(b.y - 15);
    expect(aspectMultiplier({ ...side, yaw: 0 } as Unit, new Vector3(0, 0, -1))).toBe(1.5);
    expect(aspectMultiplier({ ...side, yaw: 0 } as Unit, new Vector3(0, 0, 1))).toBe(1);
  });

  it('repairs a friendly vehicle 20 HP/s while held, overheats after 5 s for 3 s, then works again', () => {
    const w = scene('engineer');
    const ally = tank(w, 'coalition', 0, -5);
    ally.hp = 50;
    const foe = tank(w, 'veros', 0, 5);
    foe.hp = 50;
    w.soldierCommands.repair = true;
    run(w, 2);
    expect(ally.hp).toBeCloseTo(90, 0);
    expect(foe.hp).toBe(50);
    run(w, 3.2);
    expect(ally.hp).toBeCloseTo(150, 0);
    expect(w.soldierGear.overheatUntil).toBeGreaterThan(w.time);
    const hot = ally.hp;
    run(w, 2);
    expect(ally.hp).toBe(hot);
    run(w, 1.5);
    expect(ally.hp).toBeGreaterThan(hot);
  });

  it('does not repair out of range, above full HP, or without the engineer tool', () => {
    const w = scene('engineer');
    const far = tank(w, 'coalition', 0, -40);
    far.hp = 50;
    w.soldierCommands.repair = true;
    run(w, 1);
    expect(far.hp).toBe(50);
    const a = scene('assault');
    const ally = tank(a, 'coalition', 0, -5);
    ally.hp = 50;
    a.soldierCommands.repair = true;
    run(a, 1);
    expect(ally.hp).toBe(50);
  });

  it('mines hit enemy vehicles for 200 pen 5, never friendly or civilian ones, and stay 60 s after death', () => {
    const w = scene('engineer');
    expect(w.placeMine()).toBe(true);
    expect(w.placeMine()).toBe(true);
    expect(w.placeMine()).toBe(false);
    w.soldierGear.mines[1].pos.x += 50;
    const mine = w.soldierGear.mines[0].pos;
    const ally = tank(w, 'coalition', mine.x, mine.z);
    const civ = w.spawnUnit('civ_car', mine.x, mine.z, 0, { passive: true });
    run(w, 2);
    expect(ally.hp).toBe(300);
    expect(civ.hp).toBe(civ.def.hp);
    expect(w.soldierGear.mines.length).toBe(2);
    ally.pos.x += 500;
    const foe = tank(w, 'veros', mine.x, mine.z);
    run(w, 0.2);
    expect(foe.hp).toBeCloseTo(300 - 240, 3);
    expect(w.soldierGear.mines.length).toBe(1);
    w.killPlayer('killed');
    run(w, MINE.afterDeath - 5);
    expect(w.soldierGear.mines.length).toBe(1);
    run(w, 6);
    expect(w.soldierGear.mines.length).toBe(0);
  });

  it('keeps mines across a respawn within the 60 s window', () => {
    const w = scene('engineer');
    w.placeMine();
    w.killPlayer('killed');
    run(w, 10);
    w.spawnAvatar({ kind: 'soldier', x: 0, z: 30, headingDeg: 0, cls: 'engineer' });
    expect(w.soldierGear.mines.length).toBe(1);
    expect(w.soldierGear.mineLeft).toBe(2);
  });
});
