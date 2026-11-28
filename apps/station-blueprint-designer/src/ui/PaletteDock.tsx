import React, { useEffect, useState } from 'react';
import { getBuildableDef, getBuildableName, getModuleDef, getModuleName } from '../core/catalog';
import {
  findGroupForEntity,
  getCanonicalGroupMember,
  getGroupName,
  getGroupsForView,
  getShortLabel,
  type PaletteGroupDef,
} from '../core/groups';
import { useI18n } from '../core/i18n';
import type { ActiveTool, BlueprintCategory, Rotation, ViewMode } from '../core/types';
import { KeyHintList, type KeyHintItem } from './KeyHintBar';
import { EntityGlyph } from './Schematics';

interface PaletteDockProps {
  viewMode: ViewMode;
  docCategory?: BlueprintCategory;
  shipFreeRotate?: boolean;
  mobile?: boolean;
  activeTool: ActiveTool;
  lastGroupMember: Record<string, string>;
  lastMirrorVariant?: Record<string, string>;
  lastEntityRotation?: Record<string, Rotation>;
  onSelectEntity: (entityId: string) => void;
  onSelectTool: (tool: ActiveTool) => void;
}

interface HoverMeta {
  title: string;
  sub?: string;
  spec: string;
  hints?: KeyHintItem[];
}

