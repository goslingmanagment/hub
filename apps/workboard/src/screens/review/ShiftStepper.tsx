import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Menu, Tooltip, type MenuEntry } from "@agency_hub_core/ui";
import { formatDuration, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { personPath, shiftPath } from "@/shared/links";
import { prefetchReview, useShiftsAround, type ReviewShift } from "./data.js";

/**
 * ← the chatter's previous shift · «Другая смена» · next shift → (spec §4.2).
 * A neighbour is read when the pointer or the focus reaches its arrow, not on
 * every open. «Другая смена» lists the chatter's shifts of the week around this
 * one and the others' that overlapped it, each with its length; it reads them
 * once opened or hovered. Its last item opens the chatter's card.
 */

function spanText(startedAt: string, endedAt: string, ongoing: boolean): string {
  return ongoing ? `с ${formatTimeOfDay(startedAt)}, идёт` : `${formatTimeOfDay(startedAt)}–${formatTimeOfDay(endedAt)}`;
}

export function ShiftStepper({ shift }: { shift: ReviewShift }) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [wanted, setWanted] = useState(false);
  const around = useShiftsAround(shift.startedAt, wanted);
  // The way back stays where the review was entered from; the period, the list and the page filter go along.
  const state = location.state as unknown;
  const pathTo = (userId: number, at: string) => {
    const path = shiftPath(userId, at, location.search);
    const show = new URLSearchParams(location.search).get("show");
    return show ? `${path}${path.includes("?") ? "&" : "?"}show=${encodeURIComponent(show)}` : path;
  };

  const arrow = (at: string | null, direction: "previous" | "next") => {
    const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
    const words = direction === "previous" ? "Прошлая смена" : "Следующая смена";
    if (at === null) {
      return (
        <Tooltip content={direction === "previous" ? "Прошлой смены за неделю до этой нет" : "Следующей смены пока нет"}>
          <button type="button" className="review-stepper__arrow" disabled aria-label={words}>
            <Icon size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
      );
    }
    const prefetch = () => prefetchReview(client, shift.userId, at);
    const label = `${words}: ${formatWeekdayDay(at)}, ${formatTimeOfDay(at)}`;
    return (
      <Tooltip content={label}>
        <Link to={pathTo(shift.userId, at)} state={state} className="review-stepper__arrow" aria-label={label} onMouseEnter={prefetch} onFocus={prefetch}>
          <Icon size={18} strokeWidth={1.75} aria-hidden />
        </Link>
      </Tooltip>
    );
  };

  const shifts = around.data?.shifts ?? [];
  const start = shift.start;
  const own = shifts.filter((one) => one.userId === shift.userId);
  const together = shifts.filter((one) => one.userId !== shift.userId && Date.parse(one.startedAt) < shift.end && Date.parse(one.endedAt) > start);
  const go = (userId: number, at: string) => navigate(pathTo(userId, at), { state });
  const items: MenuEntry[] = around.isPending
    ? [{ label: "Загружаем смены…", disabled: true, onSelect: () => undefined }]
    : around.isError
      ? [{ label: "Hub не ответил — смены не загрузились", disabled: true, onSelect: () => undefined }]
      : [
        { group: `${shift.username}, неделя` },
        ...own.map((one): MenuEntry => ({
          label: `${formatWeekdayDay(one.startedAt)} · ${spanText(one.startedAt, one.endedAt, one.ongoing)}`,
          hint: formatDuration(one.workedMinutes),
          checked: Date.parse(one.startedAt) === start,
          onSelect: () => go(one.userId, one.startedAt),
        })),
        ...(together.length > 0
          ? [
            { separator: true } as const,
            { group: "В это же время работали" },
            ...together.map((one): MenuEntry => ({
              label: `${one.username} · ${spanText(one.startedAt, one.endedAt, one.ongoing)}`,
              hint: formatDuration(one.workedMinutes),
              onSelect: () => go(one.userId, one.startedAt),
            })),
          ]
          : []),
        { separator: true },
        {
          label: `Карточка ${shift.username}: все смены`,
          onSelect: () => navigate(personPath(shift.userId, location.search), { state: { back: { to: `${location.pathname}${location.search}`, label: "Разбор" } } }),
        },
      ];

  return (
    <div className="review-stepper" role="group" aria-label="Смены" onMouseEnter={() => setWanted(true)}>
      {arrow(shift.previousAt, "previous")}
      <Menu
        label="Другая смена"
        items={items}
        align="end"
        onOpenChange={(open) => {
          if (open) setWanted(true);
        }}
        renderTrigger={({ ref, ...trigger }) => (
          <button ref={ref} type="button" className="review-stepper__pick" onFocus={() => setWanted(true)} {...trigger}>
            Другая смена
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      />
      {arrow(shift.nextAt, "next")}
    </div>
  );
}
