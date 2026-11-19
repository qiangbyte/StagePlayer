//! 音频曲库整体打包：媒体文件 + 单曲设置 + 目录/备注/显示名，换机可导入。
//! 包格式：ZIP（扩展名 .spaudio），内含 manifest.json + media/ + lyrics/ + stems/

use crate::fileio::ApprovedSavePaths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const FORMAT: &str = "stage-player-audio-pack";
const VERSION: u32 = 1;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPackProgress {
  pub phase: String,
  pub message: String,
  pub current: u32,
  pub total: u32,
  pub percent: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPackExportReq {
  /// 保存对话框选中的目标路径（须已 approve）
  pub dest: String,
  /// 曲库条目（含 path 与单曲设置）
  pub library: Vec<Value>,
  /// 设置：volume / loopMode / deviceName / folders / labels / notes / …
  pub settings: Value,
  #[serde(default)]
  pub include_stems: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPackImportResult {
  pub media_root: String,
  pub library: Vec<Value>,
  pub settings: Value,
  pub imported: u32,
  pub missing: u32,
  pub message: String,
}

fn emit_prog(app: &AppHandle, phase: &str, message: &str, current: u32, total: u32) {
  let percent = if total == 0 {
    0.0
  } else {
    (current as f32 / total as f32 * 100.0).clamp(0.0, 100.0)
  };
  let _ = app.emit(
    "sp-audio-pack",
    &AudioPackProgress {
      phase: phase.into(),
      message: message.into(),
      current,
      total,
      percent,
    },
  );
}

fn unix_now() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn sanitize_file_name(name: &str) -> String {
  let mut s: String = name
    .chars()
    .map(|c| match c {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      c if c.is_control() => '_',
      c => c,
    })
    .collect();
  if s.is_empty() {
    s = "audio".into();
  }
  if s.len() > 120 {
    s = s.chars().take(120).collect();
  }
  s
}

fn stem_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| e.to_string())?
    .join("stem-instrumental");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn stem_cache_key(path: &str) -> String {
  let mut h = Sha256::new();
  h.update(path.as_bytes());
  if let Ok(meta) = fs::metadata(path) {
    if let Ok(modified) = meta.modified() {
      if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
        h.update(dur.as_secs().to_le_bytes());
      }
    }
    h.update(meta.len().to_le_bytes());
  }
  format!("{:x}", h.finalize())[..32].to_string()
}

fn find_stem(app: &AppHandle, src: &str) -> Option<PathBuf> {
  let p = stem_cache_root(app)
    .ok()?
    .join(format!("{}.instrumental.wav", stem_cache_key(src)));
  if p.is_file() {
    Some(p)
  } else {
    None
  }
}

fn place_stem(app: &AppHandle, src: &str, from: &Path) -> Result<(), String> {
  let dst = stem_cache_root(app)?.join(format!("{}.instrumental.wav", stem_cache_key(src)));
  if dst.exists() {
    let same = dst.metadata().ok().zip(from.metadata().ok()).is_some_and(|(a, b)| a.len() == b.len());
    if same {
      return Ok(());
    }
  }
  fs::copy(from, &dst).map_err(|e| format!("写入伴奏缓存失败: {e}"))?;
  Ok(())
}

fn lyrics_candidates(audio: &Path) -> Vec<PathBuf> {
  let Some(stem) = audio.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
    return vec![];
  };
  let parent = audio.parent().unwrap_or_else(|| Path::new("."));
  [".lrc", ".LRC", ".txt", ".TXT"]
    .into_iter()
    .map(|ext| parent.join(format!("{stem}{ext}")))
    .filter(|p| p.is_file())
    .collect()
}

fn zip_write_file(zip: &mut ZipWriter<File>, name: &str, path: &Path) -> Result<(), String> {
  let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
  zip
    .start_file(name, opts)
    .map_err(|e| format!("zip 写入 {name}: {e}"))?;
  let mut f = File::open(path).map_err(|e| format!("打开 {path:?}: {e}"))?;
  let mut buf = vec![0u8; 256 * 1024];
  loop {
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
  }
  Ok(())
}

