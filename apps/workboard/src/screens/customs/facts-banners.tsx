import { useEffect, useRef, useState } from "react";
import {
  CUSTOM_FINDING_DISMISS_REASONS,
  type CustomBoardOrder, type CustomFinding, type CustomOrderActionBody, type CustomOrdersBoardResponse, type CustomSelfChange, type CustomUndo,
} from "@agency_hub_core/contracts";
import {
  Button, Confirm, cx, Disclosure, Field, Menu, Modal, Money, Notice, Select, Skeleton, StatusDot, Textarea, TextInput, toast,
} from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import { moscowDayOf } from "@agency_hub_core/ui/moscow";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { usePages } from "@/shared/usePages";
import { stepFailure, useAnyCustomStep, useCustomChanges, useCustomFindings, useFindingAct } from "./data";
import { changeActor, changeWords, dollarsOf, dotted, millsOfDollars } from "./facts-words";

/**
 * The facts screen's two folded blocks (customs facts spec §8, §10): «Найдено без заказа» — the traces of a custom with no
 * order, each recorded, linked to an order there is or dismissed with a reason; «За сутки изменилось само» — what the
 * system and the agents did on the viewer's orders, with «Отменить» where the viewer may take it back. Each list is read
 * when its block is opened.
 */

const SOURCE_WORDS: Record<CustomFinding["source"], string> = {
  sale: "из продаж", fan_chat: "из переписки", work_chat: "из рабочего чата", model_group: "из группы модели", shift_report: "из отчёта смены",
};
const DISMISS_WORDS: Record<(typeof CUSTOM_FINDING_DISMISS_REASONS)[number], string> = {
  not_custom: "Не кастом", sexting: "Выбрал секстинг", unused: "Не воспользовался", duplicate: "Дубль", test: "Тест", not_asked: "Кастом не просил",
};

const findingFan = (finding: CustomFinding) => finding.fan?.username ?? finding.fan?.displayName ?? "фан не известен";

/** «Записать заказ» from a finding: the board's form, its page and fan from the finding (or given here). */
function RecordFindingModal({ finding, onDone, onClose }: { finding: CustomFinding; onDone: (code: string | null) => void; onClose: () => void }) {
  const act = useFindingAct();
  const pages = usePages({ enabled: finding.pageLabel === null });
  const [task, setTask] = useState("");
  // The finding's sum as it came, to the cent: never rounded.
  const [price, setPrice] = useState(finding.amountMills !== null ? `${dollarsOf(finding.amountMills)}$` : "");
  const [amount, setAmount] = useState(finding.amountMills !== null ? dollarsOf(finding.amountMills) : "");
  const [pageLabel, setPageLabel] = useState(finding.pageLabel ?? "");
  const [fan, setFan] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const priceMills = millsOfDollars(amount);
  const ready = task.trim() !== "" && pageLabel !== "" && priceMills !== undefined;
  const submit = () => {
    if (!ready || act.isPending) return;
    act.mutate({
      findingId: finding.id,
      body: {
        action: "record",
        card: { task: task.trim(), ...(price.trim() ? { price: price.trim() } : {}) },
        ...(priceMills !== null && priceMills !== undefined ? { priceMills } : {}),
        ...(finding.pageLabel === null ? { pageLabel } : {}),
        ...(finding.fan === null && fan.trim() ? { fan: fan.trim() } : {}),
      },
    }, {
      onSuccess: (answer) => {
        toast.success(answer.finding.orderCode ? `Записан ${answer.finding.orderCode}` : "Записан");
        onDone(answer.finding.orderCode);
      },
      onError: (error) => setFailure(stepFailure(error)),
    });
  };
  return (
    <Modal
      title="Записать заказ"
      onClose={onClose}
      explicitCloseOnly={act.isPending || task !== ""}
      actions={(
        <>
          <Button onClick={onClose} disabled={act.isPending}>Отмена</Button>
          <Button variant="primary" loading={act.isPending} disabled={!ready} onClick={submit}>Записать</Button>
        </>
      )}
    >
      <div className="cf-form">
        <p className="cf-muted">
          {findingFan(finding)}{finding.pageLabel ? `, ${finding.pageLabel}` : ""}{finding.quote ? `: «${finding.quote}»` : ""}
          {finding.source === "sale" && " Продажа станет оплатой заказа."}
        </p>
        {finding.pageLabel === null && (
          <Field label="Страница">{(control) => (
            <Select {...control} value={pageLabel} onChange={(event) => setPageLabel(event.target.value)}>
              <option value="">Выберите страницу</option>
              {(pages.data ?? []).map((one) => <option key={one.label} value={one.label}>{one.label}</option>)}
            </Select>
          )}</Field>
        )}
        {finding.fan === null && (
          <Field label="Фан" hint="Ссылка на профиль, ник или номер">{(control) => <TextInput {...control} value={fan} onChange={(event) => setFan(event.target.value)} />}</Field>
        )}
        <Field label="Что снять">{(control) => <Textarea {...control} rows={4} value={task} onChange={(event) => setTask(event.target.value)} />}</Field>
        <Field label="Цена, как договорились" hint="Например: 100$ тир Master + 50$">{(control) => <TextInput {...control} value={price} onChange={(event) => setPrice(event.target.value)} />}</Field>
        <PriceField value={amount} onChange={setAmount} />
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Modal>
  );
}

