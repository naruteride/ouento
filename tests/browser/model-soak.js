// Development-only browser fixture. Vite's production inputs exclude this page.
// Exercise the genuine SDK renderer, audio decoder and GPU; do not mock those APIs.
import { CharacterRenderer } from '../../src/character/renderer';
import { SpeechPlayer } from '../../src/audio/player.js';
import { CubismMoc } from '@framework/model/cubismmoc';
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';
import { CubismMotionSyncEngineController } from '@motionsync/cubismmotionsyncenginecontroller';
import { EngineType } from '@motionsync/cubismmotionsyncutil';

const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
const run = document.querySelector('#run');
const stop = document.querySelector('#stop');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const counts = {};
const live = {};
const restores = [];
let frameTimes = [];
let cancelled = false;
let pendingFrames = new Set();
let renderer;
let player;
let gpuDrawCalls = 0;

function replace(target, name, make) {
  const original = target[name];
  target[name] = make(original);
  restores.push(() => (target[name] = original));
}
function track(kind, object) {
  if (!object) return object;
  live[kind] ??= new Set();
  counts[kind] ??= { created: 0, released: 0, peakLive: 0 };
  live[kind].add(object);
  counts[kind].created++;
  counts[kind].peakLive = Math.max(counts[kind].peakLive, live[kind].size);
  return object;
}
function release(kind, object) {
  if (live[kind]?.delete(object)) counts[kind].released++;
}
function installCounters() {
  replace(
    WebGL2RenderingContext.prototype,
    'drawElements',
    (original) =>
      function (...args) {
        const result = original.apply(this, args);
        gpuDrawCalls++;
        return result;
      },
  );
  for (const kind of [
    'Texture',
    'Buffer',
    'Program',
    'Shader',
    'Framebuffer',
    'Renderbuffer',
    'VertexArray',
  ]) {
    replace(
      WebGL2RenderingContext.prototype,
      `create${kind}`,
      (original) =>
        function (...args) {
          return track(kind, original.apply(this, args));
        },
    );
    replace(
      WebGL2RenderingContext.prototype,
      `delete${kind}`,
      (original) =>
        function (object) {
          const result = original.call(this, object);
          release(kind, object);
          return result;
        },
    );
  }
  replace(
    CubismMoc,
    'create',
    (original) =>
      function (...args) {
        return track('Moc', original.apply(this, args));
      },
  );
  replace(
    CubismMoc.prototype,
    'createModel',
    (original) =>
      function (...args) {
        return track('Model', original.apply(this, args));
      },
  );
  replace(
    CubismMoc.prototype,
    'deleteModel',
    (original) =>
      function (model) {
        const result = original.call(this, model);
        release('Model', model);
        return result;
      },
  );
  replace(
    CubismMoc.prototype,
    'release',
    (original) =>
      function () {
        const result = original.call(this);
        release('Moc', this);
        return result;
      },
  );
  replace(
    CubismRenderer_WebGL.prototype,
    'drawModel',
    (original) =>
      function (...args) {
        const result = original.apply(this, args);
        frameTimes.push(performance.now());
        return result;
      },
  );
  replace(
    window,
    'requestAnimationFrame',
    (original) =>
      function (callback) {
        const id = original.call(window, (time) => {
          pendingFrames.delete(id);
          callback(time);
        });
        pendingFrames.add(id);
        return id;
      },
  );
  replace(
    window,
    'cancelAnimationFrame',
    (original) =>
      function (id) {
        pendingFrames.delete(id);
        return original.call(window, id);
      },
  );
}

const sources = [
  {
    name: 'Mao',
    url: '/models/Mao/Mao.model3.json',
    motionSyncUrl: '/config/mao.motionsync3.json',
  },
  { name: 'Haru', url: '/models/Haru/Haru.model3.json' },
  { name: 'Kei', url: '/models/Kei_vowels/Kei_vowels.model3.json' },
];
function processorCount() {
  return (
    CubismMotionSyncEngineController.getEngine(EngineType.EngineType_Cri)
      ?.getProcessors()
      .getSize() ?? 0
  );
}
function snapshot() {
  return {
    live: Object.fromEntries(Object.entries(live).map(([kind, objects]) => [kind, objects.size])),
    motionSyncProcessors: processorCount(),
    pendingAnimationFrames: pendingFrames.size,
    audioContextState: player?.context?.state ?? 'not-created',
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
  };
}
function frameStats(times) {
  const intervals = times
    .slice(1)
    .map((time, i) => time - times[i])
    .sort((a, b) => a - b);
  const percentile = (p) =>
    intervals.length
      ? Math.round(
          intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))] * 100,
        ) / 100
      : null;
  return {
    frames: times.length,
    observedFps:
      times.length > 1
        ? Math.round(((times.length - 1) * 100000) / (times.at(-1) - times[0])) / 100
        : null,
    intervalMedianMs: percentile(0.5),
    intervalP95Ms: percentile(0.95),
  };
}
function renderReport(report) {
  output.textContent = JSON.stringify(report, null, 2);
}

