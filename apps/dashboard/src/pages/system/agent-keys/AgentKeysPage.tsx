import { Fragment, useState } from "react";
import { toast } from "sonner";

import { AGENT_CAPABILITIES, type AgentCapability, type AgentKeyItem } from "@agency_hub_core/contracts";
import {
  useAdminPages,
  useAdminUsers,
  useAgentKeys,
  useCreateAgentKey,
  useRevokeAgentKey,
  useSetHarvestCapability,
  useUpdateAgentKeyCapabilities,
  useUserDevices,
} from "@/api/queries";
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
 * «Доступ ИИ-агентов»: agent read keys, their rights, and the binding of a desktop
 * install to one sign-in. The writes are the old tab's (`TechnicalTab`) with their
 * calls unchanged; «Снять привязку» now asks first, and the key's one showing can
 * only be closed by its button (design/screens/system.md §6).
 */

const CAPABILITY_HELP: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Текст сообщений целиком: переписки и фрагменты в поиске",
  "read:money": "Операции, суммы трат, цены подписок",
  "read:observations_envelope": "Записи журнала сбора: только описание, без содержимого",
  "read:datasets": "Зарегистрированные запросы к наборам данных",
  "request:hydration": "Заявки на историю переписки (выполнять ли — решает владелец)",
  "approve:publications": "Утверждать черновики постов и альбомов на своих страницах — после «да» владельца в чате",
  "write:publication_drafts": "Черновики постов на своих страницах (утверждает человек)",
  "write:fan_queues": "Очереди фанов для чаттеров на своих страницах: по слову того, кто попросил",
  "read:content": "Посты, вложения, файлы и медиатека своих страниц с их просмотрами и лайками — без переписки, фанов и денег",
};

const CAPABILITY_SHORT: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Читать переписку",
  "read:money": "Читать деньги",
  "read:observations_envelope": "Журнал сбора: описание",
  "read:datasets": "Наборы данных",
  "request:hydration": "Подавать заявки на историю",
  "approve:publications": "Утверждать посты",
  "write:publication_drafts": "Писать черновики постов",
  "write:fan_queues": "Вести очереди фанов",
  "read:content": "Читать контент",
};

const INPUT = "input";

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

function keyStatus(key: AgentKeyItem) {
  return key.isActive ? AGENT_KEY_STATUS.active! : key.revokedAt ? AGENT_KEY_STATUS.revoked! : AGENT_KEY_STATUS.expired!;
}

export function AgentKeysPage() {
  const keys = useAgentKeys();
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-6">
      <PageHeader
        actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Выпустить ключ</button>}
        fresh={freshOf(keys)}
      />
      <AgentKeysSection creating={creating} onCreating={setCreating} />
      <HarvestBindingCard />
    </div>
  );
}