/**
 * «Сумма заказа»: the agreed total in dollars, what «оплачен» is measured by (the sales linked reach it); empty — not
 * named. A text that is no sum says so.
 */
export function PriceField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const bad = millsOfDollars(value) === undefined;
  return (
    <Field label="Сумма заказа, $" hint="Вся договорённая сумма: по ней Hub видит, оплачен ли заказ." {...(bad ? { error: "Сумма в долларах, например 120 или 49.50" } : {})}>
      {(control) => <TextInput {...control} inputMode="decimal" placeholder="120" value={value} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );
}

/** «Это уже есть»: the finding belongs to an order on the board (its page's first), or one named by its code. */
function LinkFindingModal({ finding, orders, onClose }: { finding: CustomFinding; orders: readonly CustomBoardOrder[]; onClose: () => void }) {
  const act = useFindingAct();
  const candidates = [...orders].sort((left, right) => Number(right.pageLabel === finding.pageLabel) - Number(left.pageLabel === finding.pageLabel) || right.id - left.id);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const submit = () => {
    if (code.trim() === "" || act.isPending) return;
    act.mutate({ findingId: finding.id, body: { action: "link", code: code.trim() } }, {
      onSuccess: (answer) => {
        toast.success(`Привязано к ${answer.finding.orderCode ?? code.trim()}`);
        onClose();
      },
      onError: (error) => setFailure(stepFailure(error)),
    });
  };
  return (
    <Modal
      title="Это уже есть"
      onClose={onClose}
      actions={(
        <>
          <Button onClick={onClose} disabled={act.isPending}>Отмена</Button>
          <Button variant="primary" loading={act.isPending} disabled={code.trim() === ""} onClick={submit}>Привязать</Button>
        </>
      )}
    >
      <div className="cf-form">
        <p className="cf-muted">{finding.source === "sale" ? "Продажа станет оплатой этого заказа." : "Находка закроется: заказ уже есть."}</p>
        <Field label="Заказ">{(control) => (
          <Select {...control} value={code} onChange={(event) => setCode(event.target.value)}>
            <option value="">Выберите заказ</option>
            {candidates.map((order) => (
              <option key={order.id} value={order.code}>
                {order.code} · {order.fan?.username ?? order.fan?.displayName ?? order.buyer ?? "фан не назван"}{order.pageLabel ? ` · ${order.pageLabel}` : ""}
              </option>
            ))}
          </Select>
        )}</Field>
        <Field label="Или код заказа" hint="K-123">{(control) => <TextInput {...control} value={code} onChange={(event) => setCode(event.target.value)} />}</Field>
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Modal>
  );
}

