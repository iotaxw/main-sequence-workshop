import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import type { BlueprintLibraryDriver } from '../core/library';
import type {
  BlueprintCategory,
  BlueprintDocument,
  LibraryFileEntry,
  LibraryFolderEntry,
  LibraryNode,
} from '../core/types';
import type { CadThemeId } from '../renderer/theme';
import { BlueprintThumbnail } from './BlueprintThumbnail';
import { NewBlueprintMenu } from './NewBlueprintMenu';

interface BlueprintLibraryModalProps {
  open: boolean;
  onClose: () => void;
  driver: BlueprintLibraryDriver;
  fsSupported: boolean;
  tree: LibraryNode[];
  theme: CadThemeId;
  activeSourcePath: string | null;
  stampingPath: string | null;
  onMountLocalFolder: () => void;
  onOpenGitHubConnect: () => void;
  onRefresh: () => void;
  onNewBlueprint: (category?: BlueprintCategory) => void;
  onCreateFolder: (parentFolder: string) => void;
  onImportJsonFile: (file: File) => void;
  onStampFromLibrary: (file: LibraryFileEntry) => void;
  onOpenFromLibrary: (file: LibraryFileEntry) => void;
  onExportFromLibrary: (file: LibraryFileEntry) => void;
  onExportSavFromLibrary: (file: LibraryFileEntry) => void;
  onDeleteEntry: (path: string, isFolder: boolean) => void;
  onMoveFile: (fromPath: string, targetFolder: string) => void;
}

