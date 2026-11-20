(() => {
  'use strict';

  const RP = (window.RayPachinko = window.RayPachinko || {});

  const CELL_SIZE = 48;
  const MAX_BALLS_PER_SHOT = 8;
  const MAX_SPLIT_DEPTH = 3;
  const MAX_REPLAYS_PER_SHOT = 2;

  /**
   * Compute dynamic board metrics & chamber boundary walls from settings.
   */
  function getBoardMetrics(settings) {
    const M = RP.Math;
    const W = M.clamp(Math.round((settings && settings.boardWidth) || 540), 340, 860);
    const H = M.clamp(Math.round((settings && settings.boardHeight) || 720), 440, 1080);
    const left = 22;
    const right = W - 22;
    const top = 22;
    const floorY = H - 52;
    const launchY = 46;
    const cannonX = W * 0.5;
    const cannonY = 46;
    const shape = (settings && settings.chamberShape) || 'rect';

    const chamberWalls = [];
    const pushWall = (x1, y1, x2, y2) => {
      chamberWalls.push({
        id: `_chamber_${chamberWalls.length}`,
        name: 'Chamber Wall',
        shape: 'segment',
        kind: 'chamber',
        isChamberWall: true,
        layerGroup: 'chamber',
        enabled: true,
        x1, y1, x2, y2,
        thickness: 4,
        restitution: 0.86,
        kickSpeed: 0,
        biasAngle: 0,
        tangentialBoost: 0,
        scoreAdd: 0,
        scoreMult: 1,
        splitCount: 1,
        maxHitsPerShot: 0,
        oneWay: false
      });
    };

    const innerW = right - left;
    const innerH = floorY - top;

    if (shape === 'arch') {
      // Smooth curved pachinko dome across top-left and top-right corners
      const rx = innerW * 0.22;
      const ry = Math.min(125, innerH * 0.18);
      const steps = 5;
      // Left arch from (left, top + ry) to (left + rx, top)
      for (let i = 0; i < steps; i++) {
        const a0 = Math.PI + (i / steps) * (Math.PI * 0.5);
        const a1 = Math.PI + ((i + 1) / steps) * (Math.PI * 0.5);
        pushWall(
          left + rx + Math.cos(a0) * rx,
          top + ry + Math.sin(a0) * ry,
          left + rx + Math.cos(a1) * rx,
          top + ry + Math.sin(a1) * ry
        );
      }
      // Right arch from (right - rx, top) to (right, top + ry)
      for (let i = 0; i < steps; i++) {
        const a0 = -Math.PI * 0.5 + (i / steps) * (Math.PI * 0.5);
        const a1 = -Math.PI * 0.5 + ((i + 1) / steps) * (Math.PI * 0.5);
        pushWall(
          right - rx + Math.cos(a0) * rx,
          top + ry + Math.sin(a0) * ry,
          right - rx + Math.cos(a1) * rx,
          top + ry + Math.sin(a1) * ry
        );
      }
    } else if (shape === 'funnel') {
      // Lower pinball gutter taper walls
      const insetX = innerW * 0.12;
      const startY = floorY - Math.min(185, innerH * 0.29);
      pushWall(left, startY, left + insetX, floorY - 6);
      pushWall(right, startY, right - insetX, floorY - 6);
    } else if (shape === 'diamond') {
      // Upper beveled shoulders + lower funnel bevels
      const topBevX = innerW * 0.17;
      const topBevY = Math.min(110, innerH * 0.16);
      const botBevX = innerW * 0.12;
      const botBevY = Math.min(130, innerH * 0.20);
      pushWall(left, top + topBevY, left + topBevX, top);
      pushWall(right - topBevX, top, right, top + topBevY);
      pushWall(left, floorY - botBevY, left + botBevX, floorY - 6);
      pushWall(right, floorY - botBevY, right - botBevX, floorY - 6);
    }

    return {
      W,
      H,
      left,
      right,
      top,
      floorY,
      launchY,
      cannonX,
      cannonY,
      shape,
      chamberWalls
    };
  }

  /**
   * Compute moving bonus bucket center X at simulation time t.
   */
  function getBucketX(t, settings, metrics) {
    const bw = settings.bucketWidth || 82;
    const minX = metrics.left + bw * 0.5 + 8;
    const maxX = metrics.right - bw * 0.5 - 8;
    const span = Math.max(10, maxX - minX);
    const speed = Math.max(20, settings.bucketSpeed || 150);
    const phase = ((settings.startPhaseDeg || 0) * Math.PI) / 180;
    const omega = (speed / (span * 0.5));
    return (minX + maxX) * 0.5 + Math.sin(omega * t + phase) * (span * 0.5);
  }

  function isDynamicObject(obj) {
    return Boolean(
      (obj.angularSpeedDeg && Math.abs(obj.angularSpeedDeg) > 1e-4) ||
      (obj.oscAmpX && Math.abs(obj.oscAmpX) > 1e-4) ||
      (obj.oscAmpY && Math.abs(obj.oscAmpY) > 1e-4)
    );
  }

  /**
   * Evaluate live geometry + linear/angular surface velocity of an object at simulation time t.
   */
  function evaluateObjectPose(obj, t, phaseRad) {
    let ox = 0;
    let oy = 0;
    let vx = 0;
    let vy = 0;

    if ((obj.oscAmpX || obj.oscAmpY) && (obj.oscFreq || 0) > 0) {
      const w = 2 * Math.PI * (obj.oscFreq || 0.7);
      const s = Math.sin(w * t + phaseRad);
      const c = Math.cos(w * t + phaseRad);
      ox = (obj.oscAmpX || 0) * s;
      oy = (obj.oscAmpY || 0) * s;
      vx = (obj.oscAmpX || 0) * w * c;
      vy = (obj.oscAmpY || 0) * w * c;
    }

    if (obj.shape === 'segment') {
      const mx = (obj.x1 + obj.x2) * 0.5 + ox;
      const my = (obj.y1 + obj.y2) * 0.5 + oy;
      const angSpeedRad = ((obj.angularSpeedDeg || 0) * Math.PI) / 180;
      if (Math.abs(angSpeedRad) > 1e-5) {
        const theta = angSpeedRad * t + phaseRad;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const hx = (obj.x2 - obj.x1) * 0.5;
        const hy = (obj.y2 - obj.y1) * 0.5;
        const rx = hx * cos - hy * sin;
        const ry = hx * sin + hy * cos;
        return {
          x1: mx - rx,
          y1: my - ry,
          x2: mx + rx,
          y2: my + ry,
          mx,
          my,
          vx,
          vy,
          omega: angSpeedRad
        };
      }
      return {
        x1: obj.x1 + ox,
        y1: obj.y1 + oy,
        x2: obj.x2 + ox,
        y2: obj.y2 + oy,
        mx,
        my,
        vx,
        vy,
        omega: 0
      };
    }

    return {
      x: obj.x + ox,
      y: obj.y + oy,
      vx,
      vy,
      omega: 0
    };
  }

  function buildSpatialGrid(objects, ballRadius, metrics) {
    const gridCols = Math.ceil(metrics.W / CELL_SIZE);
    const gridRows = Math.ceil(metrics.H / CELL_SIZE);
    const cells = new Array(gridCols * gridRows);
    for (let i = 0; i < cells.length; i++) cells[i] = [];

    const collidables = [];
    const zones = [];
    let hasDynamic = false;

    const allObjs = [...metrics.chamberWalls, ...objects];

    for (let i = 0; i < allObjs.length; i++) {
      const obj = allObjs[i];
      if (obj.enabled === false) continue;

      if (obj.shape === 'zone') {
        zones.push(obj);
        continue;
      }

      const dyn = isDynamicObject(obj);
      if (dyn) hasDynamic = true;

      const idx = collidables.length;
      const entry = {
        idx,
        obj,
        dyn,
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0
      };

      const pad = ballRadius + 4 + Math.abs(obj.oscAmpX || 0) + Math.abs(obj.oscAmpY || 0);
      if (obj.shape === 'circle' || obj.shape === 'portal') {
        const r = (obj.radius || 10) + pad;
        entry.minX = obj.x - r;
        entry.maxX = obj.x + r;
        entry.minY = obj.y - r;
        entry.maxY = obj.y + r;
      } else if (obj.shape === 'segment') {
        if (obj.angularSpeedDeg && Math.abs(obj.angularSpeedDeg) > 1e-4) {
          const mx = (obj.x1 + obj.x2) * 0.5;
          const my = (obj.y1 + obj.y2) * 0.5;
          const half = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) * 0.5 + pad;
          entry.minX = mx - half;
          entry.maxX = mx + half;
          entry.minY = my - half;
          entry.maxY = my + half;
        } else {
          entry.minX = Math.min(obj.x1, obj.x2) - pad;
          entry.maxX = Math.max(obj.x1, obj.x2) + pad;
          entry.minY = Math.min(obj.y1, obj.y2) - pad;
          entry.maxY = Math.max(obj.y1, obj.y2) + pad;
        }
      }

      collidables.push(entry);

      const c0 = Math.max(0, Math.floor(entry.minX / CELL_SIZE));
      const c1 = Math.min(gridCols - 1, Math.floor(entry.maxX / CELL_SIZE));
      const r0 = Math.max(0, Math.floor(entry.minY / CELL_SIZE));
      const r1 = Math.min(gridRows - 1, Math.floor(entry.maxY / CELL_SIZE));

      for (let gy = r0; gy <= r1; gy++) {
        for (let gx = c0; gx <= c1; gx++) {
          cells[gy * gridCols + gx].push(entry);
        }
      }
    }

    return { cells, gridCols, gridRows, collidables, zones, hasDynamic };
  }

  /**
   * Compute initial launch position and velocity for normalized input u in [0, 1].
   */
  function getLaunchState(u, settings) {
    const metrics = getBoardMetrics(settings);
    const speed = settings.launchSpeed;
    if (settings.launcherMode === 'cannon') {
      const minDeg = 16;
      const maxDeg = 164;
      const deg = minDeg + (maxDeg - minDeg) * u;
      const rad = (deg * Math.PI) / 180;
      return {
        x: metrics.cannonX,
        y: metrics.cannonY,
        vx: Math.cos(rad) * speed,
        vy: Math.sin(rad) * speed,
        angleDeg: deg
      };
    }

    // Drop rail mode: keep drops inside arch/diamond top opening
    const extraMargin = metrics.shape === 'arch'
      ? (metrics.right - metrics.left) * 0.14
      : metrics.shape === 'diamond'
        ? (metrics.right - metrics.left) * 0.12
        : 0;
    const margin = settings.ballRadius + 16 + extraMargin;
    const x = metrics.left + margin + Math.max(20, metrics.right - metrics.left - margin * 2) * u;
    const vy = settings.gravity <= 1 ? Math.max(180, speed) : speed * 0.28;
    return {
      x,
      y: metrics.launchY,
      vx: 0,
      vy,
      angleDeg: 90
    };
  }

  function findEarliestHit(
    ox, oy, dx, dy, maxT,
    ballRadius, metrics, grid, hitCounts,
    useGrid, stampArr, stampVal, ignoreObjIdx, simTime, phaseRad
  ) {
    const M = RP.Math;
    let bestT = maxT;
    let bestHit = null;

    const minX = metrics.left + ballRadius;
    const maxX = metrics.right - ballRadius;
    const minY = metrics.top + ballRadius;
    const maxY = metrics.floorY - ballRadius;

    if (dx < -1e-9) {
      const t = (minX - ox) / dx;
      if (t >= 0 && t <= bestT) {
        bestT = t;
        bestHit = { kind: 'wall', t, nx: 1, ny: 0, svx: 0, svy: 0 };
      }
    } else if (dx > 1e-9) {
      const t = (maxX - ox) / dx;
      if (t >= 0 && t <= bestT) {
        bestT = t;
        bestHit = { kind: 'wall', t, nx: -1, ny: 0, svx: 0, svy: 0 };
      }
    }

    if (dy < -1e-9) {
      const t = (minY - oy) / dy;
      if (t >= 0 && t <= bestT) {
        bestT = t;
        bestHit = { kind: 'wall', t, nx: 0, ny: 1, svx: 0, svy: 0 };
      }
    } else if (dy > 1e-9) {
      const t = (maxY - oy) / dy;
      if (t >= 0 && t <= bestT) {
        bestT = t;
        bestHit = { kind: 'floor', t, nx: 0, ny: -1, svx: 0, svy: 0 };
      }
    }

    const testEntry = (entry) => {
      const obj = entry.obj;
      if (entry.idx === ignoreObjIdx) return;
      if (obj.maxHitsPerShot > 0 && hitCounts[entry.idx] >= obj.maxHitsPerShot) return;

      const xLo = dx >= 0 ? ox : ox + dx * bestT;
      const xHi = dx >= 0 ? ox + dx * bestT : ox;
      if (xHi < entry.minX || xLo > entry.maxX) return;

      const yLo = dy >= 0 ? oy : oy + dy * bestT;
      const yHi = dy >= 0 ? oy + dy * bestT : oy;
      if (yHi < entry.minY || yLo > entry.maxY) return;

      let res = null;
      let svx = 0;
      let svy = 0;

      if (obj.shape === 'circle' || obj.shape === 'portal') {
        const pose = entry.dyn ? evaluateObjectPose(obj, simTime, phaseRad) : obj;
        res = M.intersectRayCircle(ox, oy, dx, dy, pose.x, pose.y, (obj.radius || 10) + ballRadius, bestT);
        if (res && entry.dyn) {
          svx = pose.vx;
          svy = pose.vy;
        }
      } else if (obj.shape === 'segment') {
        const pose = entry.dyn ? evaluateObjectPose(obj, simTime, phaseRad) : obj;
        res = M.intersectRayCapsule(
          ox, oy, dx, dy,
          pose.x1, pose.y1, pose.x2, pose.y2,
          ballRadius + (obj.thickness ? obj.thickness * 0.5 : 2),
          bestT,
          Boolean(obj.oneWay)
        );
        if (res && entry.dyn) {
          const hx = ox + dx * res.t;
          const hy = oy + dy * res.t;
          svx = pose.vx - pose.omega * (hy - pose.my);
          svy = pose.vy + pose.omega * (hx - pose.mx);
        }
      }

      if (res && res.t <= bestT) {
        bestT = res.t;
        bestHit = {
          kind: 'object',
          t: res.t,
          nx: res.nx,
          ny: res.ny,
          svx,
          svy,
          entry
        };
      }
    };

    if (useGrid) {
      const segMinX = Math.min(ox, ox + dx * maxT);
      const segMaxX = Math.max(ox, ox + dx * maxT);
      const segMinY = Math.min(oy, oy + dy * maxT);
      const segMaxY = Math.max(oy, oy + dy * maxT);

      const c0 = Math.max(0, Math.floor(segMinX / CELL_SIZE));
      const c1 = Math.min(grid.gridCols - 1, Math.floor(segMaxX / CELL_SIZE));
      const r0 = Math.max(0, Math.floor(segMinY / CELL_SIZE));
      const r1 = Math.min(grid.gridRows - 1, Math.floor(segMaxY / CELL_SIZE));

      for (let gy = r0; gy <= r1; gy++) {
        const rowOff = gy * grid.gridCols;
        for (let gx = c0; gx <= c1; gx++) {
          const bucket = grid.cells[rowOff + gx];
          for (let k = 0; k < bucket.length; k++) {
            const entry = bucket[k];
            if (stampArr[entry.idx] === stampVal) continue;
            stampArr[entry.idx] = stampVal;
            testEntry(entry);
          }
        }
      }
    } else {
      for (let i = 0; i < grid.collidables.length; i++) {
        testEntry(grid.collidables[i]);
      }
    }

    return bestHit;
  }

  /**
   * Exact analytical parabolic raycast against chamber boundaries and all static collidable objects.
   */
  function findEarliestParabolicHit(
    x0, y0, vx, vy, g, maxT,
    ballRadius, metrics, collidables, hitCounts, ignoreObjIdx
  ) {
    const M = RP.Math;
    const ay = 0.5 * g;
    let bestT = maxT;
    let bestHit = null;

    const minX = metrics.left + ballRadius;
    const maxX = metrics.right - ballRadius;
    const minY = metrics.top + ballRadius;
    const maxY = metrics.floorY - ballRadius;

    if (vx < -1e-9) {
      const t = (minX - x0) / vx;
      if (t > 1e-7 && t <= bestT) {
        bestT = t;
        bestHit = { kind: 'wall', t, nx: 1, ny: 0, svx: 0, svy: 0 };
      }
    } else if (vx > 1e-9) {
      const t = (maxX - x0) / vx;
      if (t > 1e-7 && t <= bestT) {
        bestT = t;
        bestHit = { kind: 'wall', t, nx: -1, ny: 0, svx: 0, svy: 0 };
      }
    }

    const testHoriz = (targetY, kind, ny) => {
      const c = y0 - targetY;
      const disc = vy * vy - 4 * ay * c;
      if (disc < 0) return;
      const s = Math.sqrt(disc);
      const r1 = (-vy - s) / (2 * ay);
      const r2 = (-vy + s) / (2 * ay);
      for (const t of [r1, r2]) {
        if (t > 1e-7 && t <= bestT) {
          const vty = vy + g * t;
          if (vty * ny < -1e-7) {
            bestT = t;
            bestHit = { kind, t, nx: 0, ny, svx: 0, svy: 0 };
          }
        }
      }
    };

    testHoriz(minY, 'wall', 1);
    testHoriz(maxY, 'floor', -1);

    const xEnd = x0 + vx * bestT;
    const xLo = Math.min(x0, xEnd);
    const xHi = Math.max(x0, xEnd);
    const yEnd = y0 + vy * bestT + ay * bestT * bestT;
    let yLo = Math.min(y0, yEnd);
    let yHi = Math.max(y0, yEnd);
    const tApex = -vy / g;
    if (tApex > 0 && tApex < bestT) {
      const yApex = y0 + vy * tApex + ay * tApex * tApex;
      if (yApex < yLo) yLo = yApex;
      if (yApex > yHi) yHi = yApex;
    }

    for (let i = 0; i < collidables.length; i++) {
      const entry = collidables[i];
      if (entry.idx === ignoreObjIdx) continue;
      const obj = entry.obj;
      if (obj.maxHitsPerShot > 0 && hitCounts[entry.idx] >= obj.maxHitsPerShot) continue;
      if (entry.maxX < xLo || entry.minX > xHi || entry.maxY < yLo || entry.minY > yHi) continue;

      let res = null;
      if (obj.shape === 'circle' || obj.shape === 'portal') {
        res = M.intersectParabolaCircle(
          x0, y0, vx, vy, g,
          obj.x, obj.y, (obj.radius || 10) + ballRadius, bestT
        );
      } else if (obj.shape === 'segment') {
        res = M.intersectParabolaCapsule(
          x0, y0, vx, vy, g,
          obj.x1, obj.y1, obj.x2, obj.y2,
          ballRadius + (obj.thickness ? obj.thickness * 0.5 : 2),
          bestT,
          Boolean(obj.oneWay)
        );
      }

      if (res && res.t <= bestT) {
        bestT = res.t;
        bestHit = {
          kind: 'object',
          t: res.t,
          nx: res.nx,
          ny: res.ny,
          svx: 0,
          svy: 0,
          entry
        };
      }
    }

    return bestHit;
  }

  function getSlotSpecs(settings) {
    if (settings.slotSpecs && settings.slotSpecs.length > 0) return settings.slotSpecs;
    return RP.Presets.parseSlotSpecs(settings.slotValues || [10, 20, 35, 55, 80, 100, 80, 55, 35, 20, 10]);
  }

  /**
   * Apply rigid-body bounce + roguelike trigger/synergy/bomb/refresh/splitter logic on object contact.
   */
  function applyObjectHit(
    ball, hit, hx, hy, rayIndex,
    settings, metrics, grid,
    roundState, perShotObjHits,
    spawnBallFn, recordDetails
  ) {
    const M = RP.Math;
    const obj = hit.entry.obj;
    const eIdx = hit.entry.idx;

    ball.bounces++;
    if (!obj.isChamberWall) {
      roundState.hitCounts[eIdx]++;
      roundState.triggerCounters[eIdx]++;
      perShotObjHits.set(obj.id, (perShotObjHits.get(obj.id) || 0) + 1);
    }

    // Trigger counter gating (e.g., every 3rd hit!)
    const trigN = Math.max(1, obj.triggerEveryN || 1);
    const triggersNow = !obj.isChamberWall && (roundState.triggerCounters[eIdx] % trigN === 0);

    const eventParts = [];

    if (triggersNow) {
      const dynamicAdd = (obj.scoreAdd || 0) + roundState.pegBonusAdd[eIdx];
      if (dynamicAdd) {
        ball.basePoints += dynamicAdd;
        eventParts.push((dynamicAdd > 0 ? '+' : '') + Math.round(dynamicAdd));
      }
      if (obj.scoreMult && obj.scoreMult !== 1) {
        ball.mult *= obj.scoreMult;
        eventParts.push(`×${obj.scoreMult}`);
      }

      // Cross-peg Synergy Aura buff!
      if (obj.auraRadius > 0 && obj.auraBuffAdd) {
        const rSq = obj.auraRadius * obj.auraRadius;
        const coll = grid.collidables;
        let buffed = 0;
        for (let k = 0; k < coll.length; k++) {
          if (k === eIdx) continue;
          const other = coll[k].obj;
          if (other.isChamberWall || other.shape !== 'circle') continue;
          if (M.distSq(hx, hy, other.x, other.y) <= rSq) {
            roundState.pegBonusAdd[k] += obj.auraBuffAdd;
            buffed++;
          }
        }
        if (buffed > 0) eventParts.push(`✦+${obj.auraBuffAdd}(${buffed})`);
      }

      // Refresh Peg: restore all popped pegs!
      if (obj.isRefresh) {
        roundState.hitCounts.fill(0);
        eventParts.push('⟳REFRESH');
      }

      // Bomb Peg: pop & score all pegs within blast radius!
      if (obj.isBomb && obj.bombRadius > 0) {
        const bSq = obj.bombRadius * obj.bombRadius;
        const coll = grid.collidables;
        let blastPts = 0;
        let blastCount = 0;
        for (let k = 0; k < coll.length; k++) {
          if (k === eIdx) continue;
          const other = coll[k].obj;
          if (other.isChamberWall || other.shape !== 'circle') continue;
          if (other.maxHitsPerShot > 0 && roundState.hitCounts[k] >= other.maxHitsPerShot) continue;
          if (M.distSq(hx, hy, other.x, other.y) <= bSq) {
            const pts = (other.scoreAdd || 0) + roundState.pegBonusAdd[k];
            blastPts += pts;
            roundState.hitCounts[k] = Math.max(roundState.hitCounts[k] + 1, other.maxHitsPerShot || 1);
            perShotObjHits.set(other.id, (perShotObjHits.get(other.id) || 0) + 1);
            blastCount++;
          }
        }
        if (blastCount > 0) {
          ball.basePoints += blastPts;
          eventParts.push(`✹BOOM(${blastCount})`);
        }
      }
    } else if (!obj.isChamberWall && trigN > 1) {
      const rem = trigN - (roundState.triggerCounters[eIdx] % trigN);
      eventParts.push(`${trigN - rem}/${trigN}`);
    }

    // Portal warp
    if (obj.shape === 'portal') {
      const ex = M.clamp(Number.isFinite(obj.exitX) ? obj.exitX : metrics.W - obj.x, metrics.left + 14, metrics.right - 14);
      const ey = M.clamp(Number.isFinite(obj.exitY) ? obj.exitY : Math.max(80, obj.y - 160), metrics.top + 24, metrics.floorY - 24);
      const speed = Math.max(160, Math.hypot(ball.vx, ball.vy) + (obj.kickSpeed || 0));

      if (Number.isFinite(obj.exitAngleDeg)) {
        const rad = (obj.exitAngleDeg * Math.PI) / 180;
        ball.vx = Math.cos(rad) * speed;
        ball.vy = Math.sin(rad) * speed;
      } else {
        const curSpd = Math.hypot(ball.vx, ball.vy) || 1;
        ball.vx = (ball.vx / curSpd) * speed;
        ball.vy = (ball.vy / curSpd) * speed;
      }

      ball.x = ex;
      ball.y = ey;
      ball.points.push({ x: ex, y: ey, jump: true });
      ball.ignoreObjIdx = eIdx;
      ball.ignoreSteps = 4;

      if (recordDetails) {
        ball.events.push({ x: hx, y: hy, label: eventParts.join(' ') || obj.tag || 'WARP', color: obj.color, kind: 'portal' });
      }
      return;
    }

    // Specular + Rigid-Body Spin/Friction Reflection
    let nx = hit.nx;
    let ny = hit.ny;
    if (obj.shape === 'circle' && Math.abs(nx) < 1e-6 && Math.abs(ball.vx) < 1e-3) {
      const sign = rayIndex % 2 === 0 ? 1 : -1;
      nx = sign * 0.015;
      ny = -Math.sqrt(1 - nx * nx);
    }

    const tx = -ny;
    const ty = nx;
    const svx = hit.svx || 0;
    const svy = hit.svy || 0;
    const rvx = ball.vx - svx;
    const rvy = ball.vy - svy;

    const vn = rvx * nx + rvy * ny;
    const vt = rvx * tx + rvy * ty;

    const baseE = obj.restitution != null ? obj.restitution : 0.68;
    const e = obj.kind === 'bumper' ? baseE : baseE * settings.restitutionScale;
    const outVn = Math.max(0, -vn * e) + (obj.kickSpeed || 0);
    let outVt = vt + (obj.tangentialBoost || 0);

    if (settings.enableSpinFriction) {
      const jn = Math.max(0, -(1 + e) * vn) + (obj.kickSpeed || 0);
      const rBall = Math.max(2, settings.ballRadius);
      const vSlip = vt - ball.omega * rBall;
      const mu = obj.isChamberWall ? 0.16 : 0.24;
      const jt = M.clamp(-vSlip / 3, -mu * jn, mu * jn);
      outVt = vt + jt + (obj.tangentialBoost || 0);
      ball.omega = M.clamp(ball.omega - (2 * jt) / rBall, -90, 90);
    }

    let nvx = svx + nx * outVn + tx * outVt;
    let nvy = svy + ny * outVn + ty * outVt;

    if (obj.biasAngle) {
      const rot = M.rotateVec(nvx, nvy, (obj.biasAngle * Math.PI) / 180);
      if (rot.x * nx + rot.y * ny > 8) {
        nvx = rot.x;
        nvy = rot.y;
      }
    }

    ball.vx = nvx;
    ball.vy = nvy;

    // Splitter spawns deterministic child balls (when triggered)
    const splits = triggersNow ? (obj.splitCount || 1) : 1;
    if (splits > 1 && ball.splitDepth < MAX_SPLIT_DEPTH) {
      const spreadDeg = obj.splitSpreadDeg || 24;
      const baseVx = ball.vx;
      const baseVy = ball.vy;
      ball.splitDepth++;

      let spawned = 0;
      for (let s = 0; s < splits; s++) {
        const offsetDeg = ((s / (splits - 1)) - 0.5) * 2 * spreadDeg;
        const rv = M.rotateVec(baseVx, baseVy, (offsetDeg * Math.PI) / 180);
        if (s === 0) {
          ball.vx = rv.x;
          ball.vy = rv.y;
        } else {
          const ok = spawnBallFn({
            x: ball.x + nx * 1.4,
            y: ball.y + ny * 1.4,
            vx: rv.x,
            vy: rv.y,
            omega: ball.omega * 0.5,
            basePoints: 0,
            mult: ball.mult,
            bounces: ball.bounces,
            splitDepth: ball.splitDepth,
            shotIdx: ball.shotIdx,
            isPrimary: false,
            points: [{ x: hx, y: hy, jump: false }],
            events: recordDetails ? [] : null,
            insideZones: ball.insideZones ? new Set(ball.insideZones) : null,
            ignoreObjIdx: eIdx,
            ignoreSteps: 3,
            active: true,
            landed: false,
            landedSlot: -1,
            lowSpeedSteps: 0
          });
          if (ok) spawned++;
        }
      }
      if (spawned > 0) eventParts.push(`⑂${spawned + 1}`);
    }

    if (obj.maxHitsPerShot > 0 && roundState.hitCounts[eIdx] >= obj.maxHitsPerShot) {
      eventParts.push('POP');
    }

    if (recordDetails && !obj.isChamberWall && (eventParts.length > 0 || obj.layerGroup === 'complication')) {
      ball.events.push({
        x: hx,
        y: hy,
        label: eventParts.join(' ') || obj.tag || obj.name,
        color: obj.color,
        kind: obj.kind || 'peg'
      });
    }
  }

  /**
   * Finalize a ball landing at the floor (including Moving Bonus Bucket & special slot effects).
   */
  function finalizeBallLanding(ball, hx, simTime, settings, metrics, slotSpecs, roundState, spawnReplayFn, recordDetails) {
    const M = RP.Math;
    const slotCount = slotSpecs.length;
    const landedSlot = M.clamp(
      Math.floor(((hx - metrics.left) / (metrics.right - metrics.left)) * slotCount),
      0,
      slotCount - 1
    );
    ball.landed = true;
    ball.active = false;
    ball.landedSlot = landedSlot;

    const spec = slotSpecs[landedSlot] || { value: 0, special: null, mult: 1 };
    const scoreMode = settings.scoreMode;

    // Moving Bonus Bucket check
    let bucketCaught = false;
    if (settings.movingBucket) {
      const bx = getBucketX(simTime, settings, metrics);
      const halfBw = (settings.bucketWidth || 82) * 0.5;
      if (Math.abs(hx - bx) <= halfBw) {
        bucketCaught = true;
        ball.mult *= (settings.bucketMult || 2);
        if (settings.bucketReplay !== false) {
          spawnReplayFn(ball.shotIdx);
        }
        if (recordDetails && ball.events) {
          ball.events.push({ x: hx, y: metrics.floorY - 14, label: `BUCKET ×${settings.bucketMult || 2}`, color: '#facc15', kind: 'bucket' });
        }
      }
    }

    // Special bottom slot effects
    if (spec.special === 'refresh') {
      roundState.hitCounts.fill(0);
      if (recordDetails && ball.events) {
        ball.events.push({ x: hx, y: metrics.floorY - 10, label: '⟳REFRESH', color: '#4ade80', kind: 'slot' });
      }
    } else if (spec.special === 'replay') {
      spawnReplayFn(ball.shotIdx);
      if (recordDetails && ball.events) {
        ball.events.push({ x: hx, y: metrics.floorY - 10, label: '+REPLAY', color: '#22d3ee', kind: 'slot' });
      }
    } else if (spec.special === 'halve' && scoreMode !== 'slotIndex') {
      ball.mult *= 0.5;
      if (recordDetails && ball.events) {
        ball.events.push({ x: hx, y: metrics.floorY - 10, label: 'TAX ÷2', color: '#f43f5e', kind: 'slot' });
      }
    } else if (spec.special === 'mult' && scoreMode !== 'slotIndex') {
      ball.mult *= (spec.mult || 2);
      if (recordDetails && ball.events) {
        ball.events.push({ x: hx, y: metrics.floorY - 10, label: `SLOT ×${spec.mult}`, color: '#e879f9', kind: 'slot' });
      }
    }

    let finalScore;
    if (scoreMode === 'slotIndex') {
      finalScore = landedSlot + 1;
    } else if (scoreMode === 'slotMult') {
      const sMult = spec.special === 'halve' ? 1 : (spec.special === 'mult' ? 1 : Math.max(0.1, spec.value || 1));
      finalScore = Math.max(1, ball.basePoints) * ball.mult * sMult;
    } else {
      const slotAdd = (spec.special === 'halve' || spec.special === 'mult') ? 0 : (spec.value || 0);
      finalScore = (ball.basePoints + slotAdd) * ball.mult;
    }

    ball.ballScore = finalScore;
    ball.bucketCaught = bucketCaught;
  }

  /**
   * Trace a full deterministic shot or multi-shot round (1..5 shots) starting at input u in [0, 1].
   */
  function traceRound(rayIndex, u, settings, metrics, grid, stampArr, stampRef, recordDetails) {
    const M = RP.Math;
    const launch = getLaunchState(u, settings);
    const collidables = grid.collidables;
    const zones = grid.zones;
    const slotSpecs = getSlotSpecs(settings);
    const slotCount = slotSpecs.length;
    const shotsPerRound = M.clamp(Math.round(settings.shotsPerRound || 1), 1, 5);

    const ballRadius = settings.ballRadius;
    const gravity = settings.gravity;
    const maxBounces = settings.maxBounces;
    const phaseRad = ((settings.startPhaseDeg || 0) * Math.PI) / 180;

    // Determine exact vs lockstep rigid-body solver automatically
    const needsLockstep = Boolean(
      grid.hasDynamic ||
      zones.length > 0 ||
      settings.enableSpinFriction ||
      settings.enableBallCollisions ||
      settings.movingBucket
    );
    const pureOptical = !needsLockstep && gravity <= 0.01;
    const useAnalyticParabola = !needsLockstep && gravity > 0.01 && settings.exactParabola !== false;

    // Persistent roguelike round state carried across shots #1..#S
    const roundState = {
      hitCounts: new Uint16Array(collidables.length),
      triggerCounters: new Uint16Array(collidables.length),
      pegBonusAdd: new Float64Array(collidables.length)
    };

    const paths = [];
    const allEvents = recordDetails ? [] : null;
    const perShotObjHits = new Map();
    const shotScores = new Float64Array(shotsPerRound);

    let totalScore = 0;
    let totalBounces = 0;
    let totalBallCount = 0;
    let totalLanded = 0;
    let primarySlot = Math.floor(slotCount / 2);
    let anyCapped = false;
    let roundClock = 0;

    for (let shotIdx = 0; shotIdx < shotsPerRound; shotIdx++) {
      let replaysSpawned = 0;
      const makeInitialBall = (isPrimary) => ({
        x: launch.x,
        y: launch.y,
        vx: launch.vx,
        vy: launch.vy,
        omega: 0,
        basePoints: 0,
        mult: 1,
        bounces: 0,
        splitDepth: 0,
        shotIdx,
        isPrimary,
        points: [{ x: launch.x, y: launch.y, jump: false }],
        events: recordDetails ? [] : null,
        insideZones: zones.length > 0 ? new Set() : null,
        ignoreObjIdx: -1,
        ignoreSteps: 0,
        active: true,
        landed: false,
        landedSlot: -1,
        ballScore: 0,
        lowSpeedSteps: 0
      });

      const shotBalls = [makeInitialBall(shotIdx === 0)];
      const spawnChild = (b) => {
        if (shotBalls.length >= MAX_BALLS_PER_SHOT) return false;
        shotBalls.push(b);
        return true;
      };
      const spawnReplay = () => {
        if (replaysSpawned >= MAX_REPLAYS_PER_SHOT || shotBalls.length >= MAX_BALLS_PER_SHOT) return false;
        replaysSpawned++;
        shotBalls.push(makeInitialBall(false));
        return true;
      };

      if (pureOptical || useAnalyticParabola) {
        // Exact analytical jump-to-hit per ball (0-G optical or exact quartic parabola <1e-13)
        let bIdx = 0;
        const ay = 0.5 * gravity;
        while (bIdx < shotBalls.length) {
          const ball = shotBalls[bIdx++];
          let iter = 0;
          const maxIter = maxBounces + 14;
          let flightTime = 0;
          let microCount = 0;

          while (!ball.landed && iter < maxIter && ball.bounces < maxBounces && flightTime < 14) {
            iter++;
            let hit;
            if (pureOptical) {
              const spd = Math.hypot(ball.vx, ball.vy);
              if (spd < 5) break;
              const dx = (ball.vx / spd) * (metrics.W + metrics.H);
              const dy = (ball.vy / spd) * (metrics.W + metrics.H);
              hit = findEarliestHit(
                ball.x, ball.y, dx, dy, 1.0,
                ballRadius, metrics, grid, roundState.hitCounts,
                false, stampArr, ++stampRef.v, ball.ignoreObjIdx, roundClock + flightTime, phaseRad
              );
              ball.ignoreObjIdx = -1;
              if (!hit) {
                ball.x += dx;
                ball.y += dy;
                ball.points.push({ x: ball.x, y: ball.y, jump: false });
                break;
              }
              const hx = ball.x + dx * hit.t;
              const hy = ball.y + dy * hit.t;
              flightTime += (Math.hypot(dx * hit.t, dy * hit.t)) / spd;
              ball.x = hx + hit.nx * 0.2;
              ball.y = hy + hit.ny * 0.2;
              ball.points.push({ x: hx, y: hy, jump: false });

              if (hit.kind === 'floor') {
                finalizeBallLanding(ball, hx, roundClock + flightTime, settings, metrics, slotSpecs, roundState, spawnReplay, recordDetails);
                break;
              }
              if (hit.kind === 'wall') {
                ball.bounces++;
                const vn = ball.vx * hit.nx + ball.vy * hit.ny;
                ball.vx -= 1.96 * vn * hit.nx;
                ball.vy -= 1.96 * vn * hit.ny;
                continue;
              }
              applyObjectHit(ball, hit, hx, hy, rayIndex, settings, metrics, grid, roundState, perShotObjHits, spawnChild, recordDetails);
            } else {
              hit = findEarliestParabolicHit(
                ball.x, ball.y, ball.vx, ball.vy, gravity, 3.0,
                ballRadius, metrics, collidables, roundState.hitCounts, ball.ignoreObjIdx
              );
              ball.ignoreObjIdx = -1;

              if (!hit) {
                const tStep = 0.5;
                ball.x += ball.vx * tStep;
                ball.y += ball.vy * tStep + ay * tStep * tStep;
                ball.vy += gravity * tStep;
                flightTime += tStep;
                ball.points.push({ x: ball.x, y: ball.y, jump: false });
                if (ball.y >= metrics.floorY - ballRadius) {
                  finalizeBallLanding(ball, ball.x, roundClock + flightTime, settings, metrics, slotSpecs, roundState, spawnReplay, recordDetails);
                }
                continue;
              }

              const tHit = hit.t;
              flightTime += tHit;
              const arcSteps = Math.max(1, Math.min(12, Math.ceil(tHit / 0.045)));
              for (let sIdx = 1; sIdx < arcSteps; sIdx++) {
                const st = (tHit * sIdx) / arcSteps;
                ball.points.push({
                  x: ball.x + ball.vx * st,
                  y: ball.y + ball.vy * st + ay * st * st,
                  jump: false
                });
              }

              const hx = ball.x + ball.vx * tHit;
              const hy = ball.y + ball.vy * tHit + ay * tHit * tHit;
              ball.vy += gravity * tHit;
              ball.x = hx + hit.nx * 0.02;
              ball.y = hy + hit.ny * 0.02;
              ball.points.push({ x: hx, y: hy, jump: false });

              if (tHit < 1e-4) {
                microCount++;
                if (microCount > 8) break;
              } else {
                microCount = 0;
              }

              if (hit.kind === 'floor') {
                finalizeBallLanding(ball, hx, roundClock + flightTime, settings, metrics, slotSpecs, roundState, spawnReplay, recordDetails);
                break;
              }
              if (hit.kind === 'wall') {
                ball.bounces++;
                const vn = ball.vx * hit.nx + ball.vy * hit.ny;
                const wallE = 0.72 * settings.restitutionScale;
                ball.vx -= (1 + wallE) * vn * hit.nx;
                ball.vy -= (1 + wallE) * vn * hit.ny;
                continue;
              }

              const spdSq = ball.vx * ball.vx + ball.vy * ball.vy;
              if (spdSq > 1550 * 1550) {
                const inv = 1550 / Math.sqrt(spdSq);
                ball.vx *= inv;
                ball.vy *= inv;
              }
              applyObjectHit(ball, hit, hx, hy, rayIndex, settings, metrics, grid, roundState, perShotObjHits, spawnChild, recordDetails);
            }
          }
          roundClock += Math.min(2.5, flightTime);
        }
      } else {
        // Simultaneous Lockstep Rigid-Body Substepping (handles Spin/Friction, Ball-to-Ball Collisions, Moving Spinners, Moving Bucket, Force Zones)
        const dt = 1 / 75;
        const maxSteps = 720;
        let simTime = roundClock;

        for (let step = 0; step < maxSteps; step++) {
          let anyActive = false;

          for (let bIdx = 0; bIdx < shotBalls.length; bIdx++) {
            const ball = shotBalls[bIdx];
            if (!ball.active || ball.landed || ball.bounces >= maxBounces) {
              ball.active = false;
              continue;
            }
            anyActive = true;

            let ax = 0;
            let ay = gravity;
            let drag = 0;

            // Subtle Magnus aerodynamic curve when spin is enabled
            if (settings.enableSpinFriction && Math.abs(ball.omega) > 0.5) {
              const magnus = 0.016 * ball.omega;
              ax += -ball.vy * magnus;
              ay += ball.vx * magnus;
            }

            for (let z = 0; z < zones.length; z++) {
              const zone = zones[z];
              const zr = zone.radius || 52;
              const dSq = M.distSq(ball.x, ball.y, zone.x, zone.y);
              if (dSq <= zr * zr) {
                ax += zone.forceX || 0;
                ay += zone.forceY || 0;
                if (zone.radialForce) {
                  const dist = Math.sqrt(dSq);
                  if (dist > 4) {
                    const falloff = 1 - (dist / zr) * 0.45;
                    ax += ((ball.x - zone.x) / dist) * zone.radialForce * falloff;
                    ay += ((ball.y - zone.y) / dist) * zone.radialForce * falloff;
                  }
                }
                if (zone.drag) drag = Math.max(drag, zone.drag);

                if (ball.insideZones && !ball.insideZones.has(zone.id)) {
                  ball.insideZones.add(zone.id);
                  perShotObjHits.set(zone.id, (perShotObjHits.get(zone.id) || 0) + 1);
                  if (zone.scoreAdd) ball.basePoints += zone.scoreAdd;
                  if (zone.scoreMult && zone.scoreMult !== 1) ball.mult *= zone.scoreMult;
                  if (recordDetails && (zone.scoreAdd || (zone.scoreMult && zone.scoreMult !== 1))) {
                    ball.events.push({ x: ball.x, y: ball.y, label: zone.name || 'Zone', color: zone.color, kind: 'zone' });
                  }
                }
              } else if (ball.insideZones && ball.insideZones.has(zone.id)) {
                ball.insideZones.delete(zone.id);
              }
            }

            ball.vx += ax * dt;
            ball.vy += ay * dt;
            if (drag > 0) {
              const damp = Math.max(0.5, 1 - drag * dt);
              ball.vx *= damp;
              ball.vy *= damp;
            }

            const spdSq = ball.vx * ball.vx + ball.vy * ball.vy;
            if (spdSq > 1550 * 1550) {
              const inv = 1550 / Math.sqrt(spdSq);
              ball.vx *= inv;
              ball.vy *= inv;
            }

            let rem = 1.0;
            for (let sub = 0; sub < 3 && rem > 1e-4 && ball.active && ball.bounces < maxBounces; sub++) {
              const dx = ball.vx * dt * rem;
              const dy = ball.vy * dt * rem;

              const hit = findEarliestHit(
                ball.x, ball.y, dx, dy, 1.0,
                ballRadius, metrics, grid, roundState.hitCounts,
                true, stampArr, ++stampRef.v, ball.ignoreSteps > 0 ? ball.ignoreObjIdx : -1,
                simTime + dt * (1 - rem), phaseRad
              );

              if (!hit) {
                ball.x += dx;
                ball.y += dy;
                rem = 0;
                break;
              }

              const hx = ball.x + dx * hit.t;
              const hy = ball.y + dy * hit.t;
              ball.x = hx + hit.nx * 0.2;
              ball.y = hy + hit.ny * 0.2;
              ball.points.push({ x: hx, y: hy, jump: false });

              if (hit.kind === 'floor') {
                finalizeBallLanding(ball, hx, simTime + dt * (1 - rem + hit.t * rem), settings, metrics, slotSpecs, roundState, spawnReplay, recordDetails);
                break;
              }
              if (hit.kind === 'wall') {
                ball.bounces++;
                const vn = ball.vx * hit.nx + ball.vy * hit.ny;
                const wallE = 0.72 * settings.restitutionScale;
                ball.vx -= (1 + wallE) * vn * hit.nx;
                ball.vy -= (1 + wallE) * vn * hit.ny;
                rem *= (1 - hit.t);
                continue;
              }

              applyObjectHit(ball, hit, hx, hy, rayIndex, settings, metrics, grid, roundState, perShotObjHits, spawnChild, recordDetails);
              rem *= (1 - hit.t);
            }

            if (ball.ignoreSteps > 0) ball.ignoreSteps--;

            const lastPt = ball.points[ball.points.length - 1];
            if (!lastPt || M.distSq(lastPt.x, lastPt.y, ball.x, ball.y) > 36) {
              ball.points.push({ x: ball.x, y: ball.y, jump: false });
            }

            if (ball.vx * ball.vx + ball.vy * ball.vy < 18) {
              ball.lowSpeedSteps++;
              if (ball.lowSpeedSteps > 28) ball.active = false;
            } else {
              ball.lowSpeedSteps = 0;
            }
          }

          // Ball-to-Ball simultaneous elastic collisions
          if (settings.enableBallCollisions && shotBalls.length > 1) {
            const minDist = ballRadius * 2;
            const minDistSq = minDist * minDist;
            for (let a = 0; a < shotBalls.length; a++) {
              const ba = shotBalls[a];
              if (!ba.active) continue;
              for (let b = a + 1; b < shotBalls.length; b++) {
                const bb = shotBalls[b];
                if (!bb.active) continue;
                const dx = bb.x - ba.x;
                const dy = bb.y - ba.y;
                const dSq = dx * dx + dy * dy;
                if (dSq > 1e-6 && dSq < minDistSq) {
                  const d = Math.sqrt(dSq);
                  const nx = dx / d;
                  const ny = dy / d;
                  const overlap = (minDist - d) * 0.5 + 0.05;
                  ba.x -= nx * overlap;
                  ba.y -= ny * overlap;
                  bb.x += nx * overlap;
                  bb.y += ny * overlap;

                  const rvx = bb.vx - ba.vx;
                  const rvy = bb.vy - ba.vy;
                  const vn = rvx * nx + rvy * ny;
                  if (vn < 0) {
                    const j = -0.92 * vn;
                    ba.vx -= j * nx;
                    ba.vy -= j * ny;
                    bb.vx += j * nx;
                    bb.vy += j * ny;
                    if (settings.enableSpinFriction) {
                      const avgW = (ba.omega + bb.omega) * 0.5;
                      ba.omega = M.lerp(ba.omega, avgW, 0.25);
                      bb.omega = M.lerp(bb.omega, avgW, 0.25);
                    }
                  }
                }
              }
            }
          }

          simTime += dt;
          if (!anyActive) break;
        }
        roundClock = simTime;
      }

      // Accumulate shot scores
      let shotTotal = 0;
      for (let bIdx = 0; bIdx < shotBalls.length; bIdx++) {
        const ball = shotBalls[bIdx];
        if (!ball.landed) {
          anyCapped = true;
          finalizeBallLanding(ball, ball.x, roundClock, settings, metrics, slotSpecs, roundState, () => false, false);
        } else {
          totalLanded++;
        }

        if (ball.isPrimary) primarySlot = ball.landedSlot;
        if (settings.scoreMode === 'slotIndex') {
          if (ball.isPrimary) shotTotal = ball.ballScore;
        } else {
          shotTotal += ball.ballScore;
        }
        totalBounces += ball.bounces;
        paths.push({
          isPrimary: ball.isPrimary,
          shotIdx: ball.shotIdx,
          points: ball.points,
          landedSlot: ball.landedSlot,
          ballScore: ball.ballScore
        });
        if (recordDetails && ball.events) {
          for (let e = 0; e < ball.events.length; e++) allEvents.push(ball.events[e]);
        }
      }

      shotScores[shotIdx] = shotTotal;
      if (settings.scoreMode === 'slotIndex') {
        if (shotIdx === 0) totalScore = shotTotal;
      } else {
        totalScore += shotTotal;
      }
      totalBallCount += shotBalls.length;
    }

    return {
      rayIndex,
      u,
      launch,
      finalScore: totalScore,
      shotScores,
      primarySlot,
      bounces: totalBounces,
      ballCount: totalBallCount,
      landedBalls: totalLanded,
      capped: anyCapped,
      paths,
      events: allEvents,
      objHits: perShotObjHits
    };
  }

  /**
   * Run full deterministic ray sweep across K evenly-spaced inputs u in [0, 1].
   */
  function runSweep(objects, settings, detailIndex = -1) {
    const t0 = performance.now();
    const metrics = getBoardMetrics(settings);
    const rayCount = RP.Math.clamp(settings.rayCount || 200, 30, 500);
    const shotsPerRound = RP.Math.clamp(Math.round(settings.shotsPerRound || 1), 1, 5);
    const grid = buildSpatialGrid(objects, settings.ballRadius, metrics);
    const stampArr = new Int32Array(grid.collidables.length);
    const stampRef = { v: 0 };

    const traces = new Array(rayCount);
    const values = new Float64Array(rayCount);
    const slots = new Int32Array(rayCount);
    const shotMeans = new Float64Array(shotsPerRound);
    const objectHeat = new Map();

    let cappedCount = 0;

    for (let i = 0; i < rayCount; i++) {
      const u = rayCount === 1 ? 0.5 : i / (rayCount - 1);
      const recordDetails = i === detailIndex;
      const tr = traceRound(i, u, settings, metrics, grid, stampArr, stampRef, recordDetails);
      traces[i] = tr;
      values[i] = tr.finalScore;
      slots[i] = tr.primarySlot;
      if (tr.capped) cappedCount++;

      for (let s = 0; s < shotsPerRound; s++) {
        shotMeans[s] += tr.shotScores[s];
      }

      tr.objHits.forEach((cnt, id) => {
        objectHeat.set(id, (objectHeat.get(id) || 0) + cnt);
      });
    }

    for (let s = 0; s < shotsPerRound; s++) shotMeans[s] /= Math.max(1, rayCount);
    objectHeat.forEach((cnt, id) => objectHeat.set(id, cnt / rayCount));

    const elapsedMs = performance.now() - t0;
    const needsLockstep = Boolean(
      grid.hasDynamic ||
      grid.zones.length > 0 ||
      settings.enableSpinFriction ||
      settings.enableBallCollisions ||
      settings.movingBucket
    );
    const solverKind = !needsLockstep && settings.gravity <= 0.01
      ? 'optical'
      : (!needsLockstep && settings.exactParabola !== false)
        ? 'analytic'
        : (settings.enableSpinFriction || settings.enableBallCollisions || grid.hasDynamic || settings.movingBucket)
          ? 'rigidbody'
          : 'substep';

    return {
      traces,
      values,
      slots,
      shotMeans,
      objectHeat,
      cappedCount,
      rayCount,
      elapsedMs,
      solverKind,
      metrics
    };
  }

  /**
   * Adaptive local dense ray sweep centered on [uCenter - 3.5*sigma, uCenter + 3.5*sigma].
   */
  function runLocalSweep(objects, settings, uCenter, sigmaU, count = 160) {
    const t0 = performance.now();
    const M = RP.Math;
    const metrics = getBoardMetrics(settings);
    const grid = buildSpatialGrid(objects, settings.ballRadius, metrics);
    const stampArr = new Int32Array(grid.collidables.length);
    const stampRef = { v: 0 };

    const sig = Math.max(0.004, sigmaU);
    const span = Math.min(0.5, sig * 3.5);
    const uLo = M.clamp(uCenter - span, 0, 1);
    const uHi = M.clamp(uCenter + span, 0, 1);
    const actualLo = uHi - uLo < 1e-4 ? Math.max(0, uCenter - 0.005) : uLo;
    const actualHi = uHi - uLo < 1e-4 ? Math.min(1, uCenter + 0.005) : uHi;

    // Keep multi-shot local oversampling snappy
    const shots = M.clamp(Math.round(settings.shotsPerRound || 1), 1, 5);
    const n = M.clamp(shots > 1 ? Math.round(count / 2) : count, 40, 320);
    const values = new Float64Array(n);
    const slots = new Int32Array(n);
    const uCoords = new Float64Array(n);
    const weights = new Float64Array(n);
    const invTwoSigSq = 1 / (2 * sig * sig);
    let wSum = 0;

    for (let i = 0; i < n; i++) {
      const u = n === 1 ? uCenter : actualLo + ((actualHi - actualLo) * i) / (n - 1);
      uCoords[i] = u;
      const tr = traceRound(i, u, settings, metrics, grid, stampArr, stampRef, false);
      values[i] = tr.finalScore;
      slots[i] = tr.primarySlot;
      const d = u - uCenter;
      const w = Math.exp(-d * d * invTwoSigSq);
      weights[i] = w;
      wSum += w;
    }

    if (wSum > 0) {
      for (let i = 0; i < n; i++) weights[i] /= wSum;
    } else {
      weights.fill(1 / n);
    }

    return {
      values,
      slots,
      uCoords,
      weights,
      count: n,
      elapsedMs: performance.now() - t0
    };
  }

  function traceSingleDetailed(u, objects, settings) {
    const metrics = getBoardMetrics(settings);
    const grid = buildSpatialGrid(objects, settings.ballRadius, metrics);
    const stampArr = new Int32Array(grid.collidables.length);
    const stampRef = { v: 0 };
    return traceRound(0, u, settings, metrics, grid, stampArr, stampRef, true);
  }

  RP.Engine = {
    // Legacy defaults for compatibility
    BOARD_W: 540,
    BOARD_H: 720,
    LEFT_WALL: 22,
    RIGHT_WALL: 518,
    TOP_WALL: 22,
    FLOOR_Y: 668,
    LAUNCH_Y: 46,
    CANNON_X: 270,
    CANNON_Y: 46,
    getBoardMetrics,
    getBucketX,
    evaluateObjectPose,
    isDynamicObject,
    getLaunchState,
    runSweep,
    runLocalSweep,
    traceSingleDetailed
  };
})();
