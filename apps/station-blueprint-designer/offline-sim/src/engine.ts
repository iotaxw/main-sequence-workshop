import { deserializeBlueprint } from '../../src/core/codec';
import { getBuildableDef, getItemNameZh, getModuleDef, getRecipeDef } from '../../src/core/catalog';
import {
  computeUndergroundLinks,
  getBuildingSizeCells,
  getModuleBoundsM,
  isCellBuildable,
} from '../../src/core/geometry';
import { simulateBlueprint } from '../../src/core/simulation';
import type { BlueprintDocument, PlacedBuilding, PlacedModule } from '../../src/core/types';

export interface RoomSimSummary {
  id: string;
  label: string;
  floor: number;
  floorLabel: string;
  gx: number;
  gy: number;
  kind: 'production' | 'hub';
  buildingCount: number;
  machineCount: number;
  avgEfficiency: number;
  powerPeakMW: number;
  powerActiveMW: number;
  outputs: Array<{ itemId: string; nameZh: string; ratePerSec: number }>;
  inputs: Array<{ itemId: string; nameZh: string; ratePerSec: number }>;
  errors: string[];
  anomalyWarns: string[];
}

export interface SeamSimSummary {
  name: string;
  floor: number;
  moduleCount: number;
  buildingCount: number;
  totalErrors: number;
  seamFaults: string[];
  avgEfficiency: number;
}

export interface ItemBalanceRow {
  itemId: string;
  nameZh: string;
  producedPerSec: number;
  consumedAllOnPerSec: number;
  netAllOnPerSec: number;
  /** True when the item is never produced inside the station (pure raw/imported input) */
  externalOnly: boolean;
  /** Estimated minutes to refill a 320-stack Container_2 (approx 8,000 items @ stack=25) at single-cell steady output */
  estRefillMinAt25Stack: number | null;
  producers: Array<{ room: string; ratePerSec: number }>;
  consumers: Array<{ room: string; ratePerSec: number }>;
}

export interface OrbitPowerRow {
  orbitLabel: string;
  solarEfficiency: number;
  solarGenMW: number;
  netVsCombatPeakMW: number;
  netVsPeacetimePeakMW: number;
  netVsMall25PctMW: number;
}

export interface FullStationPowerSummary {
  solarMk2Count: number;
  solarMk3Count: number;
  observatoryCount: number;
  turretCount: number;
  teleporterCount: number;
  maxSolarMW: number;
  minSolarMW: number;
  b1CrafterPeakMW: number;
  f1CrafterPeakMW: number;
  facilityPeakMW: number;
  turretPeakMW: number;
  peacetimePeakMW: number;
  combatPeakMW: number;
  mallTypical25PctMW: number;
  orbits: OrbitPowerRow[];
}

export interface StructuralIntegritySummary {
  moduleCount: number;
  buildingCount: number;
  occupiedCells: number;
  undergroundBelts: number;
  pairedUndergroundLinks: number;
  overlaps: number;
  outOfFloor: number;
  invalidRecipes: number;
  outwardTurretCount: number;
  turretsValid: boolean;
}

export interface FullStationSimReport {
  generatedAt: string;
  blueprintName: string;
  blueprintId: string;
  passed: boolean;
  productionRooms: RoomSimSummary[];
  hubRooms: RoomSimSummary[];
  seams: SeamSimSummary[];
  itemBalances: ItemBalanceRow[];
  externalInputs: ItemBalanceRow[];
  power: FullStationPowerSummary;
  integrity: StructuralIntegritySummary;
}

function floorName(floor: number): string {
  if (floor === 0) return 'B1 (L0)';
  if (floor === 2) return 'F1 (L2)';
  if (floor === 4) return 'F2 (L4)';
  return `L${floor}`;
}

