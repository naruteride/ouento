import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { uiSnapshot } from '../src/bridge/api.js';

// Real component/controller methods with form and IPC doubles; no OS capture or API use.
const originals = new Map(
  ['HTMLElement', 'customElements', 'FormData'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
const install = (key, value) =>
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
after(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
install(
  'HTMLElement',
  class extends EventTarget {
    attachShadow() {
      this.shadowRoot = {};
    }
  },
);
install('customElements', { get: () => undefined, define() {} });
install(
  'FormData',
  class {
    constructor(form) {
      this.values = new Map(
        Object.values(form.elements)
          .filter((field) => !field.disabled && (field.type !== 'checkbox' || field.checked))
          .map((field) => [field.name, field.value]),
      );
    }
    get(name) {
      return this.values.get(name);
    }
    has(name) {
      return this.values.has(name);
    }
  },
);
const { OuentoApp } = await import('../src/ui/app.js');

function fixture(values = {}) {
  const app = new OuentoApp();
  const actions = [];
  const notices = [];
  app.addEventListener('action', (event) => actions.push(event.detail));
  app.notify = (message, kind) => notices.push({ message, kind });
  const elements = Object.fromEntries(
    Object.entries({
      mode: 'screen',
      windowId: '',
      allowedApps: '',
      sensitiveApps: 'com.example.private',
      cloudConsent: false,
      screenConsent: false,
      focus: false,
      meeting: false,
      ...values,
    }).map(([name, value]) => [
      name,
      {
        name,
        type: typeof value === 'boolean' ? 'checkbox' : 'text',
        value: typeof value === 'boolean' ? 'on' : value,
        checked: typeof value === 'boolean' ? value : undefined,
        disabled: false,
        dataset: { dirty: 'true' },
      },
    ]),
  );
  const form = {
    elements,
    getAttribute: (name) => (name === 'id' ? 'observation-form' : null),
    querySelectorAll: () => Object.values(elements).filter((field) => field.dataset.dirty),
  };
  return {
    app,
    actions,
    notices,
    elements,
    submit: () => app._onSubmit({ target: form, preventDefault() {} }),
  };
}

test('screen capture starts with both consents disabled and an explicit monitor option', () => {
  const f = fixture();
  assert.equal(f.app.data.observation.mode, 'off');
  assert.equal(f.app.data.observation.cloudConsent, false);
  assert.equal(f.app.data.observation.screenConsent, false);
  const html = f.app._observePage();
  assert.match(html, /name="mode" value="screen"/);
  assert.match(html, /모니터/);
});

test('unavailable typing detection is explained without presenting it as an automatic pause', () => {
  const f = fixture();
  f.app.update({ observation: { mode: 'screen', typingState: null } });
  const notices = () => f.app._observePage().split('<form id="observation-form">')[0];
  assert.match(notices(), /입력 활동 감지를 사용할 수 없어요/);
  assert.match(notices(), /자동 관찰은 입력 감지 없이 동작해요/);
  assert.doesNotMatch(notices(), /쉬어요|쉬는 중/);
  for (const pause of [
    { typingState: true },
    { typingState: null, quiet: true },
    { typingState: null, focus: true },
    { typingState: null, meeting: true },
  ]) {
    f.app.update({ observation: { quiet: false, focus: false, meeting: false, ...pause } });
    assert.match(notices(), /자동 반응을 쉬어요/);
  }
  f.app.update({ observation: { mode: 'off', typingState: null } });
  assert.doesNotMatch(notices(), /입력 활동 감지|자동 관찰은/);
});

test('window-only consent cannot authorize a monitor even with a selected window', () => {
  const f = fixture({ cloudConsent: true, windowId: '42', allowedApps: 'com.example.editor' });
  f.submit();
  assert.equal(f.actions.length, 0);
  assert.equal(f.notices[0].kind, 'error');
  assert.match(f.notices[0].message, /전체|모니터/);
  assert.equal(f.elements.windowId.value, '42');
  assert.equal(f.elements.screenConsent.checked, false);
  assert.equal(f.elements.cloudConsent.dataset.dirty, 'true');
});

test('monitor consent never substitutes for cloud transmission consent', () => {
  const f = fixture({ screenConsent: true });
  f.submit();
  assert.equal(f.actions.length, 0);
  assert.equal(f.notices[0].kind, 'error');
  assert.match(f.notices[0].message, /AI 제공자|전달/);
});

test('both consents allow a monitor without a window or allowed-app list', () => {
  const f = fixture({ cloudConsent: true, screenConsent: true });
  f.submit();
  assert.equal(f.notices.length, 0);
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].type, 'observation-save');
  assert.equal(f.actions[0].observation.mode, 'screen');
  assert.equal(f.actions[0].observation.screenConsent, true);
  assert.equal(f.actions[0].observation.cloudConsent, true);
  assert.equal(f.actions[0].observation.windowId, '');
  assert.deepEqual(f.actions[0].observation.allowedApps, []);
  assert.deepEqual(f.actions[0].observation.sensitiveApps, ['com.example.private']);
});

test('selected-window and allowed-app modes retain their existing scope requirements', () => {
  for (const mode of ['selected', 'allowed']) {
    const f = fixture({ mode, cloudConsent: true, screenConsent: true });
    f.submit();
    assert.equal(f.actions.length, 0);
    assert.equal(f.notices[0].kind, 'error');
  }
  const selected = fixture({ mode: 'selected', cloudConsent: true, windowId: '42' });
  selected.submit();
  assert.equal(selected.actions.length, 1);
  const allowed = fixture({
    mode: 'allowed',
    cloudConsent: true,
    allowedApps: 'com.example.editor',
  });
  allowed.submit();
  assert.equal(allowed.actions.length, 1);
});

test('scope change shows monitor consent instead of window and app selection', () => {
  const f = fixture();
  const sections = ['selected allowed', 'allowed', 'screen'].map((scope) => ({
    dataset: { observationScope: scope },
    hidden: false,
  }));
  const mode = { name: 'mode', value: 'off', dataset: {}, matches: () => true };
  mode.form = {
    getAttribute: () => 'observation-form',
    querySelector: () => mode,
    querySelectorAll: () => sections,
  };
  f.app.shadowRoot.getElementById = () => mode.form;
  for (const [value, hidden] of [
    ['off', [true, true, true]],
    ['selected', [false, true, true]],
    ['allowed', [false, false, true]],
    ['screen', [true, true, false]],
  ]) {
    mode.value = value;
    f.app._onChange({ target: mode });
    assert.deepEqual(
      sections.map((section) => section.hidden),
      hidden,
    );
  }
  const html = f.app._observePage();
  assert.match(html, /name="screenConsent"/);
  assert.match(html, /다른 창·알림·바탕화면/);
});

test('leaving screen mode cannot persist its hidden consent checkbox as approval', () => {
  for (const mode of ['off', 'selected', 'allowed']) {
    const f = fixture({
      mode,
      screenConsent: true,
      cloudConsent: true,
      windowId: '42',
      allowedApps: 'com.example.editor',
    });
    f.submit();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].observation.screenConsent, false);
  }
});

