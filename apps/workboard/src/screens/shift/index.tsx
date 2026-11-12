import { ChevronRight, Copy, Plus, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import type { ShiftReportBody, ShiftReportClaim, ShiftReportClaimableResponse, ShiftReportResponse } from "@agency_hub_core/contracts";
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  ErrorState,
  Fan,
  Menu,
  Modal,
  Money,
  Notice,
  PageLabel,
  SearchInput,
  Skeleton,
  TextInput,
  Textarea,
  Tooltip,
  toast,
  type MenuEntry,
} from "@agency_hub_core/ui";
import { formatDateTime, formatDay, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { clockOf } from "@agency_hub_core/ui/shiftReports";
import { shiftDurationHint, shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { useBackTarget } from "@/shared/links";
import { ChainMoney } from "@/shared/saleChain";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import {
  isClaimed,
  mineFacts,
  minePages,
  nearLines,
  useClaimable,
  useComment,
  useLineWord,
  useOffPlatform,
  useShiftReport,
  useSubmit,
  type FanGroup,
  type Line,
  type LineWord,
} from "./data";
import { ClaimOnLine, LooseClaims } from "./Claims";
import "./shift.css";

/**
 * Смена — a shift and its report (ecosystem package F), the continuation of
 * «Мои смены»: at the end of a shift the person opens it, the draft is already
 * there — every sale of the shift with whose it is by the rule and why. They
 * touch only the exceptions («не моё», «делим с…» in a small menu, «это моё» of
 * a sale nearby, a note), write the comment, and press «Сдать смену». After it
 * the post for «Отчётность» is one button away; «Исправить» opens the draft
 * again and the next hand-in is the next version. A colleague, a team lead and
 * the owner read the same screen without a single control.
 */

const plural = (count: number, one: string, few: string, many: string) => `${count} ${ruPlural(count, one, few, many)}`;

/** One word per kind of sale, as the product says it elsewhere (plan §4 «Слова»): PPV, чаевые, подписка, пост. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  message_purchase: "PPV",
  post_purchase: "пост",
  tip: "чаевые",
  stream_tip: "чаевые",
  subscription: "подписка",
};
const kindWord = (kind: string) => KIND_WORDS[kind] ?? kind;

/** «PPV ×4» when a fan bought one kind (the sum stands on the right); «PPV ×3 $36.00 · подписка $4.00» when several. */
function kindsWords(group: FanGroup): string {
  if (group.kinds.length === 1) {
    const kind = group.kinds[0]!;
    return `${kindWord(kind.kind)}${kind.count > 1 ? ` ×${kind.count}` : ""}`;
  }
  return group.kinds.map((kind) => `${kindWord(kind.kind)}${kind.count > 1 ? ` ×${kind.count}` : ""} ${formatMills(kind.mills)}`).join(" · ");
}

/** The reasons of the plain case — the person's own PPV, the page their shift alone held — are not repeated on every line. */
const PLAIN_REASONS: ReadonlySet<string> = new Set(["ppv_sender", "holder"]);

/**
 * The reason a line shows, or null for the plain case (its «почему» stays one press away): a PPV sent in an earlier
 * shift says when («ваш PPV от 9 нояб.»), a junction, a claim, a «долёт» say why; a near line always says whose it is.
 */
function shownReason(line: Line, shiftStart: string): string | null {
  if (line.group === "near" || line.added || line.alreadyIn !== null) return line.rule.words;
  const sentAt = line.facts?.ppv?.sentAt ?? null;
  if (line.kind === "message_purchase" && line.rule.reason.startsWith("ppv_sender") && sentAt !== null && Date.parse(sentAt) < Date.parse(shiftStart)) {
    return formatDay(sentAt) === formatDay(shiftStart) ? `ваш PPV, отправлен до смены, в ${formatTimeOfDay(sentAt)}` : `ваш PPV от ${formatDay(sentAt)}`;
  }
  return PLAIN_REASONS.has(line.rule.reason) ? null : line.rule.words;
}

/** A line's money: what it counts, or — a disputed «моё» — what it claims, said to wait (it counts nothing until settled). */
function LineMoney({ line, muted = false }: { line: Line; muted?: boolean }) {
  if ((line.claimedMills ?? 0) > 0) return <span className="shf-claimed">спорно, ждёт решения: <Money mills={line.claimedMills!} /></span>;
  return <Money mills={line.amountMills} muted={muted} />;
}

/** What the person said of a line, in a word beside it. */
function WordChip({ line }: { line: Line }) {
  if (line.alreadyIn !== null) return <Badge tone="off" className="shf-chip">в другом отчёте</Badge>;
  if (line.statement === "not_mine") return <Badge tone="off" className="shf-chip">не моё</Badge>;
  if (line.statement === "share") return <Badge tone="info" className="shf-chip">пополам{line.shareWithName ? `: ${line.shareWithName}` : ""}</Badge>;
  if (isClaimed(line)) {
    return line.disputed
      ? <Tooltip content="По правилу или по чужому отчёту продажа не ваша: она в отчёте, но в сумму не входит, пока коллега не согласится или не решит владелец."><Badge tone="warning" className="shf-chip">добавлена, спорная</Badge></Tooltip>
      : <Badge tone="success" className="shf-chip">добавлена</Badge>;
  }
  if (line.statement === "mine") {
    return line.disputed
      ? <Tooltip content="По правилу продажа не ваша: она в отчёте, но в сумму не входит, пока коллега не согласится или не решит владелец."><Badge tone="warning" className="shf-chip">моё, спорная</Badge></Tooltip>
      : <Badge tone="success" className="shf-chip">моё</Badge>;
  }
  if (line.added) return <Badge tone="neutral" className="shf-chip">долёт</Badge>;
  return null;
}

// ───────────────────────────────────────────────────────────── Claims on lines (package G)

interface LineClaims {
  shiftId: number;
  /** The reader's own report: the claims speak to them; else in the third person. */
  own: boolean;
  /** The claims of each sale of the report, by transaction. */
  of: ReadonlyMap<number, readonly ShiftReportClaim[]>;
  /** The sale the address names (`?sale=`): the line a matter brought the reader to. */
  focus: number | null;
}

const ClaimsContext = createContext<LineClaims>({ shiftId: 0, own: true, of: new Map(), focus: null });

/** A line's claims under it, and the line marked when the address names it. */
function useLineClaims(line: Line) {
  const context = useContext(ClaimsContext);
  const claims = context.of.get(line.transactionId) ?? [];
  const focused = context.focus === line.transactionId;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const below = claims.length === 0 ? null : (
    <div className="shf-claims-on">
      {claims.map((claim) => <ClaimOnLine key={claim.id} claim={claim} shiftId={context.shiftId} netMills={line.netMills} own={context.own} />)}
    </div>
  );
  return { below, focused, ref, id: `sale-${line.transactionId}` };
}

// ───────────────────────────────────────────────────────────── «Почему»: the facts behind the reason

/** The facts the rule read of a sale, in words: shown under the line when its reason is pressed. */
function LineFacts({ line }: { line: Line }) {
  const facts = line.facts;
  if (facts === null) return null;
  const items: string[] = [];
  if (facts.ppv !== null) {
    if (facts.ppv.senderName !== null) items.push(`PPV отправил ${facts.ppv.senderName}${facts.ppv.sentAt ? ` ${formatDateTime(facts.ppv.sentAt)}` : ""}`);
    else if (facts.ppv.withoutAuthor) items.push(`PPV отправлен без автора${facts.ppv.sentAt ? ` ${formatDateTime(facts.ppv.sentAt)}` : ""}: с телефона или рассылкой`);
    else items.push("сообщение с этим PPV в Hub не найдено");
  }
  if (facts.lastWriter !== null) {
    items.push(`последним фану писал ${facts.lastWriter.name} ${formatDateTime(facts.lastWriter.at)}${facts.lastWriter.within48h ? "" : ", больше 48 часов назад"}`);
  } else {
    items.push("за 60 дней фану никто не писал из расширения");
  }
  if (facts.writers.length > 1) items.push(`писали фану за 48 часов: ${facts.writers.map((writer) => `${writer.name} ${writer.messages}`).join(", ")}`);
  if (facts.holders !== null) {
    items.push(facts.holders.length === 0
      ? "страницу в этот момент держала только ваша смена"
      : `страницу в этот момент держали и ${facts.holders.map((one) => `${one.name}${one.slotRunning === true ? " (шёл его слот)" : one.slotRunning === false ? " (не его слот)" : ""}`).join(", ")}`);
  }
  if (facts.ownSlotRunning !== null && facts.holders !== null && facts.holders.length > 0) items.push(facts.ownSlotRunning ? "ваш слот в это время шёл" : "ваш слот в это время не шёл");
  for (const other of facts.otherReports) items.push(`уже в отчёте ${other.name} за ${formatDay(other.reportDate)}`);
  if (facts.pot !== null) items.push("по правилу это общак страницы");
  if (facts.renewalOf !== null) items.push(`автопродление: такое же списание было ${formatDateTime(facts.renewalOf)}`);
  return <ul className="shf-facts">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

/**
 * A line's reason and its facts. A reason worth saying stands under the line, pressed it opens the facts; the plain
 * case says nothing but a quiet «почему» at the end of the line, seen when the line is pointed at or focused.
 */
function useWhy(line: Line, shiftStart: string) {
  const [open, setOpen] = useState(false);
  const reason = shownReason(line, shiftStart);
  const canOpen = line.facts !== null;
  const toggle = () => setOpen(!open);
  const inline = reason === null && canOpen
    ? <button type="button" className="shf-why shf-why--quiet" aria-expanded={open} onClick={toggle} title={`Почему: ${line.rule.words}`}>почему</button>
    : null;
  const below = reason === null ? null : canOpen
    ? <button type="button" className="shf-sale__why shf-why" aria-expanded={open} onClick={toggle} title="Почему так">{reason}</button>
    : <span className="shf-sale__why">{reason}</span>;
  return { inline, below, facts: open ? <LineFacts line={line} /> : null };
}

// ───────────────────────────────────────────────────────────── A note

function NoteEditor({ initial, placeholder, onSave, onCancel, required = false }: {
  initial: string;
  placeholder: string;
  onSave: (note: string) => void;
  onCancel: () => void;
  required?: boolean;
}) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const save = () => {
    if (required && text.trim() === "") return;
    onSave(text.trim());
  };
  return (
    <span className="shf-note-edit">
      <TextInput
        ref={input}
        value={text}
        maxLength={300}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") onCancel();
        }}
      />
      <Button size="sm" variant="primary" onClick={save} disabled={required && text.trim() === ""}>Сохранить</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Отмена</Button>
    </span>
  );
}

