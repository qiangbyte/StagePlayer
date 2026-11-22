//! 本地图片 OCR：Windows.Media.Ocr（系统自带，离线、不走 API）。
//! 用于 PDF 扫描页：前端渲成图后把 PNG 送来识别。

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
  pub ready: bool,
  pub engine: String,
  pub message: String,
}

#[tauri::command]
pub fn ocr_status() -> OcrStatus {
  #[cfg(windows)]
  {
    match win_probe() {
      Ok(lang) => OcrStatus {
        ready: true,
        engine: "windows-media-ocr".into(),
        message: format!("系统 OCR 就绪（{lang}）"),
      },
      Err(e) => OcrStatus {
        ready: false,
        engine: "windows-media-ocr".into(),
        message: e,
      },
    }
  }
  #[cfg(not(windows))]
  {
    OcrStatus {
      ready: false,
      engine: "none".into(),
      message: "当前系统暂未接入 OCR 引擎；带文字层的 PDF 仍可直接抽取".into(),
    }
  }
}

/// 对 PNG/JPEG 字节做 OCR，返回按行拼接的文本。
#[tauri::command]
pub async fn ocr_image(_app: AppHandle, bytes: Vec<u8>) -> Result<String, String> {
  if bytes.is_empty() {
    return Err("空图片".into());
  }
  #[cfg(windows)]
  {
    tauri::async_runtime::spawn_blocking(move || win_ocr_bytes(&bytes))
      .await
      .map_err(|e| e.to_string())?
  }
  #[cfg(not(windows))]
  {
    let _ = _app;
    Err("当前平台暂不支持本地 OCR；请使用带可选文字的 PDF".into())
  }
}

#[cfg(windows)]
fn win_probe() -> Result<String, String> {
  use windows::core::HSTRING;
  use windows::Globalization::Language;
  use windows::Media::Ocr::OcrEngine;

  if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
    let lang = engine
      .RecognizerLanguage()
      .ok()
      .and_then(|l| l.DisplayName().ok())
      .map(|s| s.to_string())
      .unwrap_or_else(|| "用户语言".into());
    return Ok(lang);
  }
  for tag in ["zh-Hans", "zh-CN", "zh-Hant", "en-US"] {
    let lang = Language::CreateLanguage(&HSTRING::from(tag))
      .map_err(|e| format!("创建语言 {tag} 失败：{e}"))?;
    if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
      let name = engine
        .RecognizerLanguage()
        .ok()
        .and_then(|l| l.DisplayName().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| tag.into());
      return Ok(name);
    }
  }
  Err(
    "未找到可用的系统 OCR 语言包。请到「设置 → 时间和语言 → 语言和区域」安装中文，并勾选「光学字符识别」"
      .into(),
  )
}

#[cfg(windows)]
fn make_engine() -> Result<windows::Media::Ocr::OcrEngine, String> {
  use windows::core::HSTRING;
  use windows::Globalization::Language;
  use windows::Media::Ocr::OcrEngine;

  if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
    return Ok(engine);
  }
  for tag in ["zh-Hans", "zh-CN", "zh-Hant", "en-US"] {
    if let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag)) {
      if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
        return Ok(engine);
      }
    }
  }
  Err("无法创建 OCR 引擎。请安装中文语言包并启用「光学字符识别」".into())
}

#[cfg(windows)]
fn win_ocr_bytes(bytes: &[u8]) -> Result<String, String> {
  use std::fs;
  use std::path::PathBuf;
  use windows::core::HSTRING;
  use windows::Graphics::Imaging::BitmapDecoder;
  use windows::Storage::{FileAccessMode, StorageFile};

  let dir = std::env::temp_dir().join("stage-player-ocr");
  fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
  let name = format!("p{}-{}.png", std::process::id(), std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0));
  let path = dir.join(&name);
  fs::write(&path, bytes).map_err(|e| format!("写入临时图失败：{e}"))?;
  let result = (|| {
    let path_str = path
      .canonicalize()
      .unwrap_or_else(|_| PathBuf::from(&path))
      .to_string_lossy()
      .trim_start_matches(r"\\?\")
      .to_string();
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path_str))
      .map_err(|e| format!("打开临时图：{e}"))?
      .join()
      .map_err(|e| format!("打开临时图失败：{e}"))?;
    let stream = file
      .OpenAsync(FileAccessMode::Read)
      .map_err(|e| format!("OpenAsync：{e}"))?
      .join()
      .map_err(|e| format!("打开流失败：{e}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
      .map_err(|e| format!("创建解码器：{e}"))?
      .join()
      .map_err(|e| format!("解码失败：{e}"))?;
    let bitmap = decoder
      .GetSoftwareBitmapAsync()
      .map_err(|e| format!("GetSoftwareBitmap：{e}"))?
      .join()
      .map_err(|e| format!("读取位图失败：{e}"))?;
    let engine = make_engine()?;
    let ocr = engine
      .RecognizeAsync(&bitmap)
      .map_err(|e| format!("RecognizeAsync：{e}"))?
      .join()
      .map_err(|e| format!("识别失败：{e}"))?;
    let text = ocr
      .Text()
      .map_err(|e| format!("读取结果失败：{e}"))?
      .to_string();
    Ok::<String, String>(text.trim().to_string())
  })();
  let _ = fs::remove_file(&path);
  result
}
