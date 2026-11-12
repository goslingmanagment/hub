import { Fragment, useState } from "react";
import { toast } from "sonner";

import { AGENT_CAPABILITIES, isServiceKeyCapabilities, type AgentCapability, type AgentKeyItem } from "@agency_hub_core/contracts";
import {
  useAdminPages,
  useAgentKeys,
  useCreateAgentKey,
  useKeyAgents,
  useLinkAgentKey,
  useReplaceAgentKey,
  useRevokeAgentKey,
  useUpdateAgentKeyCapabilities,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu } from "@/components/ui/RowMenu";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime, formatAgo } from "@/lib/format";
import { AGENT_KEY_STATUS } from "@/lib/statusWords";
import { freshOf, platformName, RowChevron } from "../shared.js";

/**
 * «Агенты и ключи»: agent read keys, whose agent each is, their rights and last
 * call. The writes are the old tab's (`TechnicalTab`) with their calls unchanged;
 * issuance names the agent, and a key issued before the people registry is
 * linked to its agent on the agent's card. The key's one showing can only be
 * closed by its button (design/screens/system.md §6).
 *
 * An agent holds one live key. Its rights change here in place and its pages
 * in place from the CLI, so a new key is issued only to REPLACE the live one
 * («Выпустить на замену»): the same agent, pages and rights, and the old key
 * works one more day and ends by itself. While both work neither changes.
 */

const CAPABILITY_HELP: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Текст сообщений целиком: переписки и фрагменты в поиске",
  "read:money": "Операции, суммы трат, цены подписок",
  "read:observations_envelope": "Записи журнала сбора: только описание, без содержимого",
  "read:datasets": "Зарегистрированные запросы к наборам данных",
  "request:hydration": "Заявки на историю переписки (выполнять ли — решает владелец)",
  "approve:publications": "Утверждать черновики постов и альбомов на своих страницах — после «да» владельца в чате",
  "approve:vault_albums": "Утверждать только альбомы волта на своих страницах: фанам они не видны. Посты этим правом не утвердить",
  "write:publication_drafts": "Черновики постов на своих страницах (утверждает человек)",
  "write:fan_queues": "Очереди фанов для чаттеров на своих страницах: по слову того, кто попросил",
  "read:content": "Посты, вложения, файлы и медиатека своих страниц с их просмотрами и лайками — без переписки, фанов и денег",
  "read:team": "Смены команды и факты каждой продажи на своих страницах (кто держал страницу, кто отправил PPV) — для ledger, вместе с правом на деньги. Само по себе — список людей: кто есть кто, входы, рабочие страницы, график, Telegram, без денег",
  "withdraw:publications": "Снимать посты с расписания площадки на своих страницах, без спроса: посты Hub — как «Снять» владельца, поставленные руками — по номеру из свежего чтения расписания. Вышедший пост не удалить",
  "delete:posts": "Удалять вышедшие посты своих страниц — только по «да» владельца на этот пост. Не больше дневного потолка на ключ; причина каждого удаления — в журнале владельца",
  "look:media": "Смотреть кадры медиа страницы: Hub берёт через сессию страницы одну картинку (кадры видео, обложку или фото) не больше 512 px, в темпе страницы и не больше дневного предела. Только Fansly и посты в расписании; ни файла, ни ссылки агент не получает",
  "write:matters": "Открывать, закрывать и комментировать дела по ключу: находки и напоминания человеку или роли. Только свои виды дел; дела, которые ведёт сам Hub, агенту не закрыть",
  "read:pay_terms": "Условия оплаты людей (доля и фикс за смену по моделям, с датами) в списке людей — деньги, только ключу ledger; вместе с правом «Факты смен и продаж»",
  "propose:people": "Предлагать изменения по людям и новых людей: предложение ждёт владельца, сам агент ничего не меняет. Условия оплаты не предлагает",
  "signin:contentops": "«Войти через хаб» для сервера ContentOps: обменять одноразовый код входа на «кто это и владелец ли» и потом проверять, жив ли этот вход. Сессию Hub сервер не получает, страниц это право не касается",
  "signin:taskindex": "«Войти через хаб» для сервера TaskIndex: обменять одноразовый код входа на «кто это и владелец ли» и потом проверять, жив ли этот вход. Сессию Hub сервер не получает, страниц это право не касается",
  "signin:monitor": "«Войти через хаб» для сервера server-monitor: обменять одноразовый код входа на «кто это и владелец ли» и потом проверять, жив ли этот вход. Сессию Hub сервер не получает, страниц это право не касается",
  "write:reports": "Публиковать страницы-отчёты: сводку трафика и другие доски агента. Их читает владелец, а тимлиды только те, что агент им открыл. Данных Hub через это право агент не читает",
  "write:system_state": "Присылать состояние рутин и копий своего места (мака, ПК): когда что запускалось и чем кончилось, когда снята копия. Больше ничего не пишет и не читает",
  "introspect:agent_keys": "Для сервера другой службы (ledger, ContentOps, TaskIndex): узнавать, чей ключ хаба показал ему агент, работает ли ключ и до какого числа. Сервер присылает только отпечаток ключа; сам ключ, права и страницы он не получает",
  "write:customs": "Вести заказы кастомов своих страниц: заводить заказ по карточке, править её, отмечать, что модель сдала частично, сняла, правит или отказалась, привязывать карточку из Telegram. Оплату и «отдали» отмечают люди",
  "write:shift_reports": "Отчёт смены со слов чаттера (/smena): читать его черновик, ставить «не моё», «делим», «моё», заметки, комментарий и «мимо площадки», сдавать смену. Каждая запись — с Telegram id отправителя, он должен быть этого человека; сдача — ещё и со ссылкой на сообщение",
};

