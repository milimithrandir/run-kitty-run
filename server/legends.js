// Legends board: every win of the final run becomes one "legend" (the whole team, by name), and each kitty on it may
// leave a line for SIGN_WINDOW_MS. Online wins are server-verified: everyone in the room at the moment of the win is on
// it and signs over ws. Offline (solo / local co-op) wins can't be verified, so they're signed over HTTP
// (POST /api/legends) with light checks: final-run mode, a plausible game time, one per IP per 10 minutes (index.js),
// edits by the id + secret key the server hands back. Online winners get the board over ws; anyone can read it with
// GET /api/legends (after an offline win, and from the main menu's LEGENDS button), the newest wins of each mode.
// Two lists per mode are kept for good, whatever happens to the wins themselves (only the newest MAX_WINS are stored):
//   firsts   the first LIST_MAX different players to beat that mode, in order (a player counts once: the same account or
//            browser; wins from before the lists, and offline wins from older clients, can only tell players apart by name)
//   fastest  the LIST_MAX fastest whole games (total), each player or team with only its best one: a faster run of theirs
//            replaces it, and a new run faster than the slowest pushes that one off. Four lists in one (catOf): online
//            (server-verified) and local (offline, self-reported) games, each solo and team, LIST_MAX each
// Rewards (kept for good, a removed win takes them back): the golden kitty for the first team to beat a mode, the bronze
// kitty for number 1 on any of the fastest lists (until 2026-10-16 that gave the golden kitty: those players got the
// bronze one too).
// Players are kept as hashes of their account / browser ids, never sent anywhere.
import crypto from 'node:crypto';
// State is one JSON file (newest MAX_WINS wins), saved atomically a moment after each change.
import fs from 'node:fs';

const MAX_WINS = 1000;          // stored
const SEND_WINS = 100;          // sent to clients (newest first)
const TEXT_MAX = 140;           // characters (code points) per line
const SIGN_WINDOW_MS = 15 * 60e3;
const SAVE_DELAY_MS = 2000;
const FINAL_MODES = ['mixed', 'ice', 'run'];  // modes whose level 9 is the final run
const MIN_GAME_S = 300;                 // offline: the whole game (sim.time, levels 1-9) takes longer than this
const MAX_GAME_S = 12 * 3600;
const MIN_RUN_S = 15;                   // offline: the final run alone
const OFFLINE_PLAYERS = 2;              // solo or local co-op
const LIST_MAX = 100;                   // firsts / fastest: entries per mode
const LIST_MODES = ['mixed', 'run', 'ice'];
// the fastest lists: online / local (offline wins, self-reported) games, solo / team / chained team (a game played on
// chains: its own list; on the latest wins and the firsts with the others, marked)
const CATS = ['os', 'ot', 'ls', 'lt', 'oc', 'lc'];
const catOf = (f) => (f.kind ? 'l' : 'o') + (f.chain ? 'c' : (f.kind ? f.kind === 'solo' : (f.team || f.keys || []).length === 1) ? 's' : 't');
// wins taken off the board by hand (by id): dropped when the board loads, so a deploy removes them
const REMOVED = new Set(['murjptwl94a69a', 'mv8dky15adbec8', 'mv8g942e32c8f5']);   // (mv8dky15adbec8, mv8g942e32c8f5: test runs with a bot, 2026-10-14)
// lines written in by hand (win id -> one line per kitty, in order), for a winner whose signing failed: filled in when
// the board loads, only where that kitty has no line yet
const SET_LINES = { mv7wofqk847338: ['the one and only'] };
// whole-game times set by hand (win id -> seconds) for wins from before the board kept them (filled in only where missing):
// mv7wofqk847338 = its final level (895.7 s) + 17 minutes, as its winner asked
const SET_TOTAL = { mv7wofqk847338: 895.7 + 17 * 60 };
// players linked to a win by hand (win id -> one key per kitty, in order): the hashed browser id of a winner from before
// the lists knew who anyone was, sent by that winner (legends hash of 'p:' + their browser's id; the id itself never left it)
const ADD_KEYS = { mv7wofqk847338: ['2009d11be8285f7e0d9a'] };

// single line, no control / bidi-override characters, collapsed spaces, capped; no other filtering (the apps mask)
function cleanText(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, TEXT_MAX).join('').trim();
}

