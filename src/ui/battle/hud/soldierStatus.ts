import { t } from '../../../content/strings';
import { CLASS_KITS } from '../../../sim/infantry/arms';
import type { World } from '../../../sim/world';

type Soldier = Pick<World, 'soldier' | 'soldierArms' | 'soldierGear' | 'time'>;

function launcher(w: Soldier) {
  const a = w.soldierArms, id = a.ammo.grenade ? 'grenade' : a.ammo.at_rocket ? 'at_rocket' : null;
  const m = id && a.ammo[id];
  return id && m ? { id, n: m.mag + m.reserve } : null;
}

function medkitState(w: Soldier) {
  const g = w.soldierGear;
  if (g.medkit) return t('battle.hud.medkitActive', { n: Math.ceil(g.medkit.until - w.time) });
  if (w.time < g.readyAt) return t('battle.hud.medkitWait', { n: Math.ceil(g.readyAt - w.time) });
  return t('battle.hud.medkitReady');
}

const hot = (w: Soldier) => w.soldierGear.overheatUntil > w.time;
const hotText = (w: Soldier) => t('battle.hud.repairHot', { n: Math.ceil(w.soldierGear.overheatUntil - w.time) });

export function statusLines(w: Soldier, touch: boolean) {
  const s = w.soldier!, a = w.soldierArms, m = a.ammo[a.selected]!, g = w.soldierGear;
  const first = {
    hp: t('battle.hud.hp', { n: Math.ceil(s.hp) }),
    low: s.hp < 35,
    ammo: `${t(`battle.hud.weapon.${a.selected}`)} ${a.reloading > 0 ? t('battle.hud.reloading') : `${m.mag} / ${m.reserve}`}`,
    stance: !touch && s.stance !== 'stand' ? t(`battle.hud.stance.${s.stance}`) : null,
  };
  if (touch) return { first, gear: [] };
  const l = launcher(w), gear: string[] = [];
  if (l && a.selected !== l.id) gear.push(`${t(`battle.hud.weapon.${l.id}`)} ${l.n}`);
  if (g.medkitLeft > 0) gear.push(t('battle.hud.medkit', { state: medkitState(w) }));
  if (g.repairable) gear.push(t('battle.hud.repair', { state: hot(w) ? hotText(w) : g.repairing ? t('battle.hud.repairing') : t('battle.hud.medkitReady') }));
  if (g.mineLeft > 0 || g.mines.length > 0) gear.push(t('battle.hud.mine', { n: g.mineLeft }));
  if (g.smokeLeft > 0) gear.push(t('battle.hud.smoke', { n: g.smokeLeft }));
  return { first, gear };
}

export function gearButtons(w: Soldier) {
  const a = w.soldierArms, g = w.soldierGear, primary = CLASS_KITS[w.soldier?.cls ?? 'assault'].primary, l = launcher(w);
  const swap = a.selected !== primary ? t('touch.toRifle') : `${t(a.ammo.at_rocket ? 'touch.toRocket' : 'touch.toGrenade')}${l ? ` ${l.n}` : ''}`;
  return {
    swap,
    medkit: g.medkitLeft > 0 ? `${t('touch.medkit')} ${medkitState(w)}` : null,
    repair: g.repairable ? hot(w) ? `${t('touch.repair')} ${hotText(w)}` : t('touch.repair') : null,
    mine: g.mineLeft > 0 ? `${t('touch.mine')} ${g.mineLeft}` : null,
    smoke: g.smokeLeft > 0 ? `${t('touch.smoke')} ${g.smokeLeft}` : null,
  };
}
