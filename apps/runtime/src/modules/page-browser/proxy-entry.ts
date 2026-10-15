import type { IncomingMessage } from "node:http";

import {
  routeSchemas,
  type PageBrowserDraftView,
  type PageBrowserDraftsResponse,
  type PageBrowserProxyCheckResponse,
} from "@agency_hub_core/contracts";
import {
  deletePageBrowserDraft,
  findOnboardingProfile,
  findPageBrowserDraft,
  findFanslyPageForBrowser,
  findPageById,
  listPageBrowserDrafts,
  listPagesWithoutBrowser,
  pageBrowserEnvOf,
  pageProxyStateOf,
  PageBrowserDraftError,
  savePageBrowserDraft,
  type PageBrowserDraft,
} from "@agency_hub_core/db";
import { browserEnvProblem, type PastedProxy } from "@agency_hub_core/shared";

import { auditCtx } from "../../api/request-auth.ts";
import { recordAudit, requireOwner } from "../../services/auth.ts";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../../services/errors.ts";
import { PAGE_BROWSER_ONBOARDING_AUDIT_EVENT } from "../../services/page-browser-onboarding.ts";
import {
  checkPageBrowserProxy,
  maskStoredProxy,
  readProxyText,
  endpointOfCheck,
  sealUsableProxy,
  storedProxyAsPasted,
} from "../../services/page-browser-proxy-entry.ts";
import type { ProxyCheckLedger } from "../../services/page-browser-proxy-checks.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// A page's server browser started in the dashboard (Project Browser, owner
// decision 2026-10-15): the owner pastes the proxy in any common format,
// checks it as antidetect browsers do — works or not and why, the protocol
// spoken, the latency, where it goes out — confirms the environment
// proposed from its exit, and saves a draft. `scripts/deploy-page-browser.sh
// add-profile` then makes the container and the profile from the draft with
// nothing typed on the server. Owner session only; every change only from
// the dashboard's own pages (as the onboarding's, PR 15/16).
//
// The proxy's password goes from the owner's field to Hub in one request and
// is sealed there (as `egress_endpoints.encrypted_auth`): never answered,
// never logged (Fastify logs no body), never audited, never in an error. The
// check is the owner's press, rate-limited, and touches no platform.

/** The drafts' and checks' audit: what was made and checked, never a
 *  password. */
type Principal = Parameters<typeof requireOwner>[0];

function commandOf(name: string, existing: boolean): string {
  return `scripts/deploy-page-browser.sh add-profile <host> --page ${name} --image <образ>${existing ? " --existing" : ""}`;
}

