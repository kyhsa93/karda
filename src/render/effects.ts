import * as THREE from 'three';
import type { SimEvent } from '../sim/events';
import type { World } from '../sim/world';

export const CELL = {
  explosion: [0, 1, 2, 3], smoke: [4, 5, 6, 7], dust: [8, 9, 10, 11], flash: 12, muzzle: 13, spark: 14, fire: 15,
} as const;

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size0: number;
  size1: number;
  alpha: number;
  cell: number;
  rise: number;
  drag: number;
}

class ParticleLayer {
  readonly points: THREE.Points;
  private parts: Particle[];
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private cell: Float32Array;
  private cursor = 0;

  constructor(readonly capacity: number, material: THREE.ShaderMaterial) {
    this.parts = Array.from({ length: capacity }, () => ({
      alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 1, size0: 1, size1: 1, alpha: 1, cell: 0, rise: 0, drag: 0,
    }));
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.cell = new Float32Array(capacity);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('cell', new THREE.BufferAttribute(this.cell, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, capacity);
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  get active() {
    let n = 0;
    for (const p of this.parts) if (p.alive) n++;
    return n;
  }

  spawn(at: THREE.Vector3, vel: THREE.Vector3, life: number, size0: number, size1: number, alpha: number, cell: number, rise = 0, drag = 1) {
    const p = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    p.alive = true; p.pos.copy(at); p.vel.copy(vel); p.life = life; p.max = life;
    p.size0 = size0; p.size1 = size1; p.alpha = alpha; p.cell = cell; p.rise = rise; p.drag = drag;
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.parts[i];
      if (p.alive) {
        p.life -= dt;
        if (p.life <= 0) p.alive = false;
        else {
          p.vel.multiplyScalar(Math.exp(-p.drag * dt));
          p.vel.y += p.rise * dt;
          p.pos.addScaledVector(p.vel, dt);
        }
      }
      const k = p.alive ? 1 - p.life / p.max : 1;
      this.pos[i * 3] = p.pos.x; this.pos[i * 3 + 1] = p.pos.y; this.pos[i * 3 + 2] = p.pos.z;
      this.size[i] = p.alive ? p.size0 + (p.size1 - p.size0) * k : 0;
      this.alpha[i] = p.alive ? p.alpha * (1 - k) : 0;
      this.cell[i] = p.cell;
    }
    const g = this.points.geometry;
    for (const name of ['position', 'size', 'alpha', 'cell']) (g.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }
}

function material(map: THREE.Texture, additive: boolean) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { map: { value: map }, scale: { value: 400 } },
    vertexShader: `
      attribute float size; attribute float alpha; attribute float cell;
      uniform float scale;
      varying float vAlpha; varying vec2 vCell;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vAlpha = alpha;
        vCell = vec2(mod(cell, 4.0), floor(cell / 4.0));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / max(0.1, -mv.z);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying float vAlpha; varying vec2 vCell;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 uv = (vCell + vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y)) / 4.0;
        uv.y = 1.0 - uv.y;
        vec4 c = texture2D(map, uv);
        if (c.a * vAlpha < 0.01) discard;
        gl_FragColor = vec4(c.rgb, c.a * vAlpha);
      }`,
  });
}

export function fallbackAtlas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d')!;
  const colors = ['#ffb040', '#404040', '#e8e8e8', '#fff2b0'];
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * 64 + 32, y = Math.floor(i / 4) * 64 + 32;
    const grad = g.createRadialGradient(x, y, 0, x, y, 30);
    grad.addColorStop(0, colors[Math.floor(i / 4)]);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - 32, y - 32, 64, 64);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Burning { pos: THREE.Vector3; time: number; acc: number; size: number }

export const BURN_SECONDS = 30;
export const ENEMY_TRACER_SPEED = 900;

export class Effects {
  readonly group = new THREE.Group();
  readonly glow: ParticleLayer;
  readonly smoke: ParticleLayer;
  private tracers: THREE.LineSegments;
  private tracerPos: Float32Array;
  private burning: Burning[] = [];
  private enemyTracers: { pos: THREE.Vector3; vel: THREE.Vector3; life: number }[] = [];
  private missileMesh: THREE.InstancedMesh;
  private mm = new THREE.Matrix4();
  private mq = new THREE.Quaternion();
  private mz = new THREE.Vector3(0, 1, 0);
  private one = new THREE.Vector3(1, 1, 1);
  private rnd = Math.random;
  private cloudAcc = 0;

