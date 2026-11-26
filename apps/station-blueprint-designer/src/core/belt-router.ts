import { getBuildableDef } from './catalog';
import { deltaToRotation, findBuildingAtCell, isCellBuildable, normalizeRotation, rotationToDelta } from './geometry';
import type { BlueprintDocument, Rotation } from './types';

export interface BeltCellSpec {
  x: number;
  y: number;
  rotation: Rotation;
  kind?: 'belt' | 'underground-in' | 'underground-out';
  pairIndex?: number;
  /** Preview-only marker indicating a user-pinned waypoint anchor cell */
  isWaypoint?: boolean;
}

export interface BeltWaypoint {
  cell: [number, number];
  /** Corner preference for the leg starting at this waypoint (false = X-first, true = Y-first) */
  flipCorner: boolean;
}

export interface BeltStrokeTunnel {
  /** Index in stroke cells where user pressed tunnel hotkey (T) to dive underground */
  inIndex: number;
  /** Index in stroke cells where user pressed tunnel hotkey again to surface (null while actively diving) */
  outIndex: number | null;
}

export function getMatchingUndergroundType(beltType: string): string | null {
  if (beltType === 'DAT_ConveyorBelt') return 'DAT_UndergroundBelt';
  if (beltType === 'DAT_ConveyorBelt2') return 'DAT_UndergroundBelt_2';
  if (beltType === 'DAT_ConveyorBelt3') return 'DAT_UndergroundBelt_3';
  return null;
}

export function getMatchingBeltType(undergroundType: string): string | null {
  if (undergroundType === 'DAT_UndergroundBelt') return 'DAT_ConveyorBelt';
  if (undergroundType === 'DAT_UndergroundBelt_2') return 'DAT_ConveyorBelt2';
  if (undergroundType === 'DAT_UndergroundBelt_3') return 'DAT_ConveyorBelt3';
  return null;
}

/**
 * Interpolate an orthogonal cell-by-cell path between two cells so fast pointer drags
 * never leave gaps (shapez 2 style smooth belt drawing).
 */
export function interpolateOrthogonalCells(
  from: [number, number],
  to: [number, number],
  preferXFirst: boolean
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let [x, y] = from;
  const [tx, ty] = to;

  const stepX = () => {
    while (x !== tx) {
      x += tx > x ? 1 : -1;
      result.push([x, y]);
    }
  };
  const stepY = () => {
    while (y !== ty) {
      y += ty > y ? 1 : -1;
      result.push([x, y]);
    }
  };

  if (preferXFirst) {
    stepX();
    stepY();
  } else {
    stepY();
    stepX();
  }
  return result;
}

/**
 * Append a new cursor cell into an active freehand belt stroke.
 * Handles backtracking (undoing last step when dragging backward) and orthogonal interpolation.
 */
export function extendBeltStroke(
  stroke: Array<[number, number]>,
  nextCell: [number, number]
): Array<[number, number]> {
  if (stroke.length === 0) return [nextCell];
  const last = stroke[stroke.length - 1];
  if (last[0] === nextCell[0] && last[1] === nextCell[1]) return stroke;

  // Backtrack cleanly if user drags onto the previous cell
  if (stroke.length >= 2) {
    const prev = stroke[stroke.length - 2];
    if (prev[0] === nextCell[0] && prev[1] === nextCell[1]) {
      return stroke.slice(0, -1);
    }
  }

  // Decide preferred axis from recent movement direction
  let preferX = true;
  if (stroke.length >= 2) {
    const prev = stroke[stroke.length - 2];
    preferX = Math.abs(last[0] - prev[0]) >= Math.abs(last[1] - prev[1]);
  } else {
    preferX = Math.abs(nextCell[0] - last[0]) >= Math.abs(nextCell[1] - last[1]);
  }

  const steps = interpolateOrthogonalCells(last, nextCell, preferX);
  const next = [...stroke];
  for (const s of steps) {
    // Avoid self-looping immediately back over existing stroke tail
    const dupIdx = next.findIndex((p) => p[0] === s[0] && p[1] === s[1]);
    if (dupIdx >= 0 && dupIdx >= next.length - 3) {
      next.length = dupIdx + 1;
    } else if (dupIdx < 0) {
      next.push(s);
    }
  }
  return next;
}

