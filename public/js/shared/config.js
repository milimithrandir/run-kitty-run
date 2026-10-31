
// Shared tuning constants. Pure data, no three.js.

const CFG = {
  TICK: 1 / 60,

  // Kitty
  KITTY_RADIUS: 0.4,
  KITTY_SPEED: 6.5,          // units / second at speedMult 1
  KITTY_ACCEL_TAU: 0.05,     // velocity smoothing time constant (s)
  KITTY_HIT_SCALE: 0.85,     // kitty hitbox = radius * this
  SPEED_BOOST: 0.05,         // +5% per boots
  SPEED_MULT_MAX: 1.2,       // four pairs of boots max (lost when caught)
  MUSIC_BOOST: 1.01,         // "music makes you go faster": an input with m (sound on) runs 1% faster
  MUSIC_BOOST_LEVEL: { 3: 1.02 },   // ...and on these levels this much ("CATJAM")
  HEART_BOOT_LEVEL: 4,       // "speed is life": on this level a heart counts as a pair of boots too
  REVIVE_DOUBLE_LEVEL: 5,    // "never leave a kitty behind": revives score double here (p.bonus)
  MAX_EXTRA_LIVES: 1,
  SPAWN_INVULN: 2.0,         // seconds after level start / revive
  SHIELD_TIME: 4.0,          // seconds from shield pickup

  // Ice (the snowy level): on ice a kitty keeps sliding at full speed in the way it faces and
  // can only turn at ICE_TURN_RATE, so reversing carves a small U-turn instead of flipping around.
  ICE_TURN_RATE: 5.5,        // rad/s (turn radius = speed / rate, ~1.2 units)
  ICE_ACCEL_TAU: 0.3,        // speed build-up time constant on ice (s)
  ICE_TEST: false,           // true = every level is the snowy ice level (for testing)

  // Revive
  REVIVE_DELAY: 0.2,         // seconds after going down before a friend can revive you
  REVIVE_INVULN: 0.67,       // seconds safe after a friend's revive (with REVIVE_DELAY: no new revive within ~0.9 s of one)
  REVIVE_RADIUS: 1.1,        // circle radius; living kitty center within REVIVE_RADIUS + KITTY_RADIUS revives

  // Maze geometry
  CENTER_RADIUS: 5.0,        // radius of goal area wall
  RING_WIDTH: 10.8,          // corridor width
  WALL_THICKNESS: 0.5,
  WALL_HEIGHT: 1.4,
  START_SAFE_ARC: 7.0,       // linear arc length (units) on each side of start angle with no enemies

  // Enemies
  WOLF_RADIUS: 0.66,
  WOLF_HIT_SCALE: 0.8,

  // Items
  ITEM_RADIUS: 0.6,
  CHEST_ODDS: 100,           // the lottery: one checkpoint in this many has a big chest waiting on it
  CHEST_RADIUS: 1.1,         // a kitty this close to the chest opens it
  CHEST_ARM: 1.0,            // seconds before it can be opened (so everyone sees it first)
  CHEST_LOOT: [8, 4, 44],    // pickups it drops: this many + this many per kitty, at most this many
  CROWN_RADIUS: 1.0,         // pickup radius of the crown over the goal room's middle
  TREE_RADIUS: 1.7,          // autumn levels: a kitty this close to a climbable tree's trunk is up in it (safe)         // pickup radius of the crown over the goal's center

  // Flow
  LEVEL_CLEAR_TIME: 2.4,     // seconds of celebration before next level
  RETRY_TIME: 2.2,           // easy games: seconds after everyone went down before the level starts over
};

// Loops of the (fixed) square spiral map (see maze.js).
const MAP_RINGS = 6;

