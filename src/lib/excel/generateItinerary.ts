import ExcelJS from "exceljs";
import type { ItineraryData } from "@/types";
import { addHanaTourLogo } from "@/lib/excel/logo";
import { buildItineraryDisplayDays } from "@/lib/itinerary/itineraryDisplay";
import { formatDateDotInKorea, formatDateKorInKorea, todayInKorea } from "@/lib/date/korea";

const STYLE = {
  font: "맑은 고딕",
  sizeBody: 9,
  sizeTitle: 20,
  sizeHeader: 11,
  headerBg: "FF5E27A5",
  sectionTitleBg: "FFF3E8FF",
  categoryBg: "FFF3E8FF",
  detailBg: "FFF9FAFB",
  border: "FF000000",
  borderLight: "FFD1D5DB",
};

interface ItineraryExportMeta {
  productName: string;
  bidCode: string;
}

type BorderStyle = "thin" | "medium";

interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function mmToInch(mm: number): number {
  return mm / 25.4;
}

function toColumnIndex(column: string): number {
  let result = 0;
  for (const ch of column) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result;
}

function parseRange(range: string): CellRange | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
  if (!match) return null;
  const [, startCol, startRow, endCol, endRow] = match;
  const sRow = Number.parseInt(startRow, 10);
  const eRow = Number.parseInt(endRow, 10);
  if (Number.isNaN(sRow) || Number.isNaN(eRow)) return null;
  return {
    startRow: sRow,
    startCol: toColumnIndex(startCol.toUpperCase()),
    endRow: eRow,
    endCol: toColumnIndex(endCol.toUpperCase()),
  };
}

function rangesOverlap(left: CellRange, right: CellRange): boolean {
  return !(
    left.endRow < right.startRow ||
    left.startRow > right.endRow ||
    left.endCol < right.startCol ||
    left.startCol > right.endCol
  );
}

function hasMergedOverlap(sheet: ExcelJS.Worksheet, target: CellRange): boolean {
  const rawMerges = sheet.model?.merges;
  if (!Array.isArray(rawMerges)) {
    return false;
  }

  for (const raw of rawMerges) {
    if (typeof raw !== "string") continue;
    const merged = parseRange(raw);
    if (!merged) continue;
    if (rangesOverlap(merged, target)) {
      return true;
    }
  }

  return false;
}

function safeMergeCells(sheet: ExcelJS.Worksheet, range: string): void {
  const parsed = parseRange(range);
  if (!parsed) return;

  if (
    parsed.startRow > parsed.endRow ||
    parsed.startCol > parsed.endCol ||
    parsed.startRow < 1 ||
    parsed.startCol < 1
  ) {
    return;
  }

  if (hasMergedOverlap(sheet, parsed)) {
    return;
  }

  for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
    for (let col = parsed.startCol; col <= parsed.endCol; col += 1) {
      if (sheet.getCell(row, col).isMerged) {
        return;
      }
    }
  }

  try {
    sheet.mergeCells(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already merged")) {
      throw error;
    }
  }
}

function setCellBorder(cell: ExcelJS.Cell, kind: BorderStyle = "thin"): void {
  const color = kind === "medium" ? STYLE.border : STYLE.borderLight;
  cell.border = {
    top: { style: kind, color: { argb: color } },
    left: { style: kind, color: { argb: color } },
    bottom: { style: kind, color: { argb: color } },
    right: { style: kind, color: { argb: color } },
  };
}

function setCellValue(
  cell: ExcelJS.Cell,
  value: string | number | null,
  opts: {
    bold?: boolean;
    align?: "left" | "center" | "right";
    valign?: "top" | "middle" | "bottom";
    wrap?: boolean;
    size?: number;
    bg?: string | null;
    color?: string;
    showBorder?: boolean;
  } = {}
): void {
  cell.value = value;
  cell.font = {
    name: STYLE.font,
    size: opts.size ?? STYLE.sizeBody,
    bold: opts.bold ?? false,
    color: opts.color ? { argb: opts.color } : undefined,
  };
  cell.alignment = {
    vertical: opts.valign ?? "middle",
    horizontal: opts.align ?? "left",
    wrapText: opts.wrap ?? false,
  };
  if (opts.bg === null) {
    delete cell.style.fill;
  } else {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: opts.bg ?? "FFFFFFFF" },
    };
  }
  if (opts.showBorder ?? true) {
    setCellBorder(cell);
  } else {
    delete cell.style.border;
  }
}

