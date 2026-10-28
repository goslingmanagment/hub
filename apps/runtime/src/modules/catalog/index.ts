import {
  routeSchemas,
  type AssignedPage,
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
  ModelHasPagesError,
  pausePageSync,
  updateModelBySlug,
  updatePageByLabel,
} from "@agency_hub_core/db";
import {
  createProxyRequestDispatcher,
  normalizeProxyConfig,
  redactSensitiveText,
  undiciRequest,
  type Platform,
} from "@agency_hub_core/shared";

import { auditCtx, pageScopeFor } from "../../api/request-auth.ts";
import {
  recordAudit,
} from "../../services/auth.ts";
import type { AppContext } from "../../bootstrap.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../services/errors.ts";
import { pagesForPrincipalResponse } from "../../services/closed-platform-responses.ts";
import { checkFanslyIdentityThroughBrowser, onboardFanslyPageThroughBrowser } from "../../services/page-browser-onboarding.ts";
import { onboardOnlyFansPage } from "../../services/page-onboarding.ts";
import { assertAllowedProxyTarget } from "../../services/proxy-validation.ts";
import {
  getPageSummary,
  listModelSummaries,
  listPageSummaries,
} from "../../services/reporting.ts";
import { requestPageSync } from "../../services/sync-control.ts";
import { isLegacyExecutorPlatform } from "../../sync/onlyfans/boundary.ts";
import { verifyPageOnEngine } from "../../services/sync-engine-account.ts";
import { loadVoiceLane } from "../../services/voice-lane.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Catalog module (target §6.1): models, pages, credentials, proxies,
// onboarding — platform-neutral; the adapters do verification. Handlers
// relocated verbatim from server.ts.

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

