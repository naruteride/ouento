//! OS facts and window-only capture. Collection permission is checked before any pixels are read.
use base64::Engine;
use serde::{Deserialize, Serialize};
mod events;
pub use events::{
    OsEvent, OsEventCertainty, OsEventKind, OsEventScope, OsEventSource, OsEventTarget,
    WindowEventTracker,
};
use std::{
    hash::{Hash, Hasher},
    io::Cursor,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: String,
    pub supported: bool,
    pub detail: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub platform: String,
    pub screen_permission: String,
    pub capabilities: Vec<Capability>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSample {
    pub x: f64,
    pub y: f64,
    pub coordinate_space: String,
    pub timestamp: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub timestamp: u64,
    pub typing: Option<bool>,
    pub locked: Option<bool>,
    pub focus_mode: Option<bool>,
    pub meeting: Option<bool>,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u32,
    pub app_id: String,
    pub app_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub focused: bool,
    pub minimized: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub window_id: u32,
    pub pid: u32,
    pub app_id: String,
    pub consented: bool,
    #[serde(default)]
    pub excluded_apps: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedFrame {
    pub window: WindowInfo,
    pub image_base64: String,
    pub mime_type: String,
    pub fingerprint: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: u64,
}

pub(super) fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(any(target_os = "windows", test))]
fn recent_input_from_ticks(now: u32, last_input: u32) -> Option<bool> {
    let elapsed = now.wrapping_sub(last_input);
    // GetTickCount and LASTINPUTINFO wrap at 32 bits. A future/non-monotonic
    // injected timestamp must be unknown rather than proof of idle input.
    (elapsed <= i32::MAX as u32).then_some(elapsed < 1500)
}

fn capability(name: &str, supported: bool, detail: &str) -> Capability {
    Capability {
        name: name.into(),
        supported,
        detail: detail.into(),
    }
}

pub fn capabilities() -> PlatformCapabilities {
    let supported = cfg!(any(target_os = "macos", target_os = "windows"));
    let screen_permission = screen_permission();
    let typing_available = activity_snapshot().typing.is_some();
    let typing = if cfg!(target_os = "macos") {
        if typing_available {
            "최근 키보드 활동 여부만 확인합니다. 입력 내용은 수집하지 않습니다."
        } else {
            "입력 활동을 확인할 수 없어 자동 관찰을 쉬고 있습니다. 시스템 설정의 입력 모니터링 권한을 확인하세요. 지금 화면 분석과 직접 대화는 계속 사용할 수 있습니다."
        }
    } else {
        "최근 키보드·마우스 입력을 함께 감지해 입력 중 자동 관찰을 쉽니다. 입력 종류·키코드·내용은 수집하지 않습니다. 감지 실패 시 자동 관찰을 중단합니다."
    };
    PlatformCapabilities {
        platform: std::env::consts::OS.into(),
        screen_permission,
        capabilities: vec![
            capability("전역 커서", supported, "OS 전역 커서 좌표를 반환합니다. 혼합 배율의 창 변환은 Tauri 좌표계를 따릅니다."),
            capability("선택 창 캡처", supported, "사용자가 허용한 단일 창을 캡처합니다. 보호 화면·권한 거부는 오류로 표시합니다."),
            capability("창 전환", supported, "OS 창 ID·프로세스·앱 식별자·활성 상태를 확인합니다."),
            capability("입력 중 감지", supported && typing_available, typing),
            capability("세션·잠금 보호", supported, "Windows 보안 데스크톱과 macOS 비활성 콘솔·디스플레이 절전에서 관찰을 억제합니다. macOS 잠금 키는 보조 신호이며 OS별 잠금 실기 검증이 필요합니다."),
            capability("OS 집중·회의 감지", false, "수동 집중·회의 모드를 사용하세요. OS 상태를 추측하지 않습니다."),
            capability("출력 장치 볼륨 사건", false, "양 OS 기본 표시 검증 이후 추가할 기능입니다."),
        ],
    }
}

pub fn screen_permission() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::screen_permission().into()
    }
    #[cfg(target_os = "windows")]
    {
        "not_required".into()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unsupported".into()
    }
}

pub fn request_screen_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::request_screen_permission())
    }
    #[cfg(target_os = "windows")]
    {
        Ok(true)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("지원하지 않는 운영체제입니다.".into())
    }
}

pub fn cursor_position() -> Result<CursorSample, String> {
    #[cfg(target_os = "macos")]
    {
        macos::cursor_position()
    }
    #[cfg(target_os = "windows")]
    {
        windows::cursor_position()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("지원하지 않는 운영체제입니다.".into())
    }
}

