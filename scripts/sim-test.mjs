// Sim/rules and isolated security tests (the bulk of `npm test`): no server or external requests, ~7s.
// Add new checks here rather than new scripts. Account checks use disposable temporary files and fake Stripe responses.
// Exit code 1 if any check fails.
import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG, SKATE_FINAL_LEVEL, FINAL_MODES, PLAYER_NAMES, stageStep } from '../public/js/shared/config.js';
import { generateLevel, mazeSelfTest, collideCircle, onIce } from '../public/js/shared/maze.js';
import { hyp } from '../public/js/shared/rng.js';
import { filterChat, filterName } from '../public/js/shared/filter.js';
import { isUnlocked, featTotal, medicLook, slotMetal, UNLOCKS } from '../public/js/shared/unlocks.js';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ======== rules: first kitty home clears the level, everyone respawns; wolves ramp toward the goal; pickups, crown, trees
{
  // Game rules: first kitty in the goal clears the level, everyone respawns alive at the start;
  // wolves get faster/denser toward the middle.

  const sim = createSim({ seed: 5, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] });
  stepSim(sim, {}, CFG.TICK);
  const [a, b, c] = sim.players;
  b.alive = false; b.deaths = 1; sim.circles.push({ playerId: 2, x: b.x, z: b.z, t: 0 });
  a.x = 0; a.z = 0;                       // a reaches the goal; c is still out in the maze
  let ev = stepSim(sim, {}, CFG.TICK);
  const clear = ev.find((e) => e.type === 'levelClear');
  ok(clear && clear.by === 1 && sim.state === 'levelclear', 'one kitty in the goal clears the level');
  ok(ev.some((e) => e.type === 'enterCenter' && e.playerId === 1 && e.level === 1), 'reaching the goal tells which level it was (the level 8 / 9 unlocks count every goal a kitty reached itself)');
  let died = false, levelStart = false;
  for (let t = 0; t < 60 * 3 && !levelStart; t++) {
    c.invuln = 0; ev = stepSim(sim, {}, CFG.TICK);
    if (ev.some((e) => e.type === 'death')) died = true;
    if (ev.some((e) => e.type === 'levelStart')) levelStart = true;
  }
  ok(!died, 'nobody dies during the level-clear celebration');
  ok(levelStart && sim.level === 2, 'next level starts');
  const spawns = sim.levelData.spawnPoints;
  ok(sim.players.every((p) => p.alive && !p.inCenter && Math.hypot(p.x - spawns[0].x, p.z - spawns[0].z) < 4), 'everyone (incl. the dead one) respawns alive at the start');

  // the default mode's running levels ramp up toward the goal (level 2 = autumn, a running level)
  const ld = generateLevel(sim.level, sim.levelData.seed, 'mixed');
  {
    // Run only: tuned wolves (one shared speed; level 1: always 6 s pauses) and original ones, 1/3 original on
    // level 1 up to 3/4 on level 8
    const run = generateLevel(sim.level, sim.levelData.seed, 'run'), run1 = generateLevel(1, sim.levelData.seed, 'run');
    const run8 = generateLevel(8, sim.levelData.seed, 'run');
    const tuned = run.enemies.filter((e) => e.pauseRange);
    // original wolves stay about as many as before (1/3 of the usual 216 on level 1, 3/4 on level 8, + guards);
    // the tuned ones come on top
    const n1 = run1.enemies.filter((e) => !e.pauseRange).length, n8 = run8.enemies.filter((e) => !e.pauseRange).length;
    ok(new Set(tuned.map((e) => e.speed)).size === 1, 'Run only: tuned wolves share one speed');
    ok(n1 >= 66 && n1 <= 86 && n8 >= 150 && n8 <= 185, `Run only: original wolves ${n1} on level 1, ${n8} on level 8`);
    ok(run1.enemies.length - n1 > 216 - 72, `Run only: extra tuned wolves (${run1.enemies.length - n1} on level 1)`);
    ok(run1.enemies.filter((e) => e.pauseRange).every((e) => e.pauseRange[0] === 6 && e.pauseRange[1] === 6), 'Run only level 1: tuned wolves stand still 6 s');
  }
  ok(ld.enemies.length >= 200, `wolves: ${ld.enemies.length}`);
  const half = Math.floor(ld.legs.length / 2);
  const outer = ld.enemies.filter((e) => e.leg < half), inner = ld.enemies.filter((e) => e.leg >= half);
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const len = (from, to) => ld.legs.slice(from, to).reduce((s, l) => s + l.len, 0);
  ok(new Set(ld.enemies.map((e) => e.speed)).size === 1 && ld.enemies.some((e) => e.pauseRange), 'Run + Skate running levels: Run only tuning, every wolf at one speed');
  ok(inner.length / len(half) > outer.length / len(0, half), `inner legs denser (${(outer.length / len(0, half)).toFixed(3)} -> ${(inner.length / len(half)).toFixed(3)} wolves/unit)`);
  const n = ld.legs.length;
  const fin = ld.enemies.filter((e) => e.leg === n - 1);
  ok(fin.length >= 8, `final stretch is crowded (${fin.length} wolves)`);
  {
    // the default mode's winter (ice) levels have exactly Skate only's pattern wolves for that level number
    // (ice-pattern-test.mjs); its other levels keep wanderers
    const winter = [1, 2, 3, 4].find((L) => generateLevel(L, sim.levelData.seed, 'mixed').ice);
    const ice = generateLevel(winter, sim.levelData.seed, 'mixed'), skate = generateLevel(winter, sim.levelData.seed, 'ice');
    ok(ice.ice && ice.enemies.every((e) => e.pattern) && JSON.stringify(ice.enemies) === JSON.stringify(skate.enemies) && ld.enemies.every((e) => !e.pattern),
      `Run + Skate winter level ${winter} has Skate only level ${winter}'s ${skate.enemies.length} pattern wolves; running levels keep wanderers`);
    // skate levels' final stretch: a full room on top of the count (straight chargers), and crossers / diagonals in
    // the goal room
    const fs = skate.enemies.filter((e) => e.finalStretch), lastLeg = skate.legs.length - 1;
    const room = fs.filter((e) => String(e.pattern).startsWith('room-'));
    ok(fs.length >= 8 && fs.every((e) => e.leg === lastLeg) && fs.filter((e) => e.type === 'charger').every((e) => e.route.length === 2)
      && room.some((e) => e.type === 'crosser') && room.some((e) => e.type === 'diagonal'),
      `Skate only level ${winter}: ${fs.length} wolves on the final stretch, ${room.length} of them in the goal room`);
  }
  ok(ld.safeCorners.length === ld.corners.length - 2 && fin.some((e) => e.a0 < CFG.RING_WIDTH / 2), 'the goal-door corner is not a safe square');
  // Run only level 9: the final run on foot (from the right, wide, wandering wolves) only with runFinale; without it
  // (online rooms with an older client) the old spiral
  {
    const rf = generateLevel(SKATE_FINAL_LEVEL, 7, 'run', true), old = generateLevel(SKATE_FINAL_LEVEL, 7, 'run');
    ok(rf.finale && rf.finaleSide === 1 && !rf.ice && rf.corners[0].x > 0 && rf.corridorWidth > CFG.RING_WIDTH && rf.enemies.length > 1500 && rf.enemies.every((e) => !e.pattern),
      `Run only level 9 final run: from the right, ${rf.corridorWidth.toFixed(1)} wide, ${rf.enemies.length} wandering wolves`);
    ok(!old.finale && old.corridorWidth === CFG.RING_WIDTH, 'Run only level 9 without runFinale is the old spiral');
    const s = createSim({ seed: 7, players: [{ id: 1, name: 'a' }], startLevel: SKATE_FINAL_LEVEL, mode: 'run', finales: 1 });
    const sk1 = createSim({ seed: 7, players: [], startLevel: SKATE_FINAL_LEVEL, mode: 'ice', finales: 1 }).levelData;
    ok(s.levelData.finale && sk1.finaleSide === -1 && sk1.corridorWidth === CFG.RING_WIDTH, 'finale version 1: Run only level 9 final run, the skate final run still narrow');
    const sk2 = createSim({ seed: 7, players: [], startLevel: SKATE_FINAL_LEVEL, mode: 'ice', finales: 2 }).levelData;
    const runWolves = sk2.enemies.filter((e) => e.type === 'wanderer'), skate = sk2.enemies.filter((e) => e.pattern);
    ok(sk2.finale && sk2.ice && sk2.corridorWidth > CFG.RING_WIDTH && skate.length > 1000 && runWolves.length > 100 && sk2.enemies.every((e, i) => e.id === i),
      `finale version 2: wide skate final run, ${skate.length} skate wolves and ${runWolves.length} run wolves at the end`);
    // version 4: skate goal rooms keep only their three wolves on the door's side of the disc (the rest of the level as before)
    {
      const v3 = generateLevel(4, 21, 'ice', 3), v4 = generateLevel(4, 21, 'ice', 4), dc = v4.corners.at(-1);
      const room = (ld) => ld.enemies.filter((e) => /^room-/.test(e.pattern));
      // ...and no last-lane crosser / diagonal turning round in the open (the junction); every other wolf as before
      const key = (e) => JSON.stringify({ ...e, id: 0, seed: 0 }), was = new Set(v3.enemies.map(key));
      const at = (e, q) => ({ x: e.frame.ox + e.frame.ux * q.th + e.frame.nx * q.r, z: e.frame.oz + e.frame.uz * q.th + e.frame.nz * q.r });
      const inOpen = v4.enemies.filter((e) => e.leg === v4.legs.length - 1 && (e.type === 'crosser' || e.type === 'diagonal') && !/^room-/.test(e.pattern)
        && [e.route[0], e.route.at(-1)].some((q) => { const p = at(e, q); return !(Math.abs(p.x) < 9 && Math.abs(p.z) < 9) && !collideCircle(v4, p.x, p.z, CFG.WOLF_RADIUS + 0.6).hit; }));
      const early = (e) => e.leg < v4.legs.length - 2;   // (the last two lanes are picked for their risk in version 4: new designs)
      ok(room(v3).length === 6 && room(v4).length === 3 && inOpen.length === 0 && v4.enemies.filter(early).filter((e) => !was.has(key(e))).length <= 3   // (the level's count trim may take a different row end)
        && room(v4).every((e) => e.route.every((q) => at(e, q).x * dc.x + at(e, q).z * dc.z > 0)),
        `finale version 4: skate goal rooms without the three wolves behind the disc, no last-lane wolf turning round in the open (${v3.enemies.length} -> ${v4.enemies.length} wolves)`);
      // version 5: the lane before's neither (those ending at a wall stay); checked on a few levels
      // ...and level + 1 white wolves in the doorway, from the outer wall to the victory circle's edge (never inside it)
      let open5 = 0, wall5 = 0, door5 = true, doors5 = 0;
      for (const [L, s] of [[3, 1], [4, 21], [6, 2], [8, 5]]) {
        const v5 = generateLevel(L, s, 'ice', 5), d = v5.legs.length - 1;
        const dw = v5.enemies.filter((e) => e.pattern === 'door-crosser');
        doors5 += dw.length;
        door5 &&= v5.enemies.every((e) => e.route.every((q) => Number.isFinite(q.r) && Number.isFinite(q.th)));
        const jw = v5.enemies.filter((e) => e.pattern === 'junction-crosser');   // (the junction square's slanted crossers: wall to wall)
        door5 &&= jw.length === 1 + Math.ceil(L / 2) && jw.every((e) => e.route.every((q) => collideCircle(v5, at(e, q).x, at(e, q).z, CFG.WOLF_RADIUS + 0.3).hit));   // (rows through the door beside the disc: their end came out NaN)
        door5 &&= dw.length <= L + 1 && dw.every((e) => [e.route[0], e.route[1]].sort((p, q) => p.r - q.r).every((q, j) => (j ? Math.hypot(at(e, q).x, at(e, q).z) >= v5.centerRadius + CFG.WOLF_RADIUS : collideCircle(v5, at(e, q).x, at(e, q).z, CFG.WOLF_RADIUS + 0.3).hit)));
        for (const e of v5.enemies) if ((e.leg === d || e.leg === d - 1) && (e.type === 'crosser' || e.type === 'diagonal') && !/^room-/.test(e.pattern)) {
          // (turning round with a wall ahead: one it only runs alongside doesn't count)
          const [A, B] = [e.route[0], e.route.at(-1)].map((q) => at(e, q)), k = CFG.WOLF_RADIUS + 0.6;
          const ahead = (p, o) => (Math.abs(p.x) < 9 && Math.abs(p.z) < 9) || collideCircle(v5, p.x + (p.x - o.x) / Math.hypot(p.x - o.x, p.z - o.z) * k, p.z + (p.z - o.z) / Math.hypot(p.x - o.x, p.z - o.z) * k, 0.3).hit;
          if (!ahead(A, B) || !ahead(B, A)) open5++; else if (e.leg === d - 1) wall5++;
        }
      }
      ok(open5 === 0 && wall5 > 0 && door5 && doors5 > 0, `finale version 5: no wolf in the last two skate lanes turning round in the open (${wall5} in the lane before still run wall to wall), doorway wolves (${doors5} new) and junction crossers`);
      // version 6: the last lane's purple wolves (but the goal room's) swapped for black chargers (wall to wall)
      {
        let ok6 = true, ch6 = 0;
        for (const [L, s] of [[2, 1], [5, 4], [8, 5]]) {
          const v6 = generateLevel(L, s, 'ice', 6), jc = v6.enemies.filter((e) => e.pattern === 'junction-charger');
          ch6 += jc.length;
          ok6 &&= !v6.enemies.some((e) => e.leg === v6.legs.length - 1 && (e.pattern === 'junction-crosser' || /^diagonal/.test(e.pattern)))
            && jc.every((e) => e.type === 'charger' && e.route.every((q) => collideCircle(v6, at(e, q).x, at(e, q).z, CFG.WOLF_RADIUS + 0.3).hit));
        }
        ok(ok6 && ch6 >= 3, `finale version 6: no purple wolves in the last lane but the goal room's, ${ch6} more chargers in it`);
      }
      // version 7: every lane (but level 1's lessons and the last two) gets more wolves every level
      {
        const per = [2, 3, 7, 8].map((L) => { const v7 = generateLevel(L, 3, 'ice', 7); return v7.legs.map((_, i) => v7.enemies.filter((e) => e.leg === i).length); });
        const lanes = [...Array(13).keys()];
        ok(lanes.every((i) => per.every((c, j) => !j || c[i] > per[j - 1][i])), `finale version 7: every lane busier every level (lane ${lanes[0]}: ${per.map((c) => c[lanes[0]]).join(' -> ')})`);
      }
      // version 8: running levels' first six lanes reach 37/38/34/35/31/32 wolves on level 8 (the rest as in version 7)
      {
        const lanes = (ld) => ld.legs.map((_, i) => ld.enemies.filter((e) => e.leg === i).length);
        const r7 = lanes(generateLevel(8, 11, 'run', 7)), r8 = lanes(generateLevel(8, 11, 'run', 8)), r1 = lanes(generateLevel(1, 11, 'run', 8));
        ok(r8.slice(0, 6).join() === '37,38,34,35,31,32' && r8.slice(6).join() === r7.slice(6).join() && r1.join() === lanes(generateLevel(1, 11, 'run', 7)).join(),
          `finale version 8: running level 8's long lanes ${r8.slice(0, 6).join('/')} (was ${r7.slice(0, 6).join('/')}), level 1 as before`);
      }
      // version 9: running levels' lanes 7-15 rise 5% a level up to their level 8 count (level 8 as in version 8)
      {
        const lanes = (ld) => ld.legs.map((_, i) => ld.enemies.filter((e) => e.leg === i).length);
        const r = [1, 4, 8].map((L) => lanes(generateLevel(L, 11, 'run', 9)));
        ok(r[0].slice(6).join() === '16,18,16,17,14,15,11,11,10' && r[2].join() === lanes(generateLevel(8, 11, 'run', 8)).join(),
          `finale version 9: running lanes 7-15 ${r.map((c) => c.slice(6).join('/')).join(' -> ')} (levels 1, 4, 8)`);
      }
      // version 10: running levels 1-8 rest as long in every lane (version 9 rested less toward the middle); level 9 as before
      {
        const rests = (ld) => [...new Set(ld.enemies.filter((e) => e.type === 'wanderer' && !e.goalRoom).map((e) => e.pauseScale.toFixed(3)))];
        const r9 = rests(generateLevel(5, 11, 'run', 9)), r10 = rests(generateLevel(5, 11, 'run', 10));
        ok(r9.length > 5 && r10.length === 1 && rests(generateLevel(9, 11, 'run', 10)).join() === rests(generateLevel(9, 11, 'run', 9)).join(),
          `finale version 10: running level 5 rests ${r10.join()} in every lane (was ${r9[0]} to ${r9.at(-1)}), level 9 unchanged`);
      }
      // version 11: 8 items a level (autumn: 4 hearts / shields + the tree boots), at most 2 hearts and 3 shields;
      // level 9's tree boots are a big pair; Run + Skate's level 9: 8 per half, 2 hearts each, 3 shields in all
      {
        const kinds = (ld) => { const c = { boots: 0, life: 0, shield: 0, tree: 0, mega: 0 }; for (const it of ld.items) { if (it.tree) c.tree++; else c[it.type]++; if (it.mega) c.mega++; } return c; };
        const plain = [[1, 'run'], [4, 'ice'], [7, 'mixed']].map(([L, m]) => kinds(generateLevel(L, 31, m, 11)));
        const fall = kinds(generateLevel(2, 31, 'run', 11)), r9 = kinds(generateLevel(9, 31, 'run', 11)), c9 = kinds(generateLevel(9, 31, 'mixed', 11));
        ok(plain.every((c) => c.boots + c.life + c.shield === 8 && c.life <= 2 && c.shield <= 3 && !c.tree) && fall.boots === 0 && fall.life + fall.shield === 4 && fall.tree > 0
          && r9.mega === 1 && c9.boots + c9.life + c9.shield === 16 && c9.life <= 4 && c9.shield <= 3 && c9.mega === 2 && kinds(generateLevel(1, 31, 'run', 10)).boots + kinds(generateLevel(1, 31, 'run', 10)).life + kinds(generateLevel(1, 31, 'run', 10)).shield === 8,
          `finale version 11: items 8 a level (autumn ${fall.life + fall.shield} + ${fall.tree} tree boots), Run + Skate level 9 ${c9.boots + c9.life + c9.shield} + ${c9.mega} big boots`);
        const sim = createSim({ seed: 31, players: [{ id: 'a', name: 'A' }], startLevel: 9, mode: 'run', finales: 11 }), it = sim.items.find((i) => i.mega), q = sim.players[0];
        q.x = it.x; q.z = it.z; q.invuln = 99; stepSim(sim, {}, CFG.TICK);
        ok(it.taken && q.speedMult === CFG.SPEED_MULT_MAX, `finale version 11: the big boots give full speed at once (x${q.speedMult})`);
      }
      // version 12: Skate only's levels 1-8 go through the seasons from winter, as night levels (the wolves as in 11)
      {
        const lv = [1, 2, 3, 4, 5].map((L) => [generateLevel(L, 13, 'ice', 12), generateLevel(L, 13, 'ice', 11)]);
        ok(lv.map(([a]) => a.theme).join() === '2,4,0,1,2' && lv.every(([a, b]) => a.ice && a.night && JSON.stringify(a.enemies) === JSON.stringify(b.enemies))
          && !generateLevel(9, 13, 'ice', 12).night && !generateLevel(2, 13, 'mixed', 12).night && !generateLevel(2, 13, 'run', 12).night,
          'finale version 12: Skate only levels winter, spring, summer, autumn at night (wolves unchanged; not level 9 or the other modes)');
      }
    }
    // version 3: Run + Skate's level 9 is both in a row (skate, a hallway, the run back to the goal room); Skate only keeps
    // the wide skate final run
    const cb = generateLevel(SKATE_FINAL_LEVEL, 7, 'mixed', 3), ice3 = generateLevel(SKATE_FINAL_LEVEL, 7, 'ice', 3);
    const [a, b] = cb.safeCorners, hall = cb.extraFloors[0];
    const route = [[cb.spawnPoints[0].x, cb.spawnPoints[0].z], [cb.spawnPoints[0].x, a.z], [b.x, a.z], [b.x, 0], [0, 0]];
    let blocked = 0;
    for (let i = 1; i < route.length; i++) for (let k = 0; k <= 400; k++) {
      const x = route[i - 1][0] + (route[i][0] - route[i - 1][0]) * k / 400, z = route[i - 1][1] + (route[i][1] - route[i - 1][1]) * k / 400;
      if (collideCircle(cb, x, z, CFG.KITTY_RADIUS).hit) blocked++;
    }
    ok(cb.combo && a.x < b.x && a.z < hall.z0 && blocked === 0 && onIce(cb, b.x - 100, a.z) && !onIce(cb, b.x - 100, 0) && !onIce(cb, (hall.x0 + hall.x1) / 2, (hall.z0 + hall.z1) / 2)
      && cb.enemies.every((e, i) => e.id === i) && cb.trees.length === 2 && !ice3.combo && ice3.corridorWidth > CFG.RING_WIDTH
      && collideCircle(cb, 0, -cb.roomHalf, CFG.KITTY_RADIUS).hit,   // the goal room keeps its back wall (the fish side)
      `finale version 3: Run + Skate level 9 = skate half, hallway, run half (${cb.enemies.length} wolves, a clear way through, ice only on the skate half)`);
  }
  {
    // no wolf ever steps onto a safe square's tiles (they're W - WALL_THICKNESS wide; wolves may walk right up to
    // their edge); the final stretch's first corner is not marked safe
    for (const mode of ['mixed', 'run', 'ice']) {
    const s2 = createSim({ seed: 11, players: [], mode });
    const half = (s2.levelData.corridorWidth - CFG.WALL_THICKNESS) / 2 - 1e-6;
    let touched = 0;
    for (let t = 0; t < 60 * 60; t++) {
      stepSim(s2, {}, CFG.TICK);
      for (const e of s2.enemies) for (const c of s2.levelData.safeCorners) if (Math.abs(e.x - c.x) < half + e.radius && Math.abs(e.z - c.z) < half + e.radius) touched++;
    }
    const c5 = s2.levelData.corners.at(-2);
    ok(touched === 0 && !s2.levelData.safeCorners.includes(c5), `${mode}: safe tiles are truly wolf-free; final-stretch corners have no tile`);
    }
  }

  // easy games: everyone down = the level starts over (same level, wolves as at its start), not game over
  {
    const mk = (easy) => { const s = createSim({ seed: 11, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], startLevel: 3, mode: 'run', easy }); stepSim(s, {}, CFG.TICK); return s; };
    const wipe = (s) => { const evs = []; for (const p of s.players) { p.invuln = 0; p.x = s.enemies[0].x; p.z = s.enemies[0].z; } for (let i = 0; i < 5 && s.state === 'playing'; i++) evs.push(...stepSim(s, {}, CFG.TICK)); return evs; };
    const normal = mk(false);
    ok(wipe(normal).some((e) => e.type === 'gameOver') && normal.state === 'gameover', 'normal game: everyone down is game over');
    const easy = mk(true), fresh = mk(true);
    easy.players[0].finishes = 2; easy.players[0].rescues = 5;
    for (let i = 0; i < 300; i++) stepSim(easy, {}, CFG.TICK);
    const evs = wipe(easy);
    const wiped = evs.some((e) => e.type === 'wipe') && !evs.some((e) => e.type === 'gameOver') && easy.state === 'retry';
    let started = null, ticks = 0;
    while (!started && ticks++ < 600) started = stepSim(easy, {}, CFG.TICK).find((e) => e.type === 'levelStart') || null;
    const same = easy.enemies.length === fresh.enemies.length && easy.enemies.every((e, i) => Math.abs(e.x - fresh.enemies[i].x) < 1e-9 && Math.abs(e.z - fresh.enemies[i].z) < 1e-9);
    ok(wiped && started && started.retry && Math.abs(ticks * CFG.TICK - CFG.RETRY_TIME) < 0.1 && easy.level === 3 && easy.retries === 1 && easy.state === 'playing'
      && easy.players.every((p) => p.alive) && easy.players[0].finishes === 2 && easy.players[0].rescues === 5 && easy.enemyTicks === 0 && same,
    'easy game: everyone down starts the level over (kitties up at the start, crowns and rescues kept, wolves as at the level start)');
  }

  // easy Run + Skate, level 9: any kitty repairs the broken checkpoint (no revives needed), and from then on everyone
  // down starts again from it; a normal game still needs the revives
  {
    const mk = (easy) => { const s = createSim({ seed: 31, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], startLevel: stageStep('mixed', 13, 9), mode: 'mixed', finales: 13, easy }); stepSim(s, {}, CFG.TICK); return s; };
    const onto = (s) => { const cp = s.levelData.checkpoints.find((c) => c.medic), p = s.players[0]; p.invuln = 99; p.x = cp.x; p.z = cp.z; p.waitRelease = false; return { cp, ev: stepSim(s, {}, CFG.TICK) }; };
    const normal = mk(false), easy = mk(true);
    const n = onto(normal), e = onto(easy), ci = easy.levelData.checkpoints.indexOf(e.cp);
    const fixed = !n.ev.some((x) => x.type === 'checkpoint') && e.ev.some((x) => x.type === 'checkpoint' && x.medic) && easy.checkpointsHit.includes(ci);
    for (const p of easy.players) { p.invuln = 0; p.alive = false; }
    let started = null, ticks = 0;
    while (!started && ticks++ < 600) started = stepSim(easy, {}, CFG.TICK).find((x) => x.type === 'levelStart') || null;
    const half = (easy.levelData.safeSize || easy.levelData.corridorWidth) / 2;
    ok(fixed && started && started.retry && started.cp === ci && easy.checkpointsHit.includes(ci) && easy.enemyTicks === 0
      && easy.players.every((p) => p.alive && p.invuln > 0 && Math.abs(p.x - e.cp.x) < half && Math.abs(p.z - e.cp.z) < half),
    'easy Run + Skate level 9: any kitty repairs the checkpoint, and everyone down starts again there (a normal game needs the revives)');
  }

  // revive cooldown: standing on a fresh circle does nothing until REVIVE_DELAY has passed
  {
    const s = createSim({ seed: 8, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const [p1, p2] = s.players;
    p1.invuln = 99; p2.invuln = 0;
    p2.alive = false; s.circles.push({ playerId: 2, x: p1.x, z: p1.z, t: 0 });
    let t = 0, revivedAt = -1;
    for (; t < 120 && revivedAt < 0; t++) { p1.invuln = 99; if (stepSim(s, {}, CFG.TICK).some((e) => e.type === 'revive')) revivedAt = t; }
    const secs = (revivedAt + 1) * CFG.TICK;
    ok(revivedAt >= 0 && secs >= CFG.REVIVE_DELAY - 1e-9 && secs < CFG.REVIVE_DELAY + 0.05, `revive only after the ${CFG.REVIVE_DELAY}s cooldown (${secs.toFixed(2)}s)`);
    ok(p2.alive && Math.abs(p2.invuln - CFG.REVIVE_INVULN) < 0.02 && p2.freeTurn, `a revived kitty is safe for ${CFG.REVIVE_INVULN}s`);
  }

  // just revived on ice: the first steer picks the way it skates off (it faced the other way going down)
  {
    let found = null;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const s = createSim({ seed, players: [{ id: 1, name: 'a' }], mode: 'ice' });
      stepSim(s, {}, CFG.TICK);
      const p = s.players[0], ld = s.levelData;
      for (let a = 0; a < 64 && !found; a++) {
        const r = (ld.centerRadius || 4) + 6 + (a % 8), th = a * 0.7;
        const x = Math.cos(th) * r, z = Math.sin(th) * r;
        if (onIce(ld, x, z) && !collideCircle(ld, x, z, 1.2).hit) found = { s, p, x, z };
      }
    }
    const { s, p, x, z } = found;
    const skate = (free) => {
      Object.assign(p, { x, z, vx: 0, vz: 0, heading: 0, alive: true, waitRelease: false, freeTurn: free, invuln: 9 });
      stepSim(s, { 1: { x: -1, z: 0 } }, CFG.TICK);   // steer the opposite way to its heading
      return Math.cos(p.heading);
    };
    const freeWay = skate(true), oldWay = skate(false);
    ok(freeWay < -0.99 && oldWay > 0.9 && !p.freeTurn, 'revived on ice: the first steer sets the skating direction at once (otherwise it turns from the old heading)');
  }

  // Run + Skate level 9: the broken checkpoint (the run half's start room) only works for a kitty with 60+ revives,
  // and then revives the team like any checkpoint (a 'checkpoint' event with medic)
  {
    const s = createSim({ seed: 9, players: [1, 2, 3, 4].map((id) => ({ id, name: 'k' + id })), startLevel: SKATE_FINAL_LEVEL, mode: 'mixed', finales: 3 });
    stepSim(s, {}, CFG.TICK);
    const cp = s.levelData.checkpoints[0], [p1, p2, p3, p4] = s.players;
    const ahead = { x: cp.x - 60, z: 3 }, skating = { x: p4.x + 40, z: p4.z };   // p3 in the run half past it, p4 still skating
    const onCp = () => {
      p1.x = cp.x; p1.z = cp.z; p1.vx = p1.vz = 0;
      Object.assign(p3, ahead, { vx: 0, vz: 0 }); Object.assign(p4, skating, { vx: 0, vz: 0 });
      for (const p of s.players) p.invuln = 99;
      return stepSim(s, {}, CFG.TICK).filter((e) => e.type === 'checkpoint');
    };
    p2.alive = false;
    p1.rescues = 59; const before = onCp();
    p1.rescues = 60; const stats0 = s.stats.rescues, after = onCp();
    const near = (p, c) => Math.abs(p.x - c.x) < 9 && Math.abs(p.z - c.z) < 9;
    ok(cp && cp.medic && before.length === 0 && after.length === 1 && after[0].medic && after[0].revived.includes(2) && p2.alive,
      'Run + Skate level 9: the broken checkpoint needs 60 revives, then revives the team (medic)');
    ok(Math.abs(p3.x - ahead.x) < 0.5 && !after[0].moved.includes(3) && near(p4, cp) && near(p2, cp) && after[0].moved.includes(4),
      'the broken checkpoint leaves living kitties already past it where they are, gathers the downed and the skaters');
    ok(p1.rescues === 61 && s.stats.rescues === stats0 + 1, 'a kitty brought back by a checkpoint is a revive by the kitty that reached it (only the downed one counts)');
  }

  // speed boots: 4 pairs max, lost when caught (an extra life keeps them)
  {
    const s = createSim({ seed: 21, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const p = s.players[0];
    const grab = () => { s.items.push({ id: 900 + s.items.length, type: 'boots', x: p.x, z: p.z, taken: false }); stepSim(s, {}, CFG.TICK); return s.items.at(-1).taken; };
    const took = [grab(), grab(), grab(), grab(), grab()];
    ok(took.join() === 'true,true,true,true,false' && Math.abs(p.speedMult - (1 + 4 * CFG.SPEED_BOOST)) < 1e-9, `4 pairs of boots max (picked ${took}, speed x${p.speedMult.toFixed(2)})`);
    // (wolf positions are recomputed every tick, so move the kitty onto a wolf instead)
    const w = s.enemies[0];
    const hit = () => { p.invuln = 0; p.shield = 0; p.x = w.x; p.z = w.z; return stepSim(s, {}, CFG.TICK); };
    p.lives = 1;
    const ev1 = hit();
    ok(ev1.some((e) => e.type === 'extraLife') && p.alive && p.speedMult > 1.1, 'an extra life keeps your boots');
    const ev2 = hit();
    ok(ev2.some((e) => e.type === 'death') && !p.alive && p.speedMult === 1, 'boots are lost when caught');
  }

  // crown + aura bookkeeping: the first kitty home wears the crown; finishes are counted per kitty
  {
    const s = createSim({ seed: 31, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const finish = (p) => { for (const q of s.players) q.invuln = 99; p.x = s.levelData.crown.x; p.z = s.levelData.crown.z; stepSim(s, {}, CFG.TICK); p.x = 0; p.z = 0; let t = 0; while (t++ < 400 && !stepSim(s, {}, CFG.TICK).some((e) => e.type === 'levelStart')); };
    const [a, b] = s.players;
    finish(a);
    ok(s.lastWinner === 1 && a.finishes === 1, 'first finisher wears the crown');
    finish(b);
    ok(s.lastWinner === 2 && b.finishes === 1 && a.finishes === 1, 'crown moves to the newest finisher');
    finish(a);
    ok(a.finishes === 2 && s.lastWinner === 1, 'two finishes = aura');
  }
  // autumn levels: a kitty up a climbable tree can't be caught
  {
    const s = createSim({ seed: 41, startLevel: 2, players: [{ id: 1, name: 'a' }] });
    stepSim(s, {}, CFG.TICK);
    const p = s.players[0], t = s.levelData.trees[2];
    ok(s.levelData.trees.length >= 10, `autumn level has climbable trees (${s.levelData.trees.length})`);
    // (wolf positions are recomputed every tick, so put the kitty onto a wolf, with and without a tree there)
    const w = s.enemies[0];
    const onWolf = () => { p.invuln = 0; p.x = w.x; p.z = w.z; return stepSim(s, {}, CFG.TICK); };
    s.levelData.trees.push({ x: w.x, z: w.z });
    let ev = onWolf();
    ok(p.alive && !ev.some((e) => e.type === 'death'), 'a kitty up a tree is safe');
    s.levelData.trees.pop();
    ev = onWolf();
    ok(ev.some((e) => e.type === 'death'), 'the same spot without a tree is deadly');
    const tb = s.levelData.items.filter((it) => it.tree);
    ok(tb.length === s.levelData.trees.length && tb.every((it, i) => it.type === 'boots' && it.x === s.levelData.trees[i].x), `a pair of boots on top of every tree (${tb.length})`);
    void t;
  }
  // the goal disc only makes you safe: the first kitty home can wait there for its friends; the level clears when a
  // kitty touches the crown in the middle (it wears it and gets the finish)
  {
    const s = createSim({ seed: 32, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const [a, b] = s.players;
    a.x = s.levelData.centerRadius - 1; a.z = 0;   // a: just inside the goal's edge, far from the crown
    let ev = [];
    for (let t = 0; t < 60 * 3; t++) { a.invuln = 0; b.invuln = 99; ev.push(...stepSim(s, {}, CFG.TICK)); }
    ok(a.alive && a.inCenter && s.state === 'playing' && !ev.some((e) => e.type === 'levelClear') && !a.crowned,
      'the goal disc is safe but does not clear the level: the first one home can wait for the others');
    {
      // ... and can run back out (to help a friend): out of the disc it's not safe any more
      const r = s.levelData.centerRadius;
      a.x = r - 0.6; a.z = 0; a.vx = 0; a.vz = 0; a.invuln = 99;
      for (let t = 0; t < 60 && a.x < r + 1; t++) stepSim(s, { 1: { x: 1, z: 0 } }, CFG.TICK);
      ok(a.x > r + 0.5 && !a.inCenter, `a kitty can run back out of the goal disc (x ${a.x.toFixed(2)} vs radius ${r})`);
    }
    a.x = s.levelData.crown.x; a.z = s.levelData.crown.z;
    ev = stepSim(s, {}, CFG.TICK);
    ok(ev.some((e) => e.type === 'levelClear' && e.by === 1) && ev.some((e) => e.type === 'crown' && e.playerId === 1) && a.crowned && s.lastWinner === 1 && a.finishes === 1,
      'touching the crown clears the level and crowns that kitty');
    b.x = s.levelData.crown.x; b.z = s.levelData.crown.z; // a teammate darts to the middle during the celebration
    ev = stepSim(s, {}, CFG.TICK);
    ok(!ev.some((e) => e.type === 'crown') && !b.crowned && b.finishes === 0, 'the crown is gone once the winner has it');
  }
}

// ======== playthrough: a kitty steering along the level path (invulnerable) reaches the goal and clears the level
{
  // A kitty steering along the level path (invulnerable) reaches the goal and clears the level.
  const sim = createSim({ seed: 31337, players: [{ id: 1, name: 'bot', color: 0 }] });
  const path = sim.levelData.path;
  let k = 0, cleared = -1;
  for (let t = 0; t < 60 * 400 && cleared < 0; t++) {
    const p = sim.players[0];
    p.invuln = 1;
    while (k < path.length - 1 && Math.hypot(path[k].x - p.x, path[k].z - p.z) < 1.5) k++;
    const dx = path[k].x - p.x, dz = path[k].z - p.z, d = Math.hypot(dx, dz) || 1;
    const ev = stepSim(sim, { 1: { x: dx / d, z: dz / d } }, CFG.TICK);
    if (ev.some((e) => e.type === 'levelClear')) cleared = t;
  }
  ok(cleared > 0, cleared > 0 ? `level cleared after ${(cleared / 60).toFixed(1)}s of running` : `stuck at path point ${k}/${path.length}`);
}

// ======== victory: Skate only / Run + Skate final run ends the game; other levels and modes unchanged
{
  // Skate only's final run ends the game: reaching the goal on level SKATE_FINAL_LEVEL wins ('victory', final),
  // downed kitties are carried to the party, and no other level or mode changed its flow.
  const players = [1, 2, 3].map((id) => ({ id, name: 'k' + id, color: id }));
  // Run + Skate seasons: summer, fall, winter (ice) x3; the third winter is the boss run
  const themes = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => generateLevel(l, 9, 'mixed').theme).join(',');
  ok(themes === '0,1,2,0,1,2,0,1,2', `Run + Skate themes by level: ${themes}`);
  const toGoal = (sim, id) => { const p = sim.players.find((q) => q.id === id); p.x = 0; p.z = 0; };
  const run = (sim, ticks) => { const all = []; for (let t = 0; t < ticks; t++) all.push(...stepSim(sim, {}, CFG.TICK)); return all; };

  for (const mode of FINAL_MODES) {
  const fin = createSim({ seed: 9, players, startLevel: SKATE_FINAL_LEVEL, mode });
  ok(fin.levelData.finale && fin.levelData.ice && fin.levelData.checkpoints.length === 0 && fin.levelData.trees.length === 1 && fin.enemies.every((e) => e.route), `${mode}: level ${SKATE_FINAL_LEVEL} is the final run (ice, pattern wolves, no checkpoints, one tree)`);
  run(fin, 1);
  fin.players[1].alive = false;
  toGoal(fin, 1);
  const ev = run(fin, 1).map((e) => e.type);
  ok(ev.includes('levelClear') && ev.includes('victory') && fin.state === 'victory', `goal -> victory (${ev.join(',')})`);
  ok(fin.players.every((p) => p.alive && p.inCenter), 'downed and lagging kitties carried to the party');
  run(fin, 60 * 60);
  ok(fin.state === 'victory' && fin.level === SKATE_FINAL_LEVEL, `${mode}: after 60 s still victory on the final level (never the next one)`);
  }

  for (const [mode, lvl, next] of [['mixed', 8, 9], ['ice', 8, 9], ['run', 8, 9], ['run', 9, 10]]) {
    const sim = createSim({ seed: 9, players: players.slice(0, 1), startLevel: lvl, mode });
    run(sim, 1); toGoal(sim, 1);
    run(sim, Math.ceil(CFG.LEVEL_CLEAR_TIME * 60) + 5);
    ok(sim.level === next && sim.state === 'playing' && !!sim.levelData.finale === (FINAL_MODES.includes(mode) && next === SKATE_FINAL_LEVEL), `${mode} level ${lvl}: cleared -> level ${next}${sim.levelData.finale ? ' (the final run)' : ''}`);
  }
}

// ======== chat + name filter (public/js/shared/filter.js, store apps only)
{
  const masked = ['fuck you', 'F U C K', 'f.u.c.k', 'sh1t', '$h!t', 'a$$', 'fuuuuck', 'b!tch', 'you ass!', 'fück', 'n1gger',
    'sh*t', 'bullshit', 'kys', 'kill yourself', 'stupid c u n t', 'sexy'];
  const clean = ['hello class', 'Scunthorpe', 'my therapist', 'cocktail', 'assassin', 'Shiitake', 'grapes', 'Sussex',
    'pass the ball', 'annals', 'analysis', 'cumulative', 'Dickens', 'spicy', 'hello!!!', 'level 3 lol', 'c++', 'I a m', 'gg wp',
    'Mississippi', 'shell', 'title', 'document', 'peacock', 'raccoon', 'Hancock', 'sextant', 'butterfly', 'pussycat'];
  for (const t of masked) ok(filterChat(t).includes('♥♥♥'), `masks "${t}" -> "${filterChat(t)}"`);
  for (const t of clean) ok(filterChat(t) === t, `keeps "${t}"`);
  ok(filterChat('go to www.evil.com now') === 'go to [link] now', 'strips www link');
  ok(filterChat('see https://x.y/z?a=1 ok') === 'see [link] ok', 'strips http link');
  ok(filterChat('discord.gg/abc') === '[link]', 'strips bare domain');
  ok(filterChat('3.5 is fine') === '3.5 is fine', 'keeps numbers with dots');
  ok(filterName('Mittens').name === 'Mittens' && !filterName('Mittens').changed, 'nice name kept');
  for (const n of ['Sh_it', 'xXfuckerXx', 'N1gga', 'Hitler']) {
    const f = filterName(n);
    ok(f.changed && PLAYER_NAMES.includes(f.name), `name "${n}" -> ${f.name}`);
  }
  {
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(3).slice(0, 120);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) filterChat(long);
    const us = ((performance.now() - t0) / 2000) * 1000;
    ok(us < 500, `filter is fast (${us.toFixed(0)} µs per 120-char message)`);
  }
}

// ======== maze generator self-test: levels 1-2, every seed, mixed + ice (determinism, paths, spawns, wolves, pattern gaps)
{
  // sound on (input m): 1% faster (CFG.MUSIC_BOOST)
  {
    const run = (m) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }], startLevel: 1, mode: 'run' }); stepSim(s, {}, CFG.TICK); const p = s.players[0]; p.invuln = 99; for (let i = 0; i < 30; i++) stepSim(s, { a: { x: 0, z: -1, m } }, CFG.TICK); return Math.hypot(p.vx, p.vz); };
    const off = run(0), on = run(1);
    ok(Math.abs(on / off - CFG.MUSIC_BOOST) < 1e-6, `input m: kitty speed x${(on / off).toFixed(3)}`);
  }
  // level rules: sound on runs 2% faster on level 3 (CFG.MUSIC_BOOST_LEVEL), a heart is a pair of boots too on level 4,
  // revives score double on level 5 (p.bonus)
  {
    const sp = (L) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }], startLevel: L, mode: 'run' }); stepSim(s, {}, CFG.TICK); const p = s.players[0]; p.invuln = 99; const v = []; for (const m of [0, 1]) { p.vx = p.vz = 0; for (let i = 0; i < 30; i++) stepSim(s, { a: { x: 1, z: 0, m } }, CFG.TICK); v.push(Math.hypot(p.vx, p.vz)); p.x = s.levelData.spawnPoints[0].x; p.z = s.levelData.spawnPoints[0].z; } return v[1] / v[0]; };
    const heart = (L, full) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }], startLevel: L, mode: 'run' }); stepSim(s, {}, CFG.TICK); const p = s.players[0], it = s.items.find((i) => i.type === 'life') || s.items[0]; it.type = 'life'; p.lives = full ? CFG.MAX_EXTRA_LIVES : 0; p.x = it.x; p.z = it.z; p.invuln = 99; stepSim(s, {}, CFG.TICK); return [it.taken, p.speedMult]; };
    const [h3, h4, h4full] = [heart(3), heart(4), heart(4, true)];
    ok(Math.abs(sp(3) - 1.02) < 1e-6 && Math.abs(sp(2) - 1.01) < 1e-6 && h3[0] && h3[1] === 1 && h4[0] && h4[1] > 1 && !h4full[0], `level rules: sound-on speed x${sp(3).toFixed(3)} on level 3, a heart on level 4 is boots too (x${h4[1]})`);
    const rev = (L) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], startLevel: L, mode: 'run' }); stepSim(s, {}, CFG.TICK); const [a, b] = s.players; b.alive = false; s.circles.push({ playerId: "b", x: a.x, z: a.z, t: CFG.REVIVE_DELAY }); a.invuln = 99; for (let i = 0; i < 10; i++) stepSim(s, {}, CFG.TICK); return [a.rescues, a.bonus]; };
    const [r4, r5] = [rev(4), rev(5)];
    ok(r4[0] === 1 && !r4[1] && r5[0] === 1 && r5[1] === 1, `level rules: a revive on level 5 scores double (rescues ${r5[0]} + bonus ${r5[1]})`);
  }
  const r = mazeSelfTest(2);
  ok(r.ok, 'maze self-test (2 levels)' + (r.ok ? '' : ':\n  ' + r.problems.join('\n  ')));
}

