// The page's environment (plan §4.1, step 2; spec §6.1 `hello.env`): its
// time zone, its languages and its position, by the region of its SOCKS5.
// They come with the engine's hello and are checked here, strictly, before
// anything uses them: the time zone and the languages go to Chrome's start
// (env/handover.ts) — a root script reads them (s6-rc.d/chrome/run) and
// checks them again by the same rules, which is why the syntax is kept as
// plain POSIX extended expressions the script carries word for word. The
// position is still the hello's (Hub keeps it with the profile) and still
// checked as a value, but Chrome is never given it: the site does not ask
// for one (cdp/control.ts), and a change of it starts nothing again.
//
// - time zone: an IANA name — `Europe/Berlin`, `America/Argentina/Buenos_Aires`,
//   `Etc/GMT+3`, `UTC` — that Node's ICU knows; no offsets, no dots, no
//   leading slash (glibc reads such a TZ as a file);
// - languages: 1 to 10 BCP 47 tags in their canonical form — language,
//   then script and region if any (`de-DE`, `zh-Hant-TW`, `es-419`); no
//   variants or extensions, nothing twice. They are the list Chrome must
//   show as navigator.languages: Chrome puts them first (ForcedLanguages)
//   and then appends its UI language's own defaults that are not there yet
//   — `de-DE` brings `de, en-US, en`, `en-US` brings `en` (Chrome 155 on the
//   image). A list that leaves them out does not match what the browser
//   shows, and the start fails on it (env/check.ts);
// - position: latitude in [-90, 90], longitude in [-180, 180], accuracy in
//   metres above 0.
//
// The screen is not the page's to set: 1920×1080, the X server's geometry
// and Chrome's window (plan §3.1) — read at every start, and a different one
// alarmed (operator.ts).

export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracyM: number;
}

export interface PageEnv {
  timeZone: string;
  languages: string[];
  geolocation: Geolocation;
}

export const MAX_ZONE_LENGTH = 64;
export const MAX_LANGUAGES = 10;

/** An IANA zone name: up to three parts, each starting with a capital. */
export const ZONE_SYNTAX = "^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*){0,2}$";
/** One BCP 47 tag: language, script, region — in canonical case. */
export const TAG_SYNTAX = "[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?";
/** The languages as the hand-over carries them: tags joined by commas. */
export const LANGUAGES_SYNTAX = `^${TAG_SYNTAX}(,${TAG_SYNTAX}){0,${MAX_LANGUAGES - 1}}$`;

/** Chrome's screen: the X server's geometry and the window (plan §3.1). */
export const SCREEN = { width: 1920, height: 1080 } as const;

const ZONE = new RegExp(ZONE_SYNTAX);
const TAG = new RegExp(`^${TAG_SYNTAX}$`);

/** A value of the page's environment that is not allowed. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** What of a refused value may be said: short, and printable. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
}

export function validTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_ZONE_LENGTH || !ZONE.test(value)) throw new EnvError(`env.timeZone ${shown(value)} is not an IANA zone name`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new EnvError(`env.timeZone ${shown(value)} is not a zone ICU knows`);
  }
  return value;
}

export function validLanguages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LANGUAGES) throw new EnvError(`env.languages is not a list of 1 to ${MAX_LANGUAGES} tags`);
  const tags = value.map((tag, index) => {
    if (typeof tag !== "string" || !TAG.test(tag)) throw new EnvError(`env.languages[${index}] ${shown(tag)} is not a language tag (language, script, region)`);
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(tag)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical !== tag) throw new EnvError(`env.languages[${index}] ${shown(tag)} is not in its canonical form${canonical ? ` (${canonical})` : ""}`);
    return tag;
  });
  if (new Set(tags).size !== tags.length) throw new EnvError("env.languages has a tag twice");
  return tags;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new EnvError(`${what} is not a number`);
  return value;
}

export function validGeolocation(value: unknown): Geolocation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EnvError("env.geolocation is not an object");
  const { latitude, longitude, accuracyM } = value as Record<string, unknown>;
  const lat = finite(latitude, "env.geolocation.latitude");
  const lon = finite(longitude, "env.geolocation.longitude");
  const accuracy = finite(accuracyM, "env.geolocation.accuracyM");
  if (lat < -90 || lat > 90) throw new EnvError("env.geolocation.latitude is outside [-90, 90]");
  if (lon < -180 || lon > 180) throw new EnvError("env.geolocation.longitude is outside [-180, 180]");
  if (!(accuracy > 0)) throw new EnvError("env.geolocation.accuracyM is not above 0");
  return { latitude: lat, longitude: lon, accuracyM: accuracy };
}

/** The page's environment, or EnvError naming the first value refused. */
export function validateEnv(value: unknown): PageEnv {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EnvError("env is not an object");
  const env = value as Record<string, unknown>;
  return { timeZone: validTimeZone(env.timeZone), languages: validLanguages(env.languages), geolocation: validGeolocation(env.geolocation) };
}

/** The same environment for Chrome: its time zone and languages (the
 *  position is not given to it). */
export function sameEnv(a: PageEnv, b: PageEnv): boolean {
  return a.timeZone === b.timeZone && a.languages.length === b.languages.length && a.languages.every((tag, index) => tag === b.languages[index]);
}

/** For the journal and the log (nothing in it is a secret). */
export function describeEnv(env: PageEnv): string {
  return `time zone ${env.timeZone}; languages ${env.languages.join(", ")}`;
}
