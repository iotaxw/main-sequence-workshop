# 安装与卸载

当前版本 `0.2.0`：已适配游戏 **Build `26885430`+**（推荐 **UE4SS `4.0.0`**）及历史 Build `26639889`（内置编解码目录数据基于 Build `26639889`，新版本增量模块待按需核对）。功能验证状态详见工作区 README。

## 前置条件

- Windows 版《主星序 Main Sequence》。
- **UE4SS 版本匹配（重要）**：
  - **游戏 Build `26885430` 及以上（当前 Steam 最新版）**：必须使用 **UE4SS `4.0.0`**（官方 RE-UE4SS 4.0.0 发布版）；旧版 `3.0.1-beta` 注入 Build `26885430` 后会在数秒内触发访问违例崩溃。
  - **历史游戏 Build `26639889`**：可使用 MSCore `v0.8.4` 发布页提供的 `ue4ss-3.0.1-beta.zip`（只取 UE4SS 文件，不安装 MSCore）。

## 安装

1. 保存并关闭游戏。
2. 将 UE4SS 压缩包中的 `dwmapi.dll` 和 `ue4ss` 目录放入以下目录：

   ```text
   <game>\Windows\MainSequence\Binaries\Win64\
   ```

3. 将本包中的 `Mods\StationSectionBlueprints` 放入：

   ```text
   <game>\Windows\MainSequence\Binaries\Win64\ue4ss\Mods\
   ```

4. 在该 `Mods` 目录的 `mods.txt` 中加入以下行；没有该文件时可新建：

   ```text
   StationSectionBlueprints : 1
   ```

   也可在本包根目录使用随附管理器：

   ```powershell
   pwsh -File tools/mod-manager.ps1 -Action enable -Name StationSectionBlueprints -ModsRoot "<game>\Windows\MainSequence\Binaries\Win64\ue4ss\Mods"
   ```

5. 启动游戏。包内已包含 `Binaries/ms-blueprint-codec.exe`，用于提取独立 `DesignSaveGame` 工作副本并生成机台搭建计划；不需要安装 Cargo、Rust、额外 GVAS 工具或私有 UE SDK。原生设计图、存档和产线配平器不属于安装步骤，不需要修改。

## 管理器

```powershell
pwsh -File tools/mod-manager.ps1 -Action list -ModsRoot "<Mods 目录>"
pwsh -File tools/mod-manager.ps1 -Action enable -Name StationSectionBlueprints -ModsRoot "<Mods 目录>"
pwsh -File tools/mod-manager.ps1 -Action disable -Name StationSectionBlueprints -ModsRoot "<Mods 目录>"
```

管理器只修改目标 `mods.txt` 中同名条目，保留注释和其他 Mod，不删除文件。

## 卸载

1. 保存并关闭游戏。
2. 用管理器停用，或在 `mods.txt` 中设置 `StationSectionBlueprints : 0`。
3. 删除 `Mods\StationSectionBlueprints` 目录。
4. 不需要卸载 UE4SS；其他 Mod 可继续使用。只有确认不再需要任何 UE4SS Mod 时，才按 UE4SS 文档单独移除框架。

局部蓝图数据使用 `%LOCALAPPDATA%\MainSequence\Saved\SaveGames\StationSectionBlueprints`，卸载 Mod 不会自动删除蓝图。索引格式当前版本为 `1`；跨版本迁移必须保留原生蓝图负载，不修改原生 `Designs`。
