(() => {
  const model = window.MallModel;
  const { data, items, machines } = model;
  const construction = window.CONSTRUCTION_DATA;
  const manualOnlyItems = new Set(window.MALL_DEFAULTS.manualOnlyItemIds);
  const storageKey = `mall-planner:${data.game.buildId}:v1`;
  const $ = selector => document.querySelector(selector);
  const nameOf = itemId => items.get(itemId)?.localizedNames['zh-Hans'] ?? itemId;
  const iconOf = itemId => `icons/${itemId}.png`;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const shortName = (value, length = 15) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
  let loadError = null;
  let state;
  try {
    const saved = localStorage.getItem(storageKey);
    state = saved ? model.validateImported(JSON.parse(saved)) : model.createDefaultState();
  } catch (error) {
    loadError = error.message;
    state = model.createDefaultState();
  }
  let topology;
  let issues = [];
  let selectedItemId = 'ITEM_Protomatter';
  let zoneFilter = 'all';
  let chainFilter = 'all';
  let zoom = 0.85;
  let lastGraphSize = { width: 1200, height: 600 };
  let toastTimer;

  const toast = message => {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('visible'), 3200);
  };
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (error) {
      toast(`无法保存本地方案：${error.message}`);
    }
  };
  const commit = message => {
    save();
    render();
    if (message) toast(message);
  };
  const itemBadges = itemId => {
    const badges = [];
    if (state.targetItemIds.includes(itemId)) badges.push('<span class="badge" style="color:var(--amber)">常备</span>');
    if (state.externalItemIds.includes(itemId)) badges.push('<span class="badge" style="color:var(--green)">外部</span>');
    if (manualOnlyItems.has(itemId)) badges.push('<span class="badge" style="color:var(--amber)">手动合成</span>');
    const zone = model.zoneFor(state, itemId);
    if (zone?.isolated) badges.push(`<span class="badge" style="color:var(--purple)">${escapeHtml(zone.name)}</span>`);
    return badges.join('');
  };
  const usageGroups = itemId => {
    const groups = [];
    const downstream = [...new Set(data.recipes.filter(recipe => recipe.inputs.some(flow => flow.itemId === itemId)).flatMap(recipe => recipe.outputs.filter(flow => !flow.isByproduct).map(flow => flow.itemId)))].filter(id => id !== itemId);
    if (downstream.length) groups.push({ label: '配方下游', entries: downstream.map(id => ({ itemId: id, text: nameOf(id) })) });
    for (const [category, label] of [['ordinary', '普通建筑'], ['station', '空间站'], ['ship', '舰船']]) {
      const entries = construction.entries.filter(entry => entry.category === category).flatMap(entry => entry.cost.filter(flow => flow.itemId === itemId).map(flow => ({ text: `${entry.name} ×${flow.amount}` })));
      if (entries.length) groups.push({ label, entries });
    }
    return groups;
  };
  const usageShort = itemId => {
    const groups = usageGroups(itemId);
    const text = groups.length ? groups.slice(0, 2).map(group => `${group.label}：${group.entries.slice(0, 2).map(entry => entry.text).join('、')}${group.entries.length > 2 ? ' 等' : ''}`).join(' · ') : '终端领取或消耗';
    return manualOnlyItems.has(itemId) ? `军械库手动合成 · ${text}` : text;
  };
  const usageSection = itemId => {
    const isTarget = state.targetItemIds.includes(itemId);
    if (!isTarget && !manualOnlyItems.has(itemId)) return '';
    const groups = usageGroups(itemId);
    return `<section class="detail-section usage-section">
      <div class="section-title"><h3>${isTarget ? '常备用途' : '手动合成与用途'}</h3></div>
      ${manualOnlyItems.has(itemId) ? '<div class="manual-note">军械库产物不可量产，默认不进入总线设计；点击“加入物品并补齐上游”后才进入方案。</div>' : ''}
      ${groups.length ? groups.map(group => `<div class="usage-group"><strong>${group.label} · ${group.entries.length} 处</strong><div>${group.entries.slice(0, 8).map(entry => `<span class="usage-entry" ${entry.itemId ? `data-select-item="${entry.itemId}" tabindex="0"` : ''}>${escapeHtml(entry.text)}</span>`).join('')}${group.entries.length > 8 ? `<span class="usage-entry">等 ${group.entries.length} 处</span>` : ''}</div></div>`).join('') : '<p>没有配方或建筑直接消耗，按终端物品处理。</p>'}
    </section>`;
  };
  const buildCollaborationSummary = () => {
    const includedManualItems = [...manualOnlyItems].filter(itemId => state.includedItemIds.includes(itemId));
    const lines = [
      '# Main Sequence 总线超市协作摘要', '',
      `Build：${data.game.buildId}；方案版本：${state.version}`,
      `规划物品 ${state.includedItemIds.length}；常备目标 ${state.targetItemIds.length}；外部输入 ${state.externalItemIds.length}`,
      '规划原则：大缓存做时间解耦，层级表示配方拓扑，隔离分区只改变协作边界。', '',
      '## 外部输入',
      ...state.externalItemIds.map(itemId => `- ${nameOf(itemId)}（L${model.effectiveLevel(state, topology, itemId)}）`), '',
      '## 分区',
      ...state.zones.map(zone => {
        const count = state.includedItemIds.filter(itemId => (state.zoneByItem[itemId] ?? 'main') === zone.id).length;
        return `- ${zone.name}：${zone.isolated ? '隔离' : '开放'}，${count} 种物品`;
      }), '',
      '## 常备目标与用途',
      ...state.targetItemIds.map(itemId => {
        const groups = usageGroups(itemId).map(group => `${group.label}[${group.entries.map(entry => entry.text).join('、')}]`).join('；');
        return `- ${nameOf(itemId)}｜L${model.effectiveLevel(state, topology, itemId)}｜${groups || '终端领取或消耗'}`;
      }), '',
      '## 军械库手动合成（默认排除）',
      ...(includedManualItems.length
        ? includedManualItems.map(itemId => `- ${nameOf(itemId)}｜L${model.effectiveLevel(state, topology, itemId)}｜${usageShort(itemId)}`)
        : ['- 默认不进入总线设计，仅在详情中展示用途；显式加入后才参与层级与依赖图。']), '',
      '## 手动层级覆盖',
      ...(Object.keys(state.manualLevels).length ? Object.entries(state.manualLevels).map(([itemId, level]) => `- ${nameOf(itemId)}：L${level}（自动 L${topology.levels[itemId] ?? 0}）`) : ['- 无']), '',
      '## 采用配方分支',
      ...Object.entries(state.recipeByItem).map(([itemId, recipeId]) => `- ${nameOf(itemId)}：${recipeId}`), '',
      '## 当前问题',
      ...(issues.length ? issues.map(issue => `- [${issue.kind}] ${issue.text}`) : ['- 无']),
    ];
    return lines.join('\n');
  };
  const renderStats = () => {
    const recipesUsed = new Set(state.includedItemIds.map(itemId => model.selectedRecipe(state, itemId)?.id).filter(Boolean)).size;
    const stats = [
      [state.includedItemIds.length, '规划物品'],
      [state.targetItemIds.length, '常备目标'],
      [state.externalItemIds.length, '外部输入'],
      [recipesUsed, '采用配方'],
      [state.zones.length, '分区'],
      [issues.length, '待处理问题'],
    ];
    $('#stats').innerHTML = stats.map(([value, label]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
    $('#build-badge').textContent = `Build ${data.game.buildId}`;
    $('#issue-count').textContent = issues.length;
  };
  const groupForItem = item => {
    if (item.category === 'raw') return { id: 'basic', name: '基础类 · 采集物与原物质', order: -100 };
    if (item.nativeOrder === null) return { id: 'unregistered', name: '未登记物品', order: 1000 };
    const candidates = model.recipesByOutput.get(item.id) ?? [];
    if (!candidates.length && model.byproductItems.has(item.id)) return { id: 'byproduct', name: '副产物', order: 900 };
    const recipe = model.selectedRecipe(state, item.id) ?? candidates[0];
    const machine = recipe ? machines.get(recipe.machineId) : null;
    return machine
      ? { id: machine.id, name: machine.localizedNames['zh-Hans'], order: data.machines.findIndex(entry => entry.id === machine.id) }
      : { id: 'unproduced', name: '无生产配方', order: 950 };
  };
  const renderCatalog = () => {
    const query = $('#item-search').value.trim().toLocaleLowerCase();
    const visibleItems = data.items.filter(item => item.category !== 'machine' && (!query || [item.id, item.localizedNames['zh-Hans'], item.localizedNames.en].some(value => value.toLocaleLowerCase().includes(query)))).sort((a, b) => model.nativeOrder(a.id, b.id));
    $('#catalog-count').textContent = `${visibleItems.length}/${data.items.filter(item => item.category !== 'machine').length}`;
    const groups = new Map();
    for (const item of visibleItems) {
      const group = groupForItem(item);
      if (!groups.has(group.id)) groups.set(group.id, { ...group, items: [] });
      groups.get(group.id).items.push(item);
    }
    $('#catalog-list').innerHTML = [...groups.values()].sort((a, b) => a.order - b.order).map(group => `
      <details class="catalog-group" open>
        <summary>${escapeHtml(group.name)} · ${group.items.length}</summary>
        ${group.items.map(item => {
          const included = state.includedItemIds.includes(item.id);
          return `<div class="item-row ${selectedItemId === item.id ? 'selected' : ''}" data-select-item="${item.id}" tabindex="0">
            <img class="item-icon" src="${iconOf(item.id)}" alt="">
            <div>
              <div class="item-name" title="${escapeHtml(item.localizedNames.en)}">${escapeHtml(item.localizedNames['zh-Hans'])}</div>
              <div class="item-subline"><span>L${model.effectiveLevel(state, topology, item.id)}</span><span>${included ? '已规划' : '未加入'}</span></div>
              ${state.targetItemIds.includes(item.id) ? `<div class="item-usage" title="${escapeHtml(usageShort(item.id))}">${escapeHtml(usageShort(item.id))}</div>` : ''}
            </div>
            <button class="small ${included ? 'danger-secondary' : 'secondary'}" data-action="${included ? 'remove-item' : 'add-item'}" data-item="${item.id}">${included ? '移出' : '加入'}</button>
          </div>`;
        }).join('')}
      </details>`).join('') || '<div class="empty-state">没有匹配物品</div>';
  };
  const graphItems = () => {
    const related = model.relatedItems(state, selectedItemId, chainFilter);
    return state.includedItemIds.filter(itemId => related.has(itemId) && (zoneFilter === 'all' || (state.zoneByItem[itemId] ?? 'main') === zoneFilter));
  };
  const renderGraph = () => {
    const visible = graphItems();
    const positions = new Map();
    const levels = new Map();
    for (const itemId of visible) {
      const level = model.effectiveLevel(state, topology, itemId);
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(itemId);
    }
    const nodeWidth = 190;
    const nodeHeight = 58;
    const columnWidth = 220;
    const rowHeight = 78;
    const maxRows = Math.max(1, ...[...levels.values()].map(entries => entries.length));
    const maxLevel = Math.max(0, ...levels.keys());
    const width = Math.max(900, (maxLevel + 1) * columnWidth + 40);
    const height = Math.max(420, maxRows * rowHeight + 65);
    lastGraphSize = { width, height };
    for (const [level, entries] of levels) {
      entries.sort(model.nativeOrder).forEach((itemId, index) => positions.set(itemId, {
        x: 25 + level * columnWidth,
        y: 52 + index * rowHeight,
        level,
      }));
    }
    const edges = new Map();
    for (const outputId of visible) {
      const recipe = model.selectedRecipe(state, outputId);
      if (!recipe) continue;
      for (const output of recipe.outputs) {
        if (!positions.has(output.itemId)) continue;
        for (const input of recipe.inputs) {
          if (!positions.has(input.itemId)) continue;
          const key = `${input.itemId}->${output.itemId}`;
          edges.set(key, { from: input.itemId, to: output.itemId, byproduct: output.isByproduct || edges.get(key)?.byproduct });
        }
      }
    }
    const issueItems = new Set(issues.map(issue => issue.itemId));
    const directDownstream = new Set(state.includedItemIds.filter(itemId => itemId !== selectedItemId && model.selectedRecipe(state, itemId)?.inputs.some(input => input.itemId === selectedItemId)));
    const downstreamItems = new Set([selectedItemId, ...directDownstream]);
    let skippingEdges = 0;
    let emptyLayers = 0;
    for (const edge of edges.values()) {
      const gap = positions.get(edge.to).level - positions.get(edge.from).level - 1;
      if (gap > 0) {
        skippingEdges++;
        emptyLayers += gap;
      }
    }
    $('#graph-metrics').textContent = `${skippingEdges} 条跨层 · ${emptyLayers} 个缓存层`;
    $('#graph-metrics').title = '跨层连接表示上下游不相邻；缓存层是各连接空跨层数之和，用于比较紧凑程度。';
    const levelLabels = [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([level, entries]) => {
      const x = 25 + level * columnWidth;
      return `<text x="${x}" y="27" fill="#71899f" font-size="12">L${level} · ${entries.length} 种物品</text>`;
    }).join('');
    const edgeSvg = [...edges.values()].map(edge => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      const x1 = from.x + nodeWidth;
      const y1 = from.y + nodeHeight / 2;
      const x2 = to.x;
      const y2 = to.y + nodeHeight / 2;
      const bend = Math.max(35, Math.abs(x2 - x1) * 0.45);
      const downstream = edge.from === selectedItemId && directDownstream.has(edge.to);
      const color = downstream ? '#62c6e8' : edge.byproduct ? '#d1a65b' : '#466078';
      const marker = downstream ? 'downstream' : edge.byproduct ? 'byproduct' : 'normal';
      const gap = to.level - from.level - 1;
      const label = gap > 0 ? `<text class="graph-edge-label ${downstream ? 'downstream' : ''}" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">跨 ${gap} 层</text>` : '';
      return `<g class="graph-edge ${downstream ? 'downstream' : ''}">
        <title>${escapeHtml(nameOf(edge.from))} → ${escapeHtml(nameOf(edge.to))}${gap > 0 ? ` · 空跨 ${gap} 层` : ''}</title>
        <path d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${downstream ? 2.6 : 1.4}" ${edge.byproduct ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#arrow-${marker})"/>
        ${label}
      </g>`;
    }).join('');
    const nodeSvg = visible.map(itemId => {
      const position = positions.get(itemId);
      const zone = model.zoneFor(state, itemId);
      const external = state.externalItemIds.includes(itemId);
      const target = state.targetItemIds.includes(itemId);
      const fill = external ? '#173b35' : target ? '#3a301d' : zone?.isolated ? '#2b2140' : '#172635';
      const stroke = issueItems.has(itemId) ? '#f18383' : zone?.isolated ? '#896bb5' : '#385066';
      const subtitle = external ? '外部输入' : target ? '常备目标' : zone?.isolated ? zone.name : `L${position.level}`;
      const relation = selectedItemId === itemId ? 'selected' : downstreamItems.has(itemId) ? 'downstream' : 'context';
      return `<g class="graph-node ${relation}" data-select-item="${itemId}" data-node-id="${itemId}" tabindex="0" transform="translate(${position.x},${position.y})">
        <rect width="${nodeWidth}" height="${nodeHeight}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>
        <image href="${iconOf(itemId)}" x="10" y="13" width="32" height="32"/>
        <text x="49" y="24" fill="#edf3f7" font-size="12">${escapeHtml(shortName(nameOf(itemId)))}</text>
        <text x="49" y="43" fill="${external ? '#68d6a3' : target ? '#f0bc68' : '#91a7ba'}" font-size="10">${escapeHtml(shortName(subtitle, 20))}</text>
        <text x="169" y="17" fill="#71899f" font-size="9">L${position.level}</text>
      </g>`;
    }).join('');
    const svg = $('#dependency-graph');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.width = `${width * zoom}px`;
    svg.style.height = `${height * zoom}px`;
    svg.innerHTML = `<defs>
      <marker id="arrow-normal" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#466078"/></marker>
      <marker id="arrow-byproduct" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#d1a65b"/></marker>
      <marker id="arrow-downstream" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#62c6e8"/></marker>
    </defs>${levelLabels}${edgeSvg}${nodeSvg}`;
    $('#graph-empty').hidden = visible.length > 0;
  };
  const flowHtml = flow => `<div class="flow-row" data-select-item="${flow.itemId}" tabindex="0">
    <img class="item-icon" src="${iconOf(flow.itemId)}" alt="">
    <span>${escapeHtml(nameOf(flow.itemId))}</span>
    ${flow.isByproduct ? '<span class="badge">副产</span>' : ''}
    <span class="toolbar-spacer"></span>
    <span class="flow-amount">×${escapeHtml(flow.quantity)}</span>
  </div>`;
  const recipeCard = (recipe, itemId, consuming = false) => {
    const machine = machines.get(recipe.machineId);
    const selected = !consuming && model.selectedRecipe(state, itemId)?.id === recipe.id;
    const canSelect = !consuming && recipe.outputs.some(flow => flow.itemId === itemId && !flow.isByproduct);
    const primaryOutput = recipe.outputs.find(flow => flow.itemId === itemId) ?? recipe.outputs[0];
    const boundaries = recipe.inputs.filter(input => model.isIsolatedBoundary(state, primaryOutput.itemId, input.itemId)).map(input => `<div class="recipe-boundary">跨区接口：${escapeHtml(nameOf(input.itemId))} · ${escapeHtml(model.zoneFor(state, input.itemId)?.name ?? '主生产区')}</div>`).join('');
    return `<article class="recipe-card ${selected ? 'selected-recipe' : ''}">
      <div class="recipe-header">
        <img class="item-icon" src="${iconOf(machine.id)}" alt="">
        <div class="recipe-header-text">
          <strong>${escapeHtml(machine.localizedNames['zh-Hans'])}</strong>
          <span>${escapeHtml(recipe.id)}</span>
        </div>
        ${canSelect ? `<button class="small ${selected ? 'primary' : 'secondary'}" data-action="select-recipe" data-item="${itemId}" data-recipe="${recipe.id}">${selected ? '采用中' : '采用'}</button>` : ''}
      </div>
      <div class="recipe-body">
        <div class="recipe-meta"><span>耗时 ${escapeHtml(recipe.durationSeconds)} 秒</span><span>功率 ${machine.powerKW === null ? '待核' : `${escapeHtml(machine.powerKW)} kW`}</span></div>
        ${boundaries}
        <div class="recipe-side-label">输入</div>
        ${recipe.inputs.length ? recipe.inputs.map(flowHtml).join('') : '<p>无物品输入</p>'}
        <div class="recipe-side-label">输出</div>
        ${recipe.outputs.map(flowHtml).join('')}
      </div>
    </article>`;
  };
  const renderDetail = () => {
    const item = items.get(selectedItemId);
    if (!item) {
      $('#item-settings').innerHTML = '<div class="empty-state">点击物品开始规划</div>';
      $('#recipe-list').innerHTML = '';
      return;
    }
    const included = state.includedItemIds.includes(item.id);
    const zone = model.zoneFor(state, item.id);
    const level = model.effectiveLevel(state, topology, item.id);
    const automatic = topology.levels[item.id] ?? 0;
    const producing = data.recipes.filter(recipe => recipe.outputs.some(flow => flow.itemId === item.id));
    const consuming = data.recipes.filter(recipe => recipe.inputs.some(flow => flow.itemId === item.id));
    $('#item-settings').innerHTML = `<section class="detail-section">
      <div class="detail-item-header">
        <img class="item-icon" src="${iconOf(item.id)}" alt="">
        <div><h2>${escapeHtml(item.localizedNames['zh-Hans'])}</h2><p>${escapeHtml(item.localizedNames.en)}</p><p>${escapeHtml(item.id)}</p></div>
      </div>
      <div class="detail-badges">${itemBadges(item.id)}</div>
      ${included ? `<div class="settings-grid">
        <div class="setting-row"><label>所处层级</label><input id="detail-level" type="number" min="0" max="99" step="1" value="${level}"></div>
        <div class="setting-row"><span>自动推荐 L${automatic}</span><button class="small secondary" data-action="reset-level" data-item="${item.id}" ${state.manualLevels[item.id] === undefined ? 'disabled' : ''}>清除手动覆盖</button></div>
        <label class="checkbox-row"><input id="detail-target" type="checkbox" ${state.targetItemIds.includes(item.id) ? 'checked' : ''}>作为背包常备目标</label>
        <label class="checkbox-row"><input id="detail-external" type="checkbox" ${state.externalItemIds.includes(item.id) ? 'checked' : ''}>作为外部输入，不展开生产</label>
        <div class="setting-row"><label>所属分区</label><select id="detail-zone">${state.zones.map(entry => `<option value="${entry.id}" ${zone?.id === entry.id ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select></div>
        <label class="checkbox-row"><input id="detail-isolated" type="checkbox" ${zone?.isolated ? 'checked' : ''}>隔离当前分区，跨区依赖仅作接口</label>
        <div class="button-row">
          <button class="small secondary" data-action="add-item" data-item="${item.id}">补齐上游</button>
          <button class="small secondary" data-action="new-zone" data-item="${item.id}">新建分区</button>
          ${zone?.id !== 'main' ? `<button class="small danger-secondary" data-action="delete-zone" data-zone="${zone.id}">删除分区</button>` : ''}
          <button class="small danger-secondary" data-action="remove-item" data-item="${item.id}">移出物品</button>
        </div>
      </div>` : `<div class="settings-grid"><p>该物品尚未加入当前规划，加入时会按当前配方补齐上游。</p><button class="primary" data-action="add-item" data-item="${item.id}">加入物品并补齐上游</button></div>`}
    </section>`;
    $('#item-settings').insertAdjacentHTML('beforeend', usageSection(item.id));
    $('#recipe-list').innerHTML = `<section class="detail-section"><div class="section-title"><h3>生产配方 · ${producing.length}</h3></div><p>采用按钮只改变规划分支，原生配方始终完整保留。</p></section>
      ${producing.length ? producing.map(recipe => recipeCard(recipe, item.id)).join('') : '<div class="empty-state">没有原生生产配方</div>'}
      <section class="detail-section"><div class="section-title"><h3>下游消耗配方 · ${consuming.length}</h3></div></section>
      ${consuming.length ? consuming.map(recipe => recipeCard(recipe, item.id, true)).join('') : '<div class="empty-state">没有下游消耗配方</div>'}`;
  };
  const renderIssues = () => {
    $('#issues-list').innerHTML = issues.length ? issues.map((issue, index) => `<div class="issue-row ${issue.kind}" data-select-item="${issue.itemId}" data-issue="${index}">${escapeHtml(issue.text)}</div>`).join('') : '<div class="issue-row">没有发现缺失引用或层级冲突</div>';
  };
  const renderZoneFilter = () => {
    const select = $('#zone-filter');
    select.innerHTML = '<option value="all">全部分区</option>' + state.zones.map(zone => `<option value="${zone.id}">${escapeHtml(zone.name)}${zone.isolated ? ' · 隔离' : ''}</option>`).join('');
    if (zoneFilter !== 'all' && !state.zones.some(zone => zone.id === zoneFilter)) zoneFilter = 'all';
    select.value = zoneFilter;
  };
  const render = () => {
    topology = model.computeLevels(state);
    issues = model.getIssues(state, topology);
    renderStats();
    renderZoneFilter();
    renderCatalog();
    renderGraph();
    renderDetail();
    renderIssues();
  };
  const selectItem = itemId => {
    if (!items.has(itemId)) return;
    selectedItemId = itemId;
    render();
    const node = $('.graph-node.selected');
    const scroll = $('#graph-scroll');
    if (!node) return;
    const nodeRect = node.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    scroll.scrollLeft += nodeRect.left + nodeRect.width / 2 - scrollRect.left - scrollRect.width * 0.3;
    scroll.scrollTop += nodeRect.top + nodeRect.height / 2 - scrollRect.top - scrollRect.height / 2;
  };
  const removeItem = itemId => {
    const dependents = state.includedItemIds.filter(id => model.selectedRecipe(state, id)?.inputs.some(input => input.itemId === itemId));
    if (dependents.length && !window.confirm(`移出${nameOf(itemId)}会使 ${dependents.length} 个直接下游出现缺料，仍要继续吗？`)) return;
    state.includedItemIds = state.includedItemIds.filter(id => id !== itemId);
    state.targetItemIds = state.targetItemIds.filter(id => id !== itemId);
    state.externalItemIds = state.externalItemIds.filter(id => id !== itemId);
    delete state.recipeByItem[itemId];
    delete state.manualLevels[itemId];
    delete state.zoneByItem[itemId];
    commit(`已移出${nameOf(itemId)}，相关问题已保留显示`);
  };
  const actions = {
    'add-item': itemId => {
      model.addItemWithDependencies(state, itemId);
      selectedItemId = itemId;
      commit(`已加入${nameOf(itemId)}并补齐上游`);
    },
    'remove-item': removeItem,
    'reset-level': itemId => {
      delete state.manualLevels[itemId];
      commit(`已恢复${nameOf(itemId)}的自动层级`);
    },
    'select-recipe': (itemId, element) => {
      state.recipeByItem[itemId] = element.dataset.recipe;
      state.externalItemIds = state.externalItemIds.filter(id => id !== itemId);
      commit(`已采用 ${element.dataset.recipe}`);
    },
    'new-zone': itemId => {
      const name = window.prompt('新分区名称', '自定义隔离区');
      if (!name?.trim()) return;
      if (state.zones.some(zone => zone.name === name.trim())) {
        toast('分区名称已存在');
        return;
      }
      const id = `zone-${Date.now()}`;
      state.zones.push({ id, name: name.trim(), isolated: true });
      state.zoneByItem[itemId] = id;
      zoneFilter = id;
      commit(`已创建隔离分区${name.trim()}`);
    },
    'delete-zone': (_, element) => {
      const zoneId = element.dataset.zone;
      const zone = state.zones.find(entry => entry.id === zoneId);
      if (!zone || zoneId === 'main' || !window.confirm(`删除分区${zone.name}？其中物品会回到主生产区。`)) return;
      state.zones = state.zones.filter(entry => entry.id !== zoneId);
      for (const [itemId, assigned] of Object.entries(state.zoneByItem)) if (assigned === zoneId) state.zoneByItem[itemId] = 'main';
      if (zoneFilter === zoneId) zoneFilter = 'all';
      commit(`已删除分区${zone.name}`);
    },
  };
  document.addEventListener('click', event => {
    const actionElement = event.target.closest('[data-action]');
    if (actionElement) {
      event.stopPropagation();
      actions[actionElement.dataset.action]?.(actionElement.dataset.item, actionElement);
      return;
    }
    const itemElement = event.target.closest('[data-select-item]');
    if (itemElement) selectItem(itemElement.dataset.selectItem);
  });
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-select-item]')) {
      event.preventDefault();
      selectItem(event.target.closest('[data-select-item]').dataset.selectItem);
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'detail-level') {
      const level = Number(event.target.value);
      if (!Number.isInteger(level) || level < 0 || level > 99) {
        toast('层级必须是 0—99 的整数');
        renderDetail();
        return;
      }
      state.manualLevels[selectedItemId] = level;
      commit(`${nameOf(selectedItemId)}已设为 L${level}`);
    }
    if (event.target.id === 'detail-target') {
      const included = new Set(state.targetItemIds);
      event.target.checked ? included.add(selectedItemId) : included.delete(selectedItemId);
      state.targetItemIds = [...included].sort(model.nativeOrder);
      commit(event.target.checked ? '已加入常备目标' : '已取消常备目标');
    }
    if (event.target.id === 'detail-external') {
      const included = new Set(state.externalItemIds);
      event.target.checked ? included.add(selectedItemId) : included.delete(selectedItemId);
      state.externalItemIds = [...included].sort(model.nativeOrder);
      if (event.target.checked) state.manualLevels[selectedItemId] = 0;
      else delete state.manualLevels[selectedItemId];
      commit(event.target.checked ? '已设为外部输入' : '已恢复生产依赖');
    }
    if (event.target.id === 'detail-zone') {
      state.zoneByItem[selectedItemId] = event.target.value;
      commit(`已调整${nameOf(selectedItemId)}的分区`);
    }
    if (event.target.id === 'detail-isolated') {
      const zone = model.zoneFor(state, selectedItemId);
      zone.isolated = event.target.checked;
      commit(`${zone.name}${zone.isolated ? '已隔离' : '已取消隔离'}`);
    }
  });
  $('#item-search').addEventListener('input', renderCatalog);
  $('#zone-filter').addEventListener('change', event => { zoneFilter = event.target.value; renderGraph(); });
  $('#chain-filter').addEventListener('change', event => { chainFilter = event.target.value; renderGraph(); });
  const setZoom = value => {
    zoom = Math.max(0.25, Math.min(1.75, value));
    renderGraph();
  };
  $('#zoom-in').addEventListener('click', () => setZoom(zoom + 0.15));
  $('#zoom-out').addEventListener('click', () => setZoom(zoom - 0.15));
  $('#zoom-fit').addEventListener('click', () => setZoom(Math.min(1, $('#graph-scroll').clientWidth / lastGraphSize.width, ($('#graph-scroll').clientHeight - 20) / lastGraphSize.height)));
  $('#issues-toggle').addEventListener('click', () => {
    const list = $('#issues-list');
    list.hidden = !list.hidden;
    $('#issues-toggle').setAttribute('aria-expanded', String(!list.hidden));
  });
  $('#auto-levels').addEventListener('click', () => {
    if (!Object.keys(state.manualLevels).length || window.confirm('清除全部手动层级覆盖并按当前配方重新分层？')) {
      state.manualLevels = {};
      commit('已按当前配方重新自动分层');
    }
  });
  $('#collaboration-summary').addEventListener('click', () => {
    $('#summary-text').value = buildCollaborationSummary();
    $('#summary-dialog').showModal();
  });
  $('#summary-close').addEventListener('click', () => $('#summary-dialog').close());
  $('#summary-copy').addEventListener('click', async () => {
    const text = $('#summary-text');
    try {
      await navigator.clipboard.writeText(text.value);
      toast('协作摘要已复制');
    } catch {
      text.focus();
      text.select();
      toast(document.execCommand('copy') ? '协作摘要已复制' : '复制失败，请手动复制摘要');
    }
  });
  $('#summary-download').addEventListener('click', () => {
    const blob = new Blob([$('#summary-text').value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mall-summary-${data.game.buildId}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('协作摘要已下载');
  });
  $('#export-plan').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mall-plan-${data.game.buildId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('方案已导出');
  });
  $('#import-plan').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      state = model.validateImported(JSON.parse(await file.text()));
      selectedItemId = state.includedItemIds[0];
      commit(state.migrationNote ? `已导入 ${file.name}：${state.migrationNote}` : `已导入 ${file.name}`);
    } catch (error) {
      toast(`导入失败：${error.message}`);
    } finally {
      event.target.value = '';
    }
  });
  $('#reset-plan').addEventListener('click', () => {
    if (!window.confirm('放弃当前修改并恢复默认超市方案？')) return;
    state = model.createDefaultState();
    selectedItemId = 'ITEM_Protomatter';
    zoneFilter = 'all';
    chainFilter = 'all';
    commit('已恢复默认方案');
  });
  render();
  if (state.migrationNote) toast(state.migrationNote);
  else if (loadError) toast(`本地方案读取失败，已显示默认方案：${loadError}`);
})();
