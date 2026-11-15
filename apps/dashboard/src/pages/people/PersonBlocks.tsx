import { Check, Pencil, RotateCcw, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AdminPersonUpdateBody } from "@agency_hub_core/contracts";
import { Badge, Button, Card, Field, KeyValue, Modal, Notice, Select, Switch, TextInput, Textarea, toast } from "@agency_hub_core/ui";
import { formatDay } from "@agency_hub_core/ui/format";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { refusal, type Proposal, type RegistryPerson } from "@agency_hub_core/ui/people/registry";
import { PERSON_ROLE_WORD, PERSON_STATE_WORD, slotWords } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useDecideProposal, useSettleImportNote, useUpdatePerson } from "./registry";

/**
 * The registry's blocks of a person's card in Hub «Люди» (they were Workboard's «График и условия»): who the person is
 * («Человек»), their narrow rights («Команды и права»), what the import found and what the agents propose (open on
 * «Человек», decided on «История»), and the window that changes the record. Every write is the owner's own edit
 * (`adminPersonUpdate`), audited on the server.
 */

// ── what waits for the owner: import notes and proposals ─────────────────────

/** What waits for the owner on this person: the import's open disagreements and the agents' open proposals. */
export function WaitingBlock({ person, proposals }: { person: RegistryPerson; proposals: readonly Proposal[] }) {
  const open = person.importNotes.map((note, index) => ({ note, index })).filter(({ note }) => note.settledAt === null);
  const waiting = proposals.filter((one) => one.state === "open");
  if (open.length === 0 && waiting.length === 0) return null;
  return (
    <div className="registry-waiting">
      <Card title="Ждут вас" description="Что импорт нашёл не так, как в других источниках, и что предлагают агенты.">
        <ul className="access-list registry-items">
          {waiting.map((proposal) => <ProposalRow key={`p${proposal.id}`} proposal={proposal} code={person.code} />)}
          {open.map(({ note, index }) => <NoteRow key={`n${index}`} code={person.code} index={index} note={note} />)}
        </ul>
      </Card>
    </div>
  );
}

/** What was settled and decided about this person: the import's notes marked «Сверено», the agents' decided proposals. */
export function DecidedBlock({ person, proposals }: { person: RegistryPerson; proposals: readonly Proposal[] }) {
  const settled = person.importNotes.map((note, index) => ({ note, index })).filter(({ note }) => note.settledAt !== null);
  const decided = proposals.filter((one) => one.state !== "open");
  return (
    <Card title={<>Сверено и решено <span className="access-count">{settled.length + decided.length}</span></>} description="Предложения агентов и расхождения импорта, по которым вы уже ответили.">
      {settled.length + decided.length === 0 ? <p className="access-text">Пока ничего.</p> : (
        <ul className="access-list access-list--quiet registry-items">
          {decided.map((proposal) => <ProposalRow key={`p${proposal.id}`} proposal={proposal} code={person.code} />)}
          {settled.map(({ note, index }) => <NoteRow key={`n${index}`} code={person.code} index={index} note={note} />)}
        </ul>
      )}
    </Card>
  );
}

function NoteRow({ code, index, note }: { code: string; index: number; note: RegistryPerson["importNotes"][number] }) {
  const settle = useSettleImportNote(code);
  const run = (settled: boolean) => settle.mutate({ index, code: note.code, settled }, {
    onSuccess: () => toast.success(settled ? "Отмечено: сверено" : "Расхождение снова ждёт сверки"),
    onError: (error) => toast.error(refusal(error).status === 409 ? "Расхождения изменились: обновите карточку." : "Не удалось: Hub вернул ошибку."),
  });
  return (
    <li className="access-list__row">
      <span className="access-list__main">
        <span><Badge tone={note.settledAt ? "off" : "warning"} bare>Расхождение импорта</Badge> {note.text}</span>
        {note.settledAt && <span className="access-hint">сверено {formatDay(note.settledAt)}</span>}
      </span>
      {note.settledAt
        ? <Button size="sm" variant="ghost" icon={RotateCcw} loading={settle.isPending} onClick={() => run(false)}>Вернуть</Button>
        : <Button size="sm" icon={Check} loading={settle.isPending} onClick={() => run(true)}>Сверено</Button>}
    </li>
  );
}

