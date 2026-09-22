# Mao 연기·MotionSync 매핑

대상은 고정된 Cubism SDK for Web `5-r.5` 패키지의 **Niziiro Mao**다. 원본 모델·표정·MOC를 수정하지 않고 앱이 별도의 [mao.motionsync3.json](../public/config/mao.motionsync3.json)을 연결한다. Kei 설정 파일을 복사한 것이 아니라, 아래 실제 Mao 파라미터 검사 결과로 새 설정을 작성했다.

## 실제 Core 검사

2026-09-22 공식 Core를 Node VM에서 초기화하고 `Moc.fromArrayBuffer` / `Model.fromMoc` / `model.update()`로 조사했다. Core 런타임 버전은 `0x06000001`(06.00.0001), Mao와 Kei_vowels의 MOC 버전은 `5`(`MocVersion_50`, Cubism 5.0 형식)다. `.model3.json`의 `Version:3`과 구분한다.

| Mao ID | 표시 정보의 이름 | Core 최소 / 최대 / 기본 | 역할 |
| --- | --- | --- | --- |
| `ParamA` | あ | 0 / 1 / 0 | A 계열 모음 입 모양 |
| `ParamI` | い | 0 / 1 / 0 | I 계열 모음 입 모양 |
| `ParamU` | う | 0 / 1 / 0 | U 계열 모음 입 모양 |
| `ParamE` | え | 0 / 1 / 0 | E 계열 모음 입 모양 |
| `ParamO` | お | 0 / 1 / 0 | O 계열 모음 입 모양 |
| `ParamMouthUp` | 上がり口 | 0 / 1 / **1** | 웃는 입, 감정 담당 |
| `ParamMouthDown` | 下がり口 | 0 / 1 / 0 | 처진 입, 감정 담당 |
| `ParamMouthAngry` | むくれ口 | 0 / 1 / 0 | 투정 입 형태, 감정 담당 |
| `ParamMouthAngryLine` | むくれ口線 | 0 / 1 / 0 | 투정 입 선, 감정 담당 |

각 모음 파라미터를 기본값에서 1로 바꾸면 실제 `PartMouth` 메쉬 좌표가 서로 다르게 바뀌는 것을 확인했다. ID 이름만으로 지원을 추정하지 않았다. Mao에는 `ParamMouthOpenY`가 없으며, 원본 LipSync 그룹에는 `ParamA` 하나만 들어 있다. 반면 Kei_vowels에는 **입 개방 `ParamMouthOpenY`와 모음 5개가 모두** 있다. Kei의 입 개방 타깃을 Mao에 가져오면 존재하지 않는 파라미터를 연결하게 된다.

## 새 설정의 원칙

- `Id: OuentoMaoVowelsV1`, `UseCase: Mouth`, `AnalysisType: CRI`로 별도 식별한다.
- `CubismParameters`는 Mao에 실제로 있는 `ParamA/I/U/E/O` 5개만 선언한다. 모두 Core 범위 0~1을 따른다.
- 분석 상태는 `Silence, A, I, U, E, O` 6개다. 각 모음 상태에서 대응하는 타깃은 1, 나머지는 0이다. `Silence`의 다섯 타깃은 전부 0이다.
- `ParamMouthUp/Down/Angry/AngryLine`을 오디오 타깃에 넣지 않는다. 감정 컨트롤러가 별도로 담당한다. 매 프레임 모델 기본 파라미터를 복원하고, 감정·몸짓·물리·오디오 적용 순서를 정해 가산 효과가 누적되지 않게 한다.
- Kei의 분석 Scale(`A=.3, U=1.5, E=6, O=8`)은 복사하지 않았다. Mao의 초기 Scale은 모든 음성 상태에 1이다.
- 초기 튜닝 값은 파라미터 `Damper=0, Smooth=20`, 후처리 `BlendRatio=.35, Smoothing=25, SampleRate=60`이다. 모델 연결을 시험하기 위한 **잠정 제품 값**이며 한국어 발음 자연스러움이 검증된 값이 아니다. `SampleRate`는 분석 갱신 빈도이고 PCM의 48,000Hz와 다른 값이다.

