import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ExcelJS from "exceljs";
import JSZip from "jszip";
import type * as CfbType from "cfb";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { requireConverterAccess } from "@/lib/converter/access";
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
  if (/(?:관광|탐방|방문|견학|산책|관람|공원|수족관|성|광장|대성당|박물관|쇼|수도원|운하|폭포|연못|라벤더|국립공원|사옥|생산공장|본사|캠퍼스|자유일정|쇼핑)/u.test(line)) {
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

function stripPdfLeadingScheduleColumns(line: string): string {
  const parts = line.split("|").map((part) => repairPdfBrokenWords(part)).filter(Boolean);
  if (parts.length < 2) return line;

  const tail = parts[parts.length - 1];
  const head = parts.slice(0, -1);
  if (tail && hasPdfScheduleSignal(tail) && head.every(isPdfStructuralScheduleColumn)) {
    return tail;
  }

  return line;
}

function normalizePdfExtractedText(text: string): string {
  const sourceLines = stripPdfPageMarkers(text)
    .split("\n")
    .map(cleanPdfLine)
    .filter(Boolean);
  const output: string[] = [];
  const seenByDay = new Map<number, Set<string>>();
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

  const processScheduleLine = (rawLine: string): void => {
    if (currentDayNo <= 0) return;
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

    const withoutMeals = removePdfMealFragments(line)
      .replace(/^\(?\d{1,2}[./]\d{1,2}\.?\)?\s*/u, "")
      .replace(/^\([월화수목금토일]\)\s*/u, "")
      .trim();
    const contentLine = stripPdfLeadingScheduleColumns(withoutMeals);
    if (!contentLine || isPdfBareDateOrTimeLine(contentLine) || !hasPdfScheduleSignal(contentLine)) return;

    const hotel = /^(?:♣?\s*)?HOTEL\s*[:：]/iu.test(contentLine) || /^(?:Hyatt|Holiday Inn|Radisson)\b/iu.test(contentLine)
      ? normalizePdfHotelLine(contentLine)
      : "";
    if (hotel) {
      pushUnique(currentDayNo, `- 숙박 | ${hotel}`);
      return;
    }

    const type = pdfScheduleItemType(contentLine);
    pushUnique(currentDayNo, `- ${type} | ${contentLine}`);
  };

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