/// The physical primary-button state lets native drag keep hit testing stable until release.
pub fn primary_button_down() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::primary_button_down()
    }
    #[cfg(target_os = "windows")]
    {
        windows::primary_button_down()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

pub fn activity_snapshot() -> ActivitySnapshot {
    #[cfg(target_os = "macos")]
    {
        macos::activity_snapshot()
    }
    #[cfg(target_os = "windows")]
    {
        windows::activity_snapshot()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ActivitySnapshot {
            timestamp: timestamp(),
            typing: None,
            locked: None,
            focus_mode: None,
            meeting: None,
            source: "unsupported".into(),
        }
    }
}

/// A stable OS app identity, not a window title or user-supplied model string.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn app_id(pid: u32) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::app_id(pid)
    }
    #[cfg(target_os = "windows")]
    {
        windows::app_id(pid)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn describe_window(window: &xcap::Window) -> Result<WindowInfo, String> {
    let err = |e: xcap::XCapError| format!("창 정보를 읽을 수 없습니다: {e}");
    let pid = window.pid().map_err(err)?;
    Ok(WindowInfo {
        id: window.id().map_err(err)?,
        pid,
        app_id: app_id(pid)?,
        app_name: window.app_name().map_err(err)?,
        title: window.title().map_err(err)?,
        x: window.x().map_err(err)?,
        y: window.y().map_err(err)?,
        width: window.width().map_err(err)?,
        height: window.height().map_err(err)?,
        focused: window.is_focused().map_err(err)?,
        minimized: window.is_minimized().map_err(err)?,
    })
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut windows = Vec::new();
        for window in xcap::Window::all().map_err(|e| format!("창 목록을 읽을 수 없습니다: {e}"))?
        {
            if let Ok(info) = describe_window(&window) {
                if info.pid != std::process::id()
                    && !info.title.is_empty()
                    && info.width > 0
                    && info.height > 0
                {
                    windows.push(info);
                }
            }
        }
        windows.sort_by(|a, b| {
            b.focused
                .cmp(&a.focused)
                .then(a.app_name.cmp(&b.app_name))
                .then(a.id.cmp(&b.id))
        });
        Ok(windows)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("창 캡처는 macOS와 Windows에서 지원합니다.".into())
    }
}

pub fn sensitive_app(app_id: &str, app_name: &str, custom: &[String]) -> bool {
    let id = app_id.to_lowercase();
    let name = app_name.to_lowercase();
    // This is defense in depth. An explicit selected-window/application allowlist remains mandatory.
    let protected = [
        "1password",
        "bitwarden",
        "keepass",
        "lastpass",
        "dashlane",
        "keychain",
        "키체인",
        "passwords",
        "com.apple.systempreferences",
        "systemsettings",
        "credential",
        "authy",
    ];
    protected
        .iter()
        .any(|needle| id.contains(needle) || name.contains(needle))
        || custom.iter().any(|blocked| {
            blocked.eq_ignore_ascii_case(app_id) || blocked.eq_ignore_ascii_case(app_name)
        })
}

fn authorize_capture(request: &CaptureRequest, actual: &WindowInfo) -> Result<(), String> {
    if !request.consented {
        return Err("선택 창 캡처에 먼저 동의해 주세요.".into());
    }
    if actual.id != request.window_id
        || actual.pid != request.pid
        || actual.app_id != request.app_id
    {
        return Err("선택한 창이 닫히거나 대상이 변경되어 캡처를 취소했습니다.".into());
    }
    if actual.pid == std::process::id() {
        return Err("Ouento 자신의 창은 관찰하지 않습니다.".into());
    }
    if sensitive_app(&actual.app_id, &actual.app_name, &request.excluded_apps) {
        return Err("민감 앱으로 제외된 창은 캡처하지 않습니다.".into());
    }
    if actual.minimized {
        return Err("최소화된 창은 캡처할 수 없습니다. 선택 창을 표시해 주세요.".into());
    }
    if actual.width == 0
        || actual.height == 0
        || u64::from(actual.width) * u64::from(actual.height) > 100_000_000
    {
        return Err("캡처할 수 없는 창 크기입니다.".into());
    }
    Ok(())
}

