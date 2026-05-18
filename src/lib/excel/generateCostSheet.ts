import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { QuoteCategory, QuoteData, QuoteItem } from "@/types";
import { addHanaTourLogo } from "@/lib/excel/logo";
import { formatDateDotInKorea, formatDateKorInKorea, todayInKorea } from "@/lib/date/korea";
import {
  DEFAULT_EXCHANGE_RATE_ID,
  calculateItemSubtotalKrw,
  getExchangeRateForItem,
  getQuoteExchangeRates,
} from "@/lib/quote/currency";

const STYLE = {
  font: "맑은 고딕",
  sizeBody: 9,
  sizeHeader: 9,
  headerBg: "FF5E27A5",
  categoryBg: "FFF3E8FF",
  totalBg: "FFEFEFEF",
  totalRed: "FFCC0000",
  border: "FF000000",
};

interface CostExportMeta {
  productName: string;
  bidCode: string;
}

type CostGroup = "항공" | "숙박" | "관광" | "식사" | "차량" | "가이드" | "기타";
const CATEGORY_ORDER: readonly CostGroup[] = [
  "항공",
  "숙박",
  "관광",
  "식사",
  "차량",
  "가이드",
  "기타",
];

type RowAlignment = "left" | "center" | "right";

const SEAL_STAMP_IMAGE_PATH = path.join(
  process.cwd(),
  "public",
  "images",
  "seal-in.png"
);

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

  try {
    sheet.mergeCells(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already merged") && !message.includes("이미 병합")) {
      throw error;
    }
  }
}

function setBorder(cell: ExcelJS.Cell, color = STYLE.border): void {
  cell.border = {
    top: { style: "thin", color: { argb: color } },
    left: { style: "thin", color: { argb: color } },
    bottom: { style: "thin", color: { argb: color } },
    right: { style: "thin", color: { argb: color } },
  };
}

function setRowBorder(row: ExcelJS.Row): void {
  for (let col = 1; col <= 8; col += 1) {
    setBorder(row.getCell(col));
  }
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

interface LegacyQuoteItemShape {
  location?: string;
  name?: string;
  detail?: string;
  content?: string;
  qtyAdult?: number;
  qty?: number;
  unitPrice?: number;
  quantity?: number;
  currencyRateId?: string;
  subtotal?: number;
  totalPriceKrw?: number;
}

function normalizeQuoteItem(item: QuoteItem, data: Pick<QuoteData, "exchangeRates">): QuoteItem {
  const legacy = item as Partial<LegacyQuoteItemShape>;
  const region = item.region?.trim() || legacy.location?.trim() || "";
  const date = item.date || "";
  const description =
    item.description?.trim() ??
    legacy.detail?.trim() ??
    legacy.name?.trim() ??
    legacy.content?.trim() ??
    "";
  const quantity = toFiniteNumber(
    item.quantity,
    toFiniteNumber(legacy.qtyAdult, toFiniteNumber(legacy.qty, 1))
  );
  const unitPrice = toFiniteNumber(item.unitPrice, 0);
  const currencyRateId = item.currencyRateId ?? legacy.currencyRateId ?? DEFAULT_EXCHANGE_RATE_ID;
  const exchangeRates = getQuoteExchangeRates(data);
  return {
    ...item,
    region,
    date,
    description,
    quantity,
    unitPrice,
    currencyRateId,
    subtotal: calculateItemSubtotalKrw({ quantity, unitPrice, currencyRateId }, exchangeRates),
  };
}

function setCellValue(
  cell: ExcelJS.Cell,
  value: string | number,
  opts: {
    bold?: boolean;
    align?: RowAlignment;
    valign?: "top" | "middle" | "bottom";
    wrap?: boolean;
    bg?: string | null;
    color?: string;
    size?: number;
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
  if (opts.bg) {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: opts.bg },
    };
  } else {
    delete cell.style.fill;
  }
  if (opts.showBorder ?? true) {
    setBorder(cell);
  } else {
    delete cell.style.border;
  }
}

