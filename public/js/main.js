import * as THREE from 'three';
import { CFG, PLAYER_COLORS, PLAYER_NAMES, NET, LATEST_FV, SKATE_FINAL_LEVEL, HELL_LEVELS, stageOf, stageStep } from './shared/config.js';
import { hashSeed } from './shared/rng.js';
import { collideCircle, onIce, inTree, levelHash } from './shared/maze.js';
import { updateEnemies, nearestEnemyDist, applyEnemyState, turnIn, turnedAgo } from './shared/enemies.js';
import { createSim, stepSim, predictPlayer, loadLevel, CHAIN_SOFT, CHAIN_LEN, chainLinks, vsScore } from './shared/sim.js';
import { hellWaves, WAVE_SPEED } from './shared/waves.js';
import { pregenNext } from './levelpregen.js';
import { ghostMaterial, disposeModel, createKittyModel, createWolfRig, newWolfState, createItemModel, createReviveCircleModel, createPortalModel, createCrownPickupModel, createGiantFishModel, createChestModel } from './models.js';
import { createWolfPack } from './wolfpack.js';
import { buildWorld, setupLighting } from './world.js';
import { createEffects } from './effects.js';
import { createIceTrail } from './trail.js';
import { createAuraTrail } from './auratrail.js';
import { createPawPrints } from './pawprints.js';
import { medicLook, slotMetal } from './shared/unlocks.js';
import { createAudio } from './audio.js';
import { createUI, rankOrder } from './ui.js';
import { createNet, progressId } from './net.js';
import { createLobbyUI } from './lobby.js';
import { createPadNav } from './padnav.js';
import { prefColor, localSlots } from './kittycolor.js';
import { shareResult } from './share.js';
import { createChat } from './chat.js';
import { createFeedback } from './feedback.js';
import { createAccount } from './account.js';
import { createLegends } from './legends.js';
import { analytics, openStatsPage, setHellModes } from './analytics.js';
import { TOUCH, QUALITY, setQuality, goFullscreenLandscape, setKeepAwake, hideSplash } from './device.js';
import { openSettings, closeSettings, settingsOpen, settingsRoot, key, keyName, musicVolume, sfxVolume, fpsLimit, lookBack } from './settings.js';
import { NATIVE, haptic, plugin, call, storeUrl, openExternal, APP_VERSION } from './platform.js';

// Integration: renderer, input, camera, presentation of the pure sim.

const params = new URLSearchParams(location.search);
const DEBUG_LEVEL = Math.max(1, parseInt(params.get('level') || '1', 10) || 1);
const DEBUG_NIGHT = params.has('night');   // ?level=3&night: Run + Skate's level 3 by night
const DEBUG_MODE = ['mixed', 'run', 'ice'].includes(params.get('mode')) ? params.get('mode') : undefined; // offline testing: ?mode=ice
// local testing only (localhost): ?wins=7 starts every offline kitty with that many wins and a crown (all run rewards)
const DEBUG_WINS = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? Math.max(0, parseInt(params.get('wins') || '0', 10) || 0) : 0;
// local testing of the revive rewards: ?rescues=60 (localhost only, like ?wins=), and ?look=crown,pack to wear the
// crown and a kitten backpack without the other win rewards (the aura hides the kitty)
const DEBUG_RESCUES = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? Math.max(0, parseInt(params.get('rescues') || '0', 10) || 0) : 0;
const DEBUG_LOOK = new Set(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? (params.get('look') || '').split(',') : []);
// ?song: We Skate as if unlocked (localhost only): its button and speed in the settings
// ?chest: every checkpoint has the lottery chest (localhost only)
const DEBUG_CHEST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && params.has('chest');
const DEBUG_SONG = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && params.has('song');
const DEBUG_PACK = [PLAYER_COLORS[1], PLAYER_COLORS[2], PLAYER_COLORS[3]];

// ---------- renderer / scene ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY.antialias, stencil: true, powerPreference: 'high-performance' });   // stencil: wolves show through trees (wolfpack.js)
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = QUALITY.shadows;   // (graphics: Low turns them off)
renderer.shadowMap.type = QUALITY.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// near 0.5 (it was 0.1): 5 times the depth precision far from the camera. Zoomed all the way out, thin layers on the
// ground (the portal's glow, 5 mm over its stone disc) flickered in stripes. Nothing ever comes that close to the camera.
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 400);
camera.position.set(0, 40, 30);

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

const lighting = setupLighting(scene);
const effects = createEffects(scene);
const audio = createAudio();
const ui = createUI(document.getElementById('ui'));
// vote to kill a kitty standing still: from its card, or the spectate bar while watching it (updateWatchLabel)
function voteKill(id) { if (online.playing && !online.voted.has(id)) { online.voted.add(id); net.send({ t: 'votekill', id }); audio.play('click'); } }
ui.onVoteKill(voteKill);

// Soundtrack: a playlist of mp3s next to index.html, played one after the other on repeat, in a shuffled order (a new
// one every visit and every time round, so the songs don't always come in the same order; the settings' Shuffle switch,
// remembered: off, they play in their own order from the first).
// Plain <audio> element. A track that fails to load is skipped; if all fail, procedural music plays.
// The last one, We Skate, is an unlock (shared/unlocks.js 'song5': clear the final level online): it plays at every
// victory party, and joins the songs (or plays on its own) once this player has it.
const PLAYLIST = ['music/catjam2.mp3', 'music/catjam3.mp3', 'music/catjam4.mp3', 'music/catjam5.mp3'];   // (catjam1.mp3 is resting for now)
const SONG5 = 3;
let shuffleOn = true;
try { shuffleOn = localStorage.getItem('rkr-shuffle') !== '0'; } catch { /* ignore */ }
// the play order: the songs shuffled (avoid: not the song that just played first, when there's another); Shuffle off:
// their own order
function shuffledOrder(avoid = -1) {
  const a = PLAYLIST.map((_, i) => i);
  if (!shuffleOn) return a;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  if (a.length > 1 && a[0] === avoid) [a[0], a[1]] = [a[1], a[0]];
  return a;
}
let playOrder = shuffledOrder();
let trackIdx = playOrder[0];
const badTracks = new Set();
let songUnlocked = false;   // We Skate (account.has('song5'), set when the account / this browser's unlocks load)
let victorySong = false;    // We Skate is playing for the victory party (once; then the picked music goes on)
const playable = (i) => !badTracks.has(i) && (i !== SONG5 || songUnlocked);
// No src until the first real play(): nothing (4+ MB) is fetched at load, or ever while muted.
const track = new Audio();
const trackVol = () => 0.5 * musicVolume();   // the settings' music volume (100% = the usual 0.5)
track.volume = trackVol();
track.preload = 'none';
audio.attachTrack(track);   // played through the game's audio context (audio.js: no full-volume blip on Windows)
let trackWanted = false, trackFailed = false, musicLevel = 1;
let inBackground = false; // see setBackground()
// We Skate's speed (the settings, remembered): faster, same pitch. A new src resets the rate (to the default one).
const SKATE_SPEEDS = [1, 1.05, 1.1];
let skateSpeed = 1;
try { const v = +localStorage.getItem('rkr-skate-speed'); if (SKATE_SPEEDS.includes(v)) skateSpeed = v; } catch { /* ignore */ }
function setRate() {
  const r = trackIdx === SONG5 ? skateSpeed : 1;
  track.preservesPitch = true;
  if (track.defaultPlaybackRate !== r) track.defaultPlaybackRate = r;
  if (track.playbackRate !== r) track.playbackRate = r;
}
track.addEventListener('loadstart', setRate);
function playTrack() {
  if (musicOff()) return;
  if (!track.getAttribute('src')) track.src = PLAYLIST[trackIdx];
  setRate();
  track.play().catch(() => { /* needs a user gesture; retried on input */ });
}
// Which songs play (remembered): the songs the player switched on in the settings, one after the other on repeat (one
// song: on a loop). null = all of them (new songs join when unlocked); none = no music at all (the game's sound effects
// keep playing; M still mutes everything). Saved as 'both' (all, the old name kept), 'off', or the songs: '0,2'.
let musicPick = null;
try {
  const v = localStorage.getItem('rkr-music');
  if (v === 'off') musicPick = [];
  else if (v && /^\d(,\d)*$/.test(v)) musicPick = [...new Set(v.split(',').map(Number))].filter((i) => i < PLAYLIST.length);
} catch { /* ignore */ }
const songsHere = () => PLAYLIST.map((_, i) => i).filter((i) => i !== SONG5 || songUnlocked);   // (the settings list them)
const songOn = (i) => (musicPick || songsHere()).includes(i);
const musicOff = () => !!musicPick && musicPick.length === 0;
// the songs that play: the switched-on ones that load here (none of them: all that do)
function picked() {
  const all = PLAYLIST.map((_, i) => i).filter(playable), mine = all.filter(songOn);
  return mine.length ? mine : all;
}
function toggleSong(i) {
  const on = new Set(musicPick || songsHere());
  if (on.has(i)) on.delete(i); else on.add(i);
  const here = songsHere();
  musicPick = here.every((x) => on.has(x)) ? null : [...on].sort((x, y) => x - y);
  try { localStorage.setItem('rkr-music', !musicPick ? 'both' : musicPick.length ? musicPick.join(',') : 'off'); } catch { /* ignore */ }
  victorySong = false;
  applyMusicChoice();
}
function applyMusicChoice() {
  if (musicOff()) { track.pause(); audio.stopMusic(); return; }
  const set = picked();
  track.loop = set.length === 1;
  if (!set.includes(trackIdx)) {
    trackIdx = playOrder.find((i) => set.includes(i)) ?? set[0];   // switch now (the new song starts from the top)
    if (trackWanted && !audio.isMuted() && !inBackground && !trackFailed) { track.src = PLAYLIST[trackIdx]; playTrack(); }
    else track.removeAttribute('src');
  }
  // (back on after 'off': pick the music up again if a game wants it)
  if (trackWanted && trackFailed && !audio.isMuted()) audio.startMusic(musicLevel);
  else syncTrack();
}
function nextTrack() {
  const set = picked();
  let p = playOrder.indexOf(trackIdx);
  for (let k = 1; k <= 2 * PLAYLIST.length; k++) {
    if (++p >= playOrder.length) { playOrder = shuffledOrder(trackIdx); p = 0; }   // (round again: a new order)
    const i = playOrder[p];
    if (!set.includes(i) || (i === trackIdx && set.length > 1)) continue;
    trackIdx = i;
    if (trackWanted && !audio.isMuted() && !inBackground) { track.src = PLAYLIST[i]; playTrack(); }
    else track.removeAttribute('src'); // loaded lazily by the next playTrack()
    return;
  }
}
track.addEventListener('ended', () => {   // (one song on a loop: track.loop, 'ended' never fires)
  // the victory party's We Skate is over: the switched-on songs go on (one: on its loop)
  if (victorySong) { victorySong = false; track.loop = picked().length === 1; }
  nextTrack();
});
applyMusicChoice();
track.addEventListener('error', () => {
  badTracks.add(trackIdx);
  if (PLAYLIST.every((_, i) => !playable(i))) { trackFailed = true; if (trackWanted && !musicOff()) audio.startMusic(musicLevel); return; }
  nextTrack();
});

function musicPlay(level) {
  musicLevel = level;
  trackWanted = true;
  if (trackFailed) { if (!musicOff()) audio.startMusic(level); return; }
  if (!audio.isMuted() && !inBackground && track.paused) playTrack();
}
// the soundtrack comes back in softly (ramped in tick()): the victory party when We Skate can't play
function musicFadeIn(level) {
  track.volume = Math.min(0.04, trackVol());
  musicPlay(level);
}
// the victory party: We Skate from the top (the song this win unlocks online), once (no song: the music fades back in)
function musicVictorySong(level) {
  if (trackFailed || musicOff() || badTracks.has(SONG5)) { musicFadeIn(level); return; }
  victorySong = true;
  trackIdx = SONG5;
  track.loop = false;
  track.volume = trackVol();
  track.src = PLAYLIST[SONG5];
  musicLevel = level;
  trackWanted = true;
  if (!audio.isMuted() && !inBackground) playTrack();
}
function musicStop() {
  trackWanted = false;
  track.pause();
  audio.stopMusic();
}
function syncTrack() {
  if (trackFailed) return;
  if (audio.isMuted() || !trackWanted || inBackground || musicOff()) track.pause();
  else if (track.paused) playTrack();
}

// Sound starts ON unless the player muted it before (remembered per browser).
let soundPref = 'on';
try { soundPref = localStorage.getItem('rkr-sound') || 'on'; } catch (e) { /* storage unavailable */ }
audio.setMuted(soundPref === 'off');
ui.setMutedIcon(audio.isMuted());
let soundHintShown = false;

function toggleSound() {
  audio.unlock();
  audio.setMuted(!audio.isMuted());
  ui.setMutedIcon(audio.isMuted());
  try { localStorage.setItem('rkr-sound', audio.isMuted() ? 'off' : 'on'); } catch (e) { /* ignore */ }
  if (!audio.isMuted()) audio.play('click');
  syncTrack();
}
ui.onMuteClick(toggleSound);
// Settings (settings.js): volumes, which songs, graphics, keys. From the main menu and the Esc menu.
const SONG_NAMES = ['SONG 1', 'SONG 2', 'SONG 3', 'WE SKATE'];
function applyVolumes() {
  audio.setVolumes(musicVolume(), sfxVolume());
  track.volume = trackVol();
}
applyVolumes();
// graphics quality picked in the settings, switched on the spot (mid-run too): resolution, shadows (on / off, map size,
// soft or hard), particles (new effects; a level's weather from the next level). Antialiasing only on the next load
// (the browser fixes it when the renderer is made). Returns whether this pick wants different antialiasing.
function applyGraphics(pick) {
  const wantAA = setQuality(pick);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
  const type = QUALITY.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  const relink = renderer.shadowMap.enabled !== QUALITY.shadows || renderer.shadowMap.type !== type;
  renderer.shadowMap.enabled = QUALITY.shadows;
  renderer.shadowMap.type = type;
  const sun = lighting.sun;
  if (sun.shadow.mapSize.x !== QUALITY.shadowMap) {
    sun.shadow.mapSize.set(QUALITY.shadowMap, QUALITY.shadowMap);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }   // (made again at the new size)
  }
  sun.shadow.radius = QUALITY.softShadows ? 1 : 1.5;
  // shadows on / off or another kind: every material builds its shader again (a short hitch, once)
  if (relink) scene.traverse((o) => { const m = o.material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true; });
  renderer.shadowMap.needsUpdate = true;
  return wantAA !== QUALITY.antialias;
}
ui.onSettingsClick(() => {
  releaseAllInput();
  openSettings(document.getElementById('ui'), {
    music: {
      songs: songsHere().map((i) => [i, SONG_NAMES[i]]),
      on: (i) => !musicOff() && songOn(i),
      toggle: toggleSong,
      // the order: shuffled or the songs' own (from now on; the song playing goes on)
      shuffle: {
        get: () => shuffleOn,
        set: (on) => { shuffleOn = on; try { localStorage.setItem('rkr-shuffle', on ? '1' : '0'); } catch { /* ignore */ } playOrder = shuffledOrder(trackIdx); },
      },
      // We Skate's speed (once it's unlocked)
      speed: songUnlocked ? {
        choices: SKATE_SPEEDS.map((x) => [x, x + '×']),
        get: () => skateSpeed,
        set: (x) => { skateSpeed = x; try { localStorage.setItem('rkr-skate-speed', String(x)); } catch { /* ignore */ } setRate(); },
      } : null,
    },
    // who may invite you, and the players whose invites you blocked
    invites: {
      choices: [['on', 'ON'], ['friends', 'FRIENDS ONLY'], ['off', 'OFF']],
      get: invitesFrom,
      set: setInvitesFrom,
      blocked: () => blockedInviters().length,
      clearBlocked: () => setBlockedInviters([]),
    },
    onVolume: applyVolumes,
    onGraphics: applyGraphics,
    onKeys: () => ui.refreshKeys(),
    // the global chat: on / off, and hidden while you play a Multiplayer game
    globalChat: { get: () => gchatOn, set: setGchatOn, mp: () => gchatHideMp, setMp: setGchatHideMp },
  });
});
ui.onMenuClick(() => {
  if (mode !== 'play' || runOver()) return;
  if (online.playing) toggleOnlineMenu(); else togglePause();
});

// ---------- camera zoom (on your kitty): mouse wheel, + / -, a two-finger pinch, a controller's right stick ----------
// camZoom scales the camera's distance while playing: 1 = the usual view, down to ZOOM_MIN (closer) and up to ZOOM_MAX
// (a little further out). Remembered.
const ZOOM_MIN = 0.3, ZOOM_MAX = 1.25;
let camZoom = 1;
try { camZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +localStorage.getItem('rkr-zoom') || 1)); } catch { /* ignore */ }
let zoomSaveT = 0;
// Full screen on a computer (Settings, or the browser's F11): the kitty stays the size it has in a maximised window
// (about 2:1 on a 16:9 screen), so the extra height shows more of the level above and below it.
const TALL_ASPECT = 2, TALL_MAX = 1.2;
function tallView() {
  if (TOUCH || !(document.fullscreenElement || window.innerHeight >= screen.height - 1)) return 1;
  return Math.max(1, Math.min(TALL_MAX, TALL_ASPECT / camera.aspect));
}
function zoomBy(f) {
  camZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camZoom * f));
  clearTimeout(zoomSaveT);
  zoomSaveT = setTimeout(() => { try { localStorage.setItem('rkr-zoom', String(Math.round(camZoom * 1000) / 1000)); } catch { /* ignore */ } }, 400);
}

// ---------- input ----------
const keys = new Set();
// Movement: the keys picked in the settings (WASD unless changed), the arrows always too. Co-op: P1 is mouse-driven
// (see below), P2 uses these keys.
const moveKeys = () => ({ up: [key('up'), 'ArrowUp'], down: [key('down'), 'ArrowDown'], left: [key('left'), 'ArrowLeft'], right: [key('right'), 'ArrowRight'] });
const spectateDir = (code) => (code === 'ArrowLeft' || code === key('left') ? -1 : code === 'ArrowRight' || code === key('right') || code === key('watch') ? 1 : 0);

window.addEventListener('keydown', (e) => {
  if (!e.code) return;   // a synthetic event (the controller's B in the lobby): not a key to hold
  // (Solo / Local: the chat box is there too, for /dance and /feedback: soloChat)
  if (e.key === 'Enter' && (online.room || (soloChat && !paused)) && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input')) {
    e.preventDefault();
    chat.open();
    return;
  }
  audio.unlock();
  if (e.code !== key('sound')) syncTrack(); // browsers only start media after a user gesture
  if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  // standing: Tab looks at the next kitty (Shift+Tab: the one before), round to your own again
  if (e.code === key('watch') && canWatch() && !meDown() && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    if (!e.repeat) cycleWatch(e.shiftKey ? -1 : 1);
    return;
  }
  // spectating (online, your kitty down): Left/Right/A/D/Tab switch the watched kitty. These presses are kept out
  // of `keys` so they don't count as movement held from before a revive (keyup deletes them harmlessly).
  if (spectateDir(e.code) && spectating() && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    if (!e.repeat) cycleWatch(e.code === key('watch') && e.shiftKey ? -1 : spectateDir(e.code));
    return;
  }
  // zoom: + / - (also the number pad), not while typing
  const zoomIn = e.code === key('zoomIn') || e.code === 'NumpadAdd', zoomOut = e.code === key('zoomOut') || e.code === 'NumpadSubtract';
  if ((zoomIn || zoomOut) && mode === 'play' && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    zoomBy(zoomIn ? 0.9 : 1 / 0.9);
    return;
  }
  if (e.repeat) { keys.add(e.code); return; }
  // (Space: back to your own kitty; a new move too, unless switched off in the settings)
  if (lookingAway() && (e.code === key('back') || (lookBack() && isMoveKey(e.code)))) watchId = null;
  keys.add(e.code);
  if (e.code === key('sound')) {
    toggleSound();
  } else if ((e.code === key('pause') || e.code === 'Escape') && mode === 'play' && !runOver()) {
    if (online.playing) toggleOnlineMenu();
    else togglePause();
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.key === 'Meta') keys.clear();   // macOS sends no keyup for keys let go while Cmd was held
});
// lose focus (alt-tab etc.): let go of everything, the mouse button and a pinch too (their release never arrives)
function releaseAllInput() { keys.clear(); mouse.held = false; mouse.target = null; pinch.id = null; }
window.addEventListener('blur', () => { releaseAllInput(); if (mode === 'play' && !online.playing && !paused && sim.state === 'playing') togglePause(); });
window.addEventListener('pointerdown', () => { audio.unlock(); syncTrack(); });

// navigator.getGamepads() snapshot, taken once per tick() and shared by readInput / padActive / pollPadNav
let framePads = [];
function anyKey(list) { for (const k of list) if (keys.has(k)) return true; return false; }

function readInput(index, playerCount) {
  const map = playerCount === 1 || index === 1 ? moveKeys() : null;
  let x = 0, z = 0;
  if (map) {
    if (anyKey(map.left)) x -= 1;
    if (anyKey(map.right)) x += 1;
    if (anyKey(map.up)) z -= 1;
    if (anyKey(map.down)) z += 1;
  }
  // Gamepads: pad i drives player i (if present).
  // (one kitty on this device: the first connected controller, whatever slot the browser put it in)
  const pad = framePads && (playerCount === 1 ? Array.prototype.find.call(framePads, (q) => q && q.connected) : framePads[index]);
  if (pad && pad.connected) {
    let gx = pad.axes[0] || 0, gz = pad.axes[1] || 0;
    if (pad.buttons[14]?.pressed) gx = -1;
    if (pad.buttons[15]?.pressed) gx = 1;
    if (pad.buttons[12]?.pressed) gz = -1;
    if (pad.buttons[13]?.pressed) gz = 1;
    if (Math.hypot(gx, gz) > 0.18) { x = gx; z = gz; }
  }
  const m = Math.hypot(x, z);
  if (m > 1) { x /= m; z /= m; }
  return { x, z };
}

// Mouse: always drives player 1 (in co-op too). Click = run to that spot, hold = steer toward cursor.
const mouse = { ndc: new THREE.Vector2(), has: false, held: false, target: null, iceDir: null };
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseHit = new THREE.Vector3();

// Touch: a floating joystick wherever the thumb lands (anywhere on screen, so it never covers the kitty).
// Drag direction = screen direction the kitty moves; letting go = no input (stop, or keep sliding on ice).
const JOY_R = 55, JOY_DEAD = 8;
let touchId = null;
const joy = { on: false, ox: 0, oy: 0, x: 0, y: 0 };
const joyEl = document.createElement('div');
joyEl.innerHTML = '<div></div>';
joyEl.style.cssText = `position:fixed;left:0;top:0;width:${JOY_R * 2}px;height:${JOY_R * 2}px;margin:-${JOY_R}px 0 0 -${JOY_R}px;border-radius:50%;` +
  'border:3px solid rgba(255,255,255,.55);background:rgba(20,10,40,.22);pointer-events:none;z-index:5;display:none;';
joyEl.firstChild.style.cssText = 'position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;' +
  'background:rgba(255,255,255,.75);box-shadow:0 2px 8px rgba(0,0,0,.35);';
