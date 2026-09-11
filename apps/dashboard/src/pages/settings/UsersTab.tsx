import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  AdminCreateUserBody,
  AdminUser,
} from "@agency_hub_core/contracts";
import { creatableUserRoles } from "@agency_hub_core/shared";
import {
  useAdminUsers,
  useAdminCreateUser,
  useAdminDeactivateUser,
  useAdminPages,
  useAdminIssueApiKey,
  useIssuedUserApiKeys,
  useAdminReactivateUser,
  useAdminRevokeApiKeys,
  useAdminSetPassword,
  useAdminUserApiKeys,
  useAdminAssignPage,
  useAdminUnassignPage,
} from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { SearchInput } from "@/components/shared/SearchInput";
import { QuerySection } from "@/components/shared/QuerySection";
import { formatRelativeTime, formatDateTime } from "@/lib/format";
import { toast } from "sonner";
import { PageAssignmentsEditor } from "./PageAssignmentsEditor.js";
import { UserPageAssignmentModal } from "./UserPageAssignmentModal.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ModalState =
  | null
  | { type: "addChatter" }
  | { type: "createUser" }
  | { type: "assignPages"; username: string; snapshot: AdminUser }
  | { type: "confirmNewKey"; username: string; snapshot: AdminUser }
  | { type: "confirmRevoke"; username: string; snapshot: AdminUser }
  | { type: "confirmDeactivate"; username: string; snapshot: AdminUser }
  | { type: "confirmReactivate"; username: string; snapshot: AdminUser }
  | { type: "chatterDetail"; username: string; snapshot: AdminUser };

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function hasActiveKey(user: AdminUser): boolean {
  return !!user.apiKeyStatus?.activeKeyPrefix;
}

export function findAdminUserByUsername(
  users: readonly AdminUser[],
  username: string,
): AdminUser | null {
  return users.find((user) => user.username === username) ?? null;
}

/** Working chatters float up (freshest activity first); never-active rows
 * (probes, stale accounts) sink together, alphabetically. */
export function sortChattersByActivity(users: readonly AdminUser[]): AdminUser[] {
  return [...users].sort((a, b) => {
    const aTime = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
    const bTime = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    return a.username.localeCompare(b.username);
  });
}

/** Every key shares the constant `agency_hub_core_` prefix — only the tail
 * identifies it, so that's all the table shows. */
export function shortKeyPrefix(keyPrefix: string): string {
  return keyPrefix.replace(/^agency_hub_core_/, "…");
}

const thClass =
  "whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted";
const tdClass = "px-4 py-3 text-sm";
const btnSecondary =
  "min-h-8 whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover disabled:opacity-50";

/* ------------------------------------------------------------------ */
/*  PageChips — compact assignment chips; platform reads as a dot      */
/* ------------------------------------------------------------------ */

const PAGE_CHIP_LIMIT = 5;