export function ProposalRow({ proposal, code }: { proposal: Proposal; code: string }) {
  const decide = useDecideProposal();
  const [asked, setAsked] = useState<"accept" | "reject" | null>(null);
  const run = (decision: "accept" | "reject") => {
    setAsked(decision);
    decide.mutate({ proposalId: proposal.id, decision, code }, {
      onSuccess: () => toast.success(decision === "accept" ? "Предложение принято" : "Предложение отклонено"),
      onError: (error) => {
        const { status } = refusal(error);
        toast.error(status === 409 ? "Предложение уже решено или больше не подходит: обновите карточку." : "Не удалось: Hub вернул ошибку.");
      },
    });
  };
  const by = [proposal.agentKeyName, proposal.requestedBy ? `просил ${proposal.requestedBy}` : null, proposal.sourceRef].filter(Boolean).join(" · ");
  return (
    <li className="access-list__row">
      <span className="access-list__main">
        <span>
          <Badge tone={proposal.state === "open" ? "info" : "off"} bare>Предложение агента</Badge>{" "}
          {proposalLines(proposal).join("; ")}
        </span>
        <span className="access-hint">«{proposal.reason}» · {by} · {formatDay(proposal.createdAt)}</span>
        {proposal.state !== "open" && (
          <span className="access-hint">{proposal.state === "accepted" ? "принято" : proposal.state === "rejected" ? "отклонено" : "отозвано"}{proposal.decidedAt ? ` ${formatDay(proposal.decidedAt)}` : ""}</span>
        )}
      </span>
      {proposal.state === "open" && (
        <span className="registry-actions">
          <Button size="sm" variant="primary" icon={Check} loading={decide.isPending && asked === "accept"} disabled={decide.isPending} onClick={() => run("accept")}>Принять</Button>
          <Button size="sm" variant="ghost" icon={X} loading={decide.isPending && asked === "reject"} disabled={decide.isPending} onClick={() => run("reject")}>Отклонить</Button>
        </span>
      )}
    </li>
  );
}

