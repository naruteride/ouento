# 네이티브 플랫폼·모델 저장소 계약

이 문서는 구현된 Rust 경계와 검증 한계를 기록한다. macOS/Windows 실기 확인 여부는 통합 검증 기록을 따른다.

## 의존성과 공개 API

- 공통: `serde`, `serde_json`, `uuid` (`v4`), `base64` 0.22, `image` 0.25 (`png`, `jpeg`), `zip` 2.4 (`deflate`).
- macOS/Windows: `xcap = "=0.9.8"`. 네이티브 커서·권한·입력 상태는 OS FFI. Node/Python 프로세스를 실행하지 않는다.
- `platform::capabilities() -> PlatformCapabilities`
- `platform::request_screen_permission() -> Result<bool, String>`: 사용자가 관찰을 켰을 때만 호출한다.
- `platform::list_windows() -> Result<Vec<WindowInfo>, String>`: 자기 프로세스와 제목 없는 창을 제외한다.
- `platform::capture_window(&CaptureRequest) -> Result<CapturedFrame, String>`: 캡처 직전/후 창 ID·PID·앱 이름을 재검사한다. 요청의 `consented`가 false이면 수집하지 않는다. root의 관찰 세대/허용 범위 검사는 별도로 전송 직전에 다시 필요하다.
- `platform::cursor_position() -> Result<CursorSample, String>`
- `platform::primary_button_down() -> bool`: 네이티브 드래그 중 클릭 통과 상태를 고정하고 실제 마우스 해제 시 복구하기 위한 버튼 상태.
- `platform::activity_snapshot() -> ActivitySnapshot`
- `models::ModelStore::new(PathBuf) -> Result<ModelStore, String>`: 앱의 관리 모델 폴더를 인자로 받는다.
- `inspect_source(&Path) -> Result<ImportInspection, String>`: 폴더/ZIP을 한도 내 임시 폴더에 스냅샷한다. `token`과 후보 `candidates`를 반환한다.
- `import(&str token, &str entrypoint) -> Result<ImportedModel, String>`: 선택한 진입점과 검증된 참조만 UUID 관리 폴더로 옮긴다. Core 검사는 렌더러의 모델 생성 전에 반드시 실행해야 한다.
- `list()`, `get(id)`, `remove(id)`, `discard_inspection(token)`: 가져온 모델 관리.
- `read_asset(id, relative_path) -> Result<Vec<u8>, String>`: manifest에 기록한 검증 자산만 반환한다. 임의 파일 읽기 명령으로 노출하지 않는다.
- `read_import_asset(token, entrypoint, relative_path) -> Result<Vec<u8>, String>`: 사용 확정 전 미리보기용. 해당 후보의 검증된 자산만 읽고 진입점은 사용할 수 없는 선택 참조를 제외한 JSON을 반환한다. 네이티브 IPC는 blocking 작업 풀에서 실행하며 검사 결과는 제한된 메모리 캐시에 보관한다. 사용 확정 시 전체 파일을 다시 검사한다.
- `save_mapping(id, serde_json::Value)`, `load_mapping(id)`: 모델별 JSON 매핑. UI에서 Core가 반환한 파라미터와 대조하며 저장소도 크기·숫자·객체 형식을 제한한다.

구조체 JSON 필드는 `camelCase`다. 오류는 사용자에게 표시 가능한 한국어 메시지다.

Windows의 `GetAsyncKeyState`는 논리 기본 버튼이 아니라 물리 버튼을 읽는다. `GetSystemMetrics(SM_SWAPBUTTON)`에 따라 왼쪽/오른쪽을 선택해 기본 버튼을 교환한 사용자도 드래그 유지 상태를 올바르게 읽는다. [Microsoft API 계약](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate). 호스트에서 타입 검사는 했지만 Windows 링크·실기 검증은 별도다.

## 좌표와 관찰 사실

macOS의 CGEvent 전역 커서는 주 디스플레이 왼쪽 위 기준 **desktop points**, Windows GetCursorPos는 DPI-aware 앱의 **physical pixels**다. `CursorSample.coordinateSpace`로 구분한다. 혼합 배율 환경에서 macOS 전역 점에 단일 화면 배율을 곱하지 않는다. Tauri 창과 비교하는 네이티브 hit test에는 동일 좌표계를 반환하는 Tauri `Window::cursor_position`/창 좌표를 사용하고 CSS 좌표 변환 시 해당 창 배율을 적용한다.

