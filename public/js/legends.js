// Legends board: the teams that beat Run Kitty Run, with one line per kitty. Only finishers see it: online winners get
// it from the server over ws ('legends', live 'legend' updates) and sign over ws; offline (solo / local co-op) winners
// read it with GET /api/legends and sign with POST /api/legends (one line per local kitty). Either way lines can be
// changed for 15 minutes after the win. Opened from the victory screen (and, while an online winner can still sign,
// from a small button in the lobby), and by anyone from the main menu (showPublic: read only, GET /api/legends). One tab
// per mode. All player text goes in with textContent; the apps mask it like chat (net.js).
// FASTEST 100 is six lists (online / local games, solo / team / chained: the server keeps 100 each, this splits them by
// their kind); LATEST and FIRST 100 show chained games with the others, marked ⛓. LEVEL TIMES: every level's fastest
// clears (server/levelboards.js, POST /api/levels: no game connection needed): normal / easy, solo / team / chained,
// online / local, everyone or your starred friends or a group (made here, joined with a code). Level 9's board shows
// only once the server knows you have reached it (can9).
import { apiUrl, NATIVE } from './platform.js';
import { cleanForApp, progressId } from './net.js';
import { TOUCH } from './device.js';
import { fmtNum } from './account.js';

const MAX = 140;
const MODES = { mixed: 'Run + Skate', run: 'Run only', ice: 'Skate only' };

