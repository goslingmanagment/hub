import { z } from "zod";

import type { TeamLedgerQuestion, TeamLedgerQuestionsResponse } from "@agency_hub_core/contracts";

import { ServiceUnavailableError } from "./errors.ts";
import { ledgerGet, list, micros, millsOf, type LedgerReadApp } from "./ledger-payouts.ts";

/**
 * Workboard «Решения → Чья продажа» (the owner's): the open questions «whose is this sale» the team's chat agent asked
 * and the agency ledger keeps, read from GET /v1/questions?open=1 with Hub's payouts key, split by whom they wait for
 * (the owner, or the chatters among themselves), sums in mills. Read-only: the owner answers the agent in the chat, the
 * agent records the decision in the ledger and the question closes. A changed shape is a 503, never a wrong row; while
 * the ledger does not open the questions to Hub's key (403/404) the answer is «none yet», said once in the log.
 */

/** A text the ledger may leave out or null, trimmed. */
const text = z.string().nullish().transform((value) => value?.trim() ?? "");
/** An id or a reference the ledger may write as a number. */
const ref = z.union([z.string(), z.number()]).nullish().transform((value) => (value === null || value === undefined ? "" : String(value).trim()));
const integerId = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/).transform(Number)]);

/** One question, in the ledger's snake_case or in camelCase; absent optional fields are «not known». */
const ledgerQuestion = z.object({
  id: integerId,
  page_label: text, pageLabel: text, page: text,
  fan_ref: ref, fanRef: ref,
  fan_name: text, fanName: text,
  transaction_ref: ref, transactionRef: ref,
  net_micros: micros.nullish(), netMicros: micros.nullish(),
  occurred_at: text, occurredAt: text,
  question: z.string(),
  asked_of: text, askedOf: text,
  who: text,
  asked_at: text, askedAt: text,
  source_link: text, sourceLink: text,
  note: text,
  status: text,
  created_at: text, createdAt: text,
});

const ledgerQuestionsSchema = z.object({ questions: list(ledgerQuestion) });

type LedgerQuestion = z.output<typeof ledgerQuestion>;

/** An instant as ISO; null — empty or not a time. */
function instant(value: string): string | null {
  if (value === "") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A link the screen may open: http or https only. */
function webLink(value: string): string | null {
  if (value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The questions' refusal is said in the log once per process: it stays until the ledger opens them to Hub. */
let closedSaid = false;

export async function readTeamLedgerQuestions(
  app: LedgerReadApp,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamLedgerQuestionsResponse> {
  const serverNow = (options.now ?? new Date()).toISOString();
  const body = await ledgerGet(app, "/v1/questions", { open: "1" }, {
    client: "workboard-questions",
    absentOn: [403, 404],
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (body === undefined) {
    if (!closedSaid) {
      closedSaid = true;
      app.logger.info({}, "ledger questions: GET /v1/questions is not open to Hub's key yet; no sale questions are shown");
    }
    return { owner: [], chatters: [], questionsRead: false, serverNow };
  }
  const parsed = ledgerQuestionsSchema.safeParse(body);
  if (!parsed.success) unknownShape(app, parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`));

  const owner: TeamLedgerQuestion[] = [];
  const chatters: TeamLedgerQuestion[] = [];
  for (const raw of parsed.data.questions) {
    // Asked for the open ones; a closed one that still came is not waiting for anybody.
    if (raw.status !== "" && raw.status !== "open") continue;
    const question = questionOf(raw);
    // A question without the time it was asked is not the ledger's shape: «ждёт N дней» would be a guess.
    if (question === null) unknownShape(app, [`questions.${raw.id}.asked_at: not a time`]);
    // Anyone the ledger may name besides the chatters is the owner's to see: a question never silently disappears.
    ((raw.asked_of || raw.askedOf) === "chatters" ? chatters : owner).push(question);
  }
  const oldestFirst = (left: TeamLedgerQuestion, right: TeamLedgerQuestion) => left.askedAt.localeCompare(right.askedAt) || left.id - right.id;
  return { owner: owner.sort(oldestFirst), chatters: chatters.sort(oldestFirst), questionsRead: true, serverNow };
}

function unknownShape(app: LedgerReadApp, issues: string[]): never {
  app.logger.warn({ issues }, "ledger questions: unexpected answer");
  throw new ServiceUnavailableError("The ledger's GET /v1/questions answered in a shape Hub does not know");
}

function questionOf(raw: LedgerQuestion): TeamLedgerQuestion | null {
  const askedAt = instant(raw.asked_at || raw.askedAt) ?? instant(raw.created_at || raw.createdAt);
  if (askedAt === null) return null;
  const net = raw.net_micros ?? raw.netMicros ?? null;
  const fanRef = raw.fan_ref || raw.fanRef;
  const fanName = raw.fan_name || raw.fanName;
  const transactionRef = raw.transaction_ref || raw.transactionRef;
  return {
    id: raw.id,
    pageLabel: raw.page_label || raw.pageLabel || raw.page,
    fanRef: fanRef === "" ? null : fanRef,
    fanName: fanName === "" ? null : fanName,
    transactionRef: transactionRef === "" ? null : transactionRef,
    netMills: net === null ? null : millsOf(net),
    occurredAt: instant(raw.occurred_at || raw.occurredAt),
    question: raw.question.trim(),
    who: raw.who,
    askedAt,
    sourceLink: webLink(raw.source_link || raw.sourceLink),
    note: raw.note,
  };
}
