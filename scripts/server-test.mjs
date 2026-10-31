// Manual server test (NOT in CI): starts its own server on a free port (test hooks on, temp state files) and runs
//   1. online Skate only finale: version gating, start on the final run, victory event/snapshots, late joiner,
//      back to the lobby, the win in /api/stats, a fresh game afterwards
//   2. moderation / cross-play: hi/outdated gate, app badges, unfiltered chat, reports (apps), CORS, deep-link files
//   3. lobby/server smoke: lobby limits, chat, host start/migration, inputs, snapshots, mode gating for old clients
//   4. security: malformed HTTP bodies, report quotas across reconnects, bounded report storage
// Usage: node scripts/server-test.mjs   (PORT=... to pick a port; default: a free one). Never point it at the live server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CFG, NET, PLAYER_NAMES, PROTOCOL_VERSION, LATEST_FV, SKATE_FINAL_LEVEL as F } from '../public/js/shared/config.js';
import { createSim } from '../public/js/shared/sim.js';
import { updateEnemies } from '../public/js/shared/enemies.js';
import { levelHash } from '../public/js/shared/maze.js';

const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = +process.env.PORT || await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-server-test-'));
const REPORTS_FILE = path.join(tmp, 'reports.jsonl');
const SERVER_MIN = 4;   // server/index.js MIN_PROTOCOL (protocol 4 clients still play, minus Run only's level 9 ending)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', RKR_TEST_HOOKS: '1', MAX_CONN_PER_IP: '100', REPORTS_FILE,
    FEEDBACK_FILE: path.join(tmp, 'feedback.jsonl'), STATS_FILE: path.join(tmp, 'stats.json'),
    ACCOUNTS_FILE: path.join(tmp, 'accounts.json'), GOOGLE_CLIENT_ID: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
    APPLE_TEAM_ID: 'TEAM123456', ANDROID_CERT_SHA256: 'AA:BB, CC:DD' },
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res, rej) => { srv.stdout.on('data', (d) => { if (/server on/.test(d)) res(); }); srv.on('exit', () => rej(new Error('server exited: ' + srvErr))); });
console.log(`server on port ${PORT}`);

