import { useEffect, useState } from 'react';
import { t } from '../../content/strings';

export const STALL_MS = 20_000;

export function StallNotice({ since }: { since?: number }) {
  const [start] = useState(() => since ?? Date.now());
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setStalled(true), Math.max(0, start + STALL_MS - Date.now()));
    return () => clearTimeout(id);
  }, [start]);
  if (!stalled) return null;
  return (
    <div className="stall" role="alert">
      <p className="sub">{t('loading.stalled')}</p>
      <div className="pause-buttons">
        <button className="go" onClick={() => window.location.reload()}>{t('loading.retry')}</button>
      </div>
    </div>
  );
}