const CSS = `
.rkg-wrap{position:absolute;inset:0;z-index:45;display:flex;align-items:center;justify-content:flex-end;pointer-events:none;
  padding:max(14px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));}
.rkg-box{pointer-events:auto;position:relative;width:100%;max-width:480px;max-height:100%;height:min(820px,100%);display:flex;   /* (one height: the title stays put whatever the tab shows) */flex-direction:column;gap:10px;padding:18px 18px 14px;
  border-radius:26px;background:linear-gradient(160deg,rgba(52,30,96,.94),rgba(26,12,52,.94));border:3px solid rgba(255,215,100,.75);
  box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 40px rgba(255,200,80,.25),inset 0 1px 0 rgba(255,255,255,.35);animation:rkr-cardin .4s cubic-bezier(.2,1.4,.4,1);
  user-select:text;-webkit-user-select:text;}
.rkg-box h2{margin:0;text-align:center;font-weight:900;font-size:clamp(26px,4vw,38px);line-height:1;color:#ffe27a;-webkit-text-stroke:2px #3a1650;paint-order:stroke fill;
  text-shadow:0 4px 0 #3a1650,0 0 26px rgba(255,200,80,.7);}
.rkg-sub{text-align:center;font-weight:700;font-size:14px;color:#efe7ff;opacity:.85;}
.rkg-x{position:absolute;right:10px;top:8px;width:38px;height:38px;border-radius:12px;border:2px solid rgba(255,255,255,.25);background:rgba(0,0,0,.25);
  color:#fff;font:inherit;font-weight:900;font-size:20px;line-height:1;cursor:pointer;}
.rkg-x:hover{border-color:rgba(255,255,255,.6);}
.rkg-sign{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:16px;background:rgba(255,210,80,.1);border:2px solid rgba(255,210,80,.45);}
.rkg-row{display:flex;gap:8px;align-items:center;}
.rkg-in{flex:1;min-width:0;font:inherit;font-weight:700;font-size:16px;padding:9px 12px;border-radius:12px;border:2px solid rgba(255,255,255,.3);
  background:rgba(10,4,30,.6);color:#fff;outline:none;}
.rkg-in:focus{border-color:#ffcf5a;}
.rkg-go{font-size:16px !important;padding:9px 16px !important;flex:none;}
.rkg-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:800;opacity:.75;}
.rkg-msg.rkg-err{color:#ff8fa3;opacity:1;}
.rkg-msg.rkg-ok{color:#9dff7a;opacity:1;}
.rkg-who{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;font-size:14px;}
.rkg-list{flex:1 1 auto;min-height:60px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px;touch-action:pan-y;-webkit-overflow-scrolling:touch;}
.rkg-card{padding:9px 12px;border-radius:16px;background:rgba(0,0,0,.24);border:2px solid rgba(255,255,255,.12);}
.rkg-card.rkg-mine{border-color:rgba(255,215,100,.8);background:rgba(255,210,80,.08);}
.rkg-card .rkg-gone{opacity:.38;filter:grayscale(.7);}
.rkg-head{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:12px;font-weight:900;letter-spacing:.06em;color:#ffcf5a;margin-bottom:4px;}
.rkg-head span{opacity:.85;}
.rkg-head .rkg-you{background:#ff5c93;color:#fff;border-radius:6px;padding:0 6px;letter-spacing:.1em;opacity:1;}
.rkg-line{font-weight:700;font-size:14.5px;line-height:1.4;color:#f4eeff;overflow-wrap:anywhere;margin:2px 0;}
.rkg-line q{font-style:italic;quotes:"\\201C" "\\201D";}
.rkg-n{font-weight:900;-webkit-text-stroke:3px #2b1840;paint-order:stroke fill;white-space:nowrap;}
.rkg-also{font-size:13px;font-weight:800;opacity:.85;margin-top:3px;}
.rkg-empty{text-align:center;font-weight:700;opacity:.7;padding:14px;}
.rkg-tabs{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;}
.rkg-tab{font:inherit;font-weight:900;font-size:13px;letter-spacing:.04em;cursor:pointer;color:#fff6d8;padding:6px 12px;border-radius:999px;
  border:2px solid rgba(255,255,255,.25);background:rgba(20,8,48,.55);}
.rkg-tab:hover{background:rgba(60,30,110,.75);}
.rkg-tab.rkg-on{border-color:#ffcf5a;background:rgba(255,207,90,.22);}
.rkg-tab small{font-size:11px;opacity:.75;margin-left:4px;}
.rkg-views{display:flex;gap:4px;justify-content:center;}
.rkg-view{font:inherit;font-weight:800;font-size:12px;letter-spacing:.06em;cursor:pointer;color:#efe7ff;padding:4px 10px;border-radius:8px;border:0;background:transparent;opacity:.7;}
.rkg-view.rkg-on{background:rgba(255,255,255,.14);opacity:1;}
.rkg-rank{display:flex;gap:10px;align-items:baseline;}
.rkg-no{flex:none;min-width:30px;font-weight:900;font-size:15px;color:#ffcf5a;}
.rkg-rank .rkg-body{flex:1;min-width:0;}
.rkg-close{align-self:center;font-size:16px !important;padding:8px 22px !important;}
.rkg-opts{display:flex;flex-direction:column;gap:6px;align-items:center;}
.rkg-opts:empty{display:none;}
.rkg-seg{display:inline-flex;border-radius:10px;overflow:hidden;border:2px solid rgba(255,255,255,.2);}
.rkg-seg button{font:inherit;font-weight:900;font-size:11.5px;letter-spacing:.05em;cursor:pointer;color:#efe7ff;padding:4px 9px;border:0;background:rgba(20,8,48,.5);opacity:.75;}
.rkg-seg button.rkg-on{background:rgba(255,207,90,.28);color:#fff6d8;opacity:1;}
.rkg-segs{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}
.rkg-lv{display:flex;gap:4px;flex-wrap:wrap;justify-content:center;align-items:center;}
.rkg-lv b{font-size:11px;letter-spacing:.08em;opacity:.7;margin-right:2px;}
.rkg-lv button{font:inherit;font-weight:900;font-size:13px;cursor:pointer;color:#fff6d8;width:30px;height:28px;border-radius:9px;border:2px solid rgba(255,255,255,.22);background:rgba(20,8,48,.55);}
.rkg-lv button.rkg-on{border-color:#ffcf5a;background:rgba(255,207,90,.25);}
.rkg-lv button.rkg-hell{width:auto;padding:0 8px;color:#ffb3a0;}
.rkg-lv button.rkg-hell.rkg-on{border-color:#ff6a3d;background:rgba(255,80,40,.28);color:#ffe2d8;}
/* a big team: its first names, then +N (hover / tap: everyone, in .rkg-pop beside it) */
.rkg-more{display:inline-block;padding:0 7px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-weight:900;font-size:12px;cursor:pointer;}
.rkg-more:hover,.rkg-more:focus,.rkg-more.rkg-open{background:rgba(255,207,90,.32);outline:none;}
.rkg-pop{position:fixed;z-index:10000;display:none;max-width:320px;padding:8px 10px;border-radius:12px;background:rgba(20,8,40,.96);color:#fff;
  font-family:"Baloo 2",Fredoka,"Trebuchet MS","Segoe UI",system-ui,sans-serif;
  border:2px solid rgba(255,207,90,.6);font-weight:800;font-size:13px;line-height:1.5;box-shadow:0 6px 18px rgba(0,0,0,.5);pointer-events:none;}
.rkg-pop .rkg-gone{opacity:.38;filter:grayscale(.7);}
/* a player's swag number: next to the name while hovered (tapped, on a touch screen) */
.rkg-paid{display:none;margin-left:6px;font-size:12px;font-weight:900;color:#ffd56b;background:rgba(20,8,40,.8);padding:1px 7px;border-radius:7px;
  vertical-align:1px;-webkit-text-stroke:0;font-variant-numeric:tabular-nums;white-space:nowrap;}
.rkg-who2{cursor:default;}
.rkg-who2:hover .rkg-paid,.rkg-who2.rkg-showpaid .rkg-paid{display:inline-block;}
.rkg-you2{text-align:center;font-weight:900;font-size:13px;color:#ffcf5a;}
.rkg-grp{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:16px;background:rgba(0,0,0,.22);border:2px solid rgba(255,255,255,.12);}
.rkg-grp h3{margin:0;font-size:14px;font-weight:900;letter-spacing:.06em;color:#ffcf5a;}
.rkg-grp .rkg-in{font-size:14px;padding:6px 10px;}
.rkg-gitem{display:flex;gap:8px;align-items:center;font-weight:800;font-size:14px;}
.rkg-gitem span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.rkg-member{padding-left:10px;font-size:13px;opacity:.9;}
.rkg-fresh{display:flex;gap:6px;align-items:center;font-weight:800;font-size:13px;cursor:pointer;}
.rkg-fresh input{width:16px;height:16px;accent-color:#ffcf5a;}
.rkg-gitem code{font-weight:900;letter-spacing:.12em;color:#9dff7a;user-select:all;-webkit-user-select:all;}
.rkg-small{font:inherit;font-weight:900;font-size:11.5px;cursor:pointer;color:#fff;padding:4px 9px;border-radius:8px;border:2px solid rgba(255,255,255,.25);background:rgba(20,8,48,.6);}
.rkg-fab{position:absolute;z-index:44;right:max(16px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));pointer-events:auto;cursor:pointer;
  font:inherit;font-weight:900;font-size:14px;letter-spacing:.04em;color:#2b1840;padding:8px 14px;border-radius:999px;border:0;
  background:linear-gradient(180deg,#fff3c4,#ffcf5a);box-shadow:0 4px 0 #3a1650,0 8px 18px rgba(0,0,0,.35);display:none;}
.rkg-fab.rkg-on{display:block;}
@media (max-width:760px){ .rkg-wrap{justify-content:center;} .rkg-box{max-width:none;} }
@media (max-height:500px){
  .rkg-box{padding:10px 12px 8px;gap:6px;border-radius:18px;}
  .rkg-box h2{font-size:24px;}
  .rkg-sub{display:none;}
  .rkg-sign{padding:6px 8px;gap:4px;}
  .rkg-in{font-size:15px;padding:6px 10px;}
  .rkg-close{display:none;}
  .rkg-line{font-size:13.5px;}
}
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const hex = (c) => (typeof c === 'number' ? '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0') : /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#ffffff');
const fmtTime = (t) => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return iso.slice(0, 10); }
}

// send(msg): ws send; isOnline(): connected to the server; reconnect(): reconnect now if the connection is down;
// onOpenChange(open): the board opened / closed
// friends(): the friend ids of the players starred in the recent players list (main.js); who(): { pid, acct } (this
// browser's progress id, the swag account's session token): whose times and groups
// a hell board's score (server/levelboards.js hellScore): level * 1001 + thousandths of the map -> "Level 12 · 34%"
// with the game's total time (seconds): "Level 12 · 34% · 41:20", or through all of it (100%): "ESCAPED · 3:05:12"
const fmtLong = (t) => { t = Math.floor(t); return (t >= 3600 ? Math.floor(t / 3600) + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') : Math.floor(t / 60)) + ':' + String(t % 60).padStart(2, '0'); };
const fmtHell = (s, total) => {
  s = Math.max(0, Math.round(s || 0));
  const time = total > 0 ? ' · ' + fmtLong(total) : '';
  return s % 1001 === 1000 ? 'ESCAPED' + time : 'Level ' + Math.floor(s / 1001) + ' · ' + Math.floor((s % 1001) / 10) + '%' + time;
};
const fmtLevel = (t) => { t = Math.max(0, Math.round((t || 0) * 10)) / 10; const m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0'); };
const LEVELS = 8, SECRET = 9;

function createLegends(root, { send, isOnline, reconnect, onOpenChange, friends, who, hellOpen }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  let wins = null;          // newest first, or null = not loaded
  // while this player may sign: online { id, text, until (performance.now ms) };
  // offline { offline: true, id, key (null until the first SIGN), ctx: { mode, runTime, time }, players: [{ name, color, text }], until }
  let can = null;
  let offline = false;      // the board of an offline win (HTTP)
  let loadErr = '';
  let wrap = null, refs = null;
  let tab = 'mixed';        // the mode whose legends show (a tab each)
  let view = 'latest';      // latest wins / the first 100 players / the 100 fastest games
  let lists = null;         // { firsts: { mode: [...] }, fastest: { mode: [...] } } (servers from 2026-10-14 on)
  let fast = { local: false, team: false, chain: false };   // FASTEST 100: which of its six lists
  // LEVEL TIMES: the board picked, what came back for it, this player's groups, level 9's board known to this player
  const lv = { level: 1, easy: false, team: false, chain: false, local: false, scope: 'all', group: null, groupsOpen: false };
  let lvData = null, lvAsked = '', lvErr = '', lvGroups = [], can9 = false, lvSeq = 0, grpMsg = '';
  const catOf = (f) => ({ local: !!f.kind, team: f.kind ? f.kind !== 'solo' : (f.team || []).length !== 1, chain: !!f.chain });
  const modeOf = (w) => (MODES[w && w.mode] ? w.mode : 'mixed');

  const fab = el('button', 'rkg-fab', '📜 LEGENDS BOARD');
  fab.addEventListener('click', () => open());
  root.appendChild(fab);

  const canSign = () => !!can && performance.now() < can.until;

  // ---- data ----
  function onBoard(m) {   // ws 'legends': the board plus this player's own slot
    wins = Array.isArray(m.wins) ? m.wins : [];
    if (m.firsts && m.fastest) lists = { firsts: m.firsts, fastest: m.fastest };
    can = m.can ? { id: m.can.id, text: m.can.text || '', until: performance.now() + (m.can.left || 0) } : null;
    offline = false;
    loadErr = '';
    render();
  }
  function onLegend(m) {  // ws 'legend': someone on a legend you're part of signed it
    if (!wins || !m.win) return;
    const i = wins.findIndex((w) => w.id === m.win.id);
    if (i >= 0) wins[i] = m.win; else wins.unshift(m.win);
    render();
  }
  function onSigned(m) {
    if (!refs || !refs.msg) return;
    refs.go.disabled = false;
    if (m.ok) {
      if (can) can.text = m.text || '';
      refs.msg.className = 'rkg-msg rkg-ok';
      refs.msg.textContent = m.text ? 'Signed! You can still change it.' : 'Your line is cleared.';
    } else {
      refs.msg.className = 'rkg-msg rkg-err';
      refs.msg.textContent = m.msg || 'Could not sign right now.';
      if (/closed/.test(m.msg || '')) { can = null; render(); }
    }
  }
  // ---- level boards (POST /api/levels)
  async function levelsApi(body) {
    const r = await fetch(apiUrl('/api/levels'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(who ? who() : {}), ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || '');
    return j;
  }
  const lvKey = () => JSON.stringify([tab, lv.level, lv.easy, lv.team, lv.chain, lv.local, lv.scope, lv.group]);
  // the hell board shows in Run only and Skate only, for a player with hell open there (another mode: back to level 1)
  const hellBoard = () => (tab === 'run' || tab === 'ice') && !!(hellOpen && hellOpen(tab));
  const fixHell = () => { if (lv.level === 'h' && !hellBoard()) lv.level = 1; };
  function askLevels() {
    fixHell();
    lvErr = '';
    lvAsked = lvKey();
    const fids = lv.scope === 'friends' ? (friends ? friends() : []) : undefined;
    levelsApi({ op: 'board', id: ++lvSeq, board: { mode: tab, level: lv.level, easy: lv.easy, team: lv.team, chain: lv.chain || undefined, local: lv.local }, scope: lv.scope, fids, group: lv.group })
      .then(onLevels)
      .catch((err) => { lvErr = err.message || 'The level times are out of reach right now (no connection?).'; render(); });
  }
  function groupApi(body) {
    levelsApi({ op: 'group', ...body }).then(onLevelGroup).catch((err) => { grpMsg = err.message || 'Could not reach the server, try again in a moment.'; render(); });
  }
  // a local game's level (main.js): { mode, level, time, easy, players } or { reached: 9, players }; resolves when sent
  const reportLocal = (m) => levelsApi({ op: 'local', ...m });
  function onLevels(m) {
    if (m.id !== lvSeq) return;   // (an older answer)
    can9 = !!m.can9;
    if (Array.isArray(m.groups)) lvGroups = m.groups;
    if (m.err) { lvData = null; lvErr = m.err; if (lv.scope === 'group') { lv.scope = 'all'; lv.group = null; } }
    else {
      const clean = (x) => ({ ...x, name: appClean({ entries: [{ name: x.name, text: '' }] }).entries[0].name });
      lvData = { ...m, rows: (Array.isArray(m.rows) ? m.rows : []).map((r) => (NATIVE ? { ...clean(r), ...(Array.isArray(r.members) ? { members: r.members.map(clean) } : {}) } : r)) };
    }
    render();
  }
  function onLevelGroup(m) {
    if (Array.isArray(m.groups)) lvGroups = m.groups;
    grpMsg = m.ok ? (m.act === 'create' && m.group ? 'Group made! Share its code: ' + m.group.code : m.act === 'join' && m.group ? 'You joined ' + m.group.name + '.'
      : m.act === 'restart' ? 'Fresh start! Only new times count from now on.' : m.act === 'remove' ? 'Removed.' : '') : m.msg || 'That didn\'t work, try again.';
    if (m.ok && m.group && m.act === 'join') { lv.scope = 'group'; lv.group = m.group.id; lv.groupsOpen = false; askLevels(); }
    if (m.ok && m.act === 'leave' && lv.scope === 'group' && !lvGroups.some((g) => g.id === lv.group)) { lv.scope = 'all'; lv.group = null; askLevels(); }
    render();
  }
  // the apps mask the lists' names and lines like chat too
  function maskLists(l) {
    if (!NATIVE) return l;
    for (const m of Object.keys(l.firsts || {})) l.firsts[m] = l.firsts[m].map((f) => { const w = appClean({ entries: [{ name: f.name, text: f.text }] }); return { ...f, name: w.entries[0].name, text: w.entries[0].text }; });
    for (const m of Object.keys(l.fastest || {})) l.fastest[m] = l.fastest[m].map((f) => ({ ...f, team: appClean({ entries: f.team }).entries }));
    return l;
  }
  const appClean = (w) => { const m = { t: 'legend', win: w }; if (NATIVE) cleanForApp(m); return m.win; }; // apps: mask like chat
  function putWin(w) {
    if (!w) return;
    w = appClean(w);
    if (!wins) wins = [];
    const i = wins.findIndex((q) => q.id === w.id);
    if (i >= 0) wins[i] = w; else wins.unshift(w);
  }
  // offline win (ctx: { mode, runTime, time, players: [{ name, color }] }): fetch the board; the kitties may sign it
  async function fetchOffline(ctx) {
    offline = true;
    can = ctx && Array.isArray(ctx.players) && ctx.players.length ? {
      offline: true, id: null, key: null, until: performance.now() + 15 * 60e3,
      ctx: { mode: ctx.mode, runTime: ctx.runTime, time: ctx.time, ...(ctx.chain ? { chain: true } : {}) },
      players: ctx.players.map((p) => ({ name: p.name, color: p.color, text: '' })),
    } : null;
    wins = null;
    loadErr = '';
    render();
    try {
      const r = await fetch(apiUrl('/api/legends'), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error();
      const msg = { t: 'legends', wins: Array.isArray(j.wins) ? j.wins : [] };
      if (NATIVE) cleanForApp(msg); // the apps mask names and lines like chat
      if (j.firsts && j.fastest) lists = maskLists({ firsts: j.firsts, fastest: j.fastest });
      if (offline) { const mine = can && can.id && wins && wins.find((w) => w.id === can.id); wins = msg.wins; if (mine) putWin(mine); }
    } catch {
      loadErr = 'The legends board is out of reach right now (no connection?).';
    }
    render();
  }

  // ---- panel ----
  function onKey(e) { // window, capture: Esc closes the board wherever the focus is (and goes no further)
    if (!wrap || e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation(); close();
  }
  function open() {
    if (wrap) { render(); return; }
    wrap = el('div', 'rkg-wrap');
    const box = el('div', 'rkg-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Legends board');
    box.tabIndex = -1;
    const x = el('button', 'rkg-x', '✕');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    const h = el('h2', null, 'LEGENDS BOARD');
    const sub = el('div', 'rkg-sub', 'Every team that beat Project: Run Kitty Run, in their own words.');
    const tabs = el('div', 'rkg-tabs');
    const views = el('div', 'rkg-views');
    const signSlot = el('div');
    const opts = el('div', 'rkg-opts');
    const list = el('div', 'rkg-list');
    const closeBtn = el('button', 'rkr-btn rkr-alt rkg-close', 'CLOSE');
    closeBtn.addEventListener('click', close);
    box.append(x, h, sub, tabs, views, opts, signSlot, list, closeBtn);
    wrap.appendChild(box);
    // typing must not move the kitty / trigger game keys (the board's own keys stop here, after the input saw them)
    wrap.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.addEventListener('keyup', (e) => e.stopPropagation());
    root.appendChild(wrap);
    refs = { box, sub, tabs, views, opts, signSlot, list, signKey: '' };
    // a winner sees the mode they just won first, everyone else Run + Skate
    const own = can && wins && wins.find((w) => w.id === can.id);
    tab = own ? modeOf(own) : can && can.ctx && MODES[can.ctx.mode] ? can.ctx.mode : 'mixed';
    window.addEventListener('keydown', onKey, true);
    fab.classList.remove('rkg-on');
    render();
    setTimeout(() => { if (refs) (refs.input && !TOUCH ? refs.input : box).focus({ preventScroll: true }); }, 30);
    if (onOpenChange) onOpenChange(true);
  }
  function close() {
    hidePop();
    if (!wrap) return;
    window.removeEventListener('keydown', onKey, true);
    wrap.remove();
    wrap = null; refs = null;
    if (onOpenChange) onOpenChange(false);
  }

  const oneLine = (v) => v.replace(/\s+/g, ' ').trim().slice(0, MAX);
  function setMsg(text, cls) { if (refs && refs.msg) { refs.msg.className = 'rkg-msg' + (cls ? ' rkg-' + cls : ''); refs.msg.textContent = text; } }

  // offline: first SIGN puts the win on the board (server returns id + key), later ones edit the lines
  async function signOffline(texts) {
    const c = can;
    const body = c.id
      ? { id: c.id, key: c.key, players: texts.map((text) => ({ text })) }
      : { ...c.ctx, pid: progressId() || undefined, players: c.players.map((p, i) => ({ name: p.name, color: p.color, text: texts[i] })) };   // (pid: who you are, for the firsts / fastest lists)
    let j = {};
    try {
      const r = await fetch(apiUrl('/api/legends'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.msg || 'Could not sign right now.');
    } catch (err) {
      if (refs && refs.go) refs.go.disabled = false;
      setMsg(err.message && !/fetch|network/i.test(err.message) ? err.message : 'Could not reach the board, try again in a moment.', 'err');
      if (/closed/.test(j.msg || '')) { can = null; render(); }
      return;
    }
    if (can !== c) return;
    if (j.id) { c.id = j.id; c.key = j.key; }
    if (Number.isFinite(j.left)) c.until = performance.now() + j.left;
    texts.forEach((t, i) => { c.players[i].text = t; });
    putWin(j.win);
    render();
    if (refs && refs.go) refs.go.disabled = false;
    setMsg(texts.some(Boolean) ? 'Signed! You can still change it.' : 'On the board!', 'ok');
  }

  function renderSign() {
    const key = canSign() ? 'sign:' + (can.offline ? 'offline:' + (can.id ? 'on' : 'new') : can.id) : 'none';
    if (key === refs.signKey) return;
    refs.signKey = key;
    refs.signSlot.textContent = '';
    refs.input = refs.go = refs.msg = null;
    if (key === 'none') return;
    // one input per kitty: online that's you; offline the local players (solo, or both co-op kitties on this device)
    const slots = can.offline ? can.players : [{ text: can.text }];
    const signed = can.offline ? !!can.id : !!can.text;
    const box = el('div', 'rkg-sign');
    const inputs = [];
    const go = el('button', 'rkr-btn rkg-go', signed ? 'UPDATE' : 'SIGN');
    slots.forEach((p, i) => {
      const row = el('div', 'rkg-row');
      if (slots.length > 1) {
        const n = el('span', 'rkg-n rkg-who', p.name);
        n.style.color = hex(p.color);
        row.appendChild(n);
      }
      const input = el('input', 'rkg-in');
      input.type = 'text';
      input.maxLength = MAX;
      input.placeholder = 'Leave your mark (1–2 sentences)';
      input.value = p.text || '';
      input.setAttribute('aria-label', slots.length > 1 ? `${p.name}'s line on the legends board` : 'Your line on the legends board');
      input.enterKeyHint = i === slots.length - 1 ? 'send' : 'next';
      inputs.push(input);
      row.appendChild(input);
      if (i === slots.length - 1) row.appendChild(go);
      box.appendChild(row);
    });
    const meta = el('div', 'rkg-meta');
    const msg = el('span', 'rkg-msg', slots.length > 1 ? 'One line each, signed with your kitties\' names' : can.offline ? `Signed as ${slots[0].name || 'you'}` : 'Signed with your kitty\'s name');
    const count = el('span', null, `${inputs[0].value.length} / ${MAX}`);
    meta.append(msg, count);
    box.appendChild(meta);
    refs.signSlot.appendChild(box);
    Object.assign(refs, { input: inputs[0], go, msg });
    inputs.forEach((input) => {
      const upd = () => { count.textContent = `${input.value.length} / ${MAX}`; };
      input.addEventListener('input', upd);
      input.addEventListener('focus', upd);
    });
    const submit = () => {
      if (!canSign()) { setMsg('The signing window for your win has closed.', 'err'); return; }
      const texts = inputs.map((x) => oneLine(x.value));
      go.disabled = true;
      setMsg('Signing…');
      if (can.offline) { signOffline(texts); return; }
      // the connection dropped (the victory party can be long): reconnect now and sign as soon as it is back. The
      // signing window belongs to this tab, so it is still there after the reconnect.
      if (!isOnline()) {
        setMsg('Reconnecting…');
        if (reconnect) reconnect();
        const t0 = performance.now();
        const wait = setInterval(() => {
          if (!refs || refs.go !== go || !canSign()) { clearInterval(wait); return; }   // (board closed / window over)
          if (isOnline()) { clearInterval(wait); setTimeout(() => { if (refs && refs.go === go && canSign()) sendSign(texts[0]); }, 400); return; }
          if (performance.now() - t0 > 30000) { clearInterval(wait); go.disabled = false; setMsg('Still not connected. Check your internet and press SIGN again.', 'err'); }
        }, 300);
        return;
      }
      sendSign(texts[0]);
    };
    const sendSign = (text) => {
      send({ t: 'sign', text });
      go.textContent = 'UPDATE';
      setTimeout(() => { go.disabled = false; }, 1500); // in case no reply comes back
    };
    go.addEventListener('click', submit);
    inputs.forEach((input, i) => input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i < inputs.length - 1) inputs[i + 1].focus(); else submit();
    }));
  }

  function renderTabs() {
    refs.tabs.textContent = '';
    for (const [id, label] of Object.entries(MODES)) {
      const n = wins ? wins.filter((w) => modeOf(w) === id).length : 0;
      const b = el('button', 'rkg-tab' + (id === tab ? ' rkg-on' : ''), label.toUpperCase());
      if (wins) b.appendChild(el('small', null, String(n)));
      b.addEventListener('click', () => { tab = id; refs.list.scrollTop = 0; if (view === 'levels') askLevels(); render(); });
      refs.tabs.appendChild(b);
    }
  }
  function renderViews() {
    refs.views.textContent = '';
    if (!lists && view !== 'levels') view = 'latest';
    for (const [id, label] of [['latest', 'LATEST'], ['firsts', 'FIRST 100'], ['fastest', 'FASTEST 100'], ['levels', 'LEVEL TIMES']]) {
      const b = el('button', 'rkg-view' + (id === view ? ' rkg-on' : ''), label);
      b.addEventListener('click', () => { view = id; refs.list.scrollTop = 0; if (id === 'levels' && lvAsked !== lvKey()) askLevels(); render(); });
      refs.views.appendChild(b);
    }
  }
  // a card's lines, the same on every view: each kitty's name first, then the line they wrote ("Name — “line”");
  // the ones who wrote nothing together on one line after them
  // a kitty's name in its colour; with a swag number, that shows next to it on hover / tap
  function nameEl(e) {
    const n = el('span', 'rkg-n', e.name);
    n.style.color = hex(e.color);
    if (!(e.paid > 0)) return n;
    const w = el('span', 'rkg-who2');
    w.append(n, el('span', 'rkg-paid', fmtNum(e.paid)));
    w.addEventListener('click', () => w.classList.toggle('rkg-showpaid'));
    return w;
  }
  // A big team's names (more than NAMES_MAX): the first ones, then +N; its hover (or a tap) shows everyone. The server
  // lists a team best scorer first (versus: the teams by points, tm their place: the winners shown, a │ between teams)
  const NAMES_MAX = 8, NAMES_LEAD = 4;
  function leadOf(list) {
    if (list.length <= NAMES_MAX) return list.length;
    if (list[0] && list[0].tm != null) { let n = 0; while (n < list.length && list[n].tm === list[0].tm) n++; return n; }
    return NAMES_LEAD;
  }
  const newTeam = (a, b) => !!a && !!b && a.tm != null && b.tm != null && a.tm !== b.tm;
  let popEl = null;
  function showPop(chip, list) {
    if (!popEl) { popEl = el('div', 'rkg-pop'); document.body.appendChild(popEl); }
    popEl.textContent = '';
    list.forEach((e, i) => {
      if (i) popEl.append(newTeam(list[i - 1], e) ? ' │ ' : ', ');
      const n = nameEl(e);
      if (e.gone) n.classList.add('rkg-gone');
      popEl.appendChild(n);
    });
    popEl.style.display = 'block';
    const r = chip.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
    popEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
    popEl.style.top = (r.bottom + h + 8 < innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
  }
  function hidePop() {
    if (popEl) popEl.style.display = 'none';
    for (const o of document.querySelectorAll('.rkg-more.rkg-open')) o.classList.remove('rkg-open');
  }
  function moreChip(list, hidden) {
    const c = el('span', 'rkg-more', '+' + hidden);
    c.tabIndex = 0;
    c.setAttribute('aria-label', hidden + ' more kitties: show everyone');
    c.addEventListener('mouseenter', () => showPop(c, list));
    c.addEventListener('mouseleave', () => { if (!c.classList.contains('rkg-open')) hidePop(); });
    c.addEventListener('focus', () => showPop(c, list));
    c.addEventListener('blur', () => hidePop());
    c.addEventListener('click', (e) => { e.stopPropagation(); const on = !c.classList.contains('rkg-open'); hidePop(); if (on) { c.classList.add('rkg-open'); showPop(c, list); } });
    return c;
  }
  document.addEventListener('click', () => { if (popEl && popEl.style.display === 'block') hidePop(); });
  function cardLines(card, entries) {
    const quiet = [];
    for (const e of entries) {
      if (!e || typeof e.name !== 'string') continue;
      if (!e.text) { quiet.push(e); continue; }
      const line = el('div', 'rkg-line');
      line.append(nameEl(e), ' — ', el('q', null, String(e.text)));
      card.appendChild(line);
    }
    if (quiet.length) {
      const line = el('div', 'rkg-line'), n = leadOf(quiet);
      quiet.slice(0, n).forEach((e, i) => {
        if (i) line.append(newTeam(quiet[i - 1], e) ? ' │ ' : ', ');
        line.appendChild(nameEl(e));
      });
      if (n < quiet.length) line.append(' ', moreChip(quiet, quiet.length - n));
      card.appendChild(line);
    }
  }
  // the first 100 players to beat this mode / its 100 fastest games (cards like LATEST's, their place first)
  function renderList(list) {
    let L = (lists[view] && lists[view][tab]) || [];
    if (view === 'fastest') L = L.filter((f) => { const c = catOf(f); return c.local === fast.local && c.chain === fast.chain && (c.chain || c.team === fast.team); });
    if (!L.length) { list.appendChild(el('div', 'rkg-empty', view === 'firsts' ? 'Nobody has beaten this mode yet. The first spot is waiting!' : 'No games on this list yet. The first one to win sets the record!')); return; }
    const mine = can && can.id;
    L.forEach((f, i) => {
      const card = el('div', 'rkg-card rkg-rank' + (f.win === mine ? ' rkg-mine' : ''));
      card.appendChild(el('div', 'rkg-no', '#' + (i + 1)));
      const body = el('div', 'rkg-body');
      const head = el('div', 'rkg-head');
      head.appendChild(el('span', null, fmtDate(f.at)));
      head.appendChild(el('span', null, (MODES[tab] || '') + (f.kind === 'solo' ? ' · solo' : f.kind === 'coop' ? ' · co-op' : '') + (f.vs ? ' · ⚔ versus' : '') + (f.chain ? ' · ⛓ chained' : '')));
      if (Number.isFinite(f.total)) head.appendChild(el('span', null, '⏱ ' + fmtTime(f.total)));
      body.appendChild(head);
      cardLines(body, view === 'firsts' ? [{ name: f.name, color: f.color, text: f.text, paid: f.paid }] : f.team || []);
      card.appendChild(body);
      list.appendChild(card);
    });
  }
  // a two-way switch ([a, b] labels; on: the second is picked), for the options rows
  function seg(a, b, on, set) {
    const w = el('div', 'rkg-seg');
    [a, b].forEach((label, i) => {
      const x = el('button', (i ? on : !on) ? 'rkg-on' : '', label);
      x.addEventListener('click', () => { if (!!i !== on) set(!!i); });
      w.appendChild(x);
    });
    return w;
  }
  // a three-way switch (labels; at: the one picked), for SOLO / TEAM / CHAINED
  function seg3(labels, at, set) {
    const w = el('div', 'rkg-seg');
    labels.forEach((label, i) => {
      const x = el('button', i === at ? 'rkg-on' : '', label);
      x.addEventListener('click', () => { if (i !== at) set(i); });
      w.appendChild(x);
    });
    return w;
  }
  const KINDS = ['SOLO', 'TEAM', '⛓ CHAINED'];
  const kindAt = (o) => (o.chain ? 2 : o.team ? 1 : 0);
  const setKind = (o, i) => { o.team = i > 0; o.chain = i === 2; };
  function renderOpts() {
    const o = refs.opts;
    o.textContent = '';
    if (view === 'fastest' && lists) {
      const segs = el('div', 'rkg-segs');
      segs.append(seg('ONLINE', 'LOCAL', fast.local, (v) => { fast.local = v; refs.list.scrollTop = 0; render(); }),
        seg3(KINDS, kindAt(fast), (i) => { setKind(fast, i); refs.list.scrollTop = 0; render(); }));
      o.appendChild(segs);
    }
    if (view !== 'levels') return;
    const pick = (fn) => () => { fn(); refs.list.scrollTop = 0; askLevels(); render(); };
    const lvRow = el('div', 'rkg-lv');
    lvRow.appendChild(el('b', null, 'LEVEL'));
    for (let n = 1; n <= (can9 ? SECRET : LEVELS); n++) {
      const b = el('button', n === lv.level ? 'rkg-on' : '', String(n));
      b.addEventListener('click', pick(() => { lv.level = n; }));
      lvRow.appendChild(b);
    }
    // hell's board (Run only / Skate only, once hell is open there): how far each player got
    if (hellBoard()) {
      const b = el('button', 'rkg-hell' + (lv.level === 'h' ? ' rkg-on' : ''), 'HELL');
      b.addEventListener('click', pick(() => { lv.level = 'h'; }));
      lvRow.appendChild(b);
    }
    const segs = el('div', 'rkg-segs');
    segs.append(seg('NORMAL', 'EASY', lv.easy, pick(() => { lv.easy = !lv.easy; })));
    segs.append(seg3(KINDS, kindAt(lv), (i) => pick(() => setKind(lv, i))()),
      seg('ONLINE', 'LOCAL', lv.local, pick(() => { lv.local = !lv.local; })));
    const scopes = el('div', 'rkg-segs');
    const sc = el('div', 'rkg-seg');
    const scope = (label, on, fn) => { const b = el('button', on ? 'rkg-on' : '', label); b.addEventListener('click', fn); sc.appendChild(b); };
    scope('EVERYONE', lv.scope === 'all' && !lv.groupsOpen, pick(() => { lv.scope = 'all'; lv.group = null; lv.groupsOpen = false; }));
    scope('FRIENDS', lv.scope === 'friends' && !lv.groupsOpen, pick(() => { lv.scope = 'friends'; lv.group = null; lv.groupsOpen = false; }));
    for (const g of lvGroups) scope(g.name.toUpperCase(), lv.scope === 'group' && lv.group === g.id && !lv.groupsOpen, pick(() => { lv.scope = 'group'; lv.group = g.id; lv.groupsOpen = false; }));
    scope('＋ GROUPS', lv.groupsOpen, () => { lv.groupsOpen = !lv.groupsOpen; grpMsg = ''; render(); });
    scopes.appendChild(sc);
    o.append(lvRow, segs, scopes);
  }
  // groups: make one (a fresh start or not), join one with a code, see your groups' codes, leave one; a group's owner
  // can remove players from it and restart its board fresh
  let grpOpen = null;   // the group whose players its owner is looking at
  function renderGroups(list) {
    const box = el('div', 'rkg-grp');
    box.appendChild(el('h3', null, 'YOUR GROUPS'));
    if (!lvGroups.length) box.appendChild(el('div', 'rkg-line', 'Make a group and share its code with your friends, or join theirs. Everyone in it sees the same board.'));
    for (const g of lvGroups) {
      const row = el('div', 'rkg-gitem');
      row.append(el('span', null, g.name + ' · ' + g.n + (g.n === 1 ? ' player' : ' players') + (g.fresh ? ' · new times since ' + fmtDate(g.fresh) : '')), el('code', null, g.code));
      if (g.owner) {
        const ppl = el('button', 'rkg-small', grpOpen === g.id ? 'DONE' : 'PLAYERS');
        ppl.addEventListener('click', () => { grpOpen = grpOpen === g.id ? null : g.id; render(); });
        row.appendChild(ppl);
      }
      const leave = el('button', 'rkg-small', 'LEAVE');
      leave.addEventListener('click', () => { leave.disabled = true; groupApi({ act: 'leave', id: g.id }); });
      row.appendChild(leave);
      box.appendChild(row);
      if (!g.owner || grpOpen !== g.id) continue;
      // the owner's tools: remove a player (they can't join again with the code), restart the board from now on
      for (const m of g.members || []) {
        const mr = el('div', 'rkg-gitem rkg-member');
        mr.appendChild(el('span', null, '· ' + m.name + (m.me ? ' (you)' : '')));
        if (!m.me) {
          const rm = el('button', 'rkg-small', 'REMOVE');
          rm.addEventListener('click', () => { rm.disabled = true; groupApi({ act: 'remove', id: g.id, member: m.t }); });
          mr.appendChild(rm);
        }
        box.appendChild(mr);
      }
      const rs = el('button', 'rkg-small', g.fresh ? 'RESTART FROM NOW' : 'FRESH START FROM NOW');
      rs.addEventListener('click', () => {
        if (rs.dataset.sure !== '1') { rs.dataset.sure = '1'; rs.textContent = 'SURE? CLEARS THE GROUP\'S TIMES'; return; }
        rs.disabled = true;
        groupApi({ act: 'restart', id: g.id });
      });
      const rrow = el('div', 'rkg-gitem rkg-member');
      rrow.append(el('span', null, 'Only times set from now on will count on this group\'s board.'), rs);
      box.appendChild(rrow);
    }
    const mk = (ph, btn, op, field, max) => {
      const row = el('div', 'rkg-row');
      const input = el('input', 'rkg-in');
      input.type = 'text'; input.maxLength = max; input.placeholder = ph;
      const go = el('button', 'rkg-small', btn);
      const submit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        go.disabled = true;
        groupApi({ act: op, [field]: v, ...(op === 'create' && lv.freshPick ? { fresh: true } : {}) });
      };
      go.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      row.append(input, go);
      return row;
    };
    const make = mk('New group name', 'MAKE', 'create', 'name', 24);
    // a fresh start: the group's board counts only times set after it's made
    const fresh = el('label', 'rkg-fresh');
    const cb = el('input');
    cb.type = 'checkbox'; cb.checked = !!lv.freshPick;
    cb.addEventListener('change', () => { lv.freshPick = cb.checked; });
    fresh.append(cb, ' Fresh start: only new times count (race from zero)');
    box.append(make, fresh, mk('Join with a code', 'JOIN', 'join', 'code', 8));
    if (grpMsg) box.appendChild(el('div', 'rkg-msg rkg-ok', grpMsg));
    list.appendChild(box);
  }
  function renderLevels(list) {
    if (lv.groupsOpen) { renderGroups(list); return; }
    if (!lvData || lvAsked !== lvKey()) { list.appendChild(el('div', 'rkg-empty', lvErr || 'Timing the kitties…')); return; }
    const rows = lvData.rows || [];
    const hell = lv.level === 'h', fmt = hell ? fmtHell : fmtLevel, icon = hell ? '🔥 ' : '⏱ ';
    if (!rows.length) {
      const fr = lv.scope === 'friends' && !(friends && friends().length);
      list.appendChild(el('div', 'rkg-empty', fr ? 'Star players in your recent players list (in a Multiplayer lobby) to race their times here.'
        : lv.scope === 'friends' ? `None of your friends has ${hell ? 'been to hell' : 'a time'} on this board yet.`
        : hell ? 'Nobody has been to hell on this board yet. How far can you get?' : 'No times on this board yet. Clear the level to set the first one!'));
      return;
    }
    // a card each, as on the other lists: its place, then the date, the team's size and the time over its names
    rows.forEach((r, i) => {
      const card = el('div', 'rkg-card rkg-rank' + (r.me ? ' rkg-mine' : ''));
      card.appendChild(el('div', 'rkg-no', '#' + (i + 1)));
      const body = el('div', 'rkg-body'), head = el('div', 'rkg-head');
      head.appendChild(el('span', null, fmtDate(r.at)));
      if (r.vs) head.appendChild(el('span', null, '⚔ versus'));   // (the team with the most points named first)
      if (lv.team && r.team > 1) head.appendChild(el('span', null, r.team + ' kitties'));
      head.appendChild(el('span', null, icon + fmt(r.time, r.total)));
      body.appendChild(head);
      // a team's time once, with everyone in it (members: the server joined their rows, best scorer first); those with a
      // faster time since greyed in their place; a big team its first names, then +N with everyone on hover / tap
      const ms = Array.isArray(r.members) && (r.members.length > 1 || r.more > 0) ? r.members : [r], lead = leadOf(ms);
      const line = el('div', 'rkg-line');
      ms.slice(0, lead).forEach((m, k) => {
        if (k) line.append(newTeam(ms[k - 1], m) ? ' │ ' : ', ');
        const n = nameEl(m);
        if (m.gone) { n.classList.add('rkg-gone'); n.title = 'Has a faster time since'; }
        line.appendChild(n);
      });
      if (lead < ms.length) line.append(' ', moreChip(ms, ms.length - lead));
      if (r.more > 0) {   // (teammates the board can't name: how many)
        const x = el('span', 'rkg-n rkg-gone', '+' + r.more);
        x.title = r.more === 1 ? 'One more kitty in this team' : r.more + ' more kitties in this team';
        line.append(', ', x);
      }
      body.appendChild(line);
      card.appendChild(body);
      list.appendChild(card);
    });
    if (lvData.me && !rows.some((r) => r.me)) list.appendChild(el('div', 'rkg-you2', 'You: #' + lvData.me.rank + ' · ' + icon + fmt(lvData.me.time, lvData.me.total)));
  }
  function render() {
    hidePop();
    if (refs && refs.list && !refs.list.popOff) { refs.list.popOff = true; refs.list.addEventListener('scroll', hidePop); }
    if (!refs) return;
    renderTabs();
    renderViews();
    renderOpts();
    renderSign();
    refs.sub.textContent = view === 'levels' ? 'The fastest clear of every level. Race everyone, your friends or your group.' : 'Every team that beat Project: Run Kitty Run, in their own words.';
    const list = refs.list;
    const top = list.scrollTop;
    list.textContent = '';
    if (view === 'levels') { renderLevels(list); list.scrollTop = top; return; }
    if (!wins) { list.appendChild(el('div', 'rkg-empty', loadErr || 'Unrolling the scroll…')); return; }
    if (view !== 'latest' && lists) { renderList(list); list.scrollTop = top; return; }
    const shown = wins.filter((w) => modeOf(w) === tab);
    if (!shown.length) {
      list.appendChild(el('div', 'rkg-empty', can ? 'No legends yet. Be the first team to sign!'
        : 'Currently no legends have made it all the way to the end, will you be the first?'));
      return;
    }
    const mine = can && can.id;
    for (const w of shown) {
      const card = el('div', 'rkg-card' + (w.id === mine ? ' rkg-mine' : ''));
      const head = el('div', 'rkg-head');
      head.appendChild(el('span', null, fmtDate(w.at)));
      head.appendChild(el('span', null, (MODES[w.mode] || 'Run Kitty Run') + (w.kind === 'solo' ? ' · solo' : w.kind === 'coop' ? ' · co-op' : '') + (w.vs ? ' · ⚔ versus' : '') + (w.chain ? ' · ⛓ chained' : '')));
      // the whole game's time (wins before 2026-10-14 only have the final level's)
      const tt = Number.isFinite(w.total) ? w.total : w.runTime;
      if (Number.isFinite(tt)) head.appendChild(el('span', null, '⏱ ' + fmtTime(tt)));
      if (w.id === mine) head.appendChild(el('span', 'rkg-you', 'YOUR TEAM'));
      card.appendChild(head);
      cardLines(card, Array.isArray(w.entries) ? w.entries : []);
      list.appendChild(card);
    }
    list.scrollTop = top;
  }

  // gamepad: d-pad up/down scrolls the list
  function scrollBy(dy) { if (refs) refs.list.scrollTop += dy; }
  // lobby shortcut while you can still sign (set from main.js)
  function setFab(on) { fab.classList.toggle('rkg-on', !!on && !wrap); }
  function reset() { close(); if (offline) { wins = null; can = null; offline = false; loadErr = ''; } } // a new run: offline boards are per win
  // the main menu's LEGENDS: anyone can look (read only); a winner who can still sign gets their own board as it is
  function showPublic() { if (canSign()) { open(); return; } fetchOffline(null); open(); }

  return {
    onBoard, onLegend, onSigned, reportLocal, fetchOffline, open, showPublic, close, isOpen: () => !!wrap, scrollBy, setFab, reset,
    canSign, available: () => offline || !!wins,
  };
}

export { createLegends };
