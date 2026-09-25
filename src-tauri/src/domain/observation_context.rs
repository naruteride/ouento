//! Native observation evidence kept with a reply through TTS and playback.
//! Validation is pure: an old watchdog must never overwrite current runtime facts.
use super::{ObservationMode, ObservationPurpose, ObservationTicket, RuntimeContext, Settings};
use crate::platform::{self, WindowInfo};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub id: u32,
    pub pid: u32,
    pub app_id: String,
}
impl From<&WindowInfo> for WindowIdentity {
    fn from(window: &WindowInfo) -> Self {
        Self {
            id: window.id,
            pid: window.pid,
            app_id: window.app_id.clone(),
        }
    }
}

#[derive(Clone)]
pub enum NativeObservationTarget {
    Window(WindowIdentity),
    Screen(platform::ScreenInfo),
}

#[derive(Clone)]
pub struct ObservationContext {
    pub ticket: ObservationTicket,
    pub target: NativeObservationTarget,
    pub focus: Option<WindowIdentity>,
    pub mode: ObservationMode,
}

pub struct NativeObservationState {
    pub runtime: RuntimeContext,
    pub screen_permission: String,
    pub windows: Vec<WindowInfo>,
    pub current_screen: Option<platform::ScreenInfo>,
}

impl ObservationContext {
    pub fn validate_native(
        &self,
        settings: &Settings,
        state: &NativeObservationState,
    ) -> Result<(), String> {
        if !state.runtime.observation_visible {
            return Err("모든 창이 숨겨져 화면 반응을 중단했습니다.".into());
        }
        if state.runtime.screen_locked {
            return Err("잠금 상태를 확인할 수 없거나 화면이 잠겨 관찰을 중단했습니다.".into());
        }
        if settings.observation.mode == ObservationMode::Off
            || settings.observation.mode != self.mode
            || !settings.observation.cloud_consent
        {
            return Err("관찰 동의가 해제되었습니다.".into());
        }
        if self.ticket.purpose == ObservationPurpose::Proactive
            && (settings.quiet
                || settings.focus_mode
                || settings.meeting_mode
                || state.runtime.meeting
                || state.runtime.typing == Some(true))
        {
            return Err("집중·입력·회의 상태로 먼저 반응하기를 중단했습니다.".into());
        }
        if state.screen_permission == "denied" {
            return Err("화면 기록 권한이 철회되었습니다.".into());
        }
        match &self.target {
            NativeObservationTarget::Window(target) => {
                if !matches!(
                    self.mode,
                    ObservationMode::SelectedWindow | ObservationMode::AllowedApps
                ) || self.ticket.target.app_id != target.app_id
                    || self.ticket.target.window_id != target.id.to_string()
                {
                    return Err("관찰 창의 승인 범위가 변경되었습니다.".into());
                }
                validate_native_target(target, &self.focus, &state.windows, self.mode)?;
                let window = state
                    .windows
                    .iter()
                    .find(|window| WindowIdentity::from(*window) == *target)
                    .ok_or("관찰 대상이 변경되었습니다.")?;
                if platform::sensitive_app(
                    &window.app_id,
                    &window.app_name,
                    &settings.observation.blocked_apps,
                ) {
                    return Err("민감 앱으로 제외된 창입니다.".into());
                }
            }
            NativeObservationTarget::Screen(screen) => {
                if self.mode != ObservationMode::CurrentScreen
                    || !settings.observation.screen_consent
                    || self.ticket.target.app_id != "screen"
                    || self.ticket.target.window_id != format!("screen:{}", screen.id)
                {
                    return Err("모니터 전체 화면의 전송 동의가 해제되었습니다.".into());
                }
                if state.current_screen.as_ref() != Some(screen) {
                    return Err("현재 모니터가 변경되어 이전 화면의 반응을 폐기했습니다.".into());
                }
                // This scope is the monitor, not its focused window. Switching
                // apps within it does not revoke an already authorized snapshot.
                // Raw OS overlay/sensitive-window checks run in platform::validate_screen
                // before and after capture, and at every native reply validation.
            }
        }
        Ok(())
    }
}

