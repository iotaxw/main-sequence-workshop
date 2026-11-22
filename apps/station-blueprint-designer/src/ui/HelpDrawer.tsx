import React from 'react';

interface HelpDrawerProps {
  open: boolean;
  onClose: () => void;
}

const KEY_GROUPS = [
  {
    title: '镜头、视角与楼层',
    items: [
      ['右键拖拽', '旋转 / 俯仰 3D 视角（开启吸附时松手自动对齐 4 正交向与固定俯角）'],
      ['G', '切换「方向与俯角自动吸附 / 完全自由无级旋转」'],
      ['中键拖 / WASD / 空格+左键', '平移视野（自动对齐当前屏幕朝向）'],
      ['鼠标滚轮', '围绕光标连续缩放；越过阈值自动在「空间站视野 ↔ 建筑视野」切换'],
      ['` / 选择态 Tab / 双击', '在「空间站视野」与「建筑视野」间直接切换并平滑缩放'],
      ['E / Q', '升高 / 降低当前焦点楼层 L（两套视野共用 8m 空间站楼层轴）'],
      ['V', '切换「隐藏焦点以上楼层 / 半透明线稿透视上层」'],
      ['Home / F', '适配整站视野 / 聚焦当前选中对象'],
    ],
  },
  {
    title: '选择与多层框选（shapez 2 风格）',
    items: [
      ['左键点击 / Shift+左键', '单选 / 追加或取消多选'],
      ['左键空白拖拽', '框选（Shift+拖 追加，Alt+拖 减选；3D 框选体显示实际跨层范围）'],
      ['B', '切换多层框选域：仅当前焦点层 → 当前可见层 → 全部楼层'],
      ['短按右键 / Esc', '取消当前建造工具、放下幽灵蓝图或取消选中'],
      ['O', '选中与当前传送带/分流器/地下带相连的整条物流链'],
      ['Delete / Backspace', '删除当前选中项'],
    ],
  },
  {
    title: '建筑放置与智能拉带',
    items: [
      ['1 ~ 9', '选择底部对应建筑/模块分组（弹出组内菜单，重复按亦可轮换）'],
      ['Tab / Shift+Tab（建造态）', '在当前激活分组内顺/逆序轮换变体（类 shapez 2 手感）'],
      ['左键拖拽（传送带）', '连续铺带自动拐弯、无缝跨门洞、直接覆盖同格旧传送带'],
      ['Shift + 拖拽（传送带）', 'Belt Planner 自动 L 形路径规划；途中按 R 切拐向、Alt 反向'],
      ['R / Shift+R', '顺时针 / 逆时针旋转预览、蓝图或选中建筑'],
      ['M', '水平镜像翻转当前持有的幽灵蓝图'],
      ['C / 中键单击对象', '吸管工具：完整复制悬停模块或建筑的类型、朝向、配方、标注与端口开关状态'],
      ['X', '切换快捷拆除刷（按住左键扫过即拆）'],
    ],
  },
  {
    title: '蓝图流转与本地文件夹',
    items: [
      ['Ctrl+C / Ctrl+X', '复制 / 剪切选中内容并立即化作幽灵蓝图跟随光标盖章'],
      ['Ctrl+V', '重新唤出最近一次复制的幽灵蓝图'],
      ['Shift + 左键（盖章）', '强制覆盖粘贴（自动替换冲突的现有建筑）'],
      ['Ctrl+S', '有选区时将选区保存为新蓝图进文件夹；无选区时保存当前画布'],
      ['Ctrl+Z / Ctrl+Shift+Z', '事务式撤销 / 重做（另支持 Ctrl+Y）'],
      ['蓝图库单击 / 双击', '单击直接拿去盖章粘贴；双击打开为独立画布编辑'],
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
            <span className="panel-title">操作快捷键与规划器说明</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="help-body">
          <section className="help-section">
            <h3 className="help-h3">操作快捷键</h3>
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
            <h3 className="help-h3">数据来源与设计边界</h3>
            <ul>
              <li>全量空间站模块（26 种）、建筑与物流件（36 种）及配方（83 条）均只读提取自本机 <code>Main Sequence Build 26639889</code>。</li>
              <li>经二进制核验：<code>2×2 B</code> 在 <code>L+1</code> 层具备四周 3 格宽回字形可建挑台；<code>超级计算机</code> 与 <code>生长舱</code> 真实占地均为 <code>7×7</code>；建筑内部无垂直传送带，跨层物流由 <code>电梯 1×1 / 2×2</code> 承载。</li>
              <li>本规划器专注离线空间布局、配方与端口规划标注，不做物流仿真、产线配平或游戏存档修改。</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
