use base64::Engine as _;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 用户通过保存对话框亲自选过的路径；写文件类命令只允许写这些路径
#[derive(Default)]
pub struct ApprovedSavePaths(Mutex<HashSet<PathBuf>>);

impl ApprovedSavePaths {
    fn approve(&self, p: PathBuf) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(p);
    }

    /// 校验目标路径来自保存对话框，防止前端被注入后写任意文件
    pub fn check(&self, p: &str) -> Result<(), String> {
        let ok = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&PathBuf::from(p));
        if ok {
            Ok(())
        } else {
            Err("保存路径未经用户确认".into())
        }
    }
}

/// 保存文件对话框（返回所选路径，取消返回 None）
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    approved: State<'_, ApprovedSavePaths>,
    default_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_title("保存文件")
        .set_file_name(&default_name);
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter("文件", &exts);
    }
    // 该版本插件没有阻塞式保存 API：用回调 + 通道等待用户选择
    let (tx, rx) = std::sync::mpsc::channel();
    builder.save_file(move |f| {
        let _ = tx.send(f);
    });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    let picked = picked.map(|f| f.to_string());
    if let Some(p) = &picked {
        approved.approve(PathBuf::from(p));
    }
    Ok(picked)
}

/// 复制文件（用于导出 AI 分离缓存的伴奏）
/// 仅允许：源在伴奏缓存目录内，目标是用户在保存对话框里选的路径
#[tauri::command]
pub async fn copy_file(
    app: AppHandle,
    approved: State<'_, ApprovedSavePaths>,
    src: String,
    dst: String,
) -> Result<u64, String> {
    approved.check(&dst)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("stem-instrumental");
    let cache = std::fs::canonicalize(&cache).map_err(|e| e.to_string())?;
    let src_c = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
    if !src_c.starts_with(&cache) {
        return Err("只能导出伴奏缓存文件".into());
    }
    let n = std::fs::copy(&src_c, &dst).map_err(|e| e.to_string())?;
    Ok(n)
}

/// 原生生成图片缩略图（最长边 320px 的 JPEG dataURL）
/// 在 Rust 侧解码，避免 WebView 渲染进程解码高清原图导致 OOM；失败返回 None
#[tauri::command]
pub async fn make_image_thumb(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let opened = image::ImageReader::open(&path)
            .ok()
            .and_then(|r| r.with_guessed_format().ok());
        let img = match opened.and_then(|r| r.decode().ok()) {
            Some(img) => img,
            None => return Ok(None),
        };
        let thumb = img.thumbnail(320, 320);
        let mut buf = std::io::Cursor::new(Vec::new());
        if thumb
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .is_err()
        {
            return Ok(None);
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(buf.get_ref());
        Ok(Some(format!("data:image/jpeg;base64,{b64}")))
    })
    .await
    .map_err(|e| e.to_string())?
}
