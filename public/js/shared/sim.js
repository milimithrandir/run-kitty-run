import { CFG, LATEST_FV, ICE_TURN_FV, SKATE_FINAL_LEVEL, HELL_LEVELS, HELL_MODES, stageOf } from './config.js';
import { hashSeed } from './rng.js';
import { generateLevel, collideCircle, inCenter, onIce, inTree, pathProgress, pathTrack } from './maze.js';
import { createEnemies, updateEnemies } from './enemies.js';
import { hellWaves, waveHit } from './waves.js';

// Deterministic game simulation core. Pure: no THREE, no DOM, no Math.random, no Date.
// stepSim is the only mutator. All state lives in the Sim object (plain data).
//
// Interpretations / extra fields (beyond CONTRACTS.md):
// - sim.started (bool): false until the first stepSim, which emits levelStart.
// - sim.enteredCenter: array of playerIds that already emitted enterCenter this level.
// - inCenter = in the goal disc right now: safe from wolves while inside, free to run back out (only the final run's
//   victory party is kept in it). The level clears when a kitty touches the crown over its middle (so the first one
//   home can wait for the others, or run out again to help).
// - On level transition, shield is reset to 0 silently (no shieldEnd event).
// - Spawn index = player index modulo spawnPoints.length (small offset if more players than points).
// - Pickup 'life' when lives are already at MAX_EXTRA_LIVES is left on the ground.
// - Game over only triggers if there is at least one player in the sim.
// - Velocity component pointing into a wall is removed after collision (smooth sliding).
// - Extra exports: addPlayer, removePlayer.


// Lobby game modes: running + skating (ice level 2), running only, skating only.
const GAME_MODES = ['mixed', 'run', 'ice'];

