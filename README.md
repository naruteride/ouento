# Ouento

선택한 성격과 Live2D 캐릭터로 일상을 함께하는 데스크톱 AI 동반자입니다. Tauri 2, Rust, JavaScript Web Components, Cubism SDK for Web을 사용합니다. 제품 범위는 [기획서](<virtual_companion_plan_2026-09-11(1).md>)와 [AGENTS.md](AGENTS.md)를 따릅니다.

현재는 MVP 코드가 통합되고 macOS 개발용 앱 번들이 생성된 단계입니다. 코드·자동 테스트·macOS/Windows 배포 앱 검증·사용자 알파를 구분합니다. 최신 수행 결과와 미검증 항목은 [검증 기록](docs/verification.md)을 확인하세요.

## 개발 환경

- Node.js **22.15.0 이상**, npm. JavaScript 의존성은 `package-lock.json`으로 고정합니다.
- Rust **1.88 이상**. 현재 macOS 개발 환경에서 확인한 버전은 `rustc 1.98.1`이며 실제 의존성은 `src-tauri/Cargo.lock`을 따릅니다.
- macOS: Xcode Command Line Tools 또는 Xcode. Tauri 구성상 최소 macOS 12.0이지만 최저 OS에서의 실제 실행은 별도 검증이 필요합니다. 현재 개발 호스트는 Apple Silicon입니다.
- Windows: Microsoft C++ Build Tools의 **Desktop development with C++**, Windows SDK, Rust MSVC 도구 모음, Microsoft Edge WebView2. Windows 11 x64를 우선 검증 대상으로 삼으며 Windows 빌드·실기는 아직 완료되지 않았습니다.

