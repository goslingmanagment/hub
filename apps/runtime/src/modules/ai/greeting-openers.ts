import { createHash } from "node:crypto";

import {
  findAiGreetingHook,
  listAiPersonaOpeners,
  type AiPersonaOpener,
  type AiPersonaOpenerFanKind,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

// Hi's first messages from the persona's own openers (owner, 2026-10-25,
// migration 0320). On an empty chat the hub draws one opener per variant, at
// random among those that fit the fan and the hour, so how fans answer each
// text can be counted against the others: a draw made for the fan (by the
// chatter, or by the model) would mix the fan's profile into the text's
// numbers. A fan with nothing to hook on gets the opener as written, without
// the model; every other fan gets the model, which starts from the opener and
// adds his name.
//
// The personal question (owner, 2026-11-10): the opener's question gives way
// to a question about the fan only when his profile holds a real hook: a bio
// that says something, a place or a language, a word in his name that names an
// interest. The model names the hook on its first line (prompts/builder.ts);
// the hub cuts that line, checks the words against the profile, and keeps the
// rest honest: with no hook the opener goes out as the owner wrote it, and a
// question about his name or what his nick means never goes out at all.

/** An account's username its owner never chose: Fansly's `user` and digits,
 * now and then with an underscore, and OnlyFans' `u` and digits. */
const DEFAULT_USERNAME = /^(?:user_?|u)\d+$/i;

export type GreetingFanKind = AiPersonaOpenerFanKind;

export interface GreetingFanProfile {
  /** The prompt's name for the fan. */
  displayName: string;
  /** False when the hub knows no name of the fan and the display name is
   * the fallback (`fan`). */
  nameKnown: boolean;
  username?: string | undefined;
  customName?: string | undefined;
  bio?: string | undefined;
  /** The request carries his profile picture. */
  hasAvatar: boolean;
}

/**
 * What the fan gives to hook on:
 * - `bare`: only a default username, no other name, no bio, no picture;
 * - `default`: a default username, with a bio or a picture;
 * - `named`: a name, or a username its owner chose;
 * - `unknown`: the hub knows no name of the fan.
 */
export function greetingFanKind(fan: GreetingFanProfile): GreetingFanKind {
  const names = [fan.nameKnown ? fan.displayName : undefined, fan.username, fan.customName]
    .map((name) => name?.trim() ?? "")
    .filter((name) => name !== "");
  if (names.length === 0) {
    return "unknown";
  }
  if (!names.every((name) => DEFAULT_USERNAME.test(name))) {
    return "named";
  }
  return (fan.bio?.trim() ?? "") === "" && !fan.hasAvatar ? "bare" : "default";
}

/** The hour of the day (0-23) in an IANA zone; null for a zone Intl does not know. */
export function localHourIn(timeZone: string, nowMs: number): number | null {
  try {
    const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(nowMs))
      .find((part) => part.type === "hour")?.value;
    const value = Number(hour);
    return Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;
  } catch {
    return null;
  }
}

/** Whether an opener may go to this fan now. Its hours are [from, to) in its
 * own zone, across midnight when from > to. */
export function openerFits(opener: AiPersonaOpener, input: { fan: GreetingFanKind; nowMs: number }): boolean {
  if (opener.audience === "bare" && input.fan !== "bare") {
    return false;
  }
  if (opener.hours === null) {
    return true;
  }
  const hour = localHourIn(opener.hours.timeZone, input.nowMs);
  if (hour === null) {
    return false;
  }
  const { from, to } = opener.hours;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** `count` different openers at random, or null when fewer fit. */
export function drawOpeners<T>(candidates: readonly T[], count: number, random: () => number): T[] | null {
  if (count < 1 || candidates.length < count) {
    return null;
  }
  const pool = [...candidates];
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(pool.splice(index, 1)[0]!);
  }
  return picked;
}

export interface GreetingOpenerDraw {
  /** One per variant, in the variants' order. */
  openers: AiPersonaOpener[];
  fan: GreetingFanKind;
  /** The openers go out as written, without the model. */
  asWritten: boolean;
}

/**
 * The draw for one Hi, or null when Hi writes as it did before: the chat is
 * not empty, the persona has no openers, or fewer fit than the variants asked.
 * As written only for a bare fan, and not in Split mode, whose parts are the
 * model's to cut.
 */
