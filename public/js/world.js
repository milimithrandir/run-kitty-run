import * as THREE from 'three';
import { CFG } from './shared/config.js';
import { createRng, hashSeed, TAU } from './shared/rng.js';
import { locate, collideCircle } from './shared/maze.js';
import { QUALITY } from './device.js';
import { WOLF_TYPES, createShieldPile, shieldLeafGeo } from './models.js';

// world.js — maze scenery, decor, ambient particles and lighting. (owner: world agent)
//
// Notes / interpretations:
// - buildWorld adds its group to the scene itself; dispose() removes it and frees every
//   geometry/material/texture it created.
// - THEMES entries carry extra fields beyond the contract (lighting, fog, decor palettes).
// - The theme index is levelData.theme (see THEME_ORDER in maze.js), falling back to (level-1)%THEMES.length.
// - Radial walls are swept walls (same style as ring walls), shortened by half the wall
//   thickness at both ends so they butt against the ring walls.
// - Lantern pillars sit flush at both ends of every gap (inset into the wall end) and every
//   ~9 units along the outer wall. No real point lights: emissive orbs + additive ground glows.
// - setupLighting expects renderer.shadowMap.enabled = true / PCFSoftShadowMap (PCFShadowMap on phones; done in main).


const THEMES = [
  {
    name: 'Sunny Meadow',
    sky: 0x9fd8ff, fog: 0xbfe3f5, fogNear: 48, fogFar: 125,
    ground: 0x86c95f, groundAlt: 0x97d26c, outerGround: 0x7cbf58, plaza: 0xeee2c6,
    wall: 0x3f8e3d, wallTop: 0x8ed86f, accent: 0xfff2a0, lamp: 0xffd27a,
    pillar: 0xe0d6bd, trunk: 0x8a5a3a, rock: 0xa3a39a, tuft: 0x5fae45,
    hemiSky: 0xd8f0ff, hemiGround: 0x5d7a3c, hemiIntensity: 1.2,
    sunColor: 0xfff0d8, sunIntensity: 2.3, glowK: 0.22,
    floorStyle: 'grass', wallStyle: 'hedge', particles: 'pollen', crownEmissive: 0,
    crowns: [0x5cb84a, 0x4aa63f, 0x78c850, 0x3f9a45, 0x8fd35a],
    smalls: [0xffffff, 0xff8fc8, 0xffe14d, 0xb48cff, 0xff6b6b],
    safeStyle: 'summer', safeTint: 0xeeeeee,   // seasonal safe squares (makeSeasonTileTexture / buildSafeProps)
  },
  {
    name: 'Autumn Grove',
    sky: 0xffd9a8, fog: 0xf2cfa4, fogNear: 48, fogFar: 120,
    ground: 0xb9a457, groundAlt: 0xc4ae60, outerGround: 0xab9649, plaza: 0xe3d1b0,
    wall: 0xa8432a, wallTop: 0xf08c3c, accent: 0xffc04a, lamp: 0xffa040,
    pillar: 0xcdb89c, trunk: 0x6b4430, rock: 0x948a7c, tuft: 0xb08d3c,
    hemiSky: 0xffe4c4, hemiGround: 0x6e4a2c, hemiIntensity: 1.1,
    sunColor: 0xffc890, sunIntensity: 2.2, glowK: 0.28,
    floorStyle: 'autumn', wallStyle: 'hedge', particles: 'leaves', crownEmissive: 0,
    crowns: [0xe8642c, 0xd83f2a, 0xf2a03a, 0xf5c542, 0xb8462e],
    smalls: [0xe8642c, 0xd83f2a, 0xf2a03a, 0xf5c542, 0x9c3b22],
    safeStyle: 'autumn', safeTint: 0xeeeeee,
  },
  {
    name: 'Snowy Peaks',
    sky: 0xcfe4f7, fog: 0xdbe9f6, fogNear: 44, fogFar: 115,
    ground: 0xdfe7f3, groundAlt: 0xd2ddee, outerGround: 0xdbe4f1, plaza: 0xbcc8da,
    wall: 0x7f90ab, wallTop: 0xf6f9ff, accent: 0x8fdcff, lamp: 0xffc878,
    pillar: 0x9aa6ba, trunk: 0x5a4636, rock: 0x8d9bb0, tuft: 0xffffff,
    hemiSky: 0xe4eeff, hemiGround: 0x5f7fc0, hemiIntensity: 1.15,
    sunColor: 0xfff4e6, sunIntensity: 1.6, glowK: 0.3,
    floorStyle: 'snow', wallStyle: 'stone', particles: 'snow', crownEmissive: 0,
    crowns: [0x2f6b52, 0x3a7a5e, 0x2a5e4a, 0x497f68, 0xbfd8dc],
    smalls: [0xffffff, 0xd8ecff, 0x9fd8ff],
    safeStyle: 'winter', safeTint: 0xeeeeee,
  },
  {
    name: 'Neon Garden',
    sky: 0x150a2e, fog: 0x1e0f40, fogNear: 30, fogFar: 90,
    ground: 0x2c2650, groundAlt: 0x342c5c, outerGround: 0x221c40, plaza: 0x4a4280,
    wall: 0x352c66, wallTop: 0xff4fd8, accent: 0x3ff6ff, lamp: 0x7cf8ff,
    pillar: 0x40367a, trunk: 0x2a2040, rock: 0x3e3570, tuft: 0x3b2f7a,
    hemiSky: 0x9a84ff, hemiGround: 0x2a1a48, hemiIntensity: 1.2,
    sunColor: 0xb8a8ff, sunIntensity: 1.1, glowK: 0.35,
    floorStyle: 'neon', wallStyle: 'neon', particles: 'motes', crownEmissive: 0.12,
    crowns: [0x5b2fa0, 0x47288a, 0x6a35b0, 0x3a2470, 0x2f6fa0],
    smalls: [0x3ff6ff, 0xff4fd8, 0xb6ff4f, 0xffd24f],
  },
  {
    name: 'Spring Blossom',
    sky: 0xbfe6ff, fog: 0xd8eefa, fogNear: 48, fogFar: 125,
    ground: 0x9edb73, groundAlt: 0xaae27f, outerGround: 0x92d468, plaza: 0xf3e6d8,
    wall: 0x4f9a48, wallTop: 0xf6b8d4, accent: 0xffd0e6, lamp: 0xffd6a0,
    pillar: 0xeadfd0, trunk: 0x6e4a3a, rock: 0xa8a8a0, tuft: 0x6cc24f,
    hemiSky: 0xf0f4ff, hemiGround: 0x6a8a4a, hemiIntensity: 1.2,
    sunColor: 0xfff4ec, sunIntensity: 2.2, glowK: 0.22,
    floorStyle: 'grass', wallStyle: 'hedge', particles: 'leaves', crownEmissive: 0,
    crowns: [0xffb7d5, 0xff9ec7, 0xffc9df, 0xf7a8c8, 0xfff0f6],   // cherry blossom trees (and falling petals)
    smalls: [0xffffff, 0xffb7d5, 0xfff07a, 0xb7e4ff, 0xd6b8ff],
    safeStyle: 'spring', safeTint: 0xe2dede,
  },
];

// The final run (level 9) is a frozen hell: the winter theme with these overrides (see buildWorld). Charred ground
// with ember specks, dark basalt walls with pale caps (the corridor edge must read), dim red lanterns, steel-blue ice
// so the wolves pop, rising embers. The goal room at the end (room*) is the warm, golden reward; the lighting blends
// from HELL_LIGHT to HEAVEN_LIGHT as the camera reaches it (setupLighting).
const HELL = {
  hell: true,
  ground: 0x3a2c2e, groundAlt: 0x3a2c2e, outerGround: 0x3b2a2b, plaza: 0xf2d29a, tile: 0x7a6a6c,
  roomGround: 0xf6dcb0, roomWall: 0xb07a52, roomWallTop: 0xffe6c0, roomLamp: 0xffc870,
  wall: 0x5c4a50, wallTop: 0xa08a8e, accent: 0xff6a3a, lamp: 0xff5a28,
  pillar: 0x3e3234, trunk: 0x2a1e1c, rock: 0x4c3e40, glowK: 0.34,
  floorEmissive: 0xff5a20, floorEmissiveIntensity: 0.55,
  ice: 0xa9bdd4, iceEmissive: 0x24476e,
  particles: 'motes', particlePalette: [0xff7a3a, 0xffa040, 0xd8401c],
  safeStyle: 'hell', safeTint: 0xffffff,   // the start square: charred, cracked, bones at the edges (makeHellTileTextures)
};
// Skate only's night levels (levelData.night): the play area lit exactly as by day (floodlit), only the sky, fog and
// everything beyond the outer walls night. NIGHT_FROST: the walls' [body, cap] emissive per season (theme index): spring
// night frost, autumn's light frost, summer's hail along the hedge tops.
const NIGHT_LIGHT = { sky: 0x0a0f22, fog: 0x0f1630, fogNear: 75, fogFar: 150 };
const NIGHT_GROUND = 0x1a2238, NIGHT_TINT = 0x3b4466, NIGHT_ICE = 0xdcefff;
const NIGHT_SPRING_CAP = { base: 0xf2b6d0, flowers: [0xffffff, 0xffd6e6, 0xff9ec7, 0xfff0f6], big: 1.8 };   // hedge tops in pink blossom
const NIGHT_FROST = { 4: [0x26323f, 0x222c38], 1: [0x2a3446, 0x2a3446], 0: [0, 0x55606e], 2: [0, 0] };
const HELL_LIGHT = { sky: 0x0e0507, fog: 0x1c0a0c, fogNear: 30, fogFar: 88, hemiSky: 0xb898a8, hemiGround: 0x4a1a1a, hemiIntensity: 1.15, sunColor: 0xffb098, sunIntensity: 1.25 };
const HEAVEN_LIGHT = { sky: 0xffd9a8, fog: 0xf5d2a0, fogNear: 48, fogFar: 125, hemiSky: 0xfff0d8, hemiGround: 0x8a6a4a, hemiIntensity: 1.2, sunColor: 0xffe2b8, sunIntensity: 1.9 };

// ---------------------------------------------------------------- small helpers

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function makeTracker() {
  const geos = new Set(), mats = new Set(), texs = new Set();
  return {
    g(x) { geos.add(x); return x; },
    m(x) { mats.add(x); return x; },
    t(x) { texs.add(x); return x; },
    dispose() {
      geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); texs.forEach((x) => x.dispose());
      geos.clear(); mats.clear(); texs.clear();
    },
  };
}