// ======== Run + Skate by day then by night (level version 13): by day Run only's level, by night Skate only's; the
// day goal is a checkpoint (everyone revives on the night rink), only the night goal clears the level
{
  const sim = createSim({ seed: 21, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], mode: 'mixed', finales: 13 });
  stepSim(sim, {}, CFG.TICK);
  const day = sim.levelData, [a, b] = sim.players;
  ok(sim.level === 1 && day.level === 1 && !day.ice && !day.night, 'Run + Skate (v13): level 1 starts by day, on foot');
  ok(JSON.stringify(day.enemies) === JSON.stringify(generateLevel(1, day.seed, 'run', 11).enemies), "Run + Skate (v13): by day it's Run only's level");
  b.alive = false; b.deaths = 1; sim.circles.push({ playerId: 2, x: b.x, z: b.z, t: 0 });
  a.x = 0; a.z = 0;
  let ev = stepSim(sim, {}, CFG.TICK);
  ok(ev.some((e) => e.type === 'stageClear' && e.level === 1) && !ev.some((e) => e.type === 'levelClear') && a.finishes === 1 && sim.stats.levelsCleared === 0, 'Run + Skate (v13): the day goal is a checkpoint, not a cleared level (its crown still counts as a win)');
  for (let t = 0; t < 60 * 4 && sim.level === 1; t++) stepSim(sim, {}, CFG.TICK);
  const night = sim.levelData;
  ok(sim.level === 2 && night.level === 1 && night.ice && night.night, 'Run + Skate (v13): then level 1 by night, on the ice');
  ok(sim.players.every((p) => p.alive) && sim.circles.length === 0, 'Run + Skate (v13): everyone revives for the night half');
  ok(JSON.stringify(night.enemies) === JSON.stringify(generateLevel(1, night.seed, 'ice', 12).enemies), "Run + Skate (v13): by night it's Skate only's level");
  a.x = 0; a.z = 0; a.invuln = 99;
  ev = stepSim(sim, {}, CFG.TICK);
  ok(ev.some((e) => e.type === 'levelClear' && e.level === 1) && a.finishes === 2 && sim.stats.levelsCleared === 1, 'Run + Skate (v13): the night goal clears level 1');
  for (let t = 0; t < 60 * 4 && sim.level === 2; t++) stepSim(sim, {}, CFG.TICK);
  ok(sim.level === 3 && sim.levelData.level === 2 && !sim.levelData.ice, 'Run + Skate (v13): then level 2 by day');
  // version 14: the night half is in the day half's season (levels 1-8); the rink, wolves and pickups are version 13's
  {
    let same = true, moved = 0;
    for (let L = 1; L <= 8; L++) {
      const day = generateLevel(2 * L - 1, 5, 'mixed', 14), night = generateLevel(2 * L, 5, 'mixed', 14), old = generateLevel(2 * L, 5, 'mixed', 13);
      if (night.theme !== day.theme || !night.ice || !night.night) same = false;
      if (JSON.stringify(night.enemies) !== JSON.stringify(old.enemies) || JSON.stringify(night.items) !== JSON.stringify(old.items) || JSON.stringify(night.walls) !== JSON.stringify(old.walls)) same = false;
      if (night.theme !== old.theme) moved++;
    }
    ok(same && moved > 0 && JSON.stringify(generateLevel(17, 5, 'mixed', 14).enemies) === JSON.stringify(generateLevel(17, 5, 'mixed', 13).enemies),
      "Run + Skate (v14): every night rink is in the season of its day half, with the rink, wolves and pickups of version 13; level 9 is unchanged");
  }
  const fin = generateLevel(17, 5, 'mixed', 13);
  ok(fin.finale && fin.level === SKATE_FINAL_LEVEL && fin.checkpoints.some((c) => c.medic), 'Run + Skate (v13): step 17 is the unchanged level 9 final run');
  ok(!generateLevel(2, 5, 'mixed', 12).night && generateLevel(2, 5, 'mixed', 12).level === 2, 'Run + Skate before v13: one level per level, as before');
}

