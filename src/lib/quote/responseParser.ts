import { v4 as uuidv4 } from "uuid";
import type { QuoteData, QuoteExchangeRate, QuoteItem } from "@/types";
import {
  DEFAULT_EXCHANGE_RATE,
  DEFAULT_EXCHANGE_RATE_ID,
  recalculateQuoteData,
} from "@/lib/quote/currency";
import { currentYearInKorea, todayInKorea } from "@/lib/date/korea";

type QuoteAnswerKind = "AIR" | "LND" | "FEE" | "SUM" | "TEXT";
type CurrencyCode = "KRW" | "USD" | "JPY";

export interface QuoteResponseDayDate {
  dayNo: number;
  date: string;
}

export interface QuoteAnswerSummaryRaw {
  currKndCd: CurrencyCode;
  untAmt: number;
  persPerFare: number;
  add1Amt: number;
  totalSum: number;
  vldtDttm?: string;
}

export interface QuoteAnswerFactorRaw {
  ansrKndCd: QuoteAnswerKind;
  fareNm: string;
  persPerFare: number;
  add1Amt: number;
  totlAmt: number;
  ptclrMtrCont: string;
  currencyCode: CurrencyCode;
}

export interface QuoteAnswerRaw {
  summary: QuoteAnswerSummaryRaw;
  factors: QuoteAnswerFactorRaw[];
  remarks: string;
}

export interface QuoteResponseDiagnostics {
  source: "quote-response-text" | "quote-response-ocr";
  confidence: "high" | "medium" | "low";
  warnings: string[];
  requiredCurrencyCodes: CurrencyCode[];
  raw: QuoteAnswerRaw;
}

export interface QuoteResponseParseResult {
  quote: QuoteData;
  extractedText: string;
  diagnostics: QuoteResponseDiagnostics;
}

export interface ParseQuoteResponseTextInput {
  text: string;
  dayDates?: QuoteResponseDayDate[];
  passengerCount?: number;
  quoteHeader?: QuoteData["header"];
}

interface MoneyValue {
  amount: number;
  currencyCode: CurrencyCode;
}

interface MoneyOccurrence extends MoneyValue {
  raw: string;
  index: number;
}

interface LabeledMoneyValue extends MoneyValue {
  found: boolean;
}

interface BasicAmountSpec {
  ansrKndCd: QuoteAnswerKind;
  fareNm: string;
  label: RegExp;
}

const ZERO_MONEY: LabeledMoneyValue = { amount: 0, currencyCode: "KRW", found: false };

const BASIC_LABEL_PATTERN =
  /(?:항공\s*요금|항공요금|항공료|TAX|합계|지상\s*요금|지상요금|지상비|랜드수익|공동\s*경비\s*요금|공동경비\s*요금|TC\s*비용|인솔자비|(?<![\p{L}\p{N}])FOC(?![\p{L}\p{N}])|보험료|기타|요금[12]|답변\s*첨부파일|첨부파일|최종\s*안내사항|유효기간)/iu;

const AIR_AMOUNT_SPECS: BasicAmountSpec[] = [
  { ansrKndCd: "AIR", fareNm: "항공료", label: /항공료/iu },
  { ansrKndCd: "AIR", fareNm: "TAX", label: /TAX/iu },
];

const LND_AMOUNT_SPECS: BasicAmountSpec[] = [
  { ansrKndCd: "LND", fareNm: "지상비", label: /지상비/iu },
  { ansrKndCd: "LND", fareNm: "랜드수익", label: /랜드수익/iu },
];

const FEE_AMOUNT_SPECS: BasicAmountSpec[] = [
  { ansrKndCd: "FEE", fareNm: "인솔자비", label: /인솔자비/iu },
  { ansrKndCd: "FEE", fareNm: "FOC", label: /(?<![\p{L}\p{N}])FOC(?![\p{L}\p{N}])/iu },
  { ansrKndCd: "FEE", fareNm: "보험료", label: /보험료/iu },
  { ansrKndCd: "FEE", fareNm: "기타", label: /기타/iu },
];

