import { useState, type ReactNode } from "react";
import type { AdminCreateUserBody, ConnectionItem, VerifyCredentialsBody } from "@agency_hub_core/contracts";
import { creatableUserRoles } from "@agency_hub_core/shared";
import {
  useAdminConnections,
  useAdminCreateUser,
  useAdminSyncRuns,
  useAdminSyncTrigger,
  useAdminUpdateCredentials,
  useAdminUsers,
} from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusDot } from "@/components/shared/StatusDot";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { toast } from "sonner";

type Tab = "credentials" | "sync" | "users";
type CredentialsModalConnection = Pick<ConnectionItem, "label" | "platform" | "proxyConfigured">;

const tabs: { key: Tab; label: string }[] = [
  { key: "credentials", label: "Credentials" },
  { key: "sync", label: "Sync" },
  { key: "users", label: "Users" },
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("credentials");

  return (
    <div>
      <h1 className="text-xl font-extrabold text-text-primary mb-5">Settings</h1>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "credentials" && <CredentialsTab />}
      {activeTab === "sync" && <SyncTab />}
      {activeTab === "users" && <UsersTab />}
    </div>
  );
}

function CredentialsTab() {
  const { data: connections, isLoading } = useAdminConnections();
  const [selectedConnection, setSelectedConnection] = useState<CredentialsModalConnection | null>(null);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading connections...</div>
    );
  }

  const items = connections ?? [];

  return (
    <>
      <div className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-text-muted">No connections configured.</p>
        )}
        {items.map((conn) => (
          <div
            key={conn.id}
            className="flex items-center justify-between rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-3">
              <StatusDot status={conn.connectionStatus} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-text-primary">
                    {conn.label}
                  </span>
                  <PlatformBadge platform={conn.platform} />
                </div>
                <div className="mt-0.5 text-xs text-text-muted">
                  @{conn.username ?? conn.displayName ?? "unknown"}
                  {conn.lastLightSyncAt && (
                    <> &middot; Last sync: {formatRelativeTime(conn.lastLightSyncAt)}</>
                  )}
                  <> &middot; {conn.subscriberCount} subs</>
                  {conn.platform === "fansly" && <> &middot; {conn.followerCount} followers</>}
                </div>
                {conn.lastSyncError && (
                  <div className="mt-1 text-xs text-danger">{conn.lastSyncError}</div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setSelectedConnection({
                  label: conn.label,
                  platform: conn.platform,
                  proxyConfigured: conn.proxyConfigured,
                })}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
            >
              Update Credentials
            </button>
          </div>
        ))}
      </div>

      {selectedConnection && (
        <CredentialsModal
          connection={selectedConnection}
          onClose={() => setSelectedConnection(null)}
        />
      )}
    </>
  );
}

