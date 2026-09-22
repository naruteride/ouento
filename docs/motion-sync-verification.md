# MotionSync 입력·취소 검증

2026-09-22, macOS 26.6.2 arm64에서 실제로 고정한 Cubism Core/Framework와 MotionSync Core/R2 플러그인을 사용했다. `src/character/motion-sync.ts`를 그대로 번들하여 공개 한국어 음원을 분석했다. mock 분석기나 텍스트 길이 기반 입 움직임을 사용하지 않았다.

```sh
npm run assets:setup -- --offline
npm run check
node scripts/check-motion-sync.mjs
```

SDK 자산과 `public/config/mao.motionsync3.json`이 준비되어 있어야 한다. 스크립트는 저장된 공개 표본만 읽으며 마이크·화면·외부 AI·네트워크를 사용하지 않는다. 검사 실패 시 종료 코드 1을 반환한다.

## 수정 사항

- R2 `InitializeEngineCri`가 `s_option.engineConfig`를 읽으므로 `CubismMotionSync.startUp(new MotionSyncOption())`로 초기화한다.
- 매 프레임 전달한 PCM 전체를 버리지 않는다. 설정별로 `getLastTotalProcessedCount(index)`만 제거하고 미처리 꼬리를 다음 프레임에 보존한다. 특정 모델에서 관측한 488을 전역 상수로 고정하지 않는다.
- 분석 시간은 실제 PCM 수 / 48,000으로 계산한다. 렌더 프레임 시간과 따로 누적한다.
- Core 스크립트 로딩 전·후 `isCurrent()`를 검사한다. 모델을 해제한 뒤 완료되는 로딩은 `AbortError`로 종료하며 모델에 접근하지 않는다. 이후 push/apply/reset도 동일 수명 조건을 검사한다.
- reset은 새 음성이 들어오지 않은 상태에서 반복 호출해도 분석 컨텍스트를 다시 만들지 않는다. dispose는 여러 번 호출할 수 있고 이후 호출은 무시한다.
- 분석 대기 PCM이 2초를 넘으면 오래된 입력을 재생하지 않도록 분석기를 초기화하고 최신 100ms만 받는다. 정상 프레임의 작은 잔여 샘플을 버리는 처리와 구분한다. 이 수치는 분석기 방어 한도이며 측정된 지연 성능이 아니다.

## 실행 결과

입력은 SDK의 `Kei_vowels/sounds/01_kei_ko.wav`다. PCM 48kHz, 16bit, 2채널을 평균하여 852,052개의 mono sample을 전달했다. 전달 구간은 137 / 2,048 / 511 / 800 / 7 / 1,600 sample을 반복해 분석 블록과 렌더 구간이 일치하지 않는 상황을 재현했다.

| 검증 | Kei_vowels | Mao 전용 설정 |
| --- | --- | --- |
| Core MOC 정합성 | 통과 | 통과 |
| 실제 최초 분석 요구량 | 488 sample | 488 sample |
| 총 PCM 입력 | 852,052 | 852,052 |
| 음원 끝까지 처리한 PCM | 852,008 | 852,008 |
| 다음 입력을 기다리는 잔여 PCM | 44 | 44 |
| 처리량 + 잔여량 = 입력량 | 모든 프레임에서 통과 | 모든 프레임에서 통과 |
| 관측 최대 대기량 | 984 sample | 984 sample |
| 입 파라미터 유한 값·범위 | 통과 | 통과 |
| 1초 무음 이후 입 값 | 모든 연결값 0 | A/I/U/E/O 모두 0 |
| 반복 reset/dispose | 통과 | 통과 |
| 해제 후 분석 컨텍스트 | 0개 | 0개 |

Mao의 A/I/U/E/O 최고값은 각각 약 1.000 / 1.000 / 0.993 / 0.986 / 0.979였다. 파라미터가 실제 PCM에 따라 변하고 무음에서 0으로 돌아오는 것을 확인한 값이며, 발음별 시각 품질 평가 점수가 아니다.

Core 스크립트 로딩 중 취소한 뒤 이미 해제된 모델을 대신하는 접근 금지 객체를 전달한 별도 검사도 통과했다. 로딩이 완료되어도 모델 객체를 읽지 않았다.

## 남은 확인

이 검사는 브라우저 오디오 재생을 수행하지 않는다. 실제 Web Audio 시계와 WebKit/WebView2 배포 앱에서의 시작·종료·중단·장기 동기화, Mao 감정과 입 형태의 합성, 청각·시각의 자연스러움은 별도로 검증해야 한다. 공식 음원의 분석 성공으로 두 OS 립싱크 품질이나 사용자 알파 완료를 주장하지 않는다.