// ---------------- 1. online Skate only finale ----------------
async function victory() {
  const bots = [];
  function bot(hi) {
    const ws = new WebSocket(WS_URL);
    const b = { ws, msgs: [], snaps: [], last: {} };
    ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t === 'snap') b.snaps.push(m); else b.msgs.push(m); });
    b.send = (m) => ws.send(JSON.stringify(m));
    b.ready = new Promise((r) => ws.on('open', () => { if (hi) b.send({ t: 'hi', ...hi }); r(); }));
    bots.push(b);
    return b;
  }
  const NEW = { v: PROTOCOL_VERSION, app: 'web', ver: 'test' };

  // ---- version gating: older builds are told to update (protocol 4: slim wolf resync, every mode); clients
  // without a 'hi' can't play any mode
  const noHi = bot(null), app3 = bot({ v: SERVER_MIN - 1, app: 'ios', ver: '1.0' });
  await Promise.all([noHi.ready, app3.ready]); await sleep(150);
  ok(app3.last.outdated && app3.ws.readyState >= 2, `protocol-${SERVER_MIN - 1} app told to update and dropped`);

  // ---- Run only's level 9 ending (protocol 5): a room with a protocol-4 kitty keeps the old spiral; a room playing
  // the ending can't be joined by one
  {
    const a = bot(NEW), old = bot({ v: 4, app: 'ios', ver: '1.0' }), b = bot(NEW), old2 = bot({ v: 4, app: 'ios', ver: '1.0' });
    await Promise.all([a.ready, old.ready, b.ready, old2.ready]);
    a.send({ t: 'create', name: 'A', mode: 'run' }); b.send({ t: 'create', name: 'B', mode: 'run' }); await sleep(150);
    old.send({ t: 'join', code: a.last.room.code, name: 'Old' }); await sleep(150);
    a.send({ t: 'start', level: F }); b.send({ t: 'start', level: F }); await sleep(300);
    ok(old.last.start && old.last.start.rf === 0 && a.last.start.rf === 0, 'Run only room with a protocol-4 kitty: no level 9 ending (rf 0)');
    ok(b.last.start && b.last.start.rf === LATEST_FV, `Run only room of current kitties plays the newest levels (rf ${LATEST_FV})`);
    old2.send({ t: 'join', code: b.last.room.code, name: 'Old2' }); await sleep(150);
    ok(old2.last.error && /new level 9/.test(old2.last.error.msg) && !old2.last.start, `protocol-4 kitty can't join it mid-game: "${old2.last.error && old2.last.error.msg}"`);
    for (const x of [a, old, b, old2]) x.ws.close();
  }
  // ---- chained lobbies (protocol 33): not alone, not for older clients; partners picked in the lobby (swapped in), the
  // chains in the start message; one leaving leaves an anchor, and coming back in time it takes its place again
  {
    const a = bot(NEW), b = bot(NEW), c = bot(NEW), d = bot({ ...NEW, tok: 'chain-tab-token-d' }), old = bot({ v: 32, app: 'web', ver: 'test' });
    await Promise.all([a.ready, b.ready, c.ready, d.ready, old.ready]);
    a.send({ t: 'create', name: 'A', mode: 'run', chain: true }); await sleep(150);
    a.send({ t: 'start' }); await sleep(150);
    ok(a.last.room.chain && a.last.error && /two kitties/.test(a.last.error.msg) && !a.last.start, 'chained lobby: no start alone');
    const code = a.last.room.code;
    old.send({ t: 'join', code, name: 'Old' }); await sleep(150);
    ok(old.last.error && /chained/.test(old.last.error.msg) && !old.last.room, 'chained lobby: a protocol-32 kitty cant join');
    for (const [x, n] of [[b, 'B'], [c, 'C'], [d, 'D']]) { x.send({ t: 'join', code, name: n }); await sleep(120); }
    const id = (x) => x.last.room.you;
    ok(JSON.stringify(a.last.room.order) === JSON.stringify([id(a), id(b), id(c), id(d)]), 'chained lobby: chain order is the join order');
    a.send({ t: 'chainwith', id: id(c) }); await sleep(150);
    ok(JSON.stringify(b.last.room.order) === JSON.stringify([id(a), id(c), id(b), id(d)]), 'chained lobby: A picks C, B takes C place');
    a.send({ t: 'start' }); await sleep(300);
    const cn = d.last.start && d.last.start.cn;
    ok(cn && JSON.stringify(cn.c) === JSON.stringify([[id(a), id(c)], [id(b), id(d)]]), 'chained game: the chains as picked in the start message');
    const dId = id(d);
    d.ws.close(); await sleep(250);
    ok(b.last.chains && b.last.chains.a && b.last.chains.a[dId] && JSON.stringify(b.last.chains.c[1]) === JSON.stringify([id(b), dId]), 'chained game: D leaving leaves an anchor on its chain');
    const d2 = bot({ ...NEW, tok: 'chain-tab-token-d' }); await d2.ready;
    d2.send({ t: 'join', code, name: 'D' }); await sleep(300);
    const back = d2.last.start && d2.last.start.cn;
    ok(back && JSON.stringify(back.c[1]) === JSON.stringify([id(b), d2.last.room.you]) && !Object.keys(back.a).length && b.last.chains.c.length === 2, 'chained game: D back in time takes its place on its chain');
    // left from the menu (same connection, same id) and back: the game starts for it, back on its chain
    const bId = id(b);
    b.send({ t: 'leave' }); await sleep(200); delete b.last.start;
    b.send({ t: 'join', code, name: 'B' }); await sleep(300);
    ok(b.last.start && JSON.stringify(b.last.start.cn.c[1]) === JSON.stringify([bId, d2.last.room.you]) && !Object.keys(b.last.start.cn.a).length, 'chained game: one leaving from the menu and back gets the game, on its chain');
    for (const x of [a, b, c, d2, old]) x.ws.close();
    await sleep(3500);   // (the connection rate limit: these six back, CONN_RATE 2/s)
  }
  // ---- versus lobbies: everyone on a team of their own; JOIN asks, someone in the team accepts (or declines); no start
  // with one team; the start message and snapshots carry the teams
  {
    const a = bot(NEW), b = bot(NEW), c = bot(NEW);
    await Promise.all([a.ready, b.ready, c.ready]);
    a.send({ t: 'create', name: 'Ann', mode: 'run', versus: true }); await sleep(150);
    const code = a.last.room.code;
    b.send({ t: 'join', code, name: 'Bob' }); await sleep(120);
    c.send({ t: 'join', code, name: 'Cat' }); await sleep(150);
    const me = (x) => x.last.room.you, team = (x) => a.last.room.mt[me(x)], tA = team(a);
    b.send({ t: 'team', act: 'join', id: tA }); c.send({ t: 'team', act: 'join', id: tA }); await sleep(200);
    const asked = team(b) !== tA && JSON.stringify(a.last.room.teams.find((t) => t.id === tA).req) === JSON.stringify([me(b), me(c)]);
    a.send({ t: 'team', act: 'accept', id: me(b) }); a.send({ t: 'team', act: 'decline', id: me(c) }); await sleep(200);
    ok(a.last.room.versus && asked && team(b) === tA && team(c) !== tA && !a.last.room.teams.find((t) => t.id === tA).req && a.last.room.teams.length === 2,
      'versus lobby: JOIN asks to join a team; accepted you are in, declined you stay on your own');
    b.send({ t: 'team', act: 'ready' }); await sleep(150);
    const rdy = c.last.room.teams.find((t) => t.id === tA).ready === true;
    c.send({ t: 'team', act: 'join', id: tA }); await sleep(100); b.send({ t: 'team', act: 'accept', id: me(c) }); await sleep(150);
    ok(rdy && team(c) === tA && !c.last.room.teams.find((t) => t.id === tA).ready, 'versus lobby: a team marked ready shows to everyone; someone joining it takes that back');
    c.send({ t: 'team', act: 'new' }); await sleep(150);
    a.send({ t: 'start' }); await sleep(300);
    const st = c.last.start, vs = st && st.vs;
    ok(st && vs.length === 2 && st.players.find((p) => p.id === me(b)).team === tA, 'versus game: the start message has the teams and who is in which');
    for (const x of [a, b, c]) x.ws.close();
    await sleep(2000);   // (the connection rate limit)
  }
  // ---- versus matchmaking: two searching lobbies (same mode) come together, teams and names kept; a searching lobby
  // with no other joins a searching game in progress as a team of its own
  {
    const a = bot(NEW), b = bot(NEW), c = bot(NEW), d = bot(NEW);
    await Promise.all([a.ready, b.ready, c.ready, d.ready]);
    a.send({ t: 'create', name: 'Ann', mode: 'ice', versus: true }); await sleep(150);
    b.send({ t: 'join', code: a.last.room.code, name: 'Bob' }); await sleep(150);
    b.send({ t: 'team', act: 'join', id: a.last.room.mt[a.last.room.you] }); await sleep(100);
    a.send({ t: 'team', act: 'accept', id: b.last.room.you }); a.send({ t: 'team', act: 'name', name: 'Ice Cats' }); await sleep(150);
    c.send({ t: 'create', name: 'Cat', mode: 'ice', versus: true }); await sleep(150);
    a.send({ t: 'team', act: 'search' }); c.send({ t: 'team', act: 'search' }); await sleep(1800);
    const R = a.last.room;
    ok(c.last.room.code === R.code && R.members.length === 3 && R.teams.length === 2 && R.teams.some((t) => t.name === 'Ice Cats') && R.mt[b.last.room.you] === R.mt[R.you] && R.search,
      'versus matchmaking: searching lobbies come together (the smaller moves in), teams and names kept');
    a.send({ t: 'start' }); await sleep(400);
    d.send({ t: 'create', name: 'Dot', mode: 'ice', versus: true }); await sleep(150);
    d.send({ t: 'team', act: 'search' }); await sleep(1800);
    const ds = d.last.start;
    ok(ds && d.last.room.code === R.code && ds.players.find((p) => p.id === d.last.room.you).team !== ds.players.find((p) => p.id === R.you).team && ds.vs.length === 3,
      'versus matchmaking: a searching lobby joins a searching game in progress, as a team of its own');
    // one leaving and coming back in a new tab (same browser: pid) is on its team again
    const PIDB = 'versusbrowserpid000000001';
    const e = bot({ ...NEW, tok: 'vs-tab-old-0001', pid: PIDB }); await e.ready;
    e.send({ t: 'join', code: R.code, name: 'Eve' }); await sleep(300);
    const eTeam = e.last.start && e.last.start.players.find((p) => p.id === e.last.room.you).team;
    e.ws.close(); await sleep(300);
    const e2 = bot({ ...NEW, tok: 'vs-tab-new-0001', pid: PIDB }); await e2.ready;
    e2.send({ t: 'join', code: R.code, name: 'Eve' }); await sleep(300);
    const e2Team = e2.last.start && e2.last.start.players.find((p) => p.id === e2.last.room.you).team;
    ok(eTeam && e2Team === eTeam, 'versus game: one leaving and coming back in a new tab (the same browser) is on its team again');
    // any mode: a Skate only lobby searching in any mode goes into a Run only lobby searching (and plays Run only); one
    // searching in its own mode only stays apart from another mode
    const f = bot(NEW), g = bot(NEW);
    await Promise.all([f.ready, g.ready]);
    f.send({ t: 'create', name: 'Fay', mode: 'run', versus: true }); await sleep(150);
    g.send({ t: 'create', name: 'Gus', mode: 'mixed', versus: true }); await sleep(150);
    f.send({ t: 'team', act: 'search' }); g.send({ t: 'team', act: 'search' }); await sleep(1800);
    const apart = f.last.room.code !== g.last.room.code;
    g.send({ t: 'team', act: 'any' }); await sleep(1800);   // (the any mode switch, while searching)
    ok(apart && g.last.room.code === f.last.room.code && g.last.room.mode === 'run' && f.last.room.members.length === 2,
      'versus matchmaking: searching in any mode joins another mode\'s lobby (and plays its mode); in its own mode only it stays apart');
    f.ws.close(); g.ws.close();
    // two in a Run + Skate lobby searching in any mode, one in Run only searching its own mode: the one's pick is kept
    // (the two move in and play Run only); then both in any mode, the bigger group's mode is played
    const j1 = bot(NEW), j2 = bot(NEW), k1 = bot(NEW);
    await Promise.all([j1.ready, j2.ready, k1.ready]);
    j1.send({ t: 'create', name: 'Jo', mode: 'mixed', versus: true }); await sleep(150);
    j2.send({ t: 'join', code: j1.last.room.code, name: 'Jay' }); await sleep(150);
    k1.send({ t: 'create', name: 'Kit', mode: 'run', versus: true }); await sleep(150);
    j1.send({ t: 'team', act: 'any' }); j1.send({ t: 'team', act: 'search' }); k1.send({ t: 'team', act: 'search' }); await sleep(1800);
    ok(j1.last.room.code === k1.last.room.code && j1.last.room.mode === 'run' && k1.last.room.members.length === 3,
      'versus matchmaking: a group searching in its own mode keeps it, the one searching in any mode moves in (even when bigger)');
    for (const x of [j1, j2, k1]) x.ws.close();
    await sleep(1500);
    const m1 = bot(NEW), m2 = bot(NEW), n1 = bot(NEW);
    await Promise.all([m1.ready, m2.ready, n1.ready]);
    m1.send({ t: 'create', name: 'Max', mode: 'mixed', versus: true }); await sleep(150);
    m2.send({ t: 'join', code: m1.last.room.code, name: 'Mo' }); await sleep(150);
    n1.send({ t: 'create', name: 'Ned', mode: 'run', versus: true }); await sleep(150);
    m1.send({ t: 'team', act: 'any' }); n1.send({ t: 'team', act: 'any' }); m1.send({ t: 'team', act: 'search' }); n1.send({ t: 'team', act: 'search' }); await sleep(1800);
    ok(n1.last.room.code === m1.last.room.code && n1.last.room.mode === 'mixed', 'versus matchmaking: both in any mode, the bigger group keeps its mode');
    for (const x of [m1, m2, n1]) x.ws.close();
    await sleep(1500);
    // chained versus: no start while a team has a kitty on its own (it would have no chain)
    const p1 = bot(NEW), p2 = bot(NEW);
    await Promise.all([p1.ready, p2.ready]);
    p1.send({ t: 'create', name: 'Pip', mode: 'run', versus: true, chain: true }); await sleep(150);
    p2.send({ t: 'join', code: p1.last.room.code, name: 'Pat' }); await sleep(150);
    p1.send({ t: 'start' }); await sleep(250);
    ok(p1.last.room.phase === 'lobby' && p1.last.error && /Chained versus/.test(p1.last.error.msg), 'chained versus lobby: no start while a team has only one kitty');
    for (const x of [p1, p2]) x.ws.close();
    await sleep(1500);
    // finding players in any lobby: two that aren't versus come together; a versus one stays apart from them; the host
    // turns versus on in the lobby (everyone a team of their own) and off again
    const q1 = bot(NEW), q2 = bot(NEW), q3 = bot(NEW);
    await Promise.all([q1.ready, q2.ready, q3.ready]);
    q1.send({ t: 'create', name: 'Quin', mode: 'run' }); await sleep(150);
    q2.send({ t: 'create', name: 'Qat', mode: 'run' }); await sleep(150);
    q3.send({ t: 'create', name: 'Quo', mode: 'run', versus: true }); await sleep(150);
    for (const x of [q1, q2, q3]) x.send({ t: 'team', act: 'search' });
    await sleep(1800);
    const together = q1.last.room.code === q2.last.room.code && q1.last.room.members.length === 2 && q3.last.room.code !== q1.last.room.code && !q1.last.room.versus;
    const host = [q1, q2].find((x) => x.last.room.host === x.last.room.you);
    host.send({ t: 'team', act: 'versus' }); await sleep(200);
    const on = host.last.room.versus && host.last.room.teams.length === 2;
    host.send({ t: 'team', act: 'versus' }); await sleep(200);
    ok(together && on && !host.last.room.versus, 'finding players: two lobbies that are not versus come together, a versus one stays apart; versus on (a team each) and off in the lobby');
    // the host changes the lobby's game in the lobby (another mode, chained, versus: a team each); not someone else
    const guest = [q1, q2].find((x) => x !== host);
    guest.send({ t: 'settings', mode: 'ice' }); await sleep(200);
    const notGuest = host.last.room.mode === 'run';
    host.send({ t: 'settings', mode: 'ice', chain: 'all', versus: true }); await sleep(200);
    const lr = guest.last.room;
    ok(notGuest && lr.mode === 'ice' && lr.chain === 'all' && lr.versus && lr.teams.length === 2 && !lr.easy, 'lobby: the host changes the game in the lobby (mode, chained, versus: a team each), nobody else can');
    host.send({ t: 'settings', mode: 'run', hell: true, hl: true, versus: true }); await sleep(200);
    ok(guest.last.room.hell && guest.last.room.versus && guest.last.room.mode === 'run', 'lobby: hell can be played versus');
    for (const x of [q1, q2, q3]) x.ws.close();
    for (const x of [a, b, c, d, e2]) x.ws.close();
    await sleep(3500);   // (the connection rate limit)
  }
  {
    // Run + Skate (protocol 7): level 9 is both final runs in a row; a client builds the very same level from 'start'
    const c = bot(NEW); await c.ready;
    c.send({ t: 'create', name: 'C', mode: 'mixed' }); await sleep(150);
    c.send({ t: 'start', level: F }); await sleep(400);
    const cs = c.last.start, cm = cs && createSim({ seed: cs.seed, players: cs.players, startLevel: cs.level, mode: cs.mode, finales: +cs.rf || 0 });
    ok(cs && cs.rf === LATEST_FV && cm.levelData.combo && levelHash(cm.levelData) === cs.lh, `Run + Skate level 9 online: both final runs (rf ${cs && cs.rf}), same level on the client`);
    c.ws.close();
  }
  noHi.send({ t: 'create', name: 'Old', mode: 'ice' }); await sleep(150);
  ok(noHi.last.error && /Skate only/.test(noHi.last.error.msg) && !noHi.last.room, `no-hi client can't create a Skate only lobby: "${noHi.last.error && noHi.last.error.msg}"`);
  const host = bot(NEW); await host.ready;
  host.send({ t: 'create', name: 'Host', mode: 'ice' }); await sleep(150);
  const code = host.last.room && host.last.room.code;
  ok(code && host.last.room.mode === 'ice', `protocol-${PROTOCOL_VERSION} client creates Skate only lobby ${code}`);
  noHi.send({ t: 'list' }); host.send({ t: 'list' }); await sleep(150);
  ok(!noHi.last.lobbies.list.some((l) => l.code === code) && host.last.lobbies.list.some((l) => l.code === code), 'Skate only lobby hidden from old clients, listed for new ones');
  noHi.last.error = null;
  noHi.send({ t: 'join', code, name: 'Old' }); await sleep(150);
  ok(noHi.last.error && /code/.test(noHi.last.error.msg) && !noHi.last.room, `no-hi client can't join it by code: "${noHi.last.error && noHi.last.error.msg}"`);

  // ---- start on the final run
  const guest = bot({ ...NEW, tok: 'guest-tab-token' }); await guest.ready;
  guest.send({ t: 'join', code, name: 'Guest' }); await sleep(150);
  host.send({ t: 'start', level: F }); await sleep(300);
  const st = guest.last.start;
  ok(st && st.level === F && st.mode === 'ice' && st.st === 'playing' && st.vic === null, `start message: level ${st && st.level}, mode ${st && st.mode}, st ${st && st.st}`);
  // the client path: build the level from the start message and mirror the wolves; compare with the server's wolf checks
  const mirror = createSim({ seed: st.seed, players: st.players, startLevel: st.level, mode: st.mode, finales: +st.rf || 0 });
  await sleep(500);
  const snap = guest.snaps.at(-1);
  for (let t = 0; t < snap.lt; t++) updateEnemies(mirror.enemies, mirror.levelData, CFG.TICK);
  const wd = Math.max(...snap.ec.map(([id, x, z]) => { const e = mirror.enemies.find((q) => q.id === id); return e ? Math.hypot(e.x - x, e.z - z) : Infinity; }));
  ok(mirror.levelData.finale && snap.lvl === F && snap.st === 'playing' && wd < 0.002,
    `client-built final run matches the server (${mirror.enemies.length} wolves, wolf check diff ${wd.toFixed(4)} after ${snap.lt} ticks)`);
  ok(st.lh === levelHash(mirror.levelData), `start message level hash ${st.lh} matches the client-built level`);

  // ---- win
  guest.snaps.length = 0;
  host.send({ t: 'dbg', do: 'goal' });
  await sleep(400);
  const evSnap = guest.snaps.find((s) => s.ev.some((e) => e.type === 'victory'));
  const vic = evSnap && evSnap.ev.find((e) => e.type === 'victory');
  const hostId = host.last.room.you, guestId = guest.last.room.you;
  ok(vic && vic.by === hostId && vic.level === F && Array.isArray(vic.party) && vic.party.includes(guestId),
    `guest receives the victory event in a snapshot (by ${vic && vic.by}, party [${vic && vic.party}])`);
  ok(evSnap && evSnap.ev.some((e) => e.type === 'levelClear') && evSnap.st === 'victory', `that snapshot also has levelClear and st '${evSnap && evSnap.st}'`);
  const tWin = Date.now();

  // ---- late joiner mid-victory
  await sleep(1500);
  const late = bot(NEW); await late.ready;
  late.send({ t: 'join', code, name: 'Late' }); await sleep(400);
  const ls = late.last.start;
  ok(ls && ls.level === F && ls.st === 'victory' && ls.vic && ls.vic.type === 'victory' && Array.isArray(ls.wolves),
    `late joiner gets start with st '${ls && ls.st}', the victory event and full wolf state`);
  const lateId = late.last.room && late.last.room.you;
  const lp = late.snaps.at(-1) && late.snaps.at(-1).p.find((p) => p[0] === lateId);
  ok(lp && lp[6] === 1 && lp[7] === 1 && Math.hypot(lp[1], lp[2]) < 5, `late joiner is in the party (alive, in goal, ${lp && Math.hypot(lp[1], lp[2]).toFixed(1)} from the portal)`);

  // ---- legends board: the winners (not the late joiner) get it and may sign once each, editable, capped
  const lg = guest.last.legends, lw = lg && lg.wins[0];
  ok(host.last.legends && lg && lg.can && lw.id === lg.can.id && lw.mode === 'ice' && lw.entries.map((e) => e.name).join() === 'Host,Guest' && lw.entries.every((e) => e.text === ''),
    `winners get the legends board with their team on it (${lw && lw.entries.map((e) => e.name)})`);
  late.send({ t: 'sign', text: 'I was not there' }); await sleep(150);
  ok(!late.last.legends && late.last.signed && late.last.signed.ok === false, 'late joiner gets no board and can\'t sign');
  guest.send({ t: 'sign', text: '  Hello\nworld\u0007 ' + 'x'.repeat(300) }); await sleep(150);
  const gl = host.last.legend && host.last.legend.win.entries[1].text;
  ok(guest.last.signed.ok && gl && gl.length === 140 && gl.startsWith('Hello world x') && !late.last.legend, `guest signs (single line, capped at ${gl && gl.length}), host sees it live, the late joiner doesn't`);
  guest.send({ t: 'sign', text: 'Edited' }); await sleep(150);
  const lb = await (await fetch(`http://127.0.0.1:${PORT}/api/legends`)).json();
  ok(host.last.legend.win.entries.length === 2 && lb.wins[0].entries[1].text === 'Edited' && lb.wins[0].entries[0].text === '', 'the guest edits its line (still one entry each); /api/legends has it');
  // offline (solo / co-op) wins sign over HTTP: plausible runs only, one per IP per 10 minutes, edits with the key
  const post = (body, ip = '10.9.9.9') => fetch(`${BASE}/api/legends`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const coop = { mode: 'mixed', time: 900, runTime: 120, players: [{ name: 'Mittens', color: 0xffb347, text: 'We did it!' }, { name: 'Socks', color: 0x6ec6ff, text: '' }] };
  const quick = await post({ ...coop, time: 60 }), noMode = await post({ ...coop, mode: 'tag' });
  const made = await post(coop), again2 = await post(coop);
  ok(!quick.ok && !noMode.ok && made.ok && made.win.kind === 'coop' && made.win.entries.length === 2 && made.key && again2.status === 429,
    `offline co-op win signed (${made.win && made.win.kind}); too-quick / unknown mode rejected; a 2nd win from the same IP within 10 min refused (${again2.status})`);
  const bad = await post({ id: made.id, key: 'nope', players: [{ text: 'hacked' }] });
  const edit = await post({ id: made.id, key: made.key, players: [{ text: 'We did it!' }, { text: 'Me too' }] });
  ok(!bad.ok && edit.ok && edit.win.entries[1].text === 'Me too' && edit.win.entries[0].text === 'We did it!', 'offline lines editable with the key only');

  // ---- snapshots keep coming, all 'victory', until everyone has gone back to the lobby ('tolobby'), one by one
  const n0 = guest.snaps.length;
  await sleep(Math.max(0, 14000 - (Date.now() - tWin)));   // (past the old 12 s: the party goes on)
  const stillOn = guest.last.room && guest.last.room.phase === 'playing';
  host.send({ t: 'tolobby' }); late.send({ t: 'tolobby' }); await sleep(400);
  const twoBack = guest.last.room && guest.last.room.phase === 'playing';
  guest.send({ t: 'tolobby' });
  const tAll = Date.now();
  while (!(guest.last.room && guest.last.room.phase === 'lobby') && Date.now() - tAll < 3000) await sleep(50);
  const back = (Date.now() - tAll) / 1000;
  const during = guest.snaps.slice(n0);
  ok(stillOn && twoBack && guest.last.room.phase === 'lobby' && back < 1, `the party goes on past 12 s and while some are still in it; lobby ${back.toFixed(1)}s after the last one went back`);
  ok(during.length > 100 && during.every((s) => s.st === 'victory' && s.lvl === F), `${during.length} snapshots during the party, all st 'victory' on level ${F}`);
  ok(!during.some((s) => s.ev.some((e) => ['levelStart', 'gameOver', 'death'].includes(e.type))), 'no level change / game over / deaths during the party');
  const cnt = guest.snaps.length; await sleep(300);
  ok(guest.snaps.length === cnt, 'snapshots stop in the lobby');
  ok(host.last.room.members.length === 3, 'everyone (incl. the late joiner) is still in the lobby');

  // ---- stats + a new game
  const stats = await (await fetch(`http://127.0.0.1:${PORT}/api/stats`)).json();
  // onlineGames: this game + the two Run only level 9 rooms + the chained one + the two versus ones + the Run + Skate one
  ok(stats.totals.onlineWins === 1 && stats.onlineWinsByMode.ice === 1 && stats.totals.onlineGames === 7, `stats: onlineWins ${stats.totals.onlineWins}, ice ${stats.onlineWinsByMode.ice}`);
  const prevStart = guest.last.start;
  host.send({ t: 'start' });
  for (let i = 0; i < 30 && !(guest.last.start !== prevStart && guest.last.snap.st === 'playing'); i++) await sleep(100); // can lag on a busy machine
  ok(guest.last.start.level === 1 && guest.last.start.st === 'playing' && guest.last.snap.st === 'playing', 'host can start a new run (level 1) afterwards');
  // same tab reconnects (new connection, same token) after the party (the room has moved on): still in the signing window
  guest.ws.close();
  const again = bot({ ...NEW, tok: 'guest-tab-token' }); await again.ready;
  again.send({ t: 'legends' }); await sleep(150);
  again.send({ t: 'sign', text: 'From the lobby' }); await sleep(150);
  ok(again.last.legends && again.last.legends.can && again.last.signed && again.last.signed.ok && host.last.legend.win.entries[1].text === 'From the lobby',
    'after a reconnect (back in the lobby, new run started) the guest can still sign');
  for (const b of bots) b.ws.close();
  await sleep(100);
}

