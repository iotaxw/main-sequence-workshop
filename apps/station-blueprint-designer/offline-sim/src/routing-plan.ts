export type WingId = 'north' | 'east' | 'west' | 'south';

export interface ElevatorShaftAssignment {
  /** 1-based shaft slot index inside the 24-port 2x2 elevator (1..24) */
  slot: number;
  /** Item carried in this dedicated vertical shaft (zero mixed belts!) */
  itemId: string;
  /** Direction & floors bridged by this shaft */
  flow: 'B1->F1' | 'F1->B1' | 'F1->F2' | 'F1->B1&F2' | 'B1->F1&F2' | 'B1->F2';
  /** Dedicated F2 boutique bay (1..12) when this shaft feeds a showcase container directly */
  f2Bay?: number;
  /** Note for game-format exporter & human inspection */
  note: string;
}

export interface WingElevatorPlan {
  wing: WingId;
  elevatorLabel: string;
  gx: number;
  gy: number;
  shafts: ElevatorShaftAssignment[];
  /** Items produced & consumed purely locally inside this wing (never consume an elevator shaft!) */
  localOnlyItems: string[];
}

export interface F2BoutiqueSlotPlan {
  wing: WingId;
  bay: number; // 1..12
  label: string;
  itemId: string | null; // null for EA reserve or manual misc container
  isSeedBox?: boolean;
  sourceKind: 'f1-cell' | 'b1-cell' | 'observatory' | 'manual-misc' | 'ea-reserve';
}

/**
 * Official 96-Shaft Cross-Deck Elevator Routing Plan (4 x BPO_ElevatorBlock_02A, 24 shafts each).
 * Design invariants:
 *  - Every shaft carries exactly ONE pure item (zero mixed belts, zero filter jams).
 *  - Every F2 boutique showcase container (1..12) maps 1:1 to shafts 1..12 (Northern half of each F2 elevator).
 *  - Shared items (e.g., B1 Coolant/Silica/Fuel or F1 Plates/Alloys) ride a single vertical shaft bridging B1<->F1<->F2!
 *  - Total active shafts: 82 / 96 (14 free EA expansion shafts across all 4 cardinal elevators).
 */
