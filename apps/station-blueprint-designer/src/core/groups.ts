import type { Lang } from './i18n';
import type { ViewMode } from './types';

export interface PaletteGroupDef {
  id: string;
  slot: number; // 1..9
  name: string;
  nameEn: string;
  members: string[];
}

export const BUILDING_GROUPS: PaletteGroupDef[] = [
  {
    id: 'belts',
    slot: 1,
    name: '传送带',
    nameEn: 'Belts',
    members: ['DAT_ConveyorBelt', 'DAT_ConveyorBelt2', 'DAT_ConveyorBelt3'],
  },
  {
    id: 'undergrounds',
    slot: 2,
    name: '下层带',
    nameEn: 'Underground',
    members: ['DAT_UndergroundBelt', 'DAT_UndergroundBelt_2', 'DAT_UndergroundBelt_3'],
  },
  {
    id: 'splitters',
    slot: 3,
    name: '分流器',
    nameEn: 'Splitters',
    members: ['DAT_Splitter', 'DAT_Splitter_2', 'DAT_Splitter_3'],
  },
  {
    id: 'balancers',
    slot: 4,
    name: '平衡器',
    nameEn: 'Balancers',
    members: ['DAT_BeltBalancer_01', 'DAT_BeltBalancer_02', 'DAT_BeltBalancer_03'],
  },
  {
    id: 'containers',
    slot: 5,
    name: '容器',
    nameEn: 'Storage',
    members: ['DAT_Container', 'DAT_Container_2'],
  },
  {
    id: 'production',
    slot: 6,
    name: '生产制造',
    nameEn: 'Production',
    members: [
      'DAT_Refinery',
      'DAT_Assembler',
      'DAT_EnrichmentChamber',
      'DAT_AdvancedAssembler',
      'DAT_Supercomputer',
      'DAT_GrowthChamber',
      'DAT_RelicSynthesizer',
    ],
  },
  {
    id: 'research',
    slot: 7,
    name: '实验室',
    nameEn: 'Research',
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
    id: 'facilities',
    slot: 8,
    name: '功能设施',
    nameEn: 'Facilities',
    members: [
      'DAT_WorkbenchMachine',
      'DAT_ReactorMachine',
      'DAT_Armoury',
      'DAT_Teleporter',
    ],
  },
  {
    id: 'decor',
    slot: 9,
    name: '装饰',
    nameEn: 'Decor',
    members: [
      'DAT_SignWall',
      'DAT_Chair',
      'DAT_CoffeeTable',
      'DAT_Plant_01',
    ],
  },
];

