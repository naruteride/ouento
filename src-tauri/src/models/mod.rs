//! Bounded, data-only Live2D import. Core consistency is additionally checked by the renderer.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MAX_FILES: usize = 4096;
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXTURE_SIDE: u32 = 8192;
const MAX_TEXTURE_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub expressions: Vec<String>,
    pub motions: Vec<String>,
    pub physics: bool,
    pub pose: bool,
    pub motion_sync: bool,
    pub eye_blink_candidates: Vec<String>,
    pub lip_sync_candidates: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub entrypoint: String,
    pub name: String,
    pub valid: bool,
    pub error: Option<String>,
    pub capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInspection {
    pub token: String,
    pub candidates: Vec<ModelCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedModel {
    pub id: String,
    pub name: String,
    pub entrypoint: String,
    pub imported_at: u64,
    pub capabilities: ModelCapabilities,
    pub assets: Vec<String>,
    pub requires_core_validation: bool,
}

#[derive(Debug, Clone)]
pub struct ModelStore {
    root: PathBuf,
    previews: Arc<Mutex<HashMap<(String, String), PreviewIndex>>>,
}

#[derive(Debug)]
struct PreviewIndex {
    assets: BTreeSet<String>,
    definition: Vec<u8>,
}

fn io_error(e: impl std::fmt::Display) -> String {
    format!("모델 파일 처리 실패: {e}")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Reject the same dangerous names on every OS, so an archive's meaning cannot change after copying.
pub fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains(['\\', ':', '\0', '?', '#', '%'])
        || value.starts_with('/')
    {
        return Err("상대 파일 경로만 허용합니다 (URL·절대 경로·인코딩된 경로 금지).".into());
    }
    let path = Path::new(value);
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err("모델 경로가 허용 폴더를 벗어납니다.".into());
        };
        let name = part.to_str().ok_or("파일 이름은 UTF-8이어야 합니다.")?;
        if name.ends_with(['.', ' '])
            || name.chars().any(|c| c.is_control() || "<>|\"*".contains(c))
        {
            return Err("플랫폼에서 안전하지 않은 파일 이름입니다.".into());
        }
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("Windows 예약 파일 이름은 가져올 수 없습니다.".into());
        }
    }
    // std::Path normalizes interior '.'; reject these explicitly before it can hide them.
    if value
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err("모델 경로에 빈 구간이나 상위 폴더 참조가 있습니다.".into());
    }
    Ok(path.to_path_buf())
}

fn relative_string(path: &Path) -> Result<String, String> {
    let parts: Result<Vec<_>, _> = path
        .components()
        .map(|c| match c {
            Component::Normal(p) => p
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "파일 이름은 UTF-8이어야 합니다.".to_owned()),
            _ => Err("잘못된 상대 경로입니다.".to_owned()),
        })
        .collect();
    Ok(parts?.join("/"))
}

fn check_uuid(value: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| "잘못된 모델 식별자입니다.")?;
    if parsed.to_string() != value {
        return Err("잘못된 모델 식별자입니다.".into());
    }
    Ok(())
}

fn checked_file(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    if fs::symlink_metadata(root)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
    {
        return Err("심볼릭 링크 폴더는 허용하지 않습니다.".into());
    }
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("잘못된 모델 자산 경로입니다.".into());
        }
        current.push(component.as_os_str());
        if fs::symlink_metadata(&current)
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        {
            return Err("모델 자산의 심볼릭 링크는 허용하지 않습니다.".into());
        }
    }
    let canonical = current.canonicalize().map_err(io_error)?;
    if !canonical.starts_with(root.canonicalize().map_err(io_error)?) {
        return Err("모델 자산이 관리 폴더를 벗어납니다.".into());
    }
    if !fs::metadata(&canonical).map_err(io_error)?.is_file() {
        return Err("자산은 일반 파일이어야 합니다.".into());
    }
    Ok(canonical)
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(io_error)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("심볼릭 링크·특수 파일은 가져올 수 없습니다.".into());
    }
    if meta.len() > limit {
        return Err(format!("파일 크기 제한({limit} bytes)을 초과했습니다."));
    }
    let file = File::open(path).map_err(io_error)?;
    let opened = file.metadata().map_err(io_error)?;
    if !opened.is_file() || opened.len() != meta.len() {
        return Err("가져오는 동안 파일이 변경되었습니다.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.ino() != opened.ino() || meta.dev() != opened.dev() {
            return Err("가져오는 동안 파일이 교체되었습니다.".into());
        }
    }
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(io_error)?;
    if data.len() as u64 > limit {
        return Err("파일 크기 제한을 초과했습니다.".into());
    }
    Ok(data)
}

fn data_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("json" | "moc3" | "png" | "jpg" | "jpeg" | "wav" | "mp3" | "ogg")
    )
}

