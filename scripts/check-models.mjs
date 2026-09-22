// 실제 SDK/Core를 사용하는 개발 진단. 렌더링·오디오 출력·OS 검증은 수행하지 않는다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild'; // Vite가 고정한 빌드 도구를 재사용한다.

const root = fileURLToPath(new URL('../', import.meta.url));
const vowelIds = ['ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO'];
const read = (file) => readFile(path.join(root, file));
const asArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function loadCore(file, globalName) {
  const sandbox = {
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
  vm.createContext(sandbox);
  vm.runInContext((await read(file)).toString('utf8'), sandbox, { timeout: 10_000 });
  // 배포 Core의 WebAssembly 초기화가 완료되도록 한 이벤트 루프를 진행한다.
  await new Promise(setImmediate);
  assert.ok(sandbox[globalName], `${globalName} 초기화 실패`);
  globalThis[globalName] = sandbox[globalName];
}

async function loadSdk() {
  const bundled = await build({
    stdin: {
      contents: `
        export { CubismFramework, Option, LogLevel } from './vendor/cubism-framework/src/live2dcubismframework';
        export { CubismMoc } from './vendor/cubism-framework/src/model/cubismmoc';
        export { CubismMotionSync, MotionSyncOption } from './vendor/motionsync/src/live2dcubismmotionsync';
        export { csmVector } from './vendor/cubism-framework/src/type/csmvector';
      `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    alias: { '@framework': path.join(root, 'vendor/cubism-framework/src') },
    target: 'es2022',
    logLevel: 'silent',
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  );
}

function parseSample(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'RIFF 형식 필요');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', 'WAVE 형식 필요');
  let format;
  let raw;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    assert.ok(end <= bytes.length, 'WAV 청크 길이 오류');
    const type = bytes.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') {
      assert.ok(size >= 16, 'WAV fmt 청크 길이 오류');
      format = {
        encoding: bytes.readUInt16LE(offset + 8),
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        bits: bytes.readUInt16LE(offset + 22),
      };
    }
    if (type === 'data') raw = bytes.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  assert.deepEqual(format, { encoding: 1, channels: 2, sampleRate: 48_000, bits: 16 });
  assert.ok(raw?.length && raw.length % 4 === 0, 'stereo PCM16 데이터 필요');
  const pcm = new Float32Array(raw.length / 4);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = (raw.readInt16LE(index * 4) + raw.readInt16LE(index * 4 + 2)) / 65_536;
  }
  return { pcm, sampleRate: format.sampleRate };
}

