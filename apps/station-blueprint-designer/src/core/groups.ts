import type { ViewMode } from './types';

export interface PaletteGroupDef {
  id: string;
  slot: number; // 1..9
  name: string;
  members: string[];
}

export const BUILDING_GROUPS: PaletteGroupDef[] = [
  {
    id: 'belts',
    slot: 1,
    name: '传送带',
    members: ['DAT_ConveyorBelt', 'DAT_ConveyorBelt2', 'DAT_ConveyorBelt3'],
  },
  {
    id: 'undergrounds',
    slot: 2,
    name: '下层带',
    members: ['DAT_UndergroundBelt', 'DAT_UndergroundBelt_2', 'DAT_UndergroundBelt_3'],
  },
  {
    id: 'splitters',
    slot: 3,
    name: '分流器',
    members: ['DAT_Splitter', 'DAT_Splitter_2', 'DAT_Splitter_3'],
  },
  {
    id: 'balancers',
    slot: 4,
    name: '平衡器',
    members: ['DAT_BeltBalancer_01', 'DAT_BeltBalancer_02', 'DAT_BeltBalancer_03'],
  },
  {
    id: 'containers',
    slot: 5,
    name: '容器',
    members: ['DAT_Container', 'DAT_Container_2'],
  },
  {
    id: 'prod-basic',
    slot: 6,
    name: '制造 I',
    members: [
      'DAT_Refinery',
      'DAT_Assembler',
      'DAT_EnrichmentChamber',
      'DAT_AdvancedAssembler',
      'DAT_WorkbenchMachine',
    ],
  },
  {
    id: 'prod-adv',
    slot: 7,
    name: '制造 II',
    members: [
      'DAT_Supercomputer',
      'DAT_GrowthChamber',
      'DAT_RelicSynthesizer',
      'DAT_Armoury',
      'DAT_Teleporter',
    ],
  },
  {
    id: 'research',
    slot: 8,
    name: '实验室',
    members: [
      'DAT_MatSciLab',
      'DAT_CompSciLab',
      'DAT_ElectroSciLab',
      'DAT_QuantumSciLab',
      'DAT_AstroSciLab',
      'DAT_XenoSciLab',
      'DAT_RelicAnalyzer',
    ],
  },
  {
    id: 'power-misc',
    slot: 9,
    name: '能源/杂项',
    members: [
      'DAT_ReactorMachine',
      'DAT_SignWall',
      'DAT_Chair',
      'DAT_CoffeeTable',
      'DAT_Plant_01',
    ],
  },
];

export const STATION_GROUPS: PaletteGroupDef[] = [
  {
    id: 'st-halls',
    slot: 1,
    name: '工厂舱',
    members: [
      'BPO_Station_02A',
      'BPO_Station_02',
      'BPO_Station_03',
      'BPO_Station_01',
      'BPO_Station_2x1',
    ],
  },
  {
    id: 'st-corridors',
    slot: 2,
    name: '连接廊',
    members: [
      'BPO_StationAdapter_01',
      'BPO_StationCorridor_01',
      'BPO_StationCorridor_02',
      'BPO_StationCorner_01',
    ],
  },
  {
    id: 'st-vertical',
    slot: 3,
    name: '电梯井',
    members: ['BPO_ElevatorBlock_03', 'BPO_ElevatorBlock_02A'],
  },
  {
    id: 'st-ops',
    slot: 4,
    name: '指挥/对接',
    members: ['BPO_CommandModule', 'BPO_Dock', 'BPO_Dock_2', 'BPO_ScannerModule'],
  },
  {
    id: 'st-energy',
    slot: 5,
    name: '光伏/采矿',
    members: [
      'BPO_SolarPanelBlock',
      'BPO_SolarPanelBlock_02',
      'BPO_SolarPanelBlock_03',
      'BPO_MiningDroneBayBlock',
      'BPO_MiningDroneBayBlock_2',
    ],
  },
  {
    id: 'st-shipyard',
    slot: 6,
    name: '船坞/深空',
    members: [
      'BPO_ShipyardCore',
      'BPO_ShipyardCore_02',
      'BPO_ShipyardSide',
      'BPO_DeepSpaceObservatory',
    ],
  },
  {
    id: 'st-defense',
    slot: 7,
    name: '防御',
    members: ['BPO_StationTurretBlock_01', 'BPO_StationArmour_01'],
  },
];

