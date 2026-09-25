mod desktop;
pub mod domain;
pub mod model_metadata;
pub mod models;
pub mod platform;
pub mod providers;
pub mod storage;

use domain::{
    observation::{ObservationPurpose, ObservationRequest, ObservationTarget, RuntimeContext},
    observation_context::{
        validate_native_target, NativeObservationState, ObservationContext, WindowIdentity,
    },
    types::*,
    Backend,
};
use models::ModelStore;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

struct AppState {
    backend: Arc<Backend>,
    models: ModelStore,
    desktop: desktop::DesktopLayout,
    observation_visible: AtomicBool,
    screen_locked: AtomicBool,
    dragging: AtomicBool,
    desired_interactive: AtomicBool,
    observation_approval: Mutex<Option<WindowIdentity>>,
}

#[tauri::command]
fn snapshot(state: State<AppState>) -> Result<Value, String> {
    let (credentials, credential_error) = match state.backend.credential_status() {
        Ok(status) => (status, None),
        Err(error) => (
            providers::CredentialStatus {
                chat: false,
                stt: false,
                tts: false,
            },
            Some(error),
        ),
    };
    Ok(
        json!({"settings":state.backend.settings()?,"memories":state.backend.memories()?,"models":state.models.list()?,"credentials":credentials,"credentialError":credential_error,"platform":platform::capabilities(),"version":env!("CARGO_PKG_VERSION")}),
    )
}
#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: State<AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    settings.validate()?;
    let current = state.backend.settings()?;
    let old_approval = state
        .observation_approval
        .lock()
        .map_err(|_| "관찰 승인 상태를 읽을 수 없습니다.")?
        .clone();
    let approval = if settings.observation.mode == ObservationMode::SelectedWindow {
        let same_selection = current.observation.mode == ObservationMode::SelectedWindow
            && current.observation.selected_window_id == settings.observation.selected_window_id;
        if same_selection {
            Some(old_approval.ok_or("관찰을 중지한 후 창을 다시 선택해 주세요.")?)
        } else {
            let windows = platform::list_windows()?;
            let window = windows
                .iter()
                .find(|window| {
                    Some(window.id.to_string()) == settings.observation.selected_window_id
                })
                .ok_or("함께 볼 창이 닫혔습니다. 창을 다시 선택해 주세요.")?;
            if platform::sensitive_app(
                &window.app_id,
                &window.app_name,
                &settings.observation.blocked_apps,
            ) {
                return Err("민감 앱으로 제외된 창은 선택할 수 없습니다.".into());
            }
            Some(WindowIdentity::from(window))
        }
    } else {
        None
    };
    let settings = state.backend.save_settings(settings)?;
    *state
        .observation_approval
        .lock()
        .map_err(|_| "관찰 승인 상태를 저장할 수 없습니다.")? = approval;
    if let Some(window) = app.get_webview_window("companion") {
        window
            .set_always_on_top(settings.always_on_top)
            .map_err(|e| e.to_string())?;
        if !state.dragging.load(Ordering::Relaxed) {
            state.desktop.reconcile(&window, settings.scale)?;
        }
    }
    app.emit("settings-changed", &settings)
        .map_err(|e| e.to_string())?;
    Ok(settings)
}
#[tauri::command]
async fn chat(state: State<'_, AppState>, text: String) -> Result<ConversationReply, String> {
    state.backend.chat(ChatRequest { text }).await
}
#[tauri::command]
async fn speech(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    utterance_id: String,
    text: String,
) -> Result<AudioReply, String> {
    if state.backend.observation_context(&utterance_id)?.is_none() {
        return state.backend.speech(&utterance_id, &text).await;
    }
    state
        .backend
        .speech_with_validation(&utterance_id, &text, || {
            validate_reply_native_async(app.clone(), state.backend.clone(), utterance_id.clone())
        })
        .await
}
#[tauri::command]
async fn transcribe(
    state: State<'_, AppState>,
    audio: Vec<u8>,
    mime_type: String,
) -> Result<String, String> {
    state.backend.transcribe(audio, &mime_type).await
}
#[tauri::command]
fn cancel_speech(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<AppState>) {
    state.backend.cancel();
    let _ = app.emit("speech-cancelled", json!({"origin":window.label()}));
}
#[tauri::command]
async fn validate_utterance(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    utterance_id: String,
) -> Result<bool, String> {
    Ok(
        validate_reply_native_async(app, state.backend.clone(), utterance_id)
            .await
            .is_ok(),
    )
}
#[tauri::command]
fn personality_preview(preset: String) -> Result<Reaction, String> {
    domain::personality::preview_personality(&preset)
}
#[tauri::command]
fn save_memory(state: State<AppState>, input: MemoryInput) -> Result<Memory, String> {
    state.backend.save_memory(input)
}
#[tauri::command]
fn delete_memory(state: State<AppState>, id: String) -> Result<(), String> {
    state.backend.delete_memory(&id)
}
#[tauri::command]
fn set_api_key(
    state: State<AppState>,
    kind: providers::ProviderKind,
    key: String,
) -> Result<(), String> {
    state.backend.set_api_key(kind, &key)
}
#[tauri::command]
fn delete_api_key(state: State<AppState>, kind: providers::ProviderKind) -> Result<(), String> {
    state.backend.delete_api_key(kind)
}
#[tauri::command]
async fn inspect_model(
    state: State<'_, AppState>,
    path: String,
) -> Result<models::ImportInspection, String> {
    let store = state.models.clone();
    tauri::async_runtime::spawn_blocking(move || store.inspect_source(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn import_model(
    state: State<'_, AppState>,
    token: String,
    entrypoint: String,
) -> Result<models::ImportedModel, String> {
    let store = state.models.clone();
    tauri::async_runtime::spawn_blocking(move || store.import(&token, &entrypoint))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn discard_import(state: State<AppState>, token: String) -> Result<(), String> {
    state.models.discard_inspection(&token)
}
#[tauri::command]
fn read_model_asset(
    state: State<AppState>,
    id: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(
        state.models.read_asset(&id, &path)?,
    ))
}
#[tauri::command]
async fn read_import_asset(
    state: State<'_, AppState>,
    token: String,
    entrypoint: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let store = state.models.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        store.read_import_asset(&token, &entrypoint, &path)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
fn save_model_metadata(
    state: State<AppState>,
    id: String,
    metadata: model_metadata::ModelMetadata,
) -> Result<(), String> {
    if !BUILTIN_MODEL_IDS.contains(&id.as_str()) {
        state.models.get(&id)?;
    }
    state.backend.save_model_metadata(&id, &metadata)
}
#[tauri::command]
fn get_model_metadata(
    state: State<AppState>,
    id: String,
) -> Result<Option<model_metadata::ModelMetadata>, String> {
    if !BUILTIN_MODEL_IDS.contains(&id.as_str()) {
        state.models.get(&id)?;
    }
    state.backend.model_metadata(&id)
}
#[tauri::command]
fn get_model_mapping(state: State<AppState>, id: String) -> Result<Value, String> {
    if id.starts_with("builtin:") {
        state.backend.builtin_model_mapping(&id)
    } else {
        state.models.load_mapping(&id)
    }
}
#[tauri::command]
fn save_model_mapping(state: State<AppState>, id: String, mapping: Value) -> Result<(), String> {
    if id.starts_with("builtin:") {
        state.backend.save_builtin_model_mapping(&id, mapping)
    } else {
        state.models.save_mapping(&id, mapping)
    }
}
#[tauri::command]
fn switch_model(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: String,
    preserve_identity: bool,
) -> Result<Settings, String> {
    if !BUILTIN_MODEL_IDS.contains(&id.as_str()) {
        state.models.get(&id)?;
    }
    state.backend.reset_character(preserve_identity)?;
    let mut settings = state.backend.settings()?;
    settings.active_model_id = Some(id);
    let settings = state.backend.save_settings(settings)?;
    app.emit("speech-cancelled", json!({"origin":"model"}))
        .map_err(|e| e.to_string())?;
    app.emit("settings-changed", &settings)
        .map_err(|e| e.to_string())?;
    Ok(settings)
}
#[tauri::command]
async fn list_windows() -> Result<Vec<platform::WindowInfo>, String> {
    tauri::async_runtime::spawn_blocking(platform::list_windows)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn request_screen_permission() -> Result<bool, String> {
    platform::request_screen_permission()
}
#[tauri::command]
fn get_platform_capabilities() -> platform::PlatformCapabilities {
    // Refresh OS authorization after returning from System Settings without
    // reloading persisted form values (or opening the credential store).
    platform::capabilities()
}
#[tauri::command]
fn stop_observation(app: tauri::AppHandle, state: State<AppState>) -> Result<Settings, String> {
    let settings = state.backend.stop_observation()?;
    *state
        .observation_approval
        .lock()
        .map_err(|_| "관찰 승인 상태를 지울 수 없습니다.")? = None;
    app.emit("settings-changed", &settings)
        .map_err(|e| e.to_string())?;
    app.emit("observation-stopped", ())
        .map_err(|e| e.to_string())?;
    Ok(settings)
}
#[tauri::command]
async fn analyze_window(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    manual: Option<bool>,
) -> Result<Option<ConversationReply>, String> {
    let purpose = if manual.unwrap_or(false) {
        ObservationPurpose::OnDemand
    } else {
        ObservationPurpose::Proactive
    };
    let _manual = (purpose == ObservationPurpose::OnDemand)
        .then(|| state.backend.on_demand_observation_guard());
    let preparation = state.backend.prepare_observation(purpose)?;
    let backend = state.backend.clone();
    let prepare_app = app.clone();
    let approval = state
        .observation_approval
        .lock()
        .map_err(|_| "관찰 승인 상태를 읽을 수 없습니다.")?
        .clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        preparation.check()?;
        let settings = backend.settings()?;
        if settings.observation.mode == domain::types::ObservationMode::Off
            || !settings.observation.cloud_consent
        {
            return Err("관찰할 창과 전송 동의를 먼저 선택해 주세요.".into());
        }
        if !observation_surface_visible(&prepare_app)
            || platform::activity_snapshot().locked != Some(false)
        {
            return Err("화면 잠금 또는 창 숨김 상태에서는 화면을 분석하지 않습니다.".into());
        }
        preparation.check()?;
        let windows = platform::list_windows()?;
        preparation.check()?;
        let focus = windows.iter().find(|w| w.focused).map(WindowIdentity::from);
        let target = match settings.observation.mode {
            domain::types::ObservationMode::SelectedWindow => windows
                .iter()
                .find(|w| Some(w.id.to_string()) == settings.observation.selected_window_id),
            domain::types::ObservationMode::AllowedApps => windows.iter().find(|w| {
                w.focused
                    && settings
                        .observation
                        .allowed_apps
                        .iter()
                        .any(|app| app.eq_ignore_ascii_case(&w.app_id))
            }),
            _ => None,
        }
        .ok_or("현재 허용 범위에서 볼 수 있는 창이 없습니다.")?;
        let native_target = WindowIdentity::from(target);
        if settings.observation.mode == ObservationMode::SelectedWindow
            && approval.as_ref() != Some(&native_target)
        {
            return Err(
                "허용했던 창이 변경되었습니다. 관찰을 중지한 후 창을 다시 선택해 주세요.".into(),
            );
        }
        // Debounce rapid focus changes before collecting pixels.
        std::thread::sleep(Duration::from_millis(250));
        preparation.check()?;
        let stable_windows = platform::list_windows()?;
        validate_native_target(
            &native_target,
            &focus,
            &stable_windows,
            settings.observation.mode,
        )?;
        let ticket = backend.begin_prepared_observation(
            &preparation,
            ObservationTarget {
                app_id: target.app_id.clone(),
                window_id: target.id.to_string(),
            },
            "",
        )?;
        let context = ObservationContext {
            ticket: ticket.clone(),
            target: native_target,
            focus,
            mode: settings.observation.mode,
        };
        verify_observation_context(&prepare_app, &backend, &context)?;
        backend.validate_observation(&ticket)?;
        preparation.check()?;
        let frame = platform::capture_window(&platform::CaptureRequest {
            window_id: target.id,
            pid: target.pid,
            app_id: target.app_id.clone(),
            consented: settings.observation.cloud_consent,
            excluded_apps: settings.observation.blocked_apps.clone(),
        })?;
        backend.validate_observation(&ticket)?;
        preparation.check()?;
        verify_observation_context(&prepare_app, &backend, &context)?;
        Ok((context, frame))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (context, frame) = prepared;
    let backend = state.backend.clone();
    let watcher_backend = backend.clone();
    let watcher_context = context.clone();
    let watcher_app = app.clone();
    let watcher = async move {
        loop {
            tokio::time::sleep(Duration::from_millis(350)).await;
            let backend = watcher_backend.clone();
            let context = watcher_context.clone();
            let app = watcher_app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                verify_observation_context(&app, &backend, &context)
            })
            .await
            .map_err(|_| "관찰 상태를 확인하지 못했습니다.".to_string())??;
        }
        #[allow(unreachable_code)]
        Ok::<(), String>(())
    };
    let request = ObservationRequest {
        ticket: context.ticket.clone(),
        image_base64: frame.image_base64,
        mime_type: frame.mime_type,
    };
    let cancellation_ticket = context.ticket.clone();
    tokio::select! {
        result=backend.observe(request)=> {
            let reply=result?;
            let verify_backend=backend.clone();
            let verify_context=context.clone();
            let verified=tauri::async_runtime::spawn_blocking(move||verify_observation_context(&app,&verify_backend,&verify_context)).await.map_err(|_|"최종 관찰 대상을 확인하지 못했습니다.".to_string())?;
            if let Err(error)=verified { backend.invalidate_observation_ticket(&cancellation_ticket)?; return Err(error); }
            if let Some(ref reply)=reply { backend.bind_observation_context(&reply.utterance_id, context)?; }
            Ok(reply)
        }
        result=watcher=> {
            backend.invalidate_observation_ticket(&cancellation_ticket)?;
            result?;
            Err("관찰 대상이 변경되어 분석을 중단했습니다.".into())
        }
    }
}

fn observation_surface_visible(app: &tauri::AppHandle) -> bool {
    ["main", "companion"].iter().any(|label| {
        app.get_webview_window(label).is_some_and(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
        })
    })
}
fn verify_native_context(
    app: &tauri::AppHandle,
    backend: &Backend,
    context: &ObservationContext,
) -> Result<(), String> {
    let settings = backend.settings()?;
    let activity = platform::activity_snapshot();
    let facts = NativeObservationState {
        runtime: RuntimeContext {
            typing: activity.typing,
            meeting: settings.meeting_mode,
            screen_locked: activity.locked.unwrap_or(true),
            observation_visible: observation_surface_visible(app),
        },
        screen_permission: platform::screen_permission(),
        windows: platform::list_windows()?,
    };
    // Pure validation: a stale watchdog must never mutate a newer request's runtime.
    context.validate_native(&settings, &facts)
}
fn verify_observation_context(
    app: &tauri::AppHandle,
    backend: &Backend,
    context: &ObservationContext,
) -> Result<(), String> {
    verify_native_context(app, backend, context)?;
    backend.validate_observation_scope(&context.ticket)
}
fn validate_reply_native(
    app: &tauri::AppHandle,
    backend: &Backend,
    utterance_id: &str,
) -> Result<(), String> {
    backend.validate_utterance(utterance_id)?;
    if let Some(context) = backend.observation_context(utterance_id)? {
        let valid = verify_native_context(app, backend, &context)
            .and_then(|()| backend.validate_observation_response_scope(&context.ticket));
        if let Err(error) = valid {
            if backend.invalidate_observation_response(&context.ticket, utterance_id)? {
                let _ = app.emit(
                    "observation-invalidated",
                    json!({"utteranceId":utterance_id}),
                );
            }
            return Err(error);
        }
    }
    backend.validate_utterance(utterance_id)
}
async fn validate_reply_native_async(
    app: tauri::AppHandle,
    backend: Arc<Backend>,
    utterance_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_reply_native(&app, &backend, &utterance_id)
    })
    .await
    .map_err(|_| "발화의 관찰 대상을 확인하지 못했습니다.".to_string())?
}
#[tauri::command]
fn show_companion(app: tauri::AppHandle, reset_position: Option<bool>) -> Result<(), String> {
    let w = app
        .get_webview_window("companion")
        .ok_or("캐릭터 창이 없습니다.")?;
    let state = app.state::<AppState>();
    let scale = state.backend.settings()?.scale;
    if reset_position.unwrap_or(false) {
        state.desktop.reset_position(&w, scale)?;
    } else {
        state.desktop.reconcile(&w, scale)?;
    }
    w.show().map_err(|e| e.to_string())?;
    app.emit("companion-visibility", json!({"visible":true}))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn is_companion_visible(app: tauri::AppHandle) -> Result<bool, String> {
    match app.get_webview_window("companion") {
        Some(window) => Ok(window.is_visible().map_err(|e| e.to_string())?
            && !window.is_minimized().map_err(|e| e.to_string())?),
        None => Ok(false),
    }
}
#[tauri::command]
fn show_settings(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or("설정 창이 없습니다.")?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
fn set_interactive(
    app: tauri::AppHandle,
    state: State<AppState>,
    interactive: bool,
) -> Result<(), String> {
    state
        .desired_interactive
        .store(interactive, Ordering::Relaxed);
    if !state.dragging.load(Ordering::Relaxed) {
        app.get_webview_window("companion")
            .ok_or("캐릭터 창이 없습니다.")?
            .set_ignore_cursor_events(!interactive)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn start_character_drag(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let w = app
        .get_webview_window("companion")
        .ok_or("캐릭터 창이 없습니다.")?;
    w.set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    state.dragging.store(true, Ordering::Relaxed);
    if let Err(error) = w.start_dragging() {
        state.dragging.store(false, Ordering::Relaxed);
        let _ = w.set_ignore_cursor_events(!state.desired_interactive.load(Ordering::Relaxed));
        return Err(error.to_string());
    }
    Ok(())
}

fn start_platform_loop(handle: tauri::AppHandle) {
    let activity_handle = handle.clone();
    std::thread::spawn(move || {
        let mut tracker = platform::WindowEventTracker::default();
        loop {
            let state = activity_handle.state::<AppState>();
            sync_observation_visibility(&activity_handle);
            let activity = platform::activity_snapshot();
            let locked = activity.locked.unwrap_or(true);
            state.screen_locked.store(locked, Ordering::Relaxed);
            let visible = observation_surface_visible(&activity_handle);
            if let Ok(settings) = state.backend.settings() {
                let _ = state.backend.set_runtime_context(RuntimeContext {
                    typing: activity.typing,
                    meeting: settings.meeting_mode,
                    screen_locked: locked,
                    observation_visible: visible,
                });
                // Revoke the old screen reply before an OS event can publish a
                // replacement ID; otherwise an already-playing old response
                // could escape its request-specific invalidation event.
                if let Ok(Some((id, _))) = state.backend.current_observation_context() {
                    let _ = validate_reply_native(&activity_handle, &state.backend, &id);
                }
                if visible && !locked && activity.typing == Some(false) {
                    if let Ok(Some(event)) = tracker.poll(&settings.observation) {
                        if let Ok(Some(reply)) = state.backend.react_to_os_event(&event) {
                            if observation_surface_visible(&activity_handle)
                                && state.backend.current_utterance(&reply.utterance_id)
                                && state.backend.settings().is_ok_and(|latest| {
                                    event.is_allowed(&latest.observation, now_ms().max(0) as u64)
                                })
                            {
                                let _ = activity_handle
                                    .emit("os-reaction", json!({"event":event,"reply":reply}));
                            }
                        }
                    }
                } else if !visible
                    || locked
                    || activity.typing.is_none()
                    || settings.observation.mode != ObservationMode::AllowedApps
                    || !settings.observation.cloud_consent
                {
                    tracker.reset();
                }
            }
            let _ = activity_handle.emit("activity-changed", activity);
            // Window enumeration must never delay the independent cursor loop.
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    std::thread::spawn(move || {
        let mut next_layout = Instant::now();
        loop {
            let state = handle.state::<AppState>();
            let now = Instant::now();
            let locked = state.screen_locked.load(Ordering::Relaxed);
            let mut active = false;
            if let Some(window) = handle.get_webview_window("companion") {
                let released =
                    state.dragging.load(Ordering::Relaxed) && !platform::primary_button_down();
                if released {
                    state.dragging.store(false, Ordering::Relaxed);
                    let _ = window.set_ignore_cursor_events(
                        !state.desired_interactive.load(Ordering::Relaxed),
                    );
                }
                active = !locked
                    && window.is_visible().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(true);
                if active {
                    if let (Ok(cursor), Ok(position), Ok(size), Ok(scale)) = (
                        window.cursor_position(),
                        window.inner_position(),
                        window.inner_size(),
                        window.scale_factor(),
                    ) {
                        if scale.is_finite() && scale > 0.0 {
                            let _ = window.emit("global-cursor", json!({"x":(cursor.x-position.x as f64)/scale,"y":(cursor.y-position.y as f64)/scale,"width":size.width as f64/scale,"height":size.height as f64/scale}));
                        }
                    }
                    if (released || now >= next_layout) && !state.dragging.load(Ordering::Relaxed) {
                        if let Ok(settings) = state.backend.settings() {
                            let _ = state.desktop.reconcile(&window, settings.scale);
                        }
                        next_layout = now + Duration::from_secs(2);
                    }
                }
            }
            // No 30 Hz cursor IPC or wakeups while hidden/locked. Activity is
            // still sampled so showing/unlocking can restart the renderer.
            std::thread::sleep(Duration::from_millis(if active { 33 } else { 250 }));
        }
    });
}

fn sync_observation_visibility(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let visible = observation_surface_visible(app);
    if state.observation_visible.swap(visible, Ordering::Relaxed) != visible {
        let _ = state.backend.set_observation_visible(visible);
        let _ = app.emit("observation-visibility", json!({"visible":visible}));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            let backend = Arc::new(Backend::open(&directory).map_err(std::io::Error::other)?);
            let models =
                ModelStore::new(directory.join("models")).map_err(std::io::Error::other)?;
            let desktop = desktop::DesktopLayout::new(&directory);
            app.manage(AppState {
                backend,
                models,
                desktop,
                observation_visible: AtomicBool::new(false),
                screen_locked: AtomicBool::new(true),
                dragging: AtomicBool::new(false),
                desired_interactive: AtomicBool::new(false),
                observation_approval: Mutex::new(None),
            });
            let settings_item = tauri::menu::MenuItem::with_id(
                app,
                "settings",
                "Ouento 설정 열기",
                true,
                None::<&str>,
            )?;
            let companion_item = tauri::menu::MenuItem::with_id(
                app,
                "companion",
                "캐릭터 보이기",
                true,
                None::<&str>,
            )?;
            let stop_item = tauri::menu::MenuItem::with_id(
                app,
                "stop-observation",
                "관찰 중지",
                true,
                None::<&str>,
            )?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "Ouento 종료", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(
                app,
                &[&settings_item, &companion_item, &stop_item, &quit_item],
            )?;
            let mut tray = tauri::tray::TrayIconBuilder::with_id("ouento")
                .menu(&tray_menu)
                .tooltip("Ouento");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "settings" => {
                    let _ = show_settings(app.clone());
                }
                "companion" => {
                    let _ = show_companion(app.clone(), Some(true));
                }
                "stop-observation" => {
                    let _ = stop_observation(app.clone(), app.state::<AppState>());
                }
                "quit" => {
                    app.state::<AppState>().backend.cancel();
                    app.exit(0);
                }
                _ => {}
            })
            .build(app)?;
            if let Some(w) = app.get_webview_window("companion") {
                w.set_focusable(false)?;
                w.set_ignore_cursor_events(true)?;
                let state = app.state::<AppState>();
                let settings = state.backend.settings().map_err(std::io::Error::other)?;
                w.set_always_on_top(settings.always_on_top)?;
                state
                    .desktop
                    .reconcile(&w, settings.scale)
                    .map_err(std::io::Error::other)?;
            }
            start_platform_loop(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Keep the native window available for the tray and companion menu.
                api.prevent_close();
                if window.hide().is_ok() && window.label() == "companion" {
                    let _ = window
                        .app_handle()
                        .emit("companion-visibility", json!({"visible":false}));
                }
            }
            sync_observation_visibility(window.app_handle());
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            save_settings,
            chat,
            speech,
            transcribe,
            cancel_speech,
            validate_utterance,
            personality_preview,
            save_memory,
            delete_memory,
            set_api_key,
            delete_api_key,
            inspect_model,
            import_model,
            discard_import,
            read_model_asset,
            read_import_asset,
            get_model_metadata,
            save_model_metadata,
            get_model_mapping,
            save_model_mapping,
            switch_model,
            list_windows,
            request_screen_permission,
            get_platform_capabilities,
            stop_observation,
            analyze_window,
            show_companion,
            is_companion_visible,
            show_settings,
            set_interactive,
            start_character_drag
        ])
        .run(tauri::generate_context!())
        .expect("Ouento 실행 실패");
}

#[cfg(test)]
mod ipc_boundary_tests {
    use super::*;
    fn window(id: u32, pid: u32, app: &str, focused: bool) -> platform::WindowInfo {
        platform::WindowInfo {
            id,
            pid,
            app_id: app.into(),
            app_name: "Example".into(),
            title: "Synthetic test".into(),
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            focused,
            minimized: false,
        }
    }
    #[test]
    fn stale_focus_and_reused_native_handles_are_rejected() {
        let initial = window(1, 100, "example.editor", true);
        let identity = WindowIdentity::from(&initial);
        let focus = Some(identity.clone());
        assert!(validate_native_target(
            &identity,
            &focus,
            std::slice::from_ref(&initial),
            ObservationMode::AllowedApps
        )
        .is_ok());
        let mut reused = initial.clone();
        reused.pid = 200;
        assert!(validate_native_target(
            &identity,
            &focus,
            &[reused],
            ObservationMode::SelectedWindow
        )
        .is_err());
        let mut switched = initial;
        switched.focused = false;
        let next = window(2, 300, "example.other", true);
        assert!(validate_native_target(
            &identity,
            &focus,
            &[switched, next],
            ObservationMode::AllowedApps
        )
        .is_err());
    }
    #[test]
    fn explicit_selected_window_can_be_background_but_not_change_mid_request() {
        let selected = window(1, 100, "example.editor", false);
        let identity = WindowIdentity::from(&selected);
        assert!(validate_native_target(
            &identity,
            &None,
            std::slice::from_ref(&selected),
            ObservationMode::SelectedWindow
        )
        .is_ok());
        assert!(validate_native_target(
            &identity,
            &None,
            std::slice::from_ref(&selected),
            ObservationMode::AllowedApps
        )
        .is_err());
        let mut minimized = selected;
        minimized.minimized = true;
        assert!(validate_native_target(
            &identity,
            &None,
            &[minimized],
            ObservationMode::SelectedWindow
        )
        .is_err());
    }
}
