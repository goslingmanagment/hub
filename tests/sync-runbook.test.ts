import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_ITEM_REFUSALS,
  HISTORY_ITEM_STATES,
  HISTORY_REQUEST_STATES,
  LIVE_SYNC_PAGE_REFUSALS,
  SYNC_ALERT_EVALUATION_RULES,
} from "@agency_hub_core/db";
import { FANSLY_PAUSE_MAX_MS, FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";

import type * as SyncContextModule from "../apps/runtime/src/sync/context.ts";

// `docs/runbooks/sync.md` is the one operator runbook of the Fansly Sync Engine
// (step 4, S4-25): it replaced seventeen `fansly-*.md` runbooks of a deleted
// engine. Prose drifts silently from the code it describes; these pins hold the
// two together where an operator would act on a wrong word:
//   - every `pnpm cli …` line of a code block parses through the real program
//     (`buildProgram`) up to the point where it opens its database context,
//     and the registry keys, routes and overrides it names are the registry's;
//   - the closed lists and ladders the runbook quotes are the code's;
//   - its links resolve, the files it names exist, and nothing the CI gate
//     observes points at a deleted runbook.
// Its SQL is run by tests/sync-runbook-sql.integration.test.ts.

/** What a mocked context factory throws: the command parsed and passed every
 *  check it makes before touching a database. */
const opened = vi.hoisted(() => {
  class Opened extends Error {}
  return { Opened };
});

vi.mock("../apps/runtime/src/sync/context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof SyncContextModule>()),
  createSyncContext: vi.fn(async () => {
    throw new opened.Opened("sync context");
  }),
}));

vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: vi.fn(async () => {
    throw new opened.Opened("app context");
  }),
}));

import { buildProgram } from "../apps/runtime/src/cli.ts";
import {
  SYNC_ENGINE_ALERT_SUBKEYS,
  SYNC_ENGINE_EVALUATOR_SUBKEY,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  SYNC_ENGINE_ROUTE_SUBKEY_PREFIX,
} from "../apps/runtime/src/services/notification-incidents.ts";
import {
  NETWORK_FAILURES_TO_PAUSE,
  NETWORK_PAUSE_LADDER_MS,
  RESOURCE_BREAKER_SUBJECTS,
  RESOURCE_HOLD_LADDER_MS,
  SUBJECT_BLOCK_AFTER,
  SUBJECT_BREAKER_LADDER_MS,
} from "../apps/runtime/src/sync/engine/errors.ts";
import { registryOverrideProblem, type RegistryOverride } from "../apps/runtime/src/sync/engine/resource.ts";
import { ROUTE_HOLD_LADDER_MS } from "../apps/runtime/src/sync/engine/route-holds.ts";
import { WAITING_REASONS } from "../apps/runtime/src/sync/engine/status.ts";
import { SYNC_STALL_AFTER_MS, SYNC_STALL_EXIT_CODE } from "../apps/runtime/src/sync/engine/watchdog.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyNewPageKeys } from "../apps/runtime/src/sync/fansly/registry.ts";
import { FANSLY_ROUTES, isFanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { ownerEnqueueKeys } from "../apps/runtime/src/sync/inspect.ts";

const ROOT = join(__dirname, "..");
const RUNBOOK_PATH = "docs/runbooks/sync.md";
const RUNBOOK = readFileSync(join(ROOT, RUNBOOK_PATH), "utf8");
/** The runbook as one line of prose: a re-wrapped paragraph reads the same. */
const PROSE = RUNBOOK.replace(/\s+/g, " ");

// ── reading the markdown ────────────────────────────────────────────────────

/** The lines of every fenced block of `language`, continuations joined. */
function fencedLines(markdown: string, language: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  let wanted = false;
  for (const rawLine of markdown.replace(/\\\n\s*/g, " ").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      wanted = !inFence && line === `\`\`\`${language}`;
      inFence = !inFence;
      continue;
    }
    if (inFence && wanted && line.length > 0) lines.push(line);
  }
  return lines;
}

