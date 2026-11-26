import React from 'react';
import { useI18n } from '../core/i18n';

interface HelpDrawerProps {
  open: boolean;
  onClose: () => void;
}

const KEY_GROUPS_ZH = [
  {
    title: '视角与楼层',
    items: [
      ['右键拖 / 短按', '3D 旋转 / 取消工具与选区'],
      ['中键 / WASD / 空格+拖', '平移画布'],
      ['滚轮 / ` / Tab / 双击模块', '缩放 / 空间站 ↔ 建筑视野'],
      ['E / Q / Shift+滚轮', '升降楼层'],
      ['V / G / H', '上层隐透 / 视角吸附 / 无 UI 预览'],
      ['Home / Shift+Home', '适配整站 / 聚焦选中'],
    ],
  },
  {
    title: '选择与搬移',
    items: [
      ['悬停实体', '查看物品、配方、规格与体检提示'],
      ['左键 / Shift / Alt+左键', '单选 / 加选 / 减选'],
      ['左键 / Shift / Alt+拖', '框选 / 加选 / 减选'],
      ['X（点 / 扫 / Shift+拖）', '拆除（可撤销）'],
      ['B', '框选层域（当前 / 可见 / 全部）'],
      ['Ctrl+X / C / V', '剪切搬移 / 复制 / 粘贴'],
      ['O / Del', '选整条传送带 / 删除选中'],
    ],
  },
  {
    title: '建造与拉带',
    items: [
      ['1 ~ 9 / Tab', '选分组 / 组内换型（Shift 反向）'],
      ['左键起止（传送带）', 'L 拉带 · 中键锚点 · ⌫ 退步'],
      ['Shift+左键起止', '手绘拉带（⌫ 退格）'],
      ['F / R / T / Alt', '换角 / 转向（不反向） / 地下 / 反向'],
      ['T（待命）', '传送带 ↔ 同级地下带'],
      ['R / F（Shift 反向/垂直）', '旋转 90° / 镜像（蓝图 · 选区 · 预览）'],
      ['C / 中键短按', '吸管复制机器配置'],
    ],
  },
  {
    title: '蓝图与系统',
    items: [
      ['L', '打开 / 关闭蓝图库'],
      ['Ctrl+S', '保存蓝图或选区'],
      ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'],
      ['拖入 .sav / .json', '直接导入画布'],
      ['右键短按 / Esc', '关闭弹窗 / 取消'],
      ['F1 / ?', '快捷键'],
    ],
  },
];

const KEY_GROUPS_EN = [
  {
    title: 'Camera & Floors',
    items: [
      ['RMB Drag / Click', 'Orbit 3D / Cancel tool & selection'],
      ['MMB / WASD / Space+Drag', 'Pan canvas'],
      ['Wheel / ` / Tab / Dbl-Click', 'Zoom / Station ↔ Building view'],
      ['E / Q / Shift+Wheel', 'Step floor up / down'],
      ['V / G / H', 'Hide upper floors / Snap camera / Clean View'],
      ['Home / Shift+Home', 'Fit station / Focus selection'],
    ],
  },
  {
    title: 'Select & Edit',
    items: [
      ['Hover Entity', 'Inspect item, recipe, specs & check notes'],
      ['LMB / Shift / Alt+Click', 'Select / Add / Subtract'],
      ['LMB / Shift / Alt+Drag', 'Box select / Add / Subtract'],
      ['X (Click / Sweep / Shift+Drag)', 'Demolish (undoable)'],
      ['B', 'Box layer scope (Focus / Visible / All)'],
      ['Ctrl+X / C / V', 'Cut & Move / Copy / Paste'],
      ['O / Del', 'Select belt chain / Delete'],
    ],
  },
  {
    title: 'Build & Belts',
    items: [
      ['1–9 / Tab', 'Pick group / Cycle variant (Shift reverse)'],
      ['LMB Start → End (Belt)', 'L-route · MMB anchor · ⌫ undo'],
      ['Shift+LMB Start → End', 'Freehand belt (⌫ undo)'],
      ['F / R / T / Alt', 'Corner / End dir (no rev) / Tunnel / Rev'],
      ['T (Idle)', 'Toggle belt ↔ underground'],
      ['R / F (Shift CCW / V)', 'Rotate 90° / Mirror (BP · Sel · Preview)'],
      ['C / MMB Click', 'Eyedropper with full config'],
    ],
  },
  {
    title: 'Blueprints & App',
    items: [
      ['L', 'Toggle Blueprint Library'],
      ['Ctrl+S', 'Save blueprint or selection'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
      ['Drop .sav / .json', 'Import onto canvas'],
      ['RMB Click / Esc', 'Close modal / Cancel'],
      ['F1 / ?', 'Shortcuts'],
    ],
  },
];

export const HelpDrawer: React.FC<HelpDrawerProps> = ({ open, onClose }) => {
  const { isEn, t } = useI18n();
  if (!open) return null;

  const groups = isEn ? KEY_GROUPS_EN : KEY_GROUPS_ZH;

  return (
    <div className="cad-help-overlay" onClick={onClose}>
      <div className="cad-help-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <div className="panel-title-wrap">
            <span className="panel-tag">HELP</span>
            <span className="panel-title">{t('快捷键', 'Shortcuts')}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title={t('关闭 (Esc)', 'Close (Esc)')}>×</button>
        </div>

        <div className="help-body">
          <section className="help-section">
            <div className="help-grid">
              {groups.map((group) => (
                <div key={group.title} className="help-card">
                  <div className="help-card-title">{group.title}</div>
                  <div className="help-rows">
                    {group.items.map(([key, desc]) => (
                      <div key={key} className="help-row">
                        <kbd className="cad-kbd">{key}</kbd>
                        <span className="help-desc">{desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="help-section help-meta">
            <ul>
              <li>
                <code>Main Sequence Build 26639889</code> ·{' '}
                {t('27 模块 · 36 建筑 · 83 配方', '27 Modules · 36 Buildings · 83 Recipes')}
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