// ======== browser trust boundaries (mock browser/socket; never connects to a server)
{
  const keys = ['window', 'location', 'WebSocket', 'sessionStorage'];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    globalThis.window = {};
    globalThis.location = new URL('https://runkittyrun.fun/?server=wss://untrusted.invalid/ws&room=ABCD');
    globalThis.sessionStorage = { getItem: () => 'regression-tab-token', setItem() {} };
    const prod = await import('../public/js/platform.js');
    ok(prod.wsUrl() === 'wss://runkittyrun.fun/ws'
      && prod.accountApiUrl('/api/account/me') === 'https://runkittyrun.fun/api/account/me',
    'production invite cannot change the game or account server');
    ok(!prod.accountSocketTrusted('wss://untrusted.invalid/ws')
      && !prod.accountSocketTrusted('wss://runkittyrun.fun/other')
      && prod.accountSocketTrusted('wss://runkittyrun.fun/ws'), 'account credentials require the trusted socket endpoint');

    let socket, socketOverride;
    globalThis.WebSocket = class {
      constructor(url) { this.url = socketOverride || url; this.readyState = 0; this.sent = []; socket = this; }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
    };
    const { createNet } = await import('../public/js/net.js');
    for (const trusted of [true, false]) {
      socketOverride = trusted ? null : 'wss://untrusted.invalid/ws';
      const net = createNet(); net.acct = () => 'dummy-session-token';
      try {
        net.connect();
        net.send({ t: 'acct', acct: 'dummy-session-token' }); // queued while connecting
        socket.readyState = 1; socket.onopen();
        net.send({ t: 'acct', acct: 'dummy-session-token' }); // later sign-in update
        ok(socket.sent.length === 3 && socket.sent.every((m) => trusted ? m.acct === 'dummy-session-token' : !m.acct),
          `account handshake and queued/live updates ${trusted ? 'reach only the trusted server' : 'omit credentials for custom servers'}`);
      } finally { net.disconnect(); }
    }
    globalThis.location = new URL('http://localhost:8091/?server=ws://localhost:8092/ws');
    const dev = await import('../public/js/platform.js?local-development-test');
    ok(dev.wsUrl() === 'ws://localhost:8092/ws'
      && dev.accountApiUrl('/api/account/me') === 'http://localhost:8091/api/account/me'
      && !dev.accountSocketTrusted(dev.wsUrl()), 'local custom servers work without receiving account credentials');
    globalThis.location = new URL('https://runkittyrun.fun/?server=javascript:alert(1)');
    const invalid = await import('../public/js/platform.js?invalid-server-test');
    ok(invalid.wsUrl() === 'wss://runkittyrun.fun/ws', 'invalid server URLs cannot override production');
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

// ======== account durability + webhook bytes (temporary files and fake Stripe; no external requests)
{
  const fs = (await import('node:fs')).default;
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { EventEmitter } = await import('node:events');
  const { createAccounts, onePerPlayer, samePlayer } = await import('../server/accounts.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-accounts-test-'));
  const file = path.join(dir, 'accounts.json'), ledger = path.join(dir, 'payments.jsonl');
  const token = 'dummy-session-token-for-regression', sub = 'test-google-sub';
  const env = { GOOGLE_CLIENT_ID: 'test-client', STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: 'whsec_dummy', NODE_ENV: 'production' };
  const session = { id: 'cs_test_regression', object: 'checkout.session', livemode: false, mode: 'payment',
    client_reference_id: sub, metadata: { app: 'run-kitty-run', sub }, amount_total: 50, currency: 'eur',
    payment_status: 'paid', url: 'https://checkout.stripe.com/test-only' };
  const savedFetch = globalThis.fetch, savedRename = fs.renameSync, savedWrite = fs.writeFileSync, savedError = console.error;
  const errors = [];
  const request = (accounts, name, chunks = [], headers = {}) => new Promise((resolve, reject) => {
    const req = new EventEmitter(); req.method = name === 'me' ? 'GET' : 'POST';
    req.headers = { authorization: 'Bearer ' + token, ...headers }; req.destroy = () => reject(new Error('unexpected oversized request'));
    let status;
    const res = { writeHead(code) { status = code; }, end(body) { resolve({ status, ...JSON.parse(body) }); } };
    if (name === 'webhook') accounts.webhook(req, res); else accounts.handle(req, res, name);
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  const pay = (accounts) => request(accounts, 'pay', [Buffer.from(JSON.stringify({ cents: 50 }))]);
  try {
    fs.writeFileSync(file, JSON.stringify({ accounts: { [sub]: { sub, email: 'test@example.invalid', name: 'Test', paid: 0,
      sessions: [crypto.createHash('sha256').update(token).digest('hex')], payments: [] },
      // a second account that never pays (signing in is free, the swag account is only active once paid)
      'unpaid-sub': { sub: 'unpaid-sub', email: 'unpaid@example.invalid', name: 'Unpaid', paid: 0,
        sessions: [crypto.createHash('sha256').update('unpaid-session-token-for-regression').digest('hex')], payments: [] } }, checkouts: {},
      // guest unlock progress: one not played with for 70 days (dropped), one from yesterday (kept)
      guests: { oldguestprogressid0123456789: { at: Date.now() - 70 * 864e5, unlocks: { l8: { run: 1 } } }, newguestprogressid0123456789: { at: Date.now() - 864e5, unlocks: { l8: { run: 1 } } } } }), { mode: 0o644 });
    fs.writeFileSync(ledger, '', { mode: 0o644 });
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith('https://api.stripe.com/v1/checkout/sessions')) throw new Error('unexpected network call');
      return { ok: true, json: async () => ({ ...session }) };
    };
    console.error = (...args) => errors.push(args.join(' '));
    let accounts = createAccounts(file, env);
    ok((fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(ledger).mode & 0o777) === 0o600,
      'existing account and payment files become private');

    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('simulated storage failure'), { code: 'EIO' }); return savedRename(from, to); };
    const failed = await pay(accounts);
    ok(failed.status >= 400 && !failed.url && !JSON.parse(fs.readFileSync(file)).checkouts[session.id],
      'failed checkout persistence never returns a payable URL');
    fs.renameSync = savedRename;
    const created = await pay(accounts);
    ok(created.ok && created.url === session.url && JSON.parse(fs.readFileSync(file)).checkouts[session.id],
      'checkout binding is on disk before returning its URL');

    accounts = createAccounts(file, env); // simulate a restart before the player completes payment
    const raw = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...session, customer_details: { name: 'Mäxi 🐈' } } } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(timestamp + '.').update(raw).digest('hex');
    const headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` };
    const split = raw.indexOf(Buffer.from('ä')) + 1;
    const credited = await request(accounts, 'webhook', [raw.subarray(0, split), raw.subarray(split)], headers);
    const duplicate = await request(accounts, 'webhook', [raw], headers);
    const bad = await request(accounts, 'webhook', [raw], { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}` });
    ok(credited.status === 200 && duplicate.status === 200 && accounts.paidFor(token) === 50
      && fs.readFileSync(ledger, 'utf8').trim().split('\n').length === 1 && bad.status === 400,
    'split Unicode webhook verifies exact bytes; duplicates credit once and bad signatures fail');
    for (const restart of [false, true]) {
      session.id = restart ? 'cs_test_snapshot_restart' : 'cs_test_snapshot_retry';
      await pay(accounts);
      const event = Buffer.from(JSON.stringify({ type: 'checkout.session.async_payment_succeeded', data: { object: session } }));
      const digest = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(timestamp + '.').update(event).digest('hex');
      const signed = { 'stripe-signature': `t=${timestamp},v1=${digest}` };
      fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('simulated snapshot failure'), { code: 'EIO' }); return savedRename(from, to); };
      const failedCredit = await request(accounts, 'webhook', [event], signed);
      fs.renameSync = savedRename;
      if (restart) accounts = createAccounts(file, env);
      const retry = await request(accounts, 'webhook', [event], signed);
      ok(failedCredit.status === 500 && retry.status === 200 && accounts.paidFor(token) === (restart ? 150 : 100)
        && fs.readFileSync(ledger, 'utf8').trim().split('\n').length === (restart ? 3 : 2),
      `failed credit snapshot recovers exactly once on ${restart ? 'restart and webhook retry' : 'webhook retry'}`);
    }
    session.id = 'cs_test_partial_ledger';
    await pay(accounts);
    const partialEvent = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: session } }));
    const partialDigest = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(timestamp + '.').update(partialEvent).digest('hex');
    const partialHeaders = { 'stripe-signature': `t=${timestamp},v1=${partialDigest}` };
    fs.writeFileSync = (fd, data, ...options) => {
      if (typeof fd === 'number' && String(data).includes('"session":"cs_test_partial_ledger"')) {
        savedWrite(fd, String(data).slice(0, 23));
        throw Object.assign(new Error('simulated partial ledger write'), { code: 'ENOSPC' });
      }
      return savedWrite(fd, data, ...options);
    };
    const partialFailure = await request(accounts, 'webhook', [partialEvent], partialHeaders);
    fs.writeFileSync = savedWrite;
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('simulated snapshot failure'), { code: 'EIO' }); return savedRename(from, to); };
    const snapshotFailure = await request(accounts, 'webhook', [partialEvent], partialHeaders);
    fs.renameSync = savedRename;
    accounts = createAccounts(file, env);
    const partialRetry = await request(accounts, 'webhook', [partialEvent], partialHeaders);
    ok(partialFailure.status === 500 && snapshotFailure.status === 500 && partialRetry.status === 200 && accounts.paidFor(token) === 200,
      'partial ledger append cannot swallow the retried payment during restart recovery');
    // "shown online" switch: off = the game server gets 0 for this player, saved on disk (survives a restart)
    const total = accounts.paidFor(token);
    const hide = await request(accounts, 'show', [Buffer.from(JSON.stringify({ show: false }))]);
    const hiddenAfterRestart = createAccounts(file, env).paidFor(token);
    const unhide = await request(accounts, 'show', [Buffer.from(JSON.stringify({ show: true }))]);
    const badShow = await request(accounts, 'show', [Buffer.from(JSON.stringify({ show: 'no' }))]);
    ok(hide.ok && hide.account.show === false && total > 0 && hide.account.paid === total && hiddenAfterRestart === 0
      && unhide.ok && unhide.account.show === true && accounts.paidFor(token) === total && !badShow.ok,
    'shown-online switch hides the total from the game server, is saved, and turns back on');
    // the number shown: any amount from 1 cent up to the total, saved; null (or the total itself) = the total again
    const disp = (cents) => request(accounts, 'display', [Buffer.from(JSON.stringify({ cents }))]);
    const low = await disp(1), lowShown = accounts.paidFor(token), lowAfterRestart = createAccounts(file, env).paidFor(token);
    const over = await disp(total + 1), zero = await disp(0), frac = await disp(1.5), word = await disp('7');
    const mid = await disp(total - 1), back = await disp(null);
    ok(low.ok && low.account.display === 1 && low.account.paid === total && lowShown === 1 && lowAfterRestart === 1
      && !over.ok && !zero.ok && !frac.ok && !word.ok && mid.ok && mid.account.display === total - 1
      && back.ok && back.account.display === total && accounts.paidFor(token) === total,
    'the number shown next to the kitty: 1 cent up to the total paid, never more, saved, and back to the total');
    // stats: online games counted by the server (by account id), solo / local reported by the browser (capped)
    accounts.recordOnline(sub, { type: 'reached', mode: 'run', level: 9 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 2 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 2 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'nope', level: 2 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'ice', level: 12 });
    accounts.recordOnline(sub, { type: 'crown' });
    accounts.recordOnline(sub, { type: 'revive' });
    accounts.recordOnline('someone-else', { type: 'crown' });
    const local = await request(accounts, 'progress', [Buffer.from(JSON.stringify({ mode: 'mixed', reached: 3, clears: [1, 2, 3, 4, 5], crowns: 50, revives: 500 }))]);
    const me = await request(accounts, 'me');
    const on = me.account.stats.online, lo = me.account.stats.local;
    ok(accounts.subFor(token) === sub && on.clears.run[2] === 2 && on.reached.run === 9 && !on.clears.ice[12] && on.crowns === 1 && on.revives === 1
      && local.ok && lo.clears.mixed[1] === 1 && lo.clears.mixed[3] === 1 && !lo.clears.mixed[4] && lo.crowns === 3 && lo.revives === 100
      && lo.reached.mixed === 3 && !lo.clears.run[2],
    'account stats: online counted per mode / level, bad modes and levels ignored, local reports capped and kept apart');
    // fastest clear per mode / level: only a faster time replaces it, times out of range are ignored
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 3, time: 95.04 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 3, time: 120 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 4, time: 1 });
    await request(accounts, 'progress', [Buffer.from(JSON.stringify({ mode: 'ice', reached: 2, clears: [2], times: [61.26], crowns: 0, revives: 0 }))]);
    const fast = await request(accounts, 'me');
    ok(fast.account.stats.online.best.run[3] === 95 && !fast.account.stats.online.best.run[4] && fast.account.stats.local.best.ice[2] === 61.3
      && !fast.account.stats.online.best.ice[2],
    'account stats: fastest clear per mode and level (online and local apart), slower and implausible times ignored');
    // hell: each hell level's clears and fastest clear, and the wins (all of hell cleared), online and local apart
    accounts.recordOnline(sub, { type: 'hellClear', mode: 'ice', level: 1, time: 80.04 });
    accounts.recordOnline(sub, { type: 'hellClear', mode: 'ice', level: 1, time: 99 });
    accounts.recordOnline(sub, { type: 'hellClear', mode: 'ice', level: 7 });
    accounts.recordOnline(sub, { type: 'hellClear', mode: 'mixed', level: 1 });
    accounts.recordOnline(sub, { type: 'hellWin', mode: 'run' });
    accounts.recordOnline(sub, { type: 'hellClear', mode: 'run', level: 2 }, true);
    const crowns0 = (await request(accounts, 'me')).account.stats.online.crowns;
    accounts.recordOnline(sub, { type: 'crown', hell: true });
    const hl = await request(accounts, 'progress', [Buffer.from(JSON.stringify({ hell: true, mode: 'run', clears: [1, 2, 9], times: [70, 60], won: true, crowns: 1, revives: 2 }))]);
    // easy games: online ones in 'easy', solo / local ones in 'easyLocal' (since the split), their revives in the usual set too
    await request(accounts, 'progress', [Buffer.from(JSON.stringify({ mode: 'ice', easy: true, reached: 2, clears: [1], times: [50], crowns: 1, revives: 3 }))]);
    await request(accounts, 'progress', [Buffer.from(JSON.stringify({ hell: true, easy: true, mode: 'ice', clears: [1], times: [90], crowns: 0, revives: 0 }))]);
    const hs = (await request(accounts, 'me')).account.stats;
    ok(hs.online.hell.clears.ice[1] === 2 && hs.online.hell.best.ice[1] === 80 && !hs.online.hell.clears.ice[7] && !hs.online.hell.clears.mixed
      && hs.online.hell.wins.run === 1 && hs.easy.hell.clears.run[2] === 1 && !hs.online.hell.clears.run[2]
      && hl.ok && hs.local.hell.clears.run[1] === 1 && hs.local.hell.best.run[2] === 60 && !hs.local.hell.clears.run[9] && hs.local.hell.wins.run === 1
      && hs.local.reached.run === 0 && !hs.local.clears.run[1]
      && hs.online.hell.crowns === 1 && hs.online.crowns === crowns0 && hs.local.hell.crowns === 1 && hs.local.hell.revives === 2 && hs.local.revives === lo.revives + 3
      && hs.easyLocal.clears.ice[1] === 1 && hs.easyLocal.crowns === 1 && hs.easyLocal.revives === 3 && hs.easyLocal.hell.clears.ice[1] === 1 && !hs.easy.clears.ice[1] && !hs.easy.hell.clears.ice[1],
    'account stats: hell levels cleared (fastest too), hell won and its crowns (their own count), per hell mode, online / easy / local apart; not counted as normal levels');
    // the hell games from before: filled once from the hell boards (levels below the furthest reached, an escape a win)
    {
      const { createLevelBoards } = await import('../server/levelboards.js');
      const lb = createLevelBoards(path.join(dir, 'levels-backfill.json'));
      lb.recordHell({ acct: sub, name: 'Me', color: 1 }, { local: false, easy: false, mode: 'run', level: 4, far: 0.46, team: 1, time: 600 });
      lb.recordHell({ acct: sub, name: 'Me', color: 1 }, { local: true, easy: false, mode: 'ice', level: 6, far: 1, team: 1, time: 900 });
      const n1 = accounts.backfillHell((s, pids) => lb.hellResults(s, pids)), n2 = accounts.backfillHell((s, pids) => lb.hellResults(s, pids));
      lb.flush();
      const bs = (await request(accounts, 'me')).account.stats;
      ok(n1 >= 1 && n2 === 0 && bs.online.hell.clears.run[3] >= 1 && !bs.online.hell.clears.run[4] && bs.online.hell.clears.run[2] >= 1
        && bs.local.hell.clears.ice[6] === 1 && bs.local.hell.wins.ice === 1 && bs.online.hell.wins.run === 1 && bs.online.hell.clears.ice[1] === 2,
        'account stats: hell games from before filled once from the hell boards (levels below the furthest reached; an escape: a win), never lowered');
    }
    // permanent unlocks, per mode: a feat done in a mode unlocks the item in that mode only (on by default); it can be
    // switched off (everywhere); locked ones can't
    const EASY_IDS = ['specs', 'gboots', 'sskates'];   // (a normal level 8 counts for the easy unlocks too: checked on their own below)
    const none = accounts.cosFor(token, 'run');
    accounts.recordFeat(sub, 'l8', 'run'); accounts.recordFeat(sub, 'l8', 'ice');
    const inRun = accounts.cosFor(token, 'run'), inIce = accounts.cosFor(token, 'ice'), inMixed = accounts.cosFor(token, 'mixed');
    accounts.recordFeat(sub, 'l8', 'mixed'); accounts.recordFeat(sub, 'l8', 'nope'); accounts.recordFeat(sub, 'l7', 'run');
    const after = accounts.cosFor(token, 'mixed');
    const lockedOn = await request(accounts, 'equip', [Buffer.from(JSON.stringify({ item: 'gskates', on: true }))]);   // (3 needed: Skate has its own 1 + Run + Skate's 1)
    const off = await request(accounts, 'equip', [Buffer.from(JSON.stringify({ item: 'shades', on: false }))]);
    ok(none.length === 0 && inRun.filter((id) => !EASY_IDS.includes(id)).join() === 'shades' && inIce.filter((id) => !EASY_IDS.includes(id)).join() === 'shades' && inMixed.length === 0 && after.filter((id) => !EASY_IDS.includes(id)).join() === 'shades'
      && !lockedOn.ok && off.ok && accounts.cosFor(token, 'run').filter((id) => !EASY_IDS.includes(id)).join() === 'rboots' && accounts.cosFor(token, 'mixed').filter((id) => !EASY_IDS.includes(id)).length === 0   // (Run: its own clear + Run + Skate's = the 2 for the boots)
      && off.account.unlocks.l8.mixed === 1 && off.account.unlocks.off.shades === true,
    'unlocks: each mode unlocks an item for that mode (Run + Skate counts in the other two as well), bad feats / modes are ignored, switched off it is not sent');
    ok(isUnlocked({ l9: { ice: 1 } }, 'lion', 'ice') && !isUnlocked({ l9: { ice: 1 } }, 'lion', 'run') && isUnlocked({ l9: { ice: 1 } }, 'lion')
      && !isUnlocked({ l8: { run: 1, ice: 1 } }, 'rboots', 'run') && isUnlocked({ l8: { run: 2 } }, 'rboots', 'run')
      // Run + Skate counts in the other two modes too (not the other way round); the chrome lion still needs each mode itself
      && isUnlocked({ l9: { mixed: 1 } }, 'lion', 'run') && isUnlocked({ l9: { mixed: 1 } }, 'lion', 'ice') && !isUnlocked({ l9: { run: 1 } }, 'lion', 'mixed')
      && isUnlocked({ l8: { run: 1, mixed: 1 } }, 'rboots', 'run') && !isUnlocked({ l8: { run: 1, mixed: 1 } }, 'rboots', 'mixed')
      && !isUnlocked({ l9: { mixed: 1 } }, 'chrome', 'mixed') && !isUnlocked({ l8: { mixed: 3 } }, 'gskates', 'run') && isUnlocked({ l8: { mixed: 3 } }, 'gskates', 'ice')
      && isUnlocked({ win: { mixed: 1 } }, 'song5', 'run')
      && !isUnlocked({ l9: { run: 1, ice: 1 } }, 'chrome', 'run') && isUnlocked({ l9: { run: 1, ice: 1, mixed: 1 } }, 'chrome', 'ice')
      && !isUnlocked({ l8: { run: 3 } }, 'gskates') && !isUnlocked({ l8: { run: 3 } }, 'gskates', 'run') && isUnlocked({ l8: { ice: 3 } }, 'gskates', 'ice') && !isUnlocked({ l8: { ice: 3 } }, 'gskates', 'run'),
    'beating level 9 in Skate (reaching every goal) gives the lion in Skate only; items needing more clears need them in that mode; the song is for any mode; the chrome lion needs one clear in all three modes, then is worn in every mode; golden skates are only earned in Skate and Run + Skate');
    // never paid: signed in, but not active: no stats, no unlock progress, nothing sent to other players
    accounts.recordOnline('unpaid-sub', { type: 'crown' }); for (const m of ['run', 'ice', 'mixed']) accounts.recordFeat('unpaid-sub', 'l8', m);
    const unpaid = await request(accounts, 'me', [], { authorization: 'Bearer unpaid-session-token-for-regression' });
    ok(unpaid.ok && unpaid.account.active === false && unpaid.account.stats.online.crowns === 0 && unpaid.account.unlocks.l8.run === 0
      && accounts.cosFor('unpaid-session-token-for-regression').length === 0 && off.account.active === true,
    'an account that has never paid is not active: nothing is counted or shown');
    const oldG = await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid: 'oldguestprogressid0123456789' }))]);
    const newG = await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid: 'newguestprogressid0123456789' }))]);
    ok(oldG.ok && oldG.unlocks === null && newG.ok && newG.unlocks && newG.unlocks.l8.run === 1, 'guest unlock progress unused for two months is dropped, recent progress is kept');
    // no active account: the progress is kept under the browser's progress id, switched there, and moves onto the
    // account once it is active (counts add up)
    const pid = 'abcdefghijklmnopqrstuvwxyz0123';
    for (const m of ['run', 'ice', 'mixed']) accounts.recordFeat({ sub: 'unpaid-sub', pid }, 'l8', m);
    accounts.recordFeat({ pid: 'too-short' }, 'l8', 'run');
    const guestCos = accounts.cosForPlayer({ sub: 'unpaid-sub', pid }, 'ice');
    const gOff = await request(accounts, 'guestequip', [Buffer.from(JSON.stringify({ pid, item: 'shades', on: false }))]);
    const gRead = await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid }))]);
    const gBad = await request(accounts, 'guestequip', [Buffer.from(JSON.stringify({ pid, item: 'gskates', on: true }))]);
    const beforeMerge = (await request(accounts, 'me')).account.unlocks.l8.run;
    accounts.mergeGuest(sub, pid);
    const merged = (await request(accounts, 'me')).account.unlocks;
    ok(guestCos.filter((id) => !['specs', 'gboots', 'sskates'].includes(id)).join() === 'shades,rboots' && gOff.ok && gRead.unlocks.off.shades === true && !gBad.ok
      && merged.l8.run === beforeMerge + 1 && merged.l8.mixed >= 1 && (await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid }))])).unlocks === null,
    'unlocks without an account: kept under the progress id, switched there, moved onto the account once it is active');
    // the new song: the final level cleared once, in any mode, unlocks it; it is never worn (not sent) and has no switch
    const spid = 'songsongsongsongsongsong0123';
    const songBefore = (await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid: spid }))])).unlocks;
    accounts.recordFeat({ pid: spid }, 'win', 'ice');
    const songAfter = (await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid: spid }))])).unlocks;
    const songSwitch = await request(accounts, 'guestequip', [Buffer.from(JSON.stringify({ pid: spid, item: 'song5', on: false }))]);
    ok(songBefore === null && songAfter && songAfter.win.ice === 1 && isUnlocked(songAfter, 'song5') && !isUnlocked(songAfter, 'shades')
      && accounts.cosForPlayer({ pid: spid }, 'ice').length === 0 && !songSwitch.ok,
    'the new song unlocks by clearing the final level in any one mode, is not worn by the kitty and has no on / off switch');
    accounts.flush();
    ok(createAccounts(file, env).subFor(token) === sub && JSON.parse(fs.readFileSync(file)).accounts[sub].stats.online.clears.run[2] === 2,
      'account stats are saved on flush and survive a restart');
    // one credit per player: several tabs of the same account or browser in one lobby count once; reviving them doesn't count
    const tabs = [{ id: 1, acct: 'A', pid: 'p1' }, { id: 2, acct: 'A', pid: 'p1' }, { id: 3, acct: null, pid: 'p1' }, { id: 4, acct: 'A', pid: 'p2' },
      { id: 5, acct: 'B', pid: 'p3' }, { id: 6, acct: null, pid: 'p4' }, { id: 7, acct: null, pid: 'p4' }, { id: 8, acct: null, pid: '' }, { id: 9, acct: null, pid: '' }];
    ok(onePerPlayer(tabs).map((m) => m.id).join() === '1,5,6,8,9' && samePlayer(tabs[0], tabs[2]) && samePlayer(tabs[0], tabs[3])
      && !samePlayer(tabs[0], tabs[4]) && !samePlayer(tabs[7], tabs[8]),
    'stats and unlocks count once per player (account or browser), however many of its tabs are in the lobby');
    // the medic badge: 3000 revives in Multiplayer, all modes added up; a swag account brings the revives its stats had
    // counted when the badge came in (taken once: later revives count toward it as feats, not twice); worn in every mode
    for (let i = 0; i < 3; i++) accounts.recordFeat(sub, 'rev', i ? 'ice' : 'run');
    const revs = (await request(accounts, 'me')).account.unlocks.rev;
    accounts.recordOnline(sub, { type: 'revive' });
    const revsLater = (await request(accounts, 'me')).account.unlocks.rev;
    ok(Number.isFinite(revs.past) && revs.run === 1 && revs.ice === 2 && featTotal({ rev: revs }, 'rev') === revs.past + 3 && revsLater.past === revs.past
      && isUnlocked({ rev: { run: 1200, ice: 900, mixed: 600, past: 300 } }, 'medic', 'mixed') && !isUnlocked({ rev: { run: 2999 } }, 'medic', 'run')
      && isUnlocked({ rev: { ice: 3000 } }, 'medic', 'run'),
    "medic badge: 3000 revives over all modes (an account's earlier revives count once), worn in every mode");
    ok(medicLook(new Set(['medic', 'shades'])) === 'base' && medicLook(new Set(['shades'])) === '', 'the card shows the medic badge when it is switched on');
    // the offline track (Solo / Local): reported by the browser, kept on the account, never worn online (only offline,
    // account.js), but its items can be switched
    const soloRep = await request(accounts, 'progress', [Buffer.from(JSON.stringify({ mode: 'ice', solo: { l9: 1, rev: 3, nope: 5 } }))]);
    const soloU = soloRep.account && soloRep.account.unlocks;
    const lionOff = await request(accounts, 'equip', [Buffer.from(JSON.stringify({ item: 'lion', on: false }))]);
    ok(soloU && soloU.solo.l9.ice === 1 && soloU.solo.rev.ice === 3 && !soloU.l9.ice && !accounts.cosFor(token, 'ice').includes('lion')
      && isUnlocked(soloU.solo, 'lion', 'ice') && lionOff.ok && lionOff.account.unlocks.off.lion === true,
    'Solo / Local unlocks are kept apart: counted on the account, worn offline only (never sent online), switchable');
    await request(accounts, 'equip', [Buffer.from(JSON.stringify({ item: 'lion', on: true }))]);
    const unconfirmed = await request(accounts, 'delete');
    const lowercase = await request(accounts, 'delete', [Buffer.from(JSON.stringify({ confirm: 'delete' }))]);
    ok(!unconfirmed.ok && !lowercase.ok && accounts.paidFor(token) > 0, 'an account is only deleted with DELETE typed (capitals)');
    const deleted = await request(accounts, 'delete', [Buffer.from(JSON.stringify({ confirm: 'DELETE' }))]);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // any old delayed save must not bring this account back
    const kept = JSON.parse(fs.readFileSync(file)).accounts[sub];
    ok(deleted.ok && createAccounts(file, env).paidFor(token) === 0 && kept && kept.deleting > 0 && !(kept.sessions || []).length,
      'a deleted account is signed out everywhere and shows nothing, after saves settle and restart');
    // within its 14 days: signed in again (a new session), it can only be restored, and then it's back as it was
    const again = 'signed-in-again-token-for-the-grace-period';
    const stored = JSON.parse(fs.readFileSync(file));
    stored.accounts[sub].sessions = [crypto.createHash('sha256').update(again).digest('hex')];
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    const graced = createAccounts(file, env), as = { authorization: 'Bearer ' + again };
    const meDel = await request(graced, 'me', [], as);
    const payDel = await request(graced, 'pay', [Buffer.from(JSON.stringify({ cents: 50 }))], as);
    const hiddenPaid = graced.paidFor(again);
    const restored = await request(graced, 'restore', [Buffer.from('{}')], as);
    ok(meDel.ok && meDel.account.deleting && meDel.account.active === false && !payDel.ok && hiddenPaid === 0
      && restored.ok && !restored.account.deleting && restored.account.active === true && graced.paidFor(again) > 0,
    'a deleted account can be restored within its 14 days (until then it cannot pay, and shows and counts nothing)');
    // after 14 days it is gone for good
    graced.flush();
    const old = JSON.parse(fs.readFileSync(file));
    old.accounts[sub].deleting = Date.now() - 15 * 864e5;
    fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
    const gone = await request(createAccounts(file, env), 'me', [], as);
    ok(gone.signedOut === true, 'a deleted account is gone for good after 14 days');
    ok(errors.some((e) => e.includes('simulated storage failure')), 'storage failure is logged');
  } finally {
    fs.renameSync = savedRename; fs.writeFileSync = savedWrite; globalThis.fetch = savedFetch; console.error = savedError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ======== legends board: the newest wins of each mode (a busy mode can't push another off the board)
{
  const { createLegends } = await import('../server/legends.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-legends-test-'));
  try {
    const lg = createLegends(path.join(dir, 'legends.json'));
    lg.recordWin('run', 1200, [{ id: 1, name: 'Shadow', color: 1 }]);
    for (let i = 0; i < 105; i++) lg.recordWin('mixed', 1500, [{ id: 10 + i, name: 'Tofu', color: 2 }]);
    const wins = JSON.parse(lg.boardJson()).wins;
    ok(wins.filter((w) => w.mode === 'mixed').length === 100 && wins.some((w) => w.mode === 'run') && wins[0].mode === 'mixed',
      'legends board: the newest 100 of each mode, newest first (an older win of a quieter mode stays on)');
    lg.recordWin('ice', 300, [{ id: 999, name: 'Pip', color: 3 }], 2400);
    const tw = JSON.parse(lg.boardJson()).wins.find((w) => w.mode === 'ice');
    ok(tw && tw.runTime === 300 && tw.total === 2400, 'legends board: a win keeps the whole game time (total) next to the final level time');
    // the permanent lists: one entry per player (account or browser) on the firsts, best game per team on the fastest
    const amy = { id: 2001, name: 'Amy', color: 4, acct: 'acct-amy', pid: 'a'.repeat(24) }, amyNew = { id: 2002, name: 'Amy', color: 4, acct: 'acct-amy', pid: 'b'.repeat(24) };
    lg.recordWin('ice', 200, [amy], 2000); lg.recordWin('ice', 200, [amyNew], 1500); lg.recordWin('ice', 200, [amy], 1800);
    const lb = JSON.parse(lg.boardJson());
    ok(lb.firsts.ice.filter((x) => x.name === 'Amy').length === 1 && lb.fastest.ice.filter((x) => x.team[0].name === 'Amy').map((x) => x.total).join() === '1500'
      && lb.firsts.run.length === 1 && lb.firsts.mixed.length === 1 && !/acct-amy|aaaaaaaa|"keys"/.test(lg.boardJson()),
      'legends lists: first 100 different players per mode (105 wins of one name: 1), each team only with its best time, no ids sent');
    // chained games: on the latest wins and the firsts with the others (marked), their own fastest list and level boards
    {
      lg.recordWin('run', 300, [{ id: 3001, name: 'Link1', color: 5 }, { id: 3002, name: 'Link2', color: 6 }], 999, true);
      const cb = JSON.parse(lg.boardJson());
      const cf = cb.fastest.run.find((x) => x.total === 999);
      ok(cb.wins.find((w) => w.total === 999).chain === 1 && cb.firsts.run.some((x) => x.name === 'Link1' && x.chain === 1) && cf && cf.chain === 1,
        'legends: a chained win is on the latest wins and the firsts (marked) and on the chained fastest list');
      const { createLevelBoards } = await import('../server/levelboards.js');
      const lc = createLevelBoards(path.join(dir, 'levels-chain.json'));
      lc.record({ acct: 'ch-1', name: 'C1', color: 1 }, { local: false, easy: false, mode: 'run', level: 2, time: 60, team: 2, run: 'chn111', chain: true });
      lc.record({ acct: 'ch-2', name: 'C2', color: 2 }, { local: false, easy: false, mode: 'run', level: 2, time: 70, team: 2, run: 'tm2222' });
      const qb = (chain) => lc.query({ acct: 'ch-1' }, { board: { local: false, easy: false, mode: 'run', level: 2, team: true, chain }, scope: 'all' }).rows.map((r) => r.name).join();
      ok(qb(true) === 'C1' && qb(false) === 'C2', 'level boards: chained times on their own board, not with the other team times');
      // a versus game's clear: one slot, marked, its kitties in the order they came (the team with the most points first)
      for (const [order, n] of ['V3', 'V1', 'V2'].entries()) lc.record({ acct: 'vs-' + n, name: n, color: 1 }, { local: false, easy: false, mode: 'run', level: 4, time: 70, team: 3, run: 'vsrun1', vs: true, order, tm: order < 2 ? 0 : 1 });
      const vr = lc.query({ acct: 'vs-V1' }, { board: { local: false, easy: false, mode: 'run', level: 4, team: true }, scope: 'all' }).rows[0];
      ok(vr && vr.vs === 1 && vr.members.map((m) => m.name + m.tm).join() === 'V30,V10,V21', 'level boards: a versus clear is marked, its kitties named best team first (each with the place of its team)');
      // an old team time (no run: from before runs kept their players) keeps a player who gets a faster time since, greyed
      const ev3 = { local: false, easy: false, mode: 'run', level: 3, team: 2 };
      lc.record({ acct: 'old-1', name: 'O1', color: 1 }, { ...ev3, time: 80 });
      lc.record({ acct: 'old-2', name: 'O2', color: 2 }, { ...ev3, time: 80 });
      lc.record({ acct: 'old-2', name: 'O2', color: 2 }, { ...ev3, time: 50, run: 'new333' });
      const r3 = lc.query({ acct: 'old-1' }, { board: { ...ev3, level: 3, team: true }, scope: 'all' }).rows.find((r) => r.time === 80);
      ok(r3 && !r3.more && r3.members.map((m) => m.name + (m.gone ? '-' : '')).join() === 'O1,O2-', 'level boards: an old team time keeps a player with a faster time since, greyed (not +1)');
      lc.flush();
    }
    // chained games: a kitty joining a chain of three takes its last kitty (two pairs), right beside it; everyone on one
    // chain: a newcomer goes on its end
    {
      const { createSim, addPlayer, removePlayer, chainJoin, chainLeave, stepSim } = await import('../public/js/shared/sim.js');
      const K = (n) => [...Array(n)].map((_, i) => ({ id: i + 1, name: 'k' + i, color: 0 }));
      const s3 = createSim({ seed: 3, players: K(3), mode: 'run', chain: true });
      const p4 = addPlayer(s3, { id: 4, name: 'k3', color: 0 }); chainJoin(s3, p4);
      const p3 = s3.players[2];
      ok(JSON.stringify(s3.chains) === '[[1,2],[3,4]]' && Math.hypot(p4.x - p3.x, p4.z - p3.z) < 1.5, 'chained: a 4th kitty joining a chain of three makes two pairs, beside its partner');
      const sa = createSim({ seed: 3, players: K(3), mode: 'run', chain: 'all' });
      const pa = addPlayer(sa, { id: 4, name: 'k3', color: 0 }); chainJoin(sa, pa);
      ok(sa.chainAll && JSON.stringify(sa.chains) === '[[1,2,3,4]]', 'everyone chained: one chain, a newcomer on its end');
      // leaving: off the end of a chain that keeps two kitties at once; from the middle an anchor until one of the chain
      // touches its spot, then the chain joins up; removePlayer alone (a client) never leaves one
      chainLeave(sa, 4); removePlayer(sa, 4);
      ok(JSON.stringify(sa.chains) === '[[1,2,3]]' && !Object.keys(sa.anchors).length, 'chained: one leaving off the end of a chain of three just goes');
      const mid = sa.players[1], mx = mid.x, mz = mid.z;
      chainLeave(sa, 2); removePlayer(sa, 2);
      const held = JSON.stringify(sa.chains) === '[[1,2,3]]' && !!sa.anchors[2];
      const k1 = sa.players[0]; k1.x = mx + 0.5; k1.z = mz;
      stepSim(sa, {}, 1 / 60);
      ok(held && JSON.stringify(sa.chains) === '[[1,3]]' && !sa.anchors[2], 'chained: one leaving from the middle leaves an anchor; touching its spot joins the chain up');
      const sc = createSim({ seed: 3, players: K(2), mode: 'run', chain: true });
      removePlayer(sc, 2);
      ok(!Object.keys(sc.anchors).length, 'chained: removePlayer alone (a client following the server) makes no anchor');
      // one left on its own: touching doesn't let go; the next kitty to join takes the place that was left, right there
      const sd = createSim({ seed: 3, players: K(2), mode: 'run', chain: true }), q2 = sd.players[1], ax = q2.x, az = q2.z;
      chainLeave(sd, 2); removePlayer(sd, 2);
      sd.players[0].x = ax; sd.players[0].z = az; stepSim(sd, {}, 1 / 60);
      const stillHeld = !!sd.anchors[2];
      const q9 = addPlayer(sd, { id: 9, name: 'new', color: 0 }); chainJoin(sd, q9);
      ok(stillHeld && JSON.stringify(sd.chains) === '[[1,9]]' && !sd.anchors[2] && q9.x === ax && q9.z === az, 'chained: one left alone stays held; a newcomer takes the place that was left, where it was');
      // boots shared on a chain (not with another chain); one caught costs the chain half its pairs (rounded up); back up
      // (revived), it has the chain's again
      const sb = createSim({ seed: 3, players: K(4), mode: 'run', chain: true }), [b1, b2, b3] = sb.players;
      for (const q of sb.players) q.invuln = 99;
      const boot = (q) => { sb.items.push({ id: 900 + sb.items.length, type: 'boots', x: q.x, z: q.z, taken: false }); stepSim(sb, {}, 1 / 60); };
      boot(b1); boot(b2); boot(b1);
      const shared = Math.round((b2.speedMult - 1) * 100) === 15 && b3.speedMult === 1;
      b1.invuln = 0; b1.shield = 0; b1.lives = 0;
      const w = sb.enemies[0];
      for (let t = 0; t < 30 && b1.alive; t++) { b1.x = b2.x = w.x; b1.z = b2.z = w.z; stepSim(sb, {}, 1 / 60); }   // (out of the safe start)
      const half = !b1.alive && Math.round((b2.speedMult - 1) * 100) === 5;
      b2.x = sb.circles.find((c) => c.playerId === 1).x; b2.z = sb.circles.find((c) => c.playerId === 1).z;
      for (let t = 0; t < 30 && !b1.alive; t++) stepSim(sb, {}, 1 / 60);
      ok(shared && half && b1.alive && Math.round((b1.speedMult - 1) * 100) === 5, 'chained: boots shared on a chain (not another), one caught costs half (3 pairs: 1 left), revived it gets the chain boots');
    }
    // versus: only your own team revives you; a team takes the crown once all of it has been in the goal (one crown for
    // the team, everyone wears it); its points: the slowest kitty's distance (the goal: a whole map) and the crown
    {
      const { createSim, stepSim, vsScore } = await import('../public/js/shared/sim.js');
      const T = 1 / 60, s = createSim({ seed: 3, mode: 'run', versus: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }] });
      stepSim(s, {}, T);
      const [a, b, c] = s.players;
      for (const p of s.players) p.invuln = 99;
      b.alive = false; s.circles.push({ playerId: 2, x: b.x, z: b.z, t: 5 });
      c.x = b.x; c.z = b.z; a.x = 30; a.z = 30;
      for (let i = 0; i < 5; i++) stepSim(s, {}, T);
      const noCross = !b.alive;
      a.x = b.x; a.z = b.z; c.x = 30;
      for (let i = 0; i < 5; i++) stepSim(s, {}, T);
      const own = b.alive && s.teams[1].revives === 1 && s.teams[2].revives === 0;
      const cr = s.levelData.crown;
      a.x = cr.x; a.z = cr.z;
      for (let i = 0; i < 5; i++) stepSim(s, {}, T);
      const blocked = !s.crownTaken;
      b.x = 0.5; b.z = 0.5;
      for (let i = 0; i < 5 && !s.crownTaken; i++) { a.x = cr.x; a.z = cr.z; stepSim(s, {}, T); }
      ok(noCross && own && blocked && s.crownTaken && s.state === 'levelclear' && s.teams[1].crowns === 1 && b.crowned && b.finishes === 1 && vsScore(s.teams[1]) === 25 && vsScore(s.teams[2]) < 20,
        'versus: only your team revives you; the crown once the whole team was in the goal (one crown, everyone wears it); points: the slowest kitty\'s way and the crown');
      // leaving: a catch for the team and a spot where it was; the crown waits until a teammate has touched it; back, it
      // is at the teammate furthest behind
      const { vsLeave, vsReturn, addPlayer, removePlayer } = await import('../public/js/shared/sim.js');
      const v = createSim({ seed: 4, mode: 'run', versus: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }] });
      stepSim(v, {}, T);
      const [va, vb] = v.players;
      for (const p of v.players) p.invuln = 99;
      vb.x = va.x + 6; vb.z = va.z; const bx = vb.x;
      vsLeave(v, 2); removePlayer(v, 2);
      const left = v.teams[1].deaths === 1 && !!v.vsLeft[2];
      const vc = v.levelData.crown;
      v.enteredCenter.push(1); va.x = vc.x; va.z = vc.z;
      for (let i = 0; i < 3; i++) stepSim(v, {}, T);
      const waits = !v.crownTaken;
      va.x = bx; va.z = vb.z; stepSim(v, {}, T);
      const picked = v.vsLeft[2] && v.vsLeft[2].by === 1;
      va.x = bx + 2; stepSim(v, {}, T);
      const stillHere = v.vsLeft[2] && v.vsLeft[2].by === 1 && v.vsLeft[2].x === va.x && !v.crownTaken;   // (carried along, not home yet)
      for (let i = 0; i < 3 && !v.crownTaken; i++) { va.x = vc.x; va.z = vc.z; stepSim(v, {}, T); }
      const home = !v.vsLeft[2] && v.crownTaken;
      const back = addPlayer(v, { id: 9, name: 'b', color: 0, team: 1 }); vsReturn(v, 2, back);
      ok(left && waits && picked && stillHere && home && back.x === va.x && back.z === va.z, 'versus: leaving costs a catch and leaves a spot a teammate picks up and carries into the goal before the crown; back, it is at its teammate furthest behind');
      // back while being carried: it is where its carrier is
      const u = createSim({ seed: 4, mode: 'run', versus: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 1 }, { id: 4, name: 'd', team: 2 }] });
      stepSim(u, {}, T);
      const [ua, ub, uc] = u.players;
      for (const p of u.players) p.invuln = 99;
      ub.x = ua.x + 6; uc.x = ua.x - 2;
      vsLeave(u, 2); removePlayer(u, 2);
      ua.x = ub.x; ua.z = ub.z; stepSim(u, {}, T); ua.x += 3; stepSim(u, {}, T);
      const ub2 = addPlayer(u, { id: 8, name: 'b', color: 0, team: 1 }); vsReturn(u, 2, ub2);
      ok(ub2.x === ua.x && ub2.z === ua.z && !u.vsLeft[2], 'versus: back while being carried, it is where its carrier is');
      // a checkpoint gathers only the team of the kitty that reached it (the others can still reach it for theirs), and the
      // gathered teammates' way counts for the team's points (unlike the score's distance elsewhere)
      const q = createSim({ seed: 7, mode: 'mixed', versus: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }] });
      stepSim(q, {}, T);
      const qcp = q.levelData.checkpoints.find((x) => !x.medic), [qa, qb, qc] = q.players;
      for (const p of q.players) p.invuln = 99;
      qa.x = qcp.x; qa.z = qcp.z; stepSim(q, {}, T); stepSim(q, {}, T);
      const gathered = Math.hypot(qb.x - qcp.x, qb.z - qcp.z) < 6 && Math.hypot(qc.x - qcp.x, qc.z - qcp.z) > 6 && q.teams[1].cur > 0.2;
      qc.x = qcp.x; qc.z = qcp.z; stepSim(q, {}, T);
      ok(gathered && q.vsCp[2] && q.vsCp[2].length === 1, 'versus: a checkpoint gathers only its own team (each team reaches it for itself); the gathered teammates\' way counts for the team\'s points');
      // chained versus: one left alone on its team's chain picks the other up and drags it behind on the chain (no running
      // about unchained), home in the goal it's done and the chain lets go
      const { chainLeave } = await import('../public/js/shared/sim.js');
      const w = createSim({ seed: 4, mode: 'run', versus: true, chain: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }] });
      stepSim(w, {}, T);
      const [wa, wb] = w.players;
      chainLeave(w, 2); vsLeave(w, 2); removePlayer(w, 2);
      const held = !!w.anchors[2];
      wa.x = wb.x; wa.z = wb.z; stepSim(w, {}, T);
      const dragged = !!(w.anchors[2] && w.anchors[2].drag) && w.vsLeft[2] && w.vsLeft[2].by === 1 && JSON.stringify(w.chains) === '[[1,2],[3]]';
      const ax0 = w.anchors[2].x, az0 = w.anchors[2].z, dl = Math.hypot(wa.x, wa.z), dir = { x: -wa.x / dl, z: -wa.z / dl };
      for (let i = 0; i < 150; i++) { wa.invuln = 99; stepSim(w, { 1: dir }, T); }   // (running toward the middle)
      const pulled = Math.hypot(w.anchors[2].x - ax0, w.anchors[2].z - az0) > 0.5;
      wa.x = 1; wa.z = 0.5; stepSim(w, {}, T); stepSim(w, {}, T);
      ok(held && dragged && pulled && !w.vsLeft[2] && !w.anchors[2] && JSON.stringify(w.chains) === '[[1],[3]]',
        'chained versus: one left alone on its chain picks the other up and drags it on the chain; home in the goal, the chain lets go');
      // ...one leaving off the end of a chain keeps it held too (until its team picks it up: then the chain lets go and
      // it's carried); back while carried, it's at its carrier
      const x = createSim({ seed: 4, mode: 'run', versus: true, chain: 'all', players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 1 }, { id: 4, name: 'd', team: 2 }] });
      stepSim(x, {}, T);
      const [xa, , xc] = x.players;
      for (const p of x.players) p.invuln = 99;
      chainLeave(x, 3); vsLeave(x, 3); removePlayer(x, 3);
      const endHeld = !!x.anchors[3];
      xa.x = xc.x; xa.z = xc.z; stepSim(x, {}, T);
      const pickedUp = !x.anchors[3] && x.vsLeft[3] && x.vsLeft[3].by === 1;
      const xc2 = addPlayer(x, { id: 7, name: 'c', color: 0, team: 1 }), carried = vsReturn(x, 3, xc2);
      ok(endHeld && pickedUp && carried === true && xc2.x === xa.x && xc2.z === xa.z && JSON.stringify(x.chains) === '[[1,7,2],[4]]',
        'chained versus: one leaving off the end of a chain is held there until picked up (then the chain lets go); back while carried, at its carrier and chained to it');
      // joining up: two on their own (their partners left) join up into the team with more points; one partner back: a
      // chain of three; both back: two pairs again, the team that wasn't kept with its points plus what was scored since
      const { loneOf, groupJoin, mergeReturn } = await import('../public/js/shared/sim.js');
      const j = createSim({ seed: 4, mode: 'run', versus: true, chain: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }, { id: 4, name: 'd', team: 2 }] });
      stepSim(j, {}, T);
      j.teams[1].crowns = 2;
      for (const id of [2, 4]) { chainLeave(j, id); vsLeave(j, id); removePlayer(j, id); }
      const lone = !!loneOf(j, 1) && !!loneOf(j, 3);
      const joined = groupJoin(j, 3, 1) && JSON.stringify(j.chains) === '[[1,3]]' && j.players.every((p) => p.team === 1) && !Object.keys(j.anchors).length;
      j.teams[1].crowns++;   // (scored together)
      const jb = addPlayer(j, { id: 9, name: 'b', team: 1 }), three = mergeReturn(j, 2, jb) && JSON.stringify(j.chains) === '[[1,9,3]]';
      const jd = addPlayer(j, { id: 10, name: 'd', team: 2 }), split = mergeReturn(j, 4, jd) && JSON.stringify(j.chains) === '[[1,9],[3,10]]'
        && [1, 9, 3, 10].map((id) => j.players.find((p) => p.id === id).team).join() === '1,1,2,2' && j.teams[2].crowns === 1 && j.teams[1].crowns === 3;
      ok(lone && joined && three && split, 'chained versus: two on their own join up (the team with more points kept); one partner back makes three, both back split into two pairs (points scored together go to both)');
      // two of three leaving: the one left drags one body only (the other ring goes); down on its own, joining another
      // group brings it back up
      const o = createSim({ seed: 4, mode: 'run', versus: true, chain: 'all', players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 1 }, { id: 4, name: 'd', team: 2 }, { id: 5, name: 'e', team: 2 }] });
      stepSim(o, {}, T);
      const [oa, ob] = o.players;
      for (const id of [2, 3]) { chainLeave(o, id); vsLeave(o, id); removePlayer(o, id); }
      oa.x = ob.x; oa.z = ob.z; oa.invuln = 99; stepSim(o, {}, T);
      const oneBody = Object.keys(o.anchors).join() === '2' && o.anchors[2].drag && o.vsLeft[3] && !o.vsLeft[3].by && JSON.stringify(o.chains) === '[[1,2],[4,5]]';
      oa.alive = false; o.circles.push({ playerId: 1, x: oa.x, z: oa.z, t: 0 });
      const upAgain = groupJoin(o, 1, 4) && oa.alive && !o.circles.some((c) => c.playerId === 1) && oa.team === 2 && JSON.stringify(o.chains) === '[[4,5,1]]';
      ok(oneBody && upAgain, 'chained versus: two of three leaving, the one left drags one body only (the other comes off the chain, still to be carried); down on its own, joining another team brings it back up');
      // a new level: a ring comes along to the start, beside its partner, to be picked up there again
      const lv = createSim({ seed: 4, mode: 'run', versus: true, chain: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }, { id: 4, name: 'e', team: 2 }] });
      stepSim(lv, {}, T);
      lv.players[1].x += 5; chainLeave(lv, 2); vsLeave(lv, 2); removePlayer(lv, 2);
      lv.state = 'levelclear'; lv.stateTimer = 0.001; stepSim(lv, {}, T); stepSim(lv, {}, T);
      ok(lv.level === 2 && Math.hypot(lv.anchors[2].x - lv.players[0].x, lv.anchors[2].z - lv.players[0].z) < 1.5 && !!lv.vsLeft[2], 'chained versus: at a new level the ring of one that left comes along beside its partner, to be picked up there');
      // pairs: a teammate on another chain can't pick up a ring still holding a kitty (it would run unchained); its partner
      // can. A whole pair gone: any teammate picks a ring up, and at a new level the rings come to the start by a teammate
      const pr = createSim({ seed: 4, mode: 'run', versus: true, chain: true, players: [1, 2, 3, 4].map((id) => ({ id, name: 'k' + id, team: 1 })).concat([{ id: 5, name: 'e', team: 2 }, { id: 6, name: 'f', team: 2 }]) });
      stepSim(pr, {}, T);
      for (const p of pr.players) p.invuln = 99;
      const pairs = JSON.stringify(pr.chains);
      const [p1, p2, p3] = pr.players;
      p2.x = p1.x + 3; chainLeave(pr, 2); vsLeave(pr, 2); removePlayer(pr, 2);
      p3.x = pr.anchors[2].x; p3.z = pr.anchors[2].z; stepSim(pr, {}, T);
      const notOther = !!pr.anchors[2] && !pr.vsLeft[2].by && pr.chains.some((c) => c.join() === '1,2');
      p1.x = pr.anchors[2].x; p1.z = pr.anchors[2].z; stepSim(pr, {}, T);
      const partner = pr.vsLeft[2] && pr.vsLeft[2].by === 1 && pr.anchors[2] && pr.anchors[2].drag;
      ok(pairs === '[[1,2],[3,4],[5,6]]' && notOther && partner, 'chained versus: a teammate on another chain cannot pick up a ring still holding a kitty; its partner can (and drags it)');
      const gp = createSim({ seed: 4, mode: 'run', versus: true, chain: true, players: [1, 2, 3, 4].map((id) => ({ id, name: 'k' + id, team: 1 })).concat([{ id: 5, name: 'e', team: 2 }, { id: 6, name: 'f', team: 2 }]) });
      stepSim(gp, {}, T);
      for (const p of gp.players) p.invuln = 99;
      gp.players[2].x += 4;
      for (const id of [3, 4]) { chainLeave(gp, id); vsLeave(gp, id); removePlayer(gp, id); }
      gp.state = 'levelclear'; gp.stateTimer = 0.001; stepSim(gp, {}, T); stepSim(gp, {}, T);
      const g1 = gp.players[0], near = [3, 4].every((id) => gp.vsLeft[id] && Math.hypot(gp.vsLeft[id].x - g1.x, gp.vsLeft[id].z - g1.z) < 4);
      ok(gp.level === 2 && near && [3, 4].some((id) => gp.vsLeft[id].by && !gp.anchors[id]),
        'chained versus: a whole pair gone, at a new level their rings come to the start by a teammate; any teammate picks one up (carried, not dragged)');
      // back in time and not carried: where it left (not ahead at a teammate); until then its team is held back at how
      // far it had got; no pickups while the level is over
      const nr = createSim({ seed: 4, mode: 'run', versus: true, players: [{ id: 1, name: 'a', team: 1 }, { id: 2, name: 'b', team: 1 }, { id: 3, name: 'c', team: 2 }] });
      stepSim(nr, {}, T);
      for (const p of nr.players) p.invuln = 99;
      const [na, nb] = nr.players;
      nb.x = na.x + 4; stepSim(nr, {}, T);
      const sx = nb.x, sz = nb.z;
      vsLeave(nr, 2); removePlayer(nr, 2);
      const sf = nr.vsLeft[2].f;
      nr.players[0].runBest = 0.9; stepSim(nr, {}, T);
      const heldBack = sf != null && nr.teams[1].cur <= sf + 1e-9;
      nr.state = 'levelclear'; nr.stateTimer = 99; na.x = sx; na.z = sz; stepSim(nr, {}, T);
      const noPick = !nr.vsLeft[2].by;
      nr.state = 'playing'; na.x = sx - 8;
      const nb2 = addPlayer(nr, { id: 9, name: 'b', color: 0, team: 1 }), was = vsReturn(nr, 2, nb2);
      ok(heldBack && noPick && was === false && nb2.x === sx && nb2.z === sz && !nr.vsLeft[2], 'versus: one that left holds its team back at how far it got; no pickups while the level is over; back, not carried, it is where it left');
    }
    // level boards: a team's time once, with everyone in it (one run); another team with the same time stays its own slot
    {
      const { createLevelBoards } = await import('../server/levelboards.js');
      const lb = createLevelBoards(path.join(dir, 'levels-teams.json'));
      const P = (i) => ({ acct: 'team-acct-' + i, name: 'K' + i, color: i });
      for (let i = 1; i <= 4; i++) lb.record(P(i), { local: false, easy: false, mode: 'run', level: 3, time: 90, team: 4, run: 'aaa111' });
      for (let i = 5; i <= 6; i++) lb.record(P(i), { local: false, easy: false, mode: 'run', level: 3, time: 90, team: 2, run: 'bbb222' });
      lb.record(P(7), { local: false, easy: false, mode: 'run', level: 3, time: 95, team: 2, run: 'ccc333' });
      const q = lb.query(P(3), { board: { local: false, easy: false, mode: 'run', level: 3, team: true }, scope: 'all' });
      const [a, b, c] = q.rows;
      ok(q.rows.length === 3 && a.members.length === 4 && a.me && a.members.some((m) => m.me && m.name === 'K3') && b.members.length === 2 && c.name === 'K7' && c.members.length === 1 && c.more === 1
        && q.me.rank === 1 && q.n === 7,
        'level boards: a team time takes one slot with everyone in it; another team with the same time is its own slot');
      // one of the 4 then sets a faster time with someone else: the new run shows them; the old one keeps all 4, that one
      // greyed in its place
      lb.record(P(2), { local: false, easy: false, mode: 'run', level: 3, time: 80, team: 2, run: 'ddd444' });
      lb.record(P(8), { local: false, easy: false, mode: 'run', level: 3, time: 80, team: 2, run: 'ddd444' });
      const q2 = lb.query(P(2), { board: { local: false, easy: false, mode: 'run', level: 3, team: true }, scope: 'all' });
      const old4 = q2.rows.find((r) => r.time === 90 && r.team === 4);
      ok(q2.rows[0].time === 80 && q2.rows[0].members.map((m) => m.name).join() === 'K2,K8' && q2.rows[0].me
        && old4 && old4.members.map((m) => m.name + (m.gone ? '-' : '')).join() === 'K1,K2-,K3,K4' && !old4.me && q2.me.rank === 1,
        'level boards: a player with a faster time since stays in the old team slot, greyed in its place (still the best of the others)');
      // a team the board can't name everyone of (a run from before runs kept their players): the rest as a count
      lb.record(P(9), { local: false, easy: false, mode: 'run', level: 3, time: 99, team: 3 });
      const q3 = lb.query(P(9), { board: { local: false, easy: false, mode: 'run', level: 3, team: true }, scope: 'all' }).rows.find((r) => r.time === 99);
      ok(q3 && q3.members.length === 1 && q3.more === 2, 'level boards: teammates the board can no longer name show as a count (+2)');
      lb.flush();
      // team times from before runs: a missing teammate is found on another level board of the same kind (the whole
      // team together there) when their time here is faster; one the boards can't place stays a count
      {
        const f = path.join(dir, 'levels-old.json'), now = Date.now(), B = (lv) => 'on:run:' + lv + ':t';
        const pl = (n, b) => ({ n, c: 1, f: [], b, at: now });
        fs.writeFileSync(f, JSON.stringify({ players: {
          aA: pl('Ann', { [B(2)]: [50, now - 60000, 3], [B(3)]: [70, now - 30000, 3] }),
          aB: pl('Bo', { [B(2)]: [50, now - 60001, 3], [B(3)]: [70, now - 30001, 3] }),
          aC: pl('Cy', { [B(2)]: [50, now - 60002, 3], [B(3)]: [60, now - 1000, 2] }),   // (Cy: level 3 faster since, with Dee)
          aD: pl('Dee', { [B(3)]: [60, now - 1001, 2] }),
          aE: pl('Eve', { [B(4)]: [99, now - 500, 3] }),   // (a team of 3 nobody else is in: +2)
        } }));
        const ol = createLevelBoards(f);
        const Q = (lv) => ol.query({ acct: 'nobody' }, { board: { local: false, easy: false, mode: 'run', level: lv, team: true }, scope: 'all' }).rows;
        const r3 = Q(3).find((r) => r.time === 70), r4 = Q(4)[0];
        ok(r3 && r3.members.map((m) => m.name + (m.gone ? '-' : '')).sort().join() === 'Ann,Bo,Cy-' && r3.members[2].gone && !r3.more && r4.more === 2,
          'level boards: an old team slot finds its missing teammate on another level board (greyed); one it cannot place is a count');
        ol.flush();
      }
    }
    // the STATS page: hell games counted on their own (per hell mode, online ones too), not in the modes played
    {
      const { createStats } = await import('../server/stats.js');
      const st = createStats(path.join(dir, 'stats.json'));
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'ice', hell: true });
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'solo', mode: 'ice', hell: true });
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'ice' });
      const bad = st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'ice', hell: 'yes' });
      const sm = st.summary(0);
      ok(sm.hell.games.ice === 2 && sm.hell.online.ice === 1 && sm.hell.games.run === 0 && sm.modes.ice === 1 && sm.kinds.solo === 0 && sm.totals.runs === 3 && !bad,
        'stats page: hell games counted apart (per hell mode, online ones too), not in the modes played; a bad hell flag refused');
      // chained games: counted (online ones too) as well as in their usual mode
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'run', chain: true });
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'coop', mode: 'mixed', chain: true });
      const badc = st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'coop', mode: 'mixed', chain: 1 });
      const sc = st.summary(0);
      ok(sc.chain.games === 2 && sc.chain.online === 1 && sc.modes.run === 1 && sc.kinds.coop === 1 && !badc, 'stats page: chained games counted (online ones too), and in their mode as usual');
      // versus games: counted (and in their kind and mode as usual); its plays key has versus last
      const vsBefore = st.summary(0).modes.run;
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'run', versus: true });
      const badv = st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'run', versus: 1 });
      const sv = st.summary(0);
      ok(sv.versus.games === 1 && sv.modes.run === vsBefore + 1 && !badv, 'stats page: versus games counted, and in their mode as usual');
      st.record({ cid: 'hellstat01', ev: 'run_start', kind: 'online', mode: 'ice', chain: 'all', easy: true });
      const pl = Object.values(st.summary(0).plays)[0] || {};
      ok(pl['online:ice:hell:normal:off'] === 1 && pl['solo:ice:hell:normal:off'] === 1 && pl['coop:mixed:game:normal:pairs'] === 1 && pl['online:ice:game:easy:everyone'] === 1 && st.summary(0).chain.games === 3,
        'stats: every game started counted by all its choices (kind, mode, hell, easy, chain) per month, for the JSON only');
    }
    // a repeat win under a new name: the first-clear entry takes the name, its line and time stay; another player changes nothing
    {
      const lr = createLegends(path.join(dir, 'legends-rename.json'));
      const bo = { id: 4001, name: 'Bo', color: 1, acct: 'acct-bo' };
      lr.recordWin('run', 200, [bo], 2000);
      lr.sign({ id: 4001, tok: '', acct: 'acct-bo', name: 'Bo' }, 'first!');
      const before = JSON.parse(lr.boardJson()).firsts.run[0];
      lr.recordWin('run', 200, [{ ...bo, id: 4002, name: 'BoCat' }], 1400);
      lr.sign({ id: 4002, tok: '', acct: 'acct-bo', name: 'BoCat' }, 'faster now');
      lr.recordWin('run', 200, [{ id: 4003, name: 'Bo', color: 1, acct: 'acct-other' }], 1300);
      const F = JSON.parse(lr.boardJson()).firsts.run;
      ok(before.text === 'first!' && F[0].name === 'BoCat' && F[0].text === 'first!' && F[0].total === 2000 && F[0].at === before.at && F[1].name === 'Bo' && F.length === 2,
        'legends first 100: a later win renames the first-clear entry; its line, date and time stay (another account with that name: its own)');
    }
    const rk = lg.ranksFor({ acct: 'acct-amy' }), rk2 = lg.ranksFor({ pids: ['b'.repeat(24)] }), rk0 = lg.ranksFor({ acct: 'nobody' });
    ok(rk.length === 1 && rk[0].mode === 'ice' && rk[0].first >= 1 && rk[0].fastest >= 1 && rk[0].total === 1500 && rk2.length === 1 && !rk0.length,
      'legends lists: an account (or a browser it played on) finds its places for the swag account menu');
    // the golden kitty: the first team to win a mode (Shadow in Run only); the bronze kitty: each new number 1 of a fastest
    // list (four per mode: online / local, solo / team), kept for good
    const P = (id, n) => ({ id, name: n, color: 1, acct: 'gk-' + n });
    lg.recordWin('run', 100, [P(3001, 'A'), P(3002, 'B')], 3000); lg.recordWin('run', 100, [P(3003, 'C')], 3500); lg.recordWin('run', 100, [P(3004, 'D')], 2500); lg.recordWin('run', 100, [P(3005, 'E')], 2400);
    lg.recordWin('run', 100, [P(3006, 'F')], 2600);
    const gk = (n) => lg.goldenFor({ acct: 'gk-' + n }), bk = (n) => lg.bronzeFor({ acct: 'gk-' + n });
    ok(!['A', 'B', 'C', 'D', 'E'].some(gk) && !lg.goldenFor({ acct: 'acct-amy' }) && lg.goldenFor({}) === false,
      'golden kitty: only the first team to beat a mode, not a fastest game');
    ok(bk('A') && bk('B') && bk('C') && bk('D') && bk('E') && !bk('F') && lg.bronzeFor({ acct: 'acct-amy' }) && !lg.bronzeFor({ acct: 'nobody' }),
      'bronze kitty: each new number 1 of a fastest list (A+B the first team game; C, D, E solo), kept when beaten; not a slower one (F)');
    const fr = JSON.parse(lg.boardJson()).fastest.run, rkE = lg.ranksFor({ acct: 'gk-E' })[0], rkB = lg.ranksFor({ acct: 'gk-B' })[0];
    ok(fr.filter((x) => !x.chain).length === 5 && rkE.fastest === 1 && rkE.list === 'os' && rkB.fastest === 1 && rkB.list === 'ot',
      'legends fastest: solo and team games on lists of their own (each has its own number 1)');
    // a swag number shows on the boards (on hover): only the accounts index.js hands in, by their key
    lg.setPaid((keys) => (keys.includes(lg.acctKey('gk-E')) ? 1234 : 0));
    const pb = JSON.parse(lg.boardJson()), eTeam = pb.fastest.run.find((x) => x.team[0].name === 'E');
    ok(eTeam.team[0].paid === 1234 && !pb.fastest.run.find((x) => x.team[0].name === 'D').team[0].paid
      && pb.wins.find((w) => w.entries[0] && w.entries[0].name === 'E').entries[0].paid === 1234 && !/gk-E/.test(lg.boardJson()),
      'legends board: a player\'s swag number goes with their name (fastest list, latest wins), no ids sent');
    lg.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ======== level boards: every level's fastest clears, a board per online / local, normal / easy, mode, level, solo / team
{
  const { createLevelBoards } = await import('../server/levelboards.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-levels-test-'));
  try {
    const lb = createLevelBoards(path.join(dir, 'levels.json'));
    const pid = (c) => c.repeat(24), who = (c, extra = {}) => ({ pid: pid(c), fid: ('fid' + c).padEnd(16, c), name: 'K' + c, color: 1, ...extra });
    const B = { mode: 'run', level: 1 };
    lb.record(who('a'), { ...B, time: 40, team: 1 }); lb.record(who('a'), { ...B, time: 50, team: 1 }); lb.record(who('a'), { ...B, time: 35, team: 1 });
    lb.record(who('b'), { ...B, time: 30, team: 2 }); lb.record(who('c'), { ...B, time: 30, team: 2 });
    lb.record(who('d'), { ...B, time: 20, team: 1, easy: true }); lb.record(who('e'), { ...B, time: 10, team: 1, local: true });
    lb.record(who('f'), { ...B, time: 2, team: 1 });   // (too quick to be real)
    const q = (w, board, more = {}) => lb.query(w, { board: { ...B, ...board }, ...more });
    const solo = q(who('a'), {}), team = q(who('z'), { team: true });
    ok(solo.rows.length === 1 && solo.rows[0].time === 35 && solo.rows[0].me && solo.me.rank === 1 && team.rows.length === 1 && team.rows[0].members.length === 2 && !team.me   // (b and c: one team, same time, same moment)
      && q(who('a'), { easy: true }).rows.map((r) => r.time).join() === '20' && q(who('a'), { local: true }).rows.map((r) => r.time).join() === '10'
      && !JSON.stringify(solo).includes(pid('a')),
      'level boards: each player only its best, solo / team / easy / local apart, too-quick times dropped, no ids sent');
    lb.record(who('g'), { mode: 'run', level: 9, time: 300, team: 1 });
    ok(q(who('a'), { level: 9 }).err && !q(who('a'), {}).can9 && q(who('g'), { level: 9 }).rows.length === 1 && q(who('g'), {}).can9
      && (lb.reach(who('a')), q(who('a'), { level: 9 }).rows.length === 1),
      'level boards: level 9 only for players who have reached it');
    lb.setReachedBefore((w) => !!w.seen9);
    ok(q(who('k'), { level: 9 }).err && q(who('k', { seen9: true }), { level: 9 }).rows.length === 1 && q(who('k'), { level: 9 }).rows.length === 1,
      'level boards: level 9 also for players who played it before the boards existed (remembered from then on)');
    const fr = q(who('a'), { team: true }, { scope: 'friends', fids: [who('b').fid] });
    ok(fr.rows.length === 1 && fr.rows[0].name === 'Kb', 'level boards: the friends board shows only the starred friends (by friend id)');
    const g = lb.createGroup(who('a'), 'Crew').group, j = lb.joinGroup(who('b'), g.code.toLowerCase());
    const gq = q(who('b'), { team: true }, { scope: 'group', group: g.id }), out = q(who('c'), { team: true }, { scope: 'group', group: g.id });
    ok(g.code.length === 6 && j.group && gq.rows.length === 1 && gq.rows[0].me && out.err && lb.joinGroup(who('b'), 'NOPE99').err
      && (lb.leaveGroup(who('b'), g.id), lb.groupsOf(who('b')).length === 0 && lb.groupsOf(who('a')).length === 1),
      'level boards: a group by its join code (any case), members only, leaving it');
    // a fresh-start group: only times set after it was made; its owner can remove a player (who can't join again)
    const fg = lb.createGroup(who('a'), 'Fresh', true).group;
    lb.joinGroup(who('b'), fg.code); lb.joinGroup(who('c'), fg.code);
    lb.record(who('b'), { ...B, time: 45, team: 2 });   // (slower than b's best of 30, but new)
    const fq = q(who('a'), { team: true }, { scope: 'group', group: fg.id });
    const tokC = lb.groupsOf(who('a')).find((x) => x.id === fg.id).members.find((m) => m.name === 'Kc').t;
    const notOwner = lb.removeMember(who('b'), fg.id, tokC).err, rm = lb.removeMember(who('a'), fg.id, tokC);
    ok(fg.fresh && fq.rows.length === 1 && fq.rows[0].time === 45 && notOwner && !rm.err && lb.groupsOf(who('c')).every((x) => x.id !== fg.id)
      && lb.joinGroup(who('c'), fg.code).err && !lb.groupsOf(who('b')).find((x) => x.id === fg.id).members
      && (lb.restartGroup(who('a'), fg.id), q(who('a'), { team: true }, { scope: 'group', group: fg.id }).rows.length === 0),
      'level boards: a fresh-start group counts only new times; its owner (only) removes players for good and restarts it');
    // signing in on a browser moves its times to the account
    lb.record(who('h'), { ...B, time: 33, team: 1 });
    const acc = who('h', { acct: 'acct-h' });
    const after = q(acc, {});
    ok(after.me && after.me.time === 33 && after.rows.filter((r) => r.name === 'Kh').length === 1, 'level boards: a browser\'s times move to the account playing on it');
    lb.setPaid((k) => (k === lb.acctKey('acct-h') ? 500 : 0));
    ok(q(acc, {}).rows.find((r) => r.name === 'Kh').paid === 500 && !q(acc, {}).rows.find((r) => r.name === 'Ka').paid,
      'level boards: a signed-in player\'s swag number goes with their name');
    lb.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// finale version 15: Run only's level 9 wolves start slower and speed up to RUN_RAMP_TOP at the goal room (same wolves, same places)
{
  const a = generateLevel(SKATE_FINAL_LEVEL, 5, 'run', 14), b = generateLevel(SKATE_FINAL_LEVEL, 5, 'run', 15);
  const xs = a.corners[0].x, mid = (e) => e.frame.ox + e.frame.ux * (e.a0 + e.a1) / 2;
  const avg = (ld, f) => { const q = ld.enemies.filter(f); return q.reduce((t, e) => t + e.speed, 0) / q.length; };
  const start = (e) => xs - mid(e) < 150, end = (e) => mid(e) - 8 < 150;
  ok(a.enemies.length === b.enemies.length && avg(b, start) < 0.75 * avg(a, start) && avg(b, end) > 0.85 * avg(a, end) && avg(b, end) < 0.95 * avg(a, end)
    && b.enemies.every((e, i) => e.a0 === a.enemies[i].a0 && e.rIn === a.enemies[i].rIn),
    'Run only level 9 (finale version 15): the same wolves, slower at the start, up to about 92% of their speed at the goal room');
  // ...and Run + Skate's running half the same (it already started slower; now it tops out at 92% too)
  const c14 = generateLevel(stageStep('mixed', 15, SKATE_FINAL_LEVEL), 5, 'mixed', 14), c15 = generateLevel(stageStep('mixed', 15, SKATE_FINAL_LEVEL), 5, 'mixed', 15);
  const nS = c15.sections[0].ld.legs.length, runOf = (ld) => ld.enemies.filter((e) => e.leg >= nS && mid(e) - 8 < 150);
  const top = (ld) => runOf(ld).reduce((t, e) => t + e.speed, 0) / runOf(ld).length;
  ok(c14.enemies.length === c15.enemies.length && top(c15) < 0.95 * top(c14) && top(c15) > 0.85 * top(c14), 'Run + Skate level 9 (finale version 15): its running half tops out at about 92% too');
}
// the mane / tail tip metals: hidden until their kitty (chrome, golden, bronze) unlocks them; one per slot is worn
{
  const metals = UNLOCKS.filter((u) => u.slot), all = { run: 1, ice: 1, mixed: 1 };
  const featOf = (u) => ({ [u.feat]: all });
  ok(metals.length === 9 && metals.every((u) => u.hidden && u.defaultOff && !isUnlocked({}, u) && isUnlocked(featOf(u), u, 'run'))
    && metals.filter((u) => u.metal === 'chrome').every((u) => u.feat === 'l9') && metals.filter((u) => u.metal === 'gold').every((u) => u.feat === 'top1')
    && metals.filter((u) => u.metal === 'bronze').every((u) => u.feat === 'fast1') && UNLOCKS.find((u) => u.id === 'bronze').excl === 'body'
    && slotMetal(new Set(['mbronze', 'mgold']), 'mane') === 'gold' && slotMetal(new Set(['tchrome']), 'tip') === 'chrome' && slotMetal(new Set(['lion']), 'mane') === null,
    'mane / tail tip metals: chrome with the Chrome kitty, gold with the Golden kitty, bronze with the Bronze kitty; hidden until then, off until switched on, one per slot');
}
// a normal game's level 8 / 9 counts for the easy games' unlocks too (not the other way round)
{
  const normal = { l8: { run: 2, ice: 0, mixed: 0 }, l9: { run: 0, ice: 0, mixed: 1 } }, easyOnly = { e8: { run: 1, ice: 0, mixed: 0 } };
  ok(isUnlocked(normal, 'specs', 'run') && isUnlocked(normal, 'gboots', 'run') && !isUnlocked(normal, 'specs', 'ice') && isUnlocked(normal, 'bow', 'ice')
    && !isUnlocked(normal, 'medal', 'ice') && !isUnlocked(easyOnly, 'shades', 'run'),
    'easy unlocks: a normal game counts for them too (Run + Skate in every mode), an easy game not for the normal ones');
}
// finale version 16: any kitty repairs Run + Skate level 9's broken checkpoint (15: only one with 60 revives this run)
{
  const hit = (v) => {
    const sim = createSim({ seed: 9, players: [{ id: 1, name: 'a', color: 1 }, { id: 2, name: 'b', color: 2 }], startLevel: stageStep('mixed', v, SKATE_FINAL_LEVEL), mode: 'mixed', finales: v });
    stepSim(sim, {}, 1 / 60);
    const cp = sim.levelData.checkpoints[0], p = sim.players[0];
    p.x = cp.x; p.z = cp.z;
    for (let i = 0; i < 5; i++) stepSim(sim, {}, 1 / 60);
    return sim.checkpointsHit.length;
  };
  ok(hit(15) === 0 && hit(16) === 1, 'Run + Skate level 9 (finale version 16): any kitty repairs the broken checkpoint (version 15: not without 60 revives)');
  // finale version 17: repaired by a kitty with 60+ revives this run, it gives a life and 4 boots in the square
  const gift = (v, rescues) => {
    const sim = createSim({ seed: 9, players: [{ id: 1, name: 'a', color: 1 }, { id: 2, name: 'b', color: 2 }], startLevel: stageStep('mixed', v, SKATE_FINAL_LEVEL), mode: 'mixed', finales: v });
    stepSim(sim, {}, 1 / 60);
    const cp = sim.levelData.checkpoints[0], p = sim.players[0];
    p.x = cp.x; p.z = cp.z; p.rescues = rescues;
    let ev = null;
    for (let i = 0; i < 5; i++) for (const e of stepSim(sim, {}, 1 / 60)) if (e.type === 'medicGift') ev = e;
    const items = sim.items.filter((it) => it.id >= 2000);
    return { ev, items, cp };
  };
  const g = gift(17, 60), g0 = gift(17, 59), g16 = gift(16, 80);
  const half = 6;
  ok(g.ev && g.items.map((it) => it.type).join() === 'life,boots,boots,boots,boots' && g.ev.items.length === 5
    && g.items.every((it) => Math.hypot(it.x - g.cp.x, it.z - g.cp.z) < 2 * half) && !g0.ev && !g0.items.length && !g16.ev && !g16.items.length,
    'Run + Skate level 9 (finale version 17): repaired by a kitty with 60+ revives, the broken checkpoint gives a life and 4 boots (59 revives or version 16: nothing)');
}
// finale version 18: Run only's level 9 wolves set off at once (their first rest one of their usual ones, not up to 6 s)
{
  const moving = (v) => {
    const sim = createSim({ seed: 31, players: [{ id: 1, name: 'a', color: 1 }], mode: 'run', finales: v, startLevel: SKATE_FINAL_LEVEL });
    const prev = sim.enemies.map((e) => [e.x, e.z]);
    for (let i = 0; i < 60; i++) { sim.players[0].invuln = 9; stepSim(sim, {}, 1 / 60); }
    return sim.enemies.filter((e, i) => Math.hypot(e.x - prev[i][0], e.z - prev[i][1]) > 0.05).length / sim.enemies.length;
  };
  const m17 = moving(17), m18 = moving(18);
  ok(m17 < 0.35 && m18 > 0.6, `Run only level 9 (finale version 18): the wolves are off at once (${Math.round(m18 * 100)}% moving in the first second; version 17: ${Math.round(m17 * 100)}%)`);
}
// finale version 21: each half of Run + Skate's final level has a heart (1-2 each); its wolves as before
{
  let bad = 0, wolvesSame = true;
  for (let s = 0; s < 40; s++) {
    const seed = 7000 + s, ld = generateLevel(17, seed, 'mixed', 21), old = generateLevel(17, seed, 'mixed', 20);
    const hs = ld.items.filter((it) => it.type === 'life'), sk = hs.filter((h) => !(h.z > ld.iceZMax)).length, rn = hs.length - sk;
    if (sk < 1 || rn < 1 || sk > 2 || rn > 2) bad++;
    if (ld.enemies.length !== old.enemies.length) wolvesSame = false;
  }
  ok(bad === 0 && wolvesSame, `Run + Skate's final (finale version 21): a heart in each half, at most 2 each (${bad} of 40 not), the same wolves`);
}

// rng.js hyp: Math.hypot as V8 computes it, from + - * / and sqrt only (the same in every browser), bit for bit
{
  let s = 12345, differ = 0;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < 200000; i++) {
    const a = i % 3 === 0 ? Math.round((r() - 0.5) * 80) / 4 : (r() - 0.5) * (i % 3 === 1 ? 400 : 1e-3), b = (r() - 0.5) * 400;
    if (!Object.is(hyp(a, b), Math.hypot(a, b))) differ++;
  }
  for (const [a, b] of [[0, 0], [-0, 5], [3, 4], [Infinity, 1], [NaN, 1], [NaN, Infinity], [1e-320, 1e-320], [1e300, 1e300]]) if (!Object.is(hyp(a, b), Math.hypot(a, b))) differ++;
  ok(differ === 0, `rng.js hyp gives exactly V8's Math.hypot (${differ} of 200008 differ), so levels are built the same in every browser`);
}

