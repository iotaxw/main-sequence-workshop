# 空间站蓝图规划器（Station Blueprint Designer）

《主星序 Main Sequence》的离线 3D 空间站蓝图规划器：深色精密 CAD 线条艺术视角、shapez 2 风格交互、实时产线物流诊断、游戏原生 `.sav` ↔ JSON 双向互转，以及本地文件夹 / 内置库 / GitHub 私有云库蓝图管理。

- **在线打开（GitHub Pages）**：https://iotaxw.github.io/main-sequence-workshop/station-blueprint-designer/

## 主要功能

- **3D 暗调线条艺术视角与全量目录**：内置 Build `26639889` 全部 27 种空间站模块（含 `2×2 B` 二层 3 格宽回字形可建挑台、2/3 型竖立巨帆太阳能板、上下对称炮塔等实测比例线稿）、36 种建筑与物流件（含 `7×7` 超级计算机与生长舱）及 83 条中英文配方；默认 64° 微倾斜俯视四向吸附（`G` 开关无级旋转），滚轮滞回切换「空间站视野 ↔ 建筑视野」（或 `` ` `` / `Tab` / 双击模块），`E / Q` 升降 8m 空间站楼层，`V` 切换隐藏或半透明透视焦点以上层。
- **shapez 2 风格分组建造与多层交互**：底部紧凑分组格子菜单按 `1~9` 直达同类分组并弹出组内子栏、建造态 `Tab`/`Shift+Tab` 轮换变体；左键点选、`Shift+左键` 多选、左键空白框选（`B` 切换当前层/可见层/全部层跨层框选）、短按右键/`Esc` 取消工具；传送带连续拖拽自动转弯与覆盖、`Shift+拖` Belt Planner 自动 L 形规划（`R` 切拐、`Alt` 反向）、`O` 选中整条连通带、`C`/中键吸管、`X` 拆除刷、`Ctrl+C/X/V` 幽灵蓝图、`R` 旋转、`M` 镜像、`Ctrl+Z / Ctrl+Shift+Z` 撤销重做。
- **实时物流与产线诊断**：统一「只看产线中段问题」口径（未接原料的产线入口标黄提示，中段缺料/超载/孤带/混料标红且混料仅标混合位），支持 2×2 跨层电梯与编织地下带；点击画布黄/红标记与右侧诊断面板双向定位。
- **游戏原生 `.sav` ↔ JSON 双向互转**：内置共享 Rust/WASM 编解码核心（源码位于仓库 `packages/ms-blueprint-codec/`），顶部「游戏互转」菜单支持拖入/导入原生游戏 `.sav` 蓝图、导出原生整站 `.sav` 与 Mod 局部预设 `.preset.sav`。
- **三合一蓝图库（本地文件夹 / 内置库 / GitHub 私有云库）**：
  - **公开起步模板**：默认内置干净的 `2x2A-标准起步模板.json`；库内蓝图**单击即化作幽灵跟随光标盖章粘贴**，**双击作为独立画布打开编辑**。
  - **挂载本地文件夹**：通过浏览器 File System Access API 直接读写本机蓝图目录与 `.json` 文件（100% 离线）。
  - **私有云库（可选）**：点击左侧「私有云库」，填写个人私有 GitHub 仓库与仅授权该仓库 `Contents` 读写的 Fine-grained PAT，即可在任意设备直连 `api.github.com` 读写个人私有蓝图；Token 仅存本机浏览器 `localStorage`，点击「断开并清除 Token」会同时抹除 Token 与当前画布缓存。

## 本地克隆与离线启动指南

前置环境：Node.js 20+（推荐 Node 24）。

```bash
git clone https://github.com/iotaxw/main-sequence-workshop.git
cd main-sequence-workshop/apps/station-blueprint-designer
npm ci
```

开发模式运行（热更新）：

```bash
npm run dev
```

测试、生产构建与本地离线预览：

```bash
npm test
npm run build
npm run preview
```

执行后在浏览器打开终端显示的 `http://localhost:...` 地址即可离线使用。

## 许可与声明

原创代码与文档遵循仓库根目录 [MIT License](../../LICENSE)。`src/data/catalog-26639889.json` 及 `packages/ms-blueprint-codec/data/catalog-26639889.json` 中的游戏名称、模块、建筑与配方元数据属于第三方游戏数据，不在 MIT 授权范围内，详见 [NOTICE](../../NOTICE)。