export function extractModuleSlice(doc: BlueprintDocument, mods: PlacedModule[]): BlueprintDocument {
  const boxes = mods.map((m) => {
    const def = getModuleDef(m.type)!;
    const [minX, minY, maxX, maxY] = getModuleBoundsM(m, def);
    return { floor: m.floor, minX, minY, maxX, maxY };
  });
  const buildings: PlacedBuilding[] = [];
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    const cx = b.x + w / 2;
    const cy = b.y + d / 2;
    if (boxes.some((bx) => bx.floor === b.floor && cx >= bx.minX && cx < bx.maxX && cy >= bx.minY && cy < bx.maxY)) {
      buildings.push(b);
    }
  }
  return {
    ...doc,
    id: `slice_${mods.map((m) => m.id).join('_')}`,
    name: mods.map((m) => m.label ?? m.type).join(' + '),
    modules: mods,
    buildings,
  };
}

export function parseBlueprintJson(rawJson: string): BlueprintDocument {
  const decoded = deserializeBlueprint(rawJson);
  if (!decoded.ok) {
    throw new Error(`Invalid blueprint JSON: ${decoded.error}`);
  }
  return decoded.doc;
}

/**
 * Runs the 5-pass offline full-station verification engine directly on a complete multi-deck blueprint.
 * Reuses the exact same physical simulation kernel (`simulateBlueprint`) as the workbench UI.
 */
