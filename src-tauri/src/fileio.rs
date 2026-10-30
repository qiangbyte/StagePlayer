use base64::Engine as _;
use std::io::Write;
use tauri_plugin_dialog::DialogExt;

/// 保存文件对话框（返回所选路径，取消返回 None）
#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
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
    Ok(picked.map(|f| f.to_string()))
}

/// 复制文件（用于导出 AI 分离缓存的伴奏）
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<u64, String> {
    let n = std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
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

/// 分块追加写入文件（base64 数据块；create=true 时新建文件）
#[tauri::command]
pub async fn append_file(path: String, data_b64: String, create: bool) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let mut f = if create {
        std::fs::File::create(&path).map_err(|e| e.to_string())?
    } else {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?
    };
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}
