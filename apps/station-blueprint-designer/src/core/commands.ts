import { getMatchingUndergroundType, type BeltCellSpec } from './belt-router';
import { CATALOG, getBuildableDef, getModuleDef } from './catalog';
import {
  findBuildingsInsideModule,
  findOverlappingBuildings,
  getBuildingSizeCells,
  getBuildingSpatialIndex,
  getDocSpatialIndex,
  getFrameGridSpec,
  getMirroredBuildingRotation,
  getMirroredModuleRotation,
  getModuleBoundsM,
  getModuleSizeUnits,
  getModuleSpatialIndex,
  isCellBuildable,
  isCellBuildableOnModule,
  isPortToggleable,
  type MirrorAxis,
  normalizeRotation,
  packCellKey,
  remapDockPortsMirror,
  remapPortIndexMirror,
  rotationToDelta,
  validateBuildingPlacement,
  validateModulePlacement,
} from './geometry';
import type {
  BlueprintCategory,
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

/** Remap a building's port-indexed configuration (disabledPorts, priorityIn/Out, portFilters) across a mirror transform. */
export function mirrorBuildingPortConfig(
  def: BuildableDef | undefined,
  rot: Rotation,
  nextRot: Rotation,
  axis: MirrorAxis,
  cfg: {
    disabledPorts?: number[];
    priorityIn?: number;
    priorityOut?: number;
    portFilters?: Record<number, string>;
  }
): {
  disabledPorts?: number[];
  priorityIn?: number;
  priorityOut?: number;
  portFilters?: Record<number, string>;
} {
  const remap = (idx: number) => remapPortIndexMirror(def, rot, nextRot, axis, idx);
  const out: {
    disabledPorts?: number[];
    priorityIn?: number;
    priorityOut?: number;
    portFilters?: Record<number, string>;
  } = {};
  if (cfg.disabledPorts && cfg.disabledPorts.length > 0) {
    out.disabledPorts = cfg.disabledPorts.map(remap).sort((a, z) => a - z);
  }
  if (cfg.priorityIn !== undefined) {
    out.priorityIn = remap(cfg.priorityIn);
  }
  if (cfg.priorityOut !== undefined) {
    out.priorityOut = remap(cfg.priorityOut);
  }
  if (cfg.portFilters && Object.keys(cfg.portFilters).length > 0) {
    out.portFilters = Object.fromEntries(
      Object.entries(cfg.portFilters).map(([k, v]) => [remap(Number(k)), v])
    );
  }
  return out;
}

let idCounter = 1;
export function createEntityId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}_${rand}`;
}

export function createEmptyBlueprint(
  name = '未命名空间站',
  category: BlueprintCategory = 'station'
): BlueprintDocument {
  return {
    format: 'station-blueprint-designer',
    formatVersion: 2,
    ...(category === 'ship' ? { category: 'ship' as const } : {}),
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

/** Place an entire belt stroke / planned belt path (including optional hotkey underground pairs) as a single O(K) atomic transaction */
export function placeBeltRunCmd(
  doc: BlueprintDocument,
  beltType: string,
  floor: number,
  segments: BeltCellSpec[]
): CommandResult {
  if (segments.length === 0) return { doc, changed: false };
  const def = getBuildableDef(beltType);
  if (!def || def.kind !== 'belt') return { doc, changed: false };
  const ugType = getMatchingUndergroundType(beltType);

  const idx = getDocSpatialIndex(doc);
  const existingFloorMap = idx.buildingCellByFloor.get(floor);
  const canPlaceAt = (seg: BeltCellSpec): { ok: boolean; removeList: string[] } => {
    if (!isCellBuildable(doc, seg.x, seg.y, floor)) return { ok: false, removeList: [] };
    const key = packCellKey(seg.x, seg.y);
    const curEntry = existingFloorMap?.get(key);
    const removeList: string[] = [];
    if (curEntry) {
      if (Array.isArray(curEntry)) {
        for (let j = 0; j < curEntry.length; j++) {
          const eb = curEntry[j];
          if (getBuildableDef(eb.type)?.kind !== 'belt') return { ok: false, removeList: [] };
          removeList.push(eb.id);
        }
      } else {
        if (getBuildableDef(curEntry.type)?.kind !== 'belt') return { ok: false, removeList: [] };
        removeList.push(curEntry.id);
      }
    }
    return { ok: true, removeList };
  };

  // Pre-validate underground IN/OUT pairs so a blocked exit never leaves an orphaned half-tunnel
  const pairSegments = new Map<number, BeltCellSpec[]>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.pairIndex !== undefined) {
      const arr = pairSegments.get(seg.pairIndex) ?? [];
      arr.push(seg);
      pairSegments.set(seg.pairIndex, arr);
    }
  }
  const blockedPairs = new Set<number>();
  for (const [pid, pair] of pairSegments.entries()) {
    if (!ugType || pair.some((s) => !canPlaceAt(s).ok)) {
      blockedPairs.add(pid);
    }
  }

  // Local mutable overlay for cells modified within this stroke
  const addedByKey = new Map<number, PlacedBuilding>();
  const removeIds = new Set<string>();
  const createdByPair = new Map<number, { inBld?: PlacedBuilding; outBld?: PlacedBuilding }>();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.pairIndex !== undefined && blockedPairs.has(seg.pairIndex)) continue;
    const isUg = seg.kind === 'underground-in' || seg.kind === 'underground-out';
    if (isUg && !ugType) continue;

    const check = canPlaceAt(seg);
    if (!check.ok) continue;
    for (const rid of check.removeList) removeIds.add(rid);

    const key = packCellKey(seg.x, seg.y);
    const bld: PlacedBuilding = isUg
      ? {
          id: createEntityId('bld'),
          type: ugType!,
          x: seg.x,
          y: seg.y,
          floor,
          rotation: normalizeRotation(seg.rotation),
          undergroundMode: seg.kind === 'underground-in' ? 'in' : 'out',
        }
      : {
          id: createEntityId('bld'),
          type: beltType,
          x: seg.x,
          y: seg.y,
          floor,
          rotation: normalizeRotation(seg.rotation),
        };
    addedByKey.set(key, bld);

    if (isUg && seg.pairIndex !== undefined) {
      const entry = createdByPair.get(seg.pairIndex) ?? {};
      if (seg.kind === 'underground-in') entry.inBld = bld;
      else entry.outBld = bld;
      createdByPair.set(seg.pairIndex, entry);
    }
  }

  for (const pair of createdByPair.values()) {
    if (pair.inBld && pair.outBld) {
      pair.inBld.undergroundPartnerId = pair.outBld.id;
      pair.outBld.undergroundPartnerId = pair.inBld.id;
    }
  }

  if (addedByKey.size === 0) return { doc, changed: false };

  const addedBuildings = Array.from(addedByKey.values());
  const nextBuildings: PlacedBuilding[] = [];
  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    if (removeIds.has(b.id)) continue;
    nextBuildings.push(b);
  }
  for (let i = 0; i < addedBuildings.length; i++) {
    nextBuildings.push(addedBuildings[i]);
  }

  return {
    doc: { ...doc, buildings: nextBuildings },
    changed: true,
    addedBuildingIds: addedBuildings.map((b) => b.id),
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

export interface ModuleConfigPatch {
  label?: string | null;
  dockName?: string | null;
  dockPorts?: Array<{ portIndex: number; itemId: string; mode: 'unload' | 'load' }> | null;
  miningItem?: string | null;
  recipeId?: string | null;
}

export function updateModuleConfigCmd(
  doc: BlueprintDocument,
  moduleId: string,
  patch: ModuleConfigPatch
): CommandResult {
  let changed = false;
  const nextModules = doc.modules.map((m) => {
    if (m.id !== moduleId) return m;
    changed = true;
    const next: PlacedModule = { ...m };
    if (patch.label !== undefined) {
      if (patch.label === null || !patch.label.trim()) delete next.label;
      else next.label = patch.label.trim();
    }
    if (patch.dockName !== undefined) {
      if (patch.dockName === null || !patch.dockName.trim()) delete next.dockName;
      else next.dockName = patch.dockName.trim();
    }
    if (patch.dockPorts !== undefined) {
      const cleaned = (patch.dockPorts ?? [])
        .filter((p) => Number.isInteger(p.portIndex) && p.portIndex >= 0 && p.itemId.trim().length > 0)
        .map((p) => ({ portIndex: p.portIndex, itemId: p.itemId.trim(), mode: p.mode }))
        .sort((a, b) => a.portIndex - b.portIndex);
      if (cleaned.length === 0) delete next.dockPorts;
      else next.dockPorts = cleaned;
    }
    if (patch.miningItem !== undefined) {
      if (patch.miningItem === null || !patch.miningItem.trim()) delete next.miningItem;
      else next.miningItem = patch.miningItem.trim();
    }
    if (patch.recipeId !== undefined) {
      if (patch.recipeId === null || !patch.recipeId.trim()) delete next.recipeId;
      else next.recipeId = patch.recipeId.trim();
    }
    return next;
  });
  return { doc: changed ? { ...doc, modules: nextModules } : doc, changed };
}

export function updateModuleLabelCmd(
  doc: BlueprintDocument,
  moduleId: string,
  label: string
): CommandResult {
  return updateModuleConfigCmd(doc, moduleId, { label });
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

function isSameNumberArray(a?: number[], b?: number[]): boolean {
  const al = a?.length ?? 0;
  const bl = b?.length ?? 0;
  if (al !== bl) return false;
  for (let i = 0; i < al; i++) {
    if (a![i] !== b![i]) return false;
  }
  return true;
}

function isSamePortFilters(a?: Record<number, string>, b?: Record<number, string>): boolean {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const k = Number(ak[i]);
    if (a![k] !== b?.[k]) return false;
  }
  return true;
}

function isSameDockPorts(
  a?: PlacedModule['dockPorts'],
  b?: PlacedModule['dockPorts']
): boolean {
  const al = a?.length ?? 0;
  const bl = b?.length ?? 0;
  if (al !== bl) return false;
  for (let i = 0; i < al; i++) {
    if (
      a![i].portIndex !== b![i].portIndex ||
      a![i].itemId !== b![i].itemId ||
      a![i].mode !== b![i].mode
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Mirror selected entities in place across `axis` ('x' or 'y') — Shapez 2 `F` / `Shift+F` style!
 * - When station modules are selected, all buildings inside them are automatically mirrored together.
 * - Single-selected top/bottom armour (`BPO_StationArmour_01` <-> `BPO_StationArmour_01B`) flips vertically.
 * - Atomic: validates all floor & collision constraints before committing; rejects with reason on conflict.
 */
export function mirrorSelectionInPlaceCmd(
  doc: BlueprintDocument,
  selection: SelectionState,
  axis: MirrorAxis
): CommandResult {
  const modSet = new Set(selection.moduleIds);
  const bldSet = new Set(selection.buildingIds);
  if (modSet.size === 0 && bldSet.size === 0) {
    return { doc, changed: false };
  }

  const selectedModules = doc.modules.filter((m) => modSet.has(m.id));
  if (
    selectedModules.length === 1 &&
    bldSet.size === 0 &&
    (selectedModules[0].type === 'BPO_StationArmour_01' ||
      selectedModules[0].type === 'BPO_StationArmour_01B')
  ) {
    const target = selectedModules[0];
    const flippedType =
      target.type === 'BPO_StationArmour_01' ? 'BPO_StationArmour_01B' : 'BPO_StationArmour_01';
    return {
      doc: {
        ...doc,
        modules: doc.modules.map((m) => (m.id === target.id ? { ...m, type: flippedType } : m)),
      },
      changed: true,
    };
  }

  for (const m of selectedModules) {
    for (const inside of findBuildingsInsideModule(doc, m)) {
      bldSet.add(inside.id);
    }
  }
  const selectedBuildings = doc.buildings.filter((b) => bldSet.has(b.id));
  if (selectedModules.length === 0 && selectedBuildings.length === 0) {
    return { doc, changed: false };
  }

  let sumGx = 0;
  let sumGy = 0;
  let sumX = 0;
  let sumY = 0;

  if (selectedModules.length > 0) {
    let minGx = Infinity;
    let maxGx = -Infinity;
    let minGy = Infinity;
    let maxGy = -Infinity;
    for (const m of selectedModules) {
      const def = getModuleDef(m.type);
      const [wu, du] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1];
      minGx = Math.min(minGx, m.gx);
      maxGx = Math.max(maxGx, m.gx + wu);
      minGy = Math.min(minGy, m.gy);
      maxGy = Math.max(maxGy, m.gy + du);
    }
    const unitM = getFrameGridSpec(doc.category).unitM;
    sumGx = minGx + maxGx;
    sumGy = minGy + maxGy;
    sumX = sumGx * unitM;
    sumY = sumGy * unitM;
  } else {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const b of selectedBuildings) {
      const def = getBuildableDef(b.type);
      const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x + w);
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y + d);
    }
    sumX = minX + maxX;
    sumY = minY + maxY;
  }

  const mirroredModMap = new Map<string, PlacedModule>();
  let anyChanged = false;

  for (const m of selectedModules) {
    const def = getModuleDef(m.type);
    const [wu, du] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1];
    // For ship modules with native MirrorClass pairs (e.g. L/R thrusters or wings), swap mirrorId!
    const swapMirrorType =
      def?.domain === 'ship' && def.mirrorId && def.canRotate === false
        ? def.mirrorId
        : def?.domain === 'ship' && def.mirrorId && (def.id.endsWith('L') || def.id.endsWith('R'))
          ? def.mirrorId
          : m.type;
    const nextRot =
      def?.domain === 'ship' && def.canRotate === false
        ? m.rotation
        : getMirroredModuleRotation(def, m.rotation, axis);
    const nextGx = axis === 'x' ? sumGx - (m.gx + wu) : m.gx;
    const nextGy = axis === 'y' ? sumGy - (m.gy + du) : m.gy;
    const remappedDockPorts = remapDockPortsMirror(def, m.rotation, nextRot, axis, m.dockPorts);
    const nextMod: PlacedModule = {
      ...m,
      type: swapMirrorType,
      gx: nextGx,
      gy: nextGy,
      rotation: nextRot,
      ...(remappedDockPorts ? { dockPorts: remappedDockPorts } : {}),
    };
    if (
      nextMod.type !== m.type ||
      nextMod.gx !== m.gx ||
      nextMod.gy !== m.gy ||
      nextMod.rotation !== m.rotation ||
      !isSameDockPorts(nextMod.dockPorts, m.dockPorts)
    ) {
      anyChanged = true;
    }
    mirroredModMap.set(m.id, nextMod);
  }

  // Validate mirrored modules against background modules outside selection
  for (const nm of mirroredModMap.values()) {
    const issue = validateModulePlacement(doc, nm, modSet);
    if (issue) {
      return { doc, changed: false, message: issue.message };
    }
  }

  const nextModules =
    mirroredModMap.size > 0
      ? doc.modules.map((m) => mirroredModMap.get(m.id) ?? m)
      : doc.modules;
  const docWithNextMods: BlueprintDocument =
    mirroredModMap.size > 0 ? { ...doc, modules: nextModules } : doc;

  const mirroredBldMap = new Map<string, PlacedBuilding>();
  for (const b of selectedBuildings) {
    const def = getBuildableDef(b.type);
    const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    const nextRot = getMirroredBuildingRotation(def, b.rotation, axis);
    const nextX = axis === 'x' ? sumX - (b.x + w) : b.x;
    const nextY = axis === 'y' ? sumY - (b.y + d) : b.y;
    const remapped = mirrorBuildingPortConfig(def, b.rotation, nextRot, axis, b);
    const nextBld: PlacedBuilding = {
      ...b,
      x: nextX,
      y: nextY,
      rotation: nextRot,
      ...cloneBuildingExtras(b),
      ...remapped,
    };
    const issue = validateBuildingPlacement(docWithNextMods, nextBld, { ignoreBuildingIds: bldSet });
    if (issue) {
      return { doc, changed: false, message: issue.message };
    }
    if (
      nextBld.x !== b.x ||
      nextBld.y !== b.y ||
      nextBld.rotation !== b.rotation ||
      nextBld.priorityIn !== b.priorityIn ||
      nextBld.priorityOut !== b.priorityOut ||
      !isSameNumberArray(nextBld.disabledPorts, b.disabledPorts) ||
      !isSamePortFilters(nextBld.portFilters, b.portFilters)
    ) {
      anyChanged = true;
    }
    mirroredBldMap.set(b.id, nextBld);
  }

  if (!anyChanged) {
    return { doc, changed: false };
  }

  // Unlink cross-boundary underground belt pairs that are no longer inline after mirroring
  const bldById = new Map<string, PlacedBuilding>();
  for (const b of doc.buildings) {
    bldById.set(b.id, mirroredBldMap.get(b.id) ?? b);
  }
  const unlinkIds = new Set<string>();
  for (const nb of mirroredBldMap.values()) {
    if (!nb.undergroundPartnerId || bldSet.has(nb.undergroundPartnerId)) continue;
    const partner = bldById.get(nb.undergroundPartnerId);
    const def = getBuildableDef(nb.type);
    if (!partner || !def || def.kind !== 'underground') {
      unlinkIds.add(nb.id);
      if (partner) unlinkIds.add(partner.id);
      continue;
    }
    const maxLen = def.maxLength ?? 8;
    const mode = nb.undergroundMode ?? 'in';
    const [dx, dy] = rotationToDelta(nb.rotation);
    const entry = mode === 'in' ? nb : partner;
    const exit = mode === 'out' ? nb : partner;
    const rx = exit.x - entry.x;
    const ry = exit.y - entry.y;
    const along = rx * dx + ry * dy;
    const perp = Math.abs(rx * dy - ry * dx);
    if (partner.floor !== nb.floor || partner.rotation !== nb.rotation || perp !== 0 || along < 1 || along > maxLen) {
      unlinkIds.add(nb.id);
      unlinkIds.add(partner.id);
    }
  }

  const nextBuildings = doc.buildings.map((b) => {
    const cur = mirroredBldMap.get(b.id) ?? b;
    if (unlinkIds.has(cur.id) && cur.undergroundPartnerId) {
      const copy = { ...cur };
      delete copy.undergroundPartnerId;
      return copy;
    }
    return cur;
  });

  return {
    doc: { ...doc, modules: nextModules, buildings: nextBuildings },
    changed: true,
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

  const isShip = doc.category === 'ship';
  const floorAllowed = (floor: number, span = 1): boolean => {
    const topFloor = floor + span - 1;
    if (layerMode === 'focus') {
      return focusFloor >= floor && focusFloor <= topFloor;
    }
    if (layerMode === 'visible') {
      if (isShip) {
        return hideAbove ? focusFloor >= floor && focusFloor <= topFloor : true;
      }
      return hideAbove ? floor <= focusFloor : true;
    }
    return true; // 'all'
  };

  const moduleIds: string[] = [];
  const buildingIds: string[] = [];

  if (viewMode === 'station') {
    if (layerMode === 'focus') {
      const floorMods = getModuleSpatialIndex(doc.modules).modulesByFloor.get(focusFloor);
      if (floorMods) {
        const seen = new Set<string>();
        for (let i = 0; i < floorMods.length; i++) {
          const m = floorMods[i];
          if (seen.has(m.id)) continue;
          const def = getModuleDef(m.type);
          if (!def) continue;
          const [x0, y0, x1, y1] = getModuleBoundsM(m, def);
          if (x1 >= box.minX && x0 <= box.maxX && y1 >= box.minY && y0 <= box.maxY) {
            seen.add(m.id);
            moduleIds.push(m.id);
          }
        }
      }
    } else {
      for (let i = 0; i < doc.modules.length; i++) {
        const m = doc.modules[i];
        const def = getModuleDef(m.type);
        if (!def) continue;
        if (!floorAllowed(m.floor, def.sizeUnits[2])) continue;
        const [x0, y0, x1, y1] = getModuleBoundsM(m, def);
        if (x1 >= box.minX && x0 <= box.maxX && y1 >= box.minY && y0 <= box.maxY) {
          moduleIds.push(m.id);
        }
      }
    }
  } else {
    const bIdx = getBuildingSpatialIndex(doc.buildings);
    // Query only 64m spatial chunks intersecting the selection rectangle (padded by max building footprint 16m
    // on the min edge since buildings are bucketed by their anchor (b.x, b.y)) -> O(chunks in box), zero duplicates!
    const minCx = Math.floor((box.minX - 16) / 64);
    const maxCx = Math.floor(box.maxX / 64);
    const minCy = Math.floor((box.minY - 16) / 64);
    const maxCy = Math.floor(box.maxY / 64);
    const chunkSpan = (maxCx - minCx + 1) * (maxCy - minCy + 1);

    const checkList = (list: PlacedBuilding[]) => {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const def = getBuildableDef(b.type);
        if (!def) continue;
        const [w, d] = getBuildingSizeCells(def, b.rotation);
        if (b.x + w >= box.minX && b.x <= box.maxX && b.y + d >= box.minY && b.y <= box.maxY) {
          buildingIds.push(b.id);
        }
      }
    };

    const checkFloor = (floor: number) => {
      const floorChunks = bIdx.buildingsByFloorChunk.get(floor);
      if (floorChunks && chunkSpan <= floorChunks.size) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const cxBase = (cx + 1024) * 2048;
          for (let cy = minCy; cy <= maxCy; cy++) {
            const list = floorChunks.get(cxBase + (cy + 1024));
            if (list) checkList(list);
          }
        }
        return;
      }
      const floorBlds = bIdx.buildingsByFloor.get(floor);
      if (floorBlds) checkList(floorBlds);
    };

    if (layerMode === 'focus') {
      checkFloor(focusFloor);
    } else {
      for (const f of bIdx.buildingsByFloor.keys()) {
        if (!floorAllowed(f, 1)) continue;
        checkFloor(f);
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
    const unitM = getFrameGridSpec(doc.category).unitM;
    let minGx = Infinity;
    let minGy = Infinity;
    for (const m of selectedModules) {
      minGx = Math.min(minGx, m.gx);
      minGy = Math.min(minGy, m.gy);
    }
    const shiftXM = minGx * unitM;
    const shiftYM = minGy * unitM;
    return {
      format: 'station-blueprint-designer',
      formatVersion: 2,
      ...(doc.category === 'ship' ? { category: 'ship' as const } : {}),
      id: createEntityId('bp'),
      name,
      gameData: { ...doc.gameData },
      modules: selectedModules.map((m) => ({
        ...m,
        gx: m.gx - minGx,
        gy: m.gy - minGy,
        floor: m.floor - minFloor,
        ...(m.dockPorts ? { dockPorts: m.dockPorts.map((p) => ({ ...p })) } : {}),
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

const blueprintBoundsCache = new WeakMap<
  BlueprintDocument,
  { width: number; depth: number; floors: number }
>();

/** Get bounding box of a blueprint in 1m units (for rotation/mirroring/preview) */
export function getBlueprintBoundsM(bp: BlueprintDocument): { width: number; depth: number; floors: number } {
  const cached = blueprintBoundsCache.get(bp);
  if (cached) return cached;
  const unitM = getFrameGridSpec(bp.category).unitM;
  let maxX = 0;
  let maxY = 0;
  let maxF = 1;
  for (const m of bp.modules) {
    const def = getModuleDef(m.type);
    const [wu, du, hu] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1, 1];
    maxX = Math.max(maxX, (m.gx + wu) * unitM);
    maxY = Math.max(maxY, (m.gy + du) * unitM);
    maxF = Math.max(maxF, m.floor + hu);
  }
  for (const b of bp.buildings) {
    const def = getBuildableDef(b.type);
    const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    maxX = Math.max(maxX, b.x + w);
    maxY = Math.max(maxY, b.y + d);
    maxF = Math.max(maxF, b.floor + 1);
  }
  const bounds = { width: Math.max(1, maxX), depth: Math.max(1, maxY), floors: maxF };
  blueprintBoundsCache.set(bp, bounds);
  return bounds;
}

/** Rotate an entire blueprint 90° CW (`delta=1`) or CCW (`delta=-1`), preserving relative positions */
export function rotateBlueprint(bp: BlueprintDocument, delta: 1 | -1): BlueprintDocument {
  const unitM = getFrameGridSpec(bp.category).unitM;
  const { width, depth } = getBlueprintBoundsM(bp);
  const wUnits = Math.ceil(width / unitM);
  const dUnits = Math.ceil(depth / unitM);
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

  const baseW = bp.modules.length > 0 ? wUnits * unitM : width;
  const baseD = bp.modules.length > 0 ? dUnits * unitM : depth;

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

/**
 * Mirror an entire blueprint across world `axis` ('x' = E<->W, 'y' = N<->S) — Shapez 2 `F` / `Shift+F`!
 * Preserves exact geometric symmetry for all 27 modules & 36 buildings (including diagonal corners,
 * Quantum Sci Lab, asymmetric docks, splitter/balancer port configs, and underground pairs).
 */
export function mirrorBlueprint(bp: BlueprintDocument, axis: MirrorAxis = 'x'): BlueprintDocument {
  const unitM = getFrameGridSpec(bp.category).unitM;
  const { width, depth } = getBlueprintBoundsM(bp);
  const wUnits = Math.ceil(width / unitM);
  const dUnits = Math.ceil(depth / unitM);
  const baseW = bp.modules.length > 0 ? wUnits * unitM : width;
  const baseD = bp.modules.length > 0 ? dUnits * unitM : depth;

  const modules: PlacedModule[] = bp.modules.map((m) => {
    const def = getModuleDef(m.type);
    const [wu, du] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1];
    const swapMirrorType =
      def?.domain === 'ship' && def.mirrorId && (def.canRotate === false || def.id.endsWith('L') || def.id.endsWith('R'))
        ? def.mirrorId
        : m.type;
    const nextRot =
      def?.domain === 'ship' && def.canRotate === false
        ? m.rotation
        : getMirroredModuleRotation(def, m.rotation, axis);
    const remappedDockPorts = remapDockPortsMirror(def, m.rotation, nextRot, axis, m.dockPorts);
    return {
      ...m,
      type: swapMirrorType,
      gx: axis === 'x' ? wUnits - (m.gx + wu) : m.gx,
      gy: axis === 'y' ? dUnits - (m.gy + du) : m.gy,
      rotation: nextRot,
      ...(remappedDockPorts ? { dockPorts: remappedDockPorts } : {}),
    };
  });

  const buildings: PlacedBuilding[] = bp.buildings.map((b) => {
    const def = getBuildableDef(b.type);
    const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
    const nextRot = getMirroredBuildingRotation(def, b.rotation, axis);
    const remapped = mirrorBuildingPortConfig(def, b.rotation, nextRot, axis, b);
    return {
      ...b,
      x: axis === 'x' ? baseW - (b.x + w) : b.x,
      y: axis === 'y' ? baseD - (b.y + d) : b.y,
      rotation: nextRot,
      ...cloneBuildingExtras(b),
      ...remapped,
    };
  });

  return { ...bp, modules, buildings };
}

/** Mirror a blueprint horizontally across world X (compat alias for `mirrorBlueprint(bp, 'x')`). */
export function mirrorBlueprintX(bp: BlueprintDocument): BlueprintDocument {
  return mirrorBlueprint(bp, 'x');
}

/**
 * Preview & Stamp a blueprint onto the target document at anchor `(anchorX, anchorY, anchorFloor)`.
 * - If blueprint has modules, anchor snaps to frame grid `(gx, gy)` (16m station / 8m ship).
 * - If blueprint is building-only, anchor is 1m cell `(x, y)`.
 */
export function computeStampCandidates(
  bp: BlueprintDocument,
  anchor: { x: number; y: number; floor: number }
): { modules: PlacedModule[]; buildings: PlacedBuilding[] } {
  const unitM = getFrameGridSpec(bp.category).unitM;
  const hasModules = bp.modules.length > 0;
  const shiftGx = hasModules ? Math.floor(anchor.x / unitM) : 0;
  const shiftGy = hasModules ? Math.floor(anchor.y / unitM) : 0;
  const shiftX = hasModules ? shiftGx * unitM : anchor.x;
  const shiftY = hasModules ? shiftGy * unitM : anchor.y;

  const modules: PlacedModule[] = bp.modules.map((m) => ({
    ...m,
    id: createEntityId('mod'),
    gx: m.gx + shiftGx,
    gy: m.gy + shiftGy,
    floor: m.floor + anchor.floor,
    ...(m.dockPorts ? { dockPorts: m.dockPorts.map((p) => ({ ...p })) } : {}),
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

export interface StampPlacementValidation {
  moduleIssues: Array<string | null>;
  buildingIssues: Array<string | null>;
  message: string | null;
}

export function validateStampBlueprintPlacement(
  doc: BlueprintDocument,
  bp: BlueprintDocument,
  anchor: { x: number; y: number; floor: number },
  options: { forceReplace?: boolean } = {}
): StampPlacementValidation {
  const unitM = getFrameGridSpec(doc.category).unitM;
  const forceReplace = Boolean(options.forceReplace);
  const hasModules = bp.modules.length > 0;
  const shiftGx = hasModules ? Math.floor(anchor.x / unitM) : 0;
  const shiftGy = hasModules ? Math.floor(anchor.y / unitM) : 0;
  const shiftX = hasModules ? shiftGx * unitM : anchor.x;
  const shiftY = hasModules ? shiftGy * unitM : anchor.y;
  const moduleOffset = { gx: shiftGx, gy: shiftGy, floor: anchor.floor };
  const moduleIssues: Array<string | null> = new Array(bp.modules.length).fill(null);
  const buildingIssues: Array<string | null> = new Array(bp.buildings.length).fill(null);
  let message: string | null = null;
  const recordIssue = (issues: Array<string | null>, index: number, issue: string): void => {
    issues[index] = issue;
    if (!forceReplace && message === null) message = issue;
  };

  const baseIdx = getDocSpatialIndex(doc);
  const ghostModGridByFloor = new Map<number, Map<number, PlacedModule[]>>();
  for (let i = 0; i < bp.modules.length; i++) {
    const m = bp.modules[i];
    const def = getModuleDef(m.type);
    if (!def) {
      recordIssue(moduleIssues, i, `未知空间站模块类型：${m.type}`);
      continue;
    }
    const gx = m.gx + shiftGx;
    const gy = m.gy + shiftGy;
    const floor = m.floor + anchor.floor;
    const [wu, du, hu] = getModuleSizeUnits(def, m.rotation);
    let conflictMsg: string | null = null;
    for (let df = 0; df < hu && !conflictMsg; df++) {
      const f = floor + df;
      const baseGrid = baseIdx.moduleGridByFloor.get(f);
      const localGrid = ghostModGridByFloor.get(f);
      for (let dx = 0; dx < wu && !conflictMsg; dx++) {
        for (let dy = 0; dy < du; dy++) {
          const k = packCellKey(gx + dx, gy + dy);
          if (localGrid?.has(k)) {
            conflictMsg = '蓝图内部模块位置重叠';
            break;
          }
          const hits = baseGrid?.get(k);
          if (hits && hits.length > 0) {
            const mDef = getModuleDef(hits[0].type);
            conflictMsg = `与已有模块「${mDef?.nameZh ?? hits[0].type}」空间重叠`;
            break;
          }
        }
      }
    }
    if (conflictMsg) {
      recordIssue(moduleIssues, i, conflictMsg);
      continue;
    }

    for (let df = 0; df < hu; df++) {
      const f = floor + df;
      let grid = ghostModGridByFloor.get(f);
      if (!grid) {
        grid = new Map();
        ghostModGridByFloor.set(f, grid);
      }
      for (let dx = 0; dx < wu; dx++) {
        for (let dy = 0; dy < du; dy++) {
          const k = packCellKey(gx + dx, gy + dy);
          const list = grid.get(k);
          if (list) list.push(m);
          else grid.set(k, [m]);
        }
      }
    }
  }

  const isOnStampFloor = (x: number, y: number, floor: number): boolean => {
    if (isCellBuildable(doc, x, y, floor)) return true;
    const grid = ghostModGridByFloor.get(floor);
    const candidates = grid?.get(packCellKey(Math.floor(x / unitM), Math.floor(y / unitM)));
    if (!candidates) return false;
    for (const m of candidates) {
      const def = getModuleDef(m.type);
      if (def && isCellBuildableOnModule(m, def, x, y, floor, moduleOffset)) return true;
    }
    return false;
  };

  interface LocalStampBuilding {
    def: BuildableDef;
    active: boolean;
  }
  const removeIds = new Set<string>();
  const addedBldByCell = new Map<number, Map<number, LocalStampBuilding>>();
  for (let i = 0; i < bp.buildings.length; i++) {
    const b = bp.buildings[i];
    const def = getBuildableDef(b.type);
    if (!def) {
      recordIssue(buildingIssues, i, `未知建筑类型：${b.type}`);
      continue;
    }
    const x = b.x + shiftX;
    const y = b.y + shiftY;
    const floor = b.floor + anchor.floor;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    let floorOk = true;
    for (let dx = 0; dx < w && floorOk; dx++) {
      for (let dy = 0; dy < d; dy++) {
        if (!isOnStampFloor(x + dx, y + dy, floor)) {
          floorOk = false;
          break;
        }
      }
    }
    if (!floorOk) {
      recordIssue(buildingIssues, i, '超出可建造工厂地板范围（墙体、镂空或无地板）');
      continue;
    }

    const baseFloorMap = baseIdx.buildingCellByFloor.get(floor);
    const localFloorMap = addedBldByCell.get(floor);
    const isBelt = def.kind === 'belt';
    const localToReplace: LocalStampBuilding[] = [];
    const baseToReplace: string[] = [];
    let conflictMsg: string | null = null;
    for (let dx = 0; dx < w && !conflictMsg; dx++) {
      for (let dy = 0; dy < d; dy++) {
        const k = packCellKey(x + dx, y + dy);
        const localHit = localFloorMap?.get(k);
        if (localHit?.active) {
          if (forceReplace || (isBelt && localHit.def.kind === 'belt')) {
            localToReplace.push(localHit);
          } else {
            conflictMsg = `与已有「${localHit.def.nameZh}」占地冲突`;
            break;
          }
        }
        const baseHit = baseFloorMap?.get(k);
        if (baseHit) {
          if (Array.isArray(baseHit)) {
            for (const existing of baseHit) {
              if (removeIds.has(existing.id)) continue;
              const eDef = getBuildableDef(existing.type);
              if (forceReplace || (isBelt && eDef?.kind === 'belt')) {
                baseToReplace.push(existing.id);
              } else {
                conflictMsg = `与已有「${eDef?.nameZh ?? existing.type}」占地冲突`;
                break;
              }
            }
          } else if (!removeIds.has(baseHit.id)) {
            const eDef = getBuildableDef(baseHit.type);
            if (forceReplace || (isBelt && eDef?.kind === 'belt')) {
              baseToReplace.push(baseHit.id);
            } else {
              conflictMsg = `与已有「${eDef?.nameZh ?? baseHit.type}」占地冲突`;
              break;
            }
          }
        }
      }
    }
    if (conflictMsg) {
      recordIssue(buildingIssues, i, conflictMsg);
      continue;
    }

    for (const local of localToReplace) local.active = false;
    for (const id of baseToReplace) removeIds.add(id);
    const placed: LocalStampBuilding = { def, active: true };
    let targetFloorMap = localFloorMap;
    if (!targetFloorMap) {
      targetFloorMap = new Map();
      addedBldByCell.set(floor, targetFloorMap);
    }
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        targetFloorMap.set(packCellKey(x + dx, y + dy), placed);
      }
    }
  }

  return { moduleIssues, buildingIssues, message };
}

export function stampBlueprintCmd(
  doc: BlueprintDocument,
  bp: BlueprintDocument,
  anchor: { x: number; y: number; floor: number },
  options: { forceReplace?: boolean } = {}
): CommandResult {
  const forceReplace = Boolean(options.forceReplace);
  if (!forceReplace) {
    const validation = validateStampBlueprintPlacement(doc, bp, anchor);
    if (validation.message) return { doc, changed: false, message: validation.message };
  }
  const { modules: candMods, buildings: candBlds } = computeStampCandidates(bp, anchor);

  // 1. Validate & accumulate station modules in one pass using spatial grid
  const baseIdx = getDocSpatialIndex(doc);
  const addedMods: PlacedModule[] = [];
  const addedModGridByFloor = new Map<number, Set<number>>();

  for (let i = 0; i < candMods.length; i++) {
    const m = candMods[i];
    const def = getModuleDef(m.type);
    if (!def) {
      if (!forceReplace) return { doc, changed: false, message: `未知空间站模块类型：${m.type}` };
      continue;
    }
    const [wu, du, hu] = getModuleSizeUnits(def, m.rotation);
    let conflictMsg: string | null = null;
    for (let df = 0; df < hu && !conflictMsg; df++) {
      const f = m.floor + df;
      const baseGrid = baseIdx.moduleGridByFloor.get(f);
      const localGrid = addedModGridByFloor.get(f);
      for (let dx = 0; dx < wu && !conflictMsg; dx++) {
        for (let dy = 0; dy < du; dy++) {
          const k = packCellKey(m.gx + dx, m.gy + dy);
          if (localGrid?.has(k)) {
            conflictMsg = '蓝图内部模块位置重叠';
            break;
          }
          const hits = baseGrid?.get(k);
          if (hits && hits.length > 0) {
            const mDef = getModuleDef(hits[0].type);
            conflictMsg = `与已有模块「${mDef?.nameZh ?? hits[0].type}」空间重叠`;
            break;
          }
        }
      }
    }
    if (conflictMsg) {
      if (!forceReplace) return { doc, changed: false, message: conflictMsg };
      continue;
    }
    addedMods.push(m);
    for (let df = 0; df < hu; df++) {
      const f = m.floor + df;
      let localGrid = addedModGridByFloor.get(f);
      if (!localGrid) {
        localGrid = new Set();
        addedModGridByFloor.set(f, localGrid);
      }
      for (let dx = 0; dx < wu; dx++) {
        for (let dy = 0; dy < du; dy++) {
          localGrid.add(packCellKey(m.gx + dx, m.gy + dy));
        }
      }
    }
  }

  // Document containing existing + newly placed modules so floor checks for buildings inside stamped modules succeed
  const docWithMods: BlueprintDocument =
    addedMods.length > 0 ? { ...doc, modules: [...doc.modules, ...addedMods] } : doc;
  const modIdx = addedMods.length > 0 ? getDocSpatialIndex(docWithMods) : baseIdx;

  // 2. Validate & batch all buildings in O(K) using per-floor mutable occupancy map (ZERO repeated array copies!)
  const removeIds = new Set<string>();
  const addedBlds: PlacedBuilding[] = [];
  const addedBldByCell = new Map<number, Map<number, PlacedBuilding>>();

  for (let i = 0; i < candBlds.length; i++) {
    const b = candBlds[i];
    const def = getBuildableDef(b.type);
    if (!def) {
      if (!forceReplace) return { doc, changed: false, message: `未知建筑类型：${b.type}` };
      continue;
    }
    const [w, d] = getBuildingSizeCells(def, b.rotation);

    // Check floor buildability
    let floorOk = true;
    for (let dx = 0; dx < w && floorOk; dx++) {
      for (let dy = 0; dy < d; dy++) {
        if (!isCellBuildable(docWithMods, b.x + dx, b.y + dy, b.floor)) {
          floorOk = false;
          break;
        }
      }
    }
    if (!floorOk) {
      if (!forceReplace) {
        return { doc, changed: false, message: '超出可建造工厂地板范围（墙体、镂空或无地板）' };
      }
      continue;
    }

    const baseFloorMap = modIdx.buildingCellByFloor.get(b.floor);
    let localFloorMap = addedBldByCell.get(b.floor);
    const isBelt = def.kind === 'belt';
    let conflictMsg: string | null = null;
    const toRemoveHere: string[] = [];

    for (let dx = 0; dx < w && !conflictMsg; dx++) {
      for (let dy = 0; dy < d; dy++) {
        const k = packCellKey(b.x + dx, b.y + dy);
        // Check against already-added buildings in this stamp
        const localHit = localFloorMap?.get(k);
        if (localHit && !removeIds.has(localHit.id)) {
          const lDef = getBuildableDef(localHit.type);
          if (forceReplace || (isBelt && lDef?.kind === 'belt')) {
            toRemoveHere.push(localHit.id);
          } else {
            conflictMsg = `与已有「${lDef?.nameZh ?? localHit.type}」占地冲突`;
            break;
          }
        }
        // Check against existing buildings in doc
        const baseHit = baseFloorMap?.get(k);
        if (baseHit) {
          if (Array.isArray(baseHit)) {
            for (let j = 0; j < baseHit.length; j++) {
              const eb = baseHit[j];
              if (removeIds.has(eb.id)) continue;
              const eDef = getBuildableDef(eb.type);
              if (forceReplace || (isBelt && eDef?.kind === 'belt')) {
                toRemoveHere.push(eb.id);
              } else {
                conflictMsg = `与已有「${eDef?.nameZh ?? eb.type}」占地冲突`;
                break;
              }
            }
          } else if (!removeIds.has(baseHit.id)) {
            const eDef = getBuildableDef(baseHit.type);
            if (forceReplace || (isBelt && eDef?.kind === 'belt')) {
              toRemoveHere.push(baseHit.id);
            } else {
              conflictMsg = `与已有「${eDef?.nameZh ?? baseHit.type}」占地冲突`;
              break;
            }
          }
        }
      }
    }

    if (conflictMsg) {
      if (!forceReplace) return { doc, changed: false, message: conflictMsg };
      continue;
    }

    for (let r = 0; r < toRemoveHere.length; r++) {
      removeIds.add(toRemoveHere[r]);
    }

    const cleanDisabled = sanitizeDisabledPorts(def, b.disabledPorts);
    const placed: PlacedBuilding = {
      ...b,
      rotation: normalizeRotation(b.rotation),
      ...cloneBuildingExtras({ ...b, disabledPorts: cleanDisabled }),
    };
    if (!cleanDisabled) delete placed.disabledPorts;

    addedBlds.push(placed);
    if (!localFloorMap) {
      localFloorMap = new Map();
      addedBldByCell.set(b.floor, localFloorMap);
    }
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        localFloorMap.set(packCellKey(b.x + dx, b.y + dy), placed);
      }
    }
  }

  const finalAddedBlds = removeIds.size > 0 ? addedBlds.filter((b) => !removeIds.has(b.id)) : addedBlds;
  if (addedMods.length === 0 && finalAddedBlds.length === 0) {
    return { doc, changed: false };
  }

  // Filter out removed buildings & clear dangling undergroundPartnerId references in one pass
  const placedIdSet = new Set(finalAddedBlds.map((b) => b.id));
  const nextBuildings: PlacedBuilding[] = [];
  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    if (removeIds.has(b.id)) continue;
    if (b.undergroundPartnerId && removeIds.has(b.undergroundPartnerId)) {
      const copy = { ...b };
      delete copy.undergroundPartnerId;
      nextBuildings.push(copy);
    } else {
      nextBuildings.push(b);
    }
  }
  for (let i = 0; i < finalAddedBlds.length; i++) {
    const b = finalAddedBlds[i];
    if (b.undergroundPartnerId && !placedIdSet.has(b.undergroundPartnerId)) {
      const copy = { ...b };
      delete copy.undergroundPartnerId;
      nextBuildings.push(copy);
    } else {
      nextBuildings.push(b);
    }
  }

  return {
    doc: {
      ...doc,
      modules: addedMods.length > 0 ? [...doc.modules, ...addedMods] : doc.modules,
      buildings: nextBuildings,
    },
    changed: true,
    addedModuleIds: addedMods.map((m) => m.id),
    addedBuildingIds: finalAddedBlds.map((b) => b.id),
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
