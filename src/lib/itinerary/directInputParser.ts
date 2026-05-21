import { randomUUID } from "node:crypto";
import type {
  DaySchedule,
  ItineraryData,
  MealSlot,
  ScheduleItem,
  ScheduleItemType,
} from "@/types";
import { currentYearInKorea, todayInKorea } from "@/lib/date/korea";
import { enforceAccommodationPolicy } from "@/lib/itinerary/policy";
import { parseItineraryText } from "@/lib/itinerary/importParser";
import {
  parseItineraryWithDiagnostics,
  type ItineraryFieldCoverage,
  type ItineraryParseResult,
} from "@/lib/itinerary/aiParser";

interface ParseDirectInputParams {
  rawText: string;
  title?: string;
}

interface ParsedMeal {
  slot: MealSlot;
  text: string;
}

type ParsedSimpleEntry =
  | { kind: "activity"; content: string }
  | { kind: "meal"; meal: ParsedMeal };

interface DayDraft {
  dayNo: number;
  date: string;
  items: ScheduleItem[];
  mealSlots: Set<MealSlot>;
}

interface DirectMeta {
  groupName: string;
  startDate: string;
  durationDays: number;
  adult: number;
  child: number;
  escort: number;
  hotelLines: string[];
  vehicle: string;
  includedLines: string[];
  excludedLines: string[];
  optionalTour: string;
  shoppingCenters: number | undefined;
  notes: string[];
  fareAdult: number;
}

interface DirectParseState {
  drafts: DayDraft[];
  byDate: Map<string, DayDraft>;
  byDayNo: Map<number, DayDraft>;
  meta: DirectMeta;
  scheduleLineCount: number;
  noiseRemovedCount: number;
}

type DirectSection = "schedule" | "meal" | "excluded" | "notes" | null;

const TODAY = todayInKorea();
const CURRENT_YEAR = currentYearInKorea();
const MEAL_LABEL_PATTERN = "(조식|중식|석식|아침|점심|저녁|조(?!식)|중(?!식)|석(?!식)|B|L|D)";

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/\t/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripDecorativePrefix(value: string): string {
  return cleanText(
    value
      .replace(/^["']|["']$/gu, "")
      .replace(/^(?:[▶└※>*•·\-]+\s*)+/u, "")
      .replace(/^=>\s*/u, "")
  );
}

function pad2(value: string | number): string {
  return String(value).padStart(2, "0");
}

function normalizeYear(value: string): number {
  const year = Number(value);
  if (!Number.isFinite(year)) return CURRENT_YEAR;
  return year < 100 ? 2000 + year : year;
}

function normalizeDateParts(year: number, month: string | number, day: string | number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseDateFromText(value: string): string {
  const text = cleanText(value);
  const full = /(?:^|\D)(20\d{2}|\d{2})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})(?:\s*일)?/u.exec(text);
  if (full?.[1] && full[2] && full[3]) {
    return normalizeDateParts(normalizeYear(full[1]), full[2], full[3]);
  }

  const monthDay = /(?:^|\D)(\d{1,2})\s*(?:월|[./])\s*(\d{1,2})(?:\s*일)?(?:\D|$)/u.exec(text);
  if (monthDay?.[1] && monthDay[2]) {
    return normalizeDateParts(CURRENT_YEAR, monthDay[1], monthDay[2]);
  }

  return "";
}

function parseLeadingMonthDayLine(value: string): { date: string; body: string } | null {
  const match = /^\s*(\d{1,2})\s*[/.]\s*(\d{1,2})\s+(.+)$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    date: normalizeDateParts(CURRENT_YEAR, match[1], match[2]),
    body: cleanText(match[3]),
  };
}

