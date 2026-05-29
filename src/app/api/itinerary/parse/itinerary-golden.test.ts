import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { ItineraryData, MealSlot } from "@/types";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/itinerary-golden");
const QUALITY_SCORE_THRESHOLD = 70;
const KNOWN_LOW_SCORE_BASELINES = [
  { marker: "쿨인싱아웃4박", minQualityScore: 53 },
  { marker: "푸꾸옥_QA00603277001", minQualityScore: 64 },
];
const FIELD_COVERAGE_BASELINES = [
  { marker: "쿠말겐3박", minDayCount: 4, minMealCount: 7, minAccommodationCount: 0 },
];
const INLINE_EXPECTATIONS: Array<{ marker: string; expected: GoldenExpected }> = [
  {
    marker: "(1)일정(OZ)-견적용 (1)",
    expected: {
      dayCount: 4,
      requiredContents: ["지옥계곡", "노보리벳츠 시대촌", "오타루 오르골당", "흰수염폭포", "팜토미타", "치토세공항"],
      requiredMeals: [
        { slot: "breakfast", valueIncludes: "호텔식" },
        { slot: "lunch", valueIncludes: "현지식" },
        { slot: "dinner", valueIncludes: "호텔식" },
      ],
      requiredHotels: ["노보리벳츠 미야비테이 호텔", "프리미어호텔 츠바키 삿포로", "죠잔케이뷰 호텔"],
      forbiddenContents: ["차 / 량", "오 / 전", "차량 전일 조식", "일정은", "안성시", "0316778115hj"],
      forbiddenExactContents: ["조", "석식"],
      forbiddenHotels: ["호텔 체크인후 석식", "호텔투숙 및 휴식"],
      requiredItemFields: [
        { dayNo: 2, contentIncludes: "에도시대 거리 노보리벳츠 시대촌 관광", transport: "차량" },
        { dayNo: 4, contentIncludes: "치토세공항 출발", region: "치토세공항", time: "14:30" },
        { dayNo: 4, contentIncludes: "인천공항 도착", region: "인천공항", time: "17:45" },
      ],
      forbiddenItemFields: [
        { dayNo: 4, contentIncludes: "조식후 삿포로 이동", region: "오전" },
        { dayNo: 4, contentIncludes: "조식후 삿포로 이동", time: "17:45" },
      ],
      forbiddenVehicleContents: ["노보리벳츠 시대촌", "전일 조식"],
    },
  },
  {
    marker: "0417스페인 9일",
    expected: {
      dayCount: 9,
      period: { start: "2026-04-17", end: "2026-04-25" },
      dayDates: {
        1: "2026-04-17",
        9: "2026-04-25",
      },
      requiredFlight: {
        departureIncludes: ["TW407", "인천 출발", "바르셀로나 도착"],
        arrivalIncludes: ["TW408", "바르셀로나 출발", "인천 도착"],
      },
      requiredItemFields: [
        { dayNo: 1, contentIncludes: "고흥출발", region: "고흥", transport: "전용차량", time: "08:00" },
        { dayNo: 2, contentIncludes: "몬세라트로 이동", region: "몬세라트", transport: "전용차량", time: "09:00" },
        { dayNo: 8, contentIncludes: "바르셀로나 출발", region: "바르셀로나", transport: "TW408", time: "21:00" },
        { dayNo: 9, contentIncludes: "인천 도착", region: "인천", time: "16:25" },
      ],
      requiredContents: [
        "몬세라트 수도원",
        "Mercado de San Miguel",
        "프라도 미술관",
        "알함브라",
        "Metropol Parasol",
        "누에보 다리",
        "사보르 아 말라가",
        "사그라다 파밀리아",
        "기내 숙박",
        "인천 도착",
      ],
      requiredHotels: ["4성급 호텔"],
      forbiddenContents: ["참고사항", "상기 일정", "환율", "TEMPOR"],
      forbiddenHotels: ["출국 수속", "몬세라트 바르셀로나", "마드리드", "그라나다", "세비야", "론다", "방문기관", "프라도 미술관", "유대인 지구"],
      forbiddenNotes: ["1일차", "2일차", "3일차", "4일차", "5일차", "6일차", "7일차", "8일차", "9일차"],
    },
  },
  {
    marker: "1[고객일정표] 오키나와 4일간_260504",
    expected: {
      dayCount: 4,
      period: { start: "2026-05-18", end: "2026-05-21" },
      requiredContents: [
        "슈리성",
        "아메리칸 빌리지",
        "비세 후쿠기",
        "츄라우미 수족관",
        "만좌모",
        "국제거리",
        "나하 국제공항",
      ],
      requiredMeals: [
        { slot: "breakfast", valueIncludes: "호텔식" },
        { slot: "lunch", valueIncludes: "현지식" },
        { slot: "dinner", valueIncludes: "호텔뷔페" },
      ],
      requiredHotels: ["Hyatt Seragaki Island", "Hyatt Regency Naha"],
      forbiddenContents: ["+81", "Add:", "나 / 하", "호 / 텔 / 식"],
    },
  },
  {
    marker: "우아한여행_삼성물산_260610_상세일정표",
    expected: {
      dayCount: 9,
      minQualityScore: 67,
      requiredContents: [
        "Zent Frenger",
        "하이델베르크성",
        "Ziehl-Abegg",
        "Museum Würth",
        "뢰머광장",
        "슈퍼셀",
        "시벨리우스 공원",
        "눅시오국립공원",
        "인천 국제 공항 도착",
      ],
      requiredMeals: [
        { slot: "breakfast", valueIncludes: "호텔식" },
        { slot: "lunch", valueIncludes: "현지식" },
        { slot: "dinner", valueIncludes: "한식" },
      ],
      requiredHotels: ["Holiday Inn Frankfurt", "Radisson Blu Royal"],
      forbiddenContents: ["참고사항", "가이드 통역비", "환율", "감사합니다", "출발 조", "자체일정) 석"],
      requiredItemFields: [
        { dayNo: 1, contentIncludes: "공항 출발", region: "공항", transport: "KE945", time: "10:50" },
        { dayNo: 5, contentIncludes: "프랑크푸르트 출발", region: "프랑크푸르트", transport: "AY1412", time: "11:30" },
        { dayNo: 8, contentIncludes: "헬싱키 출발", region: "헬싱키", transport: "AY041", time: "17:30" },
      ],
      forbiddenItemFields: [
        { dayNo: 2, contentIncludes: "Zent Frenger", region: "공항" },
        { dayNo: 2, contentIncludes: "Zent Frenger", transport: "KE945" },
        { dayNo: 2, contentIncludes: "하이델베르크성", region: "공항" },
        { dayNo: 2, contentIncludes: "하이델베르크성", transport: "KE945" },
        { dayNo: 6, contentIncludes: "슈퍼셀", transport: "AY1412" },
        { dayNo: 7, contentIncludes: "시벨리우스 공원", transport: "AY1412" },
      ],
    },
  },
  {
    marker: "싱가폴 3박 24년 10월 15일",
    expected: {
      requiredContents: ["인천공항 3층 출국장 도착 후 출국수속", "싱가폴 이색 문화 체험", "머라이언공원"],
      requiredMeals: [
        { slot: "breakfast", valueIncludes: "호텔식" },
        { slot: "lunch", valueIncludes: "송파 바쿠테" },
        { slot: "dinner", valueIncludes: "북창동 순두부" },
      ],
      requiredHotels: ["모멘튜스 또는 동급", "마리나 베이 샌즈 또는 동급"],
      forbiddenContents: [
        "□포함",
        "노쇼핑 노옵션",
        "기타 개인경비",
        "실시간 최저가 요금",
        "상기 일정은 항공 및 현지 사정",
        "㈜ 하나투어",
      ],
    },
  },
];
const SUPPORTED_EXTENSIONS = new Set([".xlsx", ".txt", ".pdf"]);
const UNSUPPORTED_EXTENSIONS = new Set([".xls"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const ITINERARY_IMAGE_FIXTURE_MARKERS = [
  "APQ251260426OZ7",
  "엠제이투어_장가계",
  "50+1 김해장가계",
  "백두산 3박 4일",
  "260708 상해&우전",
  "두발로 다낭",
  "윤기주 골프",
  "1124 서운면이장단협의회 위해연태",
] as const;
const NON_ITINERARY_IMAGE_FIXTURE_MARKERS = ["견적답변정보", "견적답변2"] as const;
const NOISE_PATTERNS = [
  /견적\s*번호/u,
  /요금\s*표/u,
  /엑셀\s*리본/u,
  /페이지\s*\d+/u,
  /담당자\s*[:：]/u,
  /전화\s*[:：]/u,
  /이메일\s*[:：]/u,
  /견적\s*호텔/u,
  /\[미팅보드/u,
  /식사\s*구분/u,
  /상세\s*입력/u,
];

interface GoldenExpected {
  dayCount?: number;
  minQualityScore?: number;
  period?: {
    start: string;
    end: string;
  };
  dayDates?: Record<number, string>;
  requiredFlight?: {
    departureIncludes?: string[];
    arrivalIncludes?: string[];
  };
  requiredItemFields?: Array<{
    dayNo?: number;
    contentIncludes: string;
    region?: string;
    transport?: string;
    time?: string;
  }>;
  forbiddenItemFields?: Array<{
    dayNo?: number;
    contentIncludes: string;
    region?: string;
    transport?: string;
    time?: string;
  }>;
  requiredContents?: string[];
  requiredMeals?: Array<{
    slot: MealSlot;
    valueIncludes: string;
  }>;
  requiredHotels?: string[];
  forbiddenHotels?: string[];
  forbiddenNotes?: string[];
  forbiddenContents?: string[];
  forbiddenExactContents?: string[];
  forbiddenVehicleContents?: string[];
}

interface GoldenCase {
  name: string;
  absolutePath: string;
  extension: string;
}

interface ParsePayload {
  itinerary?: ItineraryData;
  diagnostics?: {
    qualityScore?: number;
    fieldCoverage?: {
      dayCount: number;
      meaningfulItemCount: number;
      mealCount?: number;
      accommodationCount?: number;
    };
    warnings?: string[];
  };
  error?: string;
}

function listFixtureCases(extensions: Set<string>): GoldenCase[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) =>
      !name.startsWith("~$") &&
      !name.includes("_CONVERTER_LOCAL_") &&
      extensions.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      absolutePath: path.join(FIXTURE_DIR, name),
      extension: path.extname(name).toLowerCase(),
    }));
}