function PageChips({ pages }: { pages: AdminUser["assignedPages"] }) {
  if (pages.length === 0) {
    return <span className="text-text-muted">Нет назначений</span>;
  }

  const visible = pages.length <= PAGE_CHIP_LIMIT
    ? pages
    : pages.slice(0, PAGE_CHIP_LIMIT - 1);
  const overflow = pages.slice(visible.length);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((page) => (
        <span
          key={page.id}
          title={`${page.label} — ${page.platform === "fansly" ? "Fansly" : "OnlyFans"} / ${page.modelName}`}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-hover-alt px-2 py-0.5 text-xs text-text-secondary"
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              page.platform === "fansly" ? "bg-fansly" : "bg-onlyfans"
            }`}
          />
          {page.label}
        </span>
      ))}
      {overflow.length > 0 && (
        <details className="max-w-full rounded-lg border border-border bg-hover-alt px-2 py-0.5 text-xs text-text-muted">
          <summary className="cursor-pointer" aria-label={`Показать ещё ${overflow.length} страниц`}>+{overflow.length}</summary>
          <ul className="mt-2 space-y-1">{overflow.map((page) => <li key={page.id} className="break-all">{page.label} · {page.modelName}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

const ROLE_LABELS: Record<AdminUser["role"], string> = { owner: "Владелец", team_lead: "Тимлид", chatter: "Чаттер", content_manager: "Контент-менеджер (прежняя роль)" };
const ROLE_HELP: Record<AdminUser["role"], string> = {
  owner: "Все страницы и управление Hub, командой и ключами.",
  team_lead: "Панель и аналитика по назначенным страницам. Управление командой и ключами остаётся у владельца.",
  chatter: "Вход в ChatGoose по паролю и работа с назначенными страницами. Панель Hub недоступна.",
  content_manager: "Прежняя роль: новые аккаунты с ней не создаются; вход по паролю недоступен.",
};

export function UsersTab() {
  const { data: users, isError, error, isFetching, refetch } = useAdminUsers({ suppressGlobalError: true });
  const [modal, setModal] = useState<ModalState>(null);
  const { issued, acknowledge, pending: keyPending } = useIssuedUserApiKeys();
  const receipt = issued[0];
  const [search, setSearch] = useSearchParams();
  const query = search.get("userQuery") ?? "";
  const rawStatus = search.get("userStatus");
  const status = rawStatus === "all" || rawStatus === "inactive" ? rawStatus : "active";
  const rawRole = search.get("userRole");
  const role = rawRole && Object.hasOwn(ROLE_LABELS, rawRole) ? rawRole : "all";
  const items = users ?? [];
  const filtered = items.filter((user) => {
    const statusMatches = status === "all" || (status === "inactive" ? Boolean(user.disabledAt) : !user.disabledAt);
    return statusMatches && (role === "all" || user.role === role) && `${user.username} ${ROLE_LABELS[user.role]} ${user.role} ${user.assignedPages.map((page) => `${page.label} ${page.modelName}`).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  const visible = [...sortChattersByActivity(filtered.filter((user) => user.role === "chatter" && !user.disabledAt)), ...filtered.filter((user) => user.role !== "chatter" && !user.disabledAt), ...filtered.filter((user) => user.disabledAt)];
  const currentModalUser = modal && "username" in modal ? findAdminUserByUsername(items, modal.username) : null;
  const modalUser = currentModalUser ?? (modal && "snapshot" in modal ? modal.snapshot : null);
  const actionsDisabled = !currentModalUser || Boolean(currentModalUser.disabledAt);
  const modalActionsBlocked = keyPending || Boolean(receipt);
  function openUserModal(type: "assignPages" | "confirmNewKey" | "confirmRevoke" | "confirmDeactivate" | "confirmReactivate" | "chatterDetail", user: AdminUser) {
    if (!modalActionsBlocked) setModal({ type, username: user.username, snapshot: user });
  }
  function updateSearch(changes: Record<string, string | null>) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
      return next;
    });
  }
  return <>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-xl text-sm text-text-muted">Сотрудники входят в ChatGoose по паролю. API-ключ необязателен и нужен для прежних подключений или автоматики.</p>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={modalActionsBlocked} onClick={() => setModal({ type: "addChatter" })} className="min-h-10 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Добавить чаттера</button><button type="button" disabled={modalActionsBlocked} onClick={() => setModal({ type: "createUser" })} className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Добавить сотрудника</button></div>
    </div>
    <details className="mb-4 rounded-lg border border-border bg-card px-3 py-2"><summary className="cursor-pointer text-sm font-semibold text-text-secondary">Что позволяют роли</summary><dl className="mt-3 space-y-2">{creatableUserRoles.map((entry) => <div key={entry}><dt className="text-sm font-medium">{ROLE_LABELS[entry]}</dt><dd className="text-xs text-text-muted">{ROLE_HELP[entry]}</dd></div>)}</dl></details>
    {keyPending && <p role="status" className="mb-3 text-sm text-text-secondary">Выдаём ключ. Он появится здесь после завершения запроса, в том числе после возврата в раздел.</p>}
    {isError && users && <div className="mb-4 flex flex-wrap items-center gap-2"><StaleDataNotice title="Показан последний загруженный список" error={error} className="flex-1" /><button type="button" onClick={() => void refetch()} disabled={isFetching} className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{isFetching ? "Обновляем…" : "Повторить"}</button></div>}
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <SearchInput value={query} onChange={(value) => updateSearch({ userQuery: value })} placeholder="Найти сотрудника, страницу или модель…" />
      <label className="text-xs text-text-secondary"><span className="mb-1 block">Роль</span><select value={role} onChange={(event) => updateSearch({ userRole: event.target.value === "all" ? null : event.target.value })} className="min-h-10 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"><option value="all">Все роли</option>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-xs text-text-secondary"><span className="mb-1 block">Состояние</span><select value={status} onChange={(event) => updateSearch({ userStatus: event.target.value === "active" ? null : event.target.value })} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm"><option value="active">Активные</option><option value="inactive">Деактивированные</option><option value="all">Все участники</option></select></label>
      {(query || role !== "all" || status !== "active") && <button type="button" onClick={() => updateSearch({ userQuery: null, userRole: null, userStatus: null })} className="min-h-10 text-sm text-accent">Сбросить фильтры</button>}
      {users && <span className="py-2 text-xs text-text-muted">{visible.length} из {items.length}</span>}
    </div>
    {!users ? <StatusPanel title={isError ? "Не удалось загрузить команду" : "Загружаем команду…"} tone={isError ? "error" : "default"} description={isError ? error instanceof Error ? error.message : "Список участников недоступен." : "Получаем участников и действующие назначения страниц."} action={isError ? <button type="button" onClick={() => void refetch()} disabled={isFetching} className="text-accent disabled:opacity-50">Повторить</button> : undefined} /> : visible.length === 0 ? <StatusPanel title={items.length === 0 ? "В команде пока нет участников" : "Участники не найдены"} description={items.length === 0 ? "Добавьте сотрудника и настройте доступ к страницам." : "Измените запрос, роль или состояние. Деактивированные участники доступны через фильтр."} /> : <section className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full min-w-[900px] border-collapse"><thead><tr className="bg-hover-alt">{["Участник", "Роль", "Доступ к страницам", "Последняя активность", "Ключ автоматики", "Действия"].map((col) => <th key={col} className={thClass}>{col}</th>)}</tr></thead><tbody>{visible.map((user) => <tr key={user.id} className={`border-t border-border ${user.disabledAt ? "bg-hover-alt text-text-muted" : "hover:bg-hover-alt"}`}>
      <td className={`${tdClass} font-medium`}><span className="block max-w-[180px] break-all">{user.username}</span>{user.disabledAt && <span className="mt-1 block text-xs text-text-muted">Деактивирован {formatDateTime(user.disabledAt)}</span>}</td>
      <td className={tdClass}><span title={ROLE_HELP[user.role]}>{ROLE_LABELS[user.role]}</span></td>
      <td className={tdClass}>{user.role === "owner" ? <span className="text-sm text-text-secondary">Все страницы</span> : <PageChips pages={user.assignedPages} />}</td>
      <td className={`${tdClass} whitespace-nowrap text-text-muted`} title={user.lastActiveAt ? formatDateTime(user.lastActiveAt) : undefined}>{user.lastActiveAt ? formatRelativeTime(user.lastActiveAt) : "Нет данных об активности"}</td>
      <td className={tdClass}>{user.role !== "chatter" ? <span className="text-text-muted">Не используется</span> : hasActiveKey(user) ? <span className="text-green">Активен <code className="block text-xs text-text-muted" title={user.apiKeyStatus?.activeKeyPrefix ?? undefined}>{shortKeyPrefix(user.apiKeyStatus!.activeKeyPrefix!)}</code></span> : <span className="text-text-muted">{user.apiKeyStatus ? "Нет активного ключа" : "Нет данных"}</span>}</td>
      <td className={tdClass}><div className="flex flex-wrap gap-1.5">{user.disabledAt ? <button type="button" disabled={modalActionsBlocked} aria-label={`Восстановить ${user.username}`} onClick={() => openUserModal("confirmReactivate", user)} className={btnSecondary}>Восстановить</button> : <>
        <button type="button" disabled={modalActionsBlocked} aria-label={`Управлять доступом ${user.username}`} onClick={() => openUserModal(user.role === "chatter" ? "chatterDetail" : "assignPages", user)} className={btnSecondary}>{user.role === "chatter" ? "Управлять" : "Доступ"}</button>
        {user.role === "chatter" && (hasActiveKey(user) ? <><button type="button" disabled={modalActionsBlocked} aria-label={`Заменить API-ключ ${user.username}`} onClick={() => openUserModal("confirmNewKey", user)} className={btnSecondary}>Заменить ключ</button><button type="button" disabled={modalActionsBlocked} aria-label={`Отозвать API-ключ ${user.username}`} onClick={() => openUserModal("confirmRevoke", user)} className={`${btnSecondary} !text-danger`}>Отозвать ключ</button></> : <IssueKeyButton username={user.username} disabled={modalActionsBlocked} />)}
        {user.role !== "owner" && user.role !== "chatter" && <button type="button" disabled={modalActionsBlocked} aria-label={`Деактивировать ${user.username}`} onClick={() => openUserModal("confirmDeactivate", user)} className={`${btnSecondary} !text-danger`}>Деактивировать</button>}
      </>}</div></td>
    </tr>)}</tbody></table></section>}
    {!receipt && modal?.type === "addChatter" && <AddChatterModal onClose={() => setModal(null)} />}
    {!receipt && modal?.type === "createUser" && <CreateUserModal onClose={() => setModal(null)} />}
    {!receipt && modal?.type === "assignPages" && modalUser && <UserPageAssignmentModal key={modalUser.id} user={modalUser} actionsDisabled={actionsDisabled} onClose={() => setModal(null)} />}
    {!receipt && modal?.type === "confirmNewKey" && modalUser && <NewKeyModal disabled={actionsDisabled} user={modalUser} onClose={() => setModal(null)} onKeyIssued={() => setModal(null)} />}
    {!receipt && modal?.type === "confirmRevoke" && modalUser && <RevokeKeyModal disabled={!currentModalUser} user={modalUser} onClose={() => setModal(null)} />}
    {!receipt && modal?.type === "confirmDeactivate" && modalUser && <DeactivateUserModal disabled={actionsDisabled} user={modalUser} onClose={() => setModal(null)} />}
    {!receipt && modal?.type === "confirmReactivate" && modalUser && <ReactivateUserModal disabled={!currentModalUser} user={modalUser} onClose={() => setModal(null)} />}
    {!receipt && modal?.type === "chatterDetail" && modalUser && <ChatterDetailModal key={modalUser.id} user={modalUser} actionsDisabled={actionsDisabled} onClose={() => setModal(null)} onDeactivate={() => openUserModal("confirmDeactivate", modalUser)} />}
    {receipt && <KeyRevealModal key={receipt.id} keyValue={receipt.result.key} username={receipt.username} onClose={() => { acknowledge(receipt.id); setModal(null); }} />}
  </>;
}

