# StagePlayer 演出播放器

一个软件搞定 **音频播放、视频播放、PPT 播放、PDF 播放** 的演出/晚会专用播放器。

技术栈：**Tauri 2 + Rust 后端**，前端为原生 HTML/CSS/JS（无需 Node 构建步骤，pdf.js 已本地内置，完全离线可用）。

## 功能

| 模块 | 说明 |
|------|------|
| 📋 节目单 | 一场演出的时间轴：音频/视频/图片/PPT 页/PDF 页/圣经经文/空白歌词页混排，逐条走台（启动默认进入） |
| 🎵 音频 | 播放列表、上一首/下一首、进度/音量、列表循环/单曲循环、可推送歌曲标题卡到输出窗口 |
| 🎬 视频 | 本地静音预览 + 一键推送到输出窗口播放；以输出窗口为准回报进度，视频面板预览自动对时，切走面板时预览暂停解码，右侧预览只显示缩略图 + 进度 |
| 📊 PPT | Rust 后端解析 `.pptx`（文本+图片+背景+布局），幻灯片缩略图网格，点击即输出，←/→ 翻页 |
| 📄 PDF | pdf.js 渲染缩略图，点击页面输出高清图到输出窗口，←/→ 翻页 |
| 🖥 输出窗口 | 独立无边框窗口，可拖到投影/副屏，F 全屏、B 黑屏、双击切换全屏 |
| ⏱ 计时器 | 正计时（秒表）+ 倒计时，LED 风格大屏显示 |
| 📖 圣经投屏 | 内置和合本，经文大字投屏，一页装不下自动分页 |
| 🎤 伴奏 | 「仅伴奏」实时消人声；AI 人声分离（HTDemucs ONNX，需模型，见 `src-tauri/resources/models/README.txt`）；伴奏导出 WAV |
| 📝 歌词 | 自动读取同目录同名 `.lrc` / `.txt` |
| 🎶 歌词投屏 | 独立歌词库：粘贴歌词用 `[主歌1]` `[副歌]` `[桥段]` 标段落（不标则按空行分段、重复段落自动认作副歌）；大屏当前行居中滚动、上下渐隐，或整段显示；一键跳副歌；背景可选流动渐变（6 套配色 / 自选主色 / 随机）、图片（可从图片取色）、循环视频；可加入节目单 |
| 🔊 声压 | 实时 A/C/Z 计权声压级、Fast/Slow、RTA 频谱、曲线快照 |
| 💾 数据 | 节目单与设置自动保存到 `%APPDATA%\com.stageplayer.app\store.json`，每 10 分钟轮转备份到 `backups/`（保留 20 份）；节目单面板「导出 / 导入」可把单场演出存为 `.json`，换电脑时会提示本机缺失的媒体 |

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
- 歌词投屏：`↑` `↓` / `空格` 换行，`C` 副歌（连按轮换）、`V` 主歌、`Q` 桥段、`P` 预副歌、`E` 尾声，`1`–`9` 第几段，`Home` 回开头，`Enter` 投屏；节目单里当前条是歌词时 `↑` `↓` 与字母键同样可用（`←` `→` / `Enter` 仍是走台）

## 支持格式

- 音频：mp3 / wav / ogg / flac / m4a / aac / wma / opus
- 视频：mp4 / webm / mov（mkv、avi 依赖系统解码器，Windows 上部分格式可能不支持）
- 演示：pptx（*.ppt 老格式请先另存为 pptx*）
- 文档：pdf

## 数据存储

- 运行时仍读写 localStorage（快），每次修改后约 0.8 秒合并写入 `store.json`（先写临时文件再替换，断电不留半截文件）
- 启动时 `js/boot.js` 先恢复数据再加载主程序：
  - 上次有未落盘的改动（异常退出）→ 以本地为准
  - 旧版本留下的本地数据 → 自动迁移进 `store.json`，原文件先备份，**不删除任何旧数据**
  - `store.json` 比本地新（例如 WebView 数据被清掉）→ 用存档恢复，被覆盖的本地数据先另存一份备份
- 只允许运行一个实例：再次双击会把已打开的主窗口唤到前台

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
  js/program-io.js    单场演出导出 / 导入
  js/lyrics-show.js   歌词投屏（歌词库、逐行控制、段落跳转）；lyrics-show-render.js 段落解析 + 扩展屏渲染
  js/boot.js          入口：先恢复存档再加载 main.js；store-sync.js 负责 localStorage ⇄ store.json
src-tauri/
  src/pptx.rs         PPTX 解析（zip + roxmltree，提取文本/图片/背景/坐标，图片转 dataURL；后台线程执行）
  src/audio.rs        原生音频播放（rodio，可选声卡、消人声；音频线程异常自动重启）
  src/stem.rs         AI 人声分离与伴奏缓存
  src/spl.rs          声压计
  src/fileio.rs       保存对话框 / 伴奏导出 / 图片与视频缩略图（视频用 Windows 系统缩略图；只允许写入用户在保存对话框中确认的路径）
  src/wave.rs         波形与频谱数据的原生解码
  src/store.rs        store.json 读写、原子替换与轮转备份
  src/output.rs       输出窗口创建/全屏/关闭
  通信方式            Tauri 事件 output:set（内容推送）、output:video（视频控制）、output:video-time（输出窗口回报视频进度）
```

## 调试

- 冒烟测试：设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npm run dev`，再运行 `node scripts/cdp-smoke.mjs`
- 内存/状态探针：`scripts/diag/`
- 正式版测速：以同样的环境变量直接运行 `src-tauri/target/release/stage-player.exe`，再 `node scripts/diag/bench-release.mjs <音频> <视频> [pptx]`
- 注意：开发版（`127.0.0.1:1430`）与正式版（`tauri.localhost`）的 localStorage 互不共享，但两者读写同一个 `store.json`，启动时较新的一方会恢复到另一方（被覆盖的数据在 `backups/` 里）
- `node scripts/diag/eval.mjs [--output] "<表达式>"` 或 `--file <脚本>`：在主控 / 输出窗口里执行一段 JS
