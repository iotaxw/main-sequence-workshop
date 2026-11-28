import React from 'react';
import {
  canModuleRotate,
  getBuildableDef,
  getBuildableName,
  getItemName,
  getModuleDef,
  getModuleName,
  getRecipeDef,
  getRecipeName,
} from '../core/catalog';
import { formatFloorTag, useI18n } from '../core/i18n';
import type { ActiveTool, BlueprintDocument, SelectionState } from '../core/types';
import type { WorkbenchCheckReport } from '../core/workbench-check';
import { EntityGlyph } from './Schematics';

interface MobileInspectBarProps {
  doc: BlueprintDocument;
  selection: SelectionState;
  activeTool: ActiveTool;
  shipFreeRotate: boolean;
  simReport: WorkbenchCheckReport | null;
  onRotate: () => void;
  onMirror: () => void;
  onDeleteSelection: () => void;
  onClearSelection: () => void;
  onExitTool: () => void;
}

function isMirroredModuleVariant(typeId: string): boolean {
  const def = getModuleDef(typeId);
  if (!def?.mirrorId && typeId !== 'BPO_StationArmour_01B') return false;
  return /(_B|01B|02B|L)$/.test(typeId);
}

function fmtShipSpec(typeId: string): string {
  const def = getModuleDef(typeId);
  if (!def) return '';
  const parts: string[] = [];
  if (def.weightT !== undefined) parts.push(`${def.weightT}t`);
  if (def.thrustKN) parts.push(`${def.thrustKN}kN`);
  if (def.powerGenKW) parts.push(`+${def.powerGenKW / 1000}MW`);
  else if (def.powerKW) parts.push(`-${def.powerKW / 1000}MW`);
  return parts.join(' · ');
}

/**
 * Compact mobile contextual bar sharing exact CAD visual tokens:
 * - Station mode (read-only): shows tapped module/building specs, recipe, and check status.
 * - Ship mode (editable): shows selected block actions (Mirror / Rotate / Delete) or active placement controls.
 */
