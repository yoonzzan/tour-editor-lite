export type QuoteAnswerKind = "AIR" | "LND" | "FEE" | "SUM" | "TEXT";
export type CurrencyCode = "KRW" | "USD" | "JPY";

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

export interface QuoteBasicAmountSpec {
  ansrKndCd: Extract<QuoteAnswerKind, "AIR" | "LND" | "FEE">;
  fareNm: string;
  label: RegExp;
  amountField: "persPerFare" | "add1Amt" | "totlAmt";
}

export const QUOTE_RESPONSE_SECTION_LABELS = [
  "최종합계",
  "환율기준",
  "1인당 NET",
  "1인당 예상수익",
  "최종 입금가",
  "최종 안내사항",
  "유효기간",
  "항공 요금",
  "지상 요금",
  "공동 경비 요금",
  "답변 첨부파일",
  "첨부파일",
] as const;

export const QUOTE_RESPONSE_GRID_LABELS = [
  "요금1",
  "요금2",
  "항공료",
  "TAX",
  "지상비",
  "랜드수익",
  "인솔자비",
  "FOC",
  "보험료",
  "기타",
] as const;

export const QUOTE_RESPONSE_SUMMARY_FIELDS = [
  { key: "currKndCd", label: "통화코드", description: "환율기준 통화 코드" },
  { key: "untAmt", label: "환율기준", description: "적용 환율" },
  { key: "persPerFare", label: "1인당 NET", description: "1인당 NET 금액" },
  { key: "add1Amt", label: "1인당 예상수익", description: "표시용 예상수익" },
  { key: "totalSum", label: "최종합계", description: "최종 입금가 또는 최종합계" },
  { key: "vldtDttm", label: "유효기간", description: "견적 유효기간" },
] as const;

export const QUOTE_RESPONSE_FACTOR_FIELDS = [
  { key: "ansrKndCd", label: "구분코드", description: "AIR/LND/FEE 등 API 요금 구분" },
  { key: "fareNm", label: "요금명", description: "항공료, TAX, 지상비 등 요금 라벨" },
  { key: "persPerFare", label: "기본요금", description: "항공료/지상비 같은 기본 요금" },
  { key: "add1Amt", label: "추가금액", description: "TAX/랜드수익 등 부가 금액" },
  { key: "totlAmt", label: "합계금액", description: "요금 행 합계" },
  { key: "ptclrMtrCont", label: "특이사항", description: "요금 행 상세 설명" },
] as const;

export const QUOTE_RESPONSE_BASIC_AMOUNT_SPECS = [
  { ansrKndCd: "AIR", fareNm: "항공료", label: /항공료/iu, amountField: "persPerFare" },
  { ansrKndCd: "AIR", fareNm: "TAX", label: /TAX/iu, amountField: "add1Amt" },
  { ansrKndCd: "LND", fareNm: "지상비", label: /지상비/iu, amountField: "persPerFare" },
  { ansrKndCd: "LND", fareNm: "랜드수익", label: /랜드수익/iu, amountField: "add1Amt" },
  { ansrKndCd: "FEE", fareNm: "인솔자비", label: /인솔자비/iu, amountField: "totlAmt" },
  { ansrKndCd: "FEE", fareNm: "FOC", label: /(?<![\p{L}\p{N}])FOC(?![\p{L}\p{N}])/iu, amountField: "totlAmt" },
  { ansrKndCd: "FEE", fareNm: "보험료", label: /보험료/iu, amountField: "totlAmt" },
  { ansrKndCd: "FEE", fareNm: "기타", label: /기타/iu, amountField: "totlAmt" },
] as const satisfies readonly QuoteBasicAmountSpec[];

export const QUOTE_RESPONSE_BASIC_LABEL_PATTERN = new RegExp(
  [
    "항공\\s*요금",
    "항공요금",
    ...QUOTE_RESPONSE_BASIC_AMOUNT_SPECS.map((spec) => spec.label.source),
    "합계",
    "지상\\s*요금",
    "지상요금",
    "공동\\s*경비\\s*요금",
    "공동경비\\s*요금",
    "TC\\s*비용",
    "요금[12]",
    "답변\\s*첨부파일",
    "첨부파일",
    "최종\\s*안내사항",
    "유효기간",
  ].join("|"),
  "iu",
);

export function normalizeQuoteResponseAliases(text: string): string {
  return text
    .replace(/T\s*A\s*X/giu, "TAX")
    .replace(/N\s*E\s*T/giu, "NET")
    .replace(/K\s*R\s*W/giu, "KRW")
    .replace(/U\s*S\s*D/giu, "USD")
    .replace(/J\s*P\s*Y/giu, "JPY")
    .replace(/1\s*인\s*당/gu, "1인당")
    .replace(/1\s*인\s*(?:당\s*)?예상\s*수익/gu, "1인당 예상수익")
    .replace(/랜드\s*수익/gu, "랜드수익")
    .replace(/인솔자\s*비(?:용)?/gu, "인솔자비")
    .replace(/보험\s*(?:료|요)/gu, "보험료")
    .replace(/최종\s*합계/gu, "최종합계")
    .replace(/최종\s*입금가/gu, "최종 입금가")
    .replace(/총\s*견적가/gu, "최종합계")
    .replace(/환율\s*정보/gu, "환율기준")
    .replace(/총\s*정리\s*금액/gu, "공동 경비 요금")
    .replace(/총\s*금액/gu, "공동 경비 요금")
    .replace(/항공\s*요금/gu, "항공 요금")
    .replace(/지상\s*요금/gu, "지상 요금")
    .replace(/공동\s*경비\s*요금/gu, "공동 경비 요금");
}

export function quoteResponseSchemaPrompt(): string {
  const summaryFields = QUOTE_RESPONSE_SUMMARY_FIELDS
    .map((field) => `${field.key}=${field.label}(${field.description})`)
    .join(", ");
  const factorFields = QUOTE_RESPONSE_FACTOR_FIELDS
    .map((field) => `${field.key}=${field.label}(${field.description})`)
    .join(", ");
  const amountLabels = QUOTE_RESPONSE_BASIC_AMOUNT_SPECS
    .map((spec) => `${spec.ansrKndCd}.${spec.fareNm}->${spec.amountField}`)
    .join(", ");

  return [
    `API summary fields: ${summaryFields}`,
    `API factor fields: ${factorFields}`,
    `Known amount labels: ${amountLabels}`,
    `Section labels to preserve: ${QUOTE_RESPONSE_SECTION_LABELS.join(", ")}`,
    `Grid labels to preserve: ${QUOTE_RESPONSE_GRID_LABELS.join(", ")}`,
  ].join("\n");
}
