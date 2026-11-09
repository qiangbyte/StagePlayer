// .pect 诗歌演示文件导入：本质是 zip，内含 index（JSON：歌曲 / 每页歌词 / 背景）+ 背景图片和视频。
// 把背景素材解压到应用数据目录（pect/<文件 id>/），返回 index 原文和素材的本机路径，由前端转成歌词库与节目单

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use tauri::Manager;

#[derive(Serialize)]
pub struct PectImport {
    /// index 的 JSON 原文
    pub index: String,
    /// 包内文件名 → 解压后的本机路径
    pub files: HashMap<String, String>,
}

#[tauri::command]
pub async fn import_pect(app: tauri::AppHandle, path: String) -> Result<PectImport, String> {
    tauri::async_runtime::spawn_blocking(move || import_blocking(&app, &path))
        .await
        .map_err(|e| e.to_string())?
}

fn import_blocking(app: &tauri::AppHandle, path: &str) -> Result<PectImport, String> {
    let file = fs::File::open(path).map_err(|e| format!("打不开文件：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "不是有效的 .pect 文件".to_string())?;

    let mut index = String::new();
    zip.by_name("index")
        .map_err(|_| "不是有效的 .pect 文件（缺少 index）".to_string())?
        .read_to_string(&mut index)
        .map_err(|e| format!("读取 index 失败：{e}"))?;

    // 同一个文件重复导入时解压到同一目录，已解压过的素材不再重写
    let id: String = serde_json::from_str::<serde_json::Value>(&index)
        .ok()
        .and_then(|v| v.get("id").map(|x| x.to_string()))
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pect")
        .join(if id.is_empty() { "unknown" } else { id.as_str() });
    fs::create_dir_all(&dir).map_err(|e| format!("创建素材目录失败：{e}"))?;

    let mut files = HashMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        // 只取文件名，丢弃包内路径（防止 ../ 写到别处）
        let Some(name) = entry
            .enclosed_name()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        else {
            continue;
        };
        if name == "index" {
            continue;
        }
        let out = dir.join(&name);
        let same = out.metadata().map(|m| m.len() == entry.size()).unwrap_or(false);
        if !same {
            let mut w = fs::File::create(&out).map_err(|e| format!("写入 {name} 失败：{e}"))?;
            std::io::copy(&mut entry, &mut w).map_err(|e| format!("解压 {name} 失败：{e}"))?;
        }
        files.insert(name, out.to_string_lossy().into_owned());
    }
    Ok(PectImport { index, files })
}