function setHorizontalSpacerRowBorder(cell: ExcelJS.Cell): void {
  cell.border = {
    top: { style: "thin", color: { argb: STYLE.borderLight } },
    bottom: { style: "thin", color: { argb: STYLE.borderLight } },
  };
}

function clearBorderSides(
  cell: ExcelJS.Cell,
  options: {
    top?: boolean;
    right?: boolean;
    bottom?: boolean;
    left?: boolean;
  } = {}
): void {
  const current: Partial<ExcelJS.Borders> = cell.border ?? {};
  const next: Partial<ExcelJS.Borders> = { ...current };

  if (options.top) {
    delete next.top;
  }
  if (options.right) {
    delete next.right;
  }
  if (options.bottom) {
    delete next.bottom;
  }
  if (options.left) {
    delete next.left;
  }

  cell.border = next;
}

function formatDateDot(input: string): string {
  return formatDateDotInKorea(input);
}

function formatDateKor(input: string): string {
  return formatDateKorInKorea(input);
}

function getTodayDateString(): string {
  return todayInKorea();
}

function getDayLabel(dayNo: number, date: string): string {
  const day = new Date(date);
  if (Number.isNaN(day.getTime())) {
    return `제 ${dayNo} 일`;
  }
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][day.getDay()] ?? "";
  return `제 ${dayNo} 일\n${formatDateDot(date)}\n(${weekday})`;
}

function formatMoney(value: number): string {
  return value.toLocaleString("ko-KR");
}

function formatPassenger(data: ItineraryData["overview"]["passengers"]): string {
  return `성인 ${data.adult}, 아동 ${data.child}, 유아 ${data.infant}`;
}

function isHotelDetail(value: string, isHotelRow = false): boolean {
  if (isHotelRow) return true;
  if (!value) return false;
  return /\[(?:숙박|호텔)\]|(?:숙박|호텔)(?:\s|:|$)/u.test(value);
}

function buildHotelRichText(
  detail: string,
  isHotelRow = false
): Array<{ text: string; font?: Partial<ExcelJS.Font> }> {
  const trimmed = detail.trim();
  if (
    isHotelRow &&
    !/\[(?:숙박|호텔)\]|(?:숙박|호텔)(?:\s|:|$)/u.test(trimmed)
  ) {
    return [
      {
        text: "숙박 ",
        font: {
          name: STYLE.font,
          size: STYLE.sizeBody,
          bold: true,
        },
      },
      {
        text: trimmed,
        font: {
          name: STYLE.font,
          size: STYLE.sizeBody,
          bold: false,
        },
      },
    ];
  }

  const match = trimmed.match(/^\s*\[?(숙박|호텔)\]?\s*:?\s*(.*)$/u);
  if (!match) {
    return [
      {
        text: detail,
        font: {
          name: STYLE.font,
          size: STYLE.sizeBody,
          bold: false,
        },
      },
    ];
  }

  const label = match[1] ?? "";
  const rest = (match[2] ?? "").trim();
  const richText: Array<{ text: string; font?: Partial<ExcelJS.Font> }> = [];
  richText.push({
    text: `${label}${rest ? " " : ""}`,
    font: {
      name: STYLE.font,
      size: STYLE.sizeBody,
      bold: true,
    },
  });
  if (rest.length > 0) {
    richText.push({
      text: rest,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: false,
      },
    });
  }
  return richText;
}

function appendDescriptionRichText(
  richText: Array<{ text: string; font?: Partial<ExcelJS.Font> }>,
  description: string
): Array<{ text: string; font?: Partial<ExcelJS.Font> }> {
  const detail = description.trim();
  if (!detail) return richText;
  return [
    ...richText,
    {
      text: `${richText.length > 0 ? "\n" : ""}${detail}`,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: false,
      },
    },
  ];
}

function buildContentDetailRichText(
  content: string,
  description: string
): Array<{ text: string; font?: Partial<ExcelJS.Font> }> {
  const title = content.trim();
  const detail = description.trim();
  const richText: Array<{ text: string; font?: Partial<ExcelJS.Font> }> = [];
  if (title) {
    richText.push({
      text: title,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: true,
      },
    });
  }
  return appendDescriptionRichText(richText, detail);
}