function snapshot(mode = 'off', screenConsent = false) {
  return {
    settings: {
      activeModelId: 'builtin:mao',
      personality: 'cat',
      jealousy: { enabled: false, intensity: 0.1, frequency: 0.1 },
      observation: {
        mode,
        selectedWindowId: null,
        cloudConsent: screenConsent,
        screenConsent,
        allowedApps: [],
        blockedApps: ['com.example.private'],
      },
      providers: {
        chat: { baseUrl: '', model: '', requiresKey: true },
        stt: { baseUrl: '', model: '', requiresKey: true },
        tts: { baseUrl: '', model: '', requiresKey: true },
        voice: '',
      },
      muted: false,
    },
    credentials: { chat: false, stt: false, tts: false },
    platform: { platform: 'macos', screenPermission: 'granted', capabilities: [] },
    models: [],
    memories: [],
  };
}

test('wire snapshot maps currentScreen to screen and missing consent remains false', () => {
  const wire = snapshot('currentScreen', true);
  const ui = uiSnapshot(wire);
  assert.equal(ui.observation.mode, 'screen');
  assert.equal(ui.observation.screenConsent, true);
  delete wire.settings.observation.screenConsent;
  assert.equal(uiSnapshot(wire).observation.screenConsent, false);
  for (const [wireMode, uiMode] of [
    ['off', 'off'],
    ['selectedWindow', 'selected'],
    ['allowedApps', 'allowed'],
  ]) {
    assert.equal(uiSnapshot(snapshot(wireMode)).observation.mode, uiMode);
  }
});

let mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const imports = /^import[\s\S]*?;\n/gm;
assert.equal([...mainSource.matchAll(imports)].length, 7, 'main import boundary changed');
mainSource = mainSource.replace(imports, '');
const startup = /initialize\(\)\.catch\(\(err\) => \{[\s\S]*?\n\}\);/g;
assert.equal([...mainSource.matchAll(startup)].length, 1, 'main startup boundary changed');
mainSource = mainSource.replace(startup, '');

