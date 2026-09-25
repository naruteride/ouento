//! A caption has its own small transparent window so moving the character
//! outside a display never clips its text. Geometry uses physical coordinates.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const PADDING: f64 = 12.0;
const MOTION: f64 = 8.0;
const MAX_WIDTH: f64 = 300.0;
const HEAD_ANCHOR: f64 = 75.0;

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
    fn distance_squared(self, other: Self) -> f64 {
        let x = (self.x - other.right())
            .max(other.x - self.right())
            .max(0.0);
        let y = (self.y - other.bottom())
            .max(other.y - self.bottom())
            .max(0.0);
        x * x + y * y
    }
}

#[derive(Clone, Copy, Debug)]
struct Screen {
    bounds: Rect,
    work: Rect,
    scale: f64,
}

fn choose_screen(screens: &[Screen], character: Rect) -> Option<&Screen> {
    screens.iter().max_by(|a, b| {
        a.bounds
            .overlap(character)
            .total_cmp(&b.bounds.overlap(character))
            .then_with(|| {
                b.bounds
                    .distance_squared(character)
                    .total_cmp(&a.bounds.distance_squared(character))
            })
    })
}

fn limits(screen: Screen) -> (f64, f64) {
    (
        (screen.work.width / screen.scale - PADDING * 2.0)
            .floor()
            .clamp(1.0, MAX_WIDTH),
        (screen.work.height / screen.scale - PADDING * 2.0 - MOTION)
            .floor()
            .max(1.0),
    )
}

