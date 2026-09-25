//! Explicit, one-shot monitor capture. Desktop coordinates stay in the native
//! platform's space (macOS points / Windows physical pixels), separate from the
//! actual captured bitmap dimensions. No image is persisted here.
use super::{activity_snapshot, cursor_position, screen_permission, sensitive_app, timestamp};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    hash::{Hash, Hasher},
    io::Cursor,
};

const MAX_PIXELS: u64 = 100_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenInfo {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenCaptureRequest {
    pub screen: ScreenInfo,
    pub consented: bool,
    #[serde(default)]
    pub excluded_apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedScreen {
    pub screen: ScreenInfo,
    pub image_base64: String,
    pub mime_type: String,
    pub fingerprint: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    pub(super) fn intersects(&self, screen: &ScreenInfo) -> Result<bool, String> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            || self.width < 0.0
            || self.height < 0.0
        {
            return Err("창의 화면 영역을 확인하지 못해 전체 화면 분석을 쉽니다.".into());
        }
        Ok(self.width > 0.0
            && self.height > 0.0
            && self.x < f64::from(screen.x) + f64::from(screen.width)
            && self.y < f64::from(screen.y) + f64::from(screen.height)
            && self.x + self.width > f64::from(screen.x)
            && self.y + self.height > f64::from(screen.y))
    }
}

/// Raw OS enumeration deliberately includes titleless/tool/desktop windows.
/// Window titles are neither needed nor collected for monitor authorization.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ScreenWindow {
    pub id: usize,
    pub pid: u32,
    pub bounds: Bounds,
    pub app_id: String,
    pub app_name: String,
}

fn valid_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("전체 화면의 크기가 캡처 한도를 벗어났습니다.".into());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn describe_screen(monitor: &xcap::Monitor) -> Result<ScreenInfo, String> {
    let err = |_| "모니터 정보를 읽지 못했습니다.".to_string();
    let screen = ScreenInfo {
        id: monitor.id().map_err(err)?,
        x: monitor.x().map_err(err)?,
        y: monitor.y().map_err(err)?,
        width: monitor.width().map_err(err)?,
        height: monitor.height().map_err(err)?,
    };
    valid_size(screen.width, screen.height)?;
    Ok(screen)
}

pub fn current_screen() -> Result<ScreenInfo, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let cursor = cursor_position()?;
        if !cursor.x.is_finite()
            || !cursor.y.is_finite()
            || cursor.x < f64::from(i32::MIN)
            || cursor.x > f64::from(i32::MAX)
            || cursor.y < f64::from(i32::MIN)
            || cursor.y > f64::from(i32::MAX)
        {
            return Err("마우스가 있는 모니터를 확인하지 못했습니다.".into());
        }
        // CGEvent + CGDisplayBounds use the same point space on macOS; Win32
        // cursor + DEVMODE use physical desktop pixels. Never apply Tauri's DPI.
        let monitor = xcap::Monitor::from_point(cursor.x.floor() as i32, cursor.y.floor() as i32)
            .map_err(|_| "마우스가 있는 모니터를 찾지 못했습니다.")?;
        describe_screen(&monitor)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("모니터 캡처는 macOS와 Windows에서 지원합니다.".into())
    }
}

fn validate_environment(screen: &ScreenInfo) -> Result<(), String> {
    valid_size(screen.width, screen.height)?;
    if activity_snapshot().locked != Some(false) {
        return Err("화면 잠금/보안 상태를 확인할 수 없어 전체 화면 분석을 쉽니다.".into());
    }
    if !matches!(screen_permission().as_str(), "granted" | "not_required") {
        return Err("화면 접근 권한이 없어 전체 화면 분석을 쉽니다.".into());
    }
    if current_screen()? != *screen {
        return Err("마우스의 모니터 또는 화면 구성이 바뀌어 분석을 취소했습니다.".into());
    }
    Ok(())
}

