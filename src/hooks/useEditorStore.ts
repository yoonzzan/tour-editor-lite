// src/hooks/useEditorStore.ts — 에디터 전역 상태 (Zustand)
import { create } from "zustand";
import type { ItineraryData, QuoteData } from "@/types";
import { enforceAccommodationPolicy } from "@/lib/itinerary/policy";
import { todayInKorea } from "@/lib/date/korea";
import {
  DEFAULT_EXCHANGE_RATE,
  recalculateQuoteData,
} from "@/lib/quote/currency";

interface EditorState {
  /** 현재 편집 중인 일정표 데이터 (null = 미로드) */
  itinerary: ItineraryData | null;
  /** 현재 편집 중인 견적서 데이터 (null = 미로드) */
  quote: QuoteData | null;
  /** 미저장 변경 여부 */
  isDirty: boolean;

  // ── 액션 ───────────────────────────────────────────────

  /** SearchPopup에서 상품 선택 후 에디터 전체 교체 */
  loadFromProduct: (itinerary: ItineraryData) => void;
  /** 일정표 데이터 업데이트 */
  setItinerary: (itinerary: ItineraryData) => void;
  /** 견적서 데이터 업데이트 */
  setQuote: (quote: QuoteData) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  itinerary: null,
  quote: null,
  isDirty: false,

  loadFromProduct: (itinerary) =>
    set(() => {
      const normalized = enforceAccommodationPolicy(itinerary);
      const writtenAt = todayInKorea();
      return {
        itinerary: normalized,
        quote: recalculateQuoteData({
          header: { writtenAt, validUntil: writtenAt },
          exchangeRates: [DEFAULT_EXCHANGE_RATE],
          items: [],
          groundProfit: 0,
          agencyFee: 0,
        }),
        isDirty: true,
      };
    }),

  setItinerary: (itinerary) =>
    set({ itinerary, isDirty: true }),

  setQuote: (quote) =>
    set({ quote, isDirty: true }),
}));
