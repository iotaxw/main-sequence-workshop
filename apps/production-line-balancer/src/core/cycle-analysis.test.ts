import { describe, expect, it } from 'vitest';
import datasetJson from '../../data/main-sequence-26639889.dataset.json';
import { indexDataset } from './dataset';
import { Rational } from './rational';
import { solveLinear, solvePlan } from './solver';
import type { Dataset } from './types';

const dataset = datasetJson as Dataset;
const index = indexDataset(dataset);
const cycleItems = [
  'ITEM_AlphaProtein',
  'ITEM_BetaProtein',
  'ITEM_Biomass',
  'ITEM_Enzyme',
  'ITEM_Xenoarchaea',
  'ITEM_Xenobacteria',
  'ITEM_Xenoeukarya',
];
const cycleItemSet = new Set(cycleItems);
const externalItems = dataset.items.map(item => item.id).filter(itemId => !cycleItemSet.has(itemId));
const biomassRecipes = [undefined, 'REC_AlphaProtein', 'REC_BetaProtein', 'REC_Enzyme'] as const;
const cycleRecipeIds = [
  'REC_AlphaProtein',
  'REC_BetaProtein',
  'REC_Enzyme',
  'REC_XenoarchaeaRecycling',
  'REC_XenobacteriaRecycling',
  'REC_XenoEukaryaRecycling',
];
const cycleRecipes = cycleRecipeIds.map(recipeId => index.recipes.get(recipeId)!);

function coefficient(recipeIndex: number, itemId: string): Rational {
  const recipe = cycleRecipes[recipeIndex]!;
  let result = Rational.zero;
  for (const input of recipe.inputs) {
    if (input.itemId === itemId) result = result.subtract(Rational.parse(input.quantity));
  }
  for (const output of recipe.outputs) {
    if (output.itemId === itemId) result = result.add(Rational.parse(output.quantity));
  }
  return result;
}

describe('current game cycle structure', () => {
  it.each(['ITEM_AlphaProtein', 'ITEM_BetaProtein', 'ITEM_Enzyme'])(
    'can close %s with at most one production recipe per item',
    target => {
      const closed = biomassRecipes.filter(recipeId => {
        const result = solvePlan(dataset, index, {
          target: { itemId: target, ratePerMin: '10' },
          inputItemIds: externalItems,
          recipeByItem: recipeId ? { ITEM_Biomass: recipeId } : {},
        });
        return result.status === 'solved' && result.byproducts.length === 0;
      });
      expect(closed.length).toBeGreaterThan(0);
    },
  );

  it.each(cycleItems)('does not require parallel recipes to determine the zero-surplus feasibility of %s', target => {
    const rows = cycleItems.map(itemId => [
      ...cycleRecipes.map((_, recipeIndex) => coefficient(recipeIndex, itemId)),
      itemId === target ? Rational.of(10n) : Rational.zero,
    ]);
    const result = solveLinear(rows);
    if (target === 'ITEM_Biomass' || target.startsWith('ITEM_Xeno')) {
      expect(result).toBe('conflict');
    } else {
      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.every(rate => rate.compare(Rational.zero) >= 0)).toBe(true);
      }
    }
  });
});
