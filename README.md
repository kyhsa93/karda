# 카르다 전선

https://kyhsa93.github.io/karda/

봇과 함께 싸우는 점령전. 연합군과 베로스 인민군(VPA)이 카르다 계곡의 거점을 놓고 싸우고, 플레이어는 진영을 골라 보병 또는 탈것으로 출격한다. 전선의 흐름은 봇이 만들지만, 어느 거점이 넘어가는지는 플레이어가 바꾼다. 브라우저에서 돌고(three.js), 서버 없이 혼자 한다.

지금 되는 것: 빠른 점령전(거점 3곳), 보병 돌격병, 공격 헬기(연합군만, VPA 헬기는 준비 중), 양 진영 선택, 티켓 리스폰. 조작은 출격 화면의 조작 카드에 있다(키보드·게임패드·터치). 앞으로의 계획은 [위키](https://github.com/kyhsa93/karda/wiki)의 [비전과 방향](https://github.com/kyhsa93/karda/wiki/비전과-방향)과 [로드맵](https://github.com/kyhsa93/karda/wiki/10-로드맵).

## 앱으로 설치 (PWA)

> 2026-10-03에 주소가 `/heli-game/`에서 `/karda/`로 바뀌었다. 옛 주소는 새 주소로 넘어가지만, 옛 주소로 홈 화면에 설치한 앱은 새 주소에서 다시 설치해야 한다.

브라우저 메뉴의 "앱 설치" 또는 "홈 화면에 추가"로 설치하면 전체 화면으로 실행된다. 서비스 워커는 아무것도 캐시하지 않고 모든 요청을 `cache: 'no-store'`로 네트워크에서 새로 받으므로, 앱을 열 때마다 항상 최신 버전이 뜬다(오프라인에서는 실행되지 않는다).

## 개발

기획은 위키(전장)와 [docs/design/](docs/design/README.md)(엔진·기술 구조)에 있다. 개발 에이전트는 루트의 [CLAUDE.md](CLAUDE.md)부터 읽는다.

React + TypeScript + Vite. `main`에 push하면 GitHub Actions가 테스트·빌드 후 Pages에 배포한다.

```sh
npm install
npm run dev     # 개발 서버
npm run check   # 타입체크 + 테스트 + 빌드
```

- `src/sim/` — 게임 규칙(렌더·DOM·React 없음, 월드 RNG로 결정론): 월드(`world.ts`), 지형(`terrain.ts`), 헬기 비행·계통(`heli/`), 보병(`infantry/`), 점령전·봇 지휘(`battle/`), 무장(`weapons/`)·센서(`sensors/`)·봇 AI(`ai/`)
- `src/render/` — three.js 장면(`scene.ts`)·렌더 루프(`renderer.ts`), 아파치 기체(`heliModel.ts`)·조종석과 MPD·EUFD·예비 계기(`cockpit/`), 헬멧 심볼(`ihadss.ts`), 깃발·병사·보병 뷰모델(`battle/`)
- `src/ui/` — 화면(`screens/`)·출격 화면과 전장 HUD(`battle/`)·터치 스틱(`components/`) React 컴포넌트
- `src/input/` 입력 바인딩(키보드·게임패드·터치), `src/audio/` 로터·효과음 합성, `src/content/` 수치·문자열 JSON과 전장 지도(`battle/`)