function addDays(base: string, offset: number): string {
  const [yearRaw, monthRaw, dayRaw] = base.split("-").map(Number);
  const date = new Date(Date.UTC(yearRaw ?? CURRENT_YEAR, (monthRaw ?? 1) - 1, dayRaw ?? 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return normalizeDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function parseDurationDays(value: string): number {
  const nightDay = /(\d+)\s*박\s*(\d+)\s*일/u.exec(value);
  if (nightDay?.[2]) return Number(nightDay[2]);

  const days = /(?:~\s*)?(\d+)\s*일\s*간/u.exec(value);
  if (days?.[1]) return Number(days[1]);

  return 0;
}

function parsePassengerCounts(value: string): { adult: number; child: number; escort: number } {
  const text = cleanText(value);
  const labeledAdult = /성인\s*(\d+)/u.exec(text)?.[1];
  const labeledChild = /(?:아동|소아|어린이)\s*(\d+)/u.exec(text)?.[1];
  const labeledEscort = /(?:인솔|가이드|TC)\s*(\d+)/iu.exec(text)?.[1];
  if (labeledAdult || labeledChild || labeledEscort) {
    return {
      adult: labeledAdult ? Number(labeledAdult) : 0,
      child: labeledChild ? Number(labeledChild) : 0,
      escort: labeledEscort ? Number(labeledEscort) : 0,
    };
  }

  const plus = /(\d+)\s*(?:명)?\s*\+\s*(\d+)/u.exec(text);
  if (plus?.[1] && plus[2]) {
    const second = Number(plus[2]);
    return {
      adult: Number(plus[1]),
      child: /가이드|TC|인솔/iu.test(text) ? 0 : second,
      escort: /가이드|TC|인솔/iu.test(text) ? second : 0,
    };
  }

  const headCount = /(\d+)\s*명/u.exec(text);
  return {
    adult: headCount?.[1] ? Number(headCount[1]) : 0,
    child: 0,
    escort: 0,
  };
}

function parseKrwAmount(value: string): number {
  const totalWan = /총\s*([\d,]+)\s*만원/u.exec(value);
  const wan = totalWan ?? /([\d,]+)\s*만원/u.exec(value);
  if (wan?.[1]) return Number(wan[1].replace(/,/gu, "")) * 10000;

  const won = /([\d,]+)\s*원/u.exec(value);
  if (won?.[1]) return Number(won[1].replace(/,/gu, ""));

  return 0;
}

function blankMeta(title?: string): DirectMeta {
  return {
    groupName: title || "직접입력 일정",
    startDate: "",
    durationDays: 0,
    adult: 0,
    child: 0,
    escort: 0,
    hotelLines: [],
    vehicle: "",
    includedLines: [],
    excludedLines: [],
    optionalTour: "",
    shoppingCenters: undefined,
    notes: [],
    fareAdult: 0,
  };
}

function appendUnique(values: string[], value: string): void {
  const text = cleanText(value);
  if (!text) return;
  if (!values.includes(text)) values.push(text);
}

function mealSlotLabel(slot: MealSlot): string {
  if (slot === "breakfast") return "조식";
  if (slot === "lunch") return "중식";
  return "석식";
}

function slotFromToken(value: string): MealSlot | undefined {
  const text = cleanText(value).toLowerCase();
  if (text === "조" || text === "조식" || text === "아침" || text === "b") return "breakfast";
  if (text === "중" || text === "중식" || text === "점심" || text === "l") return "lunch";
  if (text === "석" || text === "석식" || text === "저녁" || text === "d") return "dinner";
  return undefined;
}

function stripPrice(value: string): string {
  return cleanText(
    value
      .replace(/\s*(?:[$€¥￥]\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:USD|EUR|KRW|달러|유로|엔|원|만원))\s*/giu, " ")
      .replace(/\s*(?:책정|예상가|별도)\s*$/gu, "")
      .replace(/^[;:：,\s]+|[;:：,\s]+$/gu, "")
  );
}

function stripWrappingBrackets(value: string): string {
  const text = cleanText(value);
  const square = /^\[(.+)\]$/u.exec(text);
  if (square?.[1]) return cleanText(square[1]);
  const paren = /^\((.+)\)$/u.exec(text);
  if (paren?.[1]) return cleanText(paren[1]);
  return text;
}

function sanitizeMealValue(value: string, slot: MealSlot): string {
  const text = stripWrappingBrackets(stripPrice(value));
  if (!text || /^후(?:\s|$)/u.test(text)) return mealSlotLabel(slot);
  return text;
}

function parseMealEntries(value: string): ParsedMeal[] {
  const text = cleanText(value).replace(/;/gu, ":");
  if (isStandaloneMealMarker(text)) return [];
  const meals: ParsedMeal[] = [];
  const labeled = new RegExp(
    `(?:^|[\\s/,\\[]+)${MEAL_LABEL_PATTERN}\\s*[:：]?\\s*([^/,\\]]+?)(?=(?:\\s+${MEAL_LABEL_PATTERN}\\s*[:：]?)|\\s*[/,\\]]|$)`,
    "giu",
  );

  for (const match of text.matchAll(labeled)) {
    const slot = slotFromToken(match[1] ?? "");
    if (!slot) continue;
    const mealText = sanitizeMealValue(match[2] ?? "", slot);
    if (mealText) meals.push({ slot, text: mealText });
  }

  return meals;
}

function isStandaloneMealMarker(value: string): boolean {
  return /^(?:조식|중식|석식|아침|점심|저녁|조|중|석)$/u.test(cleanText(value));
}

function looksLikeMealList(value: string): boolean {
  const text = cleanText(value);
  if (!text) return false;
  if (parseMealEntries(text).length > 0) return true;
  if (/(정식|식$|뷔페|삼겹살|씨푸드|불고기|분짜|순두부|한식|현지식|호텔식|자유식|기내식|오리구이|샤브샤브|망고빙수|비빔밥|된장찌개|김치전골|몽골식)/u.test(text)) {
    return !/(이동|관광|방문|공항|호텔\s*이동|휴식|투어|탑승|체크|거리|호수|성당|전망대|시장)/u.test(text);
  }
  return false;
}

function parseMealSummaryBody(value: string): ParsedMeal[] {
  const labeledMeals = parseMealEntries(value);
  if (labeledMeals.length > 0) return labeledMeals;

  const parts = cleanText(value)
    .split(/\s*\/\s*/u)
    .map((part) => sanitizeMealValue(part, "lunch"))
    .filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length > 3) return [];
  if (parts.some((part) => !looksLikeMealList(part) && !/^불포함$/u.test(part))) return [];

  if (parts.length === 1) return [{ slot: "lunch", text: parts[0] ?? mealSlotLabel("lunch") }];
  return parts.map((text, index, source) => {
    const slot: MealSlot = source.length >= 3
      ? index === 0 ? "breakfast" : index === 1 ? "lunch" : "dinner"
      : index === 0 ? "lunch" : "dinner";
    return { slot, text };
  });
}

function inferMealsFromList(value: string): ParsedMeal[] {
  const parts = value
    .split(/\s*,\s*/u)
    .map((part) => sanitizeMealValue(part, "lunch"))
    .filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1) return [{ slot: "lunch", text: parts[0] ?? mealSlotLabel("lunch") }];
  return parts.slice(0, 3).map((text, index, source) => {
    const slot: MealSlot = source.length >= 3
      ? index === 0 ? "breakfast" : index === 1 ? "lunch" : "dinner"
      : index === 0 ? "lunch" : "dinner";
    return { slot, text };
  });
}

