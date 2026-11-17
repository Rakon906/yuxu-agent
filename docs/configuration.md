# 本地配置

复制 `.env.example` 为 `.env`。Windows 启动器读取简单的单行 `KEY=value`，不会把内容当脚本执行。`.env`、`.runtime/`、`.cache/` 和 `.tools/` 都不进入 Git。

## 模型

- `SOCIOMEM_PARTICIPATION_PROVIDER=deepseek`：配置 `DEEPSEEK_API_KEY`，或在 `.runtime/secrets/deepseek-api-key` 写入自己的一行 Key。
- `SOCIOMEM_PARTICIPATION_PROVIDER=ollama`：配置 `SOCIOMEM_OLLAMA_BASE_URL` 和 `SOCIOMEM_OLLAMA_MODEL`。本机或自己的工作站均可；本项目不附带他人的 SSH 地址或凭据。
- `SOCIOMEM_PARTICIPATION_PROVIDER=anthropic`：配置 `SOCIOMEM_ANTHROPIC_BASE_URL`、`SOCIOMEM_ANTHROPIC_MODEL`、`SOCIOMEM_ANTHROPIC_API_KEY`，或 `SOCIOMEM_ANTHROPIC_KEY_FILE`。端点需要兼容项目实现的 Messages API。
- `SOCIOMEM_MODEL_FALLBACK` 默认 `none`；自行配置回退前，确认备用提供方及费用。

保留服务返回的真实用量；缺失的 Token 统计为未知值，不当作零。`npm.cmd run api:usage` 读取本机统计，不调用模型。

## 发送

`SOCIOMEM_PARTICIPATION_SEND=1` 开启授权群文字回复。以下功能各自启用：

| 开关 | 功能 |
| --- | --- |
| `SOCIOMEM_STICKER_SEND` | 从本机已收录表情中选择发送 |
| `SOCIOMEM_VOICE_SEND` | 偶尔使用语音回复，需要语音合成依赖 |
| `SOCIOMEM_SELFIE_SEND` | 图片生成并发送，需要图像接口及自行准备的参考图 |
| `SOCIOMEM_PAT_SEND` | 主动/回应拍一拍 |
| `SOCIOMEM_MOMENTS_ENABLED` | 启动朋友圈浏览进程 |
| `SOCIOMEM_MOMENTS_SEND`、`SOCIOMEM_MOMENTS_LIKE_SEND`、`SOCIOMEM_MOMENTS_COMMENT_SEND` | 朋友圈互动总开关及细分开关 |
| `SOCIOMEM_TRENDS_ENABLED` | 启动可选热点获取进程 |

这些开关的示例默认值为 `0`。没有本地表情库或参考图时，不会附送开发者的素材。自动发布朋友圈还需本地 `.runtime/moments/publishing-config.json`，按 `packages/moments/publishing-schedule.mjs` 的配置校验填写，默认不创建发布任务。

## 记忆与人物

`npm.cmd run setup` 只建立自己账号和群的空配置，不复制任何成员身份或日记。人物称呼保存在 `.runtime/people/group-people.json`；日记、画像和观察由后续授权群消息逐渐积累。多群分别隔离。

`SOCIOMEM_DIARY_ENABLED` 默认 `1`；可用 `SOCIOMEM_DIARY_PROVIDER` 单独选择模型。启动器会启动本地向量服务，首次可能下载模型。时间窗口、输入容量和检索预算由 `packages/memory/context-policy.mjs` 及相应环境变量控制；容量限制是上限，不是每轮必须填满的输入量。

群内梗词表 `configs/slang.json` 初始为空。可按模块 schema 添加自己的通用词条，学习到的群内记录留在 `.runtime/`。可选的 21 点活动线索通过 `SOCIOMEM_ROUTINE_MEMBER_ID` 和 `SOCIOMEM_ROUTINE_NOTE` 在本地指定，源码不预设某位真实群友。

## 可选媒体依赖

- 接收语音：`npm.cmd run voice:install` 下载并校验 SenseVoice 模型。sherpa-onnx-node 是可选 npm 依赖；安装失败的平台需要先解决该依赖，再启用转写。
- 输出语音：`python -m venv .tools/edge-tts/venv`，再用该环境中的 Python 执行 `-m pip install -r tools/voice/requirements.txt`。合成模块默认使用这个环境；TTS 依赖外部服务可用性。
- 短视频：准备 FFmpeg，使用 `SOCIOMEM_FFMPEG_PATH` 指定可执行文件。
- 视觉理解：设置 `SOCIOMEM_VISION_PROVIDER`，选择支持图像输入的已配置模型；纯文本模型不能因开启开关而获得视觉能力。
- 图片生成：配置 `SOCIOMEM_IMAGE_ENDPOINT` 和 `SOCIOMEM_IMAGE_MODEL`；当前请求使用 Responses 风格接口并复用 Anthropic/OpenCode Key 读取器，需要服务接口适配。
- 自拍参考图：`SOCIOMEM_SELFIE_REFERENCE`、`SOCIOMEM_SELFIE_BODY_REFERENCE` 指向自己的授权素材。
- 热点来源 Cookie：由自己的环境配置或私有文件提供；不要写进源码、示例或 Issue。

独立运行某个 Node 命令时，可用 `node --env-file=.env scripts/<入口>.mjs` 加载本地配置。不要把 `.env` 加载进离线测试环境。
