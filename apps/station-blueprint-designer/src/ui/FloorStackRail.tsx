import React, { useMemo } from 'react';
import { getModuleDef } from '../core/catalog';
import { formatFloorTag, useI18n } from '../core/i18n';
import type { BlueprintDocument } from '../core/types';

interface FloorStackRailProps {
  doc: BlueprintDocument;
  focusFloor: number;
  hideAbove: boolean;
  shifted: boolean;
  onSelectFloor: (floor: number) => void;
  onToggleHideAbove: () => void;
}

export const FloorStackRail: React.FC<FloorStackRailProps> = ({
  doc,
  focusFloor,
  hideAbove,
  shifted,
  onSelectFloor,
  onToggleHideAbove,
}) => {
  const { isEn, t } = useI18n();
  const { minFloor, maxFloor, countsByFloor } = useMemo(() => {
    const map = new Map<number, { mods: number; blds: number }>();
    let minF = 0;
    let maxF = 1;

    const bump = (f: number, kind: 'mods' | 'blds') => {
      if (f < minF) minF = f;
      if (f > maxF) maxF = f;
      const entry = map.get(f) ?? { mods: 0, blds: 0 };
      entry[kind] += 1;
      map.set(f, entry);
    };

    for (let i = 0; i < doc.modules.length; i++) {
      const m = doc.modules[i];
      const def = getModuleDef(m.type);
      const span = def?.sizeUnits[2] ?? 1;
      for (let df = 0; df < span; df++) {
        bump(m.floor + df, 'mods');
      }
    }
    for (let i = 0; i < doc.buildings.length; i++) {
      bump(doc.buildings[i].floor, 'blds');
    }
    return { minFloor: minF, maxFloor: maxF, countsByFloor: map };
  }, [doc.modules, doc.buildings]);

  const floors = useMemo(() => {
    const low = Math.max(-2, Math.min(minFloor, focusFloor, 0));
    const high = Math.min(8, Math.max(maxFloor, focusFloor, 1));
    const list: number[] = [];
    for (let f = high; f >= low; f--) list.push(f);
    return list;
  }, [minFloor, maxFloor, focusFloor]);

  const canStepUp = focusFloor < 8;
  const canStepDown = focusFloor > -2;

  return (
    <aside className={`cad-floor-rail ${shifted ? 'shifted' : ''}`} aria-label={t('楼层快切', 'Floor stack')}>
      <button
        type="button"
        className={`floor-rail-eye ${hideAbove ? 'active' : ''}`}
        onClick={onToggleHideAbove}
        title={hideAbove ? t('上层已隐 (V)', 'Upper hidden (V)') : t('上层透视 (V)', 'Upper visible (V)')}
      >
        {hideAbove ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.11 1 12c.73-1.71 1.84-3.25 3.21-4.53" />
            <path d="M9.9 4.24A10.8 10.8 0 0 1 12 4c5 0 9.27 3.89 11 8a11.7 11.7 0 0 1-2.06 3.27" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="floor-rail-step"
        disabled={!canStepUp}
        onClick={() => onSelectFloor(Math.min(8, focusFloor + 1))}
        title={t('升一层 (E)', 'Floor up (E)')}
      >
        ▲
      </button>

      <div className="floor-rail-list">
        {floors.map((f) => {
          const info = countsByFloor.get(f);
          const hasContent = Boolean(info && (info.mods > 0 || info.blds > 0));
          const isCurrent = f === focusFloor;
          const isHiddenAbove = hideAbove && f > focusFloor;
          const isShip = doc.category === 'ship';
          const tip = hasContent
            ? isShip
              ? isEn
                ? `${formatFloorTag(f)} · ${info!.mods}M`
                : `${formatFloorTag(f)} · ${info!.mods}模`
              : isEn
                ? `${formatFloorTag(f)} · ${info!.mods}M · ${info!.blds}B`
                : `${formatFloorTag(f)} · ${info!.mods}模 · ${info!.blds}建`
            : `${formatFloorTag(f)} · ${t('空', 'Empty')}`;
          return (
            <button
              key={f}
              type="button"
              className={`floor-rail-pill ${isCurrent ? 'active' : ''} ${hasContent ? 'populated' : ''} ${
                isHiddenAbove ? 'dimmed' : ''
              }`}
              onClick={() => onSelectFloor(f)}
              title={tip}
            >
              <span className="floor-rail-code">{formatFloorTag(f)}</span>
              <span className="floor-rail-dot" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="floor-rail-step"
        disabled={!canStepDown}
        onClick={() => onSelectFloor(Math.max(-2, focusFloor - 1))}
        title={t('降一层 (Q)', 'Floor down (Q)')}
      >
        ▼
      </button>
    </aside>
  );
};
