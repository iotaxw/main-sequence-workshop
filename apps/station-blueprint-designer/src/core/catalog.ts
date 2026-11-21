import rawCatalog from '../data/catalog-26639889.json';
import type { BuildableDef, GameCatalog, RecipeDef, StationModuleDef } from './types';

export const CATALOG: GameCatalog = rawCatalog as GameCatalog;

const moduleMap = new Map<string, StationModuleDef>();
for (const m of CATALOG.stationModules) {
  moduleMap.set(m.id, m);
}

const buildableMap = new Map<string, BuildableDef>();
for (const b of CATALOG.buildables) {
  buildableMap.set(b.id, b);
}

const recipeMap = new Map<string, RecipeDef>();
const recipesByCrafter = new Map<string, RecipeDef[]>();
for (const r of CATALOG.recipes) {
  recipeMap.set(r.id, r);
  const list = recipesByCrafter.get(r.crafterId) ?? [];
  list.push(r);
  recipesByCrafter.set(r.crafterId, list);
}

export function getModuleDef(id: string): StationModuleDef | undefined {
  return moduleMap.get(id);
}

export function getBuildableDef(id: string): BuildableDef | undefined {
  return buildableMap.get(id);
}

export function getRecipeDef(id: string): RecipeDef | undefined {
  return recipeMap.get(id);
}

export function getRecipesForCrafter(crafterId: string | null): RecipeDef[] {
  if (!crafterId) return [];
  return recipesByCrafter.get(crafterId) ?? [];
}

export const STATION_CATEGORIES = Array.from(
  new Map(CATALOG.stationModules.map((m) => [m.categoryEn, { en: m.categoryEn, zh: m.categoryZh }])).values()
);

export const BUILDABLE_CATEGORIES = Array.from(
  new Map(CATALOG.buildables.map((b) => [b.categoryEn, { en: b.categoryEn, zh: b.categoryZh }])).values()
);

export const HOTBAR_MODULES: string[] = [
  'BPO_Station_02A',
  'BPO_Station_02',
  'BPO_Station_03',
  'BPO_Station_01',
  'BPO_Station_2x1',
  'BPO_StationAdapter_01',
  'BPO_StationCorridor_01',
  'BPO_ElevatorBlock_03',
  'BPO_ElevatorBlock_02A',
];

export const HOTBAR_BUILDINGS: string[] = [
  'DAT_ConveyorBelt',
  'DAT_UndergroundBelt',
  'DAT_Splitter',
  'DAT_BeltBalancer_01',
  'DAT_Container',
  'DAT_Refinery',
  'DAT_Assembler',
  'DAT_AdvancedAssembler',
  'DAT_Supercomputer',
];
