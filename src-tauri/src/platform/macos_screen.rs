//! ScreenCaptureKit's display/app filter removes every Ouento window at the
//! compositor, including windows created after the shareable-content snapshot.
//! This mode requires macOS 14; legacy selected-window capture remains separate.
use crate::platform::screen::{authorize_windows, Bounds, ScreenInfo, ScreenWindow};
use block2::RcBlock;
use objc2::{available, AnyThread, MainThreadMarker};
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCRunningApplication, SCScreenshotManager, SCShareableContent,
    SCStreamConfiguration, SCWindow,
};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

fn supported_worker() -> Result<(), String> {
    if !available!(macos = 14.0) {
        return Err(
            "모니터 전체 보기는 macOS 14 이상에서 지원합니다. 선택 창 함께 보기를 사용해 주세요."
                .into(),
        );
    }
    if MainThreadMarker::new().is_some() {
        return Err("화면 확인은 백그라운드 작업에서 실행해야 합니다.".into());
    }
    Ok(())
}

fn with_content<T: Send + 'static>(
    operation: impl Fn(&SCShareableContent) -> Result<T, String> + Send + Sync + 'static,
) -> Result<T, String> {
    supported_worker()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_secs(5);
    let completion = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // A delayed metadata callback must not begin screenshot collection
            // after its caller has timed out and abandoned this request.
            let result = if Instant::now() >= deadline {
                Err("화면 정보 확인 시간이 초과되었습니다.".into())
            } else if !error.is_null() || content.is_null() {
                Err("화면에 보이는 창과 앱 정보를 읽지 못했습니다.".into())
            } else {
                // SAFETY: ScreenCaptureKit keeps callback arguments alive for the
                // invocation. Only owned Rust data crosses back to the worker.
                operation(unsafe { &*content })
            };
            let _ = sender.try_send(result);
        },
    );
    // SAFETY: availability is checked above; the retained block owns its sender
    // and operation even if a timeout drops our receiver. Desktop/titleless
    // windows are included; no image/audio capture occurs in this metadata call.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(false, true, &completion);
    }
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "화면 정보 확인 시간이 초과되었습니다.")?
}

fn windows_from_content(
    content: &SCShareableContent,
    screen: &ScreenInfo,
) -> Result<Vec<ScreenWindow>, String> {
    // SAFETY: these properties belong to the immutable snapshot delivered by
    // ScreenCaptureKit and are read only during the callback's lifetime.
    unsafe {
        let display = content
            .displays()
            .into_iter()
            .find(|d| d.displayID() == screen.id)
            .ok_or("선택한 모니터가 사라졌습니다.")?;
        let frame = display.frame();
        if frame.origin.x != f64::from(screen.x)
            || frame.origin.y != f64::from(screen.y)
            || frame.size.width != f64::from(screen.width)
            || frame.size.height != f64::from(screen.height)
        {
            return Err("모니터 구성이 바뀌어 분석을 취소했습니다.".into());
        }
        let mut windows = Vec::new();
        for window in content.windows() {
            if !window.isOnScreen() {
                continue;
            }
            let frame = window.frame();
            let bounds = Bounds {
                x: frame.origin.x,
                y: frame.origin.y,
                width: frame.size.width,
                height: frame.size.height,
            };
            if !bounds.intersects(screen)? {
                continue;
            }
            let app = window
                .owningApplication()
                .ok_or("화면 창의 소유 앱을 확인하지 못했습니다.")?;
            let pid = u32::try_from(app.processID())
                .map_err(|_| "화면 앱의 프로세스를 확인하지 못했습니다.")?;
            if pid == 0 {
                return Err("화면 앱의 프로세스를 확인하지 못했습니다.".into());
            }
            let name = app.applicationName().to_string();
            let mut identity = app.bundleIdentifier().to_string();
            // Non-bundle system/desktop tools may have no bundle ID; resolve
            // their executable identity instead of dropping an unknown window.
            if identity.is_empty() && pid != std::process::id() {
                identity = super::app_id(pid)?;
            }
            windows.push(ScreenWindow {
                id: window.windowID() as usize,
                pid,
                bounds,
                app_id: identity,
                app_name: name,
            });
        }
        Ok(windows)
    }
}

pub(crate) fn screen_windows(screen: &ScreenInfo) -> Result<Vec<ScreenWindow>, String> {
    let screen = screen.clone();
    with_content(move |content| windows_from_content(content, &screen))
}

