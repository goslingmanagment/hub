import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import { listSyncPages, type SyncRegistryOverride, type SyncRegistryTierOverride } from "@agency_hub_core/db";

import { createSyncContext, type SyncContext } from "./context.ts";
import { createFanslyRegistry } from "./fansly/registry.ts";
import {
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

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
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
  const page = sync.command("page").description("Fansly Sync Engine: one page's mode, pauses, overrides and status");

  page
    .command("mode")
    .description("move a page between off and shadow (handover and live only through `sync switch`, step 3)")
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
    .description("one admitted read of a wire route for a page, journaled under its kind (shadow: simulated)")
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
          + `${queued.shadow ? " (shadow: simulated, nothing is sent)" : ""}; result: sync why --page ${options.page} --resource probe.manual --subject ''`);
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

  const ownership = sync.command("ownership").description("Fansly Sync Engine page ownership");

  ownership
    .command("status")
    .description("each page's owner generation, process, heartbeat, release and stop confirmation")
    .action(async () => {
      await withContext(deps, async ({ db }) => {
        const rows = await listSyncPages(db);
        deps.print(["page", "mode", "generation", "owner", "acquired_at", "heartbeat_at", "released", "stop_confirmed_at"].join("\t"));
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
    .action(async (options: { runningHosts: string; page?: string; acquiredBefore?: Date; dryRun: boolean }) => {
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
      });
    });
}
