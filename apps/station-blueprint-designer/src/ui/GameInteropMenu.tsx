import React, { useEffect, useRef, useState } from 'react';

interface GameInteropMenuProps {
  driverMode: 'fs-local' | 'virtual-idb' | 'github-private';
  rootLabel: string;
  fsSupported: boolean;
  onImportFile: (file: File) => void;
  onExportNativeSav: (mode: 'station' | 'preset') => void;
  onExportCanonicalJson: () => void;
  onMountLocalFolder: () => void;
  onOpenGitHubConnect: () => void;
}

export const GameInteropMenu: React.FC<GameInteropMenuProps> = ({
  driverMode,
  rootLabel,
  fsSupported,
  onImportFile,
  onExportNativeSav,
  onExportCanonicalJson,
  onMountLocalFolder,
  onOpenGitHubConnect,
}) => {
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

  const sourceLabel =
    driverMode === 'fs-local' ? '本地目录' : driverMode === 'github-private' ? '私有云库' : '内置库';

  return (
    <div className="interop-anchor" ref={wrapRef}>
      <button
        type="button"
        className={`cad-btn accent ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="导入 / 导出 .sav 与 .json"
      >
        互转 ▾
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
            <div className="interop-section-title">导入</div>
            <button
              type="button"
              className="interop-action-btn row"
              onClick={() => inputRef.current?.click()}
            >
              <span className="interop-action-main">导入蓝图文件</span>
              <span className="interop-tag">.sav / .json</span>
            </button>
          </div>

          <div className="interop-section">
            <div className="interop-section-title">导出</div>
            <button
              type="button"
              className="interop-action-btn row primary"
              onClick={() => {
                setOpen(false);
                onExportNativeSav('station');
              }}
            >
              <span className="interop-action-main">原版整站设计图</span>
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
              <span className="interop-action-main">Mod 局部预设</span>
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
              <span className="interop-action-main">规范蓝图</span>
              <span className="interop-tag">.json</span>
            </button>
          </div>

          <div className="interop-section">
            <div className="interop-section-title">蓝图源</div>
            <div className="interop-sync-status" title={rootLabel}>
              <span
                className={`status-dot ${
                  driverMode === 'fs-local' ? 'green' : driverMode === 'github-private' ? 'amber' : 'blue'
                }`}
              />
              <span>{sourceLabel}</span>
            </div>
            <div className="interop-sync-actions">
              {fsSupported && (
                <button
                  type="button"
                  className="cad-btn"
                  onClick={() => {
                    setOpen(false);
                    onMountLocalFolder();
                  }}
                >
                  {driverMode === 'fs-local' ? '切换目录' : '本地目录'}
                </button>
              )}
              <button
                type="button"
                className="cad-btn accent"
                onClick={() => {
                  setOpen(false);
                  onOpenGitHubConnect();
                }}
              >
                {driverMode === 'github-private' ? '云库设置' : '私有云库'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
