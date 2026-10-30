// 持久化：把前端 localStorage 里的 sp.* 数据落到应用数据目录的 store.json
// localStorage 仍是运行时缓存；这里保证 WebView 数据被清掉 / 换安装方式后节目单不丢
// 写入：先写 .tmp 再 rename（断电不会留下半截文件）；旧文件定期轮转进 backups/

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const STORE_FILE: &str = "store.json";
const BACKUP_DIR: &str = "backups";
/// 自动备份最短间隔
const BACKUP_EVERY: Duration = Duration::from_secs(10 * 60);
/// 保留的备份份数
const BACKUP_KEEP: usize = 20;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// backups/ 下按修改时间从新到旧
fn list_backups(dir: &Path) -> Vec<(SystemTime, PathBuf)> {
    let mut v: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v
}

fn write_backup(dir: &Path, tag: &str, contents: &[u8]) -> Result<(), String> {
    let bdir = dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
    let name = format!("store-{}-{tag}.json", unix_now());
    std::fs::write(bdir.join(name), contents).map_err(|e| e.to_string())?;
    for (_, old) in list_backups(&bdir).into_iter().skip(BACKUP_KEEP) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

fn is_valid(s: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(s)
        .map(|v| v.get("data").is_some_and(|d| d.is_object()))
        .unwrap_or(false)
}

/// 读取 store.json；损坏时回退到最新的可用备份。没有任何数据返回 None
#[tauri::command]
pub async fn store_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir(&app)?;
        if let Ok(s) = std::fs::read_to_string(dir.join(STORE_FILE)) {
            if is_valid(&s) {
                return Ok(Some(s));
            }
        }
        for (_, p) in list_backups(&dir.join(BACKUP_DIR)) {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if is_valid(&s) {
                    return Ok(Some(s));
                }
            }
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存整份快照。backup=true 时无论间隔都先把旧文件存一份（迁移 / 覆盖前用）
#[tauri::command]
pub async fn store_save(app: tauri::AppHandle, json: String, backup: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_valid(&json) {
            return Err("数据格式不正确".into());
        }
        let dir = data_dir(&app)?;
        let path = dir.join(STORE_FILE);
        if let Ok(old) = std::fs::read(&path) {
            let due = list_backups(&dir.join(BACKUP_DIR))
                .first()
                .and_then(|(t, _)| t.elapsed().ok())
                .is_none_or(|age| age >= BACKUP_EVERY);
            if backup.unwrap_or(false) || due {
                write_backup(&dir, if backup.unwrap_or(false) { "pre" } else { "auto" }, &old)?;
            }
        }
        let tmp = dir.join(format!("{STORE_FILE}.tmp"));
        std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("写入失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 单独存一份备份（例如被文件数据覆盖前的本机旧数据）
#[tauri::command]
pub async fn store_backup(app: tauri::AppHandle, json: String, tag: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tag: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
        write_backup(&data_dir(&app)?, if tag.is_empty() { "manual" } else { &tag }, json.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 打开数据目录（设置里“打开数据文件夹”）
#[tauri::command]
pub fn store_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}