function createLegends(file) {
  // total: the whole game's time, levels 1-9 (wins from 2026-10-14 on; older ones only have runTime, the final level's)
  let wins = [];   // oldest first: { id, at, mode, kind?: 'solo' | 'coop' (offline wins), runTime, total?, entries: [{ name, color, text, at }] }
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(old.wins)) wins = old.wins.filter((w) => w && Array.isArray(w.entries) && !REMOVED.has(w.id)).slice(-MAX_WINS);
    for (const w of wins) if (Number.isFinite(SET_TOTAL[w.id]) && !Number.isFinite(w.total)) w.total = Math.round(SET_TOTAL[w.id] * 10) / 10;
    for (const w of wins) (SET_LINES[w.id] || []).forEach((t, i) => { const e = w.entries[i]; if (e && !e.text && cleanText(t)) { e.text = cleanText(t); e.at = new Date().toISOString(); } });
  } catch { /* first run, or unreadable: start fresh */ }
  // firsts[mode]: [{ win, idx, at, total?, name, color, text, keys }]; fastest[mode]: [{ win, at, total, kind, team: [{ name, color, text }], keys: [[...]], teamKey }]
  let golden = [], bronze = null;   // (see below: the golden and bronze kitties' players)
  let firsts = Object.fromEntries(LIST_MODES.map((m) => [m, []])), fastest = Object.fromEntries(LIST_MODES.map((m) => [m, []]));
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.firsts && old.fastest) {
      for (const m of LIST_MODES) { if (Array.isArray(old.firsts[m])) firsts[m] = old.firsts[m]; if (Array.isArray(old.fastest[m])) fastest[m] = old.fastest[m]; }
    } else if (wins.length) {
      // (the lists are new: built from the wins kept so far, oldest first; those only know their players' names)
      for (const w of wins) credit(w, w.entries.map((e) => [nameKey(e.name)]));
    }
  } catch { /* none yet */ }
  for (const m of LIST_MODES) {   // (a removed win leaves the lists too: its players can still make them later)
    firsts[m] = firsts[m].filter((f) => !REMOVED.has(f.win)); fastest[m] = fastest[m].filter((f) => !REMOVED.has(f.win));
    for (const f of firsts[m]) { const k = (ADD_KEYS[f.win] || [])[f.idx]; if (k && !f.keys.includes(k)) f.keys.push(k); }
    for (const f of fastest[m]) (ADD_KEYS[f.win] || []).forEach((k, i) => { if (k && f.keys[i] && !f.keys[i].includes(k)) f.keys[i].push(k); });
  }
  // golden: the golden kitty's players, [{ win, keys }]: the first team to beat a mode (and, until 2026-10-16, number 1
  // of the fastest list). bronze: the bronze kitty's, number 1 of any fastest list. Kept for good (a faster game later
  // doesn't take it away; a removed win does). Built from the lists when the board has none yet.
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(old.golden)) golden = old.golden;
    if (Array.isArray(old.bronze)) bronze = old.bronze;
  } catch { /* none yet */ }
  if (!golden.length) for (const m of LIST_MODES) {
    const f0 = firsts[m][0], s0 = fastest[m][0];
    if (f0) for (const f of firsts[m]) if (f.win === f0.win) golden.push({ win: f.win, keys: f.keys.slice() });   // (the whole first team)
    if (s0) for (const k of s0.keys) golden.push({ win: s0.win, keys: k.slice() });
  }
  golden = golden.filter((g) => !REMOVED.has(g.win));
  if (!bronze) {
    // (new: everyone who was number 1 of a fastest list so far, i.e. the golden kitty's players of a timed game (the
    // first team's game was number 1 too, when it had a time), and the number 1 of each list now that they are four)
    bronze = [];
    setTimeout(() => changed(), 0);   // (saved, once the board is up)
    const timed = new Set(wins.filter((w) => Number.isFinite(w.total)).map((w) => w.id));
    for (const m of LIST_MODES) for (const x of fastest[m]) timed.add(x.win);
    const firstWins = new Set(LIST_MODES.map((m) => firsts[m][0] && firsts[m][0].win).filter(Boolean));
    for (const g of golden) if (timed.has(g.win) || !firstWins.has(g.win)) bronze.push({ win: g.win, keys: g.keys.slice() });
    for (const m of LIST_MODES) for (const c of CATS) {
      const top = fastest[m].find((x) => catOf(x) === c);
      if (top) for (const k of top.keys) bronze.push({ win: top.win, keys: k.slice() });
    }
  }
  bronze = bronze.filter((g) => !REMOVED.has(g.win));
  // signer key (tab token / client id) -> { win, idx, until }; in memory only (a restart closes the signing windows)
  const elig = new Map();
  const offlineKeys = new Map(); // offline win id -> { key, until } (edit window; in memory only)
  let saveT = null, cache = null, cacheAt = 0;
  // the swag number of a player (its keys) -> cents, or 0 (index.js: accounts whose number shows); on the board on hover
  let paidOf = () => 0;
  const setPaid = (fn) => { paidOf = fn; cache = null; };
  const withPaid = (e, keys) => { const c = keys && keys.length ? paidOf(keys) : 0; return c ? { ...e, paid: c } : e; };
  // a win's kitties' keys (the lists know them: the fastest list each kitty's, the firsts its own)
  function winKeys(w) {
    const m = LIST_MODES.includes(w.mode) ? w.mode : 'mixed';
    const f = fastest[m].find((x) => x.win === w.id);
    if (f) return f.keys;
    const out = [];
    for (const x of firsts[m]) if (x.win === w.id) out[x.idx] = x.keys;
    return out;
  }

  function save() {
    saveT = null;
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ wins, firsts, fastest, golden, bronze }), (err) => {
      if (err) { console.error('legends save failed:', err.message); return; }
      fs.rename(tmp, file, (e) => { if (e) console.error('legends save failed:', e.message); });
    });
  }
  function changed() {
    cache = null;
    if (!saveT) saveT = setTimeout(save, SAVE_DELAY_MS);
  }
  function flush() {
    if (!saveT) return;
    clearTimeout(saveT); saveT = null;
    try { fs.writeFileSync(file, JSON.stringify({ wins, firsts, fastest, golden, bronze })); } catch (e) { console.error('legends flush failed:', e.message); }
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of elig) if (e.until < now) elig.delete(k);
    for (const [k, e] of offlineKeys) if (e.until < now) offlineKeys.delete(k);
  }, 60e3).unref();

  const keysOf = (c) => (c.tok ? [c.tok, 'id:' + c.id] : ['id:' + c.id]);
  // newest first, capped; cached as a string for the HTTP read
  // the newest SEND_WINS wins of each mode, newest first (the board has a tab per mode)
  const board = () => {
    const out = [], per = {};
    for (let i = wins.length - 1; i >= 0; i--) {
      const m = wins[i].mode || 'mixed';
      if ((per[m] = (per[m] || 0) + 1) <= SEND_WINS) {
        const w = wins[i], ks = winKeys(w);
        out.push(ks.some(Boolean) ? { ...w, entries: w.entries.map((e, j) => withPaid(e, ks[j])) } : w);
      }
    }
    return out;
  };
  const publicLists = () => ({
    firsts: Object.fromEntries(LIST_MODES.map((m) => [m, firsts[m].map((f) => withPaid({ win: f.win, at: f.at, total: f.total, name: f.name, color: f.color, text: f.text || '', ...(f.chain ? { chain: 1 } : {}), ...(f.vs ? { vs: 1 } : {}) }, f.keys))])),
    fastest: Object.fromEntries(LIST_MODES.map((m) => [m, fastest[m].map((f) => ({ win: f.win, at: f.at, total: f.total, kind: f.kind, ...(f.chain ? { chain: 1 } : {}), ...(f.vs ? { vs: 1 } : {}), team: (f.team || []).map((t, j) => withPaid(t, f.keys && f.keys[j])) }))])),
  });
  // (cached a minute: the swag numbers can change without the board changing)
  function boardJson() {
    if (!cache || Date.now() - cacheAt > 60e3) { cache = JSON.stringify({ ok: true, wins: board(), ...publicLists() }); cacheAt = Date.now(); }
    return cache;
  }
  const acctKey = (sub) => hash('a:' + sub);

  // ---- the permanent lists
  // A player's keys: hashes of their account and browser ids (either one matching = the same player), or of their
  // name when that is all there is. A list entry known only by name also matches a player of that name.
  function nameKey(n) { return hash('n:' + String(n || '').toLowerCase()); }
  function hash(s) { return crypto.createHash('sha256').update('rkr-legends:' + s).digest('hex').slice(0, 20); }
  function keysOfMember(m) {
    const k = [m && m.acct && hash('a:' + m.acct), m && m.pid && hash('p:' + m.pid)].filter(Boolean);
    return k.length ? k : [nameKey(m && m.name)];
  }
  function samePerson(f, keys, name) { return f.keys.some((k) => keys.includes(k)) || (f.keys.length === 1 && f.keys[0] === nameKey(f.name) && f.keys[0] === nameKey(name)); }
  // a player already on a mode's firsts: its entry takes the name it plays under now; its first win stays as it was (place,
  // date, time and the line it signed then). Only found by its account / browser keys, never by a name alone.
  function renameFirst(mode, keys, name) {
    const m = LIST_MODES.includes(mode) ? mode : 'mixed';
    if (!name || !keys || !keys.length || (keys.length === 1 && keys[0] === nameKey(name))) return;
    for (const f of firsts[m]) if (f.keys.some((k) => keys.includes(k)) && f.name !== name) { f.name = name; changed(); }
  }
  // a new win: its players onto the firsts (those not on it yet, while there is room; those on it: only their name now)
  // and the team onto the fastest
  function credit(win, keyList) {
    const m = LIST_MODES.includes(win.mode) ? win.mode : 'mixed';
    const F = firsts[m];
    const firstEver = !F.length;   // (the first team to beat this mode: all of them number 1)
    win.entries.forEach((e, idx) => {
      if (F.some((f) => samePerson(f, keyList[idx], e.name))) { renameFirst(m, keyList[idx], e.name); return; }
      if (F.length >= LIST_MAX) return;
      F.push({ win: win.id, idx, at: win.at, ...(Number.isFinite(win.total) ? { total: win.total } : {}), name: e.name, color: e.color, text: e.text || '', keys: keyList[idx], ...(win.chain ? { chain: 1 } : {}), ...(win.vs ? { vs: 1 } : {}) });
    });
    if (firstEver) keyList.forEach((k) => golden.push({ win: win.id, keys: k.slice() }));
    if (!Number.isFinite(win.total)) return;
    const teamKey = keyList.map((k) => k[0]).sort().join('|');
    const entry = { win: win.id, at: win.at, total: win.total, kind: win.kind, ...(win.chain ? { chain: 1 } : {}), ...(win.vs ? { vs: 1 } : {}), team: win.entries.map((e) => ({ name: e.name, color: e.color, text: e.text || '', ...(e.tm != null ? { tm: e.tm } : {}) })), keys: keyList, teamKey };
    const cat = catOf(entry), L = fastest[m], mine = L.findIndex((f) => f.teamKey === teamKey && catOf(f) === cat);
    if (mine >= 0) { if (L[mine].total <= win.total) return; L.splice(mine, 1); }
    L.push(entry);
    L.sort((a, b) => a.total - b.total || (a.at < b.at ? -1 : 1));
    // (LIST_MAX on each list: past that, its slowest goes)
    let n = 0;
    fastest[m] = L.filter((f) => catOf(f) !== cat || ++n <= LIST_MAX);
    if (bronze && fastest[m].find((f) => catOf(f) === cat) === entry) keyList.forEach((k) => bronze.push({ win: win.id, keys: k.slice() }));   // (a new fastest game: the bronze kitty)
  }
  // a line was (re)signed: the lists show it too
  function syncLists(win) {
    const m = LIST_MODES.includes(win.mode) ? win.mode : 'mixed';
    for (const f of firsts[m]) if (f.win === win.id && win.entries[f.idx]) {
      f.text = win.entries[f.idx].text || ''; f.name = win.entries[f.idx].name;
      if (!Number.isFinite(f.total) && Number.isFinite(win.total)) f.total = win.total;   // (lists saved before they kept the time)
    }
    for (const f of fastest[m]) if (f.win === win.id) f.team = win.entries.map((e) => ({ name: e.name, color: e.color, text: e.text || '' }));
  }
  for (const w of wins) syncLists(w);   // (lines written in by hand at load)

  const newId = (now) => now.toString(36) + crypto.randomBytes(3).toString('hex');
  function addWin(win) {
    wins.push(win);
    if (wins.length > MAX_WINS) wins.splice(0, wins.length - MAX_WINS);
    changed();
  }

  // A room won: one legend with everyone in it (names only until they write something), and a signing window each.
  // (versus: each member's team's place, 0 the winners: the board's │ between teams)
  function recordWin(mode, runTime, members, total, chain = false, versus = false) {
    const now = Date.now();
    const win = {
      id: newId(now), at: new Date(now).toISOString(), mode,
      runTime: Number.isFinite(runTime) ? Math.round(runTime * 10) / 10 : null,
      ...(Number.isFinite(total) ? { total: Math.round(total * 10) / 10 } : {}),
      ...(chain && members.length > 1 ? { chain: 1 } : {}),   // (played on chains)
      ...(versus ? { vs: 1 } : {}),   // (versus: teams against each other, the best team named first)
      entries: members.map((m, i) => ({ name: m.name, color: m.color, text: '', at: null, ...(Array.isArray(versus) && Number.isInteger(versus[i]) ? { tm: versus[i] } : {}) })),
    };
    members.forEach((m, idx) => { for (const k of keysOf(m)) elig.set(k, { win, idx, until: now + SIGN_WINDOW_MS }); });
    credit(win, members.map(keysOfMember));
    addWin(win);
    return win;
  }

  // this client's open signing window (the newest win it was part of), or null
  function eligibility(c) {
    const now = Date.now();
    for (const k of keysOf(c)) {
      const e = elig.get(k);
      if (e && e.until > now && wins.includes(e.win)) return e;
    }
    return null;
  }

  // what a winner gets: the board plus its own slot (text so far, ms left to sign)
  function boardFor(c) {
    const e = eligibility(c);
    if (!e) return null;
    return { t: 'legends', wins: board(), ...publicLists(), can: { id: e.win.id, text: e.win.entries[e.idx].text, left: e.until - Date.now() } };
  }

  // sign (or replace / clear) this client's line; returns the updated win or an error message
  function sign(c, text) {
    const e = eligibility(c);
    if (!e) return { err: 'The signing window for your win has closed.' };
    const entry = e.win.entries[e.idx];
    entry.text = cleanText(text);
    entry.at = entry.text ? new Date().toISOString() : null;
    if (c.name) entry.name = c.name; // signed with the in-game name the server knows, never a client-picked one
    syncLists(e.win);
    if (c.name) renameFirst(e.win.mode, keysOfMember(c), c.name);   // (a first win from before: the name, not its line)
    changed();
    return { win: e.win, entry };
  }

  // ---- offline wins (HTTP): m = { mode, runTime, time, players: [{ name, color, text }] } ----
  const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14);
  const cleanColor = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : 0xffb347);
  function offlinePlayers(m) {
    const ps = Array.isArray(m.players) ? m.players.slice(0, OFFLINE_PLAYERS) : [];
    return ps.map((p, i) => ({ name: cleanName(p && p.name) || `Kitty ${i + 1}`, color: cleanColor(p && p.color), text: cleanText(p && p.text) }));
  }
  // checks only (index.js applies the per-IP limit before calling create)
  function checkOffline(m) {
    if (!m || !FINAL_MODES.includes(m.mode)) return 'That mode has no final run.';
    const time = +m.time, runTime = +m.runTime;
    if (!(time >= MIN_GAME_S && time <= MAX_GAME_S) || !(runTime >= MIN_RUN_S && runTime <= time)) return 'That run looks a little too quick for the board.';
    if (!Array.isArray(m.players) || !m.players.length || m.players.length > OFFLINE_PLAYERS) return 'Who won, though?';
    return null;
  }
  function createOffline(m) {
    const now = Date.now();
    const ps = offlinePlayers(m);
    const win = {
      id: newId(now), at: new Date(now).toISOString(), mode: m.mode, kind: ps.length > 1 ? 'coop' : 'solo',
      runTime: Math.round(+m.runTime * 10) / 10, total: Math.round(+m.time * 10) / 10,
      ...(m.chain === true && ps.length > 1 ? { chain: 1 } : {}),   // (played on chains)
      entries: ps.map((p) => ({ name: p.name, color: p.color, text: p.text, at: p.text ? new Date(now).toISOString() : null })),
    };
    const key = crypto.randomBytes(12).toString('hex');
    offlineKeys.set(win.id, { key, until: now + SIGN_WINDOW_MS });
    // (players: the browser's id when the client sends it, one per seat; otherwise only their names)
    const pid = typeof m.pid === 'string' && /^[a-z0-9]{24,40}$/.test(m.pid) ? m.pid : '';
    credit(win, ps.map((p, i) => (pid ? [hash('p:' + pid + (i ? ':' + i : ''))] : [nameKey(p.name)])));
    addWin(win);
    return { win, key, left: SIGN_WINDOW_MS };
  }
  // edit the lines (same players, same order) of an offline win within its window
  function editOffline(m) {
    const k = offlineKeys.get(String(m && m.id || ''));
    const win = k && wins.find((w) => w.id === m.id);
    const key = Buffer.from(String(m && m.key || '')), want = k ? Buffer.from(k.key) : null;   // compare bytes: a non-ASCII key of the same length would throw
    if (!win || k.until < Date.now() || key.length !== want.length || !crypto.timingSafeEqual(key, want)) {
      return { err: 'The signing window for your win has closed.' };
    }
    const ps = Array.isArray(m.players) ? m.players : [];
    win.entries.forEach((e, i) => {
      if (!ps[i]) return;
      const text = cleanText(ps[i].text);
      if (text !== e.text) { e.text = text; e.at = text ? new Date().toISOString() : null; }
    });
    syncLists(win);
    changed();
    return { win, left: k.until - Date.now() };
  }

  // has this player ever been number 1 (the golden kitty)? (player: { acct, pids })
  function goldenFor(p) {
    const keys = keysOfPlayer(p);
    if (keys.length) bindAccount(p, keys);
    return keys.length > 0 && golden.some((g) => g.keys.some((k) => keys.includes(k)));
  }
  // ... and number 1 of a fastest list (the bronze kitty)?
  function bronzeFor(p) {
    const keys = keysOfPlayer(p);
    if (keys.length) bindAccount(p, keys);
    return keys.length > 0 && bronze.some((g) => g.keys.some((k) => keys.includes(k)));
  }
  const keysOfPlayer = (p) => [p && p.acct && hash('a:' + p.acct), ...((p && p.pids) || []).map((x) => hash('p:' + x))].filter(Boolean);
  // a place found through one of an account's browsers is tied to the account itself from then on (a new browser, or
  // cleared browser data, doesn't lose it)
  function bindAccount(p, keys) {
    const a = p && p.acct && hash('a:' + p.acct);
    if (!a) return;
    let n = 0;
    const bind = (ks) => { if (ks.some((k) => keys.includes(k)) && !ks.includes(a)) { ks.push(a); n++; } };
    for (const g of golden) bind(g.keys);
    for (const g of bronze) bind(g.keys);
    for (const m of LIST_MODES) { for (const f of firsts[m]) bind(f.keys); for (const f of fastest[m]) for (const ks of f.keys) bind(ks); }
    if (n) changed();
  }
  // a player's places on the lists (the swag account menu): [{ mode, first: place or null, fastest: place or null, total,
  // list: which fastest list ('os' online solo, 'ot' online team, 'ls' / 'lt' local) }], the best fastest place of the four
  // (player: { acct, pids }; a win counts when it was made signed in to that account, or in one of those browsers)
  function ranksFor(p) {
    const keys = keysOfPlayer(p);
    if (!keys.length) return [];
    bindAccount(p, keys);
    const out = [];
    for (const m of LIST_MODES) {
      const fi = firsts[m].findIndex((f) => f.keys.some((k) => keys.includes(k)));
      let best = null;
      for (const c of CATS) {
        const L = fastest[m].filter((f) => catOf(f) === c), i = L.findIndex((f) => f.keys.some((ks) => ks.some((k) => keys.includes(k))));
        if (i >= 0 && (!best || i < best.i)) best = { i, total: L[i].total, list: c };
      }
      if (fi >= 0 || best) out.push({ mode: m, first: fi >= 0 ? fi + 1 : null, fastest: best ? best.i + 1 : null, total: best ? best.total : null, ...(best ? { list: best.list } : {}) });
    }
    return out;
  }

  return { recordWin, eligibility, boardFor, sign, boardJson, ranksFor, goldenFor, bronzeFor, setPaid, acctKey, flush, checkOffline, createOffline, editOffline, TEXT_MAX };
}

export { createLegends, cleanText };
