// Development only; exercise genuine product imports, Core, WebGL and audio.
import { CharacterRenderer } from '../../src/character/renderer';
import { SpeechPlayer } from '../../src/audio/player.js';
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';

const button = document.querySelector('#run');
const stage = document.querySelector('#stage');
const gallery = document.querySelector('#gallery');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emotions = ['happy', 'sad', 'surprised', 'annoyed', 'calm'];
let renderer;
let player;
let current;
let capture;
const gpuObjects = {};
const gpuCalls = {};
const restoreGpu = [];
const gpuSnapshot = () =>
  Object.fromEntries(Object.entries(gpuObjects).map(([name, objects]) => [name, objects.size]));

const report = {
  environment: { userAgent: navigator.userAgent, devicePixelRatio, canvasCss: [300, 400] },
  status: 'ready',
  models: [],
  errors: [],
  limits:
    'Official sample packages, not ten independent user models. Browser API/visual checks, not native desktop QA or performance results.',
};
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2);
};
const modelError = (error) => {
  const message = String(error?.stack ?? error);
  const errors = current?.errors ?? report.errors;
  if (!errors.includes(message)) errors.push(message);
};

async function run() {
  button.disabled = true;
  const originalDraw = CubismRenderer_WebGL.prototype.drawModel;
  const onError = (event) => modelError(event.error ?? event.message);
  const onRejection = (event) => modelError(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  for (const kind of ['Texture', 'Buffer', 'Framebuffer', 'Program', 'Shader']) {
    gpuObjects[kind] = new Set();
    gpuCalls[kind] = { created: 0, released: 0, peakLive: 0 };
    const prototype = WebGL2RenderingContext.prototype;
    const create = prototype[`create${kind}`];
    const remove = prototype[`delete${kind}`];
    prototype[`create${kind}`] = function (...args) {
      const object = create.apply(this, args);
      if (object) {
        gpuObjects[kind].add(object);
        gpuCalls[kind].created++;
        gpuCalls[kind].peakLive = Math.max(gpuCalls[kind].peakLive, gpuObjects[kind].size);
      }
      return object;
    };
    prototype[`delete${kind}`] = function (object) {
      const result = remove.call(this, object);
      if (gpuObjects[kind].delete(object)) gpuCalls[kind].released++;
      return result;
    };
    restoreGpu.push(() => {
      prototype[`create${kind}`] = create;
      prototype[`delete${kind}`] = remove;
    });
  }
  CubismRenderer_WebGL.prototype.drawModel = function (...args) {
    const result = originalDraw.apply(this, args);
    if (!current) return result;
    current.frames++;
    const core = this.getModel();
    for (let index = 0; index < core.getParameterCount(); index++) {
      const value = core.getParameterValueByIndex(index);
      const low = core.getParameterMinimumValue(index);
      const high = core.getParameterMaximumValue(index);
      if (!Number.isFinite(value) || value < low - 0.001 || value > high + 0.001)
        modelError(
          `Parameter outside actual Core range: ${core.getParameterId(index).getString()}=${value} [${low},${high}]`,
        );
    }
    if (capture) {
      const gl = renderer.canvas.getContext('webgl2');
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      // One diagnostic read per package, never on the product's animation path.
      gl.readPixels(
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      current.visiblePixels = pixels.reduce(
        (count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0),
        0,
      );
      current.glError = gl.getError();
      const copy = document.createElement('canvas');
      copy.width = renderer.canvas.width;
      copy.height = renderer.canvas.height;
      copy.getContext('2d').drawImage(renderer.canvas, 0, 0);
      copy.setAttribute('aria-label', `${current.name}의 실제 WebGL 렌더링`);
      const resolve = capture;
      capture = null;
      resolve(copy);
    }
    return result;
  };
  try {
    report.status = 'running';
    renderer = new CharacterRenderer(stage);
    player = new SpeechPlayer(renderer);
    await player.prepare();
    const catalogResponse = await fetch('/.cache/model-compatibility/catalog.json');
    if (!catalogResponse.ok)
      throw new Error('검증 자산 catalog가 없습니다. 가져오기 검사 스크립트를 먼저 실행하세요.');
    const catalog = await catalogResponse.json();
    report.packageCount = catalog.models.length;
    report.familyCount = new Set(catalog.models.map((model) => model.family)).size;
    const audioResponse = await fetch('/models/Kei_vowels/sounds/01_kei_ko.wav');
    if (!audioResponse.ok) throw new Error('공식 한국어 확인 음원이 없습니다.');
    const bytes = new Uint8Array(await audioResponse.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const audioBase64 = btoa(binary);
    for (const source of catalog.models) {
      current = {
        name: source.name,
        family: source.family,
        nativeStatus: source.status,
        frames: 0,
        errors: [],
        status: 'running',
      };
      report.models.push(current);
      status.textContent = `${report.models.length}/${catalog.models.length} · ${source.name}`;
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption');
      caption.textContent = source.name;
      figure.append(caption);
      gallery.append(figure);
      try {
        if (!source.render?.url) throw new Error('제품 가져오기 검사를 통과한 자산이 없습니다.');
        player.cancel();
        const details = await renderer.load({ name: source.name, url: source.render.url });
        if (!details) throw new Error('모델 로딩이 중단되었습니다.');
        current.parameterCount = details.parameters.length;
        current.expressions = details.expressions;
        current.capabilities = details.capabilities;
        current.warnings = details.warnings;
        current.mapping = details.mapping;
        if (
          source.name === 'Rice' &&
          details.capabilities.find((item) => item.name === '립싱크')?.level !== 'unsupported'
        )
          throw new Error('입 파라미터가 없는 Rice에 립싱크 지원을 표시했습니다.');
        if (source.name === 'Wanko') {
          if (
            details.capabilities.find((item) => item.name === '커서 추적')?.level !== 'unsupported'
          )
            throw new Error('구형 고개 ID를 연결하기 전에 추적 지원을 표시했습니다.');
          const manual = renderer.setMapping({
            angleX: 'PARAM_ANGLE_X',
            angleY: 'PARAM_ANGLE_Y',
            bodyAngle: 'PARAM_BODY_ANGLE_X',
            breath: 'PARAM_BREATH',
            mouthForm: 'PARAM_MOUTH_FORM',
          });
          current.manualMapping = manual;
          if (manual.capabilities.find((item) => item.name === '커서 추적')?.level !== 'fallback')
            throw new Error('Wanko의 고개 수동 연결 후 대체 추적 안내가 없습니다.');
        }
        renderer.setOptions({ fps: 30, scale: 1, cursorTracking: true });
        await player.play({ utteranceId: `compat:${source.name}`, audioBase64 }, { muted: true });
        for (let index = 0; index < emotions.length; index++) {
          renderer.react({
            emotion: emotions[index],
            intensity: 0.8,
            gaze: 'user',
            gesture: 'nod',
          });
          renderer.setCursor((index - 2) / 2, index % 2 ? -0.8 : 0.8);
          await wait(260);
        }
        player.cancel();
        renderer.setCursor(0, 0);
        renderer.react({ emotion: 'calm', intensity: 0.5, gesture: 'none' });
        await wait(400);
        let timeout;
        const screenshot = await Promise.race([
          new Promise((resolve) => {
            capture = resolve;
          }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('렌더링 프레임이 없습니다.')), 5000);
          }),
        ]).finally(() => {
          clearTimeout(timeout);
          capture = null;
        });
        figure.prepend(screenshot);
        if (!current.frames || !current.visiblePixels)
          modelError('Actual rendered frame contains no visible model pixels');
        if (current.glError !== 0) modelError(`WebGL error ${current.glError}`);
        current.status = current.errors.length ? 'failed' : 'passed';
      } catch (error) {
        modelError(error);
        current.status = 'failed';
      }
      caption.textContent = `${source.name} · ${current.status}\n${current.parameterCount ?? 0} parameters · ${current.warnings?.length ?? 0} warnings`;
      current.gpuLive = gpuSnapshot();
      publish();
    }
    report.status =
      report.models.every((model) => model.status === 'passed') && !report.errors.length
        ? 'passed'
        : 'failed';
  } catch (error) {
    report.errors.push(String(error));
    report.status = 'failed';
  } finally {
    current = null;
    try {
      await player?.dispose();
      renderer?.dispose();
    } catch (error) {
      report.errors.push(String(error));
      report.status = 'failed';
    }
    report.gpuAfterDispose = gpuSnapshot();
    report.gpuCalls = gpuCalls;
    if (Object.values(report.gpuAfterDispose).some((count) => count !== 0)) {
      report.errors.push('GPU handles survived renderer disposal');
      report.status = 'failed';
    }
    restoreGpu.forEach((restore) => restore());
    stage.hidden = true;
    CubismRenderer_WebGL.prototype.drawModel = originalDraw;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    report.summary = {
      status: report.status,
      packageCount: report.packageCount,
      familyCount: report.familyCount,
      errors: report.errors,
      gpuAfterDispose: report.gpuAfterDispose,
      gpuCalls,
      models: report.models,
    };
    publish();
    status.textContent = `${report.status.toUpperCase()} · ${report.models.filter((model) => model.status === 'passed').length}/${report.packageCount ?? 0}`;
    button.textContent = '다시 검사하려면 새로고침하세요';
  }
}
button.addEventListener('click', run);