// Difficulty curve. level starts at 1.
function levelParams(level) {
  const L = Math.max(1, level | 0);
  // The map is the same every level (fixed spiral, see maze.js); only the wolves scale.
  // Every wolf is a wanderer (roams to random spots in its territory); levels scale speed/pauses/territory.
  const types = ['wanderer'];
  return {
    rings: MAP_RINGS,                                               // fixed: same map every level
    // Fixed wolf count on every level (~1 wolf per 4 units of the ~840-unit square spiral);
    // levels get harder through speed, shorter pauses, bigger territories and new wolf types.
    enemyCount: 216,
    enemySpeed: CFG.KITTY_SPEED * Math.min(0.8 * (1 + 0.025 * (L - 1)), 0.88), // ~80% of kitty speed, creeping up per level
    enemyPauseScale: Math.max(0.4, 1 - 0.07 * (L - 1)),             // wolves rest less each level
    enemyTypes: types,
    itemCount: 8 + Math.floor(L / 2),
    // Skate only mode: pattern wolves (maze.js placePatternEnemies). Level part of the room difficulty
    // (level 1's first legs are gentle lessons; each leg adds up to +0.5 toward the middle): faster wolves,
    // shorter holds, more crosser rows and charger lanes, tighter launch windows.
    patternHeat: Math.min(1.4, 0.2 + 0.17 * (L - 1)),   // keeps climbing through level 8 (the final run caps it at 1.2)
  };
}

// Kitty colors + default names for up to 32 players (online lobbies hold NET.MAX_PLAYERS).
const PLAYER_COLORS = [
  0xffb347, 0x6ec6ff, 0xff7eb6, 0x9dff7a, 0xc59bff, 0xfff06a, 0x5ff3d0, 0xff6b5b,
  0xffd9a0, 0x3d8bff, 0xd94fff, 0x4fd16a, 0xff9e3d, 0xa8f0ff, 0xffb3d1, 0xc8ff4f,
  0x8f7bff, 0xffe0f0, 0x2fd6b0, 0xff4f8b, 0xb8885a, 0x7fb4ff, 0xf2f2f2, 0xe8c547,
  0x6fe8e8, 0xff7a3d, 0xb0ffb0, 0xd0a8ff, 0xff9999, 0x9fe05f, 0x5fb8d6, 0xffc0ff,
];
const PLAYER_NAMES = [
  'Mittens', 'Biscuit', 'Pixel', 'Noodle', 'Pumpkin', 'Waffles', 'Mochi', 'Ziggy',
  'Pepper', 'Muffin', 'Socks', 'Tofu', 'Ginger', 'Luna', 'Peanut', 'Sushi',
  'Cookie', 'Bean', 'Olive', 'Nacho', 'Toast', 'Pickle', 'Maple', 'Clover',
  'Bubbles', 'Taco', 'Mango', 'Sprout', 'Dumpling', 'Kiwi', 'Pudding', 'Whiskers',
];

// Online play
const NET = {
  MAX_PLAYERS: 32,
  SNAP_EVERY: 3,       // server sends a snapshot every N ticks (20 Hz)
  INPUT_LEAD: 3,       // ticks of safety margin client inputs should arrive ahead of the server
};

// The boss level (Run + Skate and Skate only): instead of the spiral it is one long icy straight run (as long as
// the whole spiral) packed with pattern wolves, no safe squares and no checkpoints, one climbable tree halfway.
// Clearing it wins the game (sim state 'victory'). Finale version 2 makes it three lanes wide, ending in a stretch of
// running-level wolves; Run only's level 9 is a final run on foot (version 1+). See maze.js generateLevel (fv): online
// rooms play the newest version every member has (protocol 5 / 6 / 7), otherwise the older levels. Version 3: Run +
// Skate's level 9 is the wide skate final run and then Run only's (maze.js generateCombo).
const SKATE_FINAL_LEVEL = 9;
const FINAL_MODES = ['mixed', 'ice'];