/* ------------------------------------------------------------------ */
/*  DeactivateUserModal / ReactivateUserModal                          */
/* ------------------------------------------------------------------ */

function UserActionModal({ title, message, confirmLabel, pending: externalPending = false, disabled = false, execute, onClose }: {
  title: string; message: string; confirmLabel: string; pending?: boolean; disabled?: boolean;
  execute: () => Promise<void>; onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = externalPending || submitting;
  function requestClose() { if (!inFlight.current && !externalPending) onClose(); }
  async function submit() {
    if (inFlight.current || pending || disabled) return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try { await execute(); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : "Не удалось выполнить действие"); }
    finally { inFlight.current = false; setSubmitting(false); }
  }
  return <ModalShell title={title} onClose={requestClose} closeDisabled={pending} closeLabel="Закрыть">
    <p className="text-sm text-text-secondary">{message}</p>
    {disabled && <p role="status" className="mt-3 text-sm text-warning-dark">Действие недоступно для текущего состояния пользователя. Обновите список команды.</p>}
    {error && <p role="alert" className="mt-3 break-words text-sm text-danger">{error}</p>}
    <div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" disabled={pending} onClick={requestClose} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Отмена</button><button type="button" disabled={pending || disabled} onClick={submit} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Выполняем…" : confirmLabel}</button></div>
  </ModalShell>;
}

