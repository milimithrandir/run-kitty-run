import { CFG, levelParams, SKATE_FINAL_LEVEL, FINAL_MODES, SAME_SEASON_FV, RUN_RAMP_FV, ANYONE_MEDIC_FV, MEDIC_GIFT_FV, QUICK_START_FV, HEART_FV, HALF_HEART_FV, STRETCH_REST_FV, RUN_REST_FV, EVEN_WALKS_FV, ITEMS_INSIDE_FV, WALL_BAND_FV, SEASONS_FV, stageOf } from './config.js';
import { createRng, hashSeed, ipow, hyp, legPoint } from './rng.js';   // (hyp: Math.hypot the same in every browser)
import { buildPlan, patternPose, patternSpeed } from './enemies.js';

// Square-spiral level generation + collision. Pure (no THREE, no DOM).
//
// The map is one continuous wall that spirals outward from a square goal room in the middle,
// plus a short cap that closes the outer end. Between consecutive loops of the wall runs a single
// corridor (CFG.RING_WIDTH wide) from the start pocket in the outer corner all the way to the room:
// straight legs joined by 90-degree corners. No choices, no dead ends.
// The wall layout is identical on every level; only wolves/items vary by level + seed.
//
// LevelData:
//   walls / wallSegments: [{ax,az,bx,bz}] wall centerlines (thickness CFG.WALL_THICKNESS)
//   wallCorners: [{x,z}] outer corners of the spiral (for lanterns)
//   legs: corridor legs, each a straight frame { ox,oz (start corner center), ux,uz (along),
//         nx,nz (toward the inner side), len, loop } — wolves live in leg-local coordinates
//   corners: [{x,z}] corridor corner centers along the path
//   centerRadius: radius of the glowing goal disc; roomHalf: half-size of the square goal room
//   outerRadius: half-extent of the whole map (max |x|,|z| of any wall)

const HALF_T = CFG.WALL_THICKNESS / 2;
const WOLF_MARGIN = HALF_T + CFG.WOLF_RADIUS + 0.06;
const CORNER_REST = 0.6;          // extra wolf-free distance past each corner square
const GRID_CELL = 2.0;
const GRID_MAX_R = 1.0;           // grid query valid for radii up to this; larger -> brute force

// Arm directions in order: left, up (-z, away from camera), right, down (+z, toward camera).
const DIRS = [[-1, 0], [0, -1], [1, 0], [0, 1]];
const ARMS = 19;                  // spiral wall arms; path ~845 units with 10.8-wide lanes
const ROOM = 8;                   // goal room half-size
const ICE_THEME = 2;              // Snowy Peaks
const TREE_THEME = 1;             // Autumn Grove: one climbable tree per lane
const ICE_RAMP = 0.3;              // ice levels: how much of the usual toward-the-goal difficulty ramp applies
const SPRING_THEME = 4;
// Seasons: summer meadow, autumn (climbable trees; version 25+: leaf piles), winter (the ice rink; version 25+: snow piles on
// foot), spring blossom (version 25+: the climbable trees), repeat.
// (Theme 3, the neon night garden, is out of the rotation.)
const THEME_ORDER = [0, TREE_THEME, ICE_THEME, SPRING_THEME];   // Run only: meadow, autumn, snow, spring
const SKATE_THEME_ORDER = [ICE_THEME, SPRING_THEME, 0, TREE_THEME];   // Skate only (finale version 12+): winter, spring, summer, autumn
const MIXED_THEME_ORDER = [0, TREE_THEME, ICE_THEME];             // Run + Skate: summer, fall, winter (ice); level 9's winter is the boss run

// The 8 rotations/reflections of the plane; the spiral is mapped by the one that puts the start
// in the top-left corner with the run going clockwise on screen (first step: to the right).
const SYMS = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0], [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]];

