# Main Sequence Workshop

《主星序 Main Sequence》的非官方社区工具集合。

## 项目

- [产线规划配平器](https://iotaxw.github.io/main-sequence-workshop/production-line-balancer/)：从版本化游戏数据确定目标产率所需的输入、配方分支、机器数量和耗电（[源码与使用说明](apps/production-line-balancer/README.md)）。
- [总线超市规划器](https://iotaxw.github.io/main-sequence-workshop/mall-planner/)：浏览和编辑物品层级、配方依赖、常备目标与隔离分区，并导入导出协作方案（[源码与使用说明](apps/mall-planner/README.md)）。
- [空间站蓝图规划器](https://iotaxw.github.io/main-sequence-workshop/station-blueprint-designer/)：离线 3D 暗色 CAD 空间站蓝图规划器，支持实时产线物流诊断、原生 `.sav` ↔ JSON 双向互转（共享 Rust/WASM 编解码库 `packages/ms-blueprint-codec/`）、本地文件夹与个人 GitHub 私有云库（[源码与使用说明](apps/station-blueprint-designer/README.md)）。
- [空间站局部蓝图 Mod](apps/station-section-blueprints/README.md)：在原生设计器中保存、整理和复用局部蓝图，当前仍处于开发预览阶段。

网页工具通过 GitHub Actions 构建并发布到 GitHub Pages：

- [打开产线规划配平器](https://iotaxw.github.io/main-sequence-workshop/production-line-balancer/)
- [打开总线超市规划器](https://iotaxw.github.io/main-sequence-workshop/mall-planner/)
- [打开空间站蓝图规划器](https://iotaxw.github.io/main-sequence-workshop/station-blueprint-designer/)

## 开源与第三方内容

本仓原创代码与文档采用 [MIT License](LICENSE)。游戏名称、原生图标和配方数据等第三方内容不属于 MIT 授权范围，详见 [NOTICE](NOTICE)。

本公开仓库只包含可公开源码与使用文档，不包含游戏安装文件、存档、本机环境记录、内部实验或开发探针。
