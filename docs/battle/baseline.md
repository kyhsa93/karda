# 전장 작업 기준선 (B1-1)

제거 커밋 `439ab27`(2026-09-30) 기준. 전장 로드맵(위키 `10-로드맵`)의 모든 작업은 아래 회귀 기준을 깨지 않아야 한다.

## 빌드 크기

`vite build` gzip 기준.

| 산출물 | 제거 전 `def4383` | 제거 후 `439ab27` | 차이 |
| --- | --- | --- | --- |
| 첫 JS 번들(`index`) | 206.2 KB | 128.5 KB | −77.7 KB |
| 비행 청크(`Flight`) | 132.4 KB | 없음(화면 미연결) | −132.4 KB |
| `GLTFLoader` | 13.2 KB | 13.5 KB | +0.3 KB |
| `BufferGeometryUtils` | 1.4 KB | 없음 | −1.4 KB |
| `meshopt_decoder` | 7.3 KB | 7.3 KB | 0 |
| CSS | 3.5 KB | 3.5 KB | 0 |
| **JS 합계** | **360.5 KB** | **149.2 KB** | **−211.3 KB** |

- 비행 셸이 다시 연결되면(B1-12) 비행 청크가 돌아온다. 캠페인 콘텐츠가 빠진 만큼 제거 전보다 작아야 한다.
- 첫 번들 128.5 KB에는 `assets/loader`가 끌고 오는 three 일부가 들어 있다(타이틀 화면이 로딩 화면을 쓰기 때문).
- `public/assets`: 오디오 240 KB · 모델 372 KB · 텍스처 212 KB · 글꼴 108 KB(한국어 서브셋 두 벌 각 약 47 KB).

## 테스트

| | 제거 전 | 제거 후 |
| --- | --- | --- |
| 테스트 파일 | 61 | 50 |
| 테스트 | 471 | 325 |

## 회귀 기준

모든 전장 작업에서 통과해야 하는 테스트. 전장 코드가 이 파일들을 고쳐야 한다면 커밋 메시지에 이유를 쓴다.

1. **아파치 계통** — 비행·계통·피해·로드아웃·자동 호버·무장·센서
   - `src/sim/sim.test.ts`(비행 모델·결정론)
   - `src/sim/heli/damage.test.ts`, `src/sim/heli/loadout.test.ts`
   - `src/sim/weapons/{ballistics,gun,rockets,hellfire,stinger,enemyMissile,damage}.test.ts`
   - `src/sim/sensors/{tads,fcr,laser,ase}.test.ts`
   - `src/sim/farp.test.ts`, `src/sim/difficulty.test.ts`
2. **적 AI(대 플레이어)** — `src/sim/ai/{awareness,brain,air,airDefense,movement,searchlight,lethality}.test.ts`
3. **지형·가시선·유닛** — `src/sim/{terrain,los,units}.test.ts`
4. **PWA 무캐시** — `src/sw.test.ts`
5. **구조 규칙** — `src/arch.test.ts`
6. **전장 결정론** — B1-2부터 추가(같은 시드 → 같은 결과 해시)

## 위키 9.0 대비 확인한 사실

- 9.0 모듈 표의 제거·남음 목록은 코드와 일치한다.
- `world.player`를 직접 읽는 적 AI는 `sim/ai/awareness.ts`·`brain.ts`·`air.ts`·`searchlight.ts`다. `sim/weapons/enemyMissile.ts`는 표적 위치·속도를 인자로 받으므로 B1-7(`PlayerBody`)의 교체 대상이 아니다. 플레이어 무장(`rockets`·`hellfire`·`ballistics`)은 헬기 아바타 전용이라 그대로 둔다.
- `sim/objective.ts`의 `Objective` 인터페이스(`start`·`tick`·`onEvent`)는 남아 있고 구현체는 없다. `BattleRuntime`이 첫 구현이 된다.

## 규모 측정 v1 (B1-14)

`npm run battle:bench -- --map harek --mode quick --minutes 10` — 플레이어 없이(배치 화면 대기) 봇끼리 10분, 첫 5초는 제외. node 24, 이 개발 머신 기준.

| 측정 (ms) | 평균 | p99 | 최악 | 예산 |
| --- | --- | --- | --- | --- |
| sim 한 프레임(60fps = 스텝 2번) | 0.066 | 0.340 | 1.985 | 평균 ≤ 1 |
| 전장 10Hz 틱(표적·사격) | 0.110 | 0.288 | 1.291 | 최악 ≤ 2 |
| 전장 1Hz 틱(점령·스폰·지휘) | 0.095 | 0.561 | 1.401 | 최악 ≤ 2 |

