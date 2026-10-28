import { BUNDLED_LORA_PERSONALITY_ID } from "./prompts/index.ts";

export interface PersonaLocalTime {
  /** The place the prompt's clock line names. */
  place: string;
  /** IANA time zone of that place. */
  timeZone: string;
}

// Where each persona lives, keyed by its key (ai_personas.key), for the
// model's local time in the prompt's `Now:` line (prompts/builder.ts
// {nowLine}). A persona without an entry gets no local time: the line never
// guesses one.
const PERSONA_LOCAL_TIME: Readonly<Record<string, PersonaLocalTime>> = {
  // Lora's persona: Minsk (UTC+3 all year).
  [BUNDLED_LORA_PERSONALITY_ID]: { place: "Minsk", timeZone: "Europe/Minsk" },
  // Lora's Telegram persona (chat-extension, 2026-10-28): the same Lora.
  "lora-telegram": { place: "Minsk", timeZone: "Europe/Minsk" },
};

export function personaLocalTime(personaKey: string): PersonaLocalTime | undefined {
  return Object.hasOwn(PERSONA_LOCAL_TIME, personaKey) ? PERSONA_LOCAL_TIME[personaKey] : undefined;
}
