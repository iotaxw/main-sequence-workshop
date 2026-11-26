/**
 * Lightweight Online Workbench Blueprint Checker ("图纸体检" / "Check")
 *
 * Clean division of labor:
 * - Online Workbench (this file): Fast O(V + E) deterministic geometry, wiring, pure-graph item
 *   reachability (zero floating-point decay), and static full-load rated capacity & power ledgers.
 *   Target latency: < 100 ms even on 30,000+ building mega-stations.
 * - Offline Simulator & Verifier (`simulation.ts`, `verifier.ts` HDVF L0-L5, `offline-sim/`):
 *   Deep steady-state flow balancing, Tarjan SCC loop conservation, progressive saturation
 *   backpressure cascades, multi-orbit solar curves, and `.sav` round-trip audits.
 */

import { getBuildableDef, getItemName, getModuleDef, getRecipeDef } from './catalog';
import {
  computeUndergroundLinks,
  findModuleAtWorldPoint,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  getModuleBoundsM,
  getModuleCenterM,
  getModuleEngineBlockBoundsM,
  getModuleWorldDockPorts,
  isCellBuildable,
  normalizeRotation,
  packCellKey,
  rotateVec2,
  rotationToDelta,
} from './geometry';
import { formatFloorTag, type Lang } from './i18n';
import type {
  BlueprintDocument,
  BuildableDef,
  PlacedBuilding,
  PlacedModule,
  RecipeDef,
  Rotation,
  StationModuleDef,
} from './types';

/* ===================== Public Types ===================== */

export type WorkbenchIssueSeverity = 'error' | 'warn';

export type WorkbenchFaultCode =
  | 'invalid-catalog'
  | 'module-overlap'
  | 'building-out-of-floor'
  | 'building-overlap'
  | 'invalid-recipe'
  | 'orphan-belt'
  | 'dead-end-belt'
  | 'head-on-belt'
  | 'unpaired-underground'
  | 'port-mismatch'
  | 'disabled-port-input'
  | 'mixed-item-belt'
  | 'elevator-stack-gap'
  | 'elevator-rotation-mismatch'
  | 'elevator-mixed-shaft'
  | 'machine-missing-input'
  | 'machine-wrong-item'
  | 'machine-blocked-output';

export type WorkbenchIoKind =
  | 'dock'
  | 'doorway'
  | 'elevator'
  | 'wall-stub'
  | 'open-belt'
  | 'source-container'
  | 'terminal-container'
  | 'machine-head';

export interface WorkbenchIssue {
  id: string;
  severity: WorkbenchIssueSeverity;
  code: WorkbenchFaultCode;
  message: string;
  floor: number;
  x: number;
  y: number;
  buildingId?: string;
  moduleId?: string;
}

export interface WorkbenchIoSpot {
  id: string;
  direction: 'in' | 'out';
  kind: WorkbenchIoKind;
  floor: number;
  x: number;
  y: number;
  buildingId?: string;
  items: string[];
  message: string;
}

export interface WorkbenchCellItemInfo {
  items: string[];
  tier: 1 | 2 | 3;
  capacity: number;
  mixed: boolean;
}

export interface WorkbenchRatedItem {
  itemId: string;
  ratePerSec: number;
  beltsMk3: number;
}

export interface WorkbenchRecipeSummary {
  recipeId: string;
  machineCount: number;
  ratedOutputs: Array<{ itemId: string; ratePerSec: number }>;
}

export interface WorkbenchPowerLedger {
  crafterPeakMW: number;
  labPeakMW: number;
  facilityPeakMW: number;
  intermittentPeakMW: number;
  peakDrawMW: number;
  solarGenMW: number;
  reactorGenMW: number;
  maxGenMW: number;
  minGenMW: number;
  netBalanceMW: number;
  generatorCount: number;
}

export interface WorkbenchCheckReport {
  durationMs: number;
  passed: boolean;
  errorCount: number;
  warnCount: number;
  faults: WorkbenchIssue[];
  ioSpots: WorkbenchIoSpot[];
  inputSpotCount: number;
  outputSpotCount: number;
  machineCount: number;
  configuredMachineCount: number;
  ratedNetInputs: WorkbenchRatedItem[];
  ratedNetOutputs: WorkbenchRatedItem[];
  recipeSummary: WorkbenchRecipeSummary[];
  power: WorkbenchPowerLedger;
  /** O(1) zero-string-allocation cell lookup for hover inspection. */
  getCellItem: (floor: number, x: number, y: number) => WorkbenchCellItemInfo | null;
}

/* ===================== Fast Integer-Keyed Spatial Helpers ===================== */

type FloorCellMap<T> = Map<number, Map<number, T>>;

function fcGet<T>(map: FloorCellMap<T>, floor: number, x: number, y: number): T | undefined {
  return map.get(floor)?.get(packCellKey(x, y));
}

function fcSet<T>(map: FloorCellMap<T>, floor: number, x: number, y: number, val: T): void {
  let inner = map.get(floor);
  if (!inner) {
    inner = new Map<number, T>();
    map.set(floor, inner);
  }
  inner.set(packCellKey(x, y), val);
}

function fcPush<T>(map: FloorCellMap<T[]>, floor: number, x: number, y: number, val: T): void {
  let inner = map.get(floor);
  if (!inner) {
    inner = new Map<number, T[]>();
    map.set(floor, inner);
  }
  const k = packCellKey(x, y);
  const arr = inner.get(k);
  if (arr) arr.push(val);
  else inner.set(k, [val]);
}

function fcAddSet(map: Map<number, Set<number>>, floor: number, x: number, y: number): void {
  let inner = map.get(floor);
  if (!inner) {
    inner = new Set<number>();
    map.set(floor, inner);
  }
  inner.add(packCellKey(x, y));
}

function fcHasSet(map: Map<number, Set<number>>, floor: number, x: number, y: number): boolean {
  return map.get(floor)?.has(packCellKey(x, y)) ?? false;
}

/* ===================== Internal Types & Helpers ===================== */

interface OutEdge {
  toId: string;
  portIndex?: number;
  toPortIndex?: number;
  filterItem?: string;
}

interface InEdge {
  fromId: string;
  portIndex?: number;
}

interface ElevatorPortInfo {
  stackId: string;
  colKey: string;
  portIndex: number;
  portX: number;
  portY: number;
  adjX: number;
  adjY: number;
  outDir: Rotation;
  modOrder: number;
}

