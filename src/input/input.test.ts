import { describe, expect, it } from 'vitest';
import harekRaw from '../content/battle/maps/harek.json?raw';
import { createBattleSession } from '../sim/battle/runtime';
import type { BattleMapDef } from '../sim/battle/schema';
import { STEP, World } from '../sim/world';
import { commandForKey, FLIGHT_KEYS, GAMEPAD_BUTTONS, KEY_COMMANDS, PAD_HEAD_LOOK } from './bindings';
import { Pinch } from './pinch';
import { FlightInput } from './input';

describe('key bindings (07-ui-ux.md 7.6)', () => {
  it.each([
    ['KeyI', 'engine'], ['KeyV', 'view'], ['KeyC', 'centerView'], ['KeyU', 'toggleHud'], ['KeyH', 'help'], ['KeyM', 'mute'],
    ['Escape', 'pause'], ['Space', 'fire'], ['Digit1', 'weapon1'], ['Digit4', 'weapon4'], ['KeyQ', 'weaponNext'],
    ['KeyT', 'tads'], ['KeyL', 'laser'], ['Equal', 'zoomIn'], ['Minus', 'zoomOut'], ['KeyR', 'fcr'], ['Tab', 'targetNext'],
    ['KeyF', 'flare'], ['KeyX', 'chaff'], ['KeyB', 'bobUp'], ['KeyN', 'pnvs'], ['BracketLeft', 'mpdLeftNext'],
    ['BracketRight', 'mpdRightNext'], ['KeyG', 'radioMenu'],
  ])('%s → %s', (code, cmd) => {
    expect(commandForKey(code)).toBe(cmd);
  });

  it('keeps flight keys free of command bindings', () => {
    for (const keys of Object.values(FLIGHT_KEYS)) for (const k of keys) expect(KEY_COMMANDS[k]).toBeUndefined();
  });

  it('no longer uses Q/E as pedals', () => {
    expect([...FLIGHT_KEYS.pedalLeft, ...FLIGHT_KEYS.pedalRight]).toEqual(['KeyA', 'KeyD']);
  });
});

describe('FlightInput', () => {
  function frame(input: FlightInput, world: World, keys: string[], seconds = 1) {
    input.keys.clear();
    for (const k of keys) input.keys.add(k);
    for (let i = 0; i < seconds * 60; i++) input.update(world, 1 / 60);
  }

  it('maps held keys to controls', () => {
    const world = new World({ seed: 1 }), input = new FlightInput();
    frame(input, world, ['KeyW'], 1);
    expect(world.controls.collective).toBeCloseTo(0.45, 2);
    frame(input, world, ['ArrowUp', 'ArrowRight', 'KeyD'], 2);
    expect(world.controls.cyclicY).toBeGreaterThan(0.99);
    expect(world.controls.cyclicX).toBeGreaterThan(0.99);
    expect(world.controls.pedal).toBe(1);
    frame(input, world, ['KeyQ', 'KeyE'], 1);
    expect(world.controls.pedal).toBe(0);
  });

  it('fires while Space is held and aims where the head looks', () => {
    const world = new World({ seed: 1 }), input = new FlightInput();
    input.headYaw = 0.3; input.headPitch = -0.2;
    frame(input, world, ['Space'], 0.1);
    expect(world.commands.fire).toBe(true);
    expect(world.commands.aim).toEqual({ yaw: 0.3, pitch: -0.2 });
    frame(input, world, [], 0.1);
    expect(world.commands.fire).toBe(false);
  });

  it('holds the collective where it was left and makes Shift fine', () => {
    const world = new World({ seed: 1 }), input = new FlightInput();
    frame(input, world, ['KeyW'], 1);
    frame(input, world, [], 2);
    expect(world.controls.collective).toBeCloseTo(0.45, 2);
    frame(input, world, ['KeyW', 'ShiftLeft'], 1);
    expect(world.controls.collective).toBeCloseTo(0.45 + 0.135, 2);
  });
});