function pickWeighted(rng, items, weightFn) {
  let total = 0;
  for (const it of items) total += Math.max(0, weightFn(it));
  if (total <= 0) return items[Math.floor(rng.next() * items.length)];
  let t = rng.next() * total;
  for (const it of items) {
    t -= Math.max(0, weightFn(it));
    if (t <= 0) return it;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------- geometry

// Outward square spiral. Horizontal arms grow (2R-W, 2R, 2R+W...), vertical arms (2R, 2R+W, ...),
// so parallel arms are exactly W apart and the first loop encloses a 2R x 2R room.
function buildSpiral() {
  const W = CFG.RING_WIDTH;
  const v = [{ x: ROOM - W, z: ROOM }];             // first loop encloses the room [-ROOM, ROOM]^2
  for (let i = 0; i < ARMS; i++) {
    const L = (i % 2 === 0 ? 2 * ROOM - W : 2 * ROOM) + Math.floor(i / 2) * W;
    const [dx, dz] = DIRS[i % 4];
    v.push({ x: v[i].x + dx * L, z: v[i].z + dz * L });
  }
  const walls = [];
  for (let i = 0; i < ARMS; i++) walls.push({ ax: v[i].x, az: v[i].z, bx: v[i + 1].x, bz: v[i + 1].z });
  // cap: close the outer end of the corridor (back wall of the start pocket)
  const [d1x, d1z] = DIRS[ARMS % 4], [d2x, d2z] = DIRS[(ARMS + 1) % 4];
  const e = v[ARMS];
  const k = { x: e.x + d1x * W, z: e.z + d1z * W };
  walls.push({ ax: e.x, az: e.z, bx: k.x, bz: k.z });
  walls.push({ ax: k.x, az: k.z, bx: k.x + d2x * W, bz: k.z + d2z * W });

  // corridor corner centers: c_i = v_i + W/2 (d_i + d_{i+1})
  const c = (i) => {
    const [ax, az] = DIRS[i % 4], [bx, bz] = DIRS[(i + 1) % 4];
    return { x: v[i].x + (W / 2) * (ax + bx), z: v[i].z + (W / 2) * (az + bz) };
  };
  // legs from the outside in: leg along arm i runs between c_i and c_{i+1}
  const legs = [];
  for (let i = ARMS - 1; i >= 4; i--) {
    const a = c(i), b = c(i + 1);
    const [ux, uz] = DIRS[i % 4], [nx, nz] = DIRS[(i + 1) % 4];
    legs.push({ arm: i, ox: a.x, oz: a.z, ux, uz, nx, nz, len: hyp(b.x - a.x, b.z - a.z), loop: Math.floor((i - 4) / 4) });
  }
  const corners = [];
  for (let i = ARMS; i >= 4; i--) corners.push(c(i));

  // orient: start top-left (x<0, z<0), first step heading +x
  const start = corners[0], fdx = -legs[0].ux, fdz = -legs[0].uz;
  const [a, b, cc, d] = SYMS.find(([a, b, c, d]) =>
    a * start.x + b * start.z < 0 && c * start.x + d * start.z < 0 && a * fdx + b * fdz === 1 && c * fdx + d * fdz === 0);
  const tx = (x, z) => a * x + b * z, tz = (x, z) => cc * x + d * z;
  const tp = (p) => ({ x: tx(p.x, p.z), z: tz(p.x, p.z) });
  for (const w of walls) {
    const A = tp({ x: w.ax, z: w.az }), B = tp({ x: w.bx, z: w.bz });
    w.ax = A.x; w.az = A.z; w.bx = B.x; w.bz = B.z;
  }
  for (const l of legs) {
    [l.ox, l.oz, l.ux, l.uz, l.nx, l.nz] = [tx(l.ox, l.oz), tz(l.ox, l.oz), tx(l.ux, l.uz), tz(l.ux, l.uz), tx(l.nx, l.nz), tz(l.nx, l.nz)];
  }
  for (let k = 0; k < corners.length; k++) corners[k] = tp(corners[k]);
  for (let k = 0; k < v.length; k++) v[k] = tp(v[k]);
  let ext = 0;
  for (const w of walls) ext = Math.max(ext, Math.abs(w.ax), Math.abs(w.az), Math.abs(w.bx), Math.abs(w.bz));
  return { walls, legs, corners, wallCorners: v.slice(4), outer: ext };
}

function buildStraightPath(corners) {
  const pts = [];
  const d = corners[0].x < 0 ? 1 : -1;   // toward the goal room: +x from a start on the left, -x from one on the right
  const end = corners[corners.length - 1].x;
  for (let x = corners[0].x; d * x < d * end; x += 2 * d) pts.push({ x, z: 0 });
  pts.push({ x: end, z: 0 });
  for (let x = end + 2 * d; d * x < 0; x += 2 * d) pts.push({ x, z: 0 });
  pts.push({ x: 0, z: 0 });
  return pts;
}

function buildPath(corners, legs) {
  const W = CFG.RING_WIDTH;
  const pts = [];
  const STEP = 2.0;
  const pushTo = (x, z) => {
    const l = pts[pts.length - 1];
    if (!l) { pts.push({ x, z }); return; }
    const L = hyp(x - l.x, z - l.z);
    if (L < 1e-6) return;
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 1; k <= n; k++) pts.push({ x: l.x + (x - l.x) * k / n, z: l.z + (z - l.z) * k / n });
  };
  for (const c of corners) pushTo(c.x, c.z);
  // last corner sits just outside the room opening: step in, then to the middle
  const last = corners[corners.length - 1];
  const { nx, nz } = legs[legs.length - 1];       // innermost leg: its inner side is the room
  pushTo(last.x + nx * W, last.z + nz * W);
  pushTo(0, 0);
  return pts;
}

// ---------------------------------------------------------------- the final run (Skate only, last level)
//
// One long straight corridor from the start pocket (far left) to the goal room (right; the room keeps its
// usual place around the origin, so everything that knows where the goal is still does). The path is exactly as
// long as the spiral's. There are no safe squares besides the start pocket: the corridor is cut into invisible
// "rooms" (collinear legs, each solved by the pattern-wolf generator like a spiral leg) that run right into each
// other (FINALE_GAP: no wolf-free ice between them). Halfway along, a gap just the size of its canopy holds a
// climbable tree: under its canopy is snow, not ice
// (onIce), and wolves can't reach you (inTree), the only real breather of the run.
// Its rooms get their wolves exactly like Skate only's spiral legs (legDesign / placeLeg, see the pattern-wolf
// section): charger lanes, tight rows that open up through drifting wolves, no pauses and no launch-window solver,
// at the final level's difficulty and wolf count.

// Legs follow the spiral's conventions: leg i runs from corner i (s = len, where the kitty enters) to corner
// i + 1 (s = 0); u points back toward the start (run direction is -u). leg.padHi / leg.padLo = wolf-free
// half-gap at the entry / exit end (usableRanges).

const FINALE_GAP = 0;            // wolf-free ice between two rooms: none, the wolves of one room run right up to the next
const FINALE_TREE_GAP = 2 * (CFG.TREE_RADIUS + 0.4);   // ...around the halfway tree: just its canopy (no wolf runs through it)
const FINALE_START_GAP = CFG.RING_WIDTH + 2 * CORNER_REST;   // ...at the start square: its tiles + the usual edge, like any safe square
const FINALE_ROOM = [34, 52];    // room lengths
const FINALE_WOLVES = 385;       // the run's wolf count (the spiral's level-7+ count would be 412)
// Run only's level 9: three lanes wide, and as risky everywhere as the innermost lanes of Run only's level 8 (a kitty
// standing still is touched ~17% of the time). Same density per area wasn't enough: in a corridor this wide 60% of wolf
// moves ending at a wall crowded the walls and left the middle at ~11%; RUN_FINALE_WALL = the share that keeps it flat
// wall to wall. Measured with docs/WOLF_WALL_TUNING.md's method across 17 points and along the corridor.
const RUN_FINALE_W = 3 * CFG.RING_WIDTH, RUN_FINALE_WOLVES = 2100, RUN_FINALE_WALL = 0.45;
// version 24+: those wall moves end anywhere up to RUN_FINALE_BAND from the wall (right against it, 0.05, the wall
// strip was ~23% against ~16% everywhere else; 0.7 measured flat, 0.5 ~19%, 1.0 ~10%)
const RUN_FINALE_BAND = 0.7;
const RUN_FINALE_START = 0.6;   // wolves in the first section (outside the start room) relative to the rest
// skate levels' last two lanes (version 4+): designs to pick from, and the risk to aim at on level L (the lane before the
// final stretch, or the final stretch: its chargers alone make it riskier), a fixed climb so each is a bit harder than
// the same lane the level before
const LAST_LANE_TRIES = 12;
const SPEED_KNEE = 0.6, SPEED_SLOPE = 0.45;
const KIND_TOP = 1.2;   // version 7+: no wolf faster than this x its colour's base (median) speed in its lane   // skate wolves' speed past mid difficulty (version 7+, see speedD)
const LAST_LANE_RISK = (L, door) => { const k = Math.min(8, Math.max(1, L)) - 1; return door ? 0.12 + 0.0075 * k : 0.105 + 0.0065 * k; };
// Finale version 2 (generateLevel's fv): the skate final run as wide as Run only's level 9, with the same start room.
// Its rooms get normal-width pattern layouts side by side (one per lane, each as hard as the narrow final run), the
// crossers and diagonals stretched wall to wall, at least one crosser in every wolf-width slot along it.
// its last WIDE_RUN_S seconds of skating (at full speed) have Run only's wolves instead; the level is WIDE_RUN_EXTRA longer
// than usual for them (the stretch used to be 6 s, taken out of the usual length)
const WIDE_RUN_S = 18, WIDE_RUN_EXTRA = (WIDE_RUN_S - 6) * CFG.KITTY_SPEED;
// Run only's level 9 (finale version 1+, see generateLevel; offline always, online only when every kitty in the room
// has protocol 5+, older clients build the endless spiral's level 9): the final run's corridor the other way
// round, start on the right and the goal room at its left end, on solid ground with the running levels' wandering
// wolves. Later it becomes the first half of Run + Skate's level 9 (this run, then the skate run). Its corridor is three
// lanes wide (wider than the goal room, whose whole door side opens onto it) and it has RUN_FINALE_WOLVES wolves.

let spiralPathLen = 0;
function spiralLength() {
  if (!spiralPathLen) {
    const { legs, corners } = buildSpiral();
    const pts = buildPath(corners, legs);
    for (let k = 1; k < pts.length; k++) spiralPathLen += hyp(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
  }
  return spiralPathLen;
}

// side: -1 = the corridor runs in from the left (the skate final run), 1 = from the right (Run only's level 9): the
// same corridor mirrored (x -> -x), so the run direction along it is +x / -x.
// sH: the start square's half-size when the corridor is wider than it (Run only's level 9): the start is then a room
// like the goal room, centred across the corridor with its open side toward it (short walls close off the rest)
// extra: units added to the usual length (the wide skate test: its run-wolf stretch at the end is longer than it took away)
function buildStraight(rng, side = -1, W = CFG.RING_WIDTH, sH = 0, extra = 0) {
  const h = W / 2;
  const total = Math.round(spiralLength() + extra);
  const xs = -total;                 // start square center: the path start -> goal center is `total` long
  const xd = -ROOM - h;              // the last corner: the ice square in front of the goal room's door
  const xTree = Math.round(xs + total / 2);
  // room boundaries: two runs of rooms, start -> tree and tree -> door, each split into near-equal random rooms
  const split = (a, b) => {
    const n = Math.max(1, Math.round((b - a) / ((FINALE_ROOM[0] + FINALE_ROOM[1]) / 2)));
    const w = [];
    for (let i = 0; i < n; i++) w.push(rng.range(FINALE_ROOM[0], FINALE_ROOM[1]));
    const sum = w.reduce((x, y) => x + y, 0);
    const out = [];
    let x = a;
    for (let i = 0; i < n - 1; i++) { x += (b - a) * w[i] / sum; out.push(Math.round(x * 10) / 10); }
    return out;
  };
  const xsCorners = [xs, ...split(xs, xTree), xTree, ...split(xTree, xd), xd];
  const corners = xsCorners.map((x) => ({ x, z: 0 }));
  const startGap = sH > 0 && sH < h ? 2 * sH + 2 * CORNER_REST : FINALE_START_GAP;   // a start room: its width
  const gapAt = (i) => (i === 0 ? startGap : corners[i].x === xTree ? FINALE_TREE_GAP : FINALE_GAP);
  const legs = [];
  for (let i = 0; i < corners.length - 1; i++) {
    legs.push({
      arm: i, ox: corners[i + 1].x, oz: 0, ux: -1, uz: 0, nx: 0, nz: 1, len: corners[i + 1].x - corners[i].x, loop: 0,
      padHi: gapAt(i) / 2, padLo: gapAt(i + 1) / 2,
    });
  }
  const x0 = xs - h;
  const room = sH > 0 && sH < h;
  const xb = room ? xs - sH : x0, xr = room ? xs + sH : x0;   // the start's back wall / where the corridor walls begin
  const zb = room ? sH : h;
  const walls = [
    { ax: xr, az: -h, bx: -ROOM, bz: -h },          // far wall of the corridor
    { ax: -ROOM, az: h, bx: xr, bz: h },            // near wall
    { ax: xb, az: zb, bx: xb, bz: -zb },            // back wall of the start pocket
    { ax: -ROOM, az: -h, bx: -ROOM, bz: -ROOM },    // goal room
    { ax: -ROOM, az: -ROOM, bx: ROOM, bz: -ROOM },
    { ax: ROOM, az: -ROOM, bx: ROOM, bz: ROOM },
    { ax: ROOM, az: ROOM, bx: -ROOM, bz: ROOM },
    { ax: -ROOM, az: ROOM, bx: -ROOM, bz: h },
  ];
  if (room) walls.push(
    { ax: xr, az: -sH, bx: xr, bz: -h }, { ax: xr, az: h, bx: xr, bz: sH },   // the corridor's end beside the start room
    { ax: xb, az: -sH, bx: xr, bz: -sH }, { ax: xr, az: sH, bx: xb, bz: sH },  // the start room's sides
  );
  if (side > 0) {   // mirror: start on the right, run toward -x
    for (const w of walls) { w.ax = -w.ax; w.bx = -w.bx; }
    for (const c of corners) c.x = -c.x;
    for (const l of legs) { l.ox = -l.ox; l.ux = -l.ux; }
  }
  return { walls, legs, corners, wallCorners: [], outer: -x0, tree: { x: side > 0 ? -xTree : xTree, z: 0 }, length: total, side };
}

// ---------------------------------------------------------------- placement

// Run only: how long a tuned wolf stands still before each move (s) and how far it walks, levels 1-8 (9+ = 8).
// The rest of each lane's wolves keep the original behaviour for their level: 1/3 on level 1 up to 3/4 on level 8.
// [min, max, skew]: pause = min + (max - min) * u^skew. Level 1 always 6 s; by level 8 the average is back near the old
// balance (~0.8 s) but a wolf can still stand still for up to 6 s now and then.
// finale version 8+: running levels' first six lanes (the long ones) had too few wolves for their length: wolves in each
// (guards included) on level 1 (as before) and level 8, evenly in between; the other lanes as before
const RUN_LANES_L1 = [17, 19, 19, 21, 20, 22], RUN_LANES_L8 = [37, 38, 34, 35, 31, 32];
// finale version 9+: the other lanes (7-15) keep their level 8 count (as in version 8) and have RUN_TAIL_GROWTH fewer
// every level before it, so they rise steadily too (they used to stay flat for a level or two)
const RUN_TAIL_L8 = [23, 25, 22, 24, 19, 21, 16, 16, 14], RUN_TAIL_GROWTH = 1.05;
const RUN_PAUSES = [[6, 6, 1], [3, 6, 0.67], [2, 6, 1.35], [1.2, 6, 2], [0.7, 6, 3.1], [0.4, 6, 4.1], [0.2, 6, 5.4], [0.1, 6, 7.4]];
// walk length per move, same form: level 1 ~2x the old walks; by level 8 back near the old average, with long walks still possible
const ROOM_WOLVES = 3;   // running levels: the goal room's own wolves (+1 from level 5)
// finale version 21+: the final runs' new-behaviour run wolves (those with a pauseRange) rest at least this long: a stop
// you can see, not a hitch (the longest rests and how they're spread stay)
// (the skate final runs' run stretch: 0.5; the running final runs: 0.3 in version 21, 0.42 from version 22)
const STRETCH_REST_MIN = 0.5, runFinaleRestMin = (v) => (v >= RUN_REST_FV ? 0.42 : 0.3);
const restAtLeast = (pr, min = STRETCH_REST_MIN) => [Math.max(min, pr[0]), pr[1], pr[2]];
const RUN_NEW_EXTRA = 1.5; // Run only: extra tuned wolves = (this - 1) x a level's usual tuned count, levels mirrored (placeEnemies)
const RUN_WALKS = [[5, 17.5, 1], [4.6, 18.2, 1.35], [4.3, 18.9, 1.7], [3.9, 19.6, 2], [3.6, 20.4, 2.4], [3.2, 21.1, 2.7], [2.9, 21.8, 3.1], [2.5, 22.5, 3.4]];
// finale version 23+, levels 1-8: the same ranges, each skewed just enough that a walk averages level 1's (11.25: min +
// (max - min) / (skew + 1)), so the walks don't shrink to short hops; the levels get harder by their rests. Run only's
// level 9 (hell too) and Run + Skate's running levels and final's running half have them too (level 9s: level 8's); the
// skate final runs' run stretch keeps RUN_WALKS' level 8.
const RUN_WALKS_EVEN = [[5, 17.5, 1], [4.6, 18.2, 1.045], [4.3, 18.9, 1.101], [3.9, 19.6, 1.136], [3.6, 20.4, 1.196], [3.2, 21.1, 1.224], [2.9, 21.8, 1.263], [2.5, 22.5, 1.286]];

function placeEnemies(rng, lvl, p) {
  const { legs, seed, level } = lvl;
  // level 9+ uses level 8's tuning (for two wolves in three, see `tuned` below)
  // Run only and Run + Skate's running levels (not its ice levels)
  const runTuned = (lvl.mode === 'run' || lvl.mode === 'mixed') && !lvl.ice;
  const pauseRange = runTuned ? RUN_PAUSES[Math.min(level, RUN_PAUSES.length) - 1] : null;
  // Run only: walk length per move [min, max, skew]: d = min + (max - min) * u^skew. Level 1 walks ~2x the old
  // length (evenly spread); higher levels can walk a little further but mostly take short hops (stop and turn more
  // often, so they're harder to predict). Territories grow with the max walk.
  const walk = runTuned ? ((lvl.rules ?? lvl.fv) >= EVEN_WALKS_FV ? RUN_WALKS_EVEN : RUN_WALKS)[Math.min(level, RUN_WALKS.length) - 1] : null;   // (Run only's level 9 / hell: level 8's)
  const moveScale = walk ? walk[1] / 7 : 1;
  // share of a wolf's moves that end against a wall (enemies.js WALL_SHARE): 0.4 on level 1 up to 0.6 on level 8, where
  // the wall and the middle of a lane come out about as dangerous (docs/WOLF_WALL_TUNING.md)
  const wallShare = lvl.finale ? RUN_FINALE_WALL : 0.4 + 0.2 * (Math.min(level, RUN_PAUSES.length) - 1) / (RUN_PAUSES.length - 1);
  const wallBand = lvl.finale && (lvl.rules ?? lvl.fv) >= WALL_BAND_FV ? RUN_FINALE_BAND : undefined;
  // share of original-behaviour wolves per lane: 1/3 on level 1 rising evenly to 3/4 on level 8 (and after) of the
  // usual count; Run only then adds extra tuned wolves on top (the original ones stay as many)
  const oldShare0 = 1 / 3 + (3 / 4 - 1 / 3) * (Math.min(level, RUN_PAUSES.length) - 1) / (RUN_PAUSES.length - 1);
  const W = lvl.corridorWidth;   // Run only's level 9 is wider
  const enemies = [];
  // the extra tuned wolves are the mirror image across levels 1-8: level 1 gets level 8's top-up (the smallest),
  // level 8 gets level 1's (the biggest)
  const lv = Math.min(level, RUN_PAUSES.length), mirror = RUN_PAUSES.length + 1 - lv;
  const oldShareMirror = 1 / 3 + (3 / 4 - 1 / 3) * (mirror - 1) / (RUN_PAUSES.length - 1);
  // Run only's level 9 (the final run on foot): RUN_FINALE_WOLVES
  const count = lvl.finale ? RUN_FINALE_WOLVES : pauseRange ? Math.round(p.enemyCount * (1 + (1 - oldShareMirror) * (RUN_NEW_EXTRA - 1))) : p.enemyCount;
  const oldShare = pauseRange ? p.enemyCount * oldShare0 / count : oldShare0;
  const vIn = -W / 2 + WOLF_MARGIN, vOut = W / 2 - WOLF_MARGIN;
  // usable s-range per leg: skip both corner squares and the start pocket. Wolves walk right up to where a safe
  // square's tiles end (tiles are W - WALL_THICKNESS wide); a kitty standing fully on the tiles is still out of reach.
  const last = legs.length - 1, tileEdge = ((lvl.safeSize || W) - CFG.WALL_THICKNESS) / 2;
  // Run only: which of each leg's corners (s = 0, s = len) is a safe square; unsafe corners are open ground
  const isSafe = (x, z) => lvl.safeCorners.some((q) => Math.abs(q.x - x) < 1e-6 && Math.abs(q.z - z) < 1e-6);
  const endSafe = legs.map((l) => [isSafe(l.ox, l.oz), isSafe(l.ox + l.ux * l.len, l.oz + l.uz * l.len)]);
  const ranges = legs.map((leg, li) => {
    let lo = tileEdge + CFG.WOLF_RADIUS;
    let hi = leg.len - tileEdge - CFG.WOLF_RADIUS;
    if (pauseRange) {   // Run only: an unsafe corner isn't a wall: roam right into it
      if (!endSafe[li][0]) lo = -W / 2 + WOLF_MARGIN;
      if (!endSafe[li][1]) hi = leg.len + W / 2 - WOLF_MARGIN;
    }
    // final stretch: neither of its corners is safe (wolves roam from its first corner to the goal room's door)
    if (li === last) { lo = -W / 2 + WOLF_MARGIN; hi = leg.len + W / 2 - WOLF_MARGIN; }
    // start leg: c_M is the start. Running levels treat it like any safe square (wolves walk up to its tile edge);
    // the rest keep an extra wolf-free stretch next to it (START_SAFE_ARC)
    if (li === 0 && !pauseRange) hi = leg.len - W / 2 - CFG.START_SAFE_ARC - CFG.WOLF_RADIUS;
    // the final run on foot: its rooms meet with no gap; each room's wolves reach just 6 into the next (half the corridor
    // width covered every boundary twice and left each room's middle the easiest; none left the boundaries easiest);
    // the last still reaches the door
    if (lvl.finale) { if (li !== 0) hi = Math.min(hi, leg.len + 6); if (li !== last) lo = Math.max(lo, -6); }
    return { lo, hi: Math.max(lo, hi) };
  });
  // 0 at the start leg -> 1 at the innermost leg: wolves get denser, faster and restless toward the middle
  // (ice levels ramp much more gently: skating is hard enough)
  const ramp = lvl.ice ? ICE_RAMP : 1;
  // (Run only's level 9: like the innermost lane of level 8 all the way, no ramp)
  const depth = (li) => (lvl.finale ? 1 : ramp * li / Math.max(1, legs.length - 1));
  // Run only: the guard wolves (see below) count toward their lane's share, and shares follow the lane's own length
  // (not its roaming range, which reaches into open corners): short lanes by open corners - the last two - would
  // otherwise end up far denser than the steady rise toward the middle
  const guardsAt = (li) => (pauseRange && li !== last && !lvl.finale ? endSafe[li].filter(Boolean).length : 0);
  const nGuards = legs.reduce((a, _, li) => a + guardsAt(li), 0);
  // Run only's level 9: the section right outside the start room a little thinner (wolves bunch against its edge)
  const lens = ranges.map((r, li) => (pauseRange ? legs[li].len : Math.max(0, r.hi - r.lo)) * (0.55 + 1.1 * depth(li)) * (li === last ? 0.95 : 1) * (lvl.finale && li === 0 ? RUN_FINALE_START : 1));
  const total = lens.reduce((a, b) => a + b, 0), shared = count + nGuards;
  const quota = lens.map((L) => Math.floor(L / total * shared));
  const fracs = lens.map((L, i) => ({ i, f: L / total * shared - quota[i] })).sort((a, b) => b.f - a.f);
  let left = shared - quota.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k++, left--) quota[fracs[k % fracs.length].i]++;
  if (pauseRange) legs.forEach((_, li) => { quota[li] = Math.max(0, quota[li] - guardsAt(li)); });
  if (pauseRange && !lvl.finale && lvl.fv >= 8) RUN_LANES_L8.forEach((top, li) => {
    const want = Math.round(RUN_LANES_L1[li] + (top - RUN_LANES_L1[li]) * (lv - 1) / (RUN_PAUSES.length - 1));
    quota[li] = Math.max(quota[li], want - guardsAt(li));
  });
  if (pauseRange && !lvl.finale && lvl.fv >= 9) RUN_TAIL_L8.forEach((top, k) => {
    const li = RUN_LANES_L8.length + k;
    const room = li === last ? ROOM_WOLVES + (lv >= 5 ? 1 : 0) : 0;   // (the last lane's count includes the goal room's wolves)
    if (li < legs.length) quota[li] = Math.max(0, Math.round(top / Math.pow(RUN_TAIL_GROWTH, RUN_PAUSES.length - lv)) - guardsAt(li) - room);
  });
  const spanScale = 1 + Math.min(1, 0.1 * (level - 1));   // territories grow with level
  // Run only: at an unsafe corner shared with another lane, wolves whose territory reaches the corner may also walk
  // into the neighbouring lane (an extra box in this leg's frame: the corner's band of th, and r reaching into the
  // other lane; enemies.js canWalk keeps every walk inside one box, so nobody cuts through the corner's walls).
  const cornerExt = (li, end) => {
    if (!pauseRange || endSafe[li][end]) return null;
    const nb = end ? li - 1 : li + 1;
    if (nb < 0 || nb > last) return null;
    const leg = legs[li], o = legs[nb];
    const dx = end ? o.ux : -o.ux, dz = end ? o.uz : -o.uz;   // from the corner into the neighbouring lane
    const side = Math.sign(dx * leg.nx + dz * leg.nz);
    if (!side) return null;
    const reach = Math.max(0, Math.min(12, o.len - W / 2));
    const c = end ? leg.len : 0;
    return {
      thLo: c - W / 2 + WOLF_MARGIN, thHi: c + W / 2 - WOLF_MARGIN,
      rLo: side > 0 ? vIn : -W / 2 - reach, rHi: side > 0 ? W / 2 + reach : vOut,
    };
  };
  // the final stretch's first corner sits right above the goal room's door (spiral levels): wolves there may also walk
  // straight down through the door (a column the width of the corridor) and roam the room, but never into the goal
  // disc (avoid: its radius + a wolf, so the victory circle stays as wolf-free as a safe square)
  const toFrame = (leg, x, z) => ({ r: (x - leg.ox) * leg.nx + (z - leg.oz) * leg.nz, th: (x - leg.ox) * leg.ux + (z - leg.oz) * leg.uz });
  const roomBoxes = (() => {
    if (!pauseRange || lvl.finale) return null;
    const leg = legs[last], m = ROOM - WOLF_MARGIN;
    const pts = [[-m, -m], [m, -m], [-m, m], [m, m]].map(([x, z]) => toFrame(leg, x, z));
    const room = { rLo: Math.min(...pts.map((q) => q.r)), rHi: Math.max(...pts.map((q) => q.r)), thLo: Math.min(...pts.map((q) => q.th)), thHi: Math.max(...pts.map((q) => q.th)) };
    const c = toFrame(leg, 0, 0), side = Math.sign(c.r);   // the room lies this way across the corridor
    const band = { thLo: -W / 2 + WOLF_MARGIN, thHi: W / 2 - WOLF_MARGIN };
    const column = side > 0 ? { ...band, rLo: vIn, rHi: room.rHi } : { ...band, rLo: room.rLo, rHi: vOut };
    return { boxes: [column, room], band, avoid: { r: c.r, th: c.th, R: lvl.centerRadius + CFG.WOLF_RADIUS + 0.05 } };
  })();
  const extFor = (li, a0, a1) => {
    const boxes = [];
    let avoid = null;
    for (const end of [0, 1]) {
      const ext = cornerExt(li, end);
      if (ext && a0 <= ext.thHi && a1 >= ext.thLo) boxes.push(ext);
    }
    if (li === last && roomBoxes && a0 <= roomBoxes.band.thHi && a1 >= roomBoxes.band.thLo) { boxes.push(...roomBoxes.boxes); avoid = roomBoxes.avoid; }
    return boxes.length ? { boxes, avoid } : null;
  };

  legs.forEach((leg, li) => {
    const m = quota[li];
    const { lo: R0, hi: R1 } = ranges[li];
    if (m <= 0 || R1 - R0 < 1) return;
    const frame = { ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz };
    const dk = depth(li);
    const off = rng.next();
    let placed = 0;   // wolves placed in this lane so far
    for (let k = 0; k < m; k++) {
      const t = (k + off * 0.6 + 0.2) / m;
      const cs = R0 + (R1 - R0) * Math.min(0.999, t) + rng.range(-0.15, 0.15) / m * (R1 - R0);
      const type = rng.pick(p.enemyTypes);   // always 'wanderer' now, but the pick's rng.next() keeps levels unchanged
      // Run only: in every lane a share of the wolves (RUN_OLD_SHARE, spread evenly along it) keeps the original
      // behaviour for its level; the rest are tuned (pauses / walks / shared speed)
      const tuned = !!pauseRange && Math.floor((placed + 1) * oldShare) === Math.floor(placed * oldShare);
      const span = (tuned ? moveScale : 1) * spanScale * (1 + 0.4 * dk) * rng.range(10, 20);
      const lo = Math.max(R0, cs - span / 2), hi = Math.min(R1, cs + span / 2);
      if (hi - lo < 2.5) continue;
      const id = enemies.length;
      const spec = {
        id, type, leg: li, frame,
        rIn: vIn, rOut: vOut, a0: lo, a1: hi,
        // tuned wolves all share one speed, and in Run only the original ones do too (the rng calls stay so the
        // rest of the level is unchanged)
        speed: Math.min(CFG.KITTY_SPEED * 0.92, tuned ? (rng.next(), p.enemySpeed)
          : pauseRange ? (rng.next(), p.enemySpeed) : p.enemySpeed * (0.9 + 0.2 * dk) * rng.range(0.9, 1.1)),
        phase: rng.next(),
        pauseScale: p.enemyPauseScale * (lvl.finale || !(lvl.fv >= 10) ? 1.15 - 0.45 * dk : 1),   // (version 10+: no shorter rests toward the middle, levels 1-8)
        seed: hashSeed(seed, level, 'wolf', id),
      };
      if (tuned) { spec.pauseRange = pauseRange; spec.walk = walk; }
      if (pauseRange) { spec.lateral = true; spec.wallShare = wallShare; if (wallBand) spec.wallBand = wallBand; }   // every wolf of a running level also covers the walls (enemies.js)
      const ext = extFor(li, lo, hi);
      if (ext) { spec.ext = ext.boxes; if (ext.avoid) spec.avoid = ext.avoid; }
      enemies.push(spec);
      placed++;
    }
    // Run only: a guard wolf at each end of the lane next to a safe square, roaming the stretch right beside it
    // (spread-out territories leave those ends half as crowded, so a corner felt like two safe squares in a row)
    if (!pauseRange || li === last || lvl.finale) return;   // (none by Run only's level 9 start room: already the busiest spot)
    const GUARD = 6;   // territory length next to the square
    for (const end of [0, 1]) {
      if (!endSafe[li][end]) continue;
      const a0 = end ? Math.max(R0, R1 - GUARD) : R0, a1 = end ? R1 : Math.min(R1, R0 + GUARD);
      if (a1 - a0 < 2.5) continue;
      const id = enemies.length;
      const tuned = Math.floor((placed + 1) * oldShare) === Math.floor(placed * oldShare);
      const spec = {
        id, type: 'wanderer', leg: li, frame,
        rIn: vIn, rOut: vOut, a0, a1,
        speed: Math.min(CFG.KITTY_SPEED * 0.92, tuned ? p.enemySpeed : (rng.next(), p.enemySpeed)),
        phase: rng.next(),
        pauseScale: p.enemyPauseScale * (lvl.finale || !(lvl.fv >= 10) ? 1.15 - 0.45 * dk : 1),   // (version 10+: no shorter rests toward the middle, levels 1-8)
        seed: hashSeed(seed, level, 'wolf', id),
      };
      if (tuned) { spec.pauseRange = pauseRange; spec.walk = walk; }
      if (pauseRange) { spec.lateral = true; spec.wallShare = wallShare; if (wallBand) spec.wallBand = wallBand; }   // every wolf of a running level also covers the walls (enemies.js)
      enemies.push(spec);
      placed++;
    }
  });
  // Running levels: a few wolves of the goal room's own, roaming the half of it on the door's side all round the goal
  // disc (never onto it), so no way into the disc is safe; until now only the final stretch's wolves came in, by the
  // door, and the far side of the room was always empty.
  if (pauseRange && !lvl.finale) {
    const leg = legs[last], m = ROOM - WOLF_MARGIN;
    const alongX = Math.abs(leg.ox) > Math.abs(leg.oz), sd = Math.sign(alongX ? leg.ox : leg.oz) || 1;
    const corners = alongX ? [[0, -m], [sd * m, -m], [0, m], [sd * m, m]] : [[-m, 0], [m, 0], [-m, sd * m], [m, sd * m]];
    const pts = corners.map(([x, z]) => toFrame(leg, x, z)), c = toFrame(leg, 0, 0);
    const frame = { ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz };
    const n = ROOM_WOLVES + (lv >= 5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const id = enemies.length;
      enemies.push({
        id, type: 'wanderer', leg: last, frame,
        rIn: Math.min(...pts.map((q) => q.r)), rOut: Math.max(...pts.map((q) => q.r)),
        a0: Math.min(...pts.map((q) => q.th)), a1: Math.max(...pts.map((q) => q.th)),
        speed: Math.min(CFG.KITTY_SPEED * 0.92, p.enemySpeed),
        phase: (k + rng.next()) / n,
        pauseScale: p.enemyPauseScale,
        seed: hashSeed(seed, level, 'wolf', id),
        pauseRange, walk,
        avoid: { r: c.r, th: c.th, R: lvl.centerRadius + CFG.WOLF_RADIUS + 0.05 },
        goalRoom: true,
      });
    }
  }
  return enemies;
}

// ---------------------------------------------------------------- pattern wolves (Skate only mode)
//
// In Skate only (mode 'ice') wolves don't wander: each runs a fixed route at a fixed rhythm (see the
// pattern section of enemies.js), so a leg is a "room" the kitty studies from the safe corner square and
// then skates through in one go (it can't stop on ice).
//
// Every wolf runs end to end and never stands still: it turns straight round at each end.
//   charger    runs the whole leg in a fixed lane, from the edge of one safe square to the next and back. Charger
//              lanes are skating lanes (PAT_LANES), so the lanes between them stay open; they own their lane all the time
//              (go beside them). A leg's charger lanes run at speeds whose laps share a period <= 60 s and take
//              turns; a lane holds 1-5 wolves, loosely spaced (more only where the level needs them for its count).
//   crosser    crosses the lane wall to wall, in rows walking shoulder to shoulder (crosswalk: line / wave / anti =
//              abreast, slightly staggered one way or the other / split = two halves from opposite walls; single)
//   diagonal   crosses wall to wall at an angle (swing, scissors = two crossing half a beat apart, fan = a row of swings)
// The final run (level 9's straight corridor) is built the same way: its rooms are legs too, with no door, and it
// has FINALE_WOLVES wolves.
// A leg = a set of charger lanes + crosser / diagonal segments top (entry, high th) to bottom. The room's beat is T:
// a crosser / diagonal runs there and back once per T. Rows are tight (PAT_ROW_SP < 2 * PAT_HIT: the kitty can't slip
// between two neighbours), so a row in step is a wall; it opens up through speed differences: in every row of 3+ at
// least one wolf in four (patRowNeed, more at random, spread along the row) drifts, lap T / (1 + j / n), n in
// PAT_DRIFT_N, j a whole number of laps gained / lost every n beats, picked so its speed is PAT_DRIFT_MU (0.8x - 1.4x)
// of the room's; lone crossers, pairs and scissors drift
// now and then. The room repeats every n * T <= PAT_DRIFT_PERIOD seconds. Rooms are built as designed, with no
// launch-window solver (the balance is playtested): each segment gets a random timing offset (placeLeg), about half
// of a room's rows starting the level nearer the other wall.
// Level 1's first legs ease in (PAT_LESSONS, only their rows drift); difficulty D = levelParams().patternHeat + 0.5 *
// depth drives the beat (and so the wolf speed), density, charger speed and lanes, and the variants.

const PAT_HIT = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
const PAT_SAFE = PAT_HIT + 0.3;               // clearance (spare room for imperfect skating)
const PAT_LANES = [-3.6, -1.8, 0, 1.8, 3.6];   // skating lanes: center, middles, near the walls (charger lanes are among them)
const PAT_BIN = 1 / 40;                       // timing resolution (s); beats are multiples of 0.25 s
const PAT_HZ = 120;                           // pose table rate (3 steps per bin)
const PAT_VK = CFG.KITTY_SPEED;               // skating speed the rooms are designed for
const PAT_VMAX = CFG.KITTY_SPEED * 0.9;
const PAT_DRIFT_PERIOD = 60;                  // drifting wolves are back in step with their room within this (s)
const PAT_DRIFT_N = [9, 12];                  // a room's drifting wolves gain / lose whole laps every n beats (n in this
                                              // range, 8 in the slowest rooms), so they're back in step every n beats
const PAT_DRIFT_MU = [0.8, 1.4];              // a drifting wolf's speed vs its room's (as far as PAT_VMAX allows)
const PAT_ROW_SP = [1.35, 1.6];               // spacing within a row (units): under 2 * PAT_HIT, shoulder to shoulder
const PAT_ROW_GAP = 1.69;                     // a staggered row's neighbours stay closer than this (< 2 * PAT_HIT)
const patRowNeed = (k) => (k >= 3 ? Math.ceil(k / 4) : 0);   // wolves of a row of k that run at a speed of their own
const PAT_TYPES = ['charger', 'crosser', 'diagonal'];
// How many wolves a level has, at most: level 1 ~2x the 116 of the first pattern design, +10% per level up to
// level 8. Rooms are packed by density G (shorter spacers, longer rows, wider fans); a level that came out over is
// trimmed by shortening its longest rows, then leaving out lone crossers. One that came out under could be topped
// up with charger packs (followers in a charger's own lane, up to PAT_PACK_MAX per lane), but trains of chargers
// don't play well: every charger runs alone in its lane, as in the final run.
const PAT_WOLVES_L1 = 232.6, PAT_WOLVES_GROWTH = 1.1, PAT_WOLVES_TOP = 8;
const PAT_PACK_MAX = 1;                       // wolves per charger lane, at most (1: no followers)
const ROOM_BAND = 5.85;                       // goal room wolves: distance of their tracks from the room's centre
const PAT_PACK_GAP = 2.2;                    // distance between pack members (units): 1-2x this, at random
const patWolfTarget = (level, finale) => finale ? FINALE_WOLVES : Math.round(PAT_WOLVES_L1 * ipow(PAT_WOLVES_GROWTH, Math.min(level, PAT_WOLVES_TOP) - 1));
const patDensity = (level) => Math.min(2.2, 1.2 + 0.14 * (Math.min(level, PAT_WOLVES_TOP) - 1));
const NO_FRAME = { ox: 0, oz: 0, ux: 1, uz: 0, nx: 0, nz: 1 };

// finale: the final run (its start square is like any safe square too: FINALE_START_GAP)
function usableRanges(legs, finale = false, W = CFG.RING_WIDTH) {
  const last = legs.length - 1;
  return legs.map((leg, li) => {
    let lo = (leg.padLo ?? W / 2 + CORNER_REST) + CFG.WOLF_RADIUS;
    let hi = leg.len - (leg.padHi ?? W / 2 + CORNER_REST) - CFG.WOLF_RADIUS;
    // the spiral's final stretch: neither corner is safe; the final run's last room keeps its entry gap (padHi)
    if (li === last) { lo = -W / 2 + WOLF_MARGIN; if (leg.padHi == null) hi = leg.len + W / 2 - WOLF_MARGIN; }
    // the spiral's lane before it: its first corner (the final stretch's) isn't safe either, wolves run into it
    else if (li === last - 1 && !finale) lo = -W / 2 + WOLF_MARGIN;
    return { lo, hi: Math.max(lo, hi) };
  });
}

// --- pattern library. Every wolf runs end to end: crossers / diagonals go wall to wall, chargers run the whole
// leg between the two safe squares (edge to edge), turning straight round at each end.
// Segment builders return { name, depth, wolves } with th in [0, depth] (depth = the end the kitty meets first);
// wolf: { type, route: [{r, th}], loop, offT (fraction of its own cycle), offS (s) }. c = { D, rng, vOut }.

function segCrosswalk(c, o = {}) {
  const { rng, vOut } = c, G = c.G || 0;
  let k = o.k || Math.max(1, 1 + Math.floor(c.D * 2.5 + G * 2 + rng.next() * 1.6));
  // rows walk shoulder to shoulder (PAT_ROW_SP: the kitty can't slip between two neighbours): line = abreast, wave /
  // anti = abreast with a slight stagger one way or the other, split = two halves starting on opposite walls. Rows
  // only open up through their wolves' speed differences (placeLeg). comb (alternate sides) is for the final door.
  let variant = o.variant || (k === 1 ? 'single' : rng.pick(k >= 4 && rng.chance(0.25) ? ['split'] : ['line', 'line', 'wave', 'anti']));
  const g = Math.min(1, G);
  let sp = rng.range(PAT_ROW_SP[0], PAT_ROW_SP[1]);
  if (k > 1) {     // (a lone crosser draws nothing more)
    if (!o.k) k += Math.floor(G * 2 * rng.next());
    k = Math.min(k, 3 + Math.round(3 * g * rng.next()) + (rng.chance(0.15 * g) ? 1 : 0), 1 + Math.floor((o.room ?? 99) / sp));
  }
  if (k === 1) { sp = 0; if (!o.variant) variant = 'single'; }
  if (variant === 'split' && k < 4) variant = 'line';
  const side = rng.chance(0.5) ? 1 : -1, half = variant === 'split' ? Math.round(k * rng.range(0.35, 0.65)) : 0;
  const wolves = [];
  for (let i = 0; i < k; i++) {
    const s = (variant === 'comb' && i % 2) || (variant === 'split' && i >= half) ? -side : side;
    const th = (k - 1 - i) * sp;
    const w = { type: 'crosser', route: [{ r: -s * vOut, th }, { r: s * vOut, th }], offT: 0, offS: 0 };
    // stagger (in units of one step: set once the speed is known, see legDesign)
    w.stag = variant === 'wave' ? -i : variant === 'anti' ? i : 0;
    wolves.push(w);
  }
  return { name: 'crosswalk-' + variant, depth: (k - 1) * sp, wolves, sp };
}

// diagonals: wall to wall at an angle. swing = one; scissors = two crossing half a beat apart; fan = parallel swings
function segDiagonal(c, o = {}) {
  const { rng, vOut } = c;
  const variant = o.variant || rng.pick(c.D < 0.6 || (o.room ?? 99) < 10 ? ['swing', 'scissors'] : ['swing', 'scissors', 'fan']);
  const s = rng.chance(0.5) ? 1 : -1, A = -s * vOut, B = s * vOut;
  const d = rng.range(4, 6);
  let wolves, depth = d;
  if (variant === 'scissors') {
    wolves = [
      { type: 'diagonal', route: [{ r: A, th: 0 }, { r: B, th: d }], offT: 0, offS: 0 },
      { type: 'diagonal', route: [{ r: B, th: 0 }, { r: A, th: d }], offT: 0.5, offS: 0 },
    ];
  } else if (variant === 'fan') {
    // parallel swings shoulder to shoulder (a row at an angle); denser levels fan out wider
    const sp = rng.range(PAT_ROW_SP[0], PAT_ROW_SP[1]);
    const m = Math.max(2, Math.min(2 + Math.floor((c.G || 0) * rng.next() * 2.5), 1 + Math.floor(((o.room ?? 99) - d) / sp)));
    depth = d + (m - 1) * sp;
    wolves = [...Array(m).keys()].map((i) => ({ type: 'diagonal', route: [{ r: A, th: i * sp }, { r: B, th: d + i * sp }], offT: 0, offS: 0 }));
  } else wolves = [{ type: 'diagonal', route: [{ r: A, th: 0 }, { r: B, th: d }], offT: 0, offS: 0 }];
  return { name: 'diagonal-' + variant, depth, wolves };
}

const PAT_FAMILIES = { crosswalk: segCrosswalk, diagonal: segDiagonal };
// Level 1 eases in: two legs of plain crossers, then the first charger lane; after that it's the real thing.
// Each lesson: [chargers (lanes) or null = random, segments to cycle through]. Lessons are packed with density
// PAT_LESSON_G (busier than they used to be, still one idea per room).
const PAT_LESSONS = [
  [[], [['crosswalk', { k: 1 }], ['crosswalk', { k: 1 }], ['crosswalk', { k: 2, variant: 'wave' }]]],
  [[], [['crosswalk', { k: 3, variant: 'wave' }], ['crosswalk', { k: 1 }]]],
  [[0], [['crosswalk', { k: 1 }], ['crosswalk', { k: 2, variant: 'comb' }], ['crosswalk', { k: 3, variant: 'wave' }]]],
];
const PAT_LESSON_G = 0.6;

// --- timing helpers

// Fits the wolf's speed so it runs its route there and back in exactly Tw seconds (false: it would be too fast).
function patFit(w, Tw) {
  w.speed = patternSpeed(w, Tw);
  return w.speed > 0 && w.speed <= PAT_VMAX && Math.abs(buildPlan(w, NO_FRAME, w.speed).cycle - Tw) < 1e-9;
}

// Pose table over one lap (w.cycle) at PAT_HZ; w.M = table steps per lap (a whole number: laps are beats).
function patTable(w) {
  const plan = buildPlan(w, NO_FRAME, w.speed);
  w.cycle = plan.cycle;
  w.M = Math.round(plan.cycle * PAT_HZ);
  w.tr = new Float64Array(w.M); w.tth = new Float64Array(w.M);
  for (let i = 0; i < w.M; i++) { const p = patternPose(plan, i / PAT_HZ); w.tr[i] = p.r; w.tth[i] = p.th; }
}

function patPoseIdx(w, t) {
  let tc = (t + w.off) % w.cycle;
  if (tc < 0) tc += w.cycle;
  return Math.min(w.M - 1, Math.floor(tc * PAT_HZ));
}

function placePatternEnemies(rng, lvl, p) {
  const { legs, seed, level } = lvl;
  const W = CFG.RING_WIDTH;
  const vOut = W / 2 - WOLF_MARGIN;
  const ranges = usableRanges(legs, !!lvl.finale, lvl.corridorWidth);
  const last = legs.length - 1;
  const door = lvl.finale ? -1 : last;   // the spiral's final stretch (door before the goal); the final run has none
  // a corridor several lanes wide (the wide skate final run test): one normal-width layout per band, side by side
  const nb = Math.max(1, Math.round(lvl.corridorWidth / W)), bands = [...Array(nb).keys()].map((k) => (k - (nb - 1) / 2) * W);
  const wideOut = lvl.corridorWidth / 2 - WOLF_MARGIN;   // wall to wall across all of them
  const enemies = [];
  const plans = [];
  const G0 = lvl.finale ? 2 : patDensity(level);   // the final run keeps its own tuning (density 2)
  const target = patWolfTarget(level, lvl.finale) * nb;
  const frameOf = (leg) => ({ ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz });
  const finish = (w, leg) => {
    w.rMin = Math.min(...w.route.map((q) => q.r)); w.rMax = Math.max(...w.route.map((q) => q.r));
    w.thMin = Math.min(...w.route.map((q) => q.th)); w.thMax = Math.max(...w.route.map((q) => q.th));
    w.frame = frameOf(leg);
  };

  // Chargers: full-length runners in fixed lanes (solver lanes, so the lanes between them stay open). They
  // own their lane all the time, so they don't need the room's beat. A leg's chargers share one speed and take
  // turns: their laps (5-35 s) would need speeds up to 60% apart to come back into step within PAT_DRIFT_PERIOD.
  const chargerLanes = (li, D) => {
    const lesson = level === 1 && li !== door ? PAT_LESSONS[li] : null;
    if (lesson) return lesson[0];
    let n = D < 0.25 ? (rng.chance(0.6) ? 1 : 0) : D < 0.6 ? 1 + (rng.chance(0.6) ? 1 : 0) : D < 1 ? 2 + (rng.chance(D - 0.4) ? 1 : 0) : 3;
    if (li === door) n = Math.max(2, n);   // the final stretch always has chargers running into the goal room
    const sets = {
      0: [[]], 1: [[0], [-1.8], [1.8], [-3.6], [3.6]],
      2: [[-1.8, 1.8], [-3.6, 3.6], [-3.6, 0], [0, 3.6], [-1.8, 3.6], [-3.6, 1.8]],
      3: [[-3.6, 0, 3.6], [-1.8, 1.8, -3.6], [-1.8, 1.8, 3.6], [-3.6, -1.8, 1.8]],
    };
    return rng.pick(sets[n]);
  };
  // The goal room (spiral levels): crossers and diagonals in the ring between the goal disc and the walls, so the
  // last stretch of ice before the disc is as busy as the lanes. Four crossers sweep left to right across the whole
  // room, two on each side of the disc (the nearest ROOM_BAND from the centre: clear of the disc, radius + a wolf),
  // and two diagonals cut across the far and near sides at a slant. Routes are in the final stretch's frame (all its wolves share it), timed to the
  // room's beat T (twice T where once would be too fast).
  // A crosser / diagonal of the final stretch whose room-side end is in front of the goal room's door (centred on
  // th 0) doesn't stop at the door: that end carries on through the door to the goal disc's edge (never onto it),
  // as long as the whole new route stays clear of the walls (a diagonal coming from further up the lane may not).
  const throughDoor = (w) => {
    const leg = legs[door];
    const c = { r: -leg.ox * leg.nx - leg.oz * leg.nz, th: -leg.ox * leg.ux - leg.oz * leg.uz };   // goal disc centre
    const R = lvl.centerRadius + CFG.WOLF_RADIUS + 0.1;
    // (finale version 5+: one beside the disc, not in line with it, runs on level with its middle; before, its end came
    // out NaN and it stopped halfway)
    const edge = (th) => (lvl.fv >= 5 && Math.abs(th - c.th) >= R ? 0 : Math.sqrt(R * R - (th - c.th) ** 2));
    const route = w.route.map((q) => (Math.sign(q.r) === Math.sign(c.r) && Math.abs(q.th) <= vOut
      ? { r: c.r - Math.sign(c.r) * edge(q.th), th: q.th } : q));
    if (route.every((q, k) => q === w.route[k])) return;
    for (let k = 1; k < route.length; k++) {
      const A = route[k - 1], B = route[k], n = Math.ceil(hyp(B.r - A.r, B.th - A.th) / 0.25);
      for (let t = 0; t <= n; t++) {
        const { x, z } = legPoint(leg, A.r + (B.r - A.r) * t / n, A.th + (B.th - A.th) * t / n);
        if (collideCircle(lvl, x, z, CFG.WOLF_RADIUS).hit) return;
      }
    }
    w.route = route;
    finish(w, leg);
  };
  const roomWolves = (T) => {
    const leg = legs[door], m = ROOM - HALF_T - CFG.WOLF_RADIUS - 0.08, b = ROOM_BAND;
    const fr = (x, z) => ({ r: (x - leg.ox) * leg.nx + (z - leg.oz) * leg.nz, th: (x - leg.ox) * leg.ux + (z - leg.oz) * leg.uz });
    // crossers: all left to right across the whole room (x, the way the camera looks at it), two tracks on the
    // far side of the disc and two on the near side
    const b2 = (b + m) / 2 + 0.25;
    const lines = [
      ['room-crosser', [-m, -b], [m, -b]], ['room-crosser', [-m, b], [m, b]],
      ['room-crosser', [-m, -b2], [m, -b2]], ['room-crosser', [-m, b2], [m, b2]],
      ['room-diagonal', [-m, -b + 0.55], [m, -m]], ['room-diagonal', [-m, m], [m, b - 0.55]],
    ];
    return lines.map(([name, A, B]) => {
      const w = { type: name === 'room-crosser' ? 'crosser' : 'diagonal', route: [fr(...A), fr(...B)], loop: false, offT: 0, offS: 0 };
      finish(w, leg);
      if (!patFit(w, T)) patFit(w, 2 * T);
      if (!(w.speed > 0 && w.speed <= PAT_VMAX)) w.speed = PAT_VMAX * 0.8;
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = rng.next() * w.cycle;
      return { name, wolves: [w] };
    });
  };
  // finale version 5+: white crossers in the doorway, 2 + 0.6 per level after the first side by side across the door counting the lane's own
  // (its rows already cross the doorway: the new ones only fill the gaps), each from the last lane's outer wall straight
  // through the door to the edge of the victory circle (or level with its middle, past its side). The door is the last
  // lane's first W, around its corner (th 0).
  const doorWolves = (T, segs) => {
    const leg = legs[door], n = 2 + Math.round(0.6 * (level - 1)), m = CFG.WOLF_RADIUS + 0.15;
    const c = { r: -(leg.ox * leg.nx + leg.oz * leg.nz), th: -(leg.ox * leg.ux + leg.oz * leg.uz) }, R = lvl.centerRadius + CFG.WOLF_RADIUS + 0.1;
    const lo = -W / 2 + m, hi = W / 2 - m;
    let slots = [...Array(n).keys()].map((i) => lo + (hi - lo) * (i + 0.5) / n);
    for (const sg of segs) if (!/^room-/.test(sg.name || '')) for (const w of sg.wolves) {
      if (w.type !== 'crosser' || w.thMin > hi + 0.5 || w.thMax < lo - 0.5) continue;
      const th = (w.thMin + w.thMax) / 2, near = slots.reduce((b, x) => (b === null || Math.abs(x - th) < Math.abs(b - th) ? x : b), null);
      if (near !== null) slots = slots.filter((x) => x !== near);
    }
    const order = rng.shuffle([...Array(slots.length).keys()]), k0 = slots.length;
    return order.map((k, i) => {
      const th = slots[i], dth = th - c.th;
      const end = Math.abs(dth) < R ? c.r - Math.sqrt(R * R - dth * dth) : c.r;
      const route = [{ r: -W / 2 + m, th }, { r: end, th }];
      if (i % 2) route.reverse();   // every other one starts at the victory circle
      const w = { type: 'crosser', route, loop: false, offT: 0, offS: 0 };
      finish(w, leg);
      if (!patFit(w, T)) patFit(w, 2 * T);
      if (!(w.speed > 0 && w.speed <= PAT_VMAX)) w.speed = PAT_VMAX * 0.8;
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = ((k + 0.3 * rng.next()) / k0) * w.cycle;   // taking turns, not all at once
      return { name: 'door-crosser', wolves: [w] };
    });
  };
  // finale version 5+: the lane before the last one kept too few side-to-side wolves (its rows at the junction end turn
  // round in the open and go, the rest are often sparse designs). Wherever its crossers leave a gap longer than FILL_GAP
  // (shrinking every level), single white crossers are added in it, wall to wall, taking turns.
  const fillCrossers = (pl) => {
    const leg = legs[pl.leg], m = CFG.WOLF_RADIUS + 0.15, gap = Math.max(3, 5.5 - 0.35 * (level - 1));
    const a = W / 2 + 1, b = leg.len - W / 2 - 1;
    const at = pl.segs.flatMap((sg) => sg.wolves.filter((w) => w.type === 'crosser').map((w) => (w.thMin + w.thMax) / 2)).filter((t) => t > a - gap / 2 && t < b + gap / 2);
    const cuts = [a - gap / 2, ...at.sort((x, y) => x - y), b + gap / 2], ths = [];
    for (let i = 1; i < cuts.length; i++) {
      const k = Math.floor((cuts[i] - cuts[i - 1]) / gap);
      for (let j = 1; j <= k; j++) ths.push(cuts[i - 1] + (cuts[i] - cuts[i - 1]) * j / (k + 1));
    }
    const order = rng.shuffle([...Array(ths.length).keys()]);
    return ths.map((th, i) => {
      const route = [{ r: -W / 2 + m, th }, { r: W / 2 - m, th }];
      if (rng.chance(0.5)) route.reverse();
      const w = { type: 'crosser', route, loop: false, offT: 0, offS: 0 };
      finish(w, leg);
      if (!patFit(w, pl.beat)) patFit(w, 2 * pl.beat);
      if (!(w.speed > 0 && w.speed <= PAT_VMAX)) w.speed = PAT_VMAX * 0.8;
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = ((order[i] + 0.3 * rng.next()) / ths.length) * w.cycle;
      return { name: 'fill-crosser', wolves: [w], top: 0, bottom: 0 };
    });
  };
  // finale version 5+: the square where the last two lanes meet (the last lane's far end) lost its crossers (they turned
  // round in the open), so only chargers passed through. White crossers cut across it at a slant instead, 1 + level / 2
  // (rounded up), each from one of its two outer walls (not too near the inner corner: they'd graze it) to the inner wall just round the corner (the lane before's, or
  // the last lane's), taking turns. In the last lane's frame: the square is th len +- W/2, the lane before carries on
  // at r > W/2, the last lane at th < len - W/2.
  const junctionWolves = (T) => {
    // (version 6+: none, purple wolves made the last lane too hard; junctionChargers instead)
    const leg = legs[door], m = CFG.WOLF_RADIUS + 0.15, n = lvl.fv >= 6 ? 0 : 1 + Math.ceil(level / 2), e = leg.len - W / 2;
    const order = rng.shuffle([...Array(n).keys()]);
    return order.map((k, i) => {
      const u = (Math.floor(i / 2) + 0.5) / Math.ceil(n / 2), out = rng.range(0.6, 2.6);
      const route = i % 2
        ? [{ r: -W / 2 + m, th: e + 2.5 + u * (W - 2.5 - m) }, { r: W / 2 + out, th: e + m }]    // outer wall -> the lane before's inner wall
        : [{ r: -W / 2 + m + u * (W - 2.5 - m), th: leg.len + W / 2 - m }, { r: W / 2 - m, th: e - out }];   // end wall -> the last lane's inner wall
      if (rng.chance(0.5)) route.reverse();
      const w = { type: 'crosser', route, loop: false, offT: 0, offS: 0 };
      finish(w, leg);
      if (!patFit(w, T)) patFit(w, 2 * T);
      if (!(w.speed > 0 && w.speed <= PAT_VMAX)) w.speed = PAT_VMAX * 0.8;
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = ((k + 0.3 * rng.next()) / n) * w.cycle;
      return { name: 'junction-crosser', wolves: [w], top: 0, bottom: 0 };
    });
  };
  // finale version 6+: more black chargers in the last lane instead of its purple wolves (its diagonals and the
  // junction's slanted crossers go): 1 (2 from level 3) on the last lane's free charger lanes (one always stays free), each the whole lane long, from the end wall
  // past the door to the wall beyond it, at the lane's charger speed.
  const junctionChargers = (pl) => {
    const leg = legs[door], m = CFG.WOLF_RADIUS + 0.15, cs = pl.segs.find((sg) => sg.chargers);
    const used = cs ? cs.wolves.map((w) => w.route[0].r) : [];
    const free = rng.shuffle(PAT_LANES.filter((r) => used.every((u) => Math.abs(u - r) > 1)));
    const k = Math.min(level >= 3 ? 2 : 1, free.length - 1), v = cs && cs.wolves.length ? cs.wolves[0].speed : 0.8 * PAT_VMAX;
    return free.slice(0, Math.max(0, k)).map((r) => {
      const route = [{ r, th: leg.len + W / 2 - m }, { r, th: -W / 2 + m }];
      if (rng.chance(0.5)) route.reverse();
      const w = { type: 'charger', route, loop: false, speed: v, offT: 0, offS: 0 };
      finish(w, leg);
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = rng.next() * w.cycle;
      return { name: 'junction-charger', wolves: [w], top: 0, bottom: 0 };
    });
  };
  // finale version 7+: k white crossers wall to wall, each in the biggest gap left between the lane's crossers (between
  // its corner squares), at random times in the lane's beat
  const gapCrossers = (pl, k) => {
    const leg = legs[pl.leg], m = CFG.WOLF_RADIUS + 0.15, a = W / 2 + 1, b = leg.len - W / 2 - 1, out = [];
    const at = pl.segs.flatMap((sg) => sg.wolves.filter((w) => w.type === 'crosser').map((w) => (w.thMin + w.thMax) / 2)).filter((t) => t > a && t < b);
    for (let j = 0; j < k; j++) {
      const cuts = [a, ...at.sort((x, y) => x - y), b];
      let gi = 1;
      for (let i = 2; i < cuts.length; i++) if (cuts[i] - cuts[i - 1] > cuts[gi] - cuts[gi - 1]) gi = i;
      const th = (cuts[gi - 1] + cuts[gi]) / 2;
      at.push(th);
      const route = [{ r: -W / 2 + m, th }, { r: W / 2 - m, th }];
      if (rng.chance(0.5)) route.reverse();
      const w = { type: 'crosser', route, loop: false, offT: 0, offS: 0 };
      finish(w, leg);
      if (!patFit(w, pl.beat)) patFit(w, 2 * pl.beat);
      if (!(w.speed > 0 && w.speed <= PAT_VMAX)) w.speed = PAT_VMAX * 0.8;
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = rng.next() * w.cycle;
      out.push({ name: 'fill-crosser', wolves: [w], top: 0, bottom: 0 });
    }
    return out;
  };
  // the difficulty wolf speeds go by (chargers' speed, the beat crossers and diagonals keep). Finale version 7+: above
  // SPEED_KNEE it counts SPEED_SLOPE as much, so the last levels' wolves don't all run near the cap (still faster every
  // level, just less so)
  const speedD = (D) => (lvl.fv >= 7 && !lvl.finale ? Math.min(D, SPEED_KNEE) + Math.max(0, D - SPEED_KNEE) * SPEED_SLOPE : D);
  const makeChargers = (li, D, lanes) => {
    const leg = legs[li], { lo, hi } = ranges[li];
    const v = Math.min(PAT_VMAX, (3.9 + 1.4 * speedD(D)) * rng.range(0.95, 1.05));
    const off = rng.next();
    // lanes run at different speeds where they can: laps P / m (m = n +- 0..2) all fit the period P = n * lap
    // (P <= PAT_DRIFT_PERIOD), so the lanes come back into step every P seconds
    const ms = [];
    return lanes.map((r, i) => {
      const w = { type: 'charger', route: [{ r, th: lo }, { r, th: hi }], loop: false, speed: v };
      finish(w, leg);
      const lap = buildPlan(w, NO_FRAME, v).cycle, n = Math.floor(PAT_DRIFT_PERIOD / lap + 1e-9);
      if (n >= 3) {
        for (const m of rng.shuffle([n, n - 1, n + 1, n - 2, n + 2])) {
          if (ms.includes(m)) continue;
          const vm = patternSpeed(w, n * lap / m);
          if (vm >= 0.75 * v && vm <= PAT_VMAX) { w.speed = vm; ms.push(m); break; }
        }
      }
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = ((off + i / lanes.length) % 1) * w.cycle;     // they take turns running at you
      return w;
    });
  };

  const legDesign = (li, D, T0) => {
    const leg = legs[li];
    const { lo, hi } = ranges[li];
    const lesson = level === 1 ? PAT_LESSONS[li] : null;
    const G = lesson ? PAT_LESSON_G : G0;
    // gap between segments: their nearest rows are at least 2 * PAT_SAFE * 0.7 (~1.6) apart
    const spacer = () => (Math.max(2.4, 8 - 5.5 * D) + rng.range(-0.8, 1.2)) * Math.max(0.1, 1 - 0.8 * G) + 2 * PAT_SAFE * Math.max(0.7, 1 - 0.3 * G);
    const c = { D, G, rng, vOut };
    // the room's beat T: every crosser / diagonal runs there and back once per T (at the speed that takes); some
    // drift a little off it (placeLeg)
    const T = T0 || Math.round(Math.max(5, 7.5 - 2 * speedD(D)) * 4) / 4;
    const fit = (w) => patFit(w, T);
    const segs = [];
    let cursor = hi - rng.range(0, 1.2);
    for (let n = 0; n < 30; n++) {
      let made = null;
      for (let tries = 0; tries < 5 && !made; tries++) {
        let fam = 'crosswalk', opt = {};
        if (lesson) [fam, opt] = lesson[1][n % lesson[1].length];
        else if (D >= 0.3 && rng.chance(0.3)) fam = 'diagonal';
        if (tries > 2) { fam = 'crosswalk'; opt = { k: 1 }; }
        const sd = PAT_FAMILIES[fam](c, { room: cursor - lo, ...opt });
        if (cursor - sd.depth < lo + 0.01) continue;
        const base = cursor - sd.depth;
        for (const w of sd.wolves) {
          w.route = w.route.map((q) => ({ r: q.r, th: q.th + base }));
          finish(w, leg);
        }
        if (li === door) for (const w of sd.wolves) throughDoor(w);
        if (!sd.wolves.every(fit)) continue;
        // a staggered row: each wolf a step behind (wave) / ahead (anti) of its neighbour, small enough that two
        // neighbours stay closer than PAT_ROW_GAP even mid-crossing
        for (const w of sd.wolves) if (w.stag) w.offS = w.stag * Math.min(sd.sp / PAT_VK, Math.sqrt(PAT_ROW_GAP * PAT_ROW_GAP - sd.sp * sd.sp) / w.speed);
        made = { ...sd, family: fam, top: cursor + PAT_SAFE, bottom: base - PAT_SAFE, base };
      }
      if (!made) break;
      segs.push(made);
      cursor = made.base - spacer();
      if (cursor < lo) break;
    }
    for (const sg of segs) for (const w of sg.wolves) {
      patTable(w);
      w.off = w.offT * w.cycle + w.offS;
    }
    return { segs, T, D };
  };

  // A room's timing (no launch-window solver: rooms are built as designed). Each segment gets a random timing offset,
  // chosen so that about half the room's rows start the level nearer the other wall. Drifting wolves: each row of 3+
  // gets at least one wolf in four (patRowNeed, sometimes more, spread along the row so gaps open in different places)
  // on lap T / mu, mu = 1 + j / n (n in PAT_DRIFT_N, j laps gained / lost every n beats, mu within PAT_DRIFT_MU);
  // lone crossers, pairs and scissors now and then (calm: level 1's lessons and the final door, only their rows). The
  // room repeats every n beats (<= PAT_DRIFT_PERIOD s).
  const placeLeg = (li, design, chargers, calm) => {
    const { segs, T } = design;
    const N = Math.round(T / PAT_BIN);
    const nTop = Math.min(PAT_DRIFT_N[1], Math.floor(PAT_DRIFT_PERIOD / T + 1e-9));
    const n = nTop <= PAT_DRIFT_N[0] ? nTop : PAT_DRIFT_N[0] + Math.floor(rng.next() * (nTop - PAT_DRIFT_N[0] + 1));
    let period = 0;
    // j laps more (j > 0) or fewer (j < 0) every n beats: any whole j != 0 with 1 + j / n within PAT_DRIFT_MU
    const jLo = Math.max(1, Math.floor((1 - PAT_DRIFT_MU[0]) * n + 1e-9)), jHi = Math.max(1, Math.floor((PAT_DRIFT_MU[1] - 1) * n + 1e-9));
    const sign = () => { const k = 1 + Math.floor(rng.next() * (jLo + jHi)); return k <= jLo ? -k : k - jLo; };
    // too fast for PAT_VMAX: fewer extra laps, down to none (then a lap less)
    const drift = (w, j) => {
      for (let jj = j; jj !== 0; jj = jj > 1 ? jj - 1 : jj === 1 ? -1 : 0) {
        const v = patternSpeed(w, w.cycle / (1 + jj / n));
        if (v > 0 && v <= PAT_VMAX) { w.speed = v; w.drift = true; period = n * T; return; }   // w.cycle (the beat) stays its phase reference
      }
    };
    // c wolves of a row spread along it: one from each of c even stretches
    const spread = (ws, c) => [...Array(c).keys()].map((q) => {
      const a = Math.floor(q * ws.length / c), b = Math.floor((q + 1) * ws.length / c);
      return ws[a + Math.floor(rng.next() * (b - a))];
    });
    const sides = rng.shuffle(segs.map((_, i) => (i % 2 ? 1 : -1)));
    const sideAt = (seg, s) => { const w = seg.wolves[0], i = patPoseIdx(w, s * PAT_BIN); return w.tr[i] >= 0 ? 1 : -1; };
    segs.forEach((seg, si) => {
      const ws = seg.wolves;
      let s = Math.floor(rng.next() * N);
      if (sideAt(seg, s) !== sides[si]) s = (s + Math.round(N / 2)) % N;     // half a lap on: the other wall
      for (const w of ws) w.off += s * PAT_BIN;
      if (seg.name === 'diagonal-scissors') {      // both or neither, on one drift (so they never meet)
        if (!calm && rng.chance(0.6)) { const j = sign(); ws.forEach((w) => drift(w, j)); }
      } else if (patRowNeed(ws.length)) {
        const need = patRowNeed(ws.length), most = Math.max(need, Math.floor(ws.length / 2));
        for (const w of spread(ws, need + Math.floor(rng.next() * (most - need + 1)))) drift(w, sign());
      } else if (!calm && rng.chance(ws.length === 1 ? 0.4 : 0.5)) drift(rng.pick(ws), sign());
    });
    const open = PAT_LANES.map((r) => chargers.every((w) => Math.abs(w.route[0].r - r) >= PAT_SAFE + 0.3));
    const kept = segs.slice();
    if (chargers.length) kept.unshift({ name: 'chargers', top: ranges[li].hi + PAT_SAFE, bottom: ranges[li].lo - PAT_SAFE, wolves: chargers, chargers: true });
    if (!kept.length) return null;
    return { leg: li, beat: T, period, segs: kept, open };
  };

  // finale version 4+ (the spiral levels): no crosser / diagonal that turns round in the open. Where two lanes meet at
  // an unsafe corner, a row crossing one lane right at the corner ended where a wall would be, but there the other lane
  // carries on: they ran up and turned round in mid-air in the middle of the junction. (Wolves that end at a wall or
  // run on into the goal room are fine.) Dropped after everything's made, so the rest of the level stays the same.
  const endsInOpen = (w) => {
    // (only the last two lanes', which meet there: the last lane's run up and down across the junction. Version 5+ the lane
    // before's too: from its outer wall to where its inner wall stops, turning round in the last lane. Its ones that end
    // at a wall stay)
    if (!(lvl.fv >= 4) || lvl.finale || (w.leg !== door && !(lvl.fv >= 5 && w.leg === door - 1)) || (w.type !== 'crosser' && w.type !== 'diagonal') || /^(room|junction)-/.test(w.pattern || '')) return false;
    const leg = legs[w.leg], ends = [w.route[0], w.route[w.route.length - 1]].map((q) => legPoint(leg, q.r, q.th));
    for (let i = 0; i < 2; i++) {
      const { x, z } = ends[i], o = ends[1 - i];
      if (Math.abs(x) < ROOM + 1 && Math.abs(z) < ROOM + 1) continue;   // into the goal room (through its door)
      if (lvl.fv >= 5) {
        // version 5+: the wall has to be ahead of it (one it runs alongside, like the outer wall at the corner, doesn't count)
        const dx = x - o.x, dz = z - o.z, n = hyp(dx, dz) || 1, a = CFG.WOLF_RADIUS + 0.6;
        if (!collideCircle(lvl, x + dx / n * a, z + dz / n * a, 0.3).hit) return true;
      } else if (!collideCircle(lvl, x, z, CFG.WOLF_RADIUS + 0.6).hit) return true;
    }
    return false;
  };
  // finale version 4+ (the spiral levels): the last two lanes' danger. They're designed like every lane, but with extra
  // rules on top (the final stretch's chargers, rows through the door), so how dangerous they came out was luck: from far
  // harder than the level's other lanes to nearly empty (a kitty standing still was touched 4-22% of the time). Now
  // LAST_LANE_TRIES designs are made for each and the least risky one (laneRisk) that's still at or over LAST_LANE_RISK
  // for the level is kept, then trimmed down to it once the wolf count is settled (trimLast). A fixed climb, not relative
  // to the level's other lanes: those vary too, and the same lane should get a bit harder every level.
  const tuneLast = lvl.fv >= 4 && !lvl.finale && nb === 1 && last >= 4;
  // a lane's risk: the share of time a spot in it (every unit along between its corner squares, 5 across) is touched by one of the plan's wolves,
  // over RISK_SECS (their poses straight from their timing; no goal-room wolves, none turning round in the open)
  const HITR = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE, HITR2 = HITR * HITR, RISK_SECS = 20, RISK_DT = 0.25;
  const laneRisk = (pl) => {
    const leg = legs[pl.leg], f = frameOf(leg), ws = [];
    for (const sg of pl.segs) for (const w of sg.wolves) {
      if (/^room-/.test(sg.name || '') || endsInOpen({ ...w, leg: pl.leg, pattern: sg.name })) continue;
      const plan = buildPlan(w, f, w.speed), ph = (((w.off % w.cycle) + w.cycle) % w.cycle) / w.cycle;
      ws.push({ plan, t0: ph * plan.cycle });
    }
    const spots = [];
    for (let th = W / 2 + 0.5; th < leg.len - W / 2 - 0.5; th += 1) for (const r of [-3.6, -1.8, 0, 1.8, 3.6]) spots.push(r, th);   // (between its corners)
    const n = spots.length / 2;
    if (!n) return 0;
    const pos = new Float64Array(ws.length * 2);
    let hits = 0, samples = 0;
    for (let t = 0; t < RISK_SECS; t += RISK_DT) {
      ws.forEach((w, i) => { const q = patternPose(w.plan, (w.t0 + t) % w.plan.cycle); pos[i * 2] = q.r; pos[i * 2 + 1] = q.th; });
      for (let k = 0; k < n; k++) {
        const r = spots[k * 2], th = spots[k * 2 + 1];
        for (let i = 0; i < ws.length; i++) {
          const dr = pos[i * 2] - r, dt = pos[i * 2 + 1] - th;
          if (dr * dr + dt * dt < HITR2) { hits++; break; }
        }
      }
      samples += n;
    }
    return hits / samples;
  };
  const tuned = [];   // [plan, risk to aim at]
  // (trim: it gets trimmed later, so the least risky at or over the target, else the riskiest; otherwise the nearest)
  const pickNearest = (make, target, trim, fill) => {
    let best = null, bestRisk = 0;
    for (let k = 0; k < LAST_LANE_TRIES; k++) {
      const pl = make();
      if (!pl) continue;
      const rk = laneRisk(fill ? { ...pl, segs: [...pl.segs, ...fillCrossers(pl)] } : pl);   // (fill: as it'll be, with fillCrossers)
      const better = trim ? (rk >= target ? bestRisk < target || rk < bestRisk : rk > bestRisk) : Math.abs(rk - target) < Math.abs(bestRisk - target);
      if (!best || better) { best = pl; bestRisk = rk; }
    }
    return best;
  };
  // the final run keeps its own tuning (heat 1.2, D up to 1.6); levels 7-8 go past it
  const heat = lvl.finale ? Math.min(1.2, p.patternHeat || 0) : p.patternHeat || 0, dTop = lvl.finale ? 1.6 : 1.9;
  for (let li = 0; li < legs.length; li++) {
    const lesson = level === 1 && li < PAT_LESSONS.length;
    const D = lesson ? 0.1 * li : Math.min(dTop, heat + 0.5 * li / Math.max(1, last));
    if (li === door) {
      // final stretch: a full room on the beat of the room before it (its chargers run corner to corner, straight, like
      // everywhere else), plus the goal room's crossers and diagonals (roomWolves). On top of the level's wolf count.
      const prev = plans.length && plans[plans.length - 1].leg === li - 1 ? plans[plans.length - 1] : null;
      const makeDoor = () => placeLeg(li, legDesign(li, D, prev ? prev.beat : 0), makeChargers(li, D, chargerLanes(li, D)), false);
      const pl = tuneLast ? pickNearest(makeDoor, LAST_LANE_RISK(level, true), true) : makeDoor();
      if (pl) {
        // (finale version 4+: not the three on the far side of the disc, behind it from the door, which is always on the
        // near side: they guarded nothing. Still made first, so the rest of the level comes out the same.)
        const dc = lvl.corners[lvl.corners.length - 1];   // the door corner: "behind the disc" = the other side of the centre
        const behind = (sg) => sg.wolves.every((w) => w.route.every((q) => { const pt = legPoint(legs[door], q.r, q.th); return pt.x * dc.x + pt.z * dc.z < 0; }));
        for (const sg of roomWolves(pl.beat)) if (!(lvl.fv >= 4 && behind(sg))) pl.segs.push({ ...sg, top: 0, bottom: 0 });
        plans.push({ ...pl, finale: true });
        if (tuneLast) tuned.push([plans[plans.length - 1], LAST_LANE_RISK(level, true)]);
      }
      continue;
    }
    if (tuneLast && li === last - 1) {   // the lane before the final stretch (see pickNearest)
      const pl = pickNearest(() => placeLeg(li, legDesign(li, D, 0), makeChargers(li, D, chargerLanes(li, D)), lesson), LAST_LANE_RISK(level, false), lvl.fv < 5, lvl.fv >= 5);
      if (pl) { plans.push(pl); if (lvl.fv < 5) tuned.push([pl, LAST_LANE_RISK(level, false)]); }   // (version 5+: not trimmed, that only took its crossers)
      continue;
    }
    for (const off of bands) {
      const chargers = makeChargers(li, D, chargerLanes(li, D));
      const pl = placeLeg(li, legDesign(li, D, 0), chargers, lesson);
      if (!pl) continue;
      // chargers keep to their band's lanes; crossers and diagonals run wall to wall across every band (their routes
      // stretched across the whole width, at their own speed: a crossing takes nb times as long)
      if (nb > 1) for (const sg of pl.segs) for (const w of sg.wolves) {
        w.route = w.route.map((q) => ({ r: w.type === 'charger' ? q.r + off : q.r * wideOut / vOut, th: q.th }));
        finish(w, legs[li]);
      }
      plans.push(pl);
    }
  }

  // ---- wolf count: at most `target` (see PAT_WOLVES_L1; under it only through PAT_PACK_MAX). Not in level 1's lessons.
  // Finale version 7+ (skate levels): per lane instead (see perLane below), so every lane gets busier every level.
  const tamed = (pl) => pl.finale || (level === 1 && pl.leg < PAT_LESSONS.length);
  const perLane = lvl.fv >= 7 && !lvl.finale && nb === 1;
  let count = plans.filter((pl) => !pl.finale).reduce((a, pl) => a + pl.segs.reduce((b, sg) => b + sg.wolves.length, 0), 0);
  const packs = [];
  if (!perLane) for (const pl of plans) {
    const cs = tamed(pl) ? null : pl.segs.find((sg) => sg.chargers);
    if (cs) for (const lead of cs.wolves.slice()) packs.push({ cs, lead, n: 1, back: 0 });
  }
  while (count < target && packs.length) {
    const n = Math.min(...packs.map((pk) => pk.n));
    if (n >= PAT_PACK_MAX) break;
    const cand = packs.filter((pk) => pk.n === n), pk = cand[Math.floor(rng.next() * cand.length)];
    const w = { ...pk.lead, route: pk.lead.route.map((q) => ({ ...q })) };
    pk.back += rng.range(PAT_PACK_GAP, 2 * PAT_PACK_GAP);       // following the leader down its lane, loosely
    w.off = pk.lead.off - pk.back / pk.lead.speed;
    pk.cs.wolves.push(w); pk.n++; count++;
  }
  // over: the longest rows lose an end wolf (fewer wolves only widen the gaps), keeping their drifting share
  const trimEnd = (sg) => {
    const ws = sg.wolves, k = ws.length, drift = ws.filter((w) => w.drift).length;
    return [ws[k - 1], ws[0]].find((w) => drift - (w.drift ? 1 : 0) >= patRowNeed(k - 1));
  };
  // (trims the plans in pls while there are more than limit; returns how many are left)
  const trimTo = (pls, n, limit) => {
    while (n > limit) {
      let best = null;
      for (const pl of pls) for (const sg of pl.segs) {
        if (!sg.chargers && sg.name !== 'diagonal-scissors' && sg.wolves.length > 2 && trimEnd(sg) && (!best || sg.wolves.length > best.wolves.length)) best = sg;
      }
      if (best) { best.wolves.splice(best.wolves.indexOf(trimEnd(best)), 1); n--; continue; }
      // ...then lone crossers go, at random
      const lone = pls.flatMap((pl) => pl.segs.filter((sg) => sg.name === 'crosswalk-single').map((sg) => [pl, sg]));
      if (!lone.length) break;
      const [pl, sg] = lone[Math.floor(rng.next() * lone.length)];
      pl.segs.splice(pl.segs.indexOf(sg), 1); n--;
    }
    return n;
  };
  if (!perLane) count = trimTo(plans.filter((pl) => !tamed(pl)), count, target);
  else {
    // finale version 7+: each lane gets its share of the target by length (wolves were spread evenly, ~0.4 per unit),
    // so every lane gets busier every level with it (+10%). Over: trimmed as above, within the lane. Under (levels 7-8
    // never reached their target): wall-to-wall white crossers in its biggest gaps (gapCrossers). Not level 1's
    // lessons, nor the lane before the last one (tuned for its risk, filled by fillCrossers).
    const sumLen = legs.reduce((a, g, i) => a + (i === door ? 0 : g.len), 0);
    for (const pl of plans) {
      if (tamed(pl) || (tuneLast && pl.leg === door - 1)) continue;
      const quota = Math.floor(target * legs[pl.leg].len / sumLen);   // (rounded down: rounding to nearest left the shortest lane level 1 = level 2)
      const n = trimTo([pl], pl.segs.reduce((b, sg) => b + sg.wolves.length, 0), quota);
      if (n < quota) pl.segs.push(...gapCrossers(pl, quota - n));
    }
  }

  // the last two lanes (tuneLast) down to their risk: the same trims (longest rows' end wolves, then lone crossers), one
  // at a time, each kept if it doesn't take the lane further from it (a row that doesn't help is left alone after that)
  for (const [pl, target] of tuned) {
    let rk = laneRisk(pl);
    const done = new Set();
    while (rk > target) {
      let sg = null;
      for (const s of pl.segs) if (!done.has(s) && !/^room-/.test(s.name || '') && !s.chargers && s.name !== 'diagonal-scissors' && s.wolves.length > 2 && trimEnd(s) && (!sg || s.wolves.length > sg.wolves.length)) sg = s;
      const lone = pl.segs.filter((s) => !done.has(s) && s.name === 'crosswalk-single');
      let undo;
      if (sg) { const w = trimEnd(sg), i = sg.wolves.indexOf(w); sg.wolves.splice(i, 1); undo = () => { sg.wolves.splice(i, 0, w); done.add(sg); }; }
      else if (lone.length) { const s = lone[Math.floor(rng.next() * lone.length)], i = pl.segs.indexOf(s); pl.segs.splice(i, 1); undo = () => { pl.segs.splice(i, 0, s); done.add(s); }; }
      else break;
      const nr = laneRisk(pl);
      if (Math.abs(nr - target) > Math.abs(rk - target)) undo();
      else rk = nr;
    }
  }

  // the doorway's white crossers (doorWolves), once the last lane's own are settled
  const doorPlan = plans.find((pl) => pl.finale && pl.leg === door);
  if (doorPlan && lvl.fv >= 5 && !lvl.finale) for (const sg of doorWolves(doorPlan.beat, doorPlan.segs)) doorPlan.segs.push({ ...sg, top: 0, bottom: 0 });
  const beforePlan = plans.find((pl) => pl.leg === door - 1);
  if (beforePlan && doorPlan && lvl.fv >= 5 && !lvl.finale && nb === 1) beforePlan.segs.push(...fillCrossers(beforePlan));
  if (doorPlan && lvl.fv >= 5 && !lvl.finale && nb === 1) doorPlan.segs.push(...junctionWolves(doorPlan.beat));
  if (doorPlan && lvl.fv >= 6 && !lvl.finale && nb === 1) {
    doorPlan.segs = doorPlan.segs.filter((sg) => !/^diagonal/.test(sg.name || ''));   // (the goal room's own diagonal stays)
    doorPlan.segs.push(...junctionChargers(doorPlan));
  }

  // version 7+: no wolf runs faster than KIND_TOP x the base speed of its colour in its lane (the median: drifting ones
  // and the odd long route ran up to 2x the rest). Slower ones stay as they are.
  const kindBase = new Map();
  if (lvl.fv >= 7 && !lvl.finale) for (const pl of plans) {
    const by = {};
    for (const sg of pl.segs) for (const w of sg.wolves) if (!endsInOpen({ ...w, leg: pl.leg, pattern: sg.name })) (by[w.type] ||= []).push(w.speed);   // (the wolves that stay)
    for (const [t, v] of Object.entries(by)) { v.sort((a, b) => a - b); kindBase.set(pl.leg + ':' + t, v[Math.floor(v.length / 2)]); }
  }
  const banded = (leg, w) => {
    const b = kindBase.get(leg + ':' + w.type);
    return b ? Math.min(KIND_TOP * b, w.speed) : w.speed;
  };
  // ---- specs (a drifting wolf keeps its phase in the beat: at level start it is exactly in step)
  for (const pl of plans) {
    for (const seg of pl.segs) for (const w of seg.wolves) {
      if (endsInOpen({ ...w, leg: pl.leg, pattern: seg.name })) continue;
      const id = enemies.length;
      enemies.push({
        id, type: w.type, leg: pl.leg, frame: w.frame,
        rIn: w.rMin, rOut: w.rMax, a0: w.thMin, a1: w.thMax,
        speed: banded(pl.leg, w),
        phase: Math.round((((w.off % w.cycle) + w.cycle) % w.cycle) / w.cycle * 1e9) / 1e9,
        seed: hashSeed(seed, level, 'wolf', id),
        route: w.route, loop: !!w.loop,
        pattern: seg.name,
        ...(pl.finale ? { finalStretch: true } : {}),   // the final stretch: on top of the level's count, may leave its leg
      });
    }
  }
  // the wide corridor: at least one crosser in every slot along the corridor (WIDE_ROW apart: a wolf's width). A slot
  // without one gets a lone crosser, wall to wall at about the usual crosser speed of its room, each starting
  // somewhere random along its crossing (so they never line up)
  if (nb > 1) {
    const WIDE_ROW = 2 * CFG.WOLF_RADIUS, WIDE_EXTRA = 0.15;
    legs.forEach((leg, li) => {
      const mine = enemies.filter((e) => e.leg === li && e.type === 'crosser');
      const speeds = mine.map((e) => e.speed).sort((a, b) => a - b);
      const v0 = speeds.length ? speeds[speeds.length >> 1] : 3.5;
      const { lo, hi } = ranges[li];
      // every gap between neighbouring crossers (and the room's ends) wider than a wolf gets evenly spaced new ones
      const at = [lo - WIDE_ROW / 2, ...mine.map((e) => e.route[0].th).sort((a, b) => a - b), hi + WIDE_ROW / 2], fill = [];
      for (let i = 1; i < at.length; i++) {
        const g = at[i] - at[i - 1], n = Math.ceil(g / WIDE_ROW - 1e-6) - 1;
        for (let k = 1; k <= n; k++) fill.push(at[i - 1] + g * k / (n + 1));
      }
      // ...and WIDE_EXTRA more on top, anywhere in the room
      const extra = Math.round(WIDE_EXTRA * (mine.length + fill.length));
      for (let k = 0; k < extra; k++) fill.push(rng.range(lo, hi));
      for (const th of fill) {
        const s = rng.chance(0.5) ? 1 : -1, id = enemies.length;
        const route = [{ r: -s * wideOut, th }, { r: s * wideOut, th }];
        enemies.push({
          id, type: 'crosser', leg: li, frame: frameOf(leg),
          rIn: -wideOut, rOut: wideOut, a0: th, a1: th,
          speed: Math.min(PAT_VMAX, v0 * rng.range(0.85, 1.15)),
          phase: Math.round(rng.next() * 1e9) / 1e9,
          seed: hashSeed(seed, level, 'wolf', id),
          route, loop: false,
          pattern: 'crosswalk-single',
        });
      }
    });
  }
  // the wide corridor's last WIDE_RUN_S seconds of skating before the goal room: Run only's wolves instead (like Run
  // only's level 9, at WIDE_RUN_DENSITY of its density). Skate wolves stay out: crossers / diagonals in it go, a charger
  // running into it stops at its edge.
  if (nb > 1 && lvl.finale) {
    const WIDE_RUN_DENSITY = 0.8, WIDE_RUN_CLEAR = 2 * CFG.WOLF_RADIUS + 0.5;
    const WIDE_RUN_SPEED = 0.7;   // of a running level's wolf speed: slower, you're on skates
    const dir = -Math.sign(legs[0].ux), xDoor = -dir * ROOM;   // the way the run heads along x; the goal room's door
    const xB = xDoor - dir * WIDE_RUN_S * CFG.KITTY_SPEED;                               // where the stretch begins
    const inside = (x) => dir * (x - xB) > 0;
    const wx = (e, th) => e.frame.ox + e.frame.ux * th;
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (!e.route || !e.route.some((q) => inside(wx(e, q.th)))) continue;
      const thB = (xB - e.frame.ox) / e.frame.ux;
      if (e.type === 'charger') {
        e.route = e.route.map((q) => (inside(wx(e, q.th)) ? { r: q.r, th: thB } : q));
        e.a0 = Math.min(...e.route.map((q) => q.th)); e.a1 = Math.max(...e.route.map((q) => q.th));
        if (e.a1 - e.a0 > 3) continue;
      }
      enemies.splice(i, 1);
    }
    // the run wolves: spread evenly along the stretch (in whichever rooms it covers), each roaming wall to wall over a
    // stretch of its own inside it, with Run only's level 9 behaviour. Along a leg th grows toward the start, so the
    // stretch is th < thIn (its edge) in every leg's frame
    // ...and never onto the skate wolves' paths: they start WIDE_RUN_CLEAR past the furthest any skate wolf still reaches
    let reach = -Infinity;
    for (const e of enemies) if (e.route) for (const q of e.route) reach = Math.max(reach, dir * wx(e, q.th));
    const xRun = dir * reach + dir * WIDE_RUN_CLEAR;
    const lv = RUN_PAUSES.length, walk = RUN_WALKS[lv - 1];
    const pauseRange = lvl.fv >= STRETCH_REST_FV ? restAtLeast(RUN_PAUSES[lv - 1]) : RUN_PAUSES[lv - 1];   // (version 21+: STRETCH_REST_MIN)
    const len = WIDE_RUN_S * CFG.KITTY_SPEED, runDensity = RUN_FINALE_WOLVES / (Math.abs(lvl.corners[0].x - xDoor) * lvl.corridorWidth);
    const n = Math.round(len * lvl.corridorWidth * runDensity * WIDE_RUN_DENSITY);
    for (let k = 0; k < n; k++) {
      const x = xRun + dir * (k + 0.5 + rng.range(-0.3, 0.3)) / n * Math.abs(xDoor - xRun);   // from past the gap to the door
      const li = legs.findIndex((l, j) => { const th = (x - l.ox) / l.ux; return th >= ranges[j].lo && th <= ranges[j].hi; });
      if (li < 0) continue;
      const leg = legs[li], th = (x - leg.ox) / leg.ux, thIn = (xRun - leg.ox) / leg.ux, span = rng.range(10, 18);
      const a1 = Math.min(thIn, th + span / 2, ranges[li].hi), a0 = Math.max(ranges[li].lo, Math.min(th - span / 2, a1 - 2.5));
      if (a1 - a0 < 2.5) continue;
      const id = enemies.length;
      enemies.push({
        id, type: 'wanderer', leg: li, frame: frameOf(leg),
        rIn: -wideOut, rOut: wideOut, a0, a1,
        speed: Math.min(CFG.KITTY_SPEED * 0.92, p.enemySpeed) * WIDE_RUN_SPEED, phase: rng.next(),
        pauseScale: p.enemyPauseScale * 0.7,
        seed: hashSeed(seed, level, 'wolf', id),
        pauseRange, walk, lateral: true, wallShare: RUN_FINALE_WALL,
      });
    }
    enemies.forEach((e, i) => { e.id = i; e.seed = hashSeed(seed, level, 'wolf', i); });
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // Skate only, per leg (for tests / tooling): its beat, the period it repeats with (n beats if some wolves drift),
  // the lanes no charger runs in; finale = the door of the final stretch
  lvl.patternPlan = plans.map((pl) => ({
    leg: pl.leg, beat: pl.beat, period: r3(pl.period || pl.beat), finale: !!pl.finale,
    lanes: pl.finale ? undefined : PAT_LANES.filter((_, k) => pl.open[k]),
    segs: pl.segs.map((sg) => ({ name: sg.name, top: r3(sg.top), bottom: r3(sg.bottom), n: sg.wolves.length })),
  }));
  return enemies;
}


// Finale version 11+: n items with at most cap.life hearts and cap.shield shields (once both are used up, the rest are
// boots; boots: false keeps them out, e.g. autumn levels, where every tree already has a pair). Same spots as placeItems.
const ITEMS_PER_LEVEL = 8, ITEMS_AUTUMN = 4, ITEM_CAP = { life: 2, shield: 3 };
// inside (finale version 23+): never a spot walled off from its lane (the final runs' wide corridor beside their
// narrower rooms: nothing to collide with out there, but no way in either), the line from it to the lane's middle clear
function placeItemsCapped(rng, lvl, n, cap, boots = true, inside = false) {
  const { legs, spawnPoints } = lvl;
  const W = lvl.corridorWidth;
  const items = [], used = { life: 0, shield: 0 };
  const walledOff = (leg, lat, along) => {
    const steps = Math.ceil(Math.abs(lat) / 0.25);
    for (let k = 1; k < steps; k++) { const p = legPoint(leg, lat * (1 - k / steps), along); if (collideCircle(lvl, p.x, p.z, 0.15).hit) return true; }
    return false;
  };
  const okSpot = (x, z) => {
    for (const s of spawnPoints) if (hyp(s.x - x, s.z - z) < 4) return false;
    for (const t of items) if (hyp(t.x - x, t.z - z) < 6) return false;
    if (collideCircle(lvl, x, z, CFG.ITEM_RADIUS + 0.15).hit) return false;
    for (const t of lvl.trees || []) if (hyp(t.x - x, t.z - z) < CFG.TREE_RADIUS + 1) return false;
    for (const t of lvl.piles || []) if (hyp(t.x - x, t.z - z) < CFG.PILE_RADIUS + 1) return false;   // (not hidden in a pile)
    return true;
  };
  for (let k = 0; k < n; k++) {
    const pool = [['boots', boots ? 5 : 0], ['life', used.life < cap.life ? 2 : 0], ['shield', used.shield < cap.shield ? 3 : 0]];
    const type = pool.some((t) => t[1] > 0) ? pickWeighted(rng, pool, (t) => t[1])[0] : 'boots';
    for (let s = 0; s < 40; s++) {
      const leg = pickWeighted(rng, legs, (l) => l.len);
      const along = rng.range(0, leg.len), lat = rng.range(-W / 2 + 1.2, W / 2 - 1.2);
      const { x, z } = legPoint(leg, lat, along);
      if (!okSpot(x, z) || (inside && walledOff(leg, lat, along))) continue;
      items.push({ type, x, z });
      if (type in used) used[type]++;
      break;
    }
  }
  return items;
}
// version 11+: the tree up the middle of a level 9 holds a big pair of boots worth four (full speed at once)
const treeBoots = (trees, mega) => trees.map((t) => ({ type: 'boots', x: t.x, z: t.z, tree: true, ...(mega ? { mega: true } : {}) }));

function placeItems(rng, lvl, p) {
  const { legs, spawnPoints } = lvl;
  const W = lvl.corridorWidth;
  const items = [];
  const okSpot = (x, z) => {
    for (const s of spawnPoints) if (hyp(s.x - x, s.z - z) < 4) return false;
    for (const t of items) if (hyp(t.x - x, t.z - z) < 6) return false;
    if (collideCircle(lvl, x, z, CFG.ITEM_RADIUS + 0.15).hit) return false;
    for (const t of lvl.trees || []) if (hyp(t.x - x, t.z - z) < CFG.TREE_RADIUS + 1) return false; // not hidden under a canopy
    for (const t of lvl.piles || []) if (hyp(t.x - x, t.z - z) < CFG.PILE_RADIUS + 1) return false;   // (not hidden in a pile)
    return true;
  };
  const types = [['boots', 5], ['life', 2], ['shield', 3]];
  for (let n = 0; n < p.itemCount; n++) {
    const type = pickWeighted(rng, types, (t) => t[1])[0];
    for (let s = 0; s < 40; s++) {
      const leg = pickWeighted(rng, legs, (l) => l.len);
      const along = rng.range(0, leg.len), lat = rng.range(-W / 2 + 1.2, W / 2 - 1.2);
      const { x, z } = legPoint(leg, lat, along);
      if (!okSpot(x, z)) continue;
      items.push({ id: items.length, type, x, z });
      break;
    }
  }
  return items;
}

// Every level but the final run: two safe squares are checkpoints (see sim.js): the one nearest 1/3 of the way along
// the path, and the fifth safe square before the end. Each faces down the leg that leaves it (legs[i] runs from corner i+1 at s=0 to corner i).
function pickCheckpoints(corners, legs, nSafe) {
  const cum = [0];
  for (let i = 1; i < corners.length; i++) cum.push(cum[i - 1] + hyp(corners[i].x - corners[i - 1].x, corners[i].z - corners[i - 1].z));
  const total = cum[cum.length - 1];
  const late = nSafe - 5;          // fifth safe square before the end
  let third = 1;
  for (let i = 1; i < late; i++) if (Math.abs(cum[i] - total / 3) < Math.abs(cum[third] - total / 3)) third = i;
  return [third, late].map((i) => ({ corner: i, x: corners[i].x, z: corners[i].z, heading: Math.atan2(-legs[i].uz, -legs[i].ux) })); // run direction is -u
}

// Autumn levels: one climbable tree per lane (not the final stretch), somewhere in the middle of the leg,
// off to one side. A kitty under its canopy (within CFG.TREE_RADIUS) has climbed up and wolves can't reach it.
function placeTrees(rng, legs) {
  const W = CFG.RING_WIDTH;
  const lat = W / 2 - CFG.WALL_THICKNESS / 2 - CFG.TREE_RADIUS - 0.4; // keep the canopy off the walls
  const trees = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const l = legs[i];
    if (l.len < 2 * W) continue;
    const s = rng.range(W, l.len - W), v = rng.range(-lat, lat);
    trees.push({ ...legPoint(l, v, s), leg: i });
  }
  return trees;
}

