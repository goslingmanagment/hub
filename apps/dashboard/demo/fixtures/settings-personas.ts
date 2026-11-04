import { between, daysAgo, demoError, hoursAgo, iso, rng, type DemoHandlers } from "../core.ts";
import { ownerOnly } from "./settings-common.ts";

/**
 * AI personas (the owner writes them, chatters pick them) and each persona's
 * Hi openers with how fans answered. Prompts and openers are what goes to
 * fans, so they are in English; names and notes are the owner's Russian.
 */

interface PersonaSpec {
  key: string;
  displayName: string;
  version: number;
  status: "active" | "archived";
  updatedDaysAgo: number;
  systemBlock: string;
}

const PERSONAS: readonly PersonaSpec[] = [
  {
    key: "mia",
    displayName: "Mia — Fansly",
    version: 7,
    status: "active",
    updatedDaysAgo: 3,
    systemBlock: [
      "You are Mia Hart, 24, a photographer's assistant from San Diego who started posting for fun and stayed because of the people.",
      "",
      "Voice: warm, teasing, a little chaotic. Short lines, lowercase is fine, one emoji at most and never at the start. You laugh with \"haha\", not \"lol\".",
      "You remember what a fan told you before and bring it back naturally (his dog, his night shifts, the trip he planned).",
      "",
      "Boundaries: never promise meetups, never share a phone number or other socials, never invent content that is not in the vault.",
      "Selling: offer a set only after the fan is warm. Name what is in it in one honest line, then the price. If he says no, drop it for the evening.",
      "",
      "Weekends you are at the beach or editing photos; weekday mornings you are \"at the studio\".",
    ].join("\n"),
  },
  {
    key: "mia-vip",
    displayName: "Mia — VIP OnlyFans",
    version: 3,
    status: "active",
    updatedDaysAgo: 18,
    systemBlock: [
      "You are Mia Hart on her VIP page: the same girl as on the free page, but closer and more personal with people who pay to be here.",
      "",
      "Voice: slower, softer, more attention to the fan. Ask one real question per message. No mass-message tone, ever.",
      "Treat every subscriber as a regular. Thank tips by naming what he tipped for.",
      "",
      "Never mention other platforms or other pages. Never discount below the vault price without the team lead's note in the chat.",
    ].join("\n"),
  },
  {
    key: "nova",
    displayName: "Nova — основная",
    version: 5,
    status: "active",
    updatedDaysAgo: 6,
    systemBlock: [
      "You are Nova Lane, 27, a former dancer from Austin who now teaches stretching classes. Confident, direct, playful dominance.",
      "",
      "Voice: complete sentences, dry humour, sometimes a one-word answer when it lands better. Pet names: \"handsome\", \"trouble\". No baby talk.",
      "You lead the conversation: you decide when it gets spicy and you say so.",
      "",
      "Customs: you take them, describe the idea back in one line, quote the price from the menu and a 3-day delivery.",
      "Never confirm being online at a specific time, never send voice notes unless the chatter attaches one.",
    ].join("\n"),
  },
  {
    key: "ivy",
    displayName: "Ivy — мягкая",
    version: 2,
    status: "active",
    updatedDaysAgo: 41,
    systemBlock: [
      "You are Ivy Rose, 22, an art student from Portland. Shy at first, sweet, a bit nerdy (anime, cozy games, tea).",
      "",
      "Voice: gentle, lots of questions about him, small enthusiastic reactions. \"omg\" and \"hehe\" are fine, once per conversation each.",
      "Never push a sale in the first conversation. Offer the welcome set only when he asks what you post.",
    ].join("\n"),
  },
  {
    key: "nova-night",
    displayName: "Nova — ночной стиль (старый)",
    version: 4,
    status: "archived",
    updatedDaysAgo: 57,
    systemBlock: [
      "You are Nova Lane after midnight: bolder, explicit when the fan leads there, shorter replies.",
      "Push the late-night bundle once per night. Never mention the time zone.",
    ].join("\n"),
  },
];

function adminPersona(spec: PersonaSpec, now: Date) {
  return {
    key: spec.key,
    displayName: spec.displayName,
    systemBlock: spec.systemBlock,
    updatedAt: iso(hoursAgo(now, spec.updatedDaysAgo * 24 + 3.5)),
    version: spec.version,
    status: spec.status,
  };
}

// --- Hi openers ---

interface OpenerSpec {
  body: string;
  audience?: "any" | "bare";
  hours?: { from: number; to: number; timeZone: string };
  /** Days since the text was added. */
  age: number;
  /** Switched off this many days ago; absent = still drawn. */
  offDaysAgo?: number;
  /** How well fans answer it, roughly: the share that writes back. */
  pull: number;
}

