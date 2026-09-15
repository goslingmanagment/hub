import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Decision 348 / plan §2 — the owner's vocabulary, pinned.
 *
 * A device token is machinery, like a session cookie. The person on the other
 * end of Telegram knows three things — a login, a password and the devices
 * they are signed in on — and the owner's console must speak the same words,
 * or the owner ends up explaining "the token expired" to a chatter who has
 * never heard of one. Copy that slips back into the machinery vocabulary is a
 * regression, so this gate reads the shipped copy rather than trusting review.
 *
 * `TechnicalTab.tsx` is excluded BY NAME: it is the one screen that is about
 * machines (agent keys, harvest machine ids) and is allowed to say so.
 */

const TEAM_DIR = path.resolve("apps/dashboard/src/pages/settings/team");
const EXCLUDED_FILES = new Set(["TechnicalTab.tsx"]);

const BANNED = [
  { label: "токен", pattern: /(?<!\p{L})токен/iu },
  { label: "token / device token", pattern: /(?<!\p{L})tokens?(?!\p{L})/iu },
  { label: "ключ", pattern: /(?<!\p{L})ключ/iu },
  { label: "key", pattern: /(?<!\p{L})keys?(?!\p{L})/iu },
  { label: "API", pattern: /(?<!\p{L})api(?!\p{L})/iu },
  { label: "bearer", pattern: /(?<!\p{L})bearer/iu },
  { label: "активация", pattern: /(?<!\p{L})активаци/iu },
  { label: "activation", pattern: /(?<!\p{L})activation/iu },
  { label: "резервация", pattern: /(?<!\p{L})резерваци/iu },
  { label: "reservation", pattern: /(?<!\p{L})reservation/iu },
  { label: "префикс", pattern: /(?<!\p{L})префикс/iu },
  { label: "prefix", pattern: /(?<!\p{L})prefix/iu },
] as const;

/**
 * Everything a person can read on screen: string and template literals plus
 * JSX text. Comments are dropped (they explain the machinery on purpose) and
 * so are import specifiers (`@/api/queries` is a path, not a sentence).
 */
export function extractUserFacingText(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line) && !/\bfrom\s+["']/.test(line))
    .join("\n");

  const literals: string[] = [];
  let stripped = "";
  let index = 0;

  while (index < code.length) {
    const char = code[index]!;
    const next = code[index + 1];

    if (char === "/" && next === "/") {
      while (index < code.length && code[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < code.length && code[index] !== quote) {
        if (code[index] === "\\") {
          value += code[index + 1] ?? "";
          index += 2;
          continue;
        }
        value += code[index];
        index += 1;
      }
      index += 1;
      literals.push(value);
      stripped += '""';
      continue;
    }

    stripped += char;
    index += 1;
  }

  const jsxText = [...stripped.matchAll(/>([^<>{}]+)</g)].map((match) => match[1]!);
  return [...literals, ...jsxText].filter((text) => text.trim() !== "");
}

function teamFiles(): string[] {
  return readdirSync(TEAM_DIR)
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) => !EXCLUDED_FILES.has(name))
    .filter((name) => statSync(path.join(TEAM_DIR, name)).isFile());
}

describe("Team tab copy vocabulary (§2)", () => {
  const files = teamFiles();

  it("scans the shipped Team files", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("TeamTab.tsx");
    expect(files).toContain("InviteModal.tsx");
    expect(files).toContain("LinkRevealModal.tsx");
    expect(files).toContain("UserDetailModal.tsx");
    expect(files).not.toContain("TechnicalTab.tsx");
  });

  it.each(files)("%s speaks about logins, devices and links only", (name) => {
    const texts = extractUserFacingText(readFileSync(path.join(TEAM_DIR, name), "utf8"));
    const offenders = texts.flatMap((text) => (
      BANNED.filter(({ pattern }) => pattern.test(text)).map(({ label }) => `${label}: ${text.trim()}`)
    ));
    expect(offenders).toEqual([]);
  });

  // A gate that cannot fail is not a gate: these are the exact phrasings the
  // rule exists to keep out, in both languages.
  it.each([
    "Токен устройства истёк",
    "Ваш device token отозван",
    "Скопируйте ключ и отправьте чаттеру",
    "Copy the key and send it over",
    "Введите API-ключ",
    "Authorization: Bearer …",
    "Ожидает активации",
    "Резервация истекла",
    "Префикс: agency_hub_core_",
    "Prefix: agency_hub_core_",
  ])("rejects %s", (sample) => {
    expect(BANNED.some(({ pattern }) => pattern.test(sample))).toBe(true);
  });

  it.each([
    "Человек активен и деактивирован не был",
    "Пригласить в команду",
    "Завершить вход на устройстве",
    "Отозвать все устройства",
    "Ссылка показывается один раз",
  ])("allows %s", (sample) => {
    expect(BANNED.filter(({ pattern }) => pattern.test(sample))).toEqual([]);
  });

  it("reads literals and JSX text but not comments or import paths", () => {
    const texts = extractUserFacingText([
      'import { kernel } from "@/api/queries";',
      "// a device token is machinery",
      "/* the key lives in the result */",
      'const label = "Устройства";',
      "export const view = <span>Завершить вход</span>;",
    ].join("\n"));

    expect(texts).toContain("Устройства");
    expect(texts).toContain("Завершить вход");
    expect(texts.join("\n")).not.toContain("device token");
    expect(texts.join("\n")).not.toContain("@/api/queries");
  });
});
