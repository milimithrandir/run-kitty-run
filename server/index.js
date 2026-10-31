// Run Kitty Run online server: serves the static client and runs authoritative lobbies over WebSockets.
// One Room = one lobby (max NET.MAX_PLAYERS). The first player in the lobby is its host and decides when to start.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CFG, NET, PLAYER_COLORS, PLAYER_NAMES, SKATE_FINAL_LEVEL, HELL_MODES, stageStep } from '../public/js/shared/config.js';
import { hashSeed } from '../public/js/shared/rng.js';
import { GAME_MODES, createSim, stepSim, addPlayer, removePlayer, chainGroups, chainJoin, chainLeave, chainRejoin, vsLeave, vsReturn, vsScore, loneOf, groupJoin, mergeReturn } from '../public/js/shared/sim.js';
import { serializeEnemies } from '../public/js/shared/enemies.js';
import { levelHash } from '../public/js/shared/maze.js';
import { createStats } from './stats.js';
import { createLegends } from './legends.js';
import { createLevelBoards } from './levelboards.js';
import { createAccounts, onePerPlayer, samePlayer } from './accounts.js';
import { pregenNext } from './levelgen.js';
import { SERVER_PAGES } from './pages.js';

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const GAMEOVER_TO_LOBBY_MS = 4000;
// The game won (sim state 'victory'): the room keeps stepping and snapshotting for the party (the song, the legends
// board) until every kitty in it has gone back to the lobby ('tolobby', the victory screen's BACK TO LOBBY), or
// VICTORY_TO_LOBBY_MS at most (older clients never say).
const VICTORY_TO_LOBBY_MS = 15 * 60e3;
// Client protocol versions (sent in the client's first 'hi' message, see net.js; clients that never send one
// count as 0). Bump a mode's floor when the shared sim changes so that an older client would desync there.
// Older clients can still play the other modes; they can't create or join these lobbies and don't see them listed.
//   2 = Skate only wolves walk deterministic patterns (protocol-1 clients simulate random wanderers)
//   3 = Skate only level 8 (SKATE_FINAL_LEVEL) is the final run and clearing it wins (older clients build the spiral)
//   4 = slim wolf resync format, used by every mode (with MIN_PROTOCOL 4 this only still matters for clients without 'hi')
const MODE_MIN_PROTOCOL = { ice: 4, mixed: 4, run: 4 };
// Finale versions (sim.finales, see maze.js generateLevel): the protocol each needs. A room plays the newest version
// every member has (older clients would build the older level 9 and desync); once it plays one, older clients can't
// join it mid-game.
const FINALE_PROTOCOL = [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 22, 23, 24, 25, 26, 28, 29, 30, 31, 32];   // (18: Run only level 9's wolves off at once; 19: a heart on every level; 20: boots turn faster on ice; 21: a heart in each half of Run + Skate's final, longer shortest rests; 22: 0.42 s on foot; 23: running levels' walks average the same, pickups inside; 24: wall stops up to 0.7 out)   // (15: the running final run's speed-up, Run only and Run + Skate; 16: anyone repairs Run + Skate's broken checkpoint; 17: its gift for a medic)   // 1 = Run only's level 9 final run, 2 = the wide skate final run, 3 = Run + Skate's both in a row, 4 = skate goal rooms without their back wolves, 5 = no lane-before-last wolf turning in the open, 6 = junction chargers, 7 = wolves per lane, 8 = running levels' long lanes, 9 = their other lanes, 10 = running levels' rests, 11 = items, 12 = Skate only's night seasons, 13 = Run + Skate by day then by night, 14 = its night half in the day's season
const CHEST_PROTOCOL = 21;   // clients from this protocol on draw the lottery chest (shared/sim.js)
const finalesOf = (members) => Math.min(...members.map((m) => FINALE_PROTOCOL.filter((p) => m.v >= p).length - 1));
// the newest finale version that changes this mode's levels (older ones build them the same): Run only 1 and 8 to 11,
// 15, 18 and 19, Skate only 2, 4 to 7, 11, 12 and 19, Run + Skate 2 to 11, 13 to 17 and 19
const finaleFor = (mode, f) => (f >= 24 ? 24 : f >= 23 ? 23 : f >= 22 ? 22 : f >= 21 ? 21 : f >= 20 ? 20 : f >= 19 ? 19 : mode === 'run' ? (f >= 18 ? 18 : f >= 15 ? 15 : f >= 8 ? Math.min(f, 11) : Math.min(f, 1)) : mode === 'ice' ? (f >= 11 ? Math.min(f, 12) : f >= 4 ? Math.min(f, 7) : f >= 2 ? 2 : 0) : (f >= 13 ? Math.min(f, 17) : f === 1 ? 0 : Math.min(f, 11)));   // (19-24: every mode)   // (12: Skate only only)
const runFinaleOk = (client, room) => !(room.phase === 'playing' && room.sim) || client.v >= FINALE_PROTOCOL[finaleFor(room.mode, room.sim.finales | 0)];
const modeOk = (client, mode) => client.v >= (MODE_MIN_PROTOCOL[mode] || 0);
const MODE_NAMES = { mixed: 'Run + Skate', run: 'Run only', ice: 'Skate only' };
// (a lobby's game in words, for the chat: "Hell Run only · Easy · Chained: pairs · Versus")
const modeName = (room) => [(room.hell ? 'Hell ' : '') + MODE_NAMES[room.mode], room.easy && 'Easy', room.chain && (room.chain === 'all' ? 'Chained: everyone' : 'Chained: pairs'), room.versus && 'Versus'].filter(Boolean).join(' · ');
// easy games (a level starts over when everyone is down): older clients would sit on a dead level
const EASY_PROTOCOL = 19;
// (easy hell: older clients play hell without the retry)
const EASY_HELL_PROTOCOL = 27;
const easyOk = (client, room) => !room.easy || client.v >= (room.hell ? EASY_HELL_PROTOCOL : EASY_PROTOCOL);
// hell games (config.js HELL_LEVELS): older clients would build level 9 once and win it. Anyone with this version may
// join one; creating one needs hell open in that mode (accounts.js hellOpenFor; offline progress: the client's word, hl)
const HELL_PROTOCOL = 25;
// (a hell game with its wolf waves, shared/waves.js: every member had them at its start; an older client can't join it)
const HELL_WAVES_PROTOCOL = 26;
const hellOk = (client, room) => !room.hell || (client.v >= HELL_PROTOCOL && !(room.sim && room.sim.waves && client.v < HELL_WAVES_PROTOCOL));   // (easy hell: easyOk)
// chained games (shared/sim.js chainPull: players 1+2, 3+4 on a chain): older clients don't know the chain and would
// see kitties pulled about; they can't join one
const CHAIN_PROTOCOL = 34;   // (33: the first, shorter chain)
const chainOk = (client, room) => !room.chain || client.v >= CHAIN_PROTOCOL;
// versus lobbies (teams against each other: shared/sim.js vsTeam): only clients that know the teams and their points
const VERSUS_PROTOCOL = 35;
const versusOk = (client, room) => !room.versus || client.v >= VERSUS_PROTOCOL;
const TEAM_MAX = 5;   // kitties in one versus team (as many full cards as the HUD shows)
// a game played on chains (its own level boards and fastest lists): a chained room with a pair in it
const chainedGame = (room) => !!(room.chain && room.sim && room.sim.chain && room.sim.players.length > 1);
const hellOpenFor = (client, mode) => accounts.hellOpenFor({ sub: client.acct, pid: client.pid }, mode) || levels.can9({ acct: client.acct, pid: client.pid });
const updateHow = (client) => (client.app === 'web' ? 'reload the page' : 'update the app');
const APPS = ['web', 'ios', 'android'];
// Test hooks (scripts/server-test.mjs): 'start' may pick a level and 'dbg' can drop a kitty in the goal.
// Never set this in production.
const TEST_HOOKS = process.env.RKR_TEST_HOOKS === '1';
// Player feedback is appended here as JSON lines (systemd gives the service /var/lib/run-kitty-run).
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../feedback.jsonl');
const FEEDBACK_MAX = 1000;          // characters per message
const FEEDBACK_PER_HOUR = 6;        // per IP
const MAX_ROOMS = 200;
const FEEDBACK_FILE_MAX = 5 << 20;  // bytes; stop appending past this (someone has to read it)
// Abuse limits per connection / IP. MAX_CONN_PER_IP can be raised for local load tests (scripts/server-test.mjs opens ~35).
const MAX_CONN_PER_IP = +process.env.MAX_CONN_PER_IP || 10;
const MAX_ROOMS_PER_IP = +process.env.MAX_ROOMS_PER_IP || 4;   // open lobbies created from one address (MAX_ROOMS is global)
const MSG_RATE = 150, MSG_BURST = 300;   // any message; ~60 inputs/s + pings is normal play. Over it: disconnect
const LOBBY_RATE = 1, LOBBY_BURST = 5;   // create / join / leave / list / start
// Invites (protocol 18+): a player's public friend id is a hash of its browser's progress id (which stays secret: it's
// the key to its unlock progress), so it can't be faked. Lobby members see each other's; a client remembers the people
// it played with, asks who of them is online ('seen'), and invites them into its lobby ('invite').
const INVITE_PROTOCOL = 18;
const SEEN_RATE = 0.5, SEEN_BURST = 4, SEEN_MAX = 30;   // who's online: one look every 2 s, up to 30 friends
const INVITE_RATE = 0.5, INVITE_BURST = 4;              // invites sent
const INVITE_AGAIN_MS = 15e3;                           // the same inviter, the same friend: once per 15 s
const invitedAt = new Map();                            // 'inviter>friend' -> when (oldest dropped past 5000)
const friendId = (pid) => (pid ? crypto.createHash('sha256').update('rkr-friend:' + pid).digest('base64url').slice(0, 16) : '');
const FID = /^[\w-]{16}$/;
const LOBBY_MSGS = new Set(['create', 'join', 'leave', 'list', 'start', 'team']);
// A client that stops reading would make us buffer its messages forever. Snapshots are ~1-10 KB at 20 Hz,
// so 1 MB is many seconds behind: it can't play anyway, drop it (it reconnects).
const MAX_BUFFERED = 1 << 20;
// Reconnect grace: a kitty that drops out mid-game and comes back (same tab token) within this keeps its state.
const REJOIN_GRACE_MS = 10 * 60e3;   // (10 minutes)
// Anonymous play stats (title screen STATS page) live next to the feedback file.
const stats = createStats(process.env.STATS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'stats.json'));
// Legends board (online winners sign it; see legends.js), next to the feedback file too.
const legends = createLegends(process.env.LEGENDS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'legends.json'));
// optional accounts (Google + Stripe): the total a player paid shows next to their name online
const accounts = createAccounts(process.env.ACCOUNTS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'accounts.json'));
accounts.setLegendRanks((a) => legends.ranksFor({ acct: a.sub, pids: a.pids }));
accounts.setGoldenCheck((who) => legends.goldenFor(who));
accounts.setBronzeCheck((who) => legends.bronzeFor(who));   // (the bronze kitty: number 1 of a fastest list)
// Level boards (levelboards.js): every level's fastest clears, online ones counted here, local ones reported by the game
const levels = createLevelBoards(process.env.LEVELS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'levels.json'));
accounts.backfillHell((sub, pids) => levels.hellResults(sub, pids));   // (once per account: hell games from before the account stats counted hell)
// the boards show a player's swag number on a name's hover: the accounts whose number shows, by each board's own key
// for them (looked up again at most once a minute)
let shownAt = 0, shownLegends = new Map(), shownLevels = new Map();
function shownMaps() {
  if (Date.now() - shownAt < 60e3) return;
  shownAt = Date.now();
  shownLegends = new Map(); shownLevels = new Map();
  for (const [sub, cents] of accounts.shownAll()) { shownLegends.set(legends.acctKey(sub), cents); shownLevels.set(levels.acctKey(sub), cents); }
}
legends.setPaid((keys) => { shownMaps(); for (const k of keys) { const c = shownLegends.get(k); if (c) return c; } return 0; });
levels.setPaid((key) => { shownMaps(); return shownLevels.get(key) || 0; });
// level 9's board: also for whoever played level 9 before the boards existed (the account's stats; or the browser says so,
// which only ever opens a board that shows times)
levels.setReachedBefore((who) => !!who.seen9 || accounts.reachedFinal(who.acct));
// (POST /api/levels, per IP: any request 30 burst then 2/s; a local game's cleared level 10 burst then 1 per 5 s)
const levelHits = new Map(), localHits = new Map();   // ip -> { tok, at }
setInterval(() => { const now = Date.now(); for (const m of [levelHits, localHits]) for (const [ip, h] of m) if (now - h.at > 600e3) m.delete(ip); }, 600e3).unref();   // (the golden kitty: ever number 1 on the board)   // (the swag account menu shows its places on the legends lists)
const accountHits = new Map(); // ip -> { tok, at } (token bucket)
setInterval(() => { const now = Date.now(); for (const [ip, h] of accountHits) if (now - h.at > 600e3) accountHits.delete(ip); }, 600e3).unref();
const SIGN_RATE = 0.2, SIGN_BURST = 3;     // legends: sign / edit your line
const LEGENDS_RATE = 0.5, LEGENDS_BURST = 3; // legends: ask for the board again (after a reconnect)
// Oldest client protocol still accepted at all (see PROTOCOL_VERSION in shared/config.js). App store builds lag the
// web, so only raise this when old clients would really break; they get an 'outdated' notice instead of a broken game.
// (Per-mode floors are MODE_MIN_PROTOCOL above.)
const MIN_PROTOCOL = 4;   // 4: slim wolf resync format (every mode resyncs wolves; older clients would break)
// Player reports (only the store apps have a Report button) are appended here as JSON lines, next to the feedback file by default.
const REPORTS_FILE = process.env.REPORTS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'reports.jsonl');
const REPORTS_PER_HOUR = 10;        // per IP, including reconnects
const REPORTS_GLOBAL_PER_HOUR = 500;
const REPORTS_FILE_MAX = 5 << 20;   // retain evidence, refuse new reports when full
const REPORT_REASONS = ['spam', 'abuse', 'name', 'other'];
const CHAT_HISTORY = 10;            // recent lines kept per player, attached to reports
// App deep links (Universal Links / Android App Links); set on the server, see deploy/run-kitty-run.service.
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'K46JJAK48B';
const ANDROID_CERT_SHA256 = (process.env.ANDROID_CERT_SHA256 || 'AA:BB:CC:PLACEHOLDER').split(',').map((s) => s.trim()).filter(Boolean);
const APP_ID = 'io.runkittyrun.app';
// The native apps load the client from these origins and call /api/* cross-origin.
const CORS_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);