export const WING_ELEVATOR_PLANS: WingElevatorPlan[] = [
  {
    wing: 'north',
    elevatorLabel: '北电梯 (0, -2)',
    gx: 0,
    gy: -2,
    localOnlyItems: [],
    shafts: [
      // F2 North Boutique 12 bays (shafts 1..12, 1:1 direct zero-crossing pure lanes!)
      { slot: 1, itemId: 'ITEM_Silica', flow: 'B1->F1&F2', f2Bay: 1, note: '二氧化硅 #1 (供北右3/4+北商业街)' },
      { slot: 2, itemId: 'ITEM_TitaniumPlates', flow: 'F1->B1&F2', f2Bay: 2, note: '钛板 #1 (供B1立交转东翼+北商业街)' },
      { slot: 3, itemId: 'ITEM_NickelPlates', flow: 'F1->B1&F2', f2Bay: 3, note: '镍板 #1 (供B1立交转东/西翼+北商业街)' },
      { slot: 4, itemId: 'ITEM_IridiumPlates', flow: 'F1->F2', f2Bay: 4, note: '铱板 (北翼内直供有色合金+上北商业街)' },
      { slot: 5, itemId: 'ITEM_ReinforcedGlass', flow: 'F1->B1&F2', f2Bay: 5, note: '强化玻璃 (下B1转西/南翼+上北商业街)' },
      { slot: 6, itemId: 'ITEM_Graphene', flow: 'F1->B1&F2', f2Bay: 6, note: '石墨烯 (下B1转东/南翼+上北商业街)' },
      { slot: 7, itemId: 'ITEM_Superalloy', flow: 'F1->B1&F2', f2Bay: 7, note: '超级合金 (北翼内直供有色+下B1转东/西+上北商业街)' },
      { slot: 8, itemId: 'ITEM_ChromaticAlloy', flow: 'F1->B1&F2', f2Bay: 8, note: '有色合金 (下B1转南翼+上北商业街)' },
      { slot: 9, itemId: 'ITEM_Coolant', flow: 'B1->F2', f2Bay: 9, note: '冷却剂 (B1北西舱直上北商业街)' },
      { slot: 10, itemId: 'ITEM_EnrichedFuel', flow: 'B1->F2', f2Bay: 10, note: '氘燃料 (B1北东燃料舱直上北商业街)' },
      { slot: 11, itemId: 'ITEM_WarpFuel', flow: 'B1->F2', f2Bay: 11, note: '曲速燃料 (B1天文台直上北商业街)' },
      { slot: 12, itemId: 'ITEM_StrangeMatterCrystal', flow: 'B1->F2', f2Bay: 12, note: '外采杂物/奇异物质展箱 (B1货港直上)' },
      // B1 -> F1 North Wing dedicated raw/enriched supply shafts (slots 13..18)
      { slot: 13, itemId: 'ITEM_EnrichedTitaniumOre', flow: 'B1->F1', note: '浓缩钛矿石 -> 北左1钛板 & 北右1超合金' },
      { slot: 14, itemId: 'ITEM_EnrichedNickelOre', flow: 'B1->F1', note: '浓缩镍矿石 -> 北左2镍板 & 北右1超合金' },
      { slot: 15, itemId: 'ITEM_EnrichedCobaltOre', flow: 'B1->F1', note: '浓缩钴矿石 -> 北左3钴板 & 北右1超合金' },
      { slot: 16, itemId: 'ITEM_IridiumOre', flow: 'B1->F1', note: '铱矿石 -> 北左4铱板 (外矿港直供)' },
      { slot: 17, itemId: 'ITEM_Graphite', flow: 'B1->F1', note: '石墨 #1 -> 北尖石墨烯 (3.0/s)' },
      { slot: 18, itemId: 'ITEM_Silica', flow: 'B1->F1', note: '二氧化硅 #2 并行高速线 -> 强化玻璃 & 硅晶圆' },
      // F1 -> B1 additional high-throughput / pure-intermediate shafts (slots 19..21; 22..24 reserved for EA!)
      { slot: 19, itemId: 'ITEM_CobaltPlates', flow: 'F1->B1', note: '钴板 -> 下B1立交转东翼磁线圈/电控' },
      { slot: 20, itemId: 'ITEM_SiliconWafers', flow: 'F1->B1', note: '硅晶圆 -> 下B1立交转东翼基础电路/探测器' },
      { slot: 21, itemId: 'ITEM_TitaniumPlates', flow: 'F1->B1', note: '钛板 #2 并行双带 (6.0/s满速下B1转东翼)' },
      { slot: 22, itemId: 'ITEM_Graphite', flow: 'B1->F1', note: '石墨 #2 并行补强线 (满喂北尖石墨烯 4.0/s)' },
    ],
  },
  {
    wing: 'east',
    elevatorLabel: '东电梯 (2, 0)',
    gx: 2,
    gy: 0,
    localOnlyItems: [],
    shafts: [
      // F2 East Boutique 10 active bays (slots 1..10; 11..12 EA boutique reserve)
      { slot: 1, itemId: 'ITEM_HullPlates', flow: 'F1->B1&F2', f2Bay: 1, note: '船体板 (东上1 -> 下B1转西翼+上东商业街)' },
      { slot: 2, itemId: 'ITEM_LightweightFrame', flow: 'F1->B1&F2', f2Bay: 2, note: '轻型框架 (东上2 -> 翼内供伺服+下B1转西尖修理包+上东商业街)' },
      { slot: 3, itemId: 'ITEM_BasicMotor', flow: 'F1->F2', f2Bay: 3, note: '基础马达 (东上3 -> 翼内供伺服+上东商业街)' },
      { slot: 4, itemId: 'ITEM_Servomotor', flow: 'F1->B1&F2', f2Bay: 4, note: '伺服电机 (东上4 -> 下B1转西上2磁悬浮+上东商业街)' },
      { slot: 5, itemId: 'ITEM_MagneticCoils', flow: 'F1->B1&F2', f2Bay: 5, note: '磁线圈 (东下1 -> 翼内供电路/约束+下B1转西尖修理包+上东商业街)' },
      { slot: 6, itemId: 'ITEM_Capacitor', flow: 'F1->B1&F2', f2Bay: 6, note: '电容器 (东下2 -> 翼内供伺服/约束+下B1转西下3/西尖+上东商业街)' },
      { slot: 7, itemId: 'ITEM_ContainmentCoil', flow: 'F1->B1&F2', f2Bay: 7, note: '约束线圈 (东下4 -> 下B1转西翼超导/导弹+上东商业街)' },
      { slot: 8, itemId: 'ITEM_BasicCircuit', flow: 'F1->F2', f2Bay: 8, note: '基础电路 (东下3 -> 翼内供约束/探测器/高电+上东商业街)' },
      { slot: 9, itemId: 'ITEM_DetectorArray', flow: 'F1->F2', f2Bay: 9, note: '探测器阵列 (东上5 -> 翼内供高电+上东商业街)' },
      { slot: 10, itemId: 'ITEM_AdvancedCircuits', flow: 'F1->B1&F2', f2Bay: 10, note: '高级电路 (东下5 -> 下B1转南右1空矩阵+上东商业街)' },
      // B1 -> F1 East Wing cross-wing supply shafts (slots 13..21; 11,12,22,23,24 = 5 free EA shafts!)
      { slot: 13, itemId: 'ITEM_TitaniumPlates', flow: 'B1->F1', note: '钛板 #1 -> 船体板/轻型框架/电容器/基础马达' },
      { slot: 14, itemId: 'ITEM_TitaniumPlates', flow: 'B1->F1', note: '钛板 #2 并行高速线 (双带 6.0/s)' },
      { slot: 15, itemId: 'ITEM_NickelPlates', flow: 'B1->F1', note: '镍板 #1 -> 磁线圈/电容器' },
      { slot: 16, itemId: 'ITEM_NickelPlates', flow: 'B1->F1', note: '镍板 #2 并行高速线' },
      { slot: 17, itemId: 'ITEM_CobaltPlates', flow: 'B1->F1', note: '钴板 -> 磁线圈/约束线圈' },
      { slot: 18, itemId: 'ITEM_SiliconWafers', flow: 'B1->F1', note: '硅晶圆 -> 基础电路/探测器阵列' },
      { slot: 19, itemId: 'ITEM_Graphene', flow: 'B1->F1', note: '石墨烯 -> 探测器阵列' },
      { slot: 20, itemId: 'ITEM_Superalloy', flow: 'B1->F1', note: '超级合金 -> 高级电路' },
      { slot: 21, itemId: 'ITEM_Coolant', flow: 'B1->F1', note: '冷却剂 -> 高级电路 (3.0/s)' },
    ],
  },
  {
    wing: 'west',
    elevatorLabel: '西电梯 (-2, 0)',
    gx: -2,
    gy: 0,
    localOnlyItems: [],
    shafts: [
      // F2 West Boutique 11 active bays (slots 1..11; slot 12 EA reserve)
      { slot: 1, itemId: 'ITEM_ReinforcedPlates', flow: 'F1->B1&F2', f2Bay: 1, note: '强化板材 (西上1 -> 翼内供伺服板+下B1转南右4高级板材+上西商业街)' },
      { slot: 2, itemId: 'ITEM_MaglevCoupling', flow: 'F1->F2', f2Bay: 2, note: '磁悬浮列车耦合器 (西上2 -> 翼内供伺服板/超导+上西商业街)' },
      { slot: 3, itemId: 'ITEM_ServoPlates', flow: 'F1->F2', f2Bay: 3, note: '伺服板 (西上3 -> 上西商业街)' },
      { slot: 4, itemId: 'ITEM_SuperalloyFrame', flow: 'F1->F2', f2Bay: 4, note: '超级合金框架 (西下1 -> 上西商业街)' },
      { slot: 5, itemId: 'ITEM_SuperconductorCoil', flow: 'F1->B1&F2', f2Bay: 5, note: '超导线圈 (西上4 -> 下B1转南右3多传感器+上西商业街)' },
      { slot: 6, itemId: 'ITEM_RelicShard', flow: 'F1->F2', f2Bay: 6, note: '遗迹碎片 (西下2 -> 翼内供遗迹电容+上西商业街)' },
      { slot: 7, itemId: 'ITEM_RelicCapacitor', flow: 'F1->F2', f2Bay: 7, note: '遗迹电容器 (西下3 -> 上西商业街)' },
      { slot: 8, itemId: 'ITEM_RepairKit', flow: 'F1->F2', f2Bay: 8, note: '修理包 (西尖 -> 上西商业街)' },
      { slot: 9, itemId: 'ITEM_RepairKitHull', flow: 'F1->F2', f2Bay: 9, note: '船体修理包 (西尖 -> 上西商业街)' },
      { slot: 10, itemId: 'ITEM_RepairKitElectric', flow: 'F1->F2', f2Bay: 10, note: '电力修理包 (西尖 -> 上西商业街)' },
      { slot: 11, itemId: 'ITEM_Missile', flow: 'F1->F2', f2Bay: 11, note: '导弹 (西下4 -> 上西商业街)' },
      // B1 -> F1 West Wing cross-wing supply shafts (slots 13..23; 12 & 24 = 2 free EA shafts!)
      { slot: 13, itemId: 'ITEM_Superalloy', flow: 'B1->F1', note: '超级合金 -> 强化板材/超合金框架/磁悬浮/遗迹碎片' },
      { slot: 14, itemId: 'ITEM_HullPlates', flow: 'B1->F1', note: '船体板 -> 强化板材/导弹/船体修理包' },
      { slot: 15, itemId: 'ITEM_Servomotor', flow: 'B1->F1', note: '伺服电机 -> 磁悬浮耦合器' },
      { slot: 16, itemId: 'ITEM_ReinforcedGlass', flow: 'B1->F1', note: '强化玻璃 -> 伺服板' },
      { slot: 17, itemId: 'ITEM_NickelPlates', flow: 'B1->F1', note: '镍板 -> 修理包' },
      { slot: 18, itemId: 'ITEM_Capacitor', flow: 'B1->F1', note: '电容器 -> 遗迹电容器/电力修理包' },
      { slot: 19, itemId: 'ITEM_ContainmentCoil', flow: 'B1->F1', note: '约束线圈 -> 超导线圈/导弹' },
      { slot: 20, itemId: 'ITEM_Coolant', flow: 'B1->F1', note: '冷却剂 #1 -> 超导线圈' },
      { slot: 21, itemId: 'ITEM_Coolant', flow: 'B1->F1', note: '冷却剂 #2 -> 导弹 (双线免抢料)' },
      { slot: 22, itemId: 'ITEM_LightweightFrame', flow: 'B1->F1', note: '轻型框架 -> 修理包/船体修理包' },
      { slot: 23, itemId: 'ITEM_MagneticCoils', flow: 'B1->F1', note: '磁线圈 -> 电力修理包' },
    ],
  },
  {
    wing: 'south',
    elevatorLabel: '南电梯 (0, 2)',
    gx: 0,
    gy: 2,
    localOnlyItems: [
      'ITEM_Nutrients',
      'ITEM_Biomass',
      'ITEM_Enzyme',
      'ITEM_AlphaProtein',
      'ITEM_BetaProtein',
      'ITEM_EmptySimulationMatrix',
      'ITEM_Multisensor',
      'ITEM_StellarSurveyData', // Directly supplied by flanking South-West & South-East Deep Space Observatories!
    ],
    shafts: [
      // F2 South Boutique 7 active bays (slots 1..7; 8..12 EA reserve)
      { slot: 1, itemId: 'ITEM_Biolattice', flow: 'F1->F2', f2Bay: 1, note: '生物晶格 (南左5 -> 翼内供甲壳质+上南商业街)' },
      { slot: 2, itemId: 'ITEM_ChitinComposite', flow: 'F1->F2', f2Bay: 2, note: '甲壳质复合材料 (南右5 -> 翼内供高级板材+上南商业街)' },
      { slot: 3, itemId: 'ITEM_EncodedSimulationMatrix', flow: 'F1->F2', f2Bay: 3, note: '编码模拟矩阵 (南右2超算 -> 翼内供多传感器+上南商业街)' },
      { slot: 4, itemId: 'ITEM_AdvancedPlates', flow: 'F1->F2', f2Bay: 4, note: '高级板材 (南右4 -> 上南商业街)' },
      { slot: 5, itemId: 'ITEM_Xenobacteria', flow: 'F1->F2', f2Bay: 5, note: '异源细菌保种 (南左2育种 -> 上南商业街保种小箱)' },
      { slot: 6, itemId: 'ITEM_Xenoarchaea', flow: 'F1->F2', f2Bay: 6, note: '异源古菌保种 (南左2育种 -> 上南商业街保种小箱)' },
      { slot: 7, itemId: 'ITEM_Xenoeukarya', flow: 'F1->F2', f2Bay: 7, note: '异源真核生物保种 (南左2育种 -> 上南商业街保种小箱)' },
      // B1 -> F1 South Wing raw & cross-wing supply shafts (slots 13..24; 8..12 = 5 free EA shafts!)
      { slot: 13, itemId: 'ITEM_Graphite', flow: 'B1->F1', note: '石墨 #1 -> 南左1营养素' },
      { slot: 14, itemId: 'ITEM_Graphite', flow: 'B1->F1', note: '石墨 #2 -> 南左1营养素 (双线 6.0/s)' },
      { slot: 15, itemId: 'ITEM_Silica', flow: 'B1->F1', note: '二氧化硅 #1 -> 南左1营养素' },
      { slot: 16, itemId: 'ITEM_Silica', flow: 'B1->F1', note: '二氧化硅 #2 -> 南左1营养素 (双线 6.0/s)' },
      { slot: 17, itemId: 'ITEM_WaterIce', flow: 'B1->F1', note: '水冰 #1 -> 南左1营养素 (3.0/s)' },
      { slot: 18, itemId: 'ITEM_Lonsdaleite', flow: 'B1->F1', note: '六方金刚石 #1 -> 空模拟矩阵 & 多传感器' },
      { slot: 19, itemId: 'ITEM_Lonsdaleite', flow: 'B1->F1', note: '六方金刚石 #2 -> 多传感器 (4.0/s双线)' },
      { slot: 20, itemId: 'ITEM_AdvancedCircuits', flow: 'B1->F1', note: '高级电路 -> 南右1空模拟矩阵' },
      { slot: 21, itemId: 'ITEM_ChromaticAlloy', flow: 'B1->F1', note: '有色合金 -> 多传感器 & 高级板材' },
      { slot: 22, itemId: 'ITEM_ReinforcedPlates', flow: 'B1->F1', note: '强化板材 -> 南右4高级板材' },
      { slot: 23, itemId: 'ITEM_SuperconductorCoil', flow: 'B1->F1', note: '超导线圈 -> 南右3多传感器' },
      { slot: 24, itemId: 'ITEM_ReinforcedGlass', flow: 'B1->F1', note: '强化玻璃 -> 南右5甲壳质复合材料' },
      { slot: 12, itemId: 'ITEM_Graphene', flow: 'B1->F1', note: '石墨烯 -> 南右5甲壳质复合材料 (借用南闲置#12口, 仍余#8..#11共4口EA!)' },
    ],
  },
];

