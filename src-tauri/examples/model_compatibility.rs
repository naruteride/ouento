//! Development-only exercise of the product importer. Never opens the application's data store.
//! Run through scripts/check-import-compatibility.mjs for source/output SHA-256 provenance.
use ouento_lib::models::{safe_relative, ModelStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

type Assets = BTreeMap<String, Vec<u8>>;
const OUTPUT: &str = ".cache/model-compatibility";

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathResult {
    status: String,
    stage: String,
    error: Option<String>,
    warnings: Vec<String>,
    entrypoint: Option<String>,
    preview_asset_count: usize,
    asset_count: usize,
    bytes: usize,
    preview_matches_import: bool,
    requires_core_validation: bool,
}

fn io(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn relative_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| "UTF-8 경로가 필요합니다.".into())
}

fn source_files(root: &Path, directory: &Path, files: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(io)? {
        let entry = entry.map_err(io)?;
        let kind = entry.file_type().map_err(io)?;
        if kind.is_symlink() {
            return Err(format!(
                "검사 원본의 링크를 거부했습니다: {:?}",
                entry.path()
            ));
        }
        if kind.is_dir() {
            source_files(root, &entry.path(), files)?;
        } else if kind.is_file() {
            files.push(relative_string(
                entry.path().strip_prefix(root).map_err(io)?,
            )?);
        } else {
            return Err("검사 원본에는 일반 파일만 허용합니다.".into());
        }
    }
    Ok(())
}

/// All generated data stays under the fixed development output; reject links on every component.
fn output_directory(repo: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative != OUTPUT && !relative.starts_with(&format!("{OUTPUT}/")) {
        return Err("검사 출력 폴더 밖 쓰기를 거부했습니다.".into());
    }
    let mut target = repo.to_path_buf();
    for component in safe_relative(relative)?.components() {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err(format!("검사 출력 경로에 링크/파일이 있습니다: {target:?}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&target).map_err(io)?;
            }
            Err(error) => return Err(io(error)),
        }
    }
    Ok(target)
}

fn write_output(repo: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let path = safe_relative(relative)?;
    let parent = relative_string(path.parent().ok_or("출력 부모 폴더가 없습니다.")?)?;
    let directory = output_directory(repo, &parent)?;
    let target = directory.join(path.file_name().ok_or("출력 파일 이름이 없습니다.")?);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("검사 출력 링크/특수 파일을 덮어쓸 수 없습니다.".into());
        }
    }
    fs::write(target, bytes).map_err(io)
}

fn make_zip(repo: &Path, source: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = format!("{OUTPUT}/zips/{name}.zip");
    write_output(repo, &relative, &[])?;
    let target = repo.join(relative);
    let mut writer = ZipWriter::new(File::create(&target).map_err(io)?);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut files = Vec::new();
    source_files(source, source, &mut files)?;
    files.sort();
    for file in files {
        let safe = safe_relative(&file)?;
        writer.start_file(file, options).map_err(io)?;
        writer
            .write_all(&fs::read(source.join(safe)).map_err(io)?)
            .map_err(io)?;
    }
    writer.finish().map_err(io)?;
    Ok(target)
}