export const STATION_GROUPS: PaletteGroupDef[] = [
  {
    id: 'st-factory',
    slot: 1,
    name: '工厂模块',
    nameEn: 'Factory',
    members: [
      'BPO_Station_01',
      'BPO_Station_2x1',
      'BPO_Station_02A',
      'BPO_Station_02',
      'BPO_Station_03',
    ],
  },
  {
    id: 'st-function',
    slot: 2,
    name: '功能模块',
    nameEn: 'Utility',
    members: [
      'BPO_CommandModule',
      'BPO_Dock',
      'BPO_Dock_2',
      'BPO_MiningDroneBayBlock',
      'BPO_MiningDroneBayBlock_2',
      'BPO_SolarPanelBlock',
      'BPO_SolarPanelBlock_02',
      'BPO_SolarPanelBlock_03',
      'BPO_ScannerModule',
    ],
  },
  {
    id: 'st-other',
    slot: 3,
    name: '其它模块',
    nameEn: 'Special',
    members: [
      'BPO_ShipyardCore',
      'BPO_ShipyardSide',
      'BPO_ShipyardCore_02',
      'BPO_DeepSpaceObservatory',
      'BPO_StationArmour_01',
      'BPO_StationArmour_01B',
      'BPO_StationTurretBlock_01',
    ],
  },
  {
    id: 'st-connect',
    slot: 4,
    name: '连接模块',
    nameEn: 'Connect',
    members: [
      'BPO_ElevatorBlock_03',
      'BPO_ElevatorBlock_02A',
      'BPO_StationCorridor_01',
      'BPO_StationCorner_01',
      'BPO_StationAdapter_01',
      'BPO_StationCorridor_02',
    ],
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
  BPO_StationArmour_01: '装甲·顶',
  BPO_StationArmour_01B: '装甲·底',
};

const SHORT_LABELS_EN: Record<string, string> = {
  DAT_ConveyorBelt: 'Belt I',
  DAT_ConveyorBelt2: 'Belt II',
  DAT_ConveyorBelt3: 'Belt III',
  DAT_UndergroundBelt: 'UG I',
  DAT_UndergroundBelt_2: 'UG II',
  DAT_UndergroundBelt_3: 'UG III',
  DAT_Splitter: 'Split I',
  DAT_Splitter_2: 'Split II',
  DAT_Splitter_3: 'Split III',
  DAT_BeltBalancer_01: 'Bal I',
  DAT_BeltBalancer_02: 'Bal II',
  DAT_BeltBalancer_03: 'Bal III',
  DAT_Container: 'Box I',
  DAT_Container_2: 'Box II',
  DAT_Refinery: 'Refinery',
  DAT_Assembler: 'Asm I',
  DAT_EnrichmentChamber: 'Enrich',
  DAT_AdvancedAssembler: 'Asm II',
  DAT_WorkbenchMachine: 'Bench',
  DAT_Supercomputer: 'SuperC',
  DAT_GrowthChamber: 'Growth',
  DAT_RelicSynthesizer: 'Relic',
  DAT_Armoury: 'Armoury',
  DAT_Teleporter: 'Teleport',
  DAT_MatSciLab: 'Lab I',
  DAT_CompSciLab: 'Lab II',
  DAT_ElectroSciLab: 'Lab III',
  DAT_QuantumSciLab: 'Lab IV',
  DAT_AstroSciLab: 'Lab V',
  DAT_XenoSciLab: 'Lab VI',
  DAT_RelicAnalyzer: 'Analyze',
  DAT_ReactorMachine: 'Reactor',
  DAT_SignWall: 'Sign',
  DAT_Chair: 'Chair',
  DAT_CoffeeTable: 'Table',
  DAT_Plant_01: 'Plant',
  BPO_Station_01: '1×1',
  BPO_Station_2x1: '2×1',
  BPO_Station_02A: '2×2 A',
  BPO_Station_02: '2×2 B',
  BPO_Station_03: '2×2 C',
  BPO_StationAdapter_01: 'Adapter',
  BPO_StationCorridor_01: 'Corr 1',
  BPO_StationCorridor_02: 'Corr 2',
  BPO_StationCorner_01: 'Corner',
  BPO_ElevatorBlock_03: 'Elev 1',
  BPO_ElevatorBlock_02A: 'Elev 2',
  BPO_CommandModule: 'Cmd',
  BPO_Dock: 'Dock I',
  BPO_Dock_2: 'Dock II',
  BPO_ScannerModule: 'Scan',
  BPO_SolarPanelBlock: 'Solar I',
  BPO_SolarPanelBlock_02: 'Solar II',
  BPO_SolarPanelBlock_03: 'Solar III',
  BPO_MiningDroneBayBlock: 'Mine I',
  BPO_MiningDroneBayBlock_2: 'Mine II',
  BPO_ShipyardCore: 'Yard I',
  BPO_ShipyardCore_02: 'Yard II',
  BPO_ShipyardSide: 'Yard S',
  BPO_DeepSpaceObservatory: 'Obs',
  BPO_StationTurretBlock_01: 'Turret',
  BPO_StationArmour_01: 'Arm Top',
  BPO_StationArmour_01B: 'Arm Bot',
};

export function getShortLabel(id: string, fallback?: string, lang: Lang = 'zh'): string {
  if (lang === 'en') {
    return SHORT_LABELS_EN[id] ?? fallback ?? id;
  }
  return SHORT_LABELS[id] ?? fallback ?? id;
}

export function getGroupName(group: PaletteGroupDef, lang: Lang): string {
  return lang === 'en' ? group.nameEn : group.name;
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