const CAPABILITY_SHORT: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Читать переписку",
  "read:money": "Читать деньги",
  "read:observations_envelope": "Журнал сбора: описание",
  "read:datasets": "Наборы данных",
  "request:hydration": "Подавать заявки на историю",
  "approve:publications": "Утверждать посты",
  "approve:vault_albums": "Утверждать альбомы волта",
  "write:publication_drafts": "Писать черновики постов",
  "write:fan_queues": "Вести очереди фанов",
  "read:content": "Читать контент",
  "read:team": "Факты смен и продаж",
  "withdraw:publications": "Снимать посты с расписания",
  "delete:posts": "Удалять вышедшие посты",
  "look:media": "Смотреть кадры медиа страницы",
  "write:matters": "Вести дела",
  "read:pay_terms": "Читать условия оплаты людей",
  "propose:people": "Предлагать изменения по людям",
  "signin:contentops": "Вход через Hub для ContentOps",
  "signin:taskindex": "Вход через Hub для TaskIndex",
  "signin:monitor": "Вход через Hub для server-monitor",
  "write:reports": "Публиковать отчёты",
  "write:system_state": "Присылать состояние рутин и копий",
  "introspect:agent_keys": "Узнавать, чей ключ агента",
  "write:customs": "Вести заказы кастомов",
  "write:shift_reports": "Вести отчёт смены со слов",
};

const INPUT = "input";
/** The issuance form's choice of no agent: a service's own key. */
const SERVICE_KEY = "__service";

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** «Читать контент, Писать черновики постов +1». */
function firstTwo(list: readonly string[]): string {
  return list.length <= 2 ? list.join(", ") : `${list.slice(0, 2).join(", ")} +${list.length - 2}`;
}

