"use client";

// T-201: SearchPopup 껍데기 + 탭 구조 (상품코드 / URL / 파일첨부 / 직접입력)
// T-202: 상품코드 입력 UI
// T-205: 조회 결과 미리보기 패널
// T-206: "이 일정으로 시작" → useEditorStore
// T-207: 파일 첨부 탭 UI
// T-208: 직접 입력 탭 UI

import { useEffect, useState, useRef, type DragEvent, type ChangeEvent } from "react";
import type { ItineraryData, ScheduleItem } from "@/types";
import { useEditorStore } from "@/hooks/useEditorStore";
import { withAccessCodeHeaders } from "@/lib/converter/clientAccess";
import { alignDaysToTravelPeriod } from "@/lib/itinerary/dayAlignment";
import { mergeScheduleContent } from "@/lib/itinerary/contentDetail";
import { getMealSlotRows } from "@/lib/itinerary/meal";

type Tab = "code" | "url" | "file" | "direct";

interface SearchResult {
  code: string;
  name: string;
  itinerary: ItineraryData;
  _meta?: {
    source?: "mock" | "mcp" | "mock-fallback" | "hanatour-url";
    requestedCode?: string;
    matchedCode?: string;
    requestGuid?: string;
    useMockEnabled?: boolean;
    requestedUrl?: string;
  };
}

interface Props {
  onClose: () => void;
}

interface ImportPreview {
  sourceTab: Tab;
  title: string;
  itinerary: ItineraryData;
  text: string;
  code?: string;
  source?: string;
  requestGuid?: string;
}

interface ParseApiResponse {
  itinerary?: ItineraryData;
  diagnostics?: {
    source?: "ai" | "fast-text" | "fallback-tabular" | "fallback-no-key" | "fallback-ai-error" | "fallback-quality";
    aiAttempted?: boolean;
    aiError?: string;
    aiMeaningfulItemCount?: number;
    fallbackMeaningfulItemCount?: number;
    expectedMinimumItemCount?: number;
    selectedCandidate?: "ai" | "deterministic-tabular" | "deterministic-narrative";
    qualityScore?: number;
    warnings?: string[];
    fieldCoverage?: {
      dayCount: number;
      datedDayCount: number;
      meaningfulItemCount: number;
      mealCount: number;
      accommodationCount: number;
      hasFlight: boolean;
      hasVehicle: boolean;
      hasHotelSummary: boolean;
      hasIncluded: boolean;
      hasExcluded: boolean;
      hasPassengerCount: boolean;
      hasFare: boolean;
    };
    noiseRemovedCount?: number;
  };
  error?: string;
}

type ParseProgressStage = "received" | "extracting" | "analyzing" | "completed" | "failed";

interface ParseProgressEvent {
  stage: ParseProgressStage;
  message: string;
  result?: ParseApiResponse;
  error?: string;
}

interface ImportProgressState {
  stage: ParseProgressStage;
  message: string;
}

function AutoResizeTextarea({
  id,
  value,
  onChange,
  placeholder,
  readOnly = false,
  ariaLabel,
  className = "hub-textarea w-full overflow-hidden",
}: {
  id: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    if (value.trim().length === 0) {
      textarea.style.height = "var(--hub-control-height)";
      return;
    }
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      aria-label={ariaLabel}
      rows={1}
      className={className}
    />
  );
}

