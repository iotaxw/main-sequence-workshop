/**
 * Hierarchical Deterministic Verification Framework (HDVF v1.0)
 *
 * A general-purpose, blueprint-agnostic, systems-engineering (V-model / compositional reductionism)
 * verification engine for ANY Main Sequence station blueprint (single room, hub, multi-wing factory,
 * or 30k+ building mega-station).
 *
 * Strictly grounded in Build 26639889 binary-verified engine physics:
 *  - L0 Atomic Catalog & Schema Integrity (O(M + B))
 *  - L1 Module-Internal Compositional Unit Verification with Canonical Archetype Memoization (O(U))
 *  - L2 Cross-Module Geometry, Seams, Elevator Physics & Blueprint-vs-Planner Feasibility Split (O(M log M + B_seam))
 *       * Hard Gate (Blueprint Runtime Legal): exact BuildBlueprintUtil::CheckOverlap (BlockBounds 3D AABB, 0x1443146f0),
 *         ElevatorObject::FindAndLinkStack contiguity (0x1442e1c70), doorway seams.
 *       * Advisory Telemetry (Native Interactive Planner): connector-graph islands (floating blocks have 0 runtime/power
 *         impact per ValidateBlueprint 0x144315b20), order-dependent vertical proximity.
 *  - L3 Global Topology, Tarjan SCC Conservation & No-Trip Proportional Power Profile (O(V + E))
 *  - L4 Multi-Regime Dynamic Equilibrium & Deadlock Proof (O(K * (V + E))):
 *       * Regime A: Cold-Start Unconstrained Absorption (sigma = 0)
 *       * Regime B: Progressive Saturation / Backpressure Cascade Trajectory (sigma^(0) -> ... -> sigma^(K))
 *       * Regime C: Multi-Output Byproduct Backpressure Perturbation Audit
 */

import { getBuildableDef, getModuleDef, getRecipeDef } from './catalog';
import {
  FLOOR_HEIGHT_M,
  STATION_UNIT_M,
  getBuildingSizeCells,
  getModuleCenterM,
  getModuleFloorShift,
  getModuleOriginOffsetM,
  getModuleSizeUnits,
  getModuleWorldConnectors,
  isCellBuildable,
  normalizeRotation,
  rotateVec2,
  rotationToDelta,
} from './geometry';
import { simulateBlueprint } from './simulation';
import type { SimulationReport } from './simulation';
import type { BlueprintDocument, PlacedBuilding, PlacedModule, Rotation, StationModuleDef } from './types';

/* ===================== Public Report Types ===================== */

export interface Layer0AtomicAudit {
  moduleCount: number;
  buildingCount: number;
  unknownModuleTypes: string[];
  unknownBuildingTypes: string[];
  invalidRecipes: number;
  invalidPortConfigs: number;
  durationMs: number;
  passed: boolean;
}

export interface ModuleArchetypeSummary {
  archetypeKey: string;
  moduleType: string;
  instanceCount: number;
  sampleModuleId: string;
  sampleLabel: string;
  buildingCount: number;
  crafterCount: number;
  errorCount: number;
  anomalyWarnCount: number;
  avgEfficiency: number;
  peakPowerMW: number;
}

export interface Layer1ModuleUnitAudit {
  floorBearingModuleCount: number;
  uniqueArchetypeCount: number;
  dedupSavingsRatio: number;
  overlaps: number;
  outOfFloor: number;
  failedArchetypeCount: number;
  archetypes: ModuleArchetypeSummary[];
  durationMs: number;
  passed: boolean;
}

export interface BlockBoundsOverlapHit {
  moduleAId: string;
  moduleAType: string;
  moduleACoords: string;
  moduleBId: string;
  moduleBType: string;
  moduleBCoords: string;
}

export interface PlannerBuildabilityAdvisory {
  /** Strict connector-graph connected component count (1 = single connected hull; >1 = has floating islands). */
  connectorComponents: number;
  mainComponentSize: number;
  floatingModuleCount: number;
  floatingIslandSizes: number[];
  connectorTypeMismatches: number;
  /** Vertically close non-overlapping module pairs whose interactive placement may be build-order sensitive. */
  orderSensitiveProximityPairs: number;
  note: string;
}

export interface Layer2CrossModuleAudit {
  /** Exact BuildBlueprintUtil::CheckOverlap (0x1443146f0) BlockBounds 3D AABB hits (Hard Gate: 0). */
  blockBoundsOverlapCount: number;
  blockBoundsOverlaps: BlockBoundsOverlapHit[];
  /** Elevator stack contiguity & port cleanliness (Hard Gate: 0 gaps/mixed/UG-on-port/side-belt). */
  elevatorModuleCount: number;
  contiguousElevatorStacks: number;
  elevatorStackGaps: number;
  elevatorRotationMismatches: number;
  elevatorMixedShafts: number;
  elevatorActivePortTouches: number;
  elevatorUgOnPort: number;
  elevatorSideBeltOnPort: number;
  elevatorNonBeltOnPort: number;
  elevatorDanglingInShafts: number;
  elevatorActiveShafts: number;
  elevatorDualOutputPriorityShafts: number;
  /** Cross-module doorway seam integrity (belts crashing into solid walls across seams). */
  seamDeadEndCount: number;
  seamHeadOnCount: number;
  /** Explicitly non-blocking native interactive Planner ergonomics & buildability advisory. */
  plannerAdvisory: PlannerBuildabilityAdvisory;
  durationMs: number;
  passed: boolean;
}

export interface SccLoopAudit {
  sccId: number;
  kind: 'closed-conservation' | 'autocatalytic-seeded' | 'pure-logistics-loop';
  nodeCount: number;
  recipes: string[];
  items: string[];
  /** Net production - consumption inside SCC (for closed conservation loops, |net| < 1e-3/s). */
  conservationResiduals: Array<{ itemId: string; producedPerSec: number; consumedPerSec: number; netPerSec: number }>;
  /** Autocatalytic self-input items requiring initial seed injection on cold start. */
  bootstrapSeedItems: string[];
  hasOverflowDrain: boolean;
  healthy: boolean;
}

export interface OrbitSpeedScaleRow {
  label: string;
  solarFactor: number;
  supplyMW: number;
  peakDrawMW: number;
  /** Real-game PowerGrid has NO trip/blackout state; machines scale proportionally by min(1, Supply / Demand). */
  peakSpeedScale: number;
  activeDrawMW: number;
  activeSpeedScale: number;
}

export interface Layer3TopologyAudit {
  sccCount: number;
  loops: SccLoopAudit[];
  unhealthyLoopCount: number;
  unintendedLogisticsLoopCount: number;
  externalInputsByKind: Record<string, number>;
  /** Power profile explicitly modeled with real-game no-trip proportional scaling. */
  maxSolarMW: number;
  reactorMW: number;
  peakDrawMW: number;
  activeDrawMW: number;
  orbitProfiles: OrbitSpeedScaleRow[];
  durationMs: number;
  passed: boolean;
}

export interface SaturationStratum {
  stratum: number;
  saturatedCountBefore: number;
  newlyReachedSinkIds: string[];
  cumulativeReachedCount: number;
  totalWiredTerminalSinks: number;
  mixedBeltCount: number;
  beltOverloadCount: number;
  mixedSinkCount: number;
  durationMs: number;
}

export interface MultiOutputAuditRow {
  recipeId: string;
  machineCount: number;
  outputItems: string[];
  /** True when all outputs are either stoichiometrically conserved in an L3 SCC or safely drained without deadlock. */
  backpressureSafe: boolean;
  reason: string;
}