export async function drawGreetingOpeners(
  app: Pick<AppContext, "db">,
  input: {
    personaKey: string;
    variantCount: number;
    emptyChat: boolean;
    splitAll: boolean;
    fan: GreetingFanProfile;
    nowMs: number;
    random?: () => number;
  },
): Promise<GreetingOpenerDraw | null> {
  if (!input.emptyChat) {
    return null;
  }
  const openers = await listAiPersonaOpeners(app.db, input.personaKey, { enabledOnly: true });
  if (openers.length === 0) {
    return null;
  }
  const fan = greetingFanKind(input.fan);
  const picked = drawOpeners(
    openers.filter((opener) => openerFits(opener, { fan, nowMs: input.nowMs })),
    input.variantCount,
    input.random ?? Math.random,
  );
  if (picked === null) {
    return null;
  }
  return { openers: picked, fan, asWritten: fan === "bare" && !input.splitAll };
}

/** The draw as the generation's record keeps it (params.contextManifest), and
 * as the openers' numbers read it back (listAiPersonaOpenerOutcomes). An
 * as-written draw has no hook by definition; the model's draw gets its hook
 * once the answer is in (finishGreeting). */
export function greetingOpenersManifest(
  personaKey: string,
  draw: GreetingOpenerDraw,
  profile: string,
): Record<string, unknown> {
  return {
    personaKey,
    ids: draw.openers.map((opener) => opener.id),
    fan: draw.fan,
    mode: draw.asWritten ? "as-written" : "model",
    profile,
    ...(draw.asWritten ? { hook: null, hookQuote: null, questions: draw.openers.map(() => "opener") } : {}),
  };
}

/** The text a draw sends as written: the variants in order, as the model
 * separates them. */
export function asWrittenCompletion(draw: GreetingOpenerDraw): string {
  return draw.openers.map((opener) => opener.body).join("\n[VARIANT]\n");
}

export type GreetingHookKind = "bio" | "place" | "interest";

/** The one real thing in a fan's profile to ask him about. */
export interface GreetingHook {
  kind: GreetingHookKind;
  /** The words of his profile it stands on. */
  quote: string;
}

/** What a variant asks: a question about the fan, or the opener's own. */
export type GreetingQuestion = "personal" | "opener";

const HOOK_KINDS: ReadonlySet<string> = new Set(["bio", "place", "interest"]);

/** Bios the platform writes for an account whose owner wrote none. */
const DEFAULT_BIOS: ReadonlySet<string> = new Set(["heyiamusingfansly"]);

