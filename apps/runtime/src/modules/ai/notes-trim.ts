// The questionnaire fill's second pass (owner 2026-10-17, «только то что имеет
// смысл сохранять, без лишнего, чтобы было меньше воды»). The fill itself stays
// as it is: three rewrites of its value rule swung between losing facts the
// chatter needs (fetishes, a sexting plan, «опасается чаттеров») and writing
// more text than before. This pass sees the FINISHED fill and the recorded
// values, never the chat, and answers only the pieces to delete. Hub deletes
// them itself, so the pass can cut but never add or reword a word, and a piece
// that is not found exactly is dropped. The never-cut list holds the owner's
// own marks on six production fills (what he restored from a bolder pass).
//
// Own constants on purpose, like the media describer: this is no client
// feature and no template, and the prompt manifest pins only those.

import type { AiGatewayPromptBlock } from "@agency_hub_core/contracts";

import type { AiGatewayCompletionTrim } from "../../services/ai-gateway.ts";
import { escapeForPrompt } from "./prompts/escape.ts";

/** Bumped when the instruction below changes meaningfully. */
export const NOTES_TRIM_PROMPT_VERSION = 1;
/** Low adaptive thinking (Opus 5.5 cannot turn it off) plus a short list. */
export const NOTES_TRIM_MAX_TOKENS = 4096;
/** Well under the extension's 45 s idle timeout: a slower pass is dropped and
 * the fill goes out as the model wrote it. */
export const NOTES_TRIM_TIMEOUT_MS = 20_000;
/** A pass that wants to cut more than this share of one value, or of all the
 * values, misread its job: nothing of it is applied. */
export const NOTES_TRIM_MAX_VALUE_SHARE = 0.5;
export const NOTES_TRIM_MAX_TOTAL_SHARE = 0.3;

const NOTES_TRIM_NONE = "NONE";

export const NOTES_TRIM_SYSTEM_PROMPT = `You edit a questionnaire note about one fan for an agency chatter. The chatter rereads the note before writing to the fan, so it must hold every fact worth keeping and no water. Another model has just filled the note in from the chat. Your only job is to find the water in its new values. You never add or reword anything: you only name the pieces to delete.

## What you get

- The current values: what the chatter had recorded in each field before this fill.
- The filled note: one line per field. \`Label: =\` keeps the current value, \`Label:\` with nothing after the colon is empty, \`Label: value\` is a new or rewritten value. A value may be followed by quote lines \`> «…»\` copied from the fan's messages. Lines starting with \`+ \` are proposed new fields.

## What is water

- A retold episode: what happened, step by step. Keep the fact it showed when it matters for talking to him.
- A plain feeling about a fact that adds nothing to it: that he likes his job, is glad, thinks it is funny.
- Side details around a fact: how long ago or for how many years, how many people, exact amounts that are not his purchases, what came first. A detail that names someone in his life, or where a passion of his began, is not a side detail.
- Small talk and details that will not matter in a week: what he did today, his plans for one ordinary weekend, a series he just watched, a temporary change at work that is already over.

## What is never water

- Anything of the current value of the field.
- Every fetish, and everything he likes or wants in sex, in content and from the model; how he likes to be called.
- What he says or feels about the model herself: that he wants her happy, that she is his favourite, what he finds in her.
- His manner: his jokes, a test of the model, what he suspects or fears about AI or chatters.
- Every purchase with its price and date; every offer or plan with its condition (such as a sexting once he has time alone, or his promise to say when); how fast he spends, on her or on others.
- His job and what he thinks of it beyond a plain «likes it»: that he thinks of changing it, that it is not his passion.
- Concrete things a chatter can ask him about: his signature dish, what he studied and how it went, his favourite subjects, his collection.
- The people in his life and his ties to them: who he stays friends with, how his family feels.
- Where he lives, his schedule, his health, a big life event; when a fact is new or recent.
- Every date in parentheses.

## Output

Check every clause of every \`Label: value\` and \`+ Label: value\` line against the lists above. For each piece of water, write one line \`Label: piece\`, where the piece is copied character for character from that field's value: a whole clause or a part of one, together with the separator before it (\`, \` or \`; \`) when it does not start the value. When a joining word right after the piece (но, а, и) only tied it to the rest, the piece takes that word too and leaves the separator before it: in «бармен (05.2026), работа нравится, но хочет уйти» the piece is «работа нравится, но ». Each piece must appear exactly once in its value, and what is left must still read as a note. Never name a piece of a \`=\` line or of a quote line. Most values have little water; when unsure, keep it.

When there is no water at all, write the single line \`${NOTES_TRIM_NONE}\`. Write nothing else: no preamble, no explanations, no markdown.`;

