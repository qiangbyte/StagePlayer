use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// 打开文件选择对话框（在 blocking 线程执行，避免 async 命令死锁）
#[tauri::command]
pub async fn pick_files(
    app: AppHandle,
    title: String,
    extensions: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title(&title);
        if !extensions.is_empty() {
            let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter("文件", &exts);
        }
        let files = builder.blocking_pick_files();
        Ok(files
            .unwrap_or_default()
            .into_iter()
            .filter_map(file_path_to_string)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn file_path_to_string(f: FilePath) -> Option<String> {
    match f.into_path() {
        Ok(p) => Some(p.to_string_lossy().into_owned()),
        Err(_) => None,
    }
}
