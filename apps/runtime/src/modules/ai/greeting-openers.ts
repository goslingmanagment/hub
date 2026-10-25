import {
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
// adds his name or a detail of his profile.

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
 * as the openers' numbers read it back (listAiPersonaOpenerOutcomes). */
export function greetingOpenersManifest(personaKey: string, draw: GreetingOpenerDraw): Record<string, unknown> {
  return {
    personaKey,
    ids: draw.openers.map((opener) => opener.id),
    fan: draw.fan,
    mode: draw.asWritten ? "as-written" : "model",
  };
}

/** The text a draw sends as written: the variants in order, as the model
 * separates them. */
export function asWrittenCompletion(draw: GreetingOpenerDraw): string {
  return draw.openers.map((opener) => opener.body).join("\n[VARIANT]\n");
}