pub fn validate_native_target(
    target: &WindowIdentity,
    focus: &Option<WindowIdentity>,
    windows: &[WindowInfo],
    mode: ObservationMode,
) -> Result<(), String> {
    let actual = windows
        .iter()
        .find(|window| WindowIdentity::from(*window) == *target)
        .ok_or("선택한 창이 닫히거나 대상이 바뀌었습니다.")?;
    if actual.minimized {
        return Err("선택한 창이 최소화되어 관찰을 중단했습니다.".into());
    }
    let current_focus = windows
        .iter()
        .find(|window| window.focused)
        .map(WindowIdentity::from);
    // A pinned selected window remains the target even while another app is
    // focused. Only the active-app mode follows and therefore requires focus.
    if mode == ObservationMode::AllowedApps && (&current_focus != focus || !actual.focused) {
        return Err("활성 창이 바뀌어 이전 화면의 반응을 폐기했습니다.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ObservationTarget;

    fn screen_fixture() -> (Settings, ObservationContext, NativeObservationState) {
        let mut settings = Settings::default();
        settings.observation.mode = ObservationMode::CurrentScreen;
        settings.observation.cloud_consent = true;
        settings.observation.screen_consent = true;
        let screen = platform::ScreenInfo {
            id: 4,
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let context = ObservationContext {
            ticket: ObservationTicket {
                epoch: 1,
                target: ObservationTarget {
                    app_id: "screen".into(),
                    window_id: "screen:4".into(),
                },
                captured_at: 1000,
                fingerprint: "synthetic".into(),
                purpose: ObservationPurpose::OnDemand,
            },
            target: NativeObservationTarget::Screen(screen.clone()),
            focus: None,
            mode: ObservationMode::CurrentScreen,
        };
        let state = NativeObservationState {
            runtime: RuntimeContext {
                observation_visible: true,
                ..Default::default()
            },
            screen_permission: "granted".into(),
            windows: vec![],
            current_screen: Some(screen),
        };
        (settings, context, state)
    }

    #[test]
    fn screen_reply_keeps_both_consents_scope_and_native_monitor_until_playback() {
        for change in [
            "screen-consent",
            "cloud-consent",
            "mode",
            "target",
            "monitor",
            "geometry",
            "missing",
            "permission",
            "locked",
            "hidden",
        ] {
            let (mut settings, mut context, mut state) = screen_fixture();
            assert!(context.validate_native(&settings, &state).is_ok());
            match change {
                "screen-consent" => settings.observation.screen_consent = false,
                "cloud-consent" => settings.observation.cloud_consent = false,
                "mode" => settings.observation.mode = ObservationMode::AllowedApps,
                "target" => context.ticket.target.window_id = "screen:5".into(),
                "monitor" => state.current_screen.as_mut().unwrap().id = 5,
                "geometry" => state.current_screen.as_mut().unwrap().width = 1280,
                "missing" => state.current_screen = None,
                "permission" => state.screen_permission = "denied".into(),
                "locked" => state.runtime.screen_locked = true,
                "hidden" => state.runtime.observation_visible = false,
                _ => unreachable!(),
            }
            assert!(
                context.validate_native(&settings, &state).is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn monitor_reply_survives_app_switches_and_ordinary_window_changes() {
        let (settings, mut context, mut state) = screen_fixture();
        context.ticket.purpose = ObservationPurpose::Proactive;
        context.focus = Some(WindowIdentity {
            id: 1,
            pid: 50,
            app_id: "synthetic.editor".into(),
        });
        state.windows.push(WindowInfo {
            id: 2,
            pid: 51,
            app_id: "synthetic.browser".into(),
            app_name: "Synthetic".into(),
            title: "Synthetic fixture".into(),
            x: 40,
            y: 60,
            width: 800,
            height: 600,
            focused: true,
            minimized: false,
        });
        assert!(context.validate_native(&settings, &state).is_ok());
        state.windows[0].width = 1000;
        state.windows[0].focused = false;
        assert!(context.validate_native(&settings, &state).is_ok());
        state.windows.clear();
        assert!(context.validate_native(&settings, &state).is_ok());
    }

    #[test]
    fn full_screen_keeps_manual_and_automatic_silence_policies_distinct() {
        let (mut settings, mut context, mut state) = screen_fixture();
        settings.quiet = true;
        assert!(context.validate_native(&settings, &state).is_ok());
        context.ticket.purpose = ObservationPurpose::Proactive;
        assert!(context.validate_native(&settings, &state).is_err());
        settings.quiet = false;
        assert!(context.validate_native(&settings, &state).is_ok());
        state.runtime.typing = Some(false);
        assert!(context.validate_native(&settings, &state).is_ok());
        state.runtime.typing = Some(true);
        assert!(context.validate_native(&settings, &state).is_err());
    }
}
