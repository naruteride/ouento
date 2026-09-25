import { CharacterRenderer } from './character/renderer';
import { SpeechPlayer } from './audio/player.js';
import { native, call, on, toMain, modelSource } from './bridge/api.js';
import { SpeechBubble, speechBubbleStyles } from './ui/speech-bubble.js';

document.documentElement.style.cssText = 'background:transparent;overflow:hidden;';
document.body.style.cssText =
  'margin:0;background:transparent;font-family:system-ui;color:#302b40;overflow:hidden;';
const root = document.querySelector('#companion');
root.innerHTML = `
  <style>
    ${speechBubbleStyles}
    #stage { position:absolute; inset:85px 0 28px; }
    #bubble { position:absolute; z-index:2; top:6px; left:32px; right:32px; background:#fffdf4f2;
      border:1px solid #d6cedf; border-radius:20px; padding:15px 18px; font-size:14px;
      line-height:1.6; box-shadow:0 4px 22px #3b2d5212; display:none; }
    #actions { position:absolute; bottom:9px; left:50%; transform:translateX(-50%);
      display:flex; gap:5px; background:#fffdf5ed; border:1px solid #ded8e4;
      border-radius:20px; padding:5px; }
    button { border:0; border-radius:15px; padding:7px 10px; background:transparent;
      color:#504664; font:12px system-ui; white-space:nowrap; cursor:pointer; }
    button:hover { background:#e8e0f7; }
    #status { position:absolute; top:75px; left:50%; transform:translateX(-50%);
      font-size:10px; background:#fffdf5dc; padding:3px 8px; border-radius:10px; white-space:nowrap; }
  </style>
  <div id="bubble" class="speech-bubble" role="status"></div>
  <div id="status">관찰 안 함</div>
  <div id="stage"></div>
  <div id="actions">
    <button id="settings">대화·설정</button>
    <button id="quiet">조용히</button>
    <button id="stop">관찰 중지</button>
    <button id="cancel" aria-label="말하기 중단">■</button>
  </div>`;

const stage = document.querySelector('#stage');
const bubble = document.querySelector('#bubble');
const speechBubble = new SpeechBubble(bubble, { setTimeout, clearTimeout });
const status = document.querySelector('#status');
const unlisteners = [];
let renderer;
let player;
let snapshot;
let loadedId;
let loadingId;
let interactive = false;
let modelGeneration = 0;
let reactionGeneration = 0;
let speechGeneration = 0;
let activeUtterance = null;
let activeOrigin = null;
let activeText = '';
let pendingReaction = null;
let pendingSpeech = null;
let locked = false;
let visible = true;
let closed = false;
let down;

function say(text, hold = false) {
  speechBubble.show(text, hold);
}

function stopPlayback() {
  speechGeneration++;
  activeUtterance = null;
  activeOrigin = null;
  activeText = '';
  pendingReaction = null;
  pendingSpeech = null;
  player?.cancel();
  speechBubble.hide(locked || !visible || closed);
}

function cancelReaction() {
  reactionGeneration++;
  stopPlayback();
}

function handleActivity(activity) {
  locked = activity.locked === true;
  updateVisibility();
  if (!locked && activity.typing === true) pauseAutomaticReaction();
}

function playbackChanged(state) {
  // Hold the caption throughout playback, including audio pauses. Delayed TTS
  // can restore a caption that already expired while preparing the audio.
  if ((state.speaking || state.paused) && state.utteranceId === activeUtterance && activeText) {
    say(activeText, true);
  } else if (!state.speaking && activeUtterance && activeText) {
    speechBubble.scheduleDismissal();
  }
  toMain('playback-state', state).catch(() => {});
}

