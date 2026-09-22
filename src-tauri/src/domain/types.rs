use serde::{Deserialize, Serialize};

pub const BUILTIN_MODEL_IDS: [&str; 3] = ["builtin:mao", "builtin:haru", "builtin:kei"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u32,
    pub personality: String,
    pub personality_intensity: f32,
    pub personality_frequency: f32,
    pub character_name: String,
    pub fps: u32,
    pub muted: bool,
    pub quiet: bool,
    pub focus_mode: bool,
    pub meeting_mode: bool,
    pub scale: f32,
    pub always_on_top: bool,
    pub cursor_tracking: bool,
    pub voice_enabled: bool,
    pub memory_enabled: bool,
    pub active_model_id: Option<String>,
    pub jealousy: JealousySettings,
    pub observation: ObservationSettings,
    pub providers: ProviderSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            personality: "tsundere".into(),
            personality_intensity: 0.7,
            personality_frequency: 0.5,
            character_name: "마오".into(),
            fps: 30,
            muted: false,
            quiet: false,
            focus_mode: false,
            voice_enabled: true,
            meeting_mode: false,
            scale: 1.0,
            always_on_top: true,
            cursor_tracking: true,
            memory_enabled: false,
            active_model_id: None,
            jealousy: JealousySettings::default(),
            observation: ObservationSettings::default(),
            providers: ProviderSettings::default(),
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("지원하지 않는 설정 버전입니다.".into());
        }
        if !["tsundere", "cat", "cheerleader"].contains(&self.personality.as_str()) {
            return Err("지원하지 않는 성격입니다.".into());
        }
        if self.character_name.trim().is_empty() || self.character_name.chars().count() > 40 {
            return Err("캐릭터 이름은 1~40자로 입력해 주세요.".into());
        }
        if self.fps != 30 && self.fps != 60 {
            return Err("FPS는 30 또는 60이어야 합니다.".into());
        }
        for value in [
            self.jealousy.frequency,
            self.jealousy.intensity,
            self.personality_intensity,
            self.personality_frequency,
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err("성격·질투 설정은 0~1 사이여야 합니다.".into());
            }
        }
        if !self.scale.is_finite() || !(0.5..=1.5).contains(&self.scale) {
            return Err("캐릭터 크기는 0.5~1.5배로 설정해 주세요.".into());
        }
        if !(5..=300).contains(&self.observation.interval_seconds) {
            return Err("관찰 간격은 5~300초여야 합니다.".into());
        }
        if self.observation.allowed_apps.len() > 100 || self.observation.blocked_apps.len() > 100 {
            return Err("앱 목록은 각각 100개 이하로 설정해 주세요.".into());
        }
        if self
            .observation
            .allowed_apps
            .iter()
            .chain(self.observation.blocked_apps.iter())
            .any(|x| x.trim().is_empty() || x.len() > 512)
        {
            return Err("앱 식별자가 올바르지 않습니다.".into());
        }
        if self.observation.mode == ObservationMode::SelectedWindow
            && self
                .observation
                .selected_window_id
                .as_ref()
                .is_none_or(|x| x.is_empty())
        {
            return Err("함께 볼 창을 선택해 주세요.".into());
        }
        if self.observation.mode != ObservationMode::Off && !self.observation.cloud_consent {
            return Err("관찰을 시작하기 전에 선택한 화면의 제공자 전송에 동의해 주세요.".into());
        }
        self.providers.chat.validate()?;
        self.providers.stt.validate()?;
        self.providers.tts.validate()?;
        if self.providers.voice.is_empty() || self.providers.voice.len() > 100 {
            return Err("음성 이름을 확인해 주세요.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct JealousySettings {
    pub enabled: bool,
    pub frequency: f32,
    pub intensity: f32,
}
impl Default for JealousySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: 0.25,
            intensity: 0.35,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObservationMode {
    #[default]
    Off,
    SelectedWindow,
    AllowedApps,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ObservationSettings {
    pub mode: ObservationMode,
    pub selected_window_id: Option<String>,
    pub allowed_apps: Vec<String>,
    pub blocked_apps: Vec<String>,
    pub cloud_consent: bool,
    pub interval_seconds: u64,
}
impl Default for ObservationSettings {
    fn default() -> Self {
        Self {
            mode: ObservationMode::Off,
            selected_window_id: None,
            allowed_apps: vec![],
            blocked_apps: [
                "com.1password.1password",
                "com.apple.keychainaccess",
                "1password.exe",
                "keepass.exe",
                "keepassxc.exe",
            ]
            .map(String::from)
            .into(),
            cloud_consent: false,
            interval_seconds: 15,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
    pub requires_key: bool,
}
impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
            requires_key: true,
        }
    }
}
impl ProviderConfig {
    pub fn validate(&self) -> Result<(), String> {
        let url =
            reqwest::Url::parse(&self.base_url).map_err(|_| "제공자 URL이 올바르지 않습니다.")?;
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if url.scheme() != "https" && !(url.scheme() == "http" && local) {
            return Err("HTTPS 또는 로컬 HTTP 제공자만 사용할 수 있습니다.".into());
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("제공자 URL에 비밀번호·쿼리·앵커를 넣을 수 없습니다.".into());
        }
        if url.host_str().is_none() || self.base_url.len() > 2048 || self.model.len() > 200 {
            return Err("제공자 주소 또는 모델 이름이 올바르지 않습니다.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ProviderSettings {
    pub chat: ProviderConfig,
    pub stt: ProviderConfig,
    pub tts: ProviderConfig,
    pub voice: String,
}
impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            chat: ProviderConfig::default(),
            stt: ProviderConfig::default(),
            tts: ProviderConfig::default(),
            voice: "alloy".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Emotion {
    Happy,
    Sad,
    Surprised,
    Annoyed,
    Calm,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Gaze {
    User,
    Screen,
    Away,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Gesture {
    None,
    Nod,
    Tilt,
    SmallBounce,
    LookAway,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reaction {
    pub should_react: bool,
    pub text: String,
    pub emotion: Emotion,
    pub intensity: f32,
    pub gaze: Gaze,
    pub gesture: Gesture,
    pub priority: u8,
}
impl Reaction {
    pub fn validate(&self) -> Result<(), String> {
        if !self.intensity.is_finite()
            || !(0.0..=1.0).contains(&self.intensity)
            || self.priority > 3
        {
            return Err("AI 반응 강도 또는 우선순위가 허용 범위를 벗어났습니다.".into());
        }
        if self.text.chars().count() > 500
            || self
                .text
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("AI 대사 형식이 올바르지 않습니다.".into());
        }
        if !self.should_react && !self.text.trim().is_empty() {
            return Err("침묵 반응에 대사가 포함되어 있습니다.".into());
        }
        Ok(())
    }
    pub fn silence() -> Self {
        Self {
            should_react: false,
            text: String::new(),
            emotion: Emotion::Calm,
            intensity: 0.0,
            gaze: Gaze::User,
            gesture: Gesture::None,
            priority: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequest {
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationReply {
    pub utterance_id: String,
    pub reaction: Reaction,
    pub source: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioReply {
    pub utterance_id: String,
    pub audio_base64: String,
    pub mime_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub text: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryInput {
    pub id: Option<String>,
    pub text: String,
    pub expires_at: Option<i64>,
    pub confirmed: bool,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
