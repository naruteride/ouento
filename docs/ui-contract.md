# 설정 UI 계약

`src/ui/app.js`를 불러오면 `<ouento-app>`이 등록된다. UI는 Web Components / Shadow DOM이며 네트워크·저장·Tauri 호출을 하지 않는다. `app.data = state` 또는 `app.update(partialState)`로 화면을 갱신한다. `app.navigate('chat'|'character'|'personality'|'observe'|'memory'|'settings')`로 이동한다. `app.previewElement`는 실제 Cubism 렌더러를 부착할 **항상 유지되는** DOM 요소이며, 화면 전환이나 데이터 갱신으로 제거되지 않는다. `app.notify(message, kind='success')`로 작업 결과를 알린다. `kind`는 `success`, `error`, `info` 중 하나다.

## 데이터

모든 키는 선택적이며 미제공 상태는 미연결·미설정으로 표시한다. 데이터는 표시할 때 HTML 이스케이프한다.

```js
{
  ready: true,
  platform: 'macOS',
  version: '0.1.0',
  character: {
    id: 'mao', name: 'Mao', loaded: false, status: '모델을 불러와 주세요',
    source: 'Live2D 공식 샘플',
    capabilities: [{ name: '물리 효과', level: 'supported'|'fallback'|'unsupported', detail: '...' }],
    parameters: [{ id: 'ParamMouthOpenY', minimum: 0, maximum: 1, default: 0 }],
    expressions: ['exp_01', 'exp_02'], warnings: ['선택 기능 제한 안내'],
    mapping: { mouthOpen: '...', mouthForm: '...', eyeLeft: '...', eyeRight: '...', gazeX: '...', gazeY: '...', angleX: '...', angleY: '...', bodyAngle: '...', breath: '...', emotion_calm: '', emotion_happy: '', emotion_sad: '', emotion_surprised: '', emotion_annoyed: '', layout_scale: '1', layout_x: '0', layout_y: '0', tracking_strength: '1' },
    models: [{ id: '...', name: '...' }]
  },
  messages: [{ id: '...', role: 'user'|'assistant'|'system', content: '...', time: '14:32' }],
  busy: false, recording: false, speaking: false,
  personality: { preset: 'tsundere'|'cat'|'cheerleader', intensity: 0.65, frequency: 0.4, jealousy: false, jealousyIntensity: 0.3, jealousyFrequency: 0.2 },
  observation: {
    mode: 'off'|'selected'|'allowed'|'screen', quiet: false, focus: false, meeting: false,
    windowId: '', cloudConsent: false, screenConsent: false,
    allowedApps: ['com.example.app'], sensitiveApps: ['com.example.passwordmanager'],
    status: '관찰하지 않음', permission: 'unknown'|'granted'|'denied',
    typingState: false|true|null, error: '', manualAvailable: false, manualAnalyzing: false,
    windows: [{ id: '...', appId: '...', appName: '...', title: '...' }],
    capabilities: [{ name: '화면 캡처', supported: true, detail: '...' }]
  },
  memories: [{ id: '...', content: '...', expiresAt: '2026-12-31T00:00:00Z'|null, createdAt: '...' }],
  memoryEnabled: false,
  providers: {
    chat: { endpoint: '', model: '', requiresKey: true, configured: false },
    stt: { endpoint: '', model: '', requiresKey: true, configured: false },
    tts: { endpoint: '', model: '', voice: '', requiresKey: true, configured: false }
  },
  settings: { fps: 30, scale: 1, muted: false, alwaysOnTop: true, cursorTracking: true },
  importState: { busy: false, error: '', entries: [{ path: '...', name: '...', valid: true }], sourcePath: '' },
  modelPreview: { active: false, busy: false, name: '', preserveIdentity: true },
  error: ''
}
```

`ready`는 초기 설정 읽기 완료를 뜻하며 모델/AI 연결 완료를 뜻하지 않는다. 데이터 갱신은 입력값·선택·스크롤과 실제 캐릭터 마운트를 보존한다. 입력 중인 필드를 원격 상태 갱신으로 덮어쓰지 않는다. `app.openImport()`와 `app.closeImport()`로 가져오기 다이얼로그를 열고 닫을 수 있다.

주기적인 상태 갱신은 `src/ui/dom.js`로 기존 노드를 유지하며 달라진 내용만 반영한다. 동일 텍스트를 다시 쓰거나 페이지 전체를 교체하지 않는다. 따라서 열린 네이티브 select, 드래그한 텍스트 선택, 폼 초안을 유지한다. 상태 갱신에서 메인 스크롤 위치를 다시 지정하지 않으며, 채팅은 사용자가 하단에 있을 때 새 메시지만 따라간다. 명시적 페이지 전환과 모델 교체는 별도 초기화 경계다.

