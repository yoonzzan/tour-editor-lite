import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type ExcelJS from "exceljs";
import {
  getRequestAccessCode,
  isValidAccessCode,
} from "@/lib/converter/access";
import { generateCostWorkbook } from "@/lib/excel/generateCostSheet";
import { generateItineraryWorkbook } from "@/lib/excel/generateItinerary";
import { generateExcelFilename } from "@/lib/excel/filename";
import type { ItineraryData, QuoteData } from "@/types";

type ExportType = "itinerary" | "cost";

interface ExportPayload {
  itineraryData?: unknown;
  quoteData?: unknown;
}

interface ParsedExportRequest {
  payload: ExportPayload | null;
  accessCode: string | null;
}

function parseExportType(value: string | null): ExportType | null {
  if (value === "itinerary" || value === "cost") return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readProductName(payload: ExportPayload): string {
  if (!isRecord(payload.itineraryData)) return "여행견적";
  const header = payload.itineraryData.header;
  if (!isRecord(header)) return "여행견적";
  return typeof header.groupName === "string" && header.groupName.trim()
    ? header.groupName
    : "여행견적";
}

function parsePayloadValue(value: unknown): ExportPayload | null {
  return isRecord(value) ? value : null;
}

async function parseExportRequest(
  req: NextRequest
): Promise<ParsedExportRequest> {
  const contentType = req.headers.get("content-type") ?? "";

  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const formData = await req.formData();
    const rawPayload = formData.get("payload");
    const accessCode = formData.get("accessCode");

    if (typeof rawPayload !== "string") {
      return {
        payload: null,
        accessCode: typeof accessCode === "string" ? accessCode : null,
      };
    }

    try {
      return {
        payload: parsePayloadValue(JSON.parse(rawPayload)),
        accessCode: typeof accessCode === "string" ? accessCode : null,
      };
    } catch {
      return {
        payload: null,
        accessCode: typeof accessCode === "string" ? accessCode : null,
      };
    }
  }

  try {
    const body = await req.json();
    return {
      payload: parsePayloadValue(body),
      accessCode: getRequestAccessCode(req),
    };
  } catch {
    return {
      payload: null,
      accessCode: getRequestAccessCode(req),
    };
  }
}

function createExcelResponse(
  buffer: ExcelJS.Buffer,
  type: ExportType,
  productName: string
) {
  const filename = generateExcelFilename({
    quoteCode: "LOCAL",
    bidCode: "CONVERTER",
    productName,
    type,
  });
  const encodedFilename = encodeURIComponent(filename);

  return new NextResponse(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedFilename}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(req: NextRequest) {
  const parsed = await parseExportRequest(req);
  if (!isValidAccessCode(parsed.accessCode)) {
    return NextResponse.json(
      { error: "접근코드가 올바르지 않습니다." },
      { status: 401 }
    );
  }

  const type = parseExportType(req.nextUrl.searchParams.get("type"));
  if (!type) {
    return NextResponse.json(
      { error: "type 파라미터는 'itinerary' 또는 'cost' 이어야 합니다." },
      { status: 400 }
    );
  }

  const payload = parsed.payload;
  if (!payload) {
    return NextResponse.json(
      { error: "잘못된 요청 형식입니다." },
      { status: 400 }
    );
  }

  const productName = readProductName(payload);
  try {
    if (type === "itinerary") {
      if (!payload.itineraryData) {
        return NextResponse.json(
          { error: "itineraryData가 필요합니다." },
          { status: 400 }
        );
      }
      const buffer = await generateItineraryWorkbook(
        payload.itineraryData as ItineraryData,
        {
          productName,
          bidCode: "CONVERTER",
        }
      );
      return createExcelResponse(buffer, type, productName);
    }

    if (!payload.quoteData) {
      return NextResponse.json(
        { error: "quoteData가 필요합니다." },
        { status: 400 }
      );
    }
    const buffer = await generateCostWorkbook(payload.quoteData as QuoteData, {
      productName,
      bidCode: "CONVERTER",
    });
    return createExcelResponse(buffer, type, productName);
  } catch {
    return NextResponse.json(
      { error: "Excel 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
