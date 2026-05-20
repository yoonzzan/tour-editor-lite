// 일정표 식사 데이터 정규화 및 분해 유틸

import type { ScheduleItem } from "@/types";

export type MealSlotKey = "breakfast" | "lunch" | "dinner";

export type MealLabel = "조식" | "중식" | "석식";

export const MEAL_SLOT_KEYS = ["breakfast", "lunch", "dinner"] as const;

export type MealSlotRow = {
  slot: MealSlotKey;
  label: MealLabel;
  value: string;
};

export type MealValues = {
  breakfast?: string;
  lunch?: string;
  dinner?: string;
};

export const MEAL_SLOTS: Array<{ key: MealSlotKey; label: MealLabel }> = [
  { key: "breakfast", label: "조식" },
  { key: "lunch", label: "중식" },
  { key: "dinner", label: "석식" },
];

function parseLegacyMealText(content: string): MealValues {
  const text = (content ?? "").replace(/\r/g, "").trim();
  if (!text) return {};

  const values: MealValues = {};
  const regex = /(조식|중식|석식|아침|점심|저녁)\s*[:：]?\s*([\s\S]*?)(?=\s*(?:조식|중식|석식|아침|점심|저녁)\s*[:：]?|$)/g;

  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const label = match[1];
    const rawValue = match[2]?.trim() ?? "";
    const value = rawValue
      .replace(/^[\\/|·\-\s]+|[\\/|·\-\s]+$/g, "")
      .trim();

    if (!value) continue;

    if (label === "조식" || label === "아침") values.breakfast = value;
    if (label === "중식" || label === "점심") values.lunch = value;
    if (label === "석식" || label === "저녁") values.dinner = value;
  }

  return values;
}

export function resolveMealValues(item: Pick<ScheduleItem, "meal" | "content">): MealValues {
  const explicit: MealValues = {
    breakfast: item.meal?.breakfast?.trim(),
    lunch: item.meal?.lunch?.trim(),
    dinner: item.meal?.dinner?.trim(),
  };

  const legacy = parseLegacyMealText(item.content);

  return {
    breakfast: explicit.breakfast ?? legacy.breakfast,
    lunch: explicit.lunch ?? legacy.lunch,
    dinner: explicit.dinner ?? legacy.dinner,
  };
}

export function mealSlotLabel(slot: MealSlotKey): MealLabel {
  const found = MEAL_SLOTS.find((candidate) => candidate.key === slot);
  return found?.label ?? "조식";
}

function resolveMealValueForSlot(
  item: Pick<ScheduleItem, "meal" | "content" | "mealSlot">,
  slot: MealSlotKey
): string | undefined {
  const explicit = item.meal?.[slot]?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return resolveMealValues(item)[slot];
}

export function getMealSlotRows(
  item: Pick<ScheduleItem, "meal" | "content" | "mealSlot">,
  opts: { includeEmpty?: boolean; emptyToken?: string } = {}
): MealSlotRow[] {
  const includeEmpty = opts.includeEmpty ?? false;
  const emptyToken = opts.emptyToken ?? "X";
  const { mealSlot } = item;

  if (mealSlot) {
    const value = resolveMealValueForSlot(item, mealSlot) ?? "";
    if (value.length > 0) {
      return [{ slot: mealSlot, label: mealSlotLabel(mealSlot), value }];
    }
    if (!includeEmpty) return [];
    return [
      {
        slot: mealSlot,
        label: mealSlotLabel(mealSlot),
        value: emptyToken,
      },
    ];
  }

  const values = resolveMealValues(item);

  return MEAL_SLOTS.flatMap(({ key, label }) => {
    const value = values[key];
    if (value && value.length > 0) {
      return [{ slot: key, label, value }];
    }
    if (!includeEmpty) return [];
    return [{ slot: key, label, value: emptyToken }];
  });
}
