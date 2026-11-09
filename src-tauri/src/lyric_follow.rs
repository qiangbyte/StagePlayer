//! 歌词自动跟词：主领干声 → 流式 ASR（Sherpa-onnx Online Paraformer）
//! → 拼音模糊匹配 + 换气电平抢跑。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, StreamConfig};
use parking_lot::Mutex;
use pinyin::ToPinyin;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use strsim::jaro_winkler;
use tauri::{AppHandle, Emitter, Manager, State};

const TARGET_SR: u32 = 16_000;
const MODEL_DIR_NAME: &str = "streaming-paraformer-zh-en";
/// GitHub Release 正式包名（无日期后缀；带 -2023-09-14 的是错误仓库名）
const ARCHIVE_NAME: &str = "sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2";
const ARCHIVE_INNER: &str = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";
/// 国内优先 gh-proxy / ModelScope，避免 HuggingFace 401
const ARCHIVE_URLS: &[&str] = &[
  "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
  "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
];
const FILE_URLS: &[(&str, &[&str])] = &[
  (
    "encoder.int8.onnx",
    &[
      "https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/encoder.int8.onnx",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx",
    ],
  ),
  (
    "decoder.int8.onnx",
    &[
      "https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/decoder.int8.onnx",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/decoder.int8.onnx",
    ],
  ),
  (
    "tokens.txt",
    &[
      "https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/tokens.txt",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/tokens.txt",
    ],
  ),
];
const FILES: &[&str] = &["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"];
/// 最小有效体积，避免把空壳/HTML 错误页当成模型
const MIN_FILE_BYTES: &[(&str, u64)] = &[
  ("encoder.int8.onnx", 50 * 1024 * 1024),
  ("decoder.int8.onnx", 20 * 1024 * 1024),
  ("tokens.txt", 10 * 1024),
];

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLineIn {
  pub text: String,
  pub song_id: u32,
  #[serde(default)]
  pub is_title: bool,
}

