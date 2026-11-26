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
import { KeyHintList, type KeyHintItem } from './KeyHintBar';
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
  hints?: KeyHintItem[];
}

export const PaletteDock: React.FC<PaletteDockProps> = React.memo(({
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
      const hints: KeyHintItem[] = [
        ...(showTabHint ? [{ keys: 'Tab', label: t('换型', 'Variant') }] : []),
        { keys: 'R', label: t('旋转', 'Rotate') },
        { keys: 'F', label: t('镜像', 'Mirror') },
      ];
      return {
        title: m ? getModuleName(m, lang) : id,
        sub: !isEn ? m?.nameEn : undefined,
        spec: m
          ? isEn
            ? `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}F · ${m.connectors.length}P`
            : `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}层 · ${m.connectors.length}口`
          : '',
        hints,
      };
    }
    const b = getBuildableDef(id);
    const hints: KeyHintItem[] =
      b?.kind === 'belt'
        ? [
            { keys: t('左键', 'LMB'), label: t('拉带', 'Route') },
            { keys: t('Shift+左', 'Shift+LMB'), label: t('手绘', 'Free') },
            { keys: 'T', label: t('地下', 'Tunnel') },
          ]
        : b?.kind === 'underground'
          ? [
              { keys: 'R', label: t('旋转', 'Rotate') },
              { keys: 'T', label: t('地面', 'Belt') },
            ]
          : [
              ...(showTabHint ? [{ keys: 'Tab', label: t('换型', 'Variant') }] : []),
              { keys: 'R', label: t('旋转', 'Rotate') },
              { keys: 'F', label: t('镜像', 'Mirror') },
            ];
    return {
      title: b ? getBuildableName(b, lang) : id,
      sub: !isEn ? b?.nameEn : undefined,
      spec: b
        ? isEn
          ? `${b.size[0]}×${b.size[1]} · ${b.ports.length}P`
          : `${b.size[0]}×${b.size[1]}格 · ${b.ports.length}口`
        : '',
      hints,
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
          {hoverMeta.hints && hoverMeta.hints.length > 0 && (
            <div className="s2-hover-hint">
              <KeyHintList items={hoverMeta.hints} compact />
            </div>
          )}
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
          <kbd className="cad-op-kbd s2-subtray-kbd">Tab</kbd>
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
              hints: [
                { keys: t('拖', 'Drag'), label: t('框选', 'Box') },
                { keys: 'Shift', label: t('加选', 'Add') },
                { keys: 'Alt', label: t('减选', 'Sub') },
              ],
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
              hints: [
                { keys: t('左键', 'LMB'), label: t('点/扫', 'Sweep') },
                { keys: t('Shift+拖', 'Shift+Drag'), label: t('框拆', 'Box') },
              ],
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
});
