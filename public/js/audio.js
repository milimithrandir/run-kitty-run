
// Run Kitty Run — audio.js (WebAudio only, everything synthesized).
// Contract: createAudio() -> { unlock, play, startMusic, stopMusic, setMuted, isMuted, setDanger, setBackground, attachTrack, setVolumes }
// Notes / interpretations:
// - The AudioContext is created lazily inside unlock(). play() before the context runs is a silent no-op.
// - startMusic(level) before unlock is remembered and starts automatically once unlocked.
// - All helpers live inside the createAudio closure so the single-file bundler sees no top-level name clashes.
// - Graph: sfx voices -> sfxBus ┐
//          music instances -> musicFilter (danger lowpass) -> musicBus ┴-> compressor -> master -> destination
//          soundtrack <audio> (attachTrack) -> trackGain -----------------------------------^

function createAudio() {
  let ctx = null;
  let master = null, comp = null, sfxBus = null, musicBus = null, musicFilter = null;
  let noiseBuf = null;
  let trackEl = null, trackSrc = null;
  let musicVol = 1, sfxVol = 1;          // the settings' volumes (setVolumes), 1 = as mixed   // the soundtrack's <audio> element, played through this context (attachTrack)
  let muted = false;
  let danger = 0;
  let pendingLevel = null;
  let primed = false;          // silent buffer played while the context is running
  let current = null;          // active music instance
  const instances = [];        // all instances (incl. fading ones)
  let timer = null;
  let lastStep = 0;
  let lastChomp = 0;
  let active = 0;              // active sfx voices

  const LOOKAHEAD = 0.12;
  const TICK_MS = 25;
  const MUSIC_VOL = 0.35;

  const ready = () => !!ctx && ctx.state === 'running';
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- setup
  function build() {
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { ctx = null; return false; }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    comp.connect(master); master.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.8 * sfxVol; sfxBus.connect(comp);
    musicBus = ctx.createGain(); musicBus.gain.value = MUSIC_VOL * musicVol; musicBus.connect(comp);
    musicFilter = ctx.createBiquadFilter(); musicFilter.type = 'lowpass';
    musicFilter.Q.value = 0.8; musicFilter.frequency.value = dangerFreq(danger);
    musicFilter.connect(musicBus);
    // 2s white noise buffer, shared
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // Leaving 'running' (suspended, or iOS 'interrupted') means the next unlock() must prime again.
    ctx.onstatechange = () => { if (ready()) onRunning(); else primed = false; };
    connectTrack();
    return true;
  }

  // The soundtrack is a plain <audio> element. Played on its own, every new song opens a fresh output stream, and
  // Windows plays its first moment at full volume before the browser's volume-mixer setting kicks in. Through this
  // context it shares the one long-lived stream with the sound effects. Straight into master (mute) at unity: no
  // compressor or danger filter, the songs sound as mixed. Without WebAudio the element just plays by itself.
  function connectTrack() {
    if (!ctx || !trackEl || trackSrc) return;
    try {
      trackSrc = ctx.createMediaElementSource(trackEl);
      const g = ctx.createGain(); g.gain.value = 1 / 0.9;   // (master is 0.9)
      trackSrc.connect(g); g.connect(master);
    } catch (e) { trackSrc = null; }
  }
  function attachTrack(el) { trackEl = el; connectTrack(); }
  // music (the synthesized fallback music; the soundtrack's volume is main.js's) and sound effects, 0..1
  function setVolumes(music, sfx) {
    musicVol = clamp(+music || 0, 0, 1); sfxVol = clamp(+sfx || 0, 0, 1);
    if (!ctx) return;
    sfxBus.gain.setTargetAtTime(0.8 * sfxVol, ctx.currentTime, 0.03);
    musicBus.gain.setTargetAtTime(MUSIC_VOL * musicVol, ctx.currentTime, 0.03);
  }

  function onRunning() {
    if (pendingLevel != null) { const l = pendingLevel; pendingLevel = null; startMusic(l); }
    ensureTimer();
  }

  function dangerFreq(v) {
    // 0 -> fully open (18 kHz), 1 -> muffled (~1 kHz)
    return 18000 * Math.pow(1000 / 18000, clamp(v, 0, 1));
  }

  // ---------------------------------------------------------------- node groups / cleanup
  // Every sound builds a group; when the source with the latest stop time ends, all nodes are disconnected.
  function group() {
    const g = { nodes: [], last: null, lastEnd: -1, counted: false };
    g.add = (n) => { g.nodes.push(n); return n; };
    g.src = (n, start, stop) => {
      g.nodes.push(n);
      n.start(start);
      n.stop(stop);
      if (stop > g.lastEnd) { g.lastEnd = stop; g.last = n; }
      return n;
    };
    g.finish = (count) => {
      if (!g.last) { disconnectAll(g.nodes); return; }
      if (count) { active++; g.counted = true; }
      g.last.onended = () => {
        if (g.counted) active--;
        disconnectAll(g.nodes);
        g.nodes.length = 0;
      };
    };
    return g;
  }
  function disconnectAll(nodes) {
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
  }

  // Gain envelope: 0.0001 -> peak (linear attack) -> hold -> exponential decay to 0.0001.
  function env(param, t, a, hold, d, peak) {
    const p = Math.max(peak, 0.0002);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(p, t + a);
    if (hold > 0) param.setValueAtTime(p, t + a + hold);
    param.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
  }

  function filt(g, dest, type, f, Q = 0.7, to = 0, t = 0, dur = 0) {
    const bq = g.add(ctx.createBiquadFilter());
    bq.type = type;
    bq.Q.value = Q;
    if (to && dur > 0) {
      bq.frequency.setValueAtTime(f, t);
      bq.frequency.exponentialRampToValueAtTime(to, t + dur);
    } else bq.frequency.value = f;
    bq.connect(dest);
    return bq;
  }

  // Oscillator with envelope. o: {type,f,to,slide,t,a,hold,d,peak,detune}
  function tone(g, dest, o) {
    const t = o.t, a = o.a ?? 0.005, hold = o.hold ?? 0, d = o.d ?? 0.2;
    const end = t + a + hold + d;
    const os = ctx.createOscillator();
    os.type = o.type || 'sine';
    os.frequency.setValueAtTime(o.f, t);
    if (o.to) os.frequency.exponentialRampToValueAtTime(o.to, t + (o.slide ?? (a + hold + d)));
    if (o.detune) os.detune.value = o.detune;
    const gn = g.add(ctx.createGain());
    env(gn.gain, t, a, hold, d, o.peak ?? 0.2);
    os.connect(gn); gn.connect(dest);
    g.src(os, t, end + 0.02);
    return os;
  }

  // Filtered noise burst. o: {t,a,hold,d,peak,ft,f,to,Q}
  function noise(g, dest, o) {
    const t = o.t, a = o.a ?? 0.002, hold = o.hold ?? 0, d = o.d ?? 0.1;
    const end = t + a + hold + d;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const gn = g.add(ctx.createGain());
    env(gn.gain, t, a, hold, d, o.peak ?? 0.1);
    let head = gn;
    if (o.ft) head = filt(g, gn, o.ft, o.f, o.Q ?? 1, o.to, t, a + hold + d);
    src.connect(head); gn.connect(dest);
    g.nodes.push(src);
    src.start(t, Math.random() * 1.5);
    src.stop(end + 0.02);
    if (end + 0.02 > g.lastEnd) { g.lastEnd = end + 0.02; g.last = src; }
    return src;
  }

  // LFO into an AudioParam (vibrato / wobble).
  function lfo(g, param, rate, depth, t, end, type = 'sine') {
    const os = ctx.createOscillator(); os.type = type; os.frequency.value = rate;
    const gn = g.add(ctx.createGain()); gn.gain.value = depth;
    os.connect(gn); gn.connect(param);
    g.src(os, t, end);
    return os;
  }

  // a warm wooden marimba note (levelClear): a sine with a quick soft knock (a short partial four times up)
  function marimba(g, dest, m, t, peak, p = 1, d = 0.45) {
    const f = mtof(m) * p;
    tone(g, dest, { type: 'sine', f, t, a: 0.004, d, peak });
    tone(g, dest, { type: 'sine', f: f * 4, t, a: 0.002, d: 0.05, peak: peak * 0.25 });
    tone(g, dest, { type: 'triangle', f: f / 2, t, a: 0.006, d: d * 0.6, peak: peak * 0.3 });
  }

  // a cat's voiced syllable (the laughs): an "h" of breath, then a sawtooth voice gliding f0 -> f1 through the vowel's
  // formants (fs: [[freq, Q, gain], ...]), d seconds long
  function syllable(g, dest, t, f0, f1, d, fs, peak, breath = 0.05) {
    noise(g, dest, { t, a: 0.004, d: 0.045, peak: breath, ft: 'bandpass', f: 2600, Q: 1.4 });
    const tv = t + 0.025;
    const os = ctx.createOscillator(); os.type = 'sawtooth';
    os.frequency.setValueAtTime(f0, tv);
    os.frequency.exponentialRampToValueAtTime(f1, tv + d);
    lfo(g, os.frequency, 9, f0 * 0.03, tv, tv + d + 0.03);
    const eg = g.add(ctx.createGain());
    env(eg.gain, tv, 0.012, d * 0.35, d * 0.65, peak);
    os.connect(eg);
    for (const [f, Q, gain] of fs) {
      const fg = g.add(ctx.createGain()); fg.gain.value = gain; fg.connect(dest);
      eg.connect(filt(g, fg, 'bandpass', f, Q));
    }
    g.src(os, tv, tv + d + 0.04);
  }

  // Simple 2-op FM bell. o: {f, ratio, index, t, a, d, peak}
  function fm(g, dest, o) {
    const t = o.t, a = o.a ?? 0.003, d = o.d ?? 0.4, end = t + a + d;
    const car = ctx.createOscillator(); car.frequency.value = o.f;
    const mod = ctx.createOscillator(); mod.frequency.value = o.f * o.ratio;
    const mg = g.add(ctx.createGain());
    mg.gain.setValueAtTime(o.f * o.index, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, o.f * 0.02), end);
    mod.connect(mg); mg.connect(car.frequency);
    const gn = g.add(ctx.createGain());
    env(gn.gain, t, a, 0, d, o.peak ?? 0.1);
    car.connect(gn); gn.connect(dest);
    g.src(mod, t, end + 0.02);
    g.src(car, t, end + 0.02);
  }

  // ---------------------------------------------------------------- SFX
  const SFX = {
    step(g, o, t, p) {
      noise(g, o, { t, a: 0.002, d: 0.035, peak: 0.05, ft: 'bandpass', f: 1700 * p * rnd(0.85, 1.15), Q: 1.8 });
      tone(g, o, { type: 'sine', f: 240 * p * rnd(0.9, 1.1), to: 150 * p, t, a: 0.002, d: 0.04, peak: 0.035 });
    },

    death(g, o, t, p) {
      // "mrrow!": saw through two formant bandpasses sweeping down, with vibrato
      const os = ctx.createOscillator(); os.type = 'sawtooth';
      os.frequency.setValueAtTime(480 * p, t);
      os.frequency.exponentialRampToValueAtTime(760 * p, t + 0.09);
      os.frequency.exponentialRampToValueAtTime(300 * p, t + 0.42);
      lfo(g, os.frequency, 7, 22 * p, t, t + 0.48);
      const eg = g.add(ctx.createGain());
      env(eg.gain, t, 0.03, 0.2, 0.22, 0.28);
      os.connect(eg);
      const f1 = filt(g, o, 'bandpass', 950 * p, 4, 520 * p, t, 0.45);
      const f2g = g.add(ctx.createGain()); f2g.gain.value = 0.5; f2g.connect(o);
      const f2 = filt(g, f2g, 'bandpass', 2400 * p, 7, 1300 * p, t, 0.45);
      const f3g = g.add(ctx.createGain()); f3g.gain.value = 0.35; f3g.connect(o);
      const f3 = filt(g, f3g, 'lowpass', 500 * p, 0.7);
      eg.connect(f1); eg.connect(f2); eg.connect(f3);
      g.src(os, t, t + 0.48);
      // thud
      tone(g, o, { type: 'sine', f: 150, to: 45, t: t + 0.36, a: 0.003, d: 0.2, peak: 0.5 });
      noise(g, o, { t: t + 0.36, d: 0.12, peak: 0.22, ft: 'lowpass', f: 320 });
    },

    // D: a giggly "hihihi" (an ee vowel), quick and high: versus, another team's kitty caught (main.js)
    foeSnickerD(g, o, t, p) {
      [0, 0.09, 0.18, 0.27].forEach((dt, i) => {
        const k = 1 - i * 0.06;
        syllable(g, o, t + dt, 900 * p * k, 780 * p * k, 0.05, [[420 * p, 5, 0.8], [2700 * p, 9, 0.7], [3500 * p, 10, 0.25]], 0.14 * (1 - i * 0.15), 0.05);
      });
    },

    revive(g, o, t, p) {
      const notes = [72, 76, 79, 84, 88, 91, 96];
      notes.forEach((m, i) => {
        const tt = t + i * 0.055;
        tone(g, o, { type: 'triangle', f: mtof(m) * p, t: tt, a: 0.005, d: 0.25, peak: 0.13 });
        tone(g, o, { type: 'sine', f: mtof(m + 12) * p, t: tt, a: 0.005, d: 0.18, peak: 0.035 });
      });
      noise(g, o, { t, a: 0.25, hold: 0.05, d: 0.3, peak: 0.045, ft: 'highpass', f: 5000, Q: 0.7 });
      for (let i = 0; i < 6; i++) {
        tone(g, o, { type: 'sine', f: rnd(2500, 5000) * p, t: t + 0.1 + Math.random() * 0.4, a: 0.002, d: 0.08, peak: 0.025 });
      }
    },

    pickup(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 3500);
      tone(g, lp, { type: 'square', f: 988 * p, t, a: 0.003, d: 0.06, peak: 0.06 });
      tone(g, o, { type: 'triangle', f: 988 * p, t, a: 0.003, d: 0.06, peak: 0.1 });
      tone(g, lp, { type: 'square', f: 1480 * p, t: t + 0.06, a: 0.003, d: 0.16, peak: 0.06 });
      tone(g, o, { type: 'triangle', f: 1480 * p, t: t + 0.06, a: 0.003, d: 0.16, peak: 0.1 });
    },

    boots(g, o, t, p) {
      noise(g, o, { t, a: 0.12, hold: 0.05, d: 0.15, peak: 0.2, ft: 'bandpass', f: 400 * p, to: 3500 * p, Q: 1.2 });
      fm(g, o, { f: 1568 * p, ratio: 3.01, index: 1.6, t: t + 0.2, a: 0.003, d: 0.4, peak: 0.1 });
      tone(g, o, { type: 'sine', f: 2349 * p, t: t + 0.2, a: 0.003, d: 0.3, peak: 0.05 });
    },

    life(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 2500);
      const seq = [[72, 0, 0.12, 0], [76, 0.09, 0.12, 0], [84, 0.18, 0.35, 0.08]];
      for (const [m, dt, d, hold] of seq) {
        const tt = t + dt, f = mtof(m) * p;
        tone(g, o, { type: 'triangle', f, t: tt, a: 0.006, hold, d, peak: 0.17 });
        tone(g, o, { type: 'sine', f: f / 2, t: tt, a: 0.006, hold, d, peak: 0.09 });
        tone(g, lp, { type: 'square', f, t: tt, a: 0.006, hold, d, peak: 0.025 });
      }
    },

    shield(g, o, t, p) {
      const os = tone(g, o, { type: 'sine', f: 280 * p, to: 840 * p, slide: 0.42, t, a: 0.04, hold: 0.25, d: 0.15, peak: 0.16 });
      lfo(g, os.frequency, 16, 40 * p, t, t + 0.46);
      const os2 = tone(g, o, { type: 'triangle', f: 560 * p, to: 1680 * p, slide: 0.42, t, a: 0.04, hold: 0.2, d: 0.15, peak: 0.04 });
      lfo(g, os2.frequency, 16, 80 * p, t, t + 0.42);
      for (let i = 0; i < 5; i++) {
        const f0 = rnd(500, 1000) * p;
        tone(g, o, { type: 'sine', f: f0, to: f0 * 1.8, t: t + i * 0.07 + Math.random() * 0.03, a: 0.004, d: 0.06, peak: 0.06 });
      }
    },

    shieldEnd(g, o, t, p) {
      tone(g, o, { type: 'sine', f: 900 * p, to: 180 * p, slide: 0.14, t, a: 0.003, d: 0.16, peak: 0.2 });
      noise(g, o, { t, d: 0.03, peak: 0.07, ft: 'lowpass', f: 1500 });
    },


    // A level (or Run + Skate's day half) is cleared: a soft, warm major chord that swells, low and round, with one wooden note.
    levelClear(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 1300, 0.6);
      for (const m of [60, 64, 67, 72]) for (const det of [-6, 6]) tone(g, lp, { type: 'triangle', f: mtof(m) * p, detune: det, t, a: 0.15, hold: 0.3, d: 0.7, peak: 0.028 });
      tone(g, o, { type: 'sine', f: mtof(48) * p, t, a: 0.1, hold: 0.3, d: 0.7, peak: 0.08 });
      marimba(g, lp, 72, t + 0.05, 0.06, p);
    },

    // A level starts (or restarts): one soft, round "bloop" going up.
    levelStart(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 1400, 0.6);
      tone(g, lp, { type: 'sine', f: 220 * p, to: 440 * p, slide: 0.12, t, a: 0.01, hold: 0.04, d: 0.25, peak: 0.182 });
      tone(g, lp, { type: 'triangle', f: 110 * p, to: 220 * p, slide: 0.12, t, a: 0.01, d: 0.25, peak: 0.07 });
    },

    teleport(g, o, t, p) {
      // flanger: dry + modulated short delay with feedback
      const lp = filt(g, o, 'lowpass', 5000);
      const dl = g.add(ctx.createDelay(0.05)); dl.delayTime.value = 0.004;
      const fb = g.add(ctx.createGain()); fb.gain.value = 0.55;
      const wet = g.add(ctx.createGain()); wet.gain.value = 0.7;
      lp.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(o);
      lfo(g, dl.delayTime, 5, 0.0028, t, t + 0.8); // keeper: lasts longest so the tail can ring out
      for (const det of [-12, 12]) {
        const os = ctx.createOscillator(); os.type = 'sawtooth'; os.detune.value = det;
        os.frequency.setValueAtTime(180 * p, t);
        os.frequency.exponentialRampToValueAtTime(2400 * p, t + 0.28);
        os.frequency.exponentialRampToValueAtTime(700 * p, t + 0.48);
        const gn = g.add(ctx.createGain());
        env(gn.gain, t, 0.02, 0.2, 0.26, 0.06);
        os.connect(gn); gn.connect(lp);
        g.src(os, t, t + 0.5);
      }
      noise(g, o, { t, a: 0.2, d: 0.25, peak: 0.05, ft: 'bandpass', f: 1500 * p, to: 8000 * p, Q: 2 });
    },

    gameOver(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 1800);
      const mel = [[67, 0, 0.36], [66, 0.45, 0.36], [65, 0.9, 0.36], [64, 1.35, 0.8]];
      for (const [m, dt, len] of mel) {
        const f = mtof(m) * p, last = m === 64;
        const a = tone(g, o, { type: 'triangle', f, t: t + dt, a: 0.02, hold: len * 0.5, d: len * 0.5, peak: 0.16 });
        const b = tone(g, lp, { type: 'square', f, t: t + dt, a: 0.02, hold: len * 0.5, d: len * 0.5, peak: 0.03 });
        tone(g, o, { type: 'sine', f: mtof(m - 24) * p, t: t + dt, a: 0.02, hold: len * 0.5, d: len * 0.5, peak: 0.12 });
        if (last) { lfo(g, a.frequency, 5, 6 * p, t + dt + 0.15, t + dt + 0.85); lfo(g, b.frequency, 5, 6 * p, t + dt + 0.15, t + dt + 0.85); }
      }
    },

    click(g, o, t, p) {
      tone(g, o, { type: 'sine', f: 1500 * p, t, a: 0.001, d: 0.03, peak: 0.1 });
      noise(g, o, { t, a: 0.001, d: 0.015, peak: 0.04, ft: 'highpass', f: 3000 });
    },

    extraLife(g, o, t, p) {
      noise(g, o, { t, a: 0.004, d: 0.5, peak: 0.16, ft: 'highpass', f: 2500, to: 6000, Q: 0.8 });
      fm(g, o, { f: 1760 * p, ratio: 1.414, index: 3, t, a: 0.003, d: 0.55, peak: 0.07 });
      fm(g, o, { f: 2637 * p, ratio: 2.76, index: 1.5, t, a: 0.003, d: 0.45, peak: 0.045 });
      tone(g, o, { type: 'sine', f: 110 * p, to: 55 * p, t, a: 0.003, d: 0.25, peak: 0.35 });
      tone(g, o, { type: 'sine', f: 800 * p, to: 2400 * p, slide: 0.08, t, a: 0.003, d: 0.15, peak: 0.06 });
    },

    // The final run starts: a hell bell, a deep bell tolling three times over a low drone, the last strike lower.
    finale(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 420, 0.7);
      tone(g, lp, { type: 'triangle', f: mtof(38) * p, t, a: 0.8, hold: 1.8, d: 1.2, peak: 0.12 });
      tone(g, o, { type: 'sine', f: mtof(26) * p, t, a: 0.6, hold: 2, d: 1.2, peak: 0.16 });
      [[0, 50], [1.0, 50], [2.0, 45]].forEach(([dt, m]) => {
        const fb = mtof(m) * p;
        fm(g, o, { f: fb, ratio: 2.41, index: 2.6, t: t + dt, a: 0.004, d: 2.2, peak: 0.12 });
        fm(g, o, { f: fb * 2.76, ratio: 1.41, index: 1.1, t: t + dt, a: 0.003, d: 1.2, peak: 0.04 });
        tone(g, o, { type: 'sine', f: fb / 2, t: t + dt, a: 0.004, d: 1.6, peak: 0.14 });
        noise(g, o, { t: t + dt, a: 0.002, d: 0.05, peak: 0.05, ft: 'bandpass', f: 2200, Q: 1 });
      });
    },

    // You beat Run Kitty Run: a soft ta-daa, two short warm brass chords (G, then a held C), low and rounded off
    // (~1.3 s); We Skate starts as it ends (main.js).
    victory(g, o, t, p) {
      const chord = (ms, at, len, peak) => {
        const lp = filt(g, o, 'lowpass', 700, 0.8, 1600, t + at, 0.1);
        for (const m of ms) for (const det of [-7, 7]) tone(g, lp, { type: 'sawtooth', f: mtof(m) * p, detune: det, t: t + at, a: 0.03, hold: len, d: 0.5, peak });
        for (const m of ms) tone(g, o, { type: 'triangle', f: mtof(m) * p, t: t + at, a: 0.03, hold: len, d: 0.5, peak: peak * 1.4 });
      };
      chord([55, 59, 62, 67], 0, 0.1, 0.018);
      chord([60, 64, 67, 72], 0.22, 0.5, 0.022);
      tone(g, o, { type: 'sine', f: mtof(36) * p, t: t + 0.22, a: 0.02, hold: 0.4, d: 0.6, peak: 0.16 });
    },

    // Firework rocket going up (quiet whistle) and its bang + crackle.
    fireworkLaunch(g, o, t, p) {
      const w = tone(g, o, { type: 'sine', f: 700 * p, to: 2200 * p, slide: 0.8, t, a: 0.05, hold: 0.55, d: 0.2, peak: 0.025 });
      lfo(g, w.frequency, 22, 30, t, t + 0.8);
      noise(g, o, { t, a: 0.02, d: 0.5, peak: 0.04, ft: 'bandpass', f: 2500, to: 5000, Q: 2 });
    },
    fireworkBoom(g, o, t, p) {
      tone(g, o, { type: 'sine', f: 95 * p, to: 38 * p, slide: 0.3, t, a: 0.003, d: 0.6, peak: 0.45 });
      noise(g, o, { t, a: 0.003, d: 0.9, peak: 0.22, ft: 'lowpass', f: 1600, to: 200, Q: 0.7 });
      for (let i = 0; i < 9; i++) noise(g, o, { t: t + 0.25 + Math.random() * 0.8, a: 0.001, d: 0.025, peak: 0.05, ft: 'highpass', f: 4000 });
    },

    // A kitty biting into the giant fish: a wet crunch (two quick noise snaps), a soft jaw thump and a tiny "nom".
    chomp(g, o, t, p) {
      const r = rnd(0.9, 1.12) * p;
      noise(g, o, { t, a: 0.002, d: 0.045, peak: 0.07, ft: 'bandpass', f: 2600 * r, Q: 1.4 });
      noise(g, o, { t: t + 0.035, a: 0.002, d: 0.06, peak: 0.055, ft: 'bandpass', f: 1700 * r, to: 900 * r, Q: 1.2 });
      for (let i = 0; i < 3; i++) noise(g, o, { t: t + 0.01 + Math.random() * 0.07, a: 0.001, d: 0.012, peak: 0.03, ft: 'highpass', f: 3800 });
      tone(g, o, { type: 'sine', f: 150 * r, to: 85 * r, t, a: 0.003, d: 0.08, peak: 0.12 });
      const nom = tone(g, o, { type: 'triangle', f: 520 * r, to: 380 * r, slide: 0.09, t: t + 0.07, a: 0.01, d: 0.09, peak: 0.022 });
      lfo(g, nom.frequency, 30, 25, t + 0.07, t + 0.18);
    },
    // The giant fish is all gone: a happy little "mrrp!" trill and a sparkle arpeggio.
    fishDone(g, o, t, p) {
      const os = ctx.createOscillator(); os.type = 'sawtooth';
      os.frequency.setValueAtTime(420 * p, t);
      os.frequency.exponentialRampToValueAtTime(820 * p, t + 0.16);
      os.frequency.exponentialRampToValueAtTime(640 * p, t + 0.32);
      lfo(g, os.frequency, 24, 40 * p, t, t + 0.36);
      const eg = g.add(ctx.createGain());
      env(eg.gain, t, 0.02, 0.18, 0.14, 0.12);
      os.connect(eg);
      const f1 = filt(g, o, 'bandpass', 1100 * p, 3);
      const f2g = g.add(ctx.createGain()); f2g.gain.value = 0.4; f2g.connect(o);
      const f2 = filt(g, f2g, 'bandpass', 2600 * p, 5);
      eg.connect(f1); eg.connect(f2);
      g.src(os, t, t + 0.4);
      [76, 79, 83, 88].forEach((m, i) => fm(g, o, { f: mtof(m) * p, ratio: 3.01, index: 1.2, t: t + 0.32 + i * 0.08, a: 0.002, d: 0.4, peak: 0.035 }));
    },

    tell(g, o, t, p) {
      const lp = filt(g, o, 'lowpass', 380);
      const am = g.add(ctx.createGain()); am.gain.value = 0.6; am.connect(lp);
      lfo(g, am.gain, 26, 0.4, t, t + 0.26, 'square');
      tone(g, am, { type: 'sawtooth', f: 78 * p, to: 60 * p, t, a: 0.03, hold: 0.08, d: 0.12, peak: 0.12 });
    },
  };

  // ---------------------------------------------------------------- public: play
  function play(name, opts) {
    if (!ready()) return;
    const fn = SFX[name];
    if (!fn) return;
    const o = opts || {};
    const pan = clamp(+o.pan || 0, -1, 1);
    const pitch = o.pitch > 0 ? +o.pitch : 1;
    const volume = o.volume == null ? 1 : clamp(+o.volume || 0, 0, 2);
    if (volume <= 0) return;
    const now = ctx.currentTime;
    if (name === 'step') {
      if (now - lastStep < 0.03) return;
      lastStep = now;
    }
    if (name === 'chomp') {   // several kitties munching at once: never a machine gun
      if (now - lastChomp < 0.11) return;
      lastChomp = now;
    }
    if (active > 64 || (active > 32 && (name === 'step' || name === 'tell' || name === 'chomp'))) return;
    const g = group();
    try {
      const vg = g.add(ctx.createGain());
      vg.gain.value = volume;
      if (pan && ctx.createStereoPanner) {
        const pn = g.add(ctx.createStereoPanner());
        pn.pan.value = pan;
        vg.connect(pn); pn.connect(sfxBus);
      } else vg.connect(sfxBus);
      fn(g, vg, now + 0.01, pitch);
    } catch (e) { /* never throw from audio */ }
    g.finish(true);
  }

  // ---------------------------------------------------------------- music: pattern generation
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MIXO = [0, 2, 4, 5, 7, 9, 10];
  const PROG_MAJOR = [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 5, 4], [3, 0, 4, 5], [0, 2, 3, 4]];
  const PROG_MIXO = [[0, 6, 3, 0], [0, 3, 6, 3], [0, 6, 4, 3], [3, 6, 0, 0]];

  function genPattern(level) {
    const r = mulberry((Math.imul(level, 2654435761) ^ 0x5bd1e995) >>> 0);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const key = Math.floor(r() * 12);
    const leadRoot = key < 5 ? 72 + key : 60 + key;   // 65..76
    const mixo = r() < 0.4;
    const scale = mixo ? MIXO : MAJOR;
    const prog = pick(mixo ? PROG_MIXO : PROG_MAJOR);
    const semi = (deg) => {
      const oct = Math.floor(deg / 7), idx = ((deg % 7) + 7) % 7;
      return scale[idx] + 12 * oct;
    };
    const tempo = Math.min(160, 110 + 4 * level);
    // bass: 'r' root, 'o' octave, 'f' fifth, with length in steps
    const busy = Math.min(1, level / 8);
    const bass = new Array(16).fill(null);
    for (let s = 0; s < 16; s++) {
      let pr = s === 0 ? 1 : s % 4 === 0 ? 0.7 : s % 2 === 0 ? 0.4 + 0.2 * busy : 0.08 + 0.2 * busy;
      if (r() < pr) bass[s] = { k: s === 0 ? 'r' : pick(['r', 'r', 'o', 'f']), len: 1 };
    }
    for (let s = 0; s < 16; s++) if (bass[s]) { let n = 1; while (s + n < 16 && !bass[s + n] && n < 4) n++; bass[s].len = n; }
    const kick = new Set([0, 8]);
    if (r() < 0.5) kick.add(10);
    if (r() < 0.35) kick.add(6);
    if (level >= 4) kick.add(r() < 0.5 ? 14 : 3);
    const snare = new Set([4, 12]);
    const ghost = level >= 3 && r() < 0.6 ? (r() < 0.5 ? 15 : 7) : -1;
    const openHat = r() < 0.5 ? 14 : 6;
    const genMotif = (density) => {
      const m = new Array(16).fill(null);
      let cur = pick([0, 2, 4]);
      for (let s = 0; s < 16; s++) {
        const strong = s % 4 === 0;
        if (r() < (strong ? density + 0.2 : s % 2 === 0 ? density : density * 0.45)) {
          cur += pick([-2, -1, -1, 0, 1, 1, 2]);
          cur = clamp(cur, -1, 7);
          if (strong) { const ct = [0, 2, 4, 7]; cur = ct.reduce((b, c) => (Math.abs(c - cur) < Math.abs(b - cur) ? c : b), 0); }
          m[s] = { off: cur, len: 1 };
        }
      }
      for (let s = 0; s < 16; s++) if (m[s]) { let n = 1; while (s + n < 16 && !m[s + n] && n < 4) n++; m[s].len = n; }
      return m;
    };
    const dens = 0.25 + 0.05 * Math.min(level, 7);
    const motifs = [genMotif(dens), genMotif(dens), genMotif(dens * 0.8)];
    const order = [0, 1, 0, 2];
    const arpShape = pick([[0, 1, 2, 1], [0, 1, 2, 3], [2, 1, 0, 1], [0, 2, 1, 3]]);
    const leadWave = level % 2 === 0 ? 'square' : 'triangle';
    return { level, key, leadRoot, mixo, prog, semi, tempo, bass, kick, snare, ghost, openHat, motifs, order, arpShape, leadWave,
      swing: tempo < 140 ? 0.12 : 0.05 };
  }

  // ---------------------------------------------------------------- music: instruments
  function mKick(dest, t, vel) {
    const g = group();
    tone(g, dest, { type: 'sine', f: 140, to: 42, slide: 0.12, t, a: 0.003, d: 0.28, peak: 0.75 * vel });
    noise(g, dest, { t, a: 0.001, d: 0.015, peak: 0.06 * vel, ft: 'lowpass', f: 2500 });
    g.finish(false);
  }
  function mSnare(dest, t, vel) {
    const g = group();
    noise(g, dest, { t, a: 0.002, d: 0.16, peak: 0.28 * vel, ft: 'bandpass', f: 1900, Q: 0.7 });
    tone(g, dest, { type: 'triangle', f: 200, to: 160, t, a: 0.002, d: 0.08, peak: 0.2 * vel });
    g.finish(false);
  }
  function mHat(dest, t, vel, open) {
    const g = group();
    noise(g, dest, { t, a: 0.001, d: open ? 0.2 : 0.04, peak: (open ? 0.06 : 0.075) * vel, ft: 'highpass', f: 7000, Q: 0.5 });
    g.finish(false);
  }
  function mBass(dest, t, f, dur) {
    const g = group();
    tone(g, dest, { type: 'triangle', f, t, a: 0.006, hold: dur * 0.55, d: dur * 0.45 + 0.05, peak: 0.42 });
    tone(g, dest, { type: 'square', f, t, a: 0.006, hold: dur * 0.4, d: dur * 0.5 + 0.03, peak: 0.05 });
    g.finish(false);
  }
  function mPad(dest, t, freqs, dur) {
    const g = group();
    for (const f of freqs) {
      for (const det of [-8, 8]) tone(g, dest, { type: 'sawtooth', f, detune: det, t, a: 0.3, hold: Math.max(0, dur - 0.6), d: 0.55, peak: 0.022 });
    }
    g.finish(false);
  }
  function mLead(dest, t, f, dur, wave) {
    const g = group();
    tone(g, dest, { type: 'triangle', f, t, a: 0.008, hold: dur * 0.5, d: dur * 0.5 + 0.06, peak: 0.13 });
    tone(g, dest, { type: wave === 'square' ? 'square' : 'sine', f: wave === 'square' ? f : f * 2, t, a: 0.008, hold: dur * 0.4, d: dur * 0.5 + 0.04, peak: wave === 'square' ? 0.03 : 0.03 });
    g.finish(false);
  }
  function mArp(dest, t, f) {
    const g = group();
    tone(g, dest, { type: 'triangle', f, t, a: 0.003, d: 0.12, peak: 0.05 });
    g.finish(false);
  }

  // ---------------------------------------------------------------- music: instances & scheduler
  function makeInstance(level, startTime) {
    const pat = genPattern(level);
    const stepDur = 60 / pat.tempo / 4;
    const gain = ctx.createGain(); gain.gain.value = 0.0001; gain.connect(musicFilter);
    const mk = (f, Q) => { const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = f; b.Q.value = Q; b.connect(gain); return b; };
    const bassF = mk(800, 0.8), padF = mk(1150, 0.6), leadF = mk(2800, 0.6);
    // lo-fi echo on lead (dotted 8th)
    const dl = ctx.createDelay(1.0); dl.delayTime.value = stepDur * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const wet = ctx.createGain(); wet.gain.value = 0.22;
    const echoLp = ctx.createBiquadFilter(); echoLp.type = 'lowpass'; echoLp.frequency.value = 2000;
    leadF.connect(dl); dl.connect(echoLp); echoLp.connect(fb); fb.connect(dl); echoLp.connect(wet); wet.connect(gain);
    return { level, pat, stepDur, gain, bassF, padF, leadF, step: 0, nextTime: startTime, stopAt: 0,
      nodes: [gain, bassF, padF, leadF, dl, fb, wet, echoLp] };
  }

  function scheduleStep(inst, s, t0) {
    const p = inst.pat, sd = inst.stepDur, lv = p.level;
    const bar = Math.floor(s / 16) % 4, st = s % 16;
    const chord = p.prog[bar];
    const t = st % 2 === 1 ? t0 + sd * p.swing : t0;
    const g = inst.gain;
    // drums
    if (p.kick.has(st)) mKick(g, t, st === 0 ? 1 : 0.85);
    if (p.snare.has(st)) mSnare(g, t, 1);
    else if (st === p.ghost) mSnare(g, t, 0.3);
    if (lv >= 2 && bar === 3 && st === 14) mSnare(g, t, 0.45);
    if (st === p.openHat && bar % 2 === 1) mHat(g, t, 1, true);
    else if (st % 2 === 0) mHat(g, t, st % 4 === 0 ? 0.7 : 1, false);
    else if (lv >= 4) mHat(g, t, 0.45, false);
    // bass
    const b = p.bass[st];
    if (b) {
      const semis = b.k === 'f' ? p.semi(chord + 4) : p.semi(chord) + (b.k === 'o' ? 12 : 0);
      mBass(inst.bassF, t, mtof(p.leadRoot - 24 + semis), b.len * sd * 0.9);
    }
    // pad
    if (st === 0) {
      const fr = [0, 2, 4].map((k) => mtof(p.leadRoot - 12 + p.semi(chord + k)));
      mPad(inst.padF, t, fr, sd * 16);
    }
    // lead
    const n = p.motifs[p.order[bar]][st];
    if (n && !(lv === 1 && bar === 0 && s < 64)) {
      mLead(inst.leadF, t, mtof(p.leadRoot + p.semi(chord + n.off)), n.len * sd * 0.85, p.leadWave);
    }
    // arp layer at higher levels
    if (lv >= 3 && (lv >= 6 || st % 2 === 0)) {
      const k = p.arpShape[(lv >= 6 ? st : st / 2) % 4];
      mArp(inst.padF, t, mtof(p.leadRoot + 12 + p.semi(chord + k * 2)));
    }
  }

  function ensureTimer() {
    if (timer == null && ctx) timer = setTimeout(tick, 0);
  }

  function tick() {
    timer = null;
    if (!ctx) return;
    if (ctx.state === 'running') {
      try {
        const now = ctx.currentTime;
        const hidden = typeof document !== 'undefined' && document.hidden;
        const ahead = hidden ? 1.2 : LOOKAHEAD;
        for (let i = instances.length - 1; i >= 0; i--) {
          const inst = instances[i];
          if (inst.stopAt && now > inst.stopAt + 2.5) {
            disconnectAll(inst.nodes);
            instances.splice(i, 1);
            continue;
          }
          if (inst.nextTime < now - 0.2) inst.nextTime = now + 0.05; // resync after throttling
          while (inst.nextTime < now + ahead) {
            if (inst.stopAt && inst.nextTime >= inst.stopAt) break;
            scheduleStep(inst, inst.step, inst.nextTime);
            inst.nextTime += inst.stepDur;
            inst.step++;
          }
        }
      } catch (e) { /* keep ticking */ }
    }
    if (instances.length) timer = setTimeout(tick, TICK_MS);
  }

  // ---------------------------------------------------------------- public: music
  function startMusic(level) {
    const lv = Math.max(1, Math.floor(+level || 1));
    if (!ready()) { pendingLevel = lv; return; }
    if (current && current.level === lv) return;
    const now = ctx.currentTime;
    let start = now + 0.06;
    const old = current;
    if (old) {
      // begin new pattern on the old one's next beat
      const toBeat = (4 - (old.step % 4)) % 4;
      const tb = old.nextTime + toBeat * old.stepDur;
      if (tb > start && tb < now + 1) start = tb;
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(Math.max(0.0001, old.gain.gain.value), now);
      old.gain.gain.setTargetAtTime(0.0001, start, 0.4);
      old.stopAt = start + 1.6;
    }
    const inst = makeInstance(lv, start);
    inst.gain.gain.setValueAtTime(0.0001, now);
    inst.gain.gain.setValueAtTime(0.0001, start);
    inst.gain.gain.exponentialRampToValueAtTime(1, start + (old ? 1.2 : 0.3));
    instances.push(inst);
    current = inst;
    ensureTimer();
  }

  function stopMusic() {
    pendingLevel = null;
    if (!current || !ctx) { current = null; return; }
    const now = ctx.currentTime;
    const g = current.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.setTargetAtTime(0.0001, now, 0.2);
    current.stopAt = now + 0.6;
    current = null;
  }

  // ---------------------------------------------------------------- public: misc
  function unlock() {
    if (!ctx && !build()) return;
    if (primed && ctx.state === 'running') return; // called on every key/pointer: nothing to do
    try {
      if (ctx.state !== 'running') {
        const pr = ctx.resume();
        if (pr && pr.then) pr.then(() => { if (ready()) onRunning(); }, () => {});
      }
      // tiny silent buffer (iOS unlock). Repeated until the context is actually running (it must
      // land inside a user gesture), then skipped until the context leaves 'running' again.
      if (!primed) {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination); b.start(0);
        b.onended = () => { try { b.disconnect(); } catch (e) { /* ignore */ } };
      }
    } catch (e) { /* ignore */ }
    primed = ready();
    if (primed) onRunning();
  }

  function setMuted(m) {
    muted = !!m;
    if (!ctx) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setTargetAtTime(muted ? 0 : 0.9, now, 0.06);
  }

  function isMuted() { return muted; }

  // App sent to the background: silence everything; back in front: wake the context up again
  // (iOS often leaves it "interrupted" after a trip to the home screen).
  function setBackground(bg) {
    if (!ctx) return;
    try {
      if (bg) ctx.suspend();
      else unlock();
    } catch (e) { /* ignore */ }
  }

  function setDanger(v) {
    const nv = clamp(+v || 0, 0, 1);
    if (Math.abs(nv - danger) < 0.005) return;
    danger = nv;
    if (!ctx) return;
    musicFilter.frequency.setTargetAtTime(dangerFreq(danger), ctx.currentTime, 0.25);
  }

  // (more sounds from outside: make gets the helpers, returns { name(g, o, t, p) } to add; the local sound lab's drafts)
  const extend = (make) => Object.assign(SFX, make({ tone, noise, filt, lfo, env, syllable, marimba, mtof, rnd }));
  return { unlock, play, startMusic, stopMusic, setMuted, isMuted, setDanger, setBackground, attachTrack, setVolumes, extend };
}

export { createAudio };
