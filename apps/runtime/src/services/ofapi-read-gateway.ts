import { findOfapiReadDefinition, resolveOfapiCatalogPath, type OfapiCollectionContext } from "@agency_hub_core/shared";
import { materializeOfapiReadSnapshot } from "./ofapi-collection-runner.ts";
import { safeOfapiReadBody } from "./ofapi-read-normalization.ts";
import { listOfapiMappedPages, OfapiCollectionPolicyError } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import {
  compareOfapiHistoryShadow,
  isExplicitOfapiDeepHistoryRead,
  mapOfapiHistoryMissToFallback,
  OFAPI_DEEP_HISTORY_READ_INTENT,
  readCertifiedOfapiHistoryResponse,
  type OfapiHistoryFallbackReason,
} from "./ofapi-certified-history-read.ts";
import { ofapiAuthStatusNeedsAction } from "./ofapi-account-health.ts";
import { executeCaptureFirstInteractiveRead } from "./ofapi-capture-transport.ts";
import { resolveOfapiEgressContext } from "./ofapi-egress.ts";
import { isOfapiDmReadthroughReconcileEnabled } from "./ofapi-dm-readthrough.ts";
import { enqueueReadGatewayCapture } from "./ofapi-read-gateway-capture.ts";
import { OfapiApiError, OfapiGovernedRequestError } from "./ofapi.ts";
import {
  BadRequestError,
  NotFoundError,
  OfapiCollectionRefusedError,
  ServiceUnavailableError,
} from "./errors.ts";

type RawQuery = Record<string, unknown>;

interface QueryRule {
  parse(value: string, name: string): string;
  required?: boolean;
}

interface ProxyRequest {
  collectionContext?: OfapiCollectionContext;
  kind: "proxy";
  accountId: string;
  pathname: string;
  query: Record<string, string>;
  operation: string;
  fallbackCredits: number;
  fallbackEstimated: boolean;
  /** PR4: set for the chat-messages readthrough — the chat id (== the fan id
   * on OnlyFans) that the widened v2 capture envelope carries. */
  chatId?: string;
}

export type OfapiReadGatewayRequest =
  | { kind: "accounts" }
  | { kind: "whoami" }
  | ProxyRequest;

export interface OfapiReadGatewayResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function invalid(message: string): never {
  throw new BadRequestError(`Invalid OFAPI read gateway request: ${message}`);
}

/**
 * Review #136: a collection-policy refusal — raw from the repository on the
 * proxy-read path, or the pre-dispatch cause of a governed attempt on the
 * capture-first path — is a local decision, never an upstream failure. It
 * becomes the one typed HTTP answer (429 for a time-bound cap with the reset
 * advice, 409 for an owner policy state) instead of 500/503.
 */
export function ofapiCollectionRefusal(error: unknown): OfapiCollectionRefusedError | null {
  const cause = error instanceof OfapiGovernedRequestError && error.phase === "pre_dispatch"
    ? error.cause
    : error;
  return cause instanceof OfapiCollectionPolicyError
    ? new OfapiCollectionRefusedError(cause.reason, { retryAt: cause.retryAt })
    : null;
}

function decodeSegments(rawPath: string) {
  const normalized = rawPath.replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0 || normalized.length > 1000) {
    invalid("path is empty or too long");
  }

  return normalized.split("/").map((raw) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return invalid("path contains invalid percent encoding");
    }
    if (
      decoded.length === 0
      || decoded.length > 200
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded === "."
      || decoded === ".."
    ) {
      return invalid("path contains an invalid segment");
    }
    return decoded;
  });
}

function integerRule(min: number, max: number): QueryRule {
  return {
    parse(value, name) {
      if (!/^\d+$/.test(value)) {
        return invalid(`${name} must be an integer`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        return invalid(`${name} is outside ${min}..${max}`);
      }
      return String(parsed);
    },
  };
}

function enumRule(values: readonly string[]): QueryRule {
  const allowed = new Set(values);
  return {
    parse(value, name) {
      if (!allowed.has(value)) {
        return invalid(`${name} has an unsupported value`);
      }
      return value;
    },
  };
}

function textRule(maxLength: number, pattern?: RegExp): QueryRule {
  return {
    parse(value, name) {
      if (value.length === 0 || value.length > maxLength || (pattern && !pattern.test(value))) {
        return invalid(`${name} has an invalid value`);
      }
      return value;
    },
  };
}

const OFFSET = integerRule(0, 1_000_000);
const LIMIT_100 = integerRule(1, 100);
const NO_QUERY = {} satisfies Record<string, QueryRule>;

function parseQuery(raw: RawQuery, rules: Record<string, QueryRule>) {
  const parsed: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const rule = rules[name];
    if (!rule) {
      invalid(`query parameter ${name} is not allowed`);
    }
    if (typeof value !== "string") {
      invalid(`query parameter ${name} must appear exactly once`);
    }
    parsed[name] = rule.parse(value, name);
  }
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.required && parsed[name] === undefined) invalid(`query parameter ${name} is required`);
  }
  return parsed;
}