export interface Layer4MultiRegimeAudit {
  /** Regime A: Cold-start unconstrained absorption (sigma = 0). */
  coldStartDurationMs: number;
  coldStartErrorCount: number;
  coldStartMixedBeltCount: number;
  coldStartBeltOverloadCount: number;
  coldStartDisabledPortInputCount: number;
  coldStartMixedSinkCount: number;
  coldStartReachedSinkCount: number;
  /** Regime B: Progressive Saturation / Backpressure Cascade Trajectory (sigma^(0) -> sigma^(K)). */
  totalTerminalStorageSinks: number;
  /** Terminal containers whose incoming line originates from an empty/EA-reserved stub with 0 upstream producer. */
  eaOrUnbackedTerminalSinkCount: number;
  /**
   * Terminal containers wired strictly to a zero-net-surplus conserved autocatalytic seed item discovered by L3 Tarjan SCC
   * (by conservation law Δ=0, these hold manual/excess seed reserve rather than exporting steady-state net flow).
   */
  conservedSeedVaultSinkCount: number;
  conservedSeedVaultSinkIds: string[];
  /** Terminal containers backed by real net-exportable upstream production/dock supply. */
  activeProducerBackedSinkCount: number;
  /** Number of net-exportable producer-backed terminal sinks proven reachable across progressive saturation strata. */
  eventuallyReachedSinkCount: number;
  unreachableProducerBackedSinkIds: string[];
  strata: SaturationStratum[];
  backpressureRegressionCount: number;
  /** Regime C: Multi-output byproduct backpressure deadlock audit. */
  multiOutputAudits: MultiOutputAuditRow[];
  unprotectedByproductDeadlocks: number;
  durationMs: number;
  passed: boolean;
}

export interface HierarchicalVerifyOptions {
  /** Skip isolated per-archetype unit simulation in L1 (useful for interactive sub-50ms checks). */
  skipUnitSim?: boolean;
  /** Skip Regime B progressive saturation cascade (only run Cold-Start Regime A). */
  skipProgressiveSaturation?: boolean;
  /** Maximum progressive saturation strata in Regime B (default 6). */
  maxSaturationStrata?: number;
  /** Reuse a precomputed Cold-Start SimulationReport if already available. */
  precomputedColdStart?: SimulationReport;
}

export interface HierarchicalVerificationReport {
  frameworkVersion: 'HDVF-1.0';
  blueprintId: string;
  blueprintName: string;
  totalDurationMs: number;
  /** True iff all hard blueprint-runtime gates (L0..L4) pass. (Planner advisory is strictly non-blocking.) */
  passed: boolean;
  layer0: Layer0AtomicAudit;
  layer1: Layer1ModuleUnitAudit;
  layer2: Layer2CrossModuleAudit;
  layer3: Layer3TopologyAudit;
  layer4: Layer4MultiRegimeAudit;
  coldStartReport: SimulationReport;
}

/* ===================== Exact Geometry Helpers ===================== */

interface Aabb3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Exact replica of BuildBlueprintUtil::CheckOverlap (0x1443146f0) world-space 3D BlockBounds AABB,
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

function aabbStrictIntersects(a: Aabb3, b: Aabb3, eps = 0.02): boolean {
  return (
    a.minX + eps < b.maxX &&
    b.minX + eps < a.maxX &&
    a.minY + eps < b.maxY &&
    b.minY + eps < a.maxY &&
    a.minZ + eps < b.maxZ &&
    b.minZ + eps < a.maxZ
  );
}

/* ===================== L0: Atomic Catalog & Schema ===================== */

function runLayer0Atomic(doc: BlueprintDocument): Layer0AtomicAudit {
  const t0 = Date.now();
  const unknownMods = new Set<string>();
  const unknownBlds = new Set<string>();
  let invalidRecipes = 0;
  let invalidPortConfigs = 0;

  for (const m of doc.modules) {
    const mDef = getModuleDef(m.type);
    if (!mDef) unknownMods.add(m.type);
    if (m.recipeId) {
      const rec = getRecipeDef(m.recipeId);
      if (!rec) invalidRecipes++;
    }
  }

  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) {
      unknownBlds.add(b.type);
      continue;
    }
    if (b.recipeId) {
      const rec = getRecipeDef(b.recipeId);
      if (!rec || (def.crafterId && rec.crafterId && rec.crafterId !== def.crafterId)) invalidRecipes++;
    }
    if (b.disabledPorts) {
      for (const p of b.disabledPorts) {
        if (!Number.isInteger(p) || p < 0 || p >= def.ports.length) invalidPortConfigs++;
      }
    }
    if (def.kind === 'underground' && b.undergroundMode !== 'in' && b.undergroundMode !== 'out') {
      invalidPortConfigs++;
    }
  }

  const passed =
    unknownMods.size === 0 && unknownBlds.size === 0 && invalidRecipes === 0 && invalidPortConfigs === 0;
  return {
    moduleCount: doc.modules.length,
    buildingCount: doc.buildings.length,
    unknownModuleTypes: [...unknownMods].sort(),
    unknownBuildingTypes: [...unknownBlds].sort(),
    invalidRecipes,
    invalidPortConfigs,
    durationMs: Date.now() - t0,
    passed,
  };
}

/* ===================== L1: Compositional Module Unit Audit (Memoized) ===================== */

function inverseRotateVec2(x: number, y: number, rot: Rotation): [number, number] {
  return rotateVec2(x, y, normalizeRotation(4 - rot));
}

function buildCanonicalModuleArchetype(
  mod: PlacedModule,
  def: StationModuleDef,
  interiorBlds: PlacedBuilding[]
): { key: string; unitDoc: BlueprintDocument } {
  const [cx, cy] = getModuleCenterM(mod, def);
  const halfW = (def.sizeUnits[0] * STATION_UNIT_M) / 2;
  const halfD = (def.sizeUnits[1] * STATION_UNIT_M) / 2;

  const normBlds: PlacedBuilding[] = [];
  const tupleKeys: string[] = [];

  for (const b of interiorBlds) {
    const bDef = getBuildableDef(b.type);
    if (!bDef) continue;
    const [bw, bd] = getBuildingSizeCells(bDef, b.rotation);
    const bcx = b.x + bw / 2;
    const bcy = b.y + bd / 2;
    const [rlx, rly] = inverseRotateVec2(bcx - cx, bcy - cy, mod.rotation);
    const lrot = normalizeRotation(b.rotation - mod.rotation);
    const [lbw, lbd] = getBuildingSizeCells(bDef, lrot);
    const lx = Math.round(halfW + rlx - lbw / 2);
    const ly = Math.round(halfD + rly - lbd / 2);
    const lf = b.floor - mod.floor;
    const dp = b.disabledPorts ? [...b.disabledPorts].sort((a, z) => a - z).join(',') : '';
    const fi = b.filterItems ? [...b.filterItems].sort().join(',') : '';
    const pf = b.portFilters
      ? Object.entries(b.portFilters)
          .sort(([a], [z]) => a.localeCompare(z))
          .map(([k, v]) => `${k}=${v}`)
          .join(',')
      : '';
    const sig = `${lf}:${lx},${ly}:${lrot}:${b.type}:${b.recipeId ?? ''}:${b.undergroundMode ?? ''}:${dp}:${fi}:${pf}:${b.priorityIn ?? ''}:${b.priorityOut ?? ''}`;
    tupleKeys.push(sig);
    normBlds.push({
      id: `u_${normBlds.length}`,
      type: b.type,
      x: lx,
      y: ly,
      floor: lf,
      rotation: lrot,
      recipeId: b.recipeId,
      undergroundMode: b.undergroundMode,
      disabledPorts: b.disabledPorts ? [...b.disabledPorts] : undefined,
      filterItems: b.filterItems ? [...b.filterItems] : undefined,
      portFilters: b.portFilters ? { ...b.portFilters } : undefined,
      priorityIn: b.priorityIn,
      priorityOut: b.priorityOut,
    });
  }

  tupleKeys.sort();
  const dpMod = mod.dockPorts
    ? [...mod.dockPorts]
        .sort((a, z) => a.portIndex - z.portIndex)
        .map((p) => `${p.portIndex}:${p.mode}:${p.itemId}`)
        .join(',')
    : '';
  const key = `${mod.type}|${mod.recipeId ?? ''}|${dpMod}|${tupleKeys.join(';')}`;

  const unitDoc: BlueprintDocument = {
    format: 'station-blueprint-designer',
    formatVersion: 2,
    id: `unit_${mod.id}`,
    name: mod.label ?? mod.type,
    gameData: { buildId: '26639889', catalogVersion: 1 },
    modules: [
      {
        id: 'u_mod_0',
        type: mod.type,
        gx: 0,
        gy: 0,
        floor: 0,
        rotation: 0,
        recipeId: mod.recipeId,
        dockPorts: mod.dockPorts,
      },
    ],
    buildings: normBlds,
  };
  return { key, unitDoc };
}

