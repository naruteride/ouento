import './styles.css';
import './ui/app.js';
import { CharacterRenderer } from './character/renderer';
import { SpeechPlayer, VoiceRecorder } from './audio/player.js';
import {
  native,
  call,
  on,
  toCompanion,
  modelSource,
  inspectedModelSource,
  uiSnapshot,
  builtinModels,
} from './bridge/api.js';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

const app = document.querySelector('ouento-app');
let snapshot,
  renderer,
  player,
  loadedId,
  loadingId,
  inspection,
  desktopShown = false,
  generation = 0,
  modelGeneration = 0,
  analyzing = false,
  activeOrigin = null,
  modelChanging = false,
  directBusy = false,
  companionSpeaking = false,
  locked = false,
  closed = false;
let messages = [];
let pendingModel = null;
let savedModelId = 'builtin:mao';
let loadedDetails = null;
let mappingBaseline = {};
let mappingCurrent = {};
let inspectionGeneration = 0;
let observationVisible = true;
let typingState = null;
let observationError = '';
let analysisRun = null;
let currentPresentation = null;
let platformRefresh = null;
const unlisteners = [];
const error = (err) => app.notify(String(err), 'error');
const update = (patch) => app.update(patch);
const recorder = new VoiceRecorder(() => cancel(true));
recorder.onLimit = (result) => finishRecording(result).catch(error);
recorder.onError = (err) => {
  update({ recording: false, busy: false });
  error(err);
};

async function refresh() {
  snapshot = await call('snapshot');
  showSnapshot();
  renderer?.setOptions({ ...snapshot.settings, scale: 1 });
  player?.setMuted(snapshot.settings.muted);
  return snapshot;
}
// Returning from macOS settings must update permission status without loading
// saved settings over a form that the user is still editing.
async function refreshPlatform(fresh = false) {
  // A completed permission prompt requires a newer read than any focus event
  // that started before the prompt was answered.
  if (fresh && platformRefresh) await platformRefresh.catch(() => {});
  if (!native || closed || !snapshot) return;
  if (platformRefresh) return platformRefresh;
  platformRefresh = (async () => {
    const platform = await call('get_platform_capabilities');
    if (closed) return;
    snapshot = { ...snapshot, platform };
    update({
      observation: {
        permission: platform.screenPermission,
        capabilities: platform.capabilities,
      },
    });
    showObservationState();
    return platform;
  })();
  try {
    return await platformRefresh;
  } finally {
    platformRefresh = null;
  }
}
function showSnapshot() {
  const state = uiSnapshot(snapshot);
  if (pendingModel) delete state.character.id;
  else savedModelId = snapshot.settings.activeModelId ?? 'builtin:mao';
  update(state);
  showObservationState();
}
async function save(patch) {
  const settings = { ...snapshot.settings, ...patch };
  await call('save_settings', { settings });
  await refresh();
}
async function loadModel(id, sourceOverride = null) {
  if (id === loadedId) return true;
  if (id === loadingId) return false;
  const request = ++modelGeneration;
  loadingId = id;
  loadedId = null;
  player?.cancel();
  update({
    character: {
      loaded: false,
      status: 'Live2D 모델을 불러오는 중…',
      parameters: [],
      expressions: [],
      capabilities: [],
      warnings: [],
    },
  });
  try {
    const source = sourceOverride ?? (await modelSource(id, snapshot?.models ?? []));
    if (closed || request !== modelGeneration) return;
    renderer ??= new CharacterRenderer(app.previewElement);
    player ??= new SpeechPlayer(renderer, (state) =>
      update({ speaking: state.speaking || companionSpeaking }),
    );
    renderer.setOptions({ ...snapshot?.settings, scale: 1 });
    const details = await renderer.load(source);
    if (closed || request !== modelGeneration || !details) return;
    loadedId = id;
    loadedDetails = details;
    mappingBaseline = { ...details.mapping };
    mappingCurrent = { ...details.mapping };
    if (native && !sourceOverride && !pendingModel) await saveModelMetadata(id);
    if (closed || request !== modelGeneration || loadedId !== id) return;
    renderer.setPaused(locked || document.hidden);
    update({
      character: {
        ...details,
        id,
        name: source.name,
        loaded: true,
        status: pendingModel
          ? '표정과 입 모양을 확인한 뒤 사용을 확정하세요.'
          : '함께할 준비가 됐어요',
        source: sourceOverride
          ? '검사한 모델 · 아직 저장하지 않은 미리보기'
          : id.startsWith('builtin:')
            ? 'Live2D 공식 샘플 · 개발 검증용'
            : '가져온 사용자 모델',
      },
    });
    return true;
  } finally {
    if (request === modelGeneration) loadingId = null;
  }
}
async function activateModel(id, preserveIdentity = true) {
  return beginModelPreview({ kind: 'existing', id, preserveIdentity });
}