function normalizeText(text: string): string {
  return text
    .replace(/\uFEFF/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/[^\d.-]/gu, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function detectCurrency(symbolBefore = "", symbolAfter = ""): CurrencyCode {
  const token = `${symbolBefore} ${symbolAfter}`.toUpperCase();
  if (token.includes("$") || token.includes("USD") || token.includes("US$")) return "USD";
  if (token.includes("¥") || token.includes("JPY") || token.includes("엔")) return "JPY";
  return "KRW";
}

function exchangeRateIdForCurrency(code: CurrencyCode): string {
  return code === "KRW" ? DEFAULT_EXCHANGE_RATE_ID : code.toLowerCase();
}

function parseFirstMoney(text: string): MoneyValue | null {
  return parseMoneyOccurrences(text, { requireExplicitUnit: false })[0] ?? null;
}

function parseMoneyOccurrences(
  text: string,
  options: { requireExplicitUnit: boolean },
): MoneyOccurrence[] {
  const matches: MoneyOccurrence[] = [];
  const moneyPattern = /(US\$|USD|\$|KRW|JPY|¥)?\s*([+-]?\d[\d,]*)(?:\s*(억원|만원|원|KRW|USD|US\$|JPY|¥|엔|\$))?/giu;

  for (const match of text.matchAll(moneyPattern)) {
    if (!match[2]) continue;
    const prefixUnit = match[1] ?? "";
    const suffixUnit = match[3] ?? "";
    if (options.requireExplicitUnit && !prefixUnit && !suffixUnit) continue;

    const raw = match[0];
    const multiplier =
      suffixUnit === "억원" ? 100000000 :
        suffixUnit === "만원" ? 10000 :
          1;
    matches.push({
      amount: toNumber(match[2]) * multiplier,
      currencyCode: detectCurrency(prefixUnit, `${raw} ${suffixUnit}`),
      raw,
      index: match.index,
    });
  }

  return matches;
}

function parseLeadingMoney(text: string): MoneyValue | null {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return null;

  const money = parseMoneyOccurrences(line, { requireExplicitUnit: false })[0];
  if (!money) return null;
  if (line.slice(0, money.index).trim()) return null;

  const nextChar = line.slice(money.index + money.raw.length).trimStart().charAt(0);
  if (/[./]/u.test(nextChar)) return null;

  return {
    amount: money.amount,
    currencyCode: money.currencyCode,
  };
}

function amountAfterLabel(text: string, label: RegExp): number {
  const match = label.exec(text);
  if (!match) return 0;
  const afterLabel = text.slice(match.index + match[0].length);
  return parseFirstMoney(afterLabel)?.amount ?? 0;
}

function asGlobalRegex(pattern: RegExp): RegExp {
  const flags = new Set(pattern.flags.split(""));
  flags.add("g");
  flags.add("u");
  return new RegExp(pattern.source, Array.from(flags).join(""));
}

function segmentAfterLabel(text: string, matchEnd: number): string {
  const afterLabel = text.slice(matchEnd);
  const nextLabel = BASIC_LABEL_PATTERN.exec(afterLabel);
  return nextLabel ? afterLabel.slice(0, nextLabel.index) : afterLabel;
}

function bestLabeledMoney(text: string, label: RegExp): LabeledMoneyValue {
  let best: LabeledMoneyValue = ZERO_MONEY;
  for (const match of text.matchAll(asGlobalRegex(label))) {
    const money = parseLeadingMoney(segmentAfterLabel(text, match.index + match[0].length));
    if (!money) continue;
    if (!best.found || money.amount > best.amount) {
      best = { ...money, found: true };
    }
  }
  return best;
}

function sectionText(text: string, start: RegExp, end: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch) return text;
  const afterStart = text.slice(startMatch.index);
  const endMatch = end.exec(afterStart.slice(startMatch[0].length));
  if (!endMatch) return afterStart;
  return afterStart.slice(0, startMatch[0].length + endMatch.index);
}

function sectionLeadingAmount(section: string, start: RegExp): number {
  const match = start.exec(section);
  if (!match) return 0;
  return parseFirstMoney(segmentAfterLabel(section, match.index + match[0].length))?.amount ?? 0;
}

function parseDateToken(text: string): string | undefined {
  const match = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})(?:\s*일)?/u.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match?.[1] || !match[2] || !match[3]) return "";
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  const next = new Date(utc);
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