describe('gamepad (07 7.6)', () => {
  const pad = (axes: number[], pressed: number[] = []) => ({ connected: true, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })) });

  it('maps the standard layout to combat commands', () => {
    expect(GAMEPAD_BUTTONS[7]).toBe('fire');
    expect(GAMEPAD_BUTTONS[6]).toBe('laser');
    expect(GAMEPAD_BUTTONS[5]).toBe('padRB');
    expect(GAMEPAD_BUTTONS[4]).toBe('padLB');
    expect(GAMEPAD_BUTTONS[0]).toBe('padA');
    expect([GAMEPAD_BUTTONS[1], GAMEPAD_BUTTONS[2], GAMEPAD_BUTTONS[3]]).toEqual(['flare', 'chaff', 'view']);
    expect([GAMEPAD_BUTTONS[12], GAMEPAD_BUTTONS[13], GAMEPAD_BUTTONS[14], GAMEPAD_BUTTONS[15]]).toEqual(['tads', 'fcr', 'weaponPrev', 'weaponNext']);
    expect(GAMEPAD_BUTTONS[9]).toBe('pause');
  });

  it('fires with RT, lases with LT and sends button presses once', () => {
    const world = new World({ seed: 1 }), input = new FlightInput();
    const got: string[] = [];
    input.onCommand = c => got.push(c);
    let p = pad([0, 0, 0, 0], [7, 6, 1]);
    input.gamepads = () => [p];
    input.update(world, 1 / 60); input.update(world, 1 / 60);
    expect(world.commands.fire).toBe(true);
    expect(world.commands.laser).toBe(true);
    expect(got).toEqual(['flare', 'laser', 'fire']);
    p = pad([0, 0, 0, 0]);
    input.update(world, 1 / 60);
    expect(world.commands.fire).toBe(false);
  });

  it('turns the head with the right stick while it is pressed in, instead of the cyclic', () => {
    const world = new World({ seed: 1 }), input = new FlightInput();
    input.gamepads = () => [pad([0, 0, 0.9, 0])];
    input.update(world, 0.1);
    expect(world.controls.cyclicX).toBeGreaterThan(0.8);
    expect(input.headYaw).toBe(0);
    input.gamepads = () => [pad([0, 0, 0.9, -0.6], [PAD_HEAD_LOOK])];
    for (let i = 0; i < 10; i++) input.update(world, 0.05);
    expect(world.controls.cyclicX).toBe(0);
    expect(input.headYaw).toBeLessThan(-0.5);
    expect(input.headPitch).toBeGreaterThan(0.2);
  });
});

describe('pinch zoom (07 7.6)', () => {
  it('steps zoom in and out as two fingers spread and close', () => {
    const p = new Pinch();
    expect(p.down(1, 100, 100)).toBe(false);
    expect(p.down(2, 200, 100)).toBe(true);
    expect(p.move(2, 220, 100)).toBe(0);
    expect(p.move(2, 240, 100)).toBe(1);
    expect(p.move(2, 150, 100)).toBe(-1);
    p.up(2);
    expect(p.active).toBe(false);
    expect(p.move(1, 0, 0)).toBe(0);
  });
});

