import { getBuildableDef, getModuleDef } from './catalog';
import type {
  BlueprintDocument,
  BuildableDef,
  CardinalSide,
  MachinePortDef,
  PlacedBuilding,
  PlacedModule,
  PlacementIssue,
  Rotation,
  StationFloorSurfaceDef,
  StationModuleDef,
} from './types';

export const STATION_UNIT_M = 16; // 1 station grid unit = 16 meters (= 16 building cells)
export const FLOOR_HEIGHT_M = 8; // 1 station floor = 8 meters (real game step)
export const FLOOR_VISUAL_SPACING = 10; // Clean visual spacing in 3D CAD view

export function normalizeRotation(r: number): Rotation {
  return (((r % 4) + 4) % 4) as Rotation;
}

/** Rotate a 2D vector (x, y) by 90° * rot clockwise in screen-Y-down / world-Z-south convention */
export function rotateVec2(x: number, y: number, rot: Rotation): [number, number] {
  switch (normalizeRotation(rot)) {
    case 0: return [x, y];
    case 1: return [-y, x];
    case 2: return [-x, -y];
    case 3: return [y, -x];
  }
}

export function rotateSide(side: CardinalSide, rot: Rotation): CardinalSide {
  const sides: CardinalSide[] = ['E', 'S', 'W', 'N'];
  const idx = sides.indexOf(side);
  return sides[(idx + normalizeRotation(rot)) % 4];
}

export function sideToDelta(side: CardinalSide): [number, number] {
  switch (side) {
    case 'E': return [1, 0];
    case 'S': return [0, 1];
    case 'W': return [-1, 0];
    case 'N': return [0, -1];
  }
}

export function rotationToDelta(rot: Rotation): [number, number] {
  switch (normalizeRotation(rot)) {
    case 0: return [1, 0];  // E (+X)
    case 1: return [0, 1];  // S (+Y)
    case 2: return [-1, 0]; // W (-X)
    case 3: return [0, -1]; // N (-Y)
  }
}

export function deltaToRotation(dx: number, dy: number): Rotation {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 0 : 2;
  }
  return dy >= 0 ? 1 : 3;
}

/** Get rotated station module footprint [widthUnits, depthUnits, floorSpan] */
export function getModuleSizeUnits(def: StationModuleDef, rotation: Rotation): [number, number, number] {
  const [w, d, h] = def.sizeUnits;
  return rotation % 2 === 0 ? [w, d, h] : [d, w, h];
}

/** Get rotated building footprint [widthCells, depthCells] in 1m units */
export function getBuildingSizeCells(def: BuildableDef, rotation: Rotation): [number, number] {
  const [w, d] = def.size;
  return rotation % 2 === 0 ? [w, d] : [d, w];
}

/** World meter center of a placed module (on its base floor) */
export function getModuleCenterM(mod: PlacedModule, def: StationModuleDef): [number, number] {
  const [wu, du] = getModuleSizeUnits(def, mod.rotation);
  return [
    (mod.gx + wu / 2) * STATION_UNIT_M,
    (mod.gy + du / 2) * STATION_UNIT_M,
  ];
}

/** World meter center of a placed building */
export function getBuildingCenterM(b: PlacedBuilding, def: BuildableDef): [number, number] {
  const [w, d] = getBuildingSizeCells(def, b.rotation);
  return [b.x + w / 2, b.y + d / 2];
}

/** World meter bounds of a placed module: [minX, minY, maxX, maxY] */
export function getModuleBoundsM(mod: PlacedModule, def: StationModuleDef): [number, number, number, number] {
  const [wu, du] = getModuleSizeUnits(def, mod.rotation);
  return [
    mod.gx * STATION_UNIT_M,
    mod.gy * STATION_UNIT_M,
    (mod.gx + wu) * STATION_UNIT_M,
    (mod.gy + du) * STATION_UNIT_M,
  ];
}

export interface WorldConnector {
  moduleId: string;
  type: string;
  x: number; // world meters
  y: number;
  floor: number;
  rotation: Rotation;
}

/**
 * Compute local actor-origin offset [ox, oy] in meters relative to the geometric grid center
 * of a module's `sizeUnits` bounding box (handles asymmetric modules like BPO_Dock_2 and BPO_ShipyardCore_02).
 * World position of a local actor coordinate (ax, ay) is `center + rotate(ax - ox, ay - oy)`.
 */
