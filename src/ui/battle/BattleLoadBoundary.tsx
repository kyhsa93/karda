import { Component, useCallback, useState, type ReactNode } from 'react';
import { t } from '../../content/strings';

export function useRaiseInRender() {
  const [, set] = useState(0);
  return useCallback((error: unknown) => set(() => { throw error; }), []);
}

export class BattleLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="menu">
        <div className="card" role="alert">
          <p className="sub">{t('battle.loadError.text')}</p>
          <div className="pause-buttons">
            <button className="go" onClick={() => window.location.reload()}>{t('battle.loadError.retry')}</button>
          </div>
        </div>
      </div>
    );
  }
}
