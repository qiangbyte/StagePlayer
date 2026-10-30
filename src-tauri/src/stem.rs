//! AI 人声分离（HTDemucs ONNX）→ 缓存伴奏 WAV，供「仅伴奏」切换播放。
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

/// 同时只跑一个分离任务，避免内存爆掉
pub struct StemLock(pub AtomicBool);

static STEM_APP: OnceLock<AppHandle> = OnceLock::new();
static STEM_JOB_PATH: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StemInfo {
  pub ready: bool,
  pub instrumental_path: Option<String>,
  pub message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StemProgressEvent {
  pub phase: String,
  pub percent: f32,
  pub message: String,
  pub path: Option<String>,
  pub bytes_done: Option<u64>,
  pub bytes_total: Option<u64>,
  pub busy: bool,
}

fn job_path_slot() -> &'static Mutex<Option<String>> {
  STEM_JOB_PATH.get_or_init(|| Mutex::new(None))
}

fn emit_progress(ev: StemProgressEvent) {
  if let Some(app) = STEM_APP.get() {
    let _ = app.emit("sp-stem-progress", &ev);
  }
}

fn file_label(path: &str) -> String {
  Path::new(path)
    .file_name()
    .and_then(|s| s.to_str())
    .unwrap_or(path)
    .to_string()
}

/// 加速策略：Windows 优先 DirectML(GPU)；拉满 CPU 线程；跳过常未安装的 CUDA 探测
fn configure_stem_accel() {
  // 只在用户未手动指定时设置，避免覆盖调试环境
  if std::env::var_os("STEMMER_EP_DISABLE").is_none() {
    // CUDA 未装时探测很慢；禁用后默认顺序变为 DirectML → OneDNN → XNNPACK → CPU
    #[cfg(target_os = "windows")]
    std::env::set_var("STEMMER_EP_DISABLE", "cuda");
  }
  if std::env::var_os("STEMMER_ORT_INTRA_THREADS").is_none() {
    if let Ok(n) = std::thread::available_parallelism() {
      // 留 1 核给 UI/音频，其余给推理
      let threads = n.get().saturating_sub(1).max(2);
      std::env::set_var("STEMMER_ORT_INTRA_THREADS", threads.to_string());
    }
  }
  // 若上次 GPU 探测失败被缓存，允许再试
  if std::env::var_os("STEMMER_EP_CACHE_BYPASS").is_none() {
    std::env::set_var("STEMMER_EP_CACHE_BYPASS", "1");
  }
}

/// 在 App setup 时调用一次：把分离进度桥到前端事件
pub fn init_progress_bridge(app: AppHandle) {
  let _ = STEM_APP.set(app);
  let _ = job_path_slot();
  configure_stem_accel();

  stem_splitter_core::set_split_progress_callback(|p| {
    use stem_splitter_core::SplitProgress;
    let path = job_path_slot()
      .lock()
      .ok()
      .and_then(|g| g.clone());
    let label = path.as_deref().map(file_label).unwrap_or_default();
    match p {
      SplitProgress::Stage(stage) => {
        // 各阶段用「本阶段」百分比，避免与下载进度混在一起跳变
        let (percent, message) = match stage {
          "resolve_model" => (2.0, "准备模型…".to_string()),
          "engine_preload" => (5.0, "加载推理引擎…".to_string()),
          "read_audio" => (8.0, format!("读取音频 {label}")),
          "infer" => (10.0, "开始 AI 推理…".to_string()),
          "write_stems" => (92.0, "写出分轨…".to_string()),
          "finalize" => (98.0, "收尾…".to_string()),
          other => (10.0, format!("处理中：{other}")),
        };
        emit_progress(StemProgressEvent {
          phase: "split".into(),
          percent,
          message,
          path,
          bytes_done: None,
          bytes_total: None,
          busy: true,
        });
      }
      SplitProgress::Chunks {
        done,
        total,
        percent,
      } => {
        // 推理块进度：本阶段 10%→90%
        let stage_pct = 10.0 + (percent as f32) * 0.80;
        emit_progress(StemProgressEvent {
          phase: "split".into(),
          percent: stage_pct.clamp(0.0, 99.0),
          message: format!("AI 分离中 {done}/{total} 块 · {percent:.0}%"),
          path,
          bytes_done: None,
          bytes_total: None,
          busy: true,
        });
      }
      SplitProgress::Writing {
        stem,
        done,
        total,
        percent,
      } => {
        let stage_pct = 90.0 + (percent as f32) * 0.08;
        emit_progress(StemProgressEvent {
          phase: "write".into(),
          percent: stage_pct.clamp(0.0, 99.0),
          message: format!("写出 {stem}（{done}/{total}）"),
          path,
          bytes_done: None,
          bytes_total: None,
          busy: true,
        });
      }
      SplitProgress::Finished => {
        emit_progress(StemProgressEvent {
          phase: "split".into(),
          percent: 96.0,
          message: "分轨完成，正在合成伴奏…".into(),
          path,
          bytes_done: None,
          bytes_total: None,
          busy: true,
        });
      }
    }
  });
}

