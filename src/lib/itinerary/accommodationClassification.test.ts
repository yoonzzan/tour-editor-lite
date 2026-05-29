import { describe, expect, it } from "vitest";
import {
  coerceAccommodationType,
  isActualAccommodationText,
  isGenericHotelActionText,
  shouldDemoteAccommodationText,
} from "@/lib/itinerary/accommodationClassification";

describe("accommodation classification", () => {
  it("keeps actual hotel names as accommodation", () => {
    for (const text of [
      "HOTEL: 노보텔 상해 또는 동급",
      "조잔케이 뷰 호텔",
      "4성급 호텔",
      "기내 숙박",
      "Aloft Singapore Novena",
    ]) {
      expect(isActualAccommodationText(text), text).toBe(true);
      expect(coerceAccommodationType("ACCOMMODATION", text), text).toBe("ACCOMMODATION");
    }
  });

  it("demotes generic hotel action text", () => {
    for (const text of [
      "호텔 이동 및 휴식",
      "호텔 투숙 및 휴식",
      "호텔 체크인",
      "호텔 체크인 후 휴식",
    ]) {
      expect(isGenericHotelActionText(text), text).toBe(true);
      expect(shouldDemoteAccommodationText(text), text).toBe(true);
      expect(coerceAccommodationType("ACCOMMODATION", text), text).toBe("OTHER");
    }
  });

  it("demotes accommodation-labeled schedule prose without hotel names", () => {
    const text = "호텔 & 우전 고요한 산책길 자유시간 상해로 이동 상해 스타벅스 리저브 로스터리 자유시간 호텔 투숙 및 휴식";

    expect(isActualAccommodationText(text)).toBe(false);
    expect(shouldDemoteAccommodationText(text)).toBe(true);
    expect(coerceAccommodationType("ACCOMMODATION", text)).toBe("OTHER");
  });

  it("keeps bare hotel stay markers conservative", () => {
    expect(isGenericHotelActionText("호텔투숙")).toBe(false);
    expect(coerceAccommodationType("ACCOMMODATION", "호텔투숙")).toBe("ACCOMMODATION");
  });
});