export function runOfflineFullStationSimulation(doc: BlueprintDocument): FullStationSimReport {
  // -------------------- PASS 1: Per-Room Real-Physics Simulation --------------------
  const f2BoutiquePrefixes = ['F2 北商业街', 'F2 东商业街', 'F2 西商业街', 'F2 南商业街'];
  const visitedIds = new Set<string>();
  const roomSlices: Array<{ label: string; floor: number; gx: number; gy: number; mods: PlacedModule[]; slice: BlueprintDocument }> = [];

  for (const prefix of f2BoutiquePrefixes) {
    const pair = doc.modules.filter((m) => m.floor === 4 && (m.label ?? '').startsWith(prefix));
    if (pair.length > 0) {
      pair.forEach((m) => visitedIds.add(m.id));
      roomSlices.push({
        label: `${prefix} (双段12大箱)`,
        floor: 4,
        gx: pair[0].gx,
        gy: pair[0].gy,
        mods: pair,
        slice: extractModuleSlice(doc, pair),
      });
    }
  }

  for (const m of doc.modules) {
    if (visitedIds.has(m.id)) continue;
    const def = getModuleDef(m.type);
    if (!def?.hasFactoryFloor) continue;
    const slice = extractModuleSlice(doc, [m]);
    if (slice.buildings.length === 0) continue;
    roomSlices.push({
      label: m.label ?? `${m.type}@(${m.gx},${m.gy},L${m.floor})`,
      floor: m.floor,
      gx: m.gx,
      gy: m.gy,
      mods: [m],
      slice,
    });
  }

  const productionRooms: RoomSimSummary[] = [];
  const hubRooms: RoomSimSummary[] = [];

  for (const rm of roomSlices) {
    const rep = simulateBlueprint(rm.slice);
    const errors = rep.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.code}@(${i.x},${i.y}): ${i.message}`);
    const anomalyWarns = rep.issues
      .filter((i) => i.severity === 'warn' && i.code !== 'external-input-needed' && i.code !== 'blueprint-output')
      .map((i) => `${i.code}@(${i.x},${i.y}): ${i.message}`);

    // Compute mass-conserved actual room inputs weighted by simulated steady-state efficiency
    // (avoids double-counting when a 1-input recipe is fed via parallel redundant dual belts in standard cells)
    const rawInMap = new Map<string, number>();
    const rawOutMap = new Map<string, number>();
    for (const rs of rep.recipeStats) {
      const rDef = getRecipeDef(rs.recipeId);
      if (!rDef || !rDef.durationSeconds) continue;
      const scale = rs.machineCount * rs.avgEfficiency;
      for (const inp of rDef.inputs) {
        rawInMap.set(inp.itemId, (rawInMap.get(inp.itemId) ?? 0) + (inp.quantity / rDef.durationSeconds) * scale);
      }
      for (const out of rDef.outputs) {
        rawOutMap.set(out.itemId, (rawOutMap.get(out.itemId) ?? 0) + (out.quantity / rDef.durationSeconds) * scale);
      }
    }
    const netInList: Array<{ itemId: string; nameZh: string; ratePerSec: number }> = [];
    for (const [itemId, inRate] of rawInMap) {
      const net = inRate - (rawOutMap.get(itemId) ?? 0);
      if (net > 1e-4) {
        netInList.push({ itemId, nameZh: getItemNameZh(itemId), ratePerSec: net });
      }
    }

    const summary: RoomSimSummary = {
      id: rm.mods.map((m) => m.id).join('+'),
      label: rm.label,
      floor: rm.floor,
      floorLabel: floorName(rm.floor),
      gx: rm.gx,
      gy: rm.gy,
      kind: rep.configuredMachineCount > 0 ? 'production' : 'hub',
      buildingCount: rm.slice.buildings.length,
      machineCount: rep.configuredMachineCount,
      avgEfficiency: rep.avgEfficiency,
      powerPeakMW: rep.power.crafterPeakMW,
      powerActiveMW: rep.power.activeDrawMW,
      outputs: rep.netOutputs.map((o) => ({ itemId: o.itemId, nameZh: o.nameZh, ratePerSec: o.ratePerSec })),
      inputs: netInList,
      errors,
      anomalyWarns,
    };
    if (summary.kind === 'production') productionRooms.push(summary);
    else hubRooms.push(summary);
  }

  // -------------------- PASS 2: Cross-Room Seam Integration Simulation --------------------
  const findMod = (floor: number, gx: number, gy: number) =>
    doc.modules.find((x) => x.floor === floor && x.gx === gx && x.gy === gy);

  const seamSpecs: Array<{ name: string; floor: number; coords: Array<[number, number, number]> }> = [
    {
      name: 'F1 北电梯 + 北玻璃玄关 + 北翼中轴#1 + 北左1(钛板) + 北右1(超级合金)',
      floor: 2,
      coords: [
        [2, 0, -2],
        [2, 0, -4],
        [2, 0, -6],
        [2, -2, -6],
        [2, 2, -6],
      ],
    },
    {
      name: 'F1 东电梯 + 东玻璃玄关 + 东翼中轴#1 + 东上1(船体板) + 东下1(磁线圈)',
      floor: 2,
      coords: [
        [2, 2, 0],
        [2, 4, 0],
        [2, 6, 0],
        [2, 6, -2],
        [2, 6, 2],
      ],
    },
    {
      name: 'F1 南翼中轴#4 + 南左4(α/β双蛋白) + 南右4(高级板材)',
      floor: 2,
      coords: [
        [2, 0, 12],
        [2, -2, 12],
        [2, 2, 12],
      ],
    },
    {
      name: 'F1 西电梯 + 西玻璃玄关 + 西翼中轴#1 + 西上1(强化板材) + 西下1(超级合金框架)',
      floor: 2,
      coords: [
        [2, -2, 0],
        [2, -4, 0],
        [2, -6, 0],
        [2, -6, -2],
        [2, -6, 2],
      ],
    },
    {
      name: 'F2 北电梯 + F2 北商业街双段 (12大箱)',
      floor: 4,
      coords: [
        [4, 0, -2],
        [4, 0, -4],
        [4, 0, -6],
      ],
    },
    {
      name: 'B1 中央8×8立交 + 四向2×2电梯环廊',
      floor: 0,
      coords: [
        [0, 0, 0],
        [0, 0, -2],
        [0, 2, 0],
        [0, 0, 2],
        [0, -2, 0],
      ],
    },
  ];

  const fatalSeamCodes = new Set([
    'head-on-belt',
    'dead-end-belt',
    'port-mismatch',
    'unpaired-underground',
    'splitter-leak',
    'orphan-belt',
  ]);
  const seams: SeamSimSummary[] = [];
  for (const spec of seamSpecs) {
    const mods = spec.coords.map(([fl, gx, gy]) => findMod(fl, gx, gy)).filter((m): m is PlacedModule => !!m);
    if (mods.length !== spec.coords.length) continue;
    const slice = extractModuleSlice(doc, mods);
    const rep = simulateBlueprint(slice);
    const seamFaults = rep.issues
      .filter((i) => fatalSeamCodes.has(i.code))
      .map((i) => `${i.code}@(${i.x},${i.y}): ${i.message}`);
    seams.push({
      name: spec.name,
      floor: spec.floor,
      moduleCount: mods.length,
      buildingCount: slice.buildings.length,
      totalErrors: rep.errorCount,
      seamFaults,
      avgEfficiency: rep.avgEfficiency,
    });
  }

  // -------------------- PASS 3: System-Level Item Flow & Refill Ledger --------------------
  const producersByItem = new Map<string, Array<{ room: string; ratePerSec: number }>>();
  const consumersByItem = new Map<string, Array<{ room: string; ratePerSec: number }>>();

  for (const rm of productionRooms) {
    for (const o of rm.outputs) {
      if (!producersByItem.has(o.itemId)) producersByItem.set(o.itemId, []);
      producersByItem.get(o.itemId)!.push({ room: rm.label, ratePerSec: o.ratePerSec });
    }
    for (const i of rm.inputs) {
      if (!consumersByItem.has(i.itemId)) consumersByItem.set(i.itemId, []);
      consumersByItem.get(i.itemId)!.push({ room: rm.label, ratePerSec: i.ratePerSec });
    }
  }

  const allItemIds = new Set([...producersByItem.keys(), ...consumersByItem.keys()]);
  const itemBalances: ItemBalanceRow[] = [];
  for (const itemId of allItemIds) {
    const producers = producersByItem.get(itemId) ?? [];
    const consumers = consumersByItem.get(itemId) ?? [];
    const producedPerSec = producers.reduce((s, p) => s + p.ratePerSec, 0);
    const consumedAllOnPerSec = consumers.reduce((s, c) => s + c.ratePerSec, 0);
    itemBalances.push({
      itemId,
      nameZh: getItemNameZh(itemId),
      producedPerSec,
      consumedAllOnPerSec,
      netAllOnPerSec: producedPerSec - consumedAllOnPerSec,
      externalOnly: producers.length === 0,
      // Container_2 holds 320 stacks (~8,000 units at typical stack=25)
      estRefillMinAt25Stack: producedPerSec > 0 ? 8000 / producedPerSec / 60 : null,
      producers,
      consumers,
    });
  }
  itemBalances.sort((a, b) => Number(b.externalOnly) - Number(a.externalOnly) || b.producedPerSec - a.producedPerSec);
  const externalInputs = itemBalances.filter((r) => r.externalOnly);

  // -------------------- PASS 4: Full-Station Power & Orbit Margin Audit --------------------
  const b1CrafterPeakMW = productionRooms.filter((r) => r.floor === 0).reduce((s, r) => s + r.powerPeakMW, 0);
  const f1CrafterPeakMW = productionRooms.filter((r) => r.floor === 2).reduce((s, r) => s + r.powerPeakMW, 0);
  let solarMk2Count = 0;
  let solarMk3Count = 0;
  let observatoryCount = 0;
  let turretCount = 0;
  for (const m of doc.modules) {
    if (m.type === 'BPO_SolarPanelBlock_02') solarMk2Count++;
    else if (m.type === 'BPO_SolarPanelBlock_03') solarMk3Count++;
    else if (m.type === 'BPO_DeepSpaceObservatory') observatoryCount++;
    else if (m.type === 'BPO_StationTurretBlock_01') turretCount++;
  }
  const teleporterCount = doc.buildings.filter((b) => b.type === 'DAT_Teleporter').length;
  const maxSolarMW = solarMk2Count * 48 + solarMk3Count * 288;
  const minSolarMW = maxSolarMW * 0.2;
  const facilityPeakMW = observatoryCount * 96 + teleporterCount * 12;
  const turretPeakMW = turretCount * 6;
  const peacetimePeakMW = b1CrafterPeakMW + f1CrafterPeakMW + facilityPeakMW;
  const combatPeakMW = peacetimePeakMW + turretPeakMW;
  const mallTypical25PctMW = facilityPeakMW + (b1CrafterPeakMW + f1CrafterPeakMW) * 0.25;

  const orbitDefs: Array<[string, number]> = [
    ['近恒星轨道 (100% 光照)', 1.0],
    ['标准轨道 (80% 光照)', 0.8],
    ['外环轨道 (60% 光照)', 0.6],
    ['极远深空 (20% 保底)', 0.2],
  ];
  const orbits: OrbitPowerRow[] = orbitDefs.map(([orbitLabel, eff]) => {
    const solarGenMW = maxSolarMW * eff;
    return {
      orbitLabel,
      solarEfficiency: eff,
      solarGenMW,
      netVsCombatPeakMW: solarGenMW - combatPeakMW,
      netVsPeacetimePeakMW: solarGenMW - peacetimePeakMW,
      netVsMall25PctMW: solarGenMW - mallTypical25PctMW,
    };
  });

  // -------------------- PASS 5: Global Structural Integrity --------------------
  const occupied = new Set<string>();
  let overlaps = 0;
  let outOfFloor = 0;
  let invalidRecipes = 0;
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def) continue;
    if (b.recipeId && !getRecipeDef(b.recipeId)) invalidRecipes++;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        const cx = b.x + dx;
        const cy = b.y + dy;
        if (!isCellBuildable(doc, cx, cy, b.floor)) outOfFloor++;
        const key = `${b.floor}:${cx},${cy}`;
        if (occupied.has(key)) overlaps++;
        occupied.add(key);
      }
    }
  }
  const links = computeUndergroundLinks(doc);
  const undergroundBelts = doc.buildings.filter((b) => b.type.startsWith('DAT_UndergroundBelt')).length;

  const turretMods = doc.modules.filter((m) => m.type === 'BPO_StationTurretBlock_01');
  let outwardTurretCount = 0;
  for (const t of turretMods) {
    const cx = t.gx + 0.5 - 1;
    const cy = t.gy + 0.5 - 1;
    const [dx, dy] = t.rotation === 0 ? [1, 0] : t.rotation === 1 ? [0, 1] : t.rotation === 2 ? [-1, 0] : [0, -1];
    if (dx * cx + dy * cy > 0) outwardTurretCount++;
  }
  const turretsValid = outwardTurretCount === turretMods.length;

  const passed =
    productionRooms.every((r) => r.errors.length === 0 && r.anomalyWarns.length === 0 && r.avgEfficiency >= 0.7) &&
    hubRooms.every((h) => h.errors.length === 0 && h.anomalyWarns.length === 0) &&
    seams.every((s) => s.seamFaults.length === 0) &&
    overlaps === 0 &&
    outOfFloor === 0 &&
    invalidRecipes === 0 &&
    turretsValid;

  return {
    generatedAt: new Date().toISOString(),
    blueprintName: doc.name,
    blueprintId: doc.id,
    passed,
    productionRooms,
    hubRooms,
    seams,
    itemBalances,
    externalInputs,
    power: {
      solarMk2Count,
      solarMk3Count,
      observatoryCount,
      turretCount,
      teleporterCount,
      maxSolarMW,
      minSolarMW,
      b1CrafterPeakMW,
      f1CrafterPeakMW,
      facilityPeakMW,
      turretPeakMW,
      peacetimePeakMW,
      combatPeakMW,
      mallTypical25PctMW,
      orbits,
    },
    integrity: {
      moduleCount: doc.modules.length,
      buildingCount: doc.buildings.length,
      occupiedCells: occupied.size,
      undergroundBelts,
      pairedUndergroundLinks: links.length,
      overlaps,
      outOfFloor,
      invalidRecipes,
      outwardTurretCount,
      turretsValid,
    },
  };
}
