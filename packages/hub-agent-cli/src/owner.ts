import { OWNER_AGENT_OPERATION_NAMES, OWNER_AGENT_OPERATION_SCHEMAS, OWNER_AGENT_REASON_HEADER, OWNER_AGENT_REASON_MAX } from "@agency_hub_core/contracts";
import type { KernelClient } from "@kernel/sdk";

import { HubUsageError, type HubCommand, type HubOption, type HubOptionValues } from "./commands.ts";

/**
 * `hub owner …` — the owner's agent door (payouts plan 2026-11-24, §1.8): the owner's own agent acting AS the owner,
 * with the owner's reason on every call (`--why`, sent as `x-hub-owner-reason`). Its key is the owner's desk's
 * (`HUB_OWNER_KEY`, `~/.config/hub/owner-desk`; credentials.ts), never an agent's: no cron holds it. One route,
 * `ownerAgentCall`; `hub owner call <op> --json '{…}'` reaches every operation of the door's table, the commands below
 * are its common ones with flags. What the door does and refuses is the server's (services/owner-agent-door.ts).
 */

const WHY: Record<string, HubOption> = {
  why: { kind: "string", describe: `Why the owner asks for this, in a line (required, at most ${OWNER_AGENT_REASON_MAX} characters, no fan's name)` },
};

function text(values: HubOptionValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HubUsageError(`--${name} takes a single value`);
  return value;
}

function required(values: HubOptionValues, name: string): string {
  const value = text(values, name);
  if (value === undefined || value.trim() === "") throw new HubUsageError(`--${name} is required`);
  return value;
}

function id(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) throw new HubUsageError(`${name} is a positive whole number, got "${value ?? ""}"`);
  return parsed;
}

function list(values: HubOptionValues, name: string): string[] {
  const raw = values[name];
  return raw === undefined ? [] : (Array.isArray(raw) ? raw : [String(raw)]).flatMap((one) => one.split(",")).map((one) => one.trim()).filter((one) => one !== "");
}

/** The owner's reason as the header carries it: percent-encoded UTF-8 (a header holds no Cyrillic as it is). */
export function ownerReasonHeaders(values: HubOptionValues): Record<string, string> {
  const why = required(values, "why").trim();
  if ([...why].length > OWNER_AGENT_REASON_MAX) throw new HubUsageError(`--why is at most ${OWNER_AGENT_REASON_MAX} characters`);
  return { [OWNER_AGENT_REASON_HEADER]: encodeURIComponent(why) };
}

