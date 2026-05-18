"use client";

// T-603: FlightPopup 컴포넌트 — 왕복/편도 검색 모드 분리
// T-604: 조회 결과 테이블 (왕복: 출국+귀국 조합, 편도: 인디비 단일편)

import { useState } from "react";
import { withAccessCodeHeaders } from "@/lib/converter/clientAccess";
import type {
  FlightDirection,
  FlightFareOption,
  FlightSegment,
  FlightTripType,
} from "@/app/api/flights/route";

interface FlightSelection {
  schedule: FlightFareOption;
  direction: FlightDirection;
}

interface Props {
  onClose: () => void;
  onSelect: (selection: FlightSelection) => void;
}

interface RoundTripForm {
  departureDate: string;
  departureAirport: string;
  arrivalAirport: string;
  returnDate: string;
  returnDepartureAirport: string;
  returnArrivalAirport: string;
}

interface OneWayForm {
  direction: FlightDirection;
  flightDate: string;
  departureAirport: string;
  arrivalAirport: string;
}

function formatKrw(amount: number): string {
  return amount.toLocaleString("ko-KR") + "원";
}

function getFareTypeLabel(fareType: FlightFareOption["fareType"]): string {
  if (fareType === "GROUP") return "그룹";
  return "인디비";
}

function getTripTypeLabel(tripType: FlightTripType): string {
  if (tripType === "ROUND_TRIP") return "왕복";
  return "편도";
}

function formatRoute(segment: FlightSegment): string {
  return `${segment.depAirport} → ${segment.arrAirport}`;
}

function formatTime(segment: FlightSegment): string {
  return `${segment.depTime} - ${segment.arrTime}`;
}

