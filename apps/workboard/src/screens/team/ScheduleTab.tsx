import { CalendarPlus, Pencil } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Card, Disclosure, ErrorState, Field, Modal, Notice, Select, SkeletonText, Switch, Table, TextInput, Textarea, toast, type Column } from "@agency_hub_core/ui";
import { formatDay, formatMills } from "@agency_hub_core/ui/format";
import { addDays, moscowToday } from "@agency_hub_core/ui/moscow";
import { EMPTY_SLOT, SlotFields, WorkingPagesPicker, fixMills, shareBasisPoints, shareText, slotBody, slotProblem, type SlotDraft } from "@agency_hub_core/ui/people/forms";
import { slotWords, weekdaysWords, type Weekday } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import {
  refusal,
  useCatalogPages,
  useSetPayTerm,
  useTermsHubFrom,
  useUpdatePerson,
  type OwnerCard,
  type PayTerm,
  type RegistryPerson,
  type Slot,
} from "./registry.js";

/**
 * «График и условия» of a person's card in «Команда»: how the person works —
 * the working pages in order (the first is the main one), the slots by Moscow
 * time with a page's own line where it differs — and, for the owner only, the
 * pay terms by model with their history (chat-team money stays in Workboard).
 * Every change goes from a day: a new slot or new terms end the ones before the
 * day before. A team lead reads the person's pages and slot and nothing of money
 * (their session never asks for it). Who the person is and their rights are Hub
 * «Люди».
 */
