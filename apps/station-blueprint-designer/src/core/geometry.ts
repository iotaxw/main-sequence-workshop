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

export function packCellKey(x: number, y: number): number {
  return (x + 32768) * 65536 + (y + 32768);
}

export interface ModuleSpatialIndex {
  modulesByFloor: Map<number, PlacedModule[]>;
  moduleGridByFloor: Map<number, Map<number, PlacedModule[]>>;
}

export interface BuildingSpatialIndex {
  buildingsByFloor: Map<number, PlacedBuilding[]>;
  buildingCellByFloor: Map<number, Map<number, PlacedBuilding | PlacedBuilding[]>>;
  undergrounds: PlacedBuilding[];
}

export interface DocSpatialIndex extends ModuleSpatialIndex, BuildingSpatialIndex {}

const moduleIndexCache = new WeakMap<PlacedModule[], ModuleSpatialIndex>();
const buildingIndexCache = new WeakMap<PlacedBuilding[], BuildingSpatialIndex>();

/**
 * Lazily-built O(1) module spatial index keyed on `doc.modules` array identity.
 * Editing buildings NEVER invalidates module spatial indexing!
 */
export function getModuleSpatialIndex(modules: PlacedModule[]): ModuleSpatialIndex {
  const cached = moduleIndexCache.get(modules);
  if (cached) return cached;

  const modulesByFloor = new Map<number, PlacedModule[]>();
  const moduleGridByFloor = new Map<number, Map<number, PlacedModule[]>>();
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    const def = getModuleDef(mod.type);
    const [wu, du, hu] = def ? getModuleSizeUnits(def, mod.rotation) : [1, 1, 1];
    for (let df = 0; df < hu; df++) {
      const f = mod.floor + df;
      let mList = modulesByFloor.get(f);
      if (!mList) {
        mList = [];
        modulesByFloor.set(f, mList);
      }
      mList.push(mod);

      let grid = moduleGridByFloor.get(f);
      if (!grid) {
        grid = new Map();
        moduleGridByFloor.set(f, grid);
      }
      for (let dx = 0; dx < wu; dx++) {
        for (let dy = 0; dy < du; dy++) {
          const k = packCellKey(mod.gx + dx, mod.gy + dy);
          const cellList = grid.get(k);
          if (cellList) cellList.push(mod);
          else grid.set(k, [mod]);
        }
      }
    }
  }

  const index: ModuleSpatialIndex = { modulesByFloor, moduleGridByFloor };
  moduleIndexCache.set(modules, index);
  return index;
}

/**
 * Lazily-built O(1) building spatial index keyed on `doc.buildings` array identity.
 * Editing station modules NEVER invalidates building spatial indexing!
 */
export function getBuildingSpatialIndex(buildings: PlacedBuilding[]): BuildingSpatialIndex {
  const cached = buildingIndexCache.get(buildings);
  if (cached) return cached;

  const buildingsByFloor = new Map<number, PlacedBuilding[]>();
  const buildingCellByFloor = new Map<number, Map<number, PlacedBuilding | PlacedBuilding[]>>();
  const undergrounds: PlacedBuilding[] = [];

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    const def = getBuildableDef(b.type);
    if (!def) continue;
    if (def.kind === 'underground') undergrounds.push(b);

    let bList = buildingsByFloor.get(b.floor);
    if (!bList) {
      bList = [];
      buildingsByFloor.set(b.floor, bList);
    }
    bList.push(b);

    let cellMap = buildingCellByFloor.get(b.floor);
    if (!cellMap) {
      cellMap = new Map();
      buildingCellByFloor.set(b.floor, cellMap);
    }
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        const k = packCellKey(b.x + dx, b.y + dy);
        const cur = cellMap.get(k);
        if (!cur) {
          cellMap.set(k, b);
        } else if (Array.isArray(cur)) {
          cur.push(b);
        } else {
          cellMap.set(k, [cur, b]);
        }
      }
    }
  }

  const index: BuildingSpatialIndex = { buildingsByFloor, buildingCellByFloor, undergrounds };
  buildingIndexCache.set(buildings, index);
  return index;
}