fn zip_write_bytes(zip: &mut ZipWriter<File>, name: &str, data: &[u8]) -> Result<(), String> {
  let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
  zip
    .start_file(name, opts)
    .map_err(|e| format!("zip 写入 {name}: {e}"))?;
  zip.write_all(data).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub async fn audio_pack_export(
  app: AppHandle,
  approved: State<'_, ApprovedSavePaths>,
  req: AudioPackExportReq,
) -> Result<String, String> {
  approved.check(&req.dest)?;
  let dest = req.dest.clone();
  let library = req.library;
  let settings = req.settings;
  let include_stems = req.include_stems;
  tauri::async_runtime::spawn_blocking(move || {
    export_blocking(&app, &dest, &library, &settings, include_stems)
  })
  .await
  .map_err(|e| e.to_string())?
}

fn export_blocking(
  app: &AppHandle,
  dest: &str,
  library: &[Value],
  settings: &Value,
  include_stems: bool,
) -> Result<String, String> {
  let total = library.len() as u32;
  emit_prog(app, "export", "开始打包…", 0, total.max(1));

  let dest_path = PathBuf::from(dest);
  if let Some(parent) = dest_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let tmp = dest_path.with_extension("spaudio.partial");
  let _ = fs::remove_file(&tmp);
  let file = File::create(&tmp).map_err(|e| format!("无法创建打包文件: {e}"))?;
  let mut zip = ZipWriter::new(file);

  let mut out_items: Vec<Value> = Vec::new();
  let mut missing = 0u32;
  let mut packed = 0u32;

  for (i, raw) in library.iter().enumerate() {
    let path = raw
      .get("path")
      .and_then(|x| x.as_str())
      .unwrap_or("")
      .to_string();
    emit_prog(
      app,
      "export",
      &format!("打包 {}/{}…", i + 1, total.max(1)),
      i as u32,
      total.max(1),
    );
    if path.is_empty() || !Path::new(&path).is_file() {
      missing += 1;
      continue;
    }
    let src = Path::new(&path);
    let fname = src
      .file_name()
      .map(|n| n.to_string_lossy().into_owned())
      .unwrap_or_else(|| format!("track{i}.bin"));
    let media_name = format!("media/{:04}_{}", i + 1, sanitize_file_name(&fname));
    zip_write_file(&mut zip, &media_name, src)?;

    let mut lyrics_rel: Option<String> = None;
    if let Some(lp) = lyrics_candidates(src).into_iter().next() {
      let ext = lp
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_else(|| "lrc".into());
      let lname = format!("lyrics/{:04}.{}", i + 1, ext.to_lowercase());
      if zip_write_file(&mut zip, &lname, &lp).is_ok() {
        lyrics_rel = Some(lname);
      }
    }

    let mut stem_rel: Option<String> = None;
    if include_stems {
      if let Some(sp) = find_stem(app, &path) {
        let sname = format!("stems/{:04}.instrumental.wav", i + 1);
        if zip_write_file(&mut zip, &sname, &sp).is_ok() {
          stem_rel = Some(sname);
        }
      }
    }

    let mut item = raw.clone();
    if let Some(obj) = item.as_object_mut() {
      obj.insert("file".into(), json!(media_name));
      // 保留原机绝对路径，导入时用于 labels/notes/目录 assign 重映射
      if !path.is_empty() {
        obj.insert("sourcePath".into(), json!(path));
      }
      obj.remove("path");
      if let Some(l) = lyrics_rel {
        obj.insert("lyricsFile".into(), json!(l));
      }
      if let Some(s) = stem_rel {
        obj.insert("stemFile".into(), json!(s));
      }
    }
    out_items.push(item);
    packed += 1;
  }

  let manifest = json!({
    "format": FORMAT,
    "version": VERSION,
    "exportedAt": unix_now(),
    "settings": settings,
    "items": out_items,
    "stats": { "packed": packed, "missing": missing },
  });
  let manifest_s = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
  zip_write_bytes(&mut zip, "manifest.json", manifest_s.as_bytes())?;
  zip
    .finish()
    .map_err(|e| format!("完成 zip 失败: {e}"))?;

  let _ = fs::remove_file(dest);
  fs::rename(&tmp, dest).map_err(|e| format!("保存失败: {e}"))?;
  emit_prog(app, "done", "打包完成", total.max(1), total.max(1));
  Ok(format!("已打包 {packed} 首（缺文件 {missing}）"))
}

#[tauri::command]
pub async fn audio_pack_import(
  app: AppHandle,
  path: String,
) -> Result<AudioPackImportResult, String> {
  tauri::async_runtime::spawn_blocking(move || import_blocking(&app, &path))
    .await
    .map_err(|e| e.to_string())?
}

fn import_blocking(app: &AppHandle, path: &str) -> Result<AudioPackImportResult, String> {
  let p = Path::new(path);
  let ext_ok = p
    .extension()
    .is_some_and(|e| e.eq_ignore_ascii_case("spaudio") || e.eq_ignore_ascii_case("zip"));
  if !ext_ok {
    return Err("请选择 .spaudio 打包文件".into());
  }
  emit_prog(app, "import", "正在读取打包…", 0, 1);

  let file = File::open(p).map_err(|e| format!("打不开文件: {e}"))?;
  let mut zip = ZipArchive::new(file).map_err(|_| "不是有效的音频打包文件".to_string())?;

  let mut manifest_s = String::new();
  {
    let mut entry = zip
      .by_name("manifest.json")
      .map_err(|_| "打包内缺少 manifest.json".to_string())?;
    entry
      .read_to_string(&mut manifest_s)
      .map_err(|e| format!("读取 manifest 失败: {e}"))?;
  }
  let manifest: Value =
    serde_json::from_str(&manifest_s).map_err(|e| format!("manifest 无效: {e}"))?;
  if manifest.get("format").and_then(|x| x.as_str()) != Some(FORMAT) {
    return Err("不是演出播放器音频打包".into());
  }

  let pack_id = format!("pack-{}", unix_now());
  let root = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("audio-library")
    .join(&pack_id);
  fs::create_dir_all(root.join("media")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join("lyrics")).map_err(|e| e.to_string())?;

  let total = zip.len() as u32;
  for i in 0..zip.len() {
    emit_prog(app, "import", &format!("解压 {}/{}…", i + 1, total), i as u32, total.max(1));
    let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
    if entry.is_dir() {
      continue;
    }
    let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
      continue;
    };
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    if rel_s == "manifest.json" {
      continue;
    }
    if !(rel_s.starts_with("media/")
      || rel_s.starts_with("lyrics/")
      || rel_s.starts_with("stems/"))
    {
      continue;
    }
    let out = root.join(&rel);
    if let Some(parent) = out.parent() {
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut w = File::create(&out).map_err(|e| format!("写入失败: {e}"))?;
    std::io::copy(&mut entry, &mut w).map_err(|e| format!("解压失败: {e}"))?;
  }

  let settings = manifest
    .get("settings")
    .cloned()
    .unwrap_or_else(|| json!({}));
  let items = manifest
    .get("items")
    .and_then(|x| x.as_array())
    .cloned()
    .unwrap_or_default();

  let mut library: Vec<Value> = Vec::new();
  let mut imported = 0u32;
  let mut missing = 0u32;
  // 旧相对路径 → 新绝对路径（用于 folders.assign / labels / notes 重映射）
  let mut path_map: serde_json::Map<String, Value> = serde_json::Map::new();

  for (i, raw) in items.iter().enumerate() {
    let file_rel = raw
      .get("file")
      .and_then(|x| x.as_str())
      .unwrap_or("")
      .replace('\\', "/");
    if file_rel.is_empty() {
      missing += 1;
      continue;
    }
    let abs = root.join(&file_rel);
    if !abs.is_file() {
      missing += 1;
      continue;
    }
    let abs_s = abs.to_string_lossy().into_owned();

    // 歌词放到音频同目录同名，便于 loadLyricsFor
    if let Some(lrel) = raw.get("lyricsFile").and_then(|x| x.as_str()) {
      let lp = root.join(lrel.replace('\\', "/"));
      if lp.is_file() {
        let ext = lp
          .extension()
          .map(|e| e.to_string_lossy().into_owned())
          .unwrap_or_else(|| "lrc".into());
        let stem = abs.file_stem().map(|s| s.to_string_lossy().into_owned());
        if let Some(stem) = stem {
          let dest_l = abs.with_file_name(format!("{stem}.{ext}"));
          let _ = fs::copy(&lp, &dest_l);
        }
      }
    }

    if let Some(srel) = raw.get("stemFile").and_then(|x| x.as_str()) {
      let sp = root.join(srel.replace('\\', "/"));
      if sp.is_file() {
        let _ = place_stem(app, &abs_s, &sp);
      }
    }

    let mut item = raw.clone();
    if let Some(obj) = item.as_object_mut() {
      obj.insert("path".into(), json!(abs_s.clone()));
      obj.insert("type".into(), json!("audio"));
      if !obj.contains_key("id") {
        obj.insert("id".into(), json!(format!("a{i}-{}", unix_now())));
      }
      obj.remove("file");
      obj.remove("lyricsFile");
      obj.remove("stemFile");
      obj.remove("sourcePath");
    }
    // 相对路径 / 原机绝对路径 → 新绝对路径（前端重映射 labels/notes）
    path_map.insert(file_rel.clone(), json!(abs_s.clone()));
    if let Some(old) = raw
      .get("sourcePath")
      .and_then(|x| x.as_str())
      .or_else(|| raw.get("path").and_then(|x| x.as_str()))
    {
      if !old.is_empty() {
        path_map.insert(old.to_string(), json!(abs_s.clone()));
      }
    }
    library.push(item);
    imported += 1;
  }

  let mut settings_out = settings;
  if let Some(obj) = settings_out.as_object_mut() {
    obj.insert("pathMap".into(), Value::Object(path_map));
  }

  emit_prog(app, "done", "导入完成", 1, 1);
  Ok(AudioPackImportResult {
    media_root: root.to_string_lossy().into_owned(),
    library,
    settings: settings_out,
    imported,
    missing,
    message: format!("已导入 {imported} 首到本机曲库"),
  })
}
