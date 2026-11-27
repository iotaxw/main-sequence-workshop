import React, { useMemo, useState } from 'react';
import {
  CATALOG_ITEMS,
  getBuildableDef,
  getBuildableName,
  getItemName,
  getModuleDef,
  getModuleName,
  getRecipeDef,
  getRecipeName,
  getRecipesForCrafter,
} from '../core/catalog';
import type { ModuleConfigPatch } from '../core/commands';
import {
  findBuildingsInsideModule,
  getBuildingSizeCells,
  getBuildingSpatialIndex,
  getModuleSpatialIndex,
  getModuleWorldDockPorts,
  getToggleablePorts,
  isPortToggleable,
  rotateSide,
  rotateVec2,
} from '../core/geometry';
import { formatFloorTag, type Lang, useI18n } from '../core/i18n';
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
  onUpdateModuleConfig: (id: string, patch: ModuleConfigPatch) => void;
  onCopySelection: () => void;
  onCutSelection: () => void;
  onSaveSelectionAsBlueprint: () => void;
  onRotateSelection: () => void;
  onMirrorSelection: (vertical?: boolean) => void;
  onDeleteSelection: () => void;
  onClearSelection: () => void;
}

const SIDE_ZH: Record<'N' | 'E' | 'S' | 'W', string> = { N: '北', E: '东', S: '南', W: '西' };

function getPortDisplayLabel(
  kind: string,
  port: MachinePortDef,
  rotation: 0 | 1 | 2 | 3,
  lang: Lang
): string {
  const worldSide = rotateSide(port.side, rotation);
  const sideLabel = lang === 'en' ? worldSide : SIDE_ZH[worldSide];
  if (kind === 'splitter') {
    const rel =
      lang === 'en'
        ? port.side === 'W'
          ? 'In'
          : port.side === 'E'
            ? 'Fwd'
            : port.side === 'N'
              ? 'L'
              : 'R'
        : port.side === 'W'
          ? '输入'
          : port.side === 'E'
            ? '直出'
            : port.side === 'N'
              ? '左出'
              : '右出';
    return `${rel}(${sideLabel})`;
  }
  if (kind === 'balancer') {
    const lane = lang === 'en' ? (port.hy < 0 ? 'L' : 'R') : port.hy < 0 ? '左道' : '右道';
    const role = lang === 'en' ? (port.role === 'in' ? 'In' : 'Out') : port.role === 'in' ? '入' : '出';
    return `${lane}${role}(${sideLabel})`;
  }
  return `#${port.index + 1}(${sideLabel})`;
}

