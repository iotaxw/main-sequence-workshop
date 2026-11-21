import React, { useMemo, useState } from 'react';
import {
  BUILDABLE_CATEGORIES,
  CATALOG,
  HOTBAR_BUILDINGS,
  HOTBAR_MODULES,
  STATION_CATEGORIES,
} from '../core/catalog';
import type { ActiveTool, ViewMode } from '../core/types';

interface PaletteDockProps {
  viewMode: ViewMode;
  activeTool: ActiveTool;
  onSelectTool: (tool: ActiveTool) => void;
}

export const PaletteDock: React.FC<PaletteDockProps> = ({ viewMode, activeTool, onSelectTool }) => {
  const [category, setCategory] = useState<string>('ALL');
  const [query, setQuery] = useState('');

  const categories = viewMode === 'station' ? STATION_CATEGORIES : BUILDABLE_CATEGORIES;
  const hotbar = viewMode === 'station' ? HOTBAR_MODULES : HOTBAR_BUILDINGS;

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (viewMode === 'station') {
      return CATALOG.stationModules.filter((m) => {
        if (category !== 'ALL' && m.categoryEn !== category) return false;
        if (q && !m.nameZh.toLowerCase().includes(q) && !m.nameEn.toLowerCase().includes(q)) return false;
        return true;
      });
    }
    return CATALOG.buildables.filter((b) => {
      if (category !== 'ALL' && b.categoryEn !== category) return false;
      if (q && !b.nameZh.toLowerCase().includes(q) && !b.nameEn.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [viewMode, category, query]);

  // Reset category filter if switching viewMode makes current category irrelevant
  const validCat = category === 'ALL' || categories.some((c) => c.en === category) ? category : 'ALL';

  return (
    <div className="cad-palette-dock">
      <div className="palette-top-row">
        <div className="palette-mode-tools">
          <button
            type="button"
            className={`cad-btn ${activeTool.kind === 'select' ? 'accent' : ''}`}
            onClick={() => onSelectTool({ kind: 'select' })}
            title="选择 / 框选 (Esc / 右键)"
          >
            选择
          </button>
          <button
            type="button"
            className={`cad-btn ${activeTool.kind === 'demolish' ? 'danger-active' : ''}`}
            onClick={() => onSelectTool({ kind: 'demolish' })}
            title="快捷拆除刷 (X)：按住左键扫过即拆"
          >
            拆除刷 (X)
          </button>
        </div>

        <div className="palette-cats">
          <button
            type="button"
            className={`cat-tab ${validCat === 'ALL' ? 'active' : ''}`}
            onClick={() => setCategory('ALL')}
          >
            全部 ({viewMode === 'station' ? CATALOG.stationModules.length : CATALOG.buildables.length})
          </button>
          {categories.map((c) => (
            <button
              key={c.en}
              type="button"
              className={`cat-tab ${validCat === c.en ? 'active' : ''}`}
              onClick={() => setCategory(c.en)}
            >
              {c.zh}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="cad-input palette-search"
          placeholder={viewMode === 'station' ? '筛选模块...' : '筛选建筑/物流...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="palette-items">
        {viewMode === 'station'
          ? items.map((m) => {
              const mod = m as (typeof CATALOG.stationModules)[number];
              const isSelected = activeTool.kind === 'place-module' && activeTool.moduleType === mod.id;
              const hotIdx = hotbar.indexOf(mod.id);
              return (
                <button
                  key={mod.id}
                  type="button"
                  className={`palette-card ${isSelected ? 'active' : ''} ${mod.hasFactoryFloor ? '' : 'non-floor'}`}
                  onClick={() =>
                    onSelectTool({
                      kind: 'place-module',
                      moduleType: mod.id,
                      rotation: activeTool.kind === 'place-module' ? activeTool.rotation : 0,
                    })
                  }
                  title={`${mod.nameZh} (${mod.nameEn}) · ${mod.sizeUnits[0]}×${mod.sizeUnits[1]}×${mod.sizeUnits[2]}层 · ${mod.connectors.length}接口`}
                >
                  {hotIdx >= 0 && <span className="hot-badge">{hotIdx + 1}</span>}
                  <div className="card-glyph">
                    <span className="size-tag">
                      {mod.sizeUnits[0]}×{mod.sizeUnits[1]}
                      {mod.sizeUnits[2] > 1 ? `·${mod.sizeUnits[2]}F` : ''}
                    </span>
                  </div>
                  <div className="card-name">{mod.nameZh}</div>
                </button>
              );
            })
          : items.map((b) => {
              const bld = b as (typeof CATALOG.buildables)[number];
              const isSelected = activeTool.kind === 'place-building' && activeTool.buildingType === bld.id;
              const hotIdx = hotbar.indexOf(bld.id);
              return (
                <button
                  key={bld.id}
                  type="button"
                  className={`palette-card kind-${bld.kind} ${isSelected ? 'active' : ''}`}
                  onClick={() =>
                    onSelectTool({
                      kind: 'place-building',
                      buildingType: bld.id,
                      rotation: activeTool.kind === 'place-building' ? activeTool.rotation : 0,
                      undergroundMode: bld.kind === 'underground' ? 'in' : undefined,
                    })
                  }
                  title={`${bld.nameZh} (${bld.nameEn}) · ${bld.size[0]}×${bld.size[1]} 格 · ${bld.ports.length} 接口`}
                >
                  {hotIdx >= 0 && <span className="hot-badge">{hotIdx + 1}</span>}
                  <div className="card-glyph">
                    <span className="size-tag">{bld.size[0]}×{bld.size[1]}</span>
                  </div>
                  <div className="card-name">{bld.nameZh}</div>
                </button>
              );
            })}
      </div>
    </div>
  );
};
