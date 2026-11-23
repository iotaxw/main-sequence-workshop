import { getBuildableDef, getItemNameZh, getModuleDef, getRecipeDef } from './catalog';
import {
  computeUndergroundLinks,
  findModuleAtWorldPoint,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  getModuleCenterM,
  isCellBuildable,
  normalizeRotation,
  rotateVec2,
  rotationToDelta,
} from './geometry';
import type { BlueprintDocument, BuildableDef, PlacedBuilding, RecipeDef, Rotation } from './types';

export type SimulationIssueSeverity = 'error' | 'warn';

export type SimulationIssueCode =
  | 'external-input-needed'
  | 'blueprint-output'
  | 'disabled-port-input'
  | 'power-deficit'
  | 'orphan-belt'
  | 'dead-end-belt'
  | 'head-on-belt'
  | 'unpaired-underground'
  | 'splitter-leak'
  | 'port-mismatch'
  | 'mixed-item-belt'
  | 'belt-overload'
  | 'machine-missing-input'
  | 'machine-wrong-item'
  | 'machine-blocked-output';

export interface SimulationIssue {
  id: string;
  severity: SimulationIssueSeverity;
  code: SimulationIssueCode;
  message: string;
  floor: number;
  x: number;
  y: number;
  buildingId?: string;
}

export interface ExternalInputSpot {
  id: string;
  floor: number;
  x: number;
  y: number;
  buildingId: string;
  sourceKind: 'doorway' | 'elevator' | 'wall-stub' | 'open-belt' | 'source-container' | 'machine-head';
  itemId: string | null;
  nameZh: string;
  requiredRatePerSec: number;
  suppliedRatePerSec: number;
  capacityPerSec: number;
  bottlenecked: boolean;
}

export interface FlowItemRate {
  itemId: string;
  nameZh: string;
  ratePerSec: number;
  beltsMk3: number;
}

export interface RecipeRunStat {
  recipeId: string;
  nameZh: string;
  machineCount: number;
  avgEfficiency: number;
  maxOutputRates: FlowItemRate[];
  actualOutputRates: FlowItemRate[];
}

export interface CellFlowInfo {
  items: Record<string, number>;
  totalRate: number;
  capacity: number;
  overloaded: boolean;
}

export interface PowerBreakdown {
  /** Rated peak power consumption of all installed machines, labs, and station facilities (MW) */
  peakDrawMW: number;
  /** Steady-state operating power draw weighted by backpressure-converged efficiency + continuous facilities (MW) */
  activeDrawMW: number;
  /** Maximum rated power generation from all Solar Panels (100% close orbit) and Reactors (MW) */
  maxGenMW: number;
  /** Conservative minimum power generation (20% far-orbit Solar MinEfficiency + fueled Reactors) (MW) */
  minGenMW: number;
  /** Max generation from Solar Panels (12 / 48 / 288 MW each) */
  solarGenMW: number;
  /** Max generation from Reactor Machines (48 MW each, requires fuel) */
  reactorGenMW: number;
  /** Number of generator entities (solar modules + reactors) */
  generatorCount: number;
  /** Net power margin against peak load: maxGenMW - peakDrawMW (MW) */
  netBalanceMW: number;
  /** Net power margin against steady-state active draw: maxGenMW - activeDrawMW (MW) */
  netBalanceActiveMW: number;
  /** Breakdown of peak draw by category */
  crafterPeakMW: number;
  labPeakMW: number;
  facilityPeakMW: number;
  /** Intermittent combat draw (e.g. Station Turrets: counted in peakDrawMW, 0 MW in peacetime activeDrawMW) */
  intermittentPeakMW: number;
}

export interface ExternalOutputSpot {
  id: string;
  floor: number;
  x: number;
  y: number;
  buildingId: string;
  sinkKind: 'doorway' | 'elevator' | 'wall-stub' | 'open-belt';
  items: Array<{ itemId: string; nameZh: string; ratePerSec: number }>;
  totalRatePerSec: number;
  capacityPerSec: number;
}

export interface BalanceHint {
  id: string;
  floor: number;
  x: number;
  y: number;
  itemId: string;
  nameZh: string;
  supplyRatePerSec: number;
  demandRatePerSec: number;
  estDutyRatio: number;
  message: string;
}

export interface SimulationReport {
  passed: boolean;
  errorCount: number;
  warnCount: number;
  /** Count of operational warnings excluding clean head/tail I/O endpoint markers */
  anomalyWarnCount: number;
  issues: SimulationIssue[];
  /** Every head spot where external raw material enters (yellow warning) */
  externalInputs: ExternalInputSpot[];
  /** Every tail spot where blueprint output exits (yellow warning) */
  externalOutputs: ExternalOutputSpot[];
  /** Transparent deterministic hints where internal upstream supply exceeds downstream consumer demand */
  balanceHints: BalanceHint[];
  /** Rated peak power consumption (MW) — backward-compatible alias for power.peakDrawMW */
  totalPowerMW: number;
  /** Full binary-verified power generation & consumption breakdown */
  power: PowerBreakdown;
  machineCount: number;
  configuredMachineCount: number;
  avgEfficiency: number;
  recipeStats: RecipeRunStat[];
  netInputs: FlowItemRate[];
  netOutputs: FlowItemRate[];
  /** Keyed by `${floor}:${x},${y}` */
  cellFlows: Record<string, CellFlowInfo>;
}

/** Verified Build 26639889 conveyor speeds (items/sec): Mk.1=1, Mk.2=2, Mk.3=3 */
export function getTierSpeed(tier: 1 | 2 | 3): number {
  return tier === 3 ? 3.0 : tier === 2 ? 2.0 : 1.0;
}

function cellKey(floor: number, x: number, y: number): string {
  return `${floor}:${x},${y}`;
}

function oppositeRot(r: Rotation): Rotation {
  return ((r + 2) % 4) as Rotation;
}

interface OutEdge {
  toId: string;
  portIndex?: number;
  toPortIndex?: number;
  capacity: number;
  filterItem?: string;
}

interface InEdge {
  fromId: string;
  portIndex?: number;
  capacity: number;
}

function collectElevatorPortCells(doc: BlueprintDocument): Set<string> {
  const ports = new Set<string>();
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def) continue;
    const [cx, cy] = getModuleCenterM(mod, def);
    for (const fl of def.floors) {
      if (!fl.elevatorPorts) continue;
      for (const ep of fl.elevatorPorts) {
        const [rx, ry] = rotateVec2(ep.x, ep.y, mod.rotation);
        const wx = Math.floor(cx + rx);
        const wy = Math.floor(cy + ry);
        ports.add(cellKey(mod.floor + fl.floorOffset, wx, wy));
      }
    }
  }
  return ports;
}

function isDoorwayThresholdCell(doc: BlueprintDocument, x: number, y: number, floor: number): boolean {
  const cx = x + 0.5;
  const cy = y + 0.5;
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def || !def.hasFactoryFloor) continue;
    const [mcx, mcy] = getModuleCenterM(mod, def);
    const invRot = normalizeRotation(4 - mod.rotation);
    const [lx, ly] = rotateVec2(cx - mcx, cy - mcy, invRot);

    for (const fl of def.floors) {
      if (mod.floor + fl.floorOffset !== floor) continue;
      const inInnerRect = lx >= fl.minX && lx <= fl.maxX && ly >= fl.minY && ly <= fl.maxY;
      if (inInnerRect) continue;
      for (const dw of fl.doorways) {
        if (dw.side === 'W' && lx >= fl.minX - 1.01 && lx < fl.minX && ly >= dw.start && ly <= dw.end) return true;
        if (dw.side === 'E' && lx > fl.maxX && lx <= fl.maxX + 1.01 && ly >= dw.start && ly <= dw.end) return true;
        if (dw.side === 'N' && ly >= fl.minY - 1.01 && ly < fl.minY && lx >= dw.start && lx <= dw.end) return true;
        if (dw.side === 'S' && ly > fl.maxY && ly <= fl.maxY + 1.01 && lx >= dw.start && lx <= dw.end) return true;
      }
    }
  }
  return false;
}

function isBoundaryFloorMissing(doc: BlueprintDocument, x: number, y: number, floor: number): boolean {
  return isCellBuildable(doc, x, y, floor) === null;
}

/**
 * Pure deterministic, general-purpose production-line simulator, raw-input tracer, and binary-verified power auditor.
 * Works on ANY BlueprintDocument: standalone sub-lines, single/multi-module hubs, or massive multi-deck stations.
 */