function contentTypeFor(extension: string): string {
  if (extension === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (extension === ".xls") return "application/vnd.ms-excel";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".hwp") return "application/x-hwp";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "text/plain";
}

function makeFixtureFile(testCase: GoldenCase): File {
  const bytes = readFileSync(testCase.absolutePath);
  return new File([new Uint8Array(bytes)], testCase.name, {
    type: contentTypeFor(testCase.extension),
  });
}

function expectedPathFor(testCase: GoldenCase): string {
  const basename = testCase.name.replace(/\.[^.]+$/u, "");
  return path.join(FIXTURE_DIR, `${basename}.expected.json`);
}

function loadExpected(testCase: GoldenCase): GoldenExpected | null {
  const expectedPath = expectedPathFor(testCase);
  const fileExpected = existsSync(expectedPath)
    ? JSON.parse(readFileSync(expectedPath, "utf8")) as GoldenExpected
    : null;
  const normalizedName = testCase.name.normalize("NFC");
  const inlineExpected = INLINE_EXPECTATIONS.find((entry) => normalizedName.includes(entry.marker))?.expected ?? null;
  if (!fileExpected) return inlineExpected;
  if (!inlineExpected) return fileExpected;
  return {
    ...fileExpected,
    ...inlineExpected,
    period: inlineExpected.period ?? fileExpected.period,
    dayDates: { ...(fileExpected.dayDates ?? {}), ...(inlineExpected.dayDates ?? {}) },
    requiredFlight: {
      departureIncludes: [
        ...(fileExpected.requiredFlight?.departureIncludes ?? []),
        ...(inlineExpected.requiredFlight?.departureIncludes ?? []),
      ],
      arrivalIncludes: [
        ...(fileExpected.requiredFlight?.arrivalIncludes ?? []),
        ...(inlineExpected.requiredFlight?.arrivalIncludes ?? []),
      ],
    },
    requiredItemFields: [
      ...(fileExpected.requiredItemFields ?? []),
      ...(inlineExpected.requiredItemFields ?? []),
    ],
    forbiddenItemFields: [
      ...(fileExpected.forbiddenItemFields ?? []),
      ...(inlineExpected.forbiddenItemFields ?? []),
    ],
    requiredContents: [...(fileExpected.requiredContents ?? []), ...(inlineExpected.requiredContents ?? [])],
    requiredMeals: [...(fileExpected.requiredMeals ?? []), ...(inlineExpected.requiredMeals ?? [])],
    requiredHotels: [...(fileExpected.requiredHotels ?? []), ...(inlineExpected.requiredHotels ?? [])],
    forbiddenHotels: [...(fileExpected.forbiddenHotels ?? []), ...(inlineExpected.forbiddenHotels ?? [])],
    forbiddenNotes: [...(fileExpected.forbiddenNotes ?? []), ...(inlineExpected.forbiddenNotes ?? [])],
    forbiddenContents: [...(fileExpected.forbiddenContents ?? []), ...(inlineExpected.forbiddenContents ?? [])],
    forbiddenExactContents: [
      ...(fileExpected.forbiddenExactContents ?? []),
      ...(inlineExpected.forbiddenExactContents ?? []),
    ],
    forbiddenVehicleContents: [
      ...(fileExpected.forbiddenVehicleContents ?? []),
      ...(inlineExpected.forbiddenVehicleContents ?? []),
    ],
  };
}

