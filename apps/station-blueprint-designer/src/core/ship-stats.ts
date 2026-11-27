import { getModuleDef } from './catalog';
import { getModuleSizeUnits, getModuleSpatialIndex, packCellKey } from './geometry';
import type { BlueprintDocument, ShipPowerRole } from './types';

/**
 * Verified Build 26639889 Ship Flight & Power Physics Constants:
 * - `DMSPlayerShipObject::GetMaxSpeed` (0x1442ce750): min(GlobalMaxSpeed, TotalThrust / TotalMass)
 * - `DMSPlayerShipObject::GetModifiedMaxSpeed` (0x1442ce810): boosting sums MaxThrustBoosting (= 2 * MaxThrust)
 * - `WBP_ShipHUD_Throttle` [1611]: HUD m/s = tick_speed * 30.0
 * - `DAT_SmallShipFlightModel`: GlobalMaxSpeed=200 (6000 m/s), WarpSpeed=300 (9000 m/s),
 *   SlowWarpSpeed=100 (3000 m/s), MaxLowPowerSpeed=1/3 (10 m/s), LowPowerThrottle=5 (50%)
 * - `ShipyardObject::GetMassLimit` (0x1442f3200): T1=100t (+10/lv), T2=400t (+40/lv)
 */
export const SHIP_TICK_HZ = 30;
export const SHIP_GLOBAL_MAX_SPEED_MS = 200 * SHIP_TICK_HZ; // 6000 m/s
export const SHIP_LOW_POWER_SPEED_MS = 10; // 1/3 * 30 = 10 m/s
export const SHIP_WARP_FUEL_SPEED_MS = 300 * SHIP_TICK_HZ; // 9000 m/s
export const SHIP_SLOW_WARP_SPEED_MS = 100 * SHIP_TICK_HZ; // 3000 m/s
export const SHIPYARD_T1_BASE_MASS_T = 100;
export const SHIPYARD_T2_BASE_MASS_T = 400;

export interface ShipPowerBucket {
  role: Exclude<ShipPowerRole, 'generator' | 'none'>;
  count: number;
  minMW: number;
  maxMW: number;
}

export type ShipPowerStatus = 'idle' | 'surplus' | 'peak-warn' | 'cruise-deficit' | 'no-power';

export interface ShipWarpSummary {
  count: number;
  hasWarp: boolean;
  interstellar: boolean;
  warpSpeedMS: number;
  slowWarpSpeedMS: number;
}

export interface ShipSystemsSummary {
  pilotCount: number;
  dockingCollarCount: number;
  reactorCount: number;
  thrusterCount: number;
  shieldCount: number;
  shieldCapacity: number;
  shieldRecharge: number;
  containerCount: number;
  stackBonusPct: number;
  plasmaCannons: number;
  plasmaLances: number;
  missileLaunchers: number;
  missileSilos: number;
  pointDefences: number;
  miningLasers: number;
  tractorBeams: number;
  hangars: number;
  scanners: number;
  bioCollectors: number;
}

export interface ShipValidationAlert {
  code: 'missing-pilot' | 'multi-pilot' | 'missing-dock' | 'multi-dock' | 'multi-warp' | 'overlap';
  severity: 'error' | 'warn';
  zh: string;
  en: string;
}