export function registerPageBrowserProxyEntryRoutes(
  server: ApiServer,
  ctx: ApiModuleContext,
  helpers: { requireThisOrigin: (headers: IncomingMessage["headers"]) => void; checks: ProxyCheckLedger },
): void {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;
  const { requireThisOrigin, checks } = helpers;
  const overrides = () => appContext.pageBrowserProxyCheck;

  async function audit(principal: Principal, metadata: Record<string, unknown>, platformAccountId: number | null = null): Promise<void> {
    await recordAudit({ db: appContext.db }, { ...auditCtx(principal), eventType: PAGE_BROWSER_ONBOARDING_AUDIT_EVENT, platformAccountId, metadata });
  }

  /** An existing page's own proxy, as the check takes it. */
  async function pageProxy(pageId: number, label: string): Promise<PastedProxy> {
    const page = await findPageById(appContext.db, pageId);
    if (page === null) throw new NotFoundError(`No active page ${label}`);
    if (page.proxy == null) throw new AppError(`Page ${label} has no proxy`, 409, "no_proxy");
    return storedProxyAsPasted(appContext.config, page.proxy);
  }

  async function draftView(draft: PageBrowserDraft): Promise<PageBrowserDraftView> {
    let proxy: PageBrowserDraftView["proxy"] = null;
    if (draft.proxy !== null) {
      proxy = maskStoredProxy(appContext.config, { url: draft.proxy.url, encryptedAuth: draft.proxy.encryptedAuth });
    } else if (draft.pageId !== null) {
      const page = await findPageById(appContext.db, draft.pageId);
      proxy = page?.proxy == null ? null : maskStoredProxy(appContext.config, page.proxy);
    }
    return {
      name: draft.name,
      page: draft.pageId === null ? null : { pageId: draft.pageId, label: draft.pageLabel ?? draft.name },
      proxy,
      env: pageBrowserEnvOf(draft.env),
      revision: draft.revision,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
      command: commandOf(draft.name, draft.pageId !== null),
    };
  }

  server.post("/api/v1/page-browser/proxy-check", {
    schema: routeSchemas.pageBrowserProxyCheck,
    // The owner's press, each one connection or two to the proxy.
    config: { rateLimit: { max: 12, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserProxyCheckResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const source = request.body.source;
    let proxy: PastedProxy;
    switch (source.kind) {
      case "text":
        proxy = readProxyText(source.proxy);
        break;
      case "draft": {
        const draft = await findPageBrowserDraft(appContext.db, source.name);
        if (draft === null) throw new NotFoundError(`No draft of the browser ${source.name}`);
        proxy = draft.proxy !== null
          ? storedProxyAsPasted(appContext.config, { url: draft.proxy.url, encryptedAuth: draft.proxy.encryptedAuth })
          : await pageProxy(draft.pageId!, draft.name);
        break;
      }
      case "profile": {
        const profile = await findOnboardingProfile(appContext.db, source.profileId);
        if (profile === null) throw new NotFoundError(`No page browser profile ${source.profileId}`);
        if (profile.pageId !== null) {
          proxy = await pageProxy(profile.pageId, profile.container);
        } else {
          if (profile.proxy === null) throw new AppError("No proxy is given for the new page's browser", 409, "no_proxy");
          proxy = storedProxyAsPasted(appContext.config, { url: profile.proxy.url, encryptedAuth: profile.proxy.encryptedAuth });
        }
        break;
      }
      case "page": {
        const found = await findFanslyPageForBrowser(appContext.db, source.pageLabel);
        if (found === null) throw new NotFoundError(`No active Fansly page ${source.pageLabel}`);
        if (found.proxy === null) throw new AppError(`Page ${source.pageLabel} has no proxy`, 409, "no_proxy");
        proxy = storedProxyAsPasted(appContext.config, found.proxy);
        break;
      }
    }
    return checkPageBrowserProxy(proxy, checks, overrides());
  });

  server.get("/api/v1/page-browser/drafts", {
    schema: routeSchemas.pageBrowserDrafts,
  }, async (request): Promise<PageBrowserDraftsResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const [drafts, pages] = await Promise.all([listPageBrowserDrafts(appContext.db), listPagesWithoutBrowser(appContext.db)]);
    return {
      drafts: await Promise.all(drafts.map(draftView)),
      pages: pages.map((page) => ({ pageId: page.pageId, label: page.label, proxy: page.proxy === null ? null : maskStoredProxy(appContext.config, page.proxy) })),
    };
  });

  server.put("/api/v1/page-browser/drafts/:name", {
    schema: routeSchemas.pageBrowserDraftSave,
  }, async (request): Promise<PageBrowserDraftView> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const name = request.params.name;
    const body = request.body;
    const envProblem = browserEnvProblem(body.env);
    if (envProblem !== null) throw new BadRequestError(envProblem, { reason: "env_invalid" });
    // A writer of a revision gone is refused at once (and again, under the
    // row lock, by the save's compare-and-set: Astra's review of PR #627,
    // round 2).
    const before = await findPageBrowserDraft(appContext.db, name);
    if ((before?.revision ?? null) !== body.expectedRevision) {
      throw new AppError(before === null
        ? `The draft of ${name} is gone (deleted meanwhile): open it again`
        : body.expectedRevision === null
          ? `A draft of ${name} exists already: open it to change it`
          : `The draft of ${name} was saved meanwhile (revision ${before.revision}, not ${body.expectedRevision}): open it again`, 409, "draft_changed");
    }
    let pageId: number | null = null;
    let sealed: ReturnType<typeof sealUsableProxy> | undefined;
    let keptProxy: { url: string; encryptedAuth: string | null } | undefined;
    // The SOCKS5 the container is made for: the address the owner's check of
    // this very proxy connected to — never resolved here (Astra's review of
    // PR #627, round 2).
    let socksEndpoint: string;
    let pageProxy: { id: number; fingerprint: string } | null = null;
    if (body.existingPage) {
      if (body.proxy !== undefined) {
        throw new BadRequestError("Браузер существующей страницы выходит через её собственную прокси: её меняют в настройках страницы", { reason: "proxy_of_page" });
      }
      const found = await findFanslyPageForBrowser(appContext.db, name);
      if (found === null) throw new NotFoundError(`No active Fansly page ${name}`);
      pageId = found.pageId;
      // The page's proxy as it is now — the one its check must be of, held
      // in the save (its row locked) and at the registration (item 4).
      const state = await pageProxyStateOf(appContext.db, pageId);
      let own: PastedProxy | null;
      try {
        own = state === null ? null : storedProxyAsPasted(appContext.config, { url: state.url, encryptedAuth: state.encryptedAuth });
      } catch {
        own = null;
      }
      if (state === null || own === null || own.scheme !== "socks5") {
        throw new BadRequestError(`У страницы ${name} ${own === null ? "нет прокси" : "не SOCKS5-прокси"}: браузер страницы выходит только через SOCKS5. Сначала смените прокси страницы`, { reason: "proxy_unusable" });
      }
      socksEndpoint = endpointOfCheck(checks, body.checkId, own, overrides());
      pageProxy = { id: state.id, fingerprint: state.fingerprint };
    } else if (body.proxy !== undefined) {
      const pasted = readProxyText(body.proxy);
      sealed = sealUsableProxy(appContext.config, pasted);
      socksEndpoint = endpointOfCheck(checks, body.checkId, pasted, overrides());
    } else {
      // Saved again with the proxy given before: its check must be of that
      // proxy, and the save holds it so (`keptProxy`, under the row lock).
      if (before?.proxy == null) throw new BadRequestError("A new page's browser needs its proxy", { reason: "no_proxy" });
      keptProxy = { url: before.proxy.url, encryptedAuth: before.proxy.encryptedAuth };
      socksEndpoint = endpointOfCheck(checks, body.checkId, storedProxyAsPasted(appContext.config, keptProxy), overrides());
    }
    let saved: PageBrowserDraft;
    try {
      saved = await savePageBrowserDraft(appContext.db, {
        name,
        pageId,
        socksEndpoint,
        pageProxy,
        expectedRevision: body.expectedRevision,
        ...(keptProxy === undefined ? {} : { keptProxy }),
        ...(sealed === undefined ? {} : { proxy: { url: sealed.url, encryptedAuth: sealed.encryptedAuth, keyVersion: sealed.keyVersion } }),
        env: body.env as unknown as Record<string, unknown>,
        by: `owner:${principal.user.id}`,
      });
    } catch (error) {
      if (error instanceof PageBrowserDraftError) {
        if (error.reason === "no_page") throw new NotFoundError(error.message);
        if (error.reason === "bad_name" || error.reason === "no_proxy" || error.reason === "not_socks5") throw new BadRequestError(error.message, { reason: error.reason });
        if (error.reason === "draft_changed" || error.reason === "page_proxy_changed") throw new AppError(error.message, 409, error.reason);
        throw new ConflictError(error.message);
      }
      throw error;
    }
    await audit(principal, {
      step: "draft",
      name,
      existingPage: pageId !== null,
      revision: saved.revision,
      socksEndpoint,
      ...(sealed === undefined ? {} : { proxy: `${sealed.masked.host}:${sealed.masked.port}` }),
    }, pageId);
    return draftView(saved);
  });

  server.delete("/api/v1/page-browser/drafts/:name", {
    schema: routeSchemas.pageBrowserDraftDelete,
  }, async (request) => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const deleted = await deletePageBrowserDraft(appContext.db, request.params.name);
    if (deleted) await audit(principal, { step: "draft_delete", name: request.params.name });
    return { deleted };
  });
}
