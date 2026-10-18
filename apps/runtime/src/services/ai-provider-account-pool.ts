import { createHash } from "node:crypto";

import {
  claimAiProviderAccountProbe,
  listAiProviderAccounts,
  markAiProviderAccountServing,
  markAiProviderAccountUnavailable,
  syncAiProviderAccounts,
  type AiProviderAccountRow,
  type Database,
} from "@agency_hub_core/db";
import type { AiProviderAccountFailure, AnthropicApiKeyEntry } from "@agency_hub_core/shared";

import {
  AI_PROVIDER_ACCOUNT_INCIDENT_SUBKEY_PREFIX,
  openCriticalNotificationIncident,
  resolveCriticalNotificationIncident,
} from "./notification-incidents.ts";

/** How long a process trusts its copy of the accounts' state. A refusal or
 * a recovery it sees itself drops the copy at once; another process's is
 * seen within this window (meanwhile a refused account answers fast and
 * free). */
const ACCOUNT_STATE_TTL_MS = 15_000;
/** An exhausted account is tried again by one live call this often: a
 * top-up is noticed without the owner telling Hub. */
export const AI_PROVIDER_ACCOUNT_PROBE_INTERVAL_MS = 60 * 60 * 1000;
/** last_success_at is a liveness hint, written at most this often. */
const SERVED_WRITE_INTERVAL_MS = 60_000;

export interface AiProviderAccountCandidate {
  id: number;
  label: string;
  apiKey: string;
}

/**
 * The Anthropic accounts of ANTHROPIC_API_KEYS as one pool. Spends them one
 * at a time in the owner's order — never round-robin: the prompt cache is
 * per account, so spreading calls would pay for every cached prefix again on
 * each account.
 */
export interface AnthropicAccountPool {
  /** The configured labels, in ANTHROPIC_API_KEYS order. */
  readonly labels: readonly string[];
  /** Make sure every configured label has its row (done once per process). */
  ensureRegistered(): Promise<void>;
  /** Forget this process's copy of the accounts' state (an owner change). */
  invalidate(): void;
  /** The accounts one call may try, in order: an exhausted account above
   * the first active one when its hourly probe is due, then every active
   * account, then the exhausted ones as a last resort (a refusal for credit
   * is free; when all are out the call still asks, so a top-up is noticed
   * at once). Disabled and invalid accounts are never offered. */
  candidates(): Promise<AiProviderAccountCandidate[]>;
  /** Anthropic refused the account before any output. Never throws. */
  reportRefusal(
    account: AiProviderAccountCandidate,
    failure: AiProviderAccountFailure,
    detail: { providerHttpStatus: number | null },
  ): Promise<void>;
  /** The account accepted a call. Never throws. */
  reportServed(account: AiProviderAccountCandidate): Promise<void>;
}

export function anthropicKeyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

function anthropicKeyHint(apiKey: string) {
  return apiKey.slice(-4);
}

function compareOrder(a: AiProviderAccountRow, b: AiProviderAccountRow) {
  return a.priority - b.priority || a.id - b.id;
}

export function aiProviderAccountIncidentSubKey(label: string) {
  return `${AI_PROVIDER_ACCOUNT_INCIDENT_SUBKEY_PREFIX}${label}`;
}