pub fn capture_window(request: &CaptureRequest) -> Result<CapturedFrame, String> {
    // Reject before even enumerating a window if no collection consent exists.
    if !request.consented {
        return Err("화면 캡처 동의가 없습니다.".into());
    }
    if activity_snapshot().locked == Some(true) {
        return Err("화면 잠금/보안 데스크톱 중에는 캡처하지 않습니다.".into());
    }
    if screen_permission() == "denied" {
        return Err("현재 실행 중인 Ouento에 화면 접근 권한이 적용되지 않았습니다. 시스템 설정에서 Ouento의 화면 기록을 허용하고, 이미 허용했다면 앱을 완전히 종료한 뒤 다시 열어 주세요.".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let windows = xcap::Window::all().map_err(|e| format!("창 목록을 읽지 못했습니다: {e}"))?;
        let window = windows
            .into_iter()
            .find(|w| w.id().ok() == Some(request.window_id))
            .ok_or("선택한 창을 찾지 못했습니다.")?;
        let before = describe_window(&window)?;
        authorize_capture(request, &before)?;
        let pixels = window
            .capture_image()
            .map_err(|e| format!("선택 창 캡처에 실패했습니다: {e}"))?;
        let after = describe_window(&window)?;
        authorize_capture(request, &after)?;
        if screen_permission() == "denied" || activity_snapshot().locked == Some(true) {
            return Err("캡처 중 권한/보안 상태가 변경되었습니다.".into());
        }
        if pixels.width() == 0 || pixels.height() == 0 {
            return Err("캡처한 화면이 비어 있습니다.".into());
        }
        let image = image::DynamicImage::ImageRgba8(pixels).thumbnail(1280, 1280);
        let fingerprint_pixels = image.thumbnail(32, 32).to_rgb8();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        fingerprint_pixels.as_raw().hash(&mut hasher);
        request.window_id.hash(&mut hasher);
        request.pid.hash(&mut hasher);
        let fingerprint = format!("{:016x}", hasher.finish());
        let (width, height) = (image.width(), image.height());
        let mut output = Cursor::new(Vec::new());
        image
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|e| format!("캡처 이미지를 인코딩할 수 없습니다: {e}"))?;
        Ok(CapturedFrame {
            window: after,
            image_base64: base64::engine::general_purpose::STANDARD.encode(output.into_inner()),
            mime_type: "image/png".into(),
            fingerprint,
            width,
            height,
            captured_at: timestamp(),
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("창 캡처는 macOS와 Windows에서 지원합니다.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_timestamp_keeps_short_events_and_handles_tick_wrap() {
        // Input was pressed and released 500 ms before the sample.
        assert_eq!(recent_input_from_ticks(10_000, 9_500), Some(true));
        assert_eq!(recent_input_from_ticks(10_000, 8_000), Some(false));
        assert_eq!(recent_input_from_ticks(100, u32::MAX - 399), Some(true));
        assert_eq!(recent_input_from_ticks(100, 110), None);
    }
    fn window() -> WindowInfo {
        WindowInfo {
            id: 8,
            pid: std::process::id() + 100,
            app_id: "com.example.editor".into(),
            app_name: "Editor".into(),
            title: "Notes".into(),
            x: -1000,
            y: 0,
            width: 1000,
            height: 800,
            focused: true,
            minimized: false,
        }
    }
    fn request(w: &WindowInfo) -> CaptureRequest {
        CaptureRequest {
            window_id: w.id,
            pid: w.pid,
            app_id: w.app_id.clone(),
            consented: true,
            excluded_apps: Vec::new(),
        }
    }
    #[test]
    fn no_consent_or_reused_window_id_cannot_capture() {
        let w = window();
        let mut r = request(&w);
        r.consented = false;
        assert!(authorize_capture(&r, &w).is_err());
        r.consented = true;
        r.pid += 1;
        assert!(authorize_capture(&r, &w).is_err());
        r.pid = w.pid;
        r.app_id = "different.exe".into();
        assert!(authorize_capture(&r, &w).is_err());
    }
    #[test]
    fn sensitive_custom_self_and_minimized_are_denied() {
        let mut w = window();
        let mut r = request(&w);
        r.excluded_apps.push(w.app_id.clone());
        assert!(authorize_capture(&r, &w).is_err());
        r.excluded_apps.clear();
        w.minimized = true;
        assert!(authorize_capture(&r, &w).is_err());
        w.minimized = false;
        w.pid = std::process::id();
        r.pid = w.pid;
        assert!(authorize_capture(&r, &w).is_err());
        assert!(sensitive_app("com.1password.1password", "1Password", &[]));
        assert!(!sensitive_app("com.example.editor", "Editor", &[]));
    }
    #[test]
    fn valid_window_is_authorized_and_zero_size_is_not() {
        let mut w = window();
        let r = request(&w);
        assert!(authorize_capture(&r, &w).is_ok());
        w.width = 0;
        assert!(authorize_capture(&r, &w).is_err());
    }
}