// finale version 20: on ice a kitty with 4 boots turns as tight a U-turn as without (version 19: 20% wider)
{
  const uturn = (fv, mult) => {
    const s = createSim({ seed: 3, players: [{ id: 1, name: 'a', color: 1 }], mode: 'ice', finales: fv, startLevel: 2 });
    stepSim(s, {}, CFG.TICK);
    const p = s.players[0], ld = s.levelData;
    let at = null;
    for (let x = -60; x < 60 && !at; x++) for (let z = -60; z < 60 && !at; z++) {
      let all = true;
      for (let dx = -4; dx <= 4 && all; dx++) for (let dz = -4; dz <= 4 && all; dz++) if (!onIce(ld, x + dx, z + dz)) all = false;
      if (all) at = { x, z };
    }
    Object.assign(p, at, { speedMult: mult, waitRelease: false, heading: 0, vx: CFG.KITTY_SPEED * mult, vz: 0 });
    let wide = 0;
    for (let i = 0; i < 60; i++) { p.invuln = 99; stepSim(s, { 1: { x: -1, z: 0.0001 } }, CFG.TICK); wide = Math.max(wide, Math.abs(p.z - at.z)); }
    return wide;
  };
  const plain = uturn(20, 1), boots = uturn(20, 1.2), old = uturn(19, 1.2), oldPlain = uturn(19, 1);
  ok(Math.abs(boots - plain) < 0.02 && old > plain * 1.15 && oldPlain === plain,
    `ice U-turn with 4 boots as small as without (finale version 20: ${boots.toFixed(2)} vs ${plain.toFixed(2)}; 19: ${old.toFixed(2)}; no boots the same in both)`);
}