function setItineraryDetailCell(
  cell: ExcelJS.Cell,
  detail: string,
  description: string,
  isHotel: boolean
): void {
  const value = detail || "";
  if (isHotelDetail(value, isHotel)) {
    setCellValue(cell, "", {
      wrap: true,
      align: "left",
      bg: STYLE.detailBg,
    });
    cell.value = { richText: appendDescriptionRichText(buildHotelRichText(value, isHotel), description) };
    return;
  }

  setCellValue(cell, "", {
    wrap: true,
    align: "left",
    bg: "FFFFFFFF",
  });
  cell.value = { richText: buildContentDetailRichText(value, description) };
}

function setMergedHeaderCell(
  sheet: ExcelJS.Worksheet,
  cell: ExcelJS.Cell,
  value: string
): void {
  setCellValue(cell, value, {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    size: STYLE.sizeBody,
    color: "FFFFFFFF",
  });
}

function setDayLabelCell(cell: ExcelJS.Cell, dayLabel: string): void {
  const lines = dayLabel.split("\n");
  const day = lines[0] ?? "";
  const date = lines[1] ?? "";
  const weekday = lines[2] ?? "";

  setCellValue(cell, "", {
    align: "center",
    wrap: true,
    size: STYLE.sizeBody,
    bg: "FFFFFFFF",
  });

  const richText: Array<{ text: string; font?: Partial<ExcelJS.Font> }> = [];

  if (day) {
    richText.push({
      text: day,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: true,
      },
    });
  }

  if (date) {
    if (richText.length > 0) {
      richText.push({ text: "\n" });
    }
    richText.push({
      text: date,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: false,
      },
    });
  }

  if (weekday) {
    if (richText.length > 0) {
      richText.push({ text: "\n" });
    }
    richText.push({
      text: weekday,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: false,
      },
    });
  }

  if (richText.length === 0) {
    richText.push({
      text: dayLabel,
      font: {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: true,
      },
    });
  }

  cell.value = { richText };
}

function setMealCellValue(cell: ExcelJS.Cell, value: string): void {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    setCellValue(cell, "", {
      align: "left",
      wrap: true,
      bg: "FFFFFFFF",
    });
    return;
  }

  setCellValue(cell, "", {
    align: "left",
    wrap: true,
    bg: "FFFFFFFF",
    size: STYLE.sizeBody,
  });

  const richText: Array<{ text: string; font?: Partial<ExcelJS.Font> }> = [];

  lines.forEach((line, index) => {
    const match = /^(조식|중식|석식)\s*[:：]?\s*(.*)$/.exec(line);
    if (match) {
      const label = match[1] ?? "";
      const detail = (match[2] ?? "").trim();
      richText.push({
        text: label,
        font: {
          name: STYLE.font,
          size: STYLE.sizeBody,
          bold: true,
        },
      });
      if (detail.length > 0) {
        richText.push({
          text: ` ${detail}`,
          font: {
            name: STYLE.font,
            size: STYLE.sizeBody,
            bold: false,
          },
        });
      }
    } else {
      richText.push({
        text: line,
        font: {
          name: STYLE.font,
          size: STYLE.sizeBody,
          bold: false,
        },
      });
    }

    if (index < lines.length - 1) {
      richText.push({ text: "\n" });
    }
  });

  cell.value = { richText };
}

function addItineraryHeader(
  sheet: ExcelJS.Worksheet,
  meta: ItineraryExportMeta
): void {
  sheet.addRow([]);
  sheet.addRow([]);
  const row1 = sheet.getRow(1);
  const row2 = sheet.getRow(2);
  row1.height = 35;
  row2.height = 35;

  safeMergeCells(sheet, "A1:B2");
  safeMergeCells(sheet, "C1:G2");
  safeMergeCells(sheet, "H1:I2");

  addHanaTourLogo(sheet.workbook, sheet, {
    width: 166,
    colOffset: 0.12,
    rowOffset: 0.18,
  });

  setCellValue(sheet.getCell("C1"), `${meta.productName} ${meta.bidCode}`, {
    bold: true,
    align: "center",
    size: STYLE.sizeTitle,
    bg: null,
    showBorder: false,
  });
  setCellValue(sheet.getCell("H1"), `견적 작성일: ${formatDateDot(getTodayDateString())}`, {
    align: "right",
    valign: "bottom",
    size: 9,
    bg: null,
    showBorder: false,
  });
  row1.getCell("C").alignment = {
    horizontal: "center",
    vertical: "middle",
    wrapText: true,
  };
  row2.getCell("C").alignment = {
    horizontal: "center",
    vertical: "middle",
    wrapText: true,
  };

  sheet.getRow(3).height = 15;
}