#[tauri::command]
pub fn stem_job_status(lock: State<'_, StemLock>) -> StemProgressEvent {
  let busy = lock.0.load(Ordering::SeqCst);
  let path = job_path_slot()
    .lock()
    .ok()
    .and_then(|g| g.clone());
  StemProgressEvent {
    phase: if busy { "busy".into() } else { "idle".into() },
    percent: 0.0,
    message: if busy {
      "伴奏分离进行中".into()
    } else {
      "空闲".into()
    },
    path,
    bytes_done: None,
    bytes_total: None,
    busy,
  }
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| e.to_string())?
    .join("stem-instrumental");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn cache_key(path: &str) -> String {
  let mut h = Sha256::new();
  h.update(path.as_bytes());
  if let Ok(meta) = fs::metadata(path) {
    if let Ok(modified) = meta.modified() {
      if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
        h.update(dur.as_secs().to_le_bytes());
      }
    }
    h.update(meta.len().to_le_bytes());
  }
  format!("{:x}", h.finalize())[..32].to_string()
}

fn instrumental_path_for(app: &AppHandle, src: &str) -> Result<PathBuf, String> {
  Ok(cache_root(app)?.join(format!("{}.instrumental.wav", cache_key(src))))
}

/// 查询是否已有伴奏缓存
#[tauri::command]
pub fn stem_get_instrumental(app: AppHandle, path: String) -> Result<StemInfo, String> {
  if !Path::new(&path).is_file() {
    return Ok(StemInfo {
      ready: false,
      instrumental_path: None,
      message: "源文件不存在".into(),
    });
  }
  let out = instrumental_path_for(&app, &path)?;
  if out.is_file() {
    Ok(StemInfo {
      ready: true,
      instrumental_path: Some(out.to_string_lossy().into()),
      message: "已有伴奏缓存".into(),
    })
  } else {
    Ok(StemInfo {
      ready: false,
      instrumental_path: None,
      message: "尚未分离".into(),
    })
  }
}

