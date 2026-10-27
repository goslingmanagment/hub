import { useState } from "react";
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
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

/**
 * System → «Ключи агентов»: the ONE place in the console where
 * the machinery is named out loud.
 *
 * Everywhere else the owner deals in people, logins, devices and links (§2
 * vocabulary, pinned by tests/dashboard-copy-vocabulary.test.ts, which
 * excludes this file by name). Here live the two surfaces that are genuinely
 * about machines: agent read-plane keys, and the Desktop harvest binding that
 * ties one preserved machine identity to one sign-in.
 */

const CAPABILITY_HELP: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Текст сообщений целиком: переписки и фрагменты в поиске",
  "read:money": "Операции, суммы трат, цены подписок",
  "read:observations_envelope": "Записи журнала сбора: только описание, без содержимого",
  "read:datasets": "Зарегистрированные запросы к наборам данных",
  "request:hydration": "Заявки на дозагрузку истории (выполнять ли — решает владелец)",
  "approve:publications": "Утверждать черновики постов и альбомов на своих страницах — после «да» владельца в чате",
  "write:publication_drafts": "Черновики постов на своих страницах (утверждает человек)",
};

const INPUT = "input";

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** The capability checkboxes, shared by issuance and by «Изменить права». */
function CapabilityCheckboxes({
  value,
  onChange,
}: {
  value: AgentCapability[];
  onChange: (next: AgentCapability[]) => void;
}) {
  return (
    <div className="space-y-2">
      {AGENT_CAPABILITIES.map((capability) => (
        <label key={capability} className="flex items-start gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={value.includes(capability)}
            onChange={() => onChange(toggle(value, capability))}
            className="mt-1"
          />
          <span>
            <span className="block">{CAPABILITY_HELP[capability]}</span>
            <span className="font-mono text-xs text-text-muted">{capability}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** The section's heading and description are SettingsPage's: the tab opens
 *  with its two cards. */
export function TechnicalTab() {
  return (
    <div className="space-y-6">
      <AgentKeysSection />
      <section className="card" aria-labelledby="harvest-binding-title">
        <div className="card-header">
          <div>
            <h3 id="harvest-binding-title" className="card-title">Привязка сбора данных к устройству</h3>
            <p className="card-description">
              Какой компьютер с настольным приложением может передавать в Hub собранные на нём данные — и от
              имени какого входа сотрудника.
            </p>
          </div>
        </div>
        <div className="card-body">
          <HarvestBindingSection />
        </div>
      </section>
    </div>
  );
}

function AgentKeysSection() {
  const { data: keys, isLoading, isError, error } = useAgentKeys();
  const [creating, setCreating] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentKeyItem | null>(null);
  const [editing, setEditing] = useState<AgentKeyItem | null>(null);
  const revoke = useRevokeAgentKey();
  // OWNED BY THE TAB, NOT THE MODAL (review round 2). TanStack runs a per-call
  // `mutate` callback only while the observer that issued it is mounted, so a
  // modal that owned this mutation would DISCARD the token handoff if the owner
  // dismissed it mid-flight: the server commits the key, nobody ever sees the
  // only copy of its token, and re-issuing under the same name hits a 409. The
  // tab outlives the modal, so the handoff cannot be dropped.
  const create = useCreateAgentKey();

  if (isLoading && !keys) {
    return <StatusPanel title="Загружаем ключи агентов" />;
  }

  if (isError && !keys) {
    return (
      <StatusPanel
        title="Ключи агентов не загрузились"
        description={error instanceof Error ? error.message : "Список ключей получить не удалось."}
        tone="error"
      />
    );
  }

  const items = keys ?? [];

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
      onError: (mutationError) => {
        toast.error(mutationError instanceof Error ? mutationError.message : "Не удалось отозвать ключ");
      },
    });
  }

  return (
    <section className="card" aria-labelledby="agent-keys-title">
      <div className="card-header">
        <div className="min-w-0 max-w-2xl">
          <h3 id="agent-keys-title" className="card-title">Ключи доступа</h3>
          <p className="card-description">
            Ключ даёт AI-агенту чтение только перечисленных страниц и только выбранных данных; роли человека у
            ключа нет. Пока ключом пользуются, срок продлевается, но не дальше 365 дней с выпуска.
          </p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="btn btn-primary btn-sm">
          Выпустить ключ
        </button>
      </div>

      <div className="card-body space-y-3">
        {isError && keys && <StaleDataNotice error={error} />}
        {items.length === 0 && (
          <p className="text-sm text-text-muted">Ключей пока нет.</p>
        )}
        {items.map((key) => (
          <div
            key={key.id}
            className={`rounded-xl border border-border p-4 ${key.isActive ? "" : "opacity-60"}`}
            data-agent-key={key.name}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="card-title">{key.name}</span>
                  {key.isActive
                    ? <span className="badge badge-success">Активен</span>
                    : <span className={key.revokedAt ? "badge badge-danger" : "badge"}>{key.revokedAt ? "Отозван" : "Истёк"}</span>}
                  <span className="font-mono text-xs text-text-muted">{key.keyPrefix}…</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {key.capabilities.map((capability) => (
                    <span
                      key={capability}
                      title={CAPABILITY_HELP[capability]}
                      className="rounded-md border border-border bg-hover-alt px-1.5 py-0.5 font-mono text-xs text-text-secondary"
                    >
                      {capability}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-sm text-text-secondary">
                  Страницы: {key.pageLabels.join(", ")}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  Истекает{" "}
                  {formatDateTime(key.expiresAt)} &middot;{" "}
                  {key.lastUsedAt ? `использован ${formatRelativeTime(key.lastUsedAt)}` : "ещё не использовался"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {key.isActive && (
                  <button type="button" onClick={() => setEditing(key)} className="btn btn-sm">
                    Изменить права
                  </button>
                )}
                {key.revokedAt === null && (
                  <button type="button" onClick={() => setRevoking(key)} className="btn btn-sm text-danger">
                    Отозвать
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {creating && (
        <CreateAgentKeyModal
          create={create}
          onClose={() => setCreating(false)}
          onIssued={(token, name) => {
            setCreating(false);
            setIssuedToken({ token, name });
          }}
        />
      )}

      {issuedToken && (
        <TokenRevealModal
          token={issuedToken.token}
          name={issuedToken.name}
          onClose={() => setIssuedToken(null)}
        />
      )}

      {editing && (
        <EditAgentKeyCapabilitiesModal agentKey={editing} onClose={() => setEditing(null)} />
      )}

      {revoking && (
        <ConfirmModal
          title={`Отозвать ключ «${revoking.name}»?`}
          message="Ключ перестанет работать сразу. Отзыв нельзя отменить — при необходимости выпустите новый ключ."
          confirmLabel="Отозвать"
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
  const { data: pages, isLoading: pagesLoading, isError: pagesError, error: pagesErrorValue, refetch: refetchPages, isFetching: pagesFetching } = useAdminPages();
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
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Не удалось выпустить ключ");
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
            placeholder="customs-audit"
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
              {pagesErrorValue instanceof Error ? pagesErrorValue.message : "Страницы не загрузились."} Выбор сохранён; обновите список перед выпуском ключа.
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
                <PlatformBadge platform={page.platform} />
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
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Не удалось изменить права ключа");
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
          Новые права действуют со следующего запроса агента — выпускать ключ заново не нужно. Страницы
          остаются прежними: {agentKey.pageLabels.join(", ")}. Чтобы добавить страницу, выпустите новый ключ.
        </p>

        <fieldset>
          <legend className="field-label">Доступ к данным</legend>
          <CapabilityCheckboxes value={capabilities} onChange={setCapabilities} />
        </fieldset>

        {!unchanged && (
          <div className="rounded-lg border border-border bg-hover-alt p-3 text-sm text-text-secondary">
            {added.length > 0 && <p>Добавится: {added.map((capability) => CAPABILITY_HELP[capability]).join("; ")}</p>}
            {removed.length > 0 && <p>Уберётся: {removed.map((capability) => CAPABILITY_HELP[capability]).join("; ")}</p>}
            {capabilities.length === 0 && (
              <p className="mt-1 text-warning-dark">Без отметок ключ останется рабочим, но ничего не сможет прочитать.</p>
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
    <ModalShell title={`Ключ «${name}»`} onClose={onClose} closeLabel="Закрыть">
      <div className="space-y-4">
        <p className="notice notice-warning font-medium">
          Ключ показывается один раз. Hub хранит только его отпечаток: потерянный ключ выпускают заново,
          восстановить его нельзя.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-hover-alt px-3 py-2.5 font-mono text-sm text-text-primary">
            {token}
          </code>
          <button type="button" onClick={handleCopy} className="btn btn-primary">
            {copied ? "Скопировано" : "Скопировать"}
          </button>
        </div>
        <details className="help">
          <summary>Для разработчика</summary>
          <div className="help-body">
            <p>
              Сохраните ключ в переменной <code className="font-mono">HUB_AGENT_KEY</code> или в файле{" "}
              <code className="font-mono">~/.config/hub/credentials</code> — консоль Hub найдёт его сама.
            </p>
          </div>
        </details>
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
export function HarvestBindingSection() {
  const { data: users, isLoading: usersLoading, isError: usersError, error: usersErrorValue } = useAdminUsers();
  const [userId, setUserId] = useState<number | null>(null);
  const [tokenId, setTokenId] = useState<number | null>(null);
  const [machineId, setMachineId] = useState("");

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
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Не удалось сохранить привязку");
      },
    });
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-text-secondary">
        Один идентификатор устройства привязывается ровно к одному входу. Идентификатор показывает
        настольное приложение на экране «Диагностика приложения».
      </p>

      {usersError && <StaleDataNotice title="Список команды недоступен" error={usersErrorValue} />}
      {usersLoading && !users && <p className="text-sm text-text-muted">Загружаем…</p>}

      <div className="grid gap-3 sm:grid-cols-2">
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
        <StaleDataNotice title="Входы сотрудника недоступны" error={devices.error} />
      )}
      {selectedUser && devices.data && activeDevices.length === 0 && (
        <p className="text-sm text-text-muted">У сотрудника нет действующих входов.</p>
      )}

      {selected && (
        <div className="rounded-lg border border-border bg-hover-alt p-3">
          <p className="text-sm text-text-secondary">
            Сейчас привязано: {selected.harvestMachineId
              ? <code className="font-mono text-xs">{selected.harvestMachineId}</code>
              : "ничего"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={machineId}
              aria-label="Идентификатор устройства"
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setMachineId(event.target.value)}
              className="input min-w-0 flex-1 basis-64 font-mono"
            />
            <button
              type="button"
              disabled={!machineIdValid || usersError || devices.isError || setCapability.isPending}
              onClick={() => apply(machineId.trim())}
              className="btn btn-primary"
            >
              {setCapability.isPending ? "Сохраняем…" : "Привязать"}
            </button>
            {selected.harvestMachineId && (
              <button
                type="button"
                disabled={usersError || devices.isError || setCapability.isPending}
                onClick={() => apply(null)}
                className="btn text-danger"
              >
                Снять привязку
              </button>
            )}
          </div>
          {machineId.trim() !== "" && !machineIdValid && (
            <p role="alert" className="mt-1.5 text-xs text-danger">
              Идентификатор устройства — это UUID, например 3f2504e0-4f89-11d3-9a0c-0305e82c3301.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
