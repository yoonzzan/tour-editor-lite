import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  DaySchedule,
  ItineraryData,
  MealSlot,
  ScheduleItem,
  ScheduleItemType,
} from "@/types";
import { config } from "@/lib/config";
import { enforceAccommodationLast } from "@/lib/itinerary/policy";
import { parseItineraryText } from "@/lib/itinerary/importParser";
import { currentYearInKorea, dateStringInKorea, todayInKorea } from "@/lib/date/korea";
import { splitMcpScheduleContent, splitStructuredScheduleContent } from "@/lib/itinerary/contentDetail";
import {
  ANALYSIS_SYSTEM_PROMPT,
  FEW_SHOT_ASSISTANT,
  FEW_SHOT_USER,
  PARSER_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
  buildParseUserPrompt,
} from "@/lib/itinerary/aiPrompts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_DATE_TODAY = todayInKorea();
const MAX_INPUT_CHARS = 12000;
const MAX_LINE_CHARS = 280;
const AI_CONTEXT_HEAD_CHARS = 2500;

const mealSlotSchema = z.enum(["breakfast", "lunch", "dinner"]);
const ITEM_TYPE_VALUES = [
  "TRANSFER",
  "SIGHTSEEING",
  "MEAL",
  "ACCOMMODATION",
  "OTHER",
] as const;
const itemTypeSchema = z.enum(ITEM_TYPE_VALUES);
const itemTypeSet = new Set<string>(ITEM_TYPE_VALUES);

function normalizeAiItemType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (itemTypeSet.has(normalized)) return normalized;

  const compact = value.replace(/\s+/gu, "");
  if (/^(?:이동|교통|항공|TRANSFER)$/iu.test(compact)) return "TRANSFER";
  if (/^(?:관광|일정|방문|견학|SIGHTSEEING)$/iu.test(compact)) return "SIGHTSEEING";
  if (/^(?:식사|MEAL)$/iu.test(compact)) return "MEAL";
  if (/^(?:숙박|호텔|ACCOMMODATION)$/iu.test(compact)) return "ACCOMMODATION";
  if (/^(?:기타|OTHER)$/iu.test(compact)) return "OTHER";
  return undefined;
}

function normalizeAiMealSlot(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "breakfast" || normalized === "b" || normalized === "조" || normalized === "조식" || normalized === "아침") return "breakfast";
  if (normalized === "lunch" || normalized === "l" || normalized === "중" || normalized === "중식" || normalized === "점심") return "lunch";
  if (normalized === "dinner" || normalized === "d" || normalized === "석" || normalized === "석식" || normalized === "저녁") return "dinner";
  return undefined;
}

function coerceOptionalObject<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(
    (value) => (value === null || value === undefined ? undefined : value),
    z.object(shape).optional(),
  );
}

const optionalText = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : String(value);
}, z.string().optional());

const optionalNumeric = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/gu, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}, z.number().optional());

const aiItemSchema = z.object({
  type: z.preprocess(normalizeAiItemType, itemTypeSchema.optional()),
  region: optionalText,
  transport: optionalText,
  time: optionalText,
  content: optionalText,
  detail: optionalText,
  mealSlot: z.preprocess(normalizeAiMealSlot, mealSlotSchema.optional()),
  hotel: optionalText,
}).passthrough();

const aiDaySchema = z.object({
  dayNo: z.preprocess((value) => {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const dayToken = /(?:제)?\s*(\d{1,2})\s*일/u.exec(value)?.[1];
      const parsed = dayToken ? Number(dayToken) : Number(value.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }, z.number().int().positive().optional()),
  date: optionalText,
  items: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(aiItemSchema).optional()),
}).passthrough();

const aiOutputSchema = z.object({
  header: coerceOptionalObject({
      groupName: optionalText,
      writtenAt: optionalText,
    }),
  overview: coerceOptionalObject({
      recipient: optionalText,
      cities: optionalText,
      travelPeriod: coerceOptionalObject({
          start: optionalText,
          end: optionalText,
        }),
      passengers: coerceOptionalObject({
          adult: optionalNumeric,
          child: optionalNumeric,
          infant: optionalNumeric,
          escort: optionalNumeric,
          foc: optionalNumeric,
        }),
      singleCharge: optionalNumeric,
      fare: coerceOptionalObject({
          adultPerPerson: optionalNumeric,
          childPerPerson: optionalNumeric,
          infantPerPerson: optionalNumeric,
          total: optionalNumeric,
          totalWithCard: optionalNumeric,
        }),
    }),
  basics: coerceOptionalObject({
      flight: coerceOptionalObject({
          departure: optionalText,
          arrival: optionalText,
          localVehicle: optionalText,
        }),
      accommodation: coerceOptionalObject({
          hotel: optionalText,
          grade: optionalText,
          occupancy: optionalText,
        }),
      included: optionalText,
      excluded: optionalText,
      optionalTour: optionalText,
      shoppingCenters: optionalNumeric,
      notes: optionalText,
    }),
  days: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(aiDaySchema).optional()),
}).passthrough();

interface ParseWithAiInput {
  rawText: string;
  title?: string;
}

export type ItineraryParserSource =
  | "ai"
  | "fast-text"
  | "fallback-tabular"
  | "fallback-no-key"
  | "fallback-ai-error"
  | "fallback-quality";

export type ItineraryParserCandidate =
  | "ai"
  | "deterministic-tabular"
  | "deterministic-narrative";

export interface ItineraryFieldCoverage {
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
}

export interface ItineraryCandidateScore {
  candidate: ItineraryParserCandidate;
  qualityScore: number;
  acceptable: boolean;
  fieldCoverage: ItineraryFieldCoverage;
  meaningfulItemCount: number;
  expectedMinimumItemCount: number;
  suspiciousItemCount: number;
}

export interface ItineraryParseDiagnostics {
  source: ItineraryParserSource;
  aiAttempted: boolean;
  aiError?: string;
  aiMeaningfulItemCount?: number;
  fallbackMeaningfulItemCount?: number;
  expectedMinimumItemCount?: number;
  selectedCandidate?: ItineraryParserCandidate;
  qualityScore?: number;
  warnings?: string[];
  fieldCoverage?: ItineraryFieldCoverage;
  candidateScores?: ItineraryCandidateScore[];
  noiseRemovedCount?: number;
  evidenceCounts?: {
    certain: number;
    candidates: number;
  };
}

export interface ItineraryParseResult {
  itinerary: ItineraryData;
  diagnostics: ItineraryParseDiagnostics;
}

interface ChatChoice {
  message?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
}

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function pad2(value: string): string {
  return value.padStart(2, "0");
}

function normalizeDateToken(line: string): string {
  return line.replace(
    /\b(20\d{2})\s*[./\-년]+\s*(\d{1,2})\s*[./\-월]+\s*(\d{1,2})(?:\s*일)?\b/gu,
    (_match, year: string, month: string, day: string) =>
      `${year}-${pad2(month)}-${pad2(day)}`
  );
}

function preprocessRawText(rawText: string, maxChars = MAX_INPUT_CHARS): string {
  const normalizedNewLine = rawText.replace(/\uFEFF/gu, "").replace(/\r\n?/gu, "\n");
  const lines = normalizedNewLine.split("\n");
  const cleaned: string[] = [];
  let prev = "";

  for (const original of lines) {
    if (!original.trim()) continue;
    let line = original.trimEnd();
    if (!/^[\t|]/u.test(line)) {
      line = line.trimStart();
    }

    // 구분선/장식 라인 제거
    if (/^[=\-_*~]{3,}$/u.test(line)) continue;

    line = line
      .replace(/\t/gu, " | ")
      .replace(/\s+/gu, " ")
      .replace(/(\d{1,2})\s*일\s*차/gu, "$1일차");
    line = line
      .replace(/인\s*천/gu, "인천")
      .replace(/에정/gu, "예정")
      .replace(/\(\s*\)/gu, "");
    line = normalizeDateToken(line);

    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}...`;
    }

    // 연속 중복 라인 제거
    if (line === prev) continue;
    cleaned.push(line);
    prev = line;
  }

  const merged = cleaned.join("\n").trim();
  if (!Number.isFinite(maxChars) || merged.length <= maxChars) return merged;
  return `${merged.slice(0, maxChars)}\n...`;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function scoreAiEvidenceLine(line: string): number {
  const text = cleanText(line);
  if (!text) return 0;
  let score = 0;
  if (/^\[sheet:/u.test(text)) score += /(일정|일정표|상세|세부|견적|호텔|식사)/u.test(text) ? 40 : 8;
  if (extractDayNoFromScheduleLine(text) !== undefined) score += 80;
  if (/(?:제\s*)?\d{1,2}\s*일차?|DAY\s*\d{1,2}/iu.test(text)) score += 55;
  if (/(?:일자|날짜|지역|교통편|시간|세부\s*일정|ITINERARY|MEALS?)/iu.test(text)) score += 35;
  if (/(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：]|breakfast|lunch|dinner)/iu.test(text)) score += 35;
  if (/(?:HOTEL|호텔|숙소|숙박|리조트|check[-\s]?in|체크[-\s]?인)/iu.test(text)) score += 30;
  if (/(?:항공|출발|도착|공항|전용버스|차량|가이드|포함|불포함|선택관광|쇼핑|요금|인원)/u.test(text)) score += 20;
  if (isNoiseLine(text) || isScheduleChromeToken(text)) score -= 40;
  return score;
}

function buildAiPromptText(preprocessedText: string): string {
  if (preprocessedText.length <= MAX_INPUT_CHARS) return preprocessedText;

  const lines = preprocessedText.split("\n");
  const include = new Set<number>();
  let headChars = 0;

  for (let index = 0; index < lines.length && headChars < AI_CONTEXT_HEAD_CHARS; index += 1) {
    const line = lines[index] ?? "";
    headChars += line.length + 1;
    if (!isNoiseLine(line)) include.add(index);
  }

  for (const [index, line] of lines.entries()) {
    if (scoreAiEvidenceLine(line) < 30) continue;
    include.add(index);
    if (index > 0) include.add(index - 1);
    if (index + 1 < lines.length) include.add(index + 1);
  }

  const selected = Array.from(include)
    .sort((left, right) => left - right)
    .map((index) => lines[index] ?? "")
    .filter((line) => line.trim().length > 0);

  const merged = selected.join("\n").trim();
  if (merged.length <= MAX_INPUT_CHARS) return merged;
  return `${merged.slice(0, MAX_INPUT_CHARS)}\n...`;
}

type ItineraryEvidenceKind =
  | "day"
  | "date"
  | "meal"
  | "hotel"
  | "flight"
  | "vehicle"
  | "fare"
  | "passenger"
  | "schedule";

interface ItineraryEvidenceItem {
  kind: ItineraryEvidenceKind;
  value: string;
  sourceLine: string;
  confidence: "certain" | "candidate";
  dayNo?: number;
  slot?: MealSlot;
}

interface ItineraryEvidenceSummary {
  certain: ItineraryEvidenceItem[];
  candidates: ItineraryEvidenceItem[];
}

const MAX_PROMPT_EVIDENCE_PER_GROUP = 80;
const MAX_EVIDENCE_SOURCE_CHARS = 180;

function truncateEvidenceValue(value: string): string {
  const cleaned = cleanText(value).replace(/\s+/gu, " ");
  if (cleaned.length <= MAX_EVIDENCE_SOURCE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_EVIDENCE_SOURCE_CHARS)}...`;
}

function addEvidenceItem(
  summary: ItineraryEvidenceSummary,
  seen: Set<string>,
  item: ItineraryEvidenceItem,
): void {
  const value = truncateEvidenceValue(item.value);
  const sourceLine = truncateEvidenceValue(item.sourceLine);
  if (!value) return;

  const key = [
    item.confidence,
    item.kind,
    item.dayNo ?? "",
    item.slot ?? "",
    normalizeKey(value),
    normalizeKey(sourceLine),
  ].join("|");
  if (seen.has(key)) return;
  seen.add(key);

  const target = item.confidence === "certain" ? summary.certain : summary.candidates;
  if (target.length >= MAX_PROMPT_EVIDENCE_PER_GROUP) return;
  target.push({
    ...item,
    value,
    sourceLine,
  });
}

function collectItineraryEvidence(rawText: string): ItineraryEvidenceSummary {
  const summary: ItineraryEvidenceSummary = { certain: [], candidates: [] };
  const seen = new Set<string>();
  let currentDayNo = 1;

  for (const line of rawText.split("\n")) {
    const text = cleanText(line);
    if (!text || isNoiseLine(text)) continue;

    const parsedDayNo = extractDayNoFromScheduleLine(text);
    if (parsedDayNo !== undefined) {
      currentDayNo = parsedDayNo;
      addEvidenceItem(summary, seen, {
        kind: "day",
        dayNo: parsedDayNo,
        value: `${parsedDayNo}일차`,
        sourceLine: text,
        confidence: "certain",
      });
    }

    const date = parseDateFromAnyText(text);
    if (date) {
      addEvidenceItem(summary, seen, {
        kind: "date",
        dayNo: currentDayNo,
        value: date,
        sourceLine: text,
        confidence: "certain",
      });
    }

    const rawMealMatches = Array.from(text.matchAll(/(?:^|[\s|])([조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]\s*([^|\n]+)/giu));
    for (const match of rawMealMatches) {
      const slot = toMealSlotByToken(match[1] ?? "");
      if (!slot) continue;
      const value = sanitizeMealText(match[2] ?? "", slot);
      if (!value || value === mealSlotLabel(slot)) continue;
      addEvidenceItem(summary, seen, {
        kind: "meal",
        dayNo: currentDayNo,
        slot,
        value,
        sourceLine: text,
        confidence: "certain",
      });
    }

    const columns = splitScheduleColumnsWithTabs(text);
    for (const [index, column] of columns.entries()) {
      const markerMatch = /^([조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*([:：])?\s*$/iu.exec(column);
      const slot = toMealSlotByToken(markerMatch?.[1] ?? "");
      if (!slot) continue;
      const nextValue = columns
        .slice(index + 1)
        .map((value) => cleanText(value))
        .find((value) => value && !isPlaceholderCell(value) && parseDayNoToken(value) === undefined);
      const value = sanitizeMealText(nextValue ?? "", slot);
      if (!value || value === mealSlotLabel(slot)) continue;
      addEvidenceItem(summary, seen, {
        kind: "meal",
        dayNo: currentDayNo,
        slot,
        value,
        sourceLine: text,
        confidence: "certain",
      });
    }

    const hotelName = extractHotelNameFromLine(text);
    if (hotelName) {
      addEvidenceItem(summary, seen, {
        kind: "hotel",
        dayNo: currentDayNo,
        value: hotelName,
        sourceLine: text,
        confidence: "certain",
      });
    }

    const fare = parseMoneyWon(text);
    if (fare !== undefined) {
      addEvidenceItem(summary, seen, {
        kind: "fare",
        value: String(fare),
        sourceLine: text,
        confidence: "candidate",
      });
    }

    const adultCount = parseCountByToken(text, "성인");
    const childCount = parseCountByToken(text, "아동");
    const passenger = [adultCount ? `성인 ${adultCount}` : "", childCount ? `아동 ${childCount}` : ""]
      .filter(Boolean)
      .join(" / ");
    if (passenger) {
      addEvidenceItem(summary, seen, {
        kind: "passenger",
        value: passenger,
        sourceLine: text,
        confidence: "candidate",
      });
    }

    if (/(?:\b[A-Z]{2}\s?\d{3,4}\b|항공|공항|출국|입국|출발|도착)/u.test(text)) {
      addEvidenceItem(summary, seen, {
        kind: "flight",
        dayNo: currentDayNo,
        value: text,
        sourceLine: text,
        confidence: "candidate",
      });
    }

    if (/(?:전용\s*버스|전용\s*차량|차량|버스|송영|가이드\s*미팅)/u.test(text)) {
      addEvidenceItem(summary, seen, {
        kind: "vehicle",
        dayNo: currentDayNo,
        value: text,
        sourceLine: text,
        confidence: "candidate",
      });
    }

    if (
      summary.candidates.length < MAX_PROMPT_EVIDENCE_PER_GROUP &&
      scoreAiEvidenceLine(text) >= 50 &&
      !isScheduleChromeToken(text)
    ) {
      addEvidenceItem(summary, seen, {
        kind: "schedule",
        dayNo: currentDayNo,
        value: text,
        sourceLine: text,
        confidence: "candidate",
      });
    }
  }

  return summary;
}

function formatEvidenceItemForPrompt(item: ItineraryEvidenceItem): string {
  const parts = [`kind=${item.kind}`];
  if (item.dayNo !== undefined) parts.push(`day=${item.dayNo}`);
  if (item.slot) parts.push(`slot=${item.slot}`);
  parts.push(`value="${item.value}"`);
  parts.push(`source="${item.sourceLine}"`);
  return `- ${parts.join(" ")}`;
}

function formatEvidenceForPrompt(summary: ItineraryEvidenceSummary): string {
  const blocks: string[] = [];
  if (summary.certain.length > 0) {
    blocks.push("[확정 evidence]");
    blocks.push(...summary.certain.map(formatEvidenceItemForPrompt));
  }
  if (summary.candidates.length > 0) {
    if (blocks.length > 0) blocks.push("");
    blocks.push("[후보 evidence]");
    blocks.push(...summary.candidates.map(formatEvidenceItemForPrompt));
  }
  return blocks.join("\n");
}

function countEvidenceItems(summary: ItineraryEvidenceSummary): { certain: number; candidates: number } {
  return {
    certain: summary.certain.length,
    candidates: summary.candidates.length,
  };
}

function splitDirectScheduleContent(value: string): { content: string; detail?: string } {
  const structured = splitStructuredScheduleContent(value);
  if (structured.detail) return structured;
  return splitMcpScheduleContent(value);
}

function safeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/gu, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (DATE_RE.test(trimmed)) return trimmed;

  const compact = trimmed.replace(/[./\s]/gu, "-");
  if (/^\d{8}$/u.test(compact)) {
    const yyyy = compact.slice(0, 4);
    const mm = trimmed.slice(4, 6);
    const dd = compact.slice(6, 8);
    return `${yyyy}-${mm}-${dd}`;
  }

  const matchedDate = /(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(compact);
  if (matchedDate?.[1] && matchedDate[2] && matchedDate[3]) {
    return `${matchedDate[1].padStart(4, "0")}-${matchedDate[2].padStart(2, "0")}-${matchedDate[3].padStart(2, "0")}`;
  }

  const koreanDate = /(?:^|\b)(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})일/u.exec(trimmed);
  if (koreanDate?.[1] && koreanDate[2] && koreanDate[3]) {
    return `${koreanDate[1].padStart(4, "0")}-${koreanDate[2].padStart(2, "0")}-${koreanDate[3].padStart(2, "0")}`;
  }

  const shortMonthDay = /^(\d{1,2})-(\d{1,2})$/u.exec(compact);
  if (shortMonthDay?.[1] && shortMonthDay[2]) {
    const year = currentYearInKorea();
    return `${year}-${shortMonthDay[1].padStart(2, "0")}-${shortMonthDay[2].padStart(2, "0")}`;
  }

  const date = new Date(compact);
  if (Number.isNaN(date.getTime())) return ISO_DATE_TODAY;
  return dateStringInKorea(date);
}

function normalizeOptionalDate(value: string | undefined): string {
  const trimmed = cleanText(value);
  if (!trimmed) return "";
  const normalized = normalizeDate(trimmed);
  return normalized === ISO_DATE_TODAY && !parseDateFromAnyText(trimmed) ? "" : normalized;
}

function fallbackType(content: string): ScheduleItemType {
  const text = content.toLowerCase();
  if (
    /(HOTEL\s*-\s*|숙박|리조트|resort|check[-\s]?in|체크[-\s]?인|체크[-\s]?아웃|호텔\s*(?:투숙|휴식)|객실|room|\b\d+\s*박\b)/iu
      .test(content)
  ) {
    return "ACCOMMODATION";
  }
  const hasMeal = /(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：]|meal|breakfast|lunch|dinner)/iu.test(content);
  const hasMovement = /(이동|항공|차량|버스|공항|flight|transfer|출발|도착|탑승|출국|출국수속|입국|입국수속|미팅|송영)/u.test(text);
  const hasActivity = /(관광|투어|체험|쇼핑|골프|관람|견학|캠퍼스|박물관|식물원|차이나타운|머라이언|유니버셜|가든스|리버원더스|야경쇼)/u.test(content);
  const mealContext = /(호텔|숙박|체크인|체크아웃|휴식|투숙)/u.test(content);
  const nonMealText = cleanText(
    content
      .replace(/(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：]|meal|breakfast|lunch|dinner)/giu, "")
      .replace(/[|,/()[\]·•\-\s]+/gu, " ")
  );
  if (mealContext && hasMeal && !hasMovement && !hasActivity) return "OTHER";
  if (hasMeal && !hasMovement && !hasActivity && nonMealText.length <= 8) return "MEAL";
  if (hasMovement) return "TRANSFER";
  if (hasActivity) return "SIGHTSEEING";
  if (hasMeal && !hasMovement && !hasActivity && nonMealText.length <= 8) return "MEAL";
  return "OTHER";
}

