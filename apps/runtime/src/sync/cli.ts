import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import {
  listSyncPages,
  pageBrowserEnvOf,
  type PageBrowserEnv,
  type SyncRegistryOverride,
  type SyncRegistryTierOverride,
} from "@agency_hub_core/db";
import { isIndefinite } from "@agency_hub_core/shared";

import { createSyncContext, type SyncContext } from "./context.ts";
import { OWNER_HEARTBEAT_FRESH_MS, ownerRunState, type OwnerRunState, type SyncPageModeView } from "./engine/status.ts";
import { createFanslyRegistry } from "./fansly/registry.ts";
import {
  awaitBrowserHandovers,
  BROWSER_HANDOVER_WAIT_MS,
  changeSyncPageModeByOwner,
  changeSyncPagePause,
  changeSyncRegistryOverride,
  confirmStoppedSyncOwners,
  enqueueOwnerSyncWork,
  explainSyncWork,
  findSyncPageByLabel,
  listSyncPageWork,
  OWNER_PAGE_MODES,
  ownerEnqueueKeys,
  readSyncPageStatuses,
  requestSyncProbe,
  requeueSyncWork,
} from "./inspect.ts";
import { registerSyncBrowserProfileCommands } from "./browser-profile-cli.ts";
import {
  askPageBrowserSelfTest,
  awaitPageBrowserCommand,
  drainPageBrowser,
  pinPageBrowser,
  readPageBrowserStatusesByLabel,
  startPageBrowser,
  stopPageBrowsers,
  SYNC_BROWSER_COMMAND_TTL_MS,
} from "./browser-levers.ts";
import { changeSyncPageTransport } from "./page-transport.ts";
import { raiseSyncRoute } from "./route-raise.ts";

// The owner's CLI of the Fansly Sync Engine (design §7.6), under `pnpm cli
// sync …`. `sync status` stays the legacy sync monitor until step 4, so the
// engine's page status is `sync page status`.

export interface SyncCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "rawConfig" | "close">>;
  print(line: string): void;
}

const defaultDeps: SyncCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
};

/** JSON for the terminal: a bigint as its digits, and an instant no clock
 *  reaches — the end of a hold only new credentials lift — as `"infinity"`,
 *  the word `sync page status` uses for it (`Date#toISOString` writes it as
 *  the year 275760). */
function json(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    // A Date reaches the replacer already serialised: read it off its holder.
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Date && isIndefinite(raw)) return "infinity";
    return typeof item === "bigint" ? item.toString() : item;
  }, 2);
}

const SECOND_MS = 1_000;

/** Whether an owner runs the page, as `sync ownership status` concludes it:
 *  a heartbeat alone says nothing — it may be an hour old, or of an owner
 *  that released the page. */
function ownerRunsText(state: OwnerRunState, mode: SyncPageModeView): string {
  if (state.running) return "yes";
  switch (state.why) {
    case "mode":
      return `no: the page is ${mode} (no actor runs it)`;
    case "never_owned":
      return "no: no host has taken the page";
    case "released":
      return "no: its owner released it";
    case "heartbeat_stale":
      // Whole seconds, rounded down: an age is never overstated.
      return `no: the heartbeat is ${Math.floor(state.heartbeatAgeMs / SECOND_MS)} s old `
        + `(an owner beats every 10 s; fresh within ${OWNER_HEARTBEAT_FRESH_MS / SECOND_MS} s)`;
  }
}

function parsePositiveMs(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`Expected a positive integer of milliseconds, received "${value}"`);
  }
  return parsed;
}

function parseInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`Expected an ISO timestamp, received "${value}"`);
  return parsed;
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(`Expected a JSON object, received "${value}"`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidArgumentError(`Expected a JSON object, received "${value}"`);
  }
  return parsed as Record<string, unknown>;
}

/** `--tiers`: the age tiers as the registry writes them, e.g.
 *  `[{"maxAgeDays":30,"everyMs":86400000},…,{"maxAgeDays":null,"everyMs":2592000000}]`. */