function DeactivateUserModal({ user, onClose, disabled = false }: { user: AdminUser; onClose: () => void; disabled?: boolean }) {
  const deactivate = useAdminDeactivateUser(user.username);
  return <UserActionModal title={`Деактивировать ${user.username}?`} message="Все API-ключи, устройства и сессии пользователя будут отозваны. История и авторство сохранятся; пользователя можно восстановить позже." confirmLabel="Деактивировать" disabled={disabled || user.role === "owner" || Boolean(user.disabledAt)} onClose={onClose} execute={async () => {
    await deactivate.mutateAsync();
    toast.success(`${user.username}: доступ отключён, история сохранена`);
  }} />;
}

function ReactivateUserModal({ user, onClose, disabled = false }: { user: AdminUser; onClose: () => void; disabled?: boolean }) {
  const reactivate = useAdminReactivateUser(user.username);
  return <UserActionModal title={`Восстановить ${user.username}?`} message="Существующий пароль снова позволит войти. Отозванные API-ключи и устройства останутся отозванными; при необходимости сотрудник войдёт заново." confirmLabel="Восстановить" disabled={disabled || !user.disabledAt} onClose={onClose} execute={async () => {
    await reactivate.mutateAsync();
    toast.success(`${user.username}: восстановлен. Ключи и устройства остаются отозванными`);
  }} />;
}

