//! Companion geometry is independent of model framing and user memories.
//! All calculations use physical desktop coordinates, including negative origins.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};

const WIDTH: f64 = 420.0;
const STAGE_HEIGHT: f64 = 467.0;
const CHROME_HEIGHT: f64 = 113.0;
const MARGIN: f64 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Rect {
    fn right(self) -> f64 {
        self.x + self.width
    }
    fn bottom(self) -> f64 {
        self.y + self.height
    }
    fn overlap(self, other: Self) -> f64 {
        (self.right().min(other.right()) - self.x.max(other.x)).max(0.0)
            * (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Screen {
    name: String,
    bounds: Rect,
    work: Rect,
    scale: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Placement {
    version: u32,
    monitor: String,
    origin_x: i32,
    origin_y: i32,
    horizontal: f64,
    vertical: f64,
}
impl Placement {
    fn valid(&self) -> bool {
        self.version == 1
            && self.monitor.len() <= 1024
            && self.horizontal.is_finite()
            && (0.0..=1.0).contains(&self.horizontal)
            && self.vertical.is_finite()
            && (0.0..=1.0).contains(&self.vertical)
    }
}

fn usable(screen: &Screen) -> Rect {
    // Leave space for system UI and a small gap. Tiny work areas still have a
    // positive rectangle, so a monitor removal never creates an invalid clamp.
    let margin = (MARGIN * screen.scale)
        .min(screen.work.width / 4.0)
        .min(screen.work.height / 4.0)
        .floor();
    Rect {
        x: screen.work.x + margin,
        y: screen.work.y + margin,
        width: screen.work.width - 2.0 * margin,
        height: screen.work.height - 2.0 * margin,
    }
}

fn dimensions(screen: &Screen, scale: f32) -> (f64, f64) {
    let scale = if scale.is_finite() {
        (scale as f64).clamp(0.5, 1.5)
    } else {
        1.0
    };
    let width = (WIDTH * scale).max(320.0) * screen.scale;
    let height = (STAGE_HEIGHT * scale + CHROME_HEIGHT) * screen.scale;
    let area = usable(screen);
    let fit = (area.width / width).min(area.height / height).min(1.0);
    (
        (width * fit).round().max(1.0),
        (height * fit).round().max(1.0),
    )
}

fn constrained(mut rect: Rect, screen: &Screen) -> Rect {
    let area = usable(screen);
    rect.width = rect.width.min(area.width).floor().max(1.0);
    rect.height = rect.height.min(area.height).floor().max(1.0);
    rect.x = rect
        .x
        .clamp(area.x, (area.right() - rect.width).max(area.x))
        .round();
    rect.y = rect
        .y
        .clamp(area.y, (area.bottom() - rect.height).max(area.y))
        .round();
    rect
}

fn restore(screen: &Screen, scale: f32, placement: Option<&Placement>) -> Rect {
    let (width, height) = dimensions(screen, scale);
    let area = usable(screen);
    let (x, y) = placement
        .map(|p| (p.horizontal, p.vertical))
        .unwrap_or((1.0, 1.0));
    constrained(
        Rect {
            x: area.x + (area.width - width).max(0.0) * x,
            y: area.y + (area.height - height).max(0.0) * y,
            width,
            height,
        },
        screen,
    )
}

fn capture(screen: &Screen, rect: Rect) -> Placement {
    let area = usable(screen);
    let fraction = |offset: f64, travel: f64| {
        if travel < 1.0 {
            1.0
        } else {
            ((offset / travel).clamp(0.0, 1.0) * 10000.0).round() / 10000.0
        }
    };
    Placement {
        version: 1,
        monitor: screen.name.clone(),
        origin_x: screen.bounds.x as i32,
        origin_y: screen.bounds.y as i32,
        horizontal: fraction(rect.x - area.x, area.width - rect.width),
        vertical: fraction(rect.y - area.y, area.height - rect.height),
    }
}

fn saved_screen(screens: &[Screen], placement: Option<&Placement>) -> usize {
    let Some(p) = placement else { return 0 };
    screens
        .iter()
        .position(|s| {
            s.name == p.monitor
                && s.bounds.x as i32 == p.origin_x
                && s.bounds.y as i32 == p.origin_y
        })
        .or_else(|| screens.iter().position(|s| s.name == p.monitor))
        .unwrap_or(0)
}

fn visible_screen(screens: &[Screen], rect: Rect) -> Option<usize> {
    screens
        .iter()
        .enumerate()
        .map(|(i, s)| (i, s.bounds.overlap(rect)))
        .filter(|(_, overlap)| *overlap > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

struct LayoutState {
    saved: Option<Placement>,
    screens: Vec<Screen>,
    initialized: bool,
}

pub struct DesktopLayout {
    path: PathBuf,
    state: Mutex<LayoutState>,
}
impl DesktopLayout {
    pub fn new(directory: &std::path::Path) -> Self {
        let path = directory.join("companion-window.json");
        let saved = std::fs::read(&path)
            .ok()
            .filter(|bytes| bytes.len() < 4096)
            .and_then(|bytes| serde_json::from_slice::<Placement>(&bytes).ok())
            .filter(Placement::valid);
        Self {
            path,
            state: Mutex::new(LayoutState {
                saved,
                screens: vec![],
                initialized: false,
            }),
        }
    }

    /// Called after a drag, settings change and periodically for display removal
    /// or DPI changes. Never call while a native drag is active.
    pub fn reconcile(&self, window: &tauri::WebviewWindow, scale: f32) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "캐릭터 위치 상태를 읽을 수 없습니다.")?;
        let primary = window.primary_monitor().map_err(|e| e.to_string())?;
        let mut monitors = window.available_monitors().map_err(|e| e.to_string())?;
        if let Some(primary) = primary {
            monitors.sort_by_key(|m| m.position() != primary.position());
        }
        let screens: Vec<_> = monitors
            .iter()
            .filter(|m| {
                m.scale_factor().is_finite()
                    && m.scale_factor() > 0.0
                    && m.work_area().size.width > 0
                    && m.work_area().size.height > 0
            })
            .map(|m| {
                let area = m.work_area();
                Screen {
                    name: m.name().cloned().unwrap_or_default(),
                    bounds: Rect {
                        x: m.position().x as f64,
                        y: m.position().y as f64,
                        width: m.size().width as f64,
                        height: m.size().height as f64,
                    },
                    work: Rect {
                        x: area.position.x as f64,
                        y: area.position.y as f64,
                        width: area.size.width as f64,
                        height: area.size.height as f64,
                    },
                    scale: m.scale_factor(),
                }
            })
            .collect();
        if screens.is_empty() {
            return Ok(());
        }
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let current = Rect {
            x: position.x as f64,
            y: position.y as f64,
            width: size.width as f64,
            height: size.height as f64,
        };
        let visible = visible_screen(&screens, current);
        let index = match (state.initialized, visible) {
            (true, Some(index)) => index,
            _ => saved_screen(&screens, state.saved.as_ref()),
        };
        let screen = &screens[index];
        let desired = if !state.initialized
            || visible.is_none()
            || (screens != state.screens
                && state
                    .saved
                    .as_ref()
                    .is_some_and(|p| p.monitor == screen.name))
        {
            restore(screen, scale, state.saved.as_ref())
        } else {
            let (width, height) = dimensions(screen, scale);
            // Resizing keeps the feet/right edge in place instead of cropping a
            // larger character into the previous canvas.
            constrained(
                Rect {
                    x: current.right() - width,
                    y: current.bottom() - height,
                    width,
                    height,
                },
                screen,
            )
        };
        if current.width != desired.width || current.height != desired.height {
            window
                .set_size(tauri::PhysicalSize::new(
                    desired.width as u32,
                    desired.height as u32,
                ))
                .map_err(|e| e.to_string())?;
        }
        if current.x != desired.x || current.y != desired.y {
            window
                .set_position(tauri::PhysicalPosition::new(
                    desired.x as i32,
                    desired.y as i32,
                ))
                .map_err(|e| e.to_string())?;
        }
        let saved = capture(screen, desired);
        if state.saved.as_ref() != Some(&saved) {
            let bytes =
                serde_json::to_vec(&saved).map_err(|_| "캐릭터 위치를 변환할 수 없습니다.")?;
            let temporary = self.path.with_extension("json.tmp");
            std::fs::write(&temporary, bytes).map_err(|_| "캐릭터 위치를 저장할 수 없습니다.")?;
            std::fs::rename(temporary, &self.path)
                .map_err(|_| "캐릭터 위치를 저장할 수 없습니다.")?;
            state.saved = Some(saved);
        }
        state.initialized = true;
        state.screens = screens;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn screen(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Screen {
        Screen {
            name: format!("screen-{x}"),
            bounds: Rect {
                x,
                y,
                width,
                height,
            },
            work: Rect {
                x,
                y: y + 24.0 * scale,
                width,
                height: height - 64.0 * scale,
            },
            scale,
        }
    }
    fn inside(rect: Rect, screen: &Screen) {
        assert!(rect.x >= screen.work.x && rect.y >= screen.work.y);
        assert!(rect.right() <= screen.work.right() && rect.bottom() <= screen.work.bottom());
    }
    #[test]
    fn starts_at_bottom_right_of_work_area_not_full_screen() {
        let s = screen(0.0, 0.0, 3024.0, 1964.0, 2.0);
        let r = restore(&s, 1.0, None);
        assert_eq!((r.width, r.height), (840.0, 1160.0));
        assert_eq!(r.right(), s.work.right() - 40.0);
        assert_eq!(r.bottom(), s.work.bottom() - 40.0);
        inside(r, &s);
    }
    #[test]
    fn grows_window_and_keeps_complete_character_on_small_display() {
        let s = screen(-1920.0, 0.0, 1920.0, 1080.0, 1.0);
        let small = restore(&s, 0.5, None);
        let large = restore(&s, 1.5, None);
        assert!(large.width > small.width && large.height > small.height);
        assert_eq!(large.right(), small.right());
        inside(large, &s);
        inside(
            restore(&screen(0.0, 0.0, 800.0, 600.0, 1.0), 1.5, None),
            &screen(0.0, 0.0, 800.0, 600.0, 1.0),
        );
    }
    #[test]
    fn negative_origins_and_mixed_dpi_preserve_relative_position() {
        let s = screen(-2560.0, -500.0, 2560.0, 1440.0, 1.0);
        let mut p = capture(&s, restore(&s, 1.0, None));
        p.horizontal = 0.25;
        p.vertical = 0.6;
        let r = restore(&s, 1.0, Some(&p));
        let roundtrip = capture(&s, r);
        assert!((roundtrip.horizontal - p.horizontal).abs() < 0.001);
        assert!((roundtrip.vertical - p.vertical).abs() < 0.002);
        let retina = screen(-2560.0, -500.0, 3840.0, 2160.0, 1.5);
        let changed = restore(&retina, 1.0, Some(&p));
        assert_eq!(changed.width, 630.0);
        inside(changed, &retina);
    }
    #[test]
    fn removed_monitor_falls_back_and_crossing_uses_largest_overlap() {
        let primary = screen(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let left = screen(-2560.0, 0.0, 2560.0, 1440.0, 1.5);
        let p = capture(&left, restore(&left, 1.0, None));
        let screens = vec![primary.clone(), left];
        assert_eq!(saved_screen(&screens, Some(&p)), 1);
        assert_eq!(
            visible_screen(
                &screens,
                Rect {
                    x: -100.0,
                    y: 100.0,
                    width: 420.0,
                    height: 580.0
                }
            ),
            Some(0)
        );
        assert_eq!(saved_screen(std::slice::from_ref(&primary), Some(&p)), 0);
        inside(restore(&primary, 1.0, Some(&p)), &primary);
    }
    #[test]
    fn invalid_persisted_coordinates_are_not_used() {
        let s = screen(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let mut p = capture(&s, restore(&s, 1.0, None));
        p.horizontal = f64::NAN;
        assert!(!p.valid());
        p.horizontal = 0.5;
        p.vertical = -0.01;
        assert!(!p.valid());
    }
    #[test]
    fn fractional_dpi_produces_stable_integer_geometry() {
        let s = screen(0.0, 0.0, 1024.0, 768.0, 1.333333333);
        let r = restore(&s, 1.5, None);
        // Native APIs accept whole physical pixels. Fractions would otherwise
        // trigger a resize on every reconciliation tick.
        assert_eq!(r.width.fract(), 0.0);
        assert_eq!(r.height.fract(), 0.0);
        assert_eq!(r.x.fract(), 0.0);
        assert_eq!(r.y.fract(), 0.0);
    }
}