document.body.appendChild(joyEl);
function drawJoy() {
  joyEl.style.display = joy.on ? 'block' : 'none';
  if (!joy.on) return;
  joyEl.style.transform = `translate(${joy.ox}px,${joy.oy}px)`;
  // the knob follows the thumb but stops at the rim
  const dx = joy.x - joy.ox, dy = joy.y - joy.oy, d = Math.hypot(dx, dy), k = d > JOY_R ? JOY_R / d : 1;
  joyEl.firstChild.style.transform = `translate(${dx * k}px,${dy * k}px)`;
}
function joyMove(e) {
  joy.x = e.clientX; joy.y = e.clientY;
  // the base stays where the thumb first landed (past the rim = full speed in that direction), so swinging the thumb
  // around never brings it back near the middle and slows the kitty down
  drawJoy();
}
const _camRight = new THREE.Vector3(), _camFwd = new THREE.Vector3();
function joyInput() {
  const dx = joy.x - joy.ox, dy = joy.y - joy.oy, d = Math.hypot(dx, dy);
  if (d < JOY_DEAD) return { x: 0, z: 0 };
  // screen right/up -> ground directions as the camera sees them
  _camRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  camera.getWorldDirection(_camFwd).setY(0).normalize();
  const m = Math.min(1, d / JOY_R) / d;
  const sx = dx * m, sy = -dy * m;
  return { x: _camRight.x * sx + _camFwd.x * sy, z: _camRight.z * sx + _camFwd.z * sy };
}
function setMouseNdc(e) {
  mouse.ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  mouse.has = true;
}
function mouseGround() {
  raycaster.setFromCamera(mouse.ndc, camera);
  return raycaster.ray.intersectPlane(groundPlane, mouseHit) ? { x: mouseHit.x, z: mouseHit.z } : null;
}
// a second finger pinches (zoom) while the first keeps steering
const pinch = { id: null, x: 0, y: 0, d: 0 };
const fingerGap = () => Math.hypot(pinch.x - joy.x, pinch.y - joy.y);
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'play') return;
  e.preventDefault();
  zoomBy(Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.004));
}, { passive: false });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (e.pointerId === touchId) joyMove(e); // only the first finger steers
    else if (e.pointerId === pinch.id) { pinch.x = e.clientX; pinch.y = e.clientY; }
    if (pinch.id !== null && touchId !== null) { const d = fingerGap(); if (pinch.d > 20 && d > 20) zoomBy(pinch.d / d); pinch.d = d; }
    return;
  }
  setMouseNdc(e);
});
canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (mode !== 'play' || paused || (e.button !== 0 && e.button !== 2)) return;
  if (warming()) return;   // the new level isn't on screen yet: a click would steer the kitty somewhere unseen
  // looking at a friend: this click steers nothing (it is aimed at their view); it brings the camera back, unless
  // that is switched off in the settings (then only Space / Tab do)
  // (a finger is the joystick, not aimed at anything: it steers as always)
  if (lookingAway()) { if (lookBack()) watchId = null; if (e.pointerType !== 'touch') return; }
  if (e.pointerType === 'touch') {
    if (touchId !== null) {   // a second finger: pinch to zoom
      if (pinch.id === null) { pinch.id = e.pointerId; pinch.x = e.clientX; pinch.y = e.clientY; pinch.d = fingerGap(); try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      return;
    }
    touchId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    joy.on = true; joy.ox = joy.x = e.clientX; joy.oy = joy.y = e.clientY;
    if (pinch.id !== null) pinch.d = fingerGap();   // a pinch still going: measure from here (no jump)
    mouse.target = null; mouse.iceDir = null;
    drawJoy();
    return;
  }
  setMouseNdc(e);
  mouse.held = true;
  mouse.iceDir = null;
  mouse.target = mouseGround();
  if (mouse.target) targetPulse = 1;
});
function pointerEnd(e) {
  if (e.pointerType === 'touch') {
    if (e.pointerId === pinch.id) { pinch.id = null; return; }
    if (e.pointerId !== touchId) return;
    touchId = null;
    joy.on = false;
    drawJoy();
    return;
  }
  mouse.held = false;
}
window.addEventListener('pointerup', pointerEnd);
window.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function mousePlayerIndex() {
  if (online.playing) return sim.players.findIndex((p) => p.id === online.me);
  return 0;
}

function mouseInput(p, kb) {
  if (Math.hypot(kb.x, kb.z) > 0.1 || !p.alive) { mouse.target = null; mouse.iceDir = null; return kb; }
  // a new level still being prepared (the last picture stays up): no click steering, the kitty would walk off unseen
  // and seem to teleport when the level shows
  if (warming()) { mouse.target = null; mouse.iceDir = null; mouse.held = false; return kb; }
  if (joy.on) return joyInput();
  if (p.waitRelease) {
    // the sim holds the kitty until it reads "let go" once: a click (or a press held from before the checkpoint)
    // would aim at a spot the frozen kitty never reaches and keep it stuck, so drop it and send a release
    mouse.target = null; mouse.iceDir = null; mouse.held = false;
    return kb;
  }
  if (mouse.held && mouse.has && !lookingAway()) mouse.target = mouseGround() || mouse.target;   // (not from a friend's view: it holds the last spot)
  if (!onIce(sim.levelData, p.x, p.z)) mouse.iceDir = null;
  else if (mouse.held || mouse.iceDir) {
    // ice: a click sets a direction to skate in (not a spot to stop at); holding keeps steering at the cursor
    if (mouse.target) {
      const dx = mouse.target.x - p.x, dz = mouse.target.z - p.z, d = Math.hypot(dx, dz);
      if (mouse.held && d > 0.3) mouse.iceDir = { x: dx / d, z: dz / d };
      else if (mouse.iceDir && dx * mouse.iceDir.x + dz * mouse.iceDir.z < 0) mouse.target = null; // slid past the spot
    }
    return mouse.iceDir || kb;
  } else if (mouse.target) {
    const dx = mouse.target.x - p.x, dz = mouse.target.z - p.z, d = Math.hypot(dx, dz);
    if (d > 0.3) { mouse.iceDir = { x: dx / d, z: dz / d }; return mouse.iceDir; }
  }
  if (!mouse.target) return kb;
  const dx = mouse.target.x - p.x, dz = mouse.target.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.15) { if (!mouse.held) mouse.target = null; return { x: 0, z: 0 }; }
  const m = Math.min(1, d / 0.6) / d; // ease in on arrival so the kitty stops cleanly
  return { x: dx * m, z: dz * m };
}

// Ground marker showing where the mouse kitty is headed.
let targetPulse = 0;
const targetMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.44, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), // exact player colour
);
targetMarker.rotation.x = -Math.PI / 2;
targetMarker.visible = false;
scene.add(targetMarker);

function updateTargetMarker(dt) {
  const p = sim && sim.players[mousePlayerIndex()];
  if (mode !== 'play' || !p || !p.alive || !mouse.target) { targetMarker.visible = false; return; }
  targetMarker.visible = true;
  targetMarker.material.color.set(p.color);
  targetPulse = Math.max(0, targetPulse - dt * 3);
  const s = 1 + targetPulse * 0.8 + Math.sin(simTime * 6) * 0.06;
  targetMarker.scale.set(s, s, s);
  targetMarker.position.set(mouse.target.x, 0.04, mouse.target.z);
}

// ---------- game state ----------
let mode = 'title';      // 'title' | 'play'
let paused = false;
let sim = null;
let playerCount = 1;
let localSetup = { mode: undefined, names: [], easy: false, hell: false, chain: false };   // single player / co-op: the mode and names from the setup screen (lobby.js)
let simTime = 0;         // presentation clock (seconds)
let accumulator = 0;
let gameOverShown = false;
let victory = null;       // the final run is beaten: { sim, t, ev, shown, shownAt, lobbyAt, nextFw, song } (presentation only)
let intro = null;         // the final run's opening fly-over: { sim, t }
// the run is over: everyone down, or the final run was beaten (no pause menu, no game-over screen after a win)
function runOver() { return sim.state === 'gameover' || sim.state === 'victory'; }

// Visual bindings
let view = null;          // { levelData, world, portal, wolves: Map, items: Map, circles: Map }
const kitties = new Map(); // playerId -> { model, dustT }
const prevPos = new Map(); // id -> {x,z} for interpolation (players 'p'+id, enemies 'e'+id)

function newSeed() { return hashSeed(Date.now(), Math.random()) >>> 0; }

function startSim(players, startLevel, simMode = DEBUG_MODE, easy = false, hell = false, chain = false) {
  sim = createSim({ seed: newSeed(), players, startLevel: hell ? startLevel : stageStep(simMode || 'mixed', LATEST_FV, startLevel, DEBUG_NIGHT), mode: simMode, finales: LATEST_FV, easy, hell, waves: hell, chain: chain && players.length > 1 });
  if (DEBUG_WINS) for (const p of sim.players) { p.finishes = DEBUG_WINS; p.crowned = true; }
  if (DEBUG_RESCUES) for (const p of sim.players) p.rescues = DEBUG_RESCUES;
  if (DEBUG_CHEST) sim.chestAlways = true;
  accumulator = 0;
  gameOverShown = false;
  victory = null;
  intro = null;
  prevPos.clear();
}

function clearView() {
  if (!view) return;
  view.world.dispose();
  scene.remove(view.world.group);
  disposeModel(view.portal.group);
  disposeModel(view.crown.group);
  if (view.fish) disposeModel(view.fish.group);
  if (view.chest) disposeModel(view.chest.group);
  view.wolfPack.dispose(); // wolf models are proxy rigs outside the scene (cached geometries, no GPU state)
  if (view.heatPack) view.heatPack.dispose();
  if (view.waves) view.waves.pack.dispose();
  for (const it of view.items.values()) disposeModel(it.group);
  for (const c of view.circles.values()) disposeModel(c.group);
  view = null;
}

const HERO_SAVES = 5;
function buildView() {
  clearView();
  const ld = sim.levelData;
  // a newspaper about the kitty with the most revives this run (HERO_SAVES or more), if there is one
  let hero = null;
  for (const p of sim.players) if ((p.rescues || 0) >= HERO_SAVES && (!hero || p.rescues > hero.saves)) hero = { name: p.name, saves: p.rescues };
  const world = buildWorld(scene, ld, hero);
  if (world.group.parent !== scene) scene.add(world.group);
  lighting.setTheme(ld.theme, ld);   // the final run: hell, warming to gold at the goal room
  const portal = createPortalModel();
  scene.add(portal.group);
  const crown = createCrownPickupModel();
  crown.group.position.set(ld.crown.x, 0, ld.crown.z);
  scene.add(crown.group);
  // one posable rig per wolf type (they all look alike within a type), a little state per wolf (its stride etc.)
  const wolves = new Map(), rigs = new Map();
  for (const e of sim.enemies) {
    // the look goes by how it runs: crossers cutting across the last lanes' junction at a slant wear the diagonals' coat
    const spec = ld.enemies[e.id], kind = spec && spec.pattern === 'junction-crosser' ? 'diagonal' : e.type;
    let r = rigs.get(kind);
    if (!r) {
      // scarier every level, dressed for the season; wild: a shaggy ruff of fur round the neck instead of a collar
      const rig = createWolfRig(kind, { level: ld.level, theme: ld.theme, finale: !!ld.finale, wild: true });
      rig.group.scale.setScalar(CFG.WOLF_RADIUS / 0.55); // models are built for the original 0.55 radius
      r = { rig, n: 0 };
      rigs.set(kind, r);
    }
    r.n++;
    wolves.set(e.id, { rig: r.rig, st: newWolfState(), lastHeading: undefined });
  }
  const wolfPack = createWolfPack(scene, [...rigs.values()].map((r) => [r.rig, r.n])); // draws all wolves instanced
  // the black wolves' heat as they turn round (syncVisuals): their parts again, glowing, for as many as can be in view
  const ch = rigs.get('charger');
  const heatN = ch ? Math.min(ch.n, 64) : 0;
  const heatPack = ch && ld.finale ? createWolfPack(scene, [[ch.rig, heatN]], HEAT_MAT) : null;
  // hell's wolf waves (shared/waves.js): their own instanced pack on one shared rig
  let waves = null;
  if (sim.hell && sim.waves) {
    const rig = createWolfRig('wanderer', { level: ld.level, theme: ld.theme, finale: true, wild: true });
    rig.group.scale.setScalar(CFG.WOLF_RADIUS / 0.55);
    waves = { rig, pack: createWolfPack(scene, [[rig, WAVE_PACK_CAP]]), strides: [0, 1, 2, 3].map(() => newWolfState()), snaps: [[], [], [], []], warned: -1 };
  }
  const items = new Map();
  for (const it of sim.items) if (!it.taken) items.set(it.id, itemView(it, ld));
  // the final run: a giant fish waits in the goal room for the kitties (eaten client-side, see feast())
  let fish = null;
  if (ld.finale) { fish = createGiantFishModel(); scene.add(fish.group); }
  view = { levelData: ld, world, portal, crown, fish, chest: null, wolves, wolfPack, heatPack, heatN, waves, items, circles: new Map() };
  prevPos.clear();
  warmShaders();
}

// Get every material of the level ready on the GPU while it loads. A shader is otherwise compiled the first time its
// material is drawn: the first checkpoint coming into view, the first revive beam / teleport sparkles, the first
// wolf of a kind on screen, the first kitty down (ghost + revive circle)... each a hitch of 20-150 ms mid-run. Hidden
// things are shown for the call only; with KHR_parallel_shader_compile (compileAsync) the driver compiles in the
// background instead of stalling the frame.
// While the driver compiles them in the background (compileAsync), drawing would just wait for it (a frame of ~0.7 s at
// a level start): keep showing the last picture instead, until they're ready (WARM_HOLD_MS at most).
const WARM_HOLD_MS = 2000;
let warmExtras = null, warmHoldUntil = 0;
function warming() { return !!warmHoldUntil && performance.now() < warmHoldUntil; }   // drawing held for the shaders
function warmShaders() {
  if (!warmExtras) {   // things that only exist later (a kitty down): one hidden copy of each, kept for this
    warmExtras = new THREE.Group();
    warmExtras.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), ghostMaterial()), createReviveCircleModel(0xffffff).group);
    warmExtras.visible = false;
    scene.add(warmExtras);
  }
  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  try {
    // compile everything, then wait for the shaders like renderer.compileAsync does, but a material thrown away
    // meanwhile (a model replaced) counts as done: three's own check crashed on it and the picture stayed held
    const mats = renderer.compile(scene, camera);
    if (mats && mats.size && renderer.properties) {
      const hold = performance.now() + WARM_HOLD_MS;
      warmHoldUntil = hold;
      const check = () => {
        if (warmHoldUntil !== hold) return;   // (a newer level's warm-up took over)
        for (const m of mats) { const pr = renderer.properties.get(m).currentProgram; if (!pr || pr.isReady()) mats.delete(m); }
        if (mats.size) setTimeout(check, 10); else warmHoldUntil = 0;
      };
      check();
    }
  } catch { /* a missing shader just compiles on first use, as before */ }
  for (const o of hidden) o.visible = false;
}

function ensureKitties() {
  for (const p of sim.players) {
    if (!kitties.has(p.id)) {
      const model = createKittyModel(p.color);
      // Player-colored ground marker with a heading pip (readability + co-op identity).
      // not tone mapped: shows the exact swatch colour (ACES would wash it out), never brighter than it
      const mat = new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.7, 40), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      const pipShape = new THREE.Shape();
      pipShape.moveTo(0.95, 0); pipShape.lineTo(0.76, 0.14); pipShape.lineTo(0.76, -0.14); pipShape.closePath();
      const pip = new THREE.Mesh(new THREE.ShapeGeometry(pipShape), mat);
      pip.rotation.x = -Math.PI / 2;
      pip.position.y = 0.03;
      model.group.add(ring, pip);
      scene.add(model.group);
      kitties.set(p.id, { model, dustT: 0, stepN: 0, fx: new THREE.Color(p.color), trail: createIceTrail(scene), auraTrail: createAuraTrail(scene, p.color), paws: createPawPrints(scene, p.color) });
    }
  }
  for (const [id, k] of kitties) {
    if (!sim.players.find((p) => p.id === id)) { disposeModel(k.model.group); k.trail.dispose(); k.auraTrail.dispose(); k.paws.dispose(); kitties.delete(id); }
  }
}

function removeKitties() {
  for (const g of chainGroups) g.visible = false;
  for (const k of kitties.values()) { disposeModel(k.model.group); k.trail.dispose(); k.auraTrail.dispose(); k.paws.dispose(); }
  kitties.clear();
}

// ---------- flow ----------
function enterTitle(showTitleScreen = true) {
  if (online.menu) { online.menu = false; ui.hidePause(); }
  if (mode === 'play' && sim) analytics.runEnd(runSummary());
  mode = 'title';
  paused = false;
  online.playing = false;
  ui.hideVictory();
  if (showTitleScreen) legends.reset(); // back to the lobby keeps an open board (sign while the others head back)
  ui.hideHUD();
  removeKitties();
  startSim([], 1 + Math.floor(Math.random() * 3));
  stepSim(sim, {}, CFG.TICK); // generate level
  buildView();
  if (showTitleScreen) ui.showTitle(onTitlePick);
  musicPlay(1);
}

// LOCAL (solo or co-op, picked on the setup screen with name, kitty colour, mode; lobby.js), then the run.
// Phones have no second keyboard player: solo only. The last pick is remembered.
const LOCAL_N_KEY = 'rkr-local-players';
function onTitlePick({ players }) {
  if (players === 3) return openOnline();
  audio.unlock();
  audio.play('click');
  let n = 1;
  if (!TOUCH) { try { n = localStorage.getItem(LOCAL_N_KEY) === '2' ? 2 : 1; } catch { /* ignore */ } }
  lobbyUI.showLocal(n, {
    mode: DEBUG_MODE,   // ?mode= (offline testing) preselects
    coop: !TOUCH,
    onPlayers: (k) => { try { localStorage.setItem(LOCAL_N_KEY, String(k)); } catch { /* ignore */ } },
    onStart: ({ mode: m, names, players: k, easy, hell, chain }) => { localSetup = { mode: m, names, easy: !!easy, hell: !!hell, chain: !!chain }; startGame(k); },
    onBack: () => ui.showTitle(onTitlePick),
  });
}

function startGame(n, level = DEBUG_LEVEL) {
  goFullscreenLandscape();
  audio.unlock();
  audio.play('click');
  playerCount = n;
  ui.hideTitle();
  ui.hideGameOver();
  ui.hideVictory();
  legends.reset();
  mode = 'play';
  paused = false;
  const players = [];
  const slots = localSlots(n); // player 1 in the preferred colour (kittycolor.js)
  // the names from the setup screen (empty: the colour's own name)
  for (let i = 0; i < n; i++) players.push({ id: i + 1, name: localSetup.names[i] || PLAYER_NAMES[slots[i]], color: PLAYER_COLORS[slots[i]] });
  removeKitties();
  // (hell from level 1; local testing (localhost): ?level=2 starts a Hell game on hell level 2)
  const hellAt = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? Math.min(HELL_LEVELS, level) : 1;
  startSim(players, localSetup.hell ? hellAt : level, localSetup.mode || DEBUG_MODE, !!localSetup.easy, !!localSetup.hell, !!localSetup.chain);
  analytics.runStart(n === 1 ? 'solo' : 'coop', sim.mode || 'mixed', !!sim.hell, chained(), !!sim.easy);
  cameraSnap = true;
  // First step emits levelStart which triggers buildView.
}

function togglePause() {
  paused = !paused;
  if (paused) {
    // LEAVE GAME: back to the title screen (the run is dropped)
    ui.showPause(() => { paused = false; ui.hidePause(); }, () => enterTitle(), { online: false });
  } else {
    ui.hidePause();
  }
  audio.play('click');
}

// stats for the anonymous play counter: your own kitty online, the whole team offline
function runSummary() {
  const me = online.playing ? playerById(online.me) : null;
  return me ? { deaths: me.deaths, rescues: me.rescues } : { deaths: sim.stats.deaths, rescues: sim.stats.rescues };
}

function playerById(id) { return sim.players.find((p) => p.id === id); }
function hexCss(c) { return '#' + c.toString(16).padStart(6, '0'); }

