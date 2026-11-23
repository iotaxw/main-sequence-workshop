# Offline Full-Station Simulation Sub-App (`offline-sim`)

蓝图工作台（`apps/station-blueprint-designer`）的独立离线子应用，**不打入浏览器前端构建产物**，直接复用与工作台 100% 同源的真物理内核（`../src/core/simulation.ts`、`geometry.ts`、`catalog.ts`、`codec.ts`），对数万建筑规模的完整空间站总图执行 5 大维度深度离线仿真与验收。

## 5 大验收维度

1. **Pass 1 · 全房间真物理实配仿真**：自动从完整总图中按模块包围盒切出全部生产细胞（50 间）与枢纽/走廊/电梯/商业街（46 间），逐间执行 `simulateBlueprint()`，强制校验 `0` 红错、`0` 异常警告与实际稳态产出/s、峰值功耗 MW。
2. **Pass 2 · 跨房间门洞与电梯接口拼接集成仿真**：截取 B1、F1（四翼）、F2 的多模块真实相邻组合进行物理联调，强制校验 `0` 正面对撞、`0` 死路、`0` 端口错配、`0` 分流漏口。
3. **Pass 3 · 宏观物品流量与 320 组大箱补货周期**：基于 Pass 1 实测稳态产出汇总全站 56 种物品的供给、全开需求、纯外部输入清单与大箱补货参考时间。
4. **Pass 4 · 分楼层与分轨道光照电力账本**：精确核算 Mk.2/Mk.3 太阳能装机、B1/F1 制造机、深空天文台、传送器与 8 座炮台在 100% / 80% / 60% / 20% 轨道光照下的电力盈余。
5. **Pass 5 · 整图结构与带线完整性体检**：全图数万建筑 `O(N)` 零重叠、零越界、合法配方、下层带配对与炮台朝外对称检查。

## 运行方式

在 `apps/station-blueprint-designer/` 目录执行：

```bash
# 仅跑终端 5 维严格门禁体检（约 2 秒）
npm run sim:offline

# 运行 5 维体检并生成离线单文件交互式 HTML 仪表盘 + JSON 快照
npm run sim:report

# 指定任意自定义大型蓝图 JSON 进行离线仿真
node offline-sim/run.mjs --bp path/to/your-station.json --report
```

生成的离线交互式体检面板位于 `offline-sim/report/latest-report.html`，双击用任意浏览器离线打开即可按楼层/关键词筛选查看每间房的实测流量与电力状态，无需启动任何本地服务器。