const MAX_SUBSTEP_DISP = 0.25;
const MAX_SUBSTEPS = 64;
// Chained kitties (sim.chain): the kitties are chained up in groups (sim.chains: lists of player ids; two each, the last
// three when there's an odd number: chainGroups), each next to the next on a chain CHAIN_LEN long (centre to centre).
// From CHAIN_SOFT on it stretches and pulls back, harder the further it's stretched: at CHAIN_SOFT it takes nothing off a
// kitty running away, at CHAIN_LEN all of it. Pulled back, the one running away gets held back and the other dragged
// after it: of the way back the dragged kitty covers CHAIN_DRAG (at full stretch the pair moves on at that share of the
// runner's speed); two kitties pulling apart split it by how hard each pulls.
// A pair further apart than the chain (a checkpoint) is reeled in at most CHAIN_REEL kitty speeds. A downed kitty stays
// chained where it went down (its revive circle) and doesn't move: its partner can't get further away than the chain.
// One that leaves the game (chainLeave, the server): off the end of a chain that still has two kitties it just goes; else
// (in the middle, or one of a pair) it leaves an anchor where it was (sim.anchors), held like a downed kitty, until it's
// back in time (chainRejoin, there) or a kitty of its chain touches the spot (CHAIN_TOUCH, like a revive circle: chainPull
// lets it go and the chain joins up between the kitties still there) - but only while two of its kitties are still in the
// game: one left on its own stays held (no running about alone and having friends join later) until the next kitty to
// join takes the place that was left, right there (chainJoin). Other newcomers join at the end.
const CHAIN_SOFT = 4.9, CHAIN_LEN = 7.35, CHAIN_DRAG = 0.3, CHAIN_REEL = 1.5;
const CHAIN_TOUCH = CFG.REVIVE_RADIUS + CFG.KITTY_RADIUS;   // (an anchor's spot: touched like a revive circle)
// a skater being towed (not steering itself) builds up speed at this share of the ice's usual rate
const CHAIN_TOW_ACCEL = 0.35;
// ids in chain order -> the chains: two each, the last three when there's an odd number (one alone: a chain of one);
// all: everyone on one chain
function chainGroups(ids, all = false) {
  if (all) return ids.length ? [ids.slice()] : [];
  const out = [];
  for (let i = 0; i < ids.length;) { const n = ids.length - i === 3 ? 3 : 2; out.push(ids.slice(i, i + n)); i += n; }
  return out;
}
// every link of every chain: [a, b, aSide, bSide]: a and b a kitty or an anchor ({ x, z, alive: false }: someone who
// left); the sides: everyone on the chain on a's side of the link (a included) and on b's (chainPull: who pulls which way)
function chainLinks(sim) {
  const out = [];
  if (!sim.chain || !sim.chains) return out;
  const at = (id) => findPlayer(sim, id) || (sim.anchors && sim.anchors[id] ? { id, x: sim.anchors[id].x, z: sim.anchors[id].z, vx: 0, vz: 0, alive: false, anchor: true, drag: !!sim.anchors[id].drag } : null);
  for (const g of sim.chains) {
    const ks = g.map(at);
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = ks[i], b = ks[i + 1];
      if (a && b) out.push([a, b, ks.slice(0, i + 1).filter(Boolean), ks.slice(i + 1).filter(Boolean)]);
    }
  }
  return out;
}
function moveBy(sim, p, dx, dz) {
  const c = collideCircle(sim.levelData, p.x + dx, p.z + dz, CFG.KITTY_RADIUS);
  p.x = c.x; p.z = c.z;
}
function chainMomentum(sim, p, nx, nz, pulling, tow) {
  if (!p.alive || pulling > 0.3 || !onIce(sim.levelData, p.x, p.z)) return;
  p.towed = true;
  const v = p.vx * nx + p.vz * nz;
  if (v < tow) { p.vx += nx * (tow - v); p.vz += nz * (tow - v); }
}
// only: just that kitty moves (a client predicting its own kitty: the others are the server's)
// First the stretch (each link by how hard its two kitties pull apart), then, a few times over, any link left past
// CHAIN_LEN back to it: on a long chain each link sorting itself out pulls its neighbours' links out again, and without
// these passes a tug of war along the chain would stretch some links well past the chain (the more kitties pulling one
// way, the more the others get dragged: the passes share each fix by the same pull). Further past it than CHAIN_SNAP (a
// checkpoint) it's reeled in at CHAIN_REEL at most, once a tick.
const CHAIN_SNAP = 0.6, CHAIN_PASSES = 4;
function chainPull(sim, dt, only = null) {
  if (!only) for (const p of sim.players) p.towed = false;
  // a kitty of its chain at an anchor's spot, with two of the chain still in the game: let go (sim.chainRev: the server
  // tells everyone). Versus: not by a touch (its team picks it up: vsLeft)
  if (!only && !sim.versus) for (const id of Object.keys(sim.anchors)) {
    const an = sim.anchors[id], g = sim.chains.find((c) => c.includes(+id));
    if (g && g.filter((o) => findPlayer(sim, o)).length < 2) continue;
    if (g && !g.some((o) => { const q = findPlayer(sim, o); return q && q.alive && Math.hypot(q.x - an.x, q.z - an.z) < CHAIN_TOUCH; })) continue;
    chainRelease(sim, +id);
  }
  // (versus: a body dragged behind (anchor.drag: vsLeft) moves along like a kitty standing still)
  const moves = (p) => p.alive || p.drag;
  const links = chainLinks(sim).filter(([a, b]) => (moves(a) || moves(b)) && (!only || a === only || b === only));
  const may = (p) => (p.alive && (!only || p === only)) || !!p.drag;
  // a's share of the way back (a downed kitty, an anchor: none), from how hard each of the two pulls away along u
  const shareOf = (a, b, ux, uz) => {
    const pa = Math.max(0, -(a.vx * ux + a.vz * uz)), pb = Math.max(0, b.vx * ux + b.vz * uz);
    return [!moves(a) ? 0 : !moves(b) ? 1 : pa + pb > 1e-6 ? (CHAIN_DRAG * pb + (1 - CHAIN_DRAG) * pa) / (pa + pb) : 0.5, pa, pb];
  };
  // move a and b ex closer (a's share wa); one of them against a wall: the other takes what it couldn't
  const pull = (a, b, ux, uz, d, ex, wa) => {
    if (may(a)) moveBy(sim, a, ux * ex * wa, uz * ex * wa);
    if (may(b)) moveBy(sim, b, -ux * ex * (1 - wa), -uz * ex * (1 - wa));
    for (const p of [b, a]) {
      const ex2 = b.x - a.x, ez2 = b.z - a.z, d2 = Math.sqrt(ex2 * ex2 + ez2 * ez2), rest = d2 - (d - ex);
      if (!(rest > 1e-4) || !may(p)) continue;
      const k = (p === a ? rest : -rest) / d2;
      moveBy(sim, p, ex2 * k, ez2 * k);
    }
  };
  for (const [a, b] of links) {
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.sqrt(dx * dx + dz * dz);
    if (!(d > CHAIN_SOFT)) continue;
    const ux = dx / d, uz = dz / d, [wa, pa, pb] = shareOf(a, b, ux, uz);
    // stretching: undo that share of this tick's drifting apart (so the chain gets tighter and tighter but never jerks
    // to a stop)
    const ex = Math.min(Math.min(1, (d - CHAIN_SOFT) / (CHAIN_LEN - CHAIN_SOFT)) * (pa + pb) * dt, d - CHAIN_SOFT);
    if (!(ex > 1e-6)) continue;
    pull(a, b, ux, uz, d, ex, wa);
    // on ice a kitty being dragged (not pulling away itself) picks up the pull as speed toward its partner: the ice then
    // keeps it going, so it builds up momentum to full skating speed
    if (may(a)) chainMomentum(sim, a, ux, uz, pa, ex * wa / dt);
    if (may(b)) chainMomentum(sim, b, -ux, -uz, pb, ex * (1 - wa) / dt);
  }
  for (let pass = 0; pass < CHAIN_PASSES; pass++) {
    let moved = false;
    for (const [a, b] of links) {
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.sqrt(dx * dx + dz * dz), over = d - CHAIN_LEN;
      if (!(over > 1e-4)) continue;
      const ex = over <= CHAIN_SNAP ? over : pass === 0 ? Math.min(over, CHAIN_REEL * CFG.KITTY_SPEED * dt) : 0;
      if (!(ex > 0)) continue;
      const ux = dx / d, uz = dz / d;
      pull(a, b, ux, uz, d, ex, shareOf(a, b, ux, uz)[0]);
      moved = true;
    }
    if (!moved) break;
  }
  // (a dragged body: where it was pulled to; a client predicting its own kitty leaves that to the server)
  if (!only) for (const [a, b] of links) for (const e of [a, b]) if (e.drag && sim.anchors[e.id]) { sim.anchors[e.id].x = e.x; sim.anchors[e.id].z = e.z; }
}
// Versus (sim.versus): teams (p.team) against each other. A kitty only revives its own team (circles and checkpoints:
// a checkpoint gathers only the team of the kitty that reached it, and stays there for the other teams). A team takes the
// crown only once all of its kitties have been in the goal this level; that clears the level for everyone, as ever,
// and counts as one crown for the team (every kitty of it wears it and gets the win). A team's points (vsScore): 20 a
// map for how far its slowest kitty got on each level (the lowest p.runBest), 5 a crown, -1 a catch; no points for
// revives. sim.teams: id -> { dist (maps banked from the levels before), cur (this level's), crowns, deaths, revives }
const VS_MAP = 20, VS_CROWN = 5;
function vsTeam(sim, id) { return (sim.teams[id] ||= { dist: 0, cur: 0, crowns: 0, deaths: 0, revives: 0 }); }
const vsScore = (t) => Math.round(VS_MAP * ((t.dist || 0) + (t.cur || 0))) + VS_CROWN * (t.crowns || 0) - (t.deaths || 0);
const vsMates = (sim, p) => sim.players.filter((q) => q.team === p.team);
// this level's distance of each team: its slowest kitty's furthest along, one that has been in the goal the whole map
// (playing only; frozen once the level is over)
function vsTrack(sim) {
  if (!sim.versus || sim.state !== 'playing') return;
  const ld = sim.levelData, low = new Map();
  for (const p of sim.players) {
    const f = sim.enteredCenter.includes(p.id) ? 1 : p.runLd === ld ? Math.min(1, p.runBest || 0) : 0;
    low.set(p.team, Math.min(low.has(p.team) ? low.get(p.team) : Infinity, f));
  }
  // (one that left, not picked up yet: still holds its team back at how far it had got)
  for (const s of Object.values(sim.vsLeft)) if (!s.by && s.f != null && low.has(s.team)) low.set(s.team, Math.min(low.get(s.team), s.f));
  for (const [id, f] of low) vsTeam(sim, id).cur = f;
}
// Versus: a kitty leaving the game (before removePlayer; the server) counts as caught (if it was up), and with teammates
// still in the game it leaves a spot where it was (sim.vsLeft, drawn like a revive circle) that one of them has to pick
// up and carry into the goal (s.by: the carrier; caught, it drops it where it went down) before the team can take the
// crown: so a team can still finish without it, but no faster than with it. Back in time (vsReturn), it is with its
// team again: where its carrier is if it was being carried, else where it left (its spot; a new level since: at
// whichever of them is furthest behind).
function vsLeave(sim, id) {
  const p = findPlayer(sim, id);
  if (!sim.versus || !p) return;
  if (p.alive) vsTeam(sim, p.team).deaths++;
  for (const [k, s] of Object.entries(sim.vsLeft)) if (s.by === id) { s.by = 0; if (sim.anchors[k] && sim.anchors[k].drag) { sim.anchors[k].drag = false; sim.chainRev = (sim.chainRev | 0) + 1; } }   // (what it carried or dragged: dropped where it is)
  const f = sim.enteredCenter.includes(p.id) ? 1 : p.runLd === sim.levelData ? Math.min(1, p.runBest || 0) : 0;   // (how far it had got: vsTrack)
  if (sim.players.some((q) => q !== p && q.team === p.team)) { sim.vsLeft[id] = { x: p.x, z: p.z, team: p.team, color: p.color, by: 0, f }; sim.vsRev = (sim.vsRev | 0) + 1; }
  if (sim.anchors[id]) Object.assign(sim.anchors[id], { team: p.team, color: p.color });   // (chained: its ring knows whose it is: a new level puts its spot back)
}
// (true: it was being carried: it's back up where its carrier is, not down where it went down)
function vsReturn(sim, oldId, p) {
  if (!sim.versus) return false;
  const s = sim.vsLeft[oldId], carrier = s && s.by ? findPlayer(sim, s.by) : null;
  if (s) { delete sim.vsLeft[oldId]; sim.vsRev = (sim.vsRev | 0) + 1; }
  if (carrier && sim.chain && !sim.chains.some((c) => c.includes(p.id))) vsChainTo(sim, carrier.id, p.id);   // (chained: onto its carrier's chain, right after it)
  const ld = sim.levelData, far = (q) => (sim.enteredCenter.includes(q.id) ? 1 : q.runLd === ld ? q.runBest || 0 : 0);
  const mates = sim.players.filter((q) => q !== p && q.team === p.team), up = mates.filter((q) => q.alive);
  const last = carrier || (s ? null : (up.length ? up : mates).reduce((a, q) => (!a || far(q) < far(a) ? q : a), null));
  if (last) { p.x = last.x; p.z = last.z; p.vx = 0; p.vz = 0; p.heading = last.heading; p.runLd = null; }
  else if (s) { p.x = s.x; p.z = s.z; p.vx = 0; p.vz = 0; p.runLd = null; }
  return !!carrier;
}
// chained versus: one carried (off its chain: it let go when picked up) and back in time is chained to its carrier, right
// after it on the carrier's chain
function vsChainTo(sim, carrierId, id) {
  const c = sim.chains.find((g) => g.includes(carrierId));
  if (c) c.splice(c.indexOf(carrierId) + 1, 0, id); else sim.chains.push([carrierId, id]);
  sim.chainRev = (sim.chainRev | 0) + 1;
}
// a kitty joining a running chained game (not one coming back: chainRejoin) gets a partner and starts next to it: on
// one chain (all) at its end; else a kitty on its own, else the last of a chain of three (two pairs then), else onto a
// pair (three), else on its own until the next one comes
function chainJoin(sim, p) {
  if (!sim.chain) return;
  // back with its old id (left from the menu, same connection) and still on its chain: its place, where its anchor is
  if (sim.anchors[p.id] && chainRejoin(sim, p.id, p)) { sim.chainRev = (sim.chainRev | 0) + 1; return; }
  if (sim.chains.some((g) => g.includes(p.id))) return;
  const here = (id) => !!findPlayer(sim, id);
  // versus: only a chain of its own team (one with a kitty of it still in the game)
  const mine = (g) => !sim.versus || g.some((id) => { const q = findPlayer(sim, id); return q && q !== p && q.team === p.team; });
  // a kitty held on its own by an anchor: the newcomer takes the place that was left, where it was
  const stuck = sim.chains.find((g) => mine(g) && g.some((id) => sim.anchors[id]) && g.filter((id) => here(id) && id !== p.id).length === 1);
  if (stuck) {
    const old = stuck.find((id) => sim.anchors[id]), an = sim.anchors[old];
    stuck[stuck.indexOf(old)] = p.id;
    delete sim.anchors[old];
    p.x = an.x; p.z = an.z; p.vx = 0; p.vz = 0;
    sim.chainRev = (sim.chainRev | 0) + 1;
    return;
  }
  let mate = null;
  if (sim.chainAll) {
    const g = sim.chains.find(mine);
    if (g) { mate = g[g.length - 1]; g.push(p.id); } else sim.chains.push([p.id]);
  } else {
    const lone = sim.chains.find((g) => mine(g) && g.length === 1 && here(g[0]) && g[0] !== p.id);
    const three = sim.chains.find((g) => mine(g) && g.length === 3 && here(g[2]));
    const pair = sim.chains.find((g) => mine(g) && g.length === 2 && here(g[1]));
    if (lone) { mate = lone[0]; lone.push(p.id); }
    else if (three) { mate = three.pop(); sim.chains.push([mate, p.id]); }
    else if (pair) { mate = pair[1]; pair.push(p.id); }
    else sim.chains.push([p.id]);
  }
  const q = mate != null && findPlayer(sim, mate);
  if (q) {   // (right beside its partner, not across the map at the start)
    const c = collideCircle(sim.levelData, q.x + 0.9, q.z, CFG.KITTY_RADIUS);
    p.x = c.x; p.z = c.z; p.vx = 0; p.vz = 0;
  }
}
// Chained kitties share their boots, each chain its own: boots one of them picks up speed up all of them; one caught
// costs the chain half its pairs (rounded up: one pair, all of it); one back up (revived, a new level) has the chain's
const chainMates = (sim, p) => {
  const g = sim.chain && sim.chains && sim.chains.find((c) => c.includes(p.id));
  return g ? g.map((id) => id !== p.id && findPlayer(sim, id)).filter(Boolean) : [];
};
function chainBootsShare(sim, p) { for (const q of chainMates(sim, p)) if (q.alive) q.speedMult = p.speedMult; }
function chainBootsLost(sim, p) {
  const n = Math.round((p.speedMult - 1) / CFG.SPEED_BOOST), keep = 1 + Math.floor(n / 2) * CFG.SPEED_BOOST;
  for (const q of chainMates(sim, p)) if (q.alive) q.speedMult = Math.min(q.speedMult, keep);
}
function chainBootsBack(sim, p) { for (const q of chainMates(sim, p)) if (q.alive && q.speedMult > p.speedMult) p.speedMult = q.speedMult; }
// someone who left is back (a new player id, or its old one: left from the menu, same connection): it takes its old
// place on its chain, where its anchor was
function chainRejoin(sim, oldId, p) {
  if (!sim.chain || !sim.chains) return false;
  const g = sim.chains.find((c) => c.includes(oldId));
  if (!g) return false;
  sim.chains = sim.chains.map((c) => (c === g ? c : c.filter((id) => id !== p.id))).filter((c) => c.length);
  g[g.indexOf(oldId)] = p.id;
  const an = sim.anchors[oldId];
  if (an) { p.x = an.x; p.z = an.z; delete sim.anchors[oldId]; }
  return true;
}
// Joining up (chained games): a kitty left on its own on its chain (loneOf: the others on it left, their rings or bodies
// still on it) can be voted into another group (the server: kitties of another chain stand on its ring, body or it and vote,
// more than half of that chain; versus: of that team). groupJoin: its rings and bodies go and it goes on the end of the
// voters' chain; versus: in their team, whose points stay (two on their own joining up: the team with more points). One
// that left coming back (mergeReturn, in time) is chained up with its old partner again, and the two split off on their
// own (versus: their old team, with its points from before and what the team they were in scored since) once that leaves
// two or more on both sides; until then it's on the chain with them.
function loneOf(sim, id) {
  const g = sim.chain && sim.chains.find((c) => c.includes(id));
  return !!g && !!findPlayer(sim, id) && g.filter((o) => findPlayer(sim, o)).length === 1 && g.length > 1 ? g : null;
}
// two teams' order: more points, then more crowns, then fewer times caught (as the end cards and the server); 0: a draw
function vsCmp(sim, a, b) {
  const A = sim.teams[a], B = sim.teams[b];
  if (!A || !B) return (B ? 1 : 0) - (A ? 1 : 0);
  return (vsScore(B) - vsScore(A)) || (B.crowns - A.crowns) || (A.deaths - B.deaths);
}
const vsCopy = (t) => ({ dist: t.dist + t.cur, crowns: t.crowns, deaths: t.deaths, revives: t.revives });
function groupJoin(sim, loneId, voterId) {
  const L = findPlayer(sim, loneId), V = findPlayer(sim, voterId), lg = loneOf(sim, loneId);
  const vg = V && sim.chains.find((c) => c.includes(voterId));
  if (!L || !V || !lg || !vg || vg === lg) return false;
  const vLone = loneOf(sim, voterId);   // (two on their own joining up)
  // (versus: the team kept: the voters', or of two on their own the one with more points)
  let keep = null;
  if (sim.versus) {
    const solo = (p) => sim.players.filter((q) => q.team === p.team).length === 1;
    keep = solo(L) && solo(V) && vsCmp(sim, L.team, V.team) < 0 ? L.team : V.team;
  }
  const base = sim.versus ? vsCopy(vsTeam(sim, keep)) : null;
  const off = (g, p) => {   // (its rings / bodies go; who they were, for when they come back)
    const back = g.filter((o) => o !== p.id);
    for (const o of back) { delete sim.anchors[o]; if (sim.vsLeft) delete sim.vsLeft[o]; }
    (sim.merges ||= []).push({ lone: p.id, back, team: p.team, into: keep, base });
    return back;
  };
  off(lg, L);
  if (vLone) off(vg, V);
  if (sim.versus) for (const t of new Set([L.team, V.team])) if (t !== keep) vsTeam(sim, t).cur = 0;   // (left: no level of its own meanwhile, see groupSplit)
  if (!L.alive) {   // (down, waiting on its own: joining brings it back up)
    L.alive = true; L.invuln = CFG.REVIVE_INVULN; L.freeTurn = true;
    sim.circles = sim.circles.filter((c) => c.playerId !== L.id);
  }
  sim.chains = sim.chains.filter((c) => c !== lg);
  if (vLone) vg.splice(0, vg.length, V.id);
  vg.push(L.id);
  if (sim.versus) { L.team = keep; V.team = keep; }
  sim.chainRev = (sim.chainRev | 0) + 1;
  sim.vsRev = (sim.vsRev | 0) + 1;
  return true;
}
// one that left (oldId) back in time while its partner is in another group: chained up with it, then the splits
function mergeReturn(sim, oldId, p) {
  const r = (sim.merges || []).find((m) => m.back.includes(oldId));
  if (!r) return false;
  r.back[r.back.indexOf(oldId)] = p.id;
  (r.home ||= []).push(p.id);
  const L = findPlayer(sim, r.lone), g = L && sim.chains.find((c) => c.includes(r.lone));
  if (!g) { sim.merges = sim.merges.filter((m) => m !== r); return false; }
  for (const c of sim.chains) { const i = c.indexOf(p.id); if (i >= 0 && c !== g) c.splice(i, 1); }
  sim.chains = sim.chains.filter((c) => c.length);
  if (!g.includes(p.id)) g.splice(g.indexOf(r.lone) + 1, 0, p.id);
  p.x = L.x; p.z = L.z; p.vx = 0; p.vz = 0;
  if (sim.versus) p.team = L.team;
  groupSplit(sim);
  sim.chainRev = (sim.chainRev | 0) + 1;
  return true;
}
// the merged groups that can split off again: its lone kitty and those of it back, two or more, the rest of the chain
// too (versus: the rest of the team); one left with only its own kitties on the chain goes back to its own team too
function groupSplit(sim) {
  for (let again = true; again;) {
    again = false;
    for (const r of [...(sim.merges || [])]) {
      const g = sim.chains.find((c) => c.includes(r.lone));
      if (!g) { sim.merges = sim.merges.filter((m) => m !== r); continue; }
      const side = [r.lone, ...(r.home || [])].filter((id) => g.includes(id) && findPlayer(sim, id));
      const rest = g.filter((id) => !side.includes(id) && findPlayer(sim, id));
      if (side.length < 2 || (rest.length && rest.length < 2)) continue;
      if (rest.length) { sim.chains = sim.chains.map((c) => (c === g ? c.filter((id) => !side.includes(id)) : c)); sim.chains.push(side); }
      if (sim.versus) {
        for (const id of side) findPlayer(sim, id).team = r.team;
        const stayed = sim.players.some((q) => q.team === r.team && !side.includes(q.id));   // (others of it played on meanwhile: theirs count)
        if (r.team !== r.into && r.base && !stayed) {   // (its old team: its points from before, and what the team it was in scored since)
          const t = vsTeam(sim, r.team), now = vsCopy(vsTeam(sim, r.into));
          t.dist += now.dist - r.base.dist; t.crowns += now.crowns - r.base.crowns; t.deaths += now.deaths - r.base.deaths; t.revives += now.revives - r.base.revives;
        }
      }
      sim.merges = sim.merges.filter((m) => m !== r);
      sim.chainRev = (sim.chainRev | 0) + 1;
      again = true;
    }
  }
}
// someone who left isn't coming back: off its chain (its partner waits on its own for the next kitty to join)
function chainRelease(sim, id) {
  if (!sim.chain || !sim.chains) return;
  delete sim.anchors[id];
  for (const g of sim.chains) { const i = g.indexOf(id); if (i >= 0) g.splice(i, 1); }
  sim.chains = sim.chains.filter((g) => g.length);
  sim.chainRev = (sim.chainRev | 0) + 1;
}
// a kitty leaving the game (before removePlayer): off the end of a chain that keeps two kitties at once, else an anchor
// (versus: always an anchor, held until its team picks it up: vsLeave)
function chainLeave(sim, id) {
  const p = findPlayer(sim, id), g = sim.chain && sim.chains.find((c) => c.includes(id));
  if (!p || !g) return;
  const i = g.indexOf(id), still = g.filter((o) => o !== id && findPlayer(sim, o)).length;
  if (!sim.versus && (i === 0 || i === g.length - 1) && still >= 2) chainRelease(sim, id);
  else { sim.anchors[id] = { x: p.x, z: p.z }; sim.chainRev = (sim.chainRev | 0) + 1; }
}

