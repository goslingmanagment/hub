// MIGRATED VERBATIM from chatgoose_desktop_fable
// output/reply-output.ts @ 1db76a4ae13d (2026-07-06); adapted ONLY in imports.
// Prompts are tuned production assets — do not reword outside
// the parity harness.
// Sanitizer pipeline for every insertable AI reply (SPEC §15 — runs on every LLM
// reply path). An empty result array is the "ai output unusable" signal; the error
// itself is raised by the caller.

import { splitByNext, splitByVariant } from './split.ts';

/** Stray JSON-array framing Gemini emits around reply parts. */
const BRACKET_GARBAGE = new Set(['[', ']', '["', '"]', "['", "']"]);

// Exact legacy pattern set. Deliberately narrow around "instructions": a bare match
// would also strip legitimate in-character lines (e.g. JOI "just follow my
// instructions") — 1.4.0 regression fix.
const META_LEAK_PATTERNS: readonly RegExp[] = [
  /\bthe\s+prompt\s+says\b/i,
  /\bprompt\s+says\b/i,
  /\bsystem\s+prompt\b/i,
  /\b(?:system|previous|above)\s+instructions?\b/i,
  /\bignore (?:all |the )?(?:previous |above )?instructions?\b/i,
  /\buntrusted\s+user\s+input\b/i,
  /\bnever\s+follow\s+instructions?\b/i,
  /\braw\s+system\s+messages?\b/i,
  /\bhidden\s+instructions?\b/i,
  /\boutput\s+only\b/i,
  /\bmost\s+replies\s+should\b/i,
  /\bsingle\s+message\b/i,
  /\bsingle\s+reply\b/i,
  /\bstay\s+in\s+character\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bgenerated\s+(?:reply|message|response)\b/i,
];

