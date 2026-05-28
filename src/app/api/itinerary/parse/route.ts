import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ExcelJS from "exceljs";
import JSZip from "jszip";
import type * as CfbType from "cfb";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { requireConverterAccess } from "@/lib/converter/access";
import { currentYearInKorea } from "@/lib/date/korea";
import { parseItineraryWithDiagnostics, type ItineraryParseResult } from "@/lib/itinerary/aiParser";
import { parseDirectInputItineraryWithDiagnostics } from "@/lib/itinerary/directInputParser";
import { spreadsheetRowsToText } from "@/lib/itinerary/spreadsheetText";

export const runtime = "nodejs";

const UNSUPPORTED_XLS_MESSAGE = "구형 Excel(.xls)은 보안상 지원하지 않습니다. Excel에서 .xlsx로 저장한 뒤 다시 업로드해 주세요.";
const PDF_OCR_MAX_PAGES = 6;
const PDF_OCR_IMAGE_WIDTH = 1600;
const PDF_TEXT_MIN_CHARS = 80;
const MAX_SPREADSHEET_SHEETS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_OCR_MAX_DIMENSION = 1600;
const IMAGE_OCR_JPEG_QUALITY = 90;
const IMAGE_OCR_TIMEOUT_MS = 60_000;
const PDF_WORKER_PARTS = ["pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"];
const ITINERARY_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ITINERARY_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const QUOTE_RESPONSE_OCR_MARKERS = [
  /\[QUOTE_RESPONSE_SCREEN\]/u,
  /최종\s*합계/u,
  /환율\s*기준/u,
  /1\s*인당\s*NET/iu,
  /예상\s*수익/u,
  /최종\s*입금가/u,
  /항공\s*요금/u,
  /지상\s*요금/u,
  /공동\s*경비\s*요금/u,
  /대리점\s*공개/u,
  /답변\s*첨부파일/u,
  /유효\s*기간/u,
] as const;
const STRONG_QUOTE_RESPONSE_OCR_MARKERS = [
  /\[QUOTE_RESPONSE_SCREEN\]/u,
  /최종\s*합계/u,
  /1\s*인당\s*NET/iu,
  /최종\s*입금가/u,
  /랜드\s*수익/u,
  /대리점\s*공개/u,
  /답변\s*첨부파일/u,
] as const;
let pdfWorkerDataUrlPromise: Promise<string> | null = null;

type OcrMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OcrChatChoice {
  message?: {
    content?: string | null;
  };
}

interface OcrChatCompletionResponse {
  choices?: OcrChatChoice[];
}

function normalizeExcelDate(date: Date): string {
  const year = date.getFullYear();
  if (year <= 1901) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeExcelTimeDate(date: Date): string {
  const hasHistoricalTimezoneRemainder = date.getSeconds() !== 0 || date.getMilliseconds() !== 0;
  const hours = hasHistoricalTimezoneRemainder ? date.getUTCHours() : date.getHours();
  const minutes = hasHistoricalTimezoneRemainder ? date.getUTCMinutes() : date.getMinutes();
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function excelResultValue(value: ExcelJS.CellValue): unknown {
  if (typeof value !== "object" || value === null || value instanceof Date) return value;
  const result = (value as { result?: unknown }).result;
  return result ?? value;
}

function excelCellDisplayValue(cell: ExcelJS.Cell): unknown {
  const sourceCell = cell.isMerged && cell.col === cell.master.col ? cell.master : cell;
  const value = excelResultValue(sourceCell.value);
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (value.getFullYear() <= 1901) {
      if (value.getSeconds() !== 0 || value.getMilliseconds() !== 0) {
        return normalizeExcelTimeDate(value);
      }
      const text = sourceCell.text;
      const timeText = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/u.exec(text);
      if (timeText?.[1] && timeText[2]) {
        return `${timeText[1].padStart(2, "0")}:${timeText[2]}`;
      }
      return normalizeExcelTimeDate(value);
    }
    return normalizeExcelDate(value);
  }
  const text = sourceCell.text;
  return text || value;
}

function scoreWorksheet(worksheet: ExcelJS.Worksheet): number {
  let score = 0;
  const sheetName = worksheet.name.replace(/\s+/gu, "");
  if (/(일정표|상세일정|일정|세부내역|세부)/u.test(sheetName)) score += 80;
  if (/(견적|확정|인보이스)/u.test(sheetName)) score += 25;
  if (/(호텔|식사|가이드|차량)/u.test(sheetName)) score += 15;
  if (/(상품리스트|서차지|수배부용|샘플|sample|예시)/iu.test(sheetName)) score -= 100;

  const sampleLines: string[] = [];
  const rowLimit = Math.min(worksheet.rowCount, 120);
  const columnLimit = Math.min(worksheet.columnCount, 32);
  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values: string[] = [];
    for (let column = 1; column <= columnLimit; column += 1) {
      const value = excelCellDisplayValue(row.getCell(column));
      values.push(typeof value === "string" ? value : String(value));
    }
    const line = values.filter(Boolean).join(" ");
    if (line) sampleLines.push(line);
  }

  const sample = sampleLines.join("\n");
  const dayMatches = sample.match(/(?:제\s*)?\d{1,2}\s*일차?|DAY\s*\d{1,2}/giu)?.length ?? 0;
  const mealMatches = sample.match(/(?:조식|중식|석식|아침|점심|저녁|조[:：]|중[:：]|석[:：]|\b[BLD]\s*[:：])/giu)?.length ?? 0;
  const hotelMatches = sample.match(/(?:HOTEL|호텔|숙소|숙박|리조트)/giu)?.length ?? 0;
  const headerMatches = sample.match(/(?:일자|날짜|지역|교통편|시간|세부\s*일정|ITINERARY|MEALS?)/giu)?.length ?? 0;
  score += Math.min(60, dayMatches * 12);
  score += Math.min(30, mealMatches * 4);
  score += Math.min(25, hotelMatches * 4);
  score += Math.min(30, headerMatches * 5);
  return score;
}

function isPrimaryScheduleWorksheetName(name: string): boolean {
  const sheetName = name.replace(/\s+/gu, "");
  if (/(샘플|sample|예시)/iu.test(sheetName)) return false;
  return /^(?:일정|일정표|상세일정|세부일정)$/u.test(sheetName);
}

