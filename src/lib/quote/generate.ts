// src/lib/quote/generate.ts
// 일정표 데이터 → 견적 항목 자동 생성 (T-403)

import { v4 as uuidv4 } from "uuid";
import type { ItineraryData, QuoteCategory, QuoteItem, ScheduleItemType } from "@/types";
import { getMealSlotRows } from "@/lib/itinerary/meal";
import { DEFAULT_EXCHANGE_RATE_ID } from "@/lib/quote/currency";

const TYPE_TO_CATEGORY: Record<ScheduleItemType, QuoteCategory> = {
  TRANSFER: "VEHICLE",
  SIGHTSEEING: "SIGHTSEEING",
  MEAL: "MEAL",
  ACCOMMODATION: "HOTEL",
  OTHER: "OTHER",
};

export const CATEGORY_ORDER: QuoteCategory[] = [
  "FLIGHT",
  "HOTEL",
  "SIGHTSEEING",
  "MEAL",
  "VEHICLE",
  "GUIDE",
  "OTHER",
];

export const CATEGORY_LABELS: Record<QuoteCategory, string> = {
  FLIGHT: "항공",
  HOTEL: "숙박",
  SIGHTSEEING: "관광",
  MEAL: "식사",
  VEHICLE: "차량",
  GUIDE: "가이드",
  OTHER: "기타",
};

function buildItemDescription(
  item: ItineraryData["days"][number]["items"][number]
): string {
  if (item.type === "MEAL") {
    const parts = getMealSlotRows(item, { includeEmpty: false }).map(
      ({ label, value }) => `${label} ${value}`
    );
    if (parts.length > 0) return parts.join(" / ");
  }
  return item.content.replace(/\s+/gu, " ").trim() || "(내용 없음)";
}

function buildMealItems(
  item: ItineraryData["days"][number]["items"][number],
  dayDate: string,
  quantity: number
): QuoteItem[] {
  if (item.type !== "MEAL") return [];

  const mealRows = getMealSlotRows(item, { includeEmpty: false });

  const rows: QuoteItem[] = mealRows.map((meal) => ({
    id: uuidv4(),
    category: "MEAL",
    region: item.region ?? "",
    date: dayDate,
    description: `${meal.label} ${meal.value}`,
    quantity,
    unitPrice: 0,
    currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
    subtotal: 0,
  }));

  if (rows.length === 0) {
    const description = buildItemDescription(item);
    if (description === "(내용 없음)") {
      return [];
    }
    return [
      {
        id: uuidv4(),
        category: "MEAL",
        region: item.region ?? "",
        date: dayDate,
        description,
        quantity,
        unitPrice: 0,
        currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
        subtotal: 0,
      },
    ];
  }

  return rows;
}

/**
 * T-403: 일정표 → 견적 항목 자동 생성
 * 순서: 항공 → 숙박 → 관광 → 식사 → 차량 → 가이드 → 기타
 */
export function generateQuoteItems(itinerary: ItineraryData): QuoteItem[] {
  const items: QuoteItem[] = [];
  const { adult, child, infant } = itinerary.overview.passengers;
  const quantity = Math.max(0, adult + child + infant);

  // 항공 (basics.flight)
  const { flight } = itinerary.basics;
  if (flight.departure) {
    items.push({
      id: uuidv4(),
      category: "FLIGHT",
      region: "",
      date: itinerary.overview.travelPeriod.start,
      description: `출발편: ${flight.departure}`,
      quantity,
      unitPrice: 0,
      currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
      subtotal: 0,
    });
  }
  if (flight.arrival) {
    items.push({
      id: uuidv4(),
      category: "FLIGHT",
      region: "",
      date: itinerary.overview.travelPeriod.end,
      description: `귀국편: ${flight.arrival}`,
      quantity,
      unitPrice: 0,
      currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
      subtotal: 0,
    });
  }

  // 일정표 항목
  for (const day of itinerary.days) {
    for (const schedItem of day.items) {
      if (schedItem.type === "MEAL") {
        items.push(...buildMealItems(schedItem, day.date, quantity));
      } else {
        items.push({
          id: uuidv4(),
          category: TYPE_TO_CATEGORY[schedItem.type],
          region: schedItem.region ?? "",
          date: day.date,
          description: buildItemDescription(schedItem),
          quantity,
          unitPrice: 0,
          currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
          subtotal: 0,
        });
      }
    }
  }

  // 카테고리 순서대로 정렬
  return items.sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  );
}