/**
 * Shapez 2 Belt Planner: automatic L-shaped path from anchor to target.
 * `flipCorner` toggles X-first vs Y-first (`F` key during planning).
 * `reverse` reverses flow direction (`Alt` key during planning).
 */
export function buildPlannedBeltPath(
  start: [number, number],
  end: [number, number],
  options: { flipCorner: boolean; reverse: boolean; fallbackRotation: Rotation }
): BeltCellSpec[] {
  const cells: Array<[number, number]> = [
    start,
    ...interpolateOrthogonalCells(start, end, !options.flipCorner),
  ];
  return cellsToBeltSpecs(cells, options.fallbackRotation, options.reverse);
}

/** Convert an ordered sequence of adjacent 1m cells into oriented belt segments */
export function cellsToBeltSpecs(
  cells: Array<[number, number]>,
  fallbackRotation: Rotation,
  reverse = false
): BeltCellSpec[] {
  if (cells.length === 0) return [];
  const ordered = reverse ? [...cells].reverse() : cells;
  if (ordered.length === 1) {
    return [{
      x: ordered[0][0],
      y: ordered[0][1],
      rotation: reverse ? normalizeRotation(fallbackRotation + 2) : fallbackRotation,
    }];
  }

  const specs: BeltCellSpec[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    let rot: Rotation;
    if (i < ordered.length - 1) {
      const nxt = ordered[i + 1];
      rot = deltaToRotation(nxt[0] - cur[0], nxt[1] - cur[1]);
    } else {
      // Last tile keeps direction of incoming step
      const prev = ordered[i - 1];
      rot = deltaToRotation(cur[0] - prev[0], cur[1] - prev[1]);
    }
    specs.push({ x: cur[0], y: cur[1], rotation: rot });
  }
  return specs;
}

/**
 * Extend a freehand belt stroke while respecting any open (actively diving) underground tunnel.
 * While diving (`tunnels[last].outIndex === null`), movement is projected straight along the tunnel axis
 * up to `maxLength` tiles so the cursor glides smoothly across perpendicular belts or machines!
 */
export function extendBeltStrokeWithTunnels(
  stroke: Array<[number, number]>,
  tunnels: BeltStrokeTunnel[],
  nextCell: [number, number],
  maxLength = 8
): { cells: Array<[number, number]>; tunnels: BeltStrokeTunnel[] } {
  const active = tunnels.length > 0 && tunnels[tunnels.length - 1].outIndex === null
    ? tunnels[tunnels.length - 1]
    : null;

  if (active) {
    const entry = stroke[active.inIndex];
    if (!entry) return { cells: stroke, tunnels };
    let dxAxis = 0;
    let dyAxis = 0;
    if (active.inIndex > 0) {
      const prev = stroke[active.inIndex - 1];
      dxAxis = Math.sign(entry[0] - prev[0]);
      dyAxis = Math.sign(entry[1] - prev[1]);
    }
    const rx = nextCell[0] - entry[0];
    const ry = nextCell[1] - entry[1];
    if (dxAxis === 0 && dyAxis === 0) {
      // Entry is at stroke start (index 0): pick dominant axis toward cursor
      if (rx === 0 && ry === 0) {
        if (stroke.length === active.inIndex + 1) return { cells: stroke, tunnels };
        return { cells: stroke.slice(0, active.inIndex + 1), tunnels };
      }
      if (Math.abs(rx) >= Math.abs(ry)) {
        dxAxis = Math.sign(rx);
      } else {
        dyAxis = Math.sign(ry);
      }
    }
    const proj = rx * dxAxis + ry * dyAxis;
    const dist = Math.max(0, Math.min(maxLength, proj));
    const base = stroke.slice(0, active.inIndex + 1);
    for (let k = 1; k <= dist; k++) {
      base.push([entry[0] + dxAxis * k, entry[1] + dyAxis * k]);
    }
    if (
      base.length === stroke.length &&
      base[base.length - 1][0] === stroke[stroke.length - 1][0] &&
      base[base.length - 1][1] === stroke[stroke.length - 1][1]
    ) {
      return { cells: stroke, tunnels };
    }
    return { cells: base, tunnels };
  }

  const nextCells = extendBeltStroke(stroke, nextCell);
  if (nextCells === stroke) return { cells: stroke, tunnels };
  // Trim/reopen any tunnel invalidated by backtracking
  if (tunnels.length === 0) return { cells: nextCells, tunnels };
  const nextTunnels: BeltStrokeTunnel[] = [];
  for (const t of tunnels) {
    if (t.inIndex >= nextCells.length) continue;
    if (t.outIndex !== null && t.outIndex >= nextCells.length) {
      nextTunnels.push({ inIndex: t.inIndex, outIndex: null });
    } else {
      nextTunnels.push(t);
    }
  }
  return { cells: nextCells, tunnels: nextTunnels };
}