운영체제 도구 설치는 [Tauri 공식 사전 준비](https://v2.tauri.app/start/prerequisites/)를 따릅니다. Linux와 모바일은 이번 MVP 범위에 포함하지 않습니다. Node는 빌드 도구이며 배포 앱에 별도 Node 서버나 Python 프로세스가 필요하지 않습니다.

## 처음 실행하기

저장소 루트에서 실행합니다.

```sh
npm ci
npm run assets:setup
npm run desktop
```

`assets:setup`은 고정된 공식 SDK/Core/MotionSync와 Mao·Haru·Kei 샘플을 준비하고 해시를 검사합니다. 자산은 Git에 포함하지 않습니다. 버전·출처·라이선스·오프라인 준비 방법은 [SDK 기록](docs/sdk-versions.md)에 있습니다.

이미 검증된 원본 5개가 `.cache/downloads/`에 있으면 `npm run assets:setup -- --offline`으로 네트워크 없이 다시 준비할 수 있습니다. 캐시가 없거나 해시가 다르면 실패합니다. `npm run assets:setup -- --verify`는 앞선 준비가 만든 무결성 목록으로 현재 출력만 검사하며, 다운로드나 누락 파일 복원을 수행하지 않습니다.

처음에는 AI 없이 Mao 모델의 표시와 표정부터 확인합니다. 대화를 사용하려면 **설정**에서 대화/화면 이해, 음성 인식(STT), 목소리(TTS)의 API 기본 주소와 모델을 각각 지정하세요. OpenAI 호환 API를 사용하며 특정 모델 이름이나 계정 키는 기본 제공하지 않습니다. 키는 운영체제 보안 저장소에 저장합니다. HTTPS를 사용하며 HTTP는 루프백 로컬 제공자만 허용합니다.

화면 관찰은 기본으로 꺼져 있습니다. **함께 보기**에서 창 또는 허용 앱, 제외 앱, 전송 동의를 지정한 뒤 범위를 적용하세요. **조용히 함께 있기**는 선제 발화를 억제하고, **관찰 중지**는 화면 수집·전송·대기 반응을 중단합니다. 마이크는 음성 입력을 직접 시작할 때만 사용합니다.

**지금 화면 한 번 보기**은 직접 누른 요청입니다. 입력 중·조용히·집중·회의 상태에서도 허용한 화면을 분석할 수 있습니다. 자동 관찰은 이 상태에서 쉬며, 두 방식 모두 관찰 중지·잠금·전체 숨김·동의 철회·범위 변경 시 취소됩니다.

캐릭터는 **캐릭터 → 불러오기**에서 폴더나 ZIP으로 추가합니다. `.model3.json`, `.moc3`, 텍스처가 필요하며 편집 원본이나 PNG만으로는 실행할 수 없습니다. 먼저 미리보기에서 표정·입 모양과 기능 안내를 확인한 뒤 **이 캐릭터 사용**으로 적용합니다. 그 전에는 바탕화면 캐릭터와 인격·기억을 바꾸지 않습니다. 새 인격으로 바꾸면 기존 기억이 삭제되므로 교체 선택을 확인하세요.

**설정 → 캐릭터 표시 크기**는 캐릭터 창을 함께 조절합니다. 마지막 위치는 모니터 작업 영역에 대한 상대 위치로 저장하며, 모니터가 없어지거나 배율이 달라지면 사용 가능한 화면 안으로 맞춥니다. 모델별 세부 배치는 **표정·움직임·표시 직접 설정하기**에서 조절합니다. 두 창을 모두 숨기거나 최소화하면 자동 관찰을 멈춥니다.

## 개발·검사 명령

| 명령                                                        | 용도                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                                               | 로컬 브라우저 미리보기, `http://127.0.0.1:1420`                   |
| `npm run desktop`                                           | Tauri 개발 앱과 Vite를 함께 실행                                  |
| `npm run check`                                             | TypeScript 캐릭터/SDK 정적 검사                                   |
| `npm test`                                                  | JavaScript 회귀 테스트                                            |
| `npm run test:models`                                       | 실제 Core와 MotionSync의 모델·PCM 검사                            |
| `npm run test:compatibility`                                | 공식 10묶음·9계열의 폴더/ZIP 가져오기·미리보기/확정 자산 일치 검사 |
| `npm run format:check`                                      | 앱 코드 포맷 검사                                                 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked`  | Rust 도메인·저장·모델·플랫폼 회귀 테스트                          |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked` | 네이티브 정적 검사                                                |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`    | Rust 형식 검사                                                    |
| `npm run build`                                             | 프런트엔드 정적 검사 + 배포용 `dist` 생성                         |
| `npm run assets:setup -- --offline`                         | 검증된 로컬 캐시에서 SDK 자산 재생성                              |
| `npm run assets:setup -- --verify`                          | 준비한 SDK 자산 무결성 확인                                       |
| `node scripts/check-models.mjs`                             | 실제 Core의 Mao/Haru/Kei 검사, Mao 모음 설정·한국어 PCM·무음 복귀 |
| `node scripts/check-motion-sync.mjs`                        | 실제 제품 MotionSync 연결의 PCM 보존·취소·해제 검사               |
| `node scripts/check-controller.mjs`                         | 캐릭터 이벤트의 지연·취소·미리보기·말풍선·숨김 회귀 검사          |
| `node scripts/check-model-preview.mjs`                      | 모델 미리보기·사용 확정·취소·저장 실패·지연 메타데이터 회귀 검사 |
| `node scripts/check-observation-controller.mjs`            | 수동/자동 관찰 우선순위·중지·늦은 응답 회귀 검사               |
| `npm run test:controllers`                                 | 캐릭터 이벤트·모델 사용 확정·관찰 컨트롤러 검사 함께 실행      |

브라우저 미리보기에서는 실제 Cubism 모델과 UI를 볼 수 있습니다. AI·기억 저장·OS 화면 관찰·네이티브 창 기능은 Tauri 앱에서 검증해야 합니다. 브라우저의 작동을 데스크톱 앱의 성공으로 대체하지 않습니다.

실제 WebGL 반복 검사는 개발 서버의 `http://127.0.0.1:1420/tests/browser/model-soak.html`에서 **50회 검사 시작**을 누릅니다. Mao/Haru/Kei 교체, 음소거한 한국어 샘플, 지연 로딩 취소, 그래픽 연결 복구, 30/60 FPS와 종료 후 자원 반환을 검사합니다. 페이지 결과는 브라우저 API 호출 수이며 네이티브 전체 메모리나 장시간 성능을 대신하지 않습니다. 이 페이지는 배포 빌드에서 제외됩니다.

모델 호환성 검사는 SDK 자산 준비와 Rust 검사를 마친 뒤 `npm run test:compatibility`를 실행하고, 개발 서버의 `http://127.0.0.1:1420/tests/browser/model-compatibility.html`을 엽니다. 원본 SDK ZIP의 해시·모든 표본 바이트를 대조한 후 제품 가져오기 API로 검사하며, 출력은 `.cache/model-compatibility/`에만 저장합니다. Rust 의존성은 오프라인으로 사용하므로 첫 Rust 검사로 먼저 준비해야 합니다. 결과와 기능 제한은 [모델 호환성 기록](docs/model-compatibility.md)을 확인하세요.

같은 검증 자산으로 `http://127.0.0.1:1420/tests/browser/model-hit-check.html`에서 실제 픽셀과 클릭 판정을 비교할 수 있습니다. Haru·Mao·Ren의 8개 상태와 Ren 연속 재로딩을 검사합니다. 측정 방법과 경계 오차는 [클릭 영역 기록](docs/model-hit-testing.md)에 있습니다.

**캐릭터 → 한국어 음성·입 모양 확인**은 AI 연결 없이 Live2D 공식 Kei 한국어 WAV를 재생합니다. 이 음원으로 시작·끝·중지와 감정 표정 중 입 움직임을 비교하세요. 검사 스크립트의 수치 통과와 실제 시청각 품질은 별도로 기록합니다.

`npm run desktop`은 Vite를 자동 실행합니다. 이미 `npm run dev`로 1420 포트를 사용하고 있으면 먼저 해당 개발 서버를 종료하세요.

## 배포 빌드

각 운영체제에서 네이티브 빌드를 수행합니다. 아래 명령이 문서에 있다는 사실은 해당 운영체제의 빌드 성공을 의미하지 않습니다.

macOS에서 `.app` 생성:

```sh
npm run desktop:build -- --bundles app
```

산출물 기본 위치는 `src-tauri/target/release/bundle/macos/Ouento.app`입니다. DMG가 필요하면 `--bundles dmg`를 사용합니다. 다른 기기에 배포할 때는 [macOS 서명·공증 및 번들 안내](https://v2.tauri.app/distribute/macos-application-bundle/)를 따르세요. 현재 macOS 투명 창에 `macOSPrivateApi`를 사용합니다.

Windows에서 NSIS 설치 프로그램 생성:

```powershell
npm run desktop:build -- --bundles nsis
```

설치 프로그램은 `src-tauri/target/release/bundle/nsis/`에 생성됩니다. `.msi`는 `--bundles msi`를 사용하며 추가 WiX/VBScript 환경 요구사항이 있습니다. [Windows 설치 프로그램 안내](https://v2.tauri.app/distribute/windows-installer/)

서명되지 않은 개발 빌드와 공개 배포는 별개입니다. Cubism Core, MotionSync Core, 샘플 모델의 재배포·고지·확장형 앱 조건은 [SDK 라이선스 기록](docs/sdk-versions.md#출처와-고지)을 먼저 검토하세요. `.gitignore`에 들어 있다는 사실만으로 배포물이 라이선스 검토에서 제외되는 것은 아닙니다.

## 코드와 데이터

```text
src/ui/                 JavaScript Web Components / Shadow DOM
src/character/          TypeScript Cubism 렌더러·표정·립싱크
src/audio/              Web Audio 재생·취소·마이크 입력
src/bridge/             UI와 Tauri 경계
src-tauri/src/domain/   성격·반응·관찰·취소 정책
src-tauri/src/providers/텍스트·이미지/STT/TTS 제공자
src-tauri/src/models/   모델 검사·가져오기·매핑
src-tauri/src/platform/ macOS·Windows 어댑터
src-tauri/src/storage/  설정·허용한 요약 기억·Core 파라미터 정보
src-tauri/src/desktop.rs 창 크기·위치·모니터 변경 처리
public/config/          앱이 작성한 모델별 설정
```

`vendor/`, `public/vendor/`, `public/models/`, `.cache/`, 빌드 출력은 생성 자산이므로 Git에서 제외합니다. SDK 원본은 `assets:setup`으로 복원하고, 앱의 모델별 설정은 `public/config`에 별도로 둡니다. API 키와 개인 자료를 `.env`, 코드, 로그, 테스트 자료에 넣지 마세요. 원본 화면·음성·키 입력의 지속 저장을 기본 기능으로 사용하지 않습니다.

자세한 계약: [UI](docs/ui-contract.md), [Rust 백엔드](docs/backend-contract.md), [플랫폼·가져오기](docs/platform-contract.md), [Mao 입 모양과 연기](docs/mao-mapping.md).

앱 데이터 폴더의 SQLite 스키마 3에는 모델별 실제 파라미터 ID·최소/최대/기본값과 읽을 수 있는 표정 이름이 저장됩니다. 이 정보는 Core 로딩 성공 후 갱신하며 다음 로딩의 검사를 대신하지 않습니다. `companion-window.json`은 창 위치만 저장하고 인격·기억과 별도로 관리합니다.

## 아직 확인이 필요한 것

Mao의 모델·파라미터와 새 MotionSync 설정은 실제 SDK에서 검사했지만 한국어 음성의 시청각 품질·동기화는 별도 확인이 필요합니다. 두 OS 배포 앱의 클릭 통과·포커스·혼합 배율·잠금 복귀, 실제 AI 제공자 연결, 장시간 자원 측정, 서로 다른 사용자 모델 10개, 10~20명 1주 알파는 각각 증거를 남겨야 합니다. 성능 수치는 측정 전까지 목표이며 현재 성능 보장이 아닙니다.
