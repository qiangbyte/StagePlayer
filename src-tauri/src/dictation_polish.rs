//! 讲话记录定稿：热词替换、标点、SenseVoice 离线二遍精修。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::lyric_follow::{
  download_first_ok, emit_dictation_pub, extract_archive_generic, find_asr_sidecar, write_audio_frame,
  write_frame, FollowEvent,
};

pub const SV_DIR_NAME: &str = "sense-voice-int8-2024-07-17";
pub const SV_ARCHIVE: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
pub const SV_INNER: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
pub const SV_FILES: &[&str] = &["model.int8.onnx", "tokens.txt"];
pub const SV_MIN: &[(&str, u64)] = &[("model.int8.onnx", 80 * 1024 * 1024), ("tokens.txt", 1024)];
pub const SV_URLS: &[&str] = &[
  "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
  "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
];

pub const PUNCT_DIR_NAME: &str = "punct-ct-zh-en-int8";
pub const PUNCT_ARCHIVE: &str =
  "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2";
pub const PUNCT_INNER: &str = "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8";
pub const PUNCT_FILES: &[&str] = &["model.int8.onnx"];
pub const PUNCT_MIN: &[(&str, u64)] = &[("model.int8.onnx", 20 * 1024 * 1024)];
pub const PUNCT_URLS: &[&str] = &[
  "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2",
  "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2",
];

/// 讲道/常用 ASR 错 → 正（可被用户 hotwords.json 覆盖追加）
const DEFAULT_HOTWORDS: &[(&str, &str)] = &[
  ("耶酥", "耶稣"),
  ("耶苏", "耶稣"),
  ("基督脚", "基督教"),
  ("福因", "福音"),
  ("福英", "福音"),
  ("圣静", "圣经"),
  ("圣金", "圣经"),
  ("教诲", "教会"),
  ("教汇", "教会"),
  ("祷靠", "祷告"),
  ("祷高", "祷告"),
  ("阿闷", "阿们"),
  ("阿门", "阿们"),
  ("哈利路亚", "哈利路亚"),
  ("哈利路呀", "哈利路亚"),
  ("圣灵", "圣灵"),
  ("十架", "十字架"),
  ("十字加", "十字架"),
  ("复活", "复活"),
  ("救主", "救主"),
  ("天国", "天国"),
  ("弟兄姐妹", "弟兄姊妹"),
  ("十字架架", "十字架"),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineModelStatus {
  pub sense_voice_ready: bool,
  pub punct_ready: bool,
  pub sense_voice_path: String,
  pub punct_path: String,
  pub message: String,
}

fn asr_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| e.to_string())?
    .join("asr-models");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

pub fn sense_voice_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = asr_root(app)?.join(SV_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

pub fn punct_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = asr_root(app)?.join(PUNCT_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn files_ready(dir: &Path, mins: &[(&str, u64)]) -> bool {
  mins.iter().all(|(name, min)| {
    let p = dir.join(name);
    p.is_file() && p.metadata().map(|m| m.len()).unwrap_or(0) >= *min
  })
}

pub fn sense_voice_ready(dir: &Path) -> bool {
  files_ready(dir, SV_MIN)
}

pub fn punct_ready(dir: &Path) -> bool {
  files_ready(dir, PUNCT_MIN)
}

fn hotwords_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("talk");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir.join("hotwords.json"))
}

#[derive(Deserialize)]
struct HotPair {
  #[serde(alias = "from", alias = "wrong")]
  wrong: String,
  #[serde(alias = "to", alias = "right")]
  right: String,
}

pub fn load_hotwords(app: &AppHandle) -> Vec<(String, String)> {
  let mut pairs: Vec<(String, String)> = DEFAULT_HOTWORDS
    .iter()
    .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
    .collect();
  if let Ok(path) = hotwords_path(app) {
    if path.is_file() {
      if let Ok(raw) = fs::read_to_string(&path) {
        // 支持 [["错","正"], ...] 或 [{"wrong":"","right":""}, ...]
        if let Ok(arr) = serde_json::from_str::<Vec<(String, String)>>(&raw) {
          for (w, r) in arr {
            if !w.is_empty() && !r.is_empty() {
              pairs.push((w, r));
            }
          }
        } else if let Ok(arr) = serde_json::from_str::<Vec<HotPair>>(&raw) {
          for p in arr {
            if !p.wrong.is_empty() && !p.right.is_empty() {
              pairs.push((p.wrong, p.right));
            }
          }
        }
      }
    } else {
      // 写出默认模板，方便用户改
      let template: Vec<(&str, &str)> = DEFAULT_HOTWORDS.iter().copied().collect();
      let _ = fs::write(
        &path,
        serde_json::to_string_pretty(&template).unwrap_or_else(|_| "[]".into()),
      );
    }
  }
  // 长词优先，避免短词先替换破坏长词
  pairs.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()));
  pairs
}

