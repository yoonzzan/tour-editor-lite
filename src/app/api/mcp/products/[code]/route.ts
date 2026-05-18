// T-203: GET /api/mcp/products/[code] — MCP 연동 + Mock fallback
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import products from "@/mocks/products.json";
import type { ItineraryData } from "@/types";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { requireConverterAccess } from "@/lib/converter/access";
import {
  fetchSaleProductFromMcp,
  McpNotFoundError,
  McpResponseError,
} from "@/lib/mcp/saleProductClient";
import { mapMcpProductToItinerary } from "@/lib/mcp/mapSaleProductToItinerary";

interface ProductMock {
  code: string;
  name: string;
  itinerary: ItineraryData;
}

type ProductSource = "mock" | "mcp" | "mock-fallback";

interface ProductResponse {
  code: string;
  name: string;
  itinerary: ItineraryData;
  _meta: {
    source: ProductSource;
    requestedCode: string;
    matchedCode?: string;
    requestGuid?: string;
    useMockEnabled: boolean;
  };
}

function findMockProduct(code: string): ProductMock | undefined {
  return (products as ProductMock[]).find(
    (p) => p.code.toUpperCase() === code.toUpperCase()
  );
}

function withProductSource(
  source: ProductSource,
  mapped: { code: string; name: string; itinerary: ItineraryData },
  requestedCode: string,
  requestGuid?: string,
): ProductResponse {
  return {
    ...mapped,
    _meta: {
      source,
      requestedCode,
      matchedCode: mapped.code,
      requestGuid,
      useMockEnabled: config.mcp.useMock,
    },
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const accessError = requireConverterAccess(req);
  if (accessError) return accessError;

  const { code } = await params;
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    return NextResponse.json(
      { error: "상품코드를 입력해 주세요." },
      { status: 400 }
    );
  }
  const mockProduct = findMockProduct(normalizedCode);
  const requestGuid = randomUUID();
  const requestHeaders = { "x-request-guid": requestGuid };

  if (config.mcp.useMock && mockProduct) {
    const response = withProductSource(
      "mock",
      mapMcpProductToItinerary(mockProduct, normalizedCode),
      normalizedCode,
      requestGuid,
    );
    return NextResponse.json(response, {
      headers: {
        "x-product-source": "mock",
        ...requestHeaders,
      },
    });
  }

  try {
    const mcpPayload = await fetchSaleProductFromMcp(normalizedCode, requestGuid);
    const mapped = mapMcpProductToItinerary(mcpPayload, normalizedCode);
    return NextResponse.json(
      withProductSource("mcp", mapped, normalizedCode, requestGuid),
      {
        headers: {
          "x-product-source": "mcp",
          "x-request-guid": requestGuid,
        },
      },
    );
  } catch (error) {
    if (error instanceof McpNotFoundError) {
      const message = error.message.toLowerCase();
      if (
        message.includes("session")
        || message.includes("세션")
        || message.includes("연결")
        || message.includes("handlemessage")
      ) {
        return NextResponse.json(
          { error: `MCP 연동 실패: ${error.message}` },
          {
            status: 502,
            headers: requestHeaders,
          },
        );
      }

      if (mockProduct) {
        const response = withProductSource(
          "mock-fallback",
          mapMcpProductToItinerary(mockProduct, normalizedCode),
          normalizedCode,
          requestGuid,
        );
        return NextResponse.json(response, {
          headers: {
            "x-product-source": "mock-fallback",
            ...requestHeaders,
          },
        });
      }
      return NextResponse.json(
        { error: `상품코드 '${normalizedCode}'를 찾을 수 없습니다.` },
        {
          status: 404,
          headers: requestHeaders,
        }
      );
    }

    if (error instanceof McpResponseError) {
      return NextResponse.json(
        { error: `MCP 연동 실패: ${error.message}` },
        {
          status: error.status,
          headers: requestHeaders,
        }
      );
    }

    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `일정 조회 중 오류가 발생했습니다. (${message})` },
      { status: 502, headers: requestHeaders }
    );
  }
}