/**
 * Attach the OPTIONAL `capabilities.voiceNotes` UI hint to each assigned page.
 * The field appears ONLY where the voice-notes lane serves the page
 * (voice-lane.ts, the rule the chat extension's bootstrap reads too): the live
 * voiceNotesEnabled switch is on, the TTS provider is constructed
 * (ELEVENLABS_API_KEY + complete service proxy configured), the page label is
 * in the (fail-closed) allowlist, a voice profile exists for the page, and the
 * page is a Fansly page. Otherwise the field is omitted entirely (a missing
 * field reads as disabled — old-kernel forward-compat).
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
    const serves = await loadVoiceLane(app);
    return pages.map((page) => (serves(page) ? { ...page, capabilities: { voiceNotes: true } } : page));
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
    // A device token's list leaves Telegram pages out: released clients read
    // `platform` as a closed enum (closed-platform-responses.ts).
    const pages = pagesForPrincipalResponse(principal, await listPageSummaries(appContext, pageScopeFor(principal)));
    return attachVoiceNoteCapabilities(appContext, pages);
  });

  server.get("/api/v1/models", {
    schema: routeSchemas.models,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return listModelSummaries(appContext, pageScopeFor(principal));
  });

  server.get("/api/v1/admin/models", {
    schema: routeSchemas.adminModels,
  }, async () => {
    return listAdminModels(appContext.db);
  });

  server.post("/api/v1/admin/models", {
    schema: routeSchemas.adminCreateModel,
  }, async (request) => {
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
    try {
      const { slug, name, sortOrder } = request.body;
      const model = await updateModelBySlug(appContext.db, request.params.modelSlug, {
        ...(slug === undefined ? {} : { slug }),
        ...(name === undefined ? {} : { name }),
        ...(sortOrder === undefined ? {} : { sortOrder }),
      });
      return { id: model.id, slug: model.slug, name: model.name };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.delete("/api/v1/admin/models/:modelSlug", {
    schema: routeSchemas.adminDeleteModel,
  }, async (request) => {
    try {
      await deleteModelBySlug(appContext.db, request.params.modelSlug);
      return { deleted: true as const };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.get("/api/v1/admin/pages", {
    schema: routeSchemas.adminPages,
  }, async () => {
    const pages = await listAdminPages(appContext.db);
    return pages.map((page) => serializeAssignedPage(page));
  });

  server.post("/api/v1/admin/pages", {
    schema: routeSchemas.adminCreatePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const body = request.body;
    if ("browserProfileId" in body) {
      // Project Browser PR 16: a page connected through its own server
      // browser — its account checked through the browser, the page born on
      // it and the profile bound to it, in one transaction.
      const born = await onboardFanslyPageThroughBrowser(appContext, {
        modelSlug: body.modelSlug,
        label: body.label,
        profileId: body.browserProfileId,
        by: `api:${principal.user.username}`,
        actorUserId: principal.user.id,
      });
      const page = await getPageSummary(appContext, body.label);
      return {
        page: serializeAssignedPage(page),
        verified: true,
        syncQueued: born.queuedAtBirth.length > 0,
        syncWarning: null,
        syncRetry: null,
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
    try {
      const { label, modelSlug } = request.body;
      const updated = await updatePageByLabel(appContext.db, request.params.pageLabel, {
        ...(label === undefined ? {} : { label }),
        ...(modelSlug === undefined ? {} : { modelSlug }),
      });
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
    // Soft-delete standard (replaces the handler-level 409):
    // "delete" tombstones the page — its facts remain and the RESTRICT FKs
    // (migration 0056) make an actual row DELETE structurally impossible on a
    // fact-bearing page. Same response shape as before.
    try {
      const deleted = await deletePageByLabel(appContext.db, request.params.pageLabel);
      // The planner/lease queries exclude tombstoned pages; pausing here also
      // stops in-flight leases and keeps the sync states legibly parked. A
      // Fansly page's legacy rows are left as they are: the legacy executor
      // serves no Fansly page (step 4 S4-10), so none of them is leased.
      if (isLegacyExecutorPlatform(deleted.platform)) {
        await pausePageSync(appContext.db, {
          pageId: deleted.id,
          streams: getSyncStreamsForPlatform(deleted.platform),
        });
      }
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
    const body = request.body;
    try {
      if ("browserProfileId" in body) {
        // Project Browser PR 16: the account of a new page's browser, read
        // through it by the engine (`GET /account/me`, journaled without a
        // page, its answer in observations).
        const identity = await checkFanslyIdentityThroughBrowser(appContext, { profileId: body.browserProfileId, source: "credentials_verify" });
        return {
          valid: true as const,
          platform: "fansly" as const,
          username: identity.username,
          displayName: identity.displayName,
        };
      } else {
        // OnlyMonster retired — "verifying" an OnlyFans identity
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
      // The browser's own answers keep their status: not open yet, not
      // answered yet, no such profile.
      if (error instanceof AppError && error.statusCode !== 400) throw error;
      if (error instanceof BadRequestError && error.message.startsWith("Credential verification failed: ")) throw error;
      throw new BadRequestError(
        `Credential verification failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`,
      );
    }
  });

  server.post("/api/v1/admin/proxy/test", {
    schema: routeSchemas.adminTestProxy,
  }, async (request) => {
    let proxy: ReturnType<typeof normalizeProxyConfig>;
    try {
      const { url, username, password } = request.body.proxy;
      proxy = normalizeProxyConfig({ url, username: username ?? null, password: password ?? null });
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
    // A Fansly page is verified by its engine actor (`account.verify`, ≤ 30 s,
    // else 409 queued; step-3 design §3.5 item 6). A page being switched, or
    // one the engine does not run, answers 409 before anything is resolved or
    // sent: no legacy `/account/me` is left to fall back to (step 4, S4-19).
    const onEngine = await verifyPageOnEngine(appContext, request.params.pageLabel);
    if (onEngine !== null) return onEngine;
    // OnlyMonster retired — OnlyFans pages have no pasted
    // credentials; access rides the OFAPI mapping.
    throw new BadRequestError(
      "Page verification failed: OnlyFans pages verify via their OFAPI mapping, not pasted credentials",
    );
  });
}
