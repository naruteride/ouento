// Development-only fixture. Private state probes and GPU reads remain in this file.
import { CharacterRenderer } from '../../src/character/renderer';
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';

const stage = document.querySelector('#stage');
const gallery = document.querySelector('#gallery');
const output = document.querySelector('#report');
const status = document.querySelector('#status');
const run = document.querySelector('#run');
const stop = document.querySelector('#stop');
const sources = [
  { name: 'Mao', url: '/models/Mao/Mao.model3.json' },
  { name: 'Haru', url: '/models/Haru/Haru.model3.json' },
  { name: 'Kei', url: '/models/Kei_vowels/Kei_vowels.model3.json' },
];
const gestures = [
  ['nod', '끄덕임', ['ParamAngleY']],
  ['tilt', '기울임', ['ParamAngleZ', 'ParamBodyAngleZ']],
  ['smallBounce', '작은 상체 리듬', ['ParamAngleY', 'ParamBodyAngleY']],
  ['lookAway', '고개 돌림', ['ParamAngleX', 'ParamBodyAngleX']],
];
const axisIds = [
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cancelled = false;
let renderer;
let report;
let observeFrame;
const rounded = (value) => Math.round(value * 1e6) / 1e6;
const renderReport = () => {
  output.textContent = JSON.stringify(report, null, 2);
};

async function until(predicate, timeout = 12000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (cancelled) throw new Error('검사를 중단했습니다.');
    if (performance.now() > deadline)
      throw new Error(
        '실제 렌더 프레임 대기 시간이 초과되었습니다. 페이지를 보이는 상태로 유지해 주세요.',
      );
    await wait(30);
  }
}

function checkGl(gl) {
  const errors = [];
  for (let index = 0; index < 16; index++) {
    const error = gl.getError();
    if (!error) break;
    errors.push(error);
  }
  return errors;
}

function parameterValues() {
  return renderer.parameters.map((_, index) =>
    renderer.model.coreModel.getParameterValueByIndex(index),
  );
}

// Obtain the idle reference at precisely this frame's elapsed time and smoothed
// head position through the product updater, then restore every Core parameter.
// No animation step, physics advance, or extra model.update() happens in the probe.
function idleReference(values) {
  const gesture = renderer.gesture;
  try {
    renderer.gesture = 'none';
    renderer.updateFace(0);
    return parameterValues();
  } finally {
    renderer.gesture = gesture;
    values.forEach((value, index) =>
      renderer.model.coreModel.setParameterValueByIndex(index, value),
    );
  }
}

function addFrame(container, age) {
  const figure = document.createElement('figure');
  const canvas = document.createElement('canvas');
  canvas.width = 224;
  canvas.height = 288;
  // Copy before the WebGL drawing buffer is discarded at the end of this frame.
  canvas.getContext('2d').drawImage(renderer.canvas, 0, 0, canvas.width, canvas.height);
  const caption = document.createElement('figcaption');
  caption.textContent = `${age.toFixed(2)}초`;
  figure.append(canvas, caption);
  container.append(figure);
}

async function exercise(source, [gesture, label, changedAxes]) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  title.textContent = `${source.name} · ${label}`;
  const resultText = document.createElement('p');
  resultText.className = 'result';
  resultText.textContent = '실제 프레임 수집 중…';
  const frames = document.createElement('div');
  frames.className = 'frames';
  section.append(title, resultText, frames);
  gallery.append(section);

  const result = {
    model: source.name,
    gesture,
    gestureIntensity: 0.8,
    frames: 0,
    gpuDrawCalls: 0,
    glErrors: [],
    parameterErrors: [],
    matrixStable: true,
    peakOffsets: Object.fromEntries(axisIds.map((id) => [id, 0])),
    samples: [],
    returnAtSeconds: null,
    returnMaxError: null,
    passed: false,
  };
  const errorStart = report.errors.length;
  report.cases.push(result);
  const initialMatrix = Array.from(renderer.model.getModelMatrix().getArray());
  const modelCount = renderer.model.coreModel.getParameterCount();
  const indices = axisIds.map((id) =>
    renderer.parameters.findIndex((parameter) => parameter.id === id),
  );
  if (indices.some((index) => index < 0))
    throw new Error(`${source.name}: 검사 대상 실제 파라미터가 없습니다.`);
  const startedDrawCalls = report.gpuDrawCalls;
  const targets = [0, 0.22, 0.55, 1.0, 3.0];
  let done = false;
  renderer.react({ emotion: 'calm', intensity: 0, gesture, gestureIntensity: 0.8, gaze: 'user' });
  const start = renderer.elapsed;
  observeFrame = () => {
    if (done) return;
    result.frames++;
    const age = renderer.elapsed - start;
    const values = parameterValues();
    const reference = idleReference(values);
    const offsets = Object.fromEntries(
      axisIds.map((id, axis) => [id, values[indices[axis]] - reference[indices[axis]]]),
    );
    for (const id of axisIds)
      result.peakOffsets[id] = Math.max(result.peakOffsets[id], Math.abs(offsets[id]));
    if (renderer.model.coreModel.getParameterCount() !== modelCount)
      throw new Error('몸짓이 가상 파라미터를 만들었습니다.');
    renderer.parameters.forEach((parameter, index) => {
      const value = values[index];
      if (
        (!Number.isFinite(value) ||
          value < parameter.minimum - 1e-5 ||
          value > parameter.maximum + 1e-5) &&
        result.parameterErrors.length < 12
      )
        result.parameterErrors.push({
          id: parameter.id,
          value,
          minimum: parameter.minimum,
          maximum: parameter.maximum,
          age,
        });
    });
    const matrix = renderer.model.getModelMatrix().getArray();
    result.matrixStable &&= initialMatrix.every(
      (value, index) => Math.abs(value - matrix[index]) < 1e-7,
    );
    result.glErrors.push(...checkGl(renderer.gl));
    if (targets.length && age >= targets[0]) {
      targets.shift();
      addFrame(frames, age);
      result.samples.push({
        age: rounded(age),
        offsets: Object.fromEntries(axisIds.map((id) => [id, rounded(offsets[id])])),
      });
    }
    if (age >= 3) {
      result.returnAtSeconds = rounded(age);
      result.returnMaxError = Math.max(...Object.values(offsets).map(Math.abs));
      result.gpuDrawCalls = report.gpuDrawCalls - startedDrawCalls;
      result.peakOffsets = Object.fromEntries(
        axisIds.map((id) => [id, rounded(result.peakOffsets[id])]),
      );
      result.passed =
        result.frames > 30 &&
        result.gpuDrawCalls > 0 &&
        result.glErrors.length === 0 &&
        result.parameterErrors.length === 0 &&
        result.matrixStable &&
        result.returnMaxError < 1e-5 &&
        changedAxes.every((id) => result.peakOffsets[id] > 0.01) &&
        axisIds
          .filter((id) => !changedAxes.includes(id))
          .every((id) => result.peakOffsets[id] < 1e-5) &&
        report.errors.length === errorStart;
      resultText.textContent = `${result.passed ? '통과' : '실패'} · ${result.frames}프레임 · GL 오류 ${result.glErrors.length} · 범위 오류 ${result.parameterErrors.length} · 모델 행렬 ${result.matrixStable ? '고정' : '변화'} · 3초 복귀 오차 ${result.returnMaxError.toExponential(2)}`;
      done = true;
      renderReport();
    }
  };
  await until(() => done, 15000);
  observeFrame = null;
}

