import { clamp } from '../core/math';
import { slewTads, type Tads } from '../sim/sensors/tads';
import type { World } from '../sim/world';
import { FLIGHT_KEYS, GAMEPAD_BUTTONS, KEY_COMMANDS, PAD_HEAD_LOOK, PAD_HEAD_RATE, type Command } from './bindings';
import { SOLDIER_KEYS } from './roles';

export interface PadLike { connected: boolean; axes: readonly number[]; buttons: readonly { pressed: boolean }[] }

export interface TouchSticks { lx: number; ly: number; rx: number; ry: number }

const DEAD = 0.12;
export const REST_PITCH = -0.05;
export const ASSIST_CONE = (4 * Math.PI) / 180;
export const ASSIST_RANGE = 300;
export const ASSIST_PULL = 0.6;
export const ASSIST_SLOW = 0.6;
export const PAD_LOOK_RATE = 2.6;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class FlightInput {
  readonly keys = new Set<string>();
  readonly touch: TouchSticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
  lookScale = 1;
  tadsScale = 1;
  invertY = false;
  headYaw = 0;
  headPitch = -0.1;
  private cx = 0;
  private cy = 0;
  private padButtons: boolean[] = [];
  touchFire = false;
  touchLaser = false;
  private tads: Tads | null = null;
  headLook = false;
  gamepads: () => readonly (PadLike | null)[] = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []);

  held(cmd: Command) {
    for (const k of this.keys) if (KEY_COMMANDS[k] === cmd) return true;
    return false;
  }
  onCommand?: (cmd: Command) => void;

  private heldKeys(keys: readonly string[]) {
    return keys.some(k => this.keys.has(k));
  }

  mouseFire = false;
  touchAds = false;
  touchRepair = false;
  aimAssist = true;
  assistActive = false;
  private assistNear = false;
  private padSoldier: boolean[] = [];
  mouseAds = false;
  soldierYaw = 0;
  soldierPitch = 0;
  private role: 'heli' | 'soldier' | 'none' = 'heli';

  update(world: World, dt: number) {
    const kind = world.avatar.kind;
    if (kind === 'soldier') {
      if (this.role !== 'soldier' && world.soldier) { this.soldierYaw = world.soldier.yaw; this.soldierPitch = REST_PITCH; }
      this.role = 'soldier';
      this.updateSoldier(world, dt);
      return;
    }
    this.role = kind === 'heli' ? 'heli' : 'none';
    const c = world.controls, K = FLIGHT_KEYS;
    const tx = (this.heldKeys(K.cyclicRight) ? 1 : 0) - (this.heldKeys(K.cyclicLeft) ? 1 : 0);
    const ty = (this.heldKeys(K.cyclicForward) ? 1 : 0) - (this.heldKeys(K.cyclicBack) ? 1 : 0);
    const ramp = Math.min(1, dt * 4);
    this.cx += (tx - this.cx) * ramp;
    this.cy += (ty - this.cy) * ramp;

    let cyclicX = this.cx + this.touch.rx, cyclicY = this.cy - this.touch.ry;
    let pedal = (this.heldKeys(K.pedalRight) ? 1 : 0) - (this.heldKeys(K.pedalLeft) ? 1 : 0) + this.touch.lx;
    const fine = this.heldKeys(K.fine) ? 0.3 : 1;
    let collRate = ((this.heldKeys(K.collectiveUp) ? 1 : 0) - (this.heldKeys(K.collectiveDown) ? 1 : 0)) * 0.45 * fine;
    collRate += -this.touch.ly * 0.5;

    let padFire = false, padLaser = false;
    const gp = Array.from(this.gamepads() ?? []).find(p => p && p.connected);
    if (gp) {
      pedal += dz(gp.axes[0] ?? 0);
      collRate += -dz(gp.axes[1] ?? 0) * 0.5;
      const pressed = gp.buttons.map(b => b.pressed);
      this.headLook = pressed[PAD_HEAD_LOOK] ?? false;
      const rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
      if (this.headLook) {
        const k = PAD_HEAD_RATE * dt * (this.tads?.active ? this.tadsScale * 0.6 : this.lookScale);
        const sy = this.invertY ? -ry : ry;
        if (this.tads?.active) slewTads(this.tads, -rx * k, -sy * k);
        else { this.headYaw = clamp(this.headYaw - rx * k, -2.2, 2.2); this.headPitch = clamp(this.headPitch - sy * k, -1.1, 0.7); }
      } else {
        cyclicX += rx;
        cyclicY += -ry;
      }
      pressed.forEach((on, i) => {
        const cmd = GAMEPAD_BUTTONS[i];
        if (cmd && on && !this.padButtons[i]) this.onCommand?.(cmd);
      });
      this.padButtons = pressed;
      padFire = pressed[7] ?? false;
      padLaser = pressed[6] ?? false;
    }

    c.cyclicX = clamp(cyclicX, -1, 1);
    c.cyclicY = clamp(cyclicY, -1, 1);
    c.pedal = clamp(pedal, -1, 1);
    c.collective = clamp(c.collective + collRate * dt, 0, 1);
    world.commands.fire = this.held('fire') || this.touchFire || padFire;
    world.commands.laser = this.held('laser') || this.touchLaser || padLaser;
    this.tads = world.tads;
    if (!world.tads.active) {
      world.commands.aim.yaw = this.headYaw;
      world.commands.aim.pitch = this.headPitch;
    }
  }

  private updateSoldier(world: World, dt: number) {
    const k = SOLDIER_KEYS, c = world.soldierCommands;
    let fwd = (this.heldKeys(k.forward) ? 1 : 0) - (this.heldKeys(k.back) ? 1 : 0) - this.touch.ly;
    let right = (this.heldKeys(k.right) ? 1 : 0) - (this.heldKeys(k.left) ? 1 : 0) + this.touch.lx;
    let padFire = false, padAds = false, padSprint = false, padJump = false;
    const gp = Array.from(this.gamepads() ?? []).find(p => p && p.connected);
    if (gp) {
      right += dz(gp.axes[0] ?? 0); fwd += -dz(gp.axes[1] ?? 0);
      const rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
      const slow = this.assistNear && this.aimAssist ? ASSIST_SLOW : 1;
      this.soldierYaw -= rx * PAD_LOOK_RATE * this.lookScale * slow * dt;
      this.soldierPitch = clamp(this.soldierPitch - (this.invertY ? -ry : ry) * PAD_LOOK_RATE * 0.7 * this.lookScale * slow * dt, -1.4, 1.4);
      const pressed = gp.buttons.map(b => b.pressed);
      const edge = (i: number) => (pressed[i] ?? false) && !this.padSoldier[i];
      padFire = pressed[7] ?? false; padAds = pressed[6] ?? false; padSprint = pressed[10] ?? false; padJump = pressed[0] ?? false;
      if (edge(1)) this.onCommand?.('crouch');
      if (edge(2)) this.onCommand?.('reload');
      if (edge(3)) this.onCommand?.('enter');
      if (edge(4)) this.onCommand?.('spot');
      if (edge(12)) this.onCommand?.('weapon1');
      if (edge(14) || edge(15)) this.onCommand?.('weapon2');
      if (edge(9)) this.onCommand?.('pause');
      this.padSoldier = pressed;
    }
    c.forward = clamp(fwd, -1, 1);
    c.right = clamp(right, -1, 1);
    c.sprint = this.heldKeys(k.sprint) || padSprint || Math.hypot(this.touch.lx, this.touch.ly) > 0.95;
    c.jump = this.heldKeys(k.jump) || padJump;
    c.fire = this.mouseFire || this.touchFire || padFire;
    c.repair = this.heldKeys(k.repair) || this.touchRepair;
    c.ads = this.mouseAds || this.touchAds || padAds;
    this.assist(world, dt, !!gp || this.touchUsed);
    c.yaw = this.soldierYaw;
    c.pitch = this.soldierPitch;
  }

  touchUsed = false;

  private assist(world: World, dt: number, eligible: boolean) {
    this.assistNear = false;
    this.assistActive = false;
    const s = world.soldier;
    if (!s || !this.aimAssist || !eligible) return;
    const ex = s.pos.x, ey = s.pos.y + 1.6, ez = s.pos.z;
    const cp = Math.cos(this.soldierPitch);
    const fx = -Math.sin(this.soldierYaw) * cp, fy = Math.sin(this.soldierPitch), fz = -Math.cos(this.soldierYaw) * cp;
    let best = ASSIST_CONE, by = 0, bp = 0;
    for (const u of world.units) {
      if (!u.alive || !world.huntsPlayer(u)) continue;
      const dx = u.pos.x - ex, dy = u.pos.y + 1.2 - ey, dz2 = u.pos.z - ez, d = Math.hypot(dx, dy, dz2);
      if (d > ASSIST_RANGE || d < 1) continue;
      const ang = Math.acos(clamp((dx * fx + dy * fy + dz2 * fz) / d, -1, 1));
      if (ang < best) { best = ang; by = Math.atan2(-dx, -dz2); bp = Math.asin(clamp(dy / d, -1, 1)); }
    }
    if (best >= ASSIST_CONE) return;
    this.assistNear = true;
    this.assistActive = true;
    const k = Math.min(1, ASSIST_PULL * dt / Math.max(best, 1e-3)) * 0.5;
    let dyaw = by - this.soldierYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.soldierYaw += dyaw * k;
    this.soldierPitch += (bp - this.soldierPitch) * k;
  }

  look(dx: number, dy: number) {
    const sy = this.invertY ? -dy : dy;
    if (this.role === 'soldier') {
      const slow = this.assistNear && this.aimAssist && this.touchUsed ? ASSIST_SLOW : 1;
      this.soldierYaw -= dx * 0.0035 * this.lookScale * slow;
      this.soldierPitch = clamp(this.soldierPitch - sy * 0.0035 * this.lookScale * slow, -1.4, 1.4);
      return;
    }
    if (this.tads?.active) { slewTads(this.tads, -dx * 0.004 * this.tadsScale, -sy * 0.004 * this.tadsScale); return; }
    this.headYaw = clamp(this.headYaw - dx * 0.005 * this.lookScale, -2.2, 2.2);
    this.headPitch = clamp(this.headPitch - sy * 0.005 * this.lookScale, -1.1, 0.7);
  }

  centerView() { this.headYaw = 0; this.headPitch = -0.1; }
}
