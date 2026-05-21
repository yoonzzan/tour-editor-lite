import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ExcelJS from "exceljs";
import JSZip from "jszip";
import type { NextRequest } from "next/server";

beforeEach(() => {
  process.env.ACCESS_CODE = "test-code";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("pdf-parse");
});

async function makeHwpxFile(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    "Contents/section0.xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<hp:sec xmlns:hp=\"http://www.hancom.co.kr/hwpml/2016/paragraph\">",
      "<hp:t>제1일 싱가포르</hp:t>",
      "<hp:t>조:호텔식</hp:t>",
      "<hp:t>오전 자유일정 후 가이드 미팅</hp:t>",
      "<hp:t>석:송파바쿠테</hp:t>",
      "<hp:t>HOTEL - Aloft Singapore Novena</hp:t>",
      "</hp:sec>",
    ].join(""),
  );
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  return new File([buffer], "singapore.hwpx", {
    type: "application/hwp+zip",
  });
}

async function makeXlsxWithDisplayedTimes(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("일정");
  worksheet.addRow(["제1일", "사마르칸트", "", "", "호텔 조식 후", "", "조:", "호텔식"]);
  worksheet.addRow(["", "", "아프로시압", new Date(1899, 11, 30, 16, 51), "사마르칸트 출발"]);
  worksheet.addRow(["", "타슈켄트", "", new Date(1899, 11, 30, 19, 17), "타슈켄트 도착"]);
  worksheet.getCell("D2").numFmt = "hh:mm";
  worksheet.getCell("D3").numFmt = "hh:mm";
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "samarkand.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithNumericTimeCell(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("일정");
  worksheet.addRow(["제 02일", "타슈켄트", "", "", "호텔 조식 후", "", "조:", "호텔식"]);
  worksheet.addRow(["3/18(화)", "", "", 10 / 24, "가이드 미팅", "", "중:", "현지식"]);
  worksheet.addRow(["", "", "", "", "타슈켄트에서 유명한 화이트 모스크 미노르 모스크", "", "석:", "현지식"]);
  worksheet.getCell("D2").numFmt = "hh:mm";
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "tashkent-time.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithMealAliasLabels(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("일정");
  worksheet.addRow(["제1일", "싱가포르", "전용버스", "", "호텔 아침 후", "", "아침:", "호텔식"]);
  worksheet.addRow(["", "싱가포르", "전용버스", "12:00", "국립박물관 견학", "", "점심", "현지식"]);
  worksheet.addRow(["", "싱가포르", "전용버스", "18:00", "야경 투어", "", "저녁:", "한식"]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "meal-aliases.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithSparseRows(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("일정");
  worksheet.getCell("A1").value = "제1일";
  worksheet.getCell("E1").value = "호텔 조식 후";
  worksheet.getCell("G1").value = "조:";
  worksheet.getCell("H1").value = "호텔식";
  worksheet.getCell("E2").value = "레기스탄 광장";
  worksheet.getCell("G2").value = "중:";
  worksheet.getCell("H2").value = "현지식";
  worksheet.getCell("E3").value = "숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*";
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "sparse.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithDateCells(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("일정");
  worksheet.addRow(["우즈베키스탄 6일", "일정표"]);
  worksheet.addRow(["일자(날짜)", "지역", "교통편", "시간", "내용", "", "조:", "식사"]);
  worksheet.addRow([1, new Date(2025, 2, 17), "OZ", "01:02", "인천 출발", "", "조:", "호텔식"]);
  worksheet.addRow(["", "", "전용버스", "", "가이드 미팅 후 호텔 이동"]);
  worksheet.addRow(["", "", "", "", "숙 소 : LOTTE CITY HOTEL TASHKENT PALAE 4*"]);
  worksheet.addRow([2, new Date(2025, 2, 18), "", "", "호텔 조식 후 사마르칸트 이동", "", "조:", "호텔식"]);
  worksheet.addRow(["", "", "", "", "숙 소 : HILTON GARDEN INN 4*"]);
  worksheet.addRow(["♣ 상기 일정은 항공 및 현지 사정에의해 변경될 수 있습니다. ♣"]);
  worksheet.getColumn(2).numFmt = "yyyy-mm-dd";
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "uzbekistan.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithScheduleOnLaterSheetAndMergedDay(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const invoice = workbook.addWorksheet("인보이스");
  invoice.addRow(["견적번호", "QA-TEST"]);
  invoice.addRow(["합계", 1234567]);

  const worksheet = workbook.addWorksheet("일정표");
  worksheet.addRow(["일자", "지역", "교통편", "시간", "세부일정", "식사"]);
  worksheet.addRow([1, "인천", "OZ", "10:00", "인천공항 출발"]);
  worksheet.addRow(["", "삿포로", "전용버스", "13:00", "신치토세 공항 도착", "중: 현지식"]);
  worksheet.addRow(["", "후라노", "전용버스", "15:30", "후라노 팜 도미타"]);
  worksheet.addRow([2, "삿포로", "전용버스", "09:00", "오타루 운하 관광", "조: 호텔식"]);
  worksheet.addRow(["", "", "", "", "숙 소 : SAPPORO GRAND HOTEL"]);
  worksheet.mergeCells("A2:A4");
  worksheet.getCell("A2").value = 1;

  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "later-sheet-merged.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithPrimaryScheduleAndNoisySampleSheets(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("일정표");
  worksheet.addRow(["일자", "지역", "교통편", "시간", "세부일정", "식사"]);
  worksheet.addRow([1, "인천", "KE093", "18:50", "인천 국제공항 출발"]);
  worksheet.addRow(["2025-04-21", "워싱턴", "", "19:40", "워싱턴공항(IAD) 도착 및 입국/세관 신고"]);
  worksheet.addRow(["", "", "", "", "가이드 미팅 후 이동", "석:현지식"]);
  worksheet.addRow(["", "", "", "", "HOTEL : SpringHill Suites Centreville Chantilly 또는 동급"]);

  const quote = workbook.addWorksheet("견적");
  quote.addRow(["호텔", "Springhill By Marriott Centreville/Chantilly또는 동급"]);
  quote.addRow(["식사", "조식: 호텔식 포함"]);

  const sample = workbook.addWorksheet("샘플일정");
  sample.addRow([1, "인천", "KE091", "17:55", "인천 국제공항 출발"]);
  sample.addRow(["", "", "전용차량", "", "[미팅보드: ]로 가이드 미팅", "", "중식: 현지식"]);
  sample.addRow(["", "", "", "Hotel:", "견적 호텔"]);

  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "primary-schedule-with-sample.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function makeXlsxWithPlainScheduleAndCostDetailSheets(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const schedule = workbook.addWorksheet("일정");
  schedule.addRow(["상품명", "", "", "도쿄4일"]);
  schedule.addRow(["일자", "지역", "교통편", "시간", "일정", "식사"]);
  schedule.addRow(["제1일", "인천", "전용차량", "10:00", "인천공항 출발"]);
  schedule.addRow(["10/17", "나리타", "전용차량", "13:00", "나리타 공항 도착 후 전용차량 탑승", "중: 현지식"]);
  schedule.addRow(["", "도쿄", "", "", "아사쿠사 센소지 및 나카미세 도오리", "석: 현지식"]);
  schedule.addRow(["제2일", "도쿄", "전용차량", "09:00", "호텔조식 후 전용차량 탑승", "조: 호텔식"]);
  schedule.addRow(["10/18", "하코네", "", "", "후지산 오합목"]);

  const detail = workbook.addWorksheet("상세");
  detail.addRow(["구분", "식당", "단가", "횟수", "인원", "합계"]);
  detail.addRow(["식사", "중식", 3000, 4, 27, 324000]);
  detail.addRow(["식사", "석식", 5000, 3, 27, 405000]);
  detail.addRow(["구분", "버스", "단가", "이용일", "대수", "합계"]);
  detail.addRow(["차량", "대형버스", 95000, 4, 1, 380000]);
  detail.addRow(["합 계", "", "", "", "", 3386700]);

  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "plain-schedule-with-cost-detail.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function readProgressEvents(response: Response): Promise<Array<{ stage?: string; message?: string; result?: unknown; error?: string }>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s?/u, ""))
        .join("\n");
      return JSON.parse(data) as { stage?: string; message?: string; result?: unknown; error?: string };
    });
}