// ---------------- 2. moderation / cross-play ----------------
async function moderation() {
  // ip: distinct X-Forwarded-For per bot, like distinct players behind Caddy
  let ipN = 0;
  function bot(name, ip = '10.0.' + (++ipN >> 8) + '.' + (ipN & 255)) {
    const ws = new WebSocket(WS_URL, { headers: { 'x-forwarded-for': ip } });
    const b = { name, ws, msgs: [], last: {}, closed: false };
    ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t !== 'snap') b.msgs.push(m); });
    ws.on('close', () => { b.closed = true; });
    b.send = (m) => ws.send(JSON.stringify(m));
    b.ready = new Promise((r) => ws.on('open', r));
    b.sys = () => b.msgs.filter((m) => m.t === 'chat' && m.sys).map((m) => m.text);
    b.chats = () => b.msgs.filter((m) => m.t === 'chat' && !m.sys);
    return b;
  }

  // protocol gate
  const old = bot('old'); await old.ready;
  old.send({ t: 'hi', v: 0, app: 'ios', ver: '0.9' }); await sleep(200);
  ok(old.last.outdated && /update/.test(old.last.outdated.msg) && old.closed, 'outdated protocol gets "outdated" and is closed');

  const host = bot('Host'); await host.ready;
  host.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'ios', ver: '1.0.0' });
  host.send({ t: 'create', name: 'Host', mode: 'run' }); await sleep(200);
  ok(!host.closed && host.last.room, 'current protocol accepted');
  const code = host.last.room.code;
  const droid = bot('Droid'); await droid.ready;
  droid.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'android', ver: '1.0.0<script>' });
  droid.send({ t: 'join', code, name: 'Droid' });
  const legacy = bot('Legacy'); await legacy.ready; // says hi without an app field (counts as web)
  legacy.send({ t: 'hi', v: PROTOCOL_VERSION });
  legacy.send({ t: 'join', code, name: 'Legacy' });
  const weird = bot('Weird'); await weird.ready;
  weird.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'windows-phone' });
  weird.send({ t: 'join', code, name: 'xXfuckerXx' });
  await sleep(300);
  const apps = Object.fromEntries(host.last.room.members.map((m) => [m.id, m.app]));
  const idOf = (b) => b.last.room.you;
  ok(apps[idOf(host)] === 'ios' && apps[idOf(droid)] === 'android' && apps[idOf(legacy)] === 'web' && apps[idOf(weird)] === 'web',
    'member app field: ' + JSON.stringify(Object.values(apps)));
  const weirdName = host.last.room.members.find((m) => m.id === idOf(weird)).name;
  ok(weirdName === 'xXfuckerXx', `names relayed as typed (${weirdName})`);

  // chat is relayed unfiltered (only the store apps mask words, client side)
  droid.send({ t: 'chat', text: 'what the fuck, join www.spam.com' }); await sleep(200);
  const got = host.chats().at(-1);
  ok(got && got.text === 'what the fuck, join www.spam.com', 'chat unfiltered: ' + (got && got.text));

  // reports
  const sysCount = host.sys().length;
  host.send({ t: 'report', id: idOf(droid), reason: 'abuse' }); await sleep(200);
  ok(host.sys().slice(sysCount).includes('Thanks — report sent.'), 'reporter thanked');
  const lines = fs.existsSync(REPORTS_FILE) ? fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n') : [];
  const rep = lines.length ? JSON.parse(lines[0]) : {};
  ok(lines.length === 1 && rep.reason === 'abuse' && rep.room === code && rep.reported.name === 'Droid' && rep.reported.app === 'android'
    && rep.reported.ver === '1.0.0script' && rep.reported.chat.some((c) => c.text.includes('fuck')) && rep.reporter.name === 'Host',
    'report written with context: ' + (lines[0] || '').slice(0, 160));
  host.send({ t: 'report', id: idOf(host), reason: 'spam' }); await sleep(100);
  ok(fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').length === 1, 'cannot report yourself');

  // Repeated reports from one IP about the same player only create one record.
  const spammer = bot('Spammer'); await spammer.ready;
  spammer.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'web' });
  spammer.send({ t: 'join', code, name: 'Spammer' }); await sleep(150);
  for (let i = 0; i < 12; i++) spammer.send({ t: 'report', id: idOf(legacy), reason: 'bogus' });
  await sleep(300);
  const all = fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(all.filter((r) => r.reporter.name === 'Spammer').length === 1, 'duplicate reports only create one record');
  ok(all.filter((r) => r.reporter.name === 'Spammer').every((r) => r.reason === 'other'), 'unknown reason stored as "other"');

  // no auto-mute: reports never silence anyone
  for (const b of [legacy, weird, spammer]) b.send({ t: 'report', id: idOf(droid), reason: 'abuse' });
  await sleep(200);
  droid.send({ t: 'chat', text: 'still here' }); await sleep(200);
  ok(host.chats().at(-1).text === 'still here' && !droid.sys().some((t) => /muted/.test(t)), 'reports never mute');

  // HTTP: CORS + deep-link files + pages
  {
    const r = await fetch(`${BASE}/api/feedback`, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    ok(r.status === 204 && r.headers.get('access-control-allow-origin') === 'capacitor://localhost'
      && /POST/.test(r.headers.get('access-control-allow-methods')) && /content-type/i.test(r.headers.get('access-control-allow-headers')), 'CORS preflight for capacitor://localhost');
    const r2 = await fetch(`${BASE}/api/feedback`, { method: 'POST', headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'from the app', name: 'T' }) });
    ok(r2.status === 200 && r2.headers.get('access-control-allow-origin') === 'https://localhost', 'CORS POST from https://localhost');
    const r3 = await fetch(`${BASE}/api/feedback`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    ok(!r3.headers.get('access-control-allow-origin'), 'no CORS for other origins');
    const r4 = await fetch(`${BASE}/.well-known/apple-app-site-association`, { redirect: 'manual' });
    const aasa = await r4.json();
    ok(r4.status === 200 && r4.headers.get('content-type') === 'application/json'
      && aasa.applinks.details[0].appIDs[0] === 'TEAM123456.io.runkittyrun.app' && aasa.applinks.details[0].components[0]['?'].room === '*', 'AASA served');
    const r5 = await fetch(`${BASE}/.well-known/assetlinks.json`, { redirect: 'manual' });
    const al = await r5.json();
    ok(r5.status === 200 && /application\/json/.test(r5.headers.get('content-type')) && al[0].target.package_name === 'io.runkittyrun.app'
      && JSON.stringify(al[0].target.sha256_cert_fingerprints) === '["AA:BB","CC:DD"]', 'assetlinks.json served');
    for (const p of ['privacy.html', 'terms.html', 'support.html', 'privacy', 'about', 'how-to-play', 'patch-notes']) {
      const r6 = await fetch(`${BASE}/${p}`);
      ok(r6.status === 200 && /text\/html/.test(r6.headers.get('content-type')), `/${p} served`);
    }
    const r7 = await fetch(`${BASE}/%E0%A4%A`);
    ok(r7.status === 400, 'malformed URL does not crash the server');
    ok((await fetch(`${BASE}/healthz`)).ok, 'server still healthy');
  }

  for (const b of [host, droid, legacy, weird, spammer]) b.ws.close();
  await sleep(100);
}

