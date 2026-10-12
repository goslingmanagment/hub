import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { handoverText, HANDOVER_PATH, writeHandover } from "../apps/page-browser/src/env/handover.ts";
import { EnvError, LANGUAGES_SYNTAX, TAG_SYNTAX, validateEnv, ZONE_SYNTAX, type PageEnv } from "../apps/page-browser/src/env/rules.ts";
import { parseEngineMessage } from "../apps/page-browser/src/rpc/protocol.ts";
import { hello, tempDir } from "./helpers/page-browser-fakes.ts";

// The page's environment (Project Browser plan §4.1, step 2; spec §6.1
// `hello.env`; stage 3, PR 5): strict rules for the engine's values, the
// hand-over to Chrome's start, and the root run script that checks them
// again by the same rules.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeRun = readFileSync(path.join(root, "apps/page-browser/s6/s6-rc.d/chrome/run"), "utf8");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const ENV: PageEnv = { timeZone: "Europe/Berlin", languages: ["de-DE", "de", "en-US", "en"], geolocation: { latitude: 52.52, longitude: 13.405, accuracyM: 35 } };
const withEnv = (patch: Record<string, unknown>) => ({ ...ENV, ...patch });
const withPosition = (patch: Record<string, unknown>) => ({ ...ENV, geolocation: { ...ENV.geolocation, ...patch } });

// Strings a hand-over must never let through, whatever wrote it.
const HOSTILE_ZONES = [
  "Europe/Berlin; touch /tmp/pb-env-pwned",
  "$(touch /tmp/pb-env-pwned)",
  "`touch /tmp/pb-env-pwned`",
  "Europe/Berlin && reboot",
  "../../etc/passwd",
  ":/etc/shadow",
  "/Europe/Berlin",
  "Europe//Berlin",
  "Europe/Berlin\nUTC",
  "Europe/Berlin\r",
  " Europe/Berlin",
  "europe/berlin",
  "+01:00",
  "Ëurope/Berlin",
  "A/B/C/D",
  "",
];
const HOSTILE_LANGUAGES = [
  'en-US"], "ExtensionSettings": {"*": {}}, "x": ["',
  "en-US;q=0.9",
  "en_US",
  "en-us",
  "EN-US",
  "en-US,",
  ",en-US",
  "en-US,,en",
  "en-US en",
  "en-US$(id)",
  "x-private",
  "en-US-u-ca-buddhist",
  "en-US\nde",
  Array.from({ length: 11 }, (_, index) => `e${String.fromCharCode(97 + index)}`).join(","),
  "",
];

