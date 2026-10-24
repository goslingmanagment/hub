import { useState, type ReactNode } from "react";
import type { AccountShiftReportResponse, ShiftReportSale } from "@agency_hub_core/contracts";
import { millsFromDollars } from "@agency_hub_core/shared";
import { useConfirmShiftReport, useMarkShiftSale, useMyShiftReport } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { formatDateTime, formatMills } from "@/lib/format";

// Chat Memory week 4 (week-4.md §2): the draft shift report in the cabinet.
// Hub lists the sales of the chatter's shifts and the facts of each; the
// chatter marks them and confirms. Hub credits no sale by itself.

type Shift = AccountShiftReportResponse["shifts"][number];
type Teammate = AccountShiftReportResponse["teammates"][number];

const KIND_LABELS: Readonly<Record<string, string>> = {
  subscription: "Подписка",
  tip: "Чаевые",
  message_purchase: "PPV",
  post_purchase: "Пост",
  stream_tip: "Стрим",
};
const MARK_LABELS: Readonly<Record<string, string>> = { mine: "моё", share: "делим", not_mine: "не моё" };

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
}

/** «PPV отправил vanya · писали за 48 ч: nikita 40, vanya 3 · без автора 2». */
export function factsLine(sale: ShiftReportSale): string {
  const parts: string[] = [];
  if (sale.ppvSender !== null) parts.push(`PPV отправил ${sale.ppvSender}`);
  else if (sale.ppvWithoutAuthor) parts.push("PPV отправлен без автора");
  if (sale.writers.length > 0) parts.push(`писали за 48 ч: ${sale.writers.map((writer) => `${writer.username} ${writer.messages}`).join(", ")}`);
  if (sale.withoutAuthor > 0) parts.push(`без автора ${sale.withoutAuthor}`);
  return parts.length === 0 ? "За 48 ч фану никто не писал из расширения" : parts.join(" · ");
}

function problemOf(error: unknown): string {
  if (error instanceof KernelApiError) {
    const reason = (error.body as { reason?: string } | undefined)?.reason;
    if (reason === "confirmed") return "Отчёт этой смены уже подтверждён.";
    if (reason === "unmarked") return "Сначала отметь все продажи.";
    if (reason === "ongoing") return "Смена ещё идёт — подтвердить можно после неё.";
  }
  return "Не получилось. Обнови страницу и попробуй ещё раз.";
}