/** Combined spatial index accessor (both halves independently cached by array identity) */
export function getDocSpatialIndex(doc: BlueprintDocument): DocSpatialIndex {
  const m = getModuleSpatialIndex(doc.modules);
  const b = getBuildingSpatialIndex(doc.buildings);
  return {
    modulesByFloor: m.modulesByFloor,
    moduleGridByFloor: m.moduleGridByFloor,
    buildingsByFloor: b.buildingsByFloor,
    buildingCellByFloor: b.buildingCellByFloor,
    undergrounds: b.undergrounds,
  };
}

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

/** Check whether a 1m world cell (cx, cy) on `floor` lies on ANY buildable station surface — O(1) via module spatial index */
export function isCellBuildable(
  doc: BlueprintDocument,
  cellX: number,
  cellY: number,
  floor: number
): PlacedModule | null {
  const idx = getModuleSpatialIndex(doc.modules);
  const grid = idx.moduleGridByFloor.get(floor);
  if (!grid) return null;
  const ugx = Math.floor(cellX / STATION_UNIT_M);
  const ugy = Math.floor(cellY / STATION_UNIT_M);
  const mods = grid.get(packCellKey(ugx, ugy));
  if (!mods) return null;

  const wx = cellX + 0.5;
  const wy = cellY + 0.5;
  for (let i = 0; i < mods.length; i++) {
    const mod = mods[i];
    const def = getModuleDef(mod.type);
    if (!def || !def.hasFactoryFloor) continue;
    const floorOffset = floor - mod.floor;
    if (floorOffset < 0 || floorOffset >= def.sizeUnits[2]) continue;
    let surf: StationFloorSurfaceDef | undefined;
    for (let s = 0; s < def.floors.length; s++) {
      if (def.floors[s].floorOffset === floorOffset) {
        surf = def.floors[s];
        break;
      }
    }
    if (!surf) continue;

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

/** Find station module covering world point (wx, wy) on `floor` — O(1) via module spatial index */
export function findModuleAtWorldPoint(
  doc: BlueprintDocument,
  wx: number,
  wy: number,
  floor: number
): PlacedModule | null {
  const idx = getModuleSpatialIndex(doc.modules);
  const grid = idx.moduleGridByFloor.get(floor);
  if (!grid) return null;
  const ugx = Math.floor(wx / STATION_UNIT_M);
  const ugy = Math.floor(wy / STATION_UNIT_M);
  const candidates = grid.get(packCellKey(ugx, ugy));
  if (candidates) {
    for (let i = 0; i < candidates.length; i++) {
      const mod = candidates[i];
      const def = getModuleDef(mod.type);
      if (!def) continue;
      const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, def);
      if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) {
        return mod;
      }
    }
  }
  // Handle exact maxX / maxY edge clicks
  const onXEdge = wx === ugx * STATION_UNIT_M;
  const onYEdge = wy === ugy * STATION_UNIT_M;
  if (onXEdge || onYEdge) {
    const floorMods = idx.modulesByFloor.get(floor);
    if (floorMods) {
      for (const mod of floorMods) {
        const def = getModuleDef(mod.type);
        if (!def) continue;
        const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, def);
        if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) {
          return mod;
        }
      }
    }
  }
  return null;
}

/** Check if placing a station module collides in 3D station grid with existing modules — O(wu*du*hu) */
export function validateModulePlacement(
  doc: BlueprintDocument,
  candidate: { type: string; gx: number; gy: number; floor: number; rotation: Rotation },
  ignoreModuleIds?: Set<string>
): PlacementIssue | null {
  const def = getModuleDef(candidate.type);
  if (!def) {
    return { kind: 'unknown-type', message: `未知空间站模块类型：${candidate.type}` };
  }
  const [wu, du, hu] = getModuleSizeUnits(def, candidate.rotation);
  const idx = getModuleSpatialIndex(doc.modules);

  for (let df = 0; df < hu; df++) {
    const grid = idx.moduleGridByFloor.get(candidate.floor + df);
    if (!grid) continue;
    for (let dx = 0; dx < wu; dx++) {
      for (let dy = 0; dy < du; dy++) {
        const hits = grid.get(packCellKey(candidate.gx + dx, candidate.gy + dy));
        if (!hits) continue;
        for (let i = 0; i < hits.length; i++) {
          const mod = hits[i];
          if (ignoreModuleIds && ignoreModuleIds.has(mod.id)) continue;
          const mDef = getModuleDef(mod.type);
          return {
            kind: 'module-overlap',
            message: `与已有模块「${mDef?.nameZh ?? mod.type}」空间重叠`,
          };
        }
      }
    }
  }
  return null;
}