// ---------------- static files ----------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

const WELL_KNOWN = {
  '/.well-known/apple-app-site-association': () => ({
    applinks: { details: [{ appIDs: [`${APPLE_TEAM_ID}.${APP_ID}`], components: [{ '/': '/', '?': { room: '*' } }] }] },
  }),
  '/.well-known/assetlinks.json': () => ([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: APP_ID, sha256_cert_fingerprints: ANDROID_CERT_SHA256 },
  }]),
};
// Clean addresses for the text pages (the ones search engines list: see public/sitemap.xml and the canonical links).
const PAGES = {
  '/privacy': '/privacy.html', '/terms': '/terms.html', '/support': '/support.html',
  '/about': '/about.html', '/how-to-play': '/how-to-play.html', '/warcraft-3-run-kitty-run': '/warcraft-3-run-kitty-run.html',
};

// Browser security headers on every response. The CSP (set on pages) allows the game's own files, the inline
// importmap in index.html (by hash, computed from the html at start so an edit can't break it), Sign in with Google
// (script, iframe, calls, styles; see developers.google.com/identity/gsi/web/guides/get-google-api-clientid), the
// WebSocket, and canvas images (share cards). No frame-ancestors: game portals embed the page in an iframe.
// CSP=off in the environment turns the policy off (if something new ever needs a source added).
const CSP_ON = process.env.CSP !== 'off';
const INLINE_SCRIPT_HASHES = (() => {
  const out = new Set();
  try {
    for (const f of fs.readdirSync(ROOT)) {
      if (!f.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        if (/\bsrc\s*=/.test(m[1]) || /application\/ld\+json/.test(m[1])) continue;   // (ld+json is data: never run, needs no hash)
        // (as the browser hashes it: its HTML parser turns CRLF into LF, so a Windows checkout's file still matches)
        out.add(`'sha256-${crypto.createHash('sha256').update(m[2].replace(/\r\n?/g, '\n')).digest('base64')}'`);
      }
    }
  } catch (e) { console.error('inline script hashes:', e.message); }
  return [...out];
})();
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')} https://accounts.google.com/gsi/client`.replace(/\s+/g, ' '),
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https://accounts.google.com/gsi/",
  "frame-src https://accounts.google.com/gsi/",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
function securityHeaders(req, res, html) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // behind Caddy (TLS ends there): a year of HTTPS-only for the browser
  if (req.headers['x-forwarded-proto'] === 'https' && isLoopback(req.socket.remoteAddress)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (html) {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (CSP_ON) res.setHeader('Content-Security-Policy', CSP);
  }
}

const server = http.createServer((req, res) => {
  req.on('error', () => res.destroy());
  guardHttp(res, () => handleHttp(req, res))();
});

function httpFailed(res, err) {
  console.error('http handler failed:', err.message);
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) res.writeHead(500);
  res.end();
}

// Event and filesystem callbacks run outside createServer's call stack. Also catch returned promises.
function guardHttp(res, fn) {
  return (...args) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') result.catch((err) => httpFailed(res, err));
    } catch (err) { httpFailed(res, err); }
  };
}

