import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { ItineraryData, MealSlot } from "@/types";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/itinerary-golden");
const QUALITY_SCORE_THRESHOLD = 70;
const KNOWN_LOW_SCORE_BASELINES = [
  { marker: "쿨인싱아웃4박", minQualityScore: 53 },
];
const FIELD_COVERAGE_BASELINES = [
  { marker: "쿠말겐3박", minDayCount: 4, minMealCount: 7, minAccommodationCount: 1 },
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
      forbiddenContents: ["차 / 량", "오 / 전", "일정은", "안성시", "0316778115hj"],
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
      minQualityScore: 68,
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
      forbiddenContents: ["참고사항", "가이드 통역비", "환율", "감사합니다"],
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
  requiredContents?: string[];
  requiredMeals?: Array<{
    slot: MealSlot;
    valueIncludes: string;
  }>;
  requiredHotels?: string[];
  forbiddenHotels?: string[];
  forbiddenNotes?: string[];
  forbiddenContents?: string[];
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
    .filter((name) => !name.startsWith("~$") && extensions.has(path.extname(name).toLowerCase()))
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
    requiredContents: [...(fileExpected.requiredContents ?? []), ...(inlineExpected.requiredContents ?? [])],
    requiredMeals: [...(fileExpected.requiredMeals ?? []), ...(inlineExpected.requiredMeals ?? [])],
    requiredHotels: [...(fileExpected.requiredHotels ?? []), ...(inlineExpected.requiredHotels ?? [])],
    forbiddenHotels: [...(fileExpected.forbiddenHotels ?? []), ...(inlineExpected.forbiddenHotels ?? [])],
    forbiddenNotes: [...(fileExpected.forbiddenNotes ?? []), ...(inlineExpected.forbiddenNotes ?? [])],
    forbiddenContents: [...(fileExpected.forbiddenContents ?? []), ...(inlineExpected.forbiddenContents ?? [])],
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
    const forbiddenContents = expected?.forbiddenContents ?? [];
    for (const pattern of NOISE_PATTERNS) {
      expect(itemTexts.some((value) => pattern.test(value)), testCase.name).toBe(false);
    }
    for (const forbidden of forbiddenContents) {
      expect(includesText(itemTexts, forbidden), `${testCase.name} forbidden ${forbidden}`).toBe(false);
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
});