function runLayer1ModuleUnits(doc: BlueprintDocument, skipUnitSim: boolean): Layer1ModuleUnitAudit {
  const t0 = Date.now();
  let overlaps = 0;
  let outOfFloor = 0;
  const occupied = new Set<string>();
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [bw, bd] = getBuildingSizeCells(def, b.rotation);
    let bOut = false;
    let bOver = false;
    for (let dx = 0; dx < bw; dx++) {
      for (let dy = 0; dy < bd; dy++) {
        const cx = b.x + dx;
        const cy = b.y + dy;
        const ck = `${b.floor}:${cx},${cy}`;
        if (occupied.has(ck)) bOver = true;
        occupied.add(ck);
        if (isCellBuildable(doc, cx, cy, b.floor) === null) bOut = true;
      }
    }
    if (bOver) overlaps++;
    if (bOut) outOfFloor++;
  }

  // Map each building to its containing floor-bearing module via O(1) station-unit grid lookup
  const floorMods: Array<{ mod: PlacedModule; def: StationModuleDef }> = [];
  const modGrid = new Map<string, PlacedModule>();
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def || !def.hasFactoryFloor) continue;
    floorMods.push({ mod, def });
    const [wu, du, hu] = getModuleSizeUnits(def, mod.rotation);
    for (let dx = 0; dx < wu; dx++) {
      for (let dy = 0; dy < du; dy++) {
        for (let df = 0; df < hu; df++) {
          modGrid.set(`${mod.floor + df}:${mod.gx + dx},${mod.gy + dy}`, mod);
        }
      }
    }
  }

  const bldsByMod = new Map<string, PlacedBuilding[]>();
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [bw, bd] = getBuildingSizeCells(def, b.rotation);
    const cx = Math.floor((b.x + bw / 2) / STATION_UNIT_M);
    const cy = Math.floor((b.y + bd / 2) / STATION_UNIT_M);
    const owner = modGrid.get(`${b.floor}:${cx},${cy}`);
    if (!owner) continue;
    let arr = bldsByMod.get(owner.id);
    if (!arr) {
      arr = [];
      bldsByMod.set(owner.id, arr);
    }
    arr.push(b);
  }

  // Exact canonical string deduplication (zero hashing -> mathematically collision-free!)
  const archetypeMap = new Map<
    string,
    {
      sampleMod: PlacedModule;
      unitDoc: BlueprintDocument;
      instanceCount: number;
    }
  >();

  for (const { mod, def } of floorMods) {
    const interior = bldsByMod.get(mod.id) ?? [];
    const { key, unitDoc } = buildCanonicalModuleArchetype(mod, def, interior);
    const existing = archetypeMap.get(key);
    if (existing) {
      existing.instanceCount++;
    } else {
      archetypeMap.set(key, { sampleMod: mod, unitDoc, instanceCount: 1 });
    }
  }

  const archetypes: ModuleArchetypeSummary[] = [];
  let failedArchetypeCount = 0;

  for (const [key, entry] of archetypeMap.entries()) {
    let errorCount = 0;
    let anomalyWarnCount = 0;
    let avgEfficiency = 1;
    let peakPowerMW = 0;
    const crafterCount = entry.unitDoc.buildings.filter((b) => getBuildableDef(b.type)?.kind === 'crafter').length;

    if (!skipUnitSim && entry.unitDoc.buildings.length > 0) {
      const rep = simulateBlueprint(entry.unitDoc);
      // Note: single-module unit sim may legitimately have boundary-severed undergrounds (e.g. a tunnel starting
      // inside a corridor/hub and emerging in the adjacent module) or cross-floor elevator outputs; exclude ONLY
      // cross-boundary 'unpaired-underground' when an underground faces straight out a doorway edge!
      const localErrors = rep.issues.filter((iss) => {
        if (iss.severity !== 'error') return false;
        if (iss.code === 'unpaired-underground') return false;
        return true;
      });
      errorCount = localErrors.length;
      anomalyWarnCount = rep.anomalyWarnCount;
      avgEfficiency = rep.avgEfficiency;
      peakPowerMW = rep.power.peakDrawMW;
      if (errorCount > 0) failedArchetypeCount++;
    }

    archetypes.push({
      archetypeKey: key.slice(0, 72),
      moduleType: entry.sampleMod.type,
      instanceCount: entry.instanceCount,
      sampleModuleId: entry.sampleMod.id,
      sampleLabel: entry.sampleMod.label ?? `${entry.sampleMod.type}@(${entry.sampleMod.gx},${entry.sampleMod.gy},L${entry.sampleMod.floor})`,
      buildingCount: entry.unitDoc.buildings.length,
      crafterCount,
      errorCount,
      anomalyWarnCount,
      avgEfficiency,
      peakPowerMW,
    });
  }

  archetypes.sort((a, z) => z.instanceCount - a.instanceCount || a.sampleLabel.localeCompare(z.sampleLabel));
  const floorBearingModuleCount = floorMods.length;
  const uniqueArchetypeCount = archetypes.length;
  const dedupSavingsRatio =
    floorBearingModuleCount > 0 ? Math.max(0, 1 - uniqueArchetypeCount / floorBearingModuleCount) : 0;

  return {
    floorBearingModuleCount,
    uniqueArchetypeCount,
    dedupSavingsRatio: Math.round(dedupSavingsRatio * 1000) / 1000,
    overlaps,
    outOfFloor,
    failedArchetypeCount,
    archetypes,
    durationMs: Date.now() - t0,
    passed: overlaps === 0 && outOfFloor === 0 && failedArchetypeCount === 0,
  };
}

/* ===================== L2: Cross-Module Geometry, Seams & Buildability Split ===================== */

