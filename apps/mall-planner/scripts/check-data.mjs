import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = {};
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('../src/data.js');
await import('../src/construction-data.js');
await import('../src/default-plan.js');
await import('../src/model.js');
const data = window.GAME_DATA;
const construction = window.CONSTRUCTION_DATA;
const model = window.MallModel;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const source = JSON.parse(fs.readFileSync(path.join(appRoot, '../production-line-balancer/data/main-sequence-26639889.dataset.json'), 'utf8'));
assert(JSON.stringify(source) === JSON.stringify(data), 'Browser data is stale; run npm run sync:data.');
assert(construction.game.buildId === data.game.buildId, 'Construction data Build is stale.');
assert(construction.entries.length === 152, `Expected 152 construction entries, got ${construction.entries.length}.`);
const itemIds = new Set(data.items.map(item => item.id));
for (const recipe of data.recipes) {
  assert(data.machines.some(machine => machine.id === recipe.machineId), `Missing machine for ${recipe.id}.`);
  for (const flow of [...recipe.inputs, ...recipe.outputs]) assert(itemIds.has(flow.itemId), `Missing item ${flow.itemId} for ${recipe.id}.`);
}
const constructionOnlyItems = new Set(construction.source.unregisteredItemIds ?? []);
for (const entry of construction.entries) {
  assert(entry.asset && entry.name && entry.category, `Invalid construction entry ${entry.asset}.`);
  for (const flow of entry.cost) assert(flow.itemId === null || itemIds.has(flow.itemId) || constructionOnlyItems.has(flow.itemId), `Missing construction item ${flow.itemId} in ${entry.asset}.`);
}
for (const entry of [...data.items, ...data.machines]) {
  assert(fs.existsSync(path.join(appRoot, 'icons', `${entry.id}.png`)), `Missing icon ${entry.id}.png.`);
}
const state = model.createDefaultState();
const topology = model.computeLevels(state);
const issues = model.getIssues(state, topology);
assert(state.version === 2, 'Expected plan schema v2.');
assert(state.targetItemIds.length === 33, `Expected 33 targets, got ${state.targetItemIds.length}.`);
assert(window.MALL_DEFAULTS.manualOnlyItemIds.every(itemId => state.includedItemIds.includes(itemId) && !state.targetItemIds.includes(itemId)), 'Armoury items must remain planned but not stocked.');
assert(state.externalItemIds.length === 3, `Expected 3 external inputs, got ${state.externalItemIds.length}.`);
assert(state.includedItemIds.length === 69, `Expected 69 planned items, got ${state.includedItemIds.length}.`);
assert(Math.max(...Object.values(topology.levels)) === 12, 'Expected the default network to reach L12.');
assert(issues.length === 0, `Default plan has issues: ${JSON.stringify(issues)}`);
const migrated = model.validateImported({ ...state, version: 1, targetItemIds: [...state.targetItemIds, ...window.MALL_DEFAULTS.manualOnlyItemIds] });
assert(migrated.version === 2 && migrated.targetItemIds.length === 33 && migrated.migrationNote, 'V1 target migration failed.');
console.log(`Checked Build ${data.game.buildId}: ${state.includedItemIds.length} planned items, ${state.targetItemIds.length} targets, L0-L12, ${data.recipes.length} recipes, ${construction.entries.length} construction entries, no default issues.`);