describe('soldier aim assist and gamepad (B2-11)', () => {
  it('pulls the aim toward an enemy near the crosshair only when enabled and on touch or pad', async () => {
    const { World } = await import('../sim/world');
    const { FlightInput } = await import('./input');
    const w = new World({ seed: 3, terrain: { features: [{ kind: 'flatten', center: [0, 0], radius: 600 }], pads: [{ x: -1500, z: -1500, name: 'H' }] } });
    w.active = true;
    w.spawnAvatar({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' });
    const e = w.spawnUnit('inf', 3, -100);
    void e;
    const input = new FlightInput();
    input.gamepads = () => [];
    input.touchUsed = true;
    input.update(w, 0.1);
    const yaw0 = input.soldierYaw;
    for (let i = 0; i < 20; i++) input.update(w, 0.05);
    expect(input.assistActive).toBe(true);
    expect(input.soldierYaw).toBeLessThan(yaw0);
    const off = new FlightInput();
    off.gamepads = () => [];
    off.touchUsed = true;
    off.aimAssist = false;
    off.update(w, 0.1);
    const y1 = off.soldierYaw;
    for (let i = 0; i < 20; i++) off.update(w, 0.05);
    expect(off.soldierYaw).toBe(y1);
    const mouse = new FlightInput();
    mouse.gamepads = () => [];
    mouse.update(w, 0.1);
    const y2 = mouse.soldierYaw;
    for (let i = 0; i < 20; i++) mouse.update(w, 0.05);
    expect(mouse.soldierYaw).toBe(y2);
  });

  it('moves, looks and fires with a gamepad on foot', async () => {
    const { World } = await import('../sim/world');
    const { FlightInput } = await import('./input');
    const w = new World({ seed: 3 });
    w.active = true;
    w.spawnAvatar({ kind: 'soldier', x: 0, z: 0, headingDeg: 0, cls: 'assault' });
    const input = new FlightInput();
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
    buttons[7].pressed = true; buttons[6].pressed = true;
    input.gamepads = () => [{ connected: true, axes: [0.8, -1, 0.5, 0], buttons }];
    const cmds: string[] = [];
    input.onCommand = c => cmds.push(c);
    input.update(w, 0.1);
    const y0 = input.soldierYaw;
    input.update(w, 0.1);
    expect(w.soldierCommands).toMatchObject({ fire: true, ads: true });
    expect(w.soldierCommands.forward).toBeGreaterThan(0.9);
    expect(w.soldierCommands.right).toBeGreaterThan(0.5);
    expect(input.soldierYaw).toBeLessThan(y0);
    buttons[2].pressed = true;
    input.update(w, 0.1);
    expect(cmds).toContain('reload');
  });
});

describe('mouse buttons on focus loss (#267)', () => {
  const harek = JSON.parse(harekRaw) as BattleMapDef;

  function fighter(seed: number) {
    const { session } = createBattleSession(harek, 'quick', { side: 'coalition', seed });
    session.start();
    const base = harek.bases[0].position;
    session.deploy({ kind: 'soldier', x: base[0] + 30, z: base[1] - 30, headingDeg: 0, cls: 'assault' });
    const world = session.world, input = new FlightInput();
    input.gamepads = () => [];
    const mag = () => world.soldierArms.ammo[world.soldierArms.selected]!.mag;
    const run = (seconds: number) => { for (let i = 0; i < seconds * 120; i++) { input.update(world, STEP); session.step(STEP); } };
    return { world, input, mag, run };
  }

  function watched(seed: number) {
    const f = fighter(seed), win = new EventTarget(), doc = new EventTarget(), lock = { held: true };
    const stop = f.input.watchMouseRelease(win, doc, () => lock.held);
    return { ...f, win, doc, lock, stop };
  }

  const paths: [string, (f: ReturnType<typeof watched>) => void][] = [
    ['lock lost', f => { f.lock.held = false; f.doc.dispatchEvent(new Event('pointerlockchange')); }],
    ['blur, lock kept', f => { f.win.dispatchEvent(new Event('blur')); }],
    ['blur, then lock lost', f => { f.win.dispatchEvent(new Event('blur')); f.lock.held = false; f.doc.dispatchEvent(new Event('pointerlockchange')); }],
  ];

  describe.each([1, 2])('seed %i', seed => {
    it.each(paths)('%s stops firing and leaves the magazine alone', (_, lose) => {
      const f = watched(seed);
      f.run(0.1);
      const full = f.mag();
      f.input.mouseFire = true; f.input.mouseAds = true;
      f.run(0.5);
      expect(f.world.soldierCommands).toMatchObject({ fire: true, ads: true });
      const firing = f.mag(), shots = f.world.soldierArms.shots;
      expect(firing).toBeLessThan(full);
      lose(f);
      expect(f.input).toMatchObject({ mouseFire: false, mouseAds: false });
      f.run(2);
      expect(f.world.soldierCommands).toMatchObject({ fire: false, ads: false });
      expect(f.mag()).toBe(firing);
      expect(f.world.soldierArms.shots).toBe(shots);
    });

    it('fires the same number of shots while the lock holds', () => {
      const count = (f: ReturnType<typeof fighter>) => {
        f.run(0.1);
        f.input.mouseFire = true;
        f.run(2);
        return f.world.soldierArms.shots;
      };
      const plain = count(fighter(seed));
      expect(plain).toBeGreaterThan(0);
      const held = watched(seed);
      held.doc.dispatchEvent(new Event('pointerlockchange'));
      expect(count(held)).toBe(plain);
    });
  });

  it('keeps a press when the lock is gained', () => {
    const f = watched(1);
    f.input.mouseFire = true; f.input.mouseAds = true;
    f.doc.dispatchEvent(new Event('pointerlockchange'));
    expect(f.input).toMatchObject({ mouseFire: true, mouseAds: true });
  });

  it('stops listening when disposed', () => {
    const f = watched(1);
    f.stop();
    f.input.mouseFire = true;
    f.win.dispatchEvent(new Event('blur'));
    expect(f.input.mouseFire).toBe(true);
  });
});