function parseTravelDateMap(text: string, fallbackDates: Map<number, string>): Map<number, string> {
  const explicitRange = /(?:날짜|일자)\s*[:：]?\s*(?:(\d{4})[./-])?(\d{1,2})\s*[./-]\s*(\d{1,2})\s*(?:~|-|부터)\s*(?:(\d{4})[./-])?(\d{1,2})\s*[./-]\s*(\d{1,2})/u.exec(text);
  if (!explicitRange?.[2] || !explicitRange[3] || !explicitRange[5] || !explicitRange[6]) return fallbackDates;

  const startYear = toNumber(explicitRange[1]) || currentYearInKorea();
  const startMonth = toNumber(explicitRange[2]);
  const startDay = toNumber(explicitRange[3]);
  const endYear = toNumber(explicitRange[4]) || startYear;
  const endMonth = toNumber(explicitRange[5]);
  const endDay = toNumber(explicitRange[6]);
  if (startMonth <= 0 || startDay <= 0 || endMonth <= 0 || endDay <= 0) return fallbackDates;

  const startDate = formatDate(startYear, startMonth, startDay);
  const endDate = formatDate(endYear, endMonth, endDay);
  const result = new Map<number, string>();
  for (let index = 0; index < 31; index += 1) {
    const date = addDays(startDate, index);
    if (!date) break;
    result.set(index + 1, date);
    if (date === endDate) break;
  }

  return result.size > 0 ? result : fallbackDates;
}

function parseSummary(text: string): QuoteAnswerSummaryRaw {
  const validUntilLine = text
    .split("\n")
    .find((line) => /유효기간|유효합니다/u.test(line));
  const currencyLine = text
    .split("\n")
    .find((line) => /환율기준|KRW|USD|JPY/u.test(line));
  const currencyCode = /USD/u.test(currencyLine ?? "")
    ? "USD"
    : /JPY|¥|엔/u.test(currencyLine ?? "")
      ? "JPY"
      : "KRW";

  return {
    currKndCd: currencyCode,
    untAmt: amountAfterLabel(currencyLine ?? "", /(?:환율기준|KRW|USD|JPY)/u),
    persPerFare: amountAfterLabel(text, /1\s*인당\s*NET/iu),
    add1Amt: amountAfterLabel(text, /(?:1\s*인당\s*)?예상수익/u),
    totalSum: amountAfterLabel(text, /(?:최종합계|최종\s*입금가)/u),
    vldtDttm: validUntilLine ? parseDateToken(validUntilLine) : undefined,
  };
}

function makeFactor(
  ansrKndCd: QuoteAnswerKind,
  fareNm: string,
  persPerFare: number,
  add1Amt: number,
  totlAmt: number,
  ptclrMtrCont: string,
  currencyCode: CurrencyCode = "KRW",
): QuoteAnswerFactorRaw {
  return {
    ansrKndCd,
    fareNm,
    persPerFare,
    add1Amt,
    totlAmt,
    ptclrMtrCont,
    currencyCode,
  };
}