창 캡처는 `xcap::Window::capture_image`만 사용한다. Windows 빌드는 **`wgc` 기능을 반드시 켠다**. 기본 GDI 구현의 BitBlt fallback 대신 HWND 전용 GraphicsCaptureItem으로 제한한다. 전체 모니터 캡처 후 잘라내기로 대체하지 않는다. 축소된 PNG와 해시만 메모리로 반환하며 파일로 저장하지 않는다. 기본 민감 앱 목록과 사용자가 지정한 추가 제외 목록을 적용한다. 보호 창/최소화/권한 거부 시 실패를 반환하며 다른 창으로 대체하지 않는다.

기본 차단 목록은 완전한 민감 앱 탐지기가 아니다. 명시적 창/앱 허용과 함께 적용해야 한다. 브라우저 주소·페이지 내 민감정보를 보장해서 탐지하지 않는다. `CapturedFrame`은 원시 화면 데이터이므로 로그/영속 저장 금지다.

입력 상태는 내용 없는 최근 활동 여부다. macOS 입력 모니터링을 허용하지 않으면 `typing = null`이며 권한을 자동 요청하지 않는다. Windows는 `GetLastInputInfo`의 마지막 입력 시각과 `GetTickCount`를 비교하므로 폴링 사이에 완료된 짧은 입력도 반영한다. 이 API는 키보드와 마우스를 구분하지 않으므로 Windows에서는 둘 다 1.5초 동안 보수적으로 억제하며, 키보드만 감지한다고 표시하지 않는다. 키코드·문자·입력 내용은 읽거나 저장하지 않는다. API 실패나 현재보다 미래로 해석되는 입력 시각은 `null`로 처리한다. 이 시각은 해당 세션의 입력만 나타내고 일부 주입 입력에서는 증가가 보장되지 않는다. 회의 및 집중 모드는 OS에서 신뢰할 수 있는 공통 API가 없으므로 `null`이다. UI의 수동 집중/회의 모드로 억제한다. 미지원 값을 `false`로 바꾸지 않는다.

위 입력 정책은 자동 화면 분석과 OS 사건의 선제 반응에 적용한다. 사용자의 ‘지금 화면 한 번 보기’는 Rust가 `onDemand` 티켓으로 발급해 입력 중/미확인을 허용한다. 이 예외가 OS 캡처 경계의 잠금·표시·화면 권한·동의·선택 대상/민감 앱 검사를 생략하지는 않는다.

## 공통 OS 사건

`WindowEventTracker::poll(&ObservationSettings)`은 허용 앱 모드에서만 실제 활성 창 변경을 감지한다. 첫 표본은 기준점이며 최소 250ms 동안 같은 최종 창을 확인한 후 사건을 만든다. 현재 호출 간격은 500ms이므로 실제 시작 지연 보장이 아니다. 숨김·잠금·입력 미확인 또는 모드 변경 시 추적기를 초기화한다. 입력 중에는 기존 기준점을 유지하며 호출을 쉬고, 입력이 멈춘 후 현재 최종 창을 새로 안정화한다.

`OsEvent` 필드는 `timestamp`(현재 창을 확인한 UNIX ms), `target:{appId,windowId,pid}`, `kind:"activeWindowChanged"`, `certainty:"observed"`, `source:"xcapMacos"|"xcapWindows"`, `scope:{mode:"allowedApps",appId,windowId}`다. 사건을 생성할 때 허용 앱/민감 앱을 검사하고 백엔드에서 다시 현재 허용 범위와 3초 신선도를 검사한다. 창 제목·화면·키 입력 내용은 사건에 넣지 않는다. 창이 사라졌다는 이유만으로 완료·성공 반응을 생성하지 않는다. 선택 창 함께 보기에는 이 선제 사건 반응을 추가하지 않는다.

