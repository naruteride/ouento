import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Exercise the real component methods without pretending this is a native DOM test.
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

function field(name, value = '') {
  return {
    name,
    value,
    disabled: false,
    dataset: { dirty: 'true' },
    focus() {
      this.focused = true;
    },
  };
}
function form(id, values) {
  const elements = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, field(key, value)]),
  );
  const submit = { disabled: false, textContent: '기억 저장' };
  return {
    elements,
    submit,
    attributes: {},
    resetCount: 0,
    getAttribute: (name) => (name === 'id' ? id : null),
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelector: (selector) => (selector === '[type="submit"]' ? submit : null),
    querySelectorAll: (selector) =>
      selector === '[data-dirty]'
        ? Object.values(elements).filter((item) => item.dataset.dirty)
        : [],
    reset() {
      this.resetCount++;
      for (const item of Object.values(elements)) item.value = '';
    },
  };
}
function shadow() {
  const memory = form('memory-form', { id: '', content: '', expiresAt: '' });
  const chat = form('chat-form', { text: '' });
  const cancel = { dataset: { do: 'close-memory' }, disabled: false };
  const close = { dataset: { do: 'close-memory' }, disabled: false };
  const dialog = {
    open: false,
    closeCount: 0,
    listeners: new Map(),
    querySelectorAll: () => [...Object.values(memory.elements), memory.submit, cancel, close],
    addEventListener(name, callback) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.closeCount++;
    },
  };
  const elements = new Map([
    ['memory-form', memory],
    ['memory-dialog', dialog],
    ['memory-error', { textContent: '', hidden: true }],
    ['memory-title', { textContent: '' }],
    ['chat-form', chat],
    ['chat-text', chat.elements.text],
  ]);
  return {
    memory,
    chat,
    dialog,
    cancel,
    close,
    getElementById: (id) => elements.get(id),
    addEventListener() {},
  };
}
install(
  'HTMLElement',
  class extends EventTarget {
    attachShadow() {
      this.shadowRoot = shadow();
    }
  },
);
install('customElements', { get: () => undefined, define() {} });
install(
  'FormData',
  class {
    constructor(target) {
      this.values = new Map(
        Object.values(target.elements)
          .filter((item) => !item.disabled)
          .map((item) => [item.name, item.value]),
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

function fixture() {
  const app = new OuentoApp();
  const actions = [];
  const notices = [];
  app.addEventListener('action', (event) => actions.push(event.detail));
  app.notify = (message, kind) => notices.push({ message, kind });
  app.render = () => {};
  app.connectedCallback();
  app._openMemory();
  const { memory, chat, dialog } = app.shadowRoot;
  const submit = (target = memory) => app._onSubmit({ target, preventDefault() {} });
  const error = app.shadowRoot.getElementById('memory-error');
  return { app, actions, notices, memory, chat, dialog, submit, error };
}

test('memory accepts 1,000 Unicode scalars including emoji and trims its payload', () => {
  for (const content of ['가'.repeat(1000), '😀'.repeat(1000)]) {
    const f = fixture();
    f.memory.elements.content.value = `  ${content}  `;
    f.submit();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].type, 'memory-save');
    assert.equal(f.actions[0].content, content);
    assert.equal(f.actions[0].expiresAt, null);
    assert.equal(typeof f.actions[0].requestId, 'number');
    assert.equal(f.dialog.open, true);
  }
});

test('memory rejects 1,001 Unicode scalars and whitespace without discarding the draft', () => {
  for (const content of ['가'.repeat(1001), '😀'.repeat(1001), ' \n\t ']) {
    const f = fixture();
    f.memory.elements.content.value = content;
    f.submit();
    assert.equal(f.actions.length, 0);
    assert.equal(f.memory.elements.content.value, content);
    assert.equal(f.dialog.open, true);
    assert.equal(f.error.hidden, false);
    assert.match(f.error.textContent, /1~1,000/);
  }
});

test('memory rejects expired, invalid, and rolled-over calendar dates before emitting', () => {
  for (const expiry of ['2000-01-01', 'not-a-date', '2099-02-31']) {
    const f = fixture();
    f.memory.elements.content.value = '날짜 확인';
    f.memory.elements.expiresAt.value = expiry;
    assert.doesNotThrow(() => f.submit());
    assert.equal(f.actions.length, 0);
    assert.equal(f.memory.elements.expiresAt.value, expiry);
    assert.equal(f.dialog.open, true);
    assert.match(f.error.textContent, /유효한 날짜/);
  }
});

test('memory sends a future local end-of-day expiry', () => {
  const f = fixture();
  f.memory.elements.content.value = '기억';
  f.memory.elements.expiresAt.value = '2099-03-01';
  f.submit();
  assert.equal(f.actions[0].expiresAt, new Date('2099-03-01T23:59:59').toISOString());
});

test('pending save blocks duplicate submit, close buttons and Escape with one handler', () => {
  const f = fixture();
  f.app.connectedCallback();
  assert.equal(f.dialog.listeners.get('cancel').length, 1);
  f.memory.elements.content.value = '저장 중 초안';
  f.submit();
  f.submit();
  assert.equal(f.actions.length, 1);
  assert.equal(f.memory.attributes['aria-busy'], 'true');
  for (const control of f.dialog.querySelectorAll()) assert.equal(control.disabled, true);
  f.app._onClick({ target: { closest: () => f.app.shadowRoot.close } });
  let prevented = false;
  f.dialog.listeners.get('cancel')[0]({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(f.dialog.open, true);
});

test('failed save preserves all fields, shows the backend error and unlocks retry and close', () => {
  const f = fixture();
  f.memory.elements.id.value = 'existing-id';
  f.memory.elements.content.value = '변경한 기억';
  f.memory.elements.expiresAt.value = '2099-03-01';
  f.submit();
  f.app.completeMemorySave(f.actions[0].requestId, '저장소 쓰기에 실패했어요.');
  assert.equal(f.dialog.open, true);
  assert.equal(f.memory.elements.id.value, 'existing-id');
  assert.equal(f.memory.elements.content.value, '변경한 기억');
  assert.equal(f.memory.elements.expiresAt.value, '2099-03-01');
  assert.equal(f.error.textContent, '저장소 쓰기에 실패했어요.');
  assert.equal(f.error.hidden, false);
  assert.equal(f.memory.attributes['aria-busy'], 'false');
  for (const control of f.dialog.querySelectorAll()) assert.equal(control.disabled, false);
  let prevented = false;
  f.dialog.listeners.get('cancel')[0]({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
  f.submit();
  assert.equal(f.actions.length, 2);
  assert.notEqual(f.actions[1].requestId, f.actions[0].requestId);
  assert.equal(f.error.hidden, true);
});

test('success closes only its matching request and ignores stale acknowledgments', () => {
  const f = fixture();
  f.memory.elements.content.value = '초안';
  f.submit();
  const previous = f.actions[0].requestId;
  f.app.completeMemorySave(previous + 1);
  assert.equal(f.dialog.open, true);
  assert.equal(f.memory.submit.disabled, true);
  f.app.completeMemorySave(previous, '다시 시도해 주세요.');
  f.submit();
  const current = f.actions[1].requestId;
  f.app.completeMemorySave(previous);
  f.app.completeMemorySave(previous, '오래된 오류');
  assert.equal(f.dialog.open, true);
  assert.equal(f.memory.submit.disabled, true);
  assert.equal(f.error.hidden, true);
  f.app.completeMemorySave(current);
  assert.equal(f.dialog.open, false);
  assert.equal(f.dialog.closeCount, 1);
  assert.equal(f.memory.submit.disabled, false);
  f.app.completeMemorySave(current);
  assert.equal(f.dialog.closeCount, 1);
});

test('chat rejects more than 4,000 Unicode scalars before reset and accepts 4,000 emoji', () => {
  for (const content of ['가'.repeat(4001), '😀'.repeat(4001)]) {
    const f = fixture();
    f.chat.elements.text.value = content;
    f.submit(f.chat);
    assert.equal(f.actions.length, 0);
    assert.equal(f.chat.elements.text.value, content);
    assert.equal(f.chat.resetCount, 0);
    assert.match(f.notices[0].message, /1~4,000/);
  }
  const f = fixture();
  const content = '😀'.repeat(4000);
  f.chat.elements.text.value = content;
  f.submit(f.chat);
  assert.equal(f.actions[0].text, content);
  assert.equal(f.actions[0].type, 'chat-send');
  assert.equal(f.chat.resetCount, 1);
});
