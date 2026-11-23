import React, { useState } from 'react';
import type { LibraryFileEntry, LibraryFolderEntry, LibraryNode } from '../core/types';

interface LibrarySidebarProps {
  open: boolean;
  onToggleOpen: () => void;
  onOpenModal: () => void;
  driverMode: 'fs-local' | 'virtual-idb' | 'github-private';
  rootLabel: string;
  tree: LibraryNode[];
  activeSourcePath: string | null;
  stampingPath: string | null;
  onNewBlueprint: () => void;
  onStampFromLibrary: (file: LibraryFileEntry) => void;
  onOpenFromLibrary: (file: LibraryFileEntry) => void;
}

export const LibrarySidebar: React.FC<LibrarySidebarProps> = ({
  open,
  onToggleOpen,
  onOpenModal,
  driverMode,
  rootLabel,
  tree,
  activeSourcePath,
  stampingPath,
  onNewBlueprint,
  onStampFromLibrary,
  onOpenFromLibrary,
}) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!open) {
    return (
      <div className="cad-floating-left-cluster">
        <button
          type="button"
          className="cad-floating-toggle-btn"
          onClick={onToggleOpen}
          title="展开极简蓝图列表"
        >
          蓝图列表 ›
        </button>
        <button
          type="button"
          className="cad-floating-toggle-btn accent"
          onClick={onOpenModal}
          title="打开俯视缩略图蓝图库 (L)"
        >
          ⊞ 图库 (L)
        </button>
      </div>
    );
  }

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const renderNode = (node: LibraryNode, depth: number): React.ReactNode => {
    if (node.kind === 'folder') {
      const folder = node as LibraryFolderEntry;
      const isClosed = !!collapsed[folder.path];
      return (
        <div key={`dir:${folder.path}`} className="lib-folder-group">
          <div
            className="lib-slim-row lib-slim-folder"
            style={{ paddingLeft: 10 + depth * 13 }}
            onClick={() => toggleFolder(folder.path)}
            title={folder.path}
          >
            <span className="lib-caret">{isClosed ? '▸' : '▾'}</span>
            <span className="lib-slim-name">{folder.name}</span>
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
        className={`lib-slim-row lib-slim-file ${isEditing ? 'editing' : ''} ${isStamping ? 'stamping' : ''}`}
        style={{ paddingLeft: 18 + depth * 13 }}
        onClick={() => onStampFromLibrary(file)}
        onDoubleClick={() => onOpenFromLibrary(file)}
        title={`${file.blueprintName || file.name}\n单击：抓取盖章 | 双击：打开画布编辑`}
      >
        <span className="lib-slim-name">{file.blueprintName || file.name}</span>
        <button
          type="button"
          className="lib-slim-open"
          title="打开编辑"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFromLibrary(file);
          }}
        >
          ↗
        </button>
      </div>
    );
  };

  const sourceShort =
    driverMode === 'github-private' ? '私有云库' : driverMode === 'fs-local' ? '本地目录' : '内置模板';

  return (
    <aside className="cad-sidebar left slim">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-title">蓝图</span>
          <button
            type="button"
            className="lib-source-chip"
            onClick={onOpenModal}
            title={`${rootLabel}（点击打开缩略图蓝图库 · L）`}
          >
            <span
              className={`status-dot ${
                driverMode === 'fs-local' ? 'green' : driverMode === 'github-private' ? 'amber' : 'blue'
              }`}
            />
            {sourceShort}
          </button>
        </div>
        <button type="button" className="icon-btn" onClick={onToggleOpen} title="收起侧栏">
          ‹
        </button>
      </div>

      <div className="lib-slim-top-actions">
        <button
          type="button"
          className="cad-btn accent lib-open-grid-btn"
          onClick={onOpenModal}
          title="展开悬浮缩略图蓝图库 (L)"
        >
          ⊞ 缩略图库 (L)
        </button>
        <button type="button" className="cad-btn" onClick={onNewBlueprint} title="新建空白空间站">
          +
        </button>
      </div>

      <div className="lib-tree">
        {tree.length === 0 ? (
          <div className="lib-empty">暂无蓝图</div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>

      <div className="lib-hint">单击盖章 · 双击打开 · L 缩略图</div>
    </aside>
  );
};