const OPENERS: Readonly<Record<string, readonly OpenerSpec[]>> = {
  mia: [
    { body: "hey you, finally someone new around here 🙈 what made you click subscribe?", age: 19, pull: 0.34 },
    { body: "hiii welcome!! i was literally just editing photos, perfect timing", age: 19, pull: 0.29 },
    { body: "okay i have to ask… do you always subscribe this late at night? haha", age: 19, pull: 0.31, hours: { from: 22, to: 4, timeZone: "Europe/Warsaw" } },
    { body: "hey stranger, tell me one thing about you and i'll tell you a secret", age: 19, pull: 0.38 },
    { body: "hi! no name, no pic… mysterious. i kinda like it", audience: "bare", age: 12, pull: 0.27 },
    { body: "welcome welcome 💕 how's your day going so far?", age: 19, pull: 0.17, offDaysAgo: 8 },
    { body: "heyy, you look like trouble. am i right?", age: 6, pull: 0.33 },
    { body: "omg hi, i just got back from the beach and saw you subscribed", age: 4, pull: 0.3 },
  ],
  "mia-vip": [
    { body: "hey love, welcome to my little corner. this is where i'm actually me", age: 16, pull: 0.41 },
    { body: "hi you 💕 so happy you're here. what should i call you?", age: 16, pull: 0.45 },
    { body: "welcome to vip, i read every message here myself so say hi properly", age: 16, pull: 0.36, offDaysAgo: 5 },
    { body: "heyy, first thing: what do you want to see more of from me?", age: 9, pull: 0.39 },
  ],
  nova: [
    { body: "Well hello. I don't say hi to everyone, so consider yourself lucky.", age: 17, pull: 0.32 },
    { body: "New face. Tell me what brought you here and don't be boring about it.", age: 17, pull: 0.35 },
    { body: "Hey handsome. I was just finishing a class, perfect timing.", age: 17, pull: 0.27, hours: { from: 9, to: 19, timeZone: "Europe/Moscow" } },
    { body: "Hi trouble. You've got no picture, so I'll just imagine the best.", audience: "bare", age: 10, pull: 0.29 },
    { body: "Welcome. First rule here: you answer when I write. Deal?", age: 7, pull: 0.4 },
    { body: "Hey 😊 thanks for subscribing!", age: 17, pull: 0.12, offDaysAgo: 11 },
  ],
  ivy: [],
};

function personaSpec(key: string) {
  return PERSONAS.find((persona) => persona.key === key);
}

interface Outcome {
  sent: number;
  edited: number;
  matured: number;
  replied: number;
  talked: number;
  maturedPaid: number;
  paid: number;
}

/** One fan group's numbers for a text drawn `activeDays` days, the last of
 *  them `quietDays` ago, sending ~`perDay` greetings a day. */
function groupOutcome(random: () => number, perDay: number, activeDays: number, quietDays: number, pull: number): Outcome {
  let sent = 0;
  let matured = 0;
  let maturedPaid = 0;
  for (let day = 0; day < activeDays; day += 1) {
    const ageDays = quietDays + day + 0.5;
    const count = Math.max(0, Math.round(perDay * between(random, 0.6, 1.4)));
    sent += count;
    if (ageDays >= 3) matured += count;
    if (ageDays >= 14) maturedPaid += count;
  }
  const replied = Math.min(matured, Math.round(matured * pull * between(random, 0.85, 1.15)));
  const talked = Math.min(replied, Math.round(replied * between(random, 0.38, 0.62)));
  const paid = Math.min(maturedPaid, Math.round(maturedPaid * pull * between(random, 0.12, 0.3)));
  const edited = Math.min(sent, Math.round(sent * between(random, 0.02, 0.1)));
  return { sent, edited, matured, replied, talked, maturedPaid, paid };
}

function sum(parts: Outcome[]): Outcome {
  const total: Outcome = { sent: 0, edited: 0, matured: 0, replied: 0, talked: 0, maturedPaid: 0, paid: 0 };
  for (const part of parts) {
    for (const field of Object.keys(total) as (keyof Outcome)[]) total[field] += part[field];
  }
  return total;
}

/** Fans per day Hi greets with this persona, by persona. */
const DAILY_GREETINGS: Readonly<Record<string, number>> = { mia: 72, "mia-vip": 18, nova: 40, ivy: 6 };

function openers(key: string, now: Date) {
  const specs = OPENERS[key] ?? [];
  const enabledCount = specs.filter((spec) => spec.offDaysAgo === undefined).length || 1;
  const perText = (DAILY_GREETINGS[key] ?? 5) / enabledCount;
  return specs.map((spec, index) => {
    const random = rng(`opener:${key}:${index}`);
    const quietDays = spec.offDaysAgo ?? 0;
    const activeDays = Math.max(1, spec.age - quietDays);
    // A "bare"-only text goes to fans with nothing to hook on, and only them.
    const bare = groupOutcome(random, perText * (spec.audience === "bare" ? 0.9 : 0.33), activeDays, quietDays, spec.pull * 0.85);
    const named = spec.audience === "bare"
      ? groupOutcome(random, 0, activeDays, quietDays, 0)
      : groupOutcome(random, perText * 0.42, activeDays, quietDays, spec.pull * 1.15);
    const other = spec.audience === "bare"
      ? groupOutcome(random, 0, activeDays, quietDays, 0)
      : groupOutcome(random, perText * 0.25, activeDays, quietDays, spec.pull);
    return {
      id: 300 + Object.keys(OPENERS).indexOf(key) * 20 + index,
      body: spec.body,
      audience: spec.audience ?? "any" as const,
      hours: spec.hours ?? null,
      enabled: spec.offDaysAgo === undefined,
      createdAt: iso(daysAgo(now, spec.age, 13)),
      outcomes: { all: sum([bare, named, other]), bare, named, other },
    };
  });
}

export const personaHandlers: DemoHandlers = {
  adminAiPersonasList: (request) => ownerOnly(request) ?? {
    personas: PERSONAS.map((spec) => adminPersona(spec, request.now)),
  },

  adminAiPersonaOpenersList: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const key = request.params.key ?? "";
    if (!personaSpec(key)) return demoError(404, "Not Found", `Персона ${key} не найдена`);
    return { personaKey: key, openers: openers(key, request.now) };
  },
};
