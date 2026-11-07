import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Menu, type MenuEntry } from "@agency_hub_core/ui";
import { formatCount, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { personPath, shiftPath } from "@/shared/links";
import { prefetchReview, useShiftsAround, type ReviewShift } from "./data.js";

/**
 * ← the chatter's previous shift · «Другая смена» · next shift → (spec §4.2).
 * A neighbour is read when the pointer or the focus reaches its arrow, not on
 * every open. «Другая смена» lists the chatter's shifts of the week around this
 * one and the others' that overlapped it; it reads them once opened.
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
  // The way back stays where the review was entered from; the list and the page filter go along.
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
        <button type="button" className="review-stepper__arrow" disabled aria-label={words} title={direction === "previous" ? "Прошлой смены за неделю до этой нет" : "Следующей смены пока нет"}>
          <Icon size={18} strokeWidth={1.75} aria-hidden />
        </button>
      );
    }
    const prefetch = () => prefetchReview(client, shift.userId, at);
    return (
      <Link
        to={pathTo(shift.userId, at)}
        state={state}
        className="review-stepper__arrow"
        aria-label={`${words}: ${formatWeekdayDay(at)}, ${formatTimeOfDay(at)}`}
        title={`${words} ${shift.username}: ${formatWeekdayDay(at)}, ${formatTimeOfDay(at)}`}
        onMouseEnter={prefetch}
        onFocus={prefetch}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden />
      </Link>
    );
  };

  // The list comes after the menu has opened and is wider than «Загружаем…»: the menu places itself again.
  // (packages/ui's anchored position is measured on open only; asked to follow the box's size.)
  const loaded = around.data !== undefined;
  useEffect(() => {
    if (loaded) window.dispatchEvent(new Event("resize"));
  }, [loaded]);

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
          hint: `${formatCount(one.authoredMessages)} сообщ.`,
          checked: Date.parse(one.startedAt) === start,
          onSelect: () => go(one.userId, one.startedAt),
        })),
        ...(together.length > 0
          ? [
            { separator: true } as const,
            { group: "В это же время работали" },
            ...together.map((one): MenuEntry => ({
              label: `${one.username} · ${spanText(one.startedAt, one.endedAt, one.ongoing)}`,
              hint: `${formatCount(one.authoredMessages)} сообщ.`,
              onSelect: () => go(one.userId, one.startedAt),
            })),
          ]
          : []),
        { separator: true },
        { label: `Все смены ${shift.username}`, onSelect: () => navigate(personPath(shift.userId, location.search, "shifts")) },
      ];

  return (
    <div className="review-stepper" role="group" aria-label="Смены" onMouseEnter={() => setWanted(true)}>
      {arrow(shift.previousAt, "previous")}
      <Menu
        label="Другая смена"
        items={items}
        align="end"
        renderTrigger={({ ref, onClick, ...trigger }) => (
          <button
            ref={ref}
            type="button"
            className="review-stepper__pick"
            onMouseEnter={() => setWanted(true)}
            onFocus={() => setWanted(true)}
            onClick={() => {
              setWanted(true);
              onClick();
            }}
            {...trigger}
          >
            Другая смена
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      />
      {arrow(shift.nextAt, "next")}
    </div>
  );
}