일본어 표기 5모음 변형을 CRI 분석에 연결한 것이며 한국어의 모든 음소/입 형태를 구별해 생성한다는 의미가 아니다. 모델에 없는 변형은 만들지 않는다.

## 표정과 발화 합성

| 앱 감정 | 원본 표정 | 확인한 주요 제어 |
| --- | --- | --- |
| 평온 | `exp_01` | 가산값 0, 눈 개방 곱셈 1; 저장된 기본값으로 복귀 |
| 기쁨 | `exp_02` | 눈 개방 곱셈 0 + 좌우 웃는 눈 가산 1 |
| 슬픔 | `exp_05` | 눈썹 각도/형태 -1, 입 Up -1 / Down +1 |
| 놀람 | `exp_07` | 눈 개방 ×1.2, 눈동자 형태 -1, 눈썹 형태 +1, 입 Down +1 |
| 약한 불만 | `exp_08` | 눈 형태 +1, 입 Up -1 / Angry +1 / AngryLine +1 |

감정 이름은 Ouento가 선택한 매핑이며 원본 파일 이름이 감정 이름인 것은 아니다. 자동 연기에는 `special_*` 마법 모션을 사용하지 않는다.

기쁨의 닫힌 눈은 깜박임보다 우선한다. 다섯 모음은 실제 오디오가 전담한다. 특히 불만 표정의 Angry/AngryLine은 입 선과 모음 변형을 함께 사용하므로 발화 중 합성 강도 완화가 필요할 수 있다. 시청각 비교로 강도를 정하고 음량이나 모음 값을 임의로 감정에 더하지 않는다. 발화 취소·교체·일시정지에는 **다섯 모음 전부**를 0으로 되돌린다. `ParamA`만 닫으면 이전 I/U/E/O 입 모양이 남을 수 있다.

## 작은 고개·상체 몸짓

`none`, `nod`, `tilt`, `smallBounce`, `lookAway`는 모델 전체 위치를 바꾸지 않는다. 끄덕임은 고개 Y, 기울임은 고개 Z와 상체 Z, 작은 리듬은 고개 Y와 상체 Y, 고개 돌림은 고개 X와 상체 X에 적용한다. `smallBounce`는 전신 점프가 아니다.

Mao·Haru·Kei의 실제 Core에서 `ParamAngleX/Y/Z`는 -30~30(기본 0), `ParamBodyAngleX/Y/Z`는 -10~10(기본 0)이었다. 이 축은 세 모델의 물리 출력에 포함되지 않는다. 실제 기본값에서 양·음 방향 범위를 따로 계산하고 최대 30% 이내의 작은 변위를 만든 뒤 최종 범위로 제한한다. 사용자 모델에 없는 축은 건너뛰며 `angleZ`, `bodyAngleY`, `bodyAngleZ`도 수동 연결할 수 있다. 기존 `bodyAngle`은 X축이다.

몸짓의 시계는 반응 시작 시 0에서 시작한다. 1.2~1.6초의 단발 곡선으로 움직이고 추적 강도도 부드럽게 줄였다 복원한다. 말을 오래 하거나 앱이 오래 실행되어도 몸짓이 반복되지 않는다. 고개·상체 입력은 기존대로 물리 계산 전에 적용하며 오디오 입 제어와 독립적이다. Node 실제 Core 검사와 개발용 `tests/browser/gesture-check.html`을 함께 사용하며, 배포 앱의 자연스러움 평가는 따로 기록한다.

## 실제 SDK 분석 검사 결과와 한계

Node 22.15.0에서 실제 Core + Framework R5 + 호환 패치 적용 MotionSync R2를 사용했다. 한국어 표본은 `Kei_vowels/sounds/01_kei_ko.wav`(48kHz, 16bit, stereo, 852,052 프레임)를 두 채널 평균으로 합친 PCM이다. 화면·사용자 음성·외부 AI를 사용하지 않았다.

