import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../bootstrap.ts";
import { resolvePageContext } from "./page-context.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";

// Liveness probe for the endpoints-cover initiative: WP-F9 (`dm_commerce`) + [E1].
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
  /**
   * Redacted structural skeleton of the response: key names and value TYPES only,
   * never values. This is what the next step (designing storage) actually needs,
   * and it is why the probe does not journal bodies — an owner-run diagnostic
   * should not put fan PII into a terminal or a transcript to learn a shape.
   */
  shape: string | null;
  wallClockMs: number;
  message: string | null;
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
}

type ProbeRoute = {
  key: string;
  /** True when the call cannot be made bare because an id is a path segment. */
  requires?: "postId";
  run: (
    app: AppContext,
    ctx: Parameters<AppContext["adapter"]["getPostRepliesPage"]>[0],
    options: EndpointProbeOptions,
  ) => Promise<{ items: unknown }>;
  isBare: (options: EndpointProbeOptions) => boolean;
};

/**
 * Order matters only for readability of the report. [E1] runs first because it is
 * the one whose answer can delete a slice of the plan.
 */
const ROUTES: ProbeRoute[] = [
  {
    key: "[E1] GET /post/{postId}/replies (BARE — no verify POST)",
    requires: "postId",
    run: (app, ctx, o) => app.adapter.getPostRepliesPage(ctx, { postId: o.postId as string }),
    isBare: () => true,
  },
  {
    key: "GET /groups/mediaoffers",
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
    run: (app, ctx) => app.adapter.getBroadcastStatsPage(ctx, { limit: 10 }),
    isBare: () => false,
  },
  {
    key: "GET /message/broadcast/stats/deleted",
    run: (app, ctx) => app.adapter.getBroadcastStatsPage(ctx, { limit: 10, deleted: true }),
    isBare: () => false,
  },
  {
    key: "GET /message/broadcast/scheduled",
    run: (app, ctx) => app.adapter.getBroadcastScheduled(ctx),
    isBare: () => false,
  },
  {
    key: "GET /account/media/orders",
    run: (app, ctx) => app.adapter.getAccountMediaOrdersPage(ctx, { limit: 10, offset: 0 }),
    isBare: () => false,
  },
  // `GET /tips` (by targetIds) is deliberately ABSENT: it is already wired and live
  // (`getTipsByTargetIds`, operation `post_tips` — 531 calls / 530 successes in the
  // 10 days to 2026-08-21). It sat on the WP-F9 list until the kernel was checked.
  {
    key: "GET /tips/account",
    run: (app, ctx, o) =>
      app.adapter.getTipsByAccountIds(ctx, { accountIds: o.fanAccountId ?? null }),
    isBare: (o) => !o.fanAccountId,
  },
  {
    key: "GET /mediastory/views",
    run: (app, ctx, o) =>
      app.adapter.getMediaStoryViewsPage(ctx, { storyId: o.storyId ?? "", limit: 10, offset: 0 }),
    isBare: (o) => !o.storyId,
  },
  {
    key: "GET /polls",
    run: (app, ctx) => app.adapter.getPolls(ctx),
    isBare: () => false,
  },
  {
    key: "GET /recapstats",
    run: (app, ctx) => app.adapter.getRecapStats(ctx),
    isBare: () => false,
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

    for (const route of ROUTES) {
      const bare = route.isBare(options);

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
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        const { items } = await route.run(app, requestContext, options);
        results.push({
          page: pageLabel,
          route: route.key,
          verdict: "live",
          httpStatus: 200,
          errorCode: null,
          itemCount: countItems(items),
          shape: describeShape(items),
          bare,
          wallClockMs: Date.now() - startedAt,
          message: null,
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
        });
      }
    }
  }

  return results;
}

/** Collapse the results into something an owner can read without a schema in hand. */
export function summarizeEndpointProbe(results: EndpointProbeResult[]): string {
  const lines: string[] = [];
  lines.push("VERDICT TABLE — fansly:endpoint-probe (WP-F9 liveness + [E1])");
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
    }
  }

  lines.push("");
  lines.push(
    "→ Reminder: a route that answered ONCE is live, not understood. One response is one " +
      "example — optional fields and alternate variants are not visible here.",
  );

  return lines.join("\n");
}