function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'levelStart': {
        pregenNext(sim); // the next level, off the main thread (offline nextLevel and online loadLevel pick it up)
        mouse.target = null; mouse.iceDir = null;
        buildView();
        ensureKitties();
        for (const k of kitties.values()) k.paws.clear(); // prints belong to the old map
        // an easy game starting over from its repaired checkpoint (Run + Skate's level 9): it is still repaired
        if (ev.retry && ev.cp != null) {
          if (!sim.checkpointsHit.includes(ev.cp)) sim.checkpointsHit.push(ev.cp);
          if (view && view.world.repairCheckpoint) view.world.repairCheckpoint(ev.cp);
        }
        for (const p of sim.players) effects.teleport(p.x, p.z, p.color);
        const finale = !!sim.levelData.finale;
        const L = sim.levelData.level || ev.level, night = stageOf(sim.mode, sim.finales, sim.level).night;
        // hell: its first level opens like level 9, every next one is a new hell (easy hell: a level starting over)
        const hellNext = sim.hell && sim.level > 1;
        // (an easy game's retry: just the level and 'Once more!', no WELCOME TO HELL again)
        if (ev.retry) ui.banner(sim.hell ? `HELL ${sim.level}` : `LEVEL ${L}${night ? ' · NIGHT' : ''}`, 'Once more!', 2200, finale ? 'finale' : undefined);
        else if (hellNext) ui.banner(`HELL ${sim.level}`, sim.level >= HELL_LEVELS ? 'The last one!' : 'A new hell…', 2600, 'finale');
        else if (finale) ui.banner('WELCOME TO HELL', 'Think you can escape?', 4200, 'finale');
        // (the swag menu shows level 9's unlocks from now on; not from someone's hell lobby: that doesn't open hell here)
        if (finale) { if (!sim.hell) try { localStorage.setItem('rkr-seen9', '1'); } catch { /* ignore */ } }
        else if (ev.retry) { /* (shown above) */ }
        else if (night) ui.banner(`LEVEL ${L} · NIGHT`, 'Lace up your skates!', 2200);
        else ui.banner(`LEVEL ${L}`, levelSubtitle(L), 2200);
        if (audio.isMuted() && !soundHintShown) {
          soundHintShown = true;
          ui.toast('Sound is off. Press M or click the speaker to turn it on', '#b9a4ff');
        }
        audio.play(finale && !ev.retry && !hellNext ? 'finale' : 'levelStart');
        if (finale && !ev.retry) effects.shake(0.35);
        musicPlay(L);
        cameraSnap = true;   // everyone is back at the start: no glide from the old goal while you can already move
        // the final run: the camera stays on the start square, pushing in, until you touch anything
        intro = finale && !ev.retry && !hellNext ? { sim, t: 0 } : null;
        break;
      }
      case 'wipe': {   // an easy game: everyone is down, the level starts over in a moment
        haptic('error');
        const cps = sim.levelData.checkpoints || [];
        ui.toast(sim.checkpointsHit.some((c) => cps[c] && cps[c].medic) ? 'Everyone is down: back to the checkpoint' : 'Everyone is down: the level starts over', '#ffcf5a', 'down');
        break;
      }
      case 'death': {
        const p = playerById(ev.playerId);
        if (mine(ev.playerId)) haptic('heavy');
        effects.deathPoof(ev.x, ev.z, p ? p.color : 0xffffff);
        // (versus: another team's kitty: your cat giggles at it, no shake, so it doesn't sound like one of yours)
        const foe = sim.versus && p && p.team !== (sim.players.find((q) => q.id === online.me) || {}).team;
        if (!foe) effects.shake(0.55);
        audio.play(foe ? 'foeSnickerD' : 'death', { pan: panFor(ev.x) });
        const alive = sim.players.filter((q) => q.alive).length;
        if (p && alive > 0) downToast(p);
        break;
      }
      case 'extraLife': {
        const p = playerById(ev.playerId);
        if (mine(ev.playerId)) haptic('medium');
        effects.reviveBeam(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.floatText(ev.x, 1.6, ev.z, 'EXTRA LIFE!', '#ff8fb8');
        effects.shake(0.3);
        audio.play('extraLife');
        break;
      }
      case 'revive': {
        if (ev.cp) break;   // (brought back by a checkpoint: its own effects, case 'checkpoint')
        const p = playerById(ev.playerId);
        const by = playerById(ev.by);
        if (mine(ev.playerId) || mine(ev.by)) haptic('medium');
        if (by && (by.rescues || 0) >= 120) effects.callingCard(ev.x, ev.z, by.color, iconLook(by));   // 120+ revives: the rescuer's calling card, as their player card looks
        effects.reviveBeam(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.floatText(ev.x, 1.6, ev.z, 'SAVED!', p ? hexCss(p.color) : '#fff');
        audio.play('revive', { pan: panFor(ev.x) });
        // (only to the two of them: everyone sees SAVED! over the kitty; with 8 kitties these toasts never stopped)
        if (p && by && (mine(ev.playerId) || mine(ev.by))) ui.toast(`${by.name} saved ${p.name}!`, hexCss(by.color));
        break;
      }
      case 'crown': {
        const p = playerById(ev.playerId);
        const c = sim.levelData.crown;
        effects.pickup(c.x, c.z, 0xffd34a);
        effects.floatText(c.x, 2.2, c.z, 'CROWN!', '#ffd34a');
        audio.play('extraLife');
        if (p) ui.toast(`👑 ${p.name} grabbed the crown!`, hexCss(p.color));
        break;
      }
      case 'checkpoint': {
        if (!sim.checkpointsHit.includes(ev.index)) sim.checkpointsHit.push(ev.index);   // (online: the minimap's flags)
        const by = playerById(ev.by);
        haptic('medium');
        // the kitties gathered there (ev.moved; older servers: everyone but the one that reached it) drop their old heading
        const mp = sim.players[mousePlayerIndex()];
        if (!mp || (ev.moved ? ev.moved.includes(mp.id) : mp.id !== ev.by)) { mouse.target = null; mouse.iceDir = null; }
        // one of the kitties the camera follows was moved there: show it at once (no glide while it can already run)
        const wasMoved = (id) => (ev.moved ? ev.moved.includes(id) : id !== ev.by);
        if (sim.players.some((p) => (!online.playing || p.id === online.me) && wasMoved(p.id))) cameraSnap = true;
        if (ev.medic && sim.easy) {   // an easy game: any kitty repairs it, and everyone starts again from it
          ui.banner('CHECKPOINT FIXED!', 'If everyone goes down, you start again from here', 3200);
          if (view && view.world.repairCheckpoint) view.world.repairCheckpoint(ev.index);
        } else if (ev.medic) {   // the broken checkpoint, repaired (level version 16+: by any kitty; before: one with 60+ revives)
          // (a little bonus: repaired by a kitty with 60+ revives this run, the one with the wings, it's the medicat's banner)
          const medicat = !!by && (by.rescues || 0) >= 60;
          ui.banner(medicat ? 'MEDICAT TO THE RESCUE!!!' : 'CHECKPOINT FIXED!', ev.revived.length ? `${by ? by.name : 'A kitty'} fixed the checkpoint: everyone is back on their paws` : `${by ? by.name : 'A kitty'} fixed the checkpoint`, 2600);
          if (view && view.world.repairCheckpoint) view.world.repairCheckpoint(ev.index);
        } else ui.banner('CHECKPOINT!', ev.revived.length ? 'Everyone is back on their paws' : (by && sim.players.length > 1 ? `${by.name} gathered the team` : 'Keep going!'), 1600);
        effects.teleport(ev.x, ev.z, by ? by.color : 0x8fdcff);
        effects.reviveBeam(ev.x, ev.z, ev.medic ? 0xff5a6a : 0x8fdcff);
        audio.play('revive');
        break;
      }
      case 'chest': {   // the lottery: a big chest on this checkpoint
        if (!sim.chest) sim.chest = { x: ev.x, z: ev.z, open: false };   // (online: the server's sim made it)
        ui.banner('LUCKY CHECKPOINT!', 'Step on the chest', 2600);
        effects.confetti(ev.x, ev.z);
        audio.play('extraLife');
        break;
      }
      case 'voteKill': {   // a kitty that stood still voted down by the others (online)
        const p = playerById(ev.playerId);
        if (p) ui.toast(mine(ev.playerId) ? 'You were voted out for standing still' : `${p.name} was voted out for standing still`, hexCss(p.color));
        break;
      }
      case 'medicGift': {   // the broken checkpoint repaired by a medic (60+ revives): a life and 4 boots in the square
        for (const [id, type, x, z, mega] of ev.items) if (!sim.items.some((it) => it.id === id)) sim.items.push({ id, type, x, z, taken: false, ...(mega ? { mega: true } : {}) });
        effects.confetti(ev.x, ev.z);
        audio.play('extraLife');
        break;
      }
      case 'chestOpen': {
        if (!sim.chest) sim.chest = { x: ev.x, z: ev.z };
        sim.chest.open = true;
        for (const [id, type, x, z, mega] of ev.items) if (!sim.items.some((it) => it.id === id)) sim.items.push({ id, type, x, z, taken: false, ...(mega ? { mega: true } : {}) });
        if (view && view.chest) view.chest.open();
        const by = playerById(ev.by);
        ui.banner('JACKPOT!', by && sim.players.length > 1 ? `${by.name} opened the chest` : 'Grab it all!', 2600);
        effects.confetti(ev.x, ev.z);
        effects.shake(0.4);
        haptic('success');
        audio.play('levelClear');
        break;
      }
      case 'pickup': {
        if (mine(ev.playerId)) haptic('light');
        const colors = { boots: 0x5ff3ff, life: 0xff6fa8, shield: 0x7aa8ff };
        const labels = { boots: 'SPEED UP!', life: '+1 LIFE', shield: 'SHIELD!' };
        effects.pickup(ev.x, ev.z, colors[ev.itemType] || 0xffffff);
        effects.floatText(ev.x, 1.4, ev.z, ev.mega ? 'MAX SPEED!' : labels[ev.itemType] || '', hexCss(colors[ev.itemType] || 0xffffff));
        audio.play(ev.itemType, { pan: panFor(ev.x) });
        const m = view && view.items.get(ev.itemId);
        if (m) { disposeModel(m.group); view.items.delete(ev.itemId); }
        break;
      }
      case 'enterCenter': {
        const p = playerById(ev.playerId);
        if (p) {
          effects.pickup(p.x, p.z, p.color);
          audio.play('pickup');
          // the disc only makes you safe: the crown in the middle clears the level (wait for your friends first)
          if (mine(p.id) && !sim.crownTaken) ui.toast(sim.players.length > 1 ? 'Safe! Grab the crown in the middle when your team is ready' : 'Safe! Grab the crown in the middle to finish', '#ffcf5a');
        }
        break;
      }
      case 'stageClear': {
        // Run + Skate by day: the goal is a checkpoint, the night half of the same level comes next
        haptic('success');
        effects.confetti(0, 0);
        effects.shake(0.2);
        const by = playerById(ev.by);
        ui.banner(by && sim.players.length > 1 ? `${by.name.toUpperCase()} MADE IT!` : 'MADE IT!', 'Night falls… off to the ice!', 2000);
        audio.play('levelClear');
        break;
      }
      case 'levelClear': {
        haptic('success');
        effects.confetti(0, 0);
        effects.shake(0.2);
        if (!sim.hell) analytics.level(ev.level);
        if (sim.hell && online.playing) setTimeout(() => account.refresh(), 2000);   // (the server counted it: the new song may be unlocked)
        if (sim.hell && sim.level < HELL_LEVELS) {   // hell: on to the next one, the same map
          const by = playerById(ev.by);
          ui.banner(by && sim.players.length > 1 ? `${by.name.toUpperCase()} MADE IT!` : 'MADE IT!', `Hell ${sim.level + 1} next…`, 2000, 'finale');
          audio.play('levelClear');
          break;
        }
        if (sim.levelData.finale) break; // the final run: the 'victory' event that follows throws the party
        const by = playerById(ev.by);
        ui.banner(by && sim.players.length > 1 ? `${by.name.toUpperCase()} MADE IT!` : 'MADE IT!', 'Everyone back to the start…', 2000);
        audio.play('levelClear');
        break;
      }
      case 'gameOver': {
        haptic('error');
        analytics.runEnd(runSummary());
        audio.play('gameOver');
        musicStop();
        break;
      }
      case 'victory': {
        startVictory(ev);
        break;
      }
      case 'shieldEnd': {
        const p = playerById(ev.playerId);
        if (p) effects.shieldPop(p.x, p.z);
        audio.play('shieldEnd');
        break;
      }
    }
  }
}

// haptics: only for your own kitty online; every kitty on this device offline
function mine(id) { return !online.playing || id === online.me; }
// one 'down' toast for everyone who's down, updated as more go down (not one per kitty); versus: your own team's only
function downToast(p) {
  const team = sim.versus ? (sim.players.find((q) => q.id === online.me) || {}).team : undefined;
  if (sim.versus && p.team !== team) return;
  const down = sim.players.filter((q) => !q.alive && (!sim.versus || q.team === team)), others = down.filter((q) => q.id !== p.id);
  const text = !others.length ? `${p.name} is down! Touch their circle to revive`
    : down.length === 2 ? `${p.name} and ${others[0].name} are down!` : `${down.length} kitties are down!`;
  ui.toast(text, hexCss(p.color), 'down');
}

// ---------- the final run: opening fly-over and the victory party ----------
const FW_COLORS = [0xff5c8a, 0xffd23f, 0x3ee08f, 0x4cc9ff, 0xb388ff, 0xff8c42, 0xffffff];
const FW_KINDS = ['peony', 'peony', 'ring', 'willow'];

function launchFirework(fuse) {
  const R = (sim.levelData.roomHalf || 8) - 1;
  const a = Math.random() * Math.PI * 2;
  const x0 = Math.cos(a) * R, z0 = Math.sin(a) * R;
  const x = (Math.random() * 2 - 1) * 6, z = (Math.random() * 2 - 1) * 6 - 2, y = 7 + Math.random() * 5;
  // mostly the kitties' own colours
  const pc = sim.players.length && Math.random() < 0.6 ? sim.players[(Math.random() * sim.players.length) | 0].color : null;
  const color = pc != null ? pc : FW_COLORS[(Math.random() * FW_COLORS.length) | 0];
  const color2 = Math.random() < 0.5 ? color : FW_COLORS[(Math.random() * FW_COLORS.length) | 0];
  const kind = FW_KINDS[(Math.random() * FW_KINDS.length) | 0];
  audio.play('fireworkLaunch', { pan: panFor(x0), volume: 0.6, pitch: 0.9 + Math.random() * 0.25 });
  effects.firework(x0, z0, x, y, z, {
    color, color2, kind, fuse, scale: QUALITY.particles,
    onBurst: (bx) => { audio.play('fireworkBoom', { pan: panFor(bx), volume: 0.7, pitch: 0.85 + Math.random() * 0.3 }); effects.shake(0.06); },
  });
}

function startVictory(ev) {
  if (victory && victory.sim === sim) return;
  victory = { sim, t: 0, ev: ev || null, shown: false, nextFw: 1.6, song: false };
  intro = null;
  mouse.target = null; mouse.iceDir = null;
  if (online.menu) { online.menu = false; ui.hidePause(); } // the victory screen replaces the online menu
  analytics.runEnd({ ...runSummary(), won: true });
  if (!online.playing && !sim.easy && !sim.hell) {
    // offline win: the board, and a line for each local kitty (player 1 signs with the saved online name if there is one)
    const p1 = savedName();
    legends.fetchOffline({
      mode: sim.mode, time: sim.time, runTime: ev && Number.isFinite(ev.time) ? ev.time : sim.levelTime, ...(chained() ? { chain: true } : {}),
      players: sim.players.map((p, i) => ({ name: i === 0 && p1 ? p1 : p.name, color: p.color })),
    });
  }
  musicStop();
  audio.play('victory');   // a soft ta-daa, then We Skate (updateVictory)
  if (online.playing) setTimeout(() => account.refresh(), 2000);   // the server counted the win: the new song may be unlocked
  effects.confetti(0, 0);
  effects.shake(0.6);
  effects.reviveBeam(0, 0, 0xffd34a);
  // kitties that went down on the way were carried into the room for the party
  for (const id of (ev && ev.party) || []) {
    const p = playerById(id);
    if (p) { effects.teleport(p.x, p.z, p.color); prevPos.delete('p' + p.id); }
  }
  const by = ev ? playerById(ev.by) : null;
  ui.banner('VICTORY!', sim.hell ? `You got through all ${HELL_LEVELS} levels of hell!` : by && sim.players.length > 1 ? `${by.name} reached the end first!` : 'You beat the final run!', 3800, 'gold');
  for (let i = 0; i < 3; i++) launchFirework(0.6 + i * 0.3); // opening salvo
}

// a pickup's model, in place
function itemView(it, ld) {
  const m = createItemModel(it.type);
  if (it.mega) m.group.scale.setScalar(1.7);   // level 9's big pair of boots (full speed at once)
  m.group.position.set(it.x, inTree(ld, it.x, it.z) ? 2.2 : 0, it.z); // tree boots sit on the canopy
  scene.add(m.group);
  return m;
}
// the pickups drawn again from sim.items (the server's list replaced ours)
function rebuildItemViews() {
  for (const m of view.items.values()) disposeModel(m.group);
  view.items.clear();
  for (const it of sim.items) if (!it.taken) view.items.set(it.id, itemView(it, sim.levelData));
}

function updateVictory(dt) {
  if (victory && (victory.sim !== sim || mode !== 'play' || sim.state !== 'victory')) victory = null;
  if (!victory && mode === 'play' && sim.state === 'victory') startVictory(null); // missed the event: still party
  if (!victory) return;
  const v = victory;
  if (!(dt > 0)) return;
  v.t += dt;
  v.nextFw -= dt;
  while (v.nextFw <= 0) {
    launchFirework();
    v.nextFw += v.t < 10 ? 0.25 + Math.random() * 0.4 : 0.9 + Math.random() * 1.5; // a big show, then a calmer one
  }
  if (!v.song && v.t > 1.1) { v.song = true; musicVictorySong(sim.levelData.level || sim.level); }   // as the ta-daa ends
  if (v.t < 7) effects.confettiRain(0, 0, 10, Math.max(1, Math.round(3 * QUALITY.particles)));
  if (view && view.fish) {
    if (!v.feastCue && v.t > 2.4) { v.feastCue = true; if (!view.fish.done()) { const h = view.fish.headPos(); effects.floatText(h.x * 0.75, 2.4, h.z * 0.75, 'FISH FEAST!', '#ffb27a'); } }
    if (v.shown) ui.updateVictoryFish(Math.floor(view.fish.eaten() * 100));
  }
  if (!v.shown && v.t > 5.5) { v.shown = true; v.shownAt = v.t; showVictoryScreen(); }
  // online: the server sent everyone back to the lobby; give the victory screen a few seconds, then follow
  if (v.lobbyAt != null && online.playing && v.shown && v.t - Math.max(v.lobbyAt, v.shownAt) > 5) {
    ui.hideVictory();
    backToLobby();
  }
}

// A kitty's icon looks (player card, share card, revive calling card), as its 3D model has them: sunglasses 5+ wins,
// rainbow 8+ wins and 60+ revives, lion 14+ wins, and at 16 wins the chrome (under 60 revives), rainbow (60-119) or
// celestial lion (120+)
function iconLook(p) {
  const look = iconLookOf(p);
  // the mane's own metal (a switched-on unlock), on a metal kitty only (chrome lion, bronze / golden kitty)
  const mm = slotMetal(cosOf(p), 'mane');
  if (mm && look.lion && (look.lionLook === 'chrome' || look.metal)) look.maneMetal = mm;
  const lm = slotMetal(cosOf(p), 'lens');   // (the lenses' own metal, likewise)
  if (lm && look.cool && (look.lionLook === 'chrome' || look.metal)) look.lensMetal = lm;
  if (cosOf(p).has('nolensshine')) look.lensStill = true;   // (the glasses' shine switched off)
  // local testing (?look=lion / chrome, as on the 3D kitty)
  if (DEBUG_LOOK.has('lion') || DEBUG_LOOK.has('chrome')) look.lion = true;
  if (DEBUG_LOOK.has('chrome')) look.lionLook = 'chrome';
  if (DEBUG_LOOK.has('shades') || DEBUG_LOOK.has('shades-dark') || DEBUG_LOOK.has('shades-bright')) look.cool = true;
  if (DEBUG_LOOK.has('gold') || DEBUG_LOOK.has('bronze')) { look.lion = true; look.metal = DEBUG_LOOK.has('gold') ? 'gold' : 'bronze'; }
  for (const m of ['chrome', 'gold', 'bronze']) { if (DEBUG_LOOK.has('mane-' + m)) look.maneMetal = m; if (DEBUG_LOOK.has('lens-' + m)) look.lensMetal = m; }   // (drafts)
  return look;
}
function iconLookOf(p) {
  const wins = (p && p.finishes) || 0, res = (p && p.rescues) || 0, cos = cosOf(p);
  // the golden / bronze kitty (unlocks: legends board number 1s), unless this run earned a look of its own
  const metalU = (sim.easy || (wins < 16 && !(wins >= 8 && res >= 60))) ? (cos.has('gold') ? 'gold' : cos.has('bronze') ? 'bronze' : null) : null;
  // an easy game: only the switched-on unlocks (its own rewards have no icon looks)
  // (specs: its reading glasses; metal: the bronze kitty at 8 wins with 60 revives, the golden one at 16 with 120)
  if (sim.easy) {
    const earned = cos.has('chrome') ? null : wins >= 16 && res >= 120 ? 'gold' : wins >= 8 && res >= 60 ? 'bronze' : null;
    return { cool: cos.has('shades'), specs: (wins >= 5 || cos.has('specs')) && !cos.has('shades'), rainbow: false, lion: cos.has('lion'), lionLook: cos.has('chrome') && !metalU ? 'chrome' : null,
      metal: metalU === 'gold' || earned === 'gold' ? 'gold' : metalU || earned };
  }
  const rainbow = wins >= 8 && res >= 60;
  return {
    cool: wins >= 5 || cos.has('shades'), specs: wins < 5 && !cos.has('shades') && cos.has('specs'), rainbow, lion: wins >= 14 || cos.has('lion'),   // (the chrome kitty: a mane only with the Lion mane switched on)
    // the 16-win looks come first; a switched-on chrome lion otherwise (but not over the rainbow cat's own rainbow)
    lionLook: wins >= 16 ? (res >= 120 ? 'celestial' : res >= 60 ? 'rainbow' : 'chrome') : cos.has('chrome') && !rainbow && !metalU ? 'chrome' : null,
    metal: metalU,
  };
}
// A kitty's switched-on account unlocks (shared/unlocks.js): online from the room info (the server checked the
// account), offline player 1's own signed-in account. Looks only.
const NO_COS = new Set();
function cosOf(p) {
  if (!p) return NO_COS;
  if (online.playing) {
    const r = online.roster.get(p.id);
    if (!r || !r.cos) return NO_COS;
    if (r._cosFrom !== r.cos) { r._cosFrom = r.cos; r._cos = new Set(r.cos); }
    return r._cos;
  }
  return p === sim.players[0] ? account.equipped(sim.mode) : NO_COS;   // (kitty 1: whoever plays on this device, account or not)
}

// Share the run's result (share.js: an image card of your kitty + a short text with the link). Your own kitty: the
// one this device plays (online) or player 1; level / time / crowns / revives as the end screens show them.
function shareRun(win, time) {
  const me = (online.playing ? playerById(online.me) : null) || sim.players[0] || {};
  const r = {
    win, mode: sim.mode || 'mixed', level: sim.hell ? sim.level : sim.levelData.level || sim.level, time,
    ...(sim.hell ? { hell: true, far: win ? 1 : sim.far } : {}),
    crowns: me.finishes || 0, revives: me.rescues || 0, name: me.name, color: me.color, team: sim.players.length,
    ...iconLook(me),   // the face as your player card shows it
  };
  shareResult(r).then((how) => {
    if (how === 'saved') ui.toast('Picture saved and text copied: paste it with your post', '#3ee08f');
    else if (how === 'copied') ui.toast('Result copied: paste it anywhere', '#3ee08f');
    else if (how === 'failed') ui.toast('Sharing is not available here', '#ff8fb8');
  });
}

// a kitty's scoreboard score: +1 per friend saved, -1 per time caught, up to 20 per map for how far it ran itself (p.ran,
// sim.js trackRun), +5 per win (the crown); from an older server (no p.ran) the old +20 per win
function playerScore(p) {
  const dist = p.ran === undefined ? 0 : Math.round(20 * p.ran), crownPts = (p.ran === undefined ? 20 : 5) * (p.finishes || 0);
  return (p.rescues || 0) + (p.bonus || 0) - (p.deaths || 0) + dist + crownPts;
}

function showVictoryScreen() {
  const ev = victory.ev;
  const by = ev ? playerById(ev.by) : null;
  const wasOnline = online.playing;
  const stats = {
    runTime: ev && Number.isFinite(ev.time) ? ev.time : (wasOnline ? undefined : sim.levelTime),
    totalTime: Math.max(0, sim.time - victory.t), // time at the win (online, sim.time only arrives with the snapshots)
    deaths: sim.stats.deaths, rescues: sim.stats.rescues, mode: sim.mode || 'mixed', hell: !!sim.hell,
    fish: view && view.fish ? Math.floor(view.fish.eaten() * 100) : undefined,
    first: by ? { name: by.name, color: by.color } : null,
    players: sim.players.map((p) => ({ name: p.name, color: p.color, first: !!by && p.id === by.id })),
    // the kitties by their score (the top 3 and you, the rest behind "+N more": ui.js rankHTML)
    ranking: sim.players.map((p) => ({ name: p.name, color: p.color, score: playerScore(p), crowns: p.finishes || 0, caught: p.deaths || 0, me: wasOnline && p.id === online.me }))
      .sort(rankOrder),
    ...(sim.versus ? { versus: vsRanking() } : {}),   // (versus: the teams instead)
  };
  const buttons = wasOnline
    ? [{ label: 'BACK TO LOBBY', onClick: () => backToLobby() }]
    : [{ label: 'PLAY AGAIN', sub: 'from level 1', onClick: () => startGame(playerCount, 1) },
      { label: 'MAIN MENU', alt: true, onClick: () => enterTitle() }];
  // finishers only: online the server sends the board to the winners; offline it was fetched at the win (read-only)
  victory.legendsBtn = !sim.hell && (!wasOnline || legends.available());   // (hell: its own board, in LEVEL TIMES)
  if (victory.legendsBtn) {
    buttons.push({ label: 'LEGENDS BOARD', sub: legends.canSign() ? 'sign your name' : 'see who did it', alt: true, mini: true, keep: true, onClick: () => legends.open() });
  }
  buttons.push({ label: 'SHARE', sub: 'your result', green: true, mini: true, keep: true, onClick: () => shareRun(true, stats.totalTime) });
  ui.showVictory(stats, buttons);
}

function padActive() {
  for (const pad of framePads || []) {
    if (!pad || !pad.connected) continue;
    if (Math.abs(pad.axes[0] || 0) > 0.3 || Math.abs(pad.axes[1] || 0) > 0.3) return true;
    if (pad.buttons.some((b) => b.pressed)) return true;
  }
  return false;
}

// The fly-over ends by itself, or the moment anyone touches a control / a kitty moves (it never holds anyone back).
function updateIntro(dt) {
  if (!intro) return;
  if (intro.sim !== sim || mode !== 'play' || sim.state !== 'playing' || paused) { intro = null; return; }
  intro.t += dt;
  const moved = sim.players.some((p) => (!online.playing || p.id === online.me) && p.alive && Math.hypot(p.vx, p.vz) > 0.5);
  if (intro.t > 5.2 || moved || keys.size > 0 || mouse.held || joy.on || padActive()) intro = null;
}