function IssueKeyButton({ username, disabled = false }: { username: string; disabled?: boolean }) {
  const issueKey = useAdminIssueApiKey(username);
  const inFlight = useRef(false);
  async function handleClick() {
    if (inFlight.current || issueKey.isPending || disabled) return;
    inFlight.current = true;
    try { await issueKey.mutateAsync({}); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось выдать ключ"); }
    finally { inFlight.current = false; }
  }
  return <button type="button" aria-label={`Выдать API-ключ ${username}`} disabled={disabled || issueKey.isPending} onClick={handleClick} className={btnSecondary}>{issueKey.isPending ? "Выдаём…" : "Выдать ключ"}</button>;
}

/* ------------------------------------------------------------------ */
/*  AddChatterModal — create user; password is the human credential    */
/*  (#116: keys left the human onboarding path — the row's Issue Key   */
/*  button remains as the legacy/automation fallback)                  */
/* ------------------------------------------------------------------ */

/** #116 provisioning flow, extracted for tests: create → optional password →
 * optional page assign. Idempotent retry: when a later step failed on a prior
 * submit (createdUsername already equals this username), the create step is
 * skipped; re-setting the password on retry is an idempotent server-side
 * operation. */
export async function provisionChatter(input: {
  username: string;
  password: string;
  pageLabel: string;
  createdUsername: string | null;
  createUser: (username: string) => Promise<void>;
  onUserCreated: (username: string) => void;
  setPassword: (password: string) => Promise<void>;
  assignPage: (pageLabel: string) => Promise<void>;
}): Promise<void> {
  const trimmed = input.username.trim();
  if (input.createdUsername !== trimmed) {
    await input.createUser(trimmed);
    input.onUserCreated(trimmed);
  }
  if (input.password) {
    await input.setPassword(input.password);
  }
  if (input.pageLabel) {
    await input.assignPage(input.pageLabel);
  }
}

export function AddChatterModal({ onClose }: { onClose: () => void }) {
  const createUser = useAdminCreateUser();
  const pagesQuery = useAdminPages({ suppressGlobalError: true });
  const allPages = pagesQuery.data;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedPage, setSelectedPage] = useState("");
  const [pending, setPending] = useState(false);
  const [createdUsername, setCreatedUsername] = useState<string | null>(null);
  const [appliedPassword, setAppliedPassword] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const setUserPassword = useAdminSetPassword(createdUsername ?? username.trim());
  const assignPage = useAdminAssignPage(createdUsername ?? username.trim());
  const invalidPassword = password.length > 0 && (password.length < 8 || password.length > 256);
  const pageAvailable = !selectedPage || Boolean(allPages?.some((page) => page.label === selectedPage));
  function requestClose() { if (!inFlight.current) onClose(); }
  async function handleSubmit() {
    const trimmed = createdUsername ?? username.trim();
    if (inFlight.current || !trimmed || trimmed.length > 100 || invalidPassword || !pageAvailable) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await provisionChatter({
        username: trimmed, password: password === appliedPassword ? "" : password, pageLabel: selectedPage, createdUsername,
        createUser: async (name) => { await createUser.mutateAsync({ username: name, role: "chatter" }); },
        onUserCreated: setCreatedUsername,
        setPassword: async (value) => { await setUserPassword.mutateAsync({ password: value, mustChangePassword: false }); setAppliedPassword(value); },
        assignPage: async (pageLabel) => { await assignPage.mutateAsync({ pageLabel }); },
      });
      toast.success(password || appliedPassword ? `${trimmed}: готов к входу в ChatGoose${selectedPage ? "" : ". Назначьте страницы для работы"}` : `${trimmed}: создан без пароля. Задайте пароль через «Управлять»`);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "Не удалось закончить настройку чаттера"); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <ModalShell title="Добавить чаттера" onClose={requestClose} closeDisabled={pending} closeLabel="Закрыть">
    <form onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }} aria-busy={pending}>
      {createdUsername && <p role="status" className="mb-4 rounded-lg border border-warning/30 px-3 py-2 text-sm text-text-secondary">Пользователь {createdUsername} уже создан. Продолжение завершит оставшиеся шаги для этого же аккаунта; повторного создания не будет.{appliedPassword && " Пароль уже сохранён; если оставить его без изменений, он не будет установлен повторно."}</p>}
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Имя для входа"><input required maxLength={100} disabled={createdUsername !== null} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" placeholder="Например, sarah" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm disabled:opacity-60" /></Field>
        <Field label="Пароль (можно задать позже)"><input type="password" minLength={8} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" /><p className="mt-1 text-xs text-text-muted">8–256 символов. Сотрудник использует имя и пароль в ChatGoose; без пароля войти не получится.</p>{invalidPassword && <p className="mt-1 text-xs text-danger">Введите от 8 до 256 символов или оставьте поле пустым.</p>}</Field>
        <QueryNotice error={pagesQuery.isError} stale={allPages !== undefined} retry={pagesQuery.refetch} />
        {!allPages && !pagesQuery.isError && <p role="status" className="text-sm text-text-muted">Загружаем страницы…</p>}
        <Field label="Первая страница (необязательно)"><select value={selectedPage} onChange={(event) => setSelectedPage(event.target.value)} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"><option value="">Назначить позже</option>{selectedPage && !pageAvailable && <option value={selectedPage}>{selectedPage} · сейчас недоступна</option>}{allPages?.map((page) => <option key={page.id} value={page.label}>{page.label} ({page.platform} / {page.modelName})</option>)}</select>{!pageAvailable && <p role="status" className="mt-1 text-xs text-warning-dark">Выбранная страница исчезла из каталога. Обновите список или выберите «Назначить позже».</p>}</Field>
      </fieldset>
      {error && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" disabled={pending} onClick={requestClose} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{createdUsername ? "Закрыть" : "Отмена"}</button><button type="submit" disabled={pending || !username.trim() || invalidPassword || !pageAvailable} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Настраиваем…" : createdUsername ? "Завершить настройку" : "Создать чаттера"}</button></div>
    </form>
  </ModalShell>;
}