// ───────────────────────────────────────────────────────────── «Ваши продажи»

interface Editing {
  editable: boolean;
  /** The shift's start: a PPV sent before it says when. */
  shiftStart: string;
  colleagues: ShiftReportResponse["colleagues"];
  say: (word: LineWord) => void;
}

function wordOf(line: Line): Omit<LineWord, "transactionId"> {
  return { statement: line.statement, shareWithUserId: line.shareWithUserId, shareWithName: line.shareWithName, note: line.note };
}

function MineMenu({ line, edit, onNote }: { line: Line; edit: Editing; onNote: () => void }) {
  const set = (change: Partial<LineWord>) => edit.say({ transactionId: line.transactionId, ...wordOf(line), ...change });
  if (isClaimed(line)) {
    // A sale added by hand: take it back out, or change its why.
    return (
      <Menu
        label="Что с этой продажей"
        size="sm"
        items={[
          { label: "Изменить заметку", onSelect: onNote },
          { separator: true },
          { label: "Убрать из отчёта", danger: true, onSelect: () => edit.say({ transactionId: line.transactionId, statement: null, shareWithUserId: null, shareWithName: null, note: null }) },
        ]}
      />
    );
  }
  const items: MenuEntry[] = [
    { label: "Не моё", checked: line.statement === "not_mine", onSelect: () => set({ statement: line.statement === "not_mine" ? null : "not_mine", shareWithUserId: null, shareWithName: null }) },
  ];
  if (edit.colleagues.length > 0) {
    items.push({ group: "Делим пополам с" });
    for (const one of edit.colleagues) {
      const on = line.statement === "share" && line.shareWithUserId === one.userId;
      items.push({ label: one.name, checked: on, onSelect: () => set(on ? { statement: null, shareWithUserId: null, shareWithName: null } : { statement: "share", shareWithUserId: one.userId, shareWithName: one.name }) });
    }
  }
  items.push({ separator: true });
  items.push({ label: line.note ? "Изменить заметку" : "Заметка", onSelect: onNote });
  return <Menu items={items} label="Что с этой продажей" size="sm" />;
}

