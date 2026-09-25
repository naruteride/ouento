import {
  SpeechBubble,
  speechBubbleDuration,
  speechBubbleStyles,
} from '../../src/ui/speech-bubble.js';

const style = document.createElement('style');
style.textContent = speechBubbleStyles;
document.head.append(style);
const element = document.querySelector('#bubble');
const bubble = new SpeechBubble(element);
const status = document.querySelector('#status');
const output = document.querySelector('#report');
const buttons = [...document.querySelectorAll('button')];
const shortText = '오늘도 수고했어. 잠깐 쉬어 갈까?';
const longText = (
  '오늘 한 일을 천천히 돌아보자. 작은 진전도 쌓이면 멋진 결과가 될 거야. ' +
  '급하게 서두르지 않아도 괜찮아. 잠깐 창밖을 보고 물 한 잔을 마신 뒤 이어 가자. '
)
  .repeat(3)
  .slice(0, 180);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const rounded = (value) => Math.round(value * 1000) / 1000;

function sample(elapsed) {
  const computed = getComputedStyle(element);
  const translateY = computed.transform === 'none' ? 0 : new DOMMatrix(computed.transform).m42;
  return {
    milliseconds: rounded(elapsed),
    opacity: rounded(Number(computed.opacity)),
    translateY: rounded(translateY),
    display: computed.display,
    state: element.dataset.state,
    transitionDuration: computed.transitionDuration,
  };
}

async function sampleFrames(milliseconds, start) {
  const samples = [sample(performance.now() - start)];
  while (performance.now() - start < milliseconds) {
    await nextFrame();
    samples.push(sample(performance.now() - start));
  }
  return samples;
}

function show(text) {
  status.removeAttribute('data-passed');
  status.textContent = `${speechBubbleDuration(text) / 1000}초 유지한 뒤 아래로 내려가며 사라집니다.`;
  bubble.show(text);
}

document.querySelector('#short').addEventListener('click', () => show(shortText));
document.querySelector('#long').addEventListener('click', () => show(longText));
document.querySelector('#hide').addEventListener('click', () => {
  bubble.hide();
  status.removeAttribute('data-passed');
  status.textContent = '400ms 동안 아래로 내려가며 사라집니다.';
});

document.querySelector('#verify').addEventListener('click', async () => {
  for (const button of buttons) button.disabled = true;
  status.removeAttribute('data-passed');
  status.textContent = '실제 200ms 등장 · 400ms 퇴장 프레임을 측정하고 있습니다…';
  const report = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    shortDuration: speechBubbleDuration(shortText),
    longDuration: speechBubbleDuration(longText),
    checks: [],
    passed: false,
  };
  try {
    bubble.hide(true);
    await nextFrame();
    await nextFrame();
    const enterStart = performance.now();
    bubble.show(shortText, true);
    report.enter = await sampleFrames(260, enterStart);
    const exitStart = performance.now();
    bubble.hide();
    report.exit = await sampleFrames(460, exitStart);
    const middle = (frames) => frames.some((frame) => frame.opacity > 0 && frame.opacity < 1);
    const moved = (frames) => frames.some((frame) => frame.translateY > 0 && frame.translateY < 8);
    const hasDuration = (frame, expected) =>
      frame.transitionDuration.split(',').every((duration) => duration.trim() === expected);
    const lastEntry = report.enter.at(-1);
    const lastExit = report.exit.at(-1);
    report.checks = [
      {
        name: '짧은 대사 9초 · 긴 대사 20초',
        passed: report.shortDuration === 9000 && report.longDuration === 20000,
      },
      { name: '실제 등장 전환 200ms', passed: hasDuration(report.enter[0], '0.2s') },
      { name: '등장 중간 불투명도 표본', passed: middle(report.enter) },
      {
        name: '등장 완료 불투명도 1 · 원래 위치',
        passed: lastEntry.opacity === 1 && lastEntry.translateY === 0,
      },
      { name: '실제 퇴장 전환 400ms', passed: hasDuration(report.exit[0], '0.4s') },
      { name: '퇴장 중간 불투명도 표본', passed: middle(report.exit) },
      {
        name: report.reducedMotion
          ? '동작 줄이기: 세로 이동 없음'
          : '등장·퇴장 중간 세로 이동 표본',
        passed: report.reducedMotion
          ? [...report.enter, ...report.exit].every((frame) => frame.translateY === 0)
          : moved(report.enter) && moved(report.exit),
      },
      {
        name: '퇴장 완료 display:none · hidden',
        passed: lastExit.display === 'none' && lastExit.state === 'hidden',
      },
    ];
    report.passed = report.checks.every((check) => check.passed);
    const count = report.checks.filter((check) => check.passed).length;
    status.dataset.passed = String(report.passed);
    status.textContent = `${report.passed ? '전체 통과' : '검사 실패'} · ${count}/${report.checks.length} 통과${report.passed ? '' : ' · 상세 표본을 확인해 주세요.'}`;
  } catch (error) {
    report.error = String(error.stack || error);
    status.dataset.passed = 'false';
    status.textContent = '검사 중 오류가 발생했습니다. 상세 보고서를 확인해 주세요.';
  } finally {
    report.finishedAt = new Date().toISOString();
    output.textContent = JSON.stringify(report, null, 2);
    for (const button of buttons) button.disabled = false;
  }
});