/// 确保伴奏缓存存在：首次会下载 ~200MB 模型并跑 HTDemucs（可能需数分钟）
#[tauri::command]
pub async fn stem_ensure_instrumental(
  app: AppHandle,
  lock: State<'_, StemLock>,
  path: String,
) -> Result<StemInfo, String> {
  if !Path::new(&path).is_file() {
    return Err("源音频不存在".into());
  }
  let out = instrumental_path_for(&app, &path)?;
  if out.is_file() {
    return Ok(StemInfo {
      ready: true,
      instrumental_path: Some(out.to_string_lossy().into()),
      message: "已有伴奏缓存".into(),
    });
  }

  if lock
    .0
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_err()
  {
    // 不抛错：前端用进度面板提示「进行中」
    return Err("BUSY".into());
  }

  // 双重检查
  if out.is_file() {
    lock.0.store(false, Ordering::SeqCst);
    return Ok(StemInfo {
      ready: true,
      instrumental_path: Some(out.to_string_lossy().into()),
      message: "已有伴奏缓存".into(),
    });
  }

  if let Ok(mut g) = job_path_slot().lock() {
    *g = Some(path.clone());
  }

  emit_progress(StemProgressEvent {
    phase: "start".into(),
    percent: 1.0,
    message: format!("准备分离「{}」…", file_label(&path)),
    path: Some(path.clone()),
    bytes_done: None,
    bytes_total: None,
    busy: true,
  });

  let path_clone = path.clone();
  let out_clone = out.clone();
  let work_dir = match cache_root(&app) {
    Ok(root) => root.join(format!("work-{}", cache_key(&path))),
    Err(e) => {
      lock.0.store(false, Ordering::SeqCst);
      if let Ok(mut g) = job_path_slot().lock() {
        *g = None;
      }
      return Err(e);
    }
  };

  let app_bg = app.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    run_separation(&app_bg, &path_clone, &work_dir, &out_clone)
  })
  .await
  .map_err(|e| format!("分离任务失败: {e}"));

  lock.0.store(false, Ordering::SeqCst);
  if let Ok(mut g) = job_path_slot().lock() {
    *g = None;
  }

  let result = result?;

  match result {
    Ok(()) => {
      emit_progress(StemProgressEvent {
        phase: "done".into(),
        percent: 100.0,
        message: "伴奏已就绪，可切换播放".into(),
        path: Some(path.clone()),
        bytes_done: None,
        bytes_total: None,
        busy: false,
      });
      Ok(StemInfo {
        ready: true,
        instrumental_path: Some(out.to_string_lossy().into()),
        message: "伴奏已生成".into(),
      })
    }
    Err(e) => {
      emit_progress(StemProgressEvent {
        phase: "error".into(),
        percent: 0.0,
        message: e.clone(),
        path: Some(path),
        bytes_done: None,
        bytes_total: None,
        busy: false,
      });
      Err(e)
    }
  }
}

/// 国内直连 HuggingFace 常失败；优先用内置/手工模型，再尝试镜像下载
const HF_MIRROR_MODEL: &str =
  "https://hf-mirror.com/gentij/htdemucs-ort/resolve/main/htdemucs.ort";
const HF_MODEL: &str =
  "https://huggingface.co/gentij/htdemucs-ort/resolve/main/htdemucs.ort";
const MODEL_SHA256: &str = "09dc165512d8ef7480bcb2cacea9dda82d571f8dbf421d8c44a2ca5568bec729";
const MODEL_SIZE_BYTES: u64 = 209_884_896;
const BUNDLED_MANIFEST_JSON: &str = include_str!("../resources/models/manifest.json");

