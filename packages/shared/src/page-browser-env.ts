// A page's browser environment — its time zone, its languages and its
// position (Project Browser plan §4.1 step 2, spec §6.1 `hello.env`) —
// proposed from where its proxy goes out, as antidetect browsers do (owner
// decision 2026-10-15), and checked before the owner saves it. The operator
// checks it again, by its own rules (`apps/page-browser/src/env/rules.ts`),
// and the browser's start compares what Chrome shows with it: this is the
// proposal and the early word, not the guard. Browser-safe: no Node module.

export interface BrowserEnv {
  timeZone: string;
  languages: string[];
  geolocation: { latitude: number; longitude: number; accuracyM: number };
}

/** The position's accuracy proposed for an IP's place: the IP-info services
 *  name a city, not a street. */
export const PROPOSED_ACCURACY_M = 1000;

/** The operator's syntax (env/rules.ts): an IANA zone name, a BCP 47 tag of
 *  language, script and region, at most 10 tags. */
export const BROWSER_ENV_ZONE_SYNTAX = "^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*){0,2}$";
export const BROWSER_ENV_TAG_SYNTAX = "[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?";
export const BROWSER_ENV_MAX_LANGUAGES = 10;

const ZONE = new RegExp(BROWSER_ENV_ZONE_SYNTAX);
const TAG = new RegExp(`^${BROWSER_ENV_TAG_SYNTAX}$`);

/** The main language of a country, for the browser's first language (the
 *  country's region appended). A country not listed gets English (US). */
const COUNTRY_LANGUAGE: Readonly<Record<string, string>> = {
  US: "en", GB: "en", IE: "en", CA: "en", AU: "en", NZ: "en", ZA: "en", NG: "en", KE: "en", GH: "en", SG: "en", PH: "en",
  IN: "en", PK: "ur", BD: "bn", LK: "si", MT: "en", JM: "en", TT: "en",
  DE: "de", AT: "de", CH: "de", LI: "de", LU: "fr", BE: "nl", NL: "nl", FR: "fr", MC: "fr",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", VE: "es", EC: "es", GT: "es", CU: "es", BO: "es", DO: "es",
  HN: "es", PY: "es", SV: "es", NI: "es", CR: "es", PA: "es", UY: "es", PR: "es",
  PT: "pt", BR: "pt", AO: "pt", MZ: "pt", IT: "it", SM: "it", VA: "it",
  PL: "pl", CZ: "cs", SK: "sk", HU: "hu", RO: "ro", MD: "ro", BG: "bg", GR: "el", CY: "el", TR: "tr",
  RU: "ru", BY: "ru", KZ: "ru", KG: "ru", UA: "uk", LT: "lt", LV: "lv", EE: "et",
  FI: "fi", SE: "sv", NO: "nb", DK: "da", IS: "is",
  HR: "hr", RS: "sr", SI: "sl", BA: "bs", ME: "sr", MK: "mk", AL: "sq", GE: "ka", AM: "hy", AZ: "az", UZ: "uz",
  IL: "he", IR: "fa", AE: "ar", SA: "ar", EG: "ar", MA: "ar", DZ: "ar", TN: "ar", JO: "ar", LB: "ar", KW: "ar", QA: "ar",
  BH: "ar", OM: "ar", IQ: "ar",
  JP: "ja", KR: "ko", CN: "zh", TW: "zh", HK: "zh", MO: "zh", TH: "th", VN: "vi", ID: "id", MY: "ms", KH: "km",
};

/** A tag in its canonical form, or null (Intl's word). */
function canonicalTag(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The languages proposed for a country: its language with its region, the
 * language alone, then English (US) — the list Chrome shows when its UI
 * language is the first one: Chrome appends its UI language's defaults it
 * does not see (`de-DE` brings `de, en-US, en`), and the browser's start
 * fails when the page's list leaves them out (env/check.ts). The defaults
 * seen so far are the language with and without its region and English
 * (US), so the list carries them already; where a Chrome adds another, its
 * start says which, and the owner adds it.
 */
export function languagesForCountry(countryCode: string | null): string[] {
  const country = countryCode?.toUpperCase() ?? null;
  const language = country === null ? undefined : COUNTRY_LANGUAGE[country];
  if (country === null || language === undefined) return ["en-US", "en"];
  const regional = canonicalTag(`${language}-${country}`);
  const list = [regional, language, "en-US", "en"].filter((tag): tag is string => tag !== null);
  return [...new Set(list)];
}

/** Why a time zone cannot be the browser's, or null. */
export function browserTimeZoneProblem(value: string): string | null {
  if (value.length === 0) return "Нет часового пояса";
  if (value.length > 64 || !ZONE.test(value)) return `«${value}» — не название часового пояса (например, Europe/Berlin)`;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    return `Часовой пояс «${value}» неизвестен`;
  }
  return null;
}

/** Why a list of languages cannot be the browser's, or null. */
export function browserLanguagesProblem(languages: readonly string[]): string | null {
  if (languages.length === 0) return "Нет языков";
  if (languages.length > BROWSER_ENV_MAX_LANGUAGES) return `Не больше ${BROWSER_ENV_MAX_LANGUAGES} языков`;
  for (const tag of languages) {
    if (!TAG.test(tag)) return `«${tag}» — не код языка (например, de-DE или en)`;
    const canonical = canonicalTag(tag);
    if (canonical !== tag) return `«${tag}» пишется как «${canonical ?? "?"}»`;
  }
  if (new Set(languages).size !== languages.length) return "Язык повторяется";
  return null;
}

/** Why a position cannot be the browser's, or null. */
export function browserGeolocationProblem(geolocation: BrowserEnv["geolocation"]): string | null {
  const { latitude, longitude, accuracyM } = geolocation;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return "Широта — число от −90 до 90";
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return "Долгота — число от −180 до 180";
  if (!Number.isFinite(accuracyM) || accuracyM <= 0) return "Точность — число метров больше нуля";
  return null;
}

/** Why the environment cannot be the browser's (the first reason), or null. */
export function browserEnvProblem(env: BrowserEnv): string | null {
  return browserTimeZoneProblem(env.timeZone) ?? browserLanguagesProblem(env.languages) ?? browserGeolocationProblem(env.geolocation);
}

/** Where a proxy goes out, as an IP-info service names it. */
export interface ProxyExitPlace {
  countryCode: string | null;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * The environment proposed for the exit's place: its time zone, the
 * country's languages, its coordinates — or null when the service did not
 * name a usable time zone or position (the owner fills them in).
 */
export function proposeBrowserEnv(place: ProxyExitPlace): BrowserEnv | null {
  if (place.timeZone === null || browserTimeZoneProblem(place.timeZone) !== null) return null;
  if (place.latitude === null || place.longitude === null) return null;
  const env: BrowserEnv = {
    timeZone: place.timeZone,
    languages: languagesForCountry(place.countryCode),
    // Four decimals: the services' own precision (about 11 m).
    geolocation: { latitude: Math.round(place.latitude * 1e4) / 1e4, longitude: Math.round(place.longitude * 1e4) / 1e4, accuracyM: PROPOSED_ACCURACY_M },
  };
  return browserEnvProblem(env) === null ? env : null;
}
