import type { KernelOperationResponse, OwnPayoutDetails, PayoutDetails, PersonStart, PersonStartStepId } from "@agency_hub_core/contracts";
import { PAYOUT_DETAILS_MAX_LENGTH, PERSON_START_STEPS, PERSON_START_STUCK_HOURS } from "@agency_hub_core/contracts";

import { demoError, hoursAgo, iso, daysAgo, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_PAGES } from "../world.ts";

/**
 * «Начало» in the invented agency (contracts person-start.ts). The newcomer
 * is Ника (`nika.t`, invited the day before); the chatter of the demo signs in
 * as her while the `hub-demo-scenario` cookie names a stage:
 *
 * - `start-0`       — the invitation is not opened yet (the owner's card only);
 * - `start-1`       — she has just set her password: the page is opened, nothing else;
 * - `start-nopages` — the same, and the owner has not opened a page yet;
 * - `start-2`       — the extension signed in and where to pay written: the first work is all that is left;
 * - `start-stuck`   — `start-1` three days on (the owner's matter);
 * - `start-done`    — every step done: «Начало» leaves the menu.
 *
 * Without the cookie she has not opened the invitation (`start-0`, as the
 * rest of the demo has her) and the demo's chatter is Алекс, who works and
 * has no «Начало». Where to pay is
 * kept in memory from her own write until the dev server restarts.
 */

type AccountStart = KernelOperationResponse<"accountStart">;

export const NEWCOMER = { code: "nika", name: "Ника", userId: 10, username: "nika.t", page: "mia-3" } as const;

interface Stage {
  signedUp: boolean;
  device: boolean;
  pages: boolean;
  activity: boolean;
  payout: boolean;
  /** How long ago she was invited, hours. */
  invitedHours: number;
}

const DEFAULT_STAGE = "start-0";

const STAGES: Readonly<Record<string, Stage>> = {
  "start-0": { signedUp: false, device: false, pages: true, activity: false, payout: false, invitedHours: 7.4 },
  "start-1": { signedUp: true, device: false, pages: true, activity: false, payout: false, invitedHours: 0.4 },
  "start-nopages": { signedUp: true, device: false, pages: false, activity: false, payout: false, invitedHours: 0.4 },
  "start-2": { signedUp: true, device: true, pages: true, activity: false, payout: true, invitedHours: 26 },
  "start-stuck": { signedUp: true, device: false, pages: true, activity: false, payout: false, invitedHours: 74 },
  "start-done": { signedUp: true, device: true, pages: true, activity: true, payout: true, invitedHours: 50 },
};

/** The stage the scenario names; null — not a newcomer's scenario. */
export function newcomerStage(scenario: string | undefined): string | null {
  return scenario !== undefined && scenario in STAGES ? scenario : null;
}

/** The demo's chatter is the newcomer while a stage is named. */
export function signedInAsNewcomer(request: DemoRequest): boolean {
  return request.role === "chatter" && newcomerStage(request.scenario) !== null;
}

/** The pages opened to the newcomer at the scenario's stage (the owner's card follows the default stage). */
export function newcomerPages(scenario: string | undefined): string[] {
  return STAGES[newcomerStage(scenario) ?? DEFAULT_STAGE]!.pages ? [NEWCOMER.page] : [];
}

/** Her login at a stage after the invitation: it has a password and was seen; null — as the rest of the demo has it. */
export function newcomerLogin(scenario: string | undefined, now: Date): { state: "active"; lastSeenAt: string } | null {
  const stage = newcomerStage(scenario);
  if (stage === null || !STAGES[stage]!.signedUp) return null;
  return { state: "active", lastSeenAt: iso(hoursAgo(now, 0.2)) };
}

const SAMPLE_PAYOUT = "Bybit, UID 48 210 735 (демо)";
/** The people's own writes; null — cleared. */
const written = new Map<string, { text: string; updatedAt: string } | null>();

function payoutOf(code: string, fallback: { text: string; updatedAt: string } | null): PayoutDetails {
  return written.has(code) ? written.get(code)! : fallback;
}

/** As the person's own session reads it: a narrow one (from the extension) is told it is written and when, never the text, as on Hub. */
function ownPayout(details: PayoutDetails, request: DemoRequest): OwnPayoutDetails {
  return details === null || request.narrow !== true ? details : { text: null, updatedAt: details.updatedAt };
}

function startOf(stage: Stage, now: Date): PersonStart {
  const invited = hoursAgo(now, stage.invitedHours);
  const step = (hoursAfter: number) => new Date(invited.getTime() + hoursAfter * 3_600_000);
  const signedUpAt = step(Math.min(0.1, stage.invitedHours / 2));
  const at: Record<PersonStartStepId, Date | null> = {
    install: stage.device ? step(0.3) : null,
    extension: stage.device ? step(0.3) : null,
    pages: stage.pages ? invited : null,
    activity: stage.activity ? step(20) : null,
    payout: stage.payout ? step(0.5) : null,
  };
  const steps = PERSON_START_STEPS.map((id) => ({ step: id, done: at[id] !== null, doneAt: at[id] ? iso(at[id]!) : null }));
  const currentIndex = steps.findIndex((one) => !one.done);
  const current = currentIndex === -1 ? null : PERSON_START_STEPS[currentIndex]!;
  let since: Date | null = null;
  if (current !== null) {
    since = stage.signedUp ? signedUpAt : invited;
    if (stage.signedUp) {
      for (const id of PERSON_START_STEPS.slice(0, currentIndex)) if (at[id] && at[id]! > since) since = at[id];
    }
  }
  const waitsForOwner = stage.signedUp && current === "pages";
  const pages = stage.pages ? DEMO_PAGES.filter((page) => page.label === NEWCOMER.page) : [];
  return {
    // Her record says «invited» until the owner moves it: the path stays hers, done or not.
    newcomer: true,
    signedUp: stage.signedUp,
    steps,
    done: steps.filter((one) => one.done).length,
    total: steps.length,
    current,
    since: since ? iso(since) : null,
    stuck: since !== null && !waitsForOwner && now.getTime() - since.getTime() >= PERSON_START_STUCK_HOURS * 3_600_000,
    extension: stage.device ? { label: "Firefox · Windows · ChatGoose", signedInAt: iso(at.extension!), active: true } : null,
    pages: pages.map((page) => ({ pageLabel: page.label, platform: page.platform, modelName: page.modelName })),
    firstActivity: stage.activity ? { at: iso(at.activity!), pageLabel: NEWCOMER.page } : null,
  };
}