function canvasTex(size, draw, { srgb = true, repeat = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// draw fn at (x,y) plus wrapped copies near edges so the texture tiles seamlessly
function wrapDraw(size, x, y, m, fn) {
  for (let dx = -size; dx <= size; dx += size) {
    for (let dy = -size; dy <= size; dy += size) {
      const px = x + dx, py = y + dy;
      if (px > -m && px < size + m && py > -m && py < size + m) fn(px, py);
    }
  }
}

function blotches(g, S, rng, n, rMin, rMax, light, dark) {
  for (let i = 0; i < n; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(rMin, rMax);
    const col = rng.chance(0.5) ? light : dark;
    const rgb = `${col[0]},${col[1]},${col[2]}`;
    wrapDraw(S, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, `rgba(${rgb},${col[3]})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
    });
  }
}

function makeFloorTextures(style, T) {
  const rng = createRng(hashSeed('floor', style));
  const S = 512;
  let map, emissiveMap = null;
  if (style === 'grass' || style === 'autumn') {
    const autumn = style === 'autumn';
    map = canvasTex(S, (g) => {
      g.fillStyle = autumn ? '#d4cdbf' : '#cfd2cb'; g.fillRect(0, 0, S, S);
      blotches(g, S, rng, 70, 25, 80, [255, 255, 235, 0.22], [60, 70, 30, 0.14]);
      g.lineCap = 'round';
      const blades = autumn ? 1800 : 4200;
      for (let i = 0; i < blades; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(5, 13);
        const ang = -Math.PI / 2 + rng.range(-0.7, 0.7);
        const v = rng.int(165, 255);
        g.strokeStyle = autumn ? `rgb(${v},${(v * 0.95) | 0},${(v * 0.8) | 0})` : `rgb(${(v * 0.93) | 0},${v},${(v * 0.82) | 0})`;
        g.lineWidth = rng.range(1.2, 2.4);
        wrapDraw(S, x, y, 14, (px, py) => {
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); g.stroke();
        });
      }
      if (autumn) {
        const leafCols = ['rgb(255,170,120)', 'rgb(255,130,100)', 'rgb(255,225,140)', 'rgb(140,110,90)', 'rgb(255,200,150)'];
        for (let i = 0; i < 650; i++) {
          const x = rng.range(0, S), y = rng.range(0, S), rx = rng.range(3, 7), ry = rx * rng.range(0.4, 0.6), rot = rng.range(0, TAU);
          g.fillStyle = rng.pick(leafCols);
          wrapDraw(S, x, y, 8, (px, py) => { g.beginPath(); g.ellipse(px, py, rx, ry, rot, 0, TAU); g.fill(); });
        }
      } else {
        // a few tiny clover dots
        for (let i = 0; i < 300; i++) {
          const x = rng.range(0, S), y = rng.range(0, S);
          g.fillStyle = `rgba(255,255,230,${rng.range(0.25, 0.6)})`;
          wrapDraw(S, x, y, 3, (px, py) => { g.beginPath(); g.arc(px, py, rng.range(1, 2.2), 0, TAU); g.fill(); });
        }
      }
    });
  } else if (style === 'snow') {
    map = canvasTex(S, (g) => {
      g.fillStyle = '#f0f2f6'; g.fillRect(0, 0, S, S);
      blotches(g, S, rng, 50, 40, 120, [255, 255, 255, 0.35], [150, 175, 225, 0.14]);
      for (let i = 0; i < 700; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(0.8, 2.2);
        g.fillStyle = `rgba(160,185,230,${rng.range(0.05, 0.12)})`;
        wrapDraw(S, x, y, 6, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill(); });
      }
    });
    emissiveMap = canvasTex(S, (g) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 260; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), v = rng.int(120, 255);
        g.fillStyle = `rgb(${v},${v},${v})`;
        const s = rng.chance(0.15) ? 2 : 1;
        g.fillRect(x, y, s, s);
      }
    });
  } else {
    // neon: dark tiles + glowing grid emissive map
    const N = 4, ts = S / N;
    map = canvasTex(S, (g) => {
      g.fillStyle = '#6a6a80'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const v = rng.int(185, 235);
        g.fillStyle = `rgb(${v},${v},${(v * 1.04) | 0})`;
        g.fillRect(i * ts + 3, j * ts + 3, ts - 6, ts - 6);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(i * ts + 3, j * ts + 3, ts - 6, (ts - 6) * 0.4);
      }
    });
    emissiveMap = canvasTex(S, (g) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      for (const [w, a] of [[8, 0.18], [3, 0.55], [1.2, 1]]) {
        g.strokeStyle = `rgba(255,255,255,${a})`; g.lineWidth = w;
        for (let i = 0; i <= N; i++) {
          g.beginPath(); g.moveTo(i * ts, 0); g.lineTo(i * ts, S); g.stroke();
          g.beginPath(); g.moveTo(0, i * ts); g.lineTo(S, i * ts); g.stroke();
        }
      }
    });
  }
  T.t(map); if (emissiveMap) T.t(emissiveMap);
  return { map, emissiveMap };
}

// ---- seasonal safe squares (the wolf-free corner squares): a stone tile themed per season, always with a paw print
// in the middle (safe = paw print), plus a few small props round its corners (see buildSafeProps). Purely cosmetic.

function rrect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

// A paw print centred on (cx, cy); k scales the 256-px original. rim: a soft outline drawn under it.
function drawPaw(g, cx, cy, k, fill, rim, rimW = 6) {
  const pads = [[0, 14, 30, 25, 0], [-37, -14, 11, 14, -0.35], [-14, -37, 12, 15, -0.12], [14, -37, 12, 15, 0.12], [37, -14, 11, 14, 0.35]];
  const path = (grow) => {
    g.beginPath();
    for (const [dx, dy, rx, ry, rot] of pads) {
      const x = cx + dx * k, y = cy + dy * k;
      g.moveTo(x + Math.cos(rot) * (rx * k + grow), y + Math.sin(rot) * (rx * k + grow));
      g.ellipse(x, y, rx * k + grow, ry * k + grow, rot, 0, TAU);
    }
  };
  if (rim) { g.fillStyle = rim; path(rimW * k); g.fill(); }
  g.fillStyle = fill; path(0); g.fill();
}

// Bevelled slab: base colour, a light top-left edge and a darker bottom-right edge, plus fine speckle.
function drawSlab(g, rng, x, y, w, h, r, [cr, cg, cb], speck = 40) {
  rrect(g, x, y, w, h, r); g.fillStyle = `rgb(${cr},${cg},${cb})`; g.fill();
  g.save(); rrect(g, x, y, w, h, r); g.clip();
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(0.35, 'rgba(255,255,255,0)');
  gr.addColorStop(0.7, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.16)');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  for (let i = 0; i < speck; i++) {
    g.fillStyle = rng.chance(0.5) ? 'rgba(255,255,255,0.18)' : 'rgba(60,40,20,0.10)';
    g.beginPath(); g.arc(x + rng.range(0, w), y + rng.range(0, h), rng.range(0.8, 2.2), 0, TAU); g.fill();
  }
  g.restore();
}

function drawLeaf(g, x, y, len, rot, col) {
  g.save(); g.translate(x, y); g.rotate(rot);
  g.fillStyle = col;
  g.beginPath(); g.moveTo(-len, 0); g.quadraticCurveTo(0, -len * 0.62, len, 0); g.quadraticCurveTo(0, len * 0.62, -len, 0); g.fill();
  g.strokeStyle = 'rgba(90,40,20,0.45)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(-len * 1.25, 0); g.lineTo(len * 0.8, 0); g.stroke();
  g.restore();
}

function drawBlossom(g, x, y, r, petal, centre, rot = 0) {
  g.fillStyle = petal;
  for (let k = 0; k < 5; k++) {
    const a = rot + k / 5 * TAU;
    g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62, r * 0.5, r * 0.36, a, 0, TAU); g.fill();
  }
  g.fillStyle = centre; g.beginPath(); g.arc(x, y, r * 0.3, 0, TAU); g.fill();
}

// spring look (safe squares, their flowers, hedge tops): 'daisy' (current), 'bluebell' (blue / lilac) or 'pink'
// (the original cherry-blossom one)
const SPRING_LOOK = 'daisy';
const SPRING_CAPS = {
  pink: null,
  daisy: { base: 0x6fbf4f, flowers: [0xffffff, 0xffe066] },
  bluebell: { base: 0x5fae4a, flowers: [0x8fa4f0, 0xb8a4f4, 0xffffff] },
};

function makeSeasonTileTexture(style, T) {
  const rng = createRng(hashSeed('safeTile', style));
  const S = 512, C = S / 2;
  // keep scattered bits off the paw print
  const nearPaw = (x, y, m = 0) => Math.hypot(x - C, y - C + 6) < 118 + m;
  return T.t(canvasTex(S, (g) => {
    if (style === 'summer') {
      // warm sandstone slabs inside a frame of terracotta tiles, a sun inlay behind a terracotta paw
      g.fillStyle = '#b98d62'; g.fillRect(0, 0, S, S);
      const n = 8, cell = S / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i > 0 && i < n - 1 && j > 0 && j < n - 1) continue;
        drawSlab(g, rng, i * cell + 4, j * cell + 4, cell - 8, cell - 8, 8, [rng.int(200, 222), rng.int(112, 132), rng.int(74, 90)], 18);
      }
      const inner = (S - 2 * cell) / 3;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        drawSlab(g, rng, cell + i * inner + 4, cell + j * inner + 4, inner - 8, inner - 8, 10, [rng.int(236, 248), rng.int(212, 226), rng.int(164, 180)], 60);
      }
      // the sun: a warm disc with rays
      g.fillStyle = 'rgba(244,184,70,0.85)';
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * TAU, a0 = a - 0.11, a1 = a + 0.11;
        g.beginPath(); g.moveTo(C + Math.cos(a0) * 96, C + Math.sin(a0) * 96); g.lineTo(C + Math.cos(a) * 138, C + Math.sin(a) * 138); g.lineTo(C + Math.cos(a1) * 96, C + Math.sin(a1) * 96); g.fill();
      }
      g.fillStyle = 'rgb(250,206,96)'; g.beginPath(); g.arc(C, C, 100, 0, TAU); g.fill();
      g.strokeStyle = 'rgb(236,160,64)'; g.lineWidth = 5; g.beginPath(); g.arc(C, C, 100, 0, TAU); g.stroke();
      drawPaw(g, C, C + 4, 1.45, 'rgb(196,98,58)', null);
      // a few loose grass blades creeping in at the frame
      g.lineCap = 'round';
      for (let i = 0; i < 160; i++) {
        const side = rng.int(0, 3), t = rng.range(0, S), d = rng.range(0, 22);
        const x = side === 0 ? t : side === 1 ? S - d : side === 2 ? t : d, y = side === 0 ? d : side === 1 ? t : side === 2 ? S - d : t;
        const a = rng.range(0, TAU), len = rng.range(5, 11);
        g.strokeStyle = `rgba(${rng.int(80, 120)},${rng.int(150, 185)},${rng.int(50, 80)},0.85)`; g.lineWidth = rng.range(1.5, 2.6);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
      }
    } else if (style === 'autumn') {
      // mossy cobblestones, a curb frame, an amber paw and fallen leaves drifted to the edges
      g.fillStyle = '#8c7c58'; g.fillRect(0, 0, S, S);
      const n = 8, cell = S / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const jx = rng.range(-5, 5), jy = rng.range(-5, 5), w = cell - rng.range(7, 12), h = cell - rng.range(7, 12);
        const v = rng.int(205, 232);
        drawSlab(g, rng, i * cell + (cell - w) / 2 + jx, j * cell + (cell - h) / 2 + jy, w, h, 22, [v, (v * 0.93) | 0, (v * 0.8) | 0], 30);
      }
      // moss in the joints, thicker toward the edges
      for (let i = 0; i < 260; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), edge = Math.min(x, y, S - x, S - y);
        if (rng.chance(edge / 200)) continue;
        const r = rng.range(5, 16), gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(104,138,58,0.55)'); gr.addColorStop(1, 'rgba(104,138,58,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      g.strokeStyle = 'rgb(120,96,62)'; g.lineWidth = 12; g.strokeRect(6, 6, S - 12, S - 12);
      g.strokeStyle = 'rgb(226,204,160)'; g.lineWidth = 6; g.strokeRect(6, 6, S - 12, S - 12);
      // amber paw on a round millstone inlay
      g.fillStyle = 'rgb(140,104,66)'; g.beginPath(); g.arc(C, C, 108, 0, TAU); g.fill();
      g.fillStyle = 'rgb(240,222,184)'; g.beginPath(); g.arc(C, C, 100, 0, TAU); g.fill();
      drawPaw(g, C, C + 4, 1.45, 'rgb(232,124,40)', 'rgb(150,70,30)', 5);
      const cols = ['rgb(230,108,40)', 'rgb(206,62,40)', 'rgb(242,170,58)', 'rgb(245,200,72)', 'rgb(160,78,40)'];
      for (let i = 0; i < 150; i++) {
        let x, y, tries = 0;
        do { x = rng.range(10, S - 10); y = rng.range(10, S - 10); tries++; } while ((nearPaw(x, y, 8) || (Math.min(x, y, S - x, S - y) > 90 && rng.chance(0.75))) && tries < 20);
        if (nearPaw(x, y, 8)) continue;
        drawLeaf(g, x, y, rng.range(7, 13), rng.range(0, TAU), rng.pick(cols));
      }
    } else if (style === 'winter') {
      // "cats enjoy warmth": a warm hearth in the cold. Amber/terracotta flagstones warmed by golden light pooling in
      // the middle, the snow melted back to a thin drift round the rim (a dark wet line where it's thawing), ember
      // specks and a warm terracotta paw. Warm and solid: reads clearly as ground next to the pale blue ice.
      g.fillStyle = 'rgb(150,98,66)'; g.fillRect(0, 0, S, S);
      const n = 4, cell = S / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const terra = rng.chance(0.3);
        const col = terra ? [rng.int(212, 226), rng.int(140, 156), rng.int(100, 114)] : [rng.int(226, 240), rng.int(180, 198), rng.int(126, 144)];
        drawSlab(g, rng, i * cell + 6, j * cell + 6, cell - 12, cell - 12, 14, col, 60);
      }
      // golden light pooling on the stone
      let gr = g.createRadialGradient(C, C, 20, C, C, 230);
      gr.addColorStop(0, 'rgba(255,210,120,0.55)'); gr.addColorStop(0.6, 'rgba(255,190,100,0.25)'); gr.addColorStop(1, 'rgba(255,190,100,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      // thaw: darker wet stone just inside the rim, then the last of the snow drifted against the edges
      for (const [x0, y0, x1, y1] of [[0, 0, 0, 1], [0, 0, 1, 0], [S, 0, -1, 0], [0, S, 0, -1]]) {
        const lg = g.createLinearGradient(x0, y0, x0 + x1 * 60, y0 + y1 * 60);
        lg.addColorStop(0, 'rgba(80,50,34,0.35)'); lg.addColorStop(1, 'rgba(80,50,34,0)');
        g.fillStyle = lg; g.fillRect(0, 0, S, S);
      }
      for (let i = 0; i < 150; i++) {
        const side = rng.int(0, 3), t = rng.range(0, S), d = rng.range(-6, 10);
        const x = side === 0 ? t : side === 1 ? S - d : side === 2 ? t : d, y = side === 0 ? d : side === 1 ? t : side === 2 ? S - d : t;
        const r = rng.range(8, 20), sg = g.createRadialGradient(x, y, 0, x, y, r);
        sg.addColorStop(0, 'rgba(252,252,255,0.95)'); sg.addColorStop(0.65, 'rgba(244,247,252,0.8)'); sg.addColorStop(1, 'rgba(244,247,252,0)');
        g.fillStyle = sg; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      // drips of meltwater glinting near the rim
      for (let i = 0; i < 40; i++) {
        const side = rng.int(0, 3), t = rng.range(20, S - 20), d = rng.range(22, 40);
        const x = side === 0 ? t : side === 1 ? S - d : side === 2 ? t : d, y = side === 0 ? d : side === 1 ? t : side === 2 ? S - d : t;
        g.fillStyle = 'rgba(110,70,48,0.35)'; g.beginPath(); g.ellipse(x, y, rng.range(3, 7), rng.range(2, 4), rng.range(0, TAU), 0, TAU); g.fill();
      }
      // a warm hearthstone ring round the paw
      gr = g.createRadialGradient(C, C, 70, C, C, 118);
      gr.addColorStop(0, 'rgba(255,214,140,0.85)'); gr.addColorStop(1, 'rgba(255,214,140,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(C, C, 118, 0, TAU); g.fill();
      g.strokeStyle = 'rgb(176,96,52)'; g.lineWidth = 6; g.beginPath(); g.arc(C, C, 104, 0, TAU); g.stroke();
      drawPaw(g, C, C + 4, 1.45, 'rgb(206,92,44)', 'rgb(255,226,160)', 5);
      // a few glowing ember specks
      for (let i = 0; i < 40; i++) {
        const a = rng.range(0, TAU), r = rng.range(110, 200), x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
        g.fillStyle = rng.pick(['rgba(255,150,60,0.9)', 'rgba(255,200,100,0.9)', 'rgba(230,90,40,0.8)']);
        g.beginPath(); g.arc(x, y, rng.range(1.5, 3), 0, TAU); g.fill();
      }
    } else if (SPRING_LOOK !== 'pink') {
      const daisy = SPRING_LOOK === 'daisy';
      // spring, daisy: pale limestone flags with mossy joints, a big daisy inlay behind a butter-yellow paw, daisies
      //   and buttercups in the corners. bluebell: cool grey-blue flags, a bluebell-blue ring, a periwinkle paw.
      g.fillStyle = '#8fbf62'; g.fillRect(0, 0, S, S);
      const n = 4, cell = S / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const alt = rng.chance(0.3);
        const col = daisy
          ? (alt ? [rng.int(236, 246), rng.int(226, 236), rng.int(186, 198)] : [rng.int(228, 238), rng.int(226, 234), rng.int(212, 222)])
          : (alt ? [rng.int(206, 216), rng.int(214, 224), rng.int(232, 242)] : [rng.int(226, 236), rng.int(228, 236), rng.int(232, 240)]);
        drawSlab(g, rng, i * cell + 6, j * cell + 6, cell - 12, cell - 12, 16, col, 50);
      }
      if (daisy) {
        // the daisy: a ring of long white petals round a yellow heart, the paw on the heart
        for (let k = 0; k < 20; k++) {
          const a = k / 20 * TAU;
          g.fillStyle = k % 2 ? 'rgb(255,255,252)' : 'rgb(246,246,238)';
          g.beginPath(); g.ellipse(C + Math.cos(a) * 112, C + Math.sin(a) * 112, 44, 15, a, 0, TAU); g.fill();
        }
        g.fillStyle = 'rgb(255,214,72)'; g.beginPath(); g.arc(C, C, 98, 0, TAU); g.fill();
        g.strokeStyle = 'rgb(236,170,40)'; g.lineWidth = 5; g.beginPath(); g.arc(C, C, 98, 0, TAU); g.stroke();
        drawPaw(g, C, C + 4, 1.4, 'rgb(232,150,30)', 'rgba(255,250,220,0.95)', 5);
      } else {
        g.fillStyle = 'rgba(150,176,240,0.75)'; g.beginPath(); g.arc(C, C, 102, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5; g.beginPath(); g.arc(C, C, 102, 0, TAU); g.stroke();
        drawPaw(g, C, C + 4, 1.45, 'rgb(96,112,214)', 'rgba(255,255,255,0.9)', 5);
      }
      const fl = daisy
        ? [['rgb(255,255,255)', 'rgb(255,206,60)'], ['rgb(255,226,80)', 'rgb(240,160,40)'], ['rgb(255,255,255)', 'rgb(255,206,60)'], ['rgb(255,244,170)', 'rgb(236,170,50)']]
        : [['rgb(120,140,230)', 'rgb(255,236,130)'], ['rgb(170,150,240)', 'rgb(255,236,130)'], ['rgb(255,255,255)', 'rgb(255,206,60)'], ['rgb(140,180,250)', 'rgb(255,255,255)']];
      for (const [x0, y0] of [[0, 0], [S, 0], [0, S], [S, S]]) {
        for (let k = 0; k < 9; k++) {
          const x = x0 + (x0 ? -1 : 1) * rng.range(10, 70), y = y0 + (y0 ? -1 : 1) * rng.range(10, 70);
          if (Math.hypot(x - x0, y - y0) > 80) continue;
          const [p, c] = rng.pick(fl);
          drawBlossom(g, x, y, rng.range(8, 13), p, c, rng.range(0, TAU));
        }
      }
      // a few loose petals and clover leaves
      for (let i = 0; i < 90; i++) {
        const x = rng.range(8, S - 8), y = rng.range(8, S - 8);
        if (nearPaw(x, y, 14)) continue;
        if (rng.chance(0.35)) { drawBlossom(g, x, y, rng.range(4, 6), 'rgba(110,170,70,0.85)', 'rgba(110,170,70,0.85)', rng.range(0, TAU)); continue; }
        g.fillStyle = rng.pick(daisy ? ['rgb(255,255,255)', 'rgb(255,236,140)', 'rgb(250,250,240)'] : ['rgb(150,170,240)', 'rgb(190,176,246)', 'rgb(255,255,255)']);
        g.beginPath(); g.ellipse(x, y, rng.range(3.5, 6), rng.range(2.2, 3.5), rng.range(0, TAU), 0, TAU); g.fill();
      }
    } else {
      // spring: pale cream flags with mossy joints, a pink paw, blossom petals and little flowers in the corners
      g.fillStyle = '#93c06c'; g.fillRect(0, 0, S, S);
      const n = 4, cell = S / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const pink = rng.chance(0.3);
        const col = pink ? [rng.int(236, 246), rng.int(200, 212), rng.int(206, 218)] : [rng.int(234, 244), rng.int(222, 232), rng.int(200, 214)];
        drawSlab(g, rng, i * cell + 6, j * cell + 6, cell - 12, cell - 12, 16, col, 50);
      }
      g.fillStyle = 'rgba(255,178,206,0.7)'; g.beginPath(); g.arc(C, C, 102, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5; g.beginPath(); g.arc(C, C, 102, 0, TAU); g.stroke();
      drawPaw(g, C, C + 4, 1.45, 'rgb(232,112,158)', 'rgba(255,255,255,0.9)', 5);
      // corner flower clusters
      const fl = [['rgb(255,255,255)', 'rgb(255,206,60)'], ['rgb(255,170,205)', 'rgb(255,236,130)'], ['rgb(200,170,255)', 'rgb(255,236,130)'], ['rgb(255,232,110)', 'rgb(240,150,50)']];
      for (const [x0, y0] of [[0, 0], [S, 0], [0, S], [S, S]]) {
        for (let k = 0; k < 9; k++) {
          const x = x0 + (x0 ? -1 : 1) * rng.range(10, 70), y = y0 + (y0 ? -1 : 1) * rng.range(10, 70);
          if (Math.hypot(x - x0, y - y0) > 80) continue;
          const [p, c] = rng.pick(fl);
          drawBlossom(g, x, y, rng.range(8, 13), p, c, rng.range(0, TAU));
        }
      }
      // drifting petals
      for (let i = 0; i < 120; i++) {
        const x = rng.range(8, S - 8), y = rng.range(8, S - 8);
        if (nearPaw(x, y, 6)) continue;
        g.fillStyle = rng.pick(['rgb(250,150,190)', 'rgb(255,186,212)', 'rgb(255,255,255)', 'rgb(238,120,170)']);
        g.beginPath(); g.ellipse(x, y, rng.range(3.5, 6), rng.range(2.2, 3.5), rng.range(0, TAU), 0, TAU); g.fill();
      }
    }
  }, { repeat: false }));
}

// The final run's start square: "welcome to a scary place". Cracked charred basalt with ember-lit cracks, a scorched
// paw print with a smouldering rim, claw gouges and soot. Returns { map, emissiveMap }: the cracks glow dimly through
// the emissive map (no glare: dim orange, intensity set on the material).
function makeHellTileTextures(T) {
  const rng = createRng(hashSeed('safeTile', 'hell'));
  const S = 512, C = S / 2;
  const cracks = [];
  // slab seams (jittered grid) + branching cracks across the slabs
  const n = 4, cell = S / n, jit = [];
  for (let i = 0; i <= n; i++) { jit.push([]); for (let j = 0; j <= n; j++) jit[i].push([i * cell + (i % n ? rng.range(-14, 14) : 0), j * cell + (j % n ? rng.range(-14, 14) : 0)]); }
  for (let k = 0; k < 22; k++) {
    let x = rng.range(20, S - 20), y = rng.range(20, S - 20), a = rng.range(0, TAU);
    const pts = [[x, y]], len = rng.int(4, 9);
    for (let s = 0; s < len; s++) { a += rng.range(-0.7, 0.7); x += Math.cos(a) * rng.range(10, 24); y += Math.sin(a) * rng.range(10, 24); pts.push([x, y]); }
    cracks.push({ pts, w: rng.range(1.2, 2.6) });
  }
  const claws = [];
  for (const [cx, cy, rot] of [[110, 120, 0.5], [400, 390, -2.6], [395, 110, 2.4]]) {
    for (let k = -1; k <= 1; k++) claws.push({ cx, cy, rot, k });
  }
  const clawPath = (g, { cx, cy, rot, k }) => {
    g.save(); g.translate(cx, cy); g.rotate(rot);
    g.beginPath(); g.moveTo(-42, k * 15 - 6); g.quadraticCurveTo(0, k * 15 + 6, 44, k * 15 - 2); g.restore();
  };
  const crackPath = (g, c) => { g.beginPath(); g.moveTo(c.pts[0][0], c.pts[0][1]); for (const [x, y] of c.pts) g.lineTo(x, y); };
  const map = T.t(canvasTex(S, (g) => {
    g.fillStyle = 'rgb(24,18,20)'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = [jit[i][j], jit[i + 1][j], jit[i + 1][j + 1], jit[i][j + 1]], v = rng.int(54, 72);
      g.save(); g.beginPath(); p.forEach(([x, y], q) => (q ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.clip();
      g.fillStyle = `rgb(${v},${(v * 0.84) | 0},${(v * 0.86) | 0})`; g.fillRect(0, 0, S, S);
      for (let s = 0; s < 70; s++) { g.fillStyle = rng.chance(0.5) ? 'rgba(255,240,230,0.06)' : 'rgba(0,0,0,0.18)'; g.beginPath(); g.arc(rng.range(0, S), rng.range(0, S), rng.range(1, 3), 0, TAU); g.fill(); }
      g.restore();
    }
    // the seams between the slabs
    g.strokeStyle = 'rgb(16,10,10)'; g.lineWidth = 7;
    for (let i = 0; i <= n; i++) for (let j = 0; j < n; j++) {
      g.beginPath(); g.moveTo(...jit[i][j]); g.lineTo(...jit[i][j + 1]); g.stroke();
      g.beginPath(); g.moveTo(...jit[j][i]); g.lineTo(...jit[j + 1][i]); g.stroke();
    }
    blotches(g, S, rng, 30, 30, 90, [0, 0, 0, 0.35], [70, 20, 10, 0.25]);   // soot and scorch
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const c of cracks) { crackPath(g, c); g.strokeStyle = 'rgb(12,6,6)'; g.lineWidth = c.w + 2.5; g.stroke(); crackPath(g, c); g.strokeStyle = 'rgb(170,60,24)'; g.lineWidth = c.w * 0.6; g.stroke(); }
    for (const cl of claws) { clawPath(g, cl); g.strokeStyle = 'rgb(10,6,6)'; g.lineWidth = 9; g.stroke(); clawPath(g, cl); g.strokeStyle = 'rgb(150,50,20)'; g.lineWidth = 2.5; g.stroke(); }
    // scorched burn round the paw, then the paw itself: charcoal with an ember rim
    const gr = g.createRadialGradient(C, C, 40, C, C, 130);
    gr.addColorStop(0, 'rgba(8,4,4,0.85)'); gr.addColorStop(1, 'rgba(8,4,4,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(C, C, 130, 0, TAU); g.fill();
    drawPaw(g, C, C + 4, 1.45, 'rgb(20,12,12)', 'rgb(190,70,26)', 5);
  }, { repeat: false }));
  const emissiveMap = T.t(canvasTex(S, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowColor = 'rgb(255,90,20)'; g.shadowBlur = 10;
    for (const c of cracks) { crackPath(g, c); g.strokeStyle = 'rgb(255,120,40)'; g.lineWidth = c.w * 0.8; g.stroke(); }
    for (const cl of claws) { clawPath(g, cl); g.strokeStyle = 'rgb(230,80,24)'; g.lineWidth = 2.5; g.stroke(); }
    g.shadowBlur = 16;
    drawPaw(g, C, C + 4, 1.45, '#000', 'rgb(255,110,30)', 5);
    g.shadowBlur = 0;
    drawPaw(g, C, C + 4, 1.45, '#000', null);   // the paw itself stays dark: only its rim smoulders
  }, { repeat: false }));
  return { map, emissiveMap };
}

// Small props round the corners of every safe square, themed per season (instanced; one shared vertex-colour material).
// Kept low (< ~0.6 tall) and tucked into the corners so they never hide a kitty. A checkpoint's flag corner is left clear.
function buildSafeProps(levelData, style, T) {
  const rng = createRng(hashSeed('safeProps', levelData.seed ?? 1, levelData.level ?? 1));
  const size = (levelData.safeSize || levelData.corridorWidth) - CFG.WALL_THICKNESS, h = size / 2;
  const mat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));
  const blade = (x, z, col, hgt = 0.36) => {
    const a = rng.range(0, TAU);
    return paint(place(new THREE.ConeGeometry(0.05, hgt, 3), x + Math.cos(a) * 0.05, hgt / 2, z + Math.sin(a) * 0.05, 1, rng.range(0.75, 1.2), 1, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35), col);
  };
  const flower = (x, z, y, petal, centre, r = 0.075) => {
    const out = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      out.push(paint(place(new THREE.OctahedronGeometry(r, 0), x + Math.cos(a) * r * 1.1, y, z + Math.sin(a) * r * 1.1, 1, 0.35, 0.65, 0, -a, 0), petal));
    }
    out.push(paint(place(new THREE.OctahedronGeometry(r * 0.7, 0), x, y + 0.02, z, 1, 0.6, 1), centre));
    out.push(paint(place(new THREE.CylinderGeometry(0.014, 0.014, y, 4), x, y / 2, z), 0x4f9a3a));
    return out;
  };
  const tuft = (col, n = 7, spread = 0.12, hgt = 0.36) => {
    const out = [];
    for (let k = 0; k < n; k++) out.push(blade(rng.range(-spread, spread), rng.range(-spread, spread), col, hgt * rng.range(0.8, 1.15)));
    return out;
  };
  const kinds = [];   // [geometry, weight, scaleRange]
  if (style === 'summer') {
    kinds.push([mergeGeos([...tuft(0x5fae45, 8), ...flower(0.08, 0.02, 0.34, 0xffd84a, 0xff9a2a), ...flower(-0.12, -0.08, 0.27, 0xffd84a, 0xff9a2a, 0.06)]), 2, [1.3, 1.7]]);
    kinds.push([mergeGeos([...tuft(0x6cbc4a, 7), ...flower(-0.06, 0.08, 0.32, 0xffffff, 0xffc830), ...flower(0.13, -0.06, 0.26, 0xff5a4a, 0x3a2420, 0.065)]), 2, [1.3, 1.7]]);
    kinds.push([mergeGeos(tuft(0x58a640, 10, 0.18, 0.42)), 1, [1, 1.4]]);
  } else if (style === 'autumn') {
    const pumpkin = [];
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; pumpkin.push(paint(place(new THREE.SphereGeometry(0.16, 8, 6), Math.cos(a) * 0.09, 0.15, Math.sin(a) * 0.09, 0.85, 0.9, 0.85, 0, -a, 0), 0xe8792a)); }
    pumpkin.push(paint(place(new THREE.SphereGeometry(0.15, 8, 6), 0, 0.17, 0, 1, 0.9, 1), 0xf08a32));
    pumpkin.push(paint(place(new THREE.CylinderGeometry(0.025, 0.04, 0.12, 5), 0.01, 0.33, 0, 1, 1, 1, 0, 0, -0.3), 0x4f6a24));
    pumpkin.push(paint(place(new THREE.SphereGeometry(0.07, 6, 4), 0.09, 0.3, 0.03, 1.2, 0.25, 0.7, 0, 0.5, 0), 0x5f8a2c));
    kinds.push([mergeGeos(pumpkin), 2, [1.4, 2.0]]);
    const mush = (x, z, s, cap) => [
      paint(place(new THREE.CylinderGeometry(0.045 * s, 0.06 * s, 0.2 * s, 6), x, 0.1 * s, z), 0xf2ead8),
      paint(place(new THREE.SphereGeometry(0.15 * s, 10, 5, 0, TAU, 0, Math.PI / 2), x, 0.18 * s, z, 1, 0.7, 1), cap),
      ...[0, 2.1, 4.2].map((a) => paint(place(new THREE.IcosahedronGeometry(0.025 * s, 0), x + Math.cos(a) * 0.08 * s, 0.25 * s, z + Math.sin(a) * 0.08 * s), 0xfff6e8)),
    ];
    kinds.push([mergeGeos([...mush(0, 0, 1.2, 0xd8402a), ...mush(0.17, 0.1, 0.8, 0xd8402a), ...mush(-0.12, 0.14, 0.65, 0xc8662a)]), 2, [1, 1.35]]);
    const leafShape = new THREE.Shape();
    leafShape.moveTo(-0.5, 0); leafShape.quadraticCurveTo(0, 0.32, 0.5, 0); leafShape.quadraticCurveTo(0, -0.32, -0.5, 0);
    const leaves = [];
    for (let k = 0; k < 5; k++) {
      const lg = new THREE.ShapeGeometry(leafShape, 3); lg.rotateX(-Math.PI / 2);
      leaves.push(paint(place(lg, rng.range(-0.3, 0.3), 0.02 + k * 0.006, rng.range(-0.3, 0.3), 0.3, 1, 0.3, rng.range(-0.15, 0.15), rng.range(0, TAU), 0), [0xe8642c, 0xd83f2a, 0xf2a03a, 0xf5c542, 0xb8462e][k]));
    }
    kinds.push([mergeGeos(leaves), 1, [1, 1.3]]);
  } else if (style === 'winter') {
    // "cats enjoy warmth": a warm refuge in the cold. Little campfires, glowing lanterns and a cushion on a folded
    // blanket at the corners; the fire and lantern light are unlit (always warm) and pool softly on the tile.
    const STONE = 0x9a8878, LOG = 0x7a4a2c, LOG2 = 0x5e3820;
    const fire = [], flames = [];
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * TAU;
      fire.push(paint(place(new THREE.DodecahedronGeometry(0.075, 0), Math.cos(a) * 0.3, 0.05, Math.sin(a) * 0.3, 1.2, 0.8, 1, 0, a, 0), k % 2 ? STONE : 0xb09c88));
    }
    fire.push(paint(place(new THREE.CylinderGeometry(0.25, 0.25, 0.02, 10), 0, 0.01, 0), 0x3a2018));   // ash bed
    for (const [a, c] of [[0.3, LOG], [1.35, LOG2], [2.4, LOG]]) {
      const lg = new THREE.CylinderGeometry(0.045, 0.05, 0.42, 6);
      lg.rotateX(Math.PI / 2 - 0.25); lg.rotateY(a); lg.translate(0, 0.08, 0);   // leaning in, tipi-style
      fire.push(paint(lg, c));
    }
    flames.push(paint(place(new THREE.ConeGeometry(0.17, 0.5, 6), 0, 0.31, 0), 0xff6a24));
    flames.push(paint(place(new THREE.ConeGeometry(0.1, 0.34, 6), 0.08, 0.24, 0.06, 1, 1, 1, 0, 0, -0.25), 0xff9a34));
    flames.push(paint(place(new THREE.ConeGeometry(0.1, 0.32, 6), 0, 0.24, 0.08), 0xffb83a));
    flames.push(paint(place(new THREE.IcosahedronGeometry(0.11, 0), 0, 0.09, 0, 1.6, 0.4, 1.6), 0xd8441c));   // the embers
    kinds.push([mergeGeos(fire), 1, [1.2, 1.4], null, mergeGeos(flames), { s: 3.8, color: 0xff8a2a }]);
    // a lantern: a stone foot, a wooden post and a little lamp house with a warm glowing core
    kinds.push([mergeGeos([
      paint(place(new THREE.CylinderGeometry(0.13, 0.16, 0.08, 8), 0, 0.04, 0), STONE),
      paint(place(new THREE.CylinderGeometry(0.035, 0.04, 0.5, 6), 0, 0.33, 0), LOG),
      paint(place(new THREE.BoxGeometry(0.2, 0.03, 0.2), 0, 0.59, 0), 0x4a3020),
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => paint(place(new THREE.BoxGeometry(0.025, 0.2, 0.025), sx * 0.085, 0.7, sz * 0.085), 0x4a3020)),
      paint(place(new THREE.ConeGeometry(0.11, 0.1, 4), 0, 0.9, 0, 1, 1, 1, 0, Math.PI / 4, 0), 0x6a3a26),
    ]), 2, [1.1, 1.3], null, mergeGeos([paint(place(new THREE.IcosahedronGeometry(0.125, 1), 0, 0.72, 0, 1, 1.2, 1), 0xffb84a)]), { s: 2.6, color: 0xffa03a }]);
    // a plump cushion on a folded woollen blanket (warm red with cream stripes)
    const blanket = [paint(place(new THREE.BoxGeometry(0.62, 0.05, 0.46), 0, 0.025, 0), 0xc8442e)];
    for (const x of [-0.2, 0, 0.2]) blanket.push(paint(place(new THREE.BoxGeometry(0.05, 0.052, 0.462), x, 0.026, 0), 0xf2dcb0));
    blanket.push(paint(place(new THREE.SphereGeometry(0.2, 12, 8), 0.04, 0.12, 0.02, 1, 0.38, 0.9), 0xe8a040));
    blanket.push(paint(place(new THREE.IcosahedronGeometry(0.03, 1), 0.04, 0.2, 0.02), 0xf2dcb0));
    kinds.push([mergeGeos(blanket), 1, [1.2, 1.4], 'face']);
  } else if (style === 'spring') {
    const tulip = (x, z, y, col) => [
      paint(place(new THREE.CylinderGeometry(0.015, 0.015, y, 4), x, y / 2, z), 0x4f9a3a),
      paint(place(new THREE.CylinderGeometry(0.075, 0.045, 0.13, 6), x, y + 0.05, z), col),
      paint(place(new THREE.ConeGeometry(0.05, 0.3, 3), x + 0.05, 0.13, z, 1, 1, 0.4, 0, 0.3, -0.35), 0x5fae45),
    ];
    // tulip / flower colours per SPRING_LOOK: [tulip 1, 2, 3, 4, 5, small flower, its centre, small flower 2]
    const P = {
      pink: [0xff7fb4, 0xffd84a, 0xff9ec8, 0xc8a0ff, 0xffffff, 0xffb7d5, 0xfff07a, 0xffb7d5],
      daisy: [0xffd84a, 0xffffff, 0xffb83a, 0xfff0a0, 0xffffff, 0xffffff, 0xffd040, 0xfff07a],
      bluebell: [0x8fa4f0, 0xffffff, 0xb8a4f4, 0x7088e0, 0xffffff, 0xb7c8ff, 0xfff07a, 0xd6c8ff],
    }[SPRING_LOOK];
    kinds.push([mergeGeos([...tulip(0, 0, 0.34, P[0]), ...tulip(0.14, 0.07, 0.28, P[1]), ...tulip(-0.11, 0.1, 0.3, P[2]), ...tuft(0x6cc24f, 5, 0.12, 0.28)]), 2, [1.3, 1.7]]);
    kinds.push([mergeGeos([...tulip(0.05, -0.04, 0.32, P[3]), ...tulip(-0.1, 0.06, 0.27, P[4]), ...flower(0.14, 0.12, 0.2, P[5], P[6], 0.06), ...tuft(0x6cc24f, 5, 0.12, 0.28)]), 2, [1.3, 1.7]]);
    kinds.push([mergeGeos([...tuft(0x74c858, 6, 0.14, 0.3), ...flower(0, 0, 0.18, 0xffffff, 0xffd040, 0.06), ...flower(0.12, 0.08, 0.15, P[7], 0xffd040, 0.055)]), 1, [1, 1.3]]);
  }
  if (style === 'hell') return buildHellStartProps(levelData, T, mat, h);
  if (!kinds.length) return [];
  const total = kinds.reduce((a, k) => a + k[1], 0);
  const pick = () => { let r = rng.range(0, total); for (let i = 0; i < kinds.length; i++) { r -= kinds[i][1]; if (r <= 0) return i; } return kinds.length - 1; };
  const lists = kinds.map(() => []);
  const add = (x, z, along, force = -1) => {
    const i = force >= 0 ? force : pick(), [lo, hi] = kinds[i][2], mode = kinds[i][3];
    // 'face': turned (roughly) toward the camera, which looks toward -z; 'along': lies along its edge
    const ry = mode === 'face' ? rng.range(-0.5, 0.5) : mode === 'along' ? along + rng.range(-0.25, 0.25) : rng.range(0, TAU);
    lists[i].push({ x, z, s: rng.range(lo, hi), ry });
  };
  const cps = levelData.checkpoints || [];
  for (const c of levelData.safeCorners) {
    const cp = cps.find((p) => Math.abs(p.x - c.x) < 0.5 && Math.abs(p.z - c.z) < 0.5);
    // the flag stands in the corner behind the run direction, on the left (see buildCheckpoints)
    const flag = cp ? [Math.sign(-Math.cos(cp.heading) - Math.sin(cp.heading)), Math.sign(-Math.sin(cp.heading) + Math.cos(cp.heading))] : null;
    // winter: every square gets one campfire, in a far (-z) corner where it can't hide a kitty
    const fireSx = rng.chance(0.5) ? -1 : 1;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (flag && flag[0] === sx && flag[1] === sz) continue;
      const cx = c.x + sx * (h - 0.6), cz = c.z + sz * (h - 0.6);
      add(cx, cz, rng.chance(0.5) ? 0 : Math.PI / 2, style === 'winter' && sz < 0 && (sx === fireSx || (flag && flag[1] < 0)) ? 0 : -1);
      // one or two more along the two edges that meet here
      add(c.x + sx * (h - 0.5), cz - sz * rng.range(1.1, 2.2), Math.PI / 2);
      if (rng.chance(0.6)) add(cx - sx * rng.range(1.1, 2.2), c.z + sz * (h - 0.5), 0);
    }
  }
  const out = kinds.map(([geo], i) => makeInstanced(T.g(geo), mat, lists[i], { cast: true, receive: true }));
  // kinds may carry a glowing part (flames, lantern light: unlit vertex colours, same instances) and a soft pool of
  // light on the tile (additive glow decal; dim, no glare)
  let glowMat = null, glowGeo = null;
  const pools = [];
  kinds.forEach(([, , , , lit, pool], i) => {
    if (lit) {   // flames and lamp cores a little dimmer than full white-hot
      const m = makeInstanced(T.g(lit), T.m(new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xd8d8d8 })), lists[i]);
      out.push(m);
    }
    if (pool) for (const it of lists[i]) pools.push({ x: it.x, z: it.z, y: 0.02, s: pool.s * it.s, color: new THREE.Color(pool.color) });
  });
  if (pools.length) {
    glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);
    glowMat = makeWarmGlowMat(T, 0.38);
    const g = makeInstanced(glowGeo, glowMat, pools);
    g.renderOrder = 1;
    out.push(g);
  }
  return out;
}

// The final run's start square: the remains of kitties that didn't make it (cat skulls with ear ridges and big eye
// sockets, a whole cat skeleton with a long curled tail, little paw bones) and broken spiked iron fencing along the
// walls. Proportions a bit exaggerated so they read from the game camera. Low, and kept off the near (+z) wall.
function buildHellStartProps(levelData, T, mat, h) {
  const BONE = 0xd9cdb2, BONE2 = 0xbfae90, HOLE = 0x140808, IRON = 0x6e5048, IRON2 = 0x9a7262;   // rusted iron (must read against the charred tiles)
  const catSkull = (x, y, z, s = 1, ry = 0) => {
    const parts = [
      paint(place(new THREE.IcosahedronGeometry(0.2, 2), 0, 0.17, 0, 1.05, 0.82, 1.1), BONE),                     // cranium
      paint(place(new THREE.IcosahedronGeometry(0.11, 1), 0, 0.12, 0.18, 1.15, 0.72, 1), BONE),                    // muzzle
      paint(place(new THREE.BoxGeometry(0.17, 0.04, 0.16), 0, 0.04, 0.12), BONE2),                                 // lower jaw
      ...[-1, 1].map((sx) => paint(place(new THREE.IcosahedronGeometry(0.075, 1), sx * 0.088, 0.22, 0.14, 1, 1.05, 0.75, -0.6, 0, 0), HOLE)),   // big eye sockets (tilted up so they show from above)
      ...[-1, 1].map((sx) => paint(place(new THREE.IcosahedronGeometry(0.06, 0), sx * 0.13, 0.15, 0.08, 0.5, 1, 1.3), BONE)),      // cheekbones
      ...[-1, 1].map((sx) => paint(place(new THREE.ConeGeometry(0.085, 0.24, 4), sx * 0.12, 0.33, -0.04, 1, 1, 0.55, 0, 0, -sx * 0.45), BONE)),   // pointed ear ridges
      ...[-1, 1].map((sx) => paint(place(new THREE.ConeGeometry(0.018, 0.09, 4), sx * 0.045, 0.06, 0.25, 1, 1, 1, Math.PI, 0, 0), 0xf2ead8)),  // fangs
      paint(place(new THREE.IcosahedronGeometry(0.022, 0), 0, 0.14, 0.27), HOLE),                                   // nose hole
    ];
    for (const p of parts) place(p, 0, 0, 0, s, s, s, 0, ry, 0).translate(x, y, z);
    return parts;
  };
  // a cylinder / cone from (x0, y0, z0) toward (x1, y1, z1)
  const UP = new THREE.Vector3(0, 1, 0);
  const rod = (geo, x0, y0, z0, x1, y1, z1, col) => {
    const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length();
    geo.scale(1, L, 1);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
    geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return paint(geo, col);
  };
  const pawBones = (x, z, ang, s = 1) => {
    const out = [paint(place(new THREE.IcosahedronGeometry(0.04 * s, 0), x, 0.03 * s, z, 1.3, 0.6, 1), BONE2)];
    for (let k = 0; k < 4; k++) {
      const a = ang + (k - 1.5) * 0.32, L = 0.13 * s;
      const tx = x + Math.cos(a) * L, tz = z + Math.sin(a) * L;
      out.push(rod(new THREE.CylinderGeometry(0.014 * s, 0.014 * s, 1, 4), x, 0.02 * s, z, tx, 0.02 * s, tz, BONE));
      out.push(rod(new THREE.ConeGeometry(0.016 * s, 1, 4), tx, 0.02 * s, tz, tx + Math.cos(a) * 0.06 * s, 0.015 * s, tz + Math.sin(a) * 0.06 * s, 0xf2ead8));   // claws
    }
    return out;
  };
  // the skeleton lies along x: skull at +x, spine and ribcage, hips, a long tail curling round at -x, legs splayed
  const skel = [...catSkull(0.62, 0, 0.04, 1.15, 0.75)];   // turned toward the camera
  for (let k = 0; k < 9; k++) {
    const x = 0.42 - k * 0.09;
    skel.push(paint(place(new THREE.IcosahedronGeometry(0.045, 0), x, 0.05, 0, 0.8, 0.9, 1.3), BONE));
    if (k >= 1 && k <= 5) skel.push(paint(place(new THREE.TorusGeometry(0.15 - Math.abs(k - 3) * 0.015, 0.016, 3, 10, Math.PI), x, 0.02, 0, 1, 1.1, 1, 0, Math.PI / 2, 0), BONE));   // ribs
  }
  skel.push(paint(place(new THREE.IcosahedronGeometry(0.09, 1), -0.42, 0.06, 0, 1, 0.55, 1.5), BONE2));   // pelvis
  let tx = -0.48, tz = 0, ta = Math.PI;
  for (let k = 0; k < 16; k++) {   // tail: shrinking vertebrae curling round
    ta += 0.19; tx += Math.cos(ta) * 0.075; tz += Math.sin(ta) * 0.075;
    const r = 0.034 * (1 - k / 22);
    skel.push(paint(place(new THREE.IcosahedronGeometry(r, 0), tx, r, tz, 1.4, 1, 1, 0, -ta, 0), BONE));
  }
  for (const [x0, sz, a] of [[0.32, 1, 0.9], [0.32, -1, -0.9], [-0.4, 1, 2.3], [-0.4, -1, -2.3]]) {   // legs + paws
    const L = 0.34, x1 = x0 + Math.cos(a) * L * 0.4, z1 = sz * Math.abs(Math.sin(a)) * L;
    skel.push(rod(new THREE.CylinderGeometry(0.02, 0.022, 1, 5), x0, 0.04, 0, x1, 0.025, z1, BONE));
    skel.push(...pawBones(x1, z1 + sz * 0.04, Math.atan2(sz, 0) + (x0 > 0 ? -0.3 : 0.3) * sz));
  }
  const skullPile = [...catSkull(0, 0, 0, 1), ...pawBones(0.3, 0.12, 0.4), rod(new THREE.CylinderGeometry(0.022, 0.022, 1, 5), -0.45, 0.025, -0.05, -0.15, 0.025, 0.25, BONE)];
  // broken spiked iron fence: three posts with spear tips, two rails, the end post snapped and leaning
  const fence = [];
  for (const [x, lean, hgt] of [[-0.6, 0, 0.62], [0, 0, 0.66], [0.6, 0.55, 0.42]]) {
    fence.push(paint(place(new THREE.CylinderGeometry(0.03, 0.035, hgt, 5), x + Math.sin(lean) * hgt / 2, Math.cos(lean) * hgt / 2, 0, 1, 1, 1, 0, 0, -lean), IRON));
    if (lean === 0) fence.push(paint(place(new THREE.ConeGeometry(0.055, 0.16, 4), x, hgt + 0.07, 0), IRON2));
  }
  fence.push(paint(place(new THREE.BoxGeometry(1.25, 0.04, 0.035), -0.02, 0.48, 0, 1, 1, 1, 0, 0, 0.03), IRON));
  fence.push(paint(place(new THREE.BoxGeometry(0.9, 0.04, 0.035), -0.15, 0.14, 0, 1, 1, 1, 0, 0, -0.02), IRON));
  fence.push(paint(place(new THREE.ConeGeometry(0.055, 0.16, 4), 0.98, 0.05, 0.12, 1, 1, 1, 0, 0, Math.PI / 2 + 0.3), IRON2));   // the snapped-off tip
  const c = levelData.safeCorners[0], e = h - 0.55;
  // the camera looks toward -z: the far (-z) half and the sides are what it sees; the near wall hides the +z edge
  const items = {
    skel: [{ x: c.x - 1.6, z: c.z - e + 0.9, s: 1.7, ry: 0.15 }],
    pile: [{ x: c.x + e - 0.7, z: c.z - e + 0.6, s: 1.6, ry: -0.3 }, { x: c.x - e + 0.7, z: c.z + e - 1.6, s: 1.45, ry: 0.5 }, { x: c.x + 2.3, z: c.z + e - 1.3, s: 1.3, ry: -0.6 }],
    paws: [{ x: c.x + 1.3, z: c.z - 1.9, s: 1.6, ry: 1.2 }, { x: c.x - 2.6, z: c.z + 1.4, s: 1.6, ry: -0.4 }],
    fence: [
      { x: c.x - e - 0.1, z: c.z - 2.2, s: 1.3, ry: Math.PI / 2 }, { x: c.x - e - 0.1, z: c.z + 1.6, s: 1.3, ry: -Math.PI / 2 + 0.1 },
      { x: c.x + 1.8, z: c.z - e - 0.1, s: 1.3, ry: 0.05 },
    ],
  };
  return [
    makeInstanced(T.g(mergeGeos(skel)), mat, items.skel, { cast: true, receive: true }),
    makeInstanced(T.g(mergeGeos(skullPile)), mat, items.pile, { cast: true, receive: true }),
    makeInstanced(T.g(mergeGeos(pawBones(0, 0, 0, 1.4))), mat, items.paws, { cast: true, receive: true }),
    makeInstanced(T.g(mergeGeos(fence)), mat, items.fence, { cast: true, receive: true }),
  ];
}

// The final run's start square (and the out-of-rotation neon theme): plain stone tile with a bright border and a paw print.
function makeSafeTileTexture(T) {
  const rng = createRng(4242);
  const S = 256;
  return T.t(canvasTex(S, (g) => {
    g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, S, S);
    const n = 6, cell = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = rng.int(200, 245);
      g.fillStyle = `rgb(${v},${v},${(v * 0.98) | 0})`;
      g.fillRect(i * cell + 2.5, j * cell + 2.5, cell - 5, cell - 5);
    }
    g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.strokeRect(9, 9, S - 18, S - 18);
    // paw print
    g.fillStyle = 'rgba(120,120,120,.75)';
    const C = S / 2;
    g.beginPath(); g.ellipse(C, C + 14, 30, 25, 0, 0, TAU); g.fill();
    for (const [dx, dy, r] of [[-36, -14, 11], [-14, -36, 12], [14, -36, 12], [36, -14, 11]]) {
      g.beginPath(); g.ellipse(C + dx, C + dy, r, r * 1.25, 0, 0, TAU); g.fill();
    }
  }, { repeat: false }));
}

function makePlazaTexture(T) {
  const rng = createRng(777);
  const S = 512, C = S / 2;
  return T.t(canvasTex(S, (g) => {
    g.fillStyle = '#8f8f8f'; g.fillRect(0, 0, S, S);
    const stone = (r0, r1, a0, a1) => {
      const v = rng.int(205, 248);
      g.fillStyle = `rgb(${v},${v},${(v * 0.98) | 0})`;
      g.beginPath(); g.arc(C, C, r1, a0, a1); g.arc(C, C, r0, a1, a0, true); g.closePath(); g.fill();
    };
    g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(C, C, 38, 0, TAU); g.fill();
    // little star inlay
    g.fillStyle = '#c8c8c8'; g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * TAU, r = k % 2 ? 12 : 30;
      g.lineTo(C + Math.cos(a) * r, C + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    let r = 42;
    while (r < 256) {
      const w = 34, rm = r + w / 2;
      const n = Math.max(6, Math.round(TAU * rm / 46));
      const off = rng.range(0, TAU);
      const gapA = 2.2 / rm;
      for (let k = 0; k < n; k++) {
        const a0 = off + k / n * TAU + gapA, a1 = off + (k + 1) / n * TAU - gapA;
        stone(r, r + w - 2.5, a0, a1);
      }
      r += w;
    }
    // edge darkening near the wall
    const gr = g.createRadialGradient(C, C, 190, C, C, 256);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }, { repeat: false }));
}

function makeWallTexture(style, T) {
  const rng = createRng(hashSeed('wall', style));
  const S = 256;
  return T.t(canvasTex(S, (g) => {
    if (style === 'hedge') {
      g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 1500; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), rx = rng.range(4, 9), ry = rx * rng.range(0.45, 0.7), rot = rng.range(0, TAU);
        const v = rng.int(150, 255);
        g.fillStyle = `rgb(${v},${v},${(v * 0.92) | 0})`;
        wrapDraw(S, x, y, 10, (px, py) => { g.beginPath(); g.ellipse(px, py, rx, ry, rot, 0, TAU); g.fill(); });
      }
      for (let i = 0; i < 260; i++) {
        const x = rng.range(0, S), y = rng.range(0, S);
        g.fillStyle = 'rgba(40,40,40,0.35)';
        wrapDraw(S, x, y, 3, (px, py) => { g.beginPath(); g.arc(px, py, rng.range(1, 2.5), 0, TAU); g.fill(); });
      }
    } else if (style === 'stone') {
      g.fillStyle = '#909090'; g.fillRect(0, 0, S, S);
      const bh = 32, bw = 64;
      for (let row = 0; row < S / bh; row++) {
        const off = (row % 2) * bw / 2;
        for (let k = -1; k < S / bw + 1; k++) {
          const x = k * bw + off, y = row * bh, v = rng.int(190, 240);
          g.fillStyle = `rgb(${v},${v},${Math.min(255, v + 6)})`;
          wrapDraw(S, x, y, bw, (px, py) => g.fillRect(px + 2, py + 2, bw - 4, bh - 4));
          g.fillStyle = 'rgba(255,255,255,0.18)';
          wrapDraw(S, x, y, bw, (px, py) => g.fillRect(px + 2, py + 2, bw - 4, 4));
        }
      }
      for (let i = 0; i < 500; i++) {
        g.fillStyle = `rgba(60,60,70,${rng.range(0.05, 0.2)})`;
        g.fillRect(rng.range(0, S), rng.range(0, S), 2, 2);
      }
    } else {
      g.fillStyle = '#c8c8d8'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#7a7a90';
      g.fillRect(0, 0, 4, S); g.fillRect(S / 2, 0, 4, S);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(6, 0, 10, S); g.fillRect(S / 2 + 6, 0, 10, S);
      for (let i = 0; i < 8; i++) {
        g.fillStyle = '#9a9ab0';
        g.beginPath(); g.arc(S / 4 + (i % 2) * S / 2, (i * 37) % S + 10, 3, 0, TAU); g.fill();
      }
    }
  }));
}

// A pool of lamp / fire light on the ground: tints the floor toward a warm colour instead of adding light (additive
// glows clipped to glaring white on pale floors like snow). opacity = how strong the tint gets at the centre.
function makeWarmGlowMat(T, opacity, fog = false) {
  return T.m(new THREE.MeshBasicMaterial({ map: makeGlowTexture(T), transparent: true, opacity, depthWrite: false, fog }));
}

// a lamp colour made deeper and more golden (pale lamp colours read as white once tone-mapped)
function warmLampColor(hex) {
  const c = new THREE.Color(hex), hsl = {};
  c.getHSL(hsl);
  return c.setHSL(hsl.h, Math.min(1, hsl.s * 1.15 + 0.1), Math.min(hsl.l, 0.58));
}

function makeGlowTexture(T) {
  return T.t(canvasTex(128, (g, S) => {
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }, { repeat: false }));
}

function makeSpriteTexture(kind, T) {
  return T.t(canvasTex(64, (g, S) => {
    if (kind === 'leaf') {
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(S / 2, S / 2, S * 0.42, S * 0.2, 0.7, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(S * 0.2, S * 0.75); g.lineTo(S * 0.8, S * 0.25); g.stroke();
    } else {
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(kind === 'snow' ? 0.5 : 0.25, 'rgba(255,255,255,0.8)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
  }, { repeat: false }));
}

// Make a MeshStandardMaterial's emissive get multiplied by vertex / instance color.
function emissiveByColor(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n\ttotalEmissiveRadiance *= vColor.rgb;\n#endif'
    );
  };
  mat.customProgramCacheKey = () => 'emissiveByColor';
  return mat;
}

// Merge geometries (position + normal [+ color]) into one non-indexed geometry. Disposes inputs.
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const hasColor = parts.every((p) => p.attributes.color);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  const col = hasColor ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const p of parts) {
    if (!p.attributes.normal) p.computeVertexNormals();
    pos.set(p.attributes.position.array, o * 3);
    nor.set(p.attributes.normal.array, o * 3);
    if (col) col.set(p.attributes.color.array, o * 3);
    o += p.attributes.position.count;
  }
  for (const g of geos) g.dispose();
  for (const p of parts) p.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function place(geo, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)
  );
  geo.applyMatrix4(m);
  return geo;
}

function paint(geo, color) {
  const n = geo.attributes.position.count, c = new THREE.Color(color), arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function makeInstanced(geo, mat, items, { cast = false, receive = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  mesh.count = items.length;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    p.set(it.x, it.y || 0, it.z);
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    s.set(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.s ?? 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (it.color) mesh.setColorAt(i, it.color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

// One InstancedMesh per `chunk`-wide band of x (items sorted into bands), so each band can be frustum-culled.
function makeInstancedChunks(geo, mat, items, opts, chunk) {
  const bands = new Map();
  for (const it of items) {
    const k = Math.floor(it.x / chunk);
    if (!bands.has(k)) bands.set(k, []);
    bands.get(k).push(it);
  }
  const out = [];
  for (const list of bands.values()) {
    const mesh = makeInstanced(geo, mat, list, opts);
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  return out.length ? out : [makeInstanced(geo, mat, [], opts)];
}

// Trees mark the pixels they cover (stencil 2), so a wolf behind one is drawn as a see-through shape (wolfpack.js)
function coversWolves(mat) { mat.stencilWrite = true; mat.stencilRef = 2; mat.stencilZPass = THREE.ReplaceStencilOp; return mat; }

// Splits every big InstancedMesh of the finished world into size x size cells, so the off-screen ones are frustum-culled
// (in the shadow pass too). An InstancedMesh is culled as a whole, so one mesh of trees spread over the level was drawn
// in full every frame. Same geometry, material, matrices and colours: looks the same. Runs after nightDress (which
// treats each mesh as a whole); meshes animated per instance afterwards (userData.live) stay as they are.
function chunkInstances(root, size) {
  const M = new THREE.Matrix4(), C = new THREE.Color();
  const jobs = [];
  root.traverse((o) => { if (o.isInstancedMesh && !o.userData.live && o.frustumCulled && o.count > 16) jobs.push(o); });
  for (const o of jobs) {
    const a = o.instanceMatrix.array, cells = new Map();
    for (let i = 0; i < o.count; i++) {
      const k = Math.floor(a[i * 16 + 12] / size) + ',' + Math.floor(a[i * 16 + 14] / size);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(i);
    }
    if (cells.size < 2) continue;
    const parent = o.parent, at = parent.children.indexOf(o);
    const parts = [];
    for (const list of cells.values()) {
      const m = new THREE.InstancedMesh(o.geometry, o.material, list.length);
      list.forEach((i, j) => {
        o.getMatrixAt(i, M); m.setMatrixAt(j, M);
        if (o.instanceColor) { o.getColorAt(i, C); m.setColorAt(j, C); }
      });
      m.name = o.name;
      m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow; m.renderOrder = o.renderOrder; m.visible = o.visible;
      m.position.copy(o.position); m.quaternion.copy(o.quaternion); m.scale.copy(o.scale);
      m.userData = { ...o.userData };
      m.computeBoundingSphere();
      parts.push(m);
    }
    parent.remove(o);
    o.dispose();
    parent.children.splice(at, 0, ...parts);
    for (const m of parts) { m.parent = parent; m.dispatchEvent({ type: 'added' }); }
  }
}

// ---------------------------------------------------------------- swept wall geometry

function linePath(ax, az, bx, bz, segLen) {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / segLen));
  const tx = (bx - ax) / L, tz = (bz - az) / L, pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push({ x: ax + (bx - ax) * f, z: az + (bz - az) * f, tx, tz, s: L * f });
  }
  return pts;
}

// Sweep a CCW (u right/outward, y up) profile along a path. Profile closing edge (last->first)
// is the bottom and is skipped. End caps are fans. Side normal N = (tz, -tx), so T = N x Y.
function sweep(buf, path, profile, colorFn, uvs, caps = true) {
  const P = profile.length;
  const plen = [0];
  for (let k = 1; k < P; k++) plen.push(plen[k - 1] + Math.hypot(profile[k].u - profile[k - 1].u, profile[k].y - profile[k - 1].y));
  const col = new THREE.Color();
  const push = (x, y, z, nx, ny, nz, u, v) => {
    buf.p.push(x, y, z); buf.n.push(nx, ny, nz); buf.uv.push(u, v);
    colorFn(x, y, z, col); buf.c.push(col.r, col.g, col.b);
  };
  const vert = (pt, k, nu, ny) => {
    const nx = pt.tz, nz = -pt.tx, pr = profile[k];
    push(pt.x + nx * pr.u, pr.y, pt.z + nz * pr.u, nx * nu, ny, nz * nu, pt.s * uvs, plen[k] * uvs);
  };
  for (let k = 0; k < P - 1; k++) {
    const du = profile[k + 1].u - profile[k].u, dy = profile[k + 1].y - profile[k].y, L = Math.hypot(du, dy) || 1;
    const nu = dy / L, ny = -du / L;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      // A=(a,k) B=(b,k) C=(b,k+1) D=(a,k+1); winding A,C,B / A,D,C
      vert(a, k, nu, ny); vert(b, k + 1, nu, ny); vert(b, k, nu, ny);
      vert(a, k, nu, ny); vert(a, k + 1, nu, ny); vert(b, k + 1, nu, ny);
    }
  }
  if (!caps) return;
  const capAt = (pt, sign) => {
    const nx = pt.tz, nz = -pt.tx;
    const V = (k) => {
      const pr = profile[k];
      push(pt.x + nx * pr.u, pr.y, pt.z + nz * pr.u, pt.tx * sign, 0, pt.tz * sign, pr.u * uvs, pr.y * uvs);
    };
    for (let k = 1; k < P - 1; k++) {
      if (sign > 0) { V(0); V(k); V(k + 1); } else { V(0); V(k + 1); V(k); }
    }
  };
  capAt(path[0], -1);
  capAt(path[path.length - 1], 1);
}

function bufToGeo(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.c, 3));
  g.computeBoundingSphere();
  return g;
}

function roundedProfile(hw, base, h, steps) {
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const phi = (k / steps) * Math.PI;
    // squircle-ish: flatter top
    const c = Math.cos(phi), s = Math.sin(phi);
    pts.push({ u: hw * Math.sign(c) * Math.pow(Math.abs(c), 0.8), y: base + h * Math.pow(s, 0.7) });
  }
  return pts;
}

function buildWalls(levelData, theme, T) {
  const H = CFG.WALL_HEIGHT, t = CFG.WALL_THICKNESS, ht = t / 2;
  const style = theme.wallStyle;
  let body, cap;
  if (style === 'stone') {
    body = [{ u: ht + 0.05, y: 0 }, { u: ht, y: H }, { u: -ht, y: H }, { u: -ht - 0.05, y: 0 }];
    cap = roundedProfile(ht + 0.13, H - 0.1, 0.34, 8);
  } else if (style === 'neon') {
    body = [{ u: ht, y: 0 }, { u: ht, y: H }, { u: -ht, y: H }, { u: -ht, y: 0 }];
    cap = [{ u: ht * 0.45, y: H - 0.01 }, { u: ht * 0.45, y: H + 0.07 }, { u: -ht * 0.45, y: H + 0.07 }, { u: -ht * 0.45, y: H - 0.01 }];
  } else {
    body = [{ u: ht, y: 0 }, { u: ht, y: H }, { u: -ht, y: H }, { u: -ht, y: 0 }];
    cap = roundedProfile(ht + 0.08, H - 0.12, 0.3, 6);
  }

  const wallC = new THREE.Color(theme.wall), topC = new THREE.Color(theme.wallTop), accC = new THREE.Color(theme.accent);
  const aoStrength = style === 'stone' ? 0.35 : style === 'neon' ? 0.3 : 0.5;
  // the final run: the goal room's walls are warm (the reward at the end of hell)
  const rr = levelData.roomHalf + t;
  const inRoom = (x, z) => Math.abs(x) <= rr && Math.abs(z) <= rr;
  const roomC = theme.roomWall != null ? new THREE.Color(theme.roomWall) : null;
  const roomTopC = roomC ? new THREE.Color(theme.roomWallTop) : null;
  const bodyColor = (x, y, z, out) => {
    const n = vnoise(x * 0.7 + y * 0.6, z * 0.7 - y * 0.8), n2 = vnoise(x * 2.7 + 13.1, z * 2.7 + y * 2.1);
    const f = 0.8 + 0.28 * n + 0.12 * n2;
    const ao = 1 - aoStrength + aoStrength * Math.min(1, y / (H * 0.85));
    out.copy(roomC && inRoom(x, z) ? roomC : wallC).multiplyScalar(f * ao);
  };
  // spring: a green hedge top dotted with clusters of little flowers (SPRING_CAPS)
  // (Skate's spring night: NIGHT_SPRING_CAP, a hedge in blossom, so it reads apart from summer's)
  const springCap = theme.night && theme.nightTi === 4 ? NIGHT_SPRING_CAP : theme.safeStyle === 'spring' ? SPRING_CAPS[SPRING_LOOK] : null;
  const capBase = springCap ? new THREE.Color(springCap.base) : null, capFlowers = springCap ? springCap.flowers.map((c) => new THREE.Color(c)) : null;
  const capColor = style === 'neon'
    ? (x, y, z, out) => {
      const a = Math.atan2(z, x), r = Math.hypot(x, z);
      const k = 0.5 + 0.5 * Math.sin(a * 2 + r * 0.25);
      out.copy(topC).lerp(accC, k);
    }
    : springCap ? (x, y, z, out) => {
      const n = vnoise(x * 1.3 + 5.1, z * 1.3 - 2.7);
      out.copy(capBase).multiplyScalar(0.84 + 0.2 * n);
    }
    : (x, y, z, out) => {
      const n = vnoise(x * 1.3 + 5.1, z * 1.3 - 2.7);
      out.copy(roomTopC && inRoom(x, z) ? roomTopC : topC).multiplyScalar((style === 'stone' ? 0.94 : 0.82) + 0.16 * n);
    };

  const bb = { p: [], n: [], uv: [], c: [] }, cb = { p: [], n: [], uv: [], c: [] };
  const SEG = 0.6, UVS = 1 / 1.6;
  for (const w of levelData.walls) {
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
    const ex = ((w.bx - w.ax) / L) * ht, ez = ((w.bz - w.az) / L) * ht;
    const path = linePath(w.ax - ex, w.az - ez, w.bx + ex, w.bz + ez, SEG);
    sweep(bb, path, body, bodyColor, UVS);
    sweep(cb, path, cap, capColor, UVS);
  }

  const wallTex = makeWallTexture(style, T);
  const bodyMat = T.m(new THREE.MeshStandardMaterial({ map: wallTex, vertexColors: true, roughness: style === 'neon' ? 0.55 : 0.92, metalness: style === 'neon' ? 0.2 : 0 }));
  let capMat;
  if (style === 'neon') {
    capMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.4 })));
  } else if (style === 'stone') {
    capMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
  } else {
    capMat = T.m(new THREE.MeshStandardMaterial({ map: wallTex, vertexColors: true, roughness: 0.9 }));
  }
  const bodyMesh = new THREE.Mesh(T.g(bufToGeo(bb)), bodyMat);
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;
  const capMesh = new THREE.Mesh(T.g(bufToGeo(cb)), capMat);
  capMesh.castShadow = style !== 'neon';
  capMesh.receiveShadow = true;
  if (theme.night) {   // night frost / hail on the walls (NIGHT_FROST)
    const [fb, fc] = NIGHT_FROST[theme.nightTi] || [0, 0];
    if (fb && bodyMat.emissive) bodyMat.emissive.setHex(fb);
    if (fc && capMat.emissive && style !== 'neon') capMat.emissive.setHex(fc);
    if (theme.nightTi === 0) { bodyMat.color.setRGB(0.66, 0.84, 0.58); capMat.color.setRGB(0.7, 0.86, 0.6); }   // summer: a deep, rich green
    if (theme.nightTi === 4) bodyMat.color.setRGB(1.12, 1.18, 1.0);   // spring: a paler, fresh green
  }
  if (!springCap) return [bodyMesh, capMesh];
  // the little flowers: tiny flat blooms sitting on the rounded hedge top, in drifts (denser where the noise is high)
  const rng = createRng(hashSeed('capFlowers', levelData.seed || 0));
  const hw = ht + 0.08, base = H - 0.12, capH = 0.3, items = [];
  for (const w of levelData.walls) {
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1, tx = (w.bx - w.ax) / L, tz = (w.bz - w.az) / L;
    for (let d = rng.range(0, 0.3); d < L; d += rng.range(0.12, 0.32)) {
      const x0 = w.ax + tx * d, z0 = w.az + tz * d;
      if (vnoise(x0 * 0.8 + 3.7, z0 * 0.8 - 1.9) < (theme.night ? 0.1 : 0.42)) continue;   // bare stretches between the drifts (night spring: in full blossom)
      const a = rng.range(-0.8, 0.8), c = Math.pow(Math.abs(a), 1 / 0.8), y = base + capH * Math.pow(Math.sqrt(1 - c * c), 0.7);
      const col = rng.pick(capFlowers).clone().multiplyScalar(rng.range(0.92, 1.05));
      items.push({ x: x0 - tz * a * hw, z: z0 + tx * a * hw, y: y + 0.01, s: rng.range(0.8, 1.25), ry: rng.range(0, TAU), color: col });
    }
    // night spring: blossom down both sides of the hedge too
    if (theme.night) for (let d = rng.range(0, 0.2); d < L; d += rng.range(0.1, 0.22)) {
      const x0 = w.ax + tx * d, z0 = w.az + tz * d, side = rng.chance(0.5) ? 1 : -1;
      if (vnoise(x0 * 1.1 - 4.3, z0 * 1.1 + 2.2) < 0.3) continue;
      items.push({ x: x0 - tz * side * (ht + 0.03), z: z0 + tx * side * (ht + 0.03), y: rng.range(0.25, H - 0.2), s: rng.range(0.9, 1.4), ry: rng.range(0, TAU), color: rng.pick(capFlowers).clone().multiplyScalar(rng.range(0.92, 1.05)) });
    }
  }
  const bloomGeo = T.g(new THREE.IcosahedronGeometry(0.055 * (springCap.big || 1), 0)); bloomGeo.scale(1, 0.45, 1);
  const bloomMat = T.m(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, flatShading: true }));
  return [bodyMesh, capMesh, ...makeInstancedChunks(bloomGeo, bloomMat, items, {}, 24)];
}

// ---------------------------------------------------------------- floors

function buildFloors(levelData, theme, T) {
  const W = levelData.corridorWidth, legs = levelData.legs, rh = levelData.roomHalf;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const UVS = 1 / 3.5;
  // Quad grid: `us` across (with edge-darkening factors), two rows along.
  const addStrip = (ox, oz, ax, az, bx, bz, s0, s1, us, factors, color, y = 0) => {
    const base = pos.length / 3, c = new THREE.Color(color);
    for (const sv of [s0, s1]) {
      for (let k = 0; k < us.length; k++) {
        const x = ox + ax * sv + bx * us[k], z = oz + az * sv + bz * us[k];
        pos.push(x, y, z); nor.push(0, 1, 0); uv.push(x * UVS, z * UVS);
        const f = factors[k];
        col.push(c.r * f, c.g * f, c.b * f);
      }
    }
    const n = us.length;
    for (let k = 0; k < n - 1; k++) {
      const A = base + k, B = A + 1, C = A + n, D = C + 1;
      // keep triangles facing up whatever the frame handedness
      const cross = ax * bz - az * bx;
      if (cross > 0) idx.push(A, B, C, B, D, C); else idx.push(A, C, B, B, C, D);
    }
  };
  const h = W / 2;
  const across = [-h, -h + 0.25, -h + 0.9, h - 0.9, h - 0.25, h];
  const edge = [0.62, 0.78, 1, 1, 0.78, 0.62];
  // a start room narrower than the corridor (Run only's level 9): the corridor's floor stops at its opening and the
  // room gets its own, edged like the goal room's
  // (Run + Skate's level 9: both corridors' first legs have one, leg.startRoom; their last legs own their ends, leg.endLeg)
  const sh0 = levelData.safeSize && levelData.safeSize < W ? levelData.safeSize / 2 : 0;
  legs.forEach((l, i) => {
    // each leg owns the corner square at its far end (s = len); the innermost leg also owns its start
    const sh = l.startRoom ?? (i === 0 ? sh0 : 0);
    const s0 = i === legs.length - 1 || l.endLeg ? -h : h;
    const color = l.loop % 2 ? theme.groundAlt : theme.ground;
    addStrip(l.ox, l.oz, l.ux, l.uz, l.nx, l.nz, s0, sh ? l.len - sh : l.len + h, across, edge, color);
    if (sh) addStrip(l.ox, l.oz, l.ux, l.uz, l.nx, l.nz, l.len - sh, l.len + sh, [-sh, -sh + 0.25, -sh + 0.9, sh - 0.9, sh - 0.25, sh], edge, color);
  });
  for (const r of levelData.extraFloors || []) {   // Run + Skate's level 9: the hallway between its two halves
    const hw = (r.x1 - r.x0) / 2;
    addStrip((r.x0 + r.x1) / 2, r.z0, 0, 1, 1, 0, 0, r.z1 - r.z0, [-hw, -hw + 0.25, -hw + 0.9, hw - 0.9, hw - 0.25, hw], edge, theme.ground);
  }
  // goal room
  addStrip(0, 0, 1, 0, 0, 1, -rh, rh, [-rh, -rh + 0.25, -rh + 0.9, rh - 0.9, rh - 0.25, rh], edge, theme.roomGround ?? theme.ground);
  // the outside: a big ground plane slightly below the corridors
  const big = levelData.outerRadius + 150;
  addStrip(0, 0, 1, 0, 0, 1, -big, big, [-big, big], [1, 1], theme.night ? NIGHT_GROUND : theme.outerGround, -0.03);   // (night: dark everywhere off the lanes)

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  T.g(g);

  const { map, emissiveMap } = makeFloorTextures(theme.floorStyle, T);
  const opts = { map, vertexColors: true, roughness: 0.95, metalness: 0 };
  if (theme.floorStyle === 'snow') Object.assign(opts, { emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.8 });
  if (theme.floorEmissive != null) Object.assign(opts, { emissive: theme.floorEmissive, emissiveIntensity: theme.floorEmissiveIntensity });   // the final run: ember specks in the ash
  if (theme.floorStyle === 'neon') Object.assign(opts, { emissiveMap, emissive: theme.accent, emissiveIntensity: 0.16, roughness: 0.6, metalness: 0.15 });
  const floor = new THREE.Mesh(g, T.m(new THREE.MeshStandardMaterial(opts)));
  floor.receiveShadow = true;

  // center plaza
  const pg = T.g(new THREE.CircleGeometry(levelData.centerRadius + 0.05, 72));
  pg.rotateX(-Math.PI / 2);
  const pmOpts = { map: makePlazaTexture(T), color: theme.plaza, roughness: 0.85 };
  const plaza = new THREE.Mesh(pg, T.m(new THREE.MeshStandardMaterial(pmOpts)));
  plaza.position.y = 0.005;
  plaza.receiveShadow = true;

  // safe corners: wolves never enter these squares
  const size = (levelData.safeSize || levelData.corridorWidth) - CFG.WALL_THICKNESS;
  const tp = [], tn = [], tuv = [], ti = [];
  for (const c of levelData.safeCorners) {
    const b = tp.length / 3, h = size / 2;
    tp.push(c.x - h, 0.012, c.z - h, c.x + h, 0.012, c.z - h, c.x - h, 0.012, c.z + h, c.x + h, 0.012, c.z + h);
    tn.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    tuv.push(0, 1, 1, 1, 0, 0, 1, 0);
    ti.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
  tg.setAttribute('normal', new THREE.Float32BufferAttribute(tn, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
  tg.setIndex(ti);
  const seasonal = !!theme.safeStyle;
  const tileOpts = { color: seasonal ? theme.safeTint : theme.tile ?? theme.plaza, roughness: 0.9 };
  if (theme.safeStyle === 'hell') {
    const { map, emissiveMap } = makeHellTileTextures(T);
    Object.assign(tileOpts, { map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.5 });
  } else tileOpts.map = seasonal ? makeSeasonTileTexture(theme.safeStyle, T) : makeSafeTileTexture(T);
  const tiles = new THREE.Mesh(T.g(tg), T.m(new THREE.MeshStandardMaterial(tileOpts)));
  tiles.receiveShadow = true;
  const out = [floor, plaza, tiles];
  if (seasonal) out.push(...buildSafeProps(levelData, theme.safeStyle, T));
  if (levelData.ice) out.push(buildIce(levelData, T, theme));
  return out;
}

// Glossy ice sheet over every corridor and the goal room (under the safe tiles and the goal disc; the final run's
// reward room stays as it is).
function buildIce(levelData, T, theme) {
  const rng = createRng(777);
  const S = 512;
  const map = T.t(canvasTex(S, (g) => {
    g.fillStyle = '#cfeaff'; g.fillRect(0, 0, S, S);
    blotches(g, S, rng, 40, 50, 140, [255, 255, 255, 0.22], [90, 150, 210, 0.16]);
    g.lineCap = 'round';
    // skate scratches: long faint arcs
    for (let i = 0; i < 70; i++) {
      const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(60, 260), a = rng.range(0, TAU), sweep = rng.range(0.15, 0.5);
      g.strokeStyle = `rgba(255,255,255,${rng.range(0.25, 0.55)})`; g.lineWidth = rng.range(0.8, 1.8);
      wrapDraw(S, x, y, r + 4, (px, py) => { g.beginPath(); g.arc(px, py, r, a, a + sweep); g.stroke(); });
    }
    // cracks: short jagged dark-blue polylines
    for (let i = 0; i < 18; i++) {
      let x = rng.range(0, S), y = rng.range(0, S), a = rng.range(0, TAU);
      const pts = [[x, y]];
      for (let k = 0; k < 6; k++) { a += rng.range(-0.8, 0.8); x += Math.cos(a) * rng.range(8, 22); y += Math.sin(a) * rng.range(8, 22); pts.push([x, y]); }
      g.strokeStyle = `rgba(70,120,180,${rng.range(0.25, 0.45)})`; g.lineWidth = rng.range(0.8, 1.6);
      wrapDraw(S, pts[0][0], pts[0][1], 140, (px, py) => {
        const ox = px - pts[0][0], oy = py - pts[0][1];
        g.beginPath(); g.moveTo(px, py); for (const [qx, qy] of pts) g.lineTo(qx + ox, qy + oy); g.stroke();
      });
    }
  }));
  const W = levelData.corridorWidth, h = W / 2 - CFG.WALL_THICKNESS / 2, UVS = 1 / 9;
  const pos = [], uv = [], idx = [];
  levelData.legs.forEach((l, i) => {
    if (levelData.combo && !l.ice) return;   // Run + Skate's level 9: its run half is solid ground
    // leg i runs from corner i+1 (s=0) to corner i (s=len). Butt up against safe tiles instead of running under
    // them (no flicker); an unsafe corner at s=len is iced by this leg, and the last leg also ices its s=0 door corner.
    const endSafe = l.startRoom != null ? !!l.startRoom : i < levelData.safeCorners.length;
    const eh = levelData.safeSize ? levelData.safeSize / 2 - CFG.WALL_THICKNESS / 2 : h;   // a safe square (or start room) edge
    const s0 = i === levelData.legs.length - 1 || l.endLeg ? -h : h, s1 = endSafe ? l.len - eh : l.len + h;
    const b = pos.length / 3;
    for (const [sv, v] of [[s0, -h], [s0, h], [s1, -h], [s1, h]]) {
      const x = l.ox + l.ux * sv + l.nx * v, z = l.oz + l.uz * sv + l.nz * v;
      pos.push(x, 0.004, z); uv.push(x * UVS, z * UVS);
    }
    if (l.ux * l.nz - l.uz * l.nx > 0) idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); else idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  });
  // the goal room is iced too (the goal disc draws on top of it; maze.js onIce), except the final run's reward room
  if (!levelData.finale) {
    // (out to the walls' outer face: the walls hide it, and it covers the doorway's threshold, which showed the floor)
    const rh = levelData.roomHalf + CFG.WALL_THICKNESS / 2, b = pos.length / 3;
    for (const [x, z] of [[-rh, -rh], [rh, -rh], [-rh, rh], [rh, rh]]) { pos.push(x, 0.004, z); uv.push(x * UVS, z * UVS); }
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({
    map, color: theme.ice ?? 0xd6efff, transparent: true, opacity: theme.night ? 1 : 0.82, roughness: 1, metalness: 0, // matte: no sun glare (night: opaque, the ground under it is dark; still drawn in the transparent pass, over the floor)
    emissive: theme.iceEmissive ?? 0x5aa8f0, emissiveIntensity: 0.12, depthWrite: false,
  });
  const ice = new THREE.Mesh(T.g(g), T.m(mat));
  ice.receiveShadow = true;
  // one sheet for the whole map, sorted by its centre: without this it draws over see-through things (the aura)
  // on whichever side of the map is farther from the camera than the centre. It's the floor: always draw it first.
  ice.renderOrder = -1;
  return ice;
}

// ---------------------------------------------------------------- lanterns

function buildLanterns(levelData, theme, T, rng) {
  const H = CFG.WALL_HEIGHT;
  const spots = levelData.wallCorners.map((p) => ({ x: p.x, z: p.z }));
  if (levelData.finale) {
    // the final run: a steady rhythm of lanterns down both corridor walls (staggered), plus the goal room and start cap
    // (from just past the start square to just before the goal room's door)
    // (laid out for a corridor in from the left; Run only's runs in from the right: mirrored, D = -1)
    const D = levelData.finaleSide > 0 || levelData.combo ? -1 : 1;   // (Run + Skate's level 9: its run half; the skate half's walls get theirs below)
    const rh = levelData.roomHalf, step = 12, x0 = D * (levelData.combo ? levelData.safeCorners[1].x : levelData.corners[0].x) + levelData.corridorWidth / 2 + 5;
    for (const [w, off] of [[levelData.walls[0], 0], [levelData.walls[1], step / 2]]) {
      for (let x = x0 + off; x < -rh - 4; x += step) spots.push({ x: D * x, z: w.az });
    }
    for (const w of levelData.walls.slice(3)) {
      const L = Math.hypot(w.bx - w.ax, w.bz - w.az), n = Math.max(1, Math.floor(L / (L > 40 ? 12 : 8)));   // (long corridor walls: as far apart as the run's)
      for (let k = 1; k < n; k++) spots.push({ x: w.ax + (w.bx - w.ax) * k / n, z: w.az + (w.bz - w.az) * k / n });
    }
  } else {
    // extra lanterns along the outermost loop (last 4 arms + cap)
    for (const w of levelData.walls.slice(-6)) {
      const L = Math.hypot(w.bx - w.ax, w.bz - w.az), n = Math.floor(L / 9);
      for (let k = 1; k < n; k++) spots.push({ x: w.ax + (w.bx - w.ax) * k / n, z: w.az + (w.bz - w.az) * k / n });
    }
  }

  const PH = H + 0.25;
  const pillarGeo = T.g(mergeGeos([
    place(new THREE.BoxGeometry(0.76, 0.18, 0.76), 0, 0.09, 0),
    place(new THREE.BoxGeometry(0.6, PH, 0.6), 0, PH / 2, 0),
    place(new THREE.BoxGeometry(0.74, 0.12, 0.74), 0, PH + 0.02, 0),
    place(new THREE.CylinderGeometry(0.2, 0.12, 0.14, 8), 0, PH + 0.14, 0),
  ]));
  const orbGeo = T.g(new THREE.IcosahedronGeometry(0.21, levelData.finale ? 1 : 2));   // the final run has ~150 lanterns
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);

  const pillarItems = [], orbItems = [], glowItems = [];
  const pc = new THREE.Color(theme.pillar), rpc = new THREE.Color(theme.roomWall ?? theme.pillar), prr = levelData.roomHalf + 1;
  for (const sp of spots) {
    const { x, z } = sp;
    const c = Math.abs(x) <= prr && Math.abs(z) <= prr ? rpc : pc;
    pillarItems.push({ x, z, ry: 0, color: c.clone().multiplyScalar(rng.range(0.9, 1.08)) });
    orbItems.push({ x, z, y: PH + 0.36, color: new THREE.Color(1, 1, 1) });
    glowItems.push({ x, z, y: 0.03, s: theme.night ? 7.1 : 4.2, color: new THREE.Color(1, 1, 1) });   // (night: floodlights)
  }
  const pillarMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }));
  const orbMat = T.m(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const glowMat = makeWarmGlowMat(T, theme.night ? Math.min(0.85, theme.glowK * 2.75) : Math.min(0.42, theme.glowK * 1.25), true);

  const pillars = makeInstanced(pillarGeo, pillarMat, pillarItems, { cast: true, receive: true });
  const orbs = makeInstanced(orbGeo, orbMat, orbItems);
  const glows = makeInstanced(glowGeo, glowMat, glowItems);
  glows.renderOrder = 1;

  const phases = spots.map(() => rng.range(0, 10));
  const lampC = warmLampColor(theme.lamp);
  // the final run: red lanterns down the run, warm gold ones in the goal room
  const roomLampC = theme.roomLamp != null ? warmLampColor(theme.roomLamp) : lampC, rr = levelData.roomHalf + 1;
  const lamps = spots.map((s) => (Math.abs(s.x) <= rr && Math.abs(s.z) <= rr ? roomLampC : lampC));
  const tmp = new THREE.Color();
  const update = (time) => {
    for (let i = 0; i < spots.length; i++) {
      const ph = phases[i], lc = lamps[i];
      const f = 0.86 + 0.08 * Math.sin(time * 6.3 + ph * 7) + 0.06 * Math.sin(time * 17.1 + ph * 13);
      orbs.setColorAt(i, tmp.copy(lc).multiplyScalar(f));
      glows.setColorAt(i, tmp.copy(lc).multiplyScalar(f));   // strength: glowMat's opacity
    }
    if (orbs.instanceColor) orbs.instanceColor.needsUpdate = true;
    if (glows.instanceColor) glows.instanceColor.needsUpdate = true;
  };
  update(0);

  orbs.userData.live = glows.userData.live = true;   // flickered per instance in update (see chunkInstances)
  return { meshes: [pillars, orbs, glows], update };
}

// ---------------------------------------------------------------- decor

function buildDecor(levelData, theme, ti, T, rng) {
  const W = levelData.corridorWidth, rh = levelData.roomHalf;
  const meshes = [];
  // the final run is ~870 units long: split along x so off-screen stretches get frustum-culled (also in the shadow pass)
  const inst = (geo, mat, items, opts) => (levelData.finale ? makeInstancedChunks(geo, mat, items, opts, 96) : [makeInstanced(geo, mat, items, opts)]);
  // bounding box of the walls
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const w of levelData.walls) {
    x0 = Math.min(x0, w.ax, w.bx); x1 = Math.max(x1, w.ax, w.bx);
    z0 = Math.min(z0, w.az, w.bz); z1 = Math.max(z1, w.az, w.bz);
  }
  const Rn = Math.max(x1 - x0, z1 - z0) / 2;      // for perimeter-ish counts

  const sampleCorridor = (margin) => {
    for (let tries = 0; tries < 24; tries++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (locate(levelData, x, z).leg < 0) continue;
      if (collideCircle(levelData, x, z, margin).hit) continue;
      return { x, z, r: Math.hypot(x, z), a: Math.atan2(z, x) };
    }
    return null;
  };
  // points outside the spiral, between `lo` and `hi` units beyond its outer walls
  const sampleOuter = (lo, hi) => {
    for (let tries = 0; tries < 40; tries++) {
      const x = rng.range(x0 - hi, x1 + hi), z = rng.range(z0 - hi, z1 + hi);
      if (Math.max(x0 - x, x - x1, z0 - z, z - z1) > hi) continue;
      if (locate(levelData, x, z).leg !== -2) continue;
      if (collideCircle(levelData, x, z, Math.max(0.05, lo - CFG.WALL_THICKNESS / 2)).hit) continue;
      return { x, z, r: Math.hypot(x, z), a: Math.atan2(z, x) };
    }
    return { x: x1 + hi, z: z1 + hi, r: 0, a: 0 };
  };
  const corridorArea = levelData.legs.reduce((a, l) => a + l.len * W, 0) + 4 * rh * rh;
  const outerArea = (x1 - x0 + 52) * (z1 - z0 + 52) - (x1 - x0 + 5) * (z1 - z0 + 5);
  const jitterColor = (hex, b = 0.12) => new THREE.Color(hex).multiplyScalar(rng.range(1 - b, 1 + b));
  if (theme.hell) return buildHellDecor(levelData, theme, T, rng, { inst, sampleOuter, sampleCorridor, outerArea, corridorArea, jitterColor });

  // ---- trees
  const pine = ti === 2;
  const trunkGeo = T.g(place(new THREE.CylinderGeometry(0.13, 0.2, pine ? 1.0 : 1.6, 6), 0, pine ? 0.5 : 0.8, 0));
  const crownGeo = T.g(pine
    ? mergeGeos([
      place(new THREE.ConeGeometry(1.05, 1.3, 7), 0, 1.3, 0),
      place(new THREE.ConeGeometry(0.82, 1.1, 7), 0, 2.0, 0, 1, 1, 1, 0, 0.4, 0),
      place(new THREE.ConeGeometry(0.56, 0.9, 7), 0, 2.65, 0, 1, 1, 1, 0, 0.8, 0),
    ])
    : mergeGeos([
      place(new THREE.IcosahedronGeometry(0.95, 1), 0, 2.0, 0),
      place(new THREE.IcosahedronGeometry(0.72, 1), 0.6, 1.7, 0.25),
      place(new THREE.IcosahedronGeometry(0.66, 1), -0.5, 1.75, -0.3),
      place(new THREE.IcosahedronGeometry(0.6, 1), 0.1, 2.55, 0.1),
    ]));
  const trunkMat = T.m(coversWolves(new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 1, flatShading: true })));
  const crownMat = T.m(coversWolves(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true })));
  if (theme.crownEmissive > 0) { crownMat.emissive.set(0xffffff); crownMat.emissiveIntensity = theme.crownEmissive; emissiveByColor(crownMat); }
  const trees = [];
  const nTrees = Math.round(outerArea * 0.017);
  for (let i = 0; i < nTrees; i++) {
    const p = sampleOuter(2.8, 26), s = rng.range(0.8, 1.55);
    trees.push({ x: p.x, z: p.z, s, ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.crowns)) });
  }
  meshes.push(...inst(trunkGeo, trunkMat, trees.map((t) => ({ ...t, color: null })), { cast: true }));
  meshes.push(...inst(crownGeo, crownMat, trees, { cast: true, receive: true }));

  // ---- bushes (hug the outer wall + scattered)
  const bushGeo = T.g(mergeGeos([
    place(new THREE.IcosahedronGeometry(0.5, 1), 0, 0.32, 0),
    place(new THREE.IcosahedronGeometry(0.38, 1), 0.42, 0.25, 0.1),
    place(new THREE.IcosahedronGeometry(0.36, 1), -0.38, 0.24, -0.12),
  ]));
  const bushMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
  if (theme.crownEmissive > 0) { bushMat.emissive.set(0xffffff); bushMat.emissiveIntensity = theme.crownEmissive; emissiveByColor(bushMat); }
  const bushes = [];
  for (const w of (levelData.finale ? levelData.walls.slice(0, 2) : levelData.walls.slice(-6, -2))) {
    // outer side of the outermost arms = away from the centre
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az), ux = (w.bx - w.ax) / L, uz = (w.bz - w.az) / L;
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    let nx = uz, nz = -ux;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    for (let d = 0.5; d < L; d += 2.6) {
      if (rng.chance(0.3)) continue;
      const off = CFG.WALL_THICKNESS / 2 + rng.range(0.45, 1.0);
      const x = w.ax + ux * d + nx * off, z = w.az + uz * d + nz * off;
      if (locate(levelData, x, z).leg !== -2) continue;
      bushes.push({ x, z, s: rng.range(0.8, 1.3), ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.crowns), 0.18).multiplyScalar(0.85) });
    }
  }
  const nBush = Math.round(outerArea * 0.008);
  for (let i = 0; i < nBush; i++) {
    const p = sampleOuter(2, 26);
    bushes.push({ x: p.x, z: p.z, s: rng.range(0.7, 1.4), ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.crowns), 0.18) });
  }
  meshes.push(...inst(bushGeo, bushMat, bushes, { cast: true, receive: true }));

  // ---- rocks
  const rockGeo = T.g(new THREE.DodecahedronGeometry(0.5, 0));
  const rockMat = T.m(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }));
  const rocks = [];
  const nRocks = Math.round(outerArea * 0.006);
  for (let i = 0; i < nRocks; i++) {
    const p = sampleOuter(2, 26), s = rng.range(0.5, 1.6);
    rocks.push({ x: p.x, z: p.z, y: 0.12 * s, sx: s * rng.range(0.8, 1.3), sy: s * rng.range(0.45, 0.8), sz: s, ry: rng.range(0, TAU), rx: rng.range(-0.2, 0.2), color: jitterColor(theme.rock, 0.12) });
  }
  // pebbles in corridors (same mesh)
  const nPeb = Math.round(corridorArea * 0.025);
  for (let i = 0; i < nPeb; i++) {
    const p = sampleCorridor(0.4); if (!p) continue;
    const s = rng.range(0.12, 0.26);
    rocks.push({ x: p.x, z: p.z, y: 0.03, sx: s * 1.3, sy: s * 0.5, sz: s, ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.15) });
  }
  meshes.push(...inst(rockGeo, rockMat, rocks, { cast: true, receive: true }));

  // ---- grass tufts (not in snow)
  if (ti !== 2) {
    const blades = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      blades.push(place(new THREE.ConeGeometry(0.05, 0.38, 3), Math.cos(a) * 0.06, 0.17, Math.sin(a) * 0.06, 1, rng.range(0.7, 1.2), 1, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35));
    }
    const tuftGeo = T.g(mergeGeos(blades));
    const tuftMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
    const tufts = [];
    const nIn = Math.round(corridorArea * 0.07), nOut = Math.round(outerArea * 0.03);
    for (let i = 0; i < nIn; i++) {
      const p = sampleCorridor(0.3); if (!p) continue;
      tufts.push({ x: p.x, z: p.z, s: rng.range(0.7, 1.3), ry: rng.range(0, TAU), color: jitterColor(theme.tuft, 0.18) });
    }
    for (let i = 0; i < nOut; i++) {
      const p = sampleOuter(1.2, 26);
      tufts.push({ x: p.x, z: p.z, s: rng.range(0.9, 1.6), ry: rng.range(0, TAU), color: jitterColor(theme.tuft, 0.18) });
    }
    meshes.push(...inst(tuftGeo, tuftMat, tufts));
  }

  // ---- theme-specific small things in corridors
  const clusters = (count, per, spread, margin, make) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = sampleCorridor(margin); if (!p) continue;
      const n = rng.int(per[0], per[1]);
      for (let k = 0; k < n; k++) out.push(make(p.x + rng.range(-spread, spread), p.z + rng.range(-spread, spread)));
    }
    return out;
  };

  if (ti === 0 || ti === 4) { // summer + spring: flowers
    const petals = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      petals.push(place(new THREE.OctahedronGeometry(0.075, 0), Math.cos(a) * 0.08, 0.1, Math.sin(a) * 0.08, 1, 0.35, 0.65, 0, -a, 0));
    }
    petals.push(paint(place(new THREE.OctahedronGeometry(0.055, 0), 0, 0.12, 0, 1, 0.6, 1), 0xffd040));
    for (let k = 0; k < 5; k++) paint(petals[k], 0xffffff);
    const flowerGeo = T.g(mergeGeos(petals));
    const flowerMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true }));
    const flowers = clusters(Math.round(corridorArea * 0.035), [2, 5], 0.45, 0.6, (x, z) => ({ x, z, s: rng.range(0.9, 1.4), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) }));
    // a few around the outside too
    for (let i = 0; i < outerArea * 0.02; i++) {
      const p = sampleOuter(1.2, 20);
      flowers.push({ x: p.x, z: p.z, s: rng.range(1, 1.6), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) });
    }
    meshes.push(...inst(flowerGeo, flowerMat, flowers));
  } else if (ti === 1) {
    const leafShape = new THREE.Shape();
    leafShape.moveTo(-0.5, 0); leafShape.quadraticCurveTo(0, 0.32, 0.5, 0); leafShape.quadraticCurveTo(0, -0.32, -0.5, 0);
    const leafGeo = T.g(new THREE.ShapeGeometry(leafShape, 3)); leafGeo.rotateX(-Math.PI / 2);
    const leafMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide }));
    const leaves = clusters(Math.round(corridorArea * 0.06), [3, 7], 0.8, 0.5, (x, z) => ({ x, z, y: 0.015 + rng.range(0, 0.02), s: rng.range(0.22, 0.38), ry: rng.range(0, TAU), rx: rng.range(-0.15, 0.15), color: jitterColor(rng.pick(theme.smalls), 0.15) }));
    for (let i = 0; i < outerArea * 0.12; i++) {
      const p = sampleOuter(1, 26);
      leaves.push({ x: p.x, z: p.z, y: 0.02, s: rng.range(0.25, 0.42), ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.smalls), 0.15) });
    }
    meshes.push(...inst(leafGeo, leafMat, leaves));
    // pumpkins outside (cute)
    const pumpGeo = T.g(mergeGeos([
      paint(place(new THREE.SphereGeometry(0.4, 10, 6), 0, 0.3, 0, 1, 0.75, 1), 0xffffff),
      paint(place(new THREE.CylinderGeometry(0.04, 0.06, 0.18, 5), 0, 0.62, 0), 0x3b5a20),
    ]));
    const pumpMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true }));
    const pumps = [];
    for (let i = 0; i < Math.round(8 * Rn / 7); i++) {
      const p = sampleOuter(1.0, 6);
      pumps.push({ x: p.x, z: p.z, s: rng.range(0.6, 1.2), ry: rng.range(0, TAU), color: jitterColor(0xf08a24, 0.1) });
    }
    meshes.push(...inst(pumpGeo, pumpMat, pumps, { cast: QUALITY.propShadows }));
  } else if (ti === 2) {
    const moundGeo = T.g(new THREE.IcosahedronGeometry(0.5, 1));
    const moundMat = T.m(new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.8, flatShading: true }));
    const mounds = [];
    for (let i = 0; i < corridorArea * 0.025; i++) {
      const p = sampleCorridor(0.6); if (!p) continue;
      const s = rng.range(0.4, 0.9);
      mounds.push({ x: p.x, z: p.z, y: -0.1 * s, sx: s * 1.4, sy: s * 0.35, sz: s });
    }
    for (let i = 0; i < outerArea * 0.02; i++) {
      const p = sampleOuter(1.2, 26), s = rng.range(0.8, 2.2);
      mounds.push({ x: p.x, z: p.z, y: -0.15 * s, sx: s * 1.5, sy: s * 0.45, sz: s * 1.1, ry: rng.range(0, TAU) });
    }
    meshes.push(...inst(moundGeo, moundMat, mounds, { receive: true }));
    // ice crystals (faintly glowing)
    const crysGeo = T.g(place(new THREE.OctahedronGeometry(0.12, 0), 0, 0.12, 0, 1, 1.8, 1));
    const crysMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.35 })));
    const crys = clusters(Math.round(corridorArea * 0.012), [2, 4], 0.25, 0.5, (x, z) => ({ x, z, s: rng.range(0.7, 1.4), ry: rng.range(0, TAU), rz: rng.range(-0.3, 0.3), color: new THREE.Color(rng.pick(theme.smalls)) }));
    meshes.push(...inst(crysGeo, crysMat, crys));
    // snowmen outside
    const smGeo = T.g(mergeGeos([
      paint(place(new THREE.IcosahedronGeometry(0.55, 1), 0, 0.5, 0), 0xffffff),
      paint(place(new THREE.IcosahedronGeometry(0.4, 1), 0, 1.15, 0), 0xffffff),
      paint(place(new THREE.IcosahedronGeometry(0.28, 1), 0, 1.65, 0), 0xffffff),
      paint(place(new THREE.ConeGeometry(0.06, 0.3, 5), 0.38, 1.66, 0, 1, 1, 1, 0, 0, -Math.PI / 2), 0xff8a2a),
      paint(place(new THREE.CylinderGeometry(0.2, 0.22, 0.25, 8), 0, 1.98, 0), 0x2a2a3a),
    ]));
    const smMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }));
    const sms = [];
    const nSm = levelData.finale ? Math.round(levelData.runLength / 18) : Math.max(4, Math.round(8 * Rn / 20));
    for (let i = 0; i < nSm; i++) {
      const p = sampleOuter(1.5, 8);
      sms.push({ x: p.x, z: p.z, s: rng.range(0.8, 1.1), ry: (levelData.finale ? -Math.PI / 2 : -p.a + Math.PI) + rng.range(-0.5, 0.5) });   // the final run: face the camera
    }
    meshes.push(...inst(smGeo, smMat, sms, { cast: true }));
  } else {
    // neon: glowing mushrooms in corridors and outside, crystals outside
    const mushGeo = T.g(mergeGeos([
      paint(place(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 5), 0, 0.08, 0), 0x777799),
      paint(place(new THREE.SphereGeometry(0.13, 8, 4, 0, TAU, 0, Math.PI / 2), 0, 0.15, 0, 1, 0.7, 1), 0xffffff),
    ]));
    const mushMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.45 })));
    const mush = clusters(Math.round(corridorArea * 0.02), [2, 5], 0.4, 0.6, (x, z) => ({ x, z, s: rng.range(0.7, 1.5), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) }));
    for (let i = 0; i < outerArea * 0.03; i++) {
      const p = sampleOuter(1, 26);
      mush.push({ x: p.x, z: p.z, s: rng.range(1.2, 2.8), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) });
    }
    meshes.push(...inst(mushGeo, mushMat, mush));
    const crysGeo = T.g(place(new THREE.OctahedronGeometry(0.35, 0), 0, 0.6, 0, 0.7, 2.2, 0.7));
    const crysMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 0.5 })));
    const crys = [];
    for (let i = 0; i < outerArea * 0.006; i++) {
      const p = sampleOuter(2, 26), n = rng.int(2, 4);
      for (let k = 0; k < n; k++) {
        crys.push({ x: p.x + rng.range(-0.6, 0.6), z: p.z + rng.range(-0.6, 0.6), s: rng.range(0.6, 1.4), ry: rng.range(0, TAU), rx: rng.range(-0.35, 0.35), rz: rng.range(-0.35, 0.35), color: new THREE.Color(rng.pick([theme.accent, theme.wallTop, 0xb68cff])) });
      }
    }
    meshes.push(...inst(crysGeo, crysMat, crys, { cast: true }));
  }
  return meshes;
}

// The final run's surroundings: a frozen hell. Bare dead trees, jagged basalt spikes, scattered bones and skulls,
// dim ember glows in the ash. Everything instanced (in x chunks, so the off-screen stretches get culled). Tall things
// on the near side (+z, toward the camera) stand well back from the wall so they never hide the kitties.
function buildHellDecor(levelData, theme, T, rng, { inst, sampleOuter, sampleCorridor, outerArea, corridorArea, jitterColor }) {
  const meshes = [];
  const zWall = levelData.corridorWidth / 2 + CFG.WALL_THICKNESS / 2;
  // (Run + Skate's level 9: nothing in the gap between its two corridors either, the near side of the skate one)
  const between = (p) => levelData.combo && p.z > levelData.iceZMax - 0.5 && p.z < -zWall + 0.5;
  const nearOk = (p, clear) => !between(p) && (p.z < 0 || p.z - zWall > clear);   // far side: anything; near side: `clear` units back
  const outer = (lo, hi, clear) => {
    for (let k = 0; k < 6; k++) { const p = sampleOuter(lo, hi); if (nearOk(p, clear)) return p; }
    return null;
  };

  // ---- dead trees: a crooked trunk and a few bare, forking branches (3 shapes)
  const limb = (geos, x0, y0, z0, th, ph, L, r0, r1) => {
    const dx = Math.sin(th) * Math.cos(ph), dy = Math.cos(th), dz = -Math.sin(th) * Math.sin(ph);
    geos.push(place(new THREE.CylinderGeometry(r1, r0, L, 5, 1), x0 + dx * L / 2, y0 + dy * L / 2, z0 + dz * L / 2, 1, 1, 1, 0, ph, -th));
    return [x0 + dx * L, y0 + dy * L, z0 + dz * L];
  };
  const treeGeos = [0, 1, 2].map((v) => {
    const r = createRng(hashSeed('deadtree', v)), geos = [];
    const lean = r.range(-0.12, 0.12);
    const top = limb(geos, 0, -0.1, 0, lean, r.range(0, TAU), 2.7 + v * 0.3, 0.2, 0.09);
    const nb = 3 + (v % 2);
    for (let k = 0; k < nb; k++) {
      const f = 0.45 + 0.5 * (k / nb), ph = (k / nb) * TAU + r.range(-0.4, 0.4);
      const th = r.range(0.55, 1.05), L = r.range(0.8, 1.3) * (1.1 - f * 0.4);
      const b = limb(geos, top[0] * f, top[1] * f, top[2] * f, th, ph, L, 0.075, 0.035);
      limb(geos, b[0], b[1], b[2], th * 0.5, ph + r.range(-0.8, 0.8), L * 0.55, 0.035, 0.012);
      limb(geos, b[0], b[1], b[2], th + 0.5, ph + r.range(-0.6, 0.6), L * 0.4, 0.03, 0.01);
    }
    limb(geos, top[0], top[1], top[2], 0.35, r.range(0, TAU), 0.6, 0.06, 0.012);
    return T.g(mergeGeos(geos));
  });
  const barkMat = T.m(new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }));
  const treeItems = [[], [], []];
  for (let i = 0, n = Math.round(outerArea * 0.011); i < n; i++) {
    const p = outer(2.6, 26, 6); if (!p) continue;
    treeItems[i % 3].push({ x: p.x, z: p.z, s: rng.range(0.85, 1.5), ry: rng.range(0, TAU), color: jitterColor(theme.trunk, 0.25) });
  }
  treeItems.forEach((items, v) => meshes.push(...inst(treeGeos[v], barkMat, items, { cast: true })));

  // ---- jagged basalt spikes, in clumps
  const spikeGeo = T.g(mergeGeos([
    place(new THREE.ConeGeometry(0.42, 2.2, 4), 0, 1.0, 0, 1, 1, 1, 0.08, 0.3, 0.1),
    place(new THREE.ConeGeometry(0.3, 1.4, 4), 0.55, 0.62, 0.2, 1, 1, 1, -0.1, 1.1, -0.35),
    place(new THREE.ConeGeometry(0.26, 1.0, 4), -0.45, 0.42, -0.15, 1, 1, 1, 0.2, 2.0, 0.4),
  ]));
  const spikeMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1, flatShading: true }));
  const spikes = [];
  for (let i = 0, n = Math.round(outerArea * 0.006); i < n; i++) {
    const p = outer(2.2, 26, 4); if (!p) continue;
    spikes.push({ x: p.x, z: p.z, s: rng.range(0.7, 1.5), ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.2) });
  }
  meshes.push(...inst(spikeGeo, spikeMat, spikes, { cast: true, receive: true }));

  // ---- rocks outside, and the odd pebble on the ice (dark: they read on the pale ice)
  const rockGeo = T.g(new THREE.DodecahedronGeometry(0.5, 0));
  const rockMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }));
  const rocks = [];
  for (let i = 0, n = Math.round(outerArea * 0.006); i < n; i++) {
    const p = sampleOuter(1.5, 26), s = rng.range(0.5, 1.5);
    rocks.push({ x: p.x, z: p.z, y: 0.12 * s, sx: s * rng.range(0.8, 1.3), sy: s * rng.range(0.45, 0.8), sz: s, ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.15) });
  }
  for (let i = 0, n = Math.round(corridorArea * 0.012); i < n; i++) {
    const p = sampleCorridor(0.4); if (!p) continue;
    const s = rng.range(0.12, 0.24);
    rocks.push({ x: p.x, z: p.z, y: 0.03, sx: s * 1.3, sy: s * 0.5, sz: s, ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.15) });
  }
  meshes.push(...inst(rockGeo, rockMat, rocks, { cast: true, receive: true }));

  // ---- bones and skulls in the ash (never on the ice)
  const BONE = 0xd9cdb2;
  const boneGeo = T.g(mergeGeos([
    paint(place(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 5), 0, 0.06, 0, 1, 1, 1, 0, 0, Math.PI / 2), BONE),
    ...[[-0.33, 0.06], [-0.33, -0.06], [0.33, 0.06], [0.33, -0.06]].map(([x, z]) => paint(place(new THREE.IcosahedronGeometry(0.075, 0), x, 0.06, z), BONE)),
  ]));
  const skullGeo = T.g(mergeGeos([
    paint(place(new THREE.IcosahedronGeometry(0.3, 1), 0, 0.27, -0.03, 1, 0.85, 1.05), BONE),
    paint(place(new THREE.BoxGeometry(0.3, 0.14, 0.2), 0, 0.1, 0.18), BONE),
    paint(place(new THREE.IcosahedronGeometry(0.075, 0), -0.11, 0.28, 0.23), 0x1a0808),
    paint(place(new THREE.IcosahedronGeometry(0.075, 0), 0.11, 0.28, 0.23), 0x1a0808),
    paint(place(new THREE.ConeGeometry(0.035, 0.07, 3), 0, 0.17, 0.29, 1, 1, 1, Math.PI / 2, 0, 0), 0x1a0808),
  ]));
  const boneMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }));
  const bones = [], skulls = [];
  for (let i = 0, n = Math.round(outerArea * 0.012); i < n; i++) {
    const p = sampleOuter(0.9, 20), s = rng.range(0.8, 1.4);
    bones.push({ x: p.x, z: p.z, s, ry: rng.range(0, TAU), color: new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.75, 1)) });
    if (rng.chance(0.4)) bones.push({ x: p.x + rng.range(-0.3, 0.3), z: p.z + rng.range(-0.3, 0.3), y: 0.08, s, ry: rng.range(0, TAU), color: new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.75, 1)) });
  }
  for (let i = 0, n = Math.round(outerArea * 0.0018); i < n; i++) {
    const p = sampleOuter(1.0, 18);
    skulls.push({ x: p.x, z: p.z, s: rng.range(0.9, 1.4), ry: rng.range(-0.6, 0.6), rx: rng.range(-0.15, 0.1), color: new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.8, 1)) });
  }
  meshes.push(...inst(boneGeo, boneMat, bones, { receive: true }));
  meshes.push(...inst(skullGeo, boneMat, skulls, { cast: true, receive: true }));

  // ---- faint ember glows smouldering in the ash
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);
  const glowMat = T.m(new THREE.MeshBasicMaterial({ map: makeGlowTexture(T), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const embers = [];
  for (let i = 0, n = Math.round(outerArea * 0.0025); i < n; i++) {
    const p = sampleOuter(2, 26);
    embers.push({ x: p.x, z: p.z, y: 0.02, s: rng.range(2.5, 6), ry: rng.range(0, TAU), color: new THREE.Color(0xff3a10).multiplyScalar(rng.range(0.12, 0.26)) });
  }
  for (const g of inst(glowGeo, glowMat, embers)) { g.renderOrder = 1; meshes.push(g); }
  return meshes;
}

// ---------------------------------------------------------------- night (Skate only's seasons)

// Dresses a built level for the night (the ground off the lanes is already dark: NIGHT_GROUND): everything off the maze tinted
// dark, the small things lying on the ice halved and muted toward the ice (not in winter), and in summer hailstones and
// the newspaper. Returns the meshes to add.
function nightDress(group, ld, ti, T) {
  const out = [];
  const R = ld.outerRadius + 0.6;
  const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  const tint = new THREE.Color(NIGHT_TINT), white = new THREE.Color(1, 1, 1), ice = new THREE.Color(NIGHT_ICE);
  const pos = (o, i) => { o.getMatrixAt(i, M); return V.setFromMatrixPosition(M); };
  group.traverse((o) => {
    if (!o.isInstancedMesh || o.count < 2) return;
    const outside = [], low = [];
    for (let i = 0; i < o.count; i++) { const p = pos(o, i); outside.push(Math.max(Math.abs(p.x), Math.abs(p.z)) > R || locate(ld, p.x, p.z).leg === -2); low.push(p.y < 0.2); }
    const inside = outside.filter((x) => !x).length, lowIn = outside.filter((x, i) => !x && low[i]).length;
    const floorDecor = ti !== 2 && inside > 60 && lowIn / inside > 0.9 && !o.material.map;
    if (!outside.some(Boolean) && !floorDecor) return;
    const had = !!o.instanceColor, c = new THREE.Color();
    for (let i = 0; i < o.count; i++) {
      if (had) o.getColorAt(i, c); else c.copy(white);
      if (outside[i]) c.multiply(tint);
      else if (floorDecor) {
        if (i % 2) { o.getMatrixAt(i, M); M.decompose(V, Q, S); S.setScalar(0); M.compose(V, Q, S); o.setMatrixAt(i, M); }
        c.lerp(ice, ti === 4 ? 0.45 : 0.35);
      }
      o.setColorAt(i, c);
    }
    o.instanceColor.needsUpdate = true; o.instanceMatrix.needsUpdate = true;
  });
  if (ti === 0) out.push(summerHail(ld, R, T), summerNewspaper(ld, T));
  return out;
}

// summer: hailstones lying on the ice (seeded, so everyone sees the same)
function summerHail(ld, R, T) {
  const rng = createRng(hashSeed(ld.seed ?? 1, ld.level ?? 1, 'hail'));
  const items = [];
  for (let t = 0; items.length < 600 && t < 20000; t++) {
    const x = rng.range(-R + 1, R - 1), z = rng.range(-R + 1, R - 1);
    if (locate(ld, x, z).leg < 0 || collideCircle(ld, x, z, 0.3).hit) continue;
    items.push({ x, z, y: 0.06, s: rng.range(0.8, 1.3), ry: rng.range(0, TAU) });
  }
  const geo = T.g(new THREE.IcosahedronGeometry(0.11, 0)); geo.scale(1, 0.7, 1);
  return makeInstanced(geo, T.m(new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.35 })), items);
}

// summer's easter egg: a weathered newspaper lying flat on one of the safe squares (feet go over it)
function summerNewspaper(ld, T) {
  return newspaper(ld, T, 'paper', (g) => {
    g.font = 'italic 20px Georgia, serif'; g.fillText('Midsummer edition  ·  Meow-tropolis', 384, 140);
    g.font = 'bold 44px Georgia, serif'; g.fillText('SURPRISE HAILSTORM', 384, 200); g.fillText('EXPECTED FOR MIDSUMMER', 384, 250); g.fillText('IN FINLAND', 384, 300);
    g.fillStyle = '#8f969c'; g.fillRect(52, 330, 270, 180); g.fillStyle = '#545b63'; g.beginPath(); g.ellipse(185, 385, 95, 38, 0, 0, TAU); g.fill();
    g.fillStyle = '#f3f3f0'; for (let i = 0; i < 24; i++) { g.beginPath(); g.arc(100 + (i % 8) * 24, 440 + Math.floor(i / 8) * 20, 5, 0, TAU); g.fill(); }
  });
}

// another one: the kitty with the most revives this run makes the front page (hero: { name, saves }, from main.js as
// the level is built; nobody with a few revives yet: no paper). The photo is a star of life with the count on it.
function heroNewspaper(ld, T, hero) {
  return newspaper(ld, T, 'heropaper', (g) => {
    g.font = 'italic 20px Georgia, serif'; g.fillText('Extra edition  ·  Meow-tropolis', 384, 140);
    const name = String(hero.name || 'A kitty').toUpperCase();
    let px = 50; do { g.font = 'bold ' + px + 'px Georgia, serif'; px -= 2; } while (px > 18 && g.measureText(name).width > 660);
    g.fillText(name, 384, 200);
    g.font = 'bold 44px Georgia, serif'; g.fillText('IS SAVING LOTS OF', 384, 250); g.fillText('LIVES TODAY!', 384, 300);
    g.fillStyle = '#8f969c'; g.fillRect(52, 330, 270, 180);
    g.save(); g.translate(187, 420); g.fillStyle = '#3f6fb5';
    for (let i = 0; i < 3; i++) { g.fillRect(-21, -70, 42, 140); g.rotate(Math.PI / 3); }
    g.restore();
    g.fillStyle = '#f3f3f0'; g.font = 'bold 40px Georgia, serif'; g.fillText(String(hero.saves), 187, 434);
  });
}

// the sheet itself (torn edge, masthead, columns of text, fold, creases, stains, a paw print), lying on a safe square
// picked by the level's seed; print(g) draws the headline and the photo (centred dark ink is set)
function newspaper(ld, T, salt, print) {
  const rng = createRng(hashSeed(ld.seed ?? 1, ld.level ?? 1, salt));
  const cv = document.createElement('canvas'); cv.width = 768; cv.height = 560; const g = cv.getContext('2d');
  g.save(); g.beginPath(); const pts = [];
  const edge = (x0, y0, x1, y1, n) => { for (let i = 0; i <= n; i++) { const t = i / n; pts.push([x0 + (x1 - x0) * t + rng.range(-7, 7), y0 + (y1 - y0) * t + rng.range(-7, 7)]); } };
  edge(30, 30, 738, 24, 22); edge(744, 30, 736, 420, 12); pts.push([700, 470], [660, 530]); edge(640, 536, 26, 530, 20); edge(22, 526, 30, 34, 14);
  g.moveTo(...pts[0]); for (const q of pts) g.lineTo(...q); g.closePath(); g.clip();
  const grd = g.createLinearGradient(0, 0, 768, 560); grd.addColorStop(0, '#e9dfc4'); grd.addColorStop(1, '#d8cba6'); g.fillStyle = grd; g.fillRect(0, 0, 768, 560);
  g.fillStyle = '#2a2622'; g.textAlign = 'center'; g.font = 'bold 62px Georgia, serif'; g.fillText('THE DAILY WHISKER', 384, 92); g.fillRect(44, 112, 680, 5);
  print(g);
  g.fillStyle = '#6d6a64'; for (let col = 0; col < 2; col++) for (let r = 0; r < 9; r++) g.fillRect(350 + col * 190, 336 + r * 19, 170 - ((r * 7 + col) % 4) * 18, 7);
  const fold = g.createLinearGradient(370, 0, 398, 0); fold.addColorStop(0, 'rgba(0,0,0,0)'); fold.addColorStop(0.5, 'rgba(60,45,20,0.28)'); fold.addColorStop(0.55, 'rgba(255,255,255,0.18)'); fold.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = fold; g.fillRect(360, 0, 48, 560);
  for (let i = 0; i < 14; i++) { const x = rng.range(40, 720), y = rng.range(40, 520), a = rng.range(0, Math.PI), l = rng.range(60, 180); g.strokeStyle = 'rgba(70,55,30,' + rng.range(0.06, 0.14).toFixed(3) + ')'; g.lineWidth = rng.range(2, 5); g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
  for (let i = 0; i < 5; i++) { const x = rng.range(80, 700), y = rng.range(80, 480), r = rng.range(40, 95); const st = g.createRadialGradient(x, y, r * 0.6, x, y, r); st.addColorStop(0, 'rgba(160,130,70,0.10)'); st.addColorStop(0.85, 'rgba(140,105,50,0.28)'); st.addColorStop(1, 'rgba(140,105,50,0)'); g.fillStyle = st; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
  const vg = g.createRadialGradient(384, 280, 220, 384, 280, 470); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(120,90,40,0.35)'); g.fillStyle = vg; g.fillRect(0, 0, 768, 560);
  g.fillStyle = 'rgba(70,50,30,0.55)'; g.beginPath(); g.ellipse(610, 470, 26, 22, 0, 0, TAU); g.fill();
  for (const [dx, dy] of [[-30, -32], [-10, -44], [12, -44], [32, -32]]) { g.beginPath(); g.ellipse(610 + dx, 470 + dy, 10, 13, 0, 0, TAU); g.fill(); }
  g.restore();
  const tex = T.t(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mat = T.m(new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.5, roughness: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const sq = ld.safeCorners.length > 1 ? ld.safeCorners[1 + Math.floor(rng.next() * (ld.safeCorners.length - 1))] : ld.safeCorners[0];
  const paper = new THREE.Mesh(T.g(new THREE.PlaneGeometry(2.8, 2.04)), mat);
  paper.rotation.set(-Math.PI / 2, 0, rng.range(-0.6, 0.6));
  paper.position.set(sq.x + rng.range(-1.6, 1.6), 0.012, sq.z + rng.range(-1.6, 1.6)); paper.renderOrder = 1; paper.receiveShadow = true;
  return paper;
}

// ---------------------------------------------------------------- particles

// box = { w, d } (the final run): instead of a disc over the whole map, the particles fill a w x d box that wraps
// around the camera's ground focus (read in onBeforeRender), so a 870-unit straight keeps the spiral's density.
function buildParticles(theme, rng, radius, T, box = null) {
  const kind = theme.particles;
  const area = box ? box.w * box.d : Math.PI * radius * radius;
  const thin = theme.night && theme.nightTi !== 2, hail = theme.night && theme.nightTi === 0;   // night skate seasons: a third; summer: hail
  const count = Math.round(clamp(area * 0.1, 300, 1300) * QUALITY.particles * (thin ? 1 / 3 : 1));
  if (!count) return { points: null, update() {} };   // (Ultra low: no weather at all, not even an empty layer)
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const base = new Float32Array(count * 5); // bx, bz, by, phase, speed
  const c = new THREE.Color();
  let palette, H, size, additive, sprite;
  if (kind === 'pollen') { palette = [0xfff6c0, 0xffffff, 0xfff0a0]; H = 4; size = 0.16; additive = true; sprite = 'dot'; }
  else if (kind === 'leaves') { palette = theme.crowns; H = 11; size = 0.42; additive = false; sprite = 'leaf'; }
  else if (kind === 'snow') { palette = [0xffffff, 0xf0f6ff]; H = 12; size = 0.2; additive = false; sprite = 'snow'; }
  else { palette = theme.particlePalette || [theme.accent, theme.wallTop, 0xb68cff]; H = 7; size = 0.26; additive = true; sprite = 'dot'; }
  if (hail) { palette = [0xf4f8ff, 0xffffff]; H = 12; size = 0.14; additive = false; sprite = 'snow'; }
  const bright = hail ? 1 : kind === 'motes' || kind === 'pollen' ? 0.9 : 1;
  for (let i = 0; i < count; i++) {
    if (box) { base[i * 5] = rng.range(0, box.w); base[i * 5 + 1] = rng.range(0, box.d); } else {
      const r = radius * Math.sqrt(rng.next()), a = rng.range(0, TAU);
      base[i * 5] = r * Math.cos(a); base[i * 5 + 1] = r * Math.sin(a);
    }
    base[i * 5 + 2] = kind === 'pollen' ? rng.range(0.4, 3.5) : rng.range(0, H);
    base[i * 5 + 3] = rng.range(0, 100);
    base[i * 5 + 4] = hail ? rng.range(4, 6) : kind === 'leaves' ? rng.range(0.6, 1.2) : kind === 'snow' ? rng.range(0.7, 1.5) : rng.range(0.25, 0.6);
    c.set(rng.pick(palette)).multiplyScalar(bright * rng.range(0.85, 1.1));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const g = T.g(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = T.m(new THREE.PointsMaterial({
    size, map: makeSpriteTexture(sprite, T), vertexColors: true, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true, opacity: kind === 'pollen' ? 0.75 : 1,
  }));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  let fx = 0, fz = 0;
  if (box) {
    const dir = new THREE.Vector3();
    pts.onBeforeRender = (renderer, scene, camera) => {
      camera.getWorldDirection(dir);
      const p = camera.position, k = dir.y < -0.05 ? -p.y / dir.y : 0;
      fx = p.x + dir.x * k; fz = p.z + dir.z * k;
    };
  }
  const update = (t) => {
    const ox = fx - (box ? box.w / 2 : 0), oz = fz - (box ? box.d / 2 : 0);
    for (let i = 0; i < count; i++) {
      const o = i * 5, bx = base[o], bz = base[o + 1], by = base[o + 2], ph = base[o + 3], sp = base[o + 4];
      let x, y, z;
      if (hail) {   // hail: falls fast and straight
        y = ((by - t * sp) % H + H) % H + 0.05; x = bx; z = bz;
      } else if (kind === 'pollen') {
        x = bx + Math.sin(t * 0.3 * sp + ph) * 1.6; z = bz + Math.cos(t * 0.27 * sp + ph * 1.3) * 1.6;
        y = by + Math.sin(t * 0.8 * sp + ph * 2) * 0.35;
      } else if (kind === 'motes') {
        y = (by + t * sp) % H + 0.2;
        x = bx + Math.sin(t * 0.5 + ph) * 0.8; z = bz + Math.cos(t * 0.43 + ph * 1.7) * 0.8;
      } else {
        const fall = ((by - t * sp) % H + H) % H;
        y = fall + 0.05;
        const sway = kind === 'leaves' ? 1.1 : 0.45;
        x = bx + Math.sin(t * 1.2 * sp + ph) * sway + (H - fall) * 0.25;
        z = bz + Math.cos(t * 0.9 * sp + ph * 1.3) * sway;
      }
      if (box) { x = ox + (((x - ox) % box.w) + box.w) % box.w; z = oz + (((z - oz) % box.d) + box.d) % box.d; }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    g.attributes.position.needsUpdate = true;
  };
  update(0);
  return { points: pts, update };
}

// Fall and winter lanes on foot (levelData.piles, version 25+): the shield's leaf / snow pile (models.js createShieldPile),
// about 0.95 across its foot (a touch inside CFG.PILE_RADIUS: you're safe from its edge on, and a kitty walking in
// disappears into it), each turned its own way
function buildLanePiles(levelData) {
  return (levelData.piles || []).map((p, i) => {
    const pile = createShieldPile(p.kind, true, createRng(3).next);   // (with three bumps on top and leaves scattered round its foot; the same heap every time)
    pile.update(0, 1, 0, true);
    pile.group.position.set(p.x, 0, p.z);
    pile.group.scale.multiplyScalar(1.55).multiply(new THREE.Vector3(1, 0.8, 1));   // (lower than the shield's heap: a pile on the ground)
    pile.group.rotation.y = i * 2.4;
    return pile.group;
  });
}

// Climbable trees (autumn levels; spring from level version 25, green and leafy with some blossom): a thick trunk and a broad, flat-topped canopy the kitties stand on (CLIMB_Y).
const CLIMB_Y = 2.2;
const SPRING_GREENS = [0x9ccf6a, 0x86c25e, 0xaed67a];
// spring trees: mostly fresh green leaves (the piles' leaf shape), about one in five a pink / white blossom
// (deep green, so the tree stands out from the spring grass)
const SPRING_CANOPY = [0x2c6129, 0x346f30, 0x265625], SPRING_LEAVES = [0x3c8237, 0x4a9141, 0x336f30, 0x57a04b, 0x2e6a2c], SPRING_BLOSSOM = [0xffb7d5, 0xff9ec7, 0xfff0f6], SPRING_LEAF_N = 420, SPRING_TOP_N = 460;
function buildClimbTrees(levelData, theme, T) {
  const trees = levelData.trees || [];
  if (!trees.length) return [];
  const R = CFG.TREE_RADIUS;
  const rng = createRng(hashSeed(levelData.seed ?? 1, levelData.level ?? 1, 'climbtrees'));
  const trunkGeo = T.g(new THREE.CylinderGeometry(0.28, 0.42, CLIMB_Y, 7));
  trunkGeo.translate(0, CLIMB_Y / 2 - 0.1, 0);
  const blobGeo = T.g(new THREE.IcosahedronGeometry(1, 1));
  const trunkMat = T.m(coversWolves(new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 1, flatShading: true })));
  const leafMat = T.m(coversWolves(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const per = 6;
  const blobs = new THREE.InstancedMesh(blobGeo, leafMat, trees.length * per);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const c = new THREE.Color();
  const spring = theme === THEMES[4] && !levelData.finale, puffs = trees.map(() => []);   // spring (level version 25+): leafy trees
  trees.forEach((t, i) => {
    m.compose(pos.set(t.x, 0, t.z), q.setFromEuler(e.set(0, rng.range(0, TAU), 0)), sc.set(1, 1, 1));
    trunks.setMatrixAt(i, m);
    // one big flat center pad (what the kitties stand on) + puffs around its rim
    for (let k = 0; k < per; k++) {
      let x = t.x, z = t.z, y = CLIMB_Y - 0.45, sx = R + 0.2, sy = 0.45, sz = R + 0.2;
      if (k > 0) {
        const a = (k / (per - 1)) * TAU + rng.range(-0.3, 0.3), d = R * 0.85;
        x += Math.cos(a) * d; z += Math.sin(a) * d; y = CLIMB_Y - 0.55; sx = sz = rng.range(0.7, 0.95); sy = 0.5;
      }
      m.compose(pos.set(x, y, z), q.setFromEuler(e.set(0, rng.range(0, TAU), 0)), sc.set(sx, sy, sz));
      blobs.setMatrixAt(i * per + k, m);
      if (spring) puffs[i].push({ x, y, z, sx, sy, sz });
      blobs.setColorAt(i * per + k, c.set(theme.crowns[(i + k) % theme.crowns.length]).multiplyScalar(k ? 0.9 : 1));
      if (spring) blobs.setColorAt(i * per + k, c.set(k && (k + i) % 5 === 0 ? SPRING_BLOSSOM[(i + k) % 2] : SPRING_CANOPY[(i + k) % SPRING_CANOPY.length]).multiplyScalar(k ? 0.95 : 1));   // deeper green under the leaves, now and then a pink puff
    }
  });
  if (spring) {
    // leaves all over the canopy: lying on its puffs (on their surface, never under them or floating off them), and a low
    // leaf pile on top (each tree its own size) a kitty up the tree sinks into up to its neck
    const leaves = new THREE.InstancedMesh(T.g(shieldLeafGeo()), T.m(coversWolves(new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true, side: THREE.DoubleSide }))), trees.length * (SPRING_LEAF_N + SPRING_TOP_N));
    const n = new THREE.Vector3(), tg = new THREE.Vector3(), bt = new THREE.Vector3(), M3 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), dir = new THREE.Vector3();
    const inside = (ps, x, y, z, skip) => ps.some((b, j) => j !== skip && ((x - b.x) / b.sx) ** 2 + ((y - b.y) / b.sy) ** 2 + ((z - b.z) / b.sz) ** 2 < 0.92);
    let at = 0;
    const tops = [];
    const put = (bloom, size) => {
      leaves.setMatrixAt(at, m.compose(pos, q, sc.setScalar(size)));
      leaves.setColorAt(at++, c.set(bloom ? SPRING_BLOSSOM[at % 3] : SPRING_LEAVES[at % SPRING_LEAVES.length]).multiplyScalar(rng.range(0.85, 1.05)));
    };
    trees.forEach((t, i) => {
      const ps = puffs[i];
      for (let k = 0, tries = 0; k < SPRING_LEAF_N && tries < SPRING_LEAF_N * 6; tries++) {
        const j = (rng.next() * ps.length) | 0, b = ps[j];
        dir.set(rng.range(-1, 1), rng.range(-0.25, 1), rng.range(-1, 1)).normalize();   // (the top and sides of a puff, not its underside)
        pos.set(b.x + dir.x * b.sx, b.y + dir.y * b.sy, b.z + dir.z * b.sz);
        if (inside(ps, pos.x, pos.y, pos.z, j)) continue;   // (inside another puff: nobody would see it)
        n.set(dir.x / b.sx, dir.y / b.sy, dir.z / b.sz).normalize().lerp(dir.set(0, 1, 0), 0.4).normalize();   // (eased toward flat: no leaf on edge to the camera)
        pos.addScaledVector(n, 0.03);
        tg.set(-n.z, 0, n.x).normalize(); if (tg.lengthSq() < 0.01) tg.set(1, 0, 0); bt.crossVectors(n, tg).normalize(); tg.crossVectors(bt, n);
        q.setFromRotationMatrix(M3.makeBasis(bt, n, tg)).multiply(q2.setFromEuler(e.set(rng.range(-0.5, 0.5), rng.range(0, TAU), 0)));
        const bloom = rng.next() < 0.2;
        put(bloom, bloom ? rng.range(0.13, 0.18) : rng.range(0.17, 0.25));
        k++;
      }
      // the pile on top: a low dome (0.75-1 of the pad across, 0.28-0.42 high: never over a kitty's head), its leaves lying
      // on it along the slope like the lanes' piles (models.js createShieldPile), over a green core so no gaps show through
      const pr = (R + 0.1) * rng.range(0.75, 1), ph = rng.range(0.28, 0.42);
      tops.push({ x: t.x, y: CLIMB_Y - 0.06, z: t.z, sx: pr * 0.9, sy: ph * 0.85, sz: pr * 0.9, ry: rng.range(0, TAU), color: new THREE.Color(SPRING_CANOPY[i % SPRING_CANOPY.length]).multiplyScalar(1.1) });
      for (let k = 0; k < SPRING_TOP_N; k++) {
        const a = rng.range(0, TAU), d = pr * Math.sqrt(rng.next()), top = ph * Math.pow(Math.max(0, 1 - (d / pr) ** 2), 0.75);
        pos.set(t.x + Math.cos(a) * d, CLIMB_Y - 0.06 + top * rng.range(0.75, 1) + 0.02, t.z + Math.sin(a) * d);
        // lying on the dome (turned to its slope where it is, outward whichever side), any way round, a little ruffled
        const sl = 1.6 * (d / pr) * (ph / pr);
        n.set(Math.cos(a) * sl + rng.range(-0.25, 0.25), 1, Math.sin(a) * sl + rng.range(-0.25, 0.25)).normalize();
        q.setFromUnitVectors(dir.set(0, 1, 0), n).multiply(q2.setFromAxisAngle(dir, rng.range(0, TAU)));
        const bloom = rng.next() < 0.18;
        put(bloom, bloom ? rng.range(0.13, 0.17) : rng.range(0.16, 0.23));
      }
    });
    leaves.count = at;
    leaves.castShadow = true;
    trunks.castShadow = blobs.castShadow = true; blobs.receiveShadow = true;
    const cores = makeInstanced(T.g(new THREE.SphereGeometry(1, 14, 8, 0, TAU, 0, Math.PI / 2)), T.m(coversWolves(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }))), tops, { cast: true, receive: true });
    return [trunks, blobs, leaves, cores];
  }
  trunks.castShadow = blobs.castShadow = true;
  blobs.receiveShadow = true;
  if (!levelData.finale) return [trunks, blobs];
  // the final run's tree: smouldering. A charred canopy with glowing coals on the pad and round its rim, and glowing
  // cracks up the trunk (unlit, so it stands out in the dark). On the ice (the skate final run) it's snowed on: snow
  // caps on the pad and the rim puffs, the coals glowing out round their edges
  const coals = [], cracks = [], caps = [];
  trees.forEach((t, i) => {
    const snowy = t.snowy ?? !!levelData.ice;   // Run + Skate's level 9: per tree (its skate half's)
    for (let k = 0; k < per; k++) blobs.setColorAt(i * per + k, c.set(k % 2 ? 0x2e1f1c : 0x3c2622));
    if (snowy) {
      caps.push({ x: t.x, z: t.z, y: CLIMB_Y - 0.06, sx: R * 0.6, sy: 0.16, sz: R * 0.55, ry: rng.range(0, TAU) });
      for (let k = 1; k < per; k++) {
        blobs.getMatrixAt(i * per + k, m); m.decompose(pos, q, sc);
        caps.push({ x: pos.x, z: pos.z, y: pos.y + sc.y * 0.92, sx: sc.x * 0.55, sy: 0.15, sz: sc.z * 0.55, ry: rng.range(0, TAU) });
      }
    }
    for (let k = 0; k < 9; k++) {   // on the pad (snowy: round the edge of the snow cap)
      const a = rng.range(0, TAU), d = snowy ? rng.range(R * 0.62, R * 0.8) : rng.range(0, R * 0.7);
      coals.push({ x: t.x + Math.cos(a) * d, z: t.z + Math.sin(a) * d, y: CLIMB_Y - 0.02, sx: rng.range(0.18, 0.34), sy: 0.07, sz: rng.range(0.18, 0.34), ry: rng.range(0, TAU), color: new THREE.Color(k % 3 ? 0xff5a1a : 0xffa040) });
    }
    for (let k = 1; k < per; k++) {   // on the rim puffs
      blobs.getMatrixAt(i * per + k, m); m.decompose(pos, q, sc);
      for (let j = 0; j < 2; j++) {
        const a = rng.range(0, TAU), d = sc.x * 0.5;
        coals.push({ x: pos.x + Math.cos(a) * d, z: pos.z + Math.sin(a) * d, y: pos.y + sc.y * 0.4, sx: rng.range(0.14, 0.26), sy: 0.08, sz: rng.range(0.14, 0.26), ry: rng.range(0, TAU), color: new THREE.Color(j ? 0xff7a2a : 0xff4a14) });
      }
    }
    for (let k = 0; k < 5; k++) {   // cracks up the trunk
      const a = (k / 5) * TAU + rng.range(-0.3, 0.3), r = 0.36 - 0.08 * rng.range(0, 1);
      cracks.push({ x: t.x + Math.cos(a) * r, z: t.z + Math.sin(a) * r, y: rng.range(0.4, 1.3), sx: 0.05, sy: rng.range(0.35, 0.7), sz: 0.05, ry: -a, color: new THREE.Color(0xff5a1e) });
    }
  });
  blobs.instanceColor.needsUpdate = true;
  const emberMat = T.m(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const out = [trunks, blobs,
    makeInstanced(T.g(new THREE.IcosahedronGeometry(1, 1)), emberMat, coals),
    makeInstanced(T.g(new THREE.BoxGeometry(1, 1, 1)), emberMat, cracks)];
  if (caps.length) out.push(makeInstanced(T.g(new THREE.IcosahedronGeometry(1, 1)), T.m(coversWolves(new THREE.MeshStandardMaterial({ color: 0xf6faff, roughness: 0.7, flatShading: true }))), caps, { cast: true, receive: true }));
  return out;
}

// Checkpoint squares (every level but the final run): a glowing ring with cat ears on the tile (a cat's head
// outline, ears toward the top of the screen) and a pennant with a paw print in its back corner.
function buildCheckpoints(levelData, T) {
  const out = [];
  const ringMat = T.m(new THREE.MeshBasicMaterial({ color: 0x6cccff, transparent: true, opacity: 0.68, depthWrite: false }));
  const poleMat = T.m(new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.6, metalness: 0.3 }));
  // pennant texture: blue with a white paw print. ShapeGeometry UVs are the shape's own coordinates
  // (x 0..1.1, y -0.7..0), so repeat/offset map them onto the canvas.
  const flagTex = textTexture(T, 256, 256, (g, S) => {
    g.fillStyle = '#3fb8ff'; g.fillRect(0, 0, S, S);
    g.save(); g.translate(S * 0.34, S * 0.5); g.scale(0.7 / 1.1, 1);
    drawPaw(g, 0, 0, 1.25, '#ffffff', null);
    g.restore();
  });
  flagTex.repeat.set(1 / 1.1, 1 / 0.7); flagTex.offset.set(0, 1);
  const flagMat = T.m(new THREE.MeshStandardMaterial({ map: flagTex, emissiveMap: flagTex, emissive: 0x2a8fe0, emissiveIntensity: 0.5, roughness: 0.7, side: THREE.DoubleSide }));
  const ringParts = [new THREE.RingGeometry(2.6, 3.0, 48)];
  for (const sgn of [-1, 1]) {
    // base chord just outside the ring (no double-blended overlap), tip leaning slightly outward
    const a = Math.PI / 2 + sgn * 0.6, w = 0.3, rb = 2.99 / Math.cos(w), ear = new THREE.Shape();
    ear.moveTo(Math.cos(a - w) * rb, Math.sin(a - w) * rb);
    ear.lineTo(Math.cos(a + sgn * 0.08) * 4.15, Math.sin(a + sgn * 0.08) * 4.15);
    ear.lineTo(Math.cos(a + w) * rb, Math.sin(a + w) * rb);
    ear.closePath();
    ringParts.push(new THREE.ShapeGeometry(ear));
  }
  const ringGeo = T.g(mergeGeos(ringParts));
  const poleGeo = T.g(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 8));
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0); flagShape.lineTo(1.1, -0.32); flagShape.lineTo(0, -0.7); flagShape.closePath();
  const flagGeo = T.g(new THREE.ShapeGeometry(flagShape));
  const medic = [];
  for (const cp of levelData.checkpoints || []) {
    if (cp.medic) { medic.push(buildMedicCheckpoint(levelData, cp, T, { ringParts, poleGeo, flagGeo })); continue; }
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cp.x, 0.02, cp.z);
    out.push(ring);
    // back corner of the square (behind the run direction, on the left), clear of the 3x3 arrival block
    const fx = Math.cos(cp.heading), fz = Math.sin(cp.heading), off = (levelData.safeSize || levelData.corridorWidth) / 2 - 1;
    const x = cp.x - fx * off - fz * off, z = cp.z - fz * off + fx * off;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, 1.3, z);
    pole.castShadow = true;
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(x, 2.55, z);
    // the pennant faces the camera (which looks toward -z) so its paw print shows, flying in over the square
    flag.rotation.y = x < cp.x ? 0 : Math.PI;
    flag.scale.setScalar(1.2);
    out.push(pole, flag);
  }
  for (const m of medic) out.push(m.group);
  out.medic = medic;
  return out;
}

// The medic checkpoint (Run + Skate's level 9, the run half's start room): broken until a kitty with 60+ revives this
// run steps on it. Broken: a cracked ring in a few dim pieces that flickers like a dying neon sign, one cat ear left,
// the pole snapped (its top lying beside the stump) and the torn medic pennant on the floor. Repaired: the whole ring
// glowing medic red, both ears, the pole standing and a white pennant with the red star of life.
function buildMedicCheckpoint(levelData, cp, T, { ringParts, poleGeo, flagGeo }) {
  const group = new THREE.Group(), broken = new THREE.Group(), fixed = new THREE.Group();
  group.add(broken, fixed);
  fixed.visible = false;
  const fx = Math.cos(cp.heading), fz = Math.sin(cp.heading), off = (levelData.safeSize || levelData.corridorWidth) / 2 - 1;
  const px = cp.x - fx * off - fz * off, pz = cp.z - fz * off + fx * off;
  const medicTex = (faded) => textTexture(T, 256, 256, (g, S) => {
    g.fillStyle = faded ? '#9a9496' : '#f8f8f5'; g.fillRect(0, 0, S, S);
    g.save(); g.translate(S * 0.34, S * 0.5); g.scale(0.7 / 1.1, 1);
    g.fillStyle = faded ? '#7a3a3e' : '#e2352f';
    for (const a of [0, Math.PI / 3, -Math.PI / 3]) { g.save(); g.rotate(a); g.fillRect(-46, -13, 92, 26); g.restore(); }
    g.fillStyle = faded ? '#9a9496' : '#f8f8f5'; g.fillRect(-4, -40, 8, 80);   // the staff
    g.restore();
    if (faded) {   // scorch marks
      for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(30,20,20,${0.2 + 0.3 * Math.random()})`; g.beginPath(); g.arc(Math.random() * S, Math.random() * S, 6 + Math.random() * 18, 0, TAU); g.fill(); }
    }
  });
  const flagMat = (faded) => {
    const t = medicTex(faded); t.repeat.set(1 / 1.1, 1 / 0.7); t.offset.set(0, 1);
    return T.m(new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: faded ? 0x000000 : 0xff6a6a, emissiveIntensity: faded ? 0 : 0.35, roughness: 0.8, side: THREE.DoubleSide }));
  };
  const poleMat = T.m(new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.6, metalness: 0.3 }));
  const rustMat = T.m(new THREE.MeshStandardMaterial({ color: 0x8a8078, roughness: 0.85, metalness: 0.2 }));

  // ---- broken
  const dimMat = T.m(new THREE.MeshBasicMaterial({ color: 0x9fb4c4, transparent: true, opacity: 0.32, depthWrite: false }));
  const arcs = [[0.25, 1.35, 0], [1.95, 1.05, 0.06], [3.35, 1.6, -0.05], [5.3, 0.55, 0.1]];
  for (const [a0, len, shift] of arcs) {
    const arc = new THREE.Mesh(T.g(new THREE.RingGeometry(2.6, 3.0, 16, 1, a0, len)), dimMat);
    arc.rotation.x = -Math.PI / 2; arc.rotation.z = shift;
    arc.position.set(cp.x + shift * 2, 0.02, cp.z - shift * 1.5);
    broken.add(arc);
  }
  const ear = new THREE.Mesh(T.g(ringParts[1].clone()), dimMat);   // one ear left
  ear.rotation.x = -Math.PI / 2; ear.rotation.z = 0.12;
  ear.position.set(cp.x, 0.02, cp.z);
  broken.add(ear);
  const stump = new THREE.Mesh(poleGeo, rustMat);   // the pole snapped low, leaning
  stump.scale.set(1, 0.38, 1); stump.position.set(px, 0.45, pz); stump.rotation.z = 0.25; stump.castShadow = true;
  const top = new THREE.Mesh(poleGeo, rustMat);     // its top lying on the floor
  top.scale.set(1, 0.6, 1); top.rotation.z = Math.PI / 2 - 0.1; top.rotation.y = 0.5;
  const ix = Math.sign(cp.x - px), iz = Math.sign(cp.z - pz);   // toward the middle of the square
  top.position.set(px + ix * 0.9, 0.08, pz + iz * 0.6); top.castShadow = true;
  const torn = new THREE.Mesh(flagGeo, flagMat(true));   // the torn pennant on the floor
  torn.rotation.x = -Math.PI / 2; torn.rotation.z = 0.8; torn.scale.set(1.1, 0.8, 1);
  torn.position.set(px + ix * 1.6, 0.04, pz + iz * 1.4);
  broken.add(stump, top, torn);

  // ---- repaired
  const redMat = T.m(new THREE.MeshBasicMaterial({ color: 0xff5a6a, transparent: true, opacity: 0.72, depthWrite: false }));
  const ring = new THREE.Mesh(T.g(mergeGeos(ringParts.map((g) => g.clone()))), redMat);
  ring.rotation.x = -Math.PI / 2; ring.position.set(cp.x, 0.02, cp.z);
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.set(px, 1.3, pz); pole.castShadow = true;
  const flag = new THREE.Mesh(flagGeo, flagMat(false));
  flag.position.set(px, 2.55, pz); flag.rotation.y = px < cp.x ? 0 : Math.PI; flag.scale.setScalar(1.2);
  fixed.add(ring, pole, flag);

  // a field hospital round it: two medical tents along the back wall (clear of the hallway coming in on the -z side)
  // and two field beds along the near side (low), all clear of the middle where the team gathers.
  // Broken: the tents collapsed (flat grimy canvas, a snapped pole), the beds tipped over, mattresses on the floor.
  const CANVAS = 0xe8e2d4, GRIME = 0x8a837a, RED = 0xd8342e, RED_DIM = 0x6e3a38, IRON = 0x5a5458, SHEET = 0xf2f0ea;
  // a triangular prism along x with its ridge up (a 3-sided cylinder turned on its side, a corner to the top)
  const prism = (r0, r1, len) => place(new THREE.CylinderGeometry(r0, r1, len, 3), 0, 0, 0, 1, 1, 1, -Math.PI / 2, 0, Math.PI / 2);
  const tentGeo = (ok) => {
    const parts = [];
    if (ok) {
      // a ridge tent: a triangular prism (apex up), red crosses on the end facing the camera and on the near slope
      parts.push(paint(place(prism(1.1, 1.1, 2.6), 0, 0.55, 0), CANVAS));
      parts.push(paint(place(new THREE.BoxGeometry(0.5, 0.14, 0.02), 0, 0.64, 0.62, 1, 1, 1, -0.52, 0, 0), RED));
      parts.push(paint(place(new THREE.BoxGeometry(0.14, 0.5, 0.02), 0, 0.64, 0.62, 1, 1, 1, -0.52, 0, 0), RED));
      parts.push(paint(place(new THREE.CylinderGeometry(0.04, 0.04, 1.75, 5), 1.32, 0.87, 0), IRON));
      parts.push(paint(place(new THREE.CylinderGeometry(0.04, 0.04, 1.75, 5), -1.32, 0.87, 0), IRON));
    } else {
      // collapsed: the canvas flat and crumpled, one pole snapped and lying across it
      parts.push(paint(place(place(prism(1.15, 1.25, 2.7), 0, 0, 0, 1, 0.28, 1), 0, 0.12, 0.1, 1, 1, 1, 0, 0.25, 0.08), GRIME));
      parts.push(paint(place(new THREE.BoxGeometry(0.5, 0.02, 0.14), 0.3, 0.3, 0.3, 1, 1, 1, 0, 0.3, 0.05), RED_DIM));
      parts.push(paint(place(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 5), 1.35, 0.4, 0, 1, 1, 1, 0, 0, 0.35), IRON));
      parts.push(paint(place(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 5), -0.2, 0.32, 0.55, 1, 1, 1, 0, 0.6, Math.PI / 2), IRON));
    }
    return T.g(mergeGeos(parts));
  };
  const bedGeo = (ok) => {
    const parts = [];
    if (ok) {
      parts.push(paint(place(new THREE.BoxGeometry(2, 0.08, 0.8), 0, 0.42, 0), IRON));
      for (const [lx, lz] of [[-0.9, -0.34], [0.9, -0.34], [-0.9, 0.34], [0.9, 0.34]]) parts.push(paint(place(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 5), lx, 0.21, lz), IRON));
      parts.push(paint(place(new THREE.BoxGeometry(1.9, 0.12, 0.74), 0, 0.52, 0), SHEET));
      parts.push(paint(place(new THREE.BoxGeometry(0.4, 0.12, 0.55), -0.7, 0.62, 0), 0xffffff));                // the pillow
      parts.push(paint(place(new THREE.BoxGeometry(1.1, 0.04, 0.78), 0.35, 0.6, 0), RED));                     // the blanket
      parts.push(paint(place(new THREE.BoxGeometry(0.3, 0.01, 0.08), 0.35, 0.625, 0), 0xffffff));              // its cross
      parts.push(paint(place(new THREE.BoxGeometry(0.08, 0.01, 0.3), 0.35, 0.625, 0), 0xffffff));
    } else {
      // tipped over on its side, a leg snapped off, the mattress and pillow on the floor
      parts.push(paint(place(new THREE.BoxGeometry(2, 0.08, 0.8), 0, 0.4, -0.2, 1, 1, 1, 1.35, 0, 0.08), IRON));
      for (const [lx, ly] of [[-0.9, 0.7], [0.9, 0.62]]) parts.push(paint(place(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 5), lx, ly, -0.1, 1, 1, 1, Math.PI / 2 - 0.2, 0, 0), IRON));
      parts.push(paint(place(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 5), 1.3, 0.04, 0.6, 1, 1, 1, 0, 0.8, Math.PI / 2), IRON));
      parts.push(paint(place(new THREE.BoxGeometry(1.8, 0.1, 0.72), 0.15, 0.05, 0.55, 1, 1, 1, 0, 0.18, 0), 0x9c968c));
      parts.push(paint(place(new THREE.BoxGeometry(0.4, 0.1, 0.5), -1.1, 0.05, 1.0, 1, 1, 1, 0, -0.5, 0), 0xb4aea4));
    }
    return T.g(mergeGeos(parts));
  };
  const propMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));
  const spots = [   // [x, z, ry, kind] around the square; the tents along its back wall, clear of the hallway's way in
    [cp.x + 5.4, cp.z - 2.6, -Math.PI / 2 + 0.06, 'tent'], [cp.x + 5.5, cp.z + 2.0, -Math.PI / 2 - 0.05, 'tent'],   // (crosses facing into the room)
    [cp.x - 4.2, cp.z + 5.6, 0.1, 'bed'], [cp.x + 3.0, cp.z + 5.8, -0.12, 'bed'],
  ];
  for (const [x, z, ry, kind] of spots) {
    for (const [ok, grp] of [[false, broken], [true, fixed]]) {
      const m = new THREE.Mesh(kind === 'tent' ? tentGeo(ok) : bedGeo(ok), propMat);
      m.position.set(x, 0, z); m.rotation.y = ry; m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
    }
  }

  // the broken ring flickers: mostly dim, now and then a stutter of light
  const update = (time) => {
    if (!broken.visible) return;
    const t = time * 7.3, f = Math.sin(t) * Math.sin(t * 2.71) * Math.sin(t * 0.37);
    dimMat.opacity = f > 0.55 ? 0.6 : f > 0.4 ? 0.12 : 0.3;
  };
  const repair = () => { broken.visible = false; fixed.visible = true; };
  return { group, update, repair };
}