export function getModuleOriginOffsetM(def: StationModuleDef): [number, number] {
  if (!def.blockBoundsM) return [0, 0];
  const rawOx = def.blockBoundsM.minX + (def.sizeUnits[0] * STATION_UNIT_M) / 2;
  const rawOy = def.blockBoundsM.minY + (def.sizeUnits[1] * STATION_UNIT_M) / 2;
  const ox = Math.abs(rawOx) < 0.5 ? 0 : Math.round(rawOx * 2) / 2;
  const oy = Math.abs(rawOy) < 0.5 ? 0 : Math.round(rawOy * 2) / 2;
  return [ox, oy];
}

/** Transform module connectors into world coordinates */
export function getModuleWorldConnectors(mod: PlacedModule, def: StationModuleDef): WorldConnector[] {
  const [cx, cy] = getModuleCenterM(mod, def);
  const [ox, oy] = getModuleOriginOffsetM(def);
  return def.connectors.map((c) => {
    // Native GridLocation unit = 4m (16m module has edge at ±2 native units = ±8m), shifted to centered module frame
    const lx = c.gx * 4 - ox;
    const ly = c.gy * 4 - oy;
    const [rx, ry] = rotateVec2(lx, ly, mod.rotation);
    return {
      moduleId: mod.id,
      type: c.type,
      x: cx + rx,
      y: cy + ry,
      floor: mod.floor + c.floorOffset,
      rotation: normalizeRotation(c.rotation + mod.rotation),
    };
  });
}

/** Check if a local meter cell center (lx, ly) is buildable on a station surface */
function isLocalCellOnSurface(lx: number, ly: number, surf: StationFloorSurfaceDef, halfW: number, halfD: number): boolean {
  // Check doorways (1m doorway threshold strip between interior and outer edge)
  for (const dw of surf.doorways) {
    if (dw.side === 'E' && lx >= surf.maxX && lx <= halfW && ly >= dw.start && ly <= dw.end) return true;
    if (dw.side === 'W' && lx <= surf.minX && lx >= -halfW && ly >= dw.start && ly <= dw.end) return true;
    if (dw.side === 'S' && ly >= surf.maxY && ly <= halfD && lx >= dw.start && lx <= dw.end) return true;
    if (dw.side === 'N' && ly <= surf.minY && ly >= -halfD && lx >= dw.start && lx <= dw.end) return true;
  }

  if (lx < surf.minX || lx > surf.maxX || ly < surf.minY || ly > surf.maxY) {
    return false;
  }

  if (surf.shape === 'ring') {
    if (
      surf.holeMinX !== undefined &&
      surf.holeMaxX !== undefined &&
      surf.holeMinY !== undefined &&
      surf.holeMaxY !== undefined
    ) {
      if (lx > surf.holeMinX && lx < surf.holeMaxX && ly > surf.holeMinY && ly < surf.holeMaxY) {
        return false;
      }
    }
    return true;
  }

  if (surf.shape === 'corner-ws') {
    // Symmetric 45° panoramic bevel cutting off the (+X, -Y) corner (NE): keep lx - ly <= 3.0
    return lx - ly <= 3.0;
  }

  return true;
}

/** Check whether a 1m world cell (cx, cy) on `floor` lies on ANY buildable station surface */
export function isCellBuildable(
  doc: BlueprintDocument,
  cellX: number,
  cellY: number,
  floor: number
): PlacedModule | null {
  const wx = cellX + 0.5;
  const wy = cellY + 0.5;
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def || !def.hasFactoryFloor) continue;
    const floorOffset = floor - mod.floor;
    if (floorOffset < 0 || floorOffset >= def.sizeUnits[2]) continue;
    const surf = def.floors.find((f) => f.floorOffset === floorOffset);
    if (!surf) continue;

    const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, def);
    if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;

    const [mcx, mcy] = getModuleCenterM(mod, def);
    const invRot = normalizeRotation(4 - mod.rotation);
    const [lx, ly] = rotateVec2(wx - mcx, wy - mcy, invRot);
    const halfW = (def.sizeUnits[0] * STATION_UNIT_M) / 2;
    const halfD = (def.sizeUnits[1] * STATION_UNIT_M) / 2;
    if (isLocalCellOnSurface(lx, ly, surf, halfW, halfD)) {
      return mod;
    }
  }
  return null;
}

/** Find station module covering world point (wx, wy) on `floor` (or nearest spanning floor) */
export function findModuleAtWorldPoint(
  doc: BlueprintDocument,
  wx: number,
  wy: number,
  floor: number
): PlacedModule | null {
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def) continue;
    if (floor < mod.floor || floor >= mod.floor + def.sizeUnits[2]) continue;
    const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, def);
    if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) {
      return mod;
    }
  }
  return null;
}

