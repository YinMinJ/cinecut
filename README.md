# 影刻 CineCut

面向快节奏电影混剪的浏览器应用。视频留在本机，支持高光筛选、手工微调、混剪预览和 WebM 导出。自带无第三方依赖的本地服务器，字体及演示素材均可离线使用。

## 本地启动

需要 [Node.js](https://nodejs.org/) 20 或更新版本。不需要 API Key，也不需要运行 `npm install`。

```sh
git clone https://github.com/YinMinJ/cinecut.git
cd cinecut
npm start
```

打开 **http://127.0.0.1:4173**。Windows 也可以直接双击 `start-local.cmd`，它会启动服务并打开浏览器；关闭终端即可停止。其他系统可以运行 `npm run start:open` 自动打开浏览器。服务器仅监听本机回环地址，不开放到局域网。

端口被占用时可设置 `PORT`，例如 PowerShell 中：

```powershell
$env:PORT = '4174'
npm start
```

验证命令：`npm test`、`npm run check`。

## 使用

以 HTTP/HTTPS 服务运行 `dist/`，不要直接双击 HTML。打开页面会加载开放授权示例，也可以导入本地视频。

1. 导入浏览器可解码的视频（推荐 H.264/AAC MP4），可选导入 SRT/VTT 字幕。
2. 选择快节奏或剧情高光、目标时长，点击「寻找高光」。
3. 勾选候选，点击时间线片段调整入点、出点、名称和先后顺序。
4. 点击「混剪预览」，检查节奏；也能直接在原片位置手动标记片段。
5. 导出 720p/1080p WebM，或保存含时间码和评分依据的 JSON 剪辑方案。JSON 是清单，不包含原视频，也不是成片。

## 文章分析与设计依据

原文：https://x.com/GeekCatX/status/2100951857049006110

原文的重点是 TypeSafe Jev 决策模型：用明确的标准、结构化问题和人工校准提升判断可复核性，而不是直接讲电影剪辑。作者后续案例 https://x.com/GeekCatX/status/2101223068580643172 把抽帧描述、Jev 评分、开场/收尾选择与 CapCut 执行结合。我们据此把候选发现、评分、人工编排和真实视频导出分开。

当前评分来自本地帧差与字幕关键词，不调用 Jev，也不宣称理解剧情。Jev 官方模型页 https://docs.typesafe.ai/models 说明它只接受文本。若继续增加语义评分，应先获得字幕/镜头描述，再经服务端代理调用 Jev；密钥不得放在前端。

## 能力与边界

- 用户电影通过 Blob URL 在本机处理，不上传服务器。
- 最多稀疏采样 180 组画面，长片可能遗漏精彩瞬间，支持手动补充。
- 画面变化衡量运动/切换，不等同于情绪张力、审美质量或模型置信度。
- 快节奏模式以画面变化为主；剧情模式提高字幕关键词权重。
- 导出使用 Canvas + Web Audio + MediaRecorder，保留原声、可烧录字幕，按播放速度生成，非帧精确专业渲染。导出期间请保持页面前台。
- 支持 16:9 / 9:16 / 1:1，等比保留完整画面，使用黑边，不自动追踪主体。
- 不自动配乐、识别节拍、变速或理解人物。推荐最新版 Chrome/Edge；WebM 编码受浏览器支持影响。
- 页面刷新后重新导入视频；剪辑方案保存为 JSON，当前不提供方案恢复入口。
- 字幕文件大小上限 5 MB。导出时切换到后台会取消当前导出，可返回后重新开始。

## 文件

- `dist/index.html`：工作台布局与弹窗。
- `dist/style.css`：响应式深色工作台主题。
- `dist/logic.js`：字幕解析、候选筛选、时间范围和时长计算。
- `dist/app.js`：本地视频处理、预览、人工编辑、导出及可选 WebMCP 工具。
- `dist/assets/`：示例与授权说明。
- `scripts/server.mjs`：本机静态服务器，支持视频 Range 请求、HEAD 请求和路径检查。
- `start-local.cmd`：Windows 双击启动入口。
- `tests/`：视频范围请求及剪辑逻辑验证。

## 公开版本

此版本不包含此前的托管身份、登录凭据或任何用户电影。公开可见不等于为所有文件授予统一开源许可；项目代码目前未指定开源许可证，第三方演示素材按下述 CC BY 3.0 许可使用。

## 示例授权

Big Buck Bunny，© 2008 Blender Foundation / www.bigbuckbunny.org，CC BY 3.0。
使用 30 秒片段；示例导出带来源署名，并注明 Edited excerpt。详见 `dist/assets/LICENSE-DEMO.txt`。
