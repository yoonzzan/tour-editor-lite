import { describe, expect, it } from "vitest";
import { normalizeQuoteResponseOcrText } from "./responseTemplate";

describe("normalizeQuoteResponseOcrText", () => {
  it("normalizes fixed quote answer screen text from OCR lines", () => {
    const result = normalizeQuoteResponseOcrText({
      text: "",
      lines: [
        { text: "최종합계 1,650,000원 환율기준 KRW 0" },
        { text: "1 인당 NET 1,518,000 1인당 예상수익 132,000 최종 입금가 1,650,000" },
        { text: "항공 요금 955,000원 항공료 830,000 TAX 125,000 합계 955,000" },
        { text: "지상 요금 520,000원 지상비 520,000 랜드수익 0 합계 520,000" },
        { text: "[식사] 2일차 중식 현지식$10 / 석식 한식$10" },
      ],
    });

    expect(result.normalizedText).toContain("최종합계 1,650,000원");
    expect(result.normalizedText).toContain("1인당 NET 1,518,000");
    expect(result.normalizedText).toContain("항공 요금 955,000원");
    expect(result.normalizedText).toContain("TAX 125,000 합계 955,000");
    expect(result.warnings).toEqual([]);
  });

  it("warns when OCR text does not look like quote response content", () => {
    const result = normalizeQuoteResponseOcrText({
      text: "무관한 이미지 텍스트",
    });

    expect(result.warnings[0]).toContain("주요 구간");
  });
});