/** A shell-ish tokenizer: enough for the quoting the runbook uses. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " ") {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** GitHub's anchor of a heading. */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

const HEADINGS = RUNBOOK.split("\n").filter((line) => /^#{1,3} /.test(line)).map((line) => line.replace(/^#+ /, ""));
const ANCHORS = new Set(HEADINGS.map(slug));

/** The text of one `##` section, its heading excluded. */
function section(heading: string): string {
  const start = RUNBOOK.indexOf(`\n## ${heading}\n`);
  expect(start, `no section "${heading}"`).toBeGreaterThanOrEqual(0);
  const body = RUNBOOK.slice(start + heading.length + 5);
  const end = body.search(/\n## /);
  return end === -1 ? body : body.slice(0, end);
}

/** The backticked words of the prose between `from` and `to`. */
function ticksBetween(from: string, to: string): string[] {
  const start = PROSE.indexOf(from);
  expect(start, `the runbook no longer says "${from}"`).toBeGreaterThanOrEqual(0);
  const rest = PROSE.slice(start + from.length);
  const end = rest.indexOf(to);
  expect(end, `no "${to}" after "${from}"`).toBeGreaterThanOrEqual(0);
  return [...rest.slice(0, end).matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

/** A duration as the runbook writes it. */
function human(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1_000} s`;
}

const ladder = (steps: readonly number[]): string => steps.map(human).join(" → ");

// ── the documented command lines ────────────────────────────────────────────

const COMMANDS = fencedLines(RUNBOOK, "sh").filter((line) => line.startsWith("pnpm cli "));
const REGISTRY = createFanslyRegistry();
const REGISTRY_KEYS = new Set(FANSLY_RESOURCE_SPECS.map((spec) => spec.key));

async function runDocumentedLine(command: string): Promise<unknown> {
  const program = buildProgram();
  const quiet = (node: typeof program) => {
    node.exitOverride();
    node.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    for (const child of node.commands) quiet(child);
  };
  quiet(program);
  return program.parseAsync(tokenize(command).slice(2), { from: "user" }).then(() => null, (error: unknown) => error);
}

/** The values a repeatable flag takes on one command line. */
function flagValues(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((token, index) => (token === flag && argv[index + 1] !== undefined ? [argv[index + 1]!] : []));
}

describe("the command lines of the sync runbook", () => {
  it("still teaches runnable commands", () => {
    // A rewrite that dropped the examples must not leave this file passing vacuously.
    expect(COMMANDS.length).toBeGreaterThanOrEqual(45);
    expect(COMMANDS.filter((line) => line.includes("<"))).toEqual([]);
  });

  it.each(COMMANDS)("%s", async (command) => {
    const error = await runDocumentedLine(command);
    // Anything else is the CLI refusing its own documented line: an unknown
    // command or flag, a missing required one, a value its parser rejects.
    expect(error, error instanceof Error ? error.message : String(error)).toBeInstanceOf(opened.Opened);

    const argv = tokenize(command).slice(2);
    const path = argv.slice(0, 3).join(" ");
    if (argv[0] !== "sync") return;
    const resources = flagValues(argv, "--resource");
    for (const key of resources) expect(REGISTRY_KEYS.has(key), `${key} is not a registry key`).toBe(true);
    for (const route of flagValues(argv, "--route")) expect(isFanslyRoute(route), `${route} is not a route`).toBe(true);
    for (const operation of flagValues(argv, "--operation")) {
      expect([...FANSLY_ROUTES.values()].some((route) => route.wire === operation), `${operation} is not a wire id`).toBe(true);
    }
    if (path === "sync work enqueue") {
      for (const key of resources) expect(ownerEnqueueKeys()).toContain(key);
    }
    if (path === "sync page override") {
      const spec = REGISTRY.spec(resources[0] ?? "");
      expect(spec).not.toBeNull();
      const period = flagValues(argv, "--period-ms")[0];
      const fullPeriod = flagValues(argv, "--full-period-ms")[0];
      const override: RegistryOverride | null = argv.includes("--clear")
        ? null
        : argv.includes("--disable")
          ? { enabled: false }
          : {
            ...(period === undefined ? {} : { everyMs: Number(period) }),
            ...(fullPeriod === undefined ? {} : { fullEveryMs: Number(fullPeriod) }),
          };
      if (override !== null) {
        expect(registryOverrideProblem(spec!, override)).toBeNull();
        // Owner decision №6: an economical key changes only with the owner's word.
        if (spec!.ownerProtected === true) expect(argv).toContain("--owner-approved");
      }
    }
  });
});

// ── the closed lists and ladders it quotes ──────────────────────────────────

describe("the sync runbook quotes the engine", () => {
  it("explains every waiting reason, and no other", () => {
    const table = RUNBOOK.slice(RUNBOOK.indexOf("### Why is this work waiting"), RUNBOOK.indexOf("## Pauses and frequency"));
    const reasons = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]!);
    expect([...reasons].sort()).toEqual([...WAITING_REASONS].sort());
  });

  it("names every alert latch", () => {
    const alerts = section("Alerts");
    for (const subKey of SYNC_ENGINE_ALERT_SUBKEYS) expect(alerts).toContain(`\`${subKey}\``);
    expect(alerts).toContain(`\`${SYNC_ENGINE_PACE_VIOLATION_SUBKEY}\``);
    expect(alerts).toContain(`\`${SYNC_ENGINE_ROUTE_SUBKEY_PREFIX}<route>\``);
    expect(alerts).toContain(`\`${SYNC_ENGINE_EVALUATOR_SUBKEY}\` (global)`);
    // Its check reads the evaluator's own vocabulary.
    expect(RUNBOOK).toContain(`unnest(array[${SYNC_ALERT_EVALUATION_RULES.map((rule) => `'${rule}'`).join(",")}])`);
  });

  it("gives the ladders and thresholds of the error rules", () => {
    expect(PROSE).toContain(`${ROUTE_HOLD_LADDER_MS.map((ms) => ms / 1_000).join(" → ")} s plus up to 20 % jitter`);
    expect(PROSE).toContain(ladder(SUBJECT_BREAKER_LADDER_MS));
    expect(PROSE).toContain(ladder(RESOURCE_HOLD_LADDER_MS));
    expect(PROSE).toContain(ladder(NETWORK_PAUSE_LADDER_MS));
    expect(PROSE).toContain(`after ${SUBJECT_BLOCK_AFTER} failures it is \`blocked_by_vendor\``);
    expect(PROSE).toContain(`${RESOURCE_BREAKER_SUBJECTS} or more failing subjects of one resource file`);
    expect(PROSE).toContain(`${NETWORK_FAILURES_TO_PAUSE} transport failures or timeouts in a row`);
  });

  it("gives the owner's pause bounds and the watchdog's numbers", () => {
    expect(PROSE).toContain(`${FANSLY_PAUSE_MIN_MS}–${FANSLY_PAUSE_MAX_MS} ms`);
    expect(PROSE).toContain(`has not moved for ${SYNC_STALL_AFTER_MS / 1_000} s ends the process`);
    expect(PROSE).toContain(`\`process.exit(${SYNC_STALL_EXIT_CODE})\``);
  });

  it("lists the keys `sync work enqueue` takes", () => {
    expect(ticksBetween("The keys it takes:", "Old chat history")).toEqual(ownerEnqueueKeys());
  });

  it("lists the history walks a page's birth queues (`new_page`)", () => {
    expect(ticksBetween("The page's birth queued these history walks:", "Nothing else is walked at birth")).toEqual(fanslyNewPageKeys());
  });

  it("lists the owner-protected keys", () => {
    const protectedKeys = FANSLY_RESOURCE_SPECS.filter((spec) => spec.ownerProtected === true).map((spec) => spec.key);
    expect(ticksBetween("The economical keys of owner decision №6 (", ") refuse")).toEqual(protectedKeys);
  });

  it("lists why onboarding refuses a page", () => {
    expect(ticksBetween("for a page that is not new to Hub's sync:", "Later checks")).toEqual([...LIVE_SYNC_PAGE_REFUSALS]);
  });

  it("lists the states of a history request and of its fans", () => {
    expect(ticksBetween("or refuses it (", ")").sort()).toEqual([...HISTORY_ITEM_REFUSALS].sort());
    expect(ticksBetween("Fan states:", "Request states:").sort()).toEqual([...HISTORY_ITEM_STATES].sort());
    expect(ticksBetween("Request states:", "- The requests class").sort()).toEqual([...HISTORY_REQUEST_STATES].sort());
  });
});

