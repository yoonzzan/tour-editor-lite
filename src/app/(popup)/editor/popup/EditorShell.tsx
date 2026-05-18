"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { v4 as uuidv4 } from "uuid";
import { useEditorStore } from "@/hooks/useEditorStore";
import { notifyParent } from "@/lib/postMessage";
import { todayInKorea } from "@/lib/date/korea";
import {
  DEFAULT_EXCHANGE_RATE_ID,
  getQuoteExchangeRates,
  recalculateQuoteData,
} from "@/lib/quote/currency";
import { SearchPopup } from "@/components/editor/SearchPopup";
import { ItineraryEditor } from "@/components/editor/ItineraryEditor";
import { QuoteEditor } from "@/components/editor/QuoteEditor";
import { PreviewModal } from "@/components/editor/PreviewModal";
import { FlightPopup } from "@/components/editor/FlightPopup";
import type { Role } from "@/types";
import type { QuoteItem } from "@/types";
import type { FlightDirection, FlightFareOption, FlightSegment } from "@/app/api/flights/route";

type EditorTab = "itinerary" | "quote";

interface Props {
  role: Role;
}

interface FlightSelection {
  schedule: FlightFareOption;
  direction: FlightDirection;
}

function formatFlightSegment(segment: FlightSegment): string {
  return `${segment.airline} ${segment.flightNo} ${segment.depAirport} ${segment.depTime} → ${segment.arrAirport} ${segment.arrTime}`;
}

