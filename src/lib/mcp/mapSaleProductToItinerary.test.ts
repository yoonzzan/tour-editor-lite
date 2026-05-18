import { describe, expect, it } from "vitest";
import { mapMcpProductToItinerary } from "@/lib/mcp/mapSaleProductToItinerary";

describe("mapMcpProductToItinerary", () => {
  it("filters non-schedule MCP cards and deduplicates repeated attraction cards", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "테스트 상품",
          depDay: "2026-06-02",
          arrDay: "2026-06-06",
          shpnCntrVistCnt: 1,
          depFlgtCd: "BX0719",
          arrFlgtCd: "BX0710",
          trvlExpnInclList: [
            { trvlExpnClstNm: "[교통]", trvlExpnDesc: "왕복항공권" },
            { trvlExpnClstNm: "[제세금]", trvlExpnDesc: "유류할증료" },
            { trvlExpnClstNm: "[여행자보험]", trvlExpnDesc: "3억원 여행자보험" },
          ],
          trvlExpnNoneInclList: [
            { trvlExpnClstNm: "[가이드/기사]", trvlExpnDesc: "가이드/기사 경비 : 인당 USD 40" },
          ],
          trvlChcExpnList: [
            { trvlExpnClstNm: "[교통]", trvlExpnDesc: "항공리턴변경(문의)" },
          ],
          pkgAirSeqList: [
            {
              segSeq: "1",
              airlCd: "BX",
              airlNm: "에어부산",
              flgtNm: "0719",
              depAptNm: "김해 국제공항",
              arrAptNm: "칼리보 국제공항",
              depHm: "2205",
              arrHm: "0130",
            },
            {
              segSeq: "2",
              airlCd: "BX",
              airlNm: "에어부산",
              flgtNm: "0710",
              depAptNm: "칼리보 국제공항",
              arrAptNm: "김해 국제공항",
              depHm: "0230",
              arrHm: "0730",
            },
          ],
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              strtDt: "2026-06-02",
              schdMainInfoList: [
                {
                  id: "generic-transfer",
                  schdCatgCd: "002",
                  schdCatgNm: "도시간이동",
                  memoTitlNm: "도시간이동",
                  schdRqrmTm: "00",
                  schdRqrmHm: "00",
                },
                {
                  id: "ueno-long",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  memoTitlNm: "우에노",
                  memoCont:
                    "우에노상세보기 일본의 예술과 전통의 모습을 우에노(上野)에서 이전다음 우에노 공원 설명",
                },
                {
                  id: "meeting",
                  schdCatgCd: "099",
                  schdCatgNm: "텍스트입력",
                  memoTitlNm: "인천출발 - 인천 공항 가이드 미팅 출국 3시간 전 인천공항 미팅 예정",
                },
                {
                  id: "ueno-short",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  memoTitlNm: "우에노",
                  memoCont: "우에노상세보기 일본의 예술과 전통의 모습을 우에노(上野)에서",
                },
                {
                  id: "notice",
                  schdCatgCd: "099",
                  schdCatgNm: "기타",
                  memoTitlNm: "쇼핑안내",
                  memoCont: "1회의 쇼핑이 포함된 상품입니다.",
                },
                {
                  id: "test-card",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  memoTitlNm: "묶음카드명 ttttttt",
                  memoCont: "2개의 카드매니저 등록되어 있음",
                },
                {
                  id: "card-html",
                  schdCatgCd: "001",
                  schdCatgNm: "관광지",
                  cardNm: "보라카이 리조트 소개",
                  cardCntntPc: "상세보기 이전다음 호텔소개 아주 긴 HTML 설명",
                },
                {
                  id: "untitled-card",
                  schdCatgCd: "001",
                  schdCatgNm: "관광지",
                  cmsCardId: "20180220000024",
                  cardCntntPc: "상세보기 이전다음 카드 본문만 있는 항목",
                },
                {
                  id: "meal",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "조식",
                  memoTitlNm: "식사",
                },
                {
                  id: "placeholder",
                  schdCatgCd: "099",
                  schdCatgNm: "기타",
                  memoTitlNm: "일정",
                },
              ],
            },
          ],
        },
        scheduleAndTouristSpotInfo: {
          optiontourRemarksInfo: {
            remarkData: "선택관광은 상품가격에 불포함 입니다.",
          },
          chcInfoList: [
            { chcStsngNm: "[FreePack전용] 라바스톤 마사지" },
          ],
        },
      },
      "AVP999261231VNE",
    );

    const items = result.itinerary.days[0]?.items ?? [];
    const contents = items.map((item) => item.content);

    expect(contents.filter((content) => content.includes("우에노"))).toHaveLength(1);
    expect(contents.join("\n")).not.toContain("도시간이동");
    expect(contents.join("\n")).not.toContain("쇼핑안내");
    expect(contents.join("\n")).not.toContain("묶음카드");
    expect(contents.join("\n")).not.toContain("카드매니저");
    expect(contents.join("\n")).not.toContain("상세보기");
    expect(contents.join("\n")).not.toContain("이전다음");
    expect(contents.join("\n")).not.toContain("아주 긴 HTML 설명");
    expect(contents.join("\n")).not.toContain("카드 본문만 있는 항목");
    expect(contents).toContain("보라카이 리조트 소개");
    expect(items.find((item) => item.id === "meeting")).toMatchObject({
      content: "인천출발",
      detail: "인천 공항 가이드 미팅 출국 3시간 전 인천공항 미팅 예정",
    });
    expect(items.find((item) => item.type === "MEAL")?.meal?.breakfast).toBe("예약");
    expect(items.every((item) => item.time !== "00")).toBe(true);
    expect(result.itinerary.basics.flight.departure).toBe(
      "에어부산 BX0719 / 김해 국제공항 → 칼리보 국제공항 / 22:05 → 01:30",
    );
    expect(result.itinerary.basics.flight.arrival).toBe(
      "에어부산 BX0710 / 칼리보 국제공항 → 김해 국제공항 / 02:30 → 07:30",
    );
    expect(result.itinerary.basics.included).toContain("왕복항공권");
    expect(result.itinerary.basics.included).toContain("유류할증료");
    expect(result.itinerary.basics.included).toContain("3억원 여행자보험");
    expect(result.itinerary.basics.included).not.toContain("[교통]");
    expect(result.itinerary.basics.included).not.toContain("[제세금]");
    expect(result.itinerary.basics.included).not.toContain("[여행자보험]");
    expect(result.itinerary.basics.excluded).toContain("가이드/기사 경비");
    expect(result.itinerary.basics.excluded).not.toContain("[가이드/기사]");
    expect(result.itinerary.basics.optionalTour).toContain("라바스톤 마사지");
    expect(result.itinerary.basics.notes).toContain("선택관광은 상품가격에 불포함");
  });

  it("formats Hanatour flight numbers with airline codes", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "유럽 항공 테스트",
          depDay: "2026-06-01",
          arrDay: "2026-06-09",
          airInvInfo: {
            splyInfoId: "TW0403ICNFRA-H15",
            patrId: "TW0403ICNFRA-22",
          },
        },
        itineraryInfo: {
          pkgAirSeqList: [
            {
              segSeq: "1",
              airlCd: "TW",
              airlNm: "티웨이항공",
              flgtNm: "0403",
              depHm: "0950",
              arrHm: "1650",
              depAptNm: "인천 국제공항",
              arrAptNm: "프랑크푸르트 암마인 공항",
            },
            {
              segSeq: "2",
              airlCd: "TW",
              airlNm: "티웨이항공",
              flgtNm: "0404",
              depHm: "1850",
              arrHm: "1400",
              depAptNm: "프랑크푸르트 암마인 공항",
              arrAptNm: "인천 국제공항",
            },
          ],
        },
      },
      "EWP172260601TWF",
    );

    expect(result.itinerary.basics.flight.departure).toBe(
      "티웨이항공 TW0403 / 인천 국제공항 → 프랑크푸르트 암마인 공항 / 09:50 → 16:50",
    );
    expect(result.itinerary.basics.flight.arrival).toBe(
      "티웨이항공 TW0404 / 프랑크푸르트 암마인 공항 → 인천 국제공항 / 18:50 → 14:00",
    );
  });

  it("keeps hotel schedule names clean and appends hotel grade when available", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "스위스 호텔 테스트",
          depDay: "2026-06-01",
          arrDay: "2026-06-03",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              schdDay: 1,
              strtDt: "20260601",
              htlInfoList: [
                {
                  htlKoNm: "목시 시온 숙박",
                  htlGrdNm: "4성급",
                  cityNm: "시온",
                },
              ],
              schdMainInfoList: [],
            },
            {
              schdSeq: 2,
              schdDay: 2,
              strtDt: "20260602",
              htlInfoList: [
                {
                  htlKoNm: "홀리데이 인 익스프레스 & 스위트 시옹 바이 IHG 숙박",
                  htlGrdCd: "3",
                  cityNm: "시온",
                },
              ],
              schdMainInfoList: [],
            },
          ],
        },
      },
      "EWP172260601TWF",
    );

    expect(result.itinerary.basics.accommodation.hotel).toBe(
      "목시 시온 (4성급), 홀리데이 인 익스프레스 & 스위트 시옹 바이 IHG (3성급)",
    );
    expect(result.itinerary.days[0]?.items[0]).toMatchObject({
      type: "ACCOMMODATION",
      content: "목시 시온 (4성급)",
      hotel: "목시 시온 (4성급)",
    });
    expect(result.itinerary.days[1]?.items[0]).toMatchObject({
      type: "ACCOMMODATION",
      content: "홀리데이 인 익스프레스 & 스위트 시옹 바이 IHG (3성급)",
      hotel: "홀리데이 인 익스프레스 & 스위트 시옹 바이 IHG (3성급)",
    });
  });

  it("prefers user-facing product fields and removes internal MCP noise", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "다낭 4박 5일",
          depDay: "2026-06-02",
          arrDay: "2026-06-06",
          itnrCntyCds: "VN",
          vistCity: "DAD",
          prodAreaCd: "AV",
          adtAmt: 610000,
          htlEnn: "Y",
          chdInclRoomYn: "Y",
          cityBasInfoList: [
            { cityNm: "다낭" },
          ],
          trvlChcExpnList: [
            { trvlExpnDesc: "객실 1인 사용료 : 요금미정, 문의바랍니다." },
          ],
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              strtDt: "2026-06-02",
              schdMainInfoList: [
                {
                  id: "meeting",
                  schdCatgCd: "099",
                  schdCatgNm: "텍스트입력",
                  memoTitlNm: "인천출발 - 인천 공항 가이드 미팅 출국 3시간 전 인천공항 미팅 예정",
                },
                {
                  id: "visit-region",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  memoTitlNm: "방문지역 일본 추가",
                },
                {
                  id: "country-edit",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  memoTitlNm: "국가 수정 등록완료",
                },
              ],
            },
          ],
        },
      },
      "AVP999260602VNE",
    );

    const contents = result.itinerary.days.flatMap((day) => day.items.map((item) => item.content));

    expect(result.itinerary.overview.cities).toBe("다낭");
    expect(result.itinerary.overview.fare.adultPerPerson).toBe(610000);
    expect(result.itinerary.basics.accommodation.grade).toBe("");
    expect(result.itinerary.basics.accommodation.occupancy).toBe("");
    expect(result.itinerary.basics.optionalTour).toBe("");
    expect(contents.join("\n")).not.toContain("방문지역");
    expect(contents.join("\n")).not.toContain("국가 수정");
    expect(result.itinerary.days[0]?.items.find((item) => item.id === "meeting")).toMatchObject({
      type: "OTHER",
      content: "인천출발",
      detail: "인천 공항 가이드 미팅 출국 3시간 전 인천공항 미팅 예정",
    });
  });

  it("uses sightseeing card names before MCP memo titles", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "카드명 우선순위 테스트",
          depDay: "2026-06-02",
          arrDay: "2026-06-06",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              strtDt: "2026-06-02",
              schdMainInfoList: [
                {
                  id: "damnoen-card",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  memoTitlNm: "국가 수정 등록완료",
                  cardNm: "담넌사두억",
                  cardCntntPc: "담넌사두억상세보기 태국 수상시장 체험 이전다음",
                },
              ],
            },
          ],
        },
      },
      "AVP999260602VNE",
    );

    const contents = result.itinerary.days[0]?.items.map((item) => item.content) ?? [];

    expect(contents).toContain("담넌사두억");
    expect(contents.join("\n")).not.toContain("국가 수정");
  });

  it("drops group card containers but imports nested single cards as sightseeing items", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "그룹 카드 테스트",
          depDay: "2026-06-02",
          arrDay: "2026-06-06",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              strtDt: "2026-06-02",
              schdMainInfoList: [
                {
                  id: "group-container",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  cmsCardDvCd: "G",
                  cardNm: "묶음카드명 ttttttt",
                  cmsCardList: [
                    {
                      cmsCardId: "single-1",
                      cmsCardDvCd: "S",
                      cardNm: "사파리 파크",
                      cardCntntMbl: "베트남 꾸이년의 동물학 박물관",
                    },
                    {
                      cmsCardId: "single-2",
                      cmsCardDvCd: "S",
                      cardNm: "왓 아룬",
                      cardCntntMbl: "새벽 사원",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      "AVP999260602VNE",
    );

    const items = result.itinerary.days[0]?.items ?? [];
    const contents = items.map((item) => item.content);

    expect(contents).toContain("사파리 파크");
    expect(contents).toContain("왓 아룬");
    expect(contents).not.toContain("묶음카드명 ttttttt");
    expect(items.every((item) => item.type === "SIGHTSEEING")).toBe(true);
  });

  it("expands grouped Hanatour CMS content cards into separate sightseeing items", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "그룹 카드 텍스트 테스트",
          depDay: "2026-06-02",
          arrDay: "2026-06-06",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              strtDt: "2026-06-02",
              schdMainInfoList: [
                {
                  id: "group-text-container",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  cmsCardDvCd: "G",
                  cardNm: "묶음카드명 ttttttt",
                  cmsInfoList: [
                    {
                      cmsCntntId: "safari",
                      cmsCntntNm: "사파리 파크",
                      cmsCntntCont: "베트남 꾸이년의 동물학 박물관 사파리 파크",
                    },
                    {
                      cmsCntntId: "wat-arun",
                      cmsCntntNm: "왓 아룬",
                      cmsCntntCont: "신비로운 새벽 사원",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      "AVP999260602VNE",
    );

    const contents = result.itinerary.days[0]?.items.map((item) => item.content) ?? [];

    expect(contents).toContain("사파리 파크");
    expect(contents).toContain("왓 아룬");
    expect(result.itinerary.days[0]?.items.find((item) => item.content === "사파리 파크")?.detail).toBe(
      "베트남 꾸이년의 동물학 박물관 사파리 파크",
    );
    expect(result.itinerary.days[0]?.items.find((item) => item.content === "왓 아룬")?.detail).toBe(
      "신비로운 새벽 사원",
    );
    expect(contents.join("\n")).not.toContain("묶음카드명");
    expect(contents.join("\n")).not.toContain("카드매니저");
  });

  it("uses mealCont for meals and CMS content fields for sightseeing items", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "식사 관광 테스트",
          depDay: "2026-06-02",
          arrDay: "2026-06-06",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              strtDt: "2026-06-02",
              schdMainInfoList: [
                {
                  id: "breakfast-excluded",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "조식",
                  mealCont: "불포함",
                },
                {
                  id: "lunch-flight",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "중식",
                  mealTypeNm: "기내식",
                  mealCont: "기내식은 한식으로 제공됩니다.",
                },
                {
                  id: "burapha",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  cmsInfoList: [
                    {
                      cmsCntntId: "burapha",
                      cmsCntntNm: "부라파 골프 클럽",
                      cmsCntntCont: "BURAPHA GOLF CLUB",
                    },
                  ],
                },
                {
                  id: "damnoen",
                  schdCatgCd: "001",
                  schdCatgNm: "관광",
                  cmsInfoList: [
                    {
                      cmsCntntId: "damnoen",
                      cmsCntntNm: "담넌사두억",
                      cmsCntntCont: "태국 수상시장 체험",
                    },
                  ],
                },
              ],
            },
            {
              schdSeq: 2,
              strtDt: "2026-06-03",
              schdMainInfoList: [
                {
                  id: "breakfast-resort",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "조식",
                  mealCont: "리조트식",
                },
                {
                  id: "lunch-free",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "중식",
                  mealCont: "자유식사, 일정 미포함입니다.",
                },
                {
                  id: "dinner-local",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "석식",
                  mealTypeNm: "현지식",
                  mealCont: "골프장 이용 고객은 클럽하우스 내에서 식사 준비",
                },
                {
                  id: "resort-free-time",
                  schdCatgCd: "099",
                  schdCatgNm: "텍스트입력",
                  memoTitlNm: "리조트 조식 후 오전 리조트 내 자유시간",
                },
              ],
            },
          ],
        },
      },
      "AVP999260602VNE",
    );

    const firstDayItems = result.itinerary.days[0]?.items ?? [];
    const secondDayItems = result.itinerary.days[1]?.items ?? [];
    const firstDayMeals = firstDayItems.filter((item) => item.type === "MEAL");
    const secondDayMeals = secondDayItems.filter((item) => item.type === "MEAL");

    expect(firstDayMeals.find((item) => item.id === "breakfast-excluded")?.meal?.breakfast).toBe("불포함");
    expect(firstDayMeals.find((item) => item.id === "lunch-flight")?.meal?.lunch).toBe(
      "기내식은 한식으로 제공됩니다.",
    );
    expect(firstDayItems.map((item) => item.content)).toContain("부라파 골프 클럽");
    expect(firstDayItems.find((item) => item.content === "부라파 골프 클럽")?.detail).toBe("BURAPHA GOLF CLUB");
    expect(firstDayItems.map((item) => item.content)).toContain("담넌사두억");
    expect(firstDayItems.find((item) => item.content === "담넌사두억")?.detail).toBe("태국 수상시장 체험");
    expect(secondDayMeals.find((item) => item.id === "breakfast-resort")?.meal?.breakfast).toBe("리조트식");
    expect(secondDayMeals.find((item) => item.id === "lunch-free")?.meal?.lunch).toBe("자유식사, 일정 미포함입니다.");
    expect(secondDayMeals.find((item) => item.id === "dinner-local")?.meal?.dinner).toBe(
      "골프장 이용 고객은 클럽하우스 내에서 식사 준비",
    );
    expect(secondDayItems.find((item) => item.id === "resort-free-time")).toMatchObject({
      type: "OTHER",
      content: "리조트 조식 후 오전 리조트 내 자유시간",
    });
  });

  it("uses Hanatour schdDay order, meal type fallback, and card subtitle details", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "스위스 일주 테스트",
          depDay: "2026-06-01",
          arrDay: "2026-06-09",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              schdDay: 1,
              strtDt: "20260601",
              schdMainInfoList: [
                {
                  id: "day1-lunch",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  dtlMealDvNm: "중식",
                  mealTypeNm: "기내식",
                  mealCont: null,
                },
              ],
            },
            {
              schdSeq: 6,
              schdDay: 2,
              strtDt: "20260602",
              schdMainInfoList: [
                {
                  id: "strasbourg",
                  schdCatgCd: "001",
                  schdCatgNm: "관광지",
                  cmsCardDvCd: "G",
                  cardNm: "독일의 풍취가 있는 아름다운 프랑스 마을, '스트라스부르'",
                  cmsInfoList: [
                    {
                      cmsCntntId: "P000272720",
                      cmsCntntNm: "스트라스부르(Strasbourg)",
                      cmsCntntCont: "아름다운 스트라스부르는 독일 국경에서 5km 정도 떨어져 있습니다.",
                    },
                  ],
                },
              ],
            },
            {
              schdSeq: 2,
              schdDay: 7,
              strtDt: "20260607",
              schdMainInfoList: [
                {
                  id: "hotel-note",
                  schdCatgCd: "099",
                  schdCatgNm: "텍스트입력",
                  memoTitlNm: "호텔 투숙",
                  memoCont:
                    "※ 예정호텔은 변경될 수 있으며 하기 예정 호텔 또는 동급 호텔로 확정됩니다.",
                },
                {
                  id: "zurich",
                  schdCatgCd: "001",
                  schdCatgNm: "관광지",
                  cmsCardDvCd: "G",
                  cardNm: "스위스 최대의 도시, 취리히 관광",
                  cardCntntPc:
                    '<div class="_tit title"><strong class="eps">그로스뮌스터 대성당</strong><a c_code="P000276180">상세보기</a></div><div class="_tit_comt sub"><p class="eps">Grossmuenster</p><p class="eps">스테인드 글라스가 눈부신 그로스뮌스터 대성당</p></div><div class="_tit title"><strong class="eps">린덴호프(Lindenhof)</strong><a c_code="P000312405">상세보기</a></div><div class="_tit_comt sub"></div>',
                  cmsInfoList: [
                    {
                      cmsCntntId: "P000276180",
                      cmsCntntNm: "그로스뮌스터 대성당",
                      cmsCntntCont:
                        "스위스에서 가장 크고 중요한 로마네스크 성당으로 종교개혁의 어머니 교회로 일컬어지기도 합니다.",
                    },
                    {
                      cmsCntntId: "P000312405",
                      cmsCntntNm: "린덴호프(Lindenhof)",
                      cmsCntntCont:
                        "취리히의 구시가지에 위치한 린덴호프는 고대 로마의 요새 유적이 있었던 역사적인 장소입니다.",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      "EWP172260601TWF",
    );

    expect(result.itinerary.days.map((day) => day.dayNo)).toEqual([1, 2, 7]);
    expect(result.itinerary.days[0]?.items[0]?.meal?.lunch).toBe("기내식");
    expect(result.itinerary.days[1]?.items[0]?.content).toBe("스트라스부르(Strasbourg)");
    expect(result.itinerary.days[2]?.items[0]).toMatchObject({
      type: "OTHER",
      content: "호텔 투숙",
      detail: "※ 예정호텔은 변경될 수 있으며 하기 예정 호텔 또는 동급 호텔로 확정됩니다.",
    });
    expect(result.itinerary.days[2]?.items[1]).toMatchObject({
      content: "그로스뮌스터 대성당",
      detail: "스테인드 글라스가 눈부신 그로스뮌스터 대성당",
    });
    expect(result.itinerary.days[2]?.items[2]).toMatchObject({
      content: "린덴호프(Lindenhof)",
    });
    expect(result.itinerary.days[2]?.items[2]?.detail).toBeUndefined();
  });

  it("prefixes optional tour schedule content and keeps special-included marker first", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "선택관광 테스트",
          depDay: "2026-06-01",
          arrDay: "2026-06-02",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 1,
              schdDay: 1,
              strtDt: "20260601",
              schdMainInfoList: [
                {
                  id: "rigi-spa",
                  schdCatgCd: "005",
                  schdCatgNm: "선택관광",
                  cmsCardDvCd: "S",
                  chcStsngCd: "012878",
                  cardNm: "리기 칼트바드 알프스 온천체험",
                  cardCntntPc:
                    '<div class="_tit title"><strong class="eps">리기 칼트바드 알프스 온천체험</strong><a c_code="rigi-spa">상세보기</a></div><div class="_tit_comt sub"></div>',
                  cmsInfoList: [
                    {
                      cmsCntntId: "rigi-spa",
                      cmsCntntNm: "리기 칼트바드 알프스 온천체험",
                      cmsCntntCont: "리기 칼트바드 온천은 리기산 중턱에 위치한 미네랄 온천입니다.",
                      cmsSpclStsngYn: "N",
                      chcStsngCd: "012878",
                    },
                  ],
                },
                {
                  id: "optional-with-short-html-sub",
                  schdCatgCd: "005",
                  schdCatgNm: "선택관광",
                  cmsCardDvCd: "S",
                  spclStsngYn: "Y",
                  chcStsngCd: "088888",
                  cardNm:
                    "안탈리아 유람선 - 안탈리아 마리나 항구로 이동하여 아름다운 지중해 바다를 유람선을 타고 투어합니다.",
                  cardCntntTitlNm: "안탈리아 유람선 보조 제목",
                  cardCntntPc:
                    '<div class="_tit title"><strong class="eps">안탈리아 유람선</strong><a c_code="antalya-cruise">상세보기</a></div><div class="_tit_comt sub"><p class="eps">아름다운 지중해 유람선 투어</p></div>',
                  cmsInfoList: [
                    {
                      cmsCntntId: "antalya-cruise",
                      cmsCntntNm:
                        "안탈리아 유람선 CMS 제목 - 고객의 안전을 고려하여 기상상황에 따라 진행하지 않을 수 있습니다.",
                      cmsCntntCont:
                        "안탈리아 마리나 항구로 이동하여 아름다운 지중해 바다를 유람선을 타고 투어합니다. 고객의 안전을 고려하여 기상상황이 안 좋을 때나 배에 구명조끼가 구비되어있지 않을 경우 선택관광을 진행하지 않습니다.",
                      cmsSpclStsngYn: "Y",
                      chcStsngCd: "088888",
                    },
                  ],
                },
                {
                  id: "direct-optional-long-title",
                  schdCatgCd: "005",
                  schdCatgNm: "선택관광",
                  cmsCardDvCd: "S",
                  chcStsngCd: "077777",
                  cardNm: "직접 선택관광 - 이 긴 설명은 상세에 들어가면 안 됩니다.",
                },
                {
                  id: "special-optional",
                  schdCatgCd: "005",
                  schdCatgNm: "선택관광",
                  cmsCardDvCd: "S",
                  spclStsngYn: "Y",
                  chcStsngCd: "099999",
                  cardNm: "스페셜 선택관광",
                },
              ],
            },
          ],
        },
      },
      "EWP172260601TWF",
    );

    expect(result.itinerary.days[0]?.items[0]).toMatchObject({
      content: "[선택관광]리기 칼트바드 알프스 온천체험",
    });
    expect(result.itinerary.days[0]?.items[0]?.detail).toBeUndefined();
    expect(result.itinerary.days[0]?.items[1]).toMatchObject({
      content: "[스페셜포함][선택관광]안탈리아 유람선",
      detail: "아름다운 지중해 유람선 투어",
    });
    expect(result.itinerary.days[0]?.items[1]?.content).not.toContain("안탈리아 마리나 항구");
    expect(result.itinerary.days[0]?.items[1]?.detail).not.toContain("고객의 안전");
    expect(result.itinerary.days[0]?.items[2]).toMatchObject({
      content: "[선택관광]직접 선택관광",
    });
    expect(result.itinerary.days[0]?.items[2]?.detail).toBeUndefined();
    expect(result.itinerary.days[0]?.items[3]?.content).toBe("[스페셜포함][선택관광]스페셜 선택관광");
  });

  it("keeps meal rows even when Hanatour marks the meal as a group CMS card", () => {
    const result = mapMcpProductToItinerary(
      {
        baseProductInfo: {
          saleProdNm: "프라하 중식 특식 테스트",
          depDay: "2026-06-02",
          arrDay: "2026-06-08",
        },
        itineraryInfo: {
          schdInfoList: [
            {
              schdSeq: 7,
              schdDay: 7,
              strtDt: "2026-06-08",
              schdMainInfoList: [
                {
                  id: "special-lunch",
                  schdCatgCd: "004",
                  schdCatgNm: "식사",
                  cmsCardDvCd: "G",
                  dtlMealDvNm: "중식 특식",
                  mealTypeNm: "현지식[양식]",
                  mealCont: "프라하 양조장 레스토랑에서 즐기는 스비치코바와 맥주 1잔",
                  cardNm: "필스너 우르켈 직영 레스토랑에서 즐기는 스비치코바",
                },
              ],
            },
          ],
        },
      },
      "EEP133260602OZX",
    );

    const meal = result.itinerary.days[0]?.items.find((item) => item.id === "special-lunch");

    expect(meal).toMatchObject({
      type: "MEAL",
      mealSlot: "lunch",
    });
    expect(meal?.meal?.lunch).toContain("프라하 양조장 레스토랑에서 즐기는 스비치코바와 맥주 1잔");
    expect(meal?.meal?.lunch).not.toContain("현지식[양식]");
  });
});
