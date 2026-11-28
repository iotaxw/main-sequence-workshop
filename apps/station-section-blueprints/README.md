# Station Section Blueprints

《主星序 Main Sequence》空间站局部蓝图 Mod（UE4SS Lua + `ms-blueprint-codec` 共享编解码核心），在原生空间站规划界面内支持 `Shift + 左键` 多选、含室内机台双协议保存（自动剔除跨模块边缘建筑并明文报告）、目标块悬浮快贴 + `H` 锁定微调，以及退出规划后的两阶段原生室内机台搭建。

## 版本与 UE4SS 兼容说明（重要）

- **游戏 Build `26885430` 及以上（当前 Steam 最新版）**：必须安装 **UE4SS `4.0.0`**（官方 RE-UE4SS 4.0.0 发布版）；旧版 `3.0.1-beta` 注入 Build `26885430` 后会在数秒内触发访问违例崩溃。
- **UE4SS 4.0.0 启动稳定性**：`ssb_native_designer.lua::find_session` 与 `ssb_machine_paste.lua` 均优先采用定向 `FindAllOf` 查找（不再在游戏启动阶段执行全量 `ForEachUObject` 回调），避免 UE4SS 4.0.0 GameThread 访问违例。
- **历史游戏 Build `26639889`**：兼容 UE4SS `3.0.1-beta`；当前内置目录数据（`ssb_catalog_data.lua` / `catalog-26639889.json`）基于 Build `26639889` 生成。

## 克隆后一键启动调试（兼 Agent 自助分发指引）

前置条件：已按 [INSTALL.md](INSTALL.md) 放入与游戏版本匹配的 **UE4SS `4.0.0`**、PowerShell 7 (`pwsh`) 与 Rust 工具链（`cargo`，首次自动编译 `ms-blueprint-codec.exe`）。

```powershell
git clone https://github.com/iotaxw/main-sequence-workshop.git
cd main-sequence-workshop

# 1. 自动编译 ms-blueprint-codec.exe + 从 test-blueprints/ 播种全套 5 份测试蓝图 + 开启调试沙盒快捷键(F9)并免改游戏目录拉起游戏：
pwsh -NoProfile -File apps/station-section-blueprints/scripts/start-debug.ps1 -SeedTestBlueprints -EnableDebugSandbox
```

