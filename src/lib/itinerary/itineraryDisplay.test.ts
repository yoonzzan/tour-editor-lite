import { describe, expect, it } from "vitest";
import { buildItineraryDisplayDays } from "@/lib/itinerary/itineraryDisplay";
import type { DaySchedule } from "@/types";

describe("buildItineraryDisplayDays", () => {
  it("keeps meal items out of the itinerary detail rows", () => {
    const days: DaySchedule[] = [
      {
        dayNo: 1,
        date: "2026-04-22",
        items: [
          {
            id: "sightseeing-1",
            type: "SIGHTSEEING",
            content: "시내 관광",
            detail: "가이드 동행",
            region: "다낭",
            transport: "전용차량",
            time: "10:00",
          },
          {
            id: "meal-1",
            type: "MEAL",
            content: "",
            meal: {
              breakfast: "호텔식",
              lunch: "현지식",
            },
          },
        ],
      },
    ];

    const [day] = buildItineraryDisplayDays(days);

    expect(day?.rows).toHaveLength(1);
    expect(day?.rows[0]?.detail).toBe("시내 관광");
    expect(day?.rows[0]?.detailDescription).toBe("가이드 동행");
    expect(day?.mealText).toBe("조식 호텔식\n중식 현지식");
  });

  it("normalizes legacy morning lunch dinner labels for display", () => {
    const days: DaySchedule[] = [
      {
        dayNo: 1,
        date: "2026-04-22",
        items: [
          {
            id: "meal-1",
            type: "MEAL",
            content: "아침 호텔식 점심 현지식 저녁 한식",
          },
        ],
      },
    ];

    const [day] = buildItineraryDisplayDays(days);

    expect(day?.mealText).toBe("조식 호텔식\n중식 현지식\n석식 한식");
  });
});
