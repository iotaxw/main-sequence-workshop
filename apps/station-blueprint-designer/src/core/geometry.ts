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
  moduleById: Map<string, PlacedModule>;
}

export interface BuildingSpatialIndex {
  buildingsByFloor: Map<number, PlacedBuilding[]>;
  buildingCellByFloor: Map<number, Map<number, PlacedBuilding | PlacedBuilding[]>>;
  buildingById: Map<string, PlacedBuilding>;
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
  const moduleById = new Map<string, PlacedModule>();
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    moduleById.set(mod.id, mod);
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

  const index: ModuleSpatialIndex = { modulesByFloor, moduleGridByFloor, moduleById };
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
  const buildingById = new Map<string, PlacedBuilding>();
  const undergrounds: PlacedBuilding[] = [];

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    buildingById.set(b.id, b);
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

  const index: BuildingSpatialIndex = { buildingsByFloor, buildingCellByFloor, buildingById, undergrounds };
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
    moduleById: m.moduleById,
    buildingsByFloor: b.buildingsByFloor,
    buildingCellByFloor: b.buildingCellByFloor,
    buildingById: b.buildingById,
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
  /** Vertical connector facing ('top' when local floorOffset > 0, 'bottom' when 0). */
  verticalFace?: 'top' | 'bottom';
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

export interface Aabb3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Exact Build 26639889 engine `BuildBlueprintUtil::CheckOverlap` 3D AABB (`BlockBounds`) in meters,
 * using the unified class-level actor pivot offset derived from `blockBoundsM` & `sizeUnits`.
 */
export function getModuleEngineBlockBoundsM(mod: PlacedModule, def: StationModuleDef): Aabb3 {
  const [cx, cy] = getModuleCenterM(mod, def);
  const [ox, oy] = getModuleOriginOffsetM(def);
  const [pox, poy] = rotateVec2(-ox, -oy, mod.rotation);
  const px = cx + pox;
  const py = cy + poy;
  const b = def.blockBoundsM;
  if (!b) {
    const [wu, du, hu] = getModuleSizeUnits(def, mod.rotation);
    return {
      minX: mod.gx * STATION_UNIT_M,
      minY: mod.gy * STATION_UNIT_M,
      minZ: mod.floor * FLOOR_HEIGHT_M,
      maxX: (mod.gx + wu) * STATION_UNIT_M,
      maxY: (mod.gy + du) * STATION_UNIT_M,
      maxZ: (mod.floor + hu) * FLOOR_HEIGHT_M,
    };
  }
  const zShiftFloors = getModuleFloorShift(def);
  const pz = (mod.floor + zShiftFloors) * FLOOR_HEIGHT_M;
  const [x1, y1] = rotateVec2(b.minX, b.minY, mod.rotation);
  const [x2, y2] = rotateVec2(b.maxX, b.maxY, mod.rotation);
  return {
    minX: px + Math.min(x1, x2),
    maxX: px + Math.max(x1, x2),
    minY: py + Math.min(y1, y2),
    maxY: py + Math.max(y1, y2),
    minZ: pz + b.minZ,
    maxZ: pz + b.maxZ,
  };
}

/**
 * Class-level ceiling-hung floor shift derived purely from `blockBoundsM` (zero hardcoded module IDs).
 * Matches Rust codec `module_native_pivot_offset` (`z_shift = +2` in 4m units = +1 floor = +8m):
 * modules whose bounding box sits strictly at/below Z=0 (`maxZ <= 0.05 && minZ < -0.5`, e.g. BPO_StationArmour_01B)
 * mount their native actor origin at the ceiling of their canonical floor (`floor + 1`).
 */
export function getModuleFloorShift(def: StationModuleDef): number {
  const b = def.blockBoundsM;
  if (!b) return 0;
  return b.maxZ <= 0.05 && b.minZ < -0.5 ? 1 : 0;
}

export interface DockPortLocalDef {
  portIndex: number;
  localX: number; // meters relative to module geometric center at rot=0
  localY: number;
  localOutDir: Rotation; // outward flow direction into adjacent floor cell at rot=0
}

export interface WorldDockPort {
  moduleId: string;
  portIndex: number;
  portX: number;
  portY: number;
  adjX: number;
  adjY: number;
  outDir: Rotation;
  itemId?: string;
  mode?: 'unload' | 'load';
}

const INDUSTRIAL_DOCK_LOCAL_Y = [5.5, 4.5, 3.5, 2.5, -2.5, -3.5, -4.5, -5.5] as const;
const STANDARD_DOCK_LOCAL_Y = [0.5, -0.5] as const;

/**
 * Build 26639889 binary-verified local dock port layout for freighter docks.
 * Both BPO_Dock_2 (BPO_IndustrialDock::Filters[8]) and BPO_Dock (BPO_StationBlockDock::Filters[2])
 * mount DefaultMachines[0] at GridRotation = 2 (180° flip), so Filters[0..N-1] run Y-descending
 * in module-local coordinates.
 */
export function getModuleDockPortDefs(def: StationModuleDef): DockPortLocalDef[] {
  if (def.id === 'BPO_Dock_2') {
    return INDUSTRIAL_DOCK_LOCAL_Y.map((ly, i) => ({
      portIndex: i,
      localX: -8.5,
      localY: ly,
      localOutDir: 2 as Rotation,
    }));
  }
  if (def.id === 'BPO_Dock') {
    return STANDARD_DOCK_LOCAL_Y.map((ly, i) => ({
      portIndex: i,
      localX: -7.5,
      localY: ly,
      localOutDir: 2 as Rotation,
    }));
  }
  return [];
}

/** Transform a placed dock module's ports into exact 1m world cell & adjacent floor cell coordinates. */
export function getModuleWorldDockPorts(mod: PlacedModule, def: StationModuleDef): WorldDockPort[] {
  const localDefs = getModuleDockPortDefs(def);
  if (localDefs.length === 0) return [];
  const [cx, cy] = getModuleCenterM(mod, def);
  return localDefs.map((ld) => {
    const outDir = normalizeRotation(ld.localOutDir + mod.rotation);
    const [odx, ody] = rotationToDelta(outDir);
    const [rx, ry] = rotateVec2(ld.localX, ld.localY, mod.rotation);
    const portX = Math.floor(cx + rx);
    const portY = Math.floor(cy + ry);
    const cfg = mod.dockPorts?.find((p) => p.portIndex === ld.portIndex);
    return {
      moduleId: mod.id,
      portIndex: ld.portIndex,
      portX,
      portY,
      adjX: portX + odx,
      adjY: portY + ody,
      outDir,
      itemId: cfg?.itemId,
      mode: cfg?.mode,
    };
  });
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
    const isVert = c.type.startsWith('Vertical');
    return {
      moduleId: mod.id,
      type: c.type,
      x: cx + rx,
      y: cy + ry,
      floor: mod.floor + c.floorOffset,
      rotation: normalizeRotation(c.rotation + mod.rotation),
      ...(isVert ? { verticalFace: c.floorOffset > 0 ? 'top' : 'bottom' } : {}),
    };
  });
}