// Level generation can take 100ms+ (Skate pattern wolves), so clients and the server pre-generate the next level
// off-thread and hand it over in sim.pregen = { level, seed, mode, ld }: makeLevel takes it when it matches
// (same inputs => the very same deterministic layout), otherwise generates synchronously.
// (hell: every level is a final run of its own: level 9 generated (gen) with the hell level's own seed)
function pregenParams(sim, level = sim.level + 1) {
  if (sim.hell) return { level, gen: SKATE_FINAL_LEVEL, seed: hashSeed(sim.seed, 'hell', level), mode: sim.mode, rf: sim.finales };
  return { level, seed: hashSeed(sim.seed, level), mode: sim.mode, rf: sim.finales };
}
// the level a game shows (hell: its own number; Run + Skate: day and night halves are the same level)
const shownLevel = (sim) => (sim.hell ? sim.level : (sim.levelData && sim.levelData.level) || sim.level);

function makeLevel(sim, level) {
  const again = level === sim.level && sim.levelData;   // the same level over (an easy game's retry): its data as it is
  const { seed, mode, rf, gen = level } = pregenParams(sim, level);
  const pg = sim.pregen;
  sim.pregen = null;
  sim.level = level;
  sim.levelData = again || (pg && pg.ld && pg.level === level && pg.seed === seed && pg.mode === mode && (pg.rf | 0) === rf ? pg.ld : generateLevel(gen, seed, mode, rf));
  sim.enemies = createEnemies(sim.levelData);
  sim.enemyTicks = 0;          // updateEnemies calls since this level's wolves were created (netcode)
  const src = sim.levelData.items || [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    items.push({ id: it.id, type: it.type, x: it.x, z: it.z, taken: false, ...(it.mega ? { mega: true } : {}) });
  }
  sim.items = items;
  sim.circles = [];
  if (sim.versus) for (const t of Object.values(sim.teams)) { t.dist += t.cur; t.cur = 0; }   // (the level before: banked)
  sim.enteredCenter = [];
  sim.checkpointsHit = [];
  sim.vsCp = {};
  sim.vsLeft = {};             // (a new level: the team goes on without them)
  sim.chest = null;            // the lottery chest: { x, z, cx, cz, h, t, open } once a lucky checkpoint is reached
  sim.crownTaken = false;     // the crown floating over the goal, up for grabs each level
  sim.levelTime = 0;
  sim.far = 0;                 // hell: how far along the map the furthest kitty has got this level (0..1)
  sim.state = 'playing';
  sim.stateTimer = 0;
  const shown = shownLevel(sim);
  if (shown > sim.stats.bestLevel) sim.stats.bestLevel = shown;
}

