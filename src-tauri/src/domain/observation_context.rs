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
pub struct ObservationContext {
    pub ticket: ObservationTicket,
    pub target: WindowIdentity,
    pub focus: Option<WindowIdentity>,
    pub mode: ObservationMode,
}

pub struct NativeObservationState {
    pub runtime: RuntimeContext,
    pub screen_permission: String,
    pub windows: Vec<WindowInfo>,
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
        if settings.observation.mode == ObservationMode::Off || !settings.observation.cloud_consent
        {
            return Err("관찰 동의가 해제되었습니다.".into());
        }
        if self.ticket.purpose == ObservationPurpose::Proactive {
            if state.runtime.typing.is_none() {
                return Err("입력 활동을 확인할 수 없어 자동 관찰을 쉬고 있습니다. 입력 감지 권한을 확인하거나 지금 화면 분석을 눌러 주세요.".into());
            }
            if settings.quiet
                || settings.focus_mode
                || settings.meeting_mode
                || state.runtime.meeting
                || state.runtime.typing == Some(true)
            {
                return Err("집중·입력·회의 상태로 먼저 반응하기를 중단했습니다.".into());
            }
        }
        if state.screen_permission == "denied" {
            return Err("화면 기록 권한이 철회되었습니다.".into());
        }
        validate_native_target(&self.target, &self.focus, &state.windows, self.mode)?;
        let window = state
            .windows
            .iter()
            .find(|window| WindowIdentity::from(*window) == self.target)
            .ok_or("관찰 대상이 변경되었습니다.")?;
        if platform::sensitive_app(
            &window.app_id,
            &window.app_name,
            &settings.observation.blocked_apps,
        ) {
            return Err("민감 앱으로 제외된 창입니다.".into());
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
    if &current_focus != focus || (mode == ObservationMode::AllowedApps && !actual.focused) {
        return Err("활성 창이 바뀌어 이전 화면의 반응을 폐기했습니다.".into());
    }
    Ok(())
}