function streamFile(file, res, options) {
  const stream = fs.createReadStream(file, options);
  stream.on('error', (err) => { console.error('static file read failed:', err.message); res.destroy(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// weak validator: size + mtime is enough for files that are only ever replaced by a deploy
const etagOf = (st) => `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
function notModified(req, st, etag) {
  const inm = req.headers['if-none-match'];
  if (inm) return inm.split(',').some((t) => { t = t.trim(); return t === '*' || t === etag || t === etag.slice(2); });
  const ims = Date.parse(req.headers['if-modified-since'] || '');
  return Number.isFinite(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims;
}

function handleHttp(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
  securityHeaders(req, res, !path.extname(url.pathname) || url.pathname.endsWith('.html'));
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok'); return; }
  if (url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      }).end();
      return;
    }
    if (url.pathname === '/api/feedback') { handleFeedback(req, res); return; }
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') { accounts.webhook(req, res); return; }
    if (url.pathname.startsWith('/api/account/')) {
      const ip = clientIp(req), now = Date.now(), h = accountHits.get(ip) || { tok: 20, at: now };
      h.tok = Math.min(20, h.tok + (now - h.at) / 1000 * 0.5); h.at = now; accountHits.set(ip, h);   // 20 burst, 1 per 2s
      if (h.tok < 1) { res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"ok":false,"msg":"Slow down a little!"}'); return; }
      h.tok -= 1;
      if (accounts.handle(req, res, url.pathname.slice('/api/account/'.length))) return;
    }
    if (url.pathname === '/api/legends') { handleLegends(req, res); return; }
    if (url.pathname === '/api/levels') { handleLevelsHttp(req, res); return; }
    if (url.pathname === '/api/event' || url.pathname === '/api/stats') { stats.handle(req, res, clientIp(req), () => wss.clients.size); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false}');
    return;
  }
  if (WELL_KNOWN[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(WELL_KNOWN[url.pathname]()));
    return;
  }
  if (SERVER_PAGES[url.pathname]) {
    const body = Buffer.from(SERVER_PAGES[url.pathname]);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  let p;
  try { p = decodeURIComponent(PAGES[url.pathname] || url.pathname); } catch { res.writeHead(400).end(); return; }
  if (p.includes('\0')) { res.writeHead(400).end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, guardHttp(res, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    // no-cache = revalidate every time, which the ETag makes a cheap 304 (vendor/ isn't versioned, so it gets the same)
    const etag = etagOf(st);
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/music/') ? 'public, max-age=86400' : 'no-cache',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if ((req.method === 'GET' || req.method === 'HEAD') && notModified(req, st, etag)) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': headers['Last-Modified'], 'Cache-Control': headers['Cache-Control'] }).end();
      return;
    }
    // Range requests: needed for seeking audio, and Safari won't play media without them.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? +m[1] : st.size - +m[2];
      let end = m[1] && m[2] ? +m[2] : st.size - 1;
      if (start < 0) start = 0;
      end = Math.min(end, st.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      streamFile(file, res, { start, end });
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    streamFile(file, res);
  }));
}

// One service process owns each JSONL file. Serialize size-check + append so simultaneous submissions
// cannot overrun the cap; cap queued writes too. Existing evidence is kept until an operator archives it.
function boundedJsonl(file, maxBytes) {
  let tail = Promise.resolve(), pending = 0;
  return (entry) => {
    const line = JSON.stringify(entry) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) return Promise.resolve('full');
    if (pending >= 32) return Promise.resolve('busy');
    pending++;
    const write = tail.then(async () => {
      const handle = await fs.promises.open(file, 'a', 0o600);
      try {
        const st = await handle.stat();
        if (st.size + bytes > maxBytes) return 'full';
        await handle.appendFile(line, 'utf8');
        return 'ok';
      } finally { await handle.close(); }
    });
    tail = write.catch(() => {}).finally(() => { pending--; });
    return write;
  };
}

// ---------------- feedback ----------------
const appendFeedback = boundedJsonl(FEEDBACK_FILE, FEEDBACK_FILE_MAX);
const feedbackHits = new Map(); // ip -> [timestamps]
setInterval(() => { const now = Date.now(); for (const [ip, h] of feedbackHits) if (!h.some((t) => now - t < 3600e3)) feedbackHits.delete(ip); }, 600e3).unref();

const isLoopback = (a) => a === '::1' || /^(::ffff:)?127\./.test(a || '');
// Key for the per-address limits: an IPv6 host usually owns a whole /64, so count by that; IPv4 as is.
function ipKey(ip) {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
  const head = ip.split('::')[0] ? ip.split('::')[0].split(':') : [];
  while (head.length < 4) head.push('0');
  return head.slice(0, 4).join(':') + '::/64';
}
function clientIp(req) {
  const ra = req.socket.remoteAddress || '?';
  // behind Caddy (same box, so loopback): the first X-Forwarded-For entry is the real client.
  // From anywhere else the header is whatever the client made up.
  if (!isLoopback(ra)) return ra;
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || ra;
}

function handleFeedback(req, res) {
  const reply = (code, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') return reply(405, { ok: false });
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (feedbackHits.get(ip) || []).filter((t) => now - t < 3600e3);
  feedbackHits.set(ip, hits);
  if (hits.length >= FEEDBACK_PER_HOUR) return reply(429, { ok: false, msg: 'Thanks! That is plenty of feedback for now.' });
  hits.push(now); // counted up front: junk and oversized bodies use up the allowance too
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', guardHttp(res, async () => {
    let m;
    try { m = JSON.parse(body); } catch { return reply(400, { ok: false }); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.text !== 'string' ||
      ['name', 'mode', 'app', 'ver'].some((k) => m[k] !== undefined && typeof m[k] !== 'string') ||
      (m.level != null && !Number.isFinite(m.level))) return reply(400, { ok: false });
    const clean = (v, n) => (v || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
    const text = clean(m.text, FEEDBACK_MAX);
    if (text.length < 2) return reply(400, { ok: false, msg: 'Type a little more first.' });
    const entry = {
      at: new Date(now).toISOString(), text,
      name: clean(m.name, 20), mode: clean(m.mode, 12), app: clean(m.app, 8), ver: clean(m.ver, 16), level: Number.isFinite(m.level) ? m.level | 0 : null,
      ua: clean(req.headers['user-agent'], 160),
    };
    const result = await appendFeedback(entry);
    if (result !== 'ok') return reply(503, { ok: false, msg: 'Feedback is full right now, try again later.' });
    reply(200, { ok: true });
  }));
}

// ---------------- legends board ----------------
// Read-only board for offline winners (the client only asks after beating the final run: a soft gate).
const legendsHits = new Map(); // ip -> [timestamps]
setInterval(() => { const now = Date.now(); for (const [ip, h] of legendsHits) if (!h.some((t) => now - t < 60e3)) legendsHits.delete(ip); }, 600e3).unref();
const offlineSigns = new Map(); // ip -> [timestamps of offline wins put on the board]
const OFFLINE_WIN_EVERY_MS = 10 * 60e3;
setInterval(() => { const now = Date.now(); for (const [ip, h] of offlineSigns) if (!h.some((t) => now - t < OFFLINE_WIN_EVERY_MS)) offlineSigns.delete(ip); }, 600e3).unref();
function handleLegends(req, res) {
  if (req.method === 'POST') { handleOfflineSign(req, res); return; }
  if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
  const ip = clientIp(req), now = Date.now();
  const hits = (legendsHits.get(ip) || []).filter((t) => now - t < 60e3);
  legendsHits.set(ip, hits);
  if (hits.length >= 20) { res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
  hits.push(now);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(legends.boardJson());
}

// Offline (solo / local co-op) win: POST { mode, runTime, time, players: [{ name, color, text }] } puts it on the board
// (one per IP per 10 minutes) and returns { id, key }; POST { id, key, players: [{ text }] } edits the lines for 15 min.
function handleOfflineSign(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const ip = clientIp(req), now = Date.now();
  const hits = (legendsHits.get(ip) || []).filter((t) => now - t < 60e3);
  legendsHits.set(ip, hits);
  if (hits.length >= 20) return reply(429, { ok: false, msg: 'Slow down a little!' });
  hits.push(now);
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => { try { offlineSign(); } catch (err) { console.error('legends sign failed:', err); if (!res.headersSent) reply(400, { ok: false }); } });
  function offlineSign() {
    let m;
    try { m = JSON.parse(body); } catch { return reply(400, { ok: false }); }
    if (!m || typeof m !== 'object') return reply(400, { ok: false });
    if (m.id) {
      const r = legends.editOffline(m);
      return r.err ? reply(403, { ok: false, msg: r.err }) : reply(200, { ok: true, win: r.win, left: r.left });
    }
    const bad = legends.checkOffline(m);
    if (bad) return reply(400, { ok: false, msg: bad });
    const recent = (offlineSigns.get(ip) || []).filter((t) => now - t < OFFLINE_WIN_EVERY_MS);
    if (recent.length >= 1) return reply(429, { ok: false, msg: 'One win on the board every 10 minutes, legend. Try again in a bit!' });
    offlineSigns.set(ip, [...recent, now]);
    const r = legends.createOffline(m);
    reply(200, { ok: true, id: r.win.id, key: r.key, win: r.win, left: r.left });
  }
}

// A room just won: everyone in it at this moment is on the board and may sign it; each gets the board right away.
// the game's kitties (ids) best scorer first (the scoreboard's score: main.js), as the boards list a team's names (a big
// team shows its first few, the rest on hover)
const scoreOf = (p) => (p.rescues | 0) + (p.bonus || 0) - (p.deaths | 0) + Math.round(20 * (p.ran || 0)) + 5 * (p.finishes || 0);
function byScore(room, ids) {
  const sim = room.sim, s = (id) => { const p = sim && sim.players.find((q) => q.id === id); return p ? scoreOf(p) : -Infinity; };
  return ids.slice().sort((a, b) => s(b) - s(a));
}
function legendsOnWin(room, e) {
  if (room.easy) return;   // (the board is for games won without starting levels over)
  // (best scorer first; versus: the team with the most points first, and each one's team's place)
  const ids = room.versus && room.sim ? byTeamPoints(room, room.members.map((m) => m.id)) : byScore(room, room.members.map((m) => m.id));
  const members = ids.map((id) => room.members.find((m) => m.id === id));
  legends.recordWin(room.mode, e.time, members, room.sim ? room.sim.time : NaN, chainedGame(room), room.versus && room.sim ? teamPlaces(room, ids) : false);   // (the final level's time, the whole game's; chained, versus)
  for (const m of room.members) { const b = legends.boardFor(m); if (b) send(m.ws, b); }
}

// ---- level boards (levelboards.js): POST /api/levels { op, pid, acct (session token), ... }, no game connection needed
//   op 'board'  { id, board, scope, fids, group } -> the board (and this player's groups)
//   op 'group'  { act: 'create' (name, fresh) | 'join' (code) | 'leave' (id) | 'list', or its owner's 'remove' (id,
//               member) | 'restart' (id) } -> this player's groups
//   op 'local'  { mode, level, time, easy, players: [{ name, color }] } (one or two kitties on this device), or
//               { reached: 9, players }: a solo / local co-op game's cleared level, self-reported: on the local boards only;
//               { hell: true, easy, mode, level, far, time, players }: a local hell game's end, or an easy one's wipe (its local hell board)
const bucket = (map, ip, burst, rate) => {
  const now = Date.now(), h = map.get(ip) || { tok: burst, at: now };
  h.tok = Math.min(burst, h.tok + (now - h.at) / 1000 * rate); h.at = now; map.set(ip, h);
  if (h.tok < 1) return false;
  h.tok -= 1;
  return true;
};
function handleLevelsHttp(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') return reply(405, { ok: false });
  const ip = clientIp(req);
  if (!bucket(levelHits, ip, 30, 2)) return reply(429, { ok: false, msg: 'Slow down a little!' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body); } catch { return reply(400, { ok: false }); }
    if (!m || typeof m !== 'object') return reply(400, { ok: false });
    try {
      const pid = accounts.validPid(m.pid);
      const who = { acct: accounts.subFor(m.acct), pid, fid: friendId(pid), seen9: m.seen9 === true };
      if (m.op === 'board') return reply(200, { ok: true, id: m.id, ...levels.query(who, m), groups: levels.groupsOf(who) });
      if (m.op === 'group') {
        const r = m.act === 'create' ? levels.createGroup({ ...who, name: m.who }, m.name, !!m.fresh) : m.act === 'join' ? levels.joinGroup({ ...who, name: m.who }, m.code)
          : m.act === 'leave' ? levels.leaveGroup(who, m.id) : m.act === 'remove' ? levels.removeMember(who, m.id, m.member)
          : m.act === 'restart' ? levels.restartGroup(who, m.id) : {};
        return reply(200, { ok: !r.err, act: m.act, ...(r.err ? { msg: r.err } : {}), ...(r.group ? { group: r.group } : {}), groups: levels.groupsOf(who) });
      }
      if (m.op === 'local') {
        if (!bucket(localHits, ip, 10, 0.2)) return reply(429, { ok: false });
        const ps = Array.isArray(m.players) ? m.players.slice(0, 2) : [], run = runId();   // (one run: the two kitties' time shows once)
        ps.forEach((p, seat) => {
          const w = { acct: seat ? null : who.acct, pid, seat, fid: seat ? '' : who.fid, name: p && p.name, color: p && p.color };
          if (m.reached === levels.SECRET_LEVEL) levels.reach(w);
          else if (m.hell === true) levels.recordHell(w, { local: true, easy: !!m.easy, mode: m.mode, level: m.level, far: m.far, time: m.time, team: ps.length, run, chain: m.chain === true });
          else levels.record(w, { local: true, easy: !!m.easy, mode: m.mode, level: m.level, time: m.time, team: ps.length, run, chain: m.chain === true });
        });
        return reply(200, { ok: true });
      }
      reply(400, { ok: false });
    } catch (err) { console.error('level boards failed:', err); if (!res.headersSent) reply(500, { ok: false }); }
  });
}

// ---- global chat: a message to everyone playing who has it switched on ('gsub'), from anywhere in the game (the title
// screen, a Solo game, a lobby). Same limits as a room's chat but slower (one per 2 s, bursts of 3); unfiltered, the apps
// mask on their side; kept in the sender's chat log for reports. In a lobby the name is the lobby's; elsewhere the one
// the player picked (cleaned like a lobby name).
function handleGlobalChat(client, msg) {
  const now = Date.now();
  if (!client.gsub) return;
  if (!take(client, 'gchat', 0.5, 3, now)) return send(client.ws, { t: 'chat', sys: true, text: 'Slow down a little!' });
  const text = str(msg.text).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!text) return;
  const name = client.room ? client.name : cleanName(msg.name, 'Kitty');
  if (!client.room) client.name = name;   // (a report shows who it was)
  const color = client.room ? client.color : Number.isInteger(msg.color) && msg.color >= 0 && msg.color <= 0xffffff ? msg.color : PLAYER_COLORS[0];
  client.chatLog.push({ at: new Date(now).toISOString(), room: 'global', text });
  if (client.chatLog.length > CHAT_HISTORY) client.chatLog.shift();
  const out = JSON.stringify({ t: 'gchat', id: client.id, name, color, text });
  for (const c of clients.values()) if (c.gsub && c.ws.readyState === 1) send(c.ws, out);
}

function handleSign(client, msg) {
  if (!take(client, 'sign', SIGN_RATE, SIGN_BURST, Date.now())) return send(client.ws, { t: 'signed', ok: false, msg: 'Slow down a little!' });
  const r = legends.sign(client, msg.text);
  if (r.err) return send(client.ws, { t: 'signed', ok: false, msg: r.err });
  send(client.ws, { t: 'signed', ok: true, id: r.win.id, text: r.entry.text });
  // everyone else on that legend who is online sees the line appear (only winners of that run, never bystanders)
  const s = JSON.stringify({ t: 'legend', win: r.win });
  for (const c of clients.values()) {
    if (c.ws.readyState !== 1) continue;
    const el = legends.eligibility(c);
    if (el && el.win === r.win) send(c.ws, s);
  }
}

// ---------------- rooms ----------------
const rooms = new Map(); // code -> Room
let nextClientId = 1;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

// JSON fields are untrusted: String({ toString: null }) throws, so only real strings count (anything else is '').
const str = (v) => (typeof v === 'string' ? v : '');

function cleanName(n, fallback) {
  const s = str(n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return s || fallback;
}

// private lobbies: a short password (case-sensitive), '' = public
function cleanPass(p) {
  return str(p).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const m of room.members) send(m.ws, s);
}

// the open, invitable clients with this friend id (the same browser may have more tabs open)
function friendClients(fid) {
  const out = [];
  for (const c of clients.values()) if (c.fid === fid && c.v >= INVITE_PROTOCOL && c.ws && c.ws.readyState === 1) out.push(c);
  return out;
}
// the one that tells where they are: a tab not playing first
const friendClient = (fid) => { const cs = friendClients(fid); return cs.find((c) => !c.room || c.room.phase !== 'playing') || cs[0] || null; };
const friendState = (c) => (!c ? 'off' : !c.room ? 'online' : c.room.phase === 'playing' ? 'playing' : 'lobby');
// who of these friends is online now: 'online' (the Multiplayer menu), 'lobby', 'playing' (missing: not online)
function handleSeen(client, msg) {
  if (!take(client, 'seen', SEEN_RATE, SEEN_BURST, Date.now()) || !Array.isArray(msg.fids)) return;
  const list = [];
  for (const fid of msg.fids.slice(0, SEEN_MAX)) {
    if (typeof fid !== 'string' || !FID.test(fid) || fid === client.fid) continue;
    const st = friendState(friendClient(fid));
    if (st !== 'off') list.push({ fid, st });
  }
  send(client.ws, { t: 'seen', list });
}
// an invite into the inviter's lobby: the friend gets the code (and a private lobby's password) and a JOIN button
function handleInvite(client, msg) {
  const fid = typeof msg.fid === 'string' && FID.test(msg.fid) ? msg.fid : '';
  const reply = (ok, text) => send(client.ws, { t: 'invited', fid, ok, msg: text });
  if (!fid || !client.room || client.v < INVITE_PROTOCOL) return reply(false, 'Join or start a lobby first.');
  if (!take(client, 'invite', INVITE_RATE, INVITE_BURST, Date.now())) return reply(false, 'Slow down a little!');
  const room = client.room, all = friendClients(fid).filter((c) => c !== client);
  if (!all.length) return reply(false, 'Not online right now.');
  if (all.some((c) => c.room === room)) return reply(false, 'Already in your lobby.');
  const to = all.filter((c) => !c.room || c.room.phase !== 'playing');   // (every tab of theirs that isn't mid-game)
  if (!to.length) return reply(false, 'In a game right now.');
  if (room.members.length >= (room.max || NET.MAX_PLAYERS)) return reply(false, 'Your lobby is full.');
  // the same inviter, the same friend: once per INVITE_AGAIN_MS (kept per friend id, whichever tab)
  const key = (client.fid || 'c' + client.id) + '>' + fid, last = invitedAt.get(key) || 0;
  if (Date.now() - last < INVITE_AGAIN_MS) return reply(false, 'Invited! Give them a moment.');
  invitedAt.set(key, Date.now());
  if (invitedAt.size > 5000) invitedAt.delete(invitedAt.keys().next().value);
  const json = JSON.stringify({ t: 'invite', name: client.name || 'A kitty', color: client.color, code: room.code, mode: room.mode, easy: room.easy || undefined,
    pass: room.pass || undefined, fid: client.fid || undefined, hell: room.hell || undefined, chain: room.chain || undefined });   // (fid: who it's from: the friend can block their invites)
  for (const c of to) send(c.ws, json);
  reply(true, 'Invite sent!');
}

function roomInfo(room) {
  return {
    t: 'room', code: room.code, host: room.hostId, phase: room.phase, mode: room.mode, easy: room.easy || undefined, hell: room.hell || undefined, chain: room.chain || undefined, max: room.max || NET.MAX_PLAYERS,
    locked: !!room.pass, pass: room.pass || undefined,   // private lobby: its members see the password (to pass it on)
    members: room.members.map((m) => ({ id: m.id, name: m.name, color: m.color, app: m.app, paid: m.paid || undefined,   // paid: cents (accounts.js)
      fid: m.fid || undefined,   // public friend id (invites)
      cos: m.cos && m.cos.length ? m.cos : undefined,   // cos: switched-on unlocks (shared/unlocks.js)
      ps: m.paid && m.ps ? m.ps : undefined })),   // ps: how the number is drawn ('koi'; none: the classic tag)
    order: room.chain ? chainOrder(room).slice() : undefined,   // chained: who chains up with whom (member ids, chain order)
    versus: room.versus || undefined,   // versus: the teams [{ id, name }] (members' team: mt, member id -> team id)
    teams: room.versus ? [...room.teams].map(([id, t]) => ({ id, name: t.name, req: t.req.size ? [...t.req] : undefined, ready: t.ready || undefined })) : undefined,   // (req: who asks to join it; ready: set to go)
    mt: room.versus ? Object.fromEntries(room.members.map((m) => [m.id, m.team])) : undefined,
    search: room.search ? (room.searchAny ? 'any' : true) : undefined,   // versus: looking for opponents (matchmake; 'any': in any mode)
    anyMode: room.searchAny || undefined,   // ...the any mode switch (also while not searching)
  };
}

function sendRoom(room) {
  const info = roomInfo(room);
  for (const m of room.members) send(m.ws, { ...info, you: m.id });
}

function lobbyList(client) {
  const list = [];
  for (const r of rooms.values()) {
    if (r.members.length === 0) continue;
    if (!modeOk(client, r.mode) || !runFinaleOk(client, r) || !easyOk(client, r) || !hellOk(client, r) || !chainOk(client, r) || !versusOk(client, r)) continue; // this client's build can't play that mode / game
    list.push({
      code: r.code, players: r.members.length, max: r.max || NET.MAX_PLAYERS, phase: r.phase, locked: !!r.pass,
      host: (r.members.find((m) => m.id === r.hostId) || r.members[0]).name,
      level: r.sim ? (r.sim.hell ? r.sim.level : r.sim.levelData.level || r.sim.level) : 0, mode: r.mode, easy: r.easy || undefined, hell: r.hell || undefined, chain: r.chain || undefined, versus: r.versus || undefined,
    });
  }
  return list.sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.players - a.players).slice(0, 30);
}

function freeColorSlot(room) {
  for (let i = 0; i < NET.MAX_PLAYERS; i++) if (!room.members.some((m) => m.slot === i)) return i;
  return 0;
}

// The client's preferred colour (index into PLAYER_COLORS, sent with create / join) if no one in the lobby has it.
function colorSlot(room, pref) {
  const p = Number.isInteger(pref) && pref >= 0 && pref < Math.min(NET.MAX_PLAYERS, PLAYER_COLORS.length) ? pref : -1;
  return p >= 0 && !room.members.some((m) => m.slot === p) ? p : freeColorSlot(room);
}

function joinRoom(client, room, name, pref, pass) {
  // Covers every way in: lobby list, code, invite deep link, reconnect rejoin, mid-game join.
  // 'code' in the text makes clients drop ?room= from the URL so they don't retry the link.
  if (!modeOk(client, room.mode)) return send(client.ws, { t: 'error', msg: `That lobby code is for ${MODE_NAMES[room.mode]}, which needs the latest version - ${updateHow(client)} to play it.` });
  if (!easyOk(client, room)) return send(client.ws, { t: 'error', msg: `That lobby plays an easy game, which needs the latest version - ${updateHow(client)} to play it.` });
  if (!hellOk(client, room)) return send(client.ws, { t: 'error', msg: `That lobby plays hell, which needs the latest version - ${updateHow(client)} to play it.` });
  if (!chainOk(client, room)) return send(client.ws, { t: 'error', msg: `That lobby plays chained, which needs the latest version - ${updateHow(client)} to play it.` });
  if (!versusOk(client, room)) return send(client.ws, { t: 'error', msg: `That lobby plays versus, which needs the latest version - ${updateHow(client)} to play it.` });
  // chained versus in progress: no kitty on its own (it would have no chain); one coming back to its team, or a team the
  // matchmaker brings in (two or more), can
  if (room.versus && room.chain && room.phase === 'playing' && !(client.vsMove && client.vsMove.room === room) && !leftKey(room, client)) {
    return send(client.ws, { t: 'error', msg: 'That chained versus game is in progress: join it with a team of two or more (Find opponents).' });
  }
  if (!runFinaleOk(client, room)) return send(client.ws, { t: 'error', msg: `That game is playing the new level 9 - ${updateHow(client)} to join it.` });
  const max = room.max || NET.MAX_PLAYERS;
  if (room.members.length >= max) return send(client.ws, { t: 'error', msg: `That lobby is full (${max}/${max}).` });
  // private lobby: the password, unless this is a kitty coming back within the reconnect grace (room.left)
  if (room.pass && cleanPass(pass) !== room.pass && !(client.tok && room.left && room.left.has(client.tok))) {
    return send(client.ws, { t: 'error', need: 'password', code: room.code, msg: pass ? 'Wrong password for that lobby.' : 'That lobby is private: enter its password.' });
  }
  leaveRoom(client);
  const slot = colorSlot(room, pref);
  client.room = room;
  client.cos = accounts.cosForPlayer({ sub: client.acct, pid: client.pid }, room.mode);   // the unlocks it wears in this mode
  client.slot = slot;
  client.name = cleanName(name, PLAYER_NAMES[slot]);
  client.color = PLAYER_COLORS[slot];
  client.inputs = new Map();
  client.lastInput = null; // nothing received yet
  client.margin = NET.INPUT_LEAD;
  room.members.push(client);
  if (!room.hostId) room.hostId = client.id;
  if (room.versus) joinTeam(room, client);
  sendRoom(room);
  broadcast(room, { t: 'chat', sys: true, text: `${client.name} joined` });
  if (room.phase === 'playing') {
    // Join mid-game: spawn now; send full state (including wolves) so the newcomer is in sync.
    const p = addPlayer(room.sim, { id: client.id, name: client.name, color: client.color, team: client.team });
    const at = restoreLeft(room, client, p);
    chainJoin(room.sim, p);   // (chained, and not back on its old chain: a partner, beside it)
    if (at) { p.x = at.x; p.z = at.z; }   // (versus: carried back in, it stays with its carrier)
    // Mid-victory: join the party in the goal room instead of starting alone at the far end of the final run.
    if (room.sim.state === 'victory') {
      const a = room.sim.players.length * 2.399963, r = 3.3;
      p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.vx = 0; p.vz = 0;
      p.heading = Math.atan2(-p.z, -p.x);
      p.inCenter = true;
    }
    send(client.ws, startMsg(room, true));
    sendChains(room);
  }
}

// ---- reconnect grace ----
// Someone who leaves a running game (dropped socket or LEAVE) and comes back within REJOIN_GRACE_MS gets their kitty
// back as it was: lives, deaths, rescues, crown... and a kitty that was down stays down (in its rescue circle) on the
// same level, so leaving and rejoining is not a free revive. Matched by the tab token from 'hi' (net.js); a downed
// kitty is also matched by IP, so a new tab / cleared storage doesn't dodge it either. Anyone else joining mid-game is
// a genuine drop-in and spawns alive with spawn invulnerability, as before (that is how friends join a running game).
function pruneLeft(room, now = Date.now()) {
  for (const [k, r] of room.left) {
    if (!(now - r.at > REJOIN_GRACE_MS || r.sim !== room.sim)) continue;
    room.left.delete(k);
  }
}

// ---- versus teams ----
// A newcomer's team: a new one of its own (in the lobby it can ask to join another, 'team'; joining a running game it
// plays as a team of one), unless it's back in time from a running game: then the team it had (room.left)
function joinTeam(room, client) {
  const back = room.phase === 'playing' && room.left && room.left.get(leftKey(room, client));
  const moved = client.vsMove && client.vsMove.room === room && room.teams.has(client.vsMove.team) ? client.vsMove.team : 0;   // (the matchmaker: with its team)
  client.vsMove = null;
  client.team = moved || (back && room.teams.has(back.team) ? back.team : newTeam(room, client));
}

// ---- versus matchmaking: a versus lobby's host turns on FIND OPPONENTS (room.search). Every MATCH_EVERY_MS a searching
// lobby is put together with another searching lobby of the same mode and chained setting (the smaller one moves into
// the bigger, teams and their names kept; the room keeps searching for more), or, with none, it joins a running versus
// game that was searching when it started (its teams come in as teams of their own and play on from there). Rooms must
// fit (room.max); private lobbies only match each other's searches (their kitties chose to).
const MATCH_EVERY_MS = 1500;
// (the same chained setting always; the same mode unless one searches in any mode (room.searchAny): that one plays the
// other's mode)
const modeFits = (a, b) => a.mode === b.mode || !!a.searchAny || !!b.searchAny;
function moveTeams(from, to) {
  const map = new Map();
  if (to.versus) for (const [id, t] of from.teams) {
    const nid = to.nextTeam++;
    to.teams.set(nid, { name: t.name, req: new Set() });
    map.set(id, nid);
  }
  for (const m of from.members.slice()) {
    if (to.versus) m.vsMove = { room: to, team: map.get(m.team) };
    joinRoom(m, to, m.name, m.slot, to.pass);
    if (m.room === to) send(m.ws, { t: 'chat', sys: true, text: to.versus ? 'Opponents found!' : 'Players found!' });
    else m.vsMove = null;
  }
  if (from.members.length && rooms.has(from.code)) {   // (some couldn't come: an older version of the game)
    from.search = false;
    for (const m of from.members) send(m.ws, { t: 'chat', sys: true, text: 'Players were found, but not everyone here could join them (an older version of the game?). Searching stopped.' });
    sendRoom(from);
  }
  for (const t of to.teams.values()) t.ready = false;
  if (to.phase === 'lobby') sendRoom(to);
}
// a versus lobby's team with only one kitty (chained versus can't start with one: it would have no chain)
const soloTeam = (room) => [...room.teams.keys()].some((id) => room.members.filter((m) => m.team === id).length === 1);
// (every mode since: FIND PLAYERS in any lobby; versus ones only with versus ones, the others with the others, and the
// same chained, easy and hell)
const sameKind = (a, b) => !!a.versus === !!b.versus && (a.chain || '') === (b.chain || '') && !!a.easy === !!b.easy && !!a.hell === !!b.hell;
function matchmake() {
  const searching = [...rooms.values()].filter((r) => r.search && r.members.length);
  const lobbies = searching.filter((r) => r.phase === 'lobby').sort((a, b) => b.members.length - a.members.length);
  for (const r of lobbies) {
    if (!rooms.has(r.code) || r.phase !== 'lobby') continue;   // (moved into another this round)
    const fits = (o) => o !== r && rooms.has(o.code) && sameKind(o, r) && o.members.length + r.members.length <= Math.min(o.max || NET.MAX_PLAYERS, r.max || NET.MAX_PLAYERS);
    // (a lobby of its own mode first; a game in progress plays its mode: the lobby joins it only in that mode or any)
    const other = lobbies.find((o) => o.phase === 'lobby' && fits(o) && o.mode === r.mode) || lobbies.find((o) => o.phase === 'lobby' && fits(o) && modeFits(o, r))
      || searching.find((o) => o.phase === 'playing' && o.sim && o.sim.state === 'playing' && fits(o) && (o.mode === r.mode || r.searchAny) && !(o.versus && o.chain && soloTeam(r)));   // (chained versus: no team of one)
    if (!other) continue;
    // who moves (and so plays the other's mode): into a running game always the lobby; of two lobbies with different modes
    // where only one searches in any mode, that one (the other keeps the mode it picked, whatever the sizes); else the
    // smaller group (the bigger one's mode is played)
    const anyMoves = other.phase === 'lobby' && other.mode !== r.mode && !!r.searchAny !== !!other.searchAny;
    const [from, to] = other.phase === 'playing' ? [r, other] : anyMoves ? (r.searchAny ? [r, other] : [other, r]) : other.members.length >= r.members.length ? [r, other] : [other, r];
    moveTeams(from, to);
  }
}
setInterval(matchmake, MATCH_EVERY_MS).unref();
// versus: the game's kitties (ids) best team first (its points), in their order within a team (the boards list them so)
function byTeamPoints(room, ids) {
  const sim = room.sim, teamOf = (id) => (sim.players.find((p) => p.id === id) || {}).team;
  const mine = (id) => { const p = sim.players.find((q) => q.id === id); return p ? scoreOf(p) : -Infinity; };   // (then within a team)
  return ids.slice().sort((a, b) => vsOrder(sim, teamOf(a), teamOf(b)) || (teamOf(a) | 0) - (teamOf(b) | 0) || mine(b) - mine(a));
}
// two teams' order (as the end cards: ui.js rankOrder): more points, then more crowns, then fewer times caught; 0: a draw
function vsOrder(sim, a, b) {
  const A = sim.teams[a], B = sim.teams[b];
  if (!A || !B) return (B ? 1 : 0) - (A ? 1 : 0);
  return (vsScore(B) - vsScore(A)) || (B.crowns - A.crowns) || (A.deaths - B.deaths);
}
// versus over (everyone down, or the final level won): a game on everyone's account, a win for the team in 1st (a draw on
// points: more crowns, then fewer times caught; all the same: every one of them) (once per player)
function vsResults(room) {
  const sim = room.sim, ids = Object.keys(sim.teams).map(Number).filter((t) => sim.players.some((p) => p.team === t));   // (teams still in it)
  const top = ids.filter((t) => ids.every((o) => vsOrder(sim, t, o) <= 0));   // (no team ahead of it: the winners, a draw all of them)
  for (const m of onePerPlayer(room.members.filter((x) => sim.players.some((p) => p.id === x.id)))) {
    const p = sim.players.find((q) => q.id === m.id);
    if (!vsCounted(room, m)) accounts.recordOnline(m.acct, { type: 'vsGame' });
    if (p && top.includes(p.team)) accounts.recordOnline(m.acct, { type: 'vsWin' });
  }
}
// leaving a versus game counts it as played (a loss) right away, once per player (room.vsPlayed: its account, browser)
function vsCounted(room, m) {
  const keys = [m.acct && 'a:' + m.acct, m.pid && 'p:' + m.pid].filter(Boolean), was = keys.some((k) => room.vsPlayed.has(k));
  for (const k of keys) room.vsPlayed.add(k);
  return was;
}
// ...and each one's team's place in that order (0: the winners), for the boards' │ between teams
function teamPlaces(room, ids) {
  const teamOf = (id) => (room.sim.players.find((p) => p.id === id) || {}).team, seen = [];
  return ids.map((id) => { const t = teamOf(id); if (!seen.includes(t)) seen.push(t); return seen.indexOf(t); });
}
function newTeam(room, client) {
  const id = room.nextTeam++;
  room.teams.set(id, { name: cleanName('Team ' + client.name, 'Team ' + id), req: new Set() });
  return id;
}
// lobby only: teams nobody is in any more go (a running game keeps them, with their points)
function pruneTeams(room) {
  if (!room.versus || room.phase === 'playing') return;
  for (const id of [...room.teams.keys()]) if (!room.members.some((m) => m.team === id)) room.teams.delete(id);
  for (const [id, t] of room.teams) for (const r of t.req) if (!room.members.some((m) => m.id === r && m.team !== id)) t.req.delete(r);   // (gone, or in it now)
}
// 'settings' (the host, in the lobby): another mode, normal / easy, hell, chained, versus, without making a new lobby.
// Checked as 'create' does, and every kitty in the lobby has to be able to play it (else nothing changes and the host
// hears who can't). Versus turned on or off: everyone a team of their own / no teams (as the versus switch)
function settingsMsg(room, client, msg) {
  if (!room || room.phase !== 'lobby' || room.hostId !== client.id) return;
  const mode = GAME_MODES.includes(msg.mode) ? msg.mode : room.mode;
  const hell = msg.hell === true;
  if (hell && (!HELL_MODES.includes(mode) || (!hellOpenFor(client, mode) && msg.hl !== true))) return send(client.ws, { t: 'error', msg: 'Reach the final level in any mode to open hell, or clear a level of it in someone\'s lobby.' });
  const versus = msg.versus === true;
  const next = { mode, hell: hell || undefined, easy: msg.easy === true && !versus, chain: msg.chain === 'all' ? 'all' : msg.chain === true || undefined, versus: versus || undefined };
  const t = { ...room, ...next };
  const cant = room.members.filter((m) => !modeOk(m, mode) || !easyOk(m, t) || !hellOk(m, t) || !chainOk(m, t) || !versusOk(m, t));
  if (cant.length) return send(client.ws, { t: 'error', msg: `${cant.map((m) => m.name).join(', ')} can't play that yet (an older version of the game) - pick another mode, or they can update.` });
  const vsChanged = !!room.versus !== !!next.versus;
  Object.assign(room, next);
  if (vsChanged) {
    room.teams = new Map();
    for (const m of room.members) m.team = room.versus ? newTeam(room, m) : undefined;
  }
  for (const tm of room.teams.values()) tm.ready = false;   // (something changed: set to go again)
  broadcast(room, { t: 'chat', sys: true, text: `The host changed the game to ${modeName(room)}` });
  sendRoom(room);
}
// 'team': { act: 'join', id } asks to join another team ('unask' takes it back; someone in it accepts, up to TEAM_MAX),
// 'new' a team of its own, 'name' its team's name, 'ready' (on / off: the team is set to go; someone joining or leaving
// it takes that back) and 'accept' / 'decline' { id } someone who asked (anyone in it)
function teamMsg(room, client, msg) {
  if (room && room.phase === 'lobby' && (msg.act === 'search' || msg.act === 'any' || msg.act === 'versus')) {   // (the host, any lobby)
    if (room.hostId !== client.id) return;
    if (msg.act === 'search') room.search = !room.search;
    else if (msg.act === 'any') room.searchAny = !room.searchAny;
    else {   // versus on / off: on, everyone a team of their own (every kitty in the lobby has to know versus); off, no teams
      if (!room.versus && room.members.some((m) => m.v < VERSUS_PROTOCOL)) return;
      room.versus = !room.versus || undefined;
      room.teams = new Map();
      for (const m of room.members) m.team = room.versus ? newTeam(room, m) : undefined;
      if (room.versus) room.easy = false;
    }
    sendRoom(room);
    return;
  }
  if (!room || !room.versus || room.phase !== 'lobby') return;
  const full = (id) => room.members.filter((m) => m.team === id).length >= TEAM_MAX;
  const mine = room.teams.get(client.team);
  if (msg.act === 'join' || msg.act === 'unask') {
    const id = msg.id | 0, t = room.teams.get(id);
    if (!t || id === client.team) return;
    if (msg.act === 'unask') t.req.delete(client.id);
    else if (t.req.size < 16 && !full(id)) t.req.add(client.id);
    else return;
  } else if (msg.act === 'ready') {
    if (!mine) return;
    mine.ready = !mine.ready;
  } else if (msg.act === 'accept' || msg.act === 'decline') {
    const who = room.members.find((m) => m.id === (msg.id | 0));
    if (!mine || !who || !mine.req.has(who.id)) return;
    mine.req.delete(who.id);
    if (msg.act === 'accept') {
      if (full(client.team)) return sendRoom(room);
      const was = room.teams.get(who.team);
      if (was) was.ready = false;
      mine.ready = false;
      who.team = client.team;
      for (const x of room.teams.values()) x.req.delete(who.id);
    }
  } else if (msg.act === 'new') {
    if (room.members.filter((m) => m.team === client.team).length < 2) return;   // (already on its own)
    if (mine) mine.ready = false;
    client.team = newTeam(room, client);
  } else if (msg.act === 'name') {
    const t = room.teams.get(client.team);
    if (!t) return;
    t.name = cleanName(msg.name, t.name);
  } else return;
  pruneTeams(room);
  sendRoom(room);
}

// ---- chained lobbies ----
// who chains up with whom: the member ids in chain order (two by two, the last three when odd; room.chain 'all': one
// chain through everyone in this order: shared/sim.js chainGroups)
function chainOrder(room) {
  const ids = room.members.map((m) => m.id);
  room.order = (room.order || []).filter((id) => ids.includes(id));
  for (const id of ids) if (!room.order.includes(id)) room.order.push(id);
  return room.order;
}
// a picks b: b takes the place of a's chain mate (who takes b's); everyone on one chain: b moves in right after a
function chainWith(room, a, b) {
  const o = chainOrder(room);
  if (room.versus) { const ta = room.members.find((m) => m.id === a), tb = room.members.find((m) => m.id === b); if (!ta || !tb || ta.team !== tb.team) return false; }
  if (room.chain === 'all') {
    const i = o.indexOf(a), j = o.indexOf(b);
    if (i < 0 || j < 0 || Math.abs(i - j) === 1) return false;
    o.splice(j, 1);
    o.splice(o.indexOf(a) + 1, 0, b);
    return true;
  }
  const ga = chainGroups(o).find((g) => g.includes(a));
  if (!ga || ga.includes(b) || !o.includes(b)) return false;
  const mate = ga.find((id) => id !== a);
  if (mate == null) return false;
  const i = o.indexOf(mate), j = o.indexOf(b);
  o[i] = b; o[j] = mate;
  return true;
}
// a running chained game's chains changed (someone left, came back, joined): everyone's sim follows
function sendChains(room) {
  if (room.sim && room.sim.chain) broadcast(room, { t: 'chains', c: room.sim.chains, a: room.sim.anchors });
}

function rememberLeft(room, client) {
  const sim = room.sim;
  const p = sim && room.phase === 'playing' && sim.players.find((q) => q.id === client.id);
  if (!p) return;
  pruneLeft(room);
  const circ = sim.circles.find((c) => c.playerId === p.id);
  room.left.set(client.tok || `ip:${client.ip}#${client.id}`, {
    at: Date.now(), sim, level: sim.level, ip: client.ip, pid: client.pid || '',   // (pid: the same browser, a new tab)
    alive: p.alive, x: p.x, z: p.z, circleT: circ ? circ.t : 0, id: p.id, team: client.team,   // (id: its place on its chain; versus: its team)
    lives: p.lives, deaths: p.deaths, rescues: p.rescues, finishes: p.finishes, crowned: p.crowned, speedMult: p.speedMult, bonus: p.bonus || 0, ran: p.ran || 0,
    goals: room.goalsFor === sim && room.goals.get(p.id) ? [...room.goals.get(p.id)] : [],   // (the unlocks' goal tally)
  });
}

// the kitty that left which this one is (back in time): the same tab (tok), else the same browser (pid: the tab was
// closed and the game opened again), else a downed kitty from the same IP
const IP_REJOIN_MS = 60e3;   // (by IP alone: only this soon)
function leftKey(room, client) {
  if (!room.left) return null;
  pruneLeft(room);
  if (client.tok && room.left.has(client.tok)) return client.tok;
  if (client.pid) for (const [k, r] of room.left) if (r.pid === client.pid) return k;
  for (const [k, r] of room.left) if (!r.alive && r.ip === client.ip && Date.now() - r.at < IP_REJOIN_MS) return k;
  return null;
}
function restoreLeft(room, client, p) {
  const key = leftKey(room, client);
  if (!key) return;
  const r = room.left.get(key);
  room.left.delete(key);
  const sim = room.sim;
  Object.assign(p, { lives: r.lives, deaths: r.deaths, rescues: r.rescues, finishes: r.finishes, crowned: r.crowned, speedMult: r.speedMult, bonus: r.bonus || 0, ran: r.ran || 0 });   // (ran: the score's distance)
  if (r.goals && r.goals.length && r.sim === sim) {   // the goals it had reached this run come back with it
    if (room.goalsFor !== sim) { room.goalsFor = sim; room.goals = new Map(); }
    room.goals.set(p.id, new Set(r.goals));
  }
  if (r.sim === sim) chainRejoin(sim, r.id, p);   // chained: back on its chain, where it left
  // chained: its partner joined another group meanwhile: chained up with it again (split off once both sides have two)
  if (r.sim === sim && !sim.chains.some((c) => c.includes(p.id)) && mergeReturn(sim, r.id, p)) {
    if (sim.versus) for (const m of room.members) { const q = sim.players.find((x) => x.id === m.id); if (q) m.team = q.team; }
    sendRoom(room);
    return { x: p.x, z: p.z };
  }
  // versus: with its team, at the one furthest behind; picked up and carried: up, where its carrier is (that's its revive)
  const carried = r.sim === sim && vsReturn(sim, r.id, p);
  // a new level (or the victory party) revives everyone anyway
  if (!r.alive && !carried && r.level === sim.level && sim.state !== 'victory') {
    Object.assign(p, { alive: false, x: r.x, z: r.z, vx: 0, vz: 0, moving: false, inCenter: false, invuln: 0, shield: 0, speedMult: 1 });
    sim.circles.push({ playerId: p.id, x: r.x, z: r.z, t: r.circleT });
  }
  return carried ? { x: p.x, z: p.z } : null;   // (where it has to stay: joinRoom puts it back there after chainJoin)
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  room.members = room.members.filter((m) => m !== client);
  rememberLeft(room, client);
  if (room.sim && room.sim.versus && room.phase === 'playing' && room.sim.state === 'playing' && room.sim.players.some((p) => p.id === client.id) && !vsCounted(room, client)) accounts.recordOnline(client.acct, { type: 'vsGame' });
  if (room.sim) { chainLeave(room.sim, client.id); vsLeave(room.sim, client.id); removePlayer(room.sim, client.id); }   // (chained: off its chain, or an anchor; versus: a catch, a spot to pick up)
  sendChains(room);
  if (room.members.length === 0) { rooms.delete(room.code); return; }
  if (room.versus && room.phase === 'lobby' && room.teams.has(client.team)) room.teams.get(client.team).ready = false;   // (one fewer: not set any more)
  pruneTeams(room);
  if (room.hostId === client.id) room.hostId = room.members[0].id; // next in join order
  partyOver(room);
  sendRoom(room);
  broadcast(room, { t: 'chat', sys: true, text: `${client.name} left` });
}

// the victory party ends (back to the lobby on the next tick) once everyone still in the room has gone back to it
function partyOver(room) {
  if (room.phase === 'playing' && room.victory && room.backs && room.members.every((m) => room.backs.has(m.id))) room.overAt = Date.now();
}

function startMsg(room, withWolves) {
  const sim = room.sim;
  return {
    t: 'start', seed: sim.seed, mode: sim.mode, level: sim.level, tick: room.tick, lt: sim.enemyTicks, rf: sim.finales | 0, hell: sim.hell ? 1 : undefined, hw: sim.waves ? 1 : undefined,
    easy: sim.easy ? 1 : undefined, rt: sim.retries || undefined,
    st: sim.state, vic: room.victory || null, // mid-game joiners: the run may already be won (the 'victory' event went out before)
    players: sim.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ...(sim.versus ? { team: p.team } : {}) })),
    wolves: withWolves ? serializeEnemies(sim.enemies) : null,
    lh: levelHash(sim.levelData),   // level fingerprint: a client that differs takes our items and wolves (main.js)
    it: sim.items.filter((i) => i.taken).map((i) => i.id), ct: sim.crownTaken ? 1 : 0, // mid-game joiners: already picked up
    // the lottery chest [x, z, open] and the pickups it dropped (not in the level: [id, type, x, z, mega])
    ch: sim.chest ? [sim.chest.x, sim.chest.z, sim.chest.open ? 1 : 0] : undefined,
    xi: sim.chest && sim.chest.open ? sim.items.filter((i) => i.id >= 1000).map((i) => [i.id, i.type, i.x, i.z, i.mega ? 1 : 0]) : undefined,
    cp: sim.checkpointsHit.slice(),   // ...and the checkpoints already reached (a repaired medic checkpoint shows repaired)
    cn: sim.chain ? { c: sim.chains, a: sim.anchors, all: sim.chainAll ? 1 : undefined } : undefined,   // chained: the chains and anchors (shared/sim.js chainLinks)
    vs: sim.versus ? vsTeams(room) : undefined,   // versus: the teams and their points (players carry their team)
  };
}

