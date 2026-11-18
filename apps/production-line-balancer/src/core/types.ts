export interface ItemQuantity {
  itemId: string;
  quantity: string;
  isByproduct?: boolean;
}

export type Language = 'zh-Hans' | 'en';

export interface LocalizedNames {
  'zh-Hans': string;
  en: string;
}

export interface ItemDefinition {
  id: string;
  name: string;
  localizedNames: LocalizedNames;
  shortCode: string;
  category: 'raw' | 'machine' | 'item';
  nativeOrder: number | null;
  sourceAsset: string;
  iconAsset: string;
}

export interface MachineDefinition {
  id: string;
  name: string;
  localizedNames: LocalizedNames;
  shortCode: string;
  powerKW: string | null;
  sourceAsset: string;
  iconAsset: string;
}

export interface RecipeDefinition {
  id: string;
  name: string;
  machineId: string;
  durationSeconds: string;
  inputs: ItemQuantity[];
  outputs: ItemQuantity[];
  sourceAsset: string;
}

export interface UnsupportedRecipe {
  id: string;
  sourceAsset: string;
  reason: string;
}

export interface Dataset {
  schemaVersion: 1;
  game: {
    id: string;
    buildId: string;
    engineVersion: string;
  };
  source: {
    kind: string;
    importer: string;
    craftingTime: string;
    rawItems: string;
    itemOrder: string;
    unregisteredItems: string;
    unsupportedRecipes: UnsupportedRecipe[];
  };
  items: ItemDefinition[];
  machines: MachineDefinition[];
  recipes: RecipeDefinition[];
  rawItemIds: string[];
}

export interface DatasetIndex {
  items: ReadonlyMap<string, ItemDefinition>;
  machines: ReadonlyMap<string, MachineDefinition>;
  recipes: ReadonlyMap<string, RecipeDefinition>;
  recipesByOutput: ReadonlyMap<string, readonly RecipeDefinition[]>;
}

export interface PlanInput {
  target: {
    itemId: string;
    ratePerMin: string;
  };
  inputItemIds: readonly string[];
  recipeByItem: Readonly<Record<string, string>>;
  recycleItemIds?: readonly string[];
  recycleByItem?: Readonly<Record<string, string>>;
}

export interface Fork {
  itemId: string;
  recipeIds: string[];
  kind: 'produce' | 'recycle';
}

export interface Issue {
  kind: 'invalid-value' | 'bad-reference' | 'missing-recipe' | 'invalid-selection' | 'conflict' | 'indeterminate' | 'infeasible';
  message: string;
  itemIds: string[];
  recipeIds: string[];
}

export interface PendingPlan {
  status: 'pending-forks';
  fork: Fork;
  recipeByItem: Record<string, string>;
  recycleByItem: Record<string, string>;
}

export interface InvalidPlan {
  status: 'invalid';
  issues: Issue[];
}

export interface Flow {
  itemId: string;
  ratePerMin: string;
  isByproduct?: boolean;
}

export interface RecipeRow {
  recipeId: string;
  machineId: string;
  runsPerMin: string;
  inputs: Flow[];
  outputs: Flow[];
  machines: {
    exact: string;
    built: string;
  };
  powerKW: {
    exact: string;
    built: string;
  } | null;
}

export interface SolvedPlan {
  status: 'solved';
  recipeByItem: Record<string, string>;
  recycleByItem: Record<string, string>;
  rows: RecipeRow[];
  rawInputs: Flow[];
  byproducts: Flow[];
  summary: {
    machines: {
      exact: string;
      built: string;
    };
    powerKW: {
      exact: string;
      built: string;
    } | null;
  };
}

export type PlanResult = PendingPlan | InvalidPlan | SolvedPlan;
