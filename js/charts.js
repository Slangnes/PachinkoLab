(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});

  function getThemeColors(canvas) {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const parentBg = canvas && canvas.parentElement
      ? getComputedStyle(canvas.parentElement).backgroundColor
      : '';
    const bodyText = getComputedStyle(document.body).color;
    return {
      bg: (parentBg && parentBg !== 'rgba(0, 0, 0, 0)' && !parentBg.includes('light-dark'))
        ? parentBg
        : (dark ? '#0b1120' : '#ffffff'),
      grid: dark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(15, 23, 42, 0.10)',
      axis: dark ? '#94a3b8' : '#475569',
      text: (bodyText && !bodyText.includes('light-dark'))
        ? bodyText
        : (dark ? '#f1f5f9' : '#0f172a'),
      muted: dark ? '#94a3b8' : '#64748b',
      baseline: dark ? '#94a3b8' : '#64748b',
      trained: '#06b6d4',
      trainedFill: dark ? 'rgba(34, 211, 238, 0.24)' : 'rgba(6, 182, 212, 0.20)',
      naive: '#f59e0b',
      naiveFill: dark ? 'rgba(245, 158, 11, 0.20)' : 'rgba(245, 158, 11, 0.18)',
      uniform: '#8b5cf6',
      uniformFill: dark ? 'rgba(139, 92, 246, 0.22)' : 'rgba(139, 92, 246, 0.16)',
      quota: '#f43f5e'
    };
  }

  class DistributionChart {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cb = callbacks;
      this.dpr = 1;
      this.w = 300;
      this.h = 200;
      this.pad = { top: 24, right: 16, bottom: 32, left: 42 };
      this.hoverBin = -1;
      this.draggingQuota = false;
      this.lastState = null;

      this._bindEvents();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = rect.width;
      this.h = rect.height;
      const tw = Math.round(rect.width * this.dpr);
      const th = Math.round(rect.height * this.dpr);
      if (this.canvas.width !== tw || this.canvas.height !== th) {
        this.canvas.width = tw;
        this.canvas.height = th;
      }
    }

    _valueToX(val, spec) {
      const plotW = this.w - this.pad.left - this.pad.right;
      if (spec.logScale) {
        const loL = Math.log10(Math.max(1e-6, spec.minV + spec.offset));
        const hiL = Math.log10(Math.max(1e-5, spec.maxV + spec.offset));
        const vL = Math.log10(Math.max(1e-6, val + spec.offset));
        const t = RP.Math.clamp((vL - loL) / Math.max(1e-6, hiL - loL), 0, 1);
        return this.pad.left + t * plotW;
      }
      const t = RP.Math.clamp((val - spec.minV) / Math.max(1e-6, spec.maxV - spec.minV), 0, 1);
      return this.pad.left + t * plotW;
    }

    _xToValue(px, spec) {
      const plotW = this.w - this.pad.left - this.pad.right;
      const t = RP.Math.clamp((px - this.pad.left) / Math.max(1, plotW), 0, 1);
      if (spec.logScale) {
        const loL = Math.log10(Math.max(1e-6, spec.minV + spec.offset));
        const hiL = Math.log10(Math.max(1e-5, spec.maxV + spec.offset));
        return Math.pow(10, loL + (hiL - loL) * t) - spec.offset;
      }
      return spec.minV + (spec.maxV - spec.minV) * t;
    }

    _bindEvents() {
      this.canvas.addEventListener('pointerdown', (e) => {
        if (!this.lastState || !this.lastState.analysis) return;
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const st = this.lastState;
        const spec = st.analysis.binSpec;

        if (st.chartMode !== 'slots') {
          const qx = this._valueToX(st.settings.quota, spec);
          if (Math.abs(px - qx) <= 10 && py >= this.pad.top - 10 && py <= this.h - this.pad.bottom) {
            this.draggingQuota = true;
            this.canvas.setPointerCapture(e.pointerId);
            return;
          }
        }

        // Click bin/slot to lock reverse attribution
        if (this.hoverBin >= 0) {
          if (st.chartMode === 'slots') {
            this.cb.onSlotClick(this.hoverBin);
          } else {
            this.cb.onBinClick(this.hoverBin);
          }
        }
      });

      this.canvas.addEventListener('pointermove', (e) => {
        if (!this.lastState || !this.lastState.analysis) return;
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const st = this.lastState;
        const spec = st.analysis.binSpec;

        if (this.draggingQuota) {
          const val = Math.round(this._xToValue(px, spec));
          this.cb.onQuotaChange(val);
          return;
        }

        const plotW = this.w - this.pad.left - this.pad.right;
        if (st.chartMode !== 'slots') {
          const qx = this._valueToX(st.settings.quota, spec);
          if (Math.abs(px - qx) <= 9 && py >= this.pad.top - 10 && py <= this.h - this.pad.bottom) {
            this.canvas.style.cursor = 'ew-resize';
            return;
          }
        }

        if (px >= this.pad.left && px <= this.w - this.pad.right && py >= this.pad.top && py <= this.h - this.pad.bottom) {
          const count = st.chartMode === 'slots' ? st.settings.slotValues.length : spec.binCount;
          const idx = RP.Math.clamp(Math.floor(((px - this.pad.left) / plotW) * count), 0, count - 1);
          this.canvas.style.cursor = 'pointer';
          if (idx !== this.hoverBin) {
            this.hoverBin = idx;
            if (st.chartMode === 'slots') this.cb.onHoverSlot(idx);
            else this.cb.onHoverBin(idx);
          }
        } else {
          this.canvas.style.cursor = 'default';
          if (this.hoverBin !== -1) {
            this.hoverBin = -1;
            this.cb.onHoverBin(-1);
            this.cb.onHoverSlot(-1);
          }
        }
      });

      this.canvas.addEventListener('pointerup', (e) => {
        if (this.draggingQuota) {
          this.draggingQuota = false;
          try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      });

      this.canvas.addEventListener('pointerleave', () => {
        if (!this.draggingQuota && this.hoverBin !== -1) {
          this.hoverBin = -1;
          this.cb.onHoverBin(-1);
          this.cb.onHoverSlot(-1);
        }
      });
    }

    render(state) {
      this.lastState = state;
      this.resize();
      const ctx = this.ctx;
      const theme = getThemeColors(this.canvas);
      const analysis = state.analysis;
      if (!analysis) return;

      const spec = analysis.binSpec;
      const mode = state.chartMode; // 'pmf' | 'ccdf' | 'slots'
      const compare = state.compareMode; // 'skill' | 'baseline'
      const base = state.baselineAnalysis;

      ctx.save();
      ctx.scale(this.dpr, this.dpr);

      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, this.w, this.h);

      const p = this.pad;
      const plotW = this.w - p.left - p.right;
      const plotH = this.h - p.top - p.bottom;

      // Determine active series
      let series = [];
      if (mode === 'slots') {
        if (compare === 'skill') {
          series.push({ name: 'Naive', data: analysis.naive.slotPmf, color: theme.naive, fill: theme.naiveFill, dashed: false });
          series.push({ name: 'Trained', data: analysis.trained.slotPmf, color: theme.trained, fill: theme.trainedFill, dashed: false });
          if (base && base.uniform.slotPmf.length === analysis.uniform.slotPmf.length) {
            series.push({ name: 'Baseline', data: base.uniform.slotPmf, color: theme.baseline, fill: null, dashed: true });
          }
        } else {
          if (base && base.uniform.slotPmf.length === analysis.uniform.slotPmf.length) {
            series.push({ name: 'Baseline', data: base.uniform.slotPmf, color: theme.baseline, fill: null, dashed: true });
          }
          series.push({ name: 'Current', data: analysis.uniform.slotPmf, color: theme.trained, fill: theme.trainedFill, dashed: false });
        }
      } else {
        const key = mode === 'ccdf' ? 'ccdf' : 'pmf';
        if (compare === 'skill') {
          series.push({ name: 'Naive', data: analysis.naive[key], color: theme.naive, fill: theme.naiveFill, dashed: false });
          series.push({ name: 'Trained', data: analysis.trained[key], color: theme.trained, fill: theme.trainedFill, dashed: false });
          if (base) {
            series.push({ name: 'Baseline', data: base.uniform[key], color: theme.baseline, fill: null, dashed: true });
          }
        } else {
          if (base) {
            series.push({ name: 'Baseline', data: base.uniform[key], color: theme.baseline, fill: null, dashed: true });
          }
          series.push({ name: 'Current (All)', data: analysis.uniform[key], color: theme.trained, fill: theme.trainedFill, dashed: false });
        }
      }

      // Compute Y-axis max
      let maxY = mode === 'ccdf' ? 1.0 : 0.05;
      if (mode !== 'ccdf') {
        for (const s of series) {
          for (let i = 0; i < s.data.length; i++) {
            if (s.data[i] > maxY) maxY = s.data[i];
          }
        }
        maxY = Math.min(1.0, maxY * 1.15);
      }

      // Draw horizontal gridlines + Y labels
      ctx.strokeStyle = theme.grid;
      ctx.fillStyle = theme.axis;
      ctx.font = '500 10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const yTicks = 4;
      for (let t = 0; t <= yTicks; t++) {
        const frac = t / yTicks;
        const y = p.top + plotH * (1 - frac);
        ctx.beginPath();
        ctx.moveTo(p.left, y);
        ctx.lineTo(this.w - p.right, y);
        ctx.stroke();

        const pct = Math.round(frac * maxY * 100);
        ctx.fillText(`${pct}%`, p.left - 6, y);
      }

      // Highlight hovered or locked bin column
      const count = mode === 'slots' ? state.settings.slotValues.length : spec.binCount;
      const binW = plotW / count;
      const activeIdx = this.hoverBin >= 0
        ? this.hoverBin
        : (mode === 'slots' ? state.lockedSlot : state.lockedBin);

      if (activeIdx >= 0 && activeIdx < count) {
        ctx.fillStyle = 'rgba(250, 204, 21, 0.14)';
        ctx.fillRect(p.left + activeIdx * binW, p.top, binW, plotH);
      }

      // Draw series
      if (mode === 'slots') {
        // Grouped bars for bottom slots
        const barSeries = series.filter((s) => !s.dashed);
        const subW = (binW - 4) / Math.max(1, barSeries.length);
        for (let si = 0; si < barSeries.length; si++) {
          const s = barSeries[si];
          ctx.fillStyle = s.color;
          for (let i = 0; i < count; i++) {
            const val = s.data[i] || 0;
            const bh = (val / maxY) * plotH;
            const bx = p.left + i * binW + 2 + si * subW;
            const by = p.top + plotH - bh;
            ctx.globalAlpha = activeIdx === i ? 1.0 : 0.78;
            ctx.fillRect(bx, by, Math.max(2, subW - 1), bh);
          }
        }
        ctx.globalAlpha = 1;

        // Baseline dashed polyline over slots
        for (const s of series) {
          if (!s.dashed) continue;
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (let i = 0; i < count; i++) {
            const cx = p.left + (i + 0.5) * binW;
            const cy = p.top + plotH - ((s.data[i] || 0) / maxY) * plotH;
            if (i === 0) ctx.moveTo(cx, cy);
            else ctx.lineTo(cx, cy);
          }
          ctx.stroke();
          ctx.restore();
        }
      } else {
        // PMF or CCDF smooth area + step curves
        for (const s of series) {
          ctx.save();
          if (s.dashed) ctx.setLineDash([5, 4]);

          const pts = [];
          for (let i = 0; i < count; i++) {
            const cx = p.left + (i + 0.5) * binW;
            const cy = p.top + plotH - ((s.data[i] || 0) / maxY) * plotH;
            pts.push({ x: cx, y: cy });
          }

          if (s.fill && pts.length > 0) {
            ctx.beginPath();
            ctx.moveTo(p.left, p.top + plotH);
            ctx.lineTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              const mx = (pts[i - 1].x + pts[i].x) * 0.5;
              const my = (pts[i - 1].y + pts[i].y) * 0.5;
              ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, mx, my);
            }
            ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
            ctx.lineTo(this.w - p.right, p.top + plotH);
            ctx.closePath();
            ctx.fillStyle = s.fill;
            ctx.fill();
          }

          if (pts.length > 0) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              const mx = (pts[i - 1].x + pts[i].x) * 0.5;
              const my = (pts[i - 1].y + pts[i].y) * 0.5;
              ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, mx, my);
            }
            ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = s.dashed ? 1.6 : 2.2;
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      // Draw draggable Quota vertical line in PMF / CCDF mode
      if (mode !== 'slots') {
        const qx = this._valueToX(state.settings.quota, spec);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = theme.quota;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(qx, p.top - 4);
        ctx.lineTo(qx, p.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Quota badge pill at top
        const qText = `Quota ${RP.Math.formatNumber(state.settings.quota)}`;
        ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
        const tw = ctx.measureText(qText).width + 10;
        const pillX = RP.Math.clamp(qx - tw / 2, p.left, this.w - p.right - tw);
        ctx.fillStyle = theme.quota;
        ctx.beginPath();
        ctx.roundRect(pillX, 3, tw, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(qText, pillX + tw / 2, 11.5);
        ctx.restore();
      }

      // X-axis tick labels
      ctx.fillStyle = theme.axis;
      ctx.font = '500 10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const yAxisBottom = p.top + plotH + 7;

      if (mode === 'slots') {
        const specs = state.settings.slotSpecs || [];
        for (let i = 0; i < count; i++) {
          const cx = p.left + (i + 0.5) * binW;
          const sp = specs[i];
          const lbl = state.settings.scoreMode === 'slotIndex'
            ? `#${i + 1}`
            : (sp ? sp.raw : `${state.settings.slotValues[i]}`);
          ctx.fillText(lbl, cx, yAxisBottom);
        }
      } else {
        const xTicks = 5;
        for (let t = 0; t <= xTicks; t++) {
          const bIdx = Math.round((t / xTicks) * spec.binCount);
          const val = spec.edges[bIdx];
          const x = p.left + (t / xTicks) * plotW;
          ctx.fillText(RP.Math.formatNumber(val), x, yAxisBottom);
        }
      }

      // Hover readout overlay inside top-right corner
      if (this.hoverBin >= 0 && this.hoverBin < count) {
        const i = this.hoverBin;
        let header;
        if (mode === 'slots') {
          const sp = state.settings.slotSpecs && state.settings.slotSpecs[i];
          header = `Slot #${i + 1} (${sp ? sp.raw : state.settings.slotValues[i]})`;
        } else if (mode === 'ccdf') {
          header = `Score ≥ ${RP.Math.formatNumber(spec.edges[i])}`;
        } else {
          header = `${RP.Math.formatNumber(spec.edges[i])} – ${RP.Math.formatNumber(spec.edges[i + 1])}`;
        }
        const lines = [header];
        for (const s of series) {
          lines.push(`${s.name}: ${((s.data[i] || 0) * 100).toFixed(1)}%`);
        }
        this._drawTooltipBox(ctx, lines, theme);
      }

      ctx.restore();
    }

    _drawTooltipBox(ctx, lines, theme) {
      ctx.save();
      ctx.font = '600 10.5px ui-monospace, SFMono-Regular, monospace';
      let maxW = 0;
      for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
      const boxW = maxW + 16;
      const boxH = lines.length * 14 + 10;
      const bx = this.w - this.pad.right - boxW - 4;
      const by = this.pad.top + 4;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = i === 0 ? '#fef08a' : '#e2e8f0';
        ctx.fillText(lines[i], bx + 8, by + 6 + i * 14);
      }
      ctx.restore();
    }
  }

  class SensitivityChart {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cb = callbacks;
      this.dpr = 1;
      this.w = 300;
      this.h = 165;
      this.pad = { top: 20, right: 16, bottom: 26, left: 42 };
      this.hoverU = null;
      this.dragging = null;
      this.lastState = null;

      this._bindEvents();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = rect.width;
      this.h = rect.height;
      const tw = Math.round(rect.width * this.dpr);
      const th = Math.round(rect.height * this.dpr);
      if (this.canvas.width !== tw || this.canvas.height !== th) {
        this.canvas.width = tw;
        this.canvas.height = th;
      }
    }

    _pxToU(px) {
      const plotW = this.w - this.pad.left - this.pad.right;
      return RP.Math.clamp((px - this.pad.left) / Math.max(1, plotW), 0, 1);
    }

    _bindEvents() {
      this.canvas.addEventListener('pointerdown', (e) => {
        if (!this.lastState) return;
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const u = this._pxToU(px);
        const st = this.lastState;
        const dT = Math.abs(u - st.effectiveTrainedTarget);
        const dN = Math.abs(u - st.settings.naiveTarget);
        this.dragging = dN < dT && dN < 0.06 ? 'naive' : 'trained';
        this.canvas.setPointerCapture(e.pointerId);
        this.cb.onAimDrag(this.dragging, u);
      });

      this.canvas.addEventListener('pointermove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const u = this._pxToU(px);

        if (this.dragging) {
          this.cb.onAimDrag(this.dragging, u);
          this.cb.onInspectU(u, false);
          return;
        }

        if (px >= this.pad.left && px <= this.w - this.pad.right && py >= this.pad.top && py <= this.h - this.pad.bottom) {
          this.hoverU = u;
          this.canvas.style.cursor = 'crosshair';
          this.cb.onInspectU(u, false);
        } else if (this.hoverU !== null) {
          this.hoverU = null;
          this.canvas.style.cursor = 'default';
          this.cb.onInspectU(null, false);
        }
      });

      this.canvas.addEventListener('pointerup', (e) => {
        if (this.dragging) {
          this.dragging = null;
          try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      });

      this.canvas.addEventListener('pointerleave', () => {
        if (!this.dragging && this.hoverU !== null) {
          this.hoverU = null;
          this.cb.onInspectU(null, false);
        }
      });
    }

    render(state) {
      this.lastState = state;
      this.resize();
      const ctx = this.ctx;
      const theme = getThemeColors(this.canvas);
      const isMarkov = state.solverMode === 'markov';
      const vals = isMarkov
        ? (state.markovSol ? state.markovSol.entryMeans : null)
        : (state.sweep ? state.sweep.values : null);
      if (!vals || vals.length === 0) return;

      const s = state.settings;
      const n = vals.length;
      const baseVals = isMarkov
        ? (state.baselineMarkov ? state.baselineMarkov.entryMeans : null)
        : (state.baselineSweep ? state.baselineSweep.values : null);

      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, this.w, this.h);

      const p = this.pad;
      const plotW = this.w - p.left - p.right;
      const plotH = this.h - p.top - p.bottom;

      let minV = Infinity;
      let maxV = -Infinity;
      for (let i = 0; i < n; i++) {
        if (vals[i] < minV) minV = vals[i];
        if (vals[i] > maxV) maxV = vals[i];
      }
      if (baseVals) {
        for (let i = 0; i < baseVals.length; i++) {
          if (baseVals[i] < minV) minV = baseVals[i];
          if (baseVals[i] > maxV) maxV = baseVals[i];
        }
      }
      minV = Math.min(0, minV);
      if (maxV <= minV) maxV = minV + 10;

      const useLog = state.logScale;
      const offset = minV < 0 ? -minV + 1 : 1;
      const loL = Math.log10(minV + offset);
      const hiL = Math.log10(maxV + offset);

      const valToY = (v) => {
        let t;
        if (useLog) {
          t = (Math.log10(Math.max(1e-5, v + offset)) - loL) / Math.max(1e-5, hiL - loL);
        } else {
          t = (v - minV) / Math.max(1e-5, maxV - minV);
        }
        return p.top + plotH * (1 - RP.Math.clamp(t, 0, 1));
      };

      // Grid lines & Y axis
      ctx.strokeStyle = theme.grid;
      ctx.fillStyle = theme.axis;
      ctx.font = '500 10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let k = 0; k <= 3; k++) {
        const frac = k / 3;
        const y = p.top + plotH * (1 - frac);
        ctx.beginPath();
        ctx.moveTo(p.left, y);
        ctx.lineTo(this.w - p.right, y);
        ctx.stroke();

        const tickVal = useLog
          ? Math.pow(10, loL + (hiL - loL) * frac) - offset
          : minV + (maxV - minV) * frac;
        ctx.fillText(RP.Math.formatNumber(tickVal), p.left - 6, y);
      }

      // Draw Naive & Trained Gaussian aim envelopes shaded vertically behind the score curve
      this._drawSkillBellBg(ctx, p, plotW, plotH, s.naiveTarget, s.naiveSigma, theme.naiveFill, theme.naive, 'N');
      this._drawSkillBellBg(ctx, p, plotW, plotH, state.effectiveTrainedTarget, s.trainedSigma, theme.trainedFill, theme.trained, 'T');

      // Baseline ghost curve
      if (baseVals && baseVals.length > 1) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = theme.baseline;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let i = 0; i < baseVals.length; i++) {
          const x = p.left + (i / (baseVals.length - 1)) * plotW;
          const y = valToY(baseVals[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Live score sensitivity curve f(u)
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = p.left + (i / Math.max(1, n - 1)) * plotW;
        const y = valToY(vals[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Quota horizontal reference line
      if (s.quota >= minV && s.quota <= maxV) {
        const qy = valToY(s.quota);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = theme.quota;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(p.left, qy);
        ctx.lineTo(this.w - p.right, qy);
        ctx.stroke();
        ctx.restore();
      }

      // Hover inspect marker
      if (this.hoverU !== null) {
        const hx = p.left + this.hoverU * plotW;
        const idx = Math.round(this.hoverU * (n - 1));
        const hy = valToY(vals[idx]);
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, p.top);
        ctx.lineTo(hx, p.top + plotH);
        ctx.stroke();

        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // X-axis labels (Drop % or Angle deg)
      ctx.fillStyle = theme.axis;
      ctx.font = '500 10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = [0, 0.25, 0.5, 0.75, 1];
      for (const u of xTicks) {
        const x = p.left + u * plotW;
        const lbl = s.launcherMode === 'cannon'
          ? `${Math.round(16 + (164 - 16) * u)}°`
          : `${Math.round(u * 100)}%`;
        ctx.fillText(lbl, x, p.top + plotH + 6);
      }

      ctx.restore();
    }

    _drawSkillBellBg(ctx, p, plotW, plotH, meanU, sigmaU, fill, stroke, tag) {
      const sig = Math.max(0.006, sigmaU);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p.left, p.top + plotH);
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const d = (u - meanU) / sig;
        const h = Math.exp(-0.5 * d * d) * (plotH * 0.85);
        ctx.lineTo(p.left + u * plotW, p.top + plotH - h);
      }
      ctx.lineTo(p.left + plotW, p.top + plotH);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      // Target vertical indicator
      const tx = p.left + meanU * plotW;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
      ctx.setLineDash(tag === 'N' ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(tx, p.top);
      ctx.lineTo(tx, p.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Small top tag
      ctx.fillStyle = stroke;
      ctx.font = '700 9.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(tag, tx, p.top - 9);
      ctx.restore();
    }
  }

  RP.Charts = {
    DistributionChart,
    SensitivityChart
  };
})();
