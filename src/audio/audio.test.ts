import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GameAudio } from './game';
import { SfxPlayer, SOUND_SPEED } from './sfx';
import { FakeParam, fakeCtx } from './testing';


type Ctx = ReturnType<typeof fakeCtx>;
const asCtx = (c: Ctx) => c as unknown as AudioContext;

describe('SfxPlayer', () => {
  it('plays the gun sample for the player, at most every 85 ms', () => {
    const c = fakeCtx();
    const gun = c.createBuffer(1, 100, 22050);
    const sfx = new SfxPlayer(asCtx(c), c.destination as unknown as AudioNode, { gun_shot: gun as unknown as AudioBuffer });
    const fire = { t: 'fire' as const, weapon: 'gun30', pos: new Vector3(), dir: new Vector3(0, 0, -1), owner: 0, tracer: false };
    sfx.onEvent(fire, new Vector3());
    sfx.onEvent(fire, new Vector3());
    expect(c.started).toHaveLength(1);
    expect(c.started[0].buffer).toBe(gun);
    c.currentTime += 0.1;
    sfx.onEvent(fire, new Vector3());
    expect(c.started).toHaveLength(2);
    sfx.onEvent({ ...fire, owner: 7 }, new Vector3());
    expect(c.started).toHaveLength(2);
  });

  it('plays the rocket launch sample for each player rocket, without the gun throttle', () => {
    const c = fakeCtx();
    const rocket = c.createBuffer(1, 100, 22050);
    const sfx = new SfxPlayer(asCtx(c), c.destination as unknown as AudioNode, { rocket_launch: rocket as unknown as AudioBuffer });
    const fire = { t: 'fire' as const, weapon: 'hydra70', pos: new Vector3(), dir: new Vector3(0, 0, -1), owner: 0, tracer: true };
    sfx.onEvent(fire, new Vector3());
    sfx.onEvent(fire, new Vector3());
    expect(c.started).toHaveLength(2);
    expect(c.started.every(s => s.buffer === rocket)).toBe(true);
  });

  it('delays distant explosions by the speed of sound', () => {
    const c = fakeCtx();
    const sfx = new SfxPlayer(asCtx(c), c.destination as unknown as AudioNode, {}, () => 0.1);
    sfx.onEvent({ t: 'explosion', pos: new Vector3(680, 0, 0), size: 6 }, new Vector3());
    expect(c.started[0].when).toBeCloseTo(10 + 680 / SOUND_SPEED, 5);
  });

  it('falls back to synthesised noise when a sample is missing', () => {
    const c = fakeCtx();
    const sfx = new SfxPlayer(asCtx(c), c.destination as unknown as AudioNode);
    sfx.onEvent({ t: 'impact', weapon: 'gun30', pos: new Vector3(10, 0, 0), ground: true }, new Vector3());
    expect(c.started).toHaveLength(1);
    expect(c.started[0].buffer).toBeTruthy();
  });

  it('ignores impacts too far away to hear', () => {
    const c = fakeCtx();
    const sfx = new SfxPlayer(asCtx(c), c.destination as unknown as AudioNode);
    sfx.onEvent({ t: 'impact', weapon: 'gun30', pos: new Vector3(4000, 0, 0), ground: true }, new Vector3());
    expect(c.started).toHaveLength(0);
  });
});

describe('GameAudio', () => {
  it('switches the rotor to the recording once decoded and plays the engine start clip', async () => {
    const c = fakeCtx();
    const audio = new GameAudio(asCtx(c));
    expect(audio.rotor.usingRecording).toBe(false);
    await audio.loadSamples(id => (id === 'audio.rotor_loop' || id === 'audio.engine_start' ? new ArrayBuffer(8) : undefined));
    expect(audio.rotor.usingRecording).toBe(true);
    const before = c.started.length;
    audio.onEvent({ t: 'engine', on: true }, new Vector3());
    expect(c.started.length).toBe(before + 1);
  });

  it('counts a suspended or interrupted context as suspended, not a running or closed one (#239)', () => {
    const c = fakeCtx() as Ctx & { state?: string };
    const audio = new GameAudio(asCtx(c));
    for (const [state, want] of [['suspended', true], ['interrupted', true], ['running', false], ['closed', false]] as const) {
      c.state = state;
      expect(audio.suspended).toBe(want);
    }
  });

  it('raises the loop pitch with rotor rpm', async () => {
    const c = fakeCtx();
    const audio = new GameAudio(asCtx(c));
    await audio.loadSamples(id => (id === 'audio.rotor_loop' ? new ArrayBuffer(8) : undefined));
    const loop = (audio.rotor as unknown as { loop: { src: { playbackRate: FakeParam } } }).loop;
    audio.update({ rpm: 0.2, collective: 0, airspeed: 0, warn: false });
    const low = loop.src.playbackRate.value;
    audio.update({ rpm: 1, collective: 0.6, airspeed: 0, warn: false });
    expect(loop.src.playbackRate.value).toBeGreaterThan(low);
    expect(loop.src.playbackRate.value).toBeCloseTo(1, 5);
  });
});
