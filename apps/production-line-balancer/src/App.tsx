import { useEffect, useMemo, useRef, useState } from 'react';
import datasetJson from '../data/main-sequence-26639889.dataset.json';
import { indexDataset } from './core/dataset';
import { Rational } from './core/rational';
import { solvePlan } from './core/solver';
import type { Dataset, Fork, InvalidPlan, Issue, Language, PlanResult } from './core/types';
import { loadPlan, savePlan } from './plan-storage';
import {
  DatasetChip,
  ForkPicker,
  IssuePanel,
  ItemGlyph,
  ItemPicker,
  RecipeGrid,
  SummaryStrip,
  UiIcon,
} from './ui/components';
import { entityName, label, LanguageContext, type LabelKey } from './ui/language';

const dataset = datasetJson as Dataset;
const index = indexDataset(dataset);
const itemOrder = new Map(dataset.items.map((item, order) => [item.id, order]));

export default function App() {
  const [initial] = useState(() => loadPlan(dataset));
  const [language, setLanguage] = useState<Language>(initial.plan.language ?? 'zh-Hans');
  const [storageIssues, setStorageIssues] = useState<Issue[]>(initial.issues);
  const [targetItemId, setTargetItemId] = useState<string | null>(initial.plan.targetItemId);
  const [ratePerMin, setRatePerMin] = useState(initial.plan.ratePerMin);
  const [inputItemIds, setInputItemIds] = useState<string[]>(initial.plan.inputItemIds);
  const [recipeByItem, setRecipeByItem] = useState<Record<string, string>>(initial.plan.recipeByItem);
  const [recycleItemIds, setRecycleItemIds] = useState<string[]>(initial.plan.recycleItemIds);
  const [recycleByItem, setRecycleByItem] = useState<Record<string, string>>(initial.plan.recycleByItem);
  const [picker, setPicker] = useState<'target' | 'input' | null>(null);
  const [manualFork, setManualFork] = useState<Fork | null>(null);
  const firstSave = useRef(true);
  const forkSlot = useRef<HTMLDivElement>(null);

  const plan = useMemo<PlanResult | null>(() => {
    if (!targetItemId) return null;
    try {
      Rational.parse(ratePerMin);
    } catch {
      return {
        status: 'invalid',
        issues: [{ kind: 'invalid-value', message: '目标速率格式无效', itemIds: [targetItemId], recipeIds: [] }],
      } satisfies InvalidPlan;
    }
    return solvePlan(dataset, index, {
      target: { itemId: targetItemId, ratePerMin },
      inputItemIds,
      recipeByItem,
      recycleItemIds,
      recycleByItem,
    });
  }, [targetItemId, ratePerMin, inputItemIds, recipeByItem, recycleItemIds, recycleByItem]);

  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
    } else {
      setStorageIssues([]);
    }
    savePlan({
      schemaVersion: 1,
      datasetBuildId: dataset.game.buildId,
      language,
      targetItemId,
      ratePerMin,
      inputItemIds,
      recipeByItem,
      recycleItemIds,
      recycleByItem,
    });
  }, [language, targetItemId, ratePerMin, inputItemIds, recipeByItem, recycleItemIds, recycleByItem]);

  useEffect(() => {
    if (manualFork) forkSlot.current?.scrollIntoView({ block: 'nearest' });
  }, [manualFork]);

  const activeFork = manualFork ?? (plan?.status === 'pending-forks' ? plan.fork : null);
  const effectiveRecipes = plan?.status === 'pending-forks' || plan?.status === 'solved'
    ? plan.recipeByItem
    : recipeByItem;
  const effectiveRecycles = plan?.status === 'pending-forks' || plan?.status === 'solved'
    ? plan.recycleByItem
    : recycleByItem;
  const target = targetItemId ? index.items.get(targetItemId) : undefined;

  function selectFork(recipeId: string) {
    if (!activeFork) return;
    if (activeFork.kind === 'produce') {
      setRecipeByItem({ ...effectiveRecipes, [activeFork.itemId]: recipeId });
    } else {
      setRecycleItemIds(previous => previous.includes(activeFork.itemId) ? previous : [...previous, activeFork.itemId]);
      setRecycleByItem({ ...effectiveRecycles, [activeFork.itemId]: recipeId });
    }
    setManualFork(null);
  }

  function switchRecipe(itemId: string) {
    setManualFork({
      itemId,
      kind: 'produce',
      recipeIds: index.recipesByOutput.get(itemId)?.map(recipe => recipe.id) ?? [],
    });
  }

  function removeRecycle(itemId: string) {
    setRecycleItemIds(previous => previous.filter(id => id !== itemId));
    setRecycleByItem(previous => {
      const next = { ...previous };
      delete next[itemId];
      return next;
    });
  }

  const t = (key: LabelKey) => label(key, language);

  return (
    <LanguageContext.Provider value={{ language, t }}>
      <main className="app">
        <header className="topbar">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true" />
            <span className="brand__name">{t('appTitle')}</span>
          </span>
          <div className="topbar__meta">
            <DatasetChip dataset={dataset} />
            <div className="segmented" role="group" aria-label="Language">
              <button aria-pressed={language === 'zh-Hans'} onClick={() => setLanguage('zh-Hans')}>中</button>
              <button aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
            </div>
          </div>
        </header>

        <section className="panel control">
          <div className="control__goal">
            <span className="field-label">{t('target')}</span>
            <div className="goal">
              <button className="target-slot" onClick={() => setPicker('target')} data-testid="target-slot" aria-label={target ? entityName(target, language) : t('selectTarget')} title={target ? entityName(target, language) : t('selectTarget')}>
                {target ? <ItemGlyph item={target} role="target" size="large" /> : <UiIcon name="target" size={20} />}
              </button>
              <span className="goal__name">{target ? entityName(target, language) : t('selectTarget')}</span>
              <label className="rate-field">
                <input value={ratePerMin} onChange={event => setRatePerMin(event.target.value)} inputMode="decimal" aria-label={t('targetRate')} data-testid="rate-input" />
                <span>/min</span>
              </label>
            </div>
          </div>
          <div className="control__inputs">
            <span className="field-label">{t('externalInputs')}</span>
            <div className="input-set">
              {[...inputItemIds].sort((left, right) => (itemOrder.get(left) ?? -1) - (itemOrder.get(right) ?? -1)).map(itemId => {
                const item = index.items.get(itemId)!;
                return (
                  <button className="input-chip" key={itemId} onClick={() => setInputItemIds(previous => previous.filter(id => id !== itemId))} title={`${entityName(item, language)}：${t('removeInput')}`} aria-label={`${entityName(item, language)}：${t('removeInput')}`}>
                    <ItemGlyph item={item} role="raw" size="small" />
                    <span className="input-chip__remove" aria-hidden="true"><UiIcon name="close" size={12} /></span>
                  </button>
                );
              })}
              <button className="icon-button icon-button--dashed" onClick={() => setPicker('input')} aria-label={t('addInput')} title={t('addInput')}><UiIcon name="add" /></button>
            </div>
          </div>
        </section>

        {!targetItemId && (
          <button className="empty-target" onClick={() => setPicker('target')} aria-label={t('selectTarget')}>
            <UiIcon name="target" size={32} />
            <span>{t('selectTarget')}</span>
          </button>
        )}

        {(storageIssues.length > 0 || plan?.status === 'invalid') && (
          <IssuePanel issues={[...storageIssues, ...(plan?.status === 'invalid' ? plan.issues : [])]} index={index} />
        )}

        {plan?.status === 'solved' && (
          <div className="results" data-testid="results">
            <SummaryStrip
              plan={plan}
              index={index}
              onRecycle={itemId => setRecycleItemIds(previous => previous.includes(itemId) ? previous : [...previous, itemId])}
              onRemoveRecycle={removeRecycle}
            />
            <RecipeGrid rows={plan.rows} index={index} onSwitch={switchRecipe} />
          </div>
        )}

        {activeFork && (
          <div className="fork-slot" ref={forkSlot}>
            <ForkPicker fork={activeFork} index={index} onSelect={selectFork} />
          </div>
        )}

        {picker && (
        <ItemPicker
          items={dataset.items}
          onClose={() => setPicker(null)}
          onSelect={itemId => {
            if (picker === 'target') {
              setTargetItemId(itemId);
            } else {
              setInputItemIds(previous => previous.includes(itemId) ? previous : [...previous, itemId]);
            }
            setPicker(null);
          }}
        />
      )}
      </main>
    </LanguageContext.Provider>
  );
}
