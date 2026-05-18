"use client";

// T-410: 미리보기 모달 (일정표 탭 + 견적서 탭)

import { useState, Fragment } from "react";
import Image from "next/image";
import { useEditorStore } from "@/hooks/useEditorStore";
import { getStoredAccessCode } from "@/lib/converter/clientAccess";
import type { ItineraryData, QuoteCategory, QuoteData } from "@/types";
import { buildItineraryDisplayDays } from "@/lib/itinerary/itineraryDisplay";
import { formatDateDotInKorea, formatDateKorInKorea, todayInKorea } from "@/lib/date/korea";
import {
  calculateItemSubtotalKrw,
  getExchangeRateForItem,
  getQuoteExchangeRates,
} from "@/lib/quote/currency";

const PREVIEW_DOCUMENT_CLASS = "w-full space-y-6 px-6 py-6 text-[12.5px]";
const PREVIEW_WIDE_TABLE_CLASS = "min-w-[1080px] w-full table-fixed text-[12.5px] leading-[18px]";

type PreviewTab = "itinerary" | "quote";

interface Props {
  onClose: () => void;
}

export function PreviewModal({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<PreviewTab>("itinerary");
  const { itinerary, quote } = useEditorStore();

  function handleDownload(type: "itinerary" | "cost") {
    if (type === "itinerary" && !itinerary) return;
    if (type === "cost" && !quote) return;

    const payload = { itineraryData: itinerary, quoteData: quote };
    const endpoint = `/api/export?type=${type}`;

    const frameName = `excel-download-${Date.now().toString(36)}`;
    const iframe = document.createElement("iframe");
    iframe.name = frameName;
    iframe.style.display = "none";

    const form = document.createElement("form");
    form.method = "POST";
    form.action = endpoint;
    form.target = frameName;
    form.style.display = "none";

    const payloadInput = document.createElement("input");
    payloadInput.type = "hidden";
    payloadInput.name = "payload";
    payloadInput.value = JSON.stringify(payload);
    form.appendChild(payloadInput);

    const accessInput = document.createElement("input");
    accessInput.type = "hidden";
    accessInput.name = "accessCode";
    accessInput.value = getStoredAccessCode();
    form.appendChild(accessInput);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      form.remove();
      iframe.remove();
    };

    iframe.addEventListener("load", () => {
      const text = iframe.contentDocument?.body?.innerText.trim();
      if (text) {
        window.alert(`엑셀 다운로드에 실패했습니다.\n${text}`);
      }
      window.setTimeout(cleanup, 1000);
    });

    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
    window.setTimeout(cleanup, 60000);
  }

  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[rgba(0,0,0,0.45)]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="hub-dialog z-modal flex h-[90vh] w-[94vw] max-w-[1600px] flex-col overflow-hidden"
      >
        <div className="grid h-8 shrink-0 grid-cols-[minmax(0,auto)_1fr_minmax(0,auto)] items-center gap-2 bg-[hsl(var(--hub-chrome))] px-2 text-chrome-sidebar-foreground">
          <span className="px-1 text-[13px] font-bold leading-5">미리보기</span>

          <div className="flex justify-center">
            <div className="inline-flex gap-0.5 bg-white/10 p-0.5">
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

          <div className="flex items-center gap-1.5 pe-1">
            <button
              type="button"
              onClick={() => handleDownload("itinerary")}
              className="hub-btn h-7 border-white/25 bg-transparent px-2 text-[13px] font-semibold text-chrome-sidebar-foreground hover:bg-chrome-sidebar-hover"
            >
              일정표 Excel
            </button>
            <button
              type="button"
              onClick={() => handleDownload("cost")}
              className="hub-btn h-7 border-white/25 bg-transparent px-2 text-[13px] font-semibold text-chrome-sidebar-foreground hover:bg-chrome-sidebar-hover"
            >
              견적서 Excel
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="미리보기 닫기"
              className="hub-btn-text h-7 px-2 text-chrome-sidebar-foreground hover:bg-chrome-sidebar-hover"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {activeTab === "itinerary" ? (
            <ItineraryPreview itinerary={itinerary} />
          ) : (
            <QuotePreview quote={quote} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── 탭 버튼 ─────────────────────────────────────────────

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
      type="button"
      onClick={onClick}
      className={`px-3 py-1 text-[13px] font-semibold transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-white/85 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function formatDateDot(input: string): string {
  return formatDateDotInKorea(input);
}

function formatDateKor(input: string): string {
  return formatDateKorInKorea(input);
}

function getTodayDateString(): string {
  return todayInKorea();
}

function formatMoney(value: number): string {
  return `₩ ${value.toLocaleString("ko-KR")}`;
}

function formatPassenger(data: ItineraryData["overview"]["passengers"]): string {
  return `성인 ${data.adult}, 아동 ${data.child}, 유아 ${data.infant}`;
}

function PreviewDocumentHeader({
  title,
}: {
  title: string;
}) {
  const today = getTodayDateString();

  return (
    <section className="overflow-hidden bg-white">
      <div className="grid grid-cols-[150px_1fr_220px] items-center">
        <div className="flex h-16 items-center justify-center p-2">
          <Image
            src="/images/hanatour-logo-cropped.png"
            alt="하나투어"
            width={120}
            height={27}
            className="object-contain"
            style={{ width: "134px", height: "auto" }}
          />
        </div>
        <div className="px-3 py-2 text-center text-[22px] font-bold leading-7 text-foreground">
          {title}
        </div>
        <div className="px-3 py-2 text-right text-[12.5px] leading-[18px] text-foreground/80">
          견적 작성일: {formatDateDot(today)}
        </div>
      </div>
    </section>
  );
}

function buildItinerarySummaryRows(data: ItineraryData): Array<[string, string, string]> {
  const accommodationHotel = data.basics.accommodation?.hotel ?? "";
  const accommodationGrade = data.basics.accommodation?.grade ?? "";
  const accommodationOccupancy = data.basics.accommodation?.occupancy ?? "";
  const summaryNotes = data.basics.summaryNotes;
  return [
    [
      "항공",
      `[출발] ${data.basics.flight.departure}\n[귀국] ${data.basics.flight.arrival}`,
      summaryNotes?.flight ?? "",
    ],
    [
      "차량",
      data.basics.flight.localVehicle,
      summaryNotes?.vehicle ?? "",
    ],
    [
      "숙박",
      `[호텔] ${accommodationHotel}\n[등급] ${accommodationGrade}\n[1객실 이용인원] ${accommodationOccupancy}`,
      summaryNotes?.accommodation ?? "",
    ],
    ["포함사항", data.basics.included, summaryNotes?.included ?? ""],
    ["불포함사항", data.basics.excluded, summaryNotes?.excluded ?? ""],
    ["선택관광", data.basics.optionalTour, summaryNotes?.optionalTour ?? ""],
    ["쇼핑센터", `${data.basics.shoppingCenters}회`, summaryNotes?.shoppingCenters ?? ""],
  ];
}

// ── 일정표 미리보기 ───────────────────────────────────────

function ItineraryPreview({ itinerary }: { itinerary: ItineraryData | null }) {
  if (!itinerary) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12.5px] text-muted-foreground">일정 데이터가 없습니다.</p>
      </div>
    );
  }

  const { overview, basics, days } = itinerary;
  const pax = overview.passengers;
  const blocks = buildItineraryDisplayDays(days);
  const summaryRows = buildItinerarySummaryRows(itinerary);
  const travelPeriod = `${formatDateDot(overview.travelPeriod.start)} ~ ${formatDateDot(overview.travelPeriod.end)}`;
  const occupancy = basics.accommodation?.occupancy?.trim() || "";
  const fareAdult = formatMoney(overview.fare.adultPerPerson);
  const fareChild = overview.fare.childPerPerson > 0 ? formatMoney(overview.fare.childPerPerson) : "";
  const fareInfant = overview.fare.infantPerPerson > 0 ? formatMoney(overview.fare.infantPerPerson) : "";
  const fareTotal = formatMoney(overview.fare.total);
  const fareWithCard = formatMoney(overview.fare.totalWithCard);

  return (
      <div className={PREVIEW_DOCUMENT_CLASS}>
      <PreviewDocumentHeader
        title={itinerary.header.groupName || overview.cities || "일정표"}
      />

      <div className="overflow-x-auto rounded-lg border border-grid-border">
        <table className={`${PREVIEW_WIDE_TABLE_CLASS} border border-grid-border border-collapse`}>
          <colgroup>
            <col className="w-[9%]" />
            <col className="w-[10.5%]" />
            <col className="w-[10.5%]" />
            <col className="w-[10.5%]" />
            <col className="w-[9%]" />
            <col className="w-[12.5%]" />
            <col className="w-[12.5%]" />
            <col className="w-[8.5%]" />
            <col className="w-[8.5%]" />
            <col className="w-[8.5%]" />
          </colgroup>
          <tbody>
            <tr>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                수신
              </th>
              <td className="border border-grid-border px-2 py-1" colSpan={3}>
                {overview.recipient}
              </td>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                여행도시
              </th>
              <td className="border border-grid-border px-2 py-1" colSpan={2}>
                {overview.cities}
              </td>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                여행기간
              </th>
              <td className="border border-grid-border px-2 py-1" colSpan={2}>
                {travelPeriod}
              </td>
            </tr>
            <tr>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                인원
              </th>
              <td className="border border-grid-border px-2 py-1" colSpan={2}>
                {formatPassenger(pax)}
              </td>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                인솔자
              </th>
              <td className="border border-grid-border px-2 py-1">{pax.escort}명</td>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                FOC
              </th>
              <td className="border border-grid-border px-2 py-1">{pax.foc ?? 0}명</td>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                1인실 이용금액
              </th>
              <td className="border border-grid-border px-2 py-1" colSpan={2}>
                {occupancy}
              </td>
            </tr>
            <tr>
              <th
                className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground"
                rowSpan={2}
              >
                여행 요금
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                성인 인당
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                아동 인당
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                유아 인당
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground" colSpan={3}>
                총 금액
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground" colSpan={3}>
                카드 결제 시 금액
              </th>
            </tr>
            <tr>
              <td className="border border-grid-border px-2 py-1 text-right">{fareAdult}</td>
              <td className="border border-grid-border px-2 py-1 text-right">{fareChild}</td>
              <td className="border border-grid-border px-2 py-1 text-right">{fareInfant}</td>
              <td className="border border-grid-border px-2 py-1 text-right" colSpan={3}>
                {fareTotal}
              </td>
              <td className="border border-grid-border px-2 py-1 text-right" colSpan={3}>
                {fareWithCard}
              </td>
            </tr>
            <tr>
              <td
                className="h-[6px] border border-grid-border bg-white px-0 py-0"
                colSpan={10}
              />
            </tr>
            <tr>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground">
                구분
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground" colSpan={7}>
                내용
              </th>
              <th className="whitespace-nowrap border border-grid-border bg-grid-header px-2 py-1 text-center font-bold text-grid-header-foreground" colSpan={2}>
                비고
              </th>
            </tr>
            {summaryRows.map(([label, detail, note]) => (
              <tr key={label}>
                <td className="border border-grid-border bg-muted px-2 py-1 text-center align-top font-bold">
                  {label}
                </td>
                <td className="border border-grid-border px-2 py-1" colSpan={7}>
                  <div className="whitespace-pre-wrap">{detail || ""}</div>
                </td>
                <td className="border border-grid-border px-2 py-1" colSpan={2}>
                  <div className="whitespace-pre-wrap">{note || ""}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-lg border border-grid-border">
        <table className={PREVIEW_WIDE_TABLE_CLASS}>
          <colgroup>
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[10%]" />
            <col className="w-[43%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="whitespace-nowrap bg-grid-header text-grid-header-foreground">
            <tr>
              <th className="px-3 py-2 text-center font-bold">일차</th>
              <th className="px-3 py-2 text-center font-bold">지역</th>
              <th className="px-3 py-2 text-center font-bold">교통편</th>
              <th className="px-3 py-2 text-center font-bold">시간</th>
              <th className="px-3 py-2 text-center font-bold">세부일정</th>
              <th className="px-3 py-2 text-center font-bold">식사</th>
            </tr>
          </thead>
          <tbody>
            {blocks.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center text-muted-foreground">
                  일정 없음
                </td>
              </tr>
            ) : (
              blocks.flatMap((day) => {
                const dayRowSpan = day.rows.length;
                const hasMeal = day.mealText.trim().length > 0;

                return day.rows.map((row, rowIndex) => {
                  const isFirst = rowIndex === 0;
                  return (
                    <tr key={`${row.id}-${rowIndex}`} className="border-t border-grid-border">
                    {isFirst ? (
                        <td
                          rowSpan={dayRowSpan}
                          className="whitespace-pre-wrap border-r border-grid-border px-3 py-2 align-middle text-center text-foreground bg-white"
                        >
                          <div className="whitespace-nowrap">
                            <span className="font-bold">
                              {day.dayLabel.split("\n")[0]?.replace(/\s+일$/u, "일")}
                            </span>
                            <br />
                            {day.dayLabel.split("\n")[1]}
                            <br />
                            <span>{day.dayLabel.split("\n")[2]}</span>
                          </div>
                        </td>
                      ) : null}
                      <td className="whitespace-nowrap px-3 py-2 text-center text-foreground">{row.region}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-center text-foreground">{row.transport}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-center text-foreground">{row.time}</td>
                      <td
                        className={`px-3 py-2 text-foreground ${
                          row.isHotel ? "bg-muted/40" : "bg-white"
                        }`}
                      >
                        <div className="whitespace-pre-wrap">
                          {renderDetailText(row.detail || "", row.detailDescription, row.isHotel)}
                        </div>
                      </td>
                      {isFirst ? (
                        <td
                          rowSpan={hasMeal ? dayRowSpan : 1}
                          className="align-middle border-l border-grid-border bg-white px-3 py-2 text-foreground"
                        >
                          <div className="whitespace-pre-wrap">
                            {hasMeal ? renderMealText(day.mealText) : renderMealText(row.meal || "")}
                          </div>
                        </td>
                      ) : hasMeal ? null : (
                        <td className="border-l border-grid-border bg-white px-3 py-2 text-foreground">
                          {row.meal ? renderMealText(row.meal) : ""}
                        </td>
                      )}
                    </tr>
                  );
                });
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-4 pt-2 text-center text-[12.5px] leading-[18px] text-foreground">
        <p>상기 일정은 항공 및 현지 사정에 의해 다소 변경될 수 있습니다.</p>
        <p>{formatDateKor(getTodayDateString())}</p>
        <p className="font-bold">(주) 하나투어</p>
      </div>

    </div>
  );
}

function renderDetailText(value: string, description = "", isHotel = false): React.ReactNode {
  const trimmed = value.trim();
  const detail = description.trim();
  if (!trimmed && !detail) {
    return "";
  }

  const hotelMatch = /^(?:\[(숙박|호텔)\]|(숙박|호텔))\s*:?\s*(.*)$/u.exec(trimmed);
  const descriptionNode = detail ? (
    <>
      {trimmed ? <br /> : null}
      <span>{detail}</span>
    </>
  ) : null;

  if (isHotel) {
    if (hotelMatch) {
      const label = hotelMatch[1] ?? hotelMatch[2] ?? "숙박";
      const hotelDetail = (hotelMatch[3] ?? "").trim();
      return (
        <span>
          <span className="font-bold">{label}</span>
          {hotelDetail ? ` ${hotelDetail}` : ""}
          {descriptionNode}
        </span>
      );
    }

    return (
      <span>
        <span className="font-bold">숙박</span>
        {trimmed ? ` ${trimmed}` : ""}
        {descriptionNode}
      </span>
    );
  }

  if (!hotelMatch) {
    return (
      <span>
        <span className="font-bold">{trimmed}</span>
        {descriptionNode}
      </span>
    );
  }

  const label = hotelMatch[1] ?? hotelMatch[2] ?? "";
  const hotelDetail = (hotelMatch[3] ?? "").trim();
  return (
    <span>
      <span className="font-bold">{label}</span>
      {hotelDetail ? ` ${hotelDetail}` : ""}
      {descriptionNode}
    </span>
  );
}

function renderMealText(value: string): React.ReactNode {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  return (
    <span>
      {lines.map((line, index) => {
        const match = /^(조식|중식|석식)\s*[:：]?\s*(.*)$/.exec(line);
        if (!match) {
          return (
            <span key={line + index}>
              {line}
              {index < lines.length - 1 ? <br /> : null}
            </span>
          );
        }

        const label = match[1] ?? "";
        const detail = (match[2] ?? "").trim();

        return (
          <span key={line + index}>
            <span className="font-bold">{label}</span>
            {detail ? ` ${detail}` : ""}
            {index < lines.length - 1 ? <br /> : null}
          </span>
        );
      })}
    </span>
  );
}

// ── 견적서 미리보기 ───────────────────────────────────────

type CostCategory = "항공" | "숙박" | "관광" | "식사" | "차량" | "가이드" | "기타";

type CostGroup = {
  label: CostCategory;
  items: QuoteData["items"];
  subtotal: number;
};

const COST_CATEGORY_ORDER: readonly CostCategory[] = [
  "항공",
  "숙박",
  "관광",
  "식사",
  "차량",
  "가이드",
  "기타",
];

function mapCostCategory(category: QuoteCategory | string): CostCategory {
  if (category === "FLIGHT") return "항공";
  if (category === "HOTEL") return "숙박";
  if (category === "SIGHTSEEING") return "관광";
  if (category === "MEAL") return "식사";
  if (category === "VEHICLE") return "차량";
  if (category === "GUIDE" || category === "가이드" || category === "guide") return "가이드";
  return "기타";
}

function groupQuoteItems(quote: QuoteData): CostGroup[] {
  const grouped = new Map<CostCategory, QuoteData["items"]>();
  const exchangeRates = getQuoteExchangeRates(quote);
  for (const category of COST_CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  for (const item of quote.items) {
    const key = mapCostCategory(item.category);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
  }

  return COST_CATEGORY_ORDER.flatMap((label) => {
    const bucket = grouped.get(label) ?? [];
    if (bucket.length === 0) return [];
    const subtotal = bucket.reduce(
      (sum, item) => sum + calculateItemSubtotalKrw(item, exchangeRates),
      0
    );
    return [{ label, items: bucket, subtotal }];
  });
}

function QuotePreview({ quote }: { quote: QuoteData | null }) {
  if (!quote) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12.5px] text-muted-foreground">견적 데이터가 없습니다.</p>
      </div>
    );
  }

  const grouped = groupQuoteItems(quote);
  const exchangeRates = getQuoteExchangeRates(quote);
  const subtotalKrw = grouped.reduce((sum, group) => sum + group.subtotal, 0);
  const groundProfit = quote.summary.groundProfit ?? 0;
  const agencyFeeWithGroundProfit = quote.summary.agencyFee + groundProfit;
  const totalKrw = subtotalKrw + groundProfit + quote.summary.agencyFee + quote.summary.vat;
  const validUntil = quote.header.validUntil || quote.header.writtenAt;
  const summaryRows = [
    { label: "항목소계", value: subtotalKrw },
    { label: "여행사수수료", value: agencyFeeWithGroundProfit },
    { label: "VAT", value: quote.summary.vat },
    { label: "TOTAL", value: totalKrw, isTotal: true },
  ];

  return (
    <div className={PREVIEW_DOCUMENT_CLASS}>
      <PreviewDocumentHeader
        title="견적 산출 내역서"
      />
      <div className="overflow-x-auto rounded-lg border border-grid-border">
        <table className={PREVIEW_WIDE_TABLE_CLASS}>
          <colgroup>
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[34%]" />
            <col className="w-[10%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead className="whitespace-nowrap bg-grid-header text-grid-header-foreground">
            <tr>
              <th className="px-3 py-2 text-center font-bold">항목</th>
              <th className="px-3 py-2 text-center font-bold">지역</th>
              <th className="px-3 py-2 text-center font-bold">날짜</th>
              <th className="px-3 py-2 text-center font-bold">상세내역</th>
              <th className="px-3 py-2 text-center font-bold">인원/개수</th>
              <th className="px-3 py-2 text-center font-bold">단가</th>
              <th className="px-3 py-2 text-center font-bold">합계(원)</th>
              <th className="px-3 py-2 text-center font-bold">건별합계</th>
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-3 text-center text-muted-foreground">
                  항목이 없습니다.
                </td>
              </tr>
            ) : (
              grouped.flatMap(({ label, items, subtotal }) => {
                const count = items.length;
                return items.map((item, index) => {
                  const isFirstRow = index === 0;
                  const rowKey = item.id
                    ? `${item.id}-${index}`
                    : `${label}-${index}-${item.description}`;

                  return (
                    <Fragment key={rowKey}>
                    <tr className="border-t border-border hover:bg-muted/20">
                        {isFirstRow ? (
                          <td
                            rowSpan={count}
                            className="border-r border-grid-border bg-muted px-3 py-1.5 align-middle text-center font-bold text-foreground"
                          >
                            {label}
                          </td>
                        ) : null}
                        <td className="whitespace-nowrap px-3 py-1.5 text-center text-muted-foreground">{item.region || ""}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-center text-muted-foreground">{item.date || ""}</td>
                        <td className="px-3 py-1.5 text-left text-foreground">
                          <div className="whitespace-pre-wrap">{item.description || ""}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right">{item.quantity || 0}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right">
                          {getExchangeRateForItem(exchangeRates, item).code}{" "}
                          {item.unitPrice ? item.unitPrice.toLocaleString() : 0}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium">
                          {calculateItemSubtotalKrw(item, exchangeRates).toLocaleString()}
                        </td>
                        {isFirstRow ? (
                          <td
                            rowSpan={count}
                            className="border-l border-grid-border px-3 py-1.5 text-right font-semibold text-foreground"
                          >
                            {subtotal.toLocaleString()}
                          </td>
                        ) : null}
                      </tr>
                    </Fragment>
                  );
                });
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className={`${PREVIEW_WIDE_TABLE_CLASS} border-collapse`}>
          <colgroup>
            <col className="w-[12.5%]" />
            <col className="w-[43.75%]" />
            <col className="w-[43.75%]" />
          </colgroup>
          <tbody>
            {summaryRows.map((row, index) => (
              <tr key={row.label}>
                {index === 0 ? (
                  <td
                    rowSpan={summaryRows.length}
                    className="align-middle border border-grid-border bg-muted px-3 py-1.5 text-center font-bold text-foreground"
                  >
                    예상 총 경비
                  </td>
                ) : null}
                <td
                  className="whitespace-nowrap border border-grid-border bg-white px-3 py-1.5 text-center font-medium text-muted-foreground"
                >
                  {row.label}
                </td>
                <td
                  className={`whitespace-nowrap border border-grid-border px-3 py-1.5 text-right font-semibold ${
                    row.isTotal ? "text-red-600" : "text-foreground"
                  }`}
                >
                  {row.value.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="pt-1 text-right text-[12.5px] font-medium leading-[18px] text-foreground">
        이 견적은 {formatDateKor(validUntil)} 까지만 유효합니다
      </p>

      <div className="pt-4 text-left text-[12.5px] leading-[18px] text-foreground">
        <p>(주)하나투어</p>
        <p>서울시 종로구 인사동 5길 41</p>
        <p>TEL: 1577-1233 | FAX: 02-1234-5678</p>
      </div>
    </div>
  );
}
