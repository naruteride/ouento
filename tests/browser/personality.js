import '../../src/ui/app.js';
import personas from '../../src/personality-presets.json' with { type: 'json' };

const app = document.querySelector('ouento-app');
const root = app.shadowRoot;
const checks = document.querySelector('#checks');
const report = document.querySelector('#report');
const status = document.querySelector('#status');
const run = document.querySelector('#run');
const actions = [];
app.addEventListener('action', (event) => actions.push(event.detail));
let results;
const query = (selector) => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`요소를 찾을 수 없습니다: ${selector}`);
  return node;
};
const field = (name) => query(`#personality-form [name="${name}"]`);
const edit = (name, value) => {
  const node = field(name);
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  return node;
};
const lastSave = () => actions.filter((action) => action.type === 'personality-save').at(-1);
function check(name, passed) {
  results.push({ name, passed: !!passed });
  const row = document.createElement('li');
  row.dataset.passed = String(!!passed);
  row.textContent = `${passed ? '통과' : '실패'} · ${name}`;
  checks.append(row);
  report.textContent = JSON.stringify(results, null, 2);
}
function ticks() {
  for (let i = 0; i < 4; i++) app.update({ observation: { status: `합성 상태 ${i}` } });
}
function submit() {
  query('#personality-form').requestSubmit();
}

function runChecks() {
  run.disabled = true;
  results = [];
  checks.replaceChildren();
  actions.length = 0;
  status.textContent = '검사 중…';
  try {
    app.navigate('chat');
    app._pageSnapshots.clear();
    app.data = { ready: true };
    app.navigate('personality');
    check(
      '기본 성격은 츤데레 여동생이며 호칭·예시가 채워짐',
      field('userAddress').value === '오빠' &&
        field('personalityPrompt').value.includes('츤데레 여동생') &&
        field('dialogueExamples').value.includes('상황:'),
    );
    check(
      '외형 설정과 실제 모델 변경을 구분하여 안내',
      query('#appearance-help').textContent.includes('실제 Live2D 모델은 캐릭터 메뉴'),
    );
    const prompt = edit('personalityPrompt', '첫 줄: <장난> & "다정함"\n두 번째 줄: 😀 함께 쉬기');
    prompt.focus();
    prompt.setSelectionRange(2, 11);
    ticks();
    check(
      '주기 갱신에도 초안·입력 DOM·선택 범위 유지',
      field('personalityPrompt') === prompt &&
        prompt.value.endsWith('😀 함께 쉬기') &&
        root.activeElement === prompt &&
        prompt.selectionStart === 2 &&
        prompt.selectionEnd === 11,
    );
    const name = edit('characterName', '나의 <별빛>');
    const address = edit('userAddress', '언니');
    check('고정 프리뷰에 작성 중 호칭 반영', query('#persona-quote').textContent.includes('언니,'));
    query('[data-do="personality-preview"]').click();
    const preview = actions.at(-1);
    check(
      '프리뷰는 일상 고정 예시이고 초안 호칭 전달',
      preview.scene === 'taking-a-break' && preview.text.startsWith('언니, '),
    );
    query('[name="preset"][value="cat"]').click();
    ticks();
    check(
      '성격 라디오 변경 시 작성한 내용 보존',
      prompt.value.endsWith('😀 함께 쉬기') &&
        field('userAddress').value === '언니' &&
        query('[name="preset"]:checked').value === 'cat',
    );
    app.navigate('settings');
    app.navigate('personality');
    check(
      '페이지를 오가도 모든 설정 초안 보존',
      field('characterName').value === name.value &&
        field('userAddress').value === address.value &&
        field('personalityPrompt').value === prompt.value &&
        query('[name="preset"]:checked').value === 'cat',
    );
    query('[data-do="personality-load-example"]').click();
    check(
      '명시적으로 예시를 불러올 때만 템플릿 적용, 이름 유지',
      field('personalityPrompt').value === personas[1].profile.personalityPrompt &&
        field('userAddress').value === '너' &&
        field('characterName').value === '나의 <별빛>',
    );
    const multiline = '나는 <괄호> & 따옴표 "를 써.\n두 번째 줄 😀';
    edit('personalityPrompt', multiline);
    submit();
    const first = lastSave();
    check(
      '줄바꿈·특수문자 그대로 저장 이벤트 전달',
      first.personality.profile.personalityPrompt === multiline,
    );
    check(
      '저장 중 중복 클릭을 막고 초안은 유지',
      query('#personality-form fieldset').disabled &&
        field('personalityPrompt').dataset.dirty === 'true',
    );
    ticks();
    check('저장 중 주기 갱신에도 pending 상태 유지', query('#personality-form fieldset').disabled);
    app.completePersonalitySave(first.requestId, '합성 저장 실패 <details>');
    ticks();
    check(
      '실패 후 초안 유지·재시도 가능·오류는 텍스트로 표시',
      field('personalityPrompt').value === multiline &&
        !query('#personality-form fieldset').disabled &&
        query('#personality-error').textContent === '합성 저장 실패 <details>' &&
        !query('#personality-error').querySelector('details'),
    );
    submit();
    const second = lastSave();
    app.completePersonalitySave(first.requestId);
    check(
      '이전 저장의 늦은 완료는 현재 저장을 끝내지 않음',
      query('#personality-form fieldset').disabled,
    );
    app.update({ personality: second.personality });
    app.completePersonalitySave(second.requestId);
    check(
      '성공 후 초안 표시를 지우고 저장한 값 유지',
      !field('personalityPrompt').dataset.dirty &&
        field('personalityPrompt').value === multiline &&
        !query('#personality-form fieldset').disabled,
    );
    edit('speechStyle', '다른 페이지에서 완료될 설정');
    submit();
    const third = lastSave();
    app.navigate('chat');
    app.update({ personality: third.personality });
    app.completePersonalitySave(third.requestId);
    app.navigate('personality');
    check(
      '다른 페이지에서 저장 완료 후 오래된 초안이 되살아나지 않음',
      field('speechStyle').value === '다른 페이지에서 완료될 설정' &&
        !field('speechStyle').dataset.dirty,
    );
    const savedCount = actions.filter((action) => action.type === 'personality-save').length;
    edit('relationship', '가'.repeat(201));
    submit();
    check(
      '글자 수 초과 시 저장하지 않고 초안 보존',
      actions.filter((action) => action.type === 'personality-save').length === savedCount &&
        field('relationship').value.length === 201,
    );
    app.navigate('chat');
    app._pageSnapshots.clear();
    app.data = { ready: true };
    app.navigate('personality');
    const failed = results.filter((item) => !item.passed).length;
    status.textContent = `${results.length - failed}/${results.length} 통과${failed ? ` · ${failed}개 실패` : ''}`;
    status.dataset.passed = String(failed === 0);
  } catch (error) {
    check('검사 실행 중 오류 없음', false);
    status.textContent = String(error.stack || error);
    status.dataset.passed = 'false';
  } finally {
    run.disabled = false;
  }
}
run.addEventListener('click', runChecks);
runChecks();
