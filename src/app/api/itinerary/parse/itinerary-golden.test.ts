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
const SUPPORTED_EXTENSIONS = new Set([".xlsx", ".txt"]);
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
  requiredContents?: string[];
  requiredMeals?: Array<{
    slot: MealSlot;
    valueIncludes: string;
  }>;
  requiredHotels?: string[];
  forbiddenContents?: string[];
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
    requiredContents: [...(fileExpected.requiredContents ?? []), ...(inlineExpected.requiredContents ?? [])],
    requiredMeals: [...(fileExpected.requiredMeals ?? []), ...(inlineExpected.requiredMeals ?? [])],
    requiredHotels: [...(fileExpected.requiredHotels ?? []), ...(inlineExpected.requiredHotels ?? [])],
    forbiddenContents: [...(fileExpected.forbiddenContents ?? []), ...(inlineExpected.forbiddenContents ?? [])],
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

    const itemTexts = allItemTexts(itinerary);
    const forbiddenContents = expected?.forbiddenContents ?? [];
    for (const pattern of NOISE_PATTERNS) {
      expect(itemTexts.some((value) => pattern.test(value)), testCase.name).toBe(false);
    }
    for (const forbidden of forbiddenContents) {
      expect(includesText(itemTexts, forbidden), testCase.name).toBe(false);
    }
    for (const required of expected?.requiredContents ?? []) {
      expect(includesText(itemTexts, required), testCase.name).toBe(true);
    }
    for (const hotel of expected?.requiredHotels ?? []) {
      expect(includesText(itemTexts, hotel), testCase.name).toBe(true);
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
