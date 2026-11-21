import React, { useMemo, useState } from 'react';
import { getBuildableDef, getModuleDef, getRecipeDef, getRecipesForCrafter } from '../core/catalog';
import { findBuildingsInsideModule, getBuildingSizeCells, rotateSide, rotateVec2 } from '../core/geometry';
import type { BlueprintDocument, PlacedBuilding, PlacedModule, SelectionState } from '../core/types';

interface InspectorPanelProps {
  doc: BlueprintDocument;
  selection: SelectionState;
  onUpdateBuilding: (
    ids: string[],
    patch: { recipeId?: string | null; label?: string | null; disabledPorts?: number[]; undergroundMode?: 'in' | 'out' }
  ) => void;
  onUpdateModuleLabel: (id: string, label: string) => void;
  onCopySelection: () => void;
  onSaveSelectionAsBlueprint: () => void;
  onRotateSelection: () => void;
  onDeleteSelection: () => void;
  onClearSelection: () => void;
}

const PortDiagram: React.FC<{
  building: PlacedBuilding;
  onTogglePort: (portIndex: number) => void;
}> = ({ building, onTogglePort }) => {
  const def = getBuildableDef(building.type);
  if (!def || !def.configurablePorts) return null;

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
          fill="#0d131c"
          stroke="#35465c"
          strokeWidth={0.09}
        />
        <text x={0} y={0.22} textAnchor="middle" fill="#52657d" fontSize={0.58} fontFamily="monospace">
          {w}×{d}
        </text>

        {def.ports.map((port) => {
          const [rx, ry] = rotateVec2(port.hx * 0.5, port.hy * 0.5, building.rotation);
          const side = rotateSide(port.side, building.rotation);
          const enabled = !disabledSet.has(port.index);
          const r = Math.min(0.4, Math.max(0.26, viewW * 0.04));
          return (
            <g
              key={port.index}
              className="port-node"
              onClick={() => onTogglePort(port.index)}
              style={{ cursor: 'pointer' }}
            >
              <title>{`接口 #${port.index + 1} (${side}) · ${enabled ? '活跃（点击禁用）' : '已禁用（点击启用）'}`}</title>
              <circle
                cx={rx}
                cy={ry}
                r={r}
                fill="#0b1017"
                stroke={enabled ? '#4ea377' : '#803a3e'}
                strokeWidth={0.11}
              />
              {enabled ? (
                <circle cx={rx} cy={ry} r={r * 0.24} fill="#4ea377" />
              ) : (
                <g stroke="#8c4247" strokeWidth={0.09}>
                  <line x1={rx - r * 0.45} y1={ry - r * 0.45} x2={rx + r * 0.45} y2={ry + r * 0.45} />
                  <line x1={rx + r * 0.45} y1={ry - r * 0.45} x2={rx - r * 0.45} y2={ry + r * 0.45} />
                </g>
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
  onSaveSelectionAsBlueprint,
  onRotateSelection,
  onDeleteSelection,
  onClearSelection,
}) => {
  const [recipeQuery, setRecipeQuery] = useState('');

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
    const activePortCount = def ? def.ports.length - disabledSet.size : 0;

    const handleTogglePort = (idx: number) => {
      const next = new Set(disabledSet);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      onUpdateBuilding([singleBuilding.id], { disabledPorts: Array.from(next) });
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

          {/* Active / Disabled Ports Configuration */}
          {def?.configurablePorts && (
            <div className="inspector-section">
              <div className="section-head">
                <span className="section-label">
                  接口状态（活跃 {activePortCount}/{def.ports.length}）
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
                        disabledPorts: def.ports.map((p) => p.index),
                      })
                    }
                  >
                    全关
                  </button>
                </div>
              </div>
              <PortDiagram building={singleBuilding} onTogglePort={handleTogglePort} />
              <div className="port-legend">
                <span><i className="dot green" /> 活跃接口</span>
                <span><i className="dot red" /> 已禁用接口（点击节点切换）</span>
              </div>
            </div>
          )}

          {/* Custom planning note */}
          <div className="inspector-section">
            <div className="section-label">自定义规划标注</div>
            <input
              type="text"
              className="cad-input"
              placeholder="输入简短标注（显示在 3D 顶面）"
              value={singleBuilding.label ?? ''}
              onChange={(e) => onUpdateBuilding([singleBuilding.id], { label: e.target.value })}
            />
          </div>

          <div className="inspector-footer">
            <button type="button" className="cad-btn" onClick={onRotateSelection}>旋转 (R)</button>
            <button type="button" className="cad-btn" onClick={onCopySelection}>复制 (Ctrl+C)</button>
            <button type="button" className="cad-btn danger" onClick={onDeleteSelection}>删除 (Del)</button>
          </div>
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
              type="text"
              className="cad-input"
              placeholder="例如：电路板装配区"
              value={singleModule.label ?? ''}
              onChange={(e) => onUpdateModuleLabel(singleModule.id, e.target.value)}
            />
          </div>
          <div className="inspector-footer">
            <button type="button" className="cad-btn" onClick={onRotateSelection}>旋转 (R)</button>
            <button type="button" className="cad-btn" onClick={onCopySelection}>复制蓝图</button>
            <button type="button" className="cad-btn accent" onClick={onSaveSelectionAsBlueprint}>存为蓝图</button>
            <button type="button" className="cad-btn danger" onClick={onDeleteSelection}>删除</button>
          </div>
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
          <button type="button" className="cad-btn accent" onClick={onCopySelection}>
            复制为幽灵蓝图 (Ctrl+C)
          </button>
          <button type="button" className="cad-btn" onClick={onSaveSelectionAsBlueprint}>
            保存选区到文件夹 (Ctrl+S)
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
