import { useState, type ReactNode } from "react";
import { useIsMutating } from "@tanstack/react-query";
import type { AccountShiftReportResponse, ShiftReportSale } from "@agency_hub_core/contracts";
import { SHIFT_REPORT_MAX_DAYS } from "@agency_hub_core/contracts";
import { millsFromDollars } from "@agency_hub_core/shared";
import { SHIFT_MARK_MUTATION_KEY } from "@/api/account";
import { useConfirmShiftReport, useMarkShiftSale, useMyShiftReport } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Disclosure } from "@/components/ui/Disclosure";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDateTime, formatMills, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

// The draft shift report in the cabinet. Hub lists the sales of the chatter's
// shifts and the facts of each; the chatter marks them and confirms. Hub
// credits no sale by itself. Each shift is a sheet of its own on the page.

type Shift = AccountShiftReportResponse["shifts"][number];
type Teammate = AccountShiftReportResponse["teammates"][number];

const KIND_LABELS: Readonly<Record<string, string>> = {
  subscription: "Подписка",
  tip: "Чаевые",
  message_purchase: "Платное",
  post_purchase: "Пост",
  stream_tip: "Чаевые в эфире",
};
const MARK_LABELS: Readonly<Record<string, string>> = { mine: "моё", share: "делим", not_mine: "не моё" };

/** «Платное отправил vanya · писали за 48 ч: nikita 40, vanya 3 · без автора 2». */
export function factsLine(sale: ShiftReportSale): string {
  const parts: string[] = [];
  if (sale.ppvSender !== null) parts.push(`Платное отправил ${sale.ppvSender}`);
  else if (sale.ppvWithoutAuthor) parts.push("Платное отправлено без автора");
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
    if (reason === "amount_above_net") return "Своя сумма не может быть больше суммы продажи.";
  }
  return "Не получилось. Обнови страницу и попробуй ещё раз.";
}

/** «2 нояб., 19:13 – 03:24», Moscow both; a shift going on ends «сейчас». */
function shiftWhen(shift: Pick<Shift, "startedAt" | "endedAt" | "ongoing">): string {
  return `${formatDateTime(shift.startedAt)} – ${shift.ongoing ? "сейчас" : formatTimeOfDay(shift.endedAt)}`;
}

/** Ended, and something in it waits for the chatter's confirmation. */
export function waitsForConfirmation(shift: Pick<Shift, "ongoing" | "confirmedAt" | "pending">): boolean {
  return !shift.ongoing && (shift.confirmedAt === null || shift.pending > 0);
}

function MarkButton({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={active} className={`btn btn-sm sr-mark ${active ? "team-picked" : ""}`}>
      {children}
    </button>
  );
}

function SaleRow({ sale, locked, teammates }: { sale: ShiftReportSale; locked: boolean; teammates: readonly Teammate[] }) {
  const markSale = useMarkShiftSale();
  const [amount, setAmount] = useState(sale.myMark?.amountMills === null || sale.myMark === null ? "" : (sale.myMark.amountMills / 1000).toFixed(2));
  const current = sale.myMark;
  const busy = locked || sale.confirmed || markSale.isPending;
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
    send("mine", undefined, value);
  };
  return (
    <li className="sr-sale">
      <div className="sr-sale-head">
        <p>
          <span className="tabular-nums">{formatTimeOfDay(sale.occurredAt)}</span> · {sale.pageLabel} · {KIND_LABELS[sale.kind] ?? sale.kind}
          {sale.fanName && <> · {sale.fanName}</>}
        </p>
        <p className="sr-sale-money">{formatMills(sale.netMills)}</p>
      </div>
      <p className="sr-sale-facts">{factsLine(sale)}</p>
      {sale.otherMarks.length > 0 && (
        <p className="sr-sale-facts">
          {sale.otherMarks.map((other) => `${other.username}: ${MARK_LABELS[other.mark] ?? other.mark}${other.shareWith ? ` с ${other.shareWith}` : ""}`).join(" · ")}
        </p>
      )}
      <div className="sr-sale-marks">
        <MarkButton active={current?.mark === "mine"} disabled={busy} onClick={() => send("mine")}>Моё</MarkButton>
        <select
          aria-label="Делим с"
          disabled={busy || teammates.length === 0}
          value={current?.mark === "share" ? String(current.shareWithUserId) : ""}
          onChange={(event) => event.target.value !== "" && send("share", Number(event.target.value))}
          className={`select sr-share ${current?.mark === "share" ? "team-picked" : ""}`}
        >
          <option value="">Делим с…</option>
          {teammates.map((teammate) => <option key={teammate.userId} value={teammate.userId}>{teammate.username}</option>)}
        </select>
        <MarkButton active={current?.mark === "not_mine"} disabled={busy} onClick={() => send("not_mine")}>Не моё</MarkButton>
        {current !== null && current.mark === "mine" && (
          <label className="sr-amount">
            своя сумма, $
            <input
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(event) => setAmount(event.target.value)}
              onBlur={saveAmount}
              placeholder={(sale.netMills / 1000).toFixed(2)}
              className="input"
            />
          </label>
        )}
      </div>
      {markSale.isError && <p role="alert" className="field-error">{problemOf(markSale.error)}</p>}
    </li>
  );
}