/** A finding's fan, page, source and day, then its words and its sum: one line of the block. */
function FindingFacts({ finding }: { finding: CustomFinding }) {
  return (
    <>
      <span className="cf-find__fan">
        <b>{findingFan(finding)}</b>
        <small>{[finding.pageLabel, SOURCE_WORDS[finding.source], dotted(moscowDayOf(finding.happenedAt))].filter(Boolean).join(", ")}</small>
      </span>
      <span className="cf-find__why">{finding.quote ? `«${finding.quote}»` : <span className="cf-muted">без слов</span>}</span>
      <span className="cf-find__amount">{finding.amountMills !== null ? <Money mills={finding.amountMills} /> : null}</span>
    </>
  );
}

function FindingRow({ finding, narrow, orders, focused, onOpenOrder }: {
  finding: CustomFinding; narrow: boolean; orders: readonly CustomBoardOrder[]; focused: boolean; onOpenOrder: (code: string) => void;
}) {
  const act = useFindingAct();
  const [recording, setRecording] = useState(false);
  const [linking, setLinking] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  // The matter «Кастом без заказа» opens the board on its finding (`?finding=<id>`): it is brought into view.
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const dismiss = (reason: (typeof CUSTOM_FINDING_DISMISS_REASONS)[number]) => act.mutate({ findingId: finding.id, body: { action: "dismiss", reason } }, {
    onSuccess: () => toast.success(`${findingFan(finding)}: ${DISMISS_WORDS[reason].toLowerCase()}`),
    onError: (error) => toast.error(stepFailure(error)),
  });
  return (
    <li ref={row} className={cx("cf-find", focused && "cf-find--focus")}>
      <FindingFacts finding={finding} />
      {!narrow && (
        <span className="cf-find__acts">
          <Button size="sm" onClick={() => setRecording(true)}>Записать заказ</Button>
          <Button size="sm" variant="ghost" onClick={() => setLinking(true)}>Это уже есть</Button>
          <Menu
            label="Не кастом"
            trigger="button"
            size="sm"
            align="end"
            items={CUSTOM_FINDING_DISMISS_REASONS.map((reason) => ({ label: DISMISS_WORDS[reason], onSelect: () => dismiss(reason) }))}
          />
        </span>
      )}
      {recording && (
        <RecordFindingModal
          finding={finding}
          onClose={() => setRecording(false)}
          onDone={(code) => {
            setRecording(false);
            if (code !== null) onOpenOrder(code);
          }}
        />
      )}
      {linking && <LinkFindingModal finding={finding} orders={orders} onClose={() => setLinking(false)} />}
    </li>
  );
}

/** A finding the agent dismissed as «не кастом»: who did, and «Вернуть» — open again, for a person to decide. */
function DismissedRow({ finding, narrow }: { finding: CustomFinding; narrow: boolean }) {
  const act = useFindingAct();
  const reopen = () => act.mutate({ findingId: finding.id, body: { action: "reopen" } }, {
    onSuccess: () => toast.success(`${findingFan(finding)}: снова в «Найдено без заказа»`),
    onError: (error) => toast.error(stepFailure(error)),
  });
  return (
    <li className="cf-find">
      <FindingFacts finding={finding} />
      <span className="cf-find__acts">
        <span className="cf-tag">{finding.resolvedByAgent ?? "агент"}: не кастом</span>
        {!narrow && <Button size="sm" variant="ghost" loading={act.isPending} onClick={reopen}>Вернуть</Button>}
      </span>
    </li>
  );
}

