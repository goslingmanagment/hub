import { useState } from "react";
import { toast } from "sonner";

import { AGENT_CAPABILITIES, type AgentCapability, type AgentKeyItem } from "@agency_hub_core/contracts";
import {
  useAdminPages,
  useAgentKeys,
  useCreateAgentKey,
  useRevokeAgentKey,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

/**
 * Agent Read Plane keys: issue, list, revoke.
 *
 * The whole surface exists so the owner can see, at a glance, the two things
 * that make one of these keys dangerous or safe: WHICH pages it reads and WHICH
 * capabilities it holds. Both are printed on the row rather than hidden behind a
 * detail view; a grant nobody looks at is a grant nobody controls.
 *
 * The issued token appears exactly once, in a modal, and is never fetched again.
 */

const CAPABILITY_HELP: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Verbatim message text: transcripts and search snippets",
  "read:money": "Transactions, spend rollups, subscription prices",
  "read:observations_envelope": "Capture-journal envelopes (metadata, never payloads)",
  "read:datasets": "The registered dataset queries",
  "request:hydration": "Filing a hydration request (execution stays an owner decision)",
};

export function AgentKeysTab() {
  const { data: keys, isLoading, isError, error, refetch } = useAgentKeys();
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
        action={<button type="button" className="text-sm font-semibold text-accent underline" onClick={() => void refetch()}>Повторить</button>}
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
      <QueryNotice error={isError} stale={keys !== undefined} retry={refetch} />
      <div className="mb-4 flex items-start justify-between gap-4">
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

export function CreateAgentKeyModal({
  create,
  onClose,
  onIssued,
}: {
  create: ReturnType<typeof useCreateAgentKey>;
  onClose: () => void;
  onIssued: (token: string, name: string) => void;
}) {
  const pagesQuery = useAdminPages();
  const pages = pagesQuery.data;
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
          <QueryNotice error={pagesQuery.isError} stale={pages !== undefined} retry={pagesQuery.refetch} />
          {!pages && !pagesQuery.isError && <p role="status" className="text-sm text-text-muted">Загружаем доступные страницы…</p>}
          {pages?.length === 0 && <p className="text-sm text-text-muted">В каталоге нет страниц для выдачи доступа.</p>}
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

        <div className="grid grid-cols-3 gap-3">
          <Field label="Expires in (days)">
            <input
              type="number"
              min={1}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
            />
          </Field>
          <Field label="Requests / day">
            <input
              type="number"
              min={1}
              value={dailyRequestBudget}
              onChange={(event) => setDailyRequestBudget(Number(event.target.value))}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
            />
          </Field>
          <Field label="Rows / day">
            <input
              type="number"
              min={1}
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
    await navigator.clipboard.writeText(token);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
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
