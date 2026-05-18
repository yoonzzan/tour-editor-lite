"use client";

// T-306: DayBlock 컴포넌트 (일차 헤더 + 항목 목록)
// T-307: 항목 추가 버튼 → 관광 항목 즉시 추가
// T-311: @dnd-kit/core 드래그앤드롭 (같은 일차 내)

import { type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DaySchedule, ScheduleItem, ScheduleItemType } from "@/types";
import { ScheduleItemForm } from "./ScheduleItemForm";

interface Props {
  day: DaySchedule;
  onUpdateDay: (updated: DaySchedule) => void;
  onAddItem: (type: ScheduleItemType) => void;
  onRemoveItem: (itemId: string) => void;
  onClearDay: () => void;
  onReorder: (activeId: string, overId: string) => void;
  dayDragHandle?: ReactNode;
}

export function DayBlock({
  day,
  onUpdateDay,
  onAddItem,
  onRemoveItem,
  onClearDay,
  onReorder,
  dayDragHandle,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  }

  function handleItemChange(updated: ScheduleItem) {
    const newItems = day.items.map((it) => (it.id === updated.id ? updated : it));
    const prevType = day.items.find((item) => item.id === updated.id)?.type;
    const needsReorder =
      updated.type === "ACCOMMODATION" ||
      prevType === "ACCOMMODATION" ||
      prevType === undefined;
    onUpdateDay({
      ...day,
      items: needsReorder ? stabilizeAccommodationOrder(newItems) : newItems,
    });
  }

  // 숙박 외 항목만 드래그 가능 (T-311, ACCOMMODATION: isDraggable = false)
  const draggableIds = day.items
    .filter((it) => it.type !== "ACCOMMODATION")
    .map((it) => it.id);

  return (
    <div className="hub-section" data-testid={`day-block-${day.dayNo}`}>
      {/* 일차 헤더 */}
      <div className="hub-section-head">
        <div className="flex min-w-0 items-center gap-3">
        {dayDragHandle && (
          <div className="cursor-grab text-muted-foreground hover:text-foreground">
            {dayDragHandle}
          </div>
        )}
        <span className="min-w-[4rem] text-[14px] font-bold text-foreground">
          {day.dayNo}일차
        </span>
        <input
          type="date"
          aria-label={`${day.dayNo}일차 날짜`}
          value={day.date}
          onChange={(e) => onUpdateDay({ ...day, date: e.target.value })}
          className="hub-input w-32"
        />
        <span className="text-xs text-muted-foreground">
          {day.items.length}개 항목
        </span>
        </div>
        <button
          type="button"
          disabled={day.items.length === 0}
          onClick={() => {
            if (day.items.length === 0) return;
            if (!window.confirm(`${day.dayNo}일차의 모든 항목을 삭제할까요?`)) return;
            onClearDay();
          }}
          className="hub-btn hub-btn-custom disabled:cursor-not-allowed"
        >
          내용 전체삭제
        </button>
      </div>

      {/* 항목 목록 */}
      <div className="flex flex-col p-2">
        <div className="hidden border border-grid-border bg-grid-header md:grid md:grid-cols-12 md:items-center md:gap-1 md:px-7 md:py-1">
          <span className="md:col-span-2 text-center text-xs font-bold text-grid-header-foreground">항목구분</span>
          <span className="md:col-span-1 text-center text-xs font-bold text-grid-header-foreground">지역</span>
          <span className="md:col-span-1 text-center text-xs font-bold text-grid-header-foreground">교통편</span>
          <span className="md:col-span-1 text-center text-xs font-bold text-grid-header-foreground">시간</span>
          <span className="md:col-span-3 text-center text-xs font-bold text-grid-header-foreground">내용</span>
          <span className="md:col-span-4 text-center text-xs font-bold text-grid-header-foreground">상세</span>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={draggableIds}
            strategy={verticalListSortingStrategy}
          >
            {day.items.map((item) => (
              <SortableItem
                key={item.id}
                item={item}
                isDraggable={item.type !== "ACCOMMODATION"}
                onChange={handleItemChange}
                onRemove={() => onRemoveItem(item.id)}
              />
            ))}
          </SortableContext>
        </DndContext>

        {day.items.length === 0 && (
          <p className="border-x border-b border-grid-border py-4 text-center text-xs text-muted-foreground">
            항목이 없습니다. 아래 버튼으로 추가하세요.
          </p>
        )}
      </div>

      {/* 항목 추가 (T-307) */}
      <div className="border-t border-border bg-muted/30 px-3 py-2">
        <button
          type="button"
          onClick={() => onAddItem("SIGHTSEEING")}
          className="hub-btn hub-btn-custom"
        >
          <span>+</span>
          <span>항목 추가</span>
        </button>
      </div>
    </div>
  );
}

// ── Sortable 항목 래퍼 ───────────────────────────────────

interface SortableItemProps {
  item: ScheduleItem;
  isDraggable: boolean;
  onChange: (updated: ScheduleItem) => void;
  onRemove: () => void;
}

function SortableItem({
  item,
  isDraggable,
  onChange,
  onRemove,
}: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !isDraggable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const dragHandle = isDraggable ? (
    <span
      {...attributes}
      {...listeners}
      aria-label="드래그하여 순서 변경"
      className="select-none text-muted-foreground"
      title="드래그하여 순서 변경"
    >
      ⠿
    </span>
  ) : null;

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col">
      <ScheduleItemForm
        item={item}
        onChange={onChange}
        onRemove={onRemove}
        dragHandle={dragHandle}
      />
    </div>
  );
}

function stabilizeAccommodationOrder(items: ScheduleItem[]): ScheduleItem[] {
  const accommodations = items.filter((item) => item.type === "ACCOMMODATION");
  const others = items.filter((item) => item.type !== "ACCOMMODATION");
  return [...others, ...accommodations];
}
