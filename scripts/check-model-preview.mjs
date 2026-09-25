// 실제 main 컨트롤러의 가져오기·미리보기·확정 순서 검사. IPC/렌더링만 대체한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const operations = [];
const mappings = new Map();
const events = new Map();
const saved = {
  settings: {
    activeModelId: 'builtin:mao',
    observation: { mode: 'off' },
    providers: { tts: {} },
    muted: false,
  },
  models: [],
  memories: ['kept'],
};
let nextToken = 0;
let imports = 0;
let failLoad = false;
let failSave = false;
let failSwitch = false;
let deferMetadata = false;
let resolveMetadata;
let memoryWrite;
let personalityWrite;
let failSnapshot = false;
const memoryCompletions = [];
const personalityCompletions = [];
const notifications = [];
const merge = (base, patch) => {
  const value = { ...base };
  for (const [key, item] of Object.entries(patch))
    value[key] =
      item && typeof item === 'object' && !Array.isArray(item)
        ? merge(base?.[key] ?? {}, item)
        : item;
  return value;
};
const app = {
  data: { character: {}, modelPreview: {}, observation: {} },
  previewElement: {},
  update(patch) {
    this.data = merge(this.data, patch);
  },
  addEventListener(type, handler) {
    events.set(type, handler);
  },
  notify(message) {
    notifications.push(message);
  },
  completeMemorySave(...args) {
    memoryCompletions.push(args);
  },
  completePersonalitySave(...args) {
    personalityCompletions.push(args);
  },
  openImport() {
    this.importOpen = true;
  },
  closeImport() {
    this.importOpen = false;
  },
  navigate() {},
  clearMappingDraft() {},
};
class Renderer {
  async load(source) {
    operations.push(['load', source.url]);
    if (failLoad) {
      failLoad = false;
      throw new Error('Core rejected');
    }
    this.mapping = { mouthOpen: 'ParamA', ...(source.mapping ?? {}) };
    return {
      parameters: [{ id: 'ParamA', minimum: 0, maximum: 1, default: 0 }],
      expressions: ['smile'],
      capabilities: [],
      warnings: [],
      mapping: this.mapping,
    };
  }
  validateMapping(mapping) {
    assert.ok(mapping.mouthOpen === 'ParamA' || mapping.mouthOpen === '');
  }
  setMapping(mapping) {
    this.validateMapping(mapping);
    this.mapping = { ...this.mapping, ...mapping };
    return { mapping: this.mapping, capabilities: [] };
  }
  setOptions() {}
  setPaused() {}
  react() {}
  cancelSpeech() {}
  setMouth() {}
  dispose() {}
}
const call = async (name, args = {}) => {
  operations.push([name, structuredClone(args)]);
  if (name === 'snapshot') {
    if (failSnapshot) {
      failSnapshot = false;
      throw new Error('snapshot unavailable');
    }
    return structuredClone(saved);
  }
  if (name === 'save_memory') {
    await memoryWrite;
    const memory = { ...args.input, id: args.input.id ?? `memory${saved.memories.length}` };
    saved.memories.push(memory);
    return memory;
  }
  if (name === 'save_settings') {
    await personalityWrite;
    saved.settings = { ...saved.settings, ...structuredClone(args.patch) };
    return structuredClone(saved.settings);
  }
  if (name === 'cancel_speech' || name === 'discard_import') return;
  if (name === 'inspect_model')
    return {
      token: `token${++nextToken}`,
      candidates: [{ valid: true, entrypoint: 'sample.model3.json', name: 'Sample' }],
    };
  if (name === 'import_model') {
    const model = { id: `import${++imports}`, name: 'Sample' };
    saved.models.push(model);
    return model;
  }
  if (name === 'save_model_metadata') {
    assert.ok(args.metadata.parameters[0].minimum === 0);
    assert.ok(args.metadata.parameters[0].maximum === 1);
    if (deferMetadata) {
      deferMetadata = false;
      return new Promise((resolve) => {
        resolveMetadata = resolve;
      });
    }
    return;
  }
  if (name === 'save_model_mapping') {
    if (failSave) {
      failSave = false;
      throw new Error('disk unavailable');
    }
    mappings.set(args.id, structuredClone(args.mapping));
    return;
  }
  if (name === 'switch_model') {
    if (failSwitch) {
      failSwitch = false;
      throw new Error('activation failed');
    }
    saved.settings.activeModelId = args.id;
    if (!args.preserveIdentity) saved.memories = [];
    return structuredClone(saved.settings);
  }
  throw new Error(`Unexpected command ${name}`);
};
const sandbox = {
  console,
  crypto: webcrypto,
  structuredClone,
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval() {},
  document: { hidden: false, querySelector: () => app, addEventListener() {} },
  window: { addEventListener() {} },
  native: true,
  call,
  on: async () => () => {},
  toCompanion: async () => {},
  uiSnapshot: (value) => ({
    character: { id: value.settings.activeModelId, models: value.models },
  }),
  builtinModels: [],
  modelSource: async (id) => ({ url: id, name: id, mapping: mappings.get(id) ?? {} }),
  inspectedModelSource: (inspection, entrypoint) => ({
    url: entrypoint,
    name: 'Sample',
    mapping: {},
    token: inspection.token,
  }),
  CharacterRenderer: Renderer,
  SpeechPlayer: class {
    cancel() {}
    prepare() {}
    setMuted() {}
    dispose() {}
  },
  VoiceRecorder: class {
    constructor() {
      this.state = 'idle';
    }
    cancel() {}
    dispose() {}
  },
};
vm.createContext(sandbox);
let source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const importPattern = /^import[\s\S]*?;\n/gm;
assert.equal([...source.matchAll(importPattern)].length, 7, 'main import boundary changed');
source = source.replace(importPattern, '');
const startupPattern = /initialize\(\)\.catch\(\(err\) => \{[\s\S]*?\n\}\);/g;
assert.equal([...source.matchAll(startupPattern)].length, 1, 'main startup boundary changed');
source = source.replace(startupPattern, '');
vm.runInContext(source, sandbox);
const run = (code) => vm.runInContext(code, sandbox);
await run('refresh()');
await run("loadModel('builtin:mao')");
operations.length = 0;