// Gamepad on the overlays (victory / game over / pause): A or Start = confirm, d-pad / stick left-right = switch.
// On the legends board: B or Start closes it, d-pad up/down (or the right stick) scrolls.
const padNav = { confirm: false, prev: false, next: false, back: false, spPrev: false, spNext: false };
// The menus (title, online lobby screens, single player / co-op setup, pause menu, notices) get a highlight moved
// with the d-pad / left stick, A = press, B = back (padnav.js). Start pauses a run (offline) or opens the menu
// (online), and closes the pause menu again.
const menuPad = createPadNav();
let padNavAt = performance.now();
function pollPadNav() {
  const now = performance.now(), dt = Math.min(0.1, (now - padNavAt) / 1000);
  padNavAt = now;
  let confirm = false, prev = false, next = false, back = false, scroll = 0, spPrev = false, spNext = false, lb = false, rb = false;
  let y = false, a = false, bBtn = false, start = false, select = false, up = false, down = false, left = false, right = false;
  for (const pad of framePads || []) {
    if (!pad || !pad.connected) continue;
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    lb = lb || b(4); rb = rb || b(5); y = y || b(3);
    spPrev = spPrev || b(4) || b(14); // LB / d-pad left
    spNext = spNext || b(5) || b(15); // RB / d-pad right
    confirm = confirm || b(0) || b(9);
    prev = prev || b(14) || b(12) || ax < -0.6;
    next = next || b(15) || b(13) || ax > 0.6;
    back = back || b(1) || b(9);
    scroll += (b(13) ? 1 : 0) - (b(12) ? 1 : 0) + (Math.abs(pad.axes[3] || 0) > 0.3 ? pad.axes[3] : 0);
    a = a || b(0); bBtn = bBtn || b(1); start = start || b(9); select = select || b(8);
    up = up || b(12) || ay < -0.55; down = down || b(13) || ay > 0.55;
    left = left || b(14) || ax < -0.55; right = right || b(15) || ax > 0.55;
  }
  const aEdge = a && !padNav.a, bEdge = bBtn && !padNav.b, startEdge = start && !padNav.start;
  // Select / View / Share: sound on / off, anywhere (like M)
  if (select && !padNav.select) { toggleSound(); ui.toast(audio.isMuted() ? 'Sound off' : 'Sound on', '#b9a4ff'); }
  const dir = up ? 'up' : down ? 'down' : left ? 'left' : right ? 'right' : '';
  const pauseEl = ui.pauseRoot();
  const fbEl = feedback.isOpen() ? feedback.root() : null;
  const statsEl = document.querySelector('.rks-modal');   // the STATS window (analytics.js)
  const setEl = settingsRoot();   // the SETTINGS window (over the title or the pause menu)
  const acctEl = account.isOpen() ? document.querySelector('.rka-modal') : null;   // the SWAG ACCOUNT window (account.js)
  const menu = legends.isOpen() ? null
    : setEl || acctEl || fbEl || statsEl || pauseEl || ui.noticeRoot() || ui.gameOverRoot() || (lobbyUI.isOpen() && !(online.playing && mode === 'play') ? lobbyUI.root() : null) || ui.titleRoot();
  const res = menuPad.poll(menu, { dir, a: aEdge, b: bEdge }, dt);
  if (legends.isOpen()) {
    if (back && !padNav.back) legends.close();
    else if (scroll) legends.scrollBy(scroll * 14);
  } else if (setEl) {
    if (res === 'back') closeSettings();
  } else if (acctEl) {
    if (res === 'back') account.close();
  } else if (fbEl) {
    if (res === 'back') feedback.close();
  } else if (statsEl) {
    if (res === 'back') { const b = statsEl.querySelector('button'); if (b) b.click(); }
  } else if (pauseEl) {
    if (res === 'back' || startEdge) ui.navigate('confirm');   // B / Start: back to the run
  } else if (menu) {
    // B: back (the lobby browser / setup go back to the title on Esc, lobby.js)
    if (res === 'back' && lobbyUI.isOpen()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  } else if (ui.isOverlayOpen()) {
    if (prev && !padNav.prev) ui.navigate('prev');
    if (next && !padNav.next) ui.navigate('next');
    if (confirm && !padNav.confirm) ui.navigate('confirm');
  } else {
    if (spectating()) {
      if (spPrev && !padNav.spPrev) cycleWatch(-1);
      if (spNext && !padNav.spNext) cycleWatch(1);
    } else if (canWatch() && !meDown() && !chat.isOpen()) {   // standing: LB / RB look at a friend (the d-pad moves), B: back
      if (lb && !padNav.lb) cycleWatch(-1);
      if (rb && !padNav.rb) cycleWatch(1);
      if (bEdge && lookingAway()) watchId = null;
    }
    if (y && !padNav.y && !chat.isOpen()) dance();   // Y: dance (the first emote; a wheel once there are more)
    // Start in a run: pause (offline) / the online menu
    if (startEdge && mode === 'play' && !runOver() && !chat.isOpen()) { if (online.playing) toggleOnlineMenu(); else togglePause(); }
  }
  padNav.confirm = confirm; padNav.prev = prev; padNav.next = next; padNav.back = back;
  padNav.spPrev = spPrev; padNav.spNext = spNext; padNav.lb = lb; padNav.rb = rb; padNav.y = y;
  padNav.a = a; padNav.b = bBtn; padNav.start = start; padNav.select = select;
}

// one line per level (levels past 8: the last one); some of them are hints (see CFG.MUSIC_BOOST and the level rules
// after it)
function levelSubtitle(level) {
  const tips = [
    'Get to the middle',
    'Music makes you go faster',
    'CATJAM',
    'Speed is life',
    'Never leave a kitty behind',
    'Grind never stops',
    'Getting close!',
    'Is it over...?',
  ];
  return tips[Math.min(level, tips.length) - 1];
}

function panFor(x) {
  return Math.max(-1, Math.min(1, (x - camTarget.x) / 18));
}

// ---------- camera ----------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 40, 30);
let camDist = 22;
let cameraSnap = true;
const CAM_DIR = new THREE.Vector3(0, 0.83, 0.56).normalize(); // ~56° pitch, looking toward -Z
// victory: the camera pulls back and slowly orbits the goal room at a lower pitch (so the fireworks are in view)
let camOrbit = 0, camYaw = 0;
const _orbDir = new THREE.Vector3(), _camDir = new THREE.Vector3();
const smooth01 = (v) => { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v); };
// online, while your kitty is down: the camera stays on it (its revive circle), and you can switch to a kitty still
// standing (cycleWatch). A watched kitty that falls too: back to your own. watchId: who is watched (your own id: you).
// Still standing yourself, you can look at a friend the same way (Tab): the camera follows them until you move, they
// go down, or the level changes; watchId is then their id (null: your own kitty, as always).
let watchId = null, wasDown = false, watchIdle = false;   // watchIdle: no move since looking away (myInput)
const meDown = () => { const me = online.playing ? playerById(online.me) : null; return !!me && !me.alive; };
// standing and looking at a friend: your kitty keeps running as it was (keys held, or toward the spot clicked); a new
// move key or a click brings the camera back to you (and that click steers nothing: it was aimed at the friend's view)
const lookingAway = () => watchId != null && watchId !== online.me && online.playing && !meDown();
const MOVE_CODES = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const isMoveKey = (code) => MOVE_CODES.includes(code) || code === key('up') || code === key('down') || code === key('left') || code === key('right');
function pickWatch(meP) {
  const cur = watchId != null && watchId !== meP.id ? playerById(watchId) : null;
  if (cur && cur.alive) return cur;
  watchId = meP.id;
  return null;
}
// what you can switch to while spectating: your own kitty and the ones still standing, in player order (stable, so
// cycling is predictable)
function watchCandidates() {
  return sim.players.filter((p) => p.alive || p.id === online.me);
}
function spectating() {   // (down: Left / Right / A / D switch too, they steer nothing)
  return online.playing && mode === 'play' && watchId != null && sim.state !== 'gameover' && !online.menu && meDown();
}
function canWatch() { return online.playing && mode === 'play' && sim.state !== 'gameover' && !online.menu; }
// manual switch: Left/Right/A/D/Tab, the pill's ‹ › buttons, or gamepad shoulders / d-pad. The pick sticks
// (pickWatch keeps an alive watchId) until that kitty goes down (then: your own again) or you're revived.
function cycleWatch(dir) {
  if (!canWatch()) return;
  const down = meDown();
  if (down && watchId == null) return;
  // (standing, with "moving returns the camera" off: Tab only goes through the other kitties, Space alone comes back)
  const others = !down && !lookBack();
  const list = watchCandidates().filter((p) => !others || p.id !== online.me);
  if (list.length < (others ? 1 : 2)) return;
  const i = list.findIndex((p) => p.id === (watchId != null ? watchId : online.me));
  const next = list[((i < 0 ? (dir > 0 ? 0 : -1) : i + dir) % list.length + list.length) % list.length].id;
  watchId = !down && next === online.me ? null : next;   // (standing: your own kitty is just the usual camera)
  haptic('light');
}
// phones: a binoculars button with the corner buttons looks at a friend, and brings the camera back (the pill's ‹ ›: the next)
// A dance button beside it (Multiplayer, standing): the chat's /dance. (One emote so far; a wheel once there are more.)
// Solo / Local: no server, the kitties here just dance.
function dance() {
  if (mode !== 'play') return;
  if (online.playing) { if (!meDown()) net.send({ t: 'emote', e: 'dance' }); return; }
  if (online.room || paused) return;
  for (const p of sim.players) { const k = p.alive && kitties.get(p.id); if (k) k.dance = 0.001; }
}
// Solo / Local runs have the chat box too, as a place to type /dance and /feedback (nobody to talk to)
let soloChat = false;
function syncSoloChat() {
  const on = mode === 'play' && !online.room && !online.playing;
  if (on === soloChat) return;
  soloChat = on;
  if (online.room) return;   // (a lobby's chat is its own business)
  if (on) chat.clear();
  chat.setEnabled(on);
}
let watchBtn = null, danceBtn = null;
function cornerBtn(label, svg, onClick) {
  const row = document.querySelector('.rkr-tr');
  if (!row) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rkr-hudbtn';
  b.innerHTML = svg;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); b.blur(); });
  row.insertBefore(b, row.querySelector('button'));   // (left of the other buttons, right of the key hints)
  b.addEventListener('mousedown', (e) => e.preventDefault());   // (keeps the keyboard focus off it, like the others)
  return b;
}
function updateWatchBtn() {
  const standing = canWatch() && !meDown() && sim.state === 'playing';
  const show = TOUCH && standing && watchCandidates().length > 1;
  syncSoloChat();
  const canDance = standing || (soloChat && !paused && sim.state === 'playing');   // (the dance button: computers and Solo / Local too)
  if (!danceBtn && canDance) {
    danceBtn = cornerBtn('Dance', '<svg viewBox="0 0 40 40"><path d="M12.5 9.5 L12 1.5 L18.5 5 Z M25.5 9.5 L26 1.5 L19.5 5 Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><ellipse cx="19" cy="11" rx="7.5" ry="6.2" fill="currentColor"/><ellipse cx="19" cy="24" rx="4.6" ry="6.5" fill="currentColor"/><path d="M15.5 20.5 L7 16 M22.5 20.5 L30 14.5 M16.5 28.5 L11 36 M21.5 28.5 L25 36 M23 27.5 Q34 30 33.5 21.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      () => { dance(); haptic('light'); });
  }
  if (danceBtn) danceBtn.style.display = canDance ? '' : 'none';
  if (!watchBtn && show) {
    watchBtn = cornerBtn('Watch a friend', '<svg viewBox="0 0 40 40"><path d="M9 8 H16 V17 M31 8 H24 V17 M16 14 H24 M9 8 L5 22 M31 8 L35 22" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11.5" cy="25.5" r="7" fill="none" stroke="currentColor" stroke-width="3.2"/><circle cx="28.5" cy="25.5" r="7" fill="none" stroke="currentColor" stroke-width="3.2"/><circle cx="11.5" cy="25.5" r="2.4" fill="currentColor"/><circle cx="28.5" cy="25.5" r="2.4" fill="currentColor"/></svg>',
      () => { if (lookingAway()) watchId = null; else cycleWatch(1); });
  }
  if (!watchBtn) return;
  const on = show && lookingAway();
  watchBtn.style.display = show ? '' : 'none';
  watchBtn.style.borderColor = on ? 'rgba(140,220,255,.8)' : '';
  watchBtn.style.color = on ? '#bfeaff' : '';
  watchBtn.setAttribute('aria-pressed', String(on));
}
const FINE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
let watchEl = null, watchNameEl = null, watchShown = '';
// Chained (online), joining up (server.js joinVote / joinAsk): one button. Standing on a kitty left on its own on its chain
// (its ring, body or it; not on your chain): vote it into your group (more than half of your chain, versus your team).
// Being that kitty (down too): say yes to a group voting for you, or ask to join one with a kitty of it near you. It
// joins once both are there; the snapshots carry the votes (online.jv: [its id, group, votes, it said yes, one of them])
let joinEl = null, joinShown = '';
const JOIN_TOUCH = CFG.REVIVE_RADIUS + CFG.KITTY_RADIUS, JOIN_ASK = 6;
function joinGroup(p) {
  const mine = sim.chains.find((c) => c.includes(p.id)) || [p.id];
  const group = sim.versus ? sim.players.filter((q) => q.team === p.team) : mine.map(playerById).filter(Boolean);
  return { group, key: sim.versus ? 't' + p.team : 'c' + Math.min(...group.map((q) => q.id)), need: Math.floor(group.length / 2) + 1,
    name: sim.versus ? (sim.vsNames && sim.vsNames[p.team]) || 'their team' : p.name + "'s chain" };
}
function updateJoinBtn() {
  const me = online.playing && mode === 'play' && sim && sim.chain && sim.state === 'playing' ? playerById(online.me) : null;
  let text = '', act = null;
  const myLone = me && sim.chains.find((g) => g.includes(me.id) && g.length > 1 && g.filter(playerById).length === 1);
  if (me && myLone) {
    // its own: a group voting for it (say yes), else one of another group near it (ask)
    const jv = (online.jv || []).filter(([id]) => id === me.id);
    const spots = [me, ...myLone.map((o) => sim.anchors[o]).filter(Boolean)];
    const near = sim.players.find((q) => q.alive && !myLone.includes(q.id) && spots.some((s) => Math.hypot(q.x - s.x, q.z - s.z) < JOIN_ASK));
    const e = jv.find((v) => !v[3]) || jv[0], T = e ? playerById(e[4]) : near;
    if (T) {
      const g = joinGroup(T), n = e ? e[2] : 0, asked = !!(e && e[3]);
      text = asked ? `✓ ASKED: ${g.name.toUpperCase()} ${n}/${g.need}` : (n ? `⛓ JOIN ${g.name.toUpperCase()}? ${n}/${g.need}` : `⛓ ASK TO JOIN ${g.name.toUpperCase()}`);
      act = asked ? null : { t: 'joinask', to: T.id };
    }
  } else if (me && me.alive) {
    for (const g of sim.chains) {
      const here = g.map(playerById).filter(Boolean);
      if (g.includes(me.id) || here.length !== 1 || g.length < 2) continue;
      const spots = [here[0], ...g.map((o) => sim.anchors[o]).filter(Boolean)];
      if (!spots.some((s) => Math.hypot(me.x - s.x, me.z - s.z) < JOIN_TOUCH)) continue;
      const L = here[0], mg = joinGroup(me), v = (online.jv || []).find(([id, k]) => id === L.id && k === mg.key), n = v ? v[2] : 0;
      online.joinVoted ||= new Set();
      const voted = online.joinVoted.has(L.id + ':' + mg.key) && n > 0;
      text = (voted ? '✓ VOTED' : `⛓ ADD ${L.name.toUpperCase()} TO YOUR ${sim.versus ? 'TEAM' : 'CHAIN'}`) + (mg.need > 1 || n ? ` ${n}/${mg.need}` : '') + (v && !v[3] ? ' (waiting for them)' : '');
      act = voted ? null : { t: 'joinvote', id: L.id, mark: L.id + ':' + mg.key };
      break;
    }
  }
  if (text && !joinEl) {
    joinEl = document.createElement('button');
    joinEl.style.cssText = 'position:fixed;left:50%;bottom:27%;transform:translateX(-50%);z-index:5;height:38px;padding:0 16px;border:0;border-radius:999px;' +
      'background:linear-gradient(180deg,#c9b6ff,#8f6bff);color:#fff;font:800 14px system-ui,sans-serif;cursor:pointer;touch-action:manipulation;white-space:nowrap;box-shadow:0 3px 0 #3a1650;';
    joinEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    joinEl.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); joinEl.blur();
      const a = joinEl.act;
      if (!a) return;
      if (a.mark) { online.joinVoted ||= new Set(); online.joinVoted.add(a.mark); }
      net.send(a.t === 'joinask' ? { t: 'joinask', to: a.to } : { t: 'joinvote', id: a.id });
      audio.play('click');
    });
    document.body.appendChild(joinEl);
  }
  if (joinEl) { joinEl.act = act; joinEl.style.opacity = act ? '1' : '0.7'; joinEl.style.cursor = act ? 'pointer' : 'default'; }
  if (text === joinShown) return;
  joinShown = text;
  if (joinEl) { joinEl.textContent = text; joinEl.style.display = text ? '' : 'none'; }
}

function updateWatchLabel() {
  const p = online.playing && mode === 'play' && watchId != null && sim.state !== 'gameover' ? playerById(watchId) : null;
  const multi = !!p && watchCandidates().length > 1;
  const hint = !multi || !FINE_POINTER ? '' : meDown() ? '  (← → to switch)' : `  (${keyName(key('watch'))} to switch · ${keyName(key('back'))} to go back)`;
  // the kitty watched standing still (AFK): vote to kill it from here (the only place a vote starts; then everyone sees
  // it under the top middle, ui.js paintVotes)
  const h = p && p.afk ? hudPlayers.find((q) => q && q.id === p.id) : null;
  const vote = h && !h.you && h.canVote ? (h.voted ? '✓ VOTED' : '💀 VOTE KNOCK DOWN') + (h.afkVotes ? ` ${h.afkVotes}/${h.afkNeed}` : '') : '';
  const shown = p ? p.id + '|' + p.name + '|' + multi + '|' + hint + '|' + vote + '|' + !!(h && h.canVote && !h.voted) : '';
  if (shown === watchShown) return;
  watchShown = shown;
  if (!watchEl) {
    watchEl = document.createElement('div');
    watchEl.style.cssText = 'position:fixed;left:50%;bottom:18%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;' +
      'padding:2px;border-radius:999px;background:rgba(0,0,0,0.45);color:#fff;font:600 14px system-ui,sans-serif;' +
      'z-index:5;user-select:none;-webkit-user-select:none;white-space:nowrap;touch-action:manipulation;max-width:calc(100vw - 16px);';
    const mkBtn = (label, dir, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,0.18);color:#fff;' +
        'font:700 24px/1 system-ui,sans-serif;cursor:pointer;padding:0;touch-action:manipulation;flex:none;';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); cycleWatch(dir); b.blur(); });
      return b;
    };
    watchEl.prevBtn = mkBtn('‹', -1, 'Previous kitty');
    watchEl.nextBtn = mkBtn('›', 1, 'Next kitty');
    watchNameEl = document.createElement('span');
    watchNameEl.style.cssText = 'padding:4px 10px;pointer-events:none;min-width:0;overflow:hidden;text-overflow:ellipsis;';
    watchEl.voteBtn = document.createElement('button');
    watchEl.voteBtn.style.cssText = 'height:32px;margin:0 4px;padding:0 12px;border:0;border-radius:999px;background:linear-gradient(180deg,#ff6b8a,#d63c6a);color:#fff;' +
      'font:800 13px system-ui,sans-serif;cursor:pointer;touch-action:manipulation;white-space:nowrap;flex:none;';
    watchEl.voteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    watchEl.voteBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (watchEl.voteId != null) voteKill(watchEl.voteId); watchEl.voteBtn.blur(); });
    watchEl.append(watchEl.prevBtn, watchNameEl, watchEl.voteBtn, watchEl.nextBtn);
    document.body.appendChild(watchEl);
  }
  watchNameEl.textContent = p ? 'Watching ' + (p.id === online.me ? 'your kitty' : p.name) + hint : '';
  watchEl.prevBtn.style.display = watchEl.nextBtn.style.display = multi ? '' : 'none';
  const canVote = !!(h && h.canVote && !h.voted);
  watchEl.voteId = canVote ? p.id : null;
  watchEl.voteBtn.textContent = vote;
  watchEl.voteBtn.style.display = vote ? '' : 'none';
  watchEl.voteBtn.style.opacity = canVote ? '1' : '0.6';
  watchEl.voteBtn.style.cursor = canVote ? 'pointer' : 'default';
  watchEl.voteBtn.title = canVote ? `${p.name} has been standing still: vote to knock them down (they can be revived)` : '';
  watchEl.style.pointerEvents = multi || canVote ? 'auto' : 'none';
  watchEl.style.display = p ? 'flex' : 'none';
}

