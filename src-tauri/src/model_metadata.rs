//! Diagnostic metadata read from a successfully loaded Core model. This cache
//! never substitutes for Core validation or runtime capability detection.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Parameter {
    pub id: String,
    pub minimum: f64,
    pub maximum: f64,
    pub default: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelMetadata {
    pub parameters: Vec<Parameter>,
    pub expressions: Vec<String>,
}

impl ModelMetadata {
    pub fn validate(&self) -> Result<(), String> {
        if self.parameters.len() > 16384 || self.expressions.len() > 1024 {
            return Err("모델의 파라미터 또는 표정 목록이 너무 큽니다.".into());
        }
        let valid_id =
            |id: &str| !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control);
        let mut ids = HashSet::new();
        for p in &self.parameters {
            if !valid_id(&p.id)
                || !ids.insert(&p.id)
                || !p.minimum.is_finite()
                || !p.maximum.is_finite()
                || !p.default.is_finite()
                || p.minimum > p.maximum
                || !(p.minimum..=p.maximum).contains(&p.default)
            {
                return Err("Core 파라미터의 ID 또는 최소·최대·기본값을 확인해 주세요.".into());
            }
        }
        let mut expressions = HashSet::new();
        if self
            .expressions
            .iter()
            .any(|id| !valid_id(id) || !expressions.insert(id))
        {
            return Err("모델 표정 목록을 확인해 주세요.".into());
        }
        Ok(())
    }
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if crate::domain::types::BUILTIN_MODEL_IDS.contains(&id) || uuid::Uuid::parse_str(id).is_ok() {
        Ok(())
    } else {
        Err("모델 식별자를 확인해 주세요.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn example() -> ModelMetadata {
        ModelMetadata {
            parameters: vec![Parameter {
                id: "ParamAngleX".into(),
                minimum: -30.0,
                maximum: 30.0,
                default: 0.0,
            }],
            expressions: vec!["calm".into()],
        }
    }
    #[test]
    fn rejects_duplicate_nonfinite_and_invalid_ranges() {
        let mut metadata = example();
        assert!(metadata.validate().is_ok());
        metadata.parameters.push(metadata.parameters[0].clone());
        assert!(metadata.validate().is_err());
        metadata.parameters.pop();
        metadata.parameters[0].default = 31.0;
        assert!(metadata.validate().is_err());
        metadata.parameters[0].default = 0.0;
        metadata.parameters[0].minimum = f64::NAN;
        assert!(metadata.validate().is_err());
        assert!(validate_id("../../outside").is_err());
    }
}
