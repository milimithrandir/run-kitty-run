import * as THREE from 'three';
import { drawMane, faceFill, stars } from './caticon.js';

// effects.js — pooled particle / shockwave / beam / floating-text effects.
// Notes on interpretation:
//  - Effects never call shake() themselves; the game decides how much trauma each event adds.
//  - getShakeOffset() returns a reused object (do not keep a reference across frames).
//  - Colors may be a hex number, CSS string or THREE.Color.
//  - burst(): spread 0..1 = cone half-angle as a fraction of PI around +Y (1 = full sphere). gravity is
//    signed (negative pulls down). size = world-unit diameter.

// ---------- particle record layout (struct-of-floats, stride S) ----------
const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7, S0 = 8, S1 = 9,
  GRAV = 10, DRAG = 11, CR = 12, CG = 13, CB = 14, A0 = 15, ROT = 16, SPIN = 17, PH = 18, FREQ = 19,
  SHAPE = 20, OX = 21, OZ = 22, OMEGA = 23;
const S = 24;
const SHIELD_LEAVES = [[0.86, 0.42, 0.16], [0.76, 0.26, 0.14], [0.9, 0.6, 0.2], [0.82, 0.7, 0.28]];   // shieldPop: autumn leaf colours (0..1)
const SHAPE_ROUND = 0, SHAPE_TWINKLE = 1, SHAPE_RECT = 2, SHAPE_HEART = 3, SHAPE_FISH = 4, SHAPE_STAR = 5, SHAPE_SPARKLE = 6;

const TAU = Math.PI * 2;
const rand = Math.random;
const rr = (a, b) => a + (b - a) * rand();

const P_VERT = /* glsl */`
attribute vec3 aColor;
attribute vec4 aParams;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vRot;
varying float vSquash;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aParams.x * uScale / max(-mv.z, 0.05);
  vAlpha = aParams.y * clamp(px, 0.0, 1.0);
  gl_PointSize = clamp(px, 1.0, 256.0);
  vColor = aColor;
  vRot = vec2(cos(aParams.z), sin(aParams.z));
  vSquash = aParams.w;
}`;

const P_FRAG = /* glsl */`
uniform float uCore;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vRot;
varying float vSquash;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a;
  vec3 c;
  if (vSquash < -2.5) {
    // a star of space (SHAPE_SPARKLE): a bright white core, four thin rays that taper off, a soft glow; turning slowly
    vec2 q = vec2(vRot.x * p.x - vRot.y * p.y, vRot.y * p.x + vRot.x * p.y) * 2.0;
    float r = length(q);
    if (r > 1.0) discard;
    float w = 0.012 + 0.11 * (1.0 - r);
    float rays = max(1.0 - smoothstep(0.0, w, abs(q.x)), 1.0 - smoothstep(0.0, w, abs(q.y))) * (1.0 - r);
    float core = 1.0 - smoothstep(0.06, 0.24, r);
    float halo = pow(1.0 - r, 3.0) * 0.55;
    a = max(max(rays, core), halo);
    c = mix(vColor, vec3(1.0), clamp(core * 0.9 + rays * 0.3, 0.0, 1.0));
  } else if (vSquash < -1.5) {
    // star of life (SHAPE_STAR): three crossed bars in the colour, a white staff up the middle, turning slowly
    vec2 q = vec2(vRot.x * p.x - vRot.y * p.y, vRot.y * p.x + vRot.x * p.y);
    a = 0.0;
    for (int k = 0; k < 3; k++) {
      float an = float(k) * 1.0472;
      vec2 r = vec2(cos(an) * q.x - sin(an) * q.y, sin(an) * q.x + cos(an) * q.y);
      a = max(a, (1.0 - smoothstep(0.40, 0.45, abs(r.y))) * (1.0 - smoothstep(0.10, 0.135, abs(r.x))));
    }
    // the white staff with a knob on top and the snake wound round it (head up by the knob); point-sprite y runs down
    float staff = (1.0 - smoothstep(0.016, 0.03, abs(q.x))) * (1.0 - smoothstep(0.29, 0.31, abs(q.y)));
    staff = max(staff, 1.0 - smoothstep(0.035, 0.05, length(q - vec2(0.0, -0.33))));
    float sx = sin(q.y * 21.0) * 0.075;
    float snake = (1.0 - smoothstep(0.018, 0.032, abs(q.x - sx))) * step(-0.19, q.y) * (1.0 - smoothstep(0.24, 0.26, q.y));
    snake = max(snake, 1.0 - smoothstep(0.035, 0.05, length((q - vec2(sin(-0.21 * 21.0) * 0.075, -0.21)) * vec2(0.8, 1.1))));
    c = mix(vColor, vec3(1.0), max(staff, snake));
  } else if (vSquash < 0.0) {
    // heart (SHAPE_HEART): (x^2 + y^2 - 1)^3 - x^2 y^3 <= 0, point-sprite y runs down
    vec2 q = vec2(p.x, 0.08 - p.y) * 2.7;
    float h = pow(q.x * q.x + q.y * q.y - 1.0, 3.0) - q.x * q.x * q.y * q.y * q.y;
    a = 1.0 - smoothstep(-0.04, 0.02, h);
    c = vColor;
  } else if (vSquash > 1.0) {
    // confetti fish (SHAPE_FISH): oval body + fan tail + eye, squashed by the flutter (squash = vSquash - 1)
    float sq = vSquash - 1.0;
    vec2 q = vec2(vRot.x * p.x - vRot.y * p.y, vRot.y * p.x + vRot.x * p.y);
    float sy = 0.12 + 0.88 * sq;
    vec2 b = vec2((q.x + 0.07) / 0.27, q.y / (0.15 * sy));
    float body = 1.0 - smoothstep(0.86, 1.0, length(b));
    float tw = (q.x - 0.14) * 0.85 * sy - abs(q.y);
    float tail = smoothstep(0.0, 0.02, tw) * smoothstep(0.14, 0.17, q.x) * (1.0 - smoothstep(0.40, 0.44, q.x));
    a = max(body, tail);
    float eye = 1.0 - smoothstep(0.025, 0.04, length(vec2(q.x + 0.2, q.y + 0.03 * sy)));
    c = vColor * (0.5 + 0.5 * sq) * (1.0 - 0.75 * eye * step(0.5, sq));
  } else if (vSquash > 0.0) {
    vec2 q = vec2(vRot.x * p.x - vRot.y * p.y, vRot.y * p.x + vRot.x * p.y);
    float hy = 0.22 * vSquash + 0.025;
    float ex = 1.0 - smoothstep(0.40, 0.46, abs(q.x));
    float ey = 1.0 - smoothstep(hy - 0.035, hy, abs(q.y));
    a = ex * ey;
    c = vColor * (0.5 + 0.5 * vSquash);
  } else {
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float soft = 1.0 - d;
    soft *= soft;
    float core = max(1.0 - d * 2.2, 0.0);
    a = soft + core * 0.5 * uCore;
    c = vColor + vec3(core * core * uCore);
  }
  a *= vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const RING_VERT = /* glsl */`
