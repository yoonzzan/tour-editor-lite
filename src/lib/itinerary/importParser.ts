import * as ExcelJS from "exceljs";
import { v4 as uuidv4 } from "uuid";
import type { DaySchedule, ItineraryData, MealSlot, ScheduleItem, ScheduleItemType } from "@/types";
import { mapMcpProductToItinerary } from "@/lib/mcp/mapSaleProductToItinerary";
import { enforceAccommodationPolicy } from "@/lib/itinerary/policy";
import {
  currentYearInKorea,
  dateStringInKorea,
  todayInKorea,
} from "@/lib/date/korea";
import { splitStructuredScheduleContent } from "@/lib/itinerary/contentDetail";

type UnknownRecord = Record<string, unknown>;

const CURRENT_DATE = todayInKorea();
const PLACEHOLDER_CODE = "UPLOADED";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function asDate(value: unknown): string {
  const text = asString(value);
  if (!text) return "";
  const trimmed = text.trim();
  const compact = trimmed.replace(/[./\s]/g, "-");
  const fullDate = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/u.exec(compact);
  if (fullDate) {
    const [, y, mo, d] = fullDate;
    if (y && mo && d) return `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const looseFullDate = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/u.exec(compact);
  if (looseFullDate?.[1] && looseFullDate[2] && looseFullDate[3]) {
    return `${looseFullDate[1].padStart(4, "0")}-${looseFullDate[2].padStart(2, "0")}-${looseFullDate[3].padStart(2, "0")}`;
  }

  const shortKoreanDate = /(?:^|\b)(\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})일/u.exec(trimmed);
  if (shortKoreanDate?.[1] && shortKoreanDate[2] && shortKoreanDate[3]) {
    const yy = Number(shortKoreanDate[1]);
    const year = yy >= 0 && yy <= 99 ? `20${String(yy).padStart(2, "0")}` : String(yy);
    return `${year}-${shortKoreanDate[2].padStart(2, "0")}-${shortKoreanDate[3].padStart(2, "0")}`;
  }

  const koreanDate = /(?:^|\b)(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})일/u.exec(trimmed);
  if (koreanDate?.[1] && koreanDate[2] && koreanDate[3]) {
    return `${koreanDate[1].padStart(4, "0")}-${koreanDate[2].padStart(2, "0")}-${koreanDate[3].padStart(2, "0")}`;
  }

  const shortMonthDay = /^(\d{1,2})-(\d{1,2})$/u.exec(compact);
  if (shortMonthDay?.[1] && shortMonthDay[2]) {
    const mo = Number(shortMonthDay[1]);
    const d = Number(shortMonthDay[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const year = currentYearInKorea();
      return `${year}-${shortMonthDay[1].padStart(2, "0")}-${shortMonthDay[2].padStart(2, "0")}`;
    }
  }

  const digitsOnly = compact.replace(/[^0-9]/g, "");
  if (/^\d{8}$/u.test(digitsOnly)) {
    return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
  }

  const parsed = new Date(compact);
  if (!Number.isNaN(parsed.getTime())) {
    const normalized = dateStringInKorea(parsed);
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  }
  return "";
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

function looksLikeItinerary(raw: unknown): raw is ItineraryData {
  if (!isRecord(raw)) return false;
  const header = raw.header;
  const overview = raw.overview;
  const basics = raw.basics;
  const days = raw.days;
  return isRecord(header) && isRecord(overview) && isRecord(basics) && Array.isArray(days);
}

function sanitizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeSpreadsheetCell(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const hh = value.getHours();
    const mm = value.getMinutes();
    if (year <= 1901) {
      if (hh === 0 && mm === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0) {
        return "";
      }
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
    const mmText = String(value.getMonth() + 1).padStart(2, "0");
    const ddText = String(value.getDate()).padStart(2, "0");
    return `${year}-${mmText}-${ddText}`;
  }
  return sanitizeText(String(value));
}

function normalizeItemType(content: string): ScheduleItemType {
  // 대괄호 안 식당명·식사 추천이 ACCOMMODATION 오분류를 유발하므로 제외
  const forTypeCheck = content.replace(/\[[^\]]*\]/gu, "");
  const lower = forTypeCheck.toLowerCase();
  if (/(숙박|호텔|리조트)/u.test(forTypeCheck)) return "ACCOMMODATION";
  if (/(식사|조식|중식|석식|아침|점심|저녁|식권|다이닝)/u.test(forTypeCheck)) return "MEAL";
  if (/(항공|이동|차량|버스|택시|공항|transfer|flight)/u.test(lower)) return "TRANSFER";
  if (/(골프|관광|투어|체험|탐방|스파|쇼핑)/u.test(forTypeCheck)) return "SIGHTSEEING";
  return "OTHER";
}

function inferMealSlot(content: string): MealSlot {
  if (/(중식|점심|런치|lunch)/iu.test(content)) return "lunch";
  if (/(석식|저녁|디너|dinner)/iu.test(content)) return "dinner";
  return "breakfast";
}

function normalizeMealContent(content: string, detail: string | undefined, slot: MealSlot): string {
  const source = sanitizeText([content, detail].filter(Boolean).join(": "));
  const labelPattern = /^(?:식사\s*\|\s*)?(?:조식|중식|석식|아침|점심|저녁|조|중|석|b|l|d|breakfast|lunch|dinner)\s*(?:[:：]|\|)?\s*/iu;
  const cleaned = sanitizeText(source.replace(labelPattern, ""));
  if (cleaned) return cleaned;
  if (slot === "breakfast") return "조식";
  if (slot === "lunch") return "중식";
  return "석식";
}

function isImportTransport(value: string): boolean {
  const text = sanitizeText(value);
  if (!text || text.length > 20) return false;
  if (/\b(?:OZ|KE|LJ|BX|TW|ZE|RS|7C)\d{2,4}\b/u.test(text)) return true;
  return /^(?:전용버스|버스|항공|항공편|차량|택시|지하철|열차|페리|도보|기내)$/u.test(text);
}

function extractImportTime(value: string): string {
  const matched = /\b([01]?\d|2[0-3]):([0-5]\d)\b/u.exec(value);
  if (!matched?.[1] || !matched[2]) return "";
  return `${matched[1].padStart(2, "0")}:${matched[2]}`;
}

function itemTypeFromLabel(label: string): ScheduleItemType | undefined {
  if (label === "이동") return "TRANSFER";
  if (label === "관광") return "SIGHTSEEING";
  if (label === "식사") return "MEAL";
  if (label === "숙박") return "ACCOMMODATION";
  if (label === "기타") return "OTHER";
  return undefined;
}

function splitColumnScheduleItem(value: string): {
  content: string;
  region?: string;
  transport?: string;
  time?: string;
  type?: ScheduleItemType;
} | undefined {
  const columns = value
    .split("|")
    .map((entry) => sanitizeText(entry))
    .filter(Boolean);
  if (columns.length < 3) return undefined;

  const labelType = itemTypeFromLabel(columns[0] ?? "");
  const offset = labelType ? 1 : 0;
  if (columns.length - offset < 3) return undefined;
  if (!isImportTransport(columns[offset + 1] ?? "")) return undefined;

  const region = columns[offset] ?? "";
  const transport = columns[offset + 1] ?? "";
  const remaining = columns.slice(offset + 2);
  const explicitTime = extractImportTime(remaining[0] ?? "");
  const contentSource = explicitTime ? remaining.slice(1) : remaining;
  const content = sanitizeText(contentSource.join(" | "));
  if (!content) return undefined;

  return {
    content,
    ...(region ? { region } : {}),
    ...(transport ? { transport } : {}),
    ...(explicitTime ? { time: explicitTime } : {}),
    ...(labelType ? { type: labelType } : {}),
  };
}

function buildLineItem(content: string, _dayNo: number, _seq: number, detail?: string): ScheduleItem {
  const columnItem = detail ? undefined : splitColumnScheduleItem(content);
  const split = columnItem ? { content: columnItem.content } : detail ? { content, detail } : splitStructuredScheduleContent(content);
  const itemType = columnItem?.type ?? normalizeItemType(split.content);
  const mealSlot = itemType === "MEAL" ? inferMealSlot([split.content, split.detail].filter(Boolean).join(" ")) : undefined;
  const mealContent = mealSlot ? normalizeMealContent(split.content, split.detail, mealSlot) : "";
  return {
    id: uuidv4(),
    type: itemType,
    content: mealSlot ? mealContent : split.content,
    ...(!mealSlot && split.detail ? { detail: split.detail } : {}),
    ...(mealSlot ? { mealSlot, meal: { [mealSlot]: mealContent } } : {}),
    time: columnItem?.time ?? "",
    region: columnItem?.region ?? "",
    ...(columnItem?.transport ? { transport: columnItem.transport } : {}),
  };
}

function ensureItineraryDateWindow(days: DaySchedule[]): { start: string; end: string } {
  if (days.length === 0) return { start: CURRENT_DATE, end: CURRENT_DATE };
  const sorted = [...days].sort((a, b) => a.dayNo - b.dayNo);
  return {
    start: sorted[0].date || CURRENT_DATE,
    end: sorted[sorted.length - 1].date || sorted[0].date || CURRENT_DATE,
  };
}

function buildBlankFallback(name?: string): ItineraryData {
  return {
    header: {
      groupName: name ?? "직접입력 일정",
      writtenAt: CURRENT_DATE,
    },
    overview: {
      recipient: "",
      cities: "",
      travelPeriod: {
        start: CURRENT_DATE,
        end: CURRENT_DATE,
      },
      passengers: {
        adult: 0,
        child: 0,
        infant: 0,
        escort: 0,
        foc: 0,
      },
      fare: {
        adultPerPerson: 0,
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
        localVehicle: "",
      },
      accommodation: {
        hotel: "",
        grade: "",
        occupancy: "",
      },
      included: "",
      excluded: "",
      optionalTour: "",
      shoppingCenters: 0,
      notes: "",
    },
    days: [],
  };
}

function parseDayLine(line: string): { dayNo: number; content: string } | null {
  const match = /^(?:\(?\s*)?([0-9]{1,2})\s*일차(?:\s*(?:차)?(?:째)?)?(?:\s*[:：-]|\s+)\s*(.*)$/u.exec(line.trim());
  if (!match) return null;
  const dayNo = Number(match[1]);
  if (!Number.isFinite(dayNo) || dayNo <= 0) return null;
  const rawContent = sanitizeText(match[2] ?? "").trim();
  // "(19) : 내용" 또는 "(19) - 내용" 형태 접두사 제거 (일차번호 중복 포함)
  const content = rawContent.replace(/^\(\d{1,2}\)\s*[-:：]\s*/u, "");
  return { dayNo, content };
}

interface HeaderMeta {
  startDate: string;
  endDate: string;
  adult: number;
  escort: number;
  foc: number;
  hotel: string;
  localVehicle: string;
  included: string;
  excluded: string;
  conditions: string;
  shoppingCenters: number | undefined;
  consumedIndices: Set<number>;
}

const HEADER_LINE_RE =
  /^[-•]?\s*(날짜|출발일|일정|인원|호텔|차량|조건|포함사항?|불포함사항?|쇼핑)\s*[:：]\s*(.+)$/u;

function extractHeaderMeta(source: string[]): HeaderMeta {
  const meta: HeaderMeta = {
    startDate: "",
    endDate: "",
    adult: 0,
    escort: 0,
    foc: 0,
    hotel: "",
    localVehicle: "",
    included: "",
    excluded: "",
    conditions: "",
    shoppingCenters: undefined,
    consumedIndices: new Set(),
  };

  let i = 0;
  while (i < source.length) {
    // "N일차" 마커가 나오면 헤더 섹션 종료
    if (/^(?:\(?\s*)?[0-9]{1,2}\s*일차/u.test(source[i] ?? "")) break;

    const match = HEADER_LINE_RE.exec(source[i] ?? "");
    if (!match) {
      i++;
      continue;
    }

    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    meta.consumedIndices.add(i);

    if (key === "날짜" || key === "출발일") {
      meta.startDate = asDate(value);
      // "N박M일" 기간 추출
      const nightDay = /(\d+)\s*박\s*(\d+)\s*일/u.exec(value);
      if (nightDay?.[2] && meta.startDate) {
        const totalDays = Number(nightDay[2]);
        if (totalDays > 0) meta.endDate = addDays(meta.startDate, totalDays - 1);
      }
    } else if (key === "일정") {
      // "3박5일" 단독 행
      const nightDay = /(\d+)\s*박\s*(\d+)\s*일/u.exec(value);
      if (nightDay?.[2] && meta.startDate) {
        const totalDays = Number(nightDay[2]);
        if (totalDays > 0) meta.endDate = addDays(meta.startDate, totalDays - 1);
      }
    } else if (key === "인원") {
      // "14+0TC" 또는 "20+1foc" 또는 "성인 14 / TC 1" 형식 파싱
      const adultMatch = /(\d+)\s*\+?\s*(?:성인)?/u.exec(value);
      if (adultMatch?.[1]) meta.adult = Number(adultMatch[1]);
      const tcMatch = /(\d+)\s*TC/iu.exec(value);
      if (tcMatch?.[1]) meta.escort = Number(tcMatch[1]);
      const focMatch = /(\d+)\s*foc/iu.exec(value);
      if (focMatch?.[1]) meta.foc = Number(focMatch[1]);
    } else if (key === "호텔") {
      // 호텔 행: 다음 줄이 "도시 : 호텔명" 서브라인일 수 있음
      const hotelLines: string[] = [value];
      let j = i + 1;
      while (j < source.length) {
        const subLine = source[j] ?? "";
        // "N일차" 나오거나 다른 키 패턴이면 중단
        if (/^(?:\(?\s*)?[0-9]{1,2}\s*일차/u.test(subLine)) break;
        if (HEADER_LINE_RE.test(subLine)) break;
        if (subLine.length > 0) {
          hotelLines.push(subLine);
          meta.consumedIndices.add(j);
        }
        j++;
        // 서브라인은 최대 5줄만 수집
        if (j - i > 5) break;
      }
      meta.hotel = hotelLines.filter(Boolean).join(", ");
    } else if (key === "차량") {
      meta.localVehicle = value;
    } else if (key === "조건") {
      meta.conditions = value;
      if (/노쇼핑/u.test(value)) meta.shoppingCenters = 0;
    } else if (key === "포함" || key === "포함사항") {
      meta.included = value;
    } else if (key === "불포함" || key === "불포함사항") {
      meta.excluded = value;
    } else if (key === "쇼핑") {
      const shopMatch = /(\d+)/u.exec(value);
      if (shopMatch?.[1]) meta.shoppingCenters = Number(shopMatch[1]);
    }

    i++;
  }

  return meta;
}

function isSectionMarker(line: string): boolean {
  const compact = line.replace(/\s/gu, "");
  return /^[<\[*]{0,2}(간단일정|상세일정|일정표|상품정보|세부일정)[>\]*]{0,2}$/u.test(compact);
}

interface BracketMeal {
  slot: MealSlot;
  content: string;
}

function extractMealBracket(dayContent: string): { cleaned: string; meals: BracketMeal[] } {
  const meals: BracketMeal[] = [];
  const cleaned = dayContent
    .replace(/\[([^\]]+)\]/gu, (_match, inner: string) => {
      const parts = inner.split(/\//u);
      for (const part of parts) {
        const mealMatch = /^(조|중|석|아침|점심|저녁)\s*[:：]\s*(.+)$/u.exec(part.trim());
        if (mealMatch?.[1] && mealMatch[2]) {
          const slotMap: Record<string, MealSlot> = {
            조: "breakfast",
            아침: "breakfast",
            중: "lunch",
            점심: "lunch",
            석: "dinner",
            저녁: "dinner",
          };
          const slot = slotMap[mealMatch[1]] ?? "lunch";
          meals.push({ slot, content: mealMatch[2].trim() });
        }
      }
      return meals.length > 0 ? "" : `[${inner}]`;
    })
    .trim();
  return { cleaned, meals };
}

function splitItemChunk(content: string): string[] {
  if (!content) return [];
  const chunks = content
    .split(/[·•,\n]+/u)
    .flatMap((part) => part.split(";"))
    .map((part) => sanitizeText(part))
    .filter(Boolean);
  if (chunks.length > 0) return chunks;
  return [sanitizeText(content)];
}

function parseNarrativeText(rawText: string, title?: string): ItineraryData {
  const source = rawText
    .replace(/\uFEFF/gu, "")
    .replace(/\t+/gu, " ")
    .split(/\r?\n/gu)
    .map((line) => sanitizeText(line))
    .filter(Boolean);

  if (source.length === 0) {
    return buildBlankFallback(title);
  }

  const meta = extractHeaderMeta(source);

  const grouped: Record<number, string[]> = {};
  const dates: Record<number, string> = {};
  const mealsByDay: Record<number, BracketMeal[]> = {};
  let dayNo = 0;
  let groupName = title;
  let writtenAt = CURRENT_DATE;

  for (let i = 0; i < source.length; i++) {
    if (meta.consumedIndices.has(i)) continue;

    const line = source[i] ?? "";

    if (/^(?:상품명|일정명|제목)[:：]/u.test(line)) {
      const next = line.split(/[:：]/).slice(1).join(":").trim();
      if (next.length > 0) groupName = next;
      continue;
    }

    if (/^(?:작성일|작성일자)[:：]/u.test(line)) {
      const next = line.split(/[:：]/).slice(1).join(":").trim();
      const candidate = asDate(next);
      if (candidate) writtenAt = candidate;
      continue;
    }

    if (isSectionMarker(line)) continue;

    const dayHeader = parseDayLine(line);
    if (dayHeader) {
      dayNo = dayHeader.dayNo;
      grouped[dayNo] ??= [];
      if (dayHeader.content.length > 0) {
        const { cleaned, meals } = extractMealBracket(dayHeader.content);
        if (meals.length > 0) {
          mealsByDay[dayNo] = [...(mealsByDay[dayNo] ?? []), ...meals];
        }
        if (cleaned) grouped[dayNo].push(...splitItemChunk(cleaned));
      }
      const parsedDate = asDate(line);
      if (parsedDate) dates[dayNo] = parsedDate;
      continue;
    }

    if (dayNo === 0) continue;

    const { cleaned, meals } = extractMealBracket(line);
    if (meals.length > 0) {
      mealsByDay[dayNo] = [...(mealsByDay[dayNo] ?? []), ...meals];
    }

    const hasDayPrefix = /^(?:\d{1,2})\s*일차/u.test(line);
    if (/^[-•·*]/u.test(line) || hasDayPrefix) {
      const value = (cleaned || line).replace(/^[-•·*]\s*/u, "");
      grouped[dayNo] ??= [];
      grouped[dayNo].push(...splitItemChunk(value));
      continue;
    }

    grouped[dayNo] ??= [];
    const value = cleaned || line;
    if (value.length > 0) {
      grouped[dayNo].push(...splitItemChunk(value));
    }
  }

  const keys = Object.keys(grouped)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const parsed: DaySchedule[] = [];
  let cursor = CURRENT_DATE;
  for (const key of keys) {
    const dayItems = grouped[key] ?? [];
    const items: ScheduleItem[] = dayItems.filter(Boolean).map((raw, idx) => {
      const normalized = sanitizeText(raw);
      const item = buildLineItem(normalized, key, idx + 1);
      return { ...item, region: item.region ?? "" };
    });

    const bracketMeals = mealsByDay[key] ?? [];
    for (const bm of bracketMeals) {
      items.push({
        id: uuidv4(),
        type: "MEAL",
        content: bm.content,
        mealSlot: bm.slot,
        time: "",
        region: "",
      });
    }

    if (items.length === 0) continue;
    const date = dates[key] || cursor;
    parsed.push({ dayNo: key, date, items });
    cursor = addDays(date, 1);
  }

  if (parsed.length === 0) {
    const fallbackText = source.join(" ");
    const fallbackItems = splitItemChunk(fallbackText).map((entry, index) => buildLineItem(entry, 1, index + 1));
    if (fallbackItems.length > 0) {
      parsed.push({ dayNo: 1, date: CURRENT_DATE, items: fallbackItems });
    }
  }

  const normalized = ensureItineraryDateWindow(parsed);

  const city = parsed
    .flatMap((d) =>
      d.items
        .filter((it) => it.type === "SIGHTSEEING" || it.type === "TRANSFER")
        .map((it) => it.content),
    )
    .filter((c) => c.length <= 20)
    .slice(0, 8)
    .join(" · ");

  const result = buildBlankFallback(groupName);
  result.header.writtenAt = writtenAt;
  result.overview.travelPeriod = normalized;
  result.overview.cities = city;
  result.days = parsed.sort((a, b) => a.dayNo - b.dayNo);

  if (meta.localVehicle) result.basics.flight.localVehicle = meta.localVehicle;
  if (meta.hotel) result.basics.accommodation.hotel = meta.hotel;
  if (meta.included) result.basics.included = meta.included;
  if (meta.excluded) result.basics.excluded = meta.excluded;
  if (meta.conditions) result.basics.notes = meta.conditions;
  if (meta.shoppingCenters !== undefined) result.basics.shoppingCenters = meta.shoppingCenters;
  if (meta.adult > 0) result.overview.passengers.adult = meta.adult;
  if (meta.escort > 0) result.overview.passengers.escort = meta.escort;
  if (meta.foc > 0) result.overview.passengers.foc = meta.foc;
  if (meta.startDate) {
    result.overview.travelPeriod.start = meta.startDate;
    result.overview.travelPeriod.end = meta.endDate || normalized.end;
  }

  return enforceAccommodationPolicy(result);
}
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        value += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      result.push(value.trim());
      value = "";
      continue;
    }
    value += ch;
  }

  result.push(value.trim());
  return result;
}

function parseCsvText(raw: string): ItineraryData {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return buildBlankFallback();

  const rows = lines.map(splitCsvLine);
  const header = rows[0]?.map((entry) => entry.replace(/^"|"$/gu, "")) ?? [];
  if (header.length > 1 && /일차|day|item|내용|content/u.test(header.join(","))) {
    const index = {
      day: header.findIndex((item) => /일차|day/i.test(item)),
      date: header.findIndex((item) => /날짜|date/i.test(item)),
      content: header.findIndex((item) => /내용|content|memo|description/i.test(item)),
      detail: header.findIndex((item) => /상세|detail|설명|비고/i.test(item)),
    };

    const grouped: Record<number, Array<{ content: string; detail?: string }>> = {};
    const dates: Record<number, string> = {};
    for (const row of rows.slice(1)) {
      const dayRaw = Number(row[index.day] ?? 1) || 1;
      const content = sanitizeText(row[index.content] ?? "");
      const detail = index.detail >= 0 ? sanitizeText(row[index.detail] ?? "") : "";
      const dateRaw = asDate(row[index.date] ?? "");
      if (content) {
        grouped[dayRaw] = grouped[dayRaw] ?? [];
        if (detail) {
          grouped[dayRaw].push({ content, detail });
        } else {
          grouped[dayRaw].push(...splitItemChunk(content).map((entry) => ({ content: entry })));
        }
      }
      if (dayRaw && dateRaw) dates[dayRaw] = dateRaw;
    }

    const parsed: DaySchedule[] = [];
    const keys = Object.keys(grouped).map(Number).sort((a, b) => a - b);
    let cursor = CURRENT_DATE;
    for (const key of keys) {
      const dayItems = grouped[key] ?? [];
      if (dayItems.length === 0) continue;
      const items = dayItems.map((entry, idx) => buildLineItem(entry.content, key, idx + 1, entry.detail));
      const date = dates[key] || cursor;
      parsed.push({ dayNo: key, date, items });
      cursor = addDays(date, 1);
    }

    if (parsed.length > 0) {
      const result = buildBlankFallback();
      result.overview.travelPeriod = ensureItineraryDateWindow(parsed);
      result.days = parsed;
      return enforceAccommodationPolicy(result);
    }
  }

  return parseNarrativeText(lines.join("\n"));
}

async function parseExcelBinary(file: File): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = await file.arrayBuffer();
  await workbook.xlsx.load(arrayBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return "";
  const lines: string[] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const rowValues = Array.isArray(row.values) ? row.values.slice(1) : [];
    const values = rowValues.map((value) => cellValueToText(value as ExcelJS.CellValue));
    const line = values.filter(Boolean).join(" | ");
    if (line.length > 0) lines.push(line);
  });
  return lines.join("\n");
}

function cellValueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    const rich = value.richText
      .map((entry) => ({
        text: sanitizeText(entry.text ?? ""),
        bold: Boolean(entry.font?.bold),
      }))
      .filter((entry) => entry.text.length > 0);
    const first = rich[0];
    const rest = rich.slice(1).map((entry) => entry.text).join(" ");
    if (first?.bold && rest) return `${first.text}: ${rest}`;
    return rich.map((entry) => entry.text).join(" ");
  }
  return normalizeSpreadsheetCell(value);
}

async function parseSpreadsheet(file: File): Promise<ItineraryData> {
  const text = await parseExcelBinary(file);
  const result = parseNarrativeText(text);
  if (result.days.length === 0) return buildBlankFallback();
  return enforceAccommodationPolicy(result);
}

export async function parseItineraryTextFile(file: File): Promise<ItineraryData> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const isJson = ext === "json";
  const isExcel = ext === "xls" || ext === "xlsx";
  const isTxt = ext === "txt";
  const isCsv = ext === "csv";

  if (isJson) {
    const raw = await file.text();
    const parsed = (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new Error("JSON 형식이 아닙니다. JSON 형식 또는 CSV/엑셀 파일을 업로드해 주세요.");
      }
    })();

    if (looksLikeItinerary(parsed)) return enforceAccommodationPolicy(parsed);

    const normalized = mapMcpProductToItinerary(parsed, PLACEHOLDER_CODE);
    if (looksLikeItinerary(normalized.itinerary)) return enforceAccommodationPolicy(normalized.itinerary);

    if (isRecord(parsed) && isRecord((parsed as UnknownRecord).itinerary)) {
      const nested = (parsed as UnknownRecord).itinerary;
      if (looksLikeItinerary(nested)) return enforceAccommodationPolicy(nested as ItineraryData);
    }

    const wrapped = parseNarrativeText(raw, PLACEHOLDER_CODE);
    wrapped.header.groupName = PLACEHOLDER_CODE;
    return wrapped;
  }

  if (isExcel) {
    return parseSpreadsheet(file);
  }

  if (isTxt) {
    const raw = await file.text();
    return enforceAccommodationPolicy(parseNarrativeText(raw, PLACEHOLDER_CODE));
  }

  if (isCsv) {
    const raw = await file.text();
    return enforceAccommodationPolicy(parseCsvText(raw));
  }

  throw new Error("지원하지 않는 파일 형식입니다.");
}

export function parseItineraryText(rawText: string): ItineraryData {
  return enforceAccommodationPolicy(parseNarrativeText(rawText));
}