/** Someone who works already: every step done long ago (where to pay only if they wrote it). */
function workingStart(pageLabels: readonly string[], paid: boolean, now: Date): PersonStart {
  const long = daysAgo(now, 40);
  const doneAt = (id: PersonStartStepId) => (id === "payout" && !paid ? null : iso(long));
  const steps = PERSON_START_STEPS.map((id) => ({ step: id, done: doneAt(id) !== null, doneAt: doneAt(id) }));
  const current = steps.find((one) => !one.done)?.step ?? null;
  const pages = DEMO_PAGES.filter((page) => pageLabels.includes(page.label));
  return {
    newcomer: false, signedUp: true, steps, done: steps.filter((one) => one.done).length, total: steps.length,
    current, since: current === null ? null : iso(long), stuck: false,
    extension: { label: "Firefox · Windows · ChatGoose", signedInAt: iso(long), active: true },
    pages: pages.map((page) => ({ pageLabel: page.label, platform: page.platform, modelName: page.modelName })),
    firstActivity: pages[0] ? { at: iso(long), pageLabel: pages[0].label } : null,
  };
}

/** What the people who work wrote (invented): Алекс and Катя told Hub, the rest still tell the owner in a message. */
const WORKING_PAYOUTS: Readonly<Record<string, string>> = {
  alex: "Bybit UID 31 774 902 (демо)",
  kate: "USDT TRC-20, TQd7…9xKp (демо)",
};

/** The owner's card: the way and where to pay, of one person of the registry (people.ts). */
export function demoStartForCard(person: { code: string; kind: string; state: string; pages: readonly string[]; hasLogin: boolean }, request: DemoRequest): {
  start: PersonStart | null;
  payoutDetails: PayoutDetails;
} {
  if (person.kind !== "human" || !person.hasLogin) return { start: null, payoutDetails: null };
  if (person.code === NEWCOMER.code) {
    const stage = STAGES[newcomerStage(request.scenario) ?? DEFAULT_STAGE]!;
    const start = startOf(stage, request.now);
    return { start, payoutDetails: payoutOf(NEWCOMER.code, stage.payout ? { text: SAMPLE_PAYOUT, updatedAt: start.steps[4]!.doneAt! } : null) };
  }
  const sample = WORKING_PAYOUTS[person.code];
  const fallback = sample ? { text: sample, updatedAt: iso(daysAgo(request.now, 40)) } : null;
  const payoutDetails = payoutOf(person.code, fallback);
  return { start: workingStart(person.pages, payoutDetails !== null, request.now), payoutDetails };
}

export const personStartHandlers: DemoHandlers = {
  accountStart: (request): AccountStart => {
    const now = request.now;
    if (signedInAsNewcomer(request)) {
      const stage = STAGES[newcomerStage(request.scenario)!]!;
      let start = startOf(stage, now);
      const payoutDetails = payoutOf(NEWCOMER.code, stage.payout ? { text: SAMPLE_PAYOUT, updatedAt: start.steps[4]!.doneAt! } : null);
      // Her own write closes the step at once, and clearing it opens it again, as on Hub.
      if ((payoutDetails !== null) !== stage.payout) start = startOf({ ...stage, payout: payoutDetails !== null }, now);
      return {
        person: { code: NEWCOMER.code, displayName: NEWCOMER.name }, username: NEWCOMER.username, start,
        payoutDetails: ownPayout(payoutDetails, request), submitsShift: false, serverNow: iso(now),
      };
    }
    if (request.role !== "chatter") return { person: null, username: request.role === "owner" ? "owner" : "lead.marta", start: null, payoutDetails: null, submitsShift: false, serverNow: iso(now) };
    const payoutDetails = payoutOf("alex", { text: WORKING_PAYOUTS.alex!, updatedAt: iso(daysAgo(now, 40)) });
    return {
      person: { code: "alex", displayName: "Алекс" }, username: "alex.k", start: workingStart(["mia-1", "mia-2"], payoutDetails !== null, now),
      payoutDetails: ownPayout(payoutDetails, request), submitsShift: false, serverNow: iso(now),
    };
  },

  accountPayoutDetailsSet: (request) => {
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.length > PAYOUT_DETAILS_MAX_LENGTH) return demoError(400, "Bad Request", "body/text");
    const code = signedInAsNewcomer(request) ? NEWCOMER.code : request.role === "chatter" ? "alex" : null;
    if (code === null) return demoError(409, "Conflict", "This login is nobody's in the people registry");
    const text = body.text.trim();
    if (text === "") {
      written.set(code, null);
      return { payoutDetails: null };
    }
    const row = { text, updatedAt: iso(request.now) };
    written.set(code, row);
    return { payoutDetails: row };
  },
};
