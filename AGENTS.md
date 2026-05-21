# AGENTS.md — Tour Editor
# 에이전트가 실수할 때마다 규칙 1줄 추가. 삭제하지 않는다.
# 이 파일이 프로젝트의 '학습된 지혜'다.

## Project
- Name: tour-editor
- Language: TypeScript (strict)
- Framework: Next.js 15 (App Router)

## Commands
- Build: `npm run build`
- Test: `npm run test`
- E2E: `npm run test:e2e`
- Lint: `npm run lint`
- Type Check: `npm run typecheck`
- Quality Gate: `npm run quality`

## 작업 완료 기준 (Quality Gate)
작업이 완료됐다고 선언하기 전 반드시:
- [ ] `npm run typecheck` 에러 0개
- [ ] `npm run lint` 경고 0개
- [ ] `npm run test` 전체 통과
- [ ] 새 파일에 TODO 주석 없음
- [ ] `any` 타입 없음
- [ ] 버전 덮어쓰기 코드 없음

## 핵심 도메인 규칙
- 버전 생성은 반드시 `src/lib/version/createVersion.ts` 함수를 거친다
- 버전 생성 후 기존 QuoteVersion 레코드 UPDATE 금지
- 일정표와 견적서는 항상 같은 버전 번호를 가진다 (분리 저장 금지)
- 동일 일차에 동일 구분(관광, 이동 등) 항목 여러 개 허용 — 1개 제한하는 코드 금지
- 모든 업무 날짜/표시 날짜 계산은 대한민국 기준(`Asia/Seoul`)으로 처리한다 — `src/lib/date/korea.ts` 유틸 우선 사용, `toISOString().slice(0, 10)`로 날짜 생성 금지
- 견적답변 자동가져오기: API 그리드 금액은 확정 기본 행으로 반영하고, 불포함/조건부/추가 시 금액은 기본 견적 행으로 반영 금지
- 견적답변 자동가져오기: 비고사항/대리점 공개/최종 안내사항/유효기간/답변 첨부파일 구간의 금액은 기본 견적 행으로 승격 금지
- 견적답변 항공료는 `항공 요금` 구간의 bounded 그리드에서만 선택한다 — 뒤쪽 지상/공동경비/비고 구간의 항공료 텍스트가 항공 기본요금을 덮어쓰면 안 된다
- 견적답변 `1인당 예상수익`은 표시용 기본 행으로 유지하되 `agencyFee`, VAT, `groundProfit`에 중복 반영 금지
- 견적답변 `환율기준`이 있으면 적용 외화 행이 남지 않아도 환율 영역을 유지하고, 환율 값이 채워진 상태에서는 stale 환율 경고 표시 금지
- 견적답변 OCR은 `scripts/quote-response-ocr.py` 로컬 PaddleOCR 경로를 사용하며, 유료/외부 OCR API fallback 추가는 별도 승인 필요
- 일정 직접입력: 파일 첨부 미리보기 형식(`<<상품 정보>>`, `<<상세 일정>>`, `*1일차*`, `- 이동 | ...`)은 일차/줄바꿈 구조를 보존해 deterministic structured parser로 분리 파싱한다. `<<상세 일정>>`이 없어도 `상품 정보`, `항공/교통`, `숙박`, `포함/불포함`, `선택관광`, `쇼핑센터 방문 수`, `유의사항` 메타데이터는 유효하며, `기간`이 있으면 빈 일차를 생성한다.
- 일정표 가져오기에서 견적산출/비용/원가표 성격 시트는 여행 일정으로 import하지 않는다

## 파일 경계 규칙
- API 인증: 모든 `src/app/api/**` 파일에 `getApiToken()` 또는 NextAuth handler 인증 체크 필수
- Quote 접근: Quote 기반 API는 서버에서 배정 UserID(`partnerId`, `agentId`, `salesId`) 매칭 검증 필수
- DB 쿼리: `src/lib/db.ts` Prisma client만 사용
- 역할 체크: 서버사이드에서만 — 클라이언트 전달 role 값 신뢰 금지
- Excel 생성: `src/lib/excel/` 함수만 — 컴포넌트에서 직접 ExcelJS 호출 금지

## 에러 복구 규칙
- 동일 에러로 3회 이상 실패하면 → 다른 접근법으로 전환
- 5회 실패하면 → 중단하고 사람에게 보고
- 같은 파일을 5번 이상 수정하면 → 전체 설계 재검토 신호
- 타입 에러가 10개 이상이면 → 타입 파일부터 재설계

## 실수 기록 (발생할 때마다 추가)
# [날짜] — 무엇이 잘못됐는가 → 앞으로 어떻게 할 것인가
# 예시: 2026-04-16 — version 저장 시 UPDATE 사용 → 항상 INSERT(새 레코드) 사용
# 2026-04-21 — `git status --short`를 `.git` 루트가 아닌 경로에서 실행해서 실패 → 명령 실행 전 `git rev-parse --show-toplevel`로 루트 확인 후 작업
# 2026-04-21 — `npx tsx`로 전역 실행기를 사용했다가 네트워크 제한으로 실패 → 로컬 의존성에서 가능한 실행 경로(`node_modules`) 우선 사용, 네트워크 필요 명령은 사용자에게 승인 요청 후 실행
# 2026-04-24 — `git status --short`를 `.git` 루트 확인 없이 실행해서 실패 → Git 명령 전 저장소 여부를 먼저 확인하고, 저장소가 아니면 Git 상태 확인을 생략
# 2026-05-13 — 어두운 스크림 위에서 모달에 `box-shadow`를 주면 가장자리가 밝게 번져 보임 → 에디터 다이얼로그는 `shadow-none` + `border`; `shadow-popover` 문자열은 `src/components/editor/**`, `src/app/(popup)/**` TSX에서 금지(`scripts/quality-gate.sh` 검사)
# 2026-05-19 — 조밀한 TSX 모달 수정 중 닫는 태그 구조가 깨져 파싱 에러 발생 → 모달/레이아웃 TSX 수정 직후 typecheck 또는 focused parser check를 먼저 실행

## Forbidden Patterns
- `quoteVersion.update(...)` — 버전 레코드 수정 금지
- `any` — TypeScript strict 모드
- `process.env` 직접 접근 — `src/lib/config.ts`를 통해 접근
- `console.log` in production code
- `git push origin main` 직접 푸시
- `rm -rf` 위험 명령
- 하드코딩된 역할 문자열 — `Role` enum 사용
- `shadow-popover` — `src/components/editor/**`, `src/app/(popup)/**` 내 TSX에서 사용 금지(어두운 스크림 위 밝은 테두리 착시); `shadow-none` + `border` — `npm run quality`가 검사
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tour-editor** (3632 symbols, 6614 relationships, 272 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tour-editor/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tour-editor/clusters` | All functional areas |
| `gitnexus://repo/tour-editor/processes` | All execution flows |
| `gitnexus://repo/tour-editor/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