interface FloorModuleEntry {
  mod: PlacedModule;
  def: StationModuleDef;
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const SIDE_TO_ROT: Record<'E' | 'S' | 'W' | 'N', Rotation> = { E: 0, S: 1, W: 2, N: 3 };

function oppositeRot(r: Rotation): Rotation {
  return ((r + 2) % 4) as Rotation;
}

function getTierSpeed(tier?: 1 | 2 | 3): number {
  if (tier === 3) return 3;
  if (tier === 2) return 2;
  return 1;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inferLocalOutDir(modType: string, lx: number, ly: number): Rotation {
  if (modType === 'BPO_ElevatorBlock_03') {
    if (Math.abs(ly) > Math.abs(lx)) return lx > 0 ? 2 : 0;
    return ly > 0 ? 3 : 1;
  }
  if (Math.abs(lx) >= Math.abs(ly)) return lx < 0 ? 2 : 0;
  return ly < 0 ? 3 : 1;
}

function ioKindLabel(kind: WorkbenchIoKind, direction: 'in' | 'out', lang: Lang): string {
  const en = lang === 'en';
  switch (kind) {
    case 'dock':
      return en ? (direction === 'in' ? 'Dock In' : 'Dock Out') : direction === 'in' ? '货港入料' : '货港出料';
    case 'doorway':
      return en ? (direction === 'in' ? 'Doorway In' : 'Doorway Out') : direction === 'in' ? '门口入料' : '门口出料';
    case 'elevator':
      return en ? (direction === 'in' ? 'Elevator In' : 'Elevator Out') : direction === 'in' ? '电梯入料' : '电梯出料';
    case 'wall-stub':
      return en ? (direction === 'in' ? 'Wall Stub In' : 'Wall Stub Out') : direction === 'in' ? '穿墙入料' : '穿墙出料';
    case 'open-belt':
      return en ? (direction === 'in' ? 'Open Belt In' : 'Open Belt Out') : direction === 'in' ? '带首入料' : '带尾出料';
    case 'source-container':
      return en ? 'Source Container' : '供料箱';
    case 'terminal-container':
      return en ? 'Terminal Container' : '终端箱';
    case 'machine-head':
      return en ? 'Machine Head' : '机器首端';
  }
}

/* ===================== Main Checker ===================== */

export function checkBlueprintWorkbench(doc: BlueprintDocument, lang: Lang = 'zh'): WorkbenchCheckReport {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const en = lang === 'en';

  const faults: WorkbenchIssue[] = [];
  const faultKeys = new Set<string>();
  let faultSeq = 1;

  const pushFault = (
    severity: WorkbenchIssueSeverity,
    code: WorkbenchFaultCode,
    message: string,
    floor: number,
    x: number,
    y: number,
    buildingId?: string,
    moduleId?: string
  ) => {
    const dedup = `${code}:${floor}:${x},${y}:${buildingId ?? ''}:${moduleId ?? ''}`;
    if (faultKeys.has(dedup)) return;
    faultKeys.add(dedup);
    faults.push({
      id: `chk_${faultSeq++}`,
      severity,
      code,
      message,
      floor,
      x,
      y,
      buildingId,
      moduleId,
    });
  };

  /* ---------- 1. Module Catalog, 3D BlockBounds Overlap & Floor Index ---------- */
  const floorModulesByFloor = new Map<number, FloorModuleEntry[]>();
  const modAabbs: Array<{
    mod: PlacedModule;
    def: StationModuleDef;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  }> = [];

  for (const mod of doc.modules) {
    const mDef = getModuleDef(mod.type);
    if (!mDef) {
      pushFault(
        'error',
        'invalid-catalog',
        en
          ? `Unknown station module "${mod.type}" at (${mod.gx},${mod.gy})`
          : `未知空间站模块「${mod.type}」(${mod.gx},${mod.gy})`,
        mod.floor,
        mod.gx * 8,
        mod.gy * 8,
        undefined,
        mod.id
      );
      continue;
    }
    if (mod.recipeId && !getRecipeDef(mod.recipeId)) {
      const [cx, cy] = getModuleCenterM(mod, mDef);
      pushFault(
        'error',
        'invalid-recipe',
        en
          ? `Unknown recipe "${mod.recipeId}" on ${mDef.nameEn}`
          : `${mDef.nameZh} 配置了无效配方「${mod.recipeId}」`,
        mod.floor,
        Math.floor(cx),
        Math.floor(cy),
        undefined,
        mod.id
      );
    }

    const bb = getModuleEngineBlockBoundsM(mod, mDef);
    modAabbs.push({ mod, def: mDef, ...bb });

    if (mDef.hasFactoryFloor) {
      const [cx, cy] = getModuleCenterM(mod, mDef);
      const [minX, minY, maxX, maxY] = getModuleBoundsM(mod, mDef);
      for (const fl of mDef.floors) {
        const f = mod.floor + fl.floorOffset;
        let arr = floorModulesByFloor.get(f);
        if (!arr) {
          arr = [];
          floorModulesByFloor.set(f, arr);
        }
        arr.push({ mod, def: mDef, cx, cy, minX: minX - 1.5, minY: minY - 1.5, maxX: maxX + 1.5, maxY: maxY + 1.5 });
      }
    }
  }

  // O(M log M) sweep-line 3D BlockBounds overlap check (matches BuildBlueprintUtil::CheckOverlap)
  modAabbs.sort((a, b) => a.minX - b.minX);
  const eps = 0.02;
  for (let i = 0; i < modAabbs.length; i++) {
    const a = modAabbs[i];
    for (let j = i + 1; j < modAabbs.length; j++) {
      const b = modAabbs[j];
      if (b.minX + eps >= a.maxX) break;
      if (
        a.minY + eps < b.maxY &&
        b.minY + eps < a.maxY &&
        a.minZ + eps < b.maxZ &&
        b.minZ + eps < a.maxZ
      ) {
        const cx = Math.floor((Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2);
        const cy = Math.floor((Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2);
        const nameA = en ? a.def.nameEn : a.def.nameZh;
        const nameB = en ? b.def.nameEn : b.def.nameZh;
        pushFault(
          'error',
          'module-overlap',
          en
            ? `Module 3D overlap: ${nameA} (${a.mod.gx},${a.mod.gy}) intersects ${nameB} (${b.mod.gx},${b.mod.gy})`
            : `模块 3D 重叠：${nameA} (${a.mod.gx},${a.mod.gy}) 与 ${nameB} (${b.mod.gx},${b.mod.gy}) 碰撞`,
          a.mod.floor,
          cx,
          cy,
          undefined,
          a.mod.id
        );
      }
    }
  }

  const isDoorwayThresholdCellFast = (x: number, y: number, floor: number): boolean => {
    const mods = floorModulesByFloor.get(floor);
    if (!mods) return false;
    const cx = x + 0.5;
    const cy = y + 0.5;
    for (let i = 0; i < mods.length; i++) {
      const e = mods[i];
      if (cx < e.minX || cx > e.maxX || cy < e.minY || cy > e.maxY) continue;
      const invRot = normalizeRotation(4 - e.mod.rotation);
      const [lx, ly] = rotateVec2(cx - e.cx, cy - e.cy, invRot);
      for (const fl of e.def.floors) {
        if (e.mod.floor + fl.floorOffset !== floor) continue;
        if (lx >= fl.minX && lx <= fl.maxX && ly >= fl.minY && ly <= fl.maxY) continue;
        for (const dw of fl.doorways) {
          if (dw.side === 'W' && lx >= fl.minX - 1.01 && lx < fl.minX && ly >= dw.start && ly <= dw.end) return true;
          if (dw.side === 'E' && lx > fl.maxX && lx <= fl.maxX + 1.01 && ly >= dw.start && ly <= dw.end) return true;
          if (dw.side === 'N' && ly >= fl.minY - 1.01 && ly < fl.minY && lx >= dw.start && lx <= dw.end) return true;
          if (dw.side === 'S' && ly > fl.maxY && ly <= fl.maxY + 1.01 && lx >= dw.start && lx <= dw.end) return true;
        }
      }
    }
    return false;
  };

  /* ---------- 2. Elevator Stacks & Dock Ports ---------- */
  const elevatorPorts: FloorCellMap<ElevatorPortInfo> = new Map();
  const elevatorAdjPorts: FloorCellMap<ElevatorPortInfo[]> = new Map();
  {
    const modsByXY = new Map<string, Array<{ mod: PlacedModule; def: StationModuleDef; modOrder: number }>>();
    for (let modOrder = 0; modOrder < doc.modules.length; modOrder++) {
      const mod = doc.modules[modOrder];
      const def = getModuleDef(mod.type);
      if (!def || !def.floors.some((fl) => fl.elevatorPorts && fl.elevatorPorts.length > 0)) continue;
      const xyKey = `${mod.gx},${mod.gy}`;
      let list = modsByXY.get(xyKey);
      if (!list) {
        list = [];
        modsByXY.set(xyKey, list);
      }
      list.push({ mod, def, modOrder });
    }
    for (const [xyKey, stack] of modsByXY.entries()) {
      stack.sort((a, b) => a.mod.floor - b.mod.floor);
      let stackSeq = 0;
      let prevTopFloor: number | null = null;
      let prevType: string | null = null;
      let baseRot: Rotation | null = null;
      for (const { mod, def, modOrder } of stack) {
        const [cx, cy] = getModuleCenterM(mod, def);
        const typeChanged = prevType !== null && mod.type !== prevType;
        if (prevTopFloor === null || mod.floor !== prevTopFloor || typeChanged) {
          if (prevTopFloor !== null) {
            if (typeChanged) {
              pushFault(
                'error',
                'elevator-stack-gap',
                en
                  ? `Elevator shaft (${mod.gx},${mod.gy}) mixes 1×1 and 2×2 elevator types at ${formatFloorTag(mod.floor)}`
                  : `电梯柱 (${mod.gx},${mod.gy}) 在 ${formatFloorTag(mod.floor)} 混叠了不同型号电梯（1×1 与 2×2 无法互通）`,
                mod.floor,
                Math.floor(cx),
                Math.floor(cy),
                undefined,
                mod.id
              );
            } else if (mod.floor > prevTopFloor) {
              pushFault(
                'error',
                'elevator-stack-gap',
                en
                  ? `Elevator shaft (${mod.gx},${mod.gy}) has a floor gap between ${formatFloorTag(prevTopFloor)} and ${formatFloorTag(mod.floor - 1)}`
                  : `电梯柱 (${mod.gx},${mod.gy}) 在 ${formatFloorTag(prevTopFloor)}..${formatFloorTag(mod.floor - 1)} 存在楼层断档`,
                mod.floor,
                Math.floor(cx),
                Math.floor(cy),
                undefined,
                mod.id
              );
            }
          }
          stackSeq++;
          baseRot = mod.rotation;
        } else if (mod.type === 'BPO_ElevatorBlock_03' && baseRot !== null && mod.rotation !== baseRot) {
          pushFault(
            'warn',
            'elevator-rotation-mismatch',
            en
              ? `1×1 Elevator (${mod.gx},${mod.gy}) rotation differs at ${formatFloorTag(mod.floor)} (rot ${mod.rotation} ≠ ${baseRot})`
              : `1×1 电梯 (${mod.gx},${mod.gy}) 在 ${formatFloorTag(mod.floor)} 朝向与底层不一致（${mod.rotation} ≠ ${baseRot}）`,
            mod.floor,
            Math.floor(cx),
            Math.floor(cy),
            undefined,
            mod.id
          );
        }
        prevTopFloor = mod.floor + def.sizeUnits[2];
        prevType = mod.type;
        const stackId = `${mod.type}:${xyKey}#${stackSeq}`;
        for (const fl of def.floors) {
          if (!fl.elevatorPorts) continue;
          const portFloor = mod.floor + fl.floorOffset;
          for (let portIndex = 0; portIndex < fl.elevatorPorts.length; portIndex++) {
            const ep = fl.elevatorPorts[portIndex];
            const localCenterX = Number.isInteger(ep.x) ? ep.x + 0.5 : ep.x;
            const localCenterY = Number.isInteger(ep.y) ? ep.y + 0.5 : ep.y;
            const localOutDir = inferLocalOutDir(mod.type, localCenterX, localCenterY);
            const outDir = normalizeRotation(localOutDir + mod.rotation);
            const [rx, ry] = rotateVec2(localCenterX, localCenterY, mod.rotation);
            const portX = Math.floor(cx + rx);
            const portY = Math.floor(cy + ry);
            const [odx, ody] = rotationToDelta(outDir);
            const adjX = portX + odx;
            const adjY = portY + ody;
            const colKey =
              mod.type === 'BPO_ElevatorBlock_03' ? `${stackId}:p${portIndex}` : `${stackId}:${portX},${portY}`;
            const info: ElevatorPortInfo = { stackId, colKey, portIndex, portX, portY, adjX, adjY, outDir, modOrder };
            fcSet(elevatorPorts, portFloor, portX, portY, info);
            fcPush(elevatorAdjPorts, portFloor, adjX, adjY, info);
          }
        }
      }
    }
  }

  type DockPortSpec = ReturnType<typeof getModuleWorldDockPorts>[number];
  const dockPorts: FloorCellMap<DockPortSpec> = new Map();
  const dockAdjPorts: FloorCellMap<DockPortSpec[]> = new Map();
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def) continue;
    for (const spec of getModuleWorldDockPorts(mod, def)) {
      fcSet(dockPorts, mod.floor, spec.portX, spec.portY, spec);
      fcPush(dockAdjPorts, mod.floor, spec.adjX, spec.adjY, spec);
    }
  }

  /* ---------- 3. Building Catalog, Floor Coverage, Overlap & Virtual Observatories ---------- */
  const defById = new Map<string, BuildableDef>();
  const buildingById = new Map<string, PlacedBuilding>();
  const cellMap: FloorCellMap<PlacedBuilding> = new Map();

  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    const def = getBuildableDef(b.type);
    if (!def) {
      pushFault(
        'error',
        'invalid-catalog',
        en ? `Unknown building "${b.type}" at (${b.x},${b.y})` : `未知建筑「${b.type}」(${b.x},${b.y})`,
        b.floor,
        b.x,
        b.y,
        b.id
      );
      continue;
    }
    defById.set(b.id, def);
    buildingById.set(b.id, b);

    if (b.recipeId) {
      const rec = getRecipeDef(b.recipeId);
      if (!rec || (def.crafterId && rec.crafterId && rec.crafterId !== def.crafterId)) {
        pushFault(
          'error',
          'invalid-recipe',
          en
            ? `Invalid or incompatible recipe "${b.recipeId}" on ${def.nameEn} (${b.x},${b.y})`
            : `${def.nameZh} (${b.x},${b.y}) 配置了无效或不匹配的配方「${b.recipeId}」`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }
    }
    if (def.kind === 'underground' && b.undergroundMode !== 'in' && b.undergroundMode !== 'out') {
      pushFault(
        'error',
        'port-mismatch',
        en
          ? `${def.nameEn} (${b.x},${b.y}) missing IN/OUT mode`
          : `${def.nameZh} (${b.x},${b.y}) 缺少入口/出口模式标记`,
        b.floor,
        b.x,
        b.y,
        b.id
      );
    }

    const [w, d] = getBuildingSizeCells(def, b.rotation);
    let inner = cellMap.get(b.floor);
    if (!inner) {
      inner = new Map<number, PlacedBuilding>();
      cellMap.set(b.floor, inner);
    }
    let outOfFloor = false;
    let overlappedWith: Set<string> | null = null;
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        const cx = b.x + dx;
        const cy = b.y + dy;
        if (!outOfFloor && isCellBuildable(doc, cx, cy, b.floor) === null) {
          outOfFloor = true;
        }
        const pk = packCellKey(cx, cy);
        const prev = inner.get(pk);
        if (prev && prev.id !== b.id) {
          if (!overlappedWith) overlappedWith = new Set();
          if (!overlappedWith.has(prev.id)) {
            overlappedWith.add(prev.id);
            const pDef = defById.get(prev.id);
            pushFault(
              'error',
              'building-overlap',
              en
                ? `${def.nameEn} (${b.x},${b.y}) overlaps ${pDef?.nameEn ?? prev.type} (${prev.x},${prev.y})`
                : `${def.nameZh} (${b.x},${b.y}) 与 ${pDef?.nameZh ?? prev.type} (${prev.x},${prev.y}) 重叠`,
              b.floor,
              cx,
              cy,
              b.id
            );
          }
        } else {
          inner.set(pk, b);
        }
      }
    }
    if (outOfFloor) {
      pushFault(
        'error',
        'building-out-of-floor',
        en
          ? `${def.nameEn} (${b.x},${b.y}) extends outside buildable floor`
          : `${def.nameZh} (${b.x},${b.y}) 超出可建造地板范围`,
        b.floor,
        b.x,
        b.y,
        b.id
      );
    }
  }

