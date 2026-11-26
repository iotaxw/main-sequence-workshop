import React from 'react';

export interface KeyHintItem {
  keys: string;
  label: string;
  active?: boolean;
}

export const KeyHintList: React.FC<{ items: KeyHintItem[]; compact?: boolean }> = ({ items, compact = false }) => {
  if (items.length === 0) return null;
  return (
    <div className={`cad-hint-list ${compact ? 'compact' : ''}`}>
      {items.map((item) => (
        <span
          key={`${item.keys}:${item.label}`}
          className={`cad-hint-item ${item.active ? 'is-active' : ''}`}
        >
          <kbd className="cad-op-kbd">{item.keys}</kbd>
          <span className="cad-op-act">{item.label}</span>
        </span>
      ))}
    </div>
  );
};

interface ToolActionBarProps {
  mode: string;
  badge?: string;
  tone?: 'default' | 'accent' | 'danger';
  hints: KeyHintItem[];
}

export const ToolActionBar: React.FC<ToolActionBarProps> = ({
  mode,
  badge,
  tone = 'default',
  hints,
}) => (
  <div className={`cad-tool-banner tone-${tone}`} role="status" aria-live="off">
    <span className="cad-op-mode">
      <span className={`cad-op-dot ${tone}`} aria-hidden="true" />
      <span className="cad-op-title">{mode}</span>
      {badge && <span className="cad-op-tag">{badge}</span>}
    </span>
    {hints.length > 0 && (
      <>
        <span className="cad-op-sep" aria-hidden="true" />
        <KeyHintList items={hints} />
      </>
    )}
  </div>
);
