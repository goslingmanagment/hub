import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Menu, Tooltip, type MenuEntry } from "@agency_hub_core/ui";
import { formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { personPath, shiftPath, useBackState } from "@/shared/links";
import { prefetchReview, useShiftsAround, type ReviewShift } from "./data.js";

/**
 * ← the chatter's previous shift · «Другая смена» · next shift → (spec §4.2).
 * A neighbour is read when the pointer or the focus reaches its arrow, not on
 * every open. «Другая смена» lists the chatter's shifts of the week around this
 * one and the others' that overlapped it, each with its one label (D12: «вс,
 * 1–2 нояб. 21:00–05:49») and the time worked; it reads them once opened or
 * hovered. Its last item opens the chatter's card, with «← Разбор» back here.
 */

/** A menu line longer than this leaves no room for the time worked beside it (the menu is 360 px at most). */
const LONG_LABEL = 28;

export function ShiftStepper({ shift }: { shift: ReviewShift }) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [wanted, setWanted] = useState(false);
  const around = useShiftsAround(shift.startedAt, wanted);
  // The way back stays where the review was entered from; the period, the list and the page filter go along.
  const state = location.state as unknown;
  // The card's «←» comes back to this review, which keeps its own «←» behind it (D16).
  const backHere = useBackState("Разбор");
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
        ...own.map((one): MenuEntry => {
          const label = shiftWhen(one);
          return {
            label: label.label,
            // A night over a month's end («сб, 31 окт. – 1 нояб. 21:24–05:31») takes the whole width: no room for its length.
            hint: label.label.length > LONG_LABEL ? undefined : label.worked ?? undefined,
            checked: Date.parse(one.startedAt) === start,
            onSelect: () => go(one.userId, one.startedAt),
          };
        }),
        ...(together.length > 0
          ? [
            { separator: true } as const,
            { group: "В это же время работали" },
            ...together.map((one): MenuEntry => {
              const label = shiftWhen(one);
              // Their shifts overlap this one: the clock says enough.
              return {
                label: `${one.username} · ${label.time}`,
                hint: label.worked ?? undefined,
                onSelect: () => go(one.userId, one.startedAt),
              };
            }),
          ]
          : []),
        { separator: true },
        {
          label: `Карточка ${shift.username}`,
          hint: "все смены недели",
          onSelect: () => navigate(personPath(shift.userId, location.search), { state: backHere }),
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
