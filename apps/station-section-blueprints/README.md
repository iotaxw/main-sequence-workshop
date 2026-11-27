# Station Section Blueprints

《主星序 Main Sequence》空间站局部蓝图 Mod（UE4SS Lua + `ms-blueprint-codec` 共享编解码核心），在原生空间站规划界面内支持 `Shift + 左键` 多选、含室内机台双协议保存（自动剔除跨模块边缘建筑并明文报告）、目标块悬浮快贴 + `H` 锁定微调，以及退出规划后的两阶段原生室内机台搭建。

## 克隆后一键启动调试（零修改游戏目录）

前置条件：已安装 [UE4SS](INSTALL.md)、PowerShell 7 (`pwsh`) 与 Rust 工具链（`cargo`，首次自动编译 `ms-blueprint-codec.exe`）。

```powershell
git clone https://github.com/iotaxw/main-sequence-workshop.git
cd main-sequence-workshop

# 1. 自动编译编解码器 + 写入全套测试蓝图 + 免改游戏目录直接拉起游戏调试：
pwsh -NoProfile -File apps/station-section-blueprints/scripts/start-debug.ps1 -SeedTestBlueprints
```

- 脚本会自动从 Steam 库探测 `MainSequence-Win64-Shipping.exe`（也可显式传 `-GameExe "<路径>"` 或设置 `$env:MAIN_SEQUENCE_EXE`）。
- 启动时通过 `UE4SS_MODS_PATHS` 直接挂载本仓库的 `apps/station-section-blueprints/Mods`，**不复制也不修改游戏安装目录**。
- 调试期间直接修改 `apps/station-section-blueprints/Mods/StationSectionBlueprints/Scripts/*.lua`，在 UE4SS 控制台按 `Ctrl+R` 热重载即可生效，日志位于 `<游戏Win64目录>\ue4ss\UE4SS.log`。
- 仅编译不启动游戏：
  ```powershell
  pwsh -NoProfile -File apps/station-section-blueprints/scripts/start-debug.ps1 -BuildOnly -Package
  ```

## 核心操作与快捷键

- **原地多选与保存**：在原生规划界面中按住 `Shift + 左键` 点击模块切换选中/取消；点击右侧「保存局部蓝图」，勾选「包含内部机器」后将双写 Canonical Blueprint JSON v2 与原生 `STATION_PRESET` `.sav` 到 `%LOCALAPPDATA%\MainSequence\Saved\SaveGames\StationSectionBlueprints\`，自动剔除跨边界建筑与跨区地下带并在状态栏报告剔除数量。
- **目标块悬浮快贴（默认）**：从「局部蓝图库」点击粘贴后，悬停主站任意单个模块即仅对该模块空闲接口吸附（多接口对齐优先），左键直接确认；`Tab` / `Shift+Tab` 轮换合法无碰撞对接位，`R` 顺时针旋转 90°（含室内机台时禁用镜像 `F` 保护端口手性），按 `Alt` 切换自由 16m 网格。
- **异形/多层 `H` 锁定微调**：按 `H` 或鼠标中键锁定全息预览并释放 3D 视角自由观察（如 `BPO_Station_02` 双层阳台）；锁定期间方向键按相机朝向平移 ±16m、`PageUp`/`PageDown` 升降 ±1 层（8m）、`R` 原地旋转不丢偏移、`Tab` 继续轮换、`Enter`/左键确认、再按 `H` 解锁。
- **两阶段室内机台搭建**：壳体确认并应用改动退出规划界面后，HUD 弹出「待建室内机台」确认条，点击「开始搭建」后先执行 1m 占用栅格防重叠拦截，再通过原生 `AddBuildCommand` 与强类型 `AddInputCommand` 分批建造并还原配方、地下带长度、分流器优先级与过滤槽（完全服从原生生存材料与科技校验，零作弊）。

## 当前实测状态（Build `26639889`）

- **已实机验证通过**：32/32 Lua 行为单测 + 15/15 Rust 编解码测试；原生设计器严格会话、`Shift+左键` 增删复选、含机器双协议保存与删除、`UpdatePreview` 钩子接管与 `bSnapping` 恢复、UI 挂载与 15 项快捷键注册；空背包生存材料门禁拦截、1m 防重叠拦截、以及精炼厂配方（`REC_HydrogenFuel`）、二级地下带长度（`Length=6`）与二级分流器优先级/过滤槽（`PriorityOutputIndex=2`, `ITEM_HydrogenFuel`）逐机回读。
- **待继续复测边界**：`MachinePortInput` 端口开关、`SetPaletteInput` 非零调色板、`LogisticFilterInput`、`SetTextInputCommand`、`CreativeContainerInput` 的逐项真机回读，以及多人联机同步边界。

## 安装、单元测试与打包

安装和卸载见 [INSTALL.md](INSTALL.md)。

```powershell
# 运行 Lua 自动化单测（需要 lua 5.4）
cd apps/station-section-blueprints
lua tests/run_tests.lua

# 生成独立发布包（需已编译 ms-blueprint-codec.exe）
pwsh -NoProfile -File scripts/package.ps1 -Version 0.2.0
```

原创代码与文档采用根目录 [MIT License](../../LICENSE)，游戏及其原生内容不在 MIT 授权范围内，详见 [NOTICE](../../NOTICE) 与 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
