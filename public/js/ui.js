import { CFG, PLAYER_COLORS } from './shared/config.js';
import { fmtNum } from './account.js';
import { TOUCH } from './device.js';
import { NATIVE, APP_VERSION, SERVER_ORIGIN, openExternal } from './platform.js';
import { PATCH_NOTES } from './patchnotes.js';
import { openStatsPage } from './analytics.js';
import { localSlots } from './kittycolor.js';
import { key, keyName } from './settings.js';

// Run Kitty Run — UI layer (DOM + injected CSS + 2D canvas minimap).
// Contract notes / interpretations:
// - onStart / onRestart / onResume callbacks: the UI also hides its own panel right after calling them
//   (hideTitle/hidePause/hideGameOver are idempotent, so main may call them too).
// - Keyboard handled by the UI: title (1 / 2 / Enter / Space, arrows or W/S to switch), pause (Enter),
//   game over (Enter / Space, armed after a short delay). P/Esc/M remain main.js's job.
// - setHUD may be called every frame: DOM nodes are cached and only written when values change.
// - Minimap maps world x -> canvas x, world z -> canvas y (camera: +Z is screen-down).

const FONT = "'Baloo 2','Fredoka','Trebuchet MS','Segoe UI',system-ui,sans-serif";

// a light colour (white, yellow, pale pink...): something white on it wouldn't show
function isPale(c) {
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c >>> 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 175;
}
// the end cards' order: more points, then more crowns, then fewer times caught (main.js sorts by it too)
function rankOrder(a, b) { return (b.score - a.score) || ((b.crowns || 0) - (a.crowns || 0)) || ((a.caught || 0) - (b.caught || 0)); }
function hexColor(c) {
  if (typeof c === 'string') return c;
  return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}
function rgba(c, a) {
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : (c >>> 0);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function fmtTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  const m = Math.floor(t / 60), s = t % 60;
  return m + ':' + String(s).padStart(2, '0');
}
// the same with hours (h:mm:ss) once it's an hour or more (all of hell can take a while)
function fmtLong(t) {
  t = Math.max(0, Math.floor(t || 0));
  return t < 3600 ? fmtTime(t) : Math.floor(t / 3600) + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------- inline SVG icons ----------
const INK = '#2b1840';
// sunglasses laid over the player card's cat icon (5+ wins), on the cat's eyes (same 40x40 frame)
// 14+ wins: the lion's mane behind the card's cat face (the same tufts as caticon.js draws on the canvas cards); its
// fill comes from the CSS (a deeper shade of the kitty's colour, or the 16-win looks)
const MANE_D = (() => {
  const c = (x, y, rr) => `M${(x + rr).toFixed(2)} ${y.toFixed(2)}a${rr} ${rr} 0 1 0 ${-2 * rr} 0a${rr} ${rr} 0 1 0 ${2 * rr} 0`;
  let d = c(20, 21, 16);
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2 + 0.2; d += c(20 + Math.cos(a) * 15.5, 21 + Math.sin(a) * 15.5, 6); }
  return d;
})();
// the goldfish around an account total (.rkr-fish): head, the number on its body, tail (text: digits only, from fmtNum)
// A whole koi drawn for its number, facing right (drawn head left, then mirrored): a pointed head with a big bright
// eye and a tiny smile, the body as long as the digits need (they sit on it) narrowing into a long flowing tail, a long fin
// down its back and a side fin. Cream with ragged orange-red patches, the fins orange fading to white, and
// the chrome kitty's bands of light over it, sliding head to tail as if it swims. text: digits only (fmtNum).
const FISH_C = { body: ['#fff8e8', '#fff1d6', '#ffe2b8'], fin: ['#ff7a2e', '#ffffff'], line: '#d2501c', gill: '#e06a2c', spots: '#ff4a12' };
let fishN = 0, fishCtx = null;
function fishHTML(text) {
  fishCtx ||= document.createElement('canvas').getContext('2d');
  fishCtx.font = '900 12px ' + FONT;
  const tw = Math.ceil(fishCtx.measureText(text).width);
  const H = 18, head = 11, gap = 3, L = head + gap + tw + 7, W = L + 19;   // the digits from head + gap; the body's full height to L, the tail after it
  const n = ++fishN, ink = '#2b1840', C = FISH_C, finFill = `url(#rkrff${n})`;
  const body = `M.8 9.8C1.2 5.6 5 2.4 10.5 2.2L${L - 4} 2.2C${L} 2.4 ${L + 3} 5.2 ${L + 6} 7.1L${L + 6} 10.9C${L + 3} 12.8 ${L} 15.6 ${L - 4} 15.8L10.5 15.8C5 15.6 1.4 13.4 .8 9.8Z`;
  const tail = `M${L + 5} 7.3C${L + 8} 5 ${L + 11} 1.4 ${W - .6} .6C${W - 2.6} 3.8 ${W - 5} 6.8 ${W - 4.2} 9C${W - 5} 11.2 ${W - 2.6} 14.2 ${W - .6} 17.4C${L + 11} 16.6 ${L + 8} 13 ${L + 5} 10.7Z`;
  const d0 = Math.round(head + gap + tw * 0.2), d1 = L - 2;
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="transform:scaleX(-1)">`
    + `<defs><linearGradient id="rkrfb${n}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.body[0]}"/><stop offset=".55" stop-color="${C.body[1]}"/><stop offset="1" stop-color="${C.body[2]}"/></linearGradient>`
    + `<linearGradient id="rkrfs${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>`
    + `<linearGradient id="rkrfl${n}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="37" y2="-4.4" spreadMethod="repeat"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".2" stop-color="#fff" stop-opacity=".55"/><stop offset=".4" stop-color="#3a2a40" stop-opacity=".2"/><stop offset=".56" stop-color="#fff" stop-opacity="0"/><stop offset=".66" stop-color="#fff" stop-opacity=".85"/><stop offset=".76" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0"/><animateTransform attributeName="gradientTransform" type="translate" from="-37 0" to="0 0" dur="3.4s" repeatCount="indefinite"/></linearGradient>`
    + `<linearGradient id="rkrff${n}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.fin[0]}"/><stop offset="1" stop-color="${C.fin[1]}"/></linearGradient></defs>`
    + `<path d="M${d0} 2.6C${d0 + 3} -.4 ${d1 - 4} -1.2 ${d1 + 1} -.6C${d1} .6 ${d1 + .5} 1.8 ${d1 + 1.5} 2.8Z" fill="${finFill}" stroke="${ink}" stroke-width="1" stroke-linejoin="round"/>`   // the long back fin
    + `<path d="M${d0} 2.6C${d0 + 3} -.4 ${d1 - 4} -1.2 ${d1 + 1} -.6C${d1} .6 ${d1 + .5} 1.8 ${d1 + 1.5} 2.8Z" fill="url(#rkrfl${n})"/>`
    + `<path d="M${d0 + 4} 1.9L${d0 + 5} .3M${(d0 + d1) / 2} 1.9L${(d0 + d1) / 2 + 1} -.2M${d1 - 3} 1.9L${d1 - 2} -.4" stroke="${C.line}" stroke-width=".6" stroke-linecap="round" opacity=".6"/>`
    + `<path d="${tail}" fill="${finFill}" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/>`
    + `<path d="M${L + 6} 9C${L + 10} 7 ${L + 13} 4.5 ${W - 2} 2.4M${L + 6} 9C${L + 10} 11 ${L + 13} 13.5 ${W - 2} 15.6M${L + 6} 9C${L + 9} 8.3 ${L + 11} 7.5 ${W - 5.2} 6.6M${L + 6} 9C${L + 9} 9.7 ${L + 11} 10.5 ${W - 5.2} 11.4" fill="none" stroke="${C.line}" stroke-width=".6" stroke-linecap="round" opacity=".65"/>`   // tail rays
    + `<path d="${tail}" fill="url(#rkrfl${n})"/>`   // (under the body, which overlaps the tail's root)
    + `<path d="M${head - 5.4} 12.8C${head - 5} 16.8 ${head - 2} 19.8 ${head + 4.2} 19.8C${head + 1.6} 18.4 ${head + .2} 16.2 ${head - .4} 12.8Z" fill="#ff8a3d" stroke="${ink}" stroke-width=".9" stroke-linejoin="round"/>`   // side fin (behind the body: it pokes out under the belly; solid orange, so it shows)
    + `<path d="M${head - 2.6} 16.2Q${head - .6} 18.2 ${head + 2.4} 19M${head - 1.4} 15.6Q${head + .4} 17 ${head + 2} 17.6" fill="none" stroke="${C.line}" stroke-width=".55" stroke-linecap="round" opacity=".6"/>`
    + `<path d="M${head - 5.4} 12.8C${head - 5} 16.8 ${head - 2} 19.8 ${head + 4.2} 19.8C${head + 1.6} 18.4 ${head + .2} 16.2 ${head - .4} 12.8Z" fill="url(#rkrfl${n})"/>`
    + `<path d="${body}" fill="url(#rkrfb${n})" stroke="${ink}" stroke-width="1.3" stroke-linejoin="round"/>`
    + `<path d="M${head - 4} 2.3Q${head + 2} 5 ${head - 1} 9Q${head - 5} 7 ${head - 4} 2.3Z" fill="${C.spots}"/>`   // the patch on its head
    + `<path d="M${L - 9} 2.3Q${L - 1} 3 ${L + 2} 6.6Q${L - 5} 8.5 ${L - 9} 2.3Z" fill="${C.spots}"/><path d="M${L - 6} 15.7Q${L} 14.5 ${L + 2} 11.4Q${L - 4} 12 ${L - 6} 15.7Z" fill="${C.spots}"/>`   // patches
    + `<path d="${body}" fill="url(#rkrfs${n})"/>`   // round shading over everything on the body
    + `<path d="${body}" fill="url(#rkrfl${n})"/>`   // the light
    + `<path d="M${head - .8} 4.6Q${head - 3} 9 ${head - .8} 13.6" fill="none" stroke="${C.gill}" stroke-width=".9" stroke-linecap="round"/>`   // gill
    + `<path d="M${head} 3.6H${L - 6}" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity=".5"/>`   // shine
    + `<ellipse cx="5.3" cy="7.4" rx="1.6" ry="1.9" fill="${ink}"/><circle cx="5.75" cy="6.75" r=".6" fill="#fff"/><circle cx="4.8" cy="8.2" r=".28" fill="#fff"/>`   // a big bright eye, like the kitties'
    + `<path d="M1.7 11.1Q2.6 11.9 3.6 11.3" fill="none" stroke="${ink}" stroke-width=".55" stroke-linecap="round"/>`   // a tiny smile
    + '</svg>';
  return svg + `<b style="right:${head + gap}px;width:${tw}px">${text}</b>`;
}

// the classic tag: the number in gold on a dark tag, as before the koi
const classicHTML = (text) => `<b class="rkr-ctag">${text}</b>`;
// the number's look: the classic tag, or the koi (fishHTML) for a player who picked it
const swagHTML = (text, ps = 'koi') => (ps === 'koi' ? fishHTML(text) : classicHTML(text));

const MANE_SVG = `<svg viewBox="0 0 40 40" class="rkr-mane" aria-hidden="true"><path d="${MANE_D}"/></svg>`;
const SHADES_SVG = `<svg viewBox="0 0 40 40" class="rkr-shades"><path d="M5 19.6 L10 18.8 M35 19.6 L30 18.8 M18.4 20.2 Q20 18.6 21.6 20.2" fill="none" stroke="#ffd34a" stroke-width="1.6" stroke-linecap="round"/><ellipse cx="14" cy="21.6" rx="4.8" ry="4.2" fill="#1e1a2b" stroke="#ffd34a" stroke-width="1"/><ellipse cx="26" cy="21.6" rx="4.8" ry="4.2" fill="#1e1a2b" stroke="#ffd34a" stroke-width="1"/><path d="M11.4 19.8 L14.6 19.1 M23.4 19.8 L26.6 19.1" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>`;
// ...and broken (5+ wins, kitty down): knocked crooked, both lenses cracked, a shard missing from the right one
// an easy game's reading glasses (5+ wins): round wire frames, the eyes show through
const SPECS_SVG = `<svg viewBox="0 0 40 40" class="rkr-specs"><path d="M5 19.6 L9.4 20.4 M35 19.6 L30.6 20.4 M18.6 20.6 Q20 19.2 21.4 20.6" fill="none" stroke="#e0b040" stroke-width="1.4" stroke-linecap="round"/><circle cx="14.2" cy="21.5" r="4.7" fill="rgba(255,255,255,.12)" stroke="#e0b040" stroke-width="1.5"/><circle cx="25.8" cy="21.5" r="4.7" fill="rgba(255,255,255,.12)" stroke="#e0b040" stroke-width="1.5"/></svg>`;
const SHADES_BROKEN_SVG = `<svg viewBox="0 0 40 40" class="rkr-shades-broken"><g transform="rotate(-9 20 21)"><path d="M5 19.6 L10 18.8 M35 19.6 L30 18.8 M18.4 20.2 Q20 18.6 21.6 20.2" fill="none" stroke="#ffd34a" stroke-width="1.6" stroke-linecap="round"/><ellipse cx="14" cy="21.6" rx="4.8" ry="4.2" fill="#1e1a2b" stroke="#ffd34a" stroke-width="1"/><ellipse cx="26" cy="21.6" rx="4.8" ry="4.2" fill="#1e1a2b" stroke="#ffd34a" stroke-width="1"/><path d="M26 21.6 L30.4 18.6 L30.9 21.2 Z" fill="currentColor" stroke="${INK}" stroke-width=".6" stroke-linejoin="round"/><path d="M10 19.5 L13.2 22 L12 25.4 M13.2 22 L17.4 20.8 M13.2 22 L16 25.2 M22 23.6 L26 21.6 L24.4 18 M26 21.6 L27.6 25.6" fill="none" stroke="#fff" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/></g></svg>`;
// the medic badge (3000 revives): a star of life in the kitty's colour (currentColor), and on it the revive effects'
// staff and snake (effects.js SHAPE_STAR, the particle shader's shape at 40 units): a thin staff with a knob, the snake
// winding down it (x = sin(y * 21) * 0.075) with its head up by the knob. Staff and snake from the card (.rkr-medic: white
// on most kitties, dark ink on pale ones)
const MEDIC_SVG = (() => {
  let snake = '';
  for (let i = 0; i <= 24; i++) {
    const qy = -0.19 + (0.44 * i) / 24;
    snake += (i ? 'L' : 'M') + (20 + Math.sin(qy * 21) * 3).toFixed(2) + ' ' + (20 + qy * 40).toFixed(2);
  }
  const hx = (20 + Math.sin(-0.21 * 21) * 3).toFixed(2), hy = (20 - 0.21 * 40).toFixed(2);
  return '<svg viewBox="0 0 40 40">'
    + '<path d="M16 3h8v10.1l8.7-5 4 6.9-8.7 5 8.7 5-4 6.9-8.7-5V37h-8V26.9l-8.7 5-4-6.9 8.7-5-8.7-5 4-6.9 8.7 5z" fill="currentColor" stroke="#2b1840" stroke-width="2.2" stroke-linejoin="round"/>'
    + '<path class="mo" d="M20 8v24" stroke-width="4" stroke-linecap="round"/><path class="mi" d="M20 8v24" stroke-width="3" stroke-linecap="round"/>'
    + '<circle class="mk" cx="20" cy="6.8" r="1.8" stroke-width="1"/>'
    + `<path class="mo" d="${snake}" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path class="mi" d="${snake}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<ellipse class="mk" cx="${hx}" cy="${hy}" rx="2.1" ry="1.5" stroke-width="1"/></svg>`;
})();
const ICONS = {
  fish: `<svg viewBox="0 0 40 40"><path d="M4 20 Q13 8 25 11 Q31 12.5 36 20 Q31 27.5 25 29 Q13 32 4 20 Z" fill="#ff9a7a" stroke="#7a2f3c" stroke-width="2.4" stroke-linejoin="round"/><path d="M5 20 L1 13 L1 27 Z" fill="#6d8fb3" stroke="#2f4c6b" stroke-width="2" stroke-linejoin="round"/><circle cx="29" cy="18" r="2" fill="#16121c"/><path d="M15 14 Q13 20 15 26 M20 13 Q18 20 20 27" stroke="#fff" stroke-width="1.6" fill="none" opacity=".7"/></svg>`,
  cat: `<svg viewBox="0 0 40 40" class="rkr-cat"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><g class="rkr-eyes"><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="${INK}"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="${INK}"/><circle cx="15" cy="20.4" r=".9" fill="#fff"/><circle cx="26.4" cy="20.4" r=".9" fill="#fff"/></g><g class="rkr-xeyes" stroke="${INK}" stroke-width="2" stroke-linecap="round"><path d="M12 19 L16.6 23.6 M16.6 19 L12 23.6 M23.4 19 L28 23.6 M28 19 L23.4 23.6"/></g><path d="M18.2 26.4 L21.8 26.4 L20 28.6 Z" fill="#ff6f9f" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/><path d="M20 28.6 Q18.5 31 16.5 30 M20 28.6 Q21.5 31 23.5 30" fill="none" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/><path d="M3 25 L11 26 M3.5 29 L11 28 M37 25 L29 26 M36.5 29 L29 28" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/></svg>`,
  boots: `<svg viewBox="0 0 40 40"><path d="M3 15 Q9 9 15 14 Q10 13 8 17 Q12 15 15 18 Q10 18 9 21 Z" fill="#e8fbff" stroke="#2a8fb0" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 6 L27 6 L27 22 Q36 23 37 30 L37 34 L13 34 L13 26 Q15 20 15 6 Z" fill="#33d6ff" stroke="#0b5d79" stroke-width="2.4" stroke-linejoin="round"/><path d="M13 30 L37 30" stroke="#0b5d79" stroke-width="2"/><path d="M15 10 L27 10" stroke="#fff" stroke-width="2" opacity=".7"/></svg>`,
  heart: `<svg viewBox="0 0 40 36"><path d="M20 33 C8 24 3 18 3 11.5 C3 6 7 3 11.5 3 C15 3 18 5 20 8.5 C22 5 25 3 28.5 3 C33 3 37 6 37 11.5 C37 18 32 24 20 33 Z" fill="#ff5c93" stroke="#8c1640" stroke-width="2.6" stroke-linejoin="round"/><path d="M9 10 Q10 7 13 6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".8"/></svg>`,
  heartEmpty: `<svg viewBox="0 0 40 36"><path d="M20 33 C8 24 3 18 3 11.5 C3 6 7 3 11.5 3 C15 3 18 5 20 8.5 C22 5 25 3 28.5 3 C33 3 37 6 37 11.5 C37 18 32 24 20 33 Z" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.45)" stroke-width="2.6" stroke-dasharray="4 3" stroke-linejoin="round"/></svg>`,
  shield: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="rgba(90,170,255,.35)" stroke="#5aaaff" stroke-width="2.6"/><circle cx="20" cy="20" r="11" fill="none" stroke="#bfe0ff" stroke-width="1.4" opacity=".7"/><path d="M11 14 Q14 9 20 8.5" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`,
  wolf: `<svg viewBox="0 0 40 40"><path d="M4 5 L14 13 L26 13 L36 5 L34 22 L26 34 L20 37 L14 34 L6 22 Z" fill="#7d8096" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><path d="M14 27 L20 37 L26 27 Q20 24 14 27 Z" fill="#c9cad6"/><path d="M11 19 L17 21 L12 23 Z M29 19 L23 21 L28 23 Z" fill="#ff3b3b"/><circle cx="20" cy="29" r="2" fill="${INK}"/></svg>`,
  revive: `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="31" rx="16" ry="6" fill="rgba(255,179,71,.25)" stroke="#ffb347" stroke-width="2.2" stroke-dasharray="4 3"/><path d="M13 30 L13 15 Q13 7 20 7 Q27 7 27 15 L27 30 L24.5 27.5 L22 30 L20 27.5 L18 30 L15.5 27.5 Z" fill="rgba(255,255,255,.85)" stroke="#b9a4ff" stroke-width="1.6" stroke-linejoin="round"/><circle cx="17.3" cy="15.5" r="1.6" fill="${INK}"/><circle cx="22.7" cy="15.5" r="1.6" fill="${INK}"/></svg>`,
  paw: `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="27" rx="9" ry="7.5"/><ellipse cx="8.5" cy="17" rx="3.6" ry="4.6" transform="rotate(-20 8.5 17)"/><ellipse cx="15.5" cy="10" rx="3.6" ry="4.8" transform="rotate(-6 15.5 10)"/><ellipse cx="24.5" cy="10" rx="3.6" ry="4.8" transform="rotate(6 24.5 10)"/><ellipse cx="31.5" cy="17" rx="3.6" ry="4.6" transform="rotate(20 31.5 17)"/></svg>`,
  clock: `<svg viewBox="0 0 40 40"><circle cx="20" cy="21" r="14" fill="rgba(255,255,255,.12)" stroke="currentColor" stroke-width="3"/><path d="M20 12 L20 21 L26 25" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M16 4 L24 4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`,
  eye: `<svg viewBox="0 0 40 40"><path d="M3 20 Q20 4 37 20 Q20 36 3 20 Z" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/><circle cx="20" cy="20" r="6" fill="currentColor"/><path class="rkr-eslash" d="M7 33 L33 7" stroke="#ff5c7a" stroke-width="3.6" stroke-linecap="round"/></svg>`,
  full: `<svg viewBox="0 0 40 40"><path d="M7 15 V7 H15 M25 7 H33 V15 M33 25 V33 H25 M15 33 H7 V25" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  menu: `<svg viewBox="0 0 40 40"><path d="M9 12 H31 M9 20 H31 M9 28 H31" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/></svg>`,
  crown: `<svg viewBox="0 0 40 40"><path d="M5 30 L3 11 L13 19 L20 6 L27 19 L37 11 L35 30 Z" fill="#ffd34a" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/><path d="M6 30 H34 V35 H6 Z" fill="#ffb21f" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><circle cx="20" cy="23" r="2.6" fill="#ff5c93"/><circle cx="12" cy="25" r="1.8" fill="#4cc9ff"/><circle cx="28" cy="25" r="1.8" fill="#3ee08f"/><path d="M8 14 L9.5 26" stroke="#fff" stroke-width="2" opacity=".6" stroke-linecap="round"/></svg>`,
  flag: `<svg viewBox="0 0 40 40"><path d="M10 4 V37" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/><path d="M11 6 Q19 2 25 7 Q30 11 35 8 L35 22 Q29 25 24 21 Q18 17 11 21 Z" fill="#3ee08f" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/></svg>`,
  speaker: `<svg viewBox="0 0 40 40"><path d="M6 15 L13 15 L22 7 L22 33 L13 25 L6 25 Z" fill="currentColor" stroke-linejoin="round"/><g class="rkr-waves" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M27 14 Q31 20 27 26"/><path d="M31 10 Q38 20 31 30"/></g><g class="rkr-slash" stroke="#ff5c7a" stroke-width="3.4" stroke-linecap="round"><path d="M27 14 L37 26 M37 14 L27 26"/></g></svg>`,
};

