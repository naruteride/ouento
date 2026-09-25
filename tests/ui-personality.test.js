import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import personas from '../src/personality-presets.json' with { type: 'json' };

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
      this.values = new Map(Object.values(form.elements).map((field) => [field.name, field.value]));
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
  const values = {
    preset: 'tsundere',
    characterName: '마오',
    ...personas[0].profile,
    intensity: '0.65',
    frequency: '0.4',
    jealousyIntensity: '0.3',
    jealousyFrequency: '0.2',
  };
  const elements = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        name,
        value,
        dataset: { dirty: 'true' },
        focus() {
          this.focused = true;
        },
      },
    ]),
  );
  const quote = { textContent: '' };
  const form = {
    elements,
    getAttribute: (name) => (name === 'id' ? 'personality-form' : null),
    querySelector: (selector) => (selector === '[name="preset"]:checked' ? elements.preset : null),
    querySelectorAll: (selector) =>
      selector === '[data-dirty]'
        ? Object.values(elements).filter((field) => field.dataset.dirty)
        : [],
  };
  for (const field of Object.values(elements)) field.form = form;
  app.shadowRoot.getElementById = (id) =>
    ({ 'personality-form': form, 'persona-quote': quote })[id];
  const actions = [],
    notices = [];
  app.addEventListener('action', (event) => actions.push(event.detail));
  app.notify = (message, kind) => notices.push({ message, kind });
  const submit = () => app._onSubmit({ target: form, preventDefault() {} });
  const click = (action) =>
    app._onClick({ target: { closest: () => ({ dataset: { do: action } }) } });
  return { app, elements, form, quote, actions, notices, submit, click };
}

test('personality submits all custom fields with Unicode and multiline content intact', () => {
  const f = fixture();
  f.elements.characterName.value = '  별빛 <마오>  ';
  f.elements.userAddress.value = '선배 & 친구';
  f.elements.personalityPrompt.value = '첫 줄: <장난>\n둘째 줄: "다정하게" 😀';
  f.submit();
  const { personality, requestId } = f.actions[0];
  assert.equal(personality.characterName, '별빛 <마오>');
  assert.equal(personality.profile.userAddress, '선배 & 친구');
  assert.equal(personality.profile.personalityPrompt, f.elements.personalityPrompt.value);
  assert.equal(personality.intensity, 0.65);
  assert.equal(typeof requestId, 'number');
  for (const field of Object.values(f.elements)) assert.equal(field.dataset.dirty, 'true');
});

test('personality enforces each scalar limit rather than UTF-16 length', () => {
  const limits = {
    characterName: 40,
    userAddress: 40,
    relationship: 200,
    appearance: 1000,
    personalityPrompt: 3000,
    speechStyle: 1000,
    dialogueExamples: 3000,
  };
  for (const [name, limit] of Object.entries(limits)) {
    const accepted = fixture();
    accepted.elements[name].value = '😀'.repeat(limit);
    accepted.submit();
    assert.equal(accepted.actions.length, 1, `${name}: accepts ${limit} scalars`);
    const rejected = fixture();
    rejected.elements[name].value = '😀'.repeat(limit + 1);
    rejected.submit();
    assert.equal(rejected.actions.length, 0, `${name}: rejects ${limit + 1} scalars`);
    assert.equal(rejected.elements[name].focused, true);
    assert.equal(rejected.elements[name].dataset.dirty, 'true');
  }
  const blank = fixture();
  blank.elements.characterName.value = ' \n ';
  blank.submit();
  assert.equal(blank.actions.length, 0);
  const optional = fixture();
  for (const name of Object.keys(limits).filter((name) => name !== 'characterName'))
    optional.elements[name].value = '';
  optional.submit();
  assert.equal(optional.actions.length, 1);
  assert.equal(optional.actions[0].personality.profile.userAddress, '');
});

test('failed save retains the draft and only its matching success clears dirty fields', () => {
  const f = fixture();
  f.elements.speechStyle.value = '내 말투 초안';
  f.app._pageSnapshots.set('personality', { fields: ['draft'] });
  f.submit();
  f.submit();
  assert.equal(f.actions.length, 1, 'pending requests cannot duplicate');
  const first = f.actions[0].requestId;
  f.app.completePersonalitySave(first + 1);
  assert.equal(f.app._personalitySaveRequest, first);
  f.app.completePersonalitySave(first, '저장 실패');
  assert.equal(f.elements.speechStyle.value, '내 말투 초안');
  assert.equal(f.elements.speechStyle.dataset.dirty, 'true');
  assert.equal(f.app._personalitySaveError, '저장 실패');
  assert.equal(f.app._pageSnapshots.has('personality'), true);
  f.submit();
  const second = f.actions[1].requestId;
  f.app.completePersonalitySave(first);
  assert.equal(f.app._personalitySaveRequest, second);
  f.app.completePersonalitySave(second);
  assert.equal(f.app._personalitySaveError, '');
  assert.equal(f.app._pageSnapshots.has('personality'), false);
  assert.equal(f.app._syncPersonalityFields, true);
  for (const field of Object.values(f.elements)) assert.equal(field.dataset.dirty, undefined);
});

test('personality markup escapes names, textarea contents, and save errors', () => {
  const f = fixture();
  f.app.update({
    personality: {
      characterName: '"><img src=x onerror=alert(1)>',
      profile: { appearance: '</textarea><script>injected()</script>\n& detail' },
    },
  });
  f.app._personalitySaveError = '<svg onload=alert(1)>';
  const html = f.app._personalityPage();
  assert.ok(html.includes('&quot;&gt;&lt;img'));
  assert.ok(
    html.includes('&lt;/textarea&gt;&lt;script&gt;injected()&lt;/script&gt;\n&amp; detail'),
  );
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('고정 대사 미리보기'));
  assert.ok(!html.includes('시험에 합격'));
});

test('example loading is explicit and leaves the custom name intact', () => {
  const f = fixture();
  f.elements.characterName.value = '나의 캐릭터';
  f.elements.personalityPrompt.value = '커스텀 초안';
  f.elements.preset.value = 'cat';
  f.app._updatePersonaQuote();
  assert.equal(f.elements.personalityPrompt.value, '커스텀 초안');
  f.click('personality-load-example');
  assert.equal(f.elements.personalityPrompt.value, personas[1].profile.personalityPrompt);
  assert.equal(f.elements.characterName.value, '나의 캐릭터');
  assert.equal(f.actions.length, 0, 'loading templates must not silently persist');
});

test('fixed preview uses the draft address, supports no address, and never requests exam scenes', () => {
  const f = fixture();
  f.elements.userAddress.value = '언니';
  f.click('personality-preview');
  assert.equal(f.actions[0].scene, 'taking-a-break');
  assert.equal(f.actions[0].userAddress, '언니');
  assert.ok(f.actions[0].text.startsWith('언니, '));
  f.elements.userAddress.value = '';
  f.app._updatePersonaQuote();
  assert.ok(f.quote.textContent.startsWith('“잠깐 쉬어.'));
  assert.ok(!f.quote.textContent.includes('{{userAddress}}'));
});
