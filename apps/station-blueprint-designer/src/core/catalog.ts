import rawCatalog from '../data/catalog-26639889.json';
import type { Lang } from './i18n';
import type { BuildableDef, GameCatalog, RecipeDef, StationModuleDef } from './types';

export const CATALOG: GameCatalog = rawCatalog as unknown as GameCatalog;

const moduleMap = new Map<string, StationModuleDef>();
for (const m of CATALOG.stationModules) {
  m.domain = 'station';
  moduleMap.set(m.id, m);
}
for (const m of CATALOG.shipModules ?? []) {
  m.domain = 'ship';
  moduleMap.set(m.id, m);
}

export const SHIP_MODULES: StationModuleDef[] = CATALOG.shipModules ?? [];

export function getModuleMirrorId(id: string): string | null {
  return moduleMap.get(id)?.mirrorId ?? null;
}

export function canModuleRotate(id: string, freeRotate = false): boolean {
  if (freeRotate) return true;
  const def = moduleMap.get(id);
  if (!def) return true;
  return def.canRotate !== false;
}

const buildableMap = new Map<string, BuildableDef>();
for (const b of CATALOG.buildables) {
  buildableMap.set(b.id, b);
}

export function humanizeGameId(rawId: string): string {
  const bDef = buildableMap.get(rawId);
  if (bDef) return bDef.nameEn;
  const mDef = moduleMap.get(rawId);
  if (mDef) return mDef.nameEn;
  const base = rawId
    .replace(/^(REC_|ITEM_|DAT_|BPO_)/, '')
    .replace(/^MageticCoils$/, 'MagneticCoils')
    .replace(/Alt(\d*)$/, (_m, n) => (n ? ` Alt ${n}` : ' Alt'))
    .replace(/_0?(\d+)$/, ' Mk.$1')
    .replace(/Mk(\d+)$/, ' Mk.$1')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return base || rawId;
}

const recipeMap = new Map<string, RecipeDef>();
const recipesByCrafter = new Map<string, RecipeDef[]>();
const itemNameMap = new Map<string, string>();
for (const r of CATALOG.recipes) {
  recipeMap.set(r.id, r);
  const list = recipesByCrafter.get(r.crafterId) ?? [];
  list.push(r);
  recipesByCrafter.set(r.crafterId, list);
  for (const x of [...r.inputs, ...r.outputs]) {
    if (!itemNameMap.has(x.itemId)) itemNameMap.set(x.itemId, x.nameZh);
  }
}

export interface CatalogItemEntry {
  id: string;
  nameZh: string;
  nameEn: string;
}

export const CATALOG_ITEMS: CatalogItemEntry[] = Array.from(itemNameMap.entries())
  .map(([id, nameZh]) => ({ id, nameZh, nameEn: humanizeGameId(id) }))
  .sort((a, b) => a.nameZh.localeCompare(b.nameZh, 'zh-Hans'));

export function getItemNameZh(itemId: string): string {
  return itemNameMap.get(itemId) ?? getBuildableDef(itemId)?.nameZh ?? itemId;
}

export function getItemName(itemId: string, lang: Lang): string {
  return lang === 'en' ? humanizeGameId(itemId) : getItemNameZh(itemId);
}

export function getRecipeName(recipe: RecipeDef, lang: Lang): string {
  return lang === 'en' ? humanizeGameId(recipe.id) : recipe.nameZh;
}

export function getModuleName(def: StationModuleDef, lang: Lang): string {
  return lang === 'en' ? def.nameEn : def.nameZh;
}

export function getBuildableName(def: BuildableDef, lang: Lang): string {
  return lang === 'en' ? def.nameEn : def.nameZh;
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