#[derive(Clone, Debug)]
struct LyricLine {
  song_id: u32,
  is_title: bool,
  raw_head: String,
  head_pinyin: String,
  tail_pinyin: String,
  text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowEvent {
  pub kind: String,
  pub message: String,
  pub text: Option<String>,
  pub index: Option<usize>,
  pub preview: Option<usize>,
  pub rms_db: Option<f32>,
  pub percent: Option<f32>,
  pub busy: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelStatus {
  pub ready: bool,
  pub path: String,
  pub message: String,
}

struct FollowSession {
  stop: Arc<AtomicBool>,
  tx: Sender<WorkerMsg>,
}

pub struct LyricFollowHandle {
  session: Mutex<Option<FollowSession>>,
}

impl LyricFollowHandle {
  pub fn new() -> Self {
    Self {
      session: Mutex::new(None),
    }
  }
}

enum WorkerMsg {
  Audio(Vec<f32>),
  Sync(usize),
  Stop,
}

fn emit(ev: FollowEvent) {
  if let Some(app) = APP.get() {
    let _ = app.emit("sp-lyric-follow", &ev);
  }
}

fn to_clean_pinyin(text: &str) -> String {
  text
    .chars()
    .filter_map(|c| c.to_pinyin())
    .map(|p| p.plain().to_string())
    .collect::<Vec<_>>()
    .join("")
}

fn take_tail(s: &str, max_len: usize) -> String {
  let chars: Vec<char> = s.chars().collect();
  if chars.len() <= max_len {
    s.to_string()
  } else {
    chars[chars.len() - max_len..].iter().collect()
  }
}

fn head_pinyin_of(text: &str) -> String {
  let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
  let n = chars.len().min(6);
  to_clean_pinyin(&chars[..n].iter().collect::<String>())
}

fn tail_pinyin_of(text: &str) -> String {
  // 用整句后半 / 前 8 字作「未唱先翻」锚点
  let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
  if chars.is_empty() {
    return String::new();
  }
  let start = chars.len().saturating_sub(8).max(chars.len() / 2);
  to_clean_pinyin(&chars[start..].iter().collect::<String>())
}

fn build_lines(raw: &[LyricLineIn]) -> Vec<LyricLine> {
  raw
    .iter()
    .enumerate()
    .map(|(_i, l)| LyricLine {
      song_id: l.song_id,
      is_title: l.is_title,
      raw_head: l.text.chars().take(12).collect(),
      head_pinyin: head_pinyin_of(&l.text),
      tail_pinyin: tail_pinyin_of(&l.text),
      text: l.text.clone(),
    })
    .collect()
}

struct FlipperEngine {
  lines: Vec<LyricLine>,
  curr: usize,
  armed: Option<usize>,
  armed_at: Instant,
  last_jump: Instant,
}

impl FlipperEngine {
  fn new(lines: Vec<LyricLine>, start: usize) -> Self {
    let curr = start.min(lines.len().saturating_sub(1));
    Self {
      lines,
      curr,
      armed: None,
      armed_at: Instant::now(),
      last_jump: Instant::now() - Duration::from_secs(10),
    }
  }

  fn on_asr_partial(&mut self, spoken: &str) {
    if self.last_jump.elapsed() < Duration::from_millis(2200) {
      return;
    }
    let spoken_py = to_clean_pinyin(spoken);
    if spoken_py.chars().count() < 4 {
      return;
    }
    let Some(curr) = self.lines.get(self.curr) else {
      return;
    };

    // A. 口令
    if spoken.contains("从头") || spoken.contains("主歌") || spoken.contains("第一段") {
      if let Some(pos) = self
        .lines
        .iter()
        .position(|l| l.song_id == curr.song_id && !l.is_title)
      {
        if pos != self.curr {
          self.jump_to(pos, "主领口令：跳回本曲开头");
          return;
        }
      }
    }
    if spoken.contains("副歌") || spoken.contains("再来") {
      // 跳到同曲内下一处更像副歌的行：首句匹配失败时仅提示
      emit(FollowEvent {
        kind: "partial".into(),
        message: "识别到副歌口令".into(),
        text: Some(spoken.to_string()),
        index: Some(self.curr),
        preview: self.armed,
        rms_db: None,
        percent: None,
        busy: true,
      });
    }

    // B. 刺客：同曲其它行首句
    let tail_py = take_tail(&spoken_py, 18);
    for (pos, line) in self.lines.iter().enumerate() {
      if pos == self.curr || line.is_title || line.song_id != curr.song_id {
        continue;
      }
      if line.head_pinyin.is_empty() {
        continue;
      }
      let sim = jaro_winkler(&tail_py, &line.head_pinyin);
      if sim > 0.86 {
        self.jump_to(
          pos,
          &format!("突发跳段：匹配「{}」({:.2})", line.raw_head, sim),
        );
        return;
      }
    }

    // C. 顺唱：当前句尾锚点 → Armed 下一句
    if self.armed.is_none() && self.curr + 1 < self.lines.len() {
      let next = &self.lines[self.curr + 1];
      if next.song_id == curr.song_id && !next.is_title && !curr.tail_pinyin.is_empty() {
        let hit = spoken_py.contains(&curr.tail_pinyin)
          || jaro_winkler(&tail_py, &curr.tail_pinyin) > 0.85;
        if hit {
          self.armed = Some(self.curr + 1);
          self.armed_at = Instant::now();
          emit(FollowEvent {
            kind: "armed".into(),
            message: format!("已唱到尾句锚点，等待换气翻到下一句"),
            text: Some(spoken.to_string()),
            index: Some(self.curr),
            preview: Some(self.curr + 1),
            rms_db: None,
            percent: None,
            busy: true,
          });
        }
      }
    }

    emit(FollowEvent {
      kind: "partial".into(),
      message: "识别中".into(),
      text: Some(spoken.to_string()),
      index: Some(self.curr),
      preview: self.armed,
      rms_db: None,
      percent: None,
      busy: true,
    });
  }

  fn on_rms(&mut self, rms_db: f32) {
    let Some(target) = self.armed else {
      return;
    };
    let elapsed = self.armed_at.elapsed();
    if elapsed > Duration::from_millis(500) && rms_db < -42.0 {
      self.jump_to(target, "换气抢跑：提前翻下一句");
    } else if elapsed > Duration::from_millis(1800) {
      self.jump_to(target, "延时兜底：提前翻下一句");
    }
  }

  fn jump_to(&mut self, target: usize, reason: &str) {
    if target >= self.lines.len() || target == self.curr {
      return;
    }
    self.curr = target;
    self.armed = None;
    self.last_jump = Instant::now();
    emit(FollowEvent {
      kind: "jump".into(),
      message: reason.into(),
      text: Some(self.lines[target].text.clone()),
      index: Some(target),
      preview: if target + 1 < self.lines.len() {
        Some(target + 1)
      } else {
        None
      },
      rms_db: None,
      percent: None,
      busy: true,
    });
  }

  fn sync(&mut self, idx: usize) {
    if idx < self.lines.len() {
      self.curr = idx;
      self.armed = None;
    }
  }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| e.to_string())?
    .join("asr-models")
    .join(MODEL_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn model_ready(dir: &Path) -> bool {
  MIN_FILE_BYTES.iter().all(|(name, min)| {
    let p = dir.join(name);
    p.is_file() && p.metadata().map(|m| m.len()).unwrap_or(0) >= *min
  })
}

pub fn init_bridge(app: AppHandle) {
  let _ = APP.set(app);
}

#[tauri::command]
pub fn lyric_asr_status(app: AppHandle) -> Result<AsrModelStatus, String> {
  let dir = models_dir(&app)?;
  let ready = model_ready(&dir);
  Ok(AsrModelStatus {
    ready,
    path: dir.to_string_lossy().into(),
    message: if ready {
      "ASR 模型已就绪".into()
    } else {
      "尚未下载流式 Paraformer 模型（约 200MB+）".into()
    },
  })
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
  // 允许 ModelScope/CDN 跳转；禁止跟到 huggingface.co（常 401）
  reqwest::blocking::Client::builder()
    .redirect(reqwest::redirect::Policy::custom(|attempt| {
      let host = attempt.url().host_str().unwrap_or("");
      if host == "huggingface.co" || host.ends_with(".huggingface.co") {
        attempt.stop()
      } else {
        attempt.follow()
      }
    }))
    .connect_timeout(Duration::from_secs(30))
    .timeout(Duration::from_secs(60 * 60))
    .user_agent("StagePlayer/0.1 (ASR model fetch)")
    .build()
    .map_err(|e| e.to_string())
}

fn download_file(url: &str, dest: &Path, label: &str) -> Result<(), String> {
  let client = http_client()?;
  let tmp = dest.with_extension("part");
  let resp = client
    .get(url)
    .header("Accept", "*/*")
    .send()
    .map_err(|e| format!("下载失败: {e}"))?;
  let status = resp.status();
  if status.is_redirection() {
    let loc = resp
      .headers()
      .get(reqwest::header::LOCATION)
      .and_then(|v| v.to_str().ok())
      .unwrap_or("");
    if loc.contains("huggingface.co") {
      return Err(format!("镜像跳转到 HuggingFace（常 401），换源: {url}"));
    }
    return Err(format!("意外重定向 {status} → {loc}"));
  }
  if !status.is_success() {
    return Err(format!("HTTP {status} · {url}"));
  }
  let total = resp.content_length().unwrap_or(0);
  let mut resp = resp;
  let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
  let mut buf = [0u8; 64 * 1024];
  let mut done = 0u64;
  let mut last = Instant::now() - Duration::from_secs(1);
  loop {
    let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    done += n as u64;
    if last.elapsed() >= Duration::from_millis(250) {
      last = Instant::now();
      let pct = if total > 0 {
        done as f32 / total as f32 * 100.0
      } else {
        0.0
      };
      emit(FollowEvent {
        kind: "download".into(),
        message: format!(
          "下载 {label} · {:.1}/{:.1} MB",
          done as f64 / 1e6,
          total as f64 / 1e6
        ),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: Some(pct),
        busy: true,
      });
    }
  }
  file.flush().map_err(|e| e.to_string())?;
  drop(file);
  if done < 1024 {
    let _ = fs::remove_file(&tmp);
    return Err(format!("下载内容过小（{done} bytes），源无效: {url}"));
  }
  if dest.exists() {
    let _ = fs::remove_file(dest);
  }
  fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
  Ok(())
}

fn download_first_ok(urls: &[&str], dest: &Path, label: &str) -> Result<(), String> {
  let mut errors = Vec::new();
  for url in urls {
    emit(FollowEvent {
      kind: "download".into(),
      message: format!("尝试源：{label}"),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: None,
      busy: true,
    });
    match download_file(url, dest, label) {
      Ok(()) => return Ok(()),
      Err(e) => {
        let _ = fs::remove_file(dest.with_extension("part"));
        errors.push(e);
      }
    }
  }
  Err(errors.join(" | "))
}

fn extract_archive_to(archive: &Path, dir: &Path) -> Result<(), String> {
  let staging = dir.join("_extract");
  let _ = fs::remove_dir_all(&staging);
  fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
  // Windows 10+ 自带 tar，可解 .tar.bz2
  let status = std::process::Command::new("tar")
    .args(["-xjf"])
    .arg(archive)
    .arg("-C")
    .arg(&staging)
    .status()
    .map_err(|e| format!("无法调用 tar 解压: {e}"))?;
  if !status.success() {
    return Err(format!("tar 解压失败: {status}"));
  }
  let inner = staging.join(ARCHIVE_INNER);
  let candidates: Vec<PathBuf> = if inner.is_dir() {
    vec![inner, staging.clone()]
  } else {
    let mut v = vec![staging.clone()];
    if let Ok(rd) = fs::read_dir(&staging) {
      for e in rd.flatten() {
        if e.path().is_dir() {
          v.push(e.path());
        }
      }
    }
    v
  };
  for name in FILES {
    let from = candidates
      .iter()
      .map(|r| r.join(name))
      .find(|p| p.is_file())
      .ok_or_else(|| format!("压缩包缺少 {name}"))?;
    let to = dir.join(name);
    if to.exists() {
      let _ = fs::remove_file(&to);
    }
    fs::copy(&from, &to).map_err(|e| format!("复制 {name} 失败: {e}"))?;
  }
  let _ = fs::remove_dir_all(&staging);
  Ok(())
}

fn ensure_model_files(dir: &Path) -> Result<(), String> {
  if model_ready(dir) {
    return Ok(());
  }
  // 1) 优先 GitHub Release 整包（绕开 HF 401）
  let archive = dir.join(ARCHIVE_NAME);
  let archive_ok = archive.is_file()
    && archive.metadata().map(|m| m.len()).unwrap_or(0) > 100 * 1024 * 1024;
  if !archive_ok {
    let _ = fs::remove_file(&archive);
    emit(FollowEvent {
      kind: "download".into(),
      message: "从 GitHub Release 下载 ASR 模型包…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    if let Err(e) = download_first_ok(ARCHIVE_URLS, &archive, ARCHIVE_NAME) {
      emit(FollowEvent {
        kind: "download".into(),
        message: format!("整包下载失败，改 ModelScope 逐文件：{e}"),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: None,
        busy: true,
      });
    }
  }
  if archive.is_file() && archive.metadata().map(|m| m.len()).unwrap_or(0) > 100 * 1024 * 1024 {
    emit(FollowEvent {
      kind: "download".into(),
      message: "正在解压 ASR 模型包…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(90.0),
      busy: true,
    });
    if let Err(e) = extract_archive_to(&archive, dir) {
      emit(FollowEvent {
        kind: "download".into(),
        message: format!("解压失败，改逐文件：{e}"),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: None,
        busy: true,
      });
    } else if model_ready(dir) {
      return Ok(());
    }
  }
  // 2) 回退：ModelScope / 镜像逐文件
  let mut errs = Vec::new();
  for (name, urls) in FILE_URLS {
    let dest = dir.join(name);
    let min = MIN_FILE_BYTES
      .iter()
      .find(|(n, _)| *n == *name)
      .map(|(_, m)| *m)
      .unwrap_or(64);
    if dest.is_file() && dest.metadata().map(|m| m.len()).unwrap_or(0) >= min {
      continue;
    }
    if let Err(e) = download_first_ok(urls, &dest, name) {
      errs.push(format!("{name}: {e}"));
    }
  }
  if model_ready(dir) {
    return Ok(());
  }
  Err(format!(
    "ASR 模型下载失败。可手动把 encoder.int8.onnx / decoder.int8.onnx / tokens.txt 放到：{}\n\
也可从 ModelScope 下载：https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en\n{}",
    dir.display(),
    errs.join("\n")
  ))
}

#[tauri::command]
pub async fn lyric_asr_ensure_model(app: AppHandle) -> Result<AsrModelStatus, String> {
  let dir = models_dir(&app)?;
  if model_ready(&dir) {
    return Ok(AsrModelStatus {
      ready: true,
      path: dir.to_string_lossy().into(),
      message: "ASR 模型已就绪".into(),
    });
  }
  emit(FollowEvent {
    kind: "download".into(),
    message: "开始下载流式 Paraformer 模型（GitHub 镜像优先）…".into(),
    text: None,
    index: None,
    preview: None,
    rms_db: None,
    percent: Some(0.0),
    busy: true,
  });
  let dir_bg = dir.clone();
  tauri::async_runtime::spawn_blocking(move || ensure_model_files(&dir_bg))
    .await
    .map_err(|e| e.to_string())??;

  emit(FollowEvent {
    kind: "download".into(),
    message: "ASR 模型下载完成".into(),
    text: None,
    index: None,
    preview: None,
    rms_db: None,
    percent: Some(100.0),
    busy: false,
  });
  Ok(AsrModelStatus {
    ready: true,
    path: dir.to_string_lossy().into(),
    message: "ASR 模型已就绪".into(),
  })
}

/// 独立 ASR 进程路径（与主程序 ort/MD 隔离，避免 LNK2038）。
fn find_asr_sidecar() -> Result<PathBuf, String> {
  if let Ok(p) = std::env::var("STAGE_PLAYER_ASR_SIDECAR") {
    let pb = PathBuf::from(p);
    if pb.is_file() {
      return Ok(pb);
    }
  }
  let names = [
    "lyric-asr-sidecar.exe",
    "lyric-asr-sidecar-x86_64-pc-windows-msvc.exe",
    "lyric-asr-sidecar",
  ];
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      for name in names {
        let cand = dir.join(name);
        if cand.is_file() {
          return Ok(cand);
        }
      }
    }
  }
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  for profile in ["debug", "release"] {
    let cand = manifest
      .join("target")
      .join(profile)
      .join("lyric-asr-sidecar.exe");
    if cand.is_file() {
      return Ok(cand);
    }
  }
  Err(
    "找不到 lyric-asr-sidecar.exe。请先执行: cargo build -p lyric-asr-sidecar".into(),
  )
}

fn write_frame(stdin: &mut impl Write, tag: &[u8; 4], payload: &[u8]) -> Result<(), String> {
  stdin.write_all(tag).map_err(|e| e.to_string())?;
  stdin
    .write_all(&(payload.len() as u32).to_le_bytes())
    .map_err(|e| e.to_string())?;
  stdin.write_all(payload).map_err(|e| e.to_string())?;
  stdin.flush().map_err(|e| e.to_string())
}

fn write_audio_frame(stdin: &mut impl Write, samples: &[f32]) -> Result<(), String> {
  stdin.write_all(b"AUD\0").map_err(|e| e.to_string())?;
  stdin
    .write_all(&(samples.len() as u32).to_le_bytes())
    .map_err(|e| e.to_string())?;
  for &s in samples {
    stdin
      .write_all(&s.to_le_bytes())
      .map_err(|e| e.to_string())?;
  }
  stdin.flush().map_err(|e| e.to_string())
}

fn rms_db(samples: &[f32]) -> f32 {
  if samples.is_empty() {
    return -120.0;
  }
  let mut s = 0.0f64;
  for &x in samples {
    s += (x as f64) * (x as f64);
  }
  let rms = (s / samples.len() as f64).sqrt();
  if rms < 1e-9 {
    -120.0
  } else {
    (20.0 * rms.log10()) as f32
  }
}

fn resample_linear(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
  if from_sr == 0 || to_sr == 0 || input.is_empty() {
    return Vec::new();
  }
  if from_sr == to_sr {
    return input.to_vec();
  }
  let ratio = to_sr as f64 / from_sr as f64;
  let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
  let mut out = Vec::with_capacity(out_len);
  for i in 0..out_len {
    let src = i as f64 / ratio;
    let i0 = src.floor() as usize;
    let i1 = (i0 + 1).min(input.len() - 1);
    let t = (src - i0 as f64) as f32;
    out.push(input[i0] * (1.0 - t) + input[i1] * t);
  }
  out
}

fn extract_mono(interleaved: &[f32], channels: usize, ch: usize) -> Vec<f32> {
  if channels <= 1 {
    return interleaved.to_vec();
  }
  interleaved
    .chunks(channels)
    .map(|frame| frame.get(ch).copied().unwrap_or(0.0))
    .collect()
}

#[tauri::command]
pub async fn lyric_follow_start(
  app: AppHandle,
  h: State<'_, LyricFollowHandle>,
  lines: Vec<LyricLineIn>,
  start_index: usize,
  device_index: Option<usize>,
  channel: Option<u32>,
) -> Result<(), String> {
  if lines.is_empty() {
    return Err("没有歌词行".into());
  }
  let dir = models_dir(&app)?;
  if !model_ready(&dir) {
    return Err("ASR 模型未就绪，请先下载".into());
  }

  if let Some(sess) = h.session.lock().take() {
    sess.stop.store(true, Ordering::SeqCst);
    let _ = sess.tx.send(WorkerMsg::Stop);
  }

  let stop = Arc::new(AtomicBool::new(false));
  let (tx, rx) = mpsc::channel::<WorkerMsg>();
  *h.session.lock() = Some(FollowSession {
    stop: Arc::clone(&stop),
    tx: tx.clone(),
  });

  let encoder = dir.join("encoder.int8.onnx");
  let decoder = dir.join("decoder.int8.onnx");
  let tokens = dir.join("tokens.txt");
  let built = build_lines(&lines);
  let start = start_index.min(built.len().saturating_sub(1));
  let stop_w = Arc::clone(&stop);
  let sidecar_path = find_asr_sidecar()?;

  // ASR sidecar + 状态机线程（sidecar 独立链接 sherpa/MT，避免与 ort/MD 冲突）
  thread::Builder::new()
    .name("lyric-asr".into())
    .spawn(move || {
      let mut child = match Command::new(&sidecar_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
      {
        Ok(c) => c,
        Err(e) => {
          emit(FollowEvent {
            kind: "error".into(),
            message: format!("启动 ASR sidecar 失败: {e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
      };
      let mut child_in = match child.stdin.take() {
        Some(s) => s,
        None => {
          emit(FollowEvent {
            kind: "error".into(),
            message: "ASR sidecar 无 stdin".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          let _ = child.kill();
          return;
        }
      };
      let child_out = match child.stdout.take() {
        Some(s) => s,
        None => {
          emit(FollowEvent {
            kind: "error".into(),
            message: "ASR sidecar 无 stdout".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          let _ = child.kill();
          return;
        }
      };

      let init = serde_json::json!({
        "encoder": encoder.to_string_lossy(),
        "decoder": decoder.to_string_lossy(),
        "tokens": tokens.to_string_lossy(),
      });
      let init_bytes = init.to_string().into_bytes();
      if let Err(e) = write_frame(&mut child_in, b"INIT", &init_bytes) {
        emit(FollowEvent {
          kind: "error".into(),
          message: format!("ASR INIT 失败: {e}"),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        let _ = child.kill();
        return;
      }

      let (asr_tx, asr_rx) = mpsc::channel::<serde_json::Value>();
      thread::spawn(move || {
        let reader = BufReader::new(child_out);
        for line in reader.lines().flatten() {
          if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if asr_tx.send(v).is_err() {
              break;
            }
          }
        }
      });

      let mut engine = FlipperEngine::new(built, start);
      let mut ready = false;
      let mut last_level_emit = Instant::now() - Duration::from_secs(1);
      let wait_deadline = Instant::now() + Duration::from_secs(30);
      while !ready && Instant::now() < wait_deadline {
        // 模型加载中用户就点了停止（或重新开启）：立即结束 sidecar，不等加载完，
        // 否则旧进程会多跑到加载完成，还会给界面补发一条过期的「已启动」
        if stop_w.load(Ordering::SeqCst) {
          let _ = child_in.write_all(b"STOP");
          drop(child_in);
          let _ = child.kill();
          let _ = child.wait();
          emit(FollowEvent {
            kind: "stop".into(),
            message: "语音跟词已停止".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
        // 加载期间麦克风线程也在往 rx 送音频：丢掉过期音频以免堆积，换行同步照常处理
        while let Ok(msg) = rx.try_recv() {
          match msg {
            WorkerMsg::Stop => stop_w.store(true, Ordering::SeqCst),
            WorkerMsg::Sync(i) => engine.sync(i),
            WorkerMsg::Audio(_) => {}
          }
        }
        match asr_rx.recv_timeout(Duration::from_millis(100)) {
          Ok(v) => {
            let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            if kind == "ready" {
              ready = true;
            } else if kind == "error" {
              let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR 初始化失败");
              emit(FollowEvent {
                kind: "error".into(),
                message: msg.into(),
                text: None,
                index: None,
                preview: None,
                rms_db: None,
                percent: None,
                busy: false,
              });
              let _ = child_in.write_all(b"STOP");
              let _ = child.kill();
              return;
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => {
            emit(FollowEvent {
              kind: "error".into(),
              message: "ASR sidecar 提前退出".into(),
              text: None,
              index: None,
              preview: None,
              rms_db: None,
              percent: None,
              busy: false,
            });
            let _ = child.kill();
            return;
          }
        }
      }
      if !ready {
        emit(FollowEvent {
          kind: "error".into(),
          message: "ASR sidecar 就绪超时".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        let _ = child_in.write_all(b"STOP");
        let _ = child.kill();
        return;
      }

      emit(FollowEvent {
        kind: "start".into(),
        message: "语音跟词已启动（主领干声 · sidecar）".into(),
        text: None,
        index: Some(engine.curr),
        preview: None,
        rms_db: None,
        percent: None,
        busy: true,
      });

      while !stop_w.load(Ordering::SeqCst) {
        while let Ok(v) = asr_rx.try_recv() {
          let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
          match kind {
            "partial" => {
              if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                engine.on_asr_partial(text);
              }
            }
            "error" => {
              let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR 错误");
              emit(FollowEvent {
                kind: "error".into(),
                message: msg.into(),
                text: None,
                index: Some(engine.curr),
                preview: engine.armed,
                rms_db: None,
                percent: None,
                busy: true,
              });
            }
            _ => {}
          }
        }

        match rx.recv_timeout(Duration::from_millis(50)) {
          Ok(WorkerMsg::Stop) => break,
          Ok(WorkerMsg::Sync(i)) => engine.sync(i),
          Ok(WorkerMsg::Audio(samples)) => {
            if samples.is_empty() {
              continue;
            }
            let db = rms_db(&samples);
            engine.on_rms(db);
            if last_level_emit.elapsed() >= Duration::from_millis(160) {
              last_level_emit = Instant::now();
              let hearing = db > -48.0;
              emit(FollowEvent {
                kind: "level".into(),
                message: if hearing {
                  "干声有电平".into()
                } else {
                  "等待干声".into()
                },
                text: None,
                index: Some(engine.curr),
                preview: engine.armed,
                rms_db: Some(db),
                percent: Some(((db + 60.0) / 60.0 * 100.0).clamp(0.0, 100.0)),
                busy: true,
              });
            }
            if let Err(e) = write_audio_frame(&mut child_in, &samples) {
              emit(FollowEvent {
                kind: "error".into(),
                message: format!("向 ASR 写音频失败: {e}"),
                text: None,
                index: Some(engine.curr),
                preview: engine.armed,
                rms_db: None,
                percent: None,
                busy: false,
              });
              break;
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
      }

      let _ = child_in.write_all(b"STOP");
      let _ = child_in.flush();
      drop(child_in);
      let _ = child.kill();
      let _ = child.wait();
      emit(FollowEvent {
        kind: "stop".into(),
        message: "语音跟词已停止".into(),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: None,
        busy: false,
      });
    })
    .map_err(|e| e.to_string())?;

  // 采集线程
  let stop_c = Arc::clone(&stop);
  let ch = channel.unwrap_or(0);
  thread::Builder::new()
    .name("lyric-mic".into())
    .spawn(move || {
      let host = cpal::default_host();
      let devices: Vec<_> = host
        .input_devices()
        .map(|d| d.collect())
        .unwrap_or_default();
      let device = match device_index {
        Some(i) => devices.get(i).cloned(),
        None => host.default_input_device(),
      };
      let Some(device) = device else {
        emit(FollowEvent {
          kind: "error".into(),
          message: "找不到输入设备（请接主领干声）".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        return;
      };
      let device_name = device
        .name()
        .unwrap_or_else(|_| "默认输入".into());
      let Ok(config) = device.default_input_config() else {
        emit(FollowEvent {
          kind: "error".into(),
          message: "无法读取输入配置".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        return;
      };
      let sample_format = config.sample_format();
      let stream_config: StreamConfig = config.clone().into();
      let channels = stream_config.channels as usize;
      let sr = stream_config.sample_rate.0;
      let ch_i = (ch as usize).min(channels.saturating_sub(1));
      let tx_audio = tx.clone();
      emit(FollowEvent {
        kind: "input".into(),
        message: format!("已打开输入 · {device_name} · 声道 {}", ch_i + 1),
        text: Some(device_name.clone()),
        index: None,
        preview: None,
        rms_db: Some(-90.0),
        percent: Some(0.0),
        busy: true,
      });

      let err_fn = |e| eprintln!("lyric mic error: {e}");
      let make = |tx: Sender<WorkerMsg>, stop: Arc<AtomicBool>| {
        move |data: &[f32]| {
          if stop.load(Ordering::SeqCst) {
            return;
          }
          let mono = extract_mono(data, channels, ch_i);
          let resampled = resample_linear(&mono, sr, TARGET_SR);
          let _ = tx.send(WorkerMsg::Audio(resampled));
        }
      };

      let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[f32], _| cb(data)
          },
          err_fn,
          None,
        ),
        SampleFormat::I16 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[i16], _| {
              let buf: Vec<f32> = data.iter().map(|s| (*s).to_sample::<f32>()).collect();
              cb(&buf);
            }
          },
          err_fn,
          None,
        ),
        SampleFormat::U16 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[u16], _| {
              let buf: Vec<f32> = data.iter().map(|s| (*s).to_sample::<f32>()).collect();
              cb(&buf);
            }
          },
          err_fn,
          None,
        ),
        other => {
          emit(FollowEvent {
            kind: "error".into(),
            message: format!("不支持的采样格式: {other:?}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
      };

      match stream {
        Ok(s) => {
          if let Err(e) = s.play() {
            emit(FollowEvent {
              kind: "error".into(),
              message: format!("无法打开输入: {e}"),
              text: None,
              index: None,
              preview: None,
              rms_db: None,
              percent: None,
              busy: false,
            });
            return;
          }
          while !stop_c.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
          }
          drop(s);
        }
        Err(e) => {
          emit(FollowEvent {
            kind: "error".into(),
            message: format!("创建输入流失败: {e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
        }
      }
    })
    .map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
pub fn lyric_follow_stop(h: State<'_, LyricFollowHandle>) -> Result<(), String> {
  if let Some(sess) = h.session.lock().take() {
    sess.stop.store(true, Ordering::SeqCst);
    let _ = sess.tx.send(WorkerMsg::Stop);
  }
  Ok(())
}

#[tauri::command]
pub fn lyric_follow_sync(h: State<'_, LyricFollowHandle>, index: usize) -> Result<(), String> {
  if let Some(sess) = h.session.lock().as_ref() {
    let _ = sess.tx.send(WorkerMsg::Sync(index));
  }
  Ok(())
}
