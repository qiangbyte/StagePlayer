mod audio;
mod dialog;
mod fileio;
mod karaoke;
mod lyric_follow;
mod output;
mod pect;
mod pptx;
mod spl;
mod stem;
mod store;
mod wave;

use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

/// 若主窗口完全落在所有显示器之外，拉回主显示器居中。
fn ensure_main_on_screen(win: &tauri::WebviewWindow) {
    let Ok(pos) = win.outer_position() else {
        return;
    };
    let Ok(size) = win.outer_size() else {
        return;
    };
    let monitors = win.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return;
    }
    let on_any = monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let left = mp.x;
        let top = mp.y;
        let right = mp.x + ms.width as i32;
        let bottom = mp.y + ms.height as i32;
        // 窗口至少有一部分与显示器相交
        pos.x < right
            && pos.x + size.width as i32 > left
            && pos.y < bottom
            && pos.y + size.height as i32 > top
    });
    if on_any {
        return;
    }
    let mon = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next());
    let Some(mon) = mon else {
        return;
    };
    let mp = mon.position();
    let ms = mon.size();
    let w = size.width.min(ms.width).max(800);
    let h = size.height.min(ms.height).max(600);
    let x = mp.x + ((ms.width.saturating_sub(w)) / 2) as i32;
    let y = mp.y + ((ms.height.saturating_sub(h)) / 2) as i32;
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：第二个实例在这里就退出，并把主窗口唤到前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                ensure_main_on_screen(&win);
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                #[cfg(debug_assertions)]
                {
                    win.open_devtools();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(fileio::ApprovedSavePaths::default())
        .manage(stem::StemLock(std::sync::atomic::AtomicBool::new(false)))
        .manage(lyric_follow::LyricFollowHandle::new())
        .setup(|app| {
            app.manage(audio::AudioHandle::new(app.handle().clone()));
            app.manage(spl::SplHandle::new(app.handle().clone()));
            stem::init_progress_bridge(app.handle().clone());
            lyric_follow::init_bridge(app.handle().clone());
            // Windows 标题栏跟随深色主题，与界面一致
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_theme(Some(tauri::Theme::Dark));
                let _ = win.set_background_color(Some(tauri::window::Color(0x1b, 0x1b, 0x1f, 0xff)));
                // 防止主窗口落在屏外（-25600 一类坐标）导致「看得见点不动」
                ensure_main_on_screen(&win);
                let _ = win.show();
                let _ = win.set_focus();
                // WebView2 刚 show 时立刻 open_devtools 常失败，延后补开
                #[cfg(debug_assertions)]
                {
                    win.open_devtools();
                    let win2 = win.clone();
                    std::thread::spawn(move || {
                        for delay_ms in [300u64, 900, 1800] {
                            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                            if !win2.is_devtools_open() {
                                win2.open_devtools();
                            } else {
                                break;
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|win, ev| {
            if win.label() != "main" {
                return;
            }
            match ev {
                // 大屏正在投屏时关主窗口：先交给前端确认（演出中误点 ✕ 大屏会跟着黑掉）
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if output::should_confirm_close(win.app_handle()) {
                        api.prevent_close();
                        let _ = win.emit("main:close-requested", ());
                    } else {
                        output::destroy_output(win.app_handle());
                    }
                }
                // 关主窗口 = 退出程序：输出窗口一起关掉，不能留在扩展屏上
                tauri::WindowEvent::Destroyed => output::destroy_output(win.app_handle()),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            dialog::pick_files,
            fileio::pick_save_path,
            fileio::copy_file,
            fileio::make_image_thumb,
            fileio::make_video_thumb,
            fileio::existing_files,
            fileio::write_text_file,
            fileio::read_show_file,
            store::store_load,
            store::store_save,
            store::store_backup,
            store::store_dir,
            karaoke::vocal_cancel_export,
            pptx::parse_pptx,
            pect::import_pect,
            output::open_output_window,
            output::set_output_fullscreen,
            output::close_output_window,
            output::set_output_always_on_top,
            output::list_monitors,
            output::place_output_on_monitor,
            output::quit_app,
            audio::list_audio_output_devices,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_resume,
            audio::audio_stop,
            audio::audio_set_volume,
            audio::audio_seek,
            audio::audio_state,
            audio::audio_set_vocal_cancel,
            wave::audio_wave,
            stem::stem_get_instrumental,
            stem::stem_ensure_instrumental,
            stem::stem_job_status,
            spl::spl_list_inputs,
            spl::spl_start,
            spl::spl_stop,
            spl::spl_set_params,
            spl::spl_get_snapshot,
            lyric_follow::lyric_asr_status,
            lyric_follow::lyric_asr_ensure_model,
            lyric_follow::lyric_follow_start,
            lyric_follow::lyric_follow_stop,
            lyric_follow::lyric_follow_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
