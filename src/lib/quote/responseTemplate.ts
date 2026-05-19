import type { QuoteOcrLine } from "@/lib/quote/responseOcr";

export interface NormalizeQuoteResponseOcrInput {
  text: string;
  lines?: QuoteOcrLine[];
}

export interface NormalizeQuoteResponseOcrResult {
  normalizedText: string;
  warnings: string[];
}

const SECTION_LABELS = [
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

const GRID_LABELS = [
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

function compactWhitespace(text: string): string {
  return text
    .replace(/\uFEFF/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function insertLineBreaks(text: string, labels: readonly string[]): string {
  return labels.reduce((next, label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s*");
    return next.replace(new RegExp(`\\s*(${escaped})\\s*`, "gu"), "\n$1 ");
  }, text);
}

function normalizeOcrMistakes(text: string): string {
  return text
    .replace(/T\s*A\s*X/giu, "TAX")
    .replace(/N\s*E\s*T/giu, "NET")
    .replace(/K\s*R\s*W/giu, "KRW")
    .replace(/U\s*S\s*D/giu, "USD")
    .replace(/J\s*P\s*Y/giu, "JPY")
    .replace(/1\s*인\s*당/gu, "1인당")
    .replace(/최종\s*합계/gu, "최종합계")
    .replace(/최종\s*입금가/gu, "최종 입금가")
    .replace(/항공\s*요금/gu, "항공 요금")
    .replace(/지상\s*요금/gu, "지상 요금")
    .replace(/공동\s*경비\s*요금/gu, "공동 경비 요금");
}

function linesToText(lines: QuoteOcrLine[] | undefined, fallback: string): string {
  const textFromLines = (lines ?? [])
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join("\n");
  return textFromLines || fallback;
}

function buildWarnings(text: string): string[] {
  const warnings: string[] = [];
  if (!/(?:항공\s*요금|지상\s*요금|공동\s*경비|최종합계|\[식사\]|성인\s*\d+)/u.test(text)) {
    warnings.push("OCR 텍스트에서 견적답변 주요 구간을 찾지 못했습니다. 인식 결과를 확인해 주세요.");
  }
  return warnings;
}

export function normalizeQuoteResponseOcrText(
  input: NormalizeQuoteResponseOcrInput,
): NormalizeQuoteResponseOcrResult {
  const baseText = linesToText(input.lines, input.text);
  const normalizedText = compactWhitespace(
    insertLineBreaks(
      insertLineBreaks(normalizeOcrMistakes(baseText), SECTION_LABELS),
      GRID_LABELS,
    ),
  );

  return {
    normalizedText,
    warnings: buildWarnings(normalizedText),
  };
}
