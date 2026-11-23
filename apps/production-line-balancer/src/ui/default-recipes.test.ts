import { describe, expect, it } from 'vitest';
import datasetJson from '../../data/main-sequence-26639889.dataset.json';
import { defaultExternalInputItemIds, indexDataset } from '../core/dataset';
import { solvePlan } from '../core/solver';
import type { Dataset } from '../core/types';
import { pickDefaultRecipe, resolveProduceForks } from './default-recipes';

const dataset = datasetJson as Dataset;
const index = indexDataset(dataset);
const defaultInputs = defaultExternalInputItemIds(dataset);

describe('default recipe resolution', () => {
  it('picks canonical base recipes over enriched or alt variants for all multi-recipe items', () => {
    const expected: Record<string, string> = {
      ITEM_CobaltPlates: 'REC_CobaltPlates',
      ITEM_NickelPlates: 'REC_NickelPlates',
      ITEM_TitaniumPlates: 'REC_TitaniumPlates',
      ITEM_MagneticCoils: 'REC_MageticCoils',
      ITEM_MaglevCoupling: 'REC_MaglevCoupling',
      ITEM_ReinforcedPlates: 'REC_ReinforcedPlates',
      ITEM_WarpFuel: 'REC_WarpFuel',
    };
    for (const [itemId, recipeId] of Object.entries(expected)) {
      const recipeIds = index.recipesByOutput.get(itemId)?.map(r => r.id) ?? [];
      expect(pickDefaultRecipe(itemId, recipeIds, index)).toBe(recipeId);
    }
  });

  it('resolves a full production chain immediately without leaving unresolved produce forks', () => {
    const recipes = resolveProduceForks(dataset, index, {
      target: { itemId: 'ITEM_AdvancedCircuits', ratePerMin: '30' },
      inputItemIds: defaultInputs,
      recipeByItem: {},
    });
    const solved = solvePlan(dataset, index, {
      target: { itemId: 'ITEM_AdvancedCircuits', ratePerMin: '30' },
      inputItemIds: defaultInputs,
      recipeByItem: recipes,
    });
    expect(solved.status).toBe('solved');
    expect(recipes.ITEM_CobaltPlates).toBe('REC_CobaltPlates');
    expect(recipes.ITEM_NickelPlates).toBe('REC_NickelPlates');
    expect(recipes.ITEM_MagneticCoils).toBe('REC_MageticCoils');
  });

  it('fills newly introduced upstream forks when switching to an alt recipe while preserving user choices', () => {
    const recipes = resolveProduceForks(dataset, index, {
      target: { itemId: 'ITEM_BasicCircuit', ratePerMin: '60' },
      inputItemIds: defaultInputs,
      recipeByItem: {
        ITEM_MagneticCoils: 'REC_MagneticCoilsAlt1',
        ITEM_NickelPlates: 'REC_NickelPlates',
      },
    });
    const solved = solvePlan(dataset, index, {
      target: { itemId: 'ITEM_BasicCircuit', ratePerMin: '60' },
      inputItemIds: defaultInputs,
      recipeByItem: recipes,
    });
    expect(solved.status).toBe('solved');
    expect(recipes.ITEM_MagneticCoils).toBe('REC_MagneticCoilsAlt1');
    expect(recipes.ITEM_CobaltPlates).toBe('REC_CobaltPlates');
  });
});