/**
 * Toggle underground tunnel dive/surface at the current head of an active freehand belt stroke.
 * - If not currently diving: starts a tunnel IN at the current head cell.
 * - If currently diving and cursor moved >= 1 cell forward: surfaces (locks tunnel OUT) so normal belt drawing resumes.
 * - If currently diving at distance 0: cancels the dive.
 */
export function toggleBeltStrokeTunnel(
  stroke: Array<[number, number]>,
  tunnels: BeltStrokeTunnel[]
): { tunnels: BeltStrokeTunnel[]; action: 'dive' | 'surface' | 'cancel' } {
  const headIdx = Math.max(0, stroke.length - 1);
  const last = tunnels.length > 0 ? tunnels[tunnels.length - 1] : null;
  if (last && last.outIndex === null) {
    if (headIdx > last.inIndex) {
      const next = tunnels.slice(0, -1);
      next.push({ inIndex: last.inIndex, outIndex: headIdx });
      return { tunnels: next, action: 'surface' };
    }
    return { tunnels: tunnels.slice(0, -1), action: 'cancel' };
  }
  // Avoid overlapping an existing tunnel's exit cell as a new entrance
  if (last && last.outIndex === headIdx) {
    return { tunnels, action: 'cancel' };
  }
  return { tunnels: [...tunnels, { inIndex: headIdx, outIndex: null }], action: 'dive' };
}

/**
 * Return the forbidden reverse rotation for the terminal belt cell (pointing directly back
 * into the preceding cell), or `null` when the path has < 2 cells or ends on an underground portal.
 */
