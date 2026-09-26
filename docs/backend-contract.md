# Rust 백엔드 계약

`domain::Backend`는 `Backend::open(&Path)`로 생성한다. SQLite 연결은 내부 Mutex로 보호하고 async 함수는 잠금을 잡은 채 네트워크를 기다리지 않는다. 직렬화는 모두 camelCase이며 오류는 사용자에게 표시할 한국어 `String`이다. 원본 대화·화면·음성은 DB에 저장하지 않는다.

## 설정

```json
{
  "schemaVersion": 1,
  "personality": "tsundere",
  "personalityIntensity": 0.7,
  "personalityFrequency": 0.5,
  "characterName": "마오",
  "characterProfile": {
    "userAddress": "오빠", "relationship": "여동생 같은 동반자",
    "appearance": "", "personalityPrompt": "장난스럽고 다정한 츤데레 여동생",
    "speechStyle": "자연스러운 한국어 반말", "dialogueExamples": ""
  },
  "fps": 30,
  "muted": false,
  "quiet": false,
  "focusMode": false,
  "meetingMode": false,
  "scale": 1,
  "alwaysOnTop": true,
  "cursorTracking": true,
  "voiceEnabled": true,
  "memoryEnabled": false,
  "activeModelId": null,
  "jealousy": {"enabled": false, "frequency": 0.25, "intensity": 0.35},
  "observation": {
    "mode": "off", "selectedWindowId": null, "allowedApps": [],
    "blockedApps": ["com.1password.1password", "com.apple.keychainaccess", "1password.exe", "keepass.exe", "keepassxc.exe"],
    "cloudConsent": false, "screenConsent": false, "intervalSeconds": 15
  },
  "providers": {
    "chat": {"baseUrl": "https://api.openai.com/v1", "model": "", "requiresKey": true},
    "stt": {"baseUrl": "https://api.openai.com/v1", "model": "", "requiresKey": true},
    "tts": {"baseUrl": "https://api.openai.com/v1", "model": "", "requiresKey": true},
    "voice": "alloy"
  }
}
```

위 `characterProfile`은 구조를 설명하는 짧은 예시다. 실제 기본 지침·대사 예시는 `src/personality-presets.json`을 UI와 Rust가 공유하며, 필드 한도와 이전 저장소 마이그레이션은 [성격 설정 안내](personality.md)를 따른다.

성격 ID는 `tsundere`, `cat`, `cheerleader`. 관찰 모드는 `off`, `selectedWindow`, `allowedApps`, `currentScreen`. `currentScreen`은 마우스가 있는 모니터 전체이며 `cloudConsent`와 `screenConsent`가 모두 필요하다. 모델 이름은 제공자의 실제 사용 가능한 모델을 사용자가 지정한다. 기본값이 비어 있으면 네트워크 호출 대신 설정 안내를 반환한다. HTTP는 localhost 루프백 제공자만 허용한다. 재시작 시 유효한 `currentScreen`·`allowedApps` 설정과 동의를 보존하고 OS 권한은 별도로 다시 확인한다. `selectedWindow`만 창 ID 재사용을 막기 위해 off로 돌리고 다시 선택하도록 한다. 명시적 관찰 중지는 off와 두 동의 해제를 저장한다.

## 함수