varying float vR;
void main() {
  vR = length(position.xy);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RING_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uInner;
varying float vR;
void main() {
  float t = (vR - uInner) / (1.0 - uInner);
  if (t < 0.0) discard;
  float a = t * t * (1.0 - smoothstep(0.8, 1.0, t));
  gl_FragColor = vec4(uColor, a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const BEAM_VERT = /* glsl */`
varying vec2 vUv;
varying float vFres;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFres = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const BEAM_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
varying float vFres;
void main() {
  float h = vUv.y;
  float fall = pow(max(1.0 - h, 0.0), 1.4); // max: pow of a negative is NaN (renders black)
  float stripes = 0.72 + 0.28 * sin(h * 28.0 - uTime * 11.0);
  float core = pow(max(vFres, 0.0), 1.6);
  float a = fall * stripes * (0.15 + 0.85 * core) * uOpacity;
  gl_FragColor = vec4(uColor * (0.75 + core * 0.25), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CONFETTI_COLORS = [0xff5c8a, 0xffd23f, 0x3ee08f, 0x4cc9ff, 0xb388ff, 0xff8c42, 0xffffff];

function createEffects(scene) {
  const tmpColor = new THREE.Color();
  const tmpV2 = new THREE.Vector2();
  const scaleUniform = { value: 800 };
  let time = 0;

  // ---------------------------------------------------------------- particle pools
  function makePool(max, blending, core, renderOrder) {
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const prm = new Float32Array(max * 4);
    const geo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    const aPrm = new THREE.BufferAttribute(prm, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('aColor', aCol);
    geo.setAttribute('aParams', aPrm);
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: scaleUniform, uCore: { value: core } },
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    points.visible = false;
    points.onBeforeRender = onBeforeRenderPoints;
    scene.add(points);
    return { data: new Float32Array(max * S), pos, col, prm, aPos, aCol, aPrm, geo, points, max, count: 0 };
  }

  function onBeforeRenderPoints(renderer, _scene, camera) {
    const rt = renderer.getRenderTarget();
    let h;
    if (rt) h = rt.height;
    else { renderer.getDrawingBufferSize(tmpV2); h = tmpV2.y; }
    scaleUniform.value = h * 0.5 * camera.projectionMatrix.elements[5];
  }

  const glow = makePool(4000, THREE.AdditiveBlending, 0.4, 20);   // sparkles, puffs, glows
  const soft = makePool(4000, THREE.NormalBlending, 0.15, 19);    // dust, confetti, fur, firework stars (readable on snow)

  // Emits one particle; returns its base offset into pool.data, or -1 if pool is full.
  function emit(pool, x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a) {
    if (pool.count >= pool.max) return -1;
    const o = pool.count++ * S;
    const d = pool.data;
    d[o + PX] = x; d[o + PY] = y; d[o + PZ] = z;
    d[o + VX] = vx; d[o + VY] = vy; d[o + VZ] = vz;
    d[o + AGE] = 0; d[o + LIFE] = life;
    d[o + S0] = s0; d[o + S1] = s1;
    d[o + GRAV] = 0; d[o + DRAG] = 0;
    d[o + CR] = r; d[o + CG] = g; d[o + CB] = b; d[o + A0] = a;
    d[o + ROT] = rand() * TAU; d[o + SPIN] = 0; d[o + PH] = rand() * TAU; d[o + FREQ] = 0;
    d[o + SHAPE] = SHAPE_ROUND; d[o + OX] = 0; d[o + OZ] = 0; d[o + OMEGA] = 0;
    return o;
  }

  function updatePool(pool, dt) {
    const d = pool.data, pos = pool.pos, col = pool.col, prm = pool.prm;
    let n = pool.count;
    let i = 0;
    while (i < n) {
      const o = i * S;
      const age = d[o + AGE] + dt;
      const life = d[o + LIFE];
      if (age >= life) {
        n--;
        if (i !== n) d.copyWithin(o, n * S, n * S + S);
        continue;
      }
      d[o + AGE] = age;
      const grav = d[o + GRAV];
      let vx = d[o + VX], vy = d[o + VY] + grav * dt, vz = d[o + VZ];
      const drag = d[o + DRAG];
      if (drag > 0) { const k = 1 / (1 + drag * dt); vx *= k; vy *= k; vz *= k; }
      let px = d[o + PX] + vx * dt, py = d[o + PY] + vy * dt, pz = d[o + PZ] + vz * dt;
      const om = d[o + OMEGA];
      if (om !== 0) {
        const ox = d[o + OX], oz = d[o + OZ];
        const dx = px - ox, dz = pz - oz;
        const c = Math.cos(om * dt), s = Math.sin(om * dt);
        px = ox + dx * c - dz * s;
        pz = oz + dx * s + dz * c;
      }
      if (py < 0.03 && vy < 0) { py = 0.03; vy *= -0.25; vx *= 0.5; vz *= 0.5; }
      d[o + PX] = px; d[o + PY] = py; d[o + PZ] = pz;
      d[o + VX] = vx; d[o + VY] = vy; d[o + VZ] = vz;

      const k = age / life;
      const size = d[o + S0] + (d[o + S1] - d[o + S0]) * k;
      let alpha = d[o + A0] * Math.min(1, k * 12) * (1 - k * k);
      const shape = d[o + SHAPE];
      let rot = 0, squash = 0;
      if (shape === SHAPE_TWINKLE) {
        alpha *= 0.55 + 0.45 * Math.sin(d[o + PH] + age * d[o + FREQ]);
      } else if (shape === SHAPE_RECT) {
        rot = d[o + ROT] + d[o + SPIN] * dt; d[o + ROT] = rot;
        const ph = d[o + PH] + d[o + FREQ] * dt; d[o + PH] = ph;
        squash = 0.1 + 0.9 * Math.abs(Math.sin(ph));
      } else if (shape === SHAPE_FISH) {   // flutters like confetti; 1 + squash tells the shader it's a fish
        rot = d[o + ROT] + d[o + SPIN] * dt; d[o + ROT] = rot;
        const ph = d[o + PH] + d[o + FREQ] * dt; d[o + PH] = ph;
        squash = 1.1 + 0.9 * Math.abs(Math.sin(ph));
      } else if (shape === SHAPE_HEART) {
        squash = -1;
      } else if (shape === SHAPE_STAR) {
        rot = d[o + ROT] + d[o + SPIN] * dt; d[o + ROT] = rot;
        squash = -2;
      } else if (shape === SHAPE_SPARKLE) {   // turns slowly and twinkles
        rot = d[o + ROT] + d[o + SPIN] * dt; d[o + ROT] = rot;
        alpha *= 0.55 + 0.45 * Math.sin(d[o + PH] + age * d[o + FREQ]);
        squash = -3;
      }
      const i3 = i * 3, i4 = i * 4;
      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;
      col[i3] = d[o + CR]; col[i3 + 1] = d[o + CG]; col[i3 + 2] = d[o + CB];
      prm[i4] = size; prm[i4 + 1] = alpha; prm[i4 + 2] = rot; prm[i4 + 3] = squash;
      i++;
    }
    pool.count = n;
    pool.geo.setDrawRange(0, n);
    pool.points.visible = n > 0;
    if (n > 0) {
      pool.aPos.clearUpdateRanges(); pool.aPos.addUpdateRange(0, n * 3); pool.aPos.needsUpdate = true;
      pool.aCol.clearUpdateRanges(); pool.aCol.addUpdateRange(0, n * 3); pool.aCol.needsUpdate = true;
      pool.aPrm.clearUpdateRanges(); pool.aPrm.addUpdateRange(0, n * 4); pool.aPrm.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- rings
  const ringGeo = new THREE.RingGeometry(0.5, 1, 64, 1);
  const rings = [];
  for (let i = 0; i < 24; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uInner: { value: 0.8 } },
      vertexShader: RING_VERT, fragmentShader: RING_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 18;
    scene.add(mesh);
    rings.push({ mesh, mat, active: false, age: 0, life: 1, r0: 0, r1: 1, op: 1 });
  }
  let ringCursor = 0;
  function ring(x, y, z, color, r0, r1, life, inner, opacity, intensity) {
    let rg = null;
    for (let i = 0; i < rings.length; i++) if (!rings[i].active) { rg = rings[i]; break; }
    if (!rg) { rg = rings[ringCursor]; ringCursor = (ringCursor + 1) % rings.length; }
    rg.active = true; rg.age = 0; rg.life = life; rg.r0 = r0; rg.r1 = r1; rg.op = opacity;
    rg.mat.uniforms.uColor.value.set(color).multiplyScalar(intensity);
    rg.mat.uniforms.uInner.value = inner;
    rg.mesh.position.set(x, y, z);
    rg.mesh.scale.setScalar(Math.max(r0, 0.001));
    rg.mesh.visible = true;
  }
  function updateRings(dt) {
    for (let i = 0; i < rings.length; i++) {
      const rg = rings[i];
      if (!rg.active) continue;
      rg.age += dt;
      const k = rg.age / rg.life;
      if (k >= 1) { rg.active = false; rg.mesh.visible = false; continue; }
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      rg.mesh.scale.setScalar(rg.r0 + (rg.r1 - rg.r0) * e);
      rg.mat.uniforms.uOpacity.value = rg.op * Math.pow(1 - k, 1.5);
    }
  }

  // ---------------------------------------------------------------- beams (light pillars)
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true);
  beamGeo.translate(0, 0.5, 0);
  const beams = [];
  for (let i = 0; i < 10; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(beamGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 21;
    scene.add(mesh);
    beams.push({ mesh, mat, active: false, age: 0, life: 1, radius: 1, height: 1 });
  }
  let beamCursor = 0;
  function beam(x, z, color, radius, height, life, intensity) {
    let b = null;
    for (let i = 0; i < beams.length; i++) if (!beams[i].active) { b = beams[i]; break; }
    if (!b) { b = beams[beamCursor]; beamCursor = (beamCursor + 1) % beams.length; }
    b.active = true; b.age = 0; b.life = life; b.radius = radius; b.height = height;
    b.mat.uniforms.uColor.value.set(color).multiplyScalar(intensity);
    b.mesh.position.set(x, 0, z);
    b.mesh.scale.set(0.001, 0.001, 0.001);
    b.mesh.visible = true;
  }
  function updateBeams(dt) {
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      if (!b.active) continue;
      b.age += dt;
      const k = b.age / b.life;
      if (k >= 1) { b.active = false; b.mesh.visible = false; continue; }
      const kin = Math.min(1, k / 0.1);
      const r = b.radius * (0.35 + 0.65 * kin) * (1 - 0.55 * k);
      const h = b.height * Math.min(1, k * 7);
      b.mesh.scale.set(r, h, r);
      const fade = k < 0.1 ? kin : 1 - (k - 0.1) / 0.9;
      b.mat.uniforms.uOpacity.value = fade * fade;
      b.mat.uniforms.uTime.value = time;
    }
  }

  // ---------------------------------------------------------------- floating text
  const TW = 512, TH = 128, TEXT_WORLD_H = 1.15;
  const texts = [];
  for (let i = 0; i < 16; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = TW; canvas.height = TH;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 999;
    sprite.scale.set(TEXT_WORLD_H * TW / TH, TEXT_WORLD_H, 1);
    scene.add(sprite);
    texts.push({ sprite, mat, tex, ctx, active: false, age: 0, x: 0, y: 0, z: 0, startTime: 0 });
  }
  function cssColor(c) {
    if (typeof c === 'string') return c;
    tmpColor.set(c === undefined ? 0xffffff : c);
    return '#' + tmpColor.getHexString();
  }
  const TEXT_LIFE = 1.2, TEXT_RISE = 1.5;

  // ---------------------------------------------------------------- shake
  let trauma = 0;
  const shakeOffset = { x: 0, y: 0, z: 0 };
  const SHAKE_MAX = 0.8;
  // prefers-reduced-motion: keep a hint of impact, but only a quarter of the trauma
  const reducedMotion = (typeof matchMedia === 'function') ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  // ---------------------------------------------------------------- helpers
  function rgbOf(color, mul) {
    tmpColor.set(color === undefined ? 0xffffff : color);
    if (mul !== 1) tmpColor.multiplyScalar(mul);
    return tmpColor;
  }

  // ---------------------------------------------------------------- public API
  function burst(x, y, z, opts) {
    const o = opts || {};
    const count = o.count !== undefined ? o.count : 20;
    const speed = o.speed !== undefined ? o.speed : 4;
    const size = o.size !== undefined ? o.size : 0.3;
    const life = o.life !== undefined ? o.life : 0.8;
    const gravity = o.gravity !== undefined ? o.gravity : -6;
    const spread = o.spread !== undefined ? o.spread : 1;
    const c = rgbOf(o.color, 0.9);
    const cr = c.r, cg = c.g, cb = c.b;
    const cosMax = Math.cos(Math.min(1, Math.max(0, spread)) * Math.PI);
    for (let i = 0; i < count; i++) {
      const cy = 1 - rand() * (1 - cosMax);
      const sy = Math.sqrt(Math.max(0, 1 - cy * cy));
      const a = rand() * TAU;
      const sp = speed * rr(0.5, 1);
      const p = emit(glow, x, y, z, Math.cos(a) * sy * sp, cy * sp, Math.sin(a) * sy * sp,
        life * rr(0.6, 1), size * rr(0.7, 1.2), size * 0.2, cr, cg, cb, 1);
      if (p < 0) break;
      glow.data[p + GRAV] = gravity;
      glow.data[p + DRAG] = 1.5;
    }
  }

  function deathPoof(x, z, color) {
    const c = rgbOf(color, 0.9);
    const cr = c.r, cg = c.g, cb = c.b;
    // colored puff
    for (let i = 0; i < 30; i++) {
      const a = rand() * TAU, sp = rr(2.5, 6.5);
      const p = emit(glow, x + Math.cos(a) * 0.2, rr(0.2, 0.7), z + Math.sin(a) * 0.2,
        Math.cos(a) * sp, rr(0.5, 4), Math.sin(a) * sp, rr(0.5, 0.9), rr(0.5, 0.8), 0.1, cr, cg, cb, 0.9);
      if (p < 0) break;
      glow.data[p + GRAV] = -3; glow.data[p + DRAG] = 3.5;
    }
    // white sparkles
    for (let i = 0; i < 14; i++) {
      const a = rand() * TAU, sp = rr(4, 8);
      const p = emit(glow, x, 0.5, z, Math.cos(a) * sp, rr(2, 6), Math.sin(a) * sp,
        rr(0.4, 0.7), 0.22, 0.05, 0.85, 0.85, 0.85, 1);
      if (p < 0) break;
      glow.data[p + GRAV] = -10; glow.data[p + DRAG] = 2;
      glow.data[p + SHAPE] = SHAPE_TWINKLE; glow.data[p + FREQ] = 40;
    }
    // fur tufts (soft, flutter down)
    const f = rgbOf(color, 1);
    const fr = f.r * 0.6 + 0.4, fg = f.g * 0.6 + 0.4, fb = f.b * 0.6 + 0.4;
    for (let i = 0; i < 16; i++) {
      const a = rand() * TAU, sp = rr(1.5, 4);
      const p = emit(soft, x, rr(0.3, 0.8), z, Math.cos(a) * sp, rr(3, 6), Math.sin(a) * sp,
        rr(1.0, 1.6), rr(0.2, 0.3), 0.15, fr, fg, fb, 1);
      if (p < 0) break;
      soft.data[p + GRAV] = -7; soft.data[p + DRAG] = 2.2;
      soft.data[p + SHAPE] = SHAPE_RECT; soft.data[p + SPIN] = rr(-8, 8); soft.data[p + FREQ] = rr(6, 12);
    }
    ring(x, 0.06, z, color, 0.3, 3.4, 0.55, 0.78, 0.9, 1);
    ring(x, 0.08, z, 0xffffff, 0.2, 2.0, 0.35, 0.85, 0.5, 0.8);
  }

  function reviveBeam(x, z, color) {
    beam(x, z, color, 1.15, 9, 1.1, 0.85);
    beam(x, z, 0xffffff, 0.35, 11, 0.8, 0.5);
    ring(x, 0.06, z, color, 0.4, 2.8, 0.7, 0.75, 0.9, 1);
    const c = rgbOf(color, 0.9);
    const cr = c.r * 0.65 + 0.3, cg = c.g * 0.65 + 0.3, cb = c.b * 0.65 + 0.3;
    for (let i = 0; i < 46; i++) {
      const a = rand() * TAU, rad = Math.sqrt(rand()) * 1.1;
      const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
      const p = emit(glow, px, rr(0, 0.8), pz, 0, rr(1.5, 5), 0, rr(0.8, 1.5), rr(0.15, 0.3), 0.04, cr, cg, cb, 1);
      if (p < 0) break;
      const d = glow.data;
      d[p + GRAV] = 2; d[p + DRAG] = 0.3;
      d[p + SHAPE] = SHAPE_TWINKLE; d[p + FREQ] = rr(15, 30);
      d[p + OX] = x; d[p + OZ] = z; d[p + OMEGA] = 1.8;
    }
  }

  function pickup(x, z, color) {
    ring(x, 0.06, z, color, 0.2, 1.7, 0.45, 0.82, 0.9, 1);
    const c = rgbOf(color, 0.9);
    const cr = c.r, cg = c.g, cb = c.b;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU + rand() * 0.2, sp = rr(2.5, 3.5);
      const p = emit(glow, x, 0.6, z, Math.cos(a) * sp, rr(1, 2.5), Math.sin(a) * sp, rr(0.45, 0.7), 0.24, 0.05, cr, cg, cb, 1);
      if (p < 0) break;
      glow.data[p + GRAV] = -5; glow.data[p + DRAG] = 2.5;
      glow.data[p + SHAPE] = SHAPE_TWINKLE; glow.data[p + FREQ] = 35;
    }
    for (let i = 0; i < 8; i++) {
      const p = emit(glow, x + rr(-0.3, 0.3), rr(0.3, 0.8), z + rr(-0.3, 0.3), 0, rr(2, 4), 0, rr(0.5, 0.8), 0.18, 0.04, 0.85, 0.85, 0.85, 1);
      if (p < 0) break;
      glow.data[p + DRAG] = 2;
    }
  }

  function teleport(x, z, color) {
    beam(x, z, 0xffffff, 0.6, 13, 0.5, 0.55);
    beam(x, z, color, 1.35, 10, 0.85, 0.85);
    ring(x, 0.06, z, color, 0.3, 3.0, 0.55, 0.7, 0.9, 1);
    const c = rgbOf(color, 0.9);
    const cr = c.r, cg = c.g, cb = c.b;
    const dir = rand() < 0.5 ? -1 : 1;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * TAU * 2 + rand() * 0.3, rad = rr(0.7, 1.4);
      const white = i % 3 === 0;
      const p = emit(glow, x + Math.cos(a) * rad, rr(0, 0.6), z + Math.sin(a) * rad,
        -Math.cos(a) * 0.4, rr(3, 7.5), -Math.sin(a) * 0.4, rr(0.8, 1.3), rr(0.18, 0.32), 0.04,
        white ? 0.85 : cr, white ? 0.85 : cg, white ? 0.85 : cb, 1);
      if (p < 0) break;
      const d = glow.data;
      d[p + GRAV] = 2.5; d[p + DRAG] = 0.4;
      d[p + OX] = x; d[p + OZ] = z; d[p + OMEGA] = dir * rr(6, 9);
    }
  }

  // kind (the level's season, models.js SHIELD_LOOK): 'leaves' = the leaf ball bursts, leaves fluttering down;
  // 'snow' = the snowball bursts into a soft puff of snow; otherwise the blue bubble's sparkle
  function shieldPop(x, z, kind) {
    if (kind === 'leaves' || kind === 'snow') {
      const snow = kind === 'snow';
      for (let i = 0; i < (snow ? 26 : 20); i++) {
        const u = rand() * 2 - 1, a = rand() * TAU, s = Math.sqrt(1 - u * u), nx = Math.cos(a) * s, ny = Math.abs(u), nz = Math.sin(a) * s, sp = rr(1.6, 3.2);
        const p = emit(soft, x + nx * 0.6, 0.45 + ny * 0.5, z + nz * 0.6, nx * sp, ny * sp + rr(0.5, 1.5), nz * sp,
          rr(0.7, 1.1), snow ? rr(0.12, 0.2) : rr(0.13, 0.18), snow ? 0.3 : 0.12, ...(snow ? [0.96, 0.98, 1] : SHIELD_LEAVES[i % SHIELD_LEAVES.length]), snow ? 0.8 : 0.95);
        if (p < 0) break;
        soft.data[p + GRAV] = snow ? -2.5 : -2; soft.data[p + DRAG] = snow ? 3 : 2.4;
        if (!snow) { soft.data[p + SHAPE] = SHAPE_RECT; soft.data[p + SPIN] = rr(-7, 7); }
      }
      if (snow) ring(x, 0.06, z, 0xeef6ff, 0.5, 1.8, 0.4, 0.8, 0.6, 1);
      return;
    }
    ring(x, 0.06, z, 0x7fe9ff, 0.6, 2.2, 0.35, 0.8, 0.9, 1);
    for (let i = 0; i < 32; i++) {
      const u = rand() * 2 - 1, a = rand() * TAU, s = Math.sqrt(1 - u * u);
      const nx = Math.cos(a) * s, ny = Math.abs(u), nz = Math.sin(a) * s;
      const sp = rr(3, 5.5);
      const p = emit(glow, x + nx * 0.8, 0.5 + ny * 0.8, z + nz * 0.8, nx * sp, ny * sp, nz * sp,
        rr(0.35, 0.6), rr(0.18, 0.3), 0.05, 0.4, 0.8, 0.95, 1);
      if (p < 0) break;
      glow.data[p + DRAG] = 4; glow.data[p + GRAV] = -4;
    }
  }

  function dust(x, z) {
    const n = rand() < 0.5 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, sp = rr(0.3, 0.8);
      const p = emit(soft, x + rr(-0.12, 0.12), 0.08, z + rr(-0.12, 0.12), Math.cos(a) * sp, rr(0.4, 0.9), Math.sin(a) * sp,
        rr(0.35, 0.55), rr(0.14, 0.2), rr(0.38, 0.5), 0.86, 0.8, 0.7, 0.45);
      if (p < 0) return;
      soft.data[p + DRAG] = 3;
    }
  }

  // Pattern wolf pushing off on the ice: shavings kicked out behind it.
  function iceKick(x, z, heading) {
    const bx = -Math.cos(heading), bz = -Math.sin(heading);
    for (let i = 0; i < 9; i++) {
      const a = Math.atan2(bz, bx) + rr(-0.9, 0.9), sp = rr(1.5, 3.5);
      const p = emit(soft, x + bx * 0.4, 0.06, z + bz * 0.4, Math.cos(a) * sp, rr(0.6, 1.6), Math.sin(a) * sp,
        rr(0.3, 0.5), rr(0.08, 0.13), 0.03, 0.93, 0.97, 1, 0.85);
      if (p < 0) return;
      soft.data[p + GRAV] = -7; soft.data[p + DRAG] = 3;
    }
  }

  function confetti(x, z) {
    for (let i = 0; i < 260; i++) {
      const a = rand() * TAU, tilt = rand() * 0.65, sp = rr(8, 15);
      const st = Math.sin(tilt);
      const col = CONFETTI_COLORS[(rand() * CONFETTI_COLORS.length) | 0];
      tmpColor.setHex(col);
      const p = emit(soft, x + rr(-0.4, 0.4), rr(0.3, 0.8), z + rr(-0.4, 0.4),
        Math.cos(a) * st * sp, Math.cos(tilt) * sp, Math.sin(a) * st * sp,
        rr(2.5, 3.6), rr(0.38, 0.5), 0.32, tmpColor.r, tmpColor.g, tmpColor.b, 1);
      if (p < 0) break;
      const d = soft.data;
      d[p + GRAV] = -9; d[p + DRAG] = rr(1.4, 2.2);
      d[p + SHAPE] = SHAPE_FISH; d[p + SPIN] = rr(-9, 9); d[p + FREQ] = rr(5, 12);
    }
    for (let i = 0; i < 40; i++) {
      const a = rand() * TAU, tilt = rand() * 0.8, sp = rr(6, 13);
      const st = Math.sin(tilt);
      tmpColor.setHex(CONFETTI_COLORS[(rand() * CONFETTI_COLORS.length) | 0]);
      const p = emit(glow, x, 0.5, z, Math.cos(a) * st * sp, Math.cos(tilt) * sp, Math.sin(a) * st * sp,
        rr(1.0, 1.8), 0.28, 0.05, tmpColor.r * 0.9, tmpColor.g * 0.9, tmpColor.b * 0.9, 1);
      if (p < 0) break;
      const d = glow.data;
      d[p + GRAV] = -8; d[p + DRAG] = 1.6;
      d[p + SHAPE] = SHAPE_TWINKLE; d[p + FREQ] = 30;
    }
    ring(x, 0.06, z, 0xffe680, 0.5, 4.5, 0.7, 0.85, 0.9, 1);
  }

  // A kitty takes a bite of the giant fish (the final run): pink-orange flesh crumbs and silver scales spray up out of
  // the bite at (x, y, z) toward the kitty (dirX, dirZ = unit vector fish -> kitty); heart = also float up a heart.
  function munch(x, y, z, dirX, dirZ, heart, scale = 1) {
    const n = Math.max(3, Math.round(9 * scale));
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dirZ, dirX) + rr(-1.1, 1.1), sp = rr(1.2, 3.2);
      const scaleBit = rand() < 0.3;
      const p = emit(soft, x + rr(-0.15, 0.15), y, z + rr(-0.15, 0.15), Math.cos(a) * sp, rr(1.8, 4), Math.sin(a) * sp,
        rr(0.45, 0.75), scaleBit ? rr(0.1, 0.14) : rr(0.13, 0.22), 0.06,
        scaleBit ? 0.86 : 1, scaleBit ? 0.92 : rr(0.5, 0.62), scaleBit ? 1 : rr(0.36, 0.45), 1);
      if (p < 0) break;
      soft.data[p + GRAV] = -11; soft.data[p + DRAG] = 1.2;
      if (scaleBit) { soft.data[p + SHAPE] = SHAPE_RECT; soft.data[p + SPIN] = rr(-12, 12); soft.data[p + FREQ] = rr(10, 18); }
    }
    for (let i = 0; i < 2; i++) {
      const p = emit(glow, x + rr(-0.2, 0.2), y + 0.1, z + rr(-0.2, 0.2), rr(-0.6, 0.6), rr(1, 2), rr(-0.6, 0.6),
        rr(0.3, 0.5), 0.22, 0.04, 0.85, 0.8, 0.7, 0.8);
      if (p < 0) break;
      glow.data[p + SHAPE] = SHAPE_TWINKLE; glow.data[p + FREQ] = 35;
    }
    if (heart) {
      const p = emit(soft, x - dirX * 0.1, y + 0.35, z - dirZ * 0.1, rr(-0.25, 0.25), rr(1.1, 1.5), rr(-0.25, 0.25),
        rr(1.0, 1.3), 0.42, 0.55, 1, 0.36, 0.55, 1);
      if (p >= 0) { soft.data[p + DRAG] = 1.5; soft.data[p + SHAPE] = SHAPE_HEART; }
    }
  }

  // A little star of life (the medic cape's symbol) left behind a running kitty (30+ revives), in the kitty's colour:
  // drifts up, turning slowly, and fades. color: a THREE.Color or hex
  const _trailCol = new THREE.Color();
  function medicTrail(x, y, z, color) {
    _trailCol.set(color);
    const p = emit(soft, x + rr(-0.12, 0.12), y + rr(0.2, 0.45), z + rr(-0.12, 0.12), rr(-0.15, 0.15), rr(0.35, 0.7), rr(-0.15, 0.15),
      rr(1.0, 1.4), rr(0.36, 0.46), 0.1, _trailCol.r, _trailCol.g, _trailCol.b, 1);
    if (p < 0) return;
    soft.data[p + DRAG] = 1.2; soft.data[p + SHAPE] = SHAPE_STAR; soft.data[p + ROT] = rr(0, TAU); soft.data[p + SPIN] = rr(-1.2, 1.2);
  }

  // celestial lion (16 wins + 120 revives): a trail of space behind the kitty, sparkles swirling like a galaxy's arms
  // over soft nebula clouds
  const STAR_COLS = [0xffffff, 0xffffff, 0xcfe0ff, 0xa8c8ff, 0xffd6f5, 0xd8c4ff];
  const NEBULA_COLS = [0x5a2dbf, 0x2b3fa8, 0x8e3cc4, 0x3b1d7a, 0x2a6fd6];
  // one twinkling star of space
  function sparkle(x, y, z, vx, vy, vz, life, s0, size) {
    _trailCol.set(STAR_COLS[(rand() * STAR_COLS.length) | 0]);
    const p = emit(glow, x, y, z, vx, vy, vz, life, s0 * size, 0.04, _trailCol.r, _trailCol.g, _trailCol.b, 1);
    if (p < 0) return -1;
    glow.data[p + SHAPE] = SHAPE_SPARKLE; glow.data[p + SPIN] = rr(-1.2, 1.2); glow.data[p + FREQ] = rr(7, 13); glow.data[p + DRAG] = 1.5;
    return p;
  }
  // a soft cloud of nebula: a deep colour (still reads on white snow) with a faint glow over it
  function nebula(x, y, z, s0, s1, life) {
    _trailCol.set(NEBULA_COLS[(rand() * NEBULA_COLS.length) | 0]);
    const vx = rr(-0.12, 0.12), vy = rr(0.05, 0.2), vz = rr(-0.12, 0.12);
    let p = emit(soft, x, y, z, vx, vy, vz, life, s0, s1, _trailCol.r, _trailCol.g, _trailCol.b, 0.2);
    if (p >= 0) soft.data[p + DRAG] = 1.5;
    p = emit(glow, x, y, z, vx, vy, vz, life * 0.8, s0 * 0.8, s1 * 0.9, _trailCol.r, _trailCol.g, _trailCol.b, 0.28);
    if (p >= 0) glow.data[p + DRAG] = 1.5;
  }
  // a little star twinkling up from a celestial lion's paw print
  function starStep(x, y, z) {
    sparkle(x + rr(-0.12, 0.12), y + 0.08, z + rr(-0.12, 0.12), 0, rr(0.05, 0.2), 0, rr(0.5, 0.9), rr(0.22, 0.32), 1);
  }
  // (n stars, spread around the point, lift: how high above y they start; the wing tips use a thin stream: n = 1)
  function cosmicTrail(x, y, z, n = 3, spread = 0.2, lift = 0.5, size = 1) {
    const wing = n === 1;
    // sparkles that circle round the spot they left, so the trail winds like a galaxy's arms
    for (let k = 0; k < (wing ? 1 : 2); k++) {
      const a = rr(0, TAU), r = wing ? spread : rr(0.25, 0.45);
      const p = sparkle(x + Math.cos(a) * r, y + rr(0.15, 0.15 + lift), z + Math.sin(a) * r, 0, rr(0.05, 0.2), 0, rr(1.0, 1.5), rr(0.3, 0.5), size);
      if (p >= 0) { glow.data[p + OX] = x; glow.data[p + OZ] = z; glow.data[p + OMEGA] = (k ? -1 : 1) * rr(2.2, 3.2); glow.data[p + DRAG] = 0.5; }
    }
    if (!wing && rand() < 0.55) nebula(x, y + rr(0.25, 0.5), z, 0.7, 1.5, rr(0.9, 1.3));
  }

  // ---------------------------------------------------------------- calling card (120+ revives)
  // The rescuer's cat icon (the player card's, in their colour) left on the ground where they saved
  // a kitty: pops in, stays a few seconds, fades. One texture per colour.
  const cardTex = new Map();
  // The rescuer's cat icon as their player card shows it (sunglasses, the sliding rainbow fur, the lion looks: caticon.js)
  function drawCard(g, col, look, phase) {
    const cool = look.cool;
    const INK = '#2b1840', P = (d) => new Path2D(d);
    g.clearRect(0, 0, 256, 256);
    g.save(); g.translate(128 - 20 * 5.6, 128 - 20 * 5.6); g.scale(5.6, 5.6);   // the cat fills the card
    g.lineJoin = 'round'; g.lineCap = 'round';
    const head = P('M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z');
    drawMane(g, col, look, phase || 0);   // 14+ wins (caticon.js)
    // the face: the kitty's colour, the HUD's sliding rainbow, or a 16-win lion look
    const fill = faceFill(g, look, phase || 0);
    g.save(); g.clip(head); g.fillStyle = fill || col; g.fillRect(-10, -10, 60, 60);
    if (look.lionLook === 'celestial') stars(g);
    g.restore();
    g.strokeStyle = INK; g.lineWidth = 2.6; g.stroke(head);
    g.fillStyle = '#ff9ec4'; g.fill(P('M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z'));
    if (cool) {
      g.strokeStyle = '#ffd34a'; g.lineWidth = 1.6; g.stroke(P('M5 19.6 L10 18.8 M35 19.6 L30 18.8 M18.4 20.2 Q20 18.6 21.6 20.2'));
      g.fillStyle = '#1e1a2b'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(14, 21.6, 4.8, 4.2, 0, 0, TAU); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(26, 21.6, 4.8, 4.2, 0, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke(P('M11.4 19.8 L14.6 19.1 M23.4 19.8 L26.6 19.1'));
    } else {
      g.fillStyle = INK; g.beginPath(); g.ellipse(14.3, 21.5, 2.3, 3.1, 0, 0, TAU); g.ellipse(25.7, 21.5, 2.3, 3.1, 0, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(15, 20.4, 0.9, 0, TAU); g.arc(26.4, 20.4, 0.9, 0, TAU); g.fill();
    }
    if (look.specs) {   // an easy game's reading glasses (ui.js SPECS_SVG)
      g.strokeStyle = '#e0b040'; g.lineWidth = 1.4; g.stroke(P('M5 19.6 L9.4 20.4 M35 19.6 L30.6 20.4 M18.6 20.6 Q20 19.2 21.4 20.6'));
      g.lineWidth = 1.5; g.beginPath(); g.arc(14.2, 21.5, 4.7, 0, TAU); g.stroke(); g.beginPath(); g.arc(25.8, 21.5, 4.7, 0, TAU); g.stroke();
    }
    g.strokeStyle = INK;
    const nose = P('M18.2 26.4 L21.8 26.4 L20 28.6 Z');
    g.fillStyle = '#ff6f9f'; g.fill(nose); g.lineWidth = 1; g.stroke(nose);
    g.lineWidth = 1.3; g.stroke(P('M20 28.6 Q18.5 31 16.5 30 M20 28.6 Q21.5 31 23.5 30'));
    g.restore();
  }
  // a rainbow face or mane slides: those cards get their own canvas, redrawn while they show (updateCards)
  const sliding = (look) => !!(look.rainbow || look.lionLook === 'rainbow') && look.lionLook !== 'chrome' && look.lionLook !== 'celestial';
  function cardTexture(color, look) {
    const key = (color >>> 0) + ':' + (look.cool ? 'c' : '') + (look.specs ? 's' : '') + (look.metal || '') + (look.lion ? 'l' : '') + (look.lionLook || '');
    const anim = sliding(look);
    if (!anim && cardTex.has(key)) return cardTex.get(key);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    drawCard(c.getContext('2d'), '#' + new THREE.Color(color).getHexString(), look, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    if (!anim) cardTex.set(key, t);
    return t;
  }
  const cards = [];
  const CARD_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const CARD_LIFE = 3;   // seconds on the ground (pops in 0.3 s, fades out over the last 0.6 s)
  function callingCard(x, z, color, look = {}) {
    const map = cardTexture(color, look);
    const mat = new THREE.MeshBasicMaterial({ map, transparent: true, opacity: 0, depthWrite: false });
    const m = new THREE.Mesh(CARD_GEO, mat);
    m.position.set(x, 0.07, z);
    m.renderOrder = 4;   // over the floor marks
    scene.add(m);
    cards.push({ m, age: 0, anim: sliding(look) ? { look, col: '#' + new THREE.Color(color).getHexString() } : null });
  }
  function updateCards(dt) {
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      c.age += dt;
      if (c.age >= CARD_LIFE) { scene.remove(c.m); if (c.anim) c.m.material.map.dispose(); c.m.material.dispose(); cards.splice(i, 1); continue; }
      if (c.anim) { drawCard(c.m.material.map.image.getContext('2d'), c.anim.col, c.anim.look, (c.age / 2.2) % 1); c.m.material.map.needsUpdate = true; }   // (the HUD's 2.2 s slide)
      const pop = Math.min(1, c.age / 0.3), v = pop - 1, k = 1 + 2.70158 * v * v * v + 1.70158 * v * v;   // ease-out-back
      c.m.scale.setScalar(1.7 * k * (1 + 0.03 * Math.sin(c.age * 5)));
      c.m.material.opacity = pop * Math.min(1, (CARD_LIFE - c.age) / 0.6);
    }
  }

  // ---------------------------------------------------------------- fireworks (the final run's victory party)
  // A rocket climbs from (x0, z0) to (x, y, z) leaving a sparkly trail, then bursts. opts:
  //   color, color2 (second burst colour), kind ('peony' | 'ring' | 'willow'), fuse (s), scale (particle count, 0..1),
  //   onBurst(x, y, z) (e.g. for the bang).
  const rockets = [];
  function firework(x0, z0, x, y, z, opts) {
    const o = opts || {};
    if (rockets.length >= 24) return;
    rockets.push({
      x0, z0, x, y, z, age: 0, fuse: o.fuse || rr(0.75, 1.05), trailT: 0,
      color: o.color === undefined ? CONFETTI_COLORS[(rand() * 6) | 0] : o.color,
      color2: o.color2, kind: o.kind || 'peony', scale: o.scale === undefined ? 1 : o.scale, onBurst: o.onBurst || null,
      px: x0, py: 0.4, pz: z0,
    });
  }
  function rocketPos(r, k) {
    const e = 1 - (1 - k) * (1 - k);                 // fast launch, slowing toward the top
    r.px = r.x0 + (r.x - r.x0) * k;
    r.pz = r.z0 + (r.z - r.z0) * k;
    r.py = 0.4 + (r.y - 0.4) * e;
  }
  function fireworkBurst(r) {
    const n = Math.max(24, Math.round(130 * r.scale));
    const willow = r.kind === 'willow', ringK = r.kind === 'ring';
    const c1 = rgbOf(r.color, 1), c1r = c1.r, c1g = c1.g, c1b = c1.b;
    const c2 = rgbOf(r.color2 === undefined ? r.color : r.color2, 1), c2r = c2.r, c2g = c2.g, c2b = c2.b;
    // ring bursts are tilted toward the camera a little so they read as rings, not lines
    const tilt = rr(0.5, 0.9);
    for (let i = 0; i < n; i++) {
      let dx, dy, dz;
      if (ringK) {
        const a = (i / n) * TAU;
        dx = Math.cos(a); dy = Math.sin(a) * Math.cos(tilt); dz = Math.sin(a) * Math.sin(tilt);
      } else {
        const u = rand() * 2 - 1, a = rand() * TAU, s = Math.sqrt(1 - u * u);
        dx = Math.cos(a) * s; dy = u; dz = Math.sin(a) * s;
      }
      const sp = (willow ? rr(5, 7) : rr(7.5, 10)) * (ringK ? 1 : rr(0.85, 1));
      const two = i % 3 === 0;
      // half the stars glow (additive), half are solid colour so they still read against white snow
      const solid = i % 2 === 1, pool = solid ? soft : glow;
      const p = emit(pool, r.x, r.y, r.z, dx * sp, dy * sp + 1, dz * sp,
        willow ? rr(2.0, 2.8) : rr(1.1, 1.6), willow ? 0.32 : solid ? 0.36 : 0.42, 0.06,
        two ? c2r : c1r, two ? c2g : c1g, two ? c2b : c1b, 1);
      if (p < 0) break;
      const d = pool.data;
      d[p + GRAV] = willow ? -2.2 : -3.2; d[p + DRAG] = willow ? 1.9 : 1.35;
      if (!solid) { d[p + SHAPE] = SHAPE_TWINKLE; d[p + FREQ] = rr(18, 34); }
    }
    // white-hot core flash + crackle
    for (let i = 0; i < Math.round(22 * r.scale) + 4; i++) {
      const u = rand() * 2 - 1, a = rand() * TAU, s = Math.sqrt(1 - u * u), sp = rr(1.5, 4.5);
      const p = emit(glow, r.x, r.y, r.z, Math.cos(a) * s * sp, u * sp, Math.sin(a) * s * sp, rr(0.25, 0.5), 0.9, 0.1, 0.9, 0.85, 0.75, 1);
      if (p < 0) break;
      glow.data[p + DRAG] = 3;
      glow.data[p + SHAPE] = SHAPE_TWINKLE; glow.data[p + FREQ] = 45;
    }
    if (r.onBurst) { try { r.onBurst(r.x, r.y, r.z); } catch (e) { /* ignore */ } }
  }
  function updateRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.age += dt;
      const k = Math.min(1, r.age / r.fuse);
      rocketPos(r, k);
      r.trailT -= dt;
      while (r.trailT <= 0) {
        r.trailT += 0.016;
        const c = rgbOf(r.color, 0.35);
        const p = emit(glow, r.px + rr(-0.05, 0.05), r.py, r.pz + rr(-0.05, 0.05), rr(-0.4, 0.4), rr(-1.5, -0.3), rr(-0.4, 0.4),
          rr(0.35, 0.6), 0.26, 0.04, 0.6 + c.r, 0.5 + c.g, 0.4 + c.b, 0.9);
        if (p < 0) break;
        glow.data[p + GRAV] = -2; glow.data[p + DRAG] = 1;
        glow.data[p + SHAPE] = SHAPE_TWINKLE; glow.data[p + FREQ] = 40;
        const q = emit(soft, r.px, r.py - 0.1, r.pz, rr(-0.2, 0.2), rr(-1, 0), rr(-0.2, 0.2), rr(0.3, 0.5), 0.16, 0.03, 1, 0.62, 0.25, 0.8);
        if (q >= 0) soft.data[q + DRAG] = 1;
      }
      if (k >= 1) { rockets.splice(i, 1); fireworkBurst(r); }
    }
  }

  // Confetti drifting down from the sky over a disc of radius `radius` around (x, z); call every frame for rain.
  function confettiRain(x, z, radius, count) {
    const n = count === undefined ? 4 : count;
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, rad = Math.sqrt(rand()) * radius;
      tmpColor.setHex(CONFETTI_COLORS[(rand() * CONFETTI_COLORS.length) | 0]);
      const p = emit(soft, x + Math.cos(a) * rad, rr(12, 16), z + Math.sin(a) * rad, rr(-0.6, 0.6), rr(-1.5, -0.5), rr(-0.6, 0.6),
        rr(4.5, 6.5), rr(0.34, 0.46), 0.3, tmpColor.r, tmpColor.g, tmpColor.b, 1);
      if (p < 0) return;
      const d = soft.data;
      d[p + GRAV] = -2.6; d[p + DRAG] = 1.2;
      d[p + SHAPE] = SHAPE_FISH; d[p + SPIN] = rr(-7, 7); d[p + FREQ] = rr(4, 10);
    }
  }

  function shake(amount) {
    const k = reducedMotion && reducedMotion.matches ? 0.25 : 1;
    trauma = Math.min(1, trauma + (amount || 0) * k);
  }

  function getShakeOffset() {
    return shakeOffset;
  }

  function floatText(x, y, z, text, color) {
    let t = null, oldest = null;
    for (let i = 0; i < texts.length; i++) {
      const it = texts[i];
      if (!it.active) { t = it; break; }
      if (!oldest || it.age > oldest.age) oldest = it;
    }
    if (!t) t = oldest;
    const ctx = t.ctx;
    const str = String(text);
    ctx.clearRect(0, 0, TW, TH);
    let fs = 76;
    ctx.font = `900 ${fs}px "Trebuchet MS", "Segoe UI", "Arial Rounded MT Bold", sans-serif`;
    const w = ctx.measureText(str).width;
    if (w > TW - 30) {
      fs = Math.floor(fs * (TW - 30) / w);
      ctx.font = `900 ${fs}px "Trebuchet MS", "Segoe UI", "Arial Rounded MT Bold", sans-serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(6, fs * 0.2);
    ctx.strokeStyle = 'rgba(35,20,50,0.95)';
    ctx.strokeText(str, TW / 2, TH / 2 + 4);
    ctx.fillStyle = cssColor(color);
    ctx.fillText(str, TW / 2, TH / 2 + 4);
    // glossy highlight on upper half
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(0, 0, TW, TH / 2 - 2);
    ctx.restore();
    t.tex.needsUpdate = true;
    t.active = true; t.age = 0; t.x = x; t.y = y; t.z = z;
    t.sprite.position.set(x, y, z);
    t.mat.opacity = 1;
    t.sprite.visible = true;
  }

  function updateTexts(dt) {
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t.active) continue;
      t.age += dt;
      const k = t.age / TEXT_LIFE;
      if (k >= 1) { t.active = false; t.sprite.visible = false; continue; }
      const e = 1 - (1 - k) * (1 - k);
      t.sprite.position.y = t.y + TEXT_RISE * e;
      t.mat.opacity = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
      const s = t.age / 0.15;
      const pop = s < 1 ? 0.6 + 0.4 * s + 0.25 * Math.sin(s * Math.PI) : 1;
      t.sprite.scale.set(TEXT_WORLD_H * (TW / TH) * pop, TEXT_WORLD_H * pop, 1);
    }
  }

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    time += dt;
    updatePool(glow, dt);
    updatePool(soft, dt);
    updateRings(dt);
    updateCards(dt);
    updateBeams(dt);
    updateTexts(dt);
    updateRockets(dt);
    // shake (trauma model)
    trauma = Math.max(0, trauma - 1.5 * dt);
    const m = SHAKE_MAX * trauma * trauma;
    const t = time;
    shakeOffset.x = m * (Math.sin(t * 31.7) * 0.6 + Math.sin(t * 57.3 + 1.7) * 0.4);
    shakeOffset.y = m * 0.6 * (Math.sin(t * 37.1 + 4.1) * 0.6 + Math.sin(t * 61.9 + 0.3) * 0.4);
    shakeOffset.z = m * (Math.sin(t * 29.3 + 2.9) * 0.6 + Math.sin(t * 53.9 + 5.3) * 0.4);
  }

  return {
    burst, deathPoof, reviveBeam, pickup, teleport, shieldPop, dust, iceKick, confetti, firework, confettiRain, munch,
    shake, getShakeOffset, floatText, update, medicTrail, cosmicTrail, starStep, callingCard,
  };
}

export { createEffects };