function updateCamera(dt, alpha) {
  let tx = 0, tz = 0, want = 22;
  if (mode === 'title') {
    const r = (sim.levelData.outerRadius || 20) * 0.35;
    const a = simTime * 0.08;
    tx = Math.cos(a) * r; tz = Math.sin(a) * r;
    want = (sim.levelData.outerRadius || 20) * 1.45 + 6;
  } else {
    let n = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const consider = (x, z) => { n++; tx += x; tz += z; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
    const meP = online.playing ? playerById(online.me) : null;
    const meAlive = !!(meP && meP.alive);
    const down = online.playing && !!meP && !meAlive && sim.state !== 'gameover';
    let watch = null;
    if (down) { watch = pickWatch(meP); wasDown = true; }
    else if (wasDown || !meAlive || !canWatch() || sim.state !== 'playing') { watchId = null; wasDown = false; }   // (back up: your own kitty again)
    else if (watchId != null) {   // standing, looking at a friend: until they go down or leave
      watch = watchId !== meP.id ? playerById(watchId) : null;
      if (!watch || !watch.alive) { watch = null; watchId = null; }
    }
    for (const p of sim.players) {
      if (!p.alive) continue;
      if (watch ? p !== watch : (meAlive && p.id !== online.me) || down) continue;
      const pp = prevPos.get('p' + p.id);
      const x = pp ? pp.x + (p.x - pp.x) * alpha : p.x;
      const z = pp ? pp.z + (p.z - pp.z) * alpha : p.z;
      consider(x + p.vx * 0.18, z + p.vz * 0.18);
    }
    if (n === 0 && down) { const c = sim.circles.find((q) => q.playerId === meP.id) || meP; consider(c.x, c.z); }   // your own kitty, where it fell
    if (n === 0) { for (const c of sim.circles) consider(c.x, c.z); }
    if (n === 0) consider(0, 0);
    tx /= n; tz /= n;
    const spread = Math.max(maxX - minX, (maxZ - minZ) * 1.4);
    want = Math.max(17, Math.min(50, 15 + spread * 0.9));
    if (sim.state === 'levelclear') want += 6;
    if (victory) { tx = 0; tz = 0; want = 30; }
  }
  let flyover = false;
  if (intro && mode === 'play') {
    // never show how long it is: the camera stays on the start square where you spawn, slowly pushing in from higher up
    tx = sim.levelData.corners[0].x; tz = sim.levelData.corners[0].z; want = 30 - 12 * smooth01(intro.t / 4.5);
    flyover = true;
  }
  if (mode === 'play' && !flyover && !victory) {
    // a controller's right stick (up = closer) zooms too
    for (const pad of framePads || []) {
      const ry = pad && pad.connected ? pad.axes[3] || 0 : 0;
      if (Math.abs(ry) > 0.3) { zoomBy(Math.exp(ry * dt * 1.4)); break; }
    }
    want *= camZoom * tallView();
  }
  const k = cameraSnap || flyover ? 1 : 1 - Math.exp(-dt * 5);
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.z += (tz - camTarget.z) * k;
  camDist += (want - camDist) * (cameraSnap ? 1 : 1 - Math.exp(-dt * 2.5));
  cameraSnap = false;
  let dir = CAM_DIR, lookY = 0;
  if (victory && mode === 'play') {
    camOrbit += (1 - camOrbit) * (1 - Math.exp(-dt * 0.9));
    camYaw += dt * 0.2 * camOrbit;
    const pitch = 0.62, cp = Math.cos(pitch);
    _orbDir.set(Math.sin(camYaw) * cp, Math.sin(pitch), Math.cos(camYaw) * cp);
    dir = _camDir.copy(CAM_DIR).lerp(_orbDir, camOrbit).normalize();
    lookY = 4 * camOrbit;
  } else {
    camOrbit = 0; camYaw = 0; // leaving the party always means a new scene
  }
  camPos.copy(camTarget).addScaledVector(dir, camDist);
  const sh = effects.getShakeOffset();
  camera.position.set(camPos.x + sh.x, camPos.y + sh.y, camPos.z + sh.z);
  camera.lookAt(camTarget.x + sh.x * 0.5, lookY, camTarget.z + sh.z * 0.5);
}

// ---------- per-frame visual sync ----------
// returns a shared scratch object (read it before the next call)
const _lerp = { x: 0, z: 0 };
function lerpPos(key, x, z, alpha) {
  const pp = prevPos.get(key);
  if (!pp) { _lerp.x = x; _lerp.z = z; return _lerp; }
  _lerp.x = pp.x + (x - pp.x) * alpha; _lerp.z = pp.z + (z - pp.z) * alpha;
  return _lerp;
}

function snapshotPrev() {
  for (const p of sim.players) {
    const k = 'p' + p.id; let o = prevPos.get(k);
    if (!o) { o = { x: 0, z: 0 }; prevPos.set(k, o); }
    o.x = p.x; o.z = p.z;
  }
  // wolves: on the wolf object itself (thousands of them: no string keys / map lookups every tick)
  for (const e of sim.enemies) { e.px = e.x; e.pz = e.z; }
}

// 6+ finishes: smoothly blend through all the cat colours, ~1 s each
const _cycB = new THREE.Color();
function cycleColor(t, out, cols = PLAYER_COLORS) {
  const n = cols.length, i = Math.floor(t) % n, f = t - Math.floor(t);
  return out.set(cols[i]).lerp(_cycB.set(cols[(i + 1) % n]), f * f * (3 - 2 * f));
}
// the celestial lion's colours of space (its aura, fire trail, prints and skate marks cycle through these instead)
const COSMIC_CYCLE = [0x7a3cff, 0x3a4dff, 0x1fa8ff, 0xc23cff, 0x5a24d0];
// an easy game's aura comes in metals, not in the kitty's colour or the rainbow: bronze (3 wins), silver (4). From 6
// the aura, prints, skate marks and aura trail all cycle bronze, silver, gold and the kitty's own colour (before that
// the prints, marks and trail are in the kitty's colour).
const EASY_BRONZE = 0xcd7f32, EASY_SILVER = 0xcfd6e0, EASY_GOLD = 0xffc93a, METAL_CYCLE = [EASY_BRONZE, EASY_SILVER, EASY_GOLD];

// ---------- the final run's giant fish: kitties next to it eat it ----------
// Pure presentation: the sim knows nothing about the fish, so every client counts its own bites from where the kitties
// stand (kitties that reached the goal are held inside the goal disc, whose rim runs along the fish's belly). A kitty
// standing still within FEAST_REACH of an uneaten chunk faces it and munches; after the win, kitties left standing
// around near the fish wander over to it by themselves (a small visual offset that melts away as soon as they move).
const FEAST_REACH = 1.3;     // gap between a kitty's centre and the fish's surface (kitties in the goal stay within ~4.7 of the origin)
const FEAST_WANDER = 4.5;    // after the win: idle kitties this close walk over by themselves (offset at most FEAST_STRAY)
const FEAST_STRAY = 7;
function feast(k, p, x, z, dt) {
  const fish = view.fish;
  if (k.ox === undefined) { k.ox = 0; k.oz = 0; k.idleT = 0; k.biteT = 0.3; k.bites = 0; }
  const st = sim.state;
  if (st !== 'playing' && st !== 'victory') { k.ox = 0; k.oz = 0; return null; }
  const still = !p.moving;
  k.idleT = still ? k.idleT + dt : 0;
  const vx = x + k.ox, vz = z + k.oz;   // where the kitty is shown
  const near = fish.nearest(vx, vz);
  if ((!near || near.d > FEAST_WANDER + 0.5) && Math.abs(k.ox) + Math.abs(k.oz) < 1e-3) { k.ox = 0; k.oz = 0; return null; }
  // standing still: stay where you are shown; moving: the offset melts away
  let wx = still ? k.ox : 0, wz = still ? k.oz : 0;
  if (victory && near && still && k.idleT > 2 && near.d > FEAST_REACH * 0.8 && near.d < FEAST_WANDER) {
    const gx = near.px - vx, gz = near.pz - vz, L = Math.hypot(gx, gz), m = Math.max(0, near.d - FEAST_REACH * 0.5);
    if (L > 1e-6) { wx += gx / L * m; wz += gz / L * m; }
    // stay on the dais side of the fish (never stroll out over the bones), and not too far from the real kitty
    const tx = x + wx, tz = z + wz, tr = Math.hypot(tx, tz), RMAX = sim.levelData.centerRadius;
    if (tr > RMAX) { wx = tx * RMAX / tr - x; wz = tz * RMAX / tr - z; }
    const wl = Math.hypot(wx, wz);
    if (wl > FEAST_STRAY) { wx *= FEAST_STRAY / wl; wz *= FEAST_STRAY / wl; }
  }
  // walk there at a stroll; snap back quickly once the player moves
  const px = k.ox, pz = k.oz, gx = wx - k.ox, gz = wz - k.oz, gl = Math.hypot(gx, gz), step = Math.min(gl, dt * (still ? 2.4 : 10));
  if (gl > 1e-6) { k.ox += gx / gl * step; k.oz += gz / gl * step; }
  const vel = dt > 0 ? Math.hypot(k.ox - px, k.oz - pz) / dt : 0;
  const ex = x + k.ox, ez = z + k.oz;
  const walking = still && vel > 0.35;
  let face = walking ? Math.atan2(k.oz - pz, k.ox - px) : null, munch = false;
  const n2 = near && (k.ox !== px || k.oz !== pz) ? fish.nearest(ex, ez) : near;
  if (n2 && still && !walking && n2.d < FEAST_REACH) {
    munch = true;
    face = Math.atan2(n2.pz - ez, n2.px - ex);
    k.biteT -= dt;
    if (k.biteT <= 0) {
      k.biteT = 0.5 + Math.random() * 0.25;
      const b = fish.bite(n2.i);
      if (b) {
        k.bites++;
        const fx = Math.cos(face), fz = Math.sin(face), mx = ex + fx * 0.5, mz = ez + fz * 0.5;
        effects.munch(mx, 0.55, mz, -fx, -fz, k.bites % 3 === 1, QUALITY.particles);
        audio.play('chomp', { volume: 0.45, pan: panFor(mx), pitch: 0.95 + Math.random() * 0.15 });
        if (b.done) fishFinished();
      }
    }
  } else k.biteT = 0.25;
  return { x: ex, z: ez, face, munch, walking };
}

function fishFinished() {
  const h = view.fish.headPos();
  effects.burst(h.x, 0.8, h.z, { color: 0xffd36a, count: Math.round(40 * QUALITY.particles), speed: 5, size: 0.3, life: 1.1, spread: 0.5 });
  effects.floatText(h.x, 2.2, h.z, 'ALL GONE!', '#ffd34a');
  audio.play('fishDone', { volume: 0.8, pan: panFor(h.x) });
  ui.updateVictoryFish(100);
}

const _seenCircles = new Set();
const _sunDir = { x: 0, y: 0, z: 0 };
const _kitArgs = {}; // reused kitty model.update() args (the model only reads them)
// 8+ wins backpack passengers: the other players' colours (more than PACK_MAX others: the PACK_MAX with the lowest
// scoreboard score, ties by player order, shown in player order; solo: a few default cats). Returns the kitty's
// cached array, replaced only when the chosen set changes (the model rebuilds the heads on a new array).
const PACK_MAX = 5, _packTmp = [];
const packScore = (o) => (o.rescues | 0) - (o.deaths | 0) + 20 * (o.finishes || 0);   // as on the scoreboard
function packColors(k, p) {
  _packTmp.length = 0;
  const ps = sim.players, crowded = ps.length - 1 > PACK_MAX;
  for (let i = 0; i < ps.length; i++) {
    const o = ps[i];
    if (o.id === p.id) continue;
    if (crowded) {   // rank = other players ahead of o (lower score, or same score earlier in order)
      const s = packScore(o);
      let rank = 0;
      for (let j = 0; j < ps.length && rank < PACK_MAX; j++) {
        const q = ps[j];
        if (q.id === p.id || j === i) continue;
        const sq = packScore(q);
        if (sq < s || (sq === s && j < i)) rank++;
      }
      if (rank >= PACK_MAX) continue;
    }
    _packTmp.push(o.color);
  }
  if (!_packTmp.length) for (const c of PLAYER_COLORS) if (c !== p.color && _packTmp.length < 3) _packTmp.push(c);
  const old = k.packCols;
  let same = !!old && old.length === _packTmp.length;
  for (let i = 0; same && i < old.length; i++) same = old[i] === _packTmp[i];
  if (!same) k.packCols = _packTmp.slice();
  return k.packCols;
}
const WOLF_CULL_PAD = 3;   // how far outside the view a wolf still counts (its body and shadow reach in)
const TURN_TELL = 1.3;     // s a black (charger) wolf heats up before it turns round
const TURN_COOL = 0.6;     // ...and cools off after it (quickly)
const _eyeKeep = new THREE.Color(), _eyeHot = new THREE.Color(2.2, 2.2, 1.6);   // (the eyes at their hottest: white hot)
const _heatCol = new THREE.Color();
let nHeat = 0;
// the heat: drawn over the wolf, adding light, strongest at its outline (a glowing rim, like embers) and faint in the
// middle; its colour per wolf (instance colour: deep red to orange as it heats; black adds nothing)
const HEAT_MAT = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vC;
    void main() {
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      vN = normalMatrix * mat3(instanceMatrix) * normal; vV = -mv.xyz;
      #ifdef USE_INSTANCING_COLOR
        vC = instanceColor;
      #else
        vC = vec3(0.0);
      #endif
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `varying vec3 vN; varying vec3 vV; varying vec3 vC;
    void main() {
      float rim = 1.0 - abs(dot(normalize(vN + vec3(1e-5)), normalize(vV)));
      gl_FragColor = vec4(vC * (0.3 + 1.6 * pow(rim, 1.6)), 1.0);
    }`,
});
// hell's wolf waves (shared/waves.js): the wolves of the waves on the map (those in view). A wave warming up rises out
// of the ground where it will set off (its gap already showing), shaking, then runs; at the start it sinks into the
// ground again. Cheap however many: a wave out of view is skipped whole, and its wolves share a few poses (WAVE_STRIDES
// running strides, posed once a frame per wave and stamped onto each wolf's spot)
const WAVE_PACK_CAP = 480;
const WAVE_SINK = 1.6;   // how deep a wave's wolves start under the ground
const _waveBox = new THREE.Box3(), _waveLo = new THREE.Vector3(), _waveHi = new THREE.Vector3();
function drawWaves(dt, alpha, t) {
  const V = view.waves, waves = hellWaves(sim);
  V.pack.begin();
  V.phase = (V.phase || 0) + Math.min(dt, 0.1) * (7 + 7 * Math.min(1, WAVE_SPEED / 4));   // (the strides' running step, shared)
  let n = 0;
  for (const w of waves) {
    if (w.charge < 1 && w.k > V.warned) { V.warned = w.k; if (w.k === 0) ui.toast('🔥 Wolf waves! Find the gap in each one', '#ff7a4a'); }
    const rise = w.sink > 0 ? 1 - w.sink * w.sink : w.charge < 1 ? 1 - Math.pow(1 - w.charge, 2) : 1;   // (eases out of the ground, and back in)
    const front = w.moving ? w.front + w.dir * WAVE_SPEED * CFG.TICK * alpha : w.front;   // (between ticks)
    const back = front - w.dir * w.depth;
    _waveLo.set(Math.min(front, back) - WOLF_CULL_PAD, -2, -w.half - WOLF_CULL_PAD);
    _waveHi.set(Math.max(front, back) + WOLF_CULL_PAD, 2, w.half + WOLF_CULL_PAD);
    if (!_cullFrustum.intersectsBox(_waveBox.set(_waveLo, _waveHi))) continue;   // (out of view: the whole wave)
    const shaking = w.charge < 1 || w.sink > 0;
    // this wave's strides: the rig posed once per stride (facing the start), then stamped per wolf
    const gr = V.rig.group;
    gr.position.set(0, 0, 0);
    gr.rotation.y = w.dir > 0 ? 0 : Math.PI;   // facing the start
    _wolfArgs.moving = w.moving; _wolfArgs.speed01 = w.moving ? Math.min(1, WAVE_SPEED / 4) : 0; _wolfArgs.time = t;
    const snaps = V.snaps;   // (reused: this wave's strides are stamped before the next wave poses them again)
    for (let i = 0; i < V.strides.length; i++) {
      const st = V.strides[i];
      st.phase = V.phase + i * Math.PI / 2; st.runAmt = w.moving ? Math.max(0.45, Math.min(1, WAVE_SPEED / 4)) : 0; st.clock = t;
      V.rig.pose(st, 0, _wolfArgs);   // (dt 0: posed as set, a quarter step apart)
      V.pack.snap(V.rig, snaps[i]);
    }
    for (const o of w.wolves) {
      if (n >= WAVE_PACK_CAP) break;
      const x = front - w.dir * o.dx;
      if (!_cullFrustum.intersectsSphere(_cullS.set(_cullP.set(x, 0.5, o.z), WOLF_CULL_PAD))) continue;
      const shake = shaking ? 0.06 * Math.sin(t * 40 + o.i * 1.7) : 0;
      V.pack.addSnap(snaps[o.i % snaps.length], x + shake, -WAVE_SINK * (1 - rise), o.z);
      n++;
    }
  }
  V.pack.end();
}
const _cullFrustum = new THREE.Frustum(), _cullM = new THREE.Matrix4(), _cullS = new THREE.Sphere(), _cullP = new THREE.Vector3();
const _wolfArgs = { moving: false, speed01: 0, time: 0 };
function syncVisuals(dt, alpha) {
  if (!view) return;
  if (view.levelData !== sim.levelData) buildView();
  const t = simTime;
  // wolves: only those the camera can see (its view, widened by WOLF_CULL_PAD for their shadows; last frame's
  // camera, a frame behind at most) are posed and drawn. Each is posed on its type's shared rig from its own state.
  camera.updateMatrixWorld();
  _cullFrustum.setFromProjectionMatrix(_cullM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  view.wolfPack.begin();
  if (view.heatPack) view.heatPack.begin();
  nHeat = 0;
  const heatOn = !!view.heatPack;
  for (const e of sim.enemies) {
    const m = view.wolves.get(e.id);
    if (!m) continue;
    const x = e.px === undefined ? e.x : e.px + (e.x - e.px) * alpha, z = e.pz === undefined ? e.z : e.pz + (e.z - e.pz) * alpha;
    if (!_cullFrustum.intersectsSphere(_cullS.set(_cullP.set(x, 0.5, z), WOLF_CULL_PAD))) { m.lastHeading = undefined; continue; }
    const g = m.rig.group;
    g.position.set(x, 0, z);
    g.rotation.y = -e.heading;
    _wolfArgs.moving = e.moving; _wolfArgs.speed01 = Math.min(1, (e.speedNow || 0) / 4); _wolfArgs.time = t;
    m.rig.pose(m.st, dt, _wolfArgs);
    // the final runs (level 9, hell; view.heatPack): a black wolf (a charger) heats up as it comes to turn round (out in
    // the open there; elsewhere it turns at a wall, no need): over the last TURN_TELL s it glows hotter and hotter,
    // fiery, flickering and shaking, at its hottest as it turns. Then it cools off quickly and differently (TURN_COOL s:
    // no shaking, no flicker, a dull red dying away fast), so it never looks like it's heating up for another turn
    let heat = 0, cool = 0;
    if (heatOn && e.pattern && e.type === 'charger') {
      heat = Math.max(0, 1 - turnIn(e) / TURN_TELL);
      if (!heat) { const c = 1 - turnedAgo(e) / TURN_COOL; cool = c > 0 ? c * c : 0; }
    }
    if (heat > 0 || cool > 0) {
      g.position.x += 0.08 * Math.sin(t * 45 + e.id) * heat;
      g.position.z += 0.08 * Math.cos(t * 41 + e.id) * heat;
      const em = m.rig.eyeMat;
      _eyeKeep.copy(em.color);
      em.color.lerp(_eyeHot, heat || cool * 0.5);
      view.wolfPack.add(m.rig);
      em.color.copy(_eyeKeep);
      if (view.heatPack && nHeat < view.heatN) {   // (the fire: the same wolf again, drawn as glowing heat)
        if (heat) {
          const f = heat * (0.8 + 0.2 * Math.sin(t * 23 + e.id * 1.3));   // (a flicker)
          view.heatPack.add(m.rig, _heatCol.setRGB(0.95 * f, (0.12 + 0.38 * heat * heat) * f, 0.02 * f));
        } else view.heatPack.add(m.rig, _heatCol.setRGB(0.7 * cool, 0.08 * cool, 0.02 * cool));   // (cooling: dull red)
        nHeat++;
      }
    } else view.wolfPack.add(m.rig);
    if (e.pattern) {
      // push-off: shavings the moment a wolf turns round at the end of a run (its heading changes once per run)
      if (m.lastHeading !== undefined && e.heading !== m.lastHeading) effects.iceKick(x, z, e.heading);
      m.lastHeading = e.heading;
    }
  }
  view.wolfPack.end();
  if (view.heatPack) view.heatPack.end();
  if (view.waves) drawWaves(dt, alpha, t);
  // items
  // drop pickups the server says are taken (a 'pickup' event from before we joined / reconnected never reached us)
  for (const it of sim.items) {
    const m = it.taken && view.items.get(it.id);
    if (m) { disposeModel(m.group); view.items.delete(it.id); }
  }
  // pickups that came later (the lottery chest's)
  for (const it of sim.items) if (it.id >= 1000 && !it.taken && !view.items.has(it.id)) view.items.set(it.id, itemView(it, view.levelData));
  for (const m of view.items.values()) m.update(dt, t);
  // the lottery chest
  if (!sim.chest && view.chest) { disposeModel(view.chest.group); view.chest = null; }   // (the level started over)
  if (sim.chest && !view.chest) {
    view.chest = createChestModel();
    view.chest.group.position.set(sim.chest.x, 0, sim.chest.z);
    if (sim.chest.open) view.chest.open(true);   // (joined later: already open)
    scene.add(view.chest.group);
  }
  if (view.chest) view.chest.update(dt, t);
  // revive circles
  const seen = _seenCircles; seen.clear();
  // (versus: a kitty that left, for its team to pick up, shows as a revive circle in its colour too)
  const vsSpots = sim.versus && sim.vsLeft ? Object.entries(sim.vsLeft).filter(([, s]) => !s.by).map(([id, s]) => ({ playerId: 'v' + id, x: s.x, z: s.z, color: s.color, team: s.team })) : [];
  // (versus: another team's circles grey and faint: not yours to revive)
  const myTeam = sim.versus ? (sim.players.find((q) => q.id === online.me) || {}).team : undefined;
  for (const c of vsSpots.length ? [...sim.circles, ...vsSpots] : sim.circles) {
    seen.add(c.playerId);
    let m = view.circles.get(c.playerId);
    if (!m) {
      const p = c.color != null ? c : playerById(c.playerId);
      const team = c.team != null ? c.team : p && p.team;
      m = createReviveCircleModel(p ? p.color : 0xffffff, { faint: !!sim.versus && team !== myTeam });
      scene.add(m.group);
      view.circles.set(c.playerId, m);
    }
    m.group.position.set(c.x, 0, c.z);
    m.update(dt, t);
  }
  for (const [id, m] of view.circles) if (!seen.has(id)) { disposeModel(m.group); view.circles.delete(id); }
  // portal
  view.portal.update(dt, t, { active: sim.state === 'levelclear' || sim.state === 'victory' });
  if (view.fish) view.fish.update(dt, t);
  view.crown.group.visible = !sim.crownTaken;
  if (!sim.crownTaken) view.crown.update(dt, t, camera);
  // kitties
  for (const p of sim.players) {
    const k = kitties.get(p.id);
    if (!k) continue;
    k.model.group.visible = p.alive;
    if (!p.alive) { k.trail.update(dt, p.x, p.z, p.heading, false); k.auraTrail.update(dt, p.x, 0, p.z, p.heading, false); k.paws.update(dt); continue; }
    const lp = lerpPos('p' + p.id, p.x, p.z, alpha);
    let x = lp.x, z = lp.z;
    if (online.playing && p.id === online.me) { x += online.errX; z += online.errZ; }
    const eat = view.fish ? feast(k, p, x, z, dt) : null;   // the final run's giant fish
    if (eat) { x = eat.x; z = eat.z; }
    // autumn levels: up a tree = standing on its canopy
    k.climb = (k.climb || 0) + ((inTree(sim.levelData, x, z) ? 2.2 : 0) - (k.climb || 0)) * (1 - Math.exp(-dt * 12));
    k.model.group.position.set(x, k.climb, z);
    // smooth turn
    const cur = -k.model.group.rotation.y;
    let d = (eat && eat.face != null ? eat.face : p.heading) - cur;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    k.model.group.rotation.y = -(cur + d * (1 - Math.exp(-dt * 18)));
    const speed = Math.hypot(p.vx, p.vz);
    const gliding = onIce(sim.levelData, p.x, p.z); // skating: hold still, no steps or dust
    // run rewards (finishes = runs won): 2+ paw prints + coloured skate marks, 3+ flame aura, 4+ aura trail,
    // 6+ all of them cycle through the cat colours (the fur keeps its own); wins 2-6 also set stones in the crown
    const wins = p.finishes || 0, paws = wins >= 2, cos = cosOf(p);   // cos: switched-on account unlocks
    const easy = !!sim.easy;   // an easy game: its own versions of the win rewards (the revive rewards are the same)
    const cosmic = !easy && wins >= 16 && (p.rescues || 0) >= 120;   // the celestial lion (see ka.celestial below)
    if (cosmic) cycleColor((t + p.id * 2.3) * 0.7, k.fx, COSMIC_CYCLE);
    else if (easy) { if (wins >= 6) cycleColor((t + p.id * 2.3) * 0.6, k.fx, k.metals ||= [...METAL_CYCLE, p.color]); else k.fx.set(wins >= 4 ? EASY_SILVER : EASY_BRONZE); }
    else if (wins >= 6) cycleColor(t + p.id * 2.3, k.fx);
    const ka = _kitArgs;
    ka.speed01 = gliding ? 0 : eat && eat.walking ? 0.45 : Math.min(1, speed / (CFG.KITTY_SPEED * 1.2));
    ka.moving = (p.moving && !gliding) || !!(eat && eat.walking); ka.munch = !!(eat && eat.munch); ka.bites = k.bites | 0;
    ka.skates = !!sim.levelData.ice && !(sim.levelData.iceZMax != null && z > sim.levelData.iceZMax);   // (not on Run + Skate level 9's run half)
    ka.boots = Math.round(((p.speedMult || 1) - 1) / CFG.SPEED_BOOST); ka.invuln = p.invuln; ka.shield = p.shield; ka.time = t;
    ka.crown = !!p.crowned; ka.crownStones = Math.max(0, Math.min(5, wins - 1)); ka.aura = wins >= 3; ka.auraColor = k.fx; ka.sunglasses = (!easy && wins >= 5) || cos.has('shades'); ka.rainbowBoots = (!easy && wins >= 7) || cos.has('rboots'); ka.auraCycle = !easy && wins >= 6;
    ka.backpack = wins >= 8; ka.packColors = ka.backpack ? packColors(k, p) : null;
    // easy: a bronze crown (the same stones), reading glasses (5), golden boots (7), yarn balls in the backpack (8; one
    // turns bronze at 13, one silver at 14, one gold at 15), the crown turns silver (9), gets a golden bead on its band
    // per win (10-14) and turns gold (15), silver skates with golden blades (10), a bow on the tail (11), a collar with
    // a name tag (14), a gold medal on it (16; with 120 revives a golden kitty). A switched-on unlock shows as itself.
    ka.crownMetal = !easy || wins >= 15 ? null : wins >= 9 ? 'silver' : 'bronze'; ka.crownBeads = easy ? Math.max(0, Math.min(5, wins - 9)) : 0; ka.glasses = ((easy && wins >= 5) || cos.has('specs')) && !ka.sunglasses; ka.goldBoots = ((easy && wins >= 7) || cos.has('gboots')) && !ka.rainbowBoots;   // (both also unlocks)
    ka.packYarn = easy; ka.packMetal = !easy ? 0 : wins >= 15 ? 3 : wins >= 14 ? 2 : wins >= 13 ? 1 : 0;
    // wins 9-16: night crown (9) and its stars (10-14), rainbow skates (10: golden boots, rainbow blades), fluffy tail
    // with a glowing tip (11), a rainbow name (12, ui.js), backpack kittens turning rainbow (13: one, 14: two, 15: all),
    // lion (14; at 16 a celestial or silver lion, see below). 120 revives: medevac rotor blades on the back
    ka.moonCrown = !easy && wins >= 9; ka.crownStars = Math.max(0, Math.min(5, wins - 9));
    ka.goldSkates = (!easy && wins >= 10) || cos.has('gskates'); ka.fluffyTail = (!easy && wins >= 11) || cos.has('tail'); ka.tailGlow = !cos.has('noglow');   // (its glow: unless switched off)
    ka.silverSkates = (easy && wins >= 10) || cos.has('sskates'); ka.tailBow = (easy && wins >= 11) || cos.has('bow');   // (the bow: also an unlock, on a fluffy tail too)
    ka.packRainbow = easy ? 0 : wins >= 15 ? 99 : wins >= 14 ? 2 : wins >= 13 ? 1 : 0;
    // 14: the lion (and the crown's moon lights up); 16: celestial lion with 120 revives, the rainbow cat stays rainbow
    // (60+ revives), otherwise the chrome moon lion; 120 revives: the medevac rotor
    const res = p.rescues || 0;
    ka.lion = (!easy && wins >= 14) || cos.has('lion'); ka.moonGlow = wins >= 14; ka.moonCat = wins >= 15;   // (the chrome kitty wears a mane only with the Lion mane switched on)
    ka.collar = cos.has('medal') || (easy && wins >= 16) ? 'medal' : easy && wins >= 14 ? 'tag' : null;   // (the medal: also an unlock; over a lion's mane too)   // 15: the crown's moon becomes a moon cat
    ka.celestial = !easy && wins >= 16 && res >= 120; ka.rotor = res >= 120;
    // chrome: the 16-win look, or the switched-on unlock (never over a look earned this run: celestial, rainbow)
    // the golden / bronze kitty (unlocks: legends board number 1s), over the chrome one, never over a look this run earned
    const metalU = (easy || (wins < 16 && !(wins >= 8 && res >= 60))) ? (cos.has('gold') ? 'gold' : cos.has('bronze') ? 'bronze' : null) : null;
    ka.silver = easy ? cos.has('chrome') && !metalU : wins >= 16 ? res < 60 : cos.has('chrome') && !metalU && !(wins >= 8 && res >= 60);
    // an easy game: a bronze kitty at 8 wins with 60 revives (as the rainbow one in a normal game), a golden one at 16 with 120
    const earned = !easy || ka.silver ? null : wins >= 16 && res >= 120 ? 'gold' : wins >= 8 && res >= 60 ? 'bronze' : null;
    ka.metalCat = metalU === 'gold' || earned === 'gold' ? 'gold' : metalU || earned;
    // revive rewards (rescues this run): 10+ medic cape, 30+ a trail of little stars of life, 60+ angel wings (they add up)
    const saves = p.rescues || 0;
    ka.cape = saves >= 10; ka.wings = saves >= 60;
    ka.rainbowCat = !easy && wins >= 8 && saves >= 60;   // every win reward and every revive reward: rainbow fur
    ka.lensShine = !cos.has('nolensshine');   // (a metal kitty's sunglasses: their moving shine, unless switched off)
    if (DEBUG_LOOK.has('crown')) ka.crown = true;
    // the metal shine starts on the side the sun / floodlights shine on (and the glasses' lines come from there)
    { const sn = lighting.sun; _sunDir.x = sn.position.x - sn.target.position.x; _sunDir.y = sn.position.y - sn.target.position.y; _sunDir.z = sn.position.z - sn.target.position.z; ka.lightDir = _sunDir; }
    if (DEBUG_LOOK.has('shades') || DEBUG_LOOK.has('shades-dark') || DEBUG_LOOK.has('shades-bright')) ka.sunglasses = true;
    ka.shadesTone = DEBUG_LOOK.has('shades-dark') ? 0.42 : DEBUG_LOOK.has('shades-bright') ? 1.9 : DEBUG_LOOK.has('lens-soft') ? 2.15 : 0;
    ka.lensMetal = DEBUG_LOOK.has('lens-chrome') ? 'chrome' : DEBUG_LOOK.has('lens-gold') ? 'gold' : DEBUG_LOOK.has('lens-bronze') ? 'bronze' : null;   // (a draft: another metal's lenses)
    if (DEBUG_LOOK.has('tail')) ka.fluffyTail = true;
    if (DEBUG_LOOK.has('lion') || DEBUG_LOOK.has('chrome')) ka.lion = true;
    if (DEBUG_LOOK.has('chrome')) ka.silver = true;
    if (DEBUG_LOOK.has('medal')) ka.collar = 'medal';
    // (test looks: ?look=rboots wears the rainbow boots with four pairs of speed boots, gskates the rainbow skates)
    if (DEBUG_LOOK.has('rboots')) { ka.rainbowBoots = true; ka.boots = Math.max(ka.boots, 4); }
    if (DEBUG_LOOK.has('gskates')) ka.goldSkates = true;
    // (drafts: a golden / bronze body, and the mane in a metal of its own)
    if (DEBUG_LOOK.has('gold') || DEBUG_LOOK.has('bronze')) { ka.lion = true; ka.silver = false; ka.metalCat = DEBUG_LOOK.has('gold') ? 'gold' : 'bronze'; }
    // the mane's and the fluffy tail tip's own metal (switched-on unlocks), on a metal kitty only (chrome or bronze / gold)
    const metalBody = !!(ka.silver || ka.metalCat);
    ka.maneMetal = metalBody && ka.lion ? slotMetal(cos, 'mane') : null;
    ka.tipMetal = metalBody && ka.fluffyTail ? slotMetal(cos, 'tip') : null;
    // (local test looks: ?look=mane-gold / tip-chrome ...)
    ka.maneMetal = DEBUG_LOOK.has('mane-gold') ? 'gold' : DEBUG_LOOK.has('mane-bronze') ? 'bronze' : DEBUG_LOOK.has('mane-chrome') ? 'chrome' : ka.maneMetal;
    ka.tipMetal = DEBUG_LOOK.has('tip-gold') ? 'gold' : DEBUG_LOOK.has('tip-bronze') ? 'bronze' : DEBUG_LOOK.has('tip-chrome') ? 'chrome' : ka.tipMetal;
    if (ka.tipMetal) ka.fluffyTail = true;
    // the sunglasses' lenses in a metal of their own (a switched-on unlock; none: the kitty's own metal), on a metal kitty
    ka.lensMetal = ka.lensMetal || (metalBody && ka.sunglasses ? slotMetal(cos, 'lens') : null);
    if (DEBUG_LOOK.has('pack')) { ka.backpack = true; ka.packColors = DEBUG_PACK; }
    if (saves >= 30 && !ka.celestial && p.alive && speed > 1) {   // (celestial lion: its own space trail instead, below)
      k.heartT = (k.heartT || 0) - dt;
      if (k.heartT <= 0) {
        k.heartT = 0.11;
        // 6+ wins: each star a step further round the rainbow, so the trail is a rainbow
        const col = ka.auraCycle ? _trailRainbow.setHSL((t * 1.6 + (k.rbOff ??= Math.random())) % 1, 1, 0.55) : p.color;
        effects.medicTrail(x - Math.cos(p.heading) * 0.35, k.climb || 0, z - Math.sin(p.heading) * 0.35, col);
      }
    }
    if (ka.celestial && p.alive && speed > 0.5) {   // celestial lion: a trail of space behind
      k.cosT = (k.cosT || 0) - dt;
      if (k.cosT <= 0) {
        k.cosT = 0.045;
        const cy = k.climb || 0, fx = Math.cos(p.heading), fz = Math.sin(p.heading);
        effects.cosmicTrail(x - fx * 0.4, cy, z - fz * 0.4);
        // a thin stream of stars off each open wing's tip (the dragon wings: 0.12 back, 0.54 up, 0.78 out to each side)
        for (const side of [1, -1]) effects.cosmicTrail(x - fx * 0.12 - fz * 0.78 * side, cy + 0.54, z - fz * 0.12 + fx * 0.78 * side, 1, 0.04, 0.12, 0.55);
      }
    }
    // /dance: on and on, until the kitty moves or goes down
    if (k.dance) { k.dance += dt; if (p.moving || !p.alive) k.dance = 0; }
    ka.dance = k.dance || 0;
    k.model.update(dt, ka);
    // (an easy game: the skate marks, aura trail and paw prints are the kitty's own colour until they cycle, from 6 wins)
    const trailCol = easy && wins < 6 ? (k.own ||= new THREE.Color(p.color)) : k.fx;
    k.trail.update(dt, x, z, -k.model.group.rotation.y, gliding && speed > 0.5, paws ? trailCol : null);
    k.auraTrail.update(dt, x, k.climb, z, -k.model.group.rotation.y, wins >= 4 && speed > 1, trailCol);
    k.paws.update(dt);
    if (p.moving && !gliding && sim.state !== 'gameover') {
      k.dustT -= dt;
      if (k.dustT <= 0) {
        k.dustT = 0.13;
        const bx = x - Math.cos(p.heading) * 0.3, bz = z - Math.sin(p.heading) * 0.3;
        const gy = inTree(sim.levelData, bx, bz) ? 2.2 : 0;   // on the ground or up on a canopy
        if (paws) k.paws.add(bx, gy, bz, p.heading, trailCol, cosmic);   // (the celestial lion's prints boom once)
        else effects.dust(bx, bz);
        if (cosmic) effects.starStep(bx, gy, bz);   // the celestial lion's prints twinkle with a little star
        k.stepN++;
        if (k.stepN % 2 === 0) audio.play('step', { volume: 0.35, pitch: 0.9 + Math.random() * 0.2, pan: panFor(x) });
      }
    }
  }
  drawChains(dt);
  world_update(dt, t);
}

// chained kitties: CHAIN_LINKS oval links from one kitty's collar to the other's, each kitty's half in its own colour
// with a silver link in the middle. Slack, the chain hangs in an arc as long as the chain (CHAIN_SOFT) and lies on the
// ground where the arc would go below it; stretching, the dip fades out smoothly until it runs straight at full stretch.
const CHAIN_LINKS = 33, CHAIN_Y = 0.42, CHAIN_COLLAR = 0.28;
const chainGeo = new THREE.TorusGeometry(0.075, 0.024, 8, 16).scale(1.55, 1, 1).rotateY(-Math.PI / 2);   // long along z (lookAt)
const chainSilver = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.9, roughness: 0.25 });
const chainGroups = [];
const _cq = new THREE.Vector3();
function chainPoint(out, A, B, ya, yb, h, s) {
  out.set(A.x + (B.x - A.x) * s, Math.max(0.03, ya + (yb - ya) * s - 4 * s * (1 - s) * h), A.z + (B.z - A.z) * s);
  return out;
}
// where a chained kitty left the game (sim.anchors): a grey ring like a revive circle; a kitty of its chain touching it
// lets the chain go (shared/sim.js chainPull)
const anchorRings = new Map();   // id -> mesh
const anchorMat = new THREE.MeshBasicMaterial({ color: 0xc9ced6, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
function drawAnchors() {
  const an = { ...((sim && sim.chain && sim.anchors) || {}) };
  for (const [id, m] of anchorRings) if (!an[id]) { scene.remove(m); m.geometry.dispose(); anchorRings.delete(id); }
  const pulse = 1 + Math.sin(performance.now() / 260) * 0.06;
  for (const id of Object.keys(an)) {
    let m = anchorRings.get(id);
    if (!m) {
      m = new THREE.Mesh(new THREE.RingGeometry(CFG.REVIVE_RADIUS - 0.12, CFG.REVIVE_RADIUS, 40), anchorMat);
      m.rotation.x = -Math.PI / 2;
      scene.add(m);
      anchorRings.set(id, m);
    }
    m.position.set(an[id].x, 0.04, an[id].z);
    m.scale.set(pulse, pulse, pulse);
  }
}
function drawChains(dt) {
  drawAnchors();
  const pairs = sim && sim.chain ? chainLinks(sim) : [];
  for (let i = 0; i < Math.max(pairs.length, chainGroups.length); i++) {
    // (an end can be an anchor: a kitty that left the game, chainLinks; drawn on the ground where it was)
    const pr = pairs[i], ka = pr && !pr[0].anchor && kitties.get(pr[0].id), kb = pr && !pr[1].anchor && kitties.get(pr[1].id);
    // (drawn while a kitty on it is up, or an end is a ring: two rings of kitties that left stay chained to each other)
    const on = !!(pr && (ka || pr[0].anchor) && (kb || pr[1].anchor) && (pr[0].alive || pr[1].alive || pr[0].anchor || pr[1].anchor));
    let g = chainGroups[i];
    if (!g) {
      if (!on) continue;
      g = chainGroups[i] = new THREE.Group();
      g.userData.mats = [0, 1].map(() => new THREE.MeshStandardMaterial({ metalness: 0.55, roughness: 0.3 }));
      for (let j = 0; j < CHAIN_LINKS; j++) {
        const mid = j === (CHAIN_LINKS - 1) / 2;
        const m = new THREE.Mesh(chainGeo, mid ? chainSilver : g.userData.mats[j < CHAIN_LINKS / 2 ? 0 : 1]);
        m.castShadow = true;
        g.add(m);
      }
      scene.add(g);
    }
    g.visible = on;
    if (!on) continue;
    g.userData.mats[0].color.setHex(pr[0].anchor ? 0x9a9fa6 : pr[0].color);
    g.userData.mats[1].color.setHex(pr[1].anchor ? 0x9a9fa6 : pr[1].color);
    // ends at the collars (a downed kitty: on the ground at its revive circle)
    const PA = pr[0].alive ? ka.model.group.position : { x: pr[0].x, y: 0, z: pr[0].z };
    const PB = pr[1].alive ? kb.model.group.position : { x: pr[1].x, y: 0, z: pr[1].z };
    const dx = PB.x - PA.x, dz = PB.z - PA.z, d = Math.hypot(dx, dz) || 1e-6, ux = dx / d, uz = dz / d;
    const A = { x: PA.x + ux * CHAIN_COLLAR, z: PA.z + uz * CHAIN_COLLAR }, B = { x: PB.x - ux * CHAIN_COLLAR, z: PB.z - uz * CHAIN_COLLAR };
    const ya = pr[0].alive ? PA.y + CHAIN_Y : 0.05, yb = pr[1].alive ? PB.y + CHAIN_Y : 0.05;
    // the arc's dip: a parabola as long as the whole chain (length ~ D + 8h^2 / 3D); through the stretch it fades
    // smoothly to nothing (straight a little before the pull stops the kitties); it drops back with a short lag but
    // pulls straight at once
    const D = Math.max(0.05, d - 2 * CHAIN_COLLAR), L = CHAIN_LEN - 0.3 - 2 * CHAIN_COLLAR;
    const s = Math.min(1, Math.max(0, (d - CHAIN_SOFT) / (CHAIN_LEN - 0.3 - CHAIN_SOFT))), fade = 1 - s * s * (3 - 2 * s);
    const want = (D < L ? Math.sqrt(3 * D * (L - D) / 8) : 0) * fade;
    const ud = g.userData;
    ud.h = ud.h == null || !(dt > 0) || want < ud.h ? want : ud.h + (want - ud.h) * (1 - Math.exp(-dt * 12));
    const h = ud.h;
    for (let j = 0; j < CHAIN_LINKS; j++) {
      const s = (j + 0.5) / CHAIN_LINKS, m = g.children[j];
      chainPoint(m.position, A, B, ya, yb, h, s);
      m.lookAt(chainPoint(_cq, A, B, ya, yb, h, s + 0.02));
      if (j % 2) m.rotateZ(Math.PI / 2);   // every other link turned a quarter: they hook into each other
    }
  }
}

const _trailRainbow = new THREE.Color();
function world_update(dt, t) {
  view.world.update(dt, t);
  lighting.update(dt, t, camTarget.x, camTarget.z);
}

const feedback = createFeedback(document.getElementById('ui'), {
  getContext: () => {
    if (mode !== 'play' || !sim) return { name: '', mode: 'title', level: 0 };
    const me = online.playing ? sim.players.find((p) => p.id === online.me) : sim.players[0];
    return { name: me ? me.name : '', mode: online.playing ? 'online' : playerCount === 2 ? 'coop' : 'solo', level: sim ? sim.levelData.level || sim.level : 0 };
  },
});

ui.onFeedbackClick(() => feedback.open());


const hudScores = [], hudPlayers = [];
const hudData = { level: 0, players: hudPlayers, time: 0, rescues: 0 };
let hudScoresOff = false, hudBestKind = null;
function updateHUD() {
  // feedback button: while your kitty is down, or on the game-over screen
  let down = false;
  if (mode === 'play') {
    if (sim.state === 'gameover') down = true;
    else if (online.playing) down = sim.players.some((p) => p.id === online.me && !p.alive);
    else down = sim.players.some((p) => !p.alive);
  }
  feedback.setVisible(down);
  feedback.dock(ui.gameOverSlot()); // on the game-over card it sits under 'press Enter', not over it
  if (mode !== 'play') { if (!hudScoresOff) { hudScoresOff = true; ui.setScores(null); } return; }
  // score: +1 per friend saved, -1 per time caught, up to 20 per map for how far you ran yourself (p.ran, sim.js
  // trackRun), +5 per win (the crown); from an older server (no p.ran) the old +20 per win
  // The row objects persist; ui.setScores (sort + DOM key) only runs when a score row actually changes.
  const ps = sim.players;
  // the best score is kept for each mode and difficulty (hell apart): e.g. 'run', 'mixed-easy', 'hell-ice'
  const bestKind = (sim.hell ? 'hell-' : '') + (sim.mode || 'mixed') + (sim.easy ? '-easy' : '');
  let dirty = hudScoresOff || hudScores.length !== ps.length || bestKind !== hudBestKind;
  hudScoresOff = false; hudBestKind = bestKind;
  if (dirty) { hudScores.length = ps.length; hudPlayers.length = ps.length; }
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const score = playerScore(p), crown = !!p.crowned, crowns = p.finishes || 0;
    const me = online.playing ? p.id === online.me : true, you = online.playing && p.id === online.me;
    let r = hudScores[i];
    if (!r) r = hudScores[i] = {};
    const shimmer = (p.finishes || 0) >= 12, gold = shimmer && !!sim.easy;   // 12+ wins: a rainbow name on the scoreboard (an easy game: a golden one)
    const paid = online.playing ? ((online.roster.get(p.id) || {}).paid || 0) : i === 0 && account.shown() ? account.display() : 0;   // the account's number (unless switched off)
    const pst = online.playing ? (online.roster.get(p.id) || {}).ps || '' : i === 0 ? account.paidStyle() : '';   // ...drawn as the koi fish or the classic tag
    const revives = p.rescues || 0, caught = p.deaths || 0;   // (shown on the scoreboard beside the crowns)
    if (r.name !== p.name || r.color !== p.color || r.score !== score || r.crown !== crown || r.me !== me || r.you !== you || r.shimmer !== shimmer || r.gold !== gold || r.crowns !== crowns || r.paid !== paid || r.ps !== pst
      || r.revives !== revives || r.caught !== caught) {
      r.name = p.name; r.color = p.color; r.score = score; r.crown = crown; r.crowns = crowns; r.me = me; r.you = you; r.shimmer = shimmer; r.gold = gold; r.paid = paid; r.ps = pst;
      r.revives = revives; r.caught = caught;
      dirty = true;
    }
    let h = hudPlayers[i];
    if (!h) h = hudPlayers[i] = {};
    h.name = p.name; h.color = p.color; h.shimmer = shimmer; h.gold = gold; h.rainbow = !sim.easy && (p.finishes || 0) >= 8 && (p.rescues || 0) >= 60; const il = iconLook(p); h.cool = il.cool; h.specs = !!il.specs; h.metal = il.metal || ''; h.lion = il.lion; h.lionLook = il.lionLook; h.maneMetal = il.maneMetal || ''; h.lensMetal = il.lensMetal || ''; h.lensStill = !!il.lensStill; h.alive = p.alive; h.lives = p.lives; h.speedMult = p.speedMult; h.shield = p.shield; h.you = you;
    h.medic = medicLook(cosOf(p));   // the medic badge (3000 revives), when switched on
    h.paid = paid; h.ps = pst; h.id = p.id;
    // vote to kill (online): standing still 30 s (server AFK_TICKS), the others can vote it down (server.js voteKill; started from the
    // spectate bar, then shown to everyone: ui.js paintVotes): its votes, how many
    // it takes (more than half of the others not standing still themselves), and whether we can vote / have voted
    h.afk = online.playing ? (p.afk || 0) : 0;
    if (h.afk) {
      const voters = ps.filter((q) => q.id !== p.id && !(q.afk > 0)).length;
      const meP = ps.find((q) => q.id === online.me);
      h.afkVotes = h.afk - 1; h.afkNeed = Math.floor(voters / 2) + 1;
      h.voted = online.voted.has(p.id); h.canVote = !you && !!meP && !(meP.afk > 0);
    }
  }
  if (sim.versus) ui.setScores(vsRows(), 'versus-' + bestKind);   // (versus: a row a team; same rows: nothing redrawn)
  else if (dirty) ui.setScores(hudScores, bestKind);
  // versus: your card, your team's (full), then the other teams' (faces) team by team
  if (sim.versus) {
    const mine = (ps.find((q) => q.id === online.me) || {}).team;
    for (let i = 0; i < ps.length; i++) { hudPlayers[i].team = ps[i].team; hudPlayers[i].full = !hudPlayers[i].you && ps[i].team === mine; }
    const rank = (h) => (h.you ? 0 : h.full ? 1 : 2);
    hudData.players = hudPlayers.slice().sort((a, b) => rank(a) - rank(b) || (a.team | 0) - (b.team | 0));
  } else {
    for (const h of hudPlayers) if (h) { h.full = false; h.team = undefined; }   // (nothing left over from a versus game)
    hudData.players = hudPlayers;
  }
  hudData.versus = !!sim.versus;
  hudData.level = sim.hell ? sim.level : sim.levelData.level || sim.level; hudData.time = sim.time; hudData.rescues = sim.stats.rescues;
  hudData.tag = sim.hell ? 'HELL' : 'LEVEL';   // (hell: how far along the map shows only when the game is over)
  ui.setHUD(hudData);
}


// versus: the teams' names and points from the server ([id, name, dist, cur, crowns, deaths, revives], shared/sim.js vsTeam)
function applyVs(list) {
  sim.vsNames = {};
  for (const [id, name, dist, cur, crowns, deaths, revives] of list) {
    sim.vsNames[id] = name;
    sim.teams[id] = { dist, cur, crowns, deaths, revives };
  }
}
// versus: one scoreboard row a team (its points: vsScore), its kitties on hover
function vsRows() {
  const mine = (sim.players.find((p) => p.id === online.me) || {}).team;
  return Object.entries(sim.teams).map(([id, t]) => {
    const ks = sim.players.filter((p) => p.team === +id);
    return { name: (sim.vsNames && sim.vsNames[id]) || 'Team ' + id, color: ks.length ? ks[0].color : 0xaaaaaa, score: vsScore(t), crown: t.crowns > 0, crowns: t.crowns,
      revives: t.revives, caught: t.deaths, me: +id === mine, you: +id === mine, members: ks.map((p) => p.name).join(', ') || 'nobody left',
      kitties: ks.map((p) => ({ name: p.name, color: p.color })), gone: !ks.length };   // (the end cards: each name in its cat's colour)
  });
}
// versus: the teams best first (the final ranking)
// (a team with nobody left in the game (all left, or joined up with another) isn't placed, as on the server: vsResults)
const vsRanking = () => { const rows = vsRows(), still = rows.filter((t) => !t.gone); return (still.length ? still : rows).sort(rankOrder); };

// ---------- online ----------
// Server-authoritative netcode. The server runs the real sim; this client:
//  - runs ahead of the server by ~one-way latency + a few ticks, sending its input tagged with the tick
//    it should be applied on, and predicts its own kitty with the same movement code;
//  - simulates the wolves locally (they are deterministic from the seed), checking a few against the server;
//  - reconciles its kitty on each snapshot (server state + replay of unacknowledged inputs);
//  - shows other kitties extrapolated from their last snapshot to the same "present" as the wolves.
const net = createNet();
// optional account: your total shows next to your name online (and on your card offline)
const account = createAccount(document.getElementById('ui'));
net.acct = account.token;
setHellModes(() => ['run', 'ice'].filter((m) => account.hellOpen(m)));   // (the STATS page: hell's numbers only once it's open here)
account.onChange(() => {
  const had = songUnlocked;
  songUnlocked = account.has('song5') || DEBUG_SONG;
  if (songUnlocked !== had) {
    if (!victorySong) applyMusicChoice();
    if (victory) ui.toast('New song unlocked: We Skate! Switch it on / off in Settings', '#ffd34a');
  }
  ui.setAccountButton(account.enabled() ? { paid: account.paid(), hidden: !account.shown(), signedIn: account.signedIn() } : null);
  if (net.connected) net.send({ t: 'acct', acct: account.token() || '' });
});
ui.onAccountClick(() => account.open());
account.init();

const lobbyUI = createLobbyUI(document.getElementById('ui'), {
  // opts: { max: how many kitties may join, password: '' = public } (lobby.js)
  onCreate: (name, mode, opts = {}) => net.send({ t: 'create', name, mode, easy: !!opts.easy, color: prefColor(), max: opts.max, password: opts.password || '',
    ...(opts.hell ? { hell: true, hl: account.hellOpen(mode) } : {}), ...(opts.chain ? { chain: opts.chain === 'all' ? 'all' : true } : {}), ...(opts.versus ? { versus: true } : {}) }),
  onTeam: (msg) => net.send({ t: 'team', ...msg }),   // (a versus lobby: join / make / name a team)
  // (the host: the lobby's game changed in the lobby; as onCreate)
  onSettings: (mode, opts = {}) => net.send({ t: 'settings', mode, easy: !!opts.easy, ...(opts.hell ? { hell: true, hl: account.hellOpen(mode) } : {}),
    ...(opts.chain ? { chain: opts.chain === 'all' ? 'all' : true } : {}), ...(opts.versus ? { versus: true } : {}) }),
  onChainWith: (id) => net.send({ t: 'chainwith', id }),   // (a chained lobby: chain up with that kitty)   // (hl: hell open here, offline progress included)
  hellOpen: (mode) => account.hellOpen(mode),
  onJoin: (code, name, password = '') => net.send({ t: 'join', code, name, color: prefColor(), password }),
  onLeave: () => net.send({ t: 'leave' }),
  onStart: () => net.send({ t: 'start' }),
  onRefresh: () => net.send({ t: 'list' }),
  // the invite panel: the players you played with, who of them is online, and inviting them
  recent: () => recentPlayers(),
  onRecentOpen: () => askSeen(),
  onFriend: (fid) => toggleFriend(fid),
  get friendsMax() { return FRIENDS_MAX; },   // (defined further down)
  onInvite: (fid) => net.send({ t: 'invite', fid }),
  onBack: () => leaveOnline(),
});

const chat = createChat(document.getElementById('ui'), {
  touch: TOUCH,
  onSend: (text, channel) => {
    // /feedback some words: sent as feedback, not to the room (only you see the answer); /feedback alone opens the box
    const fb = /^\/feedback(?:\s+([\s\S]*))?$/i.exec(text);
    if (fb) {
      const words = (fb[1] || '').trim();
      if (words.length < 2) { feedback.open(); return; }
      feedback.post(words.slice(0, 1000)).then(
        () => chat.add({ sys: true, text: 'Feedback sent. Thank you! 🐾' }),
        (err) => chat.add({ sys: true, text: 'Feedback not sent: ' + (err.message || 'could not send right now.') }));
      return;
    }
    if (/^\/dance\b/i.test(text)) { dance(); return; }
    if (channel === 'world') {   // (the global chat: everyone playing)
      if (!net.connected) { chat.add({ sys: true, text: 'Not connected to the global chat right now.' }); net.wake(); return; }
      net.send({ t: 'gchat', text, name: savedName() || 'Kitty', color: prefColor() });
      return;
    }
    if (online.room) net.send({ t: 'chat', text });
    else chat.add({ sys: true, text: 'Nobody else is here. Try /dance, or /feedback and your idea.' });
  },
  onOpen: () => keys.clear(), // don't keep running while typing
  onReport: NATIVE ? (id, reason) => net.send({ t: 'report', id, reason }) : null, // Report only in the store apps
});
// ---------- global chat: everyone playing, from anywhere (chat.js's 🌍 channel). On unless switched off in the settings;
// shown in games too (Multiplayer ones as well, unless "hide it in Multiplayer games" is switched on). It needs the connection to the server: made
// right away on the web, in the store apps once their terms were accepted (the first Multiplayer visit asks).
const GCHAT_KEY = 'rkr-gchat', GCHAT_MP_KEY = 'rkr-gchat-mp';
const loadFlag = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
let gchatOn = loadFlag(GCHAT_KEY, true), gchatHideMp = loadFlag(GCHAT_MP_KEY, false);
const termsOk = () => { if (!NATIVE) return true; try { return localStorage.getItem('rkr-terms-v1') === '1'; } catch { return false; } };
function setGchatOn(on) {
  gchatOn = !!on;
  try { localStorage.setItem(GCHAT_KEY, gchatOn ? '1' : '0'); } catch { /* ignore */ }
  if (gchatOn && termsOk()) net.connect();
  if (net.connected) net.send({ t: 'gsub', on: gchatOn });
  syncGlobalChat();
}
function setGchatHideMp(on) {
  gchatHideMp = !!on;
  try { localStorage.setItem(GCHAT_MP_KEY, gchatHideMp ? '1' : '0'); } catch { /* ignore */ }
  syncGlobalChat();
}
const gchatShown = () => gchatOn && termsOk() && !net.outdated && !(gchatHideMp && online.playing);
function syncGlobalChat() { chat.setWorld(gchatShown(), { room: !!online.room, onTitle: ui.isTitleOpen() }); }
net.on('gchat', (m) => { if (gchatShown()) chat.add({ ...m, g: true }); });
if (gchatOn && termsOk()) net.connect();

// Legends board (legends.js): online winners get it over ws and may sign; offline winners read it over HTTP.
const legends = createLegends(document.getElementById('ui'), {
  send: (m) => net.send(m),
  isOnline: () => net.connected,
  reconnect: () => net.wake(),
  onOpenChange: (on) => { ui.setVictoryHidden(on); keys.clear(); },
  friends: () => recentPlayers().filter((p) => p.fav).map((p) => p.fid),   // (LEVEL TIMES: your starred friends)
  hellOpen: (mode) => account.hellOpen(mode),   // (LEVEL TIMES: the hell board, once hell is open in that mode)
  who: () => ({ pid: progressId() || undefined, acct: account.token() || undefined, seen9: (() => { try { return localStorage.getItem('rkr-seen9') === '1' || undefined; } catch { return undefined; } })() }),
});
// LEVEL TIMES, local boards: a solo / local co-op game's cleared levels (and level 9 reached, which opens its board),
// sent as they happen (POST /api/levels); kept here when that fails (the newest 30) and tried again a minute later
const lvPending = [];
let lvDay = null, lvSending = false;
async function sendLevelNotes() {
  if (lvSending) return;
  lvSending = true;
  try { while (lvPending.length) { await legends.reportLocal(lvPending[0]); lvPending.shift(); } } catch { setTimeout(sendLevelNotes, 60e3); }
  lvSending = false;
}
// a game played on chains (its own level boards and fastest lists): two kitties or more on a chain
const chained = () => !!(sim && sim.chain && sim.players.length > 1);
function noteLevels(events) {
  if (sim.hell) {   // hell: only how far the game got, at its end (its local hell board; not an easy game's)
    for (const e of events) {
      if (e.type !== 'gameOver' && e.type !== 'victory' && e.type !== 'wipe') continue;   // (wipe: easy hell's level starting over)
      lvPending.push({ hell: true, easy: !!sim.easy, mode: sim.mode, level: e.level, far: e.type === 'victory' ? 1 : e.far, time: sim.time, ...(chained() ? { chain: true } : {}),   // (the game's total time)
        players: sim.players.slice(0, 2).map((p) => ({ name: p.name, color: p.color })) });
      if (lvPending.length > 30) lvPending.shift();
    }
    sendLevelNotes();
    return;
  }
  for (const e of events) {
    if (e.type === 'stageClear') { lvDay = { level: e.level, time: sim.levelTime }; continue; }   // (Run + Skate's day half)
    if (e.type === 'gameOver') { lvDay = null; continue; }
    const players = sim.players.slice(0, 2).map((p) => ({ name: p.name, color: p.color }));
    let msg = null;
    if (e.type === 'levelClear') {
      const day = lvDay && lvDay.level === e.level ? lvDay.time : 0;
      lvDay = null;
      msg = { mode: sim.mode, level: e.level, time: sim.levelTime + day, easy: !!sim.easy, players, ...(chained() ? { chain: true } : {}) };
    } else if (e.type === 'levelStart' && !e.retry && ((sim.levelData && sim.levelData.level) || sim.level) === SKATE_FINAL_LEVEL) {
      msg = { reached: SKATE_FINAL_LEVEL, players };
    }
    if (!msg) continue;
    lvPending.push(msg);
    if (lvPending.length > 30) lvPending.shift();
  }
  sendLevelNotes();
}
ui.setBlocker(() => legends.isOpen());
ui.onLegendsClick(() => legends.showPublic());   // the main menu's LEGENDS button
net.on('legends', (m) => {
  legends.onBoard(m);
  // arrived after the victory screen went up without the button (reconnect): put it up again with the button
  if (victory && victory.shown && !victory.legendsBtn && ui.isVictoryOpen() && online.playing) showVictoryScreen();
});
net.on('legend', (m) => legends.onLegend(m));
net.on('signed', (m) => legends.onSigned(m));
// back in the lobby while you can still sign: a small shortcut to the board (only the winners ever see it)
setInterval(() => legends.setFab(legends.canSign() && lobbyUI.isOpen() && lobbyUI.view() === 'room'), 1000);

// /dance: that player's kitty dances (see syncVisuals)
net.on('emote', (m) => {
  const k = m.e === 'dance' && kitties.get(m.id);
  if (k && !chat.isHidden({ id: m.id })) k.dance = 0.001;
});
net.on('chat', (m) => {
  if (!chat.add(m)) return; // blocked player or chat hidden: no bubble either
  // speech bubble over the sender's kitty during a run
  if (!m.sys && online.playing && mode === 'play') {
    const p = sim.players.find((q) => q.id === m.id);
    if (p && p.alive) effects.floatText(p.x, 2.2, p.z, m.text.length > 28 ? m.text.slice(0, 27) + '…' : m.text, hexCss(m.color));
  }
});

const WOLF_HIST = 64;
const online = {
  playing: false, me: 0, room: null, roster: new Map(),
  tick: 0, acc: 0, rate: 1, levelStartTick: 0, lastK: -1, shownLevel: 0,
  inputs: new Map(), remote: new Map(), errX: 0, errZ: 0, menu: false,
  voted: new Set(),   // the kitties standing still we voted to kill (until they move)
  again: false,   // the host's RESTART GAME on the game-over card: start a new game as soon as the room is back in the lobby
  wolfTicks: new Int32Array(WOLF_HIST).fill(-1), wolfPos: null, resyncAt: 0, wolfChase: false,
  marginFrom: 0,   // the first server tick whose input margin is about inputs sent since our clock last jumped
};

function leaveOnline() {
  net.disconnect();
  lobbyUI.hide();
  setRoomInUrl(null);
  online.room = null;
  online.rejoin = null;
  chat.setEnabled(false);
  ui.showTitle(onTitlePick);
}

// pass: a private lobby's password, kept after '#' like in its invite link (platform.js inviteUrl)
function setRoomInUrl(code, pass) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  u.hash = code && pass ? 'pw=' + encodeURIComponent(pass) : '';
  history.replaceState(null, '', u);
}

