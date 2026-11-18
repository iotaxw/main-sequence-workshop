import { useMemo, useState } from 'react';
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

export function RecipeCard({ row, index, onSwitch }: {
  row: RecipeRow;
  index: DatasetIndex;
  onSwitch: (itemId: string) => void;
}) {
  const { t } = useLanguage();
  const recipe = index.recipes.get(row.recipeId)!;
  const machine = index.machines.get(row.machineId)!;
  const primaryOutput = recipe.outputs.find(output => !output.isByproduct) ?? recipe.outputs[0]!;
  const hasAlternatives = (index.recipesByOutput.get(primaryOutput.itemId)?.length ?? 0) > 1;
  return (
    <article className="recipe-card" aria-label={recipe.id}>
      <div className="recipe-card__recipe">
        <RecipeFormula recipe={recipe} index={index} />
      </div>
      <div className="recipe-card__build">
        <MachineCard machine={machine} machines={row.machines} />
        <span className="recipe-card__action">
          {hasAlternatives && (
            <button className="icon-button recipe-card__switch" onClick={() => onSwitch(primaryOutput.itemId)} aria-label={t('switchRecipe')} title={t('switchRecipe')}>
              <UiIcon name="fork" />
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

export function RecipeGrid({ rows, index, onSwitch }: {
  rows: RecipeRow[];
  index: DatasetIndex;
  onSwitch: (itemId: string) => void;
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
            {group.map(row => <RecipeCard key={row.recipeId} row={row} index={index} onSwitch={onSwitch} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ForkPicker({ fork, index, onSelect }: {
  fork: Fork;
  index: DatasetIndex;
  onSelect: (recipeId: string) => void;
}) {
  const { language, t } = useLanguage();
  const item = index.items.get(fork.itemId)!;
  const heading = t(fork.kind === 'recycle' ? 'selectRecycle' : 'selectProduce');
  return (
    <section className={`panel fork-picker fork-picker--${fork.kind}`} aria-label={heading}>
      <header className="panel__head">
        <UiIcon name={fork.kind === 'recycle' ? 'recycle' : 'fork'} />
        <span className="panel__title">{heading}</span>
        <ItemGlyph item={item} role={fork.kind === 'recycle' ? 'byproduct' : 'target'} size="small" />
        <span className="fork-picker__item">{entityName(item, language)}</span>
      </header>
      <div className="card-grid" role="radiogroup" aria-label={heading}>
        {fork.recipeIds.map(recipeId => {
          const recipe = index.recipes.get(recipeId)!;
          const machine = index.machines.get(recipe.machineId)!;
          return (
            <button className="recipe-card recipe-option" key={recipe.id} onClick={() => onSelect(recipeId)} role="radio" aria-checked="false">
              <span className="recipe-card__recipe">
                <RecipeFormula recipe={recipe} index={index} />
              </span>
              <span className="recipe-card__build">
                <span className="machine-card">
                  <MachineGlyph machine={machine} />
                  <span className="machine-card__name">{entityName(machine, language)}</span>
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

export function SummaryStrip({ plan, index, onRecycle, onRemoveRecycle }: {
  plan: SolvedPlan;
  index: DatasetIndex;
  onRecycle: (itemId: string) => void;
  onRemoveRecycle: (itemId: string) => void;
}) {
  const { language, t } = useLanguage();
  const machines = plan.summary.machines;
  const exactMachines = formatExactMachine(machines.exact);
  const machineDescription = language === 'en'
    ? `Built ${machines.built}, continuous ${exactMachines}`
    : `建设 ${machines.built} 台，连续 ${exactMachines} 台`;
  const orphanRecycles = Object.keys(plan.recycleByItem).filter(itemId => !plan.byproducts.some(flow => flow.itemId === itemId));
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
      {(plan.byproducts.length > 0 || orphanRecycles.length > 0) && (
        <div className="metric metric--flows">
          <span className="metric__label">{t('byproductOutputs')}{plan.byproducts.length > 0 && <span className="metric__unit">/min</span>}</span>
          <div className="metric__flows">
            {plan.byproducts.map(flow => {
              const active = plan.recycleByItem[flow.itemId] !== undefined;
              return (
                <span className="flow-chip flow-chip--byproduct" key={flow.itemId}>
                  <ItemGlyph item={index.items.get(flow.itemId)!} role="byproduct" size="small" />
                  <RateValue value={flow.ratePerMin} />
                  <button className={`recycle-toggle${active ? ' recycle-toggle--on' : ''}`} onClick={() => active ? onRemoveRecycle(flow.itemId) : onRecycle(flow.itemId)} aria-label={t(active ? 'removeRecycle' : 'recycle')} aria-pressed={active} title={t(active ? 'removeRecycle' : 'recycle')}>
                    <UiIcon name="recycle" size={12} />
                  </button>
                </span>
              );
            })}
            {orphanRecycles.map(itemId => (
              <button className="flow-chip flow-chip--byproduct recycle-toggle--on" key={itemId} onClick={() => onRemoveRecycle(itemId)} title={t('removeRecycle')} aria-label={t('removeRecycle')} aria-pressed="true">
                <ItemGlyph item={index.items.get(itemId)!} role="byproduct" size="small" />
                <UiIcon name="recycle" size={12} />
              </button>
            ))}
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