// Fall and winter levels on foot (version 25+): a leaf (fall) or snow (winter) pile on a third of the lanes (rounded), one a
// lane (not the final stretch), somewhere in the middle of the leg, off to one side. A kitty in it (within
// CFG.PILE_RADIUS of its middle) is hidden and wolves can't reach it.
function placePiles(rng, legs, kind) {
  const W = CFG.RING_WIDTH;
  const lat = W / 2 - CFG.WALL_THICKNESS / 2 - CFG.PILE_RADIUS - 0.4;   // keep the pile off the walls
  const open = [];
  for (let i = 0; i < legs.length - 1; i++) if (legs[i].len >= 2 * W) open.push(i);
  for (let i = open.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [open[i], open[j]] = [open[j], open[i]]; }
  return open.slice(0, Math.round(open.length / 3)).sort((a, b) => a - b).map((i) => {
    const l = legs[i], s = rng.range(W, l.len - W), v = rng.range(-lat, lat);
    return { ...legPoint(l, v, s), leg: i, kind };
  });
}

function inPile(levelData, x, z) {
  const t = levelData.piles;
  if (!t || !t.length) return false;
  const r2 = CFG.PILE_RADIUS * CFG.PILE_RADIUS;
  for (let i = 0; i < t.length; i++) {
    const dx = x - t[i].x, dz = z - t[i].z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function inTree(levelData, x, z) {
  const t = levelData.trees;
  if (!t || !t.length) return false;
  const r2 = CFG.TREE_RADIUS * CFG.TREE_RADIUS;
  for (let i = 0; i < t.length; i++) {
    const dx = x - t[i].x, dz = z - t[i].z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

// ---------------------------------------------------------------- generation

// mode: 'mixed' (default: level 2 of every 4 is the ice rink), 'run' (no ice, original theme order), 'ice' (every level is ice)
// true = the old Run + Skate winter levels (ice + wandering wolves) instead of Skate only's pattern wolves
const CLASSIC_RUN_SKATE_ICE = false;

// ---------------------------------------------------------------- Run + Skate's level 9 (finale version 3)
//
// The two final runs in one level, as a U: first the wide skate final run (its own coordinates moved down and to the
// right: it runs left to right below the other), then, where its goal room would be, a short hallway up into Run
// only's start room, and the run on foot back right to left to the goal room (cat heaven, at the origin as always).
// Each half is generated exactly as on its own (seeds of their own); the skate half loses its goal room.
// levelData.sections keeps both halves as built (with their offset) for the set dressing (world.js).
const COMBO_GAP = 6;   // between the two corridors' walls (room for the braziers outside them)
const MEDIC_RESCUES = 60;   // revives this run that repair the broken checkpoint (= the wings)
const COMBO_RUN_SPEED0 = 0.7;   // the run half's wolf speed at its start (of their usual), rising to 1 at the goal room
// finale version 15+: the running final run's wolves (Run only's level 9 and Run + Skate's running half) only get up to
// this at the goal room (of their usual), from COMBO_RUN_SPEED0 after the start room
const RUN_RAMP_TOP = 0.92;
function generateCombo(L, seed, v = 3) {
  const sk = generateLevel(L, hashSeed(seed, L, 'combo-skate'), 'mixed', 2);
  const rn = generateLevel(L, hashSeed(seed, L, 'combo-run'), 'run', 1);
  const W = rn.corridorWidth, h = W / 2, sH = rn.safeSize / 2;
  const rs = rn.corners[0], xr0 = rs.x - sH, xr1 = rs.x + sH;   // the run's start room: its opening / back wall
  const dx = xr1 + ROOM, dz = -(2 * h + COMBO_GAP);              // skate -> combo: its corridor ends at the room's back
  const mv = (o) => ({ ...o, x: o.x + dx, z: o.z + dz });
  const mvW = (w) => ({ ax: w.ax + dx, az: w.az + dz, bx: w.bx + dx, bz: w.bz + dz });
  // skate walls without its goal room (3-7); its near wall (1) stops at the hallway
  const skW = sk.walls.filter((_, i) => i < 3 || i > 7).map(mvW);
  skW[1].ax = xr0;
  // run walls without its start room's bottom side (the hallway comes in there)
  // (only the start room's: the goal room's back wall is at the same z, both rooms being ROOM wide)
  const rnW = rn.walls.filter((w) => !(Math.abs(w.az + sH) < 1e-6 && Math.abs(w.bz + sH) < 1e-6 && Math.min(w.ax, w.bx) >= xr0 - 1e-6));
  const walls = [...rnW, ...skW,
    { ax: xr1, az: dz - h, bx: xr1, bz: -sH },   // the skate corridor's end and the hallway's right side
    { ax: xr0, az: -h, bx: xr0, bz: dz + h },    // the hallway's left side
  ];
  const nS = sk.legs.length;
  const legs = [
    ...sk.legs.map((l, i) => ({ ...l, ox: l.ox + dx, oz: l.oz + dz, ice: true, startRoom: i === 0 ? sH : 0, endLeg: i === nS - 1 })),
    ...rn.legs.map((l, i) => ({ ...l, startRoom: i === 0 ? sH : 0 })),
  ];
  const enemies = [
    ...sk.enemies.map((e) => ({ ...e, frame: { ...e.frame, ox: e.frame.ox + dx, oz: e.frame.oz + dz },
      ...(v >= STRETCH_REST_FV && e.pauseRange ? { pauseRange: restAtLeast(e.pauseRange) } : {}) })),   // (version 21+: its run stretch's rests, STRETCH_REST_MIN)
    // the run half's wolves start as slow as the skate half's run wolves (COMBO_RUN_SPEED0 of their speed, right after
    // the hallway) and get evenly faster all the way to the goal room, where they're back at full speed
    ...rn.enemies.map((e) => {
      const x = e.frame.ox + e.frame.ux * (e.a0 + e.a1) / 2, k = Math.max(0, Math.min(1, (rs.x - x) / (rs.x - ROOM)));
      return { ...e, leg: e.leg + nS, speed: e.speed * (COMBO_RUN_SPEED0 + ((v >= RUN_RAMP_FV ? RUN_RAMP_TOP : 1) - COMBO_RUN_SPEED0) * k),
        ...(v >= STRETCH_REST_FV && e.pauseRange ? { pauseRange: restAtLeast(e.pauseRange, runFinaleRestMin(v)) } : {}),   // (version 21+: as Run only's level 9)
        ...(v >= EVEN_WALKS_FV && e.walk ? { walk: RUN_WALKS_EVEN[RUN_WALKS.length - 1] } : {}),   // (version 23+: level 8's even walks, as Run only's level 9)
        ...(v >= WALL_BAND_FV && e.lateral ? { wallBand: RUN_FINALE_BAND } : {}) };   // (version 24+: wall stops up to 0.7 out, as Run only's level 9)
    }),
  ];
  enemies.forEach((e, i) => { e.id = i; e.seed = hashSeed(seed, L, 'wolf', i); });
  // (version 11+: ITEMS_PER_LEVEL per half, at most ITEM_CAP.life hearts each and ITEM_CAP.shield shields in all, and
  // the trees' big boots)
  let items = [...sk.items.map(mv), ...rn.items];
  if (v >= 11) {
    const a = placeItemsCapped(createRng(hashSeed(seed, L, 'items-skate')), sk, ITEMS_PER_LEVEL, ITEM_CAP, true, v >= ITEMS_INSIDE_FV);
    const left = ITEM_CAP.shield - a.filter((it) => it.type === 'shield').length;
    const b = placeItemsCapped(createRng(hashSeed(seed, L, 'items-run')), rn, ITEMS_PER_LEVEL, { life: ITEM_CAP.life, shield: left }, true, v >= ITEMS_INSIDE_FV);
    // finale version 21+: a heart in each half (one of its pickups when it rolled none; at most ITEM_CAP.life each still)
    if (v >= HALF_HEART_FV) { guaranteeHeart({ items: a, level: L }, hashSeed(seed, 'skate-half')); guaranteeHeart({ items: b, level: L }, hashSeed(seed, 'run-half')); }
    items = [...a.map(mv), ...treeBoots(sk.trees, true).map(mv), ...b, ...treeBoots(rn.trees, true)];
  }
  items.forEach((it, i) => { it.id = i; });
  const skPath = sk.path.filter((q) => q.x <= -ROOM).map(mv);
  const lvl = {
    ...rn,
    seed, level: L, mode: 'mixed',
    walls, wallSegments: walls, legs,
    corners: [...sk.corners.map(mv), ...rn.corners],
    safeCorners: [mv(sk.safeCorners[0]), rn.safeCorners[0]],
    startAngle: sk.startAngle,
    spawnPoints: sk.spawnPoints.map(mv),
    enemies, items,
    path: [...skPath, { x: rs.x, z: dz + h }, { x: rs.x, z: 0 }, ...rn.path],
    theme: sk.theme,
    ice: true, iceZMax: dz + h,   // ice only in the skate corridor (below its near wall)
    finale: true, finaleSide: 0, combo: true,
    trees: [...sk.trees.map((t) => ({ ...mv(t), leg: t.leg, snowy: true })), ...rn.trees.map((t) => ({ ...t, leg: t.leg + nS, snowy: false }))],
    runLength: sk.runLength + rn.runLength,
    outerRadius: Math.max(rn.outerRadius, Math.abs(sk.corners[0].x + dx) + h, Math.abs(dz) + h) + 2,
    // the run half's start room: a broken checkpoint that only a kitty with MEDIC_RESCUES+ revives this run can repair
    // (then it works like any checkpoint: everyone back on their paws, gathered there). Finale version 16+: any kitty can
    checkpoints: [{ corner: sk.corners.length, x: rs.x, z: rs.z, heading: Math.atan2(-rn.legs[0].uz, -rn.legs[0].ux), medic: true, minRescues: v >= ANYONE_MEDIC_FV ? 0 : MEDIC_RESCUES, ...(v >= MEDIC_GIFT_FV ? { giftRescues: MEDIC_RESCUES } : {}) }],   // (giftRescues: sim.js)
    patternPlan: sk.patternPlan,
    extraFloors: [{ x0: xr0, x1: xr1, z0: dz + h, z1: -sH }],   // the hallway
    sections: [{ dx, dz, ld: { ...sk, noReward: true, endTrim: 2 * sH + 2 } }, { dx: 0, dz: 0, ld: rn }],
  };
  return lvl;
}

// fv: the finale version the game plays (sim.finales): 0 = the original levels, 1 = + Run only's level 9 final run,
// 2 = + the wide skate final run (Skate only / Run + Skate level 9), 3 = + Run + Skate's level 9 is both final runs in a row
// (generateCombo), 4 = + skate levels' goal rooms without their three wolves behind the disc. Online rooms use the newest
// every member has.
// Run + Skate's day / night steps (config.js stageOf): by day exactly Run only's level, by night exactly Skate only's
function generateLevel(level, seed, mode = 'mixed', fv = 0) {
  const ld = generateLevelStage(level, seed, mode, fv);
  if ((fv | 0) >= HEART_FV) guaranteeHeart(ld, seed);
  if ((fv | 0) >= SEASONS_FV) guaranteeShields(ld, seed);   // (after the heart: its shields come from boots, so the heart stays)
  return ld;
}
// version 25+: a fall or winter level (on foot or a rink, not a final run) with fewer shields than SEASON_SHIELDS (levels
// 1-4: the first round of the seasons, 2; levels 5-8: 1) gets them: some of its boots (not a tree's), picked by the
// level's seed, become shields in the same spots (never more than ITEM_CAP)
const SEASON_SHIELDS = (level) => (level <= 4 ? 2 : 1);
function guaranteeShields(ld, seed) {
  const items = ld && ld.items;
  if (!Array.isArray(items) || ld.finale || (ld.theme !== TREE_THEME && ld.theme !== ICE_THEME)) return;
  const pool = items.filter((it) => it.type === 'boots' && !it.tree && !it.mega);
  for (let k = items.filter((it) => it.type === 'shield').length, i = 0; k < SEASON_SHIELDS(ld.level || 1) && pool.length; k++, i++)
    pool.splice((hashSeed(seed, ld.level || 0, 'shield', i) >>> 0) % pool.length, 1)[0].type = 'shield';
}
function generateLevelStage(level, seed, mode, fv) {
  const st = stageOf(mode, fv, level);
  if (st.day) return generateLevelCore(st.level, seed, 'run', Math.min(fv, 11), null, fv);   // (fv: the game's own, for the walks)
  // (fv 14+: the night rink in the day half's season, Run only's order; otherwise the level is Skate only's exactly)
  if (st.night) return generateLevelCore(st.level, seed, 'ice', Math.min(fv, 12), (fv | 0) >= SAME_SEASON_FV ? THEME_ORDER[(st.level - 1) % 4] : null);
  return generateLevelCore(st.level, seed, mode, fv);
}
// version 19+: a level with no heart among its pickups gets one: one of its pickups (not a tree's boots), picked by the
// level's seed, becomes a heart, in the same spot (up to two hearts as before; a level that had some keeps them)
function guaranteeHeart(ld, seed) {
  const items = ld && ld.items;
  if (!Array.isArray(items) || items.some((it) => it.type === 'life')) return;
  const pool = items.filter((it) => !it.tree && !it.mega);
  if (pool.length) pool[(hashSeed(seed, ld.level || 0, 'heart') >>> 0) % pool.length].type = 'life';
}

// season: a theme to give an ice level in place of Skate only's own (Run + Skate's night halves; looks only)
// rules: the game's own finale version where fv is held lower to keep a level as it was (Run + Skate's day halves): what
// came after that doesn't change the layout (the running wolves' walks, EVEN_WALKS_FV)
function generateLevelCore(level, seed, mode = 'mixed', fv = 0, season = null, rules = fv) {
  const v = fv === true ? 1 : +fv || 0;
  if (v >= 3 && mode === 'mixed' && (Math.max(1, level | 0)) === SKATE_FINAL_LEVEL) return generateCombo(SKATE_FINAL_LEVEL, seed, v);
  const L = Math.max(1, level | 0);
  const p = levelParams(L);
  const rng = createRng(hashSeed(seed, L));
  const runFinale = v >= 1 && mode === 'run' && L === SKATE_FINAL_LEVEL;
  const finale = (FINAL_MODES.includes(mode) || runFinale) && L === SKATE_FINAL_LEVEL;
  const wide = runFinale || (finale && v >= 2);   // three lanes wide with a start room
  const straight = finale ? buildStraight(createRng(hashSeed(seed, L, 'straight')), runFinale ? 1 : -1, wide ? RUN_FINALE_W : CFG.RING_WIDTH, wide ? ROOM : 0,
    wide && !runFinale ? WIDE_RUN_EXTRA : 0) : null;
  const { walls, legs, corners, wallCorners, outer } = straight || buildSpiral();
  const path = finale ? buildStraightPath(corners) : buildPath(corners, legs);

  // spawn: 2x2 block in the start pocket, facing up the first leg
  const start = corners[0];
  const first = legs[0];
  const fx = -first.ux, fz = -first.uz;          // travel direction = back along the outermost arm
  const heading = Math.atan2(fz, fx);
  const spawnPoints = [];
  for (const [a, b] of [[0.9, -1.1], [0.9, 1.1], [-0.9, -1.1], [-0.9, 1.1]]) {
    spawnPoints.push({ x: start.x + fx * a + first.nx * b, z: start.z + fz * a + first.nz * b, heading });
  }

  const lvl = {
    level: L, seed,
    loops: Math.floor((ARMS - 4) / 4),
    corridorWidth: wide ? RUN_FINALE_W : CFG.RING_WIDTH,
    safeSize: wide ? 2 * ROOM : CFG.RING_WIDTH,   // a safe square's width (Run only's level 9: its start room, the goal room's size)
    centerRadius: CFG.CENTER_RADIUS,
    roomHalf: ROOM,
    outerRadius: outer,
    walls,
    wallSegments: walls,
    wallCorners,
    legs,
    corners,
    safeCorners: finale ? corners.slice(0, 1) : corners.slice(0, -2),   // wolf-free squares (not the two corners of the final stretch; the final run: just the start)
    startAngle: heading,
    spawnPoints,
    enemies: [],
    items: [],
    path,
    // (finale version 12+: Skate only's levels 1-8 go through the seasons from winter, as floodlit night levels)
    theme: !finale && mode === 'ice' && v >= 12 ? (season ?? SKATE_THEME_ORDER[(L - 1) % 4])
      : CFG.ICE_TEST || mode === 'ice' || finale ? ICE_THEME : mode === 'mixed' ? MIXED_THEME_ORDER[(L - 1) % 3] : THEME_ORDER[(L - 1) % 4], // run mode: winter just isn't ice
    mode,
    finale,
    finaleSide: finale ? straight.side : 0,   // the final run's corridor: -1 = in from the left (skate), 1 = from the right (run)
  };
  lvl.ice = mode !== 'run' && (lvl.theme === ICE_THEME || (mode === 'ice' && v >= 12));
  if (mode === 'ice' && v >= 12 && !finale) lvl.night = true;   // (world.js: the play area lit as by day, night beyond the walls)
  lvl.checkpoints = !finale ? pickCheckpoints(corners, legs, lvl.safeCorners.length) : [];
  // the crown: floats over the middle of the goal room (above the portal)
  lvl.crown = { x: 0, z: 0 };
  if (finale) {
    lvl.loops = 0;
    lvl.runLength = straight.length;              // start square center -> goal center
    const t = straight.tree, leg = legs.findIndex((l) => l.ox === t.x);
    lvl.trees = [{ x: t.x, z: t.z, leg }];
  } else {
    // (version 25+: the trees in spring instead of fall, and on foot a leaf pile in fall / a snow pile in winter on some
    // lanes; rules: the game's own version, Run + Skate's day halves hold fv lower)
    const seasons = (+rules || 0) >= SEASONS_FV;
    lvl.trees = lvl.theme === (seasons ? SPRING_THEME : TREE_THEME) && !lvl.ice ? placeTrees(createRng(hashSeed(seed, L, 'trees')), legs) : [];
    if (seasons && !lvl.ice && (lvl.theme === TREE_THEME || lvl.theme === ICE_THEME)) lvl.piles = placePiles(createRng(hashSeed(seed, L, 'piles')), legs, lvl.theme === TREE_THEME ? 'leaves' : 'snow');
  }
  // every ice level has pattern wolves (Run + Skate's winter levels = Skate only's wolves for that level number;
  // the boss run has them in every mode). CLASSIC_RUN_SKATE_ICE brings back the old Run + Skate winter levels:
  // ice with the wandering wolves of the running levels (placeEnemies). Git tag: classic-run-skate-ice.
  const pattern = (finale && lvl.ice) || (lvl.ice && !(CLASSIC_RUN_SKATE_ICE && mode === 'mixed'));   // Run only's level 9: wandering wolves
  lvl.fv = v;   // the finale version (see above), for the wolf placement
  lvl.rules = +rules || 0;
  lvl.enemies = pattern ? placePatternEnemies(rng, lvl, p) : placeEnemies(rng, lvl, p);
  // finale version 15+: Run only's level 9 wolves at COMBO_RUN_SPEED0 of their speed after the start room, evenly faster
  // up to RUN_RAMP_TOP at the goal room, as in Run + Skate's running half (generateCombo)
  if (runFinale && v >= RUN_RAMP_FV) {
    const rs = corners[0];
    lvl.enemies = lvl.enemies.map((e) => {
      const x = e.frame.ox + e.frame.ux * (e.a0 + e.a1) / 2, k = Math.max(0, Math.min(1, (rs.x - x) / (rs.x - ROOM)));
      return { ...e, speed: e.speed * (COMBO_RUN_SPEED0 + (RUN_RAMP_TOP - COMBO_RUN_SPEED0) * k) };
    });
  }
  // finale version 18+: Run only's level 9 wolves start with one of their usual rests (enemies.js quickStart), not up to 6 s
  if (runFinale && v >= QUICK_START_FV) lvl.enemies = lvl.enemies.map((e) => (e.pauseRange ? { ...e, quickStart: true } : e));
  // finale version 21+: its new-behaviour wolves rest at least runFinaleRestMin (the original-behaviour ones as they were)
  if (runFinale && v >= STRETCH_REST_FV) lvl.enemies = lvl.enemies.map((e) => (e.pauseRange ? { ...e, pauseRange: restAtLeast(e.pauseRange, runFinaleRestMin(v)) } : e));
  if (v >= 11) {
    // version 11+: ITEMS_PER_LEVEL items (autumn: ITEMS_AUTUMN, hearts and shields only: every tree has boots), capped
    const autumn = lvl.trees.length > 0 && !finale;
    lvl.items = [...placeItemsCapped(createRng(hashSeed(seed, L, 'items')), lvl, autumn ? ITEMS_AUTUMN : ITEMS_PER_LEVEL, ITEM_CAP, !autumn, lvl.rules >= ITEMS_INSIDE_FV), ...treeBoots(lvl.trees, finale)]
      .map((it, i) => ({ id: i, ...it }));
  } else {
    lvl.items = placeItems(rng, lvl, p);
    for (const t of lvl.trees) lvl.items.push({ id: lvl.items.length, type: 'boots', x: t.x, z: t.z, tree: true }); // a pair of boots up every tree
  }
  return lvl;
}

// ---------------------------------------------------------------- collision

const gridCache = new WeakMap();

function getGrid(ld) {
  let g = gridCache.get(ld);
  if (g && g.src === ld.wallSegments) return g;
  const segs = ld.wallSegments;
  const n = segs.length;
  const data = new Float64Array(n * 4);
  for (let k = 0; k < n; k++) {
    const s = segs[k];
    data[k * 4] = s.ax; data[k * 4 + 1] = s.az; data[k * 4 + 2] = s.bx; data[k * 4 + 3] = s.bz;
  }
  const ext = (ld.outerRadius || 0) + 3;
  const dim = Math.max(1, Math.ceil((2 * ext) / GRID_CELL));
  const cells = new Array(dim * dim);
  for (let c = 0; c < cells.length; c++) cells[c] = [];
  const E = HALF_T + GRID_MAX_R + 0.01;
  const toCell = (v) => Math.min(dim - 1, Math.max(0, Math.floor((v + ext) / GRID_CELL)));
  for (let k = 0; k < n; k++) {
    const ax = data[k * 4], az = data[k * 4 + 1], bx = data[k * 4 + 2], bz = data[k * 4 + 3];
    const cx0 = toCell(Math.min(ax, bx) - E), cx1 = toCell(Math.max(ax, bx) + E);
    const cz0 = toCell(Math.min(az, bz) - E), cz1 = toCell(Math.max(az, bz) + E);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) cells[cz * dim + cx].push(k);
  }
  const all = [];
  for (let k = 0; k < n; k++) all.push(k);
  g = { src: segs, data, cells, dim, ext, all };
  gridCache.set(ld, g);
  return g;
}

function collideCircle(levelData, x, z, radius) {
  const g = getGrid(levelData);
  const d = g.data;
  const minD = radius + HALF_T;
  const minD2 = minD * minD;
  let hit = false;
  for (let pass = 0; pass < 3; pass++) {
    let list;
    if (radius <= GRID_MAX_R) {
      const cx = Math.floor((x + g.ext) / GRID_CELL), cz = Math.floor((z + g.ext) / GRID_CELL);
      list = (cx < 0 || cz < 0 || cx >= g.dim || cz >= g.dim) ? null : g.cells[cz * g.dim + cx];
      if (!list) list = g.all;
    } else list = g.all;
    let moved = false;
    for (let m = 0; m < list.length; m++) {
      const k = list[m] * 4;
      const ax = d[k], az = d[k + 1], bx = d[k + 2], bz = d[k + 3];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + ex * t, pz = az + ez * t;
      const dx = x - px, dz = z - pz;
      const dd = dx * dx + dz * dz;
      if (dd >= minD2) continue;
      const dl = Math.sqrt(dd);
      let nx, nz;
      if (dl > 1e-9) { nx = dx / dl; nz = dz / dl; }
      else {
        const el = Math.sqrt(len2) || 1;
        nx = -ez / el; nz = ex / el;
        if (nx * px + nz * pz > 0) { nx = -nx; nz = -nz; } // degenerate: prefer pushing inward
      }
      x = px + nx * minD; z = pz + nz * minD;
      hit = true; moved = true;
    }
    if (!moved) break;
  }
  return { x, z, hit };
}


// Which corridor leg (index into levelData.legs) a point is in; -1 = goal room, -2 = outside.
function locate(levelData, x, z) {
  const W = levelData.corridorWidth;
  const rh = levelData.roomHalf;
  if (Math.abs(x) < rh && Math.abs(z) < rh) return { leg: -1, s: 0, v: 0 };
  const legs = levelData.legs;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    const dx = x - l.ox, dz = z - l.oz;
    const s = dx * l.ux + dz * l.uz, v = dx * l.nx + dz * l.nz;
    if (s >= -W / 2 && s <= l.len + W / 2 && Math.abs(v) <= W / 2) return { leg: i, s, v };
  }
  return { leg: -2, s: 0, v: 0 };
}

// Ice level: everything except the safe corner squares is ice, the goal room too (all but the goal disc). The final
// run's goal room (the warm reward room) isn't.
function onIce(levelData, x, z) {
  if (!levelData.ice) return false;
  if (levelData.iceZMax != null && z > levelData.iceZMax) return false;   // Run + Skate's level 9: the run half is solid ground
  if (levelData.finale && inTree(levelData, x, z)) return false;   // the final run's tree: up there you can sit still
  const rh = levelData.roomHalf;
  if (Math.abs(x) < rh && Math.abs(z) < rh) return !levelData.finale && hyp(x, z) >= levelData.centerRadius;
  const h = (levelData.safeSize || levelData.corridorWidth) / 2;
  const sc = levelData.safeCorners;
  for (let i = 0; i < sc.length; i++) if (Math.abs(x - sc[i].x) < h && Math.abs(z - sc[i].z) < h) return false;
  return true;
}

function inCenter(levelData, x, z) {
  return hyp(x, z) < levelData.centerRadius - HALF_T;
}

// ---------------------------------------------------------------- self test

function checkPatternWolves(ld, P, stats) {
  // the final stretch's roaming wolves (generateLevel) are running-level wanderers, checked in mazeSelfTest
  ld = { ...ld, enemies: ld.enemies.filter((e) => !e.finalStretch) };
  const ranges = usableRanges(ld.legs, !!ld.finale);
  const vOut = CFG.RING_WIDTH / 2 - WOLF_MARGIN, eps = 1e-6;
  if (ld.enemies.length < 40) P(`few pattern wolves ${ld.enemies.length}`);
  const target = patWolfTarget(ld.level, ld.finale);
  if (ld.enemies.length > target) P(`${ld.enemies.length} pattern wolves, over ${target}`);
  if (!ld.patternPlan || ld.patternPlan.length < ld.legs.length - 3) P(`rooms missing: ${ld.patternPlan ? ld.patternPlan.length : 0} planned legs`);
  const beat = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.beat]));
  const period = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.period]));
  const chargerLaps = new Map();
  for (const e of ld.enemies) {
    const tag = `wolf ${e.id} (${e.type}/${e.pattern}, leg ${e.leg})`;
    if (!PAT_TYPES.includes(e.type)) P(`${tag}: type not allowed in Skate only`);
    if (!Array.isArray(e.route) || e.route.length < 2) { P(`${tag}: no route`); continue; }
    if (!(e.speed > 0 && e.speed < CFG.KITTY_SPEED * 0.92)) P(`${tag}: speed ${e.speed}`);
    if (!(e.phase >= 0 && e.phase < 1)) P(`${tag}: phase ${e.phase}`);
    if (!(e.rIn <= e.rOut && e.a0 <= e.a1)) P(`${tag}: bad bounds`);
    const rg = ranges[e.leg];
    for (const q of e.route) {
      if (!(Math.abs(q.r) <= vOut + eps && q.th >= rg.lo - eps && q.th <= rg.hi + eps)) P(`${tag}: waypoint out of bounds (${q.r.toFixed(2)}, ${q.th.toFixed(2)})`);
      if (!(q.r >= e.rIn - eps && q.r <= e.rOut + eps && q.th >= e.a0 - eps && q.th <= e.a1 + eps)) P(`${tag}: waypoint outside its spec bounds`);
    }
    // end to end: crossers / diagonals wall to wall; chargers the whole leg, safe square (or gap) to safe square
    if (e.loop || e.route.length !== 2) { P(`${tag}: route is not a single end-to-end run`); continue; }
    else if (e.type === 'charger') {
      const [A, B] = e.route;
      if (Math.abs(A.r - B.r) > eps || Math.abs(Math.min(A.th, B.th) - rg.lo) > eps || Math.abs(Math.max(A.th, B.th) - rg.hi) > eps) P(`${tag}: charger does not run the whole leg`);
      if (!chargerLaps.has(e.leg)) chargerLaps.set(e.leg, []);
      chargerLaps.get(e.leg).push(buildPlan(e, e.frame, e.speed).cycle);
    } else {
      const [A, B] = e.route;
      if (Math.abs(Math.abs(A.r) - vOut) > eps || Math.abs(Math.abs(B.r) - vOut) > eps || Math.sign(A.r) === Math.sign(B.r)) P(`${tag}: does not run wall to wall`);
      if (e.type === 'crosser' && Math.abs(A.th - B.th) > eps) P(`${tag}: crosser not straight across`);
    }
    if (e.hold != null) P(`${tag}: has a hold (wolves never pause)`);
    if (e.type !== 'charger') {
      // its lap divides the leg beat T, or it drifts: back in step with the beat within PAT_DRIFT_PERIOD, and the leg's
      // period (n beats) is a whole number of its laps
      const cyc = buildPlan(e, e.frame, e.speed).cycle, T = beat.get(e.leg), base = T / Math.max(1, Math.round(T / cyc));
      if (!T) P(`${tag}: leg has no beat`);
      else if (Math.abs(cyc - base) > 1e-4) {
        const back = base * cyc / Math.abs(base - cyc), per = period.get(e.leg);
        if (back > PAT_DRIFT_PERIOD + 1e-6) P(`${tag}: lap ${cyc.toFixed(3)} drifts back into step with the beat ${T} only every ${back.toFixed(1)}s`);
        if (!(per > T && per <= PAT_DRIFT_PERIOD + 1e-6) || Math.abs(cyc * Math.round(per / cyc) - per) > 1e-3) P(`${tag}: lap ${cyc.toFixed(3)} does not divide the leg's period ${per}`);
      }
    }
    const f = e.frame, pts = e.route;
    let clip = 0;
    for (let k = 1; k < pts.length; k++) {
      const A = pts[k - 1], B = pts[k], n = Math.max(1, Math.ceil(hyp(B.r - A.r, B.th - A.th) / 0.25));
      for (let t = 0; t <= n; t++) {
        const r = A.r + (B.r - A.r) * t / n, th = A.th + (B.th - A.th) * t / n;
        const { x, z } = legPoint(f, r, th);
        if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
      }
    }
    if (clip) P(`${tag}: route clips walls (${clip})`);
  }
  // a leg's charger lanes may run at different speeds, but come back into step within PAT_DRIFT_PERIOD
  for (const [leg, laps] of chargerLaps) {
    const L = Math.max(...laps);
    let ok = false;
    for (let j = 1; j * L <= PAT_DRIFT_PERIOD + 1e-6 && !ok; j++) ok = laps.every((c) => Math.abs(j * L / c - Math.round(j * L / c)) * c < 1e-3);
    if (!ok) P(`leg ${leg}: chargers never back in step with each other within ${PAT_DRIFT_PERIOD}s`);
  }
  // Skate only rooms (the final run's too) are built as designed: no launch-window / wait checks (the user
  // playtests their balance)
  for (const pl of ld.patternPlan || []) if (pl.period > pl.beat && !pl.finale) stats.iceDriftRooms++;
  stats.iceRooms += (ld.patternPlan || []).filter((pl) => !pl.finale).length;
  stats.iceWolves += ld.enemies.length;
}