// a private lobby's password from an invite link (…?room=ABCD#pw=secret), '' if none
function passFromLink(url) {
  const m = /[#&]pw=([^&#]*)/.exec(url || '');
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

function savedName() {
  try { return localStorage.getItem('rkr-name') || ''; } catch { return ''; }
}

// First time online in the store apps: Terms / zero-tolerance notice (terms.js; App Store 1.2). The web has no gate.
function termsAccepted() {
  if (!NATIVE) return Promise.resolve(true);
  return import('./terms.js').then((m) => (m.ensureTermsAccepted ? m.ensureTermsAccepted() : true), () => true);
}

let opening = false;
async function openOnline(joinCode, joinPass) {
  goFullscreenLandscape(); // needs the user gesture: before any await
  if (opening) return;
  if (net.outdated) { showOutdated(); return; }
  opening = true;
  let ok = true;
  try { ok = await termsAccepted(); } catch { ok = true; }
  opening = false;
  if (!ok) { setRoomInUrl(null); if (!ui.isTitleOpen()) ui.showTitle(onTitlePick); return; }
  net.connect();
  const code = joinCode || new URLSearchParams(location.search).get('room');
  const password = joinCode ? joinPass || '' : passFromLink(location.hash);
  lobbyUI.showBrowser();
  if (code) net.send({ t: 'join', code, name: savedName(), color: prefColor(), password });
}

// "Update the app" (native) / "Reload" (web) when the server says this build is too old.
function showOutdated(msg) {
  lobbyUI.hide();
  chat.setEnabled(false);
  online.room = null;
  online.rejoin = null;
  setRoomInUrl(null);
  if (online.playing || mode === 'play') enterTitle(false);
  ui.hideTitle();
  ui.showNotice({
    title: 'UPDATE TIME',
    text: msg || 'A new version of Project: Run Kitty Run is out — update to keep playing online.',
    button: NATIVE ? 'UPDATE' : 'RELOAD',
    onClick: () => (NATIVE ? openExternal(storeUrl()) : location.reload()),
    alt: 'PLAY SOLO',
    onAlt: () => { ui.hideNotice(); ui.showTitle(onTitlePick); },
  });
}
net.on('outdated', (m) => showOutdated(m.msg));

net.on('lobbies', (m) => lobbyUI.setLobbies(m.list));
net.on('error', (m) => {
  if (m.need === 'password' && lobbyUI.isOpen()) lobbyUI.askPassword(m.code); // a private lobby (list, code or invite link)
  if (lobbyUI.isOpen()) lobbyUI.showError(m.msg);
  else ui.toast(m.msg, 0xff8fa3);
  if (/code/.test(m.msg)) setRoomInUrl(null);
});
net.on('room', (m) => {
  if (!online.room || online.room.code !== m.code) chat.clear();
  online.room = m;
  online.me = m.you;
  online.pass = m.pass || '';   // a private lobby's password: sent again when we rejoin after a dropped connection
  chat.setEnabled(true);
  for (const mem of m.members) online.roster.set(mem.id, mem);
  setRoomInUrl(m.code, m.locked ? m.pass : '');
  if (!online.playing || mode !== 'play') lobbyUI.showRoom(m);
  else if (m.phase === 'lobby' && victory) victory.lobbyAt = victory.t; // the party is over on the server: head back soon
  restartWhenLobby();
});
function restartWhenLobby() {
  const r = online.room;
  if (!online.again || !r || r.phase !== 'lobby') return;
  online.again = false;
  if (r.host === r.you) net.send({ t: 'start' });
}
// ---------- invites (protocol 18): the players you played Multiplayer with, kept on this browser only ----------
// Each has the public friend id the server gave them (a hash, not their progress id); newest first. Starred ones
// (fav: friends) always stay; of the others, the newest RECENT_MAX.
const RECENT_KEY = 'rkr-recent', RECENT_MAX = 20, FRIENDS_MAX = 50;
function recentPlayers() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((p) => p && typeof p.fid === 'string' && typeof p.name === 'string') : [];
  } catch { return []; }
}
function saveRecent(list) {
  let rest = 0, favs = 0;
  const kept = list.filter((p) => (p.fav ? ++favs <= FRIENDS_MAX : ++rest <= RECENT_MAX));
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(kept)); } catch { /* ignore */ }
}
// the star: a friend stays on the list (and shows first); false when the friends list is full
function toggleFriend(fid) {
  const list = recentPlayers(), p = list.find((x) => x.fid === fid);
  if (!p) return true;
  if (p.fav) delete p.fav;
  else if (list.filter((x) => x.fav).length >= FRIENDS_MAX) return false;
  else p.fav = true;
  saveRecent(list);
  return true;
}
// a Multiplayer game starts: everyone else in the lobby goes to the top of the list
function rememberPlayers(members) {
  const me = members.find((m) => m.id === online.me), list = recentPlayers();
  for (const m of members) {
    if (!m.fid || m.id === online.me || (me && m.fid === me.fid)) continue;   // (not you, not your own other tab)
    const i = list.findIndex((p) => p.fid === m.fid);
    const fav = i >= 0 && list[i].fav;
    if (i >= 0) list.splice(i, 1);
    list.unshift({ fid: m.fid, name: m.name, color: m.color, ...(fav ? { fav: true } : {}) });   // (the name they use now)
  }
  saveRecent(list);
}
// who of them is online: asked when the invite panel opens, then every few seconds while it's open
function askSeen() {
  const fids = recentPlayers().map((p) => p.fid);
  if (fids.length && net.connected) net.send({ t: 'seen', fids });
}
setInterval(() => { if (lobbyUI.recentOpen()) askSeen(); }, 3000);
net.on('seen', (m) => lobbyUI.setSeen(Array.isArray(m.list) ? m.list : []));
net.on('invited', (m) => lobbyUI.inviteResult(m.fid, !!m.ok, typeof m.msg === 'string' ? m.msg : ''));
// Who may invite you (Settings, remembered): 'on' (anyone you played with), 'friends' (starred friends only) or 'off';
// and the players whose invites you blocked (their friend ids). Quietly: the inviter still sees "Invite sent!".
const INVITES_KEY = 'rkr-invites', NOINVITE_KEY = 'rkr-noinvite', NOINVITE_MAX = 200;
function invitesFrom() { try { const v = localStorage.getItem(INVITES_KEY); return v === 'friends' || v === 'off' ? v : 'on'; } catch { return 'on'; } }
function setInvitesFrom(v) { try { localStorage.setItem(INVITES_KEY, v); } catch { /* ignore */ } }
function blockedInviters() {
  try { const v = JSON.parse(localStorage.getItem(NOINVITE_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function setBlockedInviters(list) { try { localStorage.setItem(NOINVITE_KEY, JSON.stringify(list.slice(-NOINVITE_MAX))); } catch { /* ignore */ } }
// someone invites you into their lobby: JOIN (or not). Not from a player you muted or blocked, not over another notice.
const MODE_NAMES = { mixed: 'Run + Skate', run: 'Run only', ice: 'Skate only' };
net.on('invite', (m) => {
  if (typeof m.code !== 'string' || !/^[A-Z]{4,8}$/.test(m.code) || ui.isNoticeOpen()) return;
  if (online.room && online.room.code === m.code) return;
  if (online.playing && mode === 'play') return;   // (the server doesn't send these mid-game anyway)
  const name = String(m.name || 'A kitty').slice(0, 14);
  const fid = typeof m.fid === 'string' ? m.fid : '';
  const from = invitesFrom();
  if (from === 'off' || (fid && blockedInviters().includes(fid))) return;
  if (from === 'friends' && !(fid && recentPlayers().some((p) => p.fid === fid && p.fav))) return;
  try { if (JSON.parse(localStorage.getItem('rkr-blocked') || '[]').includes(name)) return; } catch { /* ignore */ }
  haptic('success');
  audio.play('click');
  ui.showNotice({
    title: 'INVITE!',
    text: `${name} invites you to their lobby (${MODE_NAMES[m.mode] || 'Run + Skate'}${m.easy ? ', easy' : ''}).`,
    button: 'JOIN',
    onClick: () => { ui.hideNotice(); joinFromLink(m.code, typeof m.pass === 'string' ? m.pass : ''); },
    alt: 'NO THANKS',
    onAlt: () => ui.hideNotice(),
    ...(fid ? {
      link: `Block invites from ${name}`,
      onLink: () => {
        setBlockedInviters([...blockedInviters().filter((x) => x !== fid), fid]);
        ui.hideNotice();
        ui.toast(`No more invites from ${name} (Settings: Invites)`, '#b9a4ff');
      },
    } : {}),
  });
});
net.on('left', () => { online.room = null; chat.setEnabled(false); setRoomInUrl(null); if (online.playing) enterTitle(false); lobbyUI.showBrowser(); });
net.on('open', () => {
  // back after a dropped connection (or the app was in the background): rejoin the same lobby
  const code = online.rejoin;
  online.rejoin = null;
  if (code && !online.room) net.send({ t: 'join', code, name: savedName(), color: prefColor(), password: online.pass || '' });
  net.send({ t: 'legends' }); // a winner still in its signing window (same tab, even after a reload) gets the board back
  if (gchatOn) net.send({ t: 'gsub', on: true });   // (the global chat)
});
net.on('close', () => {
  if (online.room) online.rejoin = online.room.code;
  online.room = null;
  online.again = false;
  chat.setEnabled(false);
  if (online.playing) enterTitle(false);
  ui.hideGameOver();
  ui.hideVictory();
  ui.hidePause();
  online.menu = false;
  lobbyUI.showBrowser();
  lobbyUI.showError('Connection lost. Reconnecting…');
});
net.on('start', (m) => beginOnlineGame(m));
net.on('snap', (m) => applySnapshot(m));
net.on('chains', (m) => { if (sim && sim.chain && Array.isArray(m.c)) { sim.chains = m.c; sim.anchors = m.a || {}; } });   // (chained: someone left, came back, joined)
net.on('wolves', (m) => {
  if (!online.playing || m.lvl !== sim.level) return;
  // (from before an easy game's level started over: its wolves' time far ahead of now would hold them still until then)
  if (m.lt > online.tick - online.levelStartTick + WOLF_CATCHUP_MAX) return;
  applyEnemyState(sim.enemies, m.wolves);
  sim.enemyTicks = m.lt;
  online.wolfTicks.fill(-1);
  online.wolfChase = true;   // (the server's own wolves: replayed to now even when they arrive late, see catchUpWolves)
  catchUpWolves();
});

// Desync tripwire: the server sends its level's hash (start message, levelStart events); a client that generated the
// level differently (e.g. a float op that differs between JS engines) reports it. No fallback: wolf resyncs still apply.
// The level came out different here than on the server (its fingerprint covers wolves and items): take the server's.
// The pickups would otherwise sit in other spots here (the server's ones invisible: "a shield out of nowhere"), and the
// wolves get the server's full state. The report says which part differed once the server's items are in.
let levelFix = null;   // { level, mode } while waiting for the server's items
function checkLevelHash(level, lh) {
  if (lh == null || !sim || sim.level !== level || !sim.levelData) return;
  const mine = levelHash(sim.levelData);
  if (mine === lh) return;
  console.warn(`level ${level} (${sim.mode}) generated differently from the server: hash ${mine} vs ${lh}, using the server's`);
  levelFix = { level, mode: sim.mode };
  if (net.connected) { net.send({ t: 'items' }); net.send({ t: 'resync' }); online.resyncAt = performance.now() + 2000; }
}
// the server's pickups for this level: replace ours and draw them
net.on('items', (m) => {
  if (!sim || !Array.isArray(m.items) || m.lvl !== sim.level) return;
  const items = [];
  for (const it of m.items) {
    if (!it || !Number.isInteger(it.id) || typeof it.type !== 'string' || !Number.isFinite(it.x) || !Number.isFinite(it.z)) return;
    items.push({ id: it.id, type: it.type, x: it.x, z: it.z, taken: !!it.taken, ...(it.mega ? { mega: true } : {}) });
  }
  const key = (list) => JSON.stringify(list.map((it) => [it.id, it.type, it.x, it.z, !!it.mega]));
  const itemsDiffered = key(items) !== key(sim.items);
  if (levelFix && levelFix.level === sim.level) {
    analytics.levelMismatch(levelFix.mode, levelFix.level, APP_VERSION, itemsDiffered ? 'items' : 'wolves');
    levelFix = null;
  }
  if (!itemsDiffered) return;
  sim.items = items;
  if (view) rebuildItemViews();
});

const MARGIN_SETTLE = 90;   // ticks after our clock jumps before the server's input margin is about the new inputs again
function leadTicks() { return Math.ceil(net.rtt / 2 / (CFG.TICK * 1000)) + NET.INPUT_LEAD; }

function beginOnlineGame(m) {
  online.again = false;
  lobbyUI.hide();
  if (m.st !== 'victory') legends.reset();
  ui.hideTitle();
  ui.hideGameOver();
  ui.hideVictory();
  ui.hidePause();
  audio.unlock();
  online.menu = false;
  mode = 'play';
  paused = false;
  for (const p of m.players) online.roster.set(p.id, { ...online.roster.get(p.id), ...p });   // (keeps the room's paid totals)
  if (online.room) rememberPlayers(online.room.members);   // (for the invite panel)
  playerCount = m.players.length;
  removeKitties();
  sim = createSim({ seed: m.seed, players: m.players, startLevel: m.level, mode: m.mode, finales: +m.rf || 0, easy: !!m.easy, hell: !!m.hell, waves: !!m.hw, chain: m.cn ? (m.cn.all ? 'all' : true) : false, versus: !!m.vs });
  if (m.cn && Array.isArray(m.cn.c)) { sim.chains = m.cn.c; sim.anchors = m.cn.a || {}; }   // (the server's chains: who left, rejoined)
  if (m.vs) applyVs(m.vs);
  sim.retries = m.rt | 0;
  analytics.runStart('online', m.mode || 'mixed', !!m.hell, m.cn && m.players.length > 1 ? (m.cn.all ? 'all' : true) : false, !!m.easy, !!m.vs);
  sim.started = true;
  // joined mid-level: the lottery chest and what it dropped (ch, xi), then what is already taken
  if (m.ch) sim.chest = { x: m.ch[0], z: m.ch[1], open: !!m.ch[2] };
  for (const [id, type, x, z, mega] of m.xi || []) sim.items.push({ id, type, x, z, taken: false, ...(mega ? { mega: true } : {}) });
  if (m.it) { const taken = new Set(m.it); for (const it of sim.items) it.taken = taken.has(it.id); } // joined mid-level
  sim.crownTaken = !!m.ct;
  gameOverShown = false;
  victory = null;
  intro = null;
  prevPos.clear();
  online.playing = true;
  online.inputs.clear();
  online.remote.clear();
  online.errX = online.errZ = 0;
  online.lastK = m.tick;
  online.acc = 0;
  online.rate = 1;
  online.levelStartTick = m.tick - m.lt;
  online.tick = m.tick + leadTicks();
  online.marginFrom = online.tick + MARGIN_SETTLE;
  online.wolfTicks.fill(-1);
  online.wolfPos = new Float32Array(WOLF_HIST * sim.enemies.length * 2);
  if (m.wolves) { applyEnemyState(sim.enemies, m.wolves); sim.enemyTicks = m.lt; }
  catchUpWolves();
  cameraSnap = true;
  online.shownLevel = sim.level;
  checkLevelHash(sim.level, m.lh);
  handleEvents([{ type: 'levelStart', level: sim.level }]);
  // joined mid-game: checkpoints already reached (a repaired medic checkpoint shows repaired)
  if (Array.isArray(m.cp)) {
    sim.checkpointsHit = m.cp.slice();
    for (const i of m.cp) if (sim.levelData.checkpoints && sim.levelData.checkpoints[i] && sim.levelData.checkpoints[i].medic && view) view.world.repairCheckpoint(i);
  }
  // joined (or reconnected) after the final run was won: the stored victory event won't come again
  if (m.st === 'victory') {
    sim.state = 'victory';
    intro = null;
    startVictory(m.vic || null);
  }
}

function backToLobby() {
  online.again = false;
  if (online.menu) { online.menu = false; ui.hidePause(); }
  if (online.playing && sim && sim.state === 'victory') net.send({ t: 'tolobby' });   // (the server ends the party once everyone has)
  online.playing = false;
  enterTitle(false);
  if (online.room) lobbyUI.showRoom(online.room);
  else lobbyUI.showBrowser();
}

function toggleOnlineMenu() {
  online.menu = !online.menu;
  if (online.menu) {
    ui.showPause(() => { online.menu = false; }, () => { online.menu = false; net.send({ t: 'leave' }); });
  } else {
    ui.hidePause();
  }
  audio.play('click');
}

// Step local wolves up to the level tick matching our current tick, remembering recent positions. Far behind (back
// from the background, a late level change): don't replay it all (seconds of frozen game on a big level), ask the
// server for its wolves instead; they wait where they are until the reply ('wolves') catches them up.
// In between, at most WOLF_CATCHUP_PER_CALL ticks per call: a stall of a second or two is replayed over a few frames
// (the wolves lag the server for a moment) instead of one long frame on a big level.
// The server's wolves ('wolves', online.wolfChase) are always replayed up to now, also when the reply came more than
// WOLF_CATCHUP_MAX late (a slow connection): asking again could come back just as late, every time, and the wolves
// would run in place for minutes. That replay is held to about WOLF_CHASE_WORK wolf steps (a small level: up to a
// minute or so; a big one: WOLF_CATCHUP_MAX), spread over the frames like any catch-up.
const WOLF_CATCHUP_MAX = 300;   // ticks (5 s)
const WOLF_CATCHUP_PER_CALL = 24;
const WOLF_CHASE_WORK = 600000;
function catchUpWolves() {
  const target = online.tick - online.levelStartTick, behind = target - sim.enemyTicks;
  const chaseMax = Math.max(WOLF_CATCHUP_MAX, Math.floor(WOLF_CHASE_WORK / Math.max(1, sim.enemies.length)));
  if (behind > WOLF_CATCHUP_MAX && !(online.wolfChase && behind <= chaseMax)) {
    online.wolfChase = false;
    const now = performance.now();
    if (net.connected && now > online.resyncAt) { online.resyncAt = now + 2000; net.send({ t: 'resync' }); }
    return;
  }
  let guard = 0;
  while (sim.enemyTicks < target && guard++ < WOLF_CATCHUP_PER_CALL) {
    updateEnemies(sim.enemies, sim.levelData, CFG.TICK);
    sim.enemyTicks++;
    if (target - sim.enemyTicks < WOLF_HIST) recordWolves();
  }
  if (sim.enemyTicks >= target) online.wolfChase = false;
}

function recordWolves() {
  const n = sim.enemies.length;
  if (!online.wolfPos || online.wolfPos.length !== WOLF_HIST * n * 2) online.wolfPos = new Float32Array(WOLF_HIST * n * 2);
  const slot = sim.enemyTicks % WOLF_HIST;
  online.wolfTicks[slot] = sim.enemyTicks;
  const base = slot * n * 2;
  for (let i = 0; i < n; i++) {
    online.wolfPos[base + i * 2] = sim.enemies[i].x;
    online.wolfPos[base + i * 2 + 1] = sim.enemies[i].z;
  }
}

function checkWolves(lt, checks) {
  const slot = lt % WOLF_HIST;
  if (online.wolfTicks[slot] !== lt || !checks) return;
  const n = sim.enemies.length;
  const base = slot * n * 2;
  for (const [id, x, z] of checks) {
    const i = sim.enemies[id] && sim.enemies[id].id === id ? id : sim.enemies.findIndex((e) => e.id === id);
    if (i < 0) continue;
    const dx = online.wolfPos[base + i * 2] - x, dz = online.wolfPos[base + i * 2 + 1] - z;
    if (dx * dx + dz * dz > 0.05 * 0.05) {
      const now = performance.now();
      if (now > online.resyncAt) { online.resyncAt = now + 2000; net.send({ t: 'resync' }); }
      return;
    }
  }
}

function myInput() {
  if (online.menu) return { x: 0, z: 0 };
  const me = sim.players.find((p) => p.id === online.me);
  const kb = readInput(0, 1);
  const inp = me ? mouseInput(me, kb) : kb;   // (looking at a friend: the kitty keeps going as it was, see lookingAway)
  // ... until a new move (stick or joystick; the keys: keydown), unless that is switched off in the settings
  if (!lookingAway()) watchIdle = false;
  else if (!(inp.x || inp.z)) watchIdle = true;
  else if (watchIdle && lookBack()) watchId = null;
  return inp;
}

function onlineFrame(dt) {
  online.acc += dt * online.rate;
  let steps = 0;
  while (online.acc >= CFG.TICK && steps < 8) {
    online.acc -= CFG.TICK;
    steps++;
    onlineTick();
  }
  if (steps === 8) online.acc = 0;
  const k = 1 - Math.exp(-dt / 0.12);
  online.errX -= online.errX * k;
  online.errZ -= online.errZ * k;
}

function onlineTick() {
  snapshotPrev();
  const t = ++online.tick;
  const inp = myInput();
  const q = { x: Math.round(inp.x * 1000) / 1000, z: Math.round(inp.z * 1000) / 1000, m: audio.isMuted() ? 0 : 1 };   // m: CFG.MUSIC_BOOST
  online.inputs.set(t, q);
  online.inputs.delete(t - 240);
  net.send({ t: 'in', k: t, x: q.x, z: q.z, m: q.m });

  const me = sim.players.find((p) => p.id === online.me);
  if (me) predictPlayer(sim, me, q, CFG.TICK);
  catchUpWolves();
  for (const p of sim.players) if (p.id !== online.me) extrapolateRemote(p, t);
  sim.time += CFG.TICK;
  for (const p of sim.players) {
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - CFG.TICK);
    if (p.shield > 0) p.shield = Math.max(0, p.shield - CFG.TICK);
  }
}

function extrapolateRemote(p, t) {
  const r = online.remote.get(p.id);
  if (!r || !p.alive) return;
  const age = Math.min(12, Math.max(0, t - r.k)) * CFG.TICK;
  let tx = r.x + r.vx * age, tz = r.z + r.vz * age;
  const c = collideCircle(sim.levelData, tx, tz, CFG.KITTY_RADIUS);
  tx = c.x; tz = c.z;
  if (Math.hypot(tx - p.x, tz - p.z) > 3) { p.x = tx; p.z = tz; return; }
  p.x += (tx - p.x) * 0.3;
  p.z += (tz - p.z) * 0.3;
}

function applySnapshot(m) {
  if (!online.playing || !sim || m.k <= online.lastK) return;
  online.lastK = m.k;

  // Keep our clock ~INPUT_LEAD ticks ahead of when the server needs our input.
  if (online.tick < m.k || online.tick - m.k > 120) {
    online.tick = m.k + leadTicks();
    online.marginFrom = online.tick + MARGIN_SETTLE;   // (the margins until then are about inputs from before: see below)
  }

  // Level change (the server already moved on): mirror it. An easy game's level starting over (rt moved): the same
  // level again, with its wolves and pickups as at the start.
  const again = m.lvl === sim.level && (m.rt | 0) !== (sim.retries | 0);
  if (m.lvl !== sim.level || again) {
    loadLevel(sim, m.lvl);
    sim.retries = m.rt | 0;
    online.levelStartTick = m.k - m.lt;
    online.wolfTicks.fill(-1);
    online.wolfPos = null;
    catchUpWolves();
  }

  sim.lastWinner = m.lw || 0;
  sim.crownTaken = !!m.ct;
  sim.state = m.st;
  sim.time = m.tm + (online.tick - m.k) * CFG.TICK;
  if (m.hf != null) sim.far = m.hf;   // hell: the team's progress on this level (the server's)
  sim.stats = m.s;
  const taken = new Set(m.it);
  for (const it of sim.items) it.taken = taken.has(it.id);
  sim.circles = m.c.map(([playerId, x, z, t]) => ({ playerId, x, z, t }));
  if (m.vs) applyVs(m.vs);
  if (sim.versus) sim.vsLeft = Object.fromEntries((m.vl || []).map(([id, x, z, team, color, by]) => [id, { x, z, team, color, by }]));   // (kitties that left: a revive circle where they are, or carried)
  if (sim.chain && m.ad) for (const [id, x, z] of m.ad) if (sim.anchors[id]) Object.assign(sim.anchors[id], { x, z, drag: true });   // (bodies dragged on a chain)
  online.jv = m.jv || [];   // (chained: votes to add a kitty on its own to a group: updateJoinBtn)

  const seen = new Set();
  let rosterChanged = false;
  for (const a of m.p) {
    const [id, x, z, vx, vz, heading, alive, inC, lives, speedMult, invuln, shield, deaths, rescues, margin, finishes = 0, waitRelease, crowned = 0, bonus = 0, freeTurn = 0, ran, afk = 0, team] = a;
    seen.add(id);
    let p = sim.players.find((q) => q.id === id);
    const fresh = !p;
    if (!p) {
      const info = online.roster.get(id) || { name: 'Kitty', color: 0xffffff };
      p = { id, name: info.name, color: info.color, x, z, vx: 0, vz: 0, heading, moving: false, alive: true, lives: 0,
        speedMult: 1, invuln: 0, shield: 0, inCenter: false, deaths: 0, rescues: 0 };
      sim.players.push(p);
      rosterChanged = true;
    }
    const wasAlive = p.alive;
    const oldX = p.x + (id === online.me ? online.errX : 0), oldZ = p.z + (id === online.me ? online.errZ : 0);
    Object.assign(p, { vx, vz, heading, alive: !!alive, inCenter: !!inC, lives, speedMult, invuln, shield, deaths, rescues, finishes, crowned: !!crowned, bonus, ran, afk, ...(team !== undefined ? { team } : {}) });   // (ran: undefined from an older server; team: versus)
    if (!afk) online.voted.delete(id);   // (moving again: a later vote is a new one)
    p.moving = Math.hypot(vx, vz) > 0.5;
    if (id === online.me) {
      p.x = x; p.z = z;
      if (waitRelease !== undefined) p.waitRelease = !!waitRelease;
      p.freeTurn = !!freeTurn;   // (just revived: its first steer on ice picks the way, as the server's sim does)
      // replay inputs the server hasn't processed yet
      for (let t = m.k + 1; t <= online.tick; t++) predictPlayer(sim, p, online.inputs.get(t) || null, CFG.TICK);
      online.errX = oldX - p.x;
      online.errZ = oldZ - p.z;
      if (fresh || !wasAlive || Math.hypot(online.errX, online.errZ) > 4) online.errX = online.errZ = 0;
      // margin = how many ticks early our inputs arrive; steer toward NET.INPUT_LEAD. Not right after our clock jumped
      // (a stall caught up, a big correction): the server's margin is an average over our inputs (server/index.js, 0.1 a
      // time), still mostly about the ones from before the jump for a second or so (MARGIN_SETTLE); correcting for them
      // again overshot - then the next margins pulled the clock back as far, and the wolves, synced in between, stood
      // still until it caught up (Hell Skate's big level loading at its start)
      if (m.k >= (online.marginFrom || 0)) {
        const err = margin - NET.INPUT_LEAD;
        online.rate = 1 - Math.max(-0.08, Math.min(0.08, err * 0.01));
        if (Math.abs(err) > 30) { online.tick += -Math.round(err); online.marginFrom = online.tick + MARGIN_SETTLE; }
      }
    } else {
      online.remote.set(id, { x, z, vx, vz, k: m.k });
      if (fresh || !wasAlive) { p.x = x; p.z = z; }
    }
  }
  for (let i = sim.players.length - 1; i >= 0; i--) {
    if (!seen.has(sim.players[i].id)) { sim.players.splice(i, 1); rosterChanged = true; }
  }
  if (rosterChanged) ensureKitties();

  checkWolves(m.lt, m.ec);

  const events = m.ev.filter((e) => {
    if (e.type !== 'levelStart') return true;
    if (e.retry) return again;   // (once, with the snapshot that started it over)
    if (e.level === online.shownLevel) return false;
    online.shownLevel = e.level;
    checkLevelHash(e.level, e.lh);
    return true;
  });
  if (events.length) handleEvents(events);
}

// ---------- main loop ----------
let last = performance.now();
let minimapT = 0;

// Frame pacing: the player's frame rate limit (Settings; MAX by default: every refresh of the screen). The game steps
// at a fixed 60 Hz either way (offline and online), so a limit only saves GPU work and heat. A frame is drawn once its
// time has come (to half a refresh), so the average holds the limit and a limit the screen divides is evenly spaced.
let vsyncPrev = last, vsyncMs = 1000 / 60, nextDraw = 0;

function frame(now) {
  requestAnimationFrame(frame);
  syncGlobalChat();   // (cheap when nothing changed)
  const iv = now - vsyncPrev;
  vsyncPrev = now;
  if (iv > 3 && iv < 40) vsyncMs += (iv - vsyncMs) * (iv < vsyncMs ? 0.1 : 0.02);   // leans to the short intervals (the real refresh)
  const cap = fpsLimit();
  if (cap) {
    const step = 1000 / cap;
    if (now < nextDraw - vsyncMs / 2) return;
    nextDraw = now - nextDraw > step ? now + step : nextDraw + step;   // (fell behind: start over from now)
  }
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  tick(dt);
}

function tick(dt) {
  framePads = navigator.getGamepads ? navigator.getGamepads() : [];
  const running = !paused;
  if (online.playing) {
    simTime += dt;
    onlineFrame(dt);
  } else if (running) {
    simTime += dt;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= CFG.TICK && steps < 6) {
      snapshotPrev();
      const inputs = {};
      if (mode === 'play') {
        const mi = mousePlayerIndex();
        sim.players.forEach((p, i) => {
          const kb = readInput(i, playerCount);
          inputs[p.id] = { ...(i === mi ? mouseInput(p, kb) : kb), m: audio.isMuted() ? 0 : 1 };   // m: CFG.MUSIC_BOOST
        });
        if (window.__bot) Object.assign(inputs, window.__bot(sim));
      }
      const events = stepSim(sim, inputs, CFG.TICK);
      if (mode === 'play') { handleEvents(events); account.noteLocal(sim, events); noteLevels(events); }   // solo / local stats (account.js), local level boards
      else if (events.some((e) => e.type === 'levelStart')) { pregenNext(sim); buildView(); }
      accumulator -= CFG.TICK;
      steps++;
    }
    if (steps === 6) accumulator = 0;
  }
  const alpha = online.playing ? Math.min(1, online.acc / CFG.TICK) : Math.min(1, accumulator / CFG.TICK);

  if (mode === 'play' && sim.state === 'gameover' && !gameOverShown) {
    gameOverShown = true;
    const wasOnline = online.playing;
    const runSim = sim;
    setTimeout(() => {
      if (sim !== runSim) return; // a new run already started
      if (online.menu) { online.menu = false; ui.hidePause(); }   // the game-over card replaces the online menu
      ui.showGameOver({
        level: sim.hell ? sim.level : sim.levelData.level || sim.level, deaths: sim.stats.deaths, rescues: sim.stats.rescues,
        ...(sim.hell ? { hell: true, far: sim.far } : {}),
        time: sim.time,
        // alone: nobody could revive you; nudge toward friends
        alone: sim.players.length === 1 ? (wasOnline ? 'online' : 'solo') : null,
        ...(sim.versus ? { versus: vsRanking() } : {}),
        onShare: () => shareRun(false, runSim.time),
      }, () => { ui.hideGameOver(); if (wasOnline) backToLobby(); else startGame(playerCount); }, wasOnline ? 'BACK TO LOBBY' : null,
      // LEAVE GAME: offline back to the title, online out of the lobby (to the lobby list)
      () => { if (wasOnline) net.send({ t: 'leave' }); else enterTitle(); },
      // RESTART GAME (the lobby's host): the room goes back to the lobby a few seconds after a game over; start it then
      wasOnline && online.room && online.room.host === online.me ? () => { online.again = true; restartWhenLobby(); } : null);
    }, 1400);
  }

  const vdt = running ? dt : 0;
  updateVictory(vdt);
  updateIntro(vdt);
  pollPadNav();
  if (track.volume < trackVol()) track.volume = Math.min(trackVol(), track.volume + dt * 0.15); // musicFadeIn
  syncVisuals(vdt, alpha);
  updateTargetMarker(vdt);
  effects.update(vdt);
  updateCamera(dt, alpha);
  updateWatchLabel();
  updateJoinBtn();
  updateWatchBtn();
  updateHUD();

  // danger audio
  if (mode === 'play' && sim.state === 'playing') {
    let d = Infinity;
    for (const p of sim.players) if (p.alive && !p.inCenter && (!online.playing || p.id === online.me)) d = Math.min(d, nearestEnemyDist(sim.enemies, p.x, p.z));
    audio.setDanger(Math.max(0, Math.min(1, 1 - d / 3.5)));
  } else {
    audio.setDanger(0);
  }

  minimapT -= dt;
  if (mode === 'play' && minimapT <= 0) {
    minimapT = 1 / 30;
    ui.updateMinimap(sim.levelData, sim, online.playing ? online.me : null);
  }

  setKeepAwake(mode === 'play' && !paused && sim.state !== 'gameover');
  if (!warming()) renderer.render(scene, camera);   // (not while shaders compile)
  hideSplash(); // after the first rendered frame
}

// ---------- app / platform glue ----------
// Light tap on buttons (apps only; haptic() is a no-op on the web).
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('button, .rkr-mute, .rkr-hudbtn, .rkr-menubtn, .rkl-lob')) haptic('light');
}, true);

