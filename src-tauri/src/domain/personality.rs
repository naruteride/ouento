use super::types::{Emotion, Gaze, Gesture, Reaction};
use serde::{Deserialize, Serialize};

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
    vec![
        Personality { id: "tsundere".into(), name: "수줍은 츤데레".into(), description: "툭 던지는 말 뒤에 숨은 다정함".into(), expression_strength: 0.7, gesture_strength: 0.5, min_interval_seconds: 55,
            speaking_style: "짧고 담백한 한국어 반말. 수줍어서 마음을 곧바로 드러내지 않지만 실제로 따뜻하게 대한다. 모욕하거나 소유하려 하지 않는다.".into() },
        Personality { id: "cat".into(), name: "무심한 고양이".into(), description: "말수는 적어도 늘 곁에".into(), expression_strength: 0.35, gesture_strength: 0.25, min_interval_seconds: 100,
            speaking_style: "무심하고 느긋한 한국어 반말. 한두 문장으로 간결하게 말한다. 필요 없는 질문을 반복하지 않고 조용히 함께한다.".into() },
        Personality { id: "cheerleader".into(), name: "작은 응원단".into(), description: "작은 진전도 함께 기뻐하는 친구".into(), expression_strength: 0.95, gesture_strength: 0.8, min_interval_seconds: 35,
            speaking_style: "밝고 다정한 한국어 반말. 작은 성취를 구체적으로 축하하되 과장된 확신이나 상투적인 칭찬을 반복하지 않는다.".into() },
    ]
}

pub fn personality(id: &str) -> Result<Personality, String> {
    personalities()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "지원하지 않는 성격입니다.".into())
}

pub fn preview_personality(id: &str) -> Result<Reaction, String> {
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
    if compact.contains("합격") || compact.contains("accepted") || compact.contains("passed") {
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
        ResultScene::UserSuccess => Some(preview_personality(id)?),
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
    }
}
