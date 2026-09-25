// 실제 main 컨트롤러의 수동/자동 관찰·취소 경계. IPC/오디오만 대체한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

let source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const imports = /^import[\s\S]*?;\n/gm;
assert.equal([...source.matchAll(imports)].length, 7, 'main import boundary changed');
source = source.replace(imports, '');
const startup = /initialize\(\)\.catch\(\(err\) => \{[\s\S]*?\n\}\);/g;
assert.equal([...source.matchAll(startup)].length, 1, 'main startup boundary changed');
source = source.replace(startup, '');

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const reply = (id) => ({
  utteranceId: id,
  reaction: { shouldReact: true, text: id, emotion: 'calm' },
});
function harness() {
  const requests = [];
  const forwarded = [];
  const plays = [];
  const reactions = [];
  const validations = [];
  const actions = new Map();
  const data = {};
  let deferValidation = false;
  const sandbox = {
    console,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    document: {
      hidden: false,
      querySelector: () => ({
        update(patch) {
          for (const [key, value] of Object.entries(patch))
            data[key] =
              value && typeof value === 'object' && !Array.isArray(value)
                ? { ...data[key], ...value }
                : value;
        },
        notify() {},
        addEventListener(type, handler) {
          actions.set(type, handler);
        },
      }),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    native: true,
    call: async (name, args = {}) => {
      if (name === 'cancel_speech') return;
      if (name === 'analyze_window' || name === 'chat' || name === 'speech') {
        return new Promise((resolve) => requests.push({ name, args, resolve }));
      }
      if (name === 'is_companion_visible') return sandbox.companionVisible;
      if (name === 'validate_utterance') {
        if (deferValidation) return new Promise((resolve) => validations.push({ args, resolve }));
        return true;
      }
      throw new Error(`Unexpected command ${name}`);
    },
    toCompanion: async (event, payload) => forwarded.push({ event, payload }),
    companionVisible: true,
    VoiceRecorder: class {
      constructor() {
        this.state = 'idle';
      }
      cancel() {
        this.state = 'idle';
      }
    },
    testPlayer: {
      session: null,
      cancel() {
        this.session = null;
      },
      prepare: async () => {},
      async play(audio, { validate }) {
        if (!(await validate())) return false;
        plays.push(audio.utteranceId);
        this.session = { id: audio.utteranceId };
        return true;
      },
    },
    testRenderer: {
      react(value) {
        reactions.push(value);
      },
      setOptions() {},
      setPaused() {},
    },
    initialSnapshot: {
      settings: {
        observation: { mode: 'selectedWindow' },
        quiet: false,
        focusMode: false,
        meetingMode: false,
        voiceEnabled: false,
        muted: false,
        providers: { tts: { model: '' } },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  run(
    'snapshot=initialSnapshot; player=testPlayer; renderer=testRenderer; desktopShown=true; typingState=false;',
  );
  return {
    run,
    data,
    requests,
    forwarded,
    plays,
    reactions,
    validations,
    actions,
    deferValidation: () => {
      deferValidation = true;
    },
  };
}

// Quiet and focus/meeting suppress automatic work even when activity detection is unavailable.
let h = harness();
h.run(
  'typingState=null;snapshot.settings.quiet=true;snapshot.settings.focusMode=true;snapshot.settings.meetingMode=true;',
);
await h.run('analyze(false)');
assert.equal(h.requests.length, 0);
let manual = h.run('analyze(true)');
await tick();
assert.equal(h.requests.length, 1);
assert.equal(h.requests[0].args.manual, true);
assert.equal(h.run('directBusy'), true);
assert.equal(h.data.observation.manualAnalyzing, true);
await h.run('analyze(false)');
assert.equal(h.requests.length, 1, 'automatic requests cannot interrupt an explicit request');
h.requests[0].resolve(reply('manual-quiet'));
await manual;
assert.equal(h.forwarded[0].payload.origin, 'manualObservation');
assert.equal(h.run('directBusy'), false);
assert.equal(h.data.observation.manualAnalyzing, false);

// A manual request replaces an older automatic request; its old finally is harmless.
h = harness();
let automatic = h.run('analyze(false)');
assert.equal(h.requests[0].args.manual, false);
manual = h.run('analyze(true)');
await tick();
assert.equal(h.requests.length, 2);
h.requests[0].resolve(reply('old-automatic'));
await automatic;
assert.equal(h.run('analysisRun.manual'), true);
assert.equal(h.run('directBusy'), true);
assert.equal(h.forwarded.length, 0);
h.requests[1].resolve(reply('manual-new'));
await manual;
assert.deepEqual(
  h.forwarded.map((item) => item.payload.utteranceId),
  ['manual-new'],
);

// Typing/unknown activity does not discard pending or active manual work.
h = harness();
manual = h.run('analyze(true)');
await tick();
const manualEpoch = h.run('generation');
h.run('handleActivity({typing:true,locked:false});');
assert.equal(h.run('generation'), manualEpoch);
assert.equal(h.run('directBusy'), true);
h.requests[0].resolve(reply('manual-typing'));
await manual;
h.run('handleActivity({typing:null,locked:false});');
assert.equal(h.run('activeOrigin'), 'manualObservation');
assert.equal(h.run('generation'), manualEpoch);

// The same automatic pause invalidates proactive work and its late response.
h = harness();
automatic = h.run('analyze(false)');
h.run('handleActivity({typing:true,locked:false});');
h.run('handleActivity({typing:null,locked:false});');
h.requests[0].resolve(reply('typing-automatic'));
await automatic;
assert.equal(h.forwarded.length, 0);
assert.equal(h.run('analyzing'), false);

// Missing detection allows starting, pending, and already-presented automatic work.
h = harness();
h.run('handleActivity({typing:null,locked:false})');
assert.equal(h.run('observationBlocked()'), false);
assert.match(h.data.observation.status, /함께 보는 중.*입력 감지 미지원/);
assert.doesNotMatch(h.data.observation.status, /쉬는 중/);
automatic = h.run('analyze(false)');
assert.equal(h.requests.length, 1);
const unknownActivityEpoch = h.run('generation');
h.run('handleActivity({locked:false})');
assert.equal(h.run('generation'), unknownActivityEpoch);
h.requests[0].resolve(reply('unknown-automatic'));
await automatic;
assert.equal(h.forwarded[0].payload.origin, 'observation');
h.run('handleActivity({typing:null,locked:false})');
assert.equal(h.run('generation'), unknownActivityEpoch);
assert.equal(h.run('activeOrigin'), 'observation');

// A real typing signal blocks a new request; returning to unavailable detection resumes it.
h = harness();
h.run('handleActivity({typing:true,locked:false})');
await h.run('analyze(false)');
assert.equal(h.requests.length, 0);
assert.match(h.data.observation.status, /입력 중.*쉬는 중/);
h.run('handleActivity({typing:null,locked:false})');
automatic = h.run('analyze(false)');
assert.equal(h.requests.length, 1);
h.requests[0].resolve(reply('unknown-resumed'));
await automatic;
assert.equal(h.forwarded[0].payload.utteranceId, 'unknown-resumed');

// Unavailable detection never overrides explicit quiet/privacy/visibility controls.
for (const blocked of [
  'snapshot.settings.quiet=true',
  'snapshot.settings.focusMode=true',
  'snapshot.settings.meetingMode=true',
  'locked=true',
  'observationVisible=false',
  'desktopShown=false;document.hidden=true',
  "snapshot.settings.observation.mode='off'",
]) {
  h = harness();
  h.run(`typingState=null;${blocked};showObservationState()`);
  await h.run('analyze(false)');
  assert.equal(h.requests.length, 0, blocked);
}

// A lock signal still cancels a pending automatic reply when typing is unavailable.
h = harness();
h.run('handleActivity({typing:null,locked:false})');
automatic = h.run('analyze(false)');
h.run('handleActivity({typing:null,locked:true})');
assert.match(h.data.observation.status, /화면 잠금.*쉬는 중/);
h.requests[0].resolve(reply('locked-unknown'));
await automatic;
assert.equal(h.forwarded.length, 0);

// Observation stop cancels manual work immediately; direct conversation remains usable.
h = harness();
manual = h.run('analyze(true)');
await tick();
h.run('stopObservationPlayback()');
assert.equal(h.run('directBusy'), false);
assert.equal(h.data.observation.manualAnalyzing, false);
h.requests[0].resolve(reply('stopped-manual'));
await manual;
assert.equal(h.forwarded.length, 0);
let direct = h.run("send('직접 대화')");
await tick();
const directEpoch = h.run('generation');
h.run('stopObservationPlayback()');
assert.equal(h.run('generation'), directEpoch);
assert.equal(h.run('directBusy'), true);
h.requests[1].resolve(reply('direct-after-stop'));
await direct;
assert.equal(h.forwarded[0].payload.origin, 'direct');

// Manual requests retain privacy, lock, visibility, and model-preview boundaries.
for (const blocked of [
  "snapshot.settings.observation.mode='off'",
  'locked=true',
  'observationVisible=false',
  'desktopShown=false;document.hidden=true',
  "pendingModel={id:'preview'}",
]) {
  h = harness();
  h.run(blocked);
  await h.run('analyze(true)');
  assert.equal(h.requests.length, 0, blocked);
}

// Becoming hidden during async native validation cannot restore a manual reply.
h = harness();
h.deferValidation();
manual = h.run('analyze(true)');
await tick();
h.requests[0].resolve(reply('hidden-manual'));
await tick();
assert.equal(h.validations.length, 1);
h.run('observationVisible=false;stopObservationPlayback();');
h.validations[0].resolve(true);
await manual;
assert.equal(h.forwarded.length, 0);

// A new direct message supersedes manual work without a late manual busy reset.
h = harness();
manual = h.run('analyze(true)');
await tick();
direct = h.run("send('다음 대화')");
await tick();
h.requests[0].resolve(reply('old-manual'));
await manual;
assert.equal(h.run('directBusy'), true);
h.requests[1].resolve(reply('new-direct'));
await direct;
assert.deepEqual(
  h.forwarded.map((item) => item.payload.utteranceId),
  ['new-direct'],
);

// Native rejection before presentation must discard text-only and muted replies too.
for (const muted of [false, true]) {
  h = harness();
  h.deferValidation();
  h.run(
    `snapshot.settings.voiceEnabled=${muted};snapshot.settings.muted=${muted};snapshot.settings.providers.tts.model='configured';`,
  );
  manual = h.run('analyze(true)');
  await tick();
  h.requests[0].resolve(reply(muted ? 'muted-denied' : 'text-denied'));
  await tick();
  assert.equal(h.validations.length, 1);
  h.validations[0].resolve(false);
  await manual;
  assert.equal(h.data.messages, undefined);
  assert.equal(h.reactions.length, 0);
  assert.equal(h.forwarded.length, 0);
  assert.equal(h.requests.filter((item) => item.name === 'speech').length, 0);
}

// Native context may expire during TTS even if the local generation never changed.
// Reject before either the companion audio event or settings-window player is reached.
for (const companionVisible of [false, true]) {
  h = harness();
  h.deferValidation();
  h.run(
    `companionVisible=${companionVisible};desktopShown=${companionVisible};snapshot.settings.voiceEnabled=true;snapshot.settings.providers.tts.model='configured';`,
  );
  manual = h.run('analyze(true)');
  await tick();
  h.requests[0].resolve(reply('tts-denied'));
  await tick();
  h.validations[0].resolve(true);
  await tick();
  const tts = h.requests.find((item) => item.name === 'speech');
  assert.ok(tts, 'the test must reach the pending TTS request');
  const epoch = h.run('generation');
  tts.resolve({ utteranceId: 'tts-denied', audioBase64: 'AQID' });
  await tick();
  assert.equal(h.validations.length, 2);
  h.validations[1].resolve(false);
  await manual;
  assert.equal(h.run('generation'), epoch, 'native denial must work without a local cancel event');
  assert.equal(h.forwarded.filter((item) => item.event === 'speech').length, 0);
  assert.equal(h.plays.length, 0);
}

// A rejected old validation cannot remove the newer accepted reply.
h = harness();
h.deferValidation();
const rejectedOld = h.run('analyze(true)');
await tick();
h.requests[0].resolve(reply('old-denied'));
await tick();
manual = h.run('analyze(true)');
await tick();
h.requests[1].resolve(reply('new-accepted'));
await tick();
h.validations[1].resolve(true);
await manual;
h.validations[0].resolve(false);
await rejectedOld;
assert.deepEqual(
  h.forwarded.map((item) => item.payload.utteranceId),
  ['new-accepted'],
);
assert.equal(h.data.messages.at(-1).content, 'new-accepted');
assert.equal(h.run('activeOrigin'), 'manualObservation');

// Scoped native invalidation cancels pending validation only for its observation ID.
h = harness();
h.deferValidation();
manual = h.run('analyze(true)');
await tick();
h.requests[0].resolve(reply('invalidated-pending'));
await tick();
const pendingEpoch = h.run('generation');
h.run("invalidateObservation({utteranceId:'different-id'})");
assert.equal(h.run('generation'), pendingEpoch);
h.run("invalidateObservation({utteranceId:'invalidated-pending'})");
assert.notEqual(h.run('generation'), pendingEpoch);
h.validations[0].resolve(true);
await manual;
assert.equal(h.forwarded.length, 0);

// Native invalidation during the TTS request prevents both later delivery paths.
h = harness();
h.run("snapshot.settings.voiceEnabled=true;snapshot.settings.providers.tts.model='configured';");
manual = h.run('analyze(true)');
await tick();
h.requests[0].resolve(reply('invalidated-tts'));
await tick();
const pendingTts = h.requests.find((item) => item.name === 'speech');
assert.ok(pendingTts);
h.run("invalidateObservation({utteranceId:'invalidated-tts'})");
pendingTts.resolve({ utteranceId: 'invalidated-tts', audioBase64: 'AQID' });
await manual;
assert.equal(h.plays.length, 0);
assert.equal(h.forwarded.filter((item) => item.event === 'speech').length, 0);

// A late invalidation does not cancel a different observation or any direct reply.
h = harness();
manual = h.run('analyze(true)');
await tick();
h.requests[0].resolve(reply('current-observation'));
await manual;
h.run("player.session={id:'current-observation'}");
const observationEpoch = h.run('generation');
h.run("invalidateObservation({utteranceId:'previous-observation'})");
assert.equal(h.run('generation'), observationEpoch);
assert.equal(h.run('player.session.id'), 'current-observation');
h.run("invalidateObservation({utteranceId:'current-observation'})");
assert.equal(h.run('player.session'), null);
direct = h.run("send('새 직접 요청')");
await tick();
const newDirectEpoch = h.run('generation');
h.run("invalidateObservation({utteranceId:'current-observation'})");
assert.equal(h.run('generation'), newDirectEpoch);
assert.equal(h.run('directBusy'), true);
h.requests[1].resolve(reply('current-direct'));
await direct;
h.run("invalidateObservation({utteranceId:'current-direct'})");
assert.equal(h.run('generation'), newDirectEpoch);
assert.equal(h.run('activeOrigin'), 'direct');
console.log(
  'observation controller: 20 manual/proactive priority, unknown activity, privacy, native-denial, scoped invalidation, and late-response scenarios passed',
);
