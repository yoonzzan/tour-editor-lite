"use client";

// T-302: ItineraryEditor 껍데기 + 헤더 (단체명·작성일)
// T-303: 견적 개요 테이블
// T-304: 여행요금 행 (자동 계산)
// T-305: 일정 기본 항목

import {
  cloneElement,
  useEffect,
  useCallback,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEditorStore } from "@/hooks/useEditorStore";
import type { DaySchedule, ItineraryData } from "@/types";
import { DayBlock } from "./DayBlock";
import { addDaysToDateString } from "@/lib/itinerary/dayAlignment";
import {
  addItemToDay,
  removeItemFromDay,
  reorderDays,
  reorderItemInDay,
} from "@/lib/itinerary/mutations";

type SummaryNotes = NonNullable<ItineraryData["basics"]["summaryNotes"]>;
type SummaryNoteKey = keyof SummaryNotes;
type Passengers = ItineraryData["overview"]["passengers"];
type Fare = ItineraryData["overview"]["fare"];
type Overview = ItineraryData["overview"];

const EMPTY_SUMMARY_NOTES: SummaryNotes = {
  flight: "",
  vehicle: "",
  accommodation: "",
  included: "",
  excluded: "",
  optionalTour: "",
  shoppingCenters: "",
};

function normalizeNumberInputValue(value: string): string {
  if (value === "") return "";
  return value.replace(/^0+(?=\d)/u, "");
}

function parseNonNegativeInteger(value: string): number {
  const normalized = normalizeNumberInputValue(value.replace(/[^\d]/gu, ""));
  return Math.max(0, Number(normalized));
}

function formatIntegerInputValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, Math.trunc(value)).toLocaleString("ko-KR");
}

function readNonNegativeInput(input: HTMLInputElement): number {
  const nextValue = parseNonNegativeInteger(input.value);
  input.value = formatIntegerInputValue(nextValue);
  return nextValue;
}

function calculateFareTotal(passengers: Passengers, fare: Fare): number {
  return (
    passengers.adult * fare.adultPerPerson +
    passengers.child * fare.childPerPerson +
    passengers.infant * fare.infantPerPerson
  );
}

const TEXTAREA_CLASS =
  "hub-textarea overflow-hidden";

function AutoResizeTextarea({
  id,
  value,
  onChange,
  className = TEXTAREA_CLASS,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    if (value.trim().length === 0) {
      textarea.style.height = "var(--hub-control-height)";
      return;
    }
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    />
  );
}