// Background / foreground (web tab hidden / page hidden, or app backgrounded): silence the
// soundtrack and suspend the audio context; back in front wake both up again (respecting mute)
// and make sure the socket is alive. Apps also pause a local run. visibilitychange, pagehide and
// appStateChange can all fire for one transition; the inBackground guard makes that a no-op.
function setBackground(bg) {
  if (bg === inBackground) return;
  inBackground = bg;
  if (bg) {
    releaseAllInput();
    touchId = null; joy.on = false; drawJoy();
    track.pause();
    audio.setBackground(true);
    if (NATIVE && mode === 'play' && !online.playing && !paused && sim.state === 'playing') togglePause();
  } else {
    audio.setBackground(false);
    syncTrack();
    net.wake();
    // A long time away: ask for the server's wolves right away (on a big level that is a large message, so only when
    // the local replay can't cover it; a short tab switch is replayed by catchUpWolves, which also asks if the next
    // snapshot turns out to be far ahead).
    if (online.playing && net.connected && online.tick - online.levelStartTick - sim.enemyTicks > WOLF_CATCHUP_MAX) net.send({ t: 'resync' });
  }
}
document.addEventListener('visibilitychange', () => setBackground(document.visibilityState === 'hidden'));
window.addEventListener('pagehide', () => setBackground(true));
window.addEventListener('pageshow', (e) => { if (e.persisted && document.visibilityState === 'visible') setBackground(false); });
const App = plugin('App');
if (App) {
  App.addListener('appStateChange', (st) => setBackground(!st.isActive));
  App.addListener('backButton', onBackButton);
  App.addListener('appUrlOpen', (e) => joinFromLink(roomFromLink(e && e.url), passFromLink(e && e.url)));
  call('App', 'getLaunchUrl').then((r) => { if (r && r.url) joinFromLink(roomFromLink(r.url), passFromLink(r.url)); });
}