pub fn apply_hotwords(text: &str, pairs: &[(String, String)]) -> String {
  let mut out = text.to_string();
  for (w, r) in pairs {
    if w == r || w.is_empty() {
      continue;
    }
    out = out.replace(w, r);
  }
  out
}

/// 无标点模型时的轻量句读：行末补 。
pub fn light_punctuate(text: &str) -> String {
  text
    .lines()
    .map(|line| {
      let t = line.trim();
      if t.is_empty() {
        return String::new();
      }
      let last = t.chars().last().unwrap_or(' ');
      if "。！？；…,.!?;:".contains(last) {
        t.to_string()
      } else {
        format!("{t}。")
      }
    })
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

/// 按静音/时长切块，避免 SenseVoice 一次吃太长
pub fn split_pcm_chunks(samples: &[f32], sr: u32) -> Vec<Vec<f32>> {
  if samples.is_empty() {
    return Vec::new();
  }
  let max_len = (sr as usize) * 25; // 25s
  let min_silence = (sr as usize) / 5; // 200ms
  let silence_db = -42.0f32;
  let mut chunks = Vec::new();
  let mut start = 0usize;
  let mut i = 0usize;
  let mut silence_run = 0usize;
  while i < samples.len() {
    let win = (sr as usize / 50).max(1); // 20ms
    let end = (i + win).min(samples.len());
    let mut s = 0.0f64;
    for &x in &samples[i..end] {
      s += (x as f64) * (x as f64);
    }
    let rms = (s / (end - i) as f64).sqrt();
    let db = if rms < 1e-9 {
      -120.0
    } else {
      (20.0 * rms.log10()) as f32
    };
    if db < silence_db {
      silence_run += end - i;
    } else {
      silence_run = 0;
    }
    let elapsed = end - start;
    if (silence_run >= min_silence && elapsed >= (sr as usize) * 2) || elapsed >= max_len {
      let cut = if silence_run >= min_silence {
        end.saturating_sub(silence_run / 2)
      } else {
        end
      };
      let cut = cut.max(start + 1).min(samples.len());
      let slice = &samples[start..cut];
      if slice.iter().any(|x| x.abs() > 0.01) {
        chunks.push(slice.to_vec());
      }
      start = cut;
      silence_run = 0;
      i = cut;
      continue;
    }
    i = end;
  }
  if start < samples.len() {
    let slice = &samples[start..];
    if slice.iter().any(|x| x.abs() > 0.01) {
      chunks.push(slice.to_vec());
    }
  }
  if chunks.is_empty() {
    chunks.push(samples.to_vec());
  }
  chunks
}

pub(crate) fn spawn_sidecar() -> Result<(std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>), String> {
  let path = find_asr_sidecar()?;
  let mut cmd = Command::new(&path);
  cmd.stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  let mut child = cmd.spawn().map_err(|e| format!("启动 sidecar 失败: {e}"))?;
  let child_in = child.stdin.take().ok_or("sidecar 无 stdin")?;
  let child_out = child.stdout.take().ok_or("sidecar 无 stdout")?;
  Ok((child, child_in, BufReader::new(child_out)))
}

pub(crate) fn wait_ready(rx: &mpsc::Receiver<serde_json::Value>, timeout: Duration) -> Result<(), String> {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    match rx.recv_timeout(Duration::from_millis(100)) {
      Ok(v) => {
        let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        if kind == "ready" {
          return Ok(());
        }
        if kind == "error" {
          return Err(
            v.get("message")
              .and_then(|x| x.as_str())
              .unwrap_or("sidecar 错误")
              .to_string(),
          );
        }
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      Err(_) => return Err("sidecar 提前退出".into()),
    }
  }
  Err("sidecar 就绪超时".into())
}

/// 超过此时长的录音不做整段 SenseVoice（太慢像卡住），改走文本润色
const SV_MAX_SECS: usize = 4 * 60;
/// 整次精修墙钟上限
const SV_TOTAL_BUDGET: Duration = Duration::from_secs(90);
/// 单块解码超时
const SV_CHUNK_TIMEOUT: Duration = Duration::from_secs(35);

/// SenseVoice 离线精修整段 PCM
pub fn refine_with_sensevoice(dir: &Path, samples: &[f32]) -> Result<String, String> {
  if !sense_voice_ready(dir) {
    return Err("SenseVoice 模型未就绪".into());
  }
  if samples.is_empty() {
    return Ok(String::new());
  }
  let max_samples = 16_000usize.saturating_mul(SV_MAX_SECS);
  if samples.len() > max_samples {
    return Err(format!(
      "录音超过 {} 分钟，跳过 SenseVoice 以免卡住，改用文本润色",
      SV_MAX_SECS / 60
    ));
  }
  let model = dir.join("model.int8.onnx");
  let tokens = dir.join("tokens.txt");
  let (mut child, mut child_in, child_out) = spawn_sidecar()?;
  let (tx, rx) = mpsc::channel();
  std::thread::spawn(move || {
    for line in child_out.lines().flatten() {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
        if tx.send(v).is_err() {
          break;
        }
      }
    }
  });
  let init = serde_json::json!({
    "mode": "sensevoice",
    "model": model.to_string_lossy(),
    "tokens": tokens.to_string_lossy(),
    "language": "zh",
    "use_itn": true,
  });
  write_frame(&mut child_in, b"INIT", init.to_string().as_bytes())?;
  wait_ready(&rx, Duration::from_secs(45))?;

  let chunks = split_pcm_chunks(samples, 16_000);
  let total = chunks.len().max(1);
  let mut parts = Vec::new();
  let started = Instant::now();
  for (i, chunk) in chunks.into_iter().enumerate() {
    if started.elapsed() > SV_TOTAL_BUDGET {
      let _ = child_in.write_all(b"STOP");
      let _ = child.kill();
      if parts.is_empty() {
        return Err("精修超时，改用文本润色".into());
      }
      // 已有部分结果也返回，后面由调用方决定是否采用
      break;
    }
    emit_dictation_pub(FollowEvent {
      kind: "refining".into(),
      message: format!("SenseVoice 精修中… {}/{}", i + 1, total),
      text: None,
      index: Some(i),
      preview: Some(total),
      rms_db: None,
      percent: Some((((i + 1) as f32 / total as f32) * 100.0).clamp(0.0, 100.0)),
      busy: true,
    });
    // 大块分片写入，避免单帧过大堵死管道
    for piece in chunk.chunks(16_000 * 2) {
      write_audio_frame(&mut child_in, piece)?;
    }
    write_frame(&mut child_in, b"FIN\0", &[])?;
    let deadline = Instant::now() + SV_CHUNK_TIMEOUT;
    let mut got = false;
    while Instant::now() < deadline {
      match rx.recv_timeout(Duration::from_millis(200)) {
        Ok(v) => {
          let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
          if kind == "final" {
            if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
              let t = t.trim();
              if !t.is_empty() {
                parts.push(t.to_string());
              }
            }
            got = true;
            break;
          }
          if kind == "error" {
            let _ = child_in.write_all(b"STOP");
            let _ = child.kill();
            return Err(
              v.get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("精修失败")
                .to_string(),
            );
          }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Err(_) => break,
      }
    }
    if !got {
      let _ = child_in.write_all(b"STOP");
      let _ = child.kill();
      if parts.is_empty() {
        return Err(format!("精修超时（块 {}/{}），改用文本润色", i + 1, total));
      }
      break;
    }
  }
  let _ = child_in.write_all(b"STOP");
  let _ = child_in.flush();
  drop(child_in);
  let _ = child.kill();
  let _ = child.wait();
  if parts.is_empty() {
    return Err("精修无结果，改用文本润色".into());
  }
  Ok(parts.join("\n"))
}