impl ModelStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(io_error)?;
        if fs::symlink_metadata(&root)
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        {
            return Err("모델 관리 폴더는 심볼릭 링크일 수 없습니다.".into());
        }
        fs::create_dir_all(root.join(".staging")).map_err(io_error)?;
        if fs::symlink_metadata(root.join(".staging"))
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        {
            return Err("가져오기 임시 폴더는 심볼릭 링크일 수 없습니다.".into());
        }
        let store = Self {
            root: root.canonicalize().map_err(io_error)?,
            previews: Arc::new(Mutex::new(HashMap::new())),
        };
        // Abandoned inspection snapshots contain no user originals and expire after a day.
        for entry in fs::read_dir(store.root.join(".staging"))
            .map_err(io_error)?
            .flatten()
        {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir()
                    && meta
                        .modified()
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|d| d.as_secs() > 86400)
                {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(store)
    }

    pub fn inspect_source(&self, source: &Path) -> Result<ImportInspection, String> {
        let token = Uuid::new_v4().to_string();
        let staging = self.root.join(".staging").join(&token);
        fs::create_dir(&staging).map_err(io_error)?;
        let result = self.inspect_into(source, &staging, token);
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    fn inspect_into(
        &self,
        source: &Path,
        staging: &Path,
        token: String,
    ) -> Result<ImportInspection, String> {
        let meta = fs::symlink_metadata(source).map_err(io_error)?;
        if meta.file_type().is_symlink() {
            return Err("심볼릭 링크는 가져올 수 없습니다.".into());
        }
        let mut warnings = Vec::new();
        if meta.is_dir() {
            snapshot_folder(source, staging, &mut warnings)?;
        } else if source
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
        {
            snapshot_zip(source, staging, &mut warnings)?;
        } else {
            return Err(
                "모델 폴더 또는 ZIP을 선택하세요. .cmo3·PSD·이미지 단독 파일은 실행할 수 없습니다."
                    .into(),
            );
        }
        let mut entries = Vec::new();
        collect_entrypoints(staging, staging, &mut entries)?;
        entries.sort();
        if entries.is_empty() {
            return Err(
                "실행용 .model3.json이 없습니다. .moc3와 텍스처를 포함한 모델 묶음이 필요합니다."
                    .into(),
            );
        }
        let candidates = entries
            .into_iter()
            .map(|entrypoint| {
                let name = Path::new(&entrypoint)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("모델")
                    .trim_end_matches(".model3.json")
                    .to_owned();
                match validate_model(staging, &entrypoint) {
                    Ok((_, capabilities, _)) => ModelCandidate {
                        entrypoint,
                        name,
                        valid: true,
                        error: None,
                        capabilities: Some(capabilities),
                    },
                    Err(error) => ModelCandidate {
                        entrypoint,
                        name,
                        valid: false,
                        error: Some(error),
                        capabilities: None,
                    },
                }
            })
            .collect();
        Ok(ImportInspection {
            token,
            candidates,
            warnings,
        })
    }

    /// Preview only the selected candidate's verified assets without committing an import.
    pub fn read_import_asset(
        &self,
        token: &str,
        entrypoint: &str,
        path: &str,
    ) -> Result<Vec<u8>, String> {
        check_uuid(token)?;
        let root = self.root.join(".staging").join(token);
        let key = (token.to_owned(), entrypoint.to_owned());
        let mut cache = self
            .previews
            .lock()
            .map_err(|_| "미리보기 검증 목록에 접근할 수 없습니다.")?;
        if !cache.contains_key(&key) {
            let (assets, _, definition) = validate_model(&root, entrypoint)?;
            // Bounded cache for app-managed immutable snapshots. Confirming import revalidates.
            if cache.len() >= 32 {
                if let Some(key) = cache.keys().next().cloned() {
                    cache.remove(&key);
                }
            }
            cache.insert(
                key.clone(),
                PreviewIndex {
                    assets,
                    definition: serde_json::to_vec(&definition).map_err(io_error)?,
                },
            );
        }
        let preview = cache.get(&key).ok_or("미리보기 검증 목록이 없습니다.")?;
        if !preview.assets.contains(path) {
            return Err("선택한 모델의 검증 목록에 없는 자산입니다.".into());
        }
        if path == entrypoint {
            // Even cached entrypoints must remain inside the snapshot and must not be links.
            checked_file(&root, &safe_relative(path)?)?;
            return Ok(preview.definition.clone());
        }
        drop(cache);
        read_limited(&checked_file(&root, &safe_relative(path)?)?, MAX_FILE_BYTES)
    }

    pub fn discard_inspection(&self, token: &str) -> Result<(), String> {
        check_uuid(token)?;
        self.previews
            .lock()
            .map_err(|_| "미리보기 검증 목록을 지울 수 없습니다.")?
            .retain(|(cached_token, _), _| cached_token != token);
        let path = self.root.join(".staging").join(token);
        if path.exists() {
            fs::remove_dir_all(path).map_err(io_error)?;
        }
        Ok(())
    }

    pub fn import(&self, token: &str, entrypoint: &str) -> Result<ImportedModel, String> {
        check_uuid(token)?;
        let staging = self.root.join(".staging").join(token);
        let (assets, capabilities, definition) = validate_model(&staging, entrypoint)?;
        let id = Uuid::new_v4().to_string();
        let destination = self.root.join(&id);
        fs::create_dir(&destination).map_err(io_error)?;
        let result = (|| {
            for asset in &assets {
                let relative = safe_relative(asset)?;
                let source = checked_file(&staging, &relative)?;
                let data = if asset == entrypoint {
                    serde_json::to_vec(&definition).map_err(io_error)?
                } else {
                    read_limited(&source, MAX_FILE_BYTES)?
                };
                let target = destination.join(relative);
                fs::create_dir_all(target.parent().ok_or("잘못된 자산 경로입니다.")?)
                    .map_err(io_error)?;
                fs::write(target, data).map_err(io_error)?;
            }
            let imported = ImportedModel {
                id,
                name: Path::new(entrypoint)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("모델")
                    .trim_end_matches(".model3.json")
                    .to_owned(),
                entrypoint: entrypoint.to_owned(),
                imported_at: now(),
                capabilities,
                assets: assets.into_iter().collect(),
                requires_core_validation: true,
            };
            write_json_atomic(
                &destination.join("manifest.json"),
                &serde_json::to_value(&imported).map_err(io_error)?,
            )?;
            Ok(imported)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&destination);
        }
        // Keep a failed inspection so another valid model in the bundle can be selected.
        if result.is_ok() {
            self.discard_inspection(token)?;
        }
        result
    }

    pub fn get(&self, id: &str) -> Result<ImportedModel, String> {
        check_uuid(id)?;
        let root = self.root.join(id);
        let bytes = read_limited(
            &checked_file(&root, Path::new("manifest.json"))?,
            MAX_JSON_BYTES,
        )?;
        let model: ImportedModel = serde_json::from_slice(&bytes).map_err(io_error)?;
        if model.id != id {
            return Err("모델 메타데이터 식별자가 일치하지 않습니다.".into());
        }
        safe_relative(&model.entrypoint)?;
        for asset in &model.assets {
            safe_relative(asset)?;
        }
        Ok(model)
    }

    pub fn list(&self) -> Result<Vec<ImportedModel>, String> {
        let mut models = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(io_error)?.flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            if check_uuid(&id).is_ok() {
                models.push(self.get(&id)?);
            }
        }
        models.sort_by(|a, b| b.imported_at.cmp(&a.imported_at).then(a.id.cmp(&b.id)));
        Ok(models)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.get(id)?;
        fs::remove_dir_all(self.root.join(id)).map_err(io_error)
    }

    pub fn read_asset(&self, id: &str, relative_path: &str) -> Result<Vec<u8>, String> {
        let model = self.get(id)?;
        let relative = safe_relative(relative_path)?;
        if !model.assets.iter().any(|asset| asset == relative_path) {
            return Err("검증 목록에 없는 모델 자산입니다.".into());
        }
        read_limited(
            &checked_file(&self.root.join(id), &relative)?,
            MAX_FILE_BYTES,
        )
    }

    pub fn save_mapping(&self, id: &str, mapping: Value) -> Result<(), String> {
        self.get(id)?;
        validate_model_mapping(&mapping)?;
        write_json_atomic(&self.root.join(id).join("mapping.json"), &mapping)
    }

    pub fn load_mapping(&self, id: &str) -> Result<Value, String> {
        self.get(id)?;
        let root = self.root.join(id);
        if !root.join("mapping.json").exists() {
            return Ok(serde_json::json!({}));
        }
        let bytes = read_limited(&checked_file(&root, Path::new("mapping.json"))?, 256 * 1024)?;
        let mapping = serde_json::from_slice(&bytes).map_err(io_error)?;
        validate_model_mapping(&mapping)?;
        Ok(mapping)
    }
}