/* ------------------------------------------------------------------ */
/*  CreateUserModal — existing staff user creation (preserved)         */
/* ------------------------------------------------------------------ */

export function CreateUserModal({ onClose }: { onClose: () => void }) {
  const createUser = useAdminCreateUser();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<AdminCreateUserBody["role"]>("team_lead");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const requiresPassword = role === "owner" || role === "team_lead";
  const valid = Boolean(username.trim()) && username.trim().length <= 100 && (!requiresPassword || password.length >= 8 && password.length <= 256);
  const pending = submitting || createUser.isPending;
  function requestClose() { if (!inFlight.current) onClose(); }
  async function handleSubmit() {
    if (inFlight.current || !valid) return;
    inFlight.current = true; setSubmitting(true); setError("");
    try {
      await createUser.mutateAsync({ username: username.trim(), role, ...(requiresPassword ? { password } : {}) });
      toast.success(role === "owner" ? `${username.trim()}: владелец создан с доступом ко всем страницам` : `${username.trim()}: создан. Настройте доступ к страницам${role === "chatter" ? " и пароль через «Управлять»" : ""}`);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "Не удалось создать пользователя"); }
    finally { inFlight.current = false; setSubmitting(false); }
  }
  return <ModalShell title="Добавить сотрудника" onClose={requestClose} closeDisabled={pending} closeLabel="Закрыть">
    <form onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }} aria-busy={pending}>
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Имя для входа"><input required maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" /></Field>
        <Field label="Роль"><select value={role} onChange={(event) => setRole(event.target.value as AdminCreateUserBody["role"])} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm">{creatableUserRoles.map((entry) => <option key={entry} value={entry}>{ROLE_LABELS[entry]}</option>)}</select><p className="mt-2 text-xs text-text-muted">{ROLE_HELP[role]}</p></Field>
        {requiresPassword ? <Field label="Пароль"><input type="password" required minLength={8} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" /><p className="mt-1 text-xs text-text-muted">8–256 символов.</p>{password && password.length < 8 && <p className="mt-1 text-xs text-danger">Пароль должен содержать не менее 8 символов.</p>}</Field> : <p className="text-xs text-text-muted">Чаттер будет создан без пароля и назначений. Для полной настройки за один шаг используйте «Добавить чаттера».</p>}
      </fieldset>
      {error && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" disabled={pending} onClick={requestClose} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Отмена</button><button type="submit" disabled={pending || !valid} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Создаём…" : "Создать сотрудника"}</button></div>
    </form>
  </ModalShell>;
}

/* ------------------------------------------------------------------ */
/*  NewKeyModal — confirm rotation then issue                          */
/* ------------------------------------------------------------------ */