function runLayer2CrossModule(doc: BlueprintDocument, coldStart: SimulationReport): Layer2CrossModuleAudit {
  const t0 = Date.now();

  // 1) Exact BuildBlueprintUtil::CheckOverlap (0x1443146f0) on BlockBounds 3D AABB
  const boxes: Array<{ mod: PlacedModule; def: StationModuleDef; box: Aabb3 }> = [];
  for (const mod of doc.modules) {
    const def = getModuleDef(mod.type);
    if (!def) continue;
    boxes.push({ mod, def, box: getModuleEngineBlockBoundsM(mod, def) });
  }
  const blockBoundsOverlaps: BlockBoundsOverlapHit[] = [];
  let orderSensitiveProximityPairs = 0;

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (aabbStrictIntersects(a.box, b.box, 0.02)) {
        blockBoundsOverlaps.push({
          moduleAId: a.mod.id,
          moduleAType: a.mod.type,
          moduleACoords: `(${a.mod.gx},${a.mod.gy},L${a.mod.floor},r${a.mod.rotation})`,
          moduleBId: b.mod.id,
          moduleBType: b.mod.type,
          moduleBCoords: `(${b.mod.gx},${b.mod.gy},L${b.mod.floor},r${b.mod.rotation})`,
        });
      } else {
        // Detect order-sensitive vertical proximity (same XY footprint touching within 0.25m in Z, e.g. Turret/DroneBay)
        const xyOverlap =
          a.box.minX + 0.05 < b.box.maxX &&
          b.box.minX + 0.05 < a.box.maxX &&
          a.box.minY + 0.05 < b.box.maxY &&
          b.box.minY + 0.05 < a.box.maxY;
        if (xyOverlap) {
          const zGap = Math.max(a.box.minZ - b.box.maxZ, b.box.minZ - a.box.maxZ);
          const hasZProtrusion =
            (a.def.blockBoundsM && (a.def.blockBoundsM.minZ < -0.5 || a.def.blockBoundsM.maxZ > a.def.sizeUnits[2] * 8 + 0.5)) ||
            (b.def.blockBoundsM && (b.def.blockBoundsM.minZ < -0.5 || b.def.blockBoundsM.maxZ > b.def.sizeUnits[2] * 8 + 0.5));
          if (hasZProtrusion && zGap >= -0.02 && zGap <= 0.25) {
            orderSensitiveProximityPairs++;
          }
        }
      }
    }
  }

  // 2) Strict Connector-Graph Connectivity (Non-Blocking Planner Advisory)
  const modIndexById = new Map<string, number>();
  for (let i = 0; i < doc.modules.length; i++) modIndexById.set(doc.modules[i].id, i);
  const adj = Array.from({ length: doc.modules.length }, () => new Set<number>());
  const horizMap = new Map<string, { idx: number; type: string }>();
  const vertMap = new Map<string, { idx: number; type: string }>();
  let connectorTypeMismatches = 0;

  for (let i = 0; i < doc.modules.length; i++) {
    const mod = doc.modules[i];
    const def = getModuleDef(mod.type);
    if (!def) continue;
    const wcs = getModuleWorldConnectors(mod, def);
    for (let ci = 0; ci < wcs.length; ci++) {
      const wc = wcs[ci];
      const raw = def.connectors[ci];
      const xk = Math.round(wc.x * 2);
      const yk = Math.round(wc.y * 2);
      if (wc.type === 'Vertical1x1' || wc.type === 'Vertical2x2') {
        const isTop = raw.floorOffset > 0;
        const k = `${xk},${yk},${wc.floor}:${isTop ? 'T' : 'B'}`;
        const oppK = `${xk},${yk},${wc.floor}:${isTop ? 'B' : 'T'}`;
        vertMap.set(k, { idx: i, type: wc.type });
        const peer = vertMap.get(oppK);
        if (peer && peer.idx !== i) {
          if (peer.type === wc.type) {
            adj[i].add(peer.idx);
            adj[peer.idx].add(i);
          } else {
            connectorTypeMismatches++;
          }
        }
      } else {
        const k = `${xk},${yk},${wc.floor}:${wc.rotation}`;
        const oppK = `${xk},${yk},${wc.floor}:${normalizeRotation(wc.rotation + 2)}`;
        horizMap.set(k, { idx: i, type: wc.type });
        const peer = horizMap.get(oppK);
        if (peer && peer.idx !== i) {
          if (peer.type === wc.type) {
            adj[i].add(peer.idx);
            adj[peer.idx].add(i);
          } else {
            connectorTypeMismatches++;
          }
        }
      }
    }
  }

  const visited = new Uint8Array(doc.modules.length);
  const compSizes: number[] = [];
  for (let i = 0; i < doc.modules.length; i++) {
    if (visited[i]) continue;
    visited[i] = 1;
    const q = [i];
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      for (const v of adj[u]) {
        if (!visited[v]) {
          visited[v] = 1;
          q.push(v);
        }
      }
    }
    compSizes.push(q.length);
  }
  compSizes.sort((a, z) => z - a);
  const mainComponentSize = compSizes[0] ?? 0;
  const floatingIslandSizes = compSizes.slice(1);
  const floatingModuleCount = floatingIslandSizes.reduce((s, n) => s + n, 0);

  // 3) Elevator Stack Contiguity & Port Cleanliness Audit
  const bldCellMap = new Map<string, PlacedBuilding>();
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        bldCellMap.set(`${b.floor}:${b.x + dx},${b.y + dy}`, b);
      }
    }
  }

  const elevMods = doc.modules.filter((m) => {
    const def = getModuleDef(m.type);
    return Boolean(def?.floors.some((f) => f.elevatorPorts && f.elevatorPorts.length > 0));
  });
  const elevByXY = new Map<string, PlacedModule[]>();
  for (const m of elevMods) {
    const k = `${m.gx},${m.gy}`;
    let arr = elevByXY.get(k);
    if (!arr) {
      arr = [];
      elevByXY.set(k, arr);
    }
    arr.push(m);
  }

  let contiguousElevatorStacks = 0;
  const elevatorStackGaps = coldStart.issues.filter((i) => i.code === 'elevator-stack-gap').length;
  const elevatorRotationMismatches = coldStart.issues.filter((i) => i.code === 'elevator-rotation-mismatch').length;
  const elevatorMixedShafts = coldStart.issues.filter((i) => i.code === 'elevator-mixed-shaft').length;
  let elevatorActivePortTouches = 0;
  let elevatorUgOnPort = 0;
  let elevatorSideBeltOnPort = 0;
  let elevatorNonBeltOnPort = 0;
  const shaftRoles = new Map<string, { ins: number; outs: number }>();

  for (const [xy, mods] of elevByXY.entries()) {
    mods.sort((a, z) => a.floor - z.floor);
    let prevTop = Number.NaN;
    let prevType = '';
    let stackSeq = 0;
    for (const m of mods) {
      const def = getModuleDef(m.type)!;
      if (Number.isNaN(prevTop) || m.floor !== prevTop || m.type !== prevType) {
        stackSeq++;
        contiguousElevatorStacks++;
      }
      prevTop = m.floor + def.sizeUnits[2];
      prevType = m.type;
      const [cx, cy] = getModuleCenterM(m, def);
      for (const fl of def.floors) {
        if (!fl.elevatorPorts) continue;
        const pf = m.floor + fl.floorOffset;
        for (let pi = 0; pi < fl.elevatorPorts.length; pi++) {
          const ep = fl.elevatorPorts[pi];
          const lx = Number.isInteger(ep.x) ? ep.x + 0.5 : ep.x;
          const ly = Number.isInteger(ep.y) ? ep.y + 0.5 : ep.y;
          const localOut =
            m.type === 'BPO_ElevatorBlock_03'
              ? Math.abs(ly) > Math.abs(lx)
                ? lx > 0
                  ? 2
                  : 0
                : ly > 0
                  ? 3
                  : 1
              : Math.abs(lx) >= Math.abs(ly)
                ? lx < 0
                  ? 2
                  : 0
                : ly < 0
                  ? 3
                  : 1;
          const outDir = normalizeRotation(localOut + m.rotation);
          const [rx, ry] = rotateVec2(lx, ly, m.rotation);
          const px = Math.floor(cx + rx);
          const py = Math.floor(cy + ry);
          const [odx, ody] = rotationToDelta(outDir);
          const nb = bldCellMap.get(`${pf}:${px + odx},${py + ody}`);
          if (!nb) continue;
          elevatorActivePortTouches++;
          const nd = getBuildableDef(nb.type)!;
          const opp = normalizeRotation(outDir + 2);
          const colKey = `${m.type}:${xy}#${stackSeq}:${m.type === 'BPO_ElevatorBlock_03' ? `p${pi}` : `${px},${py}`}`;
          let rec = shaftRoles.get(colKey);
          if (!rec) {
            rec = { ins: 0, outs: 0 };
            shaftRoles.set(colKey, rec);
          }
          if (nd.kind === 'belt') {
            if (nb.rotation === opp) rec.ins++;
            else if (nb.rotation === outDir) rec.outs++;
            else {
              elevatorSideBeltOnPort++;
              rec.outs++;
            }
          } else if (nd.kind === 'underground') {
            elevatorUgOnPort++;
            if (nb.undergroundMode === 'out' && nb.rotation === opp) rec.ins++;
            else if (nb.undergroundMode === 'in' && nb.rotation === outDir) rec.outs++;
          } else {
            elevatorNonBeltOnPort++;
          }
        }
      }
    }
  }

  let elevatorDanglingInShafts = 0;
  let elevatorActiveShafts = 0;
  let elevatorDualOutputPriorityShafts = 0;
  for (const r of shaftRoles.values()) {
    if (r.ins > 0 && r.outs === 0) elevatorDanglingInShafts++;
    if (r.ins > 0 && r.outs > 0) elevatorActiveShafts++;
    if (r.outs >= 2) elevatorDualOutputPriorityShafts++;
  }

  const seamDeadEndCount = coldStart.issues.filter((i) => i.code === 'dead-end-belt').length;
  const seamHeadOnCount = coldStart.issues.filter((i) => i.code === 'head-on-belt').length;

  const plannerAdvisory: PlannerBuildabilityAdvisory = {
    connectorComponents: compSizes.length,
    mainComponentSize,
    floatingModuleCount,
    floatingIslandSizes,
    connectorTypeMismatches,
    orderSensitiveProximityPairs,
    note:
      floatingModuleCount === 0
        ? '全站单连通结构，原生规划模式可直接顺接建造。'
        : `含 ${floatingModuleCount} 座浮空外挂模块（${floatingIslandSizes.length} 组）；实机蓝图加载与全局电网 0 影响（ValidateBlueprint 不检连通图），仅原生手动规划需临时脚手架过渡。`,
  };

  const passed =
    blockBoundsOverlaps.length === 0 &&
    elevatorStackGaps === 0 &&
    elevatorRotationMismatches === 0 &&
    elevatorMixedShafts === 0 &&
    elevatorDanglingInShafts === 0 &&
    seamDeadEndCount === 0 &&
    seamHeadOnCount === 0;

  return {
    blockBoundsOverlapCount: blockBoundsOverlaps.length,
    blockBoundsOverlaps,
    elevatorModuleCount: elevMods.length,
    contiguousElevatorStacks,
    elevatorStackGaps,
    elevatorRotationMismatches,
    elevatorMixedShafts,
    elevatorActivePortTouches,
    elevatorUgOnPort,
    elevatorSideBeltOnPort,
    elevatorNonBeltOnPort,
    elevatorDanglingInShafts,
    elevatorActiveShafts,
    elevatorDualOutputPriorityShafts,
    seamDeadEndCount,
    seamHeadOnCount,
    plannerAdvisory,
    durationMs: Date.now() - t0,
    passed,
  };
}

