// Windows 系统总音量（默认播放设备）：键盘 Fn+音量键调的就是它。
// 音乐页显示一条「系统」音量条跟着走，也能直接拖它改系统音量。

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct SystemVolume {
    /// 0~1
    pub volume: f32,
    pub muted: bool,
}

#[cfg(windows)]
mod imp {
    use super::SystemVolume;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Every successful COM initialization must be paired on the same thread.
    /// Volume polling happens continuously, so leaving COM initialized leaks its
    /// per-thread reference count over the lifetime of the app.
    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED)
                    .ok()
                    .map_err(|e| format!("无法初始化系统音量接口: {e}"))?;
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    /// 每次现取默认设备：用户在系统里换了默认声卡也能跟上
    fn endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("无法读取系统音量: {e}"))?;
            let dev = en
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("没有默认播放设备: {e}"))?;
            dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                .map_err(|e| format!("无法读取系统音量: {e}"))
        }
    }

    fn read(ep: &IAudioEndpointVolume) -> Result<SystemVolume, String> {
        unsafe {
            let volume = ep.GetMasterVolumeLevelScalar().map_err(|e| e.to_string())?;
            let muted = ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            Ok(SystemVolume { volume, muted })
        }
    }

    pub fn get() -> Result<SystemVolume, String> {
        let _com = ComApartment::initialize()?;
        let ep = endpoint()?;
        read(&ep)
    }

    pub fn set(v: f32) -> Result<SystemVolume, String> {
        let _com = ComApartment::initialize()?;
        let ep = endpoint()?;
        unsafe {
            ep.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null())
                .map_err(|e| format!("无法设置系统音量: {e}"))?;
        }
        read(&ep)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::SystemVolume;
    pub fn get() -> Result<SystemVolume, String> {
        Err("仅支持 Windows".into())
    }
    pub fn set(_v: f32) -> Result<SystemVolume, String> {
        Err("仅支持 Windows".into())
    }
}

/// 读 Windows 系统音量（默认播放设备）
#[tauri::command]
pub async fn system_volume_get() -> Result<SystemVolume, String> {
    tauri::async_runtime::spawn_blocking(imp::get)
        .await
        .map_err(|e| e.to_string())?
}

/// 设 Windows 系统音量（0~1）
#[tauri::command]
pub async fn system_volume_set(v: f32) -> Result<SystemVolume, String> {
    tauri::async_runtime::spawn_blocking(move || imp::set(v))
        .await
        .map_err(|e| e.to_string())?
}
