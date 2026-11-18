# Station Section Blueprints

《主星序 Main Sequence》的空间站局部蓝图 Mod，目标是在原生设计器中选区、保存到可整理文件夹的蓝图库，并通过原生规划预览与建造流程复用。

当前为**开发预览**，尚不可视为稳定完成版。两个积木的原生选择、隔离保存、读取、剪贴板预览、取消、中文嵌套文件夹和蓝图库整理已通过游戏内实测；机器、传送带、材料、生存与联机仍未完成验证，机器选项保持禁用。

## 边界

- 使用独立 UE4SS Lua Mod，不要求 MSCore，不新增游戏资源包。
- 复用原生剪贴板、规划预览、建造命令、材料校验和序列化。
- UI 嵌入原版保存区与预设浏览器，复用原版控件和样式。
- 蓝图数据与原生整站设计分离，正式数据位于 `%LOCALAPPDATA%\MainSequence\Saved\SaveGames\StationSectionBlueprints\`。
- 发布包不包含 UE4SS、开发执行器、探针、日志或游戏存档。

## 安装与打包

安装和卸载见 [INSTALL.md](INSTALL.md)。

```powershell
pwsh -File scripts/package.ps1 -Version 0.1.0-dev
```

发布包生成于 `dist/`，包含运行时代码、安装说明、Mod 管理器和 MIT License。

原创代码与文档采用根目录 [MIT License](../../LICENSE)，游戏及其原生内容不在 MIT 授权范围内，详见 [NOTICE](../../NOTICE)。