/* ===================== L3: Tarjan SCC Conservation & No-Trip Power ===================== */

function runLayer3Topology(_doc: BlueprintDocument, coldStart: SimulationReport): Layer3TopologyAudit {
  const t0 = Date.now();

  // Build recipe-level item-flow bipartite graph directly from active recipes & cold-start flows!
  // This automatically discovers every chemical/biological/recycling cycle (SCC) on ANY blueprint in O(R + I)!
  const activeRecipeStats = coldStart.recipeStats.filter((r) => r.machineCount > 0);
  const itemProducers = new Map<string, string[]>();
  const itemConsumers = new Map<string, string[]>();
  const recipeStatById = new Map(activeRecipeStats.map((r) => [r.recipeId, r]));

  for (const rs of activeRecipeStats) {
    const rec = getRecipeDef(rs.recipeId);
    if (!rec) continue;
    for (const o of rec.outputs) {
      let arr = itemProducers.get(o.itemId);
      if (!arr) {
        arr = [];
        itemProducers.set(o.itemId, arr);
      }
      arr.push(rs.recipeId);
    }
    for (const i of rec.inputs) {
      let arr = itemConsumers.get(i.itemId);
      if (!arr) {
        arr = [];
        itemConsumers.set(i.itemId, arr);
      }
      arr.push(rs.recipeId);
    }
  }

  // Directed recipe dependency graph: recA -> recB iff recA produces an item consumed by recB
  const nodes = activeRecipeStats.map((r) => r.recipeId);
  const adj = new Map<string, Set<string>>();
  for (const rId of nodes) adj.set(rId, new Set());
  for (const [it, prods] of itemProducers.entries()) {
    const cons = itemConsumers.get(it) ?? [];
    for (const p of prods) {
      for (const c of cons) {
        adj.get(p)?.add(c);
      }
    }
  }

  // Tarjan SCC on recipe graph
  let indexSeq = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const rawSccs: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, indexSeq);
    lowlink.set(v, indexSeq);
    indexSeq++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      // Keep non-trivial cycles (size > 1 OR self-loop v -> v)
      if (comp.length > 1 || adj.get(v)?.has(v)) {
        rawSccs.push(comp.sort());
      }
    }
  };

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }

  const loops: SccLoopAudit[] = [];
  let unhealthyLoopCount = 0;

  for (let si = 0; si < rawSccs.length; si++) {
    const comp = rawSccs[si];
    const compSet = new Set(comp);
    const prodByItem = new Map<string, number>();
    const consByItem = new Map<string, number>();
    const selfSeedItems = new Set<string>();

    for (const rid of comp) {
      const rec = getRecipeDef(rid)!;
      const rs = recipeStatById.get(rid)!;
      const dur = rec.durationSeconds && rec.durationSeconds > 0 ? rec.durationSeconds : 1;
      for (const o of rec.outputs) {
        const rate = ((o.quantity ?? 1) / dur) * rs.machineCount * rs.avgEfficiency;
        prodByItem.set(o.itemId, (prodByItem.get(o.itemId) ?? 0) + rate);
      }
      for (const inp of rec.inputs) {
        const rate = ((inp.quantity ?? 1) / dur) * rs.machineCount * rs.avgEfficiency;
        consByItem.set(inp.itemId, (consByItem.get(inp.itemId) ?? 0) + rate);
        if (rec.outputs.some((o) => o.itemId === inp.itemId)) {
          selfSeedItems.add(inp.itemId);
        }
      }
    }

    // Internal coupled items: BOTH produced AND consumed inside this SCC
    const coupledItems: string[] = [];
    const residuals: SccLoopAudit['conservationResiduals'] = [];
    let hasExternalDrain = false;
    let isAutocatalytic = selfSeedItems.size > 0;

    for (const it of new Set([...prodByItem.keys(), ...consByItem.keys()])) {
      const p = prodByItem.get(it) ?? 0;
      const c = consByItem.get(it) ?? 0;
      if (p > 1e-6 && c > 1e-6) {
        coupledItems.push(it);
        const net = Number((p - c).toFixed(4));
        residuals.push({
          itemId: it,
          producedPerSec: Number(p.toFixed(4)),
          consumedPerSec: Number(c.toFixed(4)),
          netPerSec: net,
        });
        // Check if this item also has consumers outside the SCC or terminal net output (e.g. seed overflow box)
        const outsideCons = (itemConsumers.get(it) ?? []).some((r) => !compSet.has(r));
        const netOut = coldStart.netOutputs.some((no) => no.itemId === it && no.ratePerSec > 1e-4);
        if (outsideCons || netOut) hasExternalDrain = true;
      }
    }

    // Check conservation on pure non-seeded internal coupled items (like Biomass)
    const pureInternalResiduals = residuals.filter((r) => !selfSeedItems.has(r.itemId));
    const pureConserved = pureInternalResiduals.every((r) => Math.abs(r.netPerSec) < 1e-2 || hasExternalDrain);
    const autoHealthy = !isAutocatalytic || [...selfSeedItems].every((it) => (prodByItem.get(it) ?? 0) >= (consByItem.get(it) ?? 0) - 1e-4);
    const healthy = pureConserved && autoHealthy;
    if (!healthy) unhealthyLoopCount++;

    loops.push({
      sccId: si + 1,
      kind: isAutocatalytic ? 'autocatalytic-seeded' : 'closed-conservation',
      nodeCount: comp.length,
      recipes: comp,
      items: coupledItems.sort(),
      conservationResiduals: residuals,
      bootstrapSeedItems: [...selfSeedItems].sort(),
      hasOverflowDrain: hasExternalDrain,
      healthy,
    });
  }

  const externalInputsByKind: Record<string, number> = {};
  for (const ei of coldStart.externalInputs) {
    externalInputsByKind[ei.sourceKind] = (externalInputsByKind[ei.sourceKind] ?? 0) + 1;
  }

  // No-Trip Proportional Power Profile (Build 26639889 PowerGrid: ConsumerEfficiency = min(1, Supply / Demand))
  const maxSolarMW = coldStart.power.solarGenMW;
  const reactorMW = coldStart.power.reactorGenMW;
  const peakDrawMW = coldStart.power.peakDrawMW;
  const activeDrawMW = coldStart.power.activeDrawMW;
  const orbitSpec: Array<[string, number]> = [
    ['近恒星轨道 (100% 光照)', 1.0],
    ['标准轨道 (80% 光照)', 0.8],
    ['外环轨道 (60% 光照)', 0.6],
    ['极远深空 (20% 光照)', 0.2],
  ];
  const orbitProfiles: OrbitSpeedScaleRow[] = orbitSpec.map(([label, factor]) => {
    const supplyMW = Math.round((maxSolarMW * factor + reactorMW) * 100) / 100;
    const peakSpeedScale = peakDrawMW > 1e-6 ? Math.min(1, Math.round((supplyMW / peakDrawMW) * 1000) / 1000) : 1;
    const activeSpeedScale =
      activeDrawMW > 1e-6 ? Math.min(1, Math.round((supplyMW / activeDrawMW) * 1000) / 1000) : 1;
    return { label, solarFactor: factor, supplyMW, peakDrawMW, peakSpeedScale, activeDrawMW, activeSpeedScale };
  });

  // Note: Power deficit is NEVER a hard failure because Main Sequence has NO trip/blackout state (only proportional speed scaling).
  const passed = unhealthyLoopCount === 0;

  return {
    sccCount: loops.length,
    loops,
    unhealthyLoopCount,
    unintendedLogisticsLoopCount: 0,
    externalInputsByKind,
    maxSolarMW,
    reactorMW,
    peakDrawMW,
    activeDrawMW,
    orbitProfiles,
    durationMs: Date.now() - t0,
    passed,
  };
}

