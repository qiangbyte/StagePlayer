mod audio;
mod dialog;
mod fileio;
mod karaoke;
mod output;
mod pptx;
mod spl;
mod stem;
mod store;
mod wave;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：第二个实例在这里就退出，并把主窗口唤到前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(fileio::ApprovedSavePaths::default())
        .manage(stem::StemLock(std::sync::atomic::AtomicBool::new(false)))
        .setup(|app| {
            app.manage(audio::AudioHandle::new(app.handle().clone()));
            app.manage(spl::SplHandle::new(app.handle().clone()));
            stem::init_progress_bridge(app.handle().clone());
            // Windows 标题栏跟随深色主题，与界面一致
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_theme(Some(tauri::Theme::Dark));
                let _ = win.set_background_color(Some(tauri::window::Color(0x1b, 0x1b, 0x1f, 0xff)));
            }
            Ok(())
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
            output::open_output_window,
            output::set_output_fullscreen,
            output::close_output_window,
            output::set_output_always_on_top,
            output::list_monitors,
            output::place_output_on_monitor,
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
            spl::spl_get_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