const CSS = `
.rkr-root{font-family:${FONT};color:#fff;-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none;}
.rkr-root *{box-sizing:border-box;}
.rkr-root svg{display:block;}
.rkr-hidden{display:none !important;}
/* account total (account.js): a gold tag under the name, before the speed; as long as it needs to be (funny numbers) */
.rkr-card .rkr-paid{font-size:13px;font-weight:900;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;
  color:#ffd56b;background:rgba(20,8,40,.6);padding:3px 7px;border-radius:7px;text-shadow:none;
  margin-left:-7px;}   /* (its digits start right under the name) */
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full) .rkr-paid{display:none;}
/* the account total in a little goldfish (fishHTML draws it as long as the number needs); the digits sit on its body */
.rkr-fish{position:relative;display:inline-flex;align-items:center;height:18px;font-size:12px;font-weight:900;line-height:1;white-space:nowrap;
  font-variant-numeric:tabular-nums;color:#4a1d00;text-shadow:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35));}
.rkr-fish svg{display:block;flex:none;overflow:visible;}
/* the classic tag in a label / beside the scoreboard (the card's own is .rkr-paid) */
.rkr-ctag{font-size:13px;font-weight:900;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;color:#ffd56b;background:rgba(20,8,40,.85);
  padding:3px 7px;border-radius:7px;text-shadow:none;}
.rkr-fish:has(> .rkr-ctag){filter:none;}
.rkr-fish b.rkr-ctag{position:static;height:auto;display:inline-block;}
.rkr-fish b{position:absolute;top:0;height:18px;display:flex;align-items:center;justify-content:center;font-weight:900;}


/* ---------------- HUD ---------------- */
.rkr-hud{position:absolute;inset:0;pointer-events:none;transition:opacity .4s;}
.rkr-hud.rkr-off{opacity:0;}
.rkr-tl{position:absolute;left:16px;top:14px;display:flex;flex-direction:column;gap:10px;align-items:flex-start;}
.rkr-lvlrow{display:flex;gap:8px;align-items:center;}
.rkr-level{position:relative;padding:4px 16px 6px;border-radius:16px;font-weight:900;font-size:22px;letter-spacing:.04em;
  background:linear-gradient(180deg,#ffcf5a,#ff8a3d);color:#4a1d06;border:3px solid #4a1d06;
  box-shadow:0 4px 0 #4a1d06,0 8px 18px rgba(0,0,0,.35);text-shadow:0 1px 0 rgba(255,255,255,.55);}
.rkr-level small{font-size:13px;margin-right:4px;opacity:.8;}
.rkr-level.rkr-pop{animation:rkr-pop .5s cubic-bezier(.2,1.6,.4,1);}
.rkr-timer{display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:14px;font-weight:800;font-size:18px;
  background:rgba(20,10,40,.55);border:2px solid rgba(255,255,255,.18);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  font-variant-numeric:tabular-nums;color:#e9e2ff;}
.rkr-timer svg{width:18px;height:18px;color:#cdbfff;}
.rkr-cards{display:flex;flex-direction:column;gap:8px;}
/* vote to kill (online): started from the spectate bar (main.js), then shown to everyone under the top middle: one
   line a kitty being voted on, with VOTE; on yours a warning to move */
.rkr-votes{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:6px;}
.rkr-vote{display:flex;align-items:center;gap:8px;padding:3px 4px 3px 12px;border-radius:999px;background:rgba(58,22,80,.82);border:2px solid #e0344f;
  font-weight:900;font-size:13px;color:#fff;white-space:nowrap;pointer-events:auto;max-width:calc(100vw - 24px);}
.rkr-vote > span{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.rkr-vote.rkr-self{background:linear-gradient(180deg,#ffd56b,#ff9d2e);border-color:#3a1650;color:#3a1650;padding-right:12px;white-space:normal;border-radius:16px;text-align:center;}
.rkr-vote button{flex:none;font:inherit;font-weight:900;font-size:12px;color:#fff;padding:3px 10px;border-radius:999px;cursor:pointer;
  background:linear-gradient(180deg,#ff7a8a,#e0344f);border:2px solid #3a1650;}
.rkr-vote button:hover{filter:brightness(1.1);}
.rkr-vote button:disabled{background:linear-gradient(180deg,#9a8fb0,#6d6488);cursor:default;filter:none;}
.rkr-cards.rkr-many{gap:4px;}
/* HUD toggle (hides everything but the corner buttons) + touch-only menu button */
/* corner controls are <button>s: drop the UA button look so they render like the old divs */
.rkr-hudbtn,.rkr-menubtn,.rkr-mute{-webkit-appearance:none;appearance:none;margin:0;font:inherit;line-height:normal;text-align:start;vertical-align:baseline;
  -webkit-tap-highlight-color:transparent;}
.rkr-hudbtn:focus:not(:focus-visible),.rkr-menubtn:focus:not(:focus-visible),.rkr-mute:focus:not(:focus-visible){outline:none;}
.rkr-hudbtn:focus-visible,.rkr-menubtn:focus-visible,.rkr-mute:focus-visible{outline:3px solid #fff;outline-offset:3px;}
.rkr-hudbtn,.rkr-menubtn{width:42px;height:42px;padding:8px;border-radius:14px;background:rgba(20,10,40,.55);border:2px solid rgba(255,255,255,.18);
  color:#fff;cursor:pointer;pointer-events:auto;}
.rkr-hudbtn .rkr-eslash{display:none;}
.rkr-fullbtn.rkr-on{border-color:rgba(140,220,255,.8);color:#bfeaff;}
html.rkr-touch .rkr-fullbtn{display:none;}
.rkr-hud.rkr-min .rkr-hudbtn .rkr-eslash{display:inline;}
.rkr-hud.rkr-min .rkr-tl,.rkr-hud.rkr-min .rkr-tc,.rkr-hud.rkr-min .rkr-map,.rkr-hud.rkr-min .rkr-scores,.rkr-hud.rkr-min .rkr-hint{display:none;}
.rkr-menubtn{display:none;}
html.rkr-touch .rkr-menubtn{display:block;}
html.rkr-touch .rkr-hint,html.rkr-touch .rkr-desk,html.rkr-touch .rkr-keyhint{display:none !important;}
.rkr-touchonly{display:none;}
html.rkr-touch .rkr-touchonly{display:block;}
.rkr-touchhint{font-weight:800;font-size:15px;color:#efe7ff;text-align:center;opacity:.9;}
.rkr-overlay{touch-action:pan-y;}
.rkr-scores{position:absolute;right:16px;top:58px;min-width:150px;max-width:280px;padding:6px 10px;border-radius:12px;
  background:rgba(10,4,30,.32);font-size:13px;font-weight:800;opacity:.85;pointer-events:none;}
.rkr-scores .rkr-sh{font-size:10px;letter-spacing:.14em;color:#ffcf5a;opacity:.9;margin-bottom:2px;}
.rkr-scores .rkr-sr{display:flex;gap:8px;align-items:center;line-height:1.5;}
.rkr-scores .rkr-sr span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkr-scores .rkr-scr{display:flex;align-items:center;gap:2px;flex:none;font-size:12px;font-weight:900;color:#ffd56b;font-variant-numeric:tabular-nums;}
.rkr-scores .rkr-scr svg{width:13px;height:13px;}
.rkr-scores .rkr-scr.rkr-srev{color:#fff;}
.rkr-scores .rkr-scr.rkr-scau{color:#fff;}
.rkr-scores .rkr-scr.rkr-scol{min-width:28px;}   /* (columns: crowns, revives, times caught line up row to row) */
.rkr-scores .rkr-scr.rkr-szero{opacity:.3;}
.rkr-scores .rkr-sr.rkr-steam{flex-wrap:wrap;}
.rkr-scores .rkr-sr.rkr-steam > span:first-child{pointer-events:auto;cursor:default;}
.rkr-scores .rkr-smem{display:none;flex-basis:100%;margin:-2px 0 3px;font-size:11px;font-weight:700;line-height:1.3;color:rgba(255,255,255,.8);white-space:normal;}
.rkr-scores .rkr-sr.rkr-sopen .rkr-smem{display:block;}
.rkr-scores .rkr-sv{pointer-events:auto;cursor:default;}
.rkr-scores .rkr-scr.rkr-shid{display:none;}   /* (revives and times caught: shown while the score is hovered, or for a moment after a tap) */
.rkr-scores .rkr-sr.rkr-sopen .rkr-scr.rkr-shid{display:flex;}
.rkr-scores .rkr-sdmed{display:inline-block;width:13px;height:13px;color:#ff5c93;}
.rkr-scores .rkr-sdmed svg{width:100%;height:100%;display:block;}
.rkr-scores .rkr-sdmed .mi{stroke:#fff;}
.rkr-scores .rkr-sdmed .mo{stroke:#2b1840;}
.rkr-scores .rkr-sdmed .mk{fill:#fff;stroke:#2b1840;}
.rkr-scores .rkr-sr.rkr-me{text-decoration:underline;text-underline-offset:3px;}
/* the account total on the scoreboard: hidden, shown beside the row while its name is hovered or after a tap on it */
.rkr-scores .rkr-sr[data-paid]{position:relative;pointer-events:auto;cursor:default;}
/* (hidden, not display:none: the fish keeps drawing, so its shine is already moving when it shows) */
.rkr-scores .rkr-sr .rkr-fish{position:absolute;right:calc(100% + 6px);top:50%;transform:translateY(-50%);visibility:hidden;}
.rkr-card .rkr-paid.rkr-fish{background:none;padding:0;border-radius:0;margin-left:-3px;color:#4a1d00;}
.rkr-scores .rkr-sr[data-paid]:hover .rkr-fish,.rkr-scores .rkr-sr[data-paid].rkr-showpaid .rkr-fish{visibility:visible;}
.rkr-scores .rkr-best{opacity:.65;font-size:11px;margin-top:2px;}
.rkr-cards.rkr-many .rkr-card{zoom:.68;}
/* the fish on a card: a little bigger than the scoreboard's. In a big lobby your own card shrinks less than the
   others (its name, speed and fish stay readable), and a face's hover label keeps its fish full size (1.75 x .68) */
.rkr-card .rkr-fish{zoom:1.2;}
.rkr-cards.rkr-many .rkr-card.rkr-you{zoom:.85;}
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full) .rkr-tip .rkr-fish{zoom:.9;}   /* (.9 x the faces' 1.3) */
/* big lobbies: everyone but you is just a face (colour + alive / down), no name */
/* (faces keep the cards' zoom, so a face is exactly the size of the card's boots icon) */
.rkr-cards.rkr-tiny{display:grid;grid-template-columns:repeat(8,max-content);gap:1px 2px;align-items:center;justify-items:center;max-width:none;}   /* (8 faces a row) */
.rkr-cards .rkr-card.rkr-you{order:-1;}   /* your own card always on top */
.rkr-cards.rkr-tiny .rkr-card.rkr-you,.rkr-cards.rkr-tiny .rkr-card.rkr-full{grid-column:1 / -1;justify-self:start;margin-bottom:2px;min-width:max-content;}   /* (wider than the faces' rows when its line needs it) */
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full){min-width:0;padding:0;border-radius:5px;border-width:1px;gap:0;box-shadow:none;}
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full) .rkr-cbody{display:none;}
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full){zoom:1.3;}   /* (the faces: a big lobby's 31 others take less room than 4 full cards; the koi rim scales with them) */
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full) .rkr-head{width:18px;height:18px;filter:none;}
.rkr-cards.rkr-tiny .rkr-card.rkr-down:not(.rkr-you):not(.rkr-full) .rkr-head{filter:grayscale(.6);}
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full){pointer-events:auto;}
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full):hover{z-index:5;}
/* a face with an account total: a koi rim (cream with orange patches, the fish's band of light sliding right to left
   over it) with four little koi swimming round it clockwise (one a side), their bellies tucked behind the face, and its fish in the hover label. A kitty that's down keeps
   the down look (the red rim) */
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full){border-width:2px;}
.rkr-card .rkr-koibits{display:none;}
.rkr-cards.rkr-tiny .rkr-card.rkr-haspaid.rkr-koi:not(.rkr-you):not(.rkr-full):not(.rkr-down){margin:1px;}   /* (the fish may poke a little over the next face) */
.rkr-cards.rkr-tiny .rkr-card.rkr-haspaid.rkr-koi:not(.rkr-you):not(.rkr-full):not(.rkr-down) .rkr-koibits{display:block;position:absolute;left:-10px;top:-10px;width:38px;height:38px;
  overflow:visible;pointer-events:none;}
/* the classic tag's face: a gold rim */
.rkr-cards.rkr-tiny .rkr-card.rkr-haspaid:not(.rkr-koi):not(.rkr-you):not(.rkr-full):not(.rkr-down){border-color:#ffd56b;box-shadow:0 0 0 1px rgba(255,213,107,.5);}
.rkr-cards.rkr-tiny .rkr-card.rkr-haspaid.rkr-koi:not(.rkr-you):not(.rkr-full):not(.rkr-down){border-color:transparent;
  background:linear-gradient(#24133f,#24133f) padding-box,
    linear-gradient(100deg,transparent 30%,rgba(255,255,255,.85) 42%,rgba(58,42,64,.25) 50%,transparent 58%) border-box,
    conic-gradient(from 20deg,#ff8a2e 0 12%,#fff1d6 12% 52%,#ff8a2e 52% 64%,#fff1d6 64%) border-box;
  box-shadow:0 0 0 1px #2b1840;background-size:100% 100%,300% 100%,100% 100%;background-repeat:no-repeat;animation:rkr-koirim 3.4s linear infinite;}
@keyframes rkr-koirim{from{background-position:0 0,0% 0,0 0;}to{background-position:0 0,100% 0,0 0;}}
/* a face's hover label: its name, and its fish (kept drawn while hidden, so the fish's light is already moving) */
.rkr-card .rkr-tip{display:none;}
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full) .rkr-tip{display:flex;visibility:hidden;align-items:center;gap:8px;position:absolute;left:-2px;top:calc(100% + 4px);
  padding:2px 8px;border-radius:8px;background:rgba(20,10,40,.9);border:1px solid rgba(255,255,255,.2);color:var(--pc);font-weight:900;font-size:13px;white-space:nowrap;pointer-events:none;}   /* (13 x the faces' 1.3: about the fish's size) */
.rkr-cards.rkr-tiny .rkr-card:not(.rkr-you):not(.rkr-full):hover .rkr-tip{visibility:visible;}
.rkr-card{--pc:#ffb347;position:relative;display:flex;align-items:center;gap:10px;min-width:210px;padding:8px 12px 8px 8px;border-radius:18px;
  background:linear-gradient(135deg,rgba(30,16,60,.72),rgba(30,16,60,.5));border:2px solid rgba(255,255,255,.14);
  box-shadow:inset 4px 0 0 var(--pc),0 6px 16px rgba(0,0,0,.3);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  transition:transform .25s,border-color .25s;}
.rkr-card .rkr-head{position:relative;width:44px;height:44px;flex:none;color:var(--pc);filter:drop-shadow(0 2px 0 rgba(0,0,0,.35));}
.rkr-card .rkr-head svg{display:block;width:100%;height:100%;}
.rkr-card .rkr-shades,.rkr-card .rkr-shades-broken{position:absolute;inset:0;display:none !important;}
.rkr-card.rkr-cool:not(.rkr-down) .rkr-shades{display:block !important;}
.rkr-card .rkr-specs{position:absolute;inset:0;display:none !important;}
.rkr-card.rkr-specson:not(.rkr-down) .rkr-specs{display:block !important;}
/* 12+ wins: the name shimmers through the rainbow (player card and scoreboard) */
@keyframes rkr-shim{to{background-position:-300% 0;}}
.rkr-card.rkr-shimmer .rkr-name,.rkr-scores .rkr-shim{background:linear-gradient(90deg,#ff6b81,#ffd56b,#6bff9a,#6bd5ff,#c27bff,#ff6b81);background-size:300% 100%;
  -webkit-background-clip:text;background-clip:text;color:transparent !important;text-shadow:none;filter:drop-shadow(0 2px 0 rgba(0,0,0,.45));animation:rkr-shim 3s linear infinite;}
.rkr-card.rkr-shimmer.rkr-goldname .rkr-name,.rkr-scores .rkr-shim.rkr-goldname{background-image:linear-gradient(90deg,#b8791f,#ffd56b,#fff6d0,#ffd56b,#b8791f,#ffd56b,#b8791f);}
.rkr-card.rkr-cool.rkr-down .rkr-shades-broken{display:block !important;}
.rkr-card.rkr-cool.rkr-down .rkr-xeyes{display:none;}
.rkr-card.rkr-rainbow .rkr-cat > path:first-child,.rkr-card.rkr-rainbow .rkr-medic svg > path:first-child{fill:url(#rkr-rainbow-fur);}
.rkr-card .rkr-head .rkr-mane{position:absolute;inset:0;width:100%;height:100%;overflow:visible;z-index:-1;display:none;}   /* (beats .rkr-head svg{display:block}) */
.rkr-card .rkr-mane path{fill:#a0522d;fill:color-mix(in srgb,currentColor 62%,#2b1840);stroke:#2b1840;stroke-width:3.2;paint-order:stroke fill;stroke-linejoin:round;}
.rkr-card.rkr-lion .rkr-head .rkr-mane{display:block;}
.rkr-card.rkr-rlion .rkr-mane path{fill:url(#rkr-rainbow-fur);}
.rkr-card.rkr-chrome .rkr-mane path,.rkr-card.rkr-chrome .rkr-cat > path:first-child,.rkr-card.rkr-chrome .rkr-medic svg > path:first-child{fill:url(#rkr-chrome-fur);}
/* a chrome / golden / bronze kitty's sunglasses: its metal instead of black lenses */
/* (each lens its own slow brushed-mirror lines, left to right: rkr-*-lens-rl) */
.rkr-card.rkr-chrome .rkr-shades ellipse{fill:url(#rkr-chrome-lens-rl);}
.rkr-card.rkr-mgold .rkr-shades ellipse{fill:url(#rkr-gold-lens-rl);}
.rkr-card.rkr-mbronze .rkr-shades ellipse{fill:url(#rkr-bronze-lens-rl);}
.rkr-card.rkr-lm-chrome .rkr-shades ellipse{fill:url(#rkr-chrome-lens-rl);}
.rkr-card.rkr-lm-gold .rkr-shades ellipse{fill:url(#rkr-gold-lens-rl);}
.rkr-card.rkr-lm-bronze .rkr-shades ellipse{fill:url(#rkr-bronze-lens-rl);}
/* the glasses' shine switched off: the lenses a still tint of their metal */
.rkr-card.rkr-lensstill.rkr-chrome .rkr-shades ellipse{fill:#aeb8c6;}
.rkr-card.rkr-lensstill.rkr-mgold .rkr-shades ellipse{fill:#e0a020;}
.rkr-card.rkr-lensstill.rkr-mbronze .rkr-shades ellipse{fill:#b0662a;}
.rkr-card.rkr-lensstill.rkr-lm-chrome .rkr-shades ellipse{fill:#aeb8c6;}
.rkr-card.rkr-lensstill.rkr-lm-gold .rkr-shades ellipse{fill:#e0a020;}
.rkr-card.rkr-lensstill.rkr-lm-bronze .rkr-shades ellipse{fill:#b0662a;}
.rkr-card.rkr-mbronze .rkr-mane path,.rkr-card.rkr-mbronze .rkr-cat > path:first-child,.rkr-card.rkr-mbronze .rkr-medic svg > path:first-child{fill:url(#rkr-bronze-fur);}
.rkr-card.rkr-mgold .rkr-mane path,.rkr-card.rkr-mgold .rkr-cat > path:first-child,.rkr-card.rkr-mgold .rkr-medic svg > path:first-child{fill:url(#rkr-gold-fur);}
.rkr-card.rkr-celestial .rkr-mane path,.rkr-card.rkr-celestial .rkr-cat > path:first-child,.rkr-card.rkr-celestial .rkr-medic svg > path:first-child{fill:url(#rkr-cosmic-fur);}
.rkr-card.rkr-celestial .rkr-mane path{stroke:#8fb8ff;}
/* the mane in a metal of its own (main.js iconLook maneMetal), over the body's */
.rkr-card.rkr-lion.rkr-mm-chrome .rkr-mane path{fill:url(#rkr-chrome-fur);}
.rkr-card.rkr-lion.rkr-mm-gold .rkr-mane path{fill:url(#rkr-gold-fur);}
.rkr-card.rkr-lion.rkr-mm-bronze .rkr-mane path{fill:url(#rkr-bronze-fur);}
.rkr-defs{position:absolute;width:0;height:0;overflow:hidden;}
.rkr-xeyes{display:none;}
.rkr-card.rkr-down .rkr-eyes{display:none;}
.rkr-card.rkr-down .rkr-xeyes{display:inline;}
.rkr-card.rkr-down{border-color:rgba(255,70,90,.8);animation:rkr-downpulse 1s ease-in-out infinite;}
.rkr-card.rkr-down .rkr-head{filter:grayscale(.6) drop-shadow(0 2px 0 rgba(0,0,0,.35));transform:rotate(-12deg);}
.rkr-cbody{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}
.rkr-crow{display:flex;align-items:center;gap:8px;}
.rkr-name{font-weight:900;font-size:17px;color:var(--pc);text-shadow:0 2px 0 rgba(0,0,0,.45);white-space:nowrap;}
.rkr-status{font-size:11px;font-weight:900;letter-spacing:.08em;padding:1px 7px;border-radius:999px;background:#38d97a;color:#073a1c;}
.rkr-down .rkr-status{background:#ff3b5c;color:#fff;animation:rkr-blink .6s steps(2) infinite;}
.rkr-hearts{display:flex;gap:2px;margin-left:auto;}
/* the medic badge: its cross in the kitty's colour, or its chrome / rainbow / gold / bronze / celestial look (with the fur, above) */
.rkr-medic{width:24px;height:24px;margin:-4px 0;flex:none;color:var(--pc,#ff5c93);filter:drop-shadow(0 1px 1px rgba(0,0,0,.45));}
.rkr-medic svg{width:100%;height:100%;display:block;}
.rkr-medic .mi{stroke:var(--mi,#fff);}
.rkr-medic .mo{stroke:var(--mo,#2b1840);}
.rkr-medic .mk{fill:var(--mi,#fff);stroke:var(--mo,#2b1840);}
.rkr-card.rkr-pale{--mi:#2b1840;--mo:rgba(255,255,255,.85);}
.rkr-medic.rkr-hidden{display:none;}
.rkr-hearts span{width:18px;height:16px;}
.rkr-hearts span.rkr-new{animation:rkr-pop .5s cubic-bezier(.2,1.6,.4,1);}
.rkr-boots{display:flex;align-items:center;gap:4px;font-weight:800;font-size:13px;color:#9ff0ff;font-variant-numeric:tabular-nums;}
.rkr-boots svg{width:18px;height:18px;}
.rkr-boots.rkr-pop{animation:rkr-pop .5s cubic-bezier(.2,1.6,.4,1);}
.rkr-shield{display:flex;align-items:center;gap:5px;height:14px;}
.rkr-shield svg{width:14px;height:14px;}
.rkr-sbar{flex:1;height:7px;border-radius:9px;background:rgba(255,255,255,.12);overflow:hidden;}
.rkr-sfill{height:100%;width:100%;border-radius:9px;background:linear-gradient(90deg,#5aaaff,#bfe6ff);transform-origin:left center;box-shadow:0 0 8px #5aaaff;}

.rkr-tc{position:absolute;left:50%;top:12px;transform:translateX(-50%);display:flex;flex-direction:column;gap:0;align-items:center;}
  background:linear-gradient(180deg,rgba(40,20,70,.8),rgba(40,20,70,.55));border:3px solid #ffc93c;color:#ffe08a;
  box-shadow:0 0 0 3px rgba(0,0,0,.25),0 6px 20px rgba(255,190,40,.25);text-shadow:0 2px 0 #6b3d00;font-variant-numeric:tabular-nums;}
.rkr-resc{display:flex;align-items:center;gap:5px;padding:4px 12px;border-radius:999px;font-weight:800;font-size:16px;
  background:rgba(40,20,70,.6);border:2px solid rgba(185,164,255,.6);color:#ddd2ff;font-variant-numeric:tabular-nums;}
.rkr-resc svg{width:22px;height:22px;}

.rkr-tr{position:absolute;right:16px;top:14px;display:flex;gap:8px;align-items:center;}
.rkr-mute{width:42px;height:42px;padding:8px;border-radius:14px;background:rgba(20,10,40,.55);border:2px solid rgba(255,255,255,.18);
  color:#fff;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:auto;cursor:pointer;}
.rkr-mute:hover{border-color:rgba(255,255,255,.5);}
.rkr-mute .rkr-slash{display:none;}
.rkr-mute.rkr-muted{color:#ff9fb2;border-color:rgba(255,92,122,.6);}
.rkr-mute.rkr-muted .rkr-slash{display:inline;}
.rkr-mute.rkr-muted .rkr-waves{display:none;}
.rkr-hint{font-size:12px;font-weight:800;color:rgba(255,255,255,.7);display:flex;gap:6px;align-items:center;}

/* ---------------- minimap ---------------- */
.rkr-map{position:absolute;right:16px;bottom:16px;width:190px;height:190px;border-radius:18px;overflow:hidden;
  background:radial-gradient(circle at 50% 40%,rgba(50,30,90,.75),rgba(15,8,30,.82));
  border:3px solid rgba(255,255,255,.85);box-shadow:0 0 0 4px rgba(60,30,110,.6),0 10px 30px rgba(0,0,0,.45),inset 0 0 24px rgba(0,0,0,.5);}
.rkr-map canvas{position:absolute;inset:0;width:100%;height:100%;}

/* ---------------- banner & toasts ---------------- */
.rkr-banner{position:absolute;left:0;right:0;top:30%;display:flex;flex-direction:column;align-items:center;text-align:center;pointer-events:none;opacity:0;}
.rkr-banner .rkr-bt{font-weight:900;font-size:clamp(44px,9vw,110px);line-height:1;letter-spacing:.03em;color:#fff6d8;
  -webkit-text-stroke:3px #3a1650;paint-order:stroke fill;
  text-shadow:0 6px 0 #3a1650,0 10px 0 rgba(0,0,0,.25),0 0 40px rgba(255,200,90,.6);}
.rkr-banner .rkr-bs{margin-top:10px;font-weight:800;font-size:clamp(16px,2.6vw,26px);color:#ffe7f2;padding:4px 18px;border-radius:999px;
  background:rgba(40,16,70,.55);text-shadow:0 2px 0 rgba(0,0,0,.4);}
.rkr-banner.rkr-in{animation:rkr-slam .55s cubic-bezier(.2,1.4,.4,1) forwards;}
.rkr-banner.rkr-out{animation:rkr-flyout .45s cubic-bezier(.6,0,.8,.4) forwards;}
.rkr-toasts{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);display:flex;flex-direction:column-reverse;align-items:center;gap:8px;pointer-events:none;}
.rkr-toast{--tc:#fff;display:flex;align-items:center;gap:8px;padding:7px 18px 8px;border-radius:999px;font-weight:800;font-size:17px;white-space:nowrap;
  background:rgba(25,12,50,.82);border:2px solid var(--tc);color:#fff;box-shadow:0 0 18px var(--tc-glow, rgba(255,255,255,.2)),0 6px 16px rgba(0,0,0,.35);
  animation:rkr-toastin .35s cubic-bezier(.2,1.5,.4,1);}
.rkr-toast i{width:10px;height:10px;border-radius:50%;background:var(--tc);box-shadow:0 0 8px var(--tc);}
.rkr-toast.rkr-bye{animation:rkr-toastout .4s ease-in forwards;}

/* ---------------- overlays ---------------- */
.rkr-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;overflow:auto;padding:20px 16px;}
.rkr-title{background:radial-gradient(ellipse at 50% 35%,rgba(70,30,120,.3),rgba(14,6,34,.72) 75%),linear-gradient(180deg,rgba(20,8,48,.15),rgba(8,2,22,.6));
  animation:rkr-fadein .6s ease-out;}
/* the title's bottom row (stats / feedback / music on the left, credits on the right): in the bottom corners while the
   menu fits on screen; when it doesn't (zoomed in, small screens: rkr-tight, set in buildTitle) it moves into the page
   flow under the panels, so it scrolls with them instead of landing on top of them */
.rkr-title{flex-direction:column;justify-content:flex-start;}
.rkr-title > .rkr-tcol{margin:auto 0;}
.rkr-tfoot{position:absolute;z-index:2;left:max(16px,env(safe-area-inset-left));right:max(16px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));
  display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;pointer-events:none;}
.rkr-tfoot > *{pointer-events:auto;}
.rkr-title.rkr-tight .rkr-tfoot{position:relative;left:auto;right:auto;bottom:auto;width:100%;margin-top:14px;flex:none;}
.rkr-footl{display:flex;gap:8px;flex-wrap:wrap;}
.rkr-statsbtn{
  pointer-events:auto;cursor:pointer;font:inherit;font-weight:900;font-size:14px;letter-spacing:.06em;color:#fff6d8;
  padding:7px 14px;border-radius:999px;border:2px solid rgba(255,255,255,.25);background:rgba(20,8,48,.55);}
.rkr-statsbtn:hover{background:rgba(60,30,110,.75);}
a.rkr-statsbtn{text-decoration:none;display:inline-block;line-height:normal;}
/* the main menu's SETTINGS: in the green of the Esc menu's SETTINGS button */
.rkr-statsbtn.rkr-setbtn{color:#3a1650;border-color:#3a1650;background:linear-gradient(180deg,#eafff0,#94f0b0 55%,#3ccf8e);box-shadow:0 3px 0 #3a1650;}
.rkr-statsbtn.rkr-setbtn:hover{background:linear-gradient(180deg,#f4fff7,#a8f5c0 55%,#52d99c);}
.rkr-credits{margin-left:auto;
  font-weight:800;font-size:14px;color:rgba(239,231,255,.75);}
.rkr-credits a{color:#ffcf5a;text-decoration:none;}
.rkr-credits a:hover{text-decoration:underline;}
.rkr-title.rkr-leaving{animation:rkr-fadeout .45s ease-in forwards;pointer-events:none;}
.rkr-tcol{display:flex;flex-direction:column;align-items:center;gap:18px;max-width:980px;width:100%;margin:auto;}
.rkr-logo{position:relative;display:flex;flex-wrap:wrap;justify-content:center;gap:0 .35em;font-weight:900;font-size:clamp(46px,9.5vw,118px);line-height:1.02;
  animation:rkr-logoin .9s cubic-bezier(.2,1.5,.4,1);}
/* "Project:" above the logo: the logo's own letters (gradient, outline), small and still */
.rkr-project{display:flex;justify-content:center;font-weight:900;font-size:clamp(18px,3.1vw,38px);line-height:1.1;letter-spacing:.04em;margin-bottom:.2em;
  animation:rkr-logoin .9s cubic-bezier(.2,1.5,.4,1);}
.rkr-project .rkr-l{animation:none;}
.rkr-word{display:flex;}
.rkr-l{position:relative;display:inline-block;color:#3a1650;-webkit-text-stroke:.16em #3a1650;
  text-shadow:0 .09em 0 #3a1650,0 .16em 0 rgba(0,0,0,.3),0 0 .4em rgba(255,120,200,.35);
  animation:rkr-bounce 2.2s cubic-bezier(.35,0,.25,1) infinite;animation-delay:calc(var(--i) * 90ms);transform-origin:50% 100%;}
.rkr-l::after{content:attr(data-c);position:absolute;left:0;top:0;-webkit-text-stroke:0;text-shadow:none;color:transparent;
  background:linear-gradient(180deg,#fff7c2 0%,#ffd04a 38%,#ff8a3d 62%,#ff4f9a 100%);-webkit-background-clip:text;background-clip:text;}
.rkr-word.rkr-kitty .rkr-l::after{background:linear-gradient(180deg,#fff0fb 0%,#ffa8de 40%,#c77dff 70%,#7b5cff 100%);-webkit-background-clip:text;background-clip:text;}
.rkr-logocat{position:absolute;width:.9em;height:.9em;right:-.55em;top:-.45em;color:#ffb347;transform:rotate(14deg);animation:rkr-wiggle 2.4s ease-in-out infinite;
  filter:drop-shadow(0 .05em 0 rgba(0,0,0,.35));}
.rkr-sub{max-width:640px;text-align:center;font-weight:700;font-size:clamp(15px,2vw,21px);color:#f1e8ff;line-height:1.35;text-shadow:0 2px 0 rgba(0,0,0,.45);}
.rkr-sub b{color:#ffcf5a;}
.rkr-btns{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;}
/* title with all three buttons (account on): one row or one column, never 2 + 1 */
.rkr-btns.rkr-three{display:grid;grid-template-columns:repeat(3,auto);justify-content:center;}
@media (max-width:820px){ .rkr-btns.rkr-three{grid-template-columns:auto;} }
.rkr-btn{pointer-events:auto;cursor:pointer;font-family:inherit;font-weight:900;font-size:clamp(18px,2.4vw,26px);letter-spacing:.04em;
  padding:14px 30px 16px;border-radius:22px;border:4px solid #3a1650;color:#3a1650;
  background:linear-gradient(180deg,#fff2a8,#ffc93c 55%,#ff9a3d);box-shadow:0 7px 0 #3a1650,0 14px 26px rgba(0,0,0,.4);
  transition:transform .12s,box-shadow .12s,filter .12s;display:flex;flex-direction:column;align-items:center;gap:2px;}
.rkr-btn small{font-size:.55em;letter-spacing:.02em;opacity:.75;font-weight:800;}
.rkr-btn.rkr-alt{background:linear-gradient(180deg,#e3f7ff,#7fd8ff 55%,#5b9dff);}
.rkr-goshare{position:absolute;top:16px;right:16px;}   /* the game-over card's SHARE (share.js) */
.rkr-btn.rkr-set{background:linear-gradient(180deg,#eafff0,#94f0b0 55%,#3ccf8e);}   /* the Esc menu's SETTINGS (settings.js) */
.rkr-btn.rkr-goagain{background:linear-gradient(180deg,#eafff0,#94f0b0 55%,#3ccf8e);}   /* the game-over card's RESTART GAME (a lobby's host) */
.rkr-btn.rkr-swag{background:linear-gradient(180deg,#ffe1f4,#ff9ad5 55%,#c77dff);}   /* 4: optional account (account.js) */
.rkr-btn:hover,.rkr-btn.rkr-sel{transform:translateY(-3px) scale(1.04);filter:brightness(1.08);box-shadow:0 10px 0 #3a1650,0 18px 30px rgba(0,0,0,.45),0 0 0 5px rgba(255,255,255,.35);}
.rkr-btn:active{transform:translateY(4px) scale(.98);box-shadow:0 3px 0 #3a1650,0 6px 14px rgba(0,0,0,.4);}
.rkr-btn:focus:not(:focus-visible){outline:none;}
.rkr-btn:focus-visible{outline:3px solid #fff;outline-offset:3px;}
.rkr-btn .rkr-kk{display:inline-block;margin-right:8px;padding:0 7px;border-radius:7px;font-size:.7em;background:rgba(58,22,80,.15);border:2px solid rgba(58,22,80,.35);}
.rkr-info{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;width:100%;}
.rkr-panel{background:linear-gradient(160deg,rgba(255,255,255,.14),rgba(255,255,255,.05));border:2px solid rgba(255,255,255,.2);border-radius:22px;
  padding:14px 18px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.35);}
.rkr-panel h3{margin:0 0 10px;font-size:15px;font-weight:900;letter-spacing:.14em;color:#ffcf5a;text-transform:uppercase;}
.rkr-how{flex:1 1 380px;max-width:520px;}
.rkr-items{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;}
.rkr-item{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:700;color:#efe7ff;line-height:1.15;}
.rkr-item b{display:block;font-size:15px;color:#fff;}
.rkr-ico{width:34px;height:34px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(0,0,0,.25);padding:4px;}
.rkr-ico svg{width:100%;height:100%;}
.rkr-ctl{flex:0 1 380px;}
.rkr-notes{flex:1 1 100%;max-width:916px;max-height:230px;overflow:auto;text-align:left;}
.rkr-note{margin-bottom:10px;}
.rkr-note .rkr-nh{display:flex;gap:10px;align-items:baseline;font-weight:900;font-size:15px;}
.rkr-note .rkr-nv{color:#ffcf5a;}
.rkr-note .rkr-nd{opacity:.5;font-size:12px;font-weight:700;}
.rkr-note ul{margin:4px 0 0;padding-left:20px;font-size:13.5px;font-weight:700;color:#efe7ff;line-height:1.45;}
@media (min-width:1100px){
  .rkr-tcol{max-width:1180px;}
  .rkr-info{flex-wrap:nowrap;align-items:stretch;}
  .rkr-how{flex:1 1 0;max-width:none;}
  .rkr-how .rkr-items{grid-template-columns:1fr;}
  .rkr-ctl{flex:0 0 auto;}
  .rkr-notes{flex:1.2 1 0;max-width:none;max-height:330px;}
}
.rkr-notes h3 + .rkr-note .rkr-nh::after{content:'NEW';font-size:10px;letter-spacing:.12em;background:#ff5c93;color:#fff;border-radius:6px;padding:1px 6px;}
.rkr-ctlgrid{display:grid;grid-template-columns:auto auto;gap:10px 18px;align-items:center;}
.rkr-ctlgrid .rkr-lab{font-weight:800;font-size:14px;color:#efe7ff;}
.rkr-ctlgrid .rkr-lab em{font-style:normal;font-weight:900;}
.rkr-keys{display:grid;grid-template-columns:repeat(3,auto);gap:3px;justify-content:start;}
.rkr-keys .rkr-k:nth-child(1){grid-column:2;grid-row:1;}
.rkr-keys .rkr-k:nth-child(2){grid-column:1;grid-row:2;}
.rkr-keys .rkr-k:nth-child(3){grid-column:2;grid-row:2;}
.rkr-keys .rkr-k:nth-child(4){grid-column:3;grid-row:2;}
.rkr-k{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 7px;border-radius:8px;
  font-family:inherit;font-weight:900;font-size:14px;color:#3a1650;background:linear-gradient(180deg,#ffffff,#ddd4f2);
  border:2px solid #3a1650;box-shadow:0 3px 0 #3a1650;line-height:1;}
.rkr-k.rkr-wide{min-width:46px;}
.rkr-krow{display:flex;gap:4px;align-items:center;flex-wrap:wrap;}
.rkr-paws{position:absolute;inset:0;overflow:hidden;pointer-events:none;}
.rkr-paws span{position:absolute;width:44px;height:44px;opacity:.09;fill:#fff;animation:rkr-drift linear infinite;}
.rkr-paws svg{width:100%;height:100%;}
.rkr-foot{font-size:13px;font-weight:700;color:rgba(255,255,255,.55);display:flex;gap:8px;align-items:center;}

.rkr-dim{background:radial-gradient(ellipse at center,rgba(20,8,48,.45),rgba(8,2,22,.78));animation:rkr-fadein .3s ease-out;}
.rkr-glass{position:relative;min-width:300px;max-width:440px;width:100%;padding:26px 28px 24px;border-radius:30px;text-align:center;
  background:linear-gradient(160deg,rgba(255,255,255,.2),rgba(255,255,255,.06));border:2px solid rgba(255,255,255,.3);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 20px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.4);
  animation:rkr-cardin .5s cubic-bezier(.2,1.4,.4,1);display:flex;flex-direction:column;align-items:center;gap:14px;margin:auto;}
.rkr-glass h2{margin:0;font-weight:900;font-size:clamp(40px,6vw,60px);line-height:1;color:#fff6d8;-webkit-text-stroke:2px #3a1650;paint-order:stroke fill;
  text-shadow:0 5px 0 #3a1650,0 0 30px rgba(255,200,90,.45);letter-spacing:.03em;}
.rkr-glass .rkr-gcat{width:74px;height:74px;color:#ffb347;margin-bottom:-6px;animation:rkr-wiggle 2.4s ease-in-out infinite;}
.rkr-gameover h2{color:#ffd6e3;text-shadow:0 5px 0 #3a1650,0 0 30px rgba(255,80,120,.55);}
.rkr-gsub{font-weight:700;font-size:16px;color:#efe7ff;opacity:.9;}
.rkr-nlink{font:inherit;font-size:13px;font-weight:700;color:#efe7ff;opacity:.65;background:none;border:0;cursor:pointer;text-decoration:underline;margin-top:2px;}
.rkr-nlink:hover{opacity:1;}
.rkr-alone{display:flex;gap:10px;align-items:center;text-align:left;max-width:420px;padding:10px 14px;border-radius:16px;font-weight:700;font-size:14px;line-height:1.35;color:#fff6d8;
  background:rgba(255,207,90,.14);border:2px solid rgba(255,207,90,.55);}
.rkr-alone svg{width:30px;height:30px;flex:none;}
.rkr-alone b{color:#ffcf5a;}
@media (max-height:500px){ .rkr-alone{font-size:12px;padding:6px 10px;} .rkr-alone svg{width:22px;height:22px;} }
.rkr-stats{width:100%;display:flex;flex-direction:column;gap:7px;}
.rkr-stat{display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:14px;background:rgba(0,0,0,.22);font-weight:800;font-size:16px;
  opacity:0;transform:translateX(-14px);transition:opacity .35s,transform .35s cubic-bezier(.2,1.5,.4,1);}
.rkr-stat.rkr-show{opacity:1;transform:none;}
.rkr-stat .rkr-ico{width:30px;height:30px;}
.rkr-stat .rkr-sl{flex:1;text-align:left;color:#e2d8ff;}
.rkr-stat .rkr-sv{font-size:22px;font-weight:900;color:#fff;font-variant-numeric:tabular-nums;}
.rkr-keyhint{font-size:13px;font-weight:700;color:rgba(255,255,255,.65);display:flex;gap:6px;align-items:center;}

/* ---------------- the final run: no minimap, no progress bar (you don't know how far it is) ---------------- */
.rkr-hud.rkr-finale .rkr-map,.rkr-hud.rkr-finale .rkr-tc,.rkr-hud.rkr-finale .rkr-hint{display:none;}

/* banner styles */
.rkr-banner.rkr-b-finale .rkr-bt{color:#ffe2d6;letter-spacing:.06em;-webkit-text-stroke:3px #3a0a0a;
  text-shadow:0 6px 0 #3a0a0a,0 10px 0 rgba(0,0,0,.35),0 0 40px rgba(220,50,20,.7);}
.rkr-banner.rkr-b-finale .rkr-bs{background:rgba(40,8,8,.75);color:#ffd8c8;border:2px solid rgba(230,90,60,.55);}
.rkr-banner.rkr-b-gold .rkr-bt{color:#ffe27a;text-shadow:0 6px 0 #3a1650,0 10px 0 rgba(0,0,0,.25),0 0 60px rgba(255,210,80,.95);}

/* ---------------- victory ---------------- */
.rkr-victory{background:radial-gradient(ellipse at 50% 30%,rgba(255,200,90,.12),rgba(20,8,48,.55) 70%);animation:rkr-fadein .6s ease-out;}
.rkr-victory .rkr-glass{max-width:520px;border-color:rgba(255,215,100,.75);box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 60px rgba(255,200,80,.35),inset 0 1px 0 rgba(255,255,255,.4);}
.rkr-victory h2{font-size:clamp(34px,5.4vw,54px);color:#ffe27a;text-shadow:0 5px 0 #3a1650,0 0 34px rgba(255,200,80,.8);}
.rkr-victory .rkr-vcrown{width:84px;height:84px;margin-bottom:-6px;animation:rkr-wiggle 2.4s ease-in-out infinite;filter:drop-shadow(0 0 16px rgba(255,210,80,.8));}
.rkr-vfirst{display:flex;align-items:center;gap:8px;padding:6px 16px;border-radius:999px;background:rgba(255,210,80,.16);border:2px solid rgba(255,210,80,.6);font-weight:900;font-size:17px;}
.rkr-vfirst svg{width:24px;height:24px;}
.rkr-vfirst .rkr-vname,.rkr-chip span{-webkit-text-stroke:3px #2b1840;paint-order:stroke fill;}
.rkr-party{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-height:96px;overflow:auto;}
/* a ranking on the end cards (rankHTML): 1st, 2nd, 3rd... with names, crowns and points; a big game the top 3 and you,
   the rest under "+N more" */
.rkr-rank{width:100%;display:flex;flex-direction:column;gap:6px;}
.rkr-rrow{display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:14px;background:rgba(0,0,0,.22);font-weight:800;font-size:16px;text-align:left;}
.rkr-rrow.rkr-rwin{background:rgba(255,207,90,.18);box-shadow:inset 0 0 0 2px #ffcf5a;}
.rkr-rpl{flex:none;width:34px;font-weight:900;color:#ffcf5a;}
.rkr-rn{flex:1;min-width:0;text-shadow:0 1px 2px rgba(0,0,0,.85),0 0 1px rgba(0,0,0,.9);}   /* (light cat colours stay readable, the winners' gold row too) */
.rkr-rn i{font-style:normal;color:rgba(255,255,255,.55);font-weight:700;}
.rkr-rn small{display:block;font-size:12px;font-weight:700;color:rgba(255,255,255,.6);white-space:normal;line-height:1.3;}   /* (every name, wrapping) */
.rkr-rs{flex:none;font-weight:900;}
.rkr-rank .rkr-scr{display:flex;align-items:center;gap:2px;flex:none;font-weight:900;color:#ffd56b;}
.rkr-rank .rkr-scr svg{width:16px;height:16px;}
.rkr-rrow.rkr-rhide{display:none;}
.rkr-rank.rkr-rall .rkr-rrow.rkr-rhide{display:flex;}
.rkr-rmore{font:inherit;font-weight:900;font-size:14px;color:#fff6d8;padding:7px 12px;border-radius:14px;cursor:pointer;background:rgba(0,0,0,.22);border:2px dashed rgba(255,255,255,.3);}
.rkr-rmore:hover{border-color:#ffcf5a;}
.rkr-chip{display:flex;align-items:center;gap:4px;padding:2px 10px 2px 4px;border-radius:999px;background:rgba(0,0,0,.25);font-weight:800;font-size:13px;}
.rkr-chip .rkr-cat{width:20px;height:20px;}
.rkr-vbtns{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;}
.rkr-vbtns .rkr-btn.rkr-mini{font-size:16px;padding:8px 18px 9px;border-radius:18px;}

/* ---------------- keyframes ---------------- */
@keyframes rkr-bounce{0%,58%,100%{transform:translateY(0) scale(1,1);}
  8%{transform:translateY(0) scale(1.12,.86);}20%{transform:translateY(-.2em) scale(.92,1.1);}
  32%{transform:translateY(0) scale(1.08,.9);}42%{transform:translateY(-.05em) scale(.98,1.03);}50%{transform:translateY(0) scale(1,1);}}
@keyframes rkr-logoin{0%{transform:scale(.3) translateY(-80px);opacity:0;}100%{transform:none;opacity:1;}}
@keyframes rkr-wiggle{0%,100%{transform:rotate(14deg);}50%{transform:rotate(-8deg) translateY(-3px);}}
@keyframes rkr-fadein{from{opacity:0;}to{opacity:1;}}
@keyframes rkr-fadeout{to{opacity:0;transform:scale(1.04);}}
@keyframes rkr-pop{0%{transform:scale(1);}40%{transform:scale(1.28);}100%{transform:scale(1);}}
@keyframes rkr-blink{0%{opacity:1;}100%{opacity:.35;}}
@keyframes rkr-downpulse{0%,100%{box-shadow:inset 4px 0 0 #ff3b5c,0 0 0 0 rgba(255,59,92,.0),0 6px 16px rgba(0,0,0,.3);}
  50%{box-shadow:inset 4px 0 0 #ff3b5c,0 0 18px 4px rgba(255,59,92,.55),0 6px 16px rgba(0,0,0,.3);}}
@keyframes rkr-slam{0%{opacity:0;transform:scale(2.4);filter:blur(14px);}60%{opacity:1;transform:scale(.93);filter:blur(0);}
  80%{transform:scale(1.04);}100%{opacity:1;transform:scale(1);filter:blur(0);}}
@keyframes rkr-flyout{0%{opacity:1;transform:none;filter:blur(0);}100%{opacity:0;transform:translateY(-60px) scale(.75);filter:blur(10px);}}
@keyframes rkr-toastin{0%{opacity:0;transform:translateY(20px) scale(.7);}100%{opacity:1;transform:none;}}
@keyframes rkr-toastout{to{opacity:0;transform:translateY(-12px) scale(.9);}}
@keyframes rkr-cardin{0%{opacity:0;transform:translateY(40px) scale(.85);}100%{opacity:1;transform:none;}}
@keyframes rkr-drift{0%{transform:translateY(0) rotate(var(--r));}100%{transform:translateY(-120vh) rotate(var(--r));}}

@media (max-width:760px){
  .rkr-prog{top:8px;}
  .rkr-pdist{font-size:13px;}
  .rkr-map{width:140px;height:140px;right:10px;bottom:10px;}
  .rkr-tl{left:10px;top:10px;}
  .rkr-card{min-width:170px;padding:6px 10px 6px 6px;}
  .rkr-card .rkr-head{width:34px;height:34px;}
  .rkr-name{font-size:15px;}
  .rkr-resc{display:none;}
  .rkr-hint{display:none;}
  .rkr-items{grid-template-columns:1fr;}
}
@media (max-height:640px){ .rkr-tcol{gap:10px;} .rkr-how,.rkr-ctl{padding:10px 14px;} }
@media (prefers-reduced-motion:reduce){ .rkr-l,.rkr-logocat,.rkr-paws span{animation:none !important;} }
/* phones in landscape: compact everything */
@media (max-height:500px){
  .rkr-map{width:110px;height:110px;}
  .rkr-tl{top:8px;gap:6px;}
  .rkr-tr{top:8px;}
  .rkr-scores{top:52px;}
  .rkr-cards .rkr-card{zoom:.75;}
  .rkr-tcol{gap:8px;}
  .rkr-logo{zoom:.6;}
  .rkr-sub{font-size:13px !important;}
  .rkr-info{display:none !important;}
  .rkr-btn{font-size:17px;}
  .rkr-glass{padding:14px 18px 14px;}
  .rkr-glass h2{font-size:34px !important;}
  .rkr-glass .rkr-gcat{width:44px;height:44px;}
  .rkr-stats{gap:2px;}
  .rkr-prog{top:6px;height:44px;}
  .rkr-pico{width:22px;height:22px;}
  .rkr-pdist{top:29px;font-size:12px;}
  .rkr-victory .rkr-vcrown{width:44px;height:44px;}
  .rkr-victory .rkr-glass{gap:7px;}
  .rkr-victory .rkr-stat{padding:3px 10px;font-size:14px;}
  .rkr-victory .rkr-stat .rkr-sv{font-size:17px;}
  .rkr-victory .rkr-stats{display:grid;grid-template-columns:1fr 1fr;gap:4px;}
  .rkr-victory .rkr-gsub{display:none;}
  .rkr-victory h2{font-size:28px !important;}
  .rkr-vfirst{font-size:14px;padding:3px 12px;}
  .rkr-party{display:none;}
}
/* notches / rounded corners (after the base rules so these win) */
.rkr-tl{left:max(16px,env(safe-area-inset-left));}
.rkr-tr{right:max(16px,env(safe-area-inset-right));}
.rkr-scores{right:max(16px,env(safe-area-inset-right));}
.rkr-map{right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));}
@media (max-width:760px){ .rkr-map{right:max(10px,env(safe-area-inset-right));bottom:max(10px,env(safe-area-inset-bottom));} }
.rkr-overlay{padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));}
.rkr-toasts{bottom:max(26px,env(safe-area-inset-bottom));max-width:calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 24px);}
.rkr-toast{max-width:100%;overflow:hidden;text-overflow:ellipsis;}
/* app-only footer on the title screen */
.rkr-legal{display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;font-size:12px;font-weight:800;color:rgba(255,255,255,.55);}
.rkr-legal a{color:rgba(255,255,255,.75);text-decoration:none;padding:4px 6px;cursor:pointer;pointer-events:auto;}
.rkr-legal a:active{color:#ffcf5a;}
`;

