use crate::{
    domain::types::{Memory, MemoryInput, Settings, BUILTIN_MODEL_IDS},
    model_metadata::{self, ModelMetadata},
    models::validate_model_mapping,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|_| "앱 저장 폴더를 만들 수 없습니다.")?;
        let path = directory.join("ouento.sqlite3");
        let connection = Connection::open(&path).map_err(db_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "기억 저장소 접근 권한을 설정할 수 없습니다.")?;
        }
        Self::initialize(connection)
    }
    fn initialize(connection: Connection) -> Result<Self, String> {
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if version > 3 {
            return Err("새 버전에서 만든 저장소입니다. 앱을 업데이트해 주세요.".into());
        }
        connection.execute_batch("PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER);
            CREATE INDEX IF NOT EXISTS memories_expiry ON memories(expires_at);
            CREATE TABLE IF NOT EXISTS builtin_model_mappings (model_id TEXT PRIMARY KEY CHECK(model_id IN ('builtin:mao','builtin:haru','builtin:kei')), json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS model_core_metadata (model_id TEXT PRIMARY KEY, json TEXT NOT NULL);
            PRAGMA user_version=3;
            COMMIT;").map_err(db_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "저장소 잠금을 가져올 수 없습니다.".into())
    }
    pub fn settings(&self) -> Result<Settings, String> {
        let raw: Option<String> = self
            .lock()?
            .query_row("SELECT json FROM settings WHERE id=1", [], |row| row.get(0))
            .optional()
            .map_err(db_error)?;
        match raw {
            None => Ok(Settings::default()),
            Some(raw) => serde_json::from_str(&raw).map_err(|_| {
                "설정 파일이 손상되었습니다. 데이터를 백업한 후 초기화해 주세요.".into()
            }),
        }
    }
    pub fn save_model_metadata(&self, id: &str, metadata: &ModelMetadata) -> Result<(), String> {
        model_metadata::validate_id(id)?;
        metadata.validate()?;
        let raw = serde_json::to_string(metadata).map_err(|_| "모델 정보를 변환할 수 없습니다.")?;
        self.lock()?.execute("INSERT INTO model_core_metadata(model_id,json) VALUES(?1,?2) ON CONFLICT(model_id) DO UPDATE SET json=excluded.json", params![id,raw]).map_err(db_error)?;
        Ok(())
    }
    pub fn model_metadata(&self, id: &str) -> Result<Option<ModelMetadata>, String> {
        model_metadata::validate_id(id)?;
        let raw: Option<String> = self
            .lock()?
            .query_row(
                "SELECT json FROM model_core_metadata WHERE model_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        raw.map(|raw| {
            let metadata: ModelMetadata =
                serde_json::from_str(&raw).map_err(|_| "저장된 모델 정보가 손상되었습니다.")?;
            metadata.validate()?;
            Ok(metadata)
        })
        .transpose()
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        settings.validate()?;
        let raw = serde_json::to_string(settings).map_err(|_| "설정을 변환할 수 없습니다.")?;
        self.lock()?.execute("INSERT INTO settings(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", [raw]).map_err(db_error)?;
        Ok(())
    }
    pub fn memories(&self, now: i64) -> Result<Vec<Memory>, String> {
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                [now],
            )
            .map_err(db_error)?;
        let mut statement = connection.prepare("SELECT id,text,created_at,updated_at,expires_at FROM memories ORDER BY updated_at DESC").map_err(db_error)?;
        let rows = statement.query_map([], memory_from_row).map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }
    pub fn save_memory(&self, input: MemoryInput, now: i64) -> Result<Memory, String> {
        if !input.confirmed {
            return Err("기억 저장은 사용자의 확인이 필요합니다.".into());
        }
        let text = input.text.trim().to_string();
        if text.is_empty() || text.chars().count() > 1000 {
            return Err("요약 기억은 1~1,000자로 입력해 주세요.".into());
        }
        if input.expires_at.is_some_and(|time| time <= now) {
            return Err("기억 만료 시각은 현재보다 뒤여야 합니다.".into());
        }
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                [now],
            )
            .map_err(db_error)?;
        let (id, created_at) = if let Some(id) = input.id {
            let created_at: i64 = connection
                .query_row(
                    "SELECT created_at FROM memories WHERE id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?
                .ok_or("기억을 찾을 수 없습니다.")?;
            (id, created_at)
        } else {
            let count: u32 = connection
                .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
                .map_err(db_error)?;
            if count >= 100 {
                return Err("기억은 최대 100개입니다. 오래된 기억을 정리해 주세요.".into());
            }
            (uuid::Uuid::new_v4().to_string(), now)
        };
        let memory = Memory {
            id,
            text,
            created_at,
            updated_at: now,
            expires_at: input.expires_at,
        };
        connection.execute("INSERT INTO memories(id,text,created_at,updated_at,expires_at) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at,expires_at=excluded.expires_at",
            params![memory.id, memory.text, memory.created_at, memory.updated_at, memory.expires_at]).map_err(db_error)?;
        Ok(memory)
    }
    pub fn delete_memory(&self, id: &str) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM memories WHERE id=?1", [id])
            .map_err(db_error)?;
        Ok(())
    }
    pub fn clear_memories(&self) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM memories", [])
            .map_err(db_error)?;
        Ok(())
    }
    pub fn builtin_model_mapping(&self, id: &str) -> Result<serde_json::Value, String> {
        validate_builtin_id(id)?;
        let raw: Option<String> = self
            .lock()?
            .query_row(
                "SELECT json FROM builtin_model_mappings WHERE model_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let mapping = match raw {
            Some(raw) => {
                serde_json::from_str(&raw).map_err(|_| "저장된 캐릭터 매핑이 손상되었습니다.")?
            }
            None => serde_json::json!({}),
        };
        validate_model_mapping(&mapping)?;
        Ok(mapping)
    }
    pub fn save_builtin_model_mapping(
        &self,
        id: &str,
        mapping: serde_json::Value,
    ) -> Result<(), String> {
        validate_builtin_id(id)?;
        validate_model_mapping(&mapping)?;
        let raw =
            serde_json::to_string(&mapping).map_err(|_| "캐릭터 매핑을 변환할 수 없습니다.")?;
        self.lock()?.execute("INSERT INTO builtin_model_mappings(model_id,json) VALUES(?1,?2) ON CONFLICT(model_id) DO UPDATE SET json=excluded.json", params![id,raw]).map_err(db_error)?;
        Ok(())
    }
}