/** Check if placing a building is valid (on buildable floor & non-overlapping) — O(w*d) via spatial index */
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

  const idx = getBuildingSpatialIndex(doc.buildings);
  const cellMap = idx.buildingCellByFloor.get(candidate.floor);
  if (!cellMap) return null;

  const ignore = options.ignoreBuildingIds;
  const allowBeltSwap = Boolean(options.allowBeltReplace && def.kind === 'belt');

  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < d; dy++) {
      const entry = cellMap.get(packCellKey(candidate.x + dx, candidate.y + dy));
      if (!entry) continue;
      if (Array.isArray(entry)) {
        for (let i = 0; i < entry.length; i++) {
          const existing = entry[i];
          if (ignore && ignore.has(existing.id)) continue;
          const eDef = getBuildableDef(existing.type);
          if (!eDef) continue;
          if (allowBeltSwap && eDef.kind === 'belt') continue;
          return {
            kind: 'building-overlap',
            message: `与已有「${eDef.nameZh}」占地冲突`,
          };
        }
      } else {
        if (ignore && ignore.has(entry.id)) continue;
        const eDef = getBuildableDef(entry.type);
        if (!eDef) continue;
        if (allowBeltSwap && eDef.kind === 'belt') continue;
        return {
          kind: 'building-overlap',
          message: `与已有「${eDef.nameZh}」占地冲突`,
        };
      }
    }
  }
  return null;
}

/** Find all buildings that overlap a given footprint on a floor — O(w*d) via spatial index */
export function findOverlappingBuildings(
  doc: BlueprintDocument,
  x: number,
  y: number,
  w: number,
  d: number,
  floor: number,
  ignoreIds?: Set<string>
): PlacedBuilding[] {
  const idx = getBuildingSpatialIndex(doc.buildings);
  const cellMap = idx.buildingCellByFloor.get(floor);
  if (!cellMap) return [];

  const hits: PlacedBuilding[] = [];
  const seen = new Set<string>();
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < d; dy++) {
      const entry = cellMap.get(packCellKey(x + dx, y + dy));
      if (!entry) continue;
      if (Array.isArray(entry)) {
        for (let i = 0; i < entry.length; i++) {
          const b = entry[i];
          if ((ignoreIds && ignoreIds.has(b.id)) || seen.has(b.id)) continue;
          seen.add(b.id);
          hits.push(b);
        }
      } else {
        if ((ignoreIds && ignoreIds.has(entry.id)) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        hits.push(entry);
      }
    }
  }
  return hits;
}

/** Find all buildings resting inside a station module's bounds (across its floors) — floor-indexed */
export function findBuildingsInsideModule(doc: BlueprintDocument, mod: PlacedModule): PlacedBuilding[] {
  const def = getModuleDef(mod.type);
  if (!def) return [];
  const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, def);
  const idx = getBuildingSpatialIndex(doc.buildings);
  const out: PlacedBuilding[] = [];
  for (let df = 0; df < def.sizeUnits[2]; df++) {
    const floorBlds = idx.buildingsByFloor.get(mod.floor + df);
    if (!floorBlds) continue;
    for (let i = 0; i < floorBlds.length; i++) {
      const b = floorBlds[i];
      const bDef = getBuildableDef(b.type);
      if (!bDef) continue;
      const [cx, cy] = getBuildingCenterM(b, bDef);
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        out.push(b);
      }
    }
  }
  return out;
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

/** Return whether a given port on `def` supports being enabled/disabled by the player. */
export function isPortToggleable(def: BuildableDef, port: MachinePortDef): boolean {
  if (!def.configurablePorts) return false;
  // Splitter's single input port is fixed always-on; only its 3 output ports can be toggled.
  if (def.kind === 'splitter') return port.role === 'out';
  // Belt Balancer lanes are all fixed always-on (priority & item filter only, no port disable).
  if (def.kind === 'balancer') return false;
  return true;
}

