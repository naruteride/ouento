# SDK 조합과 개발 자산

2026-09-22 기준으로 아래 **로컬 개발 조합**을 고정했다. SDK 소스와 바이너리·샘플은 Git에서 제외하고 공식 다운로드 원본에서 복원한다. 이 문서는 배포 허가나 플랫폼 실기 검증 완료를 뜻하지 않는다.

## 고정 조합

| 구성 | 선택한 원본 | 검증 근거 |
| --- | --- | --- |
| Cubism Core / Framework / Samples | Cubism SDK for Web `5-r.5` | 공식 ZIP의 `cubism-info.yml`과 SHA-256 |
| Cubism Core | `06.00.0001` | 패키지 `Core/CHANGELOG.md` 및 실제 Core 런타임 `0x06000001` 확인 |
| MotionSync Plugin | Cubism SDK MotionSync Plugin for Web `5-r.2` | 공식 ZIP의 `cubism-motionSync-info.yml`과 SHA-256 |
| MotionSync Core (CRI) | `05.00.0004` | 위 패키지 `Core/CHANGELOG.md`의 최신 버전 변경 항목. 실행 시 버전 추가 확인 필요 |
| MotionSync 호환 타입 | Web Framework `5-r.4`의 `csmvector.ts`, `csmstring.ts`, `csmmap.ts` | 공식 Git 태그의 개별 파일 SHA-256 |
| 기본 연기 / 매핑 비교 | Mao / Haru | Web R5의 `Samples/Resources` 원본 |
| MotionSync 입력 검증 | Kei_vowels | MotionSync R2의 `Samples/Resources` 원본. 한국어 표본 `sounds/01_kei_ko.wav` 포함 |

원본 URL과 전체 SHA-256은 [sdk-lock.json](sdk-lock.json)에 있다. SHA-256은 2026-09-22 공식 원본에서 계산했다. 릴리스 이름이 같아도 체크섬이 바뀌면 준비를 중단한다. `latest`, 개발 브랜치, 알파를 참조하지 않는다.

Web R5 원본이 기록한 커밋은 Core `d96fa37f45ab8448936200c16a090ca9c2dc2945`, Framework `a49bc546222194ac28326d20a46aa35ee4d1ce8e`, Samples `d7d41dfa407deb8f57ffdaac3c2a74e23aada68e`다. MotionSync R2 원본은 Core `d9847bdf117e1a643c3d81bb5a92a48cc32599d7`, Components `4e7daecd27712379aa522536bf041e1202d9ef1c`를 기록한다.

모델 진입점 형식은 `.model3.json`의 `Version: 3`이다. 이것을 모델의 Cubism Editor 내보내기 버전이나 MOC 바이너리 버전으로 해석하지 않는다. 개별 모델은 로딩 시 Core의 지원 MOC 버전·정합성 검사 결과로 판정한다. PSD/편집용 `.cmo3`는 실행 대상이 아니다.

## 호환 변경

MotionSync R2의 README에 명시된 SDK 시험 조합은 **Web R3**다. 따라서 R5 + R2는 공식 호환 보장 조합으로 발표하지 않는다. 현재 R5 Framework는 예전 `csm*` 컨테이너 일부를 제거했고 파라미터 ID 문자열 표현이 바뀌었다. 로컬 통합에는 다음 변경만 적용한다.

1. R4 공식 태그의 `csmvector.ts`, `csmstring.ts`, `csmmap.ts`를 R5 `Framework/src/type/`에 추가한다. 원본 저작권 고지를 보존한다.
2. MotionSync `Framework/src/cubismmotionsyncdata.ts`의 `.isEqual(cubismParameterList.at(cubismParameterIndex).id)`를 `.isEqual(cubismParameterList.at(cubismParameterIndex).id.s)`로 바꾼다. R5 파라미터 ID가 요구하는 문자열과 구형 플러그인의 `csmString`을 연결하는 한 줄이다.
3. TypeScript의 `useDefineForClassFields: false`를 사용해 SDK 상속 필드의 초기화 의미를 유지한다.
4. R5 `Framework/src/rendering/cubismshader_webgl.ts`에 GL별 셰이더 수명 패치를 적용한다. 원본 매니저는 강한 `Map`을 사용하고 전체 해제만 제공한다. `releaseContext(gl)`로 해당 canvas만 제거하고, 프로그램 공유를 고려해 중복 없이 해제하며, 상태·배열을 초기화한다. 비동기 셰이더 로딩에는 세대 검사를 넣어 해제 후 프로그램이 다시 등록되지 않게 한다. 모델 교체에서는 캐시를 유지하고 context 손실·복구 및 렌더러 종료에서 해당 GL만 해제한다.

[setup-assets.mjs](../scripts/setup-assets.mjs)가 타입 복사와 호환 변경을 정확히 재현한다. 셰이더 변경은 [patch-cubism-shaders.mjs](../scripts/patch-cubism-shaders.mjs)에 분리하며 원본·패치 결과 SHA-256을 [sdk-lock.json](sdk-lock.json)에 고정한다. 예상 원본 위치가 1개가 아니거나 해시가 다르면 실패한다. 이 변경은 Ouento의 로컬 패치이며 공식 SDK의 수정 릴리스로 표시하지 않는다. 원본 저작권 고지를 보존하고 **Core 바이너리나 전용 Core 코드는 수정하지 않는다.** 타입 검사 통과만으로 WebKit·WebView2의 오디오/시각 동작이 검증된 것은 아니다.

