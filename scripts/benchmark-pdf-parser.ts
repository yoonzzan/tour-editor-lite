import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { convert } from "@opendataloader/pdf";
import type { NextRequest } from "next/server";
import type { ItineraryParseResult } from "@/lib/itinerary/aiParser";
import type { ItineraryData, MealSlot, ScheduleItem } from "@/types";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/itinerary-golden");
const PDF_MARKERS = [
  "(1)일정(OZ)-견적용 (1)",
  "0417스페인 9일",
  "1[고객일정표] 오키나와 4일간_260504",
  "우아한여행_삼성물산_260610_상세일정표",
] as const;

interface RequiredItemField {
  dayNo?: number;
  contentIncludes: string;
  region?: string;
  transport?: string;
  time?: string;
}

interface RequiredFlight {
  departureIncludes?: string[];
  arrivalIncludes?: string[];
}

interface ExpectedFixture {
  marker: string;
  dayCount?: number;
  period?: {
    start: string;
    end: string;
  };
  dayDates?: Record<number, string>;
  requiredFlight?: RequiredFlight;
  requiredItemFields?: RequiredItemField[];
  forbiddenItemFields?: RequiredItemField[];
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

interface FixtureCase {
  name: string;
  absolutePath: string;
  expected: ExpectedFixture;
}

interface CandidateMetrics {
  label: string;
  source: string;
  qualityScore: number;
  dayCount: number;
  datedDayCount: number;
  meaningfulItemCount: number;
  mealCount: number;
  accommodationCount: number;
  hasFlight: boolean;
  hasVehicle: boolean;
  hasHotelSummary: boolean;
  expectationFailures: string[];
  parseMs: number;
  rawTextLength?: number;
  error?: string;
}

interface BenchmarkResult {
  testCase: FixtureCase;
  current: CandidateMetrics;
  opendataloader: CandidateMetrics;
  regressions: string[];
  improvements: string[];
}

const EXPECTATIONS: ExpectedFixture[] = [
  {
    marker: "(1)일정(OZ)-견적용 (1)",
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
  {
    marker: "0417스페인 9일",
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
  {
    marker: "1[고객일정표] 오키나와 4일간_260504",
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
  {
    marker: "우아한여행_삼성물산_260610_상세일정표",
    dayCount: 9,
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
];

function writeLine(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function normalizeName(value: string): string {
  return value.normalize("NFC");
}

function listFixtureCases(): FixtureCase[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter((name) => path.extname(name).toLowerCase() === ".pdf")
    .sort((left, right) => left.localeCompare(right));

  return files.map((name) => {
    const normalizedName = normalizeName(name);
    const expected = EXPECTATIONS.find((entry) => normalizedName.includes(entry.marker));
    if (!expected) {
      throw new Error(`PDF fixture expectation is missing: ${name}`);
    }
    return {
      name,
      absolutePath: path.join(FIXTURE_DIR, name),
      expected,
    };
  }).filter((entry) =>
    PDF_MARKERS.some((marker) => normalizeName(entry.name).includes(marker))
  );
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

function hotelTexts(itinerary: ItineraryData): string[] {
  return [
    itinerary.basics.accommodation.hotel,
    itinerary.basics.accommodation.grade,
    itinerary.basics.accommodation.occupancy,
    ...itinerary.days.flatMap((day) =>
      day.items
        .filter((item) => item.type === "ACCOMMODATION")
        .flatMap((item) => [item.content, item.hotel ?? ""]),
    ),
  ].filter((value) => value.trim().length > 0);
}

function includesText(values: string[], expected: string): boolean {
  return values.some((value) => value.includes(expected));
}

function findItems(itinerary: ItineraryData, field: RequiredItemField): ScheduleItem[] {
  return itinerary.days
    .filter((day) => field.dayNo === undefined || day.dayNo === field.dayNo)
    .flatMap((day) => day.items)
    .filter((item) => item.content.includes(field.contentIncludes));
}

function pushFieldMismatch(
  failures: string[],
  prefix: string,
  item: ScheduleItem | undefined,
  field: RequiredItemField,
): void {
  if (field.region !== undefined && item?.region !== field.region) {
    failures.push(`${prefix} region expected "${field.region}"`);
  }
  if (field.transport !== undefined && item?.transport !== field.transport) {
    failures.push(`${prefix} transport expected "${field.transport}"`);
  }
  if (field.time !== undefined && item?.time !== field.time) {
    failures.push(`${prefix} time expected "${field.time}"`);
  }
}

function expectationFailures(itinerary: ItineraryData, expected: ExpectedFixture): string[] {
  const failures: string[] = [];
  const texts = allItemTexts(itinerary);
  const hotels = hotelTexts(itinerary);

  if (expected.dayCount !== undefined && itinerary.days.length !== expected.dayCount) {
    failures.push(`dayCount expected ${expected.dayCount}, got ${itinerary.days.length}`);
  }
  if (expected.period && itinerary.overview.travelPeriod.start !== expected.period.start) {
    failures.push(`period start expected ${expected.period.start}, got ${itinerary.overview.travelPeriod.start}`);
  }
  if (expected.period && itinerary.overview.travelPeriod.end !== expected.period.end) {
    failures.push(`period end expected ${expected.period.end}, got ${itinerary.overview.travelPeriod.end}`);
  }
  for (const [dayNoText, date] of Object.entries(expected.dayDates ?? {})) {
    const dayNo = Number(dayNoText);
    const day = itinerary.days.find((candidate) => candidate.dayNo === dayNo);
    if (day?.date !== date) failures.push(`day ${dayNo} date expected ${date}, got ${day?.date ?? "missing"}`);
  }
  for (const required of expected.requiredFlight?.departureIncludes ?? []) {
    if (!itinerary.basics.flight.departure.includes(required)) failures.push(`departure missing "${required}"`);
  }
  for (const required of expected.requiredFlight?.arrivalIncludes ?? []) {
    if (!itinerary.basics.flight.arrival.includes(required)) failures.push(`arrival missing "${required}"`);
  }
  for (const field of expected.requiredItemFields ?? []) {
    const item = findItems(itinerary, field)[0];
    if (!item) {
      failures.push(`item missing "${field.contentIncludes}"`);
      continue;
    }
    pushFieldMismatch(failures, `item "${field.contentIncludes}"`, item, field);
  }
  for (const field of expected.forbiddenItemFields ?? []) {
    const items = findItems(itinerary, field);
    for (const item of items) {
      if (field.region !== undefined && item.region === field.region) {
        failures.push(`forbidden region "${field.region}" on "${field.contentIncludes}"`);
      }
      if (field.transport !== undefined && item.transport === field.transport) {
        failures.push(`forbidden transport "${field.transport}" on "${field.contentIncludes}"`);
      }
      if (field.time !== undefined && item.time === field.time) {
        failures.push(`forbidden time "${field.time}" on "${field.contentIncludes}"`);
      }
    }
  }
  for (const required of expected.requiredContents ?? []) {
    if (!includesText(texts, required)) failures.push(`content missing "${required}"`);
  }
  for (const meal of expected.requiredMeals ?? []) {
    const hasMeal = itinerary.days.some((day) =>
      day.items.some((item) => item.meal?.[meal.slot]?.includes(meal.valueIncludes)),
    );
    if (!hasMeal) failures.push(`${meal.slot} meal missing "${meal.valueIncludes}"`);
  }
  for (const hotel of expected.requiredHotels ?? []) {
    if (!includesText(texts, hotel)) failures.push(`hotel missing "${hotel}"`);
  }
  for (const forbidden of expected.forbiddenContents ?? []) {
    if (includesText(texts, forbidden)) failures.push(`forbidden content present "${forbidden}"`);
  }
  for (const forbidden of expected.forbiddenExactContents ?? []) {
    if (texts.some((value) => value === forbidden)) failures.push(`forbidden exact content present "${forbidden}"`);
  }
  for (const forbidden of expected.forbiddenHotels ?? []) {
    if (includesText(hotels, forbidden)) failures.push(`forbidden hotel present "${forbidden}"`);
  }
  for (const forbidden of expected.forbiddenNotes ?? []) {
    if (itinerary.basics.notes.includes(forbidden)) failures.push(`forbidden note present "${forbidden}"`);
  }
  for (const forbidden of expected.forbiddenVehicleContents ?? []) {
    if (itinerary.basics.flight.localVehicle.includes(forbidden)) {
      failures.push(`forbidden vehicle content present "${forbidden}"`);
    }
  }

  return failures;
}

function metricsFromResult(
  label: string,
  result: ItineraryParseResult,
  expected: ExpectedFixture,
  parseMs: number,
  rawTextLength?: number,
): CandidateMetrics {
  const coverage = result.diagnostics.fieldCoverage;
  return {
    label,
    source: result.diagnostics.source,
    qualityScore: result.diagnostics.qualityScore ?? 0,
    dayCount: coverage?.dayCount ?? result.itinerary.days.length,
    datedDayCount: coverage?.datedDayCount ?? 0,
    meaningfulItemCount: coverage?.meaningfulItemCount ?? 0,
    mealCount: coverage?.mealCount ?? 0,
    accommodationCount: coverage?.accommodationCount ?? 0,
    hasFlight: coverage?.hasFlight ?? false,
    hasVehicle: coverage?.hasVehicle ?? false,
    hasHotelSummary: coverage?.hasHotelSummary ?? false,
    expectationFailures: expectationFailures(result.itinerary, expected),
    parseMs,
    rawTextLength,
  };
}

function errorMetrics(label: string, error: unknown, parseMs: number): CandidateMetrics {
  const message = error instanceof Error ? error.message : String(error);
  return {
    label,
    source: "error",
    qualityScore: 0,
    dayCount: 0,
    datedDayCount: 0,
    meaningfulItemCount: 0,
    mealCount: 0,
    accommodationCount: 0,
    hasFlight: false,
    hasVehicle: false,
    hasHotelSummary: false,
    expectationFailures: [`error: ${message}`],
    parseMs,
    error: message,
  };
}

async function parseCurrent(testCase: FixtureCase): Promise<CandidateMetrics> {
  const startedAt = performance.now();
  try {
    Object.assign(process.env, {
      ACCESS_CODE: "test-code",
      OPENAI_API_KEY: "",
    });
    const { POST } = await import("../src/app/api/itinerary/parse/route");
    const bytes = readFileSync(testCase.absolutePath);
    const formData = new FormData();
    formData.append("file", new File([new Uint8Array(bytes)], testCase.name, { type: "application/pdf" }));
    formData.append("title", testCase.name.replace(/\.[^.]+$/u, ""));

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
      nextUrl: new URL("http://localhost/api/itinerary/parse?debug=1"),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = await response.json() as Partial<ItineraryParseResult> & { error?: string };
    if (!response.ok || !payload.itinerary || !payload.diagnostics) {
      throw new Error(payload.error ?? `current parser failed with status ${response.status}`);
    }
    return metricsFromResult("current", {
      itinerary: payload.itinerary,
      diagnostics: payload.diagnostics,
    }, testCase.expected, performance.now() - startedAt);
  } catch (error) {
    return errorMetrics("current", error, performance.now() - startedAt);
  }
}

async function parseOpenDataLoader(testCase: FixtureCase): Promise<CandidateMetrics> {
  const startedAt = performance.now();
  try {
    Object.assign(process.env, {
      OPENAI_API_KEY: "",
    });
    const rawText = await convert(testCase.absolutePath, {
      format: "markdown",
      toStdout: true,
      quiet: true,
      imageOutput: "off",
    });
    const { parseItineraryWithDiagnostics } = await import("../src/lib/itinerary/aiParser");
    const result = await parseItineraryWithDiagnostics({
      rawText,
      title: testCase.name.replace(/\.[^.]+$/u, ""),
    });
    return metricsFromResult("opendataloader-markdown", result, testCase.expected, performance.now() - startedAt, rawText.length);
  } catch (error) {
    return errorMetrics("opendataloader-markdown", error, performance.now() - startedAt);
  }
}

function newFailures(current: CandidateMetrics, candidate: CandidateMetrics): string[] {
  const currentFailures = new Set(current.expectationFailures);
  return candidate.expectationFailures.filter((failure) => !currentFailures.has(failure));
}

function compareCandidates(current: CandidateMetrics, candidate: CandidateMetrics): {
  regressions: string[];
  improvements: string[];
} {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const addedFailures = newFailures(current, candidate);

  if (candidate.error) regressions.push(`candidate error: ${candidate.error}`);
  if (candidate.dayCount < current.dayCount) regressions.push(`dayCount ${current.dayCount} -> ${candidate.dayCount}`);
  if (candidate.meaningfulItemCount < current.meaningfulItemCount) {
    regressions.push(`meaningfulItemCount ${current.meaningfulItemCount} -> ${candidate.meaningfulItemCount}`);
  }
  if (candidate.mealCount < current.mealCount) regressions.push(`mealCount ${current.mealCount} -> ${candidate.mealCount}`);
  if (candidate.accommodationCount < current.accommodationCount) {
    regressions.push(`accommodationCount ${current.accommodationCount} -> ${candidate.accommodationCount}`);
  }
  if (candidate.qualityScore <= current.qualityScore - 5) {
    regressions.push(`qualityScore ${current.qualityScore} -> ${candidate.qualityScore}`);
  }
  for (const failure of addedFailures) {
    regressions.push(`new expectation failure: ${failure}`);
  }

  if (candidate.qualityScore >= current.qualityScore + 5) {
    improvements.push(`qualityScore ${current.qualityScore} -> ${candidate.qualityScore}`);
  }
  if (candidate.meaningfulItemCount > current.meaningfulItemCount) {
    improvements.push(`meaningfulItemCount ${current.meaningfulItemCount} -> ${candidate.meaningfulItemCount}`);
  }
  if (candidate.mealCount > current.mealCount) improvements.push(`mealCount ${current.mealCount} -> ${candidate.mealCount}`);
  if (candidate.accommodationCount > current.accommodationCount) {
    improvements.push(`accommodationCount ${current.accommodationCount} -> ${candidate.accommodationCount}`);
  }
  if (candidate.expectationFailures.length < current.expectationFailures.length) {
    improvements.push(`expectationFailures ${current.expectationFailures.length} -> ${candidate.expectationFailures.length}`);
  }

  return { regressions, improvements };
}

function formatBool(value: boolean): string {
  return value ? "Y" : "N";
}

function formatMetric(metric: CandidateMetrics): string {
  return [
    metric.qualityScore,
    metric.dayCount,
    metric.meaningfulItemCount,
    metric.mealCount,
    metric.accommodationCount,
    formatBool(metric.hasFlight),
    formatBool(metric.hasVehicle),
    formatBool(metric.hasHotelSummary),
    metric.expectationFailures.length,
  ].join("/");
}

function printResultTable(results: BenchmarkResult[]): void {
  writeLine("| PDF | current q/day/item/meal/hotel/flight/vehicle/hotelSummary/fail | opendataloader | delta | status |");
  writeLine("|---|---:|---:|---:|---|");
  for (const result of results) {
    const delta = result.opendataloader.qualityScore - result.current.qualityScore;
    const status = result.regressions.length > 0 ? "REGRESSION" : result.improvements.length > 0 ? "IMPROVED" : "SAME";
    writeLine(`| ${normalizeName(result.testCase.name)} | ${formatMetric(result.current)} | ${formatMetric(result.opendataloader)} | ${delta >= 0 ? "+" : ""}${delta} | ${status} |`);
  }
}

function printDetails(results: BenchmarkResult[]): void {
  for (const result of results) {
    writeLine();
    writeLine(`## ${normalizeName(result.testCase.name)}`);
    writeLine(`- current: source=${result.current.source}, ${Math.round(result.current.parseMs)}ms`);
    writeLine(`- opendataloader: source=${result.opendataloader.source}, ${Math.round(result.opendataloader.parseMs)}ms, rawTextLength=${result.opendataloader.rawTextLength ?? 0}`);
    if (result.regressions.length > 0) {
      writeLine("- regressions:");
      for (const regression of result.regressions) writeLine(`  - ${regression}`);
    }
    if (result.improvements.length > 0) {
      writeLine("- improvements:");
      for (const improvement of result.improvements) writeLine(`  - ${improvement}`);
    }
    if (result.current.expectationFailures.length > 0) {
      writeLine("- current expectation failures:");
      for (const failure of result.current.expectationFailures) writeLine(`  - ${failure}`);
    }
    if (result.opendataloader.expectationFailures.length > 0) {
      writeLine("- opendataloader expectation failures:");
      for (const failure of result.opendataloader.expectationFailures) writeLine(`  - ${failure}`);
    }
  }
}

async function benchmarkCase(testCase: FixtureCase): Promise<BenchmarkResult> {
  const current = await parseCurrent(testCase);
  const opendataloader = await parseOpenDataLoader(testCase);
  const comparison = compareCandidates(current, opendataloader);
  return {
    testCase,
    current,
    opendataloader,
    regressions: comparison.regressions,
    improvements: comparison.improvements,
  };
}

async function main(): Promise<void> {
  const cases = listFixtureCases();
  if (cases.length !== PDF_MARKERS.length) {
    throw new Error(`Expected ${PDF_MARKERS.length} PDF fixtures, found ${cases.length}.`);
  }

  const results: BenchmarkResult[] = [];
  for (const testCase of cases) {
    results.push(await benchmarkCase(testCase));
  }

  const regressionCount = results.reduce((total, result) => total + result.regressions.length, 0);
  const improvementCount = results.reduce((total, result) => total + result.improvements.length, 0);
  const verdict = regressionCount === 0 && improvementCount > 0
    ? "ADOPT_CANDIDATE_FOR_FEATURE_FLAG"
    : "DO_NOT_ADOPT_YET";

  writeLine("# PDF Parser Benchmark");
  writeLine();
  writeLine(`Verdict: **${verdict}**`);
  writeLine(`Regression count: ${regressionCount}`);
  writeLine(`Improvement count: ${improvementCount}`);
  writeLine();
  printResultTable(results);
  printDetails(results);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