/// Shared JSON contract for imported and built-in model mappings.
pub(crate) fn validate_model_mapping(mapping: &Value) -> Result<(), String> {
    if !mapping.is_object() {
        return Err("모델 매핑은 객체여야 합니다.".into());
    }
    if serde_json::to_vec(mapping).map_err(io_error)?.len() > 256 * 1024 {
        return Err("모델 매핑이 너무 큽니다.".into());
    }
    validate_mapping(mapping, 0)
}

fn validate_mapping(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 12 {
        return Err("모델 매핑 구조가 너무 깊습니다.".into());
    }
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key.len() > 256 {
                    return Err("매핑 키가 너무 깁니다.".into());
                }
                validate_mapping(child, depth + 1)?;
            }
        }
        Value::Array(array) => {
            if array.len() > 4096 {
                return Err("매핑 항목이 너무 많습니다.".into());
            }
            for child in array {
                validate_mapping(child, depth + 1)?;
            }
        }
        Value::String(s) if s.len() > 1024 => return Err("매핑 문자열이 너무 깁니다.".into()),
        Value::Number(n) if n.as_f64().is_none_or(|v| !v.is_finite()) => {
            return Err("매핑 숫자가 유효하지 않습니다.".into())
        }
        _ => (),
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = File::create(&temp).map_err(io_error)?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(io_error)?)
        .map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    // Windows rename cannot replace an existing target. The old file is retained as a backup until the write succeeds.
    let backup = path.with_extension("json.previous");
    if path.exists() {
        fs::rename(path, &backup).map_err(io_error)?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(io_error(error));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn snapshot_folder(
    source: &Path,
    staging: &Path,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let source = source.canonicalize().map_err(io_error)?;
    let mut pending = vec![source.clone()];
    let mut count = 0;
    let mut total = 0u64;
    let mut names = HashSet::new();
    let mut skipped = 0;
    while let Some(folder) = pending.pop() {
        for item in fs::read_dir(folder).map_err(io_error)? {
            let item = item.map_err(io_error)?;
            count += 1;
            if count > MAX_FILES {
                return Err(format!(
                    "모델 폴더의 파일/폴더가 {MAX_FILES}개를 초과합니다."
                ));
            }
            let meta = fs::symlink_metadata(item.path()).map_err(io_error)?;
            if meta.file_type().is_symlink() {
                return Err("모델 폴더의 심볼릭 링크는 허용하지 않습니다.".into());
            }
            let relative = item
                .path()
                .strip_prefix(&source)
                .map_err(io_error)?
                .to_path_buf();
            let name = relative_string(&relative)?;
            safe_relative(&name)?;
            if !names.insert(name.to_lowercase()) {
                return Err("대소문자만 다른 중복 경로가 있습니다.".into());
            }
            if meta.is_dir() {
                pending.push(item.path());
                continue;
            }
            if !meta.is_file() {
                return Err("모델 폴더의 특수 파일은 허용하지 않습니다.".into());
            }
            total = total
                .checked_add(meta.len())
                .ok_or("모델 폴더 크기가 너무 큽니다.")?;
            if total > MAX_TOTAL_BYTES || meta.len() > MAX_FILE_BYTES {
                return Err("모델 폴더 크기 제한을 초과했습니다.".into());
            }
            if !data_extension(&relative) {
                skipped += 1;
                continue;
            }
            let checked = checked_file(&source, &relative)?;
            let bytes = read_limited(&checked, MAX_FILE_BYTES)?;
            let destination = staging.join(relative);
            fs::create_dir_all(destination.parent().ok_or("잘못된 경로입니다.")?)
                .map_err(io_error)?;
            fs::write(destination, bytes).map_err(io_error)?;
        }
    }
    if skipped > 0 {
        warnings.push(format!(
            "실행 파일·스크립트·편집 원본 등 {skipped}개 파일은 가져오지 않았습니다."
        ));
    }
    Ok(())
}

fn snapshot_zip(source: &Path, staging: &Path, warnings: &mut Vec<String>) -> Result<(), String> {
    if fs::symlink_metadata(source).map_err(io_error)?.len() > MAX_TOTAL_BYTES {
        return Err("ZIP 파일이 너무 큽니다.".into());
    }
    let mut archive =
        zip::ZipArchive::new(File::open(source).map_err(io_error)?).map_err(io_error)?;
    if archive.len() > MAX_FILES {
        return Err(format!("ZIP 항목이 {MAX_FILES}개를 초과합니다."));
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    let mut skipped = 0;
    let mut plans = Vec::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(io_error)?;
        let name = file.name().trim_end_matches('/');
        let relative = safe_relative(name)?;
        if !names.insert(name.to_lowercase()) {
            return Err("ZIP에 중복되거나 대소문자만 다른 경로가 있습니다.".into());
        }
        if let Some(mode) = file.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err("ZIP의 심볼릭 링크·특수 파일은 허용하지 않습니다.".into());
            }
        }
        total = total
            .checked_add(file.size())
            .ok_or("ZIP 해제 크기가 너무 큽니다.")?;
        if total > MAX_TOTAL_BYTES || file.size() > MAX_FILE_BYTES {
            return Err("ZIP 해제 크기 제한을 초과했습니다.".into());
        }
        if file.is_dir() {
            continue;
        }
        if !data_extension(&relative) {
            skipped += 1;
            continue;
        }
        plans.push((index, relative, file.size()));
    }
    // Check every central-directory entry before writing any extracted bytes, then
    // independently enforce actual output size while reading each decompressor.
    let mut actual_total = 0u64;
    for (index, relative, expected) in plans {
        let mut file = archive.by_index(index).map_err(io_error)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 > MAX_FILE_BYTES || bytes.len() as u64 != expected {
            return Err("ZIP 실제 해제 크기가 기록과 다르거나 한도를 초과합니다.".into());
        }
        actual_total = actual_total
            .checked_add(bytes.len() as u64)
            .ok_or("ZIP 실제 해제 크기가 너무 큽니다.")?;
        if actual_total > MAX_TOTAL_BYTES {
            return Err("ZIP 실제 총 해제 크기 제한을 초과했습니다.".into());
        }
        let destination = staging.join(relative);
        fs::create_dir_all(destination.parent().ok_or("잘못된 경로입니다.")?).map_err(io_error)?;
        fs::write(destination, bytes).map_err(io_error)?;
    }
    if skipped > 0 {
        warnings.push(format!(
            "실행 파일·스크립트·편집 원본 등 {skipped}개 파일은 가져오지 않았습니다."
        ));
    }
    Ok(())
}

