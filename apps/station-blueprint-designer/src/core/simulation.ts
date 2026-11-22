import { getBuildableDef, getItemNameZh, getModuleDef, getRecipeDef } from './catalog';
import {
  computeUndergroundLinks,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  isCellBuildable,
  rotationToDelta,
} from './geometry';
import type { BlueprintDocument, BuildableDef, PlacedBuilding, RecipeDef, Rotation } from './types';

export type SimulationIssueSeverity = 'error' | 'warn';

export type SimulationIssueCode =
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

export interface SimulationReport {
  passed: boolean;
  errorCount: number;
  warnCount: number;
  issues: SimulationIssue[];
  totalPowerMW: number;
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
    const [suW, suD] = mod.rotation % 2 === 0 ? [def.sizeUnits[0], def.sizeUnits[1]] : [def.sizeUnits[1], def.sizeUnits[0]];
    const cx = mod.gx * 16 + (suW * 16) / 2;
    const cy = mod.gy * 16 + (suD * 16) / 2;
    for (const fl of def.floors) {
      if (!fl.elevatorPorts) continue;
      for (const ep of fl.elevatorPorts) {
        let rx = ep.x;
        let ry = ep.y;
        if (mod.rotation === 1) [rx, ry] = [-ep.y, ep.x];
        else if (mod.rotation === 2) [rx, ry] = [-ep.x, -ep.y];
        else if (mod.rotation === 3) [rx, ry] = [ep.y, -ep.x];
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
    const [suW, suD] = mod.rotation % 2 === 0 ? [def.sizeUnits[0], def.sizeUnits[1]] : [def.sizeUnits[1], def.sizeUnits[0]];
    const mcx = mod.gx * 16 + (suW * 16) / 2;
    const mcy = mod.gy * 16 + (suD * 16) / 2;
    const dx = cx - mcx;
    const dy = cy - mcy;
    // Transform world offset into module local coords (inverse rotation)
    let lx = dx;
    let ly = dy;
    if (mod.rotation === 1) [lx, ly] = [dy, -dx];
    else if (mod.rotation === 2) [lx, ly] = [-dx, -dy];
    else if (mod.rotation === 3) [lx, ly] = [-dy, dx];

    for (const fl of def.floors) {
      if (mod.floor + fl.floorOffset !== floor) continue;
      const inInnerRect = lx >= fl.minX && lx <= fl.maxX && ly >= fl.minY && ly <= fl.maxY;
      if (inInnerRect) continue;
      // Check if cell falls in one of this module's doorway strips!
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
 * Pure deterministic production-line connectivity, zero-anomaly audit, and steady-state flow simulator.
 * Works on any BlueprintDocument (standalone cells, multi-module hubs, or multi-deck stations).
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

  // Index active world ports for machines & containers -> map external adjacent cell to { building, portIndex, sideDir }
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
    if (def.kind !== 'crafter' && def.kind !== 'research' && def.kind !== 'container') continue;
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
  const addEdge = (fromId: string, toId: string, capacity: number, outPortIndex?: number, inPortIndex?: number, filterItem?: string) => {
    let outs = outEdges.get(fromId);
    if (!outs) {
      outs = [];
      outEdges.set(fromId, outs);
    }
    if (!outs.some((e) => e.toId === toId && e.portIndex === outPortIndex)) {
      outs.push({ toId, portIndex: outPortIndex, capacity, filterItem });
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

  // Track doorway boundary entries and exits
  const boundaryEntries = new Set<string>();
  const boundaryExits = new Set<string>();

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
      // Determine which input port (0 or 1) aligns with targetCellX, targetCellY
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

  // 2. Build directed logistics graph + detect all structural/port anomalies
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

      // Check doorway / elevator boundary entry (ONLY on actual doorway threshold tiles or elevator ports!)
      if (
        (isDoorwayThresholdCell(doc, b.x, b.y, b.floor) && isBoundaryFloorMissing(doc, bx, by, b.floor)) ||
        elevatorPorts.has(cellKey(b.floor, bx, by))
      ) {
        boundaryEntries.add(b.id);
      }

      // Check forward target
      const { target: machHit, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, b.rotation);
      if (machHit) {
        addEdge(b.id, machHit.building.id, speed, undefined, machHit.portIndex);
      } else if (disabledHit) {
        pushIssue(
          'error',
          'dead-end-belt',
          `传送带 (${b.x},${b.y}) 指向了已禁用的机器/容器端口`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      } else if (
        (isDoorwayThresholdCell(doc, b.x, b.y, b.floor) && isBoundaryFloorMissing(doc, fx, fy, b.floor)) ||
        elevatorPorts.has(cellKey(b.floor, fx, fy))
      ) {
        boundaryExits.add(b.id);
      } else {
        const nb = cellMap.get(cellKey(b.floor, fx, fy));
        if (!nb) {
          pushIssue('error', 'dead-end-belt', `传送带 (${b.x},${b.y}) 末端悬空未接入下游`, b.floor, b.x, b.y, b.id);
        } else {
          const nbDef = defById.get(nb.id)!;
          const acc = canLogisticsAcceptFrom(nb, nbDef, b.rotation, fx, fy);
          if (acc.ok) {
            addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), undefined, acc.inPortIndex);
          } else if (acc.headOn) {
            pushIssue('error', 'head-on-belt', `传送带 (${b.x},${b.y}) 与 (${fx},${fy}) 正面对撞`, b.floor, b.x, b.y, b.id);
          } else {
            pushIssue(
              'error',
              'dead-end-belt',
              `传送带 (${b.x},${b.y}) 朝向与下游 ${nbDef.nameZh} (${fx},${fy}) 不匹配`,
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
        // Wall-tunnel underground right next to module outer wall (e.g. Cell-9P x=1, y=30 facing West) is an intentional cross-room stub -> warn, else error
        const fx = b.x + dx;
        const fy = b.y + dy;
        const bx = b.x - dx;
        const by = b.y - dy;
        const isWallStub =
          (b.undergroundMode === 'in' && (isBoundaryFloorMissing(doc, fx, fy, b.floor) || isBoundaryFloorMissing(doc, fx + dx, fy + dy, b.floor))) ||
          (b.undergroundMode === 'out' && (isBoundaryFloorMissing(doc, bx, by, b.floor) || isBoundaryFloorMissing(doc, bx - dx, by - dy, b.floor)));
        pushIssue(
          isWallStub ? 'warn' : 'error',
          'unpaired-underground',
          isWallStub
            ? `穿墙预留地下带 (${b.x},${b.y}) 等待跨舱对接`
            : `地下带 (${b.x},${b.y}) 未找到配对出/入口`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
        if (isWallStub && b.undergroundMode === 'in') {
          boundaryExits.add(b.id);
        } else if (isWallStub && b.undergroundMode === 'out') {
          boundaryEntries.add(b.id);
        }
      }

      if (b.undergroundMode === 'in') {
        const partner = ugPartnerByIn.get(b.id);
        if (partner) {
          addEdge(b.id, partner.id, speed);
        }
      } else {
        // undergroundMode === 'out' pushes forward
        const fx = b.x + dx;
        const fy = b.y + dy;
        const { target: machHit, disabledHit } = findEnabledMachinePortAccepting(b.floor, b.x, b.y, b.rotation);
        if (machHit) {
          addEdge(b.id, machHit.building.id, speed, undefined, machHit.portIndex);
        } else if (disabledHit) {
          pushIssue('error', 'port-mismatch', `地下带出口 (${b.x},${b.y}) 指向已禁用端口`, b.floor, b.x, b.y, b.id);
        } else if (isBoundaryFloorMissing(doc, fx, fy, b.floor) || elevatorPorts.has(cellKey(b.floor, fx, fy))) {
          boundaryExits.add(b.id);
        } else {
          const nb = cellMap.get(cellKey(b.floor, fx, fy));
          if (!nb) {
            pushIssue('error', 'dead-end-belt', `地下带出口 (${b.x},${b.y}) 悬空未连接`, b.floor, b.x, b.y, b.id);
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
          pushIssue('error', 'splitter-leak', `分流器 (${b.x},${b.y}) 活跃口 #${pIdx} 指向已禁用机器端口`, b.floor, b.x, b.y, b.id);
          continue;
        }
        if (isBoundaryFloorMissing(doc, tx, ty, b.floor) || elevatorPorts.has(cellKey(b.floor, tx, ty))) {
          boundaryExits.add(b.id);
          continue;
        }
        const nb = cellMap.get(cellKey(b.floor, tx, ty));
        if (!nb) {
          pushIssue('error', 'splitter-leak', `分流器 (${b.x},${b.y}) 未禁用侧口 #${pIdx} 指向空地`, b.floor, b.x, b.y, b.id);
          continue;
        }
        const nbDef = defById.get(nb.id)!;
        if (nbDef.kind === 'belt' && nb.rotation !== pDir) {
          pushIssue(
            'error',
            'splitter-leak',
            `分流器 (${b.x},${b.y}) 活跃口 #${pIdx} 侧漏撞上异向传送带 (${tx},${ty})`,
            b.floor,
            b.x,
            b.y,
            b.id
          );
          continue;
        }
        const acc = canLogisticsAcceptFrom(nb, nbDef, pDir, tx, ty);
        if (acc.ok) {
          addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), pIdx, acc.inPortIndex, filterItem);
        } else {
          pushIssue('error', 'splitter-leak', `分流器 (${b.x},${b.y}) 活跃口 #${pIdx} 与 (${tx},${ty}) 方向冲突`, b.floor, b.x, b.y, b.id);
        }
      }
    } else if (def.kind === 'balancer') {
      const worldPorts = getBuildingWorldPorts(b, def);
      const [dx, dy] = rotationToDelta(b.rotation);
      for (const wp of worldPorts) {
        if (wp.port.role !== 'out') continue;
        // Cell inside balancer owning this output port
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
          pushIssue('error', 'port-mismatch', `平衡器 (${b.x},${b.y}) 出口 #${wp.port.index} 指向已禁用机器端口`, b.floor, b.x, b.y, b.id);
          continue;
        }
        if (isBoundaryFloorMissing(doc, tx, ty, b.floor) || elevatorPorts.has(cellKey(b.floor, tx, ty))) {
          boundaryExits.add(b.id);
          continue;
        }
        const nb = cellMap.get(cellKey(b.floor, tx, ty));
        if (!nb) {
          // Intentionally unused second lane on a 2-in-1-out priority merge balancer is valid in Main Sequence!
          continue;
        }
        const nbDef = defById.get(nb.id)!;
        const acc = canLogisticsAcceptFrom(nb, nbDef, b.rotation, tx, ty);
        if (acc.ok) {
          addEdge(b.id, nb.id, Math.min(speed, getTierSpeed(nbDef.tier)), wp.port.index, acc.inPortIndex, filterItem);
        } else {
          pushIssue('error', 'port-mismatch', `平衡器 (${b.x},${b.y}) 出口 #${wp.port.index} 与 (${tx},${ty}) 方向冲突`, b.floor, b.x, b.y, b.id);
        }
      }
    } else if (def.kind === 'crafter' || def.kind === 'research' || def.kind === 'container') {
      // Connect outgoing logistics from every enabled port of this machine/container
      const worldPorts = getBuildingWorldPorts(b, def);
      for (const wp of worldPorts) {
        if (!wp.enabled) continue;
        const sideDir = SIDE_TO_ROT[wp.side];
        const ax = wp.outsideCellX;
        const ay = wp.outsideCellY;
        const nb = cellMap.get(cellKey(b.floor, ax, ay));
        if (!nb) continue;
        const nbDef = defById.get(nb.id)!;
        // If adj is a belt NOT pointing into the machine, machine can push out onto it!
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

  // 3. Check orphan/unfed belts (no incoming edge AND not a valid doorway/elevator entry!)
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    if (def.kind === 'belt') {
      const ins = inEdges.get(b.id);
      if ((!ins || ins.length === 0) && !boundaryEntries.has(b.id)) {
        pushIssue('error', 'orphan-belt', `悬空/无源传送带 (${b.x},${b.y})：没有任何上游供料`, b.floor, b.x, b.y, b.id);
      }
    } else if (def.kind === 'splitter') {
      const ins = inEdges.get(b.id);
      if (!ins || ins.length === 0) {
        pushIssue('error', 'orphan-belt', `无源分流器 (${b.x},${b.y})：输入口没有任何上游供料`, b.floor, b.x, b.y, b.id);
      }
    }
  }

  // 4. Infer external doorway boundary item assignments (so standalone standard cells simulate end-to-end!)
  const entryItem = new Map<string, string>();
  const isLogistics = (id: string) => {
    const k = defById.get(id)?.kind;
    return k === 'belt' || k === 'underground' || k === 'splitter' || k === 'balancer';
  };

  // Helper: trace forward from a node through logistics (optionally containers) to find reached crafters & ports
  const traceToCrafters = (startId: string): Array<{ crafterId: string; portIndex: number; filterHint?: string }> => {
    const visited = new Set<string>([startId]);
    const queue: Array<{ id: string; filterHint?: string }> = [{ id: startId }];
    const hits: Array<{ crafterId: string; portIndex: number; filterHint?: string }> = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of outEdges.get(cur.id) ?? []) {
        const nextDef = defById.get(e.toId);
        if (!nextDef) continue;
        const hint = e.filterItem ?? cur.filterHint;
        if (nextDef.kind === 'crafter' || nextDef.kind === 'research') {
          const inE = (inEdges.get(e.toId) ?? []).find((x) => x.fromId === cur.id);
          hits.push({ crafterId: e.toId, portIndex: inE?.portIndex ?? -1, filterHint: hint });
        } else if (isLogistics(e.toId) && !visited.has(e.toId)) {
          visited.add(e.toId);
          queue.push({ id: e.toId, filterHint: hint });
        }
      }
    }
    return hits;
  };

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
        (rec.outputs.length === 1
          ? rec.outputs[0].itemId
          : rec.outputs[oi % rec.outputs.length].itemId);
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

  // Group boundary entries by their symmetric doorway signature (min(y, 31-y) on x=0/31, or min(x, 31-x) on y=0/31)
  // so mirrored top/bottom inputs of the same cell consistently receive the exact same ingredient!
  const sortedEntries = Array.from(boundaryEntries).sort((a, bId) => {
    const ba = buildingById.get(a)!;
    const bb = buildingById.get(bId)!;
    const keyA = ba.x === 0 || ba.x === 31 ? Math.min(ba.y, 31 - ba.y) : Math.min(ba.x, 31 - ba.x);
    const keyB = bb.x === 0 || bb.x === 31 ? Math.min(bb.y, 31 - bb.y) : Math.min(bb.x, 31 - bb.x);
    return keyA - keyB || ba.floor - bb.floor || ba.x - bb.x || ba.y - bb.y;
  });

  // Track which recipe inputs are already covered on each crafter (from internal upstream crafters or assigned entries)
  const crafterAssignedPorts = new Map<string, Map<number, string>>();
  const assignCrafterPort = (cid: string, pIdx: number, itemId: string) => {
    let mp = crafterAssignedPorts.get(cid);
    if (!mp) {
      mp = new Map();
      crafterAssignedPorts.set(cid, mp);
    }
    mp.set(pIdx, itemId);
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

  // Map mirror-group signature -> assigned itemId so top & bottom halves stay consistent
  const groupItemBySig = new Map<string, string>();
  for (const eid of sortedEntries) {
    const eb = buildingById.get(eid)!;
    const hits = traceToCrafters(eid);
    if (hits.length === 0) continue;

    // Check explicit filter hint first
    const explicitHint = hits.find((h) => h.filterHint)?.filterHint;
    if (explicitHint) {
      entryItem.set(eid, explicitHint);
      for (const h of hits) assignCrafterPort(h.crafterId, h.portIndex, explicitHint);
      continue;
    }

    // Collect intersection of required recipe inputs across all reached crafters
    const firstRec = getRecipeDef(buildingById.get(hits[0].crafterId)?.recipeId ?? '');
    if (!firstRec || firstRec.inputs.length === 0) continue;

    const sigAxis = eb.x === 0 || eb.x === 31 ? `x${eb.x}:m${Math.min(eb.y, 31 - eb.y)}` : `y${eb.y}:m${Math.min(eb.x, 31 - eb.x)}`;
    const targetRecipesSig = Array.from(new Set(hits.map((h) => buildingById.get(h.crafterId)?.recipeId ?? ''))).sort().join(',');
    const groupSig = `${eb.floor}:${sigAxis}:${targetRecipesSig}`;

    const candidateItems = firstRec.inputs
      .map((i) => i.itemId)
      .filter((itemId) =>
        hits.every((h) => {
          const r = getRecipeDef(buildingById.get(h.crafterId)?.recipeId ?? '');
          return !r || r.inputs.some((ri) => ri.itemId === itemId);
        })
      );
    if (candidateItems.length === 0) continue;

    let chosen = groupItemBySig.get(groupSig);
    if (!chosen || !candidateItems.includes(chosen)) {
      // Pick the first candidate not yet assigned to another port of the first reached crafter
      const alreadyOnFirst = new Set((crafterAssignedPorts.get(hits[0].crafterId) ?? new Map()).values());
      chosen = candidateItems.find((id) => !alreadyOnFirst.has(id)) ?? candidateItems[0];
      groupItemBySig.set(groupSig, chosen);
    }
    entryItem.set(eid, chosen);
    for (const h of hits) assignCrafterPort(h.crafterId, h.portIndex, chosen);
  }

  // 5. Iterative Steady-State Flow Solver
  // Track flow pushed along each directed edge `${fromId}->${toId}:${outPortIndex ?? -1}`
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

  // Pre-seed self-reseed cycles (e.g. XenobacteriaRecycling) with a tiny starter pulse on iteration 0
  // so closed recycling loops ignite naturally just like priming a growth chamber with 1 seed!
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

  // Compute exact downstream demand per node (for boundary entries & priority-in balancers)
  const getNodeInFlow = (id: string): FlowMap => {
    const m: FlowMap = new Map();
    if (boundaryEntries.has(id)) {
      const itemId = entryItem.get(id);
      if (itemId) {
        const cap = getTierSpeed(defById.get(id)!.tier);
        addFlow(m, itemId, cap);
      }
    }
    for (const ie of inEdges.get(id) ?? []) {
      // Find matching outgoing edge(s) from ie.fromId -> id
      for (const oe of outEdges.get(ie.fromId) ?? []) {
        if (oe.toId !== id) continue;
        const fm = edgeFlows.get(edgeKey(ie.fromId, id, oe.portIndex));
        if (!fm) continue;
        for (const [it, r] of fm.entries()) addFlow(m, it, r);
      }
    }
    return m;
  };

  // Track which crafter output port carries which recipe output (for 2-output recipes like Enzyme + Biomass)
  const crafterPortOutputItem = new Map<string, Map<number, string>>();
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def || (def.kind !== 'crafter' && def.kind !== 'research') || !b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec || rec.outputs.length <= 1) continue;
    const outs = outEdges.get(b.id) ?? [];
    // Sort outputs deterministically: main output port first (smaller local port index or port with center-belt downstream)
    const pMap = new Map<number, string>();
    // In Cell-7B: x+2 drops into y=15/16 (Balancer), x+4 runs along y=13/18 (Biomass return).
    // Prefer matching explicit filter or port ordering!
    const sortedOuts = [...outs].sort((a, bEdge) => {
      const ba = buildingById.get(a.toId);
      const bb = buildingById.get(bEdge.toId);
      // Lower x offset within machine -> main product; higher x offset -> byproduct
      return (ba?.x ?? 0) - (bb?.x ?? 0) || (a.portIndex ?? 0) - (bEdge.portIndex ?? 0);
    });
    for (let i = 0; i < sortedOuts.length; i++) {
      const o = rec.outputs[Math.min(i, rec.outputs.length - 1)];
      pMap.set(sortedOuts[i].portIndex ?? i, o.itemId);
    }
    crafterPortOutputItem.set(b.id, pMap);
  }

  // Compute BFS-ordered traversal from sources (boundary entries + zero-input crafters) so arbitrarily long belt chains
  // propagate end-to-end in a SINGLE pass, while multi-pass relaxation converges closed recycling loops!
  const bfsOrder: PlacedBuilding[] = [];
  const bfsSeen = new Set<string>();
  const bfsQueue: string[] = [];
  for (const eid of boundaryEntries) {
    if (!bfsSeen.has(eid)) {
      bfsSeen.add(eid);
      bfsQueue.push(eid);
    }
  }
  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if ((def?.kind === 'crafter' || def?.kind === 'research') && !bfsSeen.has(b.id)) {
      const rec = b.recipeId ? getRecipeDef(b.recipeId) : undefined;
      if (!rec || rec.inputs.length === 0) {
        bfsSeen.add(b.id);
        bfsQueue.push(b.id);
      }
    }
  }
  while (bfsQueue.length > 0) {
    const cur = bfsQueue.shift()!;
    const cb = buildingById.get(cur);
    if (cb) bfsOrder.push(cb);
    for (const oe of outEdges.get(cur) ?? []) {
      if (!bfsSeen.has(oe.toId)) {
        bfsSeen.add(oe.toId);
        bfsQueue.push(oe.toId);
      }
    }
  }
  for (const b of doc.buildings) {
    if (!bfsSeen.has(b.id)) bfsOrder.push(b);
  }

  // Backward DP (reverse BFS) to compute exact steady-state downstream demand per node & itemId
  // so Splitter/Balancer manifolds model real game backpressure accurately (never falsely starving long manifolds!).
  const nodeDemand = new Map<string, Map<string, number>>();
  const addDemand = (id: string, itemId: string, rate: number) => {
    if (rate <= 1e-9) return;
    let m = nodeDemand.get(id);
    if (!m) {
      m = new Map();
      nodeDemand.set(id, m);
    }
    m.set(itemId, (m.get(itemId) ?? 0) + rate);
  };
  const revOrder = [...bfsOrder].reverse();
  for (let pass = 0; pass < 4; pass++) {
    for (const b of revOrder) {
      const def = defById.get(b.id);
      if (!def) continue;
      const dm = new Map<string, number>();
      if (def.kind === 'crafter' || def.kind === 'research') {
        const req = crafterDemandByInput.get(b.id);
        if (req) {
          for (const [it, r] of req.entries()) dm.set(it, r);
        }
      } else {
        const outs = outEdges.get(b.id) ?? [];
        if (boundaryExits.has(b.id)) {
          dm.set('*', getTierSpeed(def.tier));
        }
        for (const oe of outs) {
          const childDm = nodeDemand.get(oe.toId);
          if (!childDm) continue;
          let childSum = 0;
          for (const [it, r] of childDm.entries()) {
            if (oe.filterItem && it !== '*' && it !== oe.filterItem) continue;
            childSum += r;
          }
          const scale = childSum > oe.capacity ? oe.capacity / childSum : 1;
          for (const [it, r] of childDm.entries()) {
            if (oe.filterItem && it !== '*' && it !== oe.filterItem) continue;
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
  void addDemand;

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

        let eff = 1.0;
        if (rec.inputs.length > 0) {
          for (const inp of rec.inputs) {
            const need = (inp.quantity ?? 1) / dur;
            let got = inFlow.get(inp.itemId) ?? 0;
            // Ignite closed self-recycling recipes (where output also contains inp.itemId) on iter 0!
            if (iter === 0 && got < need && rec.outputs.some((o) => o.itemId === inp.itemId)) {
              got = need;
            }
            eff = Math.min(eff, need > 0 ? got / need : 1);
          }
        }
        eff = Math.max(0, Math.min(1, eff));
        crafterEfficiency.set(b.id, eff);

        if (outs.length === 0) continue;
        const portMap = crafterPortOutputItem.get(b.id);
        for (const oe of outs) {
          const fm: FlowMap = new Map();
          if (rec.outputs.length === 1) {
            const o = rec.outputs[0];
            const totalOut = eff * ((o.quantity ?? 1) / dur);
            addFlow(fm, o.itemId, Math.min(oe.capacity, totalOut / outs.length));
          } else if (portMap) {
            const assignedItem = portMap.get(oe.portIndex ?? -1);
            const o = rec.outputs.find((x) => x.itemId === assignedItem) ?? rec.outputs[0];
            const totalOut = eff * ((o.quantity ?? 1) / dur);
            addFlow(fm, o.itemId, Math.min(oe.capacity, totalOut));
          }
          setEdgeFlow(edgeKey(b.id, oe.toId, oe.portIndex), fm);
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
        // Distribute evenly across outgoing belts up to each belt capacity
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
        // Compute available input flow (honoring Balancer priorityIn + downstream backpressure demand!)
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
          // Effective throughput cap respects both physical belt capacity and downstream demand!
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

        // Route each item honoring portFilters, priorityOut, and max-min fair water-filling backpressure!
        const outMaps = new Map<OutEdge, FlowMap>();
        for (const oe of outs) outMaps.set(oe, new Map());

        for (const [itemId, rate] of combinedIn.entries()) {
          if (rate <= 1e-9) continue;
          const filteredTargets = outs.filter((e) => e.filterItem === itemId);
          const unfilteredTargets = outs.filter((e) => !e.filterItem);
          const eligible = filteredTargets.length > 0 ? filteredTargets : unfilteredTargets;
          if (eligible.length === 0) continue;

          let remaining = rate;
          // 1) Fill priorityOut first up to its backpressure-limited demand!
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
          // 2) Water-filling split across remaining eligible outputs (saturates smaller-demand branches & overflows cleanly!)
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
              // All remaining active edges can absorb the equal share
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

  // 6. Inspect converged flow for mixed-item belts, overload, missing/wrong machine inputs, blocked outputs
  const cellFlows: Record<string, CellFlowInfo> = {};
  const netInputTotals = new Map<string, number>();
  const netOutputTotals = new Map<string, number>();

  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;

    if (def.kind === 'belt' || def.kind === 'underground' || def.kind === 'splitter' || def.kind === 'balancer') {
      const cap = getTierSpeed(def.tier);
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
      const overloaded = total > cap + 1e-3;
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

      // Mixed-item contamination check on belts (unless node is a filter splitter intentionally separating mixed items)
      const hasPortFilter = b.portFilters && Object.keys(b.portFilters).length > 0;
      if (nonZeroItems.length > 1 && def.kind === 'belt') {
        pushIssue(
          'error',
          'mixed-item-belt',
          `传送带 (${b.x},${b.y}) 发生混料：${nonZeroItems.map(getItemNameZh).join(' + ')}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      } else if (nonZeroItems.length > 1 && def.kind === 'splitter' && !hasPortFilter) {
        pushIssue(
          'warn',
          'mixed-item-belt',
          `分流器 (${b.x},${b.y}) 输入混料但未配置过滤：${nonZeroItems.map(getItemNameZh).join(' + ')}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }

      if (overloaded && def.kind === 'belt') {
        pushIssue(
          'warn',
          'belt-overload',
          `传送带 (${b.x},${b.y}) 超载：需求/合流 ${total.toFixed(2)}/s > 上限 ${cap.toFixed(1)}/s`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }

      // Accumulate net external boundary exits
      if (boundaryExits.has(b.id)) {
        for (const [it, r] of flow.entries()) {
          if (r > 1e-4) netOutputTotals.set(it, (netOutputTotals.get(it) ?? 0) + Math.min(r, cap));
        }
      }
    }
  }

  // Evaluate machines (power, efficiency, missing/wrong inputs, blocked outputs) & net consumed inputs
  let totalPowerKW = 0;
  let machineCount = 0;
  let configuredMachineCount = 0;
  let effSum = 0;

  const byRecipeMap = new Map<
    string,
    { rec: RecipeDef; count: number; effSum: number }
  >();

  for (const b of doc.buildings) {
    const def = defById.get(b.id);
    if (!def) continue;
    if (def.kind !== 'crafter' && def.kind !== 'research') continue;
    machineCount++;
    if (def.powerKW) totalPowerKW += def.powerKW;
    if (!b.recipeId) continue;
    const rec = getRecipeDef(b.recipeId);
    if (!rec) continue;
    configuredMachineCount++;
    const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
    const eff = crafterEfficiency.get(b.id) ?? 0;
    effSum += eff;

    let entry = byRecipeMap.get(rec.id);
    if (!entry) {
      entry = { rec, count: 0, effSum: 0 };
      byRecipeMap.set(rec.id, entry);
    }
    entry.count++;
    entry.effSum += eff;

    const inFlow = getNodeInFlow(b.id);
    const reqSet = new Set(rec.inputs.map((i) => i.itemId));
    // Check wrong item entering machine
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
    // Check missing required inputs
    for (const inp of rec.inputs) {
      const got = inFlow.get(inp.itemId) ?? 0;
      if (got <= 1e-4) {
        pushIssue(
          'error',
          'machine-missing-input',
          `${def.nameZh} (${b.x},${b.y}) 缺少原料：${inp.nameZh}`,
          b.floor,
          b.x,
          b.y,
          b.id
        );
      }
      // Track actual consumed external input rate (net external = consumed - internally produced)
      const consumed = eff * ((inp.quantity ?? 1) / dur);
      netInputTotals.set(inp.itemId, (netInputTotals.get(inp.itemId) ?? 0) + consumed);
    }
    // Check blocked / disconnected output
    const outs = outEdges.get(b.id) ?? [];
    if (rec.outputs.length > 0 && outs.length === 0) {
      pushIssue(
        'warn',
        'machine-blocked-output',
        `${def.nameZh} (${b.x},${b.y}) 没有任何输出传送带接入`,
        b.floor,
        b.x,
        b.y,
        b.id
      );
    }
  }

  // Subtract internal production from netInputTotals so chained recipes (like B1 2:1 Enricher or Bio reseed)
  // report true NET external inputs!
  for (const { rec, effSum: rEffSum } of byRecipeMap.values()) {
    const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
    for (const o of rec.outputs) {
      const prod = rEffSum * ((o.quantity ?? 1) / dur);
      const curIn = netInputTotals.get(o.itemId) ?? 0;
      if (curIn > 0) {
        const rem = Math.max(0, curIn - prod);
        if (rem <= 1e-4) netInputTotals.delete(o.itemId);
        else netInputTotals.set(o.itemId, rem);
      }
    }
  }

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

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;

  return {
    passed: errorCount === 0,
    errorCount,
    warnCount,
    issues,
    totalPowerMW: Math.round((totalPowerKW / 1000) * 100) / 100,
    machineCount,
    configuredMachineCount,
    avgEfficiency: configuredMachineCount > 0 ? Math.round((effSum / configuredMachineCount) * 1000) / 1000 : 1,
    recipeStats,
    netInputs: toRateList(netInputTotals),
    netOutputs: toRateList(netOutputTotals),
    cellFlows,
  };
}
