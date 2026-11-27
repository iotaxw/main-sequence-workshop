import React from 'react';
import { useI18n } from '../core/i18n';
import type { BlueprintCategory } from '../core/types';
import { useHoverMenu } from './useHoverMenu';

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
  const { open, close, wrapRef, containerProps, onTriggerClick } = useHoverMenu();

  const choose = (category: BlueprintCategory) => {
    close();
    onSelectCategory(category);
  };

  return (
    <div className="new-bp-anchor" ref={wrapRef} {...containerProps}>
      <button
        type="button"
        className={`${buttonClassName} ${open ? 'accent' : ''}`}
        onClick={onTriggerClick}
        aria-label={title ?? t('新建蓝图', 'New Blueprint')}
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
            className="new-bp-item"
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
