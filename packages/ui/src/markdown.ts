/**
 * Markdown into a tree the app draws itself (components/Markdown.tsx): the
 * pages agents publish — headings, paragraphs, lists, tables, quotes, code,
 * links. CommonMark's common cases and GitHub's tables and strikethrough; no
 * raw HTML (a tag stays visible text), no images (an image is a link to it),
 * no link but http(s), mailto and the app's own paths. The text is the
 * author's: nothing is reformatted, only drawn.
 *
 * Linear on hostile input: brackets are matched once per text, and a
 * delimiter that found no closer is not looked for again further on.
 */

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong" | "em" | "del"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] }
  | { kind: "break" };

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MdInline[] }
  | { kind: "paragraph"; inline: MdInline[] }
  | { kind: "list"; ordered: boolean; start: number; tight: boolean; items: MdBlock[][] }
  | { kind: "table"; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "quote"; blocks: MdBlock[] }
  | { kind: "rule" };

/** Deeper than this a list or a quote is read as text. */
const MAX_NESTING = 8;
const MAX_INLINE_DEPTH = 6;

// ── Links ──────────────────────────────────────────────────────────────────

/** The link a person may follow, or null: http(s), mailto, and the app's own paths and anchors. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === "") return null;
  if (href.startsWith("#")) return href;
  if (href.startsWith("/")) return href.startsWith("//") || href.startsWith("/\\") ? null : href;
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  return null;
}

// ── Inline ─────────────────────────────────────────────────────────────────

const PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char);
}
function isSpace(char: string | undefined): boolean {
  return char === undefined || SPACE.test(char);
}

/** The run of one character starting at `at`, not past `limit`. */
function runLength(text: string, at: number, limit: number = text.length): number {
  let end = at;
  while (end < limit && text[end] === text[at]) end += 1;
  return end - at;
}

/** Each `[`'s matching `]` (escapes skipped), found in one pass. */
function matchBrackets(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") { at += 1; continue; }
    if (char === "[") open.push(at);
    else if (char === "]" && open.length > 0) pairs.set(open.pop()!, at);
  }
  return pairs;
}