export function getForbiddenEndRotation(specs: readonly BeltCellSpec[]): Rotation | null {
  if (specs.length < 2) return null;
  const last = specs[specs.length - 1];
  if (last.kind === 'underground-in' || last.kind === 'underground-out') return null;
  const prev = specs[specs.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  if (dx === 0 && dy === 0) return null;
  return normalizeRotation(deltaToRotation(dx, dy) + 2);
}

/**
 * Step the terminal belt rotation by `delta` (+1 CW / -1 CCW), skipping the forbidden reverse
 * direction so rotating during belt routing can never produce a back-facing belt.
 */
export function stepBeltEndRotation(
  specs: readonly BeltCellSpec[],
  currentRotation: Rotation,
  delta: 1 | -1
): Rotation {
  const forbidden = getForbiddenEndRotation(specs);
  let next = normalizeRotation(currentRotation + delta);
  if (forbidden !== null && next === forbidden) {
    next = normalizeRotation(next + delta);
  }
  return next;
}

/** Override the terminal belt cell's exit rotation (Shapez 2 `R` key during belt routing). */
export function applyEndRotationOverride(
  specs: BeltCellSpec[],
  endRotation: Rotation | null | undefined
): BeltCellSpec[] {
  if (specs.length === 0 || endRotation === null || endRotation === undefined) return specs;
  const lastIdx = specs.length - 1;
  const last = specs[lastIdx];
  if (last.kind === 'underground-in' || last.kind === 'underground-out') return specs;
  const nextRot = normalizeRotation(endRotation);
  const forbidden = getForbiddenEndRotation(specs);
  if (forbidden !== null && nextRot === forbidden) return specs;
  if (last.rotation === nextRot) return specs;
  const out = specs.slice();
  out[lastIdx] = { ...last, rotation: nextRot };
  return out;
}

/** Convert a freehand stroke + explicit hotkey tunnels into oriented BeltCellSpecs */
export function buildBeltStrokeSpecs(
  cells: Array<[number, number]>,
  tunnels: BeltStrokeTunnel[],
  fallbackRotation: Rotation,
  reverse = false,
  endRotation: Rotation | null = null
): BeltCellSpec[] {
  if (cells.length === 0) return [];
  if (tunnels.length === 0) {
    return applyEndRotationOverride(cellsToBeltSpecs(cells, fallbackRotation, reverse), endRotation);
  }

  const forwardSpecs: BeltCellSpec[] = [];
  let pairCounter = 0;
  let i = 0;

  while (i < cells.length) {
    const tunnel = tunnels.find((t) => t.inIndex === i);
    if (tunnel) {
      const effOut = tunnel.outIndex !== null ? Math.min(tunnel.outIndex, cells.length - 1) : cells.length - 1;
      if (effOut > i) {
        const rot = deltaToRotation(cells[effOut][0] - cells[i][0], cells[effOut][1] - cells[i][1]);
        const pid = pairCounter++;
        forwardSpecs.push({ x: cells[i][0], y: cells[i][1], rotation: rot, kind: 'underground-in', pairIndex: pid });
        forwardSpecs.push({ x: cells[effOut][0], y: cells[effOut][1], rotation: rot, kind: 'underground-out', pairIndex: pid });
        i = effOut + 1;
        continue;
      }
      // Armed dive at head cell (distance 0)
      const rot =
        i > 0
          ? deltaToRotation(cells[i][0] - cells[i - 1][0], cells[i][1] - cells[i - 1][1])
          : fallbackRotation;
      forwardSpecs.push({ x: cells[i][0], y: cells[i][1], rotation: rot, kind: 'underground-in' });
      i += 1;
      continue;
    }

    let rot: Rotation;
    if (i < cells.length - 1) {
      rot = deltaToRotation(cells[i + 1][0] - cells[i][0], cells[i + 1][1] - cells[i][1]);
    } else if (i > 0) {
      rot = deltaToRotation(cells[i][0] - cells[i - 1][0], cells[i][1] - cells[i - 1][1]);
    } else {
      rot = fallbackRotation;
    }
    forwardSpecs.push({ x: cells[i][0], y: cells[i][1], rotation: rot, kind: 'belt' });
    i += 1;
  }

  const ordered = !reverse
    ? forwardSpecs
    : forwardSpecs
        .slice()
        .reverse()
        .map((s) => ({
          ...s,
          rotation: normalizeRotation(s.rotation + 2),
          kind:
            s.kind === 'underground-in'
              ? ('underground-out' as const)
              : s.kind === 'underground-out'
                ? ('underground-in' as const)
                : s.kind,
        }));
  return applyEndRotationOverride(ordered, endRotation);
}

/**
 * Multi-waypoint Shapez 2 L-shaped belt planner (default click-to-click mode + middle-click waypoints).
 * - Each locked waypoint remembers its own `flipCorner` preference.
 * - `currentFlipCorner` (`F` key) flips only the active final leg.
 * - `tunnelObstacles` (`T` key) bridges straight-leg obstacles with same-tier underground pairs.
 * - `endRotation` (`R` key) rotates the terminal belt tile's exit direction.
 */
export function buildMultiWaypointBeltPath(
  doc: BlueprintDocument,
  floor: number,
  waypoints: BeltWaypoint[],
  end: [number, number],
  options: {
    currentFlipCorner: boolean;
    reverse: boolean;
    fallbackRotation: Rotation;
    tunnelObstacles: boolean;
    endRotation?: Rotation | null;
    maxLength?: number;
  }
): BeltCellSpec[] {
  if (waypoints.length === 0) return [];

  const cells: Array<[number, number]> = [waypoints[0].cell];
  const appendLeg = (from: [number, number], to: [number, number], flipCorner: boolean) => {
    const steps = interpolateOrthogonalCells(from, to, !flipCorner);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const prev = cells[cells.length - 1];
      if (prev && prev[0] === s[0] && prev[1] === s[1]) continue;
      cells.push(s);
    }
  };

  for (let i = 0; i < waypoints.length - 1; i++) {
    appendLeg(waypoints[i].cell, waypoints[i + 1].cell, waypoints[i].flipCorner);
  }
  appendLeg(waypoints[waypoints.length - 1].cell, end, options.currentFlipCorner);

  const waypointKeys = new Set<string>();
  for (let i = 0; i < waypoints.length; i++) {
    waypointKeys.add(`${waypoints[i].cell[0]},${waypoints[i].cell[1]}`);
  }

  const baseSpecs = cellsToBeltSpecs(cells, options.fallbackRotation, options.reverse).map((s) =>
    waypointKeys.has(`${s.x},${s.y}`) ? { ...s, isWaypoint: true } : s
  );

  if (!options.tunnelObstacles || baseSpecs.length < 3) {
    return applyEndRotationOverride(baseSpecs, options.endRotation);
  }

  const maxLen = options.maxLength ?? 8;
  const isObstacleForLeg = (cellX: number, cellY: number, legRot: Rotation): boolean => {
    if (!isCellBuildable(doc, cellX, cellY, floor)) return true;
    const hit = findBuildingAtCell(doc, cellX, cellY, floor);
    if (!hit) return false;
    const def = getBuildableDef(hit.type);
    if (!def) return true;
    // Allow overwriting collinear same-axis belts, jump over perpendicular belts & all non-belt machines
    if (def.kind === 'belt' && (hit.rotation === legRot || hit.rotation === normalizeRotation(legRot + 2))) {
      return false;
    }
    return true;
  };

  // Split baseSpecs into straight legs (same step direction)
  const legs: BeltCellSpec[][] = [];
  let curLeg: BeltCellSpec[] = [baseSpecs[0]];
  let curDir: [number, number] | null = null;
  for (let i = 1; i < baseSpecs.length; i++) {
    const prev = baseSpecs[i - 1];
    const cur = baseSpecs[i];
    const step: [number, number] = [cur.x - prev.x, cur.y - prev.y];
    if (curDir && (step[0] !== curDir[0] || step[1] !== curDir[1])) {
      legs.push(curLeg);
      curLeg = [prev, cur];
      curDir = step;
    } else {
      curDir = step;
      curLeg.push(cur);
    }
  }
  legs.push(curLeg);

  const result: BeltCellSpec[] = [];
  let pairCounter = 0;

  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    const startIdx = li === 0 ? 0 : 1; // avoid duplicating shared corner tile
    if (leg.length < 3) {
      for (let k = startIdx; k < leg.length; k++) result.push({ ...leg[k], kind: 'belt' });
      continue;
    }
    const legRot = deltaToRotation(leg[1].x - leg[0].x, leg[1].y - leg[0].y);
    const outLeg: BeltCellSpec[] = [];
    let i = startIdx;

    while (i < leg.length) {
      // Look ahead: if next tile is an obstacle and current tile is clear, try to bridge over contiguous obstacles!
      if (i + 2 < leg.length && !isObstacleForLeg(leg[i].x, leg[i].y, legRot) && isObstacleForLeg(leg[i + 1].x, leg[i + 1].y, legRot)) {
        let exitIdx = i + 2;
        while (exitIdx < leg.length && isObstacleForLeg(leg[exitIdx].x, leg[exitIdx].y, legRot) && exitIdx - i <= maxLen) {
          exitIdx += 1;
        }
        if (exitIdx < leg.length && exitIdx - i <= maxLen && !isObstacleForLeg(leg[exitIdx].x, leg[exitIdx].y, legRot)) {
          const pid = pairCounter++;
          outLeg.push({
            x: leg[i].x,
            y: leg[i].y,
            rotation: legRot,
            kind: 'underground-in',
            pairIndex: pid,
            ...(leg[i].isWaypoint ? { isWaypoint: true } : {}),
          });
          outLeg.push({
            x: leg[exitIdx].x,
            y: leg[exitIdx].y,
            rotation: legRot,
            kind: 'underground-out',
            pairIndex: pid,
            ...(leg[exitIdx].isWaypoint ? { isWaypoint: true } : {}),
          });
          i = exitIdx + 1;
          continue;
        }
      }
      outLeg.push({ ...leg[i], kind: 'belt' });
      i += 1;
    }
    for (const s of outLeg) result.push(s);
  }

  return applyEndRotationOverride(result, options.endRotation);
}

