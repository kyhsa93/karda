# 에셋 가공 스크립트

외부 에셋은 원본을 저장소에 넣지 않고, 이 스크립트로 가공한 결과만 `public/assets/`에 넣는다(`docs/design/10-external-assets.md` 10.8절). 스크립트는 빌드에 포함되지 않는다.

| 스크립트 | 용도 | 필요한 도구 |
| --- | --- | --- |
| `node scripts/encode-audio.mjs in.wav out.mp3 --kbps 64 [--start 3 --duration 4 --fade 0.02 --fade-out 0.3]` | 모노 MP3로 인코딩·자르기 | 시스템 `ffmpeg`, 없으면 `ffmpeg-static@5.3.0`을 `~/.cache/karda-tools`(환경변수 `HELI_TOOLS`로 변경 가능)에 자동 설치 |
| `node scripts/process-glb.mjs in.glb out.glb --texture-size 256 [--simplify 0.3] [--static]` | meshopt 압축, 텍스처 WebP·축소, 선택적 폴리곤 감소(비율), `--static`은 애니메이션·스킨 제거(정지 인스턴스용) | `@gltf-transform/cli@4.5.1`을 같은 캐시에 자동 설치 |
| `node scripts/subset-font.mjs in.ttf out.woff2 --strings` (굵기마다 한 번씩, 출력은 `.woff2`만) | 실제 쓰는 글자(`src/content/**/*.json` + ASCII)만 남긴 woff2 | `pyftsubset` (`pip install --user fonttools brotli`) |
| `node scripts/subset-font.mjs in.ttf out.woff2 --ascii --extra "°"` | 영문·숫자 계기 글꼴 | 위와 같음 |

가공한 파일을 넣으면 `public/assets/CREDITS.md`에 한 줄 추가하고 `src/assets/manifest.ts`에 등록한다. `npm test`가 출처 누락·라이선스·확인 날짜·첫 로드 용량(600KB)을 검사한다.

문자열이 바뀌면 한글 폰트 서브셋을 다시 만든다.

## 전장 도구 (TypeScript, 빌드 미포함)

`scripts/*.ts`는 `src/`의 sim 코드를 그대로 불러 쓰는 헤드리스 도구다. Node의 타입 제거 실행(`--experimental-transform-types`)과 `scripts/lib/ts.mjs`(확장자 없는 import·JSON import 해석)로 돌린다.

| 명령 | 용도 |
| --- | --- |
| `npm run battle:map -- --map harek` | 맵 파일 검증 + 배치 원칙(위키 06장 6.2) 점검 결과 출력 |
| `npm run battle:map -- --map harek --search --from 1 --tries 400 --write` | 원칙 1·4·7·9·13을 만족하는 지형 시드를 찾아 맵 파일에 기록 |
| `npm run battle:map -- --map harek --png out.png` | 위에서 본 지형도(음영·물·숲·도로·교량·거점·본진·헬기 BP·빠른 점령전 구역)를 PNG로 |
| `npm run battle:bench -- --mode quick --minutes 10` | 봇끼리 전투의 프레임·틱 시간 |
| `npm run battle:harness -- --side coalition --player idle\|proxy\|soldier [--stance cover\|exposed] [--level 0..3] [--aim-error mrad] --seeds 20 [--set tickets=250] [--set strength.player=0.6] [--trace] [--json]` | 여러 시드 경기 결과표(길이·승률·거점 소유 변경·대리 기여, 보병 대리는 적 거점 안 시간·첫 진입 시각·전진 중 정지 시간) |
| `npm run battle:roles -- [--seeds 100] [--jobs 7] [--sides coalition,veros] [--roles idle,soldier,proxy] [--aim-error mrad] [--level 0,1,2,3] [--paired] [--set k.sub=v] [--check]` | 역할 영향력 표(#193): 역할마다 승률과 95% 구간, 무입력 대비 차이, **기둥 P0 띠 판정**(역할 − idle ≥ 20pp, 역할 < 95%, 역할 간 ≤ 25pp; 구간으로 판정해 시드가 모자라면 '판정 불가'), 보병 대리의 거점 진입·`firstEntrySec`·`firstContactSec`, 마지막 3분 소유 변경 수. 시드를 여러 프로세스로 나눠 하니스를 `--json`으로 돌린다. `proxy`(공격 헬기)도 플레이어 조종·무기 경로로 날고 쏘며 P0 판정을 받는다(#198, `--aim-error`로 조준을 흐리면 승률이 떨어진다). `--level`은 보병 대리(`soldier`)를 실력 단계 L0~L3(조준 오차 100/30/10/3 mrad · 반응 0.8/0.5/0.3/0.15 s · 스캔 1.0/0.5/0.25/0.1 s)마다 한 행씩 돌리고 단계 간 단조성(`levels monotone`)을 판정한다. `--paired`는 같은 시드의 역할·idle 결과를 짝지어 판정하고(표시용·플레이어 RNG를 sim RNG에서 뗀 뒤라 가능, #199) 독립 표본과 같은 판정에 필요한 시드 수(10시드 단위로 앞에서부터)를 나란히 보인다 |
