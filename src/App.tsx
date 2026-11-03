import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { assets } from './assets/loader';
import { BOOT_GROUP } from './assets/manifest';
import { Credits } from './ui/screens/Credits';
import { Loading } from './ui/screens/Loading';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { Title } from './ui/screens/Title';
import { BattleLoadBoundary, useRaiseInRender } from './ui/battle/BattleLoadBoundary';
import { BattleSetup, loadChoice, storeChoice, type BattleChoice } from './ui/battle/BattleSetup';
import { isBattleRoute, UiState } from './ui/state';
import { hasSave, loadSave, storeSave, withDeviceDefaults, withFirstRun } from './save/save';

const loadBattleScreen = () => import('./ui/battle/Battle');
const Battle = lazy(() => loadBattleScreen().then(m => ({ default: m.Battle })));

function BattleCheck({ onReady }: { onReady: () => void }) {
  const raise = useRaiseInRender();
  useEffect(() => {
    let alive = true;
    loadBattleScreen().then(m => m.checkBattleLoads()).then(() => { if (alive) onReady(); }, error => { if (alive) raise(error); });
    return () => { alive = false; };
  }, [onReady, raise]);
  return <Loading progress={1} />;
}

export function App() {
  const [ui] = useState(() => new UiState());
  const screen = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
  const [save, setSave] = useState(() => (hasSave() ? loadSave() : withDeviceDefaults(withFirstRun(loadSave()), { mobile: window.matchMedia('(pointer: coarse)').matches || Math.min(window.screen.width, window.screen.height) < 600 })));
  useEffect(() => { storeSave(save); }, [save]);
  const [choice, setChoice] = useState<BattleChoice>(() => loadChoice());
  useEffect(() => { storeChoice(choice); }, [choice]);
  const [returning, setReturning] = useState(() => isBattleRoute(window.location.hash));
  const settled = useCallback(() => setReturning(false), []);
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const [boot, setBoot] = useState(0);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let alive = true;
    void assets.loadGroup(BOOT_GROUP, f => { if (alive) setBoot(f); }).then(() => { if (alive) setBooted(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const hashchange = () => ui.syncFromLocation();
    window.addEventListener('hashchange', hashchange);
    return () => window.removeEventListener('hashchange', hashchange);
  }, [ui]);

  if (!booted) return <Loading progress={boot} />;

  switch (screen.name) {
    case 'title':
      return <Title onBattle={() => ui.go({ name: 'battleSetup' })} onSettings={() => ui.go({ name: 'settings' })} onCredits={() => ui.go({ name: 'credits' })} />;
    case 'settings':
      return <SettingsScreen settings={save.settings} onChange={settings => setSave(prev => ({ ...prev, settings }))} onCredits={() => ui.go({ name: 'credits' })} onBack={() => ui.go({ name: 'title' })} />;
    case 'credits':
      return <Credits onBack={() => ui.go({ name: 'title' })} />;
    case 'battleSetup':
      if (returning) return <BattleLoadBoundary><BattleCheck onReady={settled} /></BattleLoadBoundary>;
      return <BattleSetup choice={choice} settings={save.settings} onChoice={setChoice} onDifficulty={difficulty => setSave(prev => ({ ...prev, settings: { ...prev.settings, difficulty } }))} onDeploy={() => ui.go({ name: 'battle', map: choice.map, mode: choice.mode })} onBack={() => ui.go({ name: 'title' })} />;
    case 'battle':
      return <BattleLoadBoundary><Suspense fallback={<Loading progress={1} />}><Battle choice={choice} touch={touch} settings={save.settings} onSettings={settings => setSave(prev => ({ ...prev, settings }))} onSetup={() => ui.go({ name: 'battleSetup' })} onTitle={() => ui.go({ name: 'title' })} tips={save.tips} onTip={id => setSave(prev => prev.tips.includes(id) ? prev : { ...prev, tips: [...prev.tips, id] })} /></Suspense></BattleLoadBoundary>;
  }
}
