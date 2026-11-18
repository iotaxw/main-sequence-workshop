import { createContext, useContext } from 'react';
import type { ItemDefinition, Language, MachineDefinition } from '../core/types';

const labels = {
  appTitle: { 'zh-Hans': '产线配平器', en: 'Line Balancer' },
  target: { 'zh-Hans': '目标', en: 'Target' },
  addInput: { 'zh-Hans': '添加外部输入', en: 'Add external input' },
  removeInput: { 'zh-Hans': '点击移出外部输入', en: 'Click to remove from external inputs' },
  production: { 'zh-Hans': '生产线', en: 'Production' },
  tier: { 'zh-Hans': '层级', en: 'Tier' },
  summary: { 'zh-Hans': '汇总', en: 'Summary' },
  targetRate: { 'zh-Hans': '目标每分钟速率', en: 'Target rate per minute' },
  selectTarget: { 'zh-Hans': '选择目标物品', en: 'Select target item' },
  searchItems: { 'zh-Hans': '搜索物品', en: 'Search items' },
  close: { 'zh-Hans': '关闭', en: 'Close' },
  switchRecipe: { 'zh-Hans': '切换配方', en: 'Switch recipe' },
  selectProduce: { 'zh-Hans': '选择生产配方', en: 'Select production recipe' },
  selectRecycle: { 'zh-Hans': '选择副产消费配方', en: 'Select byproduct consumer' },
  recycle: { 'zh-Hans': '选择回流配方', en: 'Select recycling recipe' },
  removeRecycle: { 'zh-Hans': '取消回流', en: 'Remove recycling' },
  iconFailed: { 'zh-Hans': '图标加载失败', en: 'Icon failed to load' },
  cycle: { 'zh-Hans': '回环', en: 'Cycle' },
  powerMissing: { 'zh-Hans': '耗电数据缺失', en: 'Power data missing' },
  externalInputs: { 'zh-Hans': '外部输入', en: 'External inputs' },
  totalMachines: { 'zh-Hans': '总建设机器', en: 'Machines built' },
  totalPower: { 'zh-Hans': '总耗电', en: 'Power' },
  byproductOutputs: { 'zh-Hans': '净副产', en: 'Net byproducts' },
  duration: { 'zh-Hans': '执行时间', en: 'Duration' },
  continuous: { 'zh-Hans': '连续', en: 'Continuous' },
} as const;

export type LabelKey = keyof typeof labels;

export const LanguageContext = createContext<{
  language: Language;
  t: (key: LabelKey) => string;
}>({
  language: 'zh-Hans',
  t: key => labels[key]['zh-Hans'],
});

export function useLanguage() {
  return useContext(LanguageContext);
}

export function entityName(entity: ItemDefinition | MachineDefinition, language: Language): string {
  return entity.localizedNames[language];
}

export function label(key: LabelKey, language: Language): string {
  return labels[key][language];
}