- `settings() -> Result<Settings, String>`, `save_settings(Settings) -> Result<Settings, String>`
- `patch_settings(Value) -> Result<Settings, String>`: 최신 설정에 변경 항목만 재귀 병합·검증·저장한다. 동일 Mutex 안에서 수행하여 다른 창의 설정을 과거 값으로 되돌리지 않는다. 미지의 필드·형식 오류는 저장하지 않는다.
- `personalities() -> Vec<Personality>` / `preview_personality(&str) -> Result<Reaction, String>` (모듈 함수)
- `chat(ChatRequest { text }) -> ConversationReply` (async)
- `speech(&str /* utteranceId */, &str /* text */) -> AudioReply` (async)
- `transcribe(Vec<u8>, &str /* MIME */) -> String` (async, 사용자 발화 시작으로 기존 발화 취소)
- `cancel()`: HTTP future를 취소하고 발화 세대를 교체. 렌더러는 별도로 같은 발화 ID의 오디오·자막을 중지한다.
- `current_utterance(&str) -> bool` / `validate_utterance(&str) -> Result<(), String>`: 도메인의 발화 세대를 검사한다. Tauri `validate_utterance({utteranceId})`는 비동기로 bool을 반환하며, 화면 관찰 발화에는 네이티브 대상·권한 검사를 추가한다. 직접 대화에는 화면 권한을 요구하지 않는다.
- `memories() -> Vec<Memory>`, `save_memory(MemoryInput { id: Option<String>, text, expiresAt: Option<i64>, confirmed: bool }) -> Memory`, `delete_memory(&str)`, `clear_memories()`
- `reset_character(keep_identity: bool)`: 취소 후 `false`면 기억 삭제·성격 초기화. 모델 매핑은 이 모듈과 별개다.
- `set_api_key(ProviderKind, &str)` / `delete_api_key(ProviderKind)` / `credential_status() -> CredentialStatus`: kind는 `chat`, `stt`, `tts`. OS keyring 저장. 상태에는 존재 여부만 노출.
- `set_runtime_context(RuntimeContext { typing: bool|null, meeting, screenLocked, observationVisible })`: 입력 활동을 모르면 `null`을 유지한다. 실제 입력 중 또는 회의에서는 자동 관찰만 무효화한다. null은 입력 감지 미지원이며 자동 관찰을 막거나 진행 중인 반응을 취소하지 않는다. 잠금·전체 창 숨김에서는 수동/자동 관찰 작업과 관찰 발화를 모두 무효화하며 직접 대화는 유지한다.
- `set_observation_visible(bool)`: 네이티브 창 표시 상태가 바뀔 때 관찰만 즉시 취소한다. 다시 보일 때 과거 티켓이 되살아나지 않는다.
- `begin_observation(ObservationTarget { appId, windowId }, fingerprint: &str) -> ObservationTicket`: **캡처 전에** 호출한다. 불허·중복·집중·빈도 제한이면 오류.
- `begin_observation_for(target, fingerprint, ObservationPurpose::OnDemand)`: 사용자가 명시적으로 요청한 화면 분석 티켓을 발급한다. 기본 `begin_observation`은 `Proactive`이며 OS 사건도 이 기본 정책만 사용한다.
- 실제 IPC는 창 열거·안정화 대기 **전** `prepare_observation(purpose)`로 취소 토큰을 잡고, `begin_prepared_observation(&preparation, target, fingerprint)`로 티켓을 발급한다. 취소·새 직접 요청·교체 요청·관찰 중지 후 늦게 끝난 네이티브 준비 작업은 새 티켓을 만들 수 없다. 잠금·전체 숨김·설정 변경도 준비를 무효화한다.
- `validate_observation(&ObservationTicket)`: **캡처 직전과 직후** 호출한다. OS에서 선택 창/앱 식별자를 별도로 확인해야 한다.
- `validate_observation_scope(&ObservationTicket)`: 반응 완료 후에도 범위·세대·시각을 검증한다. 이미 시작한 반응의 자체 발화 간격에는 걸리지 않는다.
- `validate_observation_response_scope(&ObservationTicket)`: 이미 발급한 답변의 허용 범위·표시·잠금을 계속 검사한다. 분석 기한이나 다음 캡처 시도를 말풍선·음성의 수명 제한으로 재사용하지 않는다. 캡처의 `epoch`, 권한·설정의 `scopeEpoch`, 자동 반응의 입력·회의 억제용 `activityEpoch`를 구분한다. 다음 준비·대기 시간 거절·분석 실패·침묵은 이전 대사를 지우지 않으며, 실패한 티켓은 같은 요청의 발화만 취소할 수 있다. 실제 중지·권한 철회·범위 변경·잠금·숨김과 사용자 취소는 계속 적용한다.
- `invalidate_observation()`: 현재 관찰 작업만 무효화하며 허용 설정과 직접 대화는 유지한다.
- `invalidate_observation_ticket(&ticket)`: 그 티켓이 아직 현재 요청인 경우에만 취소한다. 이전 요청의 watchdog이 새 수동 요청까지 취소하지 않게 한다.
- `observe(ObservationRequest { ticket, imageBase64, mimeType }) -> Option<ConversationReply>` (async): 도메인 권한/세대 검사. 실제 IPC는 `observe_with_validation(request, validate)`를 사용하며, 키 조회 후 전송 직전과 결과 직후 기록 반영 전에 네이티브 대상도 재검증한다. 이미지에는 명시적으로 허용한 창 또는 현재 모니터의 캡처만 넣는다.
- `stop_observation() -> Settings`: 수집·전송·대기 반응 취소, mode off. 직접 대화 기능 유지.

