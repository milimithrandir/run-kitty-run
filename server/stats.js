// Anonymous play stats. Clients send small events (POST /api/event) under a random per-browser id
// (no names, no IPs stored); the server keeps running totals + one row per day and serves them at
// GET /api/stats for the title screen's STATS page. State is one JSON file, saved every few seconds.
import fs from 'node:fs';

const KINDS = ['solo', 'coop', 'online'];
const MODES = ['mixed', 'run', 'ice'];
const DEVICES = ['desktop', 'touch', 'ios', 'android'];
const CID = /^[a-z0-9]{8,32}$/;
const EVENT_TYPES = ['visit', 'run_start', 'level', 'run_end', 'level_mismatch'];
const EVENTS_PER_HOUR = 400;        // per IP (a long session sends maybe 50)
const NEW_IDS_PER_HOUR = 20;        // per IP: new player ids (a family / school shares one; a script minting ids doesn't)
const MAX_PLAYER_IDS = 200000;      // ids remembered (first day seen); past this the oldest days' ids are forgotten
const SAVE_EVERY_MS = 5000;

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const HELL_MODES = ['run', 'ice'];
// hell games (run_start with hell: true, since 2026-10-24): games per hell mode and how many of them online. Not in
// kinds / modes (the STATS page shows them only to players who have hell open)
const blankHell = () => ({ games: { run: 0, ice: 0 }, online: { run: 0, ice: 0 } });
// chained games (run_start with chain: true): how many, and how many of them online; also counted in kinds / modes / hell
const blankChain = () => ({ games: 0, online: 0 });
// versus games (run_start with versus: true; online only): how many
const blankVersus = () => ({ games: 0 });
// every game started by all its choices (since 2026-10-30), per month: plays['YYYY-MM']['kind:mode:levels:difficulty:chain']
// = runs, e.g. 'coop:run:game:normal:pairs' (kind solo / coop / online; levels game / hell; difficulty normal / easy;
// chain off / pairs / everyone). Not on the STATS page: only in its JSON (/api/stats plays), to see what people play most
const playKey = (ev) => [ev.kind, ev.mode, ev.hell === true ? 'hell' : 'game', ev.easy === true ? 'easy' : 'normal',
  ev.chain === 'all' ? 'everyone' : ev.chain === true ? 'pairs' : 'off', ...(ev.versus === true ? ['versus'] : [])].join(':');   // (versus: a last part)
const blankDay = () => ({ newPlayers: 0, players: 0, runs: 0, levels: 0, deaths: 0, rescues: 0, seconds: 0, lobbies: 0, wins: 0 });