// Run + Skate from level version 13 (DAY_NIGHT_FV): every level is played twice, first by day on foot (Run only's
// level) and then by night on skates (Skate only's); reaching the day goal is a checkpoint (everyone revives and
// teleports to the night rink). Internally each half is its own step (sim.level): 1 = level 1 by day, 2 = level 1 by
// night, ..., 16 = level 8 by night, 17 = level 9 (the final run, unchanged).
const DAY_NIGHT_FV = 13;
// 14: Run + Skate's night half is in its day half's season (summer by day, then summer by night, ...) instead of Skate
// only's own order (which starts in winter). Only the season changes: the rink, its wolves and its pickups are the same.
const SAME_SEASON_FV = 14;
// 15: Run only's level 9 wolves start slower and get evenly faster toward the goal room, like Run + Skate's running half,
// and in both they only get up to 92% of their speed there (maze.js RUN_RAMP_TOP; same wolves, same places)
const RUN_RAMP_FV = 15;
// 16: Run + Skate's level 9: any kitty can repair the broken checkpoint (no revives needed, as in an easy game)
const ANYONE_MEDIC_FV = 16;
// 17: Run + Skate level 9's broken checkpoint, repaired by a kitty with 60+ revives this run, gives a life and 4 boots
const MEDIC_GIFT_FV = 17;
// 18: Run only's level 9 (and hell's): a wolf's first rest is one of its usual ones (mostly short) instead of anything up
// to 6 s, so the pack is on the move from the start (afterwards nothing changes: same rests, same walks)
const QUICK_START_FV = 18;
// 19: every level has at least one heart (one of its pickups becomes one when none came up; maze.js generateLevel)
const HEART_FV = 19;
// 20: on ice a kitty with boots also turns faster, by as much as it goes faster, so its U-turn is as small as without
// (sim.js movePlayer; without boots nothing changes)
const ICE_TURN_FV = 20;
// 21: each half of Run + Skate's final level has a heart (up to ITEM_CAP's 2 each, as before; maze.js generateCombo)
const HALF_HEART_FV = 21;
// 21 too: the final runs' new-behaviour run wolves rest longer at the least (0.1 s before; not the original-behaviour ones):
// 0.5 s in the skate final run's run stretch (Run + Skate's skate half too), 0.3 s in Run only's level 9 and Run + Skate's
// running half (maze.js STRETCH_REST_MIN, RUN_FINALE_REST_MIN); hell as its level 9
const STRETCH_REST_FV = 21;
// 22: those on foot rest at least 0.42 s (0.3 in 21: Run only's level 9, Hell Run, Run + Skate's running half)
const RUN_REST_FV = 22;
// 23: running levels 1-8 (Run + Skate's too) and the running final runs (Run only's level 9, hell, Run + Skate's running
// half): the new-behaviour wolves' walks average the same on every
// level (level 1's), the range still widening; harder levels only through their shorter rests (maze.js RUN_WALKS_EVEN)
const EVEN_WALKS_FV = 23;
// 23 too: no pickup outside the play area (the final runs' wide corridor beside their narrower rooms; maze.js
// placeItemsCapped inside)
const ITEMS_INSIDE_FV = 23;
// 23 too: Hell Run's waves 10 s apart from hell 6 (8 before; Hell Skate keeps 8; waves.js waveEvery)
const WAVE10_FV = 23;
// 24: the final runs on foot (Run only's level 9, Hell Run, Run + Skate's running half): a wolf's move to a wall ends
// anywhere up to 0.7 from it, not right against it (they lined the wall up; maze.js RUN_FINALE_BAND)
const WALL_BAND_FV = 24;
const LATEST_FV = 24;   // the level version a game on this device plays (offline; online: the newest every member has)
// Hell (protocol 25): Run only's or Skate only's level 9 (the final run) over and over. Clearing hell level n starts
// hell level n + 1, a new final run of its own (its own seed: another layout, wolves and pickups), up to HELL_LEVELS;
// clearing the last one wins. A game's result is how far it got: the level, and how far along the map the team got on it (sim.far).
// Unlocked per mode by reaching level 9 there (Run + Skate: both) or by clearing a hell level (unlocks.js hellOpen).
const HELL_LEVELS = 6;
const HELL_MODES = ['run', 'ice'];
function stageOf(mode, fv, step) {
  if (mode !== 'mixed' || (fv | 0) < DAY_NIGHT_FV) return { level: step, day: false, night: false };
  const level = Math.min(SKATE_FINAL_LEVEL, Math.ceil(step / 2));
  if (level >= SKATE_FINAL_LEVEL) return { level, day: false, night: false };
  return { level, day: step % 2 === 1, night: step % 2 === 0 };
}
// the step that starts a level (by night: its second half)
const stageStep = (mode, fv, level, night = false) => (mode === 'mixed' && (fv | 0) >= DAY_NIGHT_FV
  ? (level >= SKATE_FINAL_LEVEL ? 2 * SKATE_FINAL_LEVEL - 1 : 2 * level - 1 + (night ? 1 : 0)) : level);