`tests/renderer-boundaries.test.js`는 한 GL 해제가 다른 GL의 프로그램을 유지하는지, 복구 시 새 셰이더 상태를 만드는지, 늦은 로딩이 해제된 프로그램을 다시 할당하지 않는지 검사한다. 같은 파일에서 실제 Core를 사용해 미완료 자산 요청 중 모델 교체·종료 시 즉시 해제와 늦은 MOC 무시를 확인한다. `scripts/check-motion-sync.mjs`는 실제 CRI Core에서 두 번째 분석 프로세서 생성 실패를 주입하여 부분 생성 정리와 기존 프로세서 보존을 검사한다.

## 준비·재현

```sh
npm ci
npm run assets:setup
npm run assets:setup -- --verify
npm run check
```

`assets:setup`은 고정된 공식 파일 5개를 `.cache/downloads/`에 받고 해시를 확인한 뒤 SDK, 셰이더, Mao/Haru/Kei를 준비한다. 외부 다운로드를 못 쓰는 환경에서는 아래 이름으로 검증된 원본을 `.cache/downloads/`에 넣고 실행한다.

```text
.cache/downloads/CubismSdkForWeb-5-r.5.zip
.cache/downloads/CubismSdkMotionSyncPluginForWeb-5-r.2.zip
.cache/downloads/csmvector.ts
.cache/downloads/csmstring.ts
.cache/downloads/csmmap.ts
```

```sh
npm run assets:setup -- --offline
```

설치 스크립트는 ZIP 경로 이탈과 링크를 통한 출력 경로 우회를 거부한다. 다운로드는 파일당 64 MiB, ZIP은 10,000개 항목 / 512 MiB 해제 크기로 제한한다. 이것은 **개발 SDK 준비 한도**이며 사용자 모델 가져오기 한도와 별개다. 준비 후 `.cache/assets-manifest.json`에 생성 파일 해시를 기록한다. `--verify`는 네트워크·복사 없이 고정 파일과 출력의 일치 여부를 검사한다.

ZIP 해제 도구는 `fflate 0.8.3`으로 고정하며 npm 잠금 파일을 함께 유지한다. `--offline`은 모든 캐시가 필요하고 자동 다운로드로 전환하지 않는다. `--verify`는 기존 무결성 목록이 필요하며 누락 자산을 복구하지 않는다. 지원하는 옵션은 이 두 가지다.

| 출력 경로 | 용도 |
| --- | --- |
| `vendor/cubism-framework`, `vendor/cubism-core` | 빌드용 Framework 및 Core 타입·원본 |
| `vendor/motionsync`, `vendor/motionsync-core` | 빌드용 MotionSync 및 타입 |
| `public/vendor/cubism-core` | 브라우저 런타임 Core |
| `public/vendor/motionsync-core` | 브라우저 런타임 MotionSync Core |
| `public/vendor/shaders/WebGL` | R5 공식 WebGL 셰이더 |
| `public/vendor/licenses` | 패키지의 원본 LICENSE/NOTICE |
| `public/models/Mao`, `Haru`, `Kei_vowels` | 개발 표본·원본 라이선스 안내 |

오프라인 재실행은 이 생성 경로의 공식 파일을 다시 복사한다. 모델 매핑은 앱 데이터에 저장하고 `public/models` 원본을 수동 편집하지 않는다. 스크립트는 개발 자산을 준비하며, 최종 배포물의 포함 파일 목록은 별도로 검토해야 한다.

## 출처와 고지

- [Cubism SDK for Web 공식 다운로드](https://www.live2d.com/en/sdk/download/web/)에서 Core 포함 배포본을 확보한다. 다운로드 페이지는 사용허가 계약을 확인하도록 안내한다.
- [MotionSync 공식 다운로드](https://www.live2d.com/sdk/download/motionsync/)에서 별도 Core 포함 배포본을 확보한다.
- Framework와 MotionSync Components에는 [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)가 명시되어 있다. 수정 시에도 원본 고지와 이 변경 기록을 유지한다.
- Cubism Core와 MotionSync Core에는 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)가 적용된다. 각 `RedistributableFiles.txt`의 파일 목록과 배포 조건을 확인한다. 특히 Web R5 Core의 `.js.map`은 해당 목록에 없어 공개 출력에서 제거한다.
- Mao/Haru는 Web SDK의 `LICENSE.md`에, Kei_basic/Kei_vowels는 MotionSync의 `LICENSE.md`에 별도 샘플로 열거된다. [Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)와 [개별 샘플 이용 조건](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)을 함께 확인한다. 무료 다운로드를 무조건적인 재배포 허가로 해석하지 않는다.
- 사용자 모델을 추가할 수 있는 앱의 공개는 확장성 있는 앱(Expandable Application) 관련 조건도 확인해야 한다. [공식 Release License 안내](https://www.live2d.com/en/sdk/license/) 및 계약 원문에 따라 실제 서비스·조직 조건을 검토한 뒤 배포한다. 개발 준비만으로 배포 가능 여부를 단정하지 않는다.

## 현재 검증 상태

2026-09-22 macOS 개발 환경에서 `npm run assets:setup -- --offline`이 검증된 5개 캐시 파일로 242개 출력 파일을 재현했다. 이어 `npm run assets:setup -- --verify`의 242개 파일 무결성 검사와 `npm run check`의 TypeScript 검사가 통과했다.

실제 Core와 MotionSync를 사용한 Mao 파라미터 연결·한국어 WAV 분석·무음 복귀의 수치 검사는 [Mao 매핑 기록](mao-mapping.md)에 있다. 실행 검증 결과는 별도의 플랫폼 검증 기록에 남긴다. Web R5 + MotionSync R2의 실제 오디오 재생 동기화, Mao 입 형태의 한국어 발음 품질, macOS WebKit와 Windows WebView2 배포 앱 품질은 각각 별도 증거가 필요하다. 한 모델 로딩이나 정적 검사 성공으로 이 항목들을 완료 처리하지 않는다.
