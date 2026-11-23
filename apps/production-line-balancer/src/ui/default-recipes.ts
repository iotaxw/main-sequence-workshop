import { solvePlan } from '../core/solver';
import type { Dataset, DatasetIndex, PlanInput } from '../core/types';

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