function AgentKeysSection({ creating, onCreating }: { creating: boolean; onCreating: (value: boolean) => void }) {
  const query = useAgentKeys();
  const { data: keys, isLoading, isError } = query;
  const [issuedToken, setIssuedToken] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentKeyItem | null>(null);
  const [editing, setEditing] = useState<AgentKeyItem | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const revoke = useRevokeAgentKey();
  // OWNED BY THE SCREEN, NOT THE MODAL. TanStack runs a per-call `mutate` callback
  // only while the observer that issued it is mounted, so a modal that owned this
  // mutation would DISCARD the token handoff if the owner dismissed it mid-flight:
  // the server commits the key, nobody ever sees the only copy of its token.
  const create = useCreateAgentKey();

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
            Ключ даёт ИИ-агенту только отмеченные страницы и только отмеченные права; роли человека у ключа нет. Пока ключом
            пользуются, срок продлевается, но не дальше 365 дней с выпуска.
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
                const menu = [
                  ...(key.isActive ? [{ label: "Изменить права", onSelect: () => setEditing(key) }] : []),
                  ...(key.revokedAt === null ? [{ label: "Отозвать", onSelect: () => setRevoking(key), danger: true }] : []),
                ];
                return (
                  <Fragment key={key.id}>
                    <tr className={`sys-click-row${key.isActive ? "" : " sys-mute"}`} data-agent-key={key.name} onClick={toggleRow}>
                      <td className="whitespace-nowrap">
                        <RowChevron open={isOpen} label={isOpen ? `Свернуть: ${key.name}` : `Раскрыть: ${key.name}`} onToggle={toggleRow} />
                        <span className="font-medium">{key.name}</span>
                      </td>
                      <td>{firstTwo(key.capabilities.map((capability) => CAPABILITY_SHORT[capability] ?? capability))}</td>
                      <td>{firstTwo(key.pageLabels)}</td>
                      <td className="whitespace-nowrap">
                        до {formatDateTime(key.expiresAt, { yearUnlessCurrent: true })}
                        <span className="cell-second">{key.lastUsedAt ? `использован ${formatAgo(key.lastUsedAt)}` : "ещё не использовался"}</span>
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
          onClose={() => onCreating(false)}
          onIssued={(token, name) => {
            onCreating(false);
            setIssuedToken({ token, name });
          }}
        />
      )}

      {issuedToken && (
        <TokenRevealModal token={issuedToken.token} name={issuedToken.name} onClose={() => setIssuedToken(null)} />
      )}

      {editing && <EditAgentKeyCapabilitiesModal agentKey={editing} onClose={() => setEditing(null)} />}

      {revoking && (
        <ConfirmModal
          title={`Отозвать ключ «${revoking.name}»?`}
          message="Ключ перестанет работать сразу. Отзыв нельзя отменить: при необходимости выпустите новый ключ."
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
  onClose,
  onIssued,
}: {
  create: ReturnType<typeof useCreateAgentKey>;
  onClose: () => void;
  onIssued: (token: string, name: string) => void;
}) {
  const { data: pages, isLoading: pagesLoading, isError: pagesError, refetch: refetchPages, isFetching: pagesFetching } = useAdminPages();
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(90);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    create.mutate({
      name: name.trim(),
      capabilities,
      pageLabels,
      expiresInDays,
    }, {
      onSuccess: (result) => onIssued(result.token, result.key.name),
      onError: () => {
        toast.error("Не удалось выпустить ключ");
      },
    });
  }

  const canSubmit = name.trim().length > 0
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
      <form className="space-y-5" onSubmit={handleSubmit}>
        <Field label="Название">
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="Например, аудит кастомов"
            className={INPUT}
          />
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
 * not editable here: a page is added only by issuing a new key.
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
      onError: () => {
        toast.error("Не удалось изменить права ключа");
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
      <form className="space-y-5" onSubmit={handleSubmit}>
        <p className="text-sm text-text-secondary">
          Новые права действуют со следующего запроса агента: выпускать ключ заново не нужно. Страницы
          остаются прежними: {agentKey.pageLabels.join(", ")}. Чтобы добавить страницу, выпустите новый ключ.
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

function TokenRevealModal({
  token,
  name,
  onClose,
}: {
  token: string;
  name: string;
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
    <ModalShell title={`Ключ «${name}»`} onClose={onClose} closeLabel="Закрыть" explicitCloseOnly>
      <div className="space-y-4">
        <Notice tone="warning">
          Ключ показывается один раз. Hub хранит только его отпечаток: потерянный ключ выпускают заново,
          восстановить его нельзя.
        </Notice>
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

/* ------------------------------------------------------------------ */
/*  Harvest binding                                                    */
/* ------------------------------------------------------------------ */

const MACHINE_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors the contract's `z.string().uuid()` so a typo is refused before the
 * round-trip — a mistyped machineId would bind harvest authority to a machine
 * that does not exist. */
export function isMachineId(value: string): boolean {
  return MACHINE_ID_PATTERN.test(value.trim());
}

/**
 * Binds one Desktop install's preserved machineId to one of a person's device
 * tokens, so harvested captures are attributable to a machine the owner chose.
 * Rebinding the same machineId transfers the authority atomically server-side;
 * the UI never has to revoke first.
 *
 * The machineId is technical by nature and lives only here and in the Desktop
 * app's own Diagnostics screen — never in the Team tab.
 */
function HarvestBindingCard() {
  const [shown, setShown] = useState(false);
  return (
    <section className="card" aria-labelledby="harvest-binding-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="harvest-binding-title" className="card-title">Привязка сбора данных к устройству</h2>
          <p className="card-description sys-measure">
            Какой компьютер с настольным приложением может передавать в Hub собранные на нём данные и от имени какого входа сотрудника.
          </p>
        </div>
        {!shown && <button type="button" className="btn" onClick={() => setShown(true)}>Привязать компьютер</button>}
      </div>
      {shown && <div className="card-body"><HarvestBindingSection /></div>}
    </section>
  );
}

/**
 * Binds one Desktop install's preserved machineId to one of a person's device
 * tokens, so harvested captures are attributable to a machine the owner chose.
 * Rebinding the same machineId transfers the authority atomically server-side.
 * The machine number lives only here and in the Desktop app's own Diagnostics.
 */
export function HarvestBindingSection() {
  const { data: users, isLoading: usersLoading, isError: usersError, refetch: refetchUsers } = useAdminUsers();
  const [userId, setUserId] = useState<number | null>(null);
  const [tokenId, setTokenId] = useState<number | null>(null);
  const [machineId, setMachineId] = useState("");
  const [unbinding, setUnbinding] = useState(false);

  const candidates = (users ?? []).filter((user) => !user.disabledAt && !user.deletedAt);
  const selectedUser = candidates.find((user) => user.id === userId) ?? null;
  const devices = useUserDevices(selectedUser?.id ?? null);
  const setCapability = useSetHarvestCapability(selectedUser?.id ?? null);
  const activeDevices = selectedUser ? (devices.data ?? []).filter((device) => device.isActive) : [];
  const selected = activeDevices.find((device) => device.id === tokenId) ?? null;
  const machineIdValid = isMachineId(machineId);

  function apply(nextMachineId: string | null) {
    if (!selectedUser || tokenId === null || !selected || usersError || devices.isError || setCapability.isPending) return;
    setCapability.mutate({ tokenId, machineId: nextMachineId }, {
      onSuccess: () => {
        toast.success(nextMachineId ? "Устройство привязано к этому входу" : "Привязка снята");
        if (!nextMachineId) setMachineId("");
        setUnbinding(false);
      },
      onError: () => {
        toast.error("Не удалось сохранить привязку");
        setUnbinding(false);
      },
    });
  }

  return (
    <div className="sys-stack sys-harvest">
      <p className="text-text-secondary sys-measure">
        Один номер устройства привязывается ровно к одному входу. Номер показывает настольное приложение на экране «Диагностика приложения».
      </p>

      {usersError && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void refetchUsers()}>Повторить</button>}>
          Список команды недоступен.
        </Notice>
      )}
      {usersLoading && !users && <p className="text-text-secondary">Загружаем…</p>}

      <div className="sys-harvest-fields">
        <Field label="Сотрудник">
          <select
            value={selectedUser ? String(selectedUser.id) : ""}
            onChange={(event) => {
              setUserId(event.target.value === "" ? null : Number(event.target.value));
              setMachineId("");
              setTokenId(null);
            }}
            className="select"
          >
            <option value="">Выберите сотрудника…</option>
            {candidates.map((user) => (
              <option key={user.id} value={String(user.id)}>{user.username}</option>
            ))}
          </select>
        </Field>

        <Field label="Вход">
          <select
            value={tokenId === null ? "" : String(tokenId)}
            disabled={!selectedUser || usersError || devices.isError}
            onChange={(event) => setTokenId(event.target.value === "" ? null : Number(event.target.value))}
            className="select"
          >
            <option value="">Выберите вход…</option>
            {activeDevices.map((device) => (
              <option key={device.id} value={String(device.id)}>
                {device.label}
                {device.harvestMachineId ? " — привязан" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {devices.isError && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void devices.refetch()}>Повторить</button>}>
          Входы сотрудника недоступны.
        </Notice>
      )}
      {selectedUser && devices.data && activeDevices.length === 0 && (
        <p className="text-text-secondary">У сотрудника нет действующих входов.</p>
      )}

      {selected && (
        <div className="sys-harvest-bind">
          <p className="text-text-secondary">
            Сейчас привязано: {selected.harvestMachineId ? <code className="sys-code">{selected.harvestMachineId}</code> : "ничего"}
          </p>
          <div className="sys-harvest-row">
            <input
              value={machineId}
              aria-label="Номер устройства"
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setMachineId(event.target.value)}
              className={`input sys-machine-input${machineId.trim() !== "" && !machineIdValid ? " input-invalid" : ""}`}
            />
            <button
              type="button"
              disabled={!machineIdValid || usersError || devices.isError || setCapability.isPending}
              onClick={() => apply(machineId.trim())}
              className="btn btn-primary"
            >
              {setCapability.isPending && !unbinding ? "Сохраняем…" : "Привязать"}
            </button>
            {selected.harvestMachineId && (
              <button
                type="button"
                disabled={usersError || devices.isError || setCapability.isPending}
                onClick={() => setUnbinding(true)}
                className="btn btn-danger-outline"
              >
                Снять привязку
              </button>
            )}
          </div>
          {machineId.trim() !== "" && !machineIdValid && (
            <p role="alert" className="sys-error">Номер устройства — это UUID, например 3f2504e0-4f89-11d3-9a0c-0305e82c3301.</p>
          )}
        </div>
      )}

      {unbinding && selected && selectedUser && (
        <ConfirmModal
          title="Снять привязку компьютера?"
          message={`Компьютер ${selected.harvestMachineId ?? ""} перестанет передавать собранные данные от имени входа «${selected.label}» сотрудника ${selectedUser.username}.`}
          facts={[{ label: "Отменить", value: "можно, привяжите компьютер снова." }]}
          confirmLabel="Снять привязку"
          pendingLabel="Снимаем…"
          tone="primary"
          isPending={setCapability.isPending}
          onConfirm={() => apply(null)}
          onClose={() => setUnbinding(false)}
        />
      )}
    </div>
  );
}