function proxy(
  accountId: string,
  segments: string[],
  query: Record<string, string>,
  operation: string,
  fallbackCredits = 1,
  fallbackEstimated = true,
): ProxyRequest {
  return {
    kind: "proxy",
    accountId,
    pathname: `/${segments.map(encodeURIComponent).join("/")}`,
    query,
    operation,
    fallbackCredits,
    fallbackEstimated,
  };
}

export function resolveOfapiReadGatewayRequest(
  rawPath: string,
  rawQuery: RawQuery,
): OfapiReadGatewayRequest {
  const segments = decodeSegments(rawPath);
  // Existing desktop list reads retain their established validation and admission.
  // New bounded collectors use the catalog and explicit collection context.
  const legacyUserList = segments[1] === "user-lists" && (segments.length === 2 || (segments.length === 4 && segments[3] === "users"));
  let catalog;
  try { catalog = legacyUserList ? null : resolveOfapiCatalogPath(rawPath, rawQuery); } catch (error) { invalid(error instanceof Error ? error.message : "Invalid collection query"); }
  if (catalog && !catalog.definition.collectionOnly) return { kind: "proxy", accountId: catalog.accountId, pathname: catalog.pathname, query: catalog.query, operation: catalog.definition.operation, fallbackCredits: catalog.definition.reservedCredits ?? 1, fallbackEstimated: true, collectionContext: { category: catalog.definition.category, purpose: "interactive", detail: catalog.definition.detail, reservedCredits: catalog.definition.reservedCredits ?? 1 } };
  if (segments.length === 1 && segments[0] === "accounts") {
    parseQuery(rawQuery, NO_QUERY);
    return { kind: "accounts" };
  }
  if (segments.length === 1 && segments[0] === "whoami") {
    parseQuery(rawQuery, NO_QUERY);
    return { kind: "whoami" };
  }

  const accountId = segments[0]!;
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    invalid("account id is not an OFAPI account id");
  }

  if (segments.length === 2 && segments[1] === "chats") {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      limit: LIMIT_100,
      offset: OFFSET,
      order: enumRule(["recent", "old"]),
      filter: enumRule(["pinned", "priority", "unread", "with_tips", "unread_with_tips"]),
      query: textRule(200),
      skip_users: enumRule(["all", "none"]),
    }), "ofapi_gateway_chats");
  }

  if (
    segments.length === 4
    && segments[1] === "chats"
    && segments[3] === "messages"
  ) {
    const query = parseQuery(rawQuery, {
      limit: LIMIT_100,
      order: enumRule(["asc", "desc"]),
      filter: enumRule(["pinned"]),
      first_id: textRule(100),
      last_id: textRule(100),
      skip_users: enumRule(["all", "none"]),
    });
    if (query.first_id && query.last_id) {
      invalid("first_id and last_id are mutually exclusive");
    }
    if (query.first_id && query.order !== undefined && query.order !== "desc") {
      invalid("first_id requires order=desc");
    }
    if (query.last_id && query.order !== undefined && query.order !== "asc") {
      invalid("last_id requires order=asc");
    }
    return {
      ...proxy(accountId, segments, query, "ofapi_gateway_chat_messages"),
      chatId: segments[2]!,
    };
  }

  if (segments.length === 5 && segments[1] === "chats" && segments[3] === "messages" && segments[4] === "search") {
    return proxy(accountId, segments, parseQuery(rawQuery, { query: { ...textRule(200), required: true } }), "ofapi_gateway_chat_search");
  }

  if (
    segments.length === 5
    && segments[1] === "chats"
    && segments[3] === "messages"
  ) {
    if (!/^\d+$/.test(segments[4]!)) invalid("message id must be numeric");
    return proxy(
      accountId,
      segments,
      parseQuery(rawQuery, NO_QUERY),
      "ofapi_gateway_chat_message",
    );
  }

  if (
    segments.length === 4
    && segments[1] === "chats"
    && segments[3] === "media"
  ) {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      type: { parse(value, name) {
        const aliases: Record<string, string> = { photo: "photos", video: "videos", audio: "audios" };
        return enumRule(["photos", "videos", "audios"]).parse(aliases[value] ?? value, name);
      } },
      limit: LIMIT_100,
      offset: OFFSET,
      skip_users: enumRule(["all", "none"]),
    }), "ofapi_gateway_chat_media");
  }

  if (segments.length === 3 && segments[1] === "users" && segments[2] === "list") {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      ids: { ...textRule(220, /^\d+(,\d+){0,9}$/), required: true },
    }), "ofapi_gateway_users_list");
  }

  if (segments.length === 3 && segments[1] === "users") {
    if (["blocked", "restricted", "search", "me"].includes(segments[2]!)) invalid("reserved user path is not supported");
    return proxy(
      accountId,
      segments,
      parseQuery(rawQuery, NO_QUERY),
      "ofapi_gateway_user",
    );
  }

  if (segments.length === 2 && segments[1] === "transactions") {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      limit: LIMIT_100,
      type: enumRule(["subscribes", "tips", "post", "chat_messages", "stream"]),
      tipsSource: enumRule(["profile", "post_all", "chat", "stream", "story"]),
      marker: integerRule(0, Number.MAX_SAFE_INTEGER),
      startDate: textRule(64, /^(?:-\d+days|\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?)$/),
    }), "ofapi_gateway_transactions");
  }

  if (
    segments.length === 3
    && segments[1] === "fans"
    && (segments[2] === "all" || segments[2] === "active")
  ) {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      limit: integerRule(1, 20),
      offset: OFFSET,
      query: textRule(200),
      // Online surface (desktop variant C): filter[online]=1 + a >= dollar
      // threshold filter[total_spent] for the «Только спендеры» snapshot.
      // Fastify's default qs parser keeps these as flat bracket keys; proxyRead
      // re-serializes them verbatim (filter%5Bonline%5D=1) to OFAPI.
      "filter[online]": enumRule(["1"]),
      "filter[total_spent]": integerRule(0, 1_000_000),
      "filter[max_total_spent]": integerRule(0, 1_000_000),
    }), `ofapi_gateway_fans_${segments[2]}`);
  }

  if (segments.length === 2 && segments[1] === "user-lists") {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      view: enumRule(["queue"]),
      limit: integerRule(10, 50),
      offset: OFFSET,
    }), "ofapi_gateway_user_lists");
  }

  if (
    segments.length === 4
    && segments[1] === "user-lists"
    && segments[3] === "users"
  ) {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      limit: LIMIT_100,
      offset: OFFSET,
    }), "ofapi_gateway_user_list_users");
  }

  if (segments.length === 3 && segments[1] === "media" && segments[2] === "vault") {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      query: textRule(200),
      field: enumRule(["recent", "most-liked", "highest-tips"]),
      type: enumRule(["photo", "gif", "video", "audio"]),
      list: textRule(100),
      sort: enumRule(["asc", "desc"]),
      limit: integerRule(10, 100),
      offset: OFFSET,
    }), "ofapi_gateway_vault_media");
  }

  if (
    segments.length === 4
    && segments[1] === "media"
    && segments[2] === "vault"
    && segments[3] === "lists"
  ) {
    return proxy(accountId, segments, parseQuery(rawQuery, {
      query: textRule(200),
      limit: LIMIT_100,
      offset: OFFSET,
      lightweight: enumRule(["true", "false"]),
    }), "ofapi_gateway_vault_lists");
  }

  if (segments.length === 4 && segments[1] === "media" && segments[2] === "vault") {
    if (segments[3] === "delete-media") {
      invalid("path is not in the read-only allowlist");
    }
    return proxy(
      accountId,
      segments,
      parseQuery(rawQuery, NO_QUERY),
      "ofapi_gateway_vault_media_item",
    );
  }

  if (
    segments.length === 5
    && segments[1] === "media"
    && segments[2] === "uploads"
    && segments[4] === "status"
  ) {
    return proxy(
      accountId,
      segments,
      parseQuery(rawQuery, NO_QUERY),
      "ofapi_gateway_upload_status",
      0,
      false,
    );
  }

  return invalid("path is not in the read-only allowlist");
}