function inferMealSlot(content: string): MealSlot | undefined {
  if (/(조식|아침)/u.test(content)) return "breakfast";
  if (/(중식|점심)/u.test(content)) return "lunch";
  if (/(석식|저녁)/u.test(content)) return "dinner";
  return undefined;
}

function mealSlotLabel(slot: MealSlot): string {
  if (slot === "breakfast") return "조식";
  if (slot === "lunch") return "중식";
  return "석식";
}

function toMealSlotByToken(token: string): MealSlot | undefined {
  const normalized = cleanText(token).toLowerCase();
  if (normalized === "조" || normalized === "조식" || normalized === "아침" || normalized === "b" || normalized === "breakfast") return "breakfast";
  if (normalized === "중" || normalized === "중식" || normalized === "점심" || normalized === "l" || normalized === "lunch") return "lunch";
  if (normalized === "석" || normalized === "석식" || normalized === "저녁" || normalized === "d" || normalized === "dinner") return "dinner";
  return undefined;
}

function sanitizeMealText(text: string, slot: MealSlot): string {
  const cleaned = cleanText(
    text
      .replace(/\(\s*예정\s*\)|예정|후$/gu, "")
      .replace(/^[|•·\-:：\s]+|[|•·\-:：\s]+$/gu, "")
      .replace(/\s{2,}/gu, " ")
  );
  if (!cleaned || cleaned.length <= 1) return mealSlotLabel(slot);
  return cleaned;
}

function stripPostMealConnector(text: string): string {
  return cleanText(text.replace(/^후(?:\s+|$)/u, ""));
}