function setHeaderCell(cell: ExcelJS.Cell, value: string): void {
  setCellValue(cell, value, {
    bold: true,
    align: "center",
    bg: STYLE.headerBg,
    size: STYLE.sizeBody,
    color: "FFFFFFFF",
  });
}

function toWon(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function toDateDot(input: string): string {
  return formatDateDotInKorea(input);
}

function toDateKor(input: string): string {
  return formatDateKorInKorea(input);
}

function getTodayDateString(): string {
  return todayInKorea();
}

function mapCostGroup(category: QuoteCategory | string): CostGroup {
  if (category === "FLIGHT") return "항공";
  if (category === "HOTEL") return "숙박";
  if (category === "SIGHTSEEING") return "관광";
  if (category === "MEAL") return "식사";
  if (category === "VEHICLE") return "차량";
  if (category === "GUIDE" || category === "가이드" || category === "guide") return "가이드";
  return "기타";
}

function sortAndGroupItems(data: QuoteData): Array<{ label: CostGroup; items: QuoteItem[]; subtotal: number }> {
  const grouped = new Map<CostGroup, QuoteItem[]>();
  const normalizedItems = data.items.map((item) => normalizeQuoteItem(item, data));
  for (const item of normalizedItems) {
    const group = mapCostGroup(item.category);
    const bucket = grouped.get(group);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(group, [item]);
    }
  }

  return CATEGORY_ORDER.flatMap((label) => {
    const groupedItems = grouped.get(label) ?? [];
    if (groupedItems.length === 0) return [];
    const subtotal = groupedItems.reduce((sum, item) => sum + toWon(item.subtotal), 0);
    return [{ label, items: groupedItems, subtotal }];
  });
}

function addHeader(
  sheet: ExcelJS.Worksheet,
  _data: QuoteData,
  _meta: CostExportMeta
): void {
  sheet.addRow([]);
  sheet.addRow([]);

  const row1 = sheet.getRow(1);
  const row2 = sheet.getRow(2);
  row1.height = 35;
  row2.height = 35;

  safeMergeCells(sheet, "A1:B2");
  safeMergeCells(sheet, "D1:F2");
  safeMergeCells(sheet, "G1:H2");

  addHanaTourLogo(sheet.workbook, sheet, {
    width: 160,
    colOffset: 0.12,
    rowOffset: 0.12,
  });

  setCellValue(sheet.getCell("D1"), "견적 산출 내역서", {
    bold: true,
    align: "center",
    size: 20,
    showBorder: false,
  });
  setCellValue(
    sheet.getCell("G1"),
    `견적 작성일: ${toDateDot(getTodayDateString())}`,
    {
      align: "right",
      bg: null,
      size: 9,
      showBorder: false,
    }
  );

  safeMergeCells(sheet, "A2:A2");
  sheet.getCell("D1").alignment = {
    ...sheet.getCell("D1").alignment,
    vertical: "middle",
    horizontal: "center",
  };
  sheet.getCell("G1").alignment = {
    ...sheet.getCell("G1").alignment,
    vertical: "middle",
    horizontal: "right",
  };

  sheet.getRow(3).height = 15;
}

function addSummaryTableHeaders(sheet: ExcelJS.Worksheet): void {
  const row = sheet.addRow([]);
  row.height = 18;
  setHeaderCell(row.getCell("A"), "항 목");
  setHeaderCell(row.getCell("B"), "지역");
  setHeaderCell(row.getCell("C"), "날 짜");
  setHeaderCell(row.getCell("D"), "상세내역");
  setHeaderCell(row.getCell("E"), "인원 / 개수");
  setHeaderCell(row.getCell("F"), "단가");
  setHeaderCell(row.getCell("G"), "합계(원)");
  setHeaderCell(row.getCell("H"), "건별합계");
}

