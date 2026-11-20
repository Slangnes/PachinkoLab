(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});

  let _uidCounter = 1;
  function nextId(prefix = 'obj') {
    return `${prefix}_${_uidCounter++}`;
  }

  /**
   * Parse rich bottom-slot specification tokens:
   *   "80"  -> +80 normal slot
   *   "50R" or "R" -> +50 + Replay (free extra ball)
   *   "20F" or "F" -> +20 + Refresh (restores popped pegs)
   *   "H" or "/2"  -> Hazard (halves accumulated ball score)
   *   "x2" or "×3" -> Multiplier slot (multiplies ball score by N)
   */
  function parseSlotSpecs(input) {
    if (Array.isArray(input)) {
      return input.map((v) => {
        if (v && typeof v === 'object' && 'value' in v) return { ...v };
        const n = Number(v);
        const val = Number.isFinite(n) ? n : 10;
        return { raw: String(val), value: val, special: null, mult: 1 };
      });
    }
    const tokens = String(input || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const specs = [];
    for (const rawTok of tokens) {
      const upper = rawTok.toUpperCase();
      if (upper === 'H' || upper === '/2' || upper === 'TAX') {
        specs.push({ raw: 'H', value: 0, special: 'halve', mult: 0.5 });
        continue;
      }
      const multMatch = rawTok.match(/^[x×*]\s*(\d+(?:\.\d+)?)$/i);
      if (multMatch) {
        const m = Math.max(0.25, Math.min(20, parseFloat(multMatch[1])));
        specs.push({ raw: `×${m}`, value: m, special: 'mult', mult: m });
        continue;
      }
      const repMatch = rawTok.match(/^(-?\d+(?:\.\d+)?)?\s*R$/i);
      if (repMatch) {
        const val = repMatch[1] != null ? parseFloat(repMatch[1]) : 0;
        specs.push({ raw: `${val ? val : ''}R`, value: val, special: 'replay', mult: 1 });
        continue;
      }
      const refMatch = rawTok.match(/^(-?\d+(?:\.\d+)?)?\s*F$/i);
      if (refMatch) {
        const val = refMatch[1] != null ? parseFloat(refMatch[1]) : 0;
        specs.push({ raw: `${val ? val : ''}F`, value: val, special: 'refresh', mult: 1 });
        continue;
      }
      const num = parseFloat(rawTok);
      if (Number.isFinite(num)) {
        specs.push({ raw: String(num), value: num, special: null, mult: 1 });
      }
    }
    return specs;
  }

  function formatSlotSpecs(specs) {
    return (specs || []).map((s) => s.raw || String(s.value)).join(', ');
  }

  /**
   * Built-in complication templates shown in the placement palette.
   */
  const BUILTIN_TEMPLATES = [
    {
      templateId: 'peg',
      name: 'Peg',
      tag: '•',
      category: 'base',
      layerGroup: 'base',
      kind: 'peg',
      shape: 'circle',
      color: '#94a3b8',
      radius: 8,
      restitution: 0.62,
      kickSpeed: 0,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 5,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0
    },
    {
      templateId: 'popPeg',
      name: 'Pop Peg',
      tag: 'POP',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'pop',
      shape: 'circle',
      color: '#38bdf8',
      radius: 9,
      restitution: 0.66,
      kickSpeed: 20,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 18,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 1
    },
    {
      templateId: 'bumper',
      name: 'Bumper',
      tag: 'BMP',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'bumper',
      shape: 'circle',
      color: '#f59e0b',
      radius: 17,
      restitution: 1.24,
      kickSpeed: 230,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 25,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0
    },
    {
      templateId: 'multiplier',
      name: '×2 Mult',
      tag: '×2',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'multiplier',
      shape: 'circle',
      color: '#f43f5e',
      radius: 13,
      restitution: 0.84,
      kickSpeed: 40,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 10,
      scoreMult: 2,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 2
    },
    {
      templateId: 'splitter',
      name: 'Splitter',
      tag: '⑂2',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'splitter',
      shape: 'circle',
      color: '#10b981',
      radius: 14,
      restitution: 0.82,
      kickSpeed: 30,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 10,
      scoreMult: 1,
      splitCount: 2,
      splitSpreadDeg: 28,
      maxHitsPerShot: 1
    },
    {
      templateId: 'synergyCore',
      name: 'Synergy +15',
      tag: '✦',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'synergy',
      shape: 'circle',
      color: '#eab308',
      radius: 14,
      restitution: 0.82,
      kickSpeed: 55,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 15,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0,
      auraRadius: 105,
      auraBuffAdd: 15
    },
    {
      templateId: 'counterPin',
      name: '3-Hit Pin',
      tag: '3×',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'counter',
      shape: 'circle',
      color: '#fb7185',
      radius: 14,
      restitution: 1.05,
      kickSpeed: 120,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 180,
      scoreMult: 1.5,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0,
      triggerEveryN: 3
    },
    {
      templateId: 'refreshPeg',
      name: 'Refresh',
      tag: '⟳',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'refresh',
      shape: 'circle',
      color: '#4ade80',
      radius: 13,
      restitution: 0.80,
      kickSpeed: 50,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 10,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0,
      isRefresh: true
    },
    {
      templateId: 'bombPeg',
      name: 'Bomb Peg',
      tag: '✹',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'bomb',
      shape: 'circle',
      color: '#f97316',
      radius: 13,
      restitution: 0.90,
      kickSpeed: 110,
      biasAngle: 0,
      tangentialBoost: 0,
      scoreAdd: 40,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 1,
      isBomb: true,
      bombRadius: 86
    },
    {
      templateId: 'biasPeg',
      name: 'Spin Bias',
      tag: '↻',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'bias',
      shape: 'circle',
      color: '#a855f7',
      radius: 12,
      restitution: 0.85,
      kickSpeed: 45,
      biasAngle: -24,
      tangentialBoost: 150,
      scoreAdd: 12,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0
    },
    {
      templateId: 'wall',
      name: 'Mirror Wall',
      tag: '╱',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'wall',
      shape: 'segment',
      color: '#cbd5e1',
      thickness: 6,
      length: 100,
      angleDeg: 32,
      restitution: 0.92,
      kickSpeed: 0,
      biasAngle: 0,
      tangentialBoost: 0,
      oneWay: false,
      scoreAdd: 0,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0
    },
    {
      templateId: 'oneWay',
      name: '1-Way Gate',
      tag: '⇥',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'gate',
      shape: 'segment',
      color: '#22d3ee',
      thickness: 6,
      length: 92,
      angleDeg: -12,
      restitution: 0.90,
      kickSpeed: 40,
      biasAngle: 0,
      tangentialBoost: 0,
      oneWay: true,
      scoreAdd: 5,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0
    },
    {
      templateId: 'spinner',
      name: 'Spinner',
      tag: '✳',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'spinner',
      shape: 'segment',
      color: '#2dd4bf',
      thickness: 7,
      length: 92,
      angleDeg: 0,
      restitution: 0.95,
      kickSpeed: 55,
      biasAngle: 0,
      tangentialBoost: 0,
      oneWay: false,
      scoreAdd: 15,
      scoreMult: 1,
      splitCount: 1,
      splitSpreadDeg: 24,
      maxHitsPerShot: 0,
      angularSpeedDeg: 135
    },
    {
      templateId: 'portal',
      name: 'Warp Portal',
      tag: '◎',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'portal',
      shape: 'portal',
      color: '#c084fc',
      radius: 15,
      restitution: 1,
      kickSpeed: 80,
      exitOffsetX: 180,
      exitOffsetY: -220,
      exitAngleDeg: 65,
      scoreAdd: 15,
      scoreMult: 1,
      maxHitsPerShot: 2
    },
    {
      templateId: 'windZone',
      name: 'Wind Drift',
      tag: '≋',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'wind',
      shape: 'zone',
      color: '#38bdf8',
      radius: 68,
      forceX: 520,
      forceY: -60,
      radialForce: 0,
      drag: 0,
      scoreAdd: 0,
      scoreMult: 1
    },
    {
      templateId: 'magnetZone',
      name: 'Gravity Well',
      tag: '◌',
      category: 'complication',
      layerGroup: 'complication',
      kind: 'well',
      shape: 'zone',
      color: '#e879f9',
      radius: 66,
      forceX: 0,
      forceY: 0,
      radialForce: -620,
      drag: 0.35,
      scoreAdd: 20,
      scoreMult: 1
    }
  ];

  function instantiateFromTemplate(tpl, x, y, overrides = {}) {
    const obj = {
      id: nextId(tpl.kind || 'obj'),
      templateId: tpl.templateId || 'custom',
      name: tpl.name || 'Complication',
      tag: tpl.tag || '★',
      layerGroup: tpl.layerGroup || 'complication',
      kind: tpl.kind || 'custom',
      shape: tpl.shape || 'circle',
      color: tpl.color || '#38bdf8',
      enabled: true,
      restitution: tpl.restitution != null ? tpl.restitution : 0.8,
      kickSpeed: tpl.kickSpeed || 0,
      biasAngle: tpl.biasAngle || 0,
      tangentialBoost: tpl.tangentialBoost || 0,
      scoreAdd: tpl.scoreAdd || 0,
      scoreMult: tpl.scoreMult != null ? tpl.scoreMult : 1,
      splitCount: tpl.splitCount || 1,
      splitSpreadDeg: tpl.splitSpreadDeg || 24,
      maxHitsPerShot: tpl.maxHitsPerShot || 0,
      triggerEveryN: tpl.triggerEveryN || 1,
      auraRadius: tpl.auraRadius || 0,
      auraBuffAdd: tpl.auraBuffAdd || 0,
      isRefresh: Boolean(tpl.isRefresh),
      isBomb: Boolean(tpl.isBomb),
      bombRadius: tpl.bombRadius || 84,
      angularSpeedDeg: tpl.angularSpeedDeg || 0,
      oscAmpX: tpl.oscAmpX || 0,
      oscAmpY: tpl.oscAmpY || 0,
      oscFreq: tpl.oscFreq || 0.7,
      oneWay: Boolean(tpl.oneWay),
      thickness: tpl.thickness || 6
    };

    if (obj.shape === 'circle' || obj.shape === 'zone') {
      obj.x = x;
      obj.y = y;
      obj.radius = tpl.radius || (obj.shape === 'zone' ? 64 : 11);
      if (obj.shape === 'zone') {
        obj.forceX = tpl.forceX || 0;
        obj.forceY = tpl.forceY || 0;
        obj.radialForce = tpl.radialForce || 0;
        obj.drag = tpl.drag || 0;
      }
    } else if (obj.shape === 'portal') {
      obj.x = x;
      obj.y = y;
      obj.radius = tpl.radius || 15;
      obj.exitX = RP.Math.clamp(x + (tpl.exitOffsetX != null ? tpl.exitOffsetX : 160), 48, 760);
      obj.exitY = RP.Math.clamp(y + (tpl.exitOffsetY != null ? tpl.exitOffsetY : -180), 80, 920);
      obj.exitAngleDeg = tpl.exitAngleDeg != null ? tpl.exitAngleDeg : 75;
    } else if (obj.shape === 'segment') {
      const half = (tpl.length || 96) * 0.5;
      const rad = ((tpl.angleDeg || 25) * Math.PI) / 180;
      const dx = Math.cos(rad) * half;
      const dy = Math.sin(rad) * half;
      obj.x1 = x - dx;
      obj.y1 = y - dy;
      obj.x2 = x + dx;
      obj.y2 = y + dy;
    }

    return Object.assign(obj, overrides);
  }

  function tplById(id) {
    return BUILTIN_TEMPLATES.find((t) => t.templateId === id) || BUILTIN_TEMPLATES[0];
  }

  /**
   * Parametric Base Lattice Generator working across any boardWidth x boardHeight and pattern.
   * Patterns: 'staggered' | 'grid' | 'pyramid' | 'hex'
   */
  function generateLattice({
    boardWidth = 540,
    boardHeight = 720,
    pattern = 'staggered',
    rows = 8,
    cols = 9,
    radius = 7.5,
    scoreAdd = 5,
    templateId = 'peg',
    topMargin = 132,
    bottomMargin = 112,
    sideMargin = 54,
    filter = null
  } = {}) {
    const out = [];
    const baseTpl = tplById(templateId);
    const usableW = Math.max(120, boardWidth - sideMargin * 2);
    const usableH = Math.max(120, boardHeight - topMargin - bottomMargin);
    const rowGap = rows > 1 ? usableH / (rows - 1) : 0;
    const centerX = boardWidth * 0.5;

    if (pattern === 'hex') {
      const rings = Math.max(2, Math.min(6, Math.round(rows / 2)));
      const maxR = Math.min(usableW, usableH) * 0.46;
      const cy = topMargin + usableH * 0.5;
      for (let ring = 1; ring <= rings; ring++) {
        const rr = (ring / rings) * maxR;
        const pts = ring * 6;
        for (let k = 0; k < pts; k++) {
          const ang = (k / pts) * Math.PI * 2 + (ring % 2) * (Math.PI / pts);
          const x = centerX + Math.cos(ang) * rr;
          const y = cy + Math.sin(ang) * rr;
          if (filter && !filter(x, y, ring, k)) continue;
          out.push(instantiateFromTemplate(baseTpl, x, y, {
            name: templateId === 'popPeg' ? 'Pop Peg' : 'Peg',
            radius,
            scoreAdd,
            layerGroup: 'base'
          }));
        }
      }
      return out;
    }

    const colGap = cols > 1 ? usableW / (cols - 1) : 0;
    for (let r = 0; r < rows; r++) {
      let rowCols = cols;
      if (pattern === 'staggered' && r % 2 === 1) {
        rowCols = Math.max(2, cols - 1);
      } else if (pattern === 'pyramid') {
        rowCols = Math.min(cols, Math.max(2, Math.round(2 + (r / Math.max(1, rows - 1)) * (cols - 2))));
      }
      const rowWidth = (rowCols - 1) * colGap;
      const startX = centerX - rowWidth * 0.5;
      const y = topMargin + r * rowGap;

      for (let c = 0; c < rowCols; c++) {
        const x = startX + c * colGap;
        if (filter && !filter(x, y, r, c)) continue;
        out.push(instantiateFromTemplate(baseTpl, x, y, {
          name: templateId === 'popPeg' ? 'Pop Peg' : 'Peg',
          radius,
          scoreAdd,
          layerGroup: 'base'
        }));
      }
    }
    return out;
  }

  /**
   * Legacy helper kept for presets.
   */
  function makeGaltonGrid({
    rows = 8,
    colsEven = 9,
    startY = 132,
    rowGap = 56,
    colGap = 48,
    radius = 7.5,
    scoreAdd = 5,
    templateId = 'peg',
    boardWidth = 540,
    filter = null
  } = {}) {
    const out = [];
    const baseTpl = tplById(templateId);
    const centerX = boardWidth * 0.5;
    for (let r = 0; r < rows; r++) {
      const isOdd = r % 2 === 1;
      const cols = isOdd ? colsEven - 1 : colsEven;
      const rowWidth = (cols - 1) * colGap;
      const startX = centerX - rowWidth / 2;
      const y = startY + r * rowGap;
      for (let c = 0; c < cols; c++) {
        const x = startX + c * colGap;
        if (filter && !filter(x, y, r, c)) continue;
        out.push(instantiateFromTemplate(baseTpl, x, y, {
          name: templateId === 'popPeg' ? 'Pop Peg' : 'Peg',
          radius,
          scoreAdd,
          layerGroup: 'base'
        }));
      }
    }
    return out;
  }

  const DEFAULT_SLOT_TEXT = '10, 20, 35, 55, 80, 100, 80, 55, 35, 20, 10';
  const DEFAULT_SLOT_SPECS = parseSlotSpecs(DEFAULT_SLOT_TEXT);

  const DEFAULT_SETTINGS = {
    boardWidth: 540,
    boardHeight: 720,
    chamberShape: 'rect', // 'rect' | 'arch' | 'funnel' | 'diamond'
    launcherMode: 'drop', // 'drop' | 'cannon'
    gravity: 920,
    launchSpeed: 340,
    ballRadius: 7,
    restitutionScale: 1.0,
    rayCount: 220,
    maxBounces: 52,
    shotsPerRound: 1,
    enableSpinFriction: false,
    enableBallCollisions: false,
    movingBucket: false,
    bucketWidth: 82,
    bucketSpeed: 150,
    bucketMult: 2,
    bucketReplay: true,
    startPhaseDeg: 0,
    scoreMode: 'total', // 'total' | 'slotMult' | 'slotIndex'
    slotSpecText: DEFAULT_SLOT_TEXT,
    slotSpecs: DEFAULT_SLOT_SPECS,
    slotValues: DEFAULT_SLOT_SPECS.map((s) => s.value),
    quota: 100,
    naiveTarget: 0.5,
    naiveSigma: 0.28,
    trainedTarget: 0.5,
    trainedSigma: 0.032,
    trainedAutoAim: true,
    trainedAimGoal: 'ev', // 'ev' | 'quota'
    rayColorMode: 'score', // 'score' | 'skill' | 'slot'
    showHeatmap: true,
    exactParabola: true,
    adaptiveOversample: true
  };

  function makeSettings(overrides) {
    const merged = { ...DEFAULT_SETTINGS, ...overrides };
    const specs = parseSlotSpecs(overrides.slotSpecText || overrides.slotValues || DEFAULT_SLOT_TEXT);
    merged.slotSpecs = specs;
    merged.slotSpecText = formatSlotSpecs(specs);
    merged.slotValues = specs.map((s) => s.value);
    return merged;
  }

  function buildPresets() {
    return [
      {
        id: 'galton',
        name: 'Classic Galton (Bell Curve)',
        subtitle: 'Baseline additive peg lattice — watch the Central Limit Theorem form a bell curve, then drop complications to warp it.',
        settings: makeSettings({
          launcherMode: 'drop',
          gravity: 920,
          launchSpeed: 320,
          slotSpecText: '10, 20, 35, 55, 80, 100, 80, 55, 35, 20, 10',
          quota: 100,
          naiveSigma: 0.28,
          trainedSigma: 0.035
        }),
        buildObjects: () => makeGaltonGrid({
          rows: 8,
          colsEven: 9,
          startY: 132,
          rowGap: 58,
          colGap: 48,
          radius: 7.5,
          scoreAdd: 5
        })
      },
      {
        id: 'bimodalVault',
        name: 'Bimodal Vault (Funnels + Gate)',
        subtitle: 'Angled channels + a one-way bumper vault break independence, splitting the bell curve into two distinct outcome regimes.',
        settings: makeSettings({
          launcherMode: 'drop',
          gravity: 920,
          launchSpeed: 330,
          slotSpecText: '15, 20, 25, 30, 35, 40, 35, 30, 60, 95, 130',
          quota: 210,
          naiveSigma: 0.30,
          trainedSigma: 0.03
        }),
        buildObjects: () => {
          const objs = makeGaltonGrid({
            rows: 8,
            colsEven: 9,
            startY: 136,
            rowGap: 58,
            colGap: 48,
            radius: 7.5,
            scoreAdd: 5,
            filter: (x, y) => !(x > 338 && y > 170 && y < 515)
          });

          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Vault Funnel Left',
            x1: 312, y1: 112, x2: 364, y2: 205,
            color: '#94a3b8'
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Vault Divider',
            x1: 344, y1: 252, x2: 344, y2: 492,
            color: '#cbd5e1'
          }));
          objs.push(instantiateFromTemplate(tplById('oneWay'), 0, 0, {
            name: 'Vault 1-Way Lid',
            x1: 364, y1: 206, x2: 496, y2: 222,
            color: '#22d3ee'
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 404, 310, {
            name: 'Vault Bumper A',
            radius: 17,
            kickSpeed: 240,
            scoreAdd: 30
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 464, 378, {
            name: 'Vault Bumper B',
            radius: 17,
            kickSpeed: 240,
            scoreAdd: 30
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 410, 444, {
            name: 'Vault ×2 Core',
            scoreMult: 2,
            maxHitsPerShot: 2
          }));

          return objs;
        }
      },
      {
        id: 'peglinDelve',
        name: 'Peglin Multi-Shot Delve (3 Shots + Refresh)',
        subtitle: '3-shot round with Pop Peg depletion, Blast Bombs, Synergy Auras, Refresh Pegs, and special Replay/Hazard slots.',
        settings: makeSettings({
          boardWidth: 580,
          boardHeight: 740,
          chamberShape: 'funnel',
          launcherMode: 'cannon',
          gravity: 860,
          launchSpeed: 470,
          shotsPerRound: 3,
          enableSpinFriction: true,
          slotSpecText: 'H, 25, 40F, 70, 50R, 120, 50R, 70, 40F, 25, H',
          quota: 520,
          naiveSigma: 0.25,
          trainedSigma: 0.03
        }),
        buildObjects: () => {
          const objs = makeGaltonGrid({
            boardWidth: 580,
            rows: 7,
            colsEven: 9,
            startY: 162,
            rowGap: 62,
            colGap: 52,
            radius: 8,
            scoreAdd: 14,
            templateId: 'popPeg',
            filter: (x, y) => {
              if (Math.hypot(x - 290, y - 270) < 36) return false;
              if (Math.hypot(x - 190, y - 355) < 36) return false;
              if (Math.hypot(x - 390, y - 355) < 36) return false;
              if (Math.hypot(x - 290, y - 465) < 36) return false;
              return true;
            }
          });

          objs.push(instantiateFromTemplate(tplById('bombPeg'), 290, 270, {
            name: 'Central Bomb',
            bombRadius: 92,
            scoreAdd: 45
          }));
          objs.push(instantiateFromTemplate(tplById('synergyCore'), 190, 355, {
            name: 'Gold Aura L',
            auraRadius: 112,
            auraBuffAdd: 18
          }));
          objs.push(instantiateFromTemplate(tplById('refreshPeg'), 390, 355, {
            name: 'Board Refresh'
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 290, 465, {
            name: 'Vault ×2 Gem',
            scoreMult: 2,
            maxHitsPerShot: 3
          }));

          return objs;
        }
      },
      {
        id: 'ballionaireMill',
        name: 'Ballionaire Synergy Mill (Spinners + Bucket)',
        subtitle: 'Wide Pachinko Arch with rotating Spinner Blades, 3-Hit Counter Pins, Synergy Cores, Spin/Friction, Ball Collisions, and a Moving Bonus Bucket.',
        settings: makeSettings({
          boardWidth: 640,
          boardHeight: 760,
          chamberShape: 'arch',
          launcherMode: 'drop',
          gravity: 880,
          launchSpeed: 330,
          shotsPerRound: 1,
          enableSpinFriction: true,
          enableBallCollisions: true,
          movingBucket: true,
          bucketWidth: 88,
          bucketSpeed: 165,
          bucketMult: 2,
          bucketReplay: true,
          slotSpecText: 'H, 20, 40, 80, 30R, x2, 30R, 80, 40, 20, H',
          quota: 420,
          naiveSigma: 0.28,
          trainedSigma: 0.032
        }),
        buildObjects: () => {
          const objs = makeGaltonGrid({
            boardWidth: 640,
            rows: 6,
            colsEven: 9,
            startY: 166,
            rowGap: 72,
            colGap: 60,
            radius: 8,
            scoreAdd: 12,
            filter: (x, y) => {
              if (Math.hypot(x - 210, y - 310) < 62) return false;
              if (Math.hypot(x - 430, y - 310) < 62) return false;
              if (Math.hypot(x - 320, y - 435) < 48) return false;
              if (Math.hypot(x - 320, y - 220) < 38) return false;
              return true;
            }
          });

          objs.push(instantiateFromTemplate(tplById('splitter'), 320, 218, {
            name: 'Crown Splitter',
            splitCount: 2,
            splitSpreadDeg: 32,
            maxHitsPerShot: 2
          }));
          objs.push(instantiateFromTemplate(tplById('spinner'), 210, 310, {
            name: 'Left Mill Blade',
            length: 96,
            angularSpeedDeg: 145
          }));
          objs.push(instantiateFromTemplate(tplById('spinner'), 430, 310, {
            name: 'Right Mill Blade',
            length: 96,
            angularSpeedDeg: -145
          }));
          objs.push(instantiateFromTemplate(tplById('synergyCore'), 320, 345, {
            name: 'Synergy Hub',
            auraRadius: 120,
            auraBuffAdd: 20
          }));
          objs.push(instantiateFromTemplate(tplById('counterPin'), 320, 455, {
            name: 'Jackpot 3-Counter',
            triggerEveryN: 3,
            scoreAdd: 220,
            scoreMult: 1.5
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 158, 470, {
            name: 'Side Kicker L',
            oscAmpX: 28,
            oscFreq: 0.75
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 482, 470, {
            name: 'Side Kicker R',
            oscAmpX: -28,
            oscFreq: 0.75
          }));

          return objs;
        }
      },
      {
        id: 'bumperCriticality',
        name: 'Bumper Loop (Heavy Tail)',
        subtitle: 'Pivot cannon aiming into a resonant pinball bumper cage — demonstrates supercritical loops where Mean >> Median.',
        settings: makeSettings({
          launcherMode: 'cannon',
          gravity: 780,
          launchSpeed: 500,
          slotSpecText: '60, 30, 15, 10, 20, 40, 20, 10, 15, 30, 60',
          quota: 280,
          naiveSigma: 0.26,
          trainedSigma: 0.025
        }),
        buildObjects: () => {
          const objs = makeGaltonGrid({
            rows: 5,
            colsEven: 8,
            startY: 360,
            rowGap: 56,
            colGap: 54,
            radius: 7.5,
            scoreAdd: 8,
            templateId: 'popPeg',
            filter: (x, y) => !(Math.abs(x - 270) < 92 && y < 440)
          });

          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Cage Left Wall',
            x1: 158, y1: 175, x2: 196, y2: 332,
            restitution: 0.96
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Cage Right Wall',
            x1: 382, y1: 175, x2: 344, y2: 332,
            restitution: 0.96
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 224, 240, {
            name: 'Resonator Left',
            radius: 18,
            restitution: 1.25,
            kickSpeed: 245,
            scoreAdd: 25
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 316, 240, {
            name: 'Resonator Right',
            radius: 18,
            restitution: 1.25,
            kickSpeed: 245,
            scoreAdd: 25
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 270, 314, {
            name: 'Resonator Base',
            radius: 17,
            restitution: 1.28,
            kickSpeed: 260,
            scoreAdd: 30
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 270, 212, {
            name: 'Core ×2',
            radius: 13,
            scoreMult: 2,
            maxHitsPerShot: 2
          }));

          return objs;
        }
      },
      {
        id: 'splitterCascade',
        name: 'Splitter Cascade (Multiball)',
        subtitle: 'Ball splitters + pop-on-hit pegs + ×2 multipliers create compounding log-normal explosions. Try toggling Log X-Axis!',
        settings: makeSettings({
          launcherMode: 'cannon',
          gravity: 840,
          launchSpeed: 460,
          slotSpecText: '100, 50, 25, 12, 6, 4, 6, 12, 25, 50, 100',
          quota: 260,
          naiveSigma: 0.25,
          trainedSigma: 0.028
        }),
        buildObjects: () => {
          const objs = makeGaltonGrid({
            rows: 7,
            colsEven: 8,
            startY: 168,
            rowGap: 62,
            colGap: 54,
            radius: 8,
            scoreAdd: 12,
            templateId: 'popPeg',
            filter: (x, y) => {
              if (Math.hypot(x - 190, y - 220) < 34) return false;
              if (Math.hypot(x - 350, y - 220) < 34) return false;
              if (Math.hypot(x - 270, y - 350) < 36) return false;
              if (Math.hypot(x - 145, y - 445) < 34) return false;
              if (Math.hypot(x - 395, y - 445) < 34) return false;
              return true;
            }
          });

          objs.push(instantiateFromTemplate(tplById('splitter'), 190, 220, {
            name: 'Left Splitter',
            splitCount: 2,
            splitSpreadDeg: 30
          }));
          objs.push(instantiateFromTemplate(tplById('splitter'), 350, 220, {
            name: 'Right Splitter',
            splitCount: 2,
            splitSpreadDeg: 30
          }));
          objs.push(instantiateFromTemplate(tplById('splitter'), 270, 350, {
            name: 'Center Splitter',
            splitCount: 2,
            splitSpreadDeg: 34
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 145, 445, {
            name: 'Left ×2 Orb',
            scoreMult: 2,
            maxHitsPerShot: 3
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 395, 445, {
            name: 'Right ×2 Orb',
            scoreMult: 2,
            maxHitsPerShot: 3
          }));

          return objs;
        }
      },
      {
        id: 'portalWind',
        name: 'Portal Warp & Wind Drift',
        subtitle: 'A lateral wind field breaks symmetry while a lower-left warp portal recycles low drops into an upper-right multiplier run.',
        settings: makeSettings({
          launcherMode: 'drop',
          gravity: 860,
          launchSpeed: 310,
          slotSpecText: '5, 10, 15, 25, 40, 55, 70, 90, 115, 145, 180',
          quota: 195,
          naiveSigma: 0.28,
          trainedSigma: 0.032
        }),
        buildObjects: () => {
          const objs = makeGaltonGrid({
            rows: 7,
            colsEven: 8,
            startY: 144,
            rowGap: 62,
            colGap: 52,
            radius: 7.5,
            scoreAdd: 6,
            filter: (x, y) => Math.hypot(x - 122, y - 472) > 40 && Math.hypot(x - 418, y - 196) > 36
          });

          objs.push(instantiateFromTemplate(tplById('windZone'), 250, 290, {
            name: 'Eastward Wind',
            radius: 96,
            forceX: 540,
            forceY: -40
          }));
          objs.push(instantiateFromTemplate(tplById('portal'), 122, 472, {
            name: 'Rescue Portal',
            radius: 19,
            exitX: 416,
            exitY: 152,
            exitAngleDeg: 78,
            kickSpeed: 90,
            scoreAdd: 20,
            scoreMult: 1.5,
            maxHitsPerShot: 2
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 418, 260, {
            name: 'Chute ×2',
            scoreMult: 2,
            maxHitsPerShot: 2
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Portal Scoop',
            x1: 42, y1: 420, x2: 98, y2: 472,
            restitution: 0.85
          }));

          return objs;
        }
      },
      {
        id: 'opticalLaser',
        name: 'Optical Laser Chamber (0-G)',
        subtitle: 'Zero-gravity exact straight-line ray reflections off mirror prisms, circular lenses, and beam splitters.',
        settings: makeSettings({
          chamberShape: 'diamond',
          launcherMode: 'cannon',
          gravity: 0,
          launchSpeed: 520,
          ballRadius: 5,
          maxBounces: 42,
          slotSpecText: '120, 75, 40, 20, 10, 5, 10, 20, 40, 75, 120',
          quota: 160,
          naiveSigma: 0.28,
          trainedSigma: 0.024
        }),
        buildObjects: () => {
          const objs = [];
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Prism NW',
            x1: 270, y1: 185, x2: 182, y2: 295,
            color: '#60a5fa',
            restitution: 1.0,
            scoreAdd: 15
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Prism NE',
            x1: 270, y1: 185, x2: 358, y2: 295,
            color: '#60a5fa',
            restitution: 1.0,
            scoreAdd: 15
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Side Mirror L',
            x1: 58, y1: 245, x2: 108, y2: 435,
            color: '#e2e8f0',
            restitution: 1.0,
            scoreAdd: 12
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Side Mirror R',
            x1: 482, y1: 245, x2: 432, y2: 435,
            color: '#e2e8f0',
            restitution: 1.0,
            scoreAdd: 12
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Lower Deflector L',
            x1: 145, y1: 485, x2: 235, y2: 445,
            color: '#94a3b8',
            restitution: 1.0,
            scoreAdd: 10
          }));
          objs.push(instantiateFromTemplate(tplById('wall'), 0, 0, {
            name: 'Lower Deflector R',
            x1: 395, y1: 485, x2: 305, y2: 445,
            color: '#94a3b8',
            restitution: 1.0,
            scoreAdd: 10
          }));
          objs.push(instantiateFromTemplate(tplById('multiplier'), 270, 345, {
            name: 'Center Prism ×2',
            radius: 18,
            restitution: 1.0,
            scoreMult: 2,
            maxHitsPerShot: 2
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 156, 355, {
            name: 'Mirror Orb L',
            radius: 16,
            restitution: 1.0,
            kickSpeed: 0,
            scoreAdd: 25
          }));
          objs.push(instantiateFromTemplate(tplById('bumper'), 384, 355, {
            name: 'Mirror Orb R',
            radius: 16,
            restitution: 1.0,
            kickSpeed: 0,
            scoreAdd: 25
          }));
          objs.push(instantiateFromTemplate(tplById('splitter'), 270, 520, {
            name: 'Beam Splitter',
            radius: 15,
            splitCount: 2,
            splitSpreadDeg: 32
          }));

          return objs;
        }
      }
    ];
  }

  RP.Presets = {
    nextId,
    parseSlotSpecs,
    formatSlotSpecs,
    BUILTIN_TEMPLATES,
    DEFAULT_SETTINGS,
    makeSettings,
    instantiateFromTemplate,
    tplById,
    generateLattice,
    makeGaltonGrid,
    PRESETS: buildPresets()
  };
})();