/** One sale of «Ваши продажи»: when, what, why it is yours, what it counts; the menu while the draft is open. */
function MineSale({ line, edit, showFan }: { line: Line; edit: Editing; showFan: boolean }) {
  const [noting, setNoting] = useState(false);
  const why = useWhy(line, edit.shiftStart);
  const claims = useLineClaims(line);
  const off = line.amountMills === 0 && line.netMills > 0;
  return (
    <li ref={claims.ref} id={claims.id} className={`${off ? "shf-sale shf-sale--off" : "shf-sale"}${claims.focused ? " shf-sale--focus" : ""}`}>
      <span className="shf-sale__time">{clockOf(line.occurredAt)}</span>
      <div className="shf-sale__main">
        <p className="shf-sale__what">
          {showFan && <Fan name={line.fan.name} username={line.fan.username} fanRef={line.fan.fanRef ?? ""} className="shf-sale__fan" />}
          <span className="shf-sale__kind">{kindWord(line.kind)}</span>
          <WordChip line={line} />
          {why.inline}
        </p>
        {why.below}
        {why.facts}
        {noting
          ? <NoteEditor initial={line.note ?? ""} placeholder="Заметка: секстинг, обещал вернуться" onCancel={() => setNoting(false)} onSave={(note) => {
            setNoting(false);
            edit.say({ transactionId: line.transactionId, ...wordOf(line), note: note === "" ? null : note });
          }} />
          : line.note && <p className="shf-sale__note">{line.note}</p>}
        {claims.below}
      </div>
      <span className="shf-sale__money">
        {(line.statement === "share" || line.statement === "not_mine") && line.rule.shareMills !== line.amountMills && <Money mills={line.rule.shareMills} muted className="shf-was" />}
        <ChainMoney saleId={line.transactionId}><LineMoney line={line} muted={off} /></ChainMoney>
      </span>
      <span className="shf-sale__act">{edit.editable && <MineMenu line={line} edit={edit} onNote={() => setNoting(true)} />}</span>
    </li>
  );
}

