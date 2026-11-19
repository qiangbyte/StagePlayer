//! 录音文件转文字：本地 SenseVoice（sherpa-onnx sidecar），音频不出电脑。
//!
//! 流程：symphonia 流式解码（m4a/mp3/wav/flac/ogg…）→ 混单声道 → 16 kHz →
//! 按静音切成 ≤25 秒的小段 → 逐段送 sidecar 识别 → 按字数合并成带时间戳的段落。
//! 全程不整段载入内存，长录音（1 小时以上）也不会撑爆内存。

use crate::dictation_polish::{
  apply_hotwords, ensure_sense_voice, load_hotwords, sense_voice_dir, sense_voice_ready,
  spawn_sidecar, wait_ready,
};
use crate::lyric_follow::{write_audio_frame, write_frame};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const SR: usize = 16_000;
/// 单段最长 25 秒（SenseVoice 对 30 秒内效果最好）
const MAX_CHUNK: usize = 25 * SR;
/// 至少 2 秒才允许在静音处切
const MIN_CUT: usize = 2 * SR;
/// 连续静音 200ms 视为停顿
const SILENCE_MIN: usize = SR / 5;
/// 20ms 一个分析窗
const WIN: usize = SR / 50;
const SILENCE_DB: f64 = -42.0;
/// 合并成段落的目标字数
const PARA_CHARS: usize = 140;
/// 单段识别超时
const CHUNK_TIMEOUT: Duration = Duration::from_secs(180);

const LANGS: &[&str] = &["auto", "zh", "yue", "en", "ja", "ko"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeEvent {
  /// prepare | download | progress | para | done | error | cancelled
  pub phase: String,
  pub message: String,
  pub percent: f32,
  pub start: Option<f64>,
  pub text: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaOut {
  pub start: f64,
  pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
  pub paragraphs: Vec<ParaOut>,
  pub duration_sec: f64,
  pub elapsed_sec: f64,
  pub chunks: usize,
  pub language: String,
}

#[derive(Clone)]
pub struct TranscribeState {
  running: Arc<AtomicBool>,
  cancel: Arc<AtomicBool>,
}

impl Default for TranscribeState {
  fn default() -> Self {
    Self {
      running: Arc::new(AtomicBool::new(false)),
      cancel: Arc::new(AtomicBool::new(false)),
    }
  }
}

struct RunGuard(Arc<AtomicBool>);
impl Drop for RunGuard {
  fn drop(&mut self) {
    self.0.store(false, Ordering::SeqCst);
  }
}

fn ev(phase: &str, message: impl Into<String>, percent: f32) -> TranscribeEvent {
  TranscribeEvent {
    phase: phase.into(),
    message: message.into(),
    percent,
    start: None,
    text: None,
  }
}

// ───────────────────────── 读取进度（按已读字节估算） ─────────────────────────

struct CountingFile {
  inner: File,
  len: u64,
  cur: u64,
  shared: Arc<AtomicU64>,
}

impl MediaSource for CountingFile {
  fn is_seekable(&self) -> bool {
    true
  }

  fn byte_len(&self) -> Option<u64> {
    Some(self.len)
  }
}

impl Read for CountingFile {
  fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
    let n = self.inner.read(buf)?;
    self.cur += n as u64;
    self.shared.store(self.cur, Ordering::Relaxed);
    Ok(n)
  }
}

impl Seek for CountingFile {
  fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
    let p = self.inner.seek(pos)?;
    self.cur = p;
    self.shared.store(p, Ordering::Relaxed);
    Ok(p)
  }
}

// ───────────────────────── 降采样（面积平均，兼作低通） ─────────────────────────

struct Down {
  step: f64,
  pos: f64,
  next: f64,
  sum: f64,
  cnt: u32,
}

impl Down {
  fn new(sr: u32) -> Self {
    let step = sr.max(1) as f64 / SR as f64;
    Self {
      step,
      pos: 0.0,
      next: step,
      sum: 0.0,
      cnt: 0,
    }
  }

  fn push(&mut self, x: f32, out: &mut Vec<f32>) {
    self.sum += x as f64;
    self.cnt += 1;
    self.pos += 1.0;
    let mut emitted = false;
    while self.pos >= self.next {
      out.push((self.sum / self.cnt.max(1) as f64) as f32);
      self.next += self.step;
      emitted = true;
    }
    if emitted {
      self.sum = 0.0;
      self.cnt = 0;
    }
  }
}