/** Canonical spatial key for a world connector (0.5m resolution). */
export function getWorldConnectorKey(c: Pick<WorldConnector, 'x' | 'y' | 'floor'>): string {
  return `${Math.round(c.x * 2)},${Math.round(c.y * 2)},${c.floor}`;
}

/** Whether two world connectors at the same position/floor mate flush (type + opposite facing). */
export function areWorldConnectorsMated(a: WorldConnector, b: WorldConnector): boolean {
  if (a.type !== b.type) return false;
  if (a.type.startsWith('Vertical')) {
    return a.verticalFace !== undefined && b.verticalFace !== undefined
      ? a.verticalFace !== b.verticalFace
      : true;
  }
  return normalizeRotation(a.rotation + 2) === b.rotation;
}

/**
 * Collect open (not internally mated) world connectors of a candidate module set
 * — shared identically by single-module placement and multi-module blueprint pasting.
 */
export function collectOpenGhostConnectors(ghostModules: readonly PlacedModule[]): WorldConnector[] {
  const raw: WorldConnector[] = [];
  const byKey = new Map<string, WorldConnector[]>();
  for (const mod of ghostModules) {
    const def = getModuleDef(mod.type);
    if (!def) continue;
    for (const c of getModuleWorldConnectors(mod, def)) {
      raw.push(c);
      const k = getWorldConnectorKey(c);
      const list = byKey.get(k);
      if (list) list.push(c);
      else byKey.set(k, [c]);
    }
  }
  return raw.filter((c) => {
    const peers = byKey.get(getWorldConnectorKey(c));
    if (!peers || peers.length < 2) return true;
    return !peers.some((p) => p !== c && areWorldConnectorsMated(c, p));
  });
}

