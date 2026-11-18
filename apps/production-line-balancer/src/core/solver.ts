import { Rational } from './rational';
import type {
  Dataset,
  DatasetIndex,
  Flow,
  InvalidPlan,
  Issue,
  PlanInput,
  PlanResult,
  RecipeDefinition,
  RecipeRow,
} from './types';

const sixty = Rational.of(60n);

function invalid(kind: Issue['kind'], message: string, itemIds: string[] = [], recipeIds: string[] = []): InvalidPlan {
  return {
    status: 'invalid',
    issues: [{ kind, message, itemIds, recipeIds }],
  };
}

export function solveLinear(rows: Rational[][]): Rational[] | 'conflict' | 'indeterminate' {
  if (rows.length === 0 || rows[0]!.length < 2) {
    return 'indeterminate';
  }
  const variableCount = rows[0]!.length - 1;
  if (rows.some(row => row.length !== variableCount + 1)) {
    throw new Error('Linear system rows have inconsistent sizes.');
  }
  const matrix = rows.map(row => [...row]);
  const pivotRows = new Map<number, number>();
  let rank = 0;
  for (let column = 0; column < variableCount; column++) {
    let pivot = rank;
    while (pivot < matrix.length && matrix[pivot]![column]!.isZero()) {
      pivot++;
    }
    if (pivot === matrix.length) {
      continue;
    }
    [matrix[rank], matrix[pivot]] = [matrix[pivot]!, matrix[rank]!];
    const pivotValue = matrix[rank]![column]!;
    matrix[rank] = matrix[rank]!.map(value => value.divide(pivotValue));
    for (let row = 0; row < matrix.length; row++) {
      if (row === rank) {
        continue;
      }
      const factor = matrix[row]![column]!;
      if (factor.isZero()) {
        continue;
      }
      matrix[row] = matrix[row]!.map((value, index) => value.subtract(factor.multiply(matrix[rank]![index]!)));
    }
    pivotRows.set(column, rank);
    rank++;
  }
  for (const row of matrix) {
    if (row.slice(0, variableCount).every(value => value.isZero()) && !row[variableCount]!.isZero()) {
      return 'conflict';
    }
  }
  if (rank < variableCount) {
    return 'indeterminate';
  }
  return Array.from({ length: variableCount }, (_, column) => matrix[pivotRows.get(column)!]![variableCount]!);
}

function netCoefficient(recipe: RecipeDefinition, itemId: string): Rational {
  let coefficient = Rational.zero;
  for (const input of recipe.inputs) {
    if (input.itemId === itemId) {
      coefficient = coefficient.subtract(Rational.parse(input.quantity));
    }
  }
  for (const output of recipe.outputs) {
    if (output.itemId === itemId) {
      coefficient = coefficient.add(Rational.parse(output.quantity));
    }
  }
  return coefficient;
}