fn placement(
    screen: Screen,
    character: Rect,
    character_scale: f64,
    width: f64,
    height: f64,
) -> Rect {
    // Include both the shadow and the complete downward exit animation in the
    // clamped rectangle. Do not change the character's own position.
    let width = ((width + PADDING * 2.0).ceil() * screen.scale)
        .round()
        .min(screen.work.width);
    let height = ((height + PADDING * 2.0 + MOTION).ceil() * screen.scale)
        .round()
        .min(screen.work.height);
    let x = character.x + character.width / 2.0 - width / 2.0;
    let y =
        character.y + HEAD_ANCHOR * character_scale - height + (PADDING + MOTION) * screen.scale;
    Rect {
        x: x.clamp(screen.work.x, screen.work.right() - width).round(),
        y: y.clamp(screen.work.y, screen.work.bottom() - height)
            .round(),
        width,
        height,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Visible,
    Hiding,
    Hidden,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    layout_revision: u64,
    text: String,
    state: Phase,
    max_width: f64,
    max_height: f64,
}

struct Inner {
    snapshot: Snapshot,
    measured: Option<(f64, f64)>,
}
impl Default for Inner {
    fn default() -> Self {
        Self {
            snapshot: Snapshot {
                revision: 0,
                layout_revision: 0,
                text: String::new(),
                state: Phase::Hidden,
                max_width: MAX_WIDTH,
                max_height: 600.0,
            },
            measured: None,
        }
    }
}

impl Inner {
    fn update(&mut self, revision: u64, text: String, phase: Phase) -> bool {
        if revision <= self.snapshot.revision {
            return false;
        }
        if self.snapshot.text != text || phase == Phase::Hidden {
            self.measured = None;
        }
        self.snapshot.revision = revision;
        self.snapshot.text = if phase == Phase::Hidden {
            String::new()
        } else {
            text
        };
        self.snapshot.state = phase;
        true
    }

    fn measure(&mut self, revision: u64, layout_revision: u64, width: f64, height: f64) -> bool {
        if revision != self.snapshot.revision
            || layout_revision != self.snapshot.layout_revision
            || self.snapshot.state == Phase::Hidden
        {
            return false;
        }
        if width > self.snapshot.max_width + 0.5 || height > self.snapshot.max_height + 0.5 {
            return false;
        }
        self.measured = Some((width, height));
        true
    }

    fn set_limits(&mut self, max_width: f64, max_height: f64) -> bool {
        if self.snapshot.max_width == max_width && self.snapshot.max_height == max_height {
            return false;
        }
        self.snapshot.max_width = max_width;
        self.snapshot.max_height = max_height;
        self.snapshot.layout_revision += 1;
        self.measured = None;
        true
    }
}

#[derive(Default)]
pub struct SpeechBubble {
    inner: Mutex<Inner>,
}

impl SpeechBubble {
    fn notify(app: &tauri::AppHandle, snapshot: &Snapshot) -> Result<(), String> {
        app.emit_to("speech-bubble", "speech-bubble-state", snapshot)
            .map_err(|error| error.to_string())
    }

    pub fn update(
        &self,
        app: &tauri::AppHandle,
        revision: u64,
        text: String,
        phase: Phase,
        active: bool,
    ) -> Result<(), String> {
        if text.chars().count() > 4000 {
            return Err("말풍선이 너무 깁니다.".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "말풍선 상태를 읽을 수 없습니다.")?;
        if !inner.update(revision, text, if active { phase } else { Phase::Hidden }) {
            return Ok(());
        }
        Self::refresh(app, &mut inner, active)?;
        Self::notify(app, &inner.snapshot)
    }

    pub fn ready(&self, app: &tauri::AppHandle, active: bool) -> Result<Snapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "말풍선 상태를 읽을 수 없습니다.")?;
        Self::refresh(app, &mut inner, active)?;
        Ok(inner.snapshot.clone())
    }

    pub fn layout(
        &self,
        app: &tauri::AppHandle,
        revision: u64,
        layout_revision: u64,
        width: f64,
        height: f64,
        active: bool,
    ) -> Result<(), String> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err("말풍선 크기가 올바르지 않습니다.".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "말풍선 상태를 읽을 수 없습니다.")?;
        // Refresh limits before trusting a delayed measurement from another DPI
        // or monitor. Its revision must still belong to the displayed caption.
        Self::refresh(app, &mut inner, active)?;
        if inner.measure(revision, layout_revision, width, height) {
            Self::refresh(app, &mut inner, active)?;
        }
        Ok(())
    }

    pub fn reconcile(&self, app: &tauri::AppHandle, active: bool) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "말풍선 상태를 읽을 수 없습니다.")?;
        Self::refresh(app, &mut inner, active)
    }

    fn refresh(app: &tauri::AppHandle, inner: &mut Inner, active: bool) -> Result<(), String> {
        let window = app
            .get_webview_window("speech-bubble")
            .ok_or("말풍선 창이 없습니다.")?;
        if !active && inner.snapshot.state != Phase::Hidden {
            inner.snapshot.state = Phase::Hidden;
            inner.snapshot.text.clear();
            inner.measured = None;
            Self::notify(app, &inner.snapshot)?;
        }
        if inner.snapshot.state == Phase::Hidden {
            if window.is_visible().unwrap_or(false) {
                window.hide().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        let character = app
            .get_webview_window("companion")
            .ok_or("캐릭터 창이 없습니다.")?;
        let position = character.outer_position().map_err(|e| e.to_string())?;
        let size = character.inner_size().map_err(|e| e.to_string())?;
        let character_scale = character.scale_factor().map_err(|e| e.to_string())?;
        let character = Rect {
            x: position.x as f64,
            y: position.y as f64,
            width: size.width as f64,
            height: size.height as f64,
        };
        let screens: Vec<_> = window
            .available_monitors()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|m| m.scale_factor().is_finite() && m.scale_factor() > 0.0)
            .filter(|m| m.work_area().size.width > 0 && m.work_area().size.height > 0)
            .map(|m| Screen {
                bounds: Rect {
                    x: m.position().x as f64,
                    y: m.position().y as f64,
                    width: m.size().width as f64,
                    height: m.size().height as f64,
                },
                work: Rect {
                    x: m.work_area().position.x as f64,
                    y: m.work_area().position.y as f64,
                    width: m.work_area().size.width as f64,
                    height: m.work_area().size.height as f64,
                },
                scale: m.scale_factor(),
            })
            .collect();
        let Some(screen) = choose_screen(&screens, character).copied() else {
            window.hide().map_err(|e| e.to_string())?;
            return Ok(());
        };
        let (max_width, max_height) = limits(screen);
        if inner.set_limits(max_width, max_height) {
            Self::notify(app, &inner.snapshot)?;
            window.hide().map_err(|e| e.to_string())?;
        }
        let Some((width, height)) = inner.measured else {
            return Ok(());
        };
        if width > max_width + 0.5 || height > max_height + 0.5 {
            window.hide().map_err(|e| e.to_string())?;
            return Ok(());
        }
        let desired = placement(screen, character, character_scale, width, height);
        let size = tauri::PhysicalSize::new(desired.width as u32, desired.height as u32);
        let position = tauri::PhysicalPosition::new(desired.x as i32, desired.y as i32);
        if window.inner_size().map_err(|e| e.to_string())? != size {
            window.set_size(size).map_err(|e| e.to_string())?;
        }
        if window.outer_position().map_err(|e| e.to_string())? != position {
            window.set_position(position).map_err(|e| e.to_string())?;
        }
        if !window.is_visible().unwrap_or(false) {
            window.show().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: f64, y: f64, scale: f64) -> Screen {
        Screen {
            bounds: Rect {
                x,
                y,
                width: 1600.0 * scale,
                height: 1000.0 * scale,
            },
            work: Rect {
                x,
                y: y + 24.0 * scale,
                width: 1600.0 * scale,
                height: 936.0 * scale,
            },
            scale,
        }
    }
    fn character(x: f64, y: f64, scale: f64) -> Rect {
        Rect {
            x,
            y,
            width: 420.0 * scale,
            height: 580.0 * scale,
        }
    }
    fn inside(rect: Rect, screen: Screen) {
        assert!(rect.x >= screen.work.x && rect.y >= screen.work.y);
        assert!(rect.right() <= screen.work.right() && rect.bottom() <= screen.work.bottom());
    }

    #[test]
    fn normal_caption_is_centered_above_the_head() {
        let s = screen(0.0, 0.0, 2.0);
        let c = character(600.0, 700.0, 2.0);
        let p = placement(s, c, 2.0, 250.0, 60.0);
        assert_eq!(p.x + p.width / 2.0, c.x + c.width / 2.0);
        assert_eq!(p.bottom() - 40.0, c.y + HEAD_ANCHOR * 2.0);
        inside(p, s);
    }

    #[test]
    fn all_edges_and_fully_offscreen_characters_keep_the_complete_caption_visible() {
        let s = screen(0.0, 0.0, 1.0);
        for (x, y) in [
            (-300.0, -500.0),
            (1500.0, -500.0),
            (-300.0, 900.0),
            (1500.0, 900.0),
            (-10000.0, 20000.0),
        ] {
            let c = character(x, y, 1.0);
            let p = placement(s, c, 1.0, 300.0, 180.0);
            inside(p, s);
            assert_eq!(p.width, 324.0);
            assert_eq!(p.height, 212.0);
            assert_eq!(c.x, x);
            assert_eq!(c.y, y);
        }
    }

    #[test]
    fn negative_origins_mixed_dpi_and_nearest_display_are_supported() {
        let screens = [screen(-1600.0, -100.0, 1.0), screen(0.0, 0.0, 2.0)];
        let left = choose_screen(&screens, character(-1700.0, 50.0, 1.0)).unwrap();
        assert_eq!(left.scale, 1.0);
        let right = choose_screen(&screens, character(100.0, 50.0, 2.0)).unwrap();
        assert_eq!(right.scale, 2.0);
        let offscreen = character(-9000.0, -6000.0, 2.0);
        assert_eq!(choose_screen(&screens, offscreen).unwrap().scale, 1.0);
        inside(placement(*left, offscreen, 2.0, 300.0, 250.0), *left);
        assert_eq!(placement(*right, offscreen, 1.0, 300.0, 250.0).width, 648.0);
    }

    #[test]
    fn small_work_area_limits_content_and_has_no_invalid_clamp() {
        let s = Screen {
            bounds: Rect {
                x: -200.0,
                y: 25.0,
                width: 180.0,
                height: 140.0,
            },
            work: Rect {
                x: -200.0,
                y: 25.0,
                width: 180.0,
                height: 140.0,
            },
            scale: 1.0,
        };
        assert_eq!(limits(s), (156.0, 108.0));
        inside(
            placement(s, character(900.0, 500.0, 1.0), 1.0, 156.0, 108.0),
            s,
        );
    }

    #[test]
    fn stale_updates_and_measurements_cannot_replace_a_new_caption() {
        let mut inner = Inner::default();
        assert!(inner.update(2, "새 대사".into(), Phase::Visible));
        assert!(!inner.update(1, String::new(), Phase::Hidden));
        assert!(!inner.measure(1, 0, 200.0, 50.0));
        assert!(inner.measure(2, 0, 200.0, 50.0));
        assert!(inner.update(3, "다른 대사".into(), Phase::Visible));
        assert!(inner.measured.is_none());
        assert!(!inner.measure(2, 0, 200.0, 50.0));
        assert!(inner.update(4, String::new(), Phase::Hidden));
        assert!(!inner.measure(4, 0, 200.0, 50.0));
    }

    #[test]
    fn returning_to_a_monitor_rejects_delayed_smaller_measurements() {
        let mut inner = Inner::default();
        inner.update(1, "화면 사이를 이동하는 대사".into(), Phase::Visible);
        assert!(inner.measure(1, 0, 300.0, 350.0));
        assert!(inner.set_limits(300.0, 100.0));
        assert!(inner.measured.is_none());
        assert!(inner.measure(1, 1, 300.0, 100.0));
        assert!(inner.set_limits(300.0, 600.0));
        assert!(!inner.measure(1, 1, 300.0, 100.0));
        assert!(!inner.measure(1, 0, 300.0, 350.0));
        assert!(inner.measure(1, 2, 300.0, 350.0));
        assert_eq!(inner.measured, Some((300.0, 350.0)));
    }
}
