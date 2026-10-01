import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Decisions 350 and 351 / plan §2 — the vocabulary a person reads, pinned.
 *
 * A device token is machinery, like a session cookie. A chatter knows three
 * things — a login, a password and the devices they are signed in on — and the
 * cabinet, the invitation page and the owner's Team tab must speak the same
 * words, or the owner ends up explaining "the token expired" to someone who has
 * never heard of one. Copy drifts back into jargon one well-meaning sentence at
 * a time, so this gate reads the shipped copy rather than trusting review.
 *
 * The copy is extracted with the TypeScript parser, not a regex: inside a .tsx
 * `useState<string>(x)` looks exactly like a tag, `//` inside a URL looks like a
 * comment, and `<p>Токен {name} истёк</p>` is one sentence to the eye but never
 * one `>…<` match. The regex versions of this gate had all three bugs and said
 * so by passing. The parser also splits a text node at each interpolation, so
 * the halves around `{name}` are scanned separately and never glued into a word
 * nobody wrote.
 */

const ROOT = path.resolve("apps/dashboard/src");

// The cabinet is NOT just `pages/account`: half of what is on screen at
// /account — the header, the "checking your sign-in" states, the sign-out
// button — is ChatterLayout.
const CABINET = ["pages/account", "components/layout/ChatterLayout.tsx"];

// The Team tab and the shared components rendered inside it. `TechnicalTab.tsx`
// is excluded BY NAME: it is the one screen that is about machines (agent keys,
// harvest machine ids) and is allowed to say so.
const TEAM = [
  "pages/settings/team",
  "pages/settings/PageAssignmentsEditor.tsx",
  "components/shared/ConfirmModal.tsx",
  "components/shared/ModalShell.tsx",
  "components/shared/StaleDataNotice.tsx",
  "components/shared/StatusPanel.tsx",
];
const EXCLUDED_FILES = new Set(["TechnicalTab.tsx"]);

// A text is banned if any pattern of a word matches. The Latin words keep both
// boundary rules the two earlier gates used (`\b` and "no letter around"),
// since neither contains the other. Cyrillic: the lookbehind keeps «включить»,
// «подключить» and «деактивация» out — only the word itself is banned.
const BANNED: { word: string; patterns: RegExp[] }[] = [
  { word: "токен", patterns: [/(?<![а-яёa-z])токен/iu] },
  { word: "ключ", patterns: [/(?<![а-яёa-z])ключ/iu] },
  { word: "активация", patterns: [/(?<![а-яёa-z])активац/iu] },
  { word: "резервация", patterns: [/(?<![а-яёa-z])резерв/iu] },
  { word: "префикс", patterns: [/(?<![а-яёa-z])префикс/iu] },
  { word: "device token", patterns: [/\bdevice[\s-]*token/i] },
  { word: "token", patterns: [/\btokens?\b/i, /(?<!\p{L})tokens?(?!\p{L})/iu] },
  { word: "key", patterns: [/\bkeys?\b/i, /(?<!\p{L})keys?(?!\p{L})/iu] },
  { word: "API", patterns: [/\bapi\b/i, /(?<!\p{L})api(?!\p{L})/iu] },
  { word: "bearer", patterns: [/\bbearer\b/i, /(?<!\p{L})bearer/iu] },
  { word: "activation", patterns: [/(?<!\p{L})activation/iu] },
  { word: "reservation", patterns: [/(?<!\p{L})reservation/iu] },
  { word: "prefix", patterns: [/(?<!\p{L})prefix/iu] },
];

function bannedWords(text: string): string[] {
  return BANNED.filter(({ patterns }) => patterns.some((pattern) => pattern.test(text))).map(({ word }) => word);
}

/**
 * Everything a person can read on screen: JSX text (each segment around an
 * interpolation), string literals and the static parts of template literals.
 * Left out on purpose: comments, module specifiers (static and dynamic import)
 * and `className` values (a Tailwind class list is not copy).
 */
function readableText(source: string, fileName = "probe.tsx"): string[] {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxAttribute(node) && node.name.getText(parsed) === "className") return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    if (ts.isJsxText(node)) {
      found.push(node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return found.filter((text) => text.trim() !== "");
}

function violations(source: string, fileName?: string): string[] {
  return readableText(source, fileName).flatMap(bannedWords);
}

/** Recursive: a subdirectory is still the same surface. */
function sourceFiles(target: string): string[] {
  const full = path.resolve(ROOT, target);
  if (/\.tsx?$/.test(full)) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (EXCLUDED_FILES.has(entry.name)) return [];
    return entry.isDirectory() || /\.tsx?$/.test(entry.name) ? sourceFiles(path.join(full, entry.name)) : [];
  });
}