export const MobileInspectBar: React.FC<MobileInspectBarProps> = ({
  doc,
  selection,
  activeTool,
  shipFreeRotate,
  simReport,
  onRotate,
  onMirror,
  onDeleteSelection,
  onClearSelection,
  onExitTool,
}) => {
  const { lang, isEn, t } = useI18n();
  const isShip = doc.category === 'ship';

  // 1. Ship mode — editable contextual action bar (floats neatly above PaletteDock)
  if (isShip) {
    if (selection.moduleIds.length > 0) {
      const first = doc.modules.find((m) => m.id === selection.moduleIds[0]);
      if (!first) return null;
      const def = getModuleDef(first.type);
      const title = def ? getModuleName(def, lang) : first.type;
      const spec = fmtShipSpec(first.type);
      const canRot = canModuleRotate(first.type, shipFreeRotate);
      const hasMirror = Boolean(def?.mirrorId) || canRot;
      const mirrorActive = isMirroredModuleVariant(first.type);
      return (
        <div className="mobile-ctx-bar ship-docked" role="region" aria-label={t('部件操作', 'Block Actions')}>
          <div className="mobile-ctx-info">
            <EntityGlyph id={first.type} size={20} />
            <div className="mobile-ctx-text">
              <div className="mobile-ctx-title">{title}</div>
              <div className="mobile-ctx-sub">
                {formatFloorTag(first.floor)}
                {spec ? ` · ${spec}` : ''}
              </div>
            </div>
          </div>
          <div className="mobile-ctx-actions">
            {hasMirror && (
              <button type="button" className={`cad-btn ${mirrorActive ? 'accent' : ''}`} onClick={onMirror}>
                {t('镜像', 'Mirror')}
              </button>
            )}
            <button
              type="button"
              className={`cad-btn ${!canRot ? 'muted-lock' : ''}`}
              onClick={onRotate}
            >
              {t('旋转', 'Rot')}
            </button>
            <button type="button" className="cad-btn danger" onClick={onDeleteSelection}>
              {t('删', 'Del')}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onClearSelection}
              aria-label={t('取消选择', 'Clear selection')}
            >
              ×
            </button>
          </div>
        </div>
      );
    }

    if (activeTool.kind === 'place-module') {
      const def = getModuleDef(activeTool.moduleType);
      const title = def ? getModuleName(def, lang) : activeTool.moduleType;
      const spec = fmtShipSpec(activeTool.moduleType);
      const canRot = canModuleRotate(activeTool.moduleType, shipFreeRotate);
      const hasMirror = Boolean(def?.mirrorId) || canRot;
      const mirrorActive = isMirroredModuleVariant(activeTool.moduleType);
      return (
        <div className="mobile-ctx-bar ship-docked" role="region" aria-label={t('放置部件', 'Place Block')}>
          <div className="mobile-ctx-info">
            <EntityGlyph id={activeTool.moduleType} size={20} />
            <div className="mobile-ctx-text">
              <div className="mobile-ctx-title">
                {title}
                <span className="mobile-ctx-deg">{activeTool.rotation * 90}°</span>
              </div>
              <div className="mobile-ctx-sub">
                {spec ? `${spec} · ` : ''}
                {t('轻点空地放置', 'Tap empty grid to place')}
              </div>
            </div>
          </div>
          <div className="mobile-ctx-actions">
            {hasMirror && (
              <button type="button" className={`cad-btn ${mirrorActive ? 'accent' : ''}`} onClick={onMirror}>
                {t('镜像', 'Mirror')}
              </button>
            )}
            <button
              type="button"
              className={`cad-btn ${!canRot ? 'muted-lock' : ''}`}
              onClick={onRotate}
            >
              {t('旋转', 'Rot')}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onExitTool}
              aria-label={t('退出放置', 'Exit placement')}
            >
              ×
            </button>
          </div>
        </div>
      );
    }

    if (activeTool.kind === 'demolish') {
      return (
        <div className="mobile-ctx-bar ship-docked tone-warn" role="region" aria-label={t('拆除模式', 'Erase Mode')}>
          <div className="mobile-ctx-info">
            <div className="mobile-ctx-text">
              <div className="mobile-ctx-title">{t('拆除模式', 'Erase Mode')}</div>
              <div className="mobile-ctx-sub">{t('轻点飞船部件即可拆除', 'Tap a ship block to remove')}</div>
            </div>
          </div>
          <div className="mobile-ctx-actions">
            <button type="button" className="cad-btn" onClick={onExitTool}>
              {t('完成', 'Done')}
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  // 2. Station mode — read-only inspect card on tap
  if (selection.buildingIds.length > 0) {
    const b = doc.buildings.find((x) => x.id === selection.buildingIds[0]);
    if (!b) return null;
    const def = getBuildableDef(b.type);
    const title = def ? getBuildableName(def, lang) : b.type;
    const rec = b.recipeId ? getRecipeDef(b.recipeId) : undefined;
    const recName = rec ? getRecipeName(rec, lang) : undefined;
    const filterNames = (b.filterItems ?? []).map((id) => getItemName(id, lang)).join(', ');
    const fault = simReport?.faults.find((f) => f.buildingId === b.id);
    const subParts: string[] = [formatFloorTag(b.floor)];
    if (def) subParts.push(`${def.size[0]}×${def.size[1]}`);
    if (recName) subParts.push(recName);
    else if (filterNames) subParts.push(`${t('过滤', 'Filter')}: ${filterNames}`);
    else if (b.label) subParts.push(b.label);
    return (
      <div className="mobile-ctx-bar station-ro" role="region" aria-label={t('建筑信息', 'Building Info')}>
        <div className="mobile-ctx-info">
          <EntityGlyph id={b.type} size={22} />
          <div className="mobile-ctx-text">
            <div className="mobile-ctx-title">{title}</div>
            <div className="mobile-ctx-sub">{subParts.join(' · ')}</div>
            {fault && (
              <div className={`mobile-ctx-note ${fault.severity}`}>{fault.message}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClearSelection}
          aria-label={t('关闭', 'Close')}
        >
          ×
        </button>
      </div>
    );
  }

  if (selection.moduleIds.length > 0) {
    const m = doc.modules.find((x) => x.id === selection.moduleIds[0]);
    if (!m) return null;
    const def = getModuleDef(m.type);
    const title = def ? getModuleName(def, lang) : m.type;
    const subParts: string[] = [formatFloorTag(m.floor)];
    if (def) {
      subParts.push(
        isEn
          ? `${def.sizeUnits[0]}×${def.sizeUnits[1]} · ${def.sizeUnits[2]}F`
          : `${def.sizeUnits[0]}×${def.sizeUnits[1]} · ${def.sizeUnits[2]}层`
      );
      if (def.powerGenKW) subParts.push(`+${def.powerGenKW / 1000}MW`);
      else if (def.powerKW) subParts.push(`-${def.powerKW / 1000}MW`);
    }
    if (m.label) subParts.push(m.label);
    const fault = simReport?.faults.find((f) => f.moduleId === m.id);
    return (
      <div className="mobile-ctx-bar station-ro" role="region" aria-label={t('模块信息', 'Module Info')}>
        <div className="mobile-ctx-info">
          <EntityGlyph id={m.type} size={22} />
          <div className="mobile-ctx-text">
            <div className="mobile-ctx-title">{title}</div>
            <div className="mobile-ctx-sub">{subParts.join(' · ')}</div>
            {fault && (
              <div className={`mobile-ctx-note ${fault.severity}`}>{fault.message}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClearSelection}
          aria-label={t('关闭', 'Close')}
        >
          ×
        </button>
      </div>
    );
  }

  return null;
};
