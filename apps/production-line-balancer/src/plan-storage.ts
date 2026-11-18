import type { Dataset, Issue, Language } from './core/types';

const STORAGE_KEY = 'main-sequence.planner.v1';

export interface StoredPlan {
  schemaVersion: 1;
  datasetBuildId: string;
  language?: Language;
  targetItemId: string | null;
  ratePerMin: string;
  inputItemIds: string[];
  recipeByItem: Record<string, string>;
  recycleItemIds: string[];
  recycleByItem: Record<string, string>;
}

export const emptyStoredPlan: StoredPlan = {
  schemaVersion: 1,
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

function valid(value: unknown): value is StoredPlan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Partial<StoredPlan>;
  return plan.schemaVersion === 1
    && typeof plan.datasetBuildId === 'string'
    && (plan.targetItemId === null || typeof plan.targetItemId === 'string')
    && (plan.language === undefined || plan.language === 'zh-Hans' || plan.language === 'en')
    && typeof plan.ratePerMin === 'string'
    && Array.isArray(plan.inputItemIds) && plan.inputItemIds.every(item => typeof item === 'string')
    && stringRecord(plan.recipeByItem)
    && Array.isArray(plan.recycleItemIds) && plan.recycleItemIds.every(item => typeof item === 'string')
    && stringRecord(plan.recycleByItem);
}

function validReferences(plan: StoredPlan, dataset: Dataset): boolean {
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

export function loadPlan(dataset: Dataset): { plan: StoredPlan; issues: Issue[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { plan: { ...emptyStoredPlan, datasetBuildId: dataset.game.buildId, inputItemIds: dataset.rawItemIds }, issues: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed)) {
      return {
        plan: { ...emptyStoredPlan, datasetBuildId: dataset.game.buildId, inputItemIds: dataset.rawItemIds },
        issues: [{ kind: 'invalid-value', message: '本地方案结构无效，已阻止加载', itemIds: [], recipeIds: [] }],
      };
    }
    if (parsed.datasetBuildId !== dataset.game.buildId) {
      return {
        plan: { ...emptyStoredPlan, datasetBuildId: dataset.game.buildId, inputItemIds: dataset.rawItemIds },
        issues: [{ kind: 'invalid-selection', message: `方案 Build ${parsed.datasetBuildId} 与当前 ${dataset.game.buildId} 不一致，需重新选择`, itemIds: [], recipeIds: [] }],
      };
    }
    if (!validReferences(parsed, dataset)) {
      return {
        plan: { ...emptyStoredPlan, datasetBuildId: dataset.game.buildId, inputItemIds: dataset.rawItemIds },
        issues: [{ kind: 'invalid-selection', message: '本地方案包含已失效的物品或配方引用，已阻止加载', itemIds: [], recipeIds: [] }],
      };
    }
    return { plan: parsed, issues: [] };
  } catch {
    return {
      plan: { ...emptyStoredPlan, datasetBuildId: dataset.game.buildId, inputItemIds: dataset.rawItemIds },
      issues: [{ kind: 'invalid-value', message: '本地方案读取失败，已阻止加载', itemIds: [], recipeIds: [] }],
    };
  }
}

export function savePlan(plan: StoredPlan): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
}