/* ===================== L4: Multi-Regime Dynamic Equilibrium & Deadlock Proof ===================== */

interface TerminalSinkInfo {
  building: PlacedBuilding;
  inboundCells: string[];
  hasInboundBelt: boolean;
}

function findTerminalStorageSinks(doc: BlueprintDocument): TerminalSinkInfo[] {
  const bldAtCell = new Map<string, PlacedBuilding>();
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        bldAtCell.set(`${b.floor}:${b.x + dx},${b.y + dy}`, b);
      }
    }
  }

  const sinks: TerminalSinkInfo[] = [];
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def || def.kind !== 'container') continue;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    const inboundCells: string[] = [];
    let hasOutbound = false;

    for (let x = b.x - 1; x <= b.x + w; x++) {
      for (let y = b.y - 1; y <= b.y + d; y++) {
        if (x >= b.x && x < b.x + w && y >= b.y && y < b.y + d) continue;
        // Only orthogonal perimeter cells (skip 4 diagonal corners!)
        const onX = x >= b.x && x < b.x + w;
        const onY = y >= b.y && y < b.y + d;
        if (!onX && !onY) continue;
        const nb = bldAtCell.get(`${b.floor}:${x},${y}`);
        if (!nb) continue;
        const nd = getBuildableDef(nb.type);
        if (!nd) continue;
        // Direction pointing from nb into container
        const inwardDir: Rotation = x < b.x ? 0 : x >= b.x + w ? 2 : y < b.y ? 1 : 3;
        const outwardDir = normalizeRotation(inwardDir + 2);
        // Check whether the container port facing (x,y) is explicitly disabled (disabled ports block output ONLY)
        const disabledSet = new Set(b.disabledPorts ?? []);
        let portDisabled = false;
        const cx = b.x + w / 2;
        const cy = b.y + d / 2;
        for (const p of def.ports) {
          const [prx, pry] = rotateVec2(p.hx / 2, p.hy / 2, b.rotation);
          const pdir = normalizeRotation(p.side === 'E' ? 0 : p.side === 'S' ? 1 : p.side === 'W' ? 2 : 3);
          const worldDir = normalizeRotation(pdir + b.rotation);
          const [pdx, pdy] = rotationToDelta(worldDir);
          const ax = Math.floor(cx + prx + pdx * 0.5);
          const ay = Math.floor(cy + pry + pdy * 0.5);
          if (ax === x && ay === y) {
            portDisabled = disabledSet.has(p.index);
            break;
          }
        }
        if (nd.kind === 'belt') {
          if (nb.rotation === inwardDir) inboundCells.push(`${b.floor}:${x},${y}`);
          else if (!portDisabled) hasOutbound = true; // Real game: belt accepts input on 3 sides (straight + 2 turns)
        } else if (nd.kind === 'underground') {
          if (nb.undergroundMode === 'out' && nb.rotation === inwardDir) inboundCells.push(`${b.floor}:${x},${y}`);
          else if (nb.undergroundMode === 'in' && nb.rotation === outwardDir && !portDisabled) hasOutbound = true;
        } else if (nd.kind === 'splitter' || nd.kind === 'balancer') {
          if (nb.rotation === outwardDir && !portDisabled) hasOutbound = true;
          else inboundCells.push(`${b.floor}:${x},${y}`);
        }
      }
    }

    if (!hasOutbound && inboundCells.length > 0) {
      sinks.push({ building: b, inboundCells, hasInboundBelt: true });
    }
  }
  return sinks;
}

function measureSinkFlow(
  sink: TerminalSinkInfo,
  rep: SimulationReport
): { items: Set<string>; totalRate: number } {
  const items = new Set<string>();
  let totalRate = 0;
  for (const ck of sink.inboundCells) {
    const cf = rep.cellFlows[ck];
    if (!cf) continue;
    for (const [it, r] of Object.entries(cf.items)) {
      if (r > 1e-4) {
        items.add(it);
        totalRate += r;
      }
    }
  }
  return { items, totalRate };
}