async function measureFrames(fps) {
  renderer.setOptions({ fps, scale: 1 });
  frameTimes = [];
  const nativeTimes = [];
  let id;
  let running = true;
  const probe = (time) => {
    nativeTimes.push(time);
    if (running) id = requestAnimationFrame(probe);
  };
  id = requestAnimationFrame(probe);
  await sleep(2200);
  running = false;
  cancelAnimationFrame(id);
  return {
    targetFps: fps,
    model: sources[49 % 3].name,
    ...frameStats(frameTimes),
    browserRefresh: frameStats(nativeTimes),
  };
}

async function checkInterruptedLoad() {
  let releaseAsset;
  let signalRequested;
  const requested = new Promise((resolve) => {
    signalRequested = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseAsset = resolve;
  });
  let delayed = false;
  const old = renderer.load({
    ...sources[0],
    fetchAsset: async (relative) => {
      const url = relative === sources[0].url ? relative : '/models/Mao/' + relative;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fixture asset HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      if (!delayed && relative.endsWith('.physics3.json')) {
        delayed = true;
        signalRequested();
        // Ignore AbortSignal to represent an IPC that cannot cancel its read.
        // The renderer must still release the previous Core immediately.
        await gate;
      }
      return data;
    },
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('delayed asset was never requested')), 5000);
  });
  try {
    await Promise.race([requested, timeout]);
    const before = snapshot();
    await renderer.load(sources[1]);
    const during = snapshot();
    if (during.live.Model !== 1 || during.live.Moc !== 1)
      throw new Error('cancelled Core is retained by a delayed asset');
    releaseAsset();
    await old;
    const after = snapshot();
    if (after.live.Model !== 1 || after.live.Moc !== 1)
      throw new Error('late asset changed current Core ownership');
    return { status: 'passed', before, during, after };
  } finally {
    clearTimeout(timer);
    releaseAsset();
    await old.catch(() => {});
  }
}

async function checkContextRecovery() {
  const gl = renderer.canvas.getContext('webgl2');
  const extension = gl.getExtension('WEBGL_lose_context');
  if (!extension) return { status: 'unsupported', detail: 'WEBGL_lose_context unavailable' };
  const before = snapshot();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('WebGL restore deadline exceeded'));
    }, 8000);
    const cleanup = () => {
      clearTimeout(timeout);
      stage.removeEventListener('character-reload', reload);
      renderer.canvas.removeEventListener('webglcontextlost', lost);
    };
    const reload = async () => {
      try {
        await renderer.load(sources[0]);
        cleanup();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const lost = () => {
      setTimeout(() => extension.restoreContext(), 150);
    };
    stage.addEventListener('character-reload', reload, { once: true });
    renderer.canvas.addEventListener('webglcontextlost', lost, { once: true });
    extension.loseContext();
  });
  const beforeDraw = gpuDrawCalls;
  const deadline = performance.now() + 6000;
  while (gpuDrawCalls === beforeDraw && performance.now() < deadline) await sleep(100);
  if (gpuDrawCalls === beforeDraw)
    throw new Error('restored model did not issue any real GPU draws');
  const glError = gl.getError();
  if (glError !== gl.NO_ERROR) throw new Error(`restored WebGL error: ${glError}`);
  return {
    status: 'passed',
    before,
    after: snapshot(),
    gpuDrawCallsAfterRestore: gpuDrawCalls - beforeDraw,
    glError,
  };
}

