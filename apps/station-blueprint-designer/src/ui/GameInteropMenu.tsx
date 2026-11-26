import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';

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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="interop-anchor" ref={wrapRef}>
      <button
        type="button"
        className={`cad-btn accent ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={t('导入 / 导出 .sav 与 .json', 'Import / Export .sav & .json')}
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
          setOpen(false);
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
                setOpen(false);
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
                setOpen(false);
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
                setOpen(false);
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