describe("the rules (env/rules.ts)", () => {
  it("take the page's values: IANA zones, canonical tags, a position on Earth", () => {
    expect(validateEnv(ENV)).toEqual(ENV);
    for (const timeZone of ["UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+3", "America/Port-au-Prince", "EST5EDT", "Europe/Kyiv", "Asia/Calcutta"]) {
      expect(validateEnv(withEnv({ timeZone })).timeZone).toBe(timeZone);
    }
    for (const languages of [["en-US"], ["zh-Hant-TW", "zh-TW", "zh"], ["es-419", "es"], ["pt-BR", "pt"], ["gsw-CH", "de-CH", "de"]]) {
      expect(validateEnv(withEnv({ languages })).languages).toEqual(languages);
    }
    expect(validateEnv(withPosition({ latitude: -90, longitude: 180, accuracyM: 0.5 })).geolocation).toEqual({ latitude: -90, longitude: 180, accuracyM: 0.5 });
  });

  it("refuse anything else, naming the value", () => {
    const refused: Array<[unknown, RegExp]> = [
      ...HOSTILE_ZONES.map((timeZone): [unknown, RegExp] => [withEnv({ timeZone }), /env\.timeZone/]),
      [withEnv({ timeZone: "Mars/Olympus_Mons" }), /not a zone ICU knows/],
      [withEnv({ timeZone: "Europe/" + "B".repeat(60) }), /env\.timeZone/],
      [withEnv({ timeZone: 3 }), /env\.timeZone/],
      ...HOSTILE_LANGUAGES.filter((list) => list !== "").map((list): [unknown, RegExp] => [withEnv({ languages: list.split(",") }), /env\.languages/]),
      [withEnv({ languages: [] }), /1 to 10 tags/],
      [withEnv({ languages: "en-US" }), /1 to 10 tags/],
      [withEnv({ languages: ["iw"] }), /canonical form \(he\)/],
      [withEnv({ languages: ["en-US", "en-US"] }), /twice/],
      [withEnv({ languages: ["en-US", 7] }), /env\.languages\[1\]/],
      [withPosition({ latitude: 90.0001 }), /latitude is outside/],
      [withPosition({ longitude: -180.5 }), /longitude is outside/],
      [withPosition({ accuracyM: 0 }), /accuracyM is not above 0/],
      [withPosition({ accuracyM: -5 }), /accuracyM is not above 0/],
      [withPosition({ latitude: "52.5" }), /latitude is not a number/],
      [withPosition({ longitude: Number.NaN }), /longitude is not a number/],
      [withEnv({ geolocation: null }), /geolocation is not an object/],
      [null, /env is not an object/],
    ];
    for (const [value, message] of refused) {
      expect(() => validateEnv(value), JSON.stringify(value)).toThrow(EnvError);
      expect(() => validateEnv(value), JSON.stringify(value)).toThrow(message);
    }
  });

  it("make a hello malformed: the protocol refuses it", () => {
    expect(parseEngineMessage(JSON.stringify(hello()))).toMatchObject({ ok: true, message: { env: { timeZone: "Europe/Berlin" } } });
    expect(parseEngineMessage(JSON.stringify(hello({ env: withEnv({ timeZone: "$(reboot)" }) })))).toEqual({ ok: false, error: 'env.timeZone "$(reboot)" is not an IANA zone name' });
    expect(parseEngineMessage(JSON.stringify(hello({ env: withEnv({ languages: ["en-US;q=1"] }) })))).toMatchObject({ ok: false, error: expect.stringMatching(/^env\.languages\[0\]/) });
    expect(parseEngineMessage(JSON.stringify(hello({ env: withPosition({ accuracyM: 0 }) })))).toMatchObject({ ok: false, error: expect.stringMatching(/accuracyM/) });
    expect(parseEngineMessage(JSON.stringify(hello({ env: undefined })))).toMatchObject({ ok: false, error: "env is not an object" });
  });
});

describe("the hand-over (env/handover.ts)", () => {
  it("is two lines, written whole and the operator's alone", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const file = path.join(temp.dir, "chrome-env");
    expect(HANDOVER_PATH).toBe("/run/pb/operator/chrome-env");
    expect(handoverText(ENV)).toBe("TZ=Europe/Berlin\nLANGUAGES=de-DE,de,en-US,en\n");
    writeHandover(file, ENV);
    writeHandover(file, withEnv({ timeZone: "UTC", languages: ["en-US", "en"] }));
    expect(readFileSync(file, "utf8")).toBe("TZ=UTC\nLANGUAGES=en-US,en\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("never carries a value the rules refuse", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const file = path.join(temp.dir, "chrome-env");
    writeHandover(file, ENV);
    expect(() => writeHandover(file, withEnv({ timeZone: "Europe/Berlin\nLANGUAGES=xx" }))).toThrow(EnvError);
    expect(() => handoverText(withEnv({ languages: ["en-US", "de\nTZ=UTC"] }))).toThrow(EnvError);
    expect(readFileSync(file, "utf8")).toBe("TZ=Europe/Berlin\nLANGUAGES=de-DE,de,en-US,en\n");
  });
});

/** The environment part of Chrome's run script, as it is, with the paths
 *  in a temp dir and the read as pb-operator made a plain read; it prints
 *  what Chrome would get. */
