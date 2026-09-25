import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, emitTo } from '@tauri-apps/api/event';
export const native = isTauri();
export async function call(command, args = {}) {
  if (!native)
    throw new Error('데스크톱 앱에서 사용할 수 있어요. npm run desktop으로 실행해 주세요.');
  return invoke(command, args);
}
export const on = (event, callback) =>
  native ? listen(event, ({ payload }) => callback(payload)) : Promise.resolve(() => {});
export const toCompanion = (event, payload) =>
  native ? emitTo('companion', event, payload) : Promise.resolve();

export const toMain = (event, payload) =>
  native ? emitTo('main', event, payload) : Promise.resolve();

export const builtinModels = [
  { id: 'builtin:mao', name: 'Niziiro Mao', entrypoint: '/models/Mao/Mao.model3.json' },
  { id: 'builtin:haru', name: 'Haru', entrypoint: '/models/Haru/Haru.model3.json' },
  {
    id: 'builtin:kei',
    name: 'Kei · MotionSync',
    entrypoint: '/models/Kei_vowels/Kei_vowels.model3.json',
  },
];

export async function modelSource(id, models) {
  const builtin = builtinModels.find((model) => model.id === id);
  if (builtin)
    return {
      url: builtin.entrypoint,
      name: builtin.name,
      motionSyncUrl: id === 'builtin:mao' ? '/config/mao.motionsync3.json' : undefined,
      mapping: native ? await call('get_model_mapping', { id }) : undefined,
    };
  const model = models.find((model) => model.id === id);
  if (!model) throw new Error('선택한 모델을 찾을 수 없습니다.');
  const mapping = await call('get_model_mapping', { id });
  const folder = model.entrypoint.includes('/')
    ? model.entrypoint.slice(0, model.entrypoint.lastIndexOf('/') + 1)
    : '';
  return {
    url: model.entrypoint,
    name: model.name,
    mapping,
    warnings: model.capabilities?.warnings ?? [],
    fetchAsset: async (path) => {
      const resolved = path === model.entrypoint ? path : folder + path;
      const bytes = await call('read_model_asset', { id, path: resolved });
      return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
    },
  };
}

export function inspectedModelSource(inspection, entrypoint) {
  const candidate = inspection.candidates.find(
    (item) => item.entrypoint === entrypoint && item.valid,
  );
  if (!candidate) throw new Error('검사를 통과한 모델을 선택해 주세요.');
  const folder = entrypoint.includes('/')
    ? entrypoint.slice(0, entrypoint.lastIndexOf('/') + 1)
    : '';
  return {
    url: entrypoint,
    name: candidate.name,
    mapping: {},
    warnings: candidate.capabilities?.warnings ?? [],
    fetchAsset: async (path) => {
      const resolved = path === entrypoint ? path : folder + path;
      const bytes = await call('read_import_asset', {
        token: inspection.token,
        entrypoint,
        path: resolved,
      });
      return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
    },
  };
}

export function uiSnapshot(snapshot) {
  const s = snapshot.settings;
  return {
    ready: true,
    error: snapshot.credentialError ? `API 키 저장소: ${snapshot.credentialError}` : '',
    version: snapshot.version,
    platform:
      snapshot.platform.platform === 'macos'
        ? 'macOS'
        : snapshot.platform.platform === 'windows'
          ? 'Windows'
          : snapshot.platform.platform,
    character: {
      id: s.activeModelId ?? 'builtin:mao',
      models: [...builtinModels, ...snapshot.models].map((m) => ({ id: m.id, name: m.name })),
    },
    personality: {
      preset: s.personality,
      characterName: s.characterName,
      ...(s.characterProfile ? { profile: s.characterProfile } : {}),
      intensity: s.personalityIntensity,
      frequency: s.personalityFrequency,
      jealousy: s.jealousy.enabled,
      jealousyIntensity: s.jealousy.intensity,
      jealousyFrequency: s.jealousy.frequency,
    },
    observation: {
      mode: {
        off: 'off',
        selectedWindow: 'selected',
        allowedApps: 'allowed',
        currentScreen: 'screen',
      }[s.observation.mode],
      quiet: s.quiet,
      focus: s.focusMode,
      meeting: s.meetingMode,
      windowId: s.observation.selectedWindowId ?? '',
      cloudConsent: s.observation.cloudConsent,
      screenConsent: s.observation.screenConsent ?? false,
      allowedApps: s.observation.allowedApps,
      sensitiveApps: s.observation.blockedApps,
      status: s.observation.mode === 'off' ? '관찰하지 않음' : '허용한 화면만 함께 보는 중',
      permission: snapshot.platform.screenPermission,
      capabilities: snapshot.platform.capabilities,
    },
    memories: snapshot.memories.map((m) => ({
      id: m.id,
      content: m.text,
      createdAt: new Date(m.createdAt).toISOString(),
      expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
    })),
    memoryEnabled: s.memoryEnabled,
    providers: Object.fromEntries(
      ['chat', 'stt', 'tts'].map((kind) => [
        kind,
        {
          endpoint: s.providers[kind].baseUrl,
          model: s.providers[kind].model,
          requiresKey: s.providers[kind].requiresKey,
          configured:
            !!s.providers[kind].model &&
            (!s.providers[kind].requiresKey || snapshot.credentials[kind]),
          ...(kind === 'tts' ? { voice: s.providers.voice } : {}),
        },
      ]),
    ),
    settings: {
      fps: s.fps,
      scale: s.scale,
      muted: s.muted,
      alwaysOnTop: s.alwaysOnTop,
      cursorTracking: s.cursorTracking,
    },
  };
}
