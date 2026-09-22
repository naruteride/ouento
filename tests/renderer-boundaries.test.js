import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = (file) => fs.readFileSync(path.join(root, file));
const buffer = (value) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
const box = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  Uint8Array,
  ArrayBuffer,
  Float32Array,
  Int32Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Uint8ClampedArray,
  TextDecoder,
  atob,
};
vm.createContext(box);
vm.runInContext(bytes('vendor/cubism-core/live2dcubismcore.js').toString(), box);
await new Promise(setImmediate);
globalThis.Live2DCubismCore = box.Live2DCubismCore;
const bundled = await build({
  stdin: {
    contents: `export { CharacterRenderer } from './src/character/renderer'; export * from './src/character/optional-assets'; export { CubismFramework, Option, LogLevel } from '@framework/live2dcubismframework'; export { CubismMoc } from '@framework/model/cubismmoc'; export { CubismShaderManager_WebGL } from '@framework/rendering/cubismshader_webgl'; export { CubismWebGLOffscreenManager } from '@framework/rendering/cubismoffscreenmanager'; export { CubismOffscreenRenderTarget_WebGL } from '@framework/rendering/cubismoffscreenrendertarget_webgl'; export { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  target: 'es2022',
  logLevel: 'silent',
  alias: {
    '@framework': path.join(root, 'vendor/cubism-framework/src'),
    '@motionsync': path.join(root, 'vendor/motionsync/src'),
  },
});
const sdk = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);
const option = new sdk.Option();
option.loggingLevel = sdk.LogLevel.LogLevel_Off;
sdk.CubismFramework.startUp(option);
sdk.CubismFramework.initialize();

test('optional validators accept the pinned official assets against actual Core IDs', () => {
  for (const [name, filename] of [
    ['Mao', 'Mao'],
    ['Haru', 'Haru'],
    ['Kei_vowels', 'Kei_vowels'],
  ]) {
    const folder = `public/models/${name}/`;
    const refs = JSON.parse(bytes(`${folder}${filename}.model3.json`)).FileReferences;
    const moc = sdk.CubismMoc.create(buffer(bytes(folder + refs.Moc)), true);
    assert.ok(moc);
    const model = moc.createModel();
    const ids = new Set(
      Array.from({ length: model.getParameterCount() }, (_, i) =>
        model.getParameterId(i).getString(),
      ),
    );
    const parts = new Set(
      Array.from({ length: model.getPartCount() }, (_, i) => model.getPartId(i).getString()),
    );
    if (refs.Physics) sdk.validatePhysics(JSON.parse(bytes(folder + refs.Physics)), ids);
    if (refs.Pose) sdk.validatePose(JSON.parse(bytes(folder + refs.Pose)), parts);
    for (const expression of refs.Expressions ?? [])
      sdk.parseExpression(JSON.parse(bytes(folder + expression.File)), ids);
    moc.deleteModel(model);
    moc.release();
  }
});

test('malformed expression values cannot reach frame arithmetic', () => {
  const ids = new Set(['ParamMouthOpenY']);
  for (const value of [
    { Parameters: {} },
    { Parameters: [null] },
    { Parameters: [{ Id: 'missing', Value: 1 }] },
    { Parameters: [{ Id: 'ParamMouthOpenY', Value: 'bad' }] },
    { Parameters: [{ Id: 'ParamMouthOpenY', Value: NaN }] },
    { Parameters: [{ Id: 'ParamMouthOpenY', Value: Infinity }] },
    { Parameters: [{ Id: 'ParamMouthOpenY', Value: 1, Blend: 'Run' }] },
  ])
    assert.throws(() => sdk.parseExpression(value, ids));
  assert.deepEqual(
    sdk.parseExpression({ Parameters: [{ Id: 'ParamMouthOpenY', Value: 1 }] }, ids),
    [{ Id: 'ParamMouthOpenY', Value: 1, Blend: 'Add' }],
  );
});

test('physics counts and pose identities are validated before SDK allocation', () => {
  const physics = JSON.parse(bytes('public/models/Mao/Mao.physics3.json'));
  const ids = new Set(
    physics.PhysicsSettings.flatMap((setting) => [
      ...setting.Input.map((p) => p.Source.Id),
      ...setting.Output.map((p) => p.Destination.Id),
    ]),
  );
  physics.Meta.VertexCount = 1_000_000_000;
  assert.throws(() => sdk.validatePhysics(physics, ids), /VertexCount/);
  assert.throws(() => sdk.validatePose({ Groups: [[{ Id: 'missing' }]] }, new Set()), /파츠/);
  assert.throws(() => sdk.validatePose({ Groups: {}, FadeInTime: NaN }, new Set()));
});

test('hidden, paused and lost contexts have no scheduled frame; resume has one reset clock', () => {
  const frames = new Map();
  const previous = {
    document: globalThis.document,
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  let sequence = 0;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++sequence;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const renderer = Object.create(sdk.CharacterRenderer.prototype);
  const deltas = [];
  let physicalContextLost = false;
  let draw = () => {};
  const matrix = {
    setHeight() {
      return this;
    },
    setPosition() {},
    getArray() {
      return new Float32Array(16);
    },
  };
  Object.assign(renderer, {
    ready: true,
    disposed: false,
    paused: false,
    contextLost: false,
    raf: 0,
    last: 0,
    fps: 30,
    scale: 1,
    mapping: {},
    canvas: { clientWidth: 100, clientHeight: 100, width: 100, height: 100 },
    gl: { viewport() {}, clearColor() {}, clear() {}, isContextLost: () => physicalContextLost },
    model: {
      step(dt) {
        deltas.push(dt);
      },
      coreModel: { getCanvasHeight: () => 1, getCanvasWidth: () => 1 },
      getModelMatrix: () => matrix,
      getRenderer: () => ({
        setMvpMatrix() {},
        setRenderState() {},
        drawModel() {
          draw();
        },
      }),
    },
  });
  const tick = (now) => {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback(now);
  };
  try {
    renderer.syncFrameLoop();
    renderer.syncFrameLoop();
    assert.equal(frames.size, 1);
    tick(100);
    assert.equal(frames.size, 1);
    renderer.setPaused(true);
    assert.equal(frames.size, 0);
    renderer.setPaused(false);
    renderer.setPaused(false);
    assert.equal(frames.size, 1);
    tick(100_000);
    assert.equal(deltas.at(-1), 1 / 30);
    for (const fps of [30, 60]) {
      renderer.setPaused(true);
      renderer.setOptions({ fps });
      renderer.setPaused(false);
      deltas.length = 0;
      const duration = 10_000;
      for (let i = 0; i < 600; i++)
        tick(200_000 + (i * duration) / 600 + [0, 0.2, -0.2, 0.3][i % 4]);
      assert.ok(Math.abs(deltas.length - fps * 10) <= 1, `${fps} FPS preserves reservation phase`);
      assert.ok(Math.abs(deltas.reduce((sum, dt) => sum + dt, 0) - 10) < 0.05);
      assert.equal(frames.size, 1, 'frame jitter never creates a second loop');
      tick(900_000);
      assert.equal(deltas.at(-1), 0.05, 'long suspension clamps actual animation time');
      assert.ok(renderer.nextDeadline > 900_000, 'missed deadlines do not trigger catch-up loops');
    }
    document.hidden = true;
    renderer.syncFrameLoop();
    assert.equal(frames.size, 0);
    document.hidden = false;
    renderer.syncFrameLoop();
    assert.equal(frames.size, 1);
    const beforeNativeLoss = deltas.length;
    physicalContextLost = true;
    assert.equal(renderer.contextLost, false, 'native flag can precede the DOM event');
    tick(950_000);
    assert.equal(deltas.length, beforeNativeLoss, 'pre-event native loss prevents SDK work');
    assert.equal(frames.size, 0);
    physicalContextLost = false;
    renderer.syncFrameLoop();
    draw = () => {
      physicalContextLost = true;
      throw new TypeError('null viewport during draw');
    };
    assert.doesNotThrow(() => tick(960_000), 'mid-draw native loss waits for recovery');
    assert.equal(frames.size, 0);
    physicalContextLost = false;
    renderer.syncFrameLoop();
    draw = () => {
      throw new Error('unrelated renderer bug');
    };
    assert.throws(() => tick(970_000), /unrelated renderer bug/, 'ordinary errors stay visible');
    draw = () => {};
    renderer.contextLost = true;
    renderer.syncFrameLoop();
    assert.equal(frames.size, 0);
    renderer.contextLost = false;
    renderer.ready = false;
    renderer.syncFrameLoop();
    assert.equal(frames.size, 0);
    renderer.disposed = true;
    renderer.ready = true;
    renderer.syncFrameLoop();
    assert.equal(frames.size, 0);
  } finally {
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  }
});

test('stalled optional IPC releases pending Core immediately; late bytes cannot resurrect it', async () => {
  const original = {
    cancel: globalThis.cancelAnimationFrame,
    window: globalThis.window,
    document: globalThis.document,
    create: sdk.CubismMoc.prototype.createModel,
    delete: sdk.CubismMoc.prototype.deleteModel,
    release: sdk.CubismMoc.prototype.release,
  };
  let created = 0,
    released = 0,
    mocReleased = 0;
  sdk.CubismMoc.prototype.createModel = function (...args) {
    created++;
    return original.create.apply(this, args);
  };
  sdk.CubismMoc.prototype.deleteModel = function (...args) {
    released++;
    return original.delete.apply(this, args);
  };
  sdk.CubismMoc.prototype.release = function (...args) {
    mocReleased++;
    return original.release.apply(this, args);
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = globalThis.document = { removeEventListener() {} };
  const renderer = Object.create(sdk.CharacterRenderer.prototype);
  Object.assign(renderer, {
    generation: 0,
    disposed: false,
    contextLost: false,
    pendingLoad: null,
    model: null,
    motionSync: null,
    textures: [],
    indices: new Map(),
    observer: { disconnect() {} },
    canvas: { remove() {} },
    gl: { isContextLost: () => false },
  });
  const folder = 'public/models/Mao/';
  const makePending = (delayFile) => {
    let deliver, requested, signal;
    const requestedPromise = new Promise((resolve) => {
      requested = resolve;
    });
    const gate = new Promise((resolve) => {
      deliver = resolve;
    });
    const load = renderer.load({
      url: 'Mao.model3.json',
      name: 'Mao',
      fetchAsset: async (file, receivedSignal) => {
        if (file === delayFile) {
          signal = receivedSignal;
          requested();
          await gate; // Deliberately ignore cancellation, as native IPC can.
        }
        return buffer(bytes(folder + file));
      },
    });
    return { load, requested: requestedPromise, deliver: () => deliver(), signal: () => signal };
  };
  try {
    const first = makePending('Mao.physics3.json');
    await first.requested;
    assert.equal(created - released, 1);
    const second = makePending('Mao.physics3.json');
    assert.ok(first.signal().aborted);
    assert.equal(
      released,
      1,
      'old Core releases synchronously before the next load awaits anything',
    );
    assert.equal(
      await first.load,
      undefined,
      'cancelled load settles without the late IPC response',
    );
    await second.requested;
    assert.equal(created - released, 1);
    first.deliver();
    await new Promise(setImmediate);
    assert.equal(created - released, 1, 'late bytes preserve the new load');
    const third = makePending('Mao.moc3');
    await third.requested;
    assert.equal(created, 2);
    assert.equal(released, 2);
    renderer.dispose();
    assert.ok(third.signal().aborted);
    second.deliver();
    third.deliver();
    await Promise.all([second.load, third.load]);
    assert.equal(created, 2, 'late MOC does not allocate a Core after disposal');
    assert.equal(released, 2, 'each created Core is released exactly once');
    assert.equal(mocReleased, 2);
    assert.equal(renderer.pendingLoad, null);
    assert.equal(renderer.model, null);
  } finally {
    renderer.dispose();
    globalThis.cancelAnimationFrame = original.cancel;
    globalThis.window = original.window;
    globalThis.document = original.document;
    sdk.CubismMoc.prototype.createModel = original.create;
    sdk.CubismMoc.prototype.deleteModel = original.delete;
    sdk.CubismMoc.prototype.release = original.release;
  }
});

test('per-context shader release preserves other canvases and invalidates late compilation', async () => {
  const manager = sdk.CubismShaderManager_WebGL.getInstance();
  const deleted = [[], []];
  const contexts = deleted.map((programs) => ({
    deleteProgram(program) {
      programs.push(program);
    },
  }));
  contexts.forEach((gl) => manager.setGlContext(gl));
  const [first, second] = contexts.map((gl) => manager.getShader(gl));
  const sharedProgram = {},
    otherProgram = {};
  first._shaderSets = [{ shaderProgram: sharedProgram }, { shaderProgram: sharedProgram }];
  second._shaderSets = [{ shaderProgram: otherProgram }];
  first._isShaderLoaded = second._isShaderLoaded = true;
  manager.releaseContext(contexts[0]);
  manager.releaseContext(contexts[0]);
  assert.equal(
    manager.getShader(contexts[0]),
    undefined,
    'strong Map no longer retains disposed GL',
  );
  assert.deepEqual(deleted[0], [sharedProgram], 'shared program is deleted once');
  assert.equal(manager.getShader(contexts[1]), second);
  assert.equal(second._isShaderLoaded, true);
  assert.deepEqual(deleted[1], []);
  manager.setGlContext(contexts[0]);
  const restored = manager.getShader(contexts[0]);
  assert.notEqual(restored, first, 'restored GL has fresh shader state');
  assert.equal(restored._isShaderLoaded, false);
  let finish,
    registrations = 0;
  restored.loadShaders = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  restored.registerShader = restored.registerBlendShader = () => {
    registrations++;
  };
  restored.generateShaders();
  manager.releaseContext(contexts[0]);
  finish();
  await new Promise(setImmediate);
  assert.equal(registrations, 0, 'disposed async shader load cannot allocate programs');
  assert.equal(restored._shaderSets.length, 0);
  assert.equal(restored._isShaderLoaded, false);
  manager.releaseContext(contexts[1]);
  assert.deepEqual(deleted[1], [otherProgram]);
});

test('model replacement removes the real SDK offscreen pool before another model borrows it', () => {
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousBuffer = globalThis.WebGLBuffer;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.WebGLBuffer = class {};
  let sequence = 0;
  const makeGl = () => ({
    FRAMEBUFFER: 1,
    FRAMEBUFFER_COMPLETE: 2,
    FRAMEBUFFER_BINDING: 3,
    TEXTURE_2D: 4,
    bound: null,
    createTexture: () => ({ id: ++sequence, deleted: false }),
    createFramebuffer: () => ({ id: ++sequence, deleted: false }),
    deleteTexture(texture) {
      if (texture) texture.deleted = true;
    },
    deleteFramebuffer(framebuffer) {
      if (framebuffer) framebuffer.deleted = true;
    },
    bindTexture(_target, texture) {
      assert.ok(!texture?.deleted, 'cannot bind a deleted texture');
    },
    bindFramebuffer(_target, framebuffer) {
      assert.ok(!framebuffer?.deleted, 'cannot bind a deleted framebuffer');
      this.bound = framebuffer;
    },
    getParameter() {
      return this.bound;
    },
    texImage2D() {},
    texParameteri() {},
    framebufferTexture2D() {},
    deleteBuffer() {},
    checkFramebufferStatus() {
      return this.FRAMEBUFFER_COMPLETE;
    },
  });
  const pool = sdk.CubismWebGLOffscreenManager.getInstance();
  const gl = makeGl();
  const otherGl = makeGl();
  const allocate = (context) => {
    const target = new sdk.CubismOffscreenRenderTarget_WebGL();
    target.setOffscreenRenderTarget(context, 256, 256, null);
    target.beginDraw();
    target.endDraw();
    target.stopUsingRenderTexture();
    return target;
  };
  const renderer = Object.create(sdk.CharacterRenderer.prototype);
  Object.assign(renderer, {
    gl,
    generation: 0,
    pendingLoad: null,
    model: null,
    motionSync: null,
    textures: [],
    indices: new Map(),
  });
  try {
    // Control: the pinned SDK deletes a borrowed handle but keeps its container.
    const stale = allocate(gl);
    const staleHandle = stale.getRenderTexture();
    stale.destroyRenderTarget();
    const reused = new sdk.CubismOffscreenRenderTarget_WebGL();
    reused.setOffscreenRenderTarget(gl, 256, 256, null);
    assert.equal(reused.getRenderTexture(), staleHandle);
    assert.throws(() => reused.beginDraw(), /deleted framebuffer/);
    pool.removeContext(gl);

    const other = allocate(otherGl);
    const otherHandle = other.getRenderTexture();
    let previousHandle = staleHandle;
    for (let replacement = 0; replacement < 3; replacement++) {
      const target = allocate(gl);
      const handle = target.getRenderTexture();
      assert.notEqual(handle, previousHandle, 'replacement gets a live framebuffer');
      assert.equal(handle.deleted, false);
      const nativeRenderer = new sdk.CubismRenderer_WebGL(256, 256);
      nativeRenderer.gl = gl;
      nativeRenderer._offscreenList = [target];
      renderer.model = { dispose: () => nativeRenderer.release() };
      renderer.clearModel();
      assert.equal(handle.deleted, true, 'actual SDK release deletes the borrowed handle');
      assert.equal(pool._contextManagers.has(gl), false, 'clearModel removes the stale pool');
      assert.equal(otherHandle.deleted, false, 'another canvas keeps its framebuffer');
      assert.doesNotThrow(() => {
        other.beginDraw();
        other.endDraw();
      });
      previousHandle = handle;
    }
    assert.doesNotThrow(() => renderer.clearModel(), 'repeated clearing stays safe');
  } finally {
    renderer.clearModel();
    pool.removeContext(gl);
    pool.removeContext(otherGl);
    globalThis.cancelAnimationFrame = previousCancel;
    globalThis.WebGLBuffer = previousBuffer;
  }
});

test('manual mapping changes recompute mouth, gaze and emotion support and notify UI', () => {
  const previous = globalThis.CustomEvent;
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
    }
  };
  const events = [];
  const renderer = Object.create(sdk.CharacterRenderer.prototype);
  Object.assign(renderer, {
    mapping: {},
    indices: new Map([
      ['Mouth', 0],
      ['Eye', 1],
    ]),
    expressions: {},
    warnings: [],
    model: { hasPhysics: false },
    motionSync: null,
    container: {
      dispatchEvent(event) {
        events.push(event);
      },
    },
  });
  try {
    renderer.setMapping({ mouthOpen: 'Mouth', gazeX: 'Eye' });
    assert.equal(renderer.capabilities[0].level, 'fallback');
    assert.equal(renderer.capabilities[1].level, 'unsupported');
    assert.equal(renderer.capabilities[3].level, 'fallback');
    renderer.setMapping({ mouthOpen: '', gazeX: '' });
    assert.equal(renderer.capabilities[0].level, 'unsupported');
    assert.equal(renderer.capabilities[3].level, 'unsupported');
    assert.equal(events.at(-1).type, 'character-capabilities');
    let released = false;
    renderer.motionSync = {
      apply() {
        throw new Error('decoder stopped');
      },
      dispose() {
        released = true;
      },
    };
    renderer.speaking = true;
    renderer.mouthOpen = renderer.mouthValue = 0;
    renderer.updateMouth(1 / 30);
    assert.ok(released);
    assert.equal(renderer.motionSync, null);
    assert.equal(renderer.capabilities[3].level, 'unsupported');
    assert.ok(
      events
        .findLast((event) => event.type === 'character-capabilities')
        .detail.warnings.some((warning) => warning.includes('MotionSync')),
    );
  } finally {
    globalThis.CustomEvent = previous;
  }
});
