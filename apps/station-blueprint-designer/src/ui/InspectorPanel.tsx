import React, { useMemo, useState } from 'react';
import {
  CATALOG_ITEMS,
  getBuildableDef,
  getItemNameZh,
  getModuleDef,
  getRecipeDef,
  getRecipesForCrafter,
} from '../core/catalog';
import {
  findBuildingsInsideModule,
  getBuildingSizeCells,
  getToggleablePorts,
  isPortToggleable,
  rotateSide,
  rotateVec2,
} from '../core/geometry';
import type { BlueprintDocument, MachinePortDef, PlacedBuilding, PlacedModule, SelectionState } from '../core/types';

export interface BuildingConfigPatch {
  recipeId?: string | null;
  label?: string | null;
  disabledPorts?: number[];
  undergroundMode?: 'in' | 'out';
  priorityIn?: number | null;
  priorityOut?: number | null;
  portFilters?: Record<number, string> | null;
  filterItems?: string[] | null;
}

interface InspectorPanelProps {
  doc: BlueprintDocument;
  selection: SelectionState;
  onUpdateBuilding: (ids: string[], patch: BuildingConfigPatch) => void;
  onUpdateModuleLabel: (id: string, label: string) => void;
  onCopySelection: () => void;
  onCutSelection: () => void;
  onSaveSelectionAsBlueprint: () => void;
  onRotateSelection: () => void;
  onDeleteSelection: () => void;
  onClearSelection: () => void;
}

const SIDE_ZH: Record<'N' | 'E' | 'S' | 'W', string> = {
  N: '北',
  E: '东',
  S: '南',
  W: '西',
};

function getPortDisplayLabel(
  kind: string,
  port: MachinePortDef,
  rotation: 0 | 1 | 2 | 3
): string {
  const worldSide = rotateSide(port.side, rotation);
  if (kind === 'splitter') {
    const rel =
      port.side === 'W' ? '输入' : port.side === 'E' ? '直出' : port.side === 'N' ? '左出' : '右出';
    return `${rel}(${SIDE_ZH[worldSide]})`;
  }
  if (kind === 'balancer') {
    const lane = port.hy < 0 ? '左道' : '右道';
    const role = port.role === 'in' ? '入' : '出';
    return `${lane}${role}(${SIDE_ZH[worldSide]})`;
  }
  return `#${port.index + 1}(${SIDE_ZH[worldSide]})`;
}

