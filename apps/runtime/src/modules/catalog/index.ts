import {
  routeSchemas,
  type AssignedPage,
  type UpdateCredentialsBody,
} from "@agency_hub_core/contracts";
import {
  CatalogModelNotFoundError,
  CatalogPageNotFoundError,
  createModel,
  deleteModelBySlug,
  deletePageByLabel,
  DuplicateModelSlugError,
  DuplicatePageLabelError,
  getSyncStreamsForPlatform,
  listAdminModels,
  listAdminPages,
  listVoiceProfiles,
  ModelHasPagesError,
  pausePageSync,
  updateModelBySlug,
  updatePageByLabel,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  buildProxyEgressKey,
  createProxyRequestDispatcher,
  normalizeProxyConfig,
  redactSensitiveText,
  undiciRequest,
  type Platform,
} from "@agency_hub_core/shared";

import { auditCtx, pageScopeFor } from "../../api/request-auth.ts";
import {
  recordAudit,
  requireDashboardUser,
  requireOwner,
} from "../../services/auth.ts";
import { updatePageCredentials } from "../../services/connections.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import type { AppContext } from "../../bootstrap.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../services/errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "../../services/notification-incidents.ts";
import { resolvePageContext } from "../../services/page-context.ts";
import { onboardFanslyPage, onboardOnlyFansPage } from "../../services/page-onboarding.ts";
import { assertAllowedProxyTarget } from "../../services/proxy-validation.ts";
import {
  getPageSummary,
  listModelSummaries,
  listPageSummaries,
} from "../../services/reporting.ts";
import { createSyncRateLimitWaiter } from "../../services/sync/rate-limiter.ts";
import { fanslyUnpacedSendGuard } from "../../services/fansly-send-guard/index.ts";
import { refreshPageMetadata } from "../../services/sync/shared.ts";
import { requestPageSync } from "../../services/sync-control.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Catalog module (target §6.1): models, pages, credentials, proxies,
// onboarding — platform-neutral; the adapters do verification. Handlers
// relocated verbatim from server.ts (Stage 19 Task 3).

function serializeTimestamp(value: Date | string) {
  return new Date(value).toISOString();
}

function serializeNullableTimestamp(value: Date | string | null | undefined) {
  return value == null ? null : serializeTimestamp(value);
}

function serializePageMetric(value: number | null) {
  return {
    value,
    available: value !== null,
  };
}

function serializeAssignedPage(page: {
  id: number;
  label: string;
  platform: Platform;
  username: string | null;
  displayName: string | null;
  followerCount: number | null;
  subscriberCount: number | null;
  lastLightSyncAt: Date | string | null;
  lastFollowerSyncAt: Date | string | null;
  modelSlug: string;
  modelName: string;
}) {
  return {
    id: page.id,
    label: page.label,
    platform: page.platform,
    username: page.username,
    displayName: page.displayName,
    followerCount: serializePageMetric(page.followerCount),
    subscriberCount: serializePageMetric(page.subscriberCount),
    lastLightSyncAt: serializeNullableTimestamp(page.lastLightSyncAt),
    lastFollowerSyncAt: serializeNullableTimestamp(page.lastFollowerSyncAt),
    modelSlug: page.modelSlug,
    modelName: page.modelName,
  };
}

