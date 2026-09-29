import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { syncCriticalDbFiles } from "./helpers/sync-critical-files.ts";

// Every test file of one vitest run shares ONE Postgres cluster (see
// tests/helpers/global-setup.ts): each acquisition clones its own database,
// but files run side by side — the unit run in parallel, and on the PC two
// sync-critical DB files at a time per shard. What a database clone does not
// isolate is cluster-wide state, so this pins two rules over every file that
// can reach that cluster:
//  - a read of pg_locks or pg_stat_activity (cluster-wide views) is scoped to
//    current_database() or to a backend pid, so a sibling file's sessions and
//    locks never count or get killed;
//  - roles are cluster-wide: CREATE/ALTER/DROP ROLE (or USER/GROUP) and role
//    membership grants happen only at the allowlisted sites below.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const SELF = "tests/db-isolation-policy.test.ts";

type Literal = { text: string; line: number };

const REGEX_AFTER_PUNCT = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw", "new"]);

/**
 * The string literals of a TypeScript source — quoted strings and template
 * literals (tagged or not), with `${…}` kept as written — and the source with
 * its comments removed. Literals joined by a bare `+` are merged into one, so
 * a query split across lines is checked as a whole. A deliberately small lexer:
 * comments never count, and regex literals are skipped so a quote inside one
 * cannot throw the rest of the file out of step.
 */
export function scanSource(source: string): { literals: Literal[]; code: string } {
  const literals: Literal[] = [];
  const n = source.length;
  const code: string[] = [];
  // What sits between the previous literal and the next one: nothing yet, one
  // `+` (the next literal continues the previous one), or anything else.
  let gap: "none" | "plus" | "other" = "other";
  let previous: Literal | null = null;
  let last: { kind: "start" | "punct" | "word" | "value"; text: string } = { kind: "start", text: "" };
  let i = 0;
  let line = 1;
  let counted = 0;

  const lineAt = (index: number) => {
    for (; counted < index; counted += 1) if (source.charCodeAt(counted) === 10) line += 1;
    return line;
  };

  function quotedEnd(start: number): number {
    const quote = source[start];
    let j = start + 1;
    while (j < n && source[j] !== quote && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
    return j + 1;
  }

  function commentEnd(start: number): number {
    if (source[start + 1] === "/") {
      const end = source.indexOf("\n", start);
      return end === -1 ? n : end;
    }
    const end = source.indexOf("*/", start + 2);
    return end === -1 ? n : end + 2;
  }

  // Index just past the `}` that closes a `${` whose body starts at `start`.
  function expressionEnd(start: number): number {
    let depth = 1;
    let j = start;
    while (j < n) {
      const c = source[j];
      if (c === "'" || c === '"') j = quotedEnd(j);
      else if (c === "`") j = template(j).end;
      else if (c === "/" && (source[j + 1] === "/" || source[j + 1] === "*")) j = commentEnd(j);
      else {
        if (c === "{") depth += 1;
        if (c === "}" && --depth === 0) return j + 1;
        j += 1;
      }
    }
    return n;
  }

  function template(start: number): { end: number; text: string } {
    let text = "";
    let j = start + 1;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        text += source.slice(j, j + 2);
        j += 2;
      } else if (c === "`") {
        return { end: j + 1, text };
      } else if (c === "$" && source[j + 1] === "{") {
        const end = expressionEnd(j + 2);
        text += source.slice(j, end);
        j = end;
      } else {
        text += c;
        j += 1;
      }
    }
    return { end: n, text };
  }

  function regexEnd(start: number): number | null {
    let inClass = false;
    let j = start + 1;
    while (j < n) {
      const c = source[j];
      if (c === "\n") return null;
      if (c === "\\") j += 2;
      else {
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j += 1;
      }
    }
    j += 1;
    while (j < n && /[a-z]/i.test(source[j] ?? "")) j += 1;
    return j;
  }

  while (i < n) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (c === "/" && (next === "/" || next === "*")) {
      i = commentEnd(i);
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const { end, text } = c === "`" ? template(i) : { end: quotedEnd(i), text: "" };
      const body = c === "`" ? text : source.slice(i + 1, end - 1);
      code.push(source.slice(i, end));
      if (previous && gap === "plus") previous.text += body;
      else {
        previous = { text: body, line: lineAt(i) };
        literals.push(previous);
      }
      gap = "none";
      last = { kind: "value", text: "" };
      i = end;
      continue;
    }
    if (c === "/" && (last.kind === "start" || (last.kind === "punct" && REGEX_AFTER_PUNCT.has(last.text))
      || (last.kind === "word" && REGEX_AFTER_WORD.has(last.text)))) {
      const end = regexEnd(i);
      if (end !== null) {
        code.push(source.slice(i, end));
        gap = "other";
        last = { kind: "value", text: "" };
        i = end;
        continue;
      }
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(source[j] ?? "")) j += 1;
      const word = source.slice(i, j);
      code.push(word);
      gap = "other";
      last = { kind: "word", text: word };
      i = j;
      continue;
    }
    code.push(c);
    if (!/\s/.test(c)) {
      gap = c === "+" && gap === "none" ? "plus" : "other";
      last = { kind: "punct", text: c };
    }
    i += 1;
  }
  return { literals, code: code.join("") };
}

