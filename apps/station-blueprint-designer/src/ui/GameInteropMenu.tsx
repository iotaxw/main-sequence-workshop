import React, { useRef } from 'react';
import { useI18n } from '../core/i18n';
import { useHoverMenu } from './useHoverMenu';

interface GameInteropMenuProps {
  onImportFile: (file: File) => void;
  onExportNativeSav: (mode: 'station' | 'preset') => void;
  onExportCanonicalJson: () => void;
}

export const GameInteropMenu: React.FC<GameInteropMenuProps> = ({
  onImportFile,
  onExportNativeSav,
  onExportCanonicalJson,
}) => {
  const { t } = useI18n();
  const { open, close, wrapRef, containerProps, onTriggerClick } = useHoverMenu();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="interop-anchor" ref={wrapRef} {...containerProps}>
      <button
        type="button"
        className={`cad-btn ${open ? 'accent' : ''}`}
        onClick={onTriggerClick}
        aria-label={t('导入与导出', 'Import & Export')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {t('互转 ▾', 'I/O ▾')}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".sav,.json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportFile(f);
          e.target.value = '';
          close();
        }}
      />

      {open && (
        <div className="interop-popover compact">
          <div className="interop-section">
            <div className="interop-section-title">{t('导入', 'Import')}</div>
            <button
              type="button"
              className="interop-action-btn row"
              onClick={() => inputRef.current?.click()}
            >
              <span className="interop-action-main">{t('导入蓝图', 'Import File')}</span>
              <span className="interop-tag">.sav / .json</span>
            </button>
          </div>

          <div className="interop-section">
            <div className="interop-section-title">{t('导出', 'Export')}</div>
            <button
              type="button"
              className="interop-action-btn row primary"
              onClick={() => {
                close();
                onExportNativeSav('station');
              }}
            >
              <span className="interop-action-main">{t('游戏整站', 'Station Save')}</span>
              <span className="interop-tag">.sav</span>
            </button>
            <button
              type="button"
              className="interop-action-btn row"
              onClick={() => {
                close();
                onExportNativeSav('preset');
              }}
            >
              <span className="interop-action-main">{t('局部预设', 'Section Preset')}</span>
              <span className="interop-tag">.preset.sav</span>
            </button>
            <button
              type="button"
              className="interop-action-btn row"
              onClick={() => {
                close();
                onExportCanonicalJson();
              }}
            >
              <span className="interop-action-main">{t('蓝图 JSON', 'Blueprint JSON')}</span>
              <span className="interop-tag">.json</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
