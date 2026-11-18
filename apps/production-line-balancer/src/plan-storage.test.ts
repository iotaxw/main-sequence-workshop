import { beforeEach, describe, expect, it } from 'vitest';
import datasetJson from '../data/main-sequence-26639889.dataset.json';
import type { Dataset } from './core/types';
import { emptyStoredPlan, loadPlan, savePlan } from './plan-storage';

const dataset = datasetJson as Dataset;
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  },
});

describe('plan storage', () => {
  beforeEach(() => values.clear());

  it('restores a plan from the same game Build', () => {
    const plan = {
      ...emptyStoredPlan,
      datasetBuildId: dataset.game.buildId,
      language: 'en' as const,
      targetItemId: 'ITEM_BasicCircuit',
      ratePerMin: '10',
      inputItemIds: dataset.rawItemIds,
      recipeByItem: { ITEM_MagneticCoils: 'REC_MageticCoils' },
    };
    savePlan(plan);
    expect(loadPlan(dataset)).toEqual({ plan, issues: [] });
  });

  it('rejects a stale Build with an explicit issue', () => {
    savePlan({
      ...emptyStoredPlan,
      datasetBuildId: 'stale-build',
      targetItemId: 'ITEM_BasicCircuit',
    });
    const result = loadPlan(dataset);
    expect(result.plan.targetItemId).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain('stale-build');
  });

  it('rejects references removed from the current dataset', () => {
    savePlan({
      ...emptyStoredPlan,
      datasetBuildId: dataset.game.buildId,
      targetItemId: 'ITEM_RemovedResource',
      inputItemIds: ['ITEM_RemovedResource'],
    });
    const result = loadPlan(dataset);
    expect(result.plan.targetItemId).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain('已失效');
  });

  it('rejects malformed saved data instead of guessing a plan', () => {
    values.set('main-sequence.planner.v1', '{not-json');
    const result = loadPlan(dataset);
    expect(result.plan.targetItemId).toBeNull();
    expect(result.issues).toHaveLength(1);
  });
});