export function simulateBlueprint(doc: BlueprintDocument): SimulationReport {
  const issues: SimulationIssue[] = [];
  const issueKeys = new Set<string>();
  let issueSeq = 1;

  const pushIssue = (
    severity: SimulationIssueSeverity,
    code: SimulationIssueCode,
    message: string,
    floor: number,
    x: number,
    y: number,
    buildingId?: string
  ) => {
    const dedup = `${code}:${floor}:${x},${y}:${buildingId ?? ''}`;
    if (issueKeys.has(dedup)) return;
    issueKeys.add(dedup);
    issues.push({
      id: `sim_${issueSeq++}`,
      severity,
      code,
      message,
      floor,
      x,
      y,
      buildingId,
    });
  };

  // 1. Spatial index of all buildings & definitions
  const defById = new Map<string, BuildableDef>();
  const buildingById = new Map<string, PlacedBuilding>();
  const cellMap = new Map<string, PlacedBuilding>();
  const elevatorPorts = collectElevatorPortCells(doc);

  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    defById.set(b.id, def);
    buildingById.set(b.id, b);
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        cellMap.set(cellKey(b.floor, b.x + dx, b.y + dy), b);
      }
    }
  }

  // Index active world ports for machines, labs, reactors & containers
  interface AdjacentPortTarget {
    building: PlacedBuilding;
    portIndex: number;
    sideDir: Rotation;
    enabled: boolean;
  }
  const machinePortsByAdjCell = new Map<string, AdjacentPortTarget[]>();
  const addAdjPort = (k: string, t: AdjacentPortTarget) => {
    const arr = machinePortsByAdjCell.get(k);
    if (arr) arr.push(t);
    else machinePortsByAdjCell.set(k, [t]);
  };

  const SIDE_TO_ROT: Record<'E' | 'S' | 'W' | 'N', Rotation> = { E: 0, S: 1, W: 2, N: 3 };

  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    if (def.kind !== 'crafter' && def.kind !== 'research' && def.kind !== 'container' && def.kind !== 'reactor') continue;
    const worldPorts = getBuildingWorldPorts(b, def);
    for (const wp of worldPorts) {
      const sideDir = SIDE_TO_ROT[wp.side];
      addAdjPort(cellKey(b.floor, wp.outsideCellX, wp.outsideCellY), {
        building: b,
        portIndex: wp.port.index,
        sideDir,
        enabled: wp.enabled,
      });
    }
  }

  // Pair underground belts
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

  // Directed graph adjacency
  const outEdges = new Map<string, OutEdge[]>();
  const inEdges = new Map<string, InEdge[]>();
  const addEdge = (
    fromId: string,
    toId: string,
    capacity: number,
    outPortIndex?: number,
    inPortIndex?: number,
    filterItem?: string
  ) => {
    let outs = outEdges.get(fromId);
    if (!outs) {
      outs = [];
      outEdges.set(fromId, outs);
    }
    if (!outs.some((e) => e.toId === toId && e.portIndex === outPortIndex && e.toPortIndex === inPortIndex)) {
      outs.push({ toId, portIndex: outPortIndex, toPortIndex: inPortIndex, capacity, filterItem });
    }
    let ins = inEdges.get(toId);
    if (!ins) {
      ins = [];
      inEdges.set(toId, ins);
    }
    if (!ins.some((e) => e.fromId === fromId && e.portIndex === inPortIndex)) {
      ins.push({ fromId, portIndex: inPortIndex, capacity });
    }
  };

  // Track external input sources (首) and output sinks (尾) with their exact boundary kind
  const entrySourceKind = new Map<string, ExternalInputSpot['sourceKind']>();
  const exitSinkKind = new Map<string, ExternalOutputSpot['sinkKind']>();
  const boundaryExits = new Set<string>();
  const openTailCandidates = new Set<string>();
  const frontFaultIds = new Set<string>();

  const findEnabledMachinePortAccepting = (
    floor: number,
    srcX: number,
    srcY: number,
    pushDir: Rotation
  ): { target: AdjacentPortTarget | null; disabledHit: AdjacentPortTarget | null } => {
    const candidates = machinePortsByAdjCell.get(cellKey(floor, srcX, srcY));
    if (!candidates) return { target: null, disabledHit: null };
    const wantSide = oppositeRot(pushDir);
    let disabledHit: AdjacentPortTarget | null = null;
    for (const c of candidates) {
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
      const worldPorts = getBuildingWorldPorts(target, targetDef);
      const [pdx, pdy] = rotationToDelta(pushDir);
      for (const wp of worldPorts) {
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

  // 2. Build directed logistics graph + detect structural/port anomalies
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    const speed = getTierSpeed(def.tier);

    if (def.kind === 'belt') {
      const [dx, dy] = rotationToDelta(b.rotation);
      const bx = b.x - dx;
      const by = b.y - dy;
      const fx = b.x + dx;
      const fy = b.y + dy;

      if (elevatorPorts.has(cellKey(b.floor, bx, by))) {
        entrySourceKind.set(b.id, 'elevator');
      } else if (isDoorwayThresholdCell(doc, b.x, b.y, b.floor) && isBoundaryFloorMissing(doc, bx, by, b.floor)) {
        entrySourceKind.set(b.id, 'doorway');
      }

      const { target: machHit, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, b.rotation);
      if (machHit) {
        addEdge(b.id, machHit.building.id, speed, undefined, machHit.portIndex);
      } else if (disabledHit) {
        // Real game rule: disabling a machine/container port ONLY blocks output, NOT input! Connect normally + yellow warn.
        addEdge(b.id, disabledHit.building.id, speed, undefined, disabledHit.portIndex);
        pushIssue(
          'warn',
          'disabled-port-input',
          `传送带 (${b.x},${b.y}) 接入了已禁用输出的端口（实机仅禁出，仍可正常进料）`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      } else if (elevatorPorts.has(cellKey(b.floor, fx, fy))) {
        exitSinkKind.set(b.id, 'elevator');
        boundaryExits.add(b.id);
      } else if (isDoorwayThresholdCell(doc, b.x, b.y, b.floor) && isBoundaryFloorMissing(doc, fx, fy, b.floor)) {
        exitSinkKind.set(b.id, 'doorway');
        boundaryExits.add(b.id);
      } else {
        const nb = cellMap.get(cellKey(b.floor, fx, fy));
        if (!nb) {
          if (isBoundaryFloorMissing(doc, fx, fy, b.floor)) {
            frontFaultIds.add(b.id);
            pushIssue(
              'error',
              'dead-end-belt',
              `传送带 (${b.x},${b.y}) 直撞实心舱壁（前方无舱门也无地板）`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          } else {
            // Open buildable floor ahead: will become a YELLOW tail (尾) if part of a line, or RED isolated scrap if alone!
            openTailCandidates.add(b.id);
          }
        } else {
          const nbDef = defById.get(nb.id)!;
          const acc = canLogisticsAcceptFrom(nb, nbDef, b.rotation, fx, fy);
          if (acc.ok) {
            addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), undefined, acc.inPortIndex);
          } else if (acc.headOn) {
            frontFaultIds.add(b.id);
            pushIssue('error', 'head-on-belt', `传送带 (${b.x},${b.y}) 与 (${fx},${fy}) 正面对撞`, b.floor, b.x, b.y, b.id);
          } else {
            frontFaultIds.add(b.id);
            pushIssue(
              'error',
              'port-mismatch',
              `传送带 (${b.x},${b.y}) 朝向或接口与下游 ${nbDef.nameZh} (${fx},${fy}) 不匹配`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          }
        }
      }
    } else if (def.kind === 'underground') {
      const [dx, dy] = rotationToDelta(b.rotation);
      if (!ugPairedIds.has(b.id)) {
        const fx = b.x + dx;
        const fy = b.y + dy;
        const bx = b.x - dx;
        const by = b.y - dy;
        const isWallStub =
          (b.undergroundMode === 'in' &&
            (isBoundaryFloorMissing(doc, fx, fy, b.floor) || isBoundaryFloorMissing(doc, fx + dx, fy + dy, b.floor))) ||
          (b.undergroundMode === 'out' &&
            (isBoundaryFloorMissing(doc, bx, by, b.floor) || isBoundaryFloorMissing(doc, bx - dx, by - dy, b.floor)));
        if (isWallStub && b.undergroundMode === 'in') {
          exitSinkKind.set(b.id, 'wall-stub');
          boundaryExits.add(b.id);
        } else if (isWallStub && b.undergroundMode === 'out') {
          entrySourceKind.set(b.id, 'wall-stub');
        } else {
          pushIssue(
            'error',
            'unpaired-underground',
            `地下带 (${b.x},${b.y}) 未在 8 格射程内找到配对出/入口`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
        }
      }

      if (b.undergroundMode === 'in') {
        const partner = ugPartnerByIn.get(b.id);
        if (partner) addEdge(b.id, partner.id, speed);
      } else {
        const fx = b.x + dx;
        const fy = b.y + dy;
        const { target: machHit, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, b.rotation);
        if (machHit) {
          addEdge(b.id, machHit.building.id, speed, undefined, machHit.portIndex);
        } else if (disabledHit) {
          addEdge(b.id, disabledHit.building.id, speed, undefined, disabledHit.portIndex);
          pushIssue(
            'warn',
            'disabled-port-input',
            `地下带出口 (${b.x},${b.y}) 接入了已禁用输出的端口（实机仅禁出，仍可正常进料）`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
        } else if (elevatorPorts.has(cellKey(b.floor, fx, fy))) {
          exitSinkKind.set(b.id, 'elevator');
          boundaryExits.add(b.id);
        } else if (isDoorwayThresholdCell(doc, b.x, b.y, b.floor) && isBoundaryFloorMissing(doc, fx, fy, b.floor)) {
          exitSinkKind.set(b.id, 'doorway');
          boundaryExits.add(b.id);
        } else {
          const nb = cellMap.get(cellKey(b.floor, fx, fy));
          if (!nb) {
            if (isBoundaryFloorMissing(doc, fx, fy, b.floor)) {
              pushIssue('error', 'dead-end-belt', `地下带出口 (${b.x},${b.y}) 直撞实心舱壁`, b.floor, b.x, b.y, b.id);
            } else if (ugPairedIds.has(b.id)) {
              exitSinkKind.set(b.id, 'open-belt');
              boundaryExits.add(b.id);
            }
          } else {
            const nbDef = defById.get(nb.id)!;
            const acc = canLogisticsAcceptFrom(nb, nbDef, b.rotation, fx, fy);
            if (acc.ok) addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), undefined, acc.inPortIndex);
            else pushIssue('error', 'port-mismatch', `地下带出口 (${b.x},${b.y}) 与下游方向冲突`, b.floor, b.x, b.y, b.id);
          }
        }
      }
    } else if (def.kind === 'splitter') {
      const dis = new Set(b.disabledPorts ?? []);
      const outPortDirs: Array<[number, Rotation]> = [
        [1, ((b.rotation + 1) % 4) as Rotation],
        [2, b.rotation],
        [3, ((b.rotation + 3) % 4) as Rotation],
      ];
      for (const [pIdx, pDir] of outPortDirs) {
        if (dis.has(pIdx)) continue;
        const [pdx, pdy] = rotationToDelta(pDir);
        const tx = b.x + pdx;
        const ty = b.y + pdy;
        const filterItem = b.portFilters?.[pIdx];
        const { target: machHit, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, pDir);
        if (machHit) {
          addEdge(b.id, machHit.building.id, speed, pIdx, machHit.portIndex, filterItem);
          continue;
        }
        if (disabledHit) {
          addEdge(b.id, disabledHit.building.id, speed, pIdx, disabledHit.portIndex, filterItem);
          pushIssue(
            'warn',
            'disabled-port-input',
            `分流器 (${b.x},${b.y}) 出口 #${pIdx} 接入了已禁用输出的端口（实机仅禁出，仍可正常进料）`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
          continue;
        }
        if (isBoundaryFloorMissing(doc, tx, ty, b.floor) || elevatorPorts.has(cellKey(b.floor, tx, ty))) {
          boundaryExits.add(b.id);
          continue;
        }
        const nb = cellMap.get(cellKey(b.floor, tx, ty));
        if (!nb) continue; // Real game rule: open splitter port facing empty space does not spill/error
        const nbDef = defById.get(nb.id)!;
        const acc = canLogisticsAcceptFrom(nb, nbDef, pDir, tx, ty);
        if (acc.ok) {
          // Connects cleanly; if it side-loads a different item onto a belt, mixed-item-belt flags the merge spot yellow!
          addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), pIdx, acc.inPortIndex, filterItem);
        }
        // Other non-accepting collisions on a splitter port simply do not output (no red error)
      }
    } else if (def.kind === 'balancer') {
      const worldPorts = getBuildingWorldPorts(b, def);
      const [dx, dy] = rotationToDelta(b.rotation);
      for (const wp of worldPorts) {
        if (wp.port.role !== 'out') continue;
        const ownX = Math.floor(wp.worldX - dx * 0.5);
        const ownY = Math.floor(wp.worldY - dy * 0.5);
        const tx = wp.outsideCellX;
        const ty = wp.outsideCellY;
        const filterItem = b.portFilters?.[wp.port.index];
        const { target: machHit, disabledHit } = findEnabledMachinePortAccepting(b.floor, ownX, ownY, b.rotation);
        if (machHit) {
          addEdge(b.id, machHit.building.id, speed, wp.port.index, machHit.portIndex, filterItem);
          continue;
        }
        if (disabledHit) {
          addEdge(b.id, disabledHit.building.id, speed, wp.port.index, disabledHit.portIndex, filterItem);
          pushIssue(
            'warn',
            'disabled-port-input',
            `平衡器 (${b.x},${b.y}) 出口 #${wp.port.index} 接入了已禁用输出的端口（实机仅禁出，仍可正常进料）`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
          continue;
        }
        if (isBoundaryFloorMissing(doc, tx, ty, b.floor) || elevatorPorts.has(cellKey(b.floor, tx, ty))) {
          boundaryExits.add(b.id);
          continue;
        }
        const nb = cellMap.get(cellKey(b.floor, tx, ty));
        if (!nb) continue; // Unused second lane on a 2-in-1-out priority balancer is valid
        const nbDef = defById.get(nb.id)!;
        const acc = canLogisticsAcceptFrom(nb, nbDef, b.rotation, tx, ty);
        if (acc.ok) {
          addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), wp.port.index, acc.inPortIndex, filterItem);
        } else {
          pushIssue('error', 'port-mismatch', `平衡器 (${b.x},${b.y}) 出口 #${wp.port.index} 与 (${tx},${ty}) 方向冲突`, b.floor, b.x, b.y, b.id);
        }
      }
    } else if (def.kind === 'crafter' || def.kind === 'research' || def.kind === 'container') {
      const worldPorts = getBuildingWorldPorts(b, def);
      for (const wp of worldPorts) {
        if (!wp.enabled) continue;
        const sideDir = SIDE_TO_ROT[wp.side];
        const ax = wp.outsideCellX;
        const ay = wp.outsideCellY;
        const nb = cellMap.get(cellKey(b.floor, ax, ay));
        if (!nb) continue;
        const nbDef = defById.get(nb.id)!;
        if (nbDef.kind === 'belt') {
          if (nb.rotation !== oppositeRot(sideDir)) {
            addEdge(b.id, nb.id, getTierSpeed(nbDef.tier), wp.port.index);
          }
        } else if (nbDef.kind === 'underground' && nb.undergroundMode === 'in' && nb.rotation === sideDir) {
          addEdge(b.id, nb.id, getTierSpeed(nbDef.tier), wp.port.index);
        } else if (nbDef.kind === 'splitter' && nb.rotation === sideDir) {
          addEdge(b.id, nb.id, getTierSpeed(nbDef.tier), wp.port.index, 0);
        } else if (nbDef.kind === 'balancer' && nb.rotation === sideDir) {
          const acc = canLogisticsAcceptFrom(nb, nbDef, sideDir, ax, ay);
          if (acc.ok) addEdge(b.id, nb.id, getTierSpeed(nbDef.tier), wp.port.index, acc.inPortIndex);
        }
      }
    }
  }

  const isLogistics = (id: string) => {
    const k = defById.get(id)?.kind;
    return k === 'belt' || k === 'underground' || k === 'splitter' || k === 'balancer';
  };

  // Helper: trace forward from a node through logistics (and optional buffer containers) to find downstream crafters
  const traceToCrafters = (
    startId: string,
    traverseContainers = false
  ): Array<{ crafterId: string; portIndex: number; filterHint?: string }> => {
    const visited = new Set<string>([startId]);
    const queue: Array<{ id: string; filterHint?: string }> = [{ id: startId }];
    const hits: Array<{ crafterId: string; portIndex: number; filterHint?: string }> = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of outEdges.get(cur.id) ?? []) {
        const nextDef = defById.get(e.toId);
        if (!nextDef) continue;
        const nextB = buildingById.get(e.toId);
        const containerHint =
          nextDef.kind === 'container' && nextB?.filterItems && nextB.filterItems.length === 1
            ? nextB.filterItems[0]
            : undefined;
        const hint = e.filterItem ?? containerHint ?? cur.filterHint;
        if (nextDef.kind === 'crafter' || nextDef.kind === 'research') {
          const inE = (inEdges.get(e.toId) ?? []).find((x) => x.fromId === cur.id);
          hits.push({ crafterId: e.toId, portIndex: inE?.portIndex ?? -1, filterHint: hint });
        } else if ((isLogistics(e.toId) || (traverseContainers && nextDef.kind === 'container')) && !visited.has(e.toId)) {
          visited.add(e.toId);
          queue.push({ id: e.toId, filterHint: hint });
        }
      }
    }
    return hits;
  };

  // 3. Unified Blueprint Workbench Endpoint & Scrap Classification ("首尾标黄，中段故障标红"):
  //    - Any belt ending on open buildable floor WITH upstream (or at doorway/elevator) -> YELLOW tail ('open-belt' exit)
  //    - Any belt/splitter/balancer/filtered-container WITHOUT upstream that feeds downstream -> YELLOW head (raw-input entry)
  //    - Completely isolated 1-tile belt with NEITHER upstream NOR downstream (and no doorway/front collision) -> RED 'orphan-belt'
  for (const bid of openTailCandidates) {
    const ins = inEdges.get(bid);
    const hasIn = Boolean(ins && ins.length > 0);
    if (hasIn || entrySourceKind.has(bid)) {
      exitSinkKind.set(bid, 'open-belt');
      boundaryExits.add(bid);
    }
  }

  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    const ins = inEdges.get(b.id);
    const hasIn = Boolean(ins && ins.length > 0);
    const outs = outEdges.get(b.id);
    const hasOut = Boolean(outs && outs.length > 0);
    const hasExit = boundaryExits.has(b.id);

    if (def.kind === 'container' && !hasIn && hasOut && b.filterItems && b.filterItems.length > 0) {
      entrySourceKind.set(b.id, 'source-container');
      continue;
    }

    if (def.kind === 'belt' && !hasIn && !entrySourceKind.has(b.id)) {
      if (hasOut || hasExit) {
        entrySourceKind.set(b.id, 'open-belt');
      } else if (!frontFaultIds.has(b.id)) {
        pushIssue('error', 'orphan-belt', `孤立废带 (${b.x},${b.y})：既无上游也无下游连接`, b.floor, b.x, b.y, b.id);
      }
    } else if ((def.kind === 'splitter' || def.kind === 'balancer') && !hasIn && !entrySourceKind.has(b.id)) {
      if (hasOut || hasExit) {
        entrySourceKind.set(b.id, 'open-belt');
      } else if (def.kind === 'balancer') {
        pushIssue('error', 'orphan-belt', `孤立平衡器 (${b.x},${b.y})：既无上游也无下游连接`, b.floor, b.x, b.y, b.id);
      }
    }
  }

  // 4. General-purpose external raw-input item inference (ZERO hardcoded 32x32 magic constants!)
  const entryItem = new Map<string, string>();

  // Identify upstream crafter output items feeding any logistics node directly
  const upstreamProducedByNode = new Map<string, Set<string>>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec || rec.outputs.length === 0) continue;
    const outs = outEdges.get(b.id) ?? [];
    for (let oi = 0; oi < outs.length; oi++) {
      const e = outs[oi];
      const itemId =
        e.filterItem ??
        (rec.outputs.length === 1 ? rec.outputs[0].itemId : rec.outputs[oi % rec.outputs.length].itemId);
      const visited = new Set<string>([e.toId]);
      const q = [e.toId];
      while (q.length > 0) {
        const cur = q.shift()!;
        let set = upstreamProducedByNode.get(cur);
        if (!set) {
          set = new Set();
          upstreamProducedByNode.set(cur, set);
        }
        set.add(itemId);
        if (isLogistics(cur)) {
          for (const ne of outEdges.get(cur) ?? []) {
            if (!visited.has(ne.toId) && isLogistics(ne.toId)) {
              visited.add(ne.toId);
              q.push(ne.toId);
            }
          }
        }
      }
    }
  }

  // Module-relative symmetric signature so mirrored top/bottom or left/right doorway pairs work on ANY module size & position!
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
        if (ax >= ay) {
          return { sortKey: ay, symKey: `${host.id}:x${Math.round(lx * 2)}:ay${ay}` };
        }
        return { sortKey: ax, symKey: `${host.id}:y${Math.round(ly * 2)}:ax${ax}` };
      }
    }
    return { sortKey: eb.x + eb.y, symKey: `free:${eb.floor}:${eb.x},${eb.y}` };
  };

  const sortedEntries = Array.from(entrySourceKind.keys()).sort((a, bId) => {
    const ba = buildingById.get(a)!;
    const bb = buildingById.get(bId)!;
    const sa = getEntryModuleSymSig(ba).sortKey;
    const sb = getEntryModuleSymSig(bb).sortKey;
    return sa - sb || ba.floor - bb.floor || ba.x - bb.x || ba.y - bb.y;
  });

  const crafterAssignedPorts = new Map<string, Map<number, Set<string>>>();
  const assignCrafterPort = (cid: string, pIdx: number, itemId: string) => {
    let mp = crafterAssignedPorts.get(cid);
    if (!mp) {
      mp = new Map();
      crafterAssignedPorts.set(cid, mp);
    }
    let set = mp.get(pIdx);
    if (!set) {
      set = new Set();
      mp.set(pIdx, set);
    }
    set.add(itemId);
  };

  // Pre-register internally produced items reaching each crafter
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec) continue;
    for (const ie of inEdges.get(b.id) ?? []) {
      const produced = upstreamProducedByNode.get(ie.fromId);
      if (produced) {
        for (const itemId of produced) {
          if (rec.inputs.some((ri) => ri.itemId === itemId)) {
            assignCrafterPort(b.id, ie.portIndex ?? -1, itemId);
          }
        }
      }
    }
  }

  const groupItemBySig = new Map<string, string>();
  const pendingEntries: Array<{
    eid: string;
    eb: PlacedBuilding;
    hits: Array<{ crafterId: string; portIndex: number; filterHint?: string }>;
    candidateItems: string[];
    groupSig: string;
    sortKey: number;
  }> = [];

  // Pass 1: Assign entries with explicit source-container filters or explicit downstream filter hints first
  for (const eid of sortedEntries) {
    const eb = buildingById.get(eid)!;
    const ebDef = defById.get(eid)!;

    if (ebDef.kind === 'container' && eb.filterItems && eb.filterItems.length > 0) {
      entryItem.set(eid, eb.filterItems[0]);
      for (const h of traceToCrafters(eid, true)) assignCrafterPort(h.crafterId, h.portIndex, eb.filterItems[0]);
      continue;
    }

    const hits = traceToCrafters(eid, true);
    if (hits.length === 0) continue;

    const explicitHint = hits.find((h) => h.filterHint)?.filterHint;
    if (explicitHint) {
      entryItem.set(eid, explicitHint);
      for (const h of hits) assignCrafterPort(h.crafterId, h.portIndex, explicitHint);
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
    const groupSig = `${eb.floor}:${symKey}:${targetRecipesSig}`;

    pendingEntries.push({ eid, eb, hits, candidateItems, groupSig, sortKey });
  }

  // Pass 2: MRV (Most Constrained First) — entries with fewer candidate items (e.g. shared across recipes -> len 1)
  // claim their forced item BEFORE unconstrained entries, and multi-candidate entries pick the item needed by the most
  // still-unsatisfied downstream crafters!
  pendingEntries.sort(
    (a, b) =>
      a.candidateItems.length - b.candidateItems.length ||
      a.sortKey - b.sortKey ||
      a.eb.floor - b.eb.floor ||
      a.eb.x - b.eb.x ||
      a.eb.y - b.eb.y
  );

  for (const pe of pendingEntries) {
    let chosen = groupItemBySig.get(pe.groupSig);
    if (!chosen || !pe.candidateItems.includes(chosen)) {
      let bestItem = pe.candidateItems[0];
      let bestUnsatisfied = -1;
      for (const cand of pe.candidateItems) {
        let unsatisfied = 0;
        for (const h of pe.hits) {
          const assigned = crafterAssignedPorts.get(h.crafterId);
          let hasCand = false;
          if (assigned) {
            for (const s of assigned.values()) {
              if (s.has(cand)) {
                hasCand = true;
                break;
              }
            }
          }
          if (!hasCand) unsatisfied += 1;
        }
        if (unsatisfied > bestUnsatisfied) {
          bestUnsatisfied = unsatisfied;
          bestItem = cand;
        }
      }
      chosen = bestItem;
      groupItemBySig.set(pe.groupSig, chosen);
    }
    entryItem.set(pe.eid, chosen);
    for (const h of pe.hits) assignCrafterPort(h.crafterId, h.portIndex, chosen);
  }

  // 5. General-purpose multi-output crafter port binding:
  //    (a) Match explicit downstream filters or unique downstream recipe consumers first
  //    (b) Match already-committed downstream collector trunks so mirrored/rotated parallel machines merge cleanly
  //        without ever mixing two outputs (while still catching a single machine wiring both outputs onto one belt!)
  const crafterPortOutputItem = new Map<string, Map<number, string>>();
  const committedTrunkItem = new Map<string, string>();
  const collectDownstreamTrunkNodes = (startId: string): string[] => {
    const visited = new Set<string>();
    const queue = [startId];
    const nodes: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const curDef = defById.get(cur);
      if (!curDef || curDef.kind === 'crafter' || curDef.kind === 'research') continue;
      nodes.push(cur);
      for (const oe of outEdges.get(cur) ?? []) {
        if (!oe.filterItem && !visited.has(oe.toId)) {
          queue.push(oe.toId);
        }
      }
    }
    return nodes;
  };

  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec || rec.outputs.length <= 1) continue;
    const outs = outEdges.get(b.id) ?? [];
    if (outs.length === 0) continue;

    const pMap = new Map<number, string>();
    const assignedOutputItems = new Set<string>();
    const remainingOuts: Array<{ oe: OutEdge; trunkNodes: string[] }> = [];

    const bindPort = (oe: OutEdge, itemId: string, trunkNodes: string[]) => {
      pMap.set(oe.portIndex ?? -1, itemId);
      assignedOutputItems.add(itemId);
      for (const nid of trunkNodes) {
        if (!committedTrunkItem.has(nid)) {
          committedTrunkItem.set(nid, itemId);
        }
      }
    };

    // Pass A: Match each outgoing branch against downstream explicit filter or unique downstream recipe consumer
    for (const oe of outs) {
      const trunkNodes = collectDownstreamTrunkNodes(oe.toId);
      let matchedItem: string | undefined;
      if (oe.filterItem && rec.outputs.some((o) => o.itemId === oe.filterItem)) {
        matchedItem = oe.filterItem;
      } else {
        const downHits = traceToCrafters(oe.toId, true);
        const hintItem = downHits.find((h) => h.filterHint && rec.outputs.some((o) => o.itemId === h.filterHint))?.filterHint;
        if (hintItem) {
          matchedItem = hintItem;
        } else {
          const consumedMatches = rec.outputs.filter((o) =>
            downHits.some((h) => {
              const hr = getRecipeDef(buildingById.get(h.crafterId)?.recipeId ?? '');
              return Boolean(hr?.inputs.some((ri) => ri.itemId === o.itemId));
            })
          );
          if (consumedMatches.length === 1) {
            matchedItem = consumedMatches[0].itemId;
          }
        }
      }
      if (matchedItem && !assignedOutputItems.has(matchedItem)) {
        bindPort(oe, matchedItem, trunkNodes);
      } else {
        remainingOuts.push({ oe, trunkNodes });
      }
    }

    // Pass B: Align remaining ports with any already-committed downstream collector trunk (handles mirrored/rotated rows!)
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
      if (trunkMatch) {
        bindPort(item.oe, trunkMatch, item.trunkNodes);
      } else {
        stillUnassigned.push(item);
      }
    }

    // Pass C: Assign any fresh uncommitted trunks deterministically by port order
    const unassignedOutputs = rec.outputs.filter((o) => !assignedOutputItems.has(o.itemId));
    const fallbackOutputs = unassignedOutputs.length > 0 ? unassignedOutputs : rec.outputs;
    const sortedRem = [...stillUnassigned].sort((a, z) => (a.oe.portIndex ?? 0) - (z.oe.portIndex ?? 0));
    for (let i = 0; i < sortedRem.length; i++) {
      const o = fallbackOutputs[Math.min(i, fallbackOutputs.length - 1)];
      bindPort(sortedRem[i].oe, o.itemId, sortedRem[i].trunkNodes);
    }
    crafterPortOutputItem.set(b.id, pMap);
  }

  // 6. Iterative Steady-State Flow Solver (with true output-bottleneck efficiency & demand-pulled external supply!)
  type FlowMap = Map<string, number>;
  const edgeFlows = new Map<string, FlowMap>();
  const edgeKey = (fromId: string, toId: string, outPort?: number) => `${fromId}->${toId}:${outPort ?? -1}`;

  const addFlow = (m: FlowMap, itemId: string, rate: number) => {
    if (rate <= 1e-9) return;
    m.set(itemId, (m.get(itemId) ?? 0) + rate);
  };
  const sumFlow = (m: FlowMap): number => {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  };

  const crafterEfficiency = new Map<string, number>();
  const crafterDemandByInput = new Map<string, Map<string, number>>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec) continue;
    const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
    const dm = new Map<string, number>();
    for (const inp of rec.inputs) {
      dm.set(inp.itemId, (inp.quantity ?? 1) / dur);
    }
    crafterDemandByInput.set(b.id, dm);
  }

  // True topological order (Kahn's algorithm) so forward/backward sweeps traverse arbitrary-length belts in 1 pass!
  // Any remaining nodes belonging to feedback cycles (e.g. Ore Enricher / Xenobacteria loops) are appended deterministically.
  const inDeg = new Map<string, number>();
  for (const b of doc.buildings) inDeg.set(b.id, 0);
  for (const b of doc.buildings) {
    for (const oe of outEdges.get(b.id) ?? []) {
      inDeg.set(oe.toId, (inDeg.get(oe.toId) ?? 0) + 1);
    }
  }
  const topoOrder: PlacedBuilding[] = [];
  const topoSeen = new Set<string>();
  const kahnQueue: string[] = [];
  for (const b of doc.buildings) {
    if ((inDeg.get(b.id) ?? 0) === 0) kahnQueue.push(b.id);
  }
  while (kahnQueue.length > 0) {
    const cur = kahnQueue.shift()!;
    if (topoSeen.has(cur)) continue;
    topoSeen.add(cur);
    const cb = buildingById.get(cur);
    if (cb) topoOrder.push(cb);
    for (const oe of outEdges.get(cur) ?? []) {
      const nd = (inDeg.get(oe.toId) ?? 1) - 1;
      inDeg.set(oe.toId, nd);
      if (nd <= 0 && !topoSeen.has(oe.toId)) {
        kahnQueue.push(oe.toId);
      }
    }
  }
  // Append cyclic components in BFS order starting from entries/crafters
  for (const b of doc.buildings) {
    if (!topoSeen.has(b.id)) {
      topoSeen.add(b.id);
      topoOrder.push(b);
    }
  }
  const bfsOrder = topoOrder;

  // Backward DP (reverse BFS) to compute exact steady-state downstream demand per node & itemId
  const nodeDemand = new Map<string, Map<string, number>>();
  const revOrder = [...bfsOrder].reverse();
  for (let pass = 0; pass < 5; pass++) {
    for (const b of revOrder) {
      const def = defById.get(b.id);
      if (!def) continue;
      const dm = new Map<string, number>();
      if (def.kind === 'crafter') {
        const req = crafterDemandByInput.get(b.id);
        if (req) {
          for (const [it, r] of req.entries()) dm.set(it, r);
        }
      } else if (def.kind === 'research') {
        const inCap = (inEdges.get(b.id) ?? []).reduce((s, e) => s + e.capacity, 0);
        if (inCap > 1e-9) dm.set('*', inCap);
      } else if (def.kind === 'container' && (outEdges.get(b.id) ?? []).length === 0) {
        const inCap = (inEdges.get(b.id) ?? []).reduce((s, e) => s + e.capacity, 0);
        if (inCap > 1e-9) {
          if (b.filterItems && b.filterItems.length > 0) {
            for (const it of b.filterItems) dm.set(it, inCap);
          } else {
            dm.set('*', inCap);
          }
        }
      } else {
        const outs = outEdges.get(b.id) ?? [];
        if (boundaryExits.has(b.id)) {
          dm.set('*', getTierSpeed(def.tier));
        }
        for (const oe of outs) {
          const childDm = nodeDemand.get(oe.toId);
          if (!childDm) continue;
          const childDef = defById.get(oe.toId);
          const portAllowed =
            childDef && (childDef.kind === 'crafter' || childDef.kind === 'research')
              ? crafterAssignedPorts.get(oe.toId)?.get(oe.toPortIndex ?? -1)
              : undefined;
          let childSum = 0;
          for (const [it, r] of childDm.entries()) {
            if (oe.filterItem && it !== '*' && it !== oe.filterItem) continue;
            if (portAllowed && portAllowed.size > 0 && it !== '*' && !portAllowed.has(it)) continue;
            childSum += r;
          }
          const scale = childSum > oe.capacity ? oe.capacity / childSum : 1;
          for (const [it, r] of childDm.entries()) {
            if (oe.filterItem && it !== '*' && it !== oe.filterItem) continue;
            if (portAllowed && portAllowed.size > 0 && it !== '*' && !portAllowed.has(it)) continue;
            dm.set(it, (dm.get(it) ?? 0) + r * scale);
          }
        }
      }
      nodeDemand.set(b.id, dm);
    }
  }

  const getEdgeEffectiveCap = (oe: OutEdge, itemId: string): number => {
    const childDm = nodeDemand.get(oe.toId);
    if (!childDm) return oe.capacity;
    if (childDm.has('*')) return oe.capacity;
    const specific = childDm.get(itemId) ?? 0;
    return specific > 1e-9 ? Math.min(oe.capacity, specific) : 0;
  };

  // Determine external entry capacity & demand-pulled supply rate (eliminates false overload on lightly-loaded merges!)
  const getEntryCapacity = (id: string): number => {
    const def = defById.get(id)!;
    if (def.kind === 'container') {
      return (outEdges.get(id) ?? []).reduce((sum, e) => sum + e.capacity, 0);
    }
    return getTierSpeed(def.tier);
  };

  const getEntryDemandRate = (id: string, itemId: string): number => {
    const dm = nodeDemand.get(id);
    if (!dm) return getEntryCapacity(id);
    const specific = dm.get(itemId) ?? 0;
    if (specific > 1e-9) return specific;
    return dm.has('*') ? getEntryCapacity(id) : 0;
  };

  const getNodeInFlow = (id: string): FlowMap => {
    const m: FlowMap = new Map();
    if (entrySourceKind.has(id)) {
      const itemId = entryItem.get(id);
      if (itemId) {
        const cap = getEntryCapacity(id);
        const demand = getEntryDemandRate(id, itemId);
        // Demand-pulled supply clamped by entry belt capacity (never pushes phantom excess!)
        addFlow(m, itemId, Math.min(cap, demand));
      }
    }
    for (const ie of inEdges.get(id) ?? []) {
      for (const oe of outEdges.get(ie.fromId) ?? []) {
        if (oe.toId !== id) continue;
        const fm = edgeFlows.get(edgeKey(ie.fromId, id, oe.portIndex));
        if (!fm) continue;
        for (const [it, r] of fm.entries()) addFlow(m, it, r);
      }
    }
    return m;
  };

  // Pre-identify open raw-input heads directly on configured machines (e.g. unfed sub-line templates!)
  // If a machine has NO incoming belt delivering `inp.itemId` AND has NO wrong-item producer wired into it,
  // treat that missing input as a YELLOW open head ('machine-head') and virtually supply `need` so downstream
  // machines in an unfed multi-stage template trace cleanly without cascading false red errors!
  const machineHeadInputs = new Map<string, Set<string>>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || def.kind !== 'crafter' || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec || rec.inputs.length === 0) continue;
    const reqSet = new Set(rec.inputs.map((ri) => ri.itemId));

    // Check whether any incoming edge delivers a wrong item produced upstream
    let hasWrongUpstream = false;
    for (const ie of inEdges.get(b.id) ?? []) {
      const upProd = upstreamProducedByNode.get(ie.fromId);
      if (upProd) {
        for (const it of upProd) {
          if (!reqSet.has(it)) {
            hasWrongUpstream = true;
            break;
          }
        }
      }
      if (hasWrongUpstream) break;
    }
    if (hasWrongUpstream) continue;

    const assignedItems = new Set<string>();
    const pMap = crafterAssignedPorts.get(b.id);
    if (pMap) {
      for (const s of pMap.values()) {
        for (const it of s) assignedItems.add(it);
      }
    }
    for (const inp of rec.inputs) {
      if (!assignedItems.has(inp.itemId)) {
        let s = machineHeadInputs.get(b.id);
        if (!s) {
          s = new Set();
          machineHeadInputs.set(b.id, s);
        }
        s.add(inp.itemId);
      }
    }
  }

  const ITERS = 20;
  for (let iter = 0; iter < ITERS; iter++) {
    let maxDelta = 0;
    const setEdgeFlow = (key: string, fm: FlowMap) => {
      const prev = edgeFlows.get(key);
      if (prev) {
        for (const [it, r] of fm.entries()) {
          const d = Math.abs(r - (prev.get(it) ?? 0));
          if (d > maxDelta) maxDelta = d;
        }
        for (const [it, r] of prev.entries()) {
          if (!fm.has(it) && r > maxDelta) maxDelta = r;
        }
      } else {
        for (const r of fm.values()) if (r > maxDelta) maxDelta = r;
      }
      edgeFlows.set(key, fm);
    };

    for (const b of bfsOrder) {
      const def = defById.get(b.id);
      if (!def) continue;
      const outs = outEdges.get(b.id) ?? [];

      if (def.kind === 'crafter' || def.kind === 'research') {
        if (!b.recipeId) continue;
        const rec = getRecipeDef(b.recipeId);
        if (!rec) continue;
        const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
        const inFlow = getNodeInFlow(b.id);
        const headSet = machineHeadInputs.get(b.id);

        // 1) Input-limited efficiency (unfed machine-head inputs are virtually supplied so downstream traces cleanly!)
        let inputEff = 1.0;
        if (rec.inputs.length > 0) {
          for (const inp of rec.inputs) {
            const need = (inp.quantity ?? 1) / dur;
            let got = inFlow.get(inp.itemId) ?? 0;
            if (got <= 1e-4 && headSet?.has(inp.itemId)) {
              got = need;
            }
            // Ignite closed self-recycling loops (e.g. XenobacteriaRecycling) on iter 0
            if (iter === 0 && got < need && rec.outputs.some((o) => o.itemId === inp.itemId)) {
              got = need;
            }
            inputEff = Math.min(inputEff, need > 0 ? got / need : 1);
          }
        }

        // 2) Scientific output-evacuation efficiency (disconnected or undersized output belt throttles steady-state eff!)
        let outputEff = 1.0;
        const portMap = crafterPortOutputItem.get(b.id);
        if (rec.outputs.length > 0) {
          if (outs.length === 0) {
            outputEff = 0.0;
          } else if (rec.outputs.length === 1) {
            const maxOut = (rec.outputs[0].quantity ?? 1) / dur;
            const totalOutCap = outs.reduce((s, e) => s + e.capacity, 0);
            outputEff = maxOut > 1e-9 ? Math.min(1, totalOutCap / maxOut) : 1;
          } else if (portMap) {
            const capByItem = new Map<string, number>();
            let totalOutCap = 0;
            for (const oe of outs) {
              totalOutCap += oe.capacity;
              const assignedItem = portMap.get(oe.portIndex ?? -1) ?? rec.outputs[0].itemId;
              capByItem.set(assignedItem, (capByItem.get(assignedItem) ?? 0) + oe.capacity);
            }
            let sumMaxOut = 0;
            for (const o of rec.outputs) {
              const maxO = (o.quantity ?? 1) / dur;
              sumMaxOut += maxO;
              const capO = capByItem.get(o.itemId) ?? 0;
              if (maxO > 1e-9) outputEff = Math.min(outputEff, capO / maxO);
            }
            if (sumMaxOut > 1e-9) outputEff = Math.min(outputEff, totalOutCap / sumMaxOut);
          }
        }

        const eff = Math.max(0, Math.min(1, Math.min(inputEff, outputEff)));
        crafterEfficiency.set(b.id, eff);

        if (outs.length === 0) continue;
        if (rec.outputs.length === 1) {
          const o = rec.outputs[0];
          const totalOut = eff * ((o.quantity ?? 1) / dur);
          const totalOutCap = outs.reduce((s, e) => s + e.capacity, 0);
          for (const oe of outs) {
            const fm: FlowMap = new Map();
            const share = totalOutCap > 1e-9 ? totalOut * (oe.capacity / totalOutCap) : totalOut / outs.length;
            addFlow(fm, o.itemId, Math.min(oe.capacity, share));
            setEdgeFlow(edgeKey(b.id, oe.toId, oe.portIndex), fm);
          }
        } else if (portMap) {
          const outsByItem = new Map<string, OutEdge[]>();
          for (const oe of outs) {
            const assignedItem = portMap.get(oe.portIndex ?? -1) ?? rec.outputs[0].itemId;
            const list = outsByItem.get(assignedItem);
            if (list) list.push(oe);
            else outsByItem.set(assignedItem, [oe]);
          }
          for (const [itemId, itemOuts] of outsByItem.entries()) {
            const o = rec.outputs.find((x) => x.itemId === itemId) ?? rec.outputs[0];
            const totalOut = eff * ((o.quantity ?? 1) / dur);
            const sumCap = itemOuts.reduce((s, e) => s + e.capacity, 0);
            for (const oe of itemOuts) {
              const fm: FlowMap = new Map();
              const share = sumCap > 1e-9 ? totalOut * (oe.capacity / sumCap) : totalOut / itemOuts.length;
              addFlow(fm, o.itemId, Math.min(oe.capacity, share));
              setEdgeFlow(edgeKey(b.id, oe.toId, oe.portIndex), fm);
            }
          }
        }
        continue;
      }

      if (outs.length === 0) continue;

      if (def.kind === 'belt' || def.kind === 'underground') {
        const inFlow = getNodeInFlow(b.id);
        const oe = outs[0];
        const total = sumFlow(inFlow);
        const scale = total > oe.capacity ? oe.capacity / total : 1;
        const fm: FlowMap = new Map();
        for (const [it, r] of inFlow.entries()) addFlow(fm, it, r * scale);
        setEdgeFlow(edgeKey(b.id, oe.toId, oe.portIndex), fm);
        continue;
      }

      if (def.kind === 'container') {
        const inFlow = getNodeInFlow(b.id);
        const filterSet = b.filterItems && b.filterItems.length > 0 ? new Set(b.filterItems) : null;
        const allowed: FlowMap = new Map();
        for (const [it, r] of inFlow.entries()) {
          if (!filterSet || filterSet.has(it)) addFlow(allowed, it, r);
        }
        for (const oe of outs) {
          const fm: FlowMap = new Map();
          const shareScale = 1 / outs.length;
          let sum = 0;
          for (const [it, r] of allowed.entries()) {
            const q = r * shareScale;
            addFlow(fm, it, q);
            sum += q;
          }
          if (sum > oe.capacity) {
            const s = oe.capacity / sum;
            for (const [it, r] of fm.entries()) fm.set(it, r * s);
          }
          setEdgeFlow(edgeKey(b.id, oe.toId, oe.portIndex), fm);
        }
        continue;
      }

      if (def.kind === 'splitter' || def.kind === 'balancer') {
        let combinedIn: FlowMap = new Map();
        if (def.kind === 'balancer' && b.priorityIn !== undefined) {
          const ownDm = nodeDemand.get(b.id);
          const maxOutCap = outs.reduce((acc, e) => acc + e.capacity, 0);
          const prioFlow: FlowMap = new Map();
          const secFlow: FlowMap = new Map();
          for (const ie of inEdges.get(b.id) ?? []) {
            for (const oe of outEdges.get(ie.fromId) ?? []) {
              if (oe.toId !== b.id) continue;
              const fm = edgeFlows.get(edgeKey(ie.fromId, b.id, oe.portIndex));
              if (!fm) continue;
              const dest = ie.portIndex === b.priorityIn ? prioFlow : secFlow;
              for (const [it, r] of fm.entries()) addFlow(dest, it, r);
            }
          }
          let demandCap = maxOutCap;
          if (ownDm && !ownDm.has('*')) {
            let dmSum = 0;
            for (const r of ownDm.values()) dmSum += r;
            if (dmSum > 1e-9) demandCap = Math.min(maxOutCap, dmSum);
          }
          const prioSum = sumFlow(prioFlow);
          const takePrio = Math.min(prioSum, demandCap);
          const prioScale = prioSum > 1e-9 ? takePrio / prioSum : 0;
          for (const [it, r] of prioFlow.entries()) addFlow(combinedIn, it, r * prioScale);
          const remCap = Math.max(0, demandCap - takePrio);
          const secSum = sumFlow(secFlow);
          const secScale = secSum > 1e-9 ? Math.min(1, remCap / secSum) : 0;
          for (const [it, r] of secFlow.entries()) addFlow(combinedIn, it, r * secScale);
        } else {
          combinedIn = getNodeInFlow(b.id);
        }

        const outMaps = new Map<OutEdge, FlowMap>();
        for (const oe of outs) outMaps.set(oe, new Map());

        for (const [itemId, rate] of combinedIn.entries()) {
          if (rate <= 1e-9) continue;
          const filteredTargets = outs.filter((e) => e.filterItem === itemId);
          const unfilteredTargets = outs.filter((e) => !e.filterItem);
          const eligible = filteredTargets.length > 0 ? filteredTargets : unfilteredTargets;
          if (eligible.length === 0) continue;

          let remaining = rate;
          if (b.priorityOut !== undefined) {
            const prioEdge = eligible.find((e) => e.portIndex === b.priorityOut);
            if (prioEdge) {
              const om = outMaps.get(prioEdge)!;
              const effCap = getEdgeEffectiveCap(prioEdge, itemId);
              const free = Math.max(0, Math.min(prioEdge.capacity - sumFlow(om), effCap - (om.get(itemId) ?? 0)));
              const send = Math.min(remaining, free);
              addFlow(om, itemId, send);
              remaining -= send;
            }
          }
          let active = eligible.filter((e) => e.portIndex !== b.priorityOut);
          for (let wf = 0; wf < 4 && remaining > 1e-9 && active.length > 0; wf++) {
            const share = remaining / active.length;
            const nextActive: OutEdge[] = [];
            let progressed = false;
            for (const oe of active) {
              const om = outMaps.get(oe)!;
              const effCap = getEdgeEffectiveCap(oe, itemId);
              const free = Math.max(0, Math.min(oe.capacity - sumFlow(om), effCap - (om.get(itemId) ?? 0)));
              if (free <= share + 1e-9) {
                addFlow(om, itemId, free);
                remaining -= free;
                if (free > 1e-9) progressed = true;
              } else {
                nextActive.push(oe);
              }
            }
            if (nextActive.length === active.length) {
              for (const oe of nextActive) {
                addFlow(outMaps.get(oe)!, itemId, share);
                remaining -= share;
              }
              break;
            }
            active = nextActive;
            if (!progressed && active.length === 0) break;
          }
        }

        for (const [oe, fm] of outMaps.entries()) {
          setEdgeFlow(edgeKey(b.id, oe.toId, oe.portIndex), fm);
        }
      }
    }

    if (iter > 1 && maxDelta < 1e-5) break;
  }

  // 7. Emit yellow 'external-input-needed' warnings at EVERY external raw-material entry spot
  //    AND accumulate TRUE topological netInputs strictly from external source inflows (never global subtraction!)
  const externalInputs: ExternalInputSpot[] = [];
  const netInputTotals = new Map<string, number>();
  const SOURCE_KIND_ZH: Record<ExternalInputSpot['sourceKind'], string> = {
    doorway: '舱门入口',
    elevator: '电梯接口',
    'wall-stub': '穿墙地下口',
    'open-belt': '待接原料端',
    'source-container': '原料箱源',
    'machine-head': '机器首端',
  };

  // Identify backup/seed external entries that feed ONLY into the secondary (0%-drawn) input of a priorityIn balancer
  // (e.g. Ore Enricher starter seed line once the closed priority recycle loop supplies 100% of demand!)
  const prioSecondaryZeroSources = new Set<string>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || def.kind !== 'balancer' || b.priorityIn === undefined) continue;
    const ownDm = nodeDemand.get(b.id);
    const outs = outEdges.get(b.id) ?? [];
    const maxOutCap = outs.reduce((acc, e) => acc + e.capacity, 0);
    let demandCap = maxOutCap;
    if (ownDm && !ownDm.has('*')) {
      let dmSum = 0;
      for (const r of ownDm.values()) dmSum += r;
      if (dmSum > 1e-9) demandCap = Math.min(maxOutCap, dmSum);
    }
    let prioSum = 0;
    const secFromIds: string[] = [];
    for (const ie of inEdges.get(b.id) ?? []) {
      for (const oe of outEdges.get(ie.fromId) ?? []) {
        if (oe.toId !== b.id) continue;
        const fm = edgeFlows.get(edgeKey(ie.fromId, b.id, oe.portIndex));
        if (!fm) continue;
        if (ie.portIndex === b.priorityIn) prioSum += sumFlow(fm);
        else secFromIds.push(ie.fromId);
      }
    }
    if (prioSum >= demandCap - 1e-3 && secFromIds.length > 0) {
      // Trace upstream along single-out belts from unused secondary input to mark seed entry as 0-steady-draw
      const q = [...secFromIds];
      const seen = new Set<string>(q);
      while (q.length > 0) {
        const cur = q.shift()!;
        const cOuts = outEdges.get(cur) ?? [];
        if (cOuts.length > 1) continue;
        if (entrySourceKind.has(cur)) prioSecondaryZeroSources.add(cur);
        for (const ie of inEdges.get(cur) ?? []) {
          if (!seen.has(ie.fromId) && isLogistics(ie.fromId)) {
            seen.add(ie.fromId);
            q.push(ie.fromId);
          }
        }
      }
    }
  }

  for (const eid of sortedEntries) {
    const eb = buildingById.get(eid)!;
    const sourceKind = entrySourceKind.get(eid)!;
    const itemId = entryItem.get(eid) ?? null;
    const cap = getEntryCapacity(eid);
    const isSeedBackup = prioSecondaryZeroSources.has(eid);
    const reqRate = itemId && !isSeedBackup ? getEntryDemandRate(eid, itemId) : 0;
    const supRate = itemId ? Math.min(cap, reqRate) : 0;
    const bottlenecked = itemId !== null && reqRate > cap + 1e-3;
    const nameZh = itemId ? getItemNameZh(itemId) : '未指定原料';

    if (itemId && supRate > 1e-4) {
      netInputTotals.set(itemId, (netInputTotals.get(itemId) ?? 0) + supRate);
    }

    const spotId = `ext_${eb.floor}_${eb.x}_${eb.y}`;
    externalInputs.push({
      id: spotId,
      floor: eb.floor,
      x: eb.x,
      y: eb.y,
      buildingId: eb.id,
      sourceKind,
      itemId,
      nameZh,
      requiredRatePerSec: Math.round(reqRate * 1000) / 1000,
      suppliedRatePerSec: Math.round(supRate * 1000) / 1000,
      capacityPerSec: Math.round(cap * 1000) / 1000,
      bottlenecked,
    });

    if (itemId) {
      const beltsText = `${(reqRate / 3.0).toFixed(2)} 满带`;
      const capWarn = bottlenecked ? `（超单带上限 ${cap.toFixed(1)}/s！）` : '';
      pushIssue(
        'warn',
        'external-input-needed',
        `${SOURCE_KIND_ZH[sourceKind]} (${eb.x},${eb.y}) 需入「${nameZh}」· ${reqRate.toFixed(2)}/s（${beltsText}）${capWarn}`,
        eb.floor,
        eb.x,
        eb.y,
        eb.id
      );
      if (bottlenecked) {
        pushIssue(
          'error',
          'belt-overload',
          `入口带宽超载 (${eb.x},${eb.y})：下游需「${nameZh}」${reqRate.toFixed(2)}/s > 上限 ${cap.toFixed(1)}/s`,
          eb.floor,
          eb.x,
          eb.y,
          eb.id
        );
      }
    } else {
      pushIssue(
        'warn',
        'external-input-needed',
        `${SOURCE_KIND_ZH[sourceKind]} (${eb.x},${eb.y}) 待接入原料（下游未指定配方）`,
        eb.floor,
        eb.x,
        eb.y,
        eb.id
      );
    }
  }

  // 8. Inspect deterministic forward flow for faults (mixed-item, overload, container filter conflict)
  //    AND exact yellow output tails (尾) + terminal storage container outputs!
  const SINK_KIND_ZH: Record<ExternalOutputSpot['sinkKind'], string> = {
    doorway: '舱门尾端',
    elevator: '电梯尾端',
    'wall-stub': '穿墙尾端',
    'open-belt': '敞口尾端',
  };
  const externalOutputs: ExternalOutputSpot[] = [];
  const cellFlows: Record<string, CellFlowInfo> = {};
  const netOutputTotals = new Map<string, number>();

  // Detect downgrade bottlenecks where a high-tier belt/underground feeds > downstream tier capacity
  const chokedArrivalByNode = new Map<string, number>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'belt' && def.kind !== 'underground')) continue;
    const outs = outEdges.get(b.id) ?? [];
    if (outs.length !== 1) continue;
    const oe = outs[0];
    const arrival = sumFlow(getNodeInFlow(b.id));
    if (arrival > oe.capacity + 1e-3) {
      chokedArrivalByNode.set(oe.toId, Math.max(chokedArrivalByNode.get(oe.toId) ?? 0, arrival));
    }
  }

  // Precompute mixed logistics nodes so mixed-item-belt ONLY flags the exact merge origin (混合位), not every downstream tile!
  const mixedLogisticsIds = new Set<string>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    if (def.kind === 'belt' || def.kind === 'underground' || def.kind === 'splitter' || def.kind === 'balancer') {
      const flow = getNodeInFlow(b.id);
      let count = 0;
      for (const r of flow.values()) {
        if (r > 1e-4) count++;
      }
      if (count > 1) mixedLogisticsIds.add(b.id);
    }
  }

  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;

    if (def.kind === 'container') {
      const inFlow = getNodeInFlow(b.id);
      if (b.filterItems && b.filterItems.length > 0) {
        const allowed = new Set(b.filterItems);
        for (const [it, r] of inFlow.entries()) {
          if (r > 1e-4 && !allowed.has(it)) {
            pushIssue(
              'error',
              'port-mismatch',
              `储物箱 (${b.x},${b.y}) 过滤冲突：输入了非白名单物品「${getItemNameZh(it)}」`,
              b.floor,
              b.x,
              b.y,
              b.id
            );
          }
        }
      }
      // Terminal storage container counts cleanly as a blueprint output sink
      if ((outEdges.get(b.id) ?? []).length === 0) {
        for (const [it, r] of inFlow.entries()) {
          if (r > 1e-4) {
            if (!b.filterItems || b.filterItems.length === 0 || b.filterItems.includes(it)) {
              netOutputTotals.set(it, (netOutputTotals.get(it) ?? 0) + r);
            }
          }
        }
      }
      continue;
    }

    if (def.kind === 'belt' || def.kind === 'underground' || def.kind === 'splitter' || def.kind === 'balancer') {
      const laneSpeed = getTierSpeed(def.tier);
      // Belt Balancer has 2 full-speed parallel lanes (2 * tierSpeed total throughput!)
      const cap = def.kind === 'balancer' ? laneSpeed * 2 : laneSpeed;
      const flow = getNodeInFlow(b.id);

      const itemsObj: Record<string, number> = {};
      let total = 0;
      const nonZeroItems: string[] = [];
      for (const [it, r] of flow.entries()) {
        if (r > 1e-4) {
          itemsObj[it] = Math.round(r * 1000) / 1000;
          total += r;
          nonZeroItems.push(it);
        }
      }

      const effectiveArrival = Math.max(total, chokedArrivalByNode.get(b.id) ?? 0);
      const overloaded = effectiveArrival > cap + 1e-3;
      const [w, d] = getBuildingSizeCells(def, b.rotation);
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < d; dy++) {
          cellFlows[cellKey(b.floor, b.x + dx, b.y + dy)] = {
            items: itemsObj,
            totalRate: Math.round(total * 1000) / 1000,
            capacity: cap,
            overloaded,
          };
        }
      }

      const hasPortFilter = b.portFilters && Object.keys(b.portFilters).length > 0;
      const upstreamAlreadyMixed = (inEdges.get(b.id) ?? []).some((ie) => mixedLogisticsIds.has(ie.fromId));
      if (nonZeroItems.length > 1 && !upstreamAlreadyMixed && def.kind === 'belt') {
        pushIssue(
          'warn',
          'mixed-item-belt',
          `混料位 (${b.x},${b.y}) 发生混料：${nonZeroItems.map(getItemNameZh).join(' + ')}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      } else if (nonZeroItems.length > 1 && !upstreamAlreadyMixed && def.kind === 'splitter' && !hasPortFilter) {
        pushIssue(
          'warn',
          'mixed-item-belt',
          `分流器混料位 (${b.x},${b.y}) 未配置过滤：${nonZeroItems.map(getItemNameZh).join(' + ')}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }

      if (overloaded && (def.kind === 'belt' || def.kind === 'underground')) {
        pushIssue(
          'error',
          'belt-overload',
          `${def.nameZh} (${b.x},${b.y}) 超载：来料 ${effectiveArrival.toFixed(2)}/s > 上限 ${cap.toFixed(1)}/s`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }

      if (boundaryExits.has(b.id)) {
        const outItems: ExternalOutputSpot['items'] = [];
        for (const [it, r] of flow.entries()) {
          if (r > 1e-4) {
            const clamped = Math.min(r, cap);
            netOutputTotals.set(it, (netOutputTotals.get(it) ?? 0) + clamped);
            outItems.push({
              itemId: it,
              nameZh: getItemNameZh(it),
              ratePerSec: Math.round(clamped * 1000) / 1000,
            });
          }
        }
        const sinkKind = exitSinkKind.get(b.id);
        if (sinkKind) {
          const outSum = outItems.reduce((s, x) => s + x.ratePerSec, 0);
          externalOutputs.push({
            id: `out_${b.floor}_${b.x}_${b.y}`,
            floor: b.floor,
            x: b.x,
            y: b.y,
            buildingId: b.id,
            sinkKind,
            items: outItems,
            totalRatePerSec: Math.round(outSum * 1000) / 1000,
            capacityPerSec: cap,
          });
          const msg =
            outItems.length > 0
              ? `${SINK_KIND_ZH[sinkKind]} (${b.x},${b.y}) 输出 ${outItems.map((x) => `「${x.nameZh}」${x.ratePerSec.toFixed(2)}/s`).join(' + ')}`
              : `${SINK_KIND_ZH[sinkKind]} (${b.x},${b.y}) 待接下游（暂无流率）`;
          pushIssue('warn', 'blueprint-output', msg, b.floor, b.x, b.y, b.id);
        }
      }
    }
  }

  // 9. Transparent Binary-Verified Power Budget (Build 26639889) & Upstream-Surplus Balance Hints
  //    - Crafters: 0 W idle, powerKW * eff when running (binary-verified: AssemblerObject has no StandbyPower)
  //    - Turrets: intermittent combat peak (counted in peakDrawMW, 0 MW in peacetime activeDrawMW)
  //    - Solar: MaxEfficiency=1.00 (close orbit), MinEfficiency=0.20 (far orbit)
  //    - Reactor: 48 MW constant when fueled
  let crafterPeakKW = 0;
  let crafterActiveKW = 0;
  let labPeakKW = 0;
  let labActiveKW = 0;
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
  let effSum = 0;
  const balanceHints: BalanceHint[] = [];
  const byRecipeMap = new Map<string, { rec: RecipeDef; count: number; effSum: number }>();

  for (const b of doc.buildings) {
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
      const pKW = def.powerKW ?? 0;
      labPeakKW += pKW;
      const inFlow = getNodeInFlow(b.id);
      if (sumFlow(inFlow) > 1e-4) {
        labActiveKW += pKW;
      }
      continue;
    }

    if (def.kind !== 'crafter') continue;
    machineCount++;
    const pKW = def.powerKW ?? 0;
    crafterPeakKW += pKW;

    if (!b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec) continue;
    configuredMachineCount++;
    const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
    const eff = crafterEfficiency.get(b.id) ?? 0;
    effSum += eff;
    crafterActiveKW += pKW * eff;

    let entry = byRecipeMap.get(rec.id);
    if (!entry) {
      entry = { rec, count: 0, effSum: 0 };
      byRecipeMap.set(rec.id, entry);
    }
    entry.count++;
    entry.effSum += eff;

    const inFlow = getNodeInFlow(b.id);
    const reqSet = new Set(rec.inputs.map((i) => i.itemId));
    for (const [it, r] of inFlow.entries()) {
      if (r > 1e-4 && !reqSet.has(it)) {
        pushIssue(
          'error',
          'machine-wrong-item',
          `${def.nameZh} (${b.x},${b.y}) 混入非配方原料：${getItemNameZh(it)}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }
    }
    const headSet = machineHeadInputs.get(b.id);
    for (const inp of rec.inputs) {
      const need = (inp.quantity ?? 1) / dur;
      const got = inFlow.get(inp.itemId) ?? 0;
      if (got <= 1e-4 && headSet?.has(inp.itemId)) {
        // Unified head logic: unfed machine input is a YELLOW 'external-input-needed' head (not a red mid-line error!)
        netInputTotals.set(inp.itemId, (netInputTotals.get(inp.itemId) ?? 0) + need);
        externalInputs.push({
          id: `ext_m_${b.id}_${inp.itemId}`,
          floor: b.floor,
          x: b.x,
          y: b.y,
          buildingId: b.id,
          sourceKind: 'machine-head',
          itemId: inp.itemId,
          nameZh: inp.nameZh,
          requiredRatePerSec: Math.round(need * 1000) / 1000,
          suppliedRatePerSec: Math.round(need * 1000) / 1000,
          capacityPerSec: 3.0,
          bottlenecked: false,
        });
        pushIssue(
          'warn',
          'external-input-needed',
          `机器首端 ${def.nameZh} (${b.x},${b.y}) 需接入「${inp.nameZh}」· ${need.toFixed(2)}/s（${(need / 3.0).toFixed(2)} 满带）`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      } else if (got <= 1e-4) {
        pushIssue(
          'warn',
          'machine-missing-input',
          `${def.nameZh} (${b.x},${b.y}) 缺少原料：${inp.nameZh}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      } else if (got > need + 0.02) {
        // Transparent deterministic hint: internal upstream supply exceeds this consumer's rated demand
        const ratio = Math.max(0, Math.min(1, need / got));
        balanceHints.push({
          id: `bal_${b.id}_${inp.itemId}`,
          floor: b.floor,
          x: b.x,
          y: b.y,
          itemId: inp.itemId,
          nameZh: inp.nameZh,
          supplyRatePerSec: Math.round(got * 1000) / 1000,
          demandRatePerSec: Math.round(need * 1000) / 1000,
          estDutyRatio: Math.round(ratio * 1000) / 1000,
          message: `「${inp.nameZh}」上游供给 ${got.toFixed(2)}/s > ${def.nameZh} (${b.x},${b.y}) 需求 ${need.toFixed(2)}/s（实机将自动反压至约 ${Math.round(ratio * 100)}%）`,
        });
      }
    }
    const outs = outEdges.get(b.id) ?? [];
    if (rec.outputs.length > 0 && outs.length === 0) {
      pushIssue(
        'error',
        'machine-blocked-output',
        `${def.nameZh} (${b.x},${b.y}) 没有任何输出传送带接入（稳态效率 0%）`,
        b.floor,
        b.x,
        b.y,
        b.id
      );
    }
  }

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const peakDrawMW = round2((crafterPeakKW + labPeakKW + facilityPeakKW + intermittentPeakKW) / 1000);
  const activeDrawMW = round2((crafterActiveKW + labActiveKW + facilityPeakKW) / 1000);
  const solarGenMW = round2(solarGenKW / 1000);
  const reactorGenMW = round2(reactorGenKW / 1000);
  const maxGenMW = round2((solarGenKW + reactorGenKW) / 1000);
  const minGenMW = round2((solarGenKW * 0.2 + reactorGenKW) / 1000);
  const netBalanceMW = round2(maxGenMW - peakDrawMW);
  const netBalanceActiveMW = round2(maxGenMW - activeDrawMW);

  if (maxGenMW > 0 && netBalanceMW < -1e-2) {
    const anchor =
      doc.buildings[0] ??
      (doc.modules[0] ? { floor: doc.modules[0].floor, x: doc.modules[0].gx * 16, y: doc.modules[0].gy * 16 } : { floor: 0, x: 0, y: 0 });
    const activeNote =
      netBalanceActiveMW >= -1e-2
        ? `（当前拓扑理论实耗 ${activeDrawMW.toFixed(1)} MW 可维持）`
        : `（连理论实耗 ${activeDrawMW.toFixed(1)} MW 也缺 ${Math.abs(netBalanceActiveMW).toFixed(1)} MW！）`;
    pushIssue(
      'warn',
      'power-deficit',
      `供电缺口：最大发电 ${maxGenMW.toFixed(1)} MW < 装机峰值 ${peakDrawMW.toFixed(1)} MW${activeNote}`,
      anchor.floor,
      anchor.x,
      anchor.y
    );
  }

  const power: PowerBreakdown = {
    peakDrawMW,
    activeDrawMW,
    maxGenMW,
    minGenMW,
    solarGenMW,
    reactorGenMW,
    generatorCount,
    netBalanceMW,
    netBalanceActiveMW,
    crafterPeakMW: round2(crafterPeakKW / 1000),
    labPeakMW: round2(labPeakKW / 1000),
    facilityPeakMW: round2(facilityPeakKW / 1000),
    intermittentPeakMW: round2(intermittentPeakKW / 1000),
  };

  const toRateList = (m: Map<string, number>): FlowItemRate[] =>
    Array.from(m.entries())
      .filter(([, r]) => r > 1e-4)
      .map(([itemId, ratePerSec]) => ({
        itemId,
        nameZh: getItemNameZh(itemId),
        ratePerSec: Math.round(ratePerSec * 1000) / 1000,
        beltsMk3: Math.round((ratePerSec / 3.0) * 100) / 100,
      }))
      .sort((a, b) => b.ratePerSec - a.ratePerSec || a.nameZh.localeCompare(b.nameZh, 'zh-Hans'));

  const recipeStats: RecipeRunStat[] = Array.from(byRecipeMap.values()).map(({ rec, count, effSum: rEffSum }) => {
    const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
    const avgEff = count > 0 ? rEffSum / count : 0;
    return {
      recipeId: rec.id,
      nameZh: rec.nameZh,
      machineCount: count,
      avgEfficiency: Math.round(avgEff * 1000) / 1000,
      maxOutputRates: rec.outputs.map((o) => {
        const rate = count * ((o.quantity ?? 1) / dur);
        return {
          itemId: o.itemId,
          nameZh: o.nameZh,
          ratePerSec: Math.round(rate * 1000) / 1000,
          beltsMk3: Math.round((rate / 3.0) * 100) / 100,
        };
      }),
      actualOutputRates: rec.outputs.map((o) => {
        const rate = rEffSum * ((o.quantity ?? 1) / dur);
        return {
          itemId: o.itemId,
          nameZh: o.nameZh,
          ratePerSec: Math.round(rate * 1000) / 1000,
          beltsMk3: Math.round((rate / 3.0) * 100) / 100,
        };
      }),
    };
  });

  // Sort issues so genuine RED errors always come first, then operational warnings, then YELLOW heads (首) & tails (尾)
  const issuePriority = (i: SimulationIssue): number => {
    if (i.severity === 'error') return 0;
    if (i.code === 'power-deficit') return 1;
    if (i.code === 'external-input-needed') return 2;
    if (i.code === 'blueprint-output') return 3;
    return 1;
  };
  issues.sort((a, b) => issuePriority(a) - issuePriority(b) || a.floor - b.floor || a.y - b.y || a.x - b.x);

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;
  const anomalyWarnCount = issues.filter(
    (i) => i.severity === 'warn' && i.code !== 'external-input-needed' && i.code !== 'blueprint-output'
  ).length;

  return {
    passed: errorCount === 0,
    errorCount,
    warnCount,
    anomalyWarnCount,
    issues,
    externalInputs,
    externalOutputs,
    balanceHints,
    totalPowerMW: peakDrawMW,
    power,
    machineCount,
    configuredMachineCount,
    avgEfficiency: configuredMachineCount > 0 ? Math.round((effSum / configuredMachineCount) * 1000) / 1000 : 1,
    recipeStats,
    netInputs: toRateList(netInputTotals),
    netOutputs: toRateList(netOutputTotals),
    cellFlows,
  };
}