function spawnPoint(levelData, index) {
  const pts = levelData.spawnPoints || [];
  if (pts.length === 0) return { x: 0, z: 0, heading: 0 };
  if (index < pts.length) return { x: pts[index].x, z: pts[index].z, heading: pts[index].heading };
  // more players than spawn points: fill the rest of the start square (its center is levelData.corners[0])
  const c = levelData.corners[0], h = pts[0].heading;
  return squareSlot(c.x, c.z, h, index);
}

// Slot k of a 6x6 grid (1.35 apart) on a corner square, filled from the middle outwards; rows run across `heading`.
// (Slots 0-3 are the middle 2x2, which the 4 regular spawn points already cover.)
const SLOT_ORDER = [2, 3, 1, 4, 0, 5];
function squareSlot(cx, cz, heading, k) {
  k %= 36;
  const ring = [];
  for (const r of SLOT_ORDER) for (const c of SLOT_ORDER) ring.push([r, c]);
  ring.sort((A, B) => Math.max(Math.abs(A[0] - 2.5), Math.abs(A[1] - 2.5)) - Math.max(Math.abs(B[0] - 2.5), Math.abs(B[1] - 2.5)));
  const [row, col] = ring[k];
  const a = (2.5 - row) * 1.35, b = (col - 2.5) * 1.35;
  const fx = Math.cos(heading), fz = Math.sin(heading);
  return { x: cx + fx * a - fz * b, z: cz + fz * a + fx * b, heading };
}

function placeAtSpawn(sim, p, index) {
  const sp = spawnPoint(sim.levelData, index);
  p.x = sp.x;
  p.z = sp.z;
  p.heading = sp.heading;
  p.vx = 0;
  p.vz = 0;
  p.moving = false;
  p.alive = true;
  chainBootsBack(sim, p);
  p.invuln = CFG.SPAWN_INVULN;
  p.shield = 0;
  p.inCenter = false;
  holdUntilRelease(sim, p);
}

// Ice levels: after a spawn or a checkpoint gather the kitty ignores input until it is let go once, so a key or
// joystick still held from before (or a stale click target) can't shoot it off the safe square onto the ice.
function holdUntilRelease(sim, p) {
  const ld = sim.levelData;
  // (Run + Skate's level 9: not in its run half, solid ground above iceZMax)
  p.waitRelease = !!(ld && ld.ice) && !(ld.iceZMax != null && p.z > ld.iceZMax);
}

function makePlayer(def) {
  return {
    id: def.id,
    name: def.name,
    color: def.color,
    x: 0, z: 0, vx: 0, vz: 0, heading: 0, moving: false,
    alive: true,
    lives: 0,
    speedMult: 1,
    invuln: CFG.SPAWN_INVULN,
    shield: 0,
    inCenter: false,
    deaths: 0,
    rescues: 0,
    bonus: 0,   // extra score points (REVIVE_DOUBLE_LEVEL)
    ran: 0,     // maps run this run (the score's distance points, main.js: 20 a map): see trackRun
    team: def.team | 0,   // versus: its team
    finishes: 0,    // levels this kitty finished first this run (run rewards, see main.js)
    crowned: false, // grabbed the crown at least once this run (wears one from then on)
  };
}

// finales: the finale version (maze.js generateLevel fv): 0 original, 1 + Run only's level 9 final run, 2 + the wide
// skate final run. Online rooms with an older client play an older version.
// easy: when everyone is down the level starts over (state 'retry' for CFG.RETRY_TIME, then levelStart with retry: true)
// instead of the game being over.
// hell: Run only / Skate only's final run over and over (config.js HELL_LEVELS; sim.level is the hell level), easy or not;
// waves: with its wolf waves (waves.js; online only when every kitty's game knows them)
function createSim({ seed, players = [], startLevel = 1, mode = 'mixed', finales = 0, easy = false, hell = false, waves = false, chain = false, versus = false } = {}) {   // (chain: true pairs, 'all' everyone on one chain)
  mode = GAME_MODES.includes(mode) ? mode : 'mixed';
  hell = !!hell && HELL_MODES.includes(mode);
  const lvl = hell ? Math.max(1, Math.min(HELL_LEVELS, startLevel | 0)) : Math.max(1, startLevel | 0);
  const sim = {
    seed: seed == null ? 0 : seed,
    mode,
    finales: Math.max(0, Math.min(LATEST_FV, finales | 0)),
    easy: !!easy,   // (hell too: its level starts over)
    hell,
    waves: hell && !!waves,
    far: 0,
    retries: 0,     // easy: how often a level started over this run (snapshot rt: clients reload the level when it moves)
    level: lvl,
    time: 0,
    levelTime: 0,
    levelData: null,
    pregen: null,   // { level, seed, mode, ld }: the next level, generated off-thread (see makeLevel)
    enemies: [],
    enemyTicks: 0,
    lastWinner: 0,  // id of the kitty that last grabbed the crown in the goal (wears it)
    crownTaken: false,
    players: [],
    items: [],
    circles: [],
    state: 'playing',
    stateTimer: 0,
    stats: { rescues: 0, deaths: 0, levelsCleared: 0, bestLevel: lvl },
    started: false,
    enteredCenter: [],
    checkpointsHit: [],
    chain: !!chain,   // chained kitties (CHAIN_LEN)
    chainAll: chain === 'all',   // ...everyone on one chain
    chains: [],       // ...their chains: lists of player ids, in chain order (chainGroups)
    anchors: {},      // ...where a chained kitty that left the game was: id -> { x, z } (chainLinks)
    versus: !!versus, // teams against each other (p.team; vsTeam)
    teams: {},
    vsCp: {},         // versus: the checkpoints each team has reached this level (team -> [index])
    vsLeft: {},       // versus: where a kitty that left was, for its team to pick up (id -> { x, z, team }; vsLeave)
  };
  makeLevel(sim, lvl);
  for (let i = 0; i < players.length; i++) {
    const p = makePlayer(players[i]);
    placeAtSpawn(sim, p, i);
    sim.players.push(p);
  }
  // (the players come in chain order; versus: chains inside each team)
  if (sim.chain && sim.versus) {
    const by = new Map();
    for (const p of sim.players) by.set(p.team, [...(by.get(p.team) || []), p.id]);
    sim.chains = [...by.values()].flatMap((ids) => chainGroups(ids, sim.chainAll));
  } else if (sim.chain) sim.chains = chainGroups(sim.players.map((p) => p.id), sim.chainAll);
  if (sim.versus) for (const p of sim.players) vsTeam(sim, p.team);
  return sim;
}