// versus: every team's name and points so far: [id, name, dist, cur, crowns, deaths, revives] (shared/sim.js vsTeam)
function vsTeams(room) {
  return Object.entries(room.sim.teams).map(([id, t]) => [+id, (room.teams.get(+id) || {}).name || 'Team ' + id, r3(t.dist), r3(t.cur), t.crowns, t.deaths, t.revives, r3(t.far || 0), t.farBy | 0]);
}

function startGame(room, startLevel = 1) {
  stats.onlineGameStarted();
  room.phase = 'playing';
  room.tick = 0;
  room.pending = [];
  room.overAt = 0;
  room.victory = null;
  room.left = new Map();
  room.joinVotes = new Map();
  room.vsPlayed = new Set();
  const seed = hashSeed(Date.now(), Math.random(), room.code) >>> 0;
  room.sim = createSim({
    seed, startLevel: room.hell ? startLevel : stageStep(room.mode, finalesOf(room.members), startLevel), mode: room.mode, finales: finalesOf(room.members), easy: !!room.easy,
    hell: !!room.hell, waves: !!room.hell && room.members.every((m) => m.v >= HELL_WAVES_PROTOCOL), chain: room.chain || false, versus: !!room.versus,
    players: (room.chain ? chainOrder(room).map((id) => room.members.find((m) => m.id === id)) : room.members).map((m) => ({ id: m.id, name: m.name, color: m.color, team: m.team })),   // (chained: in chain order)
  });
  for (const m of room.members) { m.inputs.clear(); m.lastInput = null; }
  sendRoom(room);
  broadcast(room, startMsg(room, false));
}

