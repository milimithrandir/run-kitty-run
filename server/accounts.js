// Optional player accounts: sign in with Google, chip in any amount (min 0.50) through Stripe Checkout, and the total
// you've paid shows next to your kitty's name online (a lowkey flex). Nothing else depends on an account.
// An account only counts once something is paid; signing in alone just lets you pay.
//
// No SDKs: Google ID tokens are checked against Google's public keys (JWKS) with node:crypto, and Stripe is plain
// HTTPS (fetch) plus its webhook signature (HMAC). State is one JSON file, saved atomically like legends.json;
// every credited payment is also appended to payments.jsonl next to it (bookkeeping, never rewritten).
//
// Sign in with Discord is a plain OAuth2 code flow run here (GET /api/account/discord -> Discord -> .../discord/callback);
// those accounts are keyed 'discord_<user id>' (Google ones stay keyed by the bare Google id) and have no email.
//
// Env: GOOGLE_CLIENT_ID (comma-separate several: web + iOS/Android clients), DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET
// (optional: without them there's no Discord button), STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, PUBLIC_ORIGIN (where Checkout returns to, default https://runkittyrun.fun), CURRENCY (default eur).
// Without GOOGLE_CLIENT_ID + STRIPE_SECRET_KEY accounts are off and the client hides the button.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UNLOCKS, UNLOCK_MODES, FEAT_IDS, isUnlocked, isWorn, hellOpen } from '../public/js/shared/unlocks.js';
import { HELL_LEVELS, HELL_MODES } from '../public/js/shared/config.js';