const PortDiagram: React.FC<{
  building: PlacedBuilding;
  lang: Lang;
  onTogglePort?: (portIndex: number) => void;
}> = ({ building, lang, onTogglePort }) => {
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
          const portLabel = getPortDisplayLabel(def.kind, port, building.rotation, lang);
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
                  canToggle
                    ? enabled
                      ? lang === 'en'
                        ? 'Active'
                        : '活跃'
                      : lang === 'en'
                        ? 'Disabled'
                        : '禁用'
                    : lang === 'en'
                      ? 'Fixed'
                      : '固定'
                }${isPriority ? (lang === 'en' ? ' · Priority' : ' · 优先') : ''}${
                  filterItemId ? ` · ${getItemName(filterItemId, lang)}` : ''
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
                  <line x1={cx - rw * 0.3} y1={cy} x2={cx + rw * 0.3} y2={cy} stroke={strokeCol} strokeWidth={0.08} />
                ) : (
                  <line x1={cx} y1={cy - rh * 0.3} x2={cx} y2={cy + rh * 0.3} stroke={strokeCol} strokeWidth={0.08} />
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
  onUpdateModuleConfig,
  onCopySelection,
  onCutSelection,
  onSaveSelectionAsBlueprint,
  onRotateSelection,
  onMirrorSelection,
  onDeleteSelection,
  onClearSelection,
}) => {
  const { lang, isEn, t } = useI18n();
  const [recipeQuery, setRecipeQuery] = useState('');
  const [itemQuery, setItemQuery] = useState('');

  const selectedModules = useMemo(() => {
    const byId = getModuleSpatialIndex(doc.modules).moduleById;
    return selection.moduleIds.map((id) => byId.get(id)).filter((m): m is PlacedModule => Boolean(m));
  }, [doc.modules, selection.moduleIds]);
  const selectedBuildings = useMemo(() => {
    const byId = getBuildingSpatialIndex(doc.buildings).buildingById;
    return selection.buildingIds.map((id) => byId.get(id)).filter((b): b is PlacedBuilding => Boolean(b));
  }, [doc.buildings, selection.buildingIds]);

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
        getRecipeName(r, 'en').toLowerCase().includes(q) ||
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
      return (
        it.nameZh.toLowerCase().includes(q) ||
        it.nameEn.toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q)
      );
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
            <span className="panel-title">{def ? getBuildableName(def, lang) : singleBuilding.type}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClearSelection} title={t('关闭 (Esc)', 'Close (Esc)')}>
            ×
          </button>
        </div>

        <div className="inspector-body">
          <div className="inspector-kv">
            <span>{t('坐标 / 楼层', 'Pos / Floor')}</span>
            <code>({singleBuilding.x}, {singleBuilding.y}) · {formatFloorTag(singleBuilding.floor)}</code>
            <span>{t('尺寸 / 朝向', 'Size / Rot')}</span>
            <code>{def ? `${def.size[0]}×${def.size[1]}` : '?'} · {singleBuilding.rotation * 90}°</code>
          </div>

          {def?.kind === 'underground' && (
            <div className="inspector-section">
              <div className="section-label">{t('端模式', 'Tunnel End')}</div>
              <div className="btn-row">
                <button
                  type="button"
                  className={`cad-btn ${singleBuilding.undergroundMode !== 'out' ? 'accent' : ''}`}
                  onClick={() => onUpdateBuilding([singleBuilding.id], { undergroundMode: 'in' })}
                >
                  {t('入口 (IN)', 'Entry (IN)')}
                </button>
                <button
                  type="button"
                  className={`cad-btn ${singleBuilding.undergroundMode === 'out' ? 'accent' : ''}`}
                  onClick={() => onUpdateBuilding([singleBuilding.id], { undergroundMode: 'out' })}
                >
                  {t('出口 (OUT)', 'Exit (OUT)')}
                </button>
              </div>
            </div>
          )}

          {isSplitterOrBalancer && def && (
            <div className="inspector-section">
              {def.kind === 'balancer' && inputPorts.length >= 2 && (
                <>
                  <div className="section-label">{t('输入优先', 'Input Priority')}</div>
                  <div className="btn-row compact">
                    <button
                      type="button"
                      className={`cad-btn ${singleBuilding.priorityIn === undefined ? 'accent' : ''}`}
                      onClick={() => onUpdateBuilding([singleBuilding.id], { priorityIn: null })}
                    >
                      {t('均衡', 'Even')}
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
                        {getPortDisplayLabel(def.kind, p, singleBuilding.rotation, lang)}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {outputPorts.length >= 2 && (
                <>
                  <div className="section-label">{t('输出优先', 'Output Priority')}</div>
                  <div className="btn-row compact">
                    <button
                      type="button"
                      className={`cad-btn ${singleBuilding.priorityOut === undefined ? 'accent' : ''}`}
                      onClick={() => onUpdateBuilding([singleBuilding.id], { priorityOut: null })}
                    >
                      {t('均分', 'Even')}
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
                        {getPortDisplayLabel(def.kind, p, singleBuilding.rotation, lang)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {isSplitterOrBalancer && def && outputPorts.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">{t('输出过滤', 'Output Filter')}</span>
                {singleBuilding.portFilters && Object.keys(singleBuilding.portFilters).length > 0 && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { portFilters: null })}
                  >
                    {t('清空', 'Clear')}
                  </button>
                )}
              </div>
              <div className="port-filter-list">
                {outputPorts.map((p) => {
                  const curVal = singleBuilding.portFilters?.[p.index] ?? '';
                  return (
                    <label key={p.index} className="port-filter-row">
                      <span className="port-filter-tag">
                        {getPortDisplayLabel(def.kind, p, singleBuilding.rotation, lang)}
                      </span>
                      <select
                        className="cad-input port-filter-select"
                        value={curVal}
                        onChange={(e) => handleSetPortFilter(p.index, e.target.value)}
                      >
                        <option value="">{t('不限', 'Any')}</option>
                        {CATALOG_ITEMS.map((it) => (
                          <option key={it.id} value={it.id}>
                            {isEn ? it.nameEn : it.nameZh}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {recipes.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">{t('配方', 'Recipe')}</span>
                {currentRecipe && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { recipeId: null })}
                  >
                    {t('清除', 'Clear')}
                  </button>
                )}
              </div>
              {currentRecipe && (
                <div className="recipe-active-card">
                  <div className="recipe-active-title">{getRecipeName(currentRecipe, lang)}</div>
                  <div className="recipe-io">
                    {currentRecipe.inputs.map((i) => getItemName(i.itemId, lang)).join(' + ')} →{' '}
                    {currentRecipe.outputs.map((o) => getItemName(o.itemId, lang)).join(' + ')}
                  </div>
                </div>
              )}
              <input
                id="recipe-filter"
                name="recipeFilter"
                type="text"
                className="cad-input"
                placeholder={t(`筛选 ${recipes.length} 个配方...`, `Filter ${recipes.length} recipes...`)}
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
                    <span className="recipe-name">{getRecipeName(r, lang)}</span>
                    <span className="recipe-en">{r.shortCode}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isContainer && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">
                  {t(`容器过滤 (${singleBuilding.filterItems?.length ?? 0})`, `Filters (${singleBuilding.filterItems?.length ?? 0})`)}
                </span>
                {singleBuilding.filterItems && singleBuilding.filterItems.length > 0 && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { filterItems: null })}
                  >
                    {t('清空', 'Clear')}
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
                    >
                      {getItemName(itemId, lang)} ×
                    </button>
                  ))}
                </div>
              )}
              <input
                id="container-item-filter"
                name="containerItemFilter"
                type="text"
                className="cad-input"
                placeholder={t(`筛选物品...`, `Filter items...`)}
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
                      <span className="recipe-name">{isEn ? it.nameEn : it.nameZh}</span>
                      <span className="recipe-en">{active ? '✓' : '+'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {def && toggleablePorts.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">
                  {t('接口', 'Ports')} ({activeToggleCount}/{toggleablePorts.length})
                </span>
                <div className="btn-row compact">
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateBuilding([singleBuilding.id], { disabledPorts: [] })}
                  >
                    {t('全开', 'All On')}
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
                    {t('全关', 'All Off')}
                  </button>
                </div>
              </div>
              <PortDiagram building={singleBuilding} lang={lang} onTogglePort={handleTogglePort} />
              <div className="port-legend">
                <span><i className="dot green" /> {t('活跃', 'On')}</span>
                <span><i className="dot red" /> {t('禁用', 'Off')}</span>
              </div>
            </div>
          )}

          {def?.kind === 'balancer' && (
            <div className="inspector-section">
              <div className="section-label">{t('通道方位', 'Lanes')}</div>
              <PortDiagram building={singleBuilding} lang={lang} />
            </div>
          )}

          <div className="inspector-section">
            <div className="section-label">{t('标注', 'Label')}</div>
            <input
              id="building-label"
              name="buildingLabel"
              type="text"
              className="cad-input"
              placeholder={t('输入标注', 'Optional note')}
              value={singleBuilding.label ?? ''}
              onChange={(e) => onUpdateBuilding([singleBuilding.id], { label: e.target.value })}
            />
          </div>
        </div>

        <div className="inspector-footer">
          <button type="button" className="cad-btn" onClick={onRotateSelection} title="R">{t('旋转', 'Rotate')}</button>
          <button type="button" className="cad-btn" onClick={(e) => onMirrorSelection(e.shiftKey)} title="F / Shift+F">{t('镜像', 'Mirror')}</button>
          <button type="button" className="cad-btn" onClick={onCutSelection} title="Ctrl+X">{t('搬移', 'Move')}</button>
          <button type="button" className="cad-btn" onClick={onCopySelection} title="Ctrl+C">{t('复制', 'Copy')}</button>
          <button type="button" className="cad-btn danger" onClick={onDeleteSelection} title="Del">{t('删除', 'Delete')}</button>
        </div>
      </aside>
    );
  }

  if (singleModule) {
    const def = getModuleDef(singleModule.type);
    const insideCount = findBuildingsInsideModule(doc, singleModule).length;
    const dockPortsWorld = def ? getModuleWorldDockPorts(singleModule, def) : [];
    const hasDockName =
      dockPortsWorld.length > 0 || singleModule.type.startsWith('BPO_ShipyardCore');
    const isMiningBay = singleModule.type.startsWith('BPO_MiningDroneBay');
    const obsRecipes =
      singleModule.type === 'BPO_DeepSpaceObservatory'
        ? getRecipesForCrafter('CRAFT_DeepSpaceObservatory')
        : [];

    const updateDockSlot = (portIndex: number, nextItemId: string, nextMode?: 'unload' | 'load') => {
      const existing = (singleModule.dockPorts ?? []).filter((p) => p.portIndex !== portIndex);
      if (nextItemId) {
        const cur = singleModule.dockPorts?.find((p) => p.portIndex === portIndex);
        existing.push({
          portIndex,
          itemId: nextItemId,
          mode: nextMode ?? cur?.mode ?? 'unload',
        });
      }
      onUpdateModuleConfig(singleModule.id, { dockPorts: existing });
    };

    return (
      <aside className="cad-sidebar right">
        <div className="panel-header">
          <div className="panel-title-wrap">
            <span className="panel-tag">MODULE</span>
            <span className="panel-title">{def ? getModuleName(def, lang) : singleModule.type}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClearSelection}>×</button>
        </div>
        <div className="inspector-body">
          <div className="inspector-kv">
            <span>{t('大格 / 楼层', 'Grid / Floor')}</span>
            <code>({singleModule.gx}, {singleModule.gy}) · {formatFloorTag(singleModule.floor)}</code>
            <span>{t('跨度 / 接口', 'Span / Ports')}</span>
            <code>
              {def
                ? isEn
                  ? `${def.sizeUnits[0]}×${def.sizeUnits[1]}×${def.sizeUnits[2]}F · ${def.connectors.length}P`
                  : `${def.sizeUnits[0]}×${def.sizeUnits[1]}×${def.sizeUnits[2]}层 · ${def.connectors.length}口`
                : '?'}
            </code>
            <span>{t('内部建筑', 'Buildings')}</span>
            <code>{insideCount}</code>
          </div>

          {hasDockName && (
            <div className="inspector-section">
              <div className="section-label">{t('泊位名称', 'Dock Name')}</div>
              <input
                id="module-dock-name"
                name="moduleDockName"
                type="text"
                className="cad-input"
                placeholder={t('输入泊位名称', 'Dock name')}
                value={singleModule.dockName ?? ''}
                onChange={(e) => onUpdateModuleConfig(singleModule.id, { dockName: e.target.value })}
              />
            </div>
          )}

          {dockPortsWorld.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">
                  {t('货港接口', 'Dock Ports')} ({singleModule.dockPorts?.length ?? 0}/{dockPortsWorld.length})
                </span>
                {singleModule.dockPorts && singleModule.dockPorts.length > 0 && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateModuleConfig(singleModule.id, { dockPorts: [] })}
                  >
                    {t('清空', 'Clear')}
                  </button>
                )}
              </div>
              <div className="port-filter-list">
                {dockPortsWorld.map((wp) => {
                  const curItem = wp.itemId ?? '';
                  const curMode = wp.mode ?? 'unload';
                  return (
                    <div key={wp.portIndex} className="dock-port-row">
                      <span
                        className="dock-port-tag"
                        title={`#${wp.portIndex} (${wp.portX},${wp.portY}) -> (${wp.adjX},${wp.adjY})`}
                      >
                        #{wp.portIndex} ({wp.adjX},{wp.adjY})
                      </span>
                      <button
                        type="button"
                        className={`cad-btn dock-mode-btn ${curItem ? (curMode === 'load' ? 'accent' : '') : ''}`}
                        disabled={!curItem}
                        onClick={() =>
                          curItem && updateDockSlot(wp.portIndex, curItem, curMode === 'load' ? 'unload' : 'load')
                        }
                      >
                        {curMode === 'load' ? t('装货', 'Load') : t('卸货', 'Unload')}
                      </button>
                      <select
                        className="cad-input port-filter-select"
                        value={curItem}
                        onChange={(e) => updateDockSlot(wp.portIndex, e.target.value, curMode)}
                      >
                        <option value="">{t('未配', 'None')}</option>
                        {CATALOG_ITEMS.map((it) => (
                          <option key={it.id} value={it.id}>
                            {isEn ? it.nameEn : it.nameZh}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {isMiningBay && (
            <div className="inspector-section">
              <div className="section-label">{t('开采目标', 'Mining Target')}</div>
              <select
                className="cad-input"
                value={singleModule.miningItem ?? ''}
                onChange={(e) => onUpdateModuleConfig(singleModule.id, { miningItem: e.target.value || null })}
              >
                <option value="">{t('未指定', 'None')}</option>
                {CATALOG_ITEMS.map((it) => (
                  <option key={it.id} value={it.id}>
                    {isEn ? it.nameEn : it.nameZh}
                  </option>
                ))}
              </select>
            </div>
          )}

          {obsRecipes.length > 0 && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">{t('观测配方', 'Observatory Recipe')}</span>
                {singleModule.recipeId && (
                  <button
                    type="button"
                    className="lib-mini-btn"
                    onClick={() => onUpdateModuleConfig(singleModule.id, { recipeId: null })}
                  >
                    {t('清除', 'Clear')}
                  </button>
                )}
              </div>
              <div className="recipe-list">
                {obsRecipes.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`recipe-item ${singleModule.recipeId === r.id ? 'selected' : ''}`}
                    onClick={() => onUpdateModuleConfig(singleModule.id, { recipeId: r.id })}
                  >
                    <span className="recipe-name">{getRecipeName(r, lang)}</span>
                    <span className="recipe-en">{r.shortCode}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="inspector-section">
            <div className="section-label">{t('标注', 'Label')}</div>
            <input
              id="module-label"
              name="moduleLabel"
              type="text"
              className="cad-input"
              placeholder={t('输入标注', 'Optional note')}
              value={singleModule.label ?? ''}
              onChange={(e) => onUpdateModuleConfig(singleModule.id, { label: e.target.value })}
            />
          </div>
        </div>
        <div className="inspector-footer">
          <button type="button" className="cad-btn" onClick={onRotateSelection} title="R">{t('旋转', 'Rotate')}</button>
          <button type="button" className="cad-btn" onClick={(e) => onMirrorSelection(e.shiftKey)} title="F / Shift+F">{t('镜像', 'Mirror')}</button>
          <button type="button" className="cad-btn" onClick={onCutSelection} title="Ctrl+X">{t('搬移', 'Move')}</button>
          <button type="button" className="cad-btn" onClick={onCopySelection} title="Ctrl+C">{t('复制', 'Copy')}</button>
          <button type="button" className="cad-btn" onClick={onSaveSelectionAsBlueprint} title="Ctrl+S">{t('存蓝图', 'Save')}</button>
          <button type="button" className="cad-btn danger" onClick={onDeleteSelection} title="Del">{t('删除', 'Delete')}</button>
        </div>
      </aside>
    );
  }

  const floors = new Set<number>([
    ...selectedModules.map((m) => m.floor),
    ...selectedBuildings.map((b) => b.floor),
  ]);
  const floorLabel = Array.from(floors).sort((a, b) => a - b).map(formatFloorTag).join(', ');

  return (
    <aside className="cad-sidebar right">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">MULTI</span>
          <span className="panel-title">{t(`已选 ${totalSelected} 项`, `${totalSelected} Selected`)}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClearSelection}>×</button>
      </div>
      <div className="inspector-body">
        <div className="inspector-kv">
          <span>{t('模块', 'Modules')}</span>
          <code>{selectedModules.length}</code>
          <span>{t('建筑', 'Buildings')}</span>
          <code>{selectedBuildings.length}</code>
          <span>{t('楼层', 'Floors')}</span>
          <code>{floorLabel || '-'}</code>
        </div>
        <div className="inspector-footer vertical">
          <button type="button" className="cad-btn" onClick={onCutSelection}>
            {t('剪切搬移 (Ctrl+X)', 'Cut & Move (Ctrl+X)')}
          </button>
          <button type="button" className="cad-btn" onClick={onCopySelection}>
            {t('复制 (Ctrl+C)', 'Copy (Ctrl+C)')}
          </button>
          <button type="button" className="cad-btn" onClick={onSaveSelectionAsBlueprint}>
            {t('存为蓝图 (Ctrl+S)', 'Save Selection (Ctrl+S)')}
          </button>
          <button type="button" className="cad-btn" onClick={onRotateSelection}>
            {t('旋转 (R)', 'Rotate (R)')}
          </button>
          <button type="button" className="cad-btn" onClick={(e) => onMirrorSelection(e.shiftKey)} title="F / Shift+F">
            {t('镜像 (F)', 'Mirror (F)')}
          </button>
          <button type="button" className="cad-btn danger" onClick={onDeleteSelection}>
            {t('删除 (Del)', 'Delete (Del)')}
          </button>
        </div>
      </div>
    </aside>
  );
};