export const F2_BOUTIQUE_PLAN: F2BoutiqueSlotPlan[] = [
  // North Boutique (11 active + 1 misc)
  { wing: 'north', bay: 1, label: '二氧化硅', itemId: 'ITEM_Silica', sourceKind: 'b1-cell' },
  { wing: 'north', bay: 2, label: '钛板', itemId: 'ITEM_TitaniumPlates', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 3, label: '镍板', itemId: 'ITEM_NickelPlates', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 4, label: '铱板', itemId: 'ITEM_IridiumPlates', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 5, label: '强化玻璃', itemId: 'ITEM_ReinforcedGlass', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 6, label: '石墨烯', itemId: 'ITEM_Graphene', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 7, label: '超级合金', itemId: 'ITEM_Superalloy', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 8, label: '有色合金', itemId: 'ITEM_ChromaticAlloy', sourceKind: 'f1-cell' },
  { wing: 'north', bay: 9, label: '冷却剂', itemId: 'ITEM_Coolant', sourceKind: 'b1-cell' },
  { wing: 'north', bay: 10, label: '氘燃料', itemId: 'ITEM_EnrichedFuel', sourceKind: 'b1-cell' },
  { wing: 'north', bay: 11, label: '曲速燃料', itemId: 'ITEM_WarpFuel', sourceKind: 'observatory' },
  { wing: 'north', bay: 12, label: '外采杂物(遗迹核心)', itemId: null, sourceKind: 'manual-misc' },
  // East Boutique (10 active + 2 EA)
  { wing: 'east', bay: 1, label: '船体板', itemId: 'ITEM_HullPlates', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 2, label: '轻型框架', itemId: 'ITEM_LightweightFrame', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 3, label: '基础马达', itemId: 'ITEM_BasicMotor', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 4, label: '伺服电机', itemId: 'ITEM_Servomotor', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 5, label: '磁线圈', itemId: 'ITEM_MagneticCoils', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 6, label: '电容器', itemId: 'ITEM_Capacitor', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 7, label: '约束线圈', itemId: 'ITEM_ContainmentCoil', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 8, label: '基础电路', itemId: 'ITEM_BasicCircuit', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 9, label: '探测器阵列', itemId: 'ITEM_DetectorArray', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 10, label: '高级电路', itemId: 'ITEM_AdvancedCircuits', sourceKind: 'f1-cell' },
  { wing: 'east', bay: 11, label: 'EA 机电预留位 A', itemId: null, sourceKind: 'ea-reserve' },
  { wing: 'east', bay: 12, label: 'EA 机电预留位 B', itemId: null, sourceKind: 'ea-reserve' },
  // West Boutique (11 active + 1 EA)
  { wing: 'west', bay: 1, label: '强化板材', itemId: 'ITEM_ReinforcedPlates', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 2, label: '磁悬浮列车耦合器', itemId: 'ITEM_MaglevCoupling', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 3, label: '伺服板', itemId: 'ITEM_ServoPlates', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 4, label: '超级合金框架', itemId: 'ITEM_SuperalloyFrame', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 5, label: '超导线圈', itemId: 'ITEM_SuperconductorCoil', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 6, label: '遗迹碎片', itemId: 'ITEM_RelicShard', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 7, label: '遗迹电容器', itemId: 'ITEM_RelicCapacitor', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 8, label: '修理包', itemId: 'ITEM_RepairKit', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 9, label: '船体修理包', itemId: 'ITEM_RepairKitHull', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 10, label: '电力修理包', itemId: 'ITEM_RepairKitElectric', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 11, label: '导弹', itemId: 'ITEM_Missile', sourceKind: 'f1-cell' },
  { wing: 'west', bay: 12, label: 'EA 战备预留位', itemId: null, sourceKind: 'ea-reserve' },
  // South Boutique (7 active + 5 EA)
  { wing: 'south', bay: 1, label: '生物晶格', itemId: 'ITEM_Biolattice', sourceKind: 'f1-cell' },
  { wing: 'south', bay: 2, label: '甲壳质复合材料', itemId: 'ITEM_ChitinComposite', sourceKind: 'f1-cell' },
  { wing: 'south', bay: 3, label: '编码模拟矩阵', itemId: 'ITEM_EncodedSimulationMatrix', sourceKind: 'f1-cell' },
  { wing: 'south', bay: 4, label: '高级板材', itemId: 'ITEM_AdvancedPlates', sourceKind: 'f1-cell' },
  { wing: 'south', bay: 5, label: '异源细菌(保种)', itemId: 'ITEM_Xenobacteria', isSeedBox: true, sourceKind: 'f1-cell' },
  { wing: 'south', bay: 6, label: '异源古菌(保种)', itemId: 'ITEM_Xenoarchaea', isSeedBox: true, sourceKind: 'f1-cell' },
  { wing: 'south', bay: 7, label: '异源真核生物(保种)', itemId: 'ITEM_Xenoeukarya', isSeedBox: true, sourceKind: 'f1-cell' },
  { wing: 'south', bay: 8, label: 'EA 终局预留位 A', itemId: null, sourceKind: 'ea-reserve' },
  { wing: 'south', bay: 9, label: 'EA 终局预留位 B', itemId: null, sourceKind: 'ea-reserve' },
  { wing: 'south', bay: 10, label: 'EA 终局预留位 C', itemId: null, sourceKind: 'ea-reserve' },
  { wing: 'south', bay: 11, label: 'EA 终局预留位 D', itemId: null, sourceKind: 'ea-reserve' },
  { wing: 'south', bay: 12, label: 'EA 终局预留位 E', itemId: null, sourceKind: 'ea-reserve' },
];