function addCostRows(
  sheet: ExcelJS.Worksheet,
  groups: Array<{ label: CostGroup; items: QuoteItem[]; subtotal: number }>,
  data: Pick<QuoteData, "exchangeRates">
): number {
  let lastRow = sheet.rowCount;

  for (const group of groups) {
    const startRow = sheet.rowCount + 1;

    for (const [index, item] of group.items.entries()) {
      const normalized = normalizeQuoteItem(item, data);
      const currency = getExchangeRateForItem(getQuoteExchangeRates(data), normalized);
      const row = sheet.addRow([]);
      row.height = 16;

      if (index === 0) {
        setCellValue(row.getCell("A"), group.label, {
          bold: true,
          align: "center",
          bg: STYLE.categoryBg,
          size: STYLE.sizeBody,
        });
      } else {
        setCellValue(row.getCell("A"), "", {
          bold: false,
          align: "center",
          bg: STYLE.categoryBg,
          size: STYLE.sizeBody,
        });
      }
      const categoryCell = row.getCell("A");
      categoryCell.font = {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: index === 0,
        color: { argb: "FF000000" },
      };

      setCellValue(row.getCell("B"), normalized.region || "", {
        align: "center",
      });
      setCellValue(row.getCell("C"), normalized.date || "", {
        align: "center",
      });
      setCellValue(row.getCell("D"), normalized.description || "", {
        align: "left",
        wrap: true,
      });
      setCellValue(row.getCell("E"), normalized.quantity, {
        align: "right",
      });
      setCellValue(row.getCell("F"), `${currency.code} ${normalized.unitPrice.toLocaleString("ko-KR")}`, {
        align: "right",
      });
      setCellValue(row.getCell("G"), normalized.subtotal, {
        align: "right",
      });

      row.getCell("G").numFmt = "#,##0";
      row.getCell("E").numFmt = "#,##0";
      row.getCell("D").numFmt = "@";
      row.getCell("C").numFmt = "@";
      setRowBorder(row);
    }

    const endRow = sheet.rowCount;
    if (startRow <= endRow) {
      safeMergeCells(sheet, `A${startRow}:A${endRow}`);
      safeMergeCells(sheet, `H${startRow}:H${endRow}`);

      const totalCell = sheet.getCell(`H${startRow}`);
      totalCell.value = group.subtotal;
      totalCell.numFmt = "#,##0";
      totalCell.font = {
        name: STYLE.font,
        bold: true,
        size: STYLE.sizeBody,
        color: { argb: "FF000000" },
      };
      totalCell.alignment = { vertical: "middle", horizontal: "right" };

      const headerCell = sheet.getCell(`A${startRow}`);
      headerCell.alignment = { vertical: "middle", horizontal: "center" };
      headerCell.font = {
        name: STYLE.font,
        size: STYLE.sizeBody,
        bold: true,
        color: { argb: "FF000000" },
      };

      for (let r = startRow; r <= endRow; r += 1) {
        setRowBorder(sheet.getRow(r));
      }
    }

    lastRow = endRow;
  }

  return lastRow;
}

function addTotals(sheet: ExcelJS.Worksheet, data: QuoteData): void {
  const subtotal = toWon(data.summary.subtotal);
  const groundProfit = toWon(data.summary.groundProfit ?? 0);
  const agencyFee = toWon(data.summary.agencyFee);
  const agencyFeeWithGroundProfit = agencyFee + groundProfit;
  const vat = toWon(data.summary.vat);
  const total = data.summary.total === 0
    ? toWon(subtotal + groundProfit + agencyFee + vat)
    : toWon(data.summary.total);
  const summaryStartRow = sheet.rowCount + 1;
  const lines: Array<{ label: string; value: number; isTotal?: boolean }> = [
    { label: "항목소계", value: subtotal },
    { label: "여행사수수료", value: agencyFeeWithGroundProfit },
    { label: "VAT", value: vat },
    { label: "TOTAL", value: total, isTotal: true },
  ];

  const addSummaryLine = (line: { label: string; value: number; isTotal?: boolean }): void => {
    const row = sheet.addRow([]);
    row.height = 18;
    safeMergeCells(sheet, `B${row.number}:F${row.number}`);
    safeMergeCells(sheet, `G${row.number}:H${row.number}`);

    const labelCell = sheet.getCell(`B${row.number}`);
    labelCell.value = line.label;
    const isTotal = line.isTotal ?? false;
    labelCell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    labelCell.font = {
      name: STYLE.font,
      bold: isTotal,
      size: STYLE.sizeBody,
    };
    labelCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isTotal ? STYLE.totalBg : STYLE.categoryBg },
    };

    const valueCell = sheet.getCell(`G${row.number}`);
    valueCell.value = line.value;
    valueCell.numFmt = "#,##0";
    valueCell.alignment = {
      vertical: "middle",
      horizontal: "right",
    };
    valueCell.font = {
      name: STYLE.font,
      bold: isTotal,
      size: STYLE.sizeBody,
      color: isTotal ? { argb: STYLE.totalRed } : undefined,
    };
    if (line.isTotal) {
      valueCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: STYLE.totalBg },
      };
    } else {
      delete valueCell.style.fill;
    }
    setRowBorder(row);
  };

  for (const line of lines) {
    addSummaryLine(line);
  }

  const summaryEndRow = sheet.rowCount;
  safeMergeCells(sheet, `A${summaryStartRow}:A${summaryEndRow}`);
  const expectedCell = sheet.getCell(`A${summaryStartRow}`);
  setCellValue(expectedCell, "예상 총 경비", {
    bold: true,
    align: "center",
    size: STYLE.sizeBody,
    bg: STYLE.categoryBg,
  });
  expectedCell.alignment = {
    ...expectedCell.alignment,
    wrapText: true,
  };
}