function NewKeyModal({ user, onClose, onKeyIssued, disabled = false }: { user: AdminUser; onClose: () => void; onKeyIssued: (key: string) => void; disabled?: boolean }) {
  const issueKey = useAdminIssueApiKey(user.username);
  return <UserActionModal title={`Заменить API-ключ ${user.username}?`} message="Текущий API-ключ будет отозван сразу после выдачи нового. Пароль и вход с устройств не меняются. Сохраните новый ключ и обновите использующие его подключения." confirmLabel="Заменить ключ" pending={issueKey.isPending} disabled={disabled || user.role !== "chatter" || Boolean(user.disabledAt)} onClose={onClose} execute={async () => { const result = await issueKey.mutateAsync({}); onKeyIssued(result.key); }} />;
}
function RevokeKeyModal({ user, onClose, disabled = false }: { user: AdminUser; onClose: () => void; disabled?: boolean }) {
  const revokeKeys = useAdminRevokeApiKeys(user.username);
  return <UserActionModal title={`Отозвать API-ключи ${user.username}?`} message="Подключения с API-ключом потеряют доступ. Пароль и токены устройств сохранятся. Для полного отключения пользователя используйте деактивацию." confirmLabel="Отозвать ключи" disabled={disabled} onClose={onClose} execute={async () => { await revokeKeys.mutateAsync(); toast.success(`${user.username}: API-ключи отозваны`); }} />;
}
export function KeyRevealModal({ keyValue, username, onClose }: { keyValue: string; username: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  async function handleCopy() {
    try { await navigator.clipboard.writeText(keyValue); setCopied(true); setCopyError(""); }
    catch { setCopyError("Буфер обмена недоступен. Выделите ключ и скопируйте его вручную."); }
  }
  return <ModalShell title={`API-ключ: ${username}`} onClose={onClose} closeDisabled={!copied} closeLabel="Закрыть">
    <p className="mb-4 text-sm font-medium text-warning-dark">Сохраните ключ перед закрытием. После закрытия повторный показ недоступен. Для обычного входа сотрудника используйте пароль.</p>
    <Field label="Секретный API-ключ"><textarea readOnly rows={3} value={keyValue} onFocus={(event) => event.target.select()} className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm" /></Field>
    <button type="button" onClick={handleCopy} className="mt-3 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white">{copied ? "Скопировано" : "Скопировать ключ"}</button>
    {copyError && <p role="alert" className="mt-2 text-sm text-danger">{copyError}</p>}
    <div className="mt-6 flex justify-end"><button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">Ключ сохранён — закрыть</button></div>
  </ModalShell>;
}

/* ------------------------------------------------------------------ */
/*  ChatterDetailModal — key history + page management                 */
/* ------------------------------------------------------------------ */

export function ChatterDetailModal({
  user,
  onClose,
  onDeactivate,
  actionsDisabled = false,
}: {
  user: AdminUser;
  onClose: () => void;
  onDeactivate: () => void;
  actionsDisabled?: boolean;
}) {
  const keysQuery = useAdminUserApiKeys(user.username, { suppressGlobalError: true });
  const apiKeys = keysQuery.data;
  const pagesQuery = useAdminPages({ suppressGlobalError: true });
  const allPages = pagesQuery.data;
  const assignPage = useAdminAssignPage(user.username);
  const unassignPage = useAdminUnassignPage(user.username);
  const setUserPassword = useAdminSetPassword(user.username);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeAction, setActiveAction] = useState<"password" | "assign" | "unassign" | null>(null);
  const inFlight = useRef(false);
  const pending = activeAction !== null || assignPage.isPending || unassignPage.isPending || setUserPassword.isPending;
  const disabled = pending || actionsDisabled;
  const validPassword = newPassword.length >= 8 && newPassword.length <= 256;
  const assignedLabels = new Set(user.assignedPages.map((page) => page.label));
  const availablePages = (allPages ?? []).filter((page) => !assignedLabels.has(page.label));

  function requestClose() {
    if (!inFlight.current && !pending) onClose();
  }
  async function perform(action: "password" | "assign" | "unassign", execute: () => Promise<void>) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setActiveAction(action);
    setActionError("");
    try { await execute(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Не удалось сохранить изменения"); }
    finally { inFlight.current = false; setActiveAction(null); }
  }
  function handleSetPassword() {
    if (!validPassword) return;
    return perform("password", async () => {
      // #116: chatter clients cannot complete a forced password change.
      await setUserPassword.mutateAsync({ password: newPassword, mustChangePassword: false });
      setNewPassword("");
      toast.success(`${user.username}: пароль сохранён, прежние сессии и устройства отключены`);
    });
  }
  function handleAssign() {
    if (!availablePages.some((page) => page.label === selectedLabel)) return;
    return perform("assign", async () => {
      await assignPage.mutateAsync({ pageLabel: selectedLabel });
      toast.success(`${selectedLabel}: назначена пользователю ${user.username}`);
      setSelectedLabel("");
    });
  }
  function handleUnassign(pageLabel: string) {
    return perform("unassign", async () => {
      await unassignPage.mutateAsync(pageLabel);
      toast.success(`${pageLabel}: прямое назначение снято. Доступ через модель, если он есть, сохраняется.`);
    });
  }

  return (
    <ModalShell title={`Управлять: ${user.username}`} onClose={requestClose} closeDisabled={pending} closeLabel="Закрыть">
      <div className="space-y-6" aria-busy={pending}>
        {actionsDisabled && <p role="status" className="text-sm text-warning-dark">Актуальный активный пользователь недоступен. Черновик сохранён; изменения пока заблокированы.</p>}
        <form onSubmit={(event) => { event.preventDefault(); return handleSetPassword(); }}>
          <fieldset disabled={disabled}>
            <Field label="Новый пароль для ChatGoose">
              <input type="password" required minLength={8} maxLength={256} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" className="min-h-10 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
            </Field>
            <p className="mt-2 text-xs text-text-muted">8–256 символов. Сохранение пароля отключит прежние сессии и устройства: сотруднику нужно будет войти заново. API-ключи сохранятся.</p>
            {newPassword && !validPassword && <p className="mt-1 text-xs text-danger">Введите от 8 до 256 символов.</p>}
            <button type="submit" disabled={disabled || !validPassword} className="mt-3 min-h-10 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{activeAction === "password" ? "Сохраняем…" : "Сохранить пароль"}</button>
          </fieldset>
        </form>
        {actionError && <p role="alert" className="break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{actionError}</p>}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">История API-ключей</h3>
          <p className="mb-2 text-xs text-text-muted">API-ключи относятся к прежним подключениям и автоматике. Отсутствие ключа не мешает входу по паролю.</p>
          <QuerySection title="История ключей" hasData={apiKeys !== undefined} isError={keysQuery.isError} retry={keysQuery.refetch}>
            {apiKeys?.length === 0 ? <p className="text-sm text-text-muted">API-ключи ещё не выдавались.</p> : <div className="space-y-1.5">
              {apiKeys?.map((key) => <div key={key.id} className="rounded-lg border border-border bg-bg px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm"><code className="min-w-0 break-all font-mono text-text-primary">{key.keyPrefix}…</code><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${key.isActive ? "bg-green/15 text-green" : "bg-text-muted/10 text-text-muted"}`}>{key.isActive ? "Активен" : "Отозван"}</span>{key.revokedReason && <span className="break-words text-text-muted">({key.revokedReason})</span>}</div>
                <div className="mt-1 text-xs text-text-muted">Выдан {formatDateTime(key.createdAt)} · Последнее использование: {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : "не использовался"}</div>
              </div>)}
            </div>}
          </QuerySection>
        </div>
        <div>
          <QueryNotice error={pagesQuery.isError} stale={allPages !== undefined} retry={pagesQuery.refetch} />
          {!allPages && !pagesQuery.isError && <p role="status" className="text-sm text-text-muted">Загружаем каталог страниц для назначения…</p>}
          {allPages?.length === 0 && <p className="text-sm text-text-muted">В каталоге пока нет доступных страниц.</p>}
          <PageAssignmentsEditor assignedPages={user.assignedPages} availablePages={availablePages} selectedLabel={selectedLabel} onSelectedLabelChange={setSelectedLabel} onAssign={handleAssign} onUnassign={handleUnassign} assignPending={activeAction === "assign" || assignPage.isPending} unassignPending={activeAction === "unassign" || unassignPage.isPending} disabled={disabled} availablePagesLoaded={allPages !== undefined} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-text-muted">Деактивация отключит {user.username} на всех устройствах и отзовёт API-ключи. История сохранится; аккаунт можно восстановить позже.</p>
          <button type="button" disabled={disabled} onClick={() => { if (!inFlight.current && !disabled) onDeactivate(); }} className="min-h-9 shrink-0 rounded-lg border border-danger/25 bg-card px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50">Деактивировать</button>
        </div>
      </div>
      <div className="mt-6 flex justify-end"><button type="button" disabled={pending} onClick={requestClose} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50">Готово</button></div>
    </ModalShell>
  );
}
