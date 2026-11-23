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
      ['G', '切换「四向与固定俯角吸附 / 自由无级 3D 视角」'],
      ['中键拖 / WASD / 空格+左键', '平移视野（自动对齐当前屏幕朝向）'],
      ['鼠标滚轮', '围绕光标连续缩放；越过阈值自动在「空间站视野 ↔ 建筑视野」切换'],
      ['` / 选择态 Tab / 双击', '在「空间站视野」与「建筑视野」间直接切换并平滑缩放'],
      ['E / Q', '升高 / 降低当前焦点楼层 L（两套视野共用 8m 空间站楼层轴）'],
      ['V', '切换「隐藏焦点以上楼层 / 半透明线稿透视上层」'],
      ['Home / F', '适配整站视野 / 聚焦当前选中对象'],
    ],
  },
  {
    title: '选择、搬移与复制（shapez 2 风格）',
    items: [
      ['左键点击 / Shift+左键', '单选 / 追加或取消多选（开启诊断时点击黄/红标记可双向定位问题）'],
      ['左键空白拖拽', '框选（Shift+拖 追加，Alt+拖 减选；3D 框选体显示跨层范围）'],
      ['B', '切换多层框选域：仅当前焦点层 → 当前可见层 → 全部楼层'],
      ['Ctrl+X（剪切搬移）', '连带内部建筑原子提起为幽灵蓝图，左键落位即完成搬移（Ctrl+Z 可撤销）'],
      ['Ctrl+C / Ctrl+V', '复制选中内容连续盖章 / 重新唤出最近剪贴板蓝图'],
      ['O', '选中与当前传送带/分流器/地下带相连的整条物流链'],
      ['Delete / Backspace', '删除当前选中项'],
    ],
  },
  {
    title: '建筑放置与智能拉带',
    items: [
      ['1 ~ 9', '选择底部对应建筑/模块分组（弹出组内菜单，重复按轮换变体）'],
      ['Tab / Shift+Tab（建造态）', '在当前激活分组内顺/逆序轮换变体'],
      ['左键拖拽（传送带）', '连续铺带自动拐弯、无缝跨门洞、直接覆盖同格旧传送带'],
      ['Shift + 拖拽（传送带）', 'Belt Planner 自动 L 形路径规划；途中按 R 切拐向、Alt 反向'],
      ['R / Shift+R', '顺时针 / 逆时针旋转预览、幽灵蓝图或选中建筑'],
      ['M', '水平镜像翻转当前持有的幽灵蓝图（装甲板预览态亦可按 M/F 上下翻转）'],
      ['C / 中键单击对象', '吸管工具：完整复制悬停模块或建筑的类型、朝向、配方、标注与端口状态'],
      ['X', '切换快捷拆除刷（按住左键扫过即拆）'],
    ],
  },
  {
    title: '蓝图库、互转与通用退出',
    items: [
      ['L', '打开 / 关闭俯视缩略图大蓝图库（支持目录筛选、名称搜索与拖拽归类）'],
      ['蓝图单击 / 双击', '单击抓取为幽灵蓝图盖章（Shift+左键覆盖）；双击打开为独立画布编辑'],
      ['Ctrl+S', '有选区时将选区保存为新蓝图；无选区时保存当前画布'],
      ['Ctrl+Z / Ctrl+Shift+Z', '事务式撤销 / 重做（另支持 Ctrl+Y）'],
      ['拖入 .sav / .json', '直接拖放游戏原版 Designs/*.sav 或规范 .json 到画布打开与诊断'],
      ['短按右键 / Esc', '逐层关闭弹窗/菜单 → 取消建造工具/幽灵蓝图 → 清除选区 → 关闭诊断面板'],
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
          <button type="button" className="icon-btn" onClick={onClose} title="关闭 (Esc)">×</button>
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
            <h3 className="help-h3">数据来源、互转与存储说明</h3>
            <ul>
              <li>全量空间站模块（27 种）、建筑与物流件（36 种）及配方（83 条）均只读提取自 <code>Main Sequence Build 26639889</code>，并按游戏实测比例绘制 3D 线条艺术轮廓。</li>
              <li>经二进制核验：<code>2×2 B</code> 在 <code>L+1</code> 层具备四周 3 格宽回字形可建挑台；<code>超级计算机</code> 与 <code>生长舱</code> 真实占地均为 <code>7×7</code>；跨层物流由 <code>电梯 1×1 / 2×2</code> 承载。</li>
              <li>支持实时产线与物流诊断（开放边界入口仅标黄提示，中段缺料/超载/孤带/混料精准标红）与共享 Rust/WASM 原生 <code>.sav</code> ↔ 规范 JSON 双向互转（仅在用户主动导入/导出时读写文件，绝不擅自改动游戏目录）。</li>
              <li>公开版仅内置标准起步模板，支持挂载本机蓝图文件夹或连接个人 GitHub 私有云库（Token 仅存本机浏览器，断开即同时抹除 Token 与画布缓存）。</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
