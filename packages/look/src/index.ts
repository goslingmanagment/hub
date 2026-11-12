/**
 * @agency_hub_core/look: Hub's look as data, without React or the DOM.
 *   tokens  the token values (colours in both themes, type, space, shape)
 *   css     the values written out as CSS (Hub's two copies) and helpers for other names
 *   format  money, counts, percents, dates, ranges, durations, Moscow time
 *   moscow  Moscow days: today, Monday, ranges, instants
 *   plural  Russian plural forms
 *   words   the dictionary: one word per thing
 */
/** The vendored package's version: raise it when a client must notice (a name removed or renamed). */
export const LOOK_VERSION = "1.0.0";

export * from "./tokens.js";
export * from "./css.js";
export * from "./format.js";
export * from "./moscow.js";
export * from "./plural.js";
export * from "./words.js";
