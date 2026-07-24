import {
  findPageById,
  getAiGatewayPageConsecutiveFailureCount,
  type AiGatewayFailurePhase,
  type AiGatewayProvider,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  openCriticalNotificationIncident,
  resolveCriticalNotificationIncident,
} from "./notification-incidents.ts";

const AI_PROVIDER_FAILURE_THRESHOLD = 3;
const PAGE_FAILURE_SUBKEYS = ["provider", "proxy"] as const;

type AiIncidentApp = Pick<AppContext, "db"> & {
  logger: Pick<AppContext["logger"], "warn">;
};

export interface AiProviderTerminalIncidentInput {
  provider: AiGatewayProvider;
  outcome: "completed" | "failed" | "cancelled";
  pageId: number | null;
  pageLabel?: string | null;
  platform?: "fansly" | "onlyfans" | null;
  errorCode: string | null;
  failurePhase: AiGatewayFailurePhase | null;
  providerHttpStatus: number | null;
  completedAt: Date;
}

/**
 * Runs after the terminal ledger row and restricted capture have settled.
 * Every dependency failure is swallowed here: paging is downstream
 * observability and can never rewrite the chatter-facing stream outcome.
 */
export async function reconcileAiProviderTerminalIncident(
  app: AiIncidentApp,
  input: AiProviderTerminalIncidentInput,
) {
  try {
    if (input.outcome === "cancelled") {
      return;
    }

    if (input.outcome === "completed") {
      // Billing/auth use one family-wide latch. Per the owner ruling, any
      // subsequent successful generation is the recovery signal.
      await resolveCriticalNotificationIncident(app, {
        kind: "ai_provider_billing",
        platformAccountId: null,
        pageLabel: null,
        platform: null,
        subKey: null,
        recoveredAt: input.completedAt,
      });

      if (input.pageId !== null) {
        const page = await resolvePageIdentity(app, input);
        // The two stable cause latches keep a dead page proxy distinct from an
        // upstream/provider failure without creating one incident per wire
        // code. A success proves both page-local conditions recovered.
        for (const subKey of PAGE_FAILURE_SUBKEYS) {
          await resolveCriticalNotificationIncident(app, {
            kind: "ai_provider_failed",
            platformAccountId: input.pageId,
            pageLabel: page.pageLabel,
            platform: page.platform,
            subKey,
            recoveredAt: input.completedAt,
          });
        }
      }
      return;
    }

    const errorCode = input.errorCode ?? "provider_stream_failed";
    const failurePhase = input.failurePhase ?? "stream";
    const errorSummary = aiProviderIncidentSummary({
      provider: input.provider,
      errorCode,
      failurePhase,
      providerHttpStatus: input.providerHttpStatus,
    });

    if (errorCode === "provider_billing" || errorCode === "provider_auth") {
      await openCriticalNotificationIncident(app, {
        kind: "ai_provider_billing",
        platformAccountId: null,
        pageLabel: null,
        platform: null,
        subKey: null,
        errorCode,
        errorSummary,
        occurredAt: input.completedAt,
      });
      return;
    }

    if (input.pageId === null) {
      return;
    }

    const consecutiveFailures = await getAiGatewayPageConsecutiveFailureCount(app.db, {
      pageId: input.pageId,
      threshold: AI_PROVIDER_FAILURE_THRESHOLD,
    });
    if (consecutiveFailures < AI_PROVIDER_FAILURE_THRESHOLD) {
      return;
    }

    const page = await resolvePageIdentity(app, input);
    await openCriticalNotificationIncident(app, {
      kind: "ai_provider_failed",
      platformAccountId: input.pageId,
      pageLabel: page.pageLabel,
      platform: page.platform,
      subKey: errorCode === "provider_proxy_unreachable" ? "proxy" : "provider",
      errorCode,
      errorSummary,
      occurredAt: input.completedAt,
    });
  } catch (error) {
    app.logger.warn({
      provider: input.provider,
      pageId: input.pageId,
      outcome: input.outcome,
      errorCode: input.errorCode,
      failurePhase: input.failurePhase,
      providerHttpStatus: input.providerHttpStatus,
      err: error,
    }, "AI provider incident evaluation failed; continuing");
  }
}

async function resolvePageIdentity(
  app: Pick<AiIncidentApp, "db">,
  input: Pick<AiProviderTerminalIncidentInput, "pageId" | "pageLabel" | "platform">,
) {
  if (input.pageLabel !== undefined && input.platform !== undefined) {
    return {
      pageLabel: input.pageLabel,
      platform: input.platform,
    };
  }
  if (input.pageId === null) {
    return { pageLabel: null, platform: null };
  }
  const stored = await findPageById(app.db, input.pageId);
  return {
    pageLabel: stored?.page.label ?? null,
    platform: stored?.page.platform ?? null,
  };
}

function aiProviderIncidentSummary(input: {
  provider: AiGatewayProvider;
  errorCode: string;
  failurePhase: AiGatewayFailurePhase;
  providerHttpStatus: number | null;
}) {
  const provider = input.provider === "anthropic" ? "Anthropic" : "OpenRouter";
  const status = input.providerHttpStatus === null
    ? ""
    : ` (HTTP ${input.providerHttpStatus})`;
  switch (input.errorCode) {
    case "provider_billing":
      return `${provider} billing rejected AI generation${status}`;
    case "provider_auth":
      return `${provider} authentication rejected AI generation${status}`;
    case "provider_rate_limited":
      return `${provider} rate-limited AI generation${status}`;
    case "provider_unavailable":
      return `${provider} was unavailable for AI generation${status}`;
    case "provider_proxy_unreachable":
      return `Page egress proxy was unreachable for ${provider} AI generation`;
    default:
      return `${provider} AI generation failed during ${input.failurePhase}${status}`;
  }
}