const SHORT_LABELS: Record<string, string> = {
  // Logistics
  DAT_ConveyorBelt: '传送带 I',
  DAT_ConveyorBelt2: '传送带 II',
  DAT_ConveyorBelt3: '传送带 III',
  DAT_UndergroundBelt: '下层带 I',
  DAT_UndergroundBelt_2: '下层带 II',
  DAT_UndergroundBelt_3: '下层带 III',
  DAT_Splitter: '分流器 I',
  DAT_Splitter_2: '分流器 II',
  DAT_Splitter_3: '分流器 III',
  DAT_BeltBalancer_01: '平衡器 I',
  DAT_BeltBalancer_02: '平衡器 II',
  DAT_BeltBalancer_03: '平衡器 III',
  DAT_Container: '容器 I',
  DAT_Container_2: '容器 II',
  // Production
  DAT_Refinery: '精炼机',
  DAT_Assembler: '装配 I',
  DAT_EnrichmentChamber: '富集舱',
  DAT_AdvancedAssembler: '装配 II',
  DAT_WorkbenchMachine: '工作站',
  DAT_Supercomputer: '超算',
  DAT_GrowthChamber: '生长舱',
  DAT_RelicSynthesizer: '遗迹合成',
  DAT_Armoury: '军械库',
  DAT_Teleporter: '传送器',
  // Research
  DAT_MatSciLab: '实验室 I',
  DAT_CompSciLab: '实验室 II',
  DAT_ElectroSciLab: '实验室 III',
  DAT_QuantumSciLab: '实验室 IV',
  DAT_AstroSciLab: '实验室 V',
  DAT_XenoSciLab: '实验室 VI',
  DAT_RelicAnalyzer: '分析仪',
  // Power & Misc
  DAT_ReactorMachine: '反应堆',
  DAT_SignWall: '门墙',
  DAT_Chair: '座椅',
  DAT_CoffeeTable: '茶几',
  DAT_Plant_01: '绿植',
  // Station modules
  BPO_Station_01: '1×1',
  BPO_Station_2x1: '2×1',
  BPO_Station_02A: '2×2 A',
  BPO_Station_02: '2×2 B',
  BPO_Station_03: '2×2 C',
  BPO_StationAdapter_01: '适配器',
  BPO_StationCorridor_01: '廊 1×1',
  BPO_StationCorridor_02: '廊 2×2',
  BPO_StationCorner_01: '转角',
  BPO_ElevatorBlock_03: '电梯 1×1',
  BPO_ElevatorBlock_02A: '电梯 2×2',
  BPO_CommandModule: '指挥舱',
  BPO_Dock: '对接口',
  BPO_Dock_2: '工业坞',
  BPO_ScannerModule: '扫描舱',
  BPO_SolarPanelBlock: '光伏 I',
  BPO_SolarPanelBlock_02: '光伏 II',
  BPO_SolarPanelBlock_03: '光伏 III',
  BPO_MiningDroneBayBlock: '矿舱 I',
  BPO_MiningDroneBayBlock_2: '矿舱 II',
  BPO_ShipyardCore: '船坞 I',
  BPO_ShipyardCore_02: '船坞 II',
  BPO_ShipyardSide: '船坞侧',
  BPO_DeepSpaceObservatory: '天文台',
  BPO_StationTurretBlock_01: '炮塔',
  BPO_StationArmour_01: '装甲',
};

export function getShortLabel(id: string, fallback?: string): string {
  return SHORT_LABELS[id] ?? fallback ?? id;
}

export function getGroupsForView(viewMode: ViewMode): PaletteGroupDef[] {
  return viewMode === 'station' ? STATION_GROUPS : BUILDING_GROUPS;
}

export function findGroupForEntity(viewMode: ViewMode, entityId: string): PaletteGroupDef | undefined {
  return getGroupsForView(viewMode).find((g) => g.members.includes(entityId));
}

export function cycleVariantInGroup(
  viewMode: ViewMode,
  entityId: string,
  delta: 1 | -1 = 1
): string | null {
  const group = findGroupForEntity(viewMode, entityId);
  if (!group || group.members.length <= 1) return null;
  const idx = group.members.indexOf(entityId);
  if (idx < 0) return group.members[0];
  const nextIdx = (idx + delta + group.members.length) % group.members.length;
  return group.members[nextIdx];
}