export interface ShipStatsReport {
  moduleCount: number;
  totalWeightT: number;
  totalHull: number;
  totalThrustKN: number;
  totalBoostThrustKN: number;
  /** Normal top speed in m/s (0 if no thrust or no mass) */
  maxSpeedMS: number;
  /** Boost top speed in m/s */
  boostSpeedMS: number;
  /** Estimated acceleration in m/s² (30 * thrust / mass) */
  accelMS2: number;
  /** Low-power forced speed cap (10 m/s, boost disabled) */
  lowPowerSpeedMS: number;
  /** Recommended shipyard tier based on totalWeightT */
  shipyardTier: 't1' | 't2' | 't2-tech';
  warp: ShipWarpSummary;
  power: {
    genMW: number;
    buckets: ShipPowerBucket[];
    cruiseMaxMW: number; // Thrusters at 100% throttle
    combatMaxMW: number; // Thrusters + shields + weapons
    peakMaxMW: number;   // Every power-consuming module simultaneously active
    status: ShipPowerStatus;
  };
  systems: ShipSystemsSummary;
  overlapCount: number;
  alerts: ShipValidationAlert[];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function computeShipStats(doc: BlueprintDocument): ShipStatsReport {
  let totalWeightT = 0;
  let totalHull = 0;
  let totalThrustKN = 0;
  let totalBoostThrustKN = 0;
  let genKW = 0;

  const powerMap = new Map<Exclude<ShipPowerRole, 'generator' | 'none'>, { count: number; maxKW: number }>();
  const addPower = (role: Exclude<ShipPowerRole, 'generator' | 'none'>, kw: number) => {
    const cur = powerMap.get(role) ?? { count: 0, maxKW: 0 };
    cur.count += 1;
    cur.maxKW += kw;
    powerMap.set(role, cur);
  };

  let warpCount = 0;
  let interstellar = false;
  let warpSpeedMS = 0;

  const systems: ShipSystemsSummary = {
    pilotCount: 0,
    dockingCollarCount: 0,
    reactorCount: 0,
    thrusterCount: 0,
    shieldCount: 0,
    shieldCapacity: 0,
    shieldRecharge: 0,
    containerCount: 0,
    stackBonusPct: 0,
    plasmaCannons: 0,
    plasmaLances: 0,
    missileLaunchers: 0,
    missileSilos: 0,
    pointDefences: 0,
    miningLasers: 0,
    tractorBeams: 0,
    hangars: 0,
    scanners: 0,
    bioCollectors: 0,
  };

  for (let i = 0; i < doc.modules.length; i++) {
    const m = doc.modules[i];
    const def = getModuleDef(m.type);
    if (!def) continue;

    totalWeightT += def.weightT ?? 0;
    totalHull += def.hull ?? 0;
    const thrust = def.thrustKN ?? 0;
    if (thrust > 0) {
      totalThrustKN += thrust;
      totalBoostThrustKN += def.boostThrustKN ?? thrust * 2;
      systems.thrusterCount += 1;
    }

    if (def.powerGenKW && def.powerGenKW > 0) {
      genKW += def.powerGenKW;
      systems.reactorCount += 1;
    }
    if (def.powerKW && def.powerKW > 0 && def.powerRole && def.powerRole !== 'generator' && def.powerRole !== 'none') {
      addPower(def.powerRole, def.powerKW);
    }

    if (def.functionalType === 'PilotBlock') systems.pilotCount += 1;
    else if (def.functionalType === 'DockingCollar') systems.dockingCollarCount += 1;
    else if (def.functionalType === 'WarpDrive') {
      warpCount += 1;
      if (def.shipStats?.interstellarWarp) interstellar = true;
      warpSpeedMS = Math.max(warpSpeedMS, def.shipStats?.warpSpeedMS ?? SHIP_WARP_FUEL_SPEED_MS);
    } else if (def.functionalType === 'hangar') {
      systems.hangars += 1;
    }

    if (def.shipStats?.shieldCapacity) {
      systems.shieldCount += 1;
      systems.shieldCapacity += def.shipStats.shieldCapacity;
      systems.shieldRecharge += def.shipStats.shieldRecharge ?? 0.5;
    }
    if (def.shipStats?.stackBonusPct) {
      systems.containerCount += 1;
      systems.stackBonusPct += def.shipStats.stackBonusPct;
    }
    if (def.id.startsWith('BPO_CannonBlock')) systems.plasmaCannons += 1;
    else if (def.id === 'BPO_LanceBlock') systems.plasmaLances += 1;
    else if (def.id === 'BPO_MissileLauncherBlock_01') {
      systems.missileLaunchers += 1;
      systems.missileSilos += def.shipStats?.missileSilos ?? 4;
    } else if (def.id.startsWith('BPO_ShipLaserTurretBlock')) systems.pointDefences += 1;
    else if (def.id.startsWith('BPO_MiningLaserBlock')) systems.miningLasers += 1;
    else if (def.id.startsWith('BPO_TractorBeamBlock')) systems.tractorBeams += 1;
    else if (def.id === 'BPO_AstronomicScanner') systems.scanners += 1;
    else if (def.id === 'BPO_BiosampleCollector') systems.bioCollectors += 1;
  }

  // Exact speed formulas verified from DMSPlayerShipObject::GetMaxSpeed / GetModifiedMaxSpeed * 30
  let maxSpeedMS = 0;
  let boostSpeedMS = 0;
  let accelMS2 = 0;
  if (totalWeightT > 0 && totalThrustKN > 0) {
    const rawTick = totalThrustKN / totalWeightT;
    const boostTick = totalBoostThrustKN / totalWeightT;
    maxSpeedMS = round1(Math.min(SHIP_GLOBAL_MAX_SPEED_MS, rawTick * SHIP_TICK_HZ));
    boostSpeedMS = round1(Math.min(SHIP_GLOBAL_MAX_SPEED_MS, boostTick * SHIP_TICK_HZ));
    accelMS2 = round1(rawTick * SHIP_TICK_HZ);
  }

  const roleOrder: Array<Exclude<ShipPowerRole, 'generator' | 'none'>> = [
    'thruster',
    'shield',
    'weapon',
    'mining',
    'workstation',
    'other',
  ];
  const buckets: ShipPowerBucket[] = [];
  for (const role of roleOrder) {
    const entry = powerMap.get(role);
    if (entry && entry.maxKW > 0) {
      buckets.push({
        role,
        count: entry.count,
        minMW: 0,
        maxMW: round1(entry.maxKW / 1000),
      });
    }
  }

  const genMW = round1(genKW / 1000);
  const thrusterMaxMW = round1((powerMap.get('thruster')?.maxKW ?? 0) / 1000);
  const shieldMaxMW = round1((powerMap.get('shield')?.maxKW ?? 0) / 1000);
  const weaponMaxMW = round1((powerMap.get('weapon')?.maxKW ?? 0) / 1000);
  const peakMaxMW = round1(buckets.reduce((acc, b) => acc + b.maxMW, 0));
  const cruiseMaxMW = thrusterMaxMW;
  const combatMaxMW = round1(thrusterMaxMW + shieldMaxMW + weaponMaxMW);

  let status: ShipPowerStatus = 'idle';
  if (peakMaxMW > 0) {
    if (genMW <= 0) status = 'no-power';
    else if (cruiseMaxMW > genMW + 1e-6) status = 'cruise-deficit';
    else if (peakMaxMW > genMW + 1e-6) status = 'peak-warn';
    else status = 'surplus';
  } else if (genMW > 0) {
    status = 'surplus';
  }

  // Detect 3D grid overlaps (O(M) using cached spatial index)
  let overlapCount = 0;
  if (doc.modules.length > 1) {
    const idx = getModuleSpatialIndex(doc.modules);
    const seenPairs = new Set<string>();
    for (let i = 0; i < doc.modules.length; i++) {
      const m = doc.modules[i];
      const def = getModuleDef(m.type);
      const [wu, du, hu] = def ? getModuleSizeUnits(def, m.rotation) : [1, 1, 1];
      for (let df = 0; df < hu; df++) {
        const grid = idx.moduleGridByFloor.get(m.floor + df);
        if (!grid) continue;
        for (let dx = 0; dx < wu; dx++) {
          for (let dy = 0; dy < du; dy++) {
            const hits = grid.get(packCellKey(m.gx + dx, m.gy + dy));
            if (!hits || hits.length <= 1) continue;
            for (const other of hits) {
              if (other.id <= m.id) continue;
              const pk = `${m.id}|${other.id}`;
              if (!seenPairs.has(pk)) {
                seenPairs.add(pk);
                overlapCount += 1;
              }
            }
          }
        }
      }
    }
  }

  // Only emit concise hard-rule alerts when violated (no clutter for normal stateless parts)
  const alerts: ShipValidationAlert[] = [];
  if (doc.modules.length > 0) {
    if (overlapCount > 0) {
      alerts.push({
        code: 'overlap',
        severity: 'error',
        zh: `${overlapCount} 处模块重叠`,
        en: `${overlapCount} overlap`,
      });
    }
    if (systems.pilotCount === 0) {
      alerts.push({ code: 'missing-pilot', severity: 'warn', zh: '缺驾驶舱', en: 'No cockpit' });
    } else if (systems.pilotCount > 1) {
      alerts.push({ code: 'multi-pilot', severity: 'error', zh: '驾驶舱>1', en: 'Cockpits > 1' });
    }
    if (systems.dockingCollarCount === 0) {
      alerts.push({ code: 'missing-dock', severity: 'warn', zh: '缺对接舱', en: 'No collar' });
    } else if (systems.dockingCollarCount > 1) {
      alerts.push({ code: 'multi-dock', severity: 'error', zh: '对接舱>1', en: 'Collars > 1' });
    }
    if (warpCount > 1) {
      alerts.push({ code: 'multi-warp', severity: 'error', zh: '曲速驱动>1', en: 'Warp > 1' });
    }
  }

  const shipyardTier =
    totalWeightT <= SHIPYARD_T1_BASE_MASS_T
      ? 't1'
      : totalWeightT <= SHIPYARD_T2_BASE_MASS_T
        ? 't2'
        : 't2-tech';

  return {
    moduleCount: doc.modules.length,
    totalWeightT: round1(totalWeightT),
    totalHull: round1(totalHull),
    totalThrustKN: round1(totalThrustKN),
    totalBoostThrustKN: round1(totalBoostThrustKN),
    maxSpeedMS,
    boostSpeedMS,
    accelMS2,
    lowPowerSpeedMS: SHIP_LOW_POWER_SPEED_MS,
    shipyardTier,
    warp: {
      count: warpCount,
      hasWarp: warpCount > 0,
      interstellar,
      warpSpeedMS: warpCount > 0 ? warpSpeedMS : 0,
      slowWarpSpeedMS: warpCount > 0 ? SHIP_SLOW_WARP_SPEED_MS : 0,
    },
    power: {
      genMW,
      buckets,
      cruiseMaxMW,
      combatMaxMW,
      peakMaxMW,
      status,
    },
    systems: {
      ...systems,
      shieldRecharge: round1(systems.shieldRecharge),
    },
    overlapCount,
    alerts,
  };
}
