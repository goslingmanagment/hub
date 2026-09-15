import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// Decision 349 / PLAN §2 "Словарь для пользователя": a chatter knows exactly
// three things — ЛОГИН, ПАРОЛЬ, УСТРОЙСТВА. A device token is internal
// machinery, like a session cookie, and the words for that machinery must never
// reach a screen. This gate reads every user-visible string on the chatter's
// surface and fails on any of them.
//
// It is deliberately mechanical: copy drifts back into jargon one well-meaning
// sentence at a time, and a reviewer who has read the PLAN is not always the
// one reviewing the change.

// Every file a chatter's eyes land on. The cabinet is NOT just `pages/account`:
// half of what is on screen at /account — the header, the "checking your
// sign-in" states, the sign-out button — is ChatterLayout, and a gate that
// stopped at the page directory would wave all of it through.
const ROOT = path.resolve("apps/dashboard/src");
const SCANNED = [
  "pages/account",
  "components/layout/ChatterLayout.tsx",
];

function sourceFiles(target: string): string[] {
  const full = path.resolve(ROOT, target);
  if (!statSync(full).isDirectory()) return /\.tsx?$/.test(full) ? [full] : [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    sourceFiles(path.join(full, entry.name)),
  );
}

/**
 * Everything in this source that a person could read: JSX text and string /
 * template literals, minus module specifiers and comments.
 *
 * Parsed with the TypeScript parser rather than matched with a regex, because
 * inside a .tsx the two are genuinely ambiguous to a regex: `useState<string>(x)`
 * looks exactly like a tag, `//` inside a URL looks exactly like a comment, and
 * `<p>Привет, {name}! Придумай пароль</p>` is one sentence to the eye but never
 * one `>…<` match. The first version of this gate used regexes and had all
 * three bugs — it read no text at all out of a component whose braces nested,
 * and said so by passing. The parser gives the same answer the compiler does.
 *
 * The parser also splits a text node at each interpolation, so the halves
 * around `{name}` are scanned separately and are never glued into a word that
 * nobody wrote.
 */
function readableText(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const texts: string[] = [];

  function isModuleSpecifier(node: ts.Node): boolean {
    const parent = node.parent;
    if (!parent) return false;
    if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) {
      return true;
    }
    // A dynamic `import("…")`.
    return ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword;
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      texts.push(node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node)) texts.push(node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return texts;
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

/** Every forbidden word a person could read in this source. */
function violations(source: string, fileName = "probe.tsx"): string[] {
  return readableText(source, fileName).flatMap((text) =>
    FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word),
  );
}

// The gate's own falsifiability. Every case here is a shape the first version
// of this gate let through; if this block ever goes green by finding nothing,
// the gate below is decoration.
describe("the vocabulary gate itself", () => {
  it("reads copy that an interpolation interrupts", () => {
    expect(violations("<p>Твой ключ {id} истёк</p>")).toEqual(["ключ"]);
    expect(violations("<p>{name}, твой токен просрочен</p>")).toEqual(["токен"]);
  });

  it("reads copy split by several interpolations, attributes and nested braces", () => {
    expect(violations('<p style={{ color: "red" }}>Вход {a} по ключу {b} истёк</p>'))
      .toEqual(["ключ"]);
  });

  it("reads copy nested inside an expression, and the copy around it", () => {
    const source = [
      "function Card() {",
      "  return (",
      "    <div>",
      "      {ok ? <p>Твой ключ истёк</p> : null}",
      "      <span>Выйти</span>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(violations(source)).toEqual(["ключ"]);
  });

  it("reads a plain string and both halves of a template literal", () => {
    expect(violations('const a = "Введите API-ключ";').sort()).toEqual(["API", "ключ"]);
    expect(violations("const a = `срок действия токена ${x} истёк`;")).toEqual(["токен"]);
  });

  it("never glues two halves of a word into one an author did not write", () => {
    expect(violations("<p>клю{x}ч</p>")).toEqual([]);
  });

  it("leaves alone the words that merely contain a forbidden one", () => {
    expect(violations("<p>Включите расширение, подключите страницу, деактивация отменена</p>"))
      .toEqual([]);
    expect(violations("<p>The rapid, capable chapter</p>")).toEqual([]);
  });

  it("is not fooled by a generic that looks like a tag, or a URL that looks like a comment", () => {
    expect(violations('const [v] = useState<string | null>(null);\nconst u = "https://ext.gosling-agency.ru/start.html";'))
      .toEqual([]);
  });

  it("does not mistake a module specifier for something a person reads", () => {
    expect(violations('import { kernel } from "@/api/sdk";')).toEqual([]);
    expect(violations('const p = import("./pages/api-keys.js");')).toEqual([]);
  });

  it("ignores comments, which nobody on the page can read", () => {
    expect(violations("// the device token and the API key live here\n<p>Готово</p>")).toEqual([]);
  });
});

describe("account copy vocabulary", () => {
  const files = SCANNED.flatMap((target) => sourceFiles(target));

  it("covers every file a chatter looks at, chrome included", () => {
    // A rename must not silently switch this gate off.
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.map((file) => path.basename(file)).sort()).toEqual(
      expect.arrayContaining(["AccountPage.tsx", "ChatterLayout.tsx", "JoinPage.tsx", "accountView.ts"]),
    );
  });

  it("never says token, key, API, bearer, activation, reservation or prefix to a person", () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return readableText(source, file).flatMap((text) =>
        FORBIDDEN
          .filter(({ pattern }) => pattern.test(text))
          .map(({ word }) => `${path.relative(ROOT, file)}: "${text.trim()}" contains "${word}"`),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("never renders a sign-in's own metadata", () => {
    // §2: "Метаданные токена (префикс, дата выпуска, срок) пользователю не
    // показываются" — the cabinet shows a label, a client version and a last
    // activity, and the invitation page shows no link metadata at all.
    const offenders = files.filter((file) =>
      /\b(keyPrefix|expiresAt|createdAt)\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