function readInput(inputs, id) {
  const inp = inputs ? inputs[id] : null;
  if (!inp) return { x: 0, z: 0, none: true }; // no input received yet (doesn't count as letting go)
  let x = Number.isFinite(inp.x) ? inp.x : 0;
  let z = Number.isFinite(inp.z) ? inp.z : 0;
  const m2 = x * x + z * z;
  if (m2 > 1) {
    const m = Math.sqrt(m2);
    x /= m;
    z /= m;
  }
  return inp.m ? { x, z, m: 1 } : { x, z };   // m: sound on (CFG.MUSIC_BOOST)
}

// The score's distance (p.ran: maps run, 1 = a whole map): how far along this level's path a kitty has got by running
// itself. Only running on past the furthest it has been counts (p.runBest); being moved there (a checkpoint gathering
// the team, a new level's start, the victory party: any jump of more than RUN_JUMP in a tick) counts nothing, and the
// way it skipped stays uncounted.
const RUN_JUMP = 3;
function trackRun(sim, p) {
  const ld = sim.levelData;
  if (p.runLd !== ld) { p.runLd = ld; p.runBest = 0; p.runSeg = -1; p.runX = NaN; }   // (a new level: from its start)
  const moved = Math.hypot(p.x - p.runX, p.z - p.runZ);
  const jumped = !(moved <= RUN_JUMP);
  const t = pathTrack(ld, p.x, p.z, jumped ? -1 : p.runSeg);
  if (!jumped && t.f > p.runBest) p.ran = (p.ran || 0) + (t.f - p.runBest);
  if (t.f > p.runBest) p.runBest = t.f;
  p.runSeg = t.i; p.runX = p.x; p.runZ = p.z;
}

function movePlayer(sim, p, inp, dt) {
  const ld = sim.levelData;
  if (p.waitRelease) {
    if (!inp.none && inp.x * inp.x + inp.z * inp.z < 0.01) p.waitRelease = false;
    else inp = { x: 0, z: 0 };
  }
  const maxSpeed = CFG.KITTY_SPEED * p.speedMult * (inp.m ? CFG.MUSIC_BOOST_LEVEL[ld.level || sim.level] || CFG.MUSIC_BOOST : 1);   // (inp.m: sound on, see MUSIC_BOOST)
  const tx = inp.x * maxSpeed;
  const tz = inp.z * maxSpeed;
  const curSpeed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const tgtSpeed = Math.sqrt(tx * tx + tz * tz);
  const estDisp = Math.max(curSpeed, tgtSpeed) * dt;
  let n = Math.ceil(estDisp / MAX_SUBSTEP_DISP);
  if (!(n >= 1)) n = 1;
  if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  const h = dt / n;
  const k = 1 - Math.exp(-h / CFG.KITTY_ACCEL_TAU);
  const kIce = 1 - Math.exp(-h / CFG.ICE_ACCEL_TAU);
  // (finale version 20: with boots the turn rate goes up with the speed, so the U-turn on ice stays as small as without)
  const maxTurn = CFG.ICE_TURN_RATE * ((sim.finales | 0) >= ICE_TURN_FV ? p.speedMult || 1 : 1) * h;
  const steering = inp.x * inp.x + inp.z * inp.z > 0.01;
  let iced = false;
  const wasInCenter = p.inCenter;
  const maxCenterR = ld.centerRadius - CFG.WALL_THICKNESS / 2 - 0.05;

  for (let s = 0; s < n; s++) {
    if (onIce(ld, p.x, p.z)) {
      // skating: keep going the way we face, turn toward the input at a limited rate
      iced = true;
      let sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
      let ang = sp > 0.05 ? Math.atan2(p.vz, p.vx) : p.heading;
      if (steering && p.freeTurn && sp <= 0.05) ang = Math.atan2(inp.z, inp.x);   // just revived, standing: any way at once
      else if (steering) {
        let d = Math.atan2(inp.z, inp.x) - ang;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d <= -Math.PI) d += 2 * Math.PI;
        ang += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
      }
      if (steering || sp > 0.05) sp += (maxSpeed - sp) * (p.towed && !steering ? kIce * CHAIN_TOW_ACCEL : kIce);   // (p.towed: chainPull)
      p.vx = Math.cos(ang) * sp;
      p.vz = Math.sin(ang) * sp;
      p.heading = ang;
    } else {
      p.vx += (tx - p.vx) * k;
      p.vz += (tz - p.vz) * k;
    }
    if (steering) p.freeTurn = false;   // (the first steer after a revive used it, on ice or not)
    const nx = p.x + p.vx * h;
    const nz = p.z + p.vz * h;
    const c = collideCircle(ld, nx, nz, CFG.KITTY_RADIUS);
    let cx = c.x;
    let cz = c.z;
    if (c.hit) {
      const px = cx - nx;
      const pz = cz - nz;
      const pl = Math.sqrt(px * px + pz * pz);
      if (pl > 1e-6) {
        const ux = px / pl;
        const uz = pz / pl;
        const vn = p.vx * ux + p.vz * uz;
        if (vn < 0) {
          p.vx -= vn * ux;
          p.vz -= vn * uz;
        }
      }
    }
    if (wasInCenter && sim.state === 'victory') {
      // the final run's victory party stays inside the center disc (otherwise the disc is free to leave)
      const r = Math.sqrt(cx * cx + cz * cz);
      if (r > maxCenterR && r > 1e-6) {
        const ux = cx / r;
        const uz = cz / r;
        cx = ux * maxCenterR;
        cz = uz * maxCenterR;
        const vn = p.vx * ux + p.vz * uz;
        if (vn > 0) {
          p.vx -= vn * ux;
          p.vz -= vn * uz;
        }
      }
    }
    p.x = cx;
    p.z = cz;
  }

  const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (speed > 0.3 && !iced) p.heading = Math.atan2(p.vz, p.vx);
  p.moving = speed > 0.5;
  p.onIce = onIce(ld, p.x, p.z);
}

// easy games: everyone went down, the level starts over (same level, wolves and pickups as at its start; the kitties
// keep their crowns and rescues)
// A repaired (medic) checkpoint is kept (Run + Skate's level 9: the run half's start): everyone starts again there,
// the checkpoint still repaired (the event's cp: its index).
function retryLevel(sim, events) {
  const cps = sim.levelData.checkpoints || [];
  const at = sim.checkpointsHit.find((c) => cps[c] && cps[c].medic);
  sim.retries = (sim.retries | 0) + 1;
  makeLevel(sim, sim.level);
  if (at === undefined) for (let i = 0; i < sim.players.length; i++) placeAtSpawn(sim, sim.players[i], i);
  else {
    sim.checkpointsHit.push(at);
    for (let i = 0; i < sim.players.length; i++) {
      placeAtSpawn(sim, sim.players[i], i);   // (up again, safe for a moment)
      const p = sim.players[i], sp = squareSlot(cps[at].x, cps[at].z, cps[at].heading, i);
      p.x = sp.x; p.z = sp.z; p.heading = cps[at].heading;
      holdUntilRelease(sim, p);
    }
  }
  events.push({ type: 'levelStart', level: sim.level, retry: true, ...(at === undefined ? {} : { cp: at }) });
}

function nextLevel(sim, events) {
  makeLevel(sim, sim.level + 1);
  for (let i = 0; i < sim.players.length; i++) {
    placeAtSpawn(sim, sim.players[i], i);
  }
  // chained: the rings of kitties that left come along to the start, beside the next kitty on their chain (not left
  // where they were on the level before; versus: there to be picked up again)
  if (sim.chain) for (const id of Object.keys(sim.anchors)) {
    const an = sim.anchors[id], g = sim.chains.find((c) => c.includes(+id)), i = g ? g.indexOf(+id) : -1;
    const near = (g && [...g.slice(0, i).reverse(), ...g.slice(i + 1)].map((o) => findPlayer(sim, o)).find(Boolean)) ||
      (sim.versus && an.team != null && sim.players.find((q) => q.team === an.team)) || sim.players[0];
    if (!near) continue;
    const c = collideCircle(sim.levelData, near.x + 0.9, near.z, CFG.KITTY_RADIUS);
    an.x = c.x; an.z = c.z; an.drag = false;
    if (sim.versus && an.team != null) sim.vsLeft[id] = { x: an.x, z: an.z, team: an.team, color: an.color, by: 0 };
    sim.chainRev = (sim.chainRev | 0) + 1;
  }
  events.push({ type: 'levelStart', level: sim.level });
}

