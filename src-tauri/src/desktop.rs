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
        matches!(self.version, 1 | 2)
            && self.monitor.len() <= 1024
            && self.horizontal.is_finite()
            && self.vertical.is_finite()
            && (self.version == 2
                || ((0.0..=1.0).contains(&self.horizontal) && (0.0..=1.0).contains(&self.vertical)))
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
    // AppKit rounds content sizes to whole logical points. Requesting an odd
    // physical height at 2x otherwise causes a resize and downward drift every
    // reconciliation tick when preserving the bottom edge.
    let pixels = |value: f64, limit: f64| {
        ((value * fit / screen.scale).round() * screen.scale)
            .round()
            .min(limit.floor())
            .max(1.0)
    };
    (pixels(width, area.width), pixels(height, area.height))
}

fn restore(screen: &Screen, scale: f32, placement: Option<&Placement>) -> Rect {
    let (width, height) = dimensions(screen, scale);
    let area = usable(screen);
    // A removed monitor resets to the available monitor. An intentional
    // offscreen position on a monitor that still exists is preserved.
    let placement = placement.filter(|p| p.monitor == screen.name);
    let (x, y) = match placement {
        Some(p) if p.version == 2 => (
            area.x + area.width * p.horizontal - width,
            area.y + area.height * p.vertical - height,
        ),
        legacy => {
            let (x, y) = legacy
                .map(|p| (p.horizontal, p.vertical))
                .unwrap_or((1.0, 1.0));
            (
                area.x + (area.width - width).max(0.0) * x,
                area.y + (area.height - height).max(0.0) * y,
            )
        }
    };
    Rect {
        x: x.round(),
        y: y.round(),
        width,
        height,
    }
}