pub(super) fn authorize_windows(
    screen: &ScreenInfo,
    windows: &[ScreenWindow],
    excluded: &[String],
    own_pid: u32,
) -> Result<(), String> {
    for window in windows {
        if !window.bounds.intersects(screen)? || window.pid == own_pid {
            continue;
        }
        if window.pid == 0 || window.app_id.is_empty() {
            return Err("화면에 보이는 앱을 확인하지 못해 전체 화면 분석을 쉽니다.".into());
        }
        if sensitive_app(&window.app_id, &window.app_name, excluded) {
            return Err("민감 앱의 창이 이 모니터에 보여 전체 화면 분석을 쉽니다.".into());
        }
    }
    Ok(())
}

/// Windows excludes Ouento by individual HWND, so a newly visible own window
/// must already belong to this capture's exclusion guard. Other apps may move,
/// resize, open, or close without invalidating an authorized monitor capture.
#[cfg(any(target_os = "windows", test))]
pub(super) fn authorize_capture_exclusions(
    windows: &[ScreenWindow],
    excluded_window_ids: &[usize],
    own_pid: u32,
) -> Result<(), String> {
    if windows
        .iter()
        .any(|window| window.pid == own_pid && !excluded_window_ids.contains(&window.id))
    {
        return Err("캡처에서 제외되지 않은 Ouento 창이 나타나 분석을 취소했습니다.".into());
    }
    Ok(())
}

fn screen_windows(screen: &ScreenInfo, excluded: &[String]) -> Result<Vec<ScreenWindow>, String> {
    validate_environment(screen)?;
    #[cfg(target_os = "macos")]
    let windows = super::macos::screen_windows(screen)?;
    #[cfg(target_os = "windows")]
    let windows = super::windows::screen_windows(screen)?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let windows = Vec::new();
    authorize_windows(screen, &windows, excluded, std::process::id())?;
    Ok(windows)
}

pub fn validate_screen(screen: &ScreenInfo, excluded_apps: &[String]) -> Result<(), String> {
    screen_windows(screen, excluded_apps).map(|_| ())
}

