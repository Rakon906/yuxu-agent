# 源码候选版验证记录

日期：2026-11-17。环境：Windows x64、Node.js 24.22.2、Rust 1.93.1 GNU。所有运行数据、缓存、构建产物和完整日志保留在本地忽略目录，不随源码分发。

## 已通过

| 检查 | 实际结果 |
| --- | --- |
| `npm.cmd ci` | 在独立目录安装锁定依赖成功 |
| `npm.cmd test` | 802 项通过，0 失败，0 跳过；包括模拟接口、群隔离、记忆、媒体、启动和配置测试 |
| `npm.cmd run demo` | 离线 Harness 工具执行正常，新进程恢复历史得到 `RESTORED_MARKER_FOUND` |
| `npm.cmd run launchers:build` | 两个 Windows 启动器构建成功；微信启动器自检通过 |
| `npm.cmd run wechat:build` | 定制原生引擎 release 构建成功；`wx --version` 和 `wx --help` 可以执行 |
| Rust 格式和静态检查 | 最终 `cargo fmt --all --check` 与 `cargo clippy --workspace --all-targets --locked -- -D warnings` 均通过（均指定源码工作区的 manifest） |
| 隐私检查 | 通用扫描及本地已知身份、已知密钥、聊天原文对照未发现匹配；这不等于数学意义上的无泄露证明 |
| 测试素材来源 | 11 个二进制样例逐字节匹配公开上游；141 个 SILK 源文件保留公开上游原文 |

应用层完整测试前已在忽略目录安装可选语音依赖并配置 FFmpeg。未安装可选组件时，某些媒体测试可能跳过，不能直接复用这里的零跳过结论。模型接口使用模拟服务；本次没有调用真实模型、登录微信、发消息或操作朋友圈。

## 原生测试尚未全部通过

执行：

```powershell
cargo test --workspace --no-fail-fast --locked --manifest-path native/wechat/packages/native-client-rust/Cargo.toml -- --test-threads=4
```

首次可完整执行的全量结果为 **765 通过、27 失败、1 忽略**。忽略项沿用现有测试标记；Unix 专用权限和符号链接断言只在 Unix 编译，跨平台部分保留。失败目标为：

- `wechat-core --lib`：12 项，涉及视频依赖、路径规范化、保存登录资料以及官方客户端接管。
- `wechat-profile --test login_storage`：1 项。
- `wechat-profile --test media_write`：5 项。
- `wechat-profile --test mmkv_write`：4 项。
- `wechat-store --test preservation`：2 项。
- `wechat-store --test storage`：3 项。

补充调查：使用 Windows 规范化的临时目录后，`mmkv_write` 6 项与 `login_storage` 9 项全部通过，存储绑定的路径比较也通过；这说明部分失败与测试输入路径的形式有关。媒体缓存、文件导入和恢复仍有失败，不能据此宣称全部修复。官方客户端接管在代码中明确只支持 Linux，Windows 的成功路径测试不能作为该能力可用的证明。

初次视频测试环境缺少 FFprobe，之后在本地构建缓存补充了 `@ffprobe-installer/win32-x64@5.1.0`，核对下载完整性并做定向复测。最终 core 目标为 **270 通过、5 失败、1 忽略**：一个旧式视频格式检查、三个 Linux 官方客户端接管流程，以及一个保存登录路由的预期未通过。`media_write` 在另一组规范化路径复测中为 12 通过、6 失败，`storage` 为 8 通过、2 失败，`preservation` 为 7 通过、2 失败。不同环境的定向测试不能相加冒充新一轮全量结果。

不要通过移除身份、路径或文件完整性校验来消除这些失败。上述兼容性问题应作为后续独立修正，并重新运行完整测试。Windows GNU 编译应使用普通的临时目录路径；给测试进程使用的 `\\?\` 路径形式不适合直接传给 GCC。

## 发布边界

这是可审查的源码候选包。应用层测试和原生编译成功，不替代新安装的真实登录、收发、手机显示与多平台验收。候选包不含开发者的现成登录环境、模型服务、图库、人物记忆、临时修复路由或构建缓存。

新仓库没有导入旧 Git 历史。本地初始候选提交使用维护者确认的 `Rakon <222187983+Rakon906@users.noreply.github.com>`，没有使用私人邮箱；尚未推送或公开发布。