  // Synthesize virtual crafter nodes for BPO_DeepSpaceObservatory modules with recipeId
  const OBS_VIRTUAL_DEF: BuildableDef = {
    id: 'VIRTUAL_DeepSpaceObservatoryMachine',
    objectClass: 'BPO_DeepSpaceObservatoryMachine',
    nameEn: 'Deep Space Observatory',
    nameZh: '深空天文台',
    descriptionZh: '内置深空观测合成终端',
    categoryEn: 'Functional Blocks',
    categoryZh: '功能构件',
    kind: 'crafter',
    tier: 3,
    size: [1, 1],
    heightM: 16,
    crafterId: 'BPO_DeepSpaceObservatory',
    ports: [],
    configurablePorts: false,
    powerKW: 0,
    sourceAsset: '/Game/Blueprints/BuildingBlocks/BPO_DeepSpaceObservatory',
  };
  const virtualObservatories: Array<{
    building: PlacedBuilding;
    sideDir: Rotation;
    portCells: Array<{ portIndex: number; adjX: number; adjY: number }>;
  }> = [];
  const virtualObsAdjCells = new Map<number, Set<number>>();
  for (const mod of doc.modules) {
    if (mod.type !== 'BPO_DeepSpaceObservatory' || !mod.recipeId) continue;
    const mDef = getModuleDef(mod.type);
    if (!mDef) continue;
    const [cx, cy] = getModuleCenterM(mod, mDef);
    const sideDir = normalizeRotation(2 + mod.rotation);
    const portCells: Array<{ portIndex: number; adjX: number; adjY: number }> = [];
    const LOCAL_PORTS: Array<[number, number]> = [
      [-16.5, -0.5],
      [-16.5, 0.5],
    ];
    for (let pi = 0; pi < LOCAL_PORTS.length; pi++) {
      const [rx, ry] = rotateVec2(LOCAL_PORTS[pi][0], LOCAL_PORTS[pi][1], mod.rotation);
      const ax = Math.floor(cx + rx);
      const ay = Math.floor(cy + ry);
      portCells.push({ portIndex: pi, adjX: ax, adjY: ay });
      fcAddSet(virtualObsAdjCells, mod.floor, ax, ay);
    }
    const vb: PlacedBuilding = {
      id: `mod_obs:${mod.id}`,
      type: OBS_VIRTUAL_DEF.id,
      x: Math.floor(cx),
      y: Math.floor(cy),
      floor: mod.floor,
      rotation: mod.rotation,
      recipeId: mod.recipeId,
      label: mod.label ?? (en ? 'Observatory' : '深空天文台'),
    };
    defById.set(vb.id, OBS_VIRTUAL_DEF);
    buildingById.set(vb.id, vb);
    virtualObservatories.push({ building: vb, sideDir, portCells });
  }
  const allNodes: PlacedBuilding[] = [...doc.buildings, ...virtualObservatories.map((v) => v.building)];

