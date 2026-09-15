import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
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
 * The copy is extracted with the TypeScript parser, not a regex. The first
 * version of this gate matched `>([^<>{}]+)<` and was therefore blind to every
 * JSX text node containing an interpolation — `<p>Токен {name} истёк</p>`
 * passed it silently, which is precisely the shape real copy has. A parser
 * sees each text segment around `{…}` as its own JsxText node, so the hole
 * cannot come back.
 *
 * `TechnicalTab.tsx` is excluded BY NAME: it is the one screen that is about
 * machines (agent keys, harvest machine ids) and is allowed to say so.
 */

const TEAM_DIR = path.resolve("apps/dashboard/src/pages/settings/team");
const EXCLUDED_FILES = new Set(["TechnicalTab.tsx"]);

// Shared components that render INSIDE the Team tab. Their copy reaches the
// same screen, so it lives under the same rule; they are clean today and this
// keeps them that way.
const SHARED_IN_TEAM = [
  "apps/dashboard/src/pages/settings/PageAssignmentsEditor.tsx",
  "apps/dashboard/src/components/shared/ConfirmModal.tsx",
  "apps/dashboard/src/components/shared/ModalShell.tsx",
  "apps/dashboard/src/components/shared/StaleDataNotice.tsx",
  "apps/dashboard/src/components/shared/StatusPanel.tsx",
].map((relative) => path.resolve(relative));

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
 * Everything a person can read on screen: JSX text (each segment around an
 * interpolation), string literals and the static parts of template literals.
 *
 * Left out on purpose: comments (they explain the machinery deliberately),
 * import/export module specifiers (`@/api/queries` is a path, not a sentence)
 * and `className` values (a Tailwind class list is not copy).
 */
export function extractUserFacingText(source: string, fileName = "file.tsx"): string[] {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    if (ts.isJsxAttribute(node) && node.name.getText(parsed) === "className") {
      return;
    }
    if (ts.isJsxText(node)) {
      found.push(node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead
      || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail
    ) {
      found.push((node as ts.TemplateLiteralLikeNode).text);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return found.filter((text) => text.trim() !== "");
}

/** Recursive: a subdirectory of team/ is still the Team tab. */
function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (EXCLUDED_FILES.has(entry.name)) return [];
    return [full];
  });
}

function offendersIn(file: string): string[] {
  const texts = extractUserFacingText(readFileSync(file, "utf8"), path.basename(file));
  return texts.flatMap((text) => (
    BANNED.filter(({ pattern }) => pattern.test(text)).map(({ label }) => `${label}: ${text.trim()}`)
  ));
}

describe("Team tab copy vocabulary (§2)", () => {
  const files = [...collectFiles(TEAM_DIR), ...SHARED_IN_TEAM];
  const names = files.map((file) => path.basename(file));

  it("scans every shipped Team file and the shared components rendered inside it", () => {
    expect(names).toEqual(expect.arrayContaining([
      "TeamTab.tsx",
      "InviteModal.tsx",
      "LinkRevealModal.tsx",
      "UserDetailModal.tsx",
      "teamView.ts",
      "PageAssignmentsEditor.tsx",
      "ConfirmModal.tsx",
      "ModalShell.tsx",
      "StaleDataNotice.tsx",
      "StatusPanel.tsx",
    ]));
    expect(names).not.toContain("TechnicalTab.tsx");
  });

  it.each(files.map((file) => [path.basename(file), file] as const))(
    "%s speaks about logins, devices and links only",
    (_name, file) => {
      expect(offendersIn(file)).toEqual([]);
    },
  );

  // A gate that cannot fail is not a gate. These are the exact shapes the rule
  // exists to keep out — including the interpolated JSX node the previous
  // regex-based extractor walked straight past.
  it("sees copy split by an interpolation, in either half", () => {
    const interpolated = extractUserFacingText(
      "export const view = <p>Токен {u.name} истёк, введите ключ</p>;",
    );
    expect(interpolated.join("|")).toContain("Токен");
    expect(interpolated.join("|")).toContain("введите ключ");
    expect(interpolated.some((text) => BANNED.some(({ pattern }) => pattern.test(text)))).toBe(true);
  });

  it("sees copy inside a template literal around its interpolations", () => {
    const templated = extractUserFacingText('const m = `Ваш ключ ${id} отозван`;', "file.ts");
    expect(templated.some((text) => BANNED.some(({ pattern }) => pattern.test(text)))).toBe(true);
  });

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

  it("reads copy but not comments, import paths or class lists", () => {
    const texts = extractUserFacingText([
      'import { kernel } from "@/api/queries";',
      "// a device token is machinery",
      "/* the key lives in the result */",
      'const label = "Устройства";',
      'export const view = <span className="prefix-token-key">Завершить вход</span>;',
    ].join("\n"));

    expect(texts).toContain("Устройства");
    expect(texts).toContain("Завершить вход");
    const joined = texts.join("\n");
    expect(joined).not.toContain("device token");
    expect(joined).not.toContain("@/api/queries");
    expect(joined).not.toContain("prefix-token-key");
  });
});