/** A fan of a page: their sales in one line («ппв ×3 $36.00 · подписка $4.00»), opened to the single sales. */
function FanRow({ group, edit }: { group: FanGroup; edit: Editing }) {
  const claims = useContext(ClaimsContext);
  const [open, setOpen] = useState(group.marked || group.lines.some((line) => claims.focus === line.transactionId || claims.of.has(line.transactionId)));
  if (group.lines.length === 1) {
    return <ul className="shf-sales shf-sales--single"><MineSale line={group.lines[0]!} edit={edit} showFan /></ul>;
  }
  return (
    <div className={open ? "shf-fan shf-fan--open" : "shf-fan"}>
      <button type="button" className="shf-fan__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={16} strokeWidth={2} aria-hidden className="shf-fan__chevron" />
        <Fan name={group.fan.name} username={group.fan.username} fanRef={group.fan.fanRef ?? ""} className="shf-fan__name" />
        <span className="shf-fan__kinds">{kindsWords(group)}</span>
        {group.marked && !open && <Badge tone="neutral" className="shf-chip">есть отметки</Badge>}
        <Money mills={group.amountMills} className="shf-fan__money" />
      </button>
      {open && <ul className="shf-sales">{group.lines.map((line) => <MineSale key={line.transactionId} line={line} edit={edit} showFan={false} />)}</ul>}
    </div>
  );
}

function MineSection({ body, edit, own }: { body: ShiftReportBody; edit: Editing; own: boolean }) {
  const pages = useMemo(() => minePages(body), [body]);
  const facts = mineFacts(body);
  return (
    <section className="shf-card" aria-labelledby="shf-mine">
      <header className="shf-card__head">
        <h2 id="shf-mine" className="shf-card__title">{own ? "Ваши продажи" : "Продажи в отчёте"}</h2>
        <span className="shf-card__hint">{facts.count === 0 ? "нет" : plural(facts.count, "продажа", "продажи", "продаж")}</span>
      </header>
      {pages.length === 0 ? (
        <p className="shf-empty">{own ? "В этой смене по правилу ваших продаж нет." : "В этой смене по правилу продаж нет."}{own && nearLines(body).length > 0 ? " Продажи рядом, на ваших страницах, ниже." : ""}</p>
      ) : pages.map((page) => (
        <div key={page.pageLabel} className="shf-page">
          <div className="shf-page__head">
            <PageLabel label={page.pageLabel} />
            <Money mills={page.amountMills} strong={page.amountMills !== 0} muted={page.amountMills === 0} />
          </div>
          {page.fans.map((group) => <FanRow key={group.key} group={group} edit={edit} />)}
        </div>
      ))}
    </section>
  );
}

// ───────────────────────────────────────────────────────────── «Рядом»

function NearSale({ line, edit }: { line: Line; edit: Editing }) {
  const [claiming, setClaiming] = useState(false);
  const why = useWhy(line, edit.shiftStart);
  const claims = useLineClaims(line);
  const claimed = line.statement === "mine";
  return (
    <li ref={claims.ref} id={claims.id} className={`${claimed ? "shf-sale" : "shf-sale shf-sale--near"}${claims.focused ? " shf-sale--focus" : ""}`}>
      <span className="shf-sale__time">{clockOf(line.occurredAt)}</span>
      <div className="shf-sale__main">
        <p className="shf-sale__what">
          <PageLabel label={line.pageLabel} />
          <Fan name={line.fan.name} username={line.fan.username} fanRef={line.fan.fanRef ?? ""} className="shf-sale__fan" />
          <span className="shf-sale__kind">{kindWord(line.kind)}</span>
          <WordChip line={line} />
          {why.inline}
        </p>
        {why.below}
        {why.facts}
        {claiming
          ? <NoteEditor required initial={line.note ?? ""} placeholder="Почему она ваша? Одной строкой" onCancel={() => setClaiming(false)} onSave={(note) => {
            setClaiming(false);
            edit.say({ transactionId: line.transactionId, statement: "mine", shareWithUserId: null, shareWithName: null, note });
          }} />
          : line.note && <p className="shf-sale__note">{line.note}</p>}
        {claims.below}
      </div>
      <span className="shf-sale__money">
        <ChainMoney saleId={line.transactionId}>{claimed ? <LineMoney line={line} /> : <Money mills={line.netMills} muted />}</ChainMoney>
      </span>
      <span className="shf-sale__act">
        {edit.editable && !claiming && (claimed
          ? <Button size="sm" variant="ghost" onClick={() => edit.say({ transactionId: line.transactionId, statement: null, shareWithUserId: null, shareWithName: null, note: null })}>Не моё</Button>
          : <Button size="sm" variant="secondary" onClick={() => setClaiming(true)}>Это моё</Button>)}
      </span>
    </li>
  );
}