// the hit check's wolf grid (stepSim): used above HIT_GRID_MIN wolves; cells HIT_CELL wide (more than a hit's reach,
// so a kitty's own cell and its 8 neighbours hold every wolf that can touch it)
const HIT_GRID_MIN = 64, HIT_CELL = 2;
const WAVE_WOLF = { id: -1 };   // the wolf that caught a kitty, when it was one of a hell wave's (no id of its own)
const hitCell = (x, z) => (Math.floor(x / HIT_CELL) + 32768) * 65536 + (Math.floor(z / HIT_CELL) + 32768);
function stepSim(sim, inputs, dt) {
  const events = [];
  if (!(dt > 0)) dt = 0;

  if (!sim.started) {
    sim.started = true;
    events.push({ type: 'levelStart', level: sim.level });
  }

  sim.time += dt;
  sim.levelTime += dt;

  updateEnemies(sim.enemies, sim.levelData, dt);
  sim.enemyTicks++;

  if (sim.state === 'gameover') return events;

  const players = sim.players;
  const ld = sim.levelData;

  // --- timers ---
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.invuln > 0) {
      p.invuln -= dt;
      if (p.invuln < 0) p.invuln = 0;
    }
    if (p.shield > 0) {
      p.shield -= dt;
      if (p.shield <= 0) {
        p.shield = 0;
        if (p.alive) events.push({ type: 'shieldEnd', playerId: p.id });
      }
    }
  }

  // --- movement + center ---
  if (sim.chain) {   // everyone moves first, then the chains pull
    for (const p of players) if (p.alive) movePlayer(sim, p, readInput(inputs, p.id), dt);
    chainPull(sim, dt);
  }
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.alive) {
      p.vx = 0;
      p.vz = 0;
      p.moving = false;
      continue;
    }
    if (!sim.chain) movePlayer(sim, p, readInput(inputs, p.id), dt);
    p.inCenter = inCenterNow(sim, p);
    if (sim.state === 'playing') trackRun(sim, p);   // (the score's distance)
    if (sim.hell && sim.state === 'playing') { const f = pathProgress(ld, p.x, p.z); if (f > sim.far) sim.far = f; }   // (hell: the team's furthest)
    if (p.inCenter && sim.enteredCenter.indexOf(p.id) < 0) {
      sim.enteredCenter.push(p.id);
      events.push({ type: 'enterCenter', playerId: p.id, level: sim.level });   // (level: the stage it was, for the unlocks)
    }
  }

  // --- pickups ---
  const pickR = CFG.KITTY_RADIUS + CFG.ITEM_RADIUS;
  const pickR2 = pickR * pickR;
  for (let j = 0; j < sim.items.length; j++) {
    const it = sim.items[j];
    if (it.taken) continue;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      const dx = p.x - it.x;
      const dz = p.z - it.z;
      if (dx * dx + dz * dz >= pickR2) continue;
      let take = true;
      if (it.type === 'boots') {
        if (p.speedMult >= CFG.SPEED_MULT_MAX) take = false; // already boosted: leave them for a friend
        else p.speedMult = it.mega ? CFG.SPEED_MULT_MAX : Math.min(CFG.SPEED_MULT_MAX, p.speedMult + CFG.SPEED_BOOST);   // (a big pair: full speed at once)
        if (take) chainBootsShare(sim, p);
      } else if (it.type === 'life') {
        if (p.lives >= CFG.MAX_EXTRA_LIVES) take = false;   // (already has one: left for a friend, even on HEART_BOOT_LEVEL)
        else {
          p.lives = Math.min(CFG.MAX_EXTRA_LIVES, p.lives + 1);
          if ((sim.levelData.level || sim.level) === CFG.HEART_BOOT_LEVEL) { p.speedMult = Math.min(CFG.SPEED_MULT_MAX, p.speedMult + CFG.SPEED_BOOST); chainBootsShare(sim, p); }   // a pair of boots too
        }
      } else if (it.type === 'shield') {
        p.shield = CFG.SHIELD_TIME;
      }
      if (take) {
        it.taken = true;
        events.push({ type: 'pickup', playerId: p.id, itemType: it.type, itemId: it.id, x: it.x, z: it.z, ...(it.mega ? { mega: true } : {}) });
        break;
      }
    }
  }

  // --- crown: floats over the middle of the goal room. The goal disc only makes you safe (wait there and watch your
  // friends make it); the first kitty to touch the crown wears it and clears the level ---
  let crownBy = null;
  if (!sim.crownTaken) {
    const cr = CFG.KITTY_RADIUS + CFG.CROWN_RADIUS;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const cx = p.x - ld.crown.x, cz = p.z - ld.crown.z;
      if (!p.alive || cx * cx + cz * cz >= cr * cr) continue;
      if (sim.versus && (vsMates(sim, p).some((q) => !sim.enteredCenter.includes(q.id)) || Object.values(sim.vsLeft).some((s) => s.team === p.team))) continue;   // (versus: the whole team home first, anyone who left picked up)
      sim.crownTaken = true;
      sim.lastWinner = p.id;
      p.crowned = true; // keeps wearing a crown for the rest of the run
      if (sim.versus) { vsTeam(sim, p.team).crowns++; for (const q of vsMates(sim, p)) { q.crowned = true; if (q !== p) q.finishes = (q.finishes || 0) + 1; } }   // (the team: one crown, everyone wears it)
      events.push({ type: 'crown', playerId: p.id });
      crownBy = p;
      break;
    }
  }

  // --- revive (after movement) ---
  if (sim.circles.length > 0) {
    const revR = CFG.REVIVE_RADIUS + CFG.KITTY_RADIUS;
    const revR2 = revR * revR;
    for (let c = sim.circles.length - 1; c >= 0; c--) {
      const circ = sim.circles[c];
      const dead = findPlayer(sim, circ.playerId);
      if (!dead) {
        sim.circles.splice(c, 1);
        continue;
      }
      if (dead.alive) {
        sim.circles.splice(c, 1);
        continue;
      }
      if (circ.t < CFG.REVIVE_DELAY) continue; // revive cooldown
      let rescuer = null;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p.alive || p.inCenter || p === dead || (sim.versus && p.team !== dead.team)) continue;
        const dx = p.x - circ.x;
        const dz = p.z - circ.z;
        if (dx * dx + dz * dz < revR2) {
          rescuer = p;
          break;
        }
      }
      if (!rescuer) continue;
      dead.alive = true;
      chainBootsBack(sim, dead);
      dead.x = circ.x;
      dead.z = circ.z;
      dead.vx = 0;
      dead.vz = 0;
      dead.moving = false;
      dead.inCenter = false;
      dead.invuln = CFG.REVIVE_INVULN;   // a short grace period (it can't go down again, and be revived, at once)
      dead.freeTurn = true;   // on ice: its first steer picks the way it skates off (not the way it faced going down)
      rescuer.rescues++;
      if (sim.versus) vsTeam(sim, rescuer.team).revives++;
      if ((sim.levelData.level || sim.level) === CFG.REVIVE_DOUBLE_LEVEL) rescuer.bonus = (rescuer.bonus || 0) + 1;   // (scores double, REVIVE_DOUBLE_LEVEL)
      sim.stats.rescues++;
      sim.circles.splice(c, 1);
      events.push({ type: 'revive', playerId: dead.id, by: rescuer.id, x: circ.x, z: circ.z });
    }
  }

  // --- checkpoints: first kitty onto one revives everyone and gathers the rest of the team there. The kitty that
  // reached it keeps going untouched (position, speed, heading); the others land on the square's slot grid, skipping
  // any slot the activator is standing on ---
  const cps = ld.checkpoints || [];
  for (let c = 0; c < cps.length; c++) {
    if (sim.state !== 'playing' || (!sim.versus && sim.checkpointsHit.indexOf(c) >= 0)) continue;
    const cp = cps[c];
    const hitBy = (p) => !sim.versus || !(sim.vsCp[p.team] || []).includes(c);   // (versus: each team its own)
    const h = (ld.safeSize || ld.corridorWidth) / 2 - CFG.WALL_THICKNESS / 2;
    // a broken (medic) checkpoint: only a kitty with cp.minRescues revives this run can repair it (an easy game: any kitty)
    const by = players.find((p) => p.alive && !p.inCenter && hitBy(p) && Math.abs(p.x - cp.x) < h && Math.abs(p.z - cp.z) < h && (sim.easy || (p.rescues || 0) >= (cp.minRescues || 0)));
    if (!by) continue;
    if (!sim.checkpointsHit.includes(c)) sim.checkpointsHit.push(c);
    if (sim.versus) (sim.vsCp[by.team] ||= []).push(c);
    const revived = [], moved = [];
    let slot = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.inCenter || p === by || (sim.versus && p.team !== by.team)) continue;
      // the broken (medic) checkpoint: a kitty still alive that is already past it (in the run half, beyond the square in
      // the run direction) stays where it is; only the downed and those behind (skate half, hallway, the square) gather
      if (cp.medic && p.alive && (ld.iceZMax == null || p.z > ld.iceZMax) && ((p.x - cp.x) * Math.cos(cp.heading) + (p.z - cp.z) * Math.sin(cp.heading)) > h) continue;
      if (!p.alive) { p.alive = true; p.shield = 0; chainBootsBack(sim, p); revived.push(p.id); }
      moved.push(p.id);
      // a grid filling the square from the middle out (room for 36)
      let sp = squareSlot(cp.x, cp.z, cp.heading, slot);
      for (let g = 0; g < 36 && Math.hypot(sp.x - by.x, sp.z - by.z) < 1; g++) sp = squareSlot(cp.x, cp.z, cp.heading, ++slot);
      p.x = sp.x;
      p.z = sp.z;
      p.heading = cp.heading;
      p.vx = 0; p.vz = 0; p.moving = false;
      p.invuln = 0;
      holdUntilRelease(sim, p);
      slot++;
    }
    sim.circles = sim.circles.filter((circ) => { const q = findPlayer(sim, circ.playerId); return q && !q.alive; });
    events.push({ type: 'checkpoint', index: c, by: by.id, x: cp.x, z: cp.z, revived, moved, ...(cp.medic ? { medic: true } : {}) });
    // each kitty it brought back is a revive by the kitty that reached it, as one in a rescue circle (score, the revive
    // rewards, the account's revives); cp: the checkpoint's own effects show it, not a revive's
    for (const id of revived) {
      const q = findPlayer(sim, id);
      by.rescues++;
      if (sim.versus) vsTeam(sim, by.team).revives++;
      if ((ld.level || sim.level) === CFG.REVIVE_DOUBLE_LEVEL) by.bonus = (by.bonus || 0) + 1;
      sim.stats.rescues++;
      events.push({ type: 'revive', playerId: id, by: by.id, x: q.x, z: q.z, cp: true });
    }
    // the broken checkpoint repaired by a kitty with cp.giftRescues revives this run (level version 17+): a life and 4
    // boots in the square, a little ahead of the middle (new pickups, ids from 2000; the event lists them for the clients)
    if (cp.giftRescues && (by.rescues || 0) >= cp.giftRescues) {
      const gift = [];
      ['life', 'boots', 'boots', 'boots', 'boots'].forEach((type, i) => {
        const a = cp.heading + (i ? (i - 2.5) * 0.75 : 0), r = i ? h * 0.55 : h * 0.3;
        const x = Math.round((cp.x + Math.cos(a) * r) * 1000) / 1000, z = Math.round((cp.z + Math.sin(a) * r) * 1000) / 1000;
        sim.items.push({ id: 2000 + i, type, x, z, taken: false });
        gift.push([2000 + i, type, x, z, 0]);
      });
      events.push({ type: 'medicGift', by: by.id, x: cp.x, z: cp.z, items: gift });
    }
    // the lottery: once in CFG.CHEST_ODDS checkpoints a big chest stands in the square, a little ahead of the middle
    // (by the seed, so it is the same for everyone; sim.chestAlways: local testing). One a level at most.
    // sim.noChest: the server's, while a client too old to draw it is in the room.
    if (!cp.medic && !sim.chest && !sim.noChest && (sim.chestAlways || hashSeed(sim.seed, sim.level, 'chest', c, sim.retries | 0) % CFG.CHEST_ODDS === 0)) {
      sim.chest = { x: cp.x + Math.cos(cp.heading) * h * 0.5, z: cp.z + Math.sin(cp.heading) * h * 0.5, cx: cp.x, cz: cp.z, h, t: CFG.CHEST_ARM, open: false };
      events.push({ type: 'chest', x: sim.chest.x, z: sim.chest.z });
    }
  }

  // --- the lottery chest: the first kitty to step on it opens it, and it throws boots, shields and lives all over the
  // square, more of them the more kitties play (new pickups, ids from 1000; the event lists them for the clients) ---
  const ch = sim.chest;
  if (ch && !ch.open && sim.state === 'playing') {
    const cr = CFG.KITTY_RADIUS + CFG.CHEST_RADIUS;
    const by = ch.t > 0 ? null : players.find((p) => p.alive && Math.hypot(p.x - ch.x, p.z - ch.z) < cr);
    if (ch.t > 0) ch.t -= dt;
    if (by) {
      ch.open = true;
      const [base, per, max] = CFG.CHEST_LOOT, n = Math.min(max, base + per * players.length);
      const a0 = (hashSeed(sim.seed, sim.level, 'loot') % 628) / 100, loot = [];
      for (let i = 0; i < n; i++) {
        // a sunflower spiral over the square, out from the chest
        const r = 1.5 + (ch.h * 1.25 - 1.5) * Math.sqrt((i + 0.5) / n), a = a0 + i * 2.39996;
        const x = Math.max(ch.cx - ch.h + 0.7, Math.min(ch.cx + ch.h - 0.7, ch.x + Math.cos(a) * r));
        const z = Math.max(ch.cz - ch.h + 0.7, Math.min(ch.cz + ch.h - 0.7, ch.z + Math.sin(a) * r));
        const type = i % 3 === 0 ? 'boots' : i % 3 === 1 ? 'shield' : 'life';
        const it = { id: 1000 + i, type, x, z, taken: false, ...(type === 'boots' && i % 12 === 0 ? { mega: true } : {}) };
        sim.items.push(it);
        loot.push([it.id, it.type, Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000, it.mega ? 1 : 0]);
      }
      // (the sim keeps the rounded spots too, so the server and every client agree on them)
      for (let i = 0; i < n; i++) { const it = sim.items[sim.items.length - n + i]; it.x = loot[i][2]; it.z = loot[i][3]; }
      events.push({ type: 'chestOpen', by: by.id, x: ch.x, z: ch.z, items: loot });
    }
  }

  // --- hits ---
  const hitR = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
  const hitR2 = hitR * hitR;
  const enemies = sim.enemies || [];
  // with many wolves: a coarse grid of them (built once, the first time a kitty needs it), so each kitty only tests
  // the wolves around it. The wolf that catches is the same as with the plain scan: the first in the list that touches.
  let grid = null;
  const big = enemies.length > HIT_GRID_MIN;
  const waves = hellWaves(sim);   // hell's wolf waves (waves.js): their wolves catch like any other
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (sim.state !== 'playing') break; // no deaths during the level-clear celebration
    if (!p.alive || p.inCenter || p.invuln > 0 || p.shield > 0) continue;
    if (inTree(ld, p.x, p.z)) continue; // up a tree: safe
    let hit = -1;
    if (big) {
      if (!grid) {
        grid = new Map();
        for (let e = 0; e < enemies.length; e++) {
          const k = hitCell(enemies[e].x, enemies[e].z), a = grid.get(k);
          if (a) a.push(e); else grid.set(k, [e]);
        }
      }
      const cx = Math.floor(p.x / HIT_CELL), cz = Math.floor(p.z / HIT_CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const a = grid.get((gx + 32768) * 65536 + (gz + 32768));
        if (!a) continue;
        for (let q = 0; q < a.length; q++) {
          const e = a[q];
          if (hit >= 0 && e >= hit) continue;
          const dx = p.x - enemies[e].x, dz = p.z - enemies[e].z;
          if (dx * dx + dz * dz < hitR2) hit = e;
        }
      }
    } else {
      for (let e = 0; e < enemies.length; e++) {
        const dx = p.x - enemies[e].x, dz = p.z - enemies[e].z;
        if (dx * dx + dz * dz < hitR2) { hit = e; break; }
      }
    }
    if (hit < 0 && waves.length && waveHit(waves, p.x, p.z, hitR2)) hit = enemies.length;   // (a wave's wolf: WAVE_WOLF)
    if (hit >= 0) {
      const en = enemies[hit] || WAVE_WOLF;
      if (p.lives > 0) {
        p.lives--;
        p.invuln = CFG.SPAWN_INVULN;
        events.push({ type: 'extraLife', playerId: p.id, x: p.x, z: p.z });
      } else {
        p.alive = false;
        p.vx = 0;
        p.vz = 0;
        p.moving = false;
        p.shield = 0;
        p.invuln = 0;
        p.deaths++;
        chainBootsLost(sim, p);   // (chained: the chain loses half)
        if (sim.versus) vsTeam(sim, p.team).deaths++;
        p.speedMult = 1; // speed boots are lost when caught
        sim.stats.deaths++;
        sim.circles.push({ playerId: p.id, x: p.x, z: p.z, t: 0 });
        events.push({ type: 'death', playerId: p.id, x: p.x, z: p.z, enemyId: en.id });
      }
    }
  }

  // --- circles age (new circles from this frame stay at t=0) ---
  for (let c = 0; c < sim.circles.length; c++) {
    const circ = sim.circles[c];
    if (circ.t > 0 || !justDied(events, circ.playerId)) circ.t += dt;
  }

  // versus: a teammate touching where one of them left picks it up and carries it (it goes where the carrier goes);
  // carried into the goal it's done (the team can take the crown without it); the carrier caught drops it there
  if (sim.versus && sim.state === 'playing') for (const id of Object.keys(sim.vsLeft)) {
    const s = sim.vsLeft[id];
    if (!s) continue;
    if (s.by) {
      const c = findPlayer(sim, s.by), an = sim.anchors[id];
      if (an && an.drag) { s.x = an.x; s.z = an.z; } else if (c) { s.x = c.x; s.z = c.z; }
      if (!c || !c.alive) { s.by = 0; if (an && an.drag) { an.drag = false; sim.chainRev = (sim.chainRev | 0) + 1; } sim.vsRev = (sim.vsRev | 0) + 1; continue; }
      if (c.inCenter) {
        delete sim.vsLeft[id];
        if (an) chainRelease(sim, +id);   // (a dragged body home: its chain lets go)
        sim.vsRev = (sim.vsRev | 0) + 1;
        events.push({ type: 'vsHome', id: +id, by: c.id, team: s.team });
      }
      continue;
    }
    // (chained: a ring still holding kitties of its chain in the game is theirs to pick up, a teammate on another
    // chain can't free them by it; a ring of a chain with nobody of it left: any teammate)
    const g = sim.anchors[id] ? sim.chains.find((c) => c.includes(+id)) : null;
    const held = g && g.some((o) => findPlayer(sim, o));
    const q = players.find((o) => o.alive && o.team === s.team && (!held || g.includes(o.id)) && Math.hypot(o.x - s.x, o.z - s.z) < CHAIN_TOUCH);
    if (!q) continue;
    s.by = q.id;
    // (chained: its chain lets go, it's carried now; unless the carrier would be left with no kitty of its chain in the
    // game: then it stays on the chain, a body dragged behind the carrier, slowing it like a kitty standing still)
    if (sim.anchors[id]) {
      if (held && !g.some((o) => o !== q.id && findPlayer(sim, o))) {
        // (one body at most: the other rings on its chain come off it, their spots left to be carried as usual)
        for (const o of g.filter((o) => o !== +id && o !== q.id && sim.anchors[o])) chainRelease(sim, o);
        sim.anchors[id].drag = true;
      } else chainRelease(sim, +id);
      sim.chainRev = (sim.chainRev | 0) + 1;
    }
    sim.vsRev = (sim.vsRev | 0) + 1;
    events.push({ type: 'vsPickup', id: +id, by: q.id, team: s.team, x: s.x, z: s.z });
  }
  vsTrack(sim);   // (versus: the teams' distance, before the level can end this tick)

  // --- state machine ---
  let alive = 0;
  for (let i = 0; i < players.length; i++) if (players[i].alive) alive++;

  if (sim.state === 'playing') {
    if (alive === 0) {
      if (players.length > 0 && sim.easy) {
        sim.state = 'retry';
        sim.stateTimer = CFG.RETRY_TIME;
        events.push({ type: 'wipe', level: shownLevel(sim), ...(sim.hell ? { far: sim.far } : {}) });   // (easy hell: how far it got)
      } else if (players.length > 0) {
        sim.state = 'gameover';
        sim.stateTimer = 0;
        events.push({ type: 'gameOver', level: shownLevel(sim), ...(sim.hell ? { far: sim.far } : {}) });
      }
    } else if (crownBy) {
      // the crown's been grabbed (from inside the goal disc): its kitty clears the level
      const by = crownBy;
      if (stageOf(sim.mode, sim.finales, sim.level).day) {
        // Run + Skate by day: a checkpoint, not a cleared level; everyone revives on the night rink (nextLevel). The
        // crown still counts as a win (the cosmetic rewards)
        by.finishes = (by.finishes || 0) + 1;
        events.push({ type: 'stageClear', level: ld.level, by: by.id });
        sim.state = 'levelclear';
        sim.stateTimer = CFG.LEVEL_CLEAR_TIME;
      } else {
      by.finishes = (by.finishes || 0) + 1;
      sim.stats.levelsCleared++;
      if (sim.hell) sim.far = 1;
      events.push({ type: 'levelClear', level: shownLevel(sim), by: by.id });
      if (ld.finale && (!sim.hell || sim.level >= HELL_LEVELS)) win(sim, by, events);   // (hell: the next one, the same map)
      else {
        sim.state = 'levelclear';
        sim.stateTimer = CFG.LEVEL_CLEAR_TIME;
      }
      }
    }
  } else if (sim.state === 'retry') {
    sim.stateTimer -= dt;
    if (sim.stateTimer <= 0) retryLevel(sim, events);
  } else if (sim.state === 'victory') {
    sim.stateTimer += dt;      // seconds since the win (the party never ends; the client / server decide when to leave)
  } else if (sim.state === 'levelclear') {
    sim.stateTimer -= dt;
    if (sim.stateTimer <= 0) {
      sim.stateTimer = 0;
      nextLevel(sim, events);
    }
  }

  return events;
}

