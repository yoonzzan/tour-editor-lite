import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireConverterAccess } from "@/lib/converter/access";
import {
  fetchHanatourProductFromUrl,
  HanatourGatewayError,
  HanatourUrlError,
} from "@/lib/hanatour/packageProductClient";
import { mapMcpProductToItinerary } from "@/lib/mcp/mapSaleProductToItinerary";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestUrl(req: NextRequest): Promise<string> {
  const body = (await req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || typeof body.url !== "string") return "";
  return body.url;
}

export async function POST(req: NextRequest) {
  const accessError = requireConverterAccess(req);
  if (accessError) return accessError;

  const requestGuid = randomUUID();
  const requestHeaders = { "x-request-guid": requestGuid };

  try {
    const rawUrl = await readRequestUrl(req);
    const product = await fetchHanatourProductFromUrl(rawUrl, requestGuid);
    const mapped = mapMcpProductToItinerary(product.payload, product.productCode);

    return NextResponse.json(
      {
        ...mapped,
        _meta: {
          source: "hanatour-url",
          requestedUrl: rawUrl,
          requestedCode: product.productCode,
          matchedCode: mapped.code,
          requestGuid,
          useMockEnabled: false,
        },
      },
      {
        headers: {
          "x-product-source": "hanatour-url",
          ...requestHeaders,
        },
      },
    );
  } catch (error) {
    if (error instanceof HanatourUrlError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: requestHeaders });
    }

    if (error instanceof HanatourGatewayError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: requestHeaders });
    }

    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `하나투어 URL 조회 중 오류가 발생했습니다. (${message})` },
      { status: 502, headers: requestHeaders },
    );
  }
}