export interface NotesTrimPiece {
  label: string;
  piece: string;
}

export interface NotesTrimRejectedPiece extends NotesTrimPiece {
  reason: "unknown_label" | "not_a_value" | "not_found_once" | "empties_value" | "value_share" | "total_share";
}

export interface NotesTrimApplied {
  text: string;
  applied: NotesTrimPiece[];
  rejected: NotesTrimRejectedPiece[];
}

/** The pass's prompt: the recorded values the fill started from (escaped like
 * the fill's own task list) and the fill verbatim, because every piece must be
 * copied from it character for character. */
export function buildNotesTrimPrompt(input: {
  noteFields: readonly string[];
  noteValues: readonly string[];
  completionText: string;
}): { systemBlocks: AiGatewayPromptBlock[]; userBlocks: AiGatewayPromptBlock[] } {
  const current = input.noteFields
    .map((label, index) => {
      const value = input.noteValues[index]?.trim() ?? "";
      return value ? `${escapeForPrompt(label)}: ${escapeForPrompt(value)}` : `${escapeForPrompt(label)}:`;
    })
    .join("\n");
  const user = [
    "Current values:",
    "<current_values>",
    current,
    "</current_values>",
    "",
    "Filled note:",
    "<filled_note>",
    input.completionText.trim(),
    "</filled_note>",
    "",
    "List the water to delete.",
  ].join("\n");
  return {
    systemBlocks: [{ text: NOTES_TRIM_SYSTEM_PROMPT, cache: "none" }],
    userBlocks: [{ text: user, cache: "none" }],
  };
}

/** `Label: piece` lines; `NONE`, blank lines and lines without a label are no
 * pieces. One space after the colon is the format's; a second one belongs to
 * the piece. */
export function parseNotesTrimPieces(answer: string): NotesTrimPiece[] {
  const pieces: NotesTrimPiece[] = [];
  for (const raw of answer.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trim() === NOTES_TRIM_NONE) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const label = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1);
    const piece = rest.startsWith(" ") ? rest.slice(1) : rest;
    if (label === "" || piece.trim() === "") continue;
    pieces.push({ label, piece });
  }
  return pieces;
}

interface ValueLine {
  index: number;
  prefix: string;
  label: string;
  value: string;
}

