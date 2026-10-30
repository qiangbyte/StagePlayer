use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize, Clone)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

fn collect_monitors(app: &AppHandle) -> Result<Vec<(MonitorInfo, tauri::Monitor)>, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().ok().flatten();
    Ok(monitors
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let info = MonitorInfo {
                index: i,
                name: m.name().cloned().unwrap_or_default(),
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
                scale_factor: m.scale_factor(),
                is_primary: primary
                    .as_ref()
                    .map(|p| p.name() == m.name() && p.position() == m.position())
                    .unwrap_or(false),
            };
            (info, m)
        })
        .collect())
}

/// 打开（或聚焦）输出窗口；可选在指定显示器上创建
#[tauri::command]
pub async fn open_output_window(
    app: AppHandle,
    monitor_index: Option<usize>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("output") {
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(idx) = monitor_index {
            place_on_monitor(&app, idx, false)?;
        }
        return Ok(());
    }

    let mut builder =
        WebviewWindowBuilder::new(&app, "output", WebviewUrl::App("output.html".into()))
            .title("输出画面")
            .resizable(true)
            .decorations(false)
            .visible(true)
            .skip_taskbar(false);

    if let Some(idx) = monitor_index {
        if let Some((info, m)) = collect_monitors(&app)?.into_iter().find(|(i, _)| i.index == idx) {
            let scale = m.scale_factor();
            // 创建参数使用逻辑像素
            let lx = info.x as f64 / scale;
            let ly = info.y as f64 / scale;
            let lw = (info.width as f64 / scale).max(320.0);
            let lh = (info.height as f64 / scale).max(240.0);
            builder = builder.position(lx, ly).inner_size(lw, lh);
        } else {
            builder = builder.inner_size(1280.0, 720.0);
        }
    } else {
        builder = builder.inner_size(1280.0, 720.0);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = win.set_focus();

    // 创建后再用物理坐标钉死一次，避免 DPI 换算偏差
    if let Some(idx) = monitor_index {
        // 等窗口句柄就绪
        tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(80));
        })
        .await
        .ok();
        let _ = place_on_monitor(&app, idx, false);
    }
    Ok(())
}

/// 切换输出窗口全屏（当前所在屏）
#[tauri::command]
pub async fn set_output_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("output")
        .ok_or("输出窗口未打开")?;
    win.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭输出窗口（先退全屏/置顶，避免 Windows 下关不掉）
#[tauri::command]
pub async fn close_output_window(app: AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("output") else {
        return Ok(());
    };
    let _ = win.set_fullscreen(false);
    let _ = win.set_always_on_top(false);
    let _ = win.set_decorations(true);
    let _ = win.hide();
    tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(std::time::Duration::from_millis(50));
    })
    .await
    .ok();
    // hide 后窗口句柄可能仍在
    if let Some(win) = app.get_webview_window("output") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 输出窗口置顶
#[tauri::command]
pub async fn set_output_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    let win = app.get_webview_window("output").ok_or("输出窗口未打开")?;
    win.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    Ok(())
}

/// 枚举所有显示器
#[tauri::command]
pub async fn list_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    Ok(collect_monitors(&app)?
        .into_iter()
        .map(|(info, _)| info)
        .collect())
}

/// 将输出窗口放置到指定显示器（fullscreen=true 时铺满该屏）
#[tauri::command]
pub async fn place_output_on_monitor(
    app: AppHandle,
    index: usize,
    fullscreen: bool,
) -> Result<MonitorInfo, String> {
    // 分两步：先无边框铺满，再尝试独占全屏到该监视器
    let info = place_on_monitor(&app, index, false)?;

    if fullscreen {
        tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(120));
        })
        .await
        .ok();

        if let Some(win) = app.get_webview_window("output") {
            let cx = info.x as f64 + info.width as f64 / 2.0;
            let cy = info.y as f64 + info.height as f64 / 2.0;
            // Tauri 2.12+：按监视器位置进入全屏（解决 Windows 跳回主屏）
            if win
                .set_fullscreen_on_monitor(PhysicalPosition::new(cx, cy))
                .is_err()
            {
                // 回退：保持无边框铺满（演出场景同样可用）
                let _ = place_on_monitor(&app, index, false);
            } else {
                // 校验窗口是否落在目标屏；若仍跑偏则强制无边框铺满
                tauri::async_runtime::spawn_blocking(|| {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                })
                .await
                .ok();
                if !window_on_monitor(&win, &info) {
                    let _ = win.set_fullscreen(false);
                    let _ = place_on_monitor(&app, index, false);
                }
            }
        }
    }

    Ok(info)
}

fn window_on_monitor(win: &tauri::WebviewWindow, info: &MonitorInfo) -> bool {
    let Ok(pos) = win.outer_position() else {
        return false;
    };
    let margin = 80;
    pos.x >= info.x - margin
        && pos.x < info.x + info.width as i32
        && pos.y >= info.y - margin
        && pos.y < info.y + info.height as i32
}

/// 无边框铺满指定显示器（投影/LED 最稳妥的方式）
fn place_on_monitor(app: &AppHandle, index: usize, _fullscreen: bool) -> Result<MonitorInfo, String> {
    let win = app
        .get_webview_window("output")
        .ok_or("请先打开输出窗口")?;
    let list = collect_monitors(app)?;
    let (info, m) = list
        .into_iter()
        .find(|(i, _)| i.index == index)
        .ok_or("显示器不存在")?;

    let pos = m.position();
    let size = m.size();

    let _ = win.set_fullscreen(false);
    let _ = win.set_decorations(false);
    let _ = win.unmaximize();

    // Windows 多屏：先挪到监视器内一点，再贴齐原点，促使 DWM 认屏
    let _ = win.set_position(PhysicalPosition::new(pos.x + 8, pos.y + 8));
    let _ = win.set_size(PhysicalSize::new(
        size.width.saturating_sub(16).max(320),
        size.height.saturating_sub(16).max(240),
    ));
    let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
    let _ = win.set_size(PhysicalSize::new(size.width, size.height));
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();

    Ok(info)
}