모든 함수는 별도 표기가 없는 반환값을 `Result<..., String>`으로 감싼다. `cancel`만 `()`이다. 관찰 티켓은 Rust 네이티브 캡처 명령 안에서 생성하고 사용한다. WebView가 임의 앱 ID와 이미지를 조합해서 넘기는 캡처 인터페이스를 노출하지 않는다.

`begin_observation(target, "")`으로 캡처 전 티켓을 생성할 수 있다. 티켓의 `purpose`는 `proactive` 또는 `onDemand`이며 게이트가 기억한 실제 발급 목적과 일치해야 한다. 호출자가 기존 자동 티켓의 목적만 바꿔 제한을 우회할 수 없다. `observe`는 캡처 이미지 해시로 자동 요청의 중복을 검사한다. 시간 간격은 캡처 전, 화면 동일 여부는 캡처 후 검사한다. 해시는 중복 억제 용도이며 권한 증명이 아니다. `validate_observation` 자체는 OS 창 상태를 알 수 없으므로 네이티브 계층에서 캡처 전후의 실제 창 ID·PID·앱 ID를 확인한다.

Tauri `save_settings({patch})`는 전체 설정 복사본 대신 변경한 필드를 받는다. 선택 창을 최초 허용할 때 창 ID·PID·앱 ID를 메모리에 고정한다. 다른 설정 저장은 이 승인을 새로운 창으로 교체하지 않는다. `analyze_window({manual?:bool})`는 250ms 창 안정화 이후 해당 승인과 대조해 캡처한다. manual 생략은 false이며 명시적 버튼 요청만 true로 전달한다. 추론 중에는 350ms 간격으로 권한·잠금·표시 상태·허용 범위를 확인한다. 활성 창 일치는 허용 앱의 활성 대상을 따라가는 모드에서만 요구한다. 선택 창과 모니터 전체 모드는 다른 앱에 포커스가 옮겨도 유지한다. 자동 요청에는 입력·집중·회의·조용히 정책도 적용한다. 전달 직전에도 OS 사실과 발화 세대를 재검사한다. 이 폴링 간격은 초기 정책이며 실측 지연 보장이 아니다.

`speech-cancelled` 이벤트 payload는 `{origin: string}`이며 직접 취소 명령의 origin은 Tauri가 주입한 호출 창 label이다. 모델 교체는 `origin: "model"`. 프런트엔드는 자신의 요청 시작을 위해 보낸 취소 이벤트와 다른 창에서 받은 취소를 구분한다. `observation-stopped`는 관찰 발화만 취소한다. keyring 상태 확인 실패는 snapshot의 `credentialError`로 표시하며 캐릭터/설정 로딩을 차단하지 않는다.