/** What a proposal changes, in the owner's words. */
export function proposalLines(proposal: Pick<Proposal, "change">): string[] {
  const change = proposal.change as { kind?: string; change?: Record<string, unknown>; person?: Record<string, unknown> };
  const fields = (change.kind === "create" ? change.person : change.change) ?? {};
  const lines: string[] = [];
  if (change.kind === "create") {
    const role = typeof fields.role === "string" ? PERSON_ROLE_WORD[fields.role] ?? fields.role : "";
    lines.push(`новый человек: ${String(fields.displayName ?? fields.code ?? "")}${role ? `, ${role.toLowerCase()}` : ""}, код ${String(fields.code ?? "")}`);
  }
  if (change.kind !== "create" && typeof fields.displayName === "string") lines.push(`имя: ${fields.displayName}`);
  if (change.kind !== "create" && typeof fields.role === "string") lines.push(`роль: ${(PERSON_ROLE_WORD[fields.role] ?? fields.role).toLowerCase()}`);
  if (typeof fields.state === "string") lines.push(`состояние: ${PERSON_STATE_WORD[fields.state] ?? fields.state}`);
  if (typeof fields.leftOn === "string") lines.push(`день ухода: ${formatDay(fields.leftOn)}`);
  const telegram = fields.telegram as { userId?: unknown; handle?: unknown; reportTag?: unknown } | undefined;
  if (telegram) {
    if (typeof telegram.handle === "string") lines.push(`Telegram: @${telegram.handle.replace(/^@/, "")}`);
    if (typeof telegram.userId === "number") lines.push(`Telegram id: ${telegram.userId}`);
    if (typeof telegram.reportTag === "string") lines.push(`тег отчёта: ${telegram.reportTag}`);
  }
  if (Array.isArray(fields.workingPageLabels)) lines.push(`рабочие страницы: ${(fields.workingPageLabels as string[]).join(", ") || "нет"}`);
  const schedule = fields.schedule as { pageLabel?: string | null; from?: string | null; slot?: { start: string; end: string; weekdays?: string[] | null } | null } | undefined;
  if (schedule) {
    const where = schedule.pageLabel ? ` на ${schedule.pageLabel}` : "";
    const when = schedule.from ? ` с ${formatDay(schedule.from)}` : "";
    if (schedule.slot) {
      const words = slotWords({ start: schedule.slot.start, end: schedule.slot.end, weekdays: schedule.slot.weekdays ?? null });
      lines.push(`график${where}${when}: ${words.hours}${words.days ? `, ${words.days}` : ""}`);
    } else {
      lines.push(`без графика${where}${when}`);
    }
  }
  if (Array.isArray(fields.rights)) {
    const rights = fields.rights as string[];
    const words = [rights.includes("customs_lead") ? "ведёт кастомы" : null, rights.includes("records_customs") ? "записывает кастомы в системе" : null, rights.includes("submits_shift") ? "сдаёт смену доской" : null, rights.includes("sees_own_pay") ? "видит свои деньги" : null].filter(Boolean);
    lines.push(words.length > 0 ? words.join(", ") : "без узких прав");
  }
  if (typeof fields.note === "string") lines.push(`заметка: ${fields.note}`);
  const logins = fields.logins as { add?: unknown[]; remove?: unknown[] } | undefined;
  if (logins) lines.push(`входы: ${[logins.add?.length ? `связать ${logins.add.length}` : "", logins.remove?.length ? `отвязать ${logins.remove.length}` : ""].filter(Boolean).join(", ")}`);
  return lines.length > 0 ? lines : ["изменение без полей, которые показывает экран"];
}

// ── the person ───────────────────────────────────────────────────────────────

export function EditButton({ onClick, children = "Изменить" }: { onClick: () => void; children?: ReactNode }) {
  return <Button size="sm" variant="ghost" icon={Pencil} onClick={onClick}>{children}</Button>;
}

export function PersonBlock({ person, onEdit }: { person: RegistryPerson; onEdit: (() => void) | undefined }) {
  const telegram = [person.telegram.handle ? `@${person.telegram.handle}` : null, person.telegram.userId ? `id ${person.telegram.userId}` : null].filter(Boolean).join(", ");
  const doneSteps = person.onboarding.filter((step) => step.doneAt !== null).length;
  return (
    <Card title="Человек" actions={onEdit && <EditButton onClick={onEdit} />}>
      <KeyValue
        items={[
          { label: "Имя", value: person.displayName },
          { label: "Код", value: <code className="registry-code">{person.code}</code> },
          { label: "Роль", value: PERSON_ROLE_WORD[person.role] ?? person.role },
          { label: "Состояние", value: `${PERSON_STATE_WORD[person.state] ?? person.state}${person.state === "left" && person.leftOn ? `, с ${formatDay(person.leftOn)}` : ""}` },
          { label: "Telegram", value: telegram || "—" },
          { label: "Тег отчёта", value: person.telegram.reportTag ?? "—" },
          ...(person.onboarding.length > 0 ? [{ label: "Оформление", value: `${doneSteps} из ${person.onboarding.length} ${ruPlural(person.onboarding.length, "шага", "шагов", "шагов")}: ${person.onboarding.map((step) => `${step.step}${step.doneAt ? "" : " (нет)"}`).join(", ")}` }] : []),
          ...(person.note ? [{ label: "Заметка", value: person.note }] : []),
        ]}
      />
    </Card>
  );
}

