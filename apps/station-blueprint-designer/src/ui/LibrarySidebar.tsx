import React, { useState } from 'react';
import { useI18n } from '../core/i18n';
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
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!open) {
    return (
      <div className="cad-floating-left-cluster">
        <button
          type="button"
          className="cad-floating-toggle-btn"
          onClick={onToggleOpen}
          title={t('展开蓝图列表', 'Expand list')}
        >
          {t('列表 ›', 'List ›')}
        </button>
        <button
          type="button"
          className="cad-floating-toggle-btn accent"
          onClick={onOpenModal}
          title={t('蓝图库 (L)', 'Blueprint Library (L)')}
        >
          {t('⊞ 图库 (L)', '⊞ Library (L)')}
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
        title={`${file.blueprintName || file.name}\n${t('单击盖章 · 双击打开', 'Click: Stamp · Dbl-click: Open')}`}
      >
        <span className="lib-slim-name">{file.blueprintName || file.name}</span>
        <button
          type="button"
          className="lib-slim-open"
          title={t('打开编辑', 'Open')}
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
    driverMode === 'github-private'
      ? t('私有云', 'Cloud')
      : driverMode === 'fs-local'
        ? t('本地', 'Local')
        : t('内置', 'Built-in');

  return (
    <aside className="cad-sidebar left slim">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-title">{t('蓝图', 'Blueprints')}</span>
          <span className="lib-source-chip" title={rootLabel}>
            <span
              className={`status-dot ${
                driverMode === 'fs-local' ? 'green' : driverMode === 'github-private' ? 'amber' : 'blue'
              }`}
            />
            {sourceShort}
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={onToggleOpen} title={t('收起侧栏', 'Collapse')}>
          ‹
        </button>
      </div>

      <div className="lib-slim-top-actions">
        <button
          type="button"
          className="cad-btn accent lib-open-grid-btn"
          onClick={onOpenModal}
          title={t('蓝图库 (L)', 'Blueprint Library (L)')}
        >
          {t('⊞ 图库 (L)', '⊞ Library (L)')}
        </button>
        <button type="button" className="cad-btn" onClick={onNewBlueprint} title={t('新建空白蓝图', 'New Blueprint')}>
          +
        </button>
      </div>

      <div className="lib-tree">
        {tree.length === 0 ? (
          <div className="lib-empty">{t('暂无蓝图', 'No blueprints')}</div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>
    </aside>
  );
};