`screen`은 마우스가 있는 모니터 전체를 따라가는 범위다. UI는 다른 창·알림·바탕화면 포함을 설명하고, 공통 `cloudConsent` 외에 `screenConsent`를 별도로 요구한다. 창 선택/앱 허용 목록은 요구하지 않으며 민감 앱 제외는 계속 적용한다. 모드 선택 중에도 상태 갱신이 초안을 덮어쓰지 않는다. Rust에는 `currentScreen`으로 전달하며, 이 기능을 추가했다고 사용자의 기존 설정을 자동으로 활성화하지 않는다.

## action 이벤트

모든 이벤트는 `detail.type`과 아래 payload를 가진다. 루트 컨트롤러가 검증·저장·부수효과를 실행한 뒤 최신 state로 UI를 갱신한다. 이벤트 자체는 성공을 뜻하지 않는다.

| type                     | payload                                              | 의미                                                                                         |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `chat-send`              | `text`                                               | 직접 대화 전송                                                                               |
| `speech-cancel`          | 없음                                                 | AI 요청·음성·입 모양 취소                                                                    |
| `voice-toggle`           | 없음                                                 | 음성 입력 시작/종료                                                                          |
| `quiet-toggle`           | `value`                                              | 선제 발화 억제                                                                               |
| `observation-stop`       | 없음                                                 | 수집·전송·대기 반응 중단                                                                     |
| `desktop-show`           | 없음                                                 | 상주 캐릭터 표시                                                                             |
| `model-import`           | `kind`(folder 또는 zip), `preserveIdentity`          | 네이티브 파일 선택·검사 후 임시 모델 미리보기                                                |
| `model-import-entry`     | `path, sourcePath, preserveIdentity`                 | 검사한 복수 진입점에서 미리볼 모델 선택                                                      |
| `model-switch`           | `id, preserveIdentity`                               | 저장된 모델 미리보기 시작. 아직 활성 모델을 저장하지 않음                                    |
| `model-preview-accept`   | 없음                                                 | 미리본 모델의 자산·메타데이터·매핑 저장 후 활성 모델·인격 선택 확정                          |
| `model-preview-cancel`   | 없음                                                 | 임시 자산 폐기, 기존 캐릭터 복구                                                             |
| `model-preview-identity` | `value`                                              | 미리보기의 인격 유지 선택만 변경                                                             |
| `model-mapping-preview`  | `mapping`                                            | 실제 ID/범위를 검사하고 설정창 렌더러에 임시 적용. 영속 저장 없음                            |
| `model-mapping-reset`    | 없음                                                 | 저장된 매핑 또는 새 모델의 초기 매핑으로 복구                                                |
| `model-mapping-save`     | `mapping`                                            | 일반 상태는 저장. 모델 미리보기 중에는 임시 적용하고 사용 확정 때 함께 저장                  |
| `expression-preview`     | `emotion, intensity`                                 | happy, sad, surprised, annoyed, neutral 표정                                                 |
| `mouth-preview`          | `openness`                                           | 입 개방 정지 미리보기                                                                        |
| `audio-preview`          | 없음                                                 | 공식 Kei 한국어 WAV 재생·립싱크. AI·마이크 사용 없음                                         |
| `personality-save`       | `personality`                                        | 프리셋·표정 강도·빈도·질투 설정 저장                                                         |
| `personality-preview`    | `preset, scene: exam-pass`                           | 동일 합격 장면 미리보기                                                                      |
| `observation-refresh`    | 없음                                                 | 선택 가능한 창 목록                                                                          |
| `observation-save`       | `observation`                                        | 범위·클라우드 동의 적용                                                                      |
| `observation-analyze`    | 없음                                                 | 현재 허용 범위의 화면을 명시적으로 한 번 분석. 자동 반응의 입력·조용히·집중·회의 억제는 제외 |
| `permission-request`     | `permission: screen`                                 | 화면 캡처 권한 요청                                                                          |
| `memory-enable`          | `value`                                              | 허용한 요약 기억 사용                                                                        |
| `memory-save`            | `id`(문자열 또는 null), `content, expiresAt, requestId` | 기억 생성/수정. 실제 저장 결과를 같은 requestId로 확인                                      |
| `memory-delete`          | `id`                                                 | 기억 삭제                                                                                    |
| `provider-save`          | `kind, endpoint, model, voice?, apiKey, requiresKey` | 제공자 설정·키 저장. 빈 키는 기존 키 유지                                                    |
| `provider-remove-key`    | `kind`                                               | 저장된 키 제거                                                                               |
| `settings-save`          | `settings`                                           | FPS·크기·음소거·항상 위·추적 설정                                                            |

