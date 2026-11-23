import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Dataset,
  DatasetIndex,
  Fork,
  Issue,
  ItemDefinition,
  ItemQuantity,
  MachineDefinition,
  RecipeDefinition,
  RecipeRow,
  SolvedPlan,
} from '../core/types';
import { formatExactMachine, formatPower, formatRate } from './format';
import { entityName, useLanguage } from './language';

const iconUrl = (id: string) => `${import.meta.env.BASE_URL}icons/${id}.png`;

const uiIconPaths = {
  input: 'M8 2v10M3 13h10',
  arrow: 'M2 8h11M9.5 4.5 13 8l-3.5 3.5',
  add: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  fork: 'M4 2v2.5a4 4 0 0 0 8 0V2M8 8.5V14',
  recycle: 'M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3',
  search: 'M11 11l3 3M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z',
  target: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  power: 'M9 1.5 3.5 9h4L7 14.5 12.5 7h-4z',
} as const;

export function UiIcon({ name, size = 16 }: { name: keyof typeof uiIconPaths; size?: 12 | 16 | 20 | 32 }) {
  return (
    <svg className={`ui-icon ui-icon--${name}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={uiIconPaths[name]} />
    </svg>
  );
}

export function ItemGlyph({ item, role = 'item', size = 'medium' }: {
  item: ItemDefinition;
  role?: 'raw' | 'target' | 'byproduct' | 'item';
  size?: 'small' | 'medium' | 'large';
}) {
  const [failed, setFailed] = useState(false);
  const { language, t } = useLanguage();
  const name = entityName(item, language);
  return (
    <span className={`glyph glyph--${role} glyph--${size}${failed ? ' glyph--fallback' : ''}`} title={failed ? `${name}：${t('iconFailed')}` : name} aria-label={name}>
      {failed
        ? <span className="glyph__code" aria-label={t('iconFailed')}>{item.shortCode}</span>
        : <img src={iconUrl(item.id)} alt={name} onError={() => setFailed(true)} />}
    </span>
  );
}

export function MachineGlyph({ machine, size = 'medium' }: { machine: MachineDefinition; size?: 'small' | 'medium' }) {
  const [failed, setFailed] = useState(false);
  const { language, t } = useLanguage();
  const name = entityName(machine, language);
  return (
    <span className={`glyph glyph--machine glyph--${size}${failed ? ' glyph--fallback' : ''}`} title={failed ? `${name}：${t('iconFailed')}` : undefined} aria-label={name}>
      {failed
        ? <span className="glyph__code" aria-label={t('iconFailed')}>{machine.shortCode}</span>
        : <img src={iconUrl(machine.id)} alt={name} onError={() => setFailed(true)} />}
    </span>
  );
}

export function RateValue({ value }: { value: string }) {
  return <span className="rate-value">{formatRate(value)}</span>;
}

export function PowerValue({ power, basis = 'built' }: {
  power: { exact: string; built: string } | null;
  basis?: 'exact' | 'built';
}) {
  const { language, t } = useLanguage();
  if (!power) {
    return <span className="power-value power-value--missing" title={t('powerMissing')} aria-label={t('powerMissing')}><UiIcon name="power" />?</span>;
  }
  return (
    <span className={`power-value power-value--${basis}`} title={language === 'en' ? `Built ${formatPower(power.built)}, continuous ${formatPower(power.exact)}` : `建设 ${formatPower(power.built)}，连续 ${formatPower(power.exact)}`}>
      <UiIcon name="power" />{formatPower(power[basis])}
    </span>
  );
}

function QuantityList({ entries, index, side }: {
  entries: ItemQuantity[];
  index: DatasetIndex;
  side: 'in' | 'out';
}) {
  const { language } = useLanguage();
  return (
    <span className={`quantity-list quantity-list--${side}`}>
      {entries.length === 0 && <span className="quantity-list__empty" aria-hidden="true">—</span>}
      {entries.map((entry, entryIndex) => {
        const item = index.items.get(entry.itemId)!;
        const name = entityName(item, language);
        const quantity = formatRate(entry.quantity);
        return (
          <span className="quantity" key={`${entry.itemId}-${entryIndex}`} title={`${name} ×${quantity}`}>
            <ItemGlyph item={item} role={entry.isByproduct ? 'byproduct' : item.category === 'raw' ? 'raw' : 'item'} />
            <span className="quantity__value">{quantity}</span>
          </span>
        );
      })}
    </span>
  );
}

export function RecipeFormula({ recipe, index }: { recipe: RecipeDefinition; index: DatasetIndex }) {
  const { t } = useLanguage();
  const duration = `${formatRate(recipe.durationSeconds)} s`;
  return (
    <span className="recipe-formula">
      <QuantityList entries={recipe.inputs} index={index} side="in" />
      <span className="recipe-formula__time" title={`${t('duration')} ${duration}`} aria-label={`${t('duration')} ${duration}`}>
        <span className="recipe-formula__seconds">{duration}</span>
        <UiIcon name="arrow" size={20} />
      </span>
      <QuantityList entries={recipe.outputs} index={index} side="out" />
    </span>
  );
}

export function MachineCard({ machine, machines }: {
  machine: MachineDefinition;
  machines: RecipeRow['machines'];
}) {
  const { language } = useLanguage();
  const name = entityName(machine, language);
  const exact = formatExactMachine(machines.exact);
  const description = language === 'en'
    ? `${name}: build ${machines.built}, continuous ${exact}`
    : `${name}：建设 ${machines.built} 台，连续 ${exact} 台`;
  return (
    <div className="machine-card" role="group" title={description} aria-label={description}>
      <MachineGlyph machine={machine} />
      <span className="machine-card__name">{name}</span>
      <strong className="machine-card__count" aria-hidden="true"><span>×</span>{machines.built}</strong>
    </div>
  );
}

export function RecipeCard({ row, index, activeForkItemId, onSwitch }: {
  row: RecipeRow;
  index: DatasetIndex;
  activeForkItemId?: string | null;
  onSwitch: (itemId: string, anchor: HTMLElement) => void;
}) {
  const { t } = useLanguage();
  const recipe = index.recipes.get(row.recipeId)!;
  const machine = index.machines.get(row.machineId)!;
  const primaryOutput = recipe.outputs.find(output => !output.isByproduct) ?? recipe.outputs[0]!;
  const alternatives = index.recipesByOutput.get(primaryOutput.itemId) ?? [];
  const hasAlternatives = alternatives.length > 1;
  const isOpen = hasAlternatives && activeForkItemId === primaryOutput.itemId;
  return (
    <article className={`recipe-card${isOpen ? ' recipe-card--editing' : ''}`} aria-label={recipe.id}>
      <div className="recipe-card__recipe">
        <RecipeFormula recipe={recipe} index={index} />
      </div>
      <div className="recipe-card__build">
        <MachineCard machine={machine} machines={row.machines} />
        <span className="recipe-card__action">
          {hasAlternatives && (
            <button
              className={`recipe-card__switch${isOpen ? ' recipe-card__switch--open' : ''}`}
              onClick={event => onSwitch(primaryOutput.itemId, event.currentTarget)}
              aria-label={t('switchRecipe')}
              aria-expanded={isOpen}
              aria-haspopup="dialog"
              title={t('switchRecipe')}
            >
              <UiIcon name="fork" size={12} />
              <span>{alternatives.length}</span>
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

export function RecipeGrid({ rows, index, activeForkItemId, onSwitch }: {
  rows: RecipeRow[];
  index: DatasetIndex;
  activeForkItemId?: string | null;
  onSwitch: (itemId: string, anchor: HTMLElement) => void;
}) {
  const { t } = useLanguage();
  const groups = useMemo(() => {
    const rowByItem = new Map<string, number>();
    rows.forEach((row, rowIndex) => {
      for (const output of index.recipes.get(row.recipeId)!.outputs) {
        if (!output.isByproduct) rowByItem.set(output.itemId, rowIndex);
      }
    });
    const dependencies = rows.map((row, rowIndex) => {
      const result = new Set<number>();
      for (const input of index.recipes.get(row.recipeId)!.inputs) {
        const producer = rowByItem.get(input.itemId);
        if (producer !== undefined && producer !== rowIndex) result.add(producer);
      }
      return result;
    });
    const dependents = rows.map(() => new Set<number>());
    const indegree = dependencies.map(items => items.size);
    dependencies.forEach((items, rowIndex) => {
      for (const dependency of items) dependents[dependency]!.add(rowIndex);
    });
    const tiers = new Map<number, number>();
    const queue = indegree.flatMap((degree, rowIndex) => degree === 0 ? [rowIndex] : []);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const rowIndex = queue[cursor]!;
      const tier = [...dependencies[rowIndex]!].reduce((max, dependency) => Math.max(max, (tiers.get(dependency) ?? 0) + 1), 1);
      tiers.set(rowIndex, tier);
      for (const dependent of dependents[rowIndex]!) {
        if (--indegree[dependent]! === 0) queue.push(dependent);
      }
    }
    const result = new Map<string, RecipeRow[]>();
    rows.forEach((row, rowIndex) => {
      const key = tiers.has(rowIndex) ? `${tiers.get(rowIndex)}` : '↻';
      result.set(key, [...result.get(key) ?? [], row]);
    });
    return [...result.entries()].sort(([left], [right]) => {
      if (left === '↻') return 1;
      if (right === '↻') return -1;
      return Number(left) - Number(right);
    });
  }, [rows, index]);
  return (
    <div className="tiers">
      {groups.map(([tier, group]) => (
        <section className="tier" key={tier} aria-label={tier === '↻' ? t('cycle') : `${t('tier')} ${tier}`}>
          <div className="tier__mark">
            {tier === '↻' ? <UiIcon name="recycle" /> : <span>{tier.padStart(2, '0')}</span>}
          </div>
          <div className="card-grid">
            {group.map(row => <RecipeCard key={row.recipeId} row={row} index={index} activeForkItemId={activeForkItemId} onSwitch={onSwitch} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ForkPopover({ fork, index, activeRecipeIds, anchorEl, onSelect, onRemoveRecycle, onClose }: {
  fork: Fork;
  index: DatasetIndex;
  activeRecipeIds: string[];
  anchorEl: HTMLElement | null;
  onSelect: (recipeId: string) => void;
  onRemoveRecycle?: () => void;
  onClose: () => void;
}) {
  const { language, t } = useLanguage();
  const item = index.items.get(fork.itemId)!;
  const heading = t(fork.kind === 'recycle' ? 'selectRecycle' : 'selectProduce');
  const activeSet = useMemo(() => new Set(activeRecipeIds), [activeRecipeIds]);
  const panelRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const compute = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 12;
      const preferredW = fork.recipeIds.length > 1 ? Math.min(680, vw - pad * 2) : Math.min(360, vw - pad * 2);
      const panelH = panelRef.current?.offsetHeight ?? 210;
      const anchorRect = anchorEl?.getBoundingClientRect() ?? null;
      if (!anchorRect || vw <= 560) {
        setPos({
          top: Math.max(pad, Math.min(vh - panelH - pad, vh * 0.28)),
          left: Math.max(pad, (vw - preferredW) / 2),
          width: preferredW,
        });
        return;
      }
      const spaceBelow = vh - anchorRect.bottom - pad;
      const cardRect = anchorEl?.closest('.recipe-card')?.getBoundingClientRect() ?? anchorRect;
      const spaceRight = vw - cardRect.right - pad;
      let rawTop: number;
      let rawLeft: number;
      if (spaceBelow >= panelH + 8) {
        rawTop = anchorRect.bottom + 8;
        rawLeft = anchorRect.left + anchorRect.width * 0.5 - preferredW * 0.5;
      } else if (spaceRight >= preferredW + 10) {
        rawTop = cardRect.top;
        rawLeft = cardRect.right + 10;
      } else if (anchorRect.top > panelH + pad) {
        rawTop = cardRect.top - panelH - 8;
        rawLeft = anchorRect.left + anchorRect.width * 0.5 - preferredW * 0.5;
      } else {
        rawTop = anchorRect.bottom + 8;
        rawLeft = anchorRect.left + anchorRect.width * 0.5 - preferredW * 0.5;
      }
      const top = Math.max(pad, Math.min(vh - panelH - pad, rawTop));
      const left = Math.max(pad, Math.min(vw - preferredW - pad, rawLeft));
      setPos({ top, left, width: preferredW });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [anchorEl, fork.recipeIds.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [anchorEl, onClose]);

  return (
    <section
      ref={panelRef}
      className={`panel fork-popover fork-picker fork-picker--${fork.kind}`}
      style={pos ? { top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px` } : { visibility: 'hidden' }}
      role="dialog"
      aria-label={heading}
    >
      <header className="panel__head fork-popover__head">
        <UiIcon name={fork.kind === 'recycle' ? 'recycle' : 'fork'} />
        <span className="panel__title">{heading}</span>
        <ItemGlyph item={item} role={fork.kind === 'recycle' ? 'byproduct' : 'target'} size="small" />
        <span className="fork-picker__item">{entityName(item, language)}</span>
        <span className="fork-popover__spacer" />
        {fork.kind === 'recycle' && onRemoveRecycle && (
          <button className="fork-popover__clear" onClick={onRemoveRecycle}>
            {t('removeRecycle')}
          </button>
        )}
        <button className="icon-button fork-popover__close" onClick={onClose} aria-label={t('close')} title={t('close')}>
          <UiIcon name="close" size={12} />
        </button>
      </header>
      <div className="card-grid fork-popover__grid" role="radiogroup" aria-label={heading}>
        {fork.recipeIds.map(recipeId => {
          const recipe = index.recipes.get(recipeId)!;
          const machine = index.machines.get(recipe.machineId)!;
          const selected = activeSet.has(recipeId);
          return (
            <button
              className={`recipe-card recipe-option${selected ? ' recipe-option--active' : ''}`}
              key={recipe.id}
              onClick={() => onSelect(recipeId)}
              role="radio"
              aria-checked={selected}
            >
              <span className="recipe-card__recipe">
                <RecipeFormula recipe={recipe} index={index} />
              </span>
              <span className="recipe-card__build">
                <span className="machine-card">
                  <MachineGlyph machine={machine} />
                  <span className="machine-card__name">{entityName(machine, language)}</span>
                  {selected && <span className="recipe-option__dot" aria-hidden="true" />}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ItemPicker({ items, onSelect, onClose }: {
  items: ItemDefinition[];
  onSelect: (itemId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const { language, t } = useLanguage();
  const filtered = items
    .filter(item => item.nativeOrder !== null || item.category === 'machine')
    .filter(item => `${entityName(item, language)} ${item.name} ${item.id} ${item.shortCode}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="modal" onClick={onClose}>
      <section className="item-picker" role="dialog" aria-modal="true" aria-label={t('searchItems')} onClick={event => event.stopPropagation()}>
        <div className="item-picker__bar">
          <label className="search-field">
            <UiIcon name="search" />
            <input autoFocus value={query} onChange={event => setQuery(event.target.value)} aria-label={t('searchItems')} placeholder={t('searchItems')} />
          </label>
          <button className="icon-button" onClick={onClose} aria-label={t('close')}><UiIcon name="close" /></button>
        </div>
        <div className="item-picker__grid">
          {filtered.map(item => (
            <button className="item-option" key={item.id} onClick={() => onSelect(item.id)} title={entityName(item, language)}>
              <ItemGlyph item={item} role={item.category === 'raw' ? 'raw' : 'item'} />
              <span>{entityName(item, language)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function SummaryStrip({ plan, index, activeRecycleItemId, onOpenRecycle }: {
  plan: SolvedPlan;
  index: DatasetIndex;
  activeRecycleItemId?: string | null;
  onOpenRecycle: (itemId: string, anchor: HTMLElement) => void;
}) {
  const { language, t } = useLanguage();
  const machines = plan.summary.machines;
  const exactMachines = formatExactMachine(machines.exact);
  const machineDescription = language === 'en'
    ? `Built ${machines.built}, continuous ${exactMachines}`
    : `建设 ${machines.built} 台，连续 ${exactMachines} 台`;
  const surplusByproductIds = new Set(plan.byproducts.map(flow => flow.itemId));
  const rowByproductIds = plan.rows.flatMap(row =>
    row.outputs.filter(output => output.isByproduct).map(output => output.itemId),
  );
  const balancedByproductIds = [...new Set([
    ...Object.keys(plan.recycleByItem),
    ...rowByproductIds,
  ])].filter(itemId => !surplusByproductIds.has(itemId));
  const hasAnyByproduct = plan.byproducts.length > 0 || balancedByproductIds.length > 0;
  return (
    <section className="summary" aria-label={t('summary')}>
      <div className="metric metric--flows">
        <span className="metric__label">{t('externalInputs')}<span className="metric__unit">/min</span></span>
        <div className="metric__flows">
          {plan.rawInputs.map(flow => (
            <span className="flow-chip" key={flow.itemId}>
              <ItemGlyph item={index.items.get(flow.itemId)!} role="raw" size="small" />
              <RateValue value={flow.ratePerMin} />
            </span>
          ))}
        </div>
      </div>
      {hasAnyByproduct && (
        <div className="metric metric--flows">
          <span className="metric__label">{t('byproductOutputs')}<span className="metric__unit">/min</span></span>
          <div className="metric__flows">
            {plan.byproducts.map(flow => {
              const active = plan.recycleByItem[flow.itemId] !== undefined;
              const isOpen = activeRecycleItemId === flow.itemId;
              return (
                <span className={`flow-chip flow-chip--byproduct${isOpen ? ' flow-chip--editing' : ''}`} key={flow.itemId}>
                  <ItemGlyph item={index.items.get(flow.itemId)!} role="byproduct" size="small" />
                  <RateValue value={flow.ratePerMin} />
                  <button
                    className={`recycle-toggle${active ? ' recycle-toggle--on' : ''}${isOpen ? ' recycle-toggle--open' : ''}`}
                    onClick={event => onOpenRecycle(flow.itemId, event.currentTarget)}
                    aria-label={t(active ? 'selectRecycle' : 'recycle')}
                    aria-pressed={active}
                    aria-expanded={isOpen}
                    aria-haspopup="dialog"
                    title={t(active ? 'selectRecycle' : 'recycle')}
                  >
                    <UiIcon name="recycle" size={12} />
                  </button>
                </span>
              );
            })}
            {balancedByproductIds.map(itemId => {
              const isOpen = activeRecycleItemId === itemId;
              return (
                <span className={`flow-chip flow-chip--byproduct flow-chip--balanced${isOpen ? ' flow-chip--editing' : ''}`} key={itemId}>
                  <ItemGlyph item={index.items.get(itemId)!} role="byproduct" size="small" />
                  <RateValue value="0" />
                  <button
                    className={`recycle-toggle recycle-toggle--on${isOpen ? ' recycle-toggle--open' : ''}`}
                    onClick={event => onOpenRecycle(itemId, event.currentTarget)}
                    title={t('selectRecycle')}
                    aria-label={t('selectRecycle')}
                    aria-pressed="true"
                    aria-expanded={isOpen}
                    aria-haspopup="dialog"
                  >
                    <UiIcon name="recycle" size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}
      <div className="metric metric--figure" title={machineDescription} aria-label={`${t('totalMachines')}：${machineDescription}`}>
        <span className="metric__label">{t('totalMachines')}</span>
        <strong className="metric__value" aria-hidden="true">{machines.built}</strong>
        <small className="metric__aux" aria-hidden="true">≈ {exactMachines}</small>
      </div>
      <div className="metric metric--figure">
        <span className="metric__label">{t('totalPower')}</span>
        <strong className="metric__value"><PowerValue power={plan.summary.powerKW} /></strong>
        {plan.summary.powerKW && <small className="metric__aux" title={`${t('continuous')} ${formatPower(plan.summary.powerKW.exact)}`}>≈ {formatPower(plan.summary.powerKW.exact)}</small>}
      </div>
    </section>
  );
}

export function IssuePanel({ issues, index }: { issues: Issue[]; index: DatasetIndex }) {
  return (
    <div className="issues" role="alert">
      {issues.map((issue, issueIndex) => (
        <div className="issue" key={`${issue.kind}-${issueIndex}`}>
          <span className="issue__kind">{issue.kind}</span>
          <span className="issue__message">{issue.message}</span>
          <span className="issue__items">
            {issue.itemIds.map(itemId => index.items.has(itemId) && <ItemGlyph key={itemId} item={index.items.get(itemId)!} size="small" />)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DatasetChip({ dataset }: { dataset: Dataset }) {
  return (
    <span className="dataset-chip" title={dataset.source.importer}>
      <span>B{dataset.game.buildId}</span>
      <span>{dataset.recipes.length} R</span>
      <span className={dataset.source.unsupportedRecipes.length > 0 ? 'dataset-chip__warn' : undefined}>{dataset.source.unsupportedRecipes.length}!</span>
    </span>
  );
}
