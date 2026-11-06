import type { SystemId } from './heli/damage';
import type { Vector3 } from 'three';
import type { Side } from './units';

export type CrashReason =
  | 'rotorStrike' | 'terrain' | 'water' | 'tree' | 'building'
  | 'ditched' | 'hardLanding' | 'slideLanding' | 'tiltLanding' | 'slope' | 'rotorLoss' | 'crewKilled' | 'outOfBounds' | 'killed' | 'fall';

export type SimEvent =
  | { t: 'crash'; reason: CrashReason; value?: number }
  | { t: 'zone'; inside: boolean; seconds: number }
  | { t: 'memberHit'; unit: number; killed: boolean; byPlayer: boolean }
  | { t: 'unitHit'; unit: number }
  | { t: 'spotted'; id: number }
  | { t: 'pointOwner'; id: string; owner: 'coalition' | 'veros' | 'neutral'; from: 'coalition' | 'veros' | 'neutral' }
  | { t: 'battleEnd'; winner: 'coalition' | 'veros' | 'draw'; reason: 'tickets' | 'time' }
  | { t: 'landed'; descent: number }
  | { t: 'engine'; on: boolean; cause?: 'fuel' | 'damage' }
  | { t: 'refuel' }
  | { t: 'boundary' }
  | { t: 'objective'; id: string; state: 'done' | 'failed'; reason?: string }
  | { t: 'missileLost'; id: number; owner: number; reason: 'spotLost' | 'noLock' }
  | { t: 'unitDestroyed'; id: number; defId: string; side: Side; byPlayer: boolean; by?: number }
  | { t: 'explosion'; pos: Vector3; size: number }
  | { t: 'fire'; weapon: string; pos: Vector3; dir: Vector3; owner: number; tracer: boolean }
  | { t: 'impact'; weapon: string; pos: Vector3; unit?: number; ground: boolean; missile?: number }
  | { t: 'advice'; code: AdviceCode; value?: number }
  | { t: 'identified'; id: number; defId: string; side: Side }
  | { t: 'detected'; id: number; by: 'visual' | 'radar' }
  | { t: 'radarTrack'; id: number; on: boolean }
  | { t: 'fcr'; state: 'scan' | 'done' | 'mode'; mode: 'ground' | 'air'; count: number }
  | { t: 'playerHit'; by: number; weapon: string; damage: number }
  | { t: 'systemDamaged'; system: SystemId; level: 'damaged' | 'destroyed' }
  | { t: 'missileWarning'; id: number; kind: 'ir' | 'radar'; from: Vector3; owner: number }
  | { t: 'missileEnd'; id: number; hit: boolean }
  | { t: 'radio'; from: string; text: string }
  | { t: 'countermeasure'; kind: 'flare' | 'chaff'; decoyed: number; auto: boolean }
  | { t: 'farp'; state: 'started' | 'done' | 'cancelled'; repair: number; rearm: number };

export type AdviceCode = 'landingTooHard' | 'wrongPad' | 'tooHigh';

export type Emit = (e: SimEvent) => void;
