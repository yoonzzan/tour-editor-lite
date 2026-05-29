import { describe, expect, it } from "vitest";
import { parseItineraryText } from "@/lib/itinerary/importParser";

describe("parseItineraryText", () => {
  it("demotes accommodation-labeled generic hotel actions", () => {
    const itinerary = parseItineraryText([
      "1일차 | 숙박 | 우전 상해 | 전용차량 | 전일 | 호텔 & 우전 고요한 산책길 자유시간 상해로 이동 상해 스타벅스 리저브 로스터리 자유시간 호텔 투숙 및 휴식",
      "1일차 | 숙박 | 우전 | 전용차량 | 전일 | HOTEL: 노보텔 상해 또는 동급",
    ].join("\n"));
    const genericHotelAction = itinerary.days[0]?.items.find((item) => item.content.includes("우전 고요한 산책길"));
    const actualHotel = itinerary.days[0]?.items.find((item) =>
      item.content.includes("노보텔 상해") || item.detail?.includes("노보텔 상해")
    );

    expect(genericHotelAction?.type).toBe("OTHER");
    expect(genericHotelAction?.hotel).toBeUndefined();
    expect(actualHotel?.type).toBe("ACCOMMODATION");
  });
});