pub(crate) fn capture_screen_pixels(
    screen: &ScreenInfo,
    excluded_apps: &[String],
) -> Result<image::RgbaImage, String> {
    let screen = screen.clone();
    let excluded_apps = excluded_apps.to_vec();
    let (sender, receiver) = mpsc::sync_channel(1);
    with_content(move |content| {
        // Validate the latest snapshot, including sensitive windows that appeared
        // since the initial check, without requiring ordinary windows to stand still.
        let windows = windows_from_content(content, &screen)?;
        authorize_windows(&screen, &windows, &excluded_apps, std::process::id())?;
        // SAFETY: macOS14 was checked before obtaining this content. The display
        // and application arrays retain their objects during filter construction;
        // the capture API retains the filter/configuration/completion for its work.
        unsafe {
            let display = content
                .displays()
                .into_iter()
                .find(|d| d.displayID() == screen.id)
                .ok_or("선택한 모니터가 사라졌습니다.")?;
            let applications: Vec<_> = content
                .applications()
                .into_iter()
                .filter(|app| app.processID() == std::process::id() as i32)
                .collect();
            // A missing own application cannot silently become an empty exclusion
            // filter: a later Ouento window would then appear in the screenshot.
            if applications.is_empty() {
                return Err("Ouento 앱을 화면에서 제외할 수 없어 분석을 쉽니다.".into());
            }
            let excluded = NSArray::<SCRunningApplication>::from_retained_slice(&applications);
            let exceptions = NSArray::<SCWindow>::new();
            let filter = SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &excluded,
                &exceptions,
            );
            let configuration = SCStreamConfiguration::new();
            // Output pixels are explicit and bounded, independent of Retina's
            // desktop point scale. The shared encoder applies its 1280px limit.
            configuration.setWidth(screen.width as usize);
            configuration.setHeight(screen.height as usize);
            configuration.setPixelFormat(u32::from_be_bytes(*b"BGRA"));
            configuration.setShowsCursor(false);
            configuration.setCapturesAudio(false);
            configuration.setScalesToFit(true);
            let sender = sender.clone();
            let completion = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                let result = if !error.is_null() || image.is_null() {
                    Err("모니터 전체 캡처에 실패했습니다.".into())
                } else {
                    // The image belongs to the callback. Copy bounded pixels
                    // before returning; no borrowed CGImage leaves this block.
                    copy_screenshot(&*image)
                };
                let _ = sender.try_send(result);
            });
            SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                &filter,
                &configuration,
                Some(&completion),
            );
        }
        Ok(())
    })?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "전체 화면 캡처 시간이 초과되었습니다.")?
}

fn copy_screenshot(image: &CGImage) -> Result<image::RgbaImage, String> {
    if CGImage::bits_per_component(Some(image)) != 8 || CGImage::bits_per_pixel(Some(image)) != 32 {
        return Err("지원하지 않는 화면 이미지 형식입니다.".into());
    }
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0
        || height == 0
        || width
            .checked_mul(height)
            .is_none_or(|pixels| pixels > 100_000_000)
    {
        return Err("전체 화면 이미지 크기가 한도를 벗어났습니다.".into());
    }
    let stride = CGImage::bytes_per_row(Some(image));
    let provider =
        CGImage::data_provider(Some(image)).ok_or("화면 이미지 데이터를 읽지 못했습니다.")?;
    let data =
        CGDataProvider::data(Some(&provider)).ok_or("화면 이미지 데이터를 복사하지 못했습니다.")?;
    // SCScreenshotManager + SDR/BGRA configuration documents a BGRA CGImage.
    // Avoid treating row padding as pixels; reject undersized buffers entirely.
    bgra_to_rgba(width, height, stride, &data.to_vec())
}

fn bgra_to_rgba(
    width: usize,
    height: usize,
    stride: usize,
    data: &[u8],
) -> Result<image::RgbaImage, String> {
    let row = width
        .checked_mul(4)
        .ok_or("화면 이미지 크기가 잘못되었습니다.")?;
    let length = stride
        .checked_mul(height)
        .ok_or("화면 이미지 크기가 잘못되었습니다.")?;
    if width == 0
        || height == 0
        || width
            .checked_mul(height)
            .is_none_or(|pixels| pixels > 100_000_000)
        || stride < row
        || data.len() < length
        || width > u32::MAX as usize
        || height > u32::MAX as usize
    {
        return Err("화면 이미지 버퍼가 잘못되었습니다.".into());
    }
    let mut rgba = Vec::with_capacity(row * height);
    for source in data[..length].chunks_exact(stride) {
        for bgra in source[..row].as_chunks::<4>().0 {
            rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], bgra[3]]);
        }
    }
    image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or("화면 이미지를 변환하지 못했습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screenshot_conversion_respects_stride_channels_and_bounds() {
        let image = bgra_to_rgba(
            1,
            2,
            8,
            &[3, 2, 1, 255, 9, 9, 9, 9, 6, 5, 4, 128, 8, 8, 8, 8],
        )
        .unwrap();
        assert_eq!(image.as_raw(), &[1, 2, 3, 255, 4, 5, 6, 128]);
        assert!(bgra_to_rgba(1, 2, 8, &[0; 15]).is_err());
        assert!(bgra_to_rgba(2, 1, 4, &[0; 8]).is_err());
        assert!(bgra_to_rgba(usize::MAX, 2, 8, &[]).is_err());
    }
}