fn stem_splitter_models_dir() -> Result<PathBuf, String> {
  let proj = directories::ProjectDirs::from("dev", "StemSplitter", "stem-splitter-core")
    .ok_or_else(|| "无法定位模型缓存目录".to_string())?;
  let dir = proj.cache_dir().join("models");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn cached_model_path() -> Result<PathBuf, String> {
  Ok(stem_splitter_models_dir()?.join(format!(
    "HTDemucs-ORT-{}.ort",
    &MODEL_SHA256[..8]
  )))
}

fn manual_install_hint(cache_file: &Path) -> String {
  format!(
    "请手动下载模型（约 200MB）后放到以下任一位置：\n\
     1) 项目内置：src-tauri/resources/models/htdemucs.ort\n\
     2) 缓存文件：{}\n\
     下载地址：\n\
     · {}\n\
     · {}",
    cache_file.display(),
    HF_MIRROR_MODEL,
    HF_MODEL
  )
}

fn sha256_file(path: &Path) -> Result<String, String> {
  let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
  let mut hasher = Sha256::new();
  let mut buf = [0u8; 1024 * 256];
  loop {
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn model_file_ok(path: &Path) -> bool {
  if !path.is_file() {
    return false;
  }
  match fs::metadata(path) {
    Ok(m) if m.len() == MODEL_SIZE_BYTES => {}
    Ok(m) if m.len() > MODEL_SIZE_BYTES.saturating_sub(1024) => {}
    _ => return false,
  }
  matches!(sha256_file(path), Ok(sum) if sum.eq_ignore_ascii_case(MODEL_SHA256))
}

fn bundled_model_candidates(app: &AppHandle) -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Ok(rd) = app.path().resource_dir() {
    out.push(rd.join("resources").join("models").join("htdemucs.ort"));
    out.push(rd.join("models").join("htdemucs.ort"));
    out.push(rd.join("htdemucs.ort"));
  }
  out.push(
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("resources")
      .join("models")
      .join("htdemucs.ort"),
  );
  out
}

fn copy_model_with_progress(src: &Path, dest: &Path) -> Result<(), String> {
  let total = fs::metadata(src).map(|m| m.len()).unwrap_or(MODEL_SIZE_BYTES);
  emit_progress(StemProgressEvent {
    phase: "download".into(),
    percent: 0.0,
    message: format!("正在安装本地模型… {}", src.display()),
    path: job_path_slot().lock().ok().and_then(|g| g.clone()),
    bytes_done: Some(0),
    bytes_total: Some(total),
    busy: true,
  });

  let tmp = dest.with_extension("ort.install");
  let mut reader = fs::File::open(src).map_err(|e| e.to_string())?;
  let mut writer = fs::File::create(&tmp).map_err(|e| e.to_string())?;
  let mut buf = [0u8; 256 * 1024];
  let mut done: u64 = 0;
  let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    writer.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    done += n as u64;
    if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
      last_emit = std::time::Instant::now();
      let pct = if total > 0 {
        (done as f64 / total as f64 * 100.0) as f32
      } else {
        0.0
      };
      emit_progress(StemProgressEvent {
        phase: "download".into(),
        percent: pct.clamp(0.0, 99.5),
        message: format!(
          "安装本地模型 {:.0}% · {:.1}/{:.1} MB",
          pct,
          done as f64 / 1e6,
          total as f64 / 1e6
        ),
        path: job_path_slot().lock().ok().and_then(|g| g.clone()),
        bytes_done: Some(done),
        bytes_total: Some(total),
        busy: true,
      });
    }
  }
  writer.flush().map_err(|e| e.to_string())?;
  drop(writer);

  if !model_file_ok(&tmp) {
    let _ = fs::remove_file(&tmp);
    return Err("本地模型校验失败，请重新下载 htdemucs.ort".into());
  }
  if dest.exists() {
    let _ = fs::remove_file(dest);
  }
  fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
  emit_progress(StemProgressEvent {
    phase: "download".into(),
    percent: 100.0,
    message: "本地模型已就绪".into(),
    path: job_path_slot().lock().ok().and_then(|g| g.clone()),
    bytes_done: Some(total),
    bytes_total: Some(total),
    busy: true,
  });
  Ok(())
}

/// 本地起一个一次性 HTTP，给 stem-splitter 读内置 manifest（完全离线）
fn serve_local_manifest() -> Result<String, String> {
  let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  let body = BUNDLED_MANIFEST_JSON.to_string();
  std::thread::spawn(move || {
    let _ = listener.set_nonblocking(false);
    if let Ok((mut stream, _)) = listener.accept() {
      let mut buf = [0u8; 2048];
      let _ = stream.read(&mut buf);
      let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
      );
      let _ = stream.write_all(resp.as_bytes());
      let _ = stream.flush();
    }
  });
  // 给监听线程一点时间 bind 完成
  std::thread::sleep(std::time::Duration::from_millis(30));
  Ok(format!("http://127.0.0.1:{port}/manifest.json"))
}