function controller({
  platform = 'macos',
  screenPermission = 'granted',
  requestGranted = screenPermission === 'granted',
} = {}) {
  let saved = snapshot();
  saved.platform = { ...saved.platform, platform, screenPermission };
  const calls = [];
  const actions = new Map();
  const updates = [];
  const notices = [];
  const app = {
    update: (patch) => updates.push(structuredClone(patch)),
    notify: (text, kind) => notices.push({ text, kind }),
    addEventListener: (type, callback) => actions.set(type, callback),
  };
  const sandbox = {
    console,
    native: true,
    initialSnapshot: saved,
    uiSnapshot,
    setInterval: () => 1,
    clearInterval() {},
    document: { hidden: false, querySelector: () => app, addEventListener() {} },
    window: { addEventListener() {} },
    VoiceRecorder: class {
      state = 'idle';
    },
    call: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'save_settings') {
        saved = { ...saved, settings: { ...saved.settings, ...structuredClone(args.patch) } };
        return saved.settings;
      }
      if (name === 'snapshot') return structuredClone(saved);
      if (name === 'get_platform_capabilities') return structuredClone(saved.platform);
      if (name === 'request_screen_permission') return requestGranted;
      if (name === 'stop_observation') {
        // Rust tests own reset enforcement; here verify the controller consumes that response.
        saved.settings.observation = {
          ...saved.settings.observation,
          mode: 'off',
          selectedWindowId: null,
          cloudConsent: false,
          screenConsent: false,
        };
        return saved.settings;
      }
      throw new Error(`Unexpected command ${name}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(mainSource, sandbox);
  vm.runInContext('snapshot=initialSnapshot;desktopShown=true;', sandbox);
  return {
    calls,
    updates,
    notices,
    action: (detail) => actions.get('action')({ detail }),
    run: (code) => vm.runInContext(code, sandbox),
  };
}

test('macOS denial explains re-registering the current app without changing permission', async () => {
  const f = fixture();
  f.app.update({ platform: 'macOS', observation: { permission: 'denied' } });
  const html = f.app._observePage();
  assert.match(html, /화면 기록 목록에서 Ouento를 제거/);
  assert.match(html, /현재 사용하는 Ouento\.app을 다시 추가/);
  assert.equal(f.app.data.observation.permission, 'denied');

  // A prompt can succeed while the running executable still lacks effective access.
  for (const requestGranted of [false, true]) {
    const h = controller({ screenPermission: 'denied', requestGranted });
    await h.action({ type: 'permission-request' });
    assert.deepEqual(
      h.calls.map((call) => call.name),
      ['request_screen_permission', 'get_platform_capabilities'],
    );
    assert.equal(h.run('snapshot.platform.screenPermission'), 'denied');
    assert.ok(h.updates.some((patch) => patch.observation?.permission === 'denied'));
    assert.equal(h.notices.at(-1).kind, 'info');
    assert.match(h.notices.at(-1).text, /Ouento를 제거/);
    assert.match(h.notices.at(-1).text, /현재 사용하는 Ouento\.app을 다시 추가/);
    assert.equal(
      h.notices.some((notice) => notice.kind === 'success'),
      false,
    );
  }
});

test('effective permission success removes recovery instructions', async () => {
  const f = fixture();
  f.app.update({ platform: 'macOS', observation: { permission: 'granted' } });
  assert.match(f.app._observePage(), /화면 접근이 허용되어 있어요/);
  assert.doesNotMatch(f.app._observePage(), /Ouento를 제거/);
  const h = controller();
  await h.action({ type: 'permission-request' });
  assert.equal(h.notices.at(-1).kind, 'success');
  assert.doesNotMatch(h.notices.at(-1).text, /다시 추가|완전히 종료/);
});

test('Windows permission guidance does not ask to register a macOS app bundle', async () => {
  const f = fixture();
  f.app.update({ platform: 'Windows', observation: { permission: 'denied' } });
  assert.doesNotMatch(f.app._observePage(), /Ouento\.app|화면 기록 목록/);
  const h = controller({ platform: 'windows', screenPermission: 'denied' });
  await h.action({ type: 'permission-request' });
  assert.equal(h.notices.at(-1).kind, 'info');
  assert.doesNotMatch(h.notices.at(-1).text, /Ouento\.app|목록에서 Ouento를 제거/);
});

test('controller saves screen as currentScreen with both explicit consents', async () => {
  const f = fixture({ cloudConsent: true, screenConsent: true });
  f.submit();
  const h = controller();
  await h.action(f.actions[0]);
  const saved = h.calls.find((call) => call.name === 'save_settings').args.patch.observation;
  assert.equal(saved.mode, 'currentScreen');
  assert.equal(saved.screenConsent, true);
  assert.equal(saved.cloudConsent, true);
  assert.equal(saved.selectedWindowId, null);
  assert.deepEqual(saved.allowedApps, []);
  assert.deepEqual(saved.blockedApps, ['com.example.private']);
  assert.ok(h.updates.some((patch) => patch.observation?.mode === 'screen'));
  assert.equal(
    h.notices.some((notice) => notice.kind === 'error'),
    false,
  );
});

test('observation stop consumes revoked full-screen consent and prevents later work', async () => {
  const h = controller();
  await h.action({
    type: 'observation-save',
    observation: {
      mode: 'screen',
      windowId: '',
      cloudConsent: true,
      screenConsent: true,
      allowedApps: [],
      sensitiveApps: [],
      focus: false,
      meeting: false,
    },
  });
  await h.action({ type: 'observation-stop' });
  assert.deepEqual(
    h.calls.slice(-2).map((call) => call.name),
    ['stop_observation', 'snapshot'],
  );
  assert.equal(h.run('snapshot.settings.observation.mode'), 'off');
  assert.equal(h.run('snapshot.settings.observation.cloudConsent'), false);
  assert.equal(h.run('snapshot.settings.observation.screenConsent'), false);
  assert.equal(h.run('observationPrivacyBlocked()'), true);
  assert.ok(
    h.updates.some(
      (patch) =>
        patch.observation?.mode === 'off' &&
        patch.observation.cloudConsent === false &&
        patch.observation.screenConsent === false,
    ),
  );
});
