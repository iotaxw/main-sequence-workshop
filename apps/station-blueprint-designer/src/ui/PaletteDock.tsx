import React, { useEffect, useState } from 'react';
import { getBuildableDef, getBuildableName, getModuleDef, getModuleName } from '../core/catalog';
import {
  findGroupForEntity,
  getGroupName,
  getGroupsForView,
  getShortLabel,
  type PaletteGroupDef,
} from '../core/groups';
import { useI18n } from '../core/i18n';
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
  sub?: string;
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
  const { lang, isEn, t } = useI18n();
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
  }, [viewMode, activeGroup?.id, lang]);

  const buildMeta = (id: string, showTabHint: boolean): HoverMeta => {
    if (viewMode === 'station') {
      const m = getModuleDef(id);
      return {
        title: m ? getModuleName(m, lang) : id,
        sub: !isEn ? m?.nameEn : undefined,
        spec: m
          ? isEn
            ? `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}F · ${m.connectors.length}P`
            : `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}层 · ${m.connectors.length}口`
          : '',
        hint: showTabHint ? t('Tab 换型 · R 旋转', 'Tab Variant · R Rotate') : t('R 旋转', 'R Rotate'),
      };
    }
    const b = getBuildableDef(id);
    const baseHint = showTabHint ? t('Tab 换型 · R 旋转', 'Tab Variant · R Rotate') : t('R 旋转', 'R Rotate');
    const extraHint =
      b?.kind === 'belt'
        ? t(' · T/U 地下带', ' · T/U Underground')
        : b?.kind === 'underground'
          ? t(' · T/U 地面带', ' · T/U Belt')
          : '';
    return {
      title: b ? getBuildableName(b, lang) : id,
      sub: !isEn ? b?.nameEn : undefined,
      spec: b
        ? isEn
          ? `${b.size[0]}×${b.size[1]} · ${b.ports.length}P`
          : `${b.size[0]}×${b.size[1]}格 · ${b.ports.length}口`
        : '',
      hint: `${baseHint}${extraHint}`,
    };
  };

  return (
    <div className="s2-dock-anchor" onMouseLeave={() => setHoverMeta(null)}>
      {hoverMeta && (
        <div className="s2-hover-card">
          <div className="s2-hover-row">
            <span className="s2-hover-title">{hoverMeta.title}</span>
            <span className="s2-hover-spec">{hoverMeta.spec}</span>
          </div>
          {hoverMeta.sub && <div className="s2-hover-en">{hoverMeta.sub}</div>}
          {hoverMeta.hint && <div className="s2-hover-hint">{hoverMeta.hint}</div>}
        </div>
      )}

      {activeGroup && activeGroup.members.length > 1 && (
        <div className="s2-subtray" role="toolbar" aria-label={getGroupName(activeGroup, lang)}>
          <span className="s2-subtray-label">{getGroupName(activeGroup, lang)}</span>
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
                  <span className="s2-tile-label">{getShortLabel(memberId, undefined, lang)}</span>
                </button>
              );
            })}
          </div>
          <span className="s2-subtray-kbd">Tab</span>
        </div>
      )}

      <div className="s2-dock-bar">
        <button
          type="button"
          className={`s2-tile util ${activeTool.kind === 'select' ? 'active' : ''}`}
          onClick={() => onSelectTool({ kind: 'select' })}
          onMouseEnter={() =>
            setHoverMeta({
              title: t('选择', 'Select'),
              spec: isEn ? 'Esc / RMB' : 'Esc / 右键',
              hint: t('点选 / 框选 · Shift 加 · Alt 减', 'Click / Box · Shift Add · Alt Sub'),
            })
          }
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
            <polygon points="5,4 18,12 12,13.5 10.5,19.5" />
          </svg>
          <span className="s2-tile-label">{t('选择', 'Select')}</span>
        </button>

        <button
          type="button"
          className={`s2-tile util ${activeTool.kind === 'demolish' ? 'active-warn' : ''}`}
          onClick={() => onSelectTool({ kind: 'demolish' })}
          onMouseEnter={() =>
            setHoverMeta({
              title: t('拆除', 'Demolish'),
              spec: 'X',
              hint: t('点 / 扫拆 · Shift+拖 框拆', 'Click / Sweep · Shift+Drag Box'),
            })
          }
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
          <span className="s2-tile-label">{t('拆除', 'Erase')}</span>
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
              <span className="s2-tile-label">{getShortLabel(displayId, undefined, lang)}</span>
              {group.members.length > 1 && <span className="s2-group-dots" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};