  /* ---------- 4. Machine Ports & Directed Logistics Graph ---------- */
  interface AdjacentPortTarget {
    building: PlacedBuilding;
    portIndex: number;
    sideDir: Rotation;
    enabled: boolean;
  }
  const machinePortsByAdjCell: FloorCellMap<AdjacentPortTarget[]> = new Map();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    if (def.kind !== 'crafter' && def.kind !== 'research' && def.kind !== 'container' && def.kind !== 'reactor') continue;
    for (const wp of getBuildingWorldPorts(b, def)) {
      fcPush(machinePortsByAdjCell, b.floor, wp.outsideCellX, wp.outsideCellY, {
        building: b,
        portIndex: wp.port.index,
        sideDir: SIDE_TO_ROT[wp.side],
        enabled: wp.enabled,
      });
    }
  }
  for (const vo of virtualObservatories) {
    for (const pc of vo.portCells) {
      fcPush(machinePortsByAdjCell, vo.building.floor, pc.adjX, pc.adjY, {
        building: vo.building,
        portIndex: pc.portIndex,
        sideDir: vo.sideDir,
        enabled: true,
      });
    }
  }

  const ugLinks = computeUndergroundLinks(doc);
  const ugPartnerByIn = new Map<string, PlacedBuilding>();
  const ugPairedIds = new Set<string>();
  for (const link of ugLinks) {
    const outB = buildingById.get(link.toId);
    if (outB) {
      ugPartnerByIn.set(link.fromId, outB);
      ugPairedIds.add(link.fromId);
      ugPairedIds.add(link.toId);
    }
  }

  const outEdges = new Map<string, OutEdge[]>();
  const inEdges = new Map<string, InEdge[]>();
  const addEdge = (
    fromId: string,
    toId: string,
    outPortIndex?: number,
    inPortIndex?: number,
    filterItem?: string
  ) => {
    let outs = outEdges.get(fromId);
    if (!outs) {
      outs = [];
      outEdges.set(fromId, outs);
    }
    let dup = false;
    for (let i = 0; i < outs.length; i++) {
      const e = outs[i];
      if (e.toId === toId && e.portIndex === outPortIndex && e.toPortIndex === inPortIndex) {
        dup = true;
        break;
      }
    }
    if (!dup) outs.push({ toId, portIndex: outPortIndex, toPortIndex: inPortIndex, filterItem });

    let ins = inEdges.get(toId);
    if (!ins) {
      ins = [];
      inEdges.set(toId, ins);
    }
    let inDup = false;
    for (let i = 0; i < ins.length; i++) {
      if (ins[i].fromId === fromId && ins[i].portIndex === inPortIndex) {
        inDup = true;
        break;
      }
    }
    if (!inDup) ins.push({ fromId, portIndex: inPortIndex });
  };

  const entrySourceKind = new Map<string, WorkbenchIoKind>();
  const exitSinkKind = new Map<string, WorkbenchIoKind>();
  const boundaryExits = new Set<string>();
  const openTailCandidates = new Set<string>();
  const frontFaultIds = new Set<string>();
  const dockEntryItem = new Map<string, string>();

  const findEnabledMachinePortAccepting = (
    floor: number,
    srcX: number,
    srcY: number,
    pushDir: Rotation
  ): { target: AdjacentPortTarget | null; disabledHit: AdjacentPortTarget | null } => {
    const candidates = fcGet(machinePortsByAdjCell, floor, srcX, srcY);
    if (!candidates) return { target: null, disabledHit: null };
    const wantSide = oppositeRot(pushDir);
    let disabledHit: AdjacentPortTarget | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.sideDir !== wantSide) continue;
      if (c.enabled) return { target: c, disabledHit: null };
      disabledHit = c;
    }
    return { target: null, disabledHit };
  };

  const canLogisticsAcceptFrom = (
    target: PlacedBuilding,
    targetDef: BuildableDef,
    pushDir: Rotation,
    targetCellX: number,
    targetCellY: number
  ): { ok: boolean; inPortIndex?: number; headOn?: boolean } => {
    if (targetDef.kind === 'belt') {
      if (target.rotation === oppositeRot(pushDir)) return { ok: false, headOn: true };
      return { ok: true };
    }
    if (targetDef.kind === 'underground') {
      if (target.undergroundMode === 'in' && target.rotation === pushDir) return { ok: true };
      return { ok: false };
    }
    if (targetDef.kind === 'splitter') {
      if (target.rotation === pushDir) return { ok: true, inPortIndex: 0 };
      return { ok: false };
    }
    if (targetDef.kind === 'balancer') {
      if (target.rotation !== pushDir) return { ok: false };
      const [pdx, pdy] = rotationToDelta(pushDir);
      for (const wp of getBuildingWorldPorts(target, targetDef)) {
        if (wp.port.role !== 'in') continue;
        const px = Math.floor(wp.worldX + pdx * 0.5);
        const py = Math.floor(wp.worldY + pdy * 0.5);
        if (px === targetCellX && py === targetCellY) {
          return { ok: true, inPortIndex: wp.port.index };
        }
      }
      return { ok: true, inPortIndex: 0 };
    }
    return { ok: false };
  };

  interface ElevTap {
    bid: string;
    floor: number;
    modOrder: number;
    portIndex?: number;
    toPortIndex?: number;
    filterItem?: string;
  }
  const elevInByCol = new Map<string, ElevTap[]>();
  const elevOutByCol = new Map<string, ElevTap[]>();
  const pushElev = (map: Map<string, ElevTap[]>, colKey: string, rec: ElevTap) => {
    const arr = map.get(colKey);
    if (arr) arr.push(rec);
    else map.set(colKey, [rec]);
  };

  const isBoundaryMissing = (x: number, y: number, floor: number) => isCellBuildable(doc, x, y, floor) === null;

  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    const def = defById.get(b.id);
    if (!def) continue;

    if (def.kind === 'belt') {
      const [dx, dy] = rotationToDelta(b.rotation);
      const bx = b.x - dx;
      const by = b.y - dy;
      const fx = b.x + dx;
      const fy = b.y + dy;

      const adjElevHits = fcGet(elevatorAdjPorts, b.floor, b.x, b.y);
      const matchedElevIn = adjElevHits ? adjElevHits.filter((ep) => b.rotation !== oppositeRot(ep.outDir)) : null;
      const adjDockHits = fcGet(dockAdjPorts, b.floor, b.x, b.y);
      const matchedDockIn = adjDockHits ? adjDockHits.find((dp) => b.rotation !== oppositeRot(dp.outDir)) : undefined;
      if (matchedElevIn && matchedElevIn.length > 0) {
        entrySourceKind.set(b.id, 'elevator');
        for (const ep of matchedElevIn) {
          pushElev(elevOutByCol, ep.colKey, { bid: b.id, floor: b.floor, modOrder: ep.modOrder });
        }
      } else if (matchedDockIn) {
        entrySourceKind.set(b.id, 'dock');
        if (matchedDockIn.itemId) dockEntryItem.set(b.id, matchedDockIn.itemId);
      } else if (
        !fcGet(cellMap, b.floor, bx, by) &&
        !fcHasSet(virtualObsAdjCells, b.floor, b.x, b.y) &&
        isBoundaryMissing(bx, by, b.floor) &&
        isDoorwayThresholdCellFast(b.x, b.y, b.floor)
      ) {
        entrySourceKind.set(b.id, 'doorway');
      }

      const frontElev = fcGet(elevatorPorts, b.floor, fx, fy);
      const frontElevMatch = frontElev && b.rotation === oppositeRot(frontElev.outDir) ? frontElev : null;
      const frontDock = fcGet(dockPorts, b.floor, fx, fy);
      const frontDockMatch = frontDock && b.rotation === oppositeRot(frontDock.outDir) ? frontDock : null;
      if (frontElevMatch) {
        exitSinkKind.set(b.id, 'elevator');
        boundaryExits.add(b.id);
        pushElev(elevInByCol, frontElevMatch.colKey, { bid: b.id, floor: b.floor, modOrder: frontElevMatch.modOrder });
      } else if (frontDockMatch) {
        exitSinkKind.set(b.id, 'dock');
        boundaryExits.add(b.id);
      } else {
        const { target: mTarget, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, b.rotation);
        if (mTarget) {
          addEdge(b.id, mTarget.building.id, undefined, mTarget.portIndex);
        } else if (disabledHit) {
          const mDef = defById.get(disabledHit.building.id);
          addEdge(b.id, disabledHit.building.id, undefined, disabledHit.portIndex);
          pushFault(
            'warn',
            'disabled-port-input',
            en
              ? `Belt (${b.x},${b.y}) enters disabled port on ${mDef?.nameEn ?? disabledHit.building.type} (disabling only blocks output)`
              : `传送带 (${b.x},${b.y}) 指向 ${mDef?.nameZh ?? disabledHit.building.type} 的禁用口（实机禁用仅关出料，仍可进料）`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
        } else {
          const front = fcGet(cellMap, b.floor, fx, fy);
          if (front) {
            const fDef = defById.get(front.id)!;
            const res = canLogisticsAcceptFrom(front, fDef, b.rotation, fx, fy);
            if (res.ok) {
              addEdge(b.id, front.id, undefined, res.inPortIndex);
            } else if (res.headOn) {
              frontFaultIds.add(b.id);
              pushFault(
                'error',
                'head-on-belt',
                en ? `Head-on belts at (${b.x},${b.y}) ↔ (${fx},${fy})` : `传送带 (${b.x},${b.y}) 与 (${fx},${fy}) 正面对冲`,
                b.floor,
                b.x,
                b.y,
                b.id
              );
            } else {
              frontFaultIds.add(b.id);
              pushFault(
                'error',
                'port-mismatch',
                en
                  ? `Belt (${b.x},${b.y}) faces non-input side of ${fDef.nameEn}`
                  : `传送带 (${b.x},${b.y}) 指向 ${fDef.nameZh} 的非进料面/墙体`,
                b.floor,
                b.x,
                b.y,
                b.id
              );
            }
          } else if (isBoundaryMissing(fx, fy, b.floor)) {
            if (isDoorwayThresholdCellFast(b.x, b.y, b.floor)) {
              exitSinkKind.set(b.id, 'doorway');
              boundaryExits.add(b.id);
            } else {
              frontFaultIds.add(b.id);
              pushFault(
                'error',
                'dead-end-belt',
                en
                  ? `Belt (${b.x},${b.y}) dead-ends into outer wall`
                  : `传送带 (${b.x},${b.y}) 撞墙死路（前方无地板也非连通门口）`,
                b.floor,
                b.x,
                b.y,
                b.id
              );
            }
          } else {
            openTailCandidates.add(b.id);
          }
        }
      }
      continue;
    }

    if (def.kind === 'underground') {
      const [dx, dy] = rotationToDelta(b.rotation);
      if (b.undergroundMode === 'in') {
        const partner = ugPartnerByIn.get(b.id);
        if (partner) {
          addEdge(b.id, partner.id);
        } else {
          const crossWall =
            isBoundaryMissing(b.x + dx, b.y + dy, b.floor) ||
            isBoundaryMissing(b.x + dx * 2, b.y + dy * 2, b.floor);
          if (crossWall) {
            exitSinkKind.set(b.id, 'wall-stub');
            boundaryExits.add(b.id);
          } else {
            pushFault(
              'error',
              'unpaired-underground',
              en
                ? `Underground IN (${b.x},${b.y}) has no matching OUT within ${def.maxLength ?? 8} tiles`
                : `地下带入口 (${b.x},${b.y}) 在 ${def.maxLength ?? 8} 格内未配对到同向出口`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          }
        }
      } else {
        if (!ugPairedIds.has(b.id)) {
          const fromWall =
            isBoundaryMissing(b.x - dx, b.y - dy, b.floor) ||
            isBoundaryMissing(b.x - dx * 2, b.y - dy * 2, b.floor);
          if (fromWall) {
            entrySourceKind.set(b.id, 'wall-stub');
          } else {
            pushFault(
              'error',
              'unpaired-underground',
              en ? `Underground OUT (${b.x},${b.y}) has no matching IN` : `地下带出口 (${b.x},${b.y}) 没有配对的地下带入口`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          }
        }
        const fx = b.x + dx;
        const fy = b.y + dy;
        const frontElev = fcGet(elevatorPorts, b.floor, fx, fy);
        const frontElevMatch = frontElev && b.rotation === oppositeRot(frontElev.outDir) ? frontElev : null;
        const frontDock = fcGet(dockPorts, b.floor, fx, fy);
        const frontDockMatch = frontDock && b.rotation === oppositeRot(frontDock.outDir) ? frontDock : null;
        if (frontElevMatch) {
          exitSinkKind.set(b.id, 'elevator');
          boundaryExits.add(b.id);
          pushElev(elevInByCol, frontElevMatch.colKey, { bid: b.id, floor: b.floor, modOrder: frontElevMatch.modOrder });
        } else if (frontDockMatch) {
          exitSinkKind.set(b.id, 'dock');
          boundaryExits.add(b.id);
        } else {
          const { target: mTarget, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, b.rotation);
          if (mTarget) {
            addEdge(b.id, mTarget.building.id, undefined, mTarget.portIndex);
          } else if (disabledHit) {
            const mDef = defById.get(disabledHit.building.id);
            addEdge(b.id, disabledHit.building.id, undefined, disabledHit.portIndex);
            pushFault(
              'warn',
              'disabled-port-input',
              en
                ? `Underground OUT (${b.x},${b.y}) enters disabled port on ${mDef?.nameEn ?? disabledHit.building.type}`
                : `地下带出口 (${b.x},${b.y}) 指向 ${mDef?.nameZh ?? disabledHit.building.type} 的禁用口（实机仍可进料）`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          } else {
            const front = fcGet(cellMap, b.floor, fx, fy);
            if (front) {
              const fDef = defById.get(front.id)!;
              const res = canLogisticsAcceptFrom(front, fDef, b.rotation, fx, fy);
              if (res.ok) addEdge(b.id, front.id, undefined, res.inPortIndex);
              else {
                pushFault(
                  'error',
                  'port-mismatch',
                  en
                    ? `Underground OUT (${b.x},${b.y}) cannot feed ${fDef.nameEn}`
                    : `地下带出口 (${b.x},${b.y}) 无法接入前方 ${fDef.nameZh}`,
                  b.floor,
                  b.x,
                  b.y,
                  b.id
                );
              }
            } else if (isBoundaryMissing(fx, fy, b.floor)) {
              if (isDoorwayThresholdCellFast(b.x, b.y, b.floor)) {
                exitSinkKind.set(b.id, 'doorway');
                boundaryExits.add(b.id);
              } else {
                pushFault(
                  'error',
                  'dead-end-belt',
                  en ? `Underground OUT (${b.x},${b.y}) dead-ends into outer wall` : `地下带出口 (${b.x},${b.y}) 撞墙死路`,
                  b.floor,
                  b.x,
                  b.y,
                  b.id
                );
              }
            } else {
              openTailCandidates.add(b.id);
            }
          }
        }
      }
      continue;
    }

    if (def.kind === 'splitter' || def.kind === 'balancer') {
      const worldPorts = getBuildingWorldPorts(b, def);
      for (const wp of worldPorts) {
        if (wp.port.role === 'in') {
          const inDir = SIDE_TO_ROT[wp.side];
          const [idx, idy] = rotationToDelta(inDir);
          const insideX = wp.outsideCellX - idx;
          const insideY = wp.outsideCellY - idy;
          const elevHit = fcGet(elevatorPorts, b.floor, wp.outsideCellX, wp.outsideCellY);
          const dockHit = fcGet(dockPorts, b.floor, wp.outsideCellX, wp.outsideCellY);
          if (elevHit) {
            entrySourceKind.set(b.id, 'elevator');
            pushElev(elevOutByCol, elevHit.colKey, {
              bid: b.id,
              floor: b.floor,
              modOrder: elevHit.modOrder,
              toPortIndex: wp.port.index,
            });
          } else if (dockHit) {
            entrySourceKind.set(b.id, 'dock');
            if (dockHit.itemId) dockEntryItem.set(b.id, dockHit.itemId);
          } else if (
            !fcGet(cellMap, b.floor, wp.outsideCellX, wp.outsideCellY) &&
            isBoundaryMissing(wp.outsideCellX, wp.outsideCellY, b.floor) &&
            isDoorwayThresholdCellFast(insideX, insideY, b.floor)
          ) {
            entrySourceKind.set(b.id, 'doorway');
          }
          continue;
        }
        if (wp.port.role !== 'out' || !wp.enabled) continue;
        const outDir = SIDE_TO_ROT[wp.side];
        const ox = wp.outsideCellX;
        const oy = wp.outsideCellY;
        const filterItem = b.portFilters?.[wp.port.index];
        const [odx, ody] = rotationToDelta(outDir);
        const insideX = ox - odx;
        const insideY = oy - ody;

        const frontElev = fcGet(elevatorPorts, b.floor, ox, oy);
        const frontDock = fcGet(dockPorts, b.floor, ox, oy);
        if (frontElev && outDir === oppositeRot(frontElev.outDir)) {
          exitSinkKind.set(b.id, 'elevator');
          boundaryExits.add(b.id);
          pushElev(elevInByCol, frontElev.colKey, {
            bid: b.id,
            floor: b.floor,
            modOrder: frontElev.modOrder,
            portIndex: wp.port.index,
            filterItem,
          });
          continue;
        }
        if (frontDock && outDir === oppositeRot(frontDock.outDir)) {
          exitSinkKind.set(b.id, 'dock');
          boundaryExits.add(b.id);
          continue;
        }

        const { target: mTarget, disabledHit } = findEnabledMachinePortAccepting(b.floor, insideX, insideY, outDir);
        if (mTarget) {
          addEdge(b.id, mTarget.building.id, wp.port.index, mTarget.portIndex, filterItem);
          continue;
        }
        if (disabledHit) {
          const mDef = defById.get(disabledHit.building.id);
          addEdge(b.id, disabledHit.building.id, wp.port.index, disabledHit.portIndex, filterItem);
          pushFault(
            'warn',
            'disabled-port-input',
            en
              ? `${def.nameEn} (${b.x},${b.y}) enters disabled port on ${mDef?.nameEn ?? disabledHit.building.type}`
              : `${def.nameZh} (${b.x},${b.y}) 指向 ${mDef?.nameZh ?? disabledHit.building.type} 的禁用口（实机仍可进料）`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
          continue;
        }

        const front = fcGet(cellMap, b.floor, ox, oy);
        if (front) {
          const fDef = defById.get(front.id)!;
          const res = canLogisticsAcceptFrom(front, fDef, outDir, ox, oy);
          if (res.ok) {
            addEdge(b.id, front.id, wp.port.index, res.inPortIndex, filterItem);
          } else if (def.kind === 'balancer') {
            pushFault(
              'error',
              'port-mismatch',
              en
                ? `Balancer (${b.x},${b.y}) output blocked by ${fDef.nameEn}`
                : `平衡器 (${b.x},${b.y}) 出口无法接入 ${fDef.nameZh}`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          }
        } else if (isBoundaryMissing(ox, oy, b.floor) && isDoorwayThresholdCellFast(insideX, insideY, b.floor)) {
          exitSinkKind.set(b.id, 'doorway');
          boundaryExits.add(b.id);
        }
      }
      continue;
    }

    if (def.kind === 'crafter' || def.kind === 'research' || def.kind === 'container') {
      for (const wp of getBuildingWorldPorts(b, def)) {
        if (!wp.enabled) continue;
        const outDir = SIDE_TO_ROT[wp.side];
        const ox = wp.outsideCellX;
        const oy = wp.outsideCellY;
        const filterItem = b.portFilters?.[wp.port.index];

        const frontElev = fcGet(elevatorPorts, b.floor, ox, oy);
        if (frontElev && outDir === oppositeRot(frontElev.outDir)) {
          pushElev(elevInByCol, frontElev.colKey, {
            bid: b.id,
            floor: b.floor,
            modOrder: frontElev.modOrder,
            portIndex: wp.port.index,
            filterItem,
          });
          continue;
        }

        const front = fcGet(cellMap, b.floor, ox, oy);
        if (!front) continue;
        const fDef = defById.get(front.id)!;
        if (fDef.kind === 'belt') {
          if (front.rotation !== oppositeRot(outDir)) {
            addEdge(b.id, front.id, wp.port.index, undefined, filterItem);
          }
        } else if (fDef.kind === 'underground') {
          if (front.undergroundMode === 'in' && front.rotation === outDir) {
            addEdge(b.id, front.id, wp.port.index, undefined, filterItem);
          }
        } else if (fDef.kind === 'splitter' || fDef.kind === 'balancer') {
          const res = canLogisticsAcceptFrom(front, fDef, outDir, ox, oy);
          if (res.ok) addEdge(b.id, front.id, wp.port.index, res.inPortIndex, filterItem);
        } else if (fDef.kind === 'crafter' || fDef.kind === 'research' || fDef.kind === 'container') {
          const oppSide = oppositeRot(outDir);
          const [odx, ody] = rotationToDelta(outDir);
          const fPorts = getBuildingWorldPorts(front, fDef);
          const matched = fPorts.find(
            (fp) => SIDE_TO_ROT[fp.side] === oppSide && fp.outsideCellX === ox - odx && fp.outsideCellY === oy - ody
          );
          if (matched) addEdge(b.id, front.id, wp.port.index, matched.port.index, filterItem);
        }
      }
    }
  }

  // Wire virtual Observatory outgoing ports
  for (const vo of virtualObservatories) {
    const b = vo.building;
    const outDir = vo.sideDir;
    for (const pc of vo.portCells) {
      const front = fcGet(cellMap, b.floor, pc.adjX, pc.adjY);
      if (!front) continue;
      const fDef = defById.get(front.id)!;
      if (fDef.kind === 'belt') {
        if (front.rotation !== oppositeRot(outDir)) addEdge(b.id, front.id, pc.portIndex);
      } else if (fDef.kind === 'underground') {
        if (front.undergroundMode === 'in' && front.rotation === outDir) addEdge(b.id, front.id, pc.portIndex);
      } else if (fDef.kind === 'splitter' || fDef.kind === 'balancer') {
        const res = canLogisticsAcceptFrom(front, fDef, outDir, pc.adjX, pc.adjY);
        if (res.ok) addEdge(b.id, front.id, pc.portIndex, res.inPortIndex);
      }
    }
  }

  // Link vertical elevator columns across floors
  for (const [colKey, ins] of elevInByCol.entries()) {
    const rawOuts = elevOutByCol.get(colKey);
    if (!rawOuts || rawOuts.length === 0) continue;
    const outs = [...rawOuts].sort((a, z) => a.modOrder - z.modOrder || a.floor - z.floor);
    for (const inRec of ins) {
      let linked = 0;
      for (const outRec of outs) {
        if (outRec.floor === inRec.floor) continue;
        addEdge(inRec.bid, outRec.bid, inRec.portIndex, outRec.toPortIndex, inRec.filterItem);
        entrySourceKind.delete(outRec.bid);
        linked++;
      }
      if (linked > 0) {
        boundaryExits.delete(inRec.bid);
        exitSinkKind.delete(inRec.bid);
      }
    }
  }

  const isLogistics = (id: string) => {
    const k = defById.get(id)?.kind;
    return k === 'belt' || k === 'underground' || k === 'splitter' || k === 'balancer';
  };

  /* ---------- 5. Open Endpoints & Orphan Scrap Classification ---------- */
  for (const bid of openTailCandidates) {
    if ((inEdges.get(bid)?.length ?? 0) > 0 || entrySourceKind.has(bid)) {
      exitSinkKind.set(bid, 'open-belt');
      boundaryExits.add(bid);
    }
  }

  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    const def = defById.get(b.id);
    if (!def) continue;
    const hasIn = (inEdges.get(b.id)?.length ?? 0) > 0;
    const hasOut = (outEdges.get(b.id)?.length ?? 0) > 0;
    const hasExit = boundaryExits.has(b.id);

    if (def.kind === 'container' && !hasIn && hasOut && b.filterItems && b.filterItems.length > 0) {
      entrySourceKind.set(b.id, 'source-container');
      continue;
    }

    if (def.kind === 'belt' && !hasIn && !entrySourceKind.has(b.id)) {
      if (hasOut || hasExit) {
        entrySourceKind.set(b.id, 'open-belt');
      } else if (!frontFaultIds.has(b.id)) {
        pushFault(
          'error',
          'orphan-belt',
          en ? `Orphan belt (${b.x},${b.y}): no upstream or downstream` : `孤立废带 (${b.x},${b.y})：既无上游也无下游连接`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }
    } else if ((def.kind === 'splitter' || def.kind === 'balancer') && !hasIn && !entrySourceKind.has(b.id)) {
      if (hasOut || hasExit) {
        entrySourceKind.set(b.id, 'open-belt');
      } else if (def.kind === 'balancer') {
        pushFault(
          'error',
          'orphan-belt',
          en ? `Orphan balancer (${b.x},${b.y}): no connections` : `孤立平衡器 (${b.x},${b.y})：既无上游也无下游连接`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }
    }
  }

  /* ---------- 6. Pure-Graph External Entry Inference & Multi-Output Binding ---------- */
  const traceToCrafters = (
    startId: string,
    traverseContainers = false
  ): Array<{ crafterId: string; portIndex: number; filterHint?: string }> => {
    const visited = new Set<string>([startId]);
    const queue: Array<{ id: string; filterHint?: string }> = [{ id: startId }];
    let qHead = 0;
    const hits: Array<{ crafterId: string; portIndex: number; filterHint?: string }> = [];
    while (qHead < queue.length) {
      const cur = queue[qHead++];
      const outs = outEdges.get(cur.id);
      if (!outs) continue;
      for (let i = 0; i < outs.length; i++) {
        const e = outs[i];
        const nextDef = defById.get(e.toId);
        if (!nextDef) continue;
        const nextB = buildingById.get(e.toId);
        const containerHint =
          nextDef.kind === 'container' && nextB?.filterItems && nextB.filterItems.length === 1
            ? nextB.filterItems[0]
            : undefined;
        const hint = e.filterItem ?? containerHint ?? cur.filterHint;
        if (nextDef.kind === 'crafter' || nextDef.kind === 'research') {
          hits.push({ crafterId: e.toId, portIndex: e.toPortIndex ?? -1, filterHint: hint });
        } else if ((isLogistics(e.toId) || (traverseContainers && nextDef.kind === 'container')) && !visited.has(e.toId)) {
          visited.add(e.toId);
          queue.push({ id: e.toId, filterHint: hint });
        }
      }
    }
    return hits;
  };

  // Multi-output crafter port binding (Pass A/B/C)
  const crafterPortOutputItem = new Map<string, Map<number, string>>();
  const committedTrunkItem = new Map<string, string>();
  const collectDownstreamTrunkNodes = (startId: string): string[] => {
    const visited = new Set<string>();
    const queue = [startId];
    let qHead = 0;
    const nodes: string[] = [];
    while (qHead < queue.length) {
      const cur = queue[qHead++];
      if (visited.has(cur)) continue;
      visited.add(cur);
      const curDef = defById.get(cur);
      if (!curDef || curDef.kind === 'crafter' || curDef.kind === 'research') continue;
      nodes.push(cur);
      const outs = outEdges.get(cur);
      if (!outs) continue;
      for (let i = 0; i < outs.length; i++) {
        const oe = outs[i];
        if (!oe.filterItem && !visited.has(oe.toId)) queue.push(oe.toId);
      }
    }
    return nodes;
  };

  for (const b of allNodes) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec || rec.outputs.length <= 1) continue;
    const outs = outEdges.get(b.id);
    if (!outs || outs.length === 0) continue;

    const pMap = new Map<number, string>();
    const assignedOutputItems = new Set<string>();
    const remainingOuts: Array<{ oe: OutEdge; trunkNodes: string[] }> = [];

    const bindPort = (oe: OutEdge, itemId: string, trunkNodes: string[]) => {
      pMap.set(oe.portIndex ?? -1, itemId);
      assignedOutputItems.add(itemId);
      for (let i = 0; i < trunkNodes.length; i++) {
        if (!committedTrunkItem.has(trunkNodes[i])) committedTrunkItem.set(trunkNodes[i], itemId);
      }
    };

    for (const oe of outs) {
      const trunkNodes = collectDownstreamTrunkNodes(oe.toId);
      let matchedItem: string | undefined;
      if (oe.filterItem && rec.outputs.some((o) => o.itemId === oe.filterItem)) {
        matchedItem = oe.filterItem;
      } else {
        const downHits = traceToCrafters(oe.toId, true);
        const hintItem = downHits.find(
          (h) => h.filterHint && rec.outputs.some((o) => o.itemId === h.filterHint)
        )?.filterHint;
        if (hintItem) {
          matchedItem = hintItem;
        } else {
          const consumedMatches = rec.outputs.filter((o) =>
            downHits.some((h) => {
              const hr = getRecipeDef(buildingById.get(h.crafterId)?.recipeId ?? '');
              return Boolean(hr?.inputs.some((ri) => ri.itemId === o.itemId));
            })
          );
          if (consumedMatches.length === 1) matchedItem = consumedMatches[0].itemId;
        }
      }
      if (matchedItem && !assignedOutputItems.has(matchedItem)) {
        bindPort(oe, matchedItem, trunkNodes);
      } else {
        remainingOuts.push({ oe, trunkNodes });
      }
    }

    const stillUnassigned: Array<{ oe: OutEdge; trunkNodes: string[] }> = [];
    for (const item of remainingOuts) {
      let trunkMatch: string | undefined;
      for (const nid of item.trunkNodes) {
        const existing = committedTrunkItem.get(nid);
        if (existing && !assignedOutputItems.has(existing) && rec.outputs.some((o) => o.itemId === existing)) {
          trunkMatch = existing;
          break;
        }
      }
      if (trunkMatch) bindPort(item.oe, trunkMatch, item.trunkNodes);
      else stillUnassigned.push(item);
    }

    const unassignedOutputs = rec.outputs.filter((o) => !assignedOutputItems.has(o.itemId));
    const fallbackOutputs = unassignedOutputs.length > 0 ? unassignedOutputs : rec.outputs;
    const sortedRem = [...stillUnassigned].sort((a, z) => (a.oe.portIndex ?? 0) - (z.oe.portIndex ?? 0));
    for (let i = 0; i < sortedRem.length; i++) {
      bindPort(sortedRem[i].oe, fallbackOutputs[Math.min(i, fallbackOutputs.length - 1)].itemId, sortedRem[i].trunkNodes);
    }
    crafterPortOutputItem.set(b.id, pMap);
  }

  // Forward-seed internally produced items via O(V+E) multi-source BFS
  const nodeItems = new Map<string, Set<string>>();
  const propQueue: string[] = [];
  const inPropQueue = new Set<string>();

  const addNodeItem = (nodeId: string, itemId: string) => {
    let set = nodeItems.get(nodeId);
    if (!set) {
      set = new Set();
      nodeItems.set(nodeId, set);
    }
    if (!set.has(itemId)) {
      set.add(itemId);
      if (!inPropQueue.has(nodeId)) {
        inPropQueue.add(nodeId);
        propQueue.push(nodeId);
      }
    }
  };

  const runPropagation = () => {
    let qHead = 0;
    while (qHead < propQueue.length) {
      const cur = propQueue[qHead++];
      inPropQueue.delete(cur);
      const curDef = defById.get(cur);
      if (!curDef) continue;
      if (curDef.kind === 'crafter' || curDef.kind === 'research' || curDef.kind === 'reactor') continue;
      const items = nodeItems.get(cur);
      if (!items || items.size === 0) continue;
      const outs = outEdges.get(cur);
      if (!outs || outs.length === 0) continue;

      const curB = buildingById.get(cur);
      const containerAllow =
        curDef.kind === 'container' && curB?.filterItems && curB.filterItems.length > 0
          ? new Set(curB.filterItems)
          : null;
      let siblingFiltered: Set<string> | null = null;
      if (curDef.kind === 'splitter' || curDef.kind === 'balancer') {
        for (let i = 0; i < outs.length; i++) {
          const fi = outs[i].filterItem;
          if (fi) {
            if (!siblingFiltered) siblingFiltered = new Set();
            siblingFiltered.add(fi);
          }
        }
      }
      for (let i = 0; i < outs.length; i++) {
        const oe = outs[i];
        for (const it of items) {
          if (containerAllow && !containerAllow.has(it)) continue;
          if (oe.filterItem) {
            if (oe.filterItem !== it) continue;
          } else if (siblingFiltered && siblingFiltered.has(it)) {
            continue;
          }
          addNodeItem(oe.toId, it);
        }
      }
    }
    propQueue.length = 0;
  };

  // Seed 1: Crafter & Observatory outputs
  for (const b of allNodes) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec || rec.outputs.length === 0) continue;
    const pMap = crafterPortOutputItem.get(b.id);
    const outs = outEdges.get(b.id) ?? [];
    for (let oi = 0; oi < outs.length; oi++) {
      const oe = outs[oi];
      const itemId =
        rec.outputs.length === 1
          ? rec.outputs[0].itemId
          : pMap?.get(oe.portIndex ?? -1) ?? oe.filterItem ?? rec.outputs[oi % rec.outputs.length].itemId;
      if (oe.filterItem && oe.filterItem !== itemId) continue;
      addNodeItem(oe.toId, itemId);
    }
  }
  // Seed 2: Explicit dock filters & source containers
  const entryItem = new Map<string, string[]>();
  for (const eid of entrySourceKind.keys()) {
    const eb = buildingById.get(eid)!;
    const ebDef = defById.get(eid)!;
    const dockIt = dockEntryItem.get(eid);
    if (dockIt) {
      entryItem.set(eid, [dockIt]);
      addNodeItem(eid, dockIt);
      continue;
    }
    if (ebDef.kind === 'container' && eb.filterItems && eb.filterItems.length > 0) {
      entryItem.set(eid, [...eb.filterItems]);
      for (const it of eb.filterItems) addNodeItem(eid, it);
    }
  }
  runPropagation();

  // Seed 3: Infer unlabeled open entries (doorway / open-belt / unlinked elevator) via MRV
  const getEntryModuleSymSig = (eb: PlacedBuilding): { sortKey: number; symKey: string } => {
    const host = findModuleAtWorldPoint(doc, eb.x + 0.5, eb.y + 0.5, eb.floor);
    if (host) {
      const mDef = getModuleDef(host.type);
      if (mDef) {
        const [mcx, mcy] = getModuleCenterM(host, mDef);
        const invRot = normalizeRotation(4 - host.rotation);
        const [lx, ly] = rotateVec2(eb.x + 0.5 - mcx, eb.y + 0.5 - mcy, invRot);
        const ax = Math.round(Math.abs(lx) * 2);
        const ay = Math.round(Math.abs(ly) * 2);
        if (ax >= ay) return { sortKey: ay, symKey: `${host.id}:x${Math.round(lx * 2)}:ay${ay}` };
        return { sortKey: ax, symKey: `${host.id}:y${Math.round(ly * 2)}:ax${ax}` };
      }
    }
    return { sortKey: eb.x + eb.y, symKey: `free:${eb.floor}:${eb.x},${eb.y}` };
  };

  const crafterSatisfied = new Map<string, Set<string>>();
  for (const b of allNodes) {
    const items = nodeItems.get(b.id);
    if (items && items.size > 0) crafterSatisfied.set(b.id, new Set(items));
  }

  const pendingEntries: Array<{
    eid: string;
    eb: PlacedBuilding;
    hits: Array<{ crafterId: string; portIndex: number; filterHint?: string }>;
    candidateItems: string[];
    groupSig: string;
    sortKey: number;
  }> = [];

  for (const eid of entrySourceKind.keys()) {
    if (entryItem.has(eid)) continue;
    const eb = buildingById.get(eid)!;
    const hits = traceToCrafters(eid, true);
    if (hits.length === 0) continue;

    const explicitHint = hits.find((h) => h.filterHint)?.filterHint;
    if (explicitHint) {
      entryItem.set(eid, [explicitHint]);
      addNodeItem(eid, explicitHint);
      for (const h of hits) {
        let s = crafterSatisfied.get(h.crafterId);
        if (!s) {
          s = new Set();
          crafterSatisfied.set(h.crafterId, s);
        }
        s.add(explicitHint);
      }
      continue;
    }

    const firstRec = getRecipeDef(buildingById.get(hits[0].crafterId)?.recipeId ?? '');
    if (!firstRec || firstRec.inputs.length === 0) continue;

    const candidateItems = firstRec.inputs
      .map((i) => i.itemId)
      .filter((itemId) =>
        hits.every((h) => {
          const r = getRecipeDef(buildingById.get(h.crafterId)?.recipeId ?? '');
          return !r || r.inputs.some((ri) => ri.itemId === itemId);
        })
      );
    if (candidateItems.length === 0) continue;

    const { sortKey, symKey } = getEntryModuleSymSig(eb);
    const targetRecipesSig = Array.from(new Set(hits.map((h) => buildingById.get(h.crafterId)?.recipeId ?? '')))
      .sort()
      .join(',');
    pendingEntries.push({
      eid,
      eb,
      hits,
      candidateItems,
      groupSig: `${eb.floor}:${symKey}:${targetRecipesSig}`,
      sortKey,
    });
  }

  pendingEntries.sort(
    (a, b) =>
      a.candidateItems.length - b.candidateItems.length ||
      a.sortKey - b.sortKey ||
      a.eb.floor - b.eb.floor ||
      a.eb.x - b.eb.x ||
      a.eb.y - b.eb.y
  );

  const groupItemBySig = new Map<string, string>();
  for (const pe of pendingEntries) {
    let chosen = groupItemBySig.get(pe.groupSig);
    if (!chosen || !pe.candidateItems.includes(chosen)) {
      let bestItem = pe.candidateItems[0];
      let bestUnsatisfied = -1;
      for (const cand of pe.candidateItems) {
        let unsatisfied = 0;
        for (const h of pe.hits) {
          if (!crafterSatisfied.get(h.crafterId)?.has(cand)) unsatisfied++;
        }
        if (unsatisfied > bestUnsatisfied) {
          bestUnsatisfied = unsatisfied;
          bestItem = cand;
        }
      }
      chosen = bestItem;
      groupItemBySig.set(pe.groupSig, chosen);
    }
    entryItem.set(pe.eid, [chosen]);
    addNodeItem(pe.eid, chosen);
    for (const h of pe.hits) {
      let s = crafterSatisfied.get(h.crafterId);
      if (!s) {
        s = new Set();
        crafterSatisfied.set(h.crafterId, s);
      }
      s.add(chosen);
    }
  }
  runPropagation();

  /* ---------- 7. Pure-Graph Fault Audit & Lazy O(1) Cell Lookup ---------- */
  const ioSpots: WorkbenchIoSpot[] = [];
  let ioSeq = 1;
  const pushIo = (
    direction: 'in' | 'out',
    kind: WorkbenchIoKind,
    floor: number,
    x: number,
    y: number,
    items: string[],
    buildingId?: string
  ) => {
    const label = ioKindLabel(kind, direction, lang);
    const itemText = items.map((id) => getItemName(id, lang)).join(' + ');
    const message = itemText
      ? en
        ? `${label} (${x},${y}): ${itemText}`
        : `${label} (${x},${y})：${itemText}`
      : en
        ? `${label} (${x},${y}): Empty`
        : `${label} (${x},${y})：未接线/空`;
    ioSpots.push({
      id: `io_${ioSeq++}`,
      direction,
      kind,
      floor,
      x,
      y,
      buildingId,
      items,
      message,
    });
  };

  // 7A. Elevator mixed-shaft audit
  for (const [, ins] of elevInByCol.entries()) {
    const shaftItems = new Set<string>();
    for (const rec of ins) {
      const items = nodeItems.get(rec.bid);
      if (!items) continue;
      for (const it of items) {
        if (rec.filterItem && rec.filterItem !== it) continue;
        shaftItems.add(it);
      }
    }
    if (shaftItems.size > 1) {
      const firstB = buildingById.get(ins[0].bid);
      if (firstB) {
        const names = [...shaftItems].map((it) => getItemName(it, lang)).join(' + ');
        pushFault(
          'error',
          'elevator-mixed-shaft',
          en
            ? `Elevator shaft mixes items at (${firstB.x},${firstB.y}): ${names}`
            : `电梯竖井 (${firstB.x},${firstB.y}) 发生多料混装：${names}`,
          firstB.floor,
          firstB.x,
          firstB.y,
          firstB.id
        );
      }
    }
  }

  // 7B. Logistics mixed-item merge points + I/O spots
  const mixedLogisticsIds = new Set<string>();
  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    if (!isLogistics(b.id)) continue;
    const items = nodeItems.get(b.id);
    if (items && items.size > 1) mixedLogisticsIds.add(b.id);
  }

  for (let i = 0; i < doc.buildings.length; i++) {
    const b = doc.buildings[i];
    const def = defById.get(b.id);
    if (!def) continue;

    if (isLogistics(b.id)) {
      const itemSet = nodeItems.get(b.id);
      const mixed = Boolean(itemSet && itemSet.size > 1);
      if (mixed) {
        const hasPortFilter = Boolean(b.portFilters && Object.keys(b.portFilters).length > 0);
        const upstreamAlreadyMixed = (inEdges.get(b.id) ?? []).some((ie) => mixedLogisticsIds.has(ie.fromId));
        if (!upstreamAlreadyMixed && def.kind === 'belt') {
          const names = [...itemSet!].map((it) => getItemName(it, lang)).join(' + ');
          pushFault(
            'warn',
            'mixed-item-belt',
            en ? `Mixed items on belt (${b.x},${b.y}): ${names}` : `混料位 (${b.x},${b.y}) 发生混料：${names}`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
        } else if (!upstreamAlreadyMixed && def.kind === 'splitter' && !hasPortFilter) {
          const names = [...itemSet!].map((it) => getItemName(it, lang)).join(' + ');
          pushFault(
            'warn',
            'mixed-item-belt',
            en
              ? `Unfiltered splitter (${b.x},${b.y}) mixes items: ${names}`
              : `分流器混料位 (${b.x},${b.y}) 未配置过滤：${names}`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
        }
      }

      const entryKind = entrySourceKind.get(b.id);
      if (entryKind) {
        pushIo('in', entryKind, b.floor, b.x, b.y, entryItem.get(b.id) ?? (itemSet ? [...itemSet] : []), b.id);
      }
      if (boundaryExits.has(b.id)) {
        const sinkKind = exitSinkKind.get(b.id);
        if (sinkKind) pushIo('out', sinkKind, b.floor, b.x, b.y, itemSet ? [...itemSet] : [], b.id);
      }
      continue;
    }

    if (def.kind === 'container') {
      const itemSet = nodeItems.get(b.id);
      const items = itemSet ? [...itemSet] : [];
      if (b.filterItems && b.filterItems.length > 0 && items.length > 0) {
        const allow = new Set(b.filterItems);
        for (const it of items) {
          if (!allow.has(it)) {
            pushFault(
              'error',
              'machine-wrong-item',
              en
                ? `Container (${b.x},${b.y}) filter conflict: received "${getItemName(it, lang)}"`
                : `储物箱 (${b.x},${b.y}) 过滤冲突：输入了非白名单物品「${getItemName(it, lang)}」`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          }
        }
      }
      if (entrySourceKind.get(b.id) === 'source-container') {
        pushIo('in', 'source-container', b.floor, b.x, b.y, b.filterItems ?? items, b.id);
      } else if ((outEdges.get(b.id)?.length ?? 0) === 0 && (inEdges.get(b.id)?.length ?? 0) > 0) {
        pushIo('out', 'terminal-container', b.floor, b.x, b.y, items.length > 0 ? items : b.filterItems ?? [], b.id);
      }
    }
  }

  /* ---------- 8. Static Power Ledger & Full-Load Rated Capacity Ledger ---------- */
  let crafterPeakKW = 0;
  let labPeakKW = 0;
  let facilityPeakKW = 0;
  let intermittentPeakKW = 0;
  let solarGenKW = 0;
  let reactorGenKW = 0;
  let generatorCount = 0;

  for (const mod of doc.modules) {
    const mDef = getModuleDef(mod.type);
    if (!mDef) continue;
    if (mDef.powerKW) {
      if (mDef.id.includes('Turret')) intermittentPeakKW += mDef.powerKW;
      else facilityPeakKW += mDef.powerKW;
    }
    if (mDef.powerGenKW) {
      solarGenKW += mDef.powerGenKW;
      generatorCount++;
    }
  }

  let machineCount = 0;
  let configuredMachineCount = 0;
  const grossConsumed = new Map<string, number>();
  const grossProduced = new Map<string, number>();
  const byRecipe = new Map<string, { rec: RecipeDef; count: number }>();

  for (const b of allNodes) {
    const def = defById.get(b.id);
    if (!def) continue;

    if (def.powerGenKW) {
      reactorGenKW += def.powerGenKW;
      generatorCount++;
    }
    if (def.kind === 'teleporter' && def.powerKW) {
      facilityPeakKW += def.powerKW;
      continue;
    }
    if (def.kind === 'research') {
      machineCount++;
      labPeakKW += def.powerKW ?? 0;
      continue;
    }
    if (def.kind !== 'crafter') continue;

    machineCount++;
    crafterPeakKW += def.powerKW ?? 0;
    if (!b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec) continue;
    configuredMachineCount++;

    const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
    for (const inp of rec.inputs) {
      grossConsumed.set(inp.itemId, (grossConsumed.get(inp.itemId) ?? 0) + (inp.quantity ?? 1) / dur);
    }
    for (const out of rec.outputs) {
      grossProduced.set(out.itemId, (grossProduced.get(out.itemId) ?? 0) + (out.quantity ?? 1) / dur);
    }

    let rEntry = byRecipe.get(rec.id);
    if (!rEntry) {
      rEntry = { rec, count: 0 };
      byRecipe.set(rec.id, rEntry);
    }
    rEntry.count++;

    const inItems = nodeItems.get(b.id);
    const reqSet = new Set(rec.inputs.map((i) => i.itemId));
    let hasWrongItem = false;
    if (inItems) {
      for (const it of inItems) {
        if (!reqSet.has(it)) {
          hasWrongItem = true;
          pushFault(
            'error',
            'machine-wrong-item',
            en
              ? `${def.nameEn} (${b.x},${b.y}) receives non-recipe item: ${getItemName(it, lang)}`
              : `${def.nameZh} (${b.x},${b.y}) 混入非配方原料：${getItemName(it, lang)}`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
        }
      }
    }

    const ins = inEdges.get(b.id) ?? [];
    const hasDeadIncoming = ins.some((ie) => (nodeItems.get(ie.fromId)?.size ?? 0) === 0);
    for (const inp of rec.inputs) {
      if (inItems?.has(inp.itemId)) continue;
      if (ins.length === 0 || (!hasWrongItem && !hasDeadIncoming && ins.length < rec.inputs.length)) {
        pushIo('in', 'machine-head', b.floor, b.x, b.y, [inp.itemId], b.id);
      } else {
        pushFault(
          'warn',
          'machine-missing-input',
          en
            ? `${def.nameEn} (${b.x},${b.y}) missing ingredient: ${getItemName(inp.itemId, lang)}`
            : `${def.nameZh} (${b.x},${b.y}) 缺少原料连接：${getItemName(inp.itemId, lang)}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }
    }

    const outs = outEdges.get(b.id) ?? [];
    if (rec.outputs.length > 0 && outs.length === 0) {
      pushFault(
        'error',
        'machine-blocked-output',
        en
          ? `${def.nameEn} (${b.x},${b.y}) has no output belt connected`
          : `${def.nameZh} (${b.x},${b.y}) 未接入输出传送带`,
        b.floor,
        b.x,
        b.y,
        b.id
      );
    }
  }

  // Rated full-load net inputs / outputs
  const allLedgerItems = new Set<string>([...grossConsumed.keys(), ...grossProduced.keys()]);
  const ratedNetInputs: WorkbenchRatedItem[] = [];
  const ratedNetOutputs: WorkbenchRatedItem[] = [];
  for (const itemId of allLedgerItems) {
    const net = (grossProduced.get(itemId) ?? 0) - (grossConsumed.get(itemId) ?? 0);
    if (net < -1e-6) {
      const rate = -net;
      ratedNetInputs.push({ itemId, ratePerSec: round3(rate), beltsMk3: round2(rate / 3) });
    } else if (net > 1e-6) {
      ratedNetOutputs.push({ itemId, ratePerSec: round3(net), beltsMk3: round2(net / 3) });
    }
  }
  ratedNetInputs.sort((a, b) => b.ratePerSec - a.ratePerSec || a.itemId.localeCompare(b.itemId));
  ratedNetOutputs.sort((a, b) => b.ratePerSec - a.ratePerSec || a.itemId.localeCompare(b.itemId));

  const recipeSummary: WorkbenchRecipeSummary[] = Array.from(byRecipe.values())
    .map(({ rec, count }) => {
      const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
      return {
        recipeId: rec.id,
        machineCount: count,
        ratedOutputs: rec.outputs.map((o) => ({
          itemId: o.itemId,
          ratePerSec: round3(((o.quantity ?? 1) / dur) * count),
        })),
      };
    })
    .sort((a, b) => b.machineCount - a.machineCount || a.recipeId.localeCompare(b.recipeId));

  const crafterPeakMW = round2(crafterPeakKW / 1000);
  const labPeakMW = round2(labPeakKW / 1000);
  const facilityPeakMW = round2(facilityPeakKW / 1000);
  const intermittentPeakMW = round2(intermittentPeakKW / 1000);
  const peakDrawMW = round2((crafterPeakKW + labPeakKW + facilityPeakKW + intermittentPeakKW) / 1000);
  const solarGenMW = round2(solarGenKW / 1000);
  const reactorGenMW = round2(reactorGenKW / 1000);
  const maxGenMW = round2((solarGenKW + reactorGenKW) / 1000);
  const minGenMW = round2((solarGenKW * 0.2 + reactorGenKW) / 1000);
  const netBalanceMW = round2(maxGenMW - peakDrawMW);

  faults.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return a.floor - b.floor || a.x - b.x || a.y - b.y;
  });

  const errorCount = faults.filter((f) => f.severity === 'error').length;
  const warnCount = faults.length - errorCount;
  const inputSpotCount = ioSpots.filter((s) => s.direction === 'in').length;
  const outputSpotCount = ioSpots.length - inputSpotCount;

  const getCellItem = (floor: number, x: number, y: number): WorkbenchCellItemInfo | null => {
    const b = fcGet(cellMap, floor, x, y);
    if (!b) return null;
    const def = defById.get(b.id);
    if (!def || !isLogistics(b.id)) return null;
    const tier = def.tier ?? 1;
    const laneSpeed = getTierSpeed(tier);
    const capacity = def.kind === 'balancer' ? laneSpeed * 2 : laneSpeed;
    const itemSet = nodeItems.get(b.id);
    const items = itemSet ? [...itemSet] : [];
    return { items, tier, capacity, mixed: items.length > 1 };
  };

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    durationMs: Math.round((t1 - t0) * 10) / 10,
    passed: errorCount === 0,
    errorCount,
    warnCount,
    faults,
    ioSpots,
    inputSpotCount,
    outputSpotCount,
    machineCount,
    configuredMachineCount,
    ratedNetInputs,
    ratedNetOutputs,
    recipeSummary,
    power: {
      crafterPeakMW,
      labPeakMW,
      facilityPeakMW,
      intermittentPeakMW,
      peakDrawMW,
      solarGenMW,
      reactorGenMW,
      maxGenMW,
      minGenMW,
      netBalanceMW,
      generatorCount,
    },
    getCellItem,
  };
}