// ── its structure, its links, and the runbooks it replaced ──────────────────

/** The seventeen runbooks of the legacy Fansly engine. */
const LEGACY_RUNBOOKS = [
  "dm-bounded", "dm-exclusion", "dm-head-catchup", "dm-reply-repair", "earnings-correctness", "earnings-shadow",
  "earnings-targets", "events-shadow", "followers-diagnostics", "post-tips-acceptance", "provider-cooldown",
  "tip-transaction-contexts-acceptance", "ws-capture", "ws-continuity", "ws-hints", "ws-protocol-check",
  "ws-reliability",
].map((name) => `fansly-${name}.md`);

describe("the sync runbook", () => {
  it("covers the engine's operations", () => {
    expect(HEADINGS).toEqual(expect.arrayContaining([
      "Status and why",
      "Pauses and frequency",
      "Holds, breakers and quarantine",
      "Route holds and sync route raise",
      "History requests",
      "Alerts",
      "The socket and its repair",
      "Onboarding a page",
      "Watchdog restarts, shutdown and deploys",
      "Calibration",
    ]));
    expect(new Set(HEADINGS.map(slug)).size).toBe(HEADINGS.length);
  });

  it("links only to its own headings", () => {
    const links = [...RUNBOOK.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThanOrEqual(10);
    expect(links.filter((anchor) => !ANCHORS.has(anchor))).toEqual([]);
  });

  it("is linked from the error registry by headings it has", () => {
    const registry = readFileSync(join(ROOT, "docs/error-handling.md"), "utf8");
    const links = [...registry.matchAll(/\]\(runbooks\/sync\.md#([^)]+)\)/g)].map((match) => match[1]!);
    expect(links).toHaveLength(3);
    expect(links.filter((anchor) => !ANCHORS.has(anchor))).toEqual([]);
  });

  it("names files that exist", () => {
    const paths = [...new Set([...RUNBOOK.matchAll(/`((?:apps|packages|docs|tests|scripts)\/[\w./-]+\.[a-z]+)`/g)].map((match) => match[1]!))];
    expect(paths.length).toBeGreaterThanOrEqual(10);
    expect(paths.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });

  it("is tracked: docs/runbooks is ignored but for the files named", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n")).toContain(`!${RUNBOOK_PATH}`);
  });

  it("says what became of each of the seventeen legacy runbooks", () => {
    const became = section("What the legacy runbooks became");
    expect(LEGACY_RUNBOOKS).toHaveLength(17);
    for (const name of LEGACY_RUNBOOKS) expect(became).toContain(`\`${name}\``);
  });

  it("is the only Fansly runbook left", () => {
    const runbooks = readdirSync(join(ROOT, "docs/runbooks"));
    expect(runbooks).toContain("sync.md");
    expect(runbooks.filter((name) => name.startsWith("fansly-"))).toEqual([]);
  });

  it("nothing the gate observes points at a deleted Fansly runbook", () => {
    // Spelled in halves, so this file is no hit of its own search.
    const gone = ["runbooks/", "fansly-"].join("");
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        [
          "-rlF", gone, "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.vite",
          "apps", "packages", "tests", "scripts", "docs/runbooks", "docs/error-handling.md", "docs/agent-read-skill.md",
          ".gitignore",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
    } catch {
      // grep exits 1 when nothing matches.
    }
    expect(hits.split("\n").filter(Boolean)).toEqual([]);
  });
});
