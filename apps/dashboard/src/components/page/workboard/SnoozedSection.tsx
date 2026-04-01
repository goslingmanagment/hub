import { useState } from "react";
import type { WorkboardSnoozedVm } from "@/pages/workboard/viewModel";

interface SnoozedSectionProps {
  items: WorkboardSnoozedVm[];
  onUnsnooze: (fanId: number) => void;
  pendingFanId: number | null;
}

export function SnoozedSection({ items, onUnsnooze, pendingFanId }: SnoozedSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
      >
        <span className={`transition-transform ${isOpen ? "rotate-90" : ""}`}>&#9656;</span>
        Отложенные ({items.length})
      </button>

      {isOpen && (
        <div className="mt-2 space-y-1">
          {items.map((item) => (
            <div
              key={item.fanId}
              className="flex items-center justify-between gap-4 px-4 py-2 bg-card border border-border rounded-lg text-[13px]"
            >
              <div className="flex items-center gap-4 min-w-0">
                <span className="text-text-primary font-medium truncate">{item.fanLabel}</span>
                <span className="text-text-muted shrink-0">{item.ltvLabel}</span>
                <span className="text-text-muted shrink-0">до {item.snoozedUntilLabel}</span>
              </div>
              <button
                type="button"
                disabled={pendingFanId === item.fanId}
                onClick={() => onUnsnooze(item.fanId)}
                className="px-2 py-1 text-[11px] font-medium rounded border border-border text-text-muted hover:text-text-secondary hover:bg-hover transition-colors disabled:opacity-50 shrink-0"
              >
                {pendingFanId === item.fanId ? "Возвращаю..." : "Вернуть"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