function scheduleItemType(content: string): ScheduleItemType {
  const text = cleanText(content);
  if (/^(?:오전|오후|전일)?\s*자유(?:일정)?(?:\([^)]+\))?$/u.test(text)) {
    return "OTHER";
  }
  if (/^호텔\s*휴식$/u.test(text)) {
    return "OTHER";
  }
  if (/(호텔|숙박|투숙|체크\s*인|체크인|체크아웃|리조트|Hotel|HOTEL)/u.test(content)) {
    return "ACCOMMODATION";
  }
  if (/(관광|방문|거리|공원|궁|성|섬|대학|유니버셜|서커스|마사지|온천|시장|전망대|박물관|호수|성당|바티칸|베니스|꼬모|사파리|지옥|유후인|다자이후|자금성|천단|이화원|고북수진|케이블카|바딘|롯데|사오비치|야시장|혼똔|키스브릿지|바구니배|오행산|바나산|크루즈|미케비치|손짜|낙타|오프로드|바이크|맨발걷기|일몰|별빛|캠프파이어|꼬마열차|썰매|승마|광장|징기스칸릉|체험|감상|관람)/u.test(content)) {
    return "SIGHTSEEING";
  }
  if (/(공항|이동|도착|출발|버스|차량|샌딩|미팅|항공|탑승|하선)/u.test(content)) {
    return "TRANSFER";
  }
  return "OTHER";
}

function buildScheduleItem(content: string): ScheduleItem | null {
  const text = cleanText(content).replace(/^[,/\-\s]+|[,/\-\s]+$/gu, "");
  if (!text || isStandaloneMealMarker(text)) return null;
  const type = scheduleItemType(text);
  return {
    id: randomUUID(),
    type,
    content: text,
    time: "",
    region: "",
    ...(type === "ACCOMMODATION" ? { hotel: text } : {}),
  };
}

function buildMealItem(slot: MealSlot, text: string): ScheduleItem {
  const value = sanitizeMealValue(text, slot);
  return {
    id: randomUUID(),
    type: "MEAL",
    content: value,
    mealSlot: slot,
    meal: { [slot]: value },
    time: "",
    region: "",
  };
}

function mapTypedItemType(value: string, content: string): ScheduleItemType {
  const label = cleanText(value);
  if (label === "이동") return "TRANSFER";
  if (label === "식사") return "MEAL";
  if (label === "숙박") return "ACCOMMODATION";
  if (label === "관광") return "SIGHTSEEING";
  return scheduleItemType(content);
}

function createDraft(dayNo: number, date: string): DayDraft {
  return {
    dayNo,
    date,
    items: [],
    mealSlots: new Set<MealSlot>(),
  };
}

function getDraftByDayNo(state: DirectParseState, dayNo: number): DayDraft {
  const existing = state.byDayNo.get(dayNo);
  if (existing) return existing;
  const baseDate = state.meta.startDate || TODAY;
  const draft = createDraft(dayNo, addDays(baseDate, dayNo - 1));
  state.byDayNo.set(dayNo, draft);
  state.drafts.push(draft);
  if (draft.date) state.byDate.set(draft.date, draft);
  return draft;
}

function getDraftByDate(state: DirectParseState, date: string): DayDraft {
  const existing = state.byDate.get(date);
  if (existing) return existing;
  const dayNo = state.drafts.length + 1;
  const draft = createDraft(dayNo, date);
  state.byDate.set(date, draft);
  state.byDayNo.set(dayNo, draft);
  state.drafts.push(draft);
  return draft;
}

function addActivity(draft: DayDraft, content: string): void {
  const item = buildScheduleItem(content);
  if (!item) return;
  const key = `${item.type}|${item.content}`;
  const exists = draft.items.some((entry) => `${entry.type}|${entry.content}` === key);
  if (!exists) draft.items.push(item);
}

function addMeal(draft: DayDraft, meal: ParsedMeal): void {
  if (draft.mealSlots.has(meal.slot)) {
    const existing = draft.items.find((item) => item.type === "MEAL" && item.mealSlot === meal.slot);
    if (existing && existing.content !== meal.text) {
      existing.content = `${existing.content} / ${meal.text}`;
      existing.meal = { [meal.slot]: existing.content };
    }
    return;
  }
  draft.items.push(buildMealItem(meal.slot, meal.text));
  draft.mealSlots.add(meal.slot);
}

function splitActivityText(value: string): string[] {
  return value
    .split(/\s{2,}|[,，;；]/u)
    .flatMap((part) => part.split(/\s+-\s+/u))
    .map(cleanText)
    .filter(Boolean);
}

function splitHyphenScheduleText(value: string): string[] {
  return value
    .split(/\s*[-–]\s*/u)
    .map(cleanText)
    .filter(Boolean);
}

function splitMealAdjacentText(value: string): string[] {
  return value
    .split(/\s*[;；]\s*/u)
    .map(cleanText)
    .filter(Boolean);
}

function splitCompactScheduleText(value: string): string[] {
  const hyphenParts = splitHyphenScheduleText(value);
  if (hyphenParts.length > 1) return hyphenParts;

  const parts: string[] = [];
  const mealBlock = new RegExp(`${MEAL_LABEL_PATTERN}\\s*\\([^)]+\\)`, "giu");
  let lastIndex = 0;
  for (const match of value.matchAll(mealBlock)) {
    const index = match.index ?? 0;
    const before = splitMealAdjacentText(value.slice(lastIndex, index));
    parts.push(...before);
    const mealText = cleanText(match[0] ?? "");
    if (mealText) parts.push(mealText);
    lastIndex = index + (match[0]?.length ?? 0);
  }

  const after = splitMealAdjacentText(value.slice(lastIndex));
  parts.push(...after);
  if (parts.length > 1) return parts;

  return splitActivityText(value);
}

function extractBracketedMealBlocks(value: string): { body: string; meals: ParsedMeal[] } {
  const meals: ParsedMeal[] = [];
  const body = value.replace(/\[[^\]]+\]/gu, (block) => {
    const parsedMeals = parseMealEntries(block);
    if (parsedMeals.length === 0) return block;
    meals.push(...parsedMeals);
    return " ";
  });
  return { body: cleanText(body), meals };
}