function createStats(file) {
  let s = {
    since: day(), players: {},                               // cid -> first day seen
    // wins: runs that cleared the Skate only final run (client run_end with won: true);
    // onlineWins: online games won (server side, once per room), onlineWinsByMode likewise
    totals: { runs: 0, levels: 0, deaths: 0, rescues: 0, seconds: 0, lobbies: 0, onlineGames: 0, bestLevel: 0, wins: 0, onlineWins: 0 },
    kinds: Object.fromEntries(KINDS.map((k) => [k, 0])),
    modes: Object.fromEntries(MODES.map((k) => [k, 0])),
    onlineWinsByMode: Object.fromEntries(MODES.map((k) => [k, 0])),
    devices: Object.fromEntries(DEVICES.map((k) => [k, 0])),
    days: {},                                                // 'YYYY-MM-DD' -> blankDay()
    today: { day: day(), seen: [] },                         // cids active today (for the daily unique count)
    peakOnline: { count: 0, at: null },
    hell: blankHell(),
    chain: blankChain(),
    versus: blankVersus(),
    plays: {},
  };
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    s = { ...s, ...old, totals: { ...s.totals, ...old.totals } };
    s.hell = { ...blankHell(), ...(old.hell || {}) };
    s.chain = { ...blankChain(), ...(old.chain || {}) };
    s.versus = { ...blankVersus(), ...(old.versus || {}) };
    s.plays = old.plays && typeof old.plays === 'object' ? old.plays : {};
  } catch { /* first run, or unreadable: start fresh */ }
  let todaySeen = new Set(s.today.day === day() ? s.today.seen : []);
  let playerIds = Object.keys(s.players).length;
  if (!Number.isFinite(s.totals.players) || s.totals.players < playerIds) s.totals.players = playerIds;   // all-time, survives forgetting
  // Keep the id map bounded (a script can mint 20 ids an hour per address forever): drop whole oldest days.
  function pruneIds() {
    if (playerIds <= MAX_PLAYER_IDS) return;
    const byDay = new Map();
    for (const [cid, d] of Object.entries(s.players)) { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(cid); }
    for (const d of [...byDay.keys()].sort()) {
      if (playerIds <= MAX_PLAYER_IDS * 0.9) break;
      for (const cid of byDay.get(d)) { delete s.players[cid]; playerIds--; }
    }
  }
  let dirty = false;
  const hits = new Map(); // ip -> [timestamps]
  const newIds = new Map(); // ip -> [timestamps of new cids]

  function save() {
    if (!dirty) return;
    dirty = false;
    s.today = { day: day(), seen: [...todaySeen] };
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(s), (err) => {
      if (err) { console.error('stats save failed:', err.message); return; }
      fs.rename(tmp, file, () => {});
    });
  }
  setInterval(save, SAVE_EVERY_MS).unref();
  // synchronous save for shutdown (index.js calls it on SIGTERM / SIGINT / a crash)
  const flush = () => { try { s.today = { day: day(), seen: [...todaySeen] }; fs.writeFileSync(file, JSON.stringify(s)); dirty = false; } catch (e) { console.error('stats flush failed:', e.message); } };

  function today() {
    const d = day();
    if (s.today.day !== d) { s.today = { day: d, seen: [] }; todaySeen = new Set(); }
    return (s.days[d] ||= blankDay());
  }

  function touch(cid, device) {
    const D = today();
    if (!s.players[cid]) {
      s.players[cid] = s.today.day;
      playerIds++; s.totals.players++;
      if (playerIds > MAX_PLAYER_IDS) pruneIds();
      D.newPlayers++;
      if (DEVICES.includes(device)) s.devices[device]++;
    }
    if (!todaySeen.has(cid)) { todaySeen.add(cid); D.players++; }
    return D;
  }

  const num = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);

  // ev: { cid, ev: 'visit' | 'run_start' | 'level' | 'run_end', ... }; ip (optional) caps new ids per IP
  function record(ev, ip) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev) || typeof ev.cid !== 'string' || !CID.test(ev.cid) || !EVENT_TYPES.includes(ev.ev)) return false;
    // JSON fields are untrusted: even String({ toString: null }) throws. Validate before using any field.
    if (['kind', 'mode', 'device', 'ver'].some((k) => ev[k] !== undefined && typeof ev[k] !== 'string')) return false;
    if (['level', 'seconds', 'deaths', 'rescues'].some((k) => ev[k] !== undefined && !Number.isFinite(ev[k]))) return false;
    if (ev.won !== undefined && typeof ev.won !== 'boolean') return false;
    if (ev.hell !== undefined && typeof ev.hell !== 'boolean') return false;
    if (ev.chain !== undefined && typeof ev.chain !== 'boolean' && ev.chain !== 'all') return false;   // (all: everyone on one chain)
    if (ev.easy !== undefined && typeof ev.easy !== 'boolean') return false;
    if (ev.versus !== undefined && typeof ev.versus !== 'boolean') return false;
    if (ip && !s.players[ev.cid]) {
      const now = Date.now();
      const h = (newIds.get(ip) || []).filter((t) => now - t < 3600e3);
      newIds.set(ip, h);
      if (h.length >= NEW_IDS_PER_HOUR) return false;
      h.push(now);
    }
    const D = touch(ev.cid, ev.device);
    const T = s.totals;
    switch (ev.ev) {
      case 'visit': break;
      case 'run_start':
        D.runs++; T.runs++;
        if (KINDS.includes(ev.kind) && MODES.includes(ev.mode)) { const m = (s.plays[day().slice(0, 7)] ||= {}), k = playKey(ev); m[k] = (m[k] || 0) + 1; }
        if (ev.chain === true || ev.chain === 'all') { s.chain.games++; if (ev.kind === 'online') s.chain.online++; }   // (and counted as usual below)
        if (ev.versus === true) s.versus.games++;   // (likewise)
        if (ev.hell === true) {   // a hell game: its own counts
          if (HELL_MODES.includes(ev.mode)) { s.hell.games[ev.mode]++; if (ev.kind === 'online') s.hell.online[ev.mode]++; }
          break;
        }
        if (KINDS.includes(ev.kind)) s.kinds[ev.kind]++;
        if (ev.kind === 'online' && MODES.includes(ev.mode)) s.modes[ev.mode]++; // lobby mode (solo/co-op are always Run + Skate)
        break;
      case 'level':
        D.levels++; T.levels++;
        T.bestLevel = Math.max(T.bestLevel, num(ev.level, 999));
        break;
      case 'run_end': {
        const sec = num(ev.seconds, 6 * 3600);
        D.seconds += sec; T.seconds += sec;
        const de = num(ev.deaths, 999), re = num(ev.rescues, 999);
        D.deaths += de; T.deaths += de; D.rescues += re; T.rescues += re;
        if (ev.won === true) { D.wins = (D.wins || 0) + 1; T.wins++; }   // older days were saved without wins
        break;
      }
      case 'level_mismatch':   // an online client generated a level whose hash differs from the server's (desync tripwire)
        T.levelMismatches = (T.levelMismatches || 0) + 1;
        console.warn(`level hash mismatch: mode ${(ev.mode || '').slice(0, 8)} level ${num(ev.level, 999)} device ${(ev.device || '').slice(0, 8)} ver ${(ev.ver || '').slice(0, 16)} what ${String(ev.what || '?').slice(0, 16)}`);
        break;
    }
    dirty = true;
    return true;
  }

  // server-side facts
  function lobbyCreated() { today().lobbies++; s.totals.lobbies++; dirty = true; }
  function onlineGameStarted() { s.totals.onlineGames++; dirty = true; }
  function onlineGameWon(mode) {
    s.totals.onlineWins++;
    if (MODES.includes(mode)) s.onlineWinsByMode[mode] = (s.onlineWinsByMode[mode] || 0) + 1;
    dirty = true;
  }
  function online(count) {
    if (count > s.peakOnline.count) { s.peakOnline = { count, at: new Date().toISOString() }; dirty = true; }
  }

  function summary(onlineNow) {
    today();
    const days = Object.keys(s.days).sort().map((d) => ({ day: d, ...s.days[d] }));
    return {
      since: s.since, players: s.totals.players, playersToday: todaySeen.size,
      onlineNow, peakOnline: s.peakOnline, totals: { ...s.totals, bestLevel: undefined },   // (best level: a spoiler, there's a level 9)
      kinds: s.kinds, modes: s.modes, devices: s.devices,
      onlineWinsByMode: s.onlineWinsByMode,
      hell: s.hell,
      chain: s.chain,
      versus: s.versus,
      plays: s.plays,
      days: days.slice(-120),
    };
  }

  function handle(req, res, ip, onlineNow) {
    const reply = (code, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET') return reply(200, summary(onlineNow()));
    if (req.method !== 'POST') return reply(405, { ok: false });
    const now = Date.now();
    const h = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
    if (h.length >= EVENTS_PER_HOUR) return reply(429, { ok: false });
    h.push(now); hits.set(ip, h);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      let ev;
      try { ev = JSON.parse(body); } catch { return reply(400, { ok: false }); }
      // This callback runs after the top-level HTTP handler's try/catch has returned.
      try {
        const ok = record(ev, ip);
        reply(ok ? 200 : 400, { ok });
      } catch (err) {
        console.error('stats event failed:', err.message);
        reply(500, { ok: false });
      }
    });
  }
  // forget old rate-limit buckets now and then
  setInterval(() => {
    const now = Date.now();
    for (const m of [hits, newIds]) for (const [ip, h] of m) if (!h.some((t) => now - t < 3600e3)) m.delete(ip);
  }, 600e3).unref();

  return { handle, record, lobbyCreated, onlineGameStarted, onlineGameWon, online, summary, save: flush, flush };
}

export { createStats };