/**
 * «Найдено без заказа: N», folded: what came, whose; opened, every finding with its three answers, and — folded under
 * them — «Отклонено агентом»: what the reader dismissed as «не кастом» in two weeks, each with «Вернуть». `focus` — the
 * finding a matter opened the board on: the block opens on it.
 */
export function FindingsBanner({ summary, narrow, orders, defaultOpen = false, focus = null, onOpenOrder }: {
  summary: CustomOrdersBoardResponse["findings"];
  narrow: boolean;
  orders: readonly CustomBoardOrder[];
  defaultOpen?: boolean;
  focus?: number | null;
  onOpenOrder: (code: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen || focus !== null);
  const list = useCustomFindings(open);
  if (summary.open === 0 && summary.agentDismissed === 0) return null;
  const more = summary.open - summary.fans.length;
  const dismissed = list.data?.dismissedByAgent ?? [];
  return (
    <details className={cx("cf-banner", summary.open > 0 && "cf-banner--warn")} open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cf-banner__head">
        <span className="cf-banner__title">{summary.open > 0 && <StatusDot tone="warning" />}Найдено без заказа: {summary.open}</span>
        <span className="cf-banner__sum">
          {summary.open === 0 ? `агент отклонил за две недели: ${summary.agentDismissed}`
            : summary.amountMills > 0 ? <>фаны заплатили <Money mills={summary.amountMills} />, а заказа нет</> : "заказа нет ни в Hub, ни в чатах"}
        </span>
        {!open && summary.fans.length > 0 && <span className="cf-banner__who">{summary.fans.join(", ")}{more > 0 ? ` и ещё ${more}` : ""}</span>}
        <span className="cf-banner__toggle">{open ? "Свернуть" : "Показать"}</span>
      </summary>
      {open && (
        <div className="cf-banner__body">
          {list.isPending ? <Skeleton height={96} /> : list.isError || !list.data ? <p className="cf-muted">Находки не загрузились: Hub не ответил.</p> : (
            <>
              {list.data.findings.length === 0 ? <p className="cf-muted">Все находки разобраны.</p> : (
                <ul className="cf-banner__items">
                  {list.data.findings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} narrow={narrow} orders={orders} focused={finding.id === focus} onOpenOrder={onOpenOrder} />
                  ))}
                </ul>
              )}
              {dismissed.length > 0 && (
                <Disclosure size="md" summary={`Отклонено агентом: ${dismissed.length}`} hint="читатель решил «не кастом»; если это кастом — верните, и находка снова ждёт решения">
                  <ul className="cf-banner__items">{dismissed.map((finding) => <DismissedRow key={finding.id} finding={finding} narrow={narrow} />)}</ul>
                </Disclosure>
              )}
            </>
          )}
          {narrow && <PasswordWayIn text="Чтобы записать заказ или отметить «не кастом», войдите на сайте с паролем." />}
        </div>
      )}
    </details>
  );
}

/** The board's step that takes a self-change back, with the event it undoes. */
export function undoBody(undo: CustomUndo, undoOf: number, reason: string): CustomOrderActionBody {
  switch (undo.action) {
    case "unpay": return { action: "unpay", transactionRef: undo.transactionRef, undoOf };
    case "ungive": return { action: "ungive", undoOf, messageRef: undo.messageRef };
    case "retract": return { action: "retract", retracts: undo.retracts, reason, undoOf };
    case "deadline": return { action: "deadline", deadlineOn: undo.deadlineOn, undoOf };
  }
}

const UNDO_WORDS: Record<CustomUndo["action"], { title: string; message: string; confirm: string }> = {
  unpay: { title: "Убрать оплату с заказа?", message: "Продажа перестанет оплачивать заказ, и Hub больше не привяжет её сам.", confirm: "Убрать оплату" },
  ungive: { title: "Отменить «отдан»?", message: "Заказ снова «снят»; это сообщение Hub больше не засчитает сам.", confirm: "Отменить «отдан»" },
  retract: { title: "Отозвать сдачу?", message: "Сдача перестанет считаться.", confirm: "Отозвать" },
  deadline: { title: "Вернуть срок?", message: "Срок станет прежним.", confirm: "Вернуть срок" },
};