// Run + Skate's level 9: the hallway from the skate half up into the broken checkpoint (levelData.extraFloors[0]). A
// worn red runner up the middle, torches on both walls lighting it, and a couple of medkit crates by the walls (a
// hint of what the checkpoint wants): smashed open, their lids off and bandages spilled, until the checkpoint is
// repaired (out.repair), then whole again with their red crosses glowing.
function buildHallway(levelData, T, rng) {
  const out = [], r = levelData.extraFloors && levelData.extraFloors[0];
  if (!r) return out;
  const cx = (r.x0 + r.x1) / 2, L = r.z1 - r.z0, cz = (r.z0 + r.z1) / 2, ht = CFG.WALL_THICKNESS / 2;
  // the runner
  const rugTex = textTexture(T, 64, 256, (g, W, H) => {
    g.fillStyle = '#5e1418'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c99a3a'; g.fillRect(3, 0, 3, H); g.fillRect(W - 6, 0, 3, H);
    for (let y = 10; y < H; y += 26) { g.fillStyle = '#7e2228'; g.fillRect(14, y, W - 28, 12); }
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(20,8,8,${0.15 + 0.25 * Math.random()})`; g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 8, 2 + Math.random() * 6); }
  });
  const rugGeo = T.g(new THREE.PlaneGeometry(3.6, L + 1)); rugGeo.rotateX(-Math.PI / 2);
  const rug = new THREE.Mesh(rugGeo, T.m(new THREE.MeshStandardMaterial({ map: rugTex, roughness: 0.95 })));
  rug.position.set(cx, 0.012, cz); rug.receiveShadow = true;
  out.push(rug);
  // torches on both walls: an iron bracket, a flame and a warm pool of light on the floor
  const bracketGeo = T.g(new THREE.BoxGeometry(0.16, 0.5, 0.16));
  const ironMat = T.m(new THREE.MeshStandardMaterial({ color: 0x2a2224, roughness: 0.7, metalness: 0.4 }));
  const flameGeo = T.g(new THREE.ConeGeometry(0.17, 0.5, 6));
  const flameMat = T.m(new THREE.MeshBasicMaterial({ color: 0xffa040 }));
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);
  const glowMat = T.m(new THREE.MeshBasicMaterial({ map: makeGlowTexture(T), color: new THREE.Color(0xff7a2a).multiplyScalar(0.45), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  for (const [x, side] of [[r.x0 + ht + 0.1, 1], [r.x1 - ht - 0.1, -1]]) {
    for (const t of [0.3, 0.75]) {
      const z = r.z0 + L * t;
      const b = new THREE.Mesh(bracketGeo, ironMat); b.position.set(x, 1.35, z);
      const fl = new THREE.Mesh(flameGeo, flameMat); fl.position.set(x + side * 0.05, 1.85, z);
      const gl = new THREE.Mesh(glowGeo, glowMat); gl.position.set(x + side * 0.6, 0.03, z); gl.scale.setScalar(4); gl.renderOrder = 1;   // right under the torch
      out.push(b, fl, gl);
    }
  }
  // medkit crates against the walls: whole (after the repair) and smashed (before)
  const crateGeo = T.g(mergeGeos([
    paint(place(new THREE.BoxGeometry(1, 0.6, 0.7), 0, 0.3, 0), 0xe8e4dc),
    paint(place(new THREE.BoxGeometry(0.5, 0.02, 0.14), 0, 0.61, 0), 0xff3a34),
    paint(place(new THREE.BoxGeometry(0.14, 0.02, 0.5), 0, 0.61, 0), 0xff3a34),
    paint(place(new THREE.BoxGeometry(0.62, 0.14, 0.02), 0, 0.32, 0.36), 0xff3a34),
    paint(place(new THREE.BoxGeometry(0.14, 0.42, 0.02), 0, 0.32, 0.36), 0xff3a34),
  ]));
  const brokenGeo = T.g(mergeGeos([
    // the open box, dented and grimy (a lower body, no lid), its front cross faded
    paint(place(new THREE.BoxGeometry(1, 0.42, 0.7), 0, 0.21, 0, 1, 1, 1, 0, 0, 0.06), 0x8e8880),
    paint(place(new THREE.BoxGeometry(0.88, 0.04, 0.58), 0, 0.4, 0), 0x2a2224),                        // the dark inside
    paint(place(new THREE.BoxGeometry(0.62, 0.12, 0.02), 0, 0.22, 0.36), 0x6e3a38),
    paint(place(new THREE.BoxGeometry(0.14, 0.32, 0.02), 0, 0.22, 0.36), 0x6e3a38),
    // the lid, knocked off and lying askew beside it
    paint(place(new THREE.BoxGeometry(1, 0.08, 0.7), 0.95, 0.12, 0.35, 1, 1, 1, 0.5, 0.6, 0.25), 0x8e8880),
    // spilled bandage rolls
    paint(place(new THREE.CylinderGeometry(0.1, 0.1, 0.26, 8), -0.7, 0.1, 0.45, 1, 1, 1, Math.PI / 2, 0.4, 0), 0xcfc8bc),
    paint(place(new THREE.CylinderGeometry(0.09, 0.09, 0.24, 8), -0.45, 0.09, 0.75, 1, 1, 1, Math.PI / 2, -0.7, 0), 0xcfc8bc),
    paint(place(new THREE.BoxGeometry(0.7, 0.01, 0.12), -0.95, 0.01, 0.2, 1, 1, 1, 0, 0.9, 0), 0xbdb5a8),   // an unrolled strip
  ]));
  const crateMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, flatShading: true, emissive: 0x3a0606, emissiveIntensity: 0.6 }));
  const brokenMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  const whole = [], smashed = [];
  for (const [x, z, ry] of [[r.x0 + 1.3, r.z0 + L * 0.18, 0.3], [r.x1 - 1.4, r.z0 + L * 0.55, -0.4], [r.x1 - 1.1, r.z0 + L * 0.62, 0.9]]) {
    const c = new THREE.Mesh(crateGeo, crateMat); c.position.set(x, 0, z); c.rotation.y = ry; c.castShadow = true; c.visible = false;
    const b = new THREE.Mesh(brokenGeo, brokenMat); b.position.set(x, 0, z); b.rotation.y = ry; b.castShadow = true;
    whole.push(c); smashed.push(b);
    out.push(c, b);
  }
  out.repair = () => { for (const c of whole) c.visible = true; for (const b of smashed) b.visible = false; };
  void rng;
  return out;
}

// ---------------------------------------------------------------- the final run (last level)
//
// Set dressing for levelData.finale, a frozen hell (no start / finish markings, nothing that tells how far is left):
// fire braziers outside both walls at a steady rhythm, a faint blood-red shimmer on the ice, and a snow patch under
// the halfway tree (the one place to rest). At the end, the goal room is the sweet reward:
// cushions, yarn balls, bowls of milk and golden sparkles round the giant fish (models.js). Nothing tall stands on
// the near (+z) side: the camera looks down toward -z at ~56° and it would hide the kitties.

function textTexture(T, w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return T.t(t);
}

function buildFinale(levelData, theme, T, rng) {
  if (levelData.finaleSide > 0) {
    // Run only's level 9 runs in from the right: build the left-hand layout and mirror it (x -> -x; three.js flips the
    // face winding of a negatively scaled object by itself)
    const mx = (o) => ({ ...o, x: -o.x });
    const view = { ...levelData, finaleSide: -1, corners: levelData.corners.map(mx), trees: (levelData.trees || []).map(mx) };
    const out = buildFinale(view, theme, T, rng);
    const flip = new THREE.Group();
    flip.scale.x = -1;
    flip.add(...out.meshes);
    return { meshes: [flip], update: out.update };
  }
  const meshes = [];
  const W = levelData.corridorWidth, h = W / 2, rh = levelData.roomHalf, R = CFG.TREE_RADIUS;
  // the corridor starts at the start square's edge (Run only's level 9: its start room, narrower than the corridor)
  const sq = Math.min(h, (levelData.safeSize || W) / 2);
  const xs = levelData.corners[0].x, xStart = xs + sq + 0.4, xEnd = -rh - 1 - (levelData.endTrim || 0);   // endTrim: Run + Skate's skate half stops before the hallway
  const xHi = -rh;                               // the corridor's ice ends at the goal room's door

  // ---- fire braziers outside both walls (staggered); evenly spaced, so they don't tell how far is left
  const brazGeo = T.g(mergeGeos([
    paint(place(new THREE.CylinderGeometry(0.42, 0.5, 0.16, 7), 0, 0.08, 0), 0x2a2224),
    paint(place(new THREE.CylinderGeometry(0.1, 0.16, 0.85, 6), 0, 0.55, 0), 0x2a2224),
    paint(place(new THREE.CylinderGeometry(0.58, 0.3, 0.34, 8), 0, 1.08, 0), 0x3a2e30),
    paint(place(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 8), 0, 1.24, 0), 0x601a0c),   // the coals
  ]));
  const brazMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.3, flatShading: true }));
  const flameGeo = T.g(new THREE.ConeGeometry(0.4, 1, 7)); flameGeo.translate(0, 0.5, 0);
  const flameOut = T.m(new THREE.MeshBasicMaterial({ color: 0xe8461a, transparent: true, opacity: 0.85, depthWrite: false }));
  const flameIn = T.m(new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.9, depthWrite: false }));
  const braz = [], flames = [], brazGlow = [];
  const brazier = (x, z) => {
    const S = z > 0 ? 0.75 : 1;                // near side (toward the camera): keep them low
    braz.push({ x, z, s: S, ry: rng.range(0, TAU) });
    flames.push({ x, z, y: 1.25 * S, s: S, ph: rng.range(0, 10) });
    brazGlow.push({ x, z, y: 0.03, s: 6.5, color: new THREE.Color(0xff4a18).multiplyScalar(0.32) });
  };
  const off = h + CFG.WALL_THICKNESS / 2 + 1.5;
  for (let x = xStart + 10; x < xEnd - 6; x += 24) {
    brazier(x, -off - rng.range(0, 0.6));
    brazier(x + 12, off + rng.range(0, 0.6));
  }
  meshes.push(...makeInstancedChunks(brazGeo, brazMat, braz, { cast: true }, 96));
  // flames: two cones per brazier that flicker (one instanced mesh each, matrices rewritten every frame)
  const outerF = new THREE.InstancedMesh(flameGeo, flameOut, flames.length), innerF = new THREE.InstancedMesh(flameGeo, flameIn, flames.length);
  outerF.frustumCulled = innerF.frustumCulled = false;
  outerF.renderOrder = 2; innerF.renderOrder = 3;
  meshes.push(outerF, innerF);
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);
  const glowTex = makeGlowTexture(T);
  const glowMat = T.m(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  for (const g of makeInstancedChunks(glowGeo, glowMat, brazGlow, {}, 96)) { g.renderOrder = 1; meshes.push(g); }

  // ---- a faint blood-red / violet shimmer drifting over the ice (not under the tree's snow patch)
  const tr = (levelData.trees && levelData.trees[0]) || { x: 1e5, z: 0 };
  const auroraGeo = T.g(new THREE.PlaneGeometry(xHi - xStart, 2 * h - CFG.WALL_THICKNESS, Math.ceil((xHi - xStart) / 8), 1));
  auroraGeo.rotateX(-Math.PI / 2);
  auroraGeo.translate((xStart + xHi) / 2, 0.009, 0);
  const auroraMat = T.m(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTree: { value: new THREE.Vector3(tr.x, tr.z, R + 0.6) }, uK: { value: 0.2 }, uX0: { value: xStart }, uH: { value: h } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vP; uniform float uTime; uniform vec3 uTree; uniform float uK; uniform float uX0; uniform float uH;
      void main(){
        float t = uTime;
        float w = sin(vP.y * 0.32 + vP.x * 0.011 + t * 0.21) * 1.7;
        float b1 = sin(vP.x * 0.043 + t * 0.33 + w);
        float b2 = sin(vP.x * 0.019 - t * 0.19 + vP.y * 0.16 + 1.7);
        float a = smoothstep(0.3, 1.0, b1) * 0.75 + smoothstep(0.55, 1.0, b2) * 0.55;
        vec3 blood = vec3(0.75, 0.08, 0.06), ember = vec3(0.9, 0.3, 0.1), violet = vec3(0.4, 0.12, 0.55);
        float m = 0.5 + 0.5 * sin(vP.x * 0.0071 + t * 0.07);
        vec3 col = mix(mix(blood, ember, m), violet, smoothstep(0.6, 1.0, b2));
        float edge = 1.0 - smoothstep(uH - 1.8, uH - 0.2, abs(vP.y));   // fades out by the walls
        float hole = smoothstep(uTree.z, uTree.z + 1.2, distance(vP, uTree.xy));
        float fadeIn = smoothstep(uX0, uX0 + 6.0, vP.x);   // no hard line where it starts
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * edge * hole * fadeIn * uK);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  }));
  const aurora = new THREE.Mesh(auroraGeo, auroraMat);
  aurora.renderOrder = 0;   // after the ice sheet (-1), before the snow patch / glows (1)
  aurora.frustumCulled = false;
  meshes.push(aurora);

  // ---- the halfway tree: a disc of snow over the ice (the skate final run: here you can stand still), or of warm
  // ash round the smouldering tree (on foot)
  if (levelData.trees && levelData.trees.length) {
    const snowTex = levelData.ice ? textTexture(T, 128, 128, (g, S) => {
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.78, 'rgba(250,252,255,1)'); gr.addColorStop(1, 'rgba(240,246,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(170,195,235,${0.08 + 0.1 * Math.random()})`; g.beginPath(); g.arc(S / 2 + (Math.random() - 0.5) * S * 0.8, S / 2 + (Math.random() - 0.5) * S * 0.8, 1 + Math.random() * 2, 0, TAU); g.fill(); }
    }) : textTexture(T, 128, 128, (g, S) => {
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(70,52,48,1)'); gr.addColorStop(0.62, 'rgba(84,56,46,1)'); gr.addColorStop(0.82, 'rgba(230,96,40,0.9)'); gr.addColorStop(1, 'rgba(200,60,20,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(255,${90 + (Math.random() * 80) | 0},30,${0.25 + 0.4 * Math.random()})`; g.beginPath(); g.arc(S / 2 + (Math.random() - 0.5) * S * 0.75, S / 2 + (Math.random() - 0.5) * S * 0.75, 0.6 + Math.random() * 1.4, 0, TAU); g.fill(); }
    });
    const snowGeo = T.g(new THREE.PlaneGeometry(2 * R + 1.4, 2 * R + 1.4)); snowGeo.rotateX(-Math.PI / 2);
    const snowMat = T.m(levelData.ice
      ? new THREE.MeshStandardMaterial({ map: snowTex, transparent: true, roughness: 0.85, depthWrite: false, emissive: 0x9fb8e0, emissiveIntensity: 0.15 })
      : new THREE.MeshStandardMaterial({ map: snowTex, transparent: true, roughness: 0.95, depthWrite: false, emissive: 0xff5a1e, emissiveIntensity: 0.18, emissiveMap: snowTex }));
    for (const t of levelData.trees) {
      const snow = new THREE.Mesh(snowGeo, snowMat);
      snow.position.set(t.x, 0.011, t.z); snow.renderOrder = 1; snow.receiveShadow = true;
      meshes.push(snow);
    }
  }

  const room = levelData.noReward ? { meshes: [], update() {} } : buildRewardRoom(levelData, T, rng, glowGeo, glowMat);
  meshes.push(...room.meshes);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const update = (time) => {
    auroraMat.uniforms.uTime.value = time;
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i], k = f.ph;
      const fy = 0.85 + 0.2 * Math.sin(time * 9.1 + k * 7) + 0.1 * Math.sin(time * 23.7 + k * 3);
      const fw = 0.92 + 0.08 * Math.sin(time * 13.3 + k * 5);
      q.setFromEuler(e.set(0.08 * Math.sin(time * 5.3 + k), k, 0.08 * Math.sin(time * 4.1 + k * 2)));
      m4.compose(p.set(f.x, f.y, f.z), q, s.set(f.s * fw, f.s * fy * 1.1, f.s * fw));
      outerF.setMatrixAt(i, m4);
      m4.compose(p, q, s.set(f.s * fw * 0.55, f.s * fy * 0.7, f.s * fw * 0.55));
      innerF.setMatrixAt(i, m4);
    }
    outerF.instanceMatrix.needsUpdate = innerF.instanceMatrix.needsUpdate = true;
    room.update(time);
  };
  outerF.userData.live = innerF.userData.live = true;
  update(0);
  return { meshes, update };
}

// The goal room after hell: cosy and warm. Cushions in the corners, yarn balls and bowls of milk along the front
// wall, a soft golden glow on the floor and slow golden sparkles drifting in the air (all clear of the goal disc
// and the giant fish curled round its back; purely cosmetic, nothing here collides).
function buildRewardRoom(levelData, T, rng, glowGeo, glowMat) {
  const meshes = [];
  const rh = levelData.roomHalf;
  const vc = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));

  // cushions: a plump pillow with a tufted button, tinted per instance
  const cushionGeo = T.g(mergeGeos([
    paint(place(new THREE.SphereGeometry(1, 14, 8), 0, 0.26, 0, 1.0, 0.3, 1.0), 0xffffff),
    paint(place(new THREE.IcosahedronGeometry(0.12, 1), 0, 0.53, 0, 1, 0.5, 1), 0xe8e0f0),
    ...[0, 1, 2, 3].map((k) => paint(place(new THREE.IcosahedronGeometry(0.16, 0), Math.cos(k * Math.PI / 2 + Math.PI / 4) * 0.98, 0.24, Math.sin(k * Math.PI / 2 + Math.PI / 4) * 0.98), 0xffe9a8)),
  ]));
  const c = rh - 1.55;
  const cushions = [
    { x: -c + 0.3, z: c - 0.5, color: 0xff9ec7 }, { x: c, z: c - 0.5, color: 0xc4a8ff }, { x: c, z: -c, color: 0xffc49a }, { x: -c, z: -c, color: 0xa8e4c8 },
  ].map((o) => ({ ...o, s: 1.15, ry: rng.range(0, TAU), color: new THREE.Color(o.color) }));
  meshes.push(makeInstanced(cushionGeo, vc, cushions, { cast: true, receive: true }));

  // yarn balls: a ball wound with a few strands
  const yarnGeo = T.g(mergeGeos([
    paint(place(new THREE.IcosahedronGeometry(0.3, 2), 0, 0.3, 0), 0xffffff),
    paint(place(new THREE.TorusGeometry(0.3, 0.028, 4, 18), 0, 0.3, 0, 1, 1, 1, 0.3, 0, 0), 0xd8d8d8),
    paint(place(new THREE.TorusGeometry(0.3, 0.028, 4, 18), 0, 0.3, 0, 1, 1, 1, 1.4, 0.8, 0), 0xd8d8d8),
    paint(place(new THREE.TorusGeometry(0.3, 0.028, 4, 18), 0, 0.3, 0, 1, 1, 1, 2.2, -0.6, 0.4), 0xd8d8d8),
    paint(place(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 4), 0.42, 0.03, 0.18, 1, 1, 1, 0, 0.4, Math.PI / 2), 0xd8d8d8),   // a loose end
  ]));
  // (the front wall hides the last ~1 unit of floor from the camera: nothing goes past z = rh - 1.4)
  const yarn = [[-4.3, rh - 1.6, 0xff5a6a], [-c + 1.5, c - 1.2, 0x5ab4ff], [4.4, rh - 1.7, 0xffd04a], [c - 0.4, c - 2.2, 0xff8ad0], [c + 0.3, 2.4, 0x8ae070]]
    .map(([x, z, col]) => ({ x, z, s: rng.range(0.9, 1.15), ry: rng.range(0, TAU), color: new THREE.Color(col) }));
  meshes.push(makeInstanced(yarnGeo, vc, yarn, { cast: true, receive: true }));

  // bowls of milk
  const bowlGeo = T.g(mergeGeos([
    paint(place(new THREE.CylinderGeometry(0.46, 0.32, 0.24, 16), 0, 0.12, 0), 0x7aa8ff),
    paint(place(new THREE.CylinderGeometry(0.4, 0.4, 0.02, 16), 0, 0.245, 0), 0xfffaf0),
    paint(place(new THREE.TorusGeometry(0.44, 0.035, 4, 20), 0, 0.24, 0, 1, 1, 1, Math.PI / 2, 0, 0), 0xa8c8ff),
  ]));
  const bowls = [[-2.3, rh - 1.75], [0, rh - 1.55], [2.3, rh - 1.75]].map(([x, z]) => ({ x, z, s: 1 }));
  meshes.push(makeInstanced(bowlGeo, vc, bowls, { cast: true, receive: true }));

  // soft golden pools of light: one over the room, one under every cushion
  const glows = [{ x: 0, z: 0, y: 0.02, s: 2 * rh + 6, color: new THREE.Color(0xffb060).multiplyScalar(0.12) }];
  for (const o of cushions) glows.push({ x: o.x, z: o.z, y: 0.025, s: 4.5, color: new THREE.Color(0xffc070).multiplyScalar(0.2) });
  const g = makeInstanced(glowGeo, glowMat, glows);
  g.renderOrder = 1;
  meshes.push(g);

  // golden sparkles drifting in the air
  const N = 34, sp = [];
  for (let i = 0; i < N; i++) {
    let x, z;
    do { x = rng.range(-rh + 0.6, rh - 0.6); z = rng.range(-rh + 0.6, rh - 0.6); } while (Math.hypot(x, z) < 3.5);
    sp.push({ x, z, y: rng.range(0.6, 2.8), ph: rng.range(0, TAU), sp: rng.range(0.4, 0.9) });
  }
  const spGeo = T.g(new THREE.OctahedronGeometry(0.09, 0)); spGeo.scale(1, 1.6, 1);
  const spMat = T.m(new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9, depthWrite: false }));
  const spMesh = new THREE.InstancedMesh(spGeo, spMat, N);
  spMesh.frustumCulled = false;
  spMesh.userData.live = true;
  meshes.push(spMesh);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const update = (time) => {
    for (let i = 0; i < N; i++) {
      const o = sp[i], t = time * o.sp + o.ph;
      const k = Math.max(0, Math.sin(t * 2.3));   // twinkle: grow and shrink
      m4.compose(p.set(o.x + Math.sin(t) * 0.4, o.y + Math.sin(t * 0.7) * 0.35, o.z + Math.cos(t * 0.9) * 0.4), q.setFromEuler(e.set(0, t * 2, 0)), s.setScalar(0.25 + 0.9 * k));
      spMesh.setMatrixAt(i, m4);
    }
    spMesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { meshes, update };
}

// ---------------------------------------------------------------- public API

function buildWorld(scene, levelData, hero) {
  const T = makeTracker();
  const ti = (((levelData.theme ?? ((levelData.level || 1) - 1)) % THEMES.length) + THEMES.length) % THEMES.length;
  const base = THEMES[ti];
  const night = !!levelData.night && !levelData.finale;   // Skate only: a floodlit night level (see NIGHT_LIGHT)
  const theme = levelData.finale ? { ...base, ...HELL } : night ? { ...base, night: true, nightTi: ti } : base;   // the final run: a frozen hell (see HELL)
  const rng = createRng(hashSeed(levelData.seed ?? 1, levelData.level ?? 1, 'world'));
  const group = new THREE.Group();
  group.name = 'world';

  for (const m of buildFloors(levelData, theme, T)) group.add(m);
  const checkpoints = buildCheckpoints(levelData, T);
  for (const m of checkpoints) group.add(m);
  const hallway = buildHallway(levelData, T, rng);
  for (const m of hallway) group.add(m);
  for (const m of buildClimbTrees(levelData, base, T)) group.add(m);
  for (const m of buildLanePiles(levelData)) group.add(m);   // the halfway tree: smouldering in hell (buildClimbTrees), the one refuge
  for (const m of buildWalls(levelData, theme, T)) group.add(m);
  const lanterns = buildLanterns(levelData, theme, T, rng);
  for (const m of lanterns.meshes) group.add(m);
  for (const m of buildDecor(levelData, theme, ti, T, rng)) group.add(m);
  if (night) for (const m of nightDress(group, levelData, ti, T)) group.add(m);
  if (hero && !levelData.finale && levelData.safeCorners.length) group.add(heroNewspaper(levelData, T, hero));
  let finale = null;
  if (levelData.sections) {   // Run + Skate's level 9: each half dressed as on its own, moved into place
    const parts = levelData.sections.map((sec) => {
      const out = buildFinale(sec.ld, theme, T, rng), g = new THREE.Group();
      g.position.set(sec.dx, 0, sec.dz);
      g.add(...out.meshes);
      group.add(g);
      return out;
    });
    finale = { update: (time) => { for (const p of parts) p.update(time); } };
  } else if (levelData.finale) {
    finale = buildFinale(levelData, theme, T, rng);
    for (const m of finale.meshes) group.add(m);
  }
  const parts = buildParticles(theme, rng, levelData.outerRadius + 14, T, levelData.finale ? { w: 96, d: 80 } : null);
  if (parts.points) group.add(parts.points);
  chunkInstances(group, 24);

  scene.add(group);

  let disposed = false;
  return {
    group,
    theme: ti,
    update(dt, time) {
      lanterns.update(time);
      if (finale) finale.update(time);
      parts.update(time);
      for (const m of checkpoints.medic) m.update(time);
    },
    // Run + Skate's level 9: the broken (medic) checkpoint with this index was repaired
    repairCheckpoint(index) {
      const k = (levelData.checkpoints || []).slice(0, index + 1).filter((cp) => cp.medic).length - 1;
      if (k >= 0 && checkpoints.medic[k]) checkpoints.medic[k].repair();
      if (hallway.repair) hallway.repair();   // its medkit crates are whole again
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (group.parent) group.parent.remove(group);
      group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });   // their instance buffers
      T.dispose();
    },
  };
}

function setupLighting(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  const EXT = 30, MAP = QUALITY.shadowMap, DIST = 60;
  sun.castShadow = QUALITY.shadows;
  sun.shadow.mapSize.set(MAP, MAP);
  const sc = sun.shadow.camera;
  sc.left = -EXT; sc.right = EXT; sc.top = EXT; sc.bottom = -EXT;
  sc.near = 1; sc.far = DIST + 60;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  // PCFSoft (desktop) ignores radius; plain PCF (phones) uses it as the 3x3 tap spread in texels
  sun.shadow.radius = QUALITY.softShadows ? 1 : 1.5;
  scene.add(sun);
  scene.add(sun.target);

  // light comes from behind-left (screen up/left); shadows fall toward the viewer/right
  const dir = new THREE.Vector3(-0.45, 1, -0.38).normalize();
  // shadow camera basis (lookAt with up = +Y): z = dir, x = up × z, y = z × x
  const ax = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const ay = new THREE.Vector3().crossVectors(dir, ax).normalize();
  const texel = (EXT * 2) / MAP;
  const F = new THREE.Vector3(), out = new THREE.Vector3();

  const bg = new THREE.Color();
  const fog = new THREE.Fog(0xffffff, 40, 120);
  scene.fog = fog;
  scene.background = bg;

  const apply = (t) => {
    bg.set(t.sky);
    fog.color.set(t.fog); fog.near = t.fogNear; fog.far = t.fogFar;
    hemi.color.set(t.hemiSky); hemi.groundColor.set(t.hemiGround); hemi.intensity = t.hemiIntensity;
    sun.color.set(t.sunColor); sun.intensity = t.sunIntensity;
  };
  // the final run: hell lighting down the run, warming up to the goal room's golden light as the camera gets there
  let blend = null, blendK = -1;
  const ca = new THREE.Color(), cb = new THREE.Color();
  const mixLight = (k) => {
    const A = HELL_LIGHT, B = HEAVEN_LIGHT, L = (a, b) => a + (b - a) * k;
    bg.copy(ca.set(A.sky)).lerp(cb.set(B.sky), k);
    fog.color.copy(ca.set(A.fog)).lerp(cb.set(B.fog), k); fog.near = L(A.fogNear, B.fogNear); fog.far = L(A.fogFar, B.fogFar);
    hemi.color.copy(ca.set(A.hemiSky)).lerp(cb.set(B.hemiSky), k);
    hemi.groundColor.copy(ca.set(A.hemiGround)).lerp(cb.set(B.hemiGround), k);
    hemi.intensity = L(A.hemiIntensity, B.hemiIntensity);
    sun.color.copy(ca.set(A.sunColor)).lerp(cb.set(B.sunColor), k); sun.intensity = L(A.sunIntensity, B.sunIntensity);
  };

  // levelData (optional): the final run's lighting follows the camera (see update)
  function setTheme(theme, levelData = null) {
    scene.fog = fog; scene.background = bg;
    // Run only's level 9 and Run + Skate's (its run half) come in from the right
    const D = levelData && (levelData.finaleSide > 0 || levelData.combo) ? -1 : 1;
    blend = levelData && levelData.finale ? { x0: D * (-levelData.roomHalf - 34), x1: D * (-levelData.roomHalf + 2), zMin: levelData.combo ? levelData.iceZMax : -Infinity } : null;
    blendK = -1;
    if (blend) { mixLight(0); return; }
    const t = THEMES[(((theme | 0) % THEMES.length) + THEMES.length) % THEMES.length];
    apply(levelData && levelData.night ? { ...t, ...NIGHT_LIGHT } : t);
  }
  setTheme(0);

  function update(dt, time, focusX = 0, focusZ = 0) {
    if (blend) {
      const u = focusZ < blend.zMin ? 0 : clamp((focusX - blend.x0) / (blend.x1 - blend.x0), 0, 1), k = u * u * (3 - 2 * u);
      if (Math.abs(k - blendK) > 0.002) { blendK = k; mixLight(k); }
    }
    F.set(focusX, 0, focusZ);
    const fx = Math.round(F.dot(ax) / texel) * texel;
    const fy = Math.round(F.dot(ay) / texel) * texel;
    const fz = F.dot(dir);
    out.copy(ax).multiplyScalar(fx).addScaledVector(ay, fy).addScaledVector(dir, fz);
    sun.target.position.copy(out);
    sun.position.copy(out).addScaledVector(dir, DIST);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }
  update(0, 0, 0, 0);

  return { update, setTheme, hemi, sun };
}

export { THEMES, buildWorld, setupLighting };
