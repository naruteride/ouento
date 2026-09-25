// Development-only DOM regression fixture; no controller, native IPC, or provider imports.
import '../../src/ui/app.js';

const app = document.querySelector('ouento-app');
const root = app.shadowRoot;
const status = document.querySelector('#status');
const checks = document.querySelector('#checks');
const output = document.querySelector('#report');
const runButton = document.querySelector('#run');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const query = (selector) => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`검사할 요소가 없습니다: ${selector}`);
  return node;
};
const fakeWindows = [
  {
    id: 'fixture-window-a',
    appId: 'fixture.editor',
    title: '합성 문서 A',
    appName: '검사용 편집기',
  },
  { id: 'fixture-window-b', appId: 'fixture.viewer', title: '합성 문서 B', appName: '검사용 뷰어' },
];
let report;

function check(name, passed, detail = '') {
  report.checks.push({ name, passed: !!passed, detail });
  const row = document.createElement('li');
  row.dataset.passed = String(!!passed);
  row.textContent = `${passed ? '통과' : '실패'} · ${name}${detail ? ` — ${detail}` : ''}`;
  checks.append(row);
  output.textContent = JSON.stringify(report, null, 2);
}

function selectText(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) if (node.textContent.trim()) break;
  if (!node) throw new Error('선택할 텍스트 노드가 없습니다.');
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(node.length, 8));
  const selection = root.getSelection?.() || window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  if (!text) throw new Error('브라우저가 Shadow DOM 텍스트 선택을 만들지 못했습니다.');
  return {
    retained: () =>
      node.isConnected &&
      range.startContainer === node &&
      range.endContainer === node &&
      range.toString() === text &&
      selection.toString() === text,
    clear: () => selection.removeAllRanges(),
  };
}

// Count JavaScript scroll resets without changing the browser's own scrolling behavior.
function trackScrollWrites(element) {
  let prototype = element;
  let descriptor;
  while (prototype && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop');
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!descriptor?.get || !descriptor?.set)
    throw new Error('브라우저 scrollTop 속성을 검사할 수 없습니다.');
  const own = Object.getOwnPropertyDescriptor(element, 'scrollTop');
  let writes = 0;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      writes++;
      descriptor.set.call(this, value);
    },
  });
  return {
    get count() {
      return writes;
    },
    restore() {
      if (own) Object.defineProperty(element, 'scrollTop', own);
      else delete element.scrollTop;
    },
  };
}

async function activityTicks() {
  // Match the real 500 ms activity refresh, including changes to visible status.
  for (let tick = 0; tick < 3; tick++) {
    await wait(500);
    app.update({
      observation: {
        status: `합성 활동 상태 ${tick + 1}`,
        typingState: tick % 2 === 0,
      },
    });
  }
}

async function settingsChecks() {
  app.navigate('settings');
  const form = query('#settings-form');
  const fps = query('#settings-form [name="fps"]');
  const option = fps.options[1];
  fps.focus();
  const scroll = trackScrollWrites(query('.main'));
  try {
    await activityTicks();
    check(
      '프레임 속도 select와 옵션 DOM 유지',
      query('#settings-form [name="fps"]') === fps && fps.options[1] === option,
    );
    check('프레임 속도 select 포커스 유지', root.activeElement === fps);
    check('설정 폼 DOM 유지', query('#settings-form') === form);
    check('주기 갱신 중 main.scrollTop 강제 대입 없음', scroll.count === 0, `${scroll.count}회`);
  } finally {
    scroll.restore();
  }

  const model = query('#provider-chat-form [name="model"]');
  model.value = 'fixture-unsaved-model';
  model.dispatchEvent(new Event('input', { bubbles: true }));
  model.focus();
  model.setSelectionRange(2, 9);
  app.update({ providers: { chat: { configured: true, model: 'fixture-server-model' } } });
  check(
    '서버 상태 갱신 중 미저장 입력과 선택 범위 유지',
    query('#provider-chat-form [name="model"]') === model &&
      model.value === 'fixture-unsaved-model' &&
      model.selectionStart === 2 &&
      model.selectionEnd === 9 &&
      root.activeElement === model,
  );

  model.blur();
  const headingSelection = selectText(query('#page-title'));
  app.update({ observation: { status: '합성 제목 선택 중' } });
  check('공통 제목의 드래그 텍스트 선택 유지', headingSelection.retained());
  headingSelection.clear();
  const pageSelection = selectText(query('#settings-form h2'));
  app.update({ settings: { muted: true } });
  check('페이지 내용 변경 시 변경되지 않은 본문 선택 유지', pageSelection.retained());
  pageSelection.clear();
}