function jsonArgs(values: HubOptionValues): Record<string, unknown> {
  const raw = text(values, "json");
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HubUsageError("--json is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HubUsageError("--json is an object: the operation's arguments");
  return parsed as Record<string, unknown>;
}

const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

function call(client: KernelClient, op: string, args: Record<string, unknown>) {
  return client.ownerAgentCall({ body: { op, args } });
}

function command(input: Omit<HubCommand, "operation" | "profile"> & { op?: string }): HubCommand {
  const { op: _op, ...rest } = input;
  return { ...rest, operation: "ownerAgentCall", profile: "owner-desk", options: { ...WHY, ...input.options } };
}

/** The `--share anna:50` flags of a decision. */
function shares(values: HubOptionValues): Array<{ person: string; percent: number }> {
  return list(values, "share").map((one) => {
    const [person, percent] = one.split(":");
    const value = percent === undefined ? 100 : Number(percent);
    if (person === undefined || person.trim() === "" || !Number.isInteger(value)) throw new HubUsageError(`--share is <code>[:<percent>], got "${one}"`);
    return { person: person.trim(), percent: value };
  });
}

export const HUB_OWNER_COMMANDS: readonly HubCommand[] = [
  {
    name: "owner ops",
    operation: "ownerAgentCall",
    profile: "owner-desk",
    offline: true,
    summary: "The owner's agent door's operations (no call): each one's name, whether it writes, and its arguments.",
    options: {},
    run: async () => ({
      operations: OWNER_AGENT_OPERATION_NAMES.map((op) => {
        const schema = OWNER_AGENT_OPERATION_SCHEMAS[op];
        const shape = (schema.args as unknown as { shape?: Record<string, unknown>; _zod?: { def?: { in?: { shape?: Record<string, unknown> } } } });
        const fields = Object.keys(shape.shape ?? shape._zod?.def?.in?.shape ?? {});
        return { op, writes: schema.writes, args: fields };
      }),
    }),
  },
  command({
    name: "owner call",
    summary: "Run one operation of the owner's agent door as the owner (hub owner ops lists them): its arguments as JSON.",
    example: "hub owner call sale.show --json '{\"transactionId\":1234567}' --why \"проверяю спорную продажу\"",
    arguments: { name: "<op>", describe: "the operation, as hub owner ops names it", min: 1, max: 1 },
    options: { json: { kind: "string", describe: "The operation's arguments as a JSON object (default {})" } },
    run: (client, values, _deps, args) => call(client, args[0]!, jsonArgs(values)),
  }),
  command({
    name: "owner shift-report list",
    summary: "A person's shifts of a window with their stored reports (state, version, total): nothing recomputed.",
    example: "hub owner shift-report list --person anna --from 2026-11-01 --to 2026-11-07 --why \"сверяю неделю\"",
    options: {
      person: { kind: "string", describe: "The person's code (required)" },
      from: { kind: "string", describe: "First Moscow day ГГГГ-ММ-ДД (required)" },
      to: { kind: "string", describe: "Last Moscow day ГГГГ-ММ-ДД (required), at most 62 days in all" },
    },
    run: (client, values) => call(client, "shiftReport.list", { person: required(values, "person"), from: required(values, "from"), to: required(values, "to") }),
  }),
  command({
    name: "owner shift-report show",
    summary: "A shift's stored report whole: the newest version, or --version N; never a draft.",
    example: "hub owner shift-report show --shift 4321 --why \"смотрю отчёт\"",
    options: {
      shift: { kind: "number", describe: "The shift's id (required)" },
      version: { kind: "number", describe: "A version's number (default: the newest)" },
    },
    run: (client, values) => call(client, "shiftReport.show", defined({
      shiftId: id(text(values, "shift"), "--shift"),
      version: text(values, "version") === undefined ? undefined : id(text(values, "version"), "--version"),
    })),
  }),
  command({
    name: "owner shift-report versions",
    summary: "A shift's stored versions, newest first: who, when, total, why the system made it.",
    options: { shift: { kind: "number", describe: "The shift's id (required)" } },
    run: (client, values) => call(client, "shiftReport.versions", { shiftId: id(text(values, "shift"), "--shift") }),
  }),
  command({
    name: "owner sale show",
    summary: "A sale: whose it is by the rule, its decisions and claims, whether a dispute is open.",
    options: { sale: { kind: "number", describe: "The sale by Hub's id (required)" } },
    run: (client, values) => call(client, "sale.show", { transactionId: id(text(values, "sale"), "--sale") }),
  }),
  command({
    name: "owner sale decide",
    summary: "Decide whose a known sale is, as the owner: --kind owner (--share <code>), split (--share <code>:<percent>"
      + " twice or more), exclude (nobody's); with why (--note). A sale with an open dispute: decide it in Workboard."
      + " A sale with an active decision: --supersedes <its №>.",
    example: "hub owner sale decide --sale 1234567 --kind owner --share anna --note \"чат вела она\" --why \"слово владельца\"",
    options: {
      sale: { kind: "number", describe: "The sale by Hub's id (required)" },
      kind: { kind: "string", describe: "owner | split | exclude (required)" },
      share: { kind: "list", describe: "<code>[:<percent>], once per person" },
      note: { kind: "string", describe: "Why, in the owner's words (required)" },
      supersedes: { kind: "number", describe: "The sale's active decision it replaces" },
    },
    run: (client, values) => call(client, "sale.decide", defined({
      transactionId: id(text(values, "sale"), "--sale"),
      kind: required(values, "kind"),
      shares: shares(values),
      note: required(values, "note"),
      supersedes: text(values, "supersedes") === undefined ? undefined : id(text(values, "supersedes"), "--supersedes"),
    })),
  }),
  command({
    name: "owner sale cancel",
    summary: "Cancel an active decision, with why: the reports it settled get a new version with what rules now.",
    arguments: { name: "<decision №>", describe: "The decision's number", min: 1, max: 1 },
    options: { note: { kind: "string", describe: "Why (required)" } },
    run: (client, values, _deps, args) => call(client, "sale.cancel", { decisionId: id(args[0], "<decision №>"), note: required(values, "note") }),
  }),
  command({
    name: "owner sale close",
    summary: "Close an open sale question without a decision, with why.",
    arguments: { name: "<question №>", describe: "The question's number", min: 1, max: 1 },
    options: { note: { kind: "string", describe: "Why (required)" } },
    run: (client, values, _deps, args) => call(client, "sale.close", { questionId: id(args[0], "<question №>"), note: required(values, "note") }),
  }),
  command({
    name: "owner people show",
    summary: "A person: who, logins, pages, schedule, rights, onboarding, the owner's note. Never pay terms or payout details.",
    arguments: { name: "<code>", describe: "The person's code", min: 1, max: 1 },
    options: {},
    run: (client, _values, _deps, args) => call(client, "people.show", { code: args[0]! }),
  }),
  command({
    name: "owner people edit",
    summary: "Change a person: name, note, state, the day they left, working pages; onboarding and schedule as --json."
      + " Never rights, logins, keys, role, Telegram or pay terms.",
    example: "hub owner people edit anna --working-page mia-1,mia-2 --why \"с 25.11 ведёт вторую страницу\"",
    arguments: { name: "<code>", describe: "The person's code", min: 1, max: 1 },
    options: {
      "display-name": { kind: "string", describe: "The name" },
      note: { kind: "string", describe: "The owner's note (empty — none)" },
      state: { kind: "string", describe: "The person's state" },
      "left-on": { kind: "string", describe: "The day they left, ГГГГ-ММ-ДД" },
      "working-page": { kind: "list", describe: "The whole list of working pages, in order (comma-separated or repeated)" },
      json: { kind: "string", describe: "More fields as JSON: {\"onboarding\": […], \"schedule\": {…}}" },
    },
    run: (client, values, _deps, args) => {
      const note = text(values, "note");
      const pages = list(values, "working-page");
      const fields = {
        ...jsonArgs(values),
        ...defined({
          displayName: text(values, "display-name"),
          note: note === undefined ? undefined : note.trim() === "" ? null : note,
          state: text(values, "state"),
          leftOn: text(values, "left-on"),
          workingPageLabels: values["working-page"] === undefined ? undefined : pages,
        }),
      };
      if (Object.keys(fields).length === 0) throw new HubUsageError("nothing to change");
      return call(client, "people.edit", { ...fields, code: args[0]! });
    },
  }),
];