function MarkButton({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs ${active ? "border-accent bg-accent/15 text-text-primary" : "border-border text-text-secondary"} disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

function SaleRow({ sale, locked, teammates }: { sale: ShiftReportSale; locked: boolean; teammates: readonly Teammate[] }) {
  const markSale = useMarkShiftSale();
  const [amount, setAmount] = useState(sale.myMark?.amountMills === null || sale.myMark === null ? "" : (sale.myMark.amountMills / 1000).toFixed(2));
  const current = sale.myMark;
  const busy = locked || markSale.isPending;
  const send = (mark: "mine" | "share" | "not_mine", shareWithUserId?: number, amountMills?: number | null) => markSale.mutate({
    saleRef: sale.saleRef,
    mark,
    ...(shareWithUserId === undefined ? {} : { shareWithUserId }),
    amountMills: amountMills === undefined ? current?.amountMills ?? null : amountMills,
  });
  const saveAmount = () => {
    if (current === null) return;
    let value: number | null = null;
    try {
      value = amount.trim() === "" ? null : Number(millsFromDollars(amount.trim().replace(",", ".")));
    } catch {
      return;
    }
    if (value !== null && value < 0) return;
    if (value === current.amountMills) return;
    send(current.mark as "mine" | "share" | "not_mine", current.shareWithUserId ?? undefined, value);
  };
  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-text-primary">
          <span className="text-text-muted">{timeOf(sale.occurredAt)}</span> · {sale.pageLabel} · {KIND_LABELS[sale.kind] ?? sale.kind}
          {sale.fanName && <> · {sale.fanName}</>}
        </p>
        <p className="text-sm font-semibold text-text-primary">{formatMills(sale.netMills)}</p>
      </div>
      <p className="mt-1 text-xs text-text-secondary">{factsLine(sale)}</p>
      {sale.otherMarks.length > 0 && (
        <p className="mt-1 text-xs text-text-muted">
          {sale.otherMarks.map((other) => `${other.username}: ${MARK_LABELS[other.mark] ?? other.mark}${other.shareWith ? ` с ${other.shareWith}` : ""}`).join(" · ")}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <MarkButton active={current?.mark === "mine"} disabled={busy} onClick={() => send("mine")}>Моё</MarkButton>
        <select
          aria-label="Делим с"
          disabled={busy || teammates.length === 0}
          value={current?.mark === "share" ? String(current.shareWithUserId) : ""}
          onChange={(event) => event.target.value !== "" && send("share", Number(event.target.value))}
          className={`rounded-md border bg-card px-2 py-1 text-xs ${current?.mark === "share" ? "border-accent text-text-primary" : "border-border text-text-secondary"} disabled:opacity-50`}
        >
          <option value="">Делим с…</option>
          {teammates.map((teammate) => <option key={teammate.userId} value={teammate.userId}>{teammate.username}</option>)}
        </select>
        <MarkButton active={current?.mark === "not_mine"} disabled={busy} onClick={() => send("not_mine")}>Не моё</MarkButton>
        {current !== null && current.mark !== "not_mine" && (
          <label className="flex items-center gap-1 text-xs text-text-muted">
            своя сумма $
            <input
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(event) => setAmount(event.target.value)}
              onBlur={saveAmount}
              placeholder={(sale.netMills / 1000).toFixed(2)}
              className="w-20 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-text-primary"
            />
          </label>
        )}
      </div>
      {markSale.isError && <p role="alert" className="mt-1 text-xs text-danger">{problemOf(markSale.error)}</p>}
    </li>
  );
}

function ShiftCard({ shift, teammates }: { shift: Shift; teammates: readonly Teammate[] }) {
  const confirm = useConfirmShiftReport();
  const locked = shift.confirmedAt !== null;
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            {formatDateTime(shift.startedAt)} – {shift.ongoing ? "идёт" : timeOf(shift.endedAt)} · {shift.pages.join(", ")}
          </p>
          <p className="text-xs text-text-muted">
            К зачёту {formatMills(shift.creditedMills)}
            {shift.unmarked > 0 && ` · без отметки ${shift.unmarked}`}
            {locked && ` · подтверждён ${formatDateTime(shift.confirmedAt!)}`}
          </p>
        </div>
        {!locked && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={shift.ongoing || shift.unmarked > 0 || confirm.isPending}
            onClick={() => confirm.mutate(shift.startedAt)}
          >
            Подтвердить отчёт
          </button>
        )}
      </div>
      {confirm.isError && <p role="alert" className="mt-1 text-xs text-danger">{problemOf(confirm.error)}</p>}
      {shift.sales.length === 0
        ? <p className="mt-3 text-sm text-text-muted">Продаж за смену не было.</p>
        : <ul className="mt-2">{shift.sales.map((sale) => <SaleRow key={sale.saleRef} sale={sale} locked={locked} teammates={teammates} />)}</ul>}
    </div>
  );
}

export function ShiftReport({ section }: { section: (title: string, children: ReactNode) => ReactNode }) {
  const report = useMyShiftReport();
  const title = "Отчёт смены";
  if (report.isLoading) return section(title, <p role="status" className="text-sm text-text-muted">Собираем смены…</p>);
  if (report.isError || !report.data) return section(title, <p role="alert" className="text-sm text-danger">Не удалось загрузить смены. Обнови страницу.</p>);
  const { shifts, sharedWithMe, teammates, sharePercent } = report.data;
  return section(title, (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">
        Продажи на твоих страницах за твои смены (по расширению) и факты по каждой. Отметь каждую: «моё», «делим с…» или
        «не моё», если нужно — поправь сумму, и подтверди отчёт. Хаб сам продажу никому не засчитывает. «Делим» — {sharePercent}% тебе.
      </p>
      {sharedWithMe.length > 0 && (
        <div className="rounded-lg border border-accent/40 px-4 py-3">
          <p className="text-sm font-semibold text-text-primary">С тобой делят</p>
          <ul className="mt-1">{sharedWithMe.map((sale) => <SaleRow key={sale.saleRef} sale={sale} locked={false} teammates={teammates} />)}</ul>
        </div>
      )}
      {shifts.length === 0
        ? <p className="text-sm text-text-muted">За неделю смен нет: смена считается, пока открыто расширение под твоим входом.</p>
        : shifts.map((shift) => <ShiftCard key={shift.startedAt} shift={shift} teammates={teammates} />)}
    </div>
  ));
}