function valueLines(lines: readonly string[]): Map<string, ValueLine> {
  const found = new Map<string, ValueLine>();
  lines.forEach((line, index) => {
    if (line.startsWith(">")) return;
    const prefix = line.startsWith("+ ") ? "+ " : "";
    const body = line.slice(prefix.length);
    const colon = body.indexOf(":");
    if (colon <= 0) return;
    const label = body.slice(0, colon).trim();
    if (!found.has(label)) found.set(label, { index, prefix, label, value: body.slice(colon + 1).trim() });
  });
  return found;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** What a cut leaves behind: no empty brackets, no space before a separator or
 * a closing bracket, one separator where two met (the stronger «;» wins), one
 * space, no separator at either end. */
export function tidyTrimmedValue(value: string): string {
  return value
    .replace(/\(\s*\)/g, "")
    .replace(/\(\s+/g, "(")
    .replace(/\s+([,;)])/g, "$1")
    .replace(/[,;](?:\s*[,;])+/g, (run) => (run.includes(";") ? ";" : ","))
    .replace(/ {2,}/g, " ")
    .replace(/^[\s,;]+|[\s,;]+$/g, "");
}

/** Deletes the pieces from the fill's own value lines, never from a `=` line,
 * an empty one or a quote. A piece must sit exactly once in its value; a value
 * the cuts would empty, or cut by more than half, keeps every piece; a pass
 * that would cut more than NOTES_TRIM_MAX_TOTAL_SHARE of all the values is
 * applied not at all. */
export function applyNotesTrim(completionText: string, pieces: readonly NotesTrimPiece[]): NotesTrimApplied {
  const lines = completionText.split("\n");
  const values = valueLines(lines);
  const rejected: NotesTrimRejectedPiece[] = [];
  const byLabel = new Map<string, NotesTrimPiece[]>();
  for (const piece of pieces) {
    const line = values.get(piece.label);
    if (!line) {
      rejected.push({ ...piece, reason: "unknown_label" });
    } else if (line.value === "" || line.value === "=") {
      rejected.push({ ...piece, reason: "not_a_value" });
    } else if (occurrences(line.value, piece.piece) !== 1) {
      rejected.push({ ...piece, reason: "not_found_once" });
    } else {
      byLabel.set(piece.label, [...(byLabel.get(piece.label) ?? []), piece]);
    }
  }

  const applied: NotesTrimPiece[] = [];
  const rewritten = new Map<number, string>();
  let totalChars = 0;
  for (const line of values.values()) {
    if (line.value !== "=") totalChars += line.value.length;
  }
  let cutChars = 0;
  for (const [label, labelPieces] of byLabel) {
    const line = values.get(label)!;
    let value = line.value;
    const kept: NotesTrimPiece[] = [];
    for (const piece of labelPieces) {
      // An earlier piece of the same value may have taken this one's text.
      if (occurrences(value, piece.piece) !== 1) {
        rejected.push({ ...piece, reason: "not_found_once" });
        continue;
      }
      value = value.replace(piece.piece, " ");
      kept.push(piece);
    }
    const tidy = tidyTrimmedValue(value);
    const removed = line.value.length - tidy.length;
    if (tidy === "") {
      rejected.push(...kept.map((piece) => ({ ...piece, reason: "empties_value" as const })));
    } else if (removed > line.value.length * NOTES_TRIM_MAX_VALUE_SHARE) {
      rejected.push(...kept.map((piece) => ({ ...piece, reason: "value_share" as const })));
    } else if (kept.length > 0) {
      rewritten.set(line.index, `${line.prefix}${line.label}: ${tidy}`);
      applied.push(...kept);
      cutChars += removed;
    }
  }

  if (totalChars > 0 && cutChars > totalChars * NOTES_TRIM_MAX_TOTAL_SHARE) {
    return {
      text: completionText,
      applied: [],
      rejected: [...rejected, ...applied.map((piece) => ({ ...piece, reason: "total_share" as const }))],
    };
  }
  const text = lines.map((line, index) => rewritten.get(index) ?? line).join("\n");
  return { text, applied, rejected };
}

/** The gateway's trim pass for one fill: the prompt, its budget and what the
 * answer means, recorded with the prompt version. */
export function notesTrimPass(noteFields: readonly string[], noteValues: readonly string[]): AiGatewayCompletionTrim {
  return {
    prompt: (completionText) => buildNotesTrimPrompt({ noteFields, noteValues, completionText }),
    maxTokens: NOTES_TRIM_MAX_TOKENS,
    timeoutMs: NOTES_TRIM_TIMEOUT_MS,
    apply(completionText, answer) {
      const result = applyNotesTrim(completionText, parseNotesTrimPieces(answer));
      return {
        text: result.text,
        record: { version: NOTES_TRIM_PROMPT_VERSION, applied: result.applied, rejected: result.rejected },
      };
    },
  };
}
