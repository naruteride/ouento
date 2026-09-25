use super::{
    personality::personality,
    types::{ObservationMode, Settings},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeContext {
    pub typing: Option<bool>,
    pub meeting: bool,
    pub screen_locked: bool,
    pub observation_visible: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationTarget {
    pub app_id: String,
    pub window_id: String,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObservationPurpose {
    #[default]
    Proactive,
    OnDemand,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationTicket {
    pub epoch: u64,
    pub target: ObservationTarget,
    pub captured_at: i64,
    pub fingerprint: String,
    pub purpose: ObservationPurpose,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRequest {
    pub ticket: ObservationTicket,
    pub image_base64: String,
    pub mime_type: String,
}

#[derive(Default)]
pub struct ObservationGate {
    epoch: u64,
    target: Option<ObservationTarget>,
    purpose: Option<ObservationPurpose>,
    runtime: RuntimeContext,
    last_attempt: Option<i64>,
    last_reaction: Option<i64>,
    last_jealousy: Option<i64>,
    seen: HashMap<String, i64>,
}

impl ObservationGate {
    pub fn invalidate(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.target = None;
        self.purpose = None;
    }
    pub fn invalidate_if_current(&mut self, ticket: &ObservationTicket) -> bool {
        if self.epoch == ticket.epoch
            && self.target.as_ref() == Some(&ticket.target)
            && self.purpose == Some(ticket.purpose)
        {
            self.invalidate();
            true
        } else {
            false
        }
    }
    pub fn set_runtime(&mut self, context: RuntimeContext) -> bool {
        let explicit = self.purpose == Some(ObservationPurpose::OnDemand);
        let safety_changed = context.screen_locked != self.runtime.screen_locked
            || context.observation_visible != self.runtime.observation_visible;
        let suppress = context.screen_locked
            || !context.observation_visible
            || (!explicit && (context.typing == Some(true) || context.meeting));
        let verified_activity_changed = (context.typing == Some(true)
            && self.runtime.typing != Some(true))
            || context.meeting != self.runtime.meeting;
        // Unknown input remains unknown; gaining or losing idle-input evidence
        // alone must not revoke an authorized frame or its current reply.
        if safety_changed || (!explicit && verified_activity_changed) {
            self.invalidate();
        }
        self.runtime = context;
        suppress
    }
    pub fn set_visible(&mut self, visible: bool) {
        if self.runtime.observation_visible != visible {
            self.invalidate();
            self.runtime.observation_visible = visible;
        }
    }
    pub fn allowed(settings: &Settings, target: &ObservationTarget) -> Result<(), String> {
        if target.app_id.is_empty() || target.window_id.is_empty() {
            return Err("관찰 대상 창을 확인할 수 없습니다.".into());
        }
        if settings.observation.mode == ObservationMode::CurrentScreen {
            if !settings.observation.cloud_consent || !settings.observation.screen_consent {
                return Err("모니터 전체 화면의 전송 동의가 필요합니다.".into());
            }
            let screen_id = target.window_id.strip_prefix("screen:");
            return if target.app_id == "screen"
                && screen_id.is_some_and(|id| {
                    id.parse::<u32>()
                        .is_ok_and(|parsed| parsed.to_string() == id)
                }) {
                Ok(())
            } else {
                Err("관찰할 모니터를 확인할 수 없습니다.".into())
            };
        }
        if target.app_id == "screen" || target.window_id.starts_with("screen:") {
            return Err("모니터 전체 화면은 별도로 허용해야 합니다.".into());
        }
        let app = target.app_id.to_lowercase();
        if app.contains("ouento")
            || settings
                .observation
                .blocked_apps
                .iter()
                .any(|id| id.eq_ignore_ascii_case(&app))
        {
            return Err("이 앱은 관찰에서 제외되어 있습니다.".into());
        }
        match settings.observation.mode {
            ObservationMode::Off => Err("관찰이 중지되어 있습니다.".into()),
            ObservationMode::SelectedWindow
                if settings.observation.selected_window_id.as_deref()
                    == Some(&target.window_id) =>
            {
                Ok(())
            }
            ObservationMode::AllowedApps
                if settings
                    .observation
                    .allowed_apps
                    .iter()
                    .any(|id| id.eq_ignore_ascii_case(&target.app_id)) =>
            {
                Ok(())
            }
            _ => Err("허용되지 않은 창입니다.".into()),
        }
    }
    fn can_observe(&self) -> Result<(), String> {
        if !self.runtime.observation_visible {
            return Err("모든 창이 숨겨져 화면 분석을 쉬고 있습니다.".into());
        }
        if self.runtime.screen_locked {
            return Err("화면이 잠겨 있어 관찰을 쉬고 있습니다.".into());
        }
        Ok(())
    }
    pub fn can_react(&self, settings: &Settings, now: i64) -> Result<(), String> {
        self.can_observe()?;
        if settings.quiet
            || settings.focus_mode
            || settings.meeting_mode
            || self.runtime.typing == Some(true)
            || self.runtime.meeting
            || settings.personality_frequency <= 0.0
        {
            return Err("집중·입력·회의 또는 조용히 있기 상태에서는 먼저 말하지 않습니다.".into());
        }
        let interval = (personality(&settings.personality)?.min_interval_seconds as f64
            * 1000.0
            * (1.5 - settings.personality_frequency as f64)) as i64;
        if self
            .last_reaction
            .is_some_and(|last| now.saturating_sub(last) < interval)
        {
            return Err("최근 반응 후 잠시 쉬고 있습니다.".into());
        }
        Ok(())
    }
    pub fn begin(
        &mut self,
        settings: &Settings,
        target: ObservationTarget,
        fingerprint: &str,
        now: i64,
    ) -> Result<ObservationTicket, String> {
        self.begin_for(
            settings,
            target,
            fingerprint,
            ObservationPurpose::Proactive,
            now,
        )
    }
    pub fn begin_for(
        &mut self,
        settings: &Settings,
        target: ObservationTarget,
        fingerprint: &str,
        purpose: ObservationPurpose,
        now: i64,
    ) -> Result<ObservationTicket, String> {
        Self::allowed(settings, &target)?;
        self.can_observe()?;
        if purpose == ObservationPurpose::Proactive {
            self.can_react(settings, now)?;
        }
        if !settings.observation.cloud_consent {
            return Err("선택한 창의 화면을 제공자에 전달하는 데 동의해 주세요.".into());
        }
        if fingerprint.len() > 256 {
            return Err("화면 식별자가 너무 깁니다.".into());
        }
        let interval = settings.observation.interval_seconds as i64 * 1000;
        if purpose == ObservationPurpose::Proactive
            && self
                .last_attempt
                .is_some_and(|last| now.saturating_sub(last) < interval)
        {
            return Err("화면 확인 간격을 기다리고 있습니다.".into());
        }
        self.seen
            .retain(|_, time| now.saturating_sub(*time) < 5 * 60 * 1000);
        if purpose == ObservationPurpose::Proactive
            && !fingerprint.is_empty()
            && self.seen.contains_key(&format!(
                "{}:{}:{}",
                target.app_id, target.window_id, fingerprint
            ))
        {
            return Err("방금 확인한 화면이라 다시 반응하지 않습니다.".into());
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.target = Some(target.clone());
        self.purpose = Some(purpose);
        self.last_attempt = Some(now);
        Ok(ObservationTicket {
            epoch: self.epoch,
            target,
            captured_at: now,
            fingerprint: fingerprint.into(),
            purpose,
        })
    }
    pub fn validate(
        &self,
        settings: &Settings,
        ticket: &ObservationTicket,
        now: i64,
    ) -> Result<(), String> {
        self.validate_scope(settings, ticket, now)?;
        if ticket.purpose == ObservationPurpose::Proactive {
            self.can_react(settings, now)?;
        }
        Ok(())
    }
    pub fn validate_scope(
        &self,
        settings: &Settings,
        ticket: &ObservationTicket,
        now: i64,
    ) -> Result<(), String> {
        self.validate_current_scope(settings, ticket)?;
        if now.saturating_sub(ticket.captured_at) > 30_000
            || ticket.captured_at > now.saturating_add(1_000)
        {
            return Err("오래된 화면의 반응을 폐기했습니다.".into());
        }
        Ok(())
    }
    /// The response already passed the analysis freshness deadline. Keep its
    /// authorization through playback without imposing that deadline on audio duration.
    pub fn validate_current_scope(
        &self,
        settings: &Settings,
        ticket: &ObservationTicket,
    ) -> Result<(), String> {
        Self::allowed(settings, &ticket.target)?;
        self.can_observe()?;
        if !settings.observation.cloud_consent
            || self.epoch != ticket.epoch
            || self.target.as_ref() != Some(&ticket.target)
            || self.purpose != Some(ticket.purpose)
        {
            return Err("관찰 범위가 변경되어 이전 화면을 폐기했습니다.".into());
        }
        Ok(())
    }
    pub fn mark_seen(&mut self, ticket: &ObservationTicket, now: i64) {
        if !ticket.fingerprint.is_empty() {
            self.seen.insert(
                format!(
                    "{}:{}:{}",
                    ticket.target.app_id, ticket.target.window_id, ticket.fingerprint
                ),
                now,
            );
        }
    }
    pub fn reject_duplicate(&mut self, ticket: &ObservationTicket, now: i64) -> Result<(), String> {
        if ticket.purpose == ObservationPurpose::OnDemand {
            return Ok(());
        }
        self.seen
            .retain(|_, time| now.saturating_sub(*time) < 5 * 60 * 1000);
        let key = format!(
            "{}:{}:{}",
            ticket.target.app_id, ticket.target.window_id, ticket.fingerprint
        );
        if !ticket.fingerprint.is_empty() && self.seen.contains_key(&key) {
            return Err("방금 확인한 화면이라 다시 분석하지 않습니다.".into());
        }
        Ok(())
    }
    pub fn mark_reaction(&mut self, now: i64) {
        self.last_reaction = Some(now);
    }
    pub fn allow_jealousy(&mut self, settings: &Settings, now: i64) -> bool {
        if !settings.jealousy.enabled || settings.jealousy.frequency <= 0.0 {
            return false;
        }
        let interval = (600_000.0 / settings.jealousy.frequency.max(0.01)) as i64;
        if self
            .last_jealousy
            .is_some_and(|last| now.saturating_sub(last) < interval)
        {
            return false;
        }
        self.last_jealousy = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready_gate() -> ObservationGate {
        let mut gate = ObservationGate::default();
        gate.set_runtime(RuntimeContext {
            typing: Some(false),
            observation_visible: true,
            ..RuntimeContext::default()
        });
        gate
    }
    fn setup() -> (Settings, ObservationTarget) {
        let mut s = Settings::default();
        s.observation.mode = ObservationMode::SelectedWindow;
        s.observation.selected_window_id = Some("window-1".into());
        s.observation.cloud_consent = true;
        (
            s,
            ObservationTarget {
                app_id: "com.example.notes".into(),
                window_id: "window-1".into(),
            },
        )
    }
    #[test]
    fn stop_scope_changes_and_old_frames_block_transmission() {
        let (mut s, target) = setup();
        let mut gate = ready_gate();
        let ticket = gate.begin(&s, target, "a", 1000).unwrap();
        assert!(gate.validate(&s, &ticket, 2000).is_ok());
        assert!(gate.validate(&s, &ticket, 32_000).is_err());
        s.observation.mode = ObservationMode::Off;
        assert!(gate.validate(&s, &ticket, 2000).is_err());
        s.observation.mode = ObservationMode::SelectedWindow;
        gate.invalidate();
        assert!(gate.validate(&s, &ticket, 2000).is_err());
    }
    #[test]
    fn sensitive_and_unapproved_apps_are_blocked_before_capture() {
        let (s, mut t) = setup();
        t.app_id = "com.1password.1password".into();
        assert!(ObservationGate::allowed(&s, &t).is_err());
        t.app_id = "com.example.notes".into();
        t.window_id = "window-2".into();
        assert!(ObservationGate::allowed(&s, &t).is_err());
        assert!(ObservationGate::allowed(&Settings::default(), &t).is_err());
    }
    #[test]
    fn full_screen_requires_both_consents_and_an_exact_screen_scope() {
        let mut settings = Settings::default();
        settings.observation.mode = ObservationMode::CurrentScreen;
        let target = ObservationTarget {
            app_id: "screen".into(),
            window_id: "screen:9".into(),
        };
        let mut gate = ready_gate();
        assert!(settings.validate().is_err());
        assert!(gate.begin(&settings, target.clone(), "", 1000).is_err());
        settings.observation.cloud_consent = true;
        assert!(settings.validate().is_err());
        assert!(gate.begin(&settings, target.clone(), "", 1000).is_err());
        settings.observation.screen_consent = true;
        assert!(settings.validate().is_ok());
        let ticket = gate.begin(&settings, target.clone(), "", 1000).unwrap();
        assert!(gate.validate(&settings, &ticket, 1001).is_ok());
        for (app, id) in [
            ("example.editor", "screen:9"),
            ("screen", "9"),
            ("screen", "screen:-1"),
            ("screen", "screen:09"),
        ] {
            assert!(ObservationGate::allowed(
                &settings,
                &ObservationTarget {
                    app_id: app.into(),
                    window_id: id.into()
                }
            )
            .is_err());
        }
        settings.observation.screen_consent = false;
        assert!(gate.validate_current_scope(&settings, &ticket).is_err());
        settings.observation.screen_consent = true;
        settings.observation.cloud_consent = false;
        assert!(gate.validate_current_scope(&settings, &ticket).is_err());
        settings.observation.cloud_consent = true;
        settings.observation.mode = ObservationMode::SelectedWindow;
        settings.observation.selected_window_id = Some(target.window_id.clone());
        assert!(ObservationGate::allowed(&settings, &target).is_err());
    }
    #[test]
    fn full_screen_monitor_changes_do_not_reuse_seen_images_or_tickets() {
        let mut settings = Settings::default();
        settings.observation.mode = ObservationMode::CurrentScreen;
        settings.observation.cloud_consent = true;
        settings.observation.screen_consent = true;
        let mut gate = ready_gate();
        let first = ObservationTarget {
            app_id: "screen".into(),
            window_id: "screen:1".into(),
        };
        let second = ObservationTarget {
            app_id: "screen".into(),
            window_id: "screen:2".into(),
        };
        let ticket = gate
            .begin(&settings, first.clone(), "same pixels", 1000)
            .unwrap();
        gate.mark_seen(&ticket, 1000);
        assert!(gate.begin(&settings, first, "same pixels", 20_000).is_err());
        let next = gate
            .begin(&settings, second, "same pixels", 20_000)
            .unwrap();
        assert!(gate.validate(&settings, &ticket, 20_001).is_err());
        assert!(gate.validate(&settings, &next, 20_001).is_ok());
        gate.set_runtime(RuntimeContext {
            typing: Some(false),
            observation_visible: true,
            screen_locked: true,
            ..Default::default()
        });
        assert!(gate.validate(&settings, &next, 20_002).is_err());
    }
    #[test]
    fn duplicate_images_and_silence_share_one_policy() {
        let (mut s, target) = setup();
        let mut gate = ready_gate();
        let first = gate.begin(&s, target.clone(), "same", 1000).unwrap();
        gate.mark_seen(&first, 1000);
        assert!(gate.begin(&s, target.clone(), "same", 20_000).is_err());
        s.quiet = true;
        assert!(gate.begin(&s, target.clone(), "different", 20_000).is_err());
        s.quiet = false;
        gate.set_runtime(RuntimeContext {
            typing: Some(true),
            observation_visible: true,
            ..RuntimeContext::default()
        });
        assert!(gate.begin(&s, target, "different", 20_000).is_err());
    }
    #[test]
    fn hidden_observation_stays_invalid_after_reshow_even_without_input_detection() {
        let (settings, target) = setup();
        let mut gate = ready_gate();
        let ticket = gate.begin(&settings, target.clone(), "a", 1000).unwrap();
        gate.set_visible(false);
        assert!(gate.validate(&settings, &ticket, 2000).is_err());
        assert!(gate.begin(&settings, target.clone(), "b", 20_000).is_err());
        gate.set_visible(true);
        // Reshowing must not revalidate a captured frame from before hiding.
        assert!(gate.validate(&settings, &ticket, 2000).is_err());
        gate.set_runtime(RuntimeContext {
            typing: None,
            observation_visible: true,
            ..RuntimeContext::default()
        });
        assert!(gate.begin(&settings, target, "b", 20_000).is_ok());
    }
    #[test]
    fn unknown_input_preserves_proactive_tickets_until_verified_input_starts() {
        let (settings, target) = setup();
        let mut gate = ready_gate();
        assert!(!gate.set_runtime(RuntimeContext {
            typing: None,
            observation_visible: true,
            ..Default::default()
        }));
        assert_eq!(gate.runtime.typing, None);
        let ticket = gate.begin(&settings, target.clone(), "a", 1000).unwrap();
        let epoch = gate.epoch;
        for typing in [Some(false), None, None, Some(false), None] {
            assert!(!gate.set_runtime(RuntimeContext {
                typing,
                observation_visible: true,
                ..Default::default()
            }));
            assert_eq!(gate.runtime.typing, typing);
            assert_eq!(gate.epoch, epoch);
            assert!(gate.validate(&settings, &ticket, 2000).is_ok());
        }
        assert!(gate.set_runtime(RuntimeContext {
            typing: Some(true),
            observation_visible: true,
            ..Default::default()
        }));
        assert!(gate.validate(&settings, &ticket, 2000).is_err());
        assert!(gate.begin(&settings, target.clone(), "b", 20_000).is_err());
        let input_epoch = gate.epoch;
        assert!(!gate.set_runtime(RuntimeContext {
            typing: None,
            observation_visible: true,
            ..Default::default()
        }));
        assert_eq!(gate.runtime.typing, None);
        assert_eq!(gate.epoch, input_epoch);
        assert!(gate.begin(&settings, target, "b", 20_000).is_ok());
    }
    #[test]
    fn explicit_capture_ignores_proactive_silence_intervals_and_image_duplicates() {
        let (mut settings, target) = setup();
        settings.quiet = true;
        settings.focus_mode = true;
        settings.meeting_mode = true;
        settings.personality_frequency = 0.0;
        let mut gate = ready_gate();
        gate.mark_reaction(1000);
        gate.set_runtime(RuntimeContext {
            typing: None,
            meeting: true,
            observation_visible: true,
            screen_locked: false,
        });
        assert!(gate.begin(&settings, target.clone(), "same", 1001).is_err());
        let ticket = gate
            .begin_for(
                &settings,
                target.clone(),
                "same",
                ObservationPurpose::OnDemand,
                1001,
            )
            .unwrap();
        assert!(!gate.set_runtime(RuntimeContext {
            typing: Some(true),
            meeting: true,
            observation_visible: true,
            screen_locked: false
        }));
        assert!(gate.validate(&settings, &ticket, 1002).is_ok());
        gate.mark_seen(&ticket, 1002);
        assert!(gate.reject_duplicate(&ticket, 1003).is_ok());
        let repeated = gate
            .begin_for(
                &settings,
                target,
                "same",
                ObservationPurpose::OnDemand,
                1003,
            )
            .unwrap();
        assert!(gate.validate(&settings, &ticket, 1003).is_err());
        assert!(gate.validate(&settings, &repeated, 1003).is_ok());
    }
    #[test]
    fn ticket_purpose_must_match_the_issued_request() {
        let (settings, target) = setup();
        let mut gate = ready_gate();
        let mut ticket = gate.begin(&settings, target.clone(), "", 1000).unwrap();
        ticket.purpose = ObservationPurpose::OnDemand;
        assert!(gate.validate(&settings, &ticket, 1001).is_err());
        let mut manual = gate
            .begin_for(&settings, target, "", ObservationPurpose::OnDemand, 1001)
            .unwrap();
        assert!(!gate.invalidate_if_current(&ticket));
        assert!(gate.validate(&settings, &manual, 1002).is_ok());
        manual.purpose = ObservationPurpose::Proactive;
        assert!(gate.validate(&settings, &manual, 1002).is_err());
    }
    #[test]
    fn explicit_capture_still_requires_visibility_unlock_consent_scope_and_freshness() {
        let (settings, target) = setup();
        let mut gate = ready_gate();
        let ticket = gate
            .begin_for(
                &settings,
                target.clone(),
                "",
                ObservationPurpose::OnDemand,
                1000,
            )
            .unwrap();
        let mut changed = settings.clone();
        changed.observation.cloud_consent = false;
        assert!(gate.validate(&changed, &ticket, 1001).is_err());
        changed = settings.clone();
        changed.observation.selected_window_id = Some("other".into());
        assert!(gate.validate(&changed, &ticket, 1001).is_err());
        changed = settings.clone();
        changed.observation.blocked_apps.push(target.app_id.clone());
        assert!(gate.validate(&changed, &ticket, 1001).is_err());
        assert!(gate.validate(&settings, &ticket, 32_000).is_err());
        gate.set_visible(false);
        assert!(gate.validate(&settings, &ticket, 1001).is_err());
        assert!(gate
            .begin_for(
                &settings,
                target.clone(),
                "",
                ObservationPurpose::OnDemand,
                1001
            )
            .is_err());
        gate.set_runtime(RuntimeContext {
            typing: None,
            observation_visible: true,
            screen_locked: true,
            meeting: false,
        });
        assert!(gate
            .begin_for(&settings, target, "", ObservationPurpose::OnDemand, 1001)
            .is_err());
    }
    #[test]
    fn published_audio_keeps_scope_checks_without_reusing_the_analysis_deadline() {
        let (settings, target) = setup();
        let mut gate = ready_gate();
        let ticket = gate
            .begin_for(&settings, target, "", ObservationPurpose::OnDemand, 1000)
            .unwrap();
        assert!(gate.validate_scope(&settings, &ticket, 32_000).is_err());
        assert!(gate.validate_current_scope(&settings, &ticket).is_ok());
        gate.set_visible(false);
        assert!(gate.validate_current_scope(&settings, &ticket).is_err());
    }
}
