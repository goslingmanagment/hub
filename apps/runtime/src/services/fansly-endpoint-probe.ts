import {
  FanslyApiError,
  redactedFanslyRequestHeaderPlan,
  type RedactedFanslyRequestHeaderPlan,
} from "@agency_hub_core/fansly";

import type { AppContext } from "../bootstrap.ts";
import { resolvePageContext } from "./page-context.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";

// Liveness probe for the endpoints-cover initiative: WP-F9 (`dm_commerce`), [E1],
// the WP-F3 catalog routes, and [F1]'s month form.
//
// WHY THIS EXISTS. Every route below came from the 2026-08-20 static bundle
// extraction — the Fansly web client builds these requests. That is client-code
// evidence, NOT proof the server will serve them to us. The plan's rule is
// "liveness first, budget second": nothing is budgeted, flagged, scheduled or
// designed around until its first live call lands. This fires exactly that call.
//
// [E1] is the load-bearing one and it is not part of WP-F9: every observed
// `GET /post/{id}/replies` in the capture was preceded ~40 ms earlier by
// `POST /postreply/verify`. We issue the BARE GET. If it fails, WP-F5 — the whole
// comment archive — must be cut BEFORE anything is built on it.
//
// READ-ONLY, and structurally so: every route is a GET, the adapter hardcodes the
// method, and nothing here writes to Fansly or to Postgres beyond the ordinary sync
// telemetry every request already produces. There is no POST anywhere in this file
// — in particular `POST /postreply/verify` is deliberately NOT issued, because
// issuing it would destroy the only question [E1] asks.
//
// Egress: through `resolvePageContext` → the page's own proxy and egress key, with
// the standard rate-limit waiter. A Fansly page must never egress from the shared
// VPS IP (ban risk), and this path is why it does not.

export type EndpointProbeVerdict =
  /** 2xx — the route answered. */
  | "live"
  /** 401/403 — the session was rejected; says nothing about the route. */
  | "auth-rejected"
  /** Any other HTTP rejection — we got PAST auth, so the route itself refused us. */
  | "route-rejected"
  | "transport-error"
  /** No call fired: dry run, or a required path parameter was not supplied. */
  | "skipped";

export interface EndpointProbeResult {
  page: string;
  route: string;
  verdict: EndpointProbeVerdict;
  httpStatus: number | null;
  errorCode: number | null;
  /** Item count when the response was list-shaped; null when it was not, or on failure. */
  itemCount: number | null;
  /** True when the call was fired without its optional narrowing ids. */
  bare: boolean;
  /** --ids only: allowlisted identifier fields per list row (see ID_FIELDS). */
  ids?: Array<Record<string, unknown>> | null;
  /**
   * Redacted structural skeleton of the response: key names and value TYPES only,
   * never values. This is what the next step (designing storage) actually needs,
   * and it is why the probe does not journal bodies — an owner-run diagnostic
   * should not put fan PII into a terminal or a transcript to learn a shape.
   */
  shape: string | null;
  /**
   * One route-specific line beside the skeleton, for the questions a skeleton
   * cannot answer. Only a route that declares one gets one, and what it may
   * carry is the same class of thing the skeleton is: WINDOW BOUNDS and COUNTS.
   * A served `dateAfter`/`dateBefore` is a window identity, not a value to
   * redact — it is the entire answer to "was the month we asked for served".
   */
  note?: string | null;
  wallClockMs: number;
  message: string | null;
  /** The exact adapter header plan, secret values redacted, in insertion order. */
  requestHeaders: RedactedFanslyRequestHeaderPlan;
}

