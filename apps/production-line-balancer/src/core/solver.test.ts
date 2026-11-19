import { describe, expect, it } from 'vitest';
import datasetJson from '../../data/main-sequence-26639889.dataset.json';
import { defaultExternalInputItemIds, indexDataset } from './dataset';
import { Rational } from './rational';
import { solvePlan } from './solver';
import type { Dataset, PlanInput, SolvedPlan } from './types';

const dataset = datasetJson as Dataset;
const index = indexDataset(dataset);

function input(itemId: string, ratePerMin: string, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    target: { itemId, ratePerMin },
    inputItemIds: defaultExternalInputItemIds(dataset),
    recipeByItem: {},
    ...overrides,
  };
}

function solved(result: ReturnType<typeof solvePlan>): SolvedPlan {
  if (result.status !== 'solved') {
    throw new Error(`Expected solved plan, received ${JSON.stringify(result)}.`);
  }
  return result;
}

describe('Rational', () => {
  it('keeps decimal arithmetic and durations exact', () => {
    expect(Rational.parse('0.1').add(Rational.parse('0.2')).toString()).toBe('3/10');
    expect(Rational.parse('180/30').toString()).toBe('6');
    expect(Rational.parse('1/30').multiply(Rational.parse('60')).toString()).toBe('2');
  });

  it('formats continuous values without hiding the ceiling', () => {
    expect(Rational.parse('4.001').ceil().toString()).toBe('5');
    expect(Rational.parse('4.001').toDecimal(2, 'ceiling', false)).toBe('4.01');
    expect(Rational.parse('4').toDecimal(2, 'ceiling', false)).toBe('4.00');
    expect(Rational.parse('-1.24').toDecimal(1)).toBe('-1.2');
    expect(Rational.parse('-1.25').toDecimal(1)).toBe('-1.3');
  });
});

