import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Decision 349 / PLAN §2 "Словарь для пользователя": a chatter knows exactly
// three things — ЛОГИН, ПАРОЛЬ, УСТРОЙСТВА. A device token is internal
// machinery, like a session cookie, and the words for that machinery must never
// reach a screen. This gate reads every user-visible string in the /join and
// /account tree and fails on any of them.
//
// It is deliberately mechanical: copy drifts back into jargon one well-meaning
// sentence at a time, and a reviewer who has read the PLAN is not always the
// one reviewing the change.

const ACCOUNT_DIR = path.resolve("apps/dashboard/src/pages/account");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * One pass over the source that separates code from comments from literals.
 * A naive regex cannot do this: `"https://ext…"` contains a `//` that is not a
 * comment, and a stripped-too-eagerly string swallows the rest of the file.
 *
 * Returns the literals (string and template contents) and a `blanked` copy of
 * the source where comments are gone and literal contents are emptied — so the
 * JSX skeleton survives and its text nodes can be read off it.
 */
function scan(source: string): { literals: string[]; blanked: string } {
  const literals: string[] = [];
  let blanked = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      let literal = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          literal += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        literal += source[index];
        index += 1;
      }
      index += 1;
      // A module specifier is machinery, not copy: `@/api/sdk` is not a
      // sentence anyone reads. Everything else counts.
      if (!/\b(from|import|require\()\s*$/.test(blanked)) literals.push(literal);
      blanked += `${quote}${quote}`;
      continue;
    }
    blanked += char;
    index += 1;
  }
  return { literals, blanked };
}

/** JSX text nodes: what sits between two tags with no expression in it. */
function jsxText(blanked: string): string[] {
  return [...blanked.matchAll(/>([^<>{}]+)</g)]
    .map((match) => match[1]!.trim())
    .filter((text) => text !== "");
}

const FORBIDDEN: { word: string; pattern: RegExp }[] = [
  // Cyrillic: a lookbehind keeps «включить», «подключить» and «деактивация»
  // out of it — only the word itself is banned, not every word containing it.
  { word: "токен", pattern: /(?<![а-яёa-z])токен/iu },
  { word: "ключ", pattern: /(?<![а-яёa-z])ключ/iu },
  { word: "активация", pattern: /(?<![а-яёa-z])активац/iu },
  { word: "резервация", pattern: /(?<![а-яёa-z])резерв/iu },
  { word: "префикс", pattern: /(?<![а-яёa-z])префикс/iu },
  { word: "device token", pattern: /\bdevice[\s-]*token/i },
  { word: "token", pattern: /\btokens?\b/i },
  { word: "key", pattern: /\bkeys?\b/i },
  { word: "API", pattern: /\bapi\b/i },
  { word: "bearer", pattern: /\bbearer\b/i },
];

describe("account copy vocabulary", () => {
  const files = sourceFiles(ACCOUNT_DIR);

  it("covers the whole /join and /account tree", () => {
    // A rename must not silently switch this gate off.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.map((file) => path.basename(file)).sort()).toEqual(
      expect.arrayContaining(["AccountPage.tsx", "JoinPage.tsx", "accountView.ts"]),
    );
  });

  it("never says token, key, API, bearer, activation, reservation or prefix to a person", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const { literals, blanked } = scan(source);
      for (const text of [...literals, ...jsxText(blanked)]) {
        for (const { word, pattern } of FORBIDDEN) {
          if (pattern.test(text)) {
            offenders.push(`${path.relative(ACCOUNT_DIR, file)}: "${text.trim()}" contains "${word}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never renders a sign-in's own metadata", () => {
    // §2: "Метаданные токена (префикс, дата выпуска, срок) пользователю не
    // показываются" — the cabinet shows a label, a client version and a last
    // activity, and the invitation page shows no link metadata at all.
    const offenders = files.filter((file) =>
      /\b(keyPrefix|expiresAt|createdAt)\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(ACCOUNT_DIR, file))).toEqual([]);
  });
});
