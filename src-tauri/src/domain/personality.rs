use super::types::{CharacterProfile, Emotion, Gaze, Gesture, Reaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

fn templates() -> &'static Vec<Value> {
    static TEMPLATES: OnceLock<Vec<Value>> = OnceLock::new();
    TEMPLATES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/personality-presets.json"))
            .expect("bundled personality templates must be valid JSON")
    })
}

/// Shared with the settings UI. Read the fields explicitly to avoid recursively
/// calling CharacterProfile::default during serde's missing-field handling.
pub fn template_profile(id: &str) -> Result<CharacterProfile, String> {
    let template = templates()
        .iter()
        .find(|template| template["id"] == id)
        .ok_or("지원하지 않는 성격입니다.")?;
    let field = |name: &str| {
        template["profile"][name]
            .as_str()
            .expect("bundled character profile fields must be strings")
            .to_owned()
    };
    Ok(CharacterProfile {
        user_address: field("userAddress"),
        relationship: field("relationship"),
        appearance: field("appearance"),
        personality_prompt: field("personalityPrompt"),
        speech_style: field("speechStyle"),
        dialogue_examples: field("dialogueExamples"),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Personality {
    pub id: String,
    pub name: String,
    pub description: String,
    pub expression_strength: f32,
    pub gesture_strength: f32,
    pub min_interval_seconds: u64,
    pub speaking_style: String,
}

pub fn personalities() -> Vec<Personality> {
    templates()
        .iter()
        .map(|template| {
            let id = template["id"].as_str().expect("preset id");
            let (expression_strength, gesture_strength, min_interval_seconds) = match id {
                "tsundere" => (0.7, 0.5, 55),
                "cat" => (0.35, 0.25, 100),
                _ => (0.95, 0.8, 35),
            };
            Personality {
                id: id.into(),
                name: template["name"].as_str().expect("preset name").into(),
                description: template["subtitle"]
                    .as_str()
                    .expect("preset subtitle")
                    .into(),
                expression_strength,
                gesture_strength,
                min_interval_seconds,
                speaking_style: template_profile(id).expect("preset profile").speech_style,
            }
        })
        .collect()
}

pub fn personality(id: &str) -> Result<Personality, String> {
    personalities()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "지원하지 않는 성격입니다.".into())
}

pub fn preview_personality(id: &str) -> Result<Reaction, String> {
    let p = personality(id)?;
    let text = templates()
        .iter()
        .find(|template| template["id"] == id)
        .and_then(|template| template["quote"].as_str())
        .ok_or("성격 예시를 찾을 수 없습니다.")?;
    let (gaze, gesture) = match id {
        "tsundere" => (Gaze::Away, Gesture::Tilt),
        "cat" => (Gaze::User, Gesture::Nod),
        _ => (Gaze::User, Gesture::SmallBounce),
    };
    Ok(Reaction {
        should_react: true,
        text: text.into(),
        emotion: Emotion::Happy,
        intensity: p.expression_strength,
        gesture_intensity: Some(p.gesture_strength),
        gaze,
        gesture,
        priority: 1,
    })
}

/// Explicit result fixtures stay separate from the everyday personality preview.
pub fn success_reaction(id: &str) -> Result<Reaction, String> {
    let p = personality(id)?;
    let (text, gaze, gesture) = match id {
        "tsundere" => (
            "붙었네. 그렇게 준비했으니까… 축하해.",
            Gaze::Away,
            Gesture::Tilt,
        ),
        "cat" => ("합격이네. 잘했어. 이제 좀 쉬자.", Gaze::User, Gesture::Nod),
        _ => (
            "해냈다! 열심히 준비한 만큼 좋은 소식이 왔네!",
            Gaze::User,
            Gesture::SmallBounce,
        ),
    };
    Ok(Reaction {
        should_react: true,
        text: text.into(),
        emotion: Emotion::Happy,
        intensity: p.expression_strength,
        gesture_intensity: Some(p.gesture_strength),
        gaze,
        gesture,
        priority: 2,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultScene {
    NotResult,
    Negative,
    OwnerUnknown,
    UserSuccess,
}

/// Conservative local guard for explicit text scenes. This is not screenshot OCR.
pub fn classify_result_scene(text: &str, owner_is_user: bool) -> ResultScene {
    let compact: String = text
        .to_lowercase()
        .chars()
        .filter(|x| !x.is_whitespace())
        .collect();
    if [
        "불합격",
        "미합격",
        "탈락",
        "합격하지못",
        "합격하지않",
        "합격아니",
        "합격은아니",
        "합격이아니",
        "합격아님",
        "합격이아님",
        "합격은아님",
        "합격이아닙",
        "합격은아닙",
        "합격못",
        "didnotpass",
        "notaccepted",
        "rejected",
        "unsuccessful",
    ]
    .iter()
    .any(|x| compact.contains(x))
    {
        return ResultScene::Negative;
    }
    let explicit_english_result = ["exam", "admission", "application", "interview"]
        .iter()
        .any(|context| compact.contains(context))
        && (compact.contains("accepted") || compact.contains("passed"));
    if compact.contains("합격") || explicit_english_result {
        if owner_is_user {
            ResultScene::UserSuccess
        } else {
            ResultScene::OwnerUnknown
        }
    } else {
        ResultScene::NotResult
    }
}

pub fn result_scene_reaction(
    text: &str,
    owner_is_user: bool,
    id: &str,
) -> Result<Option<Reaction>, String> {
    Ok(match classify_result_scene(text, owner_is_user) {
        ResultScene::NotResult => None,
        ResultScene::UserSuccess => Some(success_reaction(id)?),
        ResultScene::OwnerUnknown => Some(Reaction {
            should_react: true,
            text: "합격이라고 적혀 있는데, 네 결과야?".into(),
            emotion: Emotion::Surprised,
            intensity: 0.35,
            gesture_intensity: None,
            gaze: Gaze::Screen,
            gesture: Gesture::Tilt,
            priority: 1,
        }),
        ResultScene::Negative => Some(Reaction {
            should_react: true,
            text: "마음이 복잡하겠다. 이야기하고 싶으면 옆에 있을게.".into(),
            emotion: Emotion::Sad,
            intensity: 0.35,
            gesture_intensity: None,
            gaze: Gaze::User,
            gesture: Gesture::None,
            priority: 1,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_results_never_become_congratulations() {
        for text in [
            "불합격",
            "합격하지 못했습니다",
            "합격이 아닙니다",
            "이번엔 합격 못했어",
            "not accepted",
        ] {
            assert_eq!(
                classify_result_scene(text, true),
                ResultScene::Negative,
                "{text}"
            );
            assert_ne!(
                result_scene_reaction(text, true, "cat")
                    .unwrap()
                    .unwrap()
                    .emotion,
                Emotion::Happy
            );
        }
    }
    #[test]
    fn unknown_owner_requires_confirmation() {
        assert_eq!(
            classify_result_scene("최종 합격", false),
            ResultScene::OwnerUnknown
        );
        assert_eq!(
            classify_result_scene("최종 합격", true),
            ResultScene::UserSuccess
        );
    }
    #[test]
    fn previews_differ_in_more_than_words() {
        let a = preview_personality("tsundere").unwrap();
        let b = preview_personality("cat").unwrap();
        let c = preview_personality("cheerleader").unwrap();
        assert!(a.intensity > b.intensity && c.intensity > a.intensity);
        assert_eq!(a.gesture_intensity, Some(0.5));
        assert_eq!(b.gesture_intensity, Some(0.25));
        assert_eq!(c.gesture_intensity, Some(0.8));
        assert_ne!(a.gesture, b.gesture);
        assert_ne!(b.gesture, c.gesture);
        for preview in [a, b, c] {
            assert!(!preview.text.contains("합격"));
            assert!(!preview.text.contains("붙었"));
        }
    }
    #[test]
    fn ordinary_success_is_not_an_admission_result() {
        for text in [
            "All tests passed",
            "Build successful",
            "게임 승리",
            "코드 테스트 통과",
        ] {
            assert_eq!(classify_result_scene(text, true), ResultScene::NotResult);
        }
        assert_eq!(
            classify_result_scene("You passed the exam", true),
            ResultScene::UserSuccess
        );
    }
    #[test]
    fn all_bundled_profiles_are_valid_and_share_the_frontend_templates() {
        for preset in personalities() {
            let profile = template_profile(&preset.id).unwrap();
            profile.validate().unwrap();
            assert_eq!(preset.speaking_style, profile.speech_style);
        }
        assert_eq!(
            CharacterProfile::default(),
            template_profile("tsundere").unwrap()
        );
    }
}