// Android back: close the top-most thing; on the title screen, minimize the app.
function onBackButton() {
  if (feedback.isOpen()) { feedback.close(); return; }
  if (legends.isOpen()) { legends.close(); return; }
  if (chat.isOpen()) { chat.close(); return; }
  const terms = document.querySelector('.rkt-modal .rkr-alt'); // terms.js notice: "Not now"
  if (terms) { terms.click(); return; }
  if (ui.isNoticeOpen()) { ui.hideNotice(); if (!ui.isTitleOpen()) ui.showTitle(onTitlePick); return; }
  if (mode === 'play') {
    if (ui.isGameOverOpen()) { ui.hideGameOver(); if (online.playing) backToLobby(); else enterTitle(); return; }
    if (ui.isVictoryOpen()) { ui.hideVictory(); if (online.playing) backToLobby(); else enterTitle(); return; }
    if (online.playing && online.menu) { online.menu = false; ui.hidePause(); net.send({ t: 'leave' }); } // = LEAVE GAME
    else if (online.playing) toggleOnlineMenu();
    else if (paused) { ui.hidePause(); enterTitle(); } // back on the pause menu = quit the run
    else togglePause();
    return;
  }
  if (lobbyUI.isOpen()) {
    if (lobbyUI.view() === 'room') net.send({ t: 'leave' });
    else leaveOnline();
    return;
  }
  if (ui.isTitleOpen()) { call('App', 'minimizeApp'); return; }
  enterTitle();
}

// Invite links: https://<server>/?room=ABCD (universal / app links) and runkittyrun://join?room=ABCD
function roomFromLink(url) {
  const m = /[?&]room=([A-Za-z0-9]{4,8})/.exec(url || '');
  return m ? m[1].toUpperCase() : null;
}
let lastLink = '', lastLinkAt = 0;
function joinFromLink(code, pass = '') {
  if (!code) return;
  const now = performance.now();
  if (code === lastLink && now - lastLinkAt < 3000) return; // launch URL + appUrlOpen can both fire
  lastLink = code; lastLinkAt = now;
  if (online.room && online.room.code === code) return;
  feedback.close();
  chat.close();
  ui.hideNotice();
  if (online.room) net.send({ t: 'leave' });
  if (mode === 'play') enterTitle(false); // a link wins over a local run
  online.menu = false;
  ui.hidePause();
  ui.hideGameOver();
  ui.hideTitle();
  setRoomInUrl(code, pass);
  openOnline(code, pass);
}

enterTitle();
if (params.has('stats')) openStatsPage(document.getElementById('ui')); // shareable link straight to the STATS page
if (params.get('room')) { ui.hideTitle(); openOnline(); }
requestAnimationFrame(frame);

// Debug handle
window.__kitty = {
  get sim() { return sim; }, get view() { return view; }, scene, camera, renderer, effects, audio, ui, startGame, keys, online, net, track,
  advance(seconds) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) tick(1 / 60); },
};

analytics.visit();
