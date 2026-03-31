import { useState } from "react";
import type {
  AdminCreateUserBody,
  AdminIssueApiKeyBody,
  AdminUser,
  ApiKeyItem,
  IssuedApiKeyResponse,
} from "@agency_hub_core/contracts";
import { creatableUserRoles } from "@agency_hub_core/shared";
import {
  useAdminUsers,
  useAdminCreateUser,
  useAdminPages,
  useAdminIssueApiKey,
  useAdminRevokeApiKeys,
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
        <AddChatterModal
          onClose={() => setModal(null)}
          onKeyIssued={(key, username) =>
            setModal({ type: "revealKey", key, username })
          }
        />
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
/*  AddChatterModal — create user + issue key in one flow              */
/* ------------------------------------------------------------------ */

function AddChatterModal({
  onClose,
  onKeyIssued,
}: {
  onClose: () => void;
  onKeyIssued: (key: string, username: string) => void;
}) {
  const createUser = useAdminCreateUser();
  const { data: allPages } = useAdminPages();
  const [username, setUsername] = useState("");
  const [selectedPage, setSelectedPage] = useState("");
  const [isPending, setIsPending] = useState(false);

  const issueKey = useAdminIssueApiKey(username.trim());

  async function handleSubmit() {
    const trimmed = username.trim();
    if (!trimmed) return;

    setIsPending(true);
    try {
      await createUser.mutateAsync({ username: trimmed, role: "chatter" });

      const body: AdminIssueApiKeyBody = selectedPage
        ? { pageLabel: selectedPage }
        : {};
      const result = await issueKey.mutateAsync(body);

      onKeyIssued(result.key, trimmed);
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
          disabled={isPending || !username.trim()}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Creating..." : "Create & Issue Key"}
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
  const [selectedLabel, setSelectedLabel] = useState("");

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