function parseMealFromToken(
  token: string,
  fallbackSlot?: MealSlot,
): { slot: MealSlot; text: string } | undefined {
  const cleaned = cleanText(token)
    .replace(/^[·•\-\s|]+/u, "")
    .replace(/^\(\s*(\S+)\s*\)\s*/u, "$1 ");

  const colonMatch = /^([조중석bld]|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]\s*([^|]+)$/iu.exec(cleaned);
  if (colonMatch) {
    const slot = toMealSlotByToken(colonMatch[1] ?? "");
    if (slot) return { slot, text: sanitizeMealText(colonMatch[2] ?? "", slot) };
  }

  const hyphenMatch = /^([조중석]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[-–—]\s*([^|]+)$/iu.exec(cleaned);
  if (hyphenMatch) {
    const slot = toMealSlotByToken(hyphenMatch[1] ?? "");
    if (slot) return { slot, text: sanitizeMealText(hyphenMatch[2] ?? "", slot) };
  }

  const directMatch = /^(조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)(?:\s*[:：]?\s*)?(.*)$/iu.exec(cleaned);
  if (directMatch) {
    const slot = toMealSlotByToken(directMatch[1] ?? "");
    if (!slot) return undefined;
    const rawDetail = cleanText(directMatch[2] ?? "");
    if (/^후(?:\s+|$)/u.test(rawDetail)) {
      return { slot, text: mealSlotLabel(slot) };
    }
    return { slot, text: sanitizeMealText(rawDetail, slot) };
  }

  const fallbackSlotText = fallbackSlot
    ? sanitizeMealText(cleaned, fallbackSlot)
    : "";
  if (fallbackSlot && fallbackSlotText) {
    return { slot: fallbackSlot, text: fallbackSlotText };
  }

  return undefined;
}

function extractMealsFromContent(content: string): {
  strippedContent: string;
  meals: Array<{ slot: MealSlot; text: string }>;
} {
  const meals: Array<{ slot: MealSlot; text: string }> = [];
  let working = content;

  const segments = working.split("|").map((entry) => cleanText(entry));
  const keepSegment = segments.map(() => true);

  const removeSegment = (index: number): void => {
    if (index >= 0 && index < keepSegment.length) keepSegment[index] = false;
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const standaloneParsed = parseMealFromToken(segment);
    const next = segments[index + 1];
    if (
      standaloneParsed &&
      standaloneParsed.text === mealSlotLabel(standaloneParsed.slot)
    ) {
      const segmentRemainder = stripPostMealConnector(
        cleanText(segment.replace(/^(조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*/iu, ""))
      );
      if (segmentRemainder && segmentRemainder !== segment) {
        meals.push(standaloneParsed);
        segments[index] = segmentRemainder;
        continue;
      }
      const nextRemainder = next ? stripPostMealConnector(next) : "";
      if (next && next !== nextRemainder) {
        meals.push(standaloneParsed);
        removeSegment(index);
        if (nextRemainder) {
          segments[index + 1] = nextRemainder;
        } else {
          removeSegment(index + 1);
        }
        continue;
      }
      if (!next) {
        meals.push(standaloneParsed);
        removeSegment(index);
        continue;
      }
    }
    if (!/식사\s*구분/u.test(segment)) continue;

    const withoutPrefix = cleanText(segment.replace(/^식사\s*구분\b/u, ""));
    if (withoutPrefix) {
      const parsed = parseMealFromToken(withoutPrefix);
      if (!parsed) {
        removeSegment(index);
        continue;
      }
      removeSegment(index);
      if (parsed.text === mealSlotLabel(parsed.slot) && next) {
        const nextIsMeal = /^(조식|중식|석식|아침|점심|저녁)\b/u.test(next);
        const nextRemainder = stripPostMealConnector(next);
        if (next !== nextRemainder) {
          meals.push(parsed);
          if (nextRemainder) {
            segments[index + 1] = nextRemainder;
          } else {
            removeSegment(index + 1);
          }
          continue;
        }
        if (!nextIsMeal) {
          const combinedParsed = parseMealFromToken(`${mealSlotLabel(parsed.slot)} ${next}`, parsed.slot);
          if (combinedParsed) {
            meals.push(combinedParsed);
            removeSegment(index + 1);
          } else {
            meals.push(parsed);
          }
          continue;
        }
      }
      meals.push(parsed);
      continue;
    }

    if (next) {
      const nextParsed = parseMealFromToken(next);
      if (nextParsed) {
        removeSegment(index);
        removeSegment(index + 1);
        const nextIsOnlySlot = nextParsed.text === mealSlotLabel(nextParsed.slot);
        const after = segments[index + 2];
        if (nextIsOnlySlot && after && !/식사\s*구분/u.test(after)) {
          const afterRemainder = stripPostMealConnector(after);
          if (after !== afterRemainder) {
            meals.push(nextParsed);
            if (afterRemainder) {
              segments[index + 2] = afterRemainder;
            } else {
              removeSegment(index + 2);
            }
            continue;
          }
          const slotLabel = nextParsed.slot === "breakfast" ? "조식" : nextParsed.slot === "lunch" ? "중식" : "석식";
          const withDetail = parseMealFromToken(`${slotLabel} ${after}`, nextParsed.slot);
          if (withDetail) {
            meals.push(withDetail);
            removeSegment(index + 2);
            continue;
          }
        }
        meals.push(nextParsed);
      }
    }
  }

  const cleanedSegments = segments.filter((_, idx) => keepSegment[idx]);
  working = cleanedSegments.join(" | ");

  const explicitMealPattern = /(^|[\s|])([조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]\s*([^|\n]+)/giu;
  for (const match of working.matchAll(explicitMealPattern)) {
    const slot = toMealSlotByToken(match[2] ?? "");
    if (!slot) continue;
    const text = sanitizeMealText(match[3] ?? "", slot);
    meals.push({ slot, text });
  }
  working = working.replace(explicitMealPattern, (_raw: string, prefix: string) => prefix);

  const parenthesizedAfterMealPattern = /(조식|중식|석식|아침|점심|저녁)\s*\(\s*([^)]+)\s*\)\s*후/gu;
  working = working.replace(parenthesizedAfterMealPattern, (_raw: string, token: string, detail: string) => {
    const slot = toMealSlotByToken(token);
    if (slot) {
      meals.push({ slot, text: sanitizeMealText(detail, slot) });
    }
    return "";
  });

  const afterMealPattern = /(조식|중식|석식|아침|점심|저녁)\s*후/gu;
  working = working.replace(afterMealPattern, (_raw: string, token: string) => {
    const slot = toMealSlotByToken(token);
    if (slot) meals.push({ slot, text: mealSlotLabel(slot) });
    return "";
  });

  const standaloneMealPrefixPattern = /(?:^|\|)\s*(조식|중식|석식|아침|점심|저녁)\s+([^|]+?)(?=\s*(?:\||$))/gu;
  working = working.replace(standaloneMealPrefixPattern, (_raw: string, token: string, detail: string) => {
    const slot = toMealSlotByToken(token);
    if (!slot) return "";
    const cleanedDetail = sanitizeMealText(detail, slot);
    if (cleanedDetail) meals.push({ slot, text: cleanedDetail });
    return "";
  });

  const standaloneMealPattern = /^[•·\s-]*(조식|중식|석식|아침|점심|저녁)\s*$/u;
  if (standaloneMealPattern.test(cleanText(working))) {
    const slot = toMealSlotByToken(cleanText(working).replace(/[•·\s-]/gu, ""));
    if (slot) meals.push({ slot, text: mealSlotLabel(slot) });
    working = "";
  }

  const dedupedMeals = meals.filter((meal, index) => {
    const key = `${meal.slot}|${normalizeKey(meal.text)}`;
    return meals.findIndex((m) => `${m.slot}|${normalizeKey(m.text)}` === key) === index;
  });

  const strippedContent = cleanText(
    working
      .replace(/\s*\|\s*/gu, " | ")
      .replace(/\s{2,}/gu, " ")
      .replace(/(?:^\|\s*|\s*\|$)/gu, "")
  );

  return { strippedContent, meals: dedupedMeals };
}

function fillDateWindow(days: Array<{ dayNo: number; date: string }>): {
  start: string;
  end: string;
} {
  if (days.length === 0) {
    return { start: ISO_DATE_TODAY, end: ISO_DATE_TODAY };
  }
  const sorted = [...days].sort((a, b) => a.dayNo - b.dayNo);
  return {
    start: sorted[0]?.date ?? ISO_DATE_TODAY,
    end: sorted[sorted.length - 1]?.date ?? ISO_DATE_TODAY,
  };
}

function addDays(base: string, offset: number): string {
  const [yRaw, mRaw, dRaw] = base.split("-").map(Number);
  const y = yRaw ?? 0;
  const m = mRaw ?? 1;
  const d = dRaw ?? 1;
  const date = new Date(Date.UTC(y, m - 1, d) + offset * 24 * 60 * 60 * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeMealsInItems(items: ScheduleItem[]): ScheduleItem[] {
  const normalized: ScheduleItem[] = [];
  const slotToIndex = new Map<MealSlot, number>();

  for (const item of items) {
    if (item.type !== "MEAL" || !item.mealSlot) {
      normalized.push(item);
      continue;
    }

    const existingIndex = slotToIndex.get(item.mealSlot);
    if (existingIndex === undefined) {
      slotToIndex.set(item.mealSlot, normalized.length);
      normalized.push(item);
      continue;
    }

    const existing = normalized[existingIndex];
    if (existing && existing.type === "MEAL") {
      normalized[existingIndex] = mergeMealItems(existing, item);
      continue;
    }

    slotToIndex.set(item.mealSlot, normalized.length);
    normalized.push(item);
  }

  return normalized;
}

function normalizeItemDedupeKey(item: ScheduleItem): string {
  const time = cleanText(item.time ?? "");
  const content = normalizeKey(item.content);
  const mealContent =
    item.type === "MEAL" ? normalizeKey(item.meal?.[item.mealSlot ?? "breakfast"] ?? item.content) : "";
  const hotel = item.type === "ACCOMMODATION" ? normalizeKey(item.hotel ?? "") : "";
  return `${item.type}|${time}|${item.mealSlot ?? ""}|${content}|${mealContent}|${hotel}`;
}

function dedupeItems(items: ScheduleItem[]): ScheduleItem[] {
  const normalized: ScheduleItem[] = [];
  const seenKeys = new Set<string>();
  const slotToIndex = new Map<MealSlot, number>();

  for (const item of items) {
    if (item.type === "MEAL" && item.mealSlot) {
      const existingIndex = slotToIndex.get(item.mealSlot);
      if (existingIndex === undefined) {
        slotToIndex.set(item.mealSlot, normalized.length);
        normalized.push(item);
        continue;
      }

      const existing = normalized[existingIndex];
      if (existing && existing.type === "MEAL") {
        normalized[existingIndex] = mergeMealItems(existing, item);
      }
      continue;
    }

    const dedupeKey = normalizeItemDedupeKey(item);
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    normalized.push(item);
  }

  return normalized;
}

function parseDayNoToken(text: string): number | undefined {
  const compact = text.replace(/\s+/gu, "");
  const normalized = compact.replace(/^\*(?=(?:제)?\d{1,2}일차?\*)/u, "").replace(/\*$/u, "").replace(/[:：\-\s]$/u, "");
  const matched = /^(?:제)?(\d{1,2})일차?$/u.exec(normalized);
  if (!matched?.[1]) return undefined;
  const dayNo = Number(matched[1]);
  return Number.isFinite(dayNo) && dayNo > 0 ? dayNo : undefined;
}

function extractDayNoFromScheduleLine(line: string): number | undefined {
  const columns = splitScheduleColumnsWithTabs(line);
  const firstValue = columns.map((column) => cleanText(column)).find(Boolean);
  if (firstValue && /^\d{1,2}$/u.test(firstValue) && /(?:\t|\|)/u.test(line)) {
    const dayNo = Number(firstValue);
    if (Number.isFinite(dayNo) && dayNo > 0) return dayNo;
  }
  for (const column of columns) {
    const parsed = parseDayNoToken(column);
    if (parsed !== undefined) return parsed;

    const embedded = /(?:^|\s)(?:제\s*(\d{1,2})\s*일(?:차)?|(\d{1,2})\s*일차)(?:\s|$)/u.exec(column);
    if (embedded?.[1]) {
      const dayNo = Number(embedded[1]);
      if (Number.isFinite(dayNo) && dayNo > 0) return dayNo;
    }
    if (embedded?.[2]) {
      const dayNo = Number(embedded[2]);
      if (Number.isFinite(dayNo) && dayNo > 0) return dayNo;
    }
  }

  const matched = /(?:^|[\s|])(?:제\s*(\d{1,2})\s*일(?:차)?|(\d{1,2})\s*일차)(?:[\s|]|$)/u.exec(line);
  const dayNo = Number(matched?.[1] ?? matched?.[2] ?? "0");
  return Number.isFinite(dayNo) && dayNo > 0 ? dayNo : undefined;
}

function compactText(value: string): string {
  return cleanText(value).replace(/\s+/gu, "");
}

function splitScheduleColumns(line: string): string[] {
  return line
    .split("|")
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

const SCHEDULE_HEADER_TOKENS = new Set([
  "date",
  "city",
  "trsft",
  "time",
  "itinerary",
  "meals",
  "meal",
  "항목구분",
  "지역",
  "교통편",
  "시간",
  "내용",
  "상세",
  "식사",
  "숙박",
  "이동",
  "관광",
  "작성일",
  "항목추가",
  "개요",
  "일정표",
  "일자",
  "날짜",
  "일정",
  "세부일정",
]);

function normalizeHeaderToken(value: string): string {
  return cleanText(value)
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function isStructuredHeaderLine(text: string): boolean {
  const cols = splitScheduleColumnsWithTabs(text).filter(Boolean);
  if (cols.length < 3) return false;
  const headerMatched = cols.filter((token) => SCHEDULE_HEADER_TOKENS.has(normalizeHeaderToken(token))).length;
  if (headerMatched === 0) return false;
  return headerMatched >= Math.max(2, Math.floor(cols.length / 2));
}

function isSummaryTrailerLine(text: string): boolean {
  const compact = cleanText(text);
  if (!compact) return false;
  if (/^(?:[▶■]|▶\s*|■\s*)/u.test(compact)) return true;
  const collapsed = compact.replace(/\s+/gu, "");
  if (/^(?:TOUR\s*FEE|TOURFEE|참고\s*사항|포함\s*사항|불포함\s*사항|기타\s*사항)(?:$|[\s|:：])/iu.test(compact)) {
    return true;
  }
  if (/^(?:\d+\.)?\s*(?:TOUR\s*FEE|TOURFEE|견적번호|기준코드|작성일|출발일|도착일|인원|차량|호텔|포함사항|불포함사항|기타사항|참고사항|비고|지상비|여행요금|요금|금액|환율|요청|쇼핑센터|쇼핑센터|쇼핑|선택관광|옵션투어|유의사항)\b/u.test(
    compact,
  )) return true;
  if (/^\*+(?:\s*)?(?:견적번호|기준코드|참고|포함|불포함|기타|출발|인원|차량|호텔)/u.test(compact)) {
    return true;
  }
  return /^(?:TOUR\s*FEE|참고사항|포함사항|불포함사항|기타사항|견적번호|기준코드)(?:$|[ :])/u.test(collapsed);
}

function isEditablePreviewSectionHeader(text: string): boolean {
  const compact = cleanText(text).replace(/\s+/gu, "");
  return /^(?:<<|\*\*)(?:상품정보|항공\/교통|숙박|포함\/불포함|상세일정)(?:>>|\*\*)$/u.test(compact);
}

function isScheduleChromeToken(text: string): boolean {
  const compact = cleanText(text).replace(/\s+/gu, "");
  if (!compact) return false;
  if (isEditablePreviewSectionHeader(text)) return true;
  if (/^(?:항목구분|지역|교통편|시간|내용|식사|숙박|이동|관광|항목추가|개요|여정)$/u.test(compact)) {
    return true;
  }
  if (/^\[?\s*(?:간단일정|상세일정|일정표?)\s*\]?$/u.test(compact)) return true;
  if (isStructuredHeaderLine(text)) return true;
  if (isSummaryTrailerLine(text)) return true;
  if (/^\d+\s*개\s*항목$/u.test(compact)) return true;
  if (/^✕+$/u.test(compact)) return true;
  if (/^\+$/u.test(compact)) return true;
  if (compact.includes("일정은변경")) return true;
  return false;
}

function isLikelyMealText(value: string): boolean {
  const compact = cleanText(value).replace(/\s+/gu, "");
  if (!compact) return false;
  return /(?:식사\s*구분|[조중석]식|[조중석][:：]|조식|중식|석식|아침|점심|저녁|\b[BLD]\s*[:：])/iu.test(compact);
}

function isEmptyMealLabel(value: string): boolean {
  const normalized = cleanText(value).replace(/[\s•·\-]+/gu, "");
  return normalized === "조식" || normalized === "중식" || normalized === "석식" || normalized === "아침" || normalized === "점심" || normalized === "저녁" || normalized === "조" || normalized === "중" || normalized === "석";
}

function mealTextScore(value: string): number {
  const normalized = cleanText(value);
  if (!normalized) return 0;
  if (isEmptyMealLabel(normalized)) return 0;
  let score = normalized.length;
  if (/(?:식사\s*구분|[조중석]\s*[:：]|조식|중식|석식|아침|점심|저녁|\b[BLD]\s*[:：])/iu.test(normalized)) {
    score -= 2;
  }
  if (/^(?:후)(?:\s|$)/u.test(normalized) || /\s후\s/u.test(normalized)) score -= 40;
  if (/(관광|투어|체험|쇼핑|골프|관람|견학|캠퍼스|박물관|식물원|차이나타운|머라이언|유니버셜|가든스|리버원더스|야경쇼|이동|공항|출발|도착|미팅)/u.test(normalized)) {
    score -= 30;
  }
  if (/후$/u.test(normalized)) score -= 1;
  if (/예정$/u.test(normalized)) score -= 1;
  return score;
}

function pickMealText(a: string, b: string): string {
  const normalizedA = cleanText(a);
  const normalizedB = cleanText(b);
  const scoreA = mealTextScore(normalizedA);
  const scoreB = mealTextScore(normalizedB);
  if (scoreA === scoreB) {
    return normalizedA.length >= normalizedB.length ? normalizedA : normalizedB;
  }
  return scoreA > scoreB ? normalizedA : normalizedB;
}

function mergeMealItems(existing: ScheduleItem, incoming: ScheduleItem): ScheduleItem {
  if (existing.type !== "MEAL" || incoming.type !== "MEAL" || existing.mealSlot !== incoming.mealSlot) {
    return existing;
  }
  const slot = existing.mealSlot;
  if (!slot) return existing;

  const mergedContent = pickMealText(existing.content, incoming.content);
  const existingMeal = existing.meal?.[slot] ?? existing.content;
  const incomingMeal = incoming.meal?.[slot] ?? incoming.content;

  return {
    ...existing,
    content: mergedContent,
    ...(incoming.transport || existing.transport ? { transport: incoming.transport || existing.transport } : {}),
    ...(incoming.region || existing.region ? { region: incoming.region || existing.region } : {}),
    ...(incoming.time || existing.time ? { time: incoming.time || existing.time } : {}),
    meal: {
      ...(existing.meal ?? {}),
      [slot]: pickMealText(existingMeal, incomingMeal),
    },
  };
}

function withoutRegionAndTransport(item: ScheduleItem, preserveItemIds?: ReadonlySet<string>): ScheduleItem {
  if (preserveItemIds?.has(item.id)) return item;
  const next = { ...item };
  delete next.region;
  delete next.transport;
  return next;
}

function stripRegionAndTransportFromData(
  data: ItineraryData,
  preserveItemIds?: ReadonlySet<string>,
): ItineraryData {
  return {
    ...data,
    days: data.days.map((day) => ({
      ...day,
      items: day.items.map((item) => withoutRegionAndTransport(item, preserveItemIds)),
    })),
  };
}

function isDayLabelToken(text: string): boolean {
  const value = cleanText(text);
  const compact = compactText(value);
  if (!value) return false;
  if (parseDayNoToken(value) !== undefined) return true;
  if (/^\(?[월화수목금토일]\)?$/u.test(value)) return true;
  if (/^(?:mon|tue|wed|thu|fri|sat|sun)\b/i.test(value)) return true;
  if (/^(?:mon|tue|wed|thu|fri|sat|sun)\s+[a-z]{3}\s+\d{1,2}\s+\d{4}\b/i.test(value)) return true;
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/u.test(value)) return true;
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/u.test(value)) return true;
  if (/^\d{1,2}\/\d{1,2}\s*\([^)]+\)$/u.test(value)) return true;
  if (/^\d{1,2}월\d{1,2}일$/u.test(compact)) return true;
  return false;
}

function isPlaceholderCell(value: string): boolean {
  const compact = cleanText(value).replace(/\s+/gu, "").toLowerCase();
  if (!compact) return true;
  if (/^(?:▶|■|▸|►|→)$/u.test(compact)) return true;
  if (isScheduleChromeToken(value)) return true;
  if (/^(?:예|샘플):?/u.test(compact)) {
    return true;
  }
  if (/^(?:https?|www)$/u.test(compact)) return true;
  if (/^예상/u.test(compact)) return true;
  if (/^\d{1,2}:\d{2}$/u.test(compact)) return true;
  if (compact === "항공" || compact === "버스" || compact === "전용버스" || compact === "차량") return true;
  if (compact === "학교") return true;
  return compact === "일정표";
}

function isLikelyTransport(text: string): boolean {
  const value = cleanText(text);
  if (!value) return false;
  if (isPlaceholderCell(value)) return false;
  if (/(조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：]|meal|breakfast|lunch|dinner)/iu.test(value)) return false;
  if (/\b(?:OZ|KE|LJ|BX|TW|ZE|RS|7C)\d{2,4}\b/u.test(value)) return true;
  if (value.length > 20) return false;
  return /^(?:전용버스|버스|항공|항공편|차량|택시|지하철|열차|페리|도보|기내)$/u.test(value)
    || /(전용버스|항공편?)/u.test(value);
}

function isLikelyRegion(text: string): boolean {
  const value = cleanText(text);
  const compact = compactText(value);
  if (!value) return false;
  if (isScheduleChromeToken(value)) return false;
  if (isPlaceholderCell(value)) return false;
  if (/:|：/.test(value)) return false;
  if (isDayLabelToken(value)) return false;
  if (isLikelyTransport(value)) return false;
  if (extractTimeToken(value)) return false;
  if (/^\d+$/u.test(compact)) return false;
  if (/^(?:학교|싱가포르본진일정표|일정표|교통편|예상|항공|버스|차량|차로|공항|입국|출국|입국수속|출국수속|미팅|체크인|기내식|피켓명|이동|숙박|호텔|항목구분|지역|시간|내용|식사|조식|중식|석식|아침|점심|저녁|체크아웃|버스티켓|전용버스)$/u.test(
    compact
  )) {
    return false;
  }
  if (
    /(일정표|에정|이동|항공|공항|버스|차량|차로|탑승|출발|도착|입국|출국|입국수속|출국수속|미팅|체크인|기내식|교통)/u.test(
      compact
    )
  ) {
    return false;
  }
  if (
    /(예정|확인|출발|도착|탑승|이동|견학|미팅|해산|인원|가이드|조식|중식|석식|아침|점심|저녁|기내식|호텔로이동|체크인)/u.test(
      compact
    )
  ) {
    return false;
  }
  if (compact.length <= 1) return false;
  return value.length <= 24;
}

function extractTimeToken(text: string): string {
  const matched = /\b([01]?\d|2[0-3]):([0-5]\d)\b/u.exec(text);
  if (!matched?.[1] || !matched[2]) return "";
  return `${matched[1].padStart(2, "0")}:${matched[2]}`;
}

function isNoiseLine(text: string): boolean {
  if (/날\s*짜.*지\s*역.*교통편.*(세\s*부\s*일\s*정|내용)/u.test(text)) return true;
  if (/^[*♣\s]*상기 일정은 .*변경/u.test(text)) return true;
  if (/^(?:일자\s*\(?날짜\)?|일자|날짜)$/u.test(cleanText(text))) return true;
  if (/^\S.*\d+\s*일\s*일정표$/u.test(cleanText(text))) return true;
  if (/^(?:\d+\.)?\s*(?:TOUR\s*FEE|참고사항|포함사항|불포함사항|기타사항|견적번호|기준코드|환율|여행요금|요금|금액)/u.test(text)) return true;
  if (isScheduleChromeToken(text)) return true;
  if (/작성일|일자별\s*일정|항목추가/gu.test(text)) return true;
  return false;
}

function parsePipeColumns(text: string): {
  dayNo?: number;
  region?: string;
  transport?: string;
  time?: string;
  content?: string;
} {
  const rawCols = splitScheduleColumns(text);
  const hasCellBoundary = /(?:\t|\|)/u.test(text);
  if (rawCols.length === 0) return {};
  if (rawCols.length < 2 && !hasCellBoundary) return {};

  const cols = [...rawCols];
  let dayNo: number | undefined;

  while (cols.length > 0) {
    const first = cols[0] ?? "";
    const parsedDayNo = parseDayNoToken(first);
    if (parsedDayNo !== undefined) {
      dayNo = parsedDayNo;
      cols.shift();
      continue;
    }
    if (/^\d{1,2}$/u.test(first)) {
      const numericDayNo = Number(first);
      if (Number.isFinite(numericDayNo) && numericDayNo > 0) {
        dayNo = numericDayNo;
        cols.shift();
        continue;
      }
    }
    if (isDayLabelToken(first)) {
      cols.shift();
      continue;
    }
    break;
  }

  if (cols.length === 0) {
    return dayNo !== undefined ? { dayNo } : {};
  }
  if (cols.length === 1 && hasCellBoundary) {
    const value = cleanText(cols[0] ?? "");
    return {
      ...(dayNo !== undefined ? { dayNo } : {}),
      ...(
        value &&
        !isPlaceholderCell(value) &&
        !isDayLabelToken(value) &&
        !isStructuredHeaderLine(text) &&
        !isSummaryTrailerLine(text)
          ? { content: value }
          : {}
      ),
    };
  }

  let region = "";
  let transport = "";
  let detail = "";
  const values = cols
    .map((value) => cleanText(value))
    .filter((value, index, source) => {
      if (!value || isPlaceholderCell(value)) return false;
      if (isDayLabelToken(value)) return false;
      if (/^(?:[조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]?$/iu.test(value)) return false;
      const previous = source[index - 1] ? cleanText(source[index - 1]) : "";
      if (/^(?:[조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]?$/iu.test(previous)) return false;
      return true;
    });

  if (values.length === 0) {
    return dayNo !== undefined ? { dayNo } : {};
  }

  if (isStructuredHeaderLine(text) || isSummaryTrailerLine(text)) {
    return dayNo !== undefined ? { dayNo } : {};
  }

  if (values.length === 1) {
    return {
      ...(dayNo !== undefined ? { dayNo } : {}),
      ...(cleanText(values[0]).length > 0 ? { content: values[0] } : {}),
    };
  }

  const isHotelLike = /(HOTEL\s*-\s*|숙박|리조트|resort|check[-\s]?in|객실|\b\d+\s*박\b|호텔\s*복귀|호텔로\s*이동|호텔\s*휴식)/iu.test(
    values[0] ?? ""
  );
  if (isHotelLike && values.length === 2) {
    return {
      ...(dayNo !== undefined ? { dayNo } : {}),
      content: cleanText(`${values[0]} | ${values[1]}`),
    };
  }

  const transportCandidates = values
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => isLikelyTransport(value));
  const transportCandidate = transportCandidates[0];
  const transportIndex = transportCandidate ? transportCandidate.index : -1;

  if (
    values.length === 2 &&
    isLikelyMealText(values[1] ?? "")
    && !isLikelyRegion(values[0] ?? "")
    && (cleanText(values[0] ?? "").length > 4)
  ) {
    return {
      ...(dayNo !== undefined ? { dayNo } : {}),
      ...(transportIndex === 0 && transportCandidate ? { transport: values[transportIndex] } : {}),
      content: cleanText(values[0]),
    };
  }

  const regionCandidate = values
    .map((value, index) => ({ value, index }))
    .find(({ index, value }) => index !== transportIndex && isLikelyRegion(value));
  const regionIndex = regionCandidate ? regionCandidate.index : -1;

  if (regionIndex !== -1) region = values[regionIndex] ?? "";
  if (transportIndex !== -1) transport = values[transportIndex] ?? "";

  detail = cleanText(
    values
      .map((value, index) => (index === regionIndex || index === transportIndex ? "" : value))
      .filter(Boolean)
      .join(" | ")
  );

  if (!detail && regionIndex !== -1 && transportIndex !== -1) {
    detail = cleanText(values.find((_, index) => index !== regionIndex && index !== transportIndex) ?? "");
  }
  if (!detail && values.length >= 2) {
    detail = cleanText(values.join(" | "));
  }

  const time = extractTimeToken(detail);
  if (time) {
    detail = cleanText(detail.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u, ""));
  }

  return {
    ...(dayNo !== undefined ? { dayNo } : {}),
    ...(region ? { region } : {}),
    ...(transport ? { transport } : {}),
    ...(time ? { time } : {}),
    ...(detail ? { content: detail } : {}),
  };
}

type ScheduleHeaderIndexMap = {
  dayIndex?: number;
  dateIndex?: number;
  regionIndex?: number;
  transportIndex?: number;
  timeIndex?: number;
  contentIndex?: number;
  detailIndex?: number;
  recognizedCount: number;
};

function splitScheduleColumnsWithTabs(line: string): string[] {
  return line.split(/\t|\|/gu).map((value) => cleanText(value));
}

function detectScheduleHeader(columns: string[]): ScheduleHeaderIndexMap | null {
  if (columns.length < 3) return null;
  const map: ScheduleHeaderIndexMap = {
    recognizedCount: 0,
  };

  for (const [index, rawColumn] of columns.entries()) {
    const token = normalizeHeaderToken(rawColumn);
    if (!token) continue;

    if (/(?:항목구분|dayno|day|제\d*일차|일차|차수|daynumber)/u.test(token)) {
      if (map.dayIndex === undefined) map.dayIndex = index;
      map.recognizedCount += 1;
      continue;
    }
    if (/(?:여행일|일자|날짜|date|start|end|날짜표기)/u.test(token)) {
      if (map.dateIndex === undefined) map.dateIndex = index;
      map.recognizedCount += 1;
      continue;
    }
    if (/(?:지역|도시|city|region)/u.test(token)) {
      if (map.regionIndex === undefined) map.regionIndex = index;
      map.recognizedCount += 1;
      continue;
    }
    if (/(?:교통편|교통|차량|항공|항공편|transit|transport|trsft)/u.test(token)) {
      if (map.transportIndex === undefined) map.transportIndex = index;
      map.recognizedCount += 1;
      continue;
    }
    if (/(?:시간|time)/u.test(token)) {
      if (map.timeIndex === undefined) map.timeIndex = index;
      map.recognizedCount += 1;
      continue;
    }
    if (/(?:항목구분|일정|내용|itinerary|content|세부|schedule)/u.test(token)) {
      if (map.contentIndex === undefined) map.contentIndex = index;
      map.recognizedCount += 1;
      continue;
    }
    if (/(?:상세|meal|meals|식사)/u.test(token)) {
      if (map.detailIndex === undefined) map.detailIndex = index;
      map.recognizedCount += 1;
      continue;
    }
  }

  if (map.contentIndex === undefined) return null;
  if (map.recognizedCount < 2) return null;
  return map;
}

function detectScheduleHeaderFromLines(lines: string[]): ScheduleHeaderIndexMap | null {
  const candidateLines = lines.filter((line) => !isSummaryTrailerLine(line));
  for (const line of candidateLines.slice(0, 80)) {
    const columns = splitScheduleColumnsWithTabs(line);
    const header = detectScheduleHeader(columns);
    if (header) return header;
  }
  return null;
}

function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?:oz|ke|lj|bx|tw|ze|rs|7c)\d{2,4}\b/gu, "")
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/gu, "")
    .replace(/(?:조식|중식|석식|아침|점심|저녁|[조중석]\s*[:：]|\b[BLD]\s*[:：]|meal|breakfast|lunch|dinner)/giu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isNoisyScheduleContent(value: string): boolean {
  const text = cleanText(value);
  if (!text) return true;
  const compact = text.replace(/\s+/gu, "").toLowerCase();
  if (compact === "[objectobject]") return true;
  if (/^\[?견적서\]?/u.test(text)) return true;
  if (/^https?:\/\/|^www\./iu.test(compact)) return true;
  if (/^\(?[ldb]\)?$/iu.test(compact)) return true;
  if (/^(?:attn|from|to)[:：]?$/iu.test(compact)) return true;
  if (/^[hd]otel$/iu.test(compact)) return true;
  if (/^호텔\|?[bld]?$/iu.test(compact)) return true;
  if (/^호텔\|[bld]$/iu.test(compact)) return true;
  if (/^(?:[ldb])[:：][^a-z가-힣0-9]?$/iu.test(compact)) return true;
  if (/^(?:[ldb])[:：]\s*[조중석]식\b/iu.test(compact)) return true;
  if (/^(?:[ldb])[:：]\s*[\p{L}\p{N}]+$/iu.test(compact)) return true;
  if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?$/u.test(text)) return true;
  if (/^\d{1,2}월\d{1,2}일$/.test(text.replace(/\s+/gu, ""))) return true;
  if (/\b(일자별\s*일정|작성일|항목추가|제\d+일차?)\b/u.test(text)) return true;
  if (/^\d+명\s*\+\s*\d+\s*(?:드라이빙\s*)?(?:현지)?가이드(?:\s*\|.*)?$/u.test(text)) return true;
  if (/^(?:20\d{2}-\d{2}-\d{2}|\d{1,2}월\s*\d{1,2}일)(?:\s*\|\s*(?:[¥￥]?\d[\d,]*|\d+))*$/u.test(text)) return true;
  if (/^\*(?:현지\s*호텔은\s*미수배|현지\s*드라이빙\s*가이드\s*조건|가이드\s*&?기사\s*팁|전일정\s*숙박|해외여행자보험\s*불포함|항공료\s*및|면세점\s*\d+회\s*방문\s*기준|환율은\s*변동)/u.test(text)) return true;
  return false;
}