### Agent 跨机自助配置清单
1. **核对 UE4SS 版本**：确认 `<游戏>\Windows\MainSequence\Binaries\Win64\ue4ss\` 为 **UE4SS `4.0.0`**（如为旧版 `3.0.1-beta` 在 Build `26885430`+ 上会秒崩）。
2. **一键编译并播种测试蓝图**：运行上述 `start-debug.ps1 -SeedTestBlueprints -EnableDebugSandbox`（若只需编译与播种不启动游戏，加 `-BuildOnly`）。仓库内 [test-blueprints/](test-blueprints/README.md) 已直接附带全部 5 份原创合成测试蓝图（Canonical JSON v2），脚本会自动将其编码并安装到：
   - 原版整站设计：`%LOCALAPPDATA%\MainSequence\Saved\SaveGames\Designs\局部蓝图测试母站.sav`
   - 局部蓝图库：`%LOCALAPPDATA%\MainSequence\Saved\SaveGames\StationSectionBlueprints\`（含 `基础对接/` 与 `异形与多层/` 共 4 套局部蓝图与校验过的 `index.ssb`）
3. **如何免材料进入测试（两种真实可用路径）**：
   - 《主星序 Main Sequence》当前抢先体验版的「新游戏」菜单里**没有**内置创造模式勾选框，且公开仓库遵循隐私与存档边界不提交玩家世界存档（`*_M.sav` / `*_S.sav`）。
   - **路径 A（实机世界完整测两阶段：壳体 + 退出后建室内机台，推荐）**：带 `-EnableDebugSandbox` 启动后，加载任意已有存档或新建一个普通存档进入世界，按 **`F9`** 调用游戏原生 `DMSPlayerController:SetCreativeMode(true/false)` 切换创造模式、按 **`Shift + F9`** 调用 `SetCreativeUnlockAllResearch()` 解锁全部科技（该辅助模块 `ssb_debug_sandbox.lua` 仅在显式开启调试参数时加载，**绝不进入发布包**），随后走进空间站控制台进规划器载入 **`局部蓝图测试母站`** 即可完整实测全部 5 类场景与两阶段室内机台搭建！
   - **路径 B（纯规划器内交互快速试玩）**：直接在游戏主菜单点击原版 **「设计器 / Designer」** 按钮，即可零门槛免费载入 **`局部蓝图测试母站`** 并测试 `Shift+左键` 多选、含机器保存（跨边界剔除报告）、目标块悬浮快贴、`Tab`/`R`/`H` 锁定微调与 4 套局部蓝图预览（注：独立设计器内无真实世界空间站，不触发退出后的第二阶段室内机台搭建）。
4. **零侵入热重载调试**：启动脚本通过 `UE4SS_MODS_PATHS` 挂载本仓库的 `apps/station-section-blueprints/Mods`，**不修改游戏安装目录**；修改 `Mods/StationSectionBlueprints/Scripts/*.lua` 后在 UE4SS 控制台按 `Ctrl+R` 即可热重载，日志位于 `<游戏Win64目录>\ue4ss\UE4SS.log`。
5. **自定义路径或仅打包**：可显式传 `-GameExe "<路径>"` 或设 `$env:MAIN_SEQUENCE_EXE`；仅编译并打发布 zip：
   ```powershell
   pwsh -NoProfile -File apps/station-section-blueprints/scripts/start-debug.ps1 -BuildOnly -Package
   ```

## 核心操作与快捷键

- **原地多选与保存**：在原生规划界面中按住 `Shift + 左键` 点击模块切换选中/取消；点击右侧「保存局部蓝图」，勾选「包含内部机器」后将双写 Canonical Blueprint JSON v2 与原生 `STATION_PRESET` `.sav` 到 `%LOCALAPPDATA%\MainSequence\Saved\SaveGames\StationSectionBlueprints\`，自动剔除跨边界建筑与跨区地下带并在状态栏报告剔除数量。
- **目标块悬浮快贴（默认）**：从「局部蓝图库」点击粘贴后，悬停主站任意单个模块即仅对该模块空闲接口吸附（多接口对齐优先），左键直接确认；`Tab` / `Shift+Tab` 轮换合法无碰撞对接位，`R` 顺时针旋转 90°（含室内机台时禁用镜像 `F` 保护端口手性），按 `Alt` 切换自由 16m 网格。
- **异形/多层 `H` 锁定微调**：按 `H` 或鼠标中键锁定全息预览并释放 3D 视角自由观察（如 `BPO_Station_02` 双层阳台）；锁定期间方向键按相机朝向平移 ±16m、`PageUp`/`PageDown` 升降 ±1 层（8m）、`R` 原地旋转不丢偏移、`Tab` 继续轮换、`Enter`/左键确认、再按 `H` 解锁。
- **两阶段室内机台搭建**：壳体确认并应用改动退出规划界面后，HUD 弹出「待建室内机台」确认条，点击「开始搭建」后先执行 1m 占用栅格防重叠拦截，再通过原生 `AddBuildCommand` 与强类型 `AddInputCommand` 分批建造并还原配方、地下带长度、分流器优先级与过滤槽（完全服从原生生存材料与科技校验，零作弊）。

## 当前实测状态

- **Build `26639889` 全链路实机通过**：33/33 Lua 行为单测 + 15/15 Rust 编解码测试；原生设计器严格会话、`Shift+左键` 增删复选、含机器双协议保存与删除、`UpdatePreview` 钩子接管与 `bSnapping` 恢复、UI 挂载与 15 项快捷键注册；空背包生存材料门禁拦截、1m 防重叠拦截、以及精炼厂配方（`REC_HydrogenFuel`）、二级地下带长度（`Length=6`）与二级分流器优先级/过滤槽（`PriorityOutputIndex=2`, `ITEM_HydrogenFuel`）逐机回读。
- **Build `26885430` + UE4SS `4.0.0`**：已实测定位并修复 `find_session` 全量 `ForEachUObject` 启动崩溃（改为定向 `FindAllOf`）；Build `26885430` 完整交互与新增内容兼容性待后续按需复测。
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