  constructor(map: THREE.Texture, readonly maxTracers = 128) {
    this.glow = new ParticleLayer(384, material(map, true));
    this.smoke = new ParticleLayer(512, material(map, false));
    this.group.add(this.smoke.points, this.glow.points);
    this.tracerPos = new Float32Array(maxTracers * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracers = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tracers.frustumCulled = false;
    this.group.add(this.tracers);
    const body = new THREE.CylinderGeometry(0.09, 0.09, 1.6, 8);
    this.missileMesh = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ color: 0x5a5f55 }), 24);
    this.missileMesh.count = 0;
    this.missileMesh.frustumCulled = false;
    this.group.add(this.missileMesh);
  }

  setScale(viewportHeight: number, fovDeg: number) {
    const s = viewportHeight / (2 * Math.tan(fovDeg * Math.PI / 360));
    for (const l of [this.glow, this.smoke]) (l.points.material as THREE.ShaderMaterial).uniforms.scale.value = s;
  }

  get burningCount() { return this.burning.length; }

  private jitter(scale: number) {
    return new THREE.Vector3((this.rnd() - 0.5) * scale, (this.rnd() - 0.5) * scale, (this.rnd() - 0.5) * scale);
  }

  onEvent(e: SimEvent, world: World) {
    switch (e.t) {
      case 'fire':
        if (e.weapon === 'agm114k' || e.weapon === 'agm114l' || e.weapon === 'stinger') {
          this.glow.spawn(e.pos, new THREE.Vector3(), 0.15, 3, 4.5, 1, CELL.flash);
          for (let i = 0; i < 5; i++) this.smoke.spawn(e.pos.clone().add(this.jitter(1.5)), e.dir.clone().multiplyScalar(-8).add(this.jitter(3)), 2.5, 2, 7, 0.55, CELL.dust[i % 4], 0.5, 1.2);
          break;
        }
        if (e.weapon === 'hydra70') {
          this.glow.spawn(e.pos, new THREE.Vector3(), 0.12, 2.5, 3.5, 1, CELL.flash);
          for (let i = 0; i < 3; i++) this.smoke.spawn(e.pos.clone().add(this.jitter(1)), e.dir.clone().multiplyScalar(-6).add(this.jitter(2)), 1.8, 1.5, 5, 0.5, CELL.smoke[i], 0.6, 1.5);
          break;
        }
        this.glow.spawn(e.pos, new THREE.Vector3(), 0.05, 1.6, 2.2, 1, CELL.muzzle);
        if (e.owner !== 0 && e.tracer && this.enemyTracers.length < 64) {
          const range = e.pos.distanceTo(world.player.pos) + 200;
          this.enemyTracers.push({ pos: e.pos.clone(), vel: e.dir.clone().multiplyScalar(ENEMY_TRACER_SPEED), life: range / ENEMY_TRACER_SPEED });
        }
        if (this.rnd() < 0.3) this.smoke.spawn(e.pos, e.dir.clone().multiplyScalar(4), 0.8, 1, 3, 0.25, CELL.dust[0], 0.5, 2);
        break;
      case 'impact': {
        if (e.ground) {
          this.smoke.spawn(e.pos, new THREE.Vector3(0, 3, 0), 1.2, 1.5, 5, 0.7, CELL.dust[(this.rnd() * 4) | 0], 1, 1.5);
        } else {
          this.glow.spawn(e.pos, new THREE.Vector3(), 0.08, 1.2, 1.8, 1, CELL.flash);
        }
        for (let i = 0; i < 2; i++) this.glow.spawn(e.pos, this.jitter(20).setY(Math.abs(this.rnd() * 12)), 0.25, 0.5, 0.3, 1, CELL.spark, -9.8, 0.5);
        break;
      }
      case 'explosion': {
        const s = Math.max(2, e.size);
        for (let i = 0; i < 3; i++) this.glow.spawn(e.pos.clone().add(this.jitter(s * 0.5)), this.jitter(s), 0.5 + i * 0.15, s * 0.8, s * 2.2, 1, CELL.explosion[i]);
        for (let i = 0; i < 4; i++) this.smoke.spawn(e.pos.clone().add(this.jitter(s * 0.6)), this.jitter(s * 0.6).setY(s * 0.4), 2.5 + this.rnd() * 1.5, s, s * 3, 0.8, CELL.smoke[i], 1.5, 0.8);
        break;
      }
      case 'unitDestroyed': {
        const u = world.unit(e.id);
        if (u) this.burning.push({ pos: u.pos.clone().setY(u.pos.y + u.def.size[1] * 0.6), time: BURN_SECONDS, acc: 0, size: Math.max(u.def.size[0], u.def.size[2]) * 0.5 });
        break;
      }
      default: break;
    }
  }

  update(dt: number, world: World) {
    for (let i = this.burning.length - 1; i >= 0; i--) {
      const b = this.burning[i];
      b.time -= dt; b.acc += dt;
      if (b.time <= 0) { this.burning.splice(i, 1); continue; }
      while (b.acc > 0.25) {
        b.acc -= 0.25;
        const fade = Math.min(1, b.time / 8);
        this.smoke.spawn(b.pos.clone().add(this.jitter(b.size)), new THREE.Vector3((this.rnd() - 0.5), 2 + this.rnd() * 2, (this.rnd() - 0.5)), 4, b.size, b.size * 4, 0.7 * fade, CELL.smoke[(this.rnd() * 4) | 0], 0.8, 0.3);
        if (this.rnd() < 0.6 * fade) this.glow.spawn(b.pos.clone().add(this.jitter(b.size * 0.6)), new THREE.Vector3(0, 1.5, 0), 0.6, b.size * 0.8, b.size * 0.4, 0.9, CELL.fire);
      }
    }
    this.cloudAcc += dt;
    while (this.cloudAcc > 0.2) {
      this.cloudAcc -= 0.2;
      const gear = world.soldierGear;
      for (const c of gear.clouds) {
        const fade = Math.min(1, (c.until - world.time) / 4);
        for (let i = 0; i < 3; i++) this.smoke.spawn(new THREE.Vector3(c.x, c.y + 1, c.z).add(this.jitter(c.r * 1.2)), this.jitter(0.6), 5, c.r * 0.5, c.r * 0.7, 0.55 * fade, CELL.dust[(this.rnd() * 4) | 0], 0.1, 0.2);
      }
      if (gear.medkit) this.glow.spawn(gear.medkit.pos.clone().setY(gear.medkit.pos.y + 0.6), new THREE.Vector3(0, 0.6, 0), 0.9, 0.5, 0.3, 0.7, CELL.flash);
    }
    for (const p of world.projectiles) {
      if (!p.burn || p.burn <= 0) continue;
      this.glow.spawn(p.pos, new THREE.Vector3(), 0.04, 1.2, 0.6, 1, CELL.fire);
      const n = Math.min(6, Math.ceil(p.vel.length() * dt / 8));
      for (let i = 0; i < n; i++) {
        const at = p.pos.clone().addScaledVector(p.vel, -dt * (i + this.rnd()) / n);
        this.smoke.spawn(at, this.jitter(1.5), 1.6 + this.rnd(), 0.8, 3.5, 0.5, CELL.dust[(this.rnd() * 4) | 0], 0.4, 1);
      }
    }
    for (const f of world.flares) {
      this.glow.spawn(f.pos, new THREE.Vector3(), 0.06, 3, 2, 1, CELL.flash);
      this.smoke.spawn(f.pos, this.jitter(1), 1.8, 0.8, 3, 0.5, CELL.dust[(this.rnd() * 4) | 0], 0.5, 1);
    }
    let mi = 0;
    for (const m of [...world.enemyMissiles, ...world.aams]) {
      if (mi < 24) {
        this.mq.setFromUnitVectors(this.mz, m.vel.clone().normalize());
        this.missileMesh.setMatrixAt(mi++, this.mm.compose(m.pos, this.mq, this.one));
      }
      if (m.age > 6) continue;
      this.glow.spawn(m.pos, new THREE.Vector3(), 0.05, 1.2, 0.6, 1, CELL.fire);
      const n = Math.min(8, Math.ceil(m.vel.length() * dt / 6));
      for (let i = 0; i < n; i++) {
        const at = m.pos.clone().addScaledVector(m.vel, -dt * (i + this.rnd()) / n);
        this.smoke.spawn(at, this.jitter(1.2), 2.5 + this.rnd(), 1, 5, 0.6, CELL.dust[(this.rnd() * 4) | 0], 0.3, 1);
      }
    }
    for (const m of world.missiles) {
      if (mi < 24) {
        this.mq.setFromUnitVectors(this.mz, m.vel.clone().normalize());
        this.missileMesh.setMatrixAt(mi++, this.mm.compose(m.pos, this.mq, this.one));
      }
      if (m.phase === 'lost') continue;
      this.glow.spawn(m.pos, new THREE.Vector3(), 0.05, 1.4, 0.7, 1, CELL.fire);
      const n = Math.min(8, Math.ceil(m.vel.length() * dt / 6));
      for (let i = 0; i < n; i++) {
        const at = m.pos.clone().addScaledVector(m.vel, -dt * (i + this.rnd()) / n);
        this.smoke.spawn(at, this.jitter(1.2), 2.2 + this.rnd(), 1, 4.5, 0.55, CELL.dust[(this.rnd() * 4) | 0], 0.3, 1);
      }
    }
    this.missileMesh.count = mi;
    this.missileMesh.instanceMatrix.needsUpdate = true;
    this.glow.update(dt);
    this.smoke.update(dt);

    let n = 0;
    for (const p of world.projectiles) {
      if (!p.tracer || n >= this.maxTracers) continue;
      const tail = p.pos.clone().addScaledVector(p.vel, -0.025);
      this.tracerPos.set([p.pos.x, p.pos.y, p.pos.z, tail.x, tail.y, tail.z], n * 6);
      n++;
    }
    for (let i = this.enemyTracers.length - 1; i >= 0; i--) {
      const t = this.enemyTracers[i];
      t.life -= dt;
      t.pos.addScaledVector(t.vel, dt);
      if (t.life <= 0) { this.enemyTracers.splice(i, 1); continue; }
      if (n >= this.maxTracers) continue;
      const tail = t.pos.clone().addScaledVector(t.vel, -0.03);
      this.tracerPos.set([t.pos.x, t.pos.y, t.pos.z, tail.x, tail.y, tail.z], n * 6);
      n++;
    }
    const g = this.tracers.geometry;
    g.setDrawRange(0, n * 2);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  get activeParticles() { return this.glow.active + this.smoke.active; }
  get capacity() { return this.glow.capacity + this.smoke.capacity; }

  dispose() {
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
