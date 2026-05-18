// src/types/index.ts — 공통 타입 & enum

// ── 역할 ────────────────────────────────────────────────

export enum Role {
  PARTNER = "PARTNER",
  AGENT = "AGENT",
  SALES = "SALES",
}

// ── 일정표 데이터 ────────────────────────────────────────

export type ScheduleItemType =
  | "TRANSFER"
  | "SIGHTSEEING"
  | "MEAL"
  | "ACCOMMODATION"
  | "OTHER";

export type MealSlot = "breakfast" | "lunch" | "dinner";

export interface ScheduleItem {
  id: string;
  type: ScheduleItemType;
  region?: string;
  transport?: string;
  time?: string;
  content: string;
  detail?: string;
  mealSlot?: MealSlot;
  meal?: {
    breakfast?: string;
    lunch?: string;
    dinner?: string;
  };
  hotel?: string;
}

export interface DaySchedule {
  dayNo: number;
  date: string; // yyyy-mm-dd
  items: ScheduleItem[];
}

export interface ItineraryData {
  header: {
    groupName: string;
    writtenAt: string; // yyyy-mm-dd
  };
  overview: {
    recipient: string;
    cities: string;
    travelPeriod: { start: string; end: string };
    passengers: {
      adult: number;
      child: number;
      infant: number;
      escort: number;
      foc: number;
    };
    singleCharge?: number;
    fare: {
      adultPerPerson: number;
      childPerPerson: number;
      infantPerPerson: number;
      total: number;
      totalWithCard: number;
    };
  };
  basics: {
    flight: { departure: string; arrival: string; localVehicle: string };
    accommodation: { hotel: string; grade: string; occupancy: string };
    included: string;
    excluded: string;
    optionalTour: string;
    shoppingCenters: number;
    summaryNotes?: {
      flight: string;
      vehicle: string;
      accommodation: string;
      included: string;
      excluded: string;
      optionalTour: string;
      shoppingCenters: string;
    };
    notes: string;
  };
  days: DaySchedule[];
}

// ── 견적서 데이터 ─────────────────────────────────────────

export type QuoteCategory =
  | "FLIGHT"
  | "HOTEL"
  | "SIGHTSEEING"
  | "MEAL"
  | "VEHICLE"
  | "GUIDE"
  | "OTHER";

export interface QuoteItem {
  id: string;
  category: QuoteCategory;
  region: string;
  date: string;
  description: string;
  quantity: number;
  unitPrice: number;
  currencyRateId?: string;
  subtotal: number; // 원화 환산 합계 (quantity * unitPrice * rateToKrw)
  refPrice?: number; // 원가 DB 참고 단가
}

export interface QuoteExchangeRate {
  id: string;
  code: string;
  rateToKrw: number;
}

export interface QuoteData {
  header: {
    writtenAt: string;
    validUntil?: string;
  };
  exchangeRates?: QuoteExchangeRate[];
  items: QuoteItem[];
  summary: {
    subtotal: number;
    groundProfit: number;
    agencyFee: number;
    vat: number;
    total: number;
  };
}