function NearSection({ body, edit, own }: { body: ShiftReportBody; edit: Editing; own: boolean }) {
  const lines = nearLines(body);
  const claims = useContext(ClaimsContext);
  if (lines.length === 0) return null;
  const claimed = lines.filter((line) => line.statement === "mine").length;
  return (
    <Disclosure
      size="md"
      className="shf-near"
      defaultOpen={claimed > 0 || lines.some((line) => claims.focus === line.transactionId || claims.of.has(line.transactionId))}
      summary={own ? "Рядом, но не ваши по правилу" : "Рядом, но не его по правилу"}
      hint={own
        ? `${plural(lines.length, "продажа", "продажи", "продаж")} на ваших страницах${claimed > 0 ? `, ${claimed} вы взяли себе` : ""}`
        : `${plural(lines.length, "продажа", "продажи", "продаж")}${claimed > 0 ? `, ${claimed} взял себе` : ""}`}
    >
      <ul className="shf-sales">{lines.map((line) => <NearSale key={line.transactionId} line={line} edit={edit} />)}</ul>
    </Disclosure>
  );
}

// ───────────────────────────────────────────────────────────── «Добавить»: a sale by hand, «мимо площадки»

/** One sale the person may add, «Это моё» with one line of why. */
function ClaimRow({ sale, onClaim }: { sale: ShiftReportClaimableResponse["sales"][number]; onClaim: (note: string) => void }) {
  const [claiming, setClaiming] = useState(false);
  return (
    <li className="shf-sale shf-claim">
      <span className="shf-sale__time">{formatDay(sale.occurredAt)}<br />{clockOf(sale.occurredAt)}</span>
      <div className="shf-sale__main">
        <p className="shf-sale__what">
          <PageLabel label={sale.pageLabel} />
          <Fan name={sale.fan.name} username={sale.fan.username} fanRef={sale.fan.fanRef ?? ""} showLogin className="shf-sale__fan" />
          <span className="shf-sale__kind">{kindWord(sale.kind)}</span>
        </p>
        <span className="shf-sale__why">{sale.words}</span>
        {claiming && <NoteEditor required initial="" placeholder="Почему она ваша? Одной строкой" onCancel={() => setClaiming(false)} onSave={(note) => { setClaiming(false); onClaim(note); }} />}
      </div>
      <span className="shf-sale__money"><Money mills={sale.netMills} muted /></span>
      <span className="shf-sale__act">{!claiming && <Button size="sm" variant="secondary" onClick={() => setClaiming(true)}>Это моё</Button>}</span>
    </li>
  );
}

/**
 * «Добавить → продажу»: the sales of the last 7 days on the person's pages that no report of theirs holds — nobody's
 * first, the rest by the fan's name or login. An added sale stands under its page marked «добавлена»: plainly when
 * nobody's, disputed when the rule or another person's report gives it to someone else.
 */
function ClaimDialog({ shiftId, body, onClose, say }: { shiftId: number; body: ShiftReportBody; onClose: () => void; say: (word: LineWord) => void }) {
  const read = useClaimable(shiftId, true);
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<ReadonlySet<number>>(() => new Set());
  const inReport = new Set(body.lines.map((line) => line.transactionId));
  const sales = (read.data?.sales ?? []).filter((sale) => !inReport.has(sale.transactionId) && !added.has(sale.transactionId));
  const words = query.trim().toLowerCase().replace(/^@/, "");
  const nobody = sales.filter((sale) => sale.home === "nobody");
  const found = words === "" ? [] : sales.filter((sale) => sale.home !== "nobody"
    && [sale.fan.name, sale.fan.username].some((name) => name !== null && name.toLowerCase().includes(words)));
  const claim = (sale: ShiftReportClaimableResponse["sales"][number], note: string) => {
    say({ transactionId: sale.transactionId, statement: "mine", shareWithUserId: null, shareWithName: null, note });
    setAdded(new Set([...added, sale.transactionId]));
    toast.success("Продажа добавлена в отчёт");
  };
  return (
    <Modal title="Добавить продажу" size="wide" onClose={onClose}>
      <div className="shf-claims">
        <p className="shf-claims__hint">Продажи последних 7 дней на ваших страницах, которых нет ни в одном вашем отчёте. Добавленная встанет под свою страницу с пометкой «добавлена».</p>
        {read.isPending && <Skeleton width="80%" />}
        {read.isError && <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Список не пришёл.</ErrorState>}
        {read.data && (
          <>
            <h3 className="shf-claims__title">Ничьи <span className="shf-card__hint">{nobody.length === 0 ? "нет" : plural(nobody.length, "продажа", "продажи", "продаж")}</span></h3>
            {nobody.length > 0 && <ul className="shf-sales">{nobody.map((sale) => <ClaimRow key={sale.transactionId} sale={sale} onClaim={(note) => claim(sale, note)} />)}</ul>}
            <h3 className="shf-claims__title">Другие</h3>
            <SearchInput value={query} onChange={setQuery} placeholder="Имя или логин фана" />
            {words !== "" && (found.length === 0
              ? <p className="shf-empty">Таких продаж нет.</p>
              : <ul className="shf-sales">{found.slice(0, 50).map((sale) => <ClaimRow key={sale.transactionId} sale={sale} onClaim={(note) => claim(sale, note)} />)}</ul>)}
          </>
        )}
      </div>
    </Modal>
  );
}

