import { CubismFramework, Option, LogLevel } from '@framework/live2dcubismframework';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import { CubismModel } from '@framework/model/cubismmodel';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismUpdateScheduler } from '@framework/motion/cubismupdatescheduler';
import { ICubismUpdater } from '@framework/motion/icubismupdater';
import { CubismPhysicsUpdater } from '@framework/motion/cubismphysicsupdater';
import { CubismPoseUpdater } from '@framework/motion/cubismposeupdater';
import { CubismShaderManager_WebGL } from '@framework/rendering/cubismshader_webgl';
import { CubismWebGLOffscreenManager } from '@framework/rendering/cubismoffscreenmanager';
import { hitTestModel, type TextureAlpha } from './hit-test';
import { parseExpression, validatePhysics, validatePose, type Expression } from './optional-assets';
type Parameter = {
  id: string;
  minimum: number;
  maximum: number;
  default: number;
};
type Mapping = Record<string, string>;
type Reaction = {
  emotion: string;
  intensity: number;
  gaze?: string;
  gesture?: string;
};
export type ModelSource = {
  url: string;
  name: string;
  mapping?: Mapping;
  motionSyncUrl?: string;
  warnings?: string[];
  fetchAsset?: (relative: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
};
function loadAborted() {
  return new DOMException('모델 준비를 취소했습니다.', 'AbortError');
}
/** Native IPC cannot be aborted, but callers must stop waiting and ignore its late result. */
function waitForAsset<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(loadAborted());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(loadAborted());
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (a: number, b: number, dt: number, speed = 8) =>
  a + (b - a) * (1 - Math.exp(-speed * dt));
class FrameUpdater extends ICubismUpdater {
  constructor(
    order: number,
    private tick: (model: CubismModel, dt: number) => void,
  ) {
    super(order);
  }
  onLateUpdate(model: CubismModel, dt: number) {
    this.tick(model, dt);
  }
}
class CharacterModel extends CubismUserModel {
  scheduler = new CubismUpdateScheduler();
  private released = false;
  get hasPhysics() {
    return !!this._physics;
  }
  get coreModel() {
    return this._model;
  }
  installEffects(
    tick: (model: CubismModel, dt: number) => void,
    mouth: (model: CubismModel, dt: number) => void,
  ) {
    this.scheduler.addUpdatableList(new FrameUpdater(400, tick));
    if (this._physics) this.scheduler.addUpdatableList(new CubismPhysicsUpdater(this._physics));
    this.scheduler.addUpdatableList(new FrameUpdater(700, mouth));
    if (this._pose) this.scheduler.addUpdatableList(new CubismPoseUpdater(this._pose));
  }
  step(dt: number) {
    this._model.loadParameters();
    this.scheduler.onLateUpdate(this._model, dt);
    this._model.update();
  }
  dispose() {
    if (this.released) return;
    this.released = true;
    this.scheduler.release();
    this.release();
  }
}
/** One native Cubism renderer per canvas; no IPC on the animation frame path. */
export class CharacterRenderer {
  canvas: HTMLCanvasElement;
  parameters: Parameter[] = [];
  warnings: string[] = [];
  mapping: Mapping = {};
  capabilities: {
    name: string;
    level: string;
    detail: string;
  }[] = [];
  private model: CharacterModel | null = null;
  private pendingLoad: { controller: AbortController; model: CharacterModel | null } | null = null;
  private gl: WebGL2RenderingContext;
  private textures: WebGLTexture[] = [];
  private hitTextures: TextureAlpha[] = [];
  private generation = 0;
  private raf = 0;
  private ready = false;
  private last = 0;
  private nextDeadline = 0;
  private elapsed = 0;
  private fps = 30;
  private scale = 1;
  private tracking = true;
  private cursor = { x: 0, y: 0 };
  private gaze = { x: 0, y: 0 };
  private head = { x: 0, y: 0 };
  private emotion = 'calm';
  private emotionWeights: Record<string, number> = {};
  private intensity = 0.7;
  private gesture = 'none';
  private gazeTarget = 'user';
  private reactionUntil = 0;
  private blinkAt = 2 + Math.random() * 3;
  private blinkStart = -100;
  private mouthOpen = 0;
  private mouthValue = 0;
  private speaking = false;
  private expressions: Record<string, Expression> = {};
  private indices = new Map<string, number>();
  private observer: ResizeObserver;
  private motionSync: any = null;
  private disposed = false;
  private paused = false;
  private contextLost = false;
  private onPointer = (event: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.setCursor(
      ((event.clientX - r.left) / r.width) * 2 - 1,
      1 - ((event.clientY - r.top) / r.height) * 2,
    );
  };
  private onVisibility = () => {
    this.syncFrameLoop();
  };
  constructor(private container: HTMLElement) {
    if (!globalThis.Live2DCubismCore)
      throw new Error('Cubism Core가 없습니다. npm run assets:setup을 실행해 주세요.');
    if (!CubismFramework.isStarted()) {
      const options = new Option();
      options.loggingLevel = LogLevel.LogLevel_Error;
      CubismFramework.startUp(options);
      CubismFramework.initialize();
    }
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'Live2D 캐릭터');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    this.container.append(this.canvas);
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) throw new Error('이 환경에서 WebGL 2를 사용할 수 없습니다.');
    this.gl = gl;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    window.addEventListener('pointermove', this.onPointer);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      if (this.disposed) return;
      this.contextLost = true;
      this.clearModel();
      CubismShaderManager_WebGL.getInstance().releaseContext(this.gl);
      container.dispatchEvent(
        new CustomEvent('character-error', {
          detail: '그래픽 연결이 중단되었습니다. 복구되면 모델을 다시 불러옵니다.',
          bubbles: true,
          composed: true,
        }),
      );
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      if (this.disposed) return;
      this.contextLost = false;
      this.clearModel();
      CubismShaderManager_WebGL.getInstance().releaseContext(this.gl);
      container.dispatchEvent(
        new CustomEvent('character-reload', { bubbles: true, composed: true }),
      );
    });
    this.resize();
  }
  async load(source: ModelSource) {
    this.clearModel();
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return;
    const generation = this.generation;
    const operation = { controller: new AbortController(), model: null as CharacterModel | null };
    this.pendingLoad = operation;
    const signal = operation.controller.signal;
    // A successful load below performs the pending Core check; do not retain that staging notice.
    const warnings = (source.warnings ?? []).filter(
      (warning) => warning !== 'Core 정합성·버전 검사와 실제 파라미터 미리보기가 아직 필요합니다.',
    );
    const isCurrent = () =>
      generation === this.generation &&
      !this.disposed &&
      !signal.aborted &&
      !this.gl.isContextLost();
    const read = async (path: string) => {
      if (!isCurrent()) throw loadAborted();
      const pending = source.fetchAsset
        ? source.fetchAsset(path, signal)
        : (async () => {
            const response = await fetch(new URL(path, new URL(source.url, location.href)), {
              signal,
            });
            if (!response.ok) throw new Error(`모델 자산 로딩 실패 (${response.status})`);
            return response.arrayBuffer();
          })();
      const result = await waitForAsset(pending, signal);
      if (!isCurrent()) throw loadAborted();
      return result;
    };
    const rootFile = source.fetchAsset ? source.url : source.url.split('/').pop()!;
    let model: CharacterModel | null = null;
    try {
      const definition = JSON.parse(new TextDecoder().decode(await read(rootFile)));
      if (!isCurrent()) return;
      const refs = definition.FileReferences;
      if (!refs?.Moc || !Array.isArray(refs.Textures) || !refs.Textures.length)
        throw new Error('모델 진입점에 Moc와 Textures가 필요합니다.');
      model = new CharacterModel();
      operation.model = model;
      const moc = await read(refs.Moc);
      if (!isCurrent()) return;
      model.loadModel(moc, true);
      if (!model.coreModel) throw new Error('지원하지 않거나 손상된 MOC3입니다.');
      if (!isCurrent()) {
        model.dispose();
        return;
      }
      const parameters = Array.from({ length: model.coreModel.getParameterCount() }, (_, i) => ({
        id: model.coreModel.getParameterId(i).getString(),
        minimum: model.coreModel.getParameterMinimumValue(i),
        maximum: model.coreModel.getParameterMaximumValue(i),
        default: model.coreModel.getParameterDefaultValue(i),
      }));
      const parameterIds = new Set(parameters.map((p) => p.id));
      const partIds = new Set(
        Array.from({ length: model.coreModel.getPartCount() }, (_, i) =>
          model.coreModel.getPartId(i).getString(),
        ),
      );
      for (const kind of ['Physics', 'Pose']) {
        if (!refs[kind]) continue;
        try {
          const data = await read(refs[kind]);
          if (!isCurrent()) {
            model.dispose();
            return;
          }
          const value = JSON.parse(new TextDecoder().decode(data));
          if (kind === 'Physics') {
            validatePhysics(value, parameterIds);
            model.loadPhysics(data, data.byteLength);
          } else {
            validatePose(value, partIds);
            model.loadPose(data, data.byteLength);
          }
        } catch (error) {
          if (!isCurrent()) return;
          warnings.push(`${kind} 기능 제외: ${String(error)}`);
        }
      }
      const expressions: Record<string, Expression> = Object.create(null);
      if (refs.Expressions !== undefined && !Array.isArray(refs.Expressions))
        warnings.push('손상된 표정 목록을 제외했습니다.');
      for (const exp of Array.isArray(refs.Expressions) ? refs.Expressions : []) {
        try {
          if (typeof exp?.Name !== 'string' || !exp.Name || typeof exp?.File !== 'string')
            throw new Error('표정 이름/경로가 없습니다.');
          const data = await read(exp.File);
          if (!isCurrent()) {
            model.dispose();
            return;
          }
          const parsed = parseExpression(JSON.parse(new TextDecoder().decode(data)), parameterIds);
          if (!parsed.length) throw new Error('연결된 표정 파라미터가 없습니다.');
          expressions[exp.Name] = parsed;
        } catch (error) {
          if (!isCurrent()) return;
          warnings.push(`표정 ${exp?.Name ?? ''} 제외: ${String(error)}`);
        }
      }
      if (!isCurrent()) {
        model.dispose();
        return;
      }
      this.model = model;
      this.expressions = expressions;
      this.parameters = parameters;
      this.warnings = warnings;
      this.indices = new Map(this.parameters.map((p, i) => [p.id, i]));
      const find = (...ids: string[]) => ids.find((id) => this.indices.has(id)) ?? '';
      const groups = Array.isArray(definition.Groups) ? definition.Groups : [];
      const idsFor = (name: string) => {
        const ids = groups.find((g: any) => g?.Name === name)?.Ids;
        return Array.isArray(ids) ? ids.filter((id: unknown) => typeof id === 'string') : [];
      };
      const lips = idsFor('LipSync');
      const eyes = idsFor('EyeBlink');
      this.mapping = {
        mouthOpen: find('ParamMouthOpenY', ...lips, 'ParamA'),
        mouthForm: find('ParamMouthForm', 'ParamMouthUp'),
        eyeLeft: find(eyes[0], 'ParamEyeLOpen'),
        eyeRight: find(eyes[1], 'ParamEyeROpen'),
        gazeX: find('ParamEyeBallX'),
        gazeY: find('ParamEyeBallY'),
        angleX: find('ParamAngleX'),
        angleY: find('ParamAngleY'),
        bodyAngle: find('ParamBodyAngleX'),
        breath: find('ParamBreath'),
        ...source.mapping,
      };
      model.installEffects(
        (_m, dt) => this.updateFace(dt),
        (_m, dt) => this.updateMouth(dt),
      );
      model.createRenderer(this.canvas.width, this.canvas.height);
      model.getRenderer().startUp(this.gl);
      model.getRenderer().setIsPremultipliedAlpha(true);
      for (let i = 0; i < refs.Textures.length; i++) {
        const blob = new Blob([await read(refs.Textures[i])]);
        if (!isCurrent()) return;
        // WebGL pixelStore does not premultiply ImageBitmap inputs.
        const image = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
        try {
          if (!isCurrent()) return;
          const texture = this.gl.createTexture()!;
          this.textures.push(texture);
          this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
          this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
          this.gl.texImage2D(
            this.gl.TEXTURE_2D,
            0,
            this.gl.RGBA,
            this.gl.RGBA,
            this.gl.UNSIGNED_BYTE,
            image,
          );
          this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
          this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
          this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
          this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
          model.getRenderer().bindTexture(i, texture);
          // Cache a small CPU alpha plane once. Cursor hit tests never read back the GPU.
          const alphaCanvas = document.createElement('canvas');
          const alphaScale = Math.min(1, 1024 / Math.max(image.width, image.height));
          alphaCanvas.width = Math.max(1, Math.round(image.width * alphaScale));
          alphaCanvas.height = Math.max(1, Math.round(image.height * alphaScale));
          const context = alphaCanvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(image, 0, 0, alphaCanvas.width, alphaCanvas.height);
            const pixels = context.getImageData(0, 0, alphaCanvas.width, alphaCanvas.height).data;
            const alpha = new Uint8Array(alphaCanvas.width * alphaCanvas.height);
            for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = pixels[pixel * 4 + 3];
            this.hitTextures[i] = { width: alphaCanvas.width, height: alphaCanvas.height, alpha };
          }
        } finally {
          image.close();
        }
      }
      const isMao = this.indices.has('ParamMouthAngryLine') && !!expressions.exp_08;
      const defaults = isMao
        ? {
            emotion_happy: 'exp_02',
            emotion_sad: 'exp_05',
            emotion_surprised: 'exp_07',
            emotion_annoyed: 'exp_08',
            emotion_calm: 'exp_01',
          }
        : {};
      this.mapping = { ...this.mapping, ...defaults, ...source.mapping };
      // Saved bindings to a now-missing optional expression cannot prevent the model loading.
      for (const [key, value] of Object.entries(this.mapping)) {
        if (key.startsWith('emotion_') && value && !this.expressions[value]) {
          warnings.push(`사용할 수 없는 표정 연결을 제외했습니다: ${value}`);
          this.mapping[key] = '';
        }
      }
      this.validateMapping(this.mapping);
      this.refreshCapabilities();
      // MotionSync is installed separately after the genuine model parameters are known.
      const motionFile = refs.MotionSync ?? source.motionSyncUrl;
      if (motionFile) {
        try {
          const { createMotionSync } = await import('./motion-sync');
          if (!isCurrent()) return;
          const data =
            source.motionSyncUrl && !refs.MotionSync
              ? await waitForAsset(
                  (async () => {
                    const response = await fetch(source.motionSyncUrl!, { signal });
                    if (!response.ok) throw new Error(`MotionSync 로딩 실패 (${response.status})`);
                    return response.arrayBuffer();
                  })(),
                  signal,
                )
              : await read(motionFile);
          if (!isCurrent()) return;
          const sync = await createMotionSync(model.coreModel, data, isCurrent);
          if (!isCurrent()) {
            sync.dispose();
            return;
          }
          this.motionSync = sync;
          this.refreshCapabilities();
        } catch (error) {
          if (!isCurrent()) return;
          this.warnings.push(`MotionSync 기능 제외: ${String(error)}`);
          this.refreshCapabilities();
        }
      }
      if (!isCurrent()) return;
      this.ready = true;
      this.resize();
      this.syncFrameLoop();
      return {
        parameters: this.parameters,
        expressions: Object.keys(this.expressions),
        mapping: this.mapping,
        capabilities: this.capabilities,
        warnings: this.warnings,
      };
    } catch (error) {
      if (!isCurrent()) return;
      this.clearModel();
      throw error;
    } finally {
      if (this.pendingLoad === operation) this.pendingLoad = null;
      if (this.model !== model) model?.dispose();
    }
  }
  setOptions(options: { fps?: number; scale?: number; cursorTracking?: boolean }) {
    const fps = options.fps === 60 ? 60 : 30;
    if (fps !== this.fps) this.nextDeadline = 0;
    this.fps = fps;
    this.scale = clamp(options.scale ?? this.scale, 0.5, 1.5);
    this.tracking = options.cursorTracking ?? this.tracking;
  }
  setCursor(x: number, y: number) {
    this.cursor = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  }
  hitTest(x: number, y: number) {
    if (
      !this.model ||
      this.paused ||
      this.contextLost ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return false;
    const matrix = this.model.getModelMatrix();
    return hitTestModel(
      this.model.coreModel,
      matrix.invertTransformX((x * this.canvas.width) / this.canvas.height),
      matrix.invertTransformY(y),
      this.hitTextures,
    );
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    this.syncFrameLoop();
  }
  validateMapping(mapping: Mapping) {
    for (const [key, id] of Object.entries(mapping)) {
      if (!id) continue;
      if (['layout_scale', 'layout_x', 'layout_y', 'tracking_strength'].includes(key)) {
        const value = Number(id);
        const minimum = key === 'layout_scale' ? 0.5 : key === 'tracking_strength' ? 0 : -1;
        const maximum = key === 'layout_scale' ? 2 : 1;
        if (!Number.isFinite(value) || value < minimum || value > maximum)
          throw new Error(`모델 표시 설정 범위를 확인해 주세요: ${key}`);
      } else if (key.startsWith('emotion_')) {
        if (!this.expressions[id]) throw new Error(`모델에 없는 표정: ${id}`);
      } else if (!this.indices.has(id)) throw new Error(`모델에 없는 파라미터: ${id}`);
    }
  }
  setMapping(mapping: Mapping) {
    this.validateMapping(mapping);
    this.mapping = { ...this.mapping, ...mapping };
    this.refreshCapabilities(true);
    return { mapping: this.mapping, capabilities: this.capabilities, warnings: this.warnings };
  }
  private refreshCapabilities(emit = false) {
    const eyes = !!(this.mapping.gazeX || this.mapping.gazeY);
    const head = !!(this.mapping.angleX || this.mapping.angleY);
    const count = ['happy', 'sad', 'surprised', 'annoyed', 'calm'].filter(
      (emotion) => !!this.expressions[this.mapping[`emotion_${emotion}`]]?.length,
    ).length;
    const emotionFallback =
      !!this.mapping.mouthForm ||
      this.indices.has('ParamBrowLY') ||
      this.indices.has('ParamBrowRY');
    const mouth = !!this.mapping.mouthOpen;
    this.capabilities = [
      {
        name: '커서 추적',
        level: eyes && head ? 'supported' : eyes || head ? 'fallback' : 'unsupported',
        detail:
          eyes || head
            ? `눈 ${eyes ? '연결' : '없음'} · 고개 ${head ? '연결' : '없음'}`
            : '추적 파라미터 연결 없음',
      },
      {
        name: '표정',
        level: count === 5 ? 'supported' : count || emotionFallback ? 'fallback' : 'unsupported',
        detail: `표정 ${count}/5개 연결${emotionFallback ? ' · 파라미터 대체 가능' : ' · 추가 대체 파라미터 없음'}`,
      },
      {
        name: '물리 효과',
        level: this.model?.hasPhysics ? 'supported' : 'unsupported',
        detail: this.model?.hasPhysics ? '검증한 모델 physics3 설정' : '사용 가능한 물리 자산 없음',
      },
      {
        name: '립싱크',
        level: this.motionSync ? 'supported' : mouth ? 'fallback' : 'unsupported',
        detail: this.motionSync
          ? 'MotionSync 오디오 분석'
          : mouth
            ? '실제 재생 오디오의 음량 기반 입 개폐'
            : '입 개폐 파라미터 연결 없음',
      },
    ];
    if (emit)
      this.container.dispatchEvent(
        new CustomEvent('character-capabilities', {
          detail: { capabilities: this.capabilities, warnings: this.warnings },
          bubbles: true,
          composed: true,
        }),
      );
  }
  react(reaction: Reaction) {
    this.emotion = reaction.emotion === 'neutral' ? 'calm' : reaction.emotion;
    this.intensity = clamp(reaction.intensity, 0, 1);
    this.gesture = reaction.gesture ?? 'none';
    this.gazeTarget = reaction.gaze ?? 'user';
    this.reactionUntil = this.elapsed + 5;
  }
  setMouth(open: number, speaking = false) {
    this.mouthOpen = clamp(open, 0, 1);
    this.speaking = speaking;
  }
  pushAudio(samples: Float32Array, dt: number) {
    this.motionSync?.push(samples, dt);
  }
  cancelSpeech() {
    this.mouthOpen = 0;
    this.mouthValue = 0;
    this.speaking = false;
    this.motionSync?.reset();
    if (this.model) this.write(this.mapping.mouthOpen, 0);
  }
  private write(id: string, value: number, weight = 1) {
    const index = this.indices.get(id);
    if (index === undefined || !this.model || !Number.isFinite(value) || !Number.isFinite(weight))
      return;
    const p = this.parameters[index];
    this.model.coreModel.setParameterValueByIndex(
      index,
      clamp(value, p.minimum, p.maximum),
      weight,
    );
  }
  private updateFace(dt: number) {
    this.elapsed += dt;
    if (this.elapsed > this.reactionUntil && !this.speaking) {
      this.emotion = 'calm';
      this.gesture = 'none';
      this.gazeTarget = 'user';
    }
    if (this.elapsed > this.blinkAt) {
      this.blinkStart = this.elapsed;
      this.blinkAt = this.elapsed + 2.5 + Math.random() * 4;
    }
    const blinkTime = this.elapsed - this.blinkStart;
    const blink = blinkTime < 0.19 ? 1 - Math.sin((blinkTime / 0.19) * Math.PI) : 1;
    this.write(this.mapping.eyeLeft, blink);
    this.write(this.mapping.eyeRight, blink);
    for (const emotion of ['happy', 'sad', 'surprised', 'annoyed', 'calm']) {
      const weight = (this.emotionWeights[emotion] = smooth(
        this.emotionWeights[emotion] ?? 0,
        this.emotion === emotion ? this.intensity : 0,
        dt,
        6,
      ));
      const exp = this.expressions[this.mapping[`emotion_${emotion}`]];
      if (exp) {
        for (const parameter of exp) {
          const index = this.indices.get(parameter.Id);
          if (index === undefined) continue;
          const current = this.model!.coreModel.getParameterValueByIndex(index);
          const value =
            parameter.Blend === 'Multiply'
              ? current * parameter.Value
              : parameter.Blend === 'Overwrite'
                ? parameter.Value
                : current + parameter.Value;
          this.write(parameter.Id, value, weight);
        }
      } else if (weight > 0.01) {
        const sign = emotion === 'happy' ? 1 : emotion === 'sad' || emotion === 'annoyed' ? -1 : 0;
        this.write(this.mapping.mouthForm, sign, weight);
        this.write(
          'ParamBrowLY',
          emotion === 'sad' ? -0.6 : emotion === 'surprised' ? 0.6 : 0,
          weight,
        );
        this.write(
          'ParamBrowRY',
          emotion === 'sad' ? -0.6 : emotion === 'surprised' ? 0.6 : 0,
          weight,
        );
      }
    }
    const strength = this.tracking
      ? (this.gesture === 'none' ? 1 : 0.35) * Number(this.mapping.tracking_strength || '1')
      : 0;
    const cx = this.gazeTarget === 'away' ? -0.8 : this.cursor.x;
    this.gaze.x = smooth(this.gaze.x, cx * strength, dt, 14);
    this.gaze.y = smooth(this.gaze.y, this.cursor.y * strength, dt, 14);
    this.head.x = smooth(this.head.x, this.gaze.x, dt, 4);
    this.head.y = smooth(this.head.y, this.gaze.y, dt, 4);
    this.write(this.mapping.gazeX, this.gaze.x);
    this.write(this.mapping.gazeY, this.gaze.y);
    this.write(this.mapping.angleX, this.head.x * 20 + Math.sin(this.elapsed * 0.73) * 1.1);
    this.write(
      this.mapping.angleY,
      this.head.y * 13 +
        (this.gesture === 'nod'
          ? Math.sin(this.elapsed * 7) * 4 * this.intensity
          : Math.sin(this.elapsed * 0.91)),
    );
    this.write(
      'ParamAngleZ',
      (this.gesture === 'tilt' ? 8 * this.intensity : 0) + Math.sin(this.elapsed * 0.55) * 1.5,
    );
    this.write(this.mapping.bodyAngle, this.head.x * 3 + Math.sin(this.elapsed * 0.43) * 1.2);
    this.write(this.mapping.breath, (Math.sin(this.elapsed * 1.4) + 1) / 2);
  }
  private updateMouth(dt: number) {
    this.mouthValue = smooth(
      this.mouthValue,
      this.mouthOpen,
      dt,
      this.mouthOpen > this.mouthValue ? 24 : 18,
    );
    if (this.motionSync && this.speaking) {
      try {
        this.motionSync.apply();
      } catch (error) {
        this.motionSync.dispose();
        this.motionSync = null;
        this.warnings.push(`MotionSync 분석 중단: ${String(error)}`);
        this.refreshCapabilities(true);
        this.container.dispatchEvent(
          new CustomEvent('character-error', {
            detail: `${this.mapping.mouthOpen ? '음량 기반 입 움직임으로 전환했습니다' : '립싱크를 중단했습니다'}: ${String(error)}`,
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else this.write(this.mapping.mouthOpen, this.mouthValue);
  }
  private resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.model?.setRenderTargetSize(this.canvas.width, this.canvas.height);
    this.syncFrameLoop();
  }
  private canRender() {
    return (
      !this.disposed &&
      this.ready &&
      !document.hidden &&
      !this.paused &&
      !this.contextLost &&
      // The native lost flag changes before the queued webglcontextlost event arrives.
      !this.gl.isContextLost() &&
      !!this.model &&
      this.canvas.clientWidth > 0 &&
      this.canvas.clientHeight > 0
    );
  }
  private stopFrameLoop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
    this.nextDeadline = 0;
  }
  private syncFrameLoop() {
    if (!this.canRender()) this.stopFrameLoop();
    else if (!this.raf) {
      this.last = 0;
      this.nextDeadline = 0;
      this.start();
    }
  }
  private start() {
    if (this.raf || !this.canRender()) return;
    const frame = (now: number) => {
      this.raf = 0;
      if (!this.canRender() || !this.model) {
        this.last = 0;
        this.nextDeadline = 0;
        return;
      }
      this.raf = requestAnimationFrame(frame);
      const interval = 1000 / this.fps;
      // Keep the reservation phase across rAF jitter; actual elapsed time is a separate clock.
      if (this.nextDeadline && now + 0.5 < this.nextDeadline) return;
      const deadline = this.nextDeadline || now;
      this.nextDeadline =
        deadline + Math.max(1, Math.floor((now - deadline) / interval) + 1) * interval;
      const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / this.fps;
      this.last = now;
      this.model.step(dt);
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const matrix = new CubismMatrix44();
      const aspect = this.canvas.width / this.canvas.height;
      matrix.scale(1 / aspect, 1);
      this.model
        .getModelMatrix()
        .setHeight(
          Math.min(
            1.9,
            (1.9 * aspect * this.model.coreModel.getCanvasHeight()) /
              this.model.coreModel.getCanvasWidth(),
          ) *
            this.scale *
            Number(this.mapping.layout_scale || '1'),
        );
      this.model
        .getModelMatrix()
        .setPosition(
          Number(this.mapping.layout_x || '0') * aspect,
          Number(this.mapping.layout_y || '0'),
        );
      matrix.multiplyByMatrix(this.model.getModelMatrix());
      this.model.getRenderer().setMvpMatrix(matrix);
      this.model.getRenderer().setRenderState(null, [0, 0, this.canvas.width, this.canvas.height]);
      try {
        this.model.getRenderer().drawModel('/vendor/shaders/WebGL/');
      } catch (error) {
        // Loss may happen during SDK draw: getParameter(VIEWPORT) then returns null.
        // Only that native state justifies waiting for the loss/restore event handlers.
        if (!gl.isContextLost()) throw error;
        this.stopFrameLoop();
        return;
      }
      if (gl.isContextLost()) this.stopFrameLoop();
    };
    this.raf = requestAnimationFrame(frame);
  }
  private clearModel() {
    this.generation++;
    const pending = this.pendingLoad;
    this.pendingLoad = null;
    pending?.controller.abort();
    pending?.model?.dispose();
    this.ready = false;
    this.stopFrameLoop();
    this.motionSync?.dispose();
    this.motionSync = null;
    this.model?.dispose();
    this.model = null;
    // SDK model release deletes borrowed offscreen handles, but its per-GL pool
    // retains them. This canvas owns one model, so drop that pool before a reload.
    CubismWebGLOffscreenManager.getInstance().removeContext(this.gl);
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.textures = [];
    this.hitTextures = [];
    this.parameters = [];
    this.indices.clear();
    this.emotion = 'calm';
    this.emotionWeights = {};
    this.gesture = 'none';
    this.reactionUntil = 0;
    this.cancelSpeech();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearModel();
    CubismShaderManager_WebGL.getInstance().releaseContext(this.gl);
    this.observer.disconnect();
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.remove();
  }
}
