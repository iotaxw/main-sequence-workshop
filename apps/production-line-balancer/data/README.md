# 版本化配方数据

`main-sequence-26639889.dataset.json` 来自游戏 Build `26639889` 的原件只读导入，不是人工抄录或社区转述。

- 81 个物品、9 台机器、83 个输入输出可唯一确定的配方。
- Raw Resources 注册资源由 `DAT_ItemRegistry` 确定性生成，共 14 项；默认外部输入排除具有零输入生产配方的 Protomatter 后为 13 项，仍可显式追加连续外部供给。
- 物品、机器、配方和输入输出保持原生顺序；每条记录保留来源资产，全局保留 Build ID 和导入器版本。
- 名称使用官方英文和简体中文数据，不维护人工翻译副本。
- 多产物配方保留 `isByproduct` 语义；3 个特殊机制配方列入 `source.unsupportedRecipes`，`REC_Protomatter` 按原生零输入语义进入普通配方网络。
- 机器功率为 kW，未知值为 `null`；耗时为秒级有理数字符串，物品速率为每分钟。
- `PF_FloatRGBA` 图标的线性 HDR RGB 在导出时转换为 sRGB，Alpha 不做伽马转换；其他像素格式不做额外增亮或反色。

游戏更新后应生成新 Build 的数据文件并复核差异，不得覆盖来源不明的数据。相同输入的重复导入必须逐字节一致。

游戏数据与原生图标属于第三方内容，不适用根目录 MIT License，详见 [NOTICE](../../NOTICE)。