export function EditorShell({ role }: Props) {
  const { isDirty, itinerary, quote, setItinerary, setQuote } = useEditorStore();

  const [showSearch, setShowSearch] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>("itinerary");
  const [showPreview, setShowPreview] = useState(false);
  const [showFlight, setShowFlight] = useState(false);

  // T-108: 미저장 닫기 경고
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty) return;
      e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  // ── 항공 선택 핸들러 (T-603) ─────────────────────────────
  function handleFlightSelect({ schedule, direction }: FlightSelection) {
    if (!itinerary) return;
    const selectedSegment = formatFlightSegment(schedule.outbound);
    const departure =
      schedule.tripType === "ROUND_TRIP" || direction === "DEPARTURE"
        ? selectedSegment
        : itinerary.basics.flight.departure;
    const arrival =
      schedule.tripType === "ROUND_TRIP"
        ? formatFlightSegment(schedule.inbound)
        : direction === "RETURN"
          ? selectedSegment
          : itinerary.basics.flight.arrival;
    const pax =
      itinerary.overview.passengers.adult + itinerary.overview.passengers.child;
    const quantity = pax > 0 ? pax : 1;
    const fareTypeLabel = schedule.fareType === "GROUP" ? "그룹" : "인디비";
    const tripTypeLabel = schedule.tripType === "ROUND_TRIP" ? "왕복" : "편도";
    const routeLabel =
      schedule.tripType === "ROUND_TRIP"
        ? `${schedule.outbound.depAirport}↔${schedule.outbound.arrAirport}`
        : `${schedule.outbound.depAirport}-${schedule.outbound.arrAirport}`;
    const flightDescription =
      schedule.tripType === "ROUND_TRIP"
        ? `[${fareTypeLabel}/${tripTypeLabel}] ${formatFlightSegment(schedule.outbound)} / ${formatFlightSegment(schedule.inbound)}`
        : `[${fareTypeLabel}/${tripTypeLabel}] ${formatFlightSegment(schedule.outbound)}`;

    setItinerary({
      ...itinerary,
      basics: {
        ...itinerary.basics,
        flight: {
          ...itinerary.basics.flight,
          departure,
          arrival,
        },
      },
    });

    const flightItem: QuoteItem = {
      id: uuidv4(),
      category: "FLIGHT",
      region: routeLabel,
      date: itinerary.overview.travelPeriod.start,
      description: flightDescription,
      quantity,
      unitPrice: schedule.total,
      currencyRateId: DEFAULT_EXCHANGE_RATE_ID,
      subtotal: quantity * schedule.total,
    };
    const currentItems = quote?.items ?? [];
    const groundProfit = quote?.summary.groundProfit ?? 0;
    const agencyFee = quote?.summary.agencyFee ?? 0;
    const items = [flightItem, ...currentItems];

    setQuote(recalculateQuoteData({
      header: quote?.header ?? { writtenAt: todayInKorea() },
      exchangeRates: getQuoteExchangeRates(quote),
      items,
      groundProfit,
      agencyFee,
    }));
    if (schedule.tripType === "ROUND_TRIP") {
      setShowFlight(false);
    }
  }

  const isNewQuote = true;
  const hasItinerary = !!itinerary;

  // ── 본문 ─────────────────────────────────────────────
  return (
    <div className="hub-app flex h-screen flex-col">
      {/* 헤더 */}
      <header className="shrink-0">
        <div className="hub-titlebar flex items-center justify-between px-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <Image
                src="/images/hanatour-logo-cropped.png"
                alt="하나투어"
                width={86}
                height={18}
                className="h-[18px] w-auto shrink-0"
                priority
              />
              <span className="hub-screen-title">
                견적서 에디터
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
          {/* 일정 불러오기 버튼 */}
          <button
            className="hub-btn hub-btn-custom"
            onClick={() => setShowSearch(true)}
          >
            일정 불러오기
          </button>

          {/* 항공 조회 버튼 (T-605: partner 숨김) */}
          {role !== "PARTNER" && (
            <button
              className="hub-btn hub-btn-secondary"
              onClick={() => setShowFlight(true)}
            >
              항공 조회
            </button>
          )}

          {/* 미리보기 버튼 */}
          {hasItinerary && (
            <button
              className="hub-btn hub-btn-custom"
              onClick={() => setShowPreview(true)}
            >
              미리보기
            </button>
          )}

          {/* 닫기 */}
          <button
            className="hub-btn hub-btn-custom"
            onClick={() => {
              if (
                isDirty &&
                !window.confirm(
                  "저장하지 않은 변경이 있습니다. 닫으시겠습니까?"
                )
              ) {
                return;
              }
              notifyParent({ type: "EDITOR_CLOSED" });
              window.close();
            }}
          >
            닫기
          </button>
          </div>
        </div>
      </header>

      {/* 탭 바 */}
      {hasItinerary && (
        <div className="hub-tabs flex w-full shrink-0 px-2">
          <div className="flex">
            <TabButton
              active={activeTab === "itinerary"}
              onClick={() => setActiveTab("itinerary")}
              label="일정표"
            />
            <TabButton
              active={activeTab === "quote"}
              onClick={() => setActiveTab("quote")}
              label="견적서"
            />
          </div>
        </div>
      )}

      {/* 본문 — 탭별 CSS hidden으로 마운트 유지 */}
      <main className="hub-workspace flex-1 overflow-auto">
        {hasItinerary ? (
          <>
            <div
              className={`h-full p-3 ${activeTab === "itinerary" ? "" : "hidden"}`}
            >
              <ItineraryEditor />
            </div>
            <div
              className={`h-full p-3 ${activeTab === "quote" ? "" : "hidden"}`}
            >
              <QuoteEditor role={role} />
            </div>
          </>
        ) : isNewQuote ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">
              연결된 견적이 없습니다.
            </p>
            <button
              className="hub-btn hub-btn-primary"
              onClick={() => setShowSearch(true)}
            >
              일정 불러오기
            </button>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              일정 데이터를 초기화하는 중...
            </p>
          </div>
        )}
      </main>

      {/* SearchPopup 모달 */}
      {showSearch && <SearchPopup onClose={() => setShowSearch(false)} />}

      {/* 항공 조회 모달 (T-603) */}
      {showFlight && (
        <FlightPopup
          onClose={() => setShowFlight(false)}
          onSelect={handleFlightSelect}
        />
      )}

      {/* 미리보기 모달 (T-410) */}
      {showPreview && (
        <PreviewModal
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}

// ── 탭 버튼 ────────────────────────────────────────────────
function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`hub-tab ${active ? "hub-tab-active" : ""}`}
    >
      {label}
    </button>
  );
}
