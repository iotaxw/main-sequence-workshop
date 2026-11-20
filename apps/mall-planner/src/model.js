(() => {
  const data = window.GAME_DATA;
  const defaults = window.MALL_DEFAULTS;
  const items = new Map(data.items.map(item => [item.id, item]));
  const machines = new Map(data.machines.map(machine => [machine.id, machine]));
  const recipes = new Map(data.recipes.map(recipe => [recipe.id, recipe]));
  const recipesByOutput = new Map();
  for (const recipe of data.recipes) {
    for (const output of recipe.outputs.filter(flow => !flow.isByproduct)) {
      if (!recipesByOutput.has(output.itemId)) recipesByOutput.set(output.itemId, []);
      recipesByOutput.get(output.itemId).push(recipe);
    }
  }
  const byproductItems = new Set(data.recipes.flatMap(recipe => recipe.outputs.filter(flow => flow.isByproduct).map(flow => flow.itemId)));
  const nativeOrder = (left, right) => {
    const a = items.get(left);
    const b = items.get(right);
    return (a.nativeOrder ?? 10000) - (b.nativeOrder ?? 10000) || a.id.localeCompare(b.id);
  };
  const selectedRecipe = (state, itemId) => {
    if (state.externalItemIds.includes(itemId)) return null;
    const candidates = recipesByOutput.get(itemId) ?? [];
    const selected = recipes.get(state.recipeByItem[itemId]);
    if (selected?.outputs.some(flow => flow.itemId === itemId && !flow.isByproduct)) return selected;
    return candidates.length === 1 ? candidates[0] : null;
  };
  const createDefaultState = () => {
    const included = new Set();
    const visiting = new Set();
    const add = itemId => {
      if (included.has(itemId) || visiting.has(itemId)) return;
      included.add(itemId);
      if (defaults.externalItemIds.includes(itemId) || byproductItems.has(itemId)) return;
      const candidates = recipesByOutput.get(itemId) ?? [];
      const recipe = recipes.get(defaults.recipeByItem[itemId]) ?? (candidates.length === 1 ? candidates[0] : null);
      if (!recipe) throw new Error(`No selected native recipe for ${itemId}.`);
      visiting.add(itemId);
      for (const input of recipe.inputs) add(input.itemId);
      for (const output of recipe.outputs) included.add(output.itemId);
      visiting.delete(itemId);
    };
    defaults.targetItemIds.forEach(add);
    return {
      version: 3,
      buildId: data.game.buildId,
      includedItemIds: [...included].sort(nativeOrder),
      targetItemIds: [...defaults.targetItemIds].sort(nativeOrder),
      externalItemIds: [...defaults.externalItemIds].sort(nativeOrder),
      recipeByItem: { ...defaults.recipeByItem },
      manualLevels: {},
      zones: defaults.zones.map(zone => ({ ...zone })),
      zoneByItem: Object.fromEntries(defaults.energyItemIds.map(itemId => [itemId, 'energy'])),
    };
  };
  const computeLevels = state => {
    const included = new Set(state.includedItemIds);
    const dependencies = new Map(state.includedItemIds.map(itemId => [itemId, new Set()]));
    for (const itemId of included) {
      const recipe = selectedRecipe(state, itemId);
      if (!recipe) continue;
      for (const output of recipe.outputs) {
        if (!included.has(output.itemId)) continue;
        for (const input of recipe.inputs) {
          if (included.has(input.itemId)) dependencies.get(output.itemId).add(input.itemId);
        }
      }
    }
    let nextIndex = 0;
    const indexes = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];
    const connect = itemId => {
      indexes.set(itemId, nextIndex);
      lowLinks.set(itemId, nextIndex++);
      stack.push(itemId);
      onStack.add(itemId);
      for (const dependency of dependencies.get(itemId)) {
        if (!indexes.has(dependency)) {
          connect(dependency);
          lowLinks.set(itemId, Math.min(lowLinks.get(itemId), lowLinks.get(dependency)));
        } else if (onStack.has(dependency)) {
          lowLinks.set(itemId, Math.min(lowLinks.get(itemId), indexes.get(dependency)));
        }
      }
      if (lowLinks.get(itemId) === indexes.get(itemId)) {
        const component = [];
        while (true) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === itemId) break;
        }
        components.push(component);
      }
    };
    for (const itemId of included) if (!indexes.has(itemId)) connect(itemId);
    const componentByItem = new Map();
    components.forEach((component, index) => component.forEach(itemId => componentByItem.set(itemId, index)));
    const componentDependencies = components.map(() => new Set());
    for (const [itemId, deps] of dependencies) {
      for (const dependency of deps) {
        const outputComponent = componentByItem.get(itemId);
        const inputComponent = componentByItem.get(dependency);
        if (outputComponent !== inputComponent) componentDependencies[outputComponent].add(inputComponent);
      }
    }
    const ranks = new Map();
    const rank = component => {
      if (ranks.has(component)) return ranks.get(component);
      const deps = [...componentDependencies[component]];
      const result = deps.length ? 1 + Math.max(...deps.map(rank)) : 0;
      ranks.set(component, result);
      return result;
    };
    const componentDependents = components.map(() => new Set());
    componentDependencies.forEach((deps, outputComponent) => {
      for (const inputComponent of deps) componentDependents[inputComponent].add(outputComponent);
    });
    const componentLevels = components.map((_, index) => rank(index));
    let improved = true;
    while (improved) {
      improved = false;
      for (let component = 0; component < components.length; component++) {
        const dependencies = [...componentDependencies[component]];
        const dependents = [...componentDependents[component]];
        const neighbors = [...dependencies, ...dependents].map(index => componentLevels[index]).sort((a, b) => a - b);
        if (!neighbors.length) continue;
        const lower = dependencies.length ? 1 + Math.max(...dependencies.map(index => componentLevels[index])) : 0;
        const upper = dependents.length ? Math.min(...dependents.map(index => componentLevels[index])) - 1 : Infinity;
        const middle = Math.floor(neighbors.length / 2);
        const medianLow = neighbors[Math.floor((neighbors.length - 1) / 2)];
        const medianHigh = neighbors[middle];
        const closestMedian = Math.max(medianLow, Math.min(medianHigh, componentLevels[component]));
        const next = Math.max(lower, Math.min(upper, closestMedian));
        if (next !== componentLevels[component]) {
          componentLevels[component] = next;
          improved = true;
        }
      }
    }
    const levels = {};
    components.forEach((component, index) => component.forEach(itemId => { levels[itemId] = componentLevels[index]; }));
    return { levels, componentByItem };
  };
  const effectiveLevel = (state, topology, itemId) => state.manualLevels[itemId] ?? topology.levels[itemId] ?? 0;
  const zoneFor = (state, itemId) => state.zones.find(zone => zone.id === (state.zoneByItem[itemId] ?? 'main'));
  const isIsolatedBoundary = (state, left, right) => {
    const leftZone = zoneFor(state, left);
    const rightZone = zoneFor(state, right);
    return leftZone?.id !== rightZone?.id && (leftZone?.isolated || rightZone?.isolated);
  };
  const getIssues = (state, topology) => {
    const issues = [];
    const included = new Set(state.includedItemIds);
    for (const itemId of included) {
      const recipe = selectedRecipe(state, itemId);
      if (!recipe) {
        if (!state.externalItemIds.includes(itemId) && !byproductItems.has(itemId) && (recipesByOutput.get(itemId)?.length ?? 0) === 0) {
          issues.push({ kind: 'error', itemId, text: `${items.get(itemId).localizedNames['zh-Hans']}没有可用生产配方` });
        } else if ((recipesByOutput.get(itemId)?.length ?? 0) > 1 && !state.externalItemIds.includes(itemId)) {
          issues.push({ kind: 'error', itemId, text: `${items.get(itemId).localizedNames['zh-Hans']}尚未选择生产配方` });
        }
        continue;
      }
      for (const input of recipe.inputs) {
        if (!included.has(input.itemId)) issues.push({ kind: 'error', itemId, text: `${items.get(itemId).localizedNames['zh-Hans']}缺少上游物品${items.get(input.itemId).localizedNames['zh-Hans']}` });
      }
      for (const output of recipe.outputs.filter(flow => !flow.isByproduct && included.has(flow.itemId))) {
        for (const input of recipe.inputs.filter(flow => included.has(flow.itemId))) {
          if (isIsolatedBoundary(state, output.itemId, input.itemId)) continue;
          if (topology.componentByItem.get(output.itemId) === topology.componentByItem.get(input.itemId)) continue;
          if (effectiveLevel(state, topology, output.itemId) <= effectiveLevel(state, topology, input.itemId)) {
            issues.push({ kind: 'warning', itemId, text: `${items.get(output.itemId).localizedNames['zh-Hans']}的层级未晚于${items.get(input.itemId).localizedNames['zh-Hans']}` });
          }
        }
      }
    }
    return issues;
  };
  const addItemWithDependencies = (state, itemId) => {
    const included = new Set(state.includedItemIds);
    const visiting = new Set();
    const add = id => {
      if (visiting.has(id)) return;
      included.add(id);
      const recipe = selectedRecipe(state, id);
      if (!recipe) return;
      visiting.add(id);
      recipe.inputs.forEach(input => add(input.itemId));
      recipe.outputs.forEach(output => included.add(output.itemId));
      visiting.delete(id);
    };
    add(itemId);
    state.includedItemIds = [...included].sort(nativeOrder);
  };
  const relatedItems = (state, itemId, mode) => {
    if (mode === 'all') return new Set(state.includedItemIds);
    const upstream = new Map(state.includedItemIds.map(id => [id, new Set()]));
    const downstream = new Map(state.includedItemIds.map(id => [id, new Set()]));
    for (const id of state.includedItemIds) {
      const recipe = selectedRecipe(state, id);
      if (!recipe) continue;
      for (const input of recipe.inputs) {
        if (!state.includedItemIds.includes(input.itemId)) continue;
        upstream.get(id).add(input.itemId);
        downstream.get(input.itemId)?.add(id);
      }
    }
    const result = new Set([itemId]);
    const visit = (id, graph, direction) => {
      for (const next of graph.get(id) ?? []) {
        if (result.has(`${direction}:${next}`)) continue;
        result.add(`${direction}:${next}`);
        visit(next, graph, direction);
      }
    };
    if (mode === 'upstream' || mode === 'related') visit(itemId, upstream, 'upstream');
    if (mode === 'downstream' || mode === 'related') visit(itemId, downstream, 'downstream');
    const resolved = new Set([itemId]);
    for (const value of result) if (typeof value === 'string' && value.includes(':')) resolved.add(value.slice(value.indexOf(':') + 1));
    return resolved;
  };
  const validateImported = original => {
    let candidate = original;
    const migrationNotes = [];
    if (candidate?.version === 1 && candidate.buildId === data.game.buildId) {
      candidate = {
        ...candidate,
        version: 2,
        targetItemIds: candidate.targetItemIds?.filter(itemId => !defaults.manualOnlyItemIds.includes(itemId)),
      };
      migrationNotes.push('version 1 军械库常备目标已移除');
    }
    if (candidate?.version === 2 && candidate.buildId === data.game.buildId) {
      const manualOnly = new Set(defaults.manualOnlyItemIds);
      candidate = {
        ...candidate,
        version: 3,
        includedItemIds: candidate.includedItemIds?.filter(itemId => !manualOnly.has(itemId)),
        targetItemIds: candidate.targetItemIds?.filter(itemId => !manualOnly.has(itemId)),
        externalItemIds: candidate.externalItemIds?.filter(itemId => !manualOnly.has(itemId)),
        recipeByItem: Object.fromEntries(Object.entries(candidate.recipeByItem ?? {}).filter(([itemId]) => !manualOnly.has(itemId))),
        manualLevels: Object.fromEntries(Object.entries(candidate.manualLevels ?? {}).filter(([itemId]) => !manualOnly.has(itemId))),
        zoneByItem: Object.fromEntries(Object.entries(candidate.zoneByItem ?? {}).filter(([itemId]) => !manualOnly.has(itemId))),
      };
      migrationNotes.push('军械库产物已移出默认总线设计，详情仍保留用途与手动加入入口');
    }
    if (!candidate || candidate.version !== 3 || candidate.buildId !== data.game.buildId) throw new Error(`方案版本或 Build 不匹配，需要 version 1 或 2、Build ${data.game.buildId}。`);
    for (const key of ['includedItemIds', 'targetItemIds', 'externalItemIds']) {
      if (!Array.isArray(candidate[key])) throw new Error(`方案缺少 ${key}。`);
      for (const itemId of candidate[key]) {
        if (!items.has(itemId) || items.get(itemId).category === 'machine') throw new Error(`方案包含未知物品 ${itemId}。`);
      }
    }
    const included = new Set(candidate.includedItemIds);
    if (!included.size) throw new Error('方案物品集不能为空。');
    if (!candidate.targetItemIds.every(id => included.has(id)) || !candidate.externalItemIds.every(id => included.has(id))) throw new Error('常备目标或外部输入不在方案物品集内。');
    for (const [itemId, recipeId] of Object.entries(candidate.recipeByItem ?? {})) {
      if (!included.has(itemId) || !recipes.get(recipeId)?.outputs.some(flow => flow.itemId === itemId && !flow.isByproduct)) throw new Error(`非法配方选择 ${itemId} -> ${recipeId}。`);
    }
    for (const [itemId, level] of Object.entries(candidate.manualLevels ?? {})) {
      if (!included.has(itemId) || !Number.isInteger(level) || level < 0 || level > 99) throw new Error(`非法手动层级 ${itemId} -> ${level}。`);
    }
    if (!Array.isArray(candidate.zones) || !candidate.zones.length || !candidate.zones.some(zone => zone.id === 'main')) throw new Error('方案必须包含 main 分区。');
    const zoneIds = new Set(candidate.zones.map(zone => zone.id));
    if (zoneIds.size !== candidate.zones.length) throw new Error('分区 ID 重复。');
    for (const zone of candidate.zones) {
      if (typeof zone.name !== 'string' || !zone.name.trim() || typeof zone.isolated !== 'boolean') throw new Error(`非法分区 ${zone.id}。`);
    }
    for (const [itemId, zoneId] of Object.entries(candidate.zoneByItem ?? {})) {
      if (!included.has(itemId) || !zoneIds.has(zoneId)) throw new Error(`非法分区归属 ${itemId} -> ${zoneId}。`);
    }
    const state = {
      version: 3,
      buildId: candidate.buildId,
      includedItemIds: [...included].sort(nativeOrder),
      targetItemIds: [...new Set(candidate.targetItemIds)].sort(nativeOrder),
      externalItemIds: [...new Set(candidate.externalItemIds)].sort(nativeOrder),
      recipeByItem: { ...candidate.recipeByItem },
      manualLevels: { ...candidate.manualLevels },
      zones: candidate.zones.map(zone => ({ id: zone.id, name: zone.name.trim(), isolated: zone.isolated })),
      zoneByItem: { ...candidate.zoneByItem },
    };
    Object.defineProperty(state, 'migrationNote', { value: migrationNotes.join('；'), enumerable: false });
    return state;
  };
  window.MallModel = {
    data,
    items,
    machines,
    recipes,
    recipesByOutput,
    byproductItems,
    nativeOrder,
    selectedRecipe,
    createDefaultState,
    computeLevels,
    effectiveLevel,
    zoneFor,
    isIsolatedBoundary,
    getIssues,
    addItemWithDependencies,
    relatedItems,
    validateImported,
  };
})();