/// 用 CT-Transformer 给文本加标点
pub fn punctuate_text(dir: &Path, text: &str) -> Result<String, String> {
  if !punct_ready(dir) {
    return Err("标点模型未就绪".into());
  }
  let t = text.trim();
  if t.is_empty() {
    return Ok(String::new());
  }
  let model = dir.join("model.int8.onnx");
  let (mut child, mut child_in, child_out) = spawn_sidecar()?;
  let (tx, rx) = mpsc::channel();
  std::thread::spawn(move || {
    for line in child_out.lines().flatten() {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
        if tx.send(v).is_err() {
          break;
        }
      }
    }
  });
  let init = serde_json::json!({
    "mode": "punct",
    "model": model.to_string_lossy(),
  });
  write_frame(&mut child_in, b"INIT", init.to_string().as_bytes())?;
  wait_ready(&rx, Duration::from_secs(45))?;

  // 按行/按段处理，避免一次过长
  let mut out_lines = Vec::new();
  for line in t.split('\n') {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    let pieces: Vec<String> = if line.chars().count() > 180 {
      let mut v = Vec::new();
      let mut buf = String::new();
      for ch in line.chars() {
        buf.push(ch);
        if buf.chars().count() >= 160 {
          v.push(std::mem::take(&mut buf));
        }
      }
      if !buf.is_empty() {
        v.push(buf);
      }
      v
    } else {
      vec![line.to_string()]
    };
    for piece in pieces {
      write_frame(&mut child_in, b"TEXT", piece.as_bytes())?;
      let polished = recv_final(&rx, Duration::from_secs(30))?;
      if !polished.is_empty() {
        out_lines.push(polished);
      }
    }
  }
  let _ = child_in.write_all(b"STOP");
  let _ = child_in.flush();
  drop(child_in);
  let _ = child.kill();
  let _ = child.wait();
  Ok(out_lines.join("\n"))
}