/** The question before a report locks: the shift, its pages, what it pays, that it cannot be undone. */
function ConfirmShift({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const confirm = useConfirmShiftReport();
  const again = shift.confirmedAt !== null;
  const close = () => {
    confirm.reset();
    onClose();
  };
  return (
    <ConfirmModal
      title={again ? "Подтвердить новые продажи?" : "Подтвердить отчёт смены?"}
      message="Отметки запрутся, продажи уйдут в выгрузку для выплат."
      facts={[
        { label: "Смена", value: shiftWhen(shift) },
        { label: "Страницы", value: shift.pages.join(", ") },
        { label: "К выплате", value: formatMills(shift.creditedMills) },
        { label: "Продаж", value: String(again ? shift.pending : shift.sales.length) },
        { label: "Отменить", value: "Нельзя: подтверждение окончательное" },
      ]}
      confirmLabel={again ? "Подтвердить новые продажи" : "Подтвердить отчёт"}
      pendingLabel="Подтверждаем…"
      tone="primary"
      initialFocus="cancel"
      error={confirm.isError ? problemOf(confirm.error) : undefined}
      isPending={confirm.isPending}
      onConfirm={() => confirm.mutate(shift.startedAt, { onSuccess: close })}
      onClose={close}
    />
  );
}

function ShiftSheet({ shift, teammates }: { shift: Shift; teammates: readonly Teammate[] }) {
  // A mark still saving (the amount saves on blur) is not in the report yet: confirm after it.
  const marking = useIsMutating({ mutationKey: SHIFT_MARK_MUTATION_KEY }) > 0;
  const [asking, setAsking] = useState(false);
  const confirmed = shift.confirmedAt !== null;
  const canConfirm = !confirmed || shift.pending > 0;
  const why = shift.ongoing
    ? "Смена ещё идёт"
    : shift.unmarked > 0
      ? `Сначала отметь все продажи: ${ruPlural(shift.unmarked, "осталась", "остались", "осталось")} ${shift.unmarked}`
      : marking ? "Сохраняем отметку…" : null;
  return (
    <section className="card sr-shift">
      <header className="sr-shift-head">
        <div className="min-w-0">
          <h3 className="card-title">
            {shift.visit && "Вне смены, "}{shiftWhen(shift)} · {shift.pages.join(", ")}
          </h3>
          <p className="sr-shift-facts">
            {confirmed ? (
              <>
                <span>Подтверждено к выплате: <b>{formatMills(shift.creditedMills)}</b></span>
                <span>Подтверждён {formatDateTime(shift.confirmedAt!)}</span>
                {shift.pending > 0 && <span>Новых продаж после подтверждения: {shift.pending}</span>}
              </>
            ) : (
              <>
                <span>К выплате, если подтвердишь: <b>{formatMills(shift.creditedMills)}</b></span>
                {shift.unmarked > 0 && <span>Не отмечено: {shift.unmarked}</span>}
              </>
            )}
          </p>
        </div>
        {canConfirm && (
          <div className="sr-shift-action">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={shift.ongoing || shift.unmarked > 0 || marking}
              onClick={() => setAsking(true)}
            >
              {confirmed ? "Подтвердить новые продажи" : "Подтвердить отчёт"}
            </button>
            {why && <span className="sr-why">{why}</span>}
          </div>
        )}
      </header>
      {shift.sales.length === 0
        ? <p className="sr-none">Продаж за смену не было.</p>
        : <ul className="sr-sales">{shift.sales.map((sale) => <SaleRow key={sale.saleRef} sale={sale} locked={false} teammates={teammates} />)}</ul>}
      {asking && <ConfirmShift shift={shift} onClose={() => setAsking(false)} />}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sr-group" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

export function ShiftReport() {
  const report = useMyShiftReport();
  const head = (
    <header className="sr-head">
      <h1 className="cs-greeting">Отчёт смены</h1>
      <p className="sr-lead">Отметь каждую продажу и подтверди отчёт: от этого зависит выплата.</p>
    </header>
  );
  const help = (
    <Disclosure>
      <p>
        Продажи на твоих страницах за твои смены (по расширению) и работа вне смен, где были продажи, и факты по каждой.
        Отметь каждую: «моё», «делим с…» или «не моё», если нужно — поправь сумму «моё» (не больше суммы продажи), и
        подтверди отчёт. Hub сам продажу никому не засчитывает. «Делим» — пополам, если коллега отметил «делим» с тобой;
        иначе это спор, его решает владелец.
      </p>
      <p>Подтвердить можно {SHIFT_REPORT_MAX_DAYS} дней.</p>
    </Disclosure>
  );
  if (report.isLoading) {
    return (
      <div className="sr-page" aria-busy="true">
        {head}
        <section className="card sr-shift" aria-hidden="true">
          <Skeleton width="45%" />
          <div className="mt-3"><Skeleton width="30%" /></div>
          <div className="mt-6"><Skeleton width="80%" /></div>
          <div className="mt-3"><Skeleton width="70%" /></div>
        </section>
      </div>
    );
  }
  if (report.isError || !report.data) {
    return (
      <div className="sr-page">
        {head}
        <div className="status-panel empty" role="alert">
          <p className="empty-title">Не удалось загрузить смены.</p>
          <div className="empty-actions">
            <button type="button" className="btn btn-sm" disabled={report.isFetching} onClick={() => void report.refetch()}>Повторить</button>
          </div>
        </div>
      </div>
    );
  }
  const { shifts, sharedWithMe, teammates } = report.data;
  const waiting = shifts.filter(waitsForConfirmation);
  const going = shifts.filter((shift) => shift.ongoing);
  const done = shifts.filter((shift) => !shift.ongoing && !waitsForConfirmation(shift));
  return (
    <div className="sr-page">
      {head}
      {sharedWithMe.length > 0 && (
        <Group title="С тобой делят">
          <section className="card sr-shift">
            <ul className="sr-sales">{sharedWithMe.map((sale) => <SaleRow key={sale.saleRef} sale={sale} locked={false} teammates={teammates} />)}</ul>
          </section>
        </Group>
      )}
      {shifts.length === 0 && (
        <div className="status-panel empty">
          <p className="empty-title">За {SHIFT_REPORT_MAX_DAYS} дней смен нет</p>
          <p className="empty-text">Смена считается по работе в расширении под твоим входом.</p>
        </div>
      )}
      {waiting.length > 0 && (
        <Group title="Ждут подтверждения">
          {waiting.map((shift) => <ShiftSheet key={shift.startedAt} shift={shift} teammates={teammates} />)}
        </Group>
      )}
      {going.length > 0 && (
        <Group title="Смена идёт">
          {going.map((shift) => <ShiftSheet key={shift.startedAt} shift={shift} teammates={teammates} />)}
        </Group>
      )}
      {done.length > 0 && (
        <details className="help sr-done">
          <summary>Подтверждённые ({done.length})</summary>
          <div className="sr-group">
            {done.map((shift) => <ShiftSheet key={shift.startedAt} shift={shift} teammates={teammates} />)}
          </div>
        </details>
      )}
      {help}
    </div>
  );
}