function appendActivityEntry(entries: ParsedSimpleEntry[], content: string): void {
  const text = cleanText(content).replace(/^[,，;；/\-\s]+|[,，;；/\-\s]+$/gu, "");
  if (!text || isStandaloneMealMarker(text)) return;
  entries.push({ kind: "activity", content: text });
}

function appendMealEntry(entries: ParsedSimpleEntry[], meal: ParsedMeal): void {
  entries.push({ kind: "meal", meal });
}

function appendSimpleSegments(entries: ParsedSimpleEntry[], value: string): void {
  splitCompactScheduleText(value).forEach((entry) => appendSimpleSegment(entries, entry));
}

function appendSimpleSegment(entries: ParsedSimpleEntry[], value: string): void {
  const segment = cleanText(value);
  if (!segment || isStandaloneMealMarker(segment)) return;

  const postMealActivity = /^(조식|중식|석식|아침|점심|저녁)\s*후\s*(.+)$/u.exec(segment);
  if (postMealActivity?.[1] && postMealActivity[2]) {
    appendSimpleSegments(entries, postMealActivity[2]);
    return;
  }

  const parsedMeals = parseMealEntries(segment);
  if (parsedMeals.length > 0) {
    parsedMeals.forEach((meal) => appendMealEntry(entries, meal));
    return;
  }

  appendActivityEntry(entries, segment);
}

function parseSimpleBody(body: string): ParsedSimpleEntry[] {
  const entries: ParsedSimpleEntry[] = [];
  const extracted = extractBracketedMealBlocks(body);
  if (!extracted.body) {
    extracted.meals.forEach((meal) => appendMealEntry(entries, meal));
    return entries;
  }

  const slashParts = extracted.body.split(/\s*\/\s*/u).map(cleanText).filter(Boolean);

  if (slashParts.length === 2 && looksLikeMealList(slashParts[1] ?? "")) {
    splitActivityText(slashParts[0] ?? "").forEach((activity) => appendActivityEntry(entries, activity));
    inferMealsFromList(slashParts[1] ?? "").forEach((meal) => appendMealEntry(entries, meal));
    extracted.meals.forEach((meal) => appendMealEntry(entries, meal));
    return entries;
  }

  const parts = slashParts.length > 0 ? slashParts : [body];
  for (const part of parts) {
    if (isStandaloneMealMarker(part)) continue;
    appendSimpleSegments(entries, part);
  }

  extracted.meals.forEach((meal) => appendMealEntry(entries, meal));
  return entries;
}

function parseDayLine(value: string): { dayNo: number; body: string } | null {
  const text = stripDecorativePrefix(value);
  const matched = /^(?:제\s*)?(\d{1,2})\s*일차\s*[:：-]\s*(.+)$/u.exec(text);
  const dDay = /^(?:D|DAY)\s*(\d{1,2})\s*[:：-]\s*(.+)$/iu.exec(text);
  const dayNoText = matched?.[1] ?? dDay?.[1];
  const body = matched?.[2] ?? dDay?.[2];
  if (!dayNoText || !body) return null;
  const dayNo = Number(dayNoText);
  if (!Number.isFinite(dayNo) || dayNo <= 0) return null;
  return { dayNo, body: cleanText(body) };
}

function parseStarDayMarker(value: string): number | undefined {
  const match = /^\s*\*+\s*(\d{1,2})\s*일차\s*\*+\s*$/u.exec(value);
  if (!match?.[1]) return undefined;
  const dayNo = Number(match[1]);
  return Number.isFinite(dayNo) && dayNo > 0 ? dayNo : undefined;
}

function parseTypedPreviewItem(value: string): ScheduleItem | null {
  const match = /^\s*-\s*(이동|관광|식사|숙박|기타)\s*\|\s*(.+)$/u.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const segments = match[2].split(/\s*\|\s*/u).map(cleanText).filter(Boolean);
  const content = cleanText(segments.filter((segment) => !/^(?:지역|교통편|시간)\s*=/u.test(segment)).join(" | "))
    .replace(/^\*\s*/u, "");
  if (!content) return null;

  if (match[1] === "식사") {
    const meal = parseMealEntries(content)[0];
    if (meal) return buildMealItem(meal.slot, meal.text);
  }

  const type = mapTypedItemType(match[1], content);
  return {
    id: randomUUID(),
    type,
    content,
    time: "",
    region: "",
    ...(type === "ACCOMMODATION" ? { hotel: content } : {}),
  };
}

function parseMetaLabel(value: string): { key: string; value: string } | null {
  const text = stripDecorativePrefix(value);
  const match = /^(?:\d+\.\s*)?(견적코드|기준\s*코드|상품명|일정명|출발일|행사\s*일자?|날짜|기간|인원|차량|호텔(?:\(RQ\))?|항공|포함|불포|불포함|불포함사항|비고|쇼핑\s*&\s*옵션|쇼핑\s*옵션|쇼핑|옵션|지상비|가이드|식사|입장지|기타포함)\s*[:：]\s*(.*)$/u.exec(text);
  if (!match?.[1]) return null;
  return { key: match[1].replace(/\s+/gu, ""), value: cleanText(match[2] ?? "") };
}

function isSectionMarker(value: string): DirectSection {
  const text = stripDecorativePrefix(value).replace(/\s+/gu, "");
  const normalized = text.replace(/[*]/gu, "");
  if (/^간단일정$/u.test(normalized)) return "schedule";
  if (/^\[?(?:일정|상세일정|간단일정|간략일정)\]?$/u.test(normalized)) return "schedule";
  if (/^\[?식사\]?$/u.test(text)) return "meal";
  if (/^\[?불포함\]?$/u.test(text)) return "excluded";
  if (/^\[?비고\]?$/u.test(text)) return "notes";
  return null;
}

function isNumberedMetaLine(value: string): boolean {
  return /^(?:[▶└※>*•·\-\s]+)?\d+\.\s*\S+\s*[:：]/u.test(value);
}

