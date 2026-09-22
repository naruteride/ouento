import { CubismMotionSync, MotionSyncOption } from '@motionsync/live2dcubismmotionsync';
import { CubismMotionSyncEngineController } from '@motionsync/cubismmotionsyncenginecontroller';
import { EngineType } from '@motionsync/cubismmotionsyncutil';
import { CubismModel } from '@framework/model/cubismmodel';
import { csmVector } from '@framework/type/csmvector';

const SAMPLE_RATE = 48000;
const MAX_PENDING_SAMPLES = SAMPLE_RATE * 2;
let coreReady: Promise<void> | undefined;

function coreAvailable() {
  return (
    typeof Live2DCubismMotionSyncCore !== 'undefined' &&
    typeof Live2DCubismMotionSyncCore.CubismMotionSyncEngine?.csmMotionSyncGetEngineVersion ===
      'function'
  );
}

function loadCore(): Promise<void> {
  if (coreAvailable()) return Promise.resolve();
  if (coreReady) return coreReady;
  const script = document.createElement('script');
  script.src = '/vendor/motionsync-core/CRI/live2dcubismmotionsynccore.min.js';
  const loading = new Promise<void>((resolve, reject) => {
    script.onload = () =>
      coreAvailable()
        ? resolve()
        : reject(new Error('MotionSync Core API가 초기화되지 않았습니다.'));
    script.onerror = () => reject(new Error('MotionSync Core를 읽을 수 없습니다.'));
    document.head.append(script);
  });
  coreReady = loading.catch((error) => {
    coreReady = undefined;
    script.remove();
    throw error;
  });
  return coreReady;
}

function cancelled() {
  const error = new Error('모델이 변경되어 MotionSync 준비를 취소했습니다.');
  error.name = 'AbortError';
  return error;
}

