// Level boards: the fastest clear of every level, a board each per
//   source      online (server-simulated, can't be faked) or local (reported by the game itself, on its own boards)
//   difficulty  normal or easy
//   mode        Run + Skate / Run only / Skate only
//   level       1-9 (level 9 only for players who have reached it themselves: it stays a secret for everyone else)
//   size        solo (one player) or team (two or more; local co-op is two kitties on one device)
// Every player keeps only their own best time on each board; a team's time counts for everyone in it. A board shows its
// fastest SHOW players, or only your starred friends ('friends': the friend ids the client sends) or the members of a
// group you're in (a name and a join code; anyone with the code can join, except players its owner removed). A group can
// be a fresh start: its board then only counts times set since it was made (or its owner restarted it), so friends can
// race from zero. No rewards come from these boards.
// Hell (config.js HELL_LEVELS) has a board too, per source, mode (Run only / Skate only) and size: how far a game got
// (the level, then how far along its map: the higher the better), every player keeping their best, with the game's
// total time: the same level and the same way along it, the quicker game first.
// Players are hashes of their account / browser ids (an account's own browser's times move to the account when it
// signs in), never sent anywhere; their friend ids (also hashes) are kept to find friends' times.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HELL_LEVELS, HELL_MODES } from '../public/js/shared/config.js';

const MODES = ['mixed', 'run', 'ice'];
const LEVELS = 9, SECRET_LEVEL = 9;
const HELL = 'h';   // a hell board's level
// a hell result as one number (the higher the better): level * 1001 + how far along its map (thousandths, 0..1000)
const hellScore = (level, far) => level * 1001 + Math.max(0, Math.min(1000, Math.round(far * 1000)));
const isHellKey = (bk) => bk.split(':')[2] === HELL;
// a board's order: fastest first, or (hell) furthest first, then the quickest game; ties: whoever got there first.
// Rows: [player key, time / score, at, team, (hell) the game's total time, run]. run: the clear / game a team's times
// came from (one id for all of them), so the board shows a team's time once, with everyone in it (query: slots)
const RUN_ID = /^[a-z0-9:-]{1,40}$/i;
const runOf = (ev) => (ev && typeof ev.run === 'string' && RUN_ID.test(ev.run) ? ev.run : '');
// two rows from the same clear: the same run, or (times from before runs were kept) the same time, team and game total,
// recorded within RUN_NEAR_MS of each other
const RUN_NEAR_MS = 5000;
const sameRun = (a, b) => a[3] > 1 && a[3] === b[3] && a[1] === b[1] && (a[5] || b[5] ? a[5] === b[5] : (a[4] || 0) === (b[4] || 0) && Math.abs(a[2] - b[2]) <= RUN_NEAR_MS);
const doneT = (r) => (r[4] > 0 ? r[4] : Infinity);
const cmpOf = (bk) => (isHellKey(bk) ? (x, y) => y[1] - x[1] || doneT(x) - doneT(y) || x[2] - y[2] : (x, y) => x[1] - y[1] || x[2] - y[2]);
const betterOn = (bk, a, b) => (isHellKey(bk) ? a > b : a < b);
// a hell entry [score, at, team, total time?] better than another (the same score: the quicker total time; none: last)
const hellBetter = (a, b) => !b || a[0] > b[0] || (a[0] === b[0] && (a[3] > 0 ? a[3] : Infinity) < (b[3] > 0 ? b[3] : Infinity));
const SHOW = 100;                       // a board's top list
const MIN_S = 5, MAX_S = 4 * 3600;      // a level's clear time (seconds)
const FRIENDS_MAX = 50;                 // fids a friends board looks at (the client keeps up to 50 starred friends)
const FIDS_MAX = 10;                    // friend ids kept per player (its newest browsers)
const GROUP_MAX = 100;                  // members per group
const GROUPS_PER_PLAYER = 10;
const GROUP_NAME_MAX = 24;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // join codes: no 0/O, 1/I
const CODE_LEN = 6;
const SAVE_DELAY_MS = 5000;
const FID = /^[\w-]{16}$/;
const PID = /^[a-z0-9]{24,40}$/;