function injectStyle() {
  if (document.getElementById('rkr-ui-style')) return;
  const st = document.createElement('style');
  st.id = 'rkr-ui-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function restartAnim(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth; // reflow so the animation restarts (only on value changes)
  node.classList.add(cls);
}

// ---------------------------------------------------------------------------

function createUI(root) {
  let accountHandler = null, acctBtn = null, acctState = null;   // title screen button 4 (account.js)
  injectStyle();
  root.classList.add('rkr-root');

  const state = { title: false, pause: false, gameOver: false, victory: false };
  let onStartCb = null, onResumeCb = null, onRestartCb = null;
  // Title menu order (data-p = mode: 3 online, 1 solo, 2 local co-op); keys 1/2/3 follow this order.
  const titleOrder = () => (acctState ? [3, 1, 4] : [3, 1]);   // 3 = online, 1 = local (solo / co-op), 4 = the account button while accounts are on
  let titleSel = 3;
  let gameOverArmedAt = 0;

  // ================= HUD =================
  const hud = el('div', 'rkr-hud rkr-off');
  const tl = el('div', 'rkr-tl');
  const lvlRow = el('div', 'rkr-lvlrow');
  const levelEl = el('div', 'rkr-level', '<small>LEVEL</small><span>1</span>');
  const levelNum = levelEl.querySelector('span'), levelTag = levelEl.querySelector('small');
  const timerEl = el('div', 'rkr-timer', ICONS.clock + '<span>0:00</span>');
  const timerTxt = timerEl.querySelector('span');
  lvlRow.append(levelEl, timerEl);
  const cardsEl = el('div', 'rkr-cards');
  tl.append(lvlRow, cardsEl);

  const tc = el('div', 'rkr-tc');
  const rescEl = el('div', 'rkr-resc', ICONS.revive + '<span>0</span>');
  const rescTxt = rescEl.querySelector('span');
  rescEl.title = 'Rescues';
  const votesEl = el('div', 'rkr-votes');
  votesEl.addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b && !b.disabled && voteKillCb) voteKillCb(+b.dataset.id); });
  tc.append(rescEl, votesEl);

  const tr = el('div', 'rkr-tr');
  const hintEl = el('div', 'rkr-hint', '<span class="rkr-k" data-act="pause"></span>pause <span class="rkr-k" data-act="hud"></span>hud <span class="rkr-k rkr-fullkey" data-act="full"></span><span class="rkr-fullkey">full</span> <span class="rkr-k" data-act="sound"></span><span class="rkr-snd">mute</span>');
  paintKeys(hintEl);   // (the keys picked in the settings)
  const muteEl = el('button', 'rkr-mute', ICONS.speaker);
  const hudBtn = el('button', 'rkr-hudbtn', ICONS.eye);
  hudBtn.title = 'Show / hide the HUD (H)';
  hudBtn.setAttribute('aria-label', 'Hide HUD');
  const menuBtn = el('button', 'rkr-menubtn', ICONS.menu);
  menuBtn.title = 'Menu';
  menuBtn.setAttribute('aria-label', 'Menu');
  muteEl.setAttribute('aria-label', 'Mute sound');
  // full screen (computers): more of the level above and below your kitty (main.js tallView)
  const fullBtn = el('button', 'rkr-hudbtn rkr-fullbtn', ICONS.full);
  fullBtn.title = 'Full screen';
  fullBtn.setAttribute('aria-label', 'Full screen');
  const canFull = !TOUCH && !!document.documentElement.requestFullscreen;
  function toggleFull() {
    if (!canFull) return;
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
  // Esc pauses the game: keep it from also leaving full screen, where the browser can (Chrome, Edge: hold Esc to leave)
  const kb = navigator.keyboard;
  const paintFull = () => {
    const on = !!document.fullscreenElement;
    fullBtn.classList.toggle('rkr-on', on); fullBtn.setAttribute('aria-pressed', String(on));
    try { if (kb && kb.lock) { if (on) kb.lock(['Escape']).catch(() => {}); else kb.unlock(); } } catch { /* not here */ }
  };
  document.addEventListener('fullscreenchange', paintFull);
  paintFull();
  fullBtn.addEventListener('click', toggleFull);
  if (!canFull) { fullBtn.style.display = 'none'; for (const n of hintEl.querySelectorAll('.rkr-fullkey')) n.style.display = 'none'; }
  for (const b of [muteEl, hudBtn, fullBtn, menuBtn]) {
    b.type = 'button';
    // mouse/touch clicks must not leave focus here, or the next Enter/Space would press it again
    b.addEventListener('mousedown', (e) => e.preventDefault());
    // keyboard-focused: Enter/Space press the button, not the game/overlay key handlers on window
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
  }
  tr.append(hintEl, hudBtn, fullBtn, muteEl, menuBtn);

  const mapEl = el('div', 'rkr-map');
  const mapCanvas = document.createElement('canvas');
  mapEl.appendChild(mapCanvas);

  const scoresEl = el('div', 'rkr-scores');
  hud.append(tl, tc, tr, mapEl, scoresEl);
  // HUD on/off (remembered); phones start with it off
  let hudMin = TOUCH;
  try { const v = localStorage.getItem('rkr-hud'); if (v) hudMin = v === 'min'; } catch { /* ignore */ }
  function setHudMin(v) {
    hudMin = v;
    hud.classList.toggle('rkr-min', v);
    hudBtn.setAttribute('aria-pressed', String(!!v));
    try { localStorage.setItem('rkr-hud', v ? 'min' : 'full'); } catch { /* ignore */ }
  }
  hud.classList.toggle('rkr-min', hudMin);
  hudBtn.setAttribute('aria-pressed', String(!!hudMin));
  hudBtn.addEventListener('click', () => setHudMin(!hudMin));
  let menuHandler = null;
  menuBtn.addEventListener('click', () => { if (menuHandler) menuHandler(); });

  const bannerEl = el('div', 'rkr-banner', '<div class="rkr-bt"></div><div class="rkr-bs"></div>');
  const bannerT = bannerEl.querySelector('.rkr-bt');
  const bannerS = bannerEl.querySelector('.rkr-bs');
  const toastsEl = el('div', 'rkr-toasts');

  // the rainbow the cat icon wears with every reward (8+ wins and 60+ revives): one shared gradient, sliding across
  // the face like the rainbow fur in the game (one loop slides it exactly one repeat along its own direction: seamless)
  const rainbowDefs = el('div', 'rkr-defs', `<svg width="0" height="0" aria-hidden="true"><defs>
    <linearGradient id="rkr-rainbow-fur" x1="0" y1="0" x2="1" y2="0.6" spreadMethod="repeat">
      <stop offset="0" stop-color="#ff5a5a"/><stop offset=".17" stop-color="#ffb84a"/><stop offset=".33" stop-color="#f4f05a"/>
      <stop offset=".5" stop-color="#6ef08a"/><stop offset=".67" stop-color="#5ac8ff"/><stop offset=".83" stop-color="#b47cff"/>
      <stop offset="1" stop-color="#ff5a5a"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-1 -0.6" dur="2.2s" repeatCount="indefinite"/>
    </linearGradient>
    <!-- an easy game's bronze / golden kitty: the same sliding band of light as the chrome lion's (below), in its metal -->
    <linearGradient id="rkr-bronze-fur" x1="0" y1="0" x2="1" y2=".12" spreadMethod="repeat">
      <stop offset="0" stop-color="#b0662a"/><stop offset=".2" stop-color="#e3a068"/><stop offset=".4" stop-color="#7d4416"/>
      <stop offset=".56" stop-color="#cd7f32"/><stop offset=".66" stop-color="#ffe2c2"/><stop offset=".76" stop-color="#cd7f32"/>
      <stop offset="1" stop-color="#b0662a"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-1 0" dur="3.4s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="rkr-bronze-lens-rl" x1="0" y1="0" x2=".8" y2="0" spreadMethod="repeat"><stop offset="0" stop-color="#b0662a"/><stop offset=".2" stop-color="#e3a068"/><stop offset=".4" stop-color="#7d4416"/> <stop offset=".56" stop-color="#cd7f32"/><stop offset=".66" stop-color="#ffe2c2"/><stop offset=".76" stop-color="#cd7f32"/> <stop offset="1" stop-color="#b0662a"/><animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-.8 0" dur="3.2s" repeatCount="indefinite"/></linearGradient>
    <!-- the koi's fins on a face with an account total: orange fading to white, like the fish's (fishHTML) -->
    <linearGradient id="rkr-koi-fin" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#ff7a2e"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
    <!-- a little koi swimming round a face's rim, back out (facing right, centred on its body; the face's box is x 8..30,
         y 8..30 there), and the mask hiding it where it would cover the face itself: it swims over the rim, its belly cut off at the face -->
    <mask id="rkr-koi-behind" maskUnits="userSpaceOnUse" x="0" y="0" width="38" height="38"><rect width="38" height="38" fill="#fff"/><rect x="10" y="10" width="18" height="18" rx="3" fill="#000"/></mask>
    <g id="rkr-koi" stroke="#2b1840" stroke-linejoin="round">
      <path d="M-6.4 0L-10.6 -3.4Q-9.2 0 -10.6 3.4Z" fill="url(#rkr-koi-fin)" stroke-width=".9"/>
      <path d="M-2.5 -3Q0 -5.6 3 -3.1Z" fill="#ff7a2e" stroke-width=".8"/>
      <path d="M7 0C7 -2.6 3 -3.4 -1 -3.2C-4 -3 -6 -1.6 -7 0C-6 1.6 -4 3 -1 3.2C3 3.4 7 2.6 7 0Z" fill="#fff4e0" stroke-width="1"/>
      <path d="M-4.6 -1.6Q-2 -3.4 .6 -2.7Q-.4 -.4 -3.4 .2Z" fill="#ff7a2e" stroke="none"/><path d="M1.6 1.2Q3.2 .4 4.6 1.6Q3 2.8 1.4 2.3Z" fill="#ff7a2e" stroke="none"/>
      <path d="M7 0C7 -2.6 3 -3.4 -1 -3.2C-4 -3 -6 -1.6 -7 0C-6 1.6 -4 3 -1 3.2C3 3.4 7 2.6 7 0Z" fill="url(#rkr-koi-shine)" stroke="none"/>
      <path d="M-6.4 0L-10.6 -3.4Q-9.2 0 -10.6 3.4Z" fill="url(#rkr-koi-shine)" stroke="none"/>
      <circle cx="4.4" cy="-.7" r="1.15" fill="#fff" stroke-width=".5"/><circle cx="4.6" cy="-.6" r=".6" fill="#2b1840" stroke="none"/>
    </g>
    <!-- the big koi's band of light on the little ones too, sliding head to tail (each part's own box) -->
    <linearGradient id="rkr-koi-shine" x1="1" y1="0" x2="0" y2="-.12" spreadMethod="repeat">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".2" stop-color="#fff" stop-opacity=".55"/><stop offset=".4" stop-color="#3a2a40" stop-opacity=".2"/>
      <stop offset=".56" stop-color="#fff" stop-opacity="0"/><stop offset=".66" stop-color="#fff" stop-opacity=".85"/><stop offset=".76" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="1 0" to="0 0" dur="3.4s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="rkr-gold-fur" x1="0" y1="0" x2="1" y2=".12" spreadMethod="repeat">
      <stop offset="0" stop-color="#e0a020"/><stop offset=".2" stop-color="#ffe07a"/><stop offset=".4" stop-color="#b8791f"/>
      <stop offset=".56" stop-color="#ffd34a"/><stop offset=".66" stop-color="#fffbe6"/><stop offset=".76" stop-color="#ffd34a"/>
      <stop offset="1" stop-color="#e0a020"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-1 0" dur="3.4s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="rkr-gold-lens-rl" x1="0" y1="0" x2=".8" y2="0" spreadMethod="repeat"><stop offset="0" stop-color="#e0a020"/><stop offset=".2" stop-color="#ffe07a"/><stop offset=".4" stop-color="#b8791f"/> <stop offset=".56" stop-color="#ffd34a"/><stop offset=".66" stop-color="#fffbe6"/><stop offset=".76" stop-color="#ffd34a"/> <stop offset="1" stop-color="#e0a020"/><animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-.8 0" dur="3.2s" repeatCount="indefinite"/></linearGradient>
    <!-- the chrome lion: a band of light slides across the mirror fur from right to left (like the koi's). The gradient repeats and
         moves by exactly its own length, so the loop has no seam -->
    <linearGradient id="rkr-chrome-fur" x1="0" y1="0" x2="1" y2=".12" spreadMethod="repeat">
      <stop offset="0" stop-color="#b9c2d0"/><stop offset=".2" stop-color="#eef2f7"/><stop offset=".4" stop-color="#8c96a8"/>
      <stop offset=".56" stop-color="#cfd6e0"/><stop offset=".66" stop-color="#ffffff"/><stop offset=".76" stop-color="#cfd6e0"/>
      <stop offset="1" stop-color="#b9c2d0"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-1 0" dur="3.4s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="rkr-chrome-lens-rl" x1="0" y1="0" x2=".8" y2="0" spreadMethod="repeat"><stop offset="0" stop-color="#b9c2d0"/><stop offset=".2" stop-color="#eef2f7"/><stop offset=".4" stop-color="#8c96a8"/> <stop offset=".56" stop-color="#cfd6e0"/><stop offset=".66" stop-color="#ffffff"/><stop offset=".76" stop-color="#cfd6e0"/> <stop offset="1" stop-color="#b9c2d0"/><animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="-.8 0" dur="3.2s" repeatCount="indefinite"/></linearGradient>
    <radialGradient id="rkr-cosmic-sky" gradientUnits="userSpaceOnUse" cx="20" cy="21" r="21" fx="20" fy="19">
      <stop offset="0" stop-color="#a99bff"/><stop offset=".35" stop-color="#6a54e0"/><stop offset=".7" stop-color="#33208f"/><stop offset="1" stop-color="#141045"/>
    </radialGradient>
    <pattern id="rkr-cosmic-fur" patternUnits="userSpaceOnUse" width="40" height="40">
      <rect width="40" height="40" fill="url(#rkr-cosmic-sky)"/>
      <g fill="#fff"><circle cx="30" cy="8" r=".7"/><circle cx="12" cy="31" r=".7"/><circle cx="33" cy="23" r=".6"/><circle cx="7" cy="23" r=".6"/>
      <circle cx="17" cy="34" r=".5"/><circle cx="24" cy="10" r=".5"/><circle cx="35" cy="30" r=".6"/><circle cx="4" cy="29" r=".6"/>
      <path d="M9 6.8Q9 9 11.2 9Q9 9 9 11.2Q9 9 6.8 9Q9 9 9 6.8Z M28 28.6Q28 31 30.4 31Q28 31 28 33.4Q28 31 25.6 31Q28 31 28 28.6Z M36 12.2Q36 14 37.8 14Q36 14 36 15.8Q36 14 34.2 14Q36 14 36 12.2Z"/></g>
    </pattern></defs></svg>`);
  root.append(hud, bannerEl, toastsEl, rainbowDefs);

  let voteKillCb = null;   // (main.js: sends the vote)
  // ---- HUD state cache ----
  const H = {
    level: null, timeSec: null, rescues: null,
    cards: [], lastNow: 0, visible: false,
  };

  function makeCard() {
    const c = el('div', 'rkr-card',
      `<div class="rkr-head">${MANE_SVG}${ICONS.cat}${SHADES_SVG}${SPECS_SVG}${SHADES_BROKEN_SVG}</div>
       <div class="rkr-cbody">
         <div class="rkr-crow"><span class="rkr-name"></span><span class="rkr-status">ALIVE</span><span class="rkr-medic rkr-hidden" title="Medic: 3000 revives">${MEDIC_SVG}</span><span class="rkr-hearts"></span></div>
         <div class="rkr-crow"><span class="rkr-paid rkr-fish rkr-hidden"></span><span class="rkr-boots">${ICONS.boots}<span>+0%</span></span></div>
         <div class="rkr-shield rkr-hidden">${ICONS.shield}<div class="rkr-sbar"><div class="rkr-sfill"></div></div></div>
       </div>
       <div class="rkr-tip"><span></span><span class="rkr-fish rkr-hidden"></span></div>
       <svg class="rkr-koibits" viewBox="0 0 38 38" aria-hidden="true"><g mask="url(#rkr-koi-behind)"><use href="#rkr-koi" transform="translate(20 9) scale(.75)"/><use href="#rkr-koi" transform="translate(29 20) rotate(90) scale(.75)"/><use href="#rkr-koi" transform="translate(18 29) rotate(180) scale(.75)"/><use href="#rkr-koi" transform="translate(9 18) rotate(-90) scale(.75)"/></g><rect x="10" y="10" width="18" height="18" rx="3.5" fill="none" stroke="#2b1840" stroke-width=".6"/></svg>`);
    const refs = {
      root: c,
      name: c.querySelector('.rkr-name'),
      status: c.querySelector('.rkr-status'),
      hearts: c.querySelector('.rkr-hearts'),
      boots: c.querySelector('.rkr-boots'),
      bootsTxt: c.querySelector('.rkr-boots > span'),
      shieldRow: c.querySelector('.rkr-shield'),
      shieldFill: c.querySelector('.rkr-sfill'),
      paid: c.querySelector('.rkr-paid'),
      tipName: c.querySelector('.rkr-tip > span'),
      tipFish: c.querySelector('.rkr-tip > .rkr-fish'),
      medic: c.querySelector('.rkr-medic'),
      v: { paid: 0, name: null, color: null, alive: null, lives: null, speed: null, shield: null },
    };
    cardsEl.appendChild(c);
    return refs;
  }

  function updateCard(card, p) {
    const v = card.v;
    if (p.name !== v.name) { v.name = p.name; card.name.textContent = p.name; card.tipName.textContent = p.name; }   // (and a face's hover label)
    if (p.color !== v.color) {
      v.color = p.color; card.root.style.setProperty('--pc', hexColor(p.color));
      card.root.classList.toggle('rkr-pale', isPale(p.color));   // (the medic badge's staff and snake go dark)
    }
    if (!!p.cool !== v.cool) { v.cool = !!p.cool; card.root.classList.toggle('rkr-cool', v.cool); }   // 5+ wins: sunglasses
    if (!!p.specs !== v.specs) { v.specs = !!p.specs; card.root.classList.toggle('rkr-specson', v.specs); }   // (an easy game: reading glasses)
    if (!!p.shimmer !== v.shimmer) { v.shimmer = !!p.shimmer; card.root.classList.toggle('rkr-shimmer', v.shimmer); }   // 12+ wins: rainbow name
    if (!!p.gold !== v.gold) { v.gold = !!p.gold; card.root.classList.toggle('rkr-goldname', v.gold); }   // (an easy game: a golden name)
    if ((p.paid || 0) !== v.paid || (p.ps || '') !== v.ps) {
      v.paid = p.paid || 0; v.ps = p.ps || '';
      const koi = v.ps === 'koi';   // (the koi fish, or the classic tag)
      card.paid.classList.toggle('rkr-hidden', !v.paid);
      card.paid.classList.toggle('rkr-fish', koi);
      if (koi) card.paid.innerHTML = swagHTML(fmtNum(v.paid), 'koi'); else card.paid.textContent = fmtNum(v.paid);
      card.tipFish.innerHTML = swagHTML(fmtNum(v.paid), v.ps);   // (its own drawing: the gradients have their own ids)
      card.root.classList.toggle('rkr-koi', koi);
      card.tipFish.classList.toggle('rkr-hidden', !v.paid);
      card.root.classList.toggle('rkr-haspaid', !!v.paid);
    }
    if (!!p.you !== v.you) { v.you = !!p.you; card.root.classList.toggle('rkr-you', v.you); }
    if (!!p.full !== v.full) { v.full = !!p.full; card.root.classList.toggle('rkr-full', v.full); }   // (versus: a teammate's card, full)
    if ((p.medic || '') !== v.medic) {   // the medic badge (revive unlocks): its look, or none
      v.medic = p.medic || '';
      card.medic.className = 'rkr-medic' + (v.medic ? ' t-' + v.medic : ' rkr-hidden');
    }
    if (!!p.rainbow !== v.rainbow) { v.rainbow = !!p.rainbow; card.root.classList.toggle('rkr-rainbow', v.rainbow); }   // every reward
    // 14+ wins: the lion's mane; 16: the chrome, rainbow or celestial lion (main.js iconLook)
    if (!!p.lion !== v.lion) { v.lion = !!p.lion; card.root.classList.toggle('rkr-lion', v.lion); }
    if ((p.lionLook || '') !== v.lionLook) {
      v.lionLook = p.lionLook || '';
      card.root.classList.toggle('rkr-chrome', v.lionLook === 'chrome');
      card.root.classList.toggle('rkr-rlion', v.lionLook === 'rainbow');
      card.root.classList.toggle('rkr-celestial', v.lionLook === 'celestial');
    }
    if (!!p.lensStill !== !!v.lensStill) { v.lensStill = !!p.lensStill; card.root.classList.toggle('rkr-lensstill', v.lensStill); }   // (the glasses' shine off)
    if ((p.lensMetal || '') !== v.lensMetal) {   // (a draft: another metal's sunglass lenses)
      v.lensMetal = p.lensMetal || '';
      for (const m of ['chrome', 'gold', 'bronze']) card.root.classList.toggle('rkr-lm-' + m, v.lensMetal === m);
    }
    if ((p.maneMetal || '') !== v.maneMetal) {   // the mane's own metal
      v.maneMetal = p.maneMetal || '';
      for (const m of ['chrome', 'gold', 'bronze']) card.root.classList.toggle('rkr-mm-' + m, v.maneMetal === m);
    }
    if ((p.metal || '') !== v.metal) {   // an easy game's bronze / golden kitty
      v.metal = p.metal || '';
      card.root.classList.toggle('rkr-mbronze', v.metal === 'bronze');
      card.root.classList.toggle('rkr-mgold', v.metal === 'gold');
    }
    const alive = !!p.alive;
    if (alive !== v.alive) {
      v.alive = alive;
      card.root.classList.toggle('rkr-down', !alive);
      card.status.textContent = alive ? 'ALIVE' : 'DOWN';
    }
    const lives = p.lives | 0;
    if (lives !== v.lives) {
      const gained = v.lives != null && lives > v.lives;
      v.lives = lives;
      const slots = Math.max(CFG.MAX_EXTRA_LIVES, lives);
      let h = '';
      for (let i = 0; i < slots; i++) {
        const filled = i < lives;
        h += `<span class="${filled && gained && i === lives - 1 ? 'rkr-new' : ''}">${filled ? ICONS.heart : ICONS.heartEmpty}</span>`;
      }
      card.hearts.innerHTML = h;
      card.hearts.title = lives + ' extra ' + (lives === 1 ? 'life' : 'lives');
    }
    const speed = Math.round(((p.speedMult || 1) - 1) * 100);
    if (speed !== v.speed) {
      const up = v.speed != null && speed > v.speed;
      v.speed = speed;
      card.bootsTxt.textContent = (speed >= 0 ? '+' : '') + speed + '% speed';
      if (up) restartAnim(card.boots, 'rkr-pop');
    }
    const sh = Math.max(0, p.shield || 0);
    const shq = sh > 0 ? Math.max(1, Math.round(sh / CFG.SHIELD_TIME * 100)) : 0;
    if (shq !== v.shield) {
      if ((shq > 0) !== (v.shield > 0)) card.shieldRow.classList.toggle('rkr-hidden', shq === 0);
      v.shield = shq;
      card.shieldFill.style.transform = `scaleX(${Math.min(1, shq / 100)})`;
    }
  }

  // votes going on (a kitty standing still with a vote or more against it; started from the spectate bar): a line each
  let votesKey = '';
  function paintVotes(ps) {
    const on = ps.filter((p) => p.afk && p.afkVotes > 0);
    const key = on.map((p) => [p.id, p.name, p.afkVotes, p.afkNeed, !!p.you, !!p.canVote, !!p.voted].join(',')).join('|');
    if (key === votesKey) return;
    votesKey = key;
    votesEl.textContent = '';
    for (const p of on) {
      const row = el('div', 'rkr-vote' + (p.you ? ' rkr-self' : ''));
      const t = el('span');
      t.textContent = p.you ? `⚠ The others are voting to knock you down for standing still: move! ${p.afkVotes}/${p.afkNeed}` : `💀 Knock down ${p.name} for standing still? ${p.afkVotes}/${p.afkNeed}`;
      row.appendChild(t);
      if (!p.you) {
        const b = el('button', null, p.voted ? '✓ VOTED' : 'VOTE');
        b.dataset.id = p.id;
        b.disabled = !!p.voted || !p.canVote;
        row.appendChild(b);
      }
      votesEl.appendChild(row);
    }
  }

  function setHUD(d) {
    if (!d) return;
    paintVotes(d.players || []);
    // (versus: your team's cards full, the other teams' faces)
    const ps0 = d.players || [], full = d.versus ? ps0.filter((p) => p.you || p.full).length : ps0.length;
    cardsEl.classList.toggle('rkr-many', full > 4);
    cardsEl.classList.toggle('rkr-tiny', d.versus ? full < ps0.length : ps0.length > 5);   // faces only (your own card stays full)
    if (!H.visible) { H.visible = true; hud.classList.remove('rkr-off'); }
    const now = performance.now();
    const dt = H.lastNow ? Math.min(0.1, (now - H.lastNow) / 1000) : 0;
    H.lastNow = now;

    if (d.level !== H.level) {
      const changed = H.level != null;
      H.level = d.level;
      levelNum.textContent = d.level;
      if (changed) restartAnim(levelEl, 'rkr-pop');
    }
    // hell: HELL n
    const tag = d.tag || 'LEVEL';
    if (tag !== H.tag) { H.tag = tag; levelTag.textContent = tag; }
    const ts = Math.floor(d.time || 0);
    if (ts !== H.timeSec) { H.timeSec = ts; timerTxt.textContent = fmtTime(ts); }

    const rs = d.rescues | 0;
    if (rs !== H.rescues) {
      const up = H.rescues != null && rs > H.rescues;
      H.rescues = rs;
      rescTxt.textContent = rs;
      if (up) restartAnim(rescEl, 'rkr-pop');
    }

    const ps = d.players || [];
    while (H.cards.length < ps.length) H.cards.push(makeCard());
    while (H.cards.length > ps.length) { const c = H.cards.pop(); c.root.remove(); }
    for (let i = 0; i < ps.length; i++) updateCard(H.cards[i], ps[i]);
  }
  function diffRound(shown, target) {
    // count toward target: floor when rising, ceil when falling, so the final value is exact.
    return shown <= target ? Math.floor(shown + 1e-6) : Math.ceil(shown - 1e-6);
  }

  // ================= minimap =================
  const M = {
    cssSize: 0, dpr: 0, ctx: mapCanvas.getContext('2d'),
    staticCanvas: document.createElement('canvas'), staticFor: null, sizeDirty: true,
    colorById: new Map(),
  };
  function measureMap() { M.sizeDirty = true; }
  window.addEventListener('resize', measureMap);

  function ensureMapSize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (!M.sizeDirty && dpr === M.dpr) return false;
    M.sizeDirty = false;
    const size = mapEl.clientWidth || 190;
    M.cssSize = size; M.dpr = dpr;
    const px = Math.round(size * dpr);
    mapCanvas.width = px; mapCanvas.height = px;
    M.staticCanvas.width = px; M.staticCanvas.height = px;
    M.staticFor = null;
    return true;
  }

  function buildStatic(ld) {
    const S = M.cssSize, dpr = M.dpr;
    const g = M.staticCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, M.staticCanvas.width, M.staticCanvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fit the whole level (walls + corridor bands) into the square with a small margin
    const W = ld.corridorWidth || 6, h = W / 2;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const grow = (x, z) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; };
    for (const w of ld.walls || []) { grow(w.ax, w.az); grow(w.bx, w.bz); }
    for (const l of ld.legs || []) {
      for (const sv of [-h, l.len + h]) for (const v of [-h, h]) grow(l.ox + l.ux * sv + l.nx * v, l.oz + l.uz * sv + l.nz * v);
    }
    if (!isFinite(x0)) { const o = ld.outerRadius || 20; x0 = z0 = -o; x1 = z1 = o; }
    const pad = 8; // css px margin inside the frame
    const sc = (S - pad * 2) / Math.max(x1 - x0, z1 - z0, 1);
    // canvas coords of world origin (maze centre), with the level bbox centred in the square
    const cx = S / 2 - ((x0 + x1) / 2) * sc, cy = S / 2 - ((z0 + z1) / 2) * sc;
    M.scale = sc; M.cx = cx; M.cy = cy;

    // corridor bands (one rectangle per leg, alternating per loop)
    for (const l of ld.legs || []) {
      const s0 = -h, s1 = l.len + h;
      const pt = (sv, v) => [cx + (l.ox + l.ux * sv + l.nx * v) * sc, cy + (l.oz + l.uz * sv + l.nz * v) * sc];
      g.beginPath();
      g.moveTo(...pt(s0, -h)); g.lineTo(...pt(s1, -h)); g.lineTo(...pt(s1, h)); g.lineTo(...pt(s0, h)); g.closePath();
      g.fillStyle = l.loop % 2 ? 'rgba(140,110,220,.16)' : 'rgba(110,200,170,.13)';
      g.fill();
    }
    // safe corners
    g.fillStyle = 'rgba(255,240,200,.38)';
    for (const c of ld.safeCorners || []) g.fillRect(cx + (c.x - h) * sc, cy + (c.z - h) * sc, W * sc, W * sc);
    // center goal glow
    const r0 = (ld.centerRadius || CFG.CENTER_RADIUS) * sc;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r0 * 1.1);
    grd.addColorStop(0, 'rgba(255,250,210,.95)');
    grd.addColorStop(0.45, 'rgba(255,200,90,.6)');
    grd.addColorStop(1, 'rgba(255,120,200,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, r0 * 1.1, 0, Math.PI * 2); g.fill();

    // walls
    const lw = Math.max(1.6, CFG.WALL_THICKNESS * sc * 1.2);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.45)';
    g.lineWidth = lw + 2;
    strokeWalls(g, ld, cx, cy, sc);
    g.strokeStyle = '#efe6ff';
    g.lineWidth = lw;
    strokeWalls(g, ld, cx, cy, sc);
  }
  function strokeWalls(g, ld, cx, cy, sc) {
    g.beginPath();
    for (const w of ld.walls || []) {
      g.moveTo(cx + w.ax * sc, cy + w.az * sc);
      g.lineTo(cx + w.bx * sc, cy + w.bz * sc);
    }
    g.stroke();
  }

  const ENEMY_COL = { wanderer: '#ff7a33' };   // pattern wolves: the default red
  const MAP_KIND_COLS = [...new Set([...Object.values(ENEMY_COL), '#ff4b4b'])], mapKinds = () => MAP_KIND_COLS;   // one path per colour
  const ITEM_COL = { boots: '#33e0ff', life: '#ff6fa8', shield: '#ffd83a' };   // boots: little cyan boots, lives: pink hearts, shields: yellow stars

  // the final run hides the minimap (and timer / hint): no telling how far is left
  let finaleOn = false;
  function setFinaleMode(on) {
    if (on === finaleOn) return;
    finaleOn = on;
    hud.classList.toggle('rkr-finale', on);
  }

  function updateMinimap(ld, sim, me) {
    if (!ld) return;
    setFinaleMode(!!ld.finale);
    if (ld.finale) return;
    const resized = ensureMapSize();
    if (resized || M.staticFor !== ld) { buildStatic(ld); M.staticFor = ld; }
    const g = M.ctx, dpr = M.dpr, sc = M.scale, cx = M.cx, cy = M.cy;
    const t = performance.now() / 1000;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    g.drawImage(M.staticCanvas, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // pulsing center
    const R0 = (ld.centerRadius || CFG.CENTER_RADIUS) * sc;
    g.beginPath();
    g.arc(cx, cy, R0 * (0.35 + 0.15 * Math.sin(t * 3)), 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,230,.55)';
    g.fill();
    if (!sim) return;

    // enemies
    const en = sim.enemies || [];
    g.lineWidth = 0.8; g.strokeStyle = 'rgba(40,0,0,.8)';
    for (const col of mapKinds(en)) {
      g.beginPath();
      for (let i = 0; i < en.length; i++) {
        const e = en[i];
        if ((ENEMY_COL[e.type] || '#ff4b4b') !== col) continue;
        const x = cx + e.x * sc, y = cy + e.z * sc;
        g.moveTo(x + 2.6, y); g.arc(x, y, 2.6, 0, Math.PI * 2);
      }
      g.fillStyle = col; g.fill(); g.stroke();
    }

    // checkpoints: a little flag on each (above the wolves, so you can find them; a reached one fades)
    const cps = ld.checkpoints || [], hit = sim.checkpointsHit || [];
    for (let i = 0; i < cps.length; i++) {
      const x = cx + cps[i].x * sc, y = cy + cps[i].z * sc, done = hit.indexOf(i) >= 0;
      g.globalAlpha = done ? 0.45 : 1;
      g.lineWidth = 2.6; g.strokeStyle = 'rgba(20,8,48,.9)';
      g.beginPath(); g.moveTo(x - 2.5, y + 5); g.lineTo(x - 2.5, y - 6); g.stroke();
      g.beginPath(); g.moveTo(x - 2.5, y - 6); g.lineTo(x + 5.5, y - 3.2); g.lineTo(x - 2.5, y - 0.4); g.closePath();
      g.fillStyle = done ? '#b9c2d0' : '#3ee08f'; g.fill();
      g.lineWidth = 1; g.strokeStyle = '#fff'; g.stroke();
      g.lineWidth = 1.2; g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(x - 2.5, y + 5); g.lineTo(x - 2.5, y - 6); g.stroke();
      g.globalAlpha = 1;
    }

    // items
    const items = sim.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.taken) continue;
      const x = cx + it.x * sc, y = cy + it.z * sc;
      g.fillStyle = ITEM_COL[it.type] || '#fff';
      {
        const r = 3 + 0.6 * Math.sin(t * 5 + i);
        g.beginPath();
        if (it.type === 'boots') {   // a little boot: shaft, then the foot out to the right
          const u = r * 0.8;
          g.moveTo(x - 0.75 * u, y - 1.25 * u); g.lineTo(x + 0.15 * u, y - 1.25 * u); g.lineTo(x + 0.15 * u, y + 0.05 * u);
          g.lineTo(x + 1.25 * u, y + 0.4 * u); g.lineTo(x + 1.25 * u, y + 1.1 * u); g.lineTo(x - 0.75 * u, y + 1.1 * u); g.closePath();
        }
        else if (it.type === 'shield') {   // a five-pointed star
          for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, q = (k % 2 ? 0.62 : 1.45) * r; if (k) g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); else g.moveTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
          g.closePath();
        }
        else if (it.type === 'life') { g.moveTo(x, y + r); g.lineTo(x - r, y - r * .2); g.arc(x - r / 2, y - r * .3, r / 2, Math.PI, 0); g.arc(x + r / 2, y - r * .3, r / 2, Math.PI, 0); g.closePath(); }
        else { g.arc(x, y, r * .85, 0, Math.PI * 2); }
        g.fill();
        g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
      }
    }

    // player colors by id
    const players = sim.players || [];
    M.colorById.clear();
    for (const p of players) M.colorById.set(p.id, p.color);

    // revive circles (versus: also kitties that left, until their team picks them up)
    // (versus: only your own team's: the others' downed kitties are theirs to worry about)
    const myTeam = sim.versus ? (players.find((p) => p.id === me) || {}).team : undefined;
    const left = sim.versus && sim.vsLeft ? Object.entries(sim.vsLeft).filter(([, s]) => !s.by && s.team === myTeam) : [];
    for (const [id, s] of left) M.colorById.set('v' + id, s.color == null ? 0xaaaaaa : s.color);
    const own = sim.versus ? (sim.circles || []).filter((c) => (players.find((p) => p.id === c.playerId) || {}).team === myTeam) : sim.circles || [];
    const circles = left.length ? [...own, ...left.map(([id, s]) => ({ playerId: 'v' + id, x: s.x, z: s.z }))] : own;
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const col = M.colorById.has(c.playerId) ? M.colorById.get(c.playerId) : 0xffffff;
      const x = cx + c.x * sc, y = cy + c.z * sc;
      const ph = (t * 1.4 + i * 0.3) % 1;
      // (the dot is as big as a standing kitty's: a kitty that goes down doesn't shrink on the map)
      g.beginPath(); g.arc(x, y, 4.2 + ph * 8, 0, Math.PI * 2);
      g.strokeStyle = rgba(col, 1 - ph); g.lineWidth = 2; g.stroke();
      g.beginPath(); g.arc(x, y, 4.2, 0, Math.PI * 2);
      g.fillStyle = rgba(col, 0.55 + 0.45 * Math.sin(t * 8)); g.fill();
      g.lineWidth = 1.8; g.strokeStyle = '#fff'; g.stroke();
    }

    // players
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.alive === false) continue;
      const x = cx + p.x * sc, y = cy + p.z * sc;
      const col = hexColor(p.color);
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2);
      g.fillStyle = rgba(p.color, 0.25 + 0.1 * Math.sin(t * 6 + i)); g.fill();
      g.beginPath(); g.arc(x, y, 4.2, 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
      g.lineWidth = 1.8; g.strokeStyle = '#fff'; g.stroke();
    }
  }

  // ================= banner & toast =================
  let bannerTimers = [];
  // style: undefined (default), 'finale' (ember red, the final run) or 'gold' (victory)
  function banner(title, subtitle, ms, style) {
    ms = ms || 1800;
    bannerEl.classList.toggle('rkr-b-finale', style === 'finale');
    bannerEl.classList.toggle('rkr-b-gold', style === 'gold');
    bannerTimers.forEach(clearTimeout); bannerTimers = [];
    bannerT.textContent = title || '';
    bannerS.textContent = subtitle || '';
    bannerS.classList.toggle('rkr-hidden', !subtitle);
    bannerEl.classList.remove('rkr-out');
    restartAnim(bannerEl, 'rkr-in');
    bannerTimers.push(setTimeout(() => {
      bannerEl.classList.remove('rkr-in');
      bannerEl.classList.add('rkr-out');
    }, Math.max(400, ms)));
  }

  // key: a toast with the same key still showing is updated in place (and stays up longer) instead of stacking a new
  // one. Phones show at most 2 at a time (a big game's toasts covered the screen), computers 5.
  const TOAST_MAX = TOUCH ? 2 : 5;
  function toast(text, color, key) {
    const c = color == null ? '#ffffff' : hexColor(color);
    let t = key ? [...toastsEl.children].find((x) => x.dataset.key === key && !x.classList.contains('rkr-bye')) : null;
    if (t) { clearTimeout(t._bye); t.textContent = ''; } else {
      t = el('div', 'rkr-toast');
      if (key) t.dataset.key = key;
      toastsEl.appendChild(t);
    }
    t.style.setProperty('--tc', c);
    t.style.setProperty('--tc-glow', rgba(c, 0.35));
    t.append(el('i'), document.createTextNode(text));
    while (toastsEl.children.length > TOAST_MAX) toastsEl.firstChild.remove();
    t._bye = setTimeout(() => {
      t.classList.add('rkr-bye');
      setTimeout(() => t.remove(), 420);
    }, 2600);
  }

  // ================= title =================
  let titleEl = null, titleBtns = [];
  function notesHtml() {
    return PATCH_NOTES.map((n) => `<div class="rkr-note"><div class="rkr-nh"><span class="rkr-nv">v${esc(n.version)}</span><span>${esc(n.title)}</span><span class="rkr-nd">${esc(n.date)}</span></div><ul>${n.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('');
  }
  function buildTitle() {
    const o = el('div', 'rkr-overlay rkr-title');
    const paws = el('div', 'rkr-paws');
    for (let i = 0; i < 14; i++) {
      const s = el('span', null, ICONS.paw);
      s.style.left = (i * 7.3 + (i % 3) * 2) % 100 + '%';
      s.style.top = 100 + (i * 37) % 60 + '%';
      s.style.setProperty('--r', ((i * 53) % 70 - 35) + 'deg');
      s.style.animationDuration = 18 + (i * 7) % 14 + 's';
      s.style.animationDelay = -((i * 3.1) % 20) + 's';
      const sz = 30 + (i * 13) % 30;
      s.style.width = s.style.height = sz + 'px';
      paws.appendChild(s);
    }
    let li = 0;
    const word = (w, cls) => `<span class="rkr-word ${cls || ''}">${[...w].map((ch) => `<span class="rkr-l" style="--i:${li++}" data-c="${ch}">${ch}</span>`).join('')}</span>`;
    const item = (icon, name, desc) => `<div class="rkr-item"><div class="rkr-ico">${icon}</div><div><b>${name}</b>${desc}</div></div>`;
    o.innerHTML = `
      <div class="rkr-tcol">
        <div class="rkr-project">${[...'Project:'].map((ch) => `<span class="rkr-l" data-c="${ch}">${ch}</span>`).join('')}</div>
        <div class="rkr-logo">${word('RUN')}${word('KITTY', 'rkr-kitty')}<span style="position:relative">${word('RUN')}<span class="rkr-logocat">${ICONS.cat}</span></span></div>
        <div class="rkr-sub">Reach the <b>heart of the labyrinth</b>. Don't touch the wolves. <b>Never leave a kitty behind.</b></div>
        <div class="rkr-btns">
          <button class="rkr-btn" data-p="3"><span><span class="rkr-kk">1</span>MULTIPLAYER</span><small>online, up to 32 kitties</small></button>
          <button class="rkr-btn rkr-alt" data-p="1"><span><span class="rkr-kk">2</span>LOCAL</span><small class="rkr-desk">solo or co-op, one keyboard</small><small class="rkr-touchonly">solo run</small></button>
          <button class="rkr-btn rkr-swag rkr-hidden" data-p="4"><span><span class="rkr-kk">3</span><b class="rkr-swagt"></b></span><small></small></button>
        </div>
        <div class="rkr-touchonly rkr-touchhint">Put your thumb down anywhere and drag: a joystick appears under it and steers your kitty.</div>
        <div class="rkr-info rkr-desk">
          <div class="rkr-panel rkr-how"><h3>How to play</h3>
            <div class="rkr-items">
              ${item(ICONS.wolf, 'Wolves', 'one touch and you\'re down')}
              ${item(ICONS.revive, 'Revive circle', 'run over a friend\'s circle')}
              ${item(ICONS.boots, 'Speed boots', '+5% speed each, 4 pairs max, lost when caught')}
              ${item(ICONS.heart, 'Extra life', 'one automatic revive')}
              ${item(ICONS.shield, 'Shield', '4 seconds of safety')}
            </div>
          </div>
          <div class="rkr-panel rkr-ctl"><h3>Controls</h3>
            <div class="rkr-ctlgrid">
              <div class="rkr-krow"><span class="rkr-k rkr-wide">Mouse</span></div>
              <div class="rkr-lab"><em class="rkr-p1">Player 1</em><br>click to run there · hold to steer</div>
              <div class="rkr-keys"><span class="rkr-k" data-act="up"></span><span class="rkr-k" data-act="left"></span><span class="rkr-k" data-act="down"></span><span class="rkr-k" data-act="right"></span></div>
              <div class="rkr-lab">or move with the keys<br><em class="rkr-p2">Player 2</em> in co-op</div>
              <div class="rkr-krow"><span class="rkr-k" data-act="sound"></span></div><div class="rkr-lab">sound on / off</div>
              <div class="rkr-krow"><span class="rkr-k" data-act="pause"></span><span class="rkr-k rkr-wide">Esc</span></div><div class="rkr-lab">pause</div>
              <div class="rkr-krow"><span class="rkr-k rkr-wide">Enter</span></div><div class="rkr-lab">chat, /dance</div>
              <div class="rkr-krow"><span class="rkr-k" data-act="hud"></span></div><div class="rkr-lab">show / hide the HUD</div>
              <div class="rkr-krow rkr-desk"><span class="rkr-k" data-act="full"></span></div><div class="rkr-lab rkr-desk">full screen</div>
            </div>
          </div>
          <div class="rkr-panel rkr-notes"><h3>What's new</h3>${notesHtml()}</div>
        </div>
        <div class="rkr-foot rkr-desk">Press <span class="rkr-k">1</span> or <span class="rkr-k">2</span> &middot; <span class="rkr-k rkr-wide">Enter</span> to start</div>
        ${NATIVE ? `<div class="rkr-legal"><a data-page="privacy">Privacy</a>&middot;<a data-page="terms">Terms</a>&middot;<a data-page="support">Support</a>&middot;<span>v${esc(APP_VERSION)}</span></div>` : ''}
      </div>`;
    o.prepend(paws);
    paintKeys(o);
    // the controls panel shows players 1 and 2 in their preferred kitty colours (picked on the setup / online screens)
    const s = localSlots(2);
    o.querySelector('.rkr-p1').style.color = hexColor(PLAYER_COLORS[s[0]]);
    o.querySelector('.rkr-p2').style.color = hexColor(PLAYER_COLORS[s[1]]);
    o.querySelectorAll('.rkr-legal a').forEach((a) => a.addEventListener('click', () => openExternal(`${SERVER_ORIGIN}/${a.dataset.page}.html`)));
    const credits = el('div', 'rkr-credits', 'made by <a href="https://www.instagram.com/ben.bhc/" target="_blank" rel="noopener">Benjamin</a> and <a href="https://x.com/milimithrandir" target="_blank" rel="noopener">Maximilian</a>');
    // desktop: anonymous play stats page
    const statsBtn = el('button', 'rkr-statsbtn rkr-desk', '📊 STATS');
    statsBtn.addEventListener('click', () => openStatsPage(root));
    // feedback / ideas from the title screen too (main.js opens the feedback box)
    const fbBtn = el('button', 'rkr-statsbtn', '💡 FEEDBACK');
    fbBtn.addEventListener('click', () => { if (feedbackHandler) feedbackHandler(); });
    const footl = el('div', 'rkr-footl');
    footl.append(statsBtn, fbBtn);
    // the legends board (legends.js), for everyone to look at
    if (legendsHandler) {
      const lb = el('button', 'rkr-statsbtn', '📜 LEGENDS');
      lb.addEventListener('mousedown', (e) => e.preventDefault());   // keep Enter / gamepad on the menu buttons
      lb.addEventListener('click', () => legendsHandler());
      footl.appendChild(lb);
    }
    // settings (settings.js: volume, songs, graphics, keys); also in the Esc menu
    if (settingsHandler) {
      const sb = el('button', 'rkr-statsbtn rkr-setbtn', '⚙️ SETTINGS');
      sb.addEventListener('mousedown', (e) => e.preventDefault());   // keep Enter / gamepad on the menu buttons
      sb.addEventListener('click', () => settingsHandler());
      footl.prepend(sb);   // (leftmost)
    }
    // on the website: the page about the game, how to play and the patch notes (a real link, so search engines follow
    // it; the apps have their own links above)
    if (!NATIVE) {
      const ab = el('a', 'rkr-statsbtn', 'ℹ️ ABOUT');
      ab.href = '/about'; ab.target = '_blank';
      footl.appendChild(ab);
    }
    // 4: optional account (account.js), hidden until accounts are on
    acctBtn = o.querySelector('.rkr-swag');
    paintAccount();
    const tfoot = el('div', 'rkr-tfoot');
    tfoot.append(footl, credits);
    o.appendChild(tfoot);
    // In the corners the bottom row would cover part of the menu, or the menu doesn't fit on screen at all (zoomed in,
    // small window)? Then it goes into the flow under the panels (rkr-tight, see the CSS). Measured in the corners.
    const tcol = o.querySelector('.rkr-tcol');
    const blocks = [...tcol.children].filter((c) => !c.classList.contains('rkr-foot'));   // ('Press 1 or 2' sits between the corners)
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const fit = () => {
      if (!o.isConnected) return;
      o.classList.remove('rkr-tight');
      const corners = [...tfoot.children].map((c) => c.getBoundingClientRect());
      const covers = blocks.some((b) => { const r = b.getBoundingClientRect(); return r.height > 0 && corners.some((c) => hit(c, r)); });
      const box = o.getBoundingClientRect(), menu = tcol.getBoundingClientRect();   // (its padding may overflow a little)
      const top = menu.top - box.top + o.scrollTop, bottom = menu.bottom - box.top + o.scrollTop;   // (scroll-independent)
      if (covers || bottom > o.clientHeight + 1 || top < -1) o.classList.add('rkr-tight');
    };
    if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(fit); ro.observe(o); ro.observe(tcol); }
    window.addEventListener('resize', fit);
    requestAnimationFrame(() => requestAnimationFrame(fit));   // once it's on screen and laid out
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);   // (the web fonts change its size)
    titleBtns = [...o.querySelectorAll('.rkr-btn')];
    titleBtns.forEach((b) => {
      b.addEventListener('click', () => startGame(+b.dataset.p));
      b.addEventListener('mouseenter', () => selectTitle(+b.dataset.p));
    });
    return o;
  }
  function selectTitle(n) {
    titleSel = n;
    titleBtns.forEach((b) => b.classList.toggle('rkr-sel', +b.dataset.p === n));
  }
  function startGame(n) {
    if (!state.title) return;
    if (n === 4) { if (acctState && accountHandler) accountHandler(); return; }   // the account box opens over the title
    const cb = onStartCb;
    hideTitle();
    if (cb) cb({ players: n === 2 || n === 3 ? n : 1 });
  }
  function showTitle(onStart) {
    onStartCb = onStart || null;
    if (titleEl) titleEl.remove();
    titleEl = buildTitle();
    root.appendChild(titleEl);
    state.title = true;
    hud.classList.add('rkr-off');
    H.visible = false;
    selectTitle(titleSel);
  }
  // back to the menu / lobby without the title screen: don't leave the last run's HUD up behind it
  function hideHUD() {
    hud.classList.add('rkr-off');
    H.visible = false;
    setFinaleMode(false);
  }
  function hideTitle() {
    if (!state.title || !titleEl) { state.title = false; return; }
    state.title = false;
    const node = titleEl;
    titleEl = null;
    node.classList.add('rkr-leaving');
    setTimeout(() => node.remove(), 460);
  }

  // ================= pause =================
  let pauseEl = null;
  // onLeave: a LEAVE GAME button. online: the online menu (the game keeps running) rather than a real pause.
  function showPause(onResume, onLeave, { online = !!onLeave } = {}) {
    onResumeCb = onResume || null;
    if (pauseEl) pauseEl.remove();
    pauseEl = el('div', 'rkr-overlay rkr-dim');
    pauseEl.innerHTML = `<div class="rkr-glass">
        <div class="rkr-gcat">${ICONS.cat}</div>
        <h2>${online ? 'MENU' : 'PAUSED'}</h2>
        <div class="rkr-gsub">${online ? 'Online games keep running. Watch out!' : 'The kitties are taking a little nap.'}</div>
        <button class="rkr-btn">RESUME</button>
        ${onLeave ? '<button class="rkr-btn rkr-alt rkr-leave">LEAVE GAME</button>' : ''}
        ${settingsHandler ? '<button class="rkr-btn rkr-set rkr-setbtn">SETTINGS</button>' : ''}
        <div class="rkr-keyhint"><span class="rkr-k rkr-wide">Enter</span> or <span class="rkr-k" data-act="pause"></span> to resume &middot; <span class="rkr-k" data-act="sound"></span> mute</div>
      </div>`;
    pauseEl.querySelector('.rkr-btn').addEventListener('click', resume);
    if (onLeave) pauseEl.querySelector('.rkr-leave').addEventListener('click', () => { hidePause(); onLeave(); });
    paintKeys(pauseEl);
    const sb = pauseEl.querySelector('.rkr-setbtn');
    if (sb) {
      sb.addEventListener('mousedown', (e) => e.preventDefault());   // keep Enter on RESUME
      sb.addEventListener('click', () => settingsHandler());
    }
    root.appendChild(pauseEl);
    state.pause = true;
  }
  function resume() {
    if (!state.pause) return;
    const cb = onResumeCb;
    hidePause();
    if (cb) cb();
  }
  function hidePause() {
    state.pause = false;
    if (pauseEl) { pauseEl.remove(); pauseEl = null; }
  }

  // ================= notice (e.g. "update the app") =================
  let noticeEl = null;
  function showNotice({ title, text, button, onClick, alt, onAlt, link, onLink }) {
    hideNotice();
    noticeEl = el('div', 'rkr-overlay rkr-dim');
    noticeEl.style.zIndex = '60';
    noticeEl.innerHTML = `<div class="rkr-glass">
        <div class="rkr-gcat">${ICONS.cat}</div>
        <h2>${esc(title)}</h2>
        <div class="rkr-gsub">${esc(text)}</div>
        <button class="rkr-btn">${esc(button)}</button>
        ${alt ? `<button class="rkr-btn rkr-alt rkr-nalt">${esc(alt)}</button>` : ''}
        ${link ? `<button class="rkr-nlink">${esc(link)}</button>` : ''}
      </div>`;
    noticeEl.querySelector('.rkr-btn').addEventListener('click', () => onClick && onClick());
    if (alt) noticeEl.querySelector('.rkr-nalt').addEventListener('click', () => onAlt && onAlt());
    if (link) noticeEl.querySelector('.rkr-nlink').addEventListener('click', () => onLink && onLink());
    root.appendChild(noticeEl);
  }
  function hideNotice() {
    if (noticeEl) { noticeEl.remove(); noticeEl = null; }
  }

  // ================= game over =================
  let goEl = null, goRaf = 0, goTimers = [];
  const GO_LINES = [
    'The wolves win this round...',
    'Nine lives? Not today.',
    'Every kitty deserves another try.',
    'So close to the glowing heart!',
  ];
  // onLeave: a LEAVE GAME button next to TRY AGAIN / BACK TO LOBBY; onAgain (a lobby's host): a RESTART GAME button
  // above them (straight into a new game, the lobby skipped; it reads STARTING… until the game starts)
  // A ranking, best first (list: [{ name, color, score, crowns, caught, me, kitties?: [{ name, color }] (a team's, under
  // its name) }], in rankOrder; what: 'team' / 'kitty'). A draw on points goes to more crowns, then fewer times caught;
  // all three the same share a place (two 1st, then 3rd), the 1st ones all gold. More than RANK_SHOW: the top places and
  // yours, the rest behind "+N more" (wireRankMore)
  const RANK_SHOW = 3;
  function rankHTML(list, what = 'kitty') {
    const at = list.map((t) => list.filter((o) => rankOrder(o, t) < 0).length);   // (its place: how many are ahead)
    const place = (i) => { const n = at[i] + 1, t = n % 100; return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); };
    const hide = (t, i) => list.length > RANK_SHOW && at[i] >= RANK_SHOW && !t.me, hidden = list.filter(hide).length;
    const more = hidden + ' more ' + (what === 'team' ? (hidden === 1 ? 'team' : 'teams') : hidden === 1 ? 'kitty' : 'kitties');
    return `<div class="rkr-rank">${list.map((t, i) => `<div class="rkr-rrow${at[i] === 0 ? ' rkr-rwin' : ''}${hide(t, i) ? ' rkr-rhide' : ''}"><span class="rkr-rpl">${place(i)}</span>
      <span class="rkr-rn" style="color:${hexColor(t.color)}">${esc(t.name)}${t.me ? ' <i>(you)</i>' : ''}${t.kitties && t.kitties.length ? `<small>${t.kitties.map((k) => `<span style="color:${hexColor(k.color)}">${esc(k.name)}</span>`).join(', ')}</small>` : ''}</span>
      ${t.crowns > 0 ? `<span class="rkr-scr">${ICONS.crown}${t.crowns}</span>` : ''}<span class="rkr-rs">${t.score > 0 ? '+' : ''}${t.score}</span></div>`).join('')}${hidden ? `<button class="rkr-rmore">+${more}</button>` : ''}</div>`;
  }
  // "+N more" shows the rest of the ranking (the card scrolls when it's long)
  function wireRankMore(node) {
    for (const b of node.querySelectorAll('.rkr-rmore')) {
      b.addEventListener('mousedown', (e) => e.preventDefault());   // (keep Enter on the card's main button)
      b.addEventListener('click', (e) => { e.stopPropagation(); b.closest('.rkr-rank').classList.add('rkr-rall'); b.remove(); });
    }
  }
  // versus: the winning team, or all the teams tied for 1st (points, crowns and times caught all the same: rankOrder;
  // "A, B and C"; last: ' and ' / ' & ')
  function winnersOf(list, last) {
    const top = list.filter((t) => rankOrder(t, list[0]) === 0).map((t) => t.name);
    return top.length > 1 ? top.slice(0, -1).join(', ') + last + top[top.length - 1] : top[0];
  }
  function showGameOver(stats, onRestart, buttonLabel, onLeave, onAgain) {
    stats = stats || {};
    onRestartCb = onRestart || null;
    hideGameOver();
    goEl = el('div', 'rkr-overlay rkr-dim');
    // (hell: the level and how far along its map, e.g. "12 · 34%")
    const hellFmt = (v) => (v >= (stats.level | 0) ? `${v} · ${Math.floor((stats.far || 0) * 100)}%` : String(v));
    const rows = [
      stats.hell ? { icon: ICONS.cat, label: 'Hell level reached', v: stats.level | 0, fmt: hellFmt, color: '#ff7a4a' }
        : { icon: ICONS.cat, label: 'Level reached', v: stats.level | 0, fmt: String, color: '#ffb347' },
      { icon: ICONS.clock, label: 'Time survived', v: Math.floor(stats.time || 0), fmt: fmtTime, color: '#cdbfff' },
      { icon: ICONS.revive, label: 'Kitties rescued', v: stats.rescues | 0, fmt: String },
      { icon: ICONS.wolf, label: 'Times caught', v: stats.deaths | 0, fmt: String },
    ];
    const line = GO_LINES[((stats.level | 0) + (stats.deaths | 0)) % GO_LINES.length];
    // versus: who won and the teams' places, no stat rows
    const vs = stats.versus && stats.versus.length ? stats.versus : null;
    if (vs) rows.length = 0;
    // (...but how far the team that got furthest went: level · %, and its kitty that did)
    const fur = vs && stats.furthest;
    if (fur) rows.push({ icon: ICONS.cat, label: `Furthest: <span style="color:${hexColor(fur.color)}">${esc(fur.name)}${fur.kitty ? ` (${esc(fur.kitty)})` : ''}</span>`, v: stats.level | 0,
      fmt: (v) => (v >= (stats.level | 0) ? `${stats.hell ? 'hell ' : 'level '}${v} · ${Math.floor(fur.far * 100)}%` : String(v)), color: stats.hell ? '#ff7a4a' : '#ffb347' });
    goEl.innerHTML = `<div class="rkr-glass rkr-gameover">
        ${stats.onShare ? '<button class="rkr-statsbtn rkr-setbtn rkr-goshare">📤 SHARE</button>' : ''}
        <div class="rkr-gcat">${ICONS.cat}</div>
        <h2>GAME OVER</h2>
        <div class="rkr-gsub">${vs ? `Everyone is down, ${esc(winnersOf(vs, ' and '))} win!` : esc(line)}</div>
        ${vs ? rankHTML(vs, 'team') : ''}
        ${stats.alone ? `<div class="rkr-alone">${ICONS.revive}<span><b>Hint:</b> Alone, nobody can revive you when you're caught. Project: Run Kitty Run is made to be beaten together. ${stats.alone === 'online' ? 'Invite some into your lobby!' : 'Play Multiplayer or Local co-op!'}</span></div>` : ''}
        ${rows.length ? `<div class="rkr-stats">${rows.map((r) => `<div class="rkr-stat"><div class="rkr-ico" style="color:${r.color || '#fff'}">${r.icon}</div><span class="rkr-sl">${r.label}</span><span class="rkr-sv">${r.fmt(0)}</span></div>`).join('')}</div>` : ''}
        <div class="rkr-btns">${onAgain ? '<button class="rkr-btn rkr-goagain">RESTART GAME</button>' : ''}<button class="rkr-btn rkr-gomain">${esc(buttonLabel || 'TRY AGAIN')}</button>${onLeave ? '<button class="rkr-btn rkr-alt rkr-goleave">LEAVE GAME</button>' : ''}</div>
        <div class="rkr-keyhint">press <span class="rkr-k rkr-wide">Enter</span></div>
        <div class="rkr-goslot"></div>
      </div>`;
    // dead-cat eyes on the header cat
    const gcat = goEl.querySelector('.rkr-gcat');
    gcat.querySelector('.rkr-eyes').style.display = 'none';
    gcat.querySelector('.rkr-xeyes').style.display = 'inline';
    gcat.style.animation = 'rkr-wiggle 2.4s ease-in-out infinite';
    if (vs) { gcat.querySelector('.rkr-eyes').style.display = ''; gcat.querySelector('.rkr-xeyes').style.display = 'none'; gcat.style.color = hexColor(vs[0].color); }   // (versus: the winners' cat, happy)
    goEl.querySelector('.rkr-gomain').addEventListener('click', restart);
    if (onLeave) goEl.querySelector('.rkr-goleave').addEventListener('click', () => { if (!state.gameOver) return; hideGameOver(); onLeave(); });
    if (onAgain) {
      const ab = goEl.querySelector('.rkr-goagain');
      ab.addEventListener('click', () => { if (!state.gameOver || ab.disabled) return; ab.disabled = true; ab.textContent = 'STARTING…'; onAgain(); });
    }
    // share the result (share.js: an image card + text); the card stays up
    if (stats.onShare) {
      const sb = goEl.querySelector('.rkr-goshare');
      sb.addEventListener('mousedown', (e) => e.preventDefault());   // keep Enter on the main button
      sb.addEventListener('click', () => stats.onShare());
    }
    wireRankMore(goEl);
    root.appendChild(goEl);
    state.gameOver = true;
    gameOverArmedAt = performance.now() + 700;

    const statEls = [...goEl.querySelectorAll('.rkr-stat')];
    const anims = rows.map((r, i) => ({ el: statEls[i], val: statEls[i].querySelector('.rkr-sv'), r, start: 350 + i * 220, last: -1 }));
    anims.forEach((a) => goTimers.push(setTimeout(() => a.el.classList.add('rkr-show'), a.start)));
    const t0 = performance.now();
    const tick = () => {
      const el0 = performance.now() - t0;
      let done = true;
      for (const a of anims) {
        const k = Math.max(0, Math.min(1, (el0 - a.start - 100) / 800));
        if (k < 1) done = false;
        const e = 1 - Math.pow(1 - k, 3);
        const v = Math.round(a.r.v * e);
        if (v !== a.last) { a.last = v; a.val.textContent = a.r.fmt(v); }
      }
      if (done) { clearInterval(goRaf); goRaf = 0; }
    };
    goRaf = setInterval(tick, 33); // interval (not rAF) so it also finishes in throttled/background tabs
  }
  function restart() {
    if (!state.gameOver) return;
    const cb = onRestartCb;
    hideGameOver();
    if (cb) cb();
  }
  function hideGameOver() {
    state.gameOver = false;
    if (goRaf) clearInterval(goRaf);
    goRaf = 0;
    goTimers.forEach(clearTimeout); goTimers = [];
    if (goEl) { goEl.remove(); goEl = null; }
  }

  // ================= victory (the final run is beaten) =================
  // stats: { mode, runTime, totalTime, deaths, rescues, first: {name, color} | null, players: [{name, color, first}] }
  // buttons: [{ label, sub?, alt?, green?, mini?, keep?, onClick }] (first = default selection; keep: the victory screen stays up)
  let vEl = null, vRaf = 0, vTimers = [], vBtns = [], vSel = 0, vArmedAt = 0, vFishRow = null;
  const V_LINES = [
    'Every wolf dodged. Every kitty home.',
    'The ice is yours. Legends skate here.',
    'Nine lives well spent.',
  ];
  function showVictory(stats, buttons) {
    stats = stats || {};
    hideVictory();
    hidePause();
    vEl = el('div', 'rkr-overlay rkr-victory');
    // (hell: its last level's time, and the whole way through all of its levels)
    const rows = [
      { icon: ICONS.flag, label: stats.hell ? 'Last level time' : 'Final run time', v: stats.runTime, fmt: fmtTime, color: '#3ee08f' },
      { icon: ICONS.clock, label: stats.hell ? 'Total time in hell' : 'Total time', v: stats.totalTime, fmt: stats.hell ? fmtLong : fmtTime, color: '#cdbfff' },
      { icon: ICONS.revive, label: 'Kitties rescued', v: stats.rescues | 0, fmt: String },
      { icon: ICONS.wolf, label: 'Times caught', v: stats.deaths | 0, fmt: String },
      { icon: ICONS.fish, label: 'Giant fish eaten', v: stats.fish, fmt: (v) => v + '%', fish: true },
    ].filter((r) => r.v != null && isFinite(r.v));
    vFishRow = rows.find((r) => r.fish) || null;
    if (vFishRow) vFishRow.idx = rows.indexOf(vFishRow);
    const ps = stats.players || [];
    const first = stats.first;
    const line = (stats.deaths | 0) === 0 ? 'Not a single kitty caught. Flawless!' : V_LINES[((stats.deaths | 0) + ps.length) % V_LINES.length];
    vEl.innerHTML = `<div class="rkr-glass">
        <div class="rkr-vcrown">${ICONS.crown}</div>
        ${stats.versus && stats.versus.length ? `<h2>${esc(winnersOf(stats.versus, ' & '))}<br>WIN!</h2>${rankHTML(stats.versus, 'team')}` : ''}
        <h2${stats.versus && stats.versus.length ? ' hidden' : ''}>${stats.hell ? 'YOU ESCAPED<br>HELL!' : stats.mode === 'run' ? 'YOU CLEARED<br>RUN MODE!' : stats.mode === 'ice' ? 'YOU CLEARED<br>SKATE MODE!' : 'YOU BEAT<br>RUN KITTY RUN!'}</h2>
        <div class="rkr-gsub">${esc(line)}</div>
        ${first && ps.length > 1 ? `<div class="rkr-vfirst">${ICONS.crown}<span>First to the goal: <span class="rkr-vname" style="color:${hexColor(first.color)}">${esc(first.name)}</span></span></div>` : ''}
        <div class="rkr-stats">${rows.map((r) => `<div class="rkr-stat"><div class="rkr-ico" style="color:${r.color || '#fff'}">${r.icon}</div><span class="rkr-sl">${r.label}</span><span class="rkr-sv">${r.fmt(0)}</span></div>`).join('')}</div>
        ${stats.versus && stats.versus.length ? '' : stats.ranking && stats.ranking.length > 1 ? rankHTML(stats.ranking, 'kitty')
          : ps.length > 1 ? `<div class="rkr-party">${ps.map((p) => `<span class="rkr-chip" style="color:${hexColor(p.color)}">${ICONS.cat}<span>${p.first ? '👑 ' : ''}${esc(p.name)}</span></span>`).join('')}</div>` : ''}
        <div class="rkr-vbtns">${(buttons || []).map((b) => `<button class="rkr-btn${b.alt ? ' rkr-alt' : ''}${b.green ? ' rkr-set' : ''}${b.mini ? ' rkr-mini' : ''}"><span>${esc(b.label)}</span>${b.sub ? `<small>${esc(b.sub)}</small>` : ''}</button>`).join('')}</div>
        <div class="rkr-keyhint">press <span class="rkr-k rkr-wide">Enter</span></div>
      </div>`;
    vBtns = [...vEl.querySelectorAll('.rkr-vbtns .rkr-btn')];
    vBtns.forEach((b, i) => {
      b.addEventListener('click', () => pickVictory(i, buttons));
      b.addEventListener('mouseenter', () => selectVictory(i));
    });
    vEl._buttons = buttons || [];
    wireRankMore(vEl);
    root.appendChild(vEl);
    state.victory = true;
    vArmedAt = performance.now() + 1000;
    selectVictory(0);

    const statEls = [...vEl.querySelectorAll('.rkr-stat')];
    const anims = rows.map((r, i) => ({ el: statEls[i], val: statEls[i].querySelector('.rkr-sv'), r, start: 450 + i * 240, last: -1 }));
    anims.forEach((a) => vTimers.push(setTimeout(() => a.el.classList.add('rkr-show'), a.start)));
    const t0 = performance.now();
    vRaf = setInterval(() => {
      const e0 = performance.now() - t0;
      let done = true;
      for (const a of anims) {
        const k = Math.max(0, Math.min(1, (e0 - a.start - 100) / 900));
        if (k < 1) done = false;
        const v = Math.round(a.r.v * (1 - Math.pow(1 - k, 3)));
        if (v !== a.last) { a.last = v; a.val.textContent = a.r.fmt(v); }
      }
      if (done) { clearInterval(vRaf); vRaf = 0; }
    }, 33);
  }
  function selectVictory(i) {
    if (!vBtns.length) return;
    vSel = (i + vBtns.length) % vBtns.length;
    vBtns.forEach((b, k) => b.classList.toggle('rkr-sel', k === vSel));
  }
  function pickVictory(i, buttons) {
    if (!state.victory) return;
    const b = (buttons || [])[i];
    if (!(b && b.keep)) hideVictory();
    if (b && b.onClick) b.onClick();
  }
  // the final run's giant fish is eaten live while the victory screen is up (percent, 0-100)
  function updateVictoryFish(pct) {
    if (!vFishRow || !vEl) return;
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    if (pct === vFishRow.v) return;
    vFishRow.v = pct;
    if (vRaf) return;   // the count-up animation is still running: it picks the new value up
    const el = vEl.querySelectorAll('.rkr-stat .rkr-sv')[vFishRow.idx];
    if (el) el.textContent = vFishRow.fmt(pct);
  }
  // another panel (the legends board) sits on top: the victory card steps aside and ignores keys / the pad meanwhile
  let blocker = null;
  function setBlocker(fn) { blocker = fn; }
  function setVictoryHidden(on) { if (vEl) vEl.classList.toggle('rkr-hidden', !!on); }
  function hideVictory() {
    vFishRow = null;
    state.victory = false;
    if (vRaf) clearInterval(vRaf);
    vRaf = 0;
    vTimers.forEach(clearTimeout); vTimers = [];
    vBtns = [];
    if (vEl) { vEl.remove(); vEl = null; }
  }

  // Gamepad (main.js polls the pad and sends edges): 'confirm' | 'prev' | 'next' for the open overlay.
  function navigate(cmd) {
    if (blocker && blocker()) return;
    if (state.victory) {
      if (cmd === 'prev') selectVictory(vSel - 1);
      else if (cmd === 'next') selectVictory(vSel + 1);
      else if (cmd === 'confirm' && performance.now() >= vArmedAt && vEl) pickVictory(vSel, vEl._buttons);
    } else if (state.gameOver) {
      if (cmd === 'confirm' && performance.now() >= gameOverArmedAt) restart();
    } else if (state.pause) {
      if (cmd === 'confirm') resume();
    }
  }

  // ================= scoreboard (top right) =================
  let scoresKey = '';
  // versus: the teams' order on the board (their points move all the time with the distance: re-sorted at most every
  // VS_SORT_MS, ties kept where they were, so the rows don't jump about)
  const VS_SORT_MS = 2000;
  let vsOrder = [], vsSortAt = 0;
  function steadyOrder(list) {
    const key = (p) => p.name + '|' + p.color, now = performance.now();
    if (now - vsSortAt > VS_SORT_MS || list.length !== vsOrder.length || list.some((p) => !vsOrder.includes(key(p)))) {
      const was = (p) => { const i = vsOrder.indexOf(key(p)); return i < 0 ? 1e9 : i; };
      vsOrder = [...list].sort((a, b) => b.score - a.score || was(a) - was(b)).map(key);
      vsSortAt = now;
    }
    return vsOrder.map((k) => list.find((p) => key(p) === k));
  }
  // the row whose revives / times caught are open (its score hovered, or tapped for 3 s): kept here, as the board is rebuilt whenever a score changes
  const sOpen = { who: '', hover: false, tap: 0 };
  const openScores = () => { for (const r of scoresEl.querySelectorAll('.rkr-sr')) r.classList.toggle('rkr-sopen', r.dataset.who === sOpen.who && (sOpen.hover || !!sOpen.tap)); };
  // your best score: one for each mode and difficulty (kind, main.js), from the scoring with distance on
  // ('rkr-best2-<kind>'; the old one for everything, 'rkr-best', is dropped)
  let best = 0, bestKind = null;
  try { localStorage.removeItem('rkr-best'); } catch { /* ignore */ }

  function setScores(list, kind) {
    if (!list) { scoresEl.style.display = 'none'; scoresKey = ''; return; }
    scoresEl.style.display = '';
    if (kind !== bestKind) { bestKind = kind; best = 0; try { best = parseInt(localStorage.getItem('rkr-best2-' + kind) || '0', 10) || 0; } catch { /* ignore */ } }
    const mine = list.filter((p) => p.me).reduce((m, p) => Math.max(m, p.score), -Infinity);
    if (mine > best) { best = mine; try { localStorage.setItem('rkr-best2-' + bestKind, String(best)); } catch { /* ignore */ } }
    const all = kind && kind.startsWith('versus') ? steadyOrder(list) : [...list].sort((a, b) => b.score - a.score);
    // big lobbies: top 8, plus you if you're further down
    const rows = all.slice(0, 8);
    const meRow = all.find((p) => p.you);
    if (meRow && !rows.includes(meRow)) rows.push(meRow);
    const key = rows.map((p) => `${p.name}|${p.score}|${p.me}|${p.crown}|${p.crowns}|${p.revives || 0}|${p.caught || 0}|${p.shimmer}|${p.paid || 0}|${p.ps || ''}|${p.members || ''}`).join(',') + '#' + best;
    if (key === scoresKey) return;
    scoresKey = key;
    scoresEl.textContent = '';
    scoresEl.appendChild(el('div', 'rkr-sh', 'SCORE'));
    for (const p of rows) {
      const r = el('div', 'rkr-sr' + (p.you ? ' rkr-me' : ''));
      const n = el('span'); n.textContent = p.name; n.style.color = hexColor(p.color);
      if (p.shimmer) n.classList.add('rkr-shim');   // 12+ wins
      if (p.gold) n.classList.add('rkr-goldname');
      const v = el('span'); v.textContent = (p.score > 0 ? '+' : '') + p.score;
      r.append(n);
      if (p.paid > 0) {   // (the account total: shown beside the row on hover, or for a moment after a tap / click)
        r.dataset.paid = fmtNum(p.paid);
        const fish = el('span', 'rkr-fish'); fish.innerHTML = swagHTML(fmtNum(p.paid), p.ps); r.appendChild(fish);
        r.addEventListener('click', () => { r.classList.add('rkr-showpaid'); clearTimeout(r._t); r._t = setTimeout(() => r.classList.remove('rkr-showpaid'), 2500); });
      }
      // the crowns this kitty has won this run; hover the score (or tap it) for the kitties it revived and the times it was caught (a 0 faint)
      if (p.crowns > 0) { const c = el('span', 'rkr-scr', ICONS.crown); c.appendChild(document.createTextNode(String(p.crowns))); c.title = p.crowns + (p.crowns === 1 ? ' crown' : ' crowns'); r.appendChild(c); }
      const stat = (cls, icon, n, title) => { const c = el('span', 'rkr-scr rkr-scol rkr-shid ' + cls + (n > 0 ? '' : ' rkr-szero'), icon); c.appendChild(document.createTextNode(String(n))); c.title = title; r.appendChild(c); };
      stat('rkr-srev', `<span class="rkr-sdmed" style="color:${hexColor(p.color)}">${MEDIC_SVG}</span>`, p.revives || 0, (p.revives || 0) + (p.revives === 1 ? ' revive' : ' revives'));
      stat('rkr-scau', ICONS.revive, p.caught || 0, 'caught ' + (p.caught || 0) + (p.caught === 1 ? ' time' : ' times'));   // (the ghost: a kitty down)
      v.classList.add('rkr-sv');
      const who = r.dataset.who = p.name + '|' + p.color;
      v.addEventListener('mouseenter', () => { sOpen.who = who; sOpen.hover = true; openScores(); });
      v.addEventListener('mouseleave', () => { sOpen.hover = false; openScores(); });
      v.addEventListener('click', () => { sOpen.who = who; clearTimeout(sOpen.tap); sOpen.tap = setTimeout(() => { sOpen.tap = 0; openScores(); }, 3000); openScores(); });
      r.appendChild(v);
      if (p.members) {   // (versus: a team's row; its kitties under it while its name or score is hovered / tapped)
        r.classList.add('rkr-steam');
        const mm = el('div', 'rkr-smem'); mm.textContent = p.members; r.appendChild(mm);
        n.addEventListener('mouseenter', () => { sOpen.who = who; sOpen.hover = true; openScores(); });
        n.addEventListener('mouseleave', () => { sOpen.hover = false; openScores(); });
        n.addEventListener('click', () => { sOpen.who = who; clearTimeout(sOpen.tap); sOpen.tap = setTimeout(() => { sOpen.tap = 0; openScores(); }, 3000); openScores(); });
      }
      scoresEl.appendChild(r);
    }
    openScores();
    if (all.length > rows.length) { const more = el('div', 'rkr-best'); more.textContent = `+${all.length - rows.length} more`; scoresEl.appendChild(more); }
    const b = el('div', 'rkr-best'); b.textContent = `best ${best > 0 ? '+' : ''}${best}`;
    scoresEl.appendChild(b);
  }

  // ================= misc =================
  function setMutedIcon(m) {
    muteEl.classList.toggle('rkr-muted', !!m);
    muteEl.setAttribute('aria-pressed', String(!!m));
    muteEl.title = m ? 'Sound is off: click or press M to turn it on' : 'Sound on: click or press M to mute';
    hintEl.querySelector('.rkr-snd').textContent = m ? 'sound on' : 'mute';
  }
  let muteHandler = null;
  muteEl.addEventListener('click', () => { if (muteHandler) muteHandler(); });
  function onMuteClick(fn) { muteHandler = fn; }
  // the title screen's music button: { label() -> text, cycle() -> next choice's text } (main.js)
  let settingsHandler = null;
  function onSettingsClick(fn) { settingsHandler = fn; }
  let legendsHandler = null;
  function onLegendsClick(fn) { legendsHandler = fn; }
  // keycaps marked data-act show the key picked for that action in the settings
  function paintKeys(node) {
    for (const k of node.querySelectorAll('[data-act]')) {
      const name = keyName(key(k.dataset.act));
      k.textContent = name;
      k.classList.toggle('rkr-wide', name.length > 1);
    }
  }
  function refreshKeys() { for (const n of [titleEl, pauseEl, hintEl]) if (n) paintKeys(n); }
  let feedbackHandler = null;
  function onFeedbackClick(fn) { feedbackHandler = fn; }
  function onAccountClick(fn) { accountHandler = fn; }
  // title screen button 4: null hides it (accounts off), else { paid } in cents (0 = no account yet)
  function setAccountButton(st) { acctState = st || null; paintAccount(); }
  function paintAccount() {
    if (!acctBtn) return;
    acctBtn.classList.toggle('rkr-hidden', !acctState);
    acctBtn.parentNode.classList.toggle('rkr-three', !!acctState);
    if (!acctState) return;
    const paid = acctState.paid || 0;
    // short title so it's the size of the other three; the rest goes in the small line
    acctBtn.querySelector('.rkr-swagt').textContent = 'SWAG ACCOUNT';
    // signed in: the button opens the account menu (the "shown online" switch, adding more, signing out)
    acctBtn.querySelector('small').textContent = paid ? `${fmtNum(paid)}${acctState.hidden ? ' hidden' : ''} · manage account`
      : acctState.signedIn ? 'manage your account' : 'create one or sign in';
  }
  function onMenuClick(fn) { menuHandler = fn; }
  function isOverlayOpen() { return state.title || state.pause || state.gameOver || state.victory; }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (blocker && blocker()) return;
    if (e.code === key('hud') && !state.title && !e.target.closest?.('input')) { setHudMin(!hudMin); return; }
    if (e.code === key('full') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest?.('input, textarea')) { toggleFull(); return; }
    if (state.victory) {
      if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'a' || k === 'A' || k === 'w' || k === 'W') selectVictory(vSel - 1);
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'd' || k === 'D' || k === 's' || k === 'S') selectVictory(vSel + 1);
      else if ((k === 'Enter' || k === ' ') && performance.now() >= vArmedAt) { e.preventDefault(); pickVictory(vSel, vEl && vEl._buttons); }
      return;
    }
    if (state.gameOver) {
      if ((k === 'Enter' || k === ' ') && performance.now() >= gameOverArmedAt) { e.preventDefault(); restart(); }
      return;
    }
    if (state.pause) {
      if (k === 'Enter') { e.preventDefault(); resume(); }
      return;
    }
    if (state.title) {
      const order = titleOrder(), idx = order.indexOf(titleSel);
      if (/^[1-9]$/.test(k) && order[+k - 1]) startGame(order[+k - 1]);
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); startGame(titleSel); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'a' || k === 'A' || k === 'w' || k === 'W') selectTitle(order[Math.max(0, idx - 1)]);
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'd' || k === 'D' || k === 's' || k === 'S') selectTitle(order[Math.min(order.length - 1, idx + 1)]);
    }
  });

  setMutedIcon(false);

  return {
    showTitle, hideTitle, setHUD, updateMinimap, banner, toast, setScores, onVoteKill: (fn) => { voteKillCb = fn; },
    showPause, hidePause, showGameOver, hideGameOver, onSettingsClick, onLegendsClick, refreshKeys, gameOverSlot: () => (goEl ? goEl.querySelector('.rkr-goslot') : null), setMutedIcon, isOverlayOpen, onMuteClick, onFeedbackClick, onAccountClick, setAccountButton, onMenuClick,
    showVictory, hideVictory, updateVictoryFish, isVictoryOpen: () => state.victory, navigate, hideHUD,
    showNotice, hideNotice, setBlocker, setVictoryHidden,
    isTitleOpen: () => state.title, isGameOverOpen: () => state.gameOver,
    isNoticeOpen: () => !!noticeEl,
    // the open title screen / pause menu / notice (controller navigation, padnav.js)
    titleRoot: () => (state.title ? titleEl : null), pauseRoot: () => (state.pause ? pauseEl : null), noticeRoot: () => noticeEl,
    gameOverRoot: () => (state.gameOver ? goEl : null),
  };
}

export { rankOrder, createUI };
