# 源码候选版验证记录

日期：2026-11-17。环境：Windows x64、Node.js 24.22.2、Rust 1.93.1 GNU、FFmpeg 9.0.2。FFprobe 使用核对下载完整性的 `@ffprobe-installer/win32-x64@5.1.0`。完整日志、工具及临时数据库保存在本地忽略目录，不随源码分发。

## 当前结果

| 检查 | 实际结果 |
| --- | --- |
| 干净目录 `npm.cmd ci` | 成功安装锁定依赖，未复制原安装的 node_modules、配置或运行数据库 |
| 干净目录 `npm.cmd run demo` | 工具调用成功，新进程恢复得到 `RESTORED_MARKER_FOUND` |
| 干净目录 `npm.cmd test` | 默认环境 800 通过、0 失败、2 跳过；按文档安装可选媒体依赖后 802 通过、0 失败、0 跳过 |
| 干净目录 `npm.cmd run wechat:build` | Release 构建成功；产物 `--version`、`--help` 正常，构建记录中的 SHA-256 与独立计算一致 |
| `npm.cmd run launchers:build` | 两个 Windows 启动器构建成功，微信启动器 `--self-test` 通过 |
| `npm.cmd run setup -- --account account-example --group 10001@chatroom` | 在新目录生成空的合成账号/群配置，没有执行登录或发送 |
| 原生工作区完整测试 | 791 通过、0 失败、1 忽略，34 个测试目标及文档测试汇总，命令退出码 0 |
| Rust 格式和静态检查 | `cargo fmt --all --check`、全工作区全目标 `cargo clippy ... -- -D warnings` 通过 |

原生完整测试命令：

```powershell
cargo test --workspace --no-fail-fast --locked --manifest-path native/wechat/packages/native-client-rust/Cargo.toml -- --test-threads=4
```

唯一未运行项是原有的 `history_latency_benchmark`，需要安静的 release 构建环境单独测量时延。三个 Linux 官方客户端接管成功用例按平台编译；Windows 新增对应的拒绝操作测试，核对账号列表和原文件未被改变。不能将 Windows 结果等同于已验证 Linux/macOS。

应用测试使用模拟模型接口；可选语音测试验证本地转换和缓存，没有调用真实语音合成服务。FFmpeg 是显式配置的外部依赖，包管理器使用本机下载缓存。这里的“干净目录”指重新安装源码依赖且没有私人运行状态，不是未安装任何开发工具的新操作系统。

## 修复了什么

前一轮原生全量结果是 765 通过、27 失败、1 忽略。本次复现并处理了以下原因，未删除文件完整性、身份或发送去重检查：

- 媒体缓存的内部 Windows 路径使用反斜杠，被面向配置字符串的校验误拒绝。现在先转换分隔符再验证，继续拒绝越界、绝对路径、Windows 数据流及链接跳转。
- 保存登录状态的目标文件用字符串比较，Windows 原生路径与正斜杠常量不相等。改为比较路径组成，仍只允许指定的 global_config。
- 文件复制后用只读句柄刷新，在 Windows 报拒绝访问；改用已有的平台文件刷新函数。
- 恢复备份目录发布时，自己仍持有目录内文件句柄，Windows 拒绝重命名；完成校验后关闭备份副本句柄，原数据库的身份和变更检查保留。
- MJPEG 源的全范围色彩在当前 FFmpeg 下传入输出，导致目标格式校验失败；现在明确转换为规定的有限范围后编码，不放宽格式、时长和大小限制。
- 需要规范化路径的测试改用规范化的临时目录；路径断言比较规范化结果。没有修改正式代码的目录跳转防护来适配测试。
- 从 npm 启动的 PowerShell 在本机无法找到 `Get-FileHash`，曾导致构建后的校验值记录失败；改用内置 .NET SHA-256，完整构建命令及独立校验随后通过。

先前的缺少 FFprobe、Windows Perl/OpenSSL 组合及新测试的编译错误也已记录并处理。最终通过的检查与中间失败尝试分别记录在[本次变更日志](change-log/CA-20261117-164806-265ee915.md)。

## 发布边界

本次只验证隔离源码副本。没有登录真实微信、发送群消息、操作朋友圈、改动网络配置或替换运行中的 Agent；真实账号、手机显示与模型服务仍需在使用者自己的配置下验收。

新仓库没有导入旧 Git 历史，提交使用维护者确认的 noreply 邮箱。源码包不含私人配置、图库、聊天、人物记忆、Cookie、密钥、构建缓存或安装后的依赖；尚未推送或公开发布。
