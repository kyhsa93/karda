import { Vector3 } from 'three';

export type Stance = 'stand' | 'crouch' | 'prone';
export type SoldierClass = 'assault' | 'engineer' | 'support' | 'recon';

export const SOLDIER_HP = 100;
export const SOLDIER_RADIUS = 0.35;
export const SOLDIER_DAMAGE_SCALE = 12.5;
export const REGEN_DELAY = 8;
export const REGEN_RATE = 5;
export const EYE_HEIGHT: Record<Stance, number> = { stand: 1.65, crouch: 1.1, prone: 0.35 };

export interface SoldierCommands {
  forward: number;
  right: number;
  sprint: boolean;
  jump: boolean;
  fire: boolean;
  repair: boolean;
  ads: boolean;
  yaw: number;
  pitch: number;
}

export interface SoldierState {
  pos: Vector3;
  vel: Vector3;
  yaw: number;
  pitch: number;
  stance: Stance;
  hp: number;
  alive: boolean;
  cls: SoldierClass;
  onGround: boolean;
}

export function createSoldier(pos: Vector3, yaw: number, cls: SoldierClass = 'assault'): SoldierState {
  return { pos: pos.clone(), vel: new Vector3(), yaw, pitch: 0, stance: 'stand', hp: SOLDIER_HP, alive: true, cls, onGround: true };
}

export function createSoldierCommands(): SoldierCommands {
  return { forward: 0, right: 0, sprint: false, jump: false, fire: false, repair: false, ads: false, yaw: 0, pitch: 0 };
}

export function soldierEye(s: SoldierState, out = new Vector3()) {
  return out.set(s.pos.x, s.pos.y + EYE_HEIGHT[s.stance], s.pos.z);
}
