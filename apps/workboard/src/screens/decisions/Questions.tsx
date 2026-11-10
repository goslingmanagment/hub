import { ExternalLink } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button, Disclosure, Mark, Money, Section, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import type { TeamLedgerQuestion } from "@agency_hub_core/contracts";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { FanCell, collidingIn } from "./FanCell";
import type { FanRefOnPage, KnownFan } from "./data";

/**
 * Решения → «Чья продажа»: the questions whose a sale is, which the team's chat agent asked the owner in the chat and
 * keeps in the agency ledger until his word is recorded — the oldest first, the question itself as the row's words, the
 * agent's note under it, how long it waits. Read only: the owner answers the agent in the chat, the agent records the
 * decision in the ledger and the question leaves. The questions the chatters settle among themselves are folded under
 * them: information for the owner, not his decision, out of the count.
 */

const HOUR_MS = 3_600_000;
/** A question that waits longer than this is worth the owner's eye: the one warm mark of the section. */
const QUESTION_LONG_WAIT_DAYS = 7;

/** How long a question waits, in the words of the «Ждёт» column: «меньше часа», «5 часов», «12 дней». */
function waitWords(hours: number): string {
  if (hours < 1) return "меньше часа";
  if (hours < 24) return `${hours} ${ruPlural(hours, "час", "часа", "часов")}`;
  const days = Math.floor(hours / 24);
  return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

/**
 * The agent's note: two lines, and the app's disclosure to read it whole — only when there is more than two lines
 * (no control that does nothing). The text stays in place; opening it only lifts the cut.
 */
function QuestionNote({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);
  return (
    <div className="decisions-question__note-block">
      <p ref={ref} className={open ? "decisions-question__note" : "decisions-question__note decisions-question__note--cut"}>{text}</p>
      {(cut || open) && (
        <Disclosure className="decisions-question__more" summary={open ? "Свернуть" : "Читать целиком"} open={open} onOpenChange={setOpen}>
          {null}
        </Disclosure>
      )}
    </div>
  );
}

function useColumns({ rows, serverNow, platformOf, fanOf, markLongWait }: {
  rows: readonly TeamLedgerQuestion[];
  serverNow: string;
  platformOf: (pageLabel: string) => string | undefined;
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
  /** The owner's questions: a long wait is his to notice. The chatters' own wear no mark. */
  markLongWait: boolean;
}): Column<TeamLedgerQuestion>[] {
  const now = Date.parse(serverNow);
  // Hub's name and login of the fan when it knows them, else the name the agent wrote.
  const fanFor = (row: TeamLedgerQuestion): KnownFan | undefined => {
    const known = row.fanRef === null ? undefined : fanOf({ pageLabel: row.pageLabel, fanRef: row.fanRef });
    if (known?.name || known?.username) return { name: known.name ?? row.fanName, username: known.username };
    return row.fanName === null ? known : { name: row.fanName, username: null };
  };
  const collides = collidingIn(rows, fanOf);
  return [
    {
      key: "fan",
      header: "Фан",
      width: 200,
      cell: (row) => (
        <FanCell
          fan={fanFor(row)}
          // A fan the ledger names without a reference is still shown by name; neither — «фан неизвестен».
          fanRef={row.fanRef ?? (row.fanName === null ? null : "")}
          pageLabel={row.pageLabel || "страница не известна"}
          platform={row.pageLabel ? platformOf(row.pageLabel) : undefined}
          showLogin={collides(row)}
        />
      ),
    },
    {
      key: "sale",
      header: "Продажа",
      numeric: true,
      nowrap: true,
      cell: (row) => {
        if (row.netMills === null && row.occurredAt === null) return <span className="ui-muted">ещё не оплачено</span>;
        return (
          <span>
            {row.netMills === null ? <span className="ui-muted">сумма не известна</span> : <Money mills={row.netMills} strong />}
            <span className="decisions-sub">{row.occurredAt === null ? "время не известно" : formatDateTime(row.occurredAt)}</span>
          </span>
        );
      },
    },
    {
      key: "wait",
      header: "Ждёт",
      nowrap: true,
      sortValue: (row) => row.askedAt,
      sortFirst: "asc",
      cell: (row) => {
        const hours = Math.max(0, Math.floor((now - Date.parse(row.askedAt)) / HOUR_MS));
        const words = waitWords(hours);
        const long = markLongWait && Math.floor(hours / 24) > QUESTION_LONG_WAIT_DAYS;
        const asked = `Спросил ${formatDateTime(row.askedAt)}`;
        return long
          ? <Mark hint={`${asked}: ждёт дольше недели`}>{words}</Mark>
          : <Tooltip content={asked}><span>{words}</span></Tooltip>;
      },
    },
    {
      key: "question",
      header: "Вопрос",
      // The row's words, last: the spare width of a wide screen falls after them, never between two columns.
      grow: true,
      cell: (row) => (
        <div className="decisions-question">
          <p className="decisions-question__text">
            {row.question || <span className="ui-muted">ledger не записал вопрос</span>}
            {/* The gap is preserved spaces, not a margin: on a line of its own the link starts at the line's start. */}
            {row.sourceLink !== null && "   "}
            {row.sourceLink !== null && (
              <a href={row.sourceLink} target="_blank" rel="noreferrer" className="decisions-link decisions-question__link">
                Открыть сообщение
                <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
              </a>
            )}
          </p>
          {row.note !== "" && <QuestionNote text={row.note} />}
        </div>
      ),
    },
  ];
}

interface QuestionsProps {
  serverNow: string;
  platformOf: (pageLabel: string) => string | undefined;
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
}

/** The section of the owner's questions (the screen shows it only when there are some), the chatters' own folded under it. */
export function QuestionsSection({ owner, chatters, ...props }: QuestionsProps & { owner: readonly TeamLedgerQuestion[]; chatters: readonly TeamLedgerQuestion[] }) {
  const columns = useColumns({ ...props, rows: owner, markLongWait: true });
  return (
    <Section
      id="questions"
      className="decisions-section"
      title={<>Чья продажа <span className="decisions-count">{owner.length}</span></>}
      description="Ответьте Генгару в чате — он запишет решение, и вопрос уйдёт отсюда."
    >
      <Table label="Чья продажа: ждут вашего решения" columns={columns} rows={owner} rowKey={(row) => String(row.id)} align="first-line" fit={false} />
      {chatters.length > 0 && <ChattersQuestions {...props} chatters={chatters} />}
    </Section>
  );
}

/**
 * The questions the chatters settle among themselves: folded, out of the count. Under the owner's questions, or — when
 * none wait for him — alone among the screen's folds, then saying what they are about.
 */
export function ChattersQuestions({ chatters, alone = false, ...props }: QuestionsProps & { chatters: readonly TeamLedgerQuestion[]; alone?: boolean }) {
  const columns = useColumns({ ...props, rows: chatters, markLongWait: false });
  return (
    <Disclosure size="md" className="decisions-fold" summary={alone ? "Чья продажа: решают сами чаттеры" : "Решают сами чаттеры"} hint={`· ${chatters.length}`}>
      <p className="decisions-note">Генгар спросил чаттеров, и они договорятся между собой. Это не ваше решение: в счётчик «Решений» не входит.</p>
      <Table label="Чья продажа: решают сами чаттеры" columns={columns} rows={chatters} rowKey={(row) => String(row.id)} align="first-line" fit={false} />
    </Disclosure>
  );
}

/**
 * The ledger did not answer the questions: said once, here, in one calm line — not in the header's line too, and not
 * read as a zero; the other sections stand.
 */
export function QuestionsUnavailable({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <Section
      id="questions"
      className="decisions-section"
      title="Чья продажа"
      description={(
        <span className="decisions-question__failed" role="status">
          ledger не ответил: вопросы сейчас не прочитать. Это не ноль.
          <Button size="sm" variant="ghost" loading={retrying} onClick={onRetry}>{retrying ? "Повторяем…" : "Повторить"}</Button>
        </span>
      )}
    />
  );
}
