# Tour Editor Lite

하나투어 견적·일정 데이터를 공개 URL에서 변환하는 Next.js 앱입니다. 원본 `tour-editor`의 로그인, DB 저장, 버전 이력 기능은 제외하고, 접근코드 기반 converter 기능만 남긴 배포판입니다.

## Features

- 공유 접근코드 게이트
- 하나투어 상품 URL 또는 상품코드 기반 일정 불러오기
- `.xlsx`, `.pdf`, `.hwp`, `.hwpx`, `.docx`, 텍스트 일정 파싱
- 일정표와 견적서 편집
- 견적답변 텍스트 및 이미지 OCR 자동 가져오기
- 일정표 Excel, 견적산출내역서 Excel 다운로드

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

개발 서버는 기본적으로 `http://localhost:3000`에서 실행됩니다.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `ACCESS_CODE` | converter 접근코드. 비어 있으면 API 접근이 거부됩니다. |
| `USE_MOCK_MCP` | `true`이면 `src/mocks/products.json` 상품 데이터를 사용합니다. |
| `HANATOUR_MCP_URL` | MCP 상품 조회 endpoint |
| `HANATOUR_MCP_TOKEN` | MCP 인증 token |
| `HANATOUR_MCP_REQUEST_TIMEOUT_MS` | MCP request timeout |
| `HANATOUR_MCP_TOOL_CALL_TIMEOUT_MS` | MCP tool call timeout |
| `OPENAI_API_KEY` | AI 일정 파싱 및 PDF OCR fallback용 API key |
| `OPENAI_MODEL` | AI 파싱 모델 |
| `OPENAI_BASE_URL` | AI API base URL |
| `OPENAI_PARSE_TIMEOUT_MS` | AI 파싱 timeout |
| `QUOTE_RESPONSE_OCR_PROVIDER` | 견적답변 이미지 OCR provider. `openai`(기본) 또는 `local` |
| `QUOTE_RESPONSE_OCR_PYTHON_BIN` | 견적답변 이미지 OCR에 사용할 Python 실행 파일. 기본값 `python3` |
| `QUOTE_RESPONSE_OCR_TIMEOUT_MS` | 견적답변 이미지 OCR timeout. 기본값 `60000` |

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Next.js 개발 서버 실행 |
| `npm run build` | 프로덕션 빌드 |
| `npm run start` | 빌드 결과 실행 |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm run lint` | Next.js/ESLint 검사 |
| `npm run test` | Vitest 단위 테스트 실행 |
| `npm run test:parser` | 견적답변, 직접입력, 일정 golden parser 회귀 테스트 |
| `npm run test:quote-response` | 견적답변 parser/API 회귀 테스트 |
| `npm run test:itinerary-direct` | 직접입력/AI 일정 parser 회귀 테스트 |
| `npm run test:itinerary-golden` | 파일 일정 golden fixture 회귀 테스트 |
| `npm run quality` | typecheck, lint, test, editor TSX 규칙 검사 |

## Runtime Surface

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | 접근코드 게이트와 converter editor |
| `/api/access/verify` | POST | 접근코드 검증 |
| `/api/mcp/products/:code` | GET | 상품코드 기반 일정 조회 |
| `/api/hanatour/products/from-url` | POST | 하나투어 URL 기반 일정 조회 |
| `/api/itinerary/parse` | POST | 파일/텍스트 일정 파싱 |
| `/api/quote-response/parse` | POST | 견적답변 텍스트 또는 이미지 OCR 결과를 견적서 행으로 파싱 |
| `/api/flights` | GET | 항공 mock 데이터 조회 |
| `/api/export?type=itinerary\|cost` | POST | 현재 화면 상태로 Excel 생성 |

모든 converter API는 `x-access-code` 헤더 또는 route별 payload의 접근코드를 검증합니다.

## Project Structure

```text
src/
  app/
    api/                  # converter API routes
    page.tsx              # converter app entry
  components/
    converter/            # access gate and app shell
    editor/               # itinerary, quote, search, preview UI
  hooks/
    useEditorStore.ts     # client editor state
  lib/
    converter/            # access code helpers
    excel/                # Excel generation
    hanatour/             # Hanatour product URL client
    itinerary/            # parsing, display, mutation helpers
    mcp/                  # MCP product mapping/client
    quote/                # quote generation/currency helpers
  mocks/                  # local product/flight/cost data
  types/                  # domain types
```

## Notes

- 이 저장소는 DB를 사용하지 않습니다.
- 원본 견적 문서 샘플(`.hwp`, `.doc`, `.docx`)은 민감정보 가능성이 있어 기본적으로 git ignore합니다.
- 업무 날짜와 표시 날짜는 `src/lib/date/korea.ts` 기준으로 처리합니다.
- 일정 파일에서 견적산출, 비용, 원가표 성격 시트는 일정표 import 대상에서 제외합니다.
- 파일 첨부 미리보기 텍스트를 직접입력으로 다시 넣는 경우에도 `<<상품 정보>>`, `<<상세 일정>>`, `*1일차*` 구조를 보존해 파싱합니다.
- 견적답변 자동 가져오기는 확정 요금 그리드 금액만 기본 견적 행으로 반영합니다. 비고사항, 안내문, 유효기간, 대리점 공개 문구의 금액은 기본 행으로 승격하지 않습니다.
- 견적답변 이미지 OCR은 기본적으로 서버 환경변수 `OPENAI_API_KEY`로 OpenAI Vision을 호출합니다. `NEXT_PUBLIC_OPENAI_API_KEY`처럼 브라우저에 노출되는 이름은 사용하지 마세요.
- `QUOTE_RESPONSE_OCR_PROVIDER=local`로 설정하면 로컬 Python 환경의 PaddleOCR을 사용합니다. 텍스트 입력 파싱은 OCR provider 설정 없이 동작합니다.