function settingsCancelSpeech(previous, next) {
  return (
    previous &&
    ['personality', 'providers', 'muted', 'voiceEnabled', 'activeModelId'].some(
      (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
    )
  );
}

function isObservationOrigin(origin) {
  return origin === 'observation' || origin === 'manualObservation';
}

async function load(settings) {
  const previous = snapshot?.settings;
  const changed = previous && JSON.stringify(previous) !== JSON.stringify(settings);
  if (
    settingsCancelSpeech(previous, settings) ||
    (changed && (isObservationOrigin(activeOrigin) || isObservationOrigin(pendingReaction?.origin)))
  ) {
    cancelReaction();
  }
  snapshot = { ...snapshot, settings };
  status.textContent =
    settings.observation.mode === 'off'
      ? '관찰 안 함'
      : settings.quiet
        ? '함께 보는 중 · 조용히'
        : '허용한 화면만 보는 중';
  document.querySelector('#quiet').textContent = settings.quiet ? '조용히 해제' : '조용히';
  // Native geometry changes the stage size. Scaling the model here as well
  // would apply the same setting twice and crop it at the canvas boundary.
  renderer?.setOptions({ ...settings, scale: 1 });
  player?.setMuted(settings.muted);

  const id = settings.activeModelId ?? 'builtin:mao';
  if (id === loadedId || id === loadingId) return;
  loadingId = id;
  loadedId = null;
  cancelReaction();
  const request = ++modelGeneration;
  try {
    const fresh = await call('snapshot');
    if (closed || request !== modelGeneration) return;
    // 로딩 중 받은 최신 설정을 오래된 snapshot으로 덮지 않는다.
    snapshot = { ...fresh, settings: snapshot.settings };
    const source = await modelSource(id, fresh.models);
    if (closed || request !== modelGeneration) return;
    const details = await renderer.load(source);
    if (closed || request !== modelGeneration || !details) return;
    loadedId = id;
    renderer.setOptions({ ...snapshot.settings, scale: 1 });
    renderer.setPaused(locked || !visible);
  } finally {
    if (request === modelGeneration) loadingId = null;
  }
}

function speechCurrent(utteranceId, request) {
  return (
    !closed && !locked && visible && request === speechGeneration && activeUtterance === utteranceId
  );
}

async function validSpeech(utteranceId, request) {
  if (!speechCurrent(utteranceId, request)) return false;
  const valid = await call('validate_utterance', { utteranceId });
  return valid && speechCurrent(utteranceId, request);
}

async function handleReaction(reply) {
  if (closed || locked || !visible || !reply?.reaction) return;
  if (!reply.utteranceId) {
    // 표정 미리보기는 현재 발화의 ID와 오디오 수명을 바꾸지 않는다.
    renderer.react(reply.reaction);
    if (reply.reaction.text) say(reply.reaction.text);
    return;
  }

  const request = ++reactionGeneration;
  stopPlayback();
  const speechRequest = speechGeneration;
  const pending = { id: reply.utteranceId, origin: reply.origin ?? null, promise: null };
  const current = () =>
    !closed &&
    !locked &&
    visible &&
    request === reactionGeneration &&
    speechRequest === speechGeneration;
  pending.promise = (async () => {
    try {
      const valid = await call('validate_utterance', { utteranceId: reply.utteranceId });
      if (!valid || !current()) return false;
      activeUtterance = reply.utteranceId;
      activeOrigin = reply.origin ?? null;
      activeText = reply.reaction.text ?? '';
      renderer.react(reply.reaction);
      if (activeText) say(activeText);
      return true;
    } catch (error) {
      if (current()) say(`반응 확인: ${error}`);
      return false;
    } finally {
      if (pendingReaction === pending) pendingReaction = null;
    }
  })();
  pendingReaction = pending;
  await pending.promise;
}

async function handleSpeech(audio) {
  if (
    closed ||
    locked ||
    !visible ||
    !audio?.utteranceId ||
    pendingSpeech?.id === audio.utteranceId ||
    player.session?.id === audio.utteranceId
  )
    return;
  const request = speechGeneration;
  const pending = { id: audio.utteranceId };
  pendingSpeech = pending;
  const validate = () => validSpeech(audio.utteranceId, request);
  try {
    // reaction 이벤트 전달 완료는 비동기 검증 완료를 뜻하지 않는다.
    if (pendingReaction?.id === audio.utteranceId) await pendingReaction.promise;
    if (!(await validate())) return;
    await player.play(audio, { muted: snapshot.settings.muted, validate });
  } catch (error) {
    if (speechCurrent(audio.utteranceId, request)) say(`음성 재생: ${error}`);
  } finally {
    if (pendingSpeech === pending) pendingSpeech = null;
  }
}

function hit(point) {
  const rect = stage.getBoundingClientRect();
  const x = (point.x - rect.left) / rect.width;
  const y = (point.y - rect.top) / rect.height;
  const character = renderer.hitTest(x * 2 - 1, 1 - y * 2);
  const actions = point.y > point.height - 48 && point.x > 28 && point.x < point.width - 28;
  const bubbleRect = bubble.getBoundingClientRect();
  const speech =
    bubble.style.display !== 'none' &&
    point.x >= bubbleRect.left &&
    point.x <= bubbleRect.right &&
    point.y >= bubbleRect.top &&
    point.y <= bubbleRect.bottom;
  return character || actions || speech;
}

function handleCursor(point) {
  const rect = stage.getBoundingClientRect();
  renderer.setCursor(
    ((point.x - rect.left) / rect.width) * 2 - 1,
    1 - ((point.y - rect.top) / rect.height) * 2,
  );
  const next = hit(point);
  if (next === interactive) return;
  interactive = next;
  call('set_interactive', { interactive }).catch(() => {});
}

function stopObservationReaction() {
  if (isObservationOrigin(activeOrigin) || isObservationOrigin(pendingReaction?.origin))
    cancelReaction();
  status.textContent = '관찰 안 함';
}

function invalidateObservation({ utteranceId }) {
  const current = pendingReaction ?? { id: activeUtterance, origin: activeOrigin };
  if (utteranceId && current.id === utteranceId && isObservationOrigin(current.origin))
    cancelReaction();
}

function pauseAutomaticReaction() {
  if (activeOrigin === 'observation' || pendingReaction?.origin === 'observation') cancelReaction();
}

function updateVisibility() {
  renderer.setPaused(locked || !visible);
  if (locked || !visible) cancelReaction();
}

async function start() {
  renderer = new CharacterRenderer(stage);
  player = new SpeechPlayer(renderer, playbackChanged);
  if (!native) {
    await renderer.load({ url: '/models/Mao/Mao.model3.json', name: 'Mao' });
    return;
  }
  snapshot = await call('snapshot');
  await load(snapshot.settings);
  unlisteners.push(
    await on('settings-changed', (settings) => load(settings).catch((error) => say(String(error)))),
  );
  unlisteners.push(await on('global-cursor', handleCursor));
  unlisteners.push(await on('reaction', handleReaction));
  unlisteners.push(await on('speech', handleSpeech));
  unlisteners.push(await on('speech-cancelled', cancelReaction));
  unlisteners.push(await on('observation-stopped', stopObservationReaction));
  unlisteners.push(await on('observation-invalidated', invalidateObservation));
  unlisteners.push(await on('activity-changed', handleActivity));
  unlisteners.push(
    await on('companion-visibility', (event) => {
      visible = event.visible;
      updateVisibility();
    }),
  );
  unlisteners.push(
    await on('mapping-changed', (data) => {
      if (data.id === loadedId) {
        try {
          renderer.setMapping(data.mapping);
        } catch (error) {
          say(String(error));
        }
      }
    }),
  );
  visible = await call('is_companion_visible');
  updateVisibility();
}

stage.addEventListener('character-error', (event) => say(String(event.detail)));
stage.addEventListener('character-reload', () => {
  loadedId = null;
  loadingId = null;
  modelGeneration++;
  cancelReaction();
  if (native && snapshot) load(snapshot.settings).catch((error) => say(String(error)));
  else
    renderer
      .load({ url: '/models/Mao/Mao.model3.json', name: 'Mao' })
      .catch((error) => say(String(error)));
});
stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  down = { x: event.clientX, y: event.clientY };
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove', (event) => {
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 5) return;
  down = null;
  call('start_character_drag').catch((error) => say(String(error)));
});
stage.addEventListener('pointerup', () => {
  if (!down) return;
  down = null;
  document.querySelector('#actions').style.display = 'flex';
});
stage.addEventListener('pointercancel', () => {
  down = null;
});
document.querySelector('#settings').onclick = () =>
  call('show_settings').catch((error) => say(String(error)));
document.querySelector('#quiet').onclick = () =>
  call('save_settings', {
    settings: { ...snapshot.settings, quiet: !snapshot.settings.quiet },
  }).catch((error) => say(String(error)));
document.querySelector('#stop').onclick = () => {
  stopObservationReaction();
  call('stop_observation').catch((error) => say(String(error)));
};
document.querySelector('#cancel').onclick = () => {
  cancelReaction();
  call('cancel_speech').catch((error) => say(String(error)));
};

start().catch((error) => say(String(error)));
window.addEventListener('beforeunload', () => {
  closed = true;
  modelGeneration++;
  cancelReaction();
  player?.dispose();
  renderer?.dispose();
  for (const unsubscribe of unlisteners) unsubscribe();
});
