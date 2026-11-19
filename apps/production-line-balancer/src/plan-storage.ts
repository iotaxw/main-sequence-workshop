import { defaultExternalInputItemIds } from './core/dataset';
import type { Dataset, Issue, Language } from './core/types';

const STORAGE_KEY = 'main-sequence.planner.v1';

export interface StoredPlan {
  schemaVersion: 2;
  datasetBuildId: string;
  language?: Language;
  targetItemId: string | null;
  ratePerMin: string;
  inputItemIds: string[];
  recipeByItem: Record<string, string>;
  recycleItemIds: string[];
  recycleByItem: Record<string, string>;
}

type LegacyStoredPlan = Omit<StoredPlan, 'schemaVersion'> & { schemaVersion: 1 };
type VersionedStoredPlan = StoredPlan | LegacyStoredPlan;

export const emptyStoredPlan: StoredPlan = {
  schemaVersion: 2,
  datasetBuildId: '',
  language: 'zh-Hans',
  targetItemId: null,
  ratePerMin: '60',
  inputItemIds: [],
  recipeByItem: {},
  recycleItemIds: [],
  recycleByItem: {},
};

function stringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string');
}

function valid(value: unknown): value is VersionedStoredPlan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Partial<VersionedStoredPlan>;
  return (plan.schemaVersion === 1 || plan.schemaVersion === 2)
    && typeof plan.datasetBuildId === 'string'
    && (plan.targetItemId === null || typeof plan.targetItemId === 'string')
    && (plan.language === undefined || plan.language === 'zh-Hans' || plan.language === 'en')
    && typeof plan.ratePerMin === 'string'
    && Array.isArray(plan.inputItemIds) && plan.inputItemIds.every(item => typeof item === 'string')
    && stringRecord(plan.recipeByItem)
    && Array.isArray(plan.recycleItemIds) && plan.recycleItemIds.every(item => typeof item === 'string')
    && stringRecord(plan.recycleByItem);
}

function validReferences(plan: VersionedStoredPlan, dataset: Dataset): boolean {
  const items = new Set(dataset.items.map(item => item.id));
  const recipes = new Map(dataset.recipes.map(recipe => [recipe.id, recipe]));
  if (plan.targetItemId !== null && !items.has(plan.targetItemId)) return false;
  if (!plan.inputItemIds.every(itemId => items.has(itemId))) return false;
  if (!plan.recycleItemIds.every(itemId => items.has(itemId))) return false;
  if (!Object.entries(plan.recipeByItem).every(([itemId, recipeId]) =>
    recipes.get(recipeId)?.outputs.some(output => output.itemId === itemId))) return false;
  return Object.entries(plan.recycleByItem).every(([itemId, recipeId]) =>
    recipes.get(recipeId)?.inputs.some(input => input.itemId === itemId));
}

function newPlan(dataset: Dataset): StoredPlan {
  return {
    ...emptyStoredPlan,
    datasetBuildId: dataset.game.buildId,
    inputItemIds: defaultExternalInputItemIds(dataset),
  };
}

function migratePlan(plan: VersionedStoredPlan, dataset: Dataset): StoredPlan {
  if (plan.schemaVersion === 2) return plan;
  const hasLegacyDefaults = dataset.rawItemIds.every(itemId => plan.inputItemIds.includes(itemId));
  if (!hasLegacyDefaults) return { ...plan, schemaVersion: 2 };
  const defaultInputs = new Set(defaultExternalInputItemIds(dataset));
  const rawItems = new Set(dataset.rawItemIds);
  return {
    ...plan,
    schemaVersion: 2,
    inputItemIds: plan.inputItemIds.filter(itemId => !rawItems.has(itemId) || defaultInputs.has(itemId)),
  };
}

export function loadPlan(dataset: Dataset): { plan: StoredPlan; issues: Issue[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { plan: newPlan(dataset), issues: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed)) {
      return {
        plan: newPlan(dataset),
        issues: [{ kind: 'invalid-value', message: '本地方案结构无效，已阻止加载', itemIds: [], recipeIds: [] }],
      };
    }
    if (parsed.datasetBuildId !== dataset.game.buildId) {
      return {
        plan: newPlan(dataset),
        issues: [{ kind: 'invalid-selection', message: `方案 Build ${parsed.datasetBuildId} 与当前 ${dataset.game.buildId} 不一致，需重新选择`, itemIds: [], recipeIds: [] }],
      };
    }
    if (!validReferences(parsed, dataset)) {
      return {
        plan: newPlan(dataset),
        issues: [{ kind: 'invalid-selection', message: '本地方案包含已失效的物品或配方引用，已阻止加载', itemIds: [], recipeIds: [] }],
      };
    }
    return { plan: migratePlan(parsed, dataset), issues: [] };
  } catch {
    return {
      plan: newPlan(dataset),
      issues: [{ kind: 'invalid-value', message: '本地方案读取失败，已阻止加载', itemIds: [], recipeIds: [] }],
    };
  }
}

export function savePlan(plan: StoredPlan): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
}