function parseTiers(value: string): SyncRegistryTierOverride[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(`Expected a JSON list of {maxAgeDays, everyMs}, received "${value}"`);
  }
  const tiers = Array.isArray(parsed) ? parsed : [];
  const valid = tiers.length > 0 && tiers.every((tier: unknown) => {
    const record = typeof tier === "object" && tier !== null && !Array.isArray(tier) ? tier as Record<string, unknown> : null;
    return record !== null && Object.keys(record).every((key) => key === "maxAgeDays" || key === "everyMs")
      && typeof record.everyMs === "number" && (record.maxAgeDays === null || typeof record.maxAgeDays === "number");
  });
  if (!valid) throw new InvalidArgumentError(`Expected a JSON list of {maxAgeDays, everyMs}, received "${value}"`);
  return tiers as SyncRegistryTierOverride[];
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseWorkId(value: string, previous: number[] = []): number[] {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`Expected a work id (a positive integer), received "${value}"`);
  }
  return [...previous, parsed];
}

/** `--to`: a route's rate, requests a minute (a slowdown may be fractional). */
function parseRatePerMin(value: string): number {
  const parsed = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number.isFinite(parsed) && parsed > 0)) {
    throw new InvalidArgumentError(`Expected a rate in requests a minute (e.g. 8 or 8.5), received "${value}"`);
  }
  return parsed;
}

function parseRevision(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`Expected a route state revision (a whole number), received "${value}"`);
  }
  return parsed;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > 1_000) {
    throw new InvalidArgumentError(`Expected a limit between 1 and 1000, received "${value}"`);
  }
  return parsed;
}

const WORK_STATES = ["open", "running", "quarantined", "done", "cancelled", "superseded"] as const;