/**
 * Find existing open station connectors that mate flush against `ghostModules`.
 * Used for green alignment lock feedback in both single-module placement and blueprint paste.
 */
export function findMatchedDockConnectors(
  existingConnectors: readonly WorldConnector[],
  existingConnCounts: ReadonlyMap<string, number>,
  ghostModules: readonly PlacedModule[]
): WorldConnector[] {
  const openGhost = collectOpenGhostConnectors(ghostModules);
  if (openGhost.length === 0) return [];
  const ghostByKey = new Map<string, WorldConnector[]>();
  for (const gc of openGhost) {
    const k = getWorldConnectorKey(gc);
    const list = ghostByKey.get(k);
    if (list) list.push(gc);
    else ghostByKey.set(k, [gc]);
  }
  const matched: WorldConnector[] = [];
  for (const c of existingConnectors) {
    const k = getWorldConnectorKey(c);
    if ((existingConnCounts.get(k) ?? 0) >= 2) continue;
    const peers = ghostByKey.get(k);
    if (peers && peers.some((gc) => areWorldConnectorsMated(c, gc))) {
      matched.push(c);
    }
  }
  return matched;
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

const undergroundLinksCache = new WeakMap<PlacedBuilding[], UndergroundLink[]>();

/**
 * Compute underground belt links in O(U) using the per-floor spatial grid (cached by `doc.buildings` identity):
 * 1. Explicit encoded pairs (`undergroundPartnerId`) take priority — supports multiple parallel/braided
 *    underground belts sharing the exact same straight line with zero ambiguity!
 * 2. Fallback for legacy/unencoded blueprints pairs remaining undergrounds same-tier first, then nearest
 *    inline matching 'out' within `maxLength` (default 8 cells).
 */
export function computeUndergroundLinks(doc: BlueprintDocument): UndergroundLink[] {
  const cached = undergroundLinksCache.get(doc.buildings);
  if (cached) return cached;

  const bIdx = getBuildingSpatialIndex(doc.buildings);
  const undergrounds = bIdx.undergrounds;
  if (undergrounds.length === 0) {
    const empty: UndergroundLink[] = [];
    undergroundLinksCache.set(doc.buildings, empty);
    return empty;
  }
  const byId = new Map<string, PlacedBuilding>();
  for (let i = 0; i < undergrounds.length; i++) {
    byId.set(undergrounds[i].id, undergrounds[i]);
  }
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
  for (let i = 0; i < undergrounds.length; i++) {
    const entry = undergrounds[i];
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

  // Pass 2: O(U * maxLen) spatial walk fallback for unencoded undergrounds (prefer same-tier first, then nearest inline)
  for (let i = 0; i < undergrounds.length; i++) {
    const entry = undergrounds[i];
    if (used.has(entry.id) || entry.undergroundMode === 'out') continue;
    const def = getBuildableDef(entry.type)!;
    const [dx, dy] = rotationToDelta(entry.rotation);
    const maxLen = def.maxLength ?? 8;
    const cellMap = bIdx.buildingCellByFloor.get(entry.floor);
    if (!cellMap) continue;

    let bestSame: PlacedBuilding | null = null;
    let bestCross: PlacedBuilding | null = null;

    for (let dist = 1; dist <= maxLen && !bestSame; dist++) {
      const hit = cellMap.get(packCellKey(entry.x + dx * dist, entry.y + dy * dist));
      if (!hit) continue;
      const list = Array.isArray(hit) ? hit : [hit];
      for (let j = 0; j < list.length; j++) {
        const cand = list[j];
        if (cand.id === entry.id || used.has(cand.id)) continue;
        if (cand.rotation !== entry.rotation || cand.undergroundMode !== 'out') continue;
        if (cand.undergroundPartnerId && byId.has(cand.undergroundPartnerId)) continue;
        const candDef = getBuildableDef(cand.type);
        if (!candDef || candDef.kind !== 'underground') continue;
        if (candDef.tier === def.tier) {
          bestSame = cand;
          break;
        }
        if (!bestCross) bestCross = cand;
      }
    }

    const best = bestSame ?? bestCross;
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

  undergroundLinksCache.set(doc.buildings, links);
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

/** World axis along which a reflection flips coordinates ('x': X -> -X, 'y': Y -> -Y). */
export type MirrorAxis = 'x' | 'y';

export function mirrorVec2(x: number, y: number, axis: MirrorAxis): [number, number] {
  return axis === 'x' ? [-x, y] : [x, -y];
}

export function mirrorSide(side: CardinalSide, axis: MirrorAxis): CardinalSide {
  if (axis === 'x') {
    if (side === 'E') return 'W';
    if (side === 'W') return 'E';
    return side;
  }
  if (side === 'N') return 'S';
  if (side === 'S') return 'N';
  return side;
}

/** Reflect a cardinal direction (0=E, 1=S, 2=W, 3=N) across the given world axis. */
export function flipDirection(rot: Rotation, axis: MirrorAxis): Rotation {
  const n = normalizeRotation(rot);
  if (axis === 'x') {
    if (n === 0) return 2;
    if (n === 2) return 0;
    return n;
  }
  if (n === 1) return 3;
  if (n === 3) return 1;
  return n;
}

/**
 * Class-level exact mirrored rotation for any building derived purely from footprint + port geometry
 * (handles diagonal-port buildings like DAT_QuantumSciLab with zero hardcoded IDs).
 */
export function getMirroredBuildingRotation(
  def: BuildableDef | undefined,
  rot: Rotation,
  axis: MirrorAxis
): Rotation {
  const cur = normalizeRotation(rot);
  const base = flipDirection(cur, axis);
  if (!def) return base;
  const [w0, d0] = getBuildingSizeCells(def, cur);
  const candidates: Rotation[] = [base, ...([0, 1, 2, 3] as Rotation[]).filter((r) => r !== base)];

  for (const cand of candidates) {
    const [wc, dc] = getBuildingSizeCells(def, cand);
    if (wc !== w0 || dc !== d0) continue;
    if (def.ports.length === 0) return cand;
    const invCand = normalizeRotation(4 - cand);
    let ok = true;
    for (let i = 0; i < def.ports.length; i++) {
      const p = def.ports[i];
      const [wx, wy] = rotateVec2(p.hx, p.hy, cur);
      const [mx, my] = mirrorVec2(wx, wy, axis);
      const [lx, ly] = rotateVec2(mx, my, invCand);
      const expectedSide = mirrorSide(rotateSide(p.side, cur), axis);
      const hit = def.ports.find(
        (q) => q.hx === lx && q.hy === ly && q.role === p.role && rotateSide(q.side, cand) === expectedSide
      );
      if (!hit) {
        ok = false;
        break;
      }
    }
    if (ok) return cand;
  }
  return base;
}

/**
 * Class-level exact mirrored rotation for any station module derived purely from `sizeUnits`,
 * `blockBoundsM` pivot offset, and `connectors` (handles diagonal modules like BPO_StationCorner_01
 * and asymmetric docks like BPO_Dock_2 with zero hardcoded IDs).
 */
export function getMirroredModuleRotation(
  def: StationModuleDef | undefined,
  rot: Rotation,
  axis: MirrorAxis
): Rotation {
  const cur = normalizeRotation(rot);
  const base = flipDirection(cur, axis);
  if (!def || !def.canRotate) return cur;
  const [wu0, du0] = getModuleSizeUnits(def, cur);
  const [ox, oy] = getModuleOriginOffsetM(def);
  const candidates: Rotation[] = [base, ...([0, 1, 2, 3] as Rotation[]).filter((r) => r !== base)];

  for (const cand of candidates) {
    const [wuc, duc] = getModuleSizeUnits(def, cand);
    if (wuc !== wu0 || duc !== du0) continue;
    if (def.connectors.length === 0) return cand;
    const invCand = normalizeRotation(4 - cand);
    let ok = true;
    for (let i = 0; i < def.connectors.length; i++) {
      const c = def.connectors[i];
      const [wx, wy] = rotateVec2(c.gx * 4 - ox, c.gy * 4 - oy, cur);
      const [mx, my] = mirrorVec2(wx, wy, axis);
      const [tx, ty] = rotateVec2(mx, my, invCand);
      const isVertical = c.type.startsWith('Vertical');
      const mWorldRot = isVertical ? c.rotation : flipDirection(normalizeRotation(c.rotation + cur), axis);
      const expectedLocalRot = isVertical ? c.rotation : normalizeRotation(mWorldRot - cand);
      const hit = def.connectors.find(
        (q) =>
          q.type === c.type &&
          q.floorOffset === c.floorOffset &&
          Math.abs(q.gx * 4 - ox - tx) < 0.1 &&
          Math.abs(q.gy * 4 - oy - ty) < 0.1 &&
          (isVertical || q.rotation === expectedLocalRot)
      );
      if (!hit) {
        ok = false;
        break;
      }
    }
    if (ok) return cand;
  }
  return base;
}

/** Remap a building's local port index when mirroring across `axis` from `rot` to `nextRot`. */
export function remapPortIndexMirror(
  def: BuildableDef | undefined,
  rot: Rotation,
  nextRot: Rotation,
  axis: MirrorAxis,
  portIndex: number
): number {
  if (!def) return portIndex;
  const src = def.ports.find((p) => p.index === portIndex);
  if (!src) return portIndex;
  const [wx, wy] = rotateVec2(src.hx, src.hy, rot);
  const [mx, my] = mirrorVec2(wx, wy, axis);
  const [lx, ly] = rotateVec2(mx, my, normalizeRotation(4 - nextRot));
  const hit = def.ports.find((p) => p.hx === lx && p.hy === ly);
  return hit ? hit.index : portIndex;
}

/** Remap a dock module's per-port filter config when mirroring across `axis` from `rot` to `nextRot`. */
export function remapDockPortsMirror(
  def: StationModuleDef | undefined,
  rot: Rotation,
  nextRot: Rotation,
  axis: MirrorAxis,
  dockPorts: PlacedModule['dockPorts']
): PlacedModule['dockPorts'] {
  if (!dockPorts || dockPorts.length === 0) return undefined;
  const cloned = dockPorts.map((p) => ({ ...p }));
  if (!def) return cloned;
  const portDefs = getModuleDockPortDefs(def);
  if (portDefs.length === 0) return cloned;
  const invNextRot = normalizeRotation(4 - nextRot);
  return cloned
    .map((p) => {
      const src = portDefs.find((pd) => pd.portIndex === p.portIndex);
      if (!src) return p;
      const [wx, wy] = rotateVec2(src.localX, src.localY, rot);
      const [mx, my] = mirrorVec2(wx, wy, axis);
      const [lx, ly] = rotateVec2(mx, my, invNextRot);
      const hit = portDefs.find(
        (pd) => Math.abs(pd.localX - lx) < 0.01 && Math.abs(pd.localY - ly) < 0.01
      );
      return hit ? { ...p, portIndex: hit.portIndex } : p;
    })
    .sort((a, b) => a.portIndex - b.portIndex);
}
