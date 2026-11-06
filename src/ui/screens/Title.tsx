import { t } from '../../content/strings';

export function Title({ onQuick, onBattle, onSettings, onCredits }: { onQuick: () => void; onBattle: () => void; onSettings: () => void; onCredits: () => void }) {
  return (
    <div className="menu">
      <div className="card">
        <h1 className="game-title">{t('title.name')}<small>{t('title.subtitle')}</small></h1>
        <div className="title-modes">
          <button className="mode primary quick" onClick={onQuick}><span className="mode-label"><b>{t('title.quick')}</b><span>{t('title.quickSub')}</span></span></button>
          <button className="mode" onClick={onBattle}><span className="mode-label"><b>{t('title.battle')}</b><span>{t('title.battleSub')}</span></span></button>
        </div>
        <button className="mode" onClick={onSettings}><b>{t('title.settings')}</b></button>
        <button className="go secondary credits-link" onClick={onCredits}>{t('credits.open')}</button>
      </div>
    </div>
  );
}
