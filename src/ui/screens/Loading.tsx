import { t } from '../../content/strings';
import { StallNotice } from './StallNotice';

export function Loading({ progress, since }: { progress: number; since?: number }) {
  return (
    <div className="menu">
      <div className="card loading">
        <p className="sub">{t('loading.text')}</p>
        <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        <StallNotice since={since} />
      </div>
    </div>
  );
}
