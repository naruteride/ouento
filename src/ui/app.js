import { styles } from './styles.js';
import { patchHTML, setText } from './dom.js';

const icons = {
  flower:
    '<path d="M12 12C3 13 2 6 6 5c3-1 6 3 6 7Zm0 0c-1-9 6-10 7-6 1 3-3 6-7 6Zm0 0c9-1 10 6 6 7-3 1-6-3-6-7Zm0 0c1 9-6 10-7 6-1-3 3-6 7-6Z"/>',
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 3v-9.5a8.5 8.5 0 0 1 17-1Z"/><path d="M7.5 10h8M7.5 14h5"/>',
  character:
    '<path d="m5 8 1-5 5 3h2l5-3 1 5v6a7 7 0 0 1-14 0Z"/><path d="M8 12h.01M16 12h.01m-6 4 2 1 2-1"/>',
  personality: '<path d="m12 3 2.7 5.7L21 10l-4.6 4.5.9 6.5-5.3-3-5.3 3 .9-6.5L3 10l6.3-1.3Z"/>',
  observe:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m-4-9 3 2 5-5"/>',
  memory: '<path d="M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2Zm0 14h14M9 7h6M9 11h4"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  moon: '<path d="M20 14.7A8.5 8.5 0 0 1 9.3 4 8.5 8.5 0 1 0 20 14.7Z"/>',
  shield: '<path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6Z"/><path d="m8 11 3 3 5-5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-3 0h6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  sound: '<path d="m11 4-6 5H2v6h3l6 5Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  archive:
    '<path d="M6 3h9l4 4v14H5V3Zm7 0v5h6M10 4v2m0 2v2m0 2v2"/><rect x="8" y="16" width="4" height="3" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m14 5 5 5M4 20l1-6L16 3l5 5L10 19Zm1-6 5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  refresh:
    '<path d="M20 4v6h-6M4 20v-6h6M4.5 8a8 8 0 0 1 13-4l2.5 6M4 14l2.5 6A8 8 0 0 0 19.5 16"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  spark: '<path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z"/>',
};

const icon = (name, className = '') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" class="${className}">${icons[name] || icons.info}</svg>`;
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const checked = (value) => (value ? 'checked' : '');
const selected = (a, b) => (a === b ? 'selected' : '');
const disabled = (value) => (value ? 'disabled' : '');
const percent = (value) => Math.round(Number(value) * 100);
const listText = (values) => (values || []).join('\n');
const splitList = (value) => [
  ...new Set(
    String(value)
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];
const deepMerge = (base, patch) => {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(base?.[key] || {}, value)
        : value;
  }
  return result;
};

const defaults = {
  ready: false,
  platform: '',
  version: '0.1.0',
  character: {
    id: '',
    name: 'Your companion',
    loaded: false,
    status: '모델을 기다리고 있어요',
    source: '',
    capabilities: [],
    warnings: [],
    parameters: [],
    expressions: [],
    mapping: {},
    models: [],
  },
  messages: [],
  busy: false,
  recording: false,
  speaking: false,
  personality: {
    preset: 'tsundere',
    intensity: 0.65,
    frequency: 0.4,
    jealousy: false,
    jealousyIntensity: 0.3,
    jealousyFrequency: 0.2,
  },
  observation: {
    mode: 'off',
    quiet: false,
    focus: false,
    meeting: false,
    windowId: '',
    cloudConsent: false,
    screenConsent: false,
    allowedApps: [],
    sensitiveApps: [],
    status: '관찰하지 않음',
    typingState: null,
    error: '',
    manualAvailable: false,
    manualAnalyzing: false,
    permission: 'unknown',
    windows: [],
    capabilities: [],
  },
  memories: [],
  memoryEnabled: false,
  providers: {
    chat: { endpoint: '', model: '', requiresKey: true, configured: false },
    stt: { endpoint: '', model: '', requiresKey: true, configured: false },
    tts: { endpoint: '', model: '', voice: '', requiresKey: true, configured: false },
  },
  settings: { fps: 30, scale: 1, muted: false, alwaysOnTop: true, cursorTracking: true },
  importState: { busy: false, error: '', entries: [], sourcePath: '' },
  modelPreview: { active: false, busy: false, name: '', preserveIdentity: true },
  error: '',
};

const pages = {
  chat: {
    name: '대화',
    eyebrow: 'A LITTLE COMPANY, EVERY DAY',
    title: '오늘도, 네 곁에.',
    description: '나누고 싶은 이야기부터, 아무 말 없는 시간까지.',
    tag: '함께하는 나만의 작은 공간',
  },
  character: {
    name: '캐릭터',
    eyebrow: 'MAKE YOURSELF AT HOME',
    title: '어떤 모습으로 만날까요?',
    description: '좋아하는 캐릭터와 눈을 맞추고, 표정을 살펴보세요.',
    tag: 'Live2D · 나만의 캐릭터',
  },
  personality: {
    name: '성격',
    eyebrow: 'A PERSONALITY THAT FITS YOU',
    title: '말투에도, 마음이 있어요.',
    description: '같은 순간, 서로 다른 반응. 잘 맞는 성격을 찾아보세요.',
    tag: '세 가지 다른 온도',
  },
  observe: {
    name: '함께 보기',
    eyebrow: 'ONLY WHAT YOU CHOOSE',
    title: '허락한 만큼, 함께 볼게요.',
    description: '어떤 화면을 함께 볼지 언제든 직접 정할 수 있어요.',
    tag: '기본은 관찰하지 않음',
  },
  memory: {
    name: '기억',
    eyebrow: 'THE LITTLE THINGS THAT MATTER',
    title: '기억해 두고 싶은 것들.',
    description: '직접 허락한 이야기만. 언제든 고치고, 지울 수 있어요.',
    tag: '기억의 주인은 당신',
  },
  settings: {
    name: '설정',
    eyebrow: 'A SPACE THAT WORKS FOR YOU',
    title: '편안한 속도로 맞춰요.',
    description: 'AI 연결부터 목소리, 화면 속 움직임까지.',
    tag: '내 공간의 작은 설정',
  },
};

const personas = [
  {
    id: 'tsundere',
    emoji: '✦',
    name: '서툰 다정함',
    subtitle: '툴툴대지만, 늘 곁에',
    quote: '붙었네. 그렇게 준비했으니까… 축하해.',
    character: '조금 서툴러도 다정한',
  },
  {
    id: 'cat',
    emoji: '☾',
    name: '느긋한 고양이',
    subtitle: '말은 적게, 마음은 깊게',
    quote: '합격이네. 잘했어. 이제 좀 쉬자.',
    character: '말없이 함께하는',
  },
  {
    id: 'cheerleader',
    emoji: '☀',
    name: '작은 응원단',
    subtitle: '당신의 기쁨을 가장 먼저',
    quote: '해냈다! 열심히 준비한 만큼 좋은 소식이 왔네!',
    character: '작은 순간도 응원하는',
  },
];

const mappingLabels = {
  mouthOpen: '입 벌림',
  mouthForm: '입 형태',
  eyeLeft: '왼쪽 눈 개방',
  eyeRight: '오른쪽 눈 개방',
  gazeX: '눈동자 좌우',
  gazeY: '눈동자 상하',
  angleX: '고개 좌우',
  angleY: '고개 상하',
  angleZ: '고개 기울임',
  bodyAngle: '상체 좌우',
  bodyAngleY: '상체 상하',
  bodyAngleZ: '상체 기울임',
  breath: '호흡',
};
const expressionLabels = {
  emotion_calm: '평온',
  emotion_happy: '기쁨',
  emotion_sad: '슬픔',
  emotion_surprised: '놀람',
  emotion_annoyed: '약한 불만',
};
const layoutControls = [
  {
    key: 'layout_scale',
    label: '이 모델의 표시 크기',
    min: 0.5,
    max: 2,
    initial: 1,
    left: '작게',
    right: '크게',
  },
  {
    key: 'layout_x',
    label: '좌우 위치',
    min: -1,
    max: 1,
    initial: 0,
    left: '왼쪽',
    right: '오른쪽',
  },
  { key: 'layout_y', label: '상하 위치', min: -1, max: 1, initial: 0, left: '아래', right: '위' },
  {
    key: 'tracking_strength',
    label: '커서를 따라가는 정도',
    min: 0,
    max: 1,
    initial: 1,
    left: '움직이지 않음',
    right: '자연스럽게 따라가기',
  },
];
const emotions = [
  ['neutral', '평온'],
  ['happy', '기쁨'],
  ['sad', '슬픔'],
  ['surprised', '놀람'],
  ['annoyed', '약한 불만'],
];

