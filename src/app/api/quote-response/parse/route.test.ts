import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

function makeRequest(body: unknown, accessCode = "test-code"): NextRequest {
  return {
    json: async () => body,
    headers: new Headers({ "x-access-code": accessCode }),
  } as unknown as NextRequest;
}

function makeFormRequest(formData: FormData, accessCode = "test-code"): NextRequest {
  return {
    formData: async () => formData,
    headers: new Headers({
      "content-type": "multipart/form-data; boundary=test",
      "x-access-code": accessCode,
    }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/quote/responseOcr");
  vi.stubEnv("ACCESS_CODE", "test-code");
  vi.resetModules();
});

describe("/api/quote-response/parse", () => {
  it("rejects invalid access codes", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ text: "항공료 10,000 합계 10,000" }, "wrong"));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toContain("접근코드");
  });

  it("rejects empty text", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ text: " " }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(422);
    expect(payload.error).toContain("텍스트");
  });

  it("returns parsed quote data", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest({
      text: "항공료 830,000 TAX 125,000 합계 955,000\n1인당 예상수익 132,000",
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    }));
    const payload = (await response.json()) as {
      quote?: {
        items?: Array<{ category: string; description: string; unitPrice: number }>;
        summary?: { agencyFee: number; total: number };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.quote?.items?.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["FLIGHT", "항공료", 830000],
      ["FLIGHT", "TAX", 125000],
      ["OTHER", "1인당 예상수익", 132000],
    ]);
    expect(payload.quote?.summary?.agencyFee).toBe(0);
    expect(payload.quote?.summary?.total).toBe(1087000);
  });

  it("runs OCR for multipart image requests and parses normalized text", async () => {
    vi.doMock("@/lib/quote/responseOcr", () => ({
      performQuoteResponseOcr: vi.fn(async () => ({
        extractedText: "항공 요금 955,000원 항공료 830,000 TAX 125,000 합계 955,000\n[식사] 2일차 중식 현지식$10 / 석식 한식$10",
        lines: [
          { text: "항공 요금 955,000원 항공료 830,000 TAX 125,000 합계 955,000" },
          { text: "[식사] 2일차 중식 현지식$10 / 석식 한식$10" },
        ],
      })),
    }));
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("image", new File(["fake"], "quote.png", { type: "image/png" }));
    formData.append("passengerCount", "28");
    formData.append("dayDates", JSON.stringify([{ dayNo: 2, date: "2026-02-07" }]));
    formData.append("quoteHeader", JSON.stringify({ writtenAt: "2026-05-19", validUntil: "2026-05-19" }));

    const response = await POST(makeFormRequest(formData));
    const payload = (await response.json()) as {
      extractedText?: string;
      diagnostics?: { source?: string };
      quote?: {
        items?: Array<{ category: string; date: string; quantity: number; unitPrice: number }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.diagnostics?.source).toBe("quote-response-ocr");
    expect(payload.extractedText).toContain("항공 요금");
    expect(payload.quote?.items?.some((item) => item.category === "FLIGHT" && item.unitPrice === 830000)).toBe(true);
    expect(payload.quote?.items?.some((item) => item.category === "FLIGHT" && item.unitPrice === 125000)).toBe(true);
    expect(payload.quote?.items?.some((item) => item.category === "MEAL" && item.date === "2026-02-07" && item.quantity === 28)).toBe(true);
  });

  it("rejects multipart requests without an image file", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeFormRequest(new FormData()));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(422);
    expect(payload.error).toContain("이미지");
  });
});