모델별 매핑 값은 모두 문자열이다. `emotion_calm/happy/sad/surprised/annoyed`는 실제 표정 이름 또는 빈 값(파라미터 대체), `layout_scale`은 .5~2, `layout_x/y`는 -1~1, `tracking_strength`는 0~1이다. `app.clearMappingDraft()`는 취소·저장 실패 복구 시 입력 초안을 비운다.

기억은 앞뒤 공백 제거 후 Unicode 코드포인트 1~1,000자, 채팅은 1~4,000자로 Rust와 같은 한도를 제출 전에 검사한다. HTML `maxlength`는 UTF-16 단위이므로 각각 2,000/8,000으로 두고 코드포인트 검사를 별도로 수행한다. 한도 초과·잘못된 만료일은 입력을 지우지 않는다.

기억 저장 중에는 필드·저장·닫기·Escape를 잠그고 중복 요청을 막는다. 컨트롤러는 실제 `save_memory` 성공 직후 `app.completeMemorySave(requestId)`를 호출한다. 실패에는 두 번째 인자로 오류 문자열을 전달하며 모달과 모든 입력을 유지하고 재시도를 허용한다. 이전 요청의 결과는 무시한다. 저장 성공 뒤 snapshot 조회만 실패하면 저장을 재시도하게 만들지 않고 별도 안내한다.

`read_import_asset({token,entrypoint,path})`는 검사한 임시 모델 자산을 읽는다. `import_model`과 `switch_model`은 ‘이 캐릭터 사용’을 누르기 전에는 호출하지 않는다. Core가 거부한 후보는 선택 창에서 오류와 함께 다른 후보/파일로 재시도할 수 있다. 메타데이터는 실제 로딩에 성공한 뒤 `save_model_metadata({id,metadata:{parameters:[{id,minimum,maximum,default}],expressions}})`로 저장하며 검사를 생략하는 캐시로 사용하지 않는다.

컨트롤러 재현 검사: `node scripts/check-model-preview.mjs`(미리보기·확정·취소·Core 실패·저장 실패·늦은 메타데이터 응답). 실제 OS 파일 선택과 렌더링 검사는 별도다.

`observation-analyze` 버튼만 `analyze_window({manual:true})`를 호출하며, 자동 주기는 `manual:false`를 보낸다. 직접 요청은 기존 요청을 취소하고 우선 처리한다. 수동 요청 응답의 UI origin은 `manualObservation`, 자동 화면·OS 반응은 `observation`이다. origin은 프런트엔드의 표시·취소 구분이며 권한 근거가 아니다. Rust는 실제 발급한 관찰 ticket의 `onDemand`/`proactive` purpose를 검증한다. 실제 입력·조용히·집중·회의 상태는 자동 반응만 쉬게 하며, 수동 분석은 관찰 중지·잠금·전체 창 숨김·권한·동의·대상 범위 변경 경계를 그대로 적용한다. 입력 감지 불가(null)는 감지 미지원 안내만 표시하며 자동 요청·캐릭터 재생을 취소하지 않는다. `manualAvailable`은 현재 로컬 상태에서 요청 버튼을 누를 수 있다는 뜻이며 캡처 권한·대상 유효성을 보증하지 않는다. IPC는 이를 다시 검사한다.

## 동작 경계

- 브라우저 드래그로 얻은 `File`을 임의 경로로 취급하지 않는다. 네이티브 폴더/ZIP 드롭은 Tauri 루트가 검증된 경로로 가져오기한다. 가져오기 화면에는 폴더/ZIP 선택 버튼과 네이티브 드롭 안내가 있다.
- 관찰은 폼을 수정하는 것으로 시작하지 않으며 **선택한 범위 적용** 버튼으로만 시작한다. 클라우드 동의 없는 활성 모드 제출은 UI에서 차단하며, 백엔드도 독립 검증해야 한다.
- 기억 삭제는 항목 단위다. 새 인격으로 교체하려면 가져오기 창의 명시적 선택을 사용한다.
- API 키는 HTML·문서·로그·일반 상태에 삽입하지 않는다. 저장 후 입력을 지운다. 백엔드가 OS 보안 저장소에 보관해야 한다.
- 표정/입 미리보기는 실제 렌더러 연결이 없을 때 성공으로 표시하지 않는다. `character.loaded`가 false면 관련 조작을 비활성화한다.