// The gate's own falsifiability: every case is a shape an earlier version of
// this gate let through. If this table ever passes by finding nothing, the
// gate below is decoration.
describe("the vocabulary gate itself", () => {
  it.each([
    ["an interpolation interrupts the copy", "<p>Твой ключ {id} истёк</p>", ["ключ"]],
    ["the banned word follows an interpolation", "<p>{name}, твой токен просрочен</p>", ["токен"]],
    ["either half of an interpolated node", "export const view = <p>Токен {u.name} истёк, введите ключ</p>;", ["токен", "ключ"]],
    ["several interpolations, attributes and nested braces", '<p style={{ color: "red" }}>Вход {a} по ключу {b} истёк</p>', ["ключ"]],
    ["copy nested inside an expression", "function Card() {\n  return (\n    <div>\n      {ok ? <p>Твой ключ истёк</p> : null}\n      <span>Выйти</span>\n    </div>\n  );\n}", ["ключ"]],
    ["a plain string", 'const a = "Введите API-ключ";', ["ключ", "API"]],
    ["the halves of a template literal", "const a = `срок действия токена ${x} истёк`;", ["токен"]],
    ["two halves of a word nobody wrote", "<p>клю{x}ч</p>", []],
    ["words that merely contain a banned one", "<p>Включите расширение, подключите страницу, деактивация отменена</p>", []],
    ["English words that merely contain one", "<p>The rapid, capable chapter</p>", []],
    ["a generic that looks like a tag, a URL that looks like a comment", 'const [v] = useState<string | null>(null);\nconst u = "https://ext.gosling-agency.ru/start.html";', []],
    ["module specifiers", 'import { kernel } from "@/api/sdk";\nconst p = import("./pages/api-keys.js");', []],
    ["comments and class lists", '// the device token and the API key live here\n/* the key lives in the result */\nexport const v = <span className="prefix-token-key">Готово</span>;', []],
  ])("finds what a person reads: %s", (_case, source, expected) => {
    expect(violations(source)).toEqual(expected);
  });

  it("reads a template literal in a .ts file", () => {
    expect(violations("const m = `Ваш ключ ${id} отозван`;", "file.ts")).toEqual(["ключ"]);
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
    expect(bannedWords(sample)).not.toEqual([]);
  });

  it.each([
    "Человек активен и деактивирован не был",
    "Пригласить в команду",
    "Завершить вход на устройстве",
    "Отозвать все устройства",
    "Ссылка показывается один раз",
  ])("allows %s", (sample) => {
    expect(bannedWords(sample)).toEqual([]);
  });
});

describe("copy vocabulary of the cabinet and the Team tab", () => {
  const cabinet = CABINET.flatMap(sourceFiles);
  const files = [...cabinet, ...TEAM.flatMap(sourceFiles)];

  it("covers every file a chatter or the owner's Team tab shows, chrome included", () => {
    // A rename must not silently switch this gate off.
    const names = files.map((file) => path.basename(file));
    expect(names).toEqual(expect.arrayContaining([
      "AccountPage.tsx", "ChatterLayout.tsx", "JoinPage.tsx", "accountView.ts",
      "TeamTab.tsx", "InviteModal.tsx", "LinkRevealModal.tsx", "UserDetailModal.tsx", "teamView.ts",
      "PageAssignmentsEditor.tsx", "ConfirmModal.tsx", "ModalShell.tsx", "StaleDataNotice.tsx", "StatusPanel.tsx",
    ]));
    expect(names).not.toContain("TechnicalTab.tsx");
  });

  it.each(files.map((file) => [path.relative(ROOT, file), file] as const))(
    "%s speaks about logins, devices and links only",
    (_name, file) => {
      const offenders = readableText(readFileSync(file, "utf8"), file)
        .flatMap((text) => bannedWords(text).map((word) => `"${text.trim()}" contains "${word}"`));
      expect(offenders).toEqual([]);
    },
  );

  it("never renders a sign-in's own metadata in the cabinet", () => {
    // §2: "Метаданные токена (префикс, дата выпуска, срок) пользователю не
    // показываются" — the cabinet shows a label, a client version and a last
    // activity, and the invitation page shows no link metadata at all.
    const offenders = cabinet.filter((file) =>
      /\b(keyPrefix|expiresAt|createdAt)\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