// Loading/previewing never imports, activates, or resets memories.
await run("inspect('/sample.zip', false)");
assert.equal(imports, 0);
assert.equal(saved.settings.activeModelId, 'builtin:mao');
assert.deepEqual(saved.memories, ['kept']);
assert.equal(run('pendingModel.kind'), 'import');
assert.equal(app.data.modelPreview.active, true);
assert.equal(app.importOpen, false);
assert.ok(
  !operations.some(([name]) =>
    ['import_model', 'switch_model', 'save_model_mapping', 'save_model_metadata'].includes(name),
  ),
);
// Preview mapping applies immediately; cancelling restores the original model.
run("previewModelMapping({mouthOpen:''})");
assert.equal(run('renderer.mapping.mouthOpen'), '');
assert.equal(mappings.size, 0);
await run('cancelModelPreview()');
assert.equal(run('loadedId'), 'builtin:mao');
assert.equal(app.data.modelPreview.active, false);
assert.deepEqual(saved.memories, ['kept']);
assert.equal(imports, 0);
assert.ok(operations.some(([name]) => name === 'discard_import'));

// Explicit acceptance is the first point that persists and changes identity.
operations.length = 0;
await run("inspect('/sample.zip', false)");
await run('acceptModelPreview()');
assert.equal(imports, 1);
assert.equal(saved.settings.activeModelId, 'import1');
assert.deepEqual(saved.memories, []);
assert.equal(run('pendingModel'), null);
const order = operations.map(([name]) => name);
assert.ok(order.indexOf('load') < order.indexOf('import_model'));
assert.ok(order.indexOf('import_model') < order.indexOf('save_model_metadata'));
assert.ok(order.indexOf('save_model_metadata') < order.indexOf('save_model_mapping'));
assert.ok(order.indexOf('save_model_mapping') < order.indexOf('switch_model'));

