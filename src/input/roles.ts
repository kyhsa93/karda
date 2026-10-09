import type { World } from '../sim/world';
import { KEY_COMMANDS, type Command } from './bindings';

export type Role = 'heli' | 'soldier' | 'none';

export const SOLDIER_COMMANDS: Readonly<Record<string, Command>> = {
  KeyC: 'crouch',
  KeyZ: 'prone',
  KeyR: 'reload',
  KeyX: 'medkit',
  KeyF: 'smoke',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Digit3: 'weapon3',
  Digit4: 'weapon4',
  KeyQ: 'spot',
  KeyE: 'enter',
  KeyV: 'view',
  KeyU: 'toggleHud',
  KeyH: 'help',
  KeyM: 'mute',
  Escape: 'pause',
  KeyG: 'radioMenu',
};

export const SOLDIER_KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
} as const;

export const ROLE_COMMANDS: Record<Role, Readonly<Record<string, Command>>> = {
  heli: KEY_COMMANDS,
  soldier: SOLDIER_COMMANDS,
  none: { Escape: 'pause', KeyH: 'help', KeyM: 'mute' },
};

export function roleOf(world: World): Role {
  const k = world.avatar.kind;
  return k === 'soldier' ? 'soldier' : k === 'heli' ? 'heli' : 'none';
}

export function roleCommand(code: string, role: Role): Command | undefined {
  return ROLE_COMMANDS[role][code];
}

export function wantsPointerLock(role: Role, touch: boolean) {
  return role === 'soldier' && !touch;
}