async function observationChecks() {
  app.update({
    observation: {
      mode: 'selected',
      windowId: fakeWindows[0].id,
      cloudConsent: true,
      permission: 'denied',
      windows: fakeWindows,
      typingState: false,
    },
  });
  app.navigate('observe');
  const form = query('#observation-form');
  const field = query('#observation-form [name="windowId"]');
  field.value = fakeWindows[1].id;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.focus();
  const option = [...field.options].find((item) => item.value === fakeWindows[1].id);
  const scroll = trackScrollWrites(query('.main'));
  try {
    await activityTicks();
    check(
      '함께 볼 창 select와 옵션 DOM 유지',
      query('#observation-form [name="windowId"]') === field && [...field.options].includes(option),
    );
    check(
      '함께 볼 창 미저장 선택과 포커스 유지',
      field.value === fakeWindows[1].id && root.activeElement === field,
    );
    check(
      '함께 보기 갱신 중 main.scrollTop 강제 대입 없음',
      scroll.count === 0,
      `${scroll.count}회`,
    );
  } finally {
    scroll.restore();
  }
  const denied = query('#page-panel').textContent;
  app.update({ observation: { permission: 'granted', error: '' } });
  const granted = query('#page-panel').textContent;
  check(
    '권한 denied → granted 상태가 즉시 화면에 반영',
    denied.includes('현재 실행 중인 Ouento에는 화면 접근이 적용되지 않았어요.') &&
      granted.includes('화면 접근이 허용되어 있어요.') &&
      !granted.includes('현재 실행 중인 Ouento에는 화면 접근이 적용되지 않았어요.'),
  );
  check(
    '권한 상태 변경 중 함께 보기 폼과 select 유지',
    query('#observation-form') === form &&
      query('#observation-form [name="windowId"]') === field &&
      field.value === fakeWindows[1].id,
  );
}

async function chatChecks() {
  const messages = Array.from({ length: 28 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `합성 대화 ${index + 1} · 스크롤과 텍스트 선택 검사용 문장입니다.`,
    time: '12:00',
  }));
  app.update({ messages });
  app.navigate('chat');
  const chat = query('.chat-body');
  chat.scrollTop = 40;
  const initialScroll = chat.scrollTop;
  const chatWrites = trackScrollWrites(chat);
  const mainWrites = trackScrollWrites(query('.main'));
  const selection = selectText(query('.message-bubble'));
  try {
    await activityTicks();
    check('대화 로그 DOM과 텍스트 선택 유지', query('.chat-body') === chat && selection.retained());
    check(
      '주기 갱신 중 대화 스크롤 강제 대입 없음',
      chatWrites.count === 0,
      `${chatWrites.count}회`,
    );
    check(
      '대화 페이지 main.scrollTop 강제 대입 없음',
      mainWrites.count === 0,
      `${mainWrites.count}회`,
    );
    check('읽고 있던 대화 스크롤 위치 유지', chat.scrollTop === initialScroll);
  } finally {
    chatWrites.restore();
    mainWrites.restore();
    selection.clear();
  }
  app.update({
    messages: [...messages, { role: 'assistant', content: '합성 새 메시지', time: '12:01' }],
  });
  check(
    '새 메시지는 표시하되 과거 대화 읽기 위치 유지',
    query('.chat-body').textContent.includes('합성 새 메시지') &&
      query('.chat-body').scrollTop === initialScroll,
  );
  app.navigate('settings');
  app.update({
    messages: [
      ...app.data.messages,
      { role: 'assistant', content: '다른 페이지에서 온 합성 메시지' },
    ],
  });
  app.navigate('chat');
  const restoredScroll = query('.chat-body').scrollTop;
  const readingPositionRestored = initialScroll > 0 && restoredScroll === initialScroll;
  const returnedChat = query('.chat-body');
  returnedChat.scrollTop = returnedChat.scrollHeight;
  app.navigate('settings');
  app.update({
    messages: [...app.data.messages, { role: 'assistant', content: '최신 합성 메시지' }],
  });
  app.navigate('chat');
  const latestChat = query('.chat-body');
  check(
    '대화 페이지 재진입 시 중간 읽기 위치 또는 최신 하단 복원',
    readingPositionRestored &&
      // CSSOM heights are rounded; the native scroll limit can differ by a pixel.
      Math.abs(latestChat.scrollHeight - latestChat.clientHeight - latestChat.scrollTop) <= 2,
    JSON.stringify({
      initialScroll,
      restoredScroll,
      latestTop: latestChat.scrollTop,
      latestHeight: latestChat.scrollHeight,
      latestClient: latestChat.clientHeight,
    }),
  );
}

