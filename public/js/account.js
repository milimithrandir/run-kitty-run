// Optional account (web only for now): sign in with Google or Discord, chip in what you like (from 0.50) through Stripe
// Checkout, and your total shows next to your kitty's name online. Server side: server/accounts.js.
// The session token lives in localStorage; main.js passes it to the game server ('hi' / 'acct').
import { accountApiUrl, NATIVE } from './platform.js';
import { UNLOCKS, UNLOCK_MODES, isUnlocked, featTotal, featCount, isWorn, hellOpen } from './shared/unlocks.js';
import { SKATE_FINAL_LEVEL, HELL_LEVELS, stageStep } from './shared/config.js';

// The offline track (Solo and Local, one track): unlocks earned there are worn in Solo and Local games only, so a faked
// one is only ever seen by its own player. Kept on an active swag account (server 'progress'), else in this browser
// (and moved onto the account once one is active).
const SOLO_KEY = 'rkr-solo', SOLO_OFF_KEY = 'rkr-solo-off';
const readJson = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
// the easy games' level 8 unlocks ('e8') came a little after their level 9 ones: a browser that beat level 9 in an easy
// game had cleared level 8 on the way, so it gets the count (its own offline track)
{
  const v = readJson(SOLO_KEY);
  let moved = false;
  for (const m of UNLOCK_MODES) { const n = Number(v.e9 && v.e9[m]) || 0; if (n > (Number(v.e8 && v.e8[m]) || 0)) { (v.e8 ||= {})[m] = n; moved = true; } }
  if (moved) writeJson(SOLO_KEY, v);
}
import { progressId } from './net.js';

const CSS = `
.rka-modal{z-index:40;}
.rka-box{max-width:460px;max-height:calc(100dvh - 24px);overflow-y:auto;overscroll-behavior:contain;text-align:center;background:linear-gradient(160deg,rgba(52,30,96,.97),rgba(26,12,52,.97)) !important;}
.rka-box h2{font-size:clamp(30px,4.5vw,44px) !important;}
.rka-big{font-size:clamp(40px,7vw,60px);font-weight:900;color:#ffd56b;text-shadow:0 3px 0 #3a1650;line-height:1;}
.rka-amts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.rka-amt{font:inherit;font-weight:900;font-size:17px;cursor:pointer;padding:9px 14px;border-radius:14px;border:2px solid rgba(255,255,255,.25);
  background:rgba(10,4,30,.5);color:#fff;min-width:74px;}
.rka-amt.rka-on{border-color:#ffd56b;background:rgba(255,213,107,.18);color:#ffd56b;}
.rka-custom{display:flex;align-items:center;justify-content:center;gap:6px;font-weight:900;font-size:18px;}
.rka-custom input{font:inherit;font-weight:900;width:110px;padding:8px 10px;border-radius:12px;border:2px solid rgba(255,255,255,.3);
  background:rgba(10,4,30,.6);color:#fff;outline:none;text-align:center;user-select:text;-webkit-user-select:text;}
.rka-custom input:focus{border-color:#ffd56b;}
.rka-shownum{font-size:14px;margin-top:6px;}
.rka-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.rka-fine{font-size:12px;opacity:.6;}
.rka-links{display:flex;gap:14px;justify-content:center;font-size:13px;}
.rka-links a{cursor:pointer;opacity:.7;text-decoration:underline;}
.rka-links a:hover{opacity:1;}
.rka-del{display:flex;flex-direction:column;gap:8px;align-items:center;padding:12px;border-radius:14px;border:2px solid rgba(255,143,163,.45);background:rgba(255,80,110,.08);}
.rka-del input{font:inherit;font-weight:900;width:150px;text-align:center;letter-spacing:.12em;padding:8px 10px;border-radius:12px;border:2px solid rgba(255,255,255,.3);background:rgba(0,0,0,.3);color:#fff;outline:none;}
.rka-del input:focus{border-color:#ff8fa3;}
.rka-del .rka-amt:disabled{opacity:.35;cursor:default;}
.rka-del .rka-delgo:not(:disabled){border-color:#ff8fa3;color:#ff8fa3;}
.rka-del-sure{display:flex;flex-direction:column;gap:10px;align-items:center;}
.rka-del[hidden],.rka-del [hidden]{display:none;}
.rka-sure{font-weight:900;font-size:22px;letter-spacing:.06em;color:#ff8fa3;}
.rka-msg{min-height:20px;font-weight:800;}
.rka-msg.rka-err{color:#ff8fa3;}
.rka-msg.rka-ok{color:#9dff7a;}
.rka-gbtn{display:flex;justify-content:center;min-height:44px;}
.rka-dbtn{font:inherit;font-weight:800;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  min-height:40px;padding:0 22px;border-radius:999px;border:0;background:#5865f2;color:#fff;text-decoration:none;}
.rka-dbtn:hover{background:#4752c4;}
/* account menu: one card per section */
.rka-sec{align-self:stretch;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 14px;border-radius:16px;background:rgba(10,4,30,.38);border:1px solid rgba(255,255,255,.12);}
.rka-sech{align-self:flex-start;font-size:12px;font-weight:900;letter-spacing:.14em;opacity:.6;}
.rka-note{font-size:14px;font-weight:700;opacity:.85;}
.rka-gold{color:#ffd56b;font-weight:900;}
.rka-tabs{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;}
.rka-amt.rka-tab{font-size:13px;padding:6px 12px;min-width:0;}
.rka-stats{align-self:stretch;display:flex;flex-direction:column;gap:8px;}
.rka-table{border-collapse:collapse;width:100%;font-size:14px;font-weight:800;}
.rka-table th{font-size:11px;font-weight:900;letter-spacing:.08em;opacity:.6;padding:2px 4px;text-align:center;}
.rka-table td{padding:3px 4px;text-align:center;border-top:1px solid rgba(255,255,255,.08);}
.rka-table th:first-child,.rka-table td:first-child{text-align:left;}
.rka-table.rka-hell{margin-top:6px;}
.rka-table.rka-hell th{color:#ff8a5c;opacity:.85;}
.rka-table .rka-esc td{border-top:2px solid rgba(255,138,92,.35);color:#ffb08f;}
.rka-tot.rka-hellcrowns{margin-top:6px;}
.rka-table td.rka-zero{opacity:.35;}
.rka-unl{align-self:stretch;display:flex;flex-direction:column;gap:6px;}
.rka-ugoal{font-size:12px;font-weight:800;opacity:.7;text-align:left;margin-top:4px;}
.rka-urow{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:12px;background:rgba(255,255,255,.05);text-align:left;}
.rka-uname{flex:1;font-weight:900;font-size:15px;}
.rka-urow.rka-locked .rka-uname{opacity:.55;}
.rka-uprog{font-size:12px;font-weight:800;opacity:.75;white-space:nowrap;}
.rka-urow:has(.rka-ulines){flex-wrap:wrap;}
.rka-ulines{display:flex;flex-direction:column;gap:2px;order:3;width:100%;text-align:left;}   /* (under the name and its switch) */
.rka-urow:has(.rka-ulines) .rka-utog{margin-left:auto;}
.rka-uprog i{font-style:normal;opacity:.75;}
.rka-uprog b{color:#9dff7a;}
.rka-amt.rka-utog{font-size:13px;padding:5px 12px;min-width:58px;}
.rka-tot{display:flex;gap:18px;justify-content:center;font-weight:900;color:#ffd56b;}
`;

