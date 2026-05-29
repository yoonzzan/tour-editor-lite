import { afterEach, describe, expect, it, vi } from "vitest";
import { currentYearInKorea } from "@/lib/date/korea";
import {
  ANALYSIS_SYSTEM_PROMPT,
  PARSER_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
  buildParseUserPrompt,
} from "@/lib/itinerary/aiPrompts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("AI prompt builders", () => {
  it("keeps analysis prompt structure and core extraction rules", () => {
    const prompt = buildAnalysisUserPrompt("테스트 일정", "1일차 인천공항 출발");

    expect(ANALYSIS_SYSTEM_PROMPT).toContain("JSON 생성이 아니라");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("HOTEL/호텔명 행");
    expect(prompt).toContain("[AI 분석 결과]");
    expect(prompt).toContain("[일차별 일정]");
    expect(prompt).toContain("[원문]");
    expect(prompt).toContain("1일차 | TRANSFER | 인천공항 출발 |  | 10:00 | ");
    expect(prompt).toContain("title: 테스트 일정");
  });

  it("can include code-extracted evidence in the analysis prompt", () => {
    const prompt = buildAnalysisUserPrompt(
      "싱가포르 테스트",
      "제2일 싱가포르\n중:키세키일식부풰",
      '[확정 evidence]\n- kind=meal day=2 slot=lunch value="키세키일식부풰" source="중:키세키일식부풰"',
    );

    expect(prompt).toContain("[코드 추출 evidence]");
    expect(prompt).toContain("확정 evidence는 누락하지 말고");
    expect(prompt).toContain('kind=meal day=2 slot=lunch value="키세키일식부풰"');
    expect(prompt).toContain("[원문]");
  });

  it("keeps parse prompt scoped to analysis text and core JSON rules", () => {
    const prompt = buildParseUserPrompt("테스트 일정", "1일차 | TRANSFER | 인천공항 출발 |  | 10:00 |");

    expect(PARSER_SYSTEM_PROMPT).toContain("반드시 JSON 객체만 출력");
    expect(PARSER_SYSTEM_PROMPT).toContain("견적번호/기준코드/출발일/인원/차량/호텔/포함/불포함/비고/지상비");
    expect(prompt).toContain("[AI 분석 결과]");
    expect(prompt).not.toContain("[원문]");
    expect(prompt).toContain("10-1) 분석 요약에 day별 HOTEL/호텔명 행이 있으면 해당 day의 ACCOMMODATION item으로 반드시 생성한다.");
    expect(prompt).toContain("11) 지역(region)과 교통편(transport)은 일정 항목에서 항상 비워둔다.");
  });
});

function jangjiajieHighDetailOcrText(): string {
  return [
    "[QUOTE_RESPONSE_SCREEN]",
    "날짜 | 지역 | 교통편 | 시간 | 주요 일정 | 식사",
    "제1일 | 장가계 | 전용버스 | 김해도착 | -부산 김해국제공항 출발 (3시간 15분 소요) | 조:호텔식",
    " | | | | -장가계 국가급 풍경명승지 천문산 (케이블카탑승) | 중:석식",
    " | | | | -세기산에서 가장 높은 곳에 위치한 유리잔도에서의 자유시간 | 석:무제",
    " | | | | -천문산과 구름다리 유리잔도선 관광 후 숙소 이동 |",
    " | | | | -장가계 721호 (내부) 호텔 투숙 |",
    " | | | | -천문산 관광 후 장가계로 이동하여 숙소에서 대피 |",
    "제2일 | 장가계 | 전용버스 | 호텔 조식 후 | -인공수로를 통해 430m에 있는 산봉우리 보봉호수 유람선 VIP | 조:호텔식",
    " | | | | -장가계에서 가장 자주 방문하는 곳으로 산을 즐길 수 있는 보봉호수 | 중:석식",
    " | | | | -하룡공원, 선녀헌화, 천대서해 관광 |",
    " | | | | -미인봉과 아양의 흙을 실감하는 (모노레일탑승) |",
    " | | | | -다이아몬드의 신비를 감상할 수 있는 그랜드캐니언 |",
    " | | | | -여행의 피로를 풀어주는 발천산스파 (90분) |",
    " | | | | -무릉원의 방향은 무릉원 이곳에서 |",
    " | | | | HOTEL: 블루베이 호텔 또는 동급 (준특급) |",
    "제3일 | 장가계 | 전용버스 | 호텔 조식 후 | -바다 타고 이르는 카르스트형의 대명 저항동굴 활동동굴 VIP | 조:호텔식",
    " | | | | -장가계천문산 (유리다리+엘리베이터+유리잔도+4D VR) | 중:석식",
    " | | | | -여행의 피로를 풀어주는 발천산스파 (90분) |",
    " | | | | -무릉원의 방향은 무릉원 이곳에서 |",
    " | | | | HOTEL: 블루베이 호텔 또는 동급 (준특급) |",
    "제4일 | 장가계 | 전용버스 | 호텔 조식 후 | -돌과 모래로 만든 그림을 전시한 군성사석화 박물관 | 조:호텔식",
    " | | | | -공항으로 이동 후 장가계 국제공항 도착 | 중:도시락",
    " | | | | -부산 김해국제공항 도착 | 석:불포함",
  ].join("\n");
}