// The final run is cleared: the game is won. Every kitty that went down on the way is carried into the goal
// room for the party (a ring around the portal); state 'victory' is final (no next level, no more deaths).
function win(sim, by, events) {
  sim.state = 'victory';
  sim.stateTimer = 0;
  const party = [];
  let slot = 0;
  for (let i = 0; i < sim.players.length; i++) {
    const p = sim.players[i];
    if (p.alive && p.inCenter) continue;
    const a = slot++ * 2.399963;   // golden angle: an even ring however many show up
    const r = 2.6 + 0.35 * (slot % 3);
    p.alive = true;
    p.x = Math.cos(a) * r; p.z = Math.sin(a) * r;
    p.vx = 0; p.vz = 0; p.moving = false;
    p.heading = Math.atan2(-p.z, -p.x);
    p.inCenter = true;
    p.shield = 0; p.invuln = 0;
    party.push(p.id);
  }
  sim.circles = [];
  events.push({ type: 'victory', level: shownLevel(sim), by: by.id, time: sim.levelTime, party });
}

function justDied(events, playerId) {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'death' && ev.playerId === playerId) return true;
  }
  return false;
}

function findPlayer(sim, id) {
  for (let i = 0; i < sim.players.length; i++) {
    if (sim.players[i].id === id) return sim.players[i];
  }
  return null;
}

