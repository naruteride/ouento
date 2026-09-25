// 실제 main 컨트롤러의 권한 재조회 경계. IPC만 대체하며 macOS 권한 실기를 대신하지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const imports = /^import[\s\S]*?;\n/gm;
assert.equal([...source.matchAll(imports)].length, 7, 'main import boundary changed');
source = source.replace(imports, '');
const startup = /initialize\(\)\.catch\(\(err\) => \{[\s\S]*?\n\}\);/g;
assert.equal([...source.matchAll(startup)].length, 1, 'main startup boundary changed');
source = source.replace(startup, '');

const platform = (screenPermission) => ({
  platform: 'macos',
  screenPermission,
  capabilities: [{ name: '선택 창 캡처', supported: true, detail: '권한 검사' }],
});
const merge = (base, patch) => {
  const value = { ...base };
  for (const [key, item] of Object.entries(patch))
    value[key] =
      item && typeof item === 'object' && !Array.isArray(item)
        ? merge(base?.[key] ?? {}, item)
        : item;
  return value;
};
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function harness(permission = 'denied') {
  const calls = [];
  const pending = [];
  const updates = [];
  const notifications = [];
  const actions = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const initialSnapshot = {
    platform: platform(permission),
    settings: {
      fps: 30,
      observation: { mode: 'selectedWindow', selectedWindowId: 'saved-window' },
    },
    models: ['saved-model'],
    memories: ['saved-memory'],
  };
  const draft = {
    settings: { fps: 60, scale: 1.2 },
    observation: {
      permission,
      windowId: 'unsaved-window',
      allowedApps: ['com.example.unsaved'],
      sensitiveApps: ['com.example.private'],
      cloudConsent: true,
    },
    providers: { chat: { endpoint: 'https://example.invalid', model: 'unsaved-model' } },
  };
  const app = {
    data: structuredClone(draft),
    update(patch) {
      updates.push(structuredClone(patch));
      this.data = merge(this.data, patch);
    },
    notify(message, kind) {
      notifications.push({ message, kind });
    },
    addEventListener(type, callback) {
      actions.set(type, callback);
    },
  };
  const sandbox = {
    console,
    native: true,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    initialSnapshot,
    requestResult: false,
    document: {
      hidden: false,
      querySelector: () => app,
      addEventListener(type, callback) {
        documentEvents.set(type, callback);
      },
    },
    window: {
      addEventListener(type, callback) {
        windowEvents.set(type, callback);
      },
    },
    VoiceRecorder: class {
      state = 'idle';
      cancel() {}
      dispose() {}
    },
    call: async (name) => {
      calls.push(name);
      if (name === 'get_platform_capabilities')
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      if (name === 'request_screen_permission') return sandbox.requestResult;
      if (name === 'list_windows') return [{ id: 12, title: 'Test window' }];
      throw new Error(`Unexpected command ${name}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  run('snapshot=initialSnapshot;desktopShown=true;typingState=false;');
  return {
    app,
    calls,
    pending,
    updates,
    notifications,
    draft,
    initialSnapshot,
    run,
    sandbox,
    focus: () => windowEvents.get('focus')(),
    visible: () => documentEvents.get('visibilitychange')(),
    close: () => windowEvents.get('beforeunload')(),
    action: (type) => actions.get('action')({ detail: { type } }),
    resolve: (permission) => pending.shift().resolve(platform(permission)),
  };
}

let checks = 0;
for (const [before, after] of [
  ['denied', 'granted'],
  ['granted', 'denied'],
]) {
  const h = harness(before);
  const refreshed = h.focus();
  h.resolve(after);
  await refreshed;
  assert.equal(h.app.data.observation.permission, after);
  assert.equal(h.run('snapshot.platform.screenPermission'), after);
  assert.strictEqual(h.run('snapshot.settings'), h.initialSnapshot.settings);
  assert.strictEqual(h.run('snapshot.models'), h.initialSnapshot.models);
  assert.strictEqual(h.run('snapshot.memories'), h.initialSnapshot.memories);
  assert.deepEqual(h.app.data.settings, h.draft.settings);
  assert.deepEqual(h.app.data.providers, h.draft.providers);
  for (const key of ['windowId', 'allowedApps', 'sensitiveApps', 'cloudConsent'])
    assert.deepEqual(h.app.data.observation[key], h.draft.observation[key]);
  assert.ok(h.updates.every((patch) => Object.keys(patch).every((key) => key === 'observation')));
  assert.deepEqual(h.calls, ['get_platform_capabilities']);
  assert.deepEqual(h.notifications, []);
  checks++;
}

// Focus and visibility often arrive together on returning from System Settings.
let h = harness();
const focused = h.focus();
h.visible();
const shared = h.run('refreshPlatform()');
assert.deepEqual(h.calls, ['get_platform_capabilities']);
h.resolve('granted');
await Promise.all([focused, shared]);
await tick();
assert.equal(h.updates.filter((patch) => 'permission' in patch.observation).length, 1);
assert.equal(h.run('platformRefresh'), null);
checks++;

// A hidden WebView must not request or refresh authorization.
h = harness();
h.sandbox.document.hidden = true;
h.visible();
assert.deepEqual(h.calls, []);
checks++;

// Entering Together View refreshes permission and window choices, retaining the draft selection.
h = harness();
const refreshedWindows = h.action('observation-refresh');
h.resolve('granted');
await refreshedWindows;
assert.deepEqual(h.calls, ['get_platform_capabilities', 'list_windows']);
assert.equal(h.app.data.observation.windows[0].id, '12');
assert.equal(h.app.data.observation.windowId, 'unsaved-window');
assert.equal(h.app.data.observation.permission, 'granted');
checks++;

// A failed query clears its in-flight state so the next activation can retry.
h = harness('granted');
let activated = h.focus();
h.pending.shift().reject(new Error('권한 조회 실패'));
await activated;
assert.equal(h.app.data.observation.permission, 'granted');
assert.equal(h.notifications[0].kind, 'error');
assert.equal(h.run('platformRefresh'), null);
activated = h.focus();
h.resolve('denied');
await activated;
assert.equal(h.app.data.observation.permission, 'denied');
assert.deepEqual(h.calls, ['get_platform_capabilities', 'get_platform_capabilities']);
checks++;

// Shutdown invalidates a late permission result; no state or UI can be resurrected.
h = harness();
const closing = h.focus();
h.close();
const updatesAtClose = h.updates.length;
const snapshotAtClose = h.run('snapshot');
h.resolve('granted');
await closing;
assert.equal(h.updates.length, updatesAtClose);
assert.strictEqual(h.run('snapshot'), snapshotAtClose);
assert.equal(h.app.data.observation.permission, 'denied');
await h.focus();
assert.deepEqual(h.calls, ['get_platform_capabilities']);
checks++;

for (const [requested, effective, notificationKind] of [
  [true, 'granted', 'success'],
  [false, 'denied', 'info'],
  [true, 'denied', 'info'],
]) {
  h = harness();
  h.sandbox.requestResult = requested;
  const request = h.action('permission-request');
  await tick();
  assert.deepEqual(h.calls, ['request_screen_permission', 'get_platform_capabilities']);
  h.resolve(effective);
  await request;
  assert.equal(h.app.data.observation.permission, effective);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].kind, notificationKind);
  assert.match(
    h.notifications[0].message,
    notificationKind === 'success' ? /허용되어/ : /완전히 종료한 뒤 다시/,
  );
  assert.deepEqual(h.app.data.settings, h.draft.settings);
  checks++;
}

// A permission request must not reuse a pre-grant activation check's denied result.
h = harness();
const beforeGrant = h.focus();
h.sandbox.requestResult = true;
const grantDuringRefresh = h.action('permission-request');
await tick();
assert.deepEqual(h.calls, ['get_platform_capabilities', 'request_screen_permission']);
h.resolve('denied');
await beforeGrant;
await tick();
assert.deepEqual(h.calls, [
  'get_platform_capabilities',
  'request_screen_permission',
  'get_platform_capabilities',
]);
assert.deepEqual(h.notifications, [], 'the stale denial cannot finish the explicit request');
h.resolve('granted');
await grantDuringRefresh;
assert.equal(h.app.data.observation.permission, 'granted');
assert.equal(h.notifications.length, 1);
assert.equal(h.notifications[0].kind, 'success');
assert.deepEqual(h.app.data.settings, h.draft.settings);
checks++;

// Startup and browser preview do not invoke native permission commands.
for (const state of ['snapshot=undefined', 'native=false']) {
  h = harness();
  h.run(state);
  await h.focus();
  h.visible();
  await tick();
  assert.deepEqual(h.calls, []);
  checks++;
}
console.log(`권한 컨트롤러 회귀 ${checks}개 통과`);
