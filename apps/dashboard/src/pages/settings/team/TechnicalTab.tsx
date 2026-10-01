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
  useUserDevices,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

/**
 * Decision 350 — "Техническое": the ONE place in the console where the
 * machinery is named out loud.
 *
 * Everywhere else the owner deals in people, logins, devices and links (§2
 * vocabulary, pinned by tests/dashboard-copy-vocabulary.test.ts, which
 * excludes this file by name). Here live the two surfaces that are genuinely
 * about machines: agent read-plane keys, and the Desktop harvest binding that
 * ties one preserved machine identity to one sign-in.
 */

const CAPABILITY_HELP: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Verbatim message text: transcripts and search snippets",
  "read:money": "Transactions, spend rollups, subscription prices",
  "read:observations_envelope": "Capture-journal envelopes (metadata, never payloads)",
  "read:datasets": "The registered dataset queries",
  "request:hydration": "Filing a hydration request (execution stays an owner decision)",
};

export function TechnicalTab() {
  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-sm font-bold text-text-primary">Ключи агентов</h2>
        <AgentKeysSection />
      </section>
      <section>
        <h2 className="mb-3 text-sm font-bold text-text-primary">Привязка сбора данных</h2>
        <HarvestBindingSection />
      </section>
    </div>
  );
}