function isMeaningfulText(value: string): boolean {
  const text = cleanText(value);
  if (!text || text.length < 2) return false;
  if (isNoisyScheduleContent(text)) return false;
  if (isMetaOnlyScheduleText(text)) return false;
  if (isScheduleChromeToken(text)) return false;
  if (/^[·•\-+✕\s]+$/u.test(text)) return false;
  if (/^\d{1,2}:\d{2}$/u.test(text)) return false;
  if (/^\d+\s*개\s*항목$/u.test(text)) return false;
  if (/^\(?\d+\)?$/u.test(text)) return false;
  if (/^\*+$/u.test(text)) return false;
  if (/\b(일자별\s*일정|작성일|항목추가|제\d+일차?)\b/u.test(text)) return false;
  return true;
}

function isMetaOnlyScheduleText(value: string): boolean {
  const text = cleanText(value).replace(/^['"`]+/u, "");
  const compact = compactText(text);
  if (!compact) return true;
  if (isEditablePreviewSectionHeader(text)) return true;
  if (isStructuredHeaderLine(text)) return true;
  if (isSummaryTrailerLine(text)) return true;
  if (/^\d+\.\s*(?:출발일|인원|차량|호텔|포함|불포함|비고|지상비)\s*(?:[:：]|\s+)/u.test(text)) return true;
  if (
    /^(?:상품명|단체명|행사명|일정명|제목|견적명|견적번호|기준코드|작성일|작성일자|수신|고객|담당자|여행도시|방문도시|지역|여행기간|여행\s*기간|행사기간|기간|여행시작일|여행\s*시작일|여행종료일|여행\s*종료일|시작일|종료일|출발일|도착일|인원|차량|현지차량|항공\s*출발|항공출발|출국편|출발편|출발\s*항공편|항공편|항공편\s*정보|항공정보|항공\s*귀국|항공귀국|귀국편|리턴편|항공\s*도착|도착편|귀국\s*항공편|리턴\s*항공편|숙박호텔|숙박\s*호텔|호텔명|포함|포함내역|포함\s*내역|포함사항|포함\s*사항|불포함|불포함내역|불포함\s*내역|불포함사항|불포함\s*사항|선택관광|옵션투어|유의사항|비고|참고|지상비|여행요금|요금|금액|쇼핑\s*센터\s*방문\s*수|쇼핑\s*센터\s*수|쇼핑\s*횟수)\s*(?:[:：]|\s+|$)/u
      .test(text.replace(/\s+/gu, " "))
  ) {
    return true;
  }
  if (/^\[?견적서\]?/u.test(text)) return true;
  if (/^(?:ATTN|FROM|TO)\s*[:：]?(?:\s*\|.*)?$/iu.test(text)) return true;
  if (/^\*(?:한국인가이드|.+업\/인당)/u.test(text)) return true;
  if (/^\[?(?:간단일정|상세일정|일정)\]?$/u.test(text)) return true;
  return false;
}

function getVisibleDayLineCount(rawText: string): number {
  const dayNos = new Set<number>();
  for (const line of rawText.split("\n")) {
    const dayNo = parseDayNoToken(line);
    if (dayNo !== undefined) dayNos.add(dayNo);
  }
  return dayNos.size;
}

function isMeaningfulScheduleItem(item: ScheduleItem): boolean {
  if (!item.content) return false;
  if (item.type === "MEAL" && item.mealSlot) {
    const mealText = cleanText(item.meal?.[item.mealSlot] ?? item.content);
    return isMeaningfulText(mealText) && !isEmptyMealLabel(mealText);
  }
  return isMeaningfulText(item.content);
}

function estimateExpectedMinimumItems(rawText: string): number {
  const lines = rawText
    .split("\n")
    .map((line) => cleanText(line))
    .filter((line) => line && !isNoiseLine(line) && !isScheduleChromeToken(line));
  const meaningfulLineCount = lines.length;

  if (meaningfulLineCount <= 8) return 2;
  if (meaningfulLineCount <= 18) return 3;
  if (meaningfulLineCount <= 32) return 4;

  const visibleDayCount = Math.max(
    1,
    lines.filter((line) => parseDayNoToken(line) !== undefined).length
  );
  return Math.min(12, Math.max(5, visibleDayCount * 2, Math.floor(meaningfulLineCount / 6)));
}

function evaluateParsedItineraryQuality(data: ItineraryData, rawText: string): {
  meaningfulItemCount: number;
  expectedMinimumItemCount: number;
  acceptable: boolean;
} {
  if (data.days.length === 0) {
    return { meaningfulItemCount: 0, expectedMinimumItemCount: estimateExpectedMinimumItems(rawText), acceptable: false };
  }

  const visibleDayLineCount = getVisibleDayLineCount(rawText);
  if (visibleDayLineCount > 1 && data.days.length < visibleDayLineCount) {
    return {
      meaningfulItemCount: data.days.flatMap((day) => day.items).filter(isMeaningfulScheduleItem).length,
      expectedMinimumItemCount: estimateExpectedMinimumItems(rawText),
      acceptable: false,
    };
  }

  const meaningfulItemCount = data.days
    .flatMap((day) => day.items)
    .filter(isMeaningfulScheduleItem)
    .length;
  const suspiciousItemCount = data.days
    .flatMap((day) => day.items)
    .filter((item) => isMetaOnlyScheduleText(item.content) || isSummaryTrailerLine(item.content))
    .length;

  const expectedMinimumItemCount = estimateExpectedMinimumItems(rawText);
  const meaningfulLineCount = rawText
    .split("\n")
    .map((line) => cleanText(line))
    .filter((line) => line && !isNoiseLine(line) && !isScheduleChromeToken(line)).length;

  if (suspiciousItemCount > 0) {
    return { meaningfulItemCount, expectedMinimumItemCount, acceptable: false };
  }

  if (meaningfulItemCount === 0) {
    return { meaningfulItemCount, expectedMinimumItemCount, acceptable: false };
  }

  if (data.days.length > 1 && meaningfulItemCount < data.days.length) {
    return { meaningfulItemCount, expectedMinimumItemCount, acceptable: false };
  }

  if (meaningfulLineCount > 24) {
    const threshold = Math.min(expectedMinimumItemCount, Math.max(2, data.days.length * 2));
    if (meaningfulItemCount < threshold) {
      return { meaningfulItemCount, expectedMinimumItemCount, acceptable: false };
    }
  }

  const density = meaningfulItemCount / Math.max(1, meaningfulLineCount);
  if (meaningfulLineCount > 40 && density < 0.2) {
    return { meaningfulItemCount, expectedMinimumItemCount, acceptable: false };
  }

  return { meaningfulItemCount, expectedMinimumItemCount, acceptable: true };
}

function collectFieldCoverage(data: ItineraryData): ItineraryFieldCoverage {
  const items = data.days.flatMap((day) => day.items);
  return {
    dayCount: data.days.length,
    datedDayCount: data.days.filter((day) => DATE_RE.test(day.date)).length,
    meaningfulItemCount: items.filter(isMeaningfulScheduleItem).length,
    mealCount: items.filter((item) => item.type === "MEAL").length,
    accommodationCount: items.filter((item) => item.type === "ACCOMMODATION").length,
    hasFlight: Boolean(data.basics.flight.departure || data.basics.flight.arrival),
    hasVehicle: Boolean(data.basics.flight.localVehicle),
    hasHotelSummary: Boolean(data.basics.accommodation.hotel),
    hasIncluded: Boolean(data.basics.included),
    hasExcluded: Boolean(data.basics.excluded),
    hasPassengerCount:
      data.overview.passengers.adult +
        data.overview.passengers.child +
        data.overview.passengers.infant +
        data.overview.passengers.escort >
      0,
    hasFare:
      data.overview.fare.adultPerPerson +
        data.overview.fare.childPerPerson +
        data.overview.fare.infantPerPerson +
        data.overview.fare.total >
      0,
  };
}

function countSuspiciousItems(data: ItineraryData): number {
  return data.days
    .flatMap((day) => day.items)
    .filter((item) => isMetaOnlyScheduleText(item.content) || isSummaryTrailerLine(item.content))
    .length;
}

function countLikelyNoiseLines(rawText: string): number {
  return rawText
    .split("\n")
    .map((line) => cleanText(line))
    .filter((line) => line && (isNoiseLine(line) || isScheduleChromeToken(line) || isMetaOnlyScheduleText(line)))
    .length;
}

function rawTextHasMeal(rawText: string): boolean {
  return /(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：]|MEALS?)/iu.test(rawText);
}

function rawTextHasAccommodation(rawText: string): boolean {
  return /(?:숙박|호텔|HOTEL|리조트|resort|check[-\s]?in|체크[-\s]?인)/iu.test(rawText);
}

function scoreParsedItinerary(
  candidate: ItineraryParserCandidate,
  data: ItineraryData,
  rawText: string,
): ItineraryCandidateScore {
  const quality = evaluateParsedItineraryQuality(data, rawText);
  const fieldCoverage = collectFieldCoverage(data);
  const suspiciousItemCount = countSuspiciousItems(data);
  const visibleDayLineCount = getVisibleDayLineCount(rawText);
  const dayTarget = Math.max(1, visibleDayLineCount || data.days.length);
  const itemTarget = Math.max(1, quality.expectedMinimumItemCount);

  const dayScore = Math.min(1, fieldCoverage.dayCount / dayTarget) * 20;
  const dateScore = Math.min(1, fieldCoverage.datedDayCount / Math.max(1, fieldCoverage.dayCount)) * 10;
  const itemScore = Math.min(1, fieldCoverage.meaningfulItemCount / itemTarget) * 35;
  const mealScore = rawTextHasMeal(rawText) ? Math.min(1, fieldCoverage.mealCount / Math.max(1, fieldCoverage.dayCount)) * 10 : 10;
  const accommodationScore = rawTextHasAccommodation(rawText)
    ? Math.min(1, fieldCoverage.accommodationCount / Math.max(1, fieldCoverage.dayCount)) * 10
    : 10;
  const metadataHits = [
    fieldCoverage.hasFlight,
    fieldCoverage.hasVehicle,
    fieldCoverage.hasHotelSummary,
    fieldCoverage.hasIncluded,
    fieldCoverage.hasExcluded,
    fieldCoverage.hasPassengerCount,
    fieldCoverage.hasFare,
  ].filter(Boolean).length;
  const metadataScore = Math.min(1, metadataHits / 4) * 10;
  const noisePenalty = Math.min(20, suspiciousItemCount * 8);
  const acceptanceBonus = quality.acceptable ? 5 : 0;
  const qualityScore = Math.max(
    0,
    Math.min(100, Math.round(dayScore + dateScore + itemScore + mealScore + accommodationScore + metadataScore + acceptanceBonus - noisePenalty)),
  );

  return {
    candidate,
    qualityScore,
    acceptable: quality.acceptable,
    fieldCoverage,
    meaningfulItemCount: quality.meaningfulItemCount,
    expectedMinimumItemCount: quality.expectedMinimumItemCount,
    suspiciousItemCount,
  };
}

function buildParserWarnings(
  source: ItineraryParserSource,
  score: ItineraryCandidateScore,
  rawText: string,
  aiError?: string,
): string[] {
  const warnings: string[] = [];
  const visibleDayLineCount = getVisibleDayLineCount(rawText);

  if (score.qualityScore < 70) {
    warnings.push(`파싱 품질 점수가 낮습니다 (${score.qualityScore}/100). 일정 반영 후 주요 항목을 확인해 주세요.`);
  }
  if (visibleDayLineCount > 1 && score.fieldCoverage.dayCount < visibleDayLineCount) {
    warnings.push(`원문에는 ${visibleDayLineCount}개 일차가 보이지만 ${score.fieldCoverage.dayCount}개 일차만 추출됐습니다.`);
  }
  if (rawTextHasMeal(rawText) && score.fieldCoverage.mealCount === 0) {
    warnings.push("원문에 식사 정보가 보이지만 조식/중식/석식 항목을 추출하지 못했습니다.");
  }
  if (rawTextHasAccommodation(rawText) && score.fieldCoverage.accommodationCount === 0) {
    warnings.push("원문에 호텔/숙박 정보가 보이지만 숙박 항목을 추출하지 못했습니다.");
  }
  if (score.suspiciousItemCount > 0) {
    warnings.push(`일정이 아닌 메타/요금/푸터성 문구가 ${score.suspiciousItemCount}개 섞였을 수 있습니다.`);
  }
  if (source === "fallback-ai-error" && aiError) {
    warnings.push(`AI 파서 호출 실패로 기본 파서를 사용했습니다: ${aiError}`);
  }
  if (source === "fallback-quality") {
    warnings.push("AI 결과가 품질 기준을 통과하지 못해 기본 파서 결과를 사용했습니다.");
  }
  if (source === "fallback-tabular") {
    warnings.push("표 구조 원문으로 판단되어 표 파서 결과를 우선 사용했습니다.");
  }

  return warnings;
}

function withDiagnosticsQuality(
  diagnostics: ItineraryParseDiagnostics,
  itinerary: ItineraryData,
  rawText: string,
  selectedCandidate: ItineraryParserCandidate,
  candidateScores: ItineraryCandidateScore[],
): ItineraryParseResult {
  const selectedScore =
    candidateScores.find((score) => score.candidate === selectedCandidate) ??
    scoreParsedItinerary(selectedCandidate, itinerary, rawText);
  const warnings = buildParserWarnings(diagnostics.source, selectedScore, rawText, diagnostics.aiError);

  return {
    itinerary,
    diagnostics: {
      ...diagnostics,
      selectedCandidate,
      qualityScore: selectedScore.qualityScore,
      warnings,
      fieldCoverage: selectedScore.fieldCoverage,
      candidateScores,
      noiseRemovedCount: countLikelyNoiseLines(rawText),
    },
  };
}

function parseDateFromAnyText(text: string): string {
  const normalized = normalizeDateToken(text);
  const direct = /\b(20\d{2}-\d{2}-\d{2})\b/u.exec(normalized)?.[1];
  if (direct) return normalizeDate(direct);

  const hyphenDate = /\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/u.exec(normalized);
  if (hyphenDate?.[1] && hyphenDate[2] && hyphenDate[3]) {
    return `${hyphenDate[1]}-${pad2(hyphenDate[2])}-${pad2(hyphenDate[3])}`;
  }

  const monthDayWithYear = /(?:^|\b)(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})일/u.exec(text);
  if (monthDayWithYear?.[1] && monthDayWithYear[2] && monthDayWithYear[3]) {
    return `${monthDayWithYear[1]}-${pad2(monthDayWithYear[2])}-${pad2(monthDayWithYear[3])}`;
  }

  const monthDay = /(?:^|\b)(\d{1,2})월\s*(\d{1,2})일/u.exec(text);
  if (monthDay?.[1] && monthDay[2]) {
    const year = currentYearInKorea();
    return `${year}-${pad2(monthDay[1])}-${pad2(monthDay[2])}`;
  }

  const monthDayShort = /(?:^|\b)(0?[1-9]|1[0-2])[./](0?[1-9]|[12]\d|3[01])(?!:\d{2})(?:\b|$)/u.exec(text);
  if (monthDayShort?.[1] && monthDayShort[2]) {
    const year = currentYearInKorea();
    return `${year}-${pad2(monthDayShort[1])}-${pad2(monthDayShort[2])}`;
  }

  const englishMonth = /(?:\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\w*\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{2,4})\b/iu.exec(text);
  if (englishMonth?.[1] && englishMonth[2] && englishMonth[3]) {
    const monthMap: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const month = monthMap[englishMonth[1]?.toLowerCase() ?? ""];
    if (month) {
      const year = Number(englishMonth[3] ?? "");
      const normalizedYear = year < 100 ? 2000 + year : year;
      return `${normalizedYear}-${month}-${pad2(englishMonth[2] ?? "")}`;
    }
  }

  return "";
}

function parseCountByToken(line: string, token: string): number | undefined {
  const normalized = line.replace(/\s+/gu, "");
  const byPost = new RegExp(`${token}\\s*[:：]?\\s*(\\d+)\\s*(?:명|여명)?`, "u").exec(normalized)?.[1];
  if (byPost) return Number(byPost);
  const byPre = new RegExp(`(\\d+)\\s*(?:명|여명)?\\s*${token}`, "u").exec(normalized)?.[1];
  if (byPre) return Number(byPre);
  return undefined;
}

function stripMetaListPrefix(line: string): string {
  return line.replace(/^\s*\d+\.\s*/u, "").trim();
}

function parsePassengerSummary(line: string): { adult?: number; child?: number } {
  const value = stripMetaListPrefix(line);
  const raw = /^(?:인원|인원수)\s*[:：]\s*(.+)$/u.exec(value)?.[1];
  if (!raw) return {};

  const plusMatch = /(\d+)\s*\+\s*(\d+)/u.exec(raw);
  if (plusMatch?.[1] && plusMatch[2]) {
    return { adult: Number(plusMatch[1]), child: Number(plusMatch[2]) };
  }

  const adult = /(\d+)\s*(?:명|인)?/u.exec(raw)?.[1];
  return adult ? { adult: Number(adult) } : {};
}

function parseMoneyWon(text: string): number | undefined {
  const normalized = text.replace(/,/gu, "");
  const manWon = /(\d+(?:\.\d+)?)\s*만원/u.exec(normalized)?.[1];
  if (manWon) return Math.round(Number(manWon) * 10000);
  const won = /(\d+)\s*원/u.exec(normalized)?.[1];
  if (won) return Number(won);
  return undefined;
}

function labelPattern(label: string): string {
  return label.replace(/\s+/gu, "\\s*");
}

