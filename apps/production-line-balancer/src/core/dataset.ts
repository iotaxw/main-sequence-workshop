import { Rational } from './rational';
import type { Dataset, DatasetIndex, ItemDefinition, MachineDefinition, RecipeDefinition } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function positive(value: string, label: string): Rational {
  const parsed = Rational.parse(value);
  assert(parsed.compare(Rational.zero) > 0, `${label} must be positive.`);
  return parsed;
}

function uniqueById<T extends { id: string }>(values: T[], label: string): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    assert(value.id.length > 0, `${label} ID cannot be empty.`);
    assert(!result.has(value.id), `Duplicate ${label} ID: ${value.id}.`);
    result.set(value.id, value);
  }
  return result;
}

function validateItem(item: ItemDefinition): void {
  assert(item.name.length > 0, `Item ${item.id} has no name.`);
  assert(item.shortCode.length > 0, `Item ${item.id} has no short code.`);
  assert(item.localizedNames.en.length > 0, `Item ${item.id} has no English name.`);
  assert(item.localizedNames['zh-Hans'].length > 0, `Item ${item.id} has no Chinese name.`);
  assert(item.nativeOrder === null || (Number.isInteger(item.nativeOrder) && item.nativeOrder >= 0), `Item ${item.id} has an invalid native order.`);
  assert(item.sourceAsset.length > 0, `Item ${item.id} has no source asset.`);
  assert(item.iconAsset.length > 0, `Item ${item.id} has no icon asset.`);
}

function validateMachine(machine: MachineDefinition): void {
  assert(machine.name.length > 0, `Machine ${machine.id} has no name.`);
  assert(machine.shortCode.length > 0, `Machine ${machine.id} has no short code.`);
  assert(machine.localizedNames.en.length > 0, `Machine ${machine.id} has no English name.`);
  assert(machine.localizedNames['zh-Hans'].length > 0, `Machine ${machine.id} has no Chinese name.`);
  assert(machine.sourceAsset.length > 0, `Machine ${machine.id} has no source asset.`);
  assert(machine.iconAsset.length > 0, `Machine ${machine.id} has no icon asset.`);
  if (machine.powerKW !== null) {
    positive(machine.powerKW, `Machine ${machine.id} power`);
  }
}

function validateRecipe(recipe: RecipeDefinition, machines: ReadonlyMap<string, MachineDefinition>): void {
  assert(machines.has(recipe.machineId), `Recipe ${recipe.id} references unknown machine ${recipe.machineId}.`);
  positive(recipe.durationSeconds, `Recipe ${recipe.id} duration`);
  assert(recipe.outputs.length > 0, `Recipe ${recipe.id} has no outputs.`);
  assert(recipe.sourceAsset.length > 0, `Recipe ${recipe.id} has no source asset.`);
  for (const [kind, quantities] of [['input', recipe.inputs], ['output', recipe.outputs]] as const) {
    const itemIds = new Set<string>();
    for (const quantity of quantities) {
      assert(!itemIds.has(quantity.itemId), `Recipe ${recipe.id} repeats ${kind} ${quantity.itemId}.`);
      itemIds.add(quantity.itemId);
      positive(quantity.quantity, `Recipe ${recipe.id} ${kind} quantity`);
    }
  }
}

export function defaultExternalInputItemIds(dataset: Dataset): string[] {
  const producedWithoutInputs = new Set(dataset.recipes
    .filter(recipe => recipe.inputs.length === 0)
    .flatMap(recipe => recipe.outputs.map(output => output.itemId)));
  return dataset.rawItemIds.filter(itemId => !producedWithoutInputs.has(itemId));
}

export function indexDataset(dataset: Dataset): DatasetIndex {
  assert(dataset.schemaVersion === 1, `Unsupported dataset schema: ${dataset.schemaVersion}.`);
  assert(dataset.game.buildId.length > 0, 'Dataset has no Build ID.');
  assert(Array.isArray(dataset.items) && Array.isArray(dataset.machines) && Array.isArray(dataset.recipes), 'Dataset collections must be arrays.');
  const items = uniqueById(dataset.items, 'item');
  const machines = uniqueById(dataset.machines, 'machine');
  const recipes = uniqueById(dataset.recipes, 'recipe');
  for (const item of dataset.items) {
    validateItem(item);
  }
  for (const machine of dataset.machines) {
    validateMachine(machine);
  }
  for (const recipe of dataset.recipes) {
    validateRecipe(recipe, machines);
    for (const quantity of [...recipe.inputs, ...recipe.outputs]) {
      assert(items.has(quantity.itemId), `Recipe ${recipe.id} references unknown item ${quantity.itemId}.`);
    }
  }
  const rawItemIds = new Set<string>();
  for (const itemId of dataset.rawItemIds) {
    assert(items.has(itemId), `Raw item reference does not exist: ${itemId}.`);
    assert(!rawItemIds.has(itemId), `Duplicate raw item: ${itemId}.`);
    rawItemIds.add(itemId);
  }
  const recipesByOutput = new Map<string, RecipeDefinition[]>();
  for (const recipe of dataset.recipes) {
    for (const output of recipe.outputs) {
      const candidates = recipesByOutput.get(output.itemId) ?? [];
      candidates.push(recipe);
      recipesByOutput.set(output.itemId, candidates);
    }
  }
  for (const candidates of recipesByOutput.values()) {
    candidates.sort((left, right) => left.id.localeCompare(right.id));
  }
  return { items, machines, recipes, recipesByOutput };
}
