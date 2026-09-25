//! Monitor capture uses the WGC backend already enabled for xcap. Raw Win32
//! enumeration is required: xcap's picker excludes own and titleless tool windows.
use super::{app_id, Handle};
use crate::platform::screen::{
    authorize_capture_exclusions, authorize_windows, Bounds, ScreenInfo, ScreenWindow,
};
use std::sync::Mutex;
use std::{ffi::c_void, mem::size_of};

static CAPTURE_EXCLUSION_LOCK: Mutex<()> = Mutex::new(());

#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct VersionInfo {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform: u32,
    service_pack: [u16; 128],
}

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(Handle, isize) -> i32, data: isize) -> i32;
    fn IsWindowVisible(window: Handle) -> i32;
    fn IsIconic(window: Handle) -> i32;
    fn IsWindow(window: Handle) -> i32;
    fn GetWindowThreadProcessId(window: Handle, pid: *mut u32) -> u32;
    fn GetWindowRect(window: Handle, rect: *mut Rect) -> i32;
    fn SetThreadDpiAwarenessContext(context: Handle) -> Handle;
    fn SetWindowDisplayAffinity(window: Handle, affinity: u32) -> i32;
    fn GetWindowDisplayAffinity(window: Handle, affinity: *mut u32) -> i32;
}
#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(window: Handle, attribute: u32, output: *mut c_void, size: u32)
        -> i32;
    fn DwmIsCompositionEnabled(enabled: *mut i32) -> i32;
}
#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(version: *mut VersionInfo) -> i32;
}

