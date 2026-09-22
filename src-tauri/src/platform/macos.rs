//! CoreGraphics/CoreFoundation boundary. No accessibility text or key contents are collected.
use super::{timestamp, ActivitySnapshot, CursorSample};
use std::{
    ffi::{c_char, c_int, c_void},
    path::Path,
};

#[repr(C)]
struct Point {
    x: f64,
    y: f64,
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *const c_void) -> Point;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventSourceSecondsSinceLastEventType(state_id: c_int, event_type: u32) -> f64;
    fn CGEventSourceButtonState(state_id: c_int, button: u32) -> bool;
    fn CGSessionCopyCurrentDictionary() -> *mut c_void;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayIsAsleep(display: u32) -> u32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const c_void);
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: *const c_void,
        buffer: *const u8,
        length: isize,
        is_directory: bool,
    ) -> *mut c_void;
    fn CFBundleCreate(allocator: *const c_void, url: *const c_void) -> *mut c_void;
    fn CFBundleGetIdentifier(bundle: *const c_void) -> *const c_void;
    fn CFStringGetCString(
        value: *const c_void,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> bool;
    fn CFStringCreateWithBytes(
        allocator: *const c_void,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: bool,
    ) -> *mut c_void;
    fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
    fn CFBooleanGetValue(value: *const c_void) -> bool;
    fn CFBooleanGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(value: *const c_void, number_type: c_int, output: *mut c_void) -> bool;
    fn CFGetTypeID(value: *const c_void) -> usize;
}
#[link(name = "System")]
extern "C" {
    fn proc_pidpath(pid: c_int, buffer: *mut c_void, size: u32) -> c_int;
}

pub fn screen_permission() -> &'static str {
    if unsafe { CGPreflightScreenCaptureAccess() } {
        "granted"
    } else {
        "denied"
    }
}
pub fn request_screen_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}
pub fn primary_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}

pub fn cursor_position() -> Result<CursorSample, String> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return Err("전역 커서 위치를 읽을 수 없습니다.".into());
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Ok(CursorSample {
            x: point.x,
            y: point.y,
            coordinate_space: "desktop_points".into(),
            timestamp: timestamp(),
        })
    }
}

pub fn activity_snapshot() -> ActivitySnapshot {
    let typing = if unsafe { CGPreflightListenEventAccess() } {
        // kCGCombinedSessionState = 0, kCGEventKeyDown = 10, kCGEventKeyUp = 11.
        let last = unsafe {
            CGEventSourceSecondsSinceLastEventType(0, 10)
                .min(CGEventSourceSecondsSinceLastEventType(0, 11))
        };
        if last.is_finite() && last >= 0.0 {
            Some(last < 1.5)
        } else {
            None
        }
    } else {
        None
    };
    ActivitySnapshot {
        timestamp: timestamp(),
        typing,
        locked: Some(session_restricted()),
        focus_mode: None,
        meeting: None,
        source: "core_graphics_session_best_effort".into(),
    }
}

/// Fail closed when no active console/display exists. The lock dictionary key is a
/// supplementary, undocumented signal; it is not represented as an Apple API guarantee.
fn session_restricted() -> bool {
    unsafe {
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 {
            return true;
        }
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            return true;
        }
        let boolean = |name: &str| -> Option<bool> {
            let key = CFStringCreateWithBytes(
                std::ptr::null(),
                name.as_bytes().as_ptr(),
                name.len() as isize,
                0x08000100,
                false,
            );
            if key.is_null() {
                return None;
            }
            let value = CFDictionaryGetValue(session, key);
            CFRelease(key);
            if value.is_null() {
                return None;
            }
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                return Some(CFBooleanGetValue(value));
            }
            if CFGetTypeID(value) == CFNumberGetTypeID() {
                let mut number = 0i64;
                if CFNumberGetValue(value, 4, (&mut number as *mut i64).cast()) {
                    return Some(number != 0);
                }
            }
            None
        };
        let on_console = boolean("kCGSSessionOnConsoleKey");
        let login_done = boolean("kCGSessionLoginDoneKey");
        let screen_locked = boolean("CGSSessionScreenIsLocked");
        CFRelease(session);
        on_console != Some(true) || login_done != Some(true) || screen_locked == Some(true)
    }
}

pub fn app_id(pid: u32) -> Result<String, String> {
    let mut buffer = vec![0u8; 4096];
    let length = unsafe {
        proc_pidpath(
            pid as c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return Err("앱 실행 파일 경로를 확인할 수 없습니다.".into());
    }
    let end = buffer
        .iter()
        .position(|b| *b == 0)
        .unwrap_or(length as usize);
    let path = std::str::from_utf8(&buffer[..end]).map_err(|_| "앱 경로를 읽을 수 없습니다.")?;
    if let Some(bundle_path) = Path::new(path)
        .ancestors()
        .find(|p| p.extension().is_some_and(|s| s == "app"))
    {
        let bytes = bundle_path
            .to_str()
            .ok_or("앱 번들 경로를 읽을 수 없습니다.")?
            .as_bytes();
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                true,
            );
            if !url.is_null() {
                let bundle = CFBundleCreate(std::ptr::null(), url);
                CFRelease(url);
                if !bundle.is_null() {
                    let id = CFBundleGetIdentifier(bundle);
                    let mut result = vec![0u8; 1024];
                    let success = !id.is_null()
                        && CFStringGetCString(
                            id,
                            result.as_mut_ptr().cast(),
                            result.len() as isize,
                            0x08000100,
                        );
                    CFRelease(bundle);
                    if success {
                        let end = result.iter().position(|b| *b == 0).unwrap_or(result.len());
                        return String::from_utf8(result[..end].to_vec())
                            .map_err(|_| "앱 식별자를 읽을 수 없습니다.".into());
                    }
                }
            }
        }
    }
    // Non-bundle tools have an absolute executable identity, not an ambiguous display name.
    Ok(path.to_owned())
}
