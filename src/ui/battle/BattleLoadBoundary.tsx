import { Component, useCallback, useState, type ReactNode } from 'react';
import { t } from '../../content/strings';

export function useRaiseInRender() {
  const [, set] = useState(0);
  return useCallback((error: unknown) => set(() => { throw error; }), []);
}

export class BattleLoadBoundary extends Component<{ children: ReactNode; strings?: 'battle.loadError' | 'battle.matchError' }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { strings = 'battle.loadError' } = this.props;
    return (
      <div className="menu">
        <div className="card" role="alert">
          <p className="sub">{t(`${strings}.text`)}</p>
          <div className="pause-buttons">
            <button className="go" onClick={() => window.location.reload()}>{t(`${strings}.retry`)}</button>
          </div>
        </div>
      </div>
    );
  }
}