run.addEventListener('click', async () => {
  run.disabled = true;
  stop.disabled = false;
  cancelled = false;
  gallery.replaceChildren();
  report = {
    startedAt: new Date().toISOString(),
    environment: { userAgent: navigator.userAgent, devicePixelRatio, canvasCss: [280, 360] },
    method:
      '실제 SDK drawModel 직후 검사. 커서·깜박임 고정, 감정 강도 0, 몸짓 강도 0.8. 복귀는 동일 프레임 제품 updateFace(0)의 none 기준과 비교. 모델 행렬 고정 검사.',
    gpuDrawCalls: 0,
    cases: [],
    errors: [],
    passed: false,
  };
  renderReport();
  const originalDraw = CubismRenderer_WebGL.prototype.drawModel;
  let restoreDrawElements;
  const onError = (event) => {
    report.errors.push(String(event.error?.stack ?? event.message));
    renderReport();
  };
  const onRejection = (event) => {
    report.errors.push(String(event.reason?.stack ?? event.reason));
    renderReport();
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  CubismRenderer_WebGL.prototype.drawModel = function (...args) {
    const result = originalDraw.apply(this, args);
    if (this === renderer?.model?.getRenderer() && observeFrame) {
      try {
        observeFrame();
      } catch (error) {
        report.errors.push(String(error.stack ?? error));
        observeFrame = null;
        cancelled = true;
        renderReport();
      }
    }
    return result;
  };
  try {
    renderer = new CharacterRenderer(stage);
    renderer.setOptions({ fps: 30, cursorTracking: false, scale: 1 });
    const gl = renderer.gl;
    const originalElements = gl.drawElements;
    gl.drawElements = function (...args) {
      report.gpuDrawCalls++;
      return originalElements.apply(this, args);
    };
    restoreDrawElements = () => {
      gl.drawElements = originalElements;
    };
    for (const source of sources) {
      status.textContent = `${source.name} 실제 모델 준비 중…`;
      await renderer.load(source);
      renderer.head = { x: 0, y: 0 };
      renderer.gaze = { x: 0, y: 0 };
      renderer.emotionWeights = {};
      renderer.blinkAt = Infinity;
      renderer.blinkStart = -100;
      let visible = false;
      observeFrame = () => {
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        const errors = checkGl(gl);
        if (errors.length) throw new Error(`준비 프레임 WebGL 오류: ${errors.join(', ')}`);
        for (let index = 3; index < pixels.length; index += 4)
          if (pixels[index] > 128) {
            visible = true;
            break;
          }
      };
      await until(() => visible);
      observeFrame = null;
      for (const gesture of gestures) {
        if (cancelled) throw new Error('검사를 중단했습니다.');
        status.textContent = `${source.name} · ${gesture[1]} 검사 중 (${report.cases.length + 1}/12)…`;
        await exercise(source, gesture);
      }
    }
    report.passed =
      report.cases.length === 12 &&
      report.cases.every((result) => result.passed) &&
      !report.errors.length;
    status.textContent = report.passed
      ? '12개 몸짓 수치 검사 통과 · 연속 이미지로 외형을 확인해 주세요.'
      : '검사 실패 · 보고서의 오류를 확인해 주세요.';
  } catch (error) {
    report.errors.push(String(error.stack ?? error));
    status.textContent = cancelled ? '검사 중단' : '검사 실패';
  } finally {
    observeFrame = null;
    renderer?.dispose();
    restoreDrawElements?.();
    CubismRenderer_WebGL.prototype.drawModel = originalDraw;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    report.finishedAt = new Date().toISOString();
    renderReport();
    run.disabled = false;
    stop.disabled = true;
  }
});
stop.addEventListener('click', () => {
  cancelled = true;
  status.textContent = '현재 검사를 정리하고 있습니다…';
});
