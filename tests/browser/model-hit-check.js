// Diagnostic only: compare the real product hitTest with pixels from the same GPU frame.
import { CharacterRenderer } from '../../src/character/renderer';
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';
import { CubismModel } from '@framework/model/cubismmodel';
const stage = document.querySelector('#stage');
const gallery = document.querySelector('#gallery');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
const button = document.querySelector('#run');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let renderer;
let capture;
let controls = {};
let partControls = {};
const cases = [
  { name: 'Haru', scene: 'default' },
  { name: 'Mao', scene: 'default' },
  { name: 'Ren', scene: 'default' },
  { name: 'Ren', scene: 'reload-default' },
  {
    name: 'Ren',
    scene: 'display',
    parameters: {
      ParamDisplayWidth1: 1,
      ParamDisplayHeight1: 1,
      ParamDisplayWidth2: 1,
      ParamDisplayHeight2: 1,
      ParamDisplayAngle: 1,
    },
  },
  {
    name: 'Ren',
    scene: 'hologram',
    parameters: { ParamHologram: 1, ParamTransparent: 1, ParamHologramPattern: 0.2 },
  },
  {
    name: 'Ren',
    scene: 'noise-motion-tail',
    parameters: {
      ParamNoise: 1,
      ParamNoiseRotate: 0.012,
      ParamDisplayAngle: 0.017,
      ParamNight: 1,
      ParamLight: 0.186,
    },
  },
  { name: 'Ren', scene: 'root-offscreen-zero', parts: { PartAll: 0 } },
];
const report = {
  environment: { userAgent: navigator.userAgent, devicePixelRatio, canvasCss: [300, 400] },
  models: [],
  errors: [],
};
function trackResources(gl) {
  const tracked = {};
  const restore = [];
  for (const kind of ['Framebuffer', 'Texture']) {
    const live = new Set();
    const counts = { created: 0, released: 0, peak: 0, active: 0 };
    const create = gl[`create${kind}`];
    const release = gl[`delete${kind}`];
    gl[`create${kind}`] = function (...args) {
      const handle = create.apply(this, args);
      if (handle) {
        live.add(handle);
        counts.created++;
        counts.peak = Math.max(counts.peak, live.size);
      }
      return handle;
    };
    gl[`delete${kind}`] = function (handle) {
      const result = release.call(this, handle);
      if (live.delete(handle)) counts.released++;
      return result;
    };
    tracked[kind] = { live, counts };
    restore.push(() => {
      gl[`create${kind}`] = create;
      gl[`delete${kind}`] = release;
    });
  }
  return {
    finish() {
      for (const cleanup of restore) cleanup();
      return Object.fromEntries(
        Object.entries(tracked).map(([kind, { live, counts }]) => [
          kind,
          { ...counts, active: live.size },
        ]),
      );
    },
  };
}
function compare() {
  const gl = renderer.canvas.getContext('webgl2');
  const w = gl.drawingBufferWidth,
    h = gl.drawingBufferHeight;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const glError = gl.getError();
  if (glError) throw new Error(`WebGL error ${glError}`);
  const copy = document.createElement('canvas');
  copy.width = w;
  copy.height = h;
  const ctx = copy.getContext('2d');
  ctx.drawImage(renderer.canvas, 0, 0);
  const result = {
    samples: 0,
    rawFalsePositive: 0,
    rawFalseNegative: 0,
    clearFalsePositive: 0,
    opaqueFalseNegative: 0,
    examples: [],
    elapsedMs: 0,
    glError,
  };
  const before = performance.now();
  for (let y = 6; y < h - 1; y += 12)
    for (let x = 6; x < w - 1; x += 12) {
      const hit = renderer.hitTest((2 * (x + 0.5)) / w - 1, (2 * (y + 0.5)) / h - 1);
      const alpha = pixels[(y * w + x) * 4 + 3];
      result.samples++;
      if (hit && alpha <= 12) result.rawFalsePositive++;
      if (!hit && alpha > 12) result.rawFalseNegative++;
      let minimum = 255,
        maximum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const a = pixels[((y + dy) * w + x + dx) * 4 + 3];
          minimum = Math.min(minimum, a);
          maximum = Math.max(maximum, a);
        }
      const clear = hit && maximum <= 2;
      const opaque = !hit && minimum >= 128;
      if (clear) result.clearFalsePositive++;
      if (opaque) result.opaqueFalseNegative++;
      if (clear || opaque) {
        if (result.examples.length < 16)
          result.examples.push({ x, y, alpha, minimum, maximum, hit });
        ctx.fillStyle = clear ? '#ed174c' : '#1687fa';
        ctx.fillRect(x - 3, h - y - 4, 7, 7);
      }
    }
  result.elapsedMs = Math.round((performance.now() - before) * 100) / 100;
  return { result, copy };
}
button.addEventListener('click', async () => {
  button.disabled = true;
  let resourceTracker;
  const draw = CubismRenderer_WebGL.prototype.drawModel;
  const update = CubismModel.prototype.update;
  const onError = (event) => report.errors.push(String(event.error?.stack ?? event.message));
  window.addEventListener('error', onError);
  CubismModel.prototype.update = function (...args) {
    if (
      this === renderer?.model?.coreModel &&
      (Object.keys(controls).length || Object.keys(partControls).length)
    ) {
      const model = this;
      for (const [id, value] of Object.entries(controls)) {
        const index = renderer.parameters.findIndex((parameter) => parameter.id === id);
        if (index < 0) throw new Error(`검사 파라미터 없음: ${id}`);
        const parameter = renderer.parameters[index];
        if (value < parameter.minimum || value > parameter.maximum)
          throw new Error(`검사 파라미터 범위 초과: ${id}`);
        model.setParameterValueByIndex(index, value);
      }
      for (const [id, opacity] of Object.entries(partControls)) {
        let part = -1;
        for (let index = 0; index < model.getPartCount(); index++)
          if (model.getPartId(index).getString() === id) part = index;
        if (part < 0) throw new Error(`검사 Part 없음: ${id}`);
        model.setPartOpacityByIndex(part, opacity);
      }
    }
    return update.apply(this, args);
  };
  CubismRenderer_WebGL.prototype.drawModel = function (...args) {
    const output = draw.apply(this, args);
    if (capture) {
      const pending = capture;
      capture = null;
      try {
        pending.resolve(compare());
      } catch (error) {
        pending.reject(error);
      }
    }
    return output;
  };
  try {
    renderer = new CharacterRenderer(stage);
    resourceTracker = trackResources(renderer.canvas.getContext('webgl2'));
    const response = await fetch('/.cache/model-compatibility/catalog.json');
    if (!response.ok) throw new Error('검증 자산 catalog가 없습니다.');
    const catalog = await response.json();
    for (const testCase of cases) {
      const { name, scene, parameters = {}, parts = {} } = testCase;
      controls = {};
      partControls = {};
      status.textContent = `${name} ${scene} 픽셀 비교`;
      const source = catalog.models.find((model) => model.name === name);
      if (!source?.render?.url) throw new Error(`${name}의 검증 자산이 없습니다.`);
      await renderer.load({ name, url: source.render.url });
      controls = parameters;
      partControls = parts;
      renderer.setOptions({ fps: 30, scale: 1, cursorTracking: true });
      renderer.setCursor(0, 0);
      await wait(800);
      let timeout;
      const captured = await new Promise((resolve, reject) => {
        capture = { resolve, reject };
        timeout = setTimeout(() => {
          capture = null;
          reject(new Error('프레임 비교 시간 초과'));
        }, 5000);
      }).finally(() => clearTimeout(timeout));
      report.models.push({ name, scene, parameters, parts, ...captured.result });
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption');
      caption.textContent = `${name} ${scene} · 투명 오판 ${captured.result.clearFalsePositive} · 불투명 오판 ${captured.result.opaqueFalseNegative}`;
      figure.append(captured.copy, caption);
      gallery.append(figure);
      output.textContent = JSON.stringify(report, null, 2);
    }
  } catch (error) {
    report.errors.push(String(error));
  } finally {
    renderer?.dispose();
    if (resourceTracker) {
      report.resourcesAfterDispose = resourceTracker.finish();
      for (const [kind, counts] of Object.entries(report.resourcesAfterDispose))
        if (counts.active) report.errors.push(`${kind} 해제 후 잔여 핸들: ${counts.active}`);
    }
    stage.hidden = true;
    CubismRenderer_WebGL.prototype.drawModel = draw;
    CubismModel.prototype.update = update;
    window.removeEventListener('error', onError);
    report.status = report.errors.length ? 'error' : 'measured';
    output.textContent = JSON.stringify(report, null, 2);
    status.textContent = `${report.status} · ${report.models.length}/${cases.length}`;
  }
});
