import { CATALOG, getBuildableDef, getModuleDef } from './catalog';
import {
  findBuildingsInsideModule,
  findOverlappingBuildings,
  getBuildingSizeCells,
  getModuleBoundsM,
  getModuleSizeUnits,
  isPortToggleable,
  normalizeRotation,
  rotateVec2,
  rotationToDelta,
  STATION_UNIT_M,
  validateBuildingPlacement,
  validateModulePlacement,
} from './geometry';
import type {
  BlueprintDocument,
  BuildableDef,
  PlacedBuilding,
  PlacedModule,
  Rotation,
  SelectionLayerMode,
  SelectionState,
  ViewMode,
} from './types';

function cloneBuildingExtras(b: {
  recipeId?: string;
  label?: string;
  disabledPorts?: number[];
  undergroundMode?: 'in' | 'out';
  undergroundPartnerId?: string;
  priorityIn?: number;
  priorityOut?: number;
  portFilters?: Record<number, string>;
  filterItems?: string[];
}): Partial<PlacedBuilding> {
  const out: Partial<PlacedBuilding> = {};
  if (b.recipeId) out.recipeId = b.recipeId;
  if (b.label) out.label = b.label;
  if (b.disabledPorts && b.disabledPorts.length > 0) out.disabledPorts = [...b.disabledPorts];
  if (b.undergroundMode) out.undergroundMode = b.undergroundMode;
  if (b.undergroundPartnerId) out.undergroundPartnerId = b.undergroundPartnerId;
  if (b.priorityIn !== undefined) out.priorityIn = b.priorityIn;
  if (b.priorityOut !== undefined) out.priorityOut = b.priorityOut;
  if (b.portFilters && Object.keys(b.portFilters).length > 0) out.portFilters = { ...b.portFilters };
  if (b.filterItems && b.filterItems.length > 0) out.filterItems = [...b.filterItems];
  return out;
}

function sanitizeDisabledPorts(def: BuildableDef | undefined, ports?: number[]): number[] | undefined {
  if (!ports || ports.length === 0) return undefined;
  if (!def) return [...new Set(ports)].sort((a, z) => a - z);
  const valid = ports.filter((idx) => {
    const p = def.ports.find((x) => x.index === idx);
    return p ? isPortToggleable(def, p) : false;
  });
  return valid.length > 0 ? [...new Set(valid)].sort((a, z) => a - z) : undefined;
}

/** Remap a building's local port index when mirroring a blueprint horizontally across world X */
function remapPortIndexMirrorX(
  def: BuildableDef | undefined,
  rot: Rotation,
  nextRot: Rotation,
  portIndex: number
): number {
  if (!def) return portIndex;
  const src = def.ports.find((p) => p.index === portIndex);
  if (!src) return portIndex;
  const [wx, wy] = rotateVec2(src.hx, src.hy, rot);
  const [lx, ly] = rotateVec2(-wx, wy, normalizeRotation(4 - nextRot));
  const hit = def.ports.find((p) => p.hx === lx && p.hy === ly);
  return hit ? hit.index : portIndex;
}

