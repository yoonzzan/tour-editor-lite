"use client";

// T-402: QuoteEditor 컴포넌트 껍데기 + 헤더
// T-403: 일정표 항목 연동 → 견적 행 자동 생성
// T-404: 단가 입력 → 합계 자동 계산 (디바운스 300ms)
// T-405: 항목별·구분별 건별합계 자동 계산
// T-406: 총 경비 섹션 (합계 + 수수료 + VAT + TOTAL)
// T-409: 가격 표시 방식 드롭다운 (sales 전용)

import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { useEditorStore } from "@/hooks/useEditorStore";
import { withAccessCodeHeaders } from "@/lib/converter/clientAccess";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  generateQuoteItems,
} from "@/lib/quote/generate";
import {
  DEFAULT_EXCHANGE_RATE_ID,
  DEFAULT_EXCHANGE_RATE,
  calculateItemSubtotalKrw,
  getExchangeRateForItem,
  getQuoteExchangeRates,
  normalizeCurrencyCode,
  recalculateQuoteData,
} from "@/lib/quote/currency";
import { todayInKorea } from "@/lib/date/korea";
import { Role, type QuoteCategory, type QuoteExchangeRate, type QuoteItem } from "@/types";
import type { QuoteResponseParseResult } from "@/lib/quote/responseParser";

type PriceMode = "상세" | "총액" | "숨김";
type QuoteResponseInputMode = "text" | "image";

const QUOTE_RESPONSE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
const QUOTE_RESPONSE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const QUOTE_RESPONSE_TEXT_PLACEHOLDER = [
  "최종합계 1,650,000원",
  "환율기준 USD 1,350",
  "항공 요금 955,000원 항공료 830,000 TAX 125,000 합계 955,000",
  "지상 요금 520,000원 지상비 520,000 합계 520,000",
  "공동 경비 요금 43,000원 보험료 8,000 FOC 35,000 합계 43,000",
  "",
  "성인 25+아동 3",
  "[식사]",
  "2일차 중식 현지식$10 / 석식 한식$10",
  "3일차 중식 한식$10 / 석식 현지식$10",
].join("\n");

type QuoteResponsePreview = QuoteResponseParseResult & {
  exchangeRates: QuoteExchangeRate[];
  ocrText?: string;
  normalizedText?: string;
};

const CATEGORY_COLORS: Record<QuoteCategory, string> = {
  FLIGHT: "bg-blue-100 text-blue-700",
  HOTEL: "bg-purple-100 text-purple-700",
  SIGHTSEEING: "bg-green-100 text-green-700",
  MEAL: "bg-orange-100 text-orange-700",
  VEHICLE: "bg-cyan-100 text-cyan-700",
  GUIDE: "bg-pink-100 text-pink-700",
  OTHER: "bg-gray-100 text-gray-600",
};

function normalizeNumberInputValue(value: string): string {
  if (value === "") return "";
  return value.replace(/^0+(?=\d)/u, "");
}

function parseNonNegativeInteger(value: string): number {
  const normalized = normalizeNumberInputValue(value.replace(/[^\d]/gu, ""));
  return Math.max(0, Number(normalized));
}

function formatIntegerInputValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, Math.trunc(value)).toLocaleString();
}

function readNonNegativeInput(input: HTMLInputElement): number {
  const nextValue = parseNonNegativeInteger(input.value);
  input.value = formatIntegerInputValue(nextValue);
  return nextValue;
}

