import { Vector3 } from 'three';
import { clamp, wrapPi } from '../../core/math';
import { AIRCRAFT, G3, MAX_PITCH, MAX_ROLL } from './airframe';
import { liftPerCollective, type FlightEnv } from './flight';
import type { Controls, HeliState } from './state';

export interface Hold { anchor: Vector3; yaw: number; ix: number; iz: number }

const SETTLE_SPEED = 2;
const KP = 0.3, KD = 1.0, KI = 0.04, MAX_ACC = 3;

export function createHold(h: HeliState): Hold {
  return { anchor: h.pos.clone(), yaw: h.yaw, ix: 0, iz: 0 };
}

export function accelerate(h: HeliState, env: FlightEnv, ax: number, az: number, ay: number, out: Controls) {
  const s = Math.sin(h.yaw), c = Math.cos(h.yaw);
  const wx = h.vel.x - env.wind.x, wz = h.vel.z - env.wind.z;
  const vf = -s * wx - c * wz, vr = c * wx - s * wz;
  const dr = AIRCRAFT.drag;
  const af = -s * ax - c * az + dr.forward.linear * vf + dr.forward.quadratic * vf * Math.abs(vf);
  const ar = c * ax - s * az + dr.side.linear * vr + dr.side.quadratic * vr * Math.abs(vr);
  out.cyclicY = clamp(Math.atan(af / G3) / MAX_PITCH, -1, 1);
  out.cyclicX = clamp(Math.atan(ar / G3) / MAX_ROLL, -1, 1);
  const lift = liftPerCollective(h, env) * Math.max(0.5, Math.cos(h.pitch) * Math.cos(h.roll));
  out.collective = lift > 0 ? clamp((G3 + ay) / lift, 0, 1) : out.collective;
  return out;
}

export function autoHover(h: HeliState, hold: Hold, env: FlightEnv, dt: number, out: Controls) {
  if (Math.hypot(h.vel.x, h.vel.z) > SETTLE_SPEED) {
    hold.anchor.x = h.pos.x; hold.anchor.z = h.pos.z;
    hold.ix = hold.iz = 0;
  }
  const ex = hold.anchor.x - h.pos.x, ez = hold.anchor.z - h.pos.z;
  hold.ix = clamp(hold.ix + ex * dt, -40, 40);
  hold.iz = clamp(hold.iz + ez * dt, -40, 40);
  const ax = clamp(KP * ex - KD * h.vel.x + KI * hold.ix, -MAX_ACC, MAX_ACC);
  const az = clamp(KP * ez - KD * h.vel.z + KI * hold.iz, -MAX_ACC, MAX_ACC);
  const ay = clamp(0.8 * (hold.anchor.y - h.pos.y) - 1.6 * h.vel.y, -3, 3);
  accelerate(h, env, ax, az, ay, out);

  out.pedal = clamp(-1.5 * wrapPi(hold.yaw - h.yaw) / AIRCRAFT.yaw.pedalRate, -1, 1);
  return out;
}