// ---------------- simulation ----------------
function stepRoom(room) {
  const sim = room.sim;
  const k = room.tick + 1;
  const inputs = {};
  for (const m of room.members) {
    const inp = m.inputs.get(k);
    if (inp) m.lastInput = inp;
    inputs[m.id] = m.lastInput;
    for (const key of m.inputs.keys()) if (key <= k) m.inputs.delete(key);
  }
  sim.noChest = room.members.some((m) => m.v < CHEST_PROTOCOL);   // (an older client would not see the chest or its pickups)
  const events = stepSim(sim, inputs, CFG.TICK);
  room.tick = k;
  if (sim.chain && (sim.chainRev | 0) !== (room.chainRev | 0)) { room.chainRev = sim.chainRev | 0; sendChains(room); }   // (an anchor let go)
  trackAfk(room);
  for (const e of events) room.pending.push(e);
  for (const e of events) {
    if (e.type === 'levelStart') {
      e.lh = levelHash(sim.levelData);
      pregenNext(sim); // next level off the event loop (makeLevel picks it up)
    }
    else if (e.type === 'gameOver') { room.overAt = Date.now() + GAMEOVER_TO_LOBBY_MS; if (sim.versus) vsResults(room); }
    else if (e.type === 'victory') {
      if (sim.versus) vsResults(room);
      // final state: the sim keeps stepping (snapshots carry st 'victory') until the room goes back to the lobby
      room.victory = e;
      room.overAt = Date.now() + VICTORY_TO_LOBBY_MS;
      room.backs = new Set();   // who has gone back to the lobby from the party
      if (!sim.hell) { stats.onlineGameWon(room.mode); legendsOnWin(room, e); }   // (hell's own board: levelboards.js)
    }
  }
  if (events.length) countForAccounts(room, events);
  if (k % NET.SNAP_EVERY === 0 || events.length || room.snapNow) { room.snapNow = false; sendSnapshot(room); }
}