async function beginModelPreview(candidate) {
  if (modelChanging || pendingModel)
    throw new Error('현재 미리보기를 사용하거나 취소한 뒤 다시 선택해 주세요.');
  modelChanging = true;
  const previousId = snapshot?.settings.activeModelId ?? savedModelId;
  pendingModel = { ...candidate, previousId };
  update({
    modelPreview: {
      active: true,
      busy: true,
      name: candidate.source?.name ?? '',
      preserveIdentity: candidate.preserveIdentity,
    },
  });
  try {
    await cancel();
    // 같은 모델을 다시 골라도 저장하지 않은 변경을 넘기지 않는다.
    loadedId = null;
    if (!(await loadModel(candidate.id, candidate.source)))
      throw new Error('모델 불러오기가 중단되었습니다.');
    update({ modelPreview: { busy: false, name: app.data.character.name } });
    app.closeImport();
    app.navigate('character');
    app.notify('표정과 입 모양을 확인하고 ‘이 캐릭터 사용’을 눌러 주세요.', 'info');
  } catch (err) {
    pendingModel = null;
    update({ modelPreview: { active: false, busy: false } });
    await loadModel(previousId).catch(error);
    throw err;
  } finally {
    modelChanging = false;
  }
}

async function cancelModelPreview() {
  if (!pendingModel || modelChanging) return;
  const preview = pendingModel;
  modelChanging = true;
  pendingModel = null;
  update({ modelPreview: { active: false, busy: false } });
  try {
    await cancel().catch(error);
    loadedId = null;
    await loadModel(preview.previousId);
  } finally {
    if (preview.token) {
      await call('discard_import', { token: preview.token }).catch(error);
      if (inspection?.token === preview.token) inspection = null;
    }
    update({ importState: { busy: false, entries: [], sourcePath: '', error: '' } });
    modelChanging = false;
  }
}