fn recv_final(rx: &mpsc::Receiver<serde_json::Value>, timeout: Duration) -> Result<String, String> {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    match rx.recv_timeout(Duration::from_millis(100)) {
      Ok(v) => {
        let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        if kind == "final" {
          return Ok(
            v.get("text")
              .and_then(|x| x.as_str())
              .unwrap_or("")
              .trim()
              .to_string(),
          );
        }
        if kind == "error" {
          return Err(
            v.get("message")
              .and_then(|x| x.as_str())
              .unwrap_or("标点失败")
              .to_string(),
          );
        }
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      Err(_) => return Err("sidecar 断开".into()),
    }
  }
  Err("标点超时".into())
}

fn ensure_archive_model(
  dir: &Path,
  archive_name: &str,
  inner: &str,
  files: &[&str],
  mins: &[(&str, u64)],
  urls: &[&str],
  label: &str,
) -> Result<(), String> {
  if files_ready(dir, mins) {
    return Ok(());
  }
  let archive = dir.join(archive_name);
  let ok = archive.is_file() && archive.metadata().map(|m| m.len()).unwrap_or(0) > 10 * 1024 * 1024;
  if !ok {
    let _ = fs::remove_file(&archive);
    emit_dictation_pub(FollowEvent {
      kind: "download".into(),
      message: format!("下载{label}…"),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    if let Err(e) = download_first_ok(urls, &archive, archive_name) {
      return Err(format!(
        "下载{label}失败（若见 HTTP 520 多为镜像繁忙，已自动换源仍失败）：{e}"
      ));
    }
  }
  emit_dictation_pub(FollowEvent {
    kind: "download".into(),
    message: format!("解压{label}…"),
    text: None,
    index: None,
    preview: None,
    rms_db: None,
    percent: Some(90.0),
    busy: true,
  });
  extract_archive_generic(&archive, dir, inner, files).map_err(|e| {
    format!("解压{label}失败: {e}")
  })?;
  if files_ready(dir, mins) {
    Ok(())
  } else {
    Err(format!("{label}解压后文件不完整：{}", dir.display()))
  }
}

pub fn ensure_sense_voice(dir: &Path) -> Result<(), String> {
  ensure_archive_model(dir, SV_ARCHIVE, SV_INNER, SV_FILES, SV_MIN, SV_URLS, "SenseVoice 精修模型")
}

pub fn ensure_punct(dir: &Path) -> Result<(), String> {
  ensure_archive_model(
    dir,
    PUNCT_ARCHIVE,
    PUNCT_INNER,
    PUNCT_FILES,
    PUNCT_MIN,
    PUNCT_URLS,
    "标点模型",
  )
}

/// 停录后定稿：优先 SenseVoice；否则热词+标点/轻量句读
pub fn polish_after_stop(
  app: &AppHandle,
  pcm: &[f32],
  streaming_text: &str,
) -> (String, String) {
  let pairs = load_hotwords(app);
  let sv_dir = sense_voice_dir(app).ok();
  let pu_dir = punct_dir(app).ok();

  if let Some(ref dir) = sv_dir {
    if sense_voice_ready(dir) && !pcm.is_empty() {
      emit_dictation_pub(FollowEvent {
        kind: "refining".into(),
        message: "定稿精修开始…".into(),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: Some(1.0),
        busy: true,
      });
      match refine_with_sensevoice(dir, pcm) {
        Ok(t) if !t.trim().is_empty() => {
          let t = apply_hotwords(&t, &pairs);
          return (t, "SenseVoice 精修完成".into());
        }
        Ok(_) => {}
        Err(e) => {
          emit_dictation_pub(FollowEvent {
            kind: "refining".into(),
            message: format!("SenseVoice 跳过：{e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: Some(50.0),
            busy: true,
          });
        }
      }
    }
  }

  let mut text = apply_hotwords(streaming_text, &pairs);
  if let Some(ref dir) = pu_dir {
    if punct_ready(dir) {
      match punctuate_text(dir, &text) {
        Ok(t) if !t.trim().is_empty() => {
          text = apply_hotwords(&t, &pairs);
          return (text, "已加标点并替换热词".into());
        }
        _ => {}
      }
    }
  }
  text = light_punctuate(&text);
  (
    text,
    "已热词替换+轻量句读（精修模型未就绪时可后台下载）".into(),
  )
}

#[tauri::command]
pub fn dictation_refine_status(app: AppHandle) -> Result<RefineModelStatus, String> {
  let sv = sense_voice_dir(&app)?;
  let pu = punct_dir(&app)?;
  let sv_ok = sense_voice_ready(&sv);
  let pu_ok = punct_ready(&pu);
  Ok(RefineModelStatus {
    sense_voice_ready: sv_ok,
    punct_ready: pu_ok,
    sense_voice_path: sv.to_string_lossy().into(),
    punct_path: pu.to_string_lossy().into(),
    message: match (sv_ok, pu_ok) {
      (true, true) => "精修与标点模型均已就绪".into(),
      (true, false) => "SenseVoice 已就绪（标点模型可作回退）".into(),
      (false, true) => "标点模型已就绪，SenseVoice 未下载".into(),
      (false, false) => "尚未下载精修模型（SenseVoice 约 230MB）".into(),
    },
  })
}

#[tauri::command]
pub async fn dictation_ensure_refine_model(app: AppHandle) -> Result<RefineModelStatus, String> {
  let sv = sense_voice_dir(&app)?;
  let pu = punct_dir(&app)?;
  let sv_bg = sv.clone();
  let pu_bg = pu.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let mut errs = Vec::new();
    if let Err(e) = ensure_sense_voice(&sv_bg) {
      errs.push(e);
    }
    // 标点作回退；失败不阻断 SenseVoice
    let _ = ensure_punct(&pu_bg);
    if sense_voice_ready(&sv_bg) || punct_ready(&pu_bg) {
      Ok(())
    } else {
      Err(errs.join(" | "))
    }
  })
  .await
  .map_err(|e| e.to_string())??;
  dictation_refine_status(app)
}

#[tauri::command]
pub async fn dictation_polish_text(app: AppHandle, text: String) -> Result<String, String> {
  let pairs = load_hotwords(&app);
  let mut t = apply_hotwords(&text, &pairs);
  let pu = punct_dir(&app)?;
  if punct_ready(&pu) {
    let pu2 = pu.clone();
    let src = t.clone();
    t = tauri::async_runtime::spawn_blocking(move || punctuate_text(&pu2, &src))
      .await
      .map_err(|e| e.to_string())?
      .unwrap_or(t);
    t = apply_hotwords(&t, &pairs);
  } else {
    t = light_punctuate(&t);
  }
  Ok(t)
}
