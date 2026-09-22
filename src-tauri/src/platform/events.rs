//! OS window facts only. No window title, screen contents, or task-success inference.
use super::{sensitive_app, WindowInfo};
use crate::domain::types::{ObservationMode, ObservationSettings};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsEventTarget {
    pub app_id: String,
    pub window_id: String,
    pub pid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OsEventKind {
    ActiveWindowChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OsEventSource {
    XcapMacos,
    XcapWindows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OsEventCertainty {
    Observed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsEventScope {
    pub mode: ObservationMode,
    pub app_id: String,
    pub window_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsEvent {
    pub timestamp: u64,
    pub target: OsEventTarget,
    pub kind: OsEventKind,
    pub certainty: OsEventCertainty,
    pub source: OsEventSource,
    pub scope: OsEventScope,
}

impl OsEvent {
    /// Recheck current authorization and freshness even for a locally produced fact.
    pub fn is_allowed(&self, settings: &ObservationSettings, now: u64) -> bool {
        settings.mode == ObservationMode::AllowedApps
            && settings.cloud_consent
            && self.scope.mode == settings.mode
            && self.scope.app_id == self.target.app_id
            && self.scope.window_id == self.target.window_id
            && !self.target.app_id.is_empty()
            && self.target.app_id.len() <= 512
            && self.target.window_id.parse::<u32>().is_ok()
            && self.target.pid != 0
            && self.target.pid != std::process::id()
            && now.saturating_sub(self.timestamp) <= 3000
            && self.timestamp <= now.saturating_add(1000)
            && settings
                .allowed_apps
                .iter()
                .any(|app| app.eq_ignore_ascii_case(&self.target.app_id))
            && !sensitive_app(&self.target.app_id, "", &settings.blocked_apps)
    }
}

#[derive(Default)]
pub struct WindowEventTracker {
    initialized: bool,
    current: Option<OsEventTarget>,
    candidate: Option<OsEventTarget>,
    candidate_since: u64,
}

impl WindowEventTracker {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn poll(&mut self, settings: &ObservationSettings) -> Result<Option<OsEvent>, String> {
        if settings.mode != ObservationMode::AllowedApps || !settings.cloud_consent {
            self.reset();
            return Ok(None);
        }
        let source = if cfg!(target_os = "macos") {
            OsEventSource::XcapMacos
        } else if cfg!(target_os = "windows") {
            OsEventSource::XcapWindows
        } else {
            self.reset();
            return Ok(None);
        };
        match super::list_windows() {
            Ok(windows) => Ok(self.sample(settings, &windows, super::timestamp(), source)),
            Err(error) => {
                self.reset();
                Err(error)
            }
        }
    }

    fn sample(
        &mut self,
        settings: &ObservationSettings,
        windows: &[WindowInfo],
        now: u64,
        source: OsEventSource,
    ) -> Option<OsEvent> {
        if settings.mode != ObservationMode::AllowedApps || !settings.cloud_consent {
            self.reset();
            return None;
        }
        let focused = windows
            .iter()
            .find(|window| window.focused && !window.minimized);
        let target = focused.map(|window| OsEventTarget {
            app_id: window.app_id.clone(),
            window_id: window.id.to_string(),
            pid: window.pid,
        });
        if !self.initialized {
            self.initialized = true;
            self.current = target.clone();
            self.candidate = target;
            self.candidate_since = now;
            return None; // A first snapshot is not an observed change.
        }
        if self.candidate != target || now < self.candidate_since {
            self.candidate = target;
            self.candidate_since = now;
            return None;
        }
        if self.current == target || now.saturating_sub(self.candidate_since) < 250 {
            return None;
        }
        self.current = target.clone();
        let target = target?; // Disappearance never means completion or success.
        let actual = focused?;
        if sensitive_app(&actual.app_id, &actual.app_name, &settings.blocked_apps) {
            return None;
        }
        let event = OsEvent {
            timestamp: now,
            scope: OsEventScope {
                mode: settings.mode,
                app_id: target.app_id.clone(),
                window_id: target.window_id.clone(),
            },
            target,
            kind: OsEventKind::ActiveWindowChanged,
            certainty: OsEventCertainty::Observed,
            source,
        };
        event.is_allowed(settings, now).then_some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> ObservationSettings {
        ObservationSettings {
            mode: ObservationMode::AllowedApps,
            cloud_consent: true,
            allowed_apps: vec!["example.editor".into()],
            ..Default::default()
        }
    }
    fn window(id: u32) -> WindowInfo {
        WindowInfo {
            id,
            pid: std::process::id() + 10,
            app_id: "example.editor".into(),
            app_name: "Editor".into(),
            title: "not forwarded".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            focused: true,
            minimized: false,
        }
    }
    #[test]
    fn only_stable_allowed_changes_become_facts() {
        let settings = settings();
        let mut tracker = WindowEventTracker::default();
        let mut sample =
            |id, now| tracker.sample(&settings, &[window(id)], now, OsEventSource::XcapMacos);
        assert!(sample(1, 0).is_none());
        assert!(sample(2, 100).is_none());
        assert!(sample(3, 200).is_none());
        assert!(sample(3, 449).is_none());
        let event = sample(3, 500).unwrap();
        assert_eq!(event.target.window_id, "3");
        assert_eq!(event.scope.mode, ObservationMode::AllowedApps);
        assert_eq!(event.certainty, OsEventCertainty::Observed);
        assert!(sample(3, 1000).is_none());
        assert!(event.is_allowed(&settings, 1000));
        assert!(!event.is_allowed(&settings, 4000));
        let mut revoked = settings.clone();
        revoked.allowed_apps.clear();
        assert!(!event.is_allowed(&revoked, 600));
        assert!(!serde_json::to_string(&event)
            .unwrap()
            .contains("not forwarded"));
    }
    #[test]
    fn closed_windows_sensitive_apps_and_selected_mode_do_not_emit() {
        let mut settings = settings();
        let mut tracker = WindowEventTracker::default();
        tracker.sample(&settings, &[window(1)], 0, OsEventSource::XcapWindows);
        assert!(tracker
            .sample(&settings, &[], 100, OsEventSource::XcapWindows)
            .is_none());
        assert!(tracker
            .sample(&settings, &[], 400, OsEventSource::XcapWindows)
            .is_none());
        let mut sensitive = window(2);
        sensitive.app_name = "PasswordS".into();
        tracker.sample(
            &settings,
            &[sensitive.clone()],
            500,
            OsEventSource::XcapWindows,
        );
        assert!(tracker
            .sample(&settings, &[sensitive], 800, OsEventSource::XcapWindows)
            .is_none());
        settings.mode = ObservationMode::SelectedWindow;
        settings.selected_window_id = Some("3".into());
        assert!(tracker
            .sample(&settings, &[window(3)], 900, OsEventSource::XcapWindows)
            .is_none());
    }
}