function range(name, label, value, left, right, min = 0, max = 1, step = 0.05, isDisabled = false) {
  const display = name === 'scale' ? `${Math.round(value * 100)}%` : `${percent(value)}%`;
  return `<div class="range-field"><label class="range-heading" for="${name}"><span>${label}</span><output for="${name}">${display}</output></label><input type="range" name="${name}" id="${name}" value="${value}" min="${min}" max="${max}" step="${step}" ${disabled(isDisabled)}><div class="range-ends"><span>${left}</span><span>${right}</span></div></div>`;
}

function toggle(name, title, description, value) {
  return `<label class="switch-row"><div><strong>${title}</strong><p>${description}</p></div><input class="switch" type="checkbox" name="${name}" ${checked(value)} aria-label="${title}"></label>`;
}

function formatExpiry(value) {
  if (!value) return '만료 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '만료일 확인 필요';
  return `${date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}까지`;
}

export class OuentoApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._data = deepMerge({}, defaults);
    this._page = 'chat';
    this._toastTimer = null;
    this._mounted = false;
    this._pageSnapshots = new Map();
    this._memorySaveSequence = 0;
    this._memorySaveRequest = null;
    this._syncMappingFields = false;
  }

  connectedCallback() {
    if (this._mounted) return;
    this._mounted = true;
    this.shadowRoot.innerHTML = `<style>${styles}</style><div class="shell">
      <aside class="sidebar"><div class="brand">${icon('flower')}<span class="wordmark">ouento</span></div><div class="nav-caption">MY LITTLE COMPANION</div>
      <nav aria-label="주 메뉴">${Object.entries(pages)
        .map(
          ([id, page]) =>
            `<button class="nav-link" data-page="${id}" ${id === this._page ? 'aria-current="page"' : ''}>${icon(id)}<span>${page.name}</span><span class="nav-dot" ${id !== this._page ? 'hidden' : ''}></span></button>`,
        )
        .join('')}</nav>
      <div class="sidebar-bottom"><button class="quiet-button" data-do="quiet-toggle" aria-pressed="false">${icon('moon')}<span>조용히 함께 있기</span><span class="tiny-switch" aria-hidden="true"></span></button><p class="quiet-help">먼저 말하지 않고, 곁에 머물러요.</p><div class="sidebar-meta"><span class="dot"></span><span id="version-label">Ouento · 나만의 동반자</span></div></div></aside>
      <div class="workspace"><header class="topbar"><div class="breadcrumb">${icon('flower')}<span>내 공간</span><span>/</span><strong id="breadcrumb-name">대화</strong></div><div class="top-actions"><span class="status-pill" id="observation-status"><span class="dot"></span>관찰하지 않음</span><button class="icon-button" data-do="observation-stop" title="관찰 중지" aria-label="관찰 중지">${icon('stop')}</button><button class="icon-button" data-do="desktop-show" title="데스크톱 캐릭터 표시" aria-label="데스크톱 캐릭터 표시">${icon('external')}</button></div></header>
      <main class="main"><div class="page-heading"><div><p class="eyebrow" id="page-eyebrow"></p><h1 id="page-title"></h1><p class="page-description" id="page-description"></p></div><span class="heading-tag" id="heading-tag"></span></div><div id="global-error" hidden></div>
      <div class="workarea"><aside class="companion" aria-label="캐릭터 미리보기"><div class="companion-header"><span class="companion-label">YOUR COMPANION</span><span class="live-badge" id="model-live"><span class="dot"></span>준비 중</span></div><div class="preview-wrap"><div id="character-preview"></div><div class="model-empty" id="model-empty"><div class="empty-orbit">${icon('spark')}</div><strong>처음 만날 준비를 해요</strong><p id="model-status">Live2D 모델을 불러오면<br>이곳에서 만날 수 있어요.</p></div></div><div class="companion-info"><p class="companion-name" id="companion-name">Your companion</p><p class="companion-persona" id="companion-persona">조금 서툴러도 다정한 나의 동반자</p><div class="companion-states"><span class="small-tag" id="character-state">모델 미연결</span><span class="small-tag" id="audio-state">목소리 미설정</span></div></div><div class="companion-footer"><span id="character-footer">작은 움직임, 자연스러운 표정</span><button class="text-button" data-do="open-import">캐릭터 불러오기 ${icon('arrow')}</button></div></aside><section class="page-panel" id="page-panel"></section></div><div id="page-bottom"></div><footer class="footer-meta"><span>당신의 일상에, 조금 더 다정한 순간.</span><span id="platform-label">OUENTO · YOUR DAILY COMPANION</span></footer></main></div></div>
      <dialog class="dialog" id="import-dialog" aria-labelledby="import-title"><div class="dialog-header"><h2 id="import-title">새로운 캐릭터를 만나요</h2><button class="icon-button" data-do="close-import" aria-label="닫기">${icon('close')}</button></div><p class="muted">실행용 Live2D 모델 폴더 또는 ZIP을 선택하세요.</p><div id="import-body"></div></dialog>
      <dialog class="dialog" id="memory-dialog" aria-labelledby="memory-title"><div class="dialog-header"><h2 id="memory-title">기억 남기기</h2><button class="icon-button" data-do="close-memory" aria-label="닫기">${icon('close')}</button></div><form id="memory-form"><input type="hidden" name="id"><label class="field"><span>기억할 이야기</span><textarea class="field-input" name="content" required maxlength="2000" aria-describedby="memory-content-help" placeholder="예: 집중할 때는 짧게 응원해 주면 좋아요."></textarea><small class="field-help" id="memory-content-help">최대 1,000자. 저장한 내용은 대화에 활용할 수 있어요.</small></label><label class="field"><span>언제까지 기억할까요?</span><input type="date" name="expiresAt"><small class="field-help">비워 두면 직접 삭제할 때까지 기억해요.</small></label><div class="notice error" id="memory-error" role="alert" hidden></div><div class="form-footer"><button class="button" type="button" data-do="close-memory">취소</button><button class="button primary" type="submit">기억 저장</button></div></form></dialog>
      <div id="toast" class="toast" role="status" hidden></div>`;
    this.shadowRoot.addEventListener('click', (event) => this._onClick(event));
    this.shadowRoot.addEventListener('submit', (event) => this._onSubmit(event));
    this.shadowRoot.addEventListener('input', (event) => this._onInput(event));
    this.shadowRoot.addEventListener('change', (event) => this._onChange(event));
    this.shadowRoot.getElementById('memory-dialog').addEventListener('cancel', (event) => {
      if (this._memorySaveRequest !== null) event.preventDefault();
    });
    this.shadowRoot.addEventListener('keydown', (event) => {
      if (
        event.target.matches('#chat-text') &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        event.target.form.requestSubmit();
      }
    });
    this.render();
  }

  disconnectedCallback() {
    clearTimeout(this._toastTimer);
  }
  get data() {
    return this._data;
  }
  set data(value) {
    this._data = deepMerge(defaults, value);
    if (this._mounted) this.render();
  }
  update(value) {
    if (value?.character?.id && value.character.id !== this._data.character.id) {
      this._data = {
        ...this._data,
        character: {
          ...this._data.character,
          mapping: {},
          expressions: [],
          parameters: [],
          capabilities: [],
        },
      };
      this._pageSnapshots.delete('character');
    }
    this._data = deepMerge(this._data, value);
    if (this._mounted) this.render();
  }
  get previewElement() {
    return this.shadowRoot.getElementById('character-preview');
  }

  navigate(page) {
    if (!pages[page]) return;
    if (page === this._page) return;
    this._pageSnapshots.set(this._page, this._snapshot());
    this._page = page;
    this.render(false);
    const snapshot = this._pageSnapshots.get(page);
    this._restore(snapshot);
    // Navigation creates a new log. Restore reading position here only;
    // periodic status updates must leave the existing scroll container alone.
    if (page === 'chat') {
      const chat = this.shadowRoot.querySelector('.chat-body');
      chat.scrollTop =
        snapshot && !snapshot.chatAtBottom ? (snapshot.chatScroll ?? 0) : chat.scrollHeight;
    }
    this.shadowRoot.querySelector('.main').scrollTop = 0;
    if (page === 'observe') this._emit('observation-refresh');
  }

  notify(message, kind = 'success') {
    const toast = this.shadowRoot.getElementById('toast');
    if (!toast) return;
    clearTimeout(this._toastTimer);
    toast.textContent = message;
    toast.className = `toast ${['error', 'info'].includes(kind) ? kind : ''}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.hidden = false;
    this._toastTimer = setTimeout(
      () => {
        toast.hidden = true;
      },
      kind === 'error' ? 8500 : 4500,
    );
  }

  openImport() {
    this._renderImport();
    this.shadowRoot.getElementById('import-dialog').showModal();
  }
  closeImport() {
    this.shadowRoot.getElementById('import-dialog')?.close();
  }

  // The controller acknowledges the matching save only after the native API resolves.
  completeMemorySave(requestId, error = null) {
    if (requestId !== this._memorySaveRequest || this._memorySaveRequest === null) return;
    this._memorySaveRequest = null;
    this._setMemorySaving(false);
    this._setMemoryError(error == null ? '' : String(error));
    if (error == null) this.shadowRoot.getElementById('memory-dialog').close();
    else this.shadowRoot.getElementById('memory-form').elements.content.focus();
  }

  _setMemorySaving(saving) {
    const dialog = this.shadowRoot.getElementById('memory-dialog');
    for (const field of dialog.querySelectorAll('input, textarea, button')) field.disabled = saving;
    const form = this.shadowRoot.getElementById('memory-form');
    form.setAttribute('aria-busy', String(saving));
    form.querySelector('[type="submit"]').textContent = saving ? '기억 저장 중…' : '기억 저장';
  }

  _setMemoryError(message) {
    const error = this.shadowRoot.getElementById('memory-error');
    error.textContent = message;
    error.hidden = !message;
  }

  clearMappingDraft() {
    const form = this.shadowRoot.getElementById('mapping-form');
    if (!form) return;
    for (const field of form.querySelectorAll('[data-dirty]')) delete field.dataset.dirty;
    if (this.shadowRoot.activeElement?.form === form) this.shadowRoot.activeElement.blur();
    this._pageSnapshots.delete('character');
    this._syncMappingFields = true;
  }

  _mappingValues(form) {
    const data = new FormData(form);
    return Object.fromEntries(
      [
        ...Object.keys(mappingLabels),
        ...Object.keys(expressionLabels),
        ...layoutControls.map((control) => control.key),
      ].map((key) => [key, String(data.get(key) ?? '').trim()]),
    );
  }

  _emit(type, payload = {}) {
    this.dispatchEvent(
      new CustomEvent('action', { detail: { type, ...payload }, bubbles: true, composed: true }),
    );
  }

  _snapshot() {
    const active = this.shadowRoot.activeElement;
    const fields = Array.from(
      this.shadowRoot.querySelectorAll(
        '#page-panel input, #page-panel textarea, #page-panel select',
      ),
    ).filter((field) => field.dataset.dirty || field === active);
    const key = (field) =>
      `${field.form?.getAttribute('id') || ''}:${field.name}:${field.type === 'radio' ? field.value : ''}`;
    const chat = this.shadowRoot.querySelector('.chat-body');
    return {
      characterId: this.shadowRoot.getElementById('page-panel').dataset.characterId,
      fields: fields.map((field) => ({
        key: key(field),
        value: field.value,
        checked: field.checked,
        dirty: !!field.dataset.dirty,
      })),
      active: active && key(active),
      selection:
        active?.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null,
      chatScroll: chat?.scrollTop,
      chatAtBottom: !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40,
      mainScroll: this.shadowRoot.querySelector('.main').scrollTop,
      expanded: Array.from(this.shadowRoot.querySelectorAll('#page-panel details')).map(
        (details) => details.open,
      ),
    };
  }

  _restore(snapshot) {
    if (!snapshot) return;
    for (const field of this.shadowRoot.querySelectorAll(
      '#page-panel input, #page-panel textarea, #page-panel select',
    )) {
      if (
        ['mapping-form', 'model-switch-form'].includes(field.form?.getAttribute('id')) &&
        snapshot.characterId !== this._data.character.id
      )
        continue;
      const key = `${field.form?.getAttribute('id') || ''}:${field.name}:${field.type === 'radio' ? field.value : ''}`;
      const previous = snapshot.fields.find((item) => item.key === key);
      if (previous) {
        if (field.type !== 'radio') field.value = previous.value;
        if (['checkbox', 'radio'].includes(field.type)) field.checked = previous.checked;
        if (previous.dirty) field.dataset.dirty = 'true';
        if (field.type === 'range') this._updateRange(field);
      }
      if (snapshot.active === key) {
        field.focus({ preventScroll: true });
        if (
          snapshot.selection &&
          field.setSelectionRange &&
          !['range', 'date', 'number'].includes(field.type)
        )
          field.setSelectionRange(...snapshot.selection);
      }
    }
    this.shadowRoot.querySelector('.main').scrollTop = snapshot.mainScroll;
    this.shadowRoot.querySelectorAll('#page-panel details').forEach((details, index) => {
      details.open = snapshot.expanded?.[index] || false;
    });
    this._updatePersonaQuote();
    this._updateObservationScope();
  }

  render(preserveInputs = true) {
    const state = this._data;
    const panel = this.shadowRoot.getElementById('page-panel');
    const modelChanged = panel.dataset.characterId !== state.character.id;
    const chatBefore = panel.querySelector('.chat-body');
    const messageCount = state.messages.length;
    const newMessages = messageCount !== this._renderedMessageCount;
    const followChat =
      chatBefore && chatBefore.scrollHeight - chatBefore.scrollTop - chatBefore.clientHeight < 40;
    panel.dataset.characterId = state.character.id;
    const page = pages[this._page];
    for (const nav of this.shadowRoot.querySelectorAll('.nav-link')) {
      nav.toggleAttribute('aria-current', nav.dataset.page === this._page);
      if (nav.dataset.page === this._page) nav.setAttribute('aria-current', 'page');
      nav.querySelector('.nav-dot').hidden = nav.dataset.page !== this._page;
    }
    for (const [id, text] of Object.entries({
      'breadcrumb-name': page.name,
      'page-title': page.title,
      'page-eyebrow': page.eyebrow,
      'page-description': page.description,
      'heading-tag': page.tag,
      'companion-name': state.character.name,
      'companion-persona': `${(personas.find((item) => item.id === state.personality.preset) || personas[0]).character} 나의 동반자`,
      'character-state': state.character.loaded ? 'Live2D' : '모델 미연결',
      'audio-state': state.settings.muted
        ? '음소거'
        : state.providers.tts.configured
          ? '목소리 연결됨'
          : '목소리 미설정',
      'version-label': `Ouento ${state.version} · 나만의 동반자`,
      'platform-label': state.platform
        ? `${state.platform} · OUENTO ${state.version}`
        : 'OUENTO · YOUR DAILY COMPANION',
    }))
      setText(this.shadowRoot.getElementById(id), text);
    this.shadowRoot.getElementById('model-empty').hidden = state.character.loaded;
    setText(
      this.shadowRoot.getElementById('model-status'),
      state.character.status || 'Live2D 모델을 불러오면 이곳에서 만날 수 있어요.',
    );
    patchHTML(
      this.shadowRoot.getElementById('model-live'),
      `<span class="dot ${state.character.loaded ? 'active' : ''}"></span>${state.character.loaded ? 'LIVE' : '준비 중'}`,
    );
    patchHTML(
      this.shadowRoot.getElementById('observation-status'),
      `<span class="dot ${state.observation.mode !== 'off' ? 'active' : ''}"></span>${escape(state.observation.status || (state.observation.mode === 'off' ? '관찰하지 않음' : '선택한 화면 함께 보는 중'))}`,
    );
    this.shadowRoot
      .querySelector('[data-do="quiet-toggle"]')
      .setAttribute('aria-pressed', String(state.observation.quiet));
    const error = this.shadowRoot.getElementById('global-error');
    error.hidden = !state.error;
    patchHTML(
      error,
      state.error
        ? `<div class="notice error global-error" role="alert">${icon('info')}<p>${escape(state.error)}</p></div>`
        : '',
    );
    const showCompanion = ['chat', 'character', 'personality'].includes(this._page);
    this.shadowRoot.querySelector('.companion').hidden = !showCompanion;
    this.shadowRoot.querySelector('.workarea').classList.toggle('full', !showCompanion);
    patchHTML(panel, this[`_${this._page}Page`](), {
      reset: !preserveInputs || (modelChanged && this._page === 'character'),
      syncFields: this._syncMappingFields && this._page === 'character',
    });
    if (this._page === 'character') this._syncMappingFields = false;
    for (const field of panel.querySelectorAll('input[type="range"][data-dirty]'))
      this._updateRange(field);
    this._updatePersonaQuote();
    this._updateObservationScope();
    patchHTML(
      this.shadowRoot.getElementById('page-bottom'),
      this._page === 'chat'
        ? `<div class="bottom-cards"><div class="mini-card"><span class="mini-card-icon">${icon('observe')}</span><div><h3>같이 보고 싶은 순간에</h3><p>선택한 화면만, 허락한 만큼 함께 봐요.</p></div><button class="text-button" data-page="observe" aria-label="함께 보기 설정">${icon('arrow')}</button></div><div class="mini-card"><span class="mini-card-icon">${icon('personality')}</span><div><h3>나와 잘 맞는 온도</h3><p>말투와 반응을 취향에 맞춰 보세요.</p></div><button class="text-button" data-page="personality" aria-label="성격 설정">${icon('arrow')}</button></div></div><div class="context-note">${icon('shield')}<span>${state.observation.mode === 'off' ? '지금은 화면을 보지 않아요. 이야기는 편하게 나눠요.' : '허용한 범위만 함께 봐요. 관찰은 언제든 멈출 수 있어요.'}</span></div>`
        : '',
    );
    const chat = this.shadowRoot.querySelector('.chat-body');
    // Only a new message may follow the conversation. Status ticks must never
    // write scrollTop: doing so cancels WebKit's native rubber-band scrolling.
    if (chat && messageCount && newMessages && (!chatBefore || followChat))
      chat.scrollTop = chat.scrollHeight;
    this._renderedMessageCount = messageCount;
    if (this.shadowRoot.getElementById('import-dialog').open) this._renderImport();
  }

  _chatPage() {
    const d = this._data;
    return `<section class="chat-panel" aria-label="대화"><div class="chat-title"><h2>우리의 이야기</h2><span class="session-label"><span class="dot ${d.providers.chat.configured ? 'active' : ''}"></span>${d.providers.chat.configured ? '대화할 준비가 됐어요' : 'AI 연결을 기다려요'}</span></div><div class="chat-body" role="log" aria-live="polite" aria-relevant="additions text">${d.messages.length ? d.messages.map((message) => `<article class="message ${['user', 'assistant', 'system'].includes(message.role) ? message.role : 'system'}"><div class="message-meta"><span>${message.role === 'user' ? '나' : message.role === 'assistant' ? escape(d.character.name) : '안내'}</span><span>${escape(message.time || '')}</span></div><div class="message-bubble">${escape(message.content)}</div></article>`).join('') : `<div class="chat-welcome">${icon('flower', 'welcome-symbol')}<h3>별일 없어도 괜찮아요.</h3><p>오늘 있었던 일, 문득 떠오른 생각.<br>어떤 이야기든 들려주세요.</p><div class="prompt-chips"><button class="prompt-chip" data-prompt="오늘 하루는 어땠어?">오늘 하루는 어땠어?</button><button class="prompt-chip" data-prompt="잠깐 쉬어 갈까?">잠깐 쉬어 갈까?</button><button class="prompt-chip" data-prompt="나 좀 응원해 줘.">나 좀 응원해 줘</button></div>${!d.providers.chat.configured ? '<p style="margin-top:21px"><button class="text-button" data-page="settings">대화를 시작하려면 AI를 연결해 주세요 →</button></p>' : ''}</div>`}${d.busy ? '<div class="thinking" role="status"><i></i><i></i><i></i><span>이야기를 듣고 있어요</span></div>' : ''}</div><div class="composer-area"><form class="composer" id="chat-form"><textarea id="chat-text" name="text" rows="2" maxlength="8000" placeholder="오늘은 어떤 하루였나요?" aria-label="대화 메시지" aria-describedby="chat-limit" required></textarea><button class="send-button" type="submit" aria-label="메시지 보내기" ${disabled(!d.ready)}>${icon('up')}</button></form><p class="field-help" id="chat-limit">최대 4,000자까지 보낼 수 있어요.</p><div class="composer-tools"><button class="voice-button" data-do="voice-toggle" aria-pressed="${d.recording}">${icon('mic')}${d.recording ? '듣고 있어요 · 눌러서 전송' : '목소리로 이야기하기'}</button>${d.busy || d.speaking ? '<button class="cancel-button" data-do="speech-cancel">말하기 중단</button>' : '<span>Enter 보내기 · Shift + Enter 줄바꿈</span>'}</div></div></section>`;
  }

  _characterPage() {
    const c = this._data.character;
    const preview = this._data.modelPreview;
    return `${preview.active ? `<div class="card"><div class="card-header"><div><h2>새 모습, 먼저 살펴보세요</h2><p>${escape(preview.name || '캐릭터')} · ${preview.busy ? '처리 중' : '아직 저장하지 않은 미리보기'}</p></div></div><p class="muted">아래에서 표정·입 움직임·지원 기능을 확인하세요. 이 창에서만 미리 보며, 사용을 확정하면 바탕화면 캐릭터도 바뀌어요.</p><label class="check-row" style="margin-top:16px"><input type="checkbox" name="previewPreserveIdentity" ${checked(preview.preserveIdentity)} ${disabled(preview.busy)}>지금의 성격과 기억 유지하기</label><p class="field-help" style="margin-top:7px">해제하면 사용을 확정할 때 새 인격으로 시작하며 기존 기억이 삭제돼요.</p><div class="form-footer"><button class="button" data-do="model-preview-cancel" ${disabled(preview.busy)}>취소하고 돌아가기</button><button class="button primary" data-do="model-preview-accept" ${disabled(preview.busy || !c.loaded)}>이 캐릭터 사용</button></div></div>` : ''}<div class="card" ${preview.active ? 'hidden' : ''}><div class="card-header"><div><h2>지금 곁에 있는 캐릭터</h2><p>${escape(c.source || '모델을 불러와 나만의 동반자를 만나세요.')}</p></div></div><div class="buttons"><button class="button primary" data-do="open-import">${icon('plus')}캐릭터 불러오기</button><button class="button" data-do="desktop-show">${icon('external')}바탕화면에 표시</button></div>${c.models.length ? `<form id="model-switch-form" style="margin-top:20px"><label class="field"><span>보관한 캐릭터</span><select name="id">${c.models.map((model) => `<option value="${escape(model.id)}" ${selected(model.id, c.id)}>${escape(model.name)}</option>`).join('')}</select></label><label class="check-row"><input type="checkbox" name="preserveIdentity" checked>지금의 성격과 기억 유지하기</label><p class="field-help" style="margin-top:7px">해제하면 새 인격으로 시작하며 기존 기억이 삭제돼요.</p><div class="form-footer"><button class="button" type="submit">선택한 캐릭터 미리보기</button></div></form>` : ''}</div>
      <div class="card"><div class="card-header"><div><h2>표정 살펴보기</h2><p>실제 모델의 표정과 입 움직임을 확인해요.</p></div></div><div class="emotion-buttons">${emotions.map(([id, name]) => `<button class="emotion-button" data-emotion="${id}" ${disabled(!c.loaded || this._data.modelPreview.busy)}>${name}</button>`).join('')}</div><div class="range-field"><label class="range-heading" for="mouth-openness"><span>입 벌림 미리보기</span><output for="mouth-openness">0%</output></label><input type="range" id="mouth-openness" name="mouthOpenness" min="0" max="1" step="0.05" value="0" ${disabled(!c.loaded || this._data.modelPreview.busy)}><div class="range-ends"><span>닫힘</span><span>열림</span></div></div><p class="field-help" style="margin-top:9px">음성 립싱크는 실제 재생 음원에 맞춰 별도로 움직여요.</p><div class="section-divider"></div><div class="buttons"><button class="button" data-do="audio-preview" ${disabled(!c.loaded || this._data.modelPreview.busy)}>${icon('sound')}한국어 음성·입 모양 확인</button><button class="button" data-do="speech-cancel" ${disabled(!this._data.speaking && !this._data.busy)}>${icon('stop')}재생 중지</button></div><p class="field-help" style="margin-top:10px">AI 연결 없이 Live2D 공식 Kei 한국어 샘플 음원을 재생해요.</p></div>
      <div class="card"><h2>이 캐릭터가 할 수 있는 것</h2><div class="capability-list">${c.capabilities.length ? c.capabilities.map((cap) => `<div class="capability"><div><span class="capability-label">${escape(cap.name)}</span>${cap.detail ? `<p class="capability-detail">${escape(cap.detail)}</p>` : ''}</div><span class="capability-badge ${cap.level === 'fallback' ? 'fallback' : cap.level === 'supported' ? '' : 'unsupported'}">${cap.level === 'supported' ? '지원' : cap.level === 'fallback' ? '대체 동작' : '미지원'}</span></div>`).join('') : '<p class="muted" style="padding:10px 0">모델을 검사한 뒤 지원 기능을 알려드릴게요.</p>'}</div>
      ${c.warnings.length ? `<div class="notice warning"><p>${c.warnings.map(escape).join('<br>')}</p></div>` : ''}<details><summary>표정·움직임·표시 직접 설정하기</summary><form id="mapping-form">${this._mappingFields(c)}<div class="form-footer"><button class="button" type="button" data-do="model-mapping-reset" ${disabled(!c.loaded || preview.busy)}>변경 취소</button><button class="button primary" type="submit" ${disabled(!c.loaded || preview.busy)}>${preview.active ? '미리보기에 적용' : '모델 설정 저장'}</button></div><p class="field-help" style="margin-top:10px">${preview.active ? '조절한 값은 미리보기에 적용되며, ‘이 캐릭터 사용’으로 확정할 때 함께 저장돼요.' : '조절한 값은 먼저 미리보기에 적용돼요. 저장하기 전에는 언제든 변경을 취소할 수 있어요.'}</p></form></details></div>`;
  }

  _mappingFields(character) {
    const c = character;
    const parameters = Object.entries(mappingLabels)
      .map(
        ([key, label]) =>
          `<label class="field"><span>${label}</span><select name="${key}" ${disabled(!c.loaded || this._data.modelPreview.busy)}><option value="">연결하지 않음</option>${c.parameters.map((parameter) => `<option value="${escape(parameter.id)}" ${selected(c.mapping[key], parameter.id)}>${escape(parameter.id)} (${parameter.minimum} ~ ${parameter.maximum})</option>`).join('')}</select></label>`,
      )
      .join('');
    const expressions = Object.entries(expressionLabels)
      .map(
        ([key, label]) =>
          `<label class="field"><span>${label}</span><select name="${key}" ${disabled(!c.loaded || this._data.modelPreview.busy)}><option value="">자동 파라미터 대체</option>${c.expressions.map((name) => `<option value="${escape(name)}" ${selected(c.mapping[key], name)}>${escape(name)}</option>`).join('')}</select></label>`,
      )
      .join('');
    const layout = layoutControls
      .map((control) => {
        const stored = c.mapping[control.key];
        const parsed = Number(stored == null || stored === '' ? control.initial : stored);
        const value = Number.isFinite(parsed)
          ? Math.min(control.max, Math.max(control.min, parsed))
          : control.initial;
        return range(
          control.key,
          control.label,
          value,
          control.left,
          control.right,
          control.min,
          control.max,
          0.05,
          !c.loaded || this._data.modelPreview.busy,
        );
      })
      .join('');
    return `<h3>감정별 표정 연결</h3><p class="field-help">모델에 들어 있는 표정을 골라 연결하고 위의 표정 버튼으로 확인하세요.</p><div class="mapping-grid">${expressions}</div><div class="section-divider"></div><h3>움직임 파라미터</h3><p class="field-help">자동으로 찾지 못한 기능은 모델의 실제 파라미터에 연결할 수 있어요.</p><div class="mapping-grid">${parameters}</div><div class="section-divider"></div><h3>이 모델의 표시와 추적</h3>${layout}<p class="field-help" style="margin-top:12px">표시 크기는 설정 화면의 전체 크기와 함께 적용돼요. 위치 0%는 화면 가운데이며, 이 설정은 모델별로 저장해요.</p>`;
  }

  _personalityPage() {
    const p = this._data.personality;
    const persona = personas.find((item) => item.id === p.preset) || personas[0];
    return `<form id="personality-form"><div class="card"><div class="card-header"><div><h2>나와 잘 맞는 성격</h2><p>말투, 표정, 움직임의 분위기가 달라져요.</p></div></div><div class="persona-grid">${personas.map((item) => `<label class="persona-card"><input type="radio" name="preset" value="${item.id}" ${checked(p.preset === item.id)}><span class="persona-emoji" aria-hidden="true">${item.emoji}</span><strong>${item.name}</strong><small>${item.subtitle}</small></label>`).join('')}</div><div class="persona-preview"><span class="scene">같은 순간 미리보기 · 내가 시험에 합격했을 때</span><p id="persona-quote">“${escape(persona.quote)}”</p></div><button class="button" type="button" data-do="personality-preview">${icon('sound')}표정과 함께 미리보기</button>${range('intensity', '표정과 움직임의 크기', p.intensity, '차분하게', '풍부하게')}${range('frequency', '먼저 말하는 빈도', p.frequency, '가끔씩', '자주')}</div><div class="card"><h2>작은 질투 연출</h2>${toggle('jealousy', '가벼운 질투 표현', '곁눈질과 짧은 투정으로, 가끔 관심을 표현해요.', p.jealousy)}${range('jealousyIntensity', '표현 강도', p.jealousyIntensity, '아주 은근하게', '조금 더 솔직하게')}${range('jealousyFrequency', '표현 빈도', p.jealousyFrequency, '드물게', '가끔')}<p class="field-help" style="margin-top:17px">같은 장면에 반복하지 않으며, 다른 캐릭터를 보는 것을 막지 않아요.</p><div class="form-footer"><button class="button primary" type="submit">이 성격으로 함께하기</button></div></div></form>`;
  }

  _observePage() {
    const o = this._data.observation;
    const permissionHelp =
      '현재 실행 중인 Ouento에는 화면 접근이 적용되지 않았어요. ' +
      (this._data.platform === 'macOS'
        ? '시스템 설정에서 Ouento의 화면 기록을 허용해 주세요. 이미 허용했는데 계속 표시되면 화면 기록 목록에서 Ouento를 제거한 다음, 현재 사용하는 Ouento.app을 다시 추가해 주세요. 변경 후 앱을 완전히 종료하고 다시 열어 주세요.'
        : '운영체제 설정에서 Ouento의 화면 접근을 허용한 뒤 화면 권한을 다시 확인해 주세요.');
    const paused = o.typingState === true || o.quiet || o.focus || o.meeting;
    const notices = `${o.error ? `<div class="notice error" role="alert"><p>${escape(o.error)}</p></div>` : ''}${o.mode !== 'off' && o.typingState === null ? '<div class="notice"><p>입력 활동 감지를 사용할 수 없어요. 자동 관찰은 입력 감지 없이 동작해요. 집중·회의 모드로 먼저 말하기를 멈출 수 있어요.</p></div>' : ''}${o.mode !== 'off' && paused ? `<div class="notice"><p>입력·집중·회의 중이거나 조용히 있을 때는 자동 반응을 쉬어요. ${o.manualAvailable ? '‘지금 화면 한 번 보기’로 허용한 화면의 분석을 요청할 수 있어요. ' : '화면 분석을 요청하려면 관찰 범위·화면 잠금·창 표시 상태를 확인해 주세요. '}직접 텍스트·음성 대화는 계속 사용할 수 있어요.</p></div>` : ''}`;
    return `${notices}<form id="observation-form"><div class="card"><div class="card-header"><div><h2>함께 볼 범위</h2><p>적용한 전체 모니터·허용 앱 설정은 다시 실행해도 유지돼요. 관찰 중지를 누르면 꺼진 상태로 기억해요.</p></div><button class="button danger" type="button" data-do="observation-stop">${icon('stop')}관찰 중지</button></div><div class="mode-options">${[
      [
        'off',
        '관찰하지 않기',
        '화면이나 앱 활동을 보지 않아요. 직접 나누는 대화는 계속할 수 있어요.',
      ],
      [
        'selected',
        '선택한 창만 함께 보기',
        '지정한 창의 화면만 함께 보고, 필요한 순간에 반응해요.',
      ],
      [
        'allowed',
        '허용한 앱에서 먼저 반응하기',
        '허용 목록에 있는 앱의 사건과 화면을 보고, 필요한 순간에 먼저 말을 건네요.',
      ],
      [
        'screen',
        '지금 사용하는 모니터 전체 보기',
        '마우스가 있는 모니터를 따라가며 화면 전체를 봐요. 창이나 앱을 하나씩 고르지 않아도 돼요.',
      ],
    ]
      .map(
        ([id, title, text]) =>
          `<label class="mode-option"><input type="radio" name="mode" value="${id}" ${checked(o.mode === id)}><span><strong>${title}</strong><small>${text}</small></span></label>`,
      )
      .join('')}</div>
      <div class="section-divider"></div><div class="form-grid"><label class="field" data-observation-scope="selected allowed"><span>함께 볼 창</span><select name="windowId"><option value="">창을 선택해 주세요</option>${o.windows.map((window) => `<option value="${escape(window.id)}" ${selected(window.id, o.windowId)}>${escape(window.appName || window.appId)} · ${escape(window.title)}</option>`).join('')}</select><button type="button" class="text-button" data-do="observation-refresh">${icon('refresh')}창 목록 새로고침</button><button type="button" class="text-button" data-do="observation-add-app">${icon('plus')}선택한 창의 앱을 허용 목록에 추가</button></label><div class="field"><span>화면 접근 권한</span><p class="muted">${o.permission === 'granted' ? '화면 접근이 허용되어 있어요.' : o.permission === 'denied' ? escape(permissionHelp) : '함께 보기를 켤 때 접근 권한을 확인해요.'}</p><button class="button" type="button" data-do="permission-request">${icon('shield')}화면 권한 확인</button></div><label class="field" data-observation-scope="allowed"><span>먼저 반응해도 되는 앱</span><textarea class="field-input" name="allowedApps" rows="3" placeholder="앱 식별자를 한 줄에 하나씩 입력하세요.">${escape(listText(o.allowedApps))}</textarea><small class="field-help">창 선택 목록의 앱 식별자를 사용해요.</small></label><label class="field"><span>언제나 제외할 민감 앱</span><textarea class="field-input" name="sensitiveApps" rows="3" placeholder="비밀번호·금융 등 민감한 앱 식별자">${escape(listText(o.sensitiveApps))}</textarea><small class="field-help">허용 목록에 있어도 제외해요.</small></label></div>
      <div class="notice">${icon('shield')}<p>함께 볼 때는 선택한 범위의 화면과 앱·창 정보를 설정한 AI 제공자에게 보낼 수 있어요. 원본 화면은 기본 저장하지 않아요.</p></div><label class="check-row"><input type="checkbox" name="cloudConsent" ${checked(o.cloudConsent)}>선택한 화면과 앱·창 정보를 AI 제공자에게 전달하는 데 동의해요.</label><div data-observation-scope="screen"><div class="notice warning"><p>모니터 전체 보기에는 같은 모니터에 보이는 다른 창·알림·바탕화면도 포함돼요. 마우스를 다른 모니터로 옮기면 대상도 바뀌어요. Ouento 창은 제외하며, 제외 목록의 민감 앱이 화면에 겹치면 분석을 쉬어요. 모든 민감정보를 자동으로 식별할 수는 없어요.</p></div><label class="check-row"><input type="checkbox" name="screenConsent" ${checked(o.screenConsent)}>마우스가 있는 모니터 전체를 AI 제공자에게 전달하는 데 동의해요.</label></div><div class="form-footer"><button class="button" type="button" data-do="observation-analyze" ${disabled(o.mode === 'off' || !o.manualAvailable || o.manualAnalyzing)}>${o.manualAnalyzing ? '요청한 화면 분석 중…' : '지금 화면 한 번 보기'}</button><button class="button primary" type="submit">선택한 범위 적용</button></div></div>
      <div class="card"><h2>방해하지 않는 순간</h2>${toggle('focus', '집중하고 있어요', '집중 모드에서는 먼저 말하지 않아요.', o.focus)}${toggle('meeting', '회의 중이에요', '회의가 끝날 때까지 선제 발화를 멈춰요.', o.meeting)}<p class="field-help" style="margin-top:11px">위 옵션도 ‘선택한 범위 적용’으로 저장해요. 조용히 있기는 발화만 멈추고, 관찰 중지는 수집과 전송도 멈춰요.</p>${o.capabilities.length ? `<div class="capability-list">${o.capabilities.map((cap) => `<div class="capability"><div><span class="capability-label">${escape(cap.name)}</span><p class="capability-detail">${escape(cap.detail)}</p></div><span class="capability-badge ${cap.supported ? '' : 'unsupported'}">${cap.supported ? '사용 가능' : '미지원'}</span></div>`).join('')}</div>` : ''}</div></form>`;
  }

  _memoryPage() {
    const d = this._data;
    return `<div class="card"><h2>기억은 허락한 것만</h2><label class="switch-row"><div><strong>대화에 요약 기억 활용하기</strong><p>아래에 직접 저장한 기억을 대화할 때 참고할 수 있어요.</p></div><input class="switch" type="checkbox" name="memoryEnabled" ${checked(d.memoryEnabled)} aria-label="요약 기억 활용하기"></label><p class="field-help" style="margin-top:11px">원본 화면·키 입력·음성을 계속 저장하지 않아요. 만료된 기억은 대화에 사용하지 않아요.</p></div><div class="card"><div class="card-header"><div><h2>함께 기억하는 이야기 <span class="muted">${d.memories.length}</span></h2><p>작은 취향부터 중요한 일정까지.</p></div><button class="button primary" data-do="memory-new">${icon('plus')}기억 남기기</button></div>${d.memories.length ? d.memories.map((memory) => `<article class="memory-row"><div><p class="memory-content">${escape(memory.content)}</p><p class="memory-date">${formatExpiry(memory.expiresAt)}</p></div><div class="memory-controls"><button class="icon-button" data-do="memory-edit" data-id="${escape(memory.id)}" aria-label="기억 수정">${icon('edit')}</button><button class="icon-button" data-do="memory-delete" data-id="${escape(memory.id)}" aria-label="기억 삭제">${icon('trash')}</button></div></article>`).join('') : `<div class="empty-state">${icon('memory')}<h3>아직 비어 있는, 우리만의 노트.</h3><p>기억해 줬으면 하는 이야기를 직접 남겨 보세요.<br>저장할 내용과 기간은 언제든 바꿀 수 있어요.</p></div>`}</div>`;
  }

  _settingsPage() {
    const d = this._data;
    return `<div class="notice" style="margin-top:0">${icon('key')}<p>대화, 음성 인식, 목소리를 각각 연결할 수 있어요. API 키는 운영체제의 보안 저장소에서 관리하며, 빈칸으로 저장하면 기존 키를 유지해요.</p></div>${[
      ['chat', '대화와 화면 이해', '텍스트·이미지를 이해할 수 있는 모델을 연결해요.', 'chat'],
      ['stt', '내 목소리 알아듣기', '음성 인식(STT) 제공자를 연결해요.', 'mic'],
      ['tts', '캐릭터의 목소리', '음성 생성(TTS) 제공자와 목소리를 정해요.', 'sound'],
    ]
      .map(([kind, title, description, glyph]) => {
        const p = d.providers[kind];
        return `<form class="card" id="provider-${kind}-form" data-provider="${kind}"><div class="card-header"><div><div class="provider-title">${icon(glyph)}<h2>${title}</h2></div><p>${description}</p></div><span class="provider-status ${p.configured ? 'connected' : ''}"><span class="dot ${p.configured ? 'active' : ''}"></span>${p.configured ? '설정됨' : '미설정'}</span></div><div class="form-grid"><label class="field"><span>API 기본 주소</span><input type="url" name="endpoint" value="${escape(p.endpoint)}" placeholder="https://api.example.com/v1" required spellcheck="false"><small class="field-help">OpenAI 호환 API의 기본 주소를 입력하세요.</small></label><label class="field"><span>모델 이름</span><input type="text" name="model" value="${escape(p.model)}" placeholder="제공자의 모델 ID" required spellcheck="false"></label>${kind === 'tts' ? `<label class="field"><span>목소리</span><input type="text" name="voice" value="${escape(p.voice)}" placeholder="제공자의 voice ID" spellcheck="false"></label>` : ''}<label class="field ${kind !== 'tts' ? 'wide' : ''}"><span>API 키</span><input type="password" name="apiKey" placeholder="${p.configured ? '저장된 키 유지 · 바꾸려면 새 키 입력' : 'API 키를 입력해 주세요'}" autocomplete="new-password" spellcheck="false"></label></div><label class="check-row"><input type="checkbox" name="requiresKey" ${checked(p.requiresKey !== false)}>API 키 인증을 사용해요.</label><p class="field-help" style="margin:5px 0 0 23px">인증이 없는 로컬 제공자를 연결할 때만 해제하세요.</p><div class="form-footer"><button class="button" type="button" data-do="provider-remove-key" data-kind="${kind}" ${disabled(!p.configured)}>저장한 키 지우기</button><button class="button primary" type="submit">연결 설정 저장</button></div></form>`;
      })
      .join(
        '',
      )}<form class="card" id="settings-form"><div class="card-header"><div><h2>화면 속 움직임</h2><p>기기의 여유와 취향에 맞춰 조절해요.</p></div></div><label class="field"><span>프레임 속도</span><select name="fps"><option value="30" ${selected(d.settings.fps, 30)}>30 FPS · 편안한 기본 설정</option><option value="60" ${selected(d.settings.fps, 60)}>60 FPS · 더 부드럽게</option></select></label>${range('scale', '캐릭터 표시 크기', d.settings.scale, '작게', '크게', 0.5, 1.5, 0.05)}${toggle('alwaysOnTop', '항상 위에 표시', '다른 창 위에서도 캐릭터를 볼 수 있어요.', d.settings.alwaysOnTop)}${toggle('cursorTracking', '커서 따라보기', '커서가 움직이는 쪽으로 눈과 고개를 돌려요.', d.settings.cursorTracking)}${toggle('muted', '캐릭터 음소거', '목소리 대신 표정과 말풍선으로 반응해요.', d.settings.muted)}<div class="form-footer"><button class="button primary" type="submit">화면 설정 저장</button></div></form>`;
  }

  _renderImport() {
    const d = this._data.importState;
    const previous = this.shadowRoot.querySelector('#import-body [name="preserveIdentity"]');
    const preserveIdentity = previous ? previous.checked : true;
    const previousEntry = this.shadowRoot.querySelector(
      '#import-body [name="entry"]:checked',
    )?.value;
    const chosenEntry =
      d.entries.find((entry) => entry.path === previousEntry && entry.valid !== false)?.path ??
      d.entries.find((entry) => entry.valid !== false)?.path;
    patchHTML(
      this.shadowRoot.getElementById('import-body'),
      `<div class="import-options"><button class="import-option" data-do="model-import" data-kind="folder" ${disabled(d.busy)}>${icon('folder')}모델 폴더 선택<small>.model3.json이 있는 폴더</small></button><button class="import-option" data-do="model-import" data-kind="zip" ${disabled(d.busy)}>${icon('archive')}ZIP 파일 선택<small>실행용 모델 묶음</small></button></div><p class="field-help" style="text-align:center;margin-top:12px">데스크톱 앱에서는 폴더나 ZIP을 창으로 끌어와도 돼요.</p><label class="check-row"><input type="checkbox" name="preserveIdentity" ${checked(preserveIdentity)}>지금의 성격과 기억을 새 모습에서도 유지해요.</label><p class="field-help" style="margin:5px 0 0 23px">해제하면 새 인격으로 시작하며 기존 기억이 삭제돼요.</p>${d.busy ? '<div class="notice">모델 파일과 참조 경로를 확인하고 있어요.</div>' : ''}${d.error ? `<div class="notice error" role="alert">${icon('info')}<p>${escape(d.error)}</p></div>` : ''}${d.entries.length ? `<form id="import-entry-form"><div class="section-divider"></div><h3>불러올 모델을 선택해 주세요.</h3>${d.entries.map((entry, index) => `<label class="import-entry"><input type="radio" name="entry" value="${escape(entry.path)}" ${checked(chosenEntry === entry.path)} ${disabled(entry.valid === false)}><span>${escape(entry.name)}<code>${escape(entry.path)}</code></span></label>`).join('')}<div class="form-footer"><button class="button primary" type="submit" ${disabled(d.busy)}>이 모델 불러오기</button></div></form>` : ''}<div class="notice warning">${icon('info')}<p>.moc3와 텍스처가 포함된 실행용 모델이 필요해요. 편집 원본(.cmo3), PSD, 이미지 파일만으로는 실행할 수 없어요.</p></div>`,
    );
  }

  _openMemory(id) {
    if (this._memorySaveRequest !== null) return;
    this._setMemoryError('');
    const item = this._data.memories.find((memory) => memory.id === id);
    const form = this.shadowRoot.getElementById('memory-form');
    form.elements.id.value = item?.id || '';
    form.elements.content.value = item?.content || '';
    const expiry = item?.expiresAt ? new Date(item.expiresAt) : null;
    form.elements.expiresAt.value =
      expiry && !Number.isNaN(expiry.getTime())
        ? `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`
        : '';
    this.shadowRoot.getElementById('memory-title').textContent = item
      ? '기억 다듬기'
      : '기억 남기기';
    this.shadowRoot.getElementById('memory-dialog').showModal();
    form.elements.content.focus();
  }

  _onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.page) {
      this.navigate(button.dataset.page);
      return;
    }
    if (button.dataset.prompt) {
      const field = this.shadowRoot.getElementById('chat-text');
      field.value = button.dataset.prompt;
      field.dataset.dirty = 'true';
      field.focus();
      return;
    }
    if (button.dataset.emotion) {
      this._emit('expression-preview', {
        emotion: button.dataset.emotion,
        intensity: this._data.personality.intensity,
      });
      return;
    }
    const action = button.dataset.do;
    switch (action) {
      case 'open-import':
        this.openImport();
        break;
      case 'close-import':
        this.shadowRoot.getElementById('import-dialog').close();
        break;
      case 'close-memory':
        if (this._memorySaveRequest === null)
          this.shadowRoot.getElementById('memory-dialog').close();
        break;
      case 'memory-new':
        this._openMemory();
        break;
      case 'memory-edit':
        this._openMemory(button.dataset.id);
        break;
      case 'memory-delete':
        this._emit(action, { id: button.dataset.id });
        break;
      case 'quiet-toggle':
        this._emit(action, { value: !this._data.observation.quiet });
        break;
      case 'observation-add-app': {
        const form = this.shadowRoot.getElementById('observation-form');
        const target = this._data.observation.windows.find(
          (window) => window.id === form.elements.windowId.value,
        );
        if (!target?.appId) {
          this.notify('먼저 목록에서 창을 선택해 주세요.', 'info');
          break;
        }
        const field = form.elements.allowedApps;
        field.value = [...new Set([...splitList(field.value), target.appId])].join('\n');
        field.dataset.dirty = 'true';
        field.focus();
        break;
      }
      case 'permission-request':
        this._emit(action, { permission: 'screen' });
        break;
      case 'model-import':
        this._emit(action, {
          kind: button.dataset.kind,
          preserveIdentity: this.shadowRoot.querySelector('#import-body [name="preserveIdentity"]')
            .checked,
        });
        break;
      case 'personality-preview':
        this._emit(action, {
          preset: new FormData(this.shadowRoot.getElementById('personality-form')).get('preset'),
          scene: 'exam-pass',
        });
        break;
      case 'provider-remove-key':
        this._emit(action, { kind: button.dataset.kind });
        break;
      default:
        if (
          [
            'observation-stop',
            'desktop-show',
            'speech-cancel',
            'voice-toggle',
            'audio-preview',
            'model-preview-accept',
            'model-preview-cancel',
            'model-mapping-reset',
            'observation-refresh',
            'observation-analyze',
          ].includes(action)
        )
          this._emit(action);
    }
  }

  _onInput(event) {
    const field = event.target;
    if (field.matches('input,select,textarea')) field.dataset.dirty = 'true';
    if (field.type === 'range') this._updateRange(field);
    if (field.name === 'mouthOpenness')
      this._emit('mouth-preview', { openness: Number(field.value) });
  }

  _onChange(event) {
    const field = event.target;
    if (field.matches('input,select,textarea')) field.dataset.dirty = 'true';
    if (field.name === 'preset') this._updatePersonaQuote();
    if (field.name === 'mode') this._updateObservationScope();
    if (field.form?.getAttribute('id') === 'mapping-form')
      this._emit('model-mapping-preview', { mapping: this._mappingValues(field.form) });
    if (field.name === 'previewPreserveIdentity') {
      delete field.dataset.dirty;
      this._emit('model-preview-identity', { value: field.checked });
    }
    if (field.name === 'memoryEnabled') {
      delete field.dataset.dirty;
      this._emit('memory-enable', { value: field.checked });
    }
  }

  _updateRange(field) {
    const output = field.parentElement.querySelector('output');
    if (output) setText(output, `${Math.round(Number(field.value) * 100)}%`);
  }

  _updateObservationScope() {
    const form = this.shadowRoot.getElementById('observation-form');
    if (!form) return;
    const mode = form.querySelector('[name="mode"]:checked')?.value || 'off';
    for (const section of form.querySelectorAll('[data-observation-scope]'))
      section.hidden = !section.dataset.observationScope.split(' ').includes(mode);
  }

  _updatePersonaQuote() {
    const quote = this.shadowRoot.getElementById('persona-quote');
    const choice = this.shadowRoot.querySelector('[name="preset"]:checked')?.value;
    if (quote && choice)
      setText(quote, `“${personas.find((persona) => persona.id === choice)?.quote || ''}”`);
  }

  _onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const value = (name) => String(data.get(name) || '').trim();
    const has = (name) => data.has(name);
    const number = (name) => Number(data.get(name));
    const clearDirty = () => {
      for (const field of form.querySelectorAll('[data-dirty]')) delete field.dataset.dirty;
    };
    // name="id"인 입력이 HTMLFormElement.id를 가릴 수 있으므로 속성을 직접 읽는다.
    switch (form.getAttribute('id')) {
      case 'chat-form': {
        const text = value('text');
        if (!text) return;
        if (Array.from(text).length > 4000) {
          this.notify('메시지는 1~4,000자로 입력해 주세요.', 'error');
          form.elements.text.focus();
          return;
        }
        form.reset();
        clearDirty();
        this._emit('chat-send', { text });
        this.shadowRoot.getElementById('chat-text')?.focus();
        break;
      }
      case 'personality-form':
        clearDirty();
        this._emit('personality-save', {
          personality: {
            preset: value('preset'),
            intensity: number('intensity'),
            frequency: number('frequency'),
            jealousy: has('jealousy'),
            jealousyIntensity: number('jealousyIntensity'),
            jealousyFrequency: number('jealousyFrequency'),
          },
        });
        break;
      case 'observation-form': {
        const observation = {
          mode: value('mode'),
          windowId: value('windowId'),
          cloudConsent: has('cloudConsent'),
          screenConsent: value('mode') === 'screen' && has('screenConsent'),
          allowedApps: splitList(value('allowedApps')),
          sensitiveApps: splitList(value('sensitiveApps')),
          focus: has('focus'),
          meeting: has('meeting'),
        };
        if (observation.mode !== 'off' && !observation.cloudConsent) {
          this.notify('함께 볼 화면을 AI 제공자에게 전달하려면 동의가 필요해요.', 'error');
          return;
        }
        if (observation.mode === 'selected' && !observation.windowId) {
          this.notify('함께 볼 창을 먼저 선택해 주세요.', 'error');
          return;
        }
        if (observation.mode === 'screen' && !observation.screenConsent) {
          this.notify(
            '모니터 전체 보기에는 다른 창과 알림도 포함돼요. 전체 화면 전송에 별도로 동의해 주세요.',
            'error',
          );
          return;
        }
        if (observation.mode === 'allowed' && !observation.allowedApps.length) {
          this.notify('먼저 반응해도 되는 앱을 추가해 주세요.', 'error');
          return;
        }
        clearDirty();
        this._emit('observation-save', { observation });
        break;
      }
      case 'mapping-form':
        clearDirty();
        this._emit('model-mapping-save', {
          mapping: this._mappingValues(form),
        });
        break;
      case 'model-switch-form':
        this._emit('model-switch', { id: value('id'), preserveIdentity: has('preserveIdentity') });
        break;
      case 'import-entry-form':
        this._emit('model-import-entry', {
          path: value('entry'),
          sourcePath: this._data.importState.sourcePath,
          preserveIdentity: this.shadowRoot.querySelector('#import-body [name="preserveIdentity"]')
            .checked,
        });
        break;
      case 'memory-form': {
        if (this._memorySaveRequest !== null) return;
        const content = value('content');
        if (!content || Array.from(content).length > 1000) {
          this._setMemoryError('기억은 1~1,000자로 입력해 주세요.');
          form.elements.content.focus();
          return;
        }
        const expiryValue = value('expiresAt');
        const expiry = expiryValue ? new Date(`${expiryValue}T23:59:59`) : null;
        if (
          expiry &&
          (!Number.isFinite(expiry.getTime()) ||
            expiry.getTime() <= Date.now() ||
            `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}` !==
              expiryValue)
        ) {
          this._setMemoryError('만료일은 오늘 이후의 유효한 날짜로 선택해 주세요.');
          form.elements.expiresAt.focus();
          return;
        }
        const requestId = ++this._memorySaveSequence;
        this._memorySaveRequest = requestId;
        this._setMemoryError('');
        // HTML maxlength counts UTF-16 units; the checks above match Rust Unicode scalars.
        const payload = {
          id: value('id') || null,
          content,
          expiresAt: expiry?.toISOString() ?? null,
          requestId,
        };
        this._setMemorySaving(true);
        this._emit('memory-save', payload);
        break;
      }
      case 'settings-form':
        clearDirty();
        this._emit('settings-save', {
          settings: {
            fps: number('fps'),
            scale: number('scale'),
            muted: has('muted'),
            alwaysOnTop: has('alwaysOnTop'),
            cursorTracking: has('cursorTracking'),
          },
        });
        break;
      default: {
        if (form.dataset.provider) {
          const payload = {
            kind: form.dataset.provider,
            endpoint: value('endpoint'),
            model: value('model'),
            apiKey: value('apiKey'),
            requiresKey: has('requiresKey'),
          };
          if (form.dataset.provider === 'tts') payload.voice = value('voice');
          form.elements.apiKey.value = '';
          clearDirty();
          this._emit('provider-save', payload);
        }
      }
    }
  }
}

if (!customElements.get('ouento-app')) customElements.define('ouento-app', OuentoApp);
