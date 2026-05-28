import type { ItineraryData, ScheduleItem } from "@/types";
import { getMealSlotRows, MEAL_SLOTS } from "@/lib/itinerary/meal";

export interface ItineraryDisplayRow {
  id: string;
  dayNo: number;
  date: string;
  region: string;
  transport: string;
  time: string;
  detail: string;
  detailDescription: string;
  isHotel: boolean;
  meal: string;
}

export interface ItineraryDisplayDay {
  dayNo: number;
  date: string;
  dayLabel: string;
  rows: ItineraryDisplayRow[];
  mealText: string;
}

function normalizeText(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "";
}

function formatDateDot(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}. ${m}. ${d}.`;
}

function getWeekday(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return ["일", "월", "화", "수", "목", "금", "토"][date.getDay()] ?? "";
}

function formatDayLabel(dayNo: number, date: string): string {
  const weekday = getWeekday(date);
  return `제 ${dayNo} 일\n${formatDateDot(date)}\n(${weekday})`;
}

function normalizeHotelDetail(hotel: string | undefined, content: string): string {
  const normalizedHotel = hotel?.trim();

  if (normalizedHotel) {
    return `[숙박] ${normalizedHotel}`;
  }

  const hasHotelPrefix = /^(?:\[(숙박|호텔)\]|숙박|호텔)(?:\s|:|$)/u.test(content);
  if (hasHotelPrefix) return content;

  return `[숙박] ${content}`;
}

function toItemRows(item: ScheduleItem, dayNo: number, date: string): ItineraryDisplayRow[] {
  if (item.type === "MEAL") return [];

  const region = normalizeText(item.region);
  const transport = normalizeText(item.transport);
  const time = normalizeText(item.time);
  const isHotel = item.type === "ACCOMMODATION";
  const rawContent = item.content?.trim() || "";
  const detail = isHotel ? normalizeHotelDetail(item.hotel, rawContent) : rawContent;
  const detailDescription = normalizeText(item.detail);

  return [
    {
      id: item.id,
      dayNo,
      date,
      region,
      transport,
      time,
      detail,
      detailDescription,
      isHotel,
      meal: "",
    },
  ];
}

function collectMealText(items: ScheduleItem[]): string {
  const valuesBySlot = new Map<string, string[]>();

  for (const item of items) {
    if (item.type !== "MEAL") continue;
    for (const { slot, value } of getMealSlotRows(item, { includeEmpty: false })) {
      const text = value?.trim() ? value.trim() : "X";
      const values = valuesBySlot.get(slot) ?? [];
      if (!values.includes(text)) values.push(text);
      valuesBySlot.set(slot, values);
    }
  }

  return MEAL_SLOTS.flatMap(({ key, label }) => {
    const values = valuesBySlot.get(key) ?? [];
    return values.map((value) => `${label} ${value}`);
  }).join("\n");
}

export function buildItineraryDisplayDays(
  days: ItineraryData["days"]
): ItineraryDisplayDay[] {
  const blocks: ItineraryDisplayDay[] = [];

  for (const day of days) {
    const rows = day.items.flatMap((item) => toItemRows(item, day.dayNo, day.date));
    const mealText = collectMealText(day.items);

    if (rows.length === 0) {
      blocks.push({
        dayNo: day.dayNo,
        date: day.date,
        dayLabel: formatDayLabel(day.dayNo, day.date),
        rows: [
          {
            id: `${day.dayNo}-empty`,
            dayNo: day.dayNo,
            date: day.date,
            region: "",
            transport: "",
            time: "",
            detail: "일정 없음",
            detailDescription: "",
            isHotel: false,
            meal: "",
          },
        ],
        mealText,
      });
      continue;
    }

    blocks.push({
      dayNo: day.dayNo,
      date: day.date,
      dayLabel: formatDayLabel(day.dayNo, day.date),
      rows,
      mealText,
    });
  }

  return blocks;
}