/**
 * Planned L-shaped belt path with optional hotkey-triggered (`T`) underground bridging
 * over obstacles along straight legs. NEVER bridges automatically unless `tunnelObstacles` is true!
 */
export function buildPlannedBeltPathWithTunnels(
  doc: BlueprintDocument,
  floor: number,
  start: [number, number],
  end: [number, number],
  options: {
    flipCorner: boolean;
    reverse: boolean;
    fallbackRotation: Rotation;
    tunnelObstacles: boolean;
    endRotation?: Rotation | null;
    maxLength?: number;
  }
): BeltCellSpec[] {
  return buildMultiWaypointBeltPath(doc, floor, [{ cell: start, flipCorner: options.flipCorner }], end, {
    currentFlipCorner: options.flipCorner,
    reverse: options.reverse,
    fallbackRotation: options.fallbackRotation,
    tunnelObstacles: options.tunnelObstacles,
    endRotation: options.endRotation,
    maxLength: options.maxLength,
  });
}

/**
 * Shapez 2 `O` key: Select entire connected conveyor/splitter/underground chain on the same floor.
 */
export function selectConnectedBeltChain(doc: BlueprintDocument, startBuildingId: string): string[] {
  const start = doc.buildings.find((b) => b.id === startBuildingId);
  if (!start) return [];
  const startDef = getBuildableDef(start.type);
  if (!startDef || !['belt', 'splitter', 'balancer', 'underground'].includes(startDef.kind)) {
    return [startBuildingId];
  }

  const visited = new Set<string>([start.id]);
  const queue = [start];
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curDef = getBuildableDef(cur.type);
    if (!curDef) continue;
    const [outDx, outDy] = rotationToDelta(cur.rotation);

    // Check 4 orthogonal neighbors
    for (const [dx, dy] of dirs) {
      const nb = findBuildingAtCell(doc, cur.x + dx, cur.y + dy, cur.floor);
      if (!nb || visited.has(nb.id)) continue;
      const nbDef = getBuildableDef(nb.type);
      if (!nbDef || !['belt', 'splitter', 'balancer', 'underground'].includes(nbDef.kind)) continue;

      const [nbOutDx, nbOutDy] = rotationToDelta(nb.rotation);
      // Connected if cur outputs into nb OR nb outputs into cur
      const curPointsToNb = dx === outDx && dy === outDy;
      const nbPointsToCur = -dx === nbOutDx && -dy === nbOutDy;
      if (curPointsToNb || nbPointsToCur || curDef.kind === 'splitter' || nbDef.kind === 'splitter') {
        visited.add(nb.id);
        queue.push(nb);
      }
    }

    // Jump across underground belt pair
    if (curDef.kind === 'underground') {
      const maxLen = curDef.maxLength ?? 8;
      const searchDir = cur.undergroundMode === 'out' ? [-outDx, -outDy] : [outDx, outDy];
      for (let dist = 1; dist <= maxLen; dist++) {
        const nb = findBuildingAtCell(doc, cur.x + searchDir[0] * dist, cur.y + searchDir[1] * dist, cur.floor);
        if (
          nb &&
          !visited.has(nb.id) &&
          nb.rotation === cur.rotation &&
          getBuildableDef(nb.type)?.kind === 'underground' &&
          nb.undergroundMode !== cur.undergroundMode
        ) {
          visited.add(nb.id);
          queue.push(nb);
          break;
        }
      }
    }
  }

  return Array.from(visited);
}
