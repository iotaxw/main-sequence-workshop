import React, { useMemo, useState } from 'react';
import type { LibraryFileEntry, LibraryFolderEntry, LibraryNode } from '../core/types';

interface LibrarySidebarProps {
  open: boolean;
  onToggleOpen: () => void;
  driverMode: 'fs-local' | 'virtual-idb';
  rootLabel: string;
  fsSupported: boolean;
  tree: LibraryNode[];
  activeSourcePath: string | null;
  stampingPath: string | null;
  onMountLocalFolder: () => void;
  onRefresh: () => void;
  onNewBlueprint: () => void;
  onCreateFolder: (parentFolder: string) => void;
  onImportJsonFile: (file: File) => void;
  onStampFromLibrary: (file: LibraryFileEntry) => void;
  onOpenFromLibrary: (file: LibraryFileEntry) => void;
  onExportFromLibrary: (file: LibraryFileEntry) => void;
  onDeleteEntry: (path: string, isFolder: boolean) => void;
  onMoveFile: (fromPath: string, targetFolder: string) => void;
}

function filterTree(nodes: LibraryNode[], query: string): LibraryNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: LibraryNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (node.name.toLowerCase().includes(q) || node.blueprintName.toLowerCase().includes(q)) {
        out.push(node);
      }
    } else {
      const children = filterTree(node.children, q);
      if (children.length > 0 || node.name.toLowerCase().includes(q)) {
        out.push({ ...node, children });
      }
    }
  }
  return out;
}

export const LibrarySidebar: React.FC<LibrarySidebarProps> = ({
  open,
  onToggleOpen,
  driverMode,
  rootLabel,
  fsSupported,
  tree,
  activeSourcePath,
  stampingPath,
  onMountLocalFolder,
  onRefresh,
  onNewBlueprint,
  onCreateFolder,
  onImportJsonFile,
  onStampFromLibrary,
  onOpenFromLibrary,
  onExportFromLibrary,
  onDeleteEntry,
  onMoveFile,
}) => {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  const filtered = useMemo(() => filterTree(tree, search), [tree, search]);

  if (!open) {
    return (
      <button
        type="button"
        className="cad-floating-toggle left"
        onClick={onToggleOpen}
        title="展开本地文件夹蓝图库"
      >
        蓝图库
      </button>
    );
  }

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const renderNode = (node: LibraryNode, depth: number): React.ReactNode => {
    if (node.kind === 'folder') {
      const folder = node as LibraryFolderEntry;
      const isClosed = !!collapsed[folder.path] && !search.trim();
      const isDrop = dropFolder === folder.path;
      return (
        <div key={`dir:${folder.path}`} className="lib-folder-group">
          <div
            className={`lib-row lib-folder ${isDrop ? 'drop-target' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => toggleFolder(folder.path)}
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
            <span className="lib-caret">{isClosed ? '▸' : '▾'}</span>
            <span className="lib-icon folder-icon">DIR</span>
            <span className="lib-name" title={folder.path}>{folder.name}</span>
            <span className="lib-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="lib-mini-btn"
                title="在此文件夹下新建子目录"
                onClick={() => onCreateFolder(folder.path)}
              >
                +目录
              </button>
              <button
                type="button"
                className="lib-mini-btn danger"
                title="删除文件夹"
                onClick={() => onDeleteEntry(folder.path, true)}
              >
                ×
              </button>
            </span>
          </div>
          {!isClosed && folder.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const file = node as LibraryFileEntry;
    const isEditing = activeSourcePath === file.path;
    const isStamping = stampingPath === file.path;
    return (
      <div
        key={`file:${file.path}`}
        className={`lib-row lib-file ${isEditing ? 'editing' : ''} ${isStamping ? 'stamping' : ''}`}
        style={{ paddingLeft: 14 + depth * 14 }}
        draggable
        onDragStart={() => setDragPath(file.path)}
        onDragEnd={() => {
          setDragPath(null);
          setDropFolder(null);
        }}
        onClick={() => onStampFromLibrary(file)}
        onDoubleClick={() => onOpenFromLibrary(file)}
        title="单击：加载到光标盖章粘贴 | 双击：打开为当前画布编辑"
      >
        <span className="lib-icon file-icon">BP</span>
        <div className="lib-file-meta">
          <div className="lib-name">{file.blueprintName || file.name}</div>
          <div className="lib-sub">
            {file.moduleCount}模 · {file.buildingCount}建 · {file.floorSpan}层
          </div>
        </div>
        <span className="lib-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="lib-mini-btn"
            title="打开编辑"
            onClick={() => onOpenFromLibrary(file)}
          >
            打开
          </button>
          <button
            type="button"
            className="lib-mini-btn"
            title="导出 JSON"
            onClick={() => onExportFromLibrary(file)}
          >
            导出
          </button>
          <button
            type="button"
            className="lib-mini-btn danger"
            title="删除蓝图"
            onClick={() => onDeleteEntry(file.path, false)}
          >
            ×
          </button>
        </span>
      </div>
    );
  };

  return (
    <aside className="cad-sidebar left">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">LIBRARY</span>
          <span className="panel-title">蓝图文件夹</span>
        </div>
        <button type="button" className="icon-btn" onClick={onToggleOpen} title="收起侧栏">
          ‹
        </button>
      </div>

      <div className="lib-mount-bar">
        <div className="lib-root-info">
          <span className={`status-dot ${driverMode === 'fs-local' ? 'green' : 'blue'}`} />
          <span className="lib-root-name" title={rootLabel}>{rootLabel}</span>
        </div>
        <div className="lib-mount-btns">
          {fsSupported && (
            <button type="button" className="cad-btn accent" onClick={onMountLocalFolder}>
              {driverMode === 'fs-local' ? '切换本地目录' : '挂载本地文件夹'}
            </button>
          )}
          <button type="button" className="cad-btn" onClick={onRefresh} title="刷新目录">
            刷新
          </button>
        </div>
      </div>

      <div className="lib-toolbar">
        <button type="button" className="cad-btn" onClick={onNewBlueprint}>
          + 新蓝图
        </button>
        <button type="button" className="cad-btn" onClick={() => onCreateFolder('')}>
          + 目录
        </button>
        <label className="cad-btn file-label">
          导入
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportJsonFile(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      <div className="lib-search-wrap">
        <input
          id="library-search"
          name="librarySearch"
          type="text"
          className="cad-input"
          placeholder="搜索文件夹或蓝图..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div
        className={`lib-tree ${dropFolder === '' ? 'drop-target' : ''}`}
        onDragOver={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setDropFolder('');
          }
        }}
        onDrop={(e) => {
          if (e.target === e.currentTarget && dragPath) {
            e.preventDefault();
            onMoveFile(dragPath, '');
            setDragPath(null);
            setDropFolder(null);
          }
        }}
      >
        {filtered.length === 0 ? (
          <div className="lib-empty">暂无匹配蓝图，可点击「+ 新蓝图」或挂载本地目录。</div>
        ) : (
          filtered.map((n) => renderNode(n, 0))
        )}
      </div>

      <div className="lib-hint">
        单击蓝图 → 化作幽灵盖章粘贴<br />
        双击蓝图 → 打开为当前画布编辑<br />
        拖拽文件 → 整理到子文件夹
      </div>
    </aside>
  );
};