// the score's distance (p.ran): how far along the map each kitty ran itself; being moved (a checkpoint) counts nothing
for (const [mode, lvl] of [['run', 1], ['ice', 3]]) {
  const sim = createSim({ seed: 3, players: [{ id: 1, name: 'a', color: 1 }, { id: 2, name: 'b', color: 2 }, { id: 3, name: 'c', color: 3 }], mode, finales: 19, startLevel: lvl });
  const path = sim.levelData.path, [a, b, c] = sim.players;
  stepSim(sim, {}, 1 / 60);
  const at = (p, i) => { const q = path[Math.max(0, Math.min(path.length - 1, i))]; p.x = q.x; p.z = q.z; };
  const half = Math.floor(path.length / 2);
  for (let i = 0; i < path.length + 5 && sim.state === 'playing'; i++) {
    for (const p of sim.players) { p.invuln = 9; p.vx = 0; p.vz = 0; }
    at(a, i); at(b, Math.min(i, Math.floor((path.length - 1) * 0.9)));
    if (i < 5) at(c, i); else at(c, Math.min(half + Math.floor((i - 5) / 2), Math.floor((path.length - 1) * 0.95)));   // (moved to half way at once)
    stepSim(sim, {}, 1 / 60);
  }
  ok(Math.round(20 * a.ran) === 20 && Math.round(20 * b.ran) === 18 && Math.round(20 * c.ran) === 9,
    `score distance (${mode}): the whole map run 20, 90% of it 18, moved half way and then run to 95% 9 (got ${Math.round(20 * a.ran)}, ${Math.round(20 * b.ran)}, ${Math.round(20 * c.ran)})`);
}
// finale version 19: every level has at least one heart (still at most two per half); version 18: some had none
{
  const count = (fv) => { let none = 0, over = 0; for (const mode of ['run', 'ice', 'mixed']) for (let seed = 1; seed <= 12; seed++) for (let step = 1; step <= (mode === 'mixed' ? 17 : 9); step++) {
    const ld = generateLevel(step, seed * 7919, mode, fv), h = ld.items.filter((it) => it.type === 'life').length;
    if (!h) none++; if (h > (ld.level === SKATE_FINAL_LEVEL && mode === 'mixed' ? 4 : 2)) over++;
  } return { none, over }; };
  const v18 = count(18), v19 = count(19);
  ok(v18.none > 0 && v19.none === 0 && v19.over === 0, `finale version 19: every level has a heart (version 18: ${v18.none} levels without one), still at most two`);
}
// ======== hell: Run only's / Skate only's final run over and over, the same map, up to HELL_LEVELS
{
  const { HELL_LEVELS } = await import('../public/js/shared/config.js');
  const { hellOpen } = await import('../public/js/shared/unlocks.js');
  const toGoal = (sim) => { const evs = []; for (let i = 0; i < 400 && evs.every((e) => e.type !== 'levelStart' && e.type !== 'victory'); i++) { const p = sim.players[0]; p.x = 0; p.z = 0; p.invuln = 9; evs.push(...stepSim(sim, {}, 1 / 60)); } return evs; };
  for (const mode of ['run', 'ice']) {
    const sim = createSim({ seed: 5, players: [{ id: 1, name: 'a', color: 1 }], mode, finales: 17, hell: true });
    stepSim(sim, {}, 1 / 60);
    const ld = sim.levelData, mid = ld.path[Math.floor(ld.path.length / 2)], p = sim.players[0];
    p.x = mid.x; p.z = mid.z; p.invuln = 9;
    stepSim(sim, {}, 1 / 60);
    const half = sim.far;
    const evs = toGoal(sim);
    const clear = evs.find((e) => e.type === 'levelClear');
    const again = createSim({ seed: 5, players: [{ id: 1, name: 'a', color: 1 }], mode, finales: 17, hell: true, startLevel: 2 }).levelData;
    ok(ld.finale && half > 0.4 && half < 0.6 && clear && clear.level === 1 && sim.level === 2 && sim.levelData !== ld && sim.levelData.finale
      && JSON.stringify(sim.levelData.items) !== JSON.stringify(ld.items) && JSON.stringify(sim.levelData.items) === JSON.stringify(again.items) && sim.far === 0 && sim.state === 'playing',
      `hell (${mode}): level 1 is the final run; the team's progress is tracked; the goal starts hell level 2, a new final run of its own (the same for everyone with the game's seed)`);
    sim.level = HELL_LEVELS;
    const end = toGoal(sim);
    ok(end.some((e) => e.type === 'victory' && e.level === HELL_LEVELS) && sim.state === 'victory', `hell (${mode}): clearing hell level ${HELL_LEVELS} wins`);
    // everyone down: the game is over, with how far it got
    const s2 = createSim({ seed: 5, players: [{ id: 1, name: 'a', color: 1 }], mode, finales: 17, hell: true });
    stepSim(s2, {}, 1 / 60);
    s2.far = 0.3; s2.players[0].alive = false;
    const go = stepSim(s2, {}, 1 / 60).find((e) => e.type === 'gameOver');
    ok(go && go.level === 1 && Math.abs(go.far - 0.3) < 1e-9, `hell (${mode}): game over says the level and how far along it`);
    // easy hell: everyone down, the same hell level starts over (its wolves and waves from the start), the wipe says how far
    const s3 = createSim({ seed: 5, players: [{ id: 1, name: 'a', color: 1 }], mode, finales: 17, hell: true, waves: true, easy: true, startLevel: 3 });
    for (let i = 0; i < 60 * 20; i++) { s3.players[0].invuln = 9; stepSim(s3, {}, 1 / 60); }
    const ld3 = s3.levelData, ticks3 = s3.enemyTicks;
    s3.far = 0.4; s3.players[0].alive = false;
    const ev3 = [];
    for (let i = 0; i < 60 * 6 && !ev3.some((e) => e.type === 'levelStart'); i++) ev3.push(...stepSim(s3, {}, 1 / 60));
    const wipe = ev3.find((e) => e.type === 'wipe'), restart = ev3.find((e) => e.type === 'levelStart');
    ok(s3.easy && s3.hell && wipe && wipe.level === 3 && Math.abs(wipe.far - 0.4) < 1e-9 && !ev3.some((e) => e.type === 'gameOver') && restart && restart.retry
      && s3.level === 3 && s3.levelData === ld3 && s3.enemyTicks < ticks3 && s3.players[0].alive && s3.far === 0,
      `hell (${mode}), easy: everyone down starts the same hell level over (waves from the start), the wipe says how far it got`);
  }
  ok(!createSim({ seed: 5, players: [], mode: 'mixed', hell: true }).hell, 'hell: not in Run + Skate');
  // wolf waves (waves.js): from hell level 2 on, in a game with them; every 45 s from the goal end, a gap in each
  {
    const { hellWaves, waveHit } = await import('../public/js/shared/waves.js');
    const r = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
    for (const mode of ['run', 'ice']) {
      const at = (opts, s) => { const sim = createSim({ seed: 9, players: [], mode, finales: 17, hell: true, ...opts }); while (sim.enemyTicks < 60 * s) stepSim(sim, {}, 1 / 60); return sim; };
      const sim = at({ waves: true, startLevel: 2 }, 30), w = hellWaves(sim).find((x) => x.k === 0), ld = sim.levelData;
      let open = 0, blockedAll = true;
      for (let z = -w.half; z <= w.half; z += 0.25) {
        let hit = false;
        for (let x = w.front + w.dir * 2; (x - (w.front - w.dir * (w.depth + 2))) * w.dir > 0; x -= w.dir * 0.05) if (waveHit([w], x, z, r * r)) { hit = true; break; }
        if (!hit) open += 0.25; else if (Math.abs(z - w.gap) < 3) blockedAll = false;
      }
      const outsideGoal = w.wolves.every((o) => Math.abs(w.front - w.dir * o.dx) > ld.roomHalf);
      // the level starts with waves along the run: the first reaches the start 45 s in (then sinks), one every 45 s
      const near = (s) => hellWaves(at({ waves: true, startLevel: 2 }, s));
      const run = Math.abs(ld.corners[0].x), at0 = near(0.5), first44 = near(44).find((x) => x.k === 0), first46 = near(46).find((x) => x.k === 0);
      let fromGoal = false;
      { const s = createSim({ seed: 9, players: [], mode, finales: 17, hell: true, waves: true, startLevel: 2 });
        while (!fromGoal && s.enemyTicks < 60 * 90) { stepSim(s, {}, 1 / 60); fromGoal = s.enemyTicks > 60 * 5 && hellWaves(s).some((x) => x.charge < 1 && Math.abs(x.front) < ld.roomHalf + 6); } }
      // never three gaps in a row in about the same spot
      const gs = []; { const s = createSim({ seed: 9, players: [], mode, finales: 17, hell: true, waves: true, startLevel: 2 }); s.enemyTicks = 60 * 45 * 60; for (const x of hellWaves(s)) gs.push(x.gap); }
      for (let k = 0; k < 400; k++) { const s = createSim({ seed: 9 + k, players: [], mode, finales: 17, hell: true, waves: true, startLevel: 2 }); s.enemyTicks = 30; const g = hellWaves(s).map((x) => x.gap); for (let i = 2; i < g.length; i++) if (Math.abs(g[i] - g[i - 1]) < 5 && Math.abs(g[i] - g[i - 2]) < 5) gs.push(NaN); }
      ok(gs.length > 3 && gs.every(Number.isFinite), `hell (${mode}) wolf waves: never three gaps in a row in about the same spot`);
      // one reaching the start every 45 s on hell 2, 35 s on hell 3, 25 s from hell 4
      const firstAt = (lvl) => { const s = createSim({ seed: 9, players: [], mode, finales: 17, hell: true, waves: true, startLevel: lvl }); while (s.enemyTicks < 60 * 60) { stepSim(s, {}, 1 / 60); if (hellWaves(s).some((x) => x.k === 0 && x.sink > 0)) return Math.round(s.enemyTicks / 60); } return 0; };
      ok(firstAt(2) === 45 && firstAt(3) === 35 && firstAt(4) === 25 && firstAt(5) === 15 && firstAt(6) === 8 && firstAt(9) === 8, `hell (${mode}) wolf waves: one every 45 s on hell 2, 35 s on hell 3, 25 s on hell 4, 15 s on hell 5, 8 s from hell 6`);
      ok(w.moving && open > 6.5 && open < 9 && blockedAll && w.wolves.every((o) => Math.abs(w.front - w.dir * o.dx) > ld.roomHalf)
        && at0.length >= 5 && at0.every((x) => x.charge < 1 && !x.moving) && first44 && first44.moving && Math.abs(first44.front) > run - 20
        && first46 && first46.sink > 0 && !first46.moving && !near(47).some((x) => x.k === 0) && fromGoal
        && hellWaves(at({ waves: true, startLevel: 1 }, 30)).length === 0 && hellWaves(at({ startLevel: 2 }, 30)).length === 0,
        `hell (${mode}) wolf waves: from hell level 2 on (with waves on), spread along the run from the start (${at0.length}), the first at the start 45 s in, then sinking; new ones rise outside the goal room; a wave blocks the whole run but its gap (${open.toFixed(2)} wide)`);
    }
  }
  // open: level 9 reached in the mode (Run + Skate: both), or a hell level of it cleared
  ok(isUnlocked({ h1: { ice: 1 } }, 'song5') && isUnlocked({ win: { run: 1 } }, 'song5') && !isUnlocked({ r9: { run: 1 } }, 'song5'),
    'the new song: unlocked by a hell level cleared too (any mode, before this rule as well)');
  ok(hellOpen({ r9: { mixed: 1 } }, 'run') && hellOpen({ r9: { mixed: 1 } }, 'ice') && hellOpen({ r9: { run: 1 } }, 'run') && hellOpen({ r9: { run: 1 } }, 'ice')
    && hellOpen({ r9: { ice: 1 } }, 'run') && hellOpen({ h1: { ice: 1 } }, 'ice') && !hellOpen({ h1: { ice: 1 } }, 'run') && !hellOpen({ l8: { run: 3 } }, 'run') && !hellOpen({}, 'run'),
    'hell opens: level 9 reached in any mode opens both; a cleared hell level opens its own mode');
  // its board: the furthest first (level, then how far along it), each player's best
  const { createLevelBoards } = await import('../server/levelboards.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-hell-test-'));
  try {
    const lb = createLevelBoards(path.join(dir, 'levels.json'));
    const who = (c) => ({ pid: c.repeat(24), name: 'K' + c, color: 1 });
    lb.recordHell(who('a'), { mode: 'run', level: 3, far: 0.2, team: 1 }); lb.recordHell(who('a'), { mode: 'run', level: 2, far: 0.9, team: 1 });
    lb.recordHell(who('b'), { mode: 'run', level: 3, far: 0.45, team: 1 }); lb.recordHell(who('c'), { mode: 'run', level: 5, far: 0.05, team: 1 });
    lb.recordHell(who('d'), { mode: 'run', level: 4, far: 0.5, team: 1, local: true }); lb.recordHell(who('e'), { mode: 'mixed', level: 9, far: 0.5, team: 1 });
    lb.recordHell(who('f'), { mode: 'run', level: HELL_LEVELS + 1, far: 0, team: 1 });
    const q = lb.query(who('a'), { board: { mode: 'run', level: 'h' } });
    ok(q.rows && q.rows.map((r) => r.name).join() === 'Kc,Kb,Ka' && q.rows[2].time === 3 * 1001 + 200 && q.me.rank === 3,
      'hell board: furthest first (level, then how far along), each player keeps their best; local games, Run + Skate and impossible levels stay off it');
    ok(!lb.record(who('g'), { mode: 'run', level: 'h', time: 40, team: 1 }), 'hell board: no level times on it');
    // easy hell has its own board
    lb.recordHell(who('m'), { mode: 'run', level: 4, far: 0.5, team: 1, easy: true });
    const qe = lb.query(who('m'), { board: { mode: 'run', level: 'h', easy: true } }), qn = lb.query(who('m'), { board: { mode: 'run', level: 'h' } });
    ok(qe.rows.length === 1 && qe.rows[0].name === 'Km' && !qn.rows.some((r) => r.name === 'Km'), 'hell board: easy hell on a board of its own');
    // all of it: the total time shows, the quickest first; a slower win doesn't replace a quicker one
    const all = (c, time) => lb.recordHell(who(c), { mode: 'ice', level: HELL_LEVELS, far: 1, team: 1, time });
    all('h', 900); all('i', 700); all('h', 950); lb.recordHell(who('j'), { mode: 'ice', level: HELL_LEVELS - 1, far: 0.99, team: 1 });
    const qa = lb.query(who('h'), { board: { mode: 'ice', level: 'h' } });
    ok(qa.rows.map((r) => r.name + ':' + (r.total || 0)).join() === 'Ki:700,Kh:900,Kj:0', 'hell board: games through all of it keep their total time, the quickest first');
    // every game's total time: the same level and the same way along it, the quicker game first (and it's kept)
    const at = (c, time) => lb.recordHell(who(c), { mode: 'run', level: 5, far: 0.5, team: 2, time });
    at('k', 900); at('l', 700); at('k', 950); at('k', 650);
    const qt = lb.query(who('k'), { board: { mode: 'run', level: 'h', team: true } });
    ok(qt.rows.map((r) => r.name + ':' + r.total).join() === 'Kk:650,Kl:700', 'hell board: every game keeps its total time; the same level and progress, the quicker first');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  // finale version 24: the final runs on foot (Run only level 9 / Hell Run, Run + Skate running half) stop their wolves up
  // to 0.7 from a wall; version 23 and the skate parts keep stopping right against it
  const band = (ld) => ld.enemies.filter((e) => e.wallBand === 0.7).length;
  const r23 = generateLevel(9, 77, 'run', 23), r24 = generateLevel(9, 77, 'run', 24);
  ok(band(r23) === 0 && band(r24) === r24.enemies.filter((e) => e.lateral).length && band(r24) > 0, 'final run on foot: version 24 wolves stop up to 0.7 from a wall, version 23 against it');
  const c24 = generateLevel(17, 77, 'mixed', 24), s24 = generateLevel(9, 77, 'ice', 24);
  ok(band(c24) > 0 && band(c24) < c24.enemies.filter((e) => e.lateral).length && band(s24) === 0, 'Run + Skate: only the running half gets the wall strip, the skate run stretch keeps its stops');
}
console.log(process.exitCode ? 'FAIL sim-test' : 'PASS sim-test');