export function ItineraryEditor() {
  const { itinerary, setItinerary } = useEditorStore();
  const daySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const update = useCallback(
    (patch: Partial<ItineraryData>) => {
      const currentItinerary = useEditorStore.getState().itinerary;
      if (!currentItinerary) return;
      setItinerary({ ...currentItinerary, ...patch });
    },
    [setItinerary]
  );

  const updateOverview = useCallback(
    (updater: (currentOverview: Overview) => Overview) => {
      const currentItinerary = useEditorStore.getState().itinerary;
      if (!currentItinerary) return;
      setItinerary({
        ...currentItinerary,
        overview: updater(currentItinerary.overview),
      });
    },
    [setItinerary]
  );

  if (!itinerary) return null;

  const { header, overview, basics, days } = itinerary;
  const summaryNotes = { ...EMPTY_SUMMARY_NOTES, ...basics.summaryNotes };

  // 총금액 자동 계산
  const { adult, child, infant } = overview.passengers;
  const { adultPerPerson, childPerPerson, infantPerPerson } = overview.fare;
  const passengerTotal = adult + child + infant;
  const autoTotal =
    adult * adultPerPerson + child * childPerPerson + infant * infantPerPerson;

  function handleDayDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const newDays = reorderDays(days, Number(active.id), Number(over.id));
    update({ days: newDays });
  }

  function updateSummaryNote(key: SummaryNoteKey, value: string) {
    update({
      basics: {
        ...basics,
        summaryNotes: {
          ...summaryNotes,
          [key]: value,
        },
      },
    });
  }

  function addDay() {
    const nextDayNo = days.length + 1;
    const startDate = overview.travelPeriod.start || days[0]?.date || "";
    const nextDate = startDate
      ? addDaysToDateString(startDate, nextDayNo - 1)
      : "";
    update({
      overview: {
        ...overview,
        travelPeriod: {
          ...overview.travelPeriod,
          end: nextDate || overview.travelPeriod.end,
        },
      },
      days: [
        ...days,
        {
          dayNo: nextDayNo,
          date: nextDate,
          items: [],
        },
      ],
    });
  }

  return (
    <div className="flex w-full flex-col gap-4 pb-16">
      {/* ── 헤더 (T-302) ─────────────────────────────── */}
      <div className="flex items-center justify-between hub-section-head">
        <h2 className="text-[13px] font-semibold text-foreground">
          일정표 에디터
        </h2>
      </div>

      <section className="hub-section p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="groupName" className="text-xs text-muted-foreground">
              단체명
            </label>
            <input
              id="groupName"
              type="text"
              value={header.groupName}
              onChange={(e) =>
                update({ header: { ...header, groupName: e.target.value } })
              }
              className="hub-input"
              placeholder="단체명 입력"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="writtenAt" className="text-xs text-muted-foreground">
              작성일
            </label>
            <input
              id="writtenAt"
              type="date"
              value={header.writtenAt}
              onChange={(e) =>
                update({ header: { ...header, writtenAt: e.target.value } })
              }
              className="hub-input"
            />
          </div>
        </div>
      </section>

      {/* ── 견적 개요 테이블 (T-303) ─────────────────── */}
      <section className="hub-section p-3">
        <h2 className="mb-3 hub-section-title">
          견적 개요
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="recipient" className="text-xs text-muted-foreground">수신</label>
            <input
              id="recipient"
              type="text"
              value={overview.recipient}
              onChange={(e) =>
                update({ overview: { ...overview, recipient: e.target.value } })
              }
              className="hub-input"
              placeholder="수신처 입력"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="cities" className="text-xs text-muted-foreground">여행도시</label>
            <input
              id="cities"
              type="text"
              value={overview.cities}
              onChange={(e) =>
                update({ overview: { ...overview, cities: e.target.value } })
              }
              className="hub-input"
              placeholder="예: 싱가포르, 방콕"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="travelStart" className="text-xs text-muted-foreground">여행 시작일</label>
            <input
              id="travelStart"
              type="date"
              value={overview.travelPeriod.start}
              onChange={(e) =>
                update({
                  overview: {
                    ...overview,
                    travelPeriod: { ...overview.travelPeriod, start: e.target.value },
                  },
                })
              }
              className="hub-input"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="travelEnd" className="text-xs text-muted-foreground">여행 종료일</label>
            <input
              id="travelEnd"
              type="date"
              value={overview.travelPeriod.end}
              onChange={(e) =>
                update({
                  overview: {
                    ...overview,
                    travelPeriod: { ...overview.travelPeriod, end: e.target.value },
                  },
                })
              }
              className="hub-input"
            />
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <span className="text-xs text-muted-foreground">인원 수</span>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {(
                [
                  { key: "adult", label: "성인" },
                  { key: "child", label: "아동" },
                  { key: "infant", label: "유아" },
                ] as const
              ).map(({ key, label }) => (
                <label key={key} htmlFor={`pax-${key}`} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <input
                    id={`pax-${key}`}
                    type="text"
                    inputMode="numeric"
                    value={formatIntegerInputValue(overview.passengers[key])}
                    onChange={(e) => {
                      const nextValue = readNonNegativeInput(e.currentTarget);
                      updateOverview((currentOverview) => {
                        const nextPassengers = {
                          ...currentOverview.passengers,
                          [key]: nextValue,
                        };
                        return {
                          ...currentOverview,
                          passengers: nextPassengers,
                          fare: {
                            ...currentOverview.fare,
                            total: calculateFareTotal(nextPassengers, currentOverview.fare),
                          },
                        };
                      });
                    }}
                    className="hub-input w-full text-right"
                  />
                </label>
              ))}
              <label htmlFor="pax-total" className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">총인원 (자동계산)</span>
                <div
                  id="pax-total"
                  className="hub-input w-full items-center justify-end bg-muted/40 text-right font-medium"
                >
                  {formatIntegerInputValue(passengerTotal)}
                </div>
              </label>
              {(
                [
                  { key: "escort", label: "인솔자" },
                  { key: "foc", label: "FOC" },
                ] as const
              ).map(({ key, label }) => (
                <label key={key} htmlFor={`pax-${key}`} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <input
                    id={`pax-${key}`}
                    type="text"
                    inputMode="numeric"
                    value={formatIntegerInputValue(overview.passengers[key])}
                    onChange={(e) => {
                      const nextValue = readNonNegativeInput(e.currentTarget);
                      updateOverview((currentOverview) => {
                        const nextPassengers = {
                          ...currentOverview.passengers,
                          [key]: nextValue,
                        };
                        return {
                          ...currentOverview,
                          passengers: nextPassengers,
                          fare: {
                            ...currentOverview.fare,
                            total: calculateFareTotal(nextPassengers, currentOverview.fare),
                          },
                        };
                      });
                    }}
                    className="hub-input w-full text-right"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 여행요금 (T-304) ──────────────────────────── */}
      <section className="hub-section p-3">
        <h2 className="mb-3 hub-section-title">
          여행요금
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(
            [
              { key: "adultPerPerson", label: "성인 1인" },
              { key: "childPerPerson", label: "아동 1인" },
              { key: "infantPerPerson", label: "유아 1인" },
            ] as const
          ).map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-1">
              <label htmlFor={`fare-${key}`} className="text-xs text-muted-foreground">
                {label} (원)
              </label>
              <input
                id={`fare-${key}`}
                type="text"
                inputMode="numeric"
                value={formatIntegerInputValue(overview.fare[key])}
                onChange={(e) => {
                  const nextValue = readNonNegativeInput(e.currentTarget);
                  updateOverview((currentOverview) => {
                    const nextFare = {
                      ...currentOverview.fare,
                      [key]: nextValue,
                    };
                    return {
                      ...currentOverview,
                      fare: {
                        ...nextFare,
                        total: calculateFareTotal(currentOverview.passengers, nextFare),
                      },
                    };
                  });
                }}
                className="hub-input text-right"
              />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">총금액 (자동계산)</label>
            <div className="hub-input items-center justify-end bg-muted/40 text-right font-medium">
              {autoTotal.toLocaleString()} 원
            </div>
          </div>
        </div>
      </section>

      {/* ── 일정 기본 항목 (T-305) ───────────────────── */}
      <section className="hub-section p-3">
        <h2 className="mb-3 hub-section-title">
          일정 기본 항목
        </h2>
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 hub-section p-3 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {(
                [
                  { key: "departure", label: "항공 (출발)" },
                  { key: "arrival", label: "항공 (귀국)" },
                ] as const
              ).map(({ key, label }) => (
                <div key={key} className="flex flex-col gap-1">
                  <label htmlFor={`basics-flight-${key}`} className="text-xs text-muted-foreground">
                    {label}
                  </label>
                  <input
                    id={`basics-flight-${key}`}
                    type="text"
                    value={basics.flight[key]}
                    onChange={(e) =>
                      update({
                        basics: {
                          ...basics,
                          flight: {
                            ...basics.flight,
                            [key]: e.target.value,
                          },
                        },
                      })
                    }
                    className="hub-input"
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="summary-note-flight" className="text-xs text-muted-foreground">
                항공 비고
              </label>
              <AutoResizeTextarea
                id="summary-note-flight"
                value={summaryNotes.flight}
                onChange={(value) => updateSummaryNote("flight", value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 hub-section p-3 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="flex flex-col gap-1">
              <label htmlFor="basics-flight-localVehicle" className="text-xs text-muted-foreground">
                현지 차량
              </label>
              <input
                id="basics-flight-localVehicle"
                type="text"
                value={basics.flight.localVehicle}
                onChange={(e) =>
                  update({
                    basics: {
                      ...basics,
                      flight: {
                        ...basics.flight,
                        localVehicle: e.target.value,
                      },
                    },
                  })
                }
                className="hub-input"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="summary-note-vehicle" className="text-xs text-muted-foreground">
                차량 비고
              </label>
              <AutoResizeTextarea
                id="summary-note-vehicle"
                value={summaryNotes.vehicle}
                onChange={(value) => updateSummaryNote("vehicle", value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 hub-section p-3 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {(
                [
                  { key: "hotel", label: "숙박 호텔" },
                  { key: "grade", label: "호텔 등급" },
                  { key: "occupancy", label: "1객실 이용인원" },
                ] as const
              ).map(({ key, label }) => (
                <div key={key} className="flex flex-col gap-1">
                  <label htmlFor={`basics-accommodation-${key}`} className="text-xs text-muted-foreground">
                    {label}
                  </label>
                  <input
                    id={`basics-accommodation-${key}`}
                    type="text"
                    value={basics.accommodation[key]}
                    onChange={(e) =>
                      update({
                        basics: {
                          ...basics,
                          accommodation: {
                            ...basics.accommodation,
                            [key]: e.target.value,
                          },
                        },
                      })
                    }
                    className="hub-input"
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="summary-note-accommodation" className="text-xs text-muted-foreground">
                숙박 비고
              </label>
              <AutoResizeTextarea
                id="summary-note-accommodation"
                value={summaryNotes.accommodation}
                onChange={(value) => updateSummaryNote("accommodation", value)}
              />
            </div>
          </div>

          {(
            [
              { key: "included", label: "포함 사항" },
              { key: "excluded", label: "불포함 사항" },
            ] as { key: "included" | "excluded"; label: string }[]
          ).map(({ key, label }) => (
            <div key={key} className="grid grid-cols-1 gap-3 hub-section p-3 md:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="flex flex-col gap-1">
                <label htmlFor={`basics-${key}`} className="text-xs text-muted-foreground">
                  {label}
                </label>
                <AutoResizeTextarea
                  id={`basics-${key}`}
                  value={basics[key]}
                  onChange={(value) =>
                    update({ basics: { ...basics, [key]: value } })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`summary-note-${key}`} className="text-xs text-muted-foreground">
                  {label} 비고
                </label>
                <AutoResizeTextarea
                  id={`summary-note-${key}`}
                  value={summaryNotes[key]}
                  onChange={(value) => updateSummaryNote(key, value)}
                />
              </div>
            </div>
          ))}

          <div className="grid grid-cols-1 gap-3 hub-section p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="basics-optionalTour" className="text-xs text-muted-foreground">
                선택관광
              </label>
              <AutoResizeTextarea
                id="basics-optionalTour"
                value={basics.optionalTour}
                onChange={(value) =>
                  update({ basics: { ...basics, optionalTour: value } })
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="summary-note-optionalTour" className="text-xs text-muted-foreground">
                선택관광 비고
              </label>
              <AutoResizeTextarea
                id="summary-note-optionalTour"
                value={summaryNotes.optionalTour}
                onChange={(value) => updateSummaryNote("optionalTour", value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="shoppingCenters" className="text-xs text-muted-foreground">
                쇼핑횟수
              </label>
              <input
                id="shoppingCenters"
                type="number"
                min={0}
                inputMode="numeric"
                value={basics.shoppingCenters}
                onChange={(e) =>
                  update({
                    basics: {
                      ...basics,
                      shoppingCenters: readNonNegativeInput(e.currentTarget),
                    },
                  })
                }
                className="w-24 hub-input text-right"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="summary-note-shoppingCenters" className="text-xs text-muted-foreground">
                쇼핑센터 비고
              </label>
              <AutoResizeTextarea
                id="summary-note-shoppingCenters"
                value={summaryNotes.shoppingCenters}
                onChange={(value) => updateSummaryNote("shoppingCenters", value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="basics-notes" className="text-xs text-muted-foreground">
              유의사항
            </label>
            <AutoResizeTextarea
              id="basics-notes"
              value={basics.notes}
              onChange={(value) => update({ basics: { ...basics, notes: value } })}
            />
          </div>
        </div>
      </section>

      {/* ── 일자별 블록 (T-306~T-312) ────────────────── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="hub-section-title">
            일차별 일정
          </h2>
          <button
            type="button"
            onClick={addDay}
            className="hub-btn hub-btn-custom"
          >
            + 일차 추가
          </button>
        </div>
        <DndContext
          sensors={daySensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDayDragEnd}
        >
          <SortableContext
            items={days.map((day) => String(day.dayNo))}
            strategy={verticalListSortingStrategy}
          >
            {days.map((day, dayIndex) => (
              <SortableDayBlock key={day.dayNo} day={day}>
                <DayBlock
                  day={day}
                  onUpdateDay={(updatedDay) => {
                    const newDays = days.map((d, i) => (i === dayIndex ? updatedDay : d));
                    update({ days: newDays });
                  }}
                  onAddItem={(type) => {
                    const newDays = addItemToDay(days, dayIndex, type);
                    update({ days: newDays });
                  }}
                  onRemoveItem={(itemId) => {
                    const newDays = removeItemFromDay(days, dayIndex, itemId);
                    update({ days: newDays });
                  }}
                  onClearDay={() => {
                    const newDays = days.map((d, i) => (i === dayIndex ? { ...d, items: [] } : d));
                    update({ days: newDays });
                  }}
                  onReorder={(activeId, overId) => {
                    const newDays = reorderItemInDay(days, dayIndex, activeId, overId);
                    update({ days: newDays });
                  }}
                />
              </SortableDayBlock>
            ))}
          </SortableContext>
        </DndContext>
      </section>
    </div>
  );
}

interface SortableDayBlockProps {
  day: DaySchedule;
  children: ReactNode;
}

function SortableDayBlock({ day, children }: SortableDayBlockProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(day.dayNo) });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const dayBlock = children as ReactElement<{
    dayDragHandle?: ReactNode;
  }>;

  return (
    <div ref={setNodeRef} style={style}>
      {cloneElement(dayBlock, {
        dayDragHandle: (
          <span
            {...attributes}
            {...listeners}
            aria-label="드래그하여 일차 순서 변경"
            className="select-none"
            title="드래그하여 일차 순서 변경"
          >
            ⠿
          </span>
        ),
      })}
    </div>
  );
}
