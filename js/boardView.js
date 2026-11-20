(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});

  const SHOT_COLORS = ['#ffffff', '#38bdf8', '#facc15', '#f472b6', '#34d399'];

  function scoreColor(t, alpha) {
    const c = RP.Math.clamp(t, 0, 1);
    let r, g, b;
    if (c < 0.35) {
      const k = c / 0.35;
      r = Math.round(RP.Math.lerp(45, 14, k));
      g = Math.round(RP.Math.lerp(95, 185, k));
      b = Math.round(RP.Math.lerp(235, 228, k));
    } else if (c < 0.72) {
      const k = (c - 0.35) / 0.37;
      r = Math.round(RP.Math.lerp(14, 245, k));
      g = Math.round(RP.Math.lerp(185, 165, k));
      b = Math.round(RP.Math.lerp(228, 32, k));
    } else {
      const k = (c - 0.72) / 0.28;
      r = Math.round(RP.Math.lerp(245, 255, k));
      g = Math.round(RP.Math.lerp(165, 72, k));
      b = Math.round(RP.Math.lerp(32, 168, k));
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function slotHueColor(slotIdx, slotCount, alpha) {
    const hue = Math.round((slotIdx / Math.max(1, slotCount)) * 310 + 195) % 360;
    return `hsla(${hue}, 88%, 62%, ${alpha})`;
  }

  class BoardView {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cb = callbacks;

      this.scaleX = 1;
      this.scaleY = 1;
      this.dpr = window.devicePixelRatio || 1;
      this.dragState = null;
      this.cursor = null;
      this.hoverObjId = null;
      this.hoverSlot = -1;
      this.hoverLaunchU = null;

      this.testBalls = [];
      this.animStartMs = 0;

      this._bindPointerEvents();
      this.resize();
    }

    _metrics(state) {
      return RP.Engine.getBoardMetrics(state ? state.settings : null);
    }

    resize(state) {
      const m = this._metrics(state);
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.round(rect.width * this.dpr);
      const targetH = Math.round(rect.height * this.dpr);
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
      }
      this.scaleX = rect.width / m.W;
      this.scaleY = rect.height / m.H;
    }

    clientToBoard(clientX, clientY, state) {
      const m = this._metrics(state);
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * m.W,
        y: ((clientY - rect.top) / rect.height) * m.H
      };
    }

    snapCoord(v, snap) {
      return snap ? Math.round(v / 12) * 12 : Math.round(v * 2) / 2;
    }

    spawnTestBall(trace, color = '#ffffff') {
      if (!trace || !trace.paths) return;
      const now = performance.now();
      if (this.testBalls.length === 0) this.animStartMs = now;
      for (let i = 0; i < trace.paths.length; i++) {
        const path = trace.paths[i];
        if (!path.points || path.points.length < 2) continue;
        const segLens = [0];
        let total = 0;
        for (let k = 1; k < path.points.length; k++) {
          const p0 = path.points[k - 1];
          const p1 = path.points[k];
          const d = p1.jump ? 0 : Math.hypot(p1.x - p0.x, p1.y - p0.y);
          total += d;
          segLens.push(total);
        }
        if (total < 1) continue;
        const shotDelay = (path.shotIdx || 0) * 680;
        const shotColor = path.shotIdx > 0
          ? SHOT_COLORS[path.shotIdx % SHOT_COLORS.length]
          : (path.isPrimary ? color : '#34d399');
        this.testBalls.push({
          points: path.points,
          segLens,
          totalLen: total,
          startTime: now + shotDelay + (path.isPrimary ? 0 : 90),
          speed: 520,
          color: shotColor,
          trail: []
        });
      }
    }

    hasActiveAnimations() {
      return this.testBalls.length > 0;
    }

    _uToHandlePos(u, s) {
      const m = RP.Engine.getBoardMetrics(s);
      if (s.launcherMode === 'cannon') {
        const deg = 16 + (164 - 16) * u;
        const rad = (deg * Math.PI) / 180;
        return {
          x: m.cannonX + Math.cos(rad) * 44,
          y: m.cannonY + Math.sin(rad) * 44
        };
      }
      const extraMargin = m.shape === 'arch'
        ? (m.right - m.left) * 0.14
        : m.shape === 'diamond'
          ? (m.right - m.left) * 0.12
          : 0;
      const margin = s.ballRadius + 16 + extraMargin;
      return {
        x: m.left + margin + Math.max(20, m.right - m.left - margin * 2) * u,
        y: m.launchY - 12
      };
    }

    _posToU(pt, s) {
      const m = RP.Engine.getBoardMetrics(s);
      if (s.launcherMode === 'cannon') {
        const deg = (Math.atan2(pt.y - m.cannonY, pt.x - m.cannonX) * 180) / Math.PI;
        return RP.Math.clamp((deg - 16) / (164 - 16), 0, 1);
      }
      const extraMargin = m.shape === 'arch'
        ? (m.right - m.left) * 0.14
        : m.shape === 'diamond'
          ? (m.right - m.left) * 0.12
          : 0;
      const margin = s.ballRadius + 16 + extraMargin;
      return RP.Math.clamp(
        (pt.x - (m.left + margin)) / Math.max(20, m.right - m.left - margin * 2),
        0,
        1
      );
    }

    _hitTestTargetHandle(pt, state) {
      const s = state.settings;
      const handles = [
        { who: 'trained', u: state.effectiveTrainedTarget },
        { who: 'naive', u: s.naiveTarget }
      ];
      for (const h of handles) {
        const pos = this._uToHandlePos(h.u, s);
        if (Math.hypot(pt.x - pos.x, pt.y - pos.y) <= 13) return h.who;
      }
      return null;
    }

    _hitTestObject(pt, objects, selectedId) {
      const M = RP.Math;
      if (selectedId) {
        const sel = objects.find((o) => o.id === selectedId);
        if (sel) {
          if (sel.shape === 'segment') {
            if (Math.hypot(pt.x - sel.x1, pt.y - sel.y1) <= 12) return { obj: sel, part: 'p1' };
            if (Math.hypot(pt.x - sel.x2, pt.y - sel.y2) <= 12) return { obj: sel, part: 'p2' };
          } else if (sel.shape === 'portal') {
            if (Math.hypot(pt.x - sel.exitX, pt.y - sel.exitY) <= 16) return { obj: sel, part: 'exit' };
          }
        }
      }

      const ordered = [...objects].sort((a, b) => {
        const rank = (o) => (o.shape === 'zone' ? 0 : o.layerGroup === 'base' ? 1 : 2);
        return rank(b) - rank(a);
      });

      for (const obj of ordered) {
        if (obj.shape === 'circle') {
          if (Math.hypot(pt.x - obj.x, pt.y - obj.y) <= Math.max(12, (obj.radius || 10) + 4)) {
            return { obj, part: 'body' };
          }
        } else if (obj.shape === 'portal') {
          if (Math.hypot(pt.x - obj.x, pt.y - obj.y) <= Math.max(14, (obj.radius || 14) + 5)) {
            return { obj, part: 'body' };
          }
          if (Math.hypot(pt.x - obj.exitX, pt.y - obj.exitY) <= 15) {
            return { obj, part: 'exit' };
          }
        } else if (obj.shape === 'segment') {
          if (Math.hypot(pt.x - obj.x1, pt.y - obj.y1) <= 10) return { obj, part: 'p1' };
          if (Math.hypot(pt.x - obj.x2, pt.y - obj.y2) <= 10) return { obj, part: 'p2' };
          if (M.distToSegmentSq(pt.x, pt.y, obj.x1, obj.y1, obj.x2, obj.y2) <= 10 * 10) {
            return { obj, part: 'body' };
          }
        } else if (obj.shape === 'zone') {
          if (Math.hypot(pt.x - obj.x, pt.y - obj.y) <= (obj.radius || 64)) {
            return { obj, part: 'body' };
          }
        }
      }
      return null;
    }

    _bindPointerEvents() {
      this.canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const state = this.cb.getState();
        const m = this._metrics(state);
        const pt = this.clientToBoard(e.clientX, e.clientY, state);
        this.cursor = pt;

        const handle = this._hitTestTargetHandle(pt, state);
        if (handle) {
          this.canvas.setPointerCapture(e.pointerId);
          this.dragState = { type: 'aim', who: handle };
          this.cb.onAimDrag(handle, this._posToU(pt, state.settings));
          return;
        }

        if (pt.y >= m.floorY - 4) {
          const slotCount = (state.settings.slotSpecs || state.settings.slotValues).length;
          const slot = RP.Math.clamp(
            Math.floor(((pt.x - m.left) / (m.right - m.left)) * slotCount),
            0,
            slotCount - 1
          );
          this.cb.onSlotClick(slot);
          return;
        }

        if (state.activeTool !== 'select') {
          const tpl = this.cb.getActiveTemplate();
          if (!tpl) return;
          const sx = this.snapCoord(RP.Math.clamp(pt.x, m.left + 12, m.right - 12), state.snapToGrid);
          const sy = this.snapCoord(RP.Math.clamp(pt.y, m.top + 46, m.floorY - 18), state.snapToGrid);

          if (tpl.shape === 'segment') {
            this.canvas.setPointerCapture(e.pointerId);
            this.dragState = { type: 'drawSegment', tpl, x1: sx, y1: sy, x2: sx, y2: sy };
          } else {
            this.cb.onPlaceObject(tpl, sx, sy);
          }
          return;
        }

        const hit = this._hitTestObject(pt, state.objects, state.selectedId);
        if (hit) {
          this.canvas.setPointerCapture(e.pointerId);
          this.cb.onSelectObject(hit.obj.id);
          this.cb.onBeginTransform();
          this.dragState = {
            type: 'move',
            objId: hit.obj.id,
            part: hit.part,
            startPt: pt,
            orig: { ...hit.obj }
          };
        } else {
          this.cb.onSelectObject(null);
          if (pt.y < 105) {
            this.cb.onInspectU(this._posToU(pt, state.settings), true);
          }
        }
      });

      this.canvas.addEventListener('pointermove', (e) => {
        const state = this.cb.getState();
        const m = this._metrics(state);
        const pt = this.clientToBoard(e.clientX, e.clientY, state);
        this.cursor = pt;

        if (this.dragState) {
          if (this.dragState.type === 'aim') {
            this.cb.onAimDrag(this.dragState.who, this._posToU(pt, state.settings));
            return;
          }
          if (this.dragState.type === 'drawSegment') {
            this.dragState.x2 = this.snapCoord(RP.Math.clamp(pt.x, m.left + 8, m.right - 8), state.snapToGrid);
            this.dragState.y2 = this.snapCoord(RP.Math.clamp(pt.y, m.top + 42, m.floorY - 14), state.snapToGrid);
            this.cb.onRequestRender();
            return;
          }
          if (this.dragState.type === 'move') {
            const dx = pt.x - this.dragState.startPt.x;
            const dy = pt.y - this.dragState.startPt.y;
            const o = this.dragState.orig;
            const snap = state.snapToGrid;
            const patch = {};

            if (this.dragState.part === 'p1') {
              patch.x1 = this.snapCoord(RP.Math.clamp(o.x1 + dx, m.left + 6, m.right - 6), snap);
              patch.y1 = this.snapCoord(RP.Math.clamp(o.y1 + dy, m.top + 36, m.floorY - 12), snap);
            } else if (this.dragState.part === 'p2') {
              patch.x2 = this.snapCoord(RP.Math.clamp(o.x2 + dx, m.left + 6, m.right - 6), snap);
              patch.y2 = this.snapCoord(RP.Math.clamp(o.y2 + dy, m.top + 36, m.floorY - 12), snap);
            } else if (this.dragState.part === 'exit') {
              patch.exitX = this.snapCoord(RP.Math.clamp(o.exitX + dx, m.left + 14, m.right - 14), snap);
              patch.exitY = this.snapCoord(RP.Math.clamp(o.exitY + dy, m.top + 44, m.floorY - 20), snap);
            } else if (o.shape === 'segment') {
              const sdx = this.snapCoord(o.x1 + dx, snap) - o.x1;
              const sdy = this.snapCoord(o.y1 + dy, snap) - o.y1;
              patch.x1 = RP.Math.clamp(o.x1 + sdx, m.left + 6, m.right - 6);
              patch.y1 = RP.Math.clamp(o.y1 + sdy, m.top + 36, m.floorY - 12);
              patch.x2 = RP.Math.clamp(o.x2 + sdx, m.left + 6, m.right - 6);
              patch.y2 = RP.Math.clamp(o.y2 + sdy, m.top + 36, m.floorY - 12);
            } else {
              patch.x = this.snapCoord(RP.Math.clamp(o.x + dx, m.left + 10, m.right - 10), snap);
              patch.y = this.snapCoord(RP.Math.clamp(o.y + dy, m.top + 42, m.floorY - 16), snap);
            }
            this.cb.onMoveObject(this.dragState.objId, patch);
            return;
          }
        }

        const handle = this._hitTestTargetHandle(pt, state);
        if (handle) {
          this.canvas.style.cursor = 'ew-resize';
          this.hoverObjId = null;
          this.hoverSlot = -1;
          this.cb.onHoverSlot(-1);
          return;
        }

        if (pt.y >= m.floorY - 4) {
          const slotCount = (state.settings.slotSpecs || state.settings.slotValues).length;
          const slot = RP.Math.clamp(
            Math.floor(((pt.x - m.left) / (m.right - m.left)) * slotCount),
            0,
            slotCount - 1
          );
          this.hoverSlot = slot;
          this.hoverObjId = null;
          this.canvas.style.cursor = 'pointer';
          this.cb.onHoverSlot(slot);
          return;
        } else if (this.hoverSlot !== -1) {
          this.hoverSlot = -1;
          this.cb.onHoverSlot(-1);
        }

        const nearLauncher = state.settings.launcherMode === 'cannon'
          ? Math.hypot(pt.x - m.cannonX, pt.y - m.cannonY) < 76
          : pt.y < 92;

        if (nearLauncher && state.activeTool === 'select') {
          const u = this._posToU(pt, state.settings);
          this.hoverLaunchU = u;
          this.canvas.style.cursor = 'crosshair';
          this.cb.onInspectU(u, false);
          return;
        } else if (this.hoverLaunchU !== null) {
          this.hoverLaunchU = null;
          this.cb.onInspectU(null, false);
        }

        if (state.activeTool !== 'select') {
          this.canvas.style.cursor = 'crosshair';
          this.hoverObjId = null;
          this.cb.onRequestRender();
          return;
        }

        const hit = this._hitTestObject(pt, state.objects, state.selectedId);
        const nextHoverId = hit ? hit.obj.id : null;
        if (nextHoverId !== this.hoverObjId) {
          this.hoverObjId = nextHoverId;
          if (this.cb.onHoverObj) this.cb.onHoverObj(nextHoverId);
        }
        this.canvas.style.cursor = hit ? (hit.part === 'p1' || hit.part === 'p2' || hit.part === 'exit' ? 'grab' : 'move') : 'default';
        this.cb.onRequestRender();
      });

      this.canvas.addEventListener('pointerup', (e) => {
        if (!this.dragState) return;
        const ds = this.dragState;
        this.dragState = null;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}

        if (ds.type === 'drawSegment') {
          const len = Math.hypot(ds.x2 - ds.x1, ds.y2 - ds.y1);
          if (len < 14) {
            this.cb.onPlaceObject(ds.tpl, ds.x1, ds.y1);
          } else {
            this.cb.onPlaceObject(ds.tpl, (ds.x1 + ds.x2) / 2, (ds.y1 + ds.y2) / 2, {
              x1: ds.x1, y1: ds.y1, x2: ds.x2, y2: ds.y2
            });
          }
        }
      });

      this.canvas.addEventListener('pointerleave', () => {
        this.cursor = null;
        this.hoverObjId = null;
        if (this.hoverSlot !== -1) {
          this.hoverSlot = -1;
          this.cb.onHoverSlot(-1);
        }
        if (this.hoverLaunchU !== null) {
          this.hoverLaunchU = null;
          this.cb.onInspectU(null, false);
        }
        this.cb.onRequestRender();
      });
    }

    render(state) {
      this.resize(state);
      const ctx = this.ctx;
      const m = this._metrics(state);
      const s = state.settings;
      const sweep = state.sweep;

      // Live animation clock for spinning blades & moving bucket during test-ball playback
      const liveAnimT = this.testBalls.length > 0 ? (performance.now() - this.animStartMs) / 1000 : 0;
      const phaseRad = ((s.startPhaseDeg || 0) * Math.PI) / 180;

      ctx.save();
      ctx.scale(this.dpr * this.scaleX, this.dpr * this.scaleY);

      // 1. Optical chamber backdrop
      const bgGrad = ctx.createLinearGradient(0, 0, 0, m.H);
      bgGrad.addColorStop(0, '#070b14');
      bgGrad.addColorStop(1, '#0b1220');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, m.W, m.H);

      // Precision coordinate grid
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = m.left; x <= m.right; x += 24) {
        ctx.moveTo(x, m.top);
        ctx.lineTo(x, m.floorY);
      }
      for (let y = m.top; y <= m.floorY; y += 24) {
        ctx.moveTo(m.left, y);
        ctx.lineTo(m.right, y);
      }
      ctx.stroke();

      // Chamber outer boundary
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = 2;
      ctx.strokeRect(m.left, m.top, m.right - m.left, m.floorY - m.top);

      // Custom chamber bevels / pachinko arch walls
      if (m.chamberWalls.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 4.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const cw of m.chamberWalls) {
          ctx.moveTo(cw.x1, cw.y1);
          ctx.lineTo(cw.x2, cw.y2);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // 2. Render force zones beneath rays
      for (const obj of state.objects) {
        if (obj.shape !== 'zone') continue;
        this._drawZone(ctx, obj, obj.id === state.selectedId, obj.id === this.hoverObjId);
      }

      // 3. Render Live Raycasting Bundle OR Exact Markov Sankey Flow Graph
      if (state.solverMode === 'markov') {
        if (state.markovFlow) this._drawMarkovGraph(ctx, state);
      } else if (sweep && sweep.traces.length > 0) {
        this._drawRayBundle(ctx, state);
      }

      // 4. Render single inspected ray on top (physics mode)
      if (state.solverMode !== 'markov' && state.inspectedTrace) {
        this._drawSingleTrace(ctx, state.inspectedTrace, m);
      }

      // 5. Render bottom slots + live landing probability bars
      this._drawSlots(ctx, state, m);

      // 6. Render Moving Bonus Bucket if enabled
      if (s.movingBucket) {
        this._drawMovingBucket(ctx, s, m, liveAnimT);
      }

      // 7. Render physical objects (pegs, bumpers, walls, gates, spinners, portals)
      const heatMap = state.solverMode === 'markov' ? state.markovHeat : (sweep ? sweep.objectHeat : null);
      const maxHeat = this._maxHeatFromMap(heatMap);
      for (const obj of state.objects) {
        if (obj.shape === 'zone') continue;
        const heat = heatMap ? (heatMap.get(obj.id) || 0) : 0;
        this._drawObject(
          ctx,
          obj,
          obj.id === state.selectedId,
          obj.id === this.hoverObjId,
          s.showHeatmap && maxHeat > 0 ? heat / maxHeat : 0,
          liveAnimT,
          phaseRad
        );
      }

      // 8. Render launcher rail / pivot cannon + Naive & Trained skill envelopes
      this._drawLauncher(ctx, state, m);

      // 9. Render placement preview / active segment draw
      this._drawPlacementPreview(ctx, state, m);

      // 10. Render animated test balls
      this._drawTestBalls(ctx);

      ctx.restore();
    }

    _maxHeatFromMap(map) {
      if (!map) return 0;
      let m = 0;
      map.forEach((v) => { if (v > m) m = v; });
      return m;
    }

    _drawMovingBucket(ctx, s, m, t) {
      const bw = s.bucketWidth || 82;
      const bx = RP.Engine.getBucketX(t, s, m);
      const by = m.floorY - 9;

      ctx.save();
      // Sweep track rail
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.25)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(m.left + 8, by);
      ctx.lineTo(m.right - 8, by);
      ctx.stroke();
      ctx.setLineDash([]);

      // Glowing bucket lip
      ctx.fillStyle = 'rgba(250, 204, 21, 0.24)';
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.roundRect(bx - bw * 0.5, by - 7, bw, 13, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fef08a';
      ctx.font = '700 8.5px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`×${s.bucketMult || 2}${s.bucketReplay !== false ? ' +R' : ''}`, bx, by);
      ctx.restore();
    }

    _drawMarkovGraph(ctx, state) {
      const sol = state.markovSol;
      const flow = state.markovFlow;
      if (!sol || !flow) return;

      const g = sol.graph;
      const N = g.N;
      const bayesMap = state.markovBayesFlows;
      const hasBayes = Boolean(bayesMap && bayesMap.size > 0);
      const activeFlowMode = state.markovFlowView || 'trained';

      let maxFlow = 0.08;
      for (const ef of flow.edgeFlows) {
        if (ef.flow > maxFlow) maxFlow = ef.flow;
      }

      const nodePos = (idx) => (idx < N ? g.nodes[idx] : g.slots[idx - N]);

      ctx.save();
      ctx.lineCap = 'round';

      const entryColor = activeFlowMode === 'naive'
        ? [245, 158, 11]
        : activeFlowMode === 'trained'
          ? [34, 211, 238]
          : [139, 92, 246];

      const aggEntry = new Map();
      for (let c = 0; c < g.entryCols; c++) {
        const w = state.markovEntryWeights ? state.markovEntryWeights[c] : (1 / g.entryCols);
        if (w < 1e-4) continue;
        const tgt = g.entryTargets[c];
        const pt = g.entryPoints[c];
        const prev = aggEntry.get(tgt);
        if (!prev) aggEntry.set(tgt, { sumX: pt.x * w, sumY: pt.y * w, w });
        else {
          prev.sumX += pt.x * w;
          prev.sumY += pt.y * w;
          prev.w += w;
        }
      }

      aggEntry.forEach((info, tgt) => {
        const dest = nodePos(tgt);
        const sx = info.sumX / info.w;
        const sy = info.sumY / info.w;
        const alpha = hasBayes ? 0.14 : RP.Math.clamp(info.w * 2.4 + 0.12, 0.14, 0.85);
        ctx.strokeStyle = `rgba(${entryColor[0]},${entryColor[1]},${entryColor[2]},${alpha})`;
        ctx.lineWidth = RP.Math.clamp(info.w * 14, 1.2, 6.5);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(dest.x, dest.y);
        ctx.stroke();
      });

      for (const ef of flow.edgeFlows) {
        const a = nodePos(ef.from);
        const b = nodePos(ef.to);
        const key = `${ef.from}->${ef.to}`;
        const cond = hasBayes ? (bayesMap.get(key) || 0) : 0;

        let alpha;
        let width;
        let stroke;
        const isLoop = ef.kind === 'loop';
        const isPortal = ef.kind === 'portal';

        if (hasBayes) {
          if (cond > 0.005) {
            alpha = RP.Math.clamp(cond * 1.4 + 0.25, 0.28, 0.95);
            width = RP.Math.clamp(cond * 7.5 + 1.1, 1.3, 6.5);
            stroke = `rgba(253, 224, 71, ${alpha})`;
          } else {
            alpha = 0.06;
            width = 1;
            stroke = 'rgba(148, 163, 184, 0.08)';
          }
        } else {
          const norm = RP.Math.clamp(ef.flow / maxFlow, 0, 1);
          alpha = RP.Math.clamp(norm * 0.78 + 0.10, 0.10, 0.92);
          width = RP.Math.clamp(norm * 6.0 + 0.85, 0.9, 6.5);
          if (isLoop) stroke = `rgba(245, 158, 11, ${Math.min(0.95, alpha + 0.12)})`;
          else if (isPortal) stroke = `rgba(192, 132, 252, ${Math.min(0.95, alpha + 0.15)})`;
          else stroke = `rgba(${entryColor[0]},${entryColor[1]},${entryColor[2]},${alpha})`;
        }

        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        if (isPortal) ctx.setLineDash([5, 4]);
        else ctx.setLineDash([]);

        ctx.beginPath();
        if (ef.from === ef.to) {
          ctx.arc(a.x, a.y - 20, 16, 0.25 * Math.PI, 2.15 * Math.PI);
        } else if (isLoop || isPortal) {
          const mx = (a.x + b.x) * 0.5;
          const my = (a.y + b.y) * 0.5;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const curve = isPortal ? -34 : 24;
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(mx - (dy / len) * curve, my + (dx / len) * curve, b.x, b.y);
        } else {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();

        if ((!hasBayes && isLoop && ef.p >= 0.12 && ef.flow >= 0.04) || (hasBayes && cond >= 0.22 && ef.from !== ef.to)) {
          const lx = ef.from === ef.to ? a.x : (a.x + b.x) * 0.5;
          const ly = ef.from === ef.to ? a.y - 40 : (a.y + b.y) * 0.5 - 6;
          const lbl = hasBayes ? `${Math.round(cond * 100)}%` : `↻${Math.round(ef.p * 100)}%`;
          ctx.save();
          ctx.setLineDash([]);
          ctx.font = '700 9px ui-monospace, SFMono-Regular, monospace';
          const tw = ctx.measureText(lbl).width + 6;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
          ctx.beginPath();
          ctx.roundRect(lx - tw / 2, ly - 6.5, tw, 13, 3);
          ctx.fill();
          ctx.fillStyle = hasBayes ? '#fef08a' : '#fbbf24';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lbl, lx, ly + 0.5);
          ctx.restore();
        }
      }
      ctx.setLineDash([]);

      if (state.inspectedU !== null && g.entryCols > 0) {
        const c = RP.Math.clamp(Math.round(state.inspectedU * (g.entryCols - 1)), 0, g.entryCols - 1);
        const pt = g.entryPoints[c];
        const dest = nodePos(g.entryTargets[c]);
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(dest.x, dest.y);
        ctx.stroke();
      }

      ctx.restore();
    }

    _drawRayBundle(ctx, state) {
      const sweep = state.sweep;
      const traces = sweep.traces;
      const n = traces.length;
      const s = state.settings;
      const highlightSet = state.highlightRaySet;
      const hasFilter = highlightSet && highlightSet.size > 0;
      const hasSingle = Boolean(state.inspectedTrace);

      const stats = state.analysis ? state.analysis.uniform : null;
      const loV = stats ? stats.p10 * 0.75 : 0;
      const hiV = stats ? Math.max(loV + 1, stats.p99) : 100;
      const useLogColor = hiV / Math.max(1, Math.abs(loV) + 1) > 8;
      const logLo = Math.log10(Math.max(1, loV + 1));
      const logHi = Math.log10(Math.max(2, hiV + 1));

      const trainedT = state.effectiveTrainedTarget;
      const trainedSig = s.trainedSigma;
      const naiveT = s.naiveTarget;
      const naiveSig = s.naiveSigma;
      const slotCount = (s.slotSpecs || s.slotValues).length;

      let avgBounces = 0;
      for (let i = 0; i < n; i++) avgBounces += traces[i].bounces;
      avgBounces /= Math.max(1, n);
      const densityDamp = avgBounces > 14 ? RP.Math.clamp(14 / avgBounces, 0.28, 1) : 1;
      const baseAlpha = RP.Math.clamp((38 / n) * densityDamp, 0.04, 0.34);
      const rayWidth = s.gravity <= 1 ? 0.95 : 1.15;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < n; i++) {
        const isHighlighted = hasFilter && highlightSet.has(i);
        if (isHighlighted) continue;

        const tr = traces[i];
        let alpha = baseAlpha;
        if (hasFilter) alpha = baseAlpha * 0.16;
        else if (hasSingle) alpha = baseAlpha * 0.30;

        let stroke;
        if (s.rayColorMode === 'skill') {
          const dT = Math.abs(tr.u - trainedT) / Math.max(0.005, trainedSig);
          const dN = Math.abs(tr.u - naiveT) / Math.max(0.01, naiveSig);
          if (dT <= 1.65) stroke = `rgba(34, 211, 238, ${Math.min(0.65, alpha * 2.4)})`;
          else if (dN <= 1.4) stroke = `rgba(245, 158, 11, ${alpha * 1.1})`;
          else stroke = `rgba(100, 116, 139, ${alpha * 0.35})`;
        } else if (s.rayColorMode === 'slot') {
          stroke = slotHueColor(tr.primarySlot, slotCount, alpha);
        } else {
          let tNorm;
          if (useLogColor) {
            tNorm = (Math.log10(Math.max(1, tr.finalScore + 1)) - logLo) / Math.max(0.1, logHi - logLo);
          } else {
            tNorm = (tr.finalScore - loV) / Math.max(1e-5, hiV - loV);
          }
          stroke = scoreColor(tNorm, alpha);
        }

        ctx.strokeStyle = stroke;
        ctx.lineWidth = rayWidth;
        this._strokeTracePaths(ctx, tr.paths);
      }

      if (hasFilter) {
        const hiAlpha = RP.Math.clamp(12 / Math.sqrt(highlightSet.size), 0.35, 0.92);
        ctx.strokeStyle = `rgba(254, 240, 138, ${hiAlpha})`;
        ctx.lineWidth = 1.85;
        highlightSet.forEach((idx) => {
          if (idx >= 0 && idx < n) this._strokeTracePaths(ctx, traces[idx].paths);
        });
      }

      ctx.restore();
    }

    _strokeTracePaths(ctx, paths) {
      for (let p = 0; p < paths.length; p++) {
        const pts = paths[p].points;
        if (pts.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].jump) ctx.moveTo(pts[k].x, pts[k].y);
          else ctx.lineTo(pts[k].x, pts[k].y);
        }
        ctx.stroke();
      }
    }

    _drawSingleTrace(ctx, tr, m) {
      ctx.save();
      const multiShot = tr.shotScores && tr.shotScores.length > 1;
      for (let p = 0; p < tr.paths.length; p++) {
        const path = tr.paths[p];
        const pts = path.points;
        if (pts.length < 2) continue;

        const shotHue = multiShot
          ? SHOT_COLORS[(path.shotIdx || 0) % SHOT_COLORS.length]
          : (path.isPrimary ? '#ffffff' : '#6ee7b7');

        ctx.strokeStyle = multiShot ? `${shotHue}48` : (path.isPrimary ? 'rgba(56, 189, 248, 0.38)' : 'rgba(16, 185, 129, 0.35)');
        ctx.lineWidth = 4.8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].jump) ctx.moveTo(pts[k].x, pts[k].y);
          else ctx.lineTo(pts[k].x, pts[k].y);
        }
        ctx.stroke();

        ctx.strokeStyle = shotHue;
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(216, 180, 254, 0.85)';
        ctx.lineWidth = 1.5;
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].jump) {
            ctx.beginPath();
            ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
            ctx.lineTo(pts[k].x, pts[k].y);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      if (tr.events && tr.events.length > 0) {
        const shown = tr.events.slice(0, 12);
        ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const ev of shown) {
          ctx.fillStyle = ev.color || '#38bdf8';
          ctx.beginPath();
          ctx.arc(ev.x, ev.y, 3.2, 0, Math.PI * 2);
          ctx.fill();

          if (ev.label) {
            const w = Math.max(24, ctx.measureText(ev.label).width + 8);
            const bx = RP.Math.clamp(ev.x, m.left + 6 + w / 2, m.right - 6 - w / 2);
            const by = Math.max(40, ev.y - 13);
            ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
            ctx.strokeStyle = ev.color || '#38bdf8';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bx - w / 2, by - 7.5, w, 15, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(ev.label, bx, by + 0.5);
          }
        }
      }
      ctx.restore();
    }

    _drawZone(ctx, obj, selected, hovered) {
      const r = obj.radius || 64;
      const disabled = obj.enabled === false;
      ctx.save();
      ctx.globalAlpha = disabled ? 0.18 : 1;

      const grad = ctx.createRadialGradient(obj.x, obj.y, 4, obj.x, obj.y, r);
      grad.addColorStop(0, `${obj.color}38`);
      grad.addColorStop(1, `${obj.color}06`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(obj.x, obj.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#e2e8f0' : `${obj.color}99`;
      ctx.lineWidth = selected ? 2 : 1.25;
      ctx.stroke();
      ctx.setLineDash([]);

      if (obj.forceX || obj.forceY) {
        const len = Math.hypot(obj.forceX, obj.forceY);
        const ux = obj.forceX / len;
        const uy = obj.forceY / len;
        ctx.strokeStyle = `${obj.color}aa`;
        ctx.lineWidth = 1.5;
        for (const off of [-20, 0, 20]) {
          const px = obj.x - uy * off;
          const py = obj.y + ux * off;
          this._drawArrow(ctx, px - ux * 16, py - uy * 16, px + ux * 16, py + uy * 16, 5);
        }
      } else if (obj.radialForce) {
        const inward = obj.radialForce < 0;
        ctx.strokeStyle = `${obj.color}aa`;
        ctx.lineWidth = 1.4;
        for (let a = 0; a < 6; a++) {
          const rad = (a * Math.PI) / 3;
          const xOut = obj.x + Math.cos(rad) * (r * 0.62);
          const yOut = obj.y + Math.sin(rad) * (r * 0.62);
          const xIn = obj.x + Math.cos(rad) * (r * 0.24);
          const yIn = obj.y + Math.sin(rad) * (r * 0.24);
          if (inward) this._drawArrow(ctx, xOut, yOut, xIn, yIn, 4.5);
          else this._drawArrow(ctx, xIn, yIn, xOut, yOut, 4.5);
        }
      }

      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillStyle = `${obj.color}dd`;
      ctx.textAlign = 'center';
      ctx.fillText(obj.name || 'Zone', obj.x, obj.y + r - 10);
      ctx.restore();
    }

    _drawObject(ctx, obj, selected, hovered, normHeat, liveAnimT = 0, phaseRad = 0) {
      const disabled = obj.enabled === false;
      const isDyn = RP.Engine.isDynamicObject(obj);
      const pose = isDyn ? RP.Engine.evaluateObjectPose(obj, liveAnimT, phaseRad) : obj;

      ctx.save();
      ctx.globalAlpha = disabled ? 0.25 : 1;

      // Subtle travel rail for oscillating obstacles
      if ((obj.oscAmpX || obj.oscAmpY) && !disabled) {
        const cx = obj.shape === 'segment' ? (obj.x1 + obj.x2) * 0.5 : obj.x;
        const cy = obj.shape === 'segment' ? (obj.y1 + obj.y2) * 0.5 : obj.y;
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = `${obj.color}55`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx - (obj.oscAmpX || 0), cy - (obj.oscAmpY || 0));
        ctx.lineTo(cx + (obj.oscAmpX || 0), cy + (obj.oscAmpY || 0));
        ctx.stroke();
        ctx.restore();
      }

      if (obj.shape === 'segment') {
        const lw = obj.thickness || 6;
        const x1 = pose.x1;
        const y1 = pose.y1;
        const x2 = pose.x2;
        const y2 = pose.y2;

        if (normHeat > 0.04 && !disabled) {
          ctx.strokeStyle = `rgba(251, 146, 60, ${normHeat * 0.55})`;
          ctx.lineWidth = lw + 10;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }

        ctx.strokeStyle = selected ? '#ffffff' : obj.color || '#cbd5e1';
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Spinner hub & rotation direction arc
        if (obj.angularSpeedDeg && Math.abs(obj.angularSpeedDeg) > 1e-3) {
          const mx = (x1 + x2) * 0.5;
          const my = (y1 + y2) * 0.5;
          const half = Math.hypot(x2 - x1, y2 - y1) * 0.5;
          ctx.save();
          ctx.setLineDash([3, 5]);
          ctx.strokeStyle = `${obj.color}44`;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.arc(mx, my, half, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#0f172a';
          ctx.strokeStyle = obj.color || '#2dd4bf';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        if (obj.oneWay) {
          const ux = x2 - x1;
          const uy = y2 - y1;
          const len = Math.hypot(ux, uy) || 1;
          const nx = -uy / len;
          const ny = ux / len;
          const mx = (x1 + x2) * 0.5;
          const my = (y1 + y2) * 0.5;

          ctx.strokeStyle = '#67e8f9';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1 + nx * 4, y1 + ny * 4);
          ctx.lineTo(x2 + nx * 4, y2 + ny * 4);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(103, 232, 249, 0.8)';
          ctx.lineWidth = 1.5;
          this._drawArrow(ctx, mx - nx * 13, my - ny * 13, mx + nx * 12, my + ny * 12, 5);
        }

        if (selected || hovered) {
          for (const [hx, hy] of [[obj.x1, obj.y1], [obj.x2, obj.y2]]) {
            ctx.fillStyle = selected ? '#38bdf8' : '#94a3b8';
            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
        return;
      }

      if (obj.shape === 'portal') {
        const r = obj.radius || 15;
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = selected ? '#f0abfc' : 'rgba(192, 132, 252, 0.55)';
        ctx.lineWidth = selected ? 2 : 1.3;
        ctx.beginPath();
        ctx.moveTo(obj.x, obj.y);
        const mx = (obj.x + obj.exitX) * 0.5;
        const my = (obj.y + obj.exitY) * 0.5 - 26;
        ctx.quadraticCurveTo(mx, my, obj.exitX, obj.exitY);
        ctx.stroke();
        ctx.restore();

        if (normHeat > 0.04 && !disabled) {
          ctx.fillStyle = `rgba(192, 132, 252, ${normHeat * 0.5})`;
          ctx.beginPath();
          ctx.arc(obj.x, obj.y, r + 9, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(192, 132, 252, 0.22)';
        ctx.strokeStyle = selected ? '#ffffff' : obj.color || '#c084fc';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f5d0fe';
        ctx.font = '700 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('IN', obj.x, obj.y + 0.5);

        ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
        ctx.strokeStyle = selected ? '#ffffff' : '#67e8f9';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(obj.exitX, obj.exitY, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        if (Number.isFinite(obj.exitAngleDeg)) {
          const rad = (obj.exitAngleDeg * Math.PI) / 180;
          ctx.strokeStyle = '#67e8f9';
          ctx.lineWidth = 1.8;
          this._drawArrow(
            ctx,
            obj.exitX,
            obj.exitY,
            obj.exitX + Math.cos(rad) * (r + 14),
            obj.exitY + Math.sin(rad) * (r + 14),
            5
          );
        }
        ctx.fillStyle = '#cffafe';
        ctx.fillText('OUT', obj.exitX, obj.exitY + 0.5);
        ctx.restore();
        return;
      }

      // Circle objects
      const cx = pose.x;
      const cy = pose.y;
      const r = obj.radius || 9;

      // Synergy Aura radius ring
      if (obj.auraRadius > 0 && !disabled) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = (selected || hovered) ? 'rgba(250, 204, 21, 0.72)' : 'rgba(250, 204, 21, 0.22)';
        ctx.lineWidth = (selected || hovered) ? 1.6 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, obj.auraRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Bomb Blast radius ring when selected/hovered
      if (obj.isBomb && obj.bombRadius > 0 && !disabled) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = (selected || hovered) ? 'rgba(249, 115, 22, 0.75)' : 'rgba(249, 115, 22, 0.22)';
        ctx.lineWidth = (selected || hovered) ? 1.6 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, obj.bombRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (normHeat > 0.04 && !disabled) {
        const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r + 12);
        halo.addColorStop(0, `rgba(251, 146, 60, ${normHeat * 0.58})`);
        halo.addColorStop(1, 'rgba(251, 146, 60, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 12, 0, Math.PI * 2);
        ctx.fill();
      }

      if (obj.kickSpeed > 80 || obj.restitution > 1.05) {
        ctx.strokeStyle = `${obj.color}66`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = obj.layerGroup === 'base' ? '#1e293b' : `${obj.color}33`;
      ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#f8fafc' : obj.color || '#94a3b8';
      ctx.lineWidth = selected ? 2.6 : obj.layerGroup === 'base' ? 1.8 : 2.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (obj.maxHitsPerShot === 1) {
        ctx.strokeStyle = `${obj.color}88`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, r - 3), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (r >= 10 || obj.layerGroup !== 'base') {
        let label = obj.tag || '';
        if (obj.isRefresh) label = '⟳';
        else if (obj.isBomb) label = '✹';
        else if (obj.auraRadius > 0) label = '✦';
        else if (obj.triggerEveryN > 1) label = `${obj.triggerEveryN}×`;
        else if (obj.scoreMult && obj.scoreMult !== 1) label = `×${obj.scoreMult}`;
        else if (obj.splitCount > 1) label = `⑂${obj.splitCount}`;
        else if (!label || label === '•') label = obj.scoreAdd ? `+${obj.scoreAdd}` : '';

        if (label && r >= 9) {
          ctx.fillStyle = '#f8fafc';
          ctx.font = `700 ${r >= 14 ? 10 : 8.5}px ui-monospace, SFMono-Regular, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, cx, cy + 0.5);
        }
      }

      ctx.restore();
    }

    _drawSlots(ctx, state, m) {
      const specs = state.settings.slotSpecs || RP.Presets.parseSlotSpecs(state.settings.slotValues);
      const count = specs.length;
      const totalW = m.right - m.left;
      const slotW = totalW / count;
      const slotPmf = state.solverMode === 'markov' && state.markovFlow
        ? state.markovFlow.slotPmf
        : (state.analysis ? state.analysis.uniform.slotPmf : null);
      const maxP = slotPmf ? Math.max(0.05, ...slotPmf) : 1;

      ctx.save();
      for (let i = 0; i < count; i++) {
        const spec = specs[i];
        const x = m.left + i * slotW;
        const isLocked = state.lockedSlot === i;
        const isHovered = this.hoverSlot === i;
        const p = slotPmf ? slotPmf[i] : 0;

        let specialTint = null;
        let specialText = null;
        if (spec.special === 'replay') { specialTint = '#22d3ee'; specialText = spec.value ? `${spec.value}R` : 'R'; }
        else if (spec.special === 'refresh') { specialTint = '#4ade80'; specialText = spec.value ? `${spec.value}F` : 'F'; }
        else if (spec.special === 'halve') { specialTint = '#f43f5e'; specialText = '÷2'; }
        else if (spec.special === 'mult') { specialTint = '#e879f9'; specialText = `×${spec.mult}`; }

        ctx.fillStyle = isLocked
          ? 'rgba(250, 204, 21, 0.24)'
          : isHovered
            ? 'rgba(56, 189, 248, 0.2)'
            : specialTint
              ? `${specialTint}18`
              : 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(x + 1, m.floorY, slotW - 2, m.H - m.floorY - 12);

        const barH = (p / maxP) * (m.H - m.floorY - 16);
        ctx.fillStyle = isLocked
          ? 'rgba(250, 204, 21, 0.55)'
          : specialTint
            ? `${specialTint}44`
            : 'rgba(56, 189, 248, 0.32)';
        ctx.fillRect(x + 2, m.H - 13 - barH, slotW - 4, barH);

        ctx.strokeStyle = isLocked ? '#facc15' : (specialTint ? `${specialTint}88` : 'rgba(148, 163, 184, 0.35)');
        ctx.lineWidth = isLocked ? 2 : 1;
        ctx.strokeRect(x + 1, m.floorY, slotW - 2, m.H - m.floorY - 12);

        ctx.fillStyle = isLocked ? '#fef08a' : (specialTint || '#e2e8f0');
        ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = state.settings.scoreMode === 'slotIndex'
          ? `#${i + 1}`
          : (specialText || (state.settings.scoreMode === 'slotMult' ? `×${spec.value}` : `${spec.value}`));
        ctx.fillText(label, x + slotW / 2, m.floorY + 14);

        ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
        ctx.font = '500 9px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText(`${(p * 100).toFixed(0)}%`, x + slotW / 2, m.floorY + 29);
      }
      ctx.restore();
    }

    _drawLauncher(ctx, state, m) {
      const s = state.settings;
      ctx.save();

      if (s.launcherMode === 'cannon') {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(m.cannonX, m.cannonY, 44, (16 * Math.PI) / 180, (164 * Math.PI) / 180);
        ctx.stroke();

        this._drawArcEnvelope(ctx, m, s.naiveTarget, s.naiveSigma, 'rgba(245, 158, 11, 0.55)', 44, 5);
        this._drawArcEnvelope(ctx, m, state.effectiveTrainedTarget, s.trainedSigma, 'rgba(34, 211, 238, 0.9)', 44, 5);

        ctx.fillStyle = '#1e293b';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(m.cannonX, m.cannonY, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        const extraMargin = m.shape === 'arch'
          ? (m.right - m.left) * 0.14
          : m.shape === 'diamond'
            ? (m.right - m.left) * 0.12
            : 0;
        const margin = s.ballRadius + 16 + extraMargin;
        const x0 = m.left + margin;
        const x1 = m.right - margin;
        const railY = m.launchY - 12;

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, railY);
        ctx.lineTo(x1, railY);
        ctx.stroke();

        this._drawRailBell(ctx, x0, x1, railY, s.naiveTarget, s.naiveSigma, 'rgba(245, 158, 11, 0.4)', '#f59e0b');
        this._drawRailBell(ctx, x0, x1, railY, state.effectiveTrainedTarget, s.trainedSigma, 'rgba(34, 211, 238, 0.45)', '#22d3ee');
      }

      const nPos = this._uToHandlePos(s.naiveTarget, s);
      const tPos = this._uToHandlePos(state.effectiveTrainedTarget, s);
      this._drawHandleBadge(ctx, nPos.x, nPos.y, 'N', '#f59e0b');
      this._drawHandleBadge(ctx, tPos.x, tPos.y, 'T', '#22d3ee');

      ctx.restore();
    }

    _drawArcEnvelope(ctx, m, meanU, sigmaU, color, radius, width) {
      const uLo = RP.Math.clamp(meanU - sigmaU * 1.5, 0, 1);
      const uHi = RP.Math.clamp(meanU + sigmaU * 1.5, 0, 1);
      const a0 = ((16 + (164 - 16) * uLo) * Math.PI) / 180;
      const a1 = ((16 + (164 - 16) * uHi) * Math.PI) / 180;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(m.cannonX, m.cannonY, radius, a0, a1);
      ctx.stroke();
    }

    _drawRailBell(ctx, x0, x1, y, meanU, sigmaU, fill, stroke) {
      const sig = Math.max(0.008, sigmaU);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      const steps = 60;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const d = (u - meanU) / sig;
        const h = Math.exp(-0.5 * d * d) * 18;
        ctx.lineTo(RP.Math.lerp(x0, x1, u), y - h);
      }
      ctx.lineTo(x1, y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    _drawHandleBadge(ctx, x, y, text, color) {
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
    }

    _drawPlacementPreview(ctx, state, m) {
      if (this.dragState && this.dragState.type === 'drawSegment') {
        const ds = this.dragState;
        ctx.save();
        ctx.strokeStyle = ds.tpl.color || '#38bdf8';
        ctx.lineWidth = ds.tpl.thickness || 6;
        ctx.lineCap = 'round';
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(ds.x1, ds.y1);
        ctx.lineTo(ds.x2, ds.y2);
        ctx.stroke();
        ctx.restore();
        return;
      }

      if (state.activeTool === 'select' || !this.cursor) return;
      const tpl = this.cb.getActiveTemplate();
      if (!tpl) return;
      const sx = this.snapCoord(RP.Math.clamp(this.cursor.x, m.left + 12, m.right - 12), state.snapToGrid);
      const sy = this.snapCoord(RP.Math.clamp(this.cursor.y, m.top + 46, m.floorY - 18), state.snapToGrid);

      ctx.save();
      ctx.globalAlpha = 0.55;
      const ghost = RP.Presets.instantiateFromTemplate(tpl, sx, sy);
      if (ghost.shape === 'zone') this._drawZone(ctx, ghost, false, false);
      else this._drawObject(ctx, ghost, false, false, 0);
      ctx.restore();
    }

    _drawTestBalls(ctx) {
      if (this.testBalls.length === 0) return;
      const now = performance.now();
      const alive = [];

      for (const b of this.testBalls) {
        const elapsed = (now - b.startTime) / 1000;
        if (elapsed < 0) {
          alive.push(b);
          continue;
        }
        const dist = elapsed * b.speed;
        if (dist >= b.totalLen) continue;

        let idx = 1;
        while (idx < b.segLens.length - 1 && b.segLens[idx] < dist) idx++;
        const s0 = b.segLens[idx - 1];
        const s1 = b.segLens[idx];
        const frac = s1 > s0 ? (dist - s0) / (s1 - s0) : 0;
        const p0 = b.points[idx - 1];
        const p1 = b.points[idx];
        const x = RP.Math.lerp(p0.x, p1.x, frac);
        const y = RP.Math.lerp(p0.y, p1.y, frac);

        b.trail.push({ x, y });
        if (b.trail.length > 16) b.trail.shift();

        ctx.save();
        for (let k = 1; k < b.trail.length; k++) {
          ctx.globalAlpha = (k / b.trail.length) * 0.65;
          ctx.strokeStyle = b.color;
          ctx.lineWidth = (k / b.trail.length) * 6.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(b.trail[k - 1].x, b.trail[k - 1].y);
          ctx.lineTo(b.trail[k].x, b.trail[k].y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        alive.push(b);
      }
      this.testBalls = alive;
    }

    _drawArrow(ctx, x1, y1, x2, y2, headLen) {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
  }

  RP.BoardView = BoardView;
})();