export function ScheduleTab({ person, card, cardFailed, onRetry, isOwner }: {
  person: RegistryPerson;
  /** The owner's card (`adminPerson`); undefined while it comes, and always for a team lead. */
  card: OwnerCard | undefined;
  cardFailed: boolean;
  onRetry: () => void;
  isOwner: boolean;
}) {
  const [editing, setEditing] = useState<"pages" | "schedule" | "terms" | null>(null);
  const termsHubFrom = useTermsHubFrom(isOwner && person.kind === "human");
  return (
    <div className="registry-tab">
      {isOwner && cardFailed && !card && (
        <Notice tone="warning" role="alert" action={<Button size="sm" onClick={onRetry}>Повторить</Button>}>
          Карточка владельца не пришла: история графика и условия оплаты не показаны.
        </Notice>
      )}
      <div className="people-grid">
        <PagesBlock person={person} onEdit={isOwner ? () => setEditing("pages") : undefined} />
        <ScheduleBlock person={person} slots={card?.scheduleSlots ?? null} onEdit={isOwner && person.kind === "human" ? () => setEditing("schedule") : undefined} />
        {isOwner && person.kind === "human" && (
          <div className="people-grid__wide">
            {card ? <TermsBlock terms={card.payTerms} payout={card.payoutDetails} termsHubFrom={termsHubFrom} onAdd={() => setEditing("terms")} /> : cardFailed ? null : <Card title="Условия оплаты"><SkeletonText lines={3} /></Card>}
          </div>
        )}
      </div>
      {editing === "pages" && <PagesModal person={person} onClose={() => setEditing(null)} />}
      {editing === "schedule" && <ScheduleModal person={person} slots={card?.scheduleSlots ?? null} onClose={() => setEditing(null)} />}
      {editing === "terms" && card && <TermsModal person={person} terms={card.payTerms} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditButton({ onClick, children = "Изменить" }: { onClick: () => void; children?: ReactNode }) {
  return <Button size="sm" variant="ghost" icon={Pencil} onClick={onClick}>{children}</Button>;
}

function PagesBlock({ person, onEdit }: { person: RegistryPerson; onEdit: (() => void) | undefined }) {
  return (
    <Card
      title={<>Рабочие страницы <span className="access-count">{person.workingPages.length}</span></>}
      description="На чём человек работает, по порядку. Доступ входа к страницам открывают в Hub, в «Людях»."
      actions={onEdit && <EditButton onClick={onEdit} />}
    >
      {person.workingPages.length === 0 ? <p className="access-text">Рабочих страниц нет.</p> : (
        <ol className="registry-order registry-order--read">
          {person.workingPages.map((page, index) => (
            <li key={page.pageLabel} className="registry-order__row">
              <span className="registry-order__place">{index + 1}</span>
              <span className="ui-page">{page.pageLabel}</span>
              <span className="access-hint">{page.modelName}{index === 0 ? " · основная" : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** A slot's dates: «с 14 сент.», «с 14 сент. по 30 окт.», «с 20 нояб., ещё не начался». */
function slotDates(slot: Pick<Slot, "validFrom" | "validTo">, today: string): string {
  const from = slot.validFrom ? `с ${formatDay(slot.validFrom)}` : "с какого дня, неизвестно";
  if (slot.validTo) return `${from} по ${formatDay(slot.validTo)}`;
  return slot.validFrom && slot.validFrom > today ? `${from}, ещё не начался` : from;
}

function SlotLine({ slot, today, quiet = false }: { slot: Slot; today: string; quiet?: boolean }) {
  const words = slotWords(slot);
  return (
    <li className={quiet ? "registry-slot-line registry-slot-line--quiet" : "registry-slot-line"}>
      <span className="registry-slot-line__hours">{words.hours}</span>
      <span>{words.days || "дни не заданы"}</span>
      <span className="access-hint">{slotDates(slot, today)}</span>
    </li>
  );
}

/**
 * A caveat under the schedule while what is set here does not reach its readers; null — none. The shift report reads
 * a person's slot from their card in the agency's knowledge base, and since 2026-11-13 Hub's people mirror writes the
 * card's header from this registry every hour: a slot set here is the slot the report reads.
 */
const SLOT_SOURCE_NOTE: string | null = null;

/**
 * The slots, by line: the person's line for every page, then each page that has its own; under each line its earlier and
 * later slots (the owner's card has them all; a team lead sees what holds now).
 */
function ScheduleBlock({ person, slots, onEdit }: { person: RegistryPerson; slots: readonly Slot[] | null; onEdit: (() => void) | undefined }) {
  const today = moscowToday();
  const lines = scheduleLines(person, slots);
  return (
    <Card
      title="График"
      description={<>Время московское. Слот решает, чья продажа на стыке смен.{SLOT_SOURCE_NOTE && <span className="registry-source">{SLOT_SOURCE_NOTE}</span>}</>}
      actions={onEdit && <Button size="sm" variant="ghost" icon={CalendarPlus} onClick={onEdit}>Изменить с даты</Button>}
    >
      {lines.length === 0 ? <p className="access-text">Графика нет.</p> : (
        <div className="registry-lines">
          {lines.map((line) => {
            // What holds today, what begins later (in sight: it is the plan), what ended (folded).
            const holding = line.all.filter((slot) => (slot.validFrom === null || slot.validFrom <= today) && (slot.validTo === null || slot.validTo >= today));
            const later = line.all.filter((slot) => slot.validFrom !== null && slot.validFrom > today);
            const ended = line.all.filter((slot) => slot.validTo !== null && slot.validTo < today);
            return (
              <div key={line.pageLabel ?? "all"} className="registry-line">
                <span className="registry-line__name">{line.pageLabel ? <>своя строка <span className="ui-page">{line.pageLabel}</span></> : "все страницы"}</span>
                <ul className="registry-slot-lines">
                  {holding.map((slot) => <SlotLine key={slot.id} slot={slot} today={today} />)}
                  {holding.length === 0 && <li className="access-hint">сегодня слота нет</li>}
                  {later.map((slot) => <SlotLine key={slot.id} slot={slot} today={today} />)}
                  {ended.length > 0 && (
                    <li>
                      <Disclosure summary="Прежние слоты" hint={String(ended.length)}>
                        <ul className="registry-slot-lines">{[...ended].reverse().map((slot) => <SlotLine key={slot.id} slot={slot} today={today} quiet />)}</ul>
                      </Disclosure>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

interface ScheduleLine {
  pageLabel: string | null;
  current: Slot | null;
  /** Oldest first. */
  all: Slot[];
}

/** The slot holding on `today` of a line, else the next one to begin (the service's `currentSlot`). */
function currentOf(slots: readonly Slot[], today: string): Slot | null {
  let holding: Slot | null = null;
  for (const slot of slots) if ((slot.validFrom === null || slot.validFrom <= today) && (slot.validTo === null || slot.validTo >= today)) holding = slot;
  return holding ?? slots.find((slot) => slot.validFrom !== null && slot.validFrom > today) ?? null;
}

function scheduleLines(person: RegistryPerson, slots: readonly Slot[] | null): ScheduleLine[] {
  const today = moscowToday();
  if (slots === null) {
    const lines: ScheduleLine[] = [];
    if (person.schedule) lines.push({ pageLabel: null, current: person.schedule, all: [person.schedule] });
    for (const slot of person.pageSchedules) lines.push({ pageLabel: slot.pageLabel, current: slot, all: [slot] });
    return lines;
  }
  const labels = [null, ...new Set(slots.flatMap((slot) => (slot.pageLabel === null ? [] : [slot.pageLabel])))];
  return labels.flatMap((label) => {
    const all = slots.filter((slot) => slot.pageLabel === label);
    return all.length === 0 ? [] : [{ pageLabel: label, current: currentOf(all, today), all }];
  });
}

// ── pay terms (the owner's only), and where to transfer as the person wrote it on «Начало» ─────

/**
 * The terms card's one quiet line while the ledger does not price the days by these terms (its switch
 * `payroll_terms_hub_from`, `termsHubFrom`): the payout sheets accrue. Gone once the ledger says the day has come;
 * nothing while its word is not known.
 */
function termsSourceLine(termsHubFrom: string | null | undefined, today: string): string | null {
  if (termsHubFrom === undefined || (termsHubFrom !== null && termsHubFrom <= today)) return null;
  return termsHubFrom === null
    ? "Пока начисляет таблица выплат: условия отсюда начнут действовать с даты включения."
    : `Пока начисляет таблица выплат: условия отсюда начнут действовать с ${formatDay(termsHubFrom)}.`;
}

function TermsBlock({ terms, payout, termsHubFrom, onAdd }: { terms: readonly PayTerm[]; payout: OwnerCard["payoutDetails"]; termsHubFrom: string | null | undefined; onAdd: () => void }) {
  const today = moscowToday();
  const source = termsSourceLine(termsHubFrom, today);
  const rows = [...terms].sort((a, b) => a.modelName.localeCompare(b.modelName, "ru") || b.validFrom.localeCompare(a.validFrom));
  const holds = (term: PayTerm) => term.validFrom <= today && (term.validTo === null || term.validTo >= today);
  const columns: Column<PayTerm>[] = [
    { key: "model", header: "Модель", cell: (term) => <span className={holds(term) ? "registry-strong" : undefined}>{term.modelName}</span> },
    { key: "share", header: "Доля", numeric: true, cell: (term) => `${shareText(term.shareBasisPoints)} %` },
    { key: "fix", header: "Фикс за день со сменой", numeric: true, cell: (term) => (term.fixPerShiftMills === 0 ? <span className="people-dash">нет</span> : formatMills(term.fixPerShiftMills)) },
    { key: "dates", header: "Действуют", nowrap: true, cell: (term) => `с ${formatDay(term.validFrom)}${term.validTo ? ` по ${formatDay(term.validTo)}` : holds(term) ? ", сейчас" : term.validFrom > today ? ", ещё не начались" : ""}` },
    { key: "note", header: "Заметка", grow: true, cell: (term) => term.note ?? <span className="people-dash">—</span> },
  ];
  return (
    <Card
      title="Условия оплаты"
      description={<>Видите только вы. Доля от дохода модели и фикс за день со сменой; новые условия с даты заканчивают прежние накануне.{source && <span className="registry-source">{source}</span>}</>}
      actions={<Button size="sm" icon={CalendarPlus} onClick={onAdd}>Новые условия с даты</Button>}
      padding={rows.length === 0 ? "md" : "none"}
      footer={<span className="registry-payout">Куда платить: {payout ? <span className="registry-payout__text">{payout.text}</span> : "человек не написал в Hub"}</span>}
    >
      {rows.length === 0 ? <p className="access-text">Условий оплаты нет.</p> : (
        <Table label="Условия оплаты" frame="bare" columns={columns} rows={rows} rowKey={(term) => String(term.id)} rowQuiet={(term) => !holds(term)} />
      )}
    </Card>
  );
}

// ── the windows of change ────────────────────────────────────────────────────

function PagesModal({ person, onClose }: { person: RegistryPerson; onClose: () => void }) {
  const update = useUpdatePerson(person.code);
  const pages = useCatalogPages();
  const [value, setValue] = useState(person.workingPages.map((page) => page.pageLabel));
  const [problem, setProblem] = useState<string | null>(null);
  const same = value.join("\u0000") === person.workingPages.map((page) => page.pageLabel).join("\u0000");
  return (
    <Modal
      title={`Рабочие страницы: ${person.displayName}`}
      size="wide"
      onClose={() => { if (!update.isPending) onClose(); }}
      explicitCloseOnly={!same || update.isPending}
      actions={(
        <>
          <Button disabled={update.isPending} onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            disabled={same}
            loading={update.isPending}
            onClick={() => update.mutate({ workingPageLabels: value }, {
              onSuccess: () => {
                toast.success("Рабочие страницы сохранены");
                onClose();
              },
              onError: (error) => setProblem(refusal(error).status === 404 ? "Одной из страниц больше нет: обновите экран." : "Не удалось сохранить: Hub вернул ошибку."),
            })}
          >
            {update.isPending ? "Сохраняем…" : "Сохранить"}
          </Button>
        </>
      )}
    >
      <div className="access-invite">
        <p className="access-text">Первая в списке: основная. Доступ входа к страницам не меняется: его открывают во вкладке «Доступ и входы».</p>
        {pages.data ? <WorkingPagesPicker pages={pages.data} value={value} onChange={setValue} disabled={update.isPending} />
          : pages.isError ? <ErrorState compact onRetry={() => void pages.refetch()} /> : <SkeletonText lines={4} />}
        {problem && <Notice tone="danger" role="alert">{problem}</Notice>}
      </div>
    </Modal>
  );
}

/** The service's refusals of a schedule change, in the owner's words. */
function scheduleRefusal(error: unknown): string {
  const { status, message } = refusal(error);
  const after = /slot from (\d{4}-\d{2}-\d{2})/.exec(message);
  if (after) return `На этой строке есть слот с ${formatDay(after[1]!)}: новый начинается не раньше.`;
  if (/give the day the change begins/.test(message)) return "У человека уже есть график: укажите день, с которого он меняется.";
  if (/A slot begins on/.test(message)) return "С этого дня уже начинается слот: задайте сам слот или другой день.";
  if (/A shift lasts/.test(message)) return "Смена длится от 1 до 16 часов.";
  if (status === 404) return "Страница не нашлась: обновите экран.";
  return "Не удалось сохранить график: Hub вернул ошибку.";
}

function ScheduleModal({ person, slots, onClose }: { person: RegistryPerson; slots: readonly Slot[] | null; onClose: () => void }) {
  const update = useUpdatePerson(person.code);
  const lines = scheduleLines(person, slots);
  const pageChoices = [...new Set([...person.workingPages.map((page) => page.pageLabel), ...lines.flatMap((line) => (line.pageLabel ? [line.pageLabel] : []))])];
  const [line, setLine] = useState<string>("");
  const pageLabel = line === "" ? null : line;
  const ofLine = (slots ?? []).filter((slot) => slot.pageLabel === pageLabel);
  const latest = ofLine.at(-1) ?? null;
  const holding = lines.find((one) => one.pageLabel === pageLabel)?.current ?? null;
  const [from, setFrom] = useState(addDays(moscowToday(), 1));
  const [off, setOff] = useState(false);
  const [draft, setDraft] = useState<SlotDraft>(() => (holding
    ? { start: holding.start, end: holding.end === "24:00" ? "00:00" : holding.end, weekdays: (holding.weekdays ?? []) as Weekday[] }
    : EMPTY_SLOT));
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(from);
  const local = !dateOk ? "Укажите день, с которого действует изменение."
    : latest?.validFrom && latest.validFrom > from ? `На этой строке есть слот с ${formatDay(latest.validFrom)}: новый начинается не раньше.`
      : off && latest?.validFrom === from ? "С этого дня уже начинается слот: задайте сам слот или другой день."
        : off && !latest ? "На этой строке графика и так нет."
          : off ? null : slotProblem(draft);

  function save() {
    setTried(true);
    if (local !== null || update.isPending) return;
    setProblem(null);
    update.mutate({ schedule: { pageLabel, from, slot: off ? null : slotBody(draft) } }, {
      onSuccess: () => {
        toast.success(off ? `С ${formatDay(from)} без графика` : `График с ${formatDay(from)} сохранён`);
        onClose();
      },
      onError: (error) => setProblem(scheduleRefusal(error)),
    });
  }

  return (
    <Modal
      title={`График с даты: ${person.displayName}`}
      onClose={() => { if (!update.isPending) onClose(); }}
      explicitCloseOnly
      size="wide"
      actions={(
        <>
          <Button disabled={update.isPending} onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={tried && local !== null} loading={update.isPending} onClick={save}>{update.isPending ? "Сохраняем…" : "Сохранить с этой даты"}</Button>
        </>
      )}
    >
      <div className="access-invite">
        <div className="registry-form__row">
          <Field label="Строка графика" hint="Своя строка страницы действует на ней вместо общей.">
            {(control) => (
              <Select {...control} value={line} onChange={(event) => setLine(event.target.value)}>
                <option value="">Все страницы</option>
                {pageChoices.map((label) => <option key={label} value={label}>{label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="С даты" hint="Прежний слот закончится накануне.">
            {(control) => <TextInput {...control} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />}
          </Field>
        </div>
        {holding && <p className="access-text">Сейчас: {slotWords(holding).hours}{slotWords(holding).days ? `, ${slotWords(holding).days}` : ""} ({slotDates(holding, moscowToday())}).</p>}
        <Switch label="С этой даты без графика" checked={off} onChange={setOff} />
        {!off && <SlotFields idPrefix="schedule-slot" value={draft} onChange={setDraft} disabled={update.isPending} />}
        {tried && local !== null && <p className="ui-field__error" role="alert">{local}</p>}
        {problem && <Notice tone="danger" role="alert">{problem}</Notice>}
      </div>
    </Modal>
  );
}

function TermsModal({ person, terms, onClose }: { person: RegistryPerson; terms: readonly PayTerm[]; onClose: () => void }) {
  const set = useSetPayTerm(person.code);
  const pages = useCatalogPages();
  const models = [...new Map((pages.data ?? []).map((page) => [page.modelSlug, page.modelName])).entries()];
  const firstModel = person.workingPages[0]?.modelSlug ?? terms[0]?.modelSlug ?? models[0]?.[0] ?? "";
  const [model, setModel] = useState(firstModel);
  const holding = [...terms].filter((term) => term.modelSlug === model).at(-1) ?? null;
  const [from, setFrom] = useState(moscowToday());
  const [share, setShare] = useState(holding ? shareText(holding.shareBasisPoints) : "");
  const [fix, setFix] = useState(holding && holding.fixPerShiftMills > 0 ? String(holding.fixPerShiftMills / 1000) : "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const shareValue = shareBasisPoints(share);
  const fixValue = fixMills(fix);
  const sameDay = terms.find((term) => term.modelSlug === model && term.validFrom === from) ?? null;
  const local = !model ? "Выберите модель."
    : !/^\d{4}-\d{2}-\d{2}$/.test(from) ? "Укажите день, с которого действуют условия."
      : shareValue === null ? "Доля: число от 0 до 100."
        : fixValue === null ? "Фикс: сумма в долларах, например 5 или 7.50."
          : null;
  const modelName = models.find(([slug]) => slug === model)?.[1] ?? holding?.modelName ?? model;

  function save() {
    setTried(true);
    if (local !== null || set.isPending || shareValue === null || fixValue === null) return;
    setProblem(null);
    set.mutate({ modelSlug: model, validFrom: from, shareBasisPoints: shareValue, fixPerShiftMills: fixValue, note: note.trim() || null }, {
      onSuccess: () => {
        toast.success(`Условия ${modelName} с ${formatDay(from)} сохранены`);
        onClose();
      },
      onError: (error) => setProblem(refusal(error).status === 404 ? "Такой модели нет в Hub: обновите экран." : "Не удалось сохранить условия: Hub вернул ошибку."),
    });
  }

  return (
    <Modal
      title={`Условия оплаты с даты: ${person.displayName}`}
      onClose={() => { if (!set.isPending) onClose(); }}
      explicitCloseOnly
      actions={(
        <>
          <Button disabled={set.isPending} onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={tried && local !== null} loading={set.isPending} onClick={save}>{set.isPending ? "Сохраняем…" : sameDay ? "Исправить условия дня" : "Сохранить с этой даты"}</Button>
        </>
      )}
    >
      <div className="access-invite">
        <div className="registry-form__row">
          <Field label="Модель">
            {(control) => (
              <Select {...control} value={model} onChange={(event) => setModel(event.target.value)}>
                {models.length === 0 && model && <option value={model}>{modelName}</option>}
                {models.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="С даты" hint={sameDay ? "С этого дня условия уже есть: они будут исправлены." : "Прежние условия модели закончатся накануне."}>
            {(control) => <TextInput {...control} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />}
          </Field>
        </div>
        <div className="registry-form__row">
          <Field label="Доля, %">
            {(control) => <TextInput {...control} data-autofocus inputMode="decimal" value={share} placeholder="25" onChange={(event) => setShare(event.target.value)} />}
          </Field>
          <Field label="Фикс за день со сменой, $" hint="Пусто: без фикса.">
            {(control) => <TextInput {...control} inputMode="decimal" value={fix} placeholder="0" onChange={(event) => setFix(event.target.value)} />}
          </Field>
        </div>
        <Field label="Заметка">
          {(control) => <TextInput {...control} value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />}
        </Field>
        {holding && (
          <p className="access-text">
            Сейчас по {holding.modelName}: {shareText(holding.shareBasisPoints)} %{holding.fixPerShiftMills > 0 ? ` и ${formatMills(holding.fixPerShiftMills)} за день со сменой` : ", без фикса"}, с {formatDay(holding.validFrom)}.
          </p>
        )}
        {tried && local !== null && <p className="ui-field__error" role="alert">{local}</p>}
        {problem && <Notice tone="danger" role="alert">{problem}</Notice>}
      </div>
    </Modal>
  );
}
