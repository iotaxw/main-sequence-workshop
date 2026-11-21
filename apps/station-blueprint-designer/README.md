# 空间站蓝图规划器（Station Blueprint Designer）

《主星序 Main Sequence》的离线 3D 空间站蓝图规划器：深色精密 CAD 线稿风、扁平平台抽象、shapez 2 风格交互与本地文件夹蓝图库。

- **在线打开（GitHub Pages）**：https://iotaxw.github.io/main-sequence-workshop/station-blueprint-designer/

## 主要功能

- **3D 暗色精密 CAD 视角**：默认正上方微倾斜俯视（64°），右键拖拽旋转支持四正交朝向与固定俯角吸附（`G` 开关自由无级旋转）；滚轮带滞回阈值自动切换「空间站视野 ↔ 建筑视野」（或按 `Tab` / 双击模块）；`E / Q` 升降 8m 统一空间站楼层，`V` 切换隐藏或半透明透视焦点以上层。
- **扁平平台抽象 & 局部圆角地面格**：空间站抽象为扁平平台薄板，仅保留可建地板与接口；默认背景干净不密密麻麻，悬停、放置、拉带与框选时仅在当前作用范围柔和浮现圆角矩形地面格矩阵。
- **shapez 2 风格建造与多层交互**：左键点选、`Shift+左键` 多选、左键空白框选（`B` 切换当前层/可见层/全部层跨层框选）、短按右键/`Esc` 取消选中或工具；传送带连续拖拽自动转弯与即时覆盖、`Shift+拖` Belt Planner 自动 L 形规划（`R` 切拐、`Alt` 反向）、`O` 选中整条连通带、`C`/中键吸管、`X` 拆除刷、`Ctrl+C/X/V` 幽灵蓝图、`R` 旋转、`M` 镜像、`Ctrl+Z / Ctrl+Shift+Z` 撤销重做。
- **本地文件夹蓝图库（统一格式）**：基于浏览器 File System Access API 可直接挂载本机文件夹读写子目录与 `.json` 蓝图（在 HTTPS GitHub Pages 或 `localhost` 均可直接使用；不支持的浏览器自动降级为内置离线目录 + JSON 导入/导出）。库内蓝图**单击即化作幽灵跟随光标盖章粘贴**，**双击作为独立画布打开编辑**。
- **全量目录与配方/端口规划**：内置 Build `26639889` 全部 26 种空间站模块（含 `2×2 B` 二层 3 格宽回字形可建挑台）、36 种建筑与物流件（含真实 `7×7` 超级计算机与生长舱）及 83 条中英文配方；选中建筑可配置配方、规划标注与单个端口活跃（亮绿）/禁用（暗红）状态，不做物流仿真或产线配平。视图右上角提供 `Help / 快捷键` 面板。

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

生产构建与本地离线预览：

```bash
npm test
npm run build
npm run preview
```

执行后在浏览器打开终端显示的 `http://localhost:...` 地址即可离线使用，并可点击左侧「挂载本地文件夹」直接管理本机蓝图目录。

## 许可与声明

原创代码与文档遵循仓库根目录 [MIT License](../../LICENSE)。`src/data/catalog-26639889.json` 中的游戏名称、模块、建筑与配方元数据属于第三方游戏数据，不在 MIT 授权范围内，详见 [NOTICE](../../NOTICE)。