fn capture(screen: &Screen, rect: Rect) -> Placement {
    let area = usable(screen);
    // Normalize the bottom/right anchor by screen size, not available travel:
    // travel can be zero on a small display, and positions may be outside 0..1.
    let fraction = |offset: f64, extent: f64| (offset / extent * 1e8).round() / 1e8;
    Placement {
        version: 2,
        monitor: screen.name.clone(),
        origin_x: screen.bounds.x as i32,
        origin_y: screen.bounds.y as i32,
        horizontal: fraction(rect.right() - area.x, area.width),
        vertical: fraction(rect.bottom() - area.y, area.height),
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
impl LayoutState {
    fn geometry(&self, screens: &[Screen], current: Rect, scale: f32) -> (usize, Rect) {
        let visible = visible_screen(screens, current);
        let index = match (self.initialized, visible) {
            (true, Some(index)) => index,
            _ => saved_screen(screens, self.saved.as_ref()),
        };
        let screen = &screens[index];
        let desired = if !self.initialized
            || (screens != self.screens
                && (visible.is_none()
                    || self
                        .saved
                        .as_ref()
                        .is_some_and(|p| p.monitor == screen.name)))
        {
            let saved = self.saved.as_ref().filter(|p| {
                // With identical monitor names, a removed display must not be
                // mistaken for the remaining display solely by its name.
                screens.len() >= self.screens.len()
                    || screens.iter().any(|s| {
                        s.name == p.monitor
                            && s.bounds.x as i32 == p.origin_x
                            && s.bounds.y as i32 == p.origin_y
                    })
            });
            restore(screen, scale, saved)
        } else {
            let (width, height) = dimensions(screen, scale);
            // Preserve user placement even when the whole window is offscreen.
            // Resizing keeps the feet/right edge in place.
            Rect {
                x: (current.right() - width).round(),
                y: (current.bottom() - height).round(),
                width,
                height,
            }
        };
        (index, desired)
    }
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
        self.reconcile_window(window, scale, false)
    }

    /// Explicit recovery only; routine checks and startup preserve placement.
    pub fn reset_position(&self, window: &tauri::WebviewWindow, scale: f32) -> Result<(), String> {
        self.reconcile_window(window, scale, true)
    }

    fn reconcile_window(
        &self,
        window: &tauri::WebviewWindow,
        scale: f32,
        reset_position: bool,
    ) -> Result<(), String> {
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
        let (index, mut desired) = state.geometry(&screens, current, scale);
        let screen = &screens[index];
        if reset_position {
            desired = restore(screen, scale, None);
        }
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
        p.vertical = f64::INFINITY;
        assert!(!p.valid());
    }
    #[test]
    fn offscreen_drag_survives_periodic_checks_and_restart() {
        let s = screen(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let screens = vec![s.clone()];
        let initial = restore(&s, 1.0, None);
        let mut state = LayoutState {
            saved: Some(capture(&s, initial)),
            screens: screens.clone(),
            initialized: true,
        };
        // All corners, plus a completely offscreen window (no overlap).
        for (x, y) in [
            (-200.0, -200.0),
            (1800.0, -200.0),
            (-200.0, 950.0),
            (1800.0, 950.0),
            (2100.0, 1200.0),
        ] {
            let dragged = Rect { x, y, ..initial };
            let (_, after_release) = state.geometry(&screens, dragged, 1.0);
            assert_eq!(after_release, dragged);
            let saved = capture(&s, after_release);
            assert!(saved.valid());
            let json = serde_json::to_vec(&saved).unwrap();
            state.saved = Some(serde_json::from_slice(&json).unwrap());
            assert_eq!(state.geometry(&screens, after_release, 1.0).1, dragged);
            state.initialized = false;
            assert_eq!(state.geometry(&screens, initial, 1.0).1, dragged);
            state.initialized = true;
        }
    }
    #[test]
    fn offscreen_position_survives_zero_travel_and_resizing() {
        let s = screen(0.0, 0.0, 800.0, 600.0, 1.0);
        let initial = restore(&s, 1.5, None);
        let dragged = Rect {
            x: -150.0,
            y: 450.0,
            ..initial
        };
        let saved = capture(&s, dragged);
        assert_eq!(restore(&s, 1.5, Some(&saved)), dragged);
        let resized = restore(&s, 0.5, Some(&saved));
        assert_eq!(resized.right(), dragged.right());
        assert_eq!(resized.bottom(), dragged.bottom());
    }
    #[test]
    fn legacy_positions_migrate_and_removed_monitors_reset() {
        let s = screen(-1920.0, 0.0, 1920.0, 1080.0, 1.0);
        let legacy = Placement {
            version: 1,
            monitor: s.name.clone(),
            origin_x: -1920,
            origin_y: 0,
            horizontal: 0.25,
            vertical: 0.6,
        };
        assert!(legacy.valid());
        let original = restore(&s, 1.0, Some(&legacy));
        let migrated = capture(&s, original);
        assert_eq!(migrated.version, 2);
        assert_eq!(restore(&s, 1.0, Some(&migrated)), original);
        let saved = capture(
            &s,
            Rect {
                x: -3000.0,
                y: 1200.0,
                ..original
            },
        );
        let state = LayoutState {
            saved: Some(saved),
            screens: vec![s],
            initialized: true,
        };
        let primary = screen(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let recovered = state
            .geometry(std::slice::from_ref(&primary), original, 1.0)
            .1;
        assert_eq!(recovered, restore(&primary, 1.0, None));
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
    #[test]
    fn retina_sizes_do_not_cause_rounding_drift() {
        let s = screen(0.0, 0.0, 3024.0, 1964.0, 2.0);
        for scale in [0.5, 0.8, 1.0, 1.1, 1.5] {
            let r = restore(&s, scale, None);
            assert_eq!((r.width / s.scale).fract(), 0.0);
            assert_eq!((r.height / s.scale).fract(), 0.0);
            let state = LayoutState {
                saved: Some(capture(&s, r)),
                screens: vec![s.clone()],
                initialized: true,
            };
            assert_eq!(state.geometry(std::slice::from_ref(&s), r, scale).1, r);
        }
    }
    #[test]
    fn removing_a_same_named_monitor_recovers_offscreen_position() {
        let primary = screen(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let mut left = screen(-1920.0, 0.0, 1920.0, 1080.0, 1.0);
        left.name.clone_from(&primary.name);
        let offscreen = Rect {
            x: -2200.0,
            y: 1300.0,
            ..restore(&left, 1.0, None)
        };
        let state = LayoutState {
            saved: Some(capture(&left, offscreen)),
            screens: vec![primary.clone(), left],
            initialized: true,
        };
        assert_eq!(
            state
                .geometry(std::slice::from_ref(&primary), offscreen, 1.0)
                .1,
            restore(&primary, 1.0, None)
        );
    }
}
