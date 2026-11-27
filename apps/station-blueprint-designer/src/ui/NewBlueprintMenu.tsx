import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import type { BlueprintCategory } from '../core/types';

interface NewBlueprintMenuProps {
  label: string;
  title?: string;
  align?: 'left' | 'right';
  buttonClassName?: string;
  onSelectCategory: (category: BlueprintCategory) => void;
}

/**
 * Extensible "New Blueprint" dropdown supporting Station Blueprints today
 * and reserving a clean typed entry point for upcoming Ship Blueprints.
 */
export const NewBlueprintMenu: React.FC<NewBlueprintMenuProps> = ({
  label,
  title,
  align = 'left',
  buttonClassName = 'cad-btn',
  onSelectCategory,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  const choose = (category: BlueprintCategory) => {
    setOpen(false);
    onSelectCategory(category);
  };

  return (
    <div className="new-bp-anchor" ref={wrapRef}>
      <button
        type="button"
        className={`${buttonClassName} ${open ? 'accent' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={title ?? t('新建蓝图', 'New Blueprint')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {label}
      </button>

      {open && (
        <div className={`new-bp-popover align-${align}`} role="menu">
          <button
            type="button"
            className="new-bp-item"
            role="menuitem"
            onClick={() => choose('station')}
          >
            {t('空间站', 'Station')}
          </button>
          <button
            type="button"
            className="new-bp-item reserved"
            role="menuitem"
            onClick={() => choose('ship')}
          >
            {t('飞船', 'Ship')}
          </button>
        </div>
      )}
    </div>
  );
};
