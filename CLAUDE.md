# 🗺️ Tour Editor — CLAUDE.md

> 이 파일은 모든 세션에서 자동 로드된다. 핵심만 담는다.
> 상세 규칙은 `.claude/rules/`, 작업 절차는 `.claude/skills/` 참조.

---

## 프로젝트 한 줄 요약
하나투어 기존 견적서 상세 화면(quoteNo 키)에서 **팝업으로 실행**되는 견적·일정 통합 에디터.
협력사 → 견적 담당자 → 영업 담당자가 단일 웹 에디터로 일정표·견적서를 작성·버전 관리한다.

---

## 기술 스택
- **Framework**: Next.js 15 (App Router) + TypeScript strict
- **UI**: Tailwind CSS + shadcn/ui + @dnd-kit/core
- **DB**: PostgreSQL + Prisma ORM
- **Auth**: NextAuth.js v5 (role: partner / agent / sales)
- **State**: Zustand + TanStack Query
- **Excel**: ExcelJS (서버사이드)
- **외부연동**: MCP (하나투어 상품 DB), Mock (항공·원가)

---

## 핵심 명령어
```bash
npm run dev          # localhost:3000
npm run build        # 프로덕션 빌드
npm run typecheck    # 타입 체크 ← 코드 변경 후 반드시
npm run lint         # ESLint
npm run test         # Vitest 유닛 테스트
npm run test:e2e     # Playwright e2e
npm run db:migrate   # Prisma 마이그레이션
npm run db:seed      # 시드 데이터
npm run quality      # 전체 품질 게이트 (typecheck + lint + test)
```

---

## 에디터 진입 방식 (핵심 아키텍처)
```
기존 하나투어 시스템 (견적서 상세 화면)
  └─ "에디터 열기" 클릭
       └─ window.open('/editor/popup?quoteNo=QC00687628001&role=agent')
            └─ 팝업 에디터 렌더링
                 └─ 저장 완료 → postMessage → 부모 창 새로고침
```

---

## 절대 금지 (어기면 즉시 중단)
- `main` 브랜치 직접 푸시
- `.env` 파일 커밋 또는 수정
- 견적 버전 덮어쓰기 — 반드시 새 버전 생성
- 삭제 API 구현 (soft delete 포함, 별도 승인 필요)
- 역할 체크 없는 API 엔드포인트
- TypeScript `any` 타입 사용
- `console.log`에 민감 데이터 출력

---

## 도메인 핵심 규칙
- **버전**: v1.0 → v1.1 → v1.2 ... 채번. 기존 버전 수정 절대 금지
- **다중 항목**: 동일 일차에 동일 구분(관광 등) 여러 개 허용
- **인감 가이드**: Excel 출력 시 견적산출내역서 우하단에 `(인)` 점선 영역 포함
- **역할**: partner/agent/sales 모두 서버에서 배정 Quote 접근권한을 검증한 뒤 편집·저장한다. sales는 가격 표시 방식(상세/총액/숨김)을 선택할 수 있다.

---

## 파일 구조 핵심
```
src/app/(popup)/editor/popup/   ← 팝업 진입 라우트
src/app/api/editor/             ← 초기화 API
src/app/api/quotes/             ← 견적 CRUD
src/app/api/versions/           ← 버전 관리
src/app/api/mcp/products/       ← MCP 상품 조회
src/app/api/quote-response/     ← 견적답변 텍스트/OCR 파싱 API
src/components/editor/          ← 에디터 컴포넌트
src/lib/version/                ← 버전 생성 로직 (핵심)
src/lib/excel/                  ← Excel 출력 로직
src/lib/quote/responseParser.ts ← 견적답변 필드/금액/식사/환율 파싱
src/lib/quote/responseOcr.ts    ← 로컬 PaddleOCR 실행 래퍼
src/mocks/                      ← Mock 데이터 (항공·원가)
```

## 견적답변 자동가져오기
- 흐름: 텍스트/이미지 OCR 입력 → `/api/quote-response/parse` → `src/lib/quote/responseParser.ts` → 미리보기 후 견적 행 적용
- 이미지 OCR은 로컬 PaddleOCR 실행(`scripts/quote-response-ocr.py`)을 사용한다
- OCR 설정은 `QUOTE_RESPONSE_OCR_PYTHON_BIN`, `QUOTE_RESPONSE_OCR_TIMEOUT_MS`로 관리한다
- API 그리드 금액은 확정 기본 행, 불포함/조건부/추가 시 금액은 기본 행 제외로 취급한다

---

## 작업 시작 전 체크리스트
1. `docs/PROGRESS.md` 에서 현재 작업 태스크 확인
2. 관련 `.claude/rules/` 파일 읽기
3. 타입 먼저 정의 → 구현 → 테스트 순서
4. 완료 후 `PROGRESS.md` 체크 업데이트

---

## 참고 문서
- `docs/PRD_v2.md` — Why & What
- `docs/요구사항정의서.md` — 요구사항 ID 및 우선순위
- `docs/기능정의서.md` — 화면·API 상세 스펙
- `docs/DB_SCHEMA.md` — Prisma 스키마
- `docs/PROGRESS.md` — 작업 단위별 진행 현황
- `AGENTS.md` — 에이전트 실수 방지 규칙 모음 (living document)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tour-editor-lite** (3827 symbols, 7948 relationships, 293 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
| `gitnexus://repo/tour-editor-lite/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tour-editor-lite/clusters` | All functional areas |
| `gitnexus://repo/tour-editor-lite/processes` | All execution flows |
| `gitnexus://repo/tour-editor-lite/process/{name}` | Step-by-step execution trace |

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
