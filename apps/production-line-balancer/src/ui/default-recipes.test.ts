import { describe, expect, it } from 'vitest';
import datasetJson from '../../data/main-sequence-26639889.dataset.json';
import { defaultExternalInputItemIds, indexDataset } from '../core/dataset';
import { solvePlan } from '../core/solver';
import type { Dataset } from '../core/types';
import { feasibleRecycleOptions, pickDefaultRecipe, resolveProduceForks } from './default-recipes';

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

  it('closes AlphaProtein Biomass surplus cleanly to zero net byproducts via XenoEukaryaRecycling', () => {
    const inputsWithSeed = [...defaultInputs, 'ITEM_Xenoeukarya'];
    const before = solvePlan(dataset, index, {
      target: { itemId: 'ITEM_AlphaProtein', ratePerMin: '30' },
      inputItemIds: inputsWithSeed,
      recipeByItem: {},
    });
    expect(before.status).toBe('solved');
    if (before.status === 'solved') {
      expect(before.byproducts).toEqual([{ itemId: 'ITEM_Biomass', ratePerMin: '30' }]);
    }
    const after = solvePlan(dataset, index, {
      target: { itemId: 'ITEM_AlphaProtein', ratePerMin: '30' },
      inputItemIds: inputsWithSeed,
      recipeByItem: {},
      recycleItemIds: ['ITEM_Biomass'],
      recycleByItem: { ITEM_Biomass: 'REC_XenoEukaryaRecycling' },
    });
    expect(after.status).toBe('solved');
    if (after.status === 'solved') {
      expect(after.byproducts).toEqual([]);
      expect(after.rawInputs.some(flow => flow.itemId === 'ITEM_Xenoeukarya')).toBe(false);
    }
  });

  it('solves every non-catalyst craftable item cleanly with default inputs and zero net byproducts', () => {
    const conservedCatalysts = new Set([
      'ITEM_Biomass',
      'ITEM_Xenobacteria',
      'ITEM_Xenoeukarya',
      'ITEM_Xenoarchaea',
    ]);
    const targets = dataset.items.filter(
      item => !defaultInputs.includes(item.id) && !conservedCatalysts.has(item.id),
    );
    expect(targets.length).toBe(64);
    for (const item of targets) {
      const baseInput = {
        target: { itemId: item.id, ratePerMin: '30' },
        inputItemIds: defaultInputs,
        recipeByItem: {},
      };
      const recipes = resolveProduceForks(dataset, index, baseInput);
      const solved = solvePlan(dataset, index, { ...baseInput, recipeByItem: recipes });
      expect(solved.status, `default plan for ${item.id}`).toBe('solved');
      if (solved.status === 'solved') {
        expect(solved.byproducts, `byproducts for ${item.id}`).toEqual([]);
        // Every non-target card's primary output can be marked as external input cleanly.
        for (const row of solved.rows) {
          const primary = row.outputs.find(output => !output.isByproduct)?.itemId ?? row.outputs[0]?.itemId;
          if (!primary || primary === item.id || defaultInputs.includes(primary)) continue;
          const nextInputs = [...defaultInputs, primary];
          const nextRecipes = resolveProduceForks(dataset, index, {
            ...baseInput,
            inputItemIds: nextInputs,
            recipeByItem: recipes,
          });
          const nextSolved = solvePlan(dataset, index, {
            ...baseInput,
            inputItemIds: nextInputs,
            recipeByItem: nextRecipes,
          });
          expect(nextSolved.status, `${item.id} after marking ${primary} external`).toBe('solved');
        }
      }
    }
  });

  it('filters recycle options to only feasible choices and closes multi-culture loops without zombie inputs', () => {
    // 1. Single external culture on AlphaProtein: only XenoEukaryaRecycling is feasible (no conflict options).
    const singleInput = {
      target: { itemId: 'ITEM_AlphaProtein', ratePerMin: '30' },
      inputItemIds: [...defaultInputs, 'ITEM_Xenoeukarya'],
      recipeByItem: {},
    };
    const singlePlan = solvePlan(dataset, index, singleInput);
    expect(singlePlan.status).toBe('solved');
    if (singlePlan.status === 'solved') {
      const options = feasibleRecycleOptions(dataset, index, singleInput, singlePlan, 'ITEM_Biomass');
      expect(options).toEqual([
        { recipeId: 'REC_XenoEukaryaRecycling', removeExternalItemId: 'ITEM_Xenoeukarya' },
      ]);
    }

    // 2. Multi-culture external inputs on Biolattice: step-by-step closure removes each culture cleanly down to 0.
    let inputs = [...defaultInputs, 'ITEM_Xenobacteria', 'ITEM_Xenoeukarya', 'ITEM_Xenoarchaea'];
    for (let step = 0; step < 3; step++) {
      const planInput = {
        target: { itemId: 'ITEM_Biolattice', ratePerMin: '30' },
        inputItemIds: inputs,
        recipeByItem: {},
      };
      const solved = solvePlan(dataset, index, planInput);
      expect(solved.status).toBe('solved');
      if (solved.status !== 'solved') break;
      const options = feasibleRecycleOptions(dataset, index, planInput, solved, 'ITEM_Biomass');
      expect(options.length).toBe(3 - step);
      expect(options.every(option => option.removeExternalItemId !== undefined)).toBe(true);
      inputs = inputs.filter(id => id !== options[0]!.removeExternalItemId);
    }
    expect(inputs).toEqual(defaultInputs);

    // 3. Targeting Biomass with Xenobacteria external outputs Enzyme surplus; every offered recycle option must solve cleanly with 0 remaining Enzyme.
    const biomassInput = {
      target: { itemId: 'ITEM_Biomass', ratePerMin: '30' },
      inputItemIds: [...defaultInputs, 'ITEM_Xenobacteria'],
      recipeByItem: { ITEM_Biomass: 'REC_Enzyme' },
    };
    const biomassPlan = solvePlan(dataset, index, biomassInput);
    expect(biomassPlan.status).toBe('solved');
    if (biomassPlan.status === 'solved') {
      expect(biomassPlan.byproducts).toEqual([{ itemId: 'ITEM_Enzyme', ratePerMin: '30' }]);
      const options = feasibleRecycleOptions(dataset, index, biomassInput, biomassPlan, 'ITEM_Enzyme');
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        const probeInput = {
          ...biomassInput,
          recycleItemIds: ['ITEM_Enzyme'],
          recycleByItem: { ITEM_Enzyme: option.recipeId },
        };
        const resolved = resolveProduceForks(dataset, index, probeInput);
        const recycled = solvePlan(dataset, index, { ...probeInput, recipeByItem: resolved });
        expect(recycled.status, `recycle Enzyme via ${option.recipeId}`).toBe('solved');
        if (recycled.status === 'solved') {
          expect(recycled.byproducts.some(flow => flow.itemId === 'ITEM_Enzyme')).toBe(false);
        }
      }
    }
  });
});
