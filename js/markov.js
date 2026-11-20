(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});

  /**
   * Check whether directed segment (ax,ay)->(bx,by) intersects wall segment (wx1,wy1)-(wx2,wy2)
   * from a blocking side (respecting wall.oneWay).
   * Returns { hit: true, t, hx, hy } or null.
   */
  function segmentHitsWall(ax, ay, bx, by, wall) {
    const dx = bx - ax;
    const dy = by - ay;
    const ex = wall.x2 - wall.x1;
    const ey = wall.y2 - wall.y1;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) return null;

    if (wall.oneWay) {
      // Left-hand normal (+n): oneWay blocks rays moving with v . n < 0
      const nx = -ey / len;
      const ny = ex / len;
      if (dx * nx + dy * ny >= -1e-6) return null;
    }

    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) return null;

    const qx = wall.x1 - ax;
    const qy = wall.y1 - ay;
    const t = (qx * ey - qy * ex) / denom;
    if (t <= 1e-4 || t >= 1 - 1e-4) return null;

    const u = (qx * dy - qy * dx) / denom;
    if (u < -0.02 || u > 1.02) return null;

    return { hit: true, t, hx: ax + dx * t, hy: ay + dy * t };
  }

  function findFirstBlockingWall(ax, ay, bx, by, walls) {
    let best = null;
    for (let i = 0; i < walls.length; i++) {
      const res = segmentHitsWall(ax, ay, bx, by, walls[i]);
      if (res && (!best || res.t < best.t)) {
        best = { wall: walls[i], ...res };
      }
    }
    return best;
  }

  /**
   * Pick the best unobstructed target node (internal or slot) for a falling/deflected transition.
   */
  function pickDownstreamTarget(fromX, fromY, side, selfIdx, nodes, slots, walls, metrics, preferStrictSide = true) {
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let j = 0; j < nodes.length; j++) {
      if (j === selfIdx) continue;
      const target = nodes[j];
      const dy = target.y - fromY;
      if (dy < 16 || dy > 220) continue;

      const dx = target.x - fromX;
      if (preferStrictSide) {
        if (side < 0 && dx >= -3) continue;
        if (side > 0 && dx <= 3) continue;
      }
      if (Math.abs(dx) > 175) continue;

      if (findFirstBlockingWall(fromX, fromY, target.x, target.y, walls)) continue;

      const idealDx = side === 0 ? 0 : side * 28;
      const score = dy * 1.15 + Math.abs(dx - idealDx) * 1.55;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) return bestIdx;

    const targetX = RP.Math.clamp(fromX + side * 24, metrics.left + 8, metrics.right - 8);
    let bestSlot = -1;
    let bestSlotDist = Infinity;
    for (let s = 0; s < slots.length; s++) {
      const slotNode = slots[s];
      const d = Math.abs(slotNode.x - targetX);
      if (findFirstBlockingWall(fromX, fromY, slotNode.x, slotNode.y - 6, walls)) continue;
      if (d < bestSlotDist) {
        bestSlotDist = d;
        bestSlot = nodes.length + s;
      }
    }

    if (bestSlot >= 0) return bestSlot;

    const sIdx = RP.Math.clamp(
      Math.floor(((targetX - metrics.left) / (metrics.right - metrics.left)) * slots.length),
      0,
      slots.length - 1
    );
    return nodes.length + sIdx;
  }

  /**
   * Follow a blocking wall downhill to its lower end to model exact funneling/channeling.
   */
  function resolveWallChuteTarget(wall, selfIdx, nodes, slots, walls, metrics) {
    const lowX = wall.y1 >= wall.y2 ? wall.x1 : wall.x2;
    const lowY = Math.max(wall.y1, wall.y2);
    const dirX = wall.y1 >= wall.y2 ? Math.sign(wall.x1 - wall.x2) : Math.sign(wall.x2 - wall.x1);
    const startX = RP.Math.clamp(lowX + dirX * 14, metrics.left + 10, metrics.right - 10);
    const startY = Math.min(metrics.floorY - 12, lowY + 8);
    return pickDownstreamTarget(startX, startY, dirX, selfIdx, nodes, slots, walls, metrics, false);
  }

  /**
   * Build the exact discrete absorbing Markov chain T = [Q | R; 0 | I] directly from board objects.
   */
  function buildGraph(objects, settings) {
    const E = RP.Engine;
    const M = RP.Math;
    const metrics = E.getBoardMetrics(settings);
    const slotSpecs = (settings.slotSpecs && settings.slotSpecs.length > 0)
      ? settings.slotSpecs
      : RP.Presets.parseSlotSpecs(settings.slotValues || [10, 20, 35, 55, 80, 100, 80, 55, 35, 20, 10]);
    const slotCount = slotSpecs.length;
    const totalW = metrics.right - metrics.left;
    const slotW = totalW / slotCount;

    const nodes = [];
    const walls = [...metrics.chamberWalls];
    const zones = [];

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.enabled === false) continue;
      if (obj.shape === 'segment') {
        walls.push(obj);
      } else if (obj.shape === 'zone') {
        zones.push(obj);
      } else {
        nodes.push({
          idx: nodes.length,
          id: obj.id,
          obj,
          x: obj.x,
          y: obj.y
        });
      }
    }

    const slots = [];
    for (let s = 0; s < slotCount; s++) {
      slots.push({
        slotIdx: s,
        globalIdx: nodes.length + s,
        x: metrics.left + (s + 0.5) * slotW,
        y: metrics.floorY,
        value: slotSpecs[s].value,
        spec: slotSpecs[s]
      });
    }

    const N = nodes.length;
    const K = slotCount;
    const adj = Array.from({ length: N }, () => []);

    const addEdge = (u, v, prob, kind = 'flow') => {
      if (prob <= 1e-12) return;
      const list = adj[u];
      for (let i = 0; i < list.length; i++) {
        if (list[i].to === v) {
          list[i].p += prob;
          if (kind === 'loop' || kind === 'portal') list[i].kind = kind;
          return;
        }
      }
      list.push({ from: u, to: v, p: prob, kind });
    };

    for (let i = 0; i < N; i++) {
      const node = nodes[i];
      const obj = node.obj;

      // Case 1: Warp Portal -> 100% jump to exit destination
      if (obj.shape === 'portal') {
        const ex = Number.isFinite(obj.exitX) ? obj.exitX : metrics.W - obj.x;
        const ey = Number.isFinite(obj.exitY) ? obj.exitY : Math.max(80, obj.y - 160);
        const dest = pickDownstreamTarget(ex, ey - 18, 0, i, nodes, slots, walls, metrics, false);
        addEdge(i, dest, 1.0, 'portal');
        continue;
      }

      let pRight;
      if (Number.isFinite(obj.markovRightProb)) {
        pRight = M.clamp(obj.markovRightProb, 0.01, 0.99);
      } else {
        let shift = 0;
        if (obj.biasAngle) shift += -obj.biasAngle / 90;
        if (obj.tangentialBoost) shift += obj.tangentialBoost / 600;
        for (const z of zones) {
          const zr = z.radius || 64;
          const d = Math.hypot(node.x - z.x, node.y - z.y);
          if (d <= zr) {
            if (z.forceX) shift += z.forceX / 1500;
            if (z.radialForce && d > 2) {
              const pullDir = Math.sign(z.x - node.x);
              shift += pullDir * (-z.radialForce / 1800) * (1 - (d / zr) * 0.4);
            }
          }
        }
        pRight = M.clamp(0.5 + shift, 0.04, 0.96);
      }
      const pLeft = 1 - pRight;

      let pLoop = 0;
      if (Number.isFinite(obj.markovLoopProb)) {
        pLoop = M.clamp(obj.markovLoopProb, 0, 0.85);
      } else if (obj.kind === 'bumper' || (obj.restitution || 0.62) > 1.04 || (obj.kickSpeed || 0) >= 120) {
        pLoop = M.clamp(((obj.restitution || 1.0) - 0.88) * 0.55 + (obj.kickSpeed || 0) / 880, 0.16, 0.56);
        for (const w of walls) {
          if (w.isChamberWall) continue;
          const wy = (w.y1 + w.y2) * 0.5;
          const wx = (w.x1 + w.x2) * 0.5;
          if (wy < node.y && node.y - wy < 145 && Math.abs(wx - node.x) < 110) {
            pLoop = Math.min(0.66, pLoop + 0.12);
            break;
          }
        }
      }

      if (pLoop > 0) {
        const neighbors = [];
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const nb = nodes[j];
          const dist = Math.hypot(nb.x - node.x, nb.y - node.y);
          if (dist <= 135 && !findFirstBlockingWall(node.x, node.y, nb.x, nb.y, walls)) {
            const isBumperLike = nb.obj.kind === 'bumper' || nb.obj.layerGroup !== 'base';
            neighbors.push({ j, dist, weight: isBumperLike ? 2.5 : 1.0 });
          }
        }
        if (neighbors.length > 0) {
          neighbors.sort((a, b) => a.dist - b.dist);
          const picked = neighbors.slice(0, 3);
          const wSum = picked.reduce((acc, x) => acc + x.weight, 0);
          for (const item of picked) {
            addEdge(i, item.j, pLoop * (item.weight / wSum), 'loop');
          }
        } else {
          addEdge(i, i, pLoop, 'loop');
        }
      }

      const pForward = 1 - pLoop;

      const resolveSide = (side) => {
        const probeX = M.clamp(node.x + side * 38, metrics.left + 8, metrics.right - 8);
        const probeY = Math.min(metrics.floorY - 6, node.y + 62);
        const wallHit = findFirstBlockingWall(node.x, node.y, probeX, probeY, walls);
        if (wallHit) {
          return resolveWallChuteTarget(wallHit.wall, i, nodes, slots, walls, metrics);
        }
        return pickDownstreamTarget(node.x, node.y, side, i, nodes, slots, walls, metrics, true);
      };

      const leftTarget = resolveSide(-1);
      const rightTarget = resolveSide(1);
      addEdge(i, leftTarget, pForward * pLeft, 'flow');
      addEdge(i, rightTarget, pForward * pRight, 'flow');

      let sum = 0;
      for (const e of adj[i]) sum += e.p;
      if (sum > 0 && Math.abs(sum - 1) > 1e-12) {
        for (const e of adj[i]) e.p /= sum;
      }
    }

    const entryCols = 64;
    const entryTargets = new Int32Array(entryCols);
    const entryPoints = new Array(entryCols);
    const raySpan = Math.hypot(metrics.W, metrics.H);

    for (let c = 0; c < entryCols; c++) {
      const u = entryCols === 1 ? 0.5 : c / (entryCols - 1);
      const launch = E.getLaunchState(u, settings);
      const spd = Math.hypot(launch.vx, launch.vy) || 1;
      const dx = (launch.vx / spd) * raySpan;
      const dy = (launch.vy / spd) * raySpan;
      entryPoints[c] = { u, x: launch.x, y: launch.y };

      let bestT = 1.0;
      let hitTarget = -1;

      const wallHit = findFirstBlockingWall(launch.x, launch.y, launch.x + dx, launch.y + dy, walls);
      if (wallHit) {
        bestT = wallHit.t;
        hitTarget = resolveWallChuteTarget(wallHit.wall, -1, nodes, slots, walls, metrics);
      }

      for (let i = 0; i < N; i++) {
        const nd = nodes[i];
        const capR = Math.max(18, (nd.obj.radius || 10) + settings.ballRadius + 7);
        const hit = M.intersectRayCircle(launch.x, launch.y, dx, dy, nd.x, nd.y, capR, bestT);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          hitTarget = i;
        }
      }

      if (hitTarget < 0) {
        const tFloor = dy > 1e-6 ? M.clamp((metrics.floorY - launch.y) / dy, 0, 1) : 1;
        const fx = M.clamp(launch.x + dx * tFloor, metrics.left + 1, metrics.right - 1);
        const sIdx = M.clamp(Math.floor(((fx - metrics.left) / totalW) * slotCount), 0, slotCount - 1);
        hitTarget = N + sIdx;
      }

      entryTargets[c] = hitTarget;
    }

    return {
      nodes,
      slots,
      walls,
      zones,
      adj,
      N,
      K,
      metrics,
      entryCols,
      entryTargets,
      entryPoints
    };
  }

  /**
   * Convolve two sparse score PMF Maps (Map<score, prob>) — exact AnyDice sum of two balls!
   */
  function convolvePmf(pmfA, pmfB) {
    const out = new Map();
    pmfA.forEach((pA, sA) => {
      if (pA < 1e-8) return;
      pmfB.forEach((pB, sB) => {
        const p = pA * pB;
        if (p < 1e-8) return;
        const s = Math.round((sA + sB) * 4) / 4;
        out.set(s, (out.get(s) || 0) + p);
      });
    });
    return out;
  }

  /**
   * Propagate exact sparse (basePoints, mult) probability states from a single starting node/slot
   * until remaining in-flight mass < 1e-7 (exact on DAGs in <= depth waves; converges exponentially on cycles).
   */
  function solveExactNodeScorePmf(startTarget, graph, settings, singleBallCache, allowSplit) {
    const N = graph.N;
    const slots = graph.slots;
    const adj = graph.adj;
    const scoreMode = settings.scoreMode;

    // Direct slot hit
    if (startTarget >= N) {
      const sIdx = startTarget - N;
      const val = scoreMode === 'slotIndex' ? (sIdx + 1) : (scoreMode === 'slotMult' ? slots[sIdx].value : slots[sIdx].value);
      const pmf = new Map([[val, 1.0]]);
      const slotPmf = new Float64Array(graph.K);
      slotPmf[sIdx] = 1.0;
      return { pmf, slotPmf, absorbedMass: 1.0 };
    }

    // Active wave: Map<nodeIdx, Map<"base|mult", prob>>
    let wave = new Map();
    wave.set(startTarget, new Map([['0|1', 1.0]]));

    const absorbedPmf = new Map();
    const slotPmf = new Float64Array(graph.K);
    let absorbedMass = 0;

    const MAX_WAVES = 72;
    const MAX_STATES_PER_NODE = 90;

    for (let step = 0; step < MAX_WAVES && wave.size > 0; step++) {
      let waveMass = 0;
      const nextWave = new Map();

      wave.forEach((stateMap, u) => {
        const node = graph.nodes[u];
        const obj = node.obj;
        const edges = adj[u];
        const add = obj.scoreAdd || 0;
        const multFactor = obj.scoreMult && obj.scoreMult !== 1 ? obj.scoreMult : 1;
        const isSplit = allowSplit && (obj.splitCount || 1) > 1 && scoreMode !== 'slotIndex';

        // If splitting into 2 balls: exact convolution with a fresh single-ball run from this node's outgoing edges!
        let extraBallPmf = null;
        if (isSplit) {
          if (!singleBallCache.has(u)) {
            singleBallCache.set(u, solveExactNodeScorePmf(u, graph, settings, singleBallCache, false).pmf);
          }
          extraBallPmf = singleBallCache.get(u);
        }

        stateMap.forEach((prob, key) => {
          if (prob < 1e-8) return;
          waveMass += prob;

          const sep = key.indexOf('|');
          const curBase = parseFloat(key.slice(0, sep));
          const curMult = parseFloat(key.slice(sep + 1));

          const newBase = Math.round((curBase + add) * 2) / 2;
          // Cap runaway infinite cyclic multiplier exponents cleanly once extreme
          const newMult = Math.min(256, Math.round((curMult * multFactor) * 4) / 4);

          if (isSplit && extraBallPmf && extraBallPmf.size > 0) {
            // Exact discrete convolution of the extra spawned ball(s) weighted by curMult
            // (We apply extra ball contribution right here and continue the primary ball!)
            const extraCopies = Math.min(2, (obj.splitCount || 2) - 1);
            let combinedExtra = extraBallPmf;
            if (extraCopies === 2) combinedExtra = convolvePmf(extraBallPmf, extraBallPmf);

            // Compress extraBallPmf into top states if large
            const entries = Array.from(combinedExtra.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 14);
            let eSum = 0;
            for (const [, ep] of entries) eSum += ep;

            for (const [eScore, ep] of entries) {
              const branchProb = prob * (ep / (eSum || 1));
              if (branchProb < 1e-8) continue;
              const boostedBase = Math.round((newBase + eScore) * 2) / 2;
              pushOutgoing(edges, boostedBase, newMult, branchProb, N, slots, scoreMode, nextWave, absorbedPmf, slotPmf, (m) => { absorbedMass += m; });
            }
          } else {
            pushOutgoing(edges, newBase, newMult, prob, N, slots, scoreMode, nextWave, absorbedPmf, slotPmf, (m) => { absorbedMass += m; });
          }
        });
      });

      if (waveMass < 1e-7) break;

      // Keep sparse state maps compact on cyclic boards without losing probability mass
      nextWave.forEach((sMap, nodeId) => {
        if (sMap.size > MAX_STATES_PER_NODE) {
          nextWave.set(nodeId, compressStateMap(sMap, MAX_STATES_PER_NODE));
        }
      });

      wave = nextWave;
    }

    return { pmf: absorbedPmf, slotPmf, absorbedMass };
  }

  function pushOutgoing(edges, base, mult, prob, N, slots, scoreMode, nextWave, absorbedPmf, slotPmf, onAbsorb) {
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const p = prob * e.p;
      if (p < 1e-8) continue;

      if (e.to >= N) {
        const sIdx = e.to - N;
        const spec = slots[sIdx].spec || { value: slots[sIdx].value, special: null, mult: 1 };
        let finalScore;
        if (scoreMode === 'slotIndex') {
          finalScore = sIdx + 1;
        } else if (scoreMode === 'slotMult') {
          const sMult = spec.special === 'halve' ? 0.5 : (spec.special === 'mult' ? spec.mult : Math.max(0.1, spec.value || 1));
          finalScore = Math.max(1, base) * mult * sMult;
        } else {
          if (spec.special === 'halve') finalScore = base * mult * 0.5;
          else if (spec.special === 'mult') finalScore = base * mult * (spec.mult || 2);
          else finalScore = (base + (spec.value || 0)) * mult;
        }

        finalScore = Math.round(finalScore * 4) / 4;
        absorbedPmf.set(finalScore, (absorbedPmf.get(finalScore) || 0) + p);
        slotPmf[sIdx] += p;
        onAbsorb(p);
      } else {
        let targetMap = nextWave.get(e.to);
        if (!targetMap) {
          targetMap = new Map();
          nextWave.set(e.to, targetMap);
        }
        const k = `${base}|${mult}`;
        targetMap.set(k, (targetMap.get(k) || 0) + p);
      }
    }
  }

  /**
   * Mass-preserving quantization when cyclic boards accumulate many distinct score states.
   */
  function compressStateMap(sMap, maxStates) {
    const byMult = new Map();
    sMap.forEach((prob, key) => {
      const sep = key.indexOf('|');
      const base = parseFloat(key.slice(0, sep));
      const mult = key.slice(sep + 1);
      if (!byMult.has(mult)) byMult.set(mult, []);
      byMult.get(mult).push([base, prob]);
    });

    const out = new Map();
    const perGroup = Math.max(8, Math.floor(maxStates / Math.max(1, byMult.size)));
    byMult.forEach((arr, mult) => {
      arr.sort((a, b) => a[0] - b[0]);
      if (arr.length <= perGroup) {
        for (const [b, p] of arr) out.set(`${b}|${mult}`, p);
        return;
      }
      const chunk = Math.ceil(arr.length / perGroup);
      for (let i = 0; i < arr.length; i += chunk) {
        let pSum = 0;
        let bAcc = 0;
        for (let k = i; k < Math.min(arr.length, i + chunk); k++) {
          pSum += arr[k][1];
          bAcc += arr[k][0] * arr[k][1];
        }
        if (pSum > 1e-9) {
          const avgBase = Math.round((bAcc / pSum) * 2) / 2;
          const key = `${avgBase}|${mult}`;
          out.set(key, (out.get(key) || 0) + pSum);
        }
      }
    });
    return out;
  }

  /**
   * Compute exact summary statistics directly from a sparse PMF Map<score, prob>.
   */
  function analyzeExactPmf(pmfMap, slotPmf, binSpec, quota) {
    const M = RP.Math;
    const pmf = new Float64Array(binSpec.binCount);
    const entries = [];
    let totalProb = 0;

    pmfMap.forEach((p, v) => {
      if (p <= 1e-12) return;
      entries.push({ v, w: p });
      totalProb += p;
    });

    if (entries.length === 0 || totalProb <= 0) {
      return {
        mean: 0, median: 0, p10: 0, p90: 0, p99: 0,
        std: 0, skewness: 0, entropyBits: 0, entropyNorm: 0,
        tailRatio: 1, quotaProb: 0,
        pmf, ccdf: new Float64Array(binSpec.binCount), binMembers: [], slotPmf
      };
    }

    const invTot = 1 / totalProb;
    let mean = 0;
    let quotaProb = 0;
    for (let i = 0; i < entries.length; i++) {
      entries[i].w *= invTot;
      mean += entries[i].v * entries[i].w;
      if (entries[i].v >= quota) quotaProb += entries[i].w;
      const b = M.findBinIndex(entries[i].v, binSpec);
      pmf[b] += entries[i].w;
    }

    let m2 = 0;
    let m3 = 0;
    for (let i = 0; i < entries.length; i++) {
      const d = entries[i].v - mean;
      const d2 = d * d;
      m2 += entries[i].w * d2;
      m3 += entries[i].w * d2 * d;
    }
    const std = Math.sqrt(Math.max(0, m2));
    const skewness = std > 1e-7 ? m3 / (std * std * std) : 0;

    entries.sort((a, b) => a.v - b.v);
    const quantile = (q) => {
      let acc = 0;
      for (let i = 0; i < entries.length; i++) {
        acc += entries[i].w;
        if (acc >= q - 1e-12) return entries[i].v;
      }
      return entries[entries.length - 1].v;
    };

    const p10 = quantile(0.10);
    const median = quantile(0.50);
    const p90 = quantile(0.90);
    const p99 = quantile(0.99);

    const ccdf = new Float64Array(binSpec.binCount);
    let tailAcc = 0;
    for (let b = binSpec.binCount - 1; b >= 0; b--) {
      tailAcc += pmf[b];
      ccdf[b] = M.clamp(tailAcc, 0, 1);
    }

    let entropyBits = 0;
    for (let b = 0; b < binSpec.binCount; b++) {
      const p = pmf[b];
      if (p > 1e-12) entropyBits -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(Math.max(2, binSpec.binCount));
    const entropyNorm = M.clamp(entropyBits / maxEntropy, 0, 1);

    return {
      mean,
      median,
      p10,
      p90,
      p99,
      std,
      skewness,
      entropyBits,
      entropyNorm,
      tailRatio: p99 / Math.max(1, Math.abs(median)),
      quotaProb,
      pmf,
      ccdf,
      binMembers: [],
      slotPmf
    };
  }

  /**
   * Full Provable Exact Markov Solver:
   * 1. Builds exact absorbing transition matrix T = [Q | R; 0 | I].
   * 2. Solves Fundamental Matrix N = (I - Q)^-1 and exact Absorption Matrix B = N * R via Gaussian elimination.
   * 3. Computes exact Score PMF for every unique entry node via AnyDice-style sparse PMF propagation.
   */
  function solveBoard(objects, settings) {
    const t0 = performance.now();
    const M = RP.Math;
    const graph = buildGraph(objects, settings);
    const N = graph.N;
    const K = graph.K;

    // 1. Exact Closed-Form (I - Q) * [N_fund | B_abs] = [I | R]
    let fundamental = null; // N x N
    let absorption = null;  // N x K
    let matrixOk = true;
    let maxRowError = 0;

    if (N > 0) {
      const A = new Float64Array(N * N);
      const RHS = new Float64Array(N * (N + K));
      for (let i = 0; i < N; i++) {
        A[i * N + i] = 1.0;
        RHS[i * (N + K) + i] = 1.0;
        const edges = graph.adj[i];
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
          const e = edges[eIdx];
          if (e.to < N) {
            A[i * N + e.to] -= e.p;
          } else {
            RHS[i * (N + K) + N + (e.to - N)] += e.p;
          }
        }
      }

      const sol = M.solveLinearSystem(A, RHS, N, N + K);
      if (sol.ok) {
        fundamental = new Float64Array(N * N);
        absorption = new Float64Array(N * K);
        for (let i = 0; i < N; i++) {
          let rowSum = 0;
          for (let j = 0; j < N; j++) {
            fundamental[i * N + j] = Math.max(0, sol.X[i * (N + K) + j]);
          }
          for (let s = 0; s < K; s++) {
            const p = M.clamp(sol.X[i * (N + K) + N + s], 0, 1);
            absorption[i * K + s] = p;
            rowSum += p;
          }
          const err = Math.abs(1 - rowSum);
          if (err > maxRowError) maxRowError = err;
        }
      } else {
        matrixOk = false;
      }
    }

    // 2. Solve exact Score PMF once for each unique entry target
    const uniqueEntries = new Set();
    for (let c = 0; c < graph.entryCols; c++) uniqueEntries.add(graph.entryTargets[c]);

    const entryResults = new Map();
    const singleBallCache = new Map();
    let minAbsorbedMass = 1.0;
    let minScore = Infinity;
    let maxScore = -Infinity;

    uniqueEntries.forEach((target) => {
      const res = solveExactNodeScorePmf(target, graph, settings, singleBallCache, true);
      if (res.absorbedMass < minAbsorbedMass) minAbsorbedMass = res.absorbedMass;

      // Exact expected value & quota curve helper for this entry
      let ev = 0;
      let mass = 0;
      res.pmf.forEach((p, v) => {
        ev += v * p;
        mass += p;
        if (v < minScore) minScore = v;
        if (v > maxScore) maxScore = v;
      });
      res.mean = mass > 0 ? ev / mass : 0;
      entryResults.set(target, res);
    });

    if (!Number.isFinite(minScore)) {
      minScore = 0;
      maxScore = 10;
    }

    // Build exact sensitivity profile E[Score | u_c] across all 64 launch coordinates
    const entryMeans = new Float64Array(graph.entryCols);
    const allScores = [];
    for (let c = 0; c < graph.entryCols; c++) {
      const res = entryResults.get(graph.entryTargets[c]);
      entryMeans[c] = res ? res.mean : 0;
    }

    // Compute robust upper score bound (99.6th percentile of uniform mixture) so 1e-7 cyclic tails don't squash linear bins
    const tmpU = new Map();
    const invCols = 1 / Math.max(1, graph.entryCols);
    for (let c = 0; c < graph.entryCols; c++) {
      const res = entryResults.get(graph.entryTargets[c]);
      if (!res) continue;
      res.pmf.forEach((p, v) => {
        tmpU.set(v, (tmpU.get(v) || 0) + p * invCols);
      });
    }
    tmpU.forEach((p, v) => allScores.push([v, p]));
    allScores.sort((a, b) => a[0] - b[0]);
    let accP = 0;
    let totalP = 0;
    for (let i = 0; i < allScores.length; i++) totalP += allScores[i][1];
    let p995Score = maxScore;
    for (let i = 0; i < allScores.length; i++) {
      accP += allScores[i][1] / (totalP || 1);
      if (accP >= 0.995) {
        p995Score = allScores[i][0];
        break;
      }
    }

    return {
      graph,
      fundamental,
      absorption,
      matrixOk,
      maxRowError,
      minAbsorbedMass,
      entryResults,
      entryMeans,
      minScore,
      maxScore,
      p995Score,
      elapsedMs: performance.now() - t0
    };
  }

  /**
   * Mix exact per-entry PMFs using launch weight vector w[0..entryCols-1].
   * Also computes exact expected visits per node and exact edge probability flows!
   */
  function mixByWeights(markovSol, weights) {
    const g = markovSol.graph;
    const N = g.N;
    const K = g.K;
    const mixedPmf = new Map();
    const mixedSlots = new Float64Array(K);
    const entryNodeProb = new Float64Array(N + K);

    for (let c = 0; c < g.entryCols; c++) {
      const w = weights[c];
      if (w <= 1e-12) continue;
      const target = g.entryTargets[c];
      entryNodeProb[target] += w;

      const res = markovSol.entryResults.get(target);
      if (!res) continue;
      res.pmf.forEach((p, v) => {
        mixedPmf.set(v, (mixedPmf.get(v) || 0) + w * p);
      });
      // Exact slot absorption directly from closed-form B = (I - Q)^-1 R when available
      if (target >= N) {
        mixedSlots[target - N] += w;
      } else if (markovSol.absorption) {
        for (let s = 0; s < K; s++) {
          mixedSlots[s] += w * markovSol.absorption[target * K + s];
        }
      } else {
        for (let s = 0; s < K; s++) mixedSlots[s] += w * res.slotPmf[s];
      }
    }

    // Exact expected visits E[visits(j)] = sum_i pi_0(i) * N[i, j]
    const expectedVisits = new Float64Array(N);
    if (markovSol.fundamental) {
      for (let i = 0; i < N; i++) {
        const pi = entryNodeProb[i];
        if (pi <= 1e-12) continue;
        const rowOff = i * N;
        for (let j = 0; j < N; j++) {
          expectedVisits[j] += pi * markovSol.fundamental[rowOff + j];
        }
      }
    }

    // Exact edge flow F(u -> v) = E[visits(u)] * P(u -> v)
    const edgeFlows = [];
    for (let u = 0; u < N; u++) {
      const vis = expectedVisits[u];
      if (vis <= 1e-6) continue;
      const edges = g.adj[u];
      for (let eIdx = 0; eIdx < edges.length; eIdx++) {
        const e = edges[eIdx];
        edgeFlows.push({
          from: u,
          to: e.to,
          p: e.p,
          flow: vis * e.p,
          kind: e.kind
        });
      }
    }

    return {
      pmf: mixedPmf,
      slotPmf: mixedSlots,
      entryNodeProb,
      expectedVisits,
      edgeFlows
    };
  }

  /**
   * Exact Bayesian Reverse Attribution for a target bottom slot s:
   * P(flow u->v | landed in slot s) = E[visits(u)] * P(u->v) * B[v, s] / P(slot s).
   */
  function computeSlotBayesianFlows(markovSol, mixed, slotIdx) {
    const g = markovSol.graph;
    const N = g.N;
    const K = g.K;
    const pSlot = mixed.slotPmf[slotIdx] || 0;
    if (pSlot <= 1e-10 || !markovSol.absorption) return null;

    const map = new Map();
    for (const ef of mixed.edgeFlows) {
      let pToSlot;
      if (ef.to >= N) {
        pToSlot = (ef.to - N) === slotIdx ? 1.0 : 0.0;
      } else {
        pToSlot = markovSol.absorption[ef.to * K + slotIdx];
      }
      if (pToSlot > 1e-6) {
        const condFlow = (ef.flow * pToSlot) / pSlot;
        map.set(`${ef.from}->${ef.to}`, condFlow);
      }
    }
    return map;
  }

  /**
   * Exact Mutual Information I(AimRegion; OutcomeBin) from exact conditional PMFs.
   */
  function computeExactMutualInfo(markovSol, binSpec, sigmaTrained) {
    const M = RP.Math;
    const g = markovSol.graph;
    const n = g.entryCols;
    const groups = M.clamp(Math.round(1 / Math.max(0.04, sigmaTrained * 2.5)), 4, 16);
    const bins = binSpec.binCount;
    const joint = new Float64Array(groups * bins);
    const pG = new Float64Array(groups);
    const pB = new Float64Array(bins);
    const invN = 1 / n;

    for (let c = 0; c < n; c++) {
      const grp = Math.min(groups - 1, Math.floor((c / n) * groups));
      const res = markovSol.entryResults.get(g.entryTargets[c]);
      if (!res) continue;
      let total = 0;
      res.pmf.forEach((p) => { total += p; });
      if (total <= 0) continue;
      pG[grp] += invN;
      res.pmf.forEach((p, v) => {
        const b = M.findBinIndex(v, binSpec);
        const contrib = invN * (p / total);
        joint[grp * bins + b] += contrib;
        pB[b] += contrib;
      });
    }

    let mi = 0;
    for (let grp = 0; grp < groups; grp++) {
      if (pG[grp] <= 1e-12) continue;
      for (let b = 0; b < bins; b++) {
        const pgb = joint[grp * bins + b];
        if (pgb > 1e-12 && pB[b] > 1e-12) {
          mi += pgb * Math.log2(pgb / (pG[grp] * pB[b]));
        }
      }
    }
    return Math.max(0, mi);
  }

  /**
   * Exact optimal Trained aim target over the 64 entry columns maximizing EV or Quota Pass Rate.
   */
  function findExactOptimalTarget(markovSol, sigmaU, goal, quota) {
    const g = markovSol.graph;
    const colMetric = new Float64Array(g.entryCols);
    for (let c = 0; c < g.entryCols; c++) {
      const res = markovSol.entryResults.get(g.entryTargets[c]);
      if (!res) continue;
      if (goal === 'quota') {
        let qProb = 0;
        let tot = 0;
        res.pmf.forEach((p, v) => {
          tot += p;
          if (v >= quota) qProb += p;
        });
        colMetric[c] = tot > 0 ? qProb / tot : 0;
      } else {
        colMetric[c] = res.mean;
      }
    }
    return RP.Math.findOptimalTarget(colMetric, sigmaU, 'ev', quota);
  }

  RP.Markov = {
    buildGraph,
    solveBoard,
    mixByWeights,
    analyzeExactPmf,
    computeSlotBayesianFlows,
    computeExactMutualInfo,
    findExactOptimalTarget
  };
})();