세션 보호는 Windows 입력 데스크톱 접근/이름과 macOS `CGSessionCopyCurrentDictionary`의 공식 콘솔·로그인 키 및 `CGDisplayIsAsleep`으로 비활성/절전 상태를 억제한다. macOS 화면 잠금의 추가 신호로 `CGSSessionScreenIsLocked`를 읽지만, 이 키는 Apple의 공개 키 목록에 없는 **미문서 의존성**이다. `source=core_graphics_session_best_effort`로 표시하며 macOS 버전별 실제 잠금/복귀 시험 전까지 완전한 잠금 보장을 주장하지 않는다. 사전을 읽을 수 없으면 관찰을 억제한다. `locked=true`는 잠금뿐 아니라 관찰하면 안 되는 비활성/보안 세션도 포함한다.

## 가져오기 한도·신뢰 경계

초기 한도는 파일 4,096개, 전체 해제 512 MiB, 단일 파일 128 MiB, JSON 8 MiB, 텍스처 한 변 8,192px 및 64M pixel이다. 측정된 성능 수치가 아니라 메모리/압축 폭탄 방어 한도다. ZIP은 metadata와 실제 읽기 모두 제한한다. 경로 이탈·절대 경로·URL·심볼릭 링크·대소문자 중복·Windows 예약 파일명을 거부한다. 실행 파일과 스크립트는 복사하지 않는다.

모델 진입점의 Version 3와 필수 Moc/Textures 참조를 검사한다. 선택 자산의 누락·문법/구조 손상은 경고와 참조 제거로 처리한다. 위험 경로·외부 참조·링크와 필수 자산 실패는 모델 전체를 거부한다. 검증한 자산만 관리 폴더에 복사하며 Core가 제공하는 실제 파라미터와 맞지 않는 표정·MotionSync 연결도 렌더러에서 제외한다. MOC3 기본 헤더 검사는 **Core의 정합성 검사나 지원 버전 검사 대신이 아니다**. `requiresCoreValidation`은 가져오기 검사에서 true로 두며 렌더러의 CubismMoc.create(buffer, true)와 버전 검사를 통과해야 실제 로딩 성공으로 표시한다.

원본 JSON을 임의 실행하지 않으며 파라미터 ID는 AI 실행 명령이 아니다. 기본 기능 표시는 파일의 존재에 따른 후보이며 실제 파라미터/범위/표정 미리보기에서 최종 지원 여부를 판단한다.

## 근거

- [xcap 0.9.8 소스·의존성](https://docs.rs/crate/xcap/0.9.8)
- [xcap 창 열거/캡처 예제](https://github.com/nashaofu/xcap)
- [Live2D MOC3 정합성 검사](https://docs.live2d.com/en/cubism-sdk-manual/moc3-consistency/)
- [Live2D 실행용 데이터](https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/)
- [Apple CGSessionCopyCurrentDictionary](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary())
- [Apple 공식 세션 키 목록](https://developer.apple.com/documentation/coregraphics/window-server-session-properties)
- [Windows GetLastInputInfo와 세션·시각 제약](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)
- [Windows GetTickCount의 32비트 래핑](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount)
## 창 크기와 위치

`desktop.rs`는 Tauri가 반환하는 물리 좌표와 모니터 작업 영역을 사용한다. 기본 창은 420×580 논리 픽셀이며 표시 크기 0.5~1.5에 따라 캐릭터 영역과 창을 함께 늘린다. 고정 UI 여백은 113 논리 픽셀, 최소 너비는 320으로 두고 작은 작업 영역에서는 전체 창을 맞춘다. companion 렌더러에는 전역 확대를 다시 적용하지 않는다.

마지막 모니터 이름·원점과 이동 가능한 영역 내 상대 위치를 `companion-window.json`에 저장한다. 첫 실행은 기본 모니터 작업 영역 우측 하단이다. 드래그 종료, 표시 크기 변경, 다시 표시할 때와 표시 중 2초 간격으로 위치를 검사한다. 모니터 제거·배율 변경 시 유효한 작업 영역으로 복원한다. 숨김/잠금 동안 30 Hz 커서 IPC를 중단한다. 좌표 계산 단위 테스트와 두 OS의 실제 혼합 배율 시험은 구분한다.