// ───────────────────────── 静音切段 ─────────────────────────

struct Seg {
  cur: Vec<f32>,
  /// cur[0] 在整段音频里的 16k 采样序号
  cur_start: usize,
  silence_run: usize,
  win_sum: f64,
  win_n: usize,
}

impl Seg {
  fn new() -> Self {
    Self {
      cur: Vec::with_capacity(MAX_CHUNK + WIN),
      cur_start: 0,
      silence_run: 0,
      win_sum: 0.0,
      win_n: 0,
    }
  }

  fn push(&mut self, x: f32) -> Option<(usize, Vec<f32>)> {
    self.cur.push(x);
    self.win_sum += (x as f64) * (x as f64);
    self.win_n += 1;
    if self.win_n < WIN {
      return None;
    }
    let rms = (self.win_sum / self.win_n as f64).sqrt();
    let db = if rms < 1e-9 { -120.0 } else { 20.0 * rms.log10() };
    if db < SILENCE_DB {
      self.silence_run += self.win_n;
    } else {
      self.silence_run = 0;
    }
    self.win_sum = 0.0;
    self.win_n = 0;

    let elapsed = self.cur.len();
    let by_silence = self.silence_run >= SILENCE_MIN && elapsed >= MIN_CUT;
    if by_silence || elapsed >= MAX_CHUNK {
      let cut = if self.silence_run >= SILENCE_MIN {
        elapsed - self.silence_run / 2
      } else {
        elapsed
      };
      let cut = cut.clamp(1, elapsed);
      let rest = self.cur.split_off(cut);
      let chunk = std::mem::replace(&mut self.cur, rest);
      let start = self.cur_start;
      self.cur_start += cut;
      self.silence_run = 0;
      return Some((start, chunk));
    }
    None
  }

  fn finish(&mut self) -> Option<(usize, Vec<f32>)> {
    if self.cur.is_empty() {
      return None;
    }
    let chunk = std::mem::take(&mut self.cur);
    Some((self.cur_start, chunk))
  }
}

// ───────────────────────── 识别 worker ─────────────────────────

struct Worker<'a> {
  child_in: std::process::ChildStdin,
  rx: mpsc::Receiver<Value>,
  cancel: &'a AtomicBool,
  emit: &'a mut dyn FnMut(TranscribeEvent),
  hot: &'a [(String, String)],
  pos: Arc<AtomicU64>,
  file_len: u64,
  paras: Vec<ParaOut>,
  buf_text: String,
  buf_start: f64,
  chunks: usize,
}

impl<'a> Worker<'a> {
  fn percent(&self) -> f32 {
    let p = self.pos.load(Ordering::Relaxed) as f64 / self.file_len.max(1) as f64 * 100.0;
    p.clamp(0.0, 99.0) as f32
  }