// ---------------- 3. lobby / server smoke ----------------
async function lobby() {
  const MAXP = NET.MAX_PLAYERS;
  // v: protocol sent in the client's 'hi' (default: this build's; null: an old client that never says hi)
  function bot(name, v = PROTOCOL_VERSION) {
    const ws = new WebSocket(WS_URL);
    if (v != null) ws.on('open', () => ws.send(JSON.stringify({ t: 'hi', v, app: 'ios', ver: 'test' })));
    const b = { name, ws, msgs: [], last: {}, snaps: 0 };
    ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t === 'snap') b.snaps++; else b.msgs.push(m); });
    b.send = (m) => ws.send(JSON.stringify(m));
    b.ready = new Promise((r) => ws.on('open', r));
    return b;
  }

  const host = bot('Host'); await host.ready;
  host.send({ t: 'create', name: 'Host' }); await sleep(200);
  const code = host.last.room.code;
  ok(/^[A-Z]{4}$/.test(code) && host.last.room.host === host.last.room.you, `create lobby ${code}, creator is host`);
  const others = [];
  for (let i = 0; i < MAXP; i++) { const b = bot('B' + i); await b.ready; b.send({ t: 'join', code, name: 'Bot' + i }); others.push(b); await sleep(30); }
  await sleep(300);
  ok(host.last.room.members.length === MAXP, `${MAXP} members (${host.last.room.members.length})`);
  ok(others[MAXP - 1].last.error && /full/.test(others[MAXP - 1].last.error.msg), `${MAXP + 1}th player rejected: ` + (others[MAXP - 1].last.error || {}).msg);
  others[0].send({ t: 'start' }); await sleep(200);
  ok(host.last.room.phase === 'lobby', 'non-host cannot start');
  const lister = bot('L'); await lister.ready; lister.send({ t: 'list' }); await sleep(200);
  ok(lister.last.lobbies.list.some((l) => l.code === code && l.players === MAXP), 'lobby appears in list');

  // chat: broadcast to the lobby, sanitized, rate limited, not leaked to other lobbies
  const chats = (b) => b.msgs.filter((m) => m.t === 'chat' && !m.sys);
  const outsider = bot('O'); await outsider.ready; outsider.send({ t: 'create', name: 'Outsider' }); await sleep(100);
  host.send({ t: 'chat', text: '  hi <b>kitties</b>\u0007 ' + 'x'.repeat(300) }); await sleep(200);
  const got = chats(others[3]).at(-1);
  ok(got && got.name === 'Host' && got.text.startsWith('hi <b>kitties</b> x') && got.text.length === 120, 'chat reaches lobby, trimmed to 120 chars');
  ok(chats(outsider).length === 0, 'chat does not leak to other lobbies');
  for (let i = 0; i < 8; i++) others[2].send({ t: 'chat', text: 'spam ' + i });
  await sleep(300);
  ok(chats(others[3]).filter((m) => m.text.startsWith('spam')).length === 5, 'chat rate limited to a burst of 5');
  ok(others[0].msgs.some((m) => m.t === 'chat' && m.sys && /joined/.test(m.text)), 'join notices sent');
  outsider.ws.close();

  host.send({ t: 'start' }); await sleep(100);
  ok(others[0].last.start && others[0].last.start.players.length === MAXP, 'host starts, everyone gets start');
  // host runs right for 1s using tick-tagged inputs
  const s0 = others[0].snaps;
  const me = host.last.room.you;
  let k = host.last.start.tick + 5;
  const p0 = () => host.last.snap.p.find((p) => p[0] === me);
  await sleep(200);
  const x0 = p0()[1], z0 = p0()[2], h0 = p0()[5];
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) { k += 1; host.send({ t: 'in', k, x: Math.cos(h0), z: Math.sin(h0) }); await sleep(1000 / 60); }
  await sleep(300);
  const x1 = p0()[1], z1 = p0()[2];
  ok(Math.hypot(x1 - x0, z1 - z0) > 2, `host kitty moved ${Math.hypot(x1 - x0, z1 - z0).toFixed(2)} units`);
  const rate = (others[0].snaps - s0) / ((Date.now() - t0 + 200) / 1000);
  ok(rate > 15 && rate < 30, `snapshot rate ~${rate.toFixed(1)}/s`);
  ok(Array.isArray(host.last.snap.ec) && host.last.snap.ec.length === 8, 'wolf checks included');

  // host leaves mid-game -> next player becomes host
  host.ws.close(); await sleep(300);
  ok(others[0].last.room.host === others[0].last.room.you, 'host migrates to next player');
  ok(others[0].last.snap.p.length === MAXP - 1, 'leaver removed from sim');

  // mid-game join gets wolves
  const late = bot('Late'); await late.ready; late.send({ t: 'join', code, name: 'Late' }); await sleep(300);
  ok(late.last.start && Array.isArray(late.last.start.wolves) && late.last.start.wolves.length >= 150, 'mid-game joiner gets full wolf state');

  for (const b of [...others, late, lister]) b.ws.close();
  await sleep(200);
  lister.ws.close();
  const chk = bot('C'); await chk.ready; chk.send({ t: 'list' }); await sleep(200);
  ok(!chk.last.lobbies.list.some((l) => l.code === code), 'empty lobby is removed');
  chk.ws.close();

  // Every mode needs the current protocol (4: slim wolf resync). A client that never says hi can't see, create or join
  // any lobby; one below MIN_PROTOCOL is told to update and dropped.
  const nu = bot('New'); await nu.ready;
  const nohi = bot('NoHi', null); await nohi.ready;
  await sleep(100);
  nohi.send({ t: 'create', name: 'NoHi', mode: 'run' }); await sleep(200);
  ok(!nohi.last.room && nohi.last.error && /Run only/.test(nohi.last.error.msg), 'client without hi cannot create Run only: ' + (nohi.last.error || {}).msg);
  nu.send({ t: 'create', name: 'New', mode: 'ice' }); await sleep(200);
  const iceCode = nu.last.room && nu.last.room.code;
  ok(nu.last.room && nu.last.room.mode === 'ice', `new client creates Skate only lobby ${iceCode}`);
  nohi.send({ t: 'list' }); nu.send({ t: 'list' }); await sleep(200);
  ok(!nohi.last.lobbies.list.some((l) => l.code === iceCode), 'Skate only lobby hidden from clients without hi');
  ok(nu.last.lobbies.list.some((l) => l.code === iceCode && l.mode === 'ice'), 'Skate only lobby listed for new clients');
  nohi.last.error = null;
  nohi.send({ t: 'join', code: iceCode, name: 'NoHi' }); await sleep(200);
  ok(!nohi.last.room && nohi.last.error, 'client without hi refused joining by code');
  ok(nu.last.room.members.length === 1, 'refused clients never entered the lobby');
  nu.send({ t: 'start' }); await sleep(300);
  const nu2 = bot('New2'); await nu2.ready; await sleep(50);
  nu2.send({ t: 'join', code: iceCode, name: 'New2' }); await sleep(300);
  ok(nu2.last.start && nu2.last.start.mode === 'ice' && Array.isArray(nu2.last.start.wolves) && Number.isFinite(nu2.last.start.lh), 'new client joins Skate only mid-game with wolf state and level hash');
  for (const b of [nu, nu2, nohi]) b.ws.close();
  await sleep(100);

  // a client below the server's MIN_PROTOCOL gets 'outdated' and is disconnected
  for (const v of [0, SERVER_MIN - 1]) {
    const ancient = bot('Ancient', v); await ancient.ready; await sleep(200);
    ok(ancient.last.outdated && ancient.ws.readyState >= 2, `protocol-${v} client told to update and dropped`);
  }

  // reports: three different reporters auto-mute a player's chat in that lobby
  // (the server counts distinct reporter IPs; all bots share 127.0.0.1, so only the reply is checked here)
  const r1 = bot('R1'); await r1.ready; r1.send({ t: 'create', name: 'R1' }); await sleep(200);
  const r2 = bot('R2'); await r2.ready; r2.send({ t: 'join', code: r1.last.room.code, name: 'R2' }); await sleep(200);
  r2.send({ t: 'report', id: r1.last.room.you, reason: 'spam' }); await sleep(200);
  ok(r2.msgs.some((m) => m.t === 'chat' && m.sys && /report sent/.test(m.text)), 'report acknowledged');
  for (const b of [r1, r2]) b.ws.close();
  await sleep(100);
}