const PRESETS = [50, 420, 1337];
const TOKEN_KEY = 'rkr-acct';

// totals are in the server's one currency (config); lobby.js and ui.js format with this too
const SYMBOLS = { eur: '€', usd: '$', gbp: '£' };
let symbol = '€';
const fmtPaid = (c) => symbol + (c / 100).toFixed(2);
// in game (lobby slots, player cards, the menu button): just the number, digit for digit as paid, so funny numbers
// read as meant (1337, 80085, 69.69): no separators, and no .00 on whole amounts
const fmtNum = (c) => (c % 100 ? (c / 100).toFixed(2) : String(Math.round(c / 100)));

// Stats & progress in the account menu: times the team cleared each level, per mode, plus crowns and revives.
// Level 9 (the final run) only gets a row once you've got that far in some mode, and a number only in modes you
// have: no spoilers.
// the stats shown: normal or easy games, online or solo / local ones (as the level boards pick them) -> the set
let statsDiff = 'normal';  // 'normal' | 'easy'
let statsSrc = 'online';   // 'online' | 'local'
const statsSet = () => (statsDiff === 'easy' ? (statsSrc === 'online' ? 'easy' : 'easyLocal') : statsSrc);
let statsWhat = 'clears';  // 'clears' (times cleared) | 'best' (fastest clear)
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const STAT_COLS = [['run', 'RUN'], ['ice', 'SKATE'], ['mixed', 'RUN + SKATE']];
function statsView(s, hellModes = []) {
  const clears = (s && s.clears) || {}, reached = (s && s.reached) || {}, best = (s && s.best) || {};
  const t = el('table', 'rka-table');
  const head = el('tr');
  head.append(el('th', null, 'LEVEL'), ...STAT_COLS.map(([, label]) => el('th', null, label)));
  t.appendChild(head);
  const last = STAT_COLS.some(([m]) => (reached[m] || 0) >= 9) ? 9 : 8;
  for (let L = 1; L <= last; L++) {
    const tr = el('tr');
    tr.appendChild(el('td', null, String(L)));
    for (const [m] of STAT_COLS) {
      const n = (clears[m] || {})[L] || 0, b = (best[m] || {})[L];
      const text = statsWhat === 'best' ? (b > 0 ? fmtTime(b) : '–') : String(n);
      tr.appendChild(el('td', (statsWhat === 'best' ? b > 0 : n) ? null : 'rka-zero', L === 9 && (reached[m] || 0) < 9 ? '–' : text));
    }
    t.appendChild(tr);
  }
  const tot = el('div', 'rka-tot');
  tot.append(el('span', null, `CROWNS ${(s && s.crowns) || 0}`), el('span', null, `REVIVES ${(s && s.revives) || 0}`));
  const wrap = el('div', 'rka-stats');
  wrap.append(t, tot);
  const vs = s && s.versus;
  if (vs && vs.games > 0) {   // (versus: once played)
    const vt = el('div', 'rka-tot');
    vt.append(el('span', null, `⚔ VERSUS WINS ${vs.wins || 0}`), el('span', null, `GAMES ${vs.games}`));
    wrap.appendChild(vt);
  }
  if (hellModes.length) wrap.appendChild(hellView(s && s.hell, hellModes));
  return wrap;
}
// the hell table (once hell is open: hellModes, the modes it's open in): each hell level's times cleared / fastest
// clear, how many times all of hell was cleared (ESCAPED), and the crowns and revives in hell (not in the ones above)
function hellView(h, hellModes) {
  const clears = (h && h.clears) || {}, best = (h && h.best) || {}, wins = (h && h.wins) || {};
  const cols = [['run', 'HELL RUN'], ['ice', 'HELL SKATE']].filter(([m]) => hellModes.includes(m));
  const t = el('table', 'rka-table rka-hell');
  const head = el('tr');
  head.append(el('th', null, 'LEVEL'), ...cols.map(([, label]) => el('th', null, label)));
  t.appendChild(head);
  for (let L = 1; L <= HELL_LEVELS; L++) {
    const tr = el('tr');
    tr.appendChild(el('td', null, String(L)));
    for (const [m] of cols) {
      const n = (clears[m] || {})[L] || 0, b = (best[m] || {})[L];
      tr.appendChild(el('td', (statsWhat === 'best' ? b > 0 : n) ? null : 'rka-zero', statsWhat === 'best' ? (b > 0 ? fmtTime(b) : '–') : String(n)));
    }
    t.appendChild(tr);
  }
  if (statsWhat !== 'best') {
    const tr = el('tr', 'rka-esc');
    tr.appendChild(el('td', null, 'ESCAPED'));
    for (const [m] of cols) tr.appendChild(el('td', wins[m] ? null : 'rka-zero', String(wins[m] || 0)));
    t.appendChild(tr);
  }
  const tot = el('div', 'rka-tot rka-hellcrowns');
  tot.append(el('span', null, `CROWNS ${(h && h.crowns) || 0}`), el('span', null, `REVIVES ${(h && h.revives) || 0}`));
  const wrap = el('div');
  wrap.append(t, tot);
  return wrap;
}

const signedInAs = (a) => (a.via === 'discord' ? `Signed in with Discord as ${a.name || 'you'}` : `Signed in as ${a.email}`);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// a line of text with its "shows next to your kitty" part in gold (it's the swag's selling point)
function goldNote(cls, text) {
  const e = el('div', cls), i = text.indexOf(GOLD), j = i + GOLD.length;
  if (i < 0) { e.textContent = text; return e; }
  e.append(text.slice(0, i), el('span', 'rka-gold', text.slice(i, j)), text.slice(j));
  return e;
}
const GOLD = 'shows next to your kitty for everyone online';

function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function writeToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

let gsiLoading = null;
function loadGsi() {
  return (gsiLoading ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = ok;
    s.onerror = () => { gsiLoading = null; fail(new Error('Could not reach Google.')); };
    document.head.appendChild(s);
  }));
}