function SyncTab() {
  const { data: connections } = useAdminConnections();
  const { data: runsData, isLoading: runsLoading } = useAdminSyncRuns({ limit: 20 });
  const triggerSync = useAdminSyncTrigger();

  const items = connections ?? [];
  const runs = runsData ?? [];

  async function handleTrigger(pageLabel: string, scope: "light" | "all") {
    try {
      await triggerSync.mutateAsync({ pageLabel, scope });
      toast.success(`Sync triggered for ${pageLabel} (${scope})`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to trigger sync");
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-sm font-bold text-text-primary mb-3">Manual Sync</h2>
        <div className="space-y-2">
          {items.map((conn) => (
            <div
              key={conn.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{conn.label}</span>
                <PlatformBadge platform={conn.platform} />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleTrigger(conn.label, "light")}
                  disabled={triggerSync.isPending}
                  className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
                >
                  Light Sync
                </button>
                <button
                  onClick={() => handleTrigger(conn.label, "all")}
                  disabled={triggerSync.isPending}
                  className="rounded-lg border border-border bg-card px-3 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
                >
                  Full Sync
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-bold text-text-primary mb-3">Recent Sync Runs</h2>
        {runsLoading && (
          <p className="text-sm text-text-muted">Loading runs...</p>
        )}
        {!runsLoading && runs.length === 0 && (
          <p className="text-sm text-text-muted">No sync runs found.</p>
        )}
        {runs.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Page", "Scope", "Started", "Status"].map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run, i) => {
                  const statusColor =
                    run.status === "completed" || run.status === "success"
                      ? "text-green"
                      : run.status === "failed"
                        ? "text-danger"
                        : run.status === "running"
                          ? "text-warning"
                          : "text-text-muted";

                  return (
                    <tr
                      key={`${run.pageLabel}-${run.startedAt}-${i}`}
                      className="border-t border-border"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-text-primary">
                        {run.pageLabel}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{run.stream}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className={`px-4 py-3 text-sm font-medium capitalize ${statusColor}`}>
                        {run.status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

function UsersTab() {
  const { data: users, isLoading } = useAdminUsers();
  const [isModalOpen, setIsModalOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading users...</div>
    );
  }

  const items = users ?? [];

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary">Users</h2>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            Create User
          </button>
        </div>

        {items.length === 0 && (
          <p className="text-sm text-text-muted">No users found.</p>
        )}
        {items.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Username", "Role", "Assigned Pages"].map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr key={user.id} className="border-t border-border">
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      {user.username}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary capitalize">
                      {user.role.replaceAll("_", " ")}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {user.assignedPages.length > 0
                        ? user.assignedPages.map((page) => page.label).join(", ")
                        : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {isModalOpen && <CreateUserModal onClose={() => setIsModalOpen(false)} />}
    </>
  );
}

function CredentialsModal({
  connection,
  onClose,
}: {
  connection: CredentialsModalConnection;
  onClose: () => void;
}) {
  const updateCredentials = useAdminUpdateCredentials(connection.label);
  const [authorization, setAuthorization] = useState("");
  const [fanslyClientId, setFanslyClientId] = useState("");
  const [fanslyClientCheck, setFanslyClientCheck] = useState("");
  const [fanslySessionId, setFanslySessionId] = useState("");
  const [onlyFansToken, setOnlyFansToken] = useState("");
  const [onlyFansUsername, setOnlyFansUsername] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [clearStoredProxy, setClearStoredProxy] = useState(false);

  const title = `Update ${connection.label} credentials`;
  const hasProxy = proxyUrl.trim().length > 0;

  async function handleSubmit() {
    const body: VerifyCredentialsBody = connection.platform === "fansly"
      ? {
        platform: "fansly",
        session: {
          authorization: authorization.trim(),
          fanslyClientId: fanslyClientId.trim() || undefined,
          fanslyClientCheck: fanslyClientCheck.trim() || undefined,
          fanslySessionId: fanslySessionId.trim() || undefined,
        },
        proxy: clearStoredProxy
          ? null
          : hasProxy
            ? {
              url: proxyUrl.trim(),
              username: proxyUsername.trim() || null,
              password: proxyPassword.trim() || null,
            }
            : undefined,
      }
      : {
        platform: "onlyfans",
        auth: {
          token: onlyFansToken.trim(),
        },
        username: onlyFansUsername.trim(),
        proxy: clearStoredProxy
          ? null
          : hasProxy
            ? {
              url: proxyUrl.trim(),
              username: proxyUsername.trim() || null,
              password: proxyPassword.trim() || null,
            }
            : undefined,
      };

    try {
      await updateCredentials.mutateAsync(body);
      toast.success("Credentials updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update credentials");
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-4">
        {connection.platform === "fansly" ? (
          <>
            <Field label="Authorization">
              <textarea
                value={authorization}
                onChange={(event) => setAuthorization(event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="fansly-client-id (optional)">
              <input
                value={fanslyClientId}
                onChange={(event) => setFanslyClientId(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="fansly-client-check (optional)">
              <input
                value={fanslyClientCheck}
                onChange={(event) => setFanslyClientCheck(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="fansly-session-id (optional)">
              <input
                value={fanslySessionId}
                onChange={(event) => setFanslySessionId(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Auth token">
              <textarea
                value={onlyFansToken}
                onChange={(event) => setOnlyFansToken(event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Username">
              <input
                value={onlyFansUsername}
                onChange={(event) => setOnlyFansUsername(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
          </>
        )}

        {connection.proxyConfigured && (
          <label className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={clearStoredProxy}
              onChange={(event) => setClearStoredProxy(event.target.checked)}
            />
            Remove the currently stored proxy on save
          </label>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Field label="Proxy URL (optional)">
            <input
              value={proxyUrl}
              onChange={(event) => {
                setProxyUrl(event.target.value);
                if (event.target.value.trim().length > 0) {
                  setClearStoredProxy(false);
                }
              }}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="Proxy username">
            <input
              value={proxyUsername}
              onChange={(event) => setProxyUsername(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="Proxy password">
            <input
              type="password"
              value={proxyPassword}
              onChange={(event) => setProxyPassword(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </div>
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
          disabled={updateCredentials.isPending}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}

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
      toast.error(error instanceof Error ? error.message : "Failed to create user");
    }
  }

  return (
    <ModalShell title="Create User" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Username">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(event) => {
              const nextRole = event.target.value as AdminCreateUserBody["role"];
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
              onChange={(event) => setPassword(event.target.value)}
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

function ModalShell({
  children,
  title,
  onClose,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-text-muted hover:text-text-primary"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-text-secondary">{label}</div>
      {children}
    </label>
  );
}