export function getToggleablePorts(def: BuildableDef): MachinePortDef[] {
  return def.ports.filter((p) => isPortToggleable(def, p));
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
    const canToggle = isPortToggleable(def, port);
    return {
      port,
      worldX: wx,
      worldY: wy,
      side,
      outsideCellX: Math.floor(wx + dx * 0.5),
      outsideCellY: Math.floor(wy + dy * 0.5),
      enabled: canToggle ? !disabled.has(port.index) : true,
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

/**
 * Compute underground belt links:
 * 1. Explicit encoded pairs (`undergroundPartnerId`) take priority — supports multiple parallel/braided
 *    underground belts sharing the exact same straight line with zero ambiguity!
 * 2. Fallback for legacy/unencoded blueprints pairs remaining undergrounds same-tier first, then nearest
 *    inline matching 'out' within `maxLength` (default 8 cells).
 */
export function computeUndergroundLinks(doc: BlueprintDocument): UndergroundLink[] {
  const undergrounds = getBuildingSpatialIndex(doc.buildings).undergrounds;
  if (undergrounds.length === 0) return [];
  const byId = new Map(undergrounds.map((u) => [u.id, u]));
  const links: UndergroundLink[] = [];
  const used = new Set<string>();

  const isInlineValid = (entry: PlacedBuilding, exit: PlacedBuilding, maxLen: number): boolean => {
    if (entry.id === exit.id) return false;
    if (entry.floor !== exit.floor || entry.rotation !== exit.rotation) return false;
    if (entry.undergroundMode === 'out' || exit.undergroundMode !== 'out') return false;
    const [dx, dy] = rotationToDelta(entry.rotation);
    const rx = exit.x - entry.x;
    const ry = exit.y - entry.y;
    const along = rx * dx + ry * dy;
    const perp = Math.abs(rx * dy - ry * dx);
    return perp === 0 && along >= 1 && along <= maxLen;
  };

  // Pass 1: Explicit encoded pairs (undergroundPartnerId)
  for (const entry of undergrounds) {
    if (used.has(entry.id) || entry.undergroundMode === 'out' || !entry.undergroundPartnerId) continue;
    const partner = byId.get(entry.undergroundPartnerId);
    if (!partner || used.has(partner.id)) continue;
    const def = getBuildableDef(entry.type)!;
    const maxLen = def.maxLength ?? 8;
    if (!isInlineValid(entry, partner, maxLen)) continue;
    used.add(entry.id);
    used.add(partner.id);
    links.push({
      fromId: entry.id,
      toId: partner.id,
      floor: entry.floor,
      x1: entry.x + 0.5,
      y1: entry.y + 0.5,
      x2: partner.x + 0.5,
      y2: partner.y + 0.5,
      tier: def.tier,
    });
  }

  // Pass 2: Backward-compatible fallback for unencoded undergrounds (prefer same-tier first, then nearest inline)
  for (const entry of undergrounds) {
    if (used.has(entry.id) || entry.undergroundMode === 'out') continue;
    const def = getBuildableDef(entry.type)!;
    const [dx, dy] = rotationToDelta(entry.rotation);
    const maxLen = def.maxLength ?? 8;

    let best: PlacedBuilding | null = null;
    let bestSameTier = false;
    let bestDist = maxLen + 1;
    for (const candidate of undergrounds) {
      if (candidate.id === entry.id || used.has(candidate.id)) continue;
      if (candidate.undergroundPartnerId && byId.has(candidate.undergroundPartnerId)) continue;
      if (!isInlineValid(entry, candidate, maxLen)) continue;
      const candDef = getBuildableDef(candidate.type);
      const sameTier = candDef?.tier === def.tier;
      const along = (candidate.x - entry.x) * dx + (candidate.y - entry.y) * dy;
      if (
        !best ||
        (sameTier && !bestSameTier) ||
        (sameTier === bestSameTier && along < bestDist)
      ) {
        best = candidate;
        bestSameTier = sameTier;
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

/** Find building covering a 1m world cell (x, y) on `floor` — O(1) via spatial index */
export function findBuildingAtCell(
  doc: BlueprintDocument,
  cellX: number,
  cellY: number,
  floor: number
): PlacedBuilding | null {
  const cellMap = getBuildingSpatialIndex(doc.buildings).buildingCellByFloor.get(floor);
  if (!cellMap) return null;
  const entry = cellMap.get(packCellKey(cellX, cellY));
  if (!entry) return null;
  return Array.isArray(entry) ? entry[0] ?? null : entry;
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
