import { useState } from "react";
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
  useAdminReactivateUser,
  useAdminRevokeApiKeys,
  useAdminSetPassword,
  useAdminUserApiKeys,
  useAdminAssignPage,
  useAdminUnassignPage,
} from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Field } from "@/components/shared/Field";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { QueryNotice } from "@/components/shared/QueryNotice";
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
  | { type: "assignPages"; username: string }
  | { type: "confirmNewKey"; username: string }
  | { type: "confirmRevoke"; username: string }
  | { type: "confirmDeactivate"; username: string }
  | { type: "confirmReactivate"; username: string }
  | { type: "revealKey"; key: string; username: string }
  | { type: "chatterDetail"; username: string };

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
  "whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover";

/* ------------------------------------------------------------------ */
/*  PageChips — compact assignment chips; platform reads as a dot      */
/* ------------------------------------------------------------------ */

const PAGE_CHIP_LIMIT = 5;

function PageChips({ pages }: { pages: AdminUser["assignedPages"] }) {
  if (pages.length === 0) {
    return <span className="text-text-muted">{"—"}</span>;
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
        <span
          title={overflow.map((page) => page.label).join(", ")}
          className="inline-flex items-center rounded-full border border-border bg-hover-alt px-2 py-0.5 text-xs text-text-muted"
        >
          +{overflow.length}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export function UsersTab() {
  const { data: users, isLoading, isError, error, isFetching, refetch } = useAdminUsers();
  const [modal, setModal] = useState<ModalState>(null);

  if (isLoading && !users) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading users...</div>
    );
  }

  if (isError && !users) {
    return (
      <div role="alert">
        <StatusPanel
          title="Не удалось загрузить команду"
          description={error instanceof Error ? error.message : "Список участников недоступен. Попробуйте загрузить его снова."}
          tone="error"
          action={(
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
            >
              {isFetching ? "Обновляем…" : "Повторить"}
            </button>
          )}
        />
      </div>
    );
  }

  const items = users ?? [];
  const chatters = sortChattersByActivity(
    items.filter((u) => u.role === "chatter" && !u.disabledAt),
  );
  const staff = items.filter((u) => u.role !== "chatter" && !u.disabledAt);
  const deactivated = items.filter((u) => u.disabledAt);
  const modalUser = modal && "username" in modal
    ? findAdminUserByUsername(items, modal.username)
    : null;

  return (
    <>
      {isError && users && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StaleDataNotice title="Показан последний загруженный список" error={error} className="flex-1" />
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            {isFetching ? "Обновляем…" : "Повторить"}
          </button>
        </div>
      )}
      <div className="space-y-8">
        {/* ---- Chatters ---- */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary">
              Chatters
              {chatters.length > 0 && (
                <span className="ml-1.5 font-normal text-text-muted">{chatters.length}</span>
              )}
            </h2>
            <div className="flex items-center gap-4">
              <span className="hidden items-center gap-3 text-[11px] text-text-muted sm:inline-flex">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-fansly" />
                  Fansly
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-onlyfans" />
                  OnlyFans
                </span>
              </span>
              <button
                type="button"
                onClick={() => setModal({ type: "addChatter" })}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
              >
                Add Chatter
              </button>
            </div>
          </div>

          {chatters.length === 0 ? (
            <p className="text-sm text-text-muted">No chatters yet. Add one to get started.</p>
          ) : (
            <section className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-hover-alt">
                    {["Username", "Key Status", "Last Active", "Pages", ""].map(
                      (col) => (
                        <th key={col} className={thClass}>
                          {col}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {chatters.map((user) => (
                    <tr
                      key={user.id}
                      onClick={() =>
                        setModal({ type: "chatterDetail", username: user.username })}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-hover-alt"
                    >
                      <td className={`${tdClass} font-medium text-text-primary`}>
                        <span title={user.username} className="block max-w-[200px] truncate">
                          {user.username}
                        </span>
                      </td>

                      {/* Key Status */}
                      <td className={`${tdClass} whitespace-nowrap`}>
                        {hasActiveKey(user) ? (
                          <span
                            className="inline-flex items-center gap-1.5"
                            title={`${user.apiKeyStatus!.activeKeyPrefix}…`}
                          >
                            <span className="inline-block h-2 w-2 rounded-full bg-green" />
                            <span className="text-text-secondary">Active</span>
                            <code className="font-mono text-xs text-text-muted">
                              {shortKeyPrefix(user.apiKeyStatus!.activeKeyPrefix!)}
                            </code>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 rounded-full bg-text-muted/40" />
                            <span className="text-text-muted">No key</span>
                          </span>
                        )}
                      </td>

                      {/* Last Active — key OR device-token use (#116 chatters
                          hold no key, so the key column alone reads "Never") */}
                      <td
                        className={`${tdClass} whitespace-nowrap text-text-muted`}
                        title={user.lastActiveAt ? formatDateTime(user.lastActiveAt) : undefined}
                      >
                        {user.lastActiveAt
                          ? formatRelativeTime(user.lastActiveAt)
                          : "Never"}
                      </td>

                      {/* Pages */}
                      <td className={tdClass}>
                        <PageChips pages={user.assignedPages} />
                      </td>

                      {/* Actions; clicks stay in the cell (the row opens Manage) */}
                      <td
                        className={`${tdClass} text-right`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-1.5">
                          {hasActiveKey(user) ? (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setModal({ type: "confirmNewKey", username: user.username })
                                }
                                className={btnSecondary}
                              >
                                New Key
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setModal({ type: "confirmRevoke", username: user.username })
                                }
                                className={`${btnSecondary} !text-danger`}
                              >
                                Revoke
                              </button>
                            </>
                          ) : (
                            <IssueKeyButton
                              username={user.username}
                              onKeyIssued={(key) =>
                                setModal({
                                  type: "revealKey",
                                  key,
                                  username: user.username,
                                })
                              }
                            />
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setModal({ type: "chatterDetail", username: user.username })
                            }
                            className={btnSecondary}
                          >
                            Manage
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        {/* ---- Staff ---- */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary">
              Staff
              {staff.length > 0 && (
                <span className="ml-1.5 font-normal text-text-muted">{staff.length}</span>
              )}
            </h2>
            <button
              type="button"
              onClick={() => setModal({ type: "createUser" })}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
            >
              Create User
            </button>
          </div>

          {staff.length === 0 ? (
            <p className="text-sm text-text-muted">No staff users.</p>
          ) : (
            <section className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-hover-alt">
                    {["Username", "Role", "Assigned Pages", ""].map((col) => (
                      <th key={col} className={thClass}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {staff.map((user) => (
                    <tr
                      key={user.id}
                      onClick={() =>
                        setModal({ type: "assignPages", username: user.username })}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-hover-alt"
                    >
                      <td className={`${tdClass} font-medium text-text-primary`}>
                        {user.username}
                      </td>
                      <td className={`${tdClass} text-text-secondary capitalize`}>
                        {user.role.replaceAll("_", " ")}
                      </td>
                      <td className={tdClass}>
                        <PageChips pages={user.assignedPages} />
                      </td>
                      <td
                        className={`${tdClass} text-right`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => setModal({ type: "assignPages", username: user.username })}
                          className={btnSecondary}
                        >
                          Manage Pages
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        {/* ---- Deactivated (#126: tombstoned, not deleted) ---- */}
        {deactivated.length > 0 && (
          <DeactivatedSection
            users={deactivated}
            onReactivate={(username) =>
              setModal({ type: "confirmReactivate", username })}
          />
        )}
      </div>

      {/* ---- Modals ---- */}
      {modal?.type === "addChatter" && (
        <AddChatterModal onClose={() => setModal(null)} />
      )}
      {modal?.type === "createUser" && (
        <CreateUserModal onClose={() => setModal(null)} />
      )}
      {modal?.type === "assignPages" && modalUser && (
        <UserPageAssignmentModal
          user={modalUser}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "confirmNewKey" && modalUser && (
        <NewKeyModal
          user={modalUser}
          onClose={() => setModal(null)}
          onKeyIssued={(key) =>
            setModal({ type: "revealKey", key, username: modalUser.username })
          }
        />
      )}
      {modal?.type === "confirmRevoke" && modalUser && (
        <RevokeKeyModal
          user={modalUser}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "revealKey" && (
        <KeyRevealModal
          keyValue={modal.key}
          username={modal.username}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "confirmDeactivate" && modalUser && (
        <DeactivateUserModal
          user={modalUser}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "confirmReactivate" && modalUser && (
        <ReactivateUserModal
          user={modalUser}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "chatterDetail" && modalUser && (
        <ChatterDetailModal
          user={modalUser}
          onClose={() => setModal(null)}
          onDeactivate={() =>
            setModal({ type: "confirmDeactivate", username: modalUser.username })}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  DeactivatedSection — collapsed list of tombstoned users (#126)     */
/* ------------------------------------------------------------------ */

function DeactivatedSection({
  users,
  onReactivate,
}: {
  users: AdminUser[];
  onReactivate: (username: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mb-3 flex items-center gap-1.5 text-sm font-bold text-text-muted transition-colors hover:text-text-primary"
      >
        <span
          className={`inline-block text-xs transition-transform ${open ? "rotate-90" : ""}`}
        >
          {"▸"}
        </span>
        Deactivated ({users.length})
      </button>

      {open && (
        <section className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-hover-alt">
                {["Username", "Role", "Deactivated", ""].map((col) => (
                  <th key={col} className={thClass}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-border">
                  <td className={`${tdClass} font-medium text-text-muted`}>
                    {user.username}
                  </td>
                  <td className={`${tdClass} capitalize text-text-muted`}>
                    {user.role.replaceAll("_", " ")}
                  </td>
                  <td className={`${tdClass} text-text-muted`}>
                    {user.disabledAt ? formatRelativeTime(user.disabledAt) : "—"}
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <button
                      type="button"
                      onClick={() => onReactivate(user.username)}
                      className={btnSecondary}
                    >
                      Reactivate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DeactivateUserModal / ReactivateUserModal                          */
/* ------------------------------------------------------------------ */

function DeactivateUserModal({
  user,
  onClose,
}: {
  user: AdminUser;
  onClose: () => void;
}) {
  const deactivate = useAdminDeactivateUser(user.username);

  async function handleConfirm() {
    try {
      const result = await deactivate.mutateAsync();
      const revoked = result.revokedApiKeys + result.revokedDeviceTokens + result.revokedSessions;
      toast.success(
        revoked > 0
          ? `${user.username} deactivated — signed out everywhere (${revoked} credential${revoked === 1 ? "" : "s"} revoked)`
          : `${user.username} deactivated`,
      );
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to deactivate user",
      );
    }
  }

  return (
    <ConfirmModal
      title={`Deactivate ${user.username}`}
      message={`This signs ${user.username} out everywhere: their API key, device sessions, and dashboard sessions are revoked, and they move to the Deactivated list. History and attribution are preserved — you can reactivate them later.`}
      confirmLabel="Deactivate"
      isPending={deactivate.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

function ReactivateUserModal({
  user,
  onClose,
}: {
  user: AdminUser;
  onClose: () => void;
}) {
  const reactivate = useAdminReactivateUser(user.username);

  async function handleConfirm() {
    try {
      await reactivate.mutateAsync();
      toast.success(
        `${user.username} reactivated — their password works again; keys and devices stay revoked`,
      );
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to reactivate user",
      );
    }
  }

  return (
    <ConfirmModal
      title={`Reactivate ${user.username}`}
      message={`${user.username} will be able to sign in with their existing password again immediately. Previously revoked API keys and device tokens stay revoked — issue fresh ones if needed.`}
      confirmLabel="Reactivate"
      isPending={reactivate.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  IssueKeyButton — inline button that issues a key directly          */
/* ------------------------------------------------------------------ */

function IssueKeyButton({
  username,
  onKeyIssued,
}: {
  username: string;
  onKeyIssued: (key: string) => void;
}) {
  const issueKey = useAdminIssueApiKey(username);

  async function handleClick() {
    try {
      const result = await issueKey.mutateAsync({});
      onKeyIssued(result.key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to issue key");
    }
  }

  return (
    <button
      type="button"
      disabled={issueKey.isPending}
      onClick={handleClick}
      className={`${btnSecondary} disabled:opacity-50`}
    >
      {issueKey.isPending ? "Issuing..." : "Issue Key"}
    </button>
  );
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

function AddChatterModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const createUser = useAdminCreateUser();
  const pagesQuery = useAdminPages();
  const allPages = pagesQuery.data;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedPage, setSelectedPage] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [createdUsername, setCreatedUsername] = useState<string | null>(null);

  const setUserPassword = useAdminSetPassword(username.trim());
  const assignPage = useAdminAssignPage(username.trim());

  const passwordTooShort = password.length > 0 && password.length < 8;

  async function handleSubmit() {
    const trimmed = username.trim();
    if (!trimmed || passwordTooShort) return;

    setIsPending(true);
    try {
      await provisionChatter({
        username,
        password,
        pageLabel: selectedPage,
        createdUsername,
        createUser: async (name) => {
          await createUser.mutateAsync({ username: name, role: "chatter" });
        },
        onUserCreated: setCreatedUsername,
        setPassword: async (pw) => {
          // mustChangePassword stays off (#116): no chatter-reachable surface
          // can complete a forced change yet.
          await setUserPassword.mutateAsync({
            password: pw,
            mustChangePassword: false,
          });
        },
        assignPage: async (pageLabel) => {
          await assignPage.mutateAsync({ pageLabel });
        },
      });

      toast.success(
        password
          ? `${trimmed} created — they can now sign in from the extension/desktop`
          : `${trimmed} created (no password — set one, or issue a key)`,
      );
      onClose();
    } catch (error) {
      setIsPending(false);
      toast.error(
        error instanceof Error ? error.message : "Failed to create chatter",
      );
    }
  }

  return (
    <ModalShell title="Add Chatter" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. sarah"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="min 8 characters"
            autoComplete="new-password"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <p className="mt-1 text-xs text-text-muted">
            The chatter signs in with this in ChatGoose (extension or desktop)
            to mint their own device token — no key to send around.
          </p>
          {passwordTooShort && (
            <p className="mt-1 text-xs text-danger">
              Password must be at least 8 characters.
            </p>
          )}
        </Field>

        <Field label="Assign a page (optional)">
          <QuerySection title="Доступные страницы" hasData={allPages !== undefined} isError={pagesQuery.isError} retry={pagesQuery.refetch}>
            {allPages?.length === 0 && <p className="mb-2 text-sm text-text-muted">В каталоге пока нет доступных страниц.</p>}
            <select
              value={selectedPage}
              onChange={(e) => setSelectedPage(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">None</option>
              {allPages?.map((page) => (
                <option key={page.id} value={page.label}>
                  {page.label} ({page.platform} / {page.modelName})
                </option>
              ))}
            </select>
          </QuerySection>
        </Field>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isPending || !username.trim() || passwordTooShort}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Creating..." : "Create Chatter"}
        </button>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/*  CreateUserModal — existing staff user creation (preserved)         */
/* ------------------------------------------------------------------ */

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const createUser = useAdminCreateUser();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<AdminCreateUserBody["role"]>("team_lead");
  const [password, setPassword] = useState("");

  const requiresPassword = role === "owner" || role === "team_lead";

  async function handleSubmit() {
    const body: AdminCreateUserBody = {
      username: username.trim(),
      role,
      password: requiresPassword ? password : undefined,
    };

    try {
      await createUser.mutateAsync(body);
      toast.success("User created");
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create user",
      );
    }
  }

  return (
    <ModalShell title="Create User" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => {
              const nextRole = e.target.value as AdminCreateUserBody["role"];
              setRole(nextRole);
              if (nextRole !== "owner" && nextRole !== "team_lead") {
                setPassword("");
              }
            }}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {creatableUserRoles.map((option) => (
              <option key={option} value={option}>
                {option.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        {requiresPassword && (
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={createUser.isPending}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/*  NewKeyModal — confirm rotation then issue                          */
/* ------------------------------------------------------------------ */

function NewKeyModal({
  user,
  onClose,
  onKeyIssued,
}: {
  user: AdminUser;
  onClose: () => void;
  onKeyIssued: (key: string) => void;
}) {
  const issueKey = useAdminIssueApiKey(user.username);

  async function handleConfirm() {
    try {
      const result = await issueKey.mutateAsync({});
      onKeyIssued(result.key);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to issue key",
      );
    }
  }

  return (
    <ConfirmModal
      title="New API Key"
      message={`This will create a new key for ${user.username} and revoke their current one. You\u2019ll need to send them the new key.`}
      confirmLabel="New Key"
      isPending={issueKey.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  RevokeKeyModal                                                     */
/* ------------------------------------------------------------------ */

function RevokeKeyModal({
  user,
  onClose,
}: {
  user: AdminUser;
  onClose: () => void;
}) {
  const revokeKeys = useAdminRevokeApiKeys(user.username);

  async function handleConfirm() {
    try {
      await revokeKeys.mutateAsync();
      toast.success("Key revoked");
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke key",
      );
    }
  }

  return (
    <ConfirmModal
      title="Revoke API Key"
      message={`This will disconnect ${user.username}\u2019s browser extension immediately. They won\u2019t be able to connect until you issue a new key.`}
      confirmLabel="Revoke Key"
      isPending={revokeKeys.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  KeyRevealModal — shown once after issuing a key                    */
/* ------------------------------------------------------------------ */

function KeyRevealModal({
  keyValue,
  username,
  onClose,
}: {
  keyValue: string;
  username: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(keyValue);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <ModalShell title={`API Key for ${username}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm font-medium text-warning">
          This key is shown only once. Copy it now and send it to the chatter.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 select-all break-all rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-sm text-text-primary">
            {keyValue}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/*  ChatterDetailModal — key history + page management                 */
/* ------------------------------------------------------------------ */

export function ChatterDetailModal({
  user,
  onClose,
  onDeactivate,
}: {
  user: AdminUser;
  onClose: () => void;
  onDeactivate: () => void;
}) {
  const keysQuery = useAdminUserApiKeys(user.username);
  const apiKeys = keysQuery.data;
  const pagesQuery = useAdminPages();
  const allPages = pagesQuery.data;
  const assignPage = useAdminAssignPage(user.username);
  const unassignPage = useAdminUnassignPage(user.username);
  const setUserPassword = useAdminSetPassword(user.username);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [newPassword, setNewPassword] = useState("");

  async function handleSetPassword() {
    if (newPassword.length < 8) return;
    try {
      // mustChangePassword stays off (#116): no chatter-reachable surface
      // can complete a forced change yet.
      await setUserPassword.mutateAsync({
        password: newPassword,
        mustChangePassword: false,
      });
      setNewPassword("");
      toast.success(
        `Password set for ${user.username} — their active sessions were signed out`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to set password",
      );
    }
  }

  const assignedLabels = new Set(user.assignedPages.map((p) => p.label));
  const availablePages = (allPages ?? []).filter(
    (p) => !assignedLabels.has(p.label),
  );

  async function handleAssign() {
    if (!selectedLabel) return;
    try {
      await assignPage.mutateAsync({ pageLabel: selectedLabel });
      toast.success(`Assigned ${selectedLabel} to ${user.username}`);
      setSelectedLabel("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to assign page",
      );
    }
  }

  async function handleUnassign(pageLabel: string) {
    try {
      await unassignPage.mutateAsync(pageLabel);
      toast.success(`Unassigned ${pageLabel} from ${user.username}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to unassign page",
      );
    }
  }

  return (
    <ModalShell title={`Manage ${user.username}`} onClose={onClose}>
      <div className="space-y-6">
        {/* Password (#116: the human credential — device tokens ride it) */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">
            Password
          </h3>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (min 8 characters)"
              autoComplete="new-password"
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={newPassword.length < 8 || setUserPassword.isPending}
              onClick={handleSetPassword}
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {setUserPassword.isPending ? "Setting..." : "Set password"}
            </button>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            The chatter signs in with this in ChatGoose to mint a device token.
            Setting a password signs out their active sessions.
          </p>
        </div>

        {/* Key History */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">
            Key History
          </h3>
          <QuerySection title="История ключей" hasData={apiKeys !== undefined} isError={keysQuery.isError} retry={keysQuery.refetch}>
          {!apiKeys || apiKeys.length === 0 ? (
            <p className="text-sm text-text-muted">No keys have been issued.</p>
          ) : (
            <div className="space-y-1.5">
              {apiKeys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <code className="font-mono text-text-primary">
                      {k.keyPrefix}...
                    </code>
                    {k.isActive ? (
                      <span className="rounded bg-green/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-green">
                        Active
                      </span>
                    ) : (
                      <span className="rounded bg-text-muted/10 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-text-muted">
                        Revoked
                      </span>
                    )}
                    {k.revokedReason && (
                      <span className="text-text-muted">
                        ({k.revokedReason})
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted">
                    {formatDateTime(k.createdAt)}
                    {k.lastUsedAt && (
                      <span className="ml-2">
                        last used {formatRelativeTime(k.lastUsedAt)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          </QuerySection>
        </div>

        {/* Page Assignments */}
        <QueryNotice error={pagesQuery.isError} stale={allPages !== undefined} retry={pagesQuery.refetch} />
        {!allPages && !pagesQuery.isError && <p role="status" className="text-sm text-text-muted">Загружаем каталог страниц для назначения…</p>}
        {allPages?.length === 0 && <p className="text-sm text-text-muted">В каталоге пока нет доступных страниц.</p>}
        <PageAssignmentsEditor
          assignedPages={user.assignedPages}
          availablePages={availablePages}
          selectedLabel={selectedLabel}
          onSelectedLabelChange={setSelectedLabel}
          onAssign={handleAssign}
          onUnassign={handleUnassign}
          assignPending={assignPage.isPending || allPages === undefined}
          unassignPending={unassignPage.isPending}
        />

        {/* Deactivation (#126: tombstone, never delete) */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2.5">
          <p className="text-xs text-text-muted">
            Deactivating signs {user.username} out everywhere and hides them
            from the list. History is preserved; you can reactivate later.
          </p>
          <button
            type="button"
            onClick={onDeactivate}
            className="shrink-0 rounded-lg border border-danger/25 bg-card px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
          >
            Deactivate
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}
