# 手工交互测试蓝图集（Canonical Blueprint JSON v2）

本目录包含 5 份由 `ms-blueprint-codec` 合成的纯测试蓝图（零玩家存档、零账号数据、零游戏资产），用于在新机器 `git clone` 后一键播种验证全部局部蓝图功能与交互路径。

执行以下命令即可自动编译 `ms-blueprint-codec.exe` 并将本目录全部蓝图写入本机游戏目录（不修改游戏安装文件）：

```powershell
pwsh -NoProfile -File apps/station-section-blueprints/scripts/start-debug.ps1 -SeedTestBlueprints
```

## 包含蓝图与测试覆盖点

1. **`局部蓝图测试母站.json`**（写入 `%LOCALAPPDATA%\MainSequence\Saved\SaveGames\Designs\局部蓝图测试母站.sav`）
   - 5 模块母站：指挥舱 + 工厂 A/B/C（`BPO_Station_01`×3）+ 2×2 双层阳台工厂（`BPO_Station_02`×1）。
   - 刻意预置 3 类跨模块边缘建筑：跨 A↔B 门洞传送带、跨 A↔B 地下带对（`Length=7`）、骑跨 A↔C 南门洞的 `2×4` 工作台。
   - 测试：`Shift+左键` 单选 A 勾选「包含内部机器」保存 → 保留 5 台、自动剔除跨边界 2 项并报告；同时选 A+B 保存 → 自动保留内门传送带与地下带对（保留 10 台、仅剔除骑跨未选 C 的工作台）。
2. **`01-单块精炼产线.json`**（写入局部蓝图库 `基础对接/`）
   - `1×1` + 2×精炼厂（`REC_HydrogenFuel`）+ 分流器（`priorityOut=2`、`portFilters["0"]=ITEM_HydrogenFuel`）+ 传送带。
   - 测试：默认目标块悬浮 1 点击快贴、`R` 旋转、`F` 含机器禁镜像提示、退出设计器后 HUD 确认条一键建机台并检查配方与分流器配置。
3. **`02-双块地下带枢纽.json`**（写入局部蓝图库 `基础对接/`）
   - `2×1` + 跨内门传送带 + 二级地下带对（`Length=7`）+ 分流器 + 精炼厂。
   - 测试：双接口对齐优先排序、`Tab`/`Shift+Tab` 轮换对接位、`Alt` 切自由 16m 网格、地下带原子建造保留 `Length=7`。
4. **`03-双层阳台工厂.json`**（写入局部蓝图库 `异形与多层/`）
   - `2×2×2` `BPO_Station_02` + 1F/2F 挑台机台。
   - 测试：**`H` 键 / 中键锁定预览** → 自由旋转 3D 视角检查 2F 阳台缺口 → 方向键（±16m 相机朝向）+ `PageUp`/`PageDown`（±1 层）微调 → `R` 原地旋转 → `Enter`/左键确认。
5. **`04-L形三块纯壳体.json`**（写入局部蓝图库 `异形与多层/`）
   - `L` 形 3 块纯壳体（0 台室内机台）。
   - 测试：纯壳体允许 `F` 镜像、`Tab` 轮换 L 形正反贴靠、退出设计器后不弹室内机台确认条。
