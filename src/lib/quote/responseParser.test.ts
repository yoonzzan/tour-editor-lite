import { describe, expect, it, vi } from "vitest";
import { parseQuoteResponseText } from "@/lib/quote/responseParser";

vi.mock("uuid", () => {
  let index = 0;
  return {
    v4: () => `quote-response-item-${index += 1}`,
  };
});

describe("parseQuoteResponseText", () => {
  it("parses table-like quote answer totals into quote data", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 1,650,000원",
        "환율기준 KRW 0",
        "1인당 NET 1,518,000 1인당 예상수익 132,000 최종 입금가 1,650,000",
        "유효기간 위 견적가는 2025-05-01 까지만 유효합니다.",
        "항공료 830,000 TAX 125,000 합계 955,000",
        "지상비 520,000 랜드수익 0 합계 520,000",
        "인솔자비 0 FOC 35,000 보험료 8,000 기타 0 합계 43,000",
      ].join("\n"),
      dayDates: [
        { dayNo: 1, date: "2026-06-25" },
        { dayNo: 2, date: "2026-06-26" },
        { dayNo: 3, date: "2026-06-27" },
      ],
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.header.validUntil).toBe("2025-05-01");
    expect(result.quote.items).toHaveLength(6);
    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["FLIGHT", "항공료", 830000],
      ["FLIGHT", "TAX", 125000],
      ["VEHICLE", "지상비", 520000],
      ["OTHER", "FOC", 35000],
      ["OTHER", "보험료", 8000],
      ["OTHER", "1인당 예상수익", 132000],
    ]);
    expect(result.diagnostics.raw.factors).toHaveLength(8);
    expect(result.quote.summary.subtotal).toBe(1650000);
    expect(result.quote.summary.agencyFee).toBe(0);
    expect(result.quote.summary.vat).toBe(0);
    expect(result.quote.summary.total).toBe(1650000);
  });

  it("parses OCR-style split labels and amounts into individual API-mapped rows", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계1,650,000원",
        "1인당 NET",
        "1,518,000",
        "1인당 예상수익",
        "132,000",
        "항공요금",
        "955,000원",
        "항공료",
        "830,000",
        "TAX",
        "125,000",
        "지상요금",
        "520,000원",
        "지상비",
        "520,000",
        "랜드수익",
        "0",
        "공동경비 요금",
        "43,000원",
        "인솔자비",
        "FOC",
        "35,000",
        "보험료",
        "8,000",
        "기타",
        "43,000",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.description, item.unitPrice])).toEqual([
      ["항공료", 830000],
      ["TAX", 125000],
      ["지상비", 520000],
      ["FOC", 35000],
      ["보험료", 8000],
      ["1인당 예상수익", 132000],
    ]);
    expect(result.quote.summary.subtotal).toBe(1650000);
  });

  it("treats OCR-misread common expense section totals as section labels, not quote rows", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 1,650,000원",
        "1인당 NET 1,607,000",
        "1인당 예상수익 43,000",
        "공통 경비 요금 10,000 원",
        "인솔자비",
        "FOC",
        "보험료 10,000",
        "기타 0",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.description, item.unitPrice])).toEqual([
      ["보험료", 10000],
      ["1인당 예상수익", 43000],
    ]);
    expect(result.quote.items.some((item) => item.description.includes("공통 경비 요금"))).toBe(false);
    expect(result.diagnostics.raw.factors.map((factor) => [
      factor.ansrKndCd,
      factor.fareNm,
      factor.totlAmt,
    ])).toEqual([
      ["FEE", "보험료", 10000],
      ["FEE", "기타", 0],
    ]);
  });

  it("recovers missing insurance from fee total when OCR drops the insurance row", () => {
    const result = parseQuoteResponseText({
      text: [
        "견적 단번 정보",
        "최종합계 870,000원",
        "환율기준 USD 1,500",
        "1인당 NET 814,500",
        "1인당 예상수익 55,500 (6.37%)",
        "최종 입금가 870,000",
        "최종 안내사항",
        "유효기간 2026-05-01 까지입니다.",
        "항공 요금 464,000원",
        "요금",
        "항공료 270,000",
        "TAX 194,000",
        "합계 464,000",
        "비고사항",
        "(6월25일 출발 2명 예약건) KE0841CTNAO-H44/",
        "2 KE 843 L25UN 4 ICTNAO DK1 1305 1345 25UN E 0 739 M",
        "3 KE 844 L27UN 6 TAICDO DK1 1455 1740 27UN E 0 739 M",
        "SEE RTSVC",
        "지상 요금 307,500원",
        "전직역 308155",
        "지상비 307,500",
        "요금",
        "지상비 0",
        "합계",
        "지상비 307,500",
        "비고사항",
        "인원: 20+1=20명(307500)",
        "상세: 1인당 15,000원, 2인 이상 시 1인당 12,500원, 3인 이상 시 10,000원, 4인 이상 시 9,500원, 5인 이상 시 9,000원",
        "중간 경비 요금 43,000원",
        "요금 0",
        "FOC 28,000",
        "비고사항",
        "(비고:3인 이상 시 foc 적용됩니다.)",
        "답변",
        "첨부파일",
        "첨부파일",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["FLIGHT", "항공료", 270000],
      ["FLIGHT", "TAX", 194000],
      ["VEHICLE", "지상비", 307500],
      ["OTHER", "FOC", 28000],
      ["OTHER", "보험료", 15000],
      ["OTHER", "1인당 예상수익", 55500],
    ]);
    expect(result.quote.items.some((item) => item.description.includes("상세:"))).toBe(false);
    expect(result.quote.items.some((item) => item.description.includes("중간 경비 요금"))).toBe(false);
    expect(result.diagnostics.warnings).toEqual([]);
    expect(result.quote.summary.total).toBe(870000);
  });

  it("parses compact expected profit and spaced land profit labels", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 1,127,000원",
        "1인당 NET 1,050,000",
        "1인예상수익 77,000",
        "지상 요금 512,000원",
        "지상비 500,000",
        "랜드 수익 12,000",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.diagnostics.raw.summary.add1Amt).toBe(77000);
    expect(result.diagnostics.raw.factors.map((factor) => [
      factor.ansrKndCd,
      factor.fareNm,
      factor.persPerFare,
      factor.add1Amt,
      factor.totlAmt,
    ])).toEqual([
      ["LND", "지상비", 500000, 0, 500000],
      ["LND", "랜드수익", 0, 12000, 12000],
    ]);
    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["VEHICLE", "지상비", 500000],
      ["VEHICLE", "랜드수익", 12000],
      ["OTHER", "1인당 예상수익", 77000],
    ]);
  });

  it("parses meal prices from free-text remarks", () => {
    const result = parseQuoteResponseText({
      text: [
        "[식사]",
        "2일차 중식 현지식$10 / 석식 한식$10",
        "3일차 중식 한식$10 / 석식 현지식$10",
        "4일차 중식 바이캠$15 / 석식 한식$10",
      ].join("\n"),
      passengerCount: 28,
      dayDates: [
        { dayNo: 2, date: "2026-02-07" },
        { dayNo: 3, date: "2026-02-08" },
        { dayNo: 4, date: "2026-02-09" },
      ],
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items).toHaveLength(6);
    expect(result.quote.items[0]).toMatchObject({
      category: "MEAL",
      date: "2026-02-07",
      description: "중식 현지식",
      quantity: 28,
      unitPrice: 10,
      currencyRateId: "usd",
    });
    expect(result.quote.items[4]).toMatchObject({
      description: "중식 바이캠",
      unitPrice: 15,
    });
    expect(result.diagnostics.requiredCurrencyCodes).toEqual(["USD"]);
  });

  it("parses noisy OCR quote answer without treating dates and counts as money", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 900,000원",
        "환율기준 USD O",
        "1인당 NET 860,000",
        "1인당 예상수익 40,000",
        "최종 입금가 900,000",
        "항공 요금 550,000원",
        "요금1 BX",
        "항공료 350,000",
        "TAX 200,000",
        "합계",
        "550,000",
        "비고사항",
        "BX10/9출발",
        "항공료 35만원 +5월기준유택20만원",
        "L TKTL 6/30",
        "지상 요금 300,000원",
        "지상비 300,000",
        "랜드수익 대리점 공개",
        "-날짜: 10/9~10/12",
        "-인원: 12+0",
        "-일정 : CAP321261009BXN 동일",
        "-호텔: 교주매리어트3박(2인1실)혹은동급//싱차15만원",
        "-차량:33인석차량",
        "-비고: 노팁 노옵션 쇼핑2회",
        "일정;1일 부산/청도도착후잔교,대복도,천주교당외부,피차에이엔,맥주박물관",
        "중-1903맥박레스토랑$10, 석-샤브샤브무제한$10",
        "2일 소어산,지모루시장,54광장,요트경기장,명월산해간불야성(음료제공)",
        "중-사천요리$10.석-삼겹살무제한$10",
        "3일노산(양구)케블카왕복포함, 신호산,독일총독관저,야시장거리",
        "중-산동요리$10. 석-양꼬치무제한$10",
        "4일 아웃",
        "공동 경비 요금 10,000원",
        "인솔자비",
        "FOC",
        "보험료 10,000",
        "기타 대리정공개여행자보험1억원",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    const rows = result.quote.items.map((item) => ({
      category: item.category,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      currencyRateId: item.currencyRateId,
      date: item.date,
    }));

    expect(rows).toEqual([
      { category: "FLIGHT", description: "항공료", quantity: 1, unitPrice: 350000, currencyRateId: "krw", date: "" },
      { category: "FLIGHT", description: "TAX", quantity: 1, unitPrice: 200000, currencyRateId: "krw", date: "" },
      { category: "VEHICLE", description: "지상비", quantity: 1, unitPrice: 300000, currencyRateId: "krw", date: "" },
      { category: "OTHER", description: "보험료", quantity: 1, unitPrice: 10000, currencyRateId: "krw", date: "" },
      { category: "OTHER", description: "1인당 예상수익", quantity: 1, unitPrice: 40000, currencyRateId: "krw", date: "" },
      { category: "MEAL", description: "중식 1903맥박레스토랑", quantity: 12, unitPrice: 10, currencyRateId: "usd", date: "2026-10-09" },
      { category: "MEAL", description: "석식 샤브샤브무제한", quantity: 12, unitPrice: 10, currencyRateId: "usd", date: "2026-10-09" },
      { category: "MEAL", description: "중식 사천요리", quantity: 12, unitPrice: 10, currencyRateId: "usd", date: "2026-10-10" },
      { category: "MEAL", description: "석식 삼겹살무제한", quantity: 12, unitPrice: 10, currencyRateId: "usd", date: "2026-10-10" },
      { category: "MEAL", description: "중식 산동요리", quantity: 12, unitPrice: 10, currencyRateId: "usd", date: "2026-10-11" },
      { category: "MEAL", description: "석식 양꼬치무제한", quantity: 12, unitPrice: 10, currencyRateId: "usd", date: "2026-10-11" },
    ]);
    expect(rows.some((row) => row.description === "랜드수익")).toBe(false);
    expect(rows.some((row) => row.description === "기타")).toBe(false);
    expect(rows.some((row) => row.description.includes("-인원: 12+0"))).toBe(false);
    expect(rows.some((row) => row.description.includes("싱차15만원"))).toBe(false);
    expect(rows.some((row) => row.description.includes("여행자보험1억원"))).toBe(false);
  });

  it("ignores deployed OCR agency remarks and only imports confirmed quote grid amounts", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 750,000원",
        "환율기준 USD 0",
        "스탭프로모션관리 697,500",
        "1인당 예상수익 52,500 (7%)",
        "최종 입금가 750,000",
        "대리점 공개",
        "└ 벌금 수준 : 300만동~500만동 수준 (18만~30만원), 기기 즉시 압수 및 폐기",
        "항공 요금 457,500원",
        "요금1 VJ",
        "항공료 457,500",
        "TAX 0 합계 457,500",
        "대리점 공개 20+0 * 인천출발 VJ시리즈 10석 / 인디비5석 / 부산발5석 평균가로 드립니다.",
        "› 시리즈블록운임 40만원 (유류포함) ★5/29 이전 선발권 조건 특가운임 ( 이후 운임 미정 )",
        "› 실시간 인디비 운임 59만원 (유류포함 ) B+W CLS",
        "› 실시간 인디비 운임: 53만원 ( 유류포함) Z+I CLS",
        "지상 요금 230,000원",
        "전지역 상세 308148",
        "지상비 230,000",
        "랜드수익 0 합계 230,000",
        "대리점 공개 * 견적코드 : QA00691325001 / 기준 코드 : AVP205260705VJZ",
        "4.호텔 : 모데나 바이 프레이저 빈펄 호텔 1박 또는 동급, kk 사파 2박 또는 동급/ 2인1실 기준 (10트윈 / 싱사 14만원)",
        "8. 지상비 : 행사비 9만원 + 호텔비 14만원 = 총 23만원 ★",
        "공동 경비 요금 10,000원",
        "인솔자비 0",
        "FOC 0",
        "보험료 10,000",
        "기타 0 합계 10,000",
        "대리점 공개 * 1억원 여행자 보험",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["FLIGHT", "항공료", 457500],
      ["VEHICLE", "지상비", 230000],
      ["OTHER", "보험료", 10000],
      ["OTHER", "1인당 예상수익", 52500],
    ]);
    expect(result.quote.summary.total).toBe(750000);
  });

  it("recovers local OCR grid amounts when labels include flight codes and land detail codes", () => {
    const result = parseQuoteResponseText({
      text: [
        "총합계 750,000 원",
        "환율기준 USD D",
        "1인당 예상수익 52,500 (7%)",
        "최종 입금가 750,000",
        "항공 요금 457,500 원",
        "요금 1",
        "항공료 VJ 항공 104 1인당 457,500",
        "TAX 0 합계 457,500",
        "비고사항",
        "3. 1인당 457,500원이 기본 요금입니다.",
        "지상 요금 230,000 원",
        "지상비 301,848 원",
        "렌트수익 0 합계 230,000",
        "비고사항",
        "2. 1인당 230,000원이 기본 요금입니다.",
        "공동 경비 요금 10,000 원",
        "인솔자비",
        "FOC 0 보료 10,000",
        "기타 합계 10,000",
        "**** 대략적인 공지 ****",
        "1. 본 견적서는 1인당 여행비용입니다.",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["FLIGHT", "항공료", 457500],
      ["VEHICLE", "지상비", 230000],
      ["OTHER", "보험료", 10000],
      ["OTHER", "1인당 예상수익", 52500],
    ]);
    expect(result.quote.summary.total).toBe(750000);
  });

  it("recovers insurance when OCR drops common fee title and reads insurance as VAT", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 : 1,050,000원",
        "환율기준 : USD 0",
        "1인당 NET : 984,000",
        "1인당 예상수익 : 66,000 (6.28%)",
        "최종 입금가 : 1,050,000",
        "항공 요금",
        "요금1",
        "항공료 40,000",
        "TAX 406,000",
        "합계",
        "446,000",
        "지상 요금 총액 : 490,000원",
        "지상비 490,000",
        "랜드수익 0",
        "합계",
        "490,000",
        "비고사항",
        "기타 FOC 38,000",
        "부가세",
        "10,000",
        "기타 0",
        "합계",
        "48,000",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice])).toEqual([
      ["FLIGHT", "항공료", 40000],
      ["FLIGHT", "TAX", 406000],
      ["VEHICLE", "지상비", 490000],
      ["OTHER", "FOC", 38000],
      ["OTHER", "보험료", 10000],
      ["OTHER", "1인당 예상수익", 66000],
    ]);
    expect(result.diagnostics.warnings).toEqual([]);
    expect(result.quote.summary.total).toBe(1050000);
  });

  it("infers meal quantity from passenger text when no passenger count is provided", () => {
    const result = parseQuoteResponseText({
      text: [
        "성인 25+아동 3",
        "[식사]",
        "2일차 중식 현지식$10 / 석식 한식$10",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items).toHaveLength(2);
    expect(result.quote.items.every((item) => item.quantity === 28)).toBe(true);
  });

  it("does not parse itinerary narration meal words as priced meal rows", () => {
    const result = parseQuoteResponseText({
      text: [
        "- 날짜: 26.3.17 출발",
        "- 인원: 16+0 / 14+0 / 12+0",
        "- 조건: 노팁, 노쇼핑, 옵션가능조건 / 매너팁 불포함",
        "12+0일 경우 1인 지상비 1,198,000원 / 14+0일 경우 1,150,000원입니다.",
        "<일정>",
        "1일차 : 싱가포르도착, 미팅, 체크인 호텔 투숙",
        "2일차 : 보타닉가든, 머라이언공원, 중식, 리버원더스, 석식, 슈퍼트리, 호텔투숙 [칠리크랩/송파바꾸떼]",
        "3일차 : 버드파라다이스, 중식, 오차드로드, 에머랄드힐, 마리나베라지, 석식, 호텔투숙 [펭귄뷔페/자유식S$20]",
        "4일차 : 체크아웃, 차이나타운, 중식, 케이블카 편도, 루지,마담투소, 간식,아랍&리틀,하지래인,부기스, 석식 / 공항이동 [만다린뷔페/송파바꾸떼]",
        "5일차 : 한국도착",
      ].join("\n"),
      dayDates: [
        { dayNo: 3, date: "2026-06-04" },
      ],
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.some((item) => item.category === "MEAL")).toBe(false);
    expect(result.quote.items.some((item) => item.description.includes("펭귄뷔페"))).toBe(false);
  });

  it("does not apply excluded or conditional dollar amounts as base quote rows", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 1,367,600원",
        "환율기준 USD 1,500",
        "1인당 NET 1,277,600",
        "1인당 예상수익 90,000",
        "항공 요금 395,100원",
        "항공료 230,000",
        "TAX 165,100",
        "지상 요금 877,500원",
        "지상비 877,500",
        "랜드수익 청도하나국제 견적확인부탁드립니다",
        "골프조20명:",
        "지상비 :$585/인",
        "불포함사항:개인적인 비용, 싱글차지$310/인(박기준),캐디팁100/인(18홀기준",
        "일정:1일차 청도도착야시장투어(양꼬치+청도맥주포함)석식후호텔이동(석식-해산물샤브샤브$20/인)",
        "관광조1안3박4일",
        "지상비 : $500/인",
        "불포함사항:개인적인 비용.싱글차지$310/인(박기준)",
        "비고: 관광팀6까지 간식제공시$10/인 추가됩니다",
        "3일차 맥주박물관VIP 코스.(중식-리원MIX레스토랑$15/인.석식-웨스틴호텔 디너뷔페 $30/인)",
        "공동 경비 요금 5,000원",
        "보험료 5,000",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice, item.currencyRateId])).toEqual([
      ["FLIGHT", "항공료", 230000, "krw"],
      ["FLIGHT", "TAX", 165100, "krw"],
      ["VEHICLE", "지상비", 877500, "krw"],
      ["OTHER", "보험료", 5000, "krw"],
      ["OTHER", "1인당 예상수익", 90000, "krw"],
    ]);
    expect(result.quote.summary.total).toBe(1367600);
    expect(result.diagnostics.requiredCurrencyCodes).toEqual([]);
  });

  it("does not apply OpenAI OCR conditional or separate costs as base rows", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 1,367,600원",
        "환율기준 USD 1,500",
        "1인당 NET 1,277,600",
        "1인당 예상수익 90,000",
        "항공 요금 395,100원",
        "항공료 230,000",
        "TAX 165,100",
        "지상 요금 877,500원",
        "지상비 877,500",
        "랜드수익 0",
        "공동 경비 요금 5,000원",
        "보험료 5,000",
        "조건부 추가 비용: 싱글차지 USD 310/인 별도",
        "옵션 가능 조건: 간식 제공 시 USD 10/인 추가 비용",
        "현지 지불: 캐디팁 100달러/인",
        "불포함: 개인경비 및 매너팁 50,000원",
        "지상비 USD 585/인 별도 조건",
      ].join("\n"),
      passengerCount: 20,
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice, item.currencyRateId])).toEqual([
      ["FLIGHT", "항공료", 230000, "krw"],
      ["FLIGHT", "TAX", 165100, "krw"],
      ["VEHICLE", "지상비", 877500, "krw"],
      ["OTHER", "보험료", 5000, "krw"],
      ["OTHER", "1인당 예상수익", 90000, "krw"],
    ]);
    expect(result.diagnostics.requiredCurrencyCodes).toEqual([]);
  });

  it("normalizes OpenAI OCR label drift without parsing summary rows as quote items", () => {
    const result = parseQuoteResponseText({
      text: [
        "견적 단번 정보",
        "총 견적가 : 1,367,600원",
        "환율정보 : USD 1,500",
        "1인당 NET : 1,277,600",
        "(6.58%)",
        "최종 입금가 : 1,367,600",
        "최종 안내사항",
        "유효기간 : 2026-05-10 까지입니다.",
        "항공료 395,100",
        "요금1",
        "항공료 230,000",
        "TAX 165,100",
        "합계",
        "395,100",
        "요금2",
        "항공료 230,000",
        "TAX 165,100",
        "합계",
        "395,100",
        "비고사항",
        "지상 요금 877,500원",
        "전환코드 : 상세 306627",
        "지불방식",
        "지불방식",
        "합계",
        "지불방식",
        "877,500",
        "합계",
        "877,500",
        "비고사항",
        "총 정리 금액 : 5,000원",
        "총 금액 5,000원",
        "인원수 : 0",
        "대행비 공지 :",
        "FOC 0",
        "보험료",
        "기타 0",
        "합계",
        "5,000",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.header.validUntil).toBe("2026-05-10");
    expect(result.diagnostics.raw.summary).toMatchObject({
      currKndCd: "USD",
      untAmt: 1500,
      persPerFare: 1277600,
      add1Amt: 90000,
      totalSum: 1367600,
    });
    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice, item.currencyRateId])).toEqual([
      ["FLIGHT", "항공료", 230000, "krw"],
      ["FLIGHT", "TAX", 165100, "krw"],
      ["VEHICLE", "지상비", 877500, "krw"],
      ["OTHER", "보험료", 5000, "krw"],
      ["OTHER", "1인당 예상수익", 90000, "krw"],
    ]);
    expect(result.quote.summary.subtotal).toBe(1367600);
    expect(result.quote.items.some((item) => item.description.includes("총 견적가"))).toBe(false);
    expect(result.quote.items.some((item) => item.description.includes("환율정보"))).toBe(false);
    expect(result.quote.items.some((item) => item.description.includes("총 정리 금액"))).toBe(false);
    expect(result.quote.items.some((item) => item.description.includes("총 금액"))).toBe(false);
    expect(result.diagnostics.requiredCurrencyCodes).toEqual([]);
  });

  it("recovers fee details and expected profit when OCR drops fee amounts onto the section total", () => {
    const result = parseQuoteResponseText({
      text: [
        "견적 답변 정보",
        "총 견적가 : 1,393,300원",
        "환율 정보 : USD 1,500",
        "1인당 NET : 1,303,300",
        "최종 입금가 : 1,393,300",
        "항공료 395,100",
        "요금1",
        "항공료 230,000",
        "TAX 165,100",
        "합계",
        "395,100",
        "비고사항",
        "지상 요금 877,500원",
        "지불방식",
        "합계",
        "877,500",
        "비고사항",
        "총 정리 금액 : 30,700원",
        "인솔자 비용 25,700",
        "보험요",
        "기타 0",
        "합계",
        "30,700",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.diagnostics.raw.summary.add1Amt).toBe(90000);
    expect(result.quote.items.map((item) => [item.category, item.description, item.unitPrice, item.currencyRateId])).toEqual([
      ["FLIGHT", "항공료", 230000, "krw"],
      ["FLIGHT", "TAX", 165100, "krw"],
      ["VEHICLE", "지상비", 877500, "krw"],
      ["OTHER", "인솔자비", 25700, "krw"],
      ["OTHER", "보험료", 5000, "krw"],
      ["OTHER", "1인당 예상수익", 90000, "krw"],
    ]);
    expect(result.quote.summary.subtotal).toBe(1393300);
  });

  it("skips exchange-rate summary rows and parses D-day meal section as meals", () => {
    const result = parseQuoteResponseText({
      text: [
        "최종합계 970,000원",
        "환율기준 KRW 1,500",
        "1인당 NET 871,800",
        "1인당 예상수익 98,200",
        "항공 요금 458,600원",
        "항공료 260,000",
        "TAX 198,600",
        "지상 요금 382,500원",
        "지상비 382,500",
        "공동 경비 요금 30,700원",
        "인솔자비 25,700",
        "보험료 5,000",
        "[식사]",
        "D1:현지식$4",
        "D2:현지식$4/삼겹살무제한$7",
        "D3:산천어특식 $6/현지식 $4",
        "D4:냉면+탕수육$4",
      ].join("\n"),
      passengerCount: 18,
      dayDates: [
        { dayNo: 1, date: "2026-10-19" },
        { dayNo: 2, date: "2026-10-20" },
        { dayNo: 3, date: "2026-10-21" },
        { dayNo: 4, date: "2026-10-22" },
      ],
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items.some((item) => item.description.includes("환율기준"))).toBe(false);
    expect(result.diagnostics.raw.summary.untAmt).toBe(1500);
    expect(result.quote.items.filter((item) => item.category === "MEAL").map((item) => [
      item.date,
      item.description,
      item.quantity,
      item.unitPrice,
      item.currencyRateId,
    ])).toEqual([
      ["2026-10-19", "현지식", 18, 4, "usd"],
      ["2026-10-20", "현지식", 18, 4, "usd"],
      ["2026-10-20", "삼겹살무제한", 18, 7, "usd"],
      ["2026-10-21", "산천어특식", 18, 6, "usd"],
      ["2026-10-21", "현지식", 18, 4, "usd"],
      ["2026-10-22", "냉면+탕수육", 18, 4, "usd"],
    ]);
  });

  it("splits adult and child per-person package prices", () => {
    const result = parseQuoteResponseText({
      text: [
        "성인 25+아동 3 헤난 가든 인당 성인 $450 / 아동 $160",
        "ㄴ호텔: 가든 디럭스 12객실*3박/ 2인1실 + 트리플 1객실 총 13객실 기준",
        "ㄴ포함사항: 디몰투어, 황제70분*2회, 세일링보트, 크리스탈코브 호핑",
        "ㄴ불포함사항: 개인경비 및 매너팁",
        "ㄴ차량: 대형버스 (45인승)",
        "ㄴ노쇼핑, 노옵션 조건",
      ].join("\n"),
      quoteHeader: { writtenAt: "2026-05-19", validUntil: "2026-05-19" },
    });

    expect(result.quote.items).toHaveLength(2);
    expect(result.quote.items[0]).toMatchObject({
      category: "OTHER",
      description: expect.stringContaining("헤난 가든 성인 인당"),
      quantity: 25,
      unitPrice: 450,
      currencyRateId: "usd",
    });
    expect(result.quote.items[0]?.description).toContain("호텔: 가든 디럭스");
    expect(result.quote.items[1]).toMatchObject({
      description: "헤난 가든 아동 인당",
      quantity: 3,
      unitPrice: 160,
      currencyRateId: "usd",
    });
    expect(result.diagnostics.requiredCurrencyCodes).toEqual(["USD"]);
  });
});
