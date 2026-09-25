// 실제 companion 컨트롤러의 비동기 경계를 검사한다. DOM·IPC·오디오만 대체하며 OS 실기를 대체하지 않는다.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { SpeechBubble, speechBubbleDuration, speechBubbleStyles } from '../src/ui/speech-bubble.js';
const nodes = new Map();
function node(id) {
  if (!nodes.has(id))
    nodes.set(id, {
      style: { display: 'none' },
      dataset: {},
      textContent: '',
      listeners: new Map(),
      addEventListener(type, fn) {
        this.listeners.set(type, fn);
      },
      getBoundingClientRect() {
        return { left: 0, top: 85, width: 400, height: 400 };
      },
      setPointerCapture() {},
    });
  return nodes.get(id);
}
let validations = [];
let nextTimer = 0;
const timers = new Map();
const reacts = [];
const plays = [];
const nativeBubbleUpdates = [];
let cancels = 0;
const sandbox = {
  console,
  setTimeout(fn, delay) {
    const id = ++nextTimer;
    timers.set(id, { fn, delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  document: { documentElement: { style: {} }, body: { style: {} }, querySelector: node },
  window: { addEventListener() {} },
  native: true,
  SpeechBubble,
  speechBubbleDuration,
  speechBubbleStyles,
  toMain: async () => {},
  on: async () => () => {},
  modelSource: async () => ({}),
  call: async (name, args) => {
    if (name === 'update_speech_bubble') {
      nativeBubbleUpdates.push(structuredClone(args));
      return;
    }
    if (name === 'validate_utterance')
      return new Promise((resolve) => validations.push({ id: args.utteranceId, resolve }));
    if (name === 'snapshot') return { models: [], settings: { observation: { mode: 'off' } } };
    if (name === 'is_companion_visible') return true;
  },
  CharacterRenderer: class {
    react(r) {
      reacts.push(r);
    }
    cancelSpeech() {}
    setPaused(v) {
      this.paused = v;
    }
    hitTest() {
      return true;
    }
  },
  SpeechPlayer: class {
    constructor(renderer, state) {
      this.onState = state;
      this.session = null;
    }
    cancel() {
      cancels++;
      this.session = null;
      this.onState({ speaking: false });
    }
    async play(audio, { validate }) {
      if (!(await validate())) return false;
      this.session = { id: audio.utteranceId };
      plays.push(audio.utteranceId);
      this.onState({ speaking: true, utteranceId: audio.utteranceId });
      return true;
    }
  },
};
vm.createContext(sandbox);
let source = fs.readFileSync(new URL('../src/companion.js', import.meta.url), 'utf8');
const importPattern = /^import[\s\S]*?;\n/gm;
assert.equal(
  [...source.matchAll(importPattern)].length,
  4,
  'companion import 경계가 변경되었습니다. 진단을 갱신하세요.',
);
source = source.replace(importPattern, '');
const startup = 'start().catch((error) => say(String(error)));';
assert.equal(
  source.split(startup).length,
  2,
  'companion 시작 지점을 정확히 하나 찾을 수 없습니다.',
);
source = source.replace(startup, '');
vm.runInContext(source, sandbox);
vm.runInContext(
  'renderer=new CharacterRenderer(stage);player=new SpeechPlayer(renderer,playbackChanged);snapshot={settings:{muted:false,observation:{mode:"off"}}};',
  sandbox,
);
const run = (code) => vm.runInContext(code, sandbox);
const finishTimer = (delay) => {
  const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
  assert.ok(entry, `missing ${delay}ms timer`);
  const [id, timer] = entry;
  timers.delete(id);
  timer.fn();
};
const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const resolve = (id, value = true) => {
  const index = validations.findIndex((v) => v.id === id);
  assert.ok(index >= 0, `missing validation ${id}`);
  validations.splice(index, 1)[0].resolve(value);
};
const reaction = (id, origin = 'direct') =>
  run(
    `handleReaction({utteranceId:${JSON.stringify(id)},origin:${JSON.stringify(origin)},reaction:{emotion:'happy',text:${JSON.stringify(id)}}})`,
  );
// A cancelled asynchronous validation cannot restore a reaction.
let pending = reaction('cancelled');
run('cancelReaction()');
resolve('cancelled');
await pending;
assert.equal(run('activeUtterance'), null);
assert.equal(reacts.length, 0);
// Newer reaction wins even when the old validation resolves last.
let old = reaction('old');
let fresh = reaction('fresh');
resolve('fresh');
await fresh;
resolve('old');
await old;
assert.equal(run('activeUtterance'), 'fresh');
assert.equal(reacts.length, 1);
// Preview retains active utterance and does not cancel playback.
const before = cancels;
await run("handleReaction({reaction:{emotion:'sad'}})");
assert.equal(run('activeUtterance'), 'fresh');
assert.equal(cancels, before);
// Speech validation rechecks the epoch after IPC.
pending = run("handleSpeech({utteranceId:'fresh',audioBase64:''})");
run('cancelReaction()');
resolve('fresh');
await pending;
assert.equal(plays.length, 0);
// Speech can arrive before reaction validation completes and waits for it.
const waiting = reaction('paired');
const audio = run("handleSpeech({utteranceId:'paired',audioBase64:''})");
assert.equal(validations.length, 1);
resolve('paired');
await waiting;
await tick();
resolve('paired');
await tick();
resolve('paired');
await audio;
assert.deepEqual(plays, ['paired']);
assert.equal(node('#bubble').style.display, 'block');
assert.equal(node('#bubble').textContent, 'paired');
assert.equal(timers.size, 0, 'caption must stay while speaking');
// Audio suspension retains the current caption just like active playback.
run("playbackChanged({speaking:false,paused:true,utteranceId:'paired'})");
assert.equal(node('#bubble').dataset.state, 'visible');
assert.equal(timers.size, 0, 'paused audio must not start a caption expiry timer');
run("playbackChanged({speaking:true,utteranceId:'paired'})");
assert.equal(timers.size, 0);
// Preview while audio is playing keeps its identity and session.
await run("handleReaction({reaction:{emotion:'calm'}})");
assert.equal(run('player.session.id'), 'paired');
// Hidden and locked states compose, and hiding invalidates current speech.
run('visible=false;updateVisibility()');
assert.equal(run('player.session'), null);
assert.equal(run('renderer.paused'), true);
assert.equal(
  node('#bubble').style.display,
  'none',
  'a hidden window clears the caption immediately',
);
assert.equal(timers.size, 0);
run('locked=true;visible=true;updateVisibility()');
assert.equal(run('renderer.paused'), true);
run('locked=false;updateVisibility()');
assert.equal(run('renderer.paused'), false);
// A preview during reaction validation must not invalidate the pending utterance.
pending = reaction('pending-preview');
const beforePreview = cancels;
await run("handleReaction({reaction:{emotion:'surprised'}})");
assert.equal(cancels, beforePreview);
resolve('pending-preview');
await pending;
assert.equal(run('activeUtterance'), 'pending-preview');
const afterPreview = run("handleSpeech({utteranceId:'pending-preview',audioBase64:''})");
resolve('pending-preview');
await tick();
resolve('pending-preview');
await afterPreview;
assert.equal(run('player.session.id'), 'pending-preview');
// Automatic pauses preserve the pending and active explicit screen request.
pending = reaction('manual-pending', 'manualObservation');
run('pauseAutomaticReaction()');
resolve('manual-pending');
await pending;
assert.equal(run('activeUtterance'), 'manual-pending');
const manualAudio = run("handleSpeech({utteranceId:'manual-pending',audioBase64:''})");
resolve('manual-pending');
await tick();
resolve('manual-pending');
await manualAudio;
run('pauseAutomaticReaction()');
assert.equal(run('player.session.id'), 'manual-pending');
run('stopObservationReaction()');
assert.equal(run('player.session'), null);
assert.equal(run('activeUtterance'), null);
// An explicit observation stop invalidates pending manual validation as well.
pending = reaction('manual-stopped', 'manualObservation');
run('stopObservationReaction()');
resolve('manual-stopped');
await pending;
assert.equal(run('activeUtterance'), null);
// Actual typing discards proactive replies, while stop preserves direct chat.
pending = reaction('automatic-stopped', 'observation');
run('handleActivity({typing:true,locked:false})');
resolve('automatic-stopped');
await pending;
assert.equal(run('activeUtterance'), null);
pending = reaction('direct-preserved');
resolve('direct-preserved');
await pending;
run('stopObservationReaction()');
assert.equal(run('activeUtterance'), 'direct-preserved');

// Native false rejects a text/muted reaction without applying it to the character.
const beforeDenied = reacts.length;
pending = reaction('text-denied', 'manualObservation');
resolve('text-denied', false);
await pending;
assert.equal(run('activeUtterance'), null);
assert.equal(reacts.length, beforeDenied);
assert.equal(node('#bubble').dataset.state, 'hiding');
finishTimer(400);
assert.equal(node('#bubble').style.display, 'none');

// An asynchronous false in handleSpeech never reaches the player's play method.
pending = reaction('audio-denied', 'manualObservation');
resolve('audio-denied');
await pending;
const playsBeforeDenied = plays.length;
pending = run("handleSpeech({utteranceId:'audio-denied',audioBase64:''})");
resolve('audio-denied', false);
await pending;
assert.equal(plays.length, playsBeforeDenied);
assert.equal(run('player.session'), null);

// The callback passed to the player must also propagate a later native denial.
pending = run("handleSpeech({utteranceId:'audio-denied',audioBase64:''})");
resolve('audio-denied');
await tick();
resolve('audio-denied', false);
await pending;
assert.equal(plays.length, playsBeforeDenied);
assert.equal(run('player.session'), null);

// An old validation resolving false cannot replace or cancel newer accepted speech.
const oldDenied = reaction('older-denied', 'manualObservation');
pending = reaction('newer-accepted', 'manualObservation');
resolve('newer-accepted');
await pending;
pending = run("handleSpeech({utteranceId:'newer-accepted',audioBase64:''})");
resolve('newer-accepted');
await tick();
resolve('newer-accepted');
await pending;
resolve('older-denied', false);
await oldDenied;
assert.equal(run('player.session.id'), 'newer-accepted');
assert.equal(run('activeUtterance'), 'newer-accepted');

// A matching native invalidation stops active observation audio and its caption.
run("invalidateObservation({utteranceId:'previous-observation'})");
assert.equal(run('player.session.id'), 'newer-accepted');
run("invalidateObservation({utteranceId:'newer-accepted'})");
assert.equal(run('player.session'), null);
assert.equal(node('#bubble').dataset.state, 'hiding');
finishTimer(400);
assert.equal(node('#bubble').style.display, 'none');

// A pending observation validation cannot revive after its scoped invalidation.
pending = reaction('pending-invalidated', 'manualObservation');
run("invalidateObservation({utteranceId:'pending-invalidated'})");
resolve('pending-invalidated');
await pending;
assert.equal(run('activeUtterance'), null);

// Old observation IDs and invalidation events cannot interrupt new direct speech.
pending = reaction('direct-current');
run("invalidateObservation({utteranceId:'pending-invalidated'})");
resolve('direct-current');
await pending;
pending = run("handleSpeech({utteranceId:'direct-current',audioBase64:''})");
resolve('direct-current');
await tick();
resolve('direct-current');
await pending;
run("invalidateObservation({utteranceId:'direct-current'})");
assert.equal(run('player.session.id'), 'direct-current');
assert.equal(run('activeOrigin'), 'direct');

// Missing typing detection cannot cancel pending validation or an accepted automatic reply.
pending = reaction('automatic-unknown', 'observation');
const unknownEpoch = run('reactionGeneration');
run('handleActivity({typing:null,locked:false})');
assert.equal(run('reactionGeneration'), unknownEpoch);
resolve('automatic-unknown');
await pending;
assert.equal(run('activeUtterance'), 'automatic-unknown');
run('handleActivity({locked:false})');
assert.equal(run('activeUtterance'), 'automatic-unknown');
run('handleActivity({typing:true,locked:false})');
assert.equal(run('activeUtterance'), null);

// Screen locking remains an unconditional cancellation even without typing detection.
pending = reaction('locked-unknown', 'observation');
run('handleActivity({typing:null,locked:true})');
resolve('locked-unknown');
await pending;
assert.equal(run('activeUtterance'), null);
assert.equal(run('renderer.paused'), true);
run('handleActivity({typing:null,locked:false})');
assert.equal(run('renderer.paused'), false);

// A long spoken response remains during playback and gets its full reading time at the end.
const longText = '가'.repeat(180);
pending = run(
  `handleReaction({utteranceId:'long-caption',origin:'direct',reaction:{emotion:'calm',text:${JSON.stringify(longText)}}})`,
);
resolve('long-caption');
await pending;
assert.equal([...timers.values()].at(-1).delay, speechBubbleDuration(longText));
pending = run("handleSpeech({utteranceId:'long-caption',audioBase64:''})");
resolve('long-caption');
await tick();
resolve('long-caption');
await pending;
assert.equal(timers.size, 0);
run('player.cancel()');
assert.equal(node('#bubble').textContent, longText);
assert.equal(node('#bubble').dataset.state, 'visible');
assert.equal(timers.size, 1);
assert.equal([...timers.values()][0].delay, 20000);
finishTimer(20000);
assert.equal(node('#bubble').dataset.state, 'hiding');
finishTimer(400);
assert.equal(node('#bubble').style.display, 'none');

// A superseded fade callback and an old TTS message cannot hide or revive a new response.
pending = reaction('fade-old');
resolve('fade-old');
await pending;
run('cancelReaction()');
const staleFade = [...timers.values()].find((timer) => timer.delay === 400)?.fn;
assert.ok(staleFade);
pending = reaction('fade-new');
resolve('fade-new');
await pending;
staleFade();
assert.equal(node('#bubble').dataset.state, 'visible');
assert.equal(node('#bubble').textContent, 'fade-new');
const playsBeforeStaleTts = plays.length;
await run("handleSpeech({utteranceId:'fade-old',audioBase64:''})");
assert.equal(plays.length, playsBeforeStaleTts);
assert.equal(node('#bubble').textContent, 'fade-new');
run('cancelReaction()');
finishTimer(400);
assert.equal(node('#bubble').style.display, 'none');
assert.equal(timers.size, 0);

// Native surfaces mirror each phase; the companion retains the sole reading timer.
const nativeUpdatesBefore = nativeBubbleUpdates.length;
pending = reaction('native-caption');
resolve('native-caption');
await pending;
assert.equal(nativeBubbleUpdates.at(-1).state, 'visible');
assert.equal(nativeBubbleUpdates.at(-1).text, 'native-caption');
run("playbackChanged({speaking:true,utteranceId:'native-caption'})");
run("playbackChanged({speaking:false,paused:true,utteranceId:'native-caption'})");
assert.equal(timers.size, 0, 'native mirroring cannot create a second caption TTL');
assert.equal(nativeBubbleUpdates.at(-1).state, 'visible');
run('playbackChanged({speaking:false})');
assert.equal(timers.size, 1);
finishTimer(speechBubbleDuration('native-caption'));
assert.equal(nativeBubbleUpdates.at(-1).state, 'hiding');
finishTimer(400);
assert.equal(nativeBubbleUpdates.at(-1).state, 'hidden');
assert.equal(nativeBubbleUpdates.at(-1).text, '');
assert.deepEqual(
  nativeBubbleUpdates.slice(nativeUpdatesBefore).map((update) => update.state),
  ['visible', 'visible', 'visible', 'hiding', 'hidden'],
);
assert.ok(
  nativeBubbleUpdates.every(
    (update, index) =>
      Number.isSafeInteger(update.revision) &&
      update.revision > 0 &&
      (index === 0 || update.revision > nativeBubbleUpdates[index - 1].revision),
  ),
);
assert.equal(timers.size, 0);
console.log(
  'companion controller: 24 deferred-event, preview, native caption lifecycle, caption timing, visibility, unknown-activity, manual-observation, native-denial, scoped invalidation scenarios passed',
);
