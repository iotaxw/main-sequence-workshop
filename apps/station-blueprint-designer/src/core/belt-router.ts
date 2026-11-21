import { getBuildableDef } from './catalog';
import { deltaToRotation, findBuildingAtCell, normalizeRotation, rotationToDelta } from './geometry';
import type { BlueprintDocument, Rotation } from './types';

export interface BeltCellSpec {
  x: number;
  y: number;
  rotation: Rotation;
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
 * Shapez 2 Belt Planner (Shift + drag): automatic L-shaped path from anchor to target.
 * `flipCorner` toggles X-first vs Y-first (R key during planning).
 * `reverse` reverses flow direction (Alt key during planning).
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