async function main() {
  await loadCore('vendor/cubism-core/live2dcubismcore.js', 'Live2DCubismCore');
  await loadCore(
    'vendor/motionsync-core/CRI/live2dcubismmotionsynccore.js',
    'Live2DCubismMotionSyncCore',
  );
  const sdk = await loadSdk();
  const options = new sdk.Option();
  options.loggingLevel = sdk.LogLevel.LogLevel_Off;
  sdk.CubismFramework.startUp(options);
  sdk.CubismFramework.initialize();
  const motionOptions = new sdk.MotionSyncOption();
  motionOptions.logFunction = () => {};
  motionOptions.loggingLevel = sdk.LogLevel.LogLevel_Off;
  sdk.CubismMotionSync.startUp(motionOptions);
  sdk.CubismMotionSync.initialize();

  console.log(`Cubism Core 0x${globalThis.Live2DCubismCore.Version.csmGetVersion().toString(16)}`);
  for (const [name, file] of [
    ['Mao', 'public/models/Mao/Mao.moc3'],
    ['Haru', 'public/models/Haru/Haru.moc3'],
    ['Kei_vowels', 'public/models/Kei_vowels/Kei_vowels.moc3'],
  ]) {
    const bytes = asArrayBuffer(await read(file));
    const moc = sdk.CubismMoc.create(bytes, true);
    assert.ok(moc, `${name} Core 정합성 검사 실패`);
    const model = moc.createModel();
    assert.ok(model, `${name} 모델 생성 실패`);
    model.update();
    console.log(
      `${name}: MOC version ${globalThis.Live2DCubismCore.Version.csmGetMocVersion(bytes)}, ${model.getParameterCount()} parameters, ${model.getDrawableCount()} drawables`,
    );
    moc.deleteModel(model);
    moc.release();
  }

  const moc = sdk.CubismMoc.create(asArrayBuffer(await read('public/models/Mao/Mao.moc3')), true);
  assert.ok(moc, 'Mao MOC 생성 실패');
  const model = moc.createModel();
  let sync;
  try {
    const configuration = await read('public/config/mao.motionsync3.json');
    const settings = JSON.parse(configuration).Settings;
    assert.equal(settings.length, 1);
    assert.deepEqual(
      settings[0].CubismParameters.map((item) => item.Id),
      vowelIds,
    );
    const ids = vowelIds.map((id) => sdk.CubismFramework.getIdManager().getId(id));
    for (const id of ids) {
      const index = model.getParameterIndex(id);
      assert.ok(
        index >= 0 && index < model.getParameterCount(),
        `Mao 실제 파라미터 없음: ${id.getString()}`,
      );
      assert.equal(model.getParameterMinimumValue(index), 0);
      assert.equal(model.getParameterMaximumValue(index), 1);
      assert.equal(model.getParameterDefaultValue(index), 0);
    }
    const { pcm, sampleRate } = parseSample(
      await read('public/models/Kei_vowels/sounds/01_kei_ko.wav'),
    );
    const configBytes = asArrayBuffer(configuration);
    sync = sdk.CubismMotionSync.create(model, configBytes, configBytes.byteLength, sampleRate);
    assert.ok(sync, 'Mao MotionSync 생성 실패');

    // SDK R2의 공개 API에 소비량 조회가 없어 개발 진단에서만 내부 프로세서 정보를 읽는다.
    const info = sync._processorInfoList.at(0);
    const required = info._processor.getRequireSampleCount();
    assert.ok(Number.isInteger(required) && required > 0, '유효하지 않은 분석 샘플 수');
    const maxima = vowelIds.map(() => 0);
    const feed = (chunk) => {
      const vector = new sdk.csmVector();
      for (const sample of chunk) vector.pushBack(sample);
      sync.setSoundBuffer(0, vector, 0);
      sync.updateParameters(model, chunk.length / sampleRate);
      ids.forEach((id, index) => {
        const value = model.getParameterValueById(id);
        assert.ok(
          Number.isFinite(value) && value >= 0 && value <= 1,
          `${vowelIds[index]} 범위 위반: ${value}`,
        );
        maxima[index] = Math.max(maxima[index], value);
      });
    };
    // 마지막 잔여 PCM도 버리지 않고 무음으로 분석 단위에 맞춘다.
    const chunkSize = required * 4;
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = new Float32Array(chunkSize);
      chunk.set(pcm.subarray(offset, Math.min(pcm.length, offset + chunkSize)));
      feed(chunk);
    }
    for (let pass = 0; pass < 100; pass += 1) feed(new Float32Array(required));
    const silence = ids.map((id) => model.getParameterValueById(id));
    assert.ok(
      maxima.every((value) => value > 0),
      '일부 모음이 전혀 움직이지 않음',
    );
    assert.ok(
      silence.every((value) => Math.abs(value) < 1e-6),
      '무음 후 입 모양이 닫히지 않음',
    );
    console.log(`한국어 PCM ${pcm.length} frames / ${sampleRate}Hz, CRI unit ${required}`);
    console.log(
      'Mao peak:',
      Object.fromEntries(vowelIds.map((id, index) => [id, Number(maxima[index].toFixed(6))])),
    );
    console.log(
      '무음 복귀:',
      Object.fromEntries(vowelIds.map((id, index) => [id, silence[index]])),
    );
    console.log(
      '통과: 실제 모델 정합성·Mao 모음 범위·한국어 PCM 분석·무음 복귀. 시청각/플랫폼 검증은 별도입니다.',
    );
  } finally {
    sync?.release();
    moc.deleteModel(model);
    moc.release();
    sdk.CubismMotionSync.dispose();
    // headless 검사에는 WebGL 렌더러 staticRelease가 없다. Framework는 이 프로세스 종료 시 해제된다.
  }
}

main().catch((error) => {
  console.error(`모델 진단 실패: ${error.message}`);
  console.error('npm ci 및 npm run assets:setup을 먼저 실행했는지 확인하세요.');
  process.exitCode = 1;
});