// Vote to kill: a kitty that has stood still for AFK_TICKS (alive, out of the goal room, the level going on) can be voted
// down by the others ('votekill'): a majority of the other kitties that aren't standing still themselves. It goes down
// as if caught (a revive circle, so it can be revived), but it isn't counted as caught. Snapshots carry each kitty's
// afk at the end of its array: 0, or 1 + its votes so far (main.js shows the vote button).
const AFK_TICKS = 30 * 60;   // (30 s)
function trackAfk(room) {
  const sim = room.sim;
  if (room.afkFor !== sim) { room.afkFor = sim; room.afk = new Map(); }
  for (const p of sim.players) {
    let a = room.afk.get(p.id);
    if (!a) room.afk.set(p.id, a = { x: p.x, z: p.z, still: 0, votes: new Set() });
    const still = sim.state === 'playing' && p.alive && !p.inCenter && Math.abs(p.x - a.x) < 0.01 && Math.abs(p.z - a.z) < 0.01;
    a.x = p.x; a.z = p.z;
    if (still) a.still++; else if (a.still) { a.still = 0; a.votes.clear(); }
  }
}
const isAfk = (room, id) => { const a = room.afkFor === room.sim && room.afk.get(id); return !!a && a.still >= AFK_TICKS; };
// votes it takes: more than half of the other kitties in the game that aren't standing still themselves
function afkNeed(room, id) {
  const voters = room.sim.players.filter((p) => p.id !== id && !isAfk(room, p.id)).length;
  return Math.floor(voters / 2) + 1;
}
// Chained: a kitty left on its own on its chain (sim.js loneOf) joins another group when both want it: more than half of
// that group (its chain; versus: its team) votes for it standing on its ring, body or it ('joinvote'), and it says yes
// ('joinask': asking first, near one of them, or saying yes to their votes; down too). Then groupJoin (down: back up).
// The group hears of it in the chat. room.joinVotes: 'lone id:group' -> { votes: Set of voter ids, agree, to (one of the
// group) }; snapshots carry them (jv).
const JOIN_TOUCH = CFG.REVIVE_RADIUS + CFG.KITTY_RADIUS, JOIN_ASK = 6;
const groupOf = (sim, p) => (sim.versus ? sim.players.filter((q) => q.team === p.team) : (sim.chains.find((c) => c.includes(p.id)) || [p.id]).map((id) => sim.players.find((q) => q.id === id)).filter(Boolean));
const groupKey = (sim, p) => (sim.versus ? 't' + p.team : 'c' + Math.min(...groupOf(sim, p).map((q) => q.id)));
const groupName = (room, sim, p) => (sim.versus ? `${(room.teams.get(p.team) || {}).name || 'their team'}` : `${p.name}'s chain`);
function joinEntry(room, sim, L, T) {
  room.joinVotes ||= new Map();
  const key = L.id + ':' + groupKey(sim, T);
  let e = room.joinVotes.get(key);
  if (!e) room.joinVotes.set(key, e = { votes: new Set(), agree: false, to: T.id });
  const group = groupOf(sim, T).filter((q) => q.id !== L.id);
  for (const v of e.votes) if (!group.some((q) => q.id === v)) e.votes.delete(v);   // (voters no longer in the group)
  return { key, e, group, need: Math.floor(group.length / 2) + 1 };
}
function joinDone(room, sim, L, T, key, e, group, need) {
  room.snapNow = true;
  const tell = (text) => { for (const m of room.members) if (group.some((q) => q.id === m.id)) send(m.ws, { t: 'chat', sys: true, text }); };
  const word = sim.versus ? 'team' : 'chain';
  if (e.votes.size < need || !e.agree) return tell;
  room.joinVotes.delete(key);
  const by = sim.players.find((q) => q.id === [...e.votes][0]) || T;
  if (!groupJoin(sim, L.id, by.id)) return tell;
  for (const m of room.members) { const p = sim.players.find((q) => q.id === m.id); if (p && sim.versus) m.team = p.team; }
  tell(`⛓ ${L.name} joined your ${word}`);
  const lm = room.members.find((m) => m.id === L.id);
  if (lm) send(lm.ws, { t: 'chat', sys: true, text: `⛓ You joined ${groupName(room, sim, by)}` });
  sendChains(room);
  sendRoom(room);
  return null;
}
// one of the group, standing on the lone kitty's ring, body or it: a vote for it
function joinVote(room, client, id) {
  const sim = room.sim;
  if (!sim || !sim.chain || room.phase !== 'playing' || sim.state !== 'playing') return;
  const V = sim.players.find((p) => p.id === client.id), L = sim.players.find((p) => p.id === id), lg = loneOf(sim, id);
  if (!V || !V.alive || !L || !lg || lg.includes(V.id)) return;
  const spots = [L, ...lg.map((o) => sim.anchors[o]).filter(Boolean)];
  if (!spots.some((s) => Math.hypot(V.x - s.x, V.z - s.z) < JOIN_TOUCH)) return;
  const { key, e, group, need } = joinEntry(room, sim, L, V);
  if (e.votes.has(V.id)) return;
  e.votes.add(V.id);
  const tell = joinDone(room, sim, L, V, key, e, group, need);
  if (!tell) return;
  const word = sim.versus ? 'team' : 'chain';
  tell(`⛓ ${V.name} votes to add ${L.name} to your ${word} (${e.votes.size}/${need})` + (e.votes.size < need ? `: run onto ${L.name}'s ring to vote too` : '') + (e.agree ? '' : `, waiting for ${L.name} to say yes`));
  const lm = room.members.find((m) => m.id === L.id);
  if (lm && !e.agree) send(lm.ws, { t: 'chat', sys: true, text: `⛓ ${groupName(room, sim, V)} want you to join them: press JOIN to say yes` });
}
// the lone kitty: asks to join (or says yes to) the group of kitty `to` (near it, or that group voting for it already)
function joinAsk(room, client, to) {
  const sim = room.sim;
  if (!sim || !sim.chain || room.phase !== 'playing' || sim.state !== 'playing') return;
  const L = sim.players.find((p) => p.id === client.id), T = sim.players.find((p) => p.id === to), lg = L && loneOf(sim, L.id);
  if (!L || !T || !lg || lg.includes(T.id)) return;
  const spots = [L, ...lg.map((o) => sim.anchors[o]).filter(Boolean)];
  const was = room.joinVotes && room.joinVotes.get(L.id + ':' + groupKey(sim, T));
  if (!(was && was.votes.size) && !spots.some((s) => Math.hypot(T.x - s.x, T.z - s.z) < JOIN_ASK)) return;   // (asking first: one of them near)
  const { key, e, group, need } = joinEntry(room, sim, L, T);
  if (e.agree) return;
  e.agree = true;
  const tell = joinDone(room, sim, L, T, key, e, group, need);
  if (tell) tell(`⛓ ${L.name} asks to join your ${sim.versus ? 'team' : 'chain'} (${e.votes.size}/${need} voted): run onto ${L.name}'s ring or body to vote`);
}

function voteKill(room, client, id) {
  const sim = room.sim;
  if (!sim || room.phase !== 'playing' || id === client.id || !isAfk(room, id) || isAfk(room, client.id)) return;
  const p = sim.players.find((q) => q.id === id);
  if (!p || !sim.players.some((q) => q.id === client.id)) return;
  const a = room.afk.get(id);
  a.votes.add(client.id);
  for (const v of a.votes) if (!sim.players.some((q) => q.id === v)) a.votes.delete(v);   // (voters gone since)
  room.snapNow = true;   // (the votes, or the kitty down, in the next tick's snapshot)
  if (a.votes.size < afkNeed(room, id)) return;
  // voted down: as when caught (no life used, nothing counted)
  Object.assign(p, { alive: false, vx: 0, vz: 0, moving: false, shield: 0, invuln: 0, speedMult: 1 });
  sim.circles.push({ playerId: p.id, x: p.x, z: p.z, t: 0 });
  a.still = 0; a.votes.clear();
  room.pending.push({ type: 'voteKill', playerId: p.id });
}