async function security() {
  const post = (route, body, ip) => fetch(`${BASE}${route}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const malformed = [
    ['/api/event', { cid: { toString: null }, ev: 'visit' }],
    ['/api/event', { cid: ['abcdefgh'], ev: 'visit' }],
    ['/api/event', { cid: 'abcdefgh', ev: 'level_mismatch', mode: { toString: null } }],
    ['/api/feedback', { text: { toString: null } }],
    ['/api/feedback', { text: 'hello', name: { toString: null } }],
    ['/api/feedback', []],
  ];
  for (let i = 0; i < malformed.length; i++) {
    const [route, body] = malformed[i];
    const r = await post(route, body, `10.20.0.${i + 1}`);
    ok(r.status === 400, `${route} rejects malformed field types without crashing (${i + 1})`);
  }
  const visit = await post('/api/event', { cid: 'securitytest123', ev: 'visit', device: 'desktop' }, '10.20.1.1');
  const feedback = await post('/api/feedback', { text: 'A valid feedback message', name: 'Tester' }, '10.20.1.2');
  ok(visit.status === 200 && feedback.status === 200 && (await fetch(`${BASE}/healthz`)).status === 200,
    'normal feedback, analytics and server health survive malformed requests');

  const sockets = [];
  async function connect(ip) {
    const ws = new WebSocket(WS_URL, { headers: { 'x-forwarded-for': ip } }); sockets.push(ws);
    const b = { ws, id: null };
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'hello') { b.id = m.id; resolve(); } });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION })));
    });
    return b;
  }
  const report = (b, target) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { b.ws.off('message', onMessage); reject(new Error('report reply timed out')); }, 3000);
    const onMessage = (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'chat' || !m.sys) return;
      clearTimeout(timer); b.ws.off('message', onMessage); resolve(m.text);
    };
    b.ws.on('message', onMessage); b.ws.send(JSON.stringify({ t: 'report', id: target.id, reason: 'spam' }));
  });
  const lines = () => fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').filter(Boolean).length;
  try {
    const targets = [];
    for (let i = 0; i < 11; i++) targets.push(await connect(`10.21.1.${i + 1}`));
    const reporter = await connect('10.21.2.1');
    const before = lines();
    for (let i = 0; i < 10; i++) await report(reporter, targets[i]);
    const after = lines(); reporter.ws.close();
    const reconnected = await connect('10.21.2.1');
    const reply = await report(reconnected, targets[10]);
    ok(after === before + 10 && lines() === after && !reply.includes('report sent'), 'report quota survives reconnecting from the same IP');
    const other = await connect('10.21.2.2');
    await report(other, targets[0]); const once = lines(); other.ws.close();
    const duplicate = await connect('10.21.2.2'); await report(duplicate, targets[0]);
    ok(lines() === once, 'duplicate suppression survives reconnecting from the same IP');

    const cap = 5 << 20;
    fs.writeFileSync(REPORTS_FILE, Buffer.alloc(cap - 1, 0x20));
    const full = await Promise.all([connect('10.21.3.1'), connect('10.21.3.2')]);
    const fullReplies = await Promise.all(full.map((b) => report(b, targets[1])));
    ok(fs.statSync(REPORTS_FILE).size === cap - 1 && fullReplies.every((text) => !text.includes('report sent')),
      'concurrent reports cannot exceed the report-file size cap or claim a failed write succeeded');
  } finally { for (const ws of sockets) ws.terminate(); }
}

const t0 = Date.now();
try {
  for (const [name, fn] of [['finale', victory], ['moderation', moderation], ['lobby', lobby], ['security', security]]) {
    console.log(`\n== ${name}`);
    await fn();
  }
} catch (e) {
  ok(false, 'threw: ' + (e && e.stack || e));
} finally {
  srv.kill('SIGTERM');
  await new Promise((r) => srv.once('exit', r));
  if (srvErr.trim()) { console.log('FAIL server stderr:\n' + srvErr); process.exitCode = 1; }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
}
console.log(`\n${process.exitCode ? 'FAIL' : 'PASS'} server-test  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit();