function mazeSelfTest(levels = 12, modes = ['mixed', 'ice']) {
  const problems = [];
  const seeds = [1, 42, 1337, 9001, 'kitty', 777777];
  const stats = { levels: 0, avgPathLen: 0, enemies: 0, items: 0, iceWolves: 0, iceRooms: 0, iceDriftRooms: 0 };
  for (const mode of modes) for (const s of seeds) {
    for (let l = 1; l <= levels; l++) {
      const P = (s, l, msg) => { if (problems.length < 200) problems.push(`${mode} seed ${s} L${l}: ${msg}`); };
      const ld = generateLevel(l, s, mode);
      const p = levelParams(l);
      const pattern = ld.ice || ld.finale;
      if (pattern !== ld.enemies.filter((e) => !e.finalStretch).every((e) => e.pattern)) P(s, l, `ice ${ld.ice}: pattern wolves ${!pattern ? 'on a non-ice level' : 'missing'}`);
      // skate levels (not the final run): the final stretch's room + the goal room's crossers / diagonals (on top of
      // the count), clear of the walls and never onto the goal disc; chargers run straight, one lane each
      const fs = ld.enemies.filter((e) => e.finalStretch), lastLeg = ld.legs.length - 1;
      if (pattern && !ld.finale && fs.length < 8) P(s, l, `only ${fs.length} wolves on the final stretch`);
      if ((!pattern || ld.finale) && fs.length) P(s, l, 'final-stretch wolves on a level without a skate final stretch');
      const roomW = fs.filter((e) => String(e.pattern).startsWith('room-'));
      if (fs.length && (roomW.length !== 6 || !roomW.some((e) => e.type === 'crosser') || !roomW.some((e) => e.type === 'diagonal'))) P(s, l, `goal room wolves: ${roomW.map((e) => e.type).join(',')}`);
      let inRoom = false;
      for (const e of fs) {
        if (e.leg !== lastLeg || !e.pattern) P(s, l, `final-stretch wolf ${e.id}: leg ${e.leg}, ${e.type}/${e.pattern}`);
        if (e.type === 'charger' && e.route.length !== 2) P(s, l, `final-stretch charger ${e.id}: a route of ${e.route.length} points`);
        let clip = 0, disc = 0;
        for (let k = 1; k < e.route.length; k++) {
          const A = e.route[k - 1], B = e.route[k], n = Math.max(1, Math.ceil(hyp(B.r - A.r, B.th - A.th) / 0.25));
          for (let t = 0; t <= n; t++) {
            const { x, z } = legPoint(e.frame, A.r + (B.r - A.r) * t / n, A.th + (B.th - A.th) * t / n);
            if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
            if (hyp(x, z) < ld.centerRadius + CFG.WOLF_RADIUS) disc++;
            const w = locate(ld, x, z);
            if (w.leg === -1) inRoom = true;
          }
        }
        if (clip) P(s, l, `final-stretch wolf ${e.id} (${e.type}): route clips walls (${clip})`);
        if (disc) P(s, l, `final-stretch wolf ${e.id} (${e.type}): route enters the goal disc`);
      }
      if (fs.length && !inRoom) P(s, l, 'no final-stretch wolf in the goal room');
      stats.levels++;
      if (JSON.stringify(ld) !== JSON.stringify(generateLevel(l, s, mode))) P(s, l, 'not deterministic');
      // path: starts at start, ends in center, never inside walls
      const path = ld.path;
      if (!inCenter(ld, path[path.length - 1].x, path[path.length - 1].z)) P(s, l, 'path does not end in center');
      let len = 0, bad = 0;
      for (let k = 1; k < path.length; k++) {
        const A = path[k - 1], B = path[k];
        const sl = hyp(B.x - A.x, B.z - A.z);
        len += sl;
        if (sl > 2.6) P(s, l, 'path step too long ' + sl.toFixed(2));
        const n = Math.ceil(sl / 0.2);
        for (let t = 0; t <= n; t++) {
          const x = A.x + (B.x - A.x) * t / n, z = A.z + (B.z - A.z) * t / n;
          if (collideCircle(ld, x, z, CFG.KITTY_RADIUS).hit) bad++;
        }
      }
      if (bad) P(s, l, `path hits walls at ${bad} samples`);
      stats.avgPathLen += len;
      // spawn points
      for (const sp of ld.spawnPoints) {
        if (collideCircle(ld, sp.x, sp.z, CFG.KITTY_RADIUS).hit) P(s, l, 'spawn collides');
        if (locate(ld, sp.x, sp.z).leg !== 0) P(s, l, 'spawn not in the first leg');
      }
      // enemies: territories inside their leg, clear of walls and the start pocket
      if (pattern) checkPatternWolves(ld, (msg) => P(s, l, msg), stats);
      else {
        if (ld.enemies.length < p.enemyCount * 0.85) P(s, l, `few enemies ${ld.enemies.length}/${p.enemyCount}`);
        const runTunedLevel = ld.enemies.some((e) => e.pauseRange);
        for (const e of ld.enemies) {
          if (!(e.rIn < e.rOut && e.a0 < e.a1)) P(s, l, 'enemy bad bounds ' + e.id);
          if (!p.enemyTypes.includes(e.type)) P(s, l, 'enemy type ' + e.type);
          if (!(e.speed > 0 && e.speed < CFG.KITTY_SPEED)) P(s, l, 'enemy speed ' + e.speed);
          let clip = 0, unsafe = 0;
          const f = e.frame;
          for (let u = 0; u <= 8; u++) for (let v = 0; v <= 4; v++) {
            const a = e.a0 + (e.a1 - e.a0) * u / 8, r = e.rIn + (e.rOut - e.rIn) * v / 4;
            const { x, z } = legPoint(f, r, a);
            if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
            for (const sp of ld.spawnPoints) if (hyp(sp.x - x, sp.z - z) < CFG.START_SAFE_ARC) unsafe++;
          }
          if (clip) P(s, l, `enemy ${e.id} (${e.type}) bounds clip walls (${clip})`);
          // tuned running levels walk up to the start square's tile edge like any safe square (sim-test checks the tiles)
          if (unsafe && !runTunedLevel) P(s, l, `enemy ${e.id} covers start safe area`);
        }
      }
      // items
      if (ld.items.length < p.itemCount) P(s, l, `few items ${ld.items.length}/${p.itemCount}`);
      for (const it of ld.items) {
        if (collideCircle(ld, it.x, it.z, CFG.ITEM_RADIUS).hit) P(s, l, 'item in wall ' + it.id);
        if (locate(ld, it.x, it.z).leg < 0) P(s, l, 'item outside corridors');
      }
      ld.items.forEach((it, k) => { if (it.id !== k) P(s, l, 'item ids not sequential'); });
      ld.enemies.forEach((e, k) => { if (e.id !== k) P(s, l, 'enemy ids not sequential'); });
      stats.enemies += ld.enemies.length;
      stats.items += ld.items.length;
    }
  }
  stats.avgPathLen /= Math.max(1, stats.levels);
  return { ok: problems.length === 0, problems, stats };
}

