import { useEffect, useMemo, useRef, useState } from 'react';
import datasetJson from '../data/main-sequence-26639889.dataset.json';
import { defaultExternalInputItemIds, indexDataset } from './core/dataset';
import { Rational } from './core/rational';
import { solvePlan } from './core/solver';
import type { Dataset, Fork, InvalidPlan, Issue, Language, PlanResult } from './core/types';
import { loadPlan, savePlan } from './plan-storage';
import {
  DatasetChip,
  ForkPopover,
  IssuePanel,
  ItemGlyph,
  ItemPicker,
  RecipeGrid,
  SummaryStrip,
  UiIcon,
} from './ui/components';
import { feasibleRecycleOptions, resolveProduceForks, type FeasibleRecycleOption } from './ui/default-recipes';
import { entityName, label, LanguageContext, type LabelKey } from './ui/language';

const dataset = datasetJson as Dataset;
const index = indexDataset(dataset);
const defaultInputs = defaultExternalInputItemIds(dataset);
const defaultInputKey = [...defaultInputs].sort().join(',');
const craftableItems = dataset.items.filter(item => (index.recipesByOutput.get(item.id)?.length ?? 0) > 0);
const itemOrder = new Map(dataset.items.map((item, order) => [item.id, order]));

interface OpenForkState {
  fork: Fork;
  anchorEl: HTMLElement | null;
}

function fillDefaultProduceRecipes(
  targetItemId: string | null,
  ratePerMin: string,
  inputItemIds: string[],
  recipeByItem: Record<string, string>,
  recycleItemIds: string[],
  recycleByItem: Record<string, string>,
): Record<string, string> {
  if (!targetItemId) return recipeByItem;
  try {
    Rational.parse(ratePerMin);
  } catch {
    return recipeByItem;
  }
  return resolveProduceForks(dataset, index, {
    target: { itemId: targetItemId, ratePerMin },
    inputItemIds,
    recipeByItem,
    recycleItemIds,
    recycleByItem,
  });
}