function addStampGuide(sheet: ExcelJS.Worksheet, startLineRow: number): void {
  if (!existsSync(SEAL_STAMP_IMAGE_PATH)) {
    return;
  }

  try {
    const stampId = sheet.workbook.addImage({
      filename: SEAL_STAMP_IMAGE_PATH,
      extension: "png",
    });
    sheet.addImage(stampId, {
      tl: {
        col: 6.25,
        row: startLineRow - 1 + 0.05,
      },
      ext: {
        width: 52,
        height: 52,
      },
      editAs: "oneCell",
    });
  } catch {
    return;
  }
}

function addValidityNotice(sheet: ExcelJS.Worksheet, data: QuoteData): void {
  const validUntil = data.header.validUntil || data.header.writtenAt;
  const notice = `이 견적은 ${toDateKor(validUntil)} 까지만 유효합니다`;
  const row = sheet.addRow([]);
  row.height = 20;
  safeMergeCells(sheet, `B${row.number}:H${row.number}`);
  setCellValue(row.getCell("B"), notice, {
    align: "right",
    bold: true,
    size: 9,
    wrap: true,
    showBorder: false,
  });
}

function addFooter(sheet: ExcelJS.Worksheet): void {
  const spacer = sheet.addRow([]);
  spacer.height = 24;

  const lines = [
    "(주)하나투어",
    "서울시 종로구 인사동 5길 41",
    "TEL: 1577-1233 | FAX: 02-1234-5678",
  ];
  let footerLineRow = 0;

  for (const line of lines) {
    const row = sheet.addRow([line]);
    row.height = 18;
    if (footerLineRow === 0) {
      footerLineRow = row.number;
    }
    setCellValue(row.getCell("A"), line, {
      align: "left",
      size: 9,
      wrap: true,
      showBorder: false,
    });
    safeMergeCells(sheet, `A${row.number}:E${row.number}`);
  }

  if (footerLineRow > 0) {
    addStampGuide(sheet, footerLineRow);
  }
}

export async function generateCostWorkbook(
  data: QuoteData,
  meta: CostExportMeta
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("견적산출내역서", {
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
    { key: "item", width: 12 },
    { key: "region", width: 12 },
    { key: "date", width: 12 },
    { key: "desc", width: 35 },
    { key: "count", width: 10 },
    { key: "price", width: 15 },
    { key: "total", width: 15 },
    { key: "groupTotal", width: 15 },
  ];

  addHeader(worksheet, data, meta);
  addSummaryTableHeaders(worksheet);
  const grouped = sortAndGroupItems(data);
  addCostRows(worksheet, grouped, data);
  addTotals(worksheet, data);
  addValidityNotice(worksheet, data);
  addFooter(worksheet);

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ExcelJS.Buffer;
}