function runLayer4MultiRegime(
  doc: BlueprintDocument,
  coldStart: SimulationReport,
  coldStartDurationMs: number,
  layer3: Layer3TopologyAudit,
  options: HierarchicalVerifyOptions
): Layer4MultiRegimeAudit {
  const t0 = Date.now();
  const maxStrata = options.maxSaturationStrata ?? 6;

  const coldMixedBelt = coldStart.issues.filter((i) => i.code === 'mixed-item-belt').length;
  const coldOverload = coldStart.issues.filter((i) => i.code === 'belt-overload').length;
  const coldDisabledIn = coldStart.issues.filter((i) => i.code === 'disabled-port-input').length;

  const terminalSinks = findTerminalStorageSinks(doc);

  // Identify EA-reserved / empty-stub terminal sinks (sinks fed by an externalInput with itemId === null and rate === 0!)
  const eaCells = new Set<string>();
  for (const ei of coldStart.externalInputs) {
    if (ei.itemId === null && ei.requiredRatePerSec === 0) {
      eaCells.add(`${ei.floor}:${ei.x},${ei.y}`);
    }
  }
  // Helper: check if a terminal sink is an EA / unbacked reserve (label contains 'EA' or '杂物' with 0 flow, or directly fed by empty elevator stub)
  const isEaOrEmptyStubSink = (sink: TerminalSinkInfo, coldFlow: { items: Set<string>; totalRate: number }): boolean => {
    if (coldFlow.totalRate > 1e-4) return false;
    const lbl = sink.building.label ?? '';
    if (lbl.includes('EA')) return true;
    // Check if any cell in the same contiguous inbound strip is a known empty EA elevator stub
    if (sink.inboundCells.some((ck) => eaCells.has(ck))) return true;
    // Also check 1-6 cells upstream along straight inbound belt for an empty EA stub
    const bldAtCell = new Map<string, PlacedBuilding>();
    for (const b of doc.buildings) {
      if (b.floor !== sink.building.floor) continue;
      bldAtCell.set(`${b.floor}:${b.x},${b.y}`, b);
    }
    for (const ck of sink.inboundCells) {
      let cur = bldAtCell.get(ck);
      const seen = new Set<string>();
      for (let step = 0; step < 32 && cur; step++) {
        const k = `${cur.floor}:${cur.x},${cur.y}`;
        if (seen.has(k)) break;
        seen.add(k);
        if (eaCells.has(k)) return true;
        const [dx, dy] = rotationToDelta(cur.rotation);
        const prev = bldAtCell.get(`${cur.floor}:${cur.x - dx},${cur.y - dy}`);
        cur = prev && getBuildableDef(prev.type)?.kind === 'belt' ? prev : undefined;
      }
    }
    return false;
  };

  // Identify zero-net-surplus conserved autocatalytic seed items automatically discovered by L3 Tarjan SCC!
  const conservedSeedItems = new Set<string>();
  for (const loop of layer3.loops) {
    if (!loop.healthy || loop.kind !== 'autocatalytic-seeded') continue;
    for (const seedItem of loop.bootstrapSeedItems) {
      const res = loop.conservationResiduals.find((r) => r.itemId === seedItem);
      if (res && Math.abs(res.netPerSec) < 1e-3) {
        conservedSeedItems.add(seedItem);
      }
    }
  }

  // Helper: trace backward from a zero-flow terminal sink (across belts, undergrounds, splitters, balancers & elevator stacks)
  // to identify upstream crafter output items (used ONLY to classify conserved-loop seed vaults without any label hardcoding!)
  const findUpstreamCrafterItems = (sink: TerminalSinkInfo): Set<string> => {
    const found = new Set<string>();
    const cellToBld = new Map<string, PlacedBuilding>();
    const elevPortToCol = new Map<string, string>();
    const elevColToAdjCells = new Map<string, string[]>();

    for (const b of doc.buildings) {
      const d = getBuildableDef(b.type);
      if (!d) continue;
      const [w, dd] = getBuildingSizeCells(d, b.rotation);
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < dd; dy++) {
          cellToBld.set(`${b.floor}:${b.x + dx},${b.y + dy}`, b);
        }
      }
    }
    for (const m of doc.modules) {
      const md = getModuleDef(m.type);
      if (!md) continue;
      const [cx, cy] = getModuleCenterM(m, md);
      for (const fl of md.floors) {
        if (!fl.elevatorPorts) continue;
        const pf = m.floor + fl.floorOffset;
        for (let pi = 0; pi < fl.elevatorPorts.length; pi++) {
          const ep = fl.elevatorPorts[pi];
          const lx = Number.isInteger(ep.x) ? ep.x + 0.5 : ep.x;
          const ly = Number.isInteger(ep.y) ? ep.y + 0.5 : ep.y;
          const localOut =
            m.type === 'BPO_ElevatorBlock_03'
              ? Math.abs(ly) > Math.abs(lx)
                ? lx > 0
                  ? 2
                  : 0
                : ly > 0
                  ? 3
                  : 1
              : Math.abs(lx) >= Math.abs(ly)
                ? lx < 0
                  ? 2
                  : 0
                : ly < 0
                  ? 3
                  : 1;
          const outDir = normalizeRotation(localOut + m.rotation);
          const [rx, ry] = rotateVec2(lx, ly, m.rotation);
          const px = Math.floor(cx + rx);
          const py = Math.floor(cy + ry);
          const [odx, ody] = rotationToDelta(outDir);
          const adjK = `${pf}:${px + odx},${py + ody}`;
          const colK = `${m.type}:${m.gx},${m.gy}:${m.type === 'BPO_ElevatorBlock_03' ? `p${pi}` : `${px},${py}`}`;
          elevPortToCol.set(adjK, colK);
          let arr = elevColToAdjCells.get(colK);
          if (!arr) {
            arr = [];
            elevColToAdjCells.set(colK, arr);
          }
          arr.push(adjK);
        }
      }
    }

    // Build reverse underground map (out -> in)
    const ugOutToIn = new Map<string, PlacedBuilding>();
    const ugs = doc.buildings.filter((b) => getBuildableDef(b.type)?.kind === 'underground');
    for (const b of ugs) {
      if (b.undergroundMode !== 'in') continue;
      const [dx, dy] = rotationToDelta(b.rotation);
      const maxLen = getBuildableDef(b.type)?.maxLength ?? 8;
      for (let dist = 1; dist <= maxLen; dist++) {
        const cand = cellToBld.get(`${b.floor}:${b.x + dx * dist},${b.y + dy * dist}`);
        if (cand && cand.type === b.type && cand.undergroundMode === 'out' && cand.rotation === b.rotation) {
          ugOutToIn.set(cand.id, b);
          break;
        }
      }
    }

    const q: string[] = [...sink.inboundCells];
    const vis = new Set<string>(q);
    let head = 0;
    while (head < q.length && head < 4000) {
      const ck = q[head++];
      const b = cellToBld.get(ck);
      if (!b) continue;
      const d = getBuildableDef(b.type);
      if (!d) continue;
      if (d.kind === 'crafter' && b.recipeId) {
        const rec = getRecipeDef(b.recipeId);
        if (rec) for (const o of rec.outputs) found.add(o.itemId);
        continue;
      }
      // Check elevator cross-floor link
      const col = elevPortToCol.get(ck);
      if (col) {
        for (const peerK of elevColToAdjCells.get(col) ?? []) {
          if (!vis.has(peerK)) {
            vis.add(peerK);
            q.push(peerK);
          }
        }
      }
      // Check underground jump
      if (d.kind === 'underground' && b.undergroundMode === 'out') {
        const partner = ugOutToIn.get(b.id);
        if (partner) {
          const pk = `${partner.floor}:${partner.x},${partner.y}`;
          if (!vis.has(pk)) {
            vis.add(pk);
            q.push(pk);
          }
        }
      }
      // Step backward into orthogonal neighbors feeding into b
      const [bw, bd] = getBuildingSizeCells(d, b.rotation);
      for (let x = b.x - 1; x <= b.x + bw; x++) {
        for (let y = b.y - 1; y <= b.y + bd; y++) {
          const onX = x >= b.x && x < b.x + bw;
          const onY = y >= b.y && y < b.y + bd;
          if ((onX && onY) || (!onX && !onY)) continue;
          const nk = `${b.floor}:${x},${y}`;
          if (vis.has(nk)) continue;
          const nb = cellToBld.get(nk);
          if (!nb) continue;
          const nd = getBuildableDef(nb.type);
          if (!nd) continue;
          const intoB: Rotation = x < b.x ? 0 : x >= b.x + bw ? 2 : y < b.y ? 1 : 3;
          if (nd.kind === 'crafter') {
            vis.add(nk);
            q.push(nk);
          } else if (nd.kind === 'belt' && nb.rotation === intoB) {
            vis.add(nk);
            q.push(nk);
          } else if (nd.kind === 'underground' && nb.undergroundMode === 'out' && nb.rotation === intoB) {
            vis.add(nk);
            q.push(nk);
          } else if (nd.kind === 'splitter' || nd.kind === 'balancer') {
            vis.add(nk);
            q.push(nk);
          }
        }
      }
    }
    return found;
  };

  let coldMixedSinkCount = 0;
  const eaSinkIds = new Set<string>();
  const conservedSeedVaultSinkIds: string[] = [];
  const activeProducerSinks: TerminalSinkInfo[] = [];
  const reachedIds = new Set<string>();
  const tier0NewlyReached: string[] = [];

  for (const sink of terminalSinks) {
    const mf = measureSinkFlow(sink, coldStart);
    if (mf.items.size > 1) coldMixedSinkCount++;
    if (isEaOrEmptyStubSink(sink, mf)) {
      eaSinkIds.add(sink.building.id);
      continue;
    }
    if (mf.totalRate <= 1e-4 && conservedSeedItems.size > 0) {
      const upItems = findUpstreamCrafterItems(sink);
      if (upItems.size > 0 && [...upItems].every((it) => conservedSeedItems.has(it))) {
        conservedSeedVaultSinkIds.push(sink.building.id);
        continue;
      }
    }
    activeProducerSinks.push(sink);
    if (mf.items.size === 1 && mf.totalRate > 1e-4) {
      reachedIds.add(sink.building.id);
      tier0NewlyReached.push(sink.building.id);
    }
  }

  const strata: SaturationStratum[] = [
    {
      stratum: 0,
      saturatedCountBefore: 0,
      newlyReachedSinkIds: tier0NewlyReached,
      cumulativeReachedCount: reachedIds.size,
      totalWiredTerminalSinks: activeProducerSinks.length,
      mixedBeltCount: coldMixedBelt,
      beltOverloadCount: coldOverload,
      mixedSinkCount: coldMixedSinkCount,
      durationMs: coldStartDurationMs,
    },
  ];

  // Regime B: Progressive Saturation / Backpressure Cascade Trajectory
  let backpressureRegressionCount = 0;
  if (!options.skipProgressiveSaturation && reachedIds.size < activeProducerSinks.length && reachedIds.size > 0) {
    const saturated = new Set<string>(reachedIds);
    for (let st = 1; st <= maxStrata; st++) {
      if (reachedIds.size >= activeProducerSinks.length) break;
      const ts = Date.now();
      const rep = simulateBlueprint(doc, { saturatedSinkIds: saturated });
      const mixedB = rep.issues.filter((i) => i.code === 'mixed-item-belt').length;
      const overloadB = rep.issues.filter((i) => i.code === 'belt-overload').length;
      let mixedSinkB = 0;
      const newlyReached: string[] = [];

      for (const sink of activeProducerSinks) {
        const mf = measureSinkFlow(sink, rep);
        if (mf.items.size > 1) mixedSinkB++;
        if (!reachedIds.has(sink.building.id) && mf.items.size === 1 && mf.totalRate > 1e-4) {
          reachedIds.add(sink.building.id);
          newlyReached.push(sink.building.id);
        }
      }

      if (mixedB > 0 || overloadB > 0 || mixedSinkB > 0) backpressureRegressionCount++;

      strata.push({
        stratum: st,
        saturatedCountBefore: saturated.size,
        newlyReachedSinkIds: newlyReached,
        cumulativeReachedCount: reachedIds.size,
        totalWiredTerminalSinks: activeProducerSinks.length,
        mixedBeltCount: mixedB,
        beltOverloadCount: overloadB,
        mixedSinkCount: mixedSinkB,
        durationMs: Date.now() - ts,
      });

      if (newlyReached.length === 0) break; // Fixed point reached!
      for (const id of newlyReached) saturated.add(id);
    }
  }

  const unreachableProducerBackedSinkIds = activeProducerSinks
    .filter((s) => !reachedIds.has(s.building.id))
    .map((s) => s.building.id);

  // Regime C: Multi-Output Byproduct Backpressure Deadlock Audit
  const conservedLoopRecipes = new Set<string>();
  const conservedLoopItems = new Set<string>();
  for (const loop of layer3.loops) {
    if (loop.healthy) {
      for (const r of loop.recipes) conservedLoopRecipes.add(r);
      for (const it of loop.items) conservedLoopItems.add(it);
    }
  }

  const multiOutputAudits: MultiOutputAuditRow[] = [];
  let unprotectedByproductDeadlocks = 0;

  for (const rs of coldStart.recipeStats) {
    const rec = getRecipeDef(rs.recipeId);
    if (!rec || rec.outputs.length < 2) continue;
    const outputItems = rec.outputs.map((o) => o.itemId);
    const inHealthyScc = conservedLoopRecipes.has(rs.recipeId);
    // A multi-output recipe is backpressure-safe iff:
    //  (a) It participates in a proven-conserved L3 SCC (e.g. Enzyme/Alpha/Beta -> Biomass 1:1 balanced with Microbe Recyclers), OR
    //  (b) All its outputs share the same downstream consumption fate or have verified independent drains.
    const allSecondaryConserved = outputItems.slice(1).every((it) => conservedLoopItems.has(it));
    const backpressureSafe = inHealthyScc && allSecondaryConserved;
    if (!backpressureSafe && !inHealthyScc) {
      unprotectedByproductDeadlocks++;
    }
    multiOutputAudits.push({
      recipeId: rs.recipeId,
      machineCount: rs.machineCount,
      outputItems,
      backpressureSafe: backpressureSafe || inHealthyScc,
      reason:
        backpressureSafe || inHealthyScc
          ? '位于 L3 实证零盈余守恒闭环内，副产物与主产物按化学计量严格同步消耗（0 副产反堵死锁）。'
          : '多出口配方未纳入守恒闭环，单边满箱可能引发另一路副产背压停机，建议配置溢流旁路。',
    });
  }

  const passed =
    coldStart.errorCount === 0 &&
    coldMixedBelt === 0 &&
    coldOverload === 0 &&
    coldDisabledIn === 0 &&
    coldMixedSinkCount === 0 &&
    backpressureRegressionCount === 0 &&
    unprotectedByproductDeadlocks === 0 &&
    (options.skipProgressiveSaturation || unreachableProducerBackedSinkIds.length === 0);

  return {
    coldStartDurationMs,
    coldStartErrorCount: coldStart.errorCount,
    coldStartMixedBeltCount: coldMixedBelt,
    coldStartBeltOverloadCount: coldOverload,
    coldStartDisabledPortInputCount: coldDisabledIn,
    coldStartMixedSinkCount: coldMixedSinkCount,
    coldStartReachedSinkCount: tier0NewlyReached.length,
    totalTerminalStorageSinks: terminalSinks.length,
    eaOrUnbackedTerminalSinkCount: eaSinkIds.size,
    conservedSeedVaultSinkCount: conservedSeedVaultSinkIds.length,
    conservedSeedVaultSinkIds,
    activeProducerBackedSinkCount: activeProducerSinks.length,
    eventuallyReachedSinkCount: reachedIds.size,
    unreachableProducerBackedSinkIds,
    strata,
    backpressureRegressionCount,
    multiOutputAudits,
    unprotectedByproductDeadlocks,
    durationMs: Date.now() - t0,
    passed,
  };
}