function selectWorksheets(workbook: ExcelJS.Workbook): ExcelJS.Worksheet[] {
  const scored = workbook.worksheets
    .map((worksheet, index) => ({ worksheet, index, score: scoreWorksheet(worksheet) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const primaryScheduleSheets = scored
    .filter((entry) => entry.score > 0 && isPrimaryScheduleWorksheetName(entry.worksheet.name))
    .slice(0, MAX_SPREADSHEET_SHEETS)
    .map((entry) => entry.worksheet);
  if (primaryScheduleSheets.length > 0) return primaryScheduleSheets;

  const selected = scored
    .filter((entry) => entry.score > 0)
    .slice(0, MAX_SPREADSHEET_SHEETS)
    .map((entry) => entry.worksheet);
  return selected.length > 0 ? selected : workbook.worksheets.slice(0, 1);
}

function worksheetToText(worksheet: ExcelJS.Worksheet): string {
  const rows: unknown[][] = [];
  const columnCount = worksheet.columnCount;
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values: unknown[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      values.push(excelCellDisplayValue(row.getCell(column)));
    }
    rows.push(values);
  });

  return spreadsheetRowsToText(rows);
}

async function spreadsheetToText(file: File): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = await file.arrayBuffer();
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch {
    throw new Error("올바른 .xlsx 파일이 아닙니다. 파일이 손상되었거나 구형 .xls 형식일 수 있습니다.");
  }
  const worksheets = selectWorksheets(workbook);
  return worksheets
    .map((worksheet) => [`[sheet:${worksheet.name}]`, worksheetToText(worksheet)].filter(Boolean).join("\n"))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

function stripPdfPageMarkers(text: string): string {
  return text
    .replace(/--\s*\d+\s+of\s+\d+\s*--/giu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function cleanPdfLine(line: string): string {
  return line
    .replace(/\u0000/gu, " ")
    .replace(/\t+/gu, " ")
    .replace(/[ \u00a0]+/gu, " ")
    .trim();
}

function cleanPdfColumnLine(line: string): string {
  return line
    .replace(/\u0000/gu, " ")
    .replace(/[ \u00a0]+/gu, " ")
    .trim();
}

function repairPdfBrokenWords(text: string): string {
  return cleanPdfLine(text)
    .replace(/차\s+량/gu, "차량")
    .replace(/전\s+용\s*버스/gu, "전용버스")
    .replace(/기\s+내\s+식/gu, "기내식")
    .replace(/호\s+텔\s+식/gu, "호텔식")
    .replace(/현\s+지\s+식/gu, "현지식")
    .replace(/한\s+식/gu, "한식")
    .replace(/오\s+전/gu, "오전")
    .replace(/전\s+일/gu, "전일")
    .replace(/인\s+천/gu, "인천")
    .replace(/나\s+하/gu, "나하")
    .replace(/온\s+나\s+손/gu, "온나손")
    .replace(/차\s+탄/gu, "차탄")
    .replace(/슈\s+리/gu, "슈리")
    .replace(/\s+([),.])/gu, "$1")
    .replace(/([(])\s+/gu, "$1")
    .trim();
}

function pdfMealSlotLabel(slot: "breakfast" | "lunch" | "dinner"): string {
  if (slot === "breakfast") return "조식";
  if (slot === "lunch") return "중식";
  return "석식";
}

function pdfMealSlotFromMarker(marker: string): "breakfast" | "lunch" | "dinner" | null {
  if (marker === "조") return "breakfast";
  if (marker === "중") return "lunch";
  if (marker === "석") return "dinner";
  return null;
}

function splitPdfTrailingMealMarker(line: string): {
  content: string;
  slot: "breakfast" | "lunch" | "dinner" | null;
} {
  const repaired = repairPdfBrokenWords(line);
  const match = /^(.*?)\s+([조중석])$/u.exec(repaired);
  const slot = match?.[2] ? pdfMealSlotFromMarker(match[2]) : null;
  if (!match?.[1] || !slot) return { content: repaired, slot: null };
  return { content: match[1].trim(), slot };
}

function isPdfMealValueLine(line: string): boolean {
  const cleaned = repairPdfBrokenWords(line)
    .replace(/^[*:：\s]+/u, "")
    .replace(/[)*\s]+$/u, "")
    .trim();
  return /^(?:호텔식|현지식|한식|기내식|공항식|도시락|자유식|선상식|밀박스|불포함|X)(?:\s*[(/].*)?$/iu.test(cleaned);
}

function parsePdfLooseMealLine(line: string): { slot: "breakfast" | "lunch" | "dinner"; text: string } | null {
  const match = /^([조중석])\s+(.+)$/u.exec(repairPdfBrokenWords(line));
  const slot = match?.[1] ? pdfMealSlotFromMarker(match[1]) : null;
  const text = match?.[2]?.trim() ?? "";
  if (!slot || !isPdfMealValueLine(text)) return null;
  return { slot, text };
}

function extractPdfMeals(line: string): Array<{ slot: "breakfast" | "lunch" | "dinner"; text: string }> {
  const meals: Array<{ slot: "breakfast" | "lunch" | "dinner"; text: string }> = [];
  const looseMeal = parsePdfLooseMealLine(line);
  if (looseMeal) meals.push(looseMeal);

  const pattern = /(?:^|\s)([조중석])\s*[:：]\s*([\s\S]*?)(?=\s+[조중석]\s*[:：]|$)/gu;
  for (const match of line.matchAll(pattern)) {
    const marker = match[1];
    const rawText = repairPdfBrokenWords(match[2] ?? "")
      .replace(/^[/:：\s]+/u, "")
      .replace(/\s+(?:HOTEL|Hyatt|Holiday Inn|Radisson|Add)\b.*$/iu, "")
      .trim();
    if (!marker || !rawText || rawText === "X") continue;
    const slot = marker === "조" ? "breakfast" : marker === "중" ? "lunch" : "dinner";
    meals.push({ slot, text: rawText });
  }

  const namedPattern = /(?:^|\s)(조식|중식|석식)(?:\s*\/\s*특식)?\s*(?:[:：]\s*([^\n|]+)|\s+([^\n|]+))?/gu;
  for (const match of line.matchAll(namedPattern)) {
    const marker = match[1];
    const rawValue = repairPdfBrokenWords(match[2] ?? match[3] ?? "")
      .replace(/^[*:：\s]+/u, "")
      .replace(/^[(*\s]+/u, "")
      .replace(/[)*\s]+$/u, "")
      .trim();
    if (!marker || !rawValue || /^후(?:\s|$)/u.test(rawValue)) continue;
    const slot = marker === "조식" ? "breakfast" : marker === "중식" ? "lunch" : "dinner";
    if (meals.some((meal) => meal.slot === slot && meal.text === rawValue)) continue;
    meals.push({ slot, text: rawValue });
  }
  if (!meals.some((meal) => meal.slot === "breakfast") && /호텔\s*조식\s*후/u.test(line)) {
    meals.push({ slot: "breakfast", text: "호텔식" });
  }
  return meals;
}

function removePdfMealFragments(line: string): string {
  if (parsePdfLooseMealLine(line)) return "";
  return splitPdfTrailingMealMarker(repairPdfBrokenWords(line)).content
    .replace(/(?:^|\s)[조중석]\s*[:：]\s*[\s\S]*?(?=\s+[조중석]\s*[:：]|$)/gu, " ")
    .replace(/(?:^|\s)(?:조식|중식|석식)(?:\s*\/\s*특식)?\s*(?:[:：]\s*[^\n|]+|\([^)]+\))/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function isPdfFooterOrContactLine(line: string): boolean {
  return /(?:^|\s)(?:Add|Tel|TEL|T|F|E)\s*[:：-]/iu.test(line)
    || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(line)
    || /\+\d{1,3}\s*\d/u.test(line)
    || isPdfTrailerStartLine(line);
}

function isPdfTrailerStartLine(line: string): boolean {
  return /^(?:감사합니다|참고사항|※?\s*상기\s*일정|[-•·]?\s*(?:환율|가이드\s*통역비|휴관)|.*TEMPORARILY|.*TEMPORÄR)/iu.test(line);
}

function isPdfScheduleHeaderLine(line: string): boolean {
  const compact = line.replace(/\s+/gu, "");
  return /^(?:날짜|일자|도시명|교통편|시각|시간|세부일정|제공식사|행사일정|숙박시설)+$/u.test(compact)
    || /^(?:날짜지역교통편시간행사일정식사)$/u.test(compact)
    || /^(?:일정식사)$/u.test(compact);
}

function isPdfBareDateOrTimeLine(line: string): boolean {
  const compact = line.replace(/\s+/gu, "");
  return /^\(?\d{1,2}[./]\d{1,2}\.?\)?(?:\([^)]+\))?$/u.test(compact)
    || /^\([월화수목금토일]\)$/u.test(compact)
    || /^\d{1,2}:\d{2}$/u.test(compact)
    || /^\d{1,2}::\d{2}$/u.test(compact)
    || /^(?:(?:\([^)]*\))?호텔종료|오전|전일|차량|전용차량|전용버스|조식|중식|석식|OZ\d{3,4}|KE\d{3,4}|AY\s?\d{2,4}|TW\d{3,4})$/iu.test(compact);
}

function isPdfDayPeriodToken(line: string): boolean {
  return /^(?:오전|오후|전일)$/u.test(repairPdfBrokenWords(line).replace(/\s+/gu, ""));
}

function isPdfStructuralScheduleColumn(text: string): boolean {
  const compact = text.replace(/\s+/gu, "");
  return compact.length <= 10
    && (
      /^(?:제)?\d{1,2}일(?:차)?$/u.test(compact)
      ||
      isPdfBareDateOrTimeLine(compact)
      || /^(?:전용)?(?:버스|차량|전용버스|전용차량)$/u.test(compact)
      || /^[가-힣A-Za-z]{1,10}$/u.test(compact)
      || /^[A-Z]{2}\d{2,4}$/iu.test(compact)
    );
}

function hasPdfScheduleSignal(line: string): boolean {
  return /(?:HOTEL|Hyatt|Holiday Inn|Radisson|출발|도착|이동|관광|탐방|방문|견학|수속|집결|체크|호텔|투숙|휴식|중식|석식|조식|만찬|자유|산책|관람|공원|수족관|성|광장|대성당|박물관|궁전|쇼|탑승|공항|가이드|미팅|문화|기관|수도원|운하|폭포|연못|라벤더|국립공원|사옥|생산공장|본사|캠퍼스|지옥계곡|시키사이노오카)/iu.test(line);
}

function pdfScheduleItemType(line: string): "이동" | "관광" | "숙박" | "기타" {
  if (/호텔\s*(?:체크인|투숙|휴식)/u.test(line) && !/(?:HOTEL|Hyatt|Holiday Inn|Radisson|동급|\d?\s*성급\s*호텔|기\s*내\s*숙\s*박)/iu.test(line)) {
    return "기타";
  }
  if (/(?:^| )(?:HOTEL|Hyatt|Holiday Inn|Radisson)\b|\d?\s*성급\s*호텔|호텔\s*(?:투숙|체크인|종료)|리조트\s*도착|기\s*내\s*숙\s*박|동급/iu.test(line)) {
    return "숙박";
  }
  if (/(?:출발|도착|이동|공항|수속|집결|체크아웃|가이드\s*미팅|전용차량|전용버스|\b[A-Z]{2}\s?\d{2,4}\b)/iu.test(line)) {
    return "이동";
  }
  if (/(?:관광|탐방|방문|견학|산책|관람|공원|수족관|성|광장|대성당|박물관|궁전|쇼|수도원|운하|폭포|연못|라벤더|국립공원|사옥|생산공장|본사|캠퍼스|자유일정|쇼핑)/u.test(line)) {
    return "관광";
  }
  return "기타";
}

function normalizePdfHotelLine(line: string): string {
  return repairPdfBrokenWords(line)
    .replace(/^♣?\s*HOTEL\s*[:：]\s*/iu, "")
    .replace(/\(\s*\+\d[\s\S]*$/u, "")
    .replace(/\s+Add\s*[:：][\s\S]*$/iu, "")
    .trim();
}

function isPdfHotelContactLine(line: string): boolean {
  return /^(?:♣?\s*HOTEL\s*[:：]|Hyatt\b|Holiday Inn\b|Radisson\b)/iu.test(line);
}

function normalizePdfScheduleLine(line: string): string {
  return repairPdfBrokenWords(line)
    .replace(/^[▶□■└n•·\-→|\s]+/u, "")
    .replace(/\s*\*약\s*/gu, " 약 ")
    .replace(/\b\d{1,2}[:;]\d{2}(?:\(\+1\))?\b/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

interface PdfScheduleMeta {
  region: string;
  transport: string;
  time: string;
  contentHint: string;
  contextOnly: boolean;
}

function emptyPdfScheduleMeta(): PdfScheduleMeta {
  return {
    region: "",
    transport: "",
    time: "",
    contentHint: "",
    contextOnly: false,
  };
}

function normalizePdfTimeToken(value: string): string {
  return value.replace(";", ":").trim();
}

function extractPdfTimeToken(value: string): string {
  return normalizePdfTimeToken(/\b\d{1,2}[:;]\d{2}(?:\(\+1\))?\b/u.exec(value)?.[0] ?? "");
}

function isPdfTransportToken(value: string): boolean {
  const compact = value.replace(/\s+/gu, "");
  return /^(?:전용차량|전용버스|전용차|차량|버스|고속열차|열차|기차|항공|국내선|국제선|[-]|[A-Z]{2}\d{2,4})$/iu.test(compact);
}

function isPdfLocationToken(value: string): boolean {
  const text = repairPdfBrokenWords(value);
  if (!text || text.length > 24) return false;
  if (isPdfDayPeriodToken(text)) return false;
  if (extractPdfTimeToken(text) || isPdfTransportToken(text) || hasPdfScheduleSignal(text)) return false;
  return /^[\p{L}\s@.-]+$/u.test(text);
}

function inferPdfRegionFromContent(content: string): string {
  const text = repairPdfBrokenWords(content);
  const departure = /([\p{L}]+)\s*출발/u.exec(text);
  const arrival = /([\p{L}]+)\s*도착/u.exec(text);
  const movement = /^([\p{L}]+)로\s*이동/u.exec(text);
  return cleanPdfLine(departure?.[1] ?? arrival?.[1] ?? movement?.[1] ?? "");
}

function stripPdfDatePrefixPreservingColumns(line: string): string {
  return line
    .replace(/^\(?\s*(?:0?[1-9]|1[0-2])[./]\s*(?:3[01]|[12]\d|0?[1-9])\.?\s*\)?(?:\s*\([^)]+\))?\s*/u, "")
    .trim();
}

function parsePdfMonthDayDateLine(line: string): { date: string; rest: string } | null {
  const match = /^\(?\s*(0?[1-9]|1[0-2])[./]\s*(3[01]|[12]\d|0?[1-9])\.?\s*\)?(?:\s*\([^)]+\))?\s*(.*)$/u.exec(line);
  if (!match?.[1] || !match[2]) return null;
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  return {
    date: `${currentYearInKorea()}-${month}-${day}`,
    rest: cleanPdfLine(match[3] ?? ""),
  };
}

function stripPdfDayOrDatePrefix(line: string): string {
  return repairPdfBrokenWords(line)
    .replace(/^(?:제\s*)?\d{1,2}\s*일(?:차)?\s*/u, "")
    .replace(/^\(?\s*(?:0?[1-9]|1[0-2])[./]\s*(?:3[01]|[12]\d|0?[1-9])\.?\s*\)?(?:\s*\([^)]+\))?\s*/u, "")
    .trim();
}

function cleanPdfScheduleContentHint(value: string): string {
  if (parsePdfLooseMealLine(value)) return "";
  return splitPdfTrailingMealMarker(repairPdfBrokenWords(value)).content
    .replace(/^[▶□■└n•·\-→|\s]+/u, "")
    .replace(/\b(?:[조중석])\s*[:：]\s*(?:호텔식|현지식|한\s*식|한식|불포함|기내식)\b/gu, " ")
    .replace(/\s+(?:조|중|석)\s+(?:호텔식|현지식|한\s*식|한식|불포함|기내식)\b/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function isPdfMealColumn(value: string): boolean {
  const repaired = repairPdfBrokenWords(value);
  return /^(?:[조중석])(?:\s*[:：]\s*(?:호텔식|현지식|한\s*식|한식|불포함|기내식)?)?$/u.test(repaired)
    || isPdfMealValueLine(repaired)
    || parsePdfLooseMealLine(repaired) !== null;
}

function normalizePdfTransportToken(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

function parsePdfInlineScheduleSegment(segment: string): Partial<PdfScheduleMeta> {
  const text = stripPdfDayOrDatePrefix(segment);
  if (!text || isPdfDayPeriodToken(text) || isPdfMealColumn(text)) return {};

  if (text !== "-" && isPdfTransportToken(text)) {
    return { transport: normalizePdfTransportToken(text) };
  }

  const standaloneTime = /^(?:\([^)]*\)\s*)?(\d{1,2}[:;]\d{2}(?:\(\+1\))?)$/u.exec(text);
  if (standaloneTime?.[1]) {
    return { time: normalizePdfTimeToken(standaloneTime[1]) };
  }

  const flightEvent = /\b((?:OZ|KE|TW|AY|VY)\s?\d{2,4})\b\s+(\d{1,2}[:;]\d{2}(?:\(\+1\))?)\s+([\p{L}\s]+?)\s*(출발|도착)(.*)$/iu.exec(text);
  if (flightEvent?.[1] && flightEvent[2] && flightEvent[3] && flightEvent[4]) {
    const region = cleanPdfLine(flightEvent[3]);
    const event = flightEvent[4];
    return {
      region,
      transport: normalizePdfTransportToken(flightEvent[1]),
      time: normalizePdfTimeToken(flightEvent[2]),
      contentHint: cleanPdfScheduleContentHint(`${region} ${event}${flightEvent[5] ?? ""}`),
    };
  }

  const vehicleEvent = /^([\p{L}\s]+?)\s+(전용차량|전용버스|전용차|차량|버스)\s+(\d{1,2}[:;]\d{2}(?:\(\+1\))?)\s+(.+)$/iu.exec(text);
  if (vehicleEvent?.[1] && vehicleEvent[2] && vehicleEvent[3] && vehicleEvent[4]) {
    const region = cleanPdfLine(vehicleEvent[1]);
    return {
      ...(isPdfDayPeriodToken(region) ? {} : { region }),
      transport: normalizePdfTransportToken(vehicleEvent[2]),
      time: normalizePdfTimeToken(vehicleEvent[3]),
      contentHint: cleanPdfScheduleContentHint(vehicleEvent[4]),
    };
  }

  const leadingVehicleEvent = /^(전용차량|전용버스|전용차|차량|버스)\s+(?:(?:전일|오전|오후)\s+)?(?:조식\s*후\s*)?(?:▶\s*)?(.+)$/iu.exec(text);
  if (leadingVehicleEvent?.[1] && leadingVehicleEvent[2]) {
    return {
      transport: normalizePdfTransportToken(leadingVehicleEvent[1]),
      contentHint: cleanPdfScheduleContentHint(leadingVehicleEvent[2]),
    };
  }

  const vehicleContext = /^([\p{L}\s]+?)\s+(전용차량|전용버스|전용차|차량|버스)$/iu.exec(text);
  if (vehicleContext?.[1] && vehicleContext[2]) {
    return {
      region: cleanPdfLine(vehicleContext[1]),
      transport: normalizePdfTransportToken(vehicleContext[2]),
    };
  }

  const distanceContext = /^([\p{L}\s]+?)\s+\d+\s*KM$/iu.exec(text);
  if (distanceContext?.[1]) {
    return { region: cleanPdfLine(distanceContext[1]) };
  }

  const distanceEvent = /^([\p{L}\s]+?)\s+\d+\s*KM\s+(?:(\d{1,2}[:;]\d{2}(?:\(\+1\))?)\s+)?(.+)$/iu.exec(text);
  if (distanceEvent?.[1] && distanceEvent[3]) {
    return {
      region: cleanPdfLine(distanceEvent[1]),
      ...(distanceEvent[2] ? { time: normalizePdfTimeToken(distanceEvent[2]) } : {}),
      contentHint: cleanPdfScheduleContentHint(distanceEvent[3]),
    };
  }

  const timeEvent = /^(?:\([^)]*\)\s*)?(\d{1,2}[:;]\d{2}(?:\(\+1\))?)\s+(.+)$/u.exec(text);
  if (timeEvent?.[1] && timeEvent[2]) {
    return {
      time: normalizePdfTimeToken(timeEvent[1]),
      contentHint: cleanPdfScheduleContentHint(timeEvent[2]),
    };
  }

  const regionTimeEvent = /^([\p{L}\s]+?)\s+(\d{1,2}[:;]\d{2}(?:\(\+1\))?)\s+(.+)$/u.exec(text);
  if (regionTimeEvent?.[1] && regionTimeEvent[2] && regionTimeEvent[3]) {
    return {
      region: cleanPdfLine(regionTimeEvent[1]),
      time: normalizePdfTimeToken(regionTimeEvent[2]),
      contentHint: cleanPdfScheduleContentHint(regionTimeEvent[3]),
    };
  }

  if (hasPdfScheduleSignal(text)) {
    return { contentHint: cleanPdfScheduleContentHint(text) };
  }

  return {};
}

function stripPdfLeadingScheduleColumns(line: string): string {
  const parts = line.split("|").map((part) => repairPdfBrokenWords(part)).filter(Boolean);
  if (parts.length < 2) return line;

  const tail = parts[parts.length - 1];
  const head = parts.slice(0, -1);
  if (tail && hasPdfScheduleSignal(tail) && head.some((part) => /^(?:제)?\d{1,2}일(?:차)?$/u.test(part.replace(/\s+/gu, "")))) {
    return tail;
  }
  if (tail && hasPdfScheduleSignal(tail) && head.every(isPdfStructuralScheduleColumn)) {
    return tail;
  }
  if (tail && hasPdfScheduleSignal(tail) && parts.length >= 3 && head.join("").replace(/\s+/gu, "").length <= 30) {
    return tail;
  }

  return line;
}

function splitPdfColumns(line: string): string[] {
  return line
    .split(/\t+|\s*\|\s*/u)
    .map((part) => repairPdfBrokenWords(part))
    .map((part) => part.replace(/^[▶□■└n•·\-→|\s]+/u, "").trim())
    .filter(Boolean);
}

function parsePdfScheduleMeta(rawLine: string): PdfScheduleMeta {
  const columns = splitPdfColumns(rawLine);
  const meta = emptyPdfScheduleMeta();

  if (columns.length === 0) return meta;

  const scheduleColumns = columns.filter((column) => !isPdfMealColumn(column));
  let contentColumnIndex = -1;

  for (const [index, column] of scheduleColumns.entries()) {
    const parsed = parsePdfInlineScheduleSegment(column);
    if (!meta.region && parsed.region) meta.region = parsed.region;
    if (!meta.transport && parsed.transport) meta.transport = parsed.transport;
    if (!meta.time && parsed.time) meta.time = parsed.time;
    if (!meta.contentHint && parsed.contentHint && hasPdfScheduleSignal(parsed.contentHint)) {
      meta.contentHint = parsed.contentHint;
      contentColumnIndex = index;
    }
  }

  if (meta.contentHint && contentColumnIndex >= 0 && /(?:[:：-]\s*|방문기관\s*)$/u.test(meta.contentHint)) {
    const continuation = scheduleColumns
      .slice(contentColumnIndex + 1)
      .map(stripPdfDayOrDatePrefix)
      .filter((column) =>
        column &&
        !isPdfMealColumn(column) &&
        !isPdfDayPeriodToken(column) &&
        !isPdfTransportToken(column) &&
        column !== extractPdfTimeToken(column))
      .join(" ")
      .trim();
    if (continuation) {
      meta.contentHint = cleanPdfScheduleContentHint(`${meta.contentHint} ${continuation}`);
    }
  }

  if (!meta.region && contentColumnIndex > 0) {
    const regionColumn = scheduleColumns
      .slice(0, contentColumnIndex)
      .map(stripPdfDayOrDatePrefix)
      .reverse()
      .find((column) => isPdfLocationToken(column));
    if (regionColumn) meta.region = regionColumn;
  }

  const normalizedLine = normalizePdfScheduleLine(rawLine);
  if (!meta.contentHint) {
    const parsedLine = parsePdfInlineScheduleSegment(normalizedLine);
    if (!meta.region && parsedLine.region) meta.region = parsedLine.region;
    if (!meta.transport && parsedLine.transport) meta.transport = parsedLine.transport;
    if (!meta.time && parsedLine.time) meta.time = parsedLine.time;
    if (parsedLine.contentHint && hasPdfScheduleSignal(parsedLine.contentHint)) {
      meta.contentHint = parsedLine.contentHint;
    }
  }

  if (!meta.contentHint) {
    const cleanColumns = scheduleColumns.map(stripPdfDayOrDatePrefix).filter(Boolean);
    const transportColumn = cleanColumns.find((column) => column !== "-" && isPdfTransportToken(column));
    if (!meta.transport && transportColumn) meta.transport = normalizePdfTransportToken(transportColumn);
    if (!meta.region && cleanColumns.length >= 2 && isPdfLocationToken(cleanColumns[0] ?? "") && isPdfLocationToken(cleanColumns[1] ?? "")) {
      meta.region = cleanPdfLine(cleanColumns[1] ?? "");
    } else if (!meta.region && cleanColumns.length === 1 && isPdfLocationToken(cleanColumns[0] ?? "")) {
      meta.region = cleanPdfLine(cleanColumns[0] ?? "");
    }
  }

  const structuralOnly = scheduleColumns.every((column) => {
    const clean = cleanPdfLine(stripPdfDayOrDatePrefix(column));
    return !clean || isPdfLocationToken(clean) || isPdfTransportToken(clean) || clean === extractPdfTimeToken(clean);
  });
  meta.contextOnly = !meta.contentHint && (!hasPdfScheduleSignal(normalizedLine) || structuralOnly);
  return meta;
}

function cityBeforePdfFlightEvent(line: string, event: "출발" | "도착"): string {
  const beforeEvent = repairPdfBrokenWords(line).split(event)[0] ?? "";
  const text = beforeEvent
    .replace(/\b\d{1,2}[:;]\d{2}(?:\(\+1\))?\b/gu, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  const tokens = text.split(/\s+/u).filter(Boolean);
  return tokens[tokens.length - 1] ?? "";
}

function extractPdfFlightSummaries(sourceLines: string[]): { departure: string; arrival: string } {
  const internationalFlightPattern = /\b((?:OZ|KE|TW|AY)\s?\d{2,4})\b/iu;
  let departure = "";
  let arrival = "";

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = repairPdfBrokenWords(sourceLines[index] ?? "");
    const flightNo = internationalFlightPattern.exec(line)?.[1]?.replace(/\s+/gu, "");
    if (!flightNo) continue;

    const windowLines = sourceLines
      .slice(index, index + 4)
      .map((sourceLine) => repairPdfBrokenWords(sourceLine));
    const joined = windowLines.join(" ");
    const departureLine = windowLines.find((candidate) => candidate.includes("출발")) ?? "";
    const arrivalLine = windowLines.find((candidate) => candidate.includes("도착")) ?? "";
    const times = Array.from(joined.matchAll(/\b\d{1,2}[:;]\d{2}(?:\(\+1\))?\b/gu))
      .map((match) => match[0].replace(";", ":"));
    const departureCity = cityBeforePdfFlightEvent(departureLine, "출발");
    const arrivalCity = cityBeforePdfFlightEvent(arrivalLine, "도착");
    const summary = [
      flightNo,
      departureCity && ` ${departureCity} 출발`,
      times[0] && ` ${times[0]}`,
      arrivalCity && ` / ${arrivalCity} 도착`,
      times[1] && ` ${times[1]}`,
    ].filter(Boolean).join("").trim();
    if (!summary) continue;

    if (!departure && departureCity === "인천") {
      departure = summary;
    } else if (!arrival && arrivalCity === "인천") {
      arrival = summary;
    }
  }

  return { departure, arrival };
}

function isPdfContinuationScheduleLine(content: string): boolean {
  return /^\([^)]{2,}\)$/u.test(content)
    || /^(?:수,|당,|의\s*묘|지구|등\s*탐방|카사|탈루냐|광장,|구릉\s*지구|알바이신\s*지구|유대인\s*거리|누에바\s*광장|히랄다\s*탑|세계\s*3대|대성당|산또\s*또메)/u.test(content);
}

function isHighConfidencePdfTimedEvent(content: string, meta: PdfScheduleMeta): boolean {
  const compact = repairPdfBrokenWords(content).replace(/\s+/gu, "");
  const transport = meta.transport.replace(/\s+/gu, "");
  return /(?:출발|도착)/u.test(compact)
    && (
      /(?:공항|인천|치토세|바르셀로나|헬싱키|프랑크푸르트|말라가)/u.test(compact)
      || /^(?:OZ|KE|TW|AY|VY)\d{2,4}$/iu.test(transport)
    );
}

function stripPdfVisitPrefix(content: string): string {
  return content
    .replace(/^[가-힣A-Za-z\s]+(?=■?\s*방문기관)/u, "")
    .replace(/^■\s*/u, "")
    .trim();
}

function normalizePdfExtractedText(text: string): string {
  const sourceLines = stripPdfPageMarkers(text)
    .split("\n")
    .map(cleanPdfColumnLine)
    .filter(Boolean);
  const output: string[] = [];
  const seenByDay = new Map<number, Set<string>>();
  const flightSummaries = extractPdfFlightSummaries(sourceLines);
  let pendingMeta = emptyPdfScheduleMeta();
  let pendingRegionAmbiguous = false;
  let pendingTimeCandidates: string[] = [];
  let pendingMealSlot: "breakfast" | "lunch" | "dinner" | null = null;
  let currentDayNo = 0;
  let trailerStarted = false;
  let pageInterludeStarted = false;

  const pushUnique = (dayNo: number, line: string): void => {
    const seen = seenByDay.get(dayNo) ?? new Set<string>();
    if (seen.has(line)) return;
    seen.add(line);
    seenByDay.set(dayNo, seen);
    output.push(line);
  };

  const syncPendingTimeMeta = (): void => {
    pendingMeta.time = pendingTimeCandidates.length === 1 ? pendingTimeCandidates[0] ?? "" : "";
  };

  const mergePendingMeta = (meta: PdfScheduleMeta): PdfScheduleMeta => ({
    ...meta,
    region: meta.region || pendingMeta.region,
    transport: meta.transport || pendingMeta.transport,
    time: meta.time || pendingMeta.time,
  });

  const rememberPendingMeta = (meta: PdfScheduleMeta): void => {
    if (meta.region) {
      if (pendingMeta.region && pendingMeta.region !== meta.region) {
        pendingMeta.region = "";
        pendingRegionAmbiguous = true;
      } else if (!pendingRegionAmbiguous) {
        pendingMeta.region = meta.region;
      }
    }
    if (meta.time) {
      if (!pendingTimeCandidates.includes(meta.time)) {
        pendingTimeCandidates.push(meta.time);
      }
      syncPendingTimeMeta();
    }
    pendingMeta = {
      ...pendingMeta,
      transport: meta.transport || pendingMeta.transport,
    };
  };

  const clearPendingMeta = (opts: { preserveTimes?: boolean } = {}): void => {
    const preservedTimes = opts.preserveTimes ? pendingTimeCandidates : [];
    pendingMeta = emptyPdfScheduleMeta();
    pendingTimeCandidates = preservedTimes;
    syncPendingTimeMeta();
    pendingRegionAmbiguous = false;
  };

  const resolvePendingTimeForContent = (
    meta: PdfScheduleMeta,
    content: string,
  ): { meta: PdfScheduleMeta; usedPendingTime: boolean } => {
    if (meta.time || pendingTimeCandidates.length === 0) {
      return { meta, usedPendingTime: false };
    }

    if (pendingTimeCandidates.length === 1 || isHighConfidencePdfTimedEvent(content, meta)) {
      const [time, ...rest] = pendingTimeCandidates;
      pendingTimeCandidates = rest;
      syncPendingTimeMeta();
      return {
        meta: {
          ...meta,
          time: time ?? "",
        },
        usedPendingTime: true,
      };
    }

    return { meta, usedPendingTime: false };
  };

  const clearPendingMetaAfterSchedule = (resolved: { meta: PdfScheduleMeta; usedPendingTime: boolean }): void => {
    clearPendingMeta({
      preserveTimes: pendingTimeCandidates.length > 0 && (resolved.usedPendingTime || !resolved.meta.time),
    });
  };

  const clearPendingMeal = (): void => {
    pendingMealSlot = null;
  };

  const pushPdfMeal = (dayNo: number, slot: "breakfast" | "lunch" | "dinner", text: string): void => {
    const value = repairPdfBrokenWords(text)
      .replace(/^[*:：\s]+/u, "")
      .replace(/[)*\s]+$/u, "")
      .trim();
    if (!value || value === "X") return;
    pushUnique(dayNo, `- 식사 | ${pdfMealSlotLabel(slot)}: ${value}`);
  };

  const pushPdfScheduleItem = (
    dayNo: number,
    type: "이동" | "관광" | "숙박" | "기타",
    content: string,
    meta: PdfScheduleMeta,
  ): void => {
    const value = cleanPdfLine(content);
    if (!value) return;
    const previous = output[output.length - 1] ?? "";
    if (
      type === "관광"
      && previous.startsWith("- 관광 | ")
      && (previous.endsWith(":") || isPdfContinuationScheduleLine(value))
    ) {
      output[output.length - 1] = `${previous} ${value}`;
      return;
    }
    const region = inferPdfRegionFromContent(value) || meta.region;
    const metaSegments = [
      region ? `지역=${region}` : "",
      meta.transport ? `교통편=${meta.transport}` : "",
      meta.time ? `시간=${meta.time}` : "",
    ].filter(Boolean);
    pushUnique(dayNo, [`- ${type}`, ...metaSegments, value].join(" | "));
  };

  const pushSplitPdfScheduleItems = (dayNo: number, contentLine: string, meta: PdfScheduleMeta): boolean => {
    const leadingHotel = /^(\d?\s*성급\s*호텔)(?:\s+(.+))?$/u.exec(contentLine);
    if (leadingHotel?.[1]) {
      pushPdfScheduleItem(dayNo, "숙박", leadingHotel[1], meta);
      const suffix = stripPdfVisitPrefix(leadingHotel[2] ?? "");
      if (suffix && /(?:방문|관광|탐방|견학|기관)/u.test(suffix)) {
        pushPdfScheduleItem(dayNo, "관광", suffix, meta);
      }
      return true;
    }

    const trailingHotel = /^(.+?)\s+(\d?\s*성급\s*호텔|기내\s*숙박)$/u.exec(contentLine);
    if (!trailingHotel?.[1] || !trailingHotel[2]) return false;
    const prefix = trailingHotel[1].trim();
    const accommodation = trailingHotel[2].trim();
    if (prefix && hasPdfScheduleSignal(prefix)) {
      const prefixType = pdfScheduleItemType(prefix);
      pushPdfScheduleItem(dayNo, prefixType === "숙박" ? "기타" : prefixType, prefix, meta);
    }
    pushPdfScheduleItem(dayNo, "숙박", accommodation, meta);
    return true;
  };

  const processScheduleLine = (rawLine: string): void => {
    if (currentDayNo <= 0) return;
    const parsedMeta = parsePdfScheduleMeta(rawLine);
    const meta = parsedMeta.contextOnly ? parsedMeta : mergePendingMeta(parsedMeta);
    const line = normalizePdfScheduleLine(rawLine);
    if (isPdfHotelContactLine(line)) {
      clearPendingMeta();
      clearPendingMeal();
      const hotel = normalizePdfHotelLine(line);
      if (hotel) pushUnique(currentDayNo, `- 숙박 | ${hotel}`);
      return;
    }
    if (pendingMealSlot && isPdfMealValueLine(line)) {
      pushPdfMeal(currentDayNo, pendingMealSlot, line);
      clearPendingMeta();
      clearPendingMeal();
      return;
    }
    const trailingMeal = splitPdfTrailingMealMarker(line);
    const meals = extractPdfMeals(line);
    for (const meal of meals) {
      pushPdfMeal(currentDayNo, meal.slot, meal.text);
    }
    pendingMealSlot = trailingMeal.slot;
    if (meals.length > 0 && parsedMeta.contextOnly) {
      clearPendingMeta();
      return;
    }
    if (parsedMeta.contextOnly) {
      rememberPendingMeta(parsedMeta);
      return;
    }
    if (!line || (isPdfFooterOrContactLine(line) && !isPdfHotelContactLine(line)) || isPdfScheduleHeaderLine(line) || isPdfBareDateOrTimeLine(line)) {
      clearPendingMeta();
      return;
    }

    const withoutMeals = removePdfMealFragments(trailingMeal.content)
      .replace(/^\(?\d{1,2}[./]\d{1,2}\.?\)?\s*/u, "")
      .replace(/^\([월화수목금토일]\)\s*/u, "")
      .trim();
    const rawContentLine = meta.contentHint && hasPdfScheduleSignal(meta.contentHint)
      ? splitPdfTrailingMealMarker(meta.contentHint).content
      : stripPdfLeadingScheduleColumns(withoutMeals);
    const contentLine = splitPdfTrailingMealMarker(rawContentLine).content;
    if (!contentLine || isPdfBareDateOrTimeLine(contentLine) || !hasPdfScheduleSignal(contentLine)) {
      clearPendingMeta();
      return;
    }
    const resolvedMeta = resolvePendingTimeForContent(meta, contentLine);
    const scheduleMeta = resolvedMeta.meta;

    const hotel = /^(?:♣?\s*)?HOTEL\s*[:：]/iu.test(contentLine) || /^(?:Hyatt|Holiday Inn|Radisson)\b/iu.test(contentLine)
      ? normalizePdfHotelLine(contentLine)
      : "";
    if (hotel) {
      clearPendingMetaAfterSchedule(resolvedMeta);
      pushUnique(currentDayNo, `- 숙박 | ${hotel}`);
      return;
    }

    if (pushSplitPdfScheduleItems(currentDayNo, contentLine, scheduleMeta)) {
      clearPendingMetaAfterSchedule(resolvedMeta);
      return;
    }

    const type = pdfScheduleItemType(contentLine);
    pushPdfScheduleItem(currentDayNo, type, contentLine, scheduleMeta);
    clearPendingMetaAfterSchedule(resolvedMeta);
  };

  if (flightSummaries.departure) output.push(`항공 출발: ${flightSummaries.departure}`);
  if (flightSummaries.arrival) output.push(`항공 귀국: ${flightSummaries.arrival}`);

  for (const rawLine of sourceLines) {
    const line = repairPdfBrokenWords(rawLine);
    if (!line) continue;
    const dayMatch = /^(?:제\s*)?0?(\d{1,2})\s*일차?\s*(.*)$/u.exec(line);
    if (dayMatch?.[1]) {
      pageInterludeStarted = false;
      clearPendingMeta();
      clearPendingMeal();
      currentDayNo = Number(dayMatch[1]);
      output.push(`*${currentDayNo}일차*`);
      const rest = dayMatch[2]?.trim();
      if (rest) processScheduleLine(rest);
      continue;
    }
    const pdfDate = currentDayNo > 0 ? parsePdfMonthDayDateLine(line) : null;
    if (pdfDate) {
      pushUnique(currentDayNo, pdfDate.date);
      const restWithColumns = stripPdfDatePrefixPreservingColumns(rawLine);
      if (restWithColumns) processScheduleLine(restWithColumns);
      continue;
    }
    if (/\.xlsx$/iu.test(line)) {
      pageInterludeStarted = true;
      continue;
    }
    if (pageInterludeStarted) continue;
    if (isPdfTrailerStartLine(line)) {
      trailerStarted = true;
      continue;
    }
    if (isPdfFooterOrContactLine(line) && !isPdfHotelContactLine(line)) continue;
    if (trailerStarted) continue;

    if (currentDayNo === 0) {
      if (!isPdfScheduleHeaderLine(line)) output.push(line);
      continue;
    }

    processScheduleLine(line);
  }

  return output.length > 0 ? output.join("\n") : stripPdfPageMarkers(text);
}

function isMeaningfulPdfText(text: string): boolean {
  const cleaned = stripPdfPageMarkers(text);
  const compact = cleaned.replace(/\s+/gu, "");
  if (compact.length >= PDF_TEXT_MIN_CHARS) return true;
  return compact.length >= 30 && /(?:견적|일정|호텔|출발|도착|조식|중식|석식|아침|점심|저녁|포함|불포함)/u.test(compact);
}

async function ensurePdfCanvasGlobals(): Promise<void> {
  const globalObject = globalThis as typeof globalThis & {
    DOMMatrix?: typeof DOMMatrix;
    ImageData?: typeof ImageData;
    Path2D?: typeof Path2D;
  };

  if (!globalObject.DOMMatrix || !globalObject.ImageData || !globalObject.Path2D) {
    let canvas: typeof import("@napi-rs/canvas");
    try {
      canvas = await import("@napi-rs/canvas");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new Error(`PDF 렌더링 환경 초기화에 실패했습니다. @napi-rs/canvas를 불러올 수 없습니다. (${message})`);
    }

    if (!globalObject.DOMMatrix && canvas.DOMMatrix) {
      globalObject.DOMMatrix = canvas.DOMMatrix as unknown as typeof DOMMatrix;
    }
    if (!globalObject.ImageData && canvas.ImageData) {
      globalObject.ImageData = canvas.ImageData as unknown as typeof ImageData;
    }
    if (!globalObject.Path2D && canvas.Path2D) {
      globalObject.Path2D = canvas.Path2D as unknown as typeof Path2D;
    }

    if (!globalObject.DOMMatrix || !globalObject.ImageData || !globalObject.Path2D) {
      throw new Error("PDF 렌더링 환경 초기화에 실패했습니다. PDF 처리에 필요한 canvas API를 사용할 수 없습니다.");
    }
  }
}

async function configurePdfWorker(PDFParse: typeof import("pdf-parse").PDFParse): Promise<void> {
  PDFParse.setWorker(await getPdfWorkerDataUrl());
}

function getPdfWorkerDataUrl(): Promise<string> {
  pdfWorkerDataUrlPromise ??= loadPdfWorkerDataUrl();
  return pdfWorkerDataUrlPromise;
}

async function loadPdfWorkerDataUrl(): Promise<string> {
  const errors: string[] = [];
  for (const workerPath of pdfWorkerPathCandidates()) {
    try {
      const workerSource = await readFile(workerPath);
      return `data:text/javascript;base64,${workerSource.toString("base64")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      errors.push(`${workerPath}: ${message}`);
    }
  }

  throw new Error(`PDF worker 초기화에 실패했습니다. pdf.worker.min.mjs를 data URL로 준비할 수 없습니다. (${errors.join("; ")})`);
}

function pdfWorkerPathCandidates(): string[] {
  return [path.join(process.cwd(), "node_modules", ...PDF_WORKER_PARTS)];
}

function extractOcrText(payload: OcrChatCompletionResponse): string {
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callPdfOcr(pageImages: string[]): Promise<string> {
  if (!config.ai.apiKey) {
    throw new Error("PDF에서 텍스트를 추출하지 못했습니다. 이미지형 PDF라 OCR이 필요하지만 AI API key가 없습니다.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.parseTimeoutMs);
  const content: OcrMessageContent[] = [
    {
      type: "text",
      text: [
        "이미지는 여행 견적서/PDF 일정표 페이지다.",
        "OCR로 보이는 모든 한글/영문/숫자 텍스트를 원문 순서대로 추출해라.",
        "표는 행 단위로 보존하고, 셀 구분이 보이면 | 로 구분해라.",
        "추측하지 말고 이미지에 보이는 텍스트만 출력해라.",
        "설명 없이 추출 텍스트만 출력해라.",
      ].join("\n"),
    },
    ...pageImages.map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
  ];

  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content,
          },
        ],
      }),
      signal: controller.signal,
    });

    const payload = (await response.json()) as OcrChatCompletionResponse;
    if (response.ok) {
      const text = extractOcrText(payload);
      if (text) return text;
      throw new Error("PDF OCR 결과가 비어 있습니다.");
    }

    throw new Error(`PDF OCR 호출 실패 (${response.status})`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`PDF OCR 시간이 ${config.ai.parseTimeoutMs}ms를 초과했습니다.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function imageExtension(file: File): string {
  return path.extname(file.name).toLowerCase();
}

function isItineraryImageFile(file: File): boolean {
  return ITINERARY_IMAGE_EXTENSIONS.has(imageExtension(file)) || ITINERARY_IMAGE_TYPES.has(file.type.toLowerCase());
}

interface PreparedImageForOcr {
  buffer: Buffer;
  mimeType: string;
}

async function prepareImageForOcr(file: File): Promise<PreparedImageForOcr> {
  const imageBuffer = Buffer.from(await file.arrayBuffer());
  const canvasModule = await import("@napi-rs/canvas");
  const sourceImage = await canvasModule.loadImage(imageBuffer);
  const maxDimension = Math.max(sourceImage.width, sourceImage.height);
  const scale = Math.min(1, IMAGE_OCR_MAX_DIMENSION / maxDimension);
  const width = Math.max(1, Math.round(sourceImage.width * scale));
  const height = Math.max(1, Math.round(sourceImage.height * scale));
  const canvas = canvasModule.createCanvas(width, height);
  const context = canvas.getContext("2d");

  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(sourceImage, 0, 0, width, height);

  return {
    buffer: canvas.toBuffer("image/jpeg", IMAGE_OCR_JPEG_QUALITY),
    mimeType: "image/jpeg",
  };
}

async function imageToDataUrl(file: File): Promise<string> {
  const { buffer, mimeType } = await prepareImageForOcr(file);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function callImageOcr(imageUrl: string): Promise<string> {
  if (!config.ai.apiKey) {
    throw new Error("이미지에서 텍스트를 추출하려면 AI API key가 필요합니다.");
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(config.ai.parseTimeoutMs, IMAGE_OCR_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const content: OcrMessageContent[] = [
    {
      type: "text",
      text: [
        "이미지는 여행 일정표 또는 여행 견적서의 일정표 영역이다.",
        "이미지 전체가 견적 답변 정보 화면이면 첫 줄에 [QUOTE_RESPONSE_SCREEN]을 출력한 뒤 보이는 텍스트를 원문 순서대로 추출해라.",
        "견적 답변 정보 화면은 최종합계, 환율기준, 항공 요금, 지상 요금, 공동 경비 요금, 대리점 공개 같은 구간이 함께 보이는 화면이다.",
        "OCR로 보이는 모든 한글/영문/숫자 텍스트를 원문 순서대로 추출해라.",
        "표는 행 단위로 보존하고, 셀 구분이 보이면 | 로 구분해라.",
        "일차, 날짜, 지역, 교통편, 시간, 일정, 식사, 숙박 텍스트를 누락하지 마라.",
        "일정표 이미지에서는 일정 구성에 필요한 텍스트를 우선하고, 회사 푸터/연락처/주의문/장식 문구는 생략해도 된다.",
        "견적답변, 금액표, 요금표만 있고 여행 일정이 보이지 않으면 보이는 텍스트만 출력하고 일정을 추정하지 마라.",
        "설명 없이 추출 텍스트만 출력해라.",
      ].join("\n"),
    },
    {
      type: "image_url",
      image_url: { url: imageUrl },
    },
  ];

  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0,
        max_tokens: 2500,
        messages: [
          {
            role: "user",
            content,
          },
        ],
      }),
      signal: controller.signal,
    });

    const payload = (await response.json()) as OcrChatCompletionResponse;
    if (response.ok) {
      const text = extractOcrText(payload);
      if (text) return text;
      throw new Error("이미지 OCR 결과가 비어 있습니다.");
    }

    throw new Error(`이미지 OCR 호출 실패 (${response.status})`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`이미지 OCR 시간이 ${timeoutMs}ms를 초과했습니다.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeQuoteResponseOcrText(text: string): boolean {
  const markerCount = QUOTE_RESPONSE_OCR_MARKERS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  const strongMarkerCount = STRONG_QUOTE_RESPONSE_OCR_MARKERS.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0,
  );
  return strongMarkerCount >= 2 || markerCount >= 4;
}

function looksLikeQuoteResponseImageName(fileName: string): boolean {
  return /견적\s*답변|quote[-_\s]*response/iu.test(fileName.normalize("NFC"));
}

async function imageToText(file: File): Promise<string> {
  if (!isItineraryImageFile(file)) {
    throw new Error("PNG, JPG, WEBP 이미지 파일만 OCR 처리할 수 있습니다.");
  }
  if (file.size <= 0) {
    throw new Error("OCR 처리할 이미지 파일이 비어 있습니다.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("이미지 파일은 10MB 이하만 OCR 처리할 수 있습니다.");
  }
  if (!config.ai.apiKey) {
    throw new Error("이미지에서 텍스트를 추출하려면 AI API key가 필요합니다.");
  }
  if (looksLikeQuoteResponseImageName(file.name)) {
    throw new Error("일정표 이미지가 아닙니다. 견적답변 이미지는 견적답변 불러오기에서 처리해 주세요.");
  }

  const text = await callImageOcr(await imageToDataUrl(file));
  if (looksLikeQuoteResponseOcrText(text)) {
    throw new Error("일정표 이미지가 아닙니다. 견적답변 이미지는 견적답변 불러오기에서 처리해 주세요.");
  }
  return text;
}

async function pdfToText(file: File): Promise<string> {
  await ensurePdfCanvasGlobals();
  const { PDFParse } = await import("pdf-parse");
  await configurePdfWorker(PDFParse);
  const arrayBuffer = await file.arrayBuffer();
  const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
  try {
    const result = await parser.getText();
    if (isMeaningfulPdfText(result.text)) return normalizePdfExtractedText(result.text);

    const screenshot = await parser.getScreenshot({
      desiredWidth: PDF_OCR_IMAGE_WIDTH,
      first: PDF_OCR_MAX_PAGES,
      imageBuffer: false,
      imageDataUrl: true,
    });
    const pageImages = screenshot.pages
      .map((page) => page.dataUrl)
      .filter(Boolean);
    if (pageImages.length === 0) return normalizePdfExtractedText(result.text);

    return normalizePdfExtractedText(await callPdfOcr(pageImages));
  } finally {
    await parser.destroy();
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'");
}

function hwpxXmlToText(xml: string): string {
  const textNodes = Array.from(xml.matchAll(/<[\w.-]+:t\b[^>]*>([\s\S]*?)<\/[\w.-]+:t>/giu), (match) =>
    decodeXmlEntities(match[1]?.replace(/<[^>]+>/gu, "") ?? "").trim(),
  ).filter(Boolean);

  if (textNodes.length > 0) return textNodes.join("\n");

  return decodeXmlEntities(xml.replace(/<[^>]+>/gu, "\n"))
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function docxToText(file: File): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("올바른 .docx 파일이 아닙니다. 파일이 손상되었거나 구형 .doc 형식일 수 있습니다.");
  }
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) throw new Error(".docx 파일 내부에서 문서 내용을 찾을 수 없습니다.");
  const xml = await documentXml.async("string");

  // OOXML: <w:p>는 단락, <w:t>는 실제 텍스트
  const paragraphs = Array.from(xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/giu));
  const lines = paragraphs
    .map((match) => {
      const inner = match[1] ?? "";
      const texts = Array.from(
        inner.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/giu),
        (m) => decodeXmlEntities(m[1] ?? ""),
      );
      return texts.join("").trim();
    })
    .filter(Boolean);

  return lines.join("\n");
}

async function hwpxToText(file: File): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("올바른 .hwpx 파일이 아닙니다. 파일이 손상되었거나 구형 .hwp 형식일 수 있습니다.");
  }
  const xmlFiles = Object.values(zip.files)
    .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".xml"))
    .sort((left, right) => left.name.localeCompare(right.name));

  const sections = await Promise.all(xmlFiles.map(async (entry) => hwpxXmlToText(await entry.async("string"))));
  return sections.filter(Boolean).join("\n");
}

function parseHwpSection(buf: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.readUInt32LE(offset);
    offset += 4;
    const tagId = header & 0x3ff;
    let size = (header >> 20) & 0xfff;
    if (size === 0xfff) {
      if (offset + 4 > buf.length) break;
      size = buf.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > buf.length) break;
    if (tagId === 67) {
      // PARA_TEXT(HWPTAG_BEGIN+51=0x43): UTF-16LE 텍스트, 제어 코드(< 0x20) 제외
      let text = "";
      for (let i = 0; i + 1 < size; i += 2) {
        const code = buf.readUInt16LE(offset + i);
        if (code === 0x0d || code === 0x2029) {
          if (text.trim()) lines.push(text.trim());
          text = "";
        } else if (code >= 0x20) {
          text += String.fromCharCode(code);
        }
      }
      if (text.trim()) lines.push(text.trim());
    }
    offset += size;
  }
  return lines.join("\n");
}

async function hwpToText(file: File): Promise<string> {
  const { inflateRawSync } = await import("zlib");
  const cfbMod = await import("cfb");
  // CJS 모듈 interop: webpack은 named exports를 직접 노출하거나 default 아래에 둠
  const cfbLib = ((cfbMod as unknown as { default?: typeof CfbType }).default ?? cfbMod) as typeof CfbType;

  const buf = Buffer.from(await file.arrayBuffer());
  let wb: CfbType.CFB$Container;
  try {
    wb = cfbLib.read(buf, { type: "buffer" });
  } catch {
    throw new Error("HWP 파일을 열 수 없습니다. 파일이 손상되었거나 HWP 3.x 이하 구형 형식일 수 있습니다.");
  }

  const headerEntry = cfbLib.find(wb, "FileHeader");
  if (!headerEntry?.content) throw new Error("HWP 파일 헤더를 읽을 수 없습니다.");
  const headerBuf = Buffer.from(headerEntry.content);
  if (headerBuf.length < 40) throw new Error("HWP 파일 헤더가 올바르지 않습니다.");
  const flags = headerBuf.readUInt32LE(36);
  const isCompressed = (flags & 0x01) !== 0;
  const isEncrypted = (flags & 0x02) !== 0;
  if (isEncrypted) throw new Error("암호화된 HWP 파일은 지원하지 않습니다. 암호를 제거한 뒤 업로드해 주세요.");

  const sectionEntries: CfbType.CFB$Entry[] = wb.FileIndex
    .filter((e) => e.type === 2 && /^Section\d+$/i.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.replace(/Section/i, ""), 10);
      const nb = parseInt(b.name.replace(/Section/i, ""), 10);
      return na - nb;
    });

  const texts: string[] = [];
  for (const entry of sectionEntries) {
    let data = Buffer.from(entry.content);
    if (isCompressed) data = inflateRawSync(data);
    const sectionText = parseHwpSection(data);
    if (sectionText) texts.push(sectionText);
  }
  return texts.join("\n");
}

async function extractRawText(
  formData: FormData,
): Promise<{ rawText: string; title?: string; isTextInput: boolean; preferDirectParser: boolean }> {
  const textInput = formData.get("text");
  const titleInput = formData.get("title");
  const fileInput = formData.get("file");

  const title = typeof titleInput === "string" ? titleInput.trim() : undefined;
  if (typeof textInput === "string" && textInput.trim()) {
    return { rawText: textInput, title, isTextInput: true, preferDirectParser: true };
  }

  if (!(fileInput instanceof File)) {
    throw new Error("텍스트 또는 파일이 필요합니다.");
  }

  const name = fileInput.name.toLowerCase();
  const fileTitle = fileInput.name.replace(/\.[^.]+$/u, "");

  if (name.endsWith(".xls") && !name.endsWith(".xlsx")) throw new Error(UNSUPPORTED_XLS_MESSAGE);
  if (name.endsWith(".hwp") && !name.endsWith(".hwpx")) {
    const rawText = await hwpToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: true };
  }

  if (name.endsWith(".xlsx")) {
    const rawText = await spreadsheetToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: false };
  }

  if (name.endsWith(".pdf")) {
    const rawText = await pdfToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: false };
  }

  if (isItineraryImageFile(fileInput)) {
    const rawText = await imageToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: false };
  }

  if (name.endsWith(".hwpx")) {
    const rawText = await hwpxToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: false };
  }

  if (name.endsWith(".docx")) {
    const rawText = await docxToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: false };
  }

  const rawText = await fileInput.text();
  return { rawText, title: title ?? fileTitle, isTextInput: false, preferDirectParser: false };
}

function isDebugRequest(req: NextRequest): boolean {
  const requestWithUrl = req as NextRequest & {
    nextUrl?: {
      searchParams?: URLSearchParams;
    };
  };
  return requestWithUrl.nextUrl?.searchParams?.get("debug") === "1";
}

function isProgressRequest(req: NextRequest): boolean {
  const requestWithUrl = req as NextRequest & {
    nextUrl?: {
      searchParams?: URLSearchParams;
    };
  };
  return requestWithUrl.nextUrl?.searchParams?.get("progress") === "1";
}

function toPublicParseResult(result: ItineraryParseResult, includeDebug: boolean): ItineraryParseResult {
  if (includeDebug) return result;
  const diagnostics = { ...result.diagnostics };
  delete diagnostics.candidateScores;
  return {
    itinerary: result.itinerary,
    diagnostics,
  };
}

type ParseProgressStage = "received" | "extracting" | "analyzing" | "completed" | "failed";

interface ParseProgressEvent {
  stage: ParseProgressStage;
  message: string;
  result?: ItineraryParseResult;
  error?: string;
}

function progressMessage(stage: ParseProgressStage): string {
  switch (stage) {
    case "received":
      return "요청을 확인하고 있습니다.";
    case "extracting":
      return "파일/입력 내용을 읽고 있습니다.";
    case "analyzing":
      return "일정 구조를 파악하고 있습니다.";
    case "completed":
      return "일정표로 정리하고 있습니다.";
    case "failed":
      return "일정을 불러오지 못했습니다.";
  }
}

function encodeProgressEvent(event: ParseProgressEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function streamParseProgress(req: NextRequest): Response {
  const includeDebug = isDebugRequest(req);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ParseProgressEvent) => {
        controller.enqueue(encodeProgressEvent(event));
      };

      try {
        send({ stage: "received", message: progressMessage("received") });
        const formData = await req.formData();
        send({ stage: "extracting", message: progressMessage("extracting") });
        const { rawText, title, isTextInput, preferDirectParser } = await extractRawText(formData);
        if (isTextInput || preferDirectParser) {
          const result = await parseDirectInputItineraryWithDiagnostics({ rawText, title });
          send({ stage: "completed", message: progressMessage("completed"), result: toPublicParseResult(result, includeDebug) });
          return;
        }
        send({ stage: "analyzing", message: progressMessage("analyzing") });
        const result = await parseItineraryWithDiagnostics({ rawText, title });
        send({
          stage: "completed",
          message: progressMessage("completed"),
          result: toPublicParseResult(result, includeDebug),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "파싱 중 오류가 발생했습니다.";
        send({
          stage: "failed",
          message: progressMessage("failed"),
          error: message,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(req: NextRequest) {
  const accessError = requireConverterAccess(req);
  if (accessError) return accessError;

  if (isProgressRequest(req)) {
    return streamParseProgress(req);
  }

  try {
    const formData = await req.formData();
    const { rawText, title, isTextInput, preferDirectParser } = await extractRawText(formData);
    if (isTextInput || preferDirectParser) {
      const result = await parseDirectInputItineraryWithDiagnostics({ rawText, title });
      const publicResult = toPublicParseResult(result, isDebugRequest(req));
      return NextResponse.json(publicResult, {
        headers: {
          "x-itinerary-parser-source": result.diagnostics.source,
          "x-itinerary-parser-score": String(result.diagnostics.qualityScore ?? ""),
        },
      });
    }
    const result = await parseItineraryWithDiagnostics({ rawText, title });
    const publicResult = toPublicParseResult(result, isDebugRequest(req));
    return NextResponse.json(publicResult, {
      headers: {
        "x-itinerary-parser-source": result.diagnostics.source,
        "x-itinerary-parser-score": String(result.diagnostics.qualityScore ?? ""),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파싱 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