function createAccount(root) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const A = { enabled: false, token: NATIVE ? '' : readToken(), account: null, cfg: null };
  let modal = null, changeFn = null;
  let eqFor, eqGuest, eqMode, eqSolo, eqSet = new Set();   // equipped(): made once per account / guest progress, mode, offline track
  const changed = () => { mergeSolo(); if (changeFn) changeFn(); };
  // ---- the offline track ----
  const activeAcct = () => !!(A.account && Number(A.account.paid) > 0);
  let soloVer = 0, soloPending = null, soloT = null;
  // this player's offline progress: the account's, or this browser's
  const soloProg = () => (activeAcct() ? (A.account.unlocks && A.account.unlocks.solo) || {} : readJson(SOLO_KEY));
  // hell open in this mode (Run only / Skate only): level 9 reached in any mode, or a hell level of this mode cleared,
  // online or offline (unlocks.js hellOpen); before hell existed: the account's stats, or this browser saw level 9
  function hellOpenHere(mode) {
    if (mode !== 'run' && mode !== 'ice') return false;   // (Run only and Skate only have one)
    const u = (A.account && Number(A.account.paid) > 0 && A.account.unlocks) || A.guest;
    if ((u && hellOpen(u, mode)) || hellOpen(soloProg(), mode)) return true;
    const st = A.account && A.account.stats;
    if (st && ['online', 'local', 'easy', 'easyLocal'].some((k) => { const r = st[k] && st[k].reached; return !!r && Object.values(r).some((v) => (v | 0) >= 9); })) return true;   // (level 9 in any mode)
    try { return localStorage.getItem('rkr-seen9') === '1'; } catch { return false; }
  }
  // an offline feat done ('l8' | 'l9' | 'e8' | 'e9' | 'win' | 'rev') in a mode
  function soloFeat(feat, mode, n = 1) {
    if (!UNLOCK_MODES.includes(mode)) return;
    soloVer++;
    if (!activeAcct()) {
      const v = readJson(SOLO_KEY);
      (v[feat] ||= {})[mode] = (Number(v[feat][mode]) || 0) + n;
      writeJson(SOLO_KEY, v);
      changed();
      return;
    }
    const s = A.account.unlocks && (A.account.unlocks.solo ||= {});   // (counted here at once, sent in a moment)
    if (s) { (s[feat] ||= {})[mode] = (Number(s[feat][mode]) || 0) + n; }
    soloPending ||= {};
    ((soloPending[mode] ||= {})[feat]) = (soloPending[mode][feat] || 0) + n;
    if (!soloT) soloT = setTimeout(sendSolo, 3000);
    changed();
  }
  function sendSolo() {
    clearTimeout(soloT); soloT = null;
    const p = soloPending; soloPending = null;
    if (!p || !activeAcct()) return;
    for (const [mode, solo] of Object.entries(p)) api('progress', { mode, solo }).then((j) => { if (j.account) { A.account = j.account; soloVer++; } }).catch(() => { /* best effort */ });
  }
  // a browser's own offline track moves onto the account once one is active (its switches too)
  let merging = false;
  function mergeSolo() {
    if (merging || !activeAcct()) return;
    const v = readJson(SOLO_KEY);
    const modes = {};
    for (const [f, per] of Object.entries(v)) for (const [m, n] of Object.entries(per || {})) if (UNLOCK_MODES.includes(m) && n > 0) (modes[m] ||= {})[f] = n;
    if (!Object.keys(modes).length) return;
    merging = true;
    writeJson(SOLO_KEY, {});
    Promise.all(Object.entries(modes).map(([mode, solo]) => api('progress', { mode, solo })))
      .then((js) => { const j = js[js.length - 1]; if (j && j.account) { A.account = j.account; soloVer++; } })
      .catch(() => { writeJson(SOLO_KEY, v); })   // (try again next time)
      .finally(() => { merging = false; if (changeFn) changeFn(); });
  }
  // offline: the feats seen in a Solo or Local run (either player), like the server's online ones: level 8 cleared and
  // level 9 won having reached the goal yourself on every level, the final run won (the song), revives (the medic badge)
  let soloRun = null;   // { sim, goals: Map(player id -> steps whose goal it reached) }
  function noteSolo(sim, events) {
    if (!soloRun || soloRun.sim !== sim) soloRun = { sim, goals: new Map() };
    const goals = (id) => { let g = soloRun.goals.get(id); if (!g) soloRun.goals.set(id, g = new Set()); return g; };
    for (const e of events) {
      // hell: a cleared hell level (it stays open in this mode), and revives; none of level 9's own
      // (a cleared hell level: the new song too, as the final run won)
      if (sim.hell) { if (e.type === 'levelClear') { soloFeat('h1', sim.mode); soloFeat('win', sim.mode); } else if (e.type === 'revive') soloFeat('rev', sim.mode); continue; }
      if (e.type === 'enterCenter') goals(e.playerId).add(e.level ?? sim.level);
      // (an easy game: its own level 8 and 9 feats; not again when level 9 starts over)
      else if (e.type === 'levelStart' && !e.retry && ((sim.levelData && sim.levelData.level) || sim.level) === SKATE_FINAL_LEVEL) {
        soloFeat('r9', sim.mode);   // (hell opens in this mode: Run + Skate's in both)
        if (sim.players.some((p) => goals(p.id).size >= stageStep(sim.mode, sim.finales, 8, true))) soloFeat(sim.easy ? 'e8' : 'l8', sim.mode);
      } else if (e.type === 'victory') {
        const party = Array.isArray(e.party) ? e.party : [];
        if (sim.players.some((p) => !party.includes(p.id) && goals(p.id).size >= stageStep(sim.mode, sim.finales, SKATE_FINAL_LEVEL))) soloFeat(sim.easy ? 'e9' : 'l9', sim.mode);
        soloFeat('win', sim.mode);
      } else if (e.type === 'revive') soloFeat('rev', sim.mode);
    }
  }
  // the offline switches of a player without an account (items unlocked offline only: the server has no record of them)
  const soloOff = () => (activeAcct() ? {} : readJson(SOLO_OFF_KEY));

  async function api(name, body) {
    const r = await fetch(accountApiUrl('/api/account/' + name), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',   // credentials must never follow a redirect to another server
      headers: { 'Content-Type': 'application/json', ...(A.token ? { Authorization: 'Bearer ' + A.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (j.signedOut) { setSession('', null); throw new Error('You were signed out, sign in again.'); }
    if (!j.ok) throw new Error(j.msg || 'Something went wrong, try again in a moment.');
    return j;
  }
  // the guest unlock routes: no sign-in, just this browser's progress id
  async function guestApi(name, body) {
    const r = await fetch(accountApiUrl('/api/account/' + name), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.msg || 'Something went wrong, try again in a moment.');
    return j;
  }
  async function loadGuest() {
    const pid = progressId();
    if (!pid) return false;
    try {
      const j = await guestApi('guest', { pid });
      const before = JSON.stringify(A.guest || null);
      A.guest = j.unlocks || null;
      if (JSON.stringify(A.guest) !== before) { changed(); return true; }
    } catch { /* offline */ }
    return false;
  }
  function setSession(token, account) {
    A.token = token; A.account = account;
    writeToken(token);
    changed();
  }

  async function init() {
    if (NATIVE) return;   // the apps get sign-in later (native Google / Apple sign-in); paying stays on the web
    try {
      A.cfg = await fetch(accountApiUrl('/api/account/config'), { redirect: 'error' }).then((r) => r.json());
      A.enabled = !!(A.cfg && A.cfg.enabled);
      if (A.cfg && A.cfg.currency) symbol = SYMBOLS[A.cfg.currency] || A.cfg.currency.toUpperCase() + ' ';
    } catch { A.enabled = false; }
    loadGuest();   // this browser's unlocks (no account needed: its own kitty wears them in solo games too)
    if (!A.enabled) { changed(); return; }
    // back from Sign in with Discord (server/accounts.js): #signin=<one-time code> or #signin-error=<why>
    const h = new URLSearchParams(location.hash.slice(1)), handoff = h.get('signin'), signinErr = h.get('signin-error');
    if (handoff || signinErr) history.replaceState(null, '', location.pathname + location.search);
    const q = new URLSearchParams(location.search), paid = q.get('paid');
    if (paid) {
      q.delete('paid');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    }
    if (handoff) {
      try {
        const j = await api('handoff', { code: handoff });
        setSession(j.token, j.account);
        open(j.account && j.account.deleting ? {} : { msg: Number(j.account && j.account.paid) > 0 ? 'Welcome back! Your swag is on this browser now.' : 'Signed in!', ok: true });
        return;
      } catch (e) { open({ err: e.message }); }
    } else if (signinErr) {
      open({ err: { denied: 'Discord sign-in was cancelled.', expired: 'Sign-in timed out, try again.', off: 'Discord sign-in is not available right now.' }[signinErr] || 'Discord sign-in did not work, try again.' });
    }
    if (A.token) { try { A.account = (await api('me')).account; } catch { /* signed out */ } }
    changed();
    if (paid === 'cancel' && A.token) open({ msg: 'No worries, nothing was charged.' });
    else if (paid && A.token) {
      open({ msg: 'Confirming your payment…' });
      try {
        const j = await api('confirm', { session: paid });
        A.account = j.account; changed();
        open({ thanks: j.paid, msg: j.paid ? '' : 'Your payment is still processing; your total updates as soon as it clears.' });
      } catch (e) { open({ err: e.message }); }
    }
  }

  function close() { if (modal) modal.remove(); modal = null; }

  // small print ending in links to the Terms and Privacy pages
  function fine(text) {
    const d = el('div', 'rka-fine', text);
    const link = (page, label) => { const l = el('a', null, label); l.href = page + '.html'; l.target = '_blank'; l.rel = 'noopener'; l.style.color = 'inherit'; return l; };
    d.append(link('terms', 'Terms'), ' & ', link('privacy', 'Privacy'), '.');
    return d;
  }

  // one modal: signed out (create one, or sign back in); signed in: the account menu, or the amount picker (opts.view 'pay')
  function open(opts = {}) {
    // no active account: the guest progress may have moved on (an online game): fetch it, redraw if it did
    if (!opts.fresh && !(A.account && Number(A.account.paid) > 0)) loadGuest().then((ch) => { if (ch && modal) open({ ...opts, fresh: true }); });
    if (!A.enabled) return;
    close();
    modal = el('div', 'rkr-overlay rkr-dim rka-modal');
    const box = el('div', 'rkr-glass rka-box');
    modal.appendChild(box);
    modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    box.tabIndex = -1;   // focus inside, so title / game keys don't fire behind the box
    setTimeout(() => { if (modal && !modal.contains(document.activeElement)) box.focus(); }, 0);
    modal.addEventListener('keyup', (e) => e.stopPropagation());
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    const msg = el('div', 'rka-msg' + (opts.err ? ' rka-err' : opts.thanks ? ' rka-ok' : ''), opts.err || opts.msg || '');
    const say = (t, kind) => { msg.className = 'rka-msg' + (kind ? ' rka-' + kind : ''); msg.textContent = t; };
    const closeBtn = el('button', 'rkr-btn rkr-alt', 'CLOSE');
    closeBtn.addEventListener('click', close);
    const a = A.account;
    const section = (title) => { const s = el('div', 'rka-sec'); s.appendChild(el('div', 'rka-sech', title)); return s; };
    // the unlocks with their progress per mode and on / off switches: an account's, or this browser's (no account)
    const unlocksBox = (title, prog, toggle, note, solo = {}, offOf = (id) => !!(prog.off && prog.off[id])) => {
      const box_ = section(title);
      const ulist = el('div', 'rka-unl');
      const SHORT = { run: 'Run', ice: 'Skate', mixed: 'Run + Skate' };
      const GOALS = { l8: 'Clear level 8 in a normal game having reached the goal yourself on every level (both halves in Run + Skate). Each mode unlocks it for that mode, Run + Skate for all three:',
        l9: 'Clear level 9 in a normal game having reached the goal yourself on every level, the final one too. Each mode unlocks it for that mode, Run + Skate for all three:',
        e8: 'Clear level 8 in an easy game having reached the goal yourself on every level (both halves in Run + Skate); a normal game counts too. Each mode unlocks it for that mode, Run + Skate for all three:',
        e9: 'Clear level 9 in an easy game having reached the goal yourself on every level, the final one too; a normal game counts too. Each mode unlocks it for that mode, Run + Skate for all three:',
        win: 'Clear the final level, or a level of the new mode, to unlock a new song (any mode):',
        rev: 'Revive kitties (all modes together):',
        top1: 'Number 1 on the legends board: the first team to beat a mode. Worn in every mode:',
        fast1: 'Number 1 on a fastest list of the legends board (solo or team, online or local). Worn in every mode:',
        later: 'Special rewards: the lion mane and the fluffy tail tip in a metal of their own, on a metal kitty (one metal each at a time):' };
      let lastFeat = '';
      // no spoilers: level 9's unlocks only once this player has seen level 9 (this browser, the account's stats, or progress)
      let seen9 = false;
      try { seen9 = localStorage.getItem('rkr-seen9') === '1'; } catch { /* ignore */ }
      const st = A.account && A.account.stats;
      seen9 ||= ['online', 'local', 'easy', 'easyLocal'].some((k) => st && st[k] && Object.values(st[k].reached || {}).some((v) => v >= 9));
      seen9 ||= Object.values((prog && prog.l9) || {}).some((v) => v > 0) || Object.values(solo.l9 || {}).some((v) => v > 0);
      for (const u of UNLOCKS) {
        if ((u.feat === 'l9' || u.feat === 'e9') && !seen9) continue;
        if (u.hidden && !isUnlocked(prog, u) && !isUnlocked(solo, u)) continue;   // (not shown at all until it's unlocked)
        // a mane / tail tip metal: only once the player has the Lion mane / Fluffy tail to wear it on
        const part = u.part || (u.slot === 'mane' ? 'lion' : u.slot === 'tip' ? 'tail' : u.slot === 'lens' ? 'shades' : null);
        if (part && !isUnlocked(prog, part) && !isUnlocked(solo, part)) continue;
        // (u.metalKitty: only with a chrome, golden or bronze kitty unlocked, the looks it changes)
        if (u.metalKitty && !['chrome', 'gold', 'bronze'].some((m) => isUnlocked(prog, m) || isUnlocked(solo, m))) continue;
        if (u.feat !== lastFeat) { lastFeat = u.feat; ulist.appendChild(el('div', 'rka-ugoal', GOALS[u.feat])); }
        const onl = isUnlocked(prog, u), off_ = isUnlocked(solo, u), open_ = onl || off_;   // (in some mode, online or offline: its switch shows)
        const row = el('div', 'rka-urow' + (open_ ? '' : ' rka-locked'));
        row.appendChild(el('span', 'rka-uname', (open_ ? '' : '🔒 ') + (u.song && !open_ ? 'New song' : u.name) + (u.all ? ' (all 3 modes)' : '')));   // (u.all: needs every mode, then worn in all)
        if (u.song) {
          // a song has no switch: it joins the soundtrack, and the settings can play it on its own
          row.appendChild(el('span', 'rka-uprog', open_ ? 'Switch it on / off in Settings' : ''));
        } else if (u.invert) {
          // a switch for something the kitty has anyway (the tail tip's glow): ON shows it; switched OFF, the item is worn
          row.appendChild(el('span', 'rka-uprog', 'Unlocked'));
          const on = !(prog.off && prog.off[u.id] === false);
          const t = el('button', 'rka-amt rka-utog' + (on ? ' rka-on' : ''), on ? 'ON' : 'OFF');
          t.addEventListener('click', async () => {
            t.disabled = true;
            try { await toggle(u.id, on); changed(); open({ fresh: true }); } catch (e) { t.disabled = false; say(e.message, 'err'); }
          });
          row.appendChild(t);
        } else if (u.slot || u.feat === 'top1' || u.feat === 'fast1') {
          // a metal for the mane / tail tip: one of its slot at a time (switching one on switches the others off)
          row.appendChild(el('span', 'rka-uprog', u.slot ? 'Unlocked (on a metal kitty)' : 'Unlocked'));
          const on = u.defaultOff ? prog.off && prog.off[u.id] === false : !offOf(u.id);
          const t = el('button', 'rka-amt rka-utog' + (on ? ' rka-on' : ''), on ? 'ON' : 'OFF');
          t.addEventListener('click', async () => {
            t.disabled = true;
            try {
              await toggle(u.id, !on);
              if (!on) for (const o of UNLOCKS) if (o.id !== u.id && ((u.slot && o.slot === u.slot) || (u.excl && o.excl === u.excl)) && isWorn(o, prog.off) && (isUnlocked(prog, o) || isUnlocked(solo, o))) await toggle(o.id, false);
              changed(); open({ fresh: true });
            } catch (e) { t.disabled = false; say(e.message, 'err'); }
          });
          row.appendChild(t);
        } else {
          // each mode on its own: a tick where it's unlocked (and worn), the count toward it elsewhere (a total item:
          // one count over all modes)
          // two lines: Multiplayer (worn everywhere) and Solo / Local (worn offline only)
          // cover (the Solo / Local line): the Multiplayer progress. What's unlocked there is worn offline too, so a mode
          // unlocked in Multiplayer has its tick on this line as well
          const ticks = (pr, label, done, cover = null) => {
            const p = el('span', 'rka-uprog');
            p.appendChild(el('i', null, label));
            const modes = u.modes || UNLOCK_MODES;   // (only the modes it can be earned in)
            const own = (m) => Math.min(u.times, u.all ? ((pr[u.feat] || {})[m]) || 0 : featCount(pr, u.feat, m));   // (Run + Skate counts in the other two)
            const covered = (m) => !!cover && isUnlocked(cover, u, m);
            if (u.total) { const ok = done || covered(null); p.appendChild(el(ok ? 'b' : 'span', null, ok ? '✓' : `${Math.min(u.times, featTotal(pr, u.feat))}/${u.times}`)); }
            else modes.forEach((m, i) => {
              const n = own(m), ok = n >= u.times || covered(m);
              if (i) p.append(' · ');
              p.appendChild(el(ok ? 'b' : 'span', null, ok ? `${SHORT[m]} ✓` : `${SHORT[m]} ${n}/${u.times}`));
            });
            return p;
          };
          const lines = el('div', 'rka-ulines');
          lines.append(ticks(prog, 'Multiplayer: ', onl), ticks(solo, 'Solo / Local: ', off_, prog));
          row.appendChild(lines);
          if (open_) {   // one switch for every mode it's unlocked in
            const on = !offOf(u.id);
            const t = el('button', 'rka-amt rka-utog' + (on ? ' rka-on' : ''), on ? 'ON' : 'OFF');
            t.addEventListener('click', async () => {
              t.disabled = true;
              try {
                await toggle(u.id, !on);
                // (one of an excl group at a time: the chrome or the golden kitty)
                if (!on && u.excl) for (const o of UNLOCKS) if (o.id !== u.id && o.excl === u.excl && !offOf(o.id) && (isUnlocked(prog, o) || isUnlocked(solo, o))) await toggle(o.id, false);
                changed(); open({ fresh: true });
              }
              catch (e) { t.disabled = false; say(e.message, 'err'); }
            });
            row.appendChild(t);
          }
        }
        ulist.appendChild(row);
      }
      // the new mode (no item: a row of its own; not a word about what it is), open in Run only / Skate only
      const nmRun = hellOpenHere('run'), nmIce = hellOpenHere('ice'), nmAny = nmRun || nmIce;
      ulist.appendChild(el('div', 'rka-ugoal', "Reach the final level in any mode (Run + Skate, Run only or Skate only), or clear a level of the new mode in someone else's lobby:"));
      const nm = el('div', 'rka-urow' + (nmAny ? '' : ' rka-locked'));
      nm.appendChild(el('span', 'rka-uname', (nmAny ? '' : '🔒 ') + 'New mode'));
      nm.appendChild(el('span', 'rka-uprog', nmAny ? 'Unlocked: ' + [nmRun && 'Run only', nmIce && 'Skate only'].filter(Boolean).join(', ') : ''));
      ulist.appendChild(nm);
      box_.append(ulist, el('div', 'rka-fine', note));
      return box_;
    };
    // this browser's own progress (no active account), kept by the server under its progress id
    const guestBox = () => unlocksBox('YOUR UNLOCKS (THIS BROWSER)', A.guest || {},
      async (id, on) => {
        if (A.guest && isUnlocked(A.guest, id)) A.guest = (await guestApi('guestequip', { pid: progressId(), item: id, on })).unlocks;
        const o = readJson(SOLO_OFF_KEY);
        if (!on) o[id] = true; else if ((UNLOCKS.find((x) => x.id === id) || {}).defaultOff) o[id] = false; else delete o[id];   // (a defaultOff item: switched on on purpose)
        writeJson(SOLO_OFF_KEY, o); soloVer++;
      },
      'Multiplayer unlocks show for everyone; Solo / Local ones only in your own Solo and Local games. Saved on this browser only: clearing its data or another device loses them (and Multiplayer ones after two months without playing it). Activate a swag account to keep them safe.',
      soloProg(), (id) => !!((A.guest && A.guest.off && A.guest.off[id]) || readJson(SOLO_OFF_KEY)[id]));
    const sayOpts = () => { if (opts.msg || opts.err) say(opts.err || opts.msg, opts.err ? 'err' : opts.thanks || opts.ok ? 'ok' : ''); };

    if (!A.token || !a) {
      // Signed out: create one, or sign back in (another browser, cleared storage). Accounts are keyed by the Google /
      // Discord account, so both sections do the same thing: the same Google or Discord account always gets the same
      // swag account back (a Google one and a Discord one are two separate accounts).
      const create = section('NEW HERE?'), back = section('ALREADY HAVE ONE?');
      const gNew = el('div', 'rka-gbtn'), gBack = el('div', 'rka-gbtn');
      const discordBtn = (text) => {
        const b = el('a', 'rka-dbtn', text);
        b.href = accountApiUrl('/api/account/discord') + '?origin=' + encodeURIComponent(location.origin);
        return b;
      };
      create.append(goldNote('rka-note', `Totally optional, you do not need an account to play the game. Sign up, then chip in whatever you like once to activate it: the total shows next to your kitty for everyone online (can toggle it on and off), and your account keeps your stats and earns unlocks in Multiplayer games.`), gNew);
      back.append(el('div', 'rka-note', `Sign in with the same ${A.cfg.discord ? 'Google or Discord' : 'Google'} account as before and your swag comes back, on any browser.`), gBack);
      if (A.cfg.discord) { create.append(discordBtn('Sign up with Discord')); back.append(discordBtn('Sign in with Discord')); }
      box.append(el('h2', null, 'SWAG ACCOUNT'), create, back, guestBox(), msg, fine('By signing in you agree to the '), closeBtn);
      loadGsi().then(() => {
        if (!modal || !gNew.isConnected) return;
        google.accounts.id.initialize({
          client_id: A.cfg.googleClientId,
          callback: async (r) => {
            say('Signing in…');
            try {
              const j = await api('google', { credential: r.credential });
              setSession(j.token, j.account);
              // always the account menu, never straight to paying (paying is only ever the player's own click)
              open(j.account && j.account.deleting ? {} : { msg: Number(j.account && j.account.paid) > 0 ? 'Welcome back! Your swag is on this browser now.' : 'Signed in!', ok: true });   // (deleted: the restore view says it all)
            } catch (e) { say(e.message, 'err'); }
          },
        });
        const look = { theme: 'filled_black', size: 'large', shape: 'pill' };
        google.accounts.id.renderButton(gNew, { ...look, text: 'signup_with' });
        google.accounts.id.renderButton(gBack, { ...look, text: 'signin_with' });
      }).catch((e) => say(e.message, 'err'));
      root.appendChild(modal);
      return;
    }

    // a deleted account (signed in again within its 14 days): only a way back
    if (a.deleting) {
      const until = new Date(a.deleting).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
      const sec = section('ACCOUNT DELETED');
      const back = el('button', 'rka-amt rka-on', 'RESTORE MY ACCOUNT');
      back.addEventListener('click', async () => {
        back.disabled = true;
        try { const j = await api('restore', {}); A.account = j.account; changed(); open({ fresh: true, msg: 'Welcome back! Your account is restored.', ok: true }); }
        catch (e) { back.disabled = false; say(e.message, 'err'); }
      });
      sec.append(el('div', 'rka-note', `You deleted this account. You can still restore this account within 14 days: it's gone for good on ${until}.`), back);
      const links = el('div', 'rka-links'), out = el('a', null, 'Sign out');
      out.addEventListener('click', async () => { try { await api('logout', {}); } catch { /* gone anyway */ } setSession('', null); close(); });
      links.append(out);
      box.append(el('h2', null, 'YOUR SWAG ACCOUNT'), sec, msg, closeBtn, links, fine(`${signedInAs(a)}. `));
      sayOpts();
      root.appendChild(modal);
      return;
    }

    const paid = Number(a.paid) || 0;
    const shown = a.show !== false;

    // Signed in: the account menu, one section per thing (stats & progress go in here later). The amount picker is
    // its own view (opts.view 'pay', with BACK).
    if (opts.view !== 'pay') {
      box.append(el('h2', null, opts.thanks ? 'THANK YOU!' : 'YOUR SWAG ACCOUNT'), el('div', 'rkr-gsub', `Hi ${a.name || 'there'}!`));
      // Swag: your total, the "shown online" switch (server: accounts.js 'show') and adding more
      const swag = section(paid > 0 ? 'SWAG' : 'ACTIVATE YOUR SWAG ACCOUNT');
      if (paid > 0) {
        const sw = el('button', 'rka-amt' + (shown ? ' rka-on' : ''), shown ? 'SHOWN ONLINE: ON' : 'SHOWN ONLINE: OFF');
        sw.addEventListener('click', async () => {
          sw.disabled = true;
          try { A.account = (await api('show', { show: !shown })).account; changed(); open(); } catch (e) { say(e.message, 'err'); sw.disabled = false; }
        });
        const add = el('button', 'rka-amt', 'ADD MORE');
        add.addEventListener('click', () => open({ view: 'pay' }));
        const r = el('div', 'rka-row');
        r.append(sw, add);
        // the number next to your kitty: the total, or any lower number you like (server: accounts.js 'display')
        const disp = Number(a.display) || paid;
        const numRow = el('label', 'rka-custom rka-shownum', 'Number shown: ');
        const numIn = el('input');
        numIn.type = 'text'; numIn.inputMode = 'decimal'; numIn.value = fmtNum(disp); numIn.maxLength = 12;
        const setBtn = el('button', 'rka-amt', 'SET');
        const cents = () => {
          const mm = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(numIn.value);
          return mm ? +mm[1] * 100 + +(mm[2] || '0').padEnd(2, '0') : 0;
        };
        const setNum = async () => {
          const c = cents();
          if (!(c >= 1 && c <= paid)) { say(`Pick a number from 0.01 to ${fmtNum(paid)} (your total).`, 'err'); return; }
          setBtn.disabled = true;
          try { A.account = (await api('display', { cents: c })).account; changed(); open(); } catch (e) { say(e.message, 'err'); setBtn.disabled = false; }
        };
        setBtn.addEventListener('click', setNum);
        numIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') setNum(); });
        numRow.append(numIn, setBtn);
        swag.append(el('div', 'rka-big', fmtPaid(paid)),
          el('div', 'rka-note', shown ? (disp !== paid ? `Your kitty shows ${fmtNum(disp)} for everyone online.` : 'Shows next to your kitty for everyone online.') : 'Hidden: other players don\'t see it right now.'), r,
          numRow, el('div', 'rka-fine', `The number next to your kitty can be anything from 0.01 up to your total (${fmtNum(paid)}).`));
        // how it looks: the classic tag or the koi fish (server: accounts.js 'style'), one at a time
        const koi = a.style === 'koi', looks = el('div', 'rka-row');
        const lookBtn = (label, isKoi) => {
          const on = koi === isKoi, b = el('button', 'rka-amt' + (on ? ' rka-on' : ''), label + (on ? ': ON' : ': OFF'));
          b.addEventListener('click', async () => {
            b.disabled = true;
            // (switching one on switches the other off; switching one off switches the other on)
            try { A.account = (await api('style', { style: on !== isKoi ? 'koi' : 'classic' })).account; changed(); open(); } catch (e) { say(e.message, 'err'); b.disabled = false; }
          });
          return b;
        };
        looks.append(lookBtn('CLASSIC TAG', false), lookBtn('KOI FISH', true));
        swag.append(el('div', 'rka-note', 'How your number looks:'), looks);
      } else {
        const pick = el('button', 'rka-amt rka-on', 'PICK AN AMOUNT');
        pick.addEventListener('click', () => open({ view: 'pay' }));
        swag.append(goldNote('rka-note', `Chip in once, from ${fmtPaid(A.cfg.min)}, to activate your account: the total shows next to your kitty for everyone online (can toggle it on and off), the game keeps your stats and you can earn unlocks in Multiplayer games.`), pick);
      }
      // Unlocks (shared/unlocks.js): earned online, kept forever, each switched on or off here
      const unl = unlocksBox('UNLOCKS', a.unlocks || {}, async (id, on) => { A.account = (await api('equip', { item: id, on })).account; },
        'Multiplayer unlocks show on your kitty in every game, for everyone; Solo / Local ones only in your own Solo and Local games.',
        (a.unlocks && a.unlocks.solo) || {});
      // Stats & progress: normal or easy games, then online (counted by the game server) or solo / local (reported by
      // this browser), as the level boards pick them
      const stats = section('STATS & PROGRESS');
      const tabRow = (opts, cur, set) => {
        const row = el('div', 'rka-tabs');
        for (const [k, label] of opts) {
          const t = el('button', 'rka-amt rka-tab' + (k === cur ? ' rka-on' : ''), label);
          t.addEventListener('click', () => { set(k); open({ fresh: true }); });
          row.appendChild(t);
        }
        return row;
      };
      const diff = tabRow([['normal', 'NORMAL'], ['easy', 'EASY']], statsDiff, (k) => { statsDiff = k; });
      const tabs = tabRow([['online', 'ONLINE'], ['local', 'SOLO & LOCAL']], statsSrc, (k) => { statsSrc = k; });
      // what the table shows: times cleared, or the fastest clear
      const what = el('div', 'rka-tabs');
      for (const [k, label] of [['clears', 'TIMES CLEARED'], ['best', 'FASTEST']]) {
        const t = el('button', 'rka-amt rka-tab' + (k === statsWhat ? ' rka-on' : ''), label);
        t.addEventListener('click', () => { statsWhat = k; open({ fresh: true }); });
        what.appendChild(t);
      }
      const set = statsSet();
      stats.append(diff, tabs, what, statsView(a.stats && a.stats[set], ['run', 'ice'].filter((m) => hellOpenHere(m))),
        el('div', 'rka-fine', set === 'online' ? 'Counted by the game server in Multiplayer games.'
          : set === 'easy' ? 'Easy Multiplayer games, counted by the game server. Until 24 October 2026 this also counted easy solo and local games.'
          : set === 'easyLocal' ? 'Easy solo and local co-op games, counted by your own browser (since 24 October 2026).'
          : 'Counted by your own browser in solo and local co-op games.'));
      const links = el('div', 'rka-links');
      const out = el('a', null, 'Sign out'), del = el('a', null, 'Delete account');
      out.addEventListener('click', async () => { try { await api('logout', {}); } catch { /* gone anyway */ } setSession('', null); close(); });
      // deleting takes typing DELETE (in capitals), then a yes to ARE YOU SURE?: no account goes by an accidental click
      const delBox = el('div', 'rka-del');
      delBox.hidden = true;
      const delIn = el('input'); delIn.type = 'text'; delIn.placeholder = 'DELETE'; delIn.autocomplete = 'off'; delIn.spellcheck = false;
      const delGo = el('button', 'rka-amt rka-delgo', 'DELETE FOREVER'); delGo.disabled = true;
      const delNo = el('button', 'rka-amt', 'KEEP MY ACCOUNT');
      const delRow = el('div', 'rka-amts'); delRow.append(delNo, delGo);
      const delNote = el('div', 'rka-note', `This deletes your account${paid ? `, your ${fmtPaid(paid)} total` : ''}, your stats and your unlocks. You can still restore this account within 14 days by signing in again; after that it's gone for good. Payments aren't refunded. Type DELETE to confirm.`);
      // the last step: ARE YOU SURE?
      const sure = el('div', 'rka-del-sure');
      sure.hidden = true;
      const sureYes = el('button', 'rka-amt rka-delgo', 'YES, DELETE IT'), sureNo = el('button', 'rka-amt', 'NO, KEEP IT');
      const sureRow = el('div', 'rka-amts'); sureRow.append(sureNo, sureYes);
      sure.append(el('div', 'rka-sure', 'ARE YOU SURE?'), sureRow);
      delBox.append(delNote, delIn, delRow, sure);
      const reset = () => { delBox.hidden = true; sure.hidden = true; delNote.hidden = delIn.hidden = delRow.hidden = false; delIn.value = ''; delGo.disabled = true; sureYes.disabled = false; };
      delIn.addEventListener('input', () => { delGo.disabled = delIn.value.trim() !== 'DELETE'; });
      delNo.addEventListener('click', reset);
      sureNo.addEventListener('click', reset);
      del.addEventListener('click', () => { reset(); delBox.hidden = false; delIn.focus(); });
      delGo.addEventListener('click', () => {
        if (delIn.value.trim() !== 'DELETE') return;
        delNote.hidden = delIn.hidden = delRow.hidden = true;
        sure.hidden = false;
      });
      sureYes.addEventListener('click', async () => {
        if (delIn.value.trim() !== 'DELETE') return;
        sureYes.disabled = true;
        try {
          await api('delete', { confirm: 'DELETE' });
          setSession('', null);
          open({ msg: 'Your account is deleted. You can still restore this account within 14 days: just sign in again.' });
        } catch (e) { sureYes.disabled = false; say(e.message, 'err'); }
      });
      links.append(out, del);
      // stats and unlocks only on an active account (one that has paid; the server counts nothing before)
      // the legends board's lists: this account's places (wins made while signed in to it)
      const ranks = Array.isArray(a.legends) ? a.legends : [];
      const leg = ranks.length ? section('LEGENDS') : null;
      if (leg) {
        const MODE_NAME = { mixed: 'Run + Skate', run: 'Run only', ice: 'Skate only' };
        for (const r of ranks) {
          if (r.first) leg.appendChild(el('div', 'rka-note', `🏆 #${r.first} of the first 100 to beat ${MODE_NAME[r.mode] || r.mode}`));
          if (r.fastest) {
            const t = Math.max(0, Math.floor(r.total || 0));
            leg.appendChild(el('div', 'rka-note', `⏱ #${r.fastest} of the 100 fastest ${({ os: 'online solo ', ot: 'online team ', ls: 'local solo ', lt: 'local team ', oc: 'online chained ', lc: 'local chained ' })[r.list] || ''}games in ${MODE_NAME[r.mode] || r.mode} (${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')})`));
          }
        }
      }
      box.append(swag, ...(leg ? [leg] : []), ...(paid > 0 ? [unl, stats] : [guestBox()]), msg, closeBtn, links, delBox, fine(`${signedInAs(a)}. `));
      sayOpts();
      root.appendChild(modal);
      // fresh numbers (a game may have counted since this page loaded): redraw if the menu is still the one showing
      if (!opts.fresh) {
        const mine = modal;
        api('me').then((j) => { if (modal === mine && j.account) { A.account = j.account; open({ ...opts, fresh: true }); } }).catch(() => { /* keep what we have */ });
      }
      return;
    }

    // Amount picker
    box.append(el('h2', null, paid > 0 ? 'ADD SWAG' : 'CREATE SWAG ACCOUNT'),
      goldNote('rkr-gsub', paid > 0 ? `You have ${fmtPaid(paid)}. Add more any time, it only goes up.`
        : `Hi ${a.name || 'there'}! How much? Whatever you pick shows next to your kitty for everyone online (can toggle it on and off).`));
    let cents = 50;
    const amts = el('div', 'rka-amts');
    const btns = PRESETS.map((c) => {
      const b = el('button', 'rka-amt', fmtPaid(c));
      b.addEventListener('click', () => { cents = c; input.value = ''; sync(); });
      amts.appendChild(b);
      return [b, c];
    });
    const custom = el('label', 'rka-custom', symbol);
    const input = el('input');
    input.type = 'text'; input.inputMode = 'decimal'; input.placeholder = 'other';
    input.addEventListener('input', () => {
      // whole units and up to 2 decimals ("13.37" / "13,37"); anything else is not an amount yet
      const mm = /^\s*(\d{1,15})(?:[.,](\d{1,2}))?\s*$/.exec(input.value);
      cents = mm ? +mm[1] * 100 + +(mm[2] || '0').padEnd(2, '0') : 0; sync();
    });
    custom.appendChild(input);
    const pay = el('button', 'rkr-btn');
    const min = A.cfg.min, max = A.cfg.max;   // max: only Stripe's own per-payment limit
    function sync() {
      for (const [b, c] of btns) b.classList.toggle('rka-on', !input.value && c === cents);
      const ok = Number.isSafeInteger(cents) && cents >= min && cents <= max;
      pay.disabled = !ok;
      pay.textContent = ok ? (paid > 0 ? 'ADD ' : 'PAY ') + fmtPaid(cents) : cents > max ? 'TOO MUCH FOR ONE PAYMENT' : `MIN ${fmtPaid(min)}`;
      if (paid > 0 && ok) say(`New total: ${fmtPaid(paid + cents)}`);
    }
    pay.addEventListener('click', async () => {
      pay.disabled = true; say('Opening secure checkout…');
      try { location.href = (await api('pay', { cents, origin: location.origin })).url; } catch (e) { say(e.message, 'err'); pay.disabled = false; }
    });
    const back = el('button', 'rkr-btn rkr-alt', 'BACK');
    back.addEventListener('click', () => open());
    const row = el('div', 'rka-row');
    row.append(pay, back);
    box.append(amts, custom, row, msg,
      fine(`${signedInAs(a)}. One-time payment through Stripe, no subscription. Your total shows right away, so payments can't be refunded. `));
    sync();
    sayOpts();
    root.appendChild(modal);
  }

  // Solo / local co-op stats: picked up from the local game's events and sent in small batches (server: 'progress').
  // A cleared level counts for the team; crowns and revives only for kitty 1 (whoever is signed in on this device).
  let local = null, localT = null, dayTime = null;
  function sendLocal() {
    clearTimeout(localT); localT = null;
    const p = local; local = null;
    if (!p || !A.token || !A.account) return;
    api('progress', p).then((j) => { if (j.account) A.account = j.account; }).catch(() => { /* best effort */ });
  }
  function noteLocal(sim, events) {
    noteSolo(sim, events);   // (the offline unlock track: everyone, with an account or not)
    if (!A.enabled || !A.token || !A.account || !(Number(A.account.paid) > 0)) return;
    if (sim.hell) { noteHell(sim, events); return; }   // (hell: its own table, and its own board, main.js noteLevels)
    const me = sim.players[0];
    for (const e of events) {
      if (e.type === 'gameOver' || e.type === 'victory') { sendLocal(); dayTime = null; continue; }
      if (e.type === 'stageClear') { dayTime = { level: e.level, time: sim.levelTime }; continue; }   // Run + Skate's day half
      const t = e.type === 'levelStart' ? 'reached' : e.type === 'levelClear' ? 'clear'
        : e.type === 'crown' && me && e.playerId === me.id ? 'crown' : e.type === 'revive' && me && e.by === me.id ? 'revive' : null;
      if (!t) continue;
      if (local && (local.mode !== sim.mode || !!local.easy !== !!sim.easy)) sendLocal();
      local ||= { mode: sim.mode, reached: 0, clears: [], times: [], crowns: 0, revives: 0, ...(sim.easy ? { easy: true } : {}) };   // (an easy game: its own stats)
      const level = e.type === 'levelClear' ? e.level : (sim.levelData && sim.levelData.level) || sim.level;
      if (t === 'reached') local.reached = Math.max(local.reached, level);
      else if (t === 'clear') {
        local.reached = Math.max(local.reached, level); local.clears.push(level);
        local.times.push(sim.levelTime + (dayTime && dayTime.level === level ? dayTime.time : 0));
        dayTime = null;
      }
      else if (t === 'crown') local.crowns++;
      else local.revives++;
      if (t === 'clear' || local.crowns >= 3 || local.revives >= 100) sendLocal();
      else if (!localT) localT = setTimeout(sendLocal, 5000);
    }
  }

  // a solo / local hell game: its cleared hell levels (with times), a win when all of hell is cleared, crowns and revives
  // (server 'progress' with hell: true)
  function noteHell(sim, events) {
    const me = sim.players[0];
    for (const e of events) {
      if (e.type === 'gameOver' || e.type === 'victory') {
        if (e.type === 'victory') { local ||= hellBatch(sim); local.won = true; }
        sendLocal(); continue;
      }
      const t = e.type === 'levelClear' ? 'clear' : e.type === 'crown' && me && e.playerId === me.id ? 'crown' : e.type === 'revive' && me && e.by === me.id ? 'revive' : null;
      if (!t) continue;
      if (local && (!local.hell || local.mode !== sim.mode || !!local.easy !== !!sim.easy)) sendLocal();
      local ||= hellBatch(sim);
      if (t === 'clear') { local.clears.push(e.level); local.times.push(sim.levelTime); }
      else if (t === 'crown') local.crowns++;
      else local.revives++;
      if (t === 'clear' || local.crowns >= 3 || local.revives >= 100) sendLocal();
      else if (!localT) localT = setTimeout(sendLocal, 5000);
    }
  }
  const hellBatch = (sim) => ({ hell: true, mode: sim.mode, clears: [], times: [], crowns: 0, revives: 0, ...(sim.easy ? { easy: true } : {}) });

  return {
    init, open, close, noteLocal,
    isOpen: () => !!modal,
    enabled: () => A.enabled,
    token: () => A.token,
    signedIn: () => !!(A.token && A.account),
    paid: () => (A.account ? Number(A.account.paid) || 0 : 0),
    display: () => (A.account ? Number(A.account.display) || Number(A.account.paid) || 0 : 0),   // the number shown next to the kitty (the total, or a lower one picked)
    shown: () => !A.account || A.account.show !== false,
    paidStyle: () => (A.account && A.account.style === 'koi' ? 'koi' : ''),   // how the number is drawn ('koi': the koi fish)   // the player's "shown online" switch
    onChange(fn) { changeFn = fn; },
    // an unlock this player has (an active account's, or this browser's), switched on or not (songs: settings.js)
    // fresh unlocks (a game was just won online): the account's, or this browser's
    async refresh() {
      if (A.token && A.account) { try { const j = await api('me'); if (j.account) { A.account = j.account; changed(); } } catch { /* keep what we have */ } }
      else loadGuest();
    },
    hellOpen: hellOpenHere,   // (hellOpenHere)
    has(id) {
      const u = (A.account && Number(A.account.paid) > 0 && A.account.unlocks) || A.guest;
      return (!!u && isUnlocked(u, id)) || isUnlocked(soloProg(), id);   // (online or offline: the song is your own)
    },
    // the unlocks worn offline (Solo / Local) in this mode: earned online or offline (each mode its own), switched on
    equipped(mode) {
      if (eqFor !== A.account || eqGuest !== A.guest || eqMode !== mode || eqSolo !== soloVer) {
        eqFor = A.account; eqGuest = A.guest; eqMode = mode; eqSolo = soloVer;
        const u = (A.account && Number(A.account.paid) > 0 && A.account.unlocks) || A.guest || {};
        const solo = soloProg(), off = { ...(u.off || {}), ...soloOff() };
        eqSet = new Set(UNLOCKS.filter((x) => !x.song && (isUnlocked(u, x, mode) || isUnlocked(solo, x, mode)) && isWorn(x, off)).map((x) => x.id));
      }
      return eqSet;
    },
  };
}

export { createAccount, fmtPaid, fmtNum };
