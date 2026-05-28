import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateItineraryWorkbook } from "@/lib/excel/generateItinerary";
import type { ItineraryData } from "@/types";

type RichTextRun = { text: string; font?: Partial<ExcelJS.Font> };
type RichTextValue = { richText: RichTextRun[] };

function isRichTextValue(value: ExcelJS.CellValue): value is RichTextValue {
  if (!value || typeof value !== "object" || !("richText" in value)) return false;
  const richText = (value as { richText?: unknown }).richText;
  return Array.isArray(richText)
    && richText.every((run) =>
      Boolean(run)
      && typeof run === "object"
      && "text" in run
      && typeof (run as { text?: unknown }).text === "string"
    );
}

function buildItinerary(items: ItineraryData["days"][number]["items"]): ItineraryData {
  return {
    header: {
      groupName: "테스트",
      writtenAt: "2026-05-28",
    },
    overview: {
      recipient: "테스트",
      cities: "테스트",
      travelPeriod: { start: "2026-05-28", end: "2026-05-28" },
      passengers: {
        adult: 1,
        child: 0,
        infant: 0,
        escort: 0,
        foc: 0,
      },
      fare: {
        adultPerPerson: 0,
        childPerPerson: 0,
        infantPerPerson: 0,
        total: 0,
        totalWithCard: 0,
      },
    },
    basics: {
      flight: { departure: "", arrival: "", localVehicle: "" },
      accommodation: { hotel: "", grade: "", occupancy: "" },
      included: "",
      excluded: "",
      optionalTour: "",
      shoppingCenters: 0,
      notes: "",
    },
    days: [
      {
        dayNo: 1,
        date: "2026-05-28",
        items,
      },
    ],
  };
}

describe("generateItineraryWorkbook", () => {
  it("does not style a plain hotel activity as a hotel label", async () => {
    const buffer = await generateItineraryWorkbook(
      buildItinerary([
        {
          id: "activity-1",
          type: "OTHER",
          content: "호텔 투숙 및 휴식",
        },
      ]),
      { productName: "테스트", bidCode: "" },
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet("여행일정표");
    expect(worksheet).toBeDefined();

    const detailValues: RichTextValue[] = [];
    worksheet?.eachRow((row) => {
      const value = row.getCell("E").value;
      if (isRichTextValue(value) && value.richText.some((run) => run.text.includes("호텔 투숙 및 휴식"))) {
        detailValues.push(value);
      }
    });

    const detailValue = detailValues[0];
    expect(detailValue?.richText).toHaveLength(1);
    expect(detailValue?.richText[0]?.text).toBe("호텔 투숙 및 휴식");
    expect(detailValue?.richText[0]?.font?.bold).toBe(true);
  });
});