fn ensure_model_ready(app: &AppHandle) -> Result<String, String> {
  let local = cached_model_path()?;
  if model_file_ok(&local) {
    emit_progress(StemProgressEvent {
      phase: "download".into(),
      percent: 100.0,
      message: "已使用本地缓存模型".into(),
      path: job_path_slot().lock().ok().and_then(|g| g.clone()),
      bytes_done: Some(MODEL_SIZE_BYTES),
      bytes_total: Some(MODEL_SIZE_BYTES),
      busy: true,
    });
    return serve_local_manifest();
  }

  // 优先：程序内置 / 你手动放到 resources 的文件
  for cand in bundled_model_candidates(app) {
    if cand.is_file() {
      emit_progress(StemProgressEvent {
        phase: "download".into(),
        percent: 1.0,
        message: format!("发现本地模型：{}", cand.display()),
        path: job_path_slot().lock().ok().and_then(|g| g.clone()),
        bytes_done: None,
        bytes_total: Some(MODEL_SIZE_BYTES),
        busy: true,
      });
      copy_model_with_progress(&cand, &local)?;
      return serve_local_manifest();
    }
  }

  // 回退：尝试镜像下载
  match download_model_via_mirror(&local) {
    Ok(()) => serve_local_manifest(),
    Err(e) => Err(format!("{e}\n{}", manual_install_hint(&local))),
  }
}

fn download_model_via_mirror(local: &Path) -> Result<(), String> {
  emit_progress(StemProgressEvent {
    phase: "download".into(),
    percent: 0.0,
    message: "正在从镜像下载 AI 模型（约 200MB）…".into(),
    path: job_path_slot().lock().ok().and_then(|g| g.clone()),
    bytes_done: Some(0),
    bytes_total: Some(MODEL_SIZE_BYTES),
    busy: true,
  });

  let client = reqwest::blocking::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(30))
    .timeout(std::time::Duration::from_secs(60 * 60))
    .build()
    .map_err(|e| e.to_string())?;

  let urls = [HF_MIRROR_MODEL, HF_MODEL];
  let mut last_err = String::from("无可用下载源");
  for url in urls {
    let tmp = local.with_extension("ort.part");
    let result = (|| -> Result<(), String> {
      let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载 HTTP 错误: {e}"))?;

      let total = resp.content_length().unwrap_or(MODEL_SIZE_BYTES);
      let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
      let mut downloaded: u64 = 0;
      let mut buf = [0u8; 64 * 1024];
      let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
      loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
          break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
          last_emit = std::time::Instant::now();
          let pct = if total > 0 {
            (downloaded as f64 / total as f64 * 100.0) as f32
          } else {
            0.0
          };
          emit_progress(StemProgressEvent {
            phase: "download".into(),
            percent: pct.clamp(0.0, 99.5),
            message: format!(
              "已下载 {:.1} / {:.1} MB",
              downloaded as f64 / 1e6,
              total as f64 / 1e6
            ),
            path: job_path_slot().lock().ok().and_then(|g| g.clone()),
            bytes_done: Some(downloaded),
            bytes_total: Some(total),
            busy: true,
          });
        }
      }
      file.flush().map_err(|e| e.to_string())?;
      drop(file);

      let sum = sha256_file(&tmp)?;
      if !sum.eq_ignore_ascii_case(MODEL_SHA256) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("模型校验失败（期望 {MODEL_SHA256}，得到 {sum}）"));
      }
      if local.exists() {
        let _ = fs::remove_file(local);
      }
      fs::rename(&tmp, local).map_err(|e| e.to_string())?;
      Ok(())
    })();

    match result {
      Ok(()) => {
        emit_progress(StemProgressEvent {
          phase: "download".into(),
          percent: 100.0,
          message: "模型下载完成，开始分离…".into(),
          path: job_path_slot().lock().ok().and_then(|g| g.clone()),
          bytes_done: Some(MODEL_SIZE_BYTES),
          bytes_total: Some(MODEL_SIZE_BYTES),
          busy: true,
        });
        return Ok(());
      }
      Err(e) => {
        last_err = e;
        let _ = fs::remove_file(local.with_extension("ort.part"));
      }
    }
  }
  Err(last_err)
}