const MIN_CENTS = 50;              // Stripe's minimum charge (EUR / USD; the account settles in EUR, so a USD charge must clear €0.50)
// No cap of our own: this is only the largest amount Stripe's API takes (8 digits); card / payment-method limits still apply
const STRIPE_MAX_CENTS = 99999999;
const MAX_SESSIONS = 10;           // signed-in devices per account
const GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com'];
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
// The Stripe account is shared with other projects, and a webhook endpoint gets every project's events: only sessions
// this server created (bound in `checkouts`) and marked with APP are ever credited.
const APP = 'run-kitty-run';
const CHECKOUT_KEEP_MS = 30 * 864e5;   // an unpaid binding is forgotten after this (async methods like SEPA can take days)
// Pinned per request so the shared account's default API version never matters (branding_settings needs 2025-09-30+)
const STRIPE_VERSION = '2026-08-26.dahlia';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function createAccounts(file, env = process.env) {
  const clientIds = String(env.GOOGLE_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stripeKey = env.STRIPE_SECRET_KEY || '';
  const hookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const origins = new Set([env.PUBLIC_ORIGIN || 'https://runkittyrun.fun',
    ...(env.NODE_ENV === 'production' ? [] : [`http://localhost:${env.PORT || 8080}`, `http://127.0.0.1:${env.PORT || 8080}`])]);
  const enabled = !!(clientIds.length && stripeKey);
  const discordId = env.DISCORD_CLIENT_ID || '', discordSecret = env.DISCORD_CLIENT_SECRET || '';
  const discordOn = enabled && !!(discordId && discordSecret);
  const CURRENCY = /^[a-z]{3}$/.test(env.CURRENCY || '') ? env.CURRENCY : 'eur';   // one currency for everyone, so totals compare
  const paymentsFile = file.replace(/[^/]*$/, 'payments.jsonl');
  const LIVE = /^(sk|rk)_live_/.test(stripeKey);   // a test-mode session never credits a live server, and vice versa

  // sub (Google user id, or 'discord_<id>') -> { sub, email, name, paid (cents), created, sessions: [sha256 of token], payments: [stripe session ids],
  //   hide (true = the total isn't shown to other players), stats: { online, local } (see "stats" below) }
  let accounts = {};
  // Checkout Session id -> { sub, cents, at }: written when this server creates the session, removed once credited
  let checkouts = {};
  // players without an active account: unlock progress under their browser's random progress id (shared/unlocks.js),
  // { unlocks, at (last seen, ms) }; moved onto their account when they activate one (mergeGuest)
  let guests = {};
  let dirty = false;
  // Tighten files from older deployments too. An unreadable or corrupt store is not a new account store.
  for (const p of [file, paymentsFile, file + '.tmp']) {
    try {
      if (!fs.lstatSync(p).isFile()) throw new Error('account storage must be a regular file: ' + p);
      fs.chmodSync(p, 0o600);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old && old.accounts && typeof old.accounts === 'object') accounts = old.accounts;
    if (old && old.checkouts && typeof old.checkouts === 'object') checkouts = old.checkouts;
    if (old && old.guests && typeof old.guests === 'object') guests = old.guests;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = () => JSON.stringify({ accounts, checkouts, guests });
  // guest progress nobody has played online with for two months goes (at start, then daily)
  const GUEST_KEEP_MS = 61 * 864e5;
  function pruneGuests() {
    let n = 0;
    for (const [k, g] of Object.entries(guests)) if (!g || !(Date.now() - (g.at || 0) < GUEST_KEEP_MS)) { delete guests[k]; n++; }
    return n;
  }
  // a deleted account is kept (hidden, signed out everywhere) for DELETE_KEEP_MS so its owner can restore it by signing
  // in again; then it goes for good (at start, then daily)
  const DELETE_KEEP_MS = 14 * 864e5;
  const deleteGone = (a) => a && a.deleting && !(Date.now() - a.deleting < DELETE_KEEP_MS);
  function pruneDeleted() {
    let n = 0;
    for (const [k, a] of Object.entries(accounts)) if (deleteGone(a)) { delete accounts[k]; n++; }
    return n;
  }
  pruneGuests(); pruneDeleted();
  setInterval(() => { if (pruneGuests() + pruneDeleted()) { statsChanged(); reindex(); } }, 864e5).unref();
  // One synchronous writer: no old asynchronous snapshot can overwrite a newer payment or revocation.
  // Failures propagate to the caller; a Checkout URL must never escape without its saved binding.
  function saveNow() {
    dirty = true;
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, state());
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    dirty = false;
  }
  let statsT = null;   // stats are saved a moment after they change (a full synchronous save, so never a stale one)
  function flush() {
    if (statsT) { clearTimeout(statsT); statsT = null; dirty = true; }
    if (dirty) saveNow();
  }
  // payments.jsonl is the record of truth for money: credit any logged payment the account file missed (a crash
  // between the two writes). Deleted accounts stay deleted.
  (function recover() {
    let lines = [];
    try { lines = fs.readFileSync(paymentsFile, 'utf8').split('\n'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    let n = 0;
    for (const l of lines) {
      let p; try { p = JSON.parse(l); } catch { continue; }
      if (p && checkouts[p.session]) { delete checkouts[p.session]; n++; }
      const a = p && accounts[p.sub];
      if (!a || (a.payments || []).includes(p.session)) continue;
      a.payments = [...(a.payments || []), p.session];
      a.paid = (Number(a.paid) || 0) + (Number(p.amount) || 0);
      n++;
    }
    if (n) { console.log('accounts: recovered payments from payments.jsonl'); saveNow(); }
  })();
  function pruneCheckouts() {
    const old = Date.now() - CHECKOUT_KEEP_MS;
    let pruned = false;
    for (const [id, c] of Object.entries(checkouts)) if (!(c.at > old)) { delete checkouts[id]; pruned = true; }
    if (pruned || dirty) {
      try { saveNow(); } catch (e) { console.error('accounts save failed:', e.message); }
    }
  }
  setInterval(pruneCheckouts, 6 * 3600e3).unref();
  const byToken = new Map();   // sha256(token) -> sub
  const reindex = () => { byToken.clear(); for (const a of Object.values(accounts)) for (const h of a.sessions || []) byToken.set(h, a.sub); };
  reindex();

  // ---- Google ----
  let jwks = { keys: new Map(), until: 0, at: 0 };
  async function googleKey(kid) {
    if (Date.now() > jwks.until || !jwks.keys.has(kid)) {
      // an unknown kid refetches the keys (rotation), but not more than once a minute: a made-up kid shouldn't
      // turn every bad token into a request to Google
      if (!jwks.keys.has(kid) && Date.now() - jwks.at < 60e3 && Date.now() <= jwks.until) return null;
      jwks.at = Date.now();
      const r = await fetch(JWKS_URL);
      if (!r.ok) throw new Error('google keys ' + r.status);
      const maxAge = +((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1] || 3600);
      const j = await r.json();
      jwks = { keys: new Map(j.keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])), until: Date.now() + maxAge * 1000, at: Date.now() };
    }
    return jwks.keys.get(kid);
  }
  // a Google ID token (from Sign in with Google) -> its claims, or throws
  async function verifyGoogle(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('bad token');
    const head = b64json(parts[0]), claims = b64json(parts[1]);
    if (head.alg !== 'RS256') throw new Error('bad alg');
    const key = await googleKey(head.kid);
    if (!key || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
    const now = Date.now() / 1000;
    if (!GOOGLE_ISS.includes(claims.iss) || !clientIds.includes(claims.aud) || !(claims.exp > now) || !claims.sub) throw new Error('bad claims');
    return claims;
  }

  // ---- Discord ----
  // state -> { origin, at }: one per sign-in started here (the browser also holds it in a cookie, so a callback only
  // signs in the browser that started it); handoff code -> { token, at }: the callback hands the session token to the
  // page through a one-time code in the URL fragment, never the token itself
  const discordStates = new Map(), handoffs = new Map();
  const FLOW_MS = 10 * 60e3, HANDOFF_MS = 2 * 60e3;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of discordStates) if (now - v.at > FLOW_MS) discordStates.delete(k);
    for (const [k, v] of handoffs) if (now - v.at > HANDOFF_MS) handoffs.delete(k);
  }, 60e3).unref();
  const STATE_COOKIE = 'rkr_discord';
  const discordRedirect = (origin) => origin + '/api/account/discord/callback';
  // a Discord authorization code -> the Discord user ({ id, username, global_name }), or throws
  async function discordUser(code, origin) {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(discordId + ':' + discordSecret).toString('base64') },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: discordRedirect(origin) }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new Error('discord token ' + r.status + ' ' + (t.error || ''));
    const u = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + t.access_token } });
    const j = await u.json().catch(() => ({}));
    if (!u.ok || !/^\d{1,25}$/.test(String(j.id || ''))) throw new Error('discord user ' + u.status);
    // we only needed who it is: hand the access token back (best effort)
    fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(discordId + ':' + discordSecret).toString('base64') },
      body: new URLSearchParams({ token: t.access_token, token_type_hint: 'access_token' }),
    }).catch(() => {});
    return j;
  }
  // GET /api/account/discord?origin=...: off to Discord's consent screen
  function discordStart(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const origin = origins.has(q.get('origin')) ? q.get('origin') : [...origins][0];
    if (!discordOn) { res.writeHead(302, { Location: origin + '/#signin-error=off', 'Cache-Control': 'no-store' }).end(); return; }
    const state = crypto.randomBytes(18).toString('base64url');
    discordStates.set(state, { origin, at: Date.now() });
    const to = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: discordId, scope: 'identify', state, redirect_uri: discordRedirect(origin), prompt: 'none',
    });
    res.writeHead(302, {
      Location: to, 'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/api/account/discord; Max-Age=600; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`,
    }).end();
  }
  // GET /api/account/discord/callback?code&state: back from Discord; signs in and returns to the game
  async function discordCallback(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const state = String(q.get('state') || '');
    const cookie = (new RegExp('(?:^|;\\s*)' + STATE_COOKIE + '=([\\w-]+)').exec(req.headers.cookie || '') || [])[1];
    const flow = discordStates.get(state);
    discordStates.delete(state);
    const back = (hash) => res.writeHead(302, {
      Location: ((flow && flow.origin) || [...origins][0]) + '/#' + hash, 'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=; Path=/api/account/discord; Max-Age=0; HttpOnly; SameSite=Lax`,
    }).end();
    if (!flow || !cookie || cookie !== state || Date.now() - flow.at > FLOW_MS) return back('signin-error=expired');
    if (q.get('error')) return back('signin-error=' + (q.get('error') === 'access_denied' ? 'denied' : 'failed'));
    const code = String(q.get('code') || '');
    if (!/^[\w-]{10,100}$/.test(code)) return back('signin-error=failed');
    let u;
    try { u = await discordUser(code, flow.origin); } catch (e) { console.error('discord sign-in failed:', e.message); return back('signin-error=failed'); }
    const sub = 'discord_' + u.id;
    if (deleteGone(accounts[sub])) delete accounts[sub];   // (its grace period is over: a new account)
    const a = accounts[sub] ||= { sub, via: 'discord', email: '', name: '', paid: 0, created: new Date().toISOString(), sessions: [], payments: [] };
    a.name = cleanName(u.global_name || u.username);
    let token;
    try { token = newSession(a); } catch (e) { console.error('discord sign-in failed:', e.message); return back('signin-error=failed'); }
    const handoff = crypto.randomBytes(18).toString('base64url');
    handoffs.set(handoff, { token, at: Date.now() });
    back('signin=' + handoff);
  }

  // ---- Stripe ----
  function form(obj, pre = '', out = []) {
    for (const [k, v] of Object.entries(obj)) {
      const key = pre ? `${pre}[${k}]` : k;
      if (v && typeof v === 'object') form(v, key, out);
      else if (v != null) out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    }
    return out.join('&');
  }
  async function stripe(method, path, body) {
    const r = await fetch('https://api.stripe.com/v1' + path, {
      method,
      headers: { Authorization: 'Bearer ' + stripeKey, 'Stripe-Version': STRIPE_VERSION, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? form(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'stripe ' + r.status);
    return j;
  }

  // ---- accounts ----
  // A swag account is active once it has paid (one payment of at least MIN_CENTS): only then are its stats and unlock
  // progress counted and its switched-on unlocks shown. Signing in alone is free (it's how the payment finds the account).
  // (a deleted account waiting out its grace period is not active: nothing shown or counted)
  const active = (a) => (Number(a && a.paid) || 0) > 0 && !(a && a.deleting);
  // the number shown next to the kitty: the total paid, or a lower one the player picked ('display' route: 1 cent up to
  // the total)
  const shownCents = (a) => { const paid = Number(a && a.paid) || 0, d = Number(a && a.display); return Number.isInteger(d) && d >= 1 && d <= paid ? d : paid; };
  // the account's places on the legends board's lists (index.js hands in legends.ranksFor)
  let legendRanks = () => [];
  const setLegendRanks = (fn) => { legendRanks = fn; };
  // ever number 1 on the legends board (index.js hands in legends.goldenFor): the golden kitty, in every mode
  let goldenCheck = () => false;
  const setGoldenCheck = (fn) => { goldenCheck = fn; };
  // number 1 of a fastest list (index.js hands in legends.bronzeFor): the bronze kitty, in every mode
  let bronzeCheck = () => false;
  const setBronzeCheck = (fn) => { bronzeCheck = fn; };
  const pub = (a) => (a ? { name: a.name, email: a.email, via: a.via || 'google', paid: Number(a.paid) || 0, display: shownCents(a), active: active(a), show: !a.hide, style: a.style === 'koi' ? 'koi' : 'classic', unlocks: unlocksOf(a),
    legends: legendRanks(a),
    deleting: a.deleting ? new Date(a.deleting + DELETE_KEEP_MS).toISOString() : null,   // deleted: gone for good at this time
    stats: { online: (a.stats && a.stats.online) || blankStats(), local: (a.stats && a.stats.local) || blankStats(), easy: (a.stats && a.stats.easy) || blankStats(), easyLocal: (a.stats && a.stats.easyLocal) || blankStats() } } : null);
  function newSession(a) {
    const token = crypto.randomBytes(24).toString('base64url');
    const h = sha(token);
    const previous = a.sessions;
    a.sessions = [...(a.sessions || []), h].slice(-MAX_SESSIONS);
    try { saveNow(); } catch (e) { a.sessions = previous; throw e; }
    reindex();
    return token;
  }
  const fromToken = (token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
    const sub = byToken.get(sha(token));
    return (sub && accounts[sub]) || null;
  };
  // total paid (cents) for a session token, 0 if none / unpaid / hidden: what the game server shows next to the name
  const paidFor = (token) => { const a = fromToken(token); return a && !a.hide && !a.deleting ? shownCents(a) : 0; };
  // how the number is drawn for everyone: 'koi' (the koi fish) or '' (the classic tag)
  const paidStyleFor = (token) => { const a = fromToken(token); return a && a.style === 'koi' ? 'koi' : ''; };
  // the account id behind a session token (the game server keeps this per player instead of the token itself)
  const subFor = (token) => { const a = fromToken(token); return a ? a.sub : null; };
  // has this account played level 9 (its stats, online or local or easy)? (the level boards open level 9's board)
  const reachedFinal = (sub) => {
    const st = sub && accounts[sub] && accounts[sub].stats;
    return !!st && ['online', 'local', 'easy', 'easyLocal'].some((k) => st[k] && Object.values(st[k].reached || {}).some((v) => v >= 9));
  };
  // hell open in this mode for this player (who: { sub, pid }): its unlock progress (online or offline: r9 / h1), or an
  // account's stats saying it reached level 9 (in any mode) before hell existed
  function hellOpenFor(who, mode) {
    const h = holderOf(who, false);
    if (h) { const u = unlocksOf(h); if (hellOpen(u, mode) || hellOpen(u.solo, mode)) return true; }
    const st = who && who.sub && accounts[who.sub] && accounts[who.sub].stats;
    return !!st && ['online', 'local', 'easy', 'easyLocal'].some((k) => { const r = st[k] && st[k].reached; return !!r && Object.values(r).some((v) => (v | 0) >= 9); });   // (level 9 in any mode)
  }
  // every account whose number shows (not hidden, not being deleted): [[sub, cents]] (the boards show it on a name's hover)
  const shownAll = () => Object.values(accounts).filter((a) => a && a.sub && !a.hide && !a.deleting && shownCents(a) > 0).map((a) => [a.sub, shownCents(a)]);

  // ---- stats (the account menu) ----
  // Two separate sets: 'online' is counted by this server from the online games it runs; 'local' (solo / local co-op)
  // is reported by the player's own browser, so the menu shows it apart as numbers anyone could edit. Easy games (a level
  // starts over when everyone is down) have their own two: 'easy' the online ones ('easyLocal' the solo / local ones,
  // reported by the browser: since 2026-10-24; before, 'easy' had both, online and offline ones together); their revives count
  // in the usual set too.
  // { clears: { mode: { level: times the team cleared it } }, reached: { mode: highest level played }, crowns, revives }
  // best: the fastest clear per mode and level, in seconds (Run + Skate: the day and night halves together)
  // hell: { clears: { run / ice: { hell level: times cleared } }, best: { ...: { hell level: fastest } }, wins: { run / ice: escapes },
  // crowns, revives (in hell games: their own counts, not in the ones above; the revive unlocks count them all, recordFeat) }
  const blankHell = () => ({ clears: { run: {}, ice: {} }, best: { run: {}, ice: {} }, wins: { run: 0, ice: 0 }, crowns: 0, revives: 0 });
  // versus: { games, wins } (online games: the server's vsResults)
  function blankStats() { return { clears: { run: {}, ice: {}, mixed: {} }, reached: { run: 0, ice: 0, mixed: 0 }, best: { run: {}, ice: {}, mixed: {} }, crowns: 0, revives: 0, hell: blankHell(), versus: { games: 0, wins: 0 } }; }
  const STAT_MODES = ['run', 'ice', 'mixed'], MAX_LEVEL = 9;
  const MIN_TIME = 5, MAX_TIME = 4 * 3600;   // a clear time outside this is ignored (seconds)
  function statsOf(a, kind) {
    a.stats ||= {};
    const s = a.stats[kind] ||= blankStats();
    s.best ||= {};
    for (const m of STAT_MODES) { s.clears[m] ||= {}; s.reached[m] ||= 0; s.best[m] ||= {}; }
    s.hell ||= blankHell();
    s.hell.crowns ||= 0; s.hell.revives ||= 0;
    s.versus ||= { games: 0, wins: 0 };
    return s;
  }
  function statsChanged() {
    if (statsT) return;
    statsT = setTimeout(() => {
      statsT = null;
      try { saveNow(); } catch (e) { dirty = true; console.error('accounts save failed:', e.message); }
    }, 2000);
    statsT.unref();
  }
  // ev: { type: 'reached' | 'clear', mode, level, time? (a clear's seconds) } | { type: 'crown' | 'revive', hell? }
  //   | { type: 'hellClear', mode (run / ice), level (hell level), time? } | { type: 'hellWin', mode } (all of hell cleared)
  //   | { type: 'vsGame' | 'vsWin' } (a versus game played / won)
  function record(a, kind, ev, n = 1) {
    if (!a || !ev || !(n > 0) || !active(a)) return;
    const s = statsOf(a, kind);
    if (ev.type === 'crown') { if (ev.hell) s.hell.crowns += n; else s.crowns += n; }   // (a hell game's: the hell table's own)
    else if (ev.type === 'revive') { if (ev.hell) s.hell.revives += n; else s.revives += n; }
    else if (ev.type === 'vsGame') s.versus.games += n;
    else if (ev.type === 'vsWin') s.versus.wins += n;
    else if (ev.type === 'reached' || ev.type === 'clear') {
      if (!STAT_MODES.includes(ev.mode) || !Number.isInteger(ev.level) || ev.level < 1 || ev.level > MAX_LEVEL) return;
      s.reached[ev.mode] = Math.max(s.reached[ev.mode], ev.level);
      if (ev.type === 'clear') {
        s.clears[ev.mode][ev.level] = (s.clears[ev.mode][ev.level] || 0) + n;
        const t = Number(ev.time);
        if (Number.isFinite(t) && t >= MIN_TIME && t <= MAX_TIME) {
          const r = Math.round(t * 10) / 10, old = s.best[ev.mode][ev.level];
          if (!(old <= r)) s.best[ev.mode][ev.level] = r;
        }
      }
    } else if (ev.type === 'hellClear' || ev.type === 'hellWin') {
      if (!HELL_MODES.includes(ev.mode)) return;
      const h = s.hell;
      if (ev.type === 'hellWin') h.wins[ev.mode] = (h.wins[ev.mode] || 0) + n;
      else {
        if (!Number.isInteger(ev.level) || ev.level < 1 || ev.level > HELL_LEVELS) return;
        h.clears[ev.mode][ev.level] = (h.clears[ev.mode][ev.level] || 0) + n;
        const t = Number(ev.time);
        if (Number.isFinite(t) && t >= MIN_TIME && t <= MAX_TIME) {
          const r = Math.round(t * 10) / 10, old = h.best[ev.mode][ev.level];
          if (!(old <= r)) h.best[ev.mode][ev.level] = r;
        }
      }
    } else return;
    statsChanged();
  }
  // Once per account (hellBack): the hell table filled from the hell boards (levelboards.js hellResults), for the hell
  // games played before the account stats counted hell (2026-10-24): every hell level below the furthest one reached
  // cleared at least once, and an escape (all of hell cleared) a win at least once. No times: the boards keep only a
  // game's total. (resultsFor(sub, pids) -> [{ local, easy, mode, level, escaped }])
  function backfillHell(resultsFor) {
    let n = 0;
    for (const a of Object.values(accounts)) {
      if (!a || !a.sub || a.hellBack || a.deleting || !active(a)) continue;   // (one not active yet: once it is)
      a.hellBack = 1;
      n++;
      for (const r of resultsFor(a.sub, a.pids || [])) {
        if (!HELL_MODES.includes(r.mode) || !(r.level >= 1)) continue;
        const h = statsOf(a, r.easy ? (r.local ? 'easyLocal' : 'easy') : r.local ? 'local' : 'online').hell;
        const cleared = Math.min(HELL_LEVELS, r.escaped ? r.level : r.level - 1);
        for (let L = 1; L <= cleared; L++) h.clears[r.mode][L] = Math.max(h.clears[r.mode][L] || 0, 1);
        if (r.escaped) h.wins[r.mode] = Math.max(h.wins[r.mode] || 0, 1);
      }
    }
    if (n) statsChanged();
    return n;
  }
  // online games: the game server calls this for each signed-in player (by account id)
  const recordOnline = (sub, ev, easy = false) => { if (sub && accounts[sub]) record(accounts[sub], easy ? 'easy' : 'online', ev); };

  // ---- permanent unlocks (shared/unlocks.js): feats done online, per mode, and the items switched off ----
  function unlocksOf(a) {
    const u = a.unlocks ||= {};
    for (const f of FEAT_IDS) { u[f] ||= {}; for (const m of UNLOCK_MODES) u[f][m] = Number(u[f][m]) || 0; }
    // the medic badge counts revives from its start; a swag account brings the ones its stats counted before (once)
    if (u.rev.past == null) u.rev.past = Number(a.stats && a.stats.online && a.stats.online.revives) || 0;
    // the offline track (Solo and Local, one track): reported by the browser, so worn offline only (account.js)
    u.solo ||= {};
    for (const f of FEAT_IDS) { u.solo[f] ||= {}; for (const m of UNLOCK_MODES) u.solo[f][m] = Number(u.solo[f][m]) || 0; }
    u.off ||= {};
    // the golden kitty (unlocks.js 'top1'): from the legends board, not counted by games (an account: its browsers count too)
    const holder = a.sub ? { acct: a.sub, pids: a.pids } : { pids: a.pid ? [a.pid] : [] };
    if (goldenCheck(holder)) u.top1 = { run: 1, ice: 1, mixed: 1 };
    else delete u.top1;
    // the bronze kitty (unlocks.js 'fast1'): the same, from the fastest lists
    if (bronzeCheck(holder)) u.fast1 = { run: 1, ice: 1, mixed: 1 };
    else delete u.fast1;
    // the easy games' level 8 unlocks ('e8') came a little after easy games: once, whoever cleared level 8 in one before
    // gets the count. A level 9 win there ('e9') had level 8 cleared on the way; an account's easy stats counted its
    // level 8 clears (up to the 3 the unlocks need; online and offline ones together, so they go to the online track).
    // (2: done again when the third unlock, the skates, came: it counted up to 2 before)
    if ((u.e8Back | 0) < 2) {
      u.e8Back = 2;
      const had = (a.stats && a.stats.easy && a.stats.easy.clears) || {};
      for (const m of UNLOCK_MODES) {
        u.e8[m] = Math.max(u.e8[m], u.e9[m], Math.min(3, Number(had[m] && had[m][8]) || 0));
        u.solo.e8[m] = Math.max(u.solo.e8[m], u.solo.e9[m]);
      }
      statsChanged();
    }
    return u;
  }
  // who's playing: { sub (account id, maybe not active), pid (the browser's progress id) } or just an account id.
  // An active account keeps its own progress; anyone else keeps it under their progress id.
  const PID = /^[a-z0-9]{24,40}$/;
  const validPid = (p) => (typeof p === 'string' && PID.test(p) ? p : '');
  function holderOf(who, create = false) {
    const sub = typeof who === 'string' ? who : who && who.sub;
    const a = sub && accounts[sub];
    if (a && active(a)) return a;
    const pid = validPid(who && who.pid);
    if (!pid) return null;
    if (!guests[pid] && create) guests[pid] = { at: Date.now() };
    if (guests[pid]) guests[pid].pid ||= pid;   // (its own id, for the golden kitty's check)
    return guests[pid] || null;
  }
  // the game server: this kitty did a feat ('l8' | 'l9' | 'win') in a mode
  function recordFeat(who, feat, mode) {
    if (!FEAT_IDS.includes(feat) || !UNLOCK_MODES.includes(mode)) return;
    const h = holderOf(who, true);
    if (!h) return;
    unlocksOf(h)[feat][mode]++;
    if (h.sub == null) h.at = Date.now();
    statsChanged();
  }
  // the items worn in this game mode: unlocked in that mode (each mode earns its own) and switched on
  const switchedOn = (h, mode) => {
    if (!h || !mode) return [];
    const u = unlocksOf(h);
    return UNLOCKS.filter((x) => !x.song && isUnlocked(u, x, mode) && isWorn(x, u.off)).map((x) => x.id);   // (a song isn't worn)
  };
  // the unlocked items switched on (the game server sends them to everyone in the room)
  const cosFor = (token, mode) => { const a = fromToken(token); return a && active(a) ? switchedOn(a, mode) : []; };
  const cosForPlayer = (who, mode) => switchedOn(holderOf(who), mode);
  // this browser plays online: its guest progress (if any) is kept another two months from now
  function seenGuest(pid) { const g = (pid = validPid(pid)) && guests[pid]; if (g) { g.at = Date.now(); statsChanged(); } }
  // an account that is active now takes over this browser's guest progress (counts add up; its own switches stay)
  function mergeGuest(sub, pid) {
    const a = sub && accounts[sub];
    pid = validPid(pid);
    // the browsers this account has played on (the last few): its legends board places count wins made in them too
    if (a && pid && !(a.pids || []).includes(pid)) { a.pids = [...(a.pids || []), pid].slice(-10); statsChanged(); }
    const g = pid && guests[pid];
    if (!a || !active(a) || !g || !g.unlocks) return;
    const u = unlocksOf(a), gu = unlocksOf(g);
    for (const f of FEAT_IDS) for (const m of UNLOCK_MODES) u[f][m] += gu[f][m];
    for (const k of Object.keys(gu.off)) if (!(k in u.off)) u.off[k] = gu.off[k];
    delete guests[pid];
    statsChanged();
  }
  // a guest's own menu (no sign-in): its progress, and its switches
  function guestRoute(name, m) {
    const pid = validPid(m.pid);
    if (!pid) return { ok: false };
    const g = guests[pid];
    if (name === 'guest') return { ok: true, unlocks: g ? unlocksOf(g) : null };
    const item = UNLOCKS.find((x) => x.id === m.item && !x.song);   // (a song has no switch: it's picked in the settings)
    if (!g || !item || typeof m.on !== 'boolean') return { ok: false };
    const u = unlocksOf(g);
    if (!isUnlocked(u, item)) return { ok: false, msg: 'Not unlocked yet.' };
    if (!m.on) u.off[item.id] = true; else if (item.defaultOff) u.off[item.id] = false; else delete u.off[item.id];
    g.at = Date.now();
    statsChanged();
    return { ok: true, unlocks: u };
  }

  // Is this paid session one of ours, unchanged? (a session from another project on the shared account, the other
  // mode, or one this server never created gets null, quietly: the webhook sees every project's checkouts)
  function ours(s) {
    if (!s || s.object !== 'checkout.session' || s.livemode !== LIVE || !s.metadata || s.metadata.app !== APP) return null;
    const c = checkouts[s.id];
    if (!c || c.sub !== s.client_reference_id || c.sub !== s.metadata.sub) return null;
    if (s.mode !== 'payment' || s.payment_status !== 'paid' || s.currency !== CURRENCY || s.amount_total !== c.cents) {
      if (s.payment_status === 'paid') console.error('checkout', s.id, 'paid but does not match what was created');
      return null;
    }
    return c;
  }

  // credit a paid Checkout Session once (from the webhook or the return trip, whichever comes first)
  function credit(s) {
    const c = ours(s);
    if (!c) return null;
    const a = accounts[c.sub];
    if (!a) { console.error('paid session for a deleted account', s.id); return null; }
    if ((a.payments || []).includes(s.id)) {
      delete checkouts[s.id];
      try { saveNow(); } catch (e) { checkouts[s.id] = c; throw e; }
      return a;
    }
    const amount = s.amount_total;
    // Written to disk before anyone is told it worked (the webhook's 200, the confirm reply): the log line first (it
    // replays on startup, see recover()), then the account file. A failed log write throws, so Stripe retries the webhook.
    const line = { at: new Date().toISOString(), session: s.id, sub: a.sub, email: a.email, amount, currency: s.currency, total: (Number(a.paid) || 0) + amount };
    const fd = fs.openSync(paymentsFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      // A disk error can leave half a log entry. Separate it before retrying so recovery can read the new entry.
      const size = fs.fstatSync(fd).size, tail = Buffer.alloc(1);
      const separator = size && fs.readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10 ? '\n' : '';
      fs.writeFileSync(fd, separator + JSON.stringify(line) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    a.payments = [...(a.payments || []), s.id];
    a.paid = line.total;
    delete checkouts[s.id];
    // Keep the binding on failure so a webhook retry commits the snapshot without appending/crediting twice.
    try { saveNow(); } catch (e) { checkouts[s.id] = c; throw e; }
    console.log(`payment: ${a.email || a.sub} +${(s.amount_total / 100).toFixed(2)} = ${(a.paid / 100).toFixed(2)}`);
    return a;
  }

  // ---- HTTP ----
  const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  function readBody(req, max, cb) {
    const chunks = [];
    let size = 0, stopped = false;
    req.on('data', (c) => {
      if (stopped) return;
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += chunk.length;
      if (size > max) { stopped = true; chunks.length = 0; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { stopped = true; chunks.length = 0; });
    req.on('aborted', () => { stopped = true; chunks.length = 0; });
    req.on('end', () => { if (!stopped) cb(Buffer.concat(chunks, size)); });
  }
  const bearer = (req) => (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1];

  async function route(name, req, body) {
    if (name === 'config') return { ok: true, enabled, googleClientId: clientIds[0] || null, discord: discordOn, min: MIN_CENTS, max: STRIPE_MAX_CENTS, currency: CURRENCY };
    if (name === 'guest' || name === 'guestequip') {
      let gm = {};
      if (body) { try { gm = JSON.parse(body) || {}; } catch { return { ok: false }; } }
      return guestRoute(name, gm);
    }
    if (!enabled) return { ok: false, msg: 'Accounts are not open yet.' };
    let m = {};
    if (body) { try { m = JSON.parse(body) || {}; } catch { return { ok: false }; } }
    if (name === 'google') {
      let c;
      try { c = await verifyGoogle(m.credential); } catch (e) { return { ok: false, msg: 'Google sign-in did not work, try again.' }; }
      if (c.email_verified === false) return { ok: false, msg: 'That Google account has no verified email.' };
      if (deleteGone(accounts[c.sub])) delete accounts[c.sub];   // (its grace period is over: a new account)
      const a = accounts[c.sub] ||= { sub: c.sub, email: '', name: '', paid: 0, created: new Date().toISOString(), sessions: [], payments: [] };
      a.email = String(c.email || '').slice(0, 120);
      a.name = cleanName(c.given_name || c.name);
      return { ok: true, token: newSession(a), account: pub(a) };
    }
    if (name === 'handoff') {
      // the page, back from the Discord callback: its one-time code -> the session token
      const h = handoffs.get(String(m.code || ''));
      handoffs.delete(String(m.code || ''));
      const a = h && Date.now() - h.at <= HANDOFF_MS ? fromToken(h.token) : null;
      if (!a) return { ok: false, msg: 'Sign-in timed out, try again.' };
      return { ok: true, token: h.token, account: pub(a) };
    }
    const a = fromToken(bearer(req));
    if (!a) return { ok: false, signedOut: true };
    if (name === 'me') return { ok: true, account: pub(a) };
    if (name === 'restore') {
      // a deleted account, signed in again within its grace period: back as it was
      if (!a.deleting) return { ok: true, account: pub(a) };
      const at = a.deleting;
      delete a.deleting;
      try { saveNow(); } catch (e) { a.deleting = at; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (a.deleting && name !== 'logout') return { ok: false, msg: 'This account is deleted. Restore it first.' };
    if (name === 'pay') {
      const cents = m.cents;
      if (!Number.isSafeInteger(cents) || cents < MIN_CENTS) return { ok: false, msg: `The smallest amount is ${(MIN_CENTS / 100).toFixed(2)}.` };
      if (cents > STRIPE_MAX_CENTS) return { ok: false, msg: 'That is more than one payment can take.' };
      const origin = origins.has(m.origin) ? m.origin : [...origins][0];
      let s;
      try { s = await stripe('POST', '/checkout/sessions', {
        mode: 'payment', client_reference_id: a.sub, customer_email: a.email || undefined, submit_type: 'pay',
        line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY, unit_amount: cents,
          product_data: { name: 'Run Kitty Run: your number', description: 'Adds to the total shown next to your kitty online. One-time, cosmetic only.' } } } },
        metadata: { app: APP, sub: a.sub },
        payment_intent_data: { description: 'Run Kitty Run account', metadata: { app: APP, sub: a.sub } },
        branding_settings: { display_name: 'Run Kitty Run' },   // the Checkout heading (the shared account keeps its name)
        success_url: `${origin}/?paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?paid=cancel`,
      }); } catch (e) { console.error('checkout failed:', e.message); return { ok: false, msg: /amount/i.test(e.message) ? e.message : 'Checkout is not available right now, try again in a moment.' }; }
      if (s.livemode !== LIVE || !s.url) return { ok: false, msg: 'Checkout is not available right now, try again in a moment.' };
      if (accounts[a.sub] !== a || fromToken(bearer(req)) !== a) return { ok: false, signedOut: true };
      // bind before the player can pay: only sessions in here are ever credited
      checkouts[s.id] = { sub: a.sub, cents, at: Date.now() };
      try { saveNow(); } catch (e) { delete checkouts[s.id]; throw e; }
      return { ok: true, url: s.url };
    }
    if (name === 'confirm') {
      // back from Checkout: ask Stripe directly so it doesn't wait on the webhook
      if (!/^cs_[\w]+$/.test(String(m.session || ''))) return { ok: false };
      // only a checkout this player started here is ever looked up (no asking Stripe about other people's sessions)
      if (!checkouts[m.session] && !(a.payments || []).includes(m.session)) return { ok: false };
      const s = await stripe('GET', '/checkout/sessions/' + m.session);
      if (s.id !== m.session || (!checkouts[s.id] && !(a.payments || []).includes(s.id))) return { ok: false };
      if (s.client_reference_id !== a.sub) return { ok: false };
      credit(s);
      return { ok: true, paid: s.payment_status === 'paid', account: pub(a) };
    }
    if (name === 'equip') {
      // an unlocked item on / off (the player's own switch)
      const item = UNLOCKS.find((x) => x.id === m.item && !x.song);
      if (!item || typeof m.on !== 'boolean') return { ok: false };
      const u = unlocksOf(a);
      if (!active(a)) return { ok: false, msg: 'Activate your swag account first.' };
      if (!isUnlocked(u, item) && !isUnlocked(u.solo, item)) return { ok: false, msg: 'Not unlocked yet.' };   // (online or offline)
      const had = item.id in u.off, previous = u.off[item.id];
      if (!m.on) u.off[item.id] = true; else if (item.defaultOff) u.off[item.id] = false; else delete u.off[item.id];
      try { saveNow(); } catch (e) { if (had) u.off[item.id] = previous; else delete u.off[item.id]; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (name === 'show') {
      // the player's own switch: show the total to other players online, or not (it stays on the account either way)
      if (typeof m.show !== 'boolean') return { ok: false };
      const previous = a.hide;
      if (m.show) delete a.hide; else a.hide = true;
      try { saveNow(); } catch (e) { if (previous) a.hide = previous; else delete a.hide; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (name === 'style') {
      // how the number looks: 'classic' (the tag) or 'koi' (the koi fish)
      if (m.style !== 'classic' && m.style !== 'koi') return { ok: false };
      const previous = a.style;
      if (m.style === 'koi') a.style = 'koi'; else delete a.style;
      try { saveNow(); } catch (e) { if (previous) a.style = previous; else delete a.style; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (name === 'display') {
      // the number shown next to the kitty: any amount from 1 cent up to the total paid (cents); null: the total again
      const paid = Number(a.paid) || 0, previous = a.display;
      if (m.cents === null) delete a.display;
      else if (Number.isInteger(m.cents) && m.cents >= 1 && m.cents <= paid) { if (m.cents === paid) delete a.display; else a.display = m.cents; }
      else return { ok: false, msg: 'Pick a number up to your total.' };
      try { saveNow(); } catch (e) { if (previous == null) delete a.display; else a.display = previous; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (name === 'progress') {
      // solo / local co-op results, reported by the browser: { mode, reached, clears: [levels], times: [seconds per
      // clear, newer browsers], crowns, revives, easy? (an easy game: its own set, and only the song and the revives
      // of the offline unlocks) }.
      // Capped per report (the endpoint is rate limited per IP too); shown apart from the online numbers.
      // A hell game (hell: true, mode run / ice): clears are hell levels (with times), won: all of hell cleared; its crowns
      // and revives go to the hell table's own counts. (The offline unlock track goes on as in any game.)
      if (m.hell === true) {
        if (!HELL_MODES.includes(m.mode)) return { ok: false };
        const easy = m.easy === true, kind = easy ? 'easyLocal' : 'local';
        const times = Array.isArray(m.times) ? m.times : [];
        (Array.isArray(m.clears) ? m.clears : []).slice(0, 3).forEach((v, i) => record(a, kind, { type: 'hellClear', mode: m.mode, level: v, time: times[i] }));
        if (m.won === true) record(a, kind, { type: 'hellWin', mode: m.mode });
        const count = (v, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : 0);
        record(a, kind, { type: 'crown', hell: true }, count(m.crowns, 3));
        record(a, 'local', { type: 'revive', hell: true }, count(m.revives, 100));
        if (easy) record(a, 'easyLocal', { type: 'revive', hell: true }, count(m.revives, 100));
        return { ok: true, account: pub(a) };
      }
      const mode = STAT_MODES.includes(m.mode) ? m.mode : null;
      if (!mode) return { ok: false };
      const lvl = (v) => (Number.isInteger(v) && v >= 1 && v <= MAX_LEVEL ? v : 0);
      const easy = m.easy === true, kind = easy ? 'easyLocal' : 'local';
      if (lvl(m.reached)) record(a, kind, { type: 'reached', mode, level: lvl(m.reached) });
      const times = Array.isArray(m.times) ? m.times : [];
      (Array.isArray(m.clears) ? m.clears : []).slice(0, 3).forEach((v, i) => { if (lvl(v)) record(a, kind, { type: 'clear', mode, level: v, time: times[i] }); });
      const count = (v, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : 0);
      record(a, kind, { type: 'crown' }, count(m.crowns, 3));
      record(a, 'local', { type: 'revive' }, count(m.revives, 100));
      if (easy) record(a, 'easyLocal', { type: 'revive' }, count(m.revives, 100));
      // offline unlock progress ({ feat: count } in this mode): only ever worn offline, so a faked one shows only to its
      // own player. (Capped per report; bigger when a browser's own track moves onto the account.)
      if (m.solo && typeof m.solo === 'object' && active(a)) {
        const u = unlocksOf(a);
        for (const f of FEAT_IDS) {
          if (easy ? !['rev', 'win', 'e8', 'e9', 'r9'].includes(f) : f === 'e8' || f === 'e9') continue;   // (an easy game: its own level 8 and 9 feats; reaching level 9 counts anywhere)
          const n = count(m.solo[f], f === 'rev' ? 5000 : 50); if (n) u.solo[f][mode] += n;
        }
        statsChanged();
      }
      return { ok: true, account: pub(a) };
    }
    if (name === 'logout') {
      const h = sha(bearer(req));
      const previous = a.sessions;
      a.sessions = (a.sessions || []).filter((x) => x !== h);
      try { saveNow(); } catch (e) { a.sessions = previous; throw e; }
      reindex();
      return { ok: true };
    }
    if (name === 'delete') {
      // only with DELETE typed in the menu (no account goes by an accidental click, or an old page's one-click delete)
      if (m.confirm !== 'DELETE') return { ok: false, msg: 'Type DELETE to delete your account.' };
      // hidden and signed out everywhere now, gone for good after DELETE_KEEP_MS (pruneDeleted; signing in again within
      // that time can restore it); payments.jsonl keeps its lines (bookkeeping)
      const previous = a.sessions;
      a.deleting = Date.now(); a.sessions = [];
      try { saveNow(); } catch (e) { delete a.deleting; a.sessions = previous; throw e; }
      reindex();
      return { ok: true, until: new Date(a.deleting + DELETE_KEEP_MS).toISOString() };
    }
    return null;
  }

  // POST /api/stripe/webhook: checkout.session.completed (and async payment succeeded) credits the account
  function webhook(req, res) {
    readBody(req, 1 << 16, (raw) => {
      const sig = String(req.headers['stripe-signature'] || '');
      const t = (/(?:^|,)t=(\d+)/.exec(sig) || [])[1];
      const v1s = [...sig.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map((x) => x[1]);
      const want = hookSecret && t ? crypto.createHmac('sha256', hookSecret).update(t + '.').update(raw).digest('hex') : '';
      const ok = want && Math.abs(Date.now() / 1000 - +t) < 300
        && v1s.some((v) => v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
      if (!ok) return reply(res, 400, { ok: false });
      let ev;
      try { ev = JSON.parse(raw.toString('utf8')); } catch { return reply(res, 400, { ok: false }); }
      if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
        try { credit(ev.data && ev.data.object); } catch (e) { console.error('credit failed:', e.message); return reply(res, 500, { ok: false }); }   // Stripe retries
      }
      reply(res, 200, { ok: true });
    });
  }

  // /api/account/<name>; returns false if it isn't one of ours
  function handle(req, res, name) {
    if (name === 'config' && req.method === 'GET') { route('config', req).then((j) => reply(res, 200, j)); return true; }
    if (name === 'discord' && req.method === 'GET') { discordStart(req, res); return true; }
    if (name === 'discord/callback' && req.method === 'GET') {
      discordCallback(req, res).catch((e) => { console.error('discord sign-in failed:', e.message); if (!res.headersSent) reply(res, 502, { ok: false }); });
      return true;
    }
    if (!['google', 'handoff', 'me', 'pay', 'confirm', 'show', 'style', 'display', 'equip', 'guest', 'guestequip', 'progress', 'logout', 'delete', 'restore'].includes(name)) return false;
    if (req.method !== (name === 'me' ? 'GET' : 'POST')) { reply(res, 405, { ok: false }); return true; }
    const go = (body) => route(name, req, body)
      .then((j) => reply(res, j ? 200 : 404, j || { ok: false }))
      .catch((e) => { console.error('account', name, 'failed:', e.message); reply(res, 502, { ok: false, msg: 'Something went wrong, try again in a moment.' }); });
    if (req.method === 'GET') go(''); else readBody(req, 8192, (raw) => go(raw.toString('utf8')));
    return true;
  }

  return { enabled, handle, webhook, backfillHell, setLegendRanks, setGoldenCheck, setBronzeCheck, paidFor, paidStyleFor, shownAll, reachedFinal, hellOpenFor, subFor, cosFor, cosForPlayer, mergeGuest, seenGuest, validPid, recordOnline, recordFeat, flush };
}

// One credit per player, however many of its tabs are in the game: of these kitties (members: { acct, pid }), the
// ones that count, in order. A kitty doesn't when one before it has the same account or the same browser (progress
// id): 10 tabs in one lobby still clear a level once. (Kitties with neither have nothing to count on anyway.)
function onePerPlayer(members) {
  const seen = new Set();
  return members.filter((m) => {
    const keys = [m && m.acct && 'a:' + m.acct, m && m.pid && 'p:' + m.pid].filter(Boolean);
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}
// the same player (account or browser) behind both kitties: reviving your own other tab doesn't count
const samePlayer = (a, b) => !!(a && b && ((a.acct && a.acct === b.acct) || (a.pid && a.pid === b.pid)));

export { createAccounts, onePerPlayer, samePlayer };