function AgentKeysSection() {
  const { data: keys, isLoading, isError, error } = useAgentKeys();
  const [creating, setCreating] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentKeyItem | null>(null);
  const revoke = useRevokeAgentKey();
  // OWNED BY THE TAB, NOT THE MODAL (review round 2). TanStack runs a per-call
  // `mutate` callback only while the observer that issued it is mounted, so a
  // modal that owned this mutation would DISCARD the token handoff if the owner
  // dismissed it mid-flight: the server commits the key, nobody ever sees the
  // only copy of its token, and re-issuing under the same name hits a 409. The
  // tab outlives the modal, so the handoff cannot be dropped.
  const create = useCreateAgentKey();

  if (isLoading && !keys) {
    return <div className="py-12 text-center text-sm text-text-muted">Loading agent keys...</div>;
  }

  if (isError && !keys) {
    return (
      <StatusPanel
        title="Agent keys failed to load"
        description={error instanceof Error ? error.message : "The agent key list could not be fetched."}
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
          ? `Revoked "${target.name}"`
          : `"${target.name}" was already revoked`);
        setRevoking(null);
      },
      onError: (mutationError) => {
        toast.error(mutationError instanceof Error ? mutationError.message : "Revoke failed");
      },
    });
  }

  return (
    <>
      {isError && keys && <StaleDataNotice error={error} className="mb-4" />}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-text-muted">
          Machine credentials for the agent read plane. A key holds no human role: it reads
          exactly the pages listed on its row, and nothing outside its capabilities. Keys
          expire, slide forward while in use, and never live past 365 days from issuance.
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Issue key
        </button>
      </div>

      <div className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-text-muted">No agent keys issued.</p>
        )}
        {items.map((key) => (
          <div
            key={key.id}
            className={`rounded-xl border bg-card p-4 ${
              key.isActive ? "border-border" : "border-border opacity-60"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-text-primary">{key.name}</span>
                  {key.isActive
                    ? (
                      <span className="rounded-full border border-border bg-hover px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                        Active
                      </span>
                    )
                    : (
                      <span className="rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
                        {key.revokedAt ? "Revoked" : "Expired"}
                      </span>
                    )}
                </div>
                <div className="mt-0.5 font-mono text-xs text-text-muted">{key.keyPrefix}...</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {key.capabilities.map((capability) => (
                    <span
                      key={capability}
                      title={CAPABILITY_HELP[capability]}
                      className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
                    >
                      {capability}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-xs text-text-muted">
                  Pages: {key.pageLabels.join(", ")}
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  {key.dailyRequestBudget.toLocaleString()} req/day &middot;{" "}
                  {key.dailyRowBudget.toLocaleString()} rows/day &middot; expires{" "}
                  {formatDateTime(key.expiresAt)} &middot; last used{" "}
                  {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : "never"}
                </div>
              </div>
              {key.revokedAt === null && (
                <button
                  type="button"
                  onClick={() => setRevoking(key)}
                  className="shrink-0 rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                >
                  Revoke
                </button>
              )}
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

      {revoking && (
        <ConfirmModal
          title={`Revoke "${revoking.name}"?`}
          message="The key stops authenticating immediately. Revocation cannot be undone; issue a new key instead."
          confirmLabel="Revoke"
          isPending={revoke.isPending}
          onConfirm={handleRevoke}
          onClose={() => setRevoking(null)}
        />
      )}
    </>
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
  const [dailyRequestBudget, setDailyRequestBudget] = useState(5_000);
  const [dailyRowBudget, setDailyRowBudget] = useState(500_000);

  function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    create.mutate({
      name: name.trim(),
      capabilities,
      pageLabels,
      expiresInDays,
      dailyRequestBudget,
      dailyRowBudget,
    }, {
      onSuccess: (result) => onIssued(result.token, result.key.name),
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Issuing the key failed");
      },
    });
  }

  const canSubmit = name.trim().length > 0
    && capabilities.length > 0
    && pageLabels.length > 0
    && Boolean(pages) && !pagesError
    && pageLabels.every((label) => pages?.some((page) => page.label === label))
    && Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
    && Number.isInteger(dailyRequestBudget) && dailyRequestBudget >= 1 && dailyRequestBudget <= 1_000_000
    && Number.isInteger(dailyRowBudget) && dailyRowBudget >= 1 && dailyRowBudget <= 100_000_000
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
    <ModalShell title="Issue agent key" onClose={closeUnlessPending}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Name">
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="customs-audit"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
          />
        </Field>

        <div>
          <div className="mb-1 text-sm text-text-secondary">Capabilities</div>
          <div className="space-y-1">
            {AGENT_CAPABILITIES.map((capability) => (
              <label key={capability} className="flex items-start gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={() => setCapabilities((current) => toggle(current, capability))}
                  className="mt-1"
                />
                <span>
                  <span className="font-mono text-xs">{capability}</span>
                  <span className="block text-xs text-text-muted">{CAPABILITY_HELP[capability]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 text-sm text-text-secondary">
            Pages (explicit; a page created later is NOT granted)
          </div>
          {pagesLoading && !pages && <p className="text-sm text-text-muted">Loading pages…</p>}
          {pagesError && <div role="alert" className="mb-2 text-sm text-danger">
            {pagesErrorValue instanceof Error ? pagesErrorValue.message : "Pages could not be loaded."} Your selection is kept; refresh before issuing a key.
            <button type="button" disabled={pagesFetching} onClick={() => void refetchPages()} className="ml-2 underline">Retry</button>
          </div>}
          {pages && pages.length === 0 && <p className="text-sm text-text-muted">Create a page before issuing a key.</p>}
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {(pages ?? []).map((page) => (
              <label key={page.label} className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={pageLabels.includes(page.label)}
                  onChange={() => setPageLabels((current) => toggle(current, page.label))}
                />
                <span>{page.label}</span>
                <span className="text-xs text-text-muted">{page.platform}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Expires in (days)">
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
            />
          </Field>
          <Field label="Requests / day">
            <input
              type="number"
              min={1}
              max={1_000_000}
              value={dailyRequestBudget}
              onChange={(event) => setDailyRequestBudget(Number(event.target.value))}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
            />
          </Field>
          <Field label="Rows / day">
            <input
              type="number"
              min={1}
              max={100_000_000}
              value={dailyRowBudget}
              onChange={(event) => setDailyRowBudget(Number(event.target.value))}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeUnlessPending}
            disabled={create.isPending}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? "Issuing..." : "Issue"}
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
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard unavailable. Select and copy the token shown here before closing.");
    }
  }

  return (
    <ModalShell title={`Agent key "${name}"`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm font-medium text-warning">
          This token is shown only once. The hub stores only its hash; a lost token is
          re-issued, never recovered.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 select-all break-all rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-sm text-text-primary">
            {token}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-text-muted">
          Put it in HUB_AGENT_KEY, or in ~/.config/hub/credentials, and the hub CLI will
          find it.
        </p>
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
        toast.success(nextMachineId ? "Machine bound to this sign-in" : "Binding removed");
        if (!nextMachineId) setMachineId("");
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Binding failed");
      },
    });
  }

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-text-muted">
        Desktop harvest authority: one machineId belongs to exactly one sign-in. Take the
        machineId from the app&apos;s Diagnostics screen («Диагностика приложения»).
      </p>

      {usersError && <StaleDataNotice title="Team list unavailable" error={usersErrorValue} />}
      {usersLoading && !users && <p className="text-sm text-text-muted">Loading…</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person">
          <select
            value={selectedUser ? String(selectedUser.id) : ""}
            onChange={(event) => {
              setUserId(event.target.value === "" ? null : Number(event.target.value));
              setMachineId("");
              setTokenId(null);
            }}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Select a person…</option>
            {candidates.map((user) => (
              <option key={user.id} value={String(user.id)}>{user.username}</option>
            ))}
          </select>
        </Field>

        <Field label="Sign-in">
          <select
            value={tokenId === null ? "" : String(tokenId)}
            disabled={!selectedUser || usersError || devices.isError}
            onChange={(event) => setTokenId(event.target.value === "" ? null : Number(event.target.value))}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary disabled:opacity-50"
          >
            <option value="">Select a sign-in…</option>
            {activeDevices.map((device) => (
              <option key={device.id} value={String(device.id)}>
                {device.label}
                {device.harvestMachineId ? " — bound" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {devices.isError && (
        <StaleDataNotice title="Sign-ins unavailable" error={devices.error} />
      )}
      {selectedUser && devices.data && activeDevices.length === 0 && (
        <p className="text-sm text-text-muted">This person has no live sign-in to bind.</p>
      )}

      {selected && (
        <div className="rounded-lg border border-border bg-bg px-3 py-2.5">
          <div className="text-xs text-text-muted">
            Currently bound: {selected.harvestMachineId
              ? <code className="font-mono">{selected.harvestMachineId}</code>
              : "nothing"}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={machineId}
              aria-label="machineId"
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setMachineId(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-text-primary"
            />
            <button
              type="button"
              disabled={!machineIdValid || usersError || devices.isError || setCapability.isPending}
              onClick={() => apply(machineId.trim())}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {setCapability.isPending ? "Saving…" : "Bind"}
            </button>
            {selected.harvestMachineId && (
              <button
                type="button"
                disabled={usersError || devices.isError || setCapability.isPending}
                onClick={() => apply(null)}
                className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                Remove binding
              </button>
            )}
          </div>
          {machineId.trim() !== "" && !machineIdValid && (
            <p role="alert" className="mt-1 text-xs text-danger">
              A machineId is a UUID, e.g. 3f2504e0-4f89-11d3-9a0c-0305e82c3301.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