// Existing model switching has the same preview and explicit acceptance boundary.
operations.length = 0;
await run("activateModel('builtin:haru', true)");
assert.equal(saved.settings.activeModelId, 'import1');
assert.ok(!operations.some(([name]) => name === 'switch_model'));
await run('cancelModelPreview()');
assert.equal(run('loadedId'), 'import1');

// Core failure cannot import or clear identity, and restores the current model.
operations.length = 0;
failLoad = true;
await assert.rejects(run("inspect('/broken.zip', false)"), /Core rejected/);
assert.equal(run('pendingModel'), null);
assert.equal(run('loadedId'), 'import1');
assert.equal(imports, 1);
assert.ok(!operations.some(([name]) => name === 'switch_model'));
assert.equal(app.importOpen, true, 'Core 실패는 후보 선택 화면에서 재시도할 수 있어야 함');
assert.ok(run('inspection?.candidates[0].valid'));
assert.ok(app.data.importState.error.includes('Core rejected'));

// Failed mapping persistence restores the saved baseline after a local preview.
const baseline = run('mappingBaseline.mouthOpen');
run("previewModelMapping({mouthOpen:''})");
failSave = true;
await assert.rejects(run("saveModelMapping({mouthOpen:''})"), /disk unavailable/);
assert.equal(run('renderer.mapping.mouthOpen'), baseline);
assert.equal(run('mappingCurrent.mouthOpen'), baseline);

// An unrelated settings event must not replace a staged preview with the old model.
await run("activateModel('builtin:haru', true)");
await run('applySettings({...snapshot.settings, quiet:true})');
assert.equal(run('loadedId'), 'builtin:haru');
assert.equal(run('pendingModel.id'), 'builtin:haru');
await run('cancelModelPreview()');
// Failed activation must restore a target model's previously saved mapping.
await run("activateModel('builtin:haru', true)");
run("previewModelMapping({mouthOpen:''})");
failSwitch = true;
await assert.rejects(run('acceptModelPreview()'), /activation failed/);
assert.equal(mappings.get('builtin:haru').mouthOpen, 'ParamA');
assert.equal(saved.settings.activeModelId, 'import1');
assert.equal(run('loadedId'), 'import1');

// A late metadata response cannot overwrite details of a later model load.
deferMetadata = true;
const lateLoad = run("loadModel('builtin:mao')");
for (let i = 0; i < 6; i++) await Promise.resolve();
assert.ok(resolveMetadata);
await run("loadModel('builtin:haru')");
resolveMetadata();
await lateLoad;
assert.equal(app.data.character.id, 'builtin:haru');
assert.equal(run('loadedId'), 'builtin:haru');
await run("loadModel('import1')");

// Cancellation discards staging even if restoring the previous model fails.
await run("inspect('/sample.zip', true)");
const discardedToken = run('pendingModel.token');
failLoad = true;
await assert.rejects(run('cancelModelPreview()'), /Core rejected/);
assert.equal(run('pendingModel'), null);
assert.equal(run('inspection'), null);
assert.ok(
  operations.some(([name, args]) => name === 'discard_import' && args.token === discardedToken),
);

// Memory dialogs acknowledge the actual write, not submission or snapshot refresh.
const action = (detail) => events.get('action')({ detail });
const draft = {
  type: 'memory-save',
  requestId: 1,
  id: null,
  content: '시험은 다음 주',
  expiresAt: null,
};
let resolveWrite;
memoryWrite = new Promise((resolve) => {
  resolveWrite = resolve;
});
const pendingMemory = action(draft);
assert.equal(memoryCompletions.length, 0, 'must keep draft open until commit');
resolveWrite();
await pendingMemory;
assert.deepEqual(memoryCompletions.pop(), [1]);
assert.equal(saved.memories.at(-1).text, draft.content);