fn collect_entrypoints(root: &Path, folder: &Path, output: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(folder).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if entry.file_type().map_err(io_error)?.is_dir() {
            collect_entrypoints(root, &entry.path(), output)?;
        } else if entry
            .file_name()
            .to_string_lossy()
            .ends_with(".model3.json")
        {
            output.push(relative_string(
                entry.path().strip_prefix(root).map_err(io_error)?,
            )?);
        }
    }
    Ok(())
}

fn validate_model(
    root: &Path,
    entrypoint: &str,
) -> Result<(BTreeSet<String>, ModelCapabilities, Value), String> {
    if !entrypoint.ends_with(".model3.json") {
        return Err(".model3.json 진입점이 필요합니다.".into());
    }
    let relative = safe_relative(entrypoint)?;
    let bytes = read_limited(&checked_file(root, &relative)?, MAX_JSON_BYTES)?;
    let model: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("모델 JSON이 손상되었습니다: {e}"))?;
    if model.get("Version").and_then(Value::as_u64) != Some(3) {
        return Err("지원하지 않는 model3.json 버전입니다 (Version 3 필요).".into());
    }
    reject_external_references(&model)?;
    let references = model
        .get("FileReferences")
        .and_then(Value::as_object)
        .ok_or("FileReferences가 없습니다.")?;
    let moc = references
        .get("Moc")
        .and_then(Value::as_str)
        .ok_or("필수 .moc3 참조가 없습니다.")?;
    let textures = references
        .get("Textures")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or("필수 텍스처 참조가 없습니다.")?;
    if textures.len() > 32 {
        return Err("텍스처 개수가 32개를 초과합니다.".into());
    }
    let parent = relative.parent().unwrap_or(Path::new(""));
    let mut assets = BTreeSet::from([entrypoint.to_owned()]);
    {
        let mut add = |reference: &str, expected_suffix: Option<&str>| -> Result<PathBuf, String> {
            let reference_path = safe_relative(reference)?;
            if let Some(suffix) = expected_suffix {
                if !reference.to_ascii_lowercase().ends_with(suffix) {
                    return Err(format!(
                        "자산 형식이 잘못되었습니다: {reference} ({suffix} 필요)"
                    ));
                }
            }
            let path = parent.join(reference_path);
            let name = relative_string(&path)?;
            if matches!(
                name.as_str(),
                "manifest.json"
                    | "mapping.json"
                    | "manifest.json.previous"
                    | "mapping.json.previous"
            ) {
                return Err("앱 메타데이터 파일 이름은 모델 자산으로 사용할 수 없습니다.".into());
            }
            if !data_extension(&path) {
                return Err(format!("실행할 수 없는 자산 참조입니다: {reference}"));
            }
            let file = checked_file(root, &path)
                .map_err(|_| format!("참조 파일이 없거나 안전하지 않습니다: {reference}"))?;
            if fs::metadata(&file).map_err(io_error)?.len() > MAX_FILE_BYTES {
                return Err("모델 자산 크기 제한을 초과했습니다.".into());
            }
            if file.extension().and_then(|s| s.to_str()) == Some("json") {
                let value: Value = serde_json::from_slice(&read_limited(&file, MAX_JSON_BYTES)?)
                    .map_err(|_| format!("자산 JSON이 손상되었습니다: {reference}"))?;
                if !value.is_object() {
                    return Err(format!("자산 JSON 객체가 필요합니다: {reference}"));
                }
                reject_external_references(&value)?;
            }
            assets.insert(name);
            Ok(file)
        };
        let moc_path = add(moc, Some(".moc3"))?;
        let mut header = [0u8; 4];
        File::open(&moc_path)
            .map_err(io_error)?
            .read_exact(&mut header)
            .map_err(|_| "MOC3 파일이 잘렸습니다.")?;
        if &header != b"MOC3" {
            return Err("MOC3 파일 헤더가 유효하지 않습니다.".into());
        }
        for texture in textures {
            let name = texture.as_str().ok_or("텍스처 경로가 문자열이 아닙니다.")?;
            let path = add(name, None)?;
            if !matches!(
                path.extension()
                    .and_then(|s| s.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("png" | "jpg" | "jpeg")
            ) {
                return Err("텍스처는 PNG/JPEG여야 합니다.".into());
            }
            let (width, height) = image::image_dimensions(&path)
                .map_err(|_| format!("텍스처가 손상되었습니다: {name}"))?;
            if width == 0
                || height == 0
                || width > MAX_TEXTURE_SIDE
                || height > MAX_TEXTURE_SIDE
                || u64::from(width) * u64::from(height) > MAX_TEXTURE_PIXELS
            {
                return Err(format!(
                    "텍스처 크기 제한을 초과했습니다: {name} ({width}×{height})"
                ));
            }
            let mut reader = image::ImageReader::open(&path)
                .map_err(io_error)?
                .with_guessed_format()
                .map_err(io_error)?;
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(MAX_TEXTURE_SIDE);
            limits.max_image_height = Some(MAX_TEXTURE_SIDE);
            limits.max_alloc = Some(MAX_TEXTURE_PIXELS * 8);
            reader.limits(limits);
            reader.decode().map_err(|_| {
                format!("텍스처 데이터가 손상되었거나 디코딩 한도를 초과했습니다: {name}")
            })?;
        }
    }
    let mut clean_references = references.clone();
    let mut warnings =
        vec!["Core 정합성·버전 검사와 실제 파라미터 미리보기가 아직 필요합니다.".to_owned()];
    for (key, suffix) in [
        ("Physics", ".physics3.json"),
        ("Pose", ".pose3.json"),
        ("DisplayInfo", ".cdi3.json"),
        ("UserData", ".userdata3.json"),
        ("MotionSync", ".motionsync3.json"),
    ] {
        if let Some(value) = references.get(key) {
            if !optional_asset(
                root,
                parent,
                value,
                Some(suffix),
                &mut assets,
                &mut warnings,
            )? {
                clean_references.remove(key);
            }
        }
    }
    let mut expressions = Vec::new();
    if let Some(value) = references.get("Expressions") {
        let mut valid = Vec::new();
        if let Some(items) = value.as_array() {
            for item in items {
                let reference = item.get("File").unwrap_or(&Value::Null);
                // Check even a malformed entry's path before deciding it is optional.
                let accepted = optional_asset(
                    root,
                    parent,
                    reference,
                    Some(".exp3.json"),
                    &mut assets,
                    &mut warnings,
                )?;
                let name = item.get("Name").and_then(Value::as_str);
                if accepted && name.is_some_and(|n| !n.is_empty() && n.len() <= 512) {
                    expressions.push(name.unwrap().to_owned());
                    valid.push(item.clone());
                } else if accepted {
                    warnings.push("이름이 없는 표정 연결을 제외했습니다.".into());
                }
            }
        } else {
            warnings.push("손상된 Expressions 목록을 제외했습니다.".into());
        }
        clean_references.insert("Expressions".into(), Value::Array(valid));
    }
    let mut motions = Vec::new();
    if let Some(value) = references.get("Motions") {
        let mut valid_groups = serde_json::Map::new();
        if let Some(groups) = value.as_object() {
            for (group, value) in groups {
                let mut valid = Vec::new();
                if let Some(items) = value.as_array() {
                    for item in items {
                        let mut cleaned = item.clone();
                        let motion_ok = optional_asset(
                            root,
                            parent,
                            item.get("File").unwrap_or(&Value::Null),
                            Some(".motion3.json"),
                            &mut assets,
                            &mut warnings,
                        )?;
                        if let Some(sound) = item.get("Sound") {
                            let sound_ok = optional_asset(
                                root,
                                parent,
                                sound,
                                None,
                                &mut assets,
                                &mut warnings,
                            )?;
                            if !sound_ok {
                                if let Some(object) = cleaned.as_object_mut() {
                                    object.remove("Sound");
                                }
                            }
                        }
                        if motion_ok {
                            valid.push(cleaned);
                        }
                    }
                } else {
                    warnings.push(format!("손상된 모션 그룹을 제외했습니다: {group}"));
                }
                if !valid.is_empty() {
                    motions.push(group.clone());
                    valid_groups.insert(group.clone(), Value::Array(valid));
                }
            }
        } else {
            warnings.push("손상된 Motions 목록을 제외했습니다.".into());
        }
        clean_references.insert("Motions".into(), Value::Object(valid_groups));
    }
    // Future/unknown file reference schemas are not silently copied or executed.
    for key in references.keys() {
        if ![
            "Moc",
            "Textures",
            "Physics",
            "Pose",
            "DisplayInfo",
            "UserData",
            "MotionSync",
            "Expressions",
            "Motions",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("지원하지 않는 자산 참조 항목입니다: {key}"));
        }
    }
    let groups = model.get("Groups").and_then(Value::as_array);
    let group_ids = |name: &str| -> Vec<String> {
        groups
            .map(|groups| {
                groups
                    .iter()
                    .filter(|g| g.get("Name").and_then(Value::as_str) == Some(name))
                    .flat_map(|g| g.get("Ids").and_then(Value::as_array).into_iter().flatten())
                    .filter_map(Value::as_str)
                    .take(1024)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    if expressions.is_empty() {
        warnings
            .push("표정 파일 없음: 실제 파라미터를 수동 연결해 가능한 감정을 미리보세요.".into());
    }
    if !clean_references.contains_key("Physics") {
        warnings.push("물리 설정 없음: 머리카락·장식 물리는 미지원입니다.".into());
    }
    if !clean_references.contains_key("MotionSync") {
        warnings.push("MotionSync 없음: 음량 기반 입 개폐로 동작합니다.".into());
    }
    let capabilities = ModelCapabilities {
        expressions,
        motions,
        physics: clean_references.contains_key("Physics"),
        pose: clean_references.contains_key("Pose"),
        motion_sync: clean_references.contains_key("MotionSync"),
        eye_blink_candidates: group_ids("EyeBlink"),
        lip_sync_candidates: group_ids("LipSync"),
        warnings,
    };
    let mut definition = model.clone();
    definition["FileReferences"] = Value::Object(clean_references);
    Ok((assets, capabilities, definition))
}

/// Only missing/malformed optional data degrades. Unsafe paths, links and external references
/// remain fatal even when a caller will not use that optional feature.
fn optional_asset(
    root: &Path,
    parent: &Path,
    value: &Value,
    suffix: Option<&str>,
    assets: &mut BTreeSet<String>,
    warnings: &mut Vec<String>,
) -> Result<bool, String> {
    let Some(reference) = value.as_str() else {
        warnings.push("문자열 경로가 아닌 선택 자산을 제외했습니다.".into());
        return Ok(false);
    };
    let path = parent.join(safe_relative(reference)?);
    let name = relative_string(&path)?;
    if matches!(
        name.as_str(),
        "manifest.json" | "mapping.json" | "manifest.json.previous" | "mapping.json.previous"
    ) || !data_extension(&path)
    {
        return Err(format!("허용하지 않는 선택 자산 경로입니다: {reference}"));
    }
    let mut current = root.to_path_buf();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("선택 자산의 심볼릭 링크는 허용하지 않습니다.".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                warnings.push(format!(
                    "선택 자산 누락으로 기능을 제외했습니다: {reference}"
                ));
                return Ok(false);
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    let file = checked_file(root, &path)?;
    let data = read_limited(
        &file,
        if suffix.is_some() {
            MAX_JSON_BYTES
        } else {
            MAX_FILE_BYTES
        },
    )?;
    let parsed = if file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        match serde_json::from_slice::<Value>(&data) {
            Ok(value) => {
                reject_external_references(&value)?;
                Some(value)
            }
            Err(_) => {
                warnings.push(format!(
                    "선택 JSON 손상으로 기능을 제외했습니다: {reference}"
                ));
                return Ok(false);
            }
        }
    } else {
        None
    };
    if suffix.is_some_and(|s| !reference.to_ascii_lowercase().ends_with(s))
        || !optional_schema(parsed.as_ref(), suffix)
    {
        warnings.push(format!(
            "선택 자산 구조/형식 오류로 기능을 제외했습니다: {reference}"
        ));
        return Ok(false);
    }
    assets.insert(name);
    Ok(true)
}

fn optional_schema(value: Option<&Value>, suffix: Option<&str>) -> bool {
    let Some(suffix) = suffix else {
        return true;
    };
    let Some(value) = value.filter(|v| v.is_object()) else {
        return false;
    };
    let array = |key: &str| value.get(key).and_then(Value::as_array);
    match suffix {
        ".exp3.json" => array("Parameters").is_some_and(|items| {
            items.len() <= 4096
                && items.iter().all(|p| {
                    p.get("Id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty() && id.len() <= 512)
                        && p.get("Value")
                            .and_then(Value::as_f64)
                            .is_some_and(f64::is_finite)
                        && p.get("Blend").is_none_or(|b| {
                            matches!(b.as_str(), Some("Add" | "Multiply" | "Overwrite"))
                        })
                })
        }),
        ".physics3.json" => {
            value.get("Version").and_then(Value::as_u64) == Some(3)
                && value.get("Meta").is_some_and(Value::is_object)
                && array("PhysicsSettings").is_some_and(|a| {
                    a.len() <= 4096
                        && a.iter().all(|s| {
                            ["Input", "Output", "Vertices"]
                                .iter()
                                .all(|key| s.get(key).is_some_and(Value::is_array))
                                && s.get("Normalization").is_some_and(Value::is_object)
                        })
                })
        }
        ".pose3.json" => array("Groups").is_some_and(|groups| {
            groups.len() <= 4096
                && groups.iter().all(|g| {
                    g.as_array().is_some_and(|items| {
                        !items.is_empty()
                            && items.iter().all(|p| {
                                p.get("Id")
                                    .and_then(Value::as_str)
                                    .is_some_and(|id| !id.is_empty())
                                    && p.get("Link").is_none_or(|v| {
                                        v.as_array()
                                            .is_some_and(|links| links.iter().all(Value::is_string))
                                    })
                            })
                    })
                })
        }),
        ".motion3.json" => {
            value.get("Version").and_then(Value::as_u64) == Some(3)
                && value.get("Meta").is_some_and(Value::is_object)
                && array("Curves").is_some()
        }
        ".motionsync3.json" => {
            value.get("Version").and_then(Value::as_u64) == Some(1)
                && array("Settings").is_some_and(|a| !a.is_empty() && a.len() <= 16)
        }
        ".cdi3.json" => {
            array("Parameters").is_some()
                || array("Parts").is_some()
                || array("ParameterGroups").is_some()
        }
        ".userdata3.json" => array("UserData").is_some(),
        _ => false,
    }
}

fn reject_external_references(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "File"
                        | "Sound"
                        | "Moc"
                        | "Physics"
                        | "Pose"
                        | "DisplayInfo"
                        | "UserData"
                        | "MotionSync"
                ) {
                    if let Some(reference) = child.as_str() {
                        safe_relative(reference)?;
                    }
                }
                reject_external_references(child)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                reject_external_references(child)?;
            }
        }
        _ => (),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("ouento-model-test-{}", Uuid::new_v4()));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(root: &Path) {
        fs::write(root.join("test.moc3"), b"MOC3test-only-header").unwrap();
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 255, 255, 255]))
            .save(root.join("texture.png"))
            .unwrap();
        fs::write(
            root.join("test.model3.json"),
            br#"{"Version":3,"FileReferences":{"Moc":"test.moc3","Textures":["texture.png"]}}"#,
        )
        .unwrap();
    }
    #[test]
    fn paths_are_portable_and_confined() {
        for path in [
            "../bad",
            "a/../bad",
            "/bad",
            "C:/bad",
            "https://a/b",
            "a\\bad",
            "a%2fb",
            "a//b",
            "a/./b",
            "NUL.json",
            "folder/COM1",
            "a.",
        ] {
            assert!(safe_relative(path).is_err(), "{path}");
        }
        assert!(safe_relative("表情/happy.exp3.json").is_ok());
    }
    #[test]
    fn copies_only_referenced_assets_and_isolates_mapping() {
        let input = Temp::new();
        let managed = Temp::new();
        fixture(&input.0);
        fs::write(input.0.join("evil.js"), "alert('never run')").unwrap();
        fs::write(input.0.join("unrelated.json"), "{}").unwrap();
        let store = ModelStore::new(managed.0.clone()).unwrap();
        let inspect = store.inspect_source(&input.0).unwrap();
        assert_eq!(inspect.candidates.len(), 1);
        assert!(inspect.candidates[0].valid);
        assert_eq!(inspect.warnings.len(), 1);
        let model = store.import(&inspect.token, "test.model3.json").unwrap();
        assert_eq!(model.assets.len(), 3);
        assert!(model.requires_core_validation);
        assert!(store.read_asset(&model.id, "test.moc3").is_ok());
        assert!(store.read_asset(&model.id, "unrelated.json").is_err());
        assert!(store.read_asset(&model.id, "../manifest.json").is_err());
        store
            .save_mapping(&model.id, serde_json::json!({"mouthOpen":"CustomMouth"}))
            .unwrap();
        assert_eq!(
            store.load_mapping(&model.id).unwrap()["mouthOpen"],
            "CustomMouth"
        );
        store
            .save_mapping(&model.id, serde_json::json!({"mouthOpen":"Second"}))
            .unwrap();
        assert_eq!(
            store.load_mapping(&model.id).unwrap()["mouthOpen"],
            "Second"
        );
        store.remove(&model.id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }
    #[test]
    fn multiple_models_require_entrypoint_and_missing_assets_are_separate() {
        let input = Temp::new();
        let managed = Temp::new();
        fixture(&input.0);
        fs::write(
            input.0.join("bad.model3.json"),
            br#"{"Version":3,"FileReferences":{"Moc":"absent.moc3","Textures":["texture.png"]}}"#,
        )
        .unwrap();
        let store = ModelStore::new(managed.0.clone()).unwrap();
        let inspect = store.inspect_source(&input.0).unwrap();
        assert_eq!(inspect.candidates.len(), 2);
        assert_eq!(inspect.candidates.iter().filter(|c| c.valid).count(), 1);
        assert!(store.import(&inspect.token, "bad.model3.json").is_err());
        assert!(store.import(&inspect.token, "test.model3.json").is_ok());
    }
    #[test]
    fn external_reference_is_rejected() {
        let input = Temp::new();
        fixture(&input.0);
        fs::write(input.0.join("test.model3.json"),br#"{"Version":3,"FileReferences":{"Moc":"https://host/a.moc3","Textures":["texture.png"]}}"#).unwrap();
        assert!(validate_model(&input.0, "test.model3.json").is_err());
    }
    #[test]
    fn zip_traversal_is_rejected_before_writing() {
        let input = Temp::new();
        let managed = Temp::new();
        let zip_path = input.0.join("bad.zip");
        let mut archive = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        archive
            .start_file(
                "../escape.model3.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"{}").unwrap();
        archive.finish().unwrap();
        let store = ModelStore::new(managed.0.clone()).unwrap();
        assert!(store.inspect_source(&zip_path).is_err());
        assert_eq!(fs::read_dir(managed.0.join(".staging")).unwrap().count(), 0);
    }
    #[test]
    fn zip_file_limit_and_case_collision_are_rejected() {
        let input = Temp::new();
        let managed = Temp::new();
        let path = input.0.join("dupe.zip");
        let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
        for name in ["A.json", "a.json"] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(b"{}").unwrap();
        }
        archive.finish().unwrap();
        let store = ModelStore::new(managed.0.clone()).unwrap();
        assert!(store.inspect_source(&path).is_err());
        let path = input.0.join("many.zip");
        let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
        for i in 0..=MAX_FILES {
            archive
                .start_file(
                    format!("{i}.json"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
        }
        archive.finish().unwrap();
        assert!(store.inspect_source(&path).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_outside_folder_is_rejected() {
        let input = Temp::new();
        let outside = Temp::new();
        let managed = Temp::new();
        fixture(&input.0);
        fs::write(outside.0.join("secret"), b"private").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret"), input.0.join("link.json")).unwrap();
        assert!(ModelStore::new(managed.0.clone())
            .unwrap()
            .inspect_source(&input.0)
            .is_err());
    }
    #[test]
    fn missing_optional_files_are_not_required() {
        let input = Temp::new();
        fixture(&input.0);
        let (_, caps, _) = validate_model(&input.0, "test.model3.json").unwrap();
        assert!(!caps.physics);
        assert!(!caps.motion_sync);
        assert!(!caps.warnings.is_empty());
    }

    #[test]
    fn damaged_optional_assets_are_removed_from_manifest_and_preview() {
        let input = Temp::new();
        let managed = Temp::new();
        fixture(&input.0);
        fs::write(input.0.join("broken.pose3.json"), b"{").unwrap();
        fs::write(input.0.join("bad.exp3.json"), br#"{"Parameters":{}}"#).unwrap();
        fs::write(
            input.0.join("good.exp3.json"),
            br#"{"Parameters":[{"Id":"ParamMouthOpenY","Value":1,"Blend":"Overwrite"}]}"#,
        )
        .unwrap();
        fs::write(
            input.0.join("idle.motion3.json"),
            br#"{"Version":3,"Meta":{},"Curves":[]}"#,
        )
        .unwrap();
        fs::write(input.0.join("unrelated.json"), b"{}").unwrap();
        fs::write(input.0.join("test.model3.json"), br#"{"Version":3,"FileReferences":{"Moc":"test.moc3","Textures":["texture.png"],"Physics":"missing.physics3.json","Pose":"broken.pose3.json","Expressions":[{"Name":"bad","File":"bad.exp3.json"},{"Name":"good","File":"good.exp3.json"}],"Motions":{"Idle":[{"File":"idle.motion3.json","Sound":"absent.wav"}]}}}"#).unwrap();
        let store = ModelStore::new(managed.0.clone()).unwrap();
        let inspect = store.inspect_source(&input.0).unwrap();
        assert!(inspect.candidates[0].valid);
        let preview: Value = serde_json::from_slice(
            &store
                .read_import_asset(&inspect.token, "test.model3.json", "test.model3.json")
                .unwrap(),
        )
        .unwrap();
        assert!(preview["FileReferences"].get("Physics").is_none());
        assert!(preview["FileReferences"].get("Pose").is_none());
        assert_eq!(
            preview["FileReferences"]["Expressions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(preview["FileReferences"]["Motions"]["Idle"][0]
            .get("Sound")
            .is_none());
        assert!(store
            .read_import_asset(&inspect.token, "test.model3.json", "unrelated.json")
            .is_err());
        assert!(store
            .read_import_asset(&inspect.token, "test.model3.json", "bad.exp3.json")
            .is_err());
        let imported = store.import(&inspect.token, "test.model3.json").unwrap();
        assert!(!imported.capabilities.physics && !imported.capabilities.pose);
        assert_eq!(imported.capabilities.expressions, vec!["good"]);
        assert_eq!(imported.assets.len(), 5);
        assert!(imported.capabilities.warnings.len() >= 4);
        let committed: Value =
            serde_json::from_slice(&store.read_asset(&imported.id, "test.model3.json").unwrap())
                .unwrap();
        assert_eq!(preview, committed);
    }

    #[test]
    fn unsafe_optional_references_remain_fatal() {
        let input = Temp::new();
        fixture(&input.0);
        for reference in [
            "../missing.physics3.json",
            "https://example.test/a.physics3.json",
            "evil.js",
        ] {
            fs::write(input.0.join("test.model3.json"), serde_json::to_vec(&serde_json::json!({"Version":3,"FileReferences":{"Moc":"test.moc3","Textures":["texture.png"],"Physics":reference}})).unwrap()).unwrap();
            assert!(
                validate_model(&input.0, "test.model3.json").is_err(),
                "{reference}"
            );
        }
        fs::write(input.0.join("test.model3.json"), br#"{"Version":3,"FileReferences":{"Moc":"test.moc3","Textures":["texture.png"],"Pose":"unsafe.pose3.json"}}"#).unwrap();
        fs::write(
            input.0.join("unsafe.pose3.json"),
            br#"{"File":"https://example.test/external","Groups":{}}"#,
        )
        .unwrap();
        assert!(validate_model(&input.0, "test.model3.json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn cached_preview_still_rejects_replaced_asset_links() {
        let input = Temp::new();
        let managed = Temp::new();
        let outside = Temp::new();
        fixture(&input.0);
        fs::write(outside.0.join("private.png"), b"outside").unwrap();
        let store = ModelStore::new(managed.0.clone()).unwrap();
        let inspect = store.inspect_source(&input.0).unwrap();
        store
            .read_import_asset(&inspect.token, "test.model3.json", "test.model3.json")
            .unwrap();
        let texture = managed
            .0
            .join(".staging")
            .join(&inspect.token)
            .join("texture.png");
        fs::remove_file(&texture).unwrap();
        std::os::unix::fs::symlink(outside.0.join("private.png"), texture).unwrap();
        assert!(store
            .read_import_asset(&inspect.token, "test.model3.json", "texture.png")
            .is_err());
        assert!(store.import(&inspect.token, "test.model3.json").is_err());
        store.discard_inspection(&inspect.token).unwrap();
        assert!(store
            .read_import_asset(&inspect.token, "test.model3.json", "test.model3.json")
            .is_err());
    }

    #[test]
    fn optional_expression_schema_does_not_admit_nan_inputs_or_unknown_blends() {
        for value in [
            serde_json::json!({"Parameters":{}}),
            serde_json::json!({"Parameters":[{"Id":"ParamX","Value":"bad"}]}),
            serde_json::json!({"Parameters":[{"Id":"ParamX","Value":1,"Blend":"Run"}]}),
        ] {
            assert!(!optional_schema(Some(&value), Some(".exp3.json")));
        }
        assert!(optional_schema(
            Some(&serde_json::json!({"Parameters":[{"Id":"ParamX","Value":1}]})),
            Some(".exp3.json")
        ));
        assert!(optional_schema(
            Some(&serde_json::json!({"Version":1,"Settings":[{}]})),
            Some(".motionsync3.json")
        ));
    }

    #[test]
    fn oversized_file_is_rejected_without_reading_it() {
        let input = Temp::new();
        let managed = Temp::new();
        fixture(&input.0);
        File::create(input.0.join("too-large.moc3"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(ModelStore::new(managed.0.clone())
            .unwrap()
            .inspect_source(&input.0)
            .is_err());
    }
    #[test]
    fn oversized_or_truncated_texture_is_rejected() {
        let input = Temp::new();
        fixture(&input.0);
        image::RgbaImage::from_pixel(MAX_TEXTURE_SIDE + 1, 1, image::Rgba([0, 0, 0, 255]))
            .save(input.0.join("texture.png"))
            .unwrap();
        assert!(validate_model(&input.0, "test.model3.json")
            .unwrap_err()
            .contains("텍스처 크기"));
        fixture(&input.0);
        let path = input.0.join("texture.png");
        let data = fs::read(&path).unwrap();
        fs::write(path, &data[..33]).unwrap();
        assert!(validate_model(&input.0, "test.model3.json").is_err());
    }
    #[test]
    fn zip_symlink_is_rejected() {
        let input = Temp::new();
        let managed = Temp::new();
        let path = input.0.join("link.zip");
        let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
        archive
            .add_symlink(
                "link.json",
                "/private/secret",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.finish().unwrap();
        assert!(ModelStore::new(managed.0.clone())
            .unwrap()
            .inspect_source(&path)
            .is_err());
    }
    #[test]
    fn unsupported_model_version_and_broken_moc_are_rejected() {
        let input = Temp::new();
        fixture(&input.0);
        fs::write(input.0.join("test.moc3"), b"BAD!").unwrap();
        assert!(validate_model(&input.0, "test.model3.json").is_err());
        fixture(&input.0);
        fs::write(
            input.0.join("test.model3.json"),
            br#"{"Version":4,"FileReferences":{"Moc":"test.moc3","Textures":["texture.png"]}}"#,
        )
        .unwrap();
        assert!(validate_model(&input.0, "test.model3.json")
            .unwrap_err()
            .contains("버전"));
    }
}
