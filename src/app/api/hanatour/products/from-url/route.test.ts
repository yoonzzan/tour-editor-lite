import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers({ "x-access-code": "test-code" }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  process.env.ACCESS_CODE = "test-code";
  process.env.USE_MOCK_MCP = "false";
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("/api/hanatour/products/from-url", () => {
  it("rejects URLs without pkgCd", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ url: "https://www.hanatour.com/trp/pkg/CHPC0PKG0200M200" }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toContain("pkgCd");
  });

  it("returns mapped itinerary data from Hanatour gateway responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("getPkgProdInfo")) {
          return new Response(
            JSON.stringify({
              data: {
                saleProdCd: "PAP101260530JQ1",
                saleProdNm: "시드니 6일",
                depDay: "20260530",
                arrDay: "20260604",
                adtAmt: 193700,
                adtTotlAmt: 539000,
                chdAmt: 193700,
                chdTotlAmt: 539000,
                infAmt: 150000,
                infTotlAmt: 150000,
                trvlExpnInclList: [{ trvlExpnClstNm: "[교통]", trvlExpnDesc: "왕복항공권" }],
              },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              schdInfoList: [
                {
                  schdSeq: 1,
                  schdDay: 1,
                  strtDt: "20260530",
                  schdMainInfoList: [
                    { id: "transfer", schdCatgCd: "002", schdCatgNm: "도시간이동", depCityNm: "인천" },
                    { id: "meal", schdCatgCd: "004", schdCatgNm: "식사", dtlMealDvNm: "석식", mealTypeNm: "기내식" },
                    { id: "hotel", schdCatgCd: "099", schdCatgNm: "텍스트입력", memoTitlNm: "호텔로 이동" },
                  ],
                },
              ],
              pkgAirSeqList: [
                {
                  segSeq: "1",
                  airlNm: "젯스타",
                  flgtNm: "0048",
                  depAptNm: "인천 국제공항",
                  arrAptNm: "시드니 공항",
                  depHm: "2150",
                  arrHm: "0905",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }),
    );

    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        url: "https://www.hanatour.com/trp/pkg/CHPC0PKG0200M200?pkgCd=PAP101260530JQ1",
      }),
    );
    const payload = (await response.json()) as {
      code?: string;
      name?: string;
      itinerary?: {
        overview?: { fare?: { adultPerPerson?: number } };
        basics?: { included?: string; flight?: { departure?: string } };
        days?: Array<{ items: Array<{ content: string }> }>;
      };
      _meta?: { source?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.code).toBe("PAP101260530JQ1");
    expect(payload.name).toBe("시드니 6일");
    expect(payload._meta?.source).toBe("hanatour-url");
    expect(payload.itinerary?.overview?.fare?.adultPerPerson).toBe(539000);
    expect(payload.itinerary?.basics?.included).toContain("왕복항공권");
    expect(payload.itinerary?.basics?.flight?.departure).toContain("젯스타");
    expect(payload.itinerary?.days?.[0]?.items.map((item) => item.content)).toContain("호텔로 이동");
  });
});