/** «Отменить» of one step the system or an agent took: a question first (a delivery: with its reason). */
export function UndoButton({ code, undo, undoOf, label = "Отменить" }: { code: string; undo: CustomUndo; undoOf: number; label?: string }) {
  const step = useAnyCustomStep();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const words = UNDO_WORDS[undo.action];
  const run = () => step.mutate({ code, body: undoBody(undo, undoOf, reason.trim()) }, {
    onSuccess: () => {
      toast.success(`${code}: отменено`);
      setAsking(false);
    },
    onError: (error) => setFailure(stepFailure(error)),
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setFailure(null); setAsking(true); }}>{label}</Button>
      {asking && undo.action !== "retract" && (
        <Confirm
          title={words.title}
          message={undo.action === "deadline" ? `Срок станет ${undo.deadlineOn ? `до ${dotted(undo.deadlineOn)}` : "не назван"}.` : words.message}
          confirmLabel={words.confirm}
          tone="primary"
          isPending={step.isPending}
          error={failure}
          onConfirm={run}
          onClose={() => setAsking(false)}
        />
      )}
      {asking && undo.action === "retract" && (
        <Modal
          title={words.title}
          onClose={() => setAsking(false)}
          explicitCloseOnly={step.isPending}
          actions={(
            <>
              <Button onClick={() => setAsking(false)} disabled={step.isPending}>Отмена</Button>
              <Button variant="primary" loading={step.isPending} disabled={reason.trim() === ""} onClick={run}>{words.confirm}</Button>
            </>
          )}
        >
          <div className="cf-form">
            <Field label="Почему" hint="Например: это сдача другого заказа.">{(control) => <Textarea {...control} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
            {failure && <Notice tone="danger">{failure}</Notice>}
          </div>
        </Modal>
      )}
    </>
  );
}

/** One line of «изменилось само»: «K-127 sea_breeze: модель сдала …». */
export function changeLine(change: Pick<CustomSelfChange, "code" | "fan" | "event" | "changes">): string {
  return `${change.code}${change.fan ? ` ${change.fan}` : ""}: ${changeWords(change)}`;
}

/** «За сутки изменилось само: N», folded with the newest line; opened, every step with its «Отменить». */
export function ChangesBanner({ summary, onOpenOrder }: { summary: CustomOrdersBoardResponse["changes"]; onOpenOrder: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const list = useCustomChanges(open);
  if (summary.count === 0 || summary.newest === null) return null;
  return (
    <details className="cf-banner" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cf-banner__head">
        <span className="cf-banner__title">За сутки изменилось само: {summary.count}</span>
        {!open && <span className="cf-banner__sum">{changeLine(summary.newest)}</span>}
        <span className="cf-banner__toggle">{open ? "Свернуть" : "Показать"}</span>
      </summary>
      {open && (
        <div className="cf-banner__body">
          {list.isPending ? <Skeleton height={96} /> : list.isError || !list.data ? <p className="cf-muted">Изменения не загрузились: Hub не ответил.</p> : (
            <ol className="cf-banner__items">
              {list.data.changes.map((change) => (
                <li key={change.id} className="cf-change">
                  <time dateTime={change.at}>{formatTimeOfDay(change.at)}</time>
                  <span className="cf-change__what">
                    <button type="button" className="cf-link" onClick={() => onOpenOrder(change.code)}>{change.code}</button>
                    {change.fan ? ` ${change.fan}` : ""}: {changeWords(change)}
                  </span>
                  <span className="cf-tag">{changeActor(change)}</span>
                  <span className="cf-change__undo">{change.undo !== null && <UndoButton code={change.code} undo={change.undo} undoOf={change.id} />}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </details>
  );
}