async function mappingResetChecks() {
  app.update({
    character: {
      id: 'fixture-model',
      loaded: true,
      mapping: { layout_scale: '1' },
    },
  });
  app.navigate('character');
  const form = query('#mapping-form');
  const details = form.closest('details');
  details.open = true;
  const scale = form.elements.layout_scale;
  const output = scale.parentElement.querySelector('output');
  scale.value = '1.4';
  scale.dispatchEvent(new Event('input', { bubbles: true }));
  // Mirror a successful model preview followed by the controller's reset response.
  app.update({ character: { mapping: { layout_scale: '1.4' } } });
  app.clearMappingDraft();
  app.update({ character: { mapping: { layout_scale: '1' } } });
  check(
    '매핑 변경 취소가 입력 프로퍼티와 표시값을 함께 복구',
    scale.value === '1' && output.textContent === '100%' && !scale.hasAttribute('data-dirty'),
  );
  check(
    '매핑 변경 취소 시 폼·슬라이더·펼친 설정 유지',
    query('#mapping-form') === form && form.elements.layout_scale === scale && details.open,
  );

  // If preview validation rejects an edit, the state/template never changes.
  // Reset must still discard the edited value despite an identical HTML cache.
  scale.value = '1.6';
  scale.dispatchEvent(new Event('input', { bubbles: true }));
  app.clearMappingDraft();
  app.update({ character: { mapping: { layout_scale: '1' } } });
  check(
    '미리보기 거부 후 동일 상태로 취소해도 입력 복구',
    scale.value === '1' && output.textContent === '100%' && !scale.hasAttribute('data-dirty'),
  );
}

async function run() {
  runButton.disabled = true;
  status.removeAttribute('data-passed');
  checks.replaceChildren();
  report = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    intervalMilliseconds: 500,
    checks: [],
    passed: false,
  };
  app.data = { ready: true, platform: '합성 환경' };
  for (const [name, exercise] of [
    ['설정·텍스트 선택', settingsChecks],
    ['함께 보기·권한 표시', observationChecks],
    ['대화·스크롤', chatChecks],
    ['캐릭터 매핑 변경 취소', mappingResetChecks],
  ]) {
    status.textContent = `${name} 검사 중…`;
    try {
      await exercise();
    } catch (error) {
      check(`${name} 실행`, false, String(error.stack || error));
    }
  }
  report.passed = report.checks.length > 0 && report.checks.every((item) => item.passed);
  report.finishedAt = new Date().toISOString();
  const passedCount = report.checks.filter((item) => item.passed).length;
  status.dataset.passed = String(report.passed);
  status.textContent = `${report.passed ? '전체 통과' : '검사 실패'} · ${passedCount}/${report.checks.length} 통과`;
  output.textContent = JSON.stringify(report, null, 2);
  runButton.disabled = false;
}

runButton.addEventListener('click', run);
await run();
