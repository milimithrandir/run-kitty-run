// Anonymous play stats: a random id per browser (localStorage), a few events to POST /api/event,
// and the title screen's STATS page (GET /api/stats). No names, no tracking across sites.
import { apiUrl, PLATFORM } from './platform.js';
import { TOUCH } from './device.js';

function clientId() {
  try {
    let id = localStorage.getItem('rkr-cid');
    if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
      localStorage.setItem('rkr-cid', id);
    }
    return id;
  } catch { return 'anon' + Math.random().toString(36).slice(2, 12); }
}
const CID = clientId();
const DEVICE = PLATFORM === 'ios' || PLATFORM === 'android' ? PLATFORM : TOUCH ? 'touch' : 'desktop';

function send(ev, data) {
  const body = JSON.stringify({ cid: CID, ev, device: DEVICE, ...data });
  try {
    fetch(apiUrl('/api/event'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* offline / blocked: stats are best-effort */ }
}

// One "run" = one kitty's game from start to game over (or back to the menu).
let run = null;
const analytics = {
  visit() { send('visit'); },
  // chain: false, true (pairs) or 'all' (everyone on one chain)
  runStart(kind, mode, hell = false, chain = false, easy = false, versus = false) {
    if (run) analytics.runEnd();
    run = { t0: performance.now() };
    send('run_start', { kind, mode, ...(hell ? { hell: true } : {}), ...(chain ? { chain: chain === 'all' ? 'all' : true } : {}), ...(easy ? { easy: true } : {}), ...(versus ? { versus: true } : {}) });
  },
  level(level) { if (run) send('level', { level }); },
  levelMismatch(mode, level, ver, what) { send('level_mismatch', { mode, level, ver, what }); },   // what: 'items' | 'wolves' | 'items+wolves'
  runEnd(s = {}) {
    if (!run) return;
    send('run_end', { seconds: (performance.now() - run.t0) / 1000, deaths: s.deaths | 0, rescues: s.rescues | 0, ...(s.won ? { won: true } : {}) });
    run = null;
  },
};

// ---------------------------------------------------------------- STATS page

const CSS = `
.rks-modal{z-index:40;}
.rks-box{max-width:860px;width:min(92vw,860px);max-height:90vh;overflow:auto;text-align:center;background:linear-gradient(160deg,rgba(52,30,96,.97),rgba(26,12,52,.97)) !important;}
.rks-box h2{font-size:clamp(30px,4.5vw,44px) !important;margin:0;}
.rks-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;width:100%;}
.rks-tile{background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.12);border-radius:16px;padding:10px 8px;}
.rks-v{font-size:30px;font-weight:900;color:#fff6d8;line-height:1.1;}
.rks-l{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#ffcf5a;opacity:.9;margin-top:2px;}
.rks-chart{width:100%;background:rgba(10,4,30,.45);border-radius:16px;border:2px solid rgba(255,255,255,.1);}
.rks-h{font-size:13px;font-weight:900;letter-spacing:.14em;color:#ffcf5a;text-transform:uppercase;margin:4px 0 -4px;}
.rks-split{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.rks-pill{font-size:14px;font-weight:800;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.08);}
.rks-pill b{color:#fff6d8;}
.rks-bars{display:flex;flex-direction:column;gap:6px;width:100%;}
.rks-h.rks-hellh{color:#ff8a5c;}
.rks-hellbars .rks-fill{background:linear-gradient(90deg,#ff5c3a,#ffb08f) !important;}
.rks-h.rks-chainh{color:#c9b6ff;}
.rks-chainbars .rks-fill{background:linear-gradient(90deg,#9b7dff,#d6c8ff) !important;}
.rks-h.rks-vsh{color:#ffb39a;}
.rks-vsbars .rks-fill{background:linear-gradient(90deg,#ff8a5c,#ffc9a8) !important;}
.rks-bar{display:grid;grid-template-columns:190px 1fr 92px;gap:10px;align-items:center;font-weight:800;font-size:14px;text-align:left;}
.rks-track{height:16px;border-radius:8px;background:rgba(255,255,255,.08);overflow:hidden;}
.rks-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,#ffcf5a,#ff9ec4);}
.rks-num{text-align:right;color:#fff6d8;}
.rks-num small{opacity:.6;font-weight:700;}
.rks-note{font-size:12px;opacity:.6;}
.rks-err{color:#ff8fa3;font-weight:800;}
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0));
function fmtTime(sec) {
  const h = sec / 3600;
  if (h >= 1) return (h >= 100 ? Math.round(h) : h.toFixed(1)) + ' h';
  return Math.round(sec / 60) + ' min';
}

// Cumulative players (line, left axis) over the time played each day (bars, right axis: hours of kitty time).
function drawChart(canvas, days) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const padL = 44, padR = 46, padT = 16, padB = 26, BAR_H = 0.55;   // (the bars fill the lower part)
  const w = W - padL - padR, h = H - padT - padB;
  g.font = '700 11px system-ui, sans-serif';
  // only days that are over: today's is still being counted (the server's days are UTC)
  const today = new Date().toISOString().slice(0, 10);
  days = days.filter((d) => d.day < today);
  if (!days.length) { g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText('No data yet', W / 2 - 30, H / 2); return; }
  let cum = 0;
  const pts = days.map((d) => ({ day: d.day, cum: (cum += d.newPlayers), hours: (d.seconds || 0) / 3600 }));
  const maxCum = Math.max(1, ...pts.map((p) => p.cum)), maxHrs = Math.max(0.5, ...pts.map((p) => p.hours));
  const n = pts.length, step = w / Math.max(1, n);
  // grid + left axis (cumulative)
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.fillStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + h - (h * i) / 4;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + w, y); g.stroke();
    g.fillText(fmt(Math.round((maxCum * i) / 4)), 6, y + 4);
  }
  // time played that day: bars, with their own scale on the right
  g.fillStyle = 'rgba(110,198,255,.45)';
  pts.forEach((p, i) => { const bh = (p.hours / maxHrs) * h * BAR_H; g.fillRect(padL + i * step + step * 0.18, padT + h - bh, Math.max(1, step * 0.64), bh); });
  g.fillStyle = 'rgba(110,198,255,.8)';
  for (const f of [0.5, 1]) { const v = maxHrs * f; g.fillText((v >= 10 ? Math.round(v) : v.toFixed(1)) + ' h', padL + w + 6, padT + h - h * BAR_H * f + 4); }
  // cumulative line
  g.strokeStyle = '#ffcf5a'; g.lineWidth = 3; g.lineJoin = 'round';
  g.beginPath();
  pts.forEach((p, i) => { const x = padL + i * step + step / 2, y = padT + h - (p.cum / maxCum) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  // x labels: first, middle, last day
  g.fillStyle = 'rgba(255,255,255,.55)';
  for (const i of [...new Set([0, Math.floor((n - 1) / 2), n - 1])]) {
    const x = padL + i * step + step / 2;
    g.fillText(pts[i].day.slice(5), Math.min(W - 40, Math.max(padL - 10, x - 16)), H - 8);
  }
  // legend
  g.fillStyle = '#ffcf5a'; g.fillRect(padL + 6, padT - 10, 14, 4);
  g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText('total players', padL + 24, padT - 5);
  g.fillStyle = 'rgba(110,198,255,.7)'; g.fillRect(padL + 120, padT - 12, 10, 8);
  g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText('time played that day', padL + 136, padT - 5);
}

// the soundtrack's average song length (music/catjam2-3.mp3: 3:05 and 3:23): songs played = time played / this
const SONG_SECONDS = 194;

// which hell modes are open for this player (main.js: the account / this browser): only they see hell's numbers
let hellModes = () => [];
const setHellModes = (fn) => { hellModes = fn; };

let styled = false;
function openStatsPage(root) {
  if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
  const modal = el('div', 'rkr-overlay rkr-dim rks-modal');
  const box = el('div', 'rkr-glass rks-box');
  const close = el('button', 'rkr-btn rkr-alt rkl-small', 'CLOSE');
  const shut = () => { modal.remove(); window.removeEventListener('keydown', onKey, true); };
  // every key stays in the window (the title screen underneath would start a game on Enter)
  const onKey = (e) => { e.stopPropagation(); if (e.key === 'Escape') shut(); };
  close.addEventListener('click', shut);
  modal.addEventListener('click', (e) => { if (e.target === modal) shut(); });
  window.addEventListener('keydown', onKey, true);
  const body = el('div', null, 'Loading…');
  body.style.cssText = 'display:flex;flex-direction:column;gap:12px;width:100%;';
  box.append(el('h2', null, 'STATS'), body, close);
  modal.appendChild(box);
  root.appendChild(modal);

  fetch(apiUrl('/api/stats'), { cache: 'no-store' }).then((r) => r.json()).then((d) => {
    body.textContent = '';
    const T = d.totals;
    const tiles = [
      [fmt(d.players), 'players ever'], [fmt(d.playersToday), 'played today'], [fmt(d.onlineNow), 'online now'],
      [fmt(T.runs), 'runs played'], [fmt(T.levels), 'levels cleared'], [fmtTime(T.seconds), 'time played'],
      [fmt(T.rescues), 'kitties rescued'], [fmt(T.deaths), 'times caught'], [fmt(Math.floor((T.seconds || 0) / SONG_SECONDS)), 'songs played'],
      [fmt(T.lobbies), 'lobbies created'], [fmt(T.onlineGames), 'online games'], [fmt(d.peakOnline.count), 'most online at once'],
    ];
    const grid = el('div', 'rks-grid');
    for (const [v, l] of tiles) { const t = el('div', 'rks-tile'); t.append(el('div', 'rks-v', v), el('div', 'rks-l', l)); grid.appendChild(t); }
    const cv = el('canvas', 'rks-chart');
    cv.style.height = '200px';
    const pills = (title, obj, names) => {
      const wrap = el('div', 'rks-split');
      const tot = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
      for (const [k, v] of Object.entries(obj)) {
        const p = el('span', 'rks-pill');
        p.append((Object.hasOwn(names, k) ? names[k] : k) + ' ', el('b', null, `${Math.round((v / tot) * 100)}%`));
        wrap.appendChild(p);
      }
      return [el('div', 'rks-h', title), wrap];
    };
    // every way to play, in runs started, named like the main menu's buttons (LOCAL: solo and co-op together;
    // MULTIPLAYER split by the lobby's mode)
    const played = [
      ['Local (solo / co-op)', (d.kinds.solo || 0) + (d.kinds.coop || 0)],
      ['Multiplayer · Run + Skate', d.modes.mixed], ['Multiplayer · Run only', d.modes.run], ['Multiplayer · Skate only', d.modes.ice],
    ];
    // hell (only for players who have it open; counted since 2026-10-24): games per hell mode, and how many online,
    // on the same scale as the modes above
    const hm = d.hell ? hellModes() : [];
    const hellRows = [['run', 'Hell Run'], ['ice', 'Hell Skate']].filter(([m]) => hm.includes(m));
    const totalRuns = played.reduce((a, [, v]) => a + (v || 0), 0) || 1;
    const topRuns = Math.max(1, ...played.map(([, v]) => v || 0), ...hellRows.map(([m]) => d.hell.games[m] || 0), (d.chain && d.chain.games) || 0);
    const bars = el('div', 'rks-bars');
    for (const [name, v] of played) {
      const row = el('div', 'rks-bar');
      const track = el('div', 'rks-track'), fill = el('div', 'rks-fill');
      fill.style.width = ((v || 0) / topRuns) * 100 + '%';
      track.appendChild(fill);
      const num = el('div', 'rks-num');
      num.append(fmt(v || 0) + ' ', el('small', null, `${Math.round(((v || 0) / totalRuns) * 100)}%`));
      row.append(el('div', null, name), track, num);
      bars.appendChild(row);
    }
    const hellPart = [];
    if (hellRows.length) {
      const H = d.hell;
      const hb = el('div', 'rks-bars rks-hellbars');
      for (const [m, name] of hellRows) {
        const g = H.games[m] || 0, row = el('div', 'rks-bar');
        const track = el('div', 'rks-track'), fill = el('div', 'rks-fill');
        fill.style.width = (g / topRuns) * 100 + '%';
        track.appendChild(fill);
        const num = el('div', 'rks-num');
        num.append(fmt(g) + ' ', el('small', null, `${fmt(H.online[m] || 0)} online`));
        row.append(el('div', null, name), track, num);
        hb.appendChild(row);
      }
      hellPart.push(el('div', 'rks-h rks-hellh', 'Hell (games)'), hb);
    }
    // chained games (any mode; also counted above), and how many online
    const chainPart = [];
    if (d.chain) {
      const cb = el('div', 'rks-bars rks-chainbars'), row = el('div', 'rks-bar');
      const track = el('div', 'rks-track'), fill = el('div', 'rks-fill');
      fill.style.width = ((d.chain.games || 0) / topRuns) * 100 + '%';
      track.appendChild(fill);
      const num = el('div', 'rks-num');
      num.append(fmt(d.chain.games || 0) + ' ', el('small', null, `${fmt(d.chain.online || 0)} online`));
      row.append(el('div', null, '⛓ Chained'), track, num);
      cb.appendChild(row);
      chainPart.push(el('div', 'rks-h rks-chainh', 'Chained (games)'), cb);
    }
    // versus games (online; also counted above)
    if (d.versus && d.versus.games > 0) {
      const vb = el('div', 'rks-bars rks-vsbars'), row = el('div', 'rks-bar');
      const track = el('div', 'rks-track'), fill = el('div', 'rks-fill');
      fill.style.width = Math.min(100, (d.versus.games / topRuns) * 100) + '%';
      track.appendChild(fill);
      row.append(el('div', null, '⚔ Versus'), track, el('div', 'rks-num', fmt(d.versus.games)));
      vb.appendChild(row);
      chainPart.push(el('div', 'rks-h rks-vsh', 'Versus (games)'), vb);
    }
    body.append(
      grid,
      el('div', 'rks-h', 'Players and time played'), cv,
      el('div', 'rks-h', 'Modes played (runs)'), bars,
      ...hellPart,
      ...chainPart,
      ...pills('Devices', d.devices, { desktop: 'Computer', touch: 'Phone / tablet', ios: 'iOS app', android: 'Android app' }),
      el('div', 'rks-note', `Counting since ${d.since}. Anonymous: each browser gets a random id, nothing else is stored.`),
    );
    drawChart(cv, d.days || []);
  }).catch(() => { body.textContent = ''; body.appendChild(el('div', 'rks-err', "Couldn't load the stats right now.")); });
}

export { analytics, openStatsPage, setHellModes };