function addOverviewSection(sheet: ExcelJS.Worksheet, data: ItineraryData): void {
  const row5 = sheet.addRow([]);
  row5.height = 22;
  setCellValue(row5.getCell("A"), "수신", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `B${row5.number}:D${row5.number}`);
  setCellValue(row5.getCell("B"), data.overview.recipient);
  setCellValue(row5.getCell("E"), "여행도시", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  setCellValue(row5.getCell("F"), data.overview.cities, { wrap: true });
  setCellValue(row5.getCell("G"), "여행기간", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `H${row5.number}:I${row5.number}`);
  setCellValue(
    row5.getCell("H"),
    `${formatDateDot(data.overview.travelPeriod.start)} ~ ${formatDateDot(data.overview.travelPeriod.end)}`,
    { wrap: true, align: "left" }
  );

  const row6 = sheet.addRow([]);
  row6.height = 22;
  setCellValue(row6.getCell("A"), "인원", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `B${row6.number}:C${row6.number}`);
  setCellValue(row6.getCell("B"), formatPassenger(data.overview.passengers));
  setCellValue(row6.getCell("D"), "인솔자", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  setCellValue(row6.getCell("E"), `${data.overview.passengers.escort}명`);
  setCellValue(row6.getCell("F"), "FOC", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  setCellValue(row6.getCell("G"), `${data.overview.passengers.foc ?? 0}명`);
  setCellValue(row6.getCell("H"), "1인실 이용금액", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  const occupancy = data.basics?.accommodation?.occupancy?.trim() ?? "";
  setCellValue(row6.getCell("I"), occupancy.length > 0 ? occupancy : "", {
    align: "left",
    wrap: true,
  });

  const row7 = sheet.addRow([]);
  row7.height = 22;
  setCellValue(row7.getCell("A"), "여행 요금", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  setCellValue(row7.getCell("B"), "성인 인당", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  setCellValue(row7.getCell("C"), "아동 인당", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  setCellValue(row7.getCell("D"), "유아 인당", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `E${row7.number}:F${row7.number}`);
  setCellValue(row7.getCell("E"), "총 금액", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `G${row7.number}:I${row7.number}`);
  setCellValue(row7.getCell("G"), "카드 결제 시 금액", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
    wrap: false,
  });

  const row8 = sheet.addRow([]);
  row8.height = 22;
  setCellValue(row8.getCell("B"), `₩ ${formatMoney(data.overview.fare.adultPerPerson)}`, {
    align: "right",
  });
  setCellValue(
    row8.getCell("C"),
    data.overview.fare.childPerPerson > 0 ? `₩ ${formatMoney(data.overview.fare.childPerPerson)}` : "",
    { align: "right" }
  );
  setCellValue(
    row8.getCell("D"),
    data.overview.fare.infantPerPerson > 0
      ? `₩ ${formatMoney(data.overview.fare.infantPerPerson)}`
      : "",
    { align: "right" }
  );
  safeMergeCells(sheet, `E${row8.number}:F${row8.number}`);
  setCellValue(row8.getCell("E"), `₩ ${formatMoney(data.overview.fare.total)}`, { align: "right" });
  safeMergeCells(sheet, `G${row8.number}:I${row8.number}`);
  setCellValue(row8.getCell("G"), `₩ ${formatMoney(data.overview.fare.totalWithCard)}`, { align: "right" });
  safeMergeCells(sheet, `A${row7.number}:A${row8.number}`);
  clearBorderSides(row7.getCell("A"), { left: true });
  clearBorderSides(row8.getCell("G"), { right: true });

  const spacer = sheet.addRow([]);
  spacer.height = 6;
  for (let col = 1; col <= 9; col += 1) {
    const cell = spacer.getCell(col);
    setHorizontalSpacerRowBorder(cell);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFFFFF" },
    };
  }
}

function addSummaryTable(sheet: ExcelJS.Worksheet, data: ItineraryData): void {
  const accommodationHotel = data.basics.accommodation?.hotel ?? "";
  const accommodationGrade = data.basics.accommodation?.grade ?? "";
  const header = sheet.addRow([]);
  header.height = 20;
  setCellValue(header.getCell("A"), "구분", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    size: STYLE.sizeBody,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `B${header.number}:G${header.number}`);
  setCellValue(header.getCell("B"), "내용", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `H${header.number}:I${header.number}`);
  setCellValue(header.getCell("H"), "비고", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  clearBorderSides(header.getCell("A"), { left: true });
  clearBorderSides(header.getCell("H"), { right: true });

  const summaryNotes = data.basics.summaryNotes;
  const rows: Array<[string, string, string]> = [
    [
      "항공",
      `[출발] ${data.basics.flight.departure}\n[귀국] ${data.basics.flight.arrival}`,
      summaryNotes?.flight ?? "",
    ],
    [
      "차량",
      data.basics.flight.localVehicle,
      summaryNotes?.vehicle ?? "",
    ],
    [
      "숙박",
      `[호텔] ${accommodationHotel}\n[등급] ${accommodationGrade}\n[1객실 이용인원] ${data.basics.accommodation.occupancy}`,
      summaryNotes?.accommodation ?? "",
    ],
    ["포함사항", data.basics.included, summaryNotes?.included ?? ""],
    ["불포함사항", data.basics.excluded, summaryNotes?.excluded ?? ""],
    ["선택관광", data.basics.optionalTour, summaryNotes?.optionalTour ?? ""],
    ["쇼핑센터", `${data.basics.shoppingCenters}회`, summaryNotes?.shoppingCenters ?? ""],
  ];

  for (const [label, detail, note] of rows) {
    const row = sheet.addRow([]);
    row.height = 20;
    setCellValue(row.getCell("A"), label, {
      bold: true,
      align: label === "유의사항" ? "left" : "center",
      bg: STYLE.sectionTitleBg,
      wrap: false,
    });
    safeMergeCells(sheet, `B${row.number}:G${row.number}`);
    setCellValue(row.getCell("B"), detail, { wrap: true });
    safeMergeCells(sheet, `H${row.number}:I${row.number}`);
    setCellValue(row.getCell("H"), note, {
      wrap: true,
      align: "left",
    });
  }
}

function addDayRows(sheet: ExcelJS.Worksheet, days: ItineraryData["days"]): void {
  const spacer = sheet.addRow([]);
  spacer.height = 6;

  const header = sheet.addRow([]);
  header.height = 20;
  setMergedHeaderCell(sheet, header.getCell("A"), "일자");
  setMergedHeaderCell(sheet, header.getCell("B"), "지역");
  setMergedHeaderCell(sheet, header.getCell("C"), "교통편");
  setMergedHeaderCell(sheet, header.getCell("D"), "시간");
  safeMergeCells(sheet, `E${header.number}:G${header.number}`);
  setCellValue(header.getCell("E"), "세부일정", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });
  safeMergeCells(sheet, `H${header.number}:I${header.number}`);
  setCellValue(header.getCell("H"), "식사", {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    color: "FFFFFFFF",
  });

  for (const day of buildItineraryDisplayDays(days)) {
    const startRow = sheet.rowCount + 1;
    const dayRows = day.rows;
    const mealText = day.mealText.trim();
    const dayLabel = day.dayLabel || getDayLabel(day.dayNo, day.date);
    const hasMeal = mealText.length > 0;

    for (const [idx, row] of dayRows.entries()) {
      const tableRow = sheet.addRow([]);
      const detailLength = row.detail.length + row.detailDescription.length;
      tableRow.height = Math.max(18, 14 + Math.floor(detailLength / 58) * 4);
      if (idx === 0) {
        setDayLabelCell(tableRow.getCell("A"), dayLabel);
      } else {
        setCellValue(tableRow.getCell("A"), "", { align: "center", size: STYLE.sizeBody, wrap: true });
      }
      setCellValue(tableRow.getCell("B"), row.region, { align: "center", wrap: false });
      setCellValue(tableRow.getCell("C"), row.transport, { align: "center", wrap: false });
      setCellValue(tableRow.getCell("D"), row.time, { align: "center", wrap: false });

      safeMergeCells(sheet, `E${tableRow.number}:G${tableRow.number}`);
      setItineraryDetailCell(tableRow.getCell("E"), row.detail || "", row.detailDescription, row.isHotel);

      if (hasMeal) {
        setCellValue(tableRow.getCell("H"), "", { bg: "FFFFFFFF" });
      } else {
        safeMergeCells(sheet, `H${tableRow.number}:I${tableRow.number}`);
        if (idx === 0) {
          setMealCellValue(tableRow.getCell("H"), row.meal || "");
        } else {
          setCellValue(tableRow.getCell("H"), "", {
            wrap: true,
            align: "left",
            bg: "FFFFFFFF",
          });
        }
      }
    }

    const endRow = sheet.rowCount;
    safeMergeCells(sheet, `A${startRow}:A${endRow}`);
    if (hasMeal) {
      safeMergeCells(sheet, `H${startRow}:I${endRow}`);
      const mealCell = sheet.getCell(`H${startRow}`);
      setMealCellValue(mealCell, mealText);
      mealCell.alignment = {
        vertical: "middle",
        horizontal: "left",
        wrapText: true,
      };
    } else {
      for (let r = startRow; r <= endRow; r += 1) {
        sheet.getCell(`H${r}`).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFFFF" },
        };
      }
    }
  }

  const noteSpacer = sheet.addRow([]);
  noteSpacer.height = 6;
  for (let col = 1; col <= 9; col += 1) {
    const cell = noteSpacer.getCell(col);
    setHorizontalSpacerRowBorder(cell);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFFFFF" },
    };
  }
}

function addFooter(sheet: ExcelJS.Worksheet): void {
  sheet.addRow([]);
  const note = sheet.addRow([`상기 일정은 항공 및 현지 사정에 의해 다소 변경될 수 있습니다.`]);
  sheet.getRow(note.number).height = 18;
  safeMergeCells(sheet, `A${note.number}:I${note.number}`);
  setCellValue(note.getCell("A"), note.getCell("A").value?.toString() ?? "", {
    size: 9,
    align: "center",
    wrap: false,
    bg: null,
    showBorder: false,
  });

  sheet.addRow([]);
  const date = sheet.addRow([formatDateKor(getTodayDateString())]);
  sheet.getRow(date.number).height = 18;
  safeMergeCells(sheet, `A${date.number}:I${date.number}`);
  setCellValue(date.getCell("A"), date.getCell("A").value?.toString() ?? "", {
    align: "center",
    size: 11,
    bg: null,
    showBorder: false,
  });

  const signature = sheet.addRow(["(주) 하나투어"]);
  sheet.getRow(signature.number).height = 18;
  safeMergeCells(sheet, `A${signature.number}:I${signature.number}`);
  setCellValue(signature.getCell("A"), signature.getCell("A").value?.toString() ?? "", {
    bold: true,
    align: "center",
    size: 11,
    wrap: false,
    bg: null,
    showBorder: false,
  });
}

export async function generateItineraryWorkbook(
  data: ItineraryData,
  meta: ItineraryExportMeta
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("여행일정표", {
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: false,
      showGridLines: false,
      margins: {
        left: mmToInch(15),
        right: mmToInch(15),
        top: mmToInch(15),
        bottom: mmToInch(15),
        header: 0,
        footer: 0,
      },
    },
  });

  worksheet.columns = [
    { key: "day", width: 13 },
    { key: "region", width: 13 },
    { key: "transport", width: 13 },
    { key: "time", width: 13 },
    { key: "detail1", width: 13 },
    { key: "detail2", width: 13 },
    { key: "detail3", width: 13 },
    { key: "meal1", width: 13 },
    { key: "meal2", width: 13 },
  ];

  addItineraryHeader(worksheet, meta);
  addOverviewSection(worksheet, data);
  addSummaryTable(worksheet, data);
  addDayRows(worksheet, data.days);
  addFooter(worksheet);

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ExcelJS.Buffer;
}
