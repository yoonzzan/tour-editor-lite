import { describe, expect, it } from "vitest";
import type { ItineraryData } from "@/types";
import { alignDaysToTravelPeriod, getTravelDayCount } from "@/lib/itinerary/dayAlignment";

function baseItinerary(days: ItineraryData["days"]): ItineraryData {
  return {
    header: { groupName: "테스트", writtenAt: "2026-04-23" },
    overview: {
      recipient: "",
      cities: "",
      travelPeriod: { start: "2026-06-02", end: "2026-06-06" },
      passengers: { adult: 0, child: 0, infant: 0, escort: 0, foc: 0 },
      fare: { adultPerPerson: 0, childPerPerson: 0, infantPerPerson: 0, total: 0, totalWithCard: 0 },
    },
    basics: {
      flight: { departure: "", arrival: "", localVehicle: "" },
      accommodation: { hotel: "", grade: "", occupancy: "" },
      included: "",
      excluded: "",
      optionalTour: "",
      shoppingCenters: 0,
      notes: "",
    },
    days,
  };
}

describe("dayAlignment", () => {
  it("calculates inclusive travel day count", () => {
    expect(getTravelDayCount({ start: "2026-06-02", end: "2026-06-06" })).toBe(5);
  });

  it("normalizes flexible date formats when counting travel days", () => {
    expect(getTravelDayCount({
      start: "2026-06-02T00:00:00+09:00",
      end: "2026.06.06",
    })).toBe(5);
    expect(getTravelDayCount({
      start: "2026-06-02 ~ 2026-06-06",
      end: "2026.06.06",
    })).toBe(5);
    expect(getTravelDayCount({
      start: "2026/06/02",
      end: "2026/06/06",
    })).toBe(5);
    expect(getTravelDayCount({
      start: "2026/06/02 ~ 2026/06/06",
      end: "2026/06/06",
    })).toBe(5);
    expect(getTravelDayCount({
      start: "2026-6-2",
      end: "2026-06-06 ",
    })).toBe(5);
  });

  it("fills missing empty days from travel period", () => {
    const result = alignDaysToTravelPeriod(baseItinerary([
      { dayNo: 1, date: "2026-06-02", items: [] },
      { dayNo: 2, date: "2026-06-03", items: [] },
    ]));

    expect(result.hasOutOfRangeContent).toBe(false);
    expect(result.itinerary.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4, 5]);
    expect(result.itinerary.days[4]?.date).toBe("2026-06-06");
  });

  it("keeps out-of-range content and reports confirmation metadata", () => {
    const result = alignDaysToTravelPeriod(baseItinerary([
      { dayNo: 1, date: "2026-06-02", items: [] },
      { dayNo: 6, date: "2026-06-07", items: [{ id: "x", type: "OTHER", content: "추가 일정" }] },
    ]));

    expect(result.hasOutOfRangeContent).toBe(true);
    expect(result.outOfRangeDayNos).toEqual([6]);
    expect(result.itinerary.days.map((day) => day.dayNo)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