// Online protocol version, sent by clients in their first 'hi' message (net.js). Bump it whenever the sim or netcode
// changes incompatibly (anything that would desync an older client); the server's MODE_MIN_PROTOCOL / MIN_PROTOCOL
// then decide who gets an "update" notice. App store builds lag the web by days, so avoid bumping casually.
//   2 = Skate only wolves walk deterministic patterns
//   3 = the boss final run on SKATE_FINAL_LEVEL (Run + Skate and Skate only) and Run + Skate's season order
//   4 = slim wolf resync format ([id, time] / [id, heading, rng, ...]) and ipow in level generation (level 9 boss
//       run differed on iOS); start messages carry a level hash (lh)
//   5 = Run only's level 9 final run (start messages carry rf; a room uses it only when every member has 5+)
//   6 = the wide skate final run (finale version 2: start messages carry rf 2 when every member has 6+)
//   7 = Run + Skate's level 9 is both final runs in a row (finale version 3, rf 3), its broken (medic) checkpoint
//   8 = skate goal rooms without their three wolves behind the disc (finale version 4, rf 4)
//   9 = no lane-before-last wolf turning round in the open at the skate levels' last junction (finale version 5, rf 5)
//  10 = at most 2 slanted crossers in the skate levels' last junction, black chargers across it instead (finale version 6, rf 6)
//  11 = skate levels: every lane's wolf count its share of the level's (busier every level) (finale version 7, rf 7)
//  12 = running levels: more wolves in the first six (long) lanes, up to 37/38/34/35/31/32 on level 8 (finale version 8, rf 8)
//  13 = running levels: lanes 7-15 rise 5% a level up to their level 8 count (finale version 9, rf 9)
//  14 = running levels 1-8: wolves rest as long in every lane, no shorter rests toward the middle (finale version 10, rf 10)
//  15 = items: 8 a level (autumn 4 + the tree boots), at most 2 hearts and 3 shields, level 9's tree has big boots (finale version 11, rf 11)
//  16 = Skate only's levels 1-8: the seasons from winter, as floodlit night levels (finale version 12, rf 12)
//  17 = Run + Skate: every level by day (Run only's) then by night (Skate only's), see DAY_NIGHT_FV (finale version 13, rf 13)
//  19 = easy games (a level starts over when everyone is down; state 'retry', snapshot rt)
//  20 = Run + Skate's night half in the day's season (finale version 14, rf 14)
//  21 = the lottery chest on a lucky checkpoint (events chest / chestOpen; only in rooms where everyone has 21+)
//  22 = the running final run's wolves speed up toward the goal room, to 92% (finale version 15, rf 15)
const PROTOCOL_VERSION = 35;   // 35: versus (lobbies with teams, start messages and snapshots vs, players' team: shared/sim.js vsTeam); 34: chained games' longer chain, each link dragged by its own two kitties (shared/sim.js chainPull); 33: chained games (lobbies with chain, start messages cn: shared/sim.js chainPull); 32: the final runs' wolves stop up to 0.7 from a wall, not right against it (finale version 24, rf 24); 31: running levels' walks average the same every level, no pickups outside the play area, Hell Run's hell 6 waves 10 s apart (finale version 23, rf 23); 30: the running final runs' run wolves rest at least 0.42 s (finale version 22, rf 22); 29: a heart in each half of Run + Skate's final level, the final runs' run wolves rest longer at the least (finale version 21, rf 21); 28: on ice, boots turn faster too (finale version 20, rf 20); 27: easy hell (a hell level starts over when everyone is down; the wipe event carries far); 26: hell's wolf waves (shared/waves.js; start messages carry hw, a hell game's sim.waves) and a heart on every level (finale version 19, rf 19); 25: hell (Run only's / Skate only's final run over and over, HELL_LEVELS; start messages carry hell, snapshots hf) and Run only level 9's wolves off at once (finale version 18, rf 18); 24: the broken checkpoint's gift for a medic (finale version 17, rf 17); 23: any kitty repairs Run + Skate level 9's broken checkpoint (finale version 16, rf 16)

export { CFG, MAP_RINGS, levelParams, PLAYER_COLORS, PLAYER_NAMES, NET, SKATE_FINAL_LEVEL, FINAL_MODES, PROTOCOL_VERSION, DAY_NIGHT_FV, SAME_SEASON_FV, RUN_RAMP_FV, ANYONE_MEDIC_FV, MEDIC_GIFT_FV, QUICK_START_FV, HEART_FV, ICE_TURN_FV, HALF_HEART_FV, STRETCH_REST_FV, RUN_REST_FV, EVEN_WALKS_FV, ITEMS_INSIDE_FV, WAVE10_FV, WALL_BAND_FV, LATEST_FV, HELL_LEVELS, HELL_MODES, stageOf, stageStep };
