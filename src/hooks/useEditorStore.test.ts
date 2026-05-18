import { describe, expect, it } from "vitest";
import { useEditorStore } from "@/hooks/useEditorStore";
import type { ItineraryData, QuoteData } from "@/types";

function buildItinerary(): ItineraryData {
  return {
    header: {
      groupName: "테스트 일정",
      writtenAt: "2026-05-15",
    },
    overview: {
      recipient: "하나투어",
      cities: "싱가포르",
      travelPeriod: { start: "2026-06-01", end: "2026-06-03" },
      passengers: { adult: 2, child: 1, infant: 0, escort: 1, foc: 1 },
      fare: {
        adultPerPerson: 1000,
        childPerPerson: 500,
        infantPerPerson: 0,
        total: 2500,
        totalWithCard: 2500,
      },
    },
    basics: {
      flight: { departure: "KE001", arrival: "KE002", localVehicle: "전용차량" },
      accommodation: { hotel: "테스트 호텔", grade: "4성급", occupancy: "2인 1실" },
      included: "항공",
      excluded: "개인경비",
      optionalTour: "",
      shoppingCenters: 0,
      notes: "",
    },
    days: [
      {
        dayNo: 1,
        date: "2026-06-01",
        items: [
          {
            id: "item-1",
            type: "SIGHTSEEING",
            content: "관광",
          },
        ],
      },
    ],
  };
}

function buildQuote(): QuoteData {
  return {
    header: { writtenAt: "2026-05-15", validUntil: "2026-05-15" },
    exchangeRates: [{ id: "krw", code: "KRW", rateToKrw: 1 }],
    items: [
      {
        id: "quote-item-1",
        category: "SIGHTSEEING",
        region: "",
        date: "2026-06-01",
        description: "기존 견적",
        quantity: 2,
        unitPrice: 1000,
        currencyRateId: "krw",
        subtotal: 2000,
      },
    ],
    summary: {
      subtotal: 2000,
      groundProfit: 0,
      agencyFee: 0,
      vat: 0,
      total: 2000,
    },
  };
}

describe("useEditorStore", () => {
  it("does not auto-generate quote items when loading an itinerary", () => {
    const store = useEditorStore.getState();
    store.setItinerary(buildItinerary());
    store.setQuote(buildQuote());

    useEditorStore.getState().loadFromProduct(buildItinerary());

    const quote = useEditorStore.getState().quote;
    expect(quote?.items).toEqual([]);
    expect(quote?.summary.total).toBe(0);
  });
});
