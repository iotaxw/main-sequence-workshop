import { Rational } from '../core/rational';
import { solvePlan } from '../core/solver';
import type { Dataset, DatasetIndex, PlanInput, SolvedPlan } from '../core/types';

const ALT_PATTERN = /(Alt\d*|Enriched|Strange)/i;

function recipeBaseScore(itemId: string, recipeId: string, inputCount: number, datasetOrder: number): [number, number, number, number] {
  const stem = itemId.replace(/^ITEM_/, '');
  const exactStem = recipeId === `REC_${stem}` ? 0 : 1;
  const isAlt = ALT_PATTERN.test(recipeId) ? 1 : 0;
  return [isAlt, exactStem, inputCount, datasetOrder];
}

function compareTuples(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Deterministically picks the canonical standard (non-Alt / non-Enriched) recipe
 * for a multi-recipe item so selecting a target shows a complete plan immediately.
 */
export function pickDefaultRecipe(itemId: string, recipeIds: string[], index: DatasetIndex): string {
  let bestId = recipeIds[0]!;
  let bestScore = recipeBaseScore(itemId, bestId, index.recipes.get(bestId)?.inputs.length ?? 99, 0);
  for (let i = 1; i < recipeIds.length; i++) {
    const id = recipeIds[i]!;
    const score = recipeBaseScore(itemId, id, index.recipes.get(id)?.inputs.length ?? 99, i);
    if (compareTuples(score, bestScore) < 0) {
      bestId = id;
      bestScore = score;
    }
  }
  return bestId;
}

/**
 * Iteratively fills any unresolved 'produce' forks with deterministic standard recipes.
 * Leaves explicit 'recycle' forks untouched and keeps the solver core strictly pure.
 */
export function resolveProduceForks(
  dataset: Dataset,
  index: DatasetIndex,
  input: PlanInput,
): Record<string, string> {
  const recipeByItem: Record<string, string> = { ...input.recipeByItem };
  const limit = dataset.items.length + 1;
  for (let step = 0; step < limit; step++) {
    const result = solvePlan(dataset, index, { ...input, recipeByItem });
    if (result.status !== 'pending-forks' || result.fork.kind !== 'produce') {
      return recipeByItem;
    }
    const chosen = pickDefaultRecipe(result.fork.itemId, result.fork.recipeIds, index);
    if (recipeByItem[result.fork.itemId] === chosen) {
      return recipeByItem;
    }
    recipeByItem[result.fork.itemId] = chosen;
  }
  return recipeByItem;
}

export interface FeasibleRecycleOption {
  recipeId: string;
  /** When set, selecting this option closes a broken internal loop by removing this item from external inputs. */
  removeExternalItemId?: string;
}

/**
 * Returns only mathematically feasible recycling or loop-closure options for a byproduct item,
 * preventing dead-end conflict choices and avoiding zombie external inputs when closing a self-catalytic loop.
 */
export function feasibleRecycleOptions(
  dataset: Dataset,
  index: DatasetIndex,
  input: PlanInput,
  solvedPlan: SolvedPlan,
  byproductItemId: string,
): FeasibleRecycleOption[] {
  const consumers = dataset.recipes
    .filter(recipe => recipe.inputs.some(ingredient => ingredient.itemId === byproductItemId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (consumers.length === 0) return [];

  const activeRawIds = new Set(solvedPlan.rawInputs.map(flow => flow.itemId));
  const externalSet = new Set(input.inputItemIds);
  const options: FeasibleRecycleOption[] = [];

  for (const recipe of consumers) {
    const primaryOut = recipe.outputs.find(output => !output.isByproduct)?.itemId ?? recipe.outputs[0]?.itemId;

    // 1. Prefer closing a broken external loop directly by removing its primary output from external inputs.
    if (primaryOut && externalSet.has(primaryOut) && activeRawIds.has(primaryOut)) {
      const nextInputs = input.inputItemIds.filter(id => id !== primaryOut);
      const nextRecycleIds = (input.recycleItemIds ?? []).filter(id => id !== byproductItemId);
      const nextRecycles = { ...(input.recycleByItem ?? {}) };
      delete nextRecycles[byproductItemId];
      const probeInput: PlanInput = {
        ...input,
        inputItemIds: nextInputs,
        recycleItemIds: nextRecycleIds,
        recycleByItem: nextRecycles,
      };
      const resolved = resolveProduceForks(dataset, index, probeInput);
      const result = solvePlan(dataset, index, { ...probeInput, recipeByItem: resolved });
      if (
        result.status === 'solved'
        && result.rows.some(row => row.recipeId === recipe.id && Rational.parse(row.runsPerMin).compare(Rational.zero) > 0)
      ) {
        options.push({ recipeId: recipe.id, removeExternalItemId: primaryOut });
        continue;
      }
    }

    // 2. Otherwise check whether explicit byproduct recycling via recycleByItem yields a valid active plan.
    const nextRecycleIds = [...new Set([...(input.recycleItemIds ?? []), byproductItemId])];
    const nextRecycles = { ...(input.recycleByItem ?? {}), [byproductItemId]: recipe.id };
    const probeInput: PlanInput = {
      ...input,
      recycleItemIds: nextRecycleIds,
      recycleByItem: nextRecycles,
    };
    const resolved = resolveProduceForks(dataset, index, probeInput);
    const result = solvePlan(dataset, index, { ...probeInput, recipeByItem: resolved });
    if (
      result.status === 'solved'
      && result.rows.some(row => row.recipeId === recipe.id && Rational.parse(row.runsPerMin).compare(Rational.zero) > 0)
    ) {
      options.push({ recipeId: recipe.id });
    }
  }

  return options;
}