function looksLikeHotelContinuation(value: string): boolean {
  const text = stripDecorativePrefix(value);
  return /(호텔|Hotel|HOTEL|동급|RQ|일차|로마|피렌체|파도바|밀라노|하얏트|노보텔|베스트웨스턴|스기노이|몬토레)/u.test(text);
}

function looksLikeLodgingSummary(value: string): boolean {
  const text = stripDecorativePrefix(value);
  if (!text) return false;
  if (parseDayLine(text) || parseMetaLabel(text) || parseLeadingMonthDayLine(text)) return false;
  return /(호텔|Hotel|HOTEL|동급|리조트|숙소|게르)/u.test(text);
}

function looksLikeDirectNoteLine(value: string): boolean {
  return /(방문정책|방문비용|입장료|책정|불포함|기준|조건|RQ|변동|확인|요금|비용|지상|노팁|노옵션|노쇼핑|싱차|옵션가능|팁포함)/u.test(value);
}

function parseParenthesizedKrwAmount(value: string): number {
  const match = /\(([\d,]{4,})\)/u.exec(value);
  if (!match?.[1]) return 0;
  const amount = Number(match[1].replace(/,/gu, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function looksLikeUnlabeledHeadcountFare(value: string): boolean {
  return /^\d+\s*\+\s*\d+\s*=\s*[\d,.]+\s*(?:불|달러|USD|\$)?(?:\s*\([\d,]+\))?$/iu.test(stripDecorativePrefix(value));
}

function applyMeta(state: DirectParseState, key: string, value: string): void {
  const meta = state.meta;
  if (key === "상품명" || key === "일정명") {
    if (value) meta.groupName = value;
    return;
  }
  if (key === "출발일" || key === "행사일" || key === "행사일자" || key === "날짜" || key === "기간") {
    const date = parseDateFromText(value);
    if (date && !meta.startDate) meta.startDate = date;
    const durationDays = parseDurationDays(value);
    if (durationDays > 0) meta.durationDays = durationDays;
    return;
  }
  if (key === "인원") {
    const passengers = parsePassengerCounts(value);
    if (passengers.adult > 0) meta.adult = passengers.adult;
    if (passengers.child > 0) meta.child = passengers.child;
    if (passengers.escort > 0) meta.escort = passengers.escort;
    return;
  }
  if (key.startsWith("호텔")) {
    appendUnique(meta.hotelLines, value);
    return;
  }
  if (key === "차량") {
    meta.vehicle = value;
    return;
  }
  if (key === "포함" || key === "기타포함" || key === "입장지") {
    appendUnique(meta.includedLines, value);
    return;
  }
  if (key === "불포" || key === "불포함" || key === "불포함사항") {
    appendUnique(meta.excludedLines, value);
    appendUnique(meta.notes, value);
    return;
  }
  if (key === "비고") {
    if (/노옵션/u.test(value)) meta.optionalTour = "노옵션";
    const shopping = /쇼핑\s*(\d+)\s*회/u.exec(value);
    if (shopping?.[1]) meta.shoppingCenters = Number(shopping[1]);
    if (/노쇼핑/u.test(value)) meta.shoppingCenters = 0;
    appendUnique(meta.notes, value);
    return;
  }
  if (key === "쇼핑&옵션" || key === "쇼핑옵션" || key === "쇼핑" || key === "옵션") {
    if (/노옵션/u.test(value)) meta.optionalTour = "노옵션";
    const shopping = /쇼핑\s*(\d+)\s*회/u.exec(value);
    if (shopping?.[1]) meta.shoppingCenters = Number(shopping[1]);
    if (/노쇼핑/u.test(value)) meta.shoppingCenters = 0;
    appendUnique(meta.notes, `${key}: ${value}`);
    return;
  }
  if (key === "지상비") {
    const amount = parseKrwAmount(value);
    if (amount > 0) meta.fareAdult = amount;
    appendUnique(meta.notes, value);
    return;
  }
  if (key === "식사" || key === "가이드" || key === "항공" || key === "견적코드" || key === "기준코드") {
    appendUnique(meta.notes, `${key}: ${value}`);
  }
}

function parseDirectInput(rawText: string, title?: string): ItineraryData | null {
  const lines = rawText
    .replace(/\uFEFF/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const state: DirectParseState = {
    drafts: [],
    byDate: new Map<string, DayDraft>(),
    byDayNo: new Map<number, DayDraft>(),
    meta: blankMeta(title),
    scheduleLineCount: 0,
    noiseRemovedCount: 0,
  };
  let section: DirectSection = null;
  let collectingHotel = false;
  let currentScheduleDraft: DayDraft | null = null;

  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (!line) continue;

    const nextSection = isSectionMarker(line);
    if (nextSection) {
      section = nextSection;
      collectingHotel = false;
      currentScheduleDraft = null;
      continue;
    }

    if (collectingHotel && !isNumberedMetaLine(line) && !parseLeadingMonthDayLine(line)) {
      if (looksLikeHotelContinuation(line)) {
        appendUnique(state.meta.hotelLines, stripDecorativePrefix(line));
        continue;
      }
      collectingHotel = false;
    }

    const meta = parseMetaLabel(line);
    if (meta) {
      applyMeta(state, meta.key, meta.value);
      collectingHotel = meta.key.startsWith("호텔");
      section = meta.key === "불포함사항" || meta.key === "불포함" || meta.key === "불포" ? "excluded" : null;
      currentScheduleDraft = null;
      continue;
    }

    const text = stripDecorativePrefix(line);

    if (looksLikeUnlabeledHeadcountFare(text)) {
      const amount = parseParenthesizedKrwAmount(text);
      if (amount > 0) state.meta.fareAdult = amount;
      appendUnique(state.meta.notes, text);
      state.noiseRemovedCount += 1;
      currentScheduleDraft = null;
      continue;
    }

    const passengerLine = /^(\d+)\s*명\s*단독$/u.exec(stripDecorativePrefix(line));
    if (passengerLine?.[1]) {
      state.meta.adult = Number(passengerLine[1]);
      currentScheduleDraft = null;
      continue;
    }

    const dateLine = parseLeadingMonthDayLine(line);
    if (dateLine) {
      const draft = getDraftByDate(state, dateLine.date);
      const meals = parseMealEntries(dateLine.body);
      if (section === "meal" || meals.length > 0) {
        meals.forEach((meal) => addMeal(draft, meal));
        currentScheduleDraft = null;
      } else {
        splitActivityText(dateLine.body).forEach((activity) => addActivity(draft, activity));
        currentScheduleDraft = draft;
      }
      state.scheduleLineCount += 1;
      continue;
    }

    const dayLine = parseDayLine(line);
    if (dayLine) {
      const existingDraft = state.byDayNo.get(dayLine.dayNo);
      const draft = getDraftByDayNo(state, dayLine.dayNo);
      const mealSummary = existingDraft && existingDraft.items.length > 0
        ? parseMealSummaryBody(dayLine.body)
        : [];
      const parsed = mealSummary.length > 0
        ? mealSummary.map((meal): ParsedSimpleEntry => ({ kind: "meal", meal }))
        : parseSimpleBody(dayLine.body);
      parsed.forEach((entry) => {
        if (entry.kind === "activity") {
          addActivity(draft, entry.content);
          return;
        }
        addMeal(draft, entry.meal);
      });
      state.scheduleLineCount += 1;
      currentScheduleDraft = mealSummary.length > 0 ? null : draft;
      continue;
    }

    if (section === "meal") {
      const meals = parseMealEntries(line);
      if (meals.length > 0) {
        const explicitDay = /(\d{1,2})\s*일차/u.exec(line)?.[1];
        const draft = explicitDay
          ? getDraftByDayNo(state, Number(explicitDay))
          : state.drafts[state.drafts.length - 1];
        if (draft) meals.forEach((meal) => addMeal(draft, meal));
        state.scheduleLineCount += 1;
        currentScheduleDraft = null;
        continue;
      }
    }

    if (/^(?:35인승|45인승|대형버스|중형|소형|하이에스)/u.test(text)) {
      state.meta.vehicle = text;
      currentScheduleDraft = null;
      continue;
    }
    if (state.drafts.length === 0 && looksLikeLodgingSummary(text)) {
      appendUnique(state.meta.hotelLines, text);
      currentScheduleDraft = null;
      continue;
    }
    if (/^[^\s]+\s*호텔$/u.test(text) || /호텔$/u.test(text) && state.drafts.length === 0) {
      appendUnique(state.meta.hotelLines, text);
      currentScheduleDraft = null;
      continue;
    }
    if (/노옵션/u.test(text) && !state.meta.optionalTour) state.meta.optionalTour = "노옵션";
    if (/노쇼핑/u.test(text)) state.meta.shoppingCenters = 0;
    const shopping = /쇼핑\s*(\d+)\s*회/u.exec(text);
    if (shopping?.[1]) state.meta.shoppingCenters = Number(shopping[1]);

    if (section === "excluded") {
      appendUnique(state.meta.excludedLines, text);
      appendUnique(state.meta.notes, text);
      state.noiseRemovedCount += 1;
      currentScheduleDraft = null;
      continue;
    }

    if (looksLikeDirectNoteLine(text)) {
      appendUnique(state.meta.notes, text);
      state.noiseRemovedCount += 1;
      currentScheduleDraft = null;
      continue;
    }

    if (currentScheduleDraft) {
      const draft = currentScheduleDraft;
      splitActivityText(text).forEach((activity) => addActivity(draft, activity));
      state.scheduleLineCount += 1;
    }
  }

  const drafts = state.drafts
    .filter((draft) => draft.items.length > 0)
    .sort((left, right) => left.dayNo - right.dayNo);
  if (drafts.length === 0 || state.scheduleLineCount === 0) return null;

  const firstDate = state.meta.startDate || drafts[0]?.date || TODAY;
  const days: DaySchedule[] = drafts.map((draft) => ({
    dayNo: draft.dayNo,
    date: draft.date || addDays(firstDate, draft.dayNo - 1),
    items: draft.items,
  }));
  const start = days[0]?.date || firstDate;
  const end = days[days.length - 1]?.date || addDays(start, Math.max(0, state.meta.durationDays - 1));

  const result: ItineraryData = {
    header: {
      groupName: state.meta.groupName,
      writtenAt: TODAY,
    },
    overview: {
      recipient: "",
      cities: "",
      travelPeriod: { start, end },
      passengers: {
        adult: state.meta.adult,
        child: state.meta.child,
        infant: 0,
        escort: state.meta.escort,
        foc: 0,
      },
      fare: {
        adultPerPerson: state.meta.fareAdult,
        childPerPerson: 0,
        infantPerPerson: 0,
        total: 0,
        totalWithCard: 0,
      },
    },
    basics: {
      flight: {
        departure: "",
        arrival: "",
        localVehicle: state.meta.vehicle,
      },
      accommodation: {
        hotel: state.meta.hotelLines.join(", "),
        grade: "",
        occupancy: "",
      },
      included: state.meta.includedLines.join(", "),
      excluded: state.meta.excludedLines.join(", "),
      optionalTour: state.meta.optionalTour,
      shoppingCenters: state.meta.shoppingCenters ?? 0,
      notes: state.meta.notes.join("\n"),
    },
    days,
  };

  return enforceAccommodationPolicy(result);
}

function collectFieldCoverage(data: ItineraryData): ItineraryFieldCoverage {
  const items = data.days.flatMap((day) => day.items);
  return {
    dayCount: data.days.length,
    datedDayCount: data.days.filter((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day.date)).length,
    meaningfulItemCount: items.filter((item) => item.content.trim().length > 0).length,
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

function directQualityScore(data: ItineraryData): number {
  const coverage = collectFieldCoverage(data);
  const dayScore = Math.min(1, coverage.dayCount / 4) * 25;
  const itemScore = Math.min(1, coverage.meaningfulItemCount / Math.max(1, coverage.dayCount * 2)) * 35;
  const mealScore = coverage.mealCount > 0 ? 15 : 5;
  const metaHits = [
    coverage.hasVehicle,
    coverage.hasHotelSummary,
    coverage.hasIncluded,
    coverage.hasExcluded,
    coverage.hasPassengerCount,
    coverage.hasFare,
  ].filter(Boolean).length;
  return Math.round(Math.min(100, dayScore + itemScore + mealScore + Math.min(20, metaHits * 4) + 5));
}

function looksLikeTypedDirectInput(rawText: string): boolean {
  return /(?:^|\n)\s*-\s*(?:이동|관광|식사|숙박|기타)\s*\|/u.test(rawText);
}

function looksLikeSpreadsheetDirectInput(rawText: string): boolean {
  if (/^\s*\[sheet:[^\]]+\]/imu.test(rawText)) return true;

  const lines = rawText
    .split(/\r?\n/u)
    .map(cleanText)
    .filter(Boolean);
  const tabularLines = lines.filter((line) => (line.match(/\t/gu)?.length ?? 0) >= 2);
  if (tabularLines.length < 2) return false;

  const sample = tabularLines.slice(0, 20).join("\n");
  return /(?:일자|날짜|지역|교통편|시간|일\s*정|식\s*사|제\s*\d{1,2}\s*일)/u.test(sample);
}

function looksLikeStructuredPreviewInput(rawText: string): boolean {
  return /(?:^|\n)\s*<<\s*상품\s*정보\s*>>/u.test(rawText);
}

function structuredPreviewLines(rawText: string): string[] {
  return rawText
    .replace(/\uFEFF/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readStructuredField(lines: string[], label: string): string {
  return readStructuredFieldLines(lines, label).join(", ");
}

function readStructuredFieldLines(lines: string[], label: string): string[] {
  const labelPattern = structuredLabelPattern(label);
  const startIndex = lines.findIndex((line) => labelPattern.test(line));
  if (startIndex < 0) return [];
  const values: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^<<.+>>$/u.test(line) || /^\*+.+\*+$/u.test(line)) break;
    if (parseStarDayMarker(line)) break;
    values.push(stripDecorativePrefix(line));
  }
  return values.map(cleanText).filter(Boolean);
}

function structuredLabelPattern(label: string): RegExp {
  const aliases: Record<string, string[]> = {
    상품명: ["상품명", "상품 이름", "일정명", "행사명"],
    방문도시: ["방문도시", "방문 도시", "여행도시", "여행 도시", "지역"],
    기간: ["기간", "여행기간", "여행 기간", "행사기간", "행사 기간"],
    "성인1인 총 상품가": ["성인1인 총 상품가", "성인 1인 총 상품가", "성인1인상품가", "성인 상품가"],
    "항공 출발": ["항공 출발", "항공출발", "출국편", "출발편"],
    "항공 귀국": ["항공 귀국", "항공귀국", "항공 도착", "항공도착", "귀국편", "리턴편", "도착편"],
    차량: ["차량", "현지차량", "현지 차량"],
    숙박호텔: ["숙박호텔", "숙박 호텔", "호텔", "호텔명"],
    호텔등급: ["호텔등급", "호텔 등급", "등급"],
    "1객실이용인원": ["1객실이용인원", "1객실 이용인원", "객실이용인원", "객실 이용인원"],
    포함사항: ["포함사항", "포함 사항", "포함내역", "포함 내역", "포함"],
    불포함사항: ["불포함사항", "불포함 사항", "불포함내역", "불포함 내역", "불포함", "불포"],
    선택관광: ["선택관광", "선택 관광", "옵션투어", "옵션 투어"],
    "쇼핑센터 방문 수": ["쇼핑센터 방문 수", "쇼핑센터 방문수", "쇼핑센터 수", "쇼핑 센터 수", "쇼핑횟수", "쇼핑 횟수"],
    유의사항: ["유의사항", "유의 사항", "주의사항", "주의 사항", "비고", "참고사항", "참고 사항"],
  };
  const labels = aliases[label] ?? [label];
  const source = labels
    .map((entry) => entry.replace(/\s+/gu, "\\s*"))
    .join("|");
  return new RegExp(`^\\*+\\s*(?:${source})\\s*\\*+$`, "u");
}

function structuredTravelPeriod(lines: string[], days: DaySchedule[]): ItineraryData["overview"]["travelPeriod"] | null {
  const period = readStructuredField(lines, "기간");
  const rangeMatch = /(20\d{2}[./-]\d{1,2}[./-]\d{1,2})\s*(?:~|-|부터)\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/u.exec(period);
  const start = rangeMatch?.[1] ? parseDateFromText(rangeMatch[1]) : days[0]?.date || "";
  const end = rangeMatch?.[2] ? parseDateFromText(rangeMatch[2]) : days[days.length - 1]?.date || start;
  if (!start || !end) return null;
  return { start, end };
}

function buildEmptyStructuredDays(period: ItineraryData["overview"]["travelPeriod"]): DaySchedule[] {
  const [startYear, startMonth, startDay] = period.start.split("-").map(Number);
  const [endYear, endMonth, endDay] = period.end.split("-").map(Number);
  if (!startYear || !startMonth || !startDay || !endYear || !endMonth || !endDay) return [];

  const startDate = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  const endDate = new Date(Date.UTC(endYear, endMonth - 1, endDay));
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(diffDays) || diffDays < 0) return [];

  return Array.from({ length: diffDays + 1 }, (_, index) => ({
    dayNo: index + 1,
    date: addDays(period.start, index),
    items: [],
  }));
}

function parseStructuredPreviewInput(rawText: string, title?: string): ItineraryData | null {
  const lines = structuredPreviewLines(rawText);
  const detailIndex = lines.findIndex((line) => /^<<\s*상세\s*일정\s*>>$/u.test(line));

  const days: DaySchedule[] = [];
  let currentDay: DaySchedule | null = null;
  let pendingDate = "";

  if (detailIndex >= 0) {
    for (let index = detailIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const dayNo = parseStarDayMarker(line);
      if (dayNo) {
        if (currentDay) days.push(currentDay);
        currentDay = { dayNo, date: "", items: [] };
        pendingDate = "";
        continue;
      }

      if (!currentDay) continue;
      const date = parseDateFromText(line);
      if (date && !pendingDate && /^20\d{2}-\d{2}-\d{2}$/u.test(date)) {
        pendingDate = date;
        currentDay.date = date;
        continue;
      }

      const item = parseTypedPreviewItem(line);
      if (item) currentDay.items.push(item);
    }
    if (currentDay) days.push(currentDay);
  }

  const period = structuredTravelPeriod(lines, days);
  if (!period) return null;
  const parsedDays = days.length > 0 ? days : buildEmptyStructuredDays(period);
  if (parsedDays.length === 0) return null;

  const groupName = readStructuredField(lines, "상품명") || title || "직접입력 일정";
  const city = readStructuredField(lines, "방문도시").replace(/^-\s*/u, "");
  const fareAdult = parseKrwAmount(readStructuredField(lines, "성인1인 총 상품가"));
  const shoppingRaw = readStructuredField(lines, "쇼핑센터 방문 수");
  const shopping = /(\d+)/u.exec(shoppingRaw)?.[1];
  const notes = readStructuredFieldLines(lines, "유의사항").join("\n");

  const result: ItineraryData = {
    header: {
      groupName,
      writtenAt: TODAY,
    },
    overview: {
      recipient: "",
      cities: city,
      travelPeriod: period,
      passengers: {
        adult: 0,
        child: 0,
        infant: 0,
        escort: 0,
        foc: 0,
      },
      fare: {
        adultPerPerson: fareAdult,
        childPerPerson: 0,
        infantPerPerson: 0,
        total: 0,
        totalWithCard: 0,
      },
    },
    basics: {
      flight: {
        departure: readStructuredField(lines, "항공 출발"),
        arrival: readStructuredField(lines, "항공 귀국"),
        localVehicle: readStructuredField(lines, "차량"),
      },
      accommodation: {
        hotel: readStructuredField(lines, "숙박호텔"),
        grade: readStructuredField(lines, "호텔등급"),
        occupancy: readStructuredField(lines, "1객실이용인원"),
      },
      included: readStructuredField(lines, "포함사항"),
      excluded: readStructuredField(lines, "불포함사항"),
      optionalTour: readStructuredField(lines, "선택관광"),
      shoppingCenters: shopping ? Number(shopping) : 0,
      notes,
    },
    days: parsedDays.map((day, index) => ({
      ...day,
      date: day.date || addDays(period.start, index),
    })),
  };

  return enforceAccommodationPolicy(result);
}

function tryLegacyFastDirectParse(rawText: string): ItineraryParseResult | null {
  if (!looksLikeTypedDirectInput(rawText)) return null;
  try {
    const itinerary = parseItineraryText(rawText);
    const hasContent = itinerary.days.some((day) => day.items.length > 0);
    if (!hasContent) return null;
    return {
      itinerary,
      diagnostics: {
        source: "fast-text",
        aiAttempted: false,
      },
    };
  } catch {
    return null;
  }
}

export async function parseDirectInputItineraryWithDiagnostics(
  input: ParseDirectInputParams,
): Promise<ItineraryParseResult> {
  if (looksLikeSpreadsheetDirectInput(input.rawText)) {
    return parseItineraryWithDiagnostics(input);
  }

  if (looksLikeStructuredPreviewInput(input.rawText)) {
    const structured = parseStructuredPreviewInput(input.rawText, input.title);
    if (structured) {
      const fieldCoverage = collectFieldCoverage(structured);
      return {
        itinerary: structured,
        diagnostics: {
          source: "fast-text",
          aiAttempted: false,
          selectedCandidate: "deterministic-narrative",
          qualityScore: directQualityScore(structured),
          fieldCoverage,
          noiseRemovedCount: 0,
        },
      };
    }
    return parseItineraryWithDiagnostics(input);
  }

  const fast = tryLegacyFastDirectParse(input.rawText);
  if (fast) return fast;

  const direct = parseDirectInput(input.rawText, input.title);
  if (!direct) {
    return parseItineraryWithDiagnostics(input);
  }

  const fieldCoverage = collectFieldCoverage(direct);
  const qualityScore = directQualityScore(direct);
  return {
    itinerary: direct,
    diagnostics: {
      source: "fast-text",
      aiAttempted: false,
      selectedCandidate: "deterministic-narrative",
      qualityScore,
      fieldCoverage,
      noiseRemovedCount: direct.basics.notes.split("\n").filter(Boolean).length,
      warnings: qualityScore < 70 ? ["직접입력 전용 파서의 품질 점수가 낮습니다. 주요 일정과 식사를 확인해 주세요."] : [],
      candidateScores: [
        {
          candidate: "deterministic-narrative",
          qualityScore,
          acceptable: qualityScore >= 70,
          fieldCoverage,
          meaningfulItemCount: fieldCoverage.meaningfulItemCount,
          expectedMinimumItemCount: Math.max(fieldCoverage.dayCount, fieldCoverage.dayCount * 2),
          suspiciousItemCount: 0,
        },
      ],
    },
  };
}