// Join mid-game: spawns alive at a spawn point with spawn invulnerability.
function addPlayer(sim, { id, name, color, team }) {
  const existing = findPlayer(sim, id);
  if (existing) return existing;
  const p = makePlayer({ id, name, color, team });
  if (sim.versus) vsTeam(sim, p.team);
  placeAtSpawn(sim, p, sim.players.length);
  sim.players.push(p);
  return p;   // (chained: the server puts it on a chain, chainRejoin / chainJoin)
}

function removePlayer(sim, id) {
  const idx = sim.players.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  sim.players.splice(idx, 1);
  sim.circles = sim.circles.filter((c) => c.playerId !== id);
  const ei = sim.enteredCenter.indexOf(id);
  if (ei >= 0) sim.enteredCenter.splice(ei, 1);
  return true;
}

// In the goal disc right now (it makes you safe while you're in it; you can run back out). The final run's victory
// party stays in it.
function inCenterNow(sim, p) {
  const now = inCenter(sim.levelData, p.x, p.z);
  return sim.state === 'victory' ? p.inCenter || now : now;
}

// Client-side prediction: the movement + center part of stepSim for one player (no hits/pickups).
function predictPlayer(sim, p, inp, dt) {
  if (!p.alive || sim.state === 'gameover') return;
  movePlayer(sim, p, readInput({ 0: inp }, 0), dt);
  if (sim.chain) chainPull(sim, dt, p);   // (its chain: only this kitty moves)
  p.inCenter = inCenterNow(sim, p);
}

// Client mirror: switch to a level the server already generated (same seed => same layout).
function loadLevel(sim, level) {
  makeLevel(sim, level);
}

export { vsScore, vsCmp, vsLeave, vsReturn, loneOf, groupJoin, mergeReturn, VS_MAP, VS_CROWN, GAME_MODES, CHAIN_SOFT, CHAIN_LEN, chainGroups, chainLinks, chainJoin, chainLeave, chainRejoin, chainRelease, pregenParams, createSim, stepSim, addPlayer, removePlayer, predictPlayer, loadLevel };
