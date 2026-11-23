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

  return (
    <div className="interop-anchor" ref={wrapRef}>
      <button
        type="button"
        className={`cad-btn accent ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="原生游戏设计图 (.sav) 双向互转与蓝图增强 Mod 共享生态"
      >
        游戏互转 ▾
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
        <div className="interop-popover">
          <div className="interop-header">
            <span className="panel-tag">INTEROP</span>
            <span className="panel-title">游戏格式互转 · 共享生态</span>
          </div>

          <div className="interop-section">
            <div className="interop-section-title">1. 从游戏导入</div>
            <button
              type="button"
              className="interop-action-btn"
              onClick={() => inputRef.current?.click()}
            >
              <span className="interop-action-main">导入游戏设计图 (.sav) / 规范蓝图 (.json)</span>
              <span className="interop-action-sub">也支持直接把 Designs/*.sav 拖进 3D 画布打开并仿真诊断</span>
            </button>
            <div className="interop-path-hint" title="游戏原版设计图目录">
              原版路径：%LOCALAPPDATA%\MainSequence\Saved\SaveGames\Designs\
            </div>
          </div>

          <div className="interop-section">
            <div className="interop-section-title">2. 导出到游戏（共享 Rust/WASM 核心）</div>
            <button
              type="button"
              className="interop-action-btn primary"
              onClick={() => {
                setOpen(false);
                onExportNativeSav('station');
              }}
            >
              <span className="interop-action-main">导出原版整站设计图 (.sav · STATION)</span>
              <span className="interop-action-sub">零 Mod 通用：放入 Designs 目录即可在原版空间站设计器载入（含机器/配方/地下带/缩略图）</span>
            </button>
            <button
              type="button"
              className="interop-action-btn"
              onClick={() => {
                setOpen(false);
                onExportNativeSav('preset');
              }}
            >
              <span className="interop-action-main">导出局部预设载荷 (.sav · STATION_PRESET)</span>
              <span className="interop-action-sub">供未来游戏内蓝图增强 Mod 剪贴板粘贴或局部载荷联调</span>
            </button>
            <button
              type="button"
              className="interop-action-btn"
              onClick={() => {
                setOpen(false);
                onExportCanonicalJson();
              }}
            >
              <span className="interop-action-main">导出规范蓝图 (.json)</span>
              <span className="interop-action-sub">主星序工坊统一主格式，适合跨项目复用、分享与版本管理</span>
            </button>
          </div>

          <div className="interop-section">
            <div className="interop-section-title">3. 与 Mod / 个人私有云蓝图库同步</div>
            <div className={`interop-sync-card ${driverMode !== 'virtual-idb' ? 'mounted' : ''}`}>
              <div className="interop-sync-status">
                <span
                  className={`status-dot ${
                    driverMode === 'fs-local' ? 'green' : driverMode === 'github-private' ? 'amber' : 'blue'
                  }`}
                />
                <span>
                  {driverMode === 'fs-local'
                    ? `已挂载本地共享目录：${rootLabel}`
                    : driverMode === 'github-private'
                      ? `已连接私有云库：${rootLabel}`
                      : '当前使用浏览器内置库'}
                </span>
              </div>
              <div className="interop-sync-desc">
                {driverMode === 'fs-local'
                  ? '规范 .json 直接落盘，未来游戏内蓝图增强 Mod 指向同一目录即可自动共用。'
                  : driverMode === 'github-private'
                    ? '直接在公开网页读写个人 GitHub 私有仓库蓝图，代码与公开站永久同步且绝不暴露私有蓝图。'
                    : '可挂载本地文件夹与游戏内 Mod 共用，或连接个人 GitHub 私有库跨设备云端访问私有蓝图。'}
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
                    {driverMode === 'fs-local' ? '切换本地目录' : '挂载本地目录'}
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
                  {driverMode === 'github-private' ? '管理 GitHub 私有库' : '连接 GitHub 私有库'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