export function createAnthropicAccountPool(deps: {
  db: Database;
  logger: { warn(obj: object, msg?: string): void };
  entries: AnthropicApiKeyEntry[];
  now?: () => Date;
}): AnthropicAccountPool | null {
  if (deps.entries.length === 0) {
    return null;
  }
  const clock = deps.now ?? (() => new Date());
  const keyByLabel = new Map(deps.entries.map((entry) => [entry.label, entry.apiKey]));
  const incidentApp = { db: deps.db, logger: deps.logger };
  let synced: Promise<void> | null = null;
  let cache: { rows: AiProviderAccountRow[]; loadedAt: number } | null = null;
  const servedWrittenAt = new Map<number, number>();

  async function ensureSynced() {
    synced ??= syncAiProviderAccounts(deps.db, {
      provider: "anthropic",
      accounts: deps.entries.map((entry) => ({
        label: entry.label,
        keyFingerprint: anthropicKeyFingerprint(entry.apiKey),
        keyHint: anthropicKeyHint(entry.apiKey),
      })),
      at: clock(),
    }).catch((error: unknown) => {
      synced = null;
      throw error;
    });
    await synced;
  }

  async function rows() {
    const now = clock().getTime();
    if (cache && now - cache.loadedAt < ACCOUNT_STATE_TTL_MS) {
      return cache.rows;
    }
    await ensureSynced();
    const loaded = (await listAiProviderAccounts(deps.db, "anthropic"))
      .filter((row) => keyByLabel.has(row.label));
    cache = { rows: loaded, loadedAt: now };
    return loaded;
  }

  function candidateOf(row: AiProviderAccountRow): AiProviderAccountCandidate {
    return { id: row.id, label: row.label, apiKey: keyByLabel.get(row.label)! };
  }

  return {
    labels: deps.entries.map((entry) => entry.label),
    ensureRegistered: ensureSynced,
    invalidate() {
      cache = null;
    },
    async candidates() {
      const enabled = (await rows()).filter((row) => row.enabled).sort(compareOrder);
      const active = enabled.filter((row) => row.status === "active");
      const exhausted = enabled.filter((row) => row.status === "exhausted");
      const now = clock();
      let probe: AiProviderAccountRow | null = null;
      // With no active account every exhausted one is asked anyway (below).
      const firstActive = active[0];
      for (const row of firstActive ? exhausted : []) {
        if (compareOrder(row, firstActive!) > 0) {
          break;
        }
        if (row.nextProbeAt && row.nextProbeAt > now) {
          continue;
        }
        const won = await claimAiProviderAccountProbe(deps.db, {
          id: row.id,
          at: now,
          nextProbeAt: new Date(now.getTime() + AI_PROVIDER_ACCOUNT_PROBE_INTERVAL_MS),
        });
        cache = null;
        if (won) {
          probe = row;
          break;
        }
      }
      const ordered = [
        ...(probe ? [probe] : []),
        ...active,
        ...exhausted.filter((row) => row !== probe),
      ];
      return ordered.map(candidateOf);
    },

    async reportRefusal(account, failure, detail) {
      const at = clock();
      const status = failure === "credit_exhausted" ? "exhausted" : "invalid";
      const httpStatus = detail.providerHttpStatus === null ? "" : ` (HTTP ${detail.providerHttpStatus})`;
      const reason = failure === "credit_exhausted"
        ? `Anthropic refused for credit${httpStatus}`
        : `Anthropic rejected the key${httpStatus}`;
      try {
        const previous = await markAiProviderAccountUnavailable(deps.db, {
          id: account.id,
          status,
          reason,
          at,
          nextProbeAt: status === "exhausted"
            ? new Date(at.getTime() + AI_PROVIDER_ACCOUNT_PROBE_INTERVAL_MS)
            : null,
        });
        cache = null;
        deps.logger.warn({
          component: "ai_provider_accounts",
          account: account.label,
          status,
          previousStatus: previous,
          providerHttpStatus: detail.providerHttpStatus,
        }, "Anthropic account refused; the next account in order takes over");
        if (previous !== null && previous !== status) {
          await openCriticalNotificationIncident(incidentApp, {
            kind: "ai_provider_billing",
            platformAccountId: null,
            pageLabel: null,
            platform: null,
            subKey: aiProviderAccountIncidentSubKey(account.label),
            errorCode: failure === "credit_exhausted" ? "provider_billing" : "provider_auth",
            errorSummary: failure === "credit_exhausted"
              ? `Anthropic account ${account.label} is out of credit${httpStatus}; Hub spends the next account in order. Top it up, then note the balance on the usage screen.`
              : `Anthropic account ${account.label}: the key was rejected${httpStatus}; Hub spends the next account in order. Replace the key in ANTHROPIC_API_KEYS.`,
            occurredAt: at,
          });
        }
      } catch (error) {
        deps.logger.warn({ account: account.label, err: error }, "Anthropic account refusal could not be recorded; continuing");
      }
    },

    async reportServed(account) {
      const at = clock();
      const known = cache?.rows.find((row) => row.id === account.id);
      const lastWrite = servedWrittenAt.get(account.id) ?? 0;
      if (known?.status === "active" && at.getTime() - lastWrite < SERVED_WRITE_INTERVAL_MS) {
        return;
      }
      servedWrittenAt.set(account.id, at.getTime());
      try {
        const previous = await markAiProviderAccountServing(deps.db, { id: account.id, at });
        if (previous !== null && previous !== "active") {
          cache = null;
          await resolveCriticalNotificationIncident(incidentApp, {
            kind: "ai_provider_billing",
            platformAccountId: null,
            pageLabel: null,
            platform: null,
            subKey: aiProviderAccountIncidentSubKey(account.label),
            recoveredAt: at,
          });
        }
      } catch (error) {
        deps.logger.warn({ account: account.label, err: error }, "Anthropic account success could not be recorded; continuing");
      }
    },
  };
}
