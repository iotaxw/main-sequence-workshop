import React from 'react';

interface HelpDrawerProps {
  open: boolean;
  onClose: () => void;
}

const KEY_GROUPS = [
  {
    title: '视角与楼层',
    items: [
      ['右键拖拽', '旋转 / 俯仰视角'],
      ['中键 / WASD / 空格+拖', '平移视野'],
      ['滚轮 / ` / Tab', '切换空间站 ↔ 建筑视野'],
      ['E / Q', '升降楼层 L'],
      ['V / G', '切换上层隐透 / 视角吸附'],
      ['Home / F', '适配整站 / 聚焦选中'],
    ],
  },
  {
    title: '选择与搬移',
    items: [
      ['左键 / Shift+左键', '单选 / 多选'],
      ['左键 / Shift+拖', '实时高亮框选（Alt 减选）'],
      ['X 后 Shift+拖', '红色实时高亮框选拆除'],
      ['B', '切换框选层域'],
      ['Ctrl+X', '剪切搬移（连带内部建筑）'],
      ['Ctrl+C / Ctrl+V', '复制盖章 / 唤出剪贴板'],
      ['O / Del', '选整条传送带 / 删除'],
    ],
  },
  {
    title: '建造与拉带',
    items: [
      ['1 ~ 9 / Tab', '选分组 / 组内换型'],
      ['左键拖拽（传送带）', '自动转弯铺带'],
      ['Shift+拖（传送带）', 'L 形规划（R 切拐 · Alt 反向）'],
      ['R / Shift+R', '顺 / 逆时针旋转'],
      ['M', '镜像蓝图 / 翻转装甲'],
      ['C / X', '吸管复制 / 拆除刷'],
    ],
  },
  {
    title: '蓝图与系统',
    items: [
      ['L', '打开 / 关闭缩略图蓝图库'],
      ['Ctrl+S', '保存选区或当前蓝图'],
      ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'],
      ['拖入 .sav / .json', '直接导入画布'],
      ['右键 / Esc', '关闭弹窗 / 取消工具与选区'],
      ['F1 / ?', '快捷键帮助'],
    ],
  },
];

export const HelpDrawer: React.FC<HelpDrawerProps> = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div className="cad-help-overlay" onClick={onClose}>
      <div className="cad-help-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <div className="panel-title-wrap">
            <span className="panel-tag">HELP</span>
            <span className="panel-title">快捷键</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭 (Esc)">×</button>
        </div>

        <div className="help-body">
          <section className="help-section">
            <div className="help-grid">
              {KEY_GROUPS.map((group) => (
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
              <li>目录：<code>Main Sequence Build 26639889</code>（27 模块 · 36 建筑 · 83 配方）</li>
              <li>规范：<code>2×2 B</code> 二层回字形挑台可建 · 超算/生长舱 <code>7×7</code> · 跨层由 <code>1×1 / 2×2 电梯</code> 承载</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
