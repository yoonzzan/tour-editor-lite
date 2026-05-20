import type { QuoteOcrLine } from "@/lib/quote/responseOcr";
import {
  QUOTE_RESPONSE_GRID_LABELS,
  QUOTE_RESPONSE_SECTION_LABELS,
  normalizeQuoteResponseAliases,
} from "@/lib/quote/responseSchema";

export interface NormalizeQuoteResponseOcrInput {
  text: string;
  lines?: QuoteOcrLine[];
}

export interface NormalizeQuoteResponseOcrResult {
  normalizedText: string;
  warnings: string[];
}

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
      insertLineBreaks(normalizeQuoteResponseAliases(baseText), QUOTE_RESPONSE_SECTION_LABELS),
      QUOTE_RESPONSE_GRID_LABELS,
    ),
  );

  return {
    normalizedText,
    warnings: buildWarnings(normalizedText),
  };
}