표정과 몸짓 강도는 각 프리셋의 `expressionStrength`·`gestureStrength`와 `personalityIntensity`를 각각 적용한다. 몸짓에 표정 배율을 다시 곱하지 않는다. 직접 대화와 화면 반응은 공통 정책에서 한 번만 배율을 적용한다. 성격 미리보기는 별도의 일상 고정 예시다. 발화 빈도는 프리셋의 최소 간격과 `personalityFrequency`를 함께 적용하고 0이면 선제 반응을 끈다. 질투 빈도는 별도의 최소 간격(최대 빈도에서도 10분)을 적용한다. 이 값은 초기 제품 정책이며 측정된 성능 수치가 아니다.

## 데이터

`Reaction`: `{shouldReact: bool, text: string, emotion: "happy"|"sad"|"surprised"|"annoyed"|"calm", intensity: 0..1, gaze: "user"|"screen"|"away", gesture: "none"|"nod"|"tilt"|"smallBounce"|"lookAway", priority: 0..3}`. 알 수 없는 필드·열거형·범위 초과·긴 대사는 거부한다. 실제 Cubism 파라미터는 전달하지 않는다.

위 계약은 제공자 입력이다. Rust가 성격 정책을 적용한 출력에는 `gestureIntensity?: 0..1`이 추가된다. 제공자 입력의 이 필드는 거부하며 로컬에서만 결정한다. 프리셋 미리보기의 표정/몸짓 강도는 츤데레 `.7/.5`, 고양이 `.35/.25`, 응원단 `.95/.8`이다. 렌더러는 몸짓 강도 0을 그대로 유지하고, 필드가 없는 표정 미리보기 등에는 `intensity`를 사용한다. 몸짓은 감정·발화 지속 시간과 별개로 1.2~1.6초에 한 번 움직인 뒤 복귀한다.

`ConversationReply`: `{utteranceId: string, reaction: Reaction, source: "provider"|"localOsEvent"}`. `AudioReply`: `{utteranceId, audioBase64, mimeType}`. UI에서 base64를 AudioContext가 디코딩할 바이트로 변환한다. 오디오와 입 모양은 해당 Web Audio 재생 시계를 기준으로 한다.

`Memory`: `{id, text, createdAt, updatedAt, expiresAt}`. 시간은 UNIX milliseconds. 만료 기억은 조회 시 지우며 AI에도 전달하지 않는다. 사용자 확인 없는 자동 저장은 지원하지 않는다.

`get_model_mapping` / `save_model_mapping`는 가져온 모델과 `builtin:mao`, `builtin:haru`, `builtin:kei`를 지원한다. 기본 모델 매핑은 SQLite의 별도 `builtin_model_mappings` 테이블에 저장하고 모델마다 격리한다. 가져온 모델과 동일한 객체·크기·깊이·문자열·숫자 검증을 저장/읽기에 적용한다. SQLite 스키마 버전 2는 버전 1의 설정·기억을 보존한다. 설정 JSON의 schemaVersion은 계속 1이다.

`is_companion_visible()` 명령은 실제 네이티브 캐릭터 창이 표시되고 최소화되지 않았는지를 bool로 반환한다. `show_companion`과 트레이에서 보이기는 `companion-visibility: {visible:true}`, 캐릭터 창 닫기→숨김은 `{visible:false}`를 발생시킨다. 프런트엔드는 이 상태를 사용해 실제로 보이는 창 하나에서만 음성을 재생한다.

`observation-visibility: {visible}`는 main 또는 companion 중 하나라도 표시되고 최소화되지 않았는지를 알린다. 두 창 모두 숨김이면 진행 중인 관찰 티켓·HTTP 요청·관찰 재생을 취소한다. 직접 대화의 취소와 구분한다.

실제 입력 중·조용히·집중·회의·발화 빈도 0은 선제 반응을 억제한다. 사용자가 누른 ‘지금 화면 한 번 보기’는 `onDemand`로 처리하여 이 억제와 자동 분석 간격·동일 화면 중복 제한을 건너뛴다. 따라서 같은 화면을 다시 요청할 수도 있다. 수동 요청도 화면 잠금·전체 숨김·동의 해제·범위/대상 변경·민감 앱·권한 거부·오래된 화면·관찰 중지에서는 취소된다. 설정 변경과 새 직접 대화의 기존 취소 정책도 유지한다.

