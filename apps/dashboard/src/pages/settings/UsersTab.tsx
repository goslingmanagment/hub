import { useState } from "react";
import type {
  AdminCreateUserBody,
  AdminUser,
} from "@agency_hub_core/contracts";
import { creatableUserRoles } from "@agency_hub_core/shared";
import {
  useAdminUsers,
  useAdminCreateUser,
  useAdminPages,
  useAdminIssueApiKey,
  useAdminRevokeApiKeys,
  useAdminSetPassword,
  useAdminUserApiKeys,
  useAdminAssignPage,
  useAdminUnassignPage,
} from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Field } from "@/components/shared/Field";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
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

const thClass =
  "px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted";
const tdClass = "px-4 py-3 text-sm";
const btnSecondary =
  "rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover";

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export function UsersTab() {
  const { data: users, isLoading } = useAdminUsers();
  const [modal, setModal] = useState<ModalState>(null);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading users...</div>
    );
  }

  const items = users ?? [];
  const chatters = items.filter((u) => u.role === "chatter");
  const staff = items.filter((u) => u.role !== "chatter");
  const modalUser = modal && "username" in modal
    ? findAdminUserByUsername(items, modal.username)
    : null;

  return (
    <>
      <div className="space-y-8">
        {/* ---- Chatters ---- */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary">Chatters</h2>
            <button
              type="button"
              onClick={() => setModal({ type: "addChatter" })}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
            >
              Add Chatter
            </button>
          </div>

          {chatters.length === 0 ? (
            <p className="text-sm text-text-muted">No chatters yet. Add one to get started.</p>
          ) : (
            <section className="overflow-hidden rounded-xl border border-border bg-card">
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
                    <tr key={user.id} className="border-t border-border">
                      <td className={`${tdClass} font-medium text-text-primary`}>
                        {user.username}
                      </td>

                      {/* Key Status */}
                      <td className={tdClass}>
                        {hasActiveKey(user) ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 rounded-full bg-green" />
                            <span className="text-text-secondary">
                              Active
                              <span className="ml-1 text-text-muted">
                                ({user.apiKeyStatus!.activeKeyPrefix}...)
                              </span>
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 rounded-full bg-text-muted/40" />
                            <span className="text-text-muted">No active key</span>
                          </span>
                        )}
                      </td>

                      {/* Last Active */}
                      <td className={`${tdClass} text-text-muted`}>
                        {user.apiKeyStatus?.activeKeyLastUsedAt
                          ? formatRelativeTime(user.apiKeyStatus.activeKeyLastUsedAt)
                          : "Never"}
                      </td>

                      {/* Pages */}
                      <td className={tdClass}>
                        {user.assignedPages.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {user.assignedPages.map((page) => (
                              <span
                                key={page.id}
                                className="inline-flex items-center gap-1"
                              >
                                <PlatformBadge platform={page.platform} />
                                <span className="text-text-secondary">{page.label}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-text-muted">{"\u2014"}</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className={`${tdClass} text-right`}>
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
            <h2 className="text-sm font-bold text-text-primary">Staff</h2>
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
            <section className="overflow-hidden rounded-xl border border-border bg-card">
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
                    <tr key={user.id} className="border-t border-border">
                      <td className={`${tdClass} font-medium text-text-primary`}>
                        {user.username}
                      </td>
                      <td className={`${tdClass} text-text-secondary capitalize`}>
                        {user.role.replaceAll("_", " ")}
                      </td>
                      <td className={`${tdClass} text-text-secondary`}>
                        {user.assignedPages.length > 0
                          ? user.assignedPages.map((page) => page.label).join(", ")
                          : "\u2014"}
                      </td>
                      <td className={`${tdClass} text-right`}>
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
      {modal?.type === "chatterDetail" && modalUser && (
        <ChatterDetailModal
          user={modalUser}
          onClose={() => setModal(null)}
        />
      )}
    </>
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
      className="rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
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
  const { data: allPages } = useAdminPages();
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

        {allPages && allPages.length > 0 && (
          <Field label="Assign a page (optional)">
            <select
              value={selectedPage}
              onChange={(e) => setSelectedPage(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">None</option>
              {allPages.map((page) => (
                <option key={page.id} value={page.label}>
                  {page.label} ({page.platform} / {page.modelName})
                </option>
              ))}
            </select>
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

function ChatterDetailModal({
  user,
  onClose,
}: {
  user: AdminUser;
  onClose: () => void;
}) {
  const { data: apiKeys, isLoading: keysLoading } = useAdminUserApiKeys(
    user.username,
  );
  const { data: allPages } = useAdminPages();
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
          {keysLoading ? (
            <p className="text-sm text-text-muted">Loading...</p>
          ) : !apiKeys || apiKeys.length === 0 ? (
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
        </div>

        {/* Page Assignments */}
        <PageAssignmentsEditor
          assignedPages={user.assignedPages}
          availablePages={availablePages}
          selectedLabel={selectedLabel}
          onSelectedLabelChange={setSelectedLabel}
          onAssign={handleAssign}
          onUnassign={handleUnassign}
          assignPending={assignPage.isPending}
          unassignPending={unassignPage.isPending}
        />
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
