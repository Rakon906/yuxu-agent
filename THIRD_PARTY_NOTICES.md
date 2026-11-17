# Yuxu 第三方组件说明

鱼叙 Yuxu（原项目名 SocioMem）是本项目的产品名称，包名为 `yuxu-agent`。微信引擎是在下列开源组件基础上维护的定制版本；更换产品名称不改变原组件的版权归属，也不表示底层代码全部由本项目从零编写。

## 微信引擎基础组件

- 原项目：Agent WeChat（agent-wechat）
- 来源：https://github.com/thisnick/agent-wechat
- 基线版本：v1.3.2
- 基线提交：13390d7c5f5924f3cfe67a8e5a4dc51dc86c179e
- 许可证：MIT
- 原版权声明：Copyright (c) 2026 Nick Yu and contributors
- 完整许可文本：[licenses/agent-wechat-MIT.txt](licenses/agent-wechat-MIT.txt)

本项目在该基础上增加了表情发送、拍一拍、朋友圈相关协议及 Yuxu 的集成逻辑。发布包含原组件或其重要部分的源码、二进制时，应随附上述完整许可文本和原版权声明。本地第三方源码内的 LICENSE、来源信息和原有版权说明保持不变。

## 命名与兼容性

产品展示使用“Yuxu 微信引擎”，普通使用入口是 `Yuxu-Start.exe`、`Yuxu-WeChat.exe` 和 `npm.cmd run wechat -- <命令>`。

`.tools/agent-wechat/`、`.runtime/agent-wechat/`、API 原始产品标识及加密附加认证数据前缀保留兼容名称。定制源码位于 `native/wechat/`，保留其原许可。`configs/agent-wechat.release.json` 仅记录上游基线来源，不作为当前定制版本的下载清单；安装入口从本仓库源码构建。

## 其他组件

| 组件 | 许可证 | 本项目使用方式 |
| --- | --- | --- |
| DeepSeek Harness（`@deepseek-ai/dsh*`） | MIT | Agent 运行和工具编排 |
| Mem0、Transformers.js | Apache-2.0 | 记忆管理与本地向量 |
| better-sqlite3 | MIT | SQLite 依赖 |
| sharp | Apache-2.0 | 图像处理 |
| sherpa-onnx-node（可选） | Apache-2.0 | 本地语音识别运行时 |

精确的直接依赖版本与来源见 `docs/dependencies.json`，完整 npm 依赖解析见 `package-lock.json`。Rust 依赖见原生工作区的 `Cargo.lock`，各组件附带的许可证继续适用。模型权重、FFmpeg、Python 环境及 npm 安装产物不在源码包内，使用者另行安装并遵守对应许可。

原生引擎包含 SILK 相关第三方源码，完整声明保留于 `native/wechat/packages/native-client-rust/crates/wechat-protocol/vendor/silk/LICENSE-SDK` 与 `LICENSE-MIT`；本项目根目录的 MIT 不覆盖或取代这些条款。

随源码保留的二进制测试样例均与上游基线逐字节核对，清单见 `docs/fixture-provenance.json`。它们不包含本项目账号采集的图片、语音、聊天数据库或抓包。