function AddSection({ shiftId, body, editable, own, say }: { shiftId: number; body: ShiftReportBody; editable: boolean; own: boolean; say: (word: LineWord) => void }) {
  const { add, withdraw } = useOffPlatform(shiftId);
  const [adding, setAdding] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [what, setWhat] = useState("");
  const dollars = Number(amount.replace(",", "."));
  const ready = Number.isFinite(dollars) && dollars > 0 && from.trim() !== "" && what.trim() !== "";
  if (!editable && body.offPlatform.length === 0) return null;
  const submit = () => {
    if (!ready) return;
    add.mutate({ amountMills: Math.round(dollars * 1000), fromWhom: from.trim(), whatFor: what.trim() }, {
      onSuccess: () => {
        setAdding(false);
        setAmount("");
        setFrom("");
        setWhat("");
      },
    });
  };
  return (
    <section className="shf-card shf-card--quiet" aria-labelledby="shf-add">
      <header className="shf-card__head">
        <h2 id="shf-add" className="shf-card__title">{editable ? "Добавить" : "Мимо площадки"}</h2>
        <span className="shf-card__hint">
          {editable ? "продажу, которой нет в отчёте, или деньги мимо площадки" : own ? "в итог входят, когда владелец подтвердит" : "со слов: в итог входят, когда владелец подтвердит"}
        </span>
        {editable && !adding && (
          <span className="shf-card__action shf-add-actions">
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setClaiming(true)}>Продажу</Button>
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setAdding(true)}>Мимо площадки</Button>
          </span>
        )}
      </header>
      {body.offPlatform.length > 0 && (
        <>
          {editable && <p className="shf-off-label">Мимо площадки: в итог входят, когда владелец подтвердит</p>}
          <ul className="shf-sales">
            {body.offPlatform.map((line) => (
              <li key={line.id} className="shf-sale shf-sale--off-platform">
                <span className="shf-sale__time" />
                <div className="shf-sale__main">
                  <p className="shf-sale__what"><span>{line.fromWhom}</span><span className="shf-sale__kind">{line.whatFor}</span></p>
                  <p className="shf-sale__reason">{line.state === "pending" ? "ждёт подтверждения владельца" : line.state === "confirmed" ? `владелец подтвердил${line.pageLabel ? `: в сумме ${line.pageLabel}` : ""}` : "владелец отклонил: в итог не входит"}</p>
                </div>
                <span className="shf-sale__money"><Money mills={line.amountMills} muted={line.state !== "confirmed"} /></span>
                <span className="shf-sale__act">
                  {editable && line.state === "pending" && (
                    <Button size="sm" variant="ghost" icon={X} aria-label="Убрать" title="Убрать" loading={withdraw.isPending && withdraw.variables === line.id} onClick={() => withdraw.mutate(line.id)} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {adding && (
        <div className="shf-off-form">
          <TextInput className="shf-off-form__amount" inputMode="decimal" placeholder="Сумма, $" aria-label="Сумма в долларах" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
          <TextInput placeholder="От кого" aria-label="От кого" maxLength={200} value={from} onChange={(event) => setFrom(event.target.value)} />
          <TextInput placeholder="За что" aria-label="За что" maxLength={300} value={what} onChange={(event) => setWhat(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submit(); }} />
          <Button size="md" variant="primary" disabled={!ready} loading={add.isPending} onClick={submit}>{add.isPending ? "Добавляем…" : "Добавить"}</Button>
          <Button size="md" variant="ghost" onClick={() => setAdding(false)}>Отмена</Button>
        </div>
      )}
      {claiming && <ClaimDialog shiftId={shiftId} body={body} say={say} onClose={() => setClaiming(false)} />}
    </section>
  );
}

// ───────────────────────────────────────────────────────────── The comment

function CommentSection({ shiftId, body, editable }: { shiftId: number; body: ShiftReportBody; editable: boolean }) {
  const save = useComment(shiftId);
  const [text, setText] = useState(body.comment);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const last = useRef(body.comment);
  // Hub's comment comes back with every read; the field keeps what is being typed.
  useEffect(() => {
    if (timer.current === null && text === last.current && body.comment !== last.current) {
      setText(body.comment);
      last.current = body.comment;
    }
  }, [body.comment, text]);
  const flush = (value: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (value === last.current) return;
    last.current = value;
    save.mutate(value, { onSuccess: (answer) => setSavedAt(answer.savedAt) });
  };
  if (!editable) {
    return body.comment.trim() === "" ? null : (
      <section className="shf-card shf-card--quiet" aria-labelledby="shf-comment">
        <header className="shf-card__head"><h2 id="shf-comment" className="shf-card__title">Комментарий</h2></header>
        <p className="shf-comment-text">{body.comment}</p>
      </section>
    );
  }
  return (
    <section className="shf-card shf-card--quiet" aria-labelledby="shf-comment">
      <header className="shf-card__head">
        <h2 id="shf-comment" className="shf-card__title">Комментарий</h2>
        <span className="shf-card__hint">{save.isPending ? "Сохраняем…" : savedAt !== null ? `Сохранено в ${formatTimeOfDay(savedAt)}` : "сохраняется сам"}</span>
      </header>
      <Textarea
        rows={3}
        maxLength={2000}
        aria-labelledby="shf-comment"
        placeholder="Что знать следующей смене и владельцу: кто ждёт ответа, кто обещал купить, что без оплаты"
        value={text}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => flush(value), 800);
        }}
        onBlur={() => flush(text)}
      />
    </section>
  );
}

// ───────────────────────────────────────────────────────────── Sums and «Сдать смену»

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} скопирован: вставьте его в Отчётность`),
    () => toast.error("Не получилось скопировать: браузер не дал доступ к буферу"),
  );
}

/** «Сдан в 02:11» and, quietly, how: «со слов, через Генгара», «версия 2, первая в 01:58». */
function HandedState({ report }: { report: ShiftReportResponse }) {
  const latest = report.latest!;
  const first = report.versions.at(-1);
  const how = [
    latest.madeFor !== null ? `версия ${latest.version} (${latest.madeFor})` : null,
    latest.madeFor === null && latest.door === "telegram" ? "со слов, через Генгара" : null,
    latest.madeFor === null && report.versions.length > 1 && first ? `версия ${latest.version}, первая в ${formatTimeOfDay(first.submittedAt)}` : null,
  ].filter((part): part is string => part !== null).join(", ");
  return (
    <span className="shf-totals__handed">
      <Badge tone="success">Сдан в {formatTimeOfDay((latest.madeFor !== null ? report.versions.find((one) => one.madeFor === null) ?? latest : latest).submittedAt)}</Badge>
      {how !== "" && <span className="shf-totals__how">{how}</span>}
    </span>
  );
}

/**
 * The bar at the bottom: the page sums and the total, and the one thing to do now — «Сдать смену»; once handed in,
 * «Сдан в 02:11 · Скопировать пост · Исправить»; a reader sees the state alone.
 */
function TotalsBar({ body, report, editable, fixing, onFix, submit }: {
  body: ShiftReportBody;
  report: ShiftReportResponse;
  editable: boolean;
  fixing: boolean;
  onFix: () => void;
  submit: { pending: boolean; run: () => void };
}) {
  const handed = report.state === "submitted" && report.latest !== null;
  let actions: ReactNode = null;
  if (editable) {
    actions = (
      <Button size="lg" variant="primary" loading={submit.pending} onClick={submit.run} className="shf-totals__submit">
        {submit.pending ? "Сдаём…" : handed ? "Сдать заново" : "Сдать смену"}
      </Button>
    );
  } else if (handed) {
    actions = (
      <>
        <HandedState report={report} />
        {report.posts.map((post) => (
          <Button key={post.modelName} size="md" variant="secondary" icon={Copy} onClick={() => copy(post.text, "Пост")}>
            {report.posts.length > 1 ? `Пост: ${post.modelName}` : "Скопировать пост"}
          </Button>
        ))}
        {report.canEdit && !fixing && <Button size="md" variant="ghost" onClick={onFix}>Исправить</Button>}
      </>
    );
  }
  return (
    <section className={editable || !handed ? "shf-totals" : "shf-totals shf-totals--handed"} aria-label="Итог отчёта">
      <ul className="shf-totals__pages">
        {body.pages.map((page) => (
          <li key={page.pageLabel}><PageLabel label={page.pageLabel} /> <Money mills={page.amountMills} muted={page.amountMills === 0} /></li>
        ))}
      </ul>
      <span className="shf-totals__sum">
        <span className="shf-totals__label">Итого</span>
        <Money mills={body.totalMills} strong />
        {report.state === "open" && <Tooltip content="Пока смена не сдана, сумма считается по правилу и вашим отметкам и может измениться: придут продажи, поменяется правило."><span className="shf-totals__pre">предварительно</span></Tooltip>}
      </span>
      {actions !== null && <span className="shf-totals__actions">{actions}</span>}
    </section>
  );
}

// ───────────────────────────────────────────────────────────── The screen

function ScreenSkeleton() {
  return (
    <div className="wb-content shf" aria-hidden>
      <Skeleton width={360} height={20} />
      <div className="shf-card"><Skeleton width="60%" /><Skeleton width="90%" /><Skeleton width="80%" /></div>
    </div>
  );
}

export function ShiftScreen() {
  const params = useParams();
  const [search] = useSearchParams();
  const shiftId = Number(params.shiftId);
  const focusParam = Number(search.get("sale"));
  const { role } = useMe();
  const back = useBackTarget(role === "chatter" ? { to: "/my/shifts", label: "Мои смены" } : { to: "/shifts", label: "Смены" });
  const read = useShiftReport(shiftId);
  const lineWord = useLineWord(shiftId);
  const submit = useSubmit(shiftId);
  const [fixing, setFixing] = useState(false);
  const report = read.data;

  if (!Number.isSafeInteger(shiftId) || shiftId <= 0) {
    return (
      <>
        <ScreenHeader title="Смена" back={back} />
        <div className="wb-content shf"><EmptyState title="Такой смены нет">Адрес неполный: откройте смену из списка.</EmptyState></div>
      </>
    );
  }
  if (!report) {
    return (
      <>
        <ScreenHeader title="Смена" back={back} />
        {read.isError
          ? <div className="wb-content shf"><ErrorState onRetry={() => void read.refetch()} retrying={read.isFetching}>Смена не пришла. Это не значит, что её нет: экран её просто не получил.</ErrorState></div>
          : <ScreenSkeleton />}
      </>
    );
  }

  const own = report.access === "own";
  const when = shiftWhen({ startedAt: report.shift.startedAt, endedAt: report.shift.endedAt, ongoing: report.shift.ongoing, workedMinutes: report.shift.workedMinutes });
  const handed = report.state === "submitted";
  const editable = report.canEdit && (!handed || fixing);
  const edit: Editing = { editable, shiftStart: report.shift.startedAt, colleagues: report.colleagues, say: (word) => lineWord.mutate(word) };
  const body = report.view;
  const hint = shiftDurationHint(when);
  // The claims of the report's sales: each under its line; one of the reader's sales that is not a line, above.
  const lineIds = new Set(body?.lines.map((line) => line.transactionId) ?? []);
  const claimsOf = new Map<number, ShiftReportClaim[]>();
  for (const claim of report.claims) {
    if (claim.transactionId === null || !lineIds.has(claim.transactionId)) continue;
    claimsOf.set(claim.transactionId, [...(claimsOf.get(claim.transactionId) ?? []), claim]);
  }
  const loose = report.claims.filter((claim) => claim.direction === "incoming" && (claim.transactionId === null || !lineIds.has(claim.transactionId)));
  const lineClaims: LineClaims = { shiftId, own, of: claimsOf, focus: Number.isSafeInteger(focusParam) && focusParam > 0 ? focusParam : null };

  let status: ReactNode;
  if (handed) status = null;
  else if (report.shift.ongoing) status = <Badge tone="info" bare>Идёт</Badge>;
  else status = <Badge tone="warning">{own ? "Сдайте смену" : "Не сдан"}</Badge>;

  const submitRun = { pending: submit.isPending, run: () => submit.mutate(undefined, { onSuccess: () => setFixing(false) }) };

  const title = own ? "Смена" : `Смена: ${report.shift.personName}`;
  const meta = (
    <span className="shf-meta">
      <span>{when.days} {when.time}</span>
      {when.worked !== null && <Tooltip content={hint ?? ""}><span>{when.worked}</span></Tooltip>}
      {report.shift.pages.length > 0 && <span>{report.shift.pages.join(", ")}</span>}
      {status}
    </span>
  );

  return (
    <>
      <ScreenHeader
        title={title}
        documentTitle={own ? `Смена ${when.days}` : `${report.shift.personName}, ${when.days}`}
        back={back}
        meta={meta}
        updatedAt={read.dataUpdatedAt}
        onRefresh={() => void read.refetch()}
        refreshing={read.isFetching}
        stale={read.isRefetchError}
      />
      <div className="wb-content shf">
        {own && !report.enabled && (
          <Notice title="Сдача смены здесь ещё не включена">Отчёт по-прежнему собирает Генгар по /smena, а вы отправляете его в Отчётность. Здесь видно, как его посчитает Hub.</Notice>
        )}
        {own && handed && report.afterSubmission && (
          <Notice
            tone="warning"
            title={`После сдачи: ${plural(report.afterSubmission.count, "продажа", "продажи", "продаж")} на ${formatMills(report.afterSubmission.mills)}`}
            action={report.canEdit ? <Button size="md" variant="primary" loading={submit.isPending} onClick={() => submit.mutate(undefined)}>{submit.isPending ? "Досдаём…" : "Досдать"}</Button> : undefined}
          >
            Они пришли или стали вашими уже после того, как вы сдали смену.
          </Notice>
        )}
        {fixing && <p className="shf-fixing">Вы исправляете сданный отчёт: отметки сохраняются сразу, а в отчёт попадут, когда вы сдадите его заново.</p>}
        <ClaimsContext.Provider value={lineClaims}>
        {own && <LooseClaims claims={loose} shiftId={shiftId} />}
        {body === null ? (
          <EmptyState title="Смена ещё не сдана">Отчёт появится здесь, когда {report.shift.personName} сдаст смену.</EmptyState>
        ) : (
          <>
            {body.cut && <p className="shf-cut">Показаны только ваши страницы.</p>}
            <MineSection body={body} edit={edit} own={own} />
            <NearSection body={body} edit={edit} own={own} />
            {(own || body.offPlatform.length > 0) && <AddSection shiftId={shiftId} body={body} editable={editable} own={own} say={edit.say} />}
            <CommentSection key={`${editable}`} shiftId={shiftId} body={body} editable={editable} />
            <TotalsBar body={body} report={report} editable={editable} fixing={fixing} onFix={() => setFixing(true)} submit={submitRun} />
            {!editable && body.source === "draft" && !own && <p className="shf-cut">Черновик: смена ещё не сдана, суммы предварительные.</p>}
          </>
        )}
        </ClaimsContext.Provider>
      </div>
    </>
  );
}
