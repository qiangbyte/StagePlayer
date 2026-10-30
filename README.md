# StagePlayer 演出播放器

一个软件搞定 **音频播放、视频播放、PPT 播放、PDF 播放** 的演出/晚会专用播放器。

技术栈：**Tauri 2 + Rust 后端**，前端为原生 HTML/CSS/JS（无需 Node 构建步骤，pdf.js 已本地内置，完全离线可用）。

## 功能

| 模块 | 说明 |
|------|------|
| 📋 节目单 | 一场演出的时间轴：音频/视频/图片/PPT 页/PDF 页/圣经经文/空白歌词页混排，逐条走台（启动默认进入） |
| 🎵 音频 | 播放列表、上一首/下一首、进度/音量、列表循环/单曲循环、可推送歌曲标题卡到输出窗口 |
| 🎬 视频 | 本地静音预览 + 一键推送到输出窗口播放，输出端进度/音量跟随主控 |
| 📊 PPT | Rust 后端解析 `.pptx`（文本+图片+背景+布局），幻灯片缩略图网格，点击即输出，←/→ 翻页 |
| 📄 PDF | pdf.js 渲染缩略图，点击页面输出高清图到输出窗口，←/→ 翻页 |
| 🖥 输出窗口 | 独立无边框窗口，可拖到投影/副屏，F 全屏、B 黑屏、双击切换全屏 |
| ⏱ 计时器 | 正计时（秒表）+ 倒计时，LED 风格大屏显示 |
| 📖 圣经投屏 | 内置和合本，经文大字投屏，一页装不下自动分页 |
| 🎤 伴奏 | 「仅伴奏」实时消人声；AI 人声分离（HTDemucs ONNX，需模型，见 `src-tauri/resources/models/README.txt`）；伴奏导出 WAV |
| 📝 歌词 | 自动读取同目录同名 `.lrc` / `.txt` |
| 🔊 声压 | 实时 A/C/Z 计权声压级、Fast/Slow、RTA 频谱、曲线快照 |

## 运行

```powershell
npm install       # 安装 Tauri CLI 与 pdfjs-dist
npm run dev       # 开发运行
npm run build     # 打包 NSIS 安装包
```

## 快捷键（主控窗口）

- `←` / `→`：PPT / PDF 上下页（需先点击过某一页）
- `空格`：音频播放/暂停
- `F`：打开并全屏输出窗口
- `B`：黑屏 / 恢复

## 支持格式

- 音频：mp3 / wav / ogg / flac / m4a / aac / wma / opus
- 视频：mp4 / webm / mov（mkv、avi 依赖系统解码器，Windows 上部分格式可能不支持）
- 演示：pptx（*.ppt 老格式请先另存为 pptx*）
- 文档：pdf

## 架构

```
src/                  前端（主控窗口 + 输出窗口）
  index.html          主控界面（顶栏计时器/输出控制、侧栏列表、四模块面板、输出预览）
  output.html         独立输出窗口（全屏播放画面）
  js/output-core.js   输出渲染核心（主控预览与输出窗口共用）
  js/slide-render.js  PPT 幻灯片 HTML 渲染器
  js/{audio,video,ppt,pdf}.js   四大功能模块
  js/audio-meters.js  频谱 + VU 表；audio-wave.js 波形解码；audio-stem-ui.js AI 分离进度
  js/program.js       节目单主流程（走台/定时开播/大厅倒计时）
  js/program-store.js 节目数据规范化与存储；program-thumbs.js 网格缩略图
  js/program-blank.js 空白歌曲页面板；program-bible.js 圣经经文面板
  js/program-lobby.js 大厅页（开场倒计时）；program-cue.js 定时开播
src-tauri/
  src/pptx.rs         PPTX 解析（zip + roxmltree，提取文本/图片/背景/坐标，图片转 dataURL；后台线程执行）
  src/audio.rs        原生音频播放（rodio，可选声卡、消人声；音频线程异常自动重启）
  src/stem.rs         AI 人声分离与伴奏缓存
  src/spl.rs          声压计
  src/fileio.rs       保存对话框 / 伴奏导出 / 图片与视频缩略图（视频用 Windows 系统缩略图；只允许写入用户在保存对话框中确认的路径）
  src/wave.rs         波形与频谱数据的原生解码
  src/output.rs       输出窗口创建/全屏/关闭
  通信方式            Tauri 事件 output:set（内容推送）、output:video（视频控制）
```

## 调试

- 冒烟测试：设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npm run dev`，再运行 `node scripts/cdp-smoke.mjs`
- 内存/状态探针：`scripts/diag/`
