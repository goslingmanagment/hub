// chat-extension H-10 (architecture.md D-15): the structural check of a
// finished Split generation. It reads the FINAL completion text with the
// markers and the sanitizer the clients parse it with (split.ts,
// reply-output.ts) and reports counts only, never text. The stream has already
// been sent when this runs, so the result is a record in the generation's
// params (`outputStructure`), never a filter.

import { normalizeReplyParts, stripThinkBlocks } from './reply-output.ts';
import { splitByVariant } from './split.ts';

/** A Split prompt asks for at least two parts and never more than three. */
export const SPLIT_PARTS_MIN = 2;
export const SPLIT_PARTS_MAX = 3;

/** A type alias, not an interface: it is stored as a plain JSON record. */
export type SplitOutputStructure = {
  /** Variants the prompt asked for: 1 for Ping and a one-draft Hi, 3 for the chat Hi. */
  variantsRequested: number;
  /** Insertable [NEXT] parts of each [VARIANT] found, in order. A variant with
   * no insertable part is not counted. */
  partsPerVariant: number[];
  /** The requested number of variants, each with two or three parts. */
  ok: boolean;
};

export function describeSplitOutput(
  completionText: string,
  variantsRequested: number,
): SplitOutputStructure {
  // Reasoning blocks go first, as in reply-output's normalize(): a marker the
  // model wrote while thinking is not a variant or a part.
  const partsPerVariant = splitByVariant(stripThinkBlocks(completionText))
    .map((variant) => normalizeReplyParts(variant).length)
    .filter((parts) => parts > 0);
  return {
    variantsRequested,
    partsPerVariant,
    ok:
      partsPerVariant.length === variantsRequested
      && partsPerVariant.every((parts) => parts >= SPLIT_PARTS_MIN && parts <= SPLIT_PARTS_MAX),
  };
}

/** The Coach template allows at most two ```draft blocks in one answer
 * (templates/coach-chat.md, "## Rules"). */
export const COACH_DRAFT_BLOCKS_MAX = 2;
/** A preset turn asks for exactly two (the builder's PRESET_INSTRUCTIONS_BLOCK). */
export const COACH_PRESET_DRAFT_BLOCKS = 2;

const COACH_DRAFT_OPEN = /^```draft[ \t]*$/;
const COACH_FENCE_CLOSE = /^```[ \t]*$/;

/** Bodies of the closed ```draft blocks of a Coach answer, in order. The
 * grammar is the template's, as the released reader of it applies it
 * (fansly-chat src/shared/coach-draft.ts): a line-anchored opener, the body
 * lines, a line-anchored closer. An opener met before the closer abandons the
 * block it interrupts, and a block that never closes is prose. */
function coachDraftBodies(text: string): string[] {
  const bodies: string[] = [];
  let open: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (COACH_DRAFT_OPEN.test(line)) {
      open = [];
    } else if (open !== null && COACH_FENCE_CLOSE.test(line)) {
      bodies.push(open.join('\n'));
      open = null;
    } else {
      open?.push(line);
    }
  }
  return bodies;
}

/** The Coach twin of SplitOutputStructure (chat-extension H-10b): a Coach
 * answer is advice with draft blocks in it, and Split asks for [NEXT] parts
 * inside each block. Counts only, never text. */
export type CoachSplitOutputStructure = {
  /** Draft blocks the prompt asked for: exactly two on a preset turn; null on
   * a question turn, where the coach decides (none, one or two). */
  draftsRequested: number | null;
  /** Insertable [NEXT] parts of each closed ```draft block, in order. A block
   * with no insertable part is not counted. */
  partsPerDraft: number[];
  /** The requested number of draft blocks (no more than the template allows
   * when the coach decides), each with two or three parts. An answer that
   * proposes no message on a question turn has nothing to split and is ok.
   * The 1500-character limit of a block is not a Split matter and is not
   * checked here. */
  ok: boolean;
};

export function describeCoachSplitOutput(
  completionText: string,
  draftsRequested: number | null,
): CoachSplitOutputStructure {
  // Reasoning blocks go first, as in describeSplitOutput: a fence or a marker
  // the model wrote while thinking is not a draft or a part.
  const partsPerDraft = coachDraftBodies(stripThinkBlocks(completionText))
    .map((body) => normalizeReplyParts(body).length)
    .filter((parts) => parts > 0);
  const countOk = draftsRequested === null
    ? partsPerDraft.length <= COACH_DRAFT_BLOCKS_MAX
    : partsPerDraft.length === draftsRequested;
  return {
    draftsRequested,
    partsPerDraft,
    ok: countOk && partsPerDraft.every((parts) => parts >= SPLIT_PARTS_MIN && parts <= SPLIT_PARTS_MAX),
  };
}