/** The narrow rights, each a switch of its own; a change keeps the other rights as they are. */
const RIGHT_SWITCHES: ReadonlyArray<{ right: RegistryPerson["rights"][number]["right"]; label: string; hint: string; on: string; off: string; held: string }> = [
  // The person right: still read for an order whose page is not known (custom-orders leaders `fallback`); the team's
  // own customs lead is the team record «Ведёт кастомы команды» (TeamRoles.tsx).
  { right: "customs_lead", label: "Кастомы без страницы", hint: "Ведёт заказы кастомов, у которых не известна страница: проверка и отдача в съёмку.", on: "ведёт кастомы без страницы", off: "больше не ведёт кастомы без страницы", held: "Ведёт кастомы без страницы." },
  {
    right: "records_customs", label: "Записывает кастомы в системе", hint: "Получает дела по кастомам: «отдайте фану», продажа похожа на кастом без заказа.",
    on: "записывает кастомы в системе", off: "больше не получает дела по кастомам", held: "Записывает кастомы в системе.",
  },
  {
    // The «Отчёт» board (package R): the person hands their shift in on the board (shifts begun after the switch).
    right: "submits_shift", label: "Сдаёт смену доской", hint: "Кнопка «Отчёт» в ChatGoose: смена сдаётся доской и подтверждается после проверки. Для смен, начатых после включения.",
    on: "сдаёт смену доской", off: "больше не сдаёт смену доской", held: "Сдаёт смену доской.",
  },
  {
    right: "sees_own_pay", label: "Видит свои деньги", hint: "В «Деньги → Мои деньги»: начислено за период, к выплате, выплачено и начисление каждой смены. Только суммы, без ставок.",
    on: "видит свои деньги", off: "больше не видит свои деньги", held: "Видит свои деньги.",
  },
];

export function RightsBlock({ person, canEdit }: { person: RegistryPerson; canEdit: boolean }) {
  const update = useUpdatePerson(person.code);
  const held = new Set(person.rights.map((right) => right.right));
  const toggle = (right: (typeof RIGHT_SWITCHES)[number], on: boolean) => {
    const rights = [...held].filter((one) => one !== right.right);
    update.mutate({ rights: on ? [...rights, right.right] : rights }, {
      onSuccess: () => toast.success(`${person.displayName} ${on ? right.on : right.off}`),
      onError: () => toast.error("Не удалось изменить права: Hub вернул ошибку."),
    });
  };
  return (
    <Card title="Права" description="Узкие права рядом с ролью.">
      {canEdit && person.kind === "human" ? <div className="registry-rights">{RIGHT_SWITCHES.map((right) => (
        <Switch
          key={right.right}
          label={right.label}
          hint={right.hint}
          checked={held.has(right.right)}
          pending={update.isPending}
          onChange={(on) => toggle(right, on)}
        />
      ))}</div> : (
        <p className="access-text">{RIGHT_SWITCHES.filter((right) => held.has(right.right)).map((right) => right.held).join(" ") || "Узких прав нет."}</p>
      )}
    </Card>
  );
}

// ── the windows of change

