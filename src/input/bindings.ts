export type Command =
  | 'engine' | 'view' | 'centerView' | 'toggleHud' | 'help' | 'mute' | 'pause'
  | 'fire' | 'weaponNext' | 'weaponPrev' | 'padA' | 'padLB' | 'padRB' | 'weapon1' | 'weapon2' | 'weapon3' | 'weapon4' | 'menu5'
  | 'tads' | 'laser' | 'zoomIn' | 'zoomOut' | 'fcr' | 'fcrMode' | 'targetNext'
  | 'flare' | 'chaff' | 'bobUp' | 'pnvs' | 'mpdLeftNext' | 'mpdRightNext' | 'radioMenu'
  | 'crouch' | 'prone' | 'reload' | 'spot' | 'enter' | 'medkit' | 'smoke';

export const KEY_COMMANDS: Readonly<Record<string, Command>> = {
  KeyI: 'engine',
  KeyV: 'view',
  KeyC: 'centerView',
  KeyU: 'toggleHud',
  KeyH: 'help',
  KeyM: 'mute',
  Escape: 'pause',
  Space: 'fire',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Digit3: 'weapon3',
  Digit4: 'weapon4',
  Digit5: 'menu5',
  KeyQ: 'weaponNext',
  KeyT: 'tads',
  KeyL: 'laser',
  Equal: 'zoomIn',
  NumpadAdd: 'zoomIn',
  Minus: 'zoomOut',
  NumpadSubtract: 'zoomOut',
  KeyR: 'fcr',
  KeyE: 'fcrMode',
  Tab: 'targetNext',
  KeyF: 'flare',
  KeyX: 'chaff',
  KeyB: 'bobUp',
  KeyN: 'pnvs',
  BracketLeft: 'mpdLeftNext',
  BracketRight: 'mpdRightNext',
  KeyG: 'radioMenu',
};

export const HELD_COMMANDS: ReadonlySet<Command> = new Set<Command>(['fire', 'laser']);

export const FLIGHT_KEYS = {
  collectiveUp: ['KeyW', 'PageUp'],
  collectiveDown: ['KeyS', 'PageDown'],
  cyclicForward: ['ArrowUp'],
  cyclicBack: ['ArrowDown'],
  cyclicLeft: ['ArrowLeft'],
  cyclicRight: ['ArrowRight'],
  pedalLeft: ['KeyA'],
  pedalRight: ['KeyD'],
  fine: ['ShiftLeft', 'ShiftRight'],
} as const;

export const PREVENT_DEFAULT: ReadonlySet<string> = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Tab',
]);

export const GAMEPAD_BUTTONS: Readonly<Record<number, Command>> = {
  0: 'padA',
  1: 'flare',
  2: 'chaff',
  3: 'view',
  4: 'padLB',
  5: 'padRB',
  6: 'laser',
  7: 'fire',
  9: 'pause',
  12: 'tads',
  13: 'fcr',
  14: 'weaponPrev',
  15: 'weaponNext',
};

export const PAD_HEAD_LOOK = 11;
export const PAD_HEAD_RATE = 2.4;

export function commandForKey(code: string): Command | undefined {
  return KEY_COMMANDS[code];
}