function AutoResizeTextarea({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "hub-textarea w-full overflow-hidden",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    if (value.trim().length === 0) {
      textarea.style.height = "var(--hub-control-height)";
      return;
    }
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

interface Props {
  role: Role;
}

export function QuoteEditor({ role }: Props) {
  const { itinerary, quote, setQuote } = useEditorStore();
  const [localItems, setLocalItems] = useState<QuoteItem[]>(
    quote?.items ?? []
  );
  const [agencyFee, setAgencyFee] = useState(
    quote?.summary.agencyFee ?? 0
  );
  const [groundProfit, setGroundProfit] = useState(
    quote?.summary.groundProfit ?? 0
  );
  const [exchangeRates, setExchangeRates] = useState<QuoteExchangeRate[]>(
    getQuoteExchangeRates(quote)
  );
  const [priceMode, setPriceMode] = useState<PriceMode>("상세");
  const [quoteResponseOpen, setQuoteResponseOpen] = useState(false);
  const [quoteResponseInputMode, setQuoteResponseInputMode] = useState<QuoteResponseInputMode>("text");
  const [quoteResponseText, setQuoteResponseText] = useState("");
  const [quoteResponseImage, setQuoteResponseImage] = useState<File | null>(null);
  const [quoteResponseLoading, setQuoteResponseLoading] = useState(false);
  const [quoteResponseError, setQuoteResponseError] = useState<string | null>(null);
  const [quoteResponsePreview, setQuoteResponsePreview] = useState<QuoteResponsePreview | null>(null);
  // 스토어 값 동기화
  useEffect(() => {
    if (quote) {
      setLocalItems(quote.items);
      setGroundProfit(quote.summary.groundProfit ?? 0);
      setAgencyFee(quote.summary.agencyFee);
      setExchangeRates(getQuoteExchangeRates(quote));
    }
  }, [quote]);

  // ── 계산 ───────────────────────────────────────────────
  const itemsWithSub = localItems.map((it) => ({
    ...it,
    currencyRateId: it.currencyRateId ?? DEFAULT_EXCHANGE_RATE_ID,
    subtotal: calculateItemSubtotalKrw(it, exchangeRates),
  }));
  const grandSubtotal = itemsWithSub.reduce((s, it) => s + it.subtotal, 0);
  const vat = Math.round(agencyFee * 0.1);
  const total = grandSubtotal + groundProfit + agencyFee + vat;
  const passengerCount =
    (itinerary?.overview.passengers.adult ?? 0) +
    (itinerary?.overview.passengers.child ?? 0) +
    (itinerary?.overview.passengers.infant ?? 0);
  const groundProfitPerPerson =
    passengerCount > 0 ? Math.round(groundProfit / passengerCount) : 0;
  const agencyFeePerPerson =
    passengerCount > 0 ? Math.round(agencyFee / passengerCount) : 0;

  // ── 즉시 스토어 반영 (T-404) ────────────────────────────
  const quoteHeader = quote?.header ?? { writtenAt: todayInKorea() };
  const validUntil = quoteHeader.validUntil || quoteHeader.writtenAt;

  function scheduleWrite(
    items: QuoteItem[],
    ground: number,
    fee: number,
    rates: QuoteExchangeRate[]
  ) {
    setQuote(recalculateQuoteData({
      header: quoteHeader,
      items,
      exchangeRates: rates,
      groundProfit: ground,
      agencyFee: fee,
    }));
  }

  function handleItemChange(updated: Partial<QuoteItem> & { id: string }) {
    const newItems = localItems.map((it) =>
      it.id === updated.id ? { ...it, ...updated } : it
    );
    setLocalItems(newItems);
    scheduleWrite(newItems, groundProfit, agencyFee, exchangeRates);
  }

  function handleGroundProfitChange(value: number) {
    setGroundProfit(value);
    scheduleWrite(localItems, value, agencyFee, exchangeRates);
  }

  function handleFeeChange(fee: number) {
    setAgencyFee(fee);
    scheduleWrite(localItems, groundProfit, fee, exchangeRates);
  }

  function handleValidUntilChange(value: string) {
    setQuote(recalculateQuoteData({
      header: {
        ...quoteHeader,
        validUntil: value || quoteHeader.writtenAt,
      },
      items: localItems,
      exchangeRates,
      groundProfit,
      agencyFee,
    }));
  }

  function handleRateChange(updated: QuoteExchangeRate) {
    const nextRates = exchangeRates.map((rate) =>
      rate.id === updated.id ? updated : rate
    );
    setExchangeRates(nextRates);
    scheduleWrite(localItems, groundProfit, agencyFee, nextRates);
  }

  function handleAddRate() {
    const newRate: QuoteExchangeRate = {
      id: uuidv4(),
      code: "USD",
      rateToKrw: 0,
    };
    const nextRates = [...exchangeRates, newRate];
    setExchangeRates(nextRates);
    scheduleWrite(localItems, groundProfit, agencyFee, nextRates);
  }

  function handleRemoveRate(rateId: string) {
    const nextRates = exchangeRates.filter((rate) => rate.id !== rateId);
    const nextItems = localItems.map((item) =>
      item.currencyRateId === rateId
        ? { ...item, currencyRateId: DEFAULT_EXCHANGE_RATE_ID }
        : item
    );
    setExchangeRates(nextRates);
    setLocalItems(nextItems);
    scheduleWrite(nextItems, groundProfit, agencyFee, nextRates);
  }

  function handleAutoGenerate() {
    if (!itinerary) return;
    const generated = generateQuoteItems(itinerary);
    setLocalItems(generated);
    scheduleWrite(generated, groundProfit, agencyFee, exchangeRates);
  }

  function openQuoteResponseImport() {
    setQuoteResponseOpen(true);
    setQuoteResponseError(null);
    setQuoteResponsePreview(null);
  }

  function closeQuoteResponseImport() {
    if (quoteResponseLoading) return;
    setQuoteResponseOpen(false);
    setQuoteResponseError(null);
  }

  function buildQuoteResponseDayDates() {
    return (itinerary?.days ?? []).map((day) => ({
      dayNo: day.dayNo,
      date: day.date,
    }));
  }

  function withPreviewRequiredRates(parsed: QuoteResponseParseResult): QuoteResponsePreview {
    const required = new Set(parsed.diagnostics.requiredCurrencyCodes);
    const summaryRate = parsed.diagnostics.raw.summary.untAmt;
    const summaryRateCode = parsed.diagnostics.raw.summary.currKndCd;
    const inferredSummaryRateFor = (code: "USD" | "JPY") => {
      if (summaryRate <= 1) return 0;
      if (summaryRateCode === code) return summaryRate;
      if (summaryRateCode === "KRW" && required.size === 1 && required.has(code)) return summaryRate;
      return 0;
    };
    const rates = getQuoteExchangeRates(parsed.quote).map((rate) => {
      if (rate.id === DEFAULT_EXCHANGE_RATE_ID) return rate;
      if (required.has(rate.code as "USD" | "JPY")) {
        const existing = exchangeRates.find((current) => current.code === rate.code);
        const summaryDefault = inferredSummaryRateFor(rate.code as "USD" | "JPY");
        return {
          ...rate,
          rateToKrw: summaryDefault || (existing && existing.rateToKrw > 1 ? existing.rateToKrw : 0),
        };
      }
      return rate;
    });
    if (summaryRate > 1 && summaryRateCode !== "KRW" && !rates.some((rate) => rate.code === summaryRateCode)) {
      rates.push({
        id: summaryRateCode.toLowerCase(),
        code: summaryRateCode,
        rateToKrw: summaryRate,
      });
    }

    return {
      ...parsed,
      exchangeRates: rates.length > 0 ? rates : [DEFAULT_EXCHANGE_RATE],
    };
  }

  async function handleParseQuoteResponse() {
    if (!quoteResponseText.trim()) {
      setQuoteResponseError("견적답변 텍스트를 입력해 주세요.");
      return;
    }

    setQuoteResponseLoading(true);
    setQuoteResponseError(null);
    setQuoteResponsePreview(null);
    try {
      const response = await fetch("/api/quote-response/parse", {
        method: "POST",
        headers: withAccessCodeHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          text: quoteResponseText,
          dayDates: buildQuoteResponseDayDates(),
          passengerCount,
          quoteHeader,
        }),
      });
      const payload = (await response.json()) as Partial<QuoteResponseParseResult> & { error?: string };
      if (!response.ok || !payload.quote || !payload.diagnostics || !payload.extractedText) {
        throw new Error(payload.error ?? "견적답변을 파싱하지 못했습니다.");
      }
      setQuoteResponsePreview(withPreviewRequiredRates(payload as QuoteResponseParseResult));
    } catch (error) {
      setQuoteResponseError(error instanceof Error ? error.message : "견적답변을 파싱하지 못했습니다.");
    } finally {
      setQuoteResponseLoading(false);
    }
  }

  async function handleParseQuoteResponseImage() {
    if (!quoteResponseImage) {
      setQuoteResponseError("OCR 처리할 이미지 파일을 선택해 주세요.");
      return;
    }

    setQuoteResponseLoading(true);
    setQuoteResponseError(null);
    setQuoteResponsePreview(null);
    try {
      const formData = new FormData();
      formData.append("image", quoteResponseImage);
      formData.append("dayDates", JSON.stringify(buildQuoteResponseDayDates()));
      formData.append("passengerCount", String(passengerCount));
      formData.append("quoteHeader", JSON.stringify(quoteHeader));

      const response = await fetch("/api/quote-response/parse", {
        method: "POST",
        headers: withAccessCodeHeaders(),
        body: formData,
      });
      const payload = (await response.json()) as Partial<QuoteResponsePreview> & { error?: string };
      if (!response.ok || !payload.quote || !payload.diagnostics || !payload.extractedText) {
        throw new Error(payload.error ?? "이미지 견적답변을 분석하지 못했습니다.");
      }
      setQuoteResponseText(payload.normalizedText ?? payload.extractedText);
      setQuoteResponsePreview(withPreviewRequiredRates(payload as QuoteResponseParseResult));
    } catch (error) {
      setQuoteResponseError(error instanceof Error ? error.message : "이미지 견적답변을 분석하지 못했습니다.");
    } finally {
      setQuoteResponseLoading(false);
    }
  }

  function handleQuoteResponseRateChange(rateId: string, value: number) {
    setQuoteResponsePreview((preview) => {
      if (!preview) return preview;
      return {
        ...preview,
        exchangeRates: preview.exchangeRates.map((rate) =>
          rate.id === rateId ? { ...rate, rateToKrw: value } : rate
        ),
      };
    });
  }

  function handleQuoteResponseBulkQuantityChange(value: number) {
    const quantity = Math.max(1, Math.round(value));
    setQuoteResponsePreview((preview) => {
      if (!preview) return preview;
      const nextItems = preview.quote.items.map((item) => ({
        ...item,
        quantity,
      }));
      return {
        ...preview,
        quote: recalculateQuoteData({
          header: preview.quote.header,
          items: nextItems,
          exchangeRates: preview.exchangeRates,
          groundProfit: preview.quote.summary.groundProfit,
          agencyFee: preview.quote.summary.agencyFee,
        }),
      };
    });
  }

  function canApplyQuoteResponsePreview(preview: QuoteResponsePreview): boolean {
    return preview.diagnostics.requiredCurrencyCodes.every((code) => {
      const rate = preview.exchangeRates.find((entry) => entry.code === code);
      return Boolean(rate && rate.rateToKrw > 0);
    });
  }

  function handleApplyQuoteResponse() {
    if (!quoteResponsePreview || !canApplyQuoteResponsePreview(quoteResponsePreview)) return;

    const nextQuote = recalculateQuoteData({
      header: quoteResponsePreview.quote.header,
      items: quoteResponsePreview.quote.items,
      exchangeRates: quoteResponsePreview.exchangeRates,
      groundProfit: quoteResponsePreview.quote.summary.groundProfit,
      agencyFee: quoteResponsePreview.quote.summary.agencyFee,
    });
    setLocalItems(nextQuote.items);
    setGroundProfit(nextQuote.summary.groundProfit);
    setAgencyFee(nextQuote.summary.agencyFee);
    setExchangeRates(getQuoteExchangeRates(nextQuote));
    setQuote(nextQuote);
    setQuoteResponseOpen(false);
    setQuoteResponsePreview(null);
  }

  function handleAddRow(category: QuoteCategory) {
    const newItem: QuoteItem = {
      id: uuidv4(),
      category,
      region: "",
      date: "",
      description: "",
      quantity: 1,
      unitPrice: 0,
      currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
      subtotal: 0,
    };
    const newItems = [...localItems, newItem].sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    );
    setLocalItems(newItems);
    scheduleWrite(newItems, groundProfit, agencyFee, exchangeRates);
  }

  function handleRemoveRow(id: string) {
    const newItems = localItems.filter((it) => it.id !== id);
    setLocalItems(newItems);
    scheduleWrite(newItems, groundProfit, agencyFee, exchangeRates);
  }

  // ── 그룹핑 (T-405) ────────────────────────────────────
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: itemsWithSub.filter((it) => it.category === cat),
    subtotal: itemsWithSub
      .filter((it) => it.category === cat)
      .reduce((s, it) => s + it.subtotal, 0),
  })).filter((g) => g.items.length > 0);

  const isPartner = role === Role.PARTNER;
  const isSales = role === Role.SALES;
  const showPrices = priceMode !== "숨김";

  return (
    <div className="flex w-full flex-col gap-4 pb-16">
      {/* ── 헤더 (T-402) ─────────────────────────────── */}
      <div className="flex items-center justify-between hub-section-head">
        <h2 className="text-[13px] font-semibold text-foreground">견적서 에디터</h2>
        <div className="flex items-center gap-2">
          {/* T-409: sales 전용 가격 표시 방식 */}
          {isSales && (
            <select
              aria-label="가격 표시 방식"
              value={priceMode}
              onChange={(e) => setPriceMode(e.target.value as PriceMode)}
              className="hub-input focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="상세">상세</option>
              <option value="총액">총액</option>
              <option value="숨김">숨김</option>
            </select>
          )}

          {/* 자동 생성 버튼 */}
          <button
            onClick={handleAutoGenerate}
            disabled={!itinerary}
            className="hub-btn hub-btn-custom disabled:opacity-40"
            title={!itinerary ? "일정을 먼저 불러오세요" : undefined}
          >
            일정에서 자동 생성
          </button>
          <button
            type="button"
            onClick={openQuoteResponseImport}
            className="hub-btn hub-btn-primary"
          >
            견적답변 불러오기
          </button>
        </div>
      </div>

      <section className="hub-section p-3">
        <div className="flex items-center gap-2">
          <label
            htmlFor="quote-valid-until"
            className="whitespace-nowrap text-[11.5px] font-semibold text-red-600"
          >
            유효기간
          </label>
          <input
            id="quote-valid-until"
            type="date"
            value={validUntil}
            onChange={(e) => handleValidUntilChange(e.target.value)}
            aria-label="유효기간"
            className="hub-input w-36 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </section>

      {showPrices && (
        <section className="hub-section p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="hub-section-title">
              환율 설정
            </h3>
            <button
              type="button"
              onClick={handleAddRate}
              className="hub-btn hub-btn-custom"
            >
              + 통화
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {exchangeRates.map((rate) => {
              const isDefault = rate.id === DEFAULT_EXCHANGE_RATE_ID;
              return (
                <div
                  key={rate.id}
                  className="grid grid-cols-[auto_4.5rem_auto_1fr_auto] items-center gap-2 text-[12.5px]"
                >
                  <span className="text-muted-foreground">1</span>
                  <input
                    type="text"
                    value={rate.code}
                    disabled={isDefault}
                    onChange={(e) =>
                      handleRateChange({
                        ...rate,
                        code: normalizeCurrencyCode(e.target.value),
                      })
                    }
                    aria-label="통화코드"
                    className="hub-input font-medium disabled:bg-muted/40"
                  />
                  <span className="text-muted-foreground">=</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={formatIntegerInputValue(rate.rateToKrw)}
                    disabled={isDefault}
                    onChange={(e) =>
                      handleRateChange({
                        ...rate,
                        rateToKrw: readNonNegativeInput(e.currentTarget),
                      })
                    }
                    aria-label={`${rate.code} 원화 환율`}
                    className="hub-input text-right disabled:bg-muted/40"
                  />
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">원</span>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => handleRemoveRate(rate.id)}
                        aria-label={`${rate.code} 환율 삭제`}
                        className="hub-btn-text px-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 빈 상태 안내 ──────────────────────────────── */}
      {localItems.length === 0 && (
        <div className="hub-section flex flex-col items-center justify-center gap-3 border-dashed py-12 text-center">
          <p className="text-[12.5px] text-muted-foreground">
            견적 항목이 없습니다.
          </p>
          {itinerary ? (
            <button
              onClick={handleAutoGenerate}
              className="hub-btn hub-btn-primary"
            >
              일정표에서 자동 생성
            </button>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              먼저 일정표 탭에서 일정을 불러오세요.
            </p>
          )}
        </div>
      )}

      {/* ── 구분별 테이블 (T-403, T-404, T-405) ─────── */}
      {grouped.map(({ category, items, subtotal: catSubtotal }) => (
        <section key={category} className="hub-section overflow-hidden">
          {/* 구분 헤더 */}
          <div className="hub-section-head">
            <span
              className={`rounded px-2 py-0.5 text-[11.5px] font-semibold ${CATEGORY_COLORS[category]}`}
            >
              {CATEGORY_LABELS[category]}
            </span>
            {showPrices && (
              <span className="text-[12.5px] font-medium text-foreground">
                소계: {catSubtotal.toLocaleString()} 원
              </span>
            )}
          </div>

          {/* 행 목록 */}
          <div className="overflow-x-auto">
            <table className="hub-grid">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-3 py-2 text-center font-medium w-24">날짜</th>
                  <th className="px-3 py-2 text-center font-medium w-24">지역</th>
                  <th className="px-3 py-2 text-center font-medium w-56">내용</th>
                  {showPrices && (
                    <>
                      <th className="px-3 py-2 text-center font-medium w-16">수량</th>
                      <th className="px-3 py-2 text-center font-medium w-44">단가</th>
                      <th className="px-3 py-2 text-center font-medium w-28">합계 (원)</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <QuoteRow
                    key={item.id}
                    item={item}
                    exchangeRates={exchangeRates}
                    showPrices={showPrices}
                    category={category}
                    onChange={handleItemChange}
                    onRemove={() => handleRemoveRow(item.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* 행 추가 */}
          <div className="border-t border-border px-3 py-1.5">
            <button
              onClick={() => handleAddRow(category)}
              className="hub-btn hub-btn-text"
            >
              + {CATEGORY_LABELS[category]} 행 추가
            </button>
          </div>
        </section>
      ))}

      {/* 전체 행 추가 드롭다운 영역 */}
      {localItems.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              onClick={() => handleAddRow(cat)}
              className="hub-btn hub-btn-custom"
            >
              + {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      )}

      {/* ── 총 경비 섹션 (T-406) ─────────────────────── */}
      {localItems.length > 0 && (
        <section className="hub-section p-3">
          <h3 className="mb-3 hub-section-title">
            총 경비
          </h3>

          {priceMode === "숨김" ? (
            <p className="text-[12.5px] text-muted-foreground">가격이 숨겨진 상태입니다.</p>
          ) : priceMode === "총액" ? (
            <div className="flex items-center justify-between border border-grid-border bg-[hsl(var(--hub-cyan-soft))] px-4 py-3">
              <span className="text-[12.5px] font-semibold text-foreground">총액</span>
              <span className="text-[12.5px] font-bold text-primary">
                {total.toLocaleString()} 원
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <SummaryRow label="항목소계" value={grandSubtotal} />
              {(isPartner || groundProfit > 0) && (
                <div className="grid grid-cols-[8rem_1fr] items-center gap-3 px-3 py-1 text-[12.5px]">
                  <label className="text-muted-foreground">
                    지상비수익
                  </label>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {isPartner ? (
                      <input
                        type="text"
                        inputMode="numeric"
                        value={formatIntegerInputValue(groundProfit)}
                        onChange={(e) =>
                          handleGroundProfitChange(readNonNegativeInput(e.currentTarget))
                        }
                        aria-label="지상비수익"
                        className="hub-input w-36 text-right"
                      />
                    ) : (
                      <span className="w-36 text-right font-medium text-foreground">
                        {groundProfit.toLocaleString()}
                      </span>
                    )}
                    <span className="text-muted-foreground">원</span>
                    <span className="text-[11.5px] text-muted-foreground">
                      1인당 {groundProfitPerPerson.toLocaleString()} 원
                    </span>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-[8rem_1fr] items-center gap-3 px-3 py-1 text-[12.5px]">
                <label className="text-muted-foreground">
                  하나투어수익
                </label>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={formatIntegerInputValue(agencyFee)}
                    onChange={(e) =>
                      handleFeeChange(readNonNegativeInput(e.currentTarget))
                    }
                    aria-label="하나투어수익"
                    className="hub-input w-36 text-right"
                  />
                  <span className="text-muted-foreground">원</span>
                  <span className="text-[11.5px] text-muted-foreground">
                    1인당 {agencyFeePerPerson.toLocaleString()} 원
                  </span>
                </div>
              </div>
              <SummaryRow label="VAT" value={vat} />
              <div className="mt-1 grid grid-cols-[8rem_1fr] items-center border border-primary/20 bg-primary/10 px-3 py-2">
                <span className="text-[12.5px] font-semibold text-foreground">TOTAL</span>
                <span className="text-right text-[12.5px] font-bold text-primary">
                  {total.toLocaleString()} 원
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {quoteResponseOpen && (
        <QuoteResponseImportModal
          text={quoteResponseText}
          mode={quoteResponseInputMode}
          image={quoteResponseImage}
          loading={quoteResponseLoading}
          error={quoteResponseError}
          preview={quoteResponsePreview}
          onModeChange={(mode) => {
            setQuoteResponseInputMode(mode);
            setQuoteResponseError(null);
          }}
          onTextChange={(value) => {
            setQuoteResponseText(value);
            if (quoteResponsePreview) setQuoteResponsePreview(null);
          }}
          onImageChange={(file) => {
            setQuoteResponseImage(file);
            setQuoteResponseError(null);
            if (quoteResponsePreview) setQuoteResponsePreview(null);
          }}
          onParse={() => void handleParseQuoteResponse()}
          onParseImage={() => void handleParseQuoteResponseImage()}
          onRateChange={handleQuoteResponseRateChange}
          onBulkQuantityChange={handleQuoteResponseBulkQuantityChange}
          canApply={quoteResponsePreview ? canApplyQuoteResponsePreview(quoteResponsePreview) : false}
          onApply={handleApplyQuoteResponse}
          onClose={closeQuoteResponseImport}
        />
      )}
    </div>
  );
}

interface QuoteResponseImportModalProps {
  text: string;
  mode: QuoteResponseInputMode;
  image: File | null;
  loading: boolean;
  error: string | null;
  preview: QuoteResponsePreview | null;
  canApply: boolean;
  onModeChange: (mode: QuoteResponseInputMode) => void;
  onTextChange: (value: string) => void;
  onImageChange: (file: File | null) => void;
  onParse: () => void;
  onParseImage: () => void;
  onRateChange: (rateId: string, value: number) => void;
  onBulkQuantityChange: (value: number) => void;
  onApply: () => void;
  onClose: () => void;
}

function QuoteResponseProgressOverlay({ mode }: { mode: QuoteResponseInputMode }) {
  const stages = [
    { key: "received", label: "확인" },
    { key: "extracting", label: "읽기" },
    { key: "analyzing", label: "파악" },
    { key: "completed", label: "정리" },
  ];
  const activeIndex = mode === "image" ? 1 : 2;

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 px-6 backdrop-blur-[1px]"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <svg aria-hidden="true" viewBox="0 0 112 112" className="h-24 w-24 text-primary">
          <defs>
            <filter id="quote-response-progress-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <circle cx="56" cy="56" r="34" fill="currentColor" opacity="0.08" className="animate-pulse" />
          <g className="origin-center animate-spin" style={{ animationDuration: "1.8s" }}>
            <path
              d="M56 16a40 40 0 0 1 39 31"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="4"
              filter="url(#quote-response-progress-glow)"
            />
            <circle cx="96" cy="56" r="4" fill="currentColor" />
          </g>
          <g className="origin-center animate-spin" style={{ animationDuration: "3.2s", animationDirection: "reverse" }}>
            <path
              d="M28 28a40 40 0 0 0-8 49"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
              strokeOpacity="0.45"
            />
            <circle cx="23" cy="75" r="3" fill="currentColor" opacity="0.7" />
          </g>
          <path
            d="M42 58h28M42 46h22M42 70h18"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="4"
            strokeOpacity="0.75"
          />
        </svg>
        <div className="flex flex-col gap-2">
          <p className="text-[14px] font-bold text-foreground">
            견적답변을 분석하고 있습니다.
          </p>
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">
            {mode === "image"
              ? "스크린샷의 견적답변을 읽고 미리보기를 준비하고 있습니다."
              : "입력한 견적답변을 견적 행으로 정리하고 있습니다."}
          </p>
        </div>
        <div className="flex items-center justify-center gap-3" aria-hidden="true">
          {stages.map((step, index) => {
            const isDone = index < activeIndex;
            const isActive = index === activeIndex;
            return (
              <div key={step.key} className="flex flex-col items-center gap-1.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full transition-colors ${
                    isDone || isActive ? "bg-primary" : "bg-muted-foreground/25"
                  } ${isActive ? "animate-pulse" : ""}`}
                />
                <span className={`text-[11.5px] ${isDone || isActive ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function QuoteResponseImportModal({
  text,
  mode,
  image,
  loading,
  error,
  preview,
  canApply,
  onModeChange,
  onTextChange,
  onImageChange,
  onParse,
  onParseImage,
  onRateChange,
  onBulkQuantityChange,
  onApply,
  onClose,
}: QuoteResponseImportModalProps) {
  const [isImageDragActive, setIsImageDragActive] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const displayRateCodes = new Set(preview?.diagnostics.requiredCurrencyCodes ?? []);
  const summaryRate = preview?.diagnostics.raw.summary.untAmt ?? 0;
  const summaryRateCode = preview?.diagnostics.raw.summary.currKndCd;
  if (summaryRate > 1 && summaryRateCode && summaryRateCode !== "KRW") {
    displayRateCodes.add(summaryRateCode);
  }
  const previewRates = preview?.exchangeRates ?? [];
  const displayItems = preview?.quote.items ?? [];
  const bulkQuantityValue =
    displayItems.length > 0 && displayItems.every((item) => item.quantity === displayItems[0]?.quantity)
      ? formatIntegerInputValue(displayItems[0]?.quantity ?? 1)
      : "";
  const hasPreviewMissingRate = displayItems.some((item) => {
    const rate = getExchangeRateForItem(previewRates, item);
    return rate.id !== DEFAULT_EXCHANGE_RATE_ID && rate.rateToKrw <= 0;
  });
  const previewItemsTotal = hasPreviewMissingRate
    ? 0
    : displayItems.reduce((sum, item) => sum + calculateItemSubtotalKrw(item, previewRates), 0);
  const previewTotal = preview
    ? previewItemsTotal + preview.quote.summary.groundProfit + preview.quote.summary.agencyFee + preview.quote.summary.vat
    : 0;
  const displayWarnings = (preview?.diagnostics.warnings ?? []).filter((warning) => {
    if (!/환율 입력이 필요합니다/u.test(warning)) return true;
    return hasPreviewMissingRate;
  });

  function handleImageFileChange(file: File | null) {
    if (!file) {
      onImageChange(null);
      return;
    }
    if (!QUOTE_RESPONSE_IMAGE_TYPES.has(file.type)) return;
    onImageChange(file);
  }

  return (
    <div className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[rgba(0,0,0,0.45)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="quote-response-import-title"
        className="hub-dialog relative z-modal flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <div className="hub-dialog-head shrink-0">
          <h3 id="quote-response-import-title" className="text-[13px] font-bold leading-5">
            견적답변 불러오기
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="닫기"
            className="hub-btn-text px-2 text-chrome-sidebar-foreground hover:bg-chrome-sidebar-hover disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <section className="flex min-h-[360px] flex-col gap-3">
            <div className="grid grid-cols-2 border border-border text-[12.5px]">
              {(["text", "image"] as const).map((nextMode) => (
                <button
                  key={nextMode}
                  type="button"
                  onClick={() => onModeChange(nextMode)}
                  disabled={loading}
                  className={`px-3 py-2 font-medium disabled:opacity-50 ${
                    mode === nextMode
                      ? "bg-primary text-primary-foreground"
                      : "bg-white text-muted-foreground hover:bg-muted/30"
                  }`}
                >
                  {nextMode === "text" ? "텍스트" : "스크린샷 첨부"}
                </button>
              ))}
            </div>

            {mode === "image" && (
              <>
                <div
                  role="region"
                  aria-label="스크린샷 이미지 파일 드롭 영역"
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (!loading) setIsImageDragActive(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!loading) event.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setIsImageDragActive(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setIsImageDragActive(false);
                    if (loading) return;
                    handleImageFileChange(event.dataTransfer.files.item(0));
                  }}
                  onClick={() => {
                    if (!loading) imageInputRef.current?.click();
                  }}
                  className={`flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed transition-colors ${
                    isImageDragActive
                      ? "border-primary bg-primary/5"
                      : "border-border bg-muted/20 hover:border-muted-foreground/50"
                  }`}
                >
                  <span className="text-2xl select-none">📎</span>
                  <p className="text-[12.5px] text-muted-foreground">
                    스크린샷 이미지 파일을 여기에 드래그하거나 클릭하여 선택하세요
                  </p>
                  <p className="text-[11.5px] text-muted-foreground">PNG, JPG, WEBP</p>
                </div>
                <input
                  ref={imageInputRef}
                  id="quote-response-image"
                  type="file"
                  accept={QUOTE_RESPONSE_IMAGE_ACCEPT}
                  onChange={(event) => handleImageFileChange(event.currentTarget.files?.[0] ?? null)}
                  disabled={loading}
                  className="hidden"
                  aria-label="스크린샷 이미지 파일 선택"
                />

                {image && (
                  <div className="border border-grid-border bg-muted/40 px-3 py-2">
                    <p className="truncate text-[12.5px] text-foreground">{image.name}</p>
                  </div>
                )}

                {!image && (
                  <p className="text-[12.5px] text-muted-foreground">
                    스크린샷 이미지 파일을 첨부하면 OCR 텍스트를 자동으로 채웁니다.
                  </p>
                )}
              </>
            )}

            <label htmlFor="quote-response-text" className="text-[12.5px] font-medium text-foreground">
              {mode === "image" ? "OCR 인식 텍스트" : "견적답변 텍스트"}
            </label>
            <textarea
              id="quote-response-text"
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              placeholder={QUOTE_RESPONSE_TEXT_PLACEHOLDER}
              className="min-h-[260px] flex-1 resize-none border border-input bg-white px-3 py-2 text-[12.5px] leading-5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {error && (
              <p role="alert" className="text-[12.5px] text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={mode === "image" ? onParseImage : onParse}
                disabled={loading || (mode === "image" ? !image : !text.trim())}
                className="hub-btn hub-btn-primary disabled:opacity-50"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
                    분석 중...
                  </span>
                ) : (
                  "미리보기 생성"
                )}
              </button>
            </div>
          </section>

          <section className="flex min-h-[360px] flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-[12.5px] font-semibold text-foreground">적용 미리보기</h4>
              {preview && (
                <span className="text-[11.5px] text-muted-foreground">
                  신뢰도 {preview.diagnostics.confidence}
                </span>
              )}
            </div>

            {!preview ? (
              <div className="flex min-h-[300px] items-center justify-center border border-dashed border-border bg-muted/20 text-[12.5px] text-muted-foreground">
                견적답변을 분석하면 생성될 견적 행이 표시됩니다.
              </div>
            ) : (
              <>
                {displayWarnings.length > 0 && (
                  <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-5 text-amber-800">
                    {displayWarnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                )}

                {previewRates.some((rate) => displayRateCodes.has(rate.code as "KRW" | "USD" | "JPY")) && (
                  <div className="grid gap-2 border border-grid-border bg-muted/20 p-3 sm:grid-cols-2">
                    {previewRates
                      .filter((rate) => displayRateCodes.has(rate.code as "KRW" | "USD" | "JPY"))
                      .map((rate) => (
                        <label key={rate.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-[12.5px]">
                          <span className="font-medium text-foreground">{rate.code}</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={rate.rateToKrw > 0 ? formatIntegerInputValue(rate.rateToKrw) : ""}
                            onChange={(event) => onRateChange(rate.id, readNonNegativeInput(event.currentTarget))}
                            placeholder="환율"
                            aria-label={`${rate.code} 환율`}
                            className="hub-input text-right"
                          />
                          <span className="text-muted-foreground">원</span>
                        </label>
                      ))}
                  </div>
                )}

                {displayItems.length > 0 && (
                  <div className="grid gap-2 border border-grid-border bg-muted/20 p-3 sm:grid-cols-[1fr_auto]">
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor="quote-response-bulk-quantity" className="text-[12.5px] font-medium text-foreground">
                        전체 행 수량
                      </label>
                      <input
                        id="quote-response-bulk-quantity"
                        type="text"
                        inputMode="numeric"
                        value={bulkQuantityValue}
                        onChange={(event) => onBulkQuantityChange(readNonNegativeInput(event.currentTarget))}
                        placeholder="혼합"
                        aria-label="전체 행 수량"
                        className="hub-input w-24 text-right"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-2 text-[12.5px]">
                      <span className="font-medium text-foreground">총합계</span>
                      <span className="min-w-32 text-right font-semibold text-foreground">
                        {hasPreviewMissingRate ? "환율 입력 후 계산" : `${previewTotal.toLocaleString()} 원`}
                      </span>
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto border border-grid-border">
                  <table className="hub-grid">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="px-3 py-2 text-center font-medium">구분</th>
                        <th className="px-3 py-2 text-center font-medium">날짜</th>
                        <th className="px-3 py-2 text-center font-medium">내용</th>
                        <th className="px-3 py-2 text-center font-medium">수량</th>
                        <th className="px-3 py-2 text-center font-medium">단가</th>
                        <th className="px-3 py-2 text-center font-medium">합계</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayItems.map((item) => {
                        const rate = getExchangeRateForItem(previewRates, item);
                        const needsRate = rate.id !== DEFAULT_EXCHANGE_RATE_ID && rate.rateToKrw <= 0;
                        const subtotal = needsRate ? 0 : calculateItemSubtotalKrw(item, previewRates);
                        return (
                          <tr key={item.id} className="border-b border-border last:border-0">
                            <td className="whitespace-nowrap px-3 py-2 text-center text-[12px]">
                              {CATEGORY_LABELS[item.category]}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-center text-[12px]">
                              {item.date || "-"}
                            </td>
                            <td className="min-w-56 whitespace-pre-wrap px-3 py-2 text-[12px] leading-5">
                              {item.description}
                            </td>
                            <td className="px-3 py-2 text-right text-[12px]">
                              {item.quantity.toLocaleString()}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right text-[12px]">
                              {rate.code} {item.unitPrice.toLocaleString()}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right text-[12px]">
                              {needsRate ? "환율 필요" : `${subtotal.toLocaleString()} 원`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} disabled={loading} className="hub-btn hub-btn-custom disabled:opacity-50">
            취소
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={!preview || !canApply || loading}
            className="hub-btn hub-btn-primary disabled:opacity-50"
          >
            현재 견적서에 적용
          </button>
        </div>
        {loading && <QuoteResponseProgressOverlay mode={mode} />}
      </div>
    </div>
  );
}

// ── 견적 행 컴포넌트 ─────────────────────────────────────

interface QuoteRowProps {
  item: QuoteItem;
  exchangeRates: QuoteExchangeRate[];
  showPrices: boolean;
  category: QuoteCategory;
  onChange: (updated: Partial<QuoteItem> & { id: string }) => void;
  onRemove: () => void;
}

function QuoteRow({
  item,
  exchangeRates,
  showPrices,
  onChange,
  onRemove,
}: QuoteRowProps) {
  const selectedRate = getExchangeRateForItem(exchangeRates, item);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/20">
      <td className="px-3 py-1.5">
        <input
          type="date"
          value={item.date}
          onChange={(e) => onChange({ id: item.id, date: e.target.value })}
          aria-label="날짜"
          className="w-full hub-input"
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={item.region}
          onChange={(e) => onChange({ id: item.id, region: e.target.value })}
          placeholder="지역"
          aria-label="지역"
          className="w-full hub-input"
        />
      </td>
      <td className="px-3 py-1.5">
        <div className="relative">
          <AutoResizeTextarea
            value={item.description}
            onChange={(value) => onChange({ id: item.id, description: value })}
            placeholder="내용"
            ariaLabel="내용"
            className={`hub-textarea w-full overflow-hidden${showPrices ? "" : " pr-8"}`}
          />
          {!showPrices && <RemoveRowButton onRemove={onRemove} />}
        </div>
      </td>
      {showPrices && (
        <>
          <td className="px-3 py-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={formatIntegerInputValue(item.quantity)}
              onChange={(e) =>
                onChange({
                  id: item.id,
                  quantity: Math.max(1, readNonNegativeInput(e.currentTarget)),
                })
              }
              aria-label="수량"
              className="w-full hub-input text-right"
            />
          </td>
          <td className="relative px-3 py-1.5 w-44">
            <div className="flex h-[31px] items-center border border-input bg-white focus-within:ring-1 focus-within:ring-ring">
              <select
                value={selectedRate.id}
                onChange={(e) =>
                  onChange({ id: item.id, currencyRateId: e.target.value })
                }
                aria-label="단가 통화"
                className="h-full w-14 border-r border-input bg-transparent px-1 text-[12.5px] text-muted-foreground focus:outline-none"
              >
                {exchangeRates.map((rate) => (
                  <option key={rate.id} value={rate.id}>
                    {rate.code}
                  </option>
                ))}
              </select>
              <input
                type="text"
                inputMode="numeric"
                value={formatIntegerInputValue(item.unitPrice)}
                onChange={(e) =>
                  onChange({
                    id: item.id,
                    unitPrice: readNonNegativeInput(e.currentTarget),
                  })
                }
                aria-label="단가"
                className="h-full w-full min-w-0 bg-transparent px-1 text-right text-[12.5px] focus:outline-none"
              />
            </div>
          </td>
          <td className="px-3 py-1.5 text-right font-medium text-foreground">
            <div className="flex items-center justify-end gap-1.5">
              <span className="min-w-0 whitespace-nowrap">
                {item.subtotal.toLocaleString()} 원
              </span>
              <RemoveRowButton onRemove={onRemove} className="shrink-0" />
            </div>
          </td>
        </>
      )}
    </tr>
  );
}

// ── 합계 행 ─────────────────────────────────────────────

function RemoveRowButton({
  onRemove,
  className = "absolute right-1 top-1/2 -translate-y-1/2",
}: {
  onRemove: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label="행 삭제"
      className={`hub-btn-text px-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive ${className}`}
    >
      ✕
    </button>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3 px-3 py-1 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value.toLocaleString()} 원</span>
    </div>
  );
}
