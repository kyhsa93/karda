import { t } from '../../content/strings';
import type { Settings } from '../../save/save';
import { read, tabStorage, write, type KeyValue } from '../../save/storage';
import { DIFFICULTY_LEVELS, type DifficultyLevel } from '../../sim/difficulty';
import type { BattleMode } from '../state';

export interface BattleChoice { mode: BattleMode; map: string; side: 'coalition' | 'veros'; time: 'day' | 'dusk' }

export const DEFAULT_CHOICE: BattleChoice = { mode: 'quick', map: 'harek', side: 'coalition', time: 'day' };
export const READY = { modes: ['quick'], maps: ['harek'], sides: ['coalition', 'veros'] } as const;
const TIMES = ['day', 'dusk'] as const;
const ESTIMATE = { quick: [8, 12, 10, 7] } as const;
const CHOICE_KEY = 'karda-battle-choice';

const known = <T extends string>(value: unknown, options: readonly string[], fallback: T) => (options.includes(value as string) ? value as T : fallback);

export function loadChoice(store: KeyValue | null = tabStorage()): BattleChoice {
  const raw = read(store, CHOICE_KEY);
  if (!raw) return DEFAULT_CHOICE;
  try {
    const c = JSON.parse(raw) ?? {};
    return {
      mode: known(c.mode, READY.modes, DEFAULT_CHOICE.mode),
      map: known(c.map, READY.maps, DEFAULT_CHOICE.map),
      side: known(c.side, READY.sides, DEFAULT_CHOICE.side),
      time: known(c.time, TIMES, DEFAULT_CHOICE.time),
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

export function storeChoice(choice: BattleChoice, store: KeyValue | null = tabStorage()) {
  write(store, CHOICE_KEY, JSON.stringify(choice));
}

function Pick<T extends string>({ value, options, ready, label, onPick }: { value: T; options: readonly T[]; ready: readonly string[]; label: (v: T) => string; onPick: (v: T) => void }) {
  return (
    <div className="choice">
      {options.map(o => {
        const ok = ready.includes(o);
        return (
          <button key={o} className={o === value ? 'on' : ''} disabled={!ok} onClick={() => onPick(o)}>
            {label(o)}{!ok && <small>{t('battle.setup.soon')}</small>}
          </button>
        );
      })}
    </div>
  );
}

export function BattleSetup({ choice, settings, onChoice, onDifficulty, onDeploy, onBack }: {
  choice: BattleChoice; settings: Settings; onChoice: (c: BattleChoice) => void; onDifficulty: (d: DifficultyLevel) => void; onDeploy: () => void; onBack: () => void;
}) {
  const set = (patch: Partial<BattleChoice>) => onChoice({ ...choice, ...patch });
  const [min, max, squads, vehicles] = ESTIMATE.quick;
  const rows: [string, React.ReactElement][] = [
    ['mode', <Pick value={choice.mode} options={['quick', 'conquest', 'breakthrough'] as BattleMode[]} ready={READY.modes} label={v => t(`battle.modes.${v}`)} onPick={mode => set({ mode })} />],
    ['map', <Pick value={choice.map} options={['harek', 'reservoir', 'pass']} ready={READY.maps} label={v => t(`battle.maps.${v}`)} onPick={map => set({ map })} />],
    ['side', <Pick value={choice.side} options={['coalition', 'veros'] as const} ready={READY.sides} label={v => t(`battle.sides.${v}`)} onPick={side => set({ side })} />],
    ['difficulty', <Pick value={settings.difficulty} options={DIFFICULTY_LEVELS} ready={DIFFICULTY_LEVELS} label={v => t(`settings.difficulty.${v}`)} onPick={onDifficulty} />],
    ['time', <Pick value={choice.time} options={TIMES} ready={TIMES} label={v => t(`battle.times.${v}`)} onPick={time => set({ time })} />],
  ];
  return (
    <div className="menu setup">
      <div className="card wide battle-setup">
        <h1>{t('battle.setup.title')}</h1>
        <div className="settings">
          {rows.map(([k, el]) => <div className="setting-row" key={k}><span>{t(`battle.setup.${k}`)}</span>{el}</div>)}
        </div>
        <p className="sub">{t('battle.setup.estimate', { min, max, squads, vehicles })}</p>
        <div className="pause-buttons">
          <button className="go secondary" onClick={onBack}>{t('battle.setup.back')}</button>
          <button className="go" onClick={onDeploy}>{t('battle.setup.deploy')} ▶</button>
        </div>
      </div>
    </div>
  );
}
