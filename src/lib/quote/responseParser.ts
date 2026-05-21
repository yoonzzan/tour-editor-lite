import { v4 as uuidv4 } from "uuid";
import type { QuoteData, QuoteExchangeRate, QuoteItem } from "@/types";
import {
  DEFAULT_EXCHANGE_RATE,
  DEFAULT_EXCHANGE_RATE_ID,
  recalculateQuoteData,
} from "@/lib/quote/currency";
import { currentYearInKorea, todayInKorea } from "@/lib/date/korea";
import {
  QUOTE_RESPONSE_BASIC_AMOUNT_SPECS,
  QUOTE_RESPONSE_BASIC_LABEL_PATTERN,
  type CurrencyCode,
  normalizeQuoteResponseAliases,
  type QuoteAnswerFactorRaw,
  type QuoteAnswerKind,
  type QuoteAnswerRaw,
  type QuoteAnswerSummaryRaw,
} from "@/lib/quote/responseSchema";

export interface QuoteResponseDayDate {
  dayNo: number;
  date: string;
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

const ZERO_MONEY: LabeledMoneyValue = { amount: 0, currencyCode: "KRW", found: false };
const SUPPORTED_CURRENCY_CODES = ["USD", "JPY", "CAD", "EUR", "AUD", "NZD", "CNY", "GBP"] as const satisfies readonly Exclude<CurrencyCode, "KRW">[];
const CURRENCY_CODE_PATTERN = /KRW|USD|US\$|JPY|CAD|EUR|AUD|NZD|CNY|CNH|GBP|¥|엔|€|£|\$/iu;
const LAND_SECTION_LABEL_PATTERN = /지상\s*요금|지상요금|개별\s*요금|개별요금|랜드\s*요금|현지\s*요금/iu;
const AIR_SECTION_END_PATTERN = /지상\s*요금|지상요금|개별\s*요금|개별요금|랜드\s*요금|현지\s*요금|공동\s*경비\s*요금|공동경비\s*요금|답변\s*첨부파일|첨부파일/iu;
const FEE_SECTION_LABEL_PATTERN = /공동\s*경비\s*요금|공동경비\s*요금|TC\s*비용/iu;
const FEE_SECTION_END_PATTERN = /답변\s*첨부파일|첨부파일/iu;
const REMARK_SECTION_PATTERN = /\n\s*(?:비고사항|대리점\s*공개|최종\s*안내사항|유효기간)(?=$|[\s:：])/iu;

function normalizeText(text: string): string {
  return normalizeQuoteResponseAliases(text)
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
  if (token.includes("CAD")) return "CAD";
  if (token.includes("EUR") || token.includes("€")) return "EUR";
  if (token.includes("AUD")) return "AUD";
  if (token.includes("NZD")) return "NZD";
  if (token.includes("CNY") || token.includes("CNH")) return "CNY";
  if (token.includes("GBP") || token.includes("£")) return "GBP";
  return "KRW";
}

function detectCurrencyCodeFromText(text: string): CurrencyCode {
  const upper = text.toUpperCase();
  if (/USD|US\$|\$/u.test(upper)) return "USD";
  if (/JPY|¥|엔/u.test(upper)) return "JPY";
  if (/CAD/u.test(upper)) return "CAD";
  if (/EUR|€/u.test(upper)) return "EUR";
  if (/AUD/u.test(upper)) return "AUD";
  if (/NZD/u.test(upper)) return "NZD";
  if (/CNY|CNH/u.test(upper)) return "CNY";
  if (/GBP|£/u.test(upper)) return "GBP";
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
  const moneyPattern = /(US\$|USD|\$|KRW|JPY|CAD|EUR|AUD|NZD|CNY|CNH|GBP|¥|€|£)?\s*([+-]?\d[\d,]*)(?:\s*(억원|만원|원|KRW|USD|US\$|JPY|CAD|EUR|AUD|NZD|CNY|CNH|GBP|¥|€|£|엔|\$))?/giu;

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

function parseHintedPerPersonMoney(text: string): MoneyValue | null {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return null;

  const hint = /(?:1인당|인당)/u.exec(line);
  if (!hint) return null;
  const afterHint = line.slice(hint.index + hint[0].length);
  const money = parseMoneyOccurrences(afterHint, { requireExplicitUnit: false })[0];
  if (!money || money.amount <= 0) return null;

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
  const nextLabel = QUOTE_RESPONSE_BASIC_LABEL_PATTERN.exec(afterLabel);
  return nextLabel ? afterLabel.slice(0, nextLabel.index) : afterLabel;
}

function bestLabeledMoney(text: string, label: RegExp): LabeledMoneyValue {
  const candidates: MoneyValue[] = [];
  for (const match of text.matchAll(asGlobalRegex(label))) {
    const segment = segmentAfterLabel(text, match.index + match[0].length);
    const money = parseLeadingMoney(segment) ?? parseHintedPerPersonMoney(segment);
    if (!money) continue;
    candidates.push(money);
  }
  if (candidates.length === 0) return ZERO_MONEY;
  const positiveCandidates = candidates.filter((money) => money.amount > 0);
  const picked = (positiveCandidates.length > 0 ? positiveCandidates : candidates)
    .reduce((smallest, money) => (money.amount < smallest.amount ? money : smallest));
  return { ...picked, found: true };
}

function sectionText(text: string, start: RegExp, end: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch) return text;
  const afterStart = text.slice(startMatch.index);
  const endMatch = end.exec(afterStart.slice(startMatch[0].length));
  if (!endMatch) return afterStart;
  return afterStart.slice(0, startMatch[0].length + endMatch.index);
}

function boundedSectionText(text: string, start: RegExp, fallbackStart: RegExp, end: RegExp): string {
  const startMatch = start.exec(text) ?? fallbackStart.exec(text);
  if (!startMatch) return "";
  const afterStart = text.slice(startMatch.index);
  const endMatch = end.exec(afterStart.slice(startMatch[0].length));
  if (!endMatch) return afterStart;
  return afterStart.slice(0, startMatch[0].length + endMatch.index);
}

function sectionTextOrEmpty(text: string, start: RegExp, end: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch) return "";
  return sectionText(text, start, end);
}