수동 분석을 준비하는 동안과 HTTP 분석 중에는 `on_demand_observation_guard()`가 자동 화면/OS 반응을 막는다. 결과 뒤에는 공통 반응 간격이 적용되고 TTS HTTP 처리에는 기존 직접 요청 guard가 적용된다. 수동 화면 답변은 자동 질투 연출 때문에 침묵으로 바꾸지 않는다. 프런트엔드의 `origin:"manualObservation"`은 수동 IPC 요청을 보낸 흐름에만 붙이는 재생 구분값이며 권한 근거는 Rust가 발급한 티켓이다. 관찰 중지·잠금·전체 숨김·설정 변경에서는 이 origin도 취소하고, 입력 휴식에서는 자동 `observation` origin만 취소한다.

화면 분석 답변에는 발화 ID와 원래 창 ID·PID·앱 ID·활성 창·관찰 티켓을 연결한다. TTS 시작/완료, 재생 직전 `validate_utterance`, 재생 중 기존 500ms 활동 루프에서 대상·권한·동의·표시·잠금·관찰 범위를 다시 검사한다. TTS HTTP 대기 중에는 350ms 검사로 늦은 오디오를 폐기한다. 분석의 30초 기한은 답변 발급까지 적용하며 정상 오디오 길이를 제한하지 않는다. 네이티브 사실 검사는 전역 runtime을 수정하지 않으므로 이전 watchdog이 새 요청의 상태를 덮어쓰지 않는다. 무효화는 티켓과 발화 ID를 비교한 뒤 실행하며 `observation-invalidated: {utteranceId}`를 보낸다. 두 창은 같은 ID의 관찰 재생/준비만 정리하고 새로운 직접 대화나 다른 관찰 발화를 보존한다.

`react_to_os_event(&platform::OsEvent)`는 허용 앱 모드의 실제 활성 창 변경에만 로컬 반응을 만든다. 설정 범위·대상 식별자·시각·표시/입력 상태를 검사하고 화면 분석과 같은 `ObservationGate`의 침묵·중복·반응 간격·성격 강도·발화 세대를 사용한다. `os-reaction: {event, reply}`는 이 정책을 통과한 경우에만 전달한다. 창 제목이나 화면 내용은 이 경로로 분석하지 않으며 창 닫힘을 작업 완료로 해석하지 않는다.

## Core 모델 정보

`save_model_metadata({id, metadata: {parameters: [{id, minimum, maximum, default}], expressions: [string]}})`는 실제 Core 로딩 성공 후 모델별 정보를 SQLite에 저장한다. `get_model_metadata({id})`는 저장된 객체 또는 `null`을 반환한다. ID 중복, 비유한 수치, 뒤집힌 범위, 범위 밖 기본값과 과도한 목록 크기를 거부한다. 가져온 모델의 ID는 관리 목록에 있어야 한다. 저장된 정보로 이후 Core 검사나 런타임 기능 감지를 생략하지 않는다.

## 제공자 선택 근거

업체 교체를 위해 Chat Completions 호환 REST, STT multipart, TTS 바이너리 응답을 별도 어댑터 계약으로 사용한다. OpenAI 신규 전용 서비스라면 Responses가 권장되지만 이 앱의 첫 연결은 여러 제공자의 호환 인터페이스를 목표로 한다. 설정 모델은 JSON object 응답과 이미지 입력을 지원해야 화면 분석을 사용할 수 있다. 자동 재시도는 중복 과금·발화 방지를 위해 하지 않는다.

공식 계약 확인: [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create), [Transcription](https://developers.openai.com/api/reference/cli/resources/audio/subresources/transcriptions/methods/create), [keyring 3.6.3](https://docs.rs/keyring/3.6.3/keyring/struct.Entry.html). 실제 제공자·계정·음성 품질 검증은 API 설정 후 별도 수행한다.