// Cheap fingerprint of a generated level (wolf specs without their shared leg frames, and items): the server sends
// it with each level so clients can report a level they generated differently (e.g. a float op that differs between
// JS engines). JSON number formatting is exact and engine independent.
const levelHashes = new WeakMap();   // levelData -> its hash (computed once: it stringifies every wolf)
function levelHash(ld) {
  let h = levelHashes.get(ld);
  if (h === undefined) { h = hashSeed(JSON.stringify([(ld.enemies || []).map(({ frame, ...s }) => s), ld.items || [], ...(ld.piles && ld.piles.length ? [ld.piles] : [])])); levelHashes.set(ld, h); }   // (piles: version 25+ only, older hashes unchanged)
  return h;
}

// How far along a level's path (levelData.path: start to goal) a point is, 0..1: the nearest point of the path. A
// straight path (the final runs: along x) is just the point's x.
const pathInfos = new WeakMap();
function pathProgress(ld, x, z) {
  const pts = ld && ld.path;
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let pi = pathInfos.get(ld);
  if (!pi) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const dir = Math.sign(pts[1].x - pts[0].x);
    const straight = !!dir && pts.every((q, i) => q.z === pts[0].z && (!i || Math.sign(q.x - pts[i - 1].x) === dir));
    pi = { cum, total: cum[cum.length - 1] || 1, straight };
    pathInfos.set(ld, pi);
  }
  if (pi.straight) {
    const a = pts[0].x, b = pts[pts.length - 1].x;
    return Math.max(0, Math.min(1, (x - a) / (b - a)));
  }
  let best = Infinity, at = 0;
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], ex = pts[i].x - A.x, ez = pts[i].z - A.z, L2 = ex * ex + ez * ez;
    if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((x - A.x) * ex + (z - A.z) * ez) / L2));
    const dx = x - A.x - ex * t, dz = z - A.z - ez * t, d = dx * dx + dz * dz;
    if (d < best) { best = d; at = pi.cum[i - 1] + t * (pi.cum[i] - pi.cum[i - 1]); }
  }
  return Math.max(0, Math.min(1, at / pi.total));
}