fn supported() -> Result<(), String> {
    let mut version = VersionInfo {
        size: size_of::<VersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    let mut composing = 0;
    // SAFETY: both output pointers address initialized repr(C) OS structs/scalars
    // of the exact documented size and remain live for the synchronous calls.
    if unsafe { RtlGetVersion(&mut version) } < 0
        || version.major < 10
        || (version.major == 10 && version.build < 19041)
        || unsafe { DwmIsCompositionEnabled(&mut composing) } < 0
        || composing == 0
    {
        return Err("모니터 전체 보기는 Windows 10 2004 이상의 데스크톱에서 지원합니다.".into());
    }
    Ok(())
}

struct DpiContext(Handle);
impl DpiContext {
    fn physical() -> Result<Self, String> {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is the documented pseudo
        // handle -4, not a dereferenced pointer. Restore this worker's old context.
        let previous = unsafe { SetThreadDpiAwarenessContext(-4isize as Handle) };
        if previous.is_null() {
            return Err("화면 좌표의 배율을 확인하지 못했습니다.".into());
        }
        Ok(Self(previous))
    }
}
impl Drop for DpiContext {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

struct Enumeration {
    handles: Vec<Handle>,
    overflow: bool,
}
unsafe extern "system" fn collect_window(window: Handle, data: isize) -> i32 {
    // SAFETY: EnumWindows is synchronous; data is our exclusive stack-owned
    // Enumeration for the duration of this callback and never escapes it.
    let result = &mut *(data as *mut Enumeration);
    if result.handles.len() >= 16_384 {
        result.overflow = true;
        return 0;
    }
    result.handles.push(window);
    1
}

pub(crate) fn screen_windows(screen: &ScreenInfo) -> Result<Vec<ScreenWindow>, String> {
    supported()?;
    let _dpi = DpiContext::physical()?;
    let mut enumeration = Enumeration {
        handles: vec![],
        overflow: false,
    };
    // SAFETY: callback signature is WNDENUMPROC and the stack pointer remains
    // valid until synchronous enumeration returns.
    if unsafe {
        EnumWindows(
            collect_window,
            (&mut enumeration as *mut Enumeration) as isize,
        )
    } == 0
        || enumeration.overflow
    {
        return Err("전체 화면의 창 목록을 확인하지 못했습니다.".into());
    }
    let mut result = Vec::new();
    for window in enumeration.handles {
        // SAFETY: handles came from EnumWindows; Win32 validates handles that
        // disappear concurrently. Every metadata failure below aborts capture.
        unsafe {
            if IsWindow(window) == 0 {
                continue;
            }
            if IsWindowVisible(window) == 0 || IsIconic(window) != 0 {
                continue;
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(
                window,
                14,
                (&mut cloaked as *mut u32).cast(),
                size_of::<u32>() as u32,
            ) < 0
            {
                return Err("화면의 창 표시 상태를 확인하지 못했습니다.".into());
            }
            if cloaked != 0 {
                continue;
            }
            let mut rect = Rect::default();
            if GetWindowRect(window, &mut rect) == 0 {
                return Err("화면의 창 영역을 확인하지 못했습니다.".into());
            }
            let bounds = Bounds {
                x: f64::from(rect.left),
                y: f64::from(rect.top),
                width: f64::from(rect.right) - f64::from(rect.left),
                height: f64::from(rect.bottom) - f64::from(rect.top),
            };
            if !bounds.intersects(screen)? {
                continue;
            }
            let mut pid = 0;
            if GetWindowThreadProcessId(window, &mut pid) == 0 || pid == 0 {
                return Err("화면의 창 소유 앱을 확인하지 못했습니다.".into());
            }
            let identity = if pid == std::process::id() {
                String::new()
            } else {
                app_id(pid)?
            };
            result.push(ScreenWindow {
                id: window as usize,
                pid,
                bounds,
                app_name: identity
                    .strip_suffix(".exe")
                    .unwrap_or(&identity)
                    .to_owned(),
                app_id: identity,
            });
        }
    }
    Ok(result)
}

struct CaptureExclusion(Vec<(Handle, u32)>);
impl CaptureExclusion {
    fn new(windows: &[ScreenWindow]) -> Result<Self, String> {
        let mut guard = Self(vec![]);
        for window in windows.iter().filter(|w| w.pid == std::process::id()) {
            let handle = window.id as Handle;
            let mut previous = 0;
            // SAFETY: only top-level handles enumerated for our current PID are
            // changed; the API itself rejects foreign/stale handles.
            if unsafe { GetWindowDisplayAffinity(handle, &mut previous) } == 0 {
                return Err("Ouento 창의 캡처 제외 상태를 확인하지 못했습니다.".into());
            }
            guard.0.push((handle, previous));
            if unsafe { SetWindowDisplayAffinity(handle, 0x11) } == 0 {
                return Err("Ouento 창을 제외할 수 없어 전체 화면 분석을 쉽니다.".into());
            }
        }
        guard.verify(windows)?;
        Ok(guard)
    }
    fn verify(&self, windows: &[ScreenWindow]) -> Result<(), String> {
        let excluded_ids: Vec<_> = self.0.iter().map(|(handle, _)| *handle as usize).collect();
        authorize_capture_exclusions(windows, &excluded_ids, std::process::id())?;
        for window in windows.iter().filter(|w| w.pid == std::process::id()) {
            let mut affinity = 0;
            if unsafe { GetWindowDisplayAffinity(window.id as Handle, &mut affinity) } == 0
                || affinity != 0x11
            {
                return Err("Ouento 창의 캡처 제외가 변경되어 분석을 취소했습니다.".into());
            }
        }
        Ok(())
    }
}
impl Drop for CaptureExclusion {
    fn drop(&mut self) {
        for (handle, previous) in &self.0 {
            let mut pid = 0;
            // Do not restore a recycled handle now owned by another process.
            if unsafe { GetWindowThreadProcessId(*handle, &mut pid) } != 0
                && pid == std::process::id()
            {
                unsafe {
                    SetWindowDisplayAffinity(*handle, *previous);
                }
            }
        }
    }
}

pub(crate) fn capture_screen_pixels(
    screen: &ScreenInfo,
    excluded_apps: &[String],
) -> Result<image::RgbaImage, String> {
    // A cancelled request can overlap its replacement. Serialize temporary
    // affinity changes so one guard cannot restore another capture's flags.
    let _exclusive = CAPTURE_EXCLUSION_LOCK
        .try_lock()
        .map_err(|_| "다른 화면 캡처가 정리 중입니다. 잠시 후 다시 시도해 주세요.")?;
    let _dpi = DpiContext::physical()?;
    let windows = screen_windows(screen)?;
    authorize_windows(screen, &windows, excluded_apps, std::process::id())?;
    let guard = CaptureExclusion::new(&windows)?;
    let monitors = xcap::Monitor::all().map_err(|_| "모니터를 찾지 못했습니다.")?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.id().ok() == Some(screen.id))
        .ok_or("선택한 모니터가 사라졌습니다.")?;
    if monitor.x().ok() != Some(screen.x)
        || monitor.y().ok() != Some(screen.y)
        || monitor.width().ok() != Some(screen.width)
        || monitor.height().ok() != Some(screen.height)
    {
        return Err("모니터 구성이 바뀌어 캡처를 취소했습니다.".into());
    }
    let pixels = monitor
        .capture_image()
        .map_err(|_| "모니터 전체 캡처에 실패했습니다.")?;
    // Keep the affinity guard alive while checking the latest own windows.
    // A newly shown own HWND was not protected during capture and invalidates
    // these pixels; ordinary third-party window changes remain acceptable.
    let windows = screen_windows(screen)?;
    authorize_windows(screen, &windows, excluded_apps, std::process::id())?;
    guard.verify(&windows)?;
    Ok(pixels)
}