/** Check if placing a station module collides in 3D station grid with existing modules */
export function validateModulePlacement(
  doc: BlueprintDocument,
  candidate: { type: string; gx: number; gy: number; floor: number; rotation: Rotation },
  ignoreModuleIds: Set<string> = new Set()
): PlacementIssue | null {
  const def = getModuleDef(candidate.type);
  if (!def) {
    return { kind: 'unknown-type', message: `未知空间站模块类型：${candidate.type}` };
  }
  const [wu, du, hu] = getModuleSizeUnits(def, candidate.rotation);
  const cMinX = candidate.gx;
  const cMaxX = candidate.gx + wu;
  const cMinY = candidate.gy;
  const cMaxY = candidate.gy + du;
  const cMinZ = candidate.floor;
  const cMaxZ = candidate.floor + hu;

  for (const mod of doc.modules) {
    if (ignoreModuleIds.has(mod.id)) continue;
    const mDef = getModuleDef(mod.type);
    if (!mDef) continue;
    const [mw, md, mh] = getModuleSizeUnits(mDef, mod.rotation);
    const overlapX = cMinX < mod.gx + mw && cMaxX > mod.gx;
    const overlapY = cMinY < mod.gy + md && cMaxY > mod.gy;
    const overlapZ = cMinZ < mod.floor + mh && cMaxZ > mod.floor;
    if (overlapX && overlapY && overlapZ) {
      return {
        kind: 'module-overlap',
        message: `与已有模块「${mDef.nameZh}」空间重叠`,
      };
    }
  }
  return null;
}

/** Check if placing a building is valid (on buildable floor & non-overlapping) */
export function validateBuildingPlacement(
  doc: BlueprintDocument,
  candidate: { type: string; x: number; y: number; floor: number; rotation: Rotation },
  options: {
    ignoreBuildingIds?: Set<string>;
    allowBeltReplace?: boolean;
    allowForceReplace?: boolean;
  } = {}
): PlacementIssue | null {
  const def = getBuildableDef(candidate.type);
  if (!def) {
    return { kind: 'unknown-type', message: `未知建筑类型：${candidate.type}` };
  }
  const [w, d] = getBuildingSizeCells(def, candidate.rotation);
  const missingCells: Array<[number, number]> = [];
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < d; dy++) {
      if (!isCellBuildable(doc, candidate.x + dx, candidate.y + dy, candidate.floor)) {
        missingCells.push([candidate.x + dx, candidate.y + dy]);
      }
    }
  }
  if (missingCells.length > 0) {
    return {
      kind: 'no-floor',
      message: '超出可建造工厂地板范围（墙体、镂空或无地板）',
      cells: missingCells,
    };
  }

  if (options.allowForceReplace) {
    return null;
  }

  const ignore = options.ignoreBuildingIds ?? new Set<string>();
  for (const existing of doc.buildings) {
    if (existing.floor !== candidate.floor) continue;
    if (ignore.has(existing.id)) continue;
    const eDef = getBuildableDef(existing.type);
    if (!eDef) continue;
    const [ew, ed] = getBuildingSizeCells(eDef, existing.rotation);
    const overlap =
      candidate.x < existing.x + ew &&
      candidate.x + w > existing.x &&
      candidate.y < existing.y + ed &&
      candidate.y + d > existing.y;
    if (overlap) {
      if (options.allowBeltReplace && def.kind === 'belt' && eDef.kind === 'belt') {
        continue;
      }
      return {
        kind: 'building-overlap',
        message: `与已有「${eDef.nameZh}」占地冲突`,
      };
    }
  }
  return null;
}

/** Find all buildings that overlap a given footprint on a floor */
export function findOverlappingBuildings(
  doc: BlueprintDocument,
  x: number,
  y: number,
  w: number,
  d: number,
  floor: number,
  ignoreIds: Set<string> = new Set()
): PlacedBuilding[] {
  const hits: PlacedBuilding[] = [];
  for (const b of doc.buildings) {
    if (b.floor !== floor || ignoreIds.has(b.id)) continue;
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [bw, bd] = getBuildingSizeCells(def, b.rotation);
    if (x < b.x + bw && x + w > b.x && y < b.y + bd && y + d > b.y) {
      hits.push(b);
    }
  }
  return hits;
}

