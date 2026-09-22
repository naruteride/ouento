//! Win32 API boundary. Input-idle timestamps contain no keys or text; secure desktops suppress observation.
use super::{timestamp, ActivitySnapshot, CursorSample};
use std::ffi::c_void;
type Handle = *mut c_void;
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    time: u32,
}
#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetAsyncKeyState(key: i32) -> i16;
    fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> Handle;
    fn GetUserObjectInformationW(
        object: Handle,
        index: i32,
        info: *mut c_void,
        length: u32,
        needed: *mut u32,
    ) -> i32;
    fn CloseDesktop(desktop: Handle) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

pub fn cursor_position() -> Result<CursorSample, String> {
    let mut point = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err("전역 커서 위치를 읽을 수 없습니다.".into());
    }
    Ok(CursorSample {
        x: f64::from(point.x),
        y: f64::from(point.y),
        coordinate_space: "physical_pixels".into(),
        timestamp: timestamp(),
    })
}

pub fn primary_button_down() -> bool {
    unsafe { GetAsyncKeyState(1) < 0 }
}

fn restricted_desktop() -> bool {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, 1); // DESKTOP_READOBJECTS; never switch or activate a desktop.
        if desktop.is_null() {
            return true;
        }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let ok = GetUserObjectInformationW(
            desktop,
            2,
            name.as_mut_ptr().cast(),
            (name.len() * 2) as u32,
            &mut needed,
        ); // UOI_NAME
        CloseDesktop(desktop);
        if ok == 0 {
            return true;
        }
        let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        !String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
    }
}

pub fn activity_snapshot() -> ActivitySnapshot {
    let locked = restricted_desktop();
    let typing = if locked {
        None
    } else {
        // A key-down/key-up pair between polls is retained by the OS timestamp.
        // This deliberately also suppresses reactions during mouse input; it does
        // not claim to distinguish typing from other activity or inspect keycodes.
        let mut input = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            time: 0,
        };
        if unsafe { GetLastInputInfo(&mut input) } == 0 {
            None
        } else {
            super::recent_input_from_ticks(unsafe { GetTickCount() }, input.time)
        }
    };
    ActivitySnapshot {
        timestamp: timestamp(),
        typing,
        locked: Some(locked),
        focus_mode: None,
        meeting: None,
        source: "win32_last_input_and_desktop".into(),
    }
}

pub fn app_id(pid: u32) -> Result<String, String> {
    unsafe {
        let process = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if process.is_null() {
            return Err("앱 프로세스를 확인할 수 없습니다.".into());
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let success = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if success == 0 {
            return Err("앱 실행 파일 경로를 확인할 수 없습니다.".into());
        }
        let path = String::from_utf16(&buffer[..length as usize])
            .map_err(|_| "앱 경로를 읽을 수 없습니다.")?;
        Ok(path
            .rsplit(['\\', '/'])
            .next()
            .ok_or("앱 실행 파일 이름이 없습니다.")?
            .to_ascii_lowercase())
    }
}
