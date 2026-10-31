// Online lobby screens (browser + room), styled with the same rkr-* look as ui.js.
// All player-supplied text is inserted with textContent.
import { fmtNum } from './account.js';
import { createColorRow, prefColor, P2_COLOR_KEY } from './kittycolor.js';
import { PLAYER_COLORS, PLAYER_NAMES } from './shared/config.js';
import { inviteUrl, share } from './platform.js';

const CAT = `<svg viewBox="0 0 40 40"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="#2b1840" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/></svg>`;
const CROWN = `<svg viewBox="0 0 40 30"><path d="M3 26 L6 7 L14 16 L20 3 L26 16 L34 7 L37 26 Z" fill="#ffcf5a" stroke="#7a4b00" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

const MODES = [
  { id: 'mixed', label: 'Run + Skate', tip: 'Every level twice: on foot by day, then on skates by night.' },
  { id: 'run', label: 'Run only', tip: 'Run only (no ice): get through 8 levels of the labyrinth.' },
  { id: 'ice', label: 'Skate only', tip: 'Skate only (no run): get through 8 levels of the labyrinth.' },
];
const modeLabel = (id, easy, hell, chain, versus) => (MODES.find((m) => m.id === id) || MODES[0]).label + (hell ? (easy ? ' (hell, easy)' : ' (hell)') : easy ? ' (easy)' : '') + (versus ? ' ⚔ versus' : '') + (chain === 'all' ? ' ⛓ everyone chained' : chain ? ' ⛓ chained' : '');
const VERSUS_TIP = ' Versus: teams against each other (make them in the lobby). You can only revive your own team; a team takes the crown once all of it has reached the goal. Points: how far your slowest kitty gets, and crowns; -1 when caught. Team with the most points wins.';
const CHAIN_ALL_TIP = ' Everyone chained: the whole team on one chain, each kitty to the next; in a lobby, click a kitty to have them next to you. The chain shares its boots. Chained games have their own level times.';
const CHAIN_TIP = ' Chained: kitties are chained up in twos (one chain of three when there are an odd number); in a lobby, click a kitty to pick your partner. A chain shares its boots. Chained games have their own level times.';
const EASY_TIP = 'Easy: when everyone is down, the level starts over instead of the game being over. Easy games have their own rewards.';
const HELL_TIP = 'Hell: get through 6 levels of hell.';
const HELL_EASY_TIP = 'Hell (easy): get through 6 levels of hell; when everyone is down, the level starts over.';
const MAX_KITTIES = 32;   // a lobby's player cap (NET.MAX_PLAYERS)
const PLAT = { ios: ['🍎', 'iPhone / iPad app'], android: ['🤖', 'Android app'], web: ['🌐', 'Browser'] };

const CSS = `
.rkl-box{max-width:560px;text-align:center;}
.rkl-box h2{font-size:clamp(34px,5vw,50px)!important;}
.rkl-row{display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;width:100%;}
.rkl-in{font:inherit;font-weight:800;font-size:18px;padding:10px 14px;border-radius:14px;border:2px solid rgba(255,255,255,.3);
  background:rgba(10,4,30,.55);color:#fff;outline:none;min-width:0;user-select:text;-webkit-user-select:text;}
.rkl-in:focus{border-color:#ffcf5a;}
.rkl-small{font-size:15px!important;padding:10px 16px!important;}
.rkl-err{min-height:20px;color:#ff8fa3;font-weight:800;}
.rkl-label{font-size:13px;font-weight:900;letter-spacing:.14em;color:#ffcf5a;text-transform:uppercase;margin-top:4px;}
.rkl-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;width:100%;max-height:34vh;overflow:auto;}
.rkl-slot{min-width:0;}
.rkl-chainpick{cursor:pointer;}
.rkl-chainbox{margin-top:6px;}
.rkl-chainbtn{width:100%;justify-content:center;min-height:34px;}
.rkl-chainbox .rkl-chainbtn.rkl-on{background:rgba(185,160,255,.22);border-color:#b9a0ff;color:#f1ebff;}   /* (lilac: beats .rkl-mode.rkl-on's gold) */
.rkl-chainbox .rkl-chainbtn.rkl-on::before{background:#b9a0ff;border-color:#f1ebff;}
.rkl-chainpick:hover{border-color:#ffcf5a;}
.rkl-chainno{font-size:11px;font-weight:900;color:#d8dde3;margin-left:4px;}
/* versus: FIND OPPONENTS with its ANY MODE button under it (green while on: the game's green button, ui.js .rkr-set) */
.rkl-searchbox{display:flex;flex-direction:column;align-items:stretch;gap:6px;}
/* versus: its switch (coral), and the lobby's teams: a box each with its name (yours to type in), its kitties, JOIN */
.rkl-vsbtn{width:100%;justify-content:center;min-height:34px;margin-top:6px;}
.rkl-modebox .rkl-vsbtn.rkl-on{background:rgba(255,120,90,.22);border-color:#ff8a5c;color:#fff0ea;}
.rkl-modebox .rkl-vsbtn.rkl-on::before{background:#ff8a5c;border-color:#fff0ea;}
.rkl-slots.rkl-teams{display:flex;flex-direction:column;gap:8px;}
.rkl-team{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:16px;background:rgba(255,138,92,.08);border:2px solid rgba(255,138,92,.35);}
.rkl-team.rkl-myteam{border-color:#ff8a5c;}
.rkl-thead{display:flex;align-items:center;gap:8px;font-weight:900;}
.rkl-tname{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ffd2c2;}
.rkl-in.rkl-tin{flex:1;min-width:0;height:34px;box-sizing:border-box;padding:4px 10px;font-size:15px;}
.rkl-tn{flex:none;font-size:12px;color:rgba(255,255,255,.6);}
.rkl-tslots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;}
.rkl-team.rkl-tready{border-color:#4fe36a;background:rgba(79,227,106,.1);}
.rkl-tok{flex:none;font-size:12px;font-weight:900;color:#4fe36a;}
.rkr-btn.rkl-tbtn.rkl-rdy{background:#4fe36a;color:#123;}
.rkl-treq{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:12px;background:rgba(255,207,90,.12);border:2px solid rgba(255,207,90,.4);font-weight:800;font-size:14px;}
.rkl-treq span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
.rkr-btn.rkl-tbtn{flex:none;min-height:32px;font-size:13px;padding:4px 12px 5px;border-radius:12px;border-width:3px;}
.rkl-slot{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:14px;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.12);
  font-weight:800;min-height:46px;text-align:left;}
.rkl-slot.rkl-open{opacity:.35;border-style:dashed;}
.rkl-slot .rkl-cat{width:30px;height:30px;flex:none;}
/* name on top; (you) and the swag number under it */
.rkl-slot .rkl-pinfo{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;line-height:1.15;}
.rkl-slot .rkl-pn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkl-slot .rkl-psub{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;min-width:0;}   /* (the number wraps under (you) if it must) */
.rkl-slot .rkl-psub .rkl-you{margin-left:0;}
.rkl-slot .rkl-psub .rkl-paid{font-size:10px;padding:2px 4px;max-width:100%;overflow:hidden;text-overflow:ellipsis;}
/* the host's crown on the cat's head, the platform badge in its corner: they take no room from the name */
.rkl-slot .rkl-crown{position:absolute;left:50%;top:-10px;width:18px;height:14px;transform:translateX(-50%);pointer-events:none;}
.rkl-slot .rkl-crown svg{width:100%;height:100%;display:block;}
.rkl-cat .rkl-plat{position:absolute;right:-7px;bottom:-5px;font-size:11px;line-height:1;opacity:1;}
.rkl-slot.rkl-me{border-color:rgba(255,207,90,.8);}
.rkl-you{font-size:11px;opacity:.7;margin-left:4px;}
.rkl-bigcode{font-size:44px;font-weight:900;letter-spacing:.25em;color:#fff6d8;line-height:1;margin-right:-.25em;}
.rkl-wait{font-weight:800;opacity:.85;}
@media (max-height:500px){
  .rkl-box h2{font-size:28px !important;}
  .rkl-slots{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:5px;}
  .rkl-slot{min-height:36px;padding:3px 6px;font-size:13px;}
  .rkl-slot .rkl-cat{width:22px;height:22px;}
  .rkl-bigcode{font-size:30px;}
  .rkl-label{margin-top:0;}
}
.rkl-roommode{font-weight:900;color:#bfe8ff;}
/* the lobby's buttons each in a colour of their own (not all blue); a switch while on: green (.rkr-set) */
.rkr-btn.rkr-alt.rkl-cteal{background:linear-gradient(180deg,#e0fff8,#7ee8d4 55%,#2fbfa8);}
.rkr-btn.rkr-alt.rkl-clilac{background:linear-gradient(180deg,#f1e8ff,#c9a8ff 55%,#9a72ff);}
.rkr-btn.rkr-alt.rkl-cpeach{background:linear-gradient(180deg,#fff0e0,#ffc08a 55%,#ff8f5a);}
.rkr-btn.rkr-alt.rkl-cswitch{background:linear-gradient(180deg,#f4f0fc,#d4cbec 55%,#ab9ed4);}
.rkl-modeline{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;}
.rkl-modeedit{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px;border-radius:16px;background:rgba(0,0,0,.2);}
.rkl-modeedit .rkl-row{margin:0;}
.rkl-link{font-size:13px;font-weight:700;opacity:.75;word-break:break-all;user-select:text;-webkit-user-select:text;}
.rkl-invite{min-width:220px;}
/* invite panel: the players you played with (who's online), and the lobby link */
.rkl-recent{width:100%;max-width:520px;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:16px;
  background:rgba(20,8,40,.45);border:2px solid rgba(255,255,255,.14);text-align:left;}
.rkl-recent[hidden]{display:none;}
.rkl-rh{font-size:12px;font-weight:900;letter-spacing:.08em;color:#ffcf5a;}
.rkl-rlist{display:flex;flex-direction:column;gap:5px;max-height:210px;overflow-y:auto;}
.rkl-rrow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:10px;background:rgba(255,255,255,.05);}
.rkl-rrow .rkl-cat{width:24px;height:24px;flex:none;}
.rkl-rname{flex:1;min-width:0;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkl-rst{flex:none;font-size:12px;font-weight:800;opacity:.75;display:flex;align-items:center;gap:5px;}
.rkl-rst i{width:8px;height:8px;border-radius:50%;background:#888;}
.rkl-rst.rkl-on{opacity:1;color:#b6ffb0;}
.rkl-rst.rkl-on i{background:#4fe36a;box-shadow:0 0 6px #4fe36a;}
.rkl-rst.rkl-busy{opacity:1;color:#ffd56b;}
.rkl-rst.rkl-busy i{background:#ffb347;}
.rkl-rrow .rkr-btn.rkl-mini:disabled{opacity:.35;cursor:default;filter:grayscale(1);}
.rkl-rnote{font-size:13px;font-weight:700;opacity:.75;}
.rkl-star{flex:none;font:inherit;font-size:20px;line-height:1;padding:0 2px;background:none;border:0;cursor:pointer;color:rgba(255,255,255,.4);}
.rkl-star:hover{color:#ffd56b;}
.rkl-star.rkl-fav{color:#ffd56b;text-shadow:0 0 8px rgba(255,213,107,.6);}
.rkl-rtip{font-size:12px;font-weight:700;opacity:.6;}
.rkl-rres{font-size:12px;font-weight:800;color:#b6ffb0;flex:none;}
.rkl-rres.rkl-bad{color:#ff8fa3;}
.rkl-plat{font-size:13px;flex:none;opacity:.85;}
.rkl-slot .rkl-cat{position:relative;}
/* account total (account.js): a gold tag after the name, like on the in-game card; as long as it needs to be */
.rkl-paid{flex:none;font-size:12px;font-weight:900;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;
  color:#ffd56b;background:rgba(20,8,40,.6);padding:3px 6px;border-radius:6px;pointer-events:none;}
@media (max-height:500px){ .rkl-invite{padding:8px 22px 10px!important;} }
/* lobby browser: header, "you" row, then join (left) / start your own (right) */
.rkr-glass.rkl-bbox{max-width:880px;text-align:left;align-items:stretch;gap:12px;padding:16px 20px 18px;}
.rkl-head{display:flex;align-items:center;gap:12px;min-width:0;}
.rkl-bbox h2{font-size:34px!important;}
.rkl-hsub{margin-left:auto;font-weight:700;font-size:13px;opacity:.6;text-align:right;}
.rkl-back{flex:none;width:44px;height:44px;padding:0 0 3px;border-radius:14px;border:3px solid #3a1650;cursor:pointer;font:inherit;font-weight:900;font-size:24px;line-height:1;
  color:#3a1650;background:linear-gradient(180deg,#e3f7ff,#7fd8ff 55%,#5b9dff);box-shadow:0 4px 0 #3a1650;transition:transform .12s,box-shadow .12s;}
.rkl-back:hover{transform:translateY(-2px);box-shadow:0 6px 0 #3a1650;}
.rkl-back:active{transform:translateY(3px);box-shadow:0 1px 0 #3a1650;}
.rkl-back:focus:not(:focus-visible){outline:none;}
.rkl-you{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;padding:4px 10px;border-radius:18px;background:rgba(10,4,30,.32);border:2px solid rgba(255,255,255,.14);}
.rkl-youlab{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:900;letter-spacing:.12em;color:#ffcf5a;text-transform:uppercase;white-space:nowrap;}
.rkl-youcat{width:32px;height:32px;flex:none;}
.rkl-youcat.rkl-any{animation:rkcp-hue 4s linear infinite;}
.rkl-namebox{display:flex;align-items:center;gap:6px;}
.rkl-in.rkl-name{width:150px;height:40px;box-sizing:border-box;padding:6px 12px;font-size:17px;}
.rkl-dice{flex:none;width:40px;height:40px;padding:0;border-radius:12px;cursor:pointer;font-size:20px;line-height:1;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.22);}
.rkl-dice:hover{background:rgba(255,255,255,.2);border-color:#ffcf5a;}
.rkl-dice:active{transform:rotate(-25deg) scale(.92);}
.rkl-you .rkcr{flex:1 1 auto;}
.rkl-cols{display:flex;gap:12px;align-items:stretch;min-height:0;}
.rkl-col{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px 12px;border-radius:20px;background:rgba(255,255,255,.06);
  border:2px solid rgba(255,255,255,.14);transition:border-color .25s,box-shadow .25s;}
.rkl-joincol{flex:3 1 0;}
.rkl-newcol{flex:2 1 0;}
.rkl-col.rkl-hot{border-color:rgba(255,207,90,.85);box-shadow:0 0 0 3px rgba(255,207,90,.15),0 0 24px rgba(255,207,90,.2);}
.rkl-ctitle{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:900;letter-spacing:.12em;color:#fff6d8;text-transform:uppercase;white-space:nowrap;}
.rkl-live{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;letter-spacing:.06em;color:#b6ffb0;}
.rkl-dot{width:9px;height:9px;border-radius:50%;background:#4fe36a;box-shadow:0 0 8px #4fe36a;animation:rkl-pulse 1.6s ease-in-out infinite;}
.rkl-live.rkl-zero{color:#fff;opacity:.5;}
.rkl-live.rkl-zero .rkl-dot{background:#aaa;box-shadow:none;animation:none;}
@keyframes rkl-pulse{50%{opacity:.35;}}
.rkl-list{display:flex;flex-direction:column;gap:6px;overflow:auto;padding:3px;margin:-3px;min-height:120px;max-height:min(300px,calc(100vh - 330px));}
.rkl-lob{flex:none;display:flex;align-items:center;gap:10px;padding:5px 6px 5px 12px;border-radius:14px;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.12);}
.rkl-lob.rkl-new{animation:rkl-in .4s ease-out;}
@keyframes rkl-in{from{opacity:0;transform:translateY(6px);}}
.rkl-lt{flex:1;min-width:0;}
.rkl-lh,.rkl-ls{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkl-lh{font-weight:900;font-size:16px;}
.rkl-ls{font-weight:700;font-size:12px;opacity:.65;}
.rkl-lob.rkl-run .rkl-ls{color:#bfe8ff;opacity:.85;}
.rkl-lob.rkl-full{opacity:.6;}
.rkr-btn.rkl-mini{flex:none;justify-content:center;min-width:80px;min-height:40px;font-size:14px;padding:6px 14px 7px;border-radius:14px;border-width:3px;
  box-shadow:0 4px 0 #3a1650,0 6px 12px rgba(0,0,0,.3);white-space:nowrap;}
.rkr-btn.rkl-mini:hover,.rkr-btn.rkl-mini.rkr-sel{transform:translateY(-2px);box-shadow:0 6px 0 #3a1650,0 8px 14px rgba(0,0,0,.35),0 0 0 3px rgba(255,255,255,.35);}
.rkr-btn.rkl-mini:active{transform:translateY(3px);box-shadow:0 1px 0 #3a1650;}
.rkr-btn.rkl-mini:disabled{cursor:default;filter:grayscale(1);opacity:.7;transform:none;box-shadow:0 4px 0 #3a1650;}
.rkl-empty{margin:auto 0;padding:14px 8px;text-align:center;font-weight:700;line-height:1.4;opacity:.8;}
.rkl-empty b{color:#ffcf5a;white-space:nowrap;}
.rkl-coderow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;}
.rkl-codelab{font-size:13px;font-weight:800;opacity:.75;}
.rkl-in.rkl-code{width:96px;height:40px;box-sizing:border-box;padding:6px 8px;font-size:17px;text-align:center;text-transform:uppercase;letter-spacing:.2em;}
.rkl-modes{display:flex;flex-direction:column;gap:6px;}
.rkl-mode{display:flex;align-items:center;gap:10px;min-height:40px;padding:5px 12px;border-radius:12px;cursor:pointer;text-align:left;
  font:inherit;font-weight:900;font-size:15px;color:#fff;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.16);}
.rkl-mode::before{content:'';flex:none;width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.6);}
.rkl-mode:hover{background:rgba(255,255,255,.16);}
.rkl-mode.rkl-on{background:rgba(255,207,90,.2);border-color:#ffcf5a;color:#fff6d8;}
.rkl-mode.rkl-on::before{background:#ffcf5a;border-color:#fff6d8;}
.rkl-mode:focus:not(:focus-visible){outline:none;}
.rkl-mode[hidden]{display:none;}
.rkl-modetip{font-size:12px;font-weight:700;opacity:.7;line-height:1.3;min-height:31px;}
.rkl-diff{display:flex;gap:6px;margin-top:6px;}
.rkl-diff .rkl-mode{flex:1 1 0;justify-content:center;min-height:34px;}
.rkl-diff .rkl-mode.rkl-on{background:rgba(120,220,150,.22);border-color:#7fe0a0;color:#e6ffee;}
.rkl-diff .rkl-mode.rkl-on::before{background:#7fe0a0;border-color:#e6ffee;}
/* each choice its own colour: Normal gold, Easy green; chained Off grey, Pairs teal, Everyone pink */
.rkl-diff .rkl-mode.rkl-on[data-easy="0"]{background:rgba(255,207,90,.2);border-color:#ffcf5a;color:#fff6d8;}
.rkl-diff .rkl-mode.rkl-on[data-easy="0"]::before{background:#ffcf5a;border-color:#fff6d8;}
.rkl-diff .rkl-mode.rkl-on[data-chain="0"]{background:rgba(200,206,214,.16);border-color:#aab1ba;color:#eef1f4;}
.rkl-diff .rkl-mode.rkl-on[data-chain="0"]::before{background:#aab1ba;border-color:#eef1f4;}
.rkl-diff .rkl-mode.rkl-on[data-chain="1"]{background:rgba(90,225,205,.2);border-color:#5fe3d0;color:#e2fffa;}
.rkl-diff .rkl-mode.rkl-on[data-chain="1"]::before{background:#5fe3d0;border-color:#e2fffa;}
.rkl-diff .rkl-mode.rkl-on[data-chain="all"]{background:rgba(255,130,200,.2);border-color:#ff8fd0;color:#ffe8f5;}
.rkl-diff .rkl-mode.rkl-on[data-chain="all"]::before{background:#ff8fd0;border-color:#ffe8f5;}
/* the modes' own colours: Run only grass green, Skate only blue, Run + Skate fading from one to the other (on foot, then
   skates); Hell's Run / Skate from hell's red into theirs */
.rkl-modes .rkl-mode.rkl-on[data-mode="run"]{background:rgba(160,220,80,.2);border-color:#a8e05a;color:#f2ffe0;}
.rkl-modes .rkl-mode.rkl-on[data-mode="run"]::before{background:#a8e05a;border-color:#f2ffe0;}
.rkl-modes .rkl-mode.rkl-on[data-mode="ice"]{background:rgba(110,180,255,.22);border-color:#7cc0ff;color:#e6f3ff;}
.rkl-modes .rkl-mode.rkl-on[data-mode="ice"]::before{background:#7cc0ff;border-color:#e6f3ff;}
.rkl-modes .rkl-mode.rkl-on[data-mode="mixed"]{position:relative;border-color:transparent;color:#fff6d8;
  background:linear-gradient(90deg,rgba(160,220,80,.2),rgba(110,180,255,.22));}
.rkl-modes .rkl-mode.rkl-on[data-mode="mixed"]::before{background:#a8e05a;border-color:#fff6d8;}
/* (its border: a gold-to-blue ring drawn over the button, the inside cut out, so the fill stays see-through like the others) */
.rkl-modes .rkl-mode.rkl-on[data-mode="mixed"]::after,.rkl-hellkind .rkl-mode.rkl-on::after{content:'';position:absolute;inset:-2px;border-radius:12px;padding:2px;pointer-events:none;
  background:linear-gradient(90deg,#a8e05a,#7cc0ff);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;}
.rkl-hellkind .rkl-mode.rkl-on{position:relative;border-color:transparent;color:#ffe2d8;}
.rkl-hellkind .rkl-mode.rkl-on[data-kind="run"]{background:linear-gradient(90deg,rgba(255,80,40,.25),rgba(160,220,80,.2));}
.rkl-hellkind .rkl-mode.rkl-on[data-kind="run"]::after{background:linear-gradient(90deg,#ff6a3d,#a8e05a);}
.rkl-hellkind .rkl-mode.rkl-on[data-kind="ice"]{background:linear-gradient(90deg,rgba(255,80,40,.25),rgba(110,180,255,.22));}
.rkl-hellkind .rkl-mode.rkl-on[data-kind="ice"]::after{background:linear-gradient(90deg,#ff6a3d,#7cc0ff);}
.rkl-hellkind .rkl-mode.rkl-on::before{background:#ff6a3d;border-color:#ffe2d8;}
.rkl-mode.rkl-hell{color:#ffb3a0;}
.rkl-mode.rkl-hell.rkl-on{background:rgba(255,80,40,.25);border-color:#ff6a3d;color:#ffe2d8;}
.rkl-mode.rkl-hell.rkl-on::before{background:#ff6a3d;border-color:#ffe2d8;}
.rkl-hellkind{display:flex;gap:6px;margin-top:6px;align-items:center;}
.rkl-hellkind .rkl-mode{flex:1 1 0;justify-content:center;min-height:34px;}
.rkl-hellkind b{font-size:12px;font-weight:900;letter-spacing:.08em;color:#ffb3a0;}
.rkl-hellkind[hidden]{display:none;}
.rkl-opt{display:flex;align-items:center;gap:8px;font-weight:800;font-size:14px;min-height:36px;}
.rkl-optlab{white-space:nowrap;}
.rkl-step{width:32px;height:32px;padding:0;border-radius:10px;cursor:pointer;font:inherit;font-weight:900;font-size:18px;color:#fff;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.22);}
.rkl-step:hover:not(:disabled){border-color:#ffcf5a;}
.rkl-step:disabled{opacity:.35;cursor:default;}
.rkl-num{min-width:26px;text-align:center;font-weight:900;font-size:17px;}
.rkl-priv{cursor:pointer;}
.rkl-priv input[type=checkbox]{width:18px;height:18px;accent-color:#ffcf5a;cursor:pointer;}
.rkl-in.rkl-pass{width:120px;height:34px;box-sizing:border-box;padding:4px 10px;font-size:15px;}
.rkl-coderow .rkl-in.rkl-pass{display:none;width:110px;height:40px;}
.rkl-coderow .rkl-in.rkl-pass.rkl-show{display:block;}
.rkr-btn.rkl-create{margin-top:auto;font-size:19px;padding:9px 18px 11px;border-radius:18px;}
.rkr-glass.rkl-lbox{max-width:640px;}
.rkl-localcol .rkl-modes{flex-direction:row;flex-wrap:wrap;}
.rkl-who{flex-direction:row;flex-wrap:wrap;}
.rkl-who .rkl-mode{flex:1 1 auto;justify-content:center;}
.rkl-localcol .rkl-mode{flex:1 1 auto;}
.rkl-localcol .rkl-modetip{min-height:0;}
.rkl-localcol .rkr-btn.rkl-create{align-self:center;min-width:220px;justify-content:center;}
.rkl-bbox .rkl-err{min-height:0;font-size:13px;}
.rkl-bbox .rkl-err:empty{display:none;}
@media (max-width:560px){
  .rkl-cols{flex-direction:column;}
  .rkl-list{max-height:none;min-height:0;}
  .rkl-hsub{display:none;}
}
@media (max-height:500px){
  .rkr-glass.rkl-bbox{gap:7px;padding:6px 14px 6px;}
  .rkl-bbox h2{font-size:24px!important;}
  .rkl-back{width:40px;height:40px;font-size:20px;}
  .rkl-you{padding:0 8px;border:0;box-shadow:inset 0 0 0 2px rgba(255,255,255,.14);}
  .rkl-youcat{width:26px;height:26px;}
  .rkl-cols{gap:8px;}
  .rkl-col{padding:5px 10px 6px;gap:5px;}
  .rkr-overlay.rkl-ov{padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom));}
  .rkl-in.rkl-name{width:120px;}
  .rkl-you .rkcr-b{width:30px;}
  .rkl-list{min-height:80px;max-height:calc(100vh - 222px);}
  .rkl-joincol:has(.rkl-err:not(:empty)) .rkl-list{max-height:calc(100vh - 242px);}
  .rkl-modes{gap:4px;}
  .rkl-modetip{min-height:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .rkr-btn.rkl-create{font-size:16px;padding:5px 14px 6px;min-height:40px;justify-content:center;}
}
`;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

function createLobbyUI(root, cb) {
  if (!document.getElementById('rkl-style')) {
    const s = document.createElement('style');
    s.id = 'rkl-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  let node = null;
  let view = null; // 'browser' | 'room'
  let errEl = null;
  let roomRefs = null;
  let br = null; // lobby browser refs
  let refreshT = 0;

  // the last mode picked (single player, co-op or a new lobby: one memory for all three); Run + Skate until one is picked
  function savedMode() {
    try { const m = localStorage.getItem('rkr-mode'); return MODES.some((x) => x.id === m) || m === 'hell' ? m : 'mixed'; } catch { return 'mixed'; }
  }
  function saveMode(m) {
    try { localStorage.setItem('rkr-mode', m); } catch { /* ignore */ }
  }
  // normal or easy (remembered like the mode)
  function savedEasy() { try { return localStorage.getItem('rkr-easy') === '1'; } catch { return false; } }
  function saveEasy(v) { try { localStorage.setItem('rkr-easy', v ? '1' : '0'); } catch { /* ignore */ } }
  // chained or not ('0' off, '1' in pairs, 'all' everyone on one chain): one choice for every mode, remembered
  function savedChain() { try { const v = localStorage.getItem('rkr-chain'); return v === '1' || v === 'all' ? v : '0'; } catch { return '0'; } }
  function saveChain(v) { try { localStorage.setItem('rkr-chain', v); } catch { /* ignore */ } }
  function savedVersus() { try { return localStorage.getItem('rkr-versus') === '1'; } catch { return false; } }
  function saveVersus(v) { try { localStorage.setItem('rkr-versus', v ? '1' : '0'); } catch { /* ignore */ } }
  // Hell, the 4th mode (once it's open: cb.hellOpen(mode)): its own Run / Skate choice, remembered like the mode
  function savedHellKind() { try { return localStorage.getItem('rkr-hellmode') === 'ice' ? 'ice' : 'run'; } catch { return 'run'; } }
  function saveHellKind(v) { try { localStorage.setItem('rkr-hellmode', v); } catch { /* ignore */ } }
  const hellAvail = (mode) => (mode === 'run' || mode === 'ice') && !!(cb.hellOpen && cb.hellOpen(mode));   // (no Run + Skate hell)

  function mount(inner, boxCls = '', ovCls = '') {
    clearInterval(refreshT);
    if (node) node.remove();
    node = el('div', 'rkr-overlay rkr-dim' + ovCls);
    const box = el('div', 'rkr-glass rkl-box' + boxCls);
    box.append(...inner);
    node.appendChild(box);
    // keep game keys (WASD, M, P) from firing while typing (Esc still bubbles: it means "back")
    node.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' && e.key !== 'Escape') e.stopPropagation(); });
    root.appendChild(node);
  }

  // Esc on the lobby browser / the local setup = back to the title, Enter on the local setup = START (unless a dialog
  // is on top of it)
  document.addEventListener('keydown', (e) => {
    const esc = e.key === 'Escape', enter = e.key === 'Enter' && view === 'local';
    if ((!esc && !enter) || (view !== 'browser' && view !== 'local') || !node || e.defaultPrevented) return;
    if (document.querySelector('.rkt-modal')) return;
    if (node.nextElementSibling && node.nextElementSibling.classList.contains('rkr-overlay')) return;
    e.preventDefault();
    if (enter) { e.stopPropagation(); localNav.go(); }   // the run has started: this Enter isn't the game's
    else if (view === 'local') localNav.back();
    else cb.onBack();
  });

  // The game mode as a list of radio buttons (Run + Skate, Run only, Skate only, and Hell once it's open, with its own
  // Run / Skate row) + a one-line tip, and under it NORMAL / EASY; the choices are remembered (savedMode, savedEasy,
  // savedHellKind), and under that ⛓ CHAINED (opts.chain: shown; OFF / ON, 'all': OFF / PAIRS / EVERYONE, online; one
  // choice for every mode, savedChain).
  // modes: the element to show (all the rows). get(): the game mode (Hell: its Run / Skate one).
  function modePicker(initial, opts = {}) {
    let mode = initial, easy = savedEasy(), kind = savedHellKind();
    // one button (⛓ Chained: Off / Pairs / Everyone, local: Off / On) that opens its choices in a row under it; while
    // chained is on the choices stay open
    const CHAIN_OPTS = opts.chain === 'all' ? [['0', 'Off'], ['1', 'Pairs'], ['all', 'Everyone']] : [['0', 'Off'], ['1', 'On']];
    const chainBox = el('div', 'rkl-chainbox');
    const chainBtn = el('button', 'rkl-mode rkl-chainbtn');
    chainBtn.type = 'button';
    chainBtn.setAttribute('aria-haspopup', 'true');
    const chainRow = el('div', 'rkl-diff rkl-chain');
    chainRow.setAttribute('role', 'radiogroup');
    let chainOpen = false;
    chainBtn.addEventListener('click', () => { if (chainNow() !== '0') return; chainOpen = !chainOpen; paint(); });   // (on: the choices stay open)
    chainBox.append(chainBtn, chainRow);
    if (!opts.chain) chainBox.style.display = 'none';   // (solo: no chain)
    const chainNow = () => { const v = opts.chain ? savedChain() : '0'; return v === 'all' && opts.chain !== 'all' ? '1' : v; };
    const vsBtn = el('button', 'rkl-mode rkl-vsbtn');
    vsBtn.type = 'button';
    if (!opts.versus) vsBtn.style.display = 'none';
    vsBtn.addEventListener('click', () => { saveVersus(!savedVersus()); paint(); });
    const vsOn = () => !!opts.versus && savedVersus();
    const anyHell = () => hellAvail('run') || hellAvail('ice');
    const kindOf = () => (hellAvail(kind) ? kind : hellAvail('run') ? 'run' : 'ice');
    const isHell = () => mode === 'hell' && anyHell();
    const box = el('div', 'rkl-modebox');
    const diff = el('div', 'rkl-diff');
    diff.setAttribute('role', 'radiogroup');
    const modes = el('div', 'rkl-modes');
    modes.setAttribute('role', 'radiogroup');
    const kinds = el('div', 'rkl-hellkind');
    kinds.setAttribute('role', 'radiogroup');
    kinds.appendChild(el('b', null, 'HELL'));
    const tip = el('div', 'rkl-modetip');
    const paint = () => {
      if (mode === 'hell' && !anyHell()) mode = 'mixed';
      for (const b of modes.children) {
        if (b.dataset.mode === 'hell') b.hidden = !anyHell();
        const on = b.dataset.mode === mode;
        b.classList.toggle('rkl-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      const h = isHell(), k = kindOf();
      kinds.hidden = !h;
      for (const b of kinds.querySelectorAll('.rkl-mode')) {
        b.hidden = !hellAvail(b.dataset.kind);
        const on = b.dataset.kind === k;
        b.classList.toggle('rkl-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      for (const b of diff.children) {
        const on = (b.dataset.easy === '1') === easy;
        b.classList.toggle('rkl-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      const cv = chainNow(), ch = cv !== '0';
      const shown = chainOpen || ch;
      chainBtn.textContent = '⛓ Chained: ' + CHAIN_OPTS.find((o) => o[0] === cv)[1] + (ch ? '' : shown ? ' ▴' : ' ▾');
      chainBtn.classList.toggle('rkl-on', ch);
      chainBtn.setAttribute('aria-expanded', String(shown));
      chainRow.style.display = shown ? '' : 'none';   // (.rkl-diff's display:flex beats [hidden])
      for (const b of chainRow.children) {
        const on = b.dataset.chain === cv;
        b.classList.toggle('rkl-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      const vs = vsOn(), ez = easy && !vs;
      vsBtn.textContent = '⚔ Versus: ' + (vs ? 'On' : 'Off');
      vsBtn.classList.toggle('rkl-on', vs);
      vsBtn.setAttribute('aria-pressed', String(vs));
      diff.style.display = vs ? 'none' : '';   // (versus: no easy game)
      tip.textContent = tip.title = (h ? (easy ? HELL_EASY_TIP : HELL_TIP) : ez ? EASY_TIP : MODES.find((m) => m.id === mode).tip) + (vs ? VERSUS_TIP : '') + (cv === 'all' ? CHAIN_ALL_TIP : ch ? CHAIN_TIP : '');
    };
    const set = (id) => { mode = id; saveMode(mode); paint(); };
    for (const m of [...MODES, { id: 'hell', label: 'Hell' }]) {
      const b = el('button', 'rkl-mode' + (m.id === 'hell' ? ' rkl-hell' : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.textContent = m.label;
      b.dataset.mode = m.id;
      b.addEventListener('click', () => set(m.id));
      modes.appendChild(b);
    }
    for (const [v, label] of [['run', 'Run'], ['ice', 'Skate']]) {
      const b = el('button', 'rkl-mode rkl-hell');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.textContent = label;
      b.dataset.kind = v;
      b.addEventListener('click', () => { kind = v; saveHellKind(kind); paint(); });
      kinds.appendChild(b);
    }
    for (const [v, label] of [['0', 'Normal'], ['1', 'Easy']]) {
      const b = el('button', 'rkl-mode');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.textContent = label;
      b.dataset.easy = v;
      b.addEventListener('click', () => { easy = v === '1'; saveEasy(easy); paint(); });
      diff.appendChild(b);
    }
    for (const [v, label] of CHAIN_OPTS) {
      const b = el('button', 'rkl-mode');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.textContent = label;
      b.dataset.chain = v;
      b.addEventListener('click', () => { saveChain(v); chainOpen = false; paint(); });
      chainRow.appendChild(b);
    }
    box.append(modes, kinds, diff, chainBox, vsBtn);
    paint();
    return { modes: box, tip, get: () => (isHell() ? kindOf() : mode === 'hell' ? 'mixed' : mode), easy: () => easy && !vsOn(), hell: isHell, versus: vsOn,
      chain: () => (chainNow() === 'all' ? 'all' : chainNow() === '1'), repaint: paint };
  }

  // A kitty's row: its colour as a cat, name box (saved under nameKey as you type) + random name, colour swatches
  // (saved under colorKey; taken() greys out another local player's colour).
  function youRow({ label, nameKey, id, colorKey, taken = null, onColor = null }) {
    const youCat = el('span', 'rkl-youcat', CAT);
    const youLab = el('label', 'rkl-youlab');
    youLab.append(youCat, document.createTextNode(label));
    const name = el('input', 'rkl-in rkl-name');
    name.id = id;
    youLab.htmlFor = name.id;
    name.maxLength = 14;
    name.placeholder = PLAYER_NAMES[Math.floor(Math.random() * PLAYER_NAMES.length)];
    try { name.value = localStorage.getItem(nameKey) || ''; } catch { /* ignore */ }
    name.autocomplete = 'off';
    name.spellcheck = false;
    const save = (v) => { try { localStorage.setItem(nameKey, v); } catch { /* ignore */ } };
    name.addEventListener('input', () => save(name.value.trim()));
    const dice = el('button', 'rkl-dice', '🎲');
    dice.type = 'button';
    dice.title = 'Random name';
    dice.setAttribute('aria-label', 'Random name');
    dice.addEventListener('click', () => {
      const cur = name.value.trim();
      const pool = PLAYER_NAMES.filter((n) => n !== cur);
      name.value = pool[Math.floor(Math.random() * pool.length)];
      save(name.value);
    });
    const nameBox = el('div', 'rkl-namebox');
    nameBox.append(name, dice);
    const paintCat = () => {
      const p = prefColor(colorKey);
      youCat.classList.toggle('rkl-any', p < 0);
      youCat.style.color = p < 0 ? '' : hex(PLAYER_COLORS[p]);
    };
    paintCat();
    const colors = createColorRow(() => { paintCat(); if (onColor) onColor(); }, 8, { key: colorKey, taken });
    const row = el('div', 'rkl-you');
    row.append(youLab, nameBox, colors);
    const getName = () => { const n = name.value.trim(); save(n); return n; };
    return { el: row, getName, refresh: () => { paintCat(); colors.refresh(); } };
  }

  // Single player / local co-op setup: the online screen's name, colour and mode choices (one row per kitty), then
  // START. onStart({ mode, names }) (an empty name = the colour's own name, main.js); onBack() = back to the title.
  let localNav = null;
  function showLocal(n, opts) {
    const { onStart, onBack, mode: forced, coop = true, onPlayers = null } = opts;
    view = 'local';
    roomRefs = null;
    br = null;
    errEl = null;
    const back = el('button', 'rkl-back', '←');
    back.type = 'button';
    back.title = 'Back (Esc)';
    back.setAttribute('aria-label', 'Back');
    const goBack = () => { hide(); onBack(); };
    back.addEventListener('click', goBack);
    const h = el('h2', null, 'LOCAL');
    const hsub = el('div', 'rkl-hsub', n === 2 ? 'Player 1: mouse · Player 2: WASD or arrows' : 'A solo run');
    const head = el('div', 'rkl-head');
    head.append(back, h, hsub);
    // solo or co-op on this device (the same screen again with one or two player rows)
    const who = el('div', 'rkl-modes rkl-who');
    who.setAttribute('role', 'radiogroup');
    for (const [k, label] of [[1, 'Solo'], [2, 'Co-op (2 players)']]) {
      const b = el('button', 'rkl-mode' + (k === n ? ' rkl-on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(k === n));
      b.textContent = label;
      b.addEventListener('click', () => {
        if (k === n) return;
        if (onPlayers) onPlayers(k);
        hide();
        showLocal(k, { ...opts, mode: mp.hell() ? 'hell' : mp.get() });   // (Hell stays picked)
      });
      who.appendChild(b);
    }
    // co-op: one row per player, each greying out the colour the other one has
    const rows = [];
    const refreshAll = () => { for (const r of rows) r.refresh(); };
    rows.push(youRow({ label: n === 2 ? 'Player 1' : 'Your name', nameKey: 'rkr-name', id: 'rkl-lname1',
      taken: n === 2 ? () => prefColor(P2_COLOR_KEY) : null, onColor: refreshAll }));
    if (n === 2) rows.push(youRow({ label: 'Player 2', nameKey: 'rkr-name2', id: 'rkl-lname2', colorKey: P2_COLOR_KEY,
      taken: () => prefColor(), onColor: refreshAll }));
    const mp = modePicker(forced || savedMode(), { chain: n > 1 });   // the same memory as online: the last mode picked anywhere (chained: two kitties)
    const start = el('button', 'rkr-btn rkl-create', '<span>START</span>');
    const go = () => { const names = rows.map((r) => r.getName()); hide(); onStart({ mode: mp.get(), names, players: n, easy: mp.easy(), hell: mp.hell(), chain: mp.chain() }); };
    start.addEventListener('click', go);
    const col = el('div', 'rkl-col rkl-localcol');
    col.append(el('div', 'rkl-ctitle', 'Mode'), mp.modes, mp.tip, start);
    mount([head, ...(coop ? [who] : []), ...rows.map((r) => r.el), col], ' rkl-bbox rkl-lbox', ' rkl-ov');
    // Enter in a name box starts too (inputs keep their keys to themselves, see mount)
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.stopPropagation(); go(); } });
    localNav = { go, back: goBack };   // (a controller moves through the screen like any menu: padnav.js)
  }

  function showBrowser() {
    view = 'browser';
    roomRefs = null;
    // header: back + title
    const back = el('button', 'rkl-back', '←');
    back.type = 'button';
    back.title = 'Back (Esc)';
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', () => cb.onBack());
    const h = el('h2', null, 'ONLINE');
    const hsub = el('div', 'rkl-hsub', 'Up to 32 kitties per lobby, public or private');
    const head = el('div', 'rkl-head');
    head.append(back, h, hsub);

    // you: name (always visible), random name, colour swatches (the colour goes with create / join, main.js)
    const me = youRow({ label: 'Your name', nameKey: 'rkr-name', id: 'rkl-name' });
    const you = me.el;
    const getName = me.getName;

    // left: join a game
    const live = el('span', 'rkl-live rkl-zero', '<span class="rkl-dot"></span><span></span>');
    const jt = el('div', 'rkl-ctitle', '<span>Join a game</span>');
    jt.appendChild(live);
    const list = el('div', 'rkl-list', '<div class="rkl-empty">Looking for lobbies…</div>');
    const code = el('input', 'rkl-in rkl-code');
    code.id = 'rkl-code';
    code.maxLength = 4;
    code.placeholder = 'CODE';
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.autocapitalize = 'characters';
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const codeLab = el('label', 'rkl-codelab', 'Got a code?');
    codeLab.htmlFor = code.id;
    const codeJoin = el('button', 'rkr-btn rkr-alt rkl-mini', 'JOIN');
    // a private lobby's password (shown once a private lobby is picked, or the server asks for it: askPassword)
    const pass = el('input', 'rkl-in rkl-pass');
    pass.id = 'rkl-pass';
    pass.type = 'password';
    pass.maxLength = 20;
    pass.placeholder = '🔒 password';
    pass.autocomplete = 'off';
    const doJoin = () => { if (code.value.trim()) { lastAct = 'join'; cb.onJoin(code.value.trim().toUpperCase(), getName(), pass.value.trim()); } };
    codeJoin.addEventListener('click', doJoin);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
    const codeRow = el('div', 'rkl-coderow');
    codeRow.append(codeLab, code, pass, codeJoin);
    const joinErr = el('div', 'rkl-err');
    const joinCol = el('div', 'rkl-col rkl-joincol');
    joinCol.append(jt, list, codeRow, joinErr);

    // right: start your own (mode remembered)
    const mp = modePicker(savedMode(), { chain: 'all', versus: true });
    // how many kitties may join (2..MAX_KITTIES, remembered)
    let max = MAX_KITTIES;
    try { const v = parseInt(localStorage.getItem('rkr-max') || '', 10); if (v >= 2 && v <= MAX_KITTIES) max = v; } catch { /* ignore */ }
    const sizeRow = el('div', 'rkl-opt');
    const minus = el('button', 'rkl-step', '−'), plus = el('button', 'rkl-step', '+'), num = el('span', 'rkl-num');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'Fewer players'); plus.setAttribute('aria-label', 'More players');
    const paintMax = () => {
      num.textContent = String(max);
      minus.disabled = max <= 2; plus.disabled = max >= MAX_KITTIES;
      try { localStorage.setItem('rkr-max', String(max)); } catch { /* ignore */ }
    };
    // one at a time up to 8, then fours up to the cap
    const step = (d) => { max = Math.max(2, Math.min(MAX_KITTIES, d > 0 ? (max < 8 ? max + 1 : max + 4) : (max <= 8 ? max - 1 : max - 4))); paintMax(); };
    minus.addEventListener('click', () => step(-1)); plus.addEventListener('click', () => step(1));
    paintMax();
    sizeRow.append(el('span', 'rkl-optlab', 'Max players'), minus, num, plus);
    // private: only people with the password get in (it's listed with a lock)
    const privRow = el('label', 'rkl-opt rkl-priv');
    const priv = el('input');
    priv.type = 'checkbox';
    const privPass = el('input', 'rkl-in rkl-pass');
    privPass.type = 'text';
    privPass.maxLength = 20;
    privPass.placeholder = 'password';
    privPass.autocomplete = 'off';
    privPass.spellcheck = false;
    const paintPriv = (focus) => { privPass.style.display = priv.checked ? '' : 'none'; if (priv.checked && focus) privPass.focus(); };
    priv.addEventListener('change', () => paintPriv(true));
    privRow.append(priv, el('span', 'rkl-optlab', '🔒 Private'), privPass);
    paintPriv(false);
    const create = el('button', 'rkr-btn rkl-create', '<span>CREATE LOBBY</span>');
    const createErr = el('div', 'rkl-err');
    create.addEventListener('click', () => {
      lastAct = 'create';
      const password = priv.checked ? privPass.value.trim() : '';
      if (priv.checked && !password) { createErr.textContent = 'Pick a password for your private lobby.'; privPass.focus(); return; }
      cb.onCreate(getName(), mp.get(), { max, password, easy: mp.easy(), hell: mp.hell(), chain: mp.chain(), versus: mp.versus() });
    });
    const newCol = el('div', 'rkl-col rkl-newcol');
    newCol.append(el('div', 'rkl-ctitle', 'Start your own'), mp.modes, mp.tip, sizeRow, privRow, create, createErr);

    const cols = el('div', 'rkl-cols');
    cols.append(joinCol, newCol);
    let lastAct = 'join';
    errEl = null;
    mount([head, you, cols], ' rkl-bbox', ' rkl-ov');
    br = { list, live, joinCol, newCol, create, getName, code, pass, rows: new Map(), errFor: () => (lastAct === 'create' ? [createErr, joinErr] : [joinErr, createErr]) };
    emphasize(0);
    cb.onRefresh();
    clearInterval(refreshT);
    refreshT = setInterval(() => cb.onRefresh(), 3000);
  }

  // one yellow primary at a time: the first joinable lobby's JOIN, or CREATE LOBBY when there's nothing to join
  function emphasize(joinable) {
    br.joinCol.classList.toggle('rkl-hot', joinable > 0);
    br.create.classList.toggle('rkr-alt', joinable > 0);
  }

  const lobbyRank = (l) => (l.players >= l.max ? 2 : l.phase === 'lobby' ? 0 : 1);

  // rows are kept per lobby code and updated in place, so refreshes don't flicker or drop hover / focus
  function setLobbies(list) {
    if (view !== 'browser' || !br) return;
    const sorted = [...list].sort((a, b) => lobbyRank(a) - lobbyRank(b) || b.players - a.players || (a.code < b.code ? -1 : 1));
    const seen = new Set();
    let joinable = 0;
    let first = true;
    for (const l of sorted) {
      seen.add(l.code);
      let r = br.rows.get(l.code);
      if (!r) {
        const row = el('div', 'rkl-lob rkl-new');
        const t = el('div', 'rkl-lt');
        const hh = el('div', 'rkl-lh');
        const sub = el('div', 'rkl-ls');
        t.append(hh, sub);
        const btn = el('button', 'rkr-btn rkl-mini');
        btn.type = 'button';
        const code = l.code;
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          if (br.rows.get(code).locked) askPassword(code);   // private: type its password, then JOIN
          else cb.onJoin(code, br.getName());
        });
        row.append(t, btn);
        row.addEventListener('animationend', () => row.classList.remove('rkl-new'), { once: true });
        r = { row, hh, sub, btn };
        br.rows.set(l.code, r);
      }
      const full = l.players >= l.max;
      const playing = l.phase !== 'lobby';
      const set = (e, v) => { if (e.textContent !== v) e.textContent = v; };
      r.locked = !!l.locked;
      set(r.hh, `${l.locked ? '🔒 ' : ''}${l.host}'s lobby`);
      set(r.sub, playing ? `${modeLabel(l.mode, l.easy, l.hell, l.chain, l.versus)} · playing level ${l.level} · ${l.players}/${l.max}`
        : `${modeLabel(l.mode, l.easy, l.hell, l.chain, l.versus)} · waiting · ${l.players}/${l.max}`);
      set(r.btn, full ? 'FULL' : playing ? 'HOP IN' : 'JOIN');
      r.row.title = `Code ${l.code}`;
      r.btn.disabled = full;
      r.row.classList.toggle('rkl-run', playing);
      r.row.classList.toggle('rkl-full', full);
      if (!full) joinable++;
      r.btn.classList.toggle('rkr-alt', !(first && !full));
      first = false;
    }
    for (const [c, r] of br.rows) if (!seen.has(c)) { r.row.remove(); br.rows.delete(c); }
    // order: only move nodes that are out of place (moving a focused node would blur it)
    const L = br.list;
    if (sorted.length) {
      const empty = L.querySelector('.rkl-empty');
      if (empty) empty.remove();
      sorted.forEach((l, i) => {
        const row = br.rows.get(l.code).row;
        if (L.children[i] !== row) L.insertBefore(row, L.children[i] || null);
      });
    } else if (!L.querySelector('.rkl-empty') || L.firstChild.dataset.k !== 'none') {
      L.textContent = '';
      const e = el('div', 'rkl-empty', 'Nobody\'s playing right now.<br>Start a lobby and invite your friends <b>→</b>');
      e.dataset.k = 'none';
      L.appendChild(e);
    }
    br.live.classList.toggle('rkl-zero', !sorted.length);
    br.live.lastChild.textContent = `${sorted.length} live`;
    emphasize(joinable);
  }

  function showRoom(info) {
    if (view !== 'room') {
      view = 'room';
      br = null;
      const h = el('h2', null, 'LOBBY');
      const code = el('div', 'rkl-bigcode');
      const roomMode = el('div', 'rkl-roommode');
      const link = el('div', 'rkl-link');
      // the host: CHANGE MODE opens the mode picker right here (mode, normal / easy, hell, chained, versus); APPLY changes
      // the lobby's game for everyone, no new lobby needed
      const modeBtn = el('button', 'rkr-btn rkr-alt rkl-mini rkl-clilac', '⚙ CHANGE MODE');
      modeBtn.type = 'button';
      const modeLine = el('div', 'rkl-modeline');
      modeLine.append(roomMode, modeBtn);
      const modeEdit = el('div', 'rkl-modeedit');
      modeEdit.hidden = true;
      modeEdit.style.display = 'none';
      const closeEdit = () => { modeEdit.textContent = ''; modeEdit.style.display = 'none'; modeEdit.hidden = true; modeBtn.textContent = '⚙ CHANGE MODE'; };
      modeBtn.addEventListener('click', () => {
        if (!modeEdit.hidden) { closeEdit(); return; }
        const cur = roomRefs.info;   // (the picker starts at the lobby's game)
        saveMode(cur.hell ? 'hell' : cur.mode); if (cur.hell) saveHellKind(cur.mode);
        saveEasy(!!cur.easy); saveChain(cur.chain === 'all' ? 'all' : cur.chain ? '1' : '0'); saveVersus(!!cur.versus);
        const mp = modePicker(savedMode(), { chain: 'all', versus: true });
        const apply = el('button', 'rkr-btn rkl-small', 'APPLY');
        const cancel = el('button', 'rkr-btn rkr-alt rkl-small', 'CANCEL');
        apply.type = cancel.type = 'button';
        apply.addEventListener('click', () => { if (cb.onSettings) cb.onSettings(mp.get(), { easy: mp.easy(), hell: mp.hell(), chain: mp.chain(), versus: mp.versus() }); closeEdit(); });
        cancel.addEventListener('click', closeEdit);
        const btns = el('div', 'rkl-row');
        btns.append(apply, cancel);
        modeEdit.append(mp.modes, mp.tip, btns);
        modeEdit.hidden = false; modeEdit.style.display = '';
        modeBtn.textContent = '⚙ CLOSE';
      });
      // INVITE FRIENDS opens the invite panel: the players you played with (invite the ones online), and the link
      const copy = el('button', 'rkr-btn rkr-alt rkl-invite rkl-cteal', '<span>INVITE FRIENDS</span><small>players you played with, or the link</small>');
      const recent = el('div', 'rkl-recent');
      recent.hidden = true;
      copy.addEventListener('click', () => {
        recent.hidden = !recent.hidden;
        if (!recent.hidden) { renderRecent(); if (cb.onRecentOpen) cb.onRecentOpen(); }
      });
      // share sheet in the app / on phones, clipboard on desktop
      const linkBtn = el('button', 'rkr-btn rkr-alt rkl-mini', 'SEND THE LINK');
      let copyT = 0;
      linkBtn.addEventListener('click', async () => {
        if (!roomRefs) return;
        const c = roomRefs.code.textContent;
        // a private lobby's link carries its password, so friends get straight in
        const res = await share({ title: 'Project: Run Kitty Run', text: `Join my Project: Run Kitty Run lobby! Code ${c}`, url: inviteUrl(c, roomRefs.pass) });
        if (res !== 'copied' && res !== 'failed') return;
        linkBtn.textContent = res === 'copied' ? 'LINK COPIED!' : 'COPY FAILED';
        clearTimeout(copyT);
        copyT = setTimeout(() => { linkBtn.textContent = 'SEND THE LINK'; }, 1400);
      });
      const rlist = el('div', 'rkl-rlist');
      const linkRow = el('div', 'rkl-row');
      linkRow.append(linkBtn);
      recent.append(el('div', 'rkl-rh', 'FRIENDS & PLAYERS YOU PLAYED WITH'), rlist, el('div', 'rkl-rtip', '★ a player to keep them as a friend: friends stay on the list.'), linkRow);
      const slots = el('div', 'rkl-slots');
      const wait = el('div', 'rkl-wait');
      const start = el('button', 'rkr-btn', '<span>START GAME</span>');
      start.addEventListener('click', () => cb.onStart());
      errEl = el('div', 'rkl-err');
      // versus: the host looks for other teams to play against (the server puts searching lobbies together)
      const search = el('button', 'rkr-btn rkr-alt rkl-small rkl-search rkl-cpeach', '🔍 FIND OPPONENTS');
      search.addEventListener('click', () => cb.onTeam && cb.onTeam({ act: 'search' }));
      // ...under it, the switch to search in any mode too (matched into another mode's lobby or game, it plays that mode)
      const searchAny = el('button', 'rkr-btn rkr-alt rkl-small rkl-cswitch');
      searchAny.type = 'button';
      searchAny.addEventListener('click', () => cb.onTeam && cb.onTeam({ act: 'any' }));
      // ...and versus on / off (only versus lobbies are matched with versus ones; on: everyone a team of their own)
      const versusBtn = el('button', 'rkr-btn rkr-alt rkl-small rkl-cswitch');
      versusBtn.type = 'button';
      versusBtn.addEventListener('click', () => cb.onTeam && cb.onTeam({ act: 'versus' }));
      const searchBox = el('div', 'rkl-searchbox');
      searchBox.append(search, searchAny, versusBtn);
      const leave = el('button', 'rkr-btn rkr-alt rkl-small', 'LEAVE');
      leave.addEventListener('click', () => cb.onLeave());
      const row = el('div', 'rkl-row');
      row.append(copy);
      const row2 = el('div', 'rkl-row');
      row2.append(start, searchBox, leave);
      mount([h, code, modeLine, modeEdit, link, row, recent, slots, wait, row2, errEl]);
      roomRefs = { code, roomMode, modeBtn, modeEdit, closeEdit, link, slots, wait, start, search, searchBox, searchAny, versusBtn, recent, rlist };
    }
    const r = roomRefs;
    r.code.textContent = info.code;
    r.roomMode.textContent = `Mode: ${modeLabel(info.mode, info.easy, info.hell, info.chain, info.versus)} · up to ${info.max || MAX_KITTIES} kitties` + (info.locked ? ` · 🔒 private, password: ${info.pass || '?'}` : '');
    r.pass = info.locked ? info.pass || '' : '';
    r.link.textContent = inviteUrl(info.code, r.pass);
    // (versus: a team name being typed in survives the redraw)
    const typing = document.activeElement && document.activeElement.classList.contains('rkl-tin') && r.slots.contains(document.activeElement) ? document.activeElement.value : null;
    r.slots.textContent = '';
    r.slots.classList.toggle('rkl-teams', !!info.versus);
    r.fids = new Set(info.members.map((m) => m.fid).filter(Boolean));
    renderRecent();
    // everyone in the lobby + one open slot (up to info.max); chained: in chain order, each kitty's chain numbered, and
    // (before the game) a click on someone on another chain chains you up with them (the server swaps them in)
    const max = info.max || 32;
    const members = info.chain && Array.isArray(info.order) ? info.order.map((id) => info.members.find((m) => m.id === id)).filter(Boolean) : info.members;
    const chainNo = new Map();
    if (info.chain === 'all') members.forEach((m, k) => chainNo.set(m.id, k + 1));   // (everyone: its place along the chain)
    else if (info.chain && info.versus) {   // (versus: chains inside each team, numbered across them)
      let g = 1;
      for (const t of info.teams || []) {
        const tm = members.filter((m) => (info.mt || {})[m.id] === t.id);
        for (let i = 0; i < tm.length; g++) { const n = tm.length - i === 3 ? 3 : 2; for (let k = i; k < i + n && k < tm.length; k++) chainNo.set(tm[k].id, g); i += n; }
      }
    } else if (info.chain) for (let i = 0, g = 1; i < members.length; g++) { const n = members.length - i === 3 ? 3 : 2; for (let k = i; k < i + n && k < members.length; k++) chainNo.set(members[k].id, g); i += n; }
    const myChain = chainNo.get(info.you);
    const slotFor = (m, i) => {
      const s = el('div', 'rkl-slot' + (m ? '' : ' rkl-open') + (m && m.id === info.you ? ' rkl-me' : ''));
      const mi = members.findIndex((x) => x.id === info.you);
      const pickable = (!info.versus || (m && (info.mt || {})[m.id] === (info.mt || {})[info.you])) && (info.chain === 'all' ? Math.abs(i - mi) > 1 : chainNo.get(m && m.id) !== myChain);   // (everyone: not already next to you; versus: your team only)
      if (m && info.chain && info.phase === 'lobby' && m.id !== info.you && pickable && cb.onChainWith) {
        s.classList.add('rkl-chainpick');
        s.title = info.chain === 'all' ? 'Have ' + m.name + ' next to you on the chain' : 'Chain up with ' + m.name;
        s.addEventListener('click', () => cb.onChainWith(m.id));
      }
      const cat = el('div', 'rkl-cat', CAT);
      cat.style.color = m ? hex(m.color) : '#888';
      const who = el('div', 'rkl-pinfo');
      const pn = el('span', 'rkl-pn');
      pn.textContent = m ? m.name : 'open';
      who.appendChild(pn);
      // under the name: (you), its chain and the swag number
      if (m && (m.id === info.you || m.paid > 0 || chainNo.has(m.id))) {
        const sub = el('div', 'rkl-psub');
        if (m.id === info.you) sub.appendChild(el('span', 'rkl-you', '(you)'));
        if (chainNo.has(m.id)) sub.appendChild(el('span', 'rkl-chainno', '⛓ ' + chainNo.get(m.id)));
        if (m.paid > 0) sub.appendChild(el('span', 'rkl-paid', fmtNum(m.paid)));
        who.appendChild(sub);
      }
      s.append(cat, who);
      // which platform (🌐 browser, 🍎 iPhone / iPad, 🤖 Android) and the host's crown: on the cat icon
      if (m && PLAT[m.app]) {
        const b = el('span', 'rkl-plat');
        b.textContent = PLAT[m.app][0];
        b.title = PLAT[m.app][1];
        cat.appendChild(b);
      }
      if (m && m.id === info.host) cat.appendChild(el('div', 'rkl-crown', CROWN));
      return s;
    };
    if (info.versus) renderTeams(info, members, slotFor, typing);
    else for (let i = 0; i < Math.min(max, members.length + 1); i++) r.slots.appendChild(slotFor(members[i], i));
    const isHost = info.host === info.you;
    const host = info.members.find((m) => m.id === info.host);
    r.start.style.display = isHost && info.phase === 'lobby' ? '' : 'none';
    // (the host, any lobby: look for players (versus: opponents), in any mode too, versus on / off)
    r.searchBox.style.display = isHost && info.phase === 'lobby' ? '' : 'none';
    r.info = info;
    r.modeBtn.style.display = isHost && info.phase === 'lobby' && cb.onSettings ? '' : 'none';
    if (!(isHost && info.phase === 'lobby') && !r.modeEdit.hidden) r.closeEdit();   // (not the host any more, or the game started)
    const any = !!info.anyMode, vs = !!info.versus;
    r.search.textContent = info.search ? '🔍 SEARCHING… (stop)' : vs ? '🔍 FIND OPPONENTS' : '🔍 FIND PLAYERS';
    r.search.classList.toggle('rkr-alt', !info.search);   // (green while searching, as ANY MODE while on)
    r.search.classList.toggle('rkr-set', !!info.search);
    const who = vs ? 'other teams' : 'other players';
    r.search.title = info.search ? `Looking for ${who}${any ? ' in any mode' : ' in this mode'}: a lobby that searches too comes in, or you join a game in progress. Click to stop` : `Look for ${who} to play with${any ? ' in any mode' : ' in this mode'} (other lobbies searching, or games in progress)`;
    r.searchAny.textContent = any ? '🌐 ANY MODE: ON' : '🌐 ANY MODE: OFF';
    r.searchAny.classList.toggle('rkr-alt', !any);
    r.searchAny.classList.toggle('rkr-set', any);
    r.searchAny.setAttribute('aria-pressed', String(any));
    r.searchAny.title = 'Also match with lobbies and games of other modes (you then play their mode; a group searching only its own mode keeps it)';
    r.versusBtn.textContent = vs ? '⚔ VERSUS: ON' : '⚔ VERSUS: OFF';
    r.versusBtn.classList.toggle('rkr-alt', !vs);
    r.versusBtn.classList.toggle('rkr-set', vs);
    r.versusBtn.setAttribute('aria-pressed', String(vs));
    r.versusBtn.title = vs ? 'Teams against each other: you are matched with versus lobbies and games only. Click to play together instead' : 'Play together: you are matched with lobbies and games that are not versus. Click to play teams against each other';
    r.wait.textContent = (info.phase !== 'lobby'
      ? 'A run is in progress. Joining…'
      : isHost ? (info.versus && new Set(Object.values(info.mt || {})).size < 2 ? 'Versus needs at least two teams: someone has to make a new team.'
        : info.versus && info.chain && Object.values(info.mt || {}).some((t, _, all) => all.filter((x) => x === t).length === 1) ? 'Chained versus: every team needs at least two kitties to start (a kitty on its own would have no chain).'
        : info.search && !info.versus ? `Searching for players${info.search === 'any' ? ' in any mode' : ''}… You're the host: start whenever you like.`
        : info.versus && info.search ? `Searching for opponents${info.search === 'any' ? ' in any mode' : ''}… ${(info.teams || []).filter((t) => t.ready).length} of ${(info.teams || []).length} teams ready.`
        : info.versus ? `You're the host. ${(info.teams || []).filter((t) => t.ready).length} of ${(info.teams || []).length} teams ready - start whenever you like (${info.members.length}/${max}).`
        : info.chain && info.members.length < 2 ? 'A chained game needs at least two kitties.' : `You're the host. Start whenever you're ready (${info.members.length}/${max}).`)
        : (info.search ? `Searching for ${info.versus ? 'opponents' : 'players'}${info.search === 'any' ? ' in any mode' : ''}… ` : '') + `Waiting for ${host ? host.name : 'the host'} to start…`) + (info.chain && info.phase === 'lobby' && info.members.length > 2 ? (info.chain === 'all' ? ' Click a kitty to have them next to you on the chain.' : ' Click a kitty to chain up with them.') : '');
  }

  // versus: a box a team, its name (yours: type to rename it, sent when you're done), its kitties, JOIN on the others
  // (JOIN asks; someone in it accepts; up to TEAM_MAX), NEW TEAM under yours when you're not on your own, and who asks to
  // join yours (ACCEPT / decline)
  const TEAM_MAX = 5;   // (server/index.js TEAM_MAX)
  function renderTeams(info, members, slotFor, typing) {
    const r = roomRefs, mt = info.mt || {}, mineT = mt[info.you], lobby = info.phase === 'lobby';
    for (const t of info.teams || []) {
      const tm = members.filter((m) => mt[m.id] === t.id);
      if (!tm.length) continue;
      const mine = t.id === mineT;
      const box = el('div', 'rkl-team' + (mine ? ' rkl-myteam' : '') + (t.ready ? ' rkl-tready' : ''));
      const head = el('div', 'rkl-thead');
      if (mine && lobby) {
        const inp = el('input', 'rkl-in rkl-tin');
        inp.maxLength = 20; inp.value = typing != null ? typing : t.name; inp.placeholder = 'Team name';
        inp.setAttribute('aria-label', 'Your team name');
        const sendName = () => { const v = inp.value.trim(); if (v && v !== t.name) cb.onTeam({ act: 'name', name: v }); };
        inp.addEventListener('change', sendName);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
        head.appendChild(inp);
        if (typing != null) setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 0);
      } else {
        const n = el('span', 'rkl-tname');
        n.textContent = t.name;
        head.appendChild(n);
      }
      head.appendChild(el('span', 'rkl-tn', tm.length + '/' + TEAM_MAX));
      if (t.ready && !(mine && lobby)) head.appendChild(el('span', 'rkl-tok', '✓ READY'));
      if (mine && lobby && cb.onTeam) {   // (the team is set to go: everyone sees it)
        const rb = el('button', 'rkr-btn rkl-tbtn' + (t.ready ? ' rkl-rdy' : ' rkr-alt'), t.ready ? '✓ READY' : 'READY');
        rb.title = t.ready ? 'Your team is set to go. Click to take it back' : 'Tell everyone your team is set to go';
        rb.addEventListener('click', () => cb.onTeam({ act: 'ready' }));
        head.appendChild(rb);
      }
      if (!mine && lobby && tm.length < TEAM_MAX && cb.onTeam) {
        const asked = (t.req || []).includes(info.you);
        const j = el('button', 'rkr-btn rkr-alt rkl-tbtn', asked ? 'ASKED ✕' : 'JOIN');
        j.title = asked ? 'Waiting for someone in the team to accept. Click to take it back' : 'Ask to join this team (someone in it accepts)';
        j.addEventListener('click', () => cb.onTeam({ act: asked ? 'unask' : 'join', id: t.id }));
        head.appendChild(j);
      }
      if (mine && lobby && tm.length > 1 && cb.onTeam) {
        const nb = el('button', 'rkr-btn rkr-alt rkl-tbtn', 'NEW TEAM');
        nb.title = 'Leave this team and make one of your own';
        nb.addEventListener('click', () => cb.onTeam({ act: 'new' }));
        head.appendChild(nb);
      }
      const grid = el('div', 'rkl-tslots');
      for (const m of tm) grid.appendChild(slotFor(m, members.indexOf(m)));
      box.append(head, grid);
      // yours: who asks to join (ACCEPT / ✕)
      if (mine && lobby && cb.onTeam) for (const id of t.req || []) {
        const who = info.members.find((m) => m.id === id);
        if (!who) continue;
        const row = el('div', 'rkl-treq');
        const n = el('span');
        n.textContent = who.name + ' asks to join';
        n.style.color = hex(who.color);
        const ok = el('button', 'rkr-btn rkl-tbtn', 'ACCEPT');
        ok.addEventListener('click', () => cb.onTeam({ act: 'accept', id }));
        const no = el('button', 'rkr-btn rkr-alt rkl-tbtn', '✕');
        no.title = 'Decline';
        no.addEventListener('click', () => cb.onTeam({ act: 'decline', id }));
        row.append(n, ok, no);
        box.appendChild(row);
      }
      r.slots.appendChild(box);
    }
  }

  // ---- the invite panel (main.js keeps the list: cb.recent() -> [{ fid, name, color, fav? }], newest first) ----
  let seen = new Map();          // fid -> 'online' | 'lobby' | 'playing' (what the server said last; missing: offline)
  const results = new Map();     // fid -> { ok, msg, until } (the answer to an invite, shown for a moment)
  const ST = { online: ['Online', 'rkl-on'], lobby: ['In a lobby', 'rkl-on'], playing: ['In a game', 'rkl-busy'] };
  function recentOpen() { return view === 'room' && !!roomRefs && !!roomRefs.recent && !roomRefs.recent.hidden; }
  function renderRecent() {
    if (!recentOpen()) return;
    const list = (cb.recent ? cb.recent() : []).filter((p) => !(roomRefs.fids && roomRefs.fids.has(p.fid)));   // (not the ones already here)
    const box = roomRefs.rlist;
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'rkl-rnote', 'The players you play Multiplayer games with show up here, so you can invite them next time.')); return; }
    // friends (starred) first, online ones first, then the most recent
    const rank = (p) => (p.fav ? 0 : 3) + (seen.get(p.fid) === 'online' || seen.get(p.fid) === 'lobby' ? 0 : seen.get(p.fid) === 'playing' ? 1 : 2);
    const sorted = list.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    const now = performance.now();
    for (const p of sorted) {
      const row = el('div', 'rkl-rrow');
      const cat = el('div', 'rkl-cat', CAT);
      cat.style.color = hex(p.color);
      const name = el('span', 'rkl-rname');
      name.textContent = p.name;
      const stv = seen.get(p.fid), st = ST[stv] || ['Offline', ''];
      const stEl = el('span', 'rkl-rst ' + st[1], '<i></i>');
      stEl.append(st[0]);
      const star = el('button', 'rkl-star' + (p.fav ? ' rkl-fav' : ''), p.fav ? '★' : '☆');
      star.title = p.fav ? 'Friend (stays on the list): click to unstar' : 'Keep as a friend';
      star.addEventListener('click', () => {
        if (cb.onFriend && cb.onFriend(p.fid) === false) { inviteResult(p.fid, false, `Friends list is full (${cb.friendsMax || 50})`); return; }
        renderRecent();
      });
      row.append(star, cat, name);
      const res = results.get(p.fid);
      if (res && res.until > now) {
        const r = el('span', 'rkl-rres' + (res.ok ? '' : ' rkl-bad'));
        r.textContent = res.msg;
        row.appendChild(r);
      } else row.appendChild(stEl);
      const inv = el('button', 'rkr-btn rkl-mini', 'INVITE');
      inv.disabled = stv !== 'online' && stv !== 'lobby';
      inv.addEventListener('click', () => { inv.disabled = true; if (cb.onInvite) cb.onInvite(p.fid); });
      row.appendChild(inv);
      box.appendChild(row);
    }
  }
  // the server's answer to 'seen': [{ fid, st }]
  function setSeen(list) {
    seen = new Map((list || []).map((x) => [x.fid, x.st]));
    renderRecent();
  }
  // the server's answer to an invite
  function inviteResult(fid, ok, msg) {
    results.set(fid, { ok, msg: msg || (ok ? 'Invite sent!' : 'Could not invite'), until: performance.now() + 3000 });
    renderRecent();
    setTimeout(renderRecent, 3100);
  }

  // a private lobby: fill in its code and ask for the password in the "Got a code?" row
  function askPassword(code) {
    if (view !== 'browser' || !br) return;
    br.code.value = code;
    br.pass.classList.add('rkl-show');
    br.pass.focus();
  }

  function showError(msg) {
    let target = errEl;
    if (view === 'browser' && br) {
      const [near, other] = br.errFor(); // under the action that was tried last (join or create)
      other.textContent = '';
      target = near;
    }
    if (!target) return;
    target.textContent = msg;
    // short landscape phones: the panel scrolls, so make sure the message is actually on screen
    if (msg && target.scrollIntoView) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hide() {
    clearInterval(refreshT);
    if (node) node.remove();
    node = null;
    view = null;
    errEl = null;
    br = null;
    roomRefs = null;
    localNav = null;
  }

  return { showBrowser, setLobbies, showRoom, showLocal, askPassword, showError, hide, isOpen: () => !!node, view: () => view, root: () => node,
    recentOpen, setSeen, inviteResult };
}

export { createLobbyUI };