/** `(url)` or `(url "title")` right after a link's text: the url and where it ends. */
function linkDestination(text: string, at: number): { url: string; end: number } | null {
  if (text[at] !== "(") return null;
  let index = at + 1;
  while (text[index] === " ") index += 1;
  let url: string;
  if (text[index] === "<") {
    const close = text.indexOf(">", index + 1);
    if (close < 0 || text.slice(index + 1, close).includes("\n")) return null;
    url = text.slice(index + 1, close);
    index = close + 1;
  } else {
    let depth = 0;
    const start = index;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\" && index + 1 < text.length) { index += 2; continue; }
      if (SPACE.test(char)) break;
      if (char === "(") depth += 1;
      else if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      index += 1;
    }
    url = text.slice(start, index);
  }
  while (text[index] === " ") index += 1;
  const quote = text[index];
  if (quote === "\"" || quote === "'") {
    const close = text.indexOf(quote, index + 1);
    if (close < 0) return null;
    index = close + 1;
    while (text[index] === " ") index += 1;
  }
  if (text[index] !== ")") return null;
  return { url: url.replace(/\\([!-/:-@[-`{-~])/g, "$1"), end: index + 1 };
}

const BARE_URL = /https?:\/\/[^\s<>]+/iy;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy;

/** A bare `https://…` in the text: where it ends, trailing punctuation left out. */
function bareUrlEnd(text: string, at: number): number | null {
  if (text.slice(at, at + 4).toLowerCase() !== "http") return null;
  BARE_URL.lastIndex = at;
  const match = BARE_URL.exec(text);
  if (!match) return null;
  let url = match[0];
  for (;;) {
    const last = url[url.length - 1]!;
    if (".,:;!?'\"*_~".includes(last)) { url = url.slice(0, -1); continue; }
    if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) { url = url.slice(0, -1); continue; }
    break;
  }
  return url.length > "https://".length ? at + url.length : null;
}

interface InlineState {
  text: string;
  brackets: Map<number, number>;
  /** By marker and the range's end: from where on there is no closer before that end. */
  noCloser: Map<string, number>;
}

/**
 * The closer of `marker` (`**`, `_`, `~~`, a run of backticks) after `from` and
 * before `limit`, or -1. A failed search is remembered, so the next opener of
 * the same marker in the same range does not walk the same text again.
 */
function findCloser(state: InlineState, marker: string, from: number, limit: number): number {
  const cacheKey = `${marker}@${limit}`;
  const known = state.noCloser.get(cacheKey);
  if (known !== undefined && from >= known) return -1;
  const { text } = state;
  const char = marker[0]!;
  let at = from;
  while (at < limit) {
    const found = text.indexOf(char, at);
    if (found < 0 || found >= limit) break;
    if (char !== "`" && found > 0 && text[found - 1] === "\\") { at = found + 1; continue; }
    const run = runLength(text, found, limit);
    if (run === marker.length && found > from) {
      if (char === "`") return found;
      const closes = !isSpace(text[found - 1]) && (char !== "_" || !isWordChar(text[found + run]));
      if (closes) return found;
    }
    at = found + run;
  }
  state.noCloser.set(cacheKey, Math.min(from, known ?? from));
  return -1;
}

function parseInlineRange(state: InlineState, start: number, end: number, depth: number): MdInline[] {
  if (depth > MAX_INLINE_DEPTH) return [{ kind: "text", text: state.text.slice(start, end) }];
  const { text } = state;
  const out: MdInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let at = start;
  while (at < end) {
    const char = text[at]!;

    if (char === "\\") {
      const next = text[at + 1];
      if (next === "\n") { flush(); out.push({ kind: "break" }); at += 2; continue; }
      if (next !== undefined && at + 1 < end && PUNCTUATION.test(next)) { buffer += next; at += 2; continue; }
      buffer += char;
      at += 1;
      continue;
    }

    if (char === "\n") {
      // Two spaces before the end of a line: a hard break.
      if (buffer.endsWith("  ")) { buffer = buffer.replace(/ +$/, ""); flush(); out.push({ kind: "break" }); }
      else buffer = `${buffer.replace(/ +$/, "")}\n`;
      at += 1;
      continue;
    }

    if (char === "`") {
      const run = runLength(text, at, end);
      const close = run <= 32 ? findCloser(state, "`".repeat(run), at + run, end) : -1;
      if (close >= 0) {
        let code = text.slice(at + run, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
        flush();
        out.push({ kind: "code", text: code });
        at = close + run;
        continue;
      }
      buffer += text.slice(at, at + run);
      at += run;
      continue;
    }

    if (char === "[" || (char === "!" && text[at + 1] === "[")) {
      const open = char === "!" ? at + 1 : at;
      const close = state.brackets.get(open);
      const destination = close !== undefined && close < end ? linkDestination(text, close + 1) : null;
      if (close !== undefined && destination !== null && destination.end <= end) {
        flush();
        const children = parseInlineRange(state, open + 1, close, depth + 1);
        const href = safeHref(destination.url);
        // An image is never loaded: its words lead to it.
        if (href === null) out.push(...children);
        else out.push({ kind: "link", href, children: children.length > 0 ? children : [{ kind: "text", text: destination.url }] });
        at = destination.end;
        continue;
      }
      buffer += char;
      at += 1;
      continue;
    }

    if (char === "<") {
      AUTOLINK.lastIndex = at;
      const auto = AUTOLINK.exec(text);
      if (auto && at + auto[0].length <= end) {
        const href = safeHref(auto[1]!);
        flush();
        out.push(href === null ? { kind: "text", text: auto[0] } : { kind: "link", href, children: [{ kind: "text", text: auto[1]! }] });
        at += auto[0].length;
        continue;
      }
      buffer += char;
      at += 1;
      continue;
    }

    if ((char === "h" || char === "H") && !isWordChar(text[at - 1])) {
      const urlEnd = bareUrlEnd(text, at);
      if (urlEnd !== null && urlEnd <= end) {
        const url = text.slice(at, urlEnd);
        const href = safeHref(url);
        if (href !== null) {
          flush();
          out.push({ kind: "link", href, children: [{ kind: "text", text: url }] });
          at = urlEnd;
          continue;
        }
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const run = runLength(text, at, end);
      const before = text[at - 1];
      const after = text[at + run];
      const opens = !isSpace(after) && (char !== "_" || !isWordChar(before));
      // Strikethrough is `~~` only: a single tilde is «about» in a person's text (~$300).
      const sizes = char === "~" ? (run === 2 ? [2] : []) : run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1];
      if (opens && at + run < end) {
        let matched = false;
        for (const size of sizes) {
          const marker = char.repeat(size);
          const contentStart = at + size;
          const close = findCloser(state, marker, contentStart, end);
          if (close < 0) continue;
          flush();
          const children = parseInlineRange(state, contentStart, close, depth + 1);
          if (char === "~") out.push({ kind: "del", children });
          else if (size === 3) out.push({ kind: "em", children: [{ kind: "strong", children }] });
          else out.push({ kind: size === 2 ? "strong" : "em", children });
          at = close + size;
          matched = true;
          break;
        }
        if (matched) continue;
      }
      buffer += text.slice(at, at + run);
      at += run;
      continue;
    }

    buffer += char;
    at += 1;
  }
  flush();
  return out;
}

export function parseInline(text: string): MdInline[] {
  const state: InlineState = { text, brackets: matchBrackets(text), noCloser: new Map() };
  return parseInlineRange(state, 0, text.length, 0);
}

// ── Blocks ─────────────────────────────────────────────────────────────────

const BLANK = /^\s*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A table row's cells: split on unescaped pipes, the outer ones dropped. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < row.length; at += 1) {
    const char = row[at]!;
    if (char === "\\" && row[at + 1] === "|") { cell += "\\|"; at += 1; continue; }
    if (char === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): MdAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  /** The bullet, or the delimiter of a number: a different one starts another list. */
  sign: string;
  start: number;
  /** Where the item's text starts. */
  contentIndent: number;
  rest: string;
}

function listMarker(line: string): ListMarker | null {
  const match = ITEM.exec(line);
  if (!match) return null;
  const indent = match[1]!.length;
  const marker = match[2]!;
  const ordered = /\d/.test(marker[0]!);
  const spaces = (match[3] ?? "").replace(/\t/g, "    ").length;
  const rest = match[4] ?? "";
  const gap = rest === "" || spaces > 4 ? 1 : spaces;
  return {
    indent,
    ordered,
    sign: ordered ? marker[marker.length - 1]! : marker,
    start: ordered ? Number(marker.slice(0, -1)) : 1,
    contentIndent: indent + marker.length + gap,
    rest: spaces > 4 ? `${" ".repeat(spaces - 1)}${rest}` : rest,
  };
}

/** Whether a line starts a block that ends a paragraph. */
function interrupts(line: string, nested: boolean): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line)) return true;
  if (!nested && QUOTE.test(line)) return true;
  const item = nested ? null : listMarker(line);
  // A numbered list breaks a paragraph only from 1, and never an empty item (CommonMark).
  return item !== null && item.rest.trim() !== "" && (!item.ordered || item.start === 1);
}

function isTableStart(lines: readonly string[], at: number): boolean {
  const head = lines[at]!;
  const delimiter = lines[at + 1];
  if (delimiter === undefined || !head.includes("|") || !DELIMITER_ROW.test(delimiter)) return false;
  return splitRow(head).length === splitRow(delimiter).length;
}

function parseBlockLines(lines: readonly string[], nesting: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  const nested = nesting >= MAX_NESTING;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (BLANK.test(line)) { flush(); at += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      flush();
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const closing = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !closing.test(lines[at]!)) {
        const raw = lines[at]!;
        body.push(raw.slice(Math.min(indent, indentOf(raw))));
        at += 1;
      }
      at += 1;
      const lang = fence[3]!.trim().split(/\s+/)[0] ?? "";
      blocks.push({ kind: "code", lang: lang === "" ? null : lang, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline((heading[2] ?? "").trim()) });
      at += 1;
      continue;
    }

    const setext = paragraph.length > 0 ? SETEXT.exec(line) : null;
    if (setext) {
      blocks.push({ kind: "heading", level: setext[1]![0] === "=" ? 1 : 2, inline: parseInline(paragraph.join("\n")) });
      paragraph = [];
      at += 1;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      at += 1;
      continue;
    }

    if (isTableStart(lines, at)) {
      flush();
      const align = splitRow(lines[at + 1]!).map(alignOf);
      const width = align.length;
      const cellsOf = (row: string) => {
        const cells = splitRow(row).slice(0, width);
        while (cells.length < width) cells.push("");
        return cells.map(parseInline);
      };
      const head = cellsOf(lines[at]!);
      const rows: MdInline[][][] = [];
      at += 2;
      while (at < lines.length && !BLANK.test(lines[at]!) && !interrupts(lines[at]!, nested)) {
        rows.push(cellsOf(lines[at]!));
        at += 1;
      }
      blocks.push({ kind: "table", align, head, rows });
      continue;
    }

    const quote = nested ? null : QUOTE.exec(line);
    if (quote) {
      flush();
      const inner: string[] = [];
      while (at < lines.length) {
        const match = QUOTE.exec(lines[at]!);
        if (!match) break;
        inner.push(match[1]!);
        at += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlockLines(inner, nesting + 1) });
      continue;
    }

    const marker = nested ? null : listMarker(line);
    if (marker && (paragraph.length === 0 || interrupts(line, nested))) {
      flush();
      const items: MdBlock[][] = [];
      let tight = true;
      let current: ListMarker | null = marker;
      while (current !== null) {
        const itemLines = [current.rest];
        let lastBlank = false;
        at += 1;
        while (at < lines.length) {
          const next = lines[at]!;
          if (BLANK.test(next)) {
            let ahead = at + 1;
            while (ahead < lines.length && BLANK.test(lines[ahead]!)) ahead += 1;
            if (ahead < lines.length && indentOf(lines[ahead]!) >= current.contentIndent) {
              for (; at < ahead; at += 1) itemLines.push("");
              lastBlank = true;
              continue;
            }
            break;
          }
          if (indentOf(next) >= current.contentIndent) {
            if (lastBlank) tight = false;
            itemLines.push(next.slice(current.contentIndent));
            lastBlank = false;
            at += 1;
            continue;
          }
          // A lazy line: the item's paragraph goes on without its indent.
          if (!lastBlank && !BLANK.test(itemLines[itemLines.length - 1] ?? "") && listMarker(next) === null && !interrupts(next, nested)
            && !isTableStart(lines, at)) {
            itemLines.push(next.trim());
            at += 1;
            continue;
          }
          break;
        }
        items.push(parseBlockLines(itemLines, nesting + 1));
        // Blank lines between items make the list loose.
        let ahead = at;
        while (ahead < lines.length && BLANK.test(lines[ahead]!)) ahead += 1;
        const following = ahead < lines.length ? listMarker(lines[ahead]!) : null;
        if (following && following.ordered === marker.ordered && following.sign === marker.sign && following.indent < current.contentIndent) {
          if (ahead > at) tight = false;
          at = ahead;
          current = following;
        } else {
          current = null;
        }
      }
      blocks.push({ kind: "list", ordered: marker.ordered, start: marker.start, tight, items });
      continue;
    }

    // Leading spaces go; trailing ones stay: two of them end a line with a break.
    paragraph.push(line.trimStart());
    at += 1;
  }
  flush();
  return blocks;
}

/** A markdown text as blocks. */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlockLines(lines, 0);
}