function collectFilesInFolder(nodes: LibraryNode[], folderPath: string): LibraryFileEntry[] {
  const out: LibraryFileEntry[] = [];
  const walk = (list: LibraryNode[]) => {
    for (const node of list) {
      if (node.kind === 'file') {
        if (!folderPath || node.path.startsWith(`${folderPath}/`)) {
          out.push(node);
        }
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

function countFiles(nodes: LibraryNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count += n.kind === 'file' ? 1 : countFiles(n.children);
  }
  return count;
}

function collectFolders(nodes: LibraryNode[]): LibraryFolderEntry[] {
  return nodes.filter((n): n is LibraryFolderEntry => n.kind === 'folder');
}

export const BlueprintLibraryModal: React.FC<BlueprintLibraryModalProps> = ({
  open,
  onClose,
  driver,
  fsSupported,
  tree,
  theme,
  activeSourcePath,
  stampingPath,
  onMountLocalFolder,
  onOpenGitHubConnect,
  onRefresh,
  onNewBlueprint,
  onCreateFolder,
  onImportJsonFile,
  onStampFromLibrary,
  onOpenFromLibrary,
  onExportFromLibrary,
  onExportSavFromLibrary,
  onDeleteEntry,
  onMoveFile,
}) => {
  const { isEn, t } = useI18n();
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [search, setSearch] = useState('');
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [docCache, setDocCache] = useState<Record<string, BlueprintDocument>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const driverRef = useRef(driver);

  useEffect(() => {
    if (driverRef.current !== driver) {
      driverRef.current = driver;
      setDocCache({});
      setLoadingPaths({});
      setSelectedFolder('');
    }
  }, [driver]);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => searchInputRef.current?.focus(), 40);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const totalCount = useMemo(() => countFiles(tree), [tree]);

  const visibleFiles = useMemo(() => {
    const base = collectFilesInFolder(tree, selectedFolder);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.blueprintName.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q)
    );
  }, [tree, selectedFolder, search]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const keyOf = (f: LibraryFileEntry) => `${f.path}@${f.contentHash ?? f.updatedAt}`;
    const queue = visibleFiles.filter((f) => !docCache[keyOf(f)]);
    if (queue.length === 0) return;

    let cursor = 0;
    const concurrency = driver.mode === 'github-private' ? 3 : 6;

    const worker = async () => {
      while (!cancelled) {
        const idx = cursor++;
        if (idx >= queue.length) break;
        const entry = queue[idx];
        const key = keyOf(entry);
        setLoadingPaths((prev) => ({ ...prev, [key]: true }));
        try {
          const { doc } = await driver.readBlueprint(entry.path);
          if (!cancelled) {
            setDocCache((prev) => ({ ...prev, [key]: doc }));
          }
        } catch {
          // Ignore individual preview read error
        } finally {
          if (!cancelled) {
            setLoadingPaths((prev) => {
              if (!prev[key]) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [open, visibleFiles, driver, docCache]);

  if (!open) return null;

  const renderFolderTree = (folders: LibraryFolderEntry[], depth: number): React.ReactNode =>
    folders.map((folder) => {
      const subFolders = collectFolders(folder.children);
      const isSelected = selectedFolder === folder.path;
      const isDrop = dropFolder === folder.path;
      const count = countFiles(folder.children);
      return (
        <div key={`mfolder:${folder.path}`}>
          <div
            className={`bpm-folder-row ${isSelected ? 'active' : ''} ${isDrop ? 'drop-target' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => setSelectedFolder(folder.path)}
            onDragOver={(e) => {
              e.preventDefault();
              setDropFolder(folder.path);
            }}
            onDragLeave={() => setDropFolder((cur) => (cur === folder.path ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              setDropFolder(null);
              if (dragPath) onMoveFile(dragPath, folder.path);
              setDragPath(null);
            }}
          >
            <span className="bpm-folder-name" title={folder.path}>
              {folder.name}
            </span>
            <span className="bpm-folder-count">{count}</span>
            <span className="bpm-folder-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="lib-mini-btn"
                title={t('新建子目录', 'New Subfolder')}
                onClick={() => onCreateFolder(folder.path)}
              >
                +
              </button>
              <button
                type="button"
                className="lib-mini-btn danger"
                title={t('删除目录', 'Delete Folder')}
                onClick={() => {
                  onDeleteEntry(folder.path, true);
                  if (selectedFolder === folder.path || selectedFolder.startsWith(`${folder.path}/`)) {
                    setSelectedFolder('');
                  }
                }}
              >
                ×
              </button>
            </span>
          </div>
          {subFolders.length > 0 && renderFolderTree(subFolders, depth + 1)}
        </div>
      );
    });

  return (
    <div className="cad-modal-overlay bpm-overlay" onClick={onClose}>
      <div className="bpm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header bpm-header">
          <div className="panel-title-wrap">
            <span className="panel-tag">BLUEPRINTS</span>
            <span className="panel-title">{t('蓝图库', 'Library')}</span>
            <span className="bpm-source-pill" title={driver.rootLabel}>
              <span
                className={`status-dot ${
                  driver.mode === 'fs-local' ? 'green' : driver.mode === 'github-private' ? 'amber' : 'blue'
                }`}
              />
              {driver.rootLabel}
            </span>
          </div>

          <div className="bpm-header-actions">
            {fsSupported && (
              <button
                type="button"
                className={`cad-btn ${driver.mode === 'fs-local' ? 'accent' : ''}`}
                onClick={onMountLocalFolder}
              >
                {driver.mode === 'fs-local' ? t('换目录', 'Switch Dir') : t('本地目录', 'Local Dir')}
              </button>
            )}
            <button
              type="button"
              className={`cad-btn ${driver.mode === 'github-private' ? 'accent' : ''}`}
              onClick={onOpenGitHubConnect}
            >
              {driver.mode === 'github-private' ? t('私有云 ✓', 'Cloud ✓') : t('私有云库', 'Private Cloud')}
            </button>
            <button type="button" className="cad-btn" onClick={onRefresh}>
              {t('刷新', 'Refresh')}
            </button>
            <span className="bpm-divider" />
            <NewBlueprintMenu
              label={t('+ 新建 ▾', '+ New ▾')}
              title={t('新建蓝图', 'New Blueprint')}
              align="right"
              onSelectCategory={(cat) => {
                onNewBlueprint(cat);
                if (cat === 'station') onClose();
              }}
            />
            <button type="button" className="cad-btn" onClick={() => onCreateFolder(selectedFolder)}>
              {t('+ 目录', '+ Folder')}
            </button>
            <label className="cad-btn file-label" title={t('导入 .json 或 .sav', 'Import .json or .sav')}>
              {t('导入', 'Import')}
              <input
                type="file"
                accept=".json,.sav,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    onImportJsonFile(file);
                    onClose();
                  }
                  e.target.value = '';
                }}
              />
            </label>
            <button type="button" className="icon-btn" onClick={onClose} title={t('关闭 (Esc)', 'Close (Esc)')}>
              ×
            </button>
          </div>
        </div>

        <div className="bpm-body">
          <aside className="bpm-folders">
            <div
              className={`bpm-folder-row ${selectedFolder === '' ? 'active' : ''} ${dropFolder === '' ? 'drop-target' : ''}`}
              onClick={() => setSelectedFolder('')}
              onDragOver={(e) => {
                e.preventDefault();
                setDropFolder('');
              }}
              onDragLeave={() => setDropFolder((cur) => (cur === '' ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDropFolder(null);
                if (dragPath) onMoveFile(dragPath, '');
                setDragPath(null);
              }}
            >
              <span className="bpm-folder-name">{t('全部蓝图', 'All Blueprints')}</span>
              <span className="bpm-folder-count">{totalCount}</span>
            </div>
            <div className="bpm-folder-scroll">{renderFolderTree(collectFolders(tree), 0)}</div>
          </aside>

          <section className="bpm-content">
            <div className="bpm-toolbar">
              <input
                ref={searchInputRef}
                type="text"
                className="cad-input bpm-search"
                placeholder={t('搜索蓝图...', 'Search blueprints...')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="bpm-meta-hint">
                {selectedFolder ? `/${selectedFolder}` : t('全部', 'All')} ·{' '}
                {isEn ? `${visibleFiles.length} items` : `${visibleFiles.length} 份`}
              </span>
            </div>

            <div className="bpm-grid">
              {visibleFiles.length === 0 ? (
                <div className="bpm-empty">{t('暂无蓝图', 'No blueprints')}</div>
              ) : (
                visibleFiles.map((file) => {
                  const cacheKey = `${file.path}@${file.contentHash ?? file.updatedAt}`;
                  const loadedDoc = docCache[cacheKey] ?? null;
                  const isEditing = activeSourcePath === file.path;
                  const isStamping = stampingPath === file.path;
                  const modCount = loadedDoc ? loadedDoc.modules.length : file.moduleCount;
                  const bldCount = loadedDoc ? loadedDoc.buildings.length : file.buildingCount;
                  return (
                    <div
                      key={file.path}
                      className={`bpm-card ${isEditing ? 'editing' : ''} ${isStamping ? 'stamping' : ''}`}
                      draggable
                      onDragStart={() => setDragPath(file.path)}
                      onDragEnd={() => {
                        setDragPath(null);
                        setDropFolder(null);
                      }}
                      onClick={() => {
                        onStampFromLibrary(file);
                        onClose();
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onOpenFromLibrary(file);
                        onClose();
                      }}
                      title={`${file.path}\n${t('单击盖章 · 双击打开', 'Click: Stamp · Dbl-click: Open')}`}
                    >
                      <div className="bpm-card-thumb">
                        <BlueprintThumbnail
                          doc={loadedDoc}
                          cacheKey={cacheKey}
                          theme={theme}
                          loading={Boolean(loadingPaths[cacheKey])}
                        />
                        {(isEditing || isStamping) && (
                          <span className={`bpm-card-badge ${isStamping ? 'stamping' : 'editing'}`}>
                            {isStamping ? t('盖章中', 'Stamping') : t('当前画布', 'Active')}
                          </span>
                        )}
                        <div className="bpm-card-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="bpm-card-btn"
                            title={t('打开编辑', 'Open in canvas')}
                            onClick={() => {
                              onOpenFromLibrary(file);
                              onClose();
                            }}
                          >
                            {t('打开', 'Open')}
                          </button>
                          <button
                            type="button"
                            className="bpm-card-btn"
                            title={t('导出 .sav', 'Export .sav')}
                            onClick={() => onExportSavFromLibrary(file)}
                          >
                            .sav
                          </button>
                          <button
                            type="button"
                            className="bpm-card-btn"
                            title={t('导出 JSON', 'Export JSON')}
                            onClick={() => onExportFromLibrary(file)}
                          >
                            JSON
                          </button>
                          <button
                            type="button"
                            className="bpm-card-btn danger"
                            title={t('删除', 'Delete')}
                            onClick={() => onDeleteEntry(file.path, false)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <div className="bpm-card-footer">
                        <div className="bpm-card-title">{file.blueprintName || file.name}</div>
                        <div className="bpm-card-sub">
                          {modCount > 0 || bldCount > 0
                            ? isEn
                              ? `${modCount}M · ${bldCount}B`
                              : `${modCount}模 · ${bldCount}建`
                            : t('载入', 'Load')}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