describe("/api/itinerary/parse", () => {
  it("fast-parses well-structured text without AI and returns fast-text source", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("text", "1일차 2026-06-02\n- 이동 | 인천공항 출발\n- 식사 | 석식: 현지식\n- 숙박 | 테스트 호텔");

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: { days?: unknown[] };
      diagnostics?: {
        source?: string;
        qualityScore?: number;
        candidateScores?: unknown[];
      };
    };

    expect(response.headers.get("x-itinerary-parser-source")).toBe("fast-text");
    expect(payload.diagnostics?.source).toBe("fast-text");
    expect(payload.diagnostics?.qualityScore).toBeUndefined();
    expect(payload.diagnostics?.candidateScores).toBeUndefined();
    expect(payload.itinerary?.days?.length).toBeGreaterThan(0);
  });

  it("fast-parses direct input meal aliases as meal slots", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append(
      "text",
      [
        "1일차 2026-06-02",
        "- 식사 | 아침: 호텔식",
        "- 관광 | 국립박물관 견학",
        "- 식사 | 점심: 현지식",
        "- 식사 | 저녁: 한식",
      ].join("\n"),
    );

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            content?: string;
            mealSlot?: string;
            meal?: { breakfast?: string; lunch?: string; dinner?: string };
          }>;
        }>;
      };
    };

    const items = payload.itinerary?.days?.[0]?.items ?? [];
    expect(response.headers.get("x-itinerary-parser-source")).toBe("fast-text");
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
    expect(items.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("한식");
  });

  it("streams real parse progress events in progress mode", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("text", "1일차 2026-06-02\n- 이동 | 인천공항 출발\n- 식사 | 석식: 현지식\n- 숙박 | 테스트 호텔");

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
      nextUrl: new URL("http://localhost/api/itinerary/parse?progress=1"),
    } as unknown as NextRequest;

    const response = await POST(request);
    const events = await readProgressEvents(response);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(events.map((event) => event.stage)).toEqual([
      "received",
      "extracting",
      "completed",
    ]);
    expect(events[2]?.result).toBeDefined();
  });

  it("rejects legacy .xls files with a clear conversion message", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append(
      "file",
      new File(["legacy excel"], "singapore.xls", {
        type: "application/vnd.ms-excel",
      }),
    );

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            type?: string;
            mealSlot?: string;
            meal?: { breakfast?: string; dinner?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(response.status).toBe(422);
    expect(payload.error).toContain("구형 Excel(.xls)은 보안상 지원하지 않습니다");
  });

  it("extracts text from .hwpx files before parsing the itinerary", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeHwpxFile());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            type?: string;
            mealSlot?: string;
            meal?: { breakfast?: string; dinner?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    const items = payload.itinerary?.days?.[0]?.items ?? [];
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("송파바쿠테");
  });

  it("keeps displayed Excel time cells as HH:mm values", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithDisplayedTimes());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            type?: string;
            content?: string;
            time?: string;
            mealSlot?: string;
            meal?: { breakfast?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    const items = payload.itinerary?.days?.[0]?.items ?? [];
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.content?.includes("사마르칸트 출발"))?.time).toBe("16:51");
    expect(items.find((item) => item.content?.includes("타슈켄트 도착"))?.time).toBe("19:17");
  });

  it("keeps numeric Excel time cells as displayed HH:mm values", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithNumericTimeCell());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            content?: string;
            time?: string;
            mealSlot?: string;
            meal?: { breakfast?: string; lunch?: string; dinner?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    const items = payload.itinerary?.days?.[0]?.items ?? [];
    expect(items.find((item) => item.content === "가이드 미팅")?.time).toBe("10:00");
    expect(items.map((item) => item.content)).toContain("타슈켄트에서 유명한 화이트 모스크 미노르 모스크");
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
    expect(items.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("현지식");
  });

  it("parses uploaded spreadsheet meal aliases as breakfast lunch and dinner", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithMealAliasLabels());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            content?: string;
            mealSlot?: string;
            meal?: { breakfast?: string; lunch?: string; dinner?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    const items = payload.itinerary?.days?.[0]?.items ?? [];
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
    expect(items.find((item) => item.mealSlot === "dinner")?.meal?.dinner).toBe("한식");
    expect(items.map((item) => item.content)).toContain("국립박물관 견학");
    expect(items.map((item) => item.content)).toContain("야경 투어");
  });

  it("handles sparse Excel rows without failing on blank cells", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithSparseRows());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            mealSlot?: string;
            meal?: { breakfast?: string; lunch?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    const items = payload.itinerary?.days?.[0]?.items ?? [];
    expect(items.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
    expect(items.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
  });

  it("keeps numeric day rows and date cells out of itinerary content", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithDateCells());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          dayNo?: number;
          items?: Array<{
            type?: string;
            content?: string;
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(payload.itinerary?.days?.map((day) => day.dayNo)).toEqual([1, 2]);
    const dayOneContents = payload.itinerary?.days?.[0]?.items?.map((item) => item.content ?? "") ?? [];
    const dayTwoContents = payload.itinerary?.days?.[1]?.items?.map((item) => item.content ?? "") ?? [];
    expect(dayOneContents.some((content) => content.includes("우즈베키스탄"))).toBe(false);
    expect(dayOneContents.some((content) => content.includes("Mon Mar"))).toBe(false);
    expect(dayOneContents.some((content) => content.includes("상기 일정"))).toBe(false);
    expect(dayOneContents.some((content) => content.includes("1 |"))).toBe(false);
    expect(dayOneContents).toContain("LOTTE CITY HOTEL TASHKENT PALAE 4*");
    expect(dayOneContents).not.toContain("HILTON GARDEN INN 4*");
    expect(dayTwoContents).toContain("HILTON GARDEN INN 4*");
  });

  it("reads schedule data from later sheets and propagates merged day cells", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithScheduleOnLaterSheetAndMergedDay());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          dayNo?: number;
          items?: Array<{
            content?: string;
            mealSlot?: string;
            meal?: { breakfast?: string; lunch?: string };
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(payload.itinerary?.days?.map((day) => day.dayNo)).toEqual([1, 2]);
    const contents = payload.itinerary?.days?.flatMap((day) => day.items?.map((item) => item.content ?? "") ?? []) ?? [];
    expect(contents).toContain("후라노 팜 도미타");
    expect(contents).toContain("SAPPORO GRAND HOTEL");
    const dayOneItems = payload.itinerary?.days?.[0]?.items ?? [];
    const dayTwoItems = payload.itinerary?.days?.[1]?.items ?? [];
    expect(dayOneItems.find((item) => item.mealSlot === "lunch")?.meal?.lunch).toBe("현지식");
    expect(dayTwoItems.find((item) => item.mealSlot === "breakfast")?.meal?.breakfast).toBe("호텔식");
  });

  it("uses the primary schedule sheet instead of quote or sample itinerary sheets", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithPrimaryScheduleAndNoisySampleSheets());
    formData.append("title", "미동부 테스트");

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
      nextUrl: new URL("http://localhost/api/itinerary/parse?debug=1"),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{ content?: string; detail?: string; hotel?: string }>;
        }>;
      };
    };

    const itemText = payload.itinerary?.days
      ?.flatMap((day) => day.items ?? [])
      .flatMap((item) => [item.content ?? "", item.detail ?? "", item.hotel ?? ""])
      .join("\n") ?? "";

    expect(response.status).toBe(200);
    expect(itemText).toContain("워싱턴공항(IAD) 도착");
    expect(itemText).toContain("SpringHill Suites Centreville Chantilly");
    expect(itemText).not.toContain("견적 호텔");
    expect(itemText).not.toContain("[미팅보드");
    expect(itemText).not.toContain("Springhill By Marriott Centreville/Chantilly");
  });

  it("treats a plain 일정 sheet as primary and excludes cost detail sheets", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", await makeXlsxWithPlainScheduleAndCostDetailSheets());

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{ content?: string }>;
        }>;
      };
      error?: string;
    };

    const itemText = payload.itinerary?.days
      ?.flatMap((day) => day.items ?? [])
      .map((item) => item.content ?? "")
      .join("\n") ?? "";

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(itemText).toContain("나리타 공항 도착");
    expect(itemText).toContain("후지산 오합목");
    expect(itemText).not.toContain("대형버스");
    expect(itemText).not.toContain("3386700");
    expect(itemText).not.toContain("3000 | 4 | 27");
  });

  it("routes pasted spreadsheet text through the tabular parser instead of direct narrative parsing", async () => {
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append(
      "text",
      [
        "[sheet:일정]",
        "일자\t지역\t교통편\t시간\t일정\t식사",
        "제1일\t인천\t전용차량\t10:00\t인천공항 출발",
        "10/17\t나리타\t전용차량\t13:00\t나리타 공항 도착 후 전용차량 탑승\t중: 현지식",
        "",
        "[sheet:상세]",
        "구분\t식당\t단가\t횟수\t인원\t합계",
        "식사\t중식\t3000\t4\t27\t324000",
      ].join("\n"),
    );

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
      nextUrl: new URL("http://localhost/api/itinerary/parse?debug=1"),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      diagnostics?: { source?: string; selectedCandidate?: string };
      itinerary?: {
        days?: Array<{
          items?: Array<{ content?: string }>;
        }>;
      };
      error?: string;
    };

    const itemText = payload.itinerary?.days
      ?.flatMap((day) => day.items ?? [])
      .map((item) => item.content ?? "")
      .join("\n") ?? "";

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(payload.diagnostics?.source).toBe("fallback-no-key");
    expect(payload.diagnostics?.selectedCandidate).toBe("deterministic-tabular");
    expect(itemText).toContain("나리타 공항 도착");
    expect(itemText).not.toContain("나리타 공항 도착 후 전용차량 탑승 나리타 공항 도착 후 전용차량 탑승");
    expect(itemText).not.toContain("3000 4 27 324000");
  });

  it("uses OCR fallback when uploaded PDF has no extractable text", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();

    const getText = vi.fn(async () => ({ text: "\n-- 1 of 2 --\n\n-- 2 of 2 --\n" }));
    const getScreenshot = vi.fn(async () => ({
      pages: [
        { dataUrl: "data:image/png;base64,page-one" },
        { dataUrl: "data:image/png;base64,page-two" },
      ],
    }));
    const destroy = vi.fn(async () => undefined);

    vi.doMock("pdf-parse", () => ({
      PDFParse: vi.fn(() => ({
        getText,
        getScreenshot,
        destroy,
      })),
    }));

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: unknown }>;
        response_format?: { type: string };
      };
      const firstContent = body.messages?.[0]?.content;

      if (Array.isArray(firstContent)) {
        return Response.json({
          choices: [
            {
              message: {
                content: "제1일 | 상해 | 전용버스 | 09:00 | 상해 도착 후 호텔 이동\n제2일 | 항주 | 전용버스 | 10:00 | 서호 관광",
              },
            },
          ],
        });
      }

      if (!body.response_format) {
        return Response.json({
          choices: [
            {
              message: {
                content: `[AI 분석 결과]
상품명: 상해항주황산 테스트
출발일: 2026-04-05

[일차별 일정]
1일차 | TRANSFER | 상해 도착 후 호텔 이동 |  | 09:00 |
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
                overview: { travelPeriod: { start: "2026-04-05", end: "2026-04-06" } },
                days: [
                  { dayNo: 1, items: [{ type: "TRANSFER", time: "09:00", content: "상해 도착 후 호텔 이동" }] },
                  { dayNo: 2, items: [{ type: "SIGHTSEEING", time: "10:00", content: "서호 관광" }] },
                ],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", new File(["fake pdf"], "scan.pdf", { type: "application/pdf" }));

    const request = {
      headers: new Headers({ "x-access-code": "test-code" }),
      formData: async () => formData,
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      itinerary?: {
        days?: Array<{
          items?: Array<{
            content?: string;
          }>;
        }>;
      };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(getScreenshot).toHaveBeenCalledWith({
      desiredWidth: 1600,
      first: 6,
      imageBuffer: false,
      imageDataUrl: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const contents = payload.itinerary?.days?.flatMap((day) => day.items?.map((item) => item.content ?? "") ?? []) ?? [];
    expect(contents).toContain("상해 도착 후 호텔 이동");
    expect(contents).toContain("서호 관광");
  });
});