function scriptPart(): string {
  const start = chromeRun.indexOf("fail() {");
  const end = chromeRun.indexOf("# --- end of the page's environment ---");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  let part = chromeRun.slice(start, end);
  for (const [from, to] of [
    ["/command/s6-setuidgid pb-operator head", "head"],
    ["HANDOVER=/run/pb/operator/chrome-env", 'HANDOVER="$T/chrome-env"'],
    ["POLICY=/etc/opt/chrome/policies/managed/page.json", 'POLICY="$T/page.json"'],
  ] as const) {
    expect(part).toContain(from);
    part = part.replace(from, to);
  }
  return `set -eu\n${part}\nprintf 'TZ=%s\\nLANGUAGE=%s\\nLANG=%s\\nFIRST=%s\\n' "$TIME_ZONE" "$LANGUAGE_LIST" "$LOCALE" "$FIRST"\n`;
}

function runScript(dir: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", ["-c", scriptPart()], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", T: dir, ...env }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("Chrome's run script (s6-rc.d/chrome/run)", () => {
  it("starts Chrome with the hand-over's zone and languages: TZ, LANGUAGE, LANG and the ForcedLanguages policy", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    for (const [languages, language, locale] of [
      [["de-DE", "de", "en-US", "en"], "de-DE:de:en-US:en", "de_DE.UTF-8"],
      [["zh-Hant-TW", "zh-TW", "zh"], "zh-Hant-TW:zh-TW:zh", "zh_TW.UTF-8"],
      [["es-419", "es"], "es-419:es", "es_419.UTF-8"],
      [["de"], "de", "de.UTF-8"],
    ] as const) {
      writeHandover(path.join(temp.dir, "chrome-env"), withEnv({ languages: [...languages] }));
      const result = runScript(temp.dir, { PB_TZ: "UTC", PB_LANG: "en-US" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`TZ=Europe/Berlin\nLANGUAGE=${language}\nLANG=${locale}\nFIRST=${languages[0]}\n`);
      expect(result.stdout).toContain("(the operator's hand-over)");
      expect(JSON.parse(readFileSync(path.join(temp.dir, "page.json"), "utf8"))).toEqual({ ForcedLanguages: languages });
      expect(statSync(path.join(temp.dir, "page.json")).mode & 0o777).toBe(0o644);
    }
  });

  it("without a hand-over takes the container's defaults, by the same rules", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const result = runScript(temp.dir, { PB_TZ: "America/New_York", PB_LANG: "en-US" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("TZ=America/New_York\nLANGUAGE=en-US\nLANG=en_US.UTF-8\nFIRST=en-US\n");
    expect(result.stdout).toContain("(the container's defaults)");
    expect(JSON.parse(readFileSync(path.join(temp.dir, "page.json"), "utf8"))).toEqual({ ForcedLanguages: ["en-US"] });
    for (const [name, value] of [
      ["PB_TZ", "Europe/Berlin; touch /tmp/pb-env-pwned"],
      ["PB_TZ", "europe/berlin"],
      ["PB_LANG", "en_US"],
    ] as const) {
      const refused = runScript(temp.dir, { PB_TZ: "UTC", PB_LANG: "en-US", [name]: value });
      expect(refused.status, `${name}=${value}`).toBe(1);
      expect(refused.stderr).toMatch(/malformed \(the container's defaults\)/);
    }
  });

  it("refuses a hand-over that breaks the rules, whatever wrote it: Chrome does not start, nothing runs, nothing is printed of it", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const pwned = path.join(temp.dir, "pwned");
    const hostile = [
      ...HOSTILE_ZONES.map((zone) => `TZ=${zone.replaceAll("/tmp/pb-env-pwned", pwned)}\nLANGUAGES=en-US\n`),
      ...HOSTILE_LANGUAGES.map((list) => `TZ=UTC\nLANGUAGES=${list.replaceAll("/tmp/pb-env-pwned", pwned)}\n`),
      "TZ=UTC\nLANGUAGES=en-US\nTZ=Europe/Berlin\n",
      "TZ=UTC\nLANGUAGES=en-US\nEXTRA=1\n",
      "LANGUAGES=en-US\nTZ=UTC\n",
      "TZ=UTC\r\nLANGUAGES=en-US\r\n",
      "TZ=UTC\nX\nLANGUAGES=en-US\n",
      "TZ=UTC\n",
      "",
      `TZ=UTC\nLANGUAGES=${"en-US,".repeat(300)}en\n`,
    ];
    for (const text of hostile) {
      writeFileSync(path.join(temp.dir, "page.json"), "untouched");
      writeFileSync(path.join(temp.dir, "chrome-env"), text);
      const result = runScript(temp.dir, { PB_TZ: "UTC", PB_LANG: "en-US" });
      expect(result.status, JSON.stringify(text)).toBe(1);
      expect(result.stderr, JSON.stringify(text)).toMatch(/^chrome: the (time zone|languages|page's environment) (is|are) malformed \(the operator's hand-over\)\n$/);
      expect(readFileSync(path.join(temp.dir, "page.json"), "utf8")).toBe("untouched");
      expect(existsSync(pwned), JSON.stringify(text)).toBe(false);
    }
  });

  it("reads the hand-over with the operator's rights: a link to another file gives nothing away", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const secret = path.join(temp.dir, "rpc_token");
    writeFileSync(secret, "S3CRET-0123456789abcdef\n");
    symlinkSync(secret, path.join(temp.dir, "chrome-env"));
    const result = runScript(temp.dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("S3CRET");
    // A link that leads nowhere is not "no hand-over": no defaults then.
    symlinkSync(path.join(temp.dir, "missing"), path.join(temp.dir, "dangling"));
    const dangling = spawnSync("sh", ["-c", scriptPart().replace('HANDOVER="$T/chrome-env"', 'HANDOVER="$T/dangling"')], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", T: temp.dir }, encoding: "utf8" });
    expect(dangling.status).toBe(1);
    expect(dangling.stderr).toMatch(/cannot be read/);
    // As pb-operator in the image: the read is the operator's own.
    expect(chromeRun).toContain('handover="$(/command/s6-setuidgid pb-operator head -c 1024 -- "$HANDOVER")"');
  });

  it("checks by the operator's rules, the same expressions, the same answers", () => {
    expect(chromeRun).toContain(`ZONE_RE='${ZONE_SYNTAX}'`);
    expect(chromeRun).toContain(`TAG_RE='${TAG_SYNTAX}'`);
    expect(LANGUAGES_SYNTAX).toBe(`^${TAG_SYNTAX}(,${TAG_SYNTAX}){0,9}$`);
    expect(chromeRun).toContain('LANGUAGES_RE="^$TAG_RE(,$TAG_RE){0,9}\\$"');
    // The script's `matches` and the operator's expressions agree on every sample.
    const definitions = chromeRun.slice(chromeRun.indexOf("ZONE_RE="), chromeRun.indexOf("\nif [ -e"));
    const samples: Array<[string, "ZONE_RE" | "LANGUAGES_RE", RegExp]> = [
      ...["Europe/Berlin", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+3", "EST5EDT", ...HOSTILE_ZONES].map((value): [string, "ZONE_RE", RegExp] => [value, "ZONE_RE", new RegExp(ZONE_SYNTAX)]),
      ...["en-US", "en-US,en", "zh-Hant-TW,zh-TW,zh", "es-419,es", "de", ...HOSTILE_LANGUAGES].map((value): [string, "LANGUAGES_RE", RegExp] => [value, "LANGUAGES_RE", new RegExp(LANGUAGES_SYNTAX)]),
    ];
    for (const [value, variable, expression] of samples) {
      const result = spawnSync("sh", ["-c", `set -eu\n${definitions}\nmatches "$V" "$${variable}"`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", V: value }, encoding: "utf8" });
      expect(result.status === 0, `${variable} ${JSON.stringify(value)}`).toBe(expression.test(value));
    }
  });
});
