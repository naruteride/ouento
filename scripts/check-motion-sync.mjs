// Actual pinned Core/Framework + public Korean sample. This is not a browser audio/visual test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const read = (filename) => fs.readFileSync(path.join(root, filename));
const asArray = (value) =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
function loadCore(filename) {
  const box = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Buffer,
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
  vm.runInContext(read(filename).toString(), box, { timeout: 10000 });
  return box;
}

try {
  const cubism = loadCore('vendor/cubism-core/live2dcubismcore.js');
  const motion = loadCore('vendor/motionsync-core/CRI/live2dcubismmotionsynccore.js');
  await new Promise(setImmediate);
  globalThis.Live2DCubismCore = cubism.Live2DCubismCore;
  globalThis.Live2DCubismMotionSyncCore = motion.Live2DCubismMotionSyncCore;
  const bundled = await build({
    stdin: {
      contents: `
      export { CubismFramework, Option, LogLevel } from './vendor/cubism-framework/src/live2dcubismframework';
      export { CubismMoc } from './vendor/cubism-framework/src/model/cubismmoc';
      export { CubismMotionSyncEngineController } from './vendor/motionsync/src/cubismmotionsyncenginecontroller';
      export { EngineType } from './vendor/motionsync/src/cubismmotionsyncutil';
      export { createMotionSync } from './src/character/motion-sync';
    `,
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

  const wav = read('public/models/Kei_vowels/sounds/01_kei_ko.wav');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let format, raw;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const chunk = wav.subarray(offset + 8, offset + 8 + size);
    if (wav.toString('ascii', offset, offset + 4) === 'fmt ') format = chunk;
    if (wav.toString('ascii', offset, offset + 4) === 'data') raw = chunk;
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && raw);
  assert.equal(format.readUInt16LE(0), 1);
  assert.equal(format.readUInt16LE(2), 2);
  assert.equal(format.readUInt32LE(4), 48000);
  assert.equal(format.readUInt16LE(14), 16);
  const audio = new Float32Array(raw.length / 4);
  for (let index = 0; index < audio.length; index++)
    audio[index] = (raw.readInt16LE(index * 4) + raw.readInt16LE(index * 4 + 2)) / 65536;

  const results = [];
  for (const [name, mocPath, configPath] of [
    [
      'Kei_vowels',
      'public/models/Kei_vowels/Kei_vowels.moc3',
      'public/models/Kei_vowels/Kei_vowels.motionsync3.json',
    ],
    ['Mao', 'public/models/Mao/Mao.moc3', 'public/config/mao.motionsync3.json'],
  ]) {
    const moc = sdk.CubismMoc.create(asArray(read(mocPath)), true);
    assert.ok(moc, `${name} Core consistency`);
    const model = moc.createModel();
    let current = true;
    const settings = asArray(read(configPath));
    const invalid = JSON.parse(read(configPath).toString());
    invalid.Settings[0].CubismParameters[0].Id = 'NonexistentParameter';
    await assert.rejects(
      sdk.createMotionSync(model, asArray(Buffer.from(JSON.stringify(invalid)))),
      /파라미터/,
    );
    const disconnected = JSON.parse(read(configPath).toString());
    disconnected.Settings[0].Mappings = [];
    await assert.rejects(
      sdk.createMotionSync(model, asArray(Buffer.from(JSON.stringify(disconnected)))),
      /대상/,
    );
    const sync = await sdk.createMotionSync(model, settings, () => current);
    const engine = sdk.CubismMotionSyncEngineController.getEngine(sdk.EngineType.EngineType_Cri);
    // The SDK can allocate one native processor before a later setting throws. Preserve the
    // live model's processor while closing only allocations belonging to the failed creation.
    const existing = engine.getProcessors().at(0);
    const multiple = JSON.parse(read(configPath).toString());
    multiple.Settings.push(structuredClone(multiple.Settings[0]));
    multiple.Meta.SettingCount = 2;
    const createProcessor = engine.CreateProcessor;
    let allocations = 0;
    engine.CreateProcessor = function (...args) {
      if (++allocations === 2) throw new Error('injected second-context allocation failure');
      return createProcessor.apply(this, args);
    };
    try {
      await assert.rejects(
        sdk.createMotionSync(model, asArray(Buffer.from(JSON.stringify(multiple)))),
        /second-context allocation failure/,
      );
      assert.equal(allocations, 2);
      assert.equal(
        engine.getProcessors().getSize(),
        1,
        'failed creation leaves no native processor',
      );
      assert.equal(
        engine.getProcessors().at(0),
        existing,
        'other model processor survives failure',
      );
    } finally {
      engine.CreateProcessor = createProcessor;
    }
    const requiredSamples = engine.getProcessors().at(0).getRequireSampleCount();
    const parameters = JSON.parse(read(configPath).toString()).Settings[0].CubismParameters;
    const peaks = Object.fromEntries(parameters.map((parameter) => [parameter.Id, 0]));
    const pattern = [137, 2048, 511, 800, 7, 1600];
    let turn = 0;
    let maximumTail = 0;
    for (let offset = 0; offset < audio.length;) {
      const chunk = audio.subarray(
        offset,
        Math.min(audio.length, offset + pattern[turn++ % pattern.length]),
      );
      sync.push(chunk, chunk.length / 48000);
      sync.apply();
      offset += chunk.length;
      const diagnostics = sync.getDiagnostics();
      assert.equal(diagnostics.receivedSamples, offset);
      for (let index = 0; index < diagnostics.processedSamples.length; index++) {
        assert.equal(
          diagnostics.processedSamples[index] + diagnostics.pendingSamples[index],
          offset,
          'PCM conservation across render frames',
        );
        maximumTail = Math.max(maximumTail, diagnostics.pendingSamples[index]);
      }
      for (const parameter of parameters) {
        const value = model.getParameterValueById(
          sdk.CubismFramework.getIdManager().getId(parameter.Id),
        );
        assert.ok(
          Number.isFinite(value) &&
            value >= parameter.Min - 0.0001 &&
            value <= parameter.Max + 0.0001,
          `${name}/${parameter.Id} range`,
        );
        peaks[parameter.Id] = Math.max(peaks[parameter.Id], value);
      }
    }
    const afterSpeech = sync.getDiagnostics();
    assert.ok(
      Object.values(peaks).some((value) => value > 0.1),
      'real speech changes mapped mouth parameters',
    );
    for (let index = 0; index < 60; index++) {
      sync.push(new Float32Array(800), 800 / 48000);
      sync.apply();
    }
    const silence = Object.fromEntries(
      parameters.map((parameter) => [
        parameter.Id,
        model.getParameterValueById(sdk.CubismFramework.getIdManager().getId(parameter.Id)),
      ]),
    );
    assert.ok(
      Object.values(silence).every((value) => Math.abs(value) < 0.001),
      'silence closes mouth shapes',
    );
    sync.reset();
    sync.reset();
    assert.equal(sync.getDiagnostics().resets, 1, 'repeated reset is idempotent without new audio');
    current = false;
    sync.push(new Float32Array(800), 800 / 48000);
    assert.equal(sync.getDiagnostics().disposed, true);
    sync.dispose();
    sync.dispose();
    sync.apply();
    sync.reset();
    assert.equal(engine.getProcessors().getSize(), 0, 'model disposal releases analysis contexts');
    moc.deleteModel(model);
    moc.release();
    results.push({
      model: name,
      inputFrames: audio.length,
      requiredSamples,
      maximumTail,
      processedSamples: afterSpeech.processedSamples,
      pendingSamples: afterSpeech.pendingSamples,
      peaks,
      silence,
    });
  }

  // Reproduce cancellation while a script is loading; no model member may be touched afterwards.
  const motionCore = globalThis.Live2DCubismMotionSyncCore;
  globalThis.Live2DCubismMotionSyncCore = undefined;
  let script,
    stillCurrent = true;
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      append(value) {
        script = value;
      },
    },
  };
  const releasedModel = new Proxy(
    {},
    {
      get() {
        throw new Error('released model was accessed');
      },
    },
  );
  const pending = sdk.createMotionSync(releasedModel, new ArrayBuffer(0), () => stillCurrent);
  stillCurrent = false;
  globalThis.Live2DCubismMotionSyncCore = motionCore;
  script.onload();
  await assert.rejects(pending, { name: 'AbortError' });
  delete globalThis.document;
  console.log(
    JSON.stringify(
      { passed: true, sample: '01_kei_ko.wav', cancellationDuringCoreLoad: 'passed', results },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`MotionSync verification failed: ${error.message}`);
  process.exitCode = 1;
}