function extractLabeledValue(line: string, labels: string[]): string {
  const withoutListPrefix = stripMetaListPrefix(line).replace(/^['"`]+/u, "");
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`^${labelPattern(label)}\\s*(?:[:：]|\\||\\s+)\\s*(.+)$`, "u");
    const matched = pattern.exec(withoutListPrefix);
    if (matched?.[1]) return cleanText(matched[1].replace(/^\|\s*/u, ""));
  }
  return "";
}

function extractDateRangeFromText(text: string): { start: string; end: string } | undefined {
  const normalized = normalizeDateToken(text);
  const matches = Array.from(normalized.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/gu))
    .map((match) => normalizeDate(match[1] ?? ""))
    .filter((value) => DATE_RE.test(value));
  if (matches.length === 0) return undefined;
  return {
    start: matches[0] ?? "",
    end: matches.length > 1 ? matches[matches.length - 1] ?? "" : matches[0] ?? "",
  };
}

function hasExplicitMetaValue(value: string): boolean {
  return Boolean(cleanText(value)) && !isMetaOnlyScheduleText(value);
}

type ItineraryMeta = {
  header?: Partial<ItineraryData["header"]>;
  overview?: Partial<Omit<ItineraryData["overview"], "travelPeriod" | "passengers" | "fare">> & {
    travelPeriod?: Partial<ItineraryData["overview"]["travelPeriod"]>;
    passengers?: Partial<ItineraryData["overview"]["passengers"]>;
    fare?: Partial<ItineraryData["overview"]["fare"]>;
  };
  basics?: Partial<Omit<ItineraryData["basics"], "flight" | "accommodation">> & {
    flight?: Partial<ItineraryData["basics"]["flight"]>;
    accommodation?: Partial<ItineraryData["basics"]["accommodation"]>;
  };
};

