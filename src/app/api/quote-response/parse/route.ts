import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireConverterAccess } from "@/lib/converter/access";
import {
  parseQuoteResponseText,
  type QuoteResponseDayDate,
} from "@/lib/quote/responseParser";
import { performQuoteResponseOcr } from "@/lib/quote/responseOcr";
import { normalizeQuoteResponseOcrText } from "@/lib/quote/responseTemplate";
import type { QuoteData } from "@/types";

export const runtime = "nodejs";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPassengerCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
  }
  return undefined;
}

function readDayDates(value: unknown): QuoteResponseDayDate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const dayNo = readPassengerCount(entry.dayNo);
    const date = readText(entry.date);
    if (!dayNo || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return [];
    return [{ dayNo, date }];
  });
}

function readQuoteHeader(value: unknown): QuoteData["header"] | undefined {
  if (!isRecord(value)) return undefined;
  const writtenAt = readText(value.writtenAt);
  const validUntil = readText(value.validUntil);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(writtenAt)) return undefined;
  return {
    writtenAt,
    validUntil: /^\d{4}-\d{2}-\d{2}$/u.test(validUntil) ? validUntil : writtenAt,
  };
}

function isFileLike(value: unknown): value is File {
  if (!isRecord(value)) return false;
  return (
    typeof value.arrayBuffer === "function" &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.size === "number"
  );
}

function parseJsonField(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function parseJsonRequest(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 422 });
  }

  const text = readText(body.text);
  if (!text) {
    return NextResponse.json({ error: "견적답변 텍스트를 입력해 주세요." }, { status: 422 });
  }

  const result = parseQuoteResponseText({
    text,
    dayDates: readDayDates(body.dayDates),
    passengerCount: readPassengerCount(body.passengerCount),
    quoteHeader: readQuoteHeader(body.quoteHeader),
  });

  return NextResponse.json(result);
}

async function parseMultipartRequest(req: NextRequest) {
  const formData = await req.formData();
  const image = formData.get("image");
  if (!isFileLike(image)) {
    return NextResponse.json({ error: "OCR 처리할 이미지 파일을 선택해 주세요." }, { status: 422 });
  }

  const ocr = await performQuoteResponseOcr(image);
  const normalized = normalizeQuoteResponseOcrText({
    text: ocr.extractedText,
    lines: ocr.lines,
  });
  const result = parseQuoteResponseText({
    text: normalized.normalizedText,
    dayDates: readDayDates(parseJsonField(formData.get("dayDates"))),
    passengerCount: readPassengerCount(formData.get("passengerCount")),
    quoteHeader: readQuoteHeader(parseJsonField(formData.get("quoteHeader"))),
  });

  return NextResponse.json({
    ...result,
    extractedText: normalized.normalizedText,
    ocrText: ocr.extractedText,
    ocrLines: ocr.lines,
    normalizedText: normalized.normalizedText,
    diagnostics: {
      ...result.diagnostics,
      source: "quote-response-ocr",
      warnings: [...normalized.warnings, ...result.diagnostics.warnings],
    },
  });
}

export async function POST(req: NextRequest) {
  const accessError = requireConverterAccess(req);
  if (accessError) return accessError;

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      return await parseMultipartRequest(req);
    }
    return await parseJsonRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "견적답변 파싱 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