/** The capability checkboxes, shared by issuance and by «Изменить права»; the codes under «Подробнее». */
function CapabilityCheckboxes({
  value,
  onChange,
}: {
  value: AgentCapability[];
  onChange: (next: AgentCapability[]) => void;
}) {
  return (
    <div className="sys-checks">
      {AGENT_CAPABILITIES.map((capability) => (
        <label key={capability} className="sys-check">
          <input type="checkbox" checked={value.includes(capability)} onChange={() => onChange(toggle(value, capability))} />
          <span>{CAPABILITY_HELP[capability]}</span>
        </label>
      ))}
      <Disclosure label="Подробнее">
        <ul>
          {AGENT_CAPABILITIES.map((capability) => (
            <li key={capability}><span className="sys-code">{capability}</span> — {CAPABILITY_SHORT[capability]}</li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

/** Why Hub refused a write of this screen (the 409's `reason`), in the owner's words; anything else is the fallback. */
const REFUSALS: Readonly<Record<string, string>> = {
  name_taken: "Ключ с таким названием уже есть: выберите другое",
  key_without_agent: "У этого ключа нет агента: такой ключ не заменяют. Выпустите новый рядом и потом отзовите старый",
  agent_key_being_replaced: "Идёт замена ключа: пока работает старый, права и страницы обоих не меняются. Отзовите старый ключ или дождитесь, пока он отключится",
  agent_key_replacement_refused: "Ключ изменился или уже не действует. Обновите список и повторите",
};

/**
 * One live key per agent (Hub refuses a second: the services give a key its agent's rights): the toast says why a
 * write was refused. `holdsLiveKey` — what «the agent already holds a live key» means for this write.
 */
function refusedText(error: unknown, fallback: string, holdsLiveKey: string): string {
  const reason = error instanceof KernelApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
  if (reason === "agent_holds_live_key") return holdsLiveKey;
  return typeof reason === "string" ? REFUSALS[reason] ?? fallback : fallback;
}

/**
 * The other key of a replacement in its day: the agent's other working key, when one of the two is marked replaced.
 * The two are equal and Hub changes neither in place until the old one ends.
 */
function pairOf(key: AgentKeyItem, keys: readonly AgentKeyItem[]): AgentKeyItem | null {
  if (!key.isActive || key.agent === null) return null;
  return keys.find((other) => other.id !== key.id && other.isActive && other.agent?.code === key.agent?.code
    && (other.replacedAt !== null || key.replacedAt !== null)) ?? null;
}

/** The agent's working key that is in no replacement yet: the one a new key would be issued in place of. */
function heldBy(agentCode: string, keys: readonly AgentKeyItem[]): AgentKeyItem | null {
  const live = keys.filter((key) => key.isActive && key.agent?.code === agentCode);
  return live.find((key) => key.replacedAt === null) ?? live[0] ?? null;
}

/** Whose a key is, in a line: the agent, a service's own key, or nobody yet. */
function agentLine(key: AgentKeyItem): string {
  if (key.agent) return key.agent.state === "left" ? `${key.agent.displayName} (ушёл)` : key.agent.displayName;
  return isServiceKeyCapabilities(key.capabilities) ? "ключ сервиса, без агента" : "агент не указан";
}

function lastCallLine(key: AgentKeyItem): string {
  if (key.lastCall) return `последний вызов ${formatAgo(key.lastCall.at)}`;
  return key.lastUsedAt ? `использован ${formatAgo(key.lastUsedAt)}` : "ещё не использовался";
}

function keyStatus(key: AgentKeyItem) {
  if (key.isActive) return key.replacedAt ? AGENT_KEY_STATUS.replaced! : AGENT_KEY_STATUS.active!;
  return key.revokedAt ? AGENT_KEY_STATUS.revoked! : AGENT_KEY_STATUS.expired!;
}

export function AgentKeysPage() {
  const keys = useAgentKeys();
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-6 sys-screen">
      <PageHeader
        actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Выпустить ключ</button>}
        fresh={freshOf(keys)}
      />
      <AgentKeysSection creating={creating} onCreating={setCreating} />
    </div>
  );
}

function AgentKeysSection({ creating, onCreating }: { creating: boolean; onCreating: (value: boolean) => void }) {
  const query = useAgentKeys();
  const { data: keys, isLoading, isError } = query;
  const [issuedToken, setIssuedToken] = useState<{ token: string; name: string; note?: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentKeyItem | null>(null);
  const [editing, setEditing] = useState<AgentKeyItem | null>(null);
  const [linking, setLinking] = useState<AgentKeyItem | null>(null);
  const [replacing, setReplacing] = useState<AgentKeyItem | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const revoke = useRevokeAgentKey();
  // OWNED BY THE SCREEN, NOT THE MODAL. TanStack runs a per-call `mutate` callback
  // only while the observer that issued it is mounted, so a modal that owned this
  // mutation would DISCARD the token handoff if the owner dismissed it mid-flight:
  // the server commits the key, nobody ever sees the only copy of its token.
  const create = useCreateAgentKey();
  // The same for a replacement: its result carries the new key's only token.
  const replace = useReplaceAgentKey();

  function handleRevoke() {
    if (!revoking) return;
    const target = revoking;
    revoke.mutate(target.id, {
      onSuccess: (result) => {
        toast.success(result.revoked
          ? `Ключ «${target.name}» отозван`
          : `Ключ «${target.name}» уже был отозван`);
        setRevoking(null);
      },
      onError: () => {
        toast.error("Не удалось отозвать ключ");
      },
    });
  }

  const items = keys ?? [];

  return (
    <section className="card" aria-labelledby="agent-keys-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="agent-keys-title" className="card-title">Ключи доступа</h2>
          <p className="card-description sys-measure">
            Каждый ключ принадлежит агенту из «Людей» и даёт ему только отмеченные страницы и только отмеченные права. Без
            агента бывает только ключ сервиса: вход через хаб и проверка чужих ключей. Пока ключом пользуются, срок
            продлевается, но не дальше 365 дней с выпуска.
          </p>
          <p className="card-description sys-measure">
            У агента один действующий ключ. Его права и страницы меняются на месте, без нового ключа. Новый ключ выпускают
            на замену старому: он получает те же права и страницы, а старый работает ещё сутки и отключается сам.
          </p>
        </div>
      </div>
      {isError && keys && (
        <div className="card-body sys-card-notice">
          <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
            {staleDataText(query.dataUpdatedAt)}
          </Notice>
        </div>
      )}
      {isLoading && !keys ? (
        <TableSkeleton rows={3} columns={5} />
      ) : !keys ? (
        <NoAnswerPanel retry={query.refetch} />
      ) : items.length === 0 ? (
        <StatusPanel title="Ключей пока нет" description="Выпустите ключ, когда агенту понадобится доступ к данным." />
      ) : (
        <div className="table-wrap">
          <table className="data-table sys-keys">
            <thead>
              <tr>
                <th>Название</th>
                <th>Что может</th>
                <th>Страницы</th>
                <th>Срок</th>
                <th>Состояние</th>
                <th><span className="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((key) => {
                const isOpen = open === key.id;
                const toggleRow = () => setOpen(isOpen ? null : key.id);
                // A replacement in its day: the agent's two keys are equal, and Hub changes neither in place.
                const pair = pairOf(key, items);
                const menu = [
                  ...(key.isActive && key.agent === null ? [{ label: "Указать агента", onSelect: () => setLinking(key) }] : []),
                  ...(key.isActive ? [{
                    label: "Изменить права", onSelect: () => setEditing(key),
                    disabled: pair !== null, hint: pair ? "идёт замена: пока работает старый ключ, права не меняются" : undefined,
                  }] : []),
                  ...(key.isActive && key.agent !== null && key.agent.state !== "left" ? [{
                    label: "Выпустить на замену", onSelect: () => setReplacing(key),
                    disabled: pair !== null, hint: pair ? "замена уже идёт: у агента два действующих ключа" : undefined,
                  }] : []),
                  ...(key.revokedAt === null ? [{ label: "Отозвать", onSelect: () => setRevoking(key), danger: true }] : []),
                ];
                return (
                  <Fragment key={key.id}>
                    <tr className={`sys-click-row${key.isActive ? "" : " sys-mute"}`} data-agent-key={key.name} onClick={toggleRow}>
                      <td className="sys-key-name">
                        <RowChevron open={isOpen} label={isOpen ? `Свернуть: ${key.name}` : `Раскрыть: ${key.name}`} onToggle={toggleRow} />
                        <span className="font-medium">{key.name}</span>
                        <span className="cell-second">{agentLine(key)}</span>
                      </td>
                      <td>{firstTwo(key.capabilities.map((capability) => CAPABILITY_SHORT[capability] ?? capability))}</td>
                      <td>{firstTwo(key.pageLabels)}</td>
                      <td>
                        <span className="sys-key-until">до {formatDateTime(key.expiresAt, { yearUnlessCurrent: true })}</span>
                        <span className="cell-second">{key.isActive && key.replacedAt ? "заменён: отключится сам" : lastCallLine(key)}</span>
                      </td>
                      <td className="status-col"><StatusBadge status={keyStatus(key)} /></td>
                      <td className="sys-actions" onClick={(event) => event.stopPropagation()}>
                        {menu.length > 0 && <RowMenu label={`Ещё: ${key.name}`} items={menu} />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="sys-detail-row">
                        <td colSpan={6}>
                          <div className="sys-detail">
                            <div>
                              <p className="sys-label">Что может</p>
                              <ul className="sys-lines">
                                {key.capabilities.length === 0
                                  ? <li>Ничего: без отметок ключ ничего не может прочитать.</li>
                                  : key.capabilities.map((capability) => <li key={capability}>{CAPABILITY_HELP[capability] ?? capability}</li>)}
                              </ul>
                            </div>
                            <div>
                              <p className="sys-label">Страницы</p>
                              <p>{key.pageLabels.join(", ")}</p>
                            </div>
                            <div>
                              <p className="sys-label">Чей ключ</p>
                              <p>{key.agent ? `${agentLine(key)}, код ${key.agent.code}` : agentLine(key)}</p>
                              {/* Other services know a key only by its agent (Hub's «кто этот ключ»): without one it is no agent there. */}
                              {!key.agent && <p className="text-sm text-text-secondary">ключ без агента: в сервисах не действует</p>}
                            </div>
                            {key.isActive && (key.replacedAt || pair) && (
                              <div>
                                <p className="sys-label">Замена</p>
                                <p>
                                  {key.replacedAt
                                    ? `Ключу выпущена замена${pair ? ` («${pair.name}»)` : ""}. Этот работает до ${formatDateTime(key.expiresAt, { yearUnlessCurrent: true })} и отключится сам: срок больше не продлевается. Когда новый ключ поставлен, этот можно отозвать раньше.`
                                    : `Выпущен на замену ключу «${pair!.name}»: тот работает до ${formatDateTime(pair!.expiresAt, { yearUnlessCurrent: true })}.`}
                                </p>
                                {pair && <p className="text-sm text-text-secondary">Пока работают оба ключа, их права и страницы не меняются.</p>}
                              </div>
                            )}
                            <div>
                              <p className="sys-label">Последний вызов</p>
                              <p>
                                {key.lastCall
                                  ? <>{formatDateTime(key.lastCall.at, { yearUnlessCurrent: true })} · <span className="sys-code">{key.lastCall.operation}</span></>
                                  : "в журнале вызовов ничего нет"}
                              </p>
                            </div>
                            <Disclosure label="Подробнее">
                              <KeyValue
                                rows={[
                                  { label: "Начало ключа", value: <span className="sys-code">{key.keyPrefix}…</span> },
                                  { label: "Права", value: <span className="sys-code">{key.capabilities.join(", ") || "—"}</span> },
                                  { label: "Выпущен", value: formatDateTime(key.createdAt, { yearUnlessCurrent: true }) },
                                ]}
                              />
                            </Disclosure>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateAgentKeyModal
          create={create}
          keys={items}
          onClose={() => onCreating(false)}
          onIssued={(token, name) => {
            onCreating(false);
            setIssuedToken({ token, name });
          }}
        />
      )}

      {issuedToken && (
        <TokenRevealModal token={issuedToken.token} name={issuedToken.name} note={issuedToken.note} onClose={() => setIssuedToken(null)} />
      )}

      {editing && <EditAgentKeyCapabilitiesModal agentKey={editing} onClose={() => setEditing(null)} />}

      {replacing && (
        <ReplaceAgentKeyModal
          agentKey={replacing}
          replace={replace}
          onClose={() => setReplacing(null)}
          onIssued={(token, name, note) => {
            setReplacing(null);
            setIssuedToken({ token, name, note });
          }}
        />
      )}

      {linking && <LinkAgentKeyModal agentKey={linking} onClose={() => setLinking(null)} />}

      {revoking && (
        <ConfirmModal
          title={`Отозвать ключ «${revoking.name}»?`}
          message={revoking.isActive && revoking.agent !== null && !revoking.replacedAt && pairOf(revoking, items) === null
            // The agent's one working key: revoking it first is downtime, a replacement is not.
            ? "Ключ перестанет работать сразу, и у агента не останется действующего ключа. Отзыв нельзя отменить. Чтобы заменить ключ без простоя, сначала выпустите новый на замену: «Выпустить на замену» в меню ключа."
            : "Ключ перестанет работать сразу. Отзыв нельзя отменить."}
          facts={[
            { label: "Что именно", value: `ключ «${revoking.name}», страницы ${revoking.pageLabels.join(", ")}` },
            { label: "Отменить", value: "нельзя" },
          ]}
          confirmLabel="Отозвать"
          pendingLabel="Отзываем…"
          initialFocus="cancel"
          isPending={revoke.isPending}
          onConfirm={handleRevoke}
          onClose={() => setRevoking(null)}
        />
      )}
    </section>
  );
}

function CreateAgentKeyModal({
  create,
  keys,
  onClose,
  onIssued,
}: {
  create: ReturnType<typeof useCreateAgentKey>;
  /** The keys of the list: an agent who holds a working one gets no second key beside it. */
  keys: readonly AgentKeyItem[];
  onClose: () => void;
  onIssued: (token: string, name: string) => void;
}) {
  const { data: pages, isLoading: pagesLoading, isError: pagesError, refetch: refetchPages, isFetching: pagesFetching } = useAdminPages();
  const agents = useKeyAgents();
  const [name, setName] = useState("");
  const [agentCode, setAgentCode] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(90);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    create.mutate({
      name: name.trim(),
      ...(agentCode === "" || agentCode === SERVICE_KEY ? {} : { agentCode }),
      capabilities,
      pageLabels,
      expiresInDays,
    }, {
      onSuccess: (result) => onIssued(result.token, result.key.name),
      onError: (error) => {
        toast.error(refusedText(error, "Не удалось выпустить ключ", "У агента уже есть действующий ключ. Новый выпускают ему на замену: «Выпустить на замену» в меню ключа"));
      },
    });
  }

  // Without an agent only a service's own key: sign-in and «who is this key» alone.
  const serviceKey = isServiceKeyCapabilities(capabilities);
  // One working key per agent: Hub refuses a second beside it, so the form says where a new key comes from instead.
  const held = agentCode === "" || agentCode === SERVICE_KEY ? null : heldBy(agentCode, keys);
  const canSubmit = name.trim().length > 0
    && agentCode !== "" && (agentCode !== SERVICE_KEY || serviceKey)
    && held === null
    && capabilities.length > 0
    && pageLabels.length > 0
    && Boolean(pages) && !pagesError
    && pageLabels.every((label) => pages?.some((page) => page.label === label))
    && Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
    && !create.isPending;

  // Belt to the parent-owned braces: while a key is being minted there is nothing
  // useful to go back to, and every dismissal path (Cancel, Escape, backdrop)
  // routes through here.
  const closeUnlessPending = () => {
    if (!create.isPending) {
      onClose();
    }
  };

  return (
    <ModalShell title="Новый ключ агента" onClose={closeUnlessPending} closeLabel="Закрыть">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <Field label="Название">
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="Например, аудит кастомов"
            className={INPUT}
          />
        </Field>

        <Field label="Чей ключ">
          <AgentSelect agents={agents} value={agentCode} onChange={setAgentCode} allowNone />
          {agentCode === SERVICE_KEY && capabilities.length > 0 && !serviceKey && (
            <p className="field-hint mt-1">Без агента выпускается только ключ сервиса: вход через хаб и проверка чужих ключей. Выберите агента.</p>
          )}
          {held && (
            <p className="field-hint mt-1" role="status">
              У этого агента уже есть действующий ключ «{held.name}», а ключ у агента один. Права и страницы меняются у него на
              месте; новый ключ выпускают ему на замену: «Выпустить на замену» в меню ключа.
            </p>
          )}
        </Field>

        <fieldset>
          <legend className="field-label">Доступ к данным</legend>
          <CapabilityCheckboxes value={capabilities} onChange={setCapabilities} />
        </fieldset>

        <fieldset>
          <legend className="field-label">Страницы</legend>
          <p className="field-hint mb-2 mt-0">Только отмеченные: страница, добавленная позже, доступа не получит.</p>
          {pagesLoading && !pages && <p className="text-sm text-text-muted">Загружаем страницы…</p>}
          {pagesError && <div role="alert" className="notice notice-danger mb-2">
            <span>
              Страницы не загрузились. Выбор сохранён; обновите список перед выпуском ключа.
              <button type="button" disabled={pagesFetching} onClick={() => void refetchPages()} className="link ml-2">Повторить</button>
            </span>
          </div>}
          {pages && pages.length === 0 && <p className="text-sm text-text-muted">Сначала добавьте страницу.</p>}
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {(pages ?? []).map((page) => (
              <label key={page.label} className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={pageLabels.includes(page.label)}
                  onChange={() => setPageLabels((current) => toggle(current, page.label))}
                />
                <span>{page.label}</span>
                <span className="text-text-secondary">{platformName(page.platform)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Срок, дней">
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              className={INPUT}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={closeUnlessPending} disabled={create.isPending} className="btn">
            Отмена
          </button>
          <button type="submit" disabled={!canSubmit} className="btn btn-primary">
            {create.isPending ? "Выпускаем…" : "Выпустить"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/**
 * «Изменить права»: the whole new set of a live key's capabilities. Its pages are
 * not editable here: they change in place too, from the CLI (`agent-keys:pages`).
 * A new key is issued only to replace one.
 */
function EditAgentKeyCapabilitiesModal({
  agentKey,
  onClose,
}: {
  agentKey: AgentKeyItem;
  onClose: () => void;
}) {
  const update = useUpdateAgentKeyCapabilities();
  const [capabilities, setCapabilities] = useState<AgentCapability[]>(agentKey.capabilities);

  const unchanged = capabilities.length === agentKey.capabilities.length
    && capabilities.every((capability) => agentKey.capabilities.includes(capability));
  const added = capabilities.filter((capability) => !agentKey.capabilities.includes(capability));
  const removed = agentKey.capabilities.filter((capability) => !capabilities.includes(capability));

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (unchanged || update.isPending) return;
    update.mutate({ id: agentKey.id, capabilities }, {
      onSuccess: () => {
        toast.success(`Права ключа «${agentKey.name}» изменены`);
        onClose();
      },
      onError: (error) => {
        toast.error(refusedText(error, "Не удалось изменить права ключа", "Не удалось изменить права ключа"));
      },
    });
  }

  const closeUnlessPending = () => {
    if (!update.isPending) {
      onClose();
    }
  };

  return (
    <ModalShell title={`Права ключа «${agentKey.name}»`} onClose={closeUnlessPending} closeLabel="Закрыть">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <p className="text-sm text-text-secondary">
          Новые права действуют со следующего запроса агента: выпускать ключ заново не нужно. Страницы ключа
          здесь не меняются: {agentKey.pageLabels.join(", ")}. Их тоже добавляют и убирают на месте, без нового ключа:
          командой <code className="sys-code">agent-keys:pages</code> на сервере, скажите агенту. Новый ключ нужен только
          на замену старому.
        </p>

        <fieldset>
          <legend className="field-label">Доступ к данным</legend>
          <CapabilityCheckboxes value={capabilities} onChange={setCapabilities} />
        </fieldset>

        {!unchanged && (
          <div className="sys-summary-box">
            {added.length > 0 && <p>Добавится: {added.map((capability) => CAPABILITY_HELP[capability]).join("; ")}</p>}
            {removed.length > 0 && <p>Уберётся: {removed.map((capability) => CAPABILITY_HELP[capability]).join("; ")}</p>}
            {capabilities.length === 0 && (
              <p>Без отметок ключ останется рабочим, но ничего не сможет прочитать.</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={closeUnlessPending} disabled={update.isPending} className="btn">
            Отмена
          </button>
          <button type="submit" disabled={unchanged || update.isPending} className="btn btn-primary">
            {update.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/**
 * «Выпустить на замену»: a new key in place of the agent's working one. Nothing of the grant is chosen here: the new
 * key is the same agent's with the same rights and pages, and the old one works one more day and ends by itself.
 */
function ReplaceAgentKeyModal({
  agentKey,
  replace,
  onClose,
  onIssued,
}: {
  agentKey: AgentKeyItem;
  replace: ReturnType<typeof useReplaceAgentKey>;
  onClose: () => void;
  onIssued: (token: string, name: string, note: string) => void;
}) {
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const sameName = name.trim() === agentKey.name;
  const canSubmit = name.trim().length > 0 && !sameName
    && Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
    && !replace.isPending;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    replace.mutate({ id: agentKey.id, name: name.trim(), expiresInDays }, {
      onSuccess: (result) => onIssued(
        result.token,
        result.key.name,
        `Старый ключ «${result.replaced.name}» работает до ${formatDateTime(result.replaced.expiresAt, { yearUnlessCurrent: true })} и отключится сам. Поставьте новый ключ вместо него за это время.`,
      ),
      onError: (error) => {
        toast.error(refusedText(error, "Не удалось выпустить ключ на замену", "У агента уже два действующих ключа: отзовите старый или дождитесь, пока он отключится"));
      },
    });
  }

  // While the key is being minted there is nothing useful to go back to (as at issuance).
  const closeUnlessPending = () => {
    if (!replace.isPending) onClose();
  };

  return (
    <ModalShell title={`Замена ключа «${agentKey.name}»`} onClose={closeUnlessPending} closeLabel="Закрыть" size="short">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <div className="space-y-2 text-sm text-text-secondary">
          <p>
            Новый ключ будет у того же агента{agentKey.agent ? ` (${agentKey.agent.displayName})` : ""}, с теми же правами и
            страницами: {agentKey.pageLabels.join(", ")}.
          </p>
          <p>
            Старый ключ не отзывается: он проработает ещё сутки и отключится сам. За это время поставьте новый ключ там, где
            стоит старый; после этого старый можно отозвать раньше. Пока работают оба, права и страницы у них не меняются.
          </p>
        </div>

        <Field label="Название нового ключа">
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder={`Например, ${agentKey.name} (новый)`}
            className={INPUT}
          />
          {sameName && <p className="field-hint mt-1">Название должно отличаться: «{agentKey.name}» остаётся у старого ключа.</p>}
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Срок, дней">
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              className={INPUT}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={closeUnlessPending} disabled={replace.isPending} className="btn">Отмена</button>
          <button type="submit" disabled={!canSubmit} className="btn btn-primary">
            {replace.isPending ? "Выпускаем…" : "Выпустить на замену"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/** The agents a key may belong to; `allowNone` — a service's own key, no agent. */
function AgentSelect({
  agents,
  value,
  onChange,
  allowNone = false,
}: {
  agents: ReturnType<typeof useKeyAgents>;
  value: string;
  onChange: (code: string) => void;
  allowNone?: boolean;
}) {
  if (agents.isError) {
    return (
      <div role="alert" className="notice notice-danger">
        <span>
          Список агентов не загрузился.
          <button type="button" disabled={agents.isFetching} onClick={() => void agents.refetch()} className="link ml-2">Повторить</button>
        </span>
      </div>
    );
  }
  return (
    <select className={INPUT} value={value} onChange={(event) => onChange(event.target.value)} disabled={!agents.data}>
      <option value="" disabled>{agents.data ? "Выберите агента" : "Загружаем агентов…"}</option>
      {(agents.data ?? []).map((agent) => (
        <option key={agent.code} value={agent.code}>{agent.displayName} ({agent.code})</option>
      ))}
      {allowNone && <option value={SERVICE_KEY}>Ключ сервиса, без агента</option>}
    </select>
  );
}

/** «Указать агента»: a key issued before the people registry goes to its agent's card. The key itself does not change. */
function LinkAgentKeyModal({ agentKey, onClose }: { agentKey: AgentKeyItem; onClose: () => void }) {
  const agents = useKeyAgents();
  const link = useLinkAgentKey();
  const [agentCode, setAgentCode] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (agentCode === "" || link.isPending) return;
    link.mutate({ agentCode, keyId: agentKey.id }, {
      onSuccess: () => {
        toast.success(`Ключ «${agentKey.name}» теперь у агента`);
        onClose();
      },
      onError: (error) => {
        toast.error(refusedText(error, "Не удалось указать агента", "У агента уже есть действующий ключ: сначала отзовите его"));
      },
    });
  }

  const closeUnlessPending = () => {
    if (!link.isPending) onClose();
  };

  return (
    <ModalShell title={`Чей ключ «${agentKey.name}»`} onClose={closeUnlessPending} closeLabel="Закрыть" size="short">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <p className="text-sm text-text-secondary">
          Ключ остаётся тем же: его не нужно выпускать заново, права и страницы не меняются. Он появится в карточке агента в «Людях».
        </p>
        <Field label="Агент">
          <AgentSelect agents={agents} value={agentCode} onChange={setAgentCode} />
        </Field>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={closeUnlessPending} disabled={link.isPending} className="btn">Отмена</button>
          <button type="submit" disabled={agentCode === "" || link.isPending} className="btn btn-primary">
            {link.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function TokenRevealModal({
  token,
  name,
  note,
  onClose,
}: {
  token: string;
  name: string;
  /** What else the owner has to know while the key is on the screen: a replacement's old key and when it ends. */
  note?: string | undefined;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast.success("Ключ скопирован");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Буфер обмена недоступен. Выделите ключ и скопируйте его, пока окно открыто.");
    }
  }

  return (
    <ModalShell title={`Ключ «${name}»`} onClose={onClose} closeLabel="Закрыть" explicitCloseOnly size="short">
      <div className="space-y-4">
        <Notice tone="warning">
          Ключ показывается один раз. Hub хранит только его отпечаток: потерянный ключ выпускают заново,
          восстановить его нельзя.
        </Notice>
        {note && <p className="text-sm text-text-secondary">{note}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <code className="sys-token">
            {token}
          </code>
          <button type="button" onClick={handleCopy} className="btn btn-primary">
            {copied ? "Скопировано" : "Скопировать"}
          </button>
        </div>
        <Disclosure label="Подробнее">
          <p>
            Сохраните ключ в переменной <code className="sys-code">HUB_AGENT_KEY</code> или в файле{" "}
            <code className="sys-code">~/.config/hub/credentials</code> — консоль Hub найдёт его сама.
          </p>
        </Disclosure>
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button type="button" onClick={onClose} className="btn">
          Готово
        </button>
      </div>
    </ModalShell>
  );
}
