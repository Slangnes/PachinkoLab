(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});
  const LIVE_BOARD_KEY = 'prismdrop_live_board_v1';
  const PHI = 0.6180339887498949;
  const $ = (id) => document.getElementById(id);

  /**
   * Dedicated horological board preset: curved Pachinko Arch with 12 hour slots,
   * symmetric pegs, resonant bumpers, mirror prisms, a portal, and a 1-RPM minute spinner.
   */
  function buildClockworkPreset() {
    const P = RP.Presets;
    const settings = P.makeSettings({
      boardWidth: 540,
      boardHeight: 740,
      chamberShape: 'arch',
      launcherMode: 'drop',
      gravity: 900,
      launchSpeed: 310,
      ballRadius: 7,
      restitutionScale: 1.0,
      rayCount: 200,
      maxBounces: 48,
      shotsPerRound: 1,
      scoreMode: 'total',
      slotSpecText: '12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11'
    });

    const objs = P.makeGaltonGrid({
      boardWidth: 540,
      rows: 7,
      colsEven: 9,
      startY: 162,
      rowGap: 66,
      colGap: 49,
      radius: 6.5,
      scoreAdd: 5,
      filter: (x, y) => {
        if (Math.hypot(x - 270, y - 360) < 62) return false;
        if (Math.hypot(x - 152, y - 272) < 34) return false;
        if (Math.hypot(x - 388, y - 272) < 34) return false;
        if (Math.hypot(x - 165, y - 470) < 34) return false;
        if (Math.hypot(x - 375, y - 470) < 34) return false;
        return true;
      }
    });

    // Subtle upper optical prism guide mirrors
    objs.push(P.instantiateFromTemplate(P.tplById('wall'), 0, 0, {
      name: 'Prism Guide L',
      x1: 72, y1: 196, x2: 126, y2: 242,
      color: '#64748b',
      restitution: 0.92
    }));
    objs.push(P.instantiateFromTemplate(P.tplById('wall'), 0, 0, {
      name: 'Prism Guide R',
      x1: 468, y1: 196, x2: 414, y2: 242,
      color: '#64748b',
      restitution: 0.92
    }));

    // Twin resonant bumpers
    objs.push(P.instantiateFromTemplate(P.tplById('bumper'), 152, 272, {
      name: 'Chrono Bumper L',
      radius: 16,
      color: '#f59e0b',
      kickSpeed: 185
    }));
    objs.push(P.instantiateFromTemplate(P.tplById('bumper'), 388, 272, {
      name: 'Chrono Bumper R',
      radius: 16,
      color: '#38bdf8',
      kickSpeed: 185
    }));

    // Center horological dial orb + twin lower prisms
    objs.push(P.instantiateFromTemplate(P.tplById('multiplier'), 270, 360, {
      name: 'Heart Core',
      radius: 17,
      color: '#e879f9',
      tag: '◈',
      kickSpeed: 120,
      maxHitsPerShot: 0
    }));
    objs.push(P.instantiateFromTemplate(P.tplById('synergyCore'), 165, 470, {
      name: 'Solstice Node',
      radius: 13,
      color: '#facc15',
      auraRadius: 72,
      auraBuffAdd: 10
    }));
    objs.push(P.instantiateFromTemplate(P.tplById('refreshPeg'), 375, 470, {
      name: 'Equinox Node',
      radius: 13,
      color: '#34d399'
    }));

    return {
      id: 'clockwork',
      name: 'Clockwork Arch (12-Hour)',
      settings,
      objects: objs,
      isClockwork: true
    };
  }

  function loadLiveLabBoard() {
    try {
      const raw = localStorage.getItem(LIVE_BOARD_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.objects) || !parsed.settings) return null;
      return {
        id: 'lab',
        name: 'Current Lab Board',
        settings: RP.Presets.makeSettings({ ...parsed.settings, shotsPerRound: 1 }),
        objects: parsed.objects,
        isClockwork: false
      };
    } catch (_) {
      return null;
    }
  }

  // ---------- Path Preparation & Arc-Length Kinematics ----------
  function preparePath(trace, objects, metrics) {
    const primary = trace.paths && trace.paths[0];
    if (!primary || !primary.points || primary.points.length < 2) return null;
    const pts = primary.points;
    const cumLen = new Float64Array(pts.length);
    let totalLen = 0;

    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const d = p1.jump ? 0 : Math.hypot(p1.x - p0.x, p1.y - p0.y);
      totalLen += d;
      cumLen[i] = totalLen;
    }
    if (totalLen < metrics.H * 0.45) return null;

    // Identify visual peg/object contact fractions along arc for synchronized ripple glow
    const contacts = [];
    const circleObjs = objects.filter((o) => o.enabled !== false && (o.shape === 'circle' || o.shape === 'portal'));
    let lastContactIdx = -10;
    for (let i = 1; i < pts.length - 1; i++) {
      if (i - lastContactIdx < 2) continue;
      const p = pts[i];
      if (p.jump) {
        contacts.push({ frac: cumLen[i] / totalLen, x: p.x, y: p.y, color: '#c084fc', r: 16 });
        lastContactIdx = i;
        continue;
      }
      for (let k = 0; k < circleObjs.length; k++) {
        const o = circleObjs[k];
        const hitR = (o.radius || 8) + 11;
        if (RP.Math.distSq(p.x, p.y, o.x, o.y) <= hitR * hitR) {
          contacts.push({
            frac: cumLen[i] / totalLen,
            x: o.x,
            y: o.y,
            color: o.color || '#38bdf8',
            r: o.radius || 8
          });
          lastContactIdx = i;
          break;
        }
      }
    }

    return {
      u: trace.u,
      points: pts,
      cumLen,
      totalLen,
      bounces: trace.bounces,
      slot: trace.primarySlot,
      start: pts[0],
      end: pts[pts.length - 1],
      contacts
    };
  }

  function samplePathAt(path, frac) {
    const f = RP.Math.clamp(frac, 0, 1);
    const targetDist = f * path.totalLen;
    const cl = path.cumLen;
    let lo = 0;
    let hi = cl.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cl[mid] <= targetDist) lo = mid;
      else hi = mid;
    }
    const p0 = path.points[lo];
    const p1 = path.points[hi];
    if (p1.jump) return { x: p1.x, y: p1.y, segIdx: hi };
    const span = cl[hi] - cl[lo];
    const localT = span > 1e-6 ? (targetDist - cl[lo]) / span : 0;
    return {
      x: RP.Math.lerp(p0.x, p1.x, localT),
      y: RP.Math.lerp(p0.y, p1.y, localT),
      segIdx: hi
    };
  }

  // ---------- Clock Application State ----------
  const clockState = {
    boardId: 'clockwork',
    settings: null,
    objects: [],
    metrics: null,
    allPaths: [],
    richPaths: [],
    isClockwork: true,

    // Horological preferences
    rhythm: 'cascade', // 'cascade' (1s / 60s / 60m) | 'zen' (60s / 60m / 12h)
    faceMode: 'digital', // 'digital' | 'sculpture'
    bgMode: 'obsidian', // 'obsidian' | 'transparent'
    speedMult: 1,       // 1 | 15 | 120
    paused: false,

    // Virtual time anchor for 15x / 120x preview speeds
    simAnchorRealMs: Date.now(),
    simAnchorClockMs: Date.now(),
    frozenClockMs: Date.now(),

    // Active orb tracking (to trigger ripples & warp-return arcs cleanly)
    orbTrackers: {
      sec: { cycle: -1, lastFrac: -1, prevEnd: null, warpStartReal: -99999, nextStart: null },
      min: { cycle: -1, lastFrac: -1, prevEnd: null, warpStartReal: -99999, nextStart: null },
      hr:  { cycle: -1, lastFrac: -1, prevEnd: null, warpStartReal: -99999, nextStart: null }
    },

    ripples: [],
    toyBalls: [],
    recording: false
  };

  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let renderScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let rafId = 0;

  function pickPathForCycle(cycleIdx, seedOffset) {
    const pool = clockState.richPaths.length > 0 ? clockState.richPaths : clockState.allPaths;
    if (pool.length === 0) return null;
    const h = (((cycleIdx * PHI) + seedOffset) % 1 + 1) % 1;
    return pool[Math.floor(h * pool.length) % pool.length];
  }

  function loadClockBoard(boardId) {
    let chosen = null;
    if (boardId === 'clockwork') {
      chosen = buildClockworkPreset();
    } else if (boardId === 'lab') {
      chosen = loadLiveLabBoard() || buildClockworkPreset();
    } else {
      const preset = RP.Presets.PRESETS.find((p) => p.id === boardId);
      if (preset) {
        chosen = {
          id: preset.id,
          name: preset.name,
          settings: RP.Presets.makeSettings({ ...preset.settings, shotsPerRound: 1, rayCount: 180 }),
          objects: preset.buildObjects(),
          isClockwork: false
        };
      } else {
        chosen = buildClockworkPreset();
      }
    }

    clockState.boardId = chosen.id;
    clockState.settings = chosen.settings;
    clockState.objects = chosen.objects;
    clockState.isClockwork = chosen.isClockwork;
    clockState.metrics = RP.Engine.getBoardMetrics(chosen.settings);

    // Compute deterministic trajectory pool once for this board
    const sweep = RP.Engine.runSweep(clockState.objects, clockState.settings, -1);
    const prepared = [];
    for (let i = 0; i < sweep.traces.length; i++) {
      const p = preparePath(sweep.traces[i], clockState.objects, clockState.metrics);
      if (p) prepared.push(p);
    }
    clockState.allPaths = prepared;
    const rich = prepared.filter((p) => p.bounces >= 3);
    clockState.richPaths = rich.length >= 12 ? rich : prepared;

    // Reset orb trackers cleanly
    for (const k of ['sec', 'min', 'hr']) {
      clockState.orbTrackers[k].cycle = -1;
      clockState.orbTrackers[k].lastFrac = -1;
    }
    clockState.ripples = [];
    clockState.toyBalls = [];
    syncFrameLayout();
  }

  function syncFrameLayout() {
    const m = clockState.metrics;
    const frame = $('clockFrame');
    if (!m || !frame) return;
    if (desktopAPI) {
      frame.style.aspectRatio = '';
      frame.style.inlineSize = '100%';
      frame.style.blockSize = '100%';
    } else {
      frame.style.aspectRatio = `${m.W} / ${m.H}`;
      const pad = clockState.bgMode === 'transparent' ? 0 : 24;
      frame.style.inlineSize = `min(98dvw, calc((100dvb - ${pad}px) * ${(m.W / m.H).toFixed(4)}))`;
      frame.style.blockSize = 'auto';
    }
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas || !clockState.metrics) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tw = Math.round(rect.width * dpr);
    const th = Math.round(rect.height * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
    const m = clockState.metrics;
    renderScale = Math.min(rect.width / m.W, rect.height / m.H);
    offsetX = (rect.width - m.W * renderScale) * 0.5;
    offsetY = (rect.height - m.H * renderScale) * 0.5;
  }

  function getCurrentClockMs(realNowMs) {
    if (clockState.paused) return clockState.frozenClockMs;
    if (clockState.speedMult === 1) return realNowMs;
    const delta = realNowMs - clockState.simAnchorRealMs;
    return clockState.simAnchorClockMs + delta * clockState.speedMult;
  }

  function addRipple(x, y, color, baseR = 8, maxAdd = 16, lifeMs = 480) {
    if (clockState.ripples.length > 48) clockState.ripples.shift();
    clockState.ripples.push({
      x,
      y,
      color,
      baseR,
      maxAdd,
      born: performance.now(),
      lifeMs
    });
  }

  /**
   * Compute live progress & cycle index for the 3 horological orbs.
   */
  function getHorologyOrbs(clockMs) {
    const d = new Date(clockMs);
    const ms = d.getMilliseconds();
    const sec = d.getSeconds();
    const min = d.getMinutes();
    const hr24 = d.getHours();
    const hr12 = hr24 % 12;

    const totalSec = clockMs / 1000;
    const totalMin = totalSec / 60;
    const totalHr = totalMin / 60;

    if (clockState.rhythm === 'zen') {
      // Zen Horology: 60s Second Orb · 60m Minute Orb · 12h Hour Orb
      return {
        date: d,
        orbs: [
          {
            key: 'hr',
            label: `H ${hr12 === 0 ? 12 : hr12}h`,
            color: '#f472b6',
            glow: 'rgba(244, 114, 182, 0.55)',
            radius: 10,
            lineWidth: 3.4,
            cycle: Math.floor(totalHr / 12),
            frac: (hr12 + min / 60 + sec / 3600) / 12,
            seed: 0.71
          },
          {
            key: 'min',
            label: `M ${String(min).padStart(2, '0')}m`,
            color: '#f59e0b',
            glow: 'rgba(245, 158, 11, 0.55)',
            radius: 8,
            lineWidth: 2.8,
            cycle: Math.floor(totalHr),
            frac: (min + sec / 60 + ms / 60000) / 60,
            seed: 0.37
          },
          {
            key: 'sec',
            label: `S ${String(sec).padStart(2, '0')}s`,
            color: '#38bdf8',
            glow: 'rgba(56, 189, 248, 0.65)',
            radius: 6.2,
            lineWidth: 2.2,
            cycle: Math.floor(totalMin),
            frac: (sec + ms / 1000) / 60,
            seed: 0.13
          }
        ]
      };
    }

    // Cascade Clock (Default): 1s Second Drop · 60s Minute Orb · 60m Hour Orb
    return {
      date: d,
      orbs: [
        {
          key: 'hr',
          label: `Hour ${min}/60m`,
          color: '#f59e0b',
          glow: 'rgba(245, 158, 11, 0.55)',
          radius: 9.2,
          lineWidth: 3.2,
          cycle: Math.floor(totalHr),
          frac: (min + sec / 60 + ms / 60000) / 60,
          seed: 0.71
        },
        {
          key: 'min',
          label: `Min ${String(sec).padStart(2, '0')}/60s`,
          color: '#38bdf8',
          glow: 'rgba(56, 189, 248, 0.60)',
          radius: 7.4,
          lineWidth: 2.6,
          cycle: Math.floor(totalMin),
          frac: (sec + ms / 1000) / 60,
          seed: 0.37
        },
        {
          key: 'sec',
          label: `Sec #${String(sec).padStart(2, '0')}`,
          color: '#f8fafc',
          glow: 'rgba(248, 250, 252, 0.75)',
          radius: 5.4,
          lineWidth: 1.9,
          cycle: Math.floor(totalSec),
          frac: ms / 1000,
          seed: 0.13
        }
      ]
    };
  }

  function spawnToyBallAtClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const m = clockState.metrics;
    const bx = (clientX - rect.left - offsetX) / renderScale;
    const by = (clientY - rect.top - offsetY) / renderScale;
    const s = clockState.settings;

    let u;
    if (s.launcherMode === 'cannon') {
      const deg = (Math.atan2(by - m.cannonY, bx - m.cannonX) * 180) / Math.PI;
      u = RP.Math.clamp((deg - 16) / (164 - 16), 0, 1);
    } else {
      u = RP.Math.clamp((bx - m.left) / (m.right - m.left), 0.02, 0.98);
    }

    const tr = RP.Engine.traceSingleDetailed(u, clockState.objects, s);
    const path = preparePath(tr, clockState.objects, m);
    if (!path) return;

    const palette = ['#34d399', '#c084fc', '#f472b6', '#67e8f9', '#fde047'];
    const color = palette[clockState.toyBalls.length % palette.length];
    clockState.toyBalls.push({
      path,
      born: performance.now(),
      durationMs: RP.Math.clamp((path.totalLen / 540) * 1000, 700, 2600),
      lastFrac: 0,
      color
    });
  }

  // ---------- Rendering Loop ----------
  function renderFrame(perfNow) {
    resizeCanvas();
    const m = clockState.metrics;
    const s = clockState.settings;
    if (!m || !s) return;

    const realNowMs = Date.now();
    const clockMs = getCurrentClockMs(realNowMs);
    const horology = getHorologyOrbs(clockMs);
    const nowDate = horology.date;

    // Update digital HUD readout
    if (clockState.faceMode !== 'sculpture') {
      const hh = nowDate.getHours();
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      const ampm = hh >= 12 ? 'PM' : 'AM';
      const mm = String(nowDate.getMinutes()).padStart(2, '0');
      const ss = String(nowDate.getSeconds()).padStart(2, '0');
      $('timeReadout').textContent = `${String(h12).padStart(2, '0')}:${mm}:${ss} ${ampm}`;

      const legendParts = horology.orbs.slice().reverse().map((o) =>
        `<span class="orb-tag" style="color:${o.color}"><span class="orb-dot" style="background:${o.color}"></span>${o.label}</span>`
      );
      $('timeLegend').innerHTML = legendParts.join('');
    }

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * renderScale, 0, 0, dpr * renderScale, dpr * offsetX, dpr * offsetY);

    // 1. Background (transparent in floating widget mode, obsidian night in dark mode)
    if (clockState.bgMode !== 'transparent') {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
      bg.addColorStop(0, '#060a14');
      bg.addColorStop(1, '#0b1324');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    // Draw true chamber silhouette matching chamberShape (no square rectangle sticking above curved arch/bevels!)
    drawChamberOutline(ctx, m, clockState.bgMode === 'transparent');

    // 2. Ethereal background caustic web (all deterministic rays at ultra-soft opacity)
    if (clockState.allPaths.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.032)';
      ctx.lineWidth = 1;
      for (let i = 0; i < clockState.allPaths.length; i += 2) {
        const pts = clockState.allPaths[i].points;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].jump) ctx.moveTo(pts[k].x, pts[k].y);
          else ctx.lineTo(pts[k].x, pts[k].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // 3. Draw board pegs, bumpers, walls, portals, and live-rotating spinners
    const animSec = clockMs / 1000;
    const phaseRad = ((s.startPhaseDeg || 0) * Math.PI) / 180;
    drawClockObjects(ctx, clockState.objects, animSec, phaseRad, clockState.isClockwork);

    // 4. Draw subtle bottom slots (highlighting current hour slot on 12-hour Clockwork board!)
    drawClockSlots(ctx, s, m, nowDate, clockState.isClockwork);

    // 5. Render the 3 Time-Paced Horological Orbs (Hour -> Minute -> Second)
    for (const orb of horology.orbs) {
      const path = pickPathForCycle(orb.cycle, orb.seed);
      if (!path) continue;
      const trk = clockState.orbTrackers[orb.key];

      // Detect cycle wrap -> splash at old landing slot + launch warp-return arc to new path!
      if (trk.cycle !== -1 && trk.cycle !== orb.cycle) {
        if (trk.prevEnd) {
          addRipple(trk.prevEnd.x, trk.prevEnd.y, orb.color, orb.radius, 24, 720);
        }
        trk.warpStartReal = perfNow;
        trk.nextStart = path.start;
        trk.lastFrac = 0;
      }

      // Detect peg/bumper contacts crossed since last frame
      if (trk.cycle === orb.cycle && trk.lastFrac >= 0 && orb.frac >= trk.lastFrac && !clockState.paused) {
        for (let c = 0; c < path.contacts.length; c++) {
          const ct = path.contacts[c];
          if (ct.frac > trk.lastFrac && ct.frac <= orb.frac) {
            addRipple(ct.x, ct.y, orb.color, ct.r, 15, 460);
          }
        }
      }

      trk.cycle = orb.cycle;
      trk.lastFrac = orb.frac;

      // Draw warp return arc back to the top (lasts 1.3s after minute/hour reset)
      const warpAge = perfNow - trk.warpStartReal;
      const warpDuration = orb.key === 'sec' && clockState.rhythm === 'cascade' ? 0 : 1350;
      if (warpDuration > 0 && warpAge >= 0 && warpAge < warpDuration && trk.prevEnd && trk.nextStart) {
        drawWarpReturnArc(ctx, trk.prevEnd, trk.nextStart, warpAge / warpDuration, orb.color, m);
      }

      // Draw future path ahead (delicate dashed), completed luminous trail behind, and glowing orb
      drawTimedOrb(ctx, path, orb);
      trk.prevEnd = path.end;
    }

    // 6. Interactive click-dropped Toy Balls
    drawToyBalls(ctx, perfNow);

    // 7. Soft expanding peg impact & slot splash ripples
    drawRipples(ctx, perfNow);

    ctx.restore();
  }

  function drawChamberOutline(ctx, m, isTransparent) {
    const innerW = m.right - m.left;
    const innerH = m.floorY - m.top;

    ctx.save();
    ctx.beginPath();
    if (m.shape === 'arch') {
      const rx = innerW * 0.22;
      const ry = Math.min(125, innerH * 0.18);
      ctx.moveTo(m.left, m.floorY);
      ctx.lineTo(m.left, m.top + ry);
      ctx.ellipse(m.left + rx, m.top + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
      ctx.lineTo(m.right - rx, m.top);
      ctx.ellipse(m.right - rx, m.top + ry, rx, ry, 0, Math.PI * 1.5, Math.PI * 2);
      ctx.lineTo(m.right, m.floorY);
      ctx.closePath();
    } else if (m.shape === 'funnel') {
      const insetX = innerW * 0.12;
      const startY = m.floorY - Math.min(185, innerH * 0.29);
      ctx.moveTo(m.left, m.top + 12);
      ctx.quadraticCurveTo(m.left, m.top, m.left + 12, m.top);
      ctx.lineTo(m.right - 12, m.top);
      ctx.quadraticCurveTo(m.right, m.top, m.right, m.top + 12);
      ctx.lineTo(m.right, startY);
      ctx.lineTo(m.right - insetX, m.floorY);
      ctx.lineTo(m.left + insetX, m.floorY);
      ctx.lineTo(m.left, startY);
      ctx.closePath();
    } else if (m.shape === 'diamond') {
      const topBevX = innerW * 0.17;
      const topBevY = Math.min(110, innerH * 0.16);
      const botBevX = innerW * 0.12;
      const botBevY = Math.min(130, innerH * 0.20);
      ctx.moveTo(m.left + topBevX, m.top);
      ctx.lineTo(m.right - topBevX, m.top);
      ctx.lineTo(m.right, m.top + topBevY);
      ctx.lineTo(m.right, m.floorY - botBevY);
      ctx.lineTo(m.right - botBevX, m.floorY);
      ctx.lineTo(m.left + botBevX, m.floorY);
      ctx.lineTo(m.left, m.floorY - botBevY);
      ctx.lineTo(m.left, m.top + topBevY);
      ctx.closePath();
    } else {
      ctx.roundRect(m.left, m.top, innerW, innerH, 14);
    }

    if (isTransparent) {
      ctx.fillStyle = 'rgba(8, 13, 25, 0.42)';
      ctx.fill();
    }
    ctx.strokeStyle = isTransparent ? 'rgba(148, 163, 184, 0.42)' : 'rgba(148, 163, 184, 0.24)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawTimedOrb(ctx, path, orb) {
    const pos = samplePathAt(path, orb.frac);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Future destiny path ahead of orb (subtle dotted)
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = `${orb.color}30`;
    ctx.lineWidth = Math.max(1.1, orb.lineWidth * 0.55);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    for (let k = pos.segIdx; k < path.points.length; k++) {
      const pt = path.points[k];
      if (pt.jump) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Completed trail behind orb (luminous energy ribbon)
    ctx.shadowColor = orb.color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = `${orb.color}cc`;
    ctx.lineWidth = orb.lineWidth;
    ctx.beginPath();
    ctx.moveTo(path.points[0].x, path.points[0].y);
    for (let k = 1; k < pos.segIdx; k++) {
      const pt = path.points[k];
      if (pt.jump) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();

    // Glowing orb sphere
    ctx.shadowBlur = 18;
    ctx.fillStyle = orb.glow;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, orb.radius * 1.65, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 8;
    ctx.fillStyle = orb.color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, orb.radius, 0, Math.PI * 2);
    ctx.fill();

    // Specular white highlight core
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.beginPath();
    ctx.arc(pos.x - orb.radius * 0.25, pos.y - orb.radius * 0.25, orb.radius * 0.36, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawWarpReturnArc(ctx, fromPt, toPt, t, color, m) {
    const fade = Math.sin(t * Math.PI);
    const sideX = fromPt.x < m.W * 0.5 ? m.left + 8 : m.right - 8;
    const ctrlX = sideX;
    const ctrlY = (fromPt.y + toPt.y) * 0.5;

    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = fade * 0.65;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fromPt.x, fromPt.y);
    ctx.quadraticCurveTo(ctrlX, ctrlY, toPt.x, toPt.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Climbing starlight bead returning to the top
    const u = t;
    const inv = 1 - u;
    const bx = inv * inv * fromPt.x + 2 * inv * u * ctrlX + u * u * toPt.x;
    const by = inv * inv * fromPt.y + 2 * inv * u * ctrlY + u * u * toPt.y;
    ctx.globalAlpha = fade;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(bx, by, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawClockObjects(ctx, objects, animSec, phaseRad, isClockwork) {
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.enabled === false) continue;

      if (obj.shape === 'zone') {
        const r = obj.radius || 64;
        const grad = ctx.createRadialGradient(obj.x, obj.y, 4, obj.x, obj.y, r);
        grad.addColorStop(0, `${obj.color}24`);
        grad.addColorStop(1, `${obj.color}00`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const isDyn = RP.Engine.isDynamicObject(obj);
      const pose = isDyn ? RP.Engine.evaluateObjectPose(obj, animSec, phaseRad) : obj;

      if (obj.shape === 'segment') {
        ctx.save();
        ctx.strokeStyle = obj.color || '#94a3b8';
        ctx.lineWidth = (obj.thickness || 6) * 0.85;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pose.x1, pose.y1);
        ctx.lineTo(pose.x2, pose.y2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (obj.shape === 'portal') {
        const r = obj.radius || 14;
        ctx.save();
        ctx.strokeStyle = `${obj.color || '#c084fc'}bb`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(103, 232, 249, 0.7)';
        ctx.beginPath();
        ctx.arc(obj.exitX, obj.exitY, r * 0.8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      // Circle pegs / bumpers / horological heart
      const r = obj.radius || 7;
      ctx.save();
      ctx.fillStyle = obj.layerGroup === 'base' ? 'rgba(30, 41, 59, 0.85)' : `${obj.color}2a`;
      ctx.strokeStyle = obj.layerGroup === 'base' ? 'rgba(148, 163, 184, 0.52)' : (obj.color || '#38bdf8');
      ctx.lineWidth = obj.layerGroup === 'base' ? 1.4 : 2;
      ctx.beginPath();
      ctx.arc(pose.x, pose.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Subtle 1-RPM minute hand orbiting the Clockwork Heart Core!
      if (isClockwork && obj.name === 'Heart Core') {
        const secAngle = ((animSec % 60) / 60) * Math.PI * 2 - Math.PI * 0.5;
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.75)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(pose.x, pose.y);
        ctx.lineTo(pose.x + Math.cos(secAngle) * (r + 12), pose.y + Math.sin(secAngle) * (r + 12));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawClockSlots(ctx, s, m, nowDate, isClockwork) {
    const specs = s.slotSpecs || RP.Presets.parseSlotSpecs(s.slotValues);
    const count = specs.length;
    const totalW = m.right - m.left;
    const slotW = totalW / count;
    const curHourIdx = nowDate.getHours() % 12; // 0 -> 12, 1 -> 1, ...

    ctx.save();
    for (let i = 0; i < count; i++) {
      const x = m.left + i * slotW;
      const isActiveHour = isClockwork && count === 12 && i === curHourIdx;

      ctx.fillStyle = isActiveHour
        ? 'rgba(180, 83, 9, 0.72)'
        : 'rgba(10, 15, 28, 0.68)';
      ctx.strokeStyle = isActiveHour
        ? 'rgba(251, 191, 36, 0.95)'
        : 'rgba(148, 163, 184, 0.32)';
      ctx.lineWidth = isActiveHour ? 1.8 : 1;
      ctx.beginPath();
      ctx.roundRect(x + 2, m.floorY + 2, slotW - 4, m.H - m.floorY - 14, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isActiveHour ? '#fef9c3' : 'rgba(226, 232, 240, 0.90)';
      ctx.font = `${isActiveHour ? '800' : '600'} 10px ui-monospace, SFMono-Regular, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(specs[i].raw || String(specs[i].value), x + slotW * 0.5, m.floorY + (m.H - m.floorY - 10) * 0.5);
    }
    ctx.restore();
  }

  function drawToyBalls(ctx, perfNow) {
    if (clockState.toyBalls.length === 0) return;
    const alive = [];
    for (const tb of clockState.toyBalls) {
      const frac = (perfNow - tb.born) / tb.durationMs;
      if (frac >= 1) {
        addRipple(tb.path.end.x, tb.path.end.y, tb.color, 6, 18, 520);
        continue;
      }
      for (const ct of tb.path.contacts) {
        if (ct.frac > tb.lastFrac && ct.frac <= frac) {
          addRipple(ct.x, ct.y, tb.color, ct.r, 14, 420);
        }
      }
      tb.lastFrac = frac;

      drawTimedOrb(ctx, tb.path, {
        color: tb.color,
        glow: `${tb.color}66`,
        radius: 5.5,
        lineWidth: 2,
        frac
      });
      alive.push(tb);
    }
    clockState.toyBalls = alive;
  }

  function drawRipples(ctx, perfNow) {
    if (clockState.ripples.length === 0) return;
    const alive = [];
    ctx.save();
    for (const rp of clockState.ripples) {
      const t = (perfNow - rp.born) / rp.lifeMs;
      if (t >= 1) continue;
      const ease = 1 - Math.pow(1 - t, 3);
      ctx.strokeStyle = rp.color;
      ctx.globalAlpha = (1 - t) * 0.62;
      ctx.lineWidth = 1.8 * (1 - t * 0.5);
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.baseR + ease * rp.maxAdd, 0, Math.PI * 2);
      ctx.stroke();
      alive.push(rp);
    }
    ctx.restore();
    clockState.ripples = alive;
  }

  function startLoop() {
    const loop = (perfNow) => {
      renderFrame(perfNow);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  // ---------- Native Desktop Widget Integration ----------
  const desktopAPI = window.prismDesktop || null;
  let desktopFlags = { alwaysOnTop: true, clickThrough: false };
  let sizePillTimer = 0;

  function persistDesktopPrefs() {
    if (!desktopAPI) return;
    desktopAPI.savePrefs({
      boardId: clockState.boardId,
      rhythm: clockState.rhythm,
      faceMode: clockState.faceMode,
      bgMode: clockState.bgMode
    });
  }

  function flashSizePill(w, h) {
    const el = $('sizePill');
    if (!el) return;
    el.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    el.classList.add('visible');
    clearTimeout(sizePillTimer);
    sizePillTimer = setTimeout(() => el.classList.remove('visible'), 900);
  }

  // ---------- UI Controls & Initialization ----------
  function syncButtons() {
    $('btnPausePlay').textContent = clockState.paused ? '▶ Play' : '⏸ Pause';
    $('btnRhythm').textContent = clockState.rhythm === 'zen' ? 'Zen' : 'Cascade';
    $('btnSpeed').textContent = `${clockState.speedMult}×`;
    $('btnSpeed').classList.toggle('active', clockState.speedMult > 1);
    $('btnFace').textContent = clockState.faceMode === 'digital' ? 'Digital' : 'Art';
    $('timeHud').hidden = clockState.faceMode === 'sculpture';
    $('btnBg').textContent = clockState.bgMode === 'transparent' ? 'Clear' : 'Dark';

    const isTrans = clockState.bgMode === 'transparent';
    document.documentElement.classList.toggle('bg-transparent', isTrans);
    document.body.classList.toggle('bg-transparent', isTrans);
    syncFrameLayout();

    if (desktopAPI) {
      $('btnPinTop').classList.toggle('active', desktopFlags.alwaysOnTop);
      $('btnClickThrough').classList.toggle('active', desktopFlags.clickThrough);
      $('btnClickThrough').textContent = desktopFlags.clickThrough ? '👻 Unlock' : '👻 Pass';
      document.body.classList.toggle('click-through', desktopFlags.clickThrough);
    }
  }

  function setSpeed(nextSpeed) {
    const nowReal = Date.now();
    clockState.simAnchorClockMs = nextSpeed === 1 ? nowReal : getCurrentClockMs(nowReal);
    clockState.simAnchorRealMs = nowReal;
    clockState.speedMult = nextSpeed;
    syncButtons();
  }

  function rebuildBoardSelect(keepId) {
    const sel = $('selClockBoard');
    sel.innerHTML = '';

    const optClock = document.createElement('option');
    optClock.value = 'clockwork';
    optClock.textContent = 'Clockwork Arch (12-Hour)';
    sel.appendChild(optClock);

    if (loadLiveLabBoard()) {
      const optLab = document.createElement('option');
      optLab.value = 'lab';
      optLab.textContent = '★ Current Lab Board';
      sel.appendChild(optLab);
    }

    for (const p of RP.Presets.PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }

    if (keepId) {
      sel.value = keepId;
      if (sel.value !== keepId) sel.value = 'clockwork';
    }
  }

  function reportDockRect() {
    if (!desktopAPI) return;
    const dockEl = document.querySelector('.hover-dock');
    if (!dockEl) return;
    const r = dockEl.getBoundingClientRect();
    desktopAPI.setDockRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }

  function bindEvents() {
    const sel = $('selClockBoard');
    rebuildBoardSelect('clockwork');
    sel.addEventListener('change', async () => {
      loadClockBoard(sel.value);
      if (desktopAPI && clockState.metrics) {
        const b = await desktopAPI.getBounds();
        const ratio = clockState.metrics.W / clockState.metrics.H;
        const nextH = RP.Math.clamp(Math.round(b.width / ratio), 280, 1100);
        if (Math.abs(nextH - b.height) >= 4) {
          desktopAPI.resizeWindow(b.width, nextH);
        }
      }
      persistDesktopPrefs();
    });

    const togglePause = () => {
      if (!clockState.paused) {
        clockState.frozenClockMs = getCurrentClockMs(Date.now());
        clockState.paused = true;
      } else {
        const nowReal = Date.now();
        clockState.simAnchorRealMs = nowReal;
        clockState.simAnchorClockMs = clockState.speedMult === 1 ? nowReal : clockState.frozenClockMs;
        clockState.paused = false;
      }
      syncButtons();
    };
    $('btnPausePlay').addEventListener('click', togglePause);

    $('btnRhythm').addEventListener('click', () => {
      clockState.rhythm = clockState.rhythm === 'cascade' ? 'zen' : 'cascade';
      for (const k of ['sec', 'min', 'hr']) clockState.orbTrackers[k].cycle = -1;
      syncButtons();
      persistDesktopPrefs();
    });

    $('btnSpeed').addEventListener('click', () => {
      const next = clockState.speedMult === 1 ? 15 : clockState.speedMult === 15 ? 120 : 1;
      setSpeed(next);
    });

    $('btnFace').addEventListener('click', () => {
      clockState.faceMode = clockState.faceMode === 'digital' ? 'sculpture' : 'digital';
      syncButtons();
      persistDesktopPrefs();
    });

    $('btnBg').addEventListener('click', () => {
      clockState.bgMode = clockState.bgMode === 'obsidian' ? 'transparent' : 'obsidian';
      syncButtons();
      persistDesktopPrefs();
    });

    // Desktop widget window interactions (Drag to Move, Quick Click to Drop Ball, Scroll to Resize, Right-Click Menu)
    if (desktopAPI) {
      document.querySelectorAll('.desktop-only').forEach((el) => { el.hidden = false; });
      $('linkLabBrowser').hidden = true;

      $('btnPinTop').addEventListener('click', () => {
        desktopFlags.alwaysOnTop = !desktopFlags.alwaysOnTop;
        desktopAPI.setAlwaysOnTop(desktopFlags.alwaysOnTop);
        syncButtons();
      });

      $('btnClickThrough').addEventListener('click', () => {
        desktopFlags.clickThrough = !desktopFlags.clickThrough;
        desktopAPI.setClickThrough(desktopFlags.clickThrough);
        syncButtons();
      });

      $('btnOpenLabDesktop').addEventListener('click', () => desktopAPI.openLab());
      $('btnCloseWidget').addEventListener('click', () => desktopAPI.closeWidget());

      // Smart Click-Through: report dock bounds so main process re-enables mouse input whenever cursor enters the dock
      const dockEl = document.querySelector('.hover-dock');
      if (dockEl) {
        if (window.ResizeObserver) {
          const ro = new ResizeObserver(() => reportDockRect());
          ro.observe(dockEl);
        }
        dockEl.addEventListener('pointerenter', () => {
          reportDockRect();
          desktopAPI.setDockHover(true);
        });
        dockEl.addEventListener('pointerleave', () => desktopAPI.setDockHover(false));
        // Keep mouse input unlocked while interacting with the board dropdown inside the dock
        sel.addEventListener('pointerdown', () => desktopAPI.setDockLock(true));
        sel.addEventListener('focus', () => desktopAPI.setDockLock(true));
        sel.addEventListener('blur', () => desktopAPI.setDockLock(false));
        sel.addEventListener('change', () => {
          setTimeout(() => desktopAPI.setDockLock(false), 120);
        });
      }

      desktopAPI.onStateSync((flags) => {
        desktopFlags = Object.assign(desktopFlags, flags);
        syncButtons();
        reportDockRect();
      });

      desktopAPI.onDockHoverState((hot) => {
        document.body.classList.toggle('dock-hot', Boolean(hot));
      });

      desktopAPI.onBoardUpdated(() => {
        rebuildBoardSelect(clockState.boardId);
        if (clockState.boardId === 'lab') loadClockBoard('lab');
      });

      let dragCtx = null;
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button === 2) {
          desktopAPI.showContextMenu();
          return;
        }
        if (e.button !== 0) return;
        desktopAPI.startDrag();
        dragCtx = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          moved: false
        };
        canvas.setPointerCapture(e.pointerId);
      });

      canvas.addEventListener('pointermove', (e) => {
        if (!dragCtx) return;
        const dx = e.clientX - dragCtx.startClientX;
        const dy = e.clientY - dragCtx.startClientY;
        if (!dragCtx.moved && Math.hypot(dx, dy) > 5) {
          dragCtx.moved = true;
          canvas.classList.add('dragging');
        }
        if (dragCtx.moved) {
          desktopAPI.stepDrag();
        }
      });

      canvas.addEventListener('pointerup', (e) => {
        if (!dragCtx) return;
        const wasDrag = dragCtx.moved;
        const cx = dragCtx.startClientX;
        const cy = dragCtx.startClientY;
        dragCtx = null;
        canvas.classList.remove('dragging');
        desktopAPI.endDrag();
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        // Quick click drops a live glowing ball; drag moves the window!
        if (!wasDrag) spawnToyBallAtClient(cx, cy);
      });

      canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        desktopAPI.showContextMenu();
      });

      // Scroll wheel resizes widget proportionally
      window.addEventListener('wheel', async (e) => {
        e.preventDefault();
        const b = await desktopAPI.getBounds();
        const m = clockState.metrics;
        const ratio = m ? (m.W / m.H) : 0.73;
        const step = e.deltaY < 0 ? 28 : -28;
        const nextW = RP.Math.clamp(b.width + step, 230, 860);
        const nextH = Math.round(nextW / ratio);
        desktopAPI.resizeWindow(nextW, nextH);
        flashSizePill(nextW, nextH);
        setTimeout(reportDockRect, 60);
      }, { passive: false });
    } else {
      // Browser mode: click drops glowing ball
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        spawnToyBallAtClient(e.clientX, e.clientY);
      });
    }

    // Live sync if user edits a board in another tab/window
    window.addEventListener('storage', (e) => {
      if (e.key === LIVE_BOARD_KEY) {
        rebuildBoardSelect(clockState.boardId);
        if (clockState.boardId === 'lab') loadClockBoard('lab');
      }
    });

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'SELECT' || tag === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePause();
      }
    });

    window.addEventListener('resize', () => {
      resizeCanvas();
      reportDockRect();
    });

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const applyReducedMotion = (matches) => {
        if (matches) {
          clockState.rhythm = 'zen';
          syncButtons();
        }
      };
      applyReducedMotion(mq.matches);
      if (mq.addEventListener) mq.addEventListener('change', (ev) => applyReducedMotion(ev.matches));
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    canvas = $('clockCanvas');
    ctx = canvas.getContext('2d');

    const params = new URLSearchParams(window.location.search);
    if (params.get('transparent') === '1' || (desktopAPI && params.get('transparent') !== '0')) {
      clockState.bgMode = 'transparent';
    }
    if (params.get('rhythm') === 'zen') clockState.rhythm = 'zen';
    if (params.get('face') === 'sculpture') clockState.faceMode = 'sculpture';

    bindEvents();

    const startBoard = params.get('board') || params.get('preset') || 'clockwork';
    $('selClockBoard').value = startBoard;
    if ($('selClockBoard').value !== startBoard) $('selClockBoard').value = 'clockwork';

    syncButtons();
    loadClockBoard($('selClockBoard').value);
    reportDockRect();
    startLoop();
  });
})();