function parseFactorLines(text: string): QuoteAnswerFactorRaw[] {
  const factors: QuoteAnswerFactorRaw[] = [];
  const normalized = text.replace(/[ \t]+/gu, " ");
  const airSection = sectionText(normalized, /항공\s*요금|항공요금/iu, /지상\s*요금|지상요금|공동\s*경비\s*요금|공동경비\s*요금|답변\s*첨부파일|첨부파일/iu);
  const landSection = sectionText(normalized, /지상\s*요금|지상요금/iu, /공동\s*경비\s*요금|공동경비\s*요금|답변\s*첨부파일|첨부파일/iu);
  const feeSection = sectionText(normalized, /공동\s*경비\s*요금|공동경비\s*요금|TC\s*비용/iu, /답변\s*첨부파일|첨부파일/iu);

  for (const spec of AIR_AMOUNT_SPECS) {
    const money = bestLabeledMoney(airSection, spec.label);
    if (money.found) factors.push(makeFactor(spec.ansrKndCd, spec.fareNm, spec.fareNm === "항공료" ? money.amount : 0, spec.fareNm === "TAX" ? money.amount : 0, money.amount, "", money.currencyCode));
  }

  for (const spec of LND_AMOUNT_SPECS) {
    const money = bestLabeledMoney(landSection, spec.label);
    if (money.found) factors.push(makeFactor(spec.ansrKndCd, spec.fareNm, spec.fareNm === "지상비" ? money.amount : 0, spec.fareNm === "랜드수익" ? money.amount : 0, money.amount, "", money.currencyCode));
  }

  const feeTotal = sectionLeadingAmount(feeSection, /공동\s*경비\s*요금|공동경비\s*요금|TC\s*비용/iu);
  const feeMoneys = FEE_AMOUNT_SPECS.map((spec) => ({
    spec,
    money: bestLabeledMoney(feeSection, spec.label),
  }));
  const feeSubtotalWithoutEtc = feeMoneys
    .filter((entry) => entry.spec.fareNm !== "기타" && entry.money.found)
    .reduce((sum, entry) => sum + entry.money.amount, 0);

  for (const { spec, money } of feeMoneys) {
    if (!money.found) continue;
    const duplicatedTotalAsEtc =
      spec.fareNm === "기타" &&
      feeTotal > 0 &&
      money.amount === feeTotal &&
      feeSubtotalWithoutEtc === feeTotal;
    const amount = duplicatedTotalAsEtc ? 0 : money.amount;
    factors.push(makeFactor(spec.ansrKndCd, spec.fareNm, amount, 0, amount, "", money.currencyCode));
  }

  return dedupeFactors(factors);
}