export function FlightPopup({ onClose, onSelect }: Props) {
  const [mode, setMode] = useState<FlightTripType>("ROUND_TRIP");
  const [roundTripForm, setRoundTripForm] = useState<RoundTripForm>({
    departureDate: "",
    departureAirport: "ICN",
    arrivalAirport: "SIN",
    returnDate: "",
    returnDepartureAirport: "SIN",
    returnArrivalAirport: "ICN",
  });
  const [oneWayForm, setOneWayForm] = useState<OneWayForm>({
    direction: "DEPARTURE",
    flightDate: "",
    departureAirport: "ICN",
    arrivalAirport: "SIN",
  });
  const [schedules, setSchedules] = useState<FlightFareOption[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);

  function handleModeChange(nextMode: FlightTripType) {
    setMode(nextMode);
    setSchedules(null);
    setError(null);
    setSelectionMessage(null);
  }

  function updateRoundTrip(field: keyof RoundTripForm, value: string) {
    setRoundTripForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateOneWay(field: keyof OneWayForm, value: string) {
    setOneWayForm((prev) => ({ ...prev, [field]: value }));
  }

  function buildSelectionMessage(schedule: FlightFareOption, direction: FlightDirection): string {
    if (schedule.tripType === "ROUND_TRIP") {
      return "왕복 항공이 일정표와 견적서에 반영되었습니다.";
    }
    const label = direction === "DEPARTURE" ? "출국편" : "귀국편";
    return `${label} ${schedule.outbound.flightNo}이 일정표와 견적서에 반영되었습니다.`;
  }

  async function loadSchedules(params: URLSearchParams) {
    const res = await fetch(`/api/flights?${params.toString()}`, {
      headers: withAccessCodeHeaders(),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? "항공 조회에 실패했습니다.");
    }
    const data = (await res.json()) as { schedules: FlightFareOption[] };
    setSchedules(data.schedules);
  }

  async function handleSearch() {
    setIsLoading(true);
    setError(null);
    setSelectionMessage(null);
    try {
      const params =
        mode === "ROUND_TRIP"
          ? new URLSearchParams({
              mode,
              departureAirport: roundTripForm.departureAirport,
              arrivalAirport: roundTripForm.arrivalAirport,
              returnDepartureAirport: roundTripForm.returnDepartureAirport,
              returnArrivalAirport: roundTripForm.returnArrivalAirport,
            })
          : new URLSearchParams({
              mode,
              departureAirport: oneWayForm.departureAirport,
              arrivalAirport: oneWayForm.arrivalAirport,
            });
      await loadSchedules(params);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSelect(schedule: FlightFareOption) {
    const direction = schedule.tripType === "ROUND_TRIP" ? "DEPARTURE" : oneWayForm.direction;
    onSelect({
      schedule,
      direction,
    });
    setSelectionMessage(buildSelectionMessage(schedule, direction));
    if (schedule.tripType === "ONE_WAY" && direction === "DEPARTURE") {
      const departureAirport = oneWayForm.arrivalAirport;
      const arrivalAirport = oneWayForm.departureAirport;
      setOneWayForm((prev) => ({
        ...prev,
        direction: "RETURN",
        departureAirport,
        arrivalAirport,
      }));
      setIsLoading(true);
      setError(null);
      try {
        await loadSchedules(
          new URLSearchParams({
            mode: "ONE_WAY",
            departureAirport,
            arrivalAirport,
          })
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
        setSchedules([]);
      } finally {
        setIsLoading(false);
      }
    }
  }

  const helperText =
    mode === "ROUND_TRIP"
      ? "출국/귀국 조건을 입력 후 조회하세요. 그룹 요금은 왕복에서만 조회됩니다."
      : "편도 조건을 입력 후 조회하세요. 편도 검색은 인디비 요금만 표시됩니다.";

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
        className="hub-dialog z-modal flex max-h-[90vh] w-[1120px] flex-col overflow-hidden"
      >
        <div className="hub-dialog-head">
          <h2 className="text-[13px] font-bold leading-5">항공 조회</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="hub-btn-text px-2 text-chrome-sidebar-foreground hover:bg-chrome-sidebar-hover"
          >
            ✕
          </button>
        </div>

        <div className="shrink-0 border-b border-border px-5 py-4">
          <div className="hub-tabs mb-4 inline-flex overflow-hidden">
            {(["ROUND_TRIP", "ONE_WAY"] as const).map((tripType) => (
              <button
                key={tripType}
                type="button"
                onClick={() => handleModeChange(tripType)}
                className={
                  mode === tripType
                    ? "hub-tab hub-tab-active"
                    : "hub-tab"
                }
              >
                {getTripTypeLabel(tripType)}
              </button>
            ))}
          </div>

          {mode === "ROUND_TRIP" ? (
            <RoundTripSearchForm form={roundTripForm} onChange={updateRoundTrip} />
          ) : (
            <OneWaySearchForm form={oneWayForm} onChange={updateOneWay} />
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[12.5px] text-muted-foreground">{selectionMessage ?? helperText}</p>
            <button
              onClick={handleSearch}
              disabled={isLoading}
              className="hub-btn hub-btn-primary disabled:opacity-50"
            >
              {isLoading ? "조회 중..." : "조회"}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" style={{ minHeight: "280px" }}>
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}

          {schedules === null && isLoading && (
            <p className="text-[12.5px] text-muted-foreground">조회 중...</p>
          )}

          {schedules !== null && schedules.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground">조회된 항공편이 없습니다.</p>
          )}

          {schedules !== null && schedules.length > 0 && (
            <>
              {mode === "ROUND_TRIP" ? (
                <RoundTripResults schedules={schedules} onSelect={handleSelect} />
              ) : (
                <OneWayResults schedules={schedules} onSelect={handleSelect} />
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="hub-btn hub-btn-custom"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function RoundTripSearchForm({
  form,
  onChange,
}: {
  form: RoundTripForm;
  onChange: (field: keyof RoundTripForm, value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex items-end gap-2">
        <DateField label="출국일" value={form.departureDate} onChange={(value) => onChange("departureDate", value)} />
        <AirportField label="출국 출발공항" value={form.departureAirport} onChange={(value) => onChange("departureAirport", value)} />
        <AirportField label="출국 도착공항" value={form.arrivalAirport} onChange={(value) => onChange("arrivalAirport", value)} />
      </div>
      <span className="flex h-[31px] items-center self-end text-[12.5px] text-muted-foreground">/</span>
      <div className="flex items-end gap-2">
        <DateField label="귀국일" value={form.returnDate} onChange={(value) => onChange("returnDate", value)} />
        <AirportField label="귀국 출발공항" value={form.returnDepartureAirport} onChange={(value) => onChange("returnDepartureAirport", value)} />
        <AirportField label="귀국 도착공항" value={form.returnArrivalAirport} onChange={(value) => onChange("returnArrivalAirport", value)} />
      </div>
    </div>
  );
}

function OneWaySearchForm({
  form,
  onChange,
}: {
  form: OneWayForm;
  onChange: (field: keyof OneWayForm, value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] text-muted-foreground">적용 대상</span>
        <div className="flex h-[31px] items-center gap-3 border border-input bg-white px-3">
          {(["DEPARTURE", "RETURN"] as const).map((direction) => (
            <label key={direction} className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-foreground">
              <input
                type="radio"
                name="one-way-direction"
                checked={form.direction === direction}
                onChange={() => onChange("direction", direction)}
                className="h-3 w-3 accent-primary"
              />
              {direction === "DEPARTURE" ? "출국" : "귀국"}
            </label>
          ))}
        </div>
      </div>
      <DateField label={form.direction === "DEPARTURE" ? "가는 날" : "오는 날"} value={form.flightDate} onChange={(value) => onChange("flightDate", value)} />
      <AirportField label="출발공항" value={form.departureAirport} onChange={(value) => onChange("departureAirport", value)} />
      <span className="mb-1 text-[12.5px] text-muted-foreground">→</span>
      <AirportField label="도착공항" value={form.arrivalAirport} onChange={(value) => onChange("arrivalAirport", value)} />
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12.5px] text-muted-foreground">{label}</label>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="hub-input"
      />
    </div>
  );
}

function AirportField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12.5px] text-muted-foreground">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        placeholder="ICN"
        className="hub-input w-28 uppercase"
      />
    </div>
  );
}

function RoundTripResults({
  schedules,
  onSelect,
}: {
  schedules: FlightFareOption[];
  onSelect: (schedule: FlightFareOption) => void;
}) {
  return (
    <table className="hub-grid">
      <thead>
        <tr>
          <th className="px-3 py-2 text-center font-medium">항공사</th>
          <th className="px-3 py-2 text-center font-medium">구분</th>
          <th className="px-3 py-2 text-center font-medium">출국 편명</th>
          <th className="px-3 py-2 text-center font-medium">출국 구간</th>
          <th className="px-3 py-2 text-center font-medium">출국 시간</th>
          <th className="px-3 py-2 text-center font-medium">귀국 편명</th>
          <th className="px-3 py-2 text-center font-medium">귀국 구간</th>
          <th className="px-3 py-2 text-center font-medium">귀국 시간</th>
          <th className="px-3 py-2 text-center font-medium">요금</th>
          <th className="px-3 py-2 text-center font-medium">유류할증료</th>
          <th className="px-3 py-2 text-center font-medium">제세공과금</th>
          <th className="px-3 py-2 text-center font-medium">총액</th>
          <th className="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {schedules.map((schedule) => {
          if (schedule.tripType !== "ROUND_TRIP") return null;
          return (
            <tr key={schedule.id} className="border-b border-border last:border-0 hover:bg-muted/50">
              <td className="px-3 py-2">{schedule.airline}</td>
              <td className="px-3 py-2">
                <FareTypeBadge fareType={schedule.fareType} />
              </td>
              <td className="px-3 py-2 font-mono">{schedule.outbound.flightNo}</td>
              <td className="px-3 py-2">{formatRoute(schedule.outbound)}</td>
              <td className="px-3 py-2">{formatTime(schedule.outbound)}</td>
              <td className="px-3 py-2 font-mono">{schedule.inbound.flightNo}</td>
              <td className="px-3 py-2">{formatRoute(schedule.inbound)}</td>
              <td className="px-3 py-2">{formatTime(schedule.inbound)}</td>
              <FareCells schedule={schedule} />
              <td className="px-3 py-2">
                <SelectButton onClick={() => onSelect(schedule)} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OneWayResults({
  schedules,
  onSelect,
}: {
  schedules: FlightFareOption[];
  onSelect: (schedule: FlightFareOption) => void;
}) {
  return (
    <table className="hub-grid">
      <thead>
        <tr>
          <th className="px-3 py-2 text-center font-medium">항공사</th>
          <th className="px-3 py-2 text-center font-medium">구분</th>
          <th className="px-3 py-2 text-center font-medium">편명</th>
          <th className="px-3 py-2 text-center font-medium">구간</th>
          <th className="px-3 py-2 text-center font-medium">시간</th>
          <th className="px-3 py-2 text-center font-medium">요금</th>
          <th className="px-3 py-2 text-center font-medium">유류할증료</th>
          <th className="px-3 py-2 text-center font-medium">제세공과금</th>
          <th className="px-3 py-2 text-center font-medium">총액</th>
          <th className="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {schedules.map((schedule) => (
          <tr key={schedule.id} className="border-b border-border last:border-0 hover:bg-muted/50">
            <td className="px-3 py-2">{schedule.airline}</td>
            <td className="px-3 py-2">
              <FareTypeBadge fareType={schedule.fareType} />
            </td>
            <td className="px-3 py-2 font-mono">{schedule.outbound.flightNo}</td>
            <td className="px-3 py-2">{formatRoute(schedule.outbound)}</td>
            <td className="px-3 py-2">{formatTime(schedule.outbound)}</td>
            <FareCells schedule={schedule} />
            <td className="px-3 py-2">
              <SelectButton onClick={() => onSelect(schedule)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FareTypeBadge({ fareType }: { fareType: FlightFareOption["fareType"] }) {
  return (
    <span
      className={
        fareType === "GROUP"
          ? "inline-flex rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11.5px] font-medium text-primary"
          : "inline-flex rounded border border-border bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground"
      }
    >
      {getFareTypeLabel(fareType)}
    </span>
  );
}

function FareCells({ schedule }: { schedule: FlightFareOption }) {
  return (
    <>
      <td className="px-3 py-2 text-right">{formatKrw(schedule.fareAdult)}</td>
      <td className="px-3 py-2 text-right">{formatKrw(schedule.fuelSurcharge)}</td>
      <td className="px-3 py-2 text-right">{formatKrw(schedule.tax)}</td>
      <td className="px-3 py-2 text-right font-semibold">{formatKrw(schedule.total)}</td>
    </>
  );
}

function SelectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hub-btn hub-btn-primary h-7 px-2"
    >
      선택
    </button>
  );
}
