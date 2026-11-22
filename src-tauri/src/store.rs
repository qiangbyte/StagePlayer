// 持久化：把前端 localStorage 里的 sp.* 数据落到磁盘 store.json
// 优先：安装目录旁 data/（和 exe 同级，升级只换 exe 时转写/节目单都还在）
// 回退：系统 AppData（安装目录不可写时，如 Program Files）
// localStorage 仍是运行时缓存；写入先 .tmp 再 rename；旧文件定期轮转进 backups/

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const STORE_FILE: &str = "store.json";
const BACKUP_DIR: &str = "backups";
const PORTABLE_DIR: &str = "data";
/// 自动备份最短间隔
const BACKUP_EVERY: Duration = Duration::from_secs(10 * 60);
/// 保留的备份份数
const BACKUP_KEEP: usize = 20;

fn appdata_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir)
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 探测目录是否可写（创建 + 写探针文件）
fn dir_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".sp_write_probe");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn portable_dir() -> Option<PathBuf> {
    let base = exe_dir()?;
    let dir = base.join(PORTABLE_DIR);
    if dir_writable(&dir) {
        Some(dir)
    } else {
        None
    }
}

/// 从 AppData 迁到安装目录 data/（只在目标还没有有效 store 时）
fn migrate_from_appdata(app: &tauri::AppHandle, dest: &Path) {
    let dest_store = dest.join(STORE_FILE);
    if dest_store.is_file() {
        if let Ok(s) = std::fs::read_to_string(&dest_store) {
            if is_valid(&s) {
                return;
            }
        }
    }
    let Ok(src_dir) = appdata_dir(app) else {
        return;
    };
    if src_dir == dest {
        return;
    }
    let src_store = src_dir.join(STORE_FILE);
    if let Ok(bytes) = std::fs::read(&src_store) {
        if is_valid(&String::from_utf8_lossy(&bytes)) {
            let tmp = dest.join(format!("{STORE_FILE}.tmp"));
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &dest_store);
            }
        }
    }
    // 顺带把 backups 拷一份（不覆盖已有）
    let src_b = src_dir.join(BACKUP_DIR);
    let dest_b = dest.join(BACKUP_DIR);
    if src_b.is_dir() {
        let _ = std::fs::create_dir_all(&dest_b);
        if let Ok(rd) = std::fs::read_dir(&src_b) {
            for e in rd.flatten() {
                let to = dest_b.join(e.file_name());
                if !to.exists() {
                    let _ = std::fs::copy(e.path(), to);
                }
            }
        }
    }
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = portable_dir() {
        migrate_from_appdata(app, &dir);
        return Ok(dir);
    }
    appdata_dir(app)
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

fn try_load_from(dir: &Path) -> Option<String> {
    if let Ok(s) = std::fs::read_to_string(dir.join(STORE_FILE)) {
        if is_valid(&s) {
            return Some(s);
        }
    }
    for (_, p) in list_backups(&dir.join(BACKUP_DIR)) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if is_valid(&s) {
                return Some(s);
            }
        }
    }
    None
}

/// 读取 store.json；损坏时回退到最新的可用备份。没有任何数据返回 None
#[tauri::command]
pub async fn store_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir(&app)?;
        if let Some(s) = try_load_from(&dir) {
            return Ok(Some(s));
        }
        // 安装目录还没有时，再读一次 AppData（旧版位置）
        if let Ok(ad) = appdata_dir(&app) {
            if ad != dir {
                if let Some(s) = try_load_from(&ad) {
                    // 写回安装目录，下次直接用
                    let tmp = dir.join(format!("{STORE_FILE}.tmp"));
                    if std::fs::write(&tmp, s.as_bytes()).is_ok() {
                        let _ = std::fs::rename(&tmp, dir.join(STORE_FILE));
                    }
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
