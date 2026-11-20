(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});

  const EPS = 1e-7;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function distSq(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return dx * dx + dy * dy;
  }

  function distToSegmentSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) return distSq(px, py, x1, y1);
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1);
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return distSq(px, py, projX, projY);
  }

  function rotateVec(vx, vy, rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return { x: vx * c - vy * s, y: vx * s + vy * c };
  }

  /**
   * Exact continuous ray-segment vs circle intersection for t in [0, maxT].
   * Ray: P(t) = (ox, oy) + t * (dx, dy).
   * Returns { t, nx, ny } or null.
   */
  function intersectRayCircle(ox, oy, dx, dy, cx, cy, r, maxT) {
    const mx = ox - cx;
    const my = oy - cy;
    const a = dx * dx + dy * dy;
    if (a < 1e-12) return null;
    const b = mx * dx + my * dy;
    const c = mx * mx + my * my - r * r;

    // Already overlapping circle
    if (c <= 0) {
      // Only collide if moving inward toward center
      if (b < -1e-9) {
        const len = Math.hypot(mx, my);
        if (len > 1e-9) {
          return { t: 0, nx: mx / len, ny: my / len };
        }
        const dLen = Math.sqrt(a);
        return { t: 0, nx: -dx / dLen, ny: -dy / dLen };
      }
      return null;
    }

    if (b >= 0) return null; // Moving away from circle
    const disc = b * b - a * c;
    if (disc < 0) return null;

    const t = (-b - Math.sqrt(disc)) / a;
    if (t < 0 || t > maxT) return null;

    const hx = ox + dx * t - cx;
    const hy = oy + dy * t - cy;
    const len = Math.hypot(hx, hy) || 1;
    return { t, nx: hx / len, ny: hy / len };
  }

  /**
   * Ray vs finite 2D line segment (sx1, sy1) -> (sx2, sy2).
   * Returns parameter t along ray in [0, maxT] if hit, else -1.
   */
  function intersectRayLineSegment(ox, oy, dx, dy, sx1, sy1, sx2, sy2, maxT) {
    const ex = sx2 - sx1;
    const ey = sy2 - sy1;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-10) return -1;

    const qx = sx1 - ox;
    const qy = sy1 - oy;
    const t = (qx * ey - qy * ex) / denom;
    if (t < 0 || t > maxT) return -1;

    const u = (qx * dy - qy * dx) / denom;
    if (u < 0 || u > 1) return -1;
    return t;
  }

  /**
   * Exact continuous ray vs capsule (line segment inflated by radius r).
   * Supports optional oneWay collision (only blocks hits arriving from +normal side).
   */
  function intersectRayCapsule(ox, oy, dx, dy, x1, y1, x2, y2, r, maxT, oneWay) {
    const ux = x2 - x1;
    const uy = y2 - y1;
    const len = Math.hypot(ux, uy);
    if (len < 1e-6) {
      if (oneWay) return null;
      return intersectRayCircle(ox, oy, dx, dy, x1, y1, r, maxT);
    }

    const tx = ux / len;
    const ty = uy / len;
    // Left-hand normal
    const nx = -ty;
    const ny = tx;

    let best = null;
    let bestT = maxT;

    // Signed distance from ray origin to segment line
    const relX = ox - x1;
    const relY = oy - y1;
    const signedDist = relX * nx + relY * ny;
    const along = relX * tx + relY * ty;
    const vn = dx * nx + dy * ny;

    // Handle initial penetration against main body
    if (along >= 0 && along <= len && Math.abs(signedDist) <= r) {
      if (oneWay) {
        if (signedDist >= -r * 0.25 && vn < -1e-9) {
          return { t: 0, nx, ny };
        }
        return null;
      }
      if (signedDist >= 0 && vn < -1e-9) return { t: 0, nx, ny };
      if (signedDist < 0 && vn > 1e-9) return { t: 0, nx: -nx, ny: -ny };
    }

    // Front offset line (+normal)
    if (vn < -1e-9) {
      const tFront = intersectRayLineSegment(
        ox, oy, dx, dy,
        x1 + nx * r, y1 + ny * r,
        x2 + nx * r, y2 + ny * r,
        bestT
      );
      if (tFront >= 0 && tFront <= bestT) {
        bestT = tFront;
        best = { t: tFront, nx, ny };
      }
    }

    if (!oneWay) {
      // Back offset line (-normal)
      if (vn > 1e-9) {
        const tBack = intersectRayLineSegment(
          ox, oy, dx, dy,
          x1 - nx * r, y1 - ny * r,
          x2 - nx * r, y2 - ny * r,
          bestT
        );
        if (tBack >= 0 && tBack <= bestT) {
          bestT = tBack;
          best = { t: tBack, nx: -nx, ny: -ny };
        }
      }

      // Endcap circles
      const hitA = intersectRayCircle(ox, oy, dx, dy, x1, y1, r, bestT);
      if (hitA && hitA.t <= bestT) {
        bestT = hitA.t;
        best = hitA;
      }
      const hitB = intersectRayCircle(ox, oy, dx, dy, x2, y2, r, bestT);
      if (hitB && hitB.t <= bestT) {
        bestT = hitB.t;
        best = hitB;
      }
    }

    return best;
  }

  /**
   * Solve a*t^3 + b*t^2 + c*t + d = 0 for all real roots (sorted ascending).
   */
  function solveCubicReal(a, b, c, d) {
    if (Math.abs(a) < 1e-14) {
      // Quadratic b*t^2 + c*t + d = 0
      if (Math.abs(b) < 1e-14) {
        if (Math.abs(c) < 1e-14) return [];
        return [-d / c];
      }
      const disc = c * c - 4 * b * d;
      if (disc < 0) return [];
      if (disc === 0) return [-c / (2 * b)];
      const s = Math.sqrt(disc);
      const r1 = (-c - s) / (2 * b);
      const r2 = (-c + s) / (2 * b);
      return r1 < r2 ? [r1, r2] : [r2, r1];
    }

    // Normalize to monic t^3 + A*t^2 + B*t + C = 0
    const A = b / a;
    const B = c / a;
    const C = d / a;

    // Depress: t = y - A/3 -> y^3 + p*y + q = 0
    const A3 = A / 3;
    const p = B - A * A3;
    const q = 2 * A3 * A3 * A3 - A3 * B + C;
    const halfQ = q * 0.5;
    const thirdP = p / 3;
    const disc = halfQ * halfQ + thirdP * thirdP * thirdP;

    let roots;
    if (disc > 1e-14) {
      const s = Math.sqrt(disc);
      const u = Math.cbrt(-halfQ + s);
      const v = Math.cbrt(-halfQ - s);
      roots = [u + v - A3];
    } else if (disc < -1e-14) {
      // Three distinct real roots (Vieta trigonometric)
      const r = Math.sqrt(Math.max(0, -thirdP));
      const cosVal = clamp(-halfQ / (r * r * r || 1), -1, 1);
      const phi = Math.acos(cosVal);
      const twoR = 2 * r;
      roots = [
        twoR * Math.cos(phi / 3) - A3,
        twoR * Math.cos((phi + 2 * Math.PI) / 3) - A3,
        twoR * Math.cos((phi + 4 * Math.PI) / 3) - A3
      ];
    } else {
      // Multiple real root
      const u = Math.cbrt(-halfQ);
      roots = [2 * u - A3, -u - A3];
    }

    // 2 Newton polish steps on original cubic
    for (let i = 0; i < roots.length; i++) {
      let t = roots[i];
      for (let it = 0; it < 2; it++) {
        const fv = ((a * t + b) * t + c) * t + d;
        const df = (3 * a * t + 2 * b) * t + c;
        if (Math.abs(df) > 1e-14) t -= fv / df;
      }
      roots[i] = t;
    }

    roots.sort((u, v) => u - v);
    return roots;
  }

  /**
   * Exact analytical ballistic parabola vs circle intersection for t in [0, maxT].
   * Trajectory: x(t) = x0 + vx*t, y(t) = y0 + vy*t + 0.5*g*t^2.
   * Provably isolates every real root via exact cubic critical-point bracketing + Newton-Bisection (<1e-13).
   */
  function intersectParabolaCircle(x0, y0, vx, vy, g, cx, cy, R, maxT) {
    if (Math.abs(g) < 1e-9) {
      const hit = intersectRayCircle(x0, y0, vx * maxT, vy * maxT, cx, cy, R, 1.0);
      return hit ? { t: hit.t * maxT, nx: hit.nx, ny: hit.ny } : null;
    }

    // Quick AABB reject for parabola on [0, maxT]
    const xEnd = x0 + vx * maxT;
    if (Math.max(x0, xEnd) + R < cx || Math.min(x0, xEnd) - R > cx) return null;

    const yEnd = y0 + vy * maxT + 0.5 * g * maxT * maxT;
    let yMin = Math.min(y0, yEnd);
    let yMax = Math.max(y0, yEnd);
    const tApex = -vy / g;
    if (tApex > 0 && tApex < maxT) {
      const yApex = y0 + vy * tApex + 0.5 * g * tApex * tApex;
      if (yApex < yMin) yMin = yApex;
      if (yApex > yMax) yMax = yApex;
    }
    if (yMax + R < cy || yMin - R > cy) return null;

    const px = x0 - cx;
    const py = y0 - cy;
    const ay = 0.5 * g;

    // f(t) = c4*t^4 + c3*t^3 + c2*t^2 + c1*t + c0 = |P(t) - C|^2 - R^2
    const c4 = ay * ay;
    const c3 = 2 * ay * vy;
    const c2 = vx * vx + vy * vy + 2 * ay * py;
    const c1 = 2 * (px * vx + py * vy);
    const c0 = px * px + py * py - R * R;

    const evalF = (t) => (((c4 * t + c3) * t + c2) * t + c1) * t + c0;
    const evalDF = (t) => ((4 * c4 * t + 3 * c3) * t + 2 * c2) * t + c1;

    // Immediate inward penetration at t = 0
    if (c0 <= 0) {
      if (c1 < -1e-7) {
        const len = Math.hypot(px, py) || 1;
        return { t: 0, nx: px / len, ny: py / len };
      }
    }

    const tStart = c0 <= 1e-6 ? 1e-5 : 0;
    if (tStart >= maxT) return null;

    // Monotone intervals bounded by real roots of f'(t) = 0
    const crits = solveCubicReal(4 * c4, 3 * c3, 2 * c2, c1);
    const pts = [tStart];
    for (let i = 0; i < crits.length; i++) {
      if (crits[i] > tStart && crits[i] < maxT) pts.push(crits[i]);
    }
    pts.push(maxT);

    for (let i = 0; i < pts.length - 1; i++) {
      let a = pts[i];
      let b = pts[i + 1];
      let fa = evalF(a);
      let fb = evalF(b);

      // Looking for downward entry crossing: fa > 0 and fb <= 0
      if (fa > 0 && fb <= 0) {
        // Safeguarded Newton-Bisection to machine precision
        let t = (a + b) * 0.5;
        for (let iter = 0; iter < 28; iter++) {
          const ft = evalF(t);
          if (Math.abs(ft) < 1e-11 || (b - a) < 1e-13) break;
          if (ft > 0) {
            a = t;
            fa = ft;
          } else {
            b = t;
            fb = ft;
          }
          const df = evalDF(t);
          let nextT = Math.abs(df) > 1e-12 ? t - ft / df : (a + b) * 0.5;
          if (nextT <= a || nextT >= b) nextT = (a + b) * 0.5;
          t = nextT;
        }
        const hx = x0 + vx * t - cx;
        const hy = y0 + vy * t + ay * t * t - cy;
        const len = Math.hypot(hx, hy) || 1;
        const nx = hx / len;
        const ny = hy / len;
        const vtx = vx;
        const vty = vy + g * t;
        if (vtx * nx + vty * ny < 0) {
          return { t, nx, ny };
        }
      }
    }

    return null;
  }

  /**
   * Exact analytical ballistic parabola vs capsule (line segment inflated by R) intersection.
   */
  function intersectParabolaCapsule(x0, y0, vx, vy, g, x1, y1, x2, y2, R, maxT, oneWay) {
    if (Math.abs(g) < 1e-9) {
      const hit = intersectRayCapsule(x0, y0, vx * maxT, vy * maxT, x1, y1, x2, y2, R, 1.0, oneWay);
      return hit ? { t: hit.t * maxT, nx: hit.nx, ny: hit.ny } : null;
    }

    const ux = x2 - x1;
    const uy = y2 - y1;
    const len = Math.hypot(ux, uy);
    if (len < 1e-6) {
      if (oneWay) return null;
      return intersectParabolaCircle(x0, y0, vx, vy, g, x1, y1, R, maxT);
    }

    const tx = ux / len;
    const ty = uy / len;
    const nx = -ty;
    const ny = tx;
    const ay = 0.5 * g;

    let bestT = maxT;
    let bestHit = null;

    // Test signed-distance plane (P(t) - A) . n = side * R
    const testPlane = (side) => {
      const snx = nx * side;
      const sny = ny * side;
      // Solve (ay * sny) t^2 + (vx * snx + vy * sny) t + ((x0-x1)*snx + (y0-y1)*sny - R) = 0
      const qa = ay * sny;
      const qb = vx * snx + vy * sny;
      const qc = (x0 - x1) * snx + (y0 - y1) * sny - R;

      // Immediate penetration check
      if (qc <= 0 && qc >= -R * 1.2 && qb < -1e-7) {
        const along0 = (x0 - x1) * tx + (y0 - y1) * ty;
        if (along0 >= 0 && along0 <= len) {
          if (!oneWay || qc >= -R * 0.35) {
            bestT = 0;
            bestHit = { t: 0, nx: snx, ny: sny };
            return;
          }
        }
      }

      const roots = [];
      if (Math.abs(qa) < 1e-12) {
        if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
      } else {
        const disc = qb * qb - 4 * qa * qc;
        if (disc >= 0) {
          const s = Math.sqrt(disc);
          roots.push((-qb - s) / (2 * qa), (-qb + s) / (2 * qa));
        }
      }

      for (let i = 0; i < roots.length; i++) {
        const t = roots[i];
        if (t < 1e-7 || t > bestT) continue;
        // Must be approaching plane (v(t) . sn < 0)
        const vDotN = vx * snx + (vy + g * t) * sny;
        if (vDotN >= -1e-7) continue;

        const hx = x0 + vx * t;
        const hy = y0 + vy * t + ay * t * t;
        const along = (hx - x1) * tx + (hy - y1) * ty;
        if (along >= 0 && along <= len) {
          bestT = t;
          bestHit = { t, nx: snx, ny: sny };
        }
      }
    };

    testPlane(1);
    if (!oneWay) {
      testPlane(-1);
      const hitA = intersectParabolaCircle(x0, y0, vx, vy, g, x1, y1, R, bestT);
      if (hitA && hitA.t <= bestT) {
        bestT = hitA.t;
        bestHit = hitA;
      }
      const hitB = intersectParabolaCircle(x0, y0, vx, vy, g, x2, y2, R, bestT);
      if (hitB && hitB.t <= bestT) {
        bestT = hitB.t;
        bestHit = hitB;
      }
    }

    return bestHit;
  }

  /**
   * Compute Kolmogorov-Smirnov (max CCDF gap) and relative mean drift between full sample
   * and even-indexed half-sample to quantify numerical convergence without extra ray traces.
   */
  function computeConvergence(values, slots, weights, binSpec, slotCount, quota) {
    const n = values.length;
    if (n < 8) return { ks: 1, meanRelDiff: 1, quotaDiff: 1, grade: 'low' };

    const full = analyzeDistribution(values, slots, weights, binSpec, slotCount, quota);
    const halfLen = Math.ceil(n / 2);
    const hVals = new Float64Array(halfLen);
    const hSlots = new Int32Array(halfLen);
    const hWeights = new Float64Array(halfLen);
    let wSum = 0;
    for (let i = 0, k = 0; i < n; i += 2, k++) {
      hVals[k] = values[i];
      hSlots[k] = slots[i];
      hWeights[k] = weights[i];
      wSum += weights[i];
    }
    if (wSum > 0) {
      for (let k = 0; k < halfLen; k++) hWeights[k] /= wSum;
    }

    const half = analyzeDistribution(hVals, hSlots, hWeights, binSpec, slotCount, quota);

    let ks = 0;
    for (let b = 0; b < binSpec.binCount; b++) {
      const d = Math.abs(full.ccdf[b] - half.ccdf[b]);
      if (d > ks) ks = d;
    }
    const meanRelDiff = Math.abs(full.mean - half.mean) / Math.max(1, Math.abs(full.mean));
    const quotaDiff = Math.abs(full.quotaProb - half.quotaProb);

    let grade = 'converged';
    if (ks >= 0.10) grade = 'chaotic';
    else if (ks >= 0.035) grade = 'moderate';

    return { ks, meanRelDiff, quotaDiff, grade };
  }

  /**
   * Exact Gaussian elimination with partial pivoting solving A * X = B
   * where A is n x n (flat Float64Array row-major) and B is n x m (flat Float64Array row-major).
   * Returns { ok, X } (X is n x m flat Float64Array).
   */
  function solveLinearSystem(A, B, n, m) {
    const M = new Float64Array(A);
    const X = new Float64Array(B);

    for (let col = 0; col < n; col++) {
      // Partial pivot
      let pivotRow = col;
      let maxAbs = Math.abs(M[col * n + col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(M[r * n + col]);
        if (v > maxAbs) {
          maxAbs = v;
          pivotRow = r;
        }
      }
      if (maxAbs < 1e-12) {
        return { ok: false, X: null };
      }
      if (pivotRow !== col) {
        for (let c = col; c < n; c++) {
          const tmp = M[col * n + c];
          M[col * n + c] = M[pivotRow * n + c];
          M[pivotRow * n + c] = tmp;
        }
        for (let c = 0; c < m; c++) {
          const tmp = X[col * m + c];
          X[col * m + c] = X[pivotRow * m + c];
          X[pivotRow * m + c] = tmp;
        }
      }

      const piv = M[col * n + col];
      for (let r = col + 1; r < n; r++) {
        const factor = M[r * n + col] / piv;
        if (factor === 0) continue;
        M[r * n + col] = 0;
        for (let c = col + 1; c < n; c++) {
          M[r * n + c] -= factor * M[col * n + c];
        }
        for (let c = 0; c < m; c++) {
          X[r * m + c] -= factor * X[col * m + c];
        }
      }
    }

    // Back-substitution
    for (let r = n - 1; r >= 0; r--) {
      const diag = M[r * n + r];
      for (let c = 0; c < m; c++) {
        let sum = X[r * m + c];
        for (let k = r + 1; k < n; k++) {
          sum -= M[r * n + k] * X[k * m + c];
        }
        X[r * m + c] = sum / diag;
      }
    }

    return { ok: true, X };
  }

  /**
   * Build normalized Gaussian weights over K uniform samples u_i in [0, 1].
   */
  function gaussianWeights(count, meanU, sigmaU) {
    const weights = new Float64Array(count);
    if (count === 0) return weights;
    if (sigmaU >= 0.99) {
      weights.fill(1 / count);
      return weights;
    }
    const sig = Math.max(0.004, sigmaU);
    const invTwoSigSq = 1 / (2 * sig * sig);
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const u = count === 1 ? 0.5 : i / (count - 1);
      const d = u - meanU;
      const w = Math.exp(-d * d * invTwoSigSq);
      weights[i] = w;
      sum += w;
    }
    if (sum > 0) {
      for (let i = 0; i < count; i++) weights[i] /= sum;
    } else {
      weights.fill(1 / count);
    }
    return weights;
  }

  /**
   * Find optimal aim target mu in [0, 1] maximizing either expected score or quota pass rate
   * for a given aim precision sigmaU.
   */
  function findOptimalTarget(values, sigmaU, mode, quota) {
    const n = values.length;
    if (n === 0) return 0.5;
    let bestU = 0.5;
    let bestMetric = -Infinity;

    // Evaluate at every ray sample point for deterministic precision
    const sig = Math.max(0.004, sigmaU);
    const invTwoSigSq = 1 / (2 * sig * sig);
    const radiusIdx = Math.min(n, Math.ceil(sig * 4 * n) + 2);

    for (let c = 0; c < n; c++) {
      const uc = n === 1 ? 0.5 : c / (n - 1);
      const lo = Math.max(0, c - radiusIdx);
      const hi = Math.min(n - 1, c + radiusIdx);
      let wSum = 0;
      let acc = 0;
      let tieAcc = 0;
      for (let i = lo; i <= hi; i++) {
        const ui = n === 1 ? 0.5 : i / (n - 1);
        const d = ui - uc;
        const w = Math.exp(-d * d * invTwoSigSq);
        wSum += w;
        if (mode === 'quota') {
          acc += w * (values[i] >= quota ? 1 : 0);
          tieAcc += w * values[i];
        } else {
          acc += w * values[i];
        }
      }
      if (wSum <= 0) continue;
      const metric = mode === 'quota' ? (acc / wSum) + (tieAcc / wSum) * 1e-7 : (acc / wSum);
      if (metric > bestMetric) {
        bestMetric = metric;
        bestU = uc;
      }
    }
    return bestU;
  }

  /**
   * Compute shared histogram bin edges (linear or log-spaced) spanning all compared distributions.
   */
  function computeBinSpec(allValues, binCount, logScale) {
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < allValues.length; i++) {
      const v = allValues[i];
      if (!Number.isFinite(v)) continue;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!Number.isFinite(minV)) {
      minV = 0;
      maxV = 10;
    }
    if (maxV <= minV) {
      maxV = minV + 1;
    }

    if (logScale) {
      const edges = new Float64Array(binCount + 1);
      // Shift by offset if values <= 0 so log1p scaling stays smooth and strictly increasing
      const offset = minV < 0 ? -minV + 1 : 1;
      const loL = Math.log10(minV + offset);
      const hiL = Math.log10(maxV + offset);
      for (let i = 0; i <= binCount; i++) {
        const t = i / binCount;
        edges[i] = Math.pow(10, loL + (hiL - loL) * t) - offset;
      }
      return { minV, maxV, binCount, logScale: true, offset, edges };
    }

    // Choose a clean discrete-aligned bin step to avoid comb-aliasing on integer/multiple-of-5 scores
    const span = maxV - minV;
    const rawStep = span / Math.max(8, binCount);
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, rawStep))));
    const norm = rawStep / mag;
    let niceMult;
    if (norm <= 1.0) niceMult = 1;
    else if (norm <= 2.0) niceMult = 2;
    else if (norm <= 2.5) niceMult = 2.5;
    else if (norm <= 5.0) niceMult = 5;
    else niceMult = 10;
    const step = niceMult * mag;

    const alignedMin = Math.floor(minV / step) * step;
    const alignedMax = Math.max(alignedMin + step, Math.ceil((maxV + step * 1e-4) / step) * step);
    const actualBins = clamp(Math.round((alignedMax - alignedMin) / step), 4, 40);
    const actualStep = (alignedMax - alignedMin) / actualBins;

    const edges = new Float64Array(actualBins + 1);
    for (let i = 0; i <= actualBins; i++) {
      edges[i] = alignedMin + actualStep * i;
    }
    return {
      minV: alignedMin,
      maxV: alignedMax,
      binCount: actualBins,
      logScale: false,
      offset: 0,
      edges
    };
  }

  function findBinIndex(val, spec) {
    const n = spec.binCount;
    if (val <= spec.edges[0]) return 0;
    if (val >= spec.edges[n]) return n - 1;
    if (!spec.logScale) {
      const idx = Math.floor(((val - spec.minV) / (spec.maxV - spec.minV)) * n);
      return clamp(idx, 0, n - 1);
    }
    // Binary search on log edges
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (val < spec.edges[mid]) {
        hi = mid - 1;
      } else if (val >= spec.edges[mid + 1]) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return clamp(lo, 0, n - 1);
  }

  /**
   * Compute full exact summary statistics, PMF, CCDF, slot PMF, entropy, and quota pass rate.
   */
  function analyzeDistribution(values, slots, weights, binSpec, slotCount, quota) {
    const n = values.length;
    const pmf = new Float64Array(binSpec.binCount);
    const binMembers = Array.from({ length: binSpec.binCount }, () => []);
    const slotPmf = new Float64Array(slotCount);

    if (n === 0) {
      return {
        mean: 0, median: 0, p10: 0, p90: 0, p99: 0,
        std: 0, skewness: 0, entropyBits: 0, entropyNorm: 0,
        tailRatio: 1, quotaProb: 0,
        pmf, ccdf: new Float64Array(binSpec.binCount), binMembers, slotPmf
      };
    }

    let mean = 0;
    let quotaProb = 0;
    const pairs = new Array(n);

    for (let i = 0; i < n; i++) {
      const v = values[i];
      const w = weights[i];
      mean += w * v;
      if (v >= quota) quotaProb += w;
      pairs[i] = { v, w };

      const b = findBinIndex(v, binSpec);
      pmf[b] += w;
      binMembers[b].push(i);

      const s = slots[i];
      if (s >= 0 && s < slotCount) {
        slotPmf[s] += w;
      }
    }

    // Variance & Skewness
    let m2 = 0;
    let m3 = 0;
    for (let i = 0; i < n; i++) {
      const d = values[i] - mean;
      const w = weights[i];
      const d2 = d * d;
      m2 += w * d2;
      m3 += w * d2 * d;
    }
    const std = Math.sqrt(Math.max(0, m2));
    const skewness = std > 1e-7 ? m3 / (std * std * std) : 0;

    // Exact weighted quantiles
    pairs.sort((a, b) => a.v - b.v);
    function quantile(q) {
      let acc = 0;
      for (let i = 0; i < pairs.length; i++) {
        acc += pairs[i].w;
        if (acc >= q - 1e-12) return pairs[i].v;
      }
      return pairs[pairs.length - 1].v;
    }
    const p10 = quantile(0.10);
    const median = quantile(0.50);
    const p90 = quantile(0.90);
    const p99 = quantile(0.99);

    // CCDF ("At Least" P(X >= bin left edge))
    const ccdf = new Float64Array(binSpec.binCount);
    let tailAcc = 0;
    for (let b = binSpec.binCount - 1; b >= 0; b--) {
      tailAcc += pmf[b];
      ccdf[b] = clamp(tailAcc, 0, 1);
    }

    // Shannon Entropy over bins (and slot entropy)
    let entropyBits = 0;
    for (let b = 0; b < binSpec.binCount; b++) {
      const p = pmf[b];
      if (p > 1e-12) entropyBits -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(Math.max(2, binSpec.binCount));
    const entropyNorm = clamp(entropyBits / maxEntropy, 0, 1);

    const denom = Math.max(1, Math.abs(median));
    const tailRatio = p99 / denom;

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
      tailRatio,
      quotaProb,
      pmf,
      ccdf,
      binMembers,
      slotPmf
    };
  }

  /**
   * Compute Mutual Information I(AimRegion; OutcomeBin) in bits.
   * Quantifies how much of the outcome's entropy is controllable by a player
   * whose aiming resolution is ~sigmaTrained.
   */
  function computeSkillMutualInfo(values, binSpec, sigmaTrained) {
    const n = values.length;
    if (n < 4) return 0;

    const groups = clamp(Math.round(1 / Math.max(0.04, sigmaTrained * 2.5)), 4, 24);
    const bins = binSpec.binCount;
    const joint = new Float64Array(groups * bins);
    const pG = new Float64Array(groups);
    const pB = new Float64Array(bins);
    const invN = 1 / n;

    for (let i = 0; i < n; i++) {
      const g = Math.min(groups - 1, Math.floor((i / n) * groups));
      const b = findBinIndex(values[i], binSpec);
      joint[g * bins + b] += invN;
      pG[g] += invN;
      pB[b] += invN;
    }

    let mi = 0;
    for (let g = 0; g < groups; g++) {
      if (pG[g] <= 1e-12) continue;
      for (let b = 0; b < bins; b++) {
        const pgb = joint[g * bins + b];
        if (pgb > 1e-12 && pB[b] > 1e-12) {
          mi += pgb * Math.log2(pgb / (pG[g] * pB[b]));
        }
      }
    }
    return Math.max(0, mi);
  }

  function formatNumber(n) {
    if (!Number.isFinite(n)) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'k';
    if (abs >= 100) return n.toFixed(0);
    if (abs >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  RP.Math = {
    EPS,
    clamp,
    lerp,
    distSq,
    distToSegmentSq,
    rotateVec,
    intersectRayCircle,
    intersectRayLineSegment,
    intersectRayCapsule,
    solveCubicReal,
    intersectParabolaCircle,
    intersectParabolaCapsule,
    gaussianWeights,
    findOptimalTarget,
    computeBinSpec,
    findBinIndex,
    analyzeDistribution,
    computeSkillMutualInfo,
    computeConvergence,
    solveLinearSystem,
    formatNumber
  };
})();