function extractMetaFromRaw(
  rawText: string,
  title: string | undefined,
  days: DaySchedule[],
): ItineraryMeta {
  const lines = rawText
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);

  let groupName = "";
  let writtenAt = "";
  let recipient = "";
  let cities = "";

  let adult: number | undefined;
  let child: number | undefined;
  let infant: number | undefined;
  let escort: number | undefined;
  let foc: number | undefined;

  let departure = "";
  let arrival = "";
  let localVehicle = "";
  let hotel = "";
  let grade = "";
  let occupancy = "";
  let included = "";
  let excluded = "";
  let optionalTour = "";
  let notes = "";
  let shoppingCenters: number | undefined;
  let adultPerPerson = 0;
  let explicitStartDate = "";
  let explicitEndDate = "";

  for (const line of lines) {
    const metaLine = stripMetaListPrefix(line).replace(/^['"`]+/u, "");

    if (!groupName) {
      const name = extractLabeledValue(metaLine, ["상품명", "단체명", "행사명", "일정명", "제목", "견적명"]);
      if (name) groupName = cleanText(name);
    }

    if (!writtenAt) {
      const written = extractLabeledValue(line, ["작성일", "작성일자"]);
      if (written) writtenAt = parseDateFromAnyText(written);
    }

    if (!recipient) {
      const rec = extractLabeledValue(line, ["수신", "고객", "담당자"]);
      if (rec) recipient = cleanText(rec);
    }

    if (!cities) {
      const found = extractLabeledValue(metaLine, ["여행도시", "방문도시", "도시", "지역"]);
      if (found) cities = found;
    }

    const rangeText = extractLabeledValue(metaLine, ["여행기간", "여행 기간", "기간", "행사기간"]);
    if (rangeText) {
      const range = extractDateRangeFromText(rangeText);
      if (range) {
        explicitStartDate = explicitStartDate || range.start;
        explicitEndDate = explicitEndDate || range.end;
      }
    }
    if (!explicitStartDate) {
      const found = extractLabeledValue(metaLine, ["여행시작일", "여행 시작일", "시작일", "출발일"]);
      if (found) explicitStartDate = parseDateFromAnyText(found);
    }
    if (!explicitEndDate) {
      const found = extractLabeledValue(metaLine, ["여행종료일", "여행 종료일", "종료일", "도착일"]);
      if (found) explicitEndDate = parseDateFromAnyText(found);
    }

    const passengerSummary = parsePassengerSummary(metaLine);
    adult = adult ?? passengerSummary.adult;
    child = child ?? passengerSummary.child;

    adult = adult ?? parseCountByToken(line, "성인");
    if (adult === undefined) {
      const student = parseCountByToken(line, "학생");
      const teacher = parseCountByToken(line, "교사");
      if (student !== undefined || teacher !== undefined) {
        adult = (student ?? 0) + (teacher ?? 0);
      }
    }
    adult = adult ?? parseCountByToken(line, "학생");
    child = child ?? parseCountByToken(line, "아동");
    infant = infant ?? parseCountByToken(line, "유아");

    const escortTokens = Array.from(line.matchAll(/인솔자\s*[:：]?\s*(\d+)/gu))
      .map((match) => Number(match[1] ?? "0"))
      .filter((num) => Number.isFinite(num));
    if (escort === undefined && escortTokens.length > 0) {
      escort = escortTokens.reduce((sum, value) => sum + value, 0);
    }
    escort = escort ?? parseCountByToken(line, "인솔자");
    foc = foc ?? parseCountByToken(line, "FOC");

    if (!departure) {
      const found = extractLabeledValue(metaLine, ["항공 출발", "항공출발", "출국편", "출발편", "출발 항공편", "항공편", "항공편 정보", "항공정보"]);
      if (found) departure = found;
    }
    if (!arrival) {
      const found = extractLabeledValue(metaLine, ["항공 귀국", "항공귀국", "귀국편", "리턴편", "항공 도착", "도착편", "귀국 항공편", "리턴 항공편"]);
      if (found) arrival = found;
    }
    if (!localVehicle) {
      const vehicle = extractLabeledValue(metaLine, ["차량", "현지 차량"]);
      if (vehicle) localVehicle = cleanText(vehicle);
    }
    if (!localVehicle && /(전용버스|현지\s*차량|버스)/u.test(line)) localVehicle = "전용버스";

    if (!hotel) {
      const hotelLine = /(?:^|[| ])HOTEL\s*-\s*([^|]+)/iu.exec(metaLine)?.[1]
        ?? extractLabeledValue(metaLine, ["숙박호텔", "숙박 호텔", "호텔명", "호텔", "숙박"]);
      if (hotelLine) {
        hotel = cleanText(hotelLine);
      }
    }
    if (!grade) {
      const found = /(5성|4성|3성|특급|준특급)/u.exec(line)?.[1];
      if (found) grade = found;
    }
    if (!occupancy) {
      const found = /(2인1실|3인1실|트윈|더블|싱글)/u.exec(line)?.[1];
      if (found) occupancy = found;
    }

    if (!included) {
      const found = extractLabeledValue(metaLine, ["포함내역", "포함 내역", "포함사항", "포함 사항", "포함"]);
      if (found) included = cleanText(found);
    }
    if (!excluded) {
      const found = extractLabeledValue(metaLine, ["불포함내역", "불포함 내역", "불포함사항", "불포함 사항", "불포함"]);
      if (found) excluded = cleanText(found);
    }
    if (!optionalTour) {
      const found = extractLabeledValue(metaLine, ["선택관광", "옵션투어"]);
      if (found) optionalTour = cleanText(found);
    }
    if (!notes) {
      const found = extractLabeledValue(metaLine, ["유의사항", "비고", "참고"]);
      if (found) notes = cleanText(found);
    }
    if (/노\s*옵션/u.test(metaLine) && !optionalTour) optionalTour = "노옵션";
    if (shoppingCenters === undefined) {
      const found = /쇼핑\s*(?:센터)?(?:\s*방문)?\s*(?:수|횟수)?\s*[:：]?\s*(\d+)/u.exec(metaLine)?.[1];
      if (found) shoppingCenters = Number(found);
      if (/노\s*쇼핑/u.test(metaLine)) shoppingCenters = 0;
    }
    if (adultPerPerson === 0) {
      const groundFee = extractLabeledValue(metaLine, ["지상비", "여행요금", "요금", "금액"]);
      if (groundFee) adultPerPerson = parseMoneyWon(groundFee) ?? 0;
    }
  }

  const noteLines = lines
    .map((line) => cleanText(line))
    .filter((line) => /^\*/u.test(line))
    .map((line) => line.replace(/^\*\s*/u, ""));
  if (noteLines.length > 0) {
    notes = [notes, ...noteLines].filter(Boolean).join("\n");
  }

  const sectionStopPattern = /^(?:상품명|단체명|행사명|일정명|여행기간|여행시작일|여행종료일|출발일|도착일|인원|차량|항공|항공편|호텔|숙박|포함|포함내역|포함사항|불포함|불포함내역|불포함사항|선택관광|옵션투어|유의사항|비고|참고|지상비|여행요금|요금|금액|쇼핑|\d+\s*일차|제\s*\d+\s*일)/u;
  const collectSection = (labels: string[]): string => {
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripMetaListPrefix(lines[index] ?? "").replace(/^['"`]+/u, "");
      const labelOnly = labels.some((label) => new RegExp(`^${labelPattern(label)}\\s*[:：]?\\s*$`, "u").test(line));
      if (!labelOnly) continue;

      const values: string[] = [];
      for (const next of lines.slice(index + 1)) {
        const value = stripMetaListPrefix(next).replace(/^['"`]+/u, "");
        if (!value) continue;
        if (sectionStopPattern.test(value)) break;
        if (extractDayNoFromScheduleLine(value) !== undefined) break;
        if (isScheduleChromeToken(value)) continue;
        values.push(cleanText(value.replace(/^[-•·*]\s*/u, "")));
      }
      const collected = values.filter(hasExplicitMetaValue).join(" / ");
      if (collected) return collected;
    }
    return "";
  };
  included = included || collectSection(["포함내역", "포함 내역", "포함사항", "포함 사항"]);
  excluded = excluded || collectSection(["불포함내역", "불포함 내역", "불포함사항", "불포함 사항"]);

  if (!cities) {
    const regionFromDays = days
      .flatMap((day) => day.items.map((item) => cleanText(item.region)))
      .filter(Boolean);
    const merged = Array.from(new Set(regionFromDays));
    cities = merged.join(", ");
  }

  const periodSourceExplicit = explicitStartDate || explicitEndDate;
  const startDate = explicitStartDate;
  const endDate = explicitEndDate;

  const meta: ItineraryMeta = {};

  if (groupName || writtenAt) {
    meta.header = {
      groupName: groupName || cleanText(title),
      writtenAt: writtenAt || ISO_DATE_TODAY,
    };
  }

  if (
    recipient ||
    cities ||
    periodSourceExplicit ||
    adult !== undefined ||
    child !== undefined ||
    infant !== undefined ||
    escort !== undefined ||
    foc !== undefined
  ) {
    meta.overview = {
      recipient: recipient || "",
      cities: cities || "",
      ...(periodSourceExplicit
        ? {
            travelPeriod: {
              start: startDate || ISO_DATE_TODAY,
              end: endDate,
            },
          }
        : {}),
      passengers: {
        adult: adult ?? 0,
        child: child ?? 0,
        infant: infant ?? 0,
        escort: escort ?? 0,
        foc: foc ?? 0,
      },
      fare: {
        adultPerPerson,
        childPerPerson: 0,
        infantPerPerson: 0,
        total: adultPerPerson > 0 ? adultPerPerson * (adult ?? 0) : 0,
        totalWithCard: adultPerPerson > 0 ? adultPerPerson * (adult ?? 0) : 0,
      },
    };
  }

  if (departure || arrival || localVehicle || hotel || grade || occupancy || included || excluded || optionalTour || notes || shoppingCenters !== undefined) {
    meta.basics = {
      flight: {
        departure,
        arrival,
        localVehicle,
      },
      accommodation: {
        hotel,
        grade,
        occupancy,
      },
      included: included || "",
      excluded: excluded || "",
      optionalTour: optionalTour || "",
      shoppingCenters: shoppingCenters ?? 0,
      notes: notes || "",
    };
  }

  return meta;
}

function mergeItineraryWithMeta(base: ItineraryData, meta: ItineraryMeta): ItineraryData {
  const isNoisyCities = (value: string): boolean =>
    /[|]|·|제\d+일/u.test(value) || value.length > 60;
  const preferCities = meta.overview?.cities
    ? meta.overview.cities
    : isNoisyCities(base.overview.cities)
      ? ""
      : base.overview.cities;

  const baseStart = normalizeDate(base.overview.travelPeriod.start || "");
  const baseEnd = normalizeDate(base.overview.travelPeriod.end || "");
  const metaStart = normalizeOptionalDate(meta.overview?.travelPeriod?.start);
  const metaEnd = normalizeOptionalDate(meta.overview?.travelPeriod?.end);
  const start = metaStart || baseStart || ISO_DATE_TODAY;
  const end = metaEnd || baseEnd || start;

  return {
    ...base,
    header: {
      groupName: meta.header?.groupName || base.header.groupName || "",
      writtenAt: base.header.writtenAt || meta.header?.writtenAt || ISO_DATE_TODAY,
    },
    overview: {
      ...base.overview,
      recipient: base.overview.recipient || meta.overview?.recipient || "",
      cities: preferCities,
      travelPeriod: {
        start,
        end,
      },
      passengers: {
        adult: base.overview.passengers.adult || meta.overview?.passengers?.adult || 0,
        child: base.overview.passengers.child || meta.overview?.passengers?.child || 0,
        infant: base.overview.passengers.infant || meta.overview?.passengers?.infant || 0,
        escort: base.overview.passengers.escort || meta.overview?.passengers?.escort || 0,
        foc: base.overview.passengers.foc || meta.overview?.passengers?.foc || 0,
      },
      fare: {
        adultPerPerson: base.overview.fare.adultPerPerson || meta.overview?.fare?.adultPerPerson || 0,
        childPerPerson: base.overview.fare.childPerPerson || meta.overview?.fare?.childPerPerson || 0,
        infantPerPerson: base.overview.fare.infantPerPerson || meta.overview?.fare?.infantPerPerson || 0,
        total: base.overview.fare.total || meta.overview?.fare?.total || 0,
        totalWithCard: base.overview.fare.totalWithCard || meta.overview?.fare?.totalWithCard || 0,
      },
    },
    basics: {
      ...base.basics,
      flight: {
        departure: base.basics.flight.departure || meta.basics?.flight?.departure || "",
        arrival: base.basics.flight.arrival || meta.basics?.flight?.arrival || "",
        localVehicle: base.basics.flight.localVehicle || meta.basics?.flight?.localVehicle || "",
      },
      accommodation: {
        hotel: base.basics.accommodation.hotel || meta.basics?.accommodation?.hotel || "",
        grade: base.basics.accommodation.grade || meta.basics?.accommodation?.grade || "",
        occupancy: base.basics.accommodation.occupancy || meta.basics?.accommodation?.occupancy || "",
      },
      included: base.basics.included || meta.basics?.included || "",
      excluded: base.basics.excluded || meta.basics?.excluded || "",
      optionalTour: base.basics.optionalTour || meta.basics?.optionalTour || "",
      shoppingCenters: base.basics.shoppingCenters || meta.basics?.shoppingCenters || 0,
      notes: base.basics.notes || meta.basics?.notes || "",
    },
  };
}

function mergeNonScheduleData(base: ItineraryData, source: ItineraryData): ItineraryData {
  const sourceStart = normalizeOptionalDate(source.overview.travelPeriod.start);
  const sourceEnd = normalizeOptionalDate(source.overview.travelPeriod.end);

  return {
    ...base,
    header: {
      groupName: cleanText(source.header.groupName) || base.header.groupName,
      writtenAt: normalizeOptionalDate(source.header.writtenAt) || base.header.writtenAt,
    },
    overview: {
      ...base.overview,
      recipient: cleanText(source.overview.recipient) || base.overview.recipient,
      cities: cleanText(source.overview.cities) || base.overview.cities,
      travelPeriod: {
        start: sourceStart || base.overview.travelPeriod.start,
        end: sourceEnd || base.overview.travelPeriod.end,
      },
      passengers: {
        adult: source.overview.passengers.adult || base.overview.passengers.adult,
        child: source.overview.passengers.child || base.overview.passengers.child,
        infant: source.overview.passengers.infant || base.overview.passengers.infant,
        escort: source.overview.passengers.escort || base.overview.passengers.escort,
        foc: source.overview.passengers.foc || base.overview.passengers.foc,
      },
      fare: {
        adultPerPerson: source.overview.fare.adultPerPerson || base.overview.fare.adultPerPerson,
        childPerPerson: source.overview.fare.childPerPerson || base.overview.fare.childPerPerson,
        infantPerPerson: source.overview.fare.infantPerPerson || base.overview.fare.infantPerPerson,
        total: source.overview.fare.total || base.overview.fare.total,
        totalWithCard: source.overview.fare.totalWithCard || base.overview.fare.totalWithCard,
      },
    },
    basics: {
      ...base.basics,
      flight: {
        departure: cleanText(source.basics.flight.departure) || base.basics.flight.departure,
        arrival: cleanText(source.basics.flight.arrival) || base.basics.flight.arrival,
        localVehicle: cleanText(source.basics.flight.localVehicle) || base.basics.flight.localVehicle,
      },
      accommodation: {
        hotel: cleanText(source.basics.accommodation.hotel) || base.basics.accommodation.hotel,
        grade: cleanText(source.basics.accommodation.grade) || base.basics.accommodation.grade,
        occupancy: cleanText(source.basics.accommodation.occupancy) || base.basics.accommodation.occupancy,
      },
      included: cleanText(source.basics.included) || base.basics.included,
      excluded: cleanText(source.basics.excluded) || base.basics.excluded,
      optionalTour: cleanText(source.basics.optionalTour) || base.basics.optionalTour,
      shoppingCenters: source.basics.shoppingCenters || base.basics.shoppingCenters,
      notes: cleanText(source.basics.notes) || base.basics.notes,
    },
  };
}

function recalculateDayDatesFromStart(data: ItineraryData): ItineraryData {
  const sortedDays = [...data.days].sort((a, b) => a.dayNo - b.dayNo);
  const firstDayNo = sortedDays[0]?.dayNo ?? 1;
  const explicitStart = normalizeOptionalDate(data.overview.travelPeriod.start);
  const explicitEnd = normalizeOptionalDate(data.overview.travelPeriod.end);
  const firstDayDate = normalizeOptionalDate(sortedDays[0]?.date);
  const start = explicitStart || firstDayDate || ISO_DATE_TODAY;
  const days = sortedDays.map((day) => ({
    ...day,
    date: addDays(start, day.dayNo - firstDayNo),
  }));
  const period = fillDateWindow(days.map((day) => ({ dayNo: day.dayNo, date: day.date })));

  return {
    ...data,
    overview: {
      ...data.overview,
      travelPeriod: {
        start: explicitStart || period.start,
        end: explicitEnd || period.end,
      },
    },
    days,
  };
}

function isGenericAccommodationItem(item: ScheduleItem): boolean {
  if (item.type !== "ACCOMMODATION") return false;
  const content = compactText(item.content);
  const hotel = compactText(item.hotel ?? "");
  if (hotel && hotel !== content) return false;
  return /^(?:호텔|숙박|리조트)?(?:명입력|입력|체크인|휴식|투숙|호텔체크인|호텔체크인후휴식|리조트투숙)$/u.test(content);
}

function isHotelLabelOnlyItem(item: ScheduleItem): boolean {
  const content = compactText(item.content);
  if (!/^(?:hotel|호텔)$/iu.test(content)) return false;
  const detail = cleanText(item.detail ?? "");
  return !detail || isMeaningfulText(detail);
}

function hasSameAccommodation(items: ScheduleItem[], candidate: ScheduleItem): boolean {
  const normalizeHotelKey = (value: string): string =>
    normalizeKey(value)
      .replace(/\b[1-5]\*$/u, "")
      .replace(/\b[1-5]성급$/u, "")
      .replace(/\b[1-5]star$/iu, "");
  const candidateHotel = normalizeHotelKey(candidate.hotel ?? candidate.content);
  const candidateContent = normalizeHotelKey(candidate.content);
  return items.some((item) => {
    if (item.type !== "ACCOMMODATION") return false;
    const hotel = normalizeHotelKey(item.hotel ?? item.content);
    const content = normalizeHotelKey(item.content);
    return Boolean(candidateHotel && hotel === candidateHotel) || Boolean(candidateContent && content === candidateContent);
  });
}

function mergeMissingAccommodationItems(primary: ItineraryData, fallback: ItineraryData): ItineraryData {
  const fallbackByDay = new Map(fallback.days.map((day) => [day.dayNo, day]));
  const fallbackByDate = new Map(fallback.days.map((day) => [day.date, day]));
  const fallbackDays = fallback.days;
  return {
    ...primary,
    days: primary.days.map((day, index) => {
        const fallbackDay = fallbackByDay.get(day.dayNo)
          ?? fallbackByDate.get(day.date)
          ?? fallbackDays[index];
        const fallbackMeals = fallbackDay?.items.filter(
          (item) => item.type === "MEAL" && item.mealSlot && isMeaningfulScheduleItem(item),
        ) ?? [];
        const fallbackAccommodations = fallbackDay?.items.filter(
          (item) => item.type === "ACCOMMODATION" && isMeaningfulText(item.hotel ?? item.content),
        ) ?? [];
        if (fallbackMeals.length === 0 && fallbackAccommodations.length === 0) return day;

        let items = [...day.items];
        for (const fallbackItem of fallbackMeals) {
          const existingIndex = items.findIndex(
            (item) => item.type === "MEAL" && item.mealSlot === fallbackItem.mealSlot,
          );
          if (existingIndex >= 0) {
            const existing = items[existingIndex];
            if (existing && existing.type === "MEAL") {
              items[existingIndex] = mergeMealItems(existing, fallbackItem);
            }
            continue;
          }

          items.push(fallbackItem);
        }

        for (const fallbackItem of fallbackAccommodations) {
          if (hasSameAccommodation(items, fallbackItem)) continue;

          const genericIndex = items.findIndex(isGenericAccommodationItem);
          if (genericIndex >= 0) {
            items[genericIndex] = fallbackItem;
            continue;
          }

          items.push(fallbackItem);
        }

        items = dedupeItems(normalizeMealsInItems(items));
        return { ...day, items };
      }),
  };
}

function isEvidenceItemCandidate(item: ScheduleItem): boolean {
  if (!isMeaningfulScheduleItem(item)) return false;
  if (isMetaOnlyScheduleText(item.content) || isSummaryTrailerLine(item.content)) return false;
  if (isNoisyScheduleContent(item.content)) return false;
  return true;
}

function hasSimilarEvidenceItem(items: ScheduleItem[], candidate: ScheduleItem): boolean {
  const candidateKey = normalizeKey(candidate.content);
  const candidateHotel = normalizeKey(candidate.hotel ?? candidate.content);
  return items.some((item) => {
    if (item.type === "MEAL" && candidate.type === "MEAL") {
      return item.mealSlot === candidate.mealSlot;
    }
    if (item.type === "ACCOMMODATION" && candidate.type === "ACCOMMODATION") {
      return hasSameAccommodation([item], candidate);
    }
    if (item.type !== candidate.type) return false;
    const itemKey = normalizeKey(item.content);
    const itemHotel = normalizeKey(item.hotel ?? item.content);
    if (candidateKey && itemKey && (candidateKey === itemKey || itemKey.includes(candidateKey) || candidateKey.includes(itemKey))) {
      return true;
    }
    return Boolean(candidateHotel && itemHotel && candidateHotel === itemHotel);
  });
}

function mergeMissingEvidenceItems(primary: ItineraryData, evidence: ItineraryData): ItineraryData {
  const evidenceByDay = new Map(evidence.days.map((day) => [day.dayNo, day]));
  const evidenceByDate = new Map(evidence.days.map((day) => [day.date, day]));
  const evidenceDays = evidence.days;

  return {
    ...primary,
    days: primary.days.map((day, index) => {
      const evidenceDay = evidenceByDay.get(day.dayNo)
        ?? evidenceByDate.get(day.date)
        ?? evidenceDays[index];
      const evidenceItems = evidenceDay?.items.filter((item) =>
        (item.type === "MEAL" || item.type === "ACCOMMODATION") && isEvidenceItemCandidate(item)
      ) ?? [];
      if (evidenceItems.length === 0) return day;

      const items = [...day.items];
      for (const evidenceItem of evidenceItems) {
        if (hasSimilarEvidenceItem(items, evidenceItem)) continue;
        items.push(evidenceItem);
      }

      return {
        ...day,
        items: dedupeItems(normalizeMealsInItems(items.filter((item) => item.type !== "ACCOMMODATION"))).concat(
          dedupeItems(normalizeMealsInItems(items.filter((item) => item.type === "ACCOMMODATION"))),
        ),
      };
    }),
  };
}

type RawMealOverrides = Partial<Record<MealSlot, string>>;

function extractRawMealOverrides(rawText: string): Array<{ dayNo: number; meals: RawMealOverrides }> {
  const byDay = new Map<number, RawMealOverrides>();
  let currentDayNo = 1;

  for (const line of rawText.split("\n")) {
    const parsedDayNo = extractDayNoFromScheduleLine(line);
    if (parsedDayNo !== undefined) currentDayNo = parsedDayNo;

    const matches = Array.from(line.matchAll(/(?:^|[\s|])([조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]\s*([^|\n]+)/giu));
    const columnMeals: Array<{ slot: MealSlot; value: string }> = [];
    const columns = splitScheduleColumnsWithTabs(line);
    for (const [index, column] of columns.entries()) {
      const markerMatch = /^([조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*([:：])?\s*$/iu.exec(column);
      const inlineMatch = /^([조중석bld]|조식|중식|석식|아침|점심|저녁|breakfast|lunch|dinner)\s*[:：]\s*(.+)$/iu.exec(column);
      const slot = toMealSlotByToken(markerMatch?.[1] ?? inlineMatch?.[1] ?? "");
      if (!slot) continue;

      const inlineValue = cleanText(inlineMatch?.[2] ?? "");
      const canUseNextValue = Boolean(markerMatch?.[2]) || /^(?:[조중석bld]|아침|점심|저녁)$/iu.test(cleanText(markerMatch?.[1] ?? ""));
      const nextValue = canUseNextValue
        ? columns
            .slice(index + 1)
            .map((value) => cleanText(value))
            .find((value) => value && !/^후(?:\s|$)/u.test(value) && !isPlaceholderCell(value) && parseDayNoToken(value) === undefined)
        : "";
      const value = sanitizeMealText(inlineValue || nextValue || "", slot);
      if (value && value !== mealSlotLabel(slot)) {
        columnMeals.push({ slot, value });
      }
    }

    if (matches.length === 0 && columnMeals.length === 0) continue;

    const meals = byDay.get(currentDayNo) ?? {};
    for (const match of matches) {
      const slot = toMealSlotByToken(match[1] ?? "");
      if (!slot) continue;
      const value = sanitizeMealText(match[2] ?? "", slot);
      if (value && value !== mealSlotLabel(slot)) {
        meals[slot] = value;
      }
    }
    for (const meal of columnMeals) {
      meals[meal.slot] = meal.value;
    }
    byDay.set(currentDayNo, meals);
  }

  return Array.from(byDay.entries())
    .map(([dayNo, meals]) => ({ dayNo, meals }))
    .filter(({ meals }) => Object.keys(meals).length > 0)
    .sort((a, b) => a.dayNo - b.dayNo);
}

function applyRawMealOverrides(
  data: ItineraryData,
  rawText: string,
  opts: { allowIndexFallback?: boolean } = {},
): ItineraryData {
  const overrides = extractRawMealOverrides(rawText);
  if (overrides.length === 0) return data;

  const byDay = new Map(overrides.map((entry) => [entry.dayNo, entry.meals]));
  const slots: MealSlot[] = ["breakfast", "lunch", "dinner"];

  return {
    ...data,
    days: data.days.map((day, index) => {
      const meals = byDay.get(day.dayNo) ?? (opts.allowIndexFallback ? overrides[index]?.meals : undefined);
      if (!meals) return day;

      let items = [...day.items];
      for (const slot of slots) {
        const value = meals[slot];
        if (!value) continue;

        const existingIndex = items.findIndex((item) => item.type === "MEAL" && item.mealSlot === slot);
        if (existingIndex >= 0) {
          const existing = items[existingIndex];
          if (existing && existing.type === "MEAL") {
            items[existingIndex] = {
              ...existing,
              content: value,
              mealSlot: slot,
              meal: {
                ...(existing.meal ?? {}),
                [slot]: value,
              },
            };
          }
          continue;
        }

        items.push({
          id: randomUUID(),
          type: "MEAL",
          content: value,
          mealSlot: slot,
          meal: { [slot]: value },
        });
      }

      items = dedupeItems(normalizeMealsInItems(items));
      return { ...day, items };
    }),
  };
}

function extractHotelNameFromLine(line: string): string {
  const direct = /\bHOTEL\s*[:：-]\s*([^|]+)/iu.exec(line)?.[1]
    ?? /(?:호텔명|숙박호텔|숙\s*소)\s*[:：]\s*([^|]+)/u.exec(line)?.[1];
  if (direct) return cleanText(direct);

  const columns = splitScheduleColumnsWithTabs(line);
  const hotelIndex = columns.findIndex((column) => /^(?:HOTEL|호텔)$/iu.test(cleanText(column)));
  if (hotelIndex < 0) return "";

  const name = columns
    .slice(hotelIndex + 1)
    .map((column) => cleanText(column))
    .find((column) =>
      isMeaningfulText(column) &&
      !isLikelyMealText(column) &&
      !/^https?:\/\//iu.test(column)
    );
  return cleanText(name ?? "");
}

function extractAccommodationItemsFromRaw(rawText: string): Map<number, ScheduleItem[]> {
  const lines = selectScheduleLines(
    rawText
      .split("\n")
      .map((line) => cleanText(line))
      .filter(Boolean),
  );
  const hotelByDay = new Map<number, ScheduleItem[]>();
  let currentDayNo = 1;

  for (const line of lines) {
    const dayNo = extractDayNoFromScheduleLine(line);
    if (dayNo !== undefined) currentDayNo = dayNo;

    const hotelName = extractHotelNameFromLine(line);
    if (!hotelName || !isMeaningfulText(hotelName)) continue;

    const item: ScheduleItem = {
      id: randomUUID(),
      type: "ACCOMMODATION",
      content: hotelName,
      hotel: hotelName,
    };
    const items = hotelByDay.get(currentDayNo) ?? [];
    if (!hasSameAccommodation(items, item)) {
      items.push(item);
      hotelByDay.set(currentDayNo, items);
    }
  }

  return hotelByDay;
}

function mergeRawHotelItems(itinerary: ItineraryData, rawText: string): ItineraryData {
  const hotelByDay = extractAccommodationItemsFromRaw(rawText);
  if (hotelByDay.size === 0) return itinerary;

  return {
    ...itinerary,
    days: itinerary.days.map((day) => {
        const rawHotels = hotelByDay.get(day.dayNo) ?? [];
        if (rawHotels.length === 0) return day;

        const items = day.items.filter((item) => !isGenericAccommodationItem(item) && !isHotelLabelOnlyItem(item));
        for (const hotel of rawHotels) {
          if (hasSameAccommodation(items, hotel)) continue;
          items.push(hotel);
        }
        return { ...day, items: dedupeItems(items) };
      }),
  };
}

function applyAuthoritativeTabularItems(primary: ItineraryData, fallback: ItineraryData): ItineraryData {
  const fallbackByDay = new Map(fallback.days.map((day) => [day.dayNo, day]));
  const fallbackByDate = new Map(fallback.days.map((day) => [day.date, day]));
  const fallbackDays = fallback.days;

  return {
    ...primary,
    days: primary.days.map((day, index) => {
      const fallbackDay = fallbackByDay.get(day.dayNo)
        ?? fallbackByDate.get(day.date)
        ?? fallbackDays[index];
      if (!fallbackDay) return day;

      const fallbackMeals = fallbackDay.items.filter((item) => item.type === "MEAL" && item.mealSlot);
      const fallbackAccommodations = fallbackDay.items.filter((item) => item.type === "ACCOMMODATION");
      const withoutTabularAuthority = day.items.filter((item) => {
        if (item.type === "MEAL") return false;
        if (item.type === "ACCOMMODATION" && fallbackAccommodations.length > 0) return false;
        return true;
      });

      return {
        ...day,
        items: dedupeItems([
          ...withoutTabularAuthority,
          ...fallbackMeals,
          ...fallbackAccommodations,
        ]),
      };
    }),
  };
}

function selectScheduleLines(lines: string[]): string[] {
  const truncateAtSummary = (source: string[]): string[] => {
    const summaryIndex = source.findIndex((line) => isSummaryTrailerLine(line) || isScheduleTerminalLine(line));
    return summaryIndex >= 0 ? source.slice(0, summaryIndex) : source;
  };
  const structuredHeaderIndex = findScheduleTableHeaderIndex(lines);
  if (structuredHeaderIndex >= 0) {
    return truncateAtSummary(lines.slice(structuredHeaderIndex + 1));
  }
  const markerIndex = lines.findIndex((line) =>
    !/^\[sheet:/iu.test(cleanText(line)) &&
    /(?:^|[\s|])(?:\d+\.\s*)?\[?\s*(?:간단일정|간략\s*일정|상세일정|일자별\s*일정|일정표)\s*\]?\s*[:：]?(?:$|[\s|])/u
      .test(cleanText(line))
  );
  if (markerIndex >= 0) {
    return truncateAtSummary(lines.slice(markerIndex + 1));
  }

  const firstDayIndex = lines.findIndex((line) =>
    extractDayNoFromScheduleLine(line) !== undefined || parseSimpleDayScheduleLine(line) !== undefined
  );
  if (firstDayIndex >= 0) {
    return truncateAtSummary(lines.slice(firstDayIndex));
  }

  return truncateAtSummary(lines).filter((line) => !isMetaOnlyScheduleText(line));
}

function findScheduleTableHeaderIndex(lines: string[]): number {
  return lines.findIndex((line, index) => {
    if (!isStructuredHeaderLine(line)) return false;
    return lines
      .slice(index + 1, index + 31)
      .some((candidate) => extractDayNoFromScheduleLine(candidate) !== undefined || parseSimpleDayScheduleLine(candidate) !== undefined);
  });
}

function isScheduleTerminalLine(line: string): boolean {
  const text = cleanText(line);
  const compact = text.replace(/\s+/gu, "");
  if (!compact) return false;
  if (/상기일정은.*(?:변경|사정)/u.test(compact)) return true;
  if (/^\(?주\)?하나투어$/u.test(compact)) return true;
  return false;
}

function parseSimpleDayScheduleLine(line: string): { dayNo: number; body: string } | undefined {
  const matched = /^\s*(?:제\s*)?(\d{1,2})\s*일차\s*[:：-]\s*(.+)$/u.exec(line);
  const embeddedDayMatch = /(?:^|[\s|])(?:D|DAY)\s*(\d{1,2})\s*[:：]\s*(.+)$/iu.exec(line);
  const dayNoText = matched?.[1] ?? embeddedDayMatch?.[1];
  if (!dayNoText) return undefined;
  const dayNo = Number(dayNoText);
  if (!Number.isFinite(dayNo) || dayNo <= 0) return undefined;
  const rawBody = matched?.[2] ?? embeddedDayMatch?.[2] ?? "";
  const body = cleanText(rawBody.split(/\s+\|\s+/u)[0] ?? rawBody);
  return { dayNo, body };
}

function splitSimpleList(value: string): string[] {
  return value
    .split(/\s*,\s*/u)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function mealSlotFromSimpleIndex(index: number, total: number): MealSlot {
  if (total >= 3) {
    if (index === 0) return "breakfast";
    if (index === 1) return "lunch";
    return "dinner";
  }
  if (total === 2) return index === 0 ? "lunch" : "dinner";
  return "dinner";
}

function splitExplicitSimpleSchedule(body: string): {
  activities: string[];
  meals: Array<{ slot: MealSlot; text: string }>;
} | null {
  const segments = body
    .split(/\s*\/\s*/u)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
  const meals: Array<{ slot: MealSlot; text: string }> = [];
  const activities: string[] = [];

  for (const segment of segments) {
    const parsedMeal = parseMealFromToken(segment);
    if (parsedMeal) {
      meals.push(parsedMeal);
      continue;
    }
    activities.push(segment);
  }

  if (meals.length === 0) return null;
  return { activities, meals };
}

function simpleActivityType(content: string): ScheduleItemType {
  if (/(숙박|투숙|리조트|호텔|체크인|체크아웃)/u.test(content)) return "ACCOMMODATION";
  if (/(도착|출발|이동|공항)/u.test(content)) return "TRANSFER";
  if (/(자유일정|불포함)/u.test(content)) return "OTHER";
  return "SIGHTSEEING";
}

function directTypedScheduleItem(line: string): ScheduleItem | null {
  const matched = /^(이동|관광|식사|숙박|기타)\s*\|\s*(.+)$/u.exec(line);
  if (!matched?.[1] || !matched[2]) return null;

  const label = matched[1];
  const segments = matched[2]
    .split(/\s*\|\s*/u)
    .map((segment) => cleanText(segment))
    .filter(Boolean);
  let region = "";
  let transport = "";
  let time = "";
  const contentSegments: string[] = [];

  for (const segment of segments) {
    const regionValue = /^(?:지역|도시|region)\s*=\s*(.+)$/iu.exec(segment)?.[1];
    if (regionValue) {
      region = cleanText(regionValue);
      continue;
    }
    const transportValue = /^(?:교통편|교통|차량|transport|transit)\s*=\s*(.+)$/iu.exec(segment)?.[1];
    if (transportValue) {
      transport = cleanText(transportValue);
      continue;
    }
    const timeValue = /^(?:시간|time)\s*=\s*(.+)$/iu.exec(segment)?.[1];
    if (timeValue) {
      time = cleanText(timeValue);
      continue;
    }
    contentSegments.push(segment);
  }

  const content = cleanText(contentSegments.join(" | "));
  if (!content) return null;

  if (label === "식사") {
    const parsedMeal = parseMealFromToken(content);
    const slot = parsedMeal?.slot ?? inferMealSlot(content);
    const mealValue = slot ? sanitizeMealText(parsedMeal?.text ?? content, slot) : content;
    return {
      id: randomUUID(),
      type: "MEAL",
      content: mealValue,
      ...(region ? { region } : {}),
      ...(transport ? { transport } : {}),
      ...(time ? { time } : {}),
      ...(slot ? { mealSlot: slot, meal: { [slot]: mealValue } } : {}),
    };
  }

  const type: ScheduleItemType =
    label === "이동"
      ? "TRANSFER"
      : label === "관광"
        ? "SIGHTSEEING"
        : label === "숙박"
          ? "ACCOMMODATION"
          : "OTHER";
  const split = splitDirectScheduleContent(content);
  return {
    id: randomUUID(),
    type,
    content: split.content,
    ...(split.detail ? { detail: split.detail } : {}),
    ...(region ? { region } : {}),
    ...(transport ? { transport } : {}),
    ...(time ? { time } : {}),
    ...(type === "ACCOMMODATION" ? { hotel: split.content } : {}),
  };
}

function hasExplicitRegionTransportMeta(line: string): boolean {
  return /(?:^|\|)\s*(?:지역|도시|region|교통편|교통|차량|transport|transit)\s*=/iu.test(line);
}

function parseFallbackFromRaw(rawText: string, title?: string): ItineraryData {
  const base = stripRegionAndTransportFromData(parseItineraryText(rawText));
  const allLines = rawText
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);
  const lines = allLines.filter((line) => !isNoiseLine(line));
  if (lines.length === 0) return base;

  const structuredHeaderIndex = findScheduleTableHeaderIndex(allLines);
  const scheduleLineSource = structuredHeaderIndex >= 0 ? allLines : lines;
  const scheduleLines = selectScheduleLines(scheduleLineSource).filter((line) => !isMetaOnlyScheduleText(line));
  const grouped = new Map<number, ScheduleItem[]>();
  const dayDateByNo = new Map<number, string>();
  const seenByDay = new Map<number, Set<string>>();
  const mealIndexByDay = new Map<number, Map<string, number>>();
  const explicitRegionTransportItemIds = new Set<string>();
  let currentDayNo = 1;
  let currentRegion = "";
  let currentTransport = "";
  const fallbackYear = currentYearInKorea().toString();
  const parseDateFromAnyTextForFallback = (line: string): string => {
    const normalized = normalizeDateToken(line);
    const direct = /\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/u.exec(normalized);
    if (direct?.[1] && direct[2] && direct[3]) {
      return normalizeDate(`${direct[1]}-${pad2(direct[2])}-${pad2(direct[3])}`);
    }
    const compact = normalized.replace(/[./\s]/gu, "-");
    const shortMonthDay = /^(\d{1,2})-(\d{1,2})$/u.exec(compact);
    if (shortMonthDay?.[1] && shortMonthDay[2]) {
      return `${fallbackYear}-${pad2(shortMonthDay[1])}-${pad2(shortMonthDay[2])}`;
    }
    const monthDay = /(?:^|\b)(\d{1,2})월\s*(\d{1,2})일/u.exec(normalized);
    if (monthDay?.[1] && monthDay[2]) return `${fallbackYear}-${pad2(monthDay[1])}-${pad2(monthDay[2])}`;
    const monthDayShort = /(?:^|\b)(0?[1-9]|1[0-2])[./](0?[1-9]|[12]\d|3[01])(?!:\d{2})(?:\b|$)/u.exec(normalized);
    if (monthDayShort?.[1] && monthDayShort[2]) {
      return `${fallbackYear}-${pad2(monthDayShort[1])}-${pad2(monthDayShort[2])}`;
    }
    const normalizedDate = parseDateFromAnyText(line);
    return DATE_RE.test(normalizedDate) ? normalizedDate : "";
  };
  const metaDateAnchor = scheduleLines[0]
    ? lines.slice(0, lines.indexOf(scheduleLines[0]))
    : [];
  let currentDate = normalizeDate(
    metaDateAnchor.map(parseDateFromAnyTextForFallback).find(Boolean)
    || base.overview.travelPeriod.start
    || ISO_DATE_TODAY,
  );
  const isBareDateLine = (line: string): boolean => {
    const noPipe = !line.includes("|");
    if (!noPipe) return false;
    if (isDayLabelToken(line) && parseDayNoToken(line) === undefined) return true;
    const compact = cleanText(line).replace(/\s+/gu, "");
    return /^(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}\.?|(?:0?[1-9]|1[0-2])[./](?:0?[1-9]|[12]\d|3[01])\.?)$/u.test(compact);
  };
  let inSummaryBlock = false;
  const structuredHeaderLine = structuredHeaderIndex >= 0 ? allLines[structuredHeaderIndex] : undefined;
  const headerMap = structuredHeaderLine
    ? detectScheduleHeader(splitScheduleColumnsWithTabs(structuredHeaderLine))
    : detectScheduleHeaderFromLines(allLines);

  const parseHeaderAlignedLine = (line: string): boolean => {
    if (!headerMap) return false;
    const columns = splitScheduleColumnsWithTabs(line);
    if (columns.length === 0) return false;

    const valueAt = (index: number | undefined): string => {
      if (index === undefined) return "";
      const value = cleanText(columns[index] ?? "");
      return isPlaceholderCell(value) ? "" : value;
    };
    const valuesFrom = (index: number | undefined): string => {
      if (index === undefined) return "";
      return cleanText(
        columns
          .slice(index)
          .map((value) => cleanText(value))
          .filter((value) => value && !isPlaceholderCell(value))
          .join(" | ")
      );
    };

    let explicitDayNo: number | undefined;
    const dayFromHeader = parseDayNoToken(valueAt(headerMap.dayIndex));
    if (dayFromHeader !== undefined) {
      explicitDayNo = dayFromHeader;
    } else {
      for (const cell of columns) {
        const parsed = parseDayNoToken(cell);
        if (parsed !== undefined) {
          explicitDayNo = parsed;
          break;
        }
      }
    }
    explicitDayNo = explicitDayNo ?? extractDayNoFromScheduleLine(line);
    if (explicitDayNo !== undefined) {
      currentDayNo = explicitDayNo;
    }

    const dateText = valueAt(headerMap.dateIndex);
    const rowDate = dateText ? parseDateFromAnyText(dateText) : "";
    if (rowDate) {
      currentDate = rowDate;
    }

    let content = valueAt(headerMap.contentIndex);
    const detailFromColumn = valuesFrom(headerMap.detailIndex);
    if (!content && detailFromColumn) {
      content = detailFromColumn;
    }
    if (!content) return columns.length > 1;

    const region = valueAt(headerMap.regionIndex);
    const transport = valueAt(headerMap.transportIndex);
    const explicitTime = valueAt(headerMap.timeIndex);
    const inferredTime = explicitTime || extractTimeToken(content);

    const contentLabel = cleanText(content);
    const isHotelLabelContent = /^(?:HOTEL|호텔)$/iu.test(contentLabel);
    const { strippedContent, meals: contentMeals } = extractMealsFromContent(content);
    content = cleanText(strippedContent.replace(/\s*\|\s*$/u, ""));
    const { strippedContent: detailContent, meals: detailMeals } = detailFromColumn
      ? extractMealsFromContent(detailFromColumn)
      : { strippedContent: "", meals: [] };

    let finalContent = content;
    let finalDetail = detailContent;
    if (isNoisyScheduleContent(finalContent) && isMeaningfulText(finalDetail)) {
      finalContent = finalDetail;
      finalDetail = "";
    }
    if (!finalContent && finalDetail) {
      finalContent = finalDetail;
      finalDetail = "";
    }

    if (rowDate) {
      if (explicitDayNo !== undefined || !dayDateByNo.has(currentDayNo)) {
        dayDateByNo.set(currentDayNo, rowDate);
        currentDate = rowDate;
      }
    }

    if (inferredTime) {
      finalContent = cleanText(finalContent.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u, ""));
      finalDetail = cleanText(finalDetail.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u, ""));
    }

    const { strippedContent: timedContent, meals: timedMeals } = extractMealsFromContent(finalContent);
    finalContent = cleanText(timedContent.replace(/\s*\|\s*$/u, ""));
    const allMeals = [...contentMeals, ...detailMeals, ...timedMeals];
    if (allMeals.length > 0 && /^(?:호텔|숙박)$/u.test(compactText(finalContent))) {
      finalContent = "";
    }
    const hasMeaningfulContent = finalContent && isMeaningfulText(finalContent);
    if (!hasMeaningfulContent && allMeals.length === 0) return false;

    const addDetailedItem = (payload: ScheduleItem): void => {
      pushItem(currentDayNo, payload);
    };

    if (finalContent) {
      const split = splitDirectScheduleContent(finalContent);
      const type = isHotelLabelContent ? "ACCOMMODATION" : fallbackType(split.content);
      const mealText = type === "MEAL"
        ? cleanText(finalContent.replace(/(?:^|\s)(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：])\s*/iu, ""))
        : "";

      const item: ScheduleItem = {
        id: randomUUID(),
        type,
        content: type === "MEAL" ? mealText || finalContent : split.content,
        ...(type !== "MEAL" && split.detail ? { detail: cleanText([split.detail, finalDetail].filter(Boolean).join(" | ")) } : {}),
        ...(isLikelyRegion(region) ? { region } : {}),
        ...(transport ? { transport } : {}),
        ...(inferredTime ? { time: inferredTime } : {}),
        ...(type === "ACCOMMODATION" ? { hotel: split.content } : {}),
      };
      addDetailedItem(item);
    }

    for (const meal of allMeals) {
      const mealValue = sanitizeMealText(meal.text, meal.slot);
      const mealItem: ScheduleItem = {
        id: randomUUID(),
        type: "MEAL",
        content: mealValue,
        ...(region ? { region } : {}),
        mealSlot: meal.slot,
        meal: { [meal.slot]: mealValue },
      };
      addDetailedItem(mealItem);
    }

    return true;
  };

  function pushItem(dayNo: number, item: ScheduleItem): void {
    const bucket = grouped.get(dayNo) ?? [];
    const seen = seenByDay.get(dayNo) ?? new Set<string>();
    if (item.type === "MEAL" && item.mealSlot) {
      const mealMap = mealIndexByDay.get(dayNo) ?? new Map<string, number>();
      const existingMealIndex = mealMap.get(item.mealSlot);
      if (existingMealIndex !== undefined) {
        const existing = bucket[existingMealIndex];
        if (existing && existing.type === "MEAL") {
          bucket[existingMealIndex] = mergeMealItems(existing, item);
          return;
        }
      }
    }

    const dedupeKey = `${item.type}|${normalizeItemDedupeKey(item)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    seenByDay.set(dayNo, seen);
    bucket.push(item);
    grouped.set(dayNo, bucket);

    if (item.type === "MEAL" && item.mealSlot) {
      const mealMap = mealIndexByDay.get(dayNo) ?? new Map<string, number>();
      mealMap.set(item.mealSlot, bucket.length - 1);
      mealIndexByDay.set(dayNo, mealMap);
    }
  }

  for (const line of scheduleLines) {
    if (inSummaryBlock) {
      if (!isSummaryTrailerLine(line)) continue;
      continue;
    }
    if (isSummaryTrailerLine(line)) {
      inSummaryBlock = true;
      continue;
    }
    if (isNoiseLine(line)) continue;
    if (/^(?:인원)\s*[:：]/u.test(line)) continue;
    const itemLine = line.replace(/^[-•·*]\s*/u, "");
    const directTypedItem = directTypedScheduleItem(itemLine);
    if (isMetaOnlyScheduleText(line) && !directTypedItem) continue;
    if (line.endsWith("일정표") && !/\d/u.test(line)) continue;
    if (isScheduleChromeToken(line)) continue;
    if (/^(?:항목추가|작성일자?|일정별|일자별|교통표|일정명|수정일)\s*[:：]?\s*$/u.test(line)) continue;
    if (isBareDateLine(line)) {
      const lineDate = parseDateFromAnyTextForFallback(line);
      if (lineDate && !dayDateByNo.has(currentDayNo)) {
        dayDateByNo.set(currentDayNo, lineDate);
      }
      continue;
    }
    if (!line.includes("|") && /일정표$/u.test(line)) continue;

    if (directTypedItem) {
      if (hasExplicitRegionTransportMeta(itemLine)) {
        explicitRegionTransportItemIds.add(directTypedItem.id);
      }
      pushItem(currentDayNo, directTypedItem);
      continue;
    }

    const simpleDay = parseSimpleDayScheduleLine(itemLine);
    if (simpleDay) {
      currentDayNo = simpleDay.dayNo;
      const explicitSchedule = splitExplicitSimpleSchedule(simpleDay.body);
      const [activityPartRaw = "", mealPartRaw = ""] = explicitSchedule
        ? [explicitSchedule.activities.join(", "), ""]
        : simpleDay.body.split(/\s*\/\s*/u);
      const activities = explicitSchedule?.activities ?? splitSimpleList(activityPartRaw);
      for (const activity of activities) {
        if (!isMeaningfulText(activity)) continue;
        const split = splitDirectScheduleContent(activity);
        const type = simpleActivityType(split.content);
        const item: ScheduleItem = {
          id: randomUUID(),
          type,
          content: split.content,
          ...(split.detail ? { detail: split.detail } : {}),
          ...(type === "ACCOMMODATION" ? { hotel: split.content } : {}),
        };
        pushItem(currentDayNo, item);
      }

      const meals = explicitSchedule?.meals
        ?? splitSimpleList(mealPartRaw)
          .filter((meal) => meal !== "불포함")
          .map((meal, index, source) => {
            const parsedMeal = parseMealFromToken(meal);
            const slot = parsedMeal?.slot ?? mealSlotFromSimpleIndex(index, source.length);
            return { slot, text: parsedMeal?.text ?? meal };
          });
      meals.forEach((meal) => {
        const mealValue = sanitizeMealText(meal.text, meal.slot);
        const mealItem: ScheduleItem = {
          id: randomUUID(),
          type: "MEAL",
          content: mealValue,
          mealSlot: meal.slot,
          meal: { [meal.slot]: mealValue },
        };
        pushItem(currentDayNo, mealItem);
      });
      continue;
    }

    if (parseHeaderAlignedLine(itemLine)) continue;

    const directDay = extractDayNoFromScheduleLine(itemLine);
    if (directDay !== undefined) currentDayNo = directDay;

    const lineDate = parseDateFromAnyTextForFallback(itemLine);
    if (lineDate && !itemLine.includes("|")) {
      currentDate = lineDate;
    }

    const parsedColumns = parsePipeColumns(itemLine);
    if (parsedColumns.dayNo !== undefined) currentDayNo = parsedColumns.dayNo;

    const cols = itemLine.split("|").map((v) => cleanText(v)).filter(Boolean);
    let region = cleanText(parsedColumns.region);
    let transport = cleanText(parsedColumns.transport);
    let content = cleanText(parsedColumns.content);

    if (!content) {
      const rest = cols
        .filter(
          (token) =>
            parseDayNoToken(token) === undefined &&
            !isDayLabelToken(token) &&
            !isScheduleChromeToken(token) &&
            !isLikelyRegion(token) &&
            !isLikelyTransport(token)
        )
        .join(" | ");
      content = cleanText(rest);
    }
    const hotelLabel = /^HOTEL\s*(?:[:：]|\||-)\s*(.+)$/iu.exec(content);
    const isHotelLabelLine = Boolean(hotelLabel?.[1]);
    if (hotelLabel?.[1]) {
      content = cleanText(hotelLabel[1]);
    }
    if (!content || !isMeaningfulText(content)) continue;

    if (!region) {
      const candidate = cols.find((token) => isLikelyRegion(token) && !isScheduleChromeToken(token));
      if (candidate) region = candidate;
    }
    if (!transport) {
      const candidate = cols.find((token) => isLikelyTransport(token));
      if (candidate) transport = candidate;
    }
    if (region) currentRegion = region;
    if (transport) currentTransport = transport;
    if (!region && currentRegion) region = currentRegion;
    if (!transport && currentTransport) transport = currentTransport;

    const time = cleanText(parsedColumns.time) || extractTimeToken(content) || extractTimeToken(itemLine);
    if (time) {
      content = cleanText(content.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u, ""));
    }

    const lineMeals = extractMealsFromContent(itemLine).meals;
    const { strippedContent, meals } = extractMealsFromContent(content);
    content = cleanText(strippedContent.replace(/\s*\|\s*$/u, ""));
    const allLineMeals = [...lineMeals, ...meals];
    if (allLineMeals.length > 0 && /^(?:호텔|숙박)$/u.test(compactText(content))) {
      content = "";
    }
    if (lineDate && content && !dayDateByNo.has(currentDayNo)) {
      dayDateByNo.set(currentDayNo, lineDate);
    }

      if (content) {
        const split = isHotelLabelLine ? { content } : splitDirectScheduleContent(content);
        const type = isHotelLabelLine ? "ACCOMMODATION" : fallbackType(split.content);
        const mealSlot = type === "MEAL" ? inferMealSlot(content) : undefined;
        const mealText = type === "MEAL"
          ? cleanText(content.replace(/(?:^|\s)(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：])\s*/iu, ""))
          : "";

      const item: ScheduleItem = {
        id: randomUUID(),
        type,
        content: type === "MEAL" ? mealText || content : split.content,
        ...(type !== "MEAL" && split.detail ? { detail: split.detail } : {}),
        ...(region ? { region } : {}),
        ...(transport ? { transport } : {}),
      ...(time ? { time } : {}),
        ...(type === "MEAL" && mealSlot
          ? { mealSlot, meal: { [mealSlot]: mealText || content } }
          : {}),
        ...(type === "ACCOMMODATION" ? { hotel: split.content } : {}),
      };
      pushItem(currentDayNo, item);
    }

    for (const meal of allLineMeals) {
      const mealValue = sanitizeMealText(meal.text, meal.slot);
      const mealItem: ScheduleItem = {
        id: randomUUID(),
        type: "MEAL",
        content: mealValue,
        ...(region ? { region } : {}),
        mealSlot: meal.slot,
        meal: { [meal.slot]: mealValue },
      };
      pushItem(currentDayNo, mealItem);
    }
  }

  const dayEntries = Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
  if (dayEntries.length === 0) return base;

  const baseDayNo = dayEntries[0]?.[0] ?? 1;
  const baseDate = dayDateByNo.get(baseDayNo) || normalizeDate(currentDate || base.overview.travelPeriod.start || ISO_DATE_TODAY);
  const days: DaySchedule[] = dayEntries.map(([dayNo, items]) => ({
    dayNo,
    date: dayDateByNo.get(dayNo) || addDays(baseDate, dayNo - baseDayNo),
    items: dedupeItems(normalizeMealsInItems(items)),
  }));
  const period = fillDateWindow(days.map((day) => ({ dayNo: day.dayNo, date: day.date })));

  const normalized = {
    ...base,
    header: {
      ...base.header,
      groupName: base.header.groupName || title || "AI 파싱 일정",
    },
    overview: {
      ...base.overview,
      travelPeriod: period,
    },
    days,
  };
  return stripRegionAndTransportFromData(
    mergeRawHotelItems(
      mergeItineraryWithMeta(normalized, extractMetaFromRaw(rawText, title, normalized.days)),
      rawText,
    ),
    explicitRegionTransportItemIds,
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstArrayValue(record: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeAiItemPayload(item: unknown): unknown {
  if (typeof item === "string" || typeof item === "number") {
    return { content: String(item) };
  }
  if (!isUnknownRecord(item)) return item;
  const detail = firstValue(item, ["detail", "details", "상세", "설명", "비고"]) ?? item.detail;
  const content = firstValue(item, [
    "content",
    "title",
    "name",
    "description",
    "text",
    "activity",
    "내용",
    "일정",
    "일정내용",
    "행사",
  ]) ?? item.content ?? detail;
  return {
    ...item,
    type: firstValue(item, ["type", "category", "kind", "구분", "항목구분"]) ?? item.type,
    content,
    detail,
    mealSlot: firstValue(item, ["mealSlot", "mealType", "slot", "식사구분"]) ?? item.mealSlot,
    hotel: firstValue(item, ["hotel", "hotelName", "숙박", "호텔명"]) ?? item.hotel,
  };
}

function normalizeAiDayPayload(day: unknown): unknown {
  if (!isUnknownRecord(day)) return day;
  const items = firstArrayValue(day, ["items", "schedules", "schedule", "activities", "entries", "일정", "항목"]);
  return {
    ...day,
    dayNo: firstValue(day, ["dayNo", "day", "dayNumber", "일차"]) ?? day.dayNo,
    date: firstValue(day, ["date", "날짜", "일자"]) ?? day.date,
    ...(items ? { items: items.map(normalizeAiItemPayload) } : {}),
  };
}

function unwrapAiPayload(raw: unknown): unknown {
  if (Array.isArray(raw)) return { days: raw.map(normalizeAiDayPayload) };
  if (!isUnknownRecord(raw)) return raw;

  const nested = firstValue(raw, ["itinerary", "data", "result"]);
  if (isUnknownRecord(nested) || Array.isArray(nested)) {
    return unwrapAiPayload(nested);
  }

  const days = firstArrayValue(raw, ["days", "itineraryDays", "dailySchedules", "schedule", "schedules", "일정"]);
  return {
    ...raw,
    ...(days ? { days: days.map(normalizeAiDayPayload) } : {}),
  };
}

function normalizeAiResult(raw: unknown, title?: string): ItineraryData {
  const parsed = aiOutputSchema.safeParse(unwrapAiPayload(raw));
  if (!parsed.success) {
    throw new Error("AI 응답이 일정표 형식과 맞지 않습니다.");
  }

  const value = parsed.data;
  const candidateDaysWithoutDates = (value.days ?? [])
    .map((day, index) => {
      const dayNo = day.dayNo ?? index + 1;
      const items = (day.items ?? [])
        .flatMap((item) => {
          const rawContent = cleanText(item.content);
          const extracted = extractMealsFromContent(rawContent);
          const contentForSchedule = cleanText(extracted.strippedContent) || (
            item.type === "MEAL" ? "" : rawContent
          );
          const split = item.detail
            ? { content: contentForSchedule, detail: cleanText(item.detail) }
            : splitStructuredScheduleContent(contentForSchedule);
          const content = split.content;
          const normalizedItems: ScheduleItem[] = [];
          const rawType = item.type ?? (content ? fallbackType(content) : "OTHER");
          const region = isLikelyRegion(item.region ?? "") ? cleanText(item.region) : "";
          const transport = isLikelyTransport(item.transport ?? "") ? cleanText(item.transport) : "";
          const time = extractTimeToken(cleanText(item.time) || content);
          if (content) {
            const inferredType = fallbackType(content);
            const type = inferredType === "ACCOMMODATION" || inferredType === "MEAL"
              ? inferredType
              : rawType;
            normalizedItems.push({
              id: randomUUID(),
              type,
              region,
              transport,
              time,
              content,
              detail: type === "MEAL" ? undefined : split.detail,
              mealSlot: type === "MEAL" ? item.mealSlot ?? inferMealSlot(content) : undefined,
              hotel: cleanText(item.hotel),
            });
          }
          for (const meal of extracted.meals) {
            const mealValue = sanitizeMealText(meal.text, meal.slot);
            normalizedItems.push({
              id: randomUUID(),
              type: "MEAL",
              region,
              transport,
              ...(time ? { time } : {}),
              content: mealValue,
              mealSlot: meal.slot,
              meal: { [meal.slot]: mealValue },
            });
          }
          return normalizedItems;
        })
        .filter((item) => (
          item.type === "MEAL" ? Boolean(item.mealSlot && item.content) : isMeaningfulScheduleItem(item)
        ));
      if (items.length === 0) return null;
      return {
        dayNo,
        date: normalizeOptionalDate(day.date),
        items: dedupeItems(normalizeMealsInItems(items)),
      };
    })
    .filter((day): day is NonNullable<typeof day> => day !== null)
    .sort((a, b) => a.dayNo - b.dayNo);

  if (candidateDaysWithoutDates.length === 0) {
    throw new Error("AI가 일정 항목을 추출하지 못했습니다.");
  }

  const explicitStart = normalizeOptionalDate(value.overview?.travelPeriod?.start);
  const firstDayDate = normalizeOptionalDate(candidateDaysWithoutDates[0]?.date);
  const startDate = explicitStart || firstDayDate || ISO_DATE_TODAY;
  const baseDayNo = candidateDaysWithoutDates[0]?.dayNo ?? 1;
  const candidateDays = candidateDaysWithoutDates.map((day) => ({
    ...day,
    date: addDays(startDate, day.dayNo - baseDayNo),
  }));
  const period = fillDateWindow(candidateDays.map((day) => ({ dayNo: day.dayNo, date: day.date })));

  const result: ItineraryData = {
    header: {
      groupName: cleanText(value.header?.groupName) || title || "AI 파싱 일정",
      writtenAt: normalizeDate(value.header?.writtenAt ?? ISO_DATE_TODAY),
    },
    overview: {
      recipient: cleanText(value.overview?.recipient),
      cities: cleanText(value.overview?.cities),
      travelPeriod: {
        start: startDate,
        end: normalizeOptionalDate(value.overview?.travelPeriod?.end) || period.end,
      },
      passengers: {
        adult: safeNumber(value.overview?.passengers?.adult),
        child: safeNumber(value.overview?.passengers?.child),
        infant: safeNumber(value.overview?.passengers?.infant),
        escort: safeNumber(value.overview?.passengers?.escort),
        foc: safeNumber(value.overview?.passengers?.foc),
      },
      singleCharge:
        value.overview?.singleCharge === undefined
          ? undefined
          : safeNumber(value.overview.singleCharge),
      fare: {
        adultPerPerson: safeNumber(value.overview?.fare?.adultPerPerson),
        childPerPerson: safeNumber(value.overview?.fare?.childPerPerson),
        infantPerPerson: safeNumber(value.overview?.fare?.infantPerPerson),
        total: safeNumber(value.overview?.fare?.total),
        totalWithCard: safeNumber(value.overview?.fare?.totalWithCard),
      },
    },
    basics: {
      flight: {
        departure: cleanText(value.basics?.flight?.departure),
        arrival: cleanText(value.basics?.flight?.arrival),
        localVehicle: cleanText(value.basics?.flight?.localVehicle),
      },
      accommodation: {
        hotel: cleanText(value.basics?.accommodation?.hotel),
        grade: cleanText(value.basics?.accommodation?.grade),
        occupancy: cleanText(value.basics?.accommodation?.occupancy),
      },
      included: cleanText(value.basics?.included),
      excluded: cleanText(value.basics?.excluded),
      optionalTour: cleanText(value.basics?.optionalTour),
      shoppingCenters: safeNumber(value.basics?.shoppingCenters),
      notes: cleanText(value.basics?.notes),
    },
    days: enforceAccommodationLast(candidateDays),
  };

  return stripRegionAndTransportFromData(recalculateDayDatesFromStart(result));
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) {
      throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
    }
    const sliced = trimmed.slice(start, end + 1);
    return JSON.parse(sliced) as unknown;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "AI 파싱 중 알 수 없는 오류가 발생했습니다.";
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

export async function parseItineraryWithDiagnostics({ rawText, title }: ParseWithAiInput): Promise<ItineraryParseResult> {
  if (!rawText.trim()) {
    throw new Error("파싱할 텍스트가 비어 있습니다.");
  }
  const preprocessedText = preprocessRawText(rawText, Number.POSITIVE_INFINITY);
  if (!preprocessedText.trim()) {
    throw new Error("전처리 후 파싱 가능한 텍스트가 없습니다.");
  }
  const aiPromptText = buildAiPromptText(preprocessedText);
  const evidenceSummary = collectItineraryEvidence(preprocessedText);
  const evidenceText = formatEvidenceForPrompt(evidenceSummary);
  const evidenceCounts = countEvidenceItems(evidenceSummary);
  if (!config.ai.apiKey) {
    const itinerary = applyRawMealOverrides(parseFallbackFromRaw(preprocessedText, title), preprocessedText);
    const candidateScore = scoreParsedItinerary("deterministic-narrative", itinerary, preprocessedText);
    return withDiagnosticsQuality(
      {
        source: "fallback-no-key",
        aiAttempted: false,
        evidenceCounts,
      },
      itinerary,
      preprocessedText,
      "deterministic-narrative",
      [candidateScore],
    );
  }
  const parseWithAi = async (): Promise<ItineraryData> => {
    const callAi = async (
      messages: ChatMessage[],
      useJsonResponseFormat: boolean,
    ): Promise<ChatCompletionResponse> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.ai.parseTimeoutMs);
      const body = {
        model: config.ai.model,
        temperature: useJsonResponseFormat ? 0.1 : 0,
        messages,
        ...(useJsonResponseFormat ? { response_format: { type: "json_object" as const } } : {}),
      };

      try {
        const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.ai.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const payload = (await response.json()) as ChatCompletionResponse;
        if (response.ok) return payload;

        const reason = JSON.stringify(payload);
        throw new Error(`AI API 호출 실패 (${response.status}): ${reason}`);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`AI API 호출 시간이 ${config.ai.parseTimeoutMs}ms를 초과했습니다.`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };

    const analysisMessages: ChatMessage[] = [
      {
        role: "system",
        content: ANALYSIS_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildAnalysisUserPrompt(title, aiPromptText, evidenceText),
      },
    ];

    const analysisBody = await callAi(analysisMessages, false);
    const analysisText = analysisBody.choices?.[0]?.message?.content;
    if (!analysisText) {
      throw new Error("AI 분석 결과가 비어 있습니다.");
    }

    const jsonMessages: ChatMessage[] = [
      {
        role: "system",
        content: PARSER_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: FEW_SHOT_USER,
      },
      {
        role: "assistant",
        content: FEW_SHOT_ASSISTANT,
      },
      {
        role: "user",
        content: buildParseUserPrompt(title, analysisText),
      },
    ];

    let body: ChatCompletionResponse;
    try {
      body = await callAi(jsonMessages, true);
    } catch {
      body = await callAi(jsonMessages, false);
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AI 응답 본문이 비어 있습니다.");
    }

    const parsedJson = extractJsonObject(content);
    const normalized = normalizeAiResult(parsedJson, title);
    return recalculateDayDatesFromStart(mergeItineraryWithMeta(
      normalized,
      extractMetaFromRaw(preprocessedText, title, normalized.days),
    ));
  };

  const parseWithFallback = (): ItineraryData => parseFallbackFromRaw(preprocessedText, title);

  let aiResult: ItineraryData | null = null;
  let aiError: string | undefined;
  let aiQuality = {
    meaningfulItemCount: 0,
    expectedMinimumItemCount: estimateExpectedMinimumItems(preprocessedText),
    acceptable: false,
  };
  const fallbackResult = applyRawMealOverrides(parseWithFallback(), preprocessedText);
  const fallbackQuality = evaluateParsedItineraryQuality(fallbackResult, preprocessedText);
  const hasTabularCellBoundaries = /(?:\t|\s\|\s)/u.test(preprocessedText);
  const fallbackCandidate: ItineraryParserCandidate = hasTabularCellBoundaries
    ? "deterministic-tabular"
    : "deterministic-narrative";
  const fallbackScore = scoreParsedItinerary(fallbackCandidate, fallbackResult, preprocessedText);
  const candidateScores: ItineraryCandidateScore[] = [fallbackScore];

  try {
    aiResult = applyRawMealOverrides(
      mergeMissingEvidenceItems(
        mergeMissingAccommodationItems(await parseWithAi(), fallbackResult),
        fallbackResult,
      ),
      preprocessedText,
      { allowIndexFallback: true },
    );
    aiQuality = evaluateParsedItineraryQuality(aiResult, preprocessedText);
    candidateScores.push(scoreParsedItinerary("ai", aiResult, preprocessedText));

    if (aiQuality.acceptable && !hasTabularCellBoundaries) {
      return withDiagnosticsQuality(
        {
          source: "ai",
          aiAttempted: true,
          aiMeaningfulItemCount: aiQuality.meaningfulItemCount,
          expectedMinimumItemCount: aiQuality.expectedMinimumItemCount,
          evidenceCounts,
        },
        aiResult,
        preprocessedText,
        "ai",
        candidateScores,
      );
    }
  } catch (error) {
    aiError = errorMessage(error);
    aiResult = null;
  }

  const aiIsSubstantiallyRicher = Boolean(
    aiResult &&
    aiQuality.meaningfulItemCount >= aiQuality.expectedMinimumItemCount &&
    aiQuality.meaningfulItemCount > fallbackQuality.meaningfulItemCount + Math.max(3, Math.ceil(fallbackQuality.meaningfulItemCount * 0.5)),
  );
  if (aiResult && aiIsSubstantiallyRicher) {
    const itinerary = hasTabularCellBoundaries
      ? applyAuthoritativeTabularItems(aiResult, fallbackResult)
      : applyRawMealOverrides(aiResult, preprocessedText);
    const selectedScore = scoreParsedItinerary("ai", itinerary, preprocessedText);
    return withDiagnosticsQuality(
      {
        source: "ai",
        aiAttempted: true,
        aiMeaningfulItemCount: aiQuality.meaningfulItemCount,
        fallbackMeaningfulItemCount: fallbackQuality.meaningfulItemCount,
        expectedMinimumItemCount: aiQuality.expectedMinimumItemCount,
        evidenceCounts,
      },
      itinerary,
      preprocessedText,
      "ai",
      [...candidateScores.filter((score) => score.candidate !== "ai"), selectedScore],
    );
  }

  const shouldUseFallback =
    !aiResult ||
    !aiQuality.acceptable ||
    (hasTabularCellBoundaries && fallbackQuality.acceptable) ||
    fallbackQuality.meaningfulItemCount > aiQuality.meaningfulItemCount + 1 ||
    fallbackQuality.meaningfulItemCount >= aiQuality.expectedMinimumItemCount;
  const tabularFallbackMeetsMinimum =
    hasTabularCellBoundaries &&
    fallbackQuality.meaningfulItemCount >= aiQuality.expectedMinimumItemCount;

  if (shouldUseFallback) {
    const itinerary = aiResult ? mergeNonScheduleData(fallbackResult, aiResult) : fallbackResult;
    const selectedScore = scoreParsedItinerary(fallbackCandidate, itinerary, preprocessedText);
    return withDiagnosticsQuality(
      {
        source: aiResult && (hasTabularCellBoundaries && (fallbackQuality.acceptable || tabularFallbackMeetsMinimum))
          ? "fallback-tabular"
          : aiResult ? "fallback-quality" : "fallback-ai-error",
        aiAttempted: true,
        ...(aiError ? { aiError } : {}),
        aiMeaningfulItemCount: aiQuality.meaningfulItemCount,
        fallbackMeaningfulItemCount: fallbackQuality.meaningfulItemCount,
        expectedMinimumItemCount: aiQuality.expectedMinimumItemCount,
        evidenceCounts,
      },
      itinerary,
      preprocessedText,
      fallbackCandidate,
      [
        ...candidateScores.filter((score) => score.candidate !== fallbackCandidate),
        selectedScore,
      ],
    );
  }

  const itinerary = applyRawMealOverrides(aiResult ?? fallbackResult, preprocessedText);
  const selectedCandidate: ItineraryParserCandidate = aiResult ? "ai" : fallbackCandidate;
  const selectedScore = scoreParsedItinerary(selectedCandidate, itinerary, preprocessedText);
  return withDiagnosticsQuality(
    {
      source: aiResult ? "ai" : "fallback-ai-error",
      aiAttempted: true,
      ...(aiError ? { aiError } : {}),
      aiMeaningfulItemCount: aiQuality.meaningfulItemCount,
      fallbackMeaningfulItemCount: fallbackQuality.meaningfulItemCount,
      expectedMinimumItemCount: aiQuality.expectedMinimumItemCount,
      evidenceCounts,
    },
    itinerary,
    preprocessedText,
    selectedCandidate,
    [
      ...candidateScores.filter((score) => score.candidate !== selectedCandidate),
      selectedScore,
    ],
  );
}

export async function parseItineraryByAi(input: ParseWithAiInput): Promise<ItineraryData> {
  const result = await parseItineraryWithDiagnostics(input);
  return result.itinerary;
}
