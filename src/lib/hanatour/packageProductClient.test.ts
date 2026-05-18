import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("packageProductClient", () => {
  it("extracts pkgCd from Hanatour package URLs", async () => {
    const { extractPkgCodeFromHanatourUrl } = await import("./packageProductClient");

    expect(
      extractPkgCodeFromHanatourUrl(
        "https://www.hanatour.com/trp/pkg/CHPC0PKG0200M200?pkgCd=PAP101260530JQ1&prePage=major-products",
      ),
    ).toBe("PAP101260530JQ1");
    expect(
      extractPkgCodeFromHanatourUrl(
        "https://m.hanatour.com/trp/pkg/CHPC0PKG0200M100?pkgCd=EWP172260601TWF&prePage=major-products",
      ),
    ).toBe("EWP172260601TWF");
  });

  it("rejects non-Hanatour URLs", async () => {
    const { extractPkgCodeFromHanatourUrl } = await import("./packageProductClient");

    expect(() => {
      extractPkgCodeFromHanatourUrl("https://example.com/trp/pkg/CHPC0PKG0200M200?pkgCd=PAP101260530JQ1");
    }).toThrow("하나투어 상품 URL만 입력할 수 있습니다.");
  });

  it("fetches product and itinerary gateway data and combines them for the mapper", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getPkgProdInfo")) {
        return new Response(
          JSON.stringify({
            data: {
              saleProdCd: "PAP101260530JQ1",
              saleProdNm: "시드니 6일",
              depDay: "20260530",
              arrDay: "20260604",
              adtAmt: 1399000,
              chdAmt: 1399000,
              infAmt: 139900,
              shpnCntrVistCnt: 3,
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
                  { schdCatgCd: "002", schdCatgNm: "도시간이동", depCityNm: "인천" },
                  { schdCatgCd: "004", schdCatgNm: "식사", dtlMealDvNm: "석식", mealTypeNm: "기내식" },
                  { schdCatgCd: "099", schdCatgNm: "텍스트입력", memoTitlNm: "호텔로 이동" },
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchHanatourProductFromUrl } = await import("./packageProductClient");
    const result = await fetchHanatourProductFromUrl(
      "https://www.hanatour.com/trp/pkg/CHPC0PKG0200M200?pkgCd=PAP101260530JQ1",
      "test-guid",
    );

    expect(result.productCode).toBe("PAP101260530JQ1");
    expect(result.payload.baseProductInfo).toMatchObject({
      saleProdNm: "시드니 6일",
      adtAmt: 1399000,
    });
    expect(result.payload.itineraryInfo).toMatchObject({
      pkgAirSeqList: expect.arrayContaining([expect.objectContaining({ airlNm: "젯스타" })]),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