export function solvePlan(dataset: Dataset, index: DatasetIndex, input: PlanInput): PlanResult {
  const targetRate = Rational.parse(input.target.ratePerMin);
  if (targetRate.compare(Rational.zero) <= 0) {
    return invalid('invalid-value', 'Target rate must be positive.', [input.target.itemId]);
  }
  if (!index.items.has(input.target.itemId)) {
    return invalid('bad-reference', `Unknown target item: ${input.target.itemId}.`, [input.target.itemId]);
  }
  const inputItems = new Set(input.inputItemIds);
  for (const itemId of inputItems) {
    if (!index.items.has(itemId)) {
      return invalid('bad-reference', `Unknown external input item: ${itemId}.`, [itemId]);
    }
  }
  if (inputItems.has(input.target.itemId)) {
    return invalid('invalid-value', 'Target cannot also be an external input.', [input.target.itemId]);
  }

  const recipeByItem: Record<string, string> = { ...input.recipeByItem };
  for (const [itemId, recipeId] of Object.entries(recipeByItem)) {
    const recipe = index.recipes.get(recipeId);
    if (!index.items.has(itemId) || !recipe) {
      return invalid('bad-reference', `Unknown recipe selection: ${itemId} -> ${recipeId}.`, [itemId], [recipeId]);
    }
    if (!recipe.outputs.some(output => output.itemId === itemId)) {
      return invalid('invalid-selection', `Recipe ${recipeId} does not produce ${itemId}.`, [itemId], [recipeId]);
    }
  }
  const recycleByItem: Record<string, string> = { ...input.recycleByItem };
  for (const [itemId, recipeId] of Object.entries(recycleByItem)) {
    const recipe = index.recipes.get(recipeId);
    if (!index.items.has(itemId) || !recipe) {
      return invalid('bad-reference', `Unknown recycle selection: ${itemId} -> ${recipeId}.`, [itemId], [recipeId]);
    }
    if (!recipe.inputs.some(ingredient => ingredient.itemId === itemId)) {
      return invalid('invalid-selection', `Recipe ${recipeId} does not consume ${itemId}.`, [itemId], [recipeId]);
    }
  }

  const requiredRecipes = new Map<string, RecipeDefinition>();
  const visited = new Set<string>();
  const recycled = new Set<string>();
  const queue: { itemId: string; kind: 'produce' | 'recycle' }[] = [
    { itemId: input.target.itemId, kind: 'produce' },
  ];
  const recycleItems = [...new Set([...input.recycleItemIds ?? [], ...Object.keys(recycleByItem)])];
  let recycleQueued = false;
  while (queue.length > 0 || !recycleQueued) {
    if (queue.length === 0) {
      recycleQueued = true;
      for (const itemId of recycleItems) {
        if (!index.items.has(itemId)) {
          return invalid('bad-reference', `Unknown recycle item: ${itemId}.`, [itemId]);
        }
        queue.push({ itemId, kind: 'recycle' });
      }
      continue;
    }
    const { itemId, kind } = queue.shift()!;
    if (kind === 'recycle') {
      if (recycled.has(itemId)) {
        continue;
      }
      recycled.add(itemId);
      const selectedId = recycleByItem[itemId];
      const candidates = dataset.recipes
        .filter(recipe => recipe.inputs.some(ingredient => ingredient.itemId === itemId))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (!selectedId) {
        return {
          status: 'pending-forks',
          fork: { itemId, recipeIds: candidates.map(candidate => candidate.id), kind: 'recycle' },
          recipeByItem,
          recycleByItem,
        };
      }
      const recipe = index.recipes.get(selectedId)!;
      requiredRecipes.set(recipe.id, recipe);
      for (const ingredient of recipe.inputs) {
        if (ingredient.itemId !== itemId) {
          queue.push({ itemId: ingredient.itemId, kind: 'produce' });
        }
      }
      continue;
    }
    if (visited.has(itemId) || inputItems.has(itemId)) {
      continue;
    }
    if (!recipeByItem[itemId] && [...requiredRecipes.values()].some(recipe =>
      recipe.outputs.some(output => output.itemId === itemId && output.isByproduct))) {
      continue;
    }
    visited.add(itemId);
    const candidates = index.recipesByOutput.get(itemId) ?? [];
    if (candidates.length === 0) {
      return invalid('missing-recipe', `No recipe produces ${itemId}.`, [itemId]);
    }
    let recipe: RecipeDefinition | undefined;
    const selectedId = recipeByItem[itemId];
    if (selectedId) {
      recipe = index.recipes.get(selectedId);
    } else if (candidates.length === 1) {
      recipe = candidates[0]!;
      recipeByItem[itemId] = recipe.id;
    } else {
      return {
        status: 'pending-forks',
        fork: { itemId, recipeIds: candidates.map(candidate => candidate.id), kind: 'produce' },
        recipeByItem,
        recycleByItem,
      };
    }
    if (!recipe) {
      return invalid('invalid-selection', `Unknown selected recipe: ${selectedId ?? ''}.`, [itemId], [selectedId ?? '']);
    }
    requiredRecipes.set(recipe.id, recipe);
    for (const ingredient of recipe.inputs) {
      if (!visited.has(ingredient.itemId) && !inputItems.has(ingredient.itemId)) {
        queue.push({ itemId: ingredient.itemId, kind: 'produce' });
      }
    }
  }

  const recipes = [...requiredRecipes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const variableIndex = new Map(recipes.map((recipe, column) => [recipe.id, column]));
  const surplusItems = new Set(recipes.flatMap(recipe =>
    recipe.outputs.filter(output => output.isByproduct).map(output => output.itemId)));
  const balanceItems = new Set<string>([input.target.itemId]);
  for (const recipe of recipes) {
    for (const ingredient of recipe.inputs) {
      if (!inputItems.has(ingredient.itemId) && !surplusItems.has(ingredient.itemId)) {
        balanceItems.add(ingredient.itemId);
      }
    }
  }
  for (const itemId of recycleItems) {
    if (!inputItems.has(itemId)) {
      balanceItems.add(itemId);
    }
  }
  const rows: Rational[][] = [];
  for (const itemId of balanceItems) {
    const coefficients = recipes.map(recipe => netCoefficient(recipe, itemId));
    const rhs = itemId === input.target.itemId ? targetRate : Rational.zero;
    rows.push([...coefficients, rhs]);
  }
  const solution = solveLinear(rows);
  if (solution === 'conflict') {
    return invalid('conflict', 'Selected recipes cannot satisfy material conservation.', [input.target.itemId], [...requiredRecipes.keys()]);
  }
  if (solution === 'indeterminate') {
    return invalid('indeterminate', 'Selected recipes leave the production network underdetermined.', [input.target.itemId], [...requiredRecipes.keys()]);
  }
  const rates = new Map<string, Rational>();
  for (const [recipeId, column] of variableIndex) {
    const rate = solution[column]!;
    if (rate.compare(Rational.zero) < 0) {
      return invalid('infeasible', `Recipe ${recipeId} requires a negative execution rate.`, [input.target.itemId], [recipeId]);
    }
    rates.set(recipeId, rate);
  }

  const netFlows = new Map<string, Rational>();
  for (const recipe of recipes) {
    const rate = rates.get(recipe.id)!;
    for (const ingredient of recipe.inputs) {
      netFlows.set(ingredient.itemId, (netFlows.get(ingredient.itemId) ?? Rational.zero).subtract(rate.multiply(Rational.parse(ingredient.quantity))));
    }
    for (const output of recipe.outputs) {
      netFlows.set(output.itemId, (netFlows.get(output.itemId) ?? Rational.zero).add(rate.multiply(Rational.parse(output.quantity))));
    }
  }
  const targetNet = netFlows.get(input.target.itemId) ?? Rational.zero;
  if (targetNet.compare(targetRate) !== 0) {
    throw new Error('Internal conservation check failed for the target item.');
  }

  const rawInputs: Flow[] = [];
  const byproducts: Flow[] = [];
  for (const [itemId, rate] of netFlows) {
    if (!inputItems.has(itemId) && itemId !== input.target.itemId && rate.compare(Rational.zero) < 0) {
      return invalid('infeasible', `Item ${itemId} has insufficient supply and is not an allowed external input.`, [itemId]);
    }
    if (inputItems.has(itemId) && rate.compare(Rational.zero) < 0) {
      rawInputs.push({ itemId, ratePerMin: rate.negate().toString() });
    } else if (itemId !== input.target.itemId && rate.compare(Rational.zero) > 0) {
      byproducts.push({ itemId, ratePerMin: rate.toString() });
    }
  }
  const itemOrder = new Map(dataset.items.map((item, order) => [item.id, order]));
  const compareItems = (left: Flow, right: Flow) => (itemOrder.get(left.itemId) ?? -1) - (itemOrder.get(right.itemId) ?? -1);
  rawInputs.sort(compareItems);
  byproducts.sort(compareItems);

  let exactMachines = Rational.zero;
  let builtMachines = 0n;
  let exactPower: Rational | null = Rational.zero;
  let builtPower: Rational | null = Rational.zero;
  const resultRows: RecipeRow[] = recipes.map(recipe => {
    const rate = rates.get(recipe.id)!;
    const exact = rate.multiply(Rational.parse(recipe.durationSeconds)).divide(sixty);
    const built = exact.ceil();
    exactMachines = exactMachines.add(exact);
    builtMachines += built;
    const machine = index.machines.get(recipe.machineId)!;
    let powerKW: RecipeRow['powerKW'] = null;
    if (machine.powerKW !== null) {
      const ratedPower = Rational.parse(machine.powerKW);
      powerKW = {
        exact: exact.multiply(ratedPower).toString(),
        built: ratedPower.multiply(Rational.of(built)).toString(),
      };
      exactPower = exactPower?.add(powerKW ? Rational.parse(powerKW.exact) : Rational.zero) ?? null;
      builtPower = builtPower?.add(powerKW ? Rational.parse(powerKW.built) : Rational.zero) ?? null;
    } else if (built > 0n) {
      exactPower = null;
      builtPower = null;
    }
    return {
      recipeId: recipe.id,
      machineId: recipe.machineId,
      runsPerMin: rate.toString(),
      inputs: recipe.inputs.map(ingredient => ({
        itemId: ingredient.itemId,
        ratePerMin: rate.multiply(Rational.parse(ingredient.quantity)).toString(),
      })),
      outputs: recipe.outputs.map(output => ({
        itemId: output.itemId,
        ratePerMin: rate.multiply(Rational.parse(output.quantity)).toString(),
        isByproduct: output.isByproduct,
      })),
      machines: { exact: exact.toString(), built: built.toString() },
      powerKW,
    };
  });

  return {
    status: 'solved',
    recipeByItem,
    recycleByItem,
    rows: resultRows,
    rawInputs,
    byproducts,
    summary: {
      machines: { exact: exactMachines.toString(), built: builtMachines.toString() },
      powerKW: exactPower === null || builtPower === null
        ? null
        : { exact: exactPower.toString(), built: builtPower.toString() },
    },
  };
}