// Account stats (accounts.js): a cleared level counts for every kitty in the game (down or not), a crown for the
// kitty that grabbed it, a revive for the rescuer. Only signed-in players have an account to count on.
// Every credit is once per player (onePerPlayer): the same account or browser in several tabs of one lobby counts once,
// and reviving your own other tab doesn't count.
function countForAccounts(room, events) {
  const sim = room.sim;
  const memberOf = (id) => room.members.find((x) => x.id === id) || null;
  const subOf = (id) => { const m = memberOf(id); return m ? m.acct : null; };
  const whoOf = (id) => { const m = memberOf(id); return m ? { sub: m.acct, pid: m.pid } : null; };
  // of these kitties (ids), the ones that count: one per player
  const once = (ids) => { const ms = ids.map(memberOf).filter(Boolean); return onePerPlayer(ms).map((m) => m.id); };
  // the steps of this run (levels; in Run + Skate each half) where each kitty reached the goal itself (before the
  // game moved on): all of them up to level 8's last step (stageStep) for the level 8 unlocks, all 9 levels' for level 9
  if (room.goalsFor !== sim) { room.goalsFor = sim; room.goals = new Map(); }
  const goalsOf = (id) => { let g = room.goals.get(id); if (!g) room.goals.set(id, g = new Set()); return g; };
  const featDone = (id, feat) => { accounts.recordFeat(whoOf(id), feat, room.mode); feats.add(id); };
  const feats = new Set();
  // easy games: their own stats (accounts.js 'easy'); of the unlocks the revives (the medic badge), the song and
  // their own level 8 and 9 ones ('e8', 'e9')
  const easy = !!room.easy;
  if (sim.hell) { countHell(room, events, { memberOf, subOf, once, featDone }); feats.size && showFeats(room, feats); return; }
  for (const e of events) {
    if (e.type === 'enterCenter') { goalsOf(e.playerId).add(e.level ?? sim.level); continue; }
    if (e.type === 'stageClear') { room.dayTime = { level: e.level, time: sim.levelTime }; continue; }
    if (e.type === 'gameOver') { room.dayTime = null; continue; }
    if (e.type === 'levelStart' || e.type === 'levelClear') {
      const level = e.type === 'levelClear' ? e.level : (sim.levelData && sim.levelData.level) || sim.level;
      const ev = { type: e.type === 'levelClear' ? 'clear' : 'reached', mode: room.mode, level };
      if (e.type === 'levelClear') {
        const day = room.dayTime && room.dayTime.level === level ? room.dayTime.time : 0;
        ev.time = sim.levelTime + day;   // the team's time for the level
        room.dayTime = null;
      }
      for (const id of once(sim.players.map((p) => p.id))) accounts.recordOnline(subOf(id), ev, easy);
      // level boards: the team's time for everyone in it (one per player); the secret level's board opens for whoever reaches it
      const team = sim.versus ? byTeamPoints(room, once(sim.players.map((p) => p.id))) : byScore(room, once(sim.players.map((p) => p.id))), run = runId();   // (run: the team's time shows once, with everyone, best scorer first; versus: the team with the most points first)
      const places = sim.versus ? teamPlaces(room, team) : null;
      for (const [order, id] of team.entries()) {
        const m = memberOf(id), p = sim.players.find((q) => q.id === id);
        if (!m) continue;
        const who = { acct: m.acct, pid: m.pid, fid: m.fid, name: (p && p.name) || m.name, color: p ? p.color : m.color };
        if (e.type === 'levelClear') levels.record(who, { local: false, easy, mode: room.mode, level, time: ev.time, team: team.length, run, chain: chainedGame(room), order, ...(sim.versus ? { vs: true, tm: places[order] } : {}) });
        else if (level === levels.SECRET_LEVEL) levels.reach(who);
      }
      if (e.type === 'levelStart' && level === SKATE_FINAL_LEVEL && !e.retry) for (const id of team) featDone(id, 'r9');   // (hell opens)
      // unlocks: level 8 cleared by a kitty that reached the goal itself on every level of the run so far (8, or 16
      // in Run + Skate: both halves), crowns or not. Checked as the game moves on to level 9, so a kitty that runs in
      // during the level-cleared pause still counts
      if (e.type === 'levelStart' && !e.retry && level === SKATE_FINAL_LEVEL) {   // (an easy game: its own unlocks; not again when level 9 starts over)
        for (const id of once(sim.players.filter((p) => goalsOf(p.id).size >= stageStep(room.mode, sim.finales, 8, true)).map((p) => p.id))) featDone(id, easy ? 'e8' : 'l8');
      }
    } else if (e.type === 'victory') {
      // unlocks: the final run won by a kitty that reached the goal itself on every level, the final one included (not
      // carried in for the party)
      const party = Array.isArray(e.party) ? e.party : [];
      const l9 = sim.players.filter((p) => !party.includes(p.id) && goalsOf(p.id).size >= stageStep(room.mode, sim.finales, SKATE_FINAL_LEVEL));   // (every step up to the last: 9, or 17 with day and night halves)
      for (const id of once(l9.map((p) => p.id))) featDone(id, easy ? 'e9' : 'l9');   // (an easy game: its own unlocks)
      for (const id of once(sim.players.map((p) => p.id))) featDone(id, 'win');   // and the new song: everyone who was there
    } else if (e.type === 'crown') accounts.recordOnline(subOf(e.playerId), { type: 'crown' }, easy);
    else if (e.type === 'revive' && !samePlayer(memberOf(e.by), memberOf(e.playerId))) {
      featDone(e.by, 'rev');   // toward the medic badge (3000 revives); first, so an account's past revives are taken before this one
      accounts.recordOnline(subOf(e.by), { type: 'revive' });
      if (easy) accounts.recordOnline(subOf(e.by), { type: 'revive' }, true);
    }
  }
  showFeats(room, feats);
}
// a feat may have unlocked something: the room shows it right away
function showFeats(room, feats) {
  let changed = false;
  for (const id of feats) {
    const m = room.members.find((x) => x.id === id);
    if (!m) continue;
    const cos = accounts.cosForPlayer({ sub: m.acct, pid: m.pid }, room.mode);
    if (cos.join() !== (m.cos || []).join()) { m.cos = cos; changed = true; }
  }
  if (changed) sendRoom(room);
}
// A hell game counts on its own: none of level 9's (no level reached or cleared, no level times, no level 8 / 9
// unlocks, no wins); a cleared hell level opens hell for everyone in the game ('h1', in this mode) and unlocks the new song
// ('win', as the final run won does), how far it got goes
// on the hell board for everyone in it (its end: game over or its last level won; easy hell: every wipe, the level
// starting over, and the win, on the easy board); crowns and revives in the account's hell table (revives toward the revive
// unlocks as anywhere).
function countHell(room, events, { memberOf, subOf, once, featDone }) {
  const sim = room.sim;
  const team = () => once(sim.players.map((p) => p.id));
  for (const e of events) {
    // the account stats' hell table: every hell level cleared, for everyone in the game, with the team's time; all of
    // hell cleared (the victory, after its last levelClear) a win too
    if (e.type === 'levelClear') for (const id of team()) accounts.recordOnline(subOf(id), { type: 'hellClear', mode: room.mode, level: e.level, time: sim.levelTime }, !!sim.easy);
    const escaped = () => { const w = sim.players.find((p) => p.id === sim.lastWinner); return team().filter((id) => !sim.versus || (w && (sim.players.find((p) => p.id === id) || {}).team === w.team)); };
    if (e.type === 'victory') for (const id of escaped()) accounts.recordOnline(subOf(id), { type: 'hellWin', mode: room.mode }, !!sim.easy);
    if (e.type === 'levelClear') { for (const id of team()) { featDone(id, 'h1'); featDone(id, 'win'); } }   // (and the new song: a hell level beaten)
    else if (sim.versus && (e.type === 'gameOver' || e.type === 'victory')) {   // (versus: a team each, its place marked)
      const w = sim.players.find((p) => p.id === sim.lastWinner), tids = Object.keys(sim.teams).map(Number).filter((t) => sim.players.some((p) => p.team === t));
      for (const t of tids) {
        const ids = once(sim.players.filter((p) => p.team === t).map((p) => p.id)), run = runId();
        const far = e.type === 'victory' && w && w.team === t ? 1 : Math.min(1, sim.teams[t].far || 0), tm = tids.filter((o) => vsOrder(sim, o, t) < 0).length;   // (its place: the teams ahead of it)
        for (const id of ids) {
          const m = memberOf(id), p = sim.players.find((q) => q.id === id);
          if (m) levels.recordHell({ acct: m.acct, pid: m.pid, fid: m.fid, name: (p && p.name) || m.name, color: p ? p.color : m.color }, { local: false, easy: !!sim.easy, mode: room.mode, level: e.level, far, team: ids.length, time: sim.time, run, chain: chainedGame(room), vs: true, tm });
        }
      }
    } else if (e.type === 'gameOver' || e.type === 'victory' || e.type === 'wipe') {
      const far = e.type === 'victory' ? 1 : e.far, ids = team(), run = runId();
      for (const id of ids) {
        const m = memberOf(id), p = sim.players.find((q) => q.id === id);
        if (m) levels.recordHell({ acct: m.acct, pid: m.pid, fid: m.fid, name: (p && p.name) || m.name, color: p ? p.color : m.color }, { local: false, easy: !!sim.easy, mode: room.mode, level: e.level, far, team: ids.length, time: sim.time, run, chain: chainedGame(room) });
      }
    } else if (e.type === 'crown') accounts.recordOnline(subOf(e.playerId), { type: 'crown', hell: true }, !!sim.easy);   // (the hell table's own crowns)
    else if (e.type === 'revive' && !samePlayer(memberOf(e.by), memberOf(e.playerId))) {
      featDone(e.by, 'rev');   // (the revive unlocks: every revive, hell's too)
      accounts.recordOnline(subOf(e.by), { type: 'revive', hell: true });
      if (sim.easy) accounts.recordOnline(subOf(e.by), { type: 'revive', hell: true }, true);
    }
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;
// a level board run: one clear / game, the same for everyone in it (levelboards.js shows the team's time once)
const runId = () => crypto.randomBytes(6).toString('hex');

function sendSnapshot(room) {
  const sim = room.sim;
  const margins = new Map(room.members.map((m) => [m.id, m.margin]));
  broadcast(room, {
    t: 'snap', k: room.tick, lvl: sim.level, st: sim.state, lt: sim.enemyTicks, tm: r3(sim.time), rt: sim.retries || undefined,
    // [id, x, z, vx, vz, heading, alive, inCenter, lives, speedMult, invuln, shield, deaths, rescues, inputMargin, finishes, waitRelease, crowned, bonus,
    //  freeTurn, ran (the score's distance: maps run), afk (0, or 1 + its votes to kill)] (new fields go at the end: older clients ignore them)
    p: sim.players.map((p) => [p.id, r3(p.x), r3(p.z), r3(p.vx), r3(p.vz), r3(p.heading), p.alive ? 1 : 0, p.inCenter ? 1 : 0,
      p.lives, r3(p.speedMult), r3(p.invuln), r3(p.shield), p.deaths, p.rescues, Math.round((margins.get(p.id) ?? 0) * 10) / 10, p.finishes || 0, p.waitRelease ? 1 : 0,
      p.crowned ? 1 : 0, p.bonus || 0, p.freeTurn ? 1 : 0, r3(p.ran || 0), isAfk(room, p.id) ? 1 + room.afk.get(p.id).votes.size : 0, ...(sim.versus ? [p.team] : [])]),   // (versus: its team)
    vs: sim.versus ? vsTeams(room) : undefined,
    vl: sim.versus ? Object.entries(sim.vsLeft).map(([id, s]) => [+id, r3(s.x), r3(s.z), s.team, s.color, s.by || 0]) : undefined,   // (kitties that left: where, their team and colour, who carries them)
    jv: sim.chain && room.joinVotes && room.joinVotes.size ? [...room.joinVotes].map(([k, v]) => [+k.split(':')[0], k.split(':')[1], v.votes.size, v.agree ? 1 : 0, v.to]) : undefined,   // (chained: joining up: [the lone kitty's id, group, votes, it said yes, one of the group])
    ad: sim.chain && Object.values(sim.anchors).some((a) => a.drag) ? Object.entries(sim.anchors).filter(([, a]) => a.drag).map(([id, a]) => [+id, r3(a.x), r3(a.z)]) : undefined,   // (chained: bodies dragged on a chain, where they are now)
    lw: sim.lastWinner || 0, ct: sim.crownTaken ? 1 : 0,
    it: sim.items.filter((i) => i.taken).map((i) => i.id),
    c: sim.circles.map((c) => [c.playerId, r3(c.x), r3(c.z), r3(c.t)]),
    s: sim.stats,
    ec: wolfCheck(sim),
    ev: room.pending,
    hf: sim.hell ? r3(sim.far) : undefined,   // hell: how far along the map the team has got on this level (0..1)
  });
  room.pending = [];
}

// A few wolf positions per snapshot (rotating) so clients can detect a desynced local wolf sim.
function wolfCheck(sim) {
  const n = sim.enemies.length;
  if (!n) return [];
  const out = [];
  const start = (sim.enemyTicks * 7) % n;
  for (let i = 0; i < 8; i++) {
    const e = sim.enemies[(start + i * 29) % n];
    out.push([e.id, r3(e.x), r3(e.z)]);
  }
  return out;
}

let lastTime = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += (now - lastTime) / 1000;
  lastTime = now;
  if (acc > 0.25) acc = 0.25; // never spiral after a stall
  while (acc >= CFG.TICK) {
    acc -= CFG.TICK;
    for (const room of rooms.values()) {
      if (room.phase !== 'playing') continue;
      try { stepRoom(room); } catch (err) { roomCrashed(room, err); }
    }
  }
  for (const room of rooms.values()) {
    if (room.phase === 'playing' && room.overAt && Date.now() >= room.overAt) {
      room.phase = 'lobby';
      room.sim = null;
      room.left = new Map();   // their rejoin records hold the whole old sim
      room.wolfMsg = null;
      room.victory = null;
      room.overAt = 0;
      sendRoom(room);
    }
  }
}, 1000 / 120);

// A sim bug in one room must not take the other rooms down: log it and send that room back to the lobby.
function roomCrashed(room, err) {
  console.error(`room ${room.code} step failed:`, err);
  room.phase = 'lobby'; room.sim = null; room.victory = null; room.overAt = 0; room.pending = []; room.left = new Map();
  try {
    sendRoom(room);
    broadcast(room, { t: 'chat', sys: true, text: 'Something went wrong — back to the lobby' });
  } catch (e) { console.error('room reset failed:', e); }
}

// ---------------- websocket ----------------
// Compress only big messages (the full wolf state for 'resync' / mid-game 'start'); snapshots go out as they are.
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 16 * 1024,
  perMessageDeflate: { threshold: 16384, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
});

const clients = new Map(); // id -> client (after disconnect: a small record for ~10 min, so late reports still work)
const RESYNC_REUSE = 30;     // ticks a room's resync message is reused for (big levels: building it is ~20 ms)
// new connections per IP: a token bucket (CONN_RATE / s, CONN_BURST at once), so nobody can churn thousands of sockets
const CONN_RATE = 2, CONN_BURST = 60;
const connRate = new Map();   // ip -> { tok, at }
const CLOSED_WS = { readyState: 3 };
const connsPerIp = new Map(); // ip -> open sockets