/** Each analysis processor retains its unconsumed PCM tail using the SDK's actual consumed count. */
export async function createMotionSync(
  model: CubismModel,
  settings: ArrayBuffer,
  isCurrent = () => true,
) {
  if (!isCurrent()) throw cancelled();
  await loadCore();
  // Loading the script is asynchronous; the caller may already have released this model.
  if (!isCurrent()) throw cancelled();
  if (!CubismMotionSync.isStarted()) CubismMotionSync.startUp(new MotionSyncOption());
  if (!CubismMotionSync.isInitialized()) CubismMotionSync.initialize();

  const definition = JSON.parse(new TextDecoder().decode(settings));
  if (
    !Array.isArray(definition.Settings) ||
    !definition.Settings.length ||
    definition.Settings.length > 16 ||
    definition.Settings.some((setting: { AnalysisType?: string }) => setting.AnalysisType !== 'CRI')
  ) {
    throw new Error('지원하는 CRI MotionSync 설정이 없습니다.');
  }
  const actualIds = new Set(
    Array.from({ length: model.getParameterCount() }, (_, index) =>
      model.getParameterId(index).getString(),
    ),
  );
  for (const setting of definition.Settings) {
    if (
      !Array.isArray(setting.CubismParameters) ||
      !setting.CubismParameters.length ||
      setting.CubismParameters.length > 4096 ||
      !Array.isArray(setting.Mappings)
    ) {
      throw new Error('MotionSync의 실제 모델 파라미터/입 모양 연결이 없습니다.');
    }
    const ids = new Set<string>();
    for (const parameter of setting.CubismParameters) {
      if (
        !parameter ||
        !actualIds.has(parameter.Id) ||
        ids.has(parameter.Id) ||
        !Number.isFinite(parameter.Min) ||
        !Number.isFinite(parameter.Max) ||
        parameter.Min >= parameter.Max
      ) {
        throw new Error('MotionSync가 모델에 없거나 잘못된 파라미터를 참조합니다.');
      }
      ids.add(parameter.Id);
    }
    let targetCount = 0;
    for (const mapping of setting.Mappings) {
      if (!mapping || !Array.isArray(mapping.Targets))
        throw new Error('MotionSync Targets가 손상되었습니다.');
      for (const target of mapping.Targets) {
        if (!target || !ids.has(target.Id) || !Number.isFinite(target.Value))
          throw new Error('MotionSync 입 모양 대상이 실제 모델과 맞지 않습니다.');
        targetCount++;
      }
    }
    if (!targetCount) throw new Error('MotionSync의 실제 입 모양 대상이 없습니다.');
  }
  const processorCount: number = definition.Settings.length;
  const processors = () => {
    const list = CubismMotionSyncEngineController.getEngine(
      EngineType.EngineType_Cri,
    )?.getProcessors();
    return list ? Array.from({ length: list.getSize() }, (_, index) => list.at(index)) : [];
  };
  const instantiate = () => {
    if (!isCurrent()) throw cancelled();
    // SDK create can throw after allocating the first of several processors. Its synchronous
    // allocation cannot interleave another load; retain identities to protect existing models.
    const before = new Set(processors());
    let created: CubismMotionSync | null = null;
    try {
      created = CubismMotionSync.create(model, settings, settings.byteLength, SAMPLE_RATE);
      if (
        !created ||
        processors().filter((processor) => !before.has(processor)).length !== processorCount
      )
        throw new Error('MotionSync 설정과 모델의 분석 프로세서를 연결할 수 없습니다.');
      if (!isCurrent()) throw cancelled();
      return created;
    } catch (error) {
      try {
        created?.release();
      } finally {
        // release may already have removed some/all of them; snapshot only the survivors.
        for (const processor of processors()) if (!before.has(processor)) processor.Close();
      }
      throw error;
    }
  };

  let sync: CubismMotionSync | null = instantiate();
  let pending: number[][] = Array.from({ length: processorCount }, () => []);
  let elapsedAudio = 0;
  let disposed = false;
  let dirty = false;
  let receivedSamples = 0;
  let processedSamples = Array(processorCount).fill(0) as number[];
  let resets = 0;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pending = [];
    elapsedAudio = 0;
    const previous = sync;
    sync = null;
    previous?.release();
  };
  const active = () => {
    if (disposed) return false;
    if (!isCurrent()) {
      dispose();
      return false;
    }
    return true;
  };
  const reset = () => {
    if (!active()) return;
    pending = Array.from({ length: processorCount }, () => []);
    elapsedAudio = 0;
    receivedSamples = 0;
    processedSamples = Array(processorCount).fill(0);
    // Repeated cancellation of an already silent player must not recreate native contexts.
    if (!dirty) return;
    dirty = false;
    sync?.release();
    sync = null;
    sync = instantiate();
    resets++;
  };

  return {
    push(chunk: Float32Array, _dt: number) {
      if (!active() || !chunk.length) return;
      if (pending.some((samples) => samples.length + chunk.length > MAX_PENDING_SAMPLES)) {
        // A stalled analyzer must not replay seconds of old speech or grow indefinitely.
        reset();
        chunk = chunk.subarray(Math.max(0, chunk.length - SAMPLE_RATE / 10));
      }
      dirty = true;
      for (const samples of pending) {
        for (const sample of chunk)
          samples.push(Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0);
      }
      receivedSamples += chunk.length;
      // Audio duration is derived from actual PCM, not a render-frame clock supplied by a caller.
      elapsedAudio += chunk.length / SAMPLE_RATE;
    },
    apply() {
      if (!active() || !sync) return;
      for (let index = 0; index < processorCount; index++) {
        const vector = new csmVector<number>();
        for (const sample of pending[index]) vector.pushBack(sample);
        sync.setSoundBuffer(index, vector, 0);
      }
      sync.updateParameters(model, elapsedAudio);
      elapsedAudio = 0;
      for (let index = 0; index < processorCount; index++) {
        const consumed = sync.getLastTotalProcessedCount(index);
        if (!Number.isInteger(consumed) || consumed < 0 || consumed > pending[index].length) {
          dispose();
          throw new Error('MotionSync가 유효하지 않은 오디오 처리 길이를 반환했습니다.');
        }
        processedSamples[index] += consumed;
        // CRI commonly requires 488 samples. Never discard a sub-block tail at a frame boundary.
        pending[index].splice(0, consumed);
      }
    },
    reset,
    dispose,
    getDiagnostics() {
      return {
        sampleRate: SAMPLE_RATE,
        receivedSamples,
        processedSamples: [...processedSamples],
        pendingSamples: pending.map((samples) => samples.length),
        resets,
        disposed,
      };
    },
  };
}