- 유닛: 목록 최대 40, 살아 있는 최대 37, 잔해 은퇴 3. 잔해는 죽은 지 90초 뒤 `world.units`에서 빠진다(`world.retireAfter`, 전장만 켬). 유닛 500개를 만들고 죽여도 목록은 150을 넘지 않는다(`retire.test.ts`).
- 참고로 점령전(대규모 편제, B5 대상)은 같은 조건에서 프레임 평균 0.165, 1Hz 틱 최악 **3.6ms** — 지휘관의 효용 계산(소대 × 거점 × 유닛)과 도로 A*가 한 틱에 몰린다. B5-7에서 줄일 것.

## 하니스 v1 · 1차 밸런스 (B1-15)

`npm run battle:harness -- --map harek --mode quick --side coalition|veros --player idle|proxy --seeds 20` (`--set 키=값`으로 경기 방식 수치를 덮어써 비교, `--trace`로 분 단위 추이). `proxy`는 플레이어 아파치를 `sim/battle/proxy.ts`의 조종사가 실제로 몬다(#198): 조종 입력(`world.controls`)으로 날고, 레이저·무기 선택·발사 입력으로 기관포·로켓·헬파이어를 플레이어 무기 경로로 쏜다(탄도·잠금·레이저 조건 그대로, 처치는 `byPlayer`). 탄약이 떨어지면 본진 패드에 착륙해 재보급한다. `--aim-error <mrad>`는 조준 오차를 더해 낙제 시험(명중률↓ → 승률↓)에 쓴다.

| 20시드 | 한 판 중앙값 | 플레이어 진영 승률 | 소유 변경 A / D / G |
| --- | --- | --- | --- |
| 연합 · idle | 12.0분 | 30% | 0 / 20 / 0 |
| 연합 · proxy | 10.6분 | 100% (대리 처치 17.0 / 사망 0.0) | 0 / 20 / 3 |
| VPA · idle | 11.8분 | 40% | 0 / 20 / 2 |
| VPA · proxy | 10.9분 | 100% (대리 처치 15.3 / 사망 0.1) | 4 / 20 / 0 |

- 목표: 중앙값 8~12분 ✓, idle 30~50% ✓, proxy ≥ 60% ✓(**폐기**: 봇 통계 사격이라 실패할 수 없는 기준이었다 — 아래 '역할 영향력'의 P0 띠로 교체, 결정 O3), "80% 시드에서 거점마다 소유 변경" ✗ → #179.
- 바꾼 수치: 빠른 점령전 티켓 300 → **200**, 출혈 0.1 → **0.3/초·거점**(점령전은 그대로, B5에서). 봇 대 봇 살상 배율 `botLethality`(1)는 올려도 처치 수가 거의 안 늘었다 — 교전 기회가 병목이었다.
- 대리 헬기는 거의 죽지 않는다(봇 방공은 통계 사격, 진영당 대공조 1·방공 차량 1). 실제 플레이어는 봇이 진짜 탄·미사일을 쏘는 기존 경로라 다르다.

## 하니스 v2 · 보병 대리 (B2-16)

`--player soldier [--stance cover|exposed]`: 실제 플레이어 보병을 `soldierCommands`로 조종한다(`sim/battle/soldierProxy.ts`). 가장 가까운 비소유 거점을 점령할 때까지 목표로 고정하고, 거점 영역 +1km 상자 안 4m 격자 흐름장(`sim/battle/footpath.ts`, 실제 이동과 같은 규칙 — 오르막 도착점 법선 32°·깊은 물 제외)을 따라 걷는다. 시야가 완전히 트인 적 분대가 300m 안에 있으면 조준 사격(탄 낙차 보정·점사). `cover`는 거점 500m 안·피격 뒤 15초 동안 앉아서 이동하고, 교전 때는 엄폐물(소품·나무) 뒤에서 앉고, 맞으면 4초 동안 사격자 반대편 엄폐물로 가거나 엎드린다. `exposed`는 늘 서서 뛴다. 배치는 목표에 가장 가까운 스폰, 본진밖에 없으면(2km 넘게) 30초까지 기다린다.

| 연합 · 20시드 | 한 판 중앙값 | 승률 | 대리 처치 / 사망 | 사망당 생존 |
| --- | --- | --- | --- | --- |
| idle | 12.1분 | 50% | — | — |
| soldier · cover | 12.0분 | 40% | 0.2 / 2.8 | 433초 |
| soldier · exposed | 12.6분 | 35% | 0.3 / 6.3 | 195초 |
| proxy(아파치) | 10.5분 | 100% | 14.4 / 0.0 | — |

- 목표: 엄폐 대 노출 생존 ≥ 2배 ✓(2.2배), 한 판 8~12분 ✓(cover 12.0분), soldier 대리 승률 ≥ 55% ✗ → #186.
- 대리가 받은 피해의 약 70%는 적 장갑차 30mm, 거의 전부 이동 중. 거점 D 둘레 평탄화 경계의 3m 단(보병 통행 불가, 봇은 경사 무시) → #187.

## 빠른 점령전 거점 기준 재정의 (#179, 소유자 결정 A11)

빠른 점령전(3거점) 기준: **가운데 거점 소유 변경 ≥ 80% 시드**, **승부가 난 시드 중 지는 쪽 시작 거점 함락 ≥ 30%**. 원래 기준(모든 거점 80%)은 B5 점령전(7거점)에서 잰다. 하니스 표에 두 줄을 더했다.

- 원인: 시작 거점 공격 때 소대 보병은 1~3km 뒤에서 걸어오고(속도 5m/s) 차량만 먼저 도착해 원 밖 지원 위치(약 230m)에 서 있었다 — 방어가 0명인데도 점령이 반에서 멈췄다. 지휘관 공세 가산점(효용 +0.6~2)과 전방 한 거점 스폰은 효과가 없었다.
- 바꾼 것: 소대 보병이 1km 안에 없고 적 병력이 0인 거점이면 **차량이 직접 원 안으로** 들어간다(`platoon.ts`). 빠른 점령전 티켓 200 → **180**(차량 점령으로 역전이 늘어 길어진 경기를 되돌림).

| 20시드 · 티켓 180 | 중앙값 | 플레이어 진영 승률 | 가운데 변경 | 지는 쪽 시작 거점 함락 |
| --- | --- | --- | --- | --- |
| 연합 · idle | 12.0분 | 30% | 100% | 30% |
| 연합 · proxy | 9.7분 | 100% | 100% | 30% |
| VPA · idle | 12.2분 | 40% | 100% | 40% |
| VPA · proxy | 9.3분 | 100% | 100% | 70% |

티켓 200이면 길이 12.6·13.1분, 170이면 연합 idle 25%로 띠를 벗어났다.

## 경로별 번들 (B1-16, 갱신 #194)

`npm run check`/`npm run build` 끝에 `scripts/bundle-report.mjs`가 경로별 JS gzip 합계를 출력하고, A1 예산을 넘으면 **실패한다**(#194부터 강제, 그 전엔 경고만이라 넘어도 아무것도 막지 않았다). vite `build.manifest`의 import 그래프로 계산한다.

| 경로 | JS gzip (2026-10-03) | 예산(A1) |
| --- | --- | --- |
| 첫 번들(타이틀·설정·전장 설정) | 144.4 KB | 210 KB |
| 전장 첫 출격(비행 셸·전장 코드·하레크·GLTF) | 348.8 KB | 400 KB |
| 모든 청크 | 348.8 KB | 440 KB |

## 에셋 그룹 (#194)

PWA가 아무것도 캐시하지 않으므로(`sw.js` no-store) 매 실행이 전부 다운로드다.

| 그룹 | 언제 받나 | 크기 (2026-10-03) | 예산 |
| --- | --- | --- | --- |
| `boot` | 타이틀 전 | 409.6 KB (이전 578.7) | 600 KB (`BOOT_BUDGET_BYTES`) |
| `heli` | 헬기를 고르거나 헬기에 탔을 때 | 169.1 KB (아파치 로터·시동·로켓·헬파이어 소리) | 경기당 합계에 포함 |
| `units` | 경기 시작 | 136.5 KB (이전 235.1) | 경기당 `units`+`farp`+`heli` ≤ 1 MB (`MISSION_BUDGET_BYTES`) |
| `farp` | 경기 시작 | 110.7 KB | 위와 같음 |
| `reserve` | 아무것도 부르지 않음 | 98.5 KB (`soldier`·`civ_car`·`fuel_truck` — 크레딧 보존용) | — |

`credits.test.ts`가 지킨다: 헬기 전용 소리는 boot에 없을 것, `units` 그룹의 모델은 로스터 유닛(보병은 코드 인형이라 제외)이 그려지는 모델일 것, 경기당 합계 예산.

제거 직후(128.5 KB) 대비 첫 번들 +15 KB는 전장 설정 화면과 문자열이다.

## 역할 영향력 (#193, 2026-10-03)

`npm run battle:roles -- --seeds 100` — 기둥 P0 띠를 역할마다 95% 구간으로 판정한다. #187(경사 규칙 하나)·#192(전방 집결지) 뒤의 값이다. 7 프로세스로 21분.

### harek quick · 100 seeds a cell · P0 band: role − idle ≥ 20pp, role < 95%, roles within 25pp (95% intervals)

| side | role | wins | 95% interval | − idle | verdict | entered a point | firstEntrySec | firstContactSec | flips in last 3 min | kills / deaths |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| coalition | idle | 39/100 (39%) | 30%–49% |  | — |  |  |  | 1.31 |  |
| coalition | soldier | 51/100 (51%) | 41%–61% | 12pp | **undecided** — beats idle by -2-25pp — more seeds | 40/100 | 201 | 349 | 0.95 | 0.9 / 6.0 |
| coalition | proxy | 98/100 (98%) | 93%–99% | 59pp | upper bound, not judged |  |  |  | 1.45 | 14.0 / 0.0 |
| coalition | (spread) | | | | **undecided** — one judged role | | | | | |
| veros | idle | 50/100 (50%) | 40%–60% |  | — |  |  |  | 1.74 |  |
| veros | soldier | 58/100 (58%) | 48%–67% | 8pp | **undecided** — beats idle by -6-21pp — more seeds | 65/100 | 209 | 451 | 1.43 | 0.8 / 6.5 |
| veros | proxy | 99/100 (99%) | 95%–100% | 49pp | upper bound, not judged |  |  |  | 1.70 | 13.7 / 0.0 |
| veros | (spread) | | | | **undecided** — one judged role | | | | | |

- `proxy`: attack helicopter played by a bot that hits with the bots' statistical fire (vsUnits), not the player's weapons — an upper bound, not judged.

600 matches in 1264 s on 7 processes.

- 보병이 처음으로 무입력보다 높게 나왔다(연합 +12pp, VPA +8pp). 그러나 구간 위 끝이 25pp·21pp로 띠(20pp)에 걸쳐 있어 아직 **판정 불가**다 — 통과로 볼 근거도, 실패로 볼 근거도 없다.
- 공격 헬기 행은 이 시점엔 상한이었다(#198에서 실제 무기 경로로 옮겼다 — 아래). 역할 수치는 이 표가 판정을 낼 때까지 바꾸지 않는다(O11).

### 공격 헬기를 실제 무기 경로로(#198)

`proxy`가 봇 통계 사격이 아니라 플레이어 헬기를 직접 몬다(`sim/battle/proxy.ts`: 조종 입력으로 비행, 레이저·기관포·로켓·헬파이어를 플레이어 경로로 발사, 처치는 `byPlayer`). 위 표의 `proxy` 행(98%/99%)은 옛 상한값이고, 같은 100시드 두 진영을 다시 돌린 값은 다음과 같다(`battle:roles --seeds 100`, 14분 24초).

| side | role | wins | 95% interval | − idle | verdict | kills / deaths |
| --- | --- | --- | --- | --- | --- | --- |
| coalition | proxy | 60/100 (60%) | 50%–69% | 21pp | **undecided** — beats idle by 7-34pp — more seeds | 2.0 / 1.6 |
| veros | proxy | 75/100 (75%) | 66%–82% | 25pp | **undecided** — beats idle by 12-37pp — more seeds | 2.5 / 1.5 |
| veros | (spread) | | | | **undecided** — roles differ by up to 29pp — more seeds | |

낙제 시험(`--aim-error`, 조준에 ±mrad 흔들림, 같은 100시드): 0 mrad 60%/75% → 30 mrad 39%/50% → 100 mrad 44%/53% (연합/VPA). 처치는 2.0 → 0.1 → 0.0으로 떨어지고 승률은 무입력(39%/50%) 수준으로 내려간다. 옛 대리는 명중률을 1/4로 낮춰도 70%였다.

판정은 아직 '판정 불가'다(구간이 띠에 걸침, 시드 더 필요). 통과·실패 근거는 아직 없다.

### 자동 집중 거점 A/B (#197, 결정 O10 — 제거)

플레이어가 거점 300m 안에 있으면 그 거점을 아군 지휘관의 집중 거점(효용 +0.8)으로, 90초 쿨다운. `battle:roles --roles soldier`, 100시드씩, 같은 시드:

| 진영 | 끔 | 켬 |
| --- | --- | --- |
| 연합 | 51% (41–61%) · 진입 40/100 | 50% (40–60%) · 진입 42/100 |
| VPA | 58% (48–67%) · 진입 65/100 | 53% (43–62%) · 진입 66/100 |

효과가 없다(오히려 VPA −5pp, 구간 안). O10의 조건("효과 미달이면 제거")대로 넣지 않았다. 지휘관 효용 +0.8은 소대가 이미 향하던 거점과 거의 같아 바뀌는 명령이 적었던 것으로 보인다(추정). B5-5의 수동 지정은 원안대로 남는다.