async function start() {
  run.disabled = true;
  stop.disabled = false;
  cancelled = false;
  for (const key of Object.keys(counts)) delete counts[key];
  for (const key of Object.keys(live)) delete live[key];
  pendingFrames = new Set();
  installCounters();
  const started = performance.now();
  const report = {
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio,
      canvasCss: [360, 500],
      sdk: 'Web 5-r.5 / MotionSync 5-r.2',
    },
    completedLoads: 0,
    status: 'running',
    errors: [],
    checkpoints: [],
    frameMeasurements: [],
    limits:
      'API handle accounting in a browser; not physical GPU bytes, native process memory or an 8-hour soak.',
  };
  const onError = (event) =>
    report.errors.push(`${status.textContent}: ${event.error?.stack ?? event.message}`);
  window.addEventListener('error', onError);
  const onRejection = (event) =>
    report.errors.push(`${status.textContent}: ${event.reason?.stack ?? event.reason}`);
  window.addEventListener('unhandledrejection', onRejection);
  try {
    renderer = new CharacterRenderer(stage);
    player = new SpeechPlayer(renderer);
    // Prepare on the actual user gesture. Subsequent iterations reuse one context.
    await player.prepare();
    const response = await fetch('/models/Kei_vowels/sounds/01_kei_ko.wav');
    if (!response.ok) throw new Error(`sample HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768)
      binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    const audioBase64 = btoa(binary);
    const baselines = new Map();
    for (let index = 0; index < 50 && !cancelled; index++) {
      const source = sources[index % sources.length];
      status.textContent = `${index + 1}/50 · ${source.name}`;
      player.cancel();
      const before = performance.now();
      const details = await renderer.load(source);
      if (!details) throw new Error(`load interrupted: ${source.name}`);
      renderer.setOptions({ fps: 30, scale: 1, cursorTracking: true });
      renderer.setCursor((index % 5) / 2 - 1, 0.4);
      renderer.react({ emotion: index % 2 ? 'happy' : 'calm', intensity: 0.6, gesture: 'nod' });
      await sleep(220);
      if (index % 5 === 0) {
        await player.play({ utteranceId: `soak-${index}`, audioBase64 }, { muted: true });
        await sleep(400);
        if (index % 10 === 0) {
          await player.pause();
          await sleep(80);
          await player.resume();
          await sleep(120);
        }
        player.cancel();
      }
      const current = snapshot();
      if (current.live.Moc !== 1 || current.live.Model !== 1)
        throw new Error(`Core lifetime mismatch at ${index + 1}`);
      if (current.motionSyncProcessors !== (source.name === 'Haru' ? 0 : 1))
        throw new Error(`MotionSync lifetime mismatch at ${index + 1}`);
      if (current.pendingAnimationFrames !== 1)
        throw new Error(`more than one renderer loop at ${index + 1}`);
      if (index >= 9) {
        const baseline = baselines.get(source.name);
        if (baseline) {
          for (const key of Object.keys(current.live)) {
            if (current.live[key] !== baseline[key])
              throw new Error(
                `growing ${key} for ${source.name}: ${baseline[key]} -> ${current.live[key]}`,
              );
          }
        } else baselines.set(source.name, { ...current.live });
      }
      report.completedLoads++;
      report.checkpoints.push({
        load: index + 1,
        model: source.name,
        elapsedMs: Math.round(performance.now() - before),
        ...current,
      });
      renderReport(report);
    }
    if (cancelled) throw new Error('User cancelled the diagnostic');
    for (const fps of [30, 60]) {
      status.textContent = `${fps} FPS 프레임 간격 측정`;
      report.frameMeasurements.push(await measureFrames(fps));
    }
    player.cancel();
    renderer.setPaused(true);
    frameTimes = [];
    await sleep(250);
    report.paused = { ...snapshot(), drawCalls: frameTimes.length };
    if (pendingFrames.size || frameTimes.length)
      throw new Error('paused renderer still schedules/draws frames');
    renderer.setPaused(false);
    await sleep(200);
    if (pendingFrames.size !== 1) throw new Error('resume did not restore one frame loop');
    status.textContent = '지연 자산 요청 중 모델 교체 검사';
    report.interruptedLoad = await checkInterruptedLoad();
    status.textContent = 'WebGL 연결 손실·복구 검사';
    report.contextRecovery = await checkContextRecovery();
    report.status = 'passed';
  } catch (error) {
    report.status = cancelled ? 'cancelled' : 'failed';
    report.errors.push(String(error));
  } finally {
    try {
      await player?.dispose();
    } catch (error) {
      report.errors.push(`audio dispose: ${error}`);
      report.status = 'failed';
    }
    try {
      renderer?.dispose();
    } catch (error) {
      report.errors.push(`renderer dispose: ${error}`);
      report.status = 'failed';
    }
    await sleep(80);
    report.afterDispose = snapshot();
    report.resourceCalls = counts;
    for (const name of [
      'Moc',
      'Model',
      'Texture',
      'Buffer',
      'Program',
      'Shader',
      'Framebuffer',
      'Renderbuffer',
      'VertexArray',
    ]) {
      if ((report.afterDispose.live[name] ?? 0) !== 0) {
        report.status = 'failed';
        report.errors.push(`not released after dispose: ${name}`);
      }
    }
    if (processorCount() !== 0 || pendingFrames.size !== 0 || player?.context?.state !== 'closed') {
      report.status = 'failed';
      report.errors.push('processor/frame/audio survived dispose');
    }
    if (report.errors.length && report.status === 'passed') report.status = 'failed';
    report.durationMs = Math.round(performance.now() - started);
    report.summary = {
      completedLoads: report.completedLoads,
      status: report.status,
      errors: report.errors,
      frameMeasurements: report.frameMeasurements,
      paused: report.paused,
      interruptedLoad: report.interruptedLoad,
      contextRecovery: report.contextRecovery,
      afterDispose: report.afterDispose,
      resourceCalls: counts,
      durationMs: report.durationMs,
    };
    renderReport(report);
    status.textContent = `${report.status.toUpperCase()} · ${report.completedLoads}/50`;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    restores.reverse().forEach((restore) => restore());
    restores.length = 0;
    stop.disabled = true;
    // Reload for a fresh JS/SDK global state before a second run.
    run.textContent = '다시 검사하려면 페이지를 새로고침하세요';
  }
}
run.addEventListener('click', start);
stop.addEventListener('click', () => {
  cancelled = true;
  stop.disabled = true;
});