const PortDiagram: React.FC<{
  building: PlacedBuilding;
  onTogglePort?: (portIndex: number) => void;
}> = ({ building, onTogglePort }) => {
  const def = getBuildableDef(building.type);
  if (!def || (!def.configurablePorts && def.kind !== 'balancer')) return null;

  const [w, d] = getBuildingSizeCells(def, building.rotation);
  const disabledSet = new Set(building.disabledPorts ?? []);
  const viewW = Math.max(w, d) + 2.4;
  const pad = viewW / 2;

  return (
    <div className="port-diagram-wrap">
      <svg viewBox={`${-pad} ${-pad} ${viewW} ${viewW}`} className="port-diagram-svg">
        <rect
          x={-w / 2}
          y={-d / 2}
          width={w}
          height={d}
          rx={0.22}
          fill="var(--bg-surface)"
          stroke="var(--border-mid)"
          strokeWidth={0.09}
        />
        <text x={0} y={0.22} textAnchor="middle" fill="var(--text-muted)" fontSize={0.56} fontFamily="monospace">
          {w}×{d}
        </text>

        {def.ports.map((port) => {
          const [rx, ry] = rotateVec2(port.hx * 0.5, port.hy * 0.5, building.rotation);
          const side = rotateSide(port.side, building.rotation);
          const canToggle = isPortToggleable(def, port) && Boolean(onTogglePort);
          const enabled = canToggle ? !disabledSet.has(port.index) : true;
          const isPriority = building.priorityIn === port.index || building.priorityOut === port.index;
          const filterItemId = building.portFilters?.[port.index];
          const isHoriz = side === 'N' || side === 'S';
          const along = Math.min(0.62, Math.max(0.36, viewW * 0.08));
          const thick = Math.min(0.22, Math.max(0.14, viewW * 0.03));
          const rw = isHoriz ? along : thick;
          const rh = isHoriz ? thick : along;
          const ox = side === 'E' ? -thick * 0.28 : side === 'W' ? thick * 0.28 : 0;
          const oy = side === 'N' ? thick * 0.28 : side === 'S' ? -thick * 0.28 : 0;
          const cx = rx + ox;
          const cy = ry + oy;
          const portLabel = getPortDisplayLabel(def.kind, port, building.rotation);
          const strokeCol = !enabled
            ? 'var(--line-disabled)'
            : isPriority
              ? 'var(--line-warn)'
              : canToggle
                ? 'var(--line-active)'
                : 'var(--text-dim)';

          return (
            <g
              key={port.index}
              className={canToggle ? 'port-node' : 'port-node-fixed'}
              onClick={canToggle ? () => onTogglePort?.(port.index) : undefined}
              style={{ cursor: canToggle ? 'pointer' : 'default' }}
            >
              <title>
                {`${portLabel} · ${
                  canToggle ? (enabled ? '活跃（点击禁用）' : '已禁用（点击启用）') : '固定启用（不可关闭）'
                }${isPriority ? ' · 优先通道' : ''}${
                  filterItemId ? ` · 过滤：${getItemNameZh(filterItemId)}` : ''
                }`}
              </title>
              <rect
                x={cx - rw / 2}
                y={cy - rh / 2}
                width={rw}
                height={rh}
                rx={0.04}
                fill="var(--bg-input)"
                stroke={strokeCol}
                strokeWidth={isPriority ? 0.12 : canToggle ? 0.095 : 0.075}
                strokeDasharray={!canToggle && !isPriority ? '0.12 0.08' : undefined}
              />
              {enabled ? (
                isHoriz ? (
                  <line
                    x1={cx - rw * 0.3}
                    y1={cy}
                    x2={cx + rw * 0.3}
                    y2={cy}
                    stroke={strokeCol}
                    strokeWidth={0.08}
                  />
                ) : (
                  <line
                    x1={cx}
                    y1={cy - rh * 0.3}
                    x2={cx}
                    y2={cy + rh * 0.3}
                    stroke={strokeCol}
                    strokeWidth={0.08}
                  />
                )
              ) : (
                <g stroke="var(--line-disabled)" strokeWidth={0.08}>
                  <line x1={cx - rw * 0.38} y1={cy - rh * 0.38} x2={cx + rw * 0.38} y2={cy + rh * 0.38} />
                  <line x1={cx + rw * 0.38} y1={cy - rh * 0.38} x2={cx - rw * 0.38} y2={cy + rh * 0.38} />
                </g>
              )}
              {filterItemId && enabled && (
                <circle cx={cx} cy={cy} r={Math.min(rw, rh) * 0.34} fill="var(--border-focus)" />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  doc,
  selection,
  onUpdateBuilding,
  onUpdateModuleLabel,
  onCopySelection,
  onCutSelection,
  onSaveSelectionAsBlueprint,
  onRotateSelection,
  onDeleteSelection,
  onClearSelection,
}) => {
  const [recipeQuery, setRecipeQuery] = useState('');
  const [itemQuery, setItemQuery] = useState('');

  const selectedModules = useMemo(
    () => doc.modules.filter((m) => selection.moduleIds.includes(m.id)),
    [doc.modules, selection.moduleIds]
  );
  const selectedBuildings = useMemo(
    () => doc.buildings.filter((b) => selection.buildingIds.includes(b.id)),
    [doc.buildings, selection.buildingIds]
  );

  const totalSelected = selectedModules.length + selectedBuildings.length;
  if (totalSelected === 0) return null;

  const singleBuilding: PlacedBuilding | null =
    selectedBuildings.length === 1 && selectedModules.length === 0 ? selectedBuildings[0] : null;
  const singleModule: PlacedModule | null =
    selectedModules.length === 1 && selectedBuildings.length === 0 ? selectedModules[0] : null;

  if (singleBuilding) {
    const def = getBuildableDef(singleBuilding.type);
    const recipes = def ? getRecipesForCrafter(def.crafterId) : [];
    const currentRecipe = singleBuilding.recipeId ? getRecipeDef(singleBuilding.recipeId) : null;
    const filteredRecipes = recipes.filter((r) => {
      const q = recipeQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        r.nameZh.toLowerCase().includes(q) ||
        r.nameEn.toLowerCase().includes(q) ||
        r.shortCode.toLowerCase().includes(q)
      );
    });
    const disabledSet = new Set(singleBuilding.disabledPorts ?? []);
    const toggleablePorts = def ? getToggleablePorts(def) : [];
    const activeToggleCount = toggleablePorts.filter((p) => !disabledSet.has(p.index)).length;

    const inputPorts = def ? def.ports.filter((p) => p.role === 'in') : [];
    const outputPorts = def ? def.ports.filter((p) => p.role === 'out') : [];
    const isSplitterOrBalancer = def?.kind === 'splitter' || def?.kind === 'balancer';
    const isContainer = def?.kind === 'container';

    const filteredCatalogItems = CATALOG_ITEMS.filter((it) => {
      const q = itemQuery.trim().toLowerCase();
      if (!q) return true;
      return it.nameZh.toLowerCase().includes(q) || it.id.toLowerCase().includes(q);
    });

    const handleTogglePort = (idx: number) => {
      if (!def) return;
      const pDef = def.ports.find((p) => p.index === idx);
      if (!pDef || !isPortToggleable(def, pDef)) return;
      const next = new Set(disabledSet);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      const patch: BuildingConfigPatch = { disabledPorts: Array.from(next) };
      if (next.has(idx)) {
        if (singleBuilding.priorityIn === idx) patch.priorityIn = null;
        if (singleBuilding.priorityOut === idx) patch.priorityOut = null;
      }
      onUpdateBuilding([singleBuilding.id], patch);
    };

    const handleSetPortFilter = (portIdx: number, itemId: string) => {
      const next: Record<number, string> = { ...(singleBuilding.portFilters ?? {}) };
      if (!itemId) delete next[portIdx];
      else next[portIdx] = itemId;
      onUpdateBuilding([singleBuilding.id], { portFilters: Object.keys(next).length > 0 ? next : null });
    };

    const handleToggleContainerFilter = (itemId: string) => {
      const cur = new Set(singleBuilding.filterItems ?? []);
      if (cur.has(itemId)) cur.delete(itemId);
      else cur.add(itemId);
      onUpdateBuilding([singleBuilding.id], { filterItems: Array.from(cur) });
    };

    return (
      <aside className="cad-sidebar right">
        <div className="panel-header">
          <div className="panel-title-wrap">
            <span className="panel-tag">BUILDING</span>
            <span className="panel-title">{def?.nameZh ?? singleBuilding.type}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClearSelection} title="取消选中 (Esc/右键)">
            ×
          </button>
        </div>

        <div className="inspector-body">
          <div className="inspector-kv">
            <span>原名</span>
            <code>{def?.nameEn ?? singleBuilding.type}</code>
            <span>坐标 / 楼层</span>
            <code>({singleBuilding.x}, {singleBuilding.y}) · L{singleBuilding.floor}</code>
            <span>尺寸 / 朝向</span>
            <code>{def ? `${def.size[0]}×${def.size[1]}` : '?'} · {singleBuilding.rotation * 90}°</code>
          </div>

          {/* Underground entry/exit switch */}
          {def?.kind === 'underground' && (
            <div className="inspector-section">
              <div className="section-label">地下传送带端模式</div>
              <div className="btn-row">
                <button
                  type="button"
                  className={`cad-btn ${singleBuilding.undergroundMode !== 'out' ? 'accent' : ''}`}
                  onClick={() => onUpdateBuilding([singleBuilding.id], { undergroundMode: 'in' })}
                >
                  入口 (IN)
                </button>
                <button
                  type="button"
                  className={`cad-btn ${singleBuilding.undergroundMode === 'out' ? 'accent' : ''}`}
                  onClick={() => onUpdateBuilding([singleBuilding.id], { undergroundMode: 'out' })}
                >
                  出口 (OUT)
                </button>
              </div>
            </div>
          )}

          {/* Splitter / Balancer Priority Configuration */}
          {isSplitterOrBalancer && def && (
            <div className="inspector-section">
              {def.kind === 'balancer' && inputPorts.length >= 2 && (
                <>
                  <div className="section-label">输入优先级</div>
                  <div className="btn-row compact">
                    <button
                      type="button"
                      className={`cad-btn ${singleBuilding.priorityIn === undefined ? 'accent' : ''}`}
                      onClick={() => onUpdateBuilding([singleBuilding.id], { priorityIn: null })}
                    >
                      均衡
                    </button>
                    {inputPorts.map((p) => (
                      <button
                        key={p.index}
                        type="button"
                        className={`cad-btn ${singleBuilding.priorityIn === p.index ? 'accent' : ''}`}
                        onClick={() =>
                          onUpdateBuilding([singleBuilding.id], {
                            priorityIn: singleBuilding.priorityIn === p.index ? null : p.index,
                          })
                        }
                      >
                        {getPortDisplayLabel(def.kind, p, singleBuilding.rotation)}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {outputPorts.length >= 2 && (
                <>
                  <div className="section-label">输出优先级</div>
                  <div className="btn-row compact">
                    <button
                      type="button"
                      className={`cad-btn ${singleBuilding.priorityOut === undefined ? 'accent' : ''}`}
                      onClick={() => onUpdateBuilding([singleBuilding.id], { priorityOut: null })}
                    >
                      均分
                    </button>
                    {outputPorts.map((p) => (
                      <button
                        key={p.index}
                        type="button"
                        className={`cad-btn ${singleBuilding.priorityOut === p.index ? 'accent' : ''}`}
                        onClick={() =>
                          onUpdateBuilding([singleBuilding.id], {
                            priorityOut: singleBuilding.priorityOut === p.index ? null : p.index,
                          })
                        }
                      >
                        {getPortDisplayLabel(def.kind, p, singleBuilding.rotation)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Splitter / Balancer Output Item Filters */}
          {isSplitterOrBalancer && def && outputPorts.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">输出口物品过滤</span>
                {singleBuilding.portFilters && Object.keys(singleBuilding.portFilters).length > 0 && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { portFilters: null })}
                  >
                    清空
                  </button>
                )}
              </div>
              <div className="port-filter-list">
                {outputPorts.map((p) => {
                  const curVal = singleBuilding.portFilters?.[p.index] ?? '';
                  return (
                    <label key={p.index} className="port-filter-row">
                      <span className="port-filter-tag">
                        {getPortDisplayLabel(def.kind, p, singleBuilding.rotation)}
                      </span>
                      <select
                        className="cad-input port-filter-select"
                        value={curVal}
                        onChange={(e) => handleSetPortFilter(p.index, e.target.value)}
                      >
                        <option value="">不限物品</option>
                        {CATALOG_ITEMS.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.nameZh}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recipe Picker (0 simulation, pure planning tag!) */}
          {recipes.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">配方配置（规划标注）</span>
                {currentRecipe && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { recipeId: null })}
                  >
                    清除
                  </button>
                )}
              </div>
              {currentRecipe && (
                <div className="recipe-active-card">
                  <div className="recipe-active-title">{currentRecipe.nameZh}</div>
                  <div className="recipe-io">
                    {currentRecipe.inputs.map((i) => i.nameZh).join(' + ')} →{' '}
                    {currentRecipe.outputs.map((o) => o.nameZh).join(' + ')}
                  </div>
                </div>
              )}
              <input
                id="recipe-filter"
                name="recipeFilter"
                type="text"
                className="cad-input"
                placeholder={`筛选 ${recipes.length} 个配方...`}
                value={recipeQuery}
                onChange={(e) => setRecipeQuery(e.target.value)}
              />
              <div className="recipe-list">
                {filteredRecipes.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`recipe-item ${singleBuilding.recipeId === r.id ? 'selected' : ''}`}
                    onClick={() => onUpdateBuilding([singleBuilding.id], { recipeId: r.id })}
                  >
                    <span className="recipe-name">{r.nameZh}</span>
                    <span className="recipe-en">{r.shortCode}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Container Logistic Item Filters (WBP_LogisticFilters) */}
          {isContainer && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">
                  容器物流过滤（{singleBuilding.filterItems?.length ?? 0}）
                </span>
                {singleBuilding.filterItems && singleBuilding.filterItems.length > 0 && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { filterItems: null })}
                  >
                    清空
                  </button>
                )}
              </div>
              {singleBuilding.filterItems && singleBuilding.filterItems.length > 0 && (
                <div className="filter-chip-row">
                  {singleBuilding.filterItems.map((itemId) => (
                    <button
                      key={itemId}
                      type="button"
                      className="filter-chip"
                      onClick={() => handleToggleContainerFilter(itemId)}
                      title="点击移除该物品过滤"
                    >
                      {getItemNameZh(itemId)} ×
                    </button>
                  ))}
                </div>
              )}
              <input
                id="container-item-filter"
                name="containerItemFilter"
                type="text"
                className="cad-input"
                placeholder={`筛选 ${CATALOG_ITEMS.length} 种物品...`}
                value={itemQuery}
                onChange={(e) => setItemQuery(e.target.value)}
              />
              <div className="recipe-list">
                {filteredCatalogItems.slice(0, 40).map((it) => {
                  const active = singleBuilding.filterItems?.includes(it.id) ?? false;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={`recipe-item ${active ? 'selected' : ''}`}
                      onClick={() => handleToggleContainerFilter(it.id)}
                    >
                      <span className="recipe-name">{it.nameZh}</span>
                      <span className="recipe-en">{active ? '已选' : '+'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Active / Disabled Ports Configuration (only for buildings with genuinely toggleable ports!) */}
          {def && toggleablePorts.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">
                  {def.kind === 'splitter' ? '输出接口' : '接口状态'}（活跃 {activeToggleCount}/{toggleablePorts.length}）
                </span>
                <div className="btn-row compact">
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { disabledPorts: [] })}
                  >
                    全开
                  </button>
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() =>
                      onUpdateBuilding([singleBuilding.id], {
                        disabledPorts: toggleablePorts.map((p) => p.index),
                        priorityOut: null,
                      })
                    }
                  >
                    全关
                  </button>
                </div>
              </div>
              <PortDiagram building={singleBuilding} onTogglePort={handleTogglePort} />
              <div className="port-legend">
                <span><i className="dot green" /> 活跃</span>
                <span><i className="dot red" /> 禁用（点击切换）</span>
              </div>
            </div>
          )}

          {/* Read-only lane reference diagram for Belt Balancer (all 4 lanes are fixed always-on) */}
          {def?.kind === 'balancer' && (
            <div className="inspector-section">
              <div className="section-label">通道方位示意（四口固定启用）</div>
              <PortDiagram building={singleBuilding} />
            </div>
          )}

          {/* Custom planning note */}
          <div className="inspector-section">
            <div className="section-label">自定义规划标注</div>
            <input
              id="building-label"
              name="buildingLabel"
              type="text"
              className="cad-input"
              placeholder="输入简短标注（显示在 3D 顶面）"
              value={singleBuilding.label ?? ''}
              onChange={(e) => onUpdateBuilding([singleBuilding.id], { label: e.target.value })}
            />
          </div>
        </div>

        <div className="inspector-footer">
          <button type="button" className="cad-btn" onClick={onRotateSelection} title="原地旋转 (R)">旋转 (R)</button>
          <button type="button" className="cad-btn" onClick={onCutSelection} title="剪切并搬移到新位置 (Ctrl+X)">剪切搬移</button>
          <button type="button" className="cad-btn" onClick={onCopySelection} title="复制为幽灵蓝图 (Ctrl+C)">复制</button>
          <button type="button" className="cad-btn danger" onClick={onDeleteSelection} title="删除 (Del)">删除</button>
        </div>
      </aside>
    );
  }

  if (singleModule) {
    const def = getModuleDef(singleModule.type);
    const insideCount = findBuildingsInsideModule(doc, singleModule).length;
    return (
      <aside className="cad-sidebar right">
        <div className="panel-header">
          <div className="panel-title-wrap">
            <span className="panel-tag">MODULE</span>
            <span className="panel-title">{def?.nameZh ?? singleModule.type}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClearSelection}>×</button>
        </div>
        <div className="inspector-body">
          <div className="inspector-kv">
            <span>原名</span>
            <code>{def?.nameEn ?? singleModule.type}</code>
            <span>大格 / 楼层</span>
            <code>({singleModule.gx}, {singleModule.gy}) · L{singleModule.floor}</code>
            <span>跨度 / 接口</span>
            <code>{def ? `${def.sizeUnits[0]}×${def.sizeUnits[1]}×${def.sizeUnits[2]}层` : '?'} · {def?.connectors.length ?? 0}口</code>
            <span>内部建筑</span>
            <code>{insideCount} 个</code>
          </div>
          {def?.floors.some((f) => f.note) && (
            <div className="inspector-note">
              {def.floors.filter((f) => f.note).map((f) => f.note).join('；')}
            </div>
          )}
          <div className="inspector-section">
            <div className="section-label">模块规划标注</div>
            <input
              id="module-label"
              name="moduleLabel"
              type="text"
              className="cad-input"
              placeholder="例如：电路板装配区"
              value={singleModule.label ?? ''}
              onChange={(e) => onUpdateModuleLabel(singleModule.id, e.target.value)}
            />
          </div>
        </div>
        <div className="inspector-footer">
          <button type="button" className="cad-btn" onClick={onRotateSelection} title="原地旋转 (R)">旋转 (R)</button>
          <button type="button" className="cad-btn accent" onClick={onCutSelection} title="连带内部建筑一起剪切搬移 (Ctrl+X)">剪切搬移</button>
          <button type="button" className="cad-btn" onClick={onCopySelection} title="复制模块及内部建筑 (Ctrl+C)">复制</button>
          <button type="button" className="cad-btn" onClick={onSaveSelectionAsBlueprint} title="保存为蓝图文件 (Ctrl+S)">存蓝图</button>
          <button type="button" className="cad-btn danger" onClick={onDeleteSelection} title="删除 (Del)">删除</button>
        </div>
      </aside>
    );
  }

  // Multi-selection panel
  const floors = new Set<number>([
    ...selectedModules.map((m) => m.floor),
    ...selectedBuildings.map((b) => b.floor),
  ]);
  const floorLabel = Array.from(floors).sort((a, b) => a - b).map((f) => `L${f}`).join(', ');

  return (
    <aside className="cad-sidebar right">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">MULTI</span>
          <span className="panel-title">已选 {totalSelected} 项</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClearSelection}>×</button>
      </div>
      <div className="inspector-body">
        <div className="inspector-kv">
          <span>空间站模块</span>
          <code>{selectedModules.length}</code>
          <span>内部建筑</span>
          <code>{selectedBuildings.length}</code>
          <span>涉及楼层</span>
          <code>{floorLabel || '-'}</code>
        </div>
        <div className="inspector-footer vertical">
          <button type="button" className="cad-btn accent" onClick={onCutSelection}>
            剪切搬移（连带内部建筑 · Ctrl+X）
          </button>
          <button type="button" className="cad-btn" onClick={onCopySelection}>
            复制为幽灵蓝图 (Ctrl+C)
          </button>
          <button type="button" className="cad-btn" onClick={onSaveSelectionAsBlueprint}>
            保存选区为蓝图 (Ctrl+S)
          </button>
          <button type="button" className="cad-btn" onClick={onRotateSelection}>
            原地旋转 (R)
          </button>
          <button type="button" className="cad-btn danger" onClick={onDeleteSelection}>
            删除选中 (Del)
          </button>
        </div>
      </div>
    </aside>
  );
};