const countBeforeFailure = saved.memories.length;
memoryWrite = Promise.reject(new Error('disk unavailable'));
await action({ ...draft, requestId: 2 });
assert.deepEqual(memoryCompletions.pop(), [2, 'Error: disk unavailable']);
assert.equal(saved.memories.length, countBeforeFailure);

memoryWrite = Promise.resolve();
failSnapshot = true;
await action({ ...draft, requestId: 3 });
assert.deepEqual(memoryCompletions.splice(0), [[3]], 'committed insert cannot become retryable');
assert.equal(saved.memories.length, countBeforeFailure + 1);
assert.ok(notifications.at(-1).startsWith('기억은 저장됐지만'));

sandbox.native = false;
await action({ ...draft, requestId: 4 });
assert.equal(memoryCompletions.at(-1)[0], 4);
assert.match(memoryCompletions.at(-1)[1], /데스크톱 앱/);
assert.equal(saved.memories.length, countBeforeFailure + 1);

// Personality drafts commit only after native persistence and preserve other settings.
sandbox.native = true;
const profile = {
  userAddress: '선배',
  relationship: '장난을 치는 친구',
  appearance: '짧은 은빛 머리',
  personalityPrompt: '장난을 좋아하지만 힘들 때는 다정하게 챙긴다.',
  speechStyle: '짧은 반말',
  dialogueExamples: '쉬자고 하면: 잠깐 같이 쉬자!',
};
const personalityDraft = {
  type: 'personality-save',
  requestId: 11,
  personality: {
    preset: 'tsundere',
    characterName: '루나',
    profile,
    intensity: 0.7,
    frequency: 0.4,
    jealousy: false,
    jealousyIntensity: 0.3,
    jealousyFrequency: 0.2,
  },
};
const previousSettings = structuredClone(saved.settings);
const previousMemories = structuredClone(saved.memories);
personalityWrite = new Promise((resolve) => {
  resolveWrite = resolve;
});
const pendingPersonality = action(personalityDraft);
assert.equal(personalityCompletions.length, 0, 'draft remains pending until settings commit');
assert.deepEqual(saved.settings, previousSettings);
const settingsRequest = operations.findLast(([name]) => name === 'save_settings')[1];
assert.ok(
  !('settings' in settingsRequest),
  'must send only intended changes, no stale full snapshot',
);
assert.ok(!('quiet' in settingsRequest.patch));
saved.settings.quiet = true; // Another window commits an independent preference first.
resolveWrite();
await pendingPersonality;
assert.deepEqual(personalityCompletions.pop(), [11]);
assert.deepEqual(saved.settings.characterProfile, profile);
assert.equal(saved.settings.quiet, true);
assert.equal(saved.settings.characterName, '루나');
assert.deepEqual(saved.settings.providers, previousSettings.providers);
assert.deepEqual(saved.settings.observation, previousSettings.observation);
assert.equal(saved.settings.activeModelId, previousSettings.activeModelId);
assert.deepEqual(saved.memories, previousMemories);
assert.equal(run('snapshot.settings.characterProfile.userAddress'), '선배');

personalityWrite = Promise.reject(new Error('settings unavailable'));
await action({ ...personalityDraft, requestId: 12 });
assert.deepEqual(personalityCompletions.pop(), [12, 'Error: settings unavailable']);

// A committed settings write uses its authoritative response, no fallible refresh.
personalityWrite = Promise.resolve();
operations.length = 0;
await action({ ...personalityDraft, requestId: 13 });
assert.deepEqual(personalityCompletions.splice(0), [[13]]);
assert.ok(!operations.some(([name]) => name === 'snapshot'));
assert.equal(notifications.at(-1), '성격을 저장했어요.');

sandbox.native = false;
await action({ ...personalityDraft, requestId: 14 });
assert.equal(personalityCompletions.at(-1)[0], 14);
assert.match(personalityCompletions.at(-1)[1], /데스크톱 앱/);
console.log(
  'model preview/memory/personality controller: 18 import, preview, commit, cancellation and draft persistence scenarios passed',
);