export interface EndpointProbeOptions {
  pageLabels: string[];
  dryRun?: boolean;
  /**
   * Required for the [E1] replies probe — the id is a PATH segment, so unlike every
   * other route here there is no meaningful bare call. Pick a post with a known,
   * visible reply, or the probe cannot distinguish "no comments" from "route dead".
   */
  postId?: string | null;
  /** Optional narrowing ids. Absent ⇒ the call still fires, bare (see `bare` above). */
  groupId?: string | null;
  fanAccountId?: string | null;
  storyId?: string | null;
  /** WP-F3 catalog probes: a known media id, bundle id, album id, post id. Absent ⇒ bare. */
  mediaId?: string | null;
  bundleId?: string | null;
  albumId?: string | null;
  /**
   * Restrict the run to routes whose key contains this substring (case-insensitive).
   * Lets a follow-up question re-fire ONE route against several subjects without
   * re-spending a request on the nine others.
   */
  only?: string | null;
  /**
   * Print platform IDENTIFIERS (and price/type/purchased flags) from list rows, so a
   * response can be reconciled against the journal by id. Still no free text, no
   * URLs, no usernames — the allowlist below is the whole surface.
   */
  ids?: boolean;
}

type ProbeRoute = {
  key: string;
  pathname: (options: EndpointProbeOptions) => string;
  /** True when the call cannot be made bare because an id is a path segment. */
  requires?: "postId";
  run: (
    app: AppContext,
    ctx: Parameters<AppContext["adapter"]["getPostRepliesPage"]>[0],
    options: EndpointProbeOptions,
  ) => Promise<{ items: unknown; note?: string | null }>;
  isBare: (options: EndpointProbeOptions) => boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The month the [F1] probe asks for: TWO calendar months back from today, UTC.
 *
 * Two rather than one because last month is partly inside the route's own
 * trailing window — a served window that happens to overlap it would prove
 * nothing. Two months back cannot be reached by the trailing window at all, so
 * the served bounds answer the question on their own.
 */
export function probeStatsMonth(now: Date): { year: number; month: number } {
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - 2;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function isoDay(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString().slice(0, 10)
    : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * The [F1] answer in one line: what we named, what came back, and the verdict.
 *
 * The verdict is the same predicate the capture lane's month walk uses — the
 * served `dateAfter` must fall inside the requested month — so a probe run and
 * a lane run cannot disagree about what "honoured" means.
 */
export function describeStatsMonthAnswer(
  requested: { year: number; month: number },
  items: unknown,
): string {
  const record = items && typeof items === "object" ? items as Record<string, unknown> : null;
  const dataset = record && typeof record.dataset === "object" && record.dataset !== null
    ? record.dataset as Record<string, unknown>
    : null;
  const servedAfter = isoDay(dataset?.dateAfter);
  const servedBefore = isoDay(dataset?.dateBefore);
  const monthStart = Date.UTC(requested.year, requested.month - 1, 1);
  const monthEnd = Date.UTC(requested.year, requested.month, 1);
  const after = typeof dataset?.dateAfter === "number" ? dataset.dateAfter : null;
  const honoured = after === null
    ? null
    : after >= monthStart - DAY_MS && after < monthEnd + DAY_MS;
  const profile = arrayLength(dataset?.profileDatapoints);
  const points = arrayLength(dataset?.datapoints);
  return [
    `asked year=${requested.year} month=${requested.month}`
    + ` (${new Date(monthStart).toISOString().slice(0, 10)} → `
    + `${new Date(monthEnd - DAY_MS).toISOString().slice(0, 10)})`,
    `served dateAfter=${servedAfter ?? "-"} dateBefore=${servedBefore ?? "-"}`,
    `profileDatapoints=${profile ?? "-"} datapoints=${points ?? "-"}`,
    honoured === null
      ? "UNJUDGED — the response described no window"
      : honoured
      ? "MONTH FORM HONOURED — the served window starts inside the month we named"
      : "MONTH FORM NOT HONOURED — the server answered a different window "
        + "(the trailing one, if dateBefore is near today)",
  ].join(" · ");
}

/**
 * Order matters only for readability of the report. [E1] runs first because it is
 * the one whose answer can delete a slice of the plan.
 */
const ROUTES: ProbeRoute[] = [
  {
    key: "[E1] GET /post/{postId}/replies (BARE — no verify POST)",
    pathname: (o) => `/post/${o.postId ?? "{postId}"}/replies`,
    requires: "postId",
    run: (app, ctx, o) => app.adapter.getPostRepliesPage(ctx, { postId: o.postId as string }),
    isBare: () => true,
  },
  {
    key: "GET /groups/mediaoffers",
    pathname: () => "/groups/mediaoffers",
    run: (app, ctx, o) =>
      app.adapter.getGroupMediaOffersPage(ctx, {
        groupId: o.groupId ?? "",
        accountId: o.fanAccountId ?? null,
        limit: 10,
      }),
    isBare: (o) => !o.groupId,
  },
  {
    key: "GET /message/broadcast/stats",
    pathname: () => "/message/broadcast/stats",
    run: (app, ctx) => app.adapter.getBroadcastStatsPage(ctx, { limit: 10 }),
    isBare: () => false,
  },
  {
    key: "GET /message/broadcast/stats/deleted",
    pathname: () => "/message/broadcast/stats",
    run: (app, ctx) => app.adapter.getBroadcastStatsPage(ctx, { limit: 10, deleted: true }),
    isBare: () => false,
  },
  {
    key: "GET /message/broadcast/scheduled",
    pathname: () => "/message/broadcast/scheduled",
    run: (app, ctx) => app.adapter.getBroadcastScheduled(ctx),
    isBare: () => false,
  },
  {
    key: "GET /account/media/orders",
    pathname: () => "/account/media/orders",
    run: (app, ctx) => app.adapter.getAccountMediaOrdersPage(ctx, { limit: 10, offset: 0 }),
    isBare: () => false,
  },
  // `GET /tips` (by targetIds) is deliberately ABSENT: it is already wired and live
  // (`getTipsByTargetIds`, operation `post_tips` — 531 calls / 530 successes in the
  // 10 days to 2026-08-21). It sat on the WP-F9 list until the kernel was checked.
  {
    key: "GET /tips/account",
    pathname: () => "/tips/account",
    run: (app, ctx, o) =>
      app.adapter.getTipsByAccountIds(ctx, { accountIds: o.fanAccountId ?? null }),
    isBare: (o) => !o.fanAccountId,
  },
  {
    key: "GET /mediastory/views",
    pathname: () => "/mediastory/views",
    run: (app, ctx, o) =>
      app.adapter.getMediaStoryViewsPage(ctx, { storyId: o.storyId ?? "", limit: 10, offset: 0 }),
    isBare: (o) => !o.storyId,
  },
  {
    key: "GET /polls",
    pathname: () => "/polls",
    run: (app, ctx) => app.adapter.getPolls(ctx),
    isBare: () => false,
  },
  {
    key: "GET /recapstats",
    pathname: () => "/recapstats",
    run: (app, ctx) => app.adapter.getRecapStats(ctx),
    isBare: () => false,
  },
  // ---- [F1] the month form: the only way this route serves history ----
  //
  // WHY IT IS HERE. WP-F1's history walk asked `/it/amoie/stats` for historical
  // DATE BOUNDS and production answered every one of them with its own trailing
  // 31 days (lora-2, 2026-08-22: `afterDate 2026-06-21 / beforeDate 2026-07-22`
  // came back `2026-07-21 → 2026-08-21`; halving to 15 days changed nothing).
  // The app's own past-month view sends `year`/`month` instead and lets the
  // server resolve the month. ONE run of this route answers whether that form
  // is honoured — the served bounds are printed, so the answer is readable
  // rather than inferred.
  {
    key: "[F1] GET /it/amoie/stats?year=&month= (the month form)",
    pathname: () => "/it/amoie/stats",
    run: async (app, ctx) => {
      const now = new Date();
      const { year, month } = probeStatsMonth(now);
      // EXACTLY the app's request: the trailing bounds ride along ignored.
      const { items } = await app.adapter.getAccountStats(ctx, {
        beforeDate: now,
        afterDate: new Date(now.getTime() - 30 * DAY_MS),
        periodMs: 86_400_000,
        year,
        month,
      });
      return { items, note: describeStatsMonthAnswer({ year, month }, items) };
    },
    isBare: () => false,
  },
  // ---- WP-F3 catalog routes from the March corpus, never observed live ----
  {
    key: "[F3] GET /account/media?ids=",
    pathname: () => "/account/media",
    run: (app, ctx, o) => app.adapter.getAccountMediaByIds(ctx, { ids: o.mediaId ?? "" }),
    isBare: (o) => !o.mediaId,
  },
  {
    key: "[F3] GET /account/media/bundle?ids=",
    pathname: () => "/account/media/bundle",
    run: (app, ctx, o) => app.adapter.getAccountMediaBundlesByIds(ctx, { ids: o.bundleId ?? "" }),
    isBare: (o) => !o.bundleId,
  },
  {
    key: "[F3] GET /account/walls?correlationPostIds=",
    pathname: () => "/account/walls",
    run: (app, ctx, o) => app.adapter.getAccountWalls(ctx, { correlationPostIds: o.postId ?? null }),
    isBare: (o) => !o.postId,
  },
  {
    key: "[F3] GET /media/vaultnew?albumId=",
    pathname: () => "/media/vaultnew",
    // WP-F3 settled the query form: `before`/`after` are the LITERAL "0" and
    // `mediaType` is present-and-EMPTY when unfiltered. The probe sends what
    // the lane sends, so a future probe run measures the real request.
    run: (app, ctx, o) =>
      app.adapter.getVaultMediaPage(ctx, {
        albumId: o.albumId ?? null,
        mediaType: "",
        search: "",
        before: "0",
        after: "0",
      }),
    isBare: (o) => !o.albumId,
  },
];

/**
 * Classify one probe call. The distinction that matters: 401/403 means the SESSION
 * was rejected and the route is unjudged, while any other status means we got past
 * auth and the route itself answered — a 404 is therefore a real finding about the
 * route, not a failure of the probe.
 */
function classify(error: unknown): {
  verdict: EndpointProbeVerdict;
  httpStatus: number | null;
  errorCode: number | null;
  message: string;
} {
  if (error instanceof FanslyApiError) {
    const status = error.status ?? null;
    if (status === 401 || status === 403) {
      return {
        verdict: "auth-rejected",
        httpStatus: status,
        errorCode: error.code ?? null,
        message: error.message,
      };
    }
    return {
      verdict: "route-rejected",
      httpStatus: status,
      errorCode: error.code ?? null,
      message: error.message,
    };
  }
  return {
    verdict: "transport-error",
    httpStatus: null,
    errorCode: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Structural skeleton, values stripped. `{id: string, price: number}` tells you
 * everything needed to design a projection; the actual id and price do not.
 * Depth- and width-limited so an unexpected giant response cannot flood stdout.
 */
const ID_FIELDS = [
  "id", "mediaOfferId", "mediaOfferType", "mediaOfferBundleId", "mediaId", "mediaType",
  "locationId", "locationType", "correlationId", "accountId", "price", "purchased", "deleted",
  "createdAt", "transactionId", "groupId", "type", "status", "amount",
] as const;

/** Pull only allowlisted identifier/flag fields from each list row. Never text or URLs. */
function extractIds(value: unknown): Array<Record<string, unknown>> | null {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).data)
      ? ((value as Record<string, unknown>).data as unknown[])
      : null;
  if (!rows) return null;
  return rows.slice(0, 100).map((row) => {
    const out: Record<string, unknown> = {};
    if (row && typeof row === "object") {
      for (const key of ID_FIELDS) {
        const v = (row as Record<string, unknown>)[key];
        if (v === undefined) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) out[key] = v;
      }
    }
    return out;
  });
}

function describeShape(value: unknown, depth = 0): string {
  if (depth > 3) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} × ${describeShape(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, 30).map(([k, v]) => `${k}: ${describeShape(v, depth + 1)}`);
    if (entries.length > 30) shown.push(`…+${entries.length - 30} more`);
    return `{${shown.join(", ")}}`;
  }
  return typeof value;
}

function countItems(items: unknown): number | null {
  if (Array.isArray(items)) {
    return items.length;
  }
  if (items && typeof items === "object" && Array.isArray((items as { data?: unknown }).data)) {
    return ((items as { data: unknown[] }).data).length;
  }
  return null;
}

export async function runFanslyEndpointProbe(
  app: AppContext,
  options: EndpointProbeOptions,
): Promise<EndpointProbeResult[]> {
  if (options.pageLabels.length === 0) {
    throw new Error("fansly:endpoint-probe requires at least one --page <label>");
  }

  const results: EndpointProbeResult[] = [];

  for (const pageLabel of options.pageLabels) {
    const context = await resolvePageContext(app, pageLabel);
    if (context.platform !== "fansly") {
      throw new Error(`Page "${pageLabel}" is not a Fansly page (platform=${context.platform})`);
    }

    const rateLimitWaiter = createSyncRateLimitWaiter(app, { egressKey: context.egressKey });
    const requestContext = {
      session: context.session,
      proxy: context.proxy,
      egressKey: context.egressKey,
      rateLimitWaiter,
    };

    const only = options.only?.trim().toLowerCase() ?? "";
    const routes = only
      ? ROUTES.filter((route) => route.key.toLowerCase().includes(only))
      : ROUTES;
    if (routes.length === 0) {
      throw new Error(`--only "${options.only}" matches none of the ${ROUTES.length} probe routes`);
    }

    for (const route of routes) {
      const bare = route.isBare(options);
      const requestHeaders = redactedFanslyRequestHeaderPlan(
        context.session,
        route.pathname(options),
      );

      if (options.dryRun) {
        results.push({
          page: pageLabel,
          route: route.key,
          verdict: "skipped",
          httpStatus: null,
          errorCode: null,
          itemCount: null,
          shape: null,
          bare,
          wallClockMs: 0,
          message: "dry-run (not called)",
          requestHeaders,
        });
        continue;
      }

      if (route.requires === "postId" && !options.postId) {
        // The id is a path segment: there is no bare form of this call, and firing
        // it without one would probe a different route entirely.
        results.push({
          page: pageLabel,
          route: route.key,
          verdict: "skipped",
          httpStatus: null,
          errorCode: null,
          itemCount: null,
          shape: null,
          bare,
          wallClockMs: 0,
          message: "no --post <id> supplied; [E1] stays UNANSWERED",
          requestHeaders,
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        const { items, note } = await route.run(app, requestContext, options);
        results.push({
          page: pageLabel,
          route: route.key,
          verdict: "live",
          httpStatus: 200,
          errorCode: null,
          itemCount: countItems(items),
          ids: options.ids ? extractIds(items) : null,
          shape: describeShape(items),
          note: note ?? null,
          bare,
          wallClockMs: Date.now() - startedAt,
          message: null,
          requestHeaders,
        });
      } catch (error) {
        const classified = classify(error);
        results.push({
          page: pageLabel,
          route: route.key,
          verdict: classified.verdict,
          httpStatus: classified.httpStatus,
          errorCode: classified.errorCode,
          itemCount: null,
          shape: null,
          bare,
          wallClockMs: Date.now() - startedAt,
          message: classified.message,
          requestHeaders,
        });
      }
    }
  }

  return results;
}

/** Collapse the results into something an owner can read without a schema in hand. */
export function summarizeEndpointProbe(results: EndpointProbeResult[]): string {
  const lines: string[] = [];
  lines.push("VERDICT TABLE — fansly:endpoint-probe (WP-F9 liveness + [E1] + [F3] + [F1])");
  lines.push("page | route | verdict | http | code | items | bare | ms | note");
  for (const r of results) {
    lines.push(
      [
        r.page,
        r.route,
        r.verdict,
        r.httpStatus ?? "-",
        r.errorCode ?? "-",
        r.itemCount ?? "-",
        r.bare ? "bare" : "-",
        r.wallClockMs,
        r.message ?? "",
      ].join(" | "),
    );
  }

  const fired = results.filter((r) => r.verdict !== "skipped");
  const live = fired.filter((r) => r.verdict === "live");
  const authRejected = fired.filter((r) => r.verdict === "auth-rejected");

  lines.push("");
  lines.push(`Fired: ${fired.length}. Live: ${live.length}. Skipped: ${results.length - fired.length}.`);

  lines.push("");
  lines.push("REQUEST HEADERS (secret values redacted; order is adapter insertion order):");
  for (const result of results) {
    const check = result.requestHeaders.clientCheck;
    lines.push(
      `${result.page} · ${result.route} · client-check route=${check.route ?? "unclassified"}`
      + ` state=${check.state}`,
    );
    for (const header of result.requestHeaders.headers) {
      lines.push(`  ${header.name}: ${header.value}`);
    }
    if (check.state !== "present") {
      lines.push("  fansly-client-check: <not sent — no captured check for this route>");
    }
  }

  if (authRejected.length > 0) {
    // An auth rejection judges the SESSION, not the route — reporting these as
    // "route dead" is exactly the absence-rule mistake this project keeps making.
    lines.push(
      `→ ${authRejected.length} call(s) were AUTH-rejected (401/403). Those routes are UNJUDGED: ` +
        "the session was refused before the route was reached. Re-run with a valid session " +
        "before recording any of them as dead.",
    );
  }

  const e1 = results.find((r) => r.route.startsWith("[E1]"));
  if (e1) {
    if (e1.verdict === "live") {
      lines.push(
        `→ [E1] PASSES: the bare GET works without \`POST /postreply/verify\` ` +
          `(${e1.itemCount ?? "?"} item(s)). WP-F5 proceeds.`,
      );
    } else if (e1.verdict === "skipped") {
      lines.push(
        e1.message?.startsWith("dry-run")
          ? "→ [E1] not attempted (dry run)."
          : "→ [E1] NOT ANSWERED — supply --post <id> for a post with a known reply.",
      );
    } else if (e1.verdict === "auth-rejected") {
      lines.push("→ [E1] UNJUDGED — the session was rejected, not the route. Re-run.");
    } else {
      lines.push(
        `→ [E1] FAILS (${e1.verdict}, http ${e1.httpStatus ?? "-"}). The bare GET does not work, ` +
          "so the comment archive (WP-F5) cannot be built on it. Tell the owner before designing " +
          "anything further; do NOT work around it by issuing the verify POST — that POST is on " +
          "the no-mutations exclusion list.",
      );
    }
  }

  const shaped = results.filter((r) => r.shape);
  if (shaped.length > 0) {
    lines.push("");
    lines.push("RESPONSE SHAPES (key names and value types only — no values):");
    for (const r of shaped) {
      lines.push(`${r.route}`);
      lines.push(`  ${r.shape}`);
      if (r.note) {
        lines.push(`  ${r.note}`);
      }
    }
  }

  const f1 = results.find((r) => r.route.startsWith("[F1]"));
  if (f1?.note) {
    lines.push("");
    lines.push(`→ [F1] ${f1.note}`);
  }

  lines.push("");
  lines.push(
    "→ Reminder: a route that answered ONCE is live, not understood. One response is one " +
      "example — optional fields and alternate variants are not visible here.",
  );

  return lines.join("\n");
}