function dedupeFactors(factors: QuoteAnswerFactorRaw[]): QuoteAnswerFactorRaw[] {
  const seen = new Set<string>();
  return factors.filter((factor) => {
    const key = `${factor.ansrKndCd}:${factor.fareNm}:${factor.totlAmt}:${factor.ptclrMtrCont}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dayDateMap(dayDates: QuoteResponseDayDate[] | undefined): Map<number, string> {
  const map = new Map<number, string>();
  for (const entry of dayDates ?? []) {
    if (entry.dayNo > 0 && /^\d{4}-\d{2}-\d{2}$/u.test(entry.date)) {
      map.set(entry.dayNo, entry.date);
    }
  }
  return map;
}

function buildItem(params: {
  category: QuoteItem["category"];
  description: string;
  quantity: number;
  unitPrice: number;
  currencyCode?: CurrencyCode;
  date?: string;
  region?: string;
}): QuoteItem {
  const currencyCode = params.currencyCode ?? "KRW";
  return {
    id: uuidv4(),
    category: params.category,
    region: params.region ?? "",
    date: params.date ?? "",
    description: params.description.trim(),
    quantity: Math.max(1, Math.round(params.quantity)),
    unitPrice: Math.max(0, Math.round(params.unitPrice)),
    currencyRateId: exchangeRateIdForCurrency(currencyCode),
    subtotal: 0,
  };
}

function parseMealItems(text: string, passengerCount: number, dates: Map<number, string>): QuoteItem[] {
  const items: QuoteItem[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let currentDayNo = 0;
  let inMealSection = false;

  for (const line of lines) {
    if (/^\[?\s*식사\s*\]?$/u.test(line)) {
      inMealSection = true;
      continue;
    }
    if (inMealSection && /^\[.+\]$/u.test(line) && !/^\[?\s*식사\s*\]?$/u.test(line)) {
      inMealSection = false;
    }

    const dayMatch = /(?:^|[;\s])(\d{1,2})\s*일(?:차)?(?=$|[^\d])/u.exec(line);
    if (dayMatch?.[1]) currentDayNo = Number(dayMatch[1]);

    const mealMatches = Array.from(line.matchAll(/(조식|중식|석식|조\s*[-:：]|중\s*[-:：]|석\s*[-:：])\s*/gu));
    if (inMealSection && /^D\s*(\d{1,2})\s*[:：]/iu.test(line)) {
      const sectionDay = /^D\s*(\d{1,2})\s*[:：]/iu.exec(line)?.[1];
      if (sectionDay) currentDayNo = Number(sectionDay);
      const sectionBody = line.replace(/^D\s*\d{1,2}\s*[:：]\s*/iu, "");
      for (const segment of sectionBody.split("/").map((entry) => entry.trim()).filter(Boolean)) {
        const money = parseMoneyOccurrences(segment, { requireExplicitUnit: true })[0];
        if (!money || money.amount <= 0) continue;
        const description = segment.slice(0, money.index).replace(/[\s,./]+$/gu, "").trim() || "식사";
        items.push(buildItem({
          category: "MEAL",
          date: dates.get(currentDayNo) ?? "",
          description,
          quantity: passengerCount,
          unitPrice: money.amount,
          currencyCode: money.currencyCode,
        }));
      }
      continue;
    }

    if (mealMatches.length === 0) continue;
    const hasExplicitMealPriceShape = mealMatches.some((entry) => {
      const beforeLabel = line.slice(0, entry.index);
      const withoutDayPrefix = beforeLabel.replace(/^\s*(?:\[식사\]\s*)?\d{1,2}\s*일(?:차)?\s*[:：;]?\s*/u, "");
      return withoutDayPrefix.trim() === "";
    });
    if (!hasExplicitMealPriceShape) continue;

    for (let index = 0; index < mealMatches.length; index += 1) {
      const match = mealMatches[index];
      const rawLabel = match?.[1];
      if (!match || !rawLabel) continue;

      const segmentStart = match.index + match[0].length;
      const segmentEnd = mealMatches[index + 1]?.index ?? line.length;
      const segment = line.slice(segmentStart, segmentEnd).replace(/^[\s,./]+|[\s,./]+$/gu, "");
      const money = parseMoneyOccurrences(segment, { requireExplicitUnit: true })[0];
      if (!money || money.amount <= 0) continue;

      const label = rawLabel.startsWith("조") ? "조식" : rawLabel.startsWith("중") ? "중식" : "석식";
      const description = segment.slice(0, money.index).replace(/[\s,./]+$/gu, "").trim();
      items.push(buildItem({
        category: "MEAL",
        date: dates.get(currentDayNo) ?? "",
        description: `${label} ${description || "식사"}`,
        quantity: passengerCount,
        unitPrice: money.amount,
        currencyCode: money.currencyCode,
      }));
    }
  }

  return items;
}

function collectIndentedConditions(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const picked = lines.filter((line) =>
    /^(?:ㄴ\s*)?(?:호텔|포함사항|불포함사항|차량|노쇼핑|노옵션)/u.test(line)
  );
  return picked
    .map((line) => line.replace(/^ㄴ\s*/u, ""))
    .join("\n");
}

function parseAdultChildPackageItems(text: string): QuoteItem[] {
  const match = /성인\s*(\d+)\s*\+\s*아동\s*(\d+)([\s\S]*?)인당\s*([\s\S]*?)(?:\n|$)/u.exec(text);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return [];

  const adultCount = toNumber(match[1]);
  const childCount = toNumber(match[2]);
  const productName = match[3].trim().replace(/\s+/gu, " ") || "인당 요금";
  const priceText = match[4];
  const adultPriceMatch = /성인\s*(US\$|USD|\$|KRW|JPY|¥|원|엔)?\s*([\d,]+)/iu.exec(priceText);
  const childPriceMatch = /아동\s*(US\$|USD|\$|KRW|JPY|¥|원|엔)?\s*([\d,]+)/iu.exec(priceText);
  const conditions = collectIndentedConditions(text);
  const suffix = conditions ? `\n${conditions}` : "";
  const items: QuoteItem[] = [];

  if (adultCount > 0 && adultPriceMatch?.[2]) {
    items.push(buildItem({
      category: "OTHER",
      description: `${productName} 성인 인당${suffix}`,
      quantity: adultCount,
      unitPrice: toNumber(adultPriceMatch[2]),
      currencyCode: detectCurrency(adultPriceMatch[1] ?? "", ""),
    }));
  }

  if (childCount > 0 && childPriceMatch?.[2]) {
    items.push(buildItem({
      category: "OTHER",
      description: `${productName} 아동 인당`,
      quantity: childCount,
      unitPrice: toNumber(childPriceMatch[2]),
      currencyCode: detectCurrency(childPriceMatch[1] ?? "", ""),
    }));
  }

  return items;
}

function inferPassengerCount(text: string): number {
  const compact = text.replace(/\s+/gu, " ");
  const headcount = /인원\s*[:：]?\s*(\d+)\s*\+\s*(\d+)(?:\s*\+\s*(\d+))?/u.exec(compact);
  if (headcount?.[1] && headcount[2]) {
    const totalHeadcount = toNumber(headcount[1]) + toNumber(headcount[2]) + toNumber(headcount[3]);
    if (totalHeadcount > 0) return totalHeadcount;
  }

  const adult = /성인\s*(\d+)/u.exec(compact)?.[1];
  const child = /아동\s*(\d+)/u.exec(compact)?.[1];
  const infant = /유아\s*(\d+)/u.exec(compact)?.[1];
  const total = toNumber(adult) + toNumber(child) + toNumber(infant);
  return total > 0 ? total : 0;
}

function factorToItem(factor: QuoteAnswerFactorRaw): QuoteItem | null {
  const amount = factor.totlAmt || factor.persPerFare + factor.add1Amt;
  if (amount <= 0) return null;

  const descriptionParts = [factor.fareNm];
  if (factor.ptclrMtrCont && factor.ptclrMtrCont !== factor.fareNm) {
    descriptionParts.push(factor.ptclrMtrCont);
  }

  const category: QuoteItem["category"] =
    factor.ansrKndCd === "AIR" ? "FLIGHT" :
      factor.ansrKndCd === "LND" ? "VEHICLE" :
        "OTHER";

  return buildItem({
    category,
    description: descriptionParts.join("\n"),
    quantity: 1,
    unitPrice: amount,
    currencyCode: factor.currencyCode,
  });
}

function summaryProfitToItem(summary: QuoteAnswerSummaryRaw): QuoteItem | null {
  if (summary.add1Amt <= 0) return null;
  return buildItem({
    category: "OTHER",
    description: "1인당 예상수익",
    quantity: 1,
    unitPrice: summary.add1Amt,
    currencyCode: "KRW",
  });
}

function parseRemarkMoneyItems(text: string, passengerCount: number): QuoteItem[] {
  const items: QuoteItem[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (BASIC_LABEL_PATTERN.test(line)) continue;
    if (/(?:환율기준|최종합계|최종\s*입금가|1\s*인당\s*NET|1\s*인당\s*예상수익|유효기간)/u.test(line)) continue;
    if (/(?:조식|중식|석식|조\s*[-:：]|중\s*[-:：]|석\s*[-:：])/u.test(line)) continue;
    if (/^D\s*\d{1,2}\s*[:：]/iu.test(line)) continue;
    if (/(?:불포함사항|불포함|개인적인\s*비용|싱글\s*차지|싱글차지|캐디\s*팁|캐디팁|매너\s*팁|매너팁)/u.test(line)) continue;
    if (/(?:추가됩니다|추가\s*됩니다|추가\s*될|추가\s*시|추가시|제공\s*시|제공시)/u.test(line)) continue;
    if (/성인\s*\d+.*아동\s*\d+.*인당/u.test(line)) continue;
    if (/^(?:US\$|USD|\$|KRW|JPY|¥)?\s*[+-]?\d[\d,]*\s*(?:억원|만원|원|KRW|USD|US\$|JPY|¥|엔|\$)$/iu.test(line)) continue;

    const occurrences = parseMoneyOccurrences(line, { requireExplicitUnit: true });
    for (const money of occurrences) {
      if (money.amount <= 0) continue;
      if (/억원/u.test(money.raw) && /(?:보험|보장|담보|여행자보험)/u.test(line)) continue;

      items.push(buildItem({
        category: "OTHER",
        description: line,
        quantity: /(?:1\s*인|인당)/u.test(line) ? passengerCount : 1,
        unitPrice: money.amount,
        currencyCode: money.currencyCode,
      }));
    }
  }

  return items;
}

function requiredCurrencyCodes(items: QuoteItem[]): CurrencyCode[] {
  const codes = new Set<CurrencyCode>();
  for (const item of items) {
    if (item.currencyRateId === "usd") codes.add("USD");
    if (item.currencyRateId === "jpy") codes.add("JPY");
  }
  return Array.from(codes);
}

function buildExchangeRates(codes: CurrencyCode[]): QuoteExchangeRate[] {
  const rates: QuoteExchangeRate[] = [DEFAULT_EXCHANGE_RATE];
  for (const code of codes) {
    if (code === "KRW") continue;
    rates.push({
      id: exchangeRateIdForCurrency(code),
      code,
      rateToKrw: 1,
    });
  }
  return rates;
}

function buildRaw(text: string): QuoteAnswerRaw {
  return {
    summary: parseSummary(text),
    factors: parseFactorLines(text),
    remarks: text,
  };
}

function inferConfidence(raw: QuoteAnswerRaw, items: QuoteItem[]): QuoteResponseDiagnostics["confidence"] {
  if (raw.summary.totalSum > 0 && items.length > 0) return "high";
  if (items.length > 0) return "medium";
  return "low";
}

function buildWarnings(raw: QuoteAnswerRaw, items: QuoteItem[], requiredCodes: CurrencyCode[]): string[] {
  const warnings: string[] = [];
  if (items.length === 0) warnings.push("견적 요금 행을 찾지 못했습니다.");

  const subtotal = items
    .filter((item) => item.currencyRateId === DEFAULT_EXCHANGE_RATE_ID && item.description !== "1인당 예상수익")
    .reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  if (raw.summary.persPerFare > 0 && subtotal > 0 && subtotal !== raw.summary.persPerFare) {
    warnings.push(`원화 항목소계 ${subtotal.toLocaleString()}원과 1인당 NET ${raw.summary.persPerFare.toLocaleString()}원이 다릅니다.`);
  }
  if (requiredCodes.length > 0) {
    warnings.push(`${requiredCodes.join(", ")} 환율 입력이 필요합니다.`);
  }
  return warnings;
}

export function parseQuoteResponseText(input: ParseQuoteResponseTextInput): QuoteResponseParseResult {
  const text = normalizeText(input.text);
  const raw = buildRaw(text);
  const inferredPassengerCount = inferPassengerCount(text);
  const passengerCount = Math.max(1, Math.round(input.passengerCount && input.passengerCount > 0
    ? input.passengerCount
    : inferredPassengerCount || 1));
  const dates = parseTravelDateMap(text, dayDateMap(input.dayDates));
  const items = [
    ...raw.factors.map(factorToItem).filter((item): item is QuoteItem => item !== null),
    ...[summaryProfitToItem(raw.summary)].filter((item): item is QuoteItem => item !== null),
    ...parseMealItems(text, passengerCount, dates),
    ...parseAdultChildPackageItems(text),
    ...parseRemarkMoneyItems(text, passengerCount),
  ];
  const requiredCodes = requiredCurrencyCodes(items);
  const quoteHeader = {
    writtenAt: input.quoteHeader?.writtenAt ?? todayInKorea(),
    validUntil: raw.summary.vldtDttm ?? input.quoteHeader?.validUntil ?? input.quoteHeader?.writtenAt ?? todayInKorea(),
  };
  const quote = recalculateQuoteData({
    header: quoteHeader,
    items,
    exchangeRates: buildExchangeRates(requiredCodes),
    groundProfit: 0,
    agencyFee: 0,
  });

  return {
    quote,
    extractedText: text,
    diagnostics: {
      source: "quote-response-text",
      confidence: inferConfidence(raw, items),
      warnings: buildWarnings(raw, items, requiredCodes),
      requiredCurrencyCodes: requiredCodes,
      raw,
    },
  };
}