function authenticatedFromStatus(status: string | null) {
  if (status === null) {
    return null;
  }
  return !ofapiAuthStatusNeedsAction(status);
}

function avatarFromMetadata(metadata: Record<string, unknown>) {
  return typeof metadata.avatarUrl === "string" && metadata.avatarUrl.length > 0
    ? metadata.avatarUrl
    : null;
}

export async function executeOfapiReadGatewayRequest(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: {
    rawPath: string;
    rawQuery: RawQuery;
    readIntent?: string | null;
  },
): Promise<OfapiReadGatewayResponse> {
  if (app.config.ofapiDesktopReadGatewayEnabled !== true) {
    throw new ServiceUnavailableError("OFAPI desktop read gateway is disabled");
  }
  const historyShadow = app.config.ofapiMessageHistoryShadowEnabled === true;
  const historyDbFallback = app.config.ofapiMessageHistoryDbFallbackEnabled === true;
  if (historyDbFallback && !historyShadow) {
    throw new ServiceUnavailableError(
      "OFAPI history DB fallback requires the shadow stage",
    );
  }
  const historyMode = historyDbFallback ? "db_fallback" : historyShadow ? "shadow" : "vendor";
  const readIntent = input.readIntent?.trim() || null;
  if (readIntent !== null && readIntent !== OFAPI_DEEP_HISTORY_READ_INTENT) {
    throw new BadRequestError("Unsupported OFAPI read intent");
  }

  const request = resolveOfapiReadGatewayRequest(input.rawPath, input.rawQuery);
  const captureFirst = Boolean(request.kind === "proxy" && request.collectionContext) || app.config.ofapiMirrorInteractiveCaptureEnabled === true;

  if (request.kind === "whoami") {
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        api_key: { name: `Agency Hub chatter: ${principal.user.username}` },
        team: { name: "Agency Hub", slug: "agency-hub" },
      },
    };
  }

  const pages = await listOfapiMappedPages(app.db);
  const assigned = pages.filter((page) => principal.assignedPageIds.includes(page.id));

  if (request.kind === "accounts") {
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: assigned.map((page) => ({
        id: page.ofapiAccountId,
        is_authenticated: authenticatedFromStatus(page.ofapiAuthStatus),
        authentication_progress: page.ofapiAuthStatus,
        display_name: page.displayName ?? page.label,
        onlyfans_username: page.username,
        onlyfans_user_data: {
          name: page.displayName ?? page.label,
          username: page.username,
          avatar: avatarFromMetadata(page.metadata),
        },
      })),
    };
  }

  const page = assigned.find((candidate) => candidate.ofapiAccountId === request.accountId);
  if (!page) {
    throw new NotFoundError("OFAPI account is not assigned to this chatter");
  }

  if (readIntent !== null && request.chatId === undefined) {
    throw new BadRequestError("Deep-history intent is valid only for chat messages");
  }
  if (historyMode !== "vendor" && !captureFirst) {
    throw new ServiceUnavailableError(
      "OFAPI certified history modes require capture-first fallback",
    );
  }

  let fallbackReason: OfapiHistoryFallbackReason | null = null;
  let shadowCandidate: { messageIds: string[] } | null = null;
  const explicitHistory = request.chatId !== undefined
    && isExplicitOfapiDeepHistoryRead({
      chatId: request.chatId,
      accountId: request.accountId,
      pathname: request.pathname,
      query: request.query,
    }, readIntent);
  if (historyMode !== "vendor") {
    if (!explicitHistory) {
      fallbackReason = "surface_not_cutover";
    } else {
      const certified = await readCertifiedOfapiHistoryResponse(app, {
        pageId: page.id,
        chatId: request.chatId!,
        accountId: request.accountId,
        pathname: request.pathname,
        query: request.query,
      });
      if (certified.kind === "hit") {
        if (historyMode === "db_fallback") return certified.response;
        shadowCandidate = { messageIds: certified.messageIds };
        fallbackReason = "shadow_probe";
      } else {
        fallbackReason = mapOfapiHistoryMissToFallback(certified.reason);
        app.logger.info({
          pageId: page.id,
          chatId: request.chatId,
          certifiedHistoryMissReason: certified.reason,
          fallbackReason,
        }, "OFAPI certified history read missed");
      }
    }
  }

  if (app.config.ofapiCreditLedgerEnabled !== true) {
    throw new ServiceUnavailableError("OFAPI desktop read gateway requires the credit ledger");
  }
  if (
    !app.ofapi ||
    (captureFirst ? !app.ofapi.dispatchGovernedRaw : !app.ofapi.proxyRead)
  ) {
    throw new ServiceUnavailableError("OFAPI client is not configured");
  }

  if (findOfapiReadDefinition(request.operation)?.category === "balances" && principal.user.role !== "owner") {
    throw new BadRequestError("Financial collection reads require the owner report");
  }
  const egress = await resolveOfapiEgressContext(app, {
    pageId: page.id,
    ofapiAccountId: request.accountId,
  });
  try {
    const response = captureFirst
      ? await executeCaptureFirstInteractiveRead(app, {
        principalUserId: principal.user.id,
        pageId: page.id,
        ofapiAccountId: request.accountId,
        dispatcher: egress.dispatcher,
        egressKey: egress.egressKey,
        operation: request.operation,
        surface: request.operation,
        pathname: request.pathname,
        query: request.query,
        fallbackCredits: request.fallbackCredits,
        collectionContext: request.collectionContext,
        servingMode: historyMode === "vendor" ? "vendor_only" : historyMode,
        fallbackReason,
      })
      : await app.ofapi.proxyRead!({
        pageId: page.id,
        dispatcher: egress.dispatcher,
        egressKey: egress.egressKey,
        // Stage 9: the acting chatter attributes this read's credit spend.
        actorUserId: principal.user.id,
      }, {
        operation: request.operation,
        pathname: request.pathname,
        query: request.query,
        fallbackCredits: request.fallbackCredits,
        fallbackEstimated: request.fallbackEstimated,
      });
    if (request.collectionContext && response.status >= 200 && response.status < 300) {
      if (!("capture" in response)) throw new ServiceUnavailableError("Collection requires durable response capture");
      const capture = response.capture as { observationId: number; receivedAt: Date };
      await materializeOfapiReadSnapshot(app, { pageId: page.id, step: request, body: response.body, observationId: capture.observationId, observationReceivedAt: capture.receivedAt });
      response.body = safeOfapiReadBody(request.operation, response.body);
    }
    // Stage 9 producer 4: tee every successful proxied body into the journal
    // — O(1) enqueue off the latency path, fail-open with a visible counter.
    if (!captureFirst && response.status >= 200 && response.status < 300) {
      enqueueReadGatewayCapture({
        app,
        principalUserId: principal.user.id,
        pageId: page.id,
        operation: request.operation,
        status: response.status,
        body: response.body,
        // PR4: chat-messages readthroughs journal the widened v2 envelope
        // (chat id == conversation ref == the fan id on OnlyFans) once the
        // reconcile flag is on; the flag off keeps today's v1 capture shape.
        ...(request.chatId !== undefined
            && isOfapiDmReadthroughReconcileEnabled(app.config)
          ? {
            chat: {
              ofapiAccountId: request.accountId,
              chatId: request.chatId,
              conversationRef: request.chatId,
              cursors: request.query,
            },
          }
          : {}),
      });
    }
    if (historyMode === "vendor") return response;
    const headers: Record<string, string> = {
      ...response.headers,
      "x-agency-hub-read-source": "vendor",
      ...(fallbackReason === null
        ? {}
        : { "x-agency-hub-read-fallback": fallbackReason }),
    };
    if (historyMode === "shadow" && shadowCandidate !== null) {
      const comparison = compareOfapiHistoryShadow(shadowCandidate.messageIds, response.body);
      headers["x-agency-hub-history-shadow"] = comparison.matches ? "match" : "mismatch";
      if (!comparison.matches) {
        app.logger.warn({
          pageId: page.id,
          chatId: request.chatId,
          dbMessageIds: shadowCandidate.messageIds,
          vendorMessageIds: comparison.vendorIds,
        }, "OFAPI certified history shadow mismatch");
      }
    }
    return { ...response, headers };
  } catch (error) {
    const refusal = ofapiCollectionRefusal(error);
    if (refusal) throw refusal;
    if (error instanceof OfapiApiError && error.status === null) {
      throw new ServiceUnavailableError("OFAPI upstream is unavailable");
    }
    throw error;
  } finally {
    try {
      await egress.close();
    } catch (error) {
      app.logger.warn({ error }, "Failed to close OFAPI egress dispatcher");
    }
  }
}