fn validate_builtin_id(id: &str) -> Result<(), String> {
    if BUILTIN_MODEL_IDS.contains(&id) {
        Ok(())
    } else {
        Err("지원하지 않는 기본 캐릭터입니다.".into())
    }
}

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: row.get(0)?,
        text: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        expires_at: row.get(4)?,
    })
}
fn db_error(_: rusqlite::Error) -> String {
    "로컬 저장소를 읽거나 쓰지 못했습니다. 디스크 공간과 접근 권한을 확인해 주세요.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> Store {
        Store::initialize(Connection::open_in_memory().unwrap()).unwrap()
    }
    #[test]
    fn memories_require_consent_and_expire_from_storage() {
        let store = store();
        let mut input = MemoryInput {
            id: None,
            text: "토요일에는 수학을 공부한다".into(),
            expires_at: Some(2000),
            confirmed: false,
        };
        assert!(store.save_memory(input.clone(), 1000).is_err());
        input.confirmed = true;
        let memory = store.save_memory(input, 1000).unwrap();
        assert_eq!(store.memories(1999).unwrap().len(), 1);
        assert!(store.memories(2000).unwrap().is_empty());
        assert!(store
            .save_memory(
                MemoryInput {
                    id: Some(memory.id),
                    text: "다른 내용".into(),
                    expires_at: None,
                    confirmed: true
                },
                3000
            )
            .is_err());
    }
    #[test]
    fn edits_preserve_creation_time_and_delete_is_final() {
        let store = store();
        let original = store
            .save_memory(
                MemoryInput {
                    id: None,
                    text: "A".into(),
                    expires_at: None,
                    confirmed: true,
                },
                1000,
            )
            .unwrap();
        let changed = store
            .save_memory(
                MemoryInput {
                    id: Some(original.id.clone()),
                    text: "B".into(),
                    expires_at: None,
                    confirmed: true,
                },
                2000,
            )
            .unwrap();
        assert_eq!(changed.created_at, 1000);
        assert_eq!(changed.updated_at, 2000);
        assert_eq!(store.memories(3000).unwrap()[0].text, "B");
        store.delete_memory(&original.id).unwrap();
        assert!(store.memories(3000).unwrap().is_empty());
    }
    #[test]
    fn settings_roundtrip_has_no_secret_fields() {
        let store = store();
        let s = Settings::default();
        store.save_settings(&s).unwrap();
        assert_eq!(store.settings().unwrap(), s);
        let mut value = serde_json::to_value(s).unwrap();
        value["apiKey"] = "should-be-rejected".into();
        assert!(serde_json::from_value::<Settings>(value).is_err());
    }
    #[test]
    fn core_metadata_survives_reopen_and_stays_separate_per_model() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let metadata = ModelMetadata {
            parameters: vec![model_metadata::Parameter {
                id: "ParamA".into(),
                minimum: 0.0,
                maximum: 1.0,
                default: 0.0,
            }],
            expressions: vec!["calm".into()],
        };
        store.save_model_metadata("builtin:mao", &metadata).unwrap();
        drop(store);
        let reopened = Store::open(directory.path()).unwrap();
        assert_eq!(
            reopened.model_metadata("builtin:mao").unwrap(),
            Some(metadata)
        );
        assert!(reopened.model_metadata("builtin:haru").unwrap().is_none());
    }
    #[test]
    fn built_in_mappings_persist_separately_and_reject_unknown_ids() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        store
            .save_builtin_model_mapping("builtin:mao", serde_json::json!({"mouthOpen":"MaoMouth"}))
            .unwrap();
        store
            .save_builtin_model_mapping(
                "builtin:haru",
                serde_json::json!({"mouthOpen":"HaruMouth"}),
            )
            .unwrap();
        assert!(store
            .save_builtin_model_mapping("builtin:../private", serde_json::json!({}))
            .is_err());
        assert!(store
            .save_builtin_model_mapping("builtin:kei", serde_json::json!(["not-an-object"]))
            .is_err());
        assert!(store
            .save_builtin_model_mapping(
                "builtin:kei",
                serde_json::json!({"mouthOpen":"x".repeat(1025)})
            )
            .is_err());
        drop(store);
        let reopened = Store::open(directory.path()).unwrap();
        assert_eq!(
            reopened.builtin_model_mapping("builtin:mao").unwrap()["mouthOpen"],
            "MaoMouth"
        );
        assert_eq!(
            reopened.builtin_model_mapping("builtin:haru").unwrap()["mouthOpen"],
            "HaruMouth"
        );
        assert_eq!(
            reopened.builtin_model_mapping("builtin:kei").unwrap(),
            serde_json::json!({})
        );
        assert!(reopened.builtin_model_mapping("builtin:unknown").is_err());
    }
    #[test]
    fn schema_one_migrates_without_erasing_settings_or_memories() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
            CREATE TABLE memories(id TEXT PRIMARY KEY,text TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER);
            INSERT INTO settings(id,json) VALUES(1,'{}');
            INSERT INTO memories(id,text,created_at,updated_at) VALUES('old','기존 기억',1000,1000);
            PRAGMA user_version=1;").unwrap();
        let migrated = Store::initialize(connection).unwrap();
        assert_eq!(migrated.settings().unwrap(), Settings::default());
        assert_eq!(migrated.memories(2000).unwrap()[0].text, "기존 기억");
        migrated
            .save_builtin_model_mapping("builtin:kei", serde_json::json!({"mouthOpen":"ParamA"}))
            .unwrap();
        assert_eq!(
            migrated.builtin_model_mapping("builtin:kei").unwrap()["mouthOpen"],
            "ParamA"
        );
    }
}