/** Find all buildings resting inside a station module's bounds (across its floors) */
export function findBuildingsInsideModule(doc: BlueprintDocument, mod: PlacedModule): PlacedBuilding[] {
  const def = getModuleDef(mod.type);
  if (!def) return [];
  const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, def);
  const minFloor = mod.floor;
  const maxFloor = mod.floor + def.sizeUnits[2] - 1;
  return doc.buildings.filter((b) => {
    if (b.floor < minFloor || b.floor > maxFloor) return false;
    const bDef = getBuildableDef(b.type);
    if (!bDef) return false;
    const [cx, cy] = getBuildingCenterM(b, bDef);
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
  });
}

export interface WorldMachinePort {
  port: MachinePortDef;
  worldX: number; // exact edge point in world meters
  worldY: number;
  side: CardinalSide;
  outsideCellX: number; // adjacent 1m cell directly outside this port
  outsideCellY: number;
  enabled: boolean;
}

/** Compute world positions and enabled states of all ports on a placed building */
export function getBuildingWorldPorts(b: PlacedBuilding, def: BuildableDef): WorldMachinePort[] {
  const [cx, cy] = getBuildingCenterM(b, def);
  const disabled = new Set(b.disabledPorts ?? []);
  return def.ports.map((port) => {
    const lx = port.hx * 0.5;
    const ly = port.hy * 0.5;
    const [rx, ry] = rotateVec2(lx, ly, b.rotation);
    const side = rotateSide(port.side, b.rotation);
    const [dx, dy] = sideToDelta(side);
    const wx = cx + rx;
    const wy = cy + ry;
    return {
      port,
      worldX: wx,
      worldY: wy,
      side,
      outsideCellX: Math.floor(wx + dx * 0.5),
      outsideCellY: Math.floor(wy + dy * 0.5),
      enabled: !disabled.has(port.index),
    };
  });
}

export interface UndergroundLink {
  fromId: string;
  toId: string;
  floor: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tier: 1 | 2 | 3;
}

/** Pair underground belt entries with nearest matching exits within MaxLength (8 cells) */
export function computeUndergroundLinks(doc: BlueprintDocument): UndergroundLink[] {
  const undergrounds = doc.buildings.filter((b) => getBuildableDef(b.type)?.kind === 'underground');
  const links: UndergroundLink[] = [];
  const used = new Set<string>();

  for (const entry of undergrounds) {
    if (used.has(entry.id)) continue;
    const def = getBuildableDef(entry.type)!;
    if (entry.undergroundMode === 'out') continue;
    const [dx, dy] = rotationToDelta(entry.rotation);
    const maxLen = def.maxLength ?? 8;

    let best: PlacedBuilding | null = null;
    let bestDist = maxLen + 1;
    for (const candidate of undergrounds) {
      if (candidate.id === entry.id || used.has(candidate.id)) continue;
      if (candidate.floor !== entry.floor) continue;
      if (candidate.rotation !== entry.rotation) continue;
      if (candidate.undergroundMode !== 'out') continue;
      const rx = candidate.x - entry.x;
      const ry = candidate.y - entry.y;
      const along = rx * dx + ry * dy;
      const perp = Math.abs(rx * dy - ry * dx);
      if (perp === 0 && along >= 1 && along <= maxLen && along < bestDist) {
        best = candidate;
        bestDist = along;
      }
    }
    if (best) {
      used.add(entry.id);
      used.add(best.id);
      links.push({
        fromId: entry.id,
        toId: best.id,
        floor: entry.floor,
        x1: entry.x + 0.5,
        y1: entry.y + 0.5,
        x2: best.x + 0.5,
        y2: best.y + 0.5,
        tier: def.tier,
      });
    }
  }
  return links;
}

/** Find building covering a 1m world cell (x, y) on `floor` */
export function findBuildingAtCell(
  doc: BlueprintDocument,
  cellX: number,
  cellY: number,
  floor: number
): PlacedBuilding | null {
  for (const b of doc.buildings) {
    if (b.floor !== floor) continue;
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    if (cellX >= b.x && cellX < b.x + w && cellY >= b.y && cellY < b.y + d) {
      return b;
    }
  }
  return null;
}

/** Compute connected floors present in the document */
export function getDocumentFloorRange(doc: BlueprintDocument): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const m of doc.modules) {
    const def = getModuleDef(m.type);
    const span = def?.sizeUnits[2] ?? 1;
    if (m.floor < min) min = m.floor;
    if (m.floor + span - 1 > max) max = m.floor + span - 1;
  }
  for (const b of doc.buildings) {
    if (b.floor < min) min = b.floor;
    if (b.floor > max) max = b.floor;
  }
  return { min, max };
}