describe('real game dataset', () => {
  it('preserves native item and recipe order and marks unregistered items', () => {
    expect(dataset.items.slice(0, 4).map(item => item.id)).toEqual([
      'ITEM_TitaniumOre',
      'ITEM_EnrichedTitaniumOre',
      'ITEM_NickelOre',
      'ITEM_EnrichedNickelOre',
    ]);
    const registeredOrders = dataset.items.filter(item => item.nativeOrder !== null).map(item => item.nativeOrder!);
    expect(registeredOrders).toHaveLength(70);
    expect(registeredOrders[0]).toBe(0);
    expect(registeredOrders.at(-1)).toBe(70);
    expect([...registeredOrders].sort((left, right) => left - right)).toEqual(registeredOrders);
    expect(new Set(registeredOrders).size).toBe(registeredOrders.length);
    expect(dataset.items.filter(item => item.category === 'item' && item.nativeOrder === null).map(item => item.id)).toEqual([
      'ITEM_Thruster',
      'ITEM_UpgradeShipSpeed_1',
      'ITEM_UpgradeShipSpeed_2',
    ]);
    expect(dataset.recipes.find(recipe => recipe.id === 'REC_BasicCircuit')?.inputs.map(input => input.itemId)).toEqual([
      'ITEM_SiliconWafers',
      'ITEM_MagneticCoils',
    ]);
    expect(dataset.recipes.find(recipe => recipe.id === 'REC_AlphaProtein')?.outputs.map(output => output.itemId)).toEqual([
      'ITEM_AlphaProtein',
      'ITEM_Biomass',
    ]);
  });

  it('produces Protomatter from its native zero-input recipe by default', () => {
    expect(dataset.rawItemIds).toContain('ITEM_Protomatter');
    expect(defaultExternalInputItemIds(dataset)).not.toContain('ITEM_Protomatter');
    const result = solved(solvePlan(dataset, index, input('ITEM_Protomatter', '60')));
    expect(result.rows).toHaveLength(1);
    expect(result.rawInputs).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      recipeId: 'REC_Protomatter',
      machineId: 'CRAFT_RelicSynthesizer',
      runsPerMin: '60',
      inputs: [],
      outputs: [{ itemId: 'ITEM_Protomatter', ratePerMin: '60', isByproduct: false }],
      machines: { exact: '1', built: '1' },
      powerKW: { exact: '54000', built: '54000' },
    });
  });

  it('keeps explicitly supplied Protomatter external', () => {
    const externalInputs = defaultExternalInputItemIds(dataset)
      .filter(itemId => itemId !== 'ITEM_CobaltOre')
      .concat('ITEM_Protomatter');
    const result = solved(solvePlan(dataset, index, input('ITEM_CobaltPlates', '30', {
      inputItemIds: externalInputs,
      recipeByItem: { ITEM_CobaltPlates: 'REC_CobaltPlates' },
    })));
    expect(result.rows.some(row => row.recipeId === 'REC_Protomatter')).toBe(false);
    expect(result.rows.some(row => row.recipeId === 'REC_CobaltSynthesis')).toBe(true);
    expect(result.rawInputs).toContainEqual({ itemId: 'ITEM_Protomatter', ratePerMin: '60' });
  });

  it('requires a recipe fork before calculating', () => {
    const result = solvePlan(dataset, index, input('ITEM_BasicCircuit', '10'));
    expect(result).toMatchObject({
      status: 'pending-forks',
      fork: { itemId: 'ITEM_MagneticCoils', kind: 'produce' },
    });
    expect(result).not.toHaveProperty('rows');
  });

  it('balances a real production chain and computes machine power', () => {
    const result = solved(solvePlan(dataset, index, input('ITEM_BasicCircuit', '10', {
      recipeByItem: {
        ITEM_MagneticCoils: 'REC_MageticCoils',
        ITEM_NickelPlates: 'REC_NickelPlates',
      },
    })));
    expect(result.rawInputs).toEqual([
      { itemId: 'ITEM_NickelOre', ratePerMin: '20' },
      { itemId: 'ITEM_Silica', ratePerMin: '20' },
    ]);
    expect(result.rows.find(row => row.recipeId === 'REC_BasicCircuit')).toMatchObject({
      recipeId: 'REC_BasicCircuit',
      machineId: 'CRAFT_Assembler',
      runsPerMin: '10',
      machines: { exact: '1', built: '1' },
      powerKW: { exact: '6000', built: '6000' },
    });
  });

  it('keeps continuous machines separate from built machines and power', () => {
    const result = solved(solvePlan(dataset, index, input('ITEM_BasicCircuit', '5', {
      recipeByItem: {
        ITEM_MagneticCoils: 'REC_MageticCoils',
        ITEM_NickelPlates: 'REC_NickelPlates',
      },
    })));
    expect(result.rows.find(row => row.recipeId === 'REC_BasicCircuit')).toMatchObject({
      machines: { exact: '1/2', built: '1' },
      powerKW: { exact: '3000', built: '6000' },
    });
  });

  it('computes power for both deep space observatory recipes', () => {
    const survey = solved(solvePlan(dataset, index, input('ITEM_StellarSurveyData', '5', {
      inputItemIds: [...defaultExternalInputItemIds(dataset), 'ITEM_AdvancedCircuits'],
    })));
    expect(survey.rows.find(row => row.recipeId === 'REC_ObservedStellarSurveyData')).toMatchObject({
      machines: { exact: '1/2', built: '1' },
      powerKW: { exact: '48000', built: '96000' },
    });
    expect(survey.summary.powerKW).toEqual({ exact: '48000', built: '96000' });

    const warpFuel = solved(solvePlan(dataset, index, input('ITEM_WarpFuel', '15', {
      inputItemIds: [...defaultExternalInputItemIds(dataset), 'ITEM_StrangeMatterCrystal'],
      recipeByItem: { ITEM_WarpFuel: 'REC_StrangeWarpFuel' },
    })));
    expect(warpFuel.rows.find(row => row.recipeId === 'REC_StrangeWarpFuel')).toMatchObject({
      machines: { exact: '1', built: '1' },
      powerKW: { exact: '96000', built: '96000' },
    });
    expect(warpFuel.summary.powerKW).toEqual({ exact: '96000', built: '96000' });
  });

  it('retains ExtraOutputs as a byproduct', () => {
    const result = solved(solvePlan(dataset, index, input('ITEM_AlphaProtein', '10', {
      inputItemIds: [
        ...defaultExternalInputItemIds(dataset),
        'ITEM_Graphite',
        'ITEM_WaterIce',
        'ITEM_Xenobacteria',
        'ITEM_Xenoeukarya',
      ],
    })));
    expect(result.byproducts).toContainEqual({ itemId: 'ITEM_Biomass', ratePerMin: '20' });
  });

  it('can close the seed loop and leave only unused biomass', () => {
    const result = solved(solvePlan(dataset, index, input('ITEM_AlphaProtein', '10', {
      inputItemIds: [...defaultExternalInputItemIds(dataset), 'ITEM_Graphite', 'ITEM_WaterIce', 'ITEM_Xenoeukarya'],
    })));
    expect(result.rows.find(row => row.recipeId === 'REC_XenobacteriaRecycling')?.runsPerMin).toBe('10');
    expect(result.byproducts).toContainEqual({ itemId: 'ITEM_Biomass', ratePerMin: '10' });
  });

  it('uses the same fork logic for an explicit byproduct recycle request', () => {
    const pending = solvePlan(dataset, index, input('ITEM_AlphaProtein', '10', {
      inputItemIds: [
        ...defaultExternalInputItemIds(dataset),
        'ITEM_Graphite',
        'ITEM_WaterIce',
        'ITEM_Xenobacteria',
        'ITEM_Xenoeukarya',
      ],
      recycleItemIds: ['ITEM_Biomass'],
    }));
    expect(pending).toMatchObject({
      status: 'pending-forks',
      fork: { itemId: 'ITEM_Biomass', kind: 'recycle' },
    });
    const result = solved(solvePlan(dataset, index, input('ITEM_AlphaProtein', '10', {
      inputItemIds: [
        ...defaultExternalInputItemIds(dataset),
        'ITEM_Graphite',
        'ITEM_WaterIce',
        'ITEM_Xenobacteria',
        'ITEM_Xenoeukarya',
      ],
      recycleByItem: { ITEM_Biomass: 'REC_XenobacteriaRecycling' },
    })));
    expect(result.byproducts).not.toContainEqual({ itemId: 'ITEM_Biomass', ratePerMin: '20' });
    expect(result.byproducts).toContainEqual({ itemId: 'ITEM_Xenobacteria', ratePerMin: '10' });
  });

  it('rejects recycling more biomass than the closed network can supply', () => {
    const result = solvePlan(dataset, index, input('ITEM_AlphaProtein', '10', {
      inputItemIds: [...defaultExternalInputItemIds(dataset), 'ITEM_Graphite', 'ITEM_WaterIce', 'ITEM_Xenoeukarya'],
      recycleByItem: { ITEM_Biomass: 'REC_XenobacteriaRecycling' },
    }));
    expect(result).toMatchObject({ status: 'invalid' });
    expect(result).not.toHaveProperty('rows');
  });
});
