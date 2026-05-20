import { describe, expect, it } from "vitest";
import { generateQuoteItems } from "@/lib/quote/generate";
import type { ItineraryData } from "@/types";

function buildItinerary(passengers: ItineraryData["overview"]["passengers"]): ItineraryData {
  return {
    header: {
      groupName: "테스트 일정",
      writtenAt: "2026-05-15",
    },
    overview: {
      recipient: "하나투어",
      cities: "싱가포르",
      travelPeriod: { start: "2026-06-01", end: "2026-06-03" },
      passengers,
      fare: {
        adultPerPerson: 1000,
        childPerPerson: 500,
        infantPerPerson: 0,
        total: 2500,
        totalWithCard: 2500,
      },
    },
    basics: {
      flight: { departure: "KE001", arrival: "", localVehicle: "전용차량" },
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

describe("generateQuoteItems", () => {
  it("uses adult, child, and infant count as generated item quantity", () => {
    const items = generateQuoteItems(
      buildItinerary({ adult: 2, child: 1, infant: 1, escort: 3, foc: 4 })
    );

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.quantity === 4)).toBe(true);
  });

  it("uses only schedule content for generated quote descriptions", () => {
    const itinerary = buildItinerary({ adult: 2, child: 0, infant: 0, escort: 0, foc: 0 });
    itinerary.days[0]!.items[0] = {
      id: "item-1",
      type: "SIGHTSEEING",
      content: "사파리 파크",
      detail: "입장권 포함",
    };

    const items = generateQuoteItems(itinerary);

    expect(items.find((item) => item.category === "SIGHTSEEING")?.description).toBe("사파리 파크");
  });
});