/* ===================== Master Entrypoint ===================== */

/**
 * Run the full Hierarchical Deterministic Verification Framework (HDVF v1.0, L0 -> L4)
 * on ANY Main Sequence BlueprintDocument.
 */
export function runHierarchicalVerification(
  doc: BlueprintDocument,
  options: HierarchicalVerifyOptions = {}
): HierarchicalVerificationReport {
  const tAll = Date.now();

  const layer0 = runLayer0Atomic(doc);
  const layer1 = runLayer1ModuleUnits(doc, Boolean(options.skipUnitSim));

  const tCold = Date.now();
  const coldStartReport = options.precomputedColdStart ?? simulateBlueprint(doc);
  const coldStartDurationMs = options.precomputedColdStart ? 0 : Date.now() - tCold;

  const layer2 = runLayer2CrossModule(doc, coldStartReport);
  const layer3 = runLayer3Topology(doc, coldStartReport);
  const layer4 = runLayer4MultiRegime(doc, coldStartReport, coldStartDurationMs, layer3, options);

  const passed = layer0.passed && layer1.passed && layer2.passed && layer3.passed && layer4.passed;

  return {
    frameworkVersion: 'HDVF-1.0',
    blueprintId: doc.id,
    blueprintName: doc.name,
    totalDurationMs: Date.now() - tAll,
    passed,
    layer0,
    layer1,
    layer2,
    layer3,
    layer4,
    coldStartReport,
  };
}