// The voice-notes page allowlist FAILS CLOSED: empty (or unset) = NO pages.
// Mirrors isPageAllowlisted in services/sync/fansly-stream-gate.ts (its
// canonical home) — kept a local copy so the two never drift on the
// empty-means-none rule.
function parseVoiceAllowlist(csv: string | undefined): Set<string> {
  if (!csv) {
    return new Set();
  }
  return new Set(
    csv
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

// Capability membership, not a new platform branch: Voice is Fansly-only for
// this pilot, and the platform-branch ratchet keeps dispatch logic centralized.
const VOICE_NOTE_CAPABILITY_PLATFORMS = new Set<Platform>(["fansly"]);

/**
 * Attach the OPTIONAL `capabilities.voiceNotes` UI hint to each assigned page.
 * The field appears ONLY when all four hold: the live voiceNotesEnabled switch
 * is on, the TTS provider is constructed (ELEVENLABS_API_KEY + complete service
 * proxy configured), the page label is in the (fail-closed) allowlist, AND a
 * voice profile exists for the page. Any of them false → the field is omitted
 * entirely (a missing field reads as disabled — old-kernel forward-compat).
 * Gating on the provider keeps the hint from ever showing a button that would
 * 503 voice_provider_unavailable.
 * This is a hint only; `POST …/voice-notes` remains the authoritative admission
 * gate. The profile lookups are batched into a single query.
 */
async function attachVoiceNoteCapabilities(
  app: AppContext,
  pages: AssignedPage[],
): Promise<AssignedPage[]> {
  // The capabilities hint is OPTIONAL enrichment (a missing field reads as
  // disabled). It must NEVER break GET /api/v1/pages — a high-frequency, primary
  // list endpoint clients call on startup. So the whole config/profile lookup is
  // fail-open: any error (a config_settings/page_voice_profiles lock, query
  // fault, or migration) logs a warn and returns the pages unchanged, mirroring
  // the fan-dossier fail-open in modules/ai/features/index.ts.
  try {
    const effective = await loadEffectiveConfig(app.db, app.config);
    if (effective.voiceNotesEnabled !== true || app.voiceTtsProvider == null) {
      return pages;
    }
    const allowlist = parseVoiceAllowlist(effective.voiceNotesPageAllowlist);
    if (allowlist.size === 0) {
      return pages;
    }
    const profiledPageIds = new Set(
      (await listVoiceProfiles(app.db)).map((profile) => profile.platformAccountId),
    );
    return pages.map((page) =>
      VOICE_NOTE_CAPABILITY_PLATFORMS.has(page.platform)
        && allowlist.has(page.label)
        && profiledPageIds.has(page.id)
        ? { ...page, capabilities: { voiceNotes: true } }
        : page,
    );
  } catch (error) {
    app.logger.warn({ err: error }, "voice-note capability hint lookup failed; omitting the field");
    return pages;
  }
}

function rethrowAdminCatalogError(error: unknown): never {
  if (
    error instanceof DuplicateModelSlugError ||
    error instanceof DuplicatePageLabelError ||
    error instanceof ModelHasPagesError
  ) {
    throw new ConflictError(error.message);
  }

  if (error instanceof CatalogModelNotFoundError || error instanceof CatalogPageNotFoundError) {
    throw new NotFoundError(error.message);
  }

  throw error;
}

function isAdminPageVerifyBadRequest(error: unknown) {
  if (error instanceof BadRequestError) {
    return true;
  }

  if (error instanceof FanslyApiError) {
    return error.status === 401 || error.status === 403;
  }

  return false;
}

export function registerCatalogRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext, boss } = ctx;
  const { requirePrincipal } = ctx.auth;

  function initialSyncRetryFor(pageLabel: string) {
    return {
      method: "POST" as const,
      path: "/api/v1/admin/sync/trigger" as const,
      body: {
        pageLabel,
        scope: "all" as const,
      },
    };
  }

  function initialSyncWarningFor(pageLabel: string) {
    return {
      code: "initial_sync_enqueue_failed" as const,
      message: `Page "${pageLabel}" was created, but initial sync was not queued. Retry by triggering an all sync for this page.`,
    };
  }

  async function queueInitialOnboardingSync(
    pageLabel: string,
    log: Pick<typeof server.log, "error" | "warn">,
  ) {
    if (!boss) {
      log.warn({ pageLabel }, "Initial sync for created page was not queued because the job queue is unavailable");
      return {
        syncQueued: false,
        syncWarning: initialSyncWarningFor(pageLabel),
        syncRetry: initialSyncRetryFor(pageLabel),
      };
    }

    try {
      await requestPageSync(appContext, boss, {
        pageLabel,
        scope: "all",
        reason: "onboarding",
      });
      return {
        syncQueued: true,
        syncWarning: null,
        syncRetry: null,
      };
    } catch (error) {
      log.error({ err: error, pageLabel }, "Failed to queue initial sync for created page");
      return {
        syncQueued: false,
        syncWarning: initialSyncWarningFor(pageLabel),
        syncRetry: initialSyncRetryFor(pageLabel),
      };
    }
  }

  server.get("/api/v1/pages", {
    schema: routeSchemas.pages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const pages = await listPageSummaries(appContext, pageScopeFor(principal));
    return attachVoiceNoteCapabilities(appContext, pages);
  });

  server.get("/api/v1/models", {
    schema: routeSchemas.models,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return listModelSummaries(appContext, pageScopeFor(principal));
  });

  server.get("/api/v1/admin/models", {
    schema: routeSchemas.adminModels,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listAdminModels(appContext.db);
  });

  server.post("/api/v1/admin/models", {
    schema: routeSchemas.adminCreateModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const model = await createModel(appContext.db, request.body);
      return { id: model.id, slug: model.slug, name: model.name };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.patch("/api/v1/admin/models/:modelSlug", {
    schema: routeSchemas.adminUpdateModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const model = await updateModelBySlug(appContext.db, request.params.modelSlug, request.body);
      return { id: model.id, slug: model.slug, name: model.name };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.delete("/api/v1/admin/models/:modelSlug", {
    schema: routeSchemas.adminDeleteModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      await deleteModelBySlug(appContext.db, request.params.modelSlug);
      return { deleted: true as const };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.get("/api/v1/admin/pages", {
    schema: routeSchemas.adminPages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const pages = await listAdminPages(appContext.db);
    return pages.map((page) => serializeAssignedPage(page));
  });

  server.post("/api/v1/admin/pages", {
    schema: routeSchemas.adminCreatePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body = request.body;
    if (body.platform === "fansly") {
      await onboardFanslyPage(appContext, {
        modelSlug: body.modelSlug,
        label: body.label,
        session: body.session,
        proxy: body.proxy,
      });
      const syncQueueState = await queueInitialOnboardingSync(body.label, request.log);
      const page = await getPageSummary(appContext, body.label);
      return {
        page: serializeAssignedPage(page),
        verified: true,
        ...syncQueueState,
      };
    } else {
      await onboardOnlyFansPage(appContext, {
        modelSlug: body.modelSlug,
        label: body.label,
        username: body.username,
      });
      const syncQueueState = await queueInitialOnboardingSync(body.label, request.log);
      const page = await getPageSummary(appContext, body.label);
      return {
        page: serializeAssignedPage(page),
        verified: true,
        ...syncQueueState,
      };
    }
  });

  server.patch("/api/v1/admin/pages/:pageLabel", {
    schema: routeSchemas.adminUpdatePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const updated = await updatePageByLabel(appContext.db, request.params.pageLabel, request.body);
      const [page] = await listAdminPages(appContext.db, { pageIds: [updated.id] });
      if (!page) {
        throw new NotFoundError(`Page "${updated.label}" not found`);
      }
      return { page: serializeAssignedPage(page) };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.delete("/api/v1/admin/pages/:pageLabel", {
    schema: routeSchemas.adminDeletePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    // Stage 13 soft-delete standard (replaces the Stage 2 handler-level 409):
    // "delete" tombstones the page — its facts remain and the RESTRICT FKs
    // (migration 0056) make an actual row DELETE structurally impossible on a
    // fact-bearing page. Same response shape as before.
    try {
      const deleted = await deletePageByLabel(appContext.db, request.params.pageLabel);
      // The planner/lease queries exclude tombstoned pages; pausing here also
      // stops in-flight leases and keeps the sync states legibly parked.
      await pausePageSync(appContext.db, {
        pageId: deleted.id,
        streams: getSyncStreamsForPlatform(deleted.platform),
      });
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.page_soft_delete",
        metadata: { pageLabel: request.params.pageLabel },
      });
      return { deleted: true as const };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.post("/api/v1/admin/credentials/verify", {
    schema: routeSchemas.adminVerifyCredentials,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body = request.body;
    try {
      if (body.platform === "fansly") {
        const proxy = normalizeProxyConfig(body.proxy);
        await assertAllowedProxyTarget(proxy);
        const egressKey = buildProxyEgressKey(proxy);
        const rateLimitWaiter = createSyncRateLimitWaiter(appContext, { egressKey });
        const result = await appContext.adapter.verifySession({
          session: body.session,
          proxy,
          egressKey,
          rateLimitWaiter,
          // No page: journaled, paced against no page (owner decision №4).
          sendGuard: fanslyUnpacedSendGuard(appContext, "credentials_verify"),
        });
        return {
          valid: true as const,
          platform: "fansly" as const,
          username: result.parsed.account.username,
          displayName: result.parsed.account.displayName,
        };
      } else {
        // Stage 18: OnlyMonster retired — "verifying" an OnlyFans identity
        // means the account is connected at the OFAPI vendor.
        if (!appContext.ofapi) {
          throw new Error("OFAPI is not configured (OFAPI_API_KEY)");
        }
        const needle = body.username.trim().toLowerCase().replace(/^@/, "");
        const accounts = await appContext.ofapi.listAccounts();
        const account = accounts.find((candidate) =>
          (candidate.username ?? "").toLowerCase().replace(/^@/, "") === needle
          || (candidate.onlyfansName ?? "").toLowerCase() === needle,
        );
        if (!account) {
          throw new Error(`No connected OFAPI account matches "${body.username}"`);
        }
        return {
          valid: true as const,
          platform: "onlyfans" as const,
          username: account.username,
          displayName: account.displayName ?? account.onlyfansName,
        };
      }
    } catch (error) {
      throw new BadRequestError(
        `Credential verification failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`,
      );
    }
  });

  server.post("/api/v1/admin/proxy/test", {
    schema: routeSchemas.adminTestProxy,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    let proxy: ReturnType<typeof normalizeProxyConfig>;
    try {
      proxy = normalizeProxyConfig(request.body.proxy);
      await assertAllowedProxyTarget(proxy);
    } catch (error) {
      throw new BadRequestError(
        `Proxy test failed: ${redactSensitiveText(error instanceof Error ? error.message : "Invalid proxy URL")}`,
      );
    }
    const dispatcher = createProxyRequestDispatcher(proxy);
    try {
      const { statusCode, body: responseBody } = await undiciRequest(
        "https://api.ipify.org?format=json",
        {
          method: "GET",
          signal: AbortSignal.timeout(30_000),
          dispatcher,
        },
      );
      const text = await responseBody.text();
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`IP check returned HTTP ${statusCode}`);
      }
      const data = JSON.parse(text) as { ip: string };
      return { ip: data.ip };
    } catch (error) {
      throw new BadRequestError(
        `Proxy test failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`,
      );
    } finally {
      await dispatcher.close();
    }
  });

  server.post("/api/v1/admin/pages/:pageLabel/verify", {
    schema: routeSchemas.adminVerifyPage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const pageContext = await resolvePageContext(appContext, request.params.pageLabel);
      if (pageContext.platform !== "fansly") {
        // Stage 18: OnlyMonster retired — OnlyFans pages have no pasted
        // credentials; access rides the OFAPI mapping.
        throw new BadRequestError(
          "OnlyFans pages verify via their OFAPI mapping, not pasted credentials",
        );
      }
      await refreshPageMetadata(appContext, pageContext, "light", undefined, null, "account_me_api");
      const recoveredAt = new Date();
      const recovery = await handleSuccessfulPageVerificationRecovery(appContext, {
        platformAccountId: pageContext.page.id,
        pageLabel: pageContext.page.label,
        platform: pageContext.platform,
        recoveredAt,
      });
      return {
        verified: true,
        username: pageContext.page.username,
        platform: pageContext.platform,
        syncUnblocked: recovery.syncUnblocked,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      if (isAdminPageVerifyBadRequest(error)) {
        throw new BadRequestError(
          `Page verification failed: ${
            redactSensitiveText(error instanceof Error ? error.message : "Unknown error")
          }`,
        );
      }

      throw error;
    }
  });

  server.patch("/api/v1/admin/pages/:pageLabel/credentials", {
    schema: routeSchemas.adminUpdateCredentials,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body: UpdateCredentialsBody = request.body;
    const result = await updatePageCredentials(appContext, request.params.pageLabel, body);
    // Field names only — credential VALUES must never reach the audit/observation row.
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.page_credentials_update",
      metadata: { pageLabel: request.params.pageLabel, fields: Object.keys(body) },
    });
    return result;
  });
}