async function acceptModelPreview() {
  if (!pendingModel || modelChanging || !loadedId) return;
  const preview = pendingModel;
  modelChanging = true;
  update({ modelPreview: { busy: true } });
  let committed = false;
  let savedMappingId = null;
  const originalMapping = { ...mappingBaseline };
  try {
    await cancel();
    renderer.validateMapping(mappingCurrent);
    let id = preview.id;
    if (preview.kind === 'import') {
      const model = await call('import_model', {
        token: preview.token,
        entrypoint: preview.entrypoint,
      });
      id = model.id;
      inspection = null;
    }
    if (native) {
      await saveModelMetadata(id);
      await call('save_model_mapping', { id, mapping: mappingCurrent });
      savedMappingId = id;
      snapshot.settings = await call('switch_model', {
        id,
        preserveIdentity: preview.preserveIdentity,
      });
    }
    committed = true;
    savedModelId = id;
    loadedId = id;
    mappingBaseline = { ...mappingCurrent };
    pendingModel = null;
    if (!preview.preserveIdentity) {
      messages = [];
      update({ messages });
    }
    update({
      modelPreview: { active: false, busy: false },
      character: {
        ...loadedDetails,
        id,
        mapping: mappingCurrent,
        loaded: true,
        status: '함께할 준비가 됐어요',
        source: id.startsWith('builtin:') ? 'Live2D 공식 샘플 · 개발 검증용' : '가져온 사용자 모델',
      },
    });
    if (native) await refresh();
    update({ importState: { busy: false, entries: [], sourcePath: '', error: '' } });
    app.notify(
      native
        ? '확인한 캐릭터와 모델 설정을 저장했어요.'
        : '브라우저 미리보기 캐릭터를 바꿨어요. 영구 저장은 데스크톱 앱에서 사용할 수 있어요.',
    );
  } catch (err) {
    if (!committed) {
      if (savedMappingId && preview.kind === 'existing') {
        await call('save_model_mapping', { id: savedMappingId, mapping: originalMapping }).catch(
          error,
        );
      }
      modelChanging = false;
      await cancelModelPreview().catch(error);
    }
    throw err;
  } finally {
    modelChanging = false;
    update({ modelPreview: { busy: false } });
  }
}
function addMessage(role, content) {
  messages = [
    ...messages,
    {
      id: crypto.randomUUID(),
      role,
      content,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
    },
  ].slice(-100);
  update({ messages });
}
function cancelLocal(keepRecording = false) {
  const request = ++generation;
  activeOrigin = null;
  currentPresentation = null;
  analysisRun = null;
  analyzing = false;
  directBusy = false;
  companionSpeaking = false;
  if (!keepRecording) recorder.cancel();
  player?.cancel();
  update({ busy: false, speaking: false, recording: false });
  showObservationState();
  return request;
}
async function cancel(keepRecording = false) {
  const request = cancelLocal(keepRecording);
  if (native) await call('cancel_speech');
  return request;
}
async function currentUtterance(utteranceId, request, origin = activeOrigin) {
  const available = () =>
    !closed &&
    !locked &&
    request === generation &&
    (!isObservationOrigin(origin) || observationVisible);
  if (!available()) return false;
  const valid = await call('validate_utterance', { utteranceId });
  return valid && available();
}
async function present(reply, request, origin = 'direct') {
  if (isObservationOrigin(origin) && !observationVisible) return;
  if (request !== generation || !reply?.reaction?.shouldReact) return;
  const presentation = { utteranceId: reply.utteranceId, origin, request };
  currentPresentation = presentation;
  const current = () => request === generation && currentPresentation === presentation;
  if (!(await currentUtterance(reply.utteranceId, request, origin)) || !current()) return;
  activeOrigin = origin;
  addMessage('assistant', reply.reaction.text);
  renderer?.react(reply.reaction);
  await toCompanion('reaction', { ...reply, origin });
  if (!current()) return;
  if (
    snapshot?.settings.voiceEnabled &&
    !snapshot.settings.muted &&
    snapshot.settings.providers.tts.model
  ) {
    try {
      const audio = await call('speech', {
        utteranceId: reply.utteranceId,
        text: reply.reaction.text,
      });
      if (!(await currentUtterance(reply.utteranceId, request, origin)) || !current()) return;
      desktopShown = await call('is_companion_visible');
      if (!current()) return;
      if (desktopShown) await toCompanion('speech', { ...audio, origin });
      else
        await player?.play(audio, {
          muted: snapshot.settings.muted,
          validate: async () =>
            current() && (await currentUtterance(reply.utteranceId, request, origin)) && current(),
        });
    } catch (err) {
      if (current()) app.notify(`음성 연결: ${err}`, 'info');
    }
  }
}
async function send(text) {
  if (pendingModel) throw new Error('캐릭터 미리보기를 사용하거나 취소한 뒤 대화해 주세요.');
  const request = await cancel();
  if (request !== generation) return;
  directBusy = true;
  update({ busy: true });
  try {
    await player?.prepare();
    if (request !== generation) return;
    addMessage('user', text);
    await present(await call('chat', { text }), request);
  } finally {
    if (request === generation) {
      directBusy = false;
      update({ busy: false });
    }
  }
}
async function finishRecording(result) {
  const request = generation;
  directBusy = true;
  update({ recording: false, busy: true });
  try {
    const text = await call('transcribe', result);
    if (request !== generation) return;
    await send(text);
  } finally {
    if (request === generation) {
      directBusy = false;
      update({ busy: false });
    }
  }
}
function isObservationOrigin(origin) {
  return origin === 'observation' || origin === 'manualObservation';
}

function observationPrivacyBlocked() {
  return (
    pendingModel ||
    !observationVisible ||
    locked ||
    closed ||
    (!desktopShown && document.hidden) ||
    !snapshot ||
    snapshot.settings.observation.mode === 'off'
  );
}