function baselineMinQualityScore(testCase: GoldenCase, expected: GoldenExpected | null): number {
  if (expected?.minQualityScore !== undefined) return expected.minQualityScore;
  const normalizedName = testCase.name.normalize("NFC");
  const baseline = KNOWN_LOW_SCORE_BASELINES.find((entry) => normalizedName.includes(entry.marker));
  return baseline?.minQualityScore ?? QUALITY_SCORE_THRESHOLD;
}

function allItemTexts(itinerary: ItineraryData): string[] {
  return itinerary.days.flatMap((day) =>
    day.items.flatMap((item) => [
      item.content,
      item.detail ?? "",
      item.hotel ?? "",
      item.meal?.breakfast ?? "",
      item.meal?.lunch ?? "",
      item.meal?.dinner ?? "",
    ]),
  ).filter((value) => value.trim().length > 0);
}

function includesText(values: string[], expected: string): boolean {
  return values.some((value) => value.includes(expected));
}

function travelDayCount(period: ItineraryData["overview"]["travelPeriod"]): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(period.start) || !/^\d{4}-\d{2}-\d{2}$/u.test(period.end)) return null;
  const start = new Date(`${period.start}T00:00:00Z`).getTime();
  const end = new Date(`${period.end}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function assertNoCommonParseAnomalies(testCaseName: string, itinerary: ItineraryData): void {
  const labeledMealOthers = itinerary.days.flatMap((day) =>
    day.items
      .filter((item) => item.type === "OTHER" && /^(?:\[\s*식사\s*\]|식사\s*[:：|])/u.test(item.content))
      .map((item) => `${day.dayNo}일차:${item.content}`),
  );
  expect(labeledMealOthers, `${testCaseName} labeled meal rows should not remain as OTHER`).toEqual([]);

  const labeledAccommodationTexts = itinerary.days.flatMap((day) =>
    day.items
      .filter((item) => item.type === "ACCOMMODATION")
      .flatMap((item) => [item.content, item.hotel ?? ""])
      .filter((value) => /^\[\s*(?:숙박|호텔|HOTEL|ACCOMMODATION)\s*\]/iu.test(value))
      .map((value) => `${day.dayNo}일차:${value}`),
  );
  expect(labeledAccommodationTexts, `${testCaseName} accommodation labels should be stripped`).toEqual([]);

  const expectedDayCount = travelDayCount(itinerary.overview.travelPeriod);
  if (expectedDayCount !== null && itinerary.days.every((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day.date))) {
    expect(
      expectedDayCount,
      `${testCaseName} travelPeriod should not greatly exceed parsed day count`,
    ).toBeLessThanOrEqual(itinerary.days.length + 2);
  }
}

async function parseFixture(testCase: GoldenCase): Promise<{ status: number; payload: ParsePayload }> {
  process.env.OPENAI_API_KEY = "";
  vi.resetModules();

  const { POST } = await import("./route");
  const formData = new FormData();
  formData.append("file", makeFixtureFile(testCase));
  formData.append("title", testCase.name.replace(/\.[^.]+$/u, ""));

  const request = {
    headers: new Headers({ "x-access-code": "test-code" }),
    formData: async () => formData,
    nextUrl: new URL("http://localhost/api/itinerary/parse?debug=1"),
  } as unknown as NextRequest;

  const response = await POST(request);
  return {
    status: response.status,
    payload: (await response.json()) as ParsePayload,
  };
}

beforeEach(() => {
  process.env.ACCESS_CODE = "test-code";
  process.env.OPENAI_API_KEY = "";
});

describe("itinerary golden fixtures", () => {
  const supportedCases = listFixtureCases(SUPPORTED_EXTENSIONS);
  const unsupportedCases = listFixtureCases(UNSUPPORTED_EXTENSIONS);
  const imageCases = listFixtureCases(IMAGE_EXTENSIONS);

  it("keeps itinerary image fixtures explicitly classified", () => {
    const classifiedMarkers = [
      ...ITINERARY_IMAGE_FIXTURE_MARKERS,
      ...NON_ITINERARY_IMAGE_FIXTURE_MARKERS,
    ];
    const unclassified = imageCases
      .map((testCase) => testCase.name.normalize("NFC"))
      .filter((name) => !classifiedMarkers.some((marker) => name.includes(marker)));

    expect(unclassified).toEqual([]);
  });

  it.each(supportedCases)("$name parses into usable itinerary data", async (testCase) => {
    const expected = loadExpected(testCase);
    const { status, payload } = await parseFixture(testCase);

    expect(payload.error, testCase.name).toBeUndefined();
    expect(status, testCase.name).toBe(200);
    expect(payload.itinerary, testCase.name).toBeDefined();
    expect(payload.diagnostics?.fieldCoverage?.dayCount, testCase.name).toBeGreaterThan(0);
    expect(payload.diagnostics?.fieldCoverage?.meaningfulItemCount, testCase.name).toBeGreaterThan(0);
    expect(payload.diagnostics?.qualityScore, testCase.name).toBeGreaterThanOrEqual(
      baselineMinQualityScore(testCase, expected),
    );
    const normalizedName = testCase.name.normalize("NFC");
    const fieldBaseline = FIELD_COVERAGE_BASELINES.find((entry) => normalizedName.includes(entry.marker));
    if (fieldBaseline) {
      expect(payload.diagnostics?.fieldCoverage?.dayCount, testCase.name).toBeGreaterThanOrEqual(fieldBaseline.minDayCount);
      expect(payload.diagnostics?.fieldCoverage?.mealCount, testCase.name).toBeGreaterThanOrEqual(fieldBaseline.minMealCount);
      expect(payload.diagnostics?.fieldCoverage?.accommodationCount, testCase.name).toBeGreaterThanOrEqual(
        fieldBaseline.minAccommodationCount,
      );
    }

    const itinerary = payload.itinerary;
    if (!itinerary) return;

    if (expected?.dayCount !== undefined) {
      expect(itinerary.days, testCase.name).toHaveLength(expected.dayCount);
    }
    if (expected?.period) {
      expect(itinerary.overview.travelPeriod.start, `${testCase.name} period start`).toBe(expected.period.start);
      expect(itinerary.overview.travelPeriod.end, `${testCase.name} period end`).toBe(expected.period.end);
    }
    for (const [dayNoText, date] of Object.entries(expected?.dayDates ?? {})) {
      const dayNo = Number(dayNoText);
      const day = itinerary.days.find((candidate) => candidate.dayNo === dayNo);
      expect(day?.date, `${testCase.name} day ${dayNo} date`).toBe(date);
    }
    for (const required of expected?.requiredFlight?.departureIncludes ?? []) {
      expect(itinerary.basics.flight.departure.includes(required), `${testCase.name} departure ${required}`).toBe(true);
    }
    for (const required of expected?.requiredFlight?.arrivalIncludes ?? []) {
      expect(itinerary.basics.flight.arrival.includes(required), `${testCase.name} arrival ${required}`).toBe(true);
    }
    for (const required of expected?.requiredItemFields ?? []) {
      const items = itinerary.days
        .filter((day) => required.dayNo === undefined || day.dayNo === required.dayNo)
        .flatMap((day) => day.items);
      const item = items.find((candidate) => candidate.content.includes(required.contentIncludes));
      expect(item, `${testCase.name} item ${required.contentIncludes}`).toBeDefined();
      if (required.region !== undefined) {
        expect(item?.region, `${testCase.name} item ${required.contentIncludes} region`).toBe(required.region);
      }
      if (required.transport !== undefined) {
        expect(item?.transport, `${testCase.name} item ${required.contentIncludes} transport`).toBe(required.transport);
      }
      if (required.time !== undefined) {
        expect(item?.time, `${testCase.name} item ${required.contentIncludes} time`).toBe(required.time);
      }
    }
    for (const forbidden of expected?.forbiddenItemFields ?? []) {
      const items = itinerary.days
        .filter((day) => forbidden.dayNo === undefined || day.dayNo === forbidden.dayNo)
        .flatMap((day) => day.items)
        .filter((candidate) => candidate.content.includes(forbidden.contentIncludes));
      expect(items.length, `${testCase.name} forbidden item ${forbidden.contentIncludes}`).toBeGreaterThan(0);
      for (const item of items) {
        if (forbidden.region !== undefined) {
          expect(item.region, `${testCase.name} item ${forbidden.contentIncludes} region`).not.toBe(forbidden.region);
        }
        if (forbidden.transport !== undefined) {
          expect(item.transport, `${testCase.name} item ${forbidden.contentIncludes} transport`).not.toBe(forbidden.transport);
        }
        if (forbidden.time !== undefined) {
          expect(item.time, `${testCase.name} item ${forbidden.contentIncludes} time`).not.toBe(forbidden.time);
        }
      }
    }

    const itemTexts = allItemTexts(itinerary);
    const hotelTexts = [
      itinerary.basics.accommodation.hotel,
      itinerary.basics.accommodation.grade,
      itinerary.basics.accommodation.occupancy,
      ...itinerary.days.flatMap((day) =>
        day.items
          .filter((item) => item.type === "ACCOMMODATION")
          .flatMap((item) => [item.content, item.hotel ?? ""]),
      ),
    ].filter((value) => value.trim().length > 0);
    assertNoCommonParseAnomalies(testCase.name, itinerary);
    const forbiddenContents = expected?.forbiddenContents ?? [];
    for (const pattern of NOISE_PATTERNS) {
      expect(itemTexts.some((value) => pattern.test(value)), testCase.name).toBe(false);
    }
    for (const forbidden of forbiddenContents) {
      expect(includesText(itemTexts, forbidden), `${testCase.name} forbidden ${forbidden}`).toBe(false);
    }
    for (const forbidden of expected?.forbiddenExactContents ?? []) {
      expect(itemTexts.some((value) => value === forbidden), `${testCase.name} exact forbidden ${forbidden}`).toBe(false);
    }
    for (const forbidden of expected?.forbiddenVehicleContents ?? []) {
      expect(itinerary.basics.flight.localVehicle.includes(forbidden), `${testCase.name} vehicle ${forbidden}`).toBe(false);
    }
    for (const forbidden of expected?.forbiddenHotels ?? []) {
      expect(includesText(hotelTexts, forbidden), `${testCase.name} hotel forbidden ${forbidden}`).toBe(false);
    }
    for (const forbidden of expected?.forbiddenNotes ?? []) {
      expect(itinerary.basics.notes.includes(forbidden), `${testCase.name} notes forbidden ${forbidden}`).toBe(false);
    }
    for (const required of expected?.requiredContents ?? []) {
      expect(includesText(itemTexts, required), `${testCase.name} required ${required}`).toBe(true);
    }
    for (const hotel of expected?.requiredHotels ?? []) {
      expect(includesText(itemTexts, hotel), `${testCase.name} hotel ${hotel}`).toBe(true);
    }
    for (const meal of expected?.requiredMeals ?? []) {
      const hasMeal = itinerary.days.some((day) =>
        day.items.some((item) => item.meal?.[meal.slot]?.includes(meal.valueIncludes)),
      );
      expect(hasMeal, `${testCase.name} ${meal.slot} ${meal.valueIncludes}`).toBe(true);
    }
  });

  it.each(unsupportedCases)("$name rejects legacy Excel with a conversion message", async (testCase) => {
    const { status, payload } = await parseFixture(testCase);

    expect(status, testCase.name).toBe(422);
    expect(payload.error, testCase.name).toContain("구형 Excel(.xls)은 보안상 지원하지 않습니다");
  });

  it("parses HWP table itinerary rows without dropping schedule columns", async () => {
    const testCase: GoldenCase = {
      name: "(3)일본(이희대 감사님) (1).hwp",
      absolutePath: path.join(FIXTURE_DIR, "(3)일본(이희대 감사님) (1).hwp"),
      extension: ".hwp",
    };
    const { status, payload } = await parseFixture(testCase);

    expect(payload.error, testCase.name).toBeUndefined();
    expect(status).toBe(200);
    expect(payload.itinerary).toBeDefined();
    expect(payload.diagnostics?.qualityScore).toBeGreaterThanOrEqual(70);

    const itinerary = payload.itinerary;
    if (!itinerary) return;
    expect(itinerary.days).toHaveLength(4);
    expect(itinerary.overview.travelPeriod).toEqual({ start: "2026-10-02", end: "2026-10-05" });
    expect(itinerary.basics.flight.departure).toContain("KE 723");
    expect(itinerary.basics.flight.departure).toContain("09:35");
    expect(itinerary.basics.flight.arrival).toContain("KE 724");
    expect(itinerary.basics.flight.arrival).toContain("12:35");

    const itemTexts = allItemTexts(itinerary);
    for (const required of [
      "토롯코 열차",
      "텐류지",
      "대나무숲",
      "호센인",
      "니시키 시장",
      "청수사",
      "후시미이나리신사",
      "도다이지",
      "수상버스 아쿠아 라이너",
      "오사카성",
      "신사이바시 도톤보리",
    ]) {
      expect(includesText(itemTexts, required), `${testCase.name} required ${required}`).toBe(true);
    }
    for (const forbidden of ["捤獥汤捯", "氠瑢", "일자", "교통편", "세   부   일   정"]) {
      expect(includesText(itemTexts, forbidden), `${testCase.name} forbidden ${forbidden}`).toBe(false);
    }
    for (const forbidden of ["호텔 조식 후", "중식(현지식)"]) {
      expect(itemTexts.some((value) => value === forbidden), `${testCase.name} exact forbidden ${forbidden}`).toBe(false);
    }
    expect(itinerary.basics.accommodation.hotel).toContain("RIHGA Royal Hotel Kyoto");
    expect(itinerary.basics.accommodation.hotel).toContain("오사카 난바 오리엔탈 호텔");
    expect(itinerary.basics.accommodation.hotel).not.toContain("호텔 체크");
    expect(itinerary.basics.accommodation.hotel).not.toContain("호텔 조식");

    const departure = itinerary.days[0]?.items.find((item) => item.content.includes("인천 국제 공항 출발"));
    expect(departure?.transport).toBe("KE 723");
    expect(departure?.time).toBe("09:35");
    const arrival = itinerary.days[3]?.items.find((item) => item.content.includes("간사이 국제공항 출발"));
    expect(arrival?.transport).toBe("KE 724");
    expect(arrival?.time).toBe("12:35");
  });
});
