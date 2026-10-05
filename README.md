# 影刻 CineCut

面向快节奏电影混剪的本地 Web 应用。支持高光筛选、手工微调、混剪预览，默认导出 **英文配音＋烧录英文字幕的 MP4**，同时提供英文 SRT。识别、翻译、配音与合成都在本机执行，不发送电影到云端，不需要 API Key。

1.1 版将导出从浏览器实时录制迁移到 FFmpeg，检查实际声音能量和字幕结果；缺音轨、未识别到对白、配音失败时明确报错，不再把空配音当作成功。旧版只支持手动导入字幕，并不会自动生成字幕。

## 本地启动

工作台和本机服务器需要 [Node.js](https://nodejs.org/) 20 或更新版本，无 npm 依赖。导出另需下方的本机引擎。

```sh
git clone https://github.com/YinMinJ/cinecut.git
cd cinecut
npm start
```

打开 [本地工作台](http://127.0.0.1:4173)。Windows 也可以直接双击 `start-local.cmd`，它会启动服务并打开浏览器；关闭终端即可停止。服务器仅监听本机回环地址，不开放到局域网。

端口被占用时可设置 `PORT`，例如 PowerShell 中：

```powershell
$env:PORT = '4174'
npm start
```

验证命令：`npm test`、`npm run check`。

## 英文配音引擎（Windows）

需要 Python 3.10+、[FFmpeg / ffprobe](https://ffmpeg.org/download.html)（含 libass、libx264、AAC）、[faster-whisper](https://github.com/SYSTRAN/faster-whisper) 多语言模型，以及 Windows 已安装的英文语音（如 Microsoft Zira Desktop）。模型使用 [Whisper 的 translate 任务](https://github.com/openai/whisper)，将其支持的源语言对白转为英文；质量会受语言、噪声、口音、多人重叠影响，不能保证每种语言或每句对白都正确。

新电脑首次安装 Python 依赖并下载模型需要联网：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-english.txt
.\.venv\Scripts\python.exe -c "from faster_whisper.utils import download_model; download_model('small', output_dir='models/small')"
powershell -File scripts/configure-english.ps1 -Python .venv/Scripts/python.exe -FFmpeg tools/ffmpeg/bin/ffmpeg.exe -FFprobe tools/ffmpeg/bin/ffprobe.exe -WhisperModel models/small
```

FFmpeg 请先从上述下载入口安装并传入实际路径。也可复用电脑上现有的 Python 环境、FFmpeg 和模型；配置脚本不会安装或覆盖其他项目。请使用多语言模型（如 small / medium / large-v3），不要使用 `.en` 或不支持翻译的 turbo 模型。

配置保存在被 Git 忽略的 `.runtime/config.json`，结构为 `{ "python": "...python.exe", "ffmpeg": "...ffmpeg.exe", "ffprobe": "...ffprobe.exe", "whisperModel": "...模型目录" }`。配置后重启服务。导出弹窗会检查引擎是否可用。运行任务不会自动下载模型。

也可设置 `CINECUT_PYTHON`、`CINECUT_FFMPEG`、`CINECUT_FFPROBE`、`CINECUT_WHISPER_MODEL` 环境变量。英文合成使用 Windows System.Speech 已安装英文音色，目前不提供跨平台配音实现或原角色声音克隆。

## 使用

必须通过 `npm start` 启动本机服务，不能只托管 `dist/` 或双击 HTML。打开页面会加载开放授权示例，也可以导入本地视频。

1. 导入浏览器可解码的视频（推荐 H.264/AAC MP4），可选导入 SRT/VTT 字幕。
2. 选择快节奏或剧情高光、目标时长，点击「寻找高光」。
3. 勾选候选，点击时间线片段调整入点、出点、名称和先后顺序。
4. 点击「混剪预览」，检查节奏；也能直接在原片位置手动标记片段。
5. 点击「导出成片」，默认「英文配音＋英文字幕」，自动识别原语言、翻译、配音和烧字幕。可选择 720p/1080p。
6. 在导出弹窗播放检查，再下载 MP4 和英文 SRT。也可以选择「保留原声＋已导入字幕」模式。

内置 Big Buck Bunny 片段以音乐和音效为主，没有可用于翻译的对白；测试英文配音请导入有清晰人声的影片。没有对白时会提示，不能凭空生成对应对白。JSON 剪辑方案仍只是时间码清单，不包含视频。

## 文章分析与设计依据

原文：https://x.com/GeekCatX/status/2100951857049006110

原文的重点是 TypeSafe Jev 决策模型：用明确的标准、结构化问题和人工校准提升判断可复核性，而不是直接讲电影剪辑。作者后续案例 https://x.com/GeekCatX/status/2101223068580643172 把抽帧描述、Jev 评分、开场/收尾选择与 CapCut 执行结合。我们据此把候选发现、评分、人工编排和真实视频导出分开。

当前评分来自本地帧差与字幕关键词，不调用 Jev，也不宣称理解剧情。Jev 官方模型页 https://docs.typesafe.ai/models 说明它只接受文本。若继续增加语义评分，应先获得字幕/镜头描述，再经服务端代理调用 Jev；密钥不得放在前端。

## 能力与边界

- 预览使用 Blob URL；导出时将素材流式交给 `127.0.0.1` 本机服务，临时保存在 `.runtime/jobs/`，不上传互联网。服务重启会清理旧任务文件；重要成片请在重启前下载保存。
- 最多稀疏采样 180 组画面，长片可能遗漏精彩瞬间，支持手动补充。
- 画面变化衡量运动/切换，不等同于情绪张力、审美质量或模型置信度。
- 快节奏模式以画面变化为主；剧情模式提高字幕关键词权重。
- 英文模式完全替换原声，使用通用英文合成音色，不保留原背景音乐、原角色音色或同步口型。字幕与实际配音时间对应，画面时长不变；过长且无法合理压缩的对白会报错。
- 英文模式自动生成字幕，不要求手动导入。手动字幕只用于高光筛选及原声导出。导出会校验音轨和非零声音，英文模式要求非空对白与字幕。
- 支持 16:9 / 9:16 / 1:1，等比保留完整画面，使用黑边，不自动追踪主体。
- 不自动配乐、识别节拍或理解人物。推荐最新版 Chrome/Edge，输出 H.264/AAC MP4。
- 页面刷新后重新导入视频；剪辑方案保存为 JSON，当前不提供方案恢复入口。
- 字幕文件大小上限 5 MB；单次导出最多 600 秒、100 段；本机素材传输上限由服务控制。切换标签页不再取消导出，关闭页面会尝试停止当前任务。

## 文件

- `dist/index.html`：工作台布局与弹窗。
- `dist/style.css`：响应式深色工作台主题。
- `dist/logic.js`：字幕解析、候选筛选、时间范围和时长计算。
- `dist/app.js`：本地视频处理、预览、人工编辑、导出及可选 WebMCP 工具。
- `dist/export.js`：本机导出设置、素材传输、进度、取消和结果预览。
- `dist/assets/`：示例与授权说明。
- `scripts/server.mjs`：本机静态服务器，支持视频 Range 请求、HEAD 请求和路径检查。
- `scripts/export-api.mjs`：任务、流式素材传输、同源令牌验证、进程和下载管理。
- `scripts/media_worker.py`：FFmpeg 剪辑、英文识别翻译、配音对齐、烧字幕与声音检查。
- `scripts/synthesize.ps1`：Windows 本机英文语音合成。
- `scripts/configure-english.ps1`：保存本机引擎路径。
- `start-local.cmd`：Windows 双击启动入口。
- `tests/`：视频范围请求及剪辑逻辑验证。

## 公开版本

此版本不包含此前的托管身份、登录凭据或任何用户电影。公开可见不等于为所有文件授予统一开源许可；项目代码目前未指定开源许可证，第三方演示素材按下述 CC BY 3.0 许可使用。

## 示例授权

Big Buck Bunny，© 2008 Blender Foundation / [www.bigbuckbunny.org](https://www.bigbuckbunny.org)，CC BY 3.0。
使用 30 秒片段；示例导出带来源署名，并注明 Edited excerpt。详见 `dist/assets/LICENSE-DEMO.txt`。