fn run_separation(
  app: &AppHandle,
  src: &str,
  work_dir: &Path,
  out_wav: &Path,
) -> Result<(), String> {
  let _ = fs::remove_dir_all(work_dir);
  fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
  configure_stem_accel();

  // 本地/内置优先；失败再给手工安装指引
  let manifest_url = ensure_model_ready(app)?;

  emit_progress(StemProgressEvent {
    phase: "split".into(),
    percent: 2.0,
    message: "加速：优先 GPU(DirectML)，不可用则多核 CPU".into(),
    path: Some(src.to_string()),
    bytes_done: None,
    bytes_total: None,
    busy: true,
  });

  let options = stem_splitter_core::SplitOptions {
    output_dir: work_dir.to_string_lossy().into(),
    model_name: "htdemucs_ort_v1".into(),
    manifest_url_override: Some(manifest_url),
  };

  let split = stem_splitter_core::split_file(src, options).map_err(|e| {
    let hint = cached_model_path()
      .map(|p| manual_install_hint(&p))
      .unwrap_or_default();
    format!("AI 分离失败: {e}\n{hint}")
  })?;

  emit_progress(StemProgressEvent {
    phase: "mix".into(),
    percent: 97.0,
    message: "正在混合鼓/贝斯/其它为伴奏…".into(),
    path: Some(src.to_string()),
    bytes_done: None,
    bytes_total: None,
    busy: true,
  });

  mix_stems_to_wav(
    Path::new(&split.drums_path),
    Path::new(&split.bass_path),
    Path::new(&split.other_path),
    out_wav,
  )?;

  // 清理中间 stem，只留伴奏
  let _ = fs::remove_dir_all(work_dir);
  let _ = app; // 进度已通过全局桥发送
  Ok(())
}

fn mix_stems_to_wav(drums: &Path, bass: &Path, other: &Path, out: &Path) -> Result<(), String> {
  let mut r_d = hound::WavReader::open(drums).map_err(|e| e.to_string())?;
  let mut r_b = hound::WavReader::open(bass).map_err(|e| e.to_string())?;
  let mut r_o = hound::WavReader::open(other).map_err(|e| e.to_string())?;
  let spec = r_d.spec();
  if r_b.spec().channels != spec.channels
    || r_o.spec().channels != spec.channels
    || r_b.spec().sample_rate != spec.sample_rate
    || r_o.spec().sample_rate != spec.sample_rate
  {
    return Err("分轨采样格式不一致".into());
  }

  let tmp = out.with_extension("tmp.wav");
  {
    let mut writer = hound::WavWriter::create(&tmp, spec).map_err(|e| e.to_string())?;
    // 统一按 f32 混音再写回
    match spec.sample_format {
      hound::SampleFormat::Int => {
        let sd: Vec<i32> = r_d
          .samples::<i32>()
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        let sb: Vec<i32> = r_b
          .samples::<i32>()
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        let so: Vec<i32> = r_o
          .samples::<i32>()
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        let n = sd.len().min(sb.len()).min(so.len());
        let max_a = (1i64 << (spec.bits_per_sample.min(31) - 1)) as f32;
        for i in 0..n {
          let v = (sd[i] as f32 + sb[i] as f32 + so[i] as f32) / max_a;
          let o = (v * 0.92 * max_a).clamp(-max_a, max_a - 1.0) as i32;
          writer.write_sample(o).map_err(|e| e.to_string())?;
        }
      }
      hound::SampleFormat::Float => {
        let sd: Vec<f32> = r_d
          .samples::<f32>()
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        let sb: Vec<f32> = r_b
          .samples::<f32>()
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        let so: Vec<f32> = r_o
          .samples::<f32>()
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        let n = sd.len().min(sb.len()).min(so.len());
        for i in 0..n {
          let v = ((sd[i] + sb[i] + so[i]) * 0.92).clamp(-1.0, 1.0);
          writer.write_sample(v).map_err(|e| e.to_string())?;
        }
      }
    }
    writer.finalize().map_err(|e| e.to_string())?;
  }

  // 原子替换
  if out.exists() {
    let _ = fs::remove_file(out);
  }
  fs::rename(&tmp, out).map_err(|e| {
    let _ = fs::remove_file(&tmp);
    e.to_string()
  })?;
  // 写个小标记方便排查
  let _ = fs::File::create(out.with_extension("wav.ok")).and_then(|mut f| {
    writeln!(f, "instrumental from demucs drums+bass+other")
  });
  Ok(())
}
