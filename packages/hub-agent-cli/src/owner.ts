import {
  OWNER_AGENT_CUSTOM_STEPS,
  OWNER_AGENT_OPERATION_NAMES,
  OWNER_AGENT_OPERATION_SCHEMAS,
  OWNER_AGENT_REASON_HEADER,
  OWNER_AGENT_REASON_MAX,
} from "@agency_hub_core/contracts";
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

/** A flag's JSON object (`--json`: the operation's arguments; `--schedule`: a schedule); absent — {}. */
function jsonValue(values: HubOptionValues, name: string): Record<string, unknown> {
  const raw = text(values, name);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HubUsageError(`--${name} is not JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HubUsageError(`--${name} is a JSON object`);
  return parsed as Record<string, unknown>;
}

const jsonArgs = (values: HubOptionValues) => jsonValue(values, "json");

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
  command({
    name: "owner people set",
    summary: "Set a person's state, the day they left, working pages and schedule (people.edit with these alone)."
      + " Never rights, logins, keys, role, Telegram or pay terms, never a proposal.",
    example: "hub owner people set anna --state left --left-on 2026-11-30 --why \"ушла с 30.11\"",
    arguments: { name: "<code>", describe: "The person's code", min: 1, max: 1 },
    options: {
      state: { kind: "string", describe: "The person's state: invited, set_up, working, left" },
      "left-on": { kind: "string", describe: "The day they left, ГГГГ-ММ-ДД (state left); empty — none" },
      "working-page": { kind: "list", describe: "The whole list of working pages, in order (comma-separated or repeated)" },
      schedule: { kind: "string", describe: "A schedule line as JSON: {\"pageLabel\":null,\"from\":\"2026-12-01\",\"slot\":{\"start\":\"10:00\",\"end\":\"18:00\"}}" },
    },
    run: (client, values, _deps, args) => {
      const leftOn = text(values, "left-on");
      const fields = defined({
        state: text(values, "state"),
        leftOn: leftOn === undefined ? undefined : leftOn.trim() === "" ? null : leftOn,
        workingPageLabels: values["working-page"] === undefined ? undefined : list(values, "working-page"),
        schedule: text(values, "schedule") === undefined ? undefined : jsonValue(values, "schedule"),
      });
      if (Object.keys(fields).length === 0) throw new HubUsageError("nothing to set: --state, --left-on, --working-page or --schedule");
      return call(client, "people.edit", { ...fields, code: args[0]! });
    },
  }),

  // ── Кастомы ──
  command({
    name: "owner custom board",
    summary: "«Кастомы» as the owner's board shows it: the live orders, findings, what changed by itself.",
    options: { page: { kind: "string", describe: "One page's orders, by its label" } },
    run: (client, values) => call(client, "custom.board", defined({ pageLabel: text(values, "page") })),
  }),
  command({
    name: "owner custom show",
    summary: "An order whole by its code: card, messages, payments, history, the steps the owner may take.",
    arguments: { name: "<code>", describe: "The order's code, K-…", min: 1, max: 1 },
    options: {},
    run: (client, _values, _deps, args) => call(client, "custom.show", { code: args[0]! }),
  }),
  command({
    name: "owner custom step",
    summary: "One step of an order as the owner on the board, none of money (never payment, unpay, paid_word, cancel or a"
      + " price). --step names it, --json its fields; an edit is {\"card\":{…the changed fields}} without «Оплата».",
    example: "hub owner custom step K-12 --step hold --json '{\"reason\":\"ждём реквизит\"}' --why \"модель попросила подождать\"",
    arguments: { name: "<code>", describe: "The order's code, K-…", min: 1, max: 1 },
    options: {
      step: { kind: "string", describe: `The step (required): ${OWNER_AGENT_CUSTOM_STEPS.join(", ")}` },
      json: { kind: "string", describe: "The step's fields as JSON (reason, note, deadlineOn, card, …)" },
    },
    run: (client, values, _deps, args) => call(client, "custom.step", { code: args[0]!, step: { ...jsonArgs(values), action: required(values, "step") } }),
  }),
  command({
    name: "owner custom-finding list",
    summary: "«Найдено без заказа»: the open findings, and the ones an agent dismissed in two weeks.",
    options: {},
    run: (client) => call(client, "customFinding.list", {}),
  }),
  command({
    name: "owner custom-finding answer",
    summary: "Answer a finding: dismiss (--reason), reopen, link (--code K-…) or record (--json '{\"card\":…}') one of no sale."
      + " A sale's finding recorded or linked pays the order: 409 finding_pays, the owner does it on the board.",
    example: "hub owner custom-finding answer 42 --step dismiss --reason not_custom --why \"обычный тип\"",
    arguments: { name: "<finding №>", describe: "The finding's number", min: 1, max: 1 },
    options: {
      step: { kind: "string", describe: "dismiss | reopen | link | record (required)" },
      reason: { kind: "string", describe: "dismiss: not_custom, sexting, unused, duplicate, test, not_asked" },
      code: { kind: "string", describe: "link: the order's code, K-…" },
      json: { kind: "string", describe: "record: its fields as JSON ({\"card\":…, \"pageLabel\":…, \"fan\":…})" },
    },
    run: (client, values, _deps, args) => call(client, "customFinding.answer", {
      findingId: id(args[0], "<finding №>"),
      step: { ...jsonArgs(values), ...defined({ reason: text(values, "reason"), code: text(values, "code") }), action: required(values, "step") },
    }),
  }),

  // ── Дела ──
  command({
    name: "owner matter list",
    summary: "The owner's matters (every one), by state, kind or page, with whether each kind is known.",
    options: {
      state: { kind: "string", describe: "open (default) | closed" },
      kind: { kind: "string", describe: "One kind" },
      page: { kind: "string", describe: "One page's (a matter of no page is every page's)" },
      limit: { kind: "number", describe: "At most this many (default 200, at most 500)" },
    },
    run: (client, values) => call(client, "matter.list", defined({
      state: text(values, "state"), kind: text(values, "kind"), pageLabel: text(values, "page"),
      limit: text(values, "limit") === undefined ? undefined : id(text(values, "limit"), "--limit"),
    })),
  }),
  command({
    name: "owner matter close",
    summary: "Close a matter an agent opened, by its key. Any other closes through its kind's own step (409 matter_kind_service names it).",
    example: "hub owner matter close agent.ask:17 --how resolved --note \"решили на созвоне\" --why \"закрываю вопрос\"",
    arguments: { name: "<key>", describe: "The matter's key", min: 1, max: 1 },
    options: {
      how: { kind: "string", describe: "resolved | withdrawn | cause_gone (required)" },
      note: { kind: "string", describe: "A line in its history" },
    },
    run: (client, values, _deps, args) => call(client, "matter.close", defined({ key: args[0]!, how: required(values, "how"), note: text(values, "note") })),
  }),
  command({
    name: "owner matter comment",
    summary: "Comment a matter by its key, in its history (any kind's).",
    arguments: { name: "<key>", describe: "The matter's key", min: 1, max: 1 },
    options: { text: { kind: "string", describe: "The comment (required)" } },
    run: (client, values, _deps, args) => call(client, "matter.comment", { key: args[0]!, text: required(values, "text") }),
  }),

  // ── «Обучение» ──
  command({
    name: "owner learn list",
    summary: "The pages of «Обучение», each with whether the team reads it.",
    options: {},
    run: (client) => call(client, "learn.list", {}),
  }),
  command({
    name: "owner learn show",
    summary: "A page of «Обучение» with its text.",
    arguments: { name: "<slug>", describe: "The page's slug", min: 1, max: 1 },
    options: {},
    run: (client, _values, _deps, args) => call(client, "learn.show", { slug: args[0]! }),
  }),
  command({
    name: "owner learn approve",
    summary: "Approve a page of «Обучение» for the team; --take-back takes the approval back.",
    arguments: { name: "<slug>", describe: "The page's slug", min: 1, max: 1 },
    options: { "take-back": { kind: "boolean", describe: "Take the approval back: the team reads it no more" } },
    run: (client, values, _deps, args) => call(client, "learn.approve", { slug: args[0]!, approved: values["take-back"] !== true }),
  }),

  // ── Подмены ──
  command({
    name: "owner swap list",
    summary: "The approved swaps of the next 14 days (and today).",
    options: {},
    run: (client) => call(client, "swap.list", {}),
  }),
  command({
    name: "owner swap approve",
    summary: "«Можно» to a swap question, with a line: the day's lines of the schedule are written.",
    arguments: { name: "<question №>", describe: "The swap question's number", min: 1, max: 1 },
    options: { text: { kind: "string", describe: "A line to the asker" } },
    run: (client, values, _deps, args) => call(client, "swap.approve", defined({ questionId: id(args[0], "<question №>"), text: text(values, "text") })),
  }),
  command({
    name: "owner swap revoke",
    summary: "Take an approved swap back before its day.",
    arguments: { name: "<question №>", describe: "The swap question's number", min: 1, max: 1 },
    options: {},
    run: (client, _values, _deps, args) => call(client, "swap.revoke", { questionId: id(args[0], "<question №>") }),
  }),

  // ── Решения из ledger ──
  command({
    name: "owner decision unlinked",
    summary: "Decisions carried over from the ledger that name no sale yet, each with the sales it may be.",
    options: {},
    run: (client) => call(client, "decision.unlinked", {}),
  }),
  command({
    name: "owner decision link",
    summary: "Tie a decision carried over from the ledger to its sale: it rules the sale from now, the reports follow.",
    arguments: { name: "<decision №>", describe: "The decision's number", min: 1, max: 1 },
    options: { sale: { kind: "number", describe: "The sale by Hub's id (required)" } },
    run: (client, values, _deps, args) => call(client, "decision.link", { decisionId: id(args[0], "<decision №>"), transactionId: id(text(values, "sale"), "--sale") }),
  }),

  // ── Общаки в Workboard (H11) ──
  command({
    name: "owner pot list",
    summary: "Workboard pots with live base balances, unrouted pot sales, and models/people catalog.",
    options: {},
    run: (client) => call(client, "pot.list", {}),
  }),
  command({
    name: "owner pot show",
    summary: "One pot by its code: eligible sales with remaining base, active participants, and distributions.",
    arguments: { name: "<code>", describe: "The pot's code", min: 1, max: 1 },
    options: {},
    run: (client, _values, _deps, args) => call(client, "pot.show", { code: args[0]! }),
  }),
  command({
    name: "owner pot create",
    summary: "Create a Workboard pot (page pot or event pot) for a live model and its pages.",
    example: "hub owner pot create winter-promo --name \"Зимний ивент\" --model mia --page mia-1,mia-2 --opens-on 2026-12-01 --participants-mode page_workers --formula equal --why \"открываем общак\"",
    arguments: { name: "<code>", describe: "The new pot's code", min: 1, max: 1 },
    options: {
      name: { kind: "string", describe: "Display name (required)" },
      model: { kind: "string", describe: "Live model slug (required)" },
      page: { kind: "list", describe: "Page labels of the model, comma-separated or repeated (required)" },
      intake: { kind: "list", describe: "Auto-intake reasons: post_tip, campaign (omit for event pot)" },
      "opens-on": { kind: "string", describe: "First Moscow day YYYY-MM-DD (required)" },
      "closes-on": { kind: "string", describe: "Last Moscow day YYYY-MM-DD (optional)" },
      "participants-mode": { kind: "string", describe: "page_workers | listed (required)" },
      formula: { kind: "string", describe: "equal | weights | manual (default equal; full formula object via --json)" },
      "auto-post": { kind: "boolean", describe: "Auto-post equal distributions per sale" },
      json: { kind: "string", describe: "Additional fields as JSON: {\"participants\":[…], \"formula\":{\"kind\":\"weights\",\"params\":…}}" },
    },
    run: (client, values, _deps, args) => {
      const extra = jsonArgs(values);
      const closesOn = text(values, "closes-on");
      const formulaKind = text(values, "formula");
      return call(client, "pot.create", {
        ...extra,
        ...defined({
          code: args[0]!,
          name: required(values, "name"),
          modelSlug: required(values, "model"),
          pageLabels: list(values, "page"),
          intakeReasons: values.intake === undefined ? undefined : list(values, "intake"),
          opensOn: required(values, "opens-on"),
          closesOn: closesOn === undefined ? undefined : closesOn.trim() === "" ? null : closesOn,
          participantsMode: required(values, "participants-mode"),
          formula: formulaKind === undefined ? (extra.formula ?? { kind: "equal", params: {} }) : { kind: formulaKind, params: {} },
          autoPost: values["auto-post"] === undefined ? undefined : values["auto-post"] === true,
        }),
      });
    },
  }),
  command({
    name: "owner pot update",
    summary: "Update an open Workboard pot (name, pages, intake, dates, participants, formula, autoPost).",
    arguments: { name: "<code>", describe: "The pot's code", min: 1, max: 1 },
    options: {
      name: { kind: "string", describe: "Display name" },
      page: { kind: "list", describe: "Page labels of the pot's model" },
      intake: { kind: "list", describe: "Auto-intake reasons: post_tip, campaign (empty for event pot)" },
      "opens-on": { kind: "string", describe: "First Moscow day YYYY-MM-DD" },
      "closes-on": { kind: "string", describe: "Last Moscow day YYYY-MM-DD (empty clears)" },
      "participants-mode": { kind: "string", describe: "page_workers | listed" },
      "auto-post": { kind: "boolean", describe: "Auto-post equal distributions per sale" },
      json: { kind: "string", describe: "Fields as JSON: {\"formula\":…, \"participants\":…, \"autoPost\":false}" },
    },
    run: (client, values, _deps, args) => {
      const closesOn = text(values, "closes-on");
      const fields = {
        ...jsonArgs(values),
        ...defined({
          name: text(values, "name"),
          pageLabels: values.page === undefined ? undefined : list(values, "page"),
          intakeReasons: values.intake === undefined ? undefined : list(values, "intake"),
          opensOn: text(values, "opens-on"),
          closesOn: closesOn === undefined ? undefined : closesOn.trim() === "" ? null : closesOn,
          participantsMode: text(values, "participants-mode"),
          autoPost: values["auto-post"] === undefined ? undefined : values["auto-post"] === true,
        }),
      };
      if (Object.keys(fields).length === 0) throw new HubUsageError("nothing to change");
      return call(client, "pot.update", { ...fields, code: args[0]! });
    },
  }),
  command({
    name: "owner pot preview",
    summary: "Pure preview of a pot distribution in base mills (writes nothing).",
    arguments: { name: "<code>", describe: "The pot's code", min: 1, max: 1 },
    options: {
      day: { kind: "string", describe: "Distribution Moscow day YYYY-MM-DD" },
      json: { kind: "string", describe: "Optional overrides as JSON: {\"formula\":…, \"parts\":[{\"transactionId\":…,\"baseMills\":…}]}" },
    },
    run: (client, values, _deps, args) => call(client, "pot.preview", {
      ...jsonArgs(values),
      ...defined({ code: args[0]!, day: text(values, "day") }),
    }),
  }),
  command({
    name: "owner pot post",
    summary: "Post an immutable Workboard pot distribution in base mills.",
    arguments: { name: "<code>", describe: "The pot's code", min: 1, max: 1 },
    options: {
      day: { kind: "string", describe: "Distribution Moscow day YYYY-MM-DD" },
      json: { kind: "string", describe: "Optional overrides as JSON: {\"formula\":…, \"parts\":[{\"transactionId\":…,\"baseMills\":…}]}" },
    },
    run: (client, values, _deps, args) => call(client, "pot.post", {
      ...jsonArgs(values),
      ...defined({ code: args[0]!, day: text(values, "day") }),
    }),
  }),
  command({
    name: "owner pot reverse",
    summary: "Reverse a posted Workboard pot distribution once with a mandatory reason.",
    arguments: { name: "<distribution №>", describe: "The distribution's id", min: 1, max: 1 },
    options: { reason: { kind: "string", describe: "Why the distribution is reversed (required)" } },
    run: (client, values, _deps, args) => call(client, "pot.reverse", {
      distributionId: id(args[0], "<distribution №>"),
      reason: required(values, "reason"),
    }),
  }),
  command({
    name: "owner pot close",
    summary: "Close an open Workboard pot (historical distributions remain intact).",
    arguments: { name: "<code>", describe: "The pot's code", min: 1, max: 1 },
    options: {},
    run: (client, _values, _deps, args) => call(client, "pot.close", { code: args[0]! }),
  }),
];