function observationBlocked() {
  return (
    observationPrivacyBlocked() ||
    analyzing ||
    directBusy ||
    companionSpeaking ||
    player?.session ||
    recorder.state !== 'idle' ||
    typingState === true ||
    snapshot.settings.quiet ||
    snapshot.settings.focusMode ||
    snapshot.settings.meetingMode
  );
}
async function analyze(manual = false) {
  if (manual ? observationPrivacyBlocked() : observationBlocked()) {
    if (manual)
      app.notify(
        '관찰 범위와 화면 잠금·창 표시 상태를 확인해 주세요. 캐릭터 미리보기 중에는 먼저 사용을 확정하거나 취소해 주세요.',
        'info',
      );
    return;
  }
  // 명시적 버튼 요청만 선제 관찰/기존 발화를 취소하고 직접 요청 우선권을 얻는다.
  const request = manual ? await cancel() : generation;
  if (request !== generation || observationPrivacyBlocked()) return;
  const run = { request, manual };
  analysisRun = run;
  currentPresentation = null;
  analyzing = true;
  if (manual) {
    activeOrigin = 'manualObservation';
    directBusy = true;
    update({ busy: true });
  }
  showObservationState();
  try {
    if (manual) await player?.prepare();
    if (request !== generation || observationPrivacyBlocked()) return;
    const reply = await call('analyze_window', { manual });
    // manualObservation은 manual:true로 발급된 해당 요청에서만 붙이는 UI 구분이다.
    // 허용 범위와 ticket purpose 정합성은 Rust가 캡처·응답 경계에서 검사한다.
    await present(reply, request, manual ? 'manualObservation' : 'observation');
    if (request === generation) {
      observationError = '';
      showObservationState();
    }
  } catch (err) {
    if (request === generation && snapshot?.settings.observation.mode !== 'off') {
      observationError = String(err);
      showObservationState();
    }
    if (manual && request === generation) error(err);
  } finally {
    if (analysisRun === run) {
      analysisRun = null;
      analyzing = false;
      if (manual && request === generation) {
        directBusy = false;
        update({ busy: false });
      }
      showObservationState();
    }
  }
}
async function previewAudio() {
  if (!player || !loadedId) throw new Error('캐릭터를 불러온 뒤 음원을 확인해 주세요.');
  const request = await cancel();
  if (request !== generation) return;
  await player.prepare();
  if (request !== generation) return;
  const response = await fetch('/models/Kei_vowels/sounds/01_kei_ko.wav');
  if (!response.ok)
    throw new Error('한국어 확인 음원을 찾지 못했습니다. SDK 자산을 준비해 주세요.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (request !== generation) return;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  renderer.react({ emotion: 'calm', intensity: 0.7 });
  await player.play(
    { utteranceId: `preview:${request}`, audioBase64: btoa(binary) },
    {
      muted: snapshot?.settings.muted ?? false,
      validate: () => !closed && !locked && request === generation,
    },
  );
}

async function saveModelMapping(mapping) {
  if (!loadedId || modelChanging) throw new Error('캐릭터를 불러온 뒤 연결을 저장해 주세요.');
  if (pendingModel) {
    previewModelMapping(mapping);
    app.notify('미리보기에 적용했어요. ‘이 캐릭터 사용’으로 확정하면 함께 저장돼요.', 'info');
    return;
  }
  const id = loadedId;
  const request = modelGeneration;
  try {
    renderer.validateMapping(mapping);
    if (native) await call('save_model_mapping', { id, mapping });
    // 저장 중 캐릭터가 교체되면 새 모델에 이전 ID를 적용하지 않는다.
    if (id === loadedId && request === modelGeneration) {
      mappingBaseline = { ...mapping };
      applyModelMapping(mapping);
    }
    await toCompanion('mapping-changed', { id, mapping });
    app.notify(
      native
        ? '모델별 매핑을 저장했어요.'
        : '미리보기에 적용했어요. 영구 저장은 데스크톱 앱에서 가능해요.',
      native ? 'success' : 'info',
    );
  } catch (err) {
    if (id === loadedId && request === modelGeneration) resetModelMapping();
    throw err;
  }
}

function applyModelMapping(mapping) {
  const complete = {
    ...Object.fromEntries(Object.keys(mappingCurrent).map((key) => [key, ''])),
    layout_scale: '1',
    layout_x: '0',
    layout_y: '0',
    tracking_strength: '1',
    ...mapping,
  };
  const details = renderer.setMapping(complete);
  mappingCurrent = { ...details.mapping };
  update({ character: details });
}

function previewModelMapping(mapping) {
  if (!loadedId || modelChanging) return;
  try {
    applyModelMapping(mapping);
  } catch (err) {
    resetModelMapping();
    throw err;
  }
}

function resetModelMapping() {
  if (!renderer || !loadedId) return;
  app.clearMappingDraft();
  applyModelMapping(mappingBaseline);
}

async function saveModelMetadata(id) {
  if (!loadedDetails) return;
  await call('save_model_metadata', {
    id,
    metadata: {
      parameters: loadedDetails.parameters.map((parameter) => ({
        id: parameter.id,
        minimum: parameter.minimum,
        maximum: parameter.maximum,
        default: parameter.default,
      })),
      expressions: loadedDetails.expressions ?? [],
    },
  });
}

function settingsCancelSpeech(previous, next) {
  return (
    previous &&
    ['personality', 'providers', 'muted', 'voiceEnabled', 'activeModelId'].some(
      (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
    )
  );
}

async function applySettings(settings) {
  const previous = snapshot?.settings;
  if (JSON.stringify(previous?.observation) !== JSON.stringify(settings.observation))
    observationError = '';
  const changed = previous && JSON.stringify(previous) !== JSON.stringify(settings);
  if (
    settingsCancelSpeech(previous, settings) ||
    (changed && (isObservationOrigin(activeOrigin) || analysisRun))
  ) {
    cancelLocal();
  }
  snapshot = { ...snapshot, settings };
  showSnapshot();
  renderer?.setOptions({ ...settings, scale: 1 });
  player?.setMuted(settings.muted);
  if (!pendingModel) await loadModel(settings.activeModelId ?? 'builtin:mao');
}

function stopObservationPlayback() {
  if (isObservationOrigin(activeOrigin) || analysisRun) cancelLocal();
}

function invalidateObservation({ utteranceId }) {
  // 이전 관찰의 늦은 무효화 통지가 새 직접 요청/다른 발화를 취소하지 않는다.
  if (
    utteranceId &&
    currentPresentation?.utteranceId === utteranceId &&
    currentPresentation.request === generation &&
    isObservationOrigin(currentPresentation.origin)
  )
    cancelLocal();
}

function pauseAutomaticObservation() {
  if (activeOrigin === 'observation' || (analysisRun && !analysisRun.manual)) cancelLocal();
}

function handleActivity(activity) {
  locked = activity.locked === true;
  typingState = typeof activity.typing === 'boolean' ? activity.typing : null;
  renderer?.setPaused(locked || document.hidden);
  if (locked) cancelLocal();
  else if (typingState === true) pauseAutomaticObservation();
  showObservationState();
}

function showObservationState() {
  if (!snapshot) return;
  const settings = snapshot.settings;
  const status =
    settings.observation.mode === 'off'
      ? '관찰하지 않음'
      : !observationVisible
        ? '창이 숨겨져 관찰 쉬는 중'
        : locked
          ? '화면 잠금 · 관찰 쉬는 중'
          : analysisRun?.manual
            ? '요청한 화면을 분석하는 중'
            : typingState === true
              ? '입력 중 · 자동 관찰 쉬는 중'
              : observationError
                ? '화면 반응 대기 · 안내 확인'
                : settings.focusMode || settings.meetingMode
                  ? '집중·회의 중 · 자동 관찰 쉬는 중'
                  : settings.quiet
                    ? '조용히 있기 · 자동 관찰 쉬는 중'
                    : `${settings.observation.mode === 'currentScreen' ? '마우스가 있는 모니터 전체 함께 보는 중' : '허용한 화면만 함께 보는 중'}${typingState === null ? ' · 입력 감지 미지원' : ''}`;
  update({
    observation: {
      status,
      typingState,
      error: observationError,
      manualAvailable: !observationPrivacyBlocked(),
      manualAnalyzing: !!analysisRun?.manual,
    },
  });
}
async function inspect(path, preserveIdentity = true) {
  if (pendingModel || modelChanging)
    throw new Error('현재 미리보기를 사용하거나 취소한 뒤 가져와 주세요.');
  const request = ++inspectionGeneration;
  const previous = inspection;
  inspection = null;
  if (previous) await call('discard_import', { token: previous.token });
  app.openImport();
  update({ importState: { busy: true, error: '', sourcePath: path, entries: [] } });
  try {
    const inspected = await call('inspect_model', { path });
    if (request !== inspectionGeneration || closed) {
      await call('discard_import', { token: inspected.token });
      return;
    }
    inspection = inspected;
    const valid = inspection.candidates.filter((c) => c.valid);
    if (!valid.length)
      throw new Error(
        inspection.candidates.map((c) => c.error).join('\n') ||
          '실행용 model3.json을 찾지 못했습니다.',
      );
    update({
      importState: {
        busy: false,
        sourcePath: path,
        entries: inspection.candidates.map((c) => ({
          path: c.entrypoint,
          name: c.valid ? c.name : `${c.name} · ${c.error}`,
          valid: c.valid,
        })),
      },
    });
    if (valid.length === 1 && inspection.candidates.length === 1)
      await previewImport(valid[0].entrypoint, preserveIdentity);
  } catch (err) {
    if (request === inspectionGeneration)
      update({ importState: { busy: false, error: String(err) } });
    throw err;
  }
}
async function previewImport(entrypoint, preserveIdentity) {
  if (!inspection) throw new Error('모델 검사를 다시 시작해 주세요.');
  update({ importState: { busy: true } });
  try {
    const source = inspectedModelSource(inspection, entrypoint);
    await beginModelPreview({
      kind: 'import',
      token: inspection.token,
      entrypoint,
      source,
      id: `preview:${inspection.token}:${entrypoint}`,
      preserveIdentity,
    });
  } finally {
    update({ importState: { busy: false } });
  }
}

app.addEventListener('action', async (event) => {
  const a = event.detail;
  try {
    if (
      !native &&
      ![
        'expression-preview',
        'mouth-preview',
        'personality-preview',
        'model-switch',
        'model-preview-accept',
        'model-preview-cancel',
        'model-preview-identity',
        'model-mapping-preview',
        'model-mapping-reset',
        'model-mapping-save',
        'audio-preview',
        'speech-cancel',
      ].includes(a.type)
    ) {
      throw new Error('OS·저장·AI 기능은 데스크톱 앱에서 사용할 수 있어요.');
    }
    switch (a.type) {
      case 'chat-send':
        await send(a.text);
        break;
      case 'speech-cancel':
        await cancel();
        break;
      case 'voice-toggle':
        if (recorder.stream) await finishRecording(await recorder.stop());
        else if (await recorder.start()) update({ recording: true });
        break;
      case 'quiet-toggle':
        await save({ quiet: a.value });
        break;
      case 'observation-stop':
        stopObservationPlayback();
        await call('stop_observation');
        await refresh();
        break;
      case 'desktop-show':
        await call('show_companion', { resetPosition: true });
        desktopShown = true;
        app.notify('화면 오른쪽 아래에서 만나요.');
        break;
      case 'model-import': {
        const path = await open(
          a.kind === 'folder'
            ? { directory: true, multiple: false }
            : { multiple: false, filters: [{ name: 'Live2D ZIP', extensions: ['zip'] }] },
        );
        if (typeof path === 'string') await inspect(path, a.preserveIdentity !== false);
        break;
      }
      case 'model-import-entry':
        await previewImport(a.path, a.preserveIdentity !== false);
        break;
      case 'model-switch':
        await activateModel(a.id, a.preserveIdentity !== false);
        break;
      case 'model-mapping-save':
        await saveModelMapping(a.mapping);
        break;
      case 'model-mapping-preview':
        previewModelMapping(a.mapping);
        break;
      case 'model-mapping-reset':
        resetModelMapping();
        break;
      case 'model-preview-accept':
        await acceptModelPreview();
        break;
      case 'model-preview-cancel':
        await cancelModelPreview();
        break;
      case 'model-preview-identity':
        if (pendingModel) {
          pendingModel.preserveIdentity = a.value;
          update({ modelPreview: { preserveIdentity: a.value } });
        }
        break;
      case 'audio-preview':
        await previewAudio();
        break;
      case 'expression-preview':
        renderer?.react({ emotion: a.emotion, intensity: a.intensity });
        if (!pendingModel)
          await toCompanion('reaction', {
            reaction: { emotion: a.emotion, intensity: a.intensity },
          });
        break;
      case 'mouth-preview':
        renderer?.setMouth(a.openness, false);
        break;
      case 'personality-preview': {
        const reaction = native
          ? await call('personality_preview', { preset: a.preset })
          : {
              shouldReact: true,
              emotion: 'happy',
              priority: 2,
              ...{
                tsundere: {
                  text: '붙었네. 그렇게 준비했으니까… 축하해.',
                  intensity: 0.7,
                  gestureIntensity: 0.5,
                  gaze: 'away',
                  gesture: 'tilt',
                },
                cat: {
                  text: '합격이네. 잘했어. 이제 좀 쉬자.',
                  intensity: 0.35,
                  gestureIntensity: 0.25,
                  gaze: 'user',
                  gesture: 'nod',
                },
                cheerleader: {
                  text: '해냈다! 열심히 준비한 만큼 좋은 소식이 왔네!',
                  intensity: 0.95,
                  gestureIntensity: 0.8,
                  gaze: 'user',
                  gesture: 'smallBounce',
                },
              }[a.preset],
            };
        renderer?.react(reaction);
        await toCompanion('reaction', { reaction });
        if (reaction.text) app.notify(reaction.text, 'info');
        break;
      }
      case 'personality-save': {
        const p = a.personality;
        await save({
          personality: p.preset,
          personalityIntensity: p.intensity,
          personalityFrequency: p.frequency,
          jealousy: {
            enabled: p.jealousy,
            intensity: p.jealousyIntensity,
            frequency: p.jealousyFrequency,
          },
        });
        app.notify('성격을 저장했어요.');
        break;
      }
      case 'observation-refresh':
        await refreshPlatform();
        update({
          observation: {
            windows: (await call('list_windows')).map((w) => ({ ...w, id: String(w.id) })),
          },
        });
        break;
      case 'permission-request': {
        const granted = await call('request_screen_permission');
        const platform = await refreshPlatform(true);
        app.notify(
          granted && platform?.screenPermission === 'granted'
            ? 'Ouento의 화면 접근이 허용되어 있어요.'
            : platform?.platform === 'macos'
              ? '시스템 설정에서 Ouento의 화면 기록을 허용해 주세요. 이미 허용했는데 계속 거부되면 목록에서 Ouento를 제거하고 현재 사용하는 Ouento.app을 다시 추가해 주세요. 변경 후 앱을 완전히 종료하고 다시 열어 주세요.'
              : '운영체제 설정에서 Ouento의 화면 접근을 허용한 뒤 화면 권한을 다시 확인해 주세요.',
          granted && platform?.screenPermission === 'granted' ? 'success' : 'info',
        );
        break;
      }
      case 'observation-save': {
        const o = a.observation;
        await save({
          focusMode: o.focus,
          meetingMode: o.meeting,
          observation: {
            ...snapshot.settings.observation,
            mode: {
              off: 'off',
              selected: 'selectedWindow',
              allowed: 'allowedApps',
              screen: 'currentScreen',
            }[o.mode],
            selectedWindowId: o.windowId || null,
            cloudConsent: o.cloudConsent,
            screenConsent: o.mode === 'screen' && o.screenConsent === true,
            allowedApps: o.allowedApps,
            blockedApps: o.sensitiveApps,
          },
        });
        app.notify(o.mode === 'off' ? '관찰을 멈췄어요.' : '선택한 범위만 함께 볼게요.');
        break;
      }
      case 'observation-analyze':
        await analyze(true);
        break;
      case 'memory-enable':
        await save({ memoryEnabled: a.value });
        break;
      case 'memory-save':
        await call('save_memory', {
          input: {
            id: a.id,
            text: a.content,
            expiresAt: a.expiresAt ? new Date(a.expiresAt).getTime() : null,
            confirmed: true,
          },
        });
        // A failed snapshot refresh must not offer a retry of an already committed insert.
        app.completeMemorySave(a.requestId);
        app.notify('기억을 저장했어요.');
        try {
          await refresh();
        } catch (err) {
          app.notify(`기억은 저장됐지만 목록을 새로 읽지 못했어요. ${String(err)}`, 'error');
        }
        break;
      case 'memory-delete':
        await call('delete_memory', { id: a.id });
        await refresh();
        app.notify('기억을 지웠어요.');
        break;
      case 'provider-save': {
        await save({
          providers: {
            ...snapshot.settings.providers,
            [a.kind]: { baseUrl: a.endpoint, model: a.model, requiresKey: a.requiresKey !== false },
            ...(a.kind === 'tts' ? { voice: a.voice || 'alloy' } : {}),
          },
        });
        if (a.apiKey) await call('set_api_key', { kind: a.kind, key: a.apiKey });
        await refresh();
        app.notify('AI 연결 설정을 저장했어요.');
        break;
      }
      case 'provider-remove-key':
        await call('delete_api_key', { kind: a.kind });
        await refresh();
        break;
      case 'settings-save':
        await save(a.settings);
        app.notify('설정을 저장했어요.');
        break;
    }
  } catch (err) {
    if (a.type === 'memory-save') app.completeMemorySave(a.requestId, String(err));
    if (err?.name !== 'AbortError') error(err);
  }
});

app.addEventListener('character-error', (event) => app.notify(String(event.detail), 'info'));
app.addEventListener('character-capabilities', (event) => update({ character: event.detail }));
app.addEventListener('character-reload', () => {
  const id = pendingModel?.id ?? snapshot?.settings.activeModelId ?? loadedId ?? 'builtin:mao';
  loadedId = null;
  loadingId = null;
  modelGeneration++;
  cancelLocal();
  loadModel(id, pendingModel?.source).catch(error);
});

async function initialize() {
  if (native) {
    await refresh();
    unlisteners.push(
      await on('settings-changed', (settings) => applySettings(settings).catch(error)),
    );
    unlisteners.push(
      await on('speech-cancelled', (event) => {
        // 이 창의 cancel()이 이미 처리했다. 늦게 도착해 새 요청을 지우지 않는다.
        if (event.origin === 'main') return;
        cancelLocal();
      }),
    );
    unlisteners.push(await on('observation-stopped', stopObservationPlayback));
    unlisteners.push(await on('observation-invalidated', invalidateObservation));
    unlisteners.push(
      await on('os-reaction', async (payload) => {
        if (observationBlocked()) return;
        const request = generation;
        try {
          await present(payload.reply, request, 'observation');
        } catch (err) {
          if (request === generation) app.notify(`화면 활동 반응: ${err}`, 'info');
        }
      }),
    );
    unlisteners.push(
      await on('playback-state', (state) => {
        companionSpeaking = state.speaking;
        update({ speaking: state.speaking || !!player?.session });
      }),
    );
    unlisteners.push(
      await on('companion-visibility', (event) => {
        desktopShown = event.visible;
        if (!desktopShown && document.hidden) stopObservationPlayback();
      }),
    );
    unlisteners.push(
      await on('observation-visibility', (event) => {
        observationVisible = event.visible;
        if (!observationVisible) stopObservationPlayback();
        showObservationState();
      }),
    );
    unlisteners.push(await on('activity-changed', handleActivity));
    unlisteners.push(
      await getCurrentWebviewWindow().onDragDropEvent(async (event) => {
        if (event.payload.type === 'drop') {
          const path = event.payload.paths[0];
          if (path)
            try {
              await inspect(path);
            } catch (err) {
              error(err);
            }
        }
      }),
    );
  } else {
    update({
      ready: true,
      platform: '브라우저 미리보기',
      character: { models: builtinModels },
      error: '캐릭터 미리보기입니다. AI·화면 관찰·저장은 데스크톱 앱에서 연결하세요.',
    });
  }
  await loadModel(snapshot?.settings.activeModelId ?? 'builtin:mao');
  if (native) {
    await call('show_companion');
    desktopShown = true;
  }
}
initialize().catch((err) => {
  update({ error: String(err), character: { loaded: false, status: String(err) } });
});
const observationTimer = setInterval(() => analyze(), 5000);
document.addEventListener('visibilitychange', () => {
  renderer?.setPaused(locked || document.hidden);
  if (!desktopShown && document.hidden) stopObservationPlayback();
  if (!document.hidden) refreshPlatform().catch(error);
});
window.addEventListener('focus', () => refreshPlatform().catch(error));
window.addEventListener('beforeunload', () => {
  closed = true;
  modelGeneration++;
  cancelLocal();
  clearInterval(observationTimer);
  recorder.dispose();
  player?.dispose();
  renderer?.dispose();
  for (const unsubscribe of unlisteners) unsubscribe();
});
