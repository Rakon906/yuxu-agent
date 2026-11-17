# 构建定制微信引擎

`native/wechat/packages/native-client-rust/` 是完整 Rust 工作区，包含本项目使用的表情、拍一拍、朋友圈及图像发送扩展。它以 agent-wechat v1.3.2 为基础，保留上游许可和来源。不要用上游基础二进制替换它后仍期待所有扩展可用。

Windows x64 开发环境需要 Rust 1.93.1、对应 C/C++ 编译器和 Perl；SQLCipher/OpenSSL 与 SILK 的构建也需要这些组件。GNU 工具链使用 MinGW-w64；MSVC 环境需要相应 Visual Studio Build Tools。不能将某一种本机工具链的成功理解为另一种也已验证。

本次验证使用 Windows GNU 工具链及 Strawberry Perl 附带的 OpenSSL 静态库。在这一环境下，设置下面两个变量后构建；其他环境应指向自己工具链兼容的 OpenSSL，或使用能够构建 OpenSSL 的对应 Perl/编译器组合：

```powershell
$env:OPENSSL_NO_VENDOR = '1'
$env:OPENSSL_DIR = 'C:\Strawberry\c'
```

Windows GNU 构建不能直接用原生 Windows Perl 运行要求 Unix 路径的 OpenSSL 配置。上述预装库路径避免这个问题，并不改变系统环境变量。

```powershell
rustup toolchain install 1.93.1 --profile minimal --component rustfmt --component clippy
npm.cmd run wechat:build
npm.cmd run launchers:build
```

构建脚本使用 PATH 中的 Cargo。输出保存到 `.tools/agent-wechat/v1.3.2/wx.exe`，该目录名是内部兼容路径。脚本不会停止另一份微信服务；本安装的二进制正在使用时会拒绝覆盖。

Windows 启动器由 `tools/startup/Program.cs` 和 `tools/wechat-start/Program.cs` 构建，使用系统 .NET Framework 编译器。源码发行版不包含开发者电脑上构建的 EXE，也不携带登录资料。

开发验证：

媒体测试还需要 `ffmpeg` 和 `ffprobe` 均在 PATH 中。仅安装 FFmpeg 可执行文件而没有 FFprobe 时，视频测试会报 `media_encoder_unavailable`。本次完整测试的结果和后续定向复测见 [验证记录](validation.md)；目前不是所有原生测试均已通过。

```powershell
cargo fmt --all --check --manifest-path native/wechat/packages/native-client-rust/Cargo.toml
cargo clippy --workspace --all-targets --locked --manifest-path native/wechat/packages/native-client-rust/Cargo.toml -- -D warnings
cargo test --workspace --locked --manifest-path native/wechat/packages/native-client-rust/Cargo.toml
```

构建及模拟测试不执行真实微信登录或消息发送。测试素材来自上游源码测试目录，个人采集的媒体、抓包和逆向工程数据库不包含在本发行版。