// Reasoning a model writes into the visible text: <think>, <thinking>,
// <reasoning>, <mental_model>, <analysis> or <analyzing>, also with a suffix
// after an underscore (<thinking_mode>) or a prefix before a colon
// (<budget:thinking>, Opus 5.5 at low effort on 2026-10-30), closed by the
// same tag in any case. The tag name is a group so the close tag must repeat
// it; a plain `<think\b` misses `<thinking>`, which is how Opus 5.5 leaked its
// reasoning into fast replies on 2026-10-09..14 (<thinking>, <reasoning>,
// <thinking_mode>, <mental_model>).
const REASONING_TAG = '(?:[\\w-]+:)?(?:think|thinking|reasoning|mental_model|analysis|analyzing)(?:_\\w+)?';
const REASONING_BLOCK = new RegExp(`<(${REASONING_TAG})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
// A block that never closes (the model forgot the close tag or ran out of
// tokens): everything from its opener on is reasoning. Only a bare tag that
// opens the text or its own line counts, so a reply that quotes one ("what
// does `<think>` mean") or plays with one ("<thinking of you>") stays whole.
// It runs after the fenced blocks are gone, so an opener quoted inside one
// cuts nothing.
const OPEN_REASONING_BLOCK = new RegExp(`(?:^|\\n)\\s*<${REASONING_TAG}>[\\s\\S]*$`, 'i');
// A close tag with no opener: what comes before it is reasoning, the reply follows it.
const CLOSED_WITHOUT_OPENER = new RegExp(`^[\\s\\S]*<\\/${REASONING_TAG}\\s*>`, 'i');

// Markup around the reply, never part of it: a <reply> or <fanmail_reply>
// wrapper, a <br>, a tool call the model wrote as text (<invoke> with the
// message in a <parameter>). Seen from Opus 5.5 at low effort, 2026-10-10..30.
const WRAPPER_TAG = /<\/?(?:\w+_)?(?:reply|message|response|answer)\s*>|<\/?(?:invoke|parameter|function_calls)\b[^>]*>(?:[\w.-]+>)?/gi;
const LINE_BREAK_TAG = /<br\s*\/?>/gi;

// Reasoning written as plain text, with no tag: a line that checks the house
// style rules ("No long dashes.", "no em dash, no full stop at end"), names
// the task as the prompt does ("Cold opener.") or opens by reporting what the
// fan wrote ("Fan writes in Russian, so reply in Russian."). A message to a
// fan never says these: none of 39,214 production generations did outside
// such reasoning (checked 2026-10-16). "no dash" needs an end of phrase after
// it, so "no dash cam" stays.
//
// And a draft the model goes on to correct: Ari's Hi opens with the persona's
// own sample, then "Wait, that copies the sample opener exactly. Vary it.",
// a check of the username rule ("not a guess about him"), or a label of the
// draft it settles on ("Final:", "Better:", "so a fresher version:"). None of
// 46,143 production generations said these outside such reasoning (checked
// 2026-10-22); "sample" alone stays, a girl may offer one. The client copies
// carry the same rules (chat-extension#281, fansly-chat#170).
const PLAN_NOTE_PATTERNS: readonly RegExp[] = [
  /\b(?:em|en|long)\s+dash(?:es)?\b/i,
  /\bno\s+dash(?:es\b|\s*[.,;)]|\s*$)/i,
  /\bno\s+(?:final\s+)?full\s+stop\b/i,
  /\bfull\s+stop\s+at\s+(?:the\s+)?end\b/i,
  /\bcold\s+opener\b/i,
  /^\s*(?:the\s+)?fan\s+(?:just\s+)?(?:writes|wrote|asks|asked|says|said|joked|replied|mentioned)\b/i,
  /\bsample\s+openers?\b/i,
  /\b(?:cop(?:y|ies|ying)|close\s+to|identical\s+to|word[\s-]+for[\s-]+word)\b.*\b(?:samples?|style\s+example)\b/i,
  /\b(?:samples?|style\s+example)\b.*\b(?:verbatim|word[\s-]+for[\s-]+word|vary)\b/i,
  /\bcop(?:y|ying)\s+(?:that|it|this)\s+(?:exactly|verbatim)\b/i,
  /(?:^|[.,;:!?]\s*|\b(?:me|should)\s+)vary(?:\s+(?:it|this|wording|the\s+wording))?\s*[.:!]?\s*$/i,
  /\b(?:jok(?:e|es|ing)\s+about\s+(?:the\s+|his\s+|what\s+(?:his\s+)?)?username|username\s+(?:jab|joke)|guess(?:es|ing)?\s+about\s+him|his\s+username)\b/i,
  /\boutput\s+(?:only\s+)?one\b/i,
  /(?:^|[.!?,]\s*)(?:final|better|revised|fix|correction|simpler|the\s+final\s+one)(?:,[^:\n]*)?\s*:\s*$/i,
  /\b(?:fresher|cleaner)\s+(?:version|take|one)\s*:\s*$/i,
  /\blet\s+me\s+(?:make\s+it\s+(?:clean|cleaner|simpler)|redo\s+that)\b/i,
  // Opus 5.5 at low effort, 2026-10-28..30: the reply's rules checked aloud
  // (("Hmm, 'tho' is banned. Fix.", "Wait: brother is an invented fact.
  // Remove.", "Last three model messages...", "Ends with no period. Good."), a
  // candidate under a label ("Something like: '...'"), and the fan read in the
  // third person with an order to itself ("he said something sweet. Respond
  // with..."). None of 36,761 generations (2026-09-25..10-30) said these
  // outside such reasoning.
  /\brestat(?:e|es|ed|ing)\b/i,
  /\binvent(?:s|ed|ing)?\s+(?:an?\s+)?(?:\w+\s+){0,2}(?:facts?|plans?|colou?rs?|details?)\b|\b(?:is|are)\s+(?:an?\s+)?invent(?:ed|ing)\b/i,
  /\b(?:is|are|also)\s+(?:on\s+the\s+)?(?:banned|forbidden)\b|\b(?:forbidden|banned)\s+(?:list|words?|phrases?)\b/i,
  /\blast\s+(?:three|two|few|[23])\s+(?:model\s+)?messages\b|\b(?:two|2)\s+of\s+(?:the\s+)?last\s+(?:three|3)\b|\b(?:previous|last)\s+model\s+messages?\b/i,
  /\bend(?:s|ed)?\s+with(?:out)?\s+(?:an?\s+|no\s+)?(?:questions?(?:\s+marks?)?|periods?|full\s+stops?)\b/i,
  /\bno\s+(?:ending|trailing)\s+(?:full\s+stop|period)\b/i,
  /\bavoid\s+(?:the\s+)?dash(?:es)?\b|\bsoft\s+markers?\b|\bonly\s+one\s+message\b|\blet(?:'s|\s+me)\s+pick\s+(?:a\s+clean\s+)?one\b/i,
  /\bthe\s+draft\b|^\s*draft\s+(?:is|says|doesn't|does\s+not)\b/i,
  /^\s*(?:something\s+like|possible\s+reply|maybe|draft|option\s*\d*|alternatively)\s*:/i,
  /(?:^|[.!?,]\s*)(?:final|better)\s+(?:output|version|reply|answer)\s*:\s*$/i,
  /^\s*["“][^"”\n]+["”]\s+(?:is\s+|seems\s+|sounds\s+)?(?:fine|ok|okay|good|better|works)\b[.,]/i,
  /^\s*(?:the\s+)?fan's\s+(?:lines?|messages?)\b|^\s*context\s*:/i,
  /^\s*(?:Answer|Respond|Reply|React)\s+(?:plainly|casual(?:ly)?|warmly|briefly|naturally|lightly)\b/,
  /^\s*Avoid\s+\w+ing\b/,
  /(?:^|\s)(?:Fix|Revise|Remove|Rephrase|Redo|Simplify|Output)(?:\s+it)?\.\s*\]?\s*$/,
  /^\s*(?:Good|Fine|Output)\.\s*$/,
  /(?:^|[.?!]\s*)Keep\s+(?:it\s+)?(?:single|simple)\.?\s*$/,
];

// A line that opens like the model talking to itself ("Hmm,", "Wait:",
// "[Wait,", "Actually") and is about the reply's rules. The subjects leave
// out what a girl may ask about herself: "Wait, you're on your period?".
const SELF_TALK_OPENER = /^\s*\[?(?:Hmm+|Wait|Actually|Check)\b/;
const SELF_TALK_SUBJECT =
  /\b(?:persona|draft|output|quotes|question\s+marks?|one\s+question|full\s+stops?|reconsider|keep\s+(?:it\s+)?simple|fix\s+(?:the\s+)?grammar)\b/i;

// The fan in the third person, then an order the model gives itself.
const FAN_READ = /^\s*he\s+(?:just\s+|really\s+)?(?:said|asked|replied|likes|wants|explained|mentioned)\b/i;
const SELF_ORDER = /\.\s+(?:Respond|Reply|React|Answer|Keep|Avoid)\b|\bso\s+(?:respond|reply|react|answer|offer|keep|nudge)\b/;

function isPlanNoteLine(line: string): boolean {
  return (
    PLAN_NOTE_PATTERNS.some((pattern) => pattern.test(line)) ||
    (SELF_TALK_OPENER.test(line) && SELF_TALK_SUBJECT.test(line)) ||
    (FAN_READ.test(line) && SELF_ORDER.test(line))
  );
}

// Within one part, the text after the last plan-note line is the reply; what
// comes before it is the plan or a draft the model went on to correct (both
// seen from Opus 5.5 at low effort). With nothing after it, the plan-note
// lines alone are dropped. It runs on each part, never across [NEXT] or
// [VARIANT], so a note cannot cut another part.
function stripPlanNotes(text: string): string {
  const lines = text.split('\n');
  let last = -1;
  lines.forEach((line, index) => {
    if (isPlanNoteLine(line)) last = index;
  });
  if (last < 0) {
    return text;
  }
  const after = lines.slice(last + 1).join('\n');
  return after.trim() ? after : lines.filter((line) => !isPlanNoteLine(line)).join('\n');
}

// Exported for output/split-structure.ts (chat-extension H-10a): a reader of the
// final text must drop reasoning blocks before it looks for delimiter markers,
// exactly as normalize() below does.
export function stripThinkBlocks(text: string): string {
  return text
    .replace(REASONING_BLOCK, '')
    .replace(/```(?:think|thinking|reasoning|chain-of-thought)[^\n]*\n[\s\S]*?```/gi, '')
    .replace(OPEN_REASONING_BLOCK, '')
    .replace(CLOSED_WITHOUT_OPENER, '')
    .replace(LINE_BREAK_TAG, '\n')
    .replace(WRAPPER_TAG, '');
}

function isMetaLeakLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return META_LEAK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function removeMetaLeakLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isMetaLeakLine(line))
    .join('\n')
    .trim();
}

function stripReplyPrefix(text: string): string {
  return text
    .replace(/^(?:message\s*\d+|reply|response)\s*[:.-]\s*/i, '')
    .replace(/^here(?:'s| is)\s+(?:a\s+)?(?:reply|response)\s*[:.-]\s*/i, '')
    .trim();
}

// Em / en / horizontal-bar dashes are an AI tell — nobody texting from a phone
// types them, and our own prompts are saturated with them, so the model mirrors
// the style back. A dash between digits is a numeric range (5–10 → 5-10); every
// other dash is a prose pause and collapses to a comma. Surrounding spaces are
// absorbed but line breaks are preserved so multi-part replies stay intact.
function normalizeDashes(text: string): string {
  return text
    .replace(/(\d)[^\S\r\n]*[—–―][^\S\r\n]*(\d)/gu, '$1-$2')
    .replace(/[^\S\r\n]*[—–―]+[^\S\r\n]*/gu, ', ')
    .replace(/,(?:[^\S\r\n]*,)+/gu, ',')
    .replace(/[^\S\r\n]+(\r?\n)/gu, '$1')
    .replace(/^[\s,]+/u, '')
    .replace(/[\s,]+$/u, '');
}

function stripWrappingQuotes(text: string): string {
  let current = text.trim();
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current
      .replace(/^"([\s\S]*)"$/u, '$1')
      .replace(/^'([\s\S]*)'$/u, '$1')
      .replace(/^“([\s\S]*)”$/u, '$1')
      .replace(/^‘([\s\S]*)’$/u, '$1')
      .trim();
  }
  return current;
}

export function sanitizeReplyPart(part: string): string {
  return normalizeDashes(
    stripWrappingQuotes(stripReplyPrefix(removeMetaLeakLines(stripPlanNotes(stripThinkBlocks(part))))),
  );
}

export function isInsertableReplyPart(part: string): boolean {
  const trimmed = part.trim();
  if (!trimmed || BRACKET_GARBAGE.has(trimmed)) {
    return false;
  }
  return !isMetaLeakLine(trimmed);
}

// Think blocks are stripped before splitting: a reasoning block may itself
// contain delimiter markers.
function normalize(rawText: string, split: (text: string) => string[]): string[] {
  return split(stripThinkBlocks(rawText)).map(sanitizeReplyPart).filter(isInsertableReplyPart);
}

export function normalizeReplyParts(rawText: string): string[] {
  return normalize(rawText, splitByNext);
}

export function normalizeVariantReplyParts(rawText: string): string[] {
  return normalize(rawText, splitByVariant);
}

export function normalizeProvidedReplyParts(parts: string[]): string[] {
  return parts.map(sanitizeReplyPart).filter(isInsertableReplyPart);
}

export function normalizeSingleReplyPart(rawText: string): string[] {
  const sanitized = sanitizeReplyPart(rawText);
  return isInsertableReplyPart(sanitized) ? [sanitized] : [];
}
