import type { ScheduleItemType } from "@/types";

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactText(value: string): string {
  return cleanText(value).replace(/[\s|,/()[\]·•\-&]+/gu, "");
}

export function isActualAccommodationText(value: string): boolean {
  const text = cleanText(value);
  if (!text) return false;
  if (/(?:^|\s)HOTEL\s*[:：-]\s*.+/iu.test(text)) return true;
  if (/(?:동급|기\s*내\s*숙\s*박|\d?\s*성급\s*호텔)/iu.test(text)) return true;
  if (/\b(?:Hyatt|Holiday Inn|Radisson|Novotel|Marriott|Hilton|Sheraton|Lotte|Aloft)\b/iu.test(text)) {
    return true;
  }
  if (/\b(?:hotel|resort|inn)\b/iu.test(text) && !isGenericHotelActionText(text)) return true;
  return /[가-힣A-Za-z0-9][가-힣A-Za-z0-9\s&().'-]{1,}(?:호텔|리조트)(?:$|[\s,)/])/u.test(text)
    && !hasScheduleProseSignal(text)
    && !isGenericHotelActionText(text);
}

export function isGenericHotelActionText(value: string): boolean {
  const compact = compactText(value);
  if (!compact) return false;
  return /^(?:숙박)?호텔(?:이동|휴식|체크인|체크아웃)(?:후|및)?(?:휴식|석식|식사|온천욕)?$/u.test(compact)
    || /^(?:숙박)?호텔투숙(?:및)?휴식$/u.test(compact)
    || /^(?:숙박)?(?:체크인|체크아웃)(?:후|및)?(?:휴식|석식|식사)?$/u.test(compact);
}

function hasScheduleProseSignal(value: string): boolean {
  return /(?:관광|탐방|방문|견학|산책|관람|자유시간|자유일정|쇼핑|마사지|중식|석식|조식|식사)/u.test(value);
}

export function shouldDemoteAccommodationText(value: string): boolean {
  const text = cleanText(value);
  if (!text || isActualAccommodationText(text)) return false;
  if (isGenericHotelActionText(text)) return true;
  return /(호텔|숙박|투숙|체크\s*인|체크인|체크아웃|리조트)/u.test(text)
    && hasScheduleProseSignal(text);
}

export function coerceAccommodationType(type: ScheduleItemType, content: string): ScheduleItemType {
  if (type !== "ACCOMMODATION") return type;
  return shouldDemoteAccommodationText(content) ? "OTHER" : type;
}