  fn recognize(&mut self, chunk: &[f32]) -> Result<String, String> {
    for piece in chunk.chunks(32_000) {
      write_audio_frame(&mut self.child_in, piece)?;
    }
    write_frame(&mut self.child_in, b"FIN\0", &[])?;
    let deadline = Instant::now() + CHUNK_TIMEOUT;
    loop {
      if self.cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
      }
      if Instant::now() > deadline {
        return Err("单段识别超时".into());
      }
      match self.rx.recv_timeout(Duration::from_millis(200)) {
        Ok(v) => match v.get("kind").and_then(|x| x.as_str()).unwrap_or("") {
          "final" => {
            return Ok(
              v.get("text")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
            )
          }
          "error" => {
            return Err(
              v.get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("识别失败")
                .to_string(),
            )
          }
          _ => {}
        },
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Err(mpsc::RecvTimeoutError::Disconnected) => return Err("识别进程已退出".into()),
      }
    }
  }

  fn flush_para(&mut self) {
    let t = self.buf_text.trim();
    if t.is_empty() {
      self.buf_text.clear();
      return;
    }
    let text = apply_hotwords(t, self.hot);
    let start = self.buf_start;
    self.buf_text.clear();
    let pct = self.percent();
    let mut e = ev("para", "", pct);
    e.start = Some(start);
    e.text = Some(text.clone());
    (self.emit)(e);
    self.paras.push(ParaOut { start, text });
  }

  fn handle_chunk(&mut self, start_sample: usize, chunk: Vec<f32>) -> Result<(), String> {
    if self.cancel.load(Ordering::SeqCst) {
      return Err("已取消".into());
    }
    // 太短或几乎全是静音的块不用识别
    if chunk.len() < SR / 4 {
      return Ok(());
    }
    let peak = chunk.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak < 0.003 {
      return Ok(());
    }
    let start_sec = start_sample as f64 / SR as f64;
    let text = self.recognize(&chunk)?;
    self.chunks += 1;
    let t = text.trim();
    if !t.is_empty() {
      if self.buf_text.is_empty() {
        self.buf_start = start_sec;
      } else {
        // 英文单词之间补空格，中文直接相连
        let last = self.buf_text.chars().last();
        let first = t.chars().next();
        if matches!((last, first), (Some(a), Some(b)) if a.is_ascii_alphanumeric() && b.is_ascii_alphanumeric())
        {
          self.buf_text.push(' ');
        }
      }
      self.buf_text.push_str(t);
      if self.buf_text.chars().count() >= PARA_CHARS {
        self.flush_para();
      }
    }
    let pct = self.percent();
    let mm = (start_sec as u64) / 60;
    let ss = (start_sec as u64) % 60;
    (self.emit)(ev(
      "progress",
      format!("转写中… 已处理到 {mm:02}:{ss:02}（{} 段）", self.chunks),
      pct,
    ));
    Ok(())
  }
}

/// 核心：不依赖 Tauri，便于脚本/测试直接调用
pub fn run_transcribe(
  path: &str,
  model_dir: &Path,
  language: &str,
  hot: &[(String, String)],
  cancel: &AtomicBool,
  emit: &mut dyn FnMut(TranscribeEvent),
) -> Result<TranscribeResult, String> {
  let started = Instant::now();
  let file = File::open(path).map_err(|e| format!("无法打开音频: {e}"))?;
  let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
  let shared = Arc::new(AtomicU64::new(0));
  let mss = MediaSourceStream::new(
    Box::new(CountingFile {
      inner: file,
      len: file_len,
      cur: 0,
      shared: shared.clone(),
    }),
    Default::default(),
  );
  let mut hint = Hint::new();
  if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
    hint.with_extension(ext);
  }
  let probed = symphonia::default::get_probe()
    .format(
      &hint,
      mss,
      &FormatOptions::default(),
      &MetadataOptions::default(),
    )
    .map_err(|e| format!("无法识别该音频格式（支持 m4a/mp3/wav/flac/ogg/aac）：{e}"))?;
  let mut format = probed.format;
  let (track_id, codec_params) = {
    let track = format
      .tracks()
      .iter()
      .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
      .ok_or_else(|| "文件里没有可解码的音轨".to_string())?;
    (track.id, track.codec_params.clone())
  };
  let mut sym_decoder = symphonia::default::get_codecs()
    .make(&codec_params, &DecoderOptions::default())
    .map_err(|e| format!("不支持该音频编码：{e}"))?;

  emit(ev("prepare", "启动本地识别引擎…", 0.0));
  let (mut child, child_in, child_out) = spawn_sidecar()?;
  let (tx, rx) = mpsc::channel::<Value>();
  std::thread::spawn(move || {
    for line in child_out.lines().flatten() {
      if let Ok(v) = serde_json::from_str::<Value>(&line) {
        if tx.send(v).is_err() {
          break;
        }
      }
    }
  });

  let mut worker = Worker {
    child_in,
    rx,
    cancel,
    emit,
    hot,
    pos: shared,
    file_len,
    paras: Vec::new(),
    buf_text: String::new(),
    buf_start: 0.0,
    chunks: 0,
  };

  let init = json!({
    "mode": "sensevoice",
    "model": model_dir.join("model.int8.onnx").to_string_lossy(),
    "tokens": model_dir.join("tokens.txt").to_string_lossy(),
    "language": language,
    "use_itn": true,
  });

  let mut total_16k: usize = 0;
  let outcome: Result<(), String> = (|| {
    write_frame(&mut worker.child_in, b"INIT", init.to_string().as_bytes())?;
    wait_ready(&worker.rx, Duration::from_secs(60))?;
    (worker.emit)(ev("progress", "开始转写…", 0.0));

    let mut down: Option<Down> = None;
    let mut cur_rate = 0u32;
    let mut seg = Seg::new();
    let mut tmp: Vec<f32> = Vec::with_capacity(8);
    let mut bad_packets = 0usize;
    loop {
      let packet = match format.next_packet() {
        Ok(p) => p,
        // 读到文件尾
        Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
        Err(SymError::ResetRequired) => break,
        Err(e) => return Err(format!("读取音频失败：{e}")),
      };
      if packet.track_id() != track_id {
        continue;
      }
      let buf = match sym_decoder.decode(&packet) {
        Ok(b) => b,
        // 个别坏包跳过；连续太多才认为文件损坏
        Err(SymError::DecodeError(_)) => {
          bad_packets += 1;
          if bad_packets > 200 && worker.chunks == 0 {
            return Err("音频损坏，无法解码".into());
          }
          continue;
        }
        Err(e) => return Err(format!("解码失败：{e}")),
      };
      let spec = *buf.spec();
      let channels = spec.channels.count().max(1);
      if down.is_none() || spec.rate != cur_rate {
        cur_rate = spec.rate;
        down = Some(Down::new(spec.rate));
      }
      let mut sb = SampleBuffer::<f32>::new(buf.capacity() as u64, spec);
      sb.copy_interleaved_ref(buf);
      let d = down.as_mut().expect("down");
      for frame in sb.samples().chunks_exact(channels) {
        let mono = frame.iter().sum::<f32>() / channels as f32;
        tmp.clear();
        d.push(mono, &mut tmp);
        for &v in &tmp {
          total_16k += 1;
          if let Some((start, chunk)) = seg.push(v) {
            worker.handle_chunk(start, chunk)?;
          }
        }
      }
    }
    if let Some((start, chunk)) = seg.finish() {
      worker.handle_chunk(start, chunk)?;
    }
    worker.flush_para();
    Ok(())
  })();

  let _ = worker.child_in.write_all(b"STOP");
  let _ = worker.child_in.flush();
  let _ = child.kill();
  let _ = child.wait();

  outcome?;
  Ok(TranscribeResult {
    paragraphs: std::mem::take(&mut worker.paras),
    duration_sec: total_16k as f64 / SR as f64,
    elapsed_sec: started.elapsed().as_secs_f64(),
    chunks: worker.chunks,
    language: language.to_string(),
  })
}