const scans = new Map<string, ReturnType<typeof scanSource>>();
function scanned(source: string) {
  let scan = scans.get(source);
  if (scan === undefined) scans.set(source, scan = scanSource(source));
  return scan;
}

/** SQL comments inside a literal never scope anything. */
function withoutSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const CLUSTER_VIEW = /\b(?:from|join)\s+(?:pg_catalog\s*\.\s*)?pg_(?:locks|stat_activity)\b/i;
const CLUSTER_VIEW_ALL = new RegExp(CLUSTER_VIEW.source, "gi");
// current_database(), or a backend pid bound to a parameter, an interpolated
// value, a literal or this session — `pid <> pg_backend_pid()` alone is not.
const SCOPED = /current_database\s*\(\s*\)|\bpid\s*(?:=\s*(?:any\s*\(\s*)?|in\s*\(\s*)(?:\$\d|\$\{|\d|pg_backend_pid\s*\(\s*\))/i;

type ClusterRead = { line: number; scoped: boolean; sql: string };

function clusterViewReads(source: string): ClusterRead[] {
  return scanned(source).literals.flatMap(literal => {
    const sql = withoutSqlComments(literal.text);
    return CLUSTER_VIEW.test(sql) ? [{ line: literal.line, scoped: SCOPED.test(sql), sql: sql.replace(/\s+/g, " ").trim() }] : [];
  });
}

const ROLE_DDL = /\b(create|alter|drop)\s+(role|user|group)\s+(?:if\s+(?:not\s+)?exists\s+)?("[^"]+"|\$\{[^}]*\}|[\w$]+)/gi;
// GRANT/REVOKE with no ON before the statement ends changes role membership.
const MEMBERSHIP = /\b(grant|revoke)\s+(?![^;]*\bon\b)[^;]*?\b(?:to|from)\s+("[^"]+"|\$\{[^}]*\}|[\w$]+)/gi;

/** Role DDL as `verb role name`, lower-cased, in source order. */
function roleStatements(source: string): string[] {
  return scanned(source).literals.flatMap(literal => {
    const sql = withoutSqlComments(literal.text);
    return [
      ...[...sql.matchAll(ROLE_DDL)].map(match => `${match[1]} ${match[2]} ${match[3]}`.toLowerCase()),
      ...[...sql.matchAll(MEMBERSHIP)].map(match => `${match[1]} membership ${match[2]}`.toLowerCase()),
    ];
  });
}

/** Every file whose SQL can reach a run's shared cluster, repo-relative. */
function scannedFiles(): string[] {
  const top = readdirSync(path.join(repoRoot, "tests")).filter(name => name.endsWith(".test.ts")).map(name => `tests/${name}`);
  const helpers = readdirSync(path.join(repoRoot, "tests/helpers")).filter(name => name.endsWith(".ts")).map(name => `tests/helpers/${name}`);
  return [...new Set([...top, ...helpers, ...syncCriticalDbFiles()])].filter(file => file !== SELF).sort();
}

const sources = new Map<string, string>();
const read = (file: string) => {
  let source = sources.get(file);
  if (source === undefined) sources.set(file, source = readFileSync(path.join(repoRoot, file), "utf8"));
  return source;
};

// Where role DDL may appear, exactly. A new site fails here until it is
// reviewed for concurrency and added.
const ROLE_DDL_SITES: Record<string, string[]> = {
  // The production read_only role: created once for the run, before any file.
  "tests/helpers/global-setup.ts": ["create role read_only"],
  // Six earnings-audit files share it; the fixture tolerates a concurrent creator.
  "tests/helpers/earnings-audit-fixture.ts": ["create role earnings_audit_test_reader"],
  // File-private roles: see FILE_PRIVATE_ROLES.
  "tests/followers-timeline.integration.test.ts": ["create role followers_timeline_reader"],
  "tests/followers-diagnostics.integration.test.ts": ["create role followers_report_reader"],
  "tests/fansly-events-measurement.integration.test.ts": ["create role a0_report_reader"],
  "tests/fan-earnings-receipts.integration.test.ts": ["create role ${role}", "drop role ${role}"],
  "tests/fansly-dm-material-probe.integration.test.ts": ["create role ${reader}", "drop role ${reader}"],
};

// The name each file-private role is created under; no other file may mention it.
const FILE_PRIVATE_ROLES: Record<string, string> = {
  "tests/followers-timeline.integration.test.ts": "followers_timeline_reader",
  "tests/followers-diagnostics.integration.test.ts": "followers_report_reader",
  "tests/fansly-events-measurement.integration.test.ts": "a0_report_reader",
  "tests/fan-earnings-receipts.integration.test.ts": "c2b_fixture_reader",
  // Suffixed with a random UUID per run.
  "tests/fansly-dm-material-probe.integration.test.ts": "material_probe_",
};

describe("DB isolation policy: the scanner", () => {
  it("merges literals joined by + and ignores comments between and inside them", () => {
    const source = [
      'await pool.query("select count(*) from pg_locks where locktype = \'advisory\' "',
      "  // current_database() in a comment scopes nothing",
      '  + "and granted", []);',
      "await pool.query(`select 1 from pg_stat_activity -- and datname = current_database()",
      "  where state = 'active'`);",
      "/* select * from pg_locks where true */",
    ].join("\n");
    expect(clusterViewReads(source).map(read => [read.line, read.scoped])).toEqual([[1, false], [4, false]]);
    expect(clusterViewReads('q("select * from pg_locks " + /* x */ "where database = (select oid from pg_database where datname = current_database())")'))
      .toMatchObject([{ scoped: true }]);
  });

  it.each([
    ["select 1 from pg_stat_activity where datname = current_database()", true],
    ["select pid from pg_stat_activity where pid = any($1::int[])", true],
    ["select count(*) from pg_stat_activity where pid = $1 and state = 'active'", true],
    ["select 1 from pg_catalog.pg_locks where pid = pg_backend_pid()", true],
    ["select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()", false],
    ["select count(*) from pg_locks l join pg_stat_activity a using (pid) where granted", false],
  ] as const)("scopes %s: %s", (sql, scoped) => {
    expect(clusterViewReads(`await db.query(\`${sql}\`);`)).toMatchObject([{ scoped }]);
  });

  it("stays in step through template expressions and regex literals", () => {
    const source = [
      "const a = `x ${fn({ b: `inner ${'}'}` })} y`;",
      "const re = /[\"'`]/g; const c = x / 2 / y;",
      'const q = "select * from pg_locks";',
    ].join("\n");
    const { literals, code } = scanSource(source);
    expect(literals.map(literal => literal.text)).toEqual(["x ${fn({ b: `inner ${'}'}` })} y", "select * from pg_locks"]);
    expect(code).toContain("x / 2 / y");
    expect(clusterViewReads(source)).toMatchObject([{ line: 3, scoped: false }]);
  });

  it("finds role DDL and membership grants, not object grants or role switches", () => {
    const source = [
      "await q(`create role reader; grant execute on function f(text) to reader`);",
      "await q('DROP ROLE IF EXISTS \"Other\"');",
      "await q(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'r') then create role r; end if; end $$`);",
      "await q(`alter user ${name} password 'x'`);",
      "await q('grant read_only to reader; revoke read_only from reader');",
      "await q('set local role read_only'); await q(`grant usage on schema public to read_only`);",
      '// create role in a comment',
    ].join("\n");
    expect(roleStatements(source)).toEqual([
      "create role reader",
      'drop role "other"',
      "create role r",
      "alter user ${name}",
      "grant membership reader",
      "revoke membership reader",
    ]);
  });
});

describe("DB isolation policy: files sharing a cluster", () => {
  const files = scannedFiles();

  it("covers every integration file, every helper and the rest of the sync-critical DB set", () => {
    const integration = readdirSync(path.join(repoRoot, "tests")).filter(name => name.endsWith(".integration.test.ts"));
    expect(integration.length).toBeGreaterThan(50);
    for (const name of integration) expect(files).toContain(`tests/${name}`);
    for (const file of syncCriticalDbFiles()) expect(files).toContain(file);
    expect(files).toContain("tests/helpers/global-setup.ts");
    expect(files).toContain("tests/helpers/earnings-audit-psql.ts");
  });

  it("scopes every pg_locks and pg_stat_activity read to this database or a backend pid", () => {
    const unscoped: string[] = [];
    let reads = 0;
    for (const file of files) {
      const source = read(file);
      const found = clusterViewReads(source);
      reads += found.length;
      for (const item of found) if (!item.scoped) unscoped.push(`${file}:${item.line}: ${item.sql}`);
      // Every such read outside comments sits in a literal the scan checked;
      // a lexer out of step would miscount here.
      const scan = scanned(source);
      const inCode = scan.code.match(CLUSTER_VIEW_ALL)?.length ?? 0;
      const inLiterals = scan.literals.reduce((sum, literal) => sum + (literal.text.match(CLUSTER_VIEW_ALL)?.length ?? 0), 0);
      expect(inLiterals, file).toBeGreaterThanOrEqual(inCode);
    }
    expect(unscoped).toEqual([]);
    // Not vacuous: the suite polls these views in well over a dozen places.
    expect(reads).toBeGreaterThanOrEqual(15);
  });

  it("creates, alters or drops roles only at the reviewed sites", () => {
    const sites: Record<string, string[]> = {};
    for (const file of files) {
      const statements = roleStatements(read(file));
      if (statements.length > 0) sites[file] = statements;
    }
    expect(sites).toEqual(ROLE_DDL_SITES);
  });

  it("keeps file-private role names private and the shared fixture concurrency-tolerant", () => {
    for (const [owner, role] of Object.entries(FILE_PRIVATE_ROLES)) {
      expect(read(owner), owner).toContain(role);
      const others = files.filter(file => file !== owner && read(file).includes(role));
      expect(others, role).toEqual([]);
    }
    const fixture = read("tests/helpers/earnings-audit-fixture.ts");
    expect(fixture).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'earnings_audit_test_reader'\) THEN\s+CREATE ROLE earnings_audit_test_reader;/);
    expect(fixture).toMatch(/EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;/);
  });
});