export const PaletteDock: React.FC<PaletteDockProps> = ({
  viewMode,
  docCategory = 'station',
  shipFreeRotate = false,
  mobile = false,
  activeTool,
  lastGroupMember,
  lastMirrorVariant = {},
  lastEntityRotation = {},
  onSelectEntity,
  onSelectTool,
}) => {
  const { lang, isEn, t } = useI18n();
  const [hoverMeta, setHoverMeta] = useState<HoverMeta | null>(null);
  const isShip = docCategory === 'ship';
  const groups = getGroupsForView(viewMode, docCategory);

  const activeEntityId =
    (viewMode === 'station' || isShip) && activeTool.kind === 'place-module'
      ? activeTool.moduleType
      : viewMode === 'building' && activeTool.kind === 'place-building'
        ? activeTool.buildingType
        : null;

  const getDisplayRotation = (entityId: string): Rotation => {
    const canonical = getCanonicalGroupMember(entityId, docCategory);
    if (activeEntityId) {
      const activeCanonical = getCanonicalGroupMember(activeEntityId, docCategory);
      if (activeCanonical === canonical) {
        if (activeTool.kind === 'place-module') return activeTool.rotation;
        if (activeTool.kind === 'place-building') return activeTool.rotation;
      }
    }
    const saved = lastEntityRotation[canonical] ?? 0;
    if (isShip && !shipFreeRotate) {
      const mDef = getModuleDef(entityId);
      if (mDef?.canRotate === false) return 0;
    }
    return saved;
  };

  const activeGroup: PaletteGroupDef | undefined = activeEntityId
    ? findGroupForEntity(viewMode, activeEntityId, docCategory)
    : undefined;

  useEffect(() => {
    setHoverMeta(null);
  }, [viewMode, docCategory, activeGroup?.id, lang]);

  const buildMeta = (id: string, showTabHint: boolean): HoverMeta => {
    if (viewMode === 'station' || isShip) {
      const m = getModuleDef(id);
      const canRot = !isShip || shipFreeRotate || m?.canRotate !== false;
      const hasMirror = Boolean(m?.mirrorId);
      const hints: KeyHintItem[] = [
        ...(showTabHint ? [{ keys: 'Tab', label: t('换型', 'Variant') }] : []),
        ...(canRot
          ? [{ keys: 'R', label: t('旋转', 'Rotate') }]
          : [{ keys: 'R', label: t('原版锁向', 'Locked') }]),
        ...(isShip
          ? hasMirror
            ? [{ keys: 'F', label: t('镜像', 'Mirror') }]
            : []
          : [{ keys: 'F', label: t('镜像', 'Mirror') }]),
      ];

      let spec = '';
      if (m) {
        if (isShip) {
          const parts: string[] = [];
          if (m.weightT !== undefined) parts.push(`${m.weightT}t`);
          if (m.thrustKN) parts.push(`${m.thrustKN}kN`);
          if (m.powerGenKW) parts.push(`+${m.powerGenKW / 1000}MW`);
          else if (m.powerKW) parts.push(`-${m.powerKW / 1000}MW`);
          parts.push(`${m.sizeUnits[0]}×${m.sizeUnits[1]}`);
          spec = parts.join(' · ');
        } else {
          spec = isEn
            ? `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}F · ${m.connectors.length}P`
            : `${m.sizeUnits[0]}×${m.sizeUnits[1]} · ${m.sizeUnits[2]}层 · ${m.connectors.length}口`;
        }
      }
      return {
        title: m ? getModuleName(m, lang) : id,
        sub: !isEn ? m?.nameEn : undefined,
        spec,
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
    <div className={`s2-dock-anchor ${mobile ? 'mobile-dock' : ''}`} onMouseLeave={() => setHoverMeta(null)}>
      {!mobile && hoverMeta && (
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
          {!mobile && <span className="s2-subtray-label">{getGroupName(activeGroup, lang)}</span>}
          <div className="s2-subtray-items">
            {activeGroup.members.map((memberId) => {
              const activeDef = activeEntityId ? getModuleDef(activeEntityId) : undefined;
              const isCur =
                activeEntityId === memberId ||
                Boolean(activeDef?.mirrorId && activeDef.mirrorId === memberId) ||
                (memberId === 'BPO_StationArmour_01' && activeEntityId === 'BPO_StationArmour_01B');
              const resolvedId = isCur && activeEntityId ? activeEntityId : lastMirrorVariant[memberId] ?? memberId;
              const rot = getDisplayRotation(resolvedId);
              return (
                <button
                  key={memberId}
                  type="button"
                  className={`s2-tile sub ${isCur ? 'active' : ''}`}
                  onClick={() => onSelectEntity(resolvedId)}
                  onMouseEnter={mobile ? undefined : () => setHoverMeta(buildMeta(resolvedId, true))}
                >
                  <EntityGlyph id={resolvedId} size={20} rotation={rot} />
                  <span className="s2-tile-label">{getShortLabel(resolvedId, undefined, lang)}</span>
                </button>
              );
            })}
          </div>
          {!mobile && <kbd className="cad-op-kbd s2-subtray-kbd">Tab</kbd>}
        </div>
      )}

      <div className="s2-dock-bar">
        <button
          type="button"
          className={`s2-tile util ${activeTool.kind === 'select' ? 'active' : ''}`}
          onClick={() => onSelectTool({ kind: 'select' })}
          onMouseEnter={
            mobile
              ? undefined
              : () =>
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
          onMouseEnter={
            mobile
              ? undefined
              : () =>
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
          const baseId =
            isGroupActive && activeEntityId
              ? activeEntityId
              : lastGroupMember[group.id] ?? group.members[0];
          const canonical = getCanonicalGroupMember(baseId, docCategory);
          const displayId =
            isGroupActive && activeEntityId
              ? activeEntityId
              : lastMirrorVariant[canonical] ?? baseId;
          const rot = getDisplayRotation(displayId);
          return (
            <button
              key={group.id}
              type="button"
              className={`s2-tile ${isGroupActive ? 'active' : ''}`}
              onClick={() => onSelectEntity(displayId)}
              onMouseEnter={mobile ? undefined : () => setHoverMeta(buildMeta(displayId, group.members.length > 1))}
            >
              {!mobile && <span className="s2-slot-num">{group.slot}</span>}
              <EntityGlyph id={displayId} size={22} rotation={rot} />
              <span className="s2-tile-label">{getShortLabel(displayId, undefined, lang)}</span>
              {group.members.length > 1 && <span className="s2-group-dots" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};