describe("parseItineraryByAi fallback", () => {
  it("parses quotation metadata separately from simple itinerary days", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `견적번호 : QA00686173001
기준코드 : AVU221260809VJA

1. 출발일 : 2026.08..09
2. 인원 : 6+0
3. 차량 : 16인승
4. 호텔 : 나트랑 메리어트 리조트 앤 스파 혼트레섬, 3베드룸 풀빌라 가든뷰 3박
5. 포함 :  기가경비
6. 불포함 : 개인 여행경비
7. 비고 : 노쇼핑/ 노옵션
8. 지상비 : 78만원

*빈펄 나트랑베이 3베드룸 풀빌라 풀뷰 3박 24만원 업/인당
*한국인가이드 기준입니다.

[간단일정]
1일차 : 나트랑도착, 혼총곶, 리조트투숙 / 쌀국수, 리조트식
2일차 : 빈원더스 일일 자유일정(가이드+차량 불포함) / 불포함, 리조트식
3일차 : 빈원더스 일일 자유일정(가이드+차량 불포함) / 불포함, 리조트식
4일차 : 오전자유일정, 롱손사, 포나가, 담시장, 아이리조트머드온천, 공항이동 / 한식, 현지식
5일차 : 도착`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });
    expect(result.days).toHaveLength(5);
    expect(result.overview.travelPeriod).toEqual({
      start: "2026-08-09",
      end: "2026-08-13",
    });
    expect(result.overview.passengers.adult).toBe(6);
    expect(result.overview.passengers.child).toBe(0);
    expect(result.basics.flight.localVehicle).toBe("16인승");
    expect(result.basics.accommodation.hotel).toContain("나트랑 메리어트");
    expect(result.basics.included).toBe("기가경비");
    expect(result.basics.excluded).toBe("개인 여행경비");
    expect(result.basics.shoppingCenters).toBe(0);
    expect(result.basics.optionalTour).toBe("노옵션");
    expect(result.overview.fare.adultPerPerson).toBe(780000);

    const allContents = result.days.flatMap((day) =>
      day.items.map((item) => item.content)
    );
    expect(allContents).not.toContain("견적번호 : QA00686173001");
    expect(allContents).not.toContain("1. 출발일 : 2026.08..09");
    expect(result.days[0]?.items.map((item) => item.content)).toContain("혼총곶");
    expect(result.days[0]?.items.some((item) => item.type === "ACCOMMODATION")).toBe(true);
  });

  it("does not fallback to 1899 dates when schedule has no explicit base date", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `
1일차 | 호텔 체크인
3일차 | 공항 이동
`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });

    expect(result.days.map((day) => day.dayNo)).toEqual([1, 3]);
    expect(result.days.every((day) => day.date !== "1899-12-31")).toBe(true);
    expect(result.overview.travelPeriod.start).not.toBe("1899-12-31");
  });

  it("returns quality diagnostics for deterministic parsing", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const rawText = `상품명: 싱가포르 4박 5일
기간: 2026-06-02 ~ 2026-06-06
인원: 성인 10, 아동 0
항공 출발: OZ751 인천 10:00 → 싱가포르 15:30
숙박호텔: Aloft Singapore Novena

1일차 2026-06-02
- 이동 | 시간=10:00 | 인천공항 출발
- 식사 | 석식: 현지식
- 숙박 | Aloft Singapore Novena
2일차 2026-06-03
- 식사 | 조식: 호텔식
- 관광 | 센토사섬`;

    const result = await parseItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });

    expect(result.diagnostics.selectedCandidate).toBe("deterministic-narrative");
    expect(result.diagnostics.qualityScore).toBeGreaterThanOrEqual(70);
    expect(result.diagnostics.fieldCoverage?.dayCount).toBe(2);
    expect(result.diagnostics.fieldCoverage?.mealCount).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.fieldCoverage?.accommodationCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.candidateScores?.[0]?.candidate).toBe("deterministic-narrative");
    expect(result.diagnostics.noiseRemovedCount).toBeGreaterThanOrEqual(0);
  });

  it("keeps region transport and time in typed direct input lines", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const rawText = `1일차 2026-06-02
- 이동 | 지역=인천 | 교통편=OZ751 | 시간=10:00 | 인천공항 출발
- 관광 | 지역=싱가포르 | 교통편=전용버스 | 시간=15:30 | 머라이언 공원
- 식사 | 지역=싱가포르 | 교통편=도보 | 시간=18:00 | 석식: 현지식`;

    const result = await parseItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const dayOne = result.itinerary.days.find((day) => day.dayNo === 1);
    const transfer = dayOne?.items.find((item) => item.content.includes("인천공항 출발"));
    const sightseeing = dayOne?.items.find((item) => item.content.includes("머라이언 공원"));
    const dinner = dayOne?.items.find((item) => item.mealSlot === "dinner");

    expect(transfer).toMatchObject({
      type: "TRANSFER",
      region: "인천",
      transport: "OZ751",
      time: "10:00",
    });
    expect(sightseeing).toMatchObject({
      type: "SIGHTSEEING",
      region: "싱가포르",
      transport: "전용버스",
      time: "15:30",
    });
    expect(dinner).toMatchObject({
      type: "MEAL",
      region: "싱가포르",
      transport: "도보",
      time: "18:00",
    });
  });

  it("ignores editable preview section headers and keeps starred day markers", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const rawText = `<<상품 정보>>
상품명: 싱가포르 4박 5일
**항공/교통**
항공 출발: OZ751 인천 10:00 → 싱가포르 15:30
<<상세 일정>>
*1일차*
2026-06-02
- 이동 | 지역=인천 | 교통편=OZ751 | 시간=10:00 | 인천공항 출발
**상세 일정**
*2일차*
2026-06-03
- 관광 | 지역=싱가포르 | 교통편=전용버스 | 시간=15:30 | 머라이언 공원`;

    const result = await parseItineraryWithDiagnostics({ rawText, title: "미리보기 재파싱" });
    const flatItems = result.itinerary.days.flatMap((day) => day.items);

    expect(result.itinerary.days.map((day) => day.dayNo)).toEqual([1, 2]);
    expect(result.itinerary.days[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "TRANSFER",
          content: "인천공항 출발",
          region: "인천",
          transport: "OZ751",
          time: "10:00",
        }),
      ])
    );
    expect(result.itinerary.days[1]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "SIGHTSEEING",
          content: "머라이언 공원",
          region: "싱가포르",
          transport: "전용버스",
          time: "15:30",
        }),
      ])
    );
    expect(flatItems.some((item) => /상품 정보|항공\/교통|상세 일정/u.test(item.content))).toBe(false);
  });

  it("keeps deterministic parsing coverage for schedules after long leading text", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const longLeadingText = Array.from({ length: 700 }, (_, index) => `참고사항 ${index + 1}: 견적 검토용 문구`).join("\n");
    const rawText = `${longLeadingText}

[상세일정]
1일차 2026-07-01
- 이동 | 시간=09:00 | 인천공항 출발
- 관광 | 타이베이 101 전망대
- 식사 | 석식: 딘타이펑
- 숙박 | GRAND HYATT TAIPEI
2일차 2026-07-02
- 식사 | 조식: 호텔식
- 관광 | 예류 지질공원`;

    const result = await parseItineraryWithDiagnostics({ rawText, title: "긴 원문 테스트" });
    const contents = result.itinerary.days.flatMap((day) => day.items.map((item) => item.content));

    expect(rawText.length).toBeGreaterThan(12000);
    expect(result.itinerary.days.map((day) => day.dayNo)).toEqual([1, 2]);
    expect(contents).toContain("타이베이 101 전망대");
    expect(contents).toContain("GRAND HYATT TAIPEI");
    expect(result.diagnostics.fieldCoverage?.meaningfulItemCount).toBeGreaterThanOrEqual(6);
  });

  it("parses abbreviated D-day summaries with hyphen meal markers", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const rawText = `5. 간략 일정 :
D1 : 공항미팅 / 푸트라자야&푸트라 모스크 / 호텔 투숙 및 휴식 / 석-한식
D2 : 겐팅하이랜드 케이블카 / 바투동굴 / 반딧불 투어 / 중-현지식 / 석-세미씨푸드
D3 : 네덜란드광장 / 트라이쇼 / 중-한식 / 석-현지식
D4 : 국립모스크 / 공항샌딩 / 중-한식 / 석-현지식`;

    const result = await parseItineraryWithDiagnostics({ rawText, title: "쿠말겐 간략 일정" });
    const dayOne = result.itinerary.days.find((day) => day.dayNo === 1);
    const dayTwo = result.itinerary.days.find((day) => day.dayNo === 2);

    expect(result.itinerary.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4]);
    expect(dayOne?.items.some((item) => item.type === "ACCOMMODATION" && item.content.includes("호텔 투숙"))).toBe(true);
    expect(dayOne?.items.find((item) => item.type === "MEAL" && item.mealSlot === "dinner")?.content).toBe("한식");
    expect(dayTwo?.items.find((item) => item.type === "MEAL" && item.mealSlot === "lunch")?.content).toBe("현지식");
    expect(dayTwo?.items.find((item) => item.type === "MEAL" && item.mealSlot === "dinner")?.content).toBe("세미씨푸드");
    expect(result.diagnostics.fieldCoverage?.mealCount).toBeGreaterThanOrEqual(7);
    expect(result.diagnostics.fieldCoverage?.accommodationCount).toBeGreaterThanOrEqual(1);
  });

  it("parses copied product summaries into overview and basics metadata", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `상품명: 다낭 테스트 5일
도시 VN, DAD, AV
기간 2026-06-02 ~ 2026-06-06
여행요금: 859,900원
항공 출발: OZ752 인천 10:00 → 다낭 13:00
항공 귀국: OZ753 다낭 14:00 → 인천 20:00
숙박호텔: 다낭 메리어트 리조트 & 스파
포함사항: 왕복항공권 / 숙박비
불포함사항: 개인 여행경비
선택관광: 담락스파
쇼핑센터 방문 수: 1

1일차 2026-06-02
- 이동 | 인천출발 - 인천 공항 가이드 미팅 출국 3시간 전 인천공항 미팅 예정
- 숙박 | 다낭 메리어트 리조트 & 스파 숙박
2일차 2026-06-03
- 관광 | 방문지역 일본 추가`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });

    expect(result.header.groupName).toBe("다낭 테스트 5일");
    expect(result.overview.cities).toBe("VN, DAD, AV");
    expect(result.overview.travelPeriod).toEqual({
      start: "2026-06-02",
      end: "2026-06-06",
    });
    expect(result.overview.fare.adultPerPerson).toBe(859900);
    expect(result.basics.flight.departure).toBe("OZ752 인천 10:00 → 다낭 13:00");
    expect(result.basics.flight.arrival).toBe("OZ753 다낭 14:00 → 인천 20:00");
    expect(result.basics.accommodation.hotel).toBe("다낭 메리어트 리조트 & 스파");
    expect(result.basics.included).toBe("왕복항공권 / 숙박비");
    expect(result.basics.excluded).toBe("개인 여행경비");
    expect(result.basics.optionalTour).toBe("담락스파");
    expect(result.basics.shoppingCenters).toBe(1);

    const firstItem = result.days[0]?.items[0];
    expect(firstItem?.content).toBe("인천출발");
    expect(firstItem?.detail).toBe("인천 공항 가이드 미팅 출국 3시간 전 인천공항 미팅 예정");
  });

  it("ignores table headers and fee blocks in pasted tabular itineraries", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `[견적서] CTS 3박4일
DATE	CITY	TRSFT	TIME	ITINERARY	ITINERARY	ITINERARY	ITINERARY	MEALS
제1일	인천		12:35	인천 국제 공항 3층 집결 및 가이드 미팅
2/28	BX	12:35	신치토세 공항 도착
	신치토세	전용버스	15:30	신치토세 공항 도착
				호텔 체크인 후 석식 및 휴식(온천욕♨)
제2일	조잔케이	전용버스		호텔 조식 후
	후라노		후라노 이동.				L: 현지식
제3일	소운쿄	전용버스		호텔 조식 후
	오타루		오타루 이동.
제4일	삿포로	전용버스		호텔 조식 후
TOUR FEE (1인 지상비)
	02월 28일	¥101,000 	¥132,000
참고 사항
*현지 호텔은 미수배 상태이므로 예약 시점에서 수배 진행 예정 입니다.
불포함사항
*해외여행자보험 불포함입니다.
기타사항
*환율은 변동 환율 기준입니다.`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });

    expect(result.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4]);
    const dayContents = result.days.flatMap((day) => day.items.map((item) => item.content));
    expect(dayContents.every((text) => !text.includes("DATE"))).toBe(true);
    expect(dayContents.every((text) => !text.includes("TOUR FEE"))).toBe(true);
    expect(dayContents.every((text) => !text.includes("참고 사항"))).toBe(true);
    expect(dayContents.every((text) => !text.includes("기타사항"))).toBe(true);
    expect(dayContents.every((text) => !text.includes("불포함사항"))).toBe(true);
    expect(dayContents).toContain("인천 국제 공항 3층 집결 및 가이드 미팅");
    expect(dayContents.some((text) => text.includes("신치토세 공항 도착"))).toBe(true);
    expect(result.overview.travelPeriod.start).toBe("2026-02-28");
  });

  it("keeps pasted full itinerary table from copy into meaningful rows only", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `[견적서] CTS 3박4일\nDATE\tCITY\tTRSFT\tTIME\tITINERARY\tMEALS\n제1일\t인천\t\t\t12:35\t인천 국제 공항 3층 집결 및 가이드 미팅\t\n2/28\tBX\t12:35\t신치토세 공항 도착\n\t신치토세\t전용버스\t15:30\t신치토세 공항 도착\n\t\t\t\t호텔 체크인 후 석식 및 휴식(온천욕♨)\n제2일\t조잔케이\t전용버스\t\t호텔 조식 후\t\n\t후라노\t\t후라노 이동.\t\n\t\t\tL: 현지식\n제3일\t소운쿄\t전용버스\t\t호텔 조식 후\t\n\t오타루\t\t오타루 이동.\n제4일\t삿포로\t전용버스\t\t호텔 조식 후\t\nTOUR FEE (1인 지상비)\n\t02월 28일\t¥101,000\t\t¥132,000\n참고 사항\n*현지 호텔은 미수배 상태이므로 예약 시점에서 수배 진행 예정 입니다.\n불포함사항\n*해외여행자보험 불포함입니다.\n기타사항\n*환율은 변동 환율 기준입니다.`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });
    expect(result.days).toHaveLength(4);
    const allContent = result.days.flatMap((day) => day.items.map((item) => item.content));
    const allDetail = result.days.flatMap((day) => day.items.map((item) => item.detail ?? ""));

    expect(allContent.some((text) => text.includes("DATE"))).toBe(false);
    expect(allContent.some((text) => text.includes("TOUR FEE"))).toBe(false);
    expect(allContent.some((text) => text.includes("참고 사항"))).toBe(false);
    expect(allContent.every((text) => !text.includes("1899"))).toBe(true);
    expect(allDetail.every((text) => !text.includes("1899"))).toBe(true);
    expect(allContent).toContain("인천 국제 공항 3층 집결 및 가이드 미팅");
    expect(allContent).toContain("신치토세 공항 도착");
    expect(allContent).toContain("호텔 체크인 후 석식 및 휴식(온천욕♨)");
    expect(result.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4]);
  });

  it("parses the provided pasted schedule without generating header/detail noise", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `[견적서] CTS 3박4일
DATE	CITY	TRSFT	TIME	ITINERARY				MEALS
제1일	인천			인천 국제 공항 3층 집결 및 가이드 미팅				
2/28		BX	12:35	인천 국제 공항 출발				
	신치토세	전용버스	15:30	신치토세 공항 도착				L: 불포함
	조잔케이			조잔케이 이동.				
				호텔 체크인 후 석식 및 휴식(온천욕♨)				D: 호텔식
				HOTEL : 조잔케이 뷰 호텔 (2인1실/ 화실 또는 양실 기준)				(뷔페식)
				https://www.jozankeiview.com/				
제2일	조잔케이	전용버스		호텔 조식 후				B:호텔식
	후라노			후라노 이동.				
				*작은요정마을을 연상시키는 닝구르테라스 관광				L: 현지식
비에이			비에이 이동.				(오무카레정식)
				*신비로운 푸른연못 아오이 이케 관광				
				*폭포의 물줄기가 흰수염 같다하여 붙여진 흰수염 폭포 관광				
				*패치워크의 길 관광(차창)				
	소운쿄			소운쿄 이동.				
				호텔 체크인 후 석식 및 휴식(온천욕♨)				
				HOTEL : 소운쿄 다이세츠 호텔 (2인1실/ 화실 또는 양실 기준)				D: 호텔식
				https://www.hotel-taisetsu.com/				(뷔페식)
제3일	소운쿄	전용버스		호텔 조식 후				B:호텔식
	오타루			오타루 이동.				
				*오르골 전시관인 오타루 오르골당 관광				
				*유리 제품을 진열 및 판매하는 기타이치가라스관(北一ガラス館) 관광				
				*오타루의 대표적인 랜드마크인 오타루 운하(小樽運河) 관광				L: 현지식
	삿포로			삿포로 이동. 				(규카츠 정식)
				*시로이 코이비토 파크 관광 (무료존)				
				*북해도 시민들의 휴식처이자 여러 축제의 장 오도리공원관광				
				석식 후 호텔이동.				
				호텔 체크인 후 휴식				D: 현지식
				HOTEL : 삿포로 프린스 호텔 (2인1실/ 양실기준)				(대게 무제한)
				https://www.princehotels.co.jp/sapporo/				
제4일	삿포로	전용버스		호텔 조식 후 				B:호텔식
				*구도청사와 더불어 삿포를 대표하는 관광 명소인 삿로포 시계탑(차장 관광) 관광				
				*면세점 1회 방문				
	치토세			치토세 공항 이동.(약 1시간 소요)				L: 현지식
				신치토세 공항 도착 후 출국 수속				(스프카레)
		BX	16:30	신치토세 국제 공항 출발				
	인천		20:10	인천 국제 공항 도착				
"TOUR FEE
(1인 지상비)"					8명 + 1 드라이빙 가이드		8명 + 1 현지가이드	
		02월 28일			¥101,000 		¥132,000 	
참고 사항		*현지 호텔은 미수배 상태이므로 예약 시점에서 수배 진행 예정 입니다.						
포함사항		*현지 드라이빙 가이드 조건입니다.						
		*전일정 숙박 2인 1실 사용기준 입니다.						
		*가이드 &기사 팁 포함(성인, 아동 동일 ￥4,000)입니다.						
		*전용버스 4일, 중식(현지식 3회), 석식(현지식 2회+호텔식 1회), 명시된 관광지 입장료는 포함입니다.						
불포함사항		*해외여행자보험 불포함입니다.						
		*항공료 및 텍스&유류 할증료 기타 개인 경비 불포함 조건입니다.						
기타사항		*호텔 싱글 이용시 1인 3박당 ￥23,000 추가 요금 발생됩니다. (1룸 이상 발생시 문의 부탁드립니다.)						
		*면세점 1회 방문 기준입니다.						
		*환율은 변동 환율 기준입니다.						
		*현지사정에 의해 상기일정 및 호텔 순서 및 일정은 변경될 수 있습니다. 				

`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });
    const allContent = result.days.flatMap((day) => day.items.map((item) => item.content));
    const allDetail = result.days.flatMap((day) => day.items.flatMap((item) => item.detail ? [item.detail] : []));

    expect(result.days).toHaveLength(4);
    expect(result.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4]);
    expect(allContent.every((text) => !text.includes("DATE"))).toBe(true);
    expect(allContent.every((text) => !text.includes("항목"))).toBe(true);
    expect(allContent.every((text) => !text.includes("TOUR FEE"))).toBe(true);
    expect(allContent.every((text) => !text.includes("1899"))).toBe(true);
    expect(allDetail.every((text) => !text.includes("1899"))).toBe(true);
    expect(allContent.some((text) => text.includes("인천 국제 공항 3층 집결 및 가이드 미팅"))).toBe(true);
    expect(allContent.some((text) => text.includes("호텔 체크인 후 석식 및 휴식"))).toBe(true);
    expect(allContent.some((text) => text.includes("신치토세 공항 도착"))).toBe(true);
    expect(result.overview.travelPeriod.start).toBe("2026-02-28");
  });

  it("keeps schedule body dates from expanding travel period in pasted itinerary blocks", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `
1일차
2025. 02. 28.
항목구분 | 싱가포르 | 항공 | 10:30 | 신치토세 공항 도착
2일차
2025. 03. 01.
항목구분 | 싱가포르 | 항공 | 10:30 | 후라노 이동
3일차
2025. 03. 02.
항목구분 | 싱가포르 | 항공 | 10:30 | 오타루 이동
4일차
2025. 03. 03.
항목구분 | 싱가포르 | 항공 | 10:30 | 삿포로 이동
5일차
2025. 03. 04.
항목구분 | 싱가포르 | 항공 | 10:30 | 신치토세 공항 출발
2025. 03. 20.
2025. 03. 21.
2025. 03. 22.
2025. 04. 10.
`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });

    expect(result.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4, 5]);
    expect(result.overview.travelPeriod).toEqual({
      start: "2025-02-28",
      end: "2025-03-04",
    });
  });

  it("uses table headers when available and ignores standalone body dates for period window", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `[견적서] CTS 3박4일
DATE|CITY|TRSFT|TIME|ITINERARY|MEALS
제1일|싱가포르|전용버스||인천 국제 공항 3층 집결 및 가이드 미팅|
2/28||BX|12:35|신치토세 공항 도착|
|신치토세|전용버스|15:30|신치토세 공항 도착|L: 현지식
|후라노|전용버스|16:20|후라노 이동.|
제2일|조잔케이|전용버스||호텔 조식 후|B:호텔식
03/01||전용버스|09:00|오타루 이동.|
03/10||전용버스|09:30|오도리 공원 이동.|
`;

    const result = await parseItineraryByAi({ rawText, title: "직접입력 일정" });

    expect(result.days.map((day) => day.dayNo)).toEqual([1, 2]);
    const currentYear = String(currentYearInKorea());
    expect(result.overview.travelPeriod).toEqual({
      start: `${currentYear}-02-28`,
      end: `${currentYear}-03-01`,
    });
    const allContents = result.days.flatMap((day) => day.items.map((item) => item.content));
    expect(allContents.some((text) => text.includes("신치토세 공항 도착"))).toBe(true);
    expect(allContents).toContain("오타루 이동.");
  });

  it("parses attachment-style spreadsheet text without leaking metadata and object noise", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const { spreadsheetRowsToText } = await import("@/lib/itinerary/spreadsheetText");
    const rawText = spreadsheetRowsToText([
      ["[견적서] CTS 3박4일", undefined, undefined, undefined, "[견적서] CTS 3박4일"],
      ["ATTN :", undefined, undefined, undefined, undefined, undefined],
      ["FROM", undefined, undefined, undefined, "2025-01-31", undefined],
      ["DATE", "CITY", "TRSFT", "TIME", "ITINERARY", "MEALS"],
      ["제1일", "인천", undefined, undefined, "인천 국제 공항 3층 집결 및 가이드 미팅", undefined],
      ["2/28", undefined, "BX", "12:35", "인천 국제 공항 출발", undefined],
      [undefined, "신치토세", "전용버스", "15:30", "신치토세 공항 도착", "L: 불포함"],
      [undefined, "조잔케이", undefined, undefined, "조잔케이 이동.", undefined],
      [undefined, undefined, undefined, undefined, "HOTEL", "조잔케이 뷰 호텔 (2인1실/ 화실 또는 양실 기준)"],
      [undefined, undefined, undefined, undefined, { text: "https", hyperlink: "https://www.jozankeiview.com/" }, undefined],
      ["제2일", "조잔케이", "전용버스", undefined, "호텔 조식 후", "B:호텔식"],
      [undefined, "후라노", undefined, undefined, "후라노 이동.", undefined],
      [undefined, undefined, undefined, undefined, { error: "#VALUE!" }, undefined],
      [undefined, "비에이", undefined, undefined, "비에이 이동.", "(오무카레정식)"],
      [undefined, "소운쿄", undefined, undefined, "소운쿄 이동.", undefined],
      [undefined, undefined, undefined, undefined, "HOTEL", "소운쿄 다이세츠 호텔 (2인1실/ 화실 또는 양실 기준) | D: 호텔식"],
      [undefined, undefined, undefined, undefined, { text: "https", hyperlink: "https://www.hotel-taisetsu.com/" }, "(뷔페식)"],
      ["제3일", "소운쿄", "전용버스", undefined, "호텔 조식 후", "B:호텔식"],
      [undefined, "오타루", undefined, undefined, "오타루 이동.", undefined],
      [undefined, undefined, undefined, undefined, { error: "#VALUE!" }, undefined],
      [undefined, "삿포로", undefined, undefined, "삿포로 이동.", "(규카츠 정식)"],
      [undefined, undefined, undefined, undefined, "호텔 체크인 후 휴식", "D: 현지식"],
      [undefined, undefined, undefined, undefined, "HOTEL", "삿포로 프린스 호텔 (2인1실/ 양실기준)"],
      [undefined, undefined, undefined, undefined, { text: "https", hyperlink: "https://www.princehotels.co.jp/sapporo/" }, undefined],
      ["제4일", "삿포로", "전용버스", undefined, "호텔 조식 후", "B:호텔식"],
      [undefined, "치토세", undefined, undefined, "치토세 공항 이동.(약 1시간 소요)", "L: 현지식"],
      [undefined, undefined, undefined, undefined, "신치토세 공항 도착 후 출국 수속", "(스프카레)"],
      [undefined, undefined, "BX", "16:30", "신치토세 국제 공항 출발", undefined],
      [undefined, "인천", undefined, "20:10", "인천 국제 공항 도착", undefined],
      ["TOUR FEE (1인 지상비)", undefined, undefined, undefined, "8명 + 1 드라이빙 가이드", undefined],
      [undefined, undefined, "02월 28일", undefined, "¥101,000", undefined],
      ["참고 사항", undefined, "*현지 호텔은 미수배 상태입니다.", undefined, undefined, undefined],
      ["포함사항", undefined, "*현지 드라이빙 가이드 조건입니다.", undefined, undefined, undefined],
      [undefined, undefined, "*가이드 &기사 팁 포함(성인, 아동 동일 ￥4,000)입니다.", undefined, undefined, undefined],
      [undefined, undefined, "*전용버스 4일, 중식(현지식 3회), 석식(현지식 2회+호텔식 1회), 명시된 관광지 입장료는 포함입니다.", undefined, undefined, undefined],
      ["불포함사항", undefined, "*해외여행자보험 불포함입니다.", undefined, undefined, undefined],
      [undefined, undefined, "*항공료 및 텍스&유류 할증료 기타 개인 경비 불포함 조건입니다.", undefined, undefined, undefined],
      ["기타사항", undefined, "*면세점 1회 방문 기준입니다.", undefined, undefined, undefined],
      [undefined, undefined, "*환율은 변동 환율 기준입니다.", undefined, undefined, undefined],
    ]);

    const result = await parseItineraryByAi({ rawText, title: "CTS 3박4일" });
    const allContents = result.days.flatMap((day) => day.items.map((item) => item.content));
    const allDetails = result.days.flatMap((day) => day.items.flatMap((item) => item.detail ? [item.detail] : []));
    const joined = [...allContents, ...allDetails].join("\n");
    const dayOneMeals = result.days[0]?.items.filter((item) => item.type === "MEAL") ?? [];
    const dayTwoMeals = result.days[1]?.items.filter((item) => item.type === "MEAL") ?? [];
    const dayThreeMeals = result.days[2]?.items.filter((item) => item.type === "MEAL") ?? [];

    expect(result.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4]);
    expect(result.overview.travelPeriod.end).toBe(result.days[3]?.date);
    expect(allContents).toContain("인천 국제 공항 3층 집결 및 가이드 미팅");
    expect(allContents).toContain("인천 국제 공항 출발");
    expect(allContents.some((text) => text.includes("신치토세 공항 도착"))).toBe(true);
    expect(allContents).toContain("후라노 이동.");
    expect(allContents).toContain("인천 국제 공항 도착");
    expect(allContents).toContain("조잔케이 뷰 호텔 (2인1실/ 화실 또는 양실 기준)");
    expect(allContents).not.toContain("호텔");
    expect(allContents).not.toContain("HOTEL");
    expect(dayOneMeals.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("불포함");
    expect(dayTwoMeals.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(dayTwoMeals.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("호텔식");
    expect(dayThreeMeals.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("현지식");
    expect(joined).not.toContain("ATTN");
    expect(joined).not.toContain("FROM");
    expect(joined).not.toContain("[견적서]");
    expect(joined).not.toContain("[object Object]");
    expect(joined).not.toContain("https");
    expect(joined).not.toContain("TOUR FEE");
    expect(joined).not.toContain("참고 사항");
    expect(joined).not.toContain("8명 + 1");
    expect(joined).not.toContain("101000");
    expect(joined).not.toContain("현지 호텔은 미수배");
    expect(joined).not.toContain("해외여행자보험");
    expect(joined).not.toContain("환율은 변동");
  });

  it("keeps post-meal schedule text out of meal values", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `DATE\tCITY\tTRSFT\tTIME\tITINERARY\tMEALS
제2일\t싱가포르\t전용버스\t\t식사 구분\t조식\t후
\t싱가포르\t전용버스\t14:00\t식사 구분\t중식\t후 싱가포르 국립박물관 견학
\t싱가포르\t전용버스\t\t식사 구분\t석식\t후 싱가포르 랜드마크 머라이언 공원 및 에스플러네이드 외관 견학`;

    const result = await parseItineraryByAi({ rawText, title: "식사 테스트" });
    const items = result.days[0]?.items ?? [];
    const meals = items.filter((item) => item.type === "MEAL");
    const contents = items.map((item) => item.content);

    expect(meals.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("조식");
    expect(meals.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("중식");
    expect(meals.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("석식");
    expect(contents).not.toContain("후");
    expect(contents).not.toContain("후 싱가포르 국립박물관 견학");
    expect(contents).toContain("싱가포르 국립박물관 견학");
    expect(contents).toContain("싱가포르 랜드마크 머라이언 공원 및 에스플러네이드 외관 견학");
  });

  it("parses meal values from the trailing meal column in headerless tabular schedules", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `제2일\t싱가포르\t전용버스\t호텔조식후\t조:호텔식
04월 28일\t\t\t오전 자유일정 후 가이드 미팅 (10:30 예정)\t
(화)\t\t\t유네스코 지정 싱가포르 국립식물원 보타닉가든 견학 \t중:키세키일식부풰
\t\t\t중식 후 싱가포르 국립박물관 견학 (14:00 예정)\t
\t\t\t싱가포르 도시개발청 URA 시티갤러리 견학\t석:송파바쿠테
\t\t\t싱가포르 차이나타운 견학\t
\t\t\t가든스 바이 더 베이 2돔 (Jurassic World 포함) 견학\t
\t\t\t석식 후 싱가포르 랜드마크 머라이언 공원 및 에스플러네이드 외관 견학\t
\t\t\t슈퍼트리 랩소디 야경쇼 관람 (19:45 예정)\t
\t\t\t리버보트 탑승하여 싱가포르 야경 관람 후 호텔 복귀 및 휴식\t
\t\t\tHOTEL - Aloft Singapore Novena - Urban Room 3박\t`;

    const result = await parseItineraryByAi({ rawText, title: "싱가포르 테스트" });
    const items = result.days[0]?.items ?? [];
    const meals = items.filter((item) => item.type === "MEAL");
    const contents = items.map((item) => item.content);

    expect(meals.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(meals.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("키세키일식부풰");
    expect(meals.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("송파바쿠테");
    expect(contents).toContain("유네스코 지정 싱가포르 국립식물원 보타닉가든 견학");
    expect(contents).toContain("싱가포르 국립박물관 견학 ( 예정)");
    expect(contents).toContain("Aloft Singapore Novena - Urban Room 3박");
    expect(contents).not.toContain("호텔");
  });

  it("parses meal values when meal markers and names are split across adjacent cells", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `제 04일\t사마르칸트\t\t\t호텔 조식 후\t\t조:\t호텔식
3/20(목)\t\t\t\t오늘날 가장 뛰어난 동양건축물의 집결체 레기스탄 광장\t\t중:\t현지식
\t\t\t\t<울루그백 마드라사, 티라카리 마드라사, 셰르다르 마드라사>\t\t석:\t한   식
\t\t\t\t기차역 이동\t\t\t
\t\t아프로시압\t16:51\t사마르칸트 출발\t\t\t
\t타슈켄트\t\t19:17\t타슈켄트 도착\t\t\t
\t\t\t\t석식 후 호텔 투숙\t\t\t
\t\t\t\t숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*\t\t\t`;

    const result = await parseItineraryByAi({ rawText, title: "우즈베키스탄 테스트" });
    const items = result.days[0]?.items ?? [];
    const meals = items.filter((item) => item.type === "MEAL");
    const transfers = items.filter((item) => item.type === "TRANSFER");

    expect(meals.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(meals.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
    expect(meals.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("한 식");
    expect(meals.find((item) => item.mealSlot === "dinner")?.content).not.toBe("호텔 투숙");
    expect(transfers.find((item) => item.content.includes("사마르칸트 출발"))?.time).toBe("16:51");
    expect(transfers.find((item) => item.content.includes("타슈켄트 도착"))?.time).toBe("19:17");
    expect(items.find((item) => item.type === "ACCOMMODATION")?.content).toContain("LOTTE CITY HOTEL TASHKENT PALAE");
  });

  it("keeps sightseeing rows after split meal columns in headerless tabular schedules", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `제 02일\t타슈켄트\t\t\t호텔 조식 후\t\t조:\t호텔식
3/18(화)\t\t\t10:00\t가이드 미팅  \t\t중:\t현지식
\t\t\t\t타슈켄트에서 유명한 화이트 모스크 미노르 모스크\t\t석:\t현지식
\t\t\t\t구시가지에 위치한 타슈켄트 종교 중심지 하자티 이맘 광장\t\t\t
\t\t\t\t우즈베키스탄 전통시장 초르수 바자르\t\t\t
\t\t\t\t타슈켄트 최고의 번화가 브로드 웨이\t\t\t
\t\t\t\t세계정복을 꿈꿨던 아무르 티무르의 동상이 있는 아무르 티무르 과장\t\t\t
\t\t\t\t석식 및 호텔 투숙\t\t\t
\t\t\t\t숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*\t\t\t`;

    const result = await parseItineraryByAi({ rawText, title: "타슈켄트 테스트" });
    const day = result.days.find((entry) => entry.dayNo === 2);
    const items = day?.items ?? [];
    const contents = items.map((item) => item.content);

    expect(items.find((item) => item.content === "가이드 미팅")?.time).toBe("10:00");
    expect(contents).toContain("타슈켄트에서 유명한 화이트 모스크 미노르 모스크");
    expect(contents).toContain("구시가지에 위치한 타슈켄트 종교 중심지 하자티 이맘 광장");
    expect(contents).toContain("우즈베키스탄 전통시장 초르수 바자르");
    expect(contents).toContain("타슈켄트 최고의 번화가 브로드 웨이");
    expect(contents).toContain("세계정복을 꿈꿨던 아무르 티무르의 동상이 있는 아무르 티무르 과장");
    expect(contents).toContain("LOTTE CITY HOTEL TASHKENT PALAE 4*");
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
    expect(items.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("현지식");
  });

  it("parses full Korean meal labels with colon in sparse tabular schedules", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `제 2 일\t\t전용차량\t\t 호텔 조식 후\t\t\t\t\t\t\t조식 : 호텔식\t
\t싱가폴 \t\t\t국립식물원 및 오차드로드\t\t\t\t\t\t\t\t
\t \t\t\t중식 칠리크랩\t\t\t\t\t\t\t중식 :칠리크랩\t
\t \t\t\t가든스 바이 더 베이 -클라우돔, 플라워돔 \t\t\t\t\t\t\t\t
\t\t\t\t석식 페라나칸\t\t\t\t\t\t\t석식 :페라나칸\t
\t\t\t\t가든스 바이 더 베이 랩소디쇼\t\t\t\t\t\t\t\t
\t \t\t\t\t 호텔 투숙 및 휴식\t\t\t\t\t\t\t\t`;

    const result = await parseItineraryByAi({ rawText, title: "싱가폴 식사 테스트" });
    const day = result.days.find((entry) => entry.dayNo === 2);
    const items = day?.items ?? [];
    const meals = items.filter((item) => item.type === "MEAL");
    const contents = items.map((item) => item.content);

    expect(meals.map((item) => item.mealSlot)).toEqual(["breakfast", "lunch", "dinner"]);
    expect(meals.map((item) => item.content)).toEqual(["호텔식", "칠리크랩", "페라나칸"]);
    expect(contents).not.toContain("중식 칠리크랩");
    expect(contents).not.toContain("석식 페라나칸");
    expect(contents).toContain("국립식물원 및 오차드로드");
    expect(contents).toContain("가든스 바이 더 베이 -클라우돔, 플라워돔");
  });

  it("keeps each row under the day where it appears in multi-day tabular schedules", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `제 01일\t인천\t항공\t10:00\t인천 출발\t\t조:\t불포함
\t타슈켄트\t전용버스\t15:00\t타슈켄트 도착 후 시내 관광\t\t중:\t기내식
\t\t\t\t숙 소 : DAY ONE HOTEL\t\t석:\t현지식
제 02일\t사마르칸트\t전용버스\t\t호텔 조식 후 사마르칸트 이동\t\t조:\t호텔식
\t\t\t\t레기스탄 광장 관광\t\t중:\t현지식
\t\t아프로시압\t16:51\t사마르칸트 출발\t\t\t
\t타슈켄트\t\t19:17\t타슈켄트 도착\t\t\t
\t\t\t\t숙 소 : DAY TWO HOTEL\t\t석:\t한식`;

    const result = await parseItineraryByAi({ rawText, title: "멀티데이 테스트" });
    const dayOne = result.days.find((day) => day.dayNo === 1);
    const dayTwo = result.days.find((day) => day.dayNo === 2);
    const dayOneContents = dayOne?.items.map((item) => item.content) ?? [];
    const dayTwoContents = dayTwo?.items.map((item) => item.content) ?? [];

    expect(dayOneContents.some((content) => content.includes("인천 출발"))).toBe(true);
    expect(dayOneContents.some((content) => content.includes("타슈켄트 도착 후 시내 관광"))).toBe(true);
    expect(dayOneContents).toContain("DAY ONE HOTEL");
    expect(dayOneContents).not.toContain("레기스탄 광장 관광");
    expect(dayOneContents).not.toContain("DAY TWO HOTEL");
    expect(dayTwoContents.some((content) => content.includes("사마르칸트 이동"))).toBe(true);
    expect(dayTwoContents.some((content) => content.includes("레기스탄 광장 관광"))).toBe(true);
    expect(dayTwoContents).toContain("DAY TWO HOTEL");
    expect(dayTwoContents).not.toContain("DAY ONE HOTEL");
    expect(dayTwo?.items.find((item) => item.content.includes("사마르칸트 출발"))?.time).toBe("16:51");
    expect(dayTwo?.items.find((item) => item.content.includes("타슈켄트 도착"))?.time).toBe("19:17");
  });

  it("ignores date cells while preserving itinerary text in the same row", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `4\tThu Mar 20 2025 09:00:00 GMT+0900 (Korean Standard Time)\t사마르칸트\t\t호텔 조식 후\t\t조:\t호텔식
\t3/20(목)\t\t\t오늘날 가장 뛰어난 동양건축물의 집결체 레기스탄 광장\t\t중:\t현지식
\t\t\t\t<울루그백 마드라사, 티라카리 마드라사, 셰르다르 마드라사>\t\t석:\t한 식
\t\t\t\t중앙아시아 최대의 모스크로 손꼽히는 비비하놈 모스크등\t\t\t
\t\t\t\t숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*\t\t\t`;

    const result = await parseItineraryByAi({ rawText, title: "우즈베키스탄 날짜셀 테스트" });
    const day = result.days.find((entry) => entry.dayNo === 4);
    const contents = day?.items.map((item) => item.content) ?? [];

    expect(contents.some((content) => content.includes("Thu Mar"))).toBe(false);
    expect(contents.some((content) => content.includes("3/20"))).toBe(false);
    expect(contents.some((content) => content.includes("레기스탄 광장"))).toBe(true);
    expect(contents.some((content) => content.includes("울루그백 마드라사"))).toBe(true);
    expect(contents.some((content) => content.includes("비비하놈 모스크"))).toBe(true);
    expect(contents).toContain("LOTTE CITY HOTEL TASHKENT PALAE 4*");
  });

  it("extracts OCR quote metadata and removes hotel label-only schedule rows", async () => {
    process.env.OPENAI_API_KEY = "";

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const rawText = `단체명 | 상해항주황산 20+2 견적용
여행시작일 | 2026.04.28
여행종료일 | 2026.05.02
항공편 정보 | KE2229 08:35/09:40
포함내역 | 왕복항공권 / 전 일정 호텔 / 전용차량
불포함내역 | 개인경비 / 매너팁
1일차 | 2026. 04. 28. | 상해 | KE2229 전용차 | 08:35 | 운동장 출발 / 김해공항 도착 후 출국수속
1일차 | 식사 구분 | 조식 | 한식
1일차 | 이동 | 김해공항 출발 / 상해행 항공 도착 (비행)
1일차 | 관광 | 오산상황관광
1일차 | 관광 | 송가고택관광
1일차 | 기타 | 호텔 체크-인 및 휴식
1일차 | Hotel | Hampton by Hilton (2인실) TEL:+86-571-8510-5888`;

    const result = await parseItineraryByAi({ rawText, title: "0405상해항주황산 20+2 견적용" });
    const dayOneContents = result.days[0]?.items.map((item) => item.content) ?? [];
    const accommodationItems = result.days[0]?.items.filter((item) => item.type === "ACCOMMODATION") ?? [];

    expect(result.header.groupName).toBe("상해항주황산 20+2 견적용");
    expect(result.overview.travelPeriod).toEqual({
      start: "2026-04-28",
      end: "2026-05-02",
    });
    expect(result.basics.flight.departure).toBe("KE2229 08:35/09:40");
    expect(result.basics.included).toBe("왕복항공권 / 전 일정 호텔 / 전용차량");
    expect(result.basics.excluded).toBe("개인경비 / 매너팁");
    expect(dayOneContents).not.toContain("Hotel");
    expect(dayOneContents).toContain("호텔 체크-인 및 휴식");
    expect(accommodationItems.map((item) => item.hotel ?? item.content)).toContain("Hampton by Hilton (2인실) TEL:+86-571-8510-5888");
  });
});

describe("parseItineraryByAi AI pipeline", () => {
  it("runs structural analysis before strict JSON generation and recalculates day dates on the server", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role: string; content: string }>;
        response_format?: { type: string };
      };
      const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";
      calls.push(lastMessage);

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: 다낭 테스트 3일
출발일: 2026-06-02
기간: 2026-06-02 ~ 2026-06-04
요금: 성인 610000

[일차별 일정]
1일차 | TRANSFER | 인천공항 출발 |  | 10:00 |
2일차 | SIGHTSEEING | 아오이 이케 |  |  |
3일차 | TRANSFER | 인천공항 도착 |  | 20:00 |`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                header: { groupName: null, writtenAt: null },
                overview: {
                  travelPeriod: { start: "2026-06-02", end: "2026-06-04" },
                  fare: { adultPerPerson: "610,000" },
                },
                basics: {
                  shoppingCenters: null,
                },
                days: [
                  {
                    dayNo: 1,
                    date: "1899-12-31",
                    items: [{ type: "TRANSFER", content: "인천공항 출발", time: "10:00" }],
                  },
                  {
                    dayNo: 2,
                    date: "1899-12-31",
                    items: [{ type: "SIGHTSEEING", content: "아오이 이케", detail: null }],
                  },
                  {
                    dayNo: 3,
                    date: "1899-12-31",
                    items: [{ type: "TRANSFER", content: "인천공항 도착", time: "20:00" }],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryByAi } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryByAi({
      rawText: "기간 2026-06-02 ~ 2026-06-04\n1일차 인천공항 출발\n2일차 아오이 이케 관광\n3일차 인천공항 도착",
      title: "다낭 테스트 3일",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[0]).toContain("[원문]");
    expect(calls[1]).toContain("[AI 분석 결과]");
    expect(calls[1]).not.toContain("[원문]");
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
    ]);
    expect(result.overview.fare.adultPerPerson).toBe(610000);
    expect(result.basics.shoppingCenters).toBe(0);
    expect(result.days[1]?.items[0]?.content).toBe("아오이 이케");
  });

  it("skips AI when the deterministic parser already has strong dated coverage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText: `항공 출발: TW407 인천 출발 11:05 / 바르셀로나 도착 19:00
항공 귀국: TW408 바르셀로나 출발 21:00 / 인천 도착 16:25
차량: 전용버스
*1일차*
2026-04-17
- 이동 | 인천국제공항 도착
- 이동 | 인천 출발
- 숙박 | 4성급 호텔
*2일차*
2026-04-18
- 이동 | 몬세라트로 이동
- 관광 | 몬세라트 수도원
- 숙박 | 4성급 호텔
*3일차*
2026-04-19
- 관광 | 프라도 미술관 탐방
- 이동 | 똘레도 이동
- 숙박 | 4성급 호텔`,
      title: "PDF 기본 파서 우선 테스트",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.diagnostics.source).toBe("fallback-tabular");
    expect(result.diagnostics.aiAttempted).toBe(false);
    expect(result.diagnostics.qualityScore).toBeGreaterThanOrEqual(70);
    expect(result.itinerary.overview.travelPeriod).toEqual({
      start: "2026-04-17",
      end: "2026-04-19",
    });
    expect(result.itinerary.basics.flight.departure).toContain("TW407");
    expect(result.itinerary.days).toHaveLength(3);
  });

  it("keeps high-detail image OCR table rows as a deterministic itinerary", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const rawText = jangjiajieHighDetailOcrText();

    const result = await parseItineraryWithDiagnostics({
      rawText,
      title: "50+1 김해장가계 260525 제주항공 견적 체크",
    });

    expect(result.diagnostics.source).toBe("fallback-no-key");
    expect(result.diagnostics.dateSource).toBe("filename");
    expect(result.itinerary.overview.travelPeriod).toEqual({
      start: "2026-05-25",
      end: "2026-05-28",
    });
    expect(result.itinerary.days).toHaveLength(4);
    expect(result.itinerary.days[1]?.items.some((item) => item.content.includes("보봉호수"))).toBe(true);
    expect(result.itinerary.days[1]?.items.some((item) => item.hotel?.includes("블루베이 호텔"))).toBe(true);
    expect(result.itinerary.days[3]?.items.some((item) => item.content.includes("장가계 국제공항 도착"))).toBe(true);
  });

  it("prefers deterministic table rows over sparse AI image parse output", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: [
                  "[AI 분석 결과]",
                  "[일차별 일정]",
                  "1일차 | TRANSFER | 인천공항 출발 |  | 10:00 |",
                  "2일차 | SIGHTSEEING | 보봉호수 유람선 |  |  |",
                  "3일차 | SIGHTSEEING | 저항동굴 활동동굴 |  |  |",
                  "4일차 | SIGHTSEEING | 군성사석화 박물관 |  |  |",
                ].join("\n"),
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                days: [
                  { dayNo: 1, items: [{ type: "TRANSFER", content: "인천공항 출발", time: "10:00" }] },
                  { dayNo: 2, items: [{ type: "SIGHTSEEING", content: "보봉호수 유람선" }] },
                  { dayNo: 3, items: [{ type: "SIGHTSEEING", content: "저항동굴 활동동굴" }] },
                  { dayNo: 4, items: [{ type: "SIGHTSEEING", content: "군성사석화 박물관" }] },
                ],
                overview: {
                  travelPeriod: { start: "2026-05-25", end: "2025-05-28" },
                },
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText: jangjiajieHighDetailOcrText(),
      title: "50+1 김해장가계 260525 제주항공 견적 체크",
    });

    expect(result.diagnostics.source).toBe("fallback-tabular");
    expect(result.itinerary.overview.travelPeriod).toEqual({
      start: "2026-05-25",
      end: "2026-05-28",
    });
    expect(result.itinerary.days).toHaveLength(4);
    expect(result.itinerary.days[0]?.items.some((item) => item.content.includes("인천공항"))).toBe(false);
    expect(result.itinerary.days[0]?.items.some((item) => item.content.includes("부산 김해국제공항 출발"))).toBe(true);
    expect(result.itinerary.days[1]?.items.length).toBeGreaterThan(5);
    expect(result.itinerary.days[1]?.items.some((item) => item.hotel?.includes("블루베이 호텔"))).toBe(true);
  });

  it("passes extracted meal and hotel evidence to the AI analysis step", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const analysisPrompts: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role: string; content: string }>;
        response_format?: { type: string };
      };
      const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";

      if (!body.response_format) {
        analysisPrompts.push(lastMessage);
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: 싱가포르 증거 테스트
출발일: 2025-04-28

[일차별 일정]
2일차 | MEAL | 키세키일식부풰 |  |  | lunch
2일차 | ACCOMMODATION | Aloft Singapore Novena - Urban Room 3박 |  |  |`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2025-04-28", end: "2025-04-28" } },
                days: [
                  {
                    dayNo: 2,
                    items: [
                      { type: "MEAL", mealSlot: "lunch", content: "키세키일식부풰" },
                      {
                        type: "ACCOMMODATION",
                        content: "Aloft Singapore Novena - Urban Room 3박",
                        hotel: "Aloft Singapore Novena - Urban Room 3박",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rawText = `제2일\t싱가포르\t전용버스\t호텔조식후\t조:호텔식
\t\t\t유네스코 지정 싱가포르 국립식물원 보타닉가든 견학 \t중:키세키일식부풰
\t\t\tHOTEL - Aloft Singapore Novena - Urban Room 3박\t`;

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({ rawText, title: "싱가포르 증거 테스트" });

    expect(analysisPrompts[0]).toContain("[코드 추출 evidence]");
    expect(analysisPrompts[0]).toContain("kind=meal");
    expect(analysisPrompts[0]).toContain("slot=lunch");
    expect(analysisPrompts[0]).toContain("키세키일식부풰");
    expect(analysisPrompts[0]).toContain("kind=hotel");
    expect(analysisPrompts[0]).toContain("Aloft Singapore Novena");
    expect(result.diagnostics.evidenceCounts?.certain).toBeGreaterThanOrEqual(3);
  });

  it("supplements day-level hotels from fallback rows when AI omits later accommodation items", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: CTS 3박4일
출발일: 2026-02-28

[일차별 일정]
1일차 | TRANSFER | 인천 국제 공항 출발 |  | 12:35 |
1일차 | ACCOMMODATION | 조잔케이 뷰 호텔 |  |  |
2일차 | SIGHTSEEING | 후라노 이동 |  |  |
3일차 | SIGHTSEEING | 오타루 이동 |  |  |`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2026-02-28", end: "2026-03-03" } },
                days: [
                  {
                    dayNo: 1,
                    items: [
                      { type: "TRANSFER", content: "인천 국제 공항 출발", time: "12:35" },
                      { type: "ACCOMMODATION", content: "조잔케이 뷰 호텔", hotel: "조잔케이 뷰 호텔" },
                    ],
                  },
                  { dayNo: 2, items: [{ type: "SIGHTSEEING", content: "후라노 이동" }] },
                  { dayNo: 3, items: [{ type: "SIGHTSEEING", content: "오타루 이동" }] },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rawText = `DATE|CITY|TRSFT|TIME|ITINERARY|MEALS
제1일|인천|BX|12:35|인천 국제 공항 출발|
||||HOTEL|조잔케이 뷰 호텔 (2인1실)
제2일|후라노|전용버스||후라노 이동|
||||HOTEL|소운쿄 다이세츠 호텔 (2인1실)
제3일|오타루|전용버스||오타루 이동|
||||HOTEL|삿포로 프린스 호텔 (2인1실)`;

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({ rawText, title: "CTS 3박4일" });
    const hotelByDay = new Map(
      result.itinerary.days.map((day) => [
        day.dayNo,
        day.items.filter((item) => item.type === "ACCOMMODATION").map((item) => item.hotel ?? item.content),
      ]),
    );

    expect(result.diagnostics.source).toBe("ai");
    expect(hotelByDay.get(1)?.join("\n")).toContain("조잔케이 뷰 호텔");
    expect(hotelByDay.get(2)?.join("\n")).toContain("소운쿄 다이세츠 호텔");
    expect(hotelByDay.get(3)?.join("\n")).toContain("삿포로 프린스 호텔");
  });

  it("corrects AI meal labels with fallback values from trailing meal columns", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: 싱가포르 테스트
출발일: 2025-04-28

[일차별 일정]
2일차 | MEAL | 호텔 |  |  |
2일차 | SIGHTSEEING | 오전 자유일정 후 가이드 미팅 |  | 10:30 |
2일차 | MEAL | 중식 |  | 14:00 |
2일차 | SIGHTSEEING | 싱가포르 도시개발청 URA 시티갤러리 견학 |  |  |
2일차 | SIGHTSEEING | 싱가포르 랜드마크 머라이언 공원 및 에스플러네이드 외관 견학 |  |  |
2일차 | MEAL | 석식 |  |  |
2일차 | SIGHTSEEING | 리버보트 탑승하여 싱가포르 야경 관람 후 호텔 복귀 및 휴식 |  |  |`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2025-04-28", end: "2025-04-28" } },
                days: [
                  {
                    dayNo: 1,
                    date: "2025-04-28",
                    items: [
                      { type: "MEAL", mealSlot: "breakfast", content: "호텔" },
                      { type: "SIGHTSEEING", content: "오전 자유일정 후 가이드 미팅", time: "10:30" },
                      { type: "MEAL", mealSlot: "lunch", content: "중식", time: "14:00" },
                      { type: "SIGHTSEEING", content: "싱가포르 도시개발청 URA 시티갤러리 견학" },
                      { type: "SIGHTSEEING", content: "싱가포르 랜드마크 머라이언 공원 및 에스플러네이드 외관 견학" },
                      { type: "MEAL", mealSlot: "dinner", content: "석식" },
                      { type: "SIGHTSEEING", content: "리버보트 탑승하여 싱가포르 야경 관람 후 호텔 복귀 및 휴식" },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rawText = `제2일\t싱가포르\t전용버스\t호텔조식후\t조:호텔식
04월 28일\t\t\t오전 자유일정 후 가이드 미팅 (10:30 예정)\t
(화)\t\t\t유네스코 지정 싱가포르 국립식물원 보타닉가든 견학 \t중:키세키일식부풰
\t\t\t중식 후 싱가포르 국립박물관 견학 (14:00 예정)\t
\t\t\t싱가포르 도시개발청 URA 시티갤러리 견학\t석:송파바쿠테
\t\t\t석식 후 싱가포르 랜드마크 머라이언 공원 및 에스플러네이드 외관 견학\t
\t\t\tHOTEL - Aloft Singapore Novena - Urban Room 3박\t`;

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({ rawText, title: "싱가포르 테스트" });
    const items = result.itinerary.days[0]?.items ?? [];
    const meals = items.filter((item) => item.type === "MEAL");
    const hotels = items.filter((item) => item.type === "ACCOMMODATION");

    expect(result.diagnostics.source).toBe("fallback-tabular");
    expect(meals.find((item) => item.mealSlot === "breakfast")?.content).toBe("호텔식");
    expect(meals.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(meals.find((item) => item.mealSlot === "lunch")?.content).toBe("키세키일식부풰");
    expect(meals.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("키세키일식부풰");
    expect(meals.find((item) => item.mealSlot === "dinner")?.content).toBe("송파바쿠테");
    expect(meals.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("송파바쿠테");
    expect(hotels.map((item) => item.hotel ?? item.content).join("\n")).toContain("Aloft Singapore Novena");
  });

  it("keeps AI results when they are much richer than the tabular fallback", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };
      const aiItems = Array.from({ length: 25 }, (_, index) => ({
        type: "SIGHTSEEING",
        content: `AI 전용 일정 ${index + 1}`,
      }));

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: aiItems
                  .map((item, index) => `1일차 | ${item.type} | ${item.content} | | ${String(9 + index).padStart(2, "0")}:00 |`)
                  .join("\n"),
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2026-04-28", end: "2026-04-28" } },
                days: [
                  {
                    dayNo: 1,
                    date: "2026-04-28",
                    items: aiItems,
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rawText = `제1일\t타슈켄트\t전용버스\t09:00\t기본 파서 일정 1
\t\t\t10:00\t기본 파서 일정 2
\t\t\t11:00\t기본 파서 일정 3
\t\t\t12:00\t기본 파서 일정 4
\t\t\t13:00\t기본 파서 일정 5
\t\t\t14:00\t기본 파서 일정 6
\t\t\t15:00\t기본 파서 일정 7
\t\t\t16:00\t기본 파서 일정 8
\t\t\t17:00\t기본 파서 일정 9`;

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({ rawText, title: "풍부한 AI 결과 테스트" });
    const contents = result.itinerary.days.flatMap((day) => day.items.map((item) => item.content));

    expect(result.diagnostics.source).toBe("ai");
    expect(result.diagnostics.aiMeaningfulItemCount).toBeGreaterThanOrEqual(25);
    expect(result.diagnostics.fallbackMeaningfulItemCount).toBe(9);
    expect(contents).toContain("AI 전용 일정 25");
    expect(contents).not.toContain("기본 파서 일정 9");
  });

  it("uses raw tabular meals and hotels when keeping richer AI schedules", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };
      const dayOneItems = [
        { type: "TRANSFER", content: "인천 출발", time: "16:35" },
        { type: "TRANSFER", content: "타슈켄트 도착", time: "20:40" },
        { type: "MEAL", mealSlot: "breakfast", content: "호텔식" },
        { type: "MEAL", mealSlot: "lunch", content: "현지식" },
        { type: "MEAL", mealSlot: "dinner", content: "현지식" },
        { type: "ACCOMMODATION", content: "LOTTE CITY HOTEL TASHKENT PALAE" },
      ];
      const dayTwoItems = [
        { type: "SIGHTSEEING", content: "미노르 모스크" },
        { type: "SIGHTSEEING", content: "하자티 이맘 광장" },
        { type: "SIGHTSEEING", content: "초르수 바자르" },
        { type: "MEAL", mealSlot: "dinner", content: "현지식" },
        { type: "MEAL", mealSlot: "lunch", content: "현지식" },
        { type: "ACCOMMODATION", content: "LOTTE CITY HOTEL TASHKENT PALAE" },
      ];
      const extraItems = Array.from({ length: 14 }, (_, index) => ({
        type: "SIGHTSEEING",
        content: `AI 보강 일정 ${index + 1}`,
      }));

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: "AI 분석 결과",
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2025-03-17", end: "2025-03-18" } },
                days: [
                  { dayNo: 1, date: "2025-03-17", items: dayOneItems },
                  { dayNo: 2, date: "2025-03-18", items: [...dayTwoItems, ...extraItems] },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rawText = `일자(날짜)\t도  시\t교  통\t시  간 \t일                                      정 \t\t식   사\t
제 01일\t인천 \tOZ0573\t16:35\t인천 출발\t\t\t
3/17(월)\t타슈켄트\t\t20:40\t타슈켄트 도착\t\t\t
\t\t\t\t가이드 미팅 후 호텔 이동\t\t\t
\t\t\t\t호텔투숙\t\t\t
\t\t\t\t숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*\t\t\t
제 02일\t타슈켄트\t\t\t호텔 조식 후\t\t조:\t호텔식
3/18(화)\t\t\t10:00\t가이드 미팅\t\t중:\t현지식
\t\t\t\t미노르 모스크\t\t석:\t현지식
\t\t\t\t숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*\t\t\t`;

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({ rawText, title: "우즈베키스탄 테스트" });
    const dayOne = result.itinerary.days.find((day) => day.dayNo === 1);
    const dayTwo = result.itinerary.days.find((day) => day.dayNo === 2);
    const dayOneMeals = dayOne?.items.filter((item) => item.type === "MEAL") ?? [];
    const dayOneHotels = dayOne?.items.filter((item) => item.type === "ACCOMMODATION") ?? [];
    const dayTwoMeals = dayTwo?.items.filter((item) => item.type === "MEAL") ?? [];
    const dayTwoHotels = dayTwo?.items.filter((item) => item.type === "ACCOMMODATION") ?? [];

    expect(result.diagnostics.source).toBe("ai");
    expect(dayOneMeals).toHaveLength(0);
    expect(dayOneHotels.map((item) => item.content)).toEqual(["LOTTE CITY HOTEL TASHKENT PALAE 4*"]);
    expect(dayTwoMeals.map((item) => item.mealSlot)).toEqual(["breakfast", "lunch", "dinner"]);
    expect(dayTwoMeals.map((item) => item.content)).toEqual(["호텔식", "현지식", "현지식"]);
    expect(dayTwoHotels.map((item) => item.content)).toEqual(["LOTTE CITY HOTEL TASHKENT PALAE 4*"]);
  });

  it("salvages AI responses with nullable sections and Korean field aliases", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
1일차 | 관광 | 싱가포르 국립박물관 견학
1일차 | 식사 | 호텔식`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                header: null,
                overview: null,
                basics: null,
                일정: [
                  {
                    일차: "제1일",
                    날짜: "2025.04.28",
                    항목: [
                      { 항목구분: "관광", 내용: "싱가포르 국립박물관 견학" },
                      { 항목구분: "식사", 식사구분: "조식", 내용: "호텔식" },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText: "제1일 싱가포르\n싱가포르 국립박물관 견학\n조:호텔식",
      title: "AI 응답 보정 테스트",
    });
    const items = result.itinerary.days[0]?.items ?? [];

    expect(result.diagnostics.source).toBe("ai");
    expect(items.find((item) => item.type === "SIGHTSEEING")?.content).toBe("싱가포르 국립박물관 견학");
    expect(items.find((item) => item.type === "MEAL")?.meal?.breakfast).toBe("호텔식");
  });

  it("keeps AI schedule items when PDF-like JSON uses strings or detail-only items", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: PDF 일정 테스트
출발일: 2026-05-01

[일차별 일정]
1일차 | TRANSFER | 인천공항 출발 |  | 09:00 |
1일차 | SIGHTSEEING | 시내 관광 |  |  |
2일차 | ACCOMMODATION | 호텔 체크인 |  |  |`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2026-05-01", end: "2026-05-02" } },
                days: [
                  {
                    dayNo: 1,
                    items: [
                      "인천공항 출발",
                      { type: "SIGHTSEEING", detail: "시내 관광" },
                    ],
                  },
                  {
                    dayNo: 2,
                    items: [{ category: "숙박", 상세: "호텔 체크인" }],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText: "제1일 인천공항 출발 시내 관광\n제2일 호텔 체크인",
      title: "PDF 일정 테스트",
    });
    const contents = result.itinerary.days.flatMap((day) => day.items.map((item) => item.content));

    expect(result.diagnostics.source).toBe("ai");
    expect(contents).toContain("인천공항 출발");
    expect(contents).toContain("시내 관광");
    expect(contents.some((content) => content.includes("호텔 체크인"))).toBe(true);
  });

  it("preserves AI metadata when tabular fallback is selected for schedule rows", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: AI 상해항주황산
출발일: 2026-04-28
기간: 2026-04-28 ~ 2026-05-02
항공: 출발편 KE2229 08:35/09:40 / 귀국편 KE2230 18:00/20:30
포함: 왕복항공권 / 호텔
불포함: 개인경비

[일차별 일정]
1일차 | TRANSFER | 상해 도착 후 호텔 이동 |  | 09:40 |
2일차 | SIGHTSEEING | 서호 관광 |  | 10:00 |`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                header: { groupName: "AI 상해항주황산" },
                overview: {
                  travelPeriod: { start: "2026-04-28", end: "2026-05-02" },
                },
                basics: {
                  flight: {
                    departure: "KE2229 08:35/09:40",
                    arrival: "KE2230 18:00/20:30",
                  },
                  included: "왕복항공권 / 호텔",
                  excluded: "개인경비",
                },
                days: [
                  { dayNo: 1, items: [{ type: "TRANSFER", content: "상해 도착 후 호텔 이동", time: "09:40" }] },
                  { dayNo: 2, items: [{ type: "SIGHTSEEING", content: "서호 관광", time: "10:00" }] },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText: `DATE | CITY | TRSFT | TIME | ITINERARY
1일차 | 상해 | 전용버스 | 09:40 | 상해 도착 후 호텔 이동
1일차 | 상해 | 전용버스 | 12:00 | 중식 후 오산상황관광
2일차 | 항주 | 전용버스 | 10:00 | 서호 관광
2일차 | 항주 | 전용버스 | 14:00 | 송가고택관광`,
      title: "파일명 제목",
    });

    expect(result.diagnostics.source).toBe("fallback-tabular");
    expect(result.itinerary.header.groupName).toBe("AI 상해항주황산");
    expect(result.itinerary.overview.travelPeriod).toEqual({
      start: "2026-04-28",
      end: "2026-05-02",
    });
    expect(result.itinerary.basics.flight.departure).toBe("KE2229 08:35/09:40");
    expect(result.itinerary.basics.flight.arrival).toBe("KE2230 18:00/20:30");
    expect(result.itinerary.basics.included).toBe("왕복항공권 / 호텔");
    expect(result.itinerary.basics.excluded).toBe("개인경비");
    expect(result.itinerary.days.flatMap((day) => day.items.map((item) => item.content))).toContain("송가고택관광");
  });

  it("splits meal prefixes embedded in AI sightseeing and transfer content", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
4일차 | 관광 | 석식 후 싱가포르 창이 국제공항으로 이동 및 쥬얼창이 견학 | | 20:00`,
              },
            },
          ],
        });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: { travelPeriod: { start: "2025-04-30", end: "2025-04-30" } },
                days: [
                  {
                    dayNo: 4,
                    date: "2025-04-30",
                    items: [
                      {
                        type: "SIGHTSEEING",
                        time: "20:00",
                        content: "석식 후 싱가포르 창이 국제공항으로 이동 및 쥬얼창이 견학",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { parseItineraryWithDiagnostics } = await import("@/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText: "제4일 싱가포르\n석식 후 싱가포르 창이 국제공항으로 이동 및 쥬얼창이 견학",
      title: "싱가포르 4일차",
    });
    const items = result.itinerary.days[0]?.items ?? [];

    expect(result.diagnostics.source).toBe("ai");
    expect(items.find((item) => item.type === "MEAL" && item.mealSlot === "dinner")?.meal?.dinner).toBe("석식");
    expect(items.find((item) => item.type !== "MEAL")?.content).toBe("싱가포르 창이 국제공항으로 이동 및 쥬얼창이 견학");
  });
});
