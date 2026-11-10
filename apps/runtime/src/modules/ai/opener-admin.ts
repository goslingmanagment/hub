import type {
  AdminAiPersonaOpenerCreateBody,
  AdminAiPersonaOpenerOutcome,
  AdminAiPersonaOpenersResponse,
} from "@agency_hub_core/contracts";
import {
  createAiPersonaOpener,
  findAiPersonaByKey,
  listAiPersonaOpenerOutcomes,
  listAiPersonaOpeners,
  setAiPersonaOpenerEnabled,
  type AiPersonaOpenerOutcome,
} from "@agency_hub_core/db";
import { millsToNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { recordAudit, withAuditTransaction, type AuditContext } from "../../services/auth.ts";
import { BadRequestError, NotFoundError } from "../../services/errors.ts";
import { localHourIn } from "./greeting-openers.ts";

// The owner's lane for Hi's openers (0320): the list with how fans answered
// each text, and the two writes, add and switch on/off. Every write commits
// its audit row in the same transaction; like the persona's, the audit never
// carries the text itself.

const ZERO: AdminAiPersonaOpenerOutcome = {
  sent: 0,
  edited: 0,
  matured: 0,
  replied: 0,
  talked: 0,
  maturedPaid: 0,
  paid: 0,
  payers: 0,
  payersGrossMills: 0,
  topPayerGrossMills: 0,
};

function add(a: AdminAiPersonaOpenerOutcome, b: AiPersonaOpenerOutcome): AdminAiPersonaOpenerOutcome {
  return {
    sent: a.sent + b.sent,
    edited: a.edited + b.edited,
    matured: a.matured + b.matured,
    replied: a.replied + b.replied,
    talked: a.talked + b.talked,
    maturedPaid: a.maturedPaid + b.maturedPaid,
    paid: a.paid + b.paid,
    payers: a.payers + b.payers,
    payersGrossMills: a.payersGrossMills + millsToNumber(b.payersGrossMills),
    // A fan sits in one row (their first greeting), so the largest of the rows is the largest fan.
    topPayerGrossMills: Math.max(a.topPayerGrossMills, millsToNumber(b.topPayerGrossMills)),
  };
}

/** A persona's openers, oldest first, each with the greetings sent from it. */
export async function listPersonaOpeners(
  app: Pick<AppContext, "db">,
  personaKey: string,
  now = new Date(),
): Promise<AdminAiPersonaOpenersResponse> {
  const [openers, outcomes] = await Promise.all([
    listAiPersonaOpeners(app.db, personaKey),
    listAiPersonaOpenerOutcomes(app.db, { personaKey, now }),
  ]);
  return {
    personaKey,
    openers: openers.map((opener) => ({
      id: opener.id,
      body: opener.body,
      audience: opener.audience,
      hours: opener.hours,
      enabled: opener.enabled,
      createdAt: opener.createdAt.toISOString(),
      outcomes: totalsOf(outcomes.filter((row) => row.openerId === opener.id)),
    })),
    // Every text together, by what the greeting asked: a personal question
    // about the fan's hook, or the text's own to a fan with no hook.
    questions: {
      personal: totalsOf(outcomes.filter((row) => row.question === "personal")),
      none: totalsOf(outcomes.filter((row) => row.question === "none")),
    },
  };
}

/** Rows summed, all together and by what the fan was. */
function totalsOf(rows: readonly AiPersonaOpenerOutcome[]) {
  const totals = { all: ZERO, bare: ZERO, named: ZERO, other: ZERO };
  for (const row of rows) {
    totals.all = add(totals.all, row);
    const group = row.fan === "bare" ? "bare" : row.fan === "named" ? "named" : "other";
    totals[group] = add(totals[group], row);
  }
  return totals;
}

async function requirePersona(app: Pick<AppContext, "db">, personaKey: string): Promise<void> {
  if (!await findAiPersonaByKey(app.db, personaKey)) {
    throw new NotFoundError("Persona not found");
  }
}

export async function createPersonaOpener(
  app: Pick<AppContext, "db">,
  audit: AuditContext,
  personaKey: string,
  input: AdminAiPersonaOpenerCreateBody,
): Promise<AdminAiPersonaOpenersResponse> {
  await requirePersona(app, personaKey);
  if (input.hours !== null) {
    if (input.hours.from === input.hours.to) {
      throw new BadRequestError("The hours must not start and end at the same hour");
    }
    if (localHourIn(input.hours.timeZone, Date.now()) === null) {
      throw new BadRequestError(`Unknown time zone: ${input.hours.timeZone}`);
    }
  }
  await withAuditTransaction(app, async (db) => {
    const opener = await createAiPersonaOpener(db, {
      personaKey,
      body: input.body,
      audience: input.audience,
      hours: input.hours,
    });
    await recordAudit({ db }, {
      ...audit,
      eventType: "ai_persona_opener.created",
      metadata: {
        personaKey,
        openerId: opener.id,
        chars: opener.body.length,
        audience: opener.audience,
        hours: opener.hours,
      },
    });
  });
  return listPersonaOpeners(app, personaKey);
}

export async function setPersonaOpenerEnabled(
  app: Pick<AppContext, "db">,
  audit: AuditContext,
  input: { personaKey: string; id: number; enabled: boolean },
): Promise<AdminAiPersonaOpenersResponse> {
  const changed = await withAuditTransaction(app, async (db) => {
    const opener = await setAiPersonaOpenerEnabled(db, input);
    if (opener === null) {
      return false;
    }
    await recordAudit({ db }, {
      ...audit,
      eventType: input.enabled ? "ai_persona_opener.enabled" : "ai_persona_opener.disabled",
      metadata: { personaKey: input.personaKey, openerId: opener.id },
    });
    return true;
  });
  if (!changed) {
    throw new NotFoundError("Opener not found");
  }
  return listPersonaOpeners(app, input.personaKey);
}