export function PersonModal({ person, onClose }: { person: RegistryPerson; onClose: () => void }) {
  const update = useUpdatePerson(person.code);
  const [name, setName] = useState(person.displayName);
  const [role, setRole] = useState(person.role);
  const [state, setState] = useState(person.state);
  const [leftOn, setLeftOn] = useState(person.leftOn ?? moscowToday());
  const [handle, setHandle] = useState(person.telegram.handle ? `@${person.telegram.handle}` : "");
  const [tag, setTag] = useState(person.telegram.reportTag ?? "");
  const [note, setNote] = useState(person.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const human = person.kind === "human";
  const handleOk = handle.trim() === "" || /^@?[A-Za-z0-9_]{3,64}$/.test(handle.trim());
  const tagOk = tag.trim() === "" || /^#[^\s#]{1,63}$/.test(tag.trim());
  const nameOk = name.trim() !== "";

  function save() {
    if (!nameOk || !handleOk || !tagOk || update.isPending) return;
    const body: AdminPersonUpdateBody = {};
    if (name.trim() !== person.displayName) body.displayName = name.trim();
    if (role !== person.role) body.role = role;
    if (state !== person.state) body.state = state;
    if (state === "left" && leftOn !== (person.leftOn ?? "")) body.leftOn = leftOn || null;
    const nextHandle = handle.trim() === "" ? null : handle.trim().replace(/^@/, "");
    const nextTag = tag.trim() === "" ? null : tag.trim();
    if (nextHandle !== person.telegram.handle || nextTag !== person.telegram.reportTag) {
      body.telegram = { ...(nextHandle !== person.telegram.handle ? { handle: nextHandle } : {}), ...(nextTag !== person.telegram.reportTag ? { reportTag: nextTag } : {}) };
    }
    if ((note.trim() || null) !== person.note) body.note = note.trim() || null;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setProblem(null);
    update.mutate(body, {
      onSuccess: () => {
        toast.success("Сохранено");
        onClose();
      },
      onError: (error) => {
        const { reason } = refusal(error);
        setProblem(reason === "telegram_taken" || reason === "tag_taken" ? "Этот Telegram или тег уже у другого человека." : "Не удалось сохранить: Hub вернул ошибку.");
      },
    });
  }

  return (
    <Modal
      title={`${person.displayName}: человек`}
      onClose={() => { if (!update.isPending) onClose(); }}
      explicitCloseOnly={update.isPending}
      actions={(
        <>
          <Button disabled={update.isPending} onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!nameOk || !handleOk || !tagOk} loading={update.isPending} onClick={save}>{update.isPending ? "Сохраняем…" : "Сохранить"}</Button>
        </>
      )}
    >
      <div className="access-invite">
        <Field label="Имя" error={nameOk ? undefined : "Напишите имя."}>
          {(control) => <TextInput {...control} data-autofocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />}
        </Field>
        {human && (
          <div className="registry-form__row">
            <Field label="Роль">
              {(control) => (
                <Select {...control} value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
                  {(["chatter", "team_lead", "content_manager", "contractor", "owner"] as const).map((value) => <option key={value} value={value}>{PERSON_ROLE_WORD[value]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Состояние">
              {(control) => (
                <Select {...control} value={state} onChange={(event) => setState(event.target.value as typeof state)}>
                  {(["invited", "set_up", "working", "left"] as const).map((value) => <option key={value} value={value}>{PERSON_STATE_WORD[value]}</option>)}
                </Select>
              )}
            </Field>
            {state === "left" && (
              <Field label="День ухода">
                {(control) => <TextInput {...control} type="date" value={leftOn} onChange={(event) => setLeftOn(event.target.value)} />}
              </Field>
            )}
          </div>
        )}
        {human && (
          <div className="registry-form__row">
            <Field label="Telegram" error={handleOk ? undefined : "Ник Telegram: латиница, цифры и _, от 3 знаков."}>
              {(control) => <TextInput {...control} value={handle} spellCheck={false} placeholder="@ник" onChange={(event) => setHandle(event.target.value)} />}
            </Field>
            <Field label="Тег отчёта" error={tagOk ? undefined : "Тег: # и одно слово, например #alex."}>
              {(control) => <TextInput {...control} value={tag} spellCheck={false} placeholder="#тег" onChange={(event) => setTag(event.target.value)} />}
            </Field>
          </div>
        )}
        <Field label="Заметка">
          {(control) => <Textarea {...control} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />}
        </Field>
        {state === "left" && person.state !== "left" && (
          <Notice tone="warning">Уход в реестре не закрывает входы: отключите доступ во вкладке «Входы и устройства».</Notice>
        )}
        {problem && <Notice tone="danger" role="alert">{problem}</Notice>}
      </div>
    </Modal>
  );
}