export default function App() {
  const [initial] = useState(() => loadPlan(dataset));
  const [language, setLanguage] = useState<Language>(initial.plan.language ?? 'zh-Hans');
  const [storageIssues, setStorageIssues] = useState<Issue[]>(initial.issues);
  const [targetItemId, setTargetItemId] = useState<string | null>(initial.plan.targetItemId);
  const [ratePerMin, setRatePerMin] = useState(initial.plan.ratePerMin);
  const [inputItemIds, setInputItemIds] = useState<string[]>(initial.plan.inputItemIds);
  const [recipeByItem, setRecipeByItem] = useState<Record<string, string>>(() =>
    fillDefaultProduceRecipes(
      initial.plan.targetItemId,
      initial.plan.ratePerMin,
      initial.plan.inputItemIds,
      initial.plan.recipeByItem,
      initial.plan.recycleItemIds,
      initial.plan.recycleByItem,
    ),
  );
  const [recycleItemIds, setRecycleItemIds] = useState<string[]>(initial.plan.recycleItemIds);
  const [recycleByItem, setRecycleByItem] = useState<Record<string, string>>(initial.plan.recycleByItem);
  const [picker, setPicker] = useState<'target' | 'input' | null>(null);
  const [openFork, setOpenFork] = useState<OpenForkState | null>(null);
  const firstSave = useRef(true);

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
      schemaVersion: 2,
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

  const effectiveRecipes = plan?.status === 'pending-forks' || plan?.status === 'solved'
    ? plan.recipeByItem
    : recipeByItem;
  const effectiveRecycles = plan?.status === 'pending-forks' || plan?.status === 'solved'
    ? plan.recycleByItem
    : recycleByItem;
  const activeForkState: OpenForkState | null = openFork
    ?? (plan?.status === 'pending-forks' ? { fork: plan.fork, anchorEl: null } : null);
  const target = targetItemId ? index.items.get(targetItemId) : undefined;

  const feasibleRecycleByItem = useMemo(() => {
    const map = new Map<string, FeasibleRecycleOption[]>();
    if (!targetItemId || plan?.status !== 'solved') return map;
    const candidateByproducts = new Set<string>([
      ...plan.byproducts.map(flow => flow.itemId),
      ...Object.keys(plan.recycleByItem),
    ]);
    const currentInput = {
      target: { itemId: targetItemId, ratePerMin },
      inputItemIds,
      recipeByItem: effectiveRecipes,
      recycleItemIds,
      recycleByItem: effectiveRecycles,
    };
    for (const itemId of candidateByproducts) {
      map.set(itemId, feasibleRecycleOptions(dataset, index, currentInput, plan, itemId));
    }
    return map;
  }, [targetItemId, ratePerMin, inputItemIds, effectiveRecipes, recycleItemIds, effectiveRecycles, plan]);

  function applyResolvedRecipes(
    nextTarget: string | null,
    nextInputs: string[],
    nextRecipes: Record<string, string>,
    nextRecycleIds = recycleItemIds,
    nextRecycles = recycleByItem,
  ) {
    setRecipeByItem(
      fillDefaultProduceRecipes(nextTarget, ratePerMin, nextInputs, nextRecipes, nextRecycleIds, nextRecycles),
    );
  }

  function selectFork(recipeId: string) {
    if (!activeForkState) return;
    const { fork } = activeForkState;
    if (fork.kind === 'produce') {
      const nextRecipes = { ...effectiveRecipes, [fork.itemId]: recipeId };
      applyResolvedRecipes(targetItemId, inputItemIds, nextRecipes);
    } else {
      const option = feasibleRecycleByItem.get(fork.itemId)?.find(candidate => candidate.recipeId === recipeId);
      if (option?.removeExternalItemId) {
        const nextInputs = inputItemIds.filter(id => id !== option.removeExternalItemId);
        const nextRecycleIds = recycleItemIds.filter(id => id !== fork.itemId);
        const nextRecycles = { ...recycleByItem };
        delete nextRecycles[fork.itemId];
        setInputItemIds(nextInputs);
        setRecycleItemIds(nextRecycleIds);
        setRecycleByItem(nextRecycles);
        applyResolvedRecipes(targetItemId, nextInputs, effectiveRecipes, nextRecycleIds, nextRecycles);
      } else {
        const nextRecycleIds = recycleItemIds.includes(fork.itemId) ? recycleItemIds : [...recycleItemIds, fork.itemId];
        const nextRecycles = { ...effectiveRecycles, [fork.itemId]: recipeId };
        setRecycleItemIds(nextRecycleIds);
        setRecycleByItem(nextRecycles);
        applyResolvedRecipes(targetItemId, inputItemIds, effectiveRecipes, nextRecycleIds, nextRecycles);
      }
    }
    setOpenFork(null);
  }

  function openProduceFork(itemId: string, anchorEl: HTMLElement) {
    if (openFork?.fork.kind === 'produce' && openFork.fork.itemId === itemId) {
      setOpenFork(null);
      return;
    }
    setOpenFork({
      fork: {
        itemId,
        kind: 'produce',
        recipeIds: index.recipesByOutput.get(itemId)?.map(recipe => recipe.id) ?? [],
      },
      anchorEl,
    });
  }

  function openRecycleFork(itemId: string, anchorEl: HTMLElement) {
    if (openFork?.fork.kind === 'recycle' && openFork.fork.itemId === itemId) {
      setOpenFork(null);
      return;
    }
    const options = feasibleRecycleByItem.get(itemId) ?? [];
    if (options.length === 0) return;
    setOpenFork({
      fork: {
        itemId,
        kind: 'recycle',
        recipeIds: options.map(option => option.recipeId),
      },
      anchorEl,
    });
  }

  function removeRecycle(itemId: string) {
    const nextRecycleIds = recycleItemIds.filter(id => id !== itemId);
    const nextRecycles = { ...recycleByItem };
    delete nextRecycles[itemId];
    setRecycleItemIds(nextRecycleIds);
    setRecycleByItem(nextRecycles);
    setOpenFork(null);
  }

  function updateInputs(nextInputs: string[], resetRecycles = false) {
    const nextRecycleIds = resetRecycles ? [] : recycleItemIds;
    const nextRecycles = resetRecycles ? {} : recycleByItem;
    setInputItemIds(nextInputs);
    if (resetRecycles) {
      setRecycleItemIds([]);
      setRecycleByItem({});
    }
    applyResolvedRecipes(targetItemId, nextInputs, recipeByItem, nextRecycleIds, nextRecycles);
    setOpenFork(null);
  }

  function markExternalInput(itemId: string) {
    if (itemId === targetItemId || inputItemIds.includes(itemId)) return;
    updateInputs([...inputItemIds, itemId]);
  }

  const isDefaultInputs = [...inputItemIds].sort().join(',') === defaultInputKey;

  const t = (key: LabelKey) => label(key, language);
  const activeForkRecipeId = activeForkState
    ? (activeForkState.fork.kind === 'produce'
      ? effectiveRecipes[activeForkState.fork.itemId]
      : effectiveRecycles[activeForkState.fork.itemId])
    : undefined;

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
            <div className="control__inputs-head">
              <span className="field-label">{t('externalInputs')}</span>
              {!isDefaultInputs && (
                <button
                  className="reset-inputs"
                  onClick={() => updateInputs(defaultInputs, true)}
                  title={t('resetInputs')}
                  aria-label={t('resetInputs')}
                >
                  <UiIcon name="recycle" size={12} />
                  <span>{t('resetInputs')}</span>
                </button>
              )}
            </div>
            <div className="input-set">
              {[...inputItemIds].sort((left, right) => (itemOrder.get(left) ?? -1) - (itemOrder.get(right) ?? -1)).map(itemId => {
                const item = index.items.get(itemId)!;
                return (
                  <button className="input-chip" key={itemId} onClick={() => updateInputs(inputItemIds.filter(id => id !== itemId))} title={`${entityName(item, language)}：${t('removeInput')}`} aria-label={`${entityName(item, language)}：${t('removeInput')}`}>
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
              activeRecycleItemId={openFork?.fork.kind === 'recycle' ? openFork.fork.itemId : null}
              canRecycleItem={itemId => (feasibleRecycleByItem.get(itemId)?.length ?? 0) > 0}
              onOpenRecycle={openRecycleFork}
            />
            <RecipeGrid
              rows={plan.rows}
              index={index}
              targetItemId={targetItemId}
              activeForkItemId={openFork?.fork.kind === 'produce' ? openFork.fork.itemId : null}
              onSwitch={openProduceFork}
              onMarkExternal={markExternalInput}
            />
          </div>
        )}

        {activeForkState && (
          <ForkPopover
            fork={activeForkState.fork}
            index={index}
            activeRecipeId={activeForkRecipeId}
            anchorEl={activeForkState.anchorEl}
            onSelect={selectFork}
            onRemoveRecycle={activeForkState.fork.kind === 'recycle' ? () => removeRecycle(activeForkState.fork.itemId) : undefined}
            onClose={() => setOpenFork(null)}
          />
        )}

        {picker && (
          <ItemPicker
            items={picker === 'target' ? craftableItems : dataset.items}
            onClose={() => setPicker(null)}
            onSelect={itemId => {
              if (picker === 'target') {
                const nextInputs = inputItemIds.includes(itemId)
                  ? inputItemIds.filter(id => id !== itemId)
                  : inputItemIds;
                setTargetItemId(itemId);
                if (nextInputs !== inputItemIds) {
                  setInputItemIds(nextInputs);
                }
                applyResolvedRecipes(itemId, nextInputs, recipeByItem);
                setOpenFork(null);
              } else {
                const nextInputs = inputItemIds.includes(itemId) ? inputItemIds : [...inputItemIds, itemId];
                updateInputs(nextInputs);
              }
              setPicker(null);
            }}
          />
        )}
      </main>
    </LanguageContext.Provider>
  );
}
