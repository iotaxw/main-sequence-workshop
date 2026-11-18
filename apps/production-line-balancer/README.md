# Main Sequence 产线规划配平器

面向《主星序 Main Sequence》的纯网页产线规划工具。选择目标物品和每分钟速率后，可逐个选择配方分支与副产回流，获得净输入、机器连续量、整数建设量和耗电。

## 本地使用

需要 Node.js 24。

```bash
npm ci
npm run dev
```

界面默认使用官方简体中文，可切换英文。方案仅保存在当前浏览器中，并校验数据 Build 与引用完整性。

## 构建与测试

```bash
npm test
npm run build
```

构建结果为 `dist/`，可部署到任意静态网站托管服务。资源地址使用相对路径，兼容 GitHub Pages 的项目子路径。

## 游戏数据刷新

正式数据位于 `data/`，记录游戏 Build ID、来源资产和导入依据。刷新需要 Windows 游戏原件、本地 .NET 10 SDK 以及与当前 Build 匹配的映射文件；工具均放在被忽略的 `.tools/` 中。

```bash
npm run refresh:game
```

可用 `-GameRoot` 指定游戏安装目录。刷新脚本连续导入两次并要求数据集逐字节一致；缺失映射、非法数值或不支持的配方会明确报错。

当前数据来自 Build `26639889`，包含 81 个物品、9 台机器、82 个具体配方和 90 张原生图标。数据详情见 [数据说明](data/README.md)。

## 许可

原创代码与文档采用根目录 [MIT License](../../LICENSE)。原生图标和游戏数据等第三方内容不在 MIT 授权范围内，详见 [NOTICE](../../NOTICE)。