fn emit_app(app: &AppHandle, e: &TranscribeEvent) {
  let _ = app.emit("sp-transcribe", e);
}

/// 录音文件 → 文字（本地 SenseVoice）
#[tauri::command]
pub async fn transcribe_file(
  app: AppHandle,
  state: State<'_, TranscribeState>,
  path: String,
  language: String,
) -> Result<TranscribeResult, String> {
  if state.running.swap(true, Ordering::SeqCst) {
    return Err("已有转写任务在进行，请先等待或取消".into());
  }
  state.cancel.store(false, Ordering::SeqCst);
  let running = state.running.clone();
  let cancel = state.cancel.clone();
  let lang = if LANGS.contains(&language.as_str()) {
    language
  } else {
    "auto".to_string()
  };

  tauri::async_runtime::spawn_blocking(move || {
    let _guard = RunGuard(running);
    let p = Path::new(&path);
    if !p.is_file() {
      let msg = format!("找不到音频文件：{path}");
      emit_app(&app, &ev("error", msg.clone(), 0.0));
      return Err(msg);
    }

    emit_app(&app, &ev("prepare", "检查本地识别模型…", 0.0));
    let dir = sense_voice_dir(&app)?;
    if !sense_voice_ready(&dir) {
      emit_app(
        &app,
        &ev("download", "首次使用：下载 SenseVoice 模型（约 230MB）…", 0.0),
      );
      if let Err(e) = ensure_sense_voice(&dir) {
        emit_app(&app, &ev("error", e.clone(), 0.0));
        return Err(e);
      }
    }
    let hot = load_hotwords(&app);
    let app2 = app.clone();
    let mut emit = move |e: TranscribeEvent| emit_app(&app2, &e);
    match run_transcribe(&path, &dir, &lang, &hot, &cancel, &mut emit) {
      Ok(r) => {
        emit_app(
          &app,
          &ev(
            "done",
            format!(
              "转写完成：音频 {:.0} 秒，用时 {:.0} 秒",
              r.duration_sec, r.elapsed_sec
            ),
            100.0,
          ),
        );
        Ok(r)
      }
      Err(e) if e == "已取消" => {
        emit_app(&app, &ev("cancelled", "已取消", 0.0));
        Err(e)
      }
      Err(e) => {
        emit_app(&app, &ev("error", e.clone(), 0.0));
        Err(e)
      }
    }
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn transcribe_cancel(state: State<'_, TranscribeState>) {
  state.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn down_48k_to_16k_count() {
    let mut d = Down::new(48_000);
    let mut out = Vec::new();
    for _ in 0..48_000 {
      d.push(0.5, &mut out);
    }
    assert!((out.len() as i64 - 16_000).abs() <= 1, "len={}", out.len());
    assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-5));
  }

  #[test]
  fn down_44k1_to_16k_count() {
    let mut d = Down::new(44_100);
    let mut out = Vec::new();
    for _ in 0..44_100 {
      d.push(0.1, &mut out);
    }
    assert!((out.len() as i64 - 16_000).abs() <= 1, "len={}", out.len());
  }

  #[test]
  fn seg_cuts_on_silence_and_max() {
    let mut seg = Seg::new();
    let mut chunks = Vec::new();
    // 3 秒“声音”（正弦）+ 1 秒静音 + 3 秒声音
    let tone = |i: usize| (i as f32 * 0.05).sin() * 0.3;
    for i in 0..(3 * SR) {
      if let Some(c) = seg.push(tone(i)) {
        chunks.push(c);
      }
    }
    for _ in 0..SR {
      if let Some(c) = seg.push(0.0) {
        chunks.push(c);
      }
    }
    for i in 0..(3 * SR) {
      if let Some(c) = seg.push(tone(i)) {
        chunks.push(c);
      }
    }
    if let Some(c) = seg.finish() {
      chunks.push(c);
    }
    assert!(chunks.len() >= 2, "应在静音处切开，实际 {}", chunks.len());
    let total: usize = chunks.iter().map(|c| c.1.len()).sum();
    assert_eq!(total, 7 * SR, "不应丢采样");
    // 起点连续
    let mut expect = 0usize;
    for (start, c) in &chunks {
      assert_eq!(*start, expect);
      expect += c.len();
    }
    // 长连续声音按 25 秒强制切
    let mut seg = Seg::new();
    let mut n = 0;
    for i in 0..(60 * SR) {
      if seg.push(tone(i)).is_some() {
        n += 1;
      }
    }
    assert_eq!(n, 2, "60 秒连续声音应切出 2 块（25+25）");
  }

  /// 真实文件冒烟：TR_AUDIO=音频路径 [TR_MODEL_DIR] [TR_LANG]，需 STAGE_PLAYER_ASR_SIDECAR
  #[test]
  #[ignore]
  fn real_file() {
    let audio = std::env::var("TR_AUDIO").expect("TR_AUDIO");
    let model_dir = std::env::var("TR_MODEL_DIR")
      .map(std::path::PathBuf::from)
      .unwrap_or_else(|_| {
        std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap())
          .join("com.stageplayer.app/asr-models/sense-voice-int8-2024-07-17")
      });
    let lang = std::env::var("TR_LANG").unwrap_or_else(|_| "auto".into());
    let cancel = AtomicBool::new(false);
    let mut emit = |e: TranscribeEvent| {
      if e.phase == "para" {
        let s = e.start.unwrap_or(0.0) as u64;
        println!("[{:02}:{:02}] {}", s / 60, s % 60, e.text.unwrap_or_default());
      } else {
        println!("-- {} {:.0}% {}", e.phase, e.percent, e.message);
      }
    };
    let r = run_transcribe(&audio, &model_dir, &lang, &[], &cancel, &mut emit).expect("transcribe");
    println!(
      "段落 {} · 音频 {:.1}s · 用时 {:.1}s · 块 {}",
      r.paragraphs.len(),
      r.duration_sec,
      r.elapsed_sec,
      r.chunks
    );
    assert!(!r.paragraphs.is_empty());
  }
}