/** Letters and digits only, lowercased: what a quote is compared by. */
function lettersOf(text: string | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function fanNames(fan: GreetingFanProfile): string[] {
  return [fan.nameKnown ? fan.displayName : undefined, fan.username, fan.customName]
    .map((name) => name?.trim() ?? "")
    .filter((name) => name !== "");
}

/** The profile a hook is decided from, as one short key: the same profile
 * keeps the hook an earlier draft of the greeting found. */
export function greetingProfileKey(fan: GreetingFanProfile): string {
  const parts = [fan.nameKnown ? fan.displayName : "", fan.username ?? "", fan.customName ?? "", fan.bio ?? ""]
    .map((part) => part.trim().toLowerCase());
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** `HOOK: none`, or `HOOK: <kind>: <words>`: the model's first line. */
const HOOK_LINE = /^HOOK\s*:\s*(none|bio|place|interest)\b[\s:]*(.*)$/i;

/** The answer without its hook line, and what the line said. `declared` is
 * false when the answer does not start with one. */
export function readGreetingHookLine(completion: string): {
  declared: boolean;
  hook: GreetingHook | null;
  text: string;
} {
  const body = completion.replace(/^\s+/, "");
  const end = body.indexOf("\n");
  const first = (end === -1 ? body : body.slice(0, end)).trim();
  const match = HOOK_LINE.exec(first);
  if (match === null) {
    return { declared: false, hook: null, text: completion.trim() };
  }
  const rest = end === -1 ? "" : body.slice(end + 1).trim();
  const kind = match[1]!.toLowerCase();
  const tail = match[2]!.trim();
  if (kind === "none") {
    // A message the model left on the line of a "none" is still the message.
    return { declared: true, hook: null, text: rest === "" ? tail : rest };
  }
  const quote = tail.replace(/^["'`«“‘]+|["'`»”’]+$/g, "").trim();
  return {
    declared: true,
    hook: quote === "" ? null : { kind: kind as GreetingHookKind, quote: quote.slice(0, 200) },
    text: rest,
  };
}

/** Whether the hook's words stand in the profile: in one of his names, or in
 * a bio he wrote himself. A detail the model made up is no hook. */
export function hookInProfile(hook: GreetingHook, fan: GreetingFanProfile): boolean {
  const quote = lettersOf(hook.quote);
  if (quote.length < 2) {
    return false;
  }
  const bio = lettersOf(fan.bio);
  return [...fanNames(fan).map(lettersOf), DEFAULT_BIOS.has(bio) ? "" : bio].some((part) => part.includes(quote));
}

function wordsOf(text: string): string[] {
  return text
    .replace(/\[NEXT\]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[.,!?;:"'()]+|[.,!?;:"'()]+$/g, ""))
    .filter((word) => word !== "");
}

/** How much of an opener's start the fan's name may change: "hey you," →
 * "hey roma,". */
const GREETING_WORDS = 3;
const NAME_WORDS = 2;

/**
 * Whether a text is the opener as written, with at most the fan's name put in
 * its greeting: everything after the first words is the opener's, word for
 * word (case and the punctuation around a word aside).
 */
export function keepsOpener(opener: string, text: string): boolean {
  const written = wordsOf(opener);
  const sent = wordsOf(text);
  let same = 0;
  while (
    same < written.length && same < sent.length
    && written[written.length - 1 - same] === sent[sent.length - 1 - same]
  ) {
    same += 1;
  }
  const writtenHead = written.length - same;
  const sentHead = sent.length - same;
  return sent.length > 0 && writtenHead <= GREETING_WORDS && sentHead <= writtenHead + NAME_WORDS;
}

/** Questions about his name: what it is, whether it was read right, which
 * form he goes by. */
const NAME_QUESTIONS: readonly RegExp[] = [
  /\bwhat(?:'s|s| is| was)? (?:your|ur) (?:real |actual |first |full )?name\b/i,
  /\b(?:what|how) (?:should|can|do|shall|may) i call (?:you|u)\b/i,
  /\b(?:should|can|do|shall|may) i call (?:you|u)\b/i,
  /\bwhat (?:do|should) (?:you|u) go by\b/i,
  /\b(?:do|did) (?:you|u) go by\b/i,
  /\b(?:your|ur) (?:real |actual |first )?name(?:'s| is|s)? \p{L}+,? (?:right|correct|or|isn'?t it|yeah|yes)\b/iu,
  /\b(?:is|was) (?:that |it |this )?(?:your|ur) (?:real|actual|first|full) name\b/i,
  /\b(?:is|was) \p{L}+ (?:your|ur) (?:real |actual |first |full )?name\b/iu,
  /\b(?:get|got|read|guess|guessed|spell|spelled|say|said) (?:your|ur|the|that) name right\b/i,
  /\b(?:does|do) (?:your|ur) name\b/i,
];

/** Questions about what his nick means or where it comes from. */
const NICK_QUESTIONS: readonly RegExp[] = [
  /\bwhat(?:'s|s| is| does| do)? [^.?!]{0,60}\b(?:mean|means|stand for|stands for)\b[^.?!]*\?/i,
  /\b(?:story|meaning|idea|deal) (?:behind|of|with) (?:your|ur|the|that|this) (?:\p{L}+ )?(?:name|nick|nickname|username|handle)\b/iu,
  /\bwhere (?:does|did|is) (?:your|ur|the|that|this) (?:name|nick|nickname|username|handle)\b/i,
  /\bhow did (?:you|u) (?:come up with|get|pick|choose|land on|end up with) (?:your|ur|the|that|this) (?:name|nick|nickname|username|handle)\b/i,
  /\bwhy (?:did (?:you|u) (?:pick|choose|go with) )?(?:your|ur|the|that|this) (?:name|nick|nickname|username|handle)\b/i,
];

/** "is it david or dave?": two forms of a word that sits in one of his names. */
const EITHER_FORM = /\bis (?:it|that) (\p{L}{2,}) or (\p{L}{2,})\b[^.?!]*\?/iu;

/** Whether a text asks about the fan's name or what his nick means: the two
 * questions that never go out (owner, 2026-11-10). */
export function asksNameOrNick(text: string, fan: GreetingFanProfile): boolean {
  const plain = text.replace(/\[NEXT\]/g, " ").replace(/[’‘]/g, "'");
  if (NAME_QUESTIONS.some((pattern) => pattern.test(plain)) || NICK_QUESTIONS.some((pattern) => pattern.test(plain))) {
    return true;
  }
  const either = EITHER_FORM.exec(plain);
  if (either === null) {
    return false;
  }
  const names = fanNames(fan).map(lettersOf);
  return [either[1]!, either[2]!].some((form) => names.some((name) => name.includes(form.toLowerCase())));
}

export interface FinishedGreeting {
  /** What goes to the chatter: the variants, without the hook line. */
  text: string;
  hook: GreetingHook | null;
  /** One per variant: what it asks. */
  questions: GreetingQuestion[];
  /** Why the hook is not the model's line: it wrote none (`no-line`), or its
   * words are not in the profile (`not-in-profile`). */
  note?: "no-line" | "not-in-profile";
}

/**
 * The model's answer as it goes out. Its hook line is cut and read; an earlier
 * draft's hook for the same profile wins over the line. With no hook every
 * variant is its opener as written (the fan's name in the greeting aside),
 * whatever the model wrote; with a hook a variant that asks about his name or
 * his nick, or that came back empty, is its opener as written too.
 */
export function finishGreeting(input: {
  completion: string;
  openers: readonly string[];
  fan: GreetingFanProfile;
  /** The hook an earlier draft found for this profile (null: none). */
  prior?: GreetingHook | null | undefined;
}): FinishedGreeting {
  const read = readGreetingHookLine(input.completion);
  let hook: GreetingHook | null;
  let note: FinishedGreeting["note"];
  if (input.prior !== undefined) {
    hook = input.prior;
  } else if (!read.declared) {
    hook = null;
    note = "no-line";
  } else if (read.hook !== null && !hookInProfile(read.hook, input.fan)) {
    hook = null;
    note = "not-in-profile";
  } else {
    hook = read.hook;
  }
  const variants = read.text.split("[VARIANT]").map((variant) => variant.trim());
  const questions: GreetingQuestion[] = [];
  const texts = input.openers.map((opener, index) => {
    const variant = variants.length === input.openers.length ? variants[index]! : "";
    const kept = variant !== "" && keepsOpener(opener, variant);
    const personal = hook !== null && variant !== "" && !kept && !asksNameOrNick(variant, input.fan);
    questions.push(personal ? "personal" : "opener");
    return personal || kept ? variant : opener;
  });
  return { text: texts.join("\n[VARIANT]\n"), hook, questions, ...(note !== undefined ? { note } : {}) };
}

/**
 * The gateway's finishing step for a model's greeting: the text that goes
 * out, and the draw's record with the hook and what each variant asks.
 */
export function greetingFinisher(input: {
  openers: readonly string[];
  fan: GreetingFanProfile;
  prior: GreetingHook | null | undefined;
  /** The draw's record so far (greetingOpenersManifest). */
  manifest: Record<string, unknown>;
}): (completion: string) => { text: string; manifest: Record<string, unknown> } {
  return (completion) => {
    const finished = finishGreeting({ completion, openers: input.openers, fan: input.fan, prior: input.prior });
    return {
      text: finished.text,
      manifest: {
        greetingOpeners: {
          ...input.manifest,
          hook: finished.hook?.kind ?? null,
          hookQuote: finished.hook?.quote ?? null,
          questions: finished.questions,
          ...(finished.note !== undefined ? { hookNote: finished.note } : {}),
        },
      },
    };
  };
}

/**
 * The hook an earlier draft of this fan's greeting found, when his profile is
 * the one it was found on: a regenerated greeting asks about the same thing
 * (or about nothing, as before). Undefined when there is no such draft.
 */
export async function findPriorGreetingHook(
  app: Pick<AppContext, "db">,
  input: { pageId: number; conversationRef: string; profile: string },
): Promise<GreetingHook | null | undefined> {
  const prior = await findAiGreetingHook(app.db, { pageId: input.pageId, conversationRef: input.conversationRef });
  if (prior === null || prior.profile !== input.profile) {
    return undefined;
  }
  if (prior.hook === null) {
    return null;
  }
  return HOOK_KINDS.has(prior.hook) && prior.hookQuote !== null && prior.hookQuote !== ""
    ? { kind: prior.hook as GreetingHookKind, quote: prior.hookQuote }
    : undefined;
}
