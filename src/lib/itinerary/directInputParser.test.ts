import { describe, expect, it } from "vitest";
import { parseDirectInputItineraryWithDiagnostics } from "@/lib/itinerary/directInputParser";
import type { ItineraryData, MealSlot } from "@/types";

function contents(data: ItineraryData): string[] {
  return data.days.flatMap((day) => day.items.map((item) => item.content));
}

function meal(data: ItineraryData, dayNo: number, slot: MealSlot): string | undefined {
  const item = data.days
    .find((day) => day.dayNo === dayNo)
    ?.items.find((entry) => entry.type === "MEAL" && entry.mealSlot === slot);
  return item?.meal?.[slot] ?? item?.content;
}

function nonMealContents(data: ItineraryData): string[] {
  return data.days.flatMap((day) =>
    day.items.filter((item) => item.type !== "MEAL").map((item) => item.content),
  );
}

describe("direct input itinerary parser", () => {
  it("merges separate date schedule and meal blocks without leaking cost notes", async () => {
    const rawText = `고북수진 가는날 늦게 돌아와서 발맛사지 할 시간이 안돼서  2일차로 넣었습니다  고북수진 가는날 석식 현지식으로만 가능합니다
유니버셜내 식사가 비싸서 $15로 책정했습니다
북경대학교 방문정책이 자꾸 변동돼서   림박에 방문여부 정확하게  확인할수 있습니다

북경대방문비용 $45/인, 유니버셜 입장료 $87(예상가)

춘휘원호텔

10/12  왕부정거리
10/13  경산  자금성 천단공원   서커스   발맛사지
10/14  이화원 고북수진이동 소주방 염색방등 사마대장성왕복케이블카
10/15  북경대학교 유니버셜
10/16   798거리

10/12  석:오리구이$12
10/13  중:현지식$10   석:샤브샤브무제한$10
10/14   중:현지식$10   석:현지식$10
10/15  중;자유식$15     석:자유식$15
10/16  중:한식$13

35인승 중형`;

    const result = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const itinerary = result.itinerary;
    const allContents = contents(itinerary).join("\n");

    expect(itinerary.days.map((day) => day.date)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
    expect(itinerary.basics.accommodation.hotel).toContain("춘휘원호텔");
    expect(itinerary.basics.flight.localVehicle).toBe("35인승 중형");
    expect(allContents).toContain("왕부정거리");
    expect(allContents).toContain("북경대학교 유니버셜");
    expect(meal(itinerary, 1, "dinner")).toBe("오리구이");
    expect(meal(itinerary, 4, "lunch")).toBe("자유식");
    expect(meal(itinerary, 5, "lunch")).toBe("한식");
    expect(allContents).not.toContain("$");
    expect(allContents).not.toContain("방문정책");
    expect(itinerary.basics.notes).toContain("방문정책");
    expect(itinerary.basics.notes).toContain("방문비용");
  });

  it("parses quotation style simple schedules and keeps metadata separate", async () => {
    const rawText = `* 견적코드 : QA00691268001 / 기준 코드 : X

1.출발일 : 2026.10.07
2.인원 : 10+0
3.차량 : 35인승 버스 1대, 가이드 1명
4.호텔 : 노보텔 타이하 1박 또는 동급, 하얏트 플레이스 하롱 2박 또는 동급/ 2인1실 기준 (5트윈 / 싱차 14만원)
5.포함 : 기가팁
6.불포함 : 개인여행경비
7.비고 : 쇼핑 2회(침향/잡화) / 노옵션 / 인솔자 무
8.지상비 : 행사비 20만원 + 호텔비 14만원 = 총 34만원
** 인원 감소 시 차액 크게 발생합니다.

*** 간단 일정 ***
1일차 : 하노이 도착, 호텔 이동 및 휴식
2일차 : 옌뜨 케이블카, 하롱베이 이동, 수상인형극, 전신 90분(팁 6$ 별도), 하얏트 망고빙수 / 옌뜨 정식, 무제한 삼겹살
3일차 : 단독 목선배 탑승, 비경, 승솟동굴, 티톱섬, 하선, 하롱파크, 홍가이 재래시장, 하얏트호텔 루프탑(스낵+맥주1잔) / 선상식+씨푸드, 오삼불고기
4일차 : 하노이 이동, 관저, 한기둥, 바딘, 호안끼엠 호수, 36거리, 스트릿카, 성요셉 성당, 롯데전망대 / 분짜정식(꽌안응온), 해물순두부`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const allContents = contents(itinerary).join("\n");

    expect(itinerary.days).toHaveLength(4);
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-10-07", end: "2026-10-10" });
    expect(itinerary.overview.passengers.adult).toBe(10);
    expect(itinerary.basics.flight.localVehicle).toBe("35인승 버스 1대, 가이드 1명");
    expect(itinerary.basics.accommodation.hotel).toContain("노보텔 타이하");
    expect(itinerary.basics.included).toBe("기가팁");
    expect(itinerary.basics.excluded).toBe("개인여행경비");
    expect(itinerary.basics.shoppingCenters).toBe(2);
    expect(itinerary.basics.optionalTour).toBe("노옵션");
    expect(itinerary.overview.fare.adultPerPerson).toBe(340000);
    expect(allContents).toContain("하노이 도착");
    expect(allContents).toContain("롯데전망대");
    expect(meal(itinerary, 2, "lunch")).toBe("옌뜨 정식");
    expect(meal(itinerary, 2, "dinner")).toBe("무제한 삼겹살");
    expect(allContents).not.toContain("견적코드");
    expect(allContents).not.toContain("지상비");
  });

  it("splits compact hyphenated simple schedules into meals and activities", async () => {
    const rawText = `요청 동일 일정 기준

- 행사일: 2026-11-21
- 인원: 성인13+아동7
- 호텔:윈덤 다낭 골든베이 5박 (트윈4개+트리플4개) 사용 기준 (룸당 싱차 22만원)
- 쇼핑 & 옵션: 쇼핑 1회+노옵션 조건
- 차량:  45인승
- 포함: 가기팁, 전신마사지1시간, 한강크루즈, 바나산,  바구니배, 호이안야경투어(소원등), 씨클로, 팩 동일 식사

< 간단일정 >
1일차: 미팅후 호텔 이동후 휴식
2일차: 조식후 오전자유-중식(분짜+반세오)-오행산관광-호이안이동후 호이안관광(씨클로, 바구니배, 야경투어, 소원등)-석식(호이안가정식)-호텔휴식
3일차: 조식후 전일자유일정(중석식불포함)
4일차: 조식후 바나산 이동-바나산 관광-중식(포시즌스뷔페)- 다낭이동-전신마사지1시간-석식(무제한삼겹살)-호텔휴식
5일차: 조식후 전일자유일정(중석식불포함)
6일차: 조식후 오전자유-중식(미케비치씨푸드)- 다낭시내관광(다낭대성당,미케비치,손짜)-석식(한식)-한강크루즈-공항이동`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const dayTwoItems = itinerary.days.find((day) => day.dayNo === 2)?.items ?? [];
    const dayTwoSummary = dayTwoItems.map((item) =>
      item.type === "MEAL"
        ? `${item.type}:${item.mealSlot}:${item.content}`
        : `${item.type}:${item.content}`,
    );

    expect(itinerary.days).toHaveLength(6);
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-11-21", end: "2026-11-26" });
    expect(itinerary.overview.passengers.adult).toBe(13);
    expect(itinerary.overview.passengers.child).toBe(7);
    expect(itinerary.basics.flight.localVehicle).toBe("45인승");
    expect(itinerary.basics.accommodation.hotel).toContain("윈덤 다낭 골든베이");
    expect(itinerary.basics.included).toContain("한강크루즈");
    expect(itinerary.basics.shoppingCenters).toBe(1);
    expect(itinerary.basics.optionalTour).toBe("노옵션");
    expect(dayTwoSummary).toEqual([
      "OTHER:오전자유",
      "MEAL:lunch:분짜+반세오",
      "SIGHTSEEING:오행산관광",
      "SIGHTSEEING:호이안이동후 호이안관광(씨클로, 바구니배, 야경투어, 소원등)",
      "MEAL:dinner:호이안가정식",
      "OTHER:호텔휴식",
    ]);
  });

  it("combines separate itinerary and meal sections by day", async () => {
    const rawText = `날짜 : 26.06.29
인원 : 16명
호텔 : 베스트웨스턴 3박 또는 동급 / 디럭스 8방 기준 - RQ조건
ㄴ싱차 : 21만원
항공 : -
차량 : 35인승 1대
포함 : 가기팁(한국인가이드), 혼똔섬+케이블카, 키스브릿지, 바구니배, 전신마사지1시간(팁별도)*1회, 전일정 중/석식
불포 : 개인경비 및 매너팁, 자유일정시 차량&가이드

* 쇼핑 1회, 노옵션 조건

[일정]
1일차 : 공항도착/가이드미팅 후 호텔투숙
2일차 : 오전자유일정/중식/혼똔섬+케이블카/석식/키스브릿지/선셋타운/부이페스트야시장
3일차 : 오전자유일정/중식/바구니배/전신마사지1시간(팁별도)/그랜드월드관광/석식
4일차 : 체크아웃 가이드미팅/중식/사오비치/호국사/코코넛수용소/석식/즈엉동야시장/공항으로 이동
5일차 : 인천도착

[식사]
2일차 중식 분짜$10 / 석식 한식$10
3일차 중식 현지식$10 / 석식 한식$10
4일차 중식 현지식$10 / 석식 한식$10`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const allContents = contents(itinerary).join("\n");

    expect(itinerary.days).toHaveLength(5);
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-06-29", end: "2026-07-03" });
    expect(itinerary.overview.passengers.adult).toBe(16);
    expect(itinerary.basics.accommodation.hotel).toContain("베스트웨스턴");
    expect(itinerary.basics.flight.localVehicle).toBe("35인승 1대");
    expect(itinerary.basics.shoppingCenters).toBe(1);
    expect(itinerary.basics.optionalTour).toBe("노옵션");
    expect(allContents).toContain("혼똔섬+케이블카");
    expect(allContents).toContain("즈엉동야시장");
    expect(meal(itinerary, 2, "lunch")).toBe("분짜");
    expect(meal(itinerary, 4, "dinner")).toBe("한식");
    expect(allContents).not.toContain("$10");
    expect(allContents).not.toContain("싱차");
    expect(itinerary.basics.notes).toContain("싱차");
  });

  it("parses month-day rows and keeps meal cost standards in notes", async () => {
    const rawText = `10명 단독

1. 호텔 : 4성급 호텔 기준  <예정 호텔 참고>
  로마  -Ergife Palace Hotel 혹은 동급 (4*)
  피렌체  - Wyndham Garden Florence 혹은 동급 (4*)
  파도바 - Four Points by Sheraton Padova 혹은 동급 (4*)
  밀라노 - Best Western Premier Hotel Royal Santina 혹은 동급 (4*)
2. 차량 : 대형버스
3. 가이드 : 한국인 가이드, 현지인 가이드
4. 식사 : 호텔 조식+중&석식 9회 기준 (중식 20EUR // 석식 25EUR 책정)
5. 입장지 : 바티칸박물관+예약,  베니스 바포레토, 베니스 수상택시
6. 기타포함 : 각종TIP , 이태리 체크포인트, 호텔 TAX

6/18 로마 공항 - 호텔
6/19 로마 전일
6/20 로마 - 피엔차 - 시에나 - 피렌체
6/21 피렌체 - 파도바
6/22 파도바 - 베니스 - 밀라노
6/23 밀라노 - 꼬모 - 밀라노 공항

[불포함]
첫날, 마지막날 석식 불포함 기준입니다.
여행용 송수신기 비용 불포함 기준입니다.`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const allContents = contents(itinerary).join("\n");

    expect(itinerary.days.map((day) => day.date)).toEqual([
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
      "2026-06-23",
    ]);
    expect(itinerary.overview.passengers.adult).toBe(10);
    expect(itinerary.basics.flight.localVehicle).toBe("대형버스");
    expect(itinerary.basics.accommodation.hotel).toContain("Ergife Palace Hotel");
    expect(itinerary.basics.included).toContain("바티칸박물관");
    expect(itinerary.basics.included).toContain("호텔 TAX");
    expect(allContents).toContain("로마 공항");
    expect(allContents).toContain("밀라노 공항");
    expect(allContents).not.toContain("20EUR");
    expect(allContents).not.toContain("불포함");
    expect(itinerary.basics.notes).toContain("20EUR");
    expect(itinerary.basics.excluded).toContain("첫날, 마지막날 석식 불포함");
  });

  it("parses decorated day lines and keeps excluded dinner as notes", async () => {
    const rawText = `<3박 4일>
▶지상비 :  1인 124,000엔(P/P)
▶인원 : 6명+1 드라이빙가이드 기준
▶기간 : 2026년 10월 8일 ~ 4일간
▶호텔(RQ) : 1-2일차 : 스기노이 호텔 니지칸 또는 동급 (RQ조건)
                     3일차 : 몬토레 라 스루 호텔 또는 동급 (RQ조건)
▶차량 : 하이에스 4일 * 1대이용
▶일정 : 요청해주신 일정과 동일합니다.
└1일차 : 중식 - 가마도지옥 - 유노하나 - 체크인
└2일차 : 벳부 사파리 - 중식 - 유후인 - 호텔복귀
   => 연휴 등 혼잡한 날에는 정글버스 탑승(선착순)이 불가할 수 있습니다.
└3일차 : 다자이후 - 중식 - 오후 자유일정
└4일차 : 조식 후 공항이동
▶비고
* 3일차 석식 불포함 입니다.
* 노팁, 노옵션, 노쇼핑기준입니다.

※ 지상 전체 RQ요청 조건
※ 인원 변경 시 요금 변동됩니다.`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const allContents = contents(itinerary).join("\n");

    expect(itinerary.days).toHaveLength(4);
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-10-08", end: "2026-10-11" });
    expect(itinerary.overview.passengers.adult).toBe(6);
    expect(itinerary.overview.passengers.escort).toBe(1);
    expect(itinerary.basics.accommodation.hotel).toContain("스기노이 호텔");
    expect(itinerary.basics.accommodation.hotel).toContain("몬토레 라 스루 호텔");
    expect(itinerary.basics.flight.localVehicle).toBe("하이에스 4일 * 1대이용");
    expect(itinerary.basics.shoppingCenters).toBe(0);
    expect(itinerary.basics.optionalTour).toBe("노옵션");
    expect(allContents).toContain("가마도지옥");
    expect(allContents).toContain("공항이동");
    expect(allContents).not.toContain("석식 불포함");
    expect(itinerary.basics.notes).toContain("3일차 석식 불포함");
  });

  it("extracts bracketed slash-separated meals from direct day lines", async () => {
    const rawText = `출발일 : 2026.10.07
인원 : 10명

[일정]
1일차 : 하노이 도착
2일차 : 하롱 이동, 마사지 [중: 베트남 가정식 / 석: 소불고기 정식]
3일차 : 바구니배 체험 [중: 껌땀 정식 / 석: 닭백숙]
4일차 : 하노이 시내관광 [중: 반쎄오+쌀국수 정식 / 석: 무제한 삼겹살]`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });
    const activityContents = nonMealContents(itinerary).join("\n");

    expect(meal(itinerary, 2, "lunch")).toBe("베트남 가정식");
    expect(meal(itinerary, 2, "dinner")).toBe("소불고기 정식");
    expect(meal(itinerary, 3, "lunch")).toBe("껌땀 정식");
    expect(meal(itinerary, 3, "dinner")).toBe("닭백숙");
    expect(meal(itinerary, 4, "lunch")).toBe("반쎄오+쌀국수 정식");
    expect(meal(itinerary, 4, "dinner")).toBe("무제한 삼겹살");
    expect(activityContents).toContain("마사지");
    expect(activityContents).not.toContain("[중:");
    expect(activityContents).not.toContain("]");
  });

  it("loads structured direct-input metadata without a detailed itinerary", async () => {
    const rawText = `<<상품 정보>>
*상품명*
직접입력 일정

*방문도시*
- 오사카

*기간*
2026-05-21 ~ 2026-05-24

*성인1인 총 상품가*
500,000원


<<항공/교통>>
*항공 출발*
인천공항

*항공 귀국*
간사이공항

*차량*
전용버스


<<숙박>>
*숙박호텔*
- 오사카 호텔 또는 동급

*호텔등급*
4성급

*1객실이용인원*
2인실


<<포함/불포함>>
*포함사항*
- 호텔숙박비

*불포함사항*
- 개인경비

*선택관광*
- 노옵션

*쇼핑센터 방문 수*
0


*유의사항*
- ■지상비: $440/인 （18+1명: $465/인)
- ■노쇼핑
- ■노옵션`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });

    expect(itinerary.header.groupName).toBe("직접입력 일정");
    expect(itinerary.overview.cities).toBe("오사카");
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-05-21", end: "2026-05-24" });
    expect(itinerary.overview.fare.adultPerPerson).toBe(500000);
    expect(itinerary.basics.flight.departure).toBe("인천공항");
    expect(itinerary.basics.flight.arrival).toBe("간사이공항");
    expect(itinerary.basics.flight.localVehicle).toBe("전용버스");
    expect(itinerary.basics.accommodation.hotel).toBe("오사카 호텔 또는 동급");
    expect(itinerary.basics.accommodation.grade).toBe("4성급");
    expect(itinerary.basics.accommodation.occupancy).toBe("2인실");
    expect(itinerary.basics.included).toBe("호텔숙박비");
    expect(itinerary.basics.excluded).toBe("개인경비");
    expect(itinerary.basics.optionalTour).toBe("노옵션");
    expect(itinerary.basics.shoppingCenters).toBe(0);
    expect(itinerary.basics.notes).toContain("지상비");
    expect(itinerary.basics.notes).toContain("노쇼핑");
    expect(itinerary.basics.notes).toContain("노옵션");
    expect(itinerary.days.map((day) => day.date)).toEqual([
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
      "2026-05-24",
    ]);
    expect(itinerary.days.every((day) => day.items.length === 0)).toBe(true);
  });

  it("accepts common structured direct-input label aliases", async () => {
    const rawText = `<<상품 정보>>
*일정명*
라벨 변형 일정

*여행 도시*
- 후쿠오카

*여행 기간*
2026-06-01 ~ 2026-06-02

*성인 1인 총 상품가*
300,000원


<<항공/교통>>
*항공출발*
부산공항

*귀국편*
후쿠오카공항

*현지 차량*
전용차량


<<숙박>>
*숙박 호텔*
- 하카타 호텔

*호텔 등급*
3성급

*객실 이용인원*
2인1실


<<포함/불포함>>
*포함*
- 조식

*불포*
- 개인경비

*옵션투어*
- 없음

*쇼핑횟수*
1

*비고*
- 라벨 변형 테스트`;

    const { itinerary } = await parseDirectInputItineraryWithDiagnostics({ rawText, title: "직접입력 일정" });

    expect(itinerary.header.groupName).toBe("라벨 변형 일정");
    expect(itinerary.overview.cities).toBe("후쿠오카");
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-06-01", end: "2026-06-02" });
    expect(itinerary.overview.fare.adultPerPerson).toBe(300000);
    expect(itinerary.basics.flight.departure).toBe("부산공항");
    expect(itinerary.basics.flight.arrival).toBe("후쿠오카공항");
    expect(itinerary.basics.flight.localVehicle).toBe("전용차량");
    expect(itinerary.basics.accommodation.hotel).toBe("하카타 호텔");
    expect(itinerary.basics.accommodation.grade).toBe("3성급");
    expect(itinerary.basics.accommodation.occupancy).toBe("2인1실");
    expect(itinerary.basics.included).toBe("조식");
    expect(itinerary.basics.excluded).toBe("개인경비");
    expect(itinerary.basics.optionalTour).toBe("없음");
    expect(itinerary.basics.shoppingCenters).toBe(1);
    expect(itinerary.basics.notes).toBe("라벨 변형 테스트");
    expect(itinerary.days.map((day) => day.date)).toEqual(["2026-06-01", "2026-06-02"]);
  });

  it("routes structured file-attachment preview text without collapsing it into one day", async () => {
    const rawText = `<<상품 정보>>
*상품명*
도쿄4일-노원구의회

*방문도시*
- 도쿄

*기간*
2026-10-17 ~ 2026-10-20

*성인1인 총 상품가*
113,500원


<<항공/교통>>
*항공 출발*
인천공항

*항공 귀국*
나리타공항

*차량*
전용버스


<<숙박>>
*숙박호텔*
- 메트로 폴리탄 이케부트로 호텔 또는 동급

*호텔등급*
4성급

*1객실이용인원*
2인실


<<포함/불포함>>
*포함사항*
- 호텔숙박비 (2인1실 기준), 식사 중식 3,000엔*4회, 석식 5,000엔*3회, 스루가이드 기준 (가이드 기사팁 포함), 생수 포함, 왕복항공료 유류택스, 1억원여행자 보험, 노쇼핑기준

*불포함사항*
- 기타 개인경비

*쇼핑센터 방문 수*
0


<<상세 일정>>
*1일차*
2026-10-17
- 이동 | 인천 공항에서 가이드 미팅 & 입국 수속
- 이동 | 인천공항 출발
- 이동 | 나리타 공항 도착 후 전용차량 탑승
- 식사 | 중식: 현지식
- 이동 | 아사쿠사로 이동
- 기타 | *아사쿠사 센소지 및 나카미세 도오리
- 식사 | 석식: 현지식
- 이동 | 호텔이동
- 기타 | 시간=4성급 | 호텔 - 메트로 폴리탄 이케부트로 호텔 또는 동급 (2인실 기준)

*2일차*
2026-10-18
- 이동 | 호텔 전용차량 탑승
- 식사 | 조식: 호텔식
- 기타 | *일본의 상징이자 명실상부한 일본의 최고봉인 후지산 오합목
- 기타 | *수많은 온천과 자연경관으로 아름다운 국립공원 하코네 국립공원
- 식사 | 중식: 현지식
- 기타 | *아시 호수의 해적 유람선을 타자 ! 아시호수 유람선( 桃源台港発>箱根町港着)
- 기타 | 도쿄로 귀환
- 식사 | 석식: 현지식
- 이동 | 호텔이동

*3일차*
2026-10-19
- 식사 | 조식: 호텔식
- 기타 | * 요코하마 아카렝가 , 미나토 미라이21, 야마시타공원 , 차이나 타원
- 기타 | ㅁ 공식 방문지 -예정 자체 수배 시내 예정
- 식사 | 석식: 현지식
- 이동 | 호텔이동

*4일차*
2026-10-20
- 식사 | 조식: 호텔식
- 기타 | ㅁ 공식 방문지 -예정 자체 수배 시내 예정
- 기타 | *오다이바 다이바시티, 자유여신상, 레인보우 브릿지 조망
- 식사 | 중식: 현지식
- 이동 | 나리타공항 이동
- 이동 | 나리타공항 출발
- 이동 | 인천공항 도착 후 해산`;

    const { itinerary, diagnostics } = await parseDirectInputItineraryWithDiagnostics({
      rawText,
      title: "직접입력 일정",
    });
    const allContents = contents(itinerary).join("\n");

    expect(diagnostics.source).toBe("fast-text");
    expect(itinerary.header.groupName).toBe("도쿄4일-노원구의회");
    expect(itinerary.overview.cities).toBe("도쿄");
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-10-17", end: "2026-10-20" });
    expect(itinerary.overview.fare.adultPerPerson).toBe(113500);
    expect(itinerary.basics.flight.departure).toBe("인천공항");
    expect(itinerary.basics.flight.arrival).toBe("나리타공항");
    expect(itinerary.basics.flight.localVehicle).toBe("전용버스");
    expect(itinerary.basics.accommodation.hotel).toContain("메트로 폴리탄 이케부트로 호텔");
    expect(itinerary.days.map((day) => day.date)).toEqual([
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(itinerary.days).toHaveLength(4);
    expect(meal(itinerary, 1, "lunch")).toBe("현지식");
    expect(meal(itinerary, 4, "lunch")).toBe("현지식");
    expect(allContents).toContain("아사쿠사 센소지 및 나카미세 도오리");
    expect(allContents).toContain("나리타공항 출발");
    expect(allContents).not.toContain("<<상품 정보>>");
    expect(allContents).not.toContain("왕복항공료 유류택스");
  });
});
