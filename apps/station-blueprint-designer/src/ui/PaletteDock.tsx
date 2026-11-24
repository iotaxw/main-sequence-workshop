import React, { useEffect, useState } from 'react';
import { getBuildableDef, getModuleDef } from '../core/catalog';
import { findGroupForEntity, getGroupsForView, getShortLabel, PaletteGroupDef } from '../core/groups';
import type { ActiveTool, ViewMode } from '../core/types';
import { EntityGlyph } from './Schematics';

interface PaletteDockProps {
  viewMode: ViewMode;
  activeTool: ActiveTool;
  lastGroupMember: Record<string, string>;
  onSelectEntity: (entityId: string) => void;
  onSelectTool: (tool: ActiveTool) => void;
}

interface HoverMeta {
  title: string;
  en: string;
  spec: string;
  hint?: string;
}

export const PaletteDock: React.FC<PaletteDockProps> = ({
  viewMode,
  activeTool,
  lastGroupMember,
  onSelectEntity,
  onSelectTool,
}) => {
  const [hoverMeta, setHoverMeta] = useState<HoverMeta | null>(null);
  const groups = getGroupsForView(viewMode);

  const activeEntityId =
    viewMode === 'station' && activeTool.kind === 'place-module'
      ? activeTool.moduleType
      : viewMode === 'building' && activeTool.kind === 'place-building'
        ? activeTool.buildingType
        : null;

  const activeGroup: PaletteGroupDef | undefined = activeEntityId
    ? findGroupForEntity(viewMode, activeEntityId)
    : undefined;

  useEffect(() => {
    setHoverMeta(null);
  }, [viewMode, activeGroup?.id]);

  const buildMeta = (id: string, showTabHint: boolean): HoverMeta => {
    if (viewMode === 'station') {
      const m = getModuleDef(id);
      return {
        title: m?.nameZh ?? id,
        en: m?.nameEn ?? id,
        spec: m ? `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}层 · ${m.connectors.length}口` : '',
        hint: showTabHint ? 'Tab 组内轮换 · R 旋转' : undefined,
      };
    }
    const b = getBuildableDef(id);
    const baseHint = showTabHint ? 'Tab 组内轮换 · R 旋转' : 'R 旋转';
    const extraHint =
      b?.kind === 'belt'
        ? ' · 拖带按 T/U 切地下带'
        : b?.kind === 'underground'
          ? ' · T/U 切回地面带'
          : '';
    return {
      title: b?.nameZh ?? id,
      en: b?.nameEn ?? id,
      spec: b ? `${b.size[0]}×${b.size[1]}格 · ${b.ports.length}口` : '',
      hint: `${baseHint}${extraHint}`,
    };
  };

  return (
    <div className="s2-dock-anchor" onMouseLeave={() => setHoverMeta(null)}>
      {/* Subtle Hover Detail Card (only visible on hover!) */}
      {hoverMeta && (
        <div className="s2-hover-card">
          <div className="s2-hover-row">
            <span className="s2-hover-title">{hoverMeta.title}</span>
            <span className="s2-hover-spec">{hoverMeta.spec}</span>
          </div>
          <div className="s2-hover-en">{hoverMeta.en}</div>
          {hoverMeta.hint && <div className="s2-hover-hint">{hoverMeta.hint}</div>}
        </div>
      )}

      {/* Shapez-2-style Sub-Tray floating directly above the dock when a group is active */}
      {activeGroup && activeGroup.members.length > 1 && (
        <div className="s2-subtray" role="toolbar" aria-label={`${activeGroup.name} 变体选择`}>
          <span className="s2-subtray-label">{activeGroup.name}</span>
          <div className="s2-subtray-items">
            {activeGroup.members.map((memberId) => {
              const isCur = activeEntityId === memberId;
              return (
                <button
                  key={memberId}
                  type="button"
                  className={`s2-tile sub ${isCur ? 'active' : ''}`}
                  onClick={() => onSelectEntity(memberId)}
                  onMouseEnter={() => setHoverMeta(buildMeta(memberId, true))}
                >
                  <EntityGlyph id={memberId} size={20} />
                  <span className="s2-tile-label">{getShortLabel(memberId)}</span>
                </button>
              );
            })}
          </div>
          <span className="s2-subtray-kbd">Tab</span>
        </div>
      )}

      {/* Main Compact Shapez-2 Grouped Grid Bar */}
      <div className="s2-dock-bar">
        <button
          type="button"
          className={`s2-tile util ${activeTool.kind === 'select' ? 'active' : ''}`}
          onClick={() => onSelectTool({ kind: 'select' })}
          onMouseEnter={() =>
            setHoverMeta({ title: '选择与框选', en: 'Select', spec: 'Esc / 右键', hint: '左键点选/框选 · Shift加选 · Alt减选' })
          }
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
            <polygon points="5,4 18,12 12,13.5 10.5,19.5" />
          </svg>
          <span className="s2-tile-label">选择</span>
        </button>

        <button
          type="button"
          className={`s2-tile util ${activeTool.kind === 'demolish' ? 'active-warn' : ''}`}
          onClick={() => onSelectTool({ kind: 'demolish' })}
          onMouseEnter={() =>
            setHoverMeta({ title: '拆除刷', en: 'Demolish', spec: 'X', hint: '点拆/扫拆 · Shift+拖 红框拆 · Ctrl+Z 撤销' })
          }
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
          <span className="s2-tile-label">拆除</span>
        </button>

        <div className="s2-divider" />

        {groups.map((group) => {
          const isGroupActive = activeGroup?.id === group.id;
          const displayId =
            isGroupActive && activeEntityId
              ? activeEntityId
              : lastGroupMember[group.id] ?? group.members[0];
          return (
            <button
              key={group.id}
              type="button"
              className={`s2-tile ${isGroupActive ? 'active' : ''}`}
              onClick={() => onSelectEntity(displayId)}
              onMouseEnter={() => setHoverMeta(buildMeta(displayId, group.members.length > 1))}
            >
              <span className="s2-slot-num">{group.slot}</span>
              <EntityGlyph id={displayId} size={22} />
              <span className="s2-tile-label">{getShortLabel(displayId)}</span>
              {group.members.length > 1 && <span className="s2-group-dots" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};