// ...the same followed from where it was (hint: the path segment it was nearest, -1: anywhere): only the segments
// around that one (PATH_TRACK of them each way, about 30 units of path), so it never jumps to the corridor next door
// through a wall the way a nearest-anywhere search can. -> { f: 0..1, i: the segment now }
const PATH_TRACK = 15;
function pathTrack(ld, x, z, hint = -1) {
  const pts = ld && ld.path;
  if (!Array.isArray(pts) || pts.length < 2) return { f: 0, i: -1 };
  if (!pathInfos.get(ld)) pathProgress(ld, x, z);   // (its lengths)
  const pi = pathInfos.get(ld), n = pts.length - 1;
  const lo = hint < 0 ? 1 : Math.max(1, hint - PATH_TRACK), hi = hint < 0 ? n : Math.min(n, hint + PATH_TRACK);
  let best = Infinity, at = 0, seg = lo;
  for (let i = lo; i <= hi; i++) {
    const A = pts[i - 1], ex = pts[i].x - A.x, ez = pts[i].z - A.z, L2 = ex * ex + ez * ez;
    if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((x - A.x) * ex + (z - A.z) * ez) / L2));
    const dx = x - A.x - ex * t, dz = z - A.z - ez * t, d = dx * dx + dz * dz;
    if (d < best) { best = d; at = pi.cum[i - 1] + t * (pi.cum[i] - pi.cum[i - 1]); seg = i; }
  }
  return { f: Math.max(0, Math.min(1, at / pi.total)), i: seg };
}

export { generateLevel, collideCircle, locate, inCenter, onIce, inTree, inPile, mazeSelfTest, levelHash, pathProgress, pathTrack };
