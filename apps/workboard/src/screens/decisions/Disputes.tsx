import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { Badge, Button, Confirm, Disclosure, Drawer, Fan, KeyValue, Money, Person, Section, Skeleton, Table, TimeMsk, Tooltip, toast, type Column } from "@agency_hub_core/ui";
import { formatDateTime, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { consoleFanHref, PersonLink, shiftPath, useBackState } from "@/shared/links";
import { FanCell, collidingIn, goColumn, pageWords } from "./FanCell";
import { disputeProblem, useResolveDispute, useSaleShifts, type Dispute, type FanRefOnPage, type KnownFan, type SaleShift } from "./data";

/**
 * Споры по продажам: a sale two chatters both put in their payout. The list
 * only names it; the decision is made in its panel (the fan, who claims what
 * and each one's conversation with the fan in their shift, what stands now),
 * and recorded after the console's own question (TeamPayoutsPage.tsx:93-134):
 * its title, facts, button and toast.
 */

const MARK_LABELS: Readonly<Record<string, string>> = { mine: "моё", share: "делим", not_mine: "не моё" };
const REASON_LABELS: Readonly<Record<string, string>> = {
  two_mine: "Оба записали «моё»",
  share_not_agreed: "«Делим» без согласия второго",
  conflicting: "Отметки не сходятся",
};

/** The console's «Было» line: every chatter's mark (TeamPayoutsPage.tsx:67-71). */
function marksLine(dispute: Dispute): string {
  return dispute.marks
    .map((mark) => `${mark.username}: ${MARK_LABELS[mark.mark] ?? mark.mark}${mark.shareWith ? ` с ${mark.shareWith}` : ""}${mark.amountMills !== null ? ` (${formatMills(mark.amountMills)})` : ""}`)
    .join(" · ");
}

function resolutionLine(dispute: Dispute): string | null {
  return dispute.resolution === null ? null : `Решено: ${dispute.resolution.map((share) => `${share.username} ${share.percent} %`).join(", ")}`;
}

/** One claimant's mark in words: «моё», «делим с alex.k», «моё, своя сумма $24.00»; null — they marked nothing. */
function markWords(dispute: Dispute, userId: number) {
  const mark = dispute.marks.find((one) => one.userId === userId);
  if (!mark) return null;
  return <>«{MARK_LABELS[mark.mark] ?? mark.mark}»{mark.shareWith ? ` с ${mark.shareWith}` : ""}{mark.amountMills !== null && <>, своя сумма <Money mills={mark.amountMills} /></>}</>;
}

interface Share {
  userId: number;
  username: string;
  percent: number;
}

/** The splits the console offers: all to one, or halves between two. Each sums to exactly 100. */
function choicesOf(dispute: Dispute): Array<{ key: string; label: string; hint: string; shares: Share[] }> {
  const whole = dispute.people.map((person) => ({
    key: `all:${person.userId}`,
    label: `Всё — ${person.username}`,
    hint: `${formatMills(dispute.netMills)} в выплату ${person.username}`,
    shares: [{ userId: person.userId, username: person.username, percent: 100 }],
  }));
  const halves = dispute.people.length === 2
    ? [{
      key: "halves",
      label: "Пополам",
      hint: `По 50 % — ${dispute.people.map((person) => person.username).join(" и ")}`,
      shares: dispute.people.map((person) => ({ userId: person.userId, username: person.username, percent: 50 })),
    }]
    : [];
  return [...whole, ...halves];
}

/** The choice that stands now, if the owner decided before. */
function currentChoice(dispute: Dispute): string | null {
  if (dispute.resolution === null) return null;
  return choicesOf(dispute).find((choice) => choice.shares.length === dispute.resolution!.length
    && choice.shares.every((share) => dispute.resolution!.some((made) => made.userId === share.userId && made.percent === share.percent)))?.key ?? null;
}

function useDisputeColumns(rows: readonly Dispute[], fanOf: (fan: FanRefOnPage) => KnownFan | undefined) {
  const collides = collidingIn(rows, fanOf);
  const when: Column<Dispute> = { key: "when", header: "Продажа", cell: (row) => <TimeMsk at={row.occurredAt} />, nowrap: true, width: 170, sortValue: (row) => row.occurredAt };
  const fan: Column<Dispute> = {
    key: "fan",
    header: "Фан",
    width: 260,
    cell: (row) => (
      <FanCell
        fan={row.fanRef === null ? undefined : fanOf({ pageLabel: row.pageLabel, fanRef: row.fanRef })}
        fanRef={row.fanRef}
        pageLabel={row.pageLabel}
        platform={row.platform}
        showLogin={collides(row)}
      />
    ),
  };
  // The sum beside the sale's time, the words last: on a wide screen the spare width falls after the words,
  // not between a name and its money (С9).
  const sum: Column<Dispute> = { key: "sum", header: "Сумма", numeric: true, width: 120, cell: (row) => <Money mills={row.netMills} strong />, sortValue: (row) => row.netMills };
  return {
    open: [
      when, sum, fan,
      {
        key: "who",
        header: "Кто записал на себя",
        grow: true,
        // People as everywhere on the screen: the circle and the name (Р-н4); why it is a dispute under them.
        cell: (row) => (
          <span className="decisions-claimants">
            <span className="decisions-people">{row.people.map((person) => <Person key={person.userId} name={person.username} />)}</span>
            <span className="decisions-sub">{REASON_LABELS[row.reason] ?? row.reason}</span>
          </span>
        ),
      },
      goColumn<Dispute>(),
    ] satisfies Column<Dispute>[],
    // A decided dispute is changed from inside its panel: its row has no arrow (Р3).
    settled: [
      when, sum, fan,
      { key: "decided", header: "Решение", grow: true, cell: (row) => resolutionLine(row)?.replace(/^Решено: /, "") ?? "—" },
    ] satisfies Column<Dispute>[],
  };
}

export function DisputesSection({ open, settled, fanOf, onOpen, selected }: {
  open: readonly Dispute[];
  settled: readonly Dispute[];
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
  onOpen: (saleRef: string) => void;
  /** The dispute open in its panel. */
  selected: string | null;
}) {
  const columns = useDisputeColumns(open, fanOf);
  return (
    <Section
      id="disputes"
      className="decisions-section"
      title={<>Споры по продажам <span className="decisions-count">{open.length}</span></>}
      description="Одну продажу записали на себя двое. Пока вы не решите, её нет в выгрузке."
    >
      <Table label="Споры по продажам" columns={columns.open} rows={open} rowKey={(row) => row.saleRef} onRowClick={(row) => onOpen(row.saleRef)} selectedKey={selected} skeletonLines={2} />
      {settled.length > 0 && <SettledDisputes settled={settled} fanOf={fanOf} onOpen={onOpen} selected={selected} />}
    </Section>
  );
}

/** Disputes decided in Hub's window (31 days), folded: a decision can be replaced from its panel. */
export function SettledDisputes({ settled, fanOf, onOpen, selected }: {
  settled: readonly Dispute[];
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
  onOpen: (saleRef: string) => void;
  selected: string | null;
}) {
  const columns = useDisputeColumns(settled, fanOf);
  return (
    <Disclosure size="md" summary="Решённые споры за последний месяц" hint={String(settled.length)} className="decisions-fold">
      <Table label="Решённые споры" columns={columns.settled} rows={settled} rowKey={(row) => row.saleRef} onRowClick={(row) => onOpen(row.saleRef)} selectedKey={selected} />
    </Disclosure>
  );
}

/** Minutes before and after the sale the review lights up (its pulse span): the talk that led to it. */
const SPAN_BEFORE = 20;
const SPAN_AFTER = 10;

/**
 * One claimant's conversation with the fan at the sale (E5): the review of their
 * shift that held it, opened on this fan's chat with the minutes around the sale
 * lit (`span`). A shift that ended before the sale opens on the chat only and
 * says so with its date (Р-н2). No shift at the sale is said in words: then only
 * the other side is known.
 */
function Evidence({ dispute, userId, shifts }: { dispute: Dispute; userId: number; shifts: ReturnType<typeof useSaleShifts> }) {
  const location = useLocation();
  const back = useBackState("Решения");
  if (shifts.isLoading) return <Skeleton width={180} />;
  if (!shifts.data) return <span className="decisions-evidence decisions-evidence--none">Смены не прочитались</span>;
  const shift: SaleShift | undefined = shifts.data.get(userId);
  if (!shift) {
    return <span className="decisions-evidence decisions-evidence--none">Смены у продажи нет</span>;
  }
  const when = shiftWhen(shift);
  const params = new URLSearchParams();
  if (dispute.fanRef !== null) params.set("chat", `${dispute.pageLabel}:${dispute.fanRef}`);
  if (shift.holds) {
    const minute = Math.floor((Date.parse(dispute.occurredAt) - Date.parse(shift.startedAt)) / 60_000);
    params.set("span", `${Math.max(0, minute - SPAN_BEFORE)}-${minute + SPAN_AFTER}`);
  }
  const path = shiftPath(userId, shift.startedAt, location.search);
  const to = `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
  const sale = formatTimeOfDay(dispute.occurredAt);
  return (
    <span className="decisions-evidence-box">
      <Tooltip
        content={shift.holds
          ? `Разбор этой смены на чате с фаном: сообщения около ${sale} подсвечены`
          : `Продажа в ${sale} была после этой смены: разбор последней смены до неё, на чате с фаном`}
        align="end"
      >
        <Link to={to} state={back} className="decisions-evidence">
          {shift.holds ? "Переписка у продажи" : "Смена до продажи"}
          <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
        </Link>
      </Tooltip>
      <span className="decisions-sub">{shift.holds ? `смена ${when.label}` : when.label}</span>
    </span>
  );
}

/**
 * «Известна только сторона kate.v: у alex.k смены у продажи нет, и продажу он не
 * отмечал.» when a claimant had no shift holding the sale (E5: say it plainly);
 * null when both sides can be read.
 */
function oneSidedWords(dispute: Dispute, shifts: Map<number, SaleShift> | undefined): string | null {
  if (!shifts) return null;
  const read = dispute.people.filter((person) => shifts.get(person.userId)?.holds === true);
  const unread = dispute.people.filter((person) => shifts.get(person.userId)?.holds !== true);
  if (read.length === 0 || unread.length === 0) return null;
  const names = (people: typeof read) => people.map((person) => person.username).join(" и ");
  const marked = unread.some((person) => dispute.marks.some((mark) => mark.userId === person.userId));
  const quiet = marked ? "" : unread.length === 1 ? ", и продажу он не отмечал" : ", и продажу они не отмечали";
  return `Известна только сторона ${names(read)}: у ${names(unread)} смены у продажи нет${quiet}.`;
}

/** The decision panel of one dispute: the fan, who claims what with their conversations, what stands; then a split and the console's question. */
export function DisputeDrawer({ dispute, fan, onClose }: { dispute: Dispute; fan: KnownFan | undefined; onClose: () => void }) {
  const choices = choicesOf(dispute);
  const now = currentChoice(dispute);
  const [picked, setPicked] = useState<string | null>(now);
  const [asking, setAsking] = useState(false);
  const shifts = useSaleShifts(dispute);
  const oneSided = oneSidedWords(dispute, shifts.data);
  const choice = choices.find((one) => one.key === picked) ?? null;
  const changed = choice !== null && choice.key !== now;
  return (
    <Drawer
      open
      onClose={onClose}
      // The focus lands on the panel, not on the first answer: a stray Space must not pick one.
      initialFocus="box"
      title={<>Спор о продаже <Money mills={dispute.netMills} /></>}
      subtitle={<>{pageWords(dispute.pageLabel, dispute.platform)} · <TimeMsk at={dispute.occurredAt} /></>}
      footer={(
        <>
          <Button onClick={onClose}>Закрыть</Button>
          <Button variant="primary" disabled={!changed} onClick={() => setAsking(true)}>
            {dispute.resolution === null ? "Записать решение…" : "Заменить решение…"}
          </Button>
        </>
      )}
    >
      <div className="decisions-panel">
        <KeyValue
          items={[
            {
              label: "Фан",
              value: dispute.fanRef === null
                ? "—"
                : <Fan name={fan?.name ?? null} username={fan?.username ?? null} fanRef={dispute.fanRef} href={consoleFanHref(dispute.pageLabel, dispute.platform, dispute.fanRef)} hint="Карточка фана в консоли" />,
            },
            {
              label: "Сейчас",
              value: dispute.resolution === null ? <Badge tone="accent">Ждёт решения</Badge> : resolutionLine(dispute),
            },
          ]}
        />

        <section className="decisions-claims" aria-labelledby={`claims-${dispute.saleRef}`}>
          <h3 id={`claims-${dispute.saleRef}`} className="decisions-panel__title">Кто что отметил</h3>
          <ul className="decisions-marks">
            {dispute.people.map((person) => (
              <li key={person.userId}>
                <span className="decisions-marks__who">
                  <PersonLink userId={person.userId} name={person.username} hint={markWords(dispute, person.userId) ?? "продажу не отмечал"} backLabel="Решения" />
                </span>
                <Evidence dispute={dispute} userId={person.userId} shifts={shifts} />
              </li>
            ))}
          </ul>
          {/* Only one side can be read (E5): said once, plainly, before the choice. */}
          {oneSided !== null && <p className="decisions-note decisions-oneside">{oneSided}</p>}
        </section>

        <fieldset className="decisions-choices">
          <legend>Кому отдать продажу</legend>
          {choices.map((one) => (
            <label key={one.key} className="decisions-choice" data-picked={picked === one.key || undefined}>
              <input type="radio" name={`split-${dispute.saleRef}`} value={one.key} checked={picked === one.key} onChange={() => setPicked(one.key)} />
              <span>
                <span className="decisions-choice__title">
                  {one.label}
                  {one.key === now && <span className="decisions-choice__now">сейчас так</span>}
                </span>
                <span className="decisions-choice__hint">{one.hint}</span>
              </span>
            </label>
          ))}
          {now === null && dispute.resolution !== null && (
            <p className="decisions-note">Сейчас стоит другое деление: {resolutionLine(dispute)?.replace(/^Решено: /, "")}. Здесь его можно заменить.</p>
          )}
        </fieldset>
      </div>
      {asking && choice && <ResolveConfirm dispute={dispute} shares={choice.shares} onClose={() => setAsking(false)} onDone={onClose} />}
    </Drawer>
  );
}

/** The console's question before a split (TeamPayoutsPage.tsx:93-134): its title, facts, button and toast; «Отменить» joins the message. */
function ResolveConfirm({ dispute, shares, onClose, onDone }: { dispute: Dispute; shares: Share[]; onClose: () => void; onDone: () => void }) {
  const resolve = useResolveDispute();
  const [problem, setProblem] = useState<string | null>(null);
  const whole = shares.length === 1;
  const sum = formatMills(dispute.netMills);
  const close = () => {
    resolve.reset();
    onClose();
  };
  return (
    <Confirm
      title={whole ? `Отдать всю продажу ${shares[0]!.username}?` : "Разделить продажу пополам?"}
      message={(
        <>
          Решение заменит прежние отметки по этой продаже в выплате. Отменить нельзя, но решение можно заменить другим. Если день
          уже выгружен, изменение появится в блоке «Изменено после подтверждения дня».
        </>
      )}
      facts={[
        { label: "Где", value: pageWords(dispute.pageLabel, dispute.platform) },
        { label: "Что", value: `Продажа ${sum}, ${formatDateTime(dispute.occurredAt)}` },
        { label: "Кому", value: shares.map((share) => `${share.username} — ${share.percent} %`).join(", ") },
        { label: "Было", value: resolutionLine(dispute) ?? marksLine(dispute) },
      ]}
      confirmLabel={whole ? `Отдать ${shares[0]!.username}` : "Разделить пополам"}
      pendingLabel="Записываем…"
      tone="primary"
      error={problem ?? undefined}
      isPending={resolve.isPending}
      onConfirm={() => {
        if (resolve.isPending) return;
        resolve.mutate(
          { saleRef: dispute.saleRef, body: { shares: shares.map(({ userId, percent }) => ({ userId, percent })) } },
          {
            onSuccess: () => {
              toast.success(whole
                ? `Записано: вся продажа ${sum} — ${shares[0]!.username}`
                : `Записано: продажа ${sum} пополам, ${shares.map((share) => share.username).join(" и ")}`);
              close();
              onDone();
            },
            onError: (error) => setProblem(disputeProblem(error)),
          },
        );
      }}
      onClose={close}
    />
  );
}

/** «2 спора» for the header line. */
export function disputesWord(count: number): string {
  return `${count} ${ruPlural(count, "спор", "спора", "споров")}`;
}
