# Vendor Finder

노션의 [견적서 & 구매 업체 모음](https://www.notion.so/ohouse/295a597878a08044aa2fd4cfc0e8e474) 페이지에 있는 두 데이터베이스(`제작물 견적서 모음`, `구매 업체`)를 그대로 가져와 필터링/검색할 수 있는 정적 페이지입니다.

## 동작 모드

| 모드 | 설명 |
|---|---|
| **LIVE** | `node server.js` 실행 + `NOTION_TOKEN` 설정 시. 30초마다 노션 폴링, 노션에서 행을 추가/수정하면 다음 사이클에 자동 반영. |
| **SNAPSHOT** | 서버는 켜져 있지만 토큰이 없거나, HTML을 그냥 더블클릭해서 연 경우. `vendors.json`의 정적 스냅샷을 사용. |
| **OFFLINE** | 둘 다 실패. 우상단 인디케이터가 빨간색으로 표시됨. |

화면 우상단 결과 헤더의 점이 LIVE/SNAPSHOT/OFFLINE 상태와 마지막 동기화 시각을 보여줍니다.

## 빠른 시작 (스냅샷만)

```bash
open vendor-finder-v2.html
```

…만 해도 26건이 다 보입니다. 노션 동기화는 아래 단계를 따라주세요.

## 실시간 노션 동기화 설정

### 1. Notion 통합(Internal Integration) 만들기

1. https://www.notion.so/profile/integrations 접속
2. **+ New integration** → 이름 입력 (예: `Vendor Finder Sync`) → workspace 선택
3. **Internal** 타입으로 생성
4. **Internal Integration Token** (`secret_…`) 복사

### 2. 노션에서 두 데이터베이스에 통합 권한 부여

각 DB(`제작물 견적서 모음`, `구매 업체`)를 열고 우상단 `…` → **Connections** → 방금 만든 통합 선택.
또는 두 DB를 모두 포함하는 상위 페이지([견적서 & 구매 업체 모음](https://www.notion.so/ohouse/295a597878a08044aa2fd4cfc0e8e474))에 한 번만 연결해도 됩니다 — 자식 DB까지 자동 상속됩니다.

### 3. 환경 변수

```bash
cp .env.example .env
# .env 파일을 열고 NOTION_TOKEN 에 secret_… 토큰 붙여넣기
```

DB ID는 기본값이 현재 워크스페이스 기준으로 채워져 있으니 그대로 두면 됩니다.

### 4. 의존성 설치 & 실행

```bash
npm install
npm start          # → http://localhost:5173
# 또는 파일 변경 시 자동 재시작:
npm run dev
```

브라우저에서 http://localhost:5173 열면 우상단에 **🟢 LIVE · HH:MM:SS** 가 뜹니다. 노션에서 행을 추가/수정하면 최대 **30초 + 15초 캐시** 안에 화면에 반영됩니다.

## 파일 구조

```
견적서/
├─ vendor-finder-v2.html   메인 UI (디자인 + fetch + 폴링)
├─ vendor-finder.html      v1 (디자인 워싱 전 원본)
├─ vendors.json            노션 스냅샷 (26건)
├─ server.js               Node HTTP 서버 (Notion API 프록시)
├─ package.json
├─ .env.example
└─ README.md
```

## API

`GET /api/vendors` → 다음 형태의 JSON 반환:

```json
{
  "generatedAt": "2026-04-10T01:23:45.000Z",
  "source": "live",
  "counts": { "estimates": 25, "vendors": 1 },
  "vendors": [
    {
      "id": "295a597878a080418a23e1d4aba44fa5",
      "name": "이토스",
      "status": "green",
      "type": ["제작"],
      "cat": ["인쇄물"],
      "price": 5940000,
      "duration": "약 2주",
      "leadDays": 14,
      "note": "100장씩, 600통",
      "project": "오늘의집 리브랜딩_명함",
      "url": "https://www.notion.so/...",
      "source": "estimates",
      "lastEdited": "2025-11-21T02:16:00.000Z"
    }
  ]
}
```

`status` 매핑 규칙:
- `green` — 업체명에 🟢 가 붙어 있음 (추천 / 진행 중)
- `orange` — 🟠 (견적만 받음)
- `warn` — `비고`에 "불량" 또는 "사용 x" 포함 (자동 감지)
- `none` — 그 외

## 트러블슈팅

- **`OFFLINE` 표시** — 서버가 꺼져 있거나, HTML을 file:// 로 열어서 `/api/vendors` 와 `/vendors.json` 둘 다 못 가져옴. `node server.js` 실행 후 `http://localhost:5173` 으로 접속.
- **`SNAPSHOT` 에서 안 바뀜** — 토큰이 없거나 통합에 DB 권한이 없어 라이브 fetch 실패 → 폴백으로 정적 파일 사용. 노션 통합 권한을 다시 확인하세요.
- **노션에서 추가했는데 안 보임** — 캐시 TTL(15초) + 폴링 간격(30초) 만큼 기다리거나, 페이지 새로고침. 탭을 다른 창에서 다시 활성화하면 즉시 새로고침됩니다.
- **새 컬럼을 추가했는데 매핑 안 됨** — `server.js` 의 `normalizeEstimate` / `normalizeVendor` 함수에 필드 추가 필요.