// token bucket on client[key + 'Tok'] / [key + 'At']: true if a message may pass
function take(client, key, rate, burst, now) {
  const tok = Math.min(burst, (client[key + 'Tok'] ?? burst) + (now - (client[key + 'At'] ?? now)) / 1000 * rate);
  client[key + 'At'] = now;
  if (tok < 1) { client[key + 'Tok'] = tok; return false; }
  client[key + 'Tok'] = tok - 1;
  return true;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req), ipk = ipKey(ip);
  const now0 = Date.now(), cr = connRate.get(ipk) || { tok: CONN_BURST, at: now0 };
  cr.tok = Math.min(CONN_BURST, cr.tok + (now0 - cr.at) / 1000 * CONN_RATE); cr.at = now0;
  if (cr.tok < 1) { connRate.set(ipk, cr); ws.close(1013, 'too many connections'); return; }
  cr.tok -= 1; connRate.set(ipk, cr);
  const n = (connsPerIp.get(ipk) || 0) + 1;
  if (n > MAX_CONN_PER_IP) { ws.close(1013, 'too many connections'); return; }
  connsPerIp.set(ipk, n);
  stats.online(wss.clients.size);
  // v/app/ver/tok come from the client's 'hi' (sent before anything else); clients that never send one are old web tabs
  const client = { id: nextClientId++, ws, room: null, name: '', app: 'web', ver: '', hi: false, v: 0, tok: '', ip, ipk, chatLog: [] };
  clients.set(client.id, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hello', id: client.id });

  ws.on('message', (raw) => {
    if (!take(client, 'msg', MSG_RATE, MSG_BURST, Date.now())) { ws.terminate(); return; } // flooding: not a real client
    try { onMessage(raw); } catch (err) { console.error('ws message failed:', err); }
  });
  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const room = client.room;
    if (LOBBY_MSGS.has(msg.t) && !take(client, 'lobby', LOBBY_RATE, LOBBY_BURST, Date.now())) {
      if (msg.t !== 'list') send(ws, { t: 'error', msg: 'Slow down a little!' });
      return;
    }
    switch (msg.t) {
      case 'hi': {
        const v = Number.isFinite(msg.v) ? msg.v : 0;
        client.hi = true;
        client.v = v;
        client.app = APPS.includes(msg.app) ? msg.app : 'web';
        client.ver = str(msg.ver).replace(/[^\w.+-]/g, '').slice(0, 16);
        if (typeof msg.tok === 'string' && /^[\w-]{8,64}$/.test(msg.tok)) client.tok = msg.tok; // reconnect grace (net.js)
        client.paid = accounts.paidFor(msg.acct);   // signed-in account: its total shows next to the name
        client.ps = accounts.paidStyleFor(msg.acct);
        client.acct = accounts.subFor(msg.acct);    // ...and its stats count this player's online games
        client.pid = accounts.validPid(msg.pid);    // the browser's unlock progress id (players without an active account)
        client.fid = v >= INVITE_PROTOCOL ? friendId(client.pid) : '';   // public friend id (invites), from the secret pid
        accounts.mergeGuest(client.acct, client.pid);   // an active account takes over this browser's guest progress
        accounts.seenGuest(client.pid);                 // (or the guest progress is kept another two months)
        client.cos = room ? accounts.cosForPlayer({ sub: client.acct, pid: client.pid }, room.mode) : [];   // (set per lobby's mode on joining)
        if (v < MIN_PROTOCOL) {
          send(ws, { t: 'outdated', msg: 'A new version of Run Kitty Run is out - update to keep playing online.' });
          ws.close(4000, 'outdated');
        }
        break;
      }
      case 'acct': {
        // signed in / out (or paid more) after connecting
        if (!take(client, 'lobby', LOBBY_RATE, LOBBY_BURST, Date.now())) return;
        const paid = accounts.paidFor(msg.acct), ps = accounts.paidStyleFor(msg.acct);
        client.acct = accounts.subFor(msg.acct);
        accounts.mergeGuest(client.acct, client.pid);
        const cos = room ? accounts.cosForPlayer({ sub: client.acct, pid: client.pid }, room.mode) : [];
        const cosChanged = cos.join() !== (client.cos || []).join();
        client.cos = cos;
        if (paid !== (client.paid || 0) || ps !== (client.ps || '') || cosChanged) { client.paid = paid; client.ps = ps; if (room) sendRoom(room); }
        break;
      }
      case 'report':
        handleReport(client, msg);
        break;
      case 'sign':
        handleSign(client, msg);
        break;
      case 'legends': {
        // a winner asks for the board again (e.g. after a reconnect); nothing for anyone else
        if (!take(client, 'legends', LEGENDS_RATE, LEGENDS_BURST, Date.now())) return;
        const b = legends.boardFor(client);
        if (b) send(ws, b);
        break;
      }
      case 'list':
        send(ws, { t: 'lobbies', list: lobbyList(client) });
        break;
      case 'seen': handleSeen(client, msg); break;
      case 'invite': handleInvite(client, msg); break;
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is full, try again later.' });
        let mine = 0;
        for (const r of rooms.values()) if (r.by === client.ipk) mine++;
        if (mine >= MAX_ROOMS_PER_IP) return send(ws, { t: 'error', msg: 'You already have several lobbies open - join one of those, or try again in a bit.' });
        const mode = GAME_MODES.includes(msg.mode) ? msg.mode : 'mixed';
        if (!modeOk(client, mode)) return send(ws, { t: 'error', msg: `${MODE_NAMES[mode]} needs the latest version - ${updateHow(client)} to play it. The other modes work as usual.` });
        // max: how many kitties may join (2..NET.MAX_PLAYERS); pass: private lobby's password ('' = public)
        const maxReq = Number.isInteger(msg.max) ? msg.max : NET.MAX_PLAYERS;
        // hell: Run only / Skate only, by a player who has it open in that mode (or says its offline progress has)
        const hell = msg.hell === true;
        if (hell && (client.v < HELL_PROTOCOL || !HELL_MODES.includes(mode))) return send(ws, { t: 'error', msg: `Hell needs the latest version - ${updateHow(client)} to play it.` });
        if (hell && !hellOpenFor(client, mode) && msg.hl !== true) return send(ws, { t: 'error', msg: `Reach the final level in any mode to open this, or clear a level of it in someone's lobby.` });
        const r = { code: makeCode(), mode, hell: hell || undefined, easy: msg.easy === true && client.v >= (hell ? EASY_HELL_PROTOCOL : EASY_PROTOCOL), chain: client.v >= CHAIN_PROTOCOL ? (msg.chain === 'all' ? 'all' : msg.chain === true || undefined) : undefined, max: Math.max(2, Math.min(NET.MAX_PLAYERS, maxReq)), pass: cleanPass(msg.password), by: client.ipk,
          members: [], hostId: 0, phase: 'lobby', sim: null, tick: 0, pending: [], overAt: 0, victory: null,
          left: new Map(), // tab token -> state of a kitty that left this game (reconnect grace)
          versus: (msg.versus === true && client.v >= VERSUS_PROTOCOL) || undefined, teams: new Map(), nextTeam: 1 };   // (versus: no easy)
        if (r.versus) r.easy = false;
        stats.lobbyCreated();
        rooms.set(r.code, r);
        joinRoom(client, r, msg.name, msg.color, r.pass);
        break;
      }
      case 'join': {
        const r = rooms.get(str(msg.code).toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'No lobby with that code.' });
        if (r === room) return;
        joinRoom(client, r, msg.name, msg.color, msg.password);
        break;
      }
      case 'tolobby':
        // back to the lobby from the victory party (the party goes on for the others until they all have)
        if (room && room.phase === 'playing' && room.victory && room.backs) { room.backs.add(client.id); partyOver(room); }
        break;
      case 'leave':
        leaveRoom(client);
        send(ws, { t: 'left' });
        break;
      case 'start':
        if (room && room.chain && room.members.length < 2 && room.hostId === client.id) { send(ws, { t: 'error', msg: 'A chained game needs at least two kitties.' }); break; }
        if (room && room.versus && room.phase === 'lobby' && new Set(room.members.map((m) => m.team)).size < 2 && room.hostId === client.id) { send(ws, { t: 'error', msg: 'Versus needs at least two teams.' }); break; }
        if (room && room.versus && room.chain && room.phase === 'lobby' && soloTeam(room) && room.hostId === client.id) { send(ws, { t: 'error', msg: 'Chained versus: every team needs at least two kitties (a kitty on its own would have no chain).' }); break; }
        if (room && room.hostId === client.id && room.phase === 'lobby') {
          startGame(room, TEST_HOOKS && Number.isFinite(msg.level) ? Math.max(1, Math.min(SKATE_FINAL_LEVEL, msg.level | 0)) : 1);
        }
        break;
      case 'settings':   // the host, in the lobby: another mode / options (settingsMsg)
        settingsMsg(room, client, msg);
        break;
      case 'team':   // versus lobby: join / make / name a team
        teamMsg(room, client, msg);
        break;
      case 'chainwith':   // chained lobby: chain up with that kitty
        if (room && room.chain && room.phase === 'lobby' && chainWith(room, client.id, msg.id | 0)) sendRoom(room);
        break;
      case 'joinvote':   // chained: vote a kitty left on its own into your group (standing on its ring, body or it)
        if (room) joinVote(room, client, msg.id | 0);
        break;
      case 'joinask':   // chained: a kitty on its own asks to join (or says yes to) the group of kitty msg.to
        if (room) joinAsk(room, client, msg.to | 0);
        break;
      case 'votekill':   // vote to knock down a kitty that has stood still (AFK) for a while
        if (room) voteKill(room, client, msg.id | 0);
        break;
      case 'dbg': {
        // test hooks: put the sender's kitty in the goal (it clears the level on the next tick) ...
        if (!TEST_HOOKS || !room || !room.sim) return;
        const p = room.sim.players.find((q) => q.id === client.id);
        if (p && msg.do === 'goal') { p.alive = true; p.x = 0; p.z = 0; p.vx = 0; p.vz = 0; }
        if (p && p.alive && msg.do === 'die') { // ... or knock it down where it stands (rescue circle and all)
          Object.assign(p, { alive: false, vx: 0, vz: 0, moving: false, shield: 0, invuln: 0, speedMult: 1 });
          p.deaths++;
          room.sim.circles.push({ playerId: p.id, x: p.x, z: p.z, t: 0 });
        }
        break;
      }
      case 'in': {
        if (!room || room.phase !== 'playing') return;
        const k = msg.k | 0;
        const x = Number.isFinite(msg.x) ? Math.max(-1, Math.min(1, msg.x)) : 0;
        const z = Number.isFinite(msg.z) ? Math.max(-1, Math.min(1, msg.z)) : 0;
        const m = msg.m ? 1 : 0;   // sound on (CFG.MUSIC_BOOST)
        const margin = k - room.tick; // >0: arrived early enough to be used on time
        client.margin += (margin - client.margin) * 0.1;
        if (k <= room.tick) { client.lastInput = { x, z, m }; return; }    // late: best effort
        if (k > room.tick + 120) return;                               // nonsense / far future
        client.inputs.set(k, { x, z, m });
        break;
      }
      case 'chat': {
        if (!room) return;
        // token bucket: bursts of 5, refills one message per second
        const now = Date.now();
        if (!take(client, 'chat', 1, 5, now)) return send(ws, { t: 'chat', sys: true, text: 'Slow down a little!' });
        const raw = str(msg.text).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!raw) return;
        client.chatLog.push({ at: new Date(now).toISOString(), room: room.code, text: raw });
        if (client.chatLog.length > CHAT_HISTORY) client.chatLog.shift();
        broadcast(room, { t: 'chat', id: client.id, name: client.name, color: client.color, text: raw }); // unfiltered (the apps mask on their side)
        break;
      }
      case 'gsub':
        // the global chat (everyone playing): this client wants its messages (or no more). Nothing from before is sent.
        client.gsub = !!msg.on;
        break;
      case 'gchat': handleGlobalChat(client, msg); break;
      case 'emote': {
        // /dance in the chat: that player's kitty dances for everyone (clients draw it; the chat's rate limit)
        if (!room || room.phase !== 'playing' || msg.e !== 'dance' || !take(client, 'chat', 1, 5, Date.now())) return;
        broadcast(room, { t: 'emote', id: client.id, e: 'dance' });
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', c: msg.c, k: room && room.phase === 'playing' ? room.tick : 0 });
        break;
      case 'items': {
        // a client whose level came out different from ours (main.js checkLevelHash): the real pickups, to draw
        // those instead (its own would be in other spots: invisible pickups). At most once a second.
        const now = Date.now();
        if (!room || !room.sim || now - (client.itemsAt || 0) < 1000) return;
        client.itemsAt = now;
        const sim = room.sim;
        send(ws, { t: 'items', lvl: sim.level, items: sim.items.map((it) => ({ id: it.id, type: it.type, x: it.x, z: it.z, taken: it.taken || undefined, mega: it.mega || undefined })) });
        break;
      }
      case 'resync': {
        // the client asks at most every 2 s (main.js); the full wolf state is big, so hold it to 1/s
        const now = Date.now();
        if (!room || !room.sim || now - (client.resyncAt || 0) < 1000) return;
        client.resyncAt = now;
        const sim = room.sim, c = room.wolfMsg;
        // (an easy game's level starting over keeps its sim and level number but its wolves start again: never reuse one from
        // before that, its time ahead of the new wolves' would hold them still on the client until it caught up)
        if (!c || c.sim !== sim || c.lvl !== sim.level || sim.enemyTicks < c.lt || sim.enemyTicks - c.lt > RESYNC_REUSE) {
          room.wolfMsg = { sim, lvl: sim.level, lt: sim.enemyTicks, s: JSON.stringify({ t: 'wolves', lvl: sim.level, lt: sim.enemyTicks, wolves: serializeEnemies(sim.enemies) }) };
        }
        send(ws, room.wolfMsg.s);
        break;
      }
    }
  }

  ws.on('close', () => {
    const left = (connsPerIp.get(ipk) || 1) - 1;
    if (left > 0) connsPerIp.set(ipk, left); else connsPerIp.delete(ipk);
    leaveRoom(client);
    // a late report only needs these (not the socket and the rest)
    clients.set(client.id, { id: client.id, name: client.name, app: client.app, ver: client.ver, hi: client.hi, ip: client.ip, chatLog: client.chatLog, room: null, ws: CLOSED_WS });
    setTimeout(() => clients.delete(client.id), 10 * 60e3);
  });
  ws.on('error', () => {});
});

// ---------------- moderation ----------------
const appendReport = boundedJsonl(REPORTS_FILE, REPORTS_FILE_MAX);
const reportHits = new Map(); // ip -> [timestamps], survives a reporter reconnect
const reportDuplicates = new Map(); // ip + target id -> last report time
let reportGlobalHits = [];
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of reportHits) if (!h.some((t) => now - t < 3600e3)) reportHits.delete(ip);
  for (const [key, at] of reportDuplicates) if (now - at >= 3600e3) reportDuplicates.delete(key);
  reportGlobalHits = reportGlobalHits.filter((t) => now - t < 3600e3);
}, 600e3).unref();

function handleReport(client, msg) {
  const now = Date.now();
  const reply = (text) => send(client.ws, { t: 'chat', sys: true, text });
  const target = Number.isSafeInteger(msg.id) ? clients.get(msg.id) : null;
  if (!target || target === client) return reply('Could not find that player.');
  const duplicateKey = client.ip + '\0' + target.id;
  if (now - (reportDuplicates.get(duplicateKey) || 0) < 3600e3) return reply('You already reported that player.');
  const hits = (reportHits.get(client.ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= REPORTS_PER_HOUR) return reply('You have sent a lot of reports — try again later.');
  reportGlobalHits = reportGlobalHits.filter((t) => now - t < 3600e3);
  if (reportGlobalHits.length >= REPORTS_GLOBAL_PER_HOUR) return reply('Reports are busy right now — try again later.');
  // Reserve both quotas before starting async IO; concurrent reports cannot all pass the same check.
  hits.push(now); reportHits.set(client.ip, hits); reportGlobalHits.push(now);
  reportDuplicates.set(duplicateKey, now);
  const reason = REPORT_REASONS.includes(msg.reason) ? msg.reason : 'other';
  const room = client.room || target.room;
  const who = (c) => ({ id: c.id, name: c.name, app: c.app, ver: c.ver });
  const entry = {
    at: new Date(now).toISOString(), reason, room: room ? room.code : null,
    reporter: who(client), reported: { ...who(target), ip: target.ip, chat: target.chatLog.slice() },
  };
  const retryable = () => { if (reportDuplicates.get(duplicateKey) === now) reportDuplicates.delete(duplicateKey); };
  appendReport(entry).then((result) => {
    if (result === 'ok') return reply('Thanks — report sent.');
    retryable(); // an unwritten report must not be presented as an already-sent duplicate
    reply(result === 'full' ? 'Reports are full right now — try again later.' : 'Reports are busy right now — try again later.');
  }).catch((err) => { retryable(); console.error('report write failed:', err.message); reply('Could not send that report — try again later.'); });
}

// Cross-play usage at a glance in the service log.
setInterval(() => {
  const n = { web: 0, ios: 0, android: 0, old: 0 };
  for (const c of clients.values()) if (c.ws.readyState === 1) n[c.hi ? c.app : 'old']++;
  if (n.web + n.ios + n.android + n.old) console.log(`clients: web ${n.web}, ios ${n.ios}, android ${n.android}, no-hi ${n.old}; rooms ${rooms.size}`);
}, 5 * 60e3).unref();

// Forget connection-rate buckets that are full again.
setInterval(() => {
  const now = Date.now();
  for (const [ip, cr] of connRate) if (cr.tok + (now - cr.at) / 1000 * CONN_RATE >= CONN_BURST) connRate.delete(ip);
}, 60e3).unref();

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// Last resort: anything that still escapes is logged; state may be inconsistent, so exit and let systemd restart us.
process.on('uncaughtException', (err) => {
  console.error('uncaught:', err);
  try { stats.flush(); } catch { /* ignore */ }
  try { legends.flush(); } catch { /* ignore */ }
  try { levels.flush(); } catch { /* ignore */ }
  try { accounts.flush(); } catch { /* ignore */ }
  process.exit(1);
});

// Deploy / restart: tell the players, close with 1012 (service restart) so clients reconnect, save stats, go.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const room of rooms.values()) {
    try { broadcast(room, { t: 'chat', sys: true, text: 'Server restarting…' }); } catch { /* ignore */ }
  }
  for (const ws of wss.clients) { try { ws.close(1012, 'restarting'); } catch { /* ignore */ } }
  stats.flush();
  legends.flush();
  levels.flush();
  accounts.flush();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(PORT, HOST, () => console.log(`Run Kitty Run server on http://${HOST}:${PORT}`));