pub fn capture_screen(request: &ScreenCaptureRequest) -> Result<CapturedScreen, String> {
    if !request.consented {
        return Err("모니터 전체 캡처에 먼저 동의해 주세요.".into());
    }
    validate_screen(&request.screen, &request.excluded_apps)?;
    #[cfg(target_os = "macos")]
    let pixels = super::macos::capture_screen_pixels(&request.screen, &request.excluded_apps)?;
    #[cfg(target_os = "windows")]
    let pixels = super::windows::capture_screen_pixels(&request.screen, &request.excluded_apps)?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let pixels = image::RgbaImage::new(0, 0);
    // Recheck the live permission, monitor, lock state, and sensitive apps.
    // Ordinary window changes do not change the user's monitor-wide scope;
    // each platform separately guarantees exclusion of our own windows.
    validate_screen(&request.screen, &request.excluded_apps)?;
    valid_size(pixels.width(), pixels.height())?;
    let image = image::DynamicImage::ImageRgba8(pixels).thumbnail(1280, 1280);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    image.thumbnail(32, 32).to_rgb8().as_raw().hash(&mut hasher);
    request.screen.hash(&mut hasher);
    let (width, height) = (image.width(), image.height());
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| "전체 화면 이미지를 인코딩하지 못했습니다.")?;
    Ok(CapturedScreen {
        screen: request.screen.clone(),
        image_base64: base64::engine::general_purpose::STANDARD.encode(output.into_inner()),
        mime_type: "image/png".into(),
        fingerprint: format!("{:016x}", hasher.finish()),
        width,
        height,
        captured_at: timestamp(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn screen() -> ScreenInfo {
        ScreenInfo {
            id: 1,
            x: -1920,
            y: -200,
            width: 1920,
            height: 1080,
        }
    }
    fn window(x: f64, pid: u32, app: &str) -> ScreenWindow {
        ScreenWindow {
            id: 7,
            pid,
            bounds: Bounds {
                x,
                y: 0.0,
                width: 300.0,
                height: 100.0,
            },
            app_id: app.into(),
            app_name: String::new(),
        }
    }
    #[test]
    fn titleless_sensitive_windows_crossing_monitor_edges_are_denied() {
        let s = screen();
        assert!(
            authorize_windows(&s, &[window(-10.0, 12, "com.1password.1password")], &[], 3).is_err()
        );
        assert!(
            authorize_windows(&s, &[window(0.0, 12, "com.1password.1password")], &[], 3).is_ok()
        );
        assert!(authorize_windows(
            &s,
            &[window(-100.0, 12, "editor.exe")],
            &["editor.exe".into()],
            3
        )
        .is_err());
    }
    #[test]
    fn unknown_metadata_is_denied_and_only_own_pid_is_exempt() {
        let s = screen();
        assert!(authorize_windows(&s, &[window(-100.0, 12, "")], &[], 3).is_err());
        assert!(authorize_windows(&s, &[window(-100.0, 0, "system")], &[], 3).is_err());
        assert!(authorize_windows(&s, &[window(-100.0, 3, "")], &[], 3).is_ok());
        let mut bad = window(-100.0, 3, "");
        bad.bounds.width = f64::NAN;
        assert!(authorize_windows(&s, &[bad], &[], 3).is_err());
    }
    #[test]
    fn ordinary_window_changes_preserve_monitor_authorization() {
        let s = screen();
        let before = vec![window(-800.0, 12, "editor.exe")];
        let mut moved = before[0].clone();
        moved.bounds.x = -300.0;
        moved.bounds.width = 600.0;
        let mut opened = window(-700.0, 18, "browser.exe");
        opened.id = 8;
        // Moving/resizing, opening, closing, and arbitrary enumeration order
        // all preserve the selected monitor's ordinary-app authorization.
        for snapshot in [
            before,
            vec![moved.clone(), opened.clone()],
            vec![opened.clone(), moved],
            vec![opened],
            vec![],
        ] {
            assert!(authorize_windows(&s, &snapshot, &[], 3).is_ok());
        }
    }
    #[test]
    fn fresh_sensitive_or_unidentified_windows_still_revoke_authorization() {
        let s = screen();
        let ordinary = window(-800.0, 12, "editor.exe");
        assert!(authorize_windows(&s, std::slice::from_ref(&ordinary), &[], 3).is_ok());
        for new_window in [
            window(-500.0, 18, "com.1password.1password"),
            window(-500.0, 18, "private.exe"),
            window(-500.0, 18, ""),
        ] {
            assert!(authorize_windows(
                &s,
                &[ordinary.clone(), new_window],
                &["private.exe".into()],
                3,
            )
            .is_err());
        }
    }
    #[test]
    fn capture_exclusions_only_require_current_own_windows_to_be_protected() {
        let own = window(-800.0, 3, "");
        let mut new_own = own.clone();
        new_own.id = 8;
        let mut ordinary = window(-500.0, 12, "editor.exe");
        ordinary.id = 9;
        assert!(authorize_capture_exclusions(&[own.clone(), ordinary.clone()], &[7], 3).is_ok());
        assert!(authorize_capture_exclusions(std::slice::from_ref(&ordinary), &[7], 3).is_ok());
        assert!(authorize_capture_exclusions(&[own, new_own.clone(), ordinary], &[7], 3).is_err());
        assert!(authorize_capture_exclusions(&[new_own], &[7, 8], 3).is_ok());
    }
    #[test]
    fn capture_budget_rejects_empty_and_overflow_sized_bitmaps() {
        assert!(valid_size(0, 100).is_err());
        assert!(valid_size(u32::MAX, u32::MAX).is_err());
        assert!(valid_size(10_000, 10_000).is_ok());
    }
    #[test]
    fn missing_consent_fails_without_touching_the_desktop() {
        assert!(capture_screen(&ScreenCaptureRequest {
            screen: screen(),
            consented: false,
            excluded_apps: vec![]
        })
        .unwrap_err()
        .contains("동의"));
    }
}
