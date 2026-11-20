(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});
  const STORAGE_KEY = 'prismdrop_custom_templates_v1';

  const $ = (id) => document.getElementById(id);

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function loadCustomTemplates() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveCustomTemplates(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  const state = {
    presetId: 'galton',
    settings: deepClone(RP.Presets.DEFAULT_SETTINGS),
    objects: [],
    customTemplates: loadCustomTemplates(),
    activeTool: 'select', // 'select' or templateId
    selectedId: null,
    snapToGrid: false,

    // Solver & Chart comparison state
    solverMode: 'physics', // 'physics' | 'markov'
    markovFlowView: 'trained', // 'trained' | 'naive' | 'uniform'
    chartMode: 'pmf',      // 'pmf' | 'ccdf' | 'slots'
    compareMode: 'skill',  // 'skill' | 'baseline'
    logScale: false,

    // Simulation outputs (Physics)
    sweep: null,
    localTrainedSweep: null,
    convergence: null,

    // Simulation outputs (Exact Markov)
    markovSol: null,
    markovFlow: null,
    markovEntryWeights: null,
    markovHeat: null,
    markovBayesFlows: null,

    // Shared Analysis & Baselines
    analysis: null,
    baselineSweep: null,
    baselineMarkov: null,
    baselineAnalysis: null,
    baselineLabel: 'Clean Galton',
    effectiveTrainedTarget: 0.5,

    // Reverse attribution & inspection
    hoverBin: -1,
    lockedBin: -1,
    hoverSlot: -1,
    lockedSlot: -1,
    hoverObjId: null,
    highlightRaySet: null,
    inspectedU: null,
    inspectedTrace: null,

    // Undo stack
    undoStack: []
  };

  let boardView = null;
  let distChart = null;
  let sensChart = null;
  let recomputeQueued = false;
  let animRafId = 0;

  // ---------- History / Undo ----------
  function pushUndo() {
    state.undoStack.push({
      objects: deepClone(state.objects),
      settings: deepClone(state.settings)
    });
    if (state.undoStack.length > 35) state.undoStack.shift();
    $('btnUndo').disabled = state.undoStack.length === 0;
  }

  function popUndo() {
    if (state.undoStack.length === 0) return;
    const prev = state.undoStack.pop();
    state.objects = prev.objects;
    state.settings = prev.settings;
    state.selectedId = null;
    $('btnUndo').disabled = state.undoStack.length === 0;
    syncControlsFromSettings();
    renderLayerList();
    renderInspector();
    scheduleRecompute();
  }

  // ---------- Core Recompute & Analysis ----------
  function scheduleRecompute() {
    if (recomputeQueued) return;
    recomputeQueued = true;
    requestAnimationFrame(() => {
      recomputeQueued = false;
      recomputeNow();
    });
  }

  function recomputeNow() {
    const M = RP.Math;
    const E = RP.Engine;
    const s = state.settings;

    if (state.solverMode === 'markov') {
      // 1. Exact Closed-Form Absorbing Markov Chain + Exact PMF Solver
      state.markovSol = RP.Markov.solveBoard(state.objects, s);

      // 2. Exact Trained optimal aim over entry columns
      if (s.trainedAutoAim) {
        state.effectiveTrainedTarget = RP.Markov.findExactOptimalTarget(
          state.markovSol,
          s.trainedSigma,
          s.trainedAimGoal,
          s.quota
        );
        $('slTrainedTarget').value = state.effectiveTrainedTarget.toFixed(3);
        $('outTrainedTarget').textContent = formatAimLabel(state.effectiveTrainedTarget);
      } else {
        state.effectiveTrainedTarget = s.trainedTarget;
      }

      // 3. Exact mixtures + distributions + heatmaps
      recomputeAnalysisOnly();

      // 4. Quota slider dynamic max
      syncQuotaSliderBounds();

      // 5. Telemetry chip
      const g = state.markovSol.graph;
      $('perfChip').textContent = `Exact Markov · ${g.N} nodes · ${state.markovSol.elapsedMs.toFixed(1)} ms`;
    } else {
      // 1. Run deterministic physics ray sweep (Analytic Quartic Parabola or 0-G Optical or Zone CCD)
      state.sweep = E.runSweep(state.objects, s, -1);

      // 2. Resolve Trained user optimal aim (if auto-aim is enabled)
      if (s.trainedAutoAim) {
        state.effectiveTrainedTarget = M.findOptimalTarget(
          state.sweep.values,
          s.trainedSigma,
          s.trainedAimGoal,
          s.quota
        );
        $('slTrainedTarget').value = state.effectiveTrainedTarget.toFixed(3);
        $('outTrainedTarget').textContent = formatAimLabel(state.effectiveTrainedTarget);
      } else {
        state.effectiveTrainedTarget = s.trainedTarget;
      }

      // 3. Adaptive dense local oversampling inside Trained ±3.5σ window
      if (s.adaptiveOversample !== false) {
        state.localTrainedSweep = E.runLocalSweep(
          state.objects,
          s,
          state.effectiveTrainedTarget,
          s.trainedSigma,
          160
        );
      } else {
        state.localTrainedSweep = null;
      }

      // 4. Recompute statistical distributions + KS convergence metrics
      recomputeAnalysisOnly();

      // 5. Refresh single inspected ray if active
      if (state.inspectedU !== null) {
        state.inspectedTrace = E.traceSingleDetailed(state.inspectedU, state.objects, s);
      }

      // 6. Quota slider dynamic max
      syncQuotaSliderBounds();

      // 7. Telemetry chip
      const totalMs = state.sweep.elapsedMs + (state.localTrainedSweep ? state.localTrainedSweep.elapsedMs : 0);
      const totalRays = state.sweep.rayCount + (state.localTrainedSweep ? state.localTrainedSweep.count : 0);
      const cappedNote = state.sweep.cappedCount > 0 ? ` · ${state.sweep.cappedCount} looping` : '';
      $('perfChip').textContent = `${totalRays} rays · ${totalMs.toFixed(1)} ms${cappedNote}`;
    }

    // 8. Render all views, KPIs, Round Strip & Proof/Convergence banner
    syncBoardFrameSize();
    updateHighlightSet();
    renderAllViews();
    updateKPIs();
    updateRoundStrip();
    updateProofBanner();
    updateStageStatus();

    // Persist live lab board so clock.html can run your custom board immediately
    try {
      localStorage.setItem('prismdrop_live_board_v1', JSON.stringify({
        settings: state.settings,
        objects: state.objects
      }));
    } catch (_) {}
  }

  function syncBoardFrameSize() {
    const m = RP.Engine.getBoardMetrics(state.settings);
    const frame = $('boardFrame');
    if (!frame) return;
    frame.style.aspectRatio = `${m.W} / ${m.H}`;
    frame.style.inlineSize = `min(100%, calc((100dvb - 165px) * ${(m.W / m.H).toFixed(4)}))`;
  }

  function rescaleObjectsForBoard(oldW, oldH, newW, newH) {
    if (oldW === newW && oldH === newH) return;
    const oldLeft = 22, oldRight = oldW - 22, oldTop = 22, oldFloor = oldH - 52;
    const newLeft = 22, newRight = newW - 22, newTop = 22, newFloor = newH - 52;
    const sx = (newRight - newLeft) / Math.max(1, oldRight - oldLeft);
    const sy = (newFloor - newTop) / Math.max(1, oldFloor - oldTop);
    const mapX = (x) => RP.Math.clamp(newLeft + (x - oldLeft) * sx, newLeft + 10, newRight - 10);
    const mapY = (y) => RP.Math.clamp(newTop + (y - oldTop) * sy, newTop + 36, newFloor - 14);

    for (const o of state.objects) {
      if (o.shape === 'segment') {
        o.x1 = mapX(o.x1);
        o.y1 = mapY(o.y1);
        o.x2 = mapX(o.x2);
        o.y2 = mapY(o.y2);
      } else {
        o.x = mapX(o.x);
        o.y = mapY(o.y);
        if (o.shape === 'portal') {
          o.exitX = mapX(o.exitX);
          o.exitY = mapY(o.exitY);
        }
      }
    }
  }

  function updateRoundStrip() {
    const el = $('roundStrip');
    const shots = state.settings.shotsPerRound || 1;
    if (state.solverMode === 'markov' || shots <= 1 || !state.sweep || !state.sweep.shotMeans) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const means = state.sweep.shotMeans;
    const parts = [];
    for (let i = 0; i < means.length; i++) {
      parts.push(`<span class="round-pill">Shot ${i + 1}: ${RP.Math.formatNumber(means[i])}</span>`);
    }
    const delta = means[means.length - 1] - means[0];
    const trend = Math.abs(delta) < 1
      ? 'Flat'
      : delta > 0
        ? `<span class="delta-pos">+${RP.Math.formatNumber(delta)} scaling</span>`
        : `<span class="delta-neg">${RP.Math.formatNumber(delta)} depletion</span>`;
    el.innerHTML = `<strong>Round EV:</strong> ${parts.join('<span class="round-arrow">→</span>')} · ${trend}`;
  }

  function syncQuotaSliderBounds() {
    const M = RP.Math;
    const s = state.settings;
    const maxObserved = state.analysis ? state.analysis.binSpec.maxV : 200;
    const slQuota = $('slQuota');
    const desiredMax = Math.max(150, Math.ceil((Math.max(maxObserved, s.quota) * 1.15) / 10) * 10);
    if (Number(slQuota.max) !== desiredMax) {
      slQuota.max = String(desiredMax);
      slQuota.step = desiredMax > 1200 ? '25' : desiredMax > 400 ? '10' : '5';
    }
    slQuota.value = String(s.quota);
    $('outQuota').textContent = M.formatNumber(s.quota);
    updateFallbackRangeProgress(slQuota);
  }

  function recomputeAnalysisOnly() {
    const M = RP.Math;
    const s = state.settings;

    if (state.solverMode === 'markov') {
      const sol = state.markovSol;
      if (!sol) return;
      const g = sol.graph;
      const base = state.baselineMarkov;

      const curMax = state.logScale ? sol.maxScore : sol.p995Score;
      const rangePts = [sol.minScore, Math.max(sol.minScore + 1, curMax)];
      if (base) {
        rangePts.push(base.minScore, state.logScale ? base.maxScore : base.p995Score);
      }
      const binSpec = M.computeBinSpec(rangePts, 22, state.logScale);

      const wU = new Float64Array(g.entryCols).fill(1 / Math.max(1, g.entryCols));
      const wN = M.gaussianWeights(g.entryCols, s.naiveTarget, s.naiveSigma);
      const wT = M.gaussianWeights(g.entryCols, state.effectiveTrainedTarget, s.trainedSigma);

      const mU = RP.Markov.mixByWeights(sol, wU);
      const mN = RP.Markov.mixByWeights(sol, wN);
      const mT = RP.Markov.mixByWeights(sol, wT);

      const uniform = RP.Markov.analyzeExactPmf(mU.pmf, mU.slotPmf, binSpec, s.quota);
      const naive = RP.Markov.analyzeExactPmf(mN.pmf, mN.slotPmf, binSpec, s.quota);
      const trained = RP.Markov.analyzeExactPmf(mT.pmf, mT.slotPmf, binSpec, s.quota);
      const mutualInfo = RP.Markov.computeExactMutualInfo(sol, binSpec, s.trainedSigma);

      state.analysis = { binSpec, uniform, naive, trained, mutualInfo };

      // Select active Sankey flow population for the board canvas
      if (state.markovFlowView === 'naive') {
        state.markovFlow = mN;
        state.markovEntryWeights = wN;
      } else if (state.markovFlowView === 'uniform') {
        state.markovFlow = mU;
        state.markovEntryWeights = wU;
      } else {
        state.markovFlow = mT;
        state.markovEntryWeights = wT;
      }

      // Build node heat map from exact Fundamental Matrix expected visits
      const heat = new Map();
      for (let i = 0; i < g.N; i++) {
        heat.set(g.nodes[i].id, state.markovFlow.expectedVisits[i] || 0);
      }
      state.markovHeat = heat;

      if (base) {
        const bg = base.graph;
        const bwU = new Float64Array(bg.entryCols).fill(1 / Math.max(1, bg.entryCols));
        const bwN = M.gaussianWeights(bg.entryCols, s.naiveTarget, s.naiveSigma);
        const bwT = M.gaussianWeights(bg.entryCols, state.effectiveTrainedTarget, s.trainedSigma);
        const bmU = RP.Markov.mixByWeights(base, bwU);
        const bmN = RP.Markov.mixByWeights(base, bwN);
        const bmT = RP.Markov.mixByWeights(base, bwT);
        state.baselineAnalysis = {
          binSpec,
          uniform: RP.Markov.analyzeExactPmf(bmU.pmf, bmU.slotPmf, binSpec, s.quota),
          naive: RP.Markov.analyzeExactPmf(bmN.pmf, bmN.slotPmf, binSpec, s.quota),
          trained: RP.Markov.analyzeExactPmf(bmT.pmf, bmT.slotPmf, binSpec, s.quota),
          mutualInfo: RP.Markov.computeExactMutualInfo(base, binSpec, s.trainedSigma)
        };
      } else {
        state.baselineAnalysis = null;
      }
      return;
    }

    if (!state.sweep) return;

    // Physics Mode: Combine current (+ local oversampled + baseline) to guarantee aligned histogram bins
    const curVals = state.sweep.values;
    const baseVals = state.baselineSweep ? state.baselineSweep.values : null;
    const locVals = state.localTrainedSweep ? state.localTrainedSweep.values : null;
    const totalLen = curVals.length + (baseVals ? baseVals.length : 0) + (locVals ? locVals.length : 0);
    const combined = new Float64Array(totalLen);
    let off = 0;
    combined.set(curVals, off); off += curVals.length;
    if (locVals) { combined.set(locVals, off); off += locVals.length; }
    if (baseVals) { combined.set(baseVals, off); }

    const binCount = 22;
    const binSpec = M.computeBinSpec(combined, binCount, state.logScale);
    const slotCount = s.slotValues.length;

    const wUniform = new Float64Array(curVals.length).fill(1 / Math.max(1, curVals.length));
    const wNaive = M.gaussianWeights(curVals.length, s.naiveTarget, s.naiveSigma);
    const wTrainedCoarse = M.gaussianWeights(curVals.length, state.effectiveTrainedTarget, s.trainedSigma);

    const uniform = M.analyzeDistribution(curVals, state.sweep.slots, wUniform, binSpec, slotCount, s.quota);
    const naive = M.analyzeDistribution(curVals, state.sweep.slots, wNaive, binSpec, slotCount, s.quota);

    let trained;
    let convTrained;
    if (state.localTrainedSweep) {
      const loc = state.localTrainedSweep;
      trained = M.analyzeDistribution(loc.values, loc.slots, loc.weights, binSpec, slotCount, s.quota);
      convTrained = M.computeConvergence(loc.values, loc.slots, loc.weights, binSpec, slotCount, s.quota);
    } else {
      trained = M.analyzeDistribution(curVals, state.sweep.slots, wTrainedCoarse, binSpec, slotCount, s.quota);
      convTrained = M.computeConvergence(curVals, state.sweep.slots, wTrainedCoarse, binSpec, slotCount, s.quota);
    }

    const convGlobal = M.computeConvergence(curVals, state.sweep.slots, wUniform, binSpec, slotCount, s.quota);
    const mutualInfo = M.computeSkillMutualInfo(curVals, binSpec, s.trainedSigma);

    state.convergence = {
      global: convGlobal,
      trained: convTrained,
      oversampled: Boolean(state.localTrainedSweep)
    };

    state.analysis = {
      binSpec,
      uniform,
      naive,
      trained,
      mutualInfo
    };

    if (state.baselineSweep) {
      const bVals = state.baselineSweep.values;
      const bSlots = state.baselineSweep.slots;
      const bSlotCount = state.baselineSweep.slotCount || slotCount;
      const bwUniform = new Float64Array(bVals.length).fill(1 / Math.max(1, bVals.length));
      const bwNaive = M.gaussianWeights(bVals.length, s.naiveTarget, s.naiveSigma);
      const bwTrained = M.gaussianWeights(bVals.length, state.effectiveTrainedTarget, s.trainedSigma);
      state.baselineAnalysis = {
        binSpec,
        uniform: M.analyzeDistribution(bVals, bSlots, bwUniform, binSpec, bSlotCount, s.quota),
        naive: M.analyzeDistribution(bVals, bSlots, bwNaive, binSpec, bSlotCount, s.quota),
        trained: M.analyzeDistribution(bVals, bSlots, bwTrained, binSpec, bSlotCount, s.quota),
        mutualInfo: M.computeSkillMutualInfo(bVals, binSpec, s.trainedSigma)
      };
    } else {
      state.baselineAnalysis = null;
    }
  }

  function updateProofBanner() {
    const banner = $('proofBanner');
    const badge = $('proofBadge');
    const text = $('proofText');

    banner.classList.remove('proof-exact', 'proof-converged', 'proof-moderate', 'proof-chaotic');

    if (state.solverMode === 'markov') {
      const sol = state.markovSol;
      if (!sol) return;
      if (!sol.matrixOk) {
        banner.classList.add('proof-chaotic');
        badge.textContent = 'Supercritical Trap';
        text.innerHTML = 'Singular (I−Q): an inescapable 100% loop exists with zero exit path.';
        return;
      }
      const massPct = (sol.minAbsorbedMass * 100).toFixed(sol.minAbsorbedMass > 0.9999 ? 2 : 3);
      banner.classList.add('proof-exact');
      badge.textContent = '✓ Provable Exact';
      text.innerHTML = `Closed-form <strong>(I−Q)⁻¹</strong> · Slot row error <strong>${sol.maxRowError.toExponential(1)}</strong> · Absorbed mass <strong>${massPct}%</strong>`;
      return;
    }

    const sw = state.sweep;
    const conv = state.convergence;
    if (!sw || !conv) return;

    const solverLabel = sw.solverKind === 'optical'
      ? 'Exact 0-G Optical'
      : sw.solverKind === 'analytic'
        ? 'Exact Quartic Parabola'
        : sw.solverKind === 'rigidbody'
          ? 'Rigid-Body Lockstep CCD (75Hz)'
          : 'Substep Zone CCD (75Hz)';

    const gKS = (conv.global.ks * 100).toFixed(1);
    const tKS = (conv.trained.ks * 100).toFixed(1);
    const worst = Math.max(conv.global.ks, conv.trained.ks);

    if (worst < 0.04) {
      banner.classList.add('proof-converged');
      badge.textContent = '✓ Converged';
    } else if (worst < 0.10) {
      banner.classList.add('proof-moderate');
      badge.textContent = '~ Moderate KS';
    } else {
      banner.classList.add('proof-chaotic');
      badge.textContent = '⚠ Chaotic Ridge';
    }

    const overNote = conv.oversampled ? ' (+160 dense)' : '';
    text.innerHTML = `<strong>${solverLabel}</strong> · Global KS <strong>±${gKS}%</strong> · Trained KS <strong>±${tKS}%</strong>${overNote}`;
  }

  function updateHighlightSet() {
    if (state.solverMode === 'markov') {
      state.highlightRaySet = null;
      const activeSlot = state.hoverSlot >= 0 ? state.hoverSlot : state.lockedSlot;
      if (activeSlot >= 0 && state.markovSol && state.markovFlow) {
        state.markovBayesFlows = RP.Markov.computeSlotBayesianFlows(state.markovSol, state.markovFlow, activeSlot);
      } else {
        state.markovBayesFlows = null;
      }
      return;
    }

    state.markovBayesFlows = null;
    if (!state.analysis || !state.sweep) {
      state.highlightRaySet = null;
      return;
    }

    const activeBin = state.hoverBin >= 0 ? state.hoverBin : state.lockedBin;
    const activeSlot = state.hoverSlot >= 0 ? state.hoverSlot : state.lockedSlot;

    if (activeBin >= 0 && state.chartMode !== 'slots') {
      const set = new Set();
      if (state.chartMode === 'ccdf') {
        for (let b = activeBin; b < state.analysis.binSpec.binCount; b++) {
          for (const idx of state.analysis.uniform.binMembers[b]) set.add(idx);
        }
      } else {
        const members = state.analysis.uniform.binMembers[activeBin] || [];
        for (const idx of members) set.add(idx);
      }
      state.highlightRaySet = set;
      return;
    }

    if (activeSlot >= 0) {
      const set = new Set();
      const traces = state.sweep.traces;
      for (let i = 0; i < traces.length; i++) {
        if (traces[i].primarySlot === activeSlot) set.add(i);
      }
      state.highlightRaySet = set;
      return;
    }

    state.highlightRaySet = null;
  }

  function renderAllViews() {
    if (boardView) boardView.render(state);
    if (distChart) distChart.render(state);
    if (sensChart) sensChart.render(state);
  }

  function ensureAnimLoop() {
    if (animRafId) return;
    const tick = () => {
      if (boardView) boardView.render(state);
      if (boardView && boardView.hasActiveAnimations()) {
        animRafId = requestAnimationFrame(tick);
      } else {
        animRafId = 0;
      }
    };
    animRafId = requestAnimationFrame(tick);
  }

  // ---------- KPIs & Legends ----------
  function formatDelta(cur, base, suffix = '', pct = false) {
    if (!Number.isFinite(base)) return '';
    const diff = cur - base;
    if (Math.abs(diff) < 1e-4) return '';
    const cls = diff > 0 ? 'delta-pos' : 'delta-neg';
    const sign = diff > 0 ? '+' : '';
    const text = pct ? `${sign}${(diff * 100).toFixed(1)}%` : `${sign}${RP.Math.formatNumber(diff)}${suffix}`;
    return ` <span class="${cls}">(${text})</span>`;
  }

  function updateKPIs() {
    const M = RP.Math;
    const a = state.analysis;
    if (!a) return;
    const b = state.baselineAnalysis;
    const isSkill = state.compareMode === 'skill';

    // 1. Expected Score & Median
    if (isSkill) {
      $('kpiMean').textContent = M.formatNumber(a.trained.mean);
      $('kpiMeanSub').innerHTML = `Naive ${M.formatNumber(a.naive.mean)} · Med ${M.formatNumber(a.trained.median)}`;
    } else {
      $('kpiMean').innerHTML = M.formatNumber(a.uniform.mean) + (b ? formatDelta(a.uniform.mean, b.uniform.mean) : '');
      $('kpiMeanSub').innerHTML = `Med ${M.formatNumber(a.uniform.median)} · σ ${M.formatNumber(a.uniform.std)}`;
    }

    // 2. Variety (Entropy & Skewness)
    const refStats = isSkill ? a.uniform : a.uniform;
    const entPct = (refStats.entropyNorm * 100).toFixed(0) + '%';
    $('kpiEntropy').innerHTML = entPct + (b ? formatDelta(refStats.entropyNorm, b.uniform.entropyNorm, '', true) : '');
    const skewStr = (refStats.skewness >= 0 ? '+' : '') + refStats.skewness.toFixed(2);
    $('kpiEntropySub').textContent = `H ${refStats.entropyBits.toFixed(2)}b · Skew ${skewStr}`;

    // 3. Fat-Tail Ratio (P99 / P50)
    const tailStats = isSkill ? a.uniform : a.uniform;
    $('kpiTail').innerHTML = `${tailStats.tailRatio.toFixed(2)}×` + (b ? formatDelta(tailStats.tailRatio, b.uniform.tailRatio, '×') : '');
    $('kpiTailSub').textContent = `P90 ${M.formatNumber(tailStats.p90)} · P99 ${M.formatNumber(tailStats.p99)}`;

    // 4. Skill Agency (Mutual Information & Trained/Naive ratio)
    const edge = a.trained.mean / Math.max(0.01, a.naive.mean);
    $('kpiSkill').innerHTML = `${a.mutualInfo.toFixed(2)} bits` + (b ? formatDelta(a.mutualInfo, b.mutualInfo, 'b') : '');
    $('kpiSkillSub').textContent = `Trained ${edge.toFixed(2)}× Naive EV`;

    // Legend & Quota pass pills
    const legendEl = $('distLegend');
    const pillsEl = $('quotaPills');

    if (isSkill) {
      legendEl.innerHTML = `
        <span class="legend-item"><span class="swatch-line" style="background:#06b6d4"></span>Trained</span>
        <span class="legend-item"><span class="swatch-line" style="background:#f59e0b"></span>Naive</span>
        ${b ? `<span class="legend-item"><span class="swatch-dashed"></span>Baseline</span>` : ''}
      `;
      const qT = (a.trained.quotaProb * 100).toFixed(1);
      const qN = (a.naive.quotaProb * 100).toFixed(1);
      pillsEl.innerHTML = `
        <span class="quota-pill quota-pill-trained">Trained ≥Q: ${qT}%</span>
        <span class="quota-pill quota-pill-naive">Naive ≥Q: ${qN}%</span>
      `;
    } else {
      legendEl.innerHTML = `
        <span class="legend-item"><span class="swatch-line" style="background:#06b6d4"></span>Current Board</span>
        ${b ? `<span class="legend-item"><span class="swatch-dashed"></span>Baseline (${escapeHtml(state.baselineLabel)})</span>` : ''}
      `;
      const qC = (a.uniform.quotaProb * 100).toFixed(1);
      const qB = b ? (b.uniform.quotaProb * 100).toFixed(1) : '—';
      pillsEl.innerHTML = `
        <span class="quota-pill quota-pill-trained">Current ≥Q: ${qC}%</span>
        ${b ? `<span class="quota-pill">Base ≥Q: ${qB}%</span>` : ''}
      `;
    }
  }

  function updateStageStatus() {
    const el = $('stageStatus');
    const M = RP.Math;

    if (state.solverMode === 'markov') {
      const sol = state.markovSol;
      const activeSlot = state.hoverSlot >= 0 ? state.hoverSlot : state.lockedSlot;
      if (activeSlot >= 0 && state.markovFlow) {
        const pSlot = ((state.markovFlow.slotPmf[activeSlot] || 0) * 100).toFixed(2);
        const lockedNote = state.lockedSlot >= 0 ? ' (Locked — click again or press Esc)' : '';
        el.innerHTML = `Exact Bayesian Attribution: Slot <strong>#${activeSlot + 1}</strong> (exact P = <strong>${pSlot}%</strong>) — gold edges show P(path | slot)${lockedNote}`;
        return;
      }

      if (state.hoverObjId && sol && state.markovFlow) {
        const node = sol.graph.nodes.find((n) => n.id === state.hoverObjId);
        if (node) {
          const vis = state.markovFlow.expectedVisits[node.idx] || 0;
          const edges = sol.graph.adj[node.idx] || [];
          const edgeDesc = edges
            .map((e) => `${e.kind === 'loop' ? '↻' : e.kind === 'portal' ? '◎' : '→'}${(e.p * 100).toFixed(0)}%`)
            .join(' · ');
          el.innerHTML = `Node <strong>${escapeHtml(node.obj.name)}</strong> · Exact E[visits] = <strong>${vis.toFixed(3)}</strong> · Outgoing: ${edgeDesc}`;
          return;
        }
      }

      if (state.inspectedU !== null && sol) {
        const g = sol.graph;
        const c = M.clamp(Math.round(state.inspectedU * (g.entryCols - 1)), 0, g.entryCols - 1);
        el.innerHTML = `Entry <strong>${formatAimLabel(state.inspectedU)}</strong> → Exact E[Score] = <strong>${M.formatNumber(sol.entryMeans[c])}</strong>`;
        return;
      }

      el.innerHTML = 'Exact Markov Mode: edges show exact probability flow F(u→v) = E[visits(u)]·P(u→v). Hover any peg to inspect exact E[visits], or click any bottom slot for Bayesian reverse attribution.';
      return;
    }

    if (state.inspectedTrace) {
      const tr = state.inspectedTrace;
      const aimText = formatAimLabel(tr.u);
      const ballsNote = tr.ballCount > 1 ? ` · <strong>${tr.ballCount} balls</strong>` : '';
      const shotsNote = tr.shotScores && tr.shotScores.length > 1
        ? ` · Shots [${Array.from(tr.shotScores).map((v) => M.formatNumber(v)).join(' + ')}]`
        : '';
      const capNote = tr.capped ? ' · <em>loop capped</em>' : '';
      el.innerHTML = `Ray <strong>${aimText}</strong> → Score <strong>${M.formatNumber(tr.finalScore)}</strong>${shotsNote} · Slot #${tr.primarySlot + 1} · ${tr.bounces} bounces${ballsNote}${capNote}`;
      return;
    }

    if (state.highlightRaySet && state.highlightRaySet.size > 0) {
      const count = state.highlightRaySet.size;
      const pct = ((count / Math.max(1, state.sweep.rayCount)) * 100).toFixed(1);
      const lockedNote = (state.lockedBin >= 0 || state.lockedSlot >= 0) ? ' (Locked — click again or press Esc to clear)' : '';
      el.innerHTML = `Reverse Attribution: showing <strong>${count} rays (${pct}%)</strong> matching selection${lockedNote}`;
      return;
    }

    if (state.activeTool !== 'select') {
      const tpl = getActiveTemplate();
      if (tpl) {
        const how = tpl.shape === 'segment' ? 'Click & drag on the board to draw' : 'Click anywhere on the board to place';
        el.innerHTML = `Placing <strong>${escapeHtml(tpl.name)}</strong> — ${how}. Press <strong>Esc</strong> to return to Select.`;
        return;
      }
    }

    el.innerHTML = 'Hover the launch rail or sensitivity curve to trace a single ray · Click any chart bar or bottom slot for reverse attribution · Drag pegs, walls, or aim handles (T / N).';
  }

  function formatAimLabel(u) {
    if (state.settings.launcherMode === 'cannon') {
      return `${Math.round(16 + (164 - 16) * u)}°`;
    }
    return `${Math.round(u * 100)}%`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- Palette & Layer Stack UI ----------
  function getAllTemplates() {
    return [...RP.Presets.BUILTIN_TEMPLATES, ...state.customTemplates];
  }

  function getActiveTemplate() {
    if (state.activeTool === 'select') return null;
    return getAllTemplates().find((t) => t.templateId === state.activeTool) || null;
  }

  function setActiveTool(toolId) {
    state.activeTool = toolId;
    document.querySelectorAll('.palette-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === toolId);
    });
    updateStageStatus();
    if (boardView) boardView.render(state);
  }

  function renderPalette() {
    const grid = $('paletteGrid');
    grid.innerHTML = '';

    // Select tool first
    const selBtn = document.createElement('button');
    selBtn.type = 'button';
    selBtn.className = 'palette-btn' + (state.activeTool === 'select' ? ' active' : '');
    selBtn.dataset.tool = 'select';
    selBtn.innerHTML = `
      <span class="palette-swatch" style="color:#38bdf8;background:#0f172a">↖</span>
      <span class="palette-label">Select</span>
    `;
    selBtn.addEventListener('click', () => setActiveTool('select'));
    grid.appendChild(selBtn);

    for (const tpl of RP.Presets.BUILTIN_TEMPLATES) {
      grid.appendChild(createPaletteButton(tpl, false));
    }

    // Custom built complications
    const wrap = $('customPaletteWrap');
    const cGrid = $('customPaletteGrid');
    cGrid.innerHTML = '';
    if (state.customTemplates.length > 0) {
      wrap.hidden = false;
      for (const tpl of state.customTemplates) {
        cGrid.appendChild(createPaletteButton(tpl, true));
      }
    } else {
      wrap.hidden = true;
    }
  }

  function createPaletteButton(tpl, isCustom) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'palette-btn' + (state.activeTool === tpl.templateId ? ' active' : '');
    btn.dataset.tool = tpl.templateId;
    btn.title = `${tpl.name} (${tpl.shape})`;
    btn.innerHTML = `
      <span class="palette-swatch" style="color:${escapeHtml(tpl.color)};background:${escapeHtml(tpl.color)}28">${escapeHtml(tpl.tag || '★')}</span>
      <span class="palette-label">${escapeHtml(tpl.name)}</span>
    `;
    btn.addEventListener('click', () => setActiveTool(tpl.templateId));

    if (isCustom) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'palette-del';
      del.title = 'Remove custom template';
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.customTemplates = state.customTemplates.filter((t) => t.templateId !== tpl.templateId);
        saveCustomTemplates(state.customTemplates);
        if (state.activeTool === tpl.templateId) setActiveTool('select');
        renderPalette();
      });
      btn.appendChild(del);
    }

    return btn;
  }

  function renderLayerList() {
    const ul = $('layerList');
    const comps = state.objects.filter((o) => o.layerGroup !== 'base');
    const baseObjs = state.objects.filter((o) => o.layerGroup === 'base');
    $('layerCountBadge').textContent = String(comps.length);

    $('chkToggleBase').checked = baseObjs.length === 0 || baseObjs.some((o) => o.enabled !== false);
    $('chkToggleComps').checked = comps.length === 0 || comps.some((o) => o.enabled !== false);

    ul.innerHTML = '';
    if (comps.length === 0) {
      ul.innerHTML = '<li class="layer-empty">No complications yet — pick one above and click the board!</li>';
      return;
    }

    for (const obj of comps) {
      const li = document.createElement('li');
      li.className = 'layer-item' + (obj.id === state.selectedId ? ' selected' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = obj.enabled !== false;
      cb.ariaLabel = `Toggle ${obj.name}`;
      cb.addEventListener('change', () => {
        pushUndo();
        obj.enabled = cb.checked;
        renderLayerList();
        scheduleRecompute();
      });

      const dot = document.createElement('span');
      dot.className = 'layer-dot';
      dot.style.background = obj.color || '#38bdf8';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'layer-name';
      nameSpan.textContent = obj.name || obj.kind;
      nameSpan.title = `${obj.name} (${obj.shape})`;
      nameSpan.addEventListener('click', () => selectObject(obj.id));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-xs btn-danger';
      delBtn.textContent = '×';
      delBtn.title = 'Remove complication';
      delBtn.addEventListener('click', () => deleteObject(obj.id));

      li.append(cb, dot, nameSpan, delBtn);
      ul.appendChild(li);
    }
  }

  // ---------- Selected Object Inspector ----------
  function selectObject(id) {
    state.selectedId = id;
    renderLayerList();
    renderInspector();
    if (boardView) boardView.render(state);
  }

  function deleteObject(id) {
    if (!id) return;
    pushUndo();
    state.objects = state.objects.filter((o) => o.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    renderLayerList();
    renderInspector();
    scheduleRecompute();
  }

  function duplicateSelected() {
    if (!state.selectedId) return;
    const src = state.objects.find((o) => o.id === state.selectedId);
    if (!src) return;
    pushUndo();
    const copy = deepClone(src);
    const m = RP.Engine.getBoardMetrics(state.settings);
    copy.id = RP.Presets.nextId(copy.kind || 'obj');
    if (copy.shape === 'segment') {
      copy.x1 = RP.Math.clamp(copy.x1 + 18, m.left + 6, m.right - 6);
      copy.x2 = RP.Math.clamp(copy.x2 + 18, m.left + 6, m.right - 6);
      copy.y1 = RP.Math.clamp(copy.y1 + 18, m.top + 36, m.floorY - 12);
      copy.y2 = RP.Math.clamp(copy.y2 + 18, m.top + 36, m.floorY - 12);
    } else {
      copy.x = RP.Math.clamp(copy.x + 22, m.left + 12, m.right - 12);
      copy.y = RP.Math.clamp(copy.y + 22, m.top + 46, m.floorY - 18);
      if (copy.shape === 'portal') {
        copy.exitX = RP.Math.clamp(copy.exitX + 22, m.left + 14, m.right - 14);
        copy.exitY = RP.Math.clamp(copy.exitY + 22, m.top + 46, m.floorY - 20);
      }
    }
    state.objects.push(copy);
    selectObject(copy.id);
    scheduleRecompute();
  }

  function renderInspector() {
    const card = $('inspectorCard');
    const body = $('inspectorBody');
    const obj = state.objects.find((o) => o.id === state.selectedId);
    if (!obj) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('inspectorTitle').textContent = `Edit: ${obj.name || obj.kind}`;
    body.innerHTML = '';

    const addField = (label, type, key, opts = {}) => {
      const wrap = document.createElement('div');
      wrap.className = 'field-block' + (opts.span2 ? ' span-2' : '');

      if (type === 'checkbox') {
        const lbl = document.createElement('label');
        lbl.className = 'check-inline';
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = Boolean(obj[key]);
        inp.addEventListener('change', () => {
          pushUndo();
          obj[key] = inp.checked;
          scheduleRecompute();
          renderLayerList();
        });
        const sp = document.createElement('span');
        sp.textContent = label;
        lbl.append(inp, sp);
        wrap.appendChild(lbl);
        body.appendChild(wrap);
        return;
      }

      const lbl = document.createElement('label');
      lbl.className = 'field-label';
      lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = type;
      inp.value = obj[key] != null ? obj[key] : '';
      if (opts.min != null) inp.min = opts.min;
      if (opts.max != null) inp.max = opts.max;
      if (opts.step != null) inp.step = opts.step;

      inp.addEventListener('input', () => {
        if (type === 'number') {
          if (opts.optional && inp.value.trim() === '') {
            delete obj[key];
            scheduleRecompute();
            return;
          }
          const n = parseFloat(inp.value);
          if (!Number.isFinite(n)) return;
          obj[key] = n;
        } else {
          obj[key] = inp.value;
          if (key === 'name') {
            $('inspectorTitle').textContent = `Edit: ${obj.name}`;
            renderLayerList();
          }
          if (key === 'color') renderLayerList();
        }
        scheduleRecompute();
      });
      inp.addEventListener('change', () => pushUndo());

      wrap.append(lbl, inp);
      body.appendChild(wrap);
    };

    addField('Name', 'text', 'name');
    addField('Color', 'color', 'color');
    addField('Tag', 'text', 'tag');
    addField('Score Add (+/-)', 'number', 'scoreAdd', { step: 5 });
    addField('Score Mult (×)', 'number', 'scoreMult', { min: 0.25, max: 10, step: 0.25 });

    if (obj.shape === 'circle' || obj.shape === 'portal' || obj.shape === 'zone') {
      addField('Radius (px)', 'number', 'radius', { min: 4, max: 150, step: 1 });
    }
    if (obj.shape === 'circle' || obj.shape === 'segment') {
      addField('Restitution', 'number', 'restitution', { min: 0.1, max: 2.0, step: 0.05 });
      addField('Kick Speed', 'number', 'kickSpeed', { min: 0, max: 550, step: 10 });
      addField('Bias Angle (°)', 'number', 'biasAngle', { min: -45, max: 45, step: 2 });
      addField('Tangent Spin', 'number', 'tangentialBoost', { min: -350, max: 350, step: 15 });
      addField('Split Balls', 'number', 'splitCount', { min: 1, max: 3, step: 1 });
      addField('Pop After N Hits', 'number', 'maxHitsPerShot', { min: 0, max: 20, step: 1 });
      addField('Trigger Every N', 'number', 'triggerEveryN', { min: 1, max: 10, step: 1 });
      addField('Oscillate X (px)', 'number', 'oscAmpX', { min: -140, max: 140, step: 5 });
      addField('Oscillate Y (px)', 'number', 'oscAmpY', { min: -140, max: 140, step: 5 });
      addField('Osc Freq (Hz)', 'number', 'oscFreq', { min: 0.1, max: 3, step: 0.1 });
    }
    if (obj.shape === 'circle') {
      addField('Aura Radius (px)', 'number', 'auraRadius', { min: 0, max: 220, step: 5 });
      addField('Aura Buff (+Pts)', 'number', 'auraBuffAdd', { min: -100, max: 200, step: 5 });
      addField('Bomb Blast Radius', 'number', 'bombRadius', { min: 20, max: 180, step: 5 });
      addField('Refresh All Popped Pegs on Hit', 'checkbox', 'isRefresh', { span2: true });
      addField('Explode Nearby Pegs (Bomb)', 'checkbox', 'isBomb', { span2: true });
    }
    if (obj.shape === 'segment') {
      addField('Spinner °/sec', 'number', 'angularSpeedDeg', { min: -360, max: 360, step: 15 });
      addField('One-Way Gate (flip endpoints to reverse)', 'checkbox', 'oneWay', { span2: true });
    }
    if (obj.shape === 'portal') {
      addField('Exit Angle (°)', 'number', 'exitAngleDeg', { min: -180, max: 180, step: 5 });
      addField('Exit Boost', 'number', 'kickSpeed', { min: 0, max: 450, step: 10 });
      addField('Max Warps / Shot', 'number', 'maxHitsPerShot', { min: 1, max: 10, step: 1 });
    }
    if (obj.shape === 'zone') {
      addField('Wind Force X', 'number', 'forceX', { min: -1200, max: 1200, step: 25 });
      addField('Wind Force Y', 'number', 'forceY', { min: -1200, max: 1200, step: 25 });
      addField('Radial (-Pull/+Push)', 'number', 'radialForce', { min: -1200, max: 1200, step: 25 });
      addField('Drag', 'number', 'drag', { min: 0, max: 5, step: 0.1 });
    }
    if (obj.shape === 'circle' && state.solverMode === 'markov') {
      addField('Markov P(Right) (0–1)', 'number', 'markovRightProb', { min: 0.01, max: 0.99, step: 0.05, optional: true });
      addField('Markov Loop Prob (0–.85)', 'number', 'markovLoopProb', { min: 0, max: 0.85, step: 0.05, optional: true });
    }
    addField('Enabled', 'checkbox', 'enabled', { span2: true });
  }

  // ---------- Presets & Baseline ----------
  function loadPreset(presetId) {
    const preset = RP.Presets.PRESETS.find((p) => p.id === presetId) || RP.Presets.PRESETS[0];
    state.presetId = preset.id;
    state.settings = deepClone(preset.settings);
    state.objects = preset.buildObjects();
    state.selectedId = null;
    state.lockedBin = -1;
    state.lockedSlot = -1;
    state.hoverBin = -1;
    state.hoverSlot = -1;
    state.undoStack = [];
    $('btnUndo').disabled = true;

    // Automatically capture an informative Baseline:
    // If preset has both base pegs and complications, baseline = base pegs only (shows pure complication delta!)
    // Otherwise baseline = current board snapshot.
    const hasBase = state.objects.some((o) => o.layerGroup === 'base');
    const hasComps = state.objects.some((o) => o.layerGroup !== 'base');

    if (hasBase && hasComps) {
      const baseOnly = state.objects.filter((o) => o.layerGroup === 'base');
      const baseSweep = RP.Engine.runSweep(baseOnly, state.settings, -1);
      baseSweep.slotCount = state.settings.slotValues.length;
      state.baselineSweep = baseSweep;
      state.baselineMarkov = RP.Markov.solveBoard(baseOnly, state.settings);
      state.baselineLabel = 'Base Lattice';
    } else {
      const snapSweep = RP.Engine.runSweep(state.objects, state.settings, -1);
      snapSweep.slotCount = state.settings.slotValues.length;
      state.baselineSweep = snapSweep;
      state.baselineMarkov = RP.Markov.solveBoard(state.objects, state.settings);
      state.baselineLabel = preset.name.split(' (')[0];
    }

    syncControlsFromSettings();
    renderLayerList();
    renderInspector();
    recomputeNow();
  }

  function lockBaselineNow() {
    if (state.solverMode === 'markov') {
      if (!state.markovSol) return;
      state.baselineMarkov = RP.Markov.solveBoard(state.objects, state.settings);
    } else {
      if (!state.sweep) return;
      state.baselineSweep = {
        values: new Float64Array(state.sweep.values),
        slots: new Int32Array(state.sweep.slots),
        slotCount: state.settings.slotValues.length
      };
      state.baselineMarkov = RP.Markov.solveBoard(state.objects, state.settings);
    }
    state.baselineLabel = 'Locked Snapshot';
    const btn = $('btnLockBaseline');
    btn.textContent = '✓ Baseline Locked';
    setTimeout(() => { btn.textContent = 'Lock Baseline'; }, 1400);
    recomputeAnalysisOnly();
    renderAllViews();
    updateKPIs();
  }

  function setSolverMode(mode) {
    if (mode !== 'physics' && mode !== 'markov') return;
    state.solverMode = mode;
    state.lockedBin = -1;
    state.lockedSlot = -1;
    state.hoverBin = -1;
    state.hoverSlot = -1;
    state.inspectedU = null;
    state.inspectedTrace = null;
    syncControlsFromSettings();
    renderInspector();
    recomputeNow();
  }

  // ---------- Controls Sync ----------
  function syncControlsFromSettings() {
    const s = state.settings;
    const isMarkov = state.solverMode === 'markov';

    document.querySelectorAll('[data-solver]').forEach((b) => {
      b.classList.toggle('active', b.dataset.solver === state.solverMode);
    });
    document.querySelectorAll('[data-markovflow]').forEach((b) => {
      b.classList.toggle('active', b.dataset.markovflow === state.markovFlowView);
    });
    $('physicsBarControls').hidden = isMarkov;
    $('markovBarControls').hidden = !isMarkov;
    $('physicsPrecisionBox').hidden = isMarkov;
    $('chkExactParabola').checked = s.exactParabola !== false;
    $('chkAdaptiveOversample').checked = s.adaptiveOversample !== false;
    $('chkSpinFriction').checked = Boolean(s.enableSpinFriction);
    $('chkBallCollisions').checked = Boolean(s.enableBallCollisions);
    $('chkMovingBucket').checked = Boolean(s.movingBucket);
    $('slPhase').value = String(s.startPhaseDeg || 0);
    $('outPhase').textContent = `${s.startPhaseDeg || 0}°`;

    $('slBoardW').value = String(s.boardWidth || 540);
    $('outBoardW').textContent = `${s.boardWidth || 540} px`;
    $('slBoardH').value = String(s.boardHeight || 720);
    $('outBoardH').textContent = `${s.boardHeight || 720} px`;
    $('selChamberShape').value = s.chamberShape || 'rect';

    $('slShotsPerRound').value = String(s.shotsPerRound || 1);
    $('outShotsPerRound').textContent = `${s.shotsPerRound || 1}`;

    document.querySelectorAll('[data-launcher]').forEach((b) => {
      b.classList.toggle('active', b.dataset.launcher === s.launcherMode);
    });
    document.querySelectorAll('[data-raycolor]').forEach((b) => {
      b.classList.toggle('active', b.dataset.raycolor === s.rayColorMode);
    });

    $('slGravity').value = String(s.gravity);
    $('outGravity').textContent = s.gravity === 0 ? '0 (0-G Laser)' : String(s.gravity);

    $('slSpeed').value = String(s.launchSpeed);
    $('outSpeed').textContent = String(s.launchSpeed);

    $('slRestitution').value = String(s.restitutionScale);
    $('outRestitution').textContent = `${s.restitutionScale.toFixed(2)}×`;

    $('slBallRadius').value = String(s.ballRadius);
    $('outBallRadius').textContent = `${s.ballRadius} px`;

    $('slRayCount').value = String(s.rayCount);
    $('outRayCount').textContent = String(s.rayCount);

    $('slMaxBounces').value = String(s.maxBounces);
    $('outMaxBounces').textContent = String(s.maxBounces);

    $('selScoreMode').value = s.scoreMode;
    $('txtSlots').value = s.slotSpecText || RP.Presets.formatSlotSpecs(s.slotSpecs) || s.slotValues.join(', ');
    $('chkHeatmap').checked = Boolean(s.showHeatmap);

    $('chkAutoAim').checked = Boolean(s.trainedAutoAim);
    $('selAutoGoal').value = s.trainedAimGoal || 'ev';
    $('slTrainedSigma').value = String(s.trainedSigma);
    $('outTrainedSigma').textContent = `${(s.trainedSigma * 100).toFixed(1)}%`;
    $('slTrainedTarget').value = String(s.trainedTarget);
    $('outTrainedTarget').textContent = formatAimLabel(s.trainedTarget);

    $('slNaiveSigma').value = String(s.naiveSigma);
    $('outNaiveSigma').textContent = s.naiveSigma >= 0.99 ? 'Uniform' : `${Math.round(s.naiveSigma * 100)}%`;
    $('slNaiveTarget').value = String(s.naiveTarget);
    $('outNaiveTarget').textContent = formatAimLabel(s.naiveTarget);

    $('slQuota').value = String(s.quota);
    $('outQuota').textContent = RP.Math.formatNumber(s.quota);

    document.querySelectorAll('input[type="range"]').forEach(updateFallbackRangeProgress);
  }

  // Fallback range progress for WebKit without accent-color support
  const supportsAccentColor = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('accent-color', '#0284c7');
  function updateFallbackRangeProgress(input) {
    if (supportsAccentColor || !input) return;
    const min = parseFloat(input.min || '0');
    const max = parseFloat(input.max || '100');
    const val = parseFloat(input.value || '0');
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--progress', `${pct.toFixed(1)}%`);
  }

  // ---------- Dialog Helpers (light-dismiss fallback) ----------
  function setupDialogLightDismiss(dialog) {
    if (!dialog) return;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (isDialogContent) return;
        dialog.close();
      });
    }
  }

  function updateBuilderVisibility() {
    const shape = $('bShape').value;
    document.querySelectorAll('#builderForm [data-shapes]').forEach((el) => {
      const allowed = el.dataset.shapes.split(',');
      el.hidden = !allowed.includes(shape);
    });
  }

  // ---------- Event Wiring ----------
  function bindUI() {
    // Populate Presets
    const sel = $('presetSelect');
    for (const p of RP.Presets.PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => loadPreset(sel.value));

    $('btnLockBaseline').addEventListener('click', lockBaselineNow);
    $('btnUndo').addEventListener('click', popUndo);

    // Drop single test ball along inspected or Trained optimal ray
    const fireSingleBall = () => {
      const u = state.inspectedU !== null ? state.inspectedU : state.effectiveTrainedTarget;
      const tr = RP.Engine.traceSingleDetailed(u, state.objects, state.settings);
      boardView.spawnTestBall(tr, '#ffffff');
      ensureAnimLoop();
    };
    $('btnDropBall').addEventListener('click', fireSingleBall);

    // Burst 5 deterministic samples spanning Naive & Trained quantiles
    $('btnBurstBalls').addEventListener('click', () => {
      const s = state.settings;
      const zOffsets = [-1.4, -0.65, 0, 0.65, 1.4];
      for (const z of zOffsets) {
        const uT = RP.Math.clamp(state.effectiveTrainedTarget + z * s.trainedSigma, 0.01, 0.99);
        const tr = RP.Engine.traceSingleDetailed(uT, state.objects, s);
        boardView.spawnTestBall(tr, '#22d3ee');
      }
      ensureAnimLoop();
    });

    // Grid snap
    $('chkSnap').addEventListener('change', (e) => {
      state.snapToGrid = e.target.checked;
    });

    // Launcher mode buttons
    document.querySelectorAll('[data-launcher]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pushUndo();
        state.settings.launcherMode = btn.dataset.launcher;
        syncControlsFromSettings();
        scheduleRecompute();
      });
    });

    // Solver engine switcher
    document.querySelectorAll('[data-solver]').forEach((btn) => {
      btn.addEventListener('click', () => setSolverMode(btn.dataset.solver));
    });

    // Markov Sankey flow population selector
    document.querySelectorAll('[data-markovflow]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.markovFlowView = btn.dataset.markovflow;
        document.querySelectorAll('[data-markovflow]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        recomputeAnalysisOnly();
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      });
    });

    // High-precision & Rigid-Body Physics options
    $('chkExactParabola').addEventListener('change', (e) => {
      state.settings.exactParabola = e.target.checked;
      scheduleRecompute();
    });

    $('chkAdaptiveOversample').addEventListener('change', (e) => {
      state.settings.adaptiveOversample = e.target.checked;
      scheduleRecompute();
    });

    $('chkSpinFriction').addEventListener('change', (e) => {
      pushUndo();
      state.settings.enableSpinFriction = e.target.checked;
      scheduleRecompute();
    });

    $('chkBallCollisions').addEventListener('change', (e) => {
      pushUndo();
      state.settings.enableBallCollisions = e.target.checked;
      scheduleRecompute();
    });

    $('chkMovingBucket').addEventListener('change', (e) => {
      pushUndo();
      state.settings.movingBucket = e.target.checked;
      scheduleRecompute();
    });

    // Board Size, Chamber Shape & Parametric Lattice Generator
    $('slBoardW').addEventListener('input', (e) => {
      const nextW = parseInt(e.target.value, 10);
      const oldW = state.settings.boardWidth || 540;
      const oldH = state.settings.boardHeight || 720;
      state.settings.boardWidth = nextW;
      $('outBoardW').textContent = `${nextW} px`;
      updateFallbackRangeProgress(e.target);
      rescaleObjectsForBoard(oldW, oldH, nextW, oldH);
      syncBoardFrameSize();
      scheduleRecompute();
    });

    $('slBoardH').addEventListener('input', (e) => {
      const nextH = parseInt(e.target.value, 10);
      const oldW = state.settings.boardWidth || 540;
      const oldH = state.settings.boardHeight || 720;
      state.settings.boardHeight = nextH;
      $('outBoardH').textContent = `${nextH} px`;
      updateFallbackRangeProgress(e.target);
      rescaleObjectsForBoard(oldW, oldH, oldW, nextH);
      syncBoardFrameSize();
      scheduleRecompute();
    });

    $('selChamberShape').addEventListener('change', (e) => {
      pushUndo();
      state.settings.chamberShape = e.target.value;
      scheduleRecompute();
    });

    $('btnGenLattice').addEventListener('click', () => {
      pushUndo();
      const pattern = $('selLatPattern').value;
      const templateId = $('selLatPegType').value;
      const rows = RP.Math.clamp(parseInt($('numLatRows').value, 10) || 8, 3, 14);
      const cols = RP.Math.clamp(parseInt($('numLatCols').value, 10) || 9, 4, 14);
      const keepComps = state.objects.filter((o) => o.layerGroup !== 'base');
      const newBase = RP.Presets.generateLattice({
        boardWidth: state.settings.boardWidth || 540,
        boardHeight: state.settings.boardHeight || 720,
        pattern,
        rows,
        cols,
        templateId,
        scoreAdd: templateId === 'popPeg' ? 14 : 5
      });
      state.objects = [...newBase, ...keepComps];
      state.selectedId = null;
      renderLayerList();
      renderInspector();
      scheduleRecompute();
    });

    // Ray color mode buttons
    document.querySelectorAll('[data-raycolor]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.rayColorMode = btn.dataset.raycolor;
        document.querySelectorAll('[data-raycolor]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        if (boardView) boardView.render(state);
      });
    });

    $('chkHeatmap').addEventListener('change', (e) => {
      state.settings.showHeatmap = e.target.checked;
      if (boardView) boardView.render(state);
    });

    // Physics sliders
    const bindSlider = (id, outId, key, fmt, parse = parseFloat) => {
      const el = $(id);
      el.addEventListener('input', () => {
        const v = parse(el.value);
        state.settings[key] = v;
        $(outId).textContent = fmt(v);
        updateFallbackRangeProgress(el);
        scheduleRecompute();
      });
    };

    bindSlider('slShotsPerRound', 'outShotsPerRound', 'shotsPerRound', (v) => String(v), parseInt);
    bindSlider('slPhase', 'outPhase', 'startPhaseDeg', (v) => `${v}°`, parseInt);
    bindSlider('slGravity', 'outGravity', 'gravity', (v) => (v === 0 ? '0 (0-G Laser)' : String(v)));
    bindSlider('slSpeed', 'outSpeed', 'launchSpeed', (v) => String(v));
    bindSlider('slRestitution', 'outRestitution', 'restitutionScale', (v) => `${v.toFixed(2)}×`);
    bindSlider('slBallRadius', 'outBallRadius', 'ballRadius', (v) => `${v} px`);
    bindSlider('slRayCount', 'outRayCount', 'rayCount', (v) => String(v), parseInt);
    bindSlider('slMaxBounces', 'outMaxBounces', 'maxBounces', (v) => String(v), parseInt);

    $('selScoreMode').addEventListener('change', (e) => {
      pushUndo();
      state.settings.scoreMode = e.target.value;
      scheduleRecompute();
    });

    $('txtSlots').addEventListener('change', (e) => {
      const specs = RP.Presets.parseSlotSpecs(e.target.value);
      if (specs.length >= 2 && specs.length <= 25) {
        pushUndo();
        state.settings.slotSpecs = specs;
        state.settings.slotSpecText = RP.Presets.formatSlotSpecs(specs);
        state.settings.slotValues = specs.map((s) => s.value);
        e.target.value = state.settings.slotSpecText;
        scheduleRecompute();
      } else {
        e.target.value = state.settings.slotSpecText || state.settings.slotValues.join(', ');
      }
    });

    // Layer master toggles
    $('chkToggleBase').addEventListener('change', (e) => {
      pushUndo();
      for (const o of state.objects) {
        if (o.layerGroup === 'base') o.enabled = e.target.checked;
      }
      scheduleRecompute();
    });

    $('chkToggleComps').addEventListener('change', (e) => {
      pushUndo();
      for (const o of state.objects) {
        if (o.layerGroup !== 'base') o.enabled = e.target.checked;
      }
      renderLayerList();
      scheduleRecompute();
    });

    $('btnClearComps').addEventListener('click', () => {
      pushUndo();
      state.objects = state.objects.filter((o) => o.layerGroup === 'base');
      state.selectedId = null;
      renderLayerList();
      renderInspector();
      scheduleRecompute();
    });

    $('btnClearAll').addEventListener('click', () => {
      pushUndo();
      state.objects = [];
      state.selectedId = null;
      renderLayerList();
      renderInspector();
      scheduleRecompute();
    });

    $('btnDupObj').addEventListener('click', duplicateSelected);
    $('btnDelObj').addEventListener('click', () => deleteObject(state.selectedId));

    // Chart controls
    document.querySelectorAll('[data-chartmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartMode = btn.dataset.chartmode;
        state.lockedBin = -1;
        state.hoverBin = -1;
        document.querySelectorAll('[data-chartmode]').forEach((b) => b.classList.toggle('active', b === btn));
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      });
    });

    document.querySelectorAll('[data-compare]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.compareMode = btn.dataset.compare;
        document.querySelectorAll('[data-compare]').forEach((b) => b.classList.toggle('active', b === btn));
        renderAllViews();
        updateKPIs();
      });
    });

    $('chkLogScale').addEventListener('change', (e) => {
      state.logScale = e.target.checked;
      recomputeAnalysisOnly();
      updateHighlightSet();
      renderAllViews();
      updateKPIs();
    });

    // Skill user controls
    $('chkAutoAim').addEventListener('change', (e) => {
      state.settings.trainedAutoAim = e.target.checked;
      scheduleRecompute();
    });

    $('selAutoGoal').addEventListener('change', (e) => {
      state.settings.trainedAimGoal = e.target.value;
      scheduleRecompute();
    });

    $('slTrainedSigma').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.settings.trainedSigma = v;
      $('outTrainedSigma').textContent = `${(v * 100).toFixed(1)}%`;
      updateFallbackRangeProgress(e.target);
      scheduleRecompute();
    });

    $('slTrainedTarget').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.settings.trainedAutoAim = false;
      $('chkAutoAim').checked = false;
      state.settings.trainedTarget = v;
      state.effectiveTrainedTarget = v;
      $('outTrainedTarget').textContent = formatAimLabel(v);
      updateFallbackRangeProgress(e.target);
      if (state.solverMode === 'physics' && state.settings.adaptiveOversample !== false) {
        scheduleRecompute();
      } else {
        recomputeAnalysisOnly();
        updateHighlightSet();
        renderAllViews();
        updateKPIs();
      }
    });

    $('slNaiveSigma').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.settings.naiveSigma = v;
      $('outNaiveSigma').textContent = v >= 0.99 ? 'Uniform' : `${Math.round(v * 100)}%`;
      updateFallbackRangeProgress(e.target);
      recomputeAnalysisOnly();
      updateHighlightSet();
      renderAllViews();
      updateKPIs();
    });

    $('slNaiveTarget').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.settings.naiveTarget = v;
      $('outNaiveTarget').textContent = formatAimLabel(v);
      updateFallbackRangeProgress(e.target);
      recomputeAnalysisOnly();
      updateHighlightSet();
      renderAllViews();
      updateKPIs();
    });

    $('slQuota').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.settings.quota = v;
      $('outQuota').textContent = RP.Math.formatNumber(v);
      updateFallbackRangeProgress(e.target);
      if (state.settings.trainedAutoAim && state.settings.trainedAimGoal === 'quota') {
        scheduleRecompute();
      } else {
        recomputeAnalysisOnly();
        renderAllViews();
        updateKPIs();
      }
    });

    // Native Dialogs: Custom Complication Builder & Import/Export
    const builderDialog = $('builderDialog');
    const ioDialog = $('ioDialog');
    setupDialogLightDismiss(builderDialog);
    setupDialogLightDismiss(ioDialog);

    document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dlg = $(btn.dataset.closeDialog);
        if (dlg) dlg.close();
      });
    });

    $('btnOpenBuilder').addEventListener('click', () => {
      updateBuilderVisibility();
      builderDialog.showModal();
    });

    $('bShape').addEventListener('change', updateBuilderVisibility);

    $('builderForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const shape = $('bShape').value;
      const tpl = {
        templateId: RP.Presets.nextId('custom'),
        name: $('bName').value.trim() || 'Custom',
        tag: $('bTag').value.trim() || '★',
        category: 'complication',
        layerGroup: 'complication',
        kind: shape === 'portal' ? 'portal' : shape === 'zone' ? 'zone' : 'custom',
        shape,
        color: $('bColor').value || '#ec4899',
        radius: parseFloat($('bRadius').value) || 14,
        length: parseFloat($('bLength').value) || 100,
        angleDeg: 25,
        restitution: parseFloat($('bRestitution').value) || 0.9,
        kickSpeed: parseFloat($('bKick').value) || 0,
        biasAngle: parseFloat($('bBias').value) || 0,
        tangentialBoost: parseFloat($('bTangent').value) || 0,
        scoreAdd: parseFloat($('bScoreAdd').value) || 0,
        scoreMult: parseFloat($('bScoreMult').value) || 1,
        splitCount: Math.max(1, Math.min(3, parseInt($('bSplit').value, 10) || 1)),
        splitSpreadDeg: parseFloat($('bSplitSpread').value) || 26,
        maxHitsPerShot: Math.max(0, parseInt($('bMaxHits').value, 10) || 0),
        triggerEveryN: Math.max(1, parseInt($('bTriggerN').value, 10) || 1),
        auraRadius: Math.max(0, parseFloat($('bAuraRadius').value) || 0),
        auraBuffAdd: parseFloat($('bAuraBuff').value) || 0,
        isRefresh: $('bIsRefresh').checked,
        isBomb: $('bIsBomb').checked,
        bombRadius: 85,
        angularSpeedDeg: parseFloat($('bAngSpeed').value) || 0,
        oscAmpX: parseFloat($('bOscX').value) || 0,
        oscAmpY: 0,
        oscFreq: 0.75,
        oneWay: $('bOneWay').checked,
        exitOffsetX: 160,
        exitOffsetY: -180,
        exitAngleDeg: parseFloat($('bExitAngle').value) || 70,
        forceX: parseFloat($('bForceX').value) || 0,
        forceY: parseFloat($('bForceY').value) || 0,
        radialForce: parseFloat($('bRadial').value) || 0,
        drag: 0
      };

      state.customTemplates.push(tpl);
      saveCustomTemplates(state.customTemplates);
      renderPalette();
      setActiveTool(tpl.templateId);
      builderDialog.close();
    });

    // Import / Export Dialog
    const buildExportPayload = () => JSON.stringify({
      version: 1,
      app: 'PrismDrop',
      settings: state.settings,
      objects: state.objects,
      customTemplates: state.customTemplates
    }, null, 2);

    const setIoFeedback = (msg, isError = false) => {
      const fb = $('ioFeedback');
      fb.textContent = msg;
      fb.classList.toggle('error', isError);
    };

    $('btnOpenIO').addEventListener('click', () => {
      $('txtIoJson').value = buildExportPayload();
      setIoFeedback('');
      ioDialog.showModal();
    });

    $('btnCopyJson').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('txtIoJson').value);
        setIoFeedback('Copied JSON to clipboard.');
      } catch (_) {
        $('txtIoJson').select();
        setIoFeedback('Selected text — press Ctrl+C to copy.');
      }
    });

    $('btnDownloadJson').addEventListener('click', () => {
      const blob = new Blob([$('txtIoJson').value], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prismdrop-${state.presetId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setIoFeedback('Downloaded JSON file.');
    });

    $('fileImportJson').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('txtIoJson').value = String(reader.result || '');
        setIoFeedback(`Loaded ${file.name}. Choose "Load Full Board" or "Merge Complications Only".`);
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    const parseIoJson = () => {
      try {
        const data = JSON.parse($('txtIoJson').value);
        if (!data || typeof data !== 'object') throw new Error('JSON must be an object or array.');
        return data;
      } catch (err) {
        setIoFeedback(`Invalid JSON: ${err.message}`, true);
        return null;
      }
    };

    $('btnReplaceBoard').addEventListener('click', () => {
      const data = parseIoJson();
      if (!data) return;
      pushUndo();
      if (Array.isArray(data.objects)) {
        state.objects = data.objects.map((o) => ({ ...o, id: o.id || RP.Presets.nextId('imp') }));
      }
      if (data.settings && typeof data.settings === 'object') {
        state.settings = RP.Presets.makeSettings(data.settings);
      }
      if (Array.isArray(data.customTemplates)) {
        state.customTemplates = data.customTemplates;
        saveCustomTemplates(state.customTemplates);
        renderPalette();
      }
      state.selectedId = null;
      syncControlsFromSettings();
      renderLayerList();
      renderInspector();
      recomputeNow();
      setIoFeedback('Loaded full board.');
      ioDialog.close();
    });

    $('btnMergeComps').addEventListener('click', () => {
      const data = parseIoJson();
      if (!data) return;
      pushUndo();
      let added = 0;
      const incomingObjs = Array.isArray(data) ? data : (Array.isArray(data.objects) ? data.objects : []);
      for (const o of incomingObjs) {
        if (o.layerGroup === 'base') continue;
        state.objects.push({ ...o, id: RP.Presets.nextId('mrg'), layerGroup: 'complication' });
        added++;
      }
      if (Array.isArray(data.customTemplates)) {
        for (const tpl of data.customTemplates) {
          if (!state.customTemplates.some((t) => t.name === tpl.name)) {
            state.customTemplates.push({ ...tpl, templateId: RP.Presets.nextId('custom') });
          }
        }
        saveCustomTemplates(state.customTemplates);
        renderPalette();
      }
      renderLayerList();
      recomputeNow();
      setIoFeedback(`Merged ${added} complication(s) onto the current board.`);
      ioDialog.close();
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ($('builderDialog').open || $('ioDialog').open) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        popUndo();
      } else if (e.key === 'Escape') {
        setActiveTool('select');
        state.lockedBin = -1;
        state.lockedSlot = -1;
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
        e.preventDefault();
        deleteObject(state.selectedId);
      } else if (e.key.toLowerCase() === 'd' && state.selectedId) {
        e.preventDefault();
        duplicateSelected();
      } else if (e.key === ' ') {
        e.preventDefault();
        fireSingleBall();
      }
    });

    // Re-render charts on OS theme change (dark-mode guidance)
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onThemeChange = () => renderAllViews();
      if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
    }

    // ResizeObserver for crisp high-DPI canvas sizing
    const ro = new ResizeObserver(() => renderAllViews());
    ro.observe($('boardCanvas'));
    ro.observe($('distCanvas'));
    ro.observe($('sensCanvas'));
  }

  // ---------- Initialize Canvas Views ----------
  function initViews() {
    let transformUndoPushed = false;

    boardView = new RP.BoardView($('boardCanvas'), {
      getState: () => state,
      getActiveTemplate,
      onSelectObject: (id) => selectObject(id),
      onBeginTransform: () => {
        transformUndoPushed = false;
      },
      onMoveObject: (id, patch) => {
        const obj = state.objects.find((o) => o.id === id);
        if (!obj) return;
        if (!transformUndoPushed) {
          pushUndo();
          transformUndoPushed = true;
        }
        Object.assign(obj, patch);
        scheduleRecompute();
      },
      onPlaceObject: (tpl, x, y, overrides) => {
        pushUndo();
        const obj = RP.Presets.instantiateFromTemplate(tpl, x, y, overrides);
        state.objects.push(obj);
        selectObject(obj.id);
        scheduleRecompute();
      },
      onAimDrag: (who, u) => handleAimDrag(who, u),
      onHoverSlot: (slot) => {
        if (state.hoverSlot !== slot) {
          state.hoverSlot = slot;
          updateHighlightSet();
          renderAllViews();
          updateStageStatus();
        }
      },
      onSlotClick: (slot) => {
        state.lockedBin = -1;
        state.lockedSlot = state.lockedSlot === slot ? -1 : slot;
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      },
      onInspectU: (u, spawnBall) => {
        state.inspectedU = u;
        state.inspectedTrace = (u !== null && state.solverMode === 'physics')
          ? RP.Engine.traceSingleDetailed(u, state.objects, state.settings)
          : null;
        if (spawnBall && u !== null) {
          const tr = state.inspectedTrace || RP.Engine.traceSingleDetailed(u, state.objects, state.settings);
          boardView.spawnTestBall(tr, '#ffffff');
          ensureAnimLoop();
        }
        renderAllViews();
        updateStageStatus();
      },
      onHoverObj: (objId) => {
        state.hoverObjId = objId;
        if (state.solverMode === 'markov') updateStageStatus();
      },
      onRequestRender: () => {
        if (boardView) boardView.render(state);
      }
    });

    distChart = new RP.Charts.DistributionChart($('distCanvas'), {
      onHoverBin: (bin) => {
        state.hoverBin = bin;
        state.hoverSlot = -1;
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      },
      onBinClick: (bin) => {
        state.lockedSlot = -1;
        state.lockedBin = state.lockedBin === bin ? -1 : bin;
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      },
      onHoverSlot: (slot) => {
        state.hoverSlot = slot;
        state.hoverBin = -1;
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      },
      onSlotClick: (slot) => {
        state.lockedBin = -1;
        state.lockedSlot = state.lockedSlot === slot ? -1 : slot;
        updateHighlightSet();
        renderAllViews();
        updateStageStatus();
      },
      onQuotaChange: (val) => {
        state.settings.quota = Math.max(0, val);
        $('slQuota').value = String(state.settings.quota);
        $('outQuota').textContent = RP.Math.formatNumber(state.settings.quota);
        updateFallbackRangeProgress($('slQuota'));
        if (state.settings.trainedAutoAim && state.settings.trainedAimGoal === 'quota') {
          scheduleRecompute();
        } else {
          recomputeAnalysisOnly();
          renderAllViews();
          updateKPIs();
        }
      }
    });

    sensChart = new RP.Charts.SensitivityChart($('sensCanvas'), {
      onInspectU: (u) => {
        state.inspectedU = u;
        state.inspectedTrace = (u !== null && state.solverMode === 'physics')
          ? RP.Engine.traceSingleDetailed(u, state.objects, state.settings)
          : null;
        renderAllViews();
        updateStageStatus();
      },
      onAimDrag: (who, u) => handleAimDrag(who, u)
    });
  }

  function handleAimDrag(who, u) {
    if (who === 'trained') {
      state.settings.trainedAutoAim = false;
      $('chkAutoAim').checked = false;
      state.settings.trainedTarget = u;
      state.effectiveTrainedTarget = u;
      $('slTrainedTarget').value = u.toFixed(3);
      $('outTrainedTarget').textContent = formatAimLabel(u);
      updateFallbackRangeProgress($('slTrainedTarget'));
      if (state.solverMode === 'physics' && state.settings.adaptiveOversample !== false) {
        scheduleRecompute();
        return;
      }
    } else {
      state.settings.naiveTarget = u;
      $('slNaiveTarget').value = u.toFixed(3);
      $('outNaiveTarget').textContent = formatAimLabel(u);
      updateFallbackRangeProgress($('slNaiveTarget'));
    }
    recomputeAnalysisOnly();
    updateHighlightSet();
    renderAllViews();
    updateKPIs();
  }

  // ---------- Boot ----------
  window.addEventListener('DOMContentLoaded', () => {
    renderPalette();
    bindUI();
    initViews();
    const params = new URLSearchParams(window.location.search);
    const startMode = params.get('mode');
    if (startMode === 'markov' || startMode === 'physics') {
      state.solverMode = startMode;
    }
    const startPreset = params.get('preset');
    const valid = RP.Presets.PRESETS.some((p) => p.id === startPreset) ? startPreset : 'galton';
    $('presetSelect').value = valid;
    loadPreset(valid);
  });
})();