function ImportProgressOverlay({ progress }: { progress: ImportProgressState }) {
  const stages: Array<{ stage: ParseProgressStage; label: string }> = [
    { stage: "received", label: "확인" },
    { stage: "extracting", label: "읽기" },
    { stage: "analyzing", label: "파악" },
    { stage: "completed", label: "정리" },
  ];
  const activeIndex = Math.max(0, stages.findIndex((step) => step.stage === progress.stage));

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 px-6 backdrop-blur-[1px]"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <svg aria-hidden="true" viewBox="0 0 112 112" className="h-24 w-24 text-primary">
          <defs>
            <filter id="import-progress-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <circle cx="56" cy="56" r="34" fill="currentColor" opacity="0.08" className="animate-pulse" />
          <g className="origin-center animate-spin" style={{ animationDuration: "1.8s" }}>
            <path
              d="M56 16a40 40 0 0 1 39 31"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="4"
              filter="url(#import-progress-glow)"
            />
            <circle cx="96" cy="56" r="4" fill="currentColor" />
          </g>
          <g className="origin-center animate-spin" style={{ animationDuration: "3.2s", animationDirection: "reverse" }}>
            <path
              d="M28 28a40 40 0 0 0-8 49"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
              strokeOpacity="0.45"
            />
            <circle cx="23" cy="75" r="3" fill="currentColor" opacity="0.7" />
          </g>
          <path
            d="M42 58h28M42 46h22M42 70h18"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="4"
            strokeOpacity="0.75"
          />
        </svg>
        <div className="flex flex-col gap-2">
          <p className="text-[14px] font-bold text-foreground">
            {progress.message}
          </p>
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">
            파일과 입력 내용을 분석해 일정표로 정리하고 있습니다.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3" aria-hidden="true">
          {stages.map((step, index) => {
            const isDone = index < activeIndex;
            const isActive = index === activeIndex;
            return (
              <div key={step.stage} className="flex flex-col items-center gap-1.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full transition-colors ${
                    isDone || isActive ? "bg-primary" : "bg-muted-foreground/25"
                  } ${isActive ? "animate-pulse" : ""}`}
                />
                <span className={`text-[11.5px] ${isDone || isActive ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function parseProgressEvent(raw: string): ParseProgressEvent {
  const json = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/u, ""))
    .join("\n")
    .trim();
  if (!json) throw new Error("빈 진행 상태를 받았습니다.");
  return JSON.parse(json) as ParseProgressEvent;
}

async function readProgressResponse(
  response: Response,
  onProgress: (event: ParseProgressEvent) => void
): Promise<ParseApiResponse> {
  if (!response.ok) {
    const raw = await response.text();
    try {
      const body = JSON.parse(raw) as { error?: string };
      return Promise.reject(new Error(body.error ?? `일정을 불러오지 못했습니다. (${response.status})`));
    } catch {
      throw new Error(raw || `일정을 불러오지 못했습니다. (${response.status})`);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("진행 상태를 읽을 수 없습니다.");

  const decoder = new TextDecoder();
  let buffer = "";
  let result: ParseApiResponse | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const event = parseProgressEvent(chunk);
      onProgress(event);
      if (event.stage === "failed") {
        throw new Error(event.error ?? event.message);
      }
      if (event.stage === "completed") {
        result = event.result ?? null;
      }
    }
  }

  if (buffer.trim()) {
    const event = parseProgressEvent(buffer);
    onProgress(event);
    if (event.stage === "failed") {
      throw new Error(event.error ?? event.message);
    }
    if (event.stage === "completed") {
      result = event.result ?? null;
    }
  }

  if (!result) throw new Error("일정 파싱 결과를 받지 못했습니다.");
  return result;
}

function parserDiagnosticMessage(diagnostics: ParseApiResponse["diagnostics"]): string | null {
  if (!diagnostics) return null;
  const coverage = diagnostics.fieldCoverage;
  const parserName = (() => {
    if (diagnostics.selectedCandidate === "ai") return "AI 파서";
    if (diagnostics.selectedCandidate === "deterministic-tabular") return "표 구조 기본 파서";
    if (diagnostics.selectedCandidate === "deterministic-narrative") return "문장형 기본 파서";
    return "알 수 없음";
  })();
  if (diagnostics.source === "fast-text") return null;

  const resultMessage = (() => {
    if (diagnostics.source === "ai") {
      return "AI 분석 결과를 적용했습니다.";
    }
    if (diagnostics.source === "fallback-tabular") {
      return diagnostics.aiAttempted
        ? "AI 분석도 시도했지만, 표 구조 기본 파서 결과가 더 안정적이라 기본 파서로 불러왔습니다."
        : "AI를 사용하지 않고 표 구조 기본 파서로 불러왔습니다.";
    }
    if (diagnostics.source === "fallback-no-key") {
      return "AI API key가 서버에 반영되지 않아 기본 파서로 불러왔습니다. dev 서버를 재시작하고 .env.local의 OPENAI_API_KEY를 확인해 주세요.";
    }
    if (diagnostics.source === "fallback-ai-error") {
      return `AI 호출이 실패해서 기본 파서로 불러왔습니다.${diagnostics.aiError ? `\n\n원인: ${diagnostics.aiError}` : ""}`;
    }
    if (diagnostics.source === "fallback-quality") {
      return "AI 결과가 품질 기준을 통과하지 못해 기본 파서로 불러왔습니다.";
    }
    return "파싱 결과를 불러왔습니다.";
  })();
  const evidence = [
    diagnostics.qualityScore !== undefined ? `- 품질 점수: ${diagnostics.qualityScore}/100` : "",
    `- 선택된 처리 방식: ${parserName}${diagnostics.selectedCandidate ? ` (${diagnostics.selectedCandidate})` : ""}`,
    coverage
      ? `- 추출된 핵심 정보: ${coverage.dayCount}일차 / 일정 ${coverage.meaningfulItemCount}개 / 식사 ${coverage.mealCount}개 / 숙박 ${coverage.accommodationCount}개`
      : "",
    coverage
      ? `- 부가 정보 감지: 항공 ${coverage.hasFlight ? "있음" : "없음"}, 차량 ${coverage.hasVehicle ? "있음" : "없음"}, 호텔요약 ${coverage.hasHotelSummary ? "있음" : "없음"}, 인원 ${coverage.hasPassengerCount ? "있음" : "없음"}, 요금 ${coverage.hasFare ? "있음" : "없음"}`
      : "",
    diagnostics.aiMeaningfulItemCount !== undefined || diagnostics.fallbackMeaningfulItemCount !== undefined
      ? `- 비교 기준: AI 일정 ${diagnostics.aiMeaningfulItemCount ?? 0}개 / 기본 파서 일정 ${diagnostics.fallbackMeaningfulItemCount ?? 0}개 / 최소 기대 ${diagnostics.expectedMinimumItemCount ?? 0}개`
      : "",
    diagnostics.noiseRemovedCount !== undefined ? `- 제외한 메타/푸터성 문구: ${diagnostics.noiseRemovedCount}개` : "",
  ].filter(Boolean);
  const warnings = diagnostics.warnings?.filter((warning) => warning.trim().length > 0) ?? [];
  const caution = warnings.length > 0
    ? warnings.map((warning) => `- ${warning}`)
    : ["- 큰 누락 신호는 감지되지 않았습니다. 그래도 날짜, 숙박, 식사, 요금은 한 번 확인해 주세요."];

  return [
    "[일정 불러오기 결과]",
    resultMessage,
    diagnostics.aiAttempted ? "AI 시도 여부: 시도함" : "AI 시도 여부: 시도하지 않음",
    "",
    "[판단 근거]",
    ...evidence,
    "",
    "[확인 필요]",
    ...caution,
  ].join("\n");
}

function formatEditableSegment(value: string | undefined): string {
  return (value ?? "").replace(/\s*\|\s*/gu, " / ").replace(/\s+/gu, " ").trim();
}

function formatItemMetaForEditableText(item: ScheduleItem): string[] {
  return [
    item.region ? `지역=${formatEditableSegment(item.region)}` : "",
    item.transport ? `교통편=${formatEditableSegment(item.transport)}` : "",
    item.time ? `시간=${formatEditableSegment(item.time)}` : "",
  ].filter(Boolean);
}

function formatItemForEditableText(item: ScheduleItem): string {
  const meta = formatItemMetaForEditableText(item);
  if (item.type === "MEAL") {
    const meals = getMealSlotRows(item, { includeEmpty: false });
    if (meals.length > 0) {
      return meals
        .map(({ label, value }) => ["식사", ...meta, `${label}: ${formatEditableSegment(value)}`].join(" | "))
        .join("\n");
    }
    return ["식사", ...meta, formatEditableSegment(item.content)].join(" | ");
  }

  const labels: Record<ScheduleItem["type"], string> = {
    TRANSFER: "이동",
    SIGHTSEEING: "관광",
    MEAL: "식사",
    ACCOMMODATION: "숙박",
    OTHER: "기타",
  };
  const content = formatEditableSegment(mergeScheduleContent(item.content, item.detail));

  return [labels[item.type], ...meta, content].filter(Boolean).join(" | ");
}

function stripPreviewHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
    "#39": "'",
  };

  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>|<\/div>|<\/li>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&(amp|gt|lt|nbsp|quot|#39);/gu, (match, entity) => entities[entity] ?? match);
}

function compactPreviewValue(value: string, max = 520): string {
  const normalized = stripPreviewHtml(value)
    .replace(/\s*\|\s*/gu, " | ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!normalized || normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trim()}...`;
}

function splitPreviewList(value: string, delimiter: RegExp): string[] {
  return stripPreviewHtml(value)
    .split(delimiter)
    .map((item) => item.replace(/\s+/gu, " ").trim())
    .filter((item) => item.length > 0);
}

function appendPreviewList(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`*${title}*`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

function appendPreviewText(lines: string[], label: string, value: string): void {
  const normalized = compactPreviewValue(value);
  if (!normalized) return;
  lines.push(`*${label}*`);
  lines.push(normalized);
  lines.push("");
}

function itineraryToEditableText(itinerary: ItineraryData): string {
  const basics = itinerary.basics;
  const fare = itinerary.overview.fare;
  const lines: string[] = ["<<상품 정보>>"];

  appendPreviewText(lines, "상품명", itinerary.header.groupName);
  appendPreviewList(lines, "방문도시", splitPreviewList(itinerary.overview.cities, /\s*,\s*/u));
  appendPreviewText(lines, "기간", `${itinerary.overview.travelPeriod.start} ~ ${itinerary.overview.travelPeriod.end}`);
  if (fare.adultPerPerson > 0) {
    appendPreviewText(lines, "성인1인 총 상품가", `${fare.adultPerPerson.toLocaleString("ko-KR")}원`);
  }
  lines.push("");

  lines.push("<<항공/교통>>");
  appendPreviewText(lines, "항공 출발", basics.flight.departure);
  appendPreviewText(lines, "항공 귀국", basics.flight.arrival);
  appendPreviewText(lines, "차량", basics.flight.localVehicle);
  lines.push("");

  lines.push("<<숙박>>");
  appendPreviewList(lines, "숙박호텔", splitPreviewList(basics.accommodation.hotel, /\s*,\s*/u));
  appendPreviewText(lines, "호텔등급", basics.accommodation.grade);
  appendPreviewText(lines, "1객실이용인원", basics.accommodation.occupancy);
  lines.push("");

  lines.push("<<포함/불포함>>");
  appendPreviewList(lines, "포함사항", splitPreviewList(basics.included, /\s*\/\s*/u));
  appendPreviewList(lines, "불포함사항", splitPreviewList(basics.excluded, /\s*\/\s*/u));
  appendPreviewList(lines, "선택관광", splitPreviewList(basics.optionalTour, /\s*\/\s*/u));
  appendPreviewText(lines, "쇼핑센터 방문 수", String(basics.shoppingCenters));
  lines.push("");

  appendPreviewList(lines, "유의사항", splitPreviewList(basics.notes, /\n+/u));

  if (itinerary.days.length > 0) {
    lines.push("<<상세 일정>>");
  }

  for (const day of itinerary.days) {
    lines.push(`*${day.dayNo}일차*`);
    if (day.date) lines.push(day.date);
    for (const item of day.items) {
      if (item.type === "OTHER" && item.content === day.date) continue;
      lines.push(`- ${formatItemForEditableText(item)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function importAlignmentMessage(expectedDayCount: number, outOfRangeDayNos: number[]): string {
  return [
    `여행기간은 ${expectedDayCount}일인데 ${outOfRangeDayNos.join(", ")}일차에 내용이 있습니다.`,
    "여행기간과 일차수가 다릅니다. 그대로 입력할까요?",
  ].join("\n");
}

const FOOTER_PRIMARY_BUTTON_CLASS =
  "hub-btn hub-btn-primary w-32 disabled:opacity-50";
const FOOTER_SECONDARY_BUTTON_CLASS =
  "hub-btn hub-btn-custom w-32";
const DIRECT_INPUT_TEMPLATE = [
  "상품명: 싱가포르 4박 5일",
  "기간: 2026-06-02 ~ 2026-06-06",
  "인원: 성인 10, 아동 0, 유아 0, FOC 0",
  "항공 출발: OZ751 인천 10:00 → 싱가포르 15:30",
  "항공 귀국: OZ752 싱가포르 23:00 → 인천 06:30",
  "숙박호텔: Aloft Singapore Novena",
  "포함사항: 왕복항공권 / 숙박 / 일정표상 식사",
  "불포함사항: 개인경비 / 여행자보험",
  "",
  "1일차 2026-06-02",
  "- 10시 인천공항 출발",
  "- 머라이언 공원 관광",
  "- 석식 현지식",
  "- Aloft Singapore Novena 숙박",
  "",
  "2일차 2026-06-03",
  "- 조식 뷔페",
  "- 센토사섬 관광",
  "- 중식 한식",
  "- 석식 송파바쿠테",
].join("\n");

export function SearchPopup({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("code");
  const loadFromProduct = useEditorStore((s) => s.loadFromProduct);

  // ── 상품코드 탭 상태 ──────────────────────────────────
  const [codeInput, setCodeInput] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  // ── 파일 탭 상태 ─────────────────────────────────────
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 직접 입력 탭 상태 ─────────────────────────────────
  const [directText, setDirectText] = useState("");
  const [directLoading, setDirectLoading] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressState | null>(null);
  const isImporting = fileLoading || directLoading;
  const visibleImportPreview = importPreview?.sourceTab === activeTab ? importPreview : null;

  // ── 상품코드 조회 ─────────────────────────────────────
  async function handleSearch() {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;

    setCodeLoading(true);
    setCodeError(null);
    setImportPreview(null);

    try {
      const res = await fetch(`/api/mcp/products/${encodeURIComponent(code)}`, {
        headers: withAccessCodeHeaders(),
      });
      const raw = await res.text();

      if (!res.ok) {
        try {
          const body = JSON.parse(raw) as { error?: string };
          setCodeError(body.error ?? `조회에 실패했습니다. (${res.status})`);
        } catch {
          setCodeError(raw || `조회에 실패했습니다. (${res.status})`);
        }
        return;
      }
      const body = JSON.parse(raw) as SearchResult;
      const aligned = alignDaysToTravelPeriod(body.itinerary).itinerary;
      setImportPreview({
        sourceTab: "code",
        title: body.name,
        itinerary: aligned,
        text: itineraryToEditableText(aligned),
        code: body.code,
        source: body._meta?.source ?? "unknown",
        requestGuid: body._meta?.requestGuid,
      });
    } catch {
      setCodeError("네트워크 오류가 발생했습니다. 다시 시도해 주세요.");
    } finally {
      setCodeLoading(false);
    }
  }

  async function handleUrlSearch() {
    const url = urlInput.trim();
    if (!url) return;

    setUrlLoading(true);
    setUrlError(null);
    setImportPreview(null);

    try {
      const res = await fetch("/api/hanatour/products/from-url", {
        method: "POST",
        headers: withAccessCodeHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ url }),
      });
      const raw = await res.text();

      if (!res.ok) {
        try {
          const body = JSON.parse(raw) as { error?: string };
          setUrlError(body.error ?? `조회에 실패했습니다. (${res.status})`);
        } catch {
          setUrlError(raw || `조회에 실패했습니다. (${res.status})`);
        }
        return;
      }
      const body = JSON.parse(raw) as SearchResult;
      const aligned = alignDaysToTravelPeriod(body.itinerary).itinerary;
      setImportPreview({
        sourceTab: "url",
        title: body.name,
        itinerary: aligned,
        text: itineraryToEditableText(aligned),
        code: body.code,
        source: body._meta?.source ?? "unknown",
        requestGuid: body._meta?.requestGuid,
      });
    } catch {
      setUrlError("네트워크 오류가 발생했습니다. 다시 시도해 주세요.");
    } finally {
      setUrlLoading(false);
    }
  }

  function handleLoadProduct() {
    if (!visibleImportPreview) return;
    const aligned = alignDaysToTravelPeriod(visibleImportPreview.itinerary);
    if (
      aligned.hasOutOfRangeContent &&
      aligned.expectedDayCount &&
      !window.confirm(importAlignmentMessage(aligned.expectedDayCount, aligned.outOfRangeDayNos))
    ) {
      return;
    }
    loadFromProduct(aligned.itinerary);
    onClose();
  }

  async function handleCopyPreviewText() {
    if (!visibleImportPreview?.text.trim()) return;
    await navigator.clipboard.writeText(visibleImportPreview.text);
  }

  function handleUseDirectInput() {
    if (!visibleImportPreview) return;
    setDirectText(visibleImportPreview.text);
    setImportPreview(null);
    setActiveTab("direct");
  }

  function handleDirectTextChange(value: string) {
    setDirectText(value);
    if (importPreview?.sourceTab === "direct") {
      setImportPreview(null);
    }
  }

  // ── 파일 유효성 검사 ──────────────────────────────────
  function validateFile(file: File): string | null {
    const MAX_MB = 10;
    const name = file.name.toLowerCase();
    if (file.size > MAX_MB * 1024 * 1024) {
      return `파일 크기가 ${MAX_MB}MB를 초과합니다. (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
    }
    if (name.endsWith(".xls") && !name.endsWith(".xlsx")) {
      return "구형 Excel(.xls)은 지원하지 않습니다. Excel에서 .xlsx로 저장한 뒤 업로드해 주세요.";
    }
    return null;
  }

  function handleFileDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const err = validateFile(file);
    if (err) { setFileError(err); setFileName(null); setSelectedFile(null); if (importPreview?.sourceTab === "file") setImportPreview(null); return; }
    setFileError(null);
    setFileName(file.name);
    setSelectedFile(file);
    if (importPreview?.sourceTab === "file") setImportPreview(null);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const err = validateFile(file);
    if (err) { setFileError(err); setFileName(null); setSelectedFile(null); if (importPreview?.sourceTab === "file") setImportPreview(null); return; }
    setFileError(null);
    setFileName(file.name);
    setSelectedFile(file);
    if (importPreview?.sourceTab === "file") setImportPreview(null);
  }

  async function handleParseFile() {
    if (!selectedFile) {
      setFileError("파일을 먼저 선택해 주세요.");
      return;
    }

    setFileLoading(true);
    setImportProgress({ stage: "received", message: "요청을 확인하고 있습니다." });
    setFileError(null);
    try {
      const form = new FormData();
      form.append("file", selectedFile);
      form.append("title", selectedFile.name.replace(/\.[^.]+$/u, ""));

      const response = await fetch("/api/itinerary/parse?progress=1", {
        method: "POST",
        headers: withAccessCodeHeaders(),
        body: form,
      });
      const payload = await readProgressResponse(response, (event) => {
        setImportProgress({ stage: event.stage, message: event.message });
      });
      if (!response.ok || !payload.itinerary) {
        throw new Error(payload.error ?? "파일에서 일정을 불러오지 못했습니다.");
      }
      const parsed = payload.itinerary;
      if (!parsed.days || parsed.days.length === 0) {
        throw new Error("불러올 수 있는 일정이 없습니다.");
      }
      const aligned = alignDaysToTravelPeriod(parsed);
      const diagnosticMessage = parserDiagnosticMessage(payload.diagnostics);
      if (diagnosticMessage) window.alert(diagnosticMessage);
      setImportPreview({
        sourceTab: "file",
        title: selectedFile.name,
        itinerary: aligned.itinerary,
        text: itineraryToEditableText(aligned.itinerary),
        source: "file",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "파일에서 일정을 불러오지 못했습니다. 형식을 확인해 주세요.";
      setFileError(message);
    } finally {
      setFileLoading(false);
      setImportProgress(null);
    }
  }

  async function handleParseDirectInput() {
    if (!directText.trim()) {
      setDirectError("직접 입력 내용을 입력해 주세요.");
      return;
    }

    setDirectLoading(true);
    setImportProgress({ stage: "received", message: "요청을 확인하고 있습니다." });
    setDirectError(null);
    try {
      const form = new FormData();
      form.append("text", directText);
      form.append("title", "직접입력 일정");
      const response = await fetch("/api/itinerary/parse?progress=1", {
        method: "POST",
        headers: withAccessCodeHeaders(),
        body: form,
      });
      const payload = await readProgressResponse(response, (event) => {
        setImportProgress({ stage: event.stage, message: event.message });
      });
      if (!response.ok || !payload.itinerary) {
        throw new Error(payload.error ?? "입력한 내용에서 일정을 불러오지 못했습니다.");
      }
      const parsed = payload.itinerary;
      if (!parsed.days || parsed.days.length === 0) {
        throw new Error("불러올 수 있는 일정이 없습니다.");
      }
      const aligned = alignDaysToTravelPeriod(parsed);
      const diagnosticMessage = parserDiagnosticMessage(payload.diagnostics);
      if (diagnosticMessage) window.alert(diagnosticMessage);
      setImportPreview({
        sourceTab: "direct",
        title: "직접입력 일정",
        itinerary: aligned.itinerary,
        text: itineraryToEditableText(aligned.itinerary),
        source: "direct",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "입력한 내용에서 일정을 불러오지 못했습니다. 형식을 확인해 주세요.";
      setDirectError(message);
    } finally {
      setDirectLoading(false);
      setImportProgress(null);
    }
  }

  function renderLookupResult() {
    if (!visibleImportPreview) return null;

    return (
      <div className="hub-section p-3">
        <div className="mb-3 border border-primary/30 bg-primary/10 p-3">
          <p className="text-[12.5px] font-semibold text-foreground">
            조회된 일정 요약을 확인하세요.
          </p>
          <p className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">
            그대로 반영하려면 일정 반영을 누르세요. 일부 문구만 수정하려면 아래 요약을 직접 입력 탭으로 보내서 수정한 뒤 불러오세요.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleCopyPreviewText()}
              className="hub-btn hub-btn-custom h-[31px] px-2"
            >
              요약 복사
            </button>
            <button
              type="button"
              onClick={handleUseDirectInput}
              className="hub-btn hub-btn-custom h-[31px] px-2"
            >
              직접 입력에서 수정
            </button>
          </div>
        </div>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <p className="text-[12.5px] font-semibold text-foreground">
              {visibleImportPreview.title}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <label htmlFor="product-edit-text" className="text-[12.5px] font-medium text-foreground">
            조회된 일정 요약
          </label>
          <AutoResizeTextarea
            id="product-edit-text"
            value={visibleImportPreview.text}
            readOnly
          />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            {visibleImportPreview.code && <span>상품코드: {visibleImportPreview.code}</span>}
            {visibleImportPreview.source && <span>데이터 소스: {visibleImportPreview.source}</span>}
            {visibleImportPreview.requestGuid && (
              <span>요청 GUID: {visibleImportPreview.requestGuid}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── 렌더 ─────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[rgba(0,0,0,0.45)]"
      onClick={(e) => { if (!isImporting && e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-popup-title"
        className="hub-dialog relative z-modal flex max-h-[90vh] w-[640px] flex-col overflow-hidden"
      >
        <div className="hub-dialog-head shrink-0">
          <h2 id="search-popup-title" className="text-[13px] font-bold leading-5">
            일정 불러오기
          </h2>
          <button
            type="button"
            aria-label="닫기"
            className="hub-btn-text px-2 text-chrome-sidebar-foreground hover:bg-chrome-sidebar-hover"
            disabled={isImporting}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="hub-tabs flex shrink-0">
          {(
            [
              { key: "code", label: "상품코드 조회" },
              { key: "url", label: "URL 입력" },
              { key: "file", label: "파일 첨부" },
              { key: "direct", label: "직접 입력" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`hub-tab ${
                activeTab === key
                  ? "hub-tab-active"
                  : ""
              }`}
              disabled={isImporting}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* ── 상품코드 탭 ── */}
          {activeTab === "code" && (
            <div className="flex flex-col gap-4">
              <div className="flex gap-2">
                <label htmlFor="product-code" className="sr-only">
                  상품코드
                </label>
                <input
                  id="product-code"
                  type="text"
                  placeholder="상품코드 입력 (예: AVP999261231VNE)"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
                  className="hub-input flex-1"
                />
                <button
                  onClick={() => void handleSearch()}
                  disabled={codeLoading || !codeInput.trim()}
                  className="hub-btn hub-btn-primary h-[31px] disabled:opacity-50"
                >
                  {codeLoading ? "조회 중..." : "조회"}
                </button>
              </div>

              {/* 에러 */}
              {codeError && (
                <p role="alert" className="text-[12.5px] text-destructive">
                  {codeError}
                </p>
              )}

              {/* 조회 결과 편집 */}
              {renderLookupResult()}
            </div>
          )}

          {/* ── URL 입력 탭 ── */}
          {activeTab === "url" && (
            <div className="flex flex-col gap-4">
              <div className="flex gap-2">
                <label htmlFor="product-url" className="sr-only">
                  하나투어 상품 URL
                </label>
                <input
                  id="product-url"
                  type="url"
                  placeholder="하나투어 상품 URL 입력"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleUrlSearch(); }}
                  className="hub-input flex-1"
                />
                <button
                  onClick={() => void handleUrlSearch()}
                  disabled={urlLoading || !urlInput.trim()}
                  className="hub-btn hub-btn-primary h-[31px] disabled:opacity-50"
                >
                  {urlLoading ? "조회 중..." : "조회"}
                </button>
              </div>

              <div className="border border-grid-border bg-muted/30 p-3 text-[11.5px] leading-[18px] text-muted-foreground">
                <p className="font-medium text-foreground">지원 URL</p>
                <p>https://www.hanatour.com/trp/pkg/...?...pkgCd=상품코드</p>
              </div>

              {urlError && (
                <p role="alert" className="text-[12.5px] text-destructive">
                  {urlError}
                </p>
              )}

              {renderLookupResult()}
            </div>
          )}

          {/* ── 파일 첨부 탭 (T-207) ── */}
          {activeTab === "file" && (
            <div className="flex flex-col gap-4">
              <div
                role="region"
                aria-label="파일 드롭 영역"
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleFileDrop}
                className={`flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed transition-colors ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border bg-muted/20 hover:border-muted-foreground/50"
                }`}
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="text-2xl select-none">📎</span>
                <p className="text-[12.5px] text-muted-foreground">
                  파일을 여기에 드래그하거나 클릭하여 선택하세요
                </p>
                <p className="text-[11.5px] text-muted-foreground">최대 10MB</p>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.csv,.json,.txt,.pdf,.hwp,.hwpx,.docx"
                className="hidden"
                aria-label="파일 선택"
                onChange={handleFileChange}
              />

              {fileError && (
                <p role="alert" className="text-[12.5px] text-destructive">
                  {fileError}
                </p>
              )}

              {fileName && (
                <div className="border border-grid-border bg-muted/40 px-3 py-2">
                  <p className="truncate text-[12.5px] text-foreground">{fileName}</p>
                </div>
              )}

              {!fileName && !fileError && (
                <p className="text-[12.5px] text-muted-foreground">
                  지원 형식: Excel (.xlsx), CSV, JSON, TXT, PDF, HWP, HWPX, DOCX
                </p>
              )}

              {renderLookupResult()}
            </div>
          )}

          {/* ── 직접 입력 탭 (T-208) ── */}
          {activeTab === "direct" && (
            <div className="flex min-h-full flex-col gap-4">
              <div className="flex shrink-0 items-start justify-between gap-3">
                <label htmlFor="direct-input" className="text-[12.5px] text-muted-foreground">
                  일정 내용을 입력하세요. 일차, 날짜, 식사, 숙박을 줄 단위로 나누면 더 정확하게 불러옵니다.
                </label>
                <button
                  type="button"
                  onClick={() => handleDirectTextChange(directText.trim() ? directText : DIRECT_INPUT_TEMPLATE)}
                  className="hub-btn hub-btn-custom h-[31px] shrink-0 px-2"
                >
                  예시 채우기
                </button>
              </div>
              <div className="shrink-0 border border-grid-border bg-muted/30 p-3 text-[11.5px] leading-[18px] text-muted-foreground">
                <p className="font-medium text-foreground">권장 형식</p>
                <p>상품명: 싱가포르 4박 5일</p>
                <p>항공 출발: OZ751 인천 10:00 → 싱가포르 15:30</p>
                <p>포함사항: 왕복항공권 / 숙박 / 일정표상 식사</p>
                <p>불포함사항: 개인경비 / 여행자보험</p>
                <p>1일차 2026-06-02</p>
                <p>- 10시 인천공항 출발</p>
                <p>- 머라이언 공원 관광</p>
                <p>- 석식 현지식</p>
                <p>- 호텔명 숙박</p>
              </div>
              <AutoResizeTextarea
                id="direct-input"
                value={directText}
                onChange={handleDirectTextChange}
                placeholder={DIRECT_INPUT_TEMPLATE}
                ariaLabel="일정 내용을 입력하세요. 일차, 날짜, 식사, 숙박을 줄 단위로 나누면 더 정확하게 불러옵니다."
                className="hub-textarea min-h-[360px] w-full resize-none overflow-hidden"
              />
              {directError && (
                <p role="alert" className="text-[12.5px] text-destructive">
                  {directError}
                </p>
              )}

              {renderLookupResult()}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-between gap-2 border-t border-border bg-background px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isImporting}
            className={FOOTER_SECONDARY_BUTTON_CLASS}
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => {
              if (visibleImportPreview) {
                handleLoadProduct();
                return;
              }
              if (activeTab === "code" || activeTab === "url") {
                handleLoadProduct();
                return;
              }
              if (activeTab === "file") {
                void handleParseFile();
                return;
              }
              void handleParseDirectInput();
            }}
            disabled={
              isImporting ||
              (activeTab === "code" && !visibleImportPreview) ||
              (activeTab === "url" && (urlLoading || !visibleImportPreview)) ||
              (activeTab === "file" && !visibleImportPreview && (fileLoading || !selectedFile)) ||
              (activeTab === "direct" && !visibleImportPreview && (!directText.trim() || directLoading))
            }
            className={FOOTER_PRIMARY_BUTTON_CLASS}
          >
            {isImporting ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
                파악중...
              </span>
            ) : (
              visibleImportPreview ? "일정 반영" : "일정 불러오기"
            )}
          </button>
        </div>
        {importProgress && <ImportProgressOverlay progress={importProgress} />}
      </div>
    </div>
  );
}