fn collect_references(
    value: &Value,
    output: &mut BTreeSet<String>,
    top_level: bool,
) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                // A motion's MotionSync string names a setting (e.g. Vowels_CRI), not a file.
                if matches!(key.as_str(), "File" | "Sound")
                    || (top_level
                        && matches!(
                            key.as_str(),
                            "Moc" | "Physics" | "Pose" | "DisplayInfo" | "UserData" | "MotionSync"
                        ))
                {
                    let reference = value.as_str().ok_or("자산 참조 문자열이 없습니다.")?;
                    safe_relative(reference)?;
                    output.insert(reference.to_owned());
                } else if top_level && key == "Textures" {
                    for texture in value.as_array().ok_or("텍스처 목록이 없습니다.")? {
                        let reference = texture.as_str().ok_or("텍스처 경로가 없습니다.")?;
                        safe_relative(reference)?;
                        output.insert(reference.to_owned());
                    }
                } else {
                    collect_references(value, output, false)?;
                }
            }
        }
        Value::Array(array) => {
            for value in array {
                collect_references(value, output, false)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn exercise(store: &ModelStore, source: &Path, name: &str) -> (PathResult, Option<Assets>) {
    let mut report = PathResult {
        status: "failed".into(),
        stage: "inspect_source".into(),
        ..Default::default()
    };
    let mut inspection_token = None;
    let mut imported_id = None;
    let outcome = (|| -> Result<Assets, String> {
        let inspection = store.inspect_source(source)?;
        inspection_token = Some(inspection.token.clone());
        report.warnings.extend(inspection.warnings);
        if inspection.candidates.len() != 1 {
            return Err(format!(
                "표본의 진입점 개수가 1개가 아닙니다: {}",
                inspection.candidates.len()
            ));
        }
        let candidate = &inspection.candidates[0];
        report.entrypoint = Some(candidate.entrypoint.clone());
        if let Some(capabilities) = &candidate.capabilities {
            report.warnings.extend(capabilities.warnings.clone());
        }
        if !candidate.valid {
            return Err(candidate
                .error
                .clone()
                .unwrap_or_else(|| "검사 실패".into()));
        }
        if candidate.entrypoint != format!("{name}.model3.json") {
            return Err("표본 이름과 진입점이 맞지 않습니다.".into());
        }
        report.stage = "read_import_asset".into();
        let entrypoint = &candidate.entrypoint;
        let definition = store.read_import_asset(&inspection.token, entrypoint, entrypoint)?;
        let json: Value = serde_json::from_slice(&definition).map_err(io)?;
        let mut references = BTreeSet::from([entrypoint.clone()]);
        collect_references(
            json.get("FileReferences").ok_or("FileReferences 없음")?,
            &mut references,
            true,
        )?;
        let mut preview = BTreeMap::new();
        for reference in &references {
            preview.insert(
                reference.clone(),
                store
                    .read_import_asset(&inspection.token, entrypoint, reference)
                    .map_err(|error| format!("{reference}: {error}"))?,
            );
        }
        report.preview_asset_count = preview.len();
        report.stage = "import".into();
        let imported = store.import(&inspection.token, entrypoint)?;
        imported_id = Some(imported.id.clone());
        report.requires_core_validation = imported.requires_core_validation;
        if imported.assets.iter().cloned().collect::<BTreeSet<_>>() != references {
            return Err("정제 JSON 참조와 저장된 manifest 자산 목록이 다릅니다.".into());
        }
        report.stage = "read_asset".into();
        let mut assets = BTreeMap::new();
        for reference in &imported.assets {
            let bytes = store.read_asset(&imported.id, reference)?;
            if preview.get(reference) != Some(&bytes) {
                return Err(format!("미리보기와 확정 후 자산이 다릅니다: {reference}"));
            }
            report.bytes += bytes.len();
            assets.insert(reference.clone(), bytes);
        }
        report.asset_count = assets.len();
        report.preview_matches_import = true;
        Ok(assets)
    })();
    // Keep only the product-read render export, never an installed app model or stale staging tree.
    let cleanup = (|| -> Result<(), String> {
        if let Some(id) = imported_id {
            store.remove(&id)?;
        }
        if let Some(token) = inspection_token {
            store.discard_inspection(&token)?;
        }
        Ok(())
    })();
    match outcome.and_then(|assets| cleanup.map(|()| assets)) {
        Ok(assets) => {
            report.status = "passed".into();
            report.stage = "complete".into();
            (report, Some(assets))
        }
        Err(error) => {
            report.error = Some(error);
            (report, None)
        }
    }
}

fn run() -> Result<bool, String> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("저장소 경로 없음")?;
    let store = ModelStore::new(output_directory(repo, &format!("{OUTPUT}/store"))?)?;
    let mut results = Vec::new();
    for (package, names) in [
        (
            "CubismSdkForWeb-5-r.5",
            &[
                "Haru", "Hiyori", "Mao", "Mark", "Natori", "Ren", "Rice", "Wanko",
            ][..],
        ),
        (
            "CubismSdkMotionSyncPluginForWeb-5-r.2",
            &["Kei_basic", "Kei_vowels"][..],
        ),
    ] {
        for name in names {
            println!("제품 가져오기 검사: {name} (folder + ZIP)");
            let source_path = format!(".cache/{package}/Samples/Resources/{name}");
            let source = repo.join(&source_path);
            let render_path = format!("{OUTPUT}/render/{name}");
            let previous_render = output_directory(repo, &render_path)?;
            fs::remove_dir_all(previous_render).map_err(io)?;
            let (folder, folder_assets) = exercise(&store, &source, name);
            let (zip, zip_assets) = match make_zip(repo, &source, name) {
                Ok(path) => exercise(&store, &path, name),
                Err(error) => (
                    PathResult {
                        status: "failed".into(),
                        stage: "create_fixture_zip".into(),
                        error: Some(error),
                        ..Default::default()
                    },
                    None,
                ),
            };
            let mut error = None;
            let mut render = Value::Null;
            if let (Some(folder_assets), Some(zip_assets)) = (folder_assets, zip_assets) {
                if folder_assets != zip_assets {
                    error = Some("폴더와 ZIP 경로의 검증 자산이 다릅니다.".to_owned());
                } else {
                    for (asset, bytes) in &folder_assets {
                        write_output(repo, &format!("{render_path}/{asset}"), bytes)?;
                    }
                    render = json!({
                        "name": name,
                        "url": format!("/{render_path}/{name}.model3.json"),
                        "assetBaseUrl": format!("/{render_path}/"),
                        "assets": folder_assets.iter().map(|(path, data)| json!({"path": path, "bytes": data.len()})).collect::<Vec<_>>()
                    });
                }
            }
            let status = if render.is_null() { "failed" } else { "passed" };
            let warnings = folder
                .warnings
                .iter()
                .chain(&zip.warnings)
                .cloned()
                .collect::<BTreeSet<_>>();
            results.push(json!({
                "name": name,
                "family": if name.starts_with("Kei_") { "Kei" } else { name },
                "source": {"path": source_path, "package": package},
                "zipPath": format!("{OUTPUT}/zips/{name}.zip"),
                "folder": folder,
                "zip": zip,
                "status": status,
                "error": error,
                "warnings": warnings,
                "render": render
            }));
            let catalog = json!({
                "schemaVersion": 1,
                "validation": "product-native-importer-only",
                "limits": "공식 샘플 10묶음·9캐릭터 계열이며 독립 사용자 모델 10개, 브라우저 Core/렌더링 또는 양 OS 배포 앱 검증을 뜻하지 않습니다.",
                "models": results
            });
            write_output(
                repo,
                &format!("{OUTPUT}/catalog.native.json"),
                &serde_json::to_vec_pretty(&catalog).map_err(io)?,
            )?;
            println!("  {name}: {status}");
        }
    }
    Ok(results.iter().all(|result| result["status"] == "passed"))
}

fn main() {
    match run() {
        Ok(true) => {
            println!("폴더·ZIP 20개 제품 가져오기 경로 통과. Core/브라우저 검증은 별도입니다.")
        }
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("모델 호환성 검사 실패: {error}");
            std::process::exit(1);
        }
    }
}