// a board's key: 'o' / 'l' (online / local) + 'n' / 'e' (normal / easy), mode, level, 's' / 't' / 'c' (solo / team /
// a chained team: its own boards)
const boardKey = (b) => (b.local ? 'l' : 'o') + (b.easy ? 'e' : 'n') + ':' + b.mode + ':' + b.level + ':' + (b.chain ? 'c' : b.team ? 't' : 's');
function parseBoard(b) {
  if (!b || typeof b !== 'object' || !MODES.includes(b.mode)) return null;
  const chain = !!b.chain && !!b.team;   // (chained: a team's)
  if (b.level === HELL) return HELL_MODES.includes(b.mode) ? { local: !!b.local, easy: !!b.easy, mode: b.mode, level: HELL, team: !!b.team, chain } : null;
  const level = Number(b.level);
  if (!Number.isInteger(level) || level < 1 || level > LEVELS) return null;
  return { local: !!b.local, easy: !!b.easy, mode: b.mode, level, team: !!b.team, chain };
}
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanColor = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : 0xffb347);
const round1 = (t) => Math.round(t * 10) / 10;

function createLevelBoards(file) {
  // players: key -> { n: name, c: color, f: [friend ids], r9?: 1 (has reached level 9), at: last seen (ms),
  //                   b: { boardKey: [time, at (ms), team size] } }
  // groups: id -> { name, code, owner: player key, m: [player keys], at, out?: [removed player keys],
  //                 fresh?: since (ms): only times set from then on, kept in b: { boardKey: { player key: [time, at, team] } } }
  // runs: run id -> { k: [player keys] }: who played in a team's clear / game, so its slot keeps everyone (those with a
  // better time since, greyed); dropped once nobody's time on a board is from it any more (pruneRuns)
  let players = {}, groups = {}, runs = {}, meta = {};
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old && typeof old.players === 'object' && old.players) players = old.players;
    if (old && typeof old.groups === 'object' && old.groups) groups = old.groups;
    if (old && typeof old.runs === 'object' && old.runs) runs = old.runs;
    if (old && typeof old.meta === 'object' && old.meta) meta = old.meta;
  } catch { /* first run, or unreadable: start fresh */ }
  const byCode = new Map(Object.entries(groups).map(([id, g]) => [g.code, id]));
  let saveT = null;
  const tops = new Map();   // boardKey -> sorted [[key, time, at, team]] (all of a board's players), dropped on change

  function pruneRuns() {
    const used = new Set();
    for (const p of Object.values(players)) for (const v of Object.values(p.b || {})) if (v && v[4]) used.add(v[4]);
    for (const g of Object.values(groups)) for (const bb of Object.values(g.b || {})) for (const v of Object.values(bb)) if (v && v[4]) used.add(v[4]);
    for (const id of Object.keys(runs)) if (!used.has(id)) delete runs[id];
  }
  function save() {
    saveT = null;
    pruneRuns();
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ players, groups, runs, meta }), (err) => {
      if (err) { console.error('level boards save failed:', err.message); return; }
      fs.rename(tmp, file, (e) => { if (e) console.error('level boards save failed:', e.message); });
    });
  }
  function changed() { if (!saveT) saveT = setTimeout(save, SAVE_DELAY_MS); }
  function flush() {
    if (!saveT) return;
    clearTimeout(saveT); saveT = null;
    pruneRuns();
    try { fs.writeFileSync(file, JSON.stringify({ players, groups, runs, meta })); } catch (e) { console.error('level boards flush failed:', e.message); }
  }

  const hash = (s) => crypto.createHash('sha256').update('rkr-levels:' + s).digest('hex').slice(0, 20);
  // who: { acct?, pid?, seat? (a local game's second kitty: its own player on this browser), fid?, name?, color? }
  // -> the player's key: the account's, else this browser's (seat 1: the browser's second kitty)
  function keyOf(who) {
    if (!who) return '';
    const pid = typeof who.pid === 'string' && PID.test(who.pid) ? who.pid : '';
    if (who.seat) return pid ? 'p' + hash('p:' + pid + ':' + who.seat) : '';
    if (who.acct) return 'a' + hash('a:' + who.acct);
    return pid ? 'p' + hash('p:' + pid) : '';
  }
  // an account's hell results on the boards (its own, and its browsers' from before it signed in there): [{ local, easy,
  // mode, level (the furthest hell level), escaped (all of hell cleared) }] (accounts.js backfillHell)
  function hellResults(sub, pids = []) {
    const keys = [sub && 'a' + hash('a:' + sub), ...pids.filter((x) => typeof x === 'string' && PID.test(x)).map((x) => 'p' + hash('p:' + x))].filter(Boolean);
    const out = [];
    for (const k of keys) {
      const p = players[k];
      if (!p || !p.b) continue;
      for (const [bk, e] of Object.entries(p.b)) {
        if (!isHellKey(bk) || !Array.isArray(e)) continue;
        const [src, mode] = bk.split(':'), score = e[0] | 0, level = Math.floor(score / 1001), far = score % 1001;
        out.push({ local: src[0] === 'l', easy: src[1] === 'e', mode, level, escaped: far >= 1000 });
      }
    }
    return out;
  }
  // an account playing in a browser that has times of its own: they move to the account (each board's better time)
  function adopt(who, key) {
    if (!who || !who.acct || who.seat || !key.startsWith('a')) return;
    const pid = typeof who.pid === 'string' && PID.test(who.pid) ? who.pid : '';
    const pk = pid && 'p' + hash('p:' + pid), g = pk && players[pk];
    if (!g) return;
    const a = (players[key] ||= { n: g.n, c: g.c, f: [], b: {}, at: g.at });
    for (const [bk, v] of Object.entries(g.b || {})) if (!a.b[bk] || (isHellKey(bk) ? hellBetter(v, a.b[bk]) : betterOn(bk, v[0], a.b[bk][0]))) { a.b[bk] = v; tops.delete(bk); }
    if (g.r9) a.r9 = 1;
    for (const f of g.f || []) addFid(a, f);
    for (const gr of Object.values(groups)) {
      const i = gr.m.indexOf(pk);
      if (i >= 0) { if (gr.m.includes(key)) gr.m.splice(i, 1); else gr.m[i] = key; }
      if (gr.owner === pk) gr.owner = key;
      if (gr.out) gr.out = gr.out.map((k) => (k === pk ? key : k));
      if (gr.b) for (const [bk, t] of Object.entries(gr.b)) if (t[pk]) { if (!t[key] || (isHellKey(bk) ? hellBetter(t[pk], t[key]) : betterOn(bk, t[pk][0], t[key][0]))) t[key] = t[pk]; delete t[pk]; }
    }
    delete players[pk];
    changed();
  }
  function addFid(p, f) {
    if (!f || !FID.test(f)) return;
    p.f = (p.f || []).filter((x) => x !== f);
    p.f.unshift(f);
    if (p.f.length > FIDS_MAX) p.f.length = FIDS_MAX;
  }
  // the player's record (made on first use when make); its name, colour and friend id brought up to date
  function playerOf(who, make) {
    const key = keyOf(who);
    if (!key) return null;
    adopt(who, key);
    let p = players[key];
    if (!p) {
      if (!make) return { key, p: null };
      p = players[key] = { n: cleanName(who.name) || 'Kitty', c: cleanColor(who.color), f: [], b: {}, at: Date.now() };
    }
    if (make) {
      const n = cleanName(who.name);
      if (n) p.n = n;
      if (Number.isInteger(who.color)) p.c = cleanColor(who.color);
      if (!who.seat) addFid(p, who.fid);
      p.at = Date.now();
    }
    return { key, p };
  }

  // a hell game's end (game over, or its last level won; easy hell: each wipe too): ev = { local, easy, mode, level,
  // far (0..1), team (players in the game), time }; true when it's a new best
  function recordHell(who, ev) {
    const b = parseBoard({ local: !!(ev && ev.local), easy: !!(ev && ev.easy), mode: ev && ev.mode, level: HELL, team: !!(ev && ev.team > 1), chain: !!(ev && ev.chain) });
    const level = Number(ev && ev.level), far = Number(ev && ev.far);
    if (!b || !Number.isInteger(level) || level < 1 || level > HELL_LEVELS || !(far >= 0 && far <= 1)) return false;
    const me = playerOf(who, true);
    if (!me) return false;
    const { key, p } = me, score = hellScore(level, far), team = Math.max(1, Math.min(99, ev.team | 0 || 1));
    joinRun({ team, run: ev.run }, key);
    // the game's total time (seconds; at least a few per level cleared)
    const t = Number(ev.time);
    const time = t >= Math.max(1, (level - 1 + (far >= 1 ? 1 : 0)) * MIN_S) && t <= 1000 * 3600 ? round1(t) : 0;
    const entry = entryOf(score, { team, run: ev.run }, time);
    const bk = boardKey(b), had = p.b[bk];
    changed();
    for (const g of Object.values(groups)) {
      if (!g.fresh || !g.m.includes(key)) continue;
      const gb = (g.b ||= {})[bk] ||= {};
      if (hellBetter(entry, gb[key])) gb[key] = entry;
    }
    if (!hellBetter(entry, had)) return false;
    keepOldRun(bk, key, had);
    p.b[bk] = entry;
    tops.delete(bk);
    return true;
  }
  // a cleared level: ev = { local, easy, mode, level, time (s), team (players in the game) }; true when it's a new best
  // a board entry: [time / score, at, team, (hell) total time or 0, run?]
  // (ev.order: its place in the team's list, a ms each: the best scorer named first)
  const entryOf = (v, ev, total) => { const run = ev.team > 1 ? runOf(ev) : ''; return [v, Date.now() + Math.max(0, Math.min(99, ev.order | 0)), Math.max(1, Math.min(99, ev.team | 0 || 1)), ...(total || run ? [total || 0] : []), ...(run ? [run] : [])]; };
  // a team's run: this player was in it (whether or not it's their best)
  // (vs: a versus game, marked; tm: each one's team's place, for the board's │ between teams)
  const joinRun = (ev, key) => {
    const run = ev.team > 1 ? runOf(ev) : '';
    if (!run || !key) return;
    const r = runs[run] ||= { k: [] };
    if (ev.vs === true) { r.vs = 1; if (Number.isInteger(ev.tm) && ev.tm >= 0 && ev.tm < 99) (r.tm ||= {})[key] = ev.tm; }
    if (!r.k.includes(key) && r.k.length < 99) r.k.push(key);
  };
  // An old team time (from before runs kept their players) that this player is leaving for a faster one: its slot gets a
  // run with everyone still in it and this player, so they stay in it (greyed) instead of turning into a count (+1)
  function keepOldRun(bk, key, had) {
    if (!Array.isArray(had) || had[4] || !(had[2] > 1)) return;
    const mates = Object.entries(players).filter(([k, p]) => {
      const v = k !== key && p.b && p.b[bk];
      return Array.isArray(v) && !v[4] && v[2] === had[2] && v[0] === had[0] && (v[3] || 0) === (had[3] || 0) && Math.abs(v[1] - had[1]) <= RUN_NEAR_MS;
    });
    if (!mates.length) return;
    const id = 'old' + hash(bk + ':' + key + ':' + had[1]).slice(0, 12);
    for (const [, p] of mates) { const v = p.b[bk]; v[3] = v[3] || 0; v[4] = id; }
    runs[id] = { k: [...mates.map(([k]) => k), key] };
  }
  // Once (meta.oldRuns, again as 2 for those who left a slot since): the team times from before runs kept their players. A team whose slot is missing players (they
  // have a faster time since, so their entry here moved) gets them back where another level board of the same kind
  // (online / local, normal / easy, mode, team) shows them in one team with everyone still in this slot: those join the
  // slot's run (greyed, they have better times); anyone it can't be sure of stays a count (+N). Not hell (one board).
  function linkOldRuns() {
    if (meta.oldRuns >= 2) return;
    meta.oldRuns = 2;
    const teams = new Map();   // board key -> [{ keys, rows: [[key, entry]], v, at, team, total }] (old team times, one per clear)
    const near = (a, b) => a.team === b[2] && a.v === b[0] && (a.total || 0) === (b[3] || 0) && Math.abs(a.at - b[1]) <= RUN_NEAR_MS;
    for (const [k, p] of Object.entries(players)) for (const [bk, v] of Object.entries(p.b || {})) {
      if (!bk.endsWith(':t') || isHellKey(bk) || !Array.isArray(v) || v[4] || !(v[2] > 1)) continue;
      const L = teams.get(bk) || teams.set(bk, []).get(bk);
      const t = L.find((x) => near(x, v));
      if (t) { t.keys.add(k); t.rows.push([k, v]); } else L.push({ keys: new Set([k]), rows: [[k, v]], v: v[0], at: v[1], team: v[2], total: v[3] || 0 });
    }
    let linked = 0;
    for (const [bk, L] of teams) {
      const [src, mode] = bk.split(':'), better = (x, y) => x < y;   // (level boards: the quicker time)
      for (const t of L) {
        if (t.keys.size >= t.team) continue;
        const found = new Set();
        for (const [bk2, L2] of teams) {
          if (bk2 === bk || bk2.split(':')[0] !== src || bk2.split(':')[1] !== mode) continue;
          for (const t2 of L2) {
            if (![...t.keys].every((k) => t2.keys.has(k))) continue;   // (everyone still in this slot, in one team there)
            for (const k of t2.keys) {
              const mine = players[k] && players[k].b && players[k].b[bk];
              if (!t.keys.has(k) && mine && better(mine[0], t.v)) found.add(k);   // (they're not here: their time here is faster)
            }
          }
        }
        const extra = [...found].slice(0, t.team - t.keys.size);
        if (!extra.length) continue;
        const id = 'old' + hash(bk + ':' + [...t.keys].sort().join(',') + ':' + t.at).slice(0, 12);
        for (const [, v] of t.rows) { v[3] = v[3] || 0; v[4] = id; }
        runs[id] = { k: [...t.keys, ...extra] };
        linked++;
      }
    }
    if (linked) { tops.clear(); changed(); }
    return linked;
  }

  function record(who, ev) {
    if (ev && ev.level === HELL) return false;
    const b = parseBoard({ ...ev, team: ev && ev.team > 1 });
    const time = +(ev && ev.time);
    if (!b || !(time >= MIN_S && time <= MAX_S)) return false;
    const me = playerOf(who, true);
    if (!me) return false;
    const { key, p } = me;
    joinRun(ev, key);
    if (b.level === SECRET_LEVEL) p.r9 = 1;
    const bk = boardKey(b), had = p.b[bk];
    changed();
    // fresh-start groups keep their own bests (any time from their start on, even when it isn't the player's best ever)
    for (const g of Object.values(groups)) {
      if (!g.fresh || !g.m.includes(key)) continue;
      const gb = (g.b ||= {})[bk] ||= {}, mine = gb[key];
      if (!mine || round1(time) < mine[0]) gb[key] = entryOf(round1(time), ev, 0);
    }
    if (had && had[0] <= round1(time)) return false;
    keepOldRun(bk, key, had);
    p.b[bk] = entryOf(round1(time), ev, 0);
    tops.delete(bk);
    return !!key;
  }
  // reached the secret level (its tab shows from then on)
  function reach(who) {
    const me = playerOf(who, true);
    if (me && !me.p.r9) { me.p.r9 = 1; changed(); }
  }
  const can9 = (who) => { const me = playerOf(who, false); return !!(me && me.p && me.p.r9); };
  // played level 9 before these boards knew (index.js: the account's stats, or the browser says it saw it): from now on
  // it's known here too
  let reachedBefore = () => false;
  const setReachedBefore = (fn) => { reachedBefore = fn; };

  function sorted(bk) {
    let L = tops.get(bk);
    if (L) return L;
    L = [];
    for (const [k, p] of Object.entries(players)) { const v = p.b && p.b[bk]; if (v) L.push([k, v[0], v[1], v[2], v[3], v[4]]); }
    L.sort(cmpOf(bk));
    tops.set(bk, L);
    return L;
  }
  // the swag number of a player (its key) -> cents, or 0 (index.js: accounts whose number shows); on the board on hover
  let paidOf = () => 0;
  const setPaid = (fn) => { paidOf = fn; };
  const acctKey = (sub) => 'a' + hash('a:' + sub);
  const row = (r, me) => {
    const p = players[r[0]], paid = r[0][0] === 'a' ? paidOf(r[0]) : 0;
    return { name: p.n, color: p.c, time: r[1], at: new Date(r[2]).toISOString(), team: r[3], ...(r[4] > 0 ? { total: r[4] } : {}), ...(paid ? { paid } : {}), ...(r[0] === me ? { me: true } : {}) };
  };

  // a board: q = { board: { local, easy, mode, level, team }, scope: 'all' | 'friends' | 'group', fids: [...], group: id }
  // -> { board, scope, group?, rows: [...] (rank order), me: { rank, time } | null, n (players on it), can9 }
  function query(who, q) {
    const b = parseBoard(q && q.board);
    let me = playerOf(who, false);
    if (!(me && me.p && me.p.r9) && reachedBefore(who)) { reach(who); me = playerOf(who, false); }
    const key = me ? me.key : '', mine = me && me.p;
    const out = { can9: !!(mine && mine.r9) };
    if (!b) return { ...out, err: 'No such board.' };
    if (b.level === SECRET_LEVEL && !out.can9) return { ...out, err: 'No such board.' };   // (not a word about it)
    const bk = boardKey(b);
    let L = sorted(bk);
    const scope = q.scope === 'friends' || q.scope === 'group' ? q.scope : 'all';
    if (scope === 'friends') {
      const fids = new Set((Array.isArray(q.fids) ? q.fids : []).slice(0, FRIENDS_MAX).filter((f) => typeof f === 'string' && FID.test(f)));
      L = L.filter((r) => r[0] === key || (players[r[0]].f || []).some((f) => fids.has(f)));
    } else if (scope === 'group') {
      const g = groups[q.group];
      if (!g || !key || !g.m.includes(key)) return { ...out, err: 'You are not in that group.' };
      const m = new Set(g.m);
      if (g.fresh) {   // (its own times, since its start)
        L = Object.entries((g.b && g.b[bk]) || {}).filter(([k]) => m.has(k) && players[k]).map(([k, v]) => [k, v[0], v[1], v[2], v[3], v[4]]);
        L.sort(cmpOf(bk));
      } else L = L.filter((r) => m.has(r[0]));
    }
    // slots: a team's rows from the same clear as one (one rank, everyone in it); a row: its first member, with the
    // rest in its team list (older clients show the first), in the order they were recorded (the best scorer first:
    // index.js). Its players with a better time since keep their place, greyed (gone): the slot stays while one of them
    // still has it
    const slots = [];
    for (const r of L) { const s = slots[slots.length - 1]; if (s && sameRun(s[0], r)) s.push(r); else slots.push([r]); }
    const at = key ? slots.findIndex((s) => s.some((r) => r[0] === key)) : -1;
    const slotRow = (s) => {
      const vsRun = s[0][5] && runs[s[0][5]] && runs[s[0][5]].vs, first = { ...row(s[0], key), ...(vsRun ? { vs: 1 } : {}) };
      const here = new Set(s.map((r) => r[0])), gone = ((s[0][5] && runs[s[0][5]] && runs[s[0][5]].k) || []).filter((k) => !here.has(k) && players[k]);
      // (a team bigger than the players known for it: a run from before runs kept their players, or one of them with a
      // better time since that the board can't name any more: the rest as a count)
      const more = Math.max(0, (s[0][3] | 0) - s.length - gone.length);
      if (s.length + gone.length < 2 && !more) return first;
      const rowOf = new Map(s.map((r) => [r[0], r])), ks = (s[0][5] && runs[s[0][5]] && runs[s[0][5]].k) || [];
      const keys = [...ks.filter((k) => rowOf.has(k) || gone.includes(k)), ...s.map((r) => r[0]).filter((k) => !ks.includes(k))];
      const tmOf = (k) => { const t = s[0][5] && runs[s[0][5]] && runs[s[0][5]].tm; return t && t[k] != null ? { tm: t[k] } : {}; };   // (versus: its team's place)
      const team = keys.map((k) => {
        if (!rowOf.has(k)) return { name: players[k].n, color: players[k].c, gone: true, ...(k === key ? { me: true } : {}), ...tmOf(k) };
        const x = row(rowOf.get(k), key);
        return { name: x.name, color: x.color, ...(x.paid ? { paid: x.paid } : {}), ...(x.me ? { me: true } : {}), ...tmOf(k) };
      });
      return { ...first, members: team, ...(more ? { more } : {}), ...(team.some((x) => x.me && !x.gone) ? { me: true } : {}) };
    };
    const mineRow = at >= 0 ? slots[at].find((r) => r[0] === key) : null;
    return {
      ...out, board: b, scope, ...(scope === 'group' ? { group: q.group } : {}),
      rows: slots.slice(0, SHOW).map(slotRow), n: L.length,
      me: mineRow ? { rank: at + 1, time: mineRow[1], ...(mineRow[4] > 0 ? { total: mineRow[4] } : {}) } : null,
    };
  }

  // ---- groups
  const memberTok = (id, k) => crypto.createHash('sha256').update('rkr-member:' + id + ':' + k).digest('hex').slice(0, 12);
  const groupInfo = (id, key) => {
    const g = groups[id], own = g.owner === key;
    return {
      id, name: g.name, code: g.code, n: g.m.length, owner: own, ...(g.fresh ? { fresh: new Date(g.fresh).toISOString() } : {}),
      // (its owner sees who is in it, to remove someone)
      ...(own ? { members: g.m.map((k) => ({ t: memberTok(id, k), name: (players[k] && players[k].n) || 'Kitty', ...(k === key ? { me: true } : {}) })) } : {}),
    };
  };
  function groupsOf(who) {
    const key = keyOf(who);
    adopt(who, key);
    return key ? Object.keys(groups).filter((id) => groups[id].m.includes(key)).map((id) => groupInfo(id, key)) : [];
  }
  function newCode() {
    for (;;) {
      let c = '';
      for (const x of crypto.randomBytes(CODE_LEN)) c += CODE_ABC[x % CODE_ABC.length];
      if (!byCode.has(c)) return c;
    }
  }
  function createGroup(who, name, fresh) {
    const me = playerOf(who, true);
    if (!me) return { err: 'Could not make a group right now.' };
    const n = cleanName(name).slice(0, GROUP_NAME_MAX);
    if (!n) return { err: 'Give your group a name.' };
    if (groupsOf(who).length >= GROUPS_PER_PLAYER) return { err: `You can be in ${GROUPS_PER_PLAYER} groups at most. Leave one first.` };
    const id = crypto.randomBytes(6).toString('hex'), code = newCode();
    groups[id] = { name: n, code, owner: me.key, m: [me.key], at: Date.now(), ...(fresh ? { fresh: Date.now(), b: {} } : {}) };
    byCode.set(code, id);
    changed();
    return { group: groupInfo(id, me.key) };
  }
  function joinGroup(who, code) {
    const id = byCode.get(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!id) return { err: 'No group has that code.' };
    const me = playerOf(who, true);
    if (!me) return { err: 'Could not join right now.' };
    const g = groups[id];
    if (g.m.includes(me.key)) return { group: groupInfo(id, me.key) };
    if ((g.out || []).includes(me.key)) return { err: 'You can\'t join that group.' };
    if (g.m.length >= GROUP_MAX) return { err: 'That group is full.' };
    if (groupsOf(who).length >= GROUPS_PER_PLAYER) return { err: `You can be in ${GROUPS_PER_PLAYER} groups at most. Leave one first.` };
    g.m.push(me.key);
    changed();
    return { group: groupInfo(id, me.key) };
  }
  // leave a group (the last one out closes it; its owner leaving hands it to the longest member)
  function leaveGroup(who, id) {
    const key = keyOf(who), g = groups[id];
    if (!key || !g || !g.m.includes(key)) return {};
    g.m = g.m.filter((k) => k !== key);
    if (!g.m.length) { byCode.delete(g.code); delete groups[id]; } else if (g.owner === key) g.owner = g.m[0];
    changed();
    return {};
  }

  // the owner: remove a member (it can't join again with the code), or restart the group's board fresh (from now on)
  function removeMember(who, id, tok) {
    const key = keyOf(who), g = groups[id];
    if (!g || !key || g.owner !== key) return { err: 'Only the group\'s owner can do that.' };
    const k = g.m.find((x) => memberTok(id, x) === tok);
    if (!k || k === key) return {};
    g.m = g.m.filter((x) => x !== k);
    (g.out ||= []).push(k);
    if (g.out.length > 500) g.out.shift();
    if (g.b) for (const bk of Object.keys(g.b)) delete g.b[bk][k];
    changed();
    return {};
  }
  function restartGroup(who, id) {
    const key = keyOf(who), g = groups[id];
    if (!g || !key || g.owner !== key) return { err: 'Only the group\'s owner can do that.' };
    g.fresh = Date.now(); g.b = {};
    changed();
    return {};
  }

  linkOldRuns();
  return { setPaid, setReachedBefore, acctKey, record, recordHell, hellResults, linkOldRuns, reach, can9, query, groupsOf, createGroup, joinGroup, leaveGroup, removeMember, restartGroup, flush, keyOf, boardKey, MIN_S, MAX_S, SECRET_LEVEL, LEVELS, HELL };
}

export { createLevelBoards, parseBoard, hellScore };