function gridSectionText(section: string): string {
  const remarkMatch = REMARK_SECTION_PATTERN.exec(section);
  return remarkMatch ? section.slice(0, remarkMatch.index) : section;
}

function fallbackFeeSectionText(text: string): string {
  const landMatch = LAND_SECTION_LABEL_PATTERN.exec(text);
  const searchStart = landMatch ? landMatch.index + landMatch[0].length : 0;
  const searchText = text.slice(searchStart);
  const feeMarker = /인솔자비|보험료|부가세|(?<![\p{L}\p{N}])FOC(?![\p{L}\p{N}])/iu.exec(searchText);
  if (!feeMarker) return "";

  const markerIndex = searchStart + feeMarker.index;
  const lineStart = text.lastIndexOf("\n", markerIndex);
  const markerLineStart = lineStart >= 0 ? lineStart + 1 : markerIndex;
  const previousLineStart = lineStart > 0 ? text.lastIndexOf("\n", lineStart - 1) : -1;
  const previousLine = previousLineStart >= 0 && lineStart >= 0
    ? text.slice(previousLineStart + 1, lineStart).trim()
    : "";
  const sectionStart = Math.max(searchStart, /항공료/u.test(previousLine) ? previousLineStart + 1 : markerLineStart);
  const fallbackText = text.slice(sectionStart);
  const endMatch = FEE_SECTION_END_PATTERN.exec(fallbackText);
  return endMatch ? fallbackText.slice(0, endMatch.index) : fallbackText;
}

function moneyAfterLastLabel(text: string, label: RegExp): MoneyValue | null {
  const matches = Array.from(text.matchAll(asGlobalRegex(label)));
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!match) continue;
    const money = parseLeadingMoney(segmentAfterLabel(text, match.index + match[0].length));
    if (money) return money;
  }
  return null;
}

function isNonBaseCostLine(line: string): boolean {
  return /(?:불포함사항|불포함|개인적인\s*비용|개인\s*경비|싱글\s*차지|싱글차지|캐디\s*팁|캐디팁|매너\s*팁|매너팁|조건부|조건\s*부|별도|추가\s*비용|추가비용|추가\s*요금|추가요금|추가됩니다|추가\s*됩니다|추가\s*될|추가\s*시|추가시|제공\s*시|제공시|옵션\s*가능|선택\s*관광|현지\s*지불|현지\s*결제|^\s*상세\s*[:：]|\d+\s*인\s*이상\s*시|\d+\s*명\s*이상\s*시)/u.test(line);
}

function removeNonBaseCostLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isNonBaseCostLine(line))
    .join("\n");
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
    .find((line) => /환율기준/u.test(line) || CURRENCY_CODE_PATTERN.test(line));
  const currencyCode = detectCurrencyCodeFromText(currencyLine ?? "");
  const persPerFare = amountAfterLabel(text, /1\s*인당\s*NET/iu);
  const explicitProfit = amountAfterLabel(text, /(?:1\s*인당\s*)?예상수익/u);
  const totalSum = amountAfterLabel(text, /(?:최종합계|최종\s*입금가)/u);
  const inferredProfit = explicitProfit > 0
    ? explicitProfit
    : totalSum > persPerFare && persPerFare > 0
      ? totalSum - persPerFare
      : 0;

  return {
    currKndCd: currencyCode,
    untAmt: amountAfterLabel(currencyLine ?? "", /(?:환율기준|KRW|USD|US\$|JPY|CAD|EUR|AUD|NZD|CNY|CNH|GBP|¥|€|£)/iu),
    persPerFare,
    add1Amt: inferredProfit,
    totalSum,
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
  const normalized = removeNonBaseCostLines(text).replace(/[ \t]+/gu, " ");
  const airSection = boundedSectionText(normalized, /항공\s*요금|항공요금/iu, /항공료|TAX/iu, AIR_SECTION_END_PATTERN);
  const landSection = boundedSectionText(normalized, LAND_SECTION_LABEL_PATTERN, /지상비|랜드수익/iu, /공동\s*경비\s*요금|공동경비\s*요금|답변\s*첨부파일|첨부파일/iu);
  const explicitFeeSection = sectionTextOrEmpty(normalized, FEE_SECTION_LABEL_PATTERN, FEE_SECTION_END_PATTERN);
  const feeSection = explicitFeeSection || fallbackFeeSectionText(normalized);
  const airGridSection = gridSectionText(airSection);
  const landGridSection = gridSectionText(landSection);
  const feeGridSection = gridSectionText(feeSection);

  for (const spec of QUOTE_RESPONSE_BASIC_AMOUNT_SPECS.filter((entry) => entry.ansrKndCd === "AIR")) {
    const money = bestLabeledMoney(airGridSection, spec.label);
    if (money.found) factors.push(makeFactor(spec.ansrKndCd, spec.fareNm, spec.amountField === "persPerFare" ? money.amount : 0, spec.amountField === "add1Amt" ? money.amount : 0, money.amount, "", money.currencyCode));
  }
  const airTotal = sectionLeadingAmount(airGridSection, /항공\s*요금|항공요금/iu);
  const hasAirBase = factors.some((factor) => factor.ansrKndCd === "AIR" && factor.fareNm === "항공료");
  if (!hasAirBase && airTotal > 0) {
    const taxAmount = factors.find((factor) => factor.ansrKndCd === "AIR" && factor.fareNm === "TAX")?.totlAmt ?? 0;
    const inferredAirBase = Math.max(0, airTotal - taxAmount);
    if (inferredAirBase > 0) {
      factors.push(makeFactor("AIR", "항공료", inferredAirBase, 0, inferredAirBase, "", "KRW"));
    }
  }

  for (const spec of QUOTE_RESPONSE_BASIC_AMOUNT_SPECS.filter((entry) => entry.ansrKndCd === "LND")) {
    const money = bestLabeledMoney(landGridSection, spec.label);
    if (money.found) factors.push(makeFactor(spec.ansrKndCd, spec.fareNm, spec.amountField === "persPerFare" ? money.amount : 0, spec.amountField === "add1Amt" ? money.amount : 0, money.amount, "", money.currencyCode));
  }
  const landBaseIndex = factors.findIndex((factor) => factor.ansrKndCd === "LND" && factor.fareNm === "지상비");
  const hasLandBase = landBaseIndex >= 0;
  const landTotal = sectionLeadingAmount(landGridSection, LAND_SECTION_LABEL_PATTERN);
  const landProfitAmount = factors.find((factor) => factor.ansrKndCd === "LND" && factor.fareNm === "랜드수익")?.totlAmt ?? 0;
  if (!hasLandBase) {
    if (landTotal > 0) {
      factors.push(makeFactor("LND", "지상비", landTotal, 0, landTotal, "", "KRW"));
    }
  } else if (landTotal > 0 && landProfitAmount <= 0 && factors[landBaseIndex]?.totlAmt !== landTotal) {
    factors[landBaseIndex] = makeFactor("LND", "지상비", landTotal, 0, landTotal, "", "KRW");
  }

  const feeTotal = sectionLeadingAmount(feeGridSection, FEE_SECTION_LABEL_PATTERN) || moneyAfterLastLabel(feeGridSection, /합계/iu)?.amount || 0;
  const feeMoneys = QUOTE_RESPONSE_BASIC_AMOUNT_SPECS.filter((entry) => entry.ansrKndCd === "FEE").map((spec) => ({
    spec,
    money: bestLabeledMoney(feeGridSection, spec.label),
  }));
  const guideFee = feeMoneys.find((entry) => entry.spec.fareNm === "인솔자비");
  if (guideFee && !guideFee.money.found && feeTotal > 0 && /(?:보험료|기타|(?<![\p{L}\p{N}])FOC(?![\p{L}\p{N}]))/iu.test(feeGridSection)) {
    const misreadGuideFee = bestLabeledMoney(feeGridSection, /항공료/iu);
    if (misreadGuideFee.found && misreadGuideFee.amount > 0 && misreadGuideFee.amount < feeTotal) {
      guideFee.money = misreadGuideFee;
    }
  }
  const feeSubtotalWithoutEtc = feeMoneys
    .filter((entry) => entry.spec.fareNm !== "기타" && entry.money.found)
    .reduce((sum, entry) => sum + entry.money.amount, 0);

  let knownFeeAmount = 0;
  let hasInsuranceFactor = false;
  let hasPositiveEtcFactor = false;
  for (const { spec, money } of feeMoneys) {
    if (!money.found) continue;
    const duplicatedTotalAsEtc =
      spec.fareNm === "기타" &&
      feeTotal > 0 &&
      money.amount === feeTotal &&
      feeSubtotalWithoutEtc === feeTotal;
    const amount = duplicatedTotalAsEtc ? 0 : money.amount;
    if (amount > 0 && spec.fareNm !== "기타") knownFeeAmount += amount;
    if (amount > 0 && spec.fareNm === "보험료") hasInsuranceFactor = true;
    if (amount > 0 && spec.fareNm === "기타") hasPositiveEtcFactor = true;
    factors.push(makeFactor(spec.ansrKndCd, spec.fareNm, amount, 0, amount, "", money.currencyCode));
  }
  if (!hasInsuranceFactor && feeTotal > knownFeeAmount && (/보험료/u.test(feeGridSection) || (knownFeeAmount > 0 && !hasPositiveEtcFactor))) {
    const inferredInsuranceAmount = feeTotal - knownFeeAmount;
    factors.push(makeFactor("FEE", "보험료", inferredInsuranceAmount, 0, inferredInsuranceAmount, "", "KRW"));
  }
  const hasFeeAmount = factors.some((factor) => factor.ansrKndCd === "FEE" && factor.totlAmt > 0);
  if (!hasFeeAmount && feeTotal > 0) {
    factors.push(makeFactor("FEE", "보험료", feeTotal, 0, feeTotal, "", "KRW"));
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

function parseRemarkMoneyItems(_text: string, _passengerCount: number): QuoteItem[] {
  // Quote-answer remarks often contain reference fares, penalties, optional costs,
  // and room conditions. Only dedicated parsers should promote remark money to rows.
  return [];
}

function requiredCurrencyCodes(items: QuoteItem[]): CurrencyCode[] {
  const codes = new Set<CurrencyCode>();
  for (const item of items) {
    const code = SUPPORTED_CURRENCY_CODES.find((entry) => item.currencyRateId === entry.toLowerCase());
    if (code) codes.add(code);
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
