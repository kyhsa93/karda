import { t } from '../../content/strings';
import { MS_TO_FPM, MS_TO_KT } from '../../core/units';
import type { CrashReason, SimEvent } from '../../sim/events';
import type { Mode } from '../../sim/session';

export interface Message { text: string; color: string; life: number }

export function crashText(reason: CrashReason, value?: number) {
  return t(`crash.${reason}`, { fpm: Math.round((value ?? 0) * MS_TO_FPM), kt: Math.round((value ?? 0) * MS_TO_KT) });
}

export function eventMessage(e: SimEvent): Omit<Message, 'life'> | null {
  switch (e.t) {
    case 'engine':
      if (e.cause === 'fuel') return { text: t('msg.fuelOut'), color: '#ef476f' };
      return e.on ? { text: t('msg.engineOn'), color: '#ffd166' } : { text: t('msg.engineOff'), color: '#ef476f' };
    case 'landed':
      if (e.descent < 1) return { text: t('msg.landedSoft'), color: '#06d6a0' };
      if (e.descent > 2.2) return { text: t('msg.landedHard'), color: '#ffd166' };
      return { text: t('msg.landed'), color: '#ffd166' };
    case 'refuel': return { text: t('msg.refuel'), color: '#4cc9f0' };
    case 'boundary': return { text: t('msg.boundary'), color: '#ef476f' };
    case 'zone': return e.inside ? { text: t('msg.zoneIn'), color: '#06d6a0' } : { text: t('msg.zoneOut', { s: Math.ceil(e.seconds) }), color: '#ef476f' };
    case 'advice':
      return { text: t(`advice.${e.code}`, { fpm: Math.round(e.value ?? 0), max: 500 }), color: '#ffd166' };
    case 'missileLost':
      return e.owner === 0 ? { text: t(`msg.missileLost.${e.reason}`), color: '#ef476f' } : null;
    case 'identified':
      return { text: t('msg.identified', { name: t(`units.${e.defId}`), side: t(`sides.${e.side}`) }), color: e.side === 'veros' ? '#ffd166' : '#4cc9f0' };
    case 'systemDamaged':
      return { text: t(`msg.system.${e.level}`, { name: t(`systems.${e.system}`) }), color: e.level === 'destroyed' ? '#ef476f' : '#ffd166' };
    case 'detected': case 'radarTrack': case 'playerHit': case 'missileWarning': case 'missileEnd': case 'countermeasure': case 'radio': return null;
    case 'fcr':
      return { text: t(`msg.fcr.${e.state}`, { n: e.count, mode: t(`msg.fcr.${e.mode}`) }), color: e.state === 'scan' ? '#ffd166' : '#4cc9f0' };
    case 'farp':
      return { text: t(`msg.farp.${e.state}`), color: e.state === 'cancelled' ? '#ef476f' : '#4cc9f0' };
    case 'objective': case 'pointOwner': case 'battleEnd': case 'memberHit': case 'spotted': return null;
    case 'crash': case 'unitDestroyed': case 'explosion': case 'fire': case 'impact': return null;
  }
}

export class MessageLog {
  items: Message[] = [];

  push(m: Omit<Message, 'life'>) {
    if (this.items.some(x => x.text === m.text)) return;
    this.items.push({ ...m, life: 3 });
    if (this.items.length > 4) this.items.shift();
  }

  tick(simDt: number) {
    for (const m of this.items) m.life -= simDt;
    this.items = this.items.filter(m => m.life > 0);
  }

  follow(mode: Mode) {
    if (mode !== 'play' && mode !== 'crashed') this.clear();
  }

  clear() {
    this.items = [];
  }
}
