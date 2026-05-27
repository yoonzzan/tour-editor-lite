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
const PDF_WORKER_PARTS = ["pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"];
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

function extractPdfMeals(line: string): Array<{ slot: "breakfast" | "lunch" | "dinner"; text: string }> {
  const meals: Array<{ slot: "breakfast" | "lunch" | "dinner"; text: string }> = [];
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
  return meals;
}

function removePdfMealFragments(line: string): string {
  return repairPdfBrokenWords(line)
    .replace(/(?:^|\s)[조중석]\s*[:：]\s*[\s\S]*?(?=\s+[조중석]\s*[:：]|$)/gu, " ")
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

interface PdfScheduleContext {
  origin: string;
  destination: string;
  region: string;
  transport: string;
  time: string;
  pendingArrivalTime: string;
}

interface PdfScheduleMeta {
  region: string;
  transport: string;
  time: string;
  contentHint: string;
  contextOnly: boolean;
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
    .split(/\t+/u)
    .map((part) => repairPdfBrokenWords(part))
    .map((part) => part.replace(/^[▶□■└n•·\-→|\s]+/u, "").trim())
    .filter(Boolean);
}

function parsePdfScheduleMeta(rawLine: string, context: PdfScheduleContext): PdfScheduleMeta {
  const columns = splitPdfColumns(rawLine);
  const meta: PdfScheduleMeta = {
    region: "",
    transport: "",
    time: "",
    contentHint: "",
    contextOnly: false,
  };

  if (columns.length === 0) return meta;

  const rawClean = repairPdfBrokenWords(rawLine);
  const flightEvent = /\b((?:OZ|KE|TW|AY|VY)\s?\d{2,4})\b[\s\S]*?(\d{1,2}[:;]\d{2}(?:\(\+1\))?)[\s\S]*?([\p{L}]+)\s*(출발|도착)/iu.exec(rawClean);
  if (flightEvent?.[1] && flightEvent[2] && flightEvent[3] && flightEvent[4]) {
    const transport = flightEvent[1].replace(/\s+/gu, "");
    const time = normalizePdfTimeToken(flightEvent[2]);
    const region = cleanPdfLine(flightEvent[3]);
    context.transport = transport;
    context.time = time;
    context.region = region;
    meta.region = region;
    meta.transport = transport;
    meta.time = time;
    meta.contentHint = `${region} ${flightEvent[4]}`;
    return meta;
  }

  const normalizedLine = normalizePdfScheduleLine(rawLine);
  const leadingTime = extractPdfTimeToken(rawLine);
  if (columns.length === 1) {
    const only = columns[0] ?? "";
    if (isPdfTransportToken(only)) {
      context.transport = only;
      meta.contextOnly = true;
      return meta;
    }
    if (extractPdfTimeToken(only) && cleanPdfLine(only) === extractPdfTimeToken(only)) {
      context.time = extractPdfTimeToken(only);
      meta.contextOnly = true;
      return meta;
    }
  }

  const first = columns[0] ?? "";
  const second = columns[1] ?? "";
  const third = columns[2] ?? "";
  if (columns.length === 2 && isPdfLocationToken(first) && isPdfLocationToken(second)) {
    context.origin = first;
    context.destination = second;
    context.region = second;
    meta.contextOnly = true;
    return meta;
  }

  const timeColumnIndex = columns.findIndex((column) => Boolean(extractPdfTimeToken(column)));
  const transportColumn =
    columns.find((column) => isPdfTransportToken(column) && column !== "-") ??
    columns.find((column) => isPdfTransportToken(column)) ??
    "";
  if (isPdfLocationToken(first) && isPdfLocationToken(second)) {
    context.origin = first;
    context.destination = second;
    context.region = second;
  }
  if (transportColumn) context.transport = transportColumn;
  if (timeColumnIndex >= 0) context.time = extractPdfTimeToken(columns[timeColumnIndex] ?? "");
  if (timeColumnIndex >= 0) {
    const timeColumn = columns[timeColumnIndex] ?? "";
    const time = extractPdfTimeToken(timeColumn);
    const sameColumnContent = cleanPdfLine(timeColumn.replace(time, ""));
    const tailContent = columns.slice(timeColumnIndex + 1).join(" ");
    meta.contentHint = cleanPdfLine([sameColumnContent, tailContent].filter(Boolean).join(" "));
  }

  const lineWithoutTime = normalizedLine.replace(/\b\d{1,2}[:;]\d{2}(?:\(\+1\))?\b/gu, " ").replace(/\s{2,}/gu, " ").trim();
  const hasContentSignal = hasPdfScheduleSignal(lineWithoutTime);
  const structuralOnly = columns.every((column) =>
    isPdfLocationToken(column) || isPdfTransportToken(column) || cleanPdfLine(column) === extractPdfTimeToken(column)
  );
  meta.contextOnly = !hasContentSignal || structuralOnly;

  const contentRegion = (() => {
    if (context.origin && normalizedLine.includes(context.origin) && /출발/u.test(normalizedLine)) return context.origin;
    if (context.destination && normalizedLine.includes(context.destination) && /도착/u.test(normalizedLine)) return context.destination;
    if (context.destination && /이동/u.test(normalizedLine)) return context.destination;
    if (isPdfLocationToken(first) && !isPdfTransportToken(second) && timeColumnIndex > 0) return first;
    return context.region;
  })();

  const time = (() => {
    if (/출발/u.test(normalizedLine) && context.time) return context.time;
    if (/도착/u.test(normalizedLine) && context.pendingArrivalTime) return context.pendingArrivalTime;
    return leadingTime || context.time;
  })();

  if (/출발/u.test(normalizedLine) && leadingTime && context.time && leadingTime !== context.time) {
    context.pendingArrivalTime = leadingTime;
  } else if (/도착/u.test(normalizedLine) && context.pendingArrivalTime) {
    context.pendingArrivalTime = "";
  }

  meta.region = contentRegion;
  meta.transport = transportColumn || context.transport;
  meta.time = time;

  if (!meta.region && isPdfLocationToken(first) && !isPdfTransportToken(second)) meta.region = first;
  if (!meta.transport && isPdfTransportToken(third)) meta.transport = third;
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
  const pdfContext: PdfScheduleContext = {
    origin: "",
    destination: "",
    region: "",
    transport: "",
    time: "",
    pendingArrivalTime: "",
  };
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
    const metaSegments = [
      (inferPdfRegionFromContent(value) || meta.region) ? `지역=${inferPdfRegionFromContent(value) || meta.region}` : "",
      (meta.transport || /전용차량/u.test(value)) ? `교통편=${meta.transport || "전용차량"}` : "",
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
    const meta = parsePdfScheduleMeta(rawLine, pdfContext);
    const line = normalizePdfScheduleLine(rawLine);
    if (isPdfHotelContactLine(line)) {
      const hotel = normalizePdfHotelLine(line);
      if (hotel) pushUnique(currentDayNo, `- 숙박 | ${hotel}`);
      return;
    }
    if (!line || (isPdfFooterOrContactLine(line) && !isPdfHotelContactLine(line)) || isPdfScheduleHeaderLine(line) || isPdfBareDateOrTimeLine(line)) return;

    const meals = extractPdfMeals(line);
    for (const meal of meals) {
      pushUnique(currentDayNo, `- 식사 | ${pdfMealSlotLabel(meal.slot)}: ${meal.text}`);
    }
    if (meta.contextOnly) return;

    const withoutMeals = removePdfMealFragments(line)
      .replace(/^\(?\d{1,2}[./]\d{1,2}\.?\)?\s*/u, "")
      .replace(/^\([월화수목금토일]\)\s*/u, "")
      .trim();
    const contentLine = meta.contentHint && hasPdfScheduleSignal(meta.contentHint)
      ? meta.contentHint
      : stripPdfLeadingScheduleColumns(withoutMeals);
    if (!contentLine || isPdfBareDateOrTimeLine(contentLine) || !hasPdfScheduleSignal(contentLine)) return;

    const hotel = /^(?:♣?\s*)?HOTEL\s*[:：]/iu.test(contentLine) || /^(?:Hyatt|Holiday Inn|Radisson)\b/iu.test(contentLine)
      ? normalizePdfHotelLine(contentLine)
      : "";
    if (hotel) {
      pushUnique(currentDayNo, `- 숙박 | ${hotel}`);
      return;
    }

    if (pushSplitPdfScheduleItems(currentDayNo, contentLine, meta)) return;

    const type = pdfScheduleItemType(contentLine);
    pushPdfScheduleItem(currentDayNo, type, contentLine, meta);
  };

  if (flightSummaries.departure) output.push(`항공 출발: ${flightSummaries.departure}`);
  if (flightSummaries.arrival) output.push(`항공 귀국: ${flightSummaries.arrival}`);

  for (const rawLine of sourceLines) {
    const line = repairPdfBrokenWords(rawLine);
    if (!line) continue;
    const dayMatch = /^(?:제\s*)?0?(\d{1,2})\s*일차?\s*(.*)$/u.exec(line);
    if (dayMatch?.[1]) {
      pageInterludeStarted = false;
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

async function extractRawText(formData: FormData): Promise<{ rawText: string; title?: string; isTextInput: boolean }> {
  const textInput = formData.get("text");
  const titleInput = formData.get("title");
  const fileInput = formData.get("file");

  const title = typeof titleInput === "string" ? titleInput.trim() : undefined;
  if (typeof textInput === "string" && textInput.trim()) {
    return { rawText: textInput, title, isTextInput: true };
  }

  if (!(fileInput instanceof File)) {
    throw new Error("텍스트 또는 파일이 필요합니다.");
  }

  const name = fileInput.name.toLowerCase();
  const fileTitle = fileInput.name.replace(/\.[^.]+$/u, "");

  if (name.endsWith(".xls") && !name.endsWith(".xlsx")) throw new Error(UNSUPPORTED_XLS_MESSAGE);
  if (name.endsWith(".hwp") && !name.endsWith(".hwpx")) {
    const rawText = await hwpToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false };
  }

  if (name.endsWith(".xlsx")) {
    const rawText = await spreadsheetToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false };
  }

  if (name.endsWith(".pdf")) {
    const rawText = await pdfToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false };
  }

  if (name.endsWith(".hwpx")) {
    const rawText = await hwpxToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false };
  }

  if (name.endsWith(".docx")) {
    const rawText = await docxToText(fileInput);
    return { rawText, title: title ?? fileTitle, isTextInput: false };
  }

  const rawText = await fileInput.text();
  return { rawText, title: title ?? fileTitle, isTextInput: false };
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
        const { rawText, title, isTextInput } = await extractRawText(formData);
        if (isTextInput) {
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
    const { rawText, title, isTextInput } = await extractRawText(formData);
    if (isTextInput) {
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
