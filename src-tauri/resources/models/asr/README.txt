流式中文 ASR 模型目录（自动跟词）

架构：
  - 主程序：麦克风采集 + 拼音匹配翻页（Flipper）
  - lyric-asr-sidecar.exe：独立进程跑 sherpa-onnx
    （避免与 AI 人声分离 ort 的 CRT/MD-MT 冲突）

默认下载「Streaming Paraformer 中英双语」到本机缓存：
  %LOCALAPPDATA%\com.stageplayer.app\asr-models\streaming-paraformer-zh-en\

自动下载优先走 GitHub Release（gh-proxy），失败再试 ModelScope 逐文件。
不要用带 -2023-09-14 后缀的错误仓库名（会 404 / 401）。

也可手动放入以下文件后跳过下载：
  encoder.int8.onnx
  decoder.int8.onnx
  tokens.txt

来源（任选）：
  https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
  包名：sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
  ModelScope：https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en

开发构建 sidecar：
  npm run sidecar