let idCounter = 1;
export function createEntityId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}_${rand}`;
}

export function createEmptyBlueprint(name = '未命名空间站'): BlueprintDocument {
  return {
    format: 'station-blueprint-designer',
    formatVersion: 2,
    id: createEntityId('bp'),
    name,
    gameData: {
      buildId: CATALOG.game.buildId,
      catalogVersion: CATALOG.catalogVersion,
    },
    modules: [],
    buildings: [],
  };
}

export interface CommandResult {
  doc: BlueprintDocument;
  changed: boolean;
  message?: string;
  addedModuleIds?: string[];
  addedBuildingIds?: string[];
}

export function placeModuleCmd(
  doc: BlueprintDocument,
  spec: { type: string; gx: number; gy: number; floor: number; rotation: Rotation; label?: string }
): CommandResult {
  const issue = validateModulePlacement(doc, spec);
  if (issue) {
    return { doc, changed: false, message: issue.message };
  }
  const mod: PlacedModule = {
    id: createEntityId('mod'),
    type: spec.type,
    gx: spec.gx,
    gy: spec.gy,
    floor: spec.floor,
    rotation: normalizeRotation(spec.rotation),
    ...(spec.label ? { label: spec.label } : {}),
  };
  return {
    doc: { ...doc, modules: [...doc.modules, mod] },
    changed: true,
    addedModuleIds: [mod.id],
  };
}

export function placeBuildingCmd(
  doc: BlueprintDocument,
  spec: {
    type: string;
    x: number;
    y: number;
    floor: number;
    rotation: Rotation;
    recipeId?: string;
    label?: string;
    disabledPorts?: number[];
    undergroundMode?: 'in' | 'out';
    undergroundPartnerId?: string;
    priorityIn?: number;
    priorityOut?: number;
    portFilters?: Record<number, string>;
    filterItems?: string[];
  },
  options: { allowBeltReplace?: boolean; allowForceReplace?: boolean; preserveEncodedPartner?: boolean } = {}
): CommandResult {
  const issue = validateBuildingPlacement(doc, spec, options);
  if (issue) {
    return { doc, changed: false, message: issue.message };
  }
  const def = getBuildableDef(spec.type)!;
  const [w, d] = getBuildingSizeCells(def, spec.rotation);

  let remaining = doc.buildings;
  const removeIds = new Set<string>();
  if (options.allowForceReplace || (options.allowBeltReplace && def.kind === 'belt')) {
    const overlapping = findOverlappingBuildings(doc, spec.x, spec.y, w, d, spec.floor);
    for (const b of overlapping) {
      if (options.allowForceReplace || getBuildableDef(b.type)?.kind === 'belt') {
        removeIds.add(b.id);
      }
    }
    if (removeIds.size > 0) {
      remaining = doc.buildings
        .filter((b) => !removeIds.has(b.id))
        .map((b) => {
          if (b.undergroundPartnerId && removeIds.has(b.undergroundPartnerId)) {
            const copy = { ...b };
            delete copy.undergroundPartnerId;
            return copy;
          }
          return b;
        });
    }
  }

  const cleanDisabled = sanitizeDisabledPorts(def, spec.disabledPorts);
  const rot = normalizeRotation(spec.rotation);
  const building: PlacedBuilding = {
    id: createEntityId('bld'),
    type: spec.type,
    x: spec.x,
    y: spec.y,
    floor: spec.floor,
    rotation: rot,
    ...cloneBuildingExtras({ ...spec, disabledPorts: cleanDisabled }),
  };

  // Explicit encoding-time pairing for underground belts (supports braided parallel runs on the same straight line!)
  if (def.kind === 'underground' && !options.preserveEncodedPartner) {
    const mode = building.undergroundMode ?? 'in';
    building.undergroundMode = mode;
    const maxLen = def.maxLength ?? 8;
    const [dx, dy] = rotationToDelta(rot);
    const isPartnerInline = (cand: PlacedBuilding): boolean => {
      const cDef = getBuildableDef(cand.type);
      if (!cDef || cDef.kind !== 'underground') return false;
      if (cand.floor !== building.floor || cand.rotation !== rot) return false;
      const cMode = cand.undergroundMode ?? 'in';
      if (cMode === mode) return false;
      const entry = mode === 'in' ? building : cand;
      const exit = mode === 'out' ? building : cand;
      const rx = exit.x - entry.x;
      const ry = exit.y - entry.y;
      const along = rx * dx + ry * dy;
      const perp = Math.abs(rx * dy - ry * dx);
      return perp === 0 && along >= 1 && along <= maxLen;
    };

    let matchedPartnerId: string | undefined;
    if (spec.undergroundPartnerId) {
      const pref = remaining.find((b) => b.id === spec.undergroundPartnerId);
      if (pref && !pref.undergroundPartnerId && isPartnerInline(pref)) {
        matchedPartnerId = pref.id;
      }
    }
    if (!matchedPartnerId) {
      // Auto-bind nearest compatible unpaired same-tier partner inline within maxLength
      let bestDist = maxLen + 1;
      for (const cand of remaining) {
        if (cand.undergroundPartnerId) continue;
        const cDef = getBuildableDef(cand.type);
        if (!cDef || cDef.tier !== def.tier) continue;
        if (!isPartnerInline(cand)) continue;
        const dist = Math.abs(cand.x - building.x) + Math.abs(cand.y - building.y);
        if (dist < bestDist) {
          bestDist = dist;
          matchedPartnerId = cand.id;
        }
      }
    }
    if (matchedPartnerId) {
      building.undergroundPartnerId = matchedPartnerId;
      remaining = remaining.map((b) =>
        b.id === matchedPartnerId ? { ...b, undergroundPartnerId: building.id } : b
      );
    } else {
      delete building.undergroundPartnerId;
    }
  }

  return {
    doc: { ...doc, buildings: [...remaining, building] },
    changed: true,
    addedBuildingIds: [building.id],
  };
}

/** Place an entire belt stroke / planned belt path as a single atomic transaction (shapez 2 instant replace) */
export function placeBeltRunCmd(
  doc: BlueprintDocument,
  beltType: string,
  floor: number,
  segments: Array<{ x: number; y: number; rotation: Rotation }>
): CommandResult {
  if (segments.length === 0) return { doc, changed: false };
  let cur = doc;
  const addedIds: string[] = [];
  for (const seg of segments) {
    const res = placeBuildingCmd(
      cur,
      { type: beltType, x: seg.x, y: seg.y, floor, rotation: seg.rotation },
      { allowBeltReplace: true }
    );
    if (res.changed) {
      cur = res.doc;
      if (res.addedBuildingIds) addedIds.push(...res.addedBuildingIds);
    }
  }
  return {
    doc: cur,
    changed: addedIds.length > 0,
    addedBuildingIds: addedIds,
  };
}

export function deleteSelectionCmd(
  doc: BlueprintDocument,
  selection: SelectionState,
  options: { cascadeBuildingsInModules?: boolean } = { cascadeBuildingsInModules: true }
): CommandResult {
  const modSet = new Set(selection.moduleIds);
  const bldSet = new Set(selection.buildingIds);
  if (modSet.size === 0 && bldSet.size === 0) return { doc, changed: false };

  if (options.cascadeBuildingsInModules) {
    for (const mod of doc.modules) {
      if (!modSet.has(mod.id)) continue;
      for (const inside of findBuildingsInsideModule(doc, mod)) {
        bldSet.add(inside.id);
      }
    }
  }

  const nextModules = doc.modules.filter((m) => !modSet.has(m.id));
  const nextBuildings = doc.buildings
    .filter((b) => !bldSet.has(b.id))
    .map((b) => {
      if (b.undergroundPartnerId && bldSet.has(b.undergroundPartnerId)) {
        const copy = { ...b };
        delete copy.undergroundPartnerId;
        return copy;
      }
      return b;
    });
  const changed = nextModules.length !== doc.modules.length || nextBuildings.length !== doc.buildings.length;
  return {
    doc: changed ? { ...doc, modules: nextModules, buildings: nextBuildings } : doc,
    changed,
  };
}

export function updateBuildingConfigCmd(
  doc: BlueprintDocument,
  buildingIds: string[],
  patch: {
    recipeId?: string | null;
    label?: string | null;
    disabledPorts?: number[];
    undergroundMode?: 'in' | 'out';
    priorityIn?: number | null;
    priorityOut?: number | null;
    portFilters?: Record<number, string> | null;
    filterItems?: string[] | null;
  }
): CommandResult {
  const idSet = new Set(buildingIds);
  if (idSet.size === 0) return { doc, changed: false };
  let changed = false;
  const nextBuildings = doc.buildings.map((b) => {
    if (!idSet.has(b.id)) return b;
    changed = true;
    const next: PlacedBuilding = { ...b };
    if (patch.recipeId !== undefined) {
      if (patch.recipeId === null || patch.recipeId === '') delete next.recipeId;
      else next.recipeId = patch.recipeId;
    }
    if (patch.label !== undefined) {
      if (patch.label === null || patch.label === '') delete next.label;
      else next.label = patch.label;
    }
    if (patch.disabledPorts !== undefined) {
      const def = getBuildableDef(b.type);
      const clean = sanitizeDisabledPorts(def, patch.disabledPorts);
      if (!clean || clean.length === 0) delete next.disabledPorts;
      else next.disabledPorts = clean;
    }
    if (patch.undergroundMode !== undefined) {
      next.undergroundMode = patch.undergroundMode;
    }
    if (patch.priorityIn !== undefined) {
      if (patch.priorityIn === null) delete next.priorityIn;
      else next.priorityIn = patch.priorityIn;
    }
    if (patch.priorityOut !== undefined) {
      if (patch.priorityOut === null) delete next.priorityOut;
      else next.priorityOut = patch.priorityOut;
    }
    if (patch.portFilters !== undefined) {
      if (!patch.portFilters || Object.keys(patch.portFilters).length === 0) delete next.portFilters;
      else next.portFilters = { ...patch.portFilters };
    }
    if (patch.filterItems !== undefined) {
      if (!patch.filterItems || patch.filterItems.length === 0) delete next.filterItems;
      else next.filterItems = Array.from(new Set(patch.filterItems));
    }
    return next;
  });
  return { doc: changed ? { ...doc, buildings: nextBuildings } : doc, changed };
}

export function updateModuleLabelCmd(
  doc: BlueprintDocument,
  moduleId: string,
  label: string
): CommandResult {
  let changed = false;
  const nextModules = doc.modules.map((m) => {
    if (m.id !== moduleId) return m;
    changed = true;
    const next: PlacedModule = { ...m };
    if (!label.trim()) delete next.label;
    else next.label = label.trim();
    return next;
  });
  return { doc: changed ? { ...doc, modules: nextModules } : doc, changed };
}

/** Rotate selected items in place (single building or station module) */
export function rotateSelectionInPlaceCmd(
  doc: BlueprintDocument,
  selection: SelectionState,
  deltaRot: 1 | -1
): CommandResult {
  if (selection.moduleIds.length === 0 && selection.buildingIds.length === 0) {
    return { doc, changed: false };
  }
  let changed = false;
  const modSet = new Set(selection.moduleIds);
  const bldSet = new Set(selection.buildingIds);

  const nextModules = doc.modules.map((m) => {
    if (!modSet.has(m.id)) return m;
    const def = getModuleDef(m.type);
    if (!def || !def.canRotate) return m;
    const nextRot = normalizeRotation(m.rotation + deltaRot);
    const issue = validateModulePlacement(doc, { ...m, rotation: nextRot }, modSet);
    if (issue) return m;
    changed = true;
    return { ...m, rotation: nextRot };
  });

  const nextBuildings = doc.buildings.map((b) => {
    if (!bldSet.has(b.id)) return b;
    const nextRot = normalizeRotation(b.rotation + deltaRot);
    const issue = validateBuildingPlacement(doc, { ...b, rotation: nextRot }, { ignoreBuildingIds: bldSet });
    if (issue) return b;
    changed = true;
    return { ...b, rotation: nextRot };
  });

  return {
    doc: changed ? { ...doc, modules: nextModules, buildings: nextBuildings } : doc,
    changed,
  };
}

/**
 * Multi-layer Box Selection (shapez 2 style!)
 * `boxMinX..boxMaxY` in world meters.
 */
export function boxSelectEntities(
  doc: BlueprintDocument,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  options: {
    viewMode: ViewMode;
    focusFloor: number;
    hideAbove: boolean;
    layerMode: SelectionLayerMode;
  }
): SelectionState {
  const { viewMode, focusFloor, hideAbove, layerMode } = options;

  const floorAllowed = (floor: number, span = 1): boolean => {
    const topFloor = floor + span - 1;
    if (layerMode === 'focus') {
      return focusFloor >= floor && focusFloor <= topFloor;
    }
    if (layerMode === 'visible') {
      return hideAbove ? floor <= focusFloor : true;
    }
    return true; // 'all'
  };

  const moduleIds: string[] = [];
  const buildingIds: string[] = [];

  if (viewMode === 'station') {
    for (const m of doc.modules) {
      const def = getModuleDef(m.type);
      if (!def) continue;
      if (!floorAllowed(m.floor, def.sizeUnits[2])) continue;
      const [x0, y0, x1, y1] = getModuleBoundsM(m, def);
      if (x1 >= box.minX && x0 <= box.maxX && y1 >= box.minY && y0 <= box.maxY) {
        moduleIds.push(m.id);
      }
    }
  } else {
    for (const b of doc.buildings) {
      const def = getBuildableDef(b.type);
      if (!def) continue;
      if (!floorAllowed(b.floor, 1)) continue;
      const [w, d] = getBuildingSizeCells(def, b.rotation);
      if (b.x + w >= box.minX && b.x <= box.maxX && b.y + d >= box.minY && b.y <= box.maxY) {
        buildingIds.push(b.id);
      }
    }
  }

  return { moduleIds, buildingIds };
}

/**
 * Extract current selection into a normalized, portable BlueprintDocument (Scheme A!).
 * - When station modules are selected, all buildings inside them are automatically included!
 * - Coordinates are normalized so min floor = 0 and min X/Y starts cleanly at 0.
 */
export function extractSelectionAsBlueprint(
  doc: BlueprintDocument,
  selection: SelectionState,
  name = '选区蓝图'
): BlueprintDocument | null {
  const modSet = new Set(selection.moduleIds);
  const bldSet = new Set(selection.buildingIds);

  const selectedModules = doc.modules.filter((m) => modSet.has(m.id));
  for (const m of selectedModules) {
    for (const inside of findBuildingsInsideModule(doc, m)) {
      bldSet.add(inside.id);
    }
  }
  const selectedBuildings = doc.buildings.filter((b) => bldSet.has(b.id));
  if (selectedModules.length === 0 && selectedBuildings.length === 0) return null;

  let minFloor = Infinity;
  for (const m of selectedModules) minFloor = Math.min(minFloor, m.floor);
  for (const b of selectedBuildings) minFloor = Math.min(minFloor, b.floor);
  if (!Number.isFinite(minFloor)) minFloor = 0;

  const sanitizeExtractedPartner = (b: PlacedBuilding): Partial<PlacedBuilding> => {
    const extras = cloneBuildingExtras(b);
    if (extras.undergroundPartnerId && !bldSet.has(extras.undergroundPartnerId)) {
      delete extras.undergroundPartnerId;
    }
    return extras;
  };

  if (selectedModules.length > 0) {
    let minGx = Infinity;
    let minGy = Infinity;
    for (const m of selectedModules) {
      minGx = Math.min(minGx, m.gx);
      minGy = Math.min(minGy, m.gy);
    }
    const shiftXM = minGx * STATION_UNIT_M;
    const shiftYM = minGy * STATION_UNIT_M;
    return {
      format: 'station-blueprint-designer',
      formatVersion: 2,
      id: createEntityId('bp'),
      name,
      gameData: { ...doc.gameData },
      modules: selectedModules.map((m) => ({
        ...m,
        gx: m.gx - minGx,
        gy: m.gy - minGy,
        floor: m.floor - minFloor,
      })),
      buildings: selectedBuildings.map((b) => {
        const copy: PlacedBuilding = {
          ...b,
          x: b.x - shiftXM,
          y: b.y - shiftYM,
          floor: b.floor - minFloor,
        };
        delete copy.undergroundPartnerId;
        return { ...copy, ...sanitizeExtractedPartner(b) };
      }),
    };
  }

  // Building-only blueprint
  let minX = Infinity;
  let minY = Infinity;
  for (const b of selectedBuildings) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  return {
    format: 'station-blueprint-designer',
    formatVersion: 2,
    id: createEntityId('bp'),
    name,
    gameData: { ...doc.gameData },
    modules: [],
    buildings: selectedBuildings.map((b) => {
      const copy: PlacedBuilding = {
        ...b,
        x: b.x - minX,
        y: b.y - minY,
        floor: b.floor - minFloor,
      };
      delete copy.undergroundPartnerId;
      return { ...copy, ...sanitizeExtractedPartner(b) };
    }),
  };
}

/** Get bounding box of a blueprint in 1m units (for rotation/mirroring/preview) */
export function getBlueprintBoundsM(bp: BlueprintDocument): { width: number; depth: number; floors: number } {
  let maxX = 0;
  let maxY = 0;
  let maxF = 1;
  for (const m of bp.modules) {
    const def = getModuleDef(m.type);
    const [wu, du, hu] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1, 1];
    maxX = Math.max(maxX, (m.gx + wu) * STATION_UNIT_M);
    maxY = Math.max(maxY, (m.gy + du) * STATION_UNIT_M);
    maxF = Math.max(maxF, m.floor + hu);
  }
  for (const b of bp.buildings) {
    const def = getBuildableDef(b.type);
    const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    maxX = Math.max(maxX, b.x + w);
    maxY = Math.max(maxY, b.y + d);
    maxF = Math.max(maxF, b.floor + 1);
  }
  return { width: Math.max(1, maxX), depth: Math.max(1, maxY), floors: maxF };
}

/** Rotate an entire blueprint 90° CW (`delta=1`) or CCW (`delta=-1`), preserving relative positions */
export function rotateBlueprint(bp: BlueprintDocument, delta: 1 | -1): BlueprintDocument {
  const { width, depth } = getBlueprintBoundsM(bp);
  const wUnits = Math.ceil(width / STATION_UNIT_M);
  const dUnits = Math.ceil(depth / STATION_UNIT_M);
  const cw = delta === 1;

  const modules: PlacedModule[] = bp.modules.map((m) => {
    const def = getModuleDef(m.type);
    const [wu, du] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1];
    // 90° CW in Y-down: (x, y) -> (H - (y + d), x); CCW: (x, y) -> (y, W - (x + w))
    const nextGx = cw ? dUnits - (m.gy + du) : m.gy;
    const nextGy = cw ? m.gx : wUnits - (m.gx + wu);
    return {
      ...m,
      gx: nextGx,
      gy: nextGy,
      rotation: normalizeRotation(m.rotation + delta),
    };
  });

  const baseW = bp.modules.length > 0 ? wUnits * STATION_UNIT_M : width;
  const baseD = bp.modules.length > 0 ? dUnits * STATION_UNIT_M : depth;

  const buildings: PlacedBuilding[] = bp.buildings.map((b) => {
    const def = getBuildableDef(b.type);
    const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    const nextX = cw ? baseD - (b.y + d) : b.y;
    const nextY = cw ? b.x : baseW - (b.x + w);
    return {
      ...b,
      x: nextX,
      y: nextY,
      rotation: normalizeRotation(b.rotation + delta),
      ...cloneBuildingExtras(b),
    };
  });

  return { ...bp, modules, buildings };
}

/** Mirror a blueprint horizontally across X (left <-> right, shapez 2 `M` key!) */
export function mirrorBlueprintX(bp: BlueprintDocument): BlueprintDocument {
  const { width } = getBlueprintBoundsM(bp);
  const wUnits = Math.ceil(width / STATION_UNIT_M);
  const baseW = bp.modules.length > 0 ? wUnits * STATION_UNIT_M : width;

  const flipRotX = (r: Rotation): Rotation => {
    if (r === 0) return 2;
    if (r === 2) return 0;
    return r;
  };

  const modules: PlacedModule[] = bp.modules.map((m) => {
    const def = getModuleDef(m.type);
    const [wu] = def ? getModuleSizeUnits(def, m.rotation) : [1];
    return {
      ...m,
      gx: wUnits - (m.gx + wu),
      rotation: flipRotX(m.rotation),
    };
  });

  const buildings: PlacedBuilding[] = bp.buildings.map((b) => {
    const def = getBuildableDef(b.type);
    const [w] = def ? getBuildingSizeCells(def, b.rotation) : [1];
    const nextRot = flipRotX(b.rotation);
    const remap = (idx: number) => remapPortIndexMirrorX(def, b.rotation, nextRot, idx);
    const remappedFilters = b.portFilters
      ? Object.fromEntries(Object.entries(b.portFilters).map(([k, v]) => [remap(Number(k)), v]))
      : undefined;
    return {
      ...b,
      x: baseW - (b.x + w),
      rotation: nextRot,
      ...cloneBuildingExtras(b),
      ...(b.disabledPorts && b.disabledPorts.length > 0
        ? { disabledPorts: b.disabledPorts.map(remap).sort((a, z) => a - z) }
        : {}),
      ...(b.priorityIn !== undefined ? { priorityIn: remap(b.priorityIn) } : {}),
      ...(b.priorityOut !== undefined ? { priorityOut: remap(b.priorityOut) } : {}),
      ...(remappedFilters ? { portFilters: remappedFilters } : {}),
    };
  });

  return { ...bp, modules, buildings };
}

/**
 * Preview & Stamp a blueprint onto the target document at anchor `(anchorX, anchorY, anchorFloor)`.
 * - If blueprint has station modules, anchor snaps to 16m station grid `(gx, gy)`.
 * - If blueprint is building-only, anchor is 1m cell `(x, y)`.
 */
export function computeStampCandidates(
  bp: BlueprintDocument,
  anchor: { x: number; y: number; floor: number }
): { modules: PlacedModule[]; buildings: PlacedBuilding[] } {
  const hasModules = bp.modules.length > 0;
  const shiftGx = hasModules ? Math.floor(anchor.x / STATION_UNIT_M) : 0;
  const shiftGy = hasModules ? Math.floor(anchor.y / STATION_UNIT_M) : 0;
  const shiftX = hasModules ? shiftGx * STATION_UNIT_M : anchor.x;
  const shiftY = hasModules ? shiftGy * STATION_UNIT_M : anchor.y;

  const modules: PlacedModule[] = bp.modules.map((m) => ({
    ...m,
    id: createEntityId('mod'),
    gx: m.gx + shiftGx,
    gy: m.gy + shiftGy,
    floor: m.floor + anchor.floor,
  }));

  const bldIdMap = new Map<string, string>();
  for (const b of bp.buildings) {
    bldIdMap.set(b.id, createEntityId('bld'));
  }
  const buildings: PlacedBuilding[] = bp.buildings.map((b) => {
    const extras = cloneBuildingExtras(b);
    if (extras.undergroundPartnerId) {
      const remapped = bldIdMap.get(extras.undergroundPartnerId);
      if (remapped) extras.undergroundPartnerId = remapped;
      else delete extras.undergroundPartnerId;
    }
    const copy: PlacedBuilding = {
      ...b,
      id: bldIdMap.get(b.id)!,
      x: b.x + shiftX,
      y: b.y + shiftY,
      floor: b.floor + anchor.floor,
    };
    delete copy.undergroundPartnerId;
    return { ...copy, ...extras };
  });

  return { modules, buildings };
}

export function stampBlueprintCmd(
  doc: BlueprintDocument,
  bp: BlueprintDocument,
  anchor: { x: number; y: number; floor: number },
  options: { forceReplace?: boolean } = {}
): CommandResult {
  const { modules: candMods, buildings: candBlds } = computeStampCandidates(bp, anchor);
  let cur = doc;
  const addedModIds: string[] = [];
  const addedBldIds: string[] = [];

  // Place modules first so buildings inside newly stamped modules have valid floors!
  for (const m of candMods) {
    const res = placeModuleCmd(cur, m);
    if (res.changed) {
      cur = res.doc;
      if (res.addedModuleIds) addedModIds.push(...res.addedModuleIds);
    } else if (!options.forceReplace) {
      return { doc, changed: false, message: res.message || '蓝图模块位置冲突' };
    }
  }

  const candToPlacedId = new Map<string, string>();
  for (const b of candBlds) {
    const res = placeBuildingCmd(cur, b, {
      allowBeltReplace: true,
      allowForceReplace: options.forceReplace,
      preserveEncodedPartner: Boolean(b.undergroundPartnerId),
    });
    if (res.changed) {
      cur = res.doc;
      if (res.addedBuildingIds && res.addedBuildingIds.length > 0) {
        addedBldIds.push(...res.addedBuildingIds);
        candToPlacedId.set(b.id, res.addedBuildingIds[0]);
      }
    } else if (!options.forceReplace) {
      return { doc, changed: false, message: res.message || '蓝图建筑位置冲突或超出地板' };
    }
  }

  // Remap preserved undergroundPartnerId from candidate IDs to final placed building IDs
  if (candToPlacedId.size > 0) {
    const placedSet = new Set(addedBldIds);
    cur = {
      ...cur,
      buildings: cur.buildings.map((b) => {
        if (!placedSet.has(b.id) || !b.undergroundPartnerId) return b;
        const mapped = candToPlacedId.get(b.undergroundPartnerId);
        if (mapped && mapped !== b.id) {
          return { ...b, undergroundPartnerId: mapped };
        }
        const copy = { ...b };
        delete copy.undergroundPartnerId;
        return copy;
      }),
    };
  }

  return {
    doc: cur,
    changed: addedModIds.length > 0 || addedBldIds.length > 0,
    addedModuleIds: addedModIds,
    addedBuildingIds: addedBldIds,
  };
}

/** Immutable Undo/Redo history stack */
export interface HistoryStack {
  past: BlueprintDocument[];
  present: BlueprintDocument;
  future: BlueprintDocument[];
}

export const MAX_HISTORY = 120;

export function createHistory(initial: BlueprintDocument): HistoryStack {
  return { past: [], present: initial, future: [] };
}

export function commitHistory(stack: HistoryStack, next: BlueprintDocument): HistoryStack {
  if (next === stack.present) return stack;
  const past = [...stack.past, stack.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, present: next, future: [] };
}

export function undoHistory(stack: HistoryStack): HistoryStack {
  if (stack.past.length === 0) return stack;
  const prev = stack.past[stack.past.length - 1];
  return {
    past: stack.past.slice(0, -1),
    present: prev,
    future: [stack.present, ...stack.future],
  };
}

export function redoHistory(stack: HistoryStack): HistoryStack {
  if (stack.future.length === 0) return stack;
  const next = stack.future[0];
  return {
    past: [...stack.past, stack.present],
    present: next,
    future: stack.future.slice(1),
  };
}