function parseWorkState(value: string): (typeof WORK_STATES)[number] {
  if (!(WORK_STATES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Expected one of ${WORK_STATES.join(", ")}, received "${value}"`);
  }
  return value as (typeof WORK_STATES)[number];
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

async function withContext<T>(deps: SyncCliDeps, body: (ctx: Pick<SyncContext, "db" | "rawConfig">) => Promise<T>): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

/** A standalone `sync` group with only the engine's commands; errors throw
 *  instead of exiting (tests and tools). */
export function buildSyncEngineCommandGroup(deps: SyncCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  registerSyncEngineCommands(sync, deps);
  for (const command of sync.commands) {
    command.exitOverride();
    for (const sub of command.commands) sub.exitOverride();
  }
  return sync;
}

/** Add the engine's commands to the `sync` command group. */
export function registerSyncEngineCommands(sync: Command, deps: SyncCliDeps = defaultDeps): void {
  // Project Browser PR 16: the page browsers' profiles (add-profile, remove-profile).
  registerSyncBrowserProfileCommands(sync, deps);

  const page = sync.command("page").description("Fansly Sync Engine: one page's mode, pauses, overrides and status");

  page
    .command("mode")
    .description("take a page left in shadow to off (no lever reaches shadow, handover or live: a page is born live at onboarding)")
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--to <mode>", `one of ${OWNER_PAGE_MODES.join(", ")}`)
    .option("--note <text>", "why (stored with the change)")
    .action(async (options: { page: string; to: string; note?: string }) => {
      await withContext(deps, async ({ db }) => {
        const changedBy = options.note === undefined ? cliActor() : `${cliActor()}: ${options.note}`;
        const result = await changeSyncPageModeByOwner(db, { pageLabel: options.page, to: options.to, changedBy });
        if (result.kind === "refused") {
          throw new Error(`sync page mode refused (${result.reason}): ${result.from ?? "?"} → ${result.to}`);
        }
        deps.print(result.kind === "changed"
          ? `${options.page}: ${result.from} → ${result.to} (the sync host follows within 2 s)`
          : `${options.page}: already ${result.mode}`);
      });
    });

  page
    .command("transport")
    .description(
      "which sender a page's requests leave through: node (undici, every page's default) or browser (its own browser); "
      + "--prepare readies a browser page's way back to node through the owner's session (audited)",
    )
    .argument("<page>", "the Fansly page")
    .argument("<transport>", "node or browser")
    .option("--prepare", "with node: the page waits under a credentials hold for the owner's session, checked through Node", false)
    .option(
      "--browser-stopped",
      "with node: the page's browser container is stopped (its leave is confirmed without its operator; its buffer is marked not drained)",
      false,
    )
    .option("--note <text>", "why (stored with the audit row)")
    .action(async (pageLabel: string, transport: string, options: { prepare: boolean; browserStopped: boolean; note?: string }) => {
      await withContext(deps, async ({ db }) => {
        const result = await changeSyncPageTransport(db, {
          pageLabel,
          to: transport,
          prepare: options.prepare,
          browserStopped: options.browserStopped,
          actor: cliActor(),
          ...(options.note === undefined ? {} : { note: options.note }),
        });
        deps.print(json({
          ...result,
          follows: result.pendingLeave !== null
            ? "the sync host stops the page's browser, takes what it kept, then Node takes the page"
            : "the sync host takes the page again within 2 s, after the request in flight",
        }));
      });
    });

  for (const action of ["pause", "resume"] as const) {
    page
      .command(action)
      .description(action === "pause"
        ? "pause a page: all of it, its history requests, or resources"
        : "resume what `sync page pause` paused")
      .requiredOption("--page <label>", "the Fansly page")
      .option("--all", "the whole page", false)
      .option("--requests", "the history requests class", false)
      .option("--resource <key>", "a registry key, e.g. media-stats.walk (repeatable)", collect, [])
      .option("--note <text>", "why")
      .action(async (options: { page: string; all: boolean; requests: boolean; resource: string[]; note?: string }) => {
        await withContext(deps, async ({ db }) => {
          const updated = await changeSyncPagePause(db, createFanslyRegistry(), {
            pageLabel: options.page,
            action,
            all: options.all,
            requests: options.requests,
            resources: options.resource,
            ...(options.note === undefined ? {} : { note: options.note }),
          });
          deps.print(json({
            page: updated.pageLabel,
            pausedAll: updated.pausedAll,
            pausedRequests: updated.pausedRequests,
            pausedResources: updated.pausedResources,
            note: updated.pauseNote,
          }));
        });
      });
  }

  page
    .command("override")
    .description("a page's frequency of one registry key (a poll's period, the vault walk's periods, the media-stats tiers), switch it off, or clear the override")
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--resource <key>", "the registry key")
    .option("--period-ms <n>", "the poll period, or a cadence walk's incremental period (catalog.vault)", parsePositiveMs)
    .option("--full-period-ms <n>", "a cadence walk's full-sweep period (catalog.vault)", parsePositiveMs)
    .option("--tiers <json>", "a tiered walk's age tiers (media-stats.walk), as the registry lists them", parseTiers)
    .option("--disable", "stop this key on this page", false)
    .option("--clear", "back to the registry's value", false)
    .option("--owner-approved", "the owner approved a change of an owner-protected key (decision №6)", false)
    .action(async (options: {
      page: string;
      resource: string;
      periodMs?: number;
      fullPeriodMs?: number;
      tiers?: SyncRegistryTierOverride[];
      disable: boolean;
      clear: boolean;
      ownerApproved: boolean;
    }) => {
      const periods = options.periodMs !== undefined || options.fullPeriodMs !== undefined;
      const chosen = [periods, options.tiers !== undefined, options.disable, options.clear].filter(Boolean).length;
      if (chosen !== 1) throw new Error("override takes exactly one of --period-ms/--full-period-ms, --tiers, --disable, --clear");
      const override: SyncRegistryOverride | null = options.clear
        ? null
        : options.disable
          ? { enabled: false as const }
          : options.tiers !== undefined
            ? { tiers: options.tiers }
            : options.periodMs !== undefined
              ? { everyMs: options.periodMs, ...(options.fullPeriodMs === undefined ? {} : { fullEveryMs: options.fullPeriodMs }) }
              : { fullEveryMs: options.fullPeriodMs! };
      await withContext(deps, async ({ db }) => {
        await changeSyncRegistryOverride(db, createFanslyRegistry(), {
          pageLabel: options.page,
          resource: options.resource,
          override,
          ownerApproved: options.ownerApproved,
        });
        deps.print(`${options.page}: ${options.resource} ${override === null ? "override cleared" : json(override)}`);
      });
    });

  page
    .command("status")
    .description("the engine's page status: owner, pause, sends by class, queue by reason, holds (JSON)")
    .option("--page <label>", "one Fansly page (default: every page)")
    .action(async (options: { page?: string }) => {
      await withContext(deps, async ({ db, rawConfig }) => {
        const pages = options.page === undefined
          ? await listSyncPages(db)
          : [await findSyncPageByLabel(db, options.page)];
        deps.print(json(await readSyncPageStatuses(db, rawConfig, pages)));
      });
    });

  sync
    .command("why")
    .description("why a page's work of one resource (and subject) is waiting (JSON)")
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--resource <key>", "the registry key")
    .option("--subject <subject>", "a chat, fan, media … id")
    .action(async (options: { page: string; resource: string; subject?: string }) => {
      await withContext(deps, async ({ db, rawConfig }) => {
        const row = await findSyncPageByLabel(db, options.page);
        deps.print(json(await explainSyncWork(db, rawConfig, row, {
          resource: options.resource,
          ...(options.subject === undefined ? {} : { subject: options.subject }),
        })));
      });
    });

  sync
    .command("probe")
    .description("one admitted read of a wire route for a page, journaled under its kind")
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--operation <wire id>", "a wire route, e.g. account.me or media.offer_stats")
    .option("--params <json>", "the route's parameters as a JSON object", parseJsonObject, {})
    .action(async (options: { page: string; operation: string; params: Record<string, unknown> }) => {
      await withContext(deps, async ({ db }) => {
        const queued = await requestSyncProbe(db, createFanslyRegistry(), {
          pageLabel: options.page,
          operation: options.operation,
          params: options.params,
          requestedBy: cliActor(),
        });
        deps.print(`${options.page}: probe ${options.operation} queued as work ${queued.workId}`
          + `; result: sync why --page ${options.page} --resource probe.manual --subject ''`);
      });
    });

  const work = sync.command("work").description("Fansly Sync Engine: a page's work rows, the quarantine lever and owner work");

  work
    .command("list")
    .description("a page's work rows in the journal it runs, newest first, each with why it waits and what a quarantine recorded (JSON)")
    .requiredOption("--page <label>", "the Fansly page")
    .option("--state <state>", `one of ${WORK_STATES.join(", ")}`, parseWorkState)
    .option("--resource <key>", "a registry key")
    .option("--limit <n>", "at most this many rows (default 50)", parseLimit, 50)
    .action(async (options: { page: string; state?: (typeof WORK_STATES)[number]; resource?: string; limit: number }) => {
      await withContext(deps, async ({ db, rawConfig }) => {
        const row = await findSyncPageByLabel(db, options.page);
        deps.print(json(await listSyncPageWork(db, rawConfig, row, {
          ...(options.state === undefined ? {} : { state: options.state }),
          ...(options.resource === undefined ? {} : { resource: options.resource }),
          limit: options.limit,
          offset: 0,
        })));
      });
    });

  work
    .command("requeue")
    .description(
      "take quarantined work out of quarantine: a captured answer re-applies from the journal (no request), "
      + "other rows run again; --work <id> (repeatable) or --quarantined [--resource <key>]",
    )
    .requiredOption("--page <label>", "the Fansly page")
    .option("--work <id>", "a quarantined work row (repeatable)", parseWorkId, [])
    .option("--quarantined", "every quarantined row of the page's journal", false)
    .option("--resource <key>", "with --quarantined: only this registry key (repeatable)", collect, [])
    .option("--note <text>", "why (stored with the audit row)")
    .action(async (options: { page: string; work: number[]; quarantined: boolean; resource: string[]; note?: string }) => {
      if ((options.work.length > 0) === options.quarantined) {
        throw new Error("requeue takes exactly one of --work <id> or --quarantined");
      }
      if (options.resource.length > 0 && !options.quarantined) throw new Error("--resource goes with --quarantined");
      await withContext(deps, async ({ db }) => {
        const requeued = await requeueSyncWork(db, {
          pageLabel: options.page,
          ...(options.work.length > 0 ? { workIds: options.work } : { resources: options.resource }),
          actor: cliActor(),
          ...(options.note === undefined ? {} : { note: options.note }),
        });
        deps.print(json({
          page: options.page,
          requeued: requeued.map((row) => ({
            work: row.id,
            resource: row.resource,
            subject: row.subject,
            via: row.reapplyAttemptId === null ? "run_again" : `reapply_attempt_${row.reapplyAttemptId}`,
          })),
        }));
      });
    });

  work
    .command("enqueue")
    .description(`the owner's own demand for a registry key of a live page (one of ${ownerEnqueueKeys().join(", ")})`)
    .requiredOption("--page <label>", "the Fansly page (live)")
    .requiredOption("--resource <key>", "the registry key")
    .option("--subject <subject>", "a chat, fan, media … id (default: the page)")
    .option("--params <json>", "the work's parameters as a JSON object", parseJsonObject)
    .option("--note <text>", "why (stored with the audit row)")
    .action(async (options: { page: string; resource: string; subject?: string; params?: Record<string, unknown>; note?: string }) => {
      await withContext(deps, async ({ db }) => {
        const queued = await enqueueOwnerSyncWork(db, createFanslyRegistry(), {
          pageLabel: options.page,
          resource: options.resource,
          ...(options.subject === undefined ? {} : { subject: options.subject }),
          ...(options.params === undefined ? {} : { params: options.params }),
          actor: cliActor(),
          ...(options.note === undefined ? {} : { note: options.note }),
        });
        deps.print(`${options.page}: ${options.resource} ${queued.created ? "queued as work" : "merged into open work"} ${queued.workId}`
          + `; follow it: sync why --page ${options.page} --resource ${options.resource}`
          + `${options.subject === undefined ? "" : ` --subject ${options.subject}`}`);
      });
    });

  const route = sync.command("route").description("Fansly Sync Engine: a page's route after a 429 (step 3b A2)");

  route
    .command("raise")
    .description(
      "raise a page+route's slowdown one step: at most +1/min, never above the route's current budget, against the "
      + "route state revision the evidence (budgets-calibration.sql) was read at; a hold in force stays (JSON, audited)",
    )
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--route <route>", "the canonical route, e.g. messaging.groups or media.offer_stats")
    .requiredOption("--to <rate>", "the new rate, requests a minute", parseRatePerMin)
    .requiredOption("--revision <n>", "the route's revision in the evidence (`sync page status` routes[].revision)", parseRevision)
    .requiredOption("--evidence <text>", "the report the step rests on (stored with the audit row)")
    .action(async (options: { page: string; route: string; to: number; revision: number; evidence: string }) => {
      await withContext(deps, async ({ db }) => {
        deps.print(json(await raiseSyncRoute(db, {
          pageLabel: options.page,
          route: options.route,
          toPerMin: options.to,
          revision: options.revision,
          evidence: options.evidence,
          actor: cliActor(),
        })));
      });
    });

  registerSyncBrowserCommands(sync, deps);

  const ownership = sync.command("ownership").description("Fansly Sync Engine page ownership");

  ownership
    .command("status")
    .description(
      "each page's owner generation, process, heartbeat, release and stop confirmation, "
      + "and whether that owner runs the page now (`runs`)",
    )
    .action(async () => {
      await withContext(deps, async ({ db }) => {
        const rows = await listSyncPages(db);
        deps.print(
          ["page", "mode", "generation", "owner", "acquired_at", "heartbeat_at", "released", "stop_confirmed_at", "runs"].join("\t"),
        );
        for (const row of rows) {
          const owner = row.owner;
          deps.print([
            row.pageLabel ?? String(row.pageId),
            row.mode,
            owner.generation.toString(),
            owner.host === null ? "" : `${owner.host} pid ${owner.pid ?? "?"}`,
            owner.acquiredAt?.toISOString() ?? "",
            owner.heartbeatAt?.toISOString() ?? "",
            owner.releasedAt !== null && owner.releaseGeneration === owner.generation ? owner.releasedAt.toISOString() : "",
            owner.stopConfirmedAt?.toISOString() ?? "",
            ownerRunsText(ownerRunState(row, row.dbNow), row.mode),
          ].join("\t"));
        }
      });
    });

  ownership
    .command("confirm-stopped")
    .description(
      "confirm that page owners whose host is not among the running sync containers are stopped "
      + "(Docker-level confirmation, rule (e)); the deploy runs it after recreating sync",
    )
    .requiredOption("--running-hosts <hosts>", "comma-separated hostnames of the running sync containers")
    .option("--page <label>", "only this page")
    .option(
      "--acquired-before <iso>",
      "only owners that acquired their page before this instant (take it right before listing the hostnames)",
      parseInstant,
    )
    .option("--dry-run", "list what would be confirmed without writing", false)
    .option(
      "--quiesced-wait-ms <ms>",
      `then wait this long for every live browser page's operator to say its previous owner's work is over (default ${BROWSER_HANDOVER_WAIT_MS})`,
      parsePositiveMs,
    )
    .action(async (options: { runningHosts: string; page?: string; acquiredBefore?: Date; dryRun: boolean; quiescedWaitMs?: number }) => {
      await withContext(deps, async ({ db }) => {
        const rows = await confirmStoppedSyncOwners(db, {
          runningHosts: options.runningHosts.split(",").map((host) => host.trim()).filter(Boolean),
          ownHost: hostname(),
          confirmedBy: cliActor(),
          dryRun: options.dryRun,
          acquiredBefore: options.acquiredBefore ?? null,
          ...(options.page === undefined ? {} : { pageLabel: options.page }),
        });
        deps.print(["page", "generation", "owner_host", options.dryRun ? "would_confirm" : "confirmed"].join("\t"));
        for (const row of rows) {
          deps.print([row.pageLabel ?? String(row.pageId), row.generation.toString(), row.ownerHost ?? "", String(options.dryRun ? true : row.confirmed)].join("\t"));
        }
        if (options.dryRun) return;
        // Plan §4.7: a browser page's hand-over ends with its operator's
        // quiesced. Pages on node: nothing to wait for, nothing printed.
        const browsers = await awaitBrowserHandovers(db, {
          waitMs: options.quiescedWaitMs ?? BROWSER_HANDOVER_WAIT_MS,
          ...(options.page === undefined ? {} : { pageLabel: options.page }),
        });
        if (browsers.length === 0) return;
        deps.print(["browser_page", "owner_generation", "quiesced"].join("\t"));
        for (const row of browsers) {
          deps.print([row.pageLabel ?? String(row.pageId), row.ownerGeneration.toString(), String(row.quiesced)].join("\t"));
        }
      });
    });
}

/** `--env`: a browser's environment as the hello carries it, e.g.
 *  `{"timeZone":"Europe/Berlin","languages":["de-DE","de","en-US","en"],"geolocation":{"latitude":52.52,"longitude":13.4,"accuracyM":5000}}`. */
function parseBrowserEnv(value: string): PageBrowserEnv {
  const parsed = parseJsonObject(value);
  const env = pageBrowserEnvOf(parsed);
  if (env === null) {
    throw new InvalidArgumentError(
      "Expected {timeZone, languages: [...], geolocation: {latitude, longitude, accuracyM}} as JSON",
    );
  }
  return env;
}

/** How long a lever waits for the engine to carry it out, by default. */
const BROWSER_WAIT_MS = 30_000;

/**
 * `pnpm cli sync browser …` (Project Browser plan §4.11; PR 17): a page's
 * browser as the engine sees it, and the owner's levers on it — each audited,
 * carried out by the engine that owns the page over its link to the operator.
 */
function registerSyncBrowserCommands(sync: Command, deps: SyncCliDeps): void {
  const browser = sync.command("browser").description("Project Browser: a page's browser — its state, the owner's stop and start, its self-test, its pinned exit IP");

  browser
    .command("status")
    .description("the browser of a page (or of every page with one): its state, link, login, exit IP, buffer, delivery, versions, self-test, alarm and alerts (JSON)")
    .option("--page <label>", "one Fansly page (default: every page with a browser)")
    .action(async (options: { page?: string }) => {
      await withContext(deps, async ({ db }) => {
        deps.print(json(await readPageBrowserStatusesByLabel(db, options.page === undefined ? {} : { pageLabel: options.page })));
      });
    });

  browser
    .command("stop")
    .description("stop a page's browser now (or --all): the engine pauses the page, the operator closes its exit and stops Chrome; kept until `start` (audited)")
    .argument("[page]", "the Fansly page")
    .option("--all", "every page with a browser", false)
    .option("--note <text>", "why (stored with the audit row)")
    .option("--wait-ms <ms>", `how long to wait for each operator's answer to the stop — once Chrome is down (default ${BROWSER_WAIT_MS})`, parsePositiveMs)
    .action(async (pageLabel: string | undefined, options: { all: boolean; note?: string; waitMs?: number }) => {
      await withContext(deps, async ({ db }) => {
        const stopped = await stopPageBrowsers(db, {
          ...(pageLabel === undefined ? {} : { pageLabel }),
          all: options.all,
          actor: cliActor(),
          ...(options.note === undefined ? {} : { note: options.note }),
        });
        // Every page's operator at once (`--all`): the waits overlap. A stop
        // is confirmed by the operator's answer to its own request, which
        // comes once Chrome is down.
        const confirmed = await Promise.all(stopped.map(async (entry) => {
          const ran = await awaitPageBrowserCommand(db, entry.command.id, { waitMs: options.waitMs ?? BROWSER_WAIT_MS });
          return { ...entry, operatorConfirmed: ran?.ok === true, confirmation: ran?.detail ?? null };
        }));
        deps.print(json({
          stopped: confirmed,
          follows: "the page is paused at once; its owner tells the operator to close the exit and stop Chrome. "
            + "operatorConfirmed=false: the operator has not answered this stop yet (no owner runs the page, its operator cannot be reached, "
            + "or Chrome did not go down) — the engine admits nothing of the page meanwhile",
        }));
      });
    });

  browser
    .command("start")
    .description("start a page's browser again: the owner's stop lifted (and the pause it put), the halt its operator holds for the owner's decision cleared by its id, the browser started (audited)")
    .argument("<page>", "the Fansly page")
    .option("--note <text>", "why (stored with the audit row)")
    .option("--wait-ms <ms>", `how long to wait for the engine to run it (default ${BROWSER_WAIT_MS})`, parsePositiveMs)
    .action(async (pageLabel: string, options: { note?: string; waitMs?: number }) => {
      await withContext(deps, async ({ db }) => {
        const asked = await startPageBrowser(db, { pageLabel, actor: cliActor(), ...(options.note === undefined ? {} : { note: options.note }) });
        const ran = await awaitPageBrowserCommand(db, asked.command.id, { waitMs: options.waitMs ?? SYNC_BROWSER_COMMAND_TTL_MS + 5_000 });
        deps.print(json({ ...asked, result: ran === null ? null : { outcome: ran.outcome, ok: ran.ok, detail: ran.detail, doneAt: ran.doneAt?.toISOString() ?? null } }));
      });
    });

  browser
    .command("selftest")
    .description("run the operator's self-test now (its exit closed for it, opened again after when it was open and the test passed; audited)")
    .argument("<page>", "the Fansly page")
    .option("--note <text>", "why (stored with the audit row)")
    .option("--wait-ms <ms>", `how long to wait for the result (default ${SYNC_BROWSER_COMMAND_TTL_MS + 30_000})`, parsePositiveMs)
    .action(async (pageLabel: string, options: { note?: string; waitMs?: number }) => {
      await withContext(deps, async ({ db }) => {
        const asked = await askPageBrowserSelfTest(db, { pageLabel, actor: cliActor(), ...(options.note === undefined ? {} : { note: options.note }) });
        const ran = await awaitPageBrowserCommand(db, asked.command.id, { waitMs: options.waitMs ?? SYNC_BROWSER_COMMAND_TTL_MS + 30_000 });
        deps.print(json({ ...asked, result: ran === null ? null : { outcome: ran.outcome, ok: ran.ok, detail: ran.detail, doneAt: ran.doneAt?.toISOString() ?? null } }));
      });
    });

  browser
    .command("snapshot")
    .description("ready a page's browser profile for a snapshot: the browser stopped (as `stop`) and confirmed stopped; the volume is packed by the host (audited)")
    .argument("<page>", "the Fansly page")
    .option("--note <text>", "why (stored with the audit row)")
    .option("--wait-ms <ms>", `how long to wait for the operator to say it stopped (default ${BROWSER_WAIT_MS})`, parsePositiveMs)
    .action(async (pageLabel: string, options: { note?: string; waitMs?: number }) => {
      await withContext(deps, async ({ db }) => {
        const [stopped] = await stopPageBrowsers(db, {
          pageLabel,
          actor: cliActor(),
          snapshot: true,
          ...(options.note === undefined ? {} : { note: options.note }),
        });
        // Quiet only once the operator answered this very stop — after
        // Chrome is down — under the page's owner that took it.
        const ran = await awaitPageBrowserCommand(db, stopped!.command.id, { waitMs: options.waitMs ?? BROWSER_WAIT_MS });
        const confirmed = ran?.ok === true;
        const [status] = await readPageBrowserStatusesByLabel(db, { pageLabel });
        const profileId = status!.browser.profileId;
        deps.print(json({
          ...stopped,
          operatorConfirmed: confirmed,
          confirmation: ran === null ? null : { outcome: ran.outcome, ok: ran.ok, detail: ran.detail, ownerGeneration: ran.takenGeneration, doneAt: ran.doneAt?.toISOString() ?? null },
          profileId,
          volumes: { profile: `pb-profile-${profileId}`, buffer: `pb-buffer-${profileId}` },
          follows: confirmed
            ? `the profile is quiet: the host packs pb-profile-${profileId} (Hub's containers have no Docker); then: sync browser start ${pageLabel}`
            : "the operator has not said it stopped: do not snapshot yet (sync browser status --page …)",
        }));
        if (!confirmed) throw new Error(`${pageLabel}: its operator has not said its browser stopped; no snapshot now`);
      });
    });

  browser
    .command("pin-ip")
    .description(
      "the exit IP the page's browser may open its exit through (after checking it: `pnpm cli page proxy-ip`), and its environment "
      + "by the proxy's region; until both are set the page cannot run on its browser (audited)",
    )
    .argument("<page>", "the Fansly page")
    .option("--ip <ip>", "the exit IP to pin")
    .option("--env <json>", "{timeZone, languages, geolocation: {latitude, longitude, accuracyM}}", parseBrowserEnv)
    .option("--note <text>", "why (stored with the audit row)")
    .action(async (pageLabel: string, options: { ip?: string; env?: PageBrowserEnv; note?: string }) => {
      await withContext(deps, async ({ db }) => {
        deps.print(json(await pinPageBrowser(db, {
          pageLabel,
          actor: cliActor(),
          ...(options.ip === undefined ? {} : { ip: options.ip }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.note === undefined ? {} : { note: options.note }),
        })));
      });
    });

  browser
    .command("drain")
    .description(
      "take what a stopped browser kept (its buffer marked not drained) while the page stays on Node: bring its container up first; "
      + "Node's slot ends, a leave takes the buffer with the browser kept stopped, then Node again (audited)",
    )
    .argument("<page>", "the Fansly page")
    .option("--note <text>", "why (stored with the audit row)")
    .action(async (pageLabel: string, options: { note?: string }) => {
      await withContext(deps, async ({ db }) => {
        deps.print(json({
          ...await drainPageBrowser(db, { pageLabel, actor: cliActor(), ...(options.note === undefined ? {} : { note: options.note }) }),
          follows: "the host ends Node's slot and takes the browser's buffer (alert 2 browser_leave_unconfirmed if its operator cannot be reached "
            + "for 2 min: then `sync page transport <page> node --browser-stopped` gives the page back to Node, the buffer still marked)",
        }));
      });
    });

  browser
    .command("log")
    .description("the browser's journals (requests, connections, states, sockets) live on the page's volume, out of Hub's reach: read them with the host script")
    .argument("<page>", "the Fansly page")
    .allowUnknownOption(true)
    .action((pageLabel: string) => {
      throw new Error(
        "the journals live on the page's buffer volume, which Hub's containers cannot read (they have no Docker): from the workstation, "
        + `scripts/deploy-page-browser.sh log <user@host> --page ${pageLabel} [--kind requests|connections|states|sockets] [--since <iso>] [--path <prefix>] [--method <M>]`,
      );
    });
}