자산 준비 후 `node scripts/check-models.mjs`로 다시 검사한다. [검사 스크립트](../scripts/check-models.mjs)는 Node VM에서 공식 Core를 실행하고, 기존 Vite의 esbuild로 공식 TypeScript 모듈을 메모리에 번들한다. 배포 앱·SDK 파일을 수정하거나 마이크를 활성화하지 않는다.

| 모델 | Core 정합성·생성 | MOC 형식 | 파라미터 / Drawable 수 |
| --- | --- | --- | --- |
| Mao | 통과 | 5 (`MocVersion_50`) | 132 / 262 |
| Haru | 통과 | 1 (`MocVersion_30`) | 42 / 84 |
| Kei_vowels | 통과 | 5 (`MocVersion_50`) | 31 / 60 |

- 새 설정의 다섯 ID가 실제 Mao 인덱스 `23, 24, 25, 26, 27`에 모두 연결됐다.
- CRI 분석기가 요구하는 단위는 488 PCM 샘플이었다. 진단에서는 그 배수인 1,952샘플씩 분석했다.
- 한국어 표본 분석 중 최대값은 소수 여섯 자리에서 A `.999959`, I `1.000000`, U `.978422`, E `.989362`, O `.954762`였다. 관찰된 `NaN` 및 0~1 범위 위반은 0건이었다.
- 분석 후 무음 PCM을 공급했을 때 다섯 모음 모두 0으로 복귀했다.

이 결과는 **실제 분석 연결과 수치 범위**만 입증한다. 브라우저/WebView의 음성 출력 시계와 동기화, 감정 중 입 모양 자연스러움, 지연, 장시간 드리프트는 별도 검증 대상이다. 시각·청각 품질을 이 검사로 완료 처리하지 않는다.

위 검사는 SDK 직접 연결 진단이다. 제품의 `MotionSyncDriver`가 불규칙 PCM 조각을 잃지 않고 처리하는지는 별도 [MotionSync 통합 검사](motion-sync-verification.md)와 `node scripts/check-motion-sync.mjs`로 확인한다.

통합 시 주의할 SDK 계약:

1. `CubismMotionSync.startUp(new MotionSyncOption())`에 옵션 객체를 넘긴다. R2에서 인수를 생략하면 모델 생성 중 `s_option.engineConfig`의 null 접근이 발생하는 것을 재현했다.
2. 분석기가 소비하지 않은 488샘플 미만의 PCM을 프레임마다 버리지 않는다. Web Audio 재생 위치에 따라 연속 버퍼를 공급하고 실제 소비 인덱스로 남은 부분을 유지한다.
3. 음성·자막·립싱크는 동일 발화 ID를 사용한다. 늦은 결과를 버리고, 무음에는 입을 닫되 재생 시간은 유지한다. 취소 후에도 기본 깜박임·호흡은 계속한다.

## 흰 사각형 원인 조사

Mao의 `HitAreaHead`와 `HitAreaBody`는 `PartCore` 소속, 기본 opacity 1인 4개 정점 메쉬다. UV는 텍스처의 `(4,4)` 부근을 가리키며, 해당 PNG 원본 픽셀은 **RGBA(255,255,255,0)**였다. 투명 흰 픽셀은 정상적인 모델 자산이다.

`createImageBitmap(..., {premultiplyAlpha:'none'})`로 만든 이미지를 premultiplied-alpha 렌더러에 넣으면 RGB가 흰색인 채 남는다. `UNPACK_PREMULTIPLY_ALPHA_WEBGL`은 ImageBitmap 입력에는 적용되지 않으므로 이미지 생성 시 `premultiplyAlpha:'premultiply'`를 지정해야 한다. [Khronos WebGL의 ImageBitmap 픽셀 저장 규칙](https://registry.khronos.org/webgl/specs/latest/1.0/#PIXEL_STORAGE_PARAMETERS)

따라서 HitArea를 지우거나 PartCore를 숨겨 문제를 덮지 않고 텍스처 업로드의 알파 계약을 맞춘다. 실제 수정 후 브라우저·양 OS 배포 앱에서 얼굴, 머리카락 가장자리, 투명 여백을 다시 확인한다.
