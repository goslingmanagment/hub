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

/** The Coach template allows at most two ```draft blocks in one answer, each
 * under 1500 characters (templates/coach-chat.md, "## Rules"). */
export const COACH_DRAFT_BLOCKS_MAX = 2;
/** The size both readers of the grammar accept, in code points of the block's
 * body (fansly-chat COACH_DRAFT_MAX_CHARS, chat-extension
 * COACH_LIMITS.draftMaxChars). */
export const COACH_DRAFT_CHARS_MAX = 1_500;
/** A preset turn asks for exactly two (the builder's PRESET_INSTRUCTIONS_BLOCK). */
export const COACH_PRESET_DRAFT_BLOCKS = 2;

/** The marker splitByNext splits on (split.ts keeps it as a literal). */
const NEXT_MARKER = '[NEXT]';

const COACH_DRAFT_OPEN = /^```draft[ \t]*$/;
const COACH_FENCE_CLOSE = /^```[ \t]*$/;
/** A draft fence the model meant to open, wherever it stands and however it is
 * spelled: indented, inside a list item, ```Draft, four backticks, an info
 * string after the word. Every COACH_DRAFT_OPEN line matches it exactly once. */
const COACH_DRAFT_FENCE_ATTEMPT = /`{3,}[ \t]*draft\b/gi;

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A Coach answer the way a client reads it: the well-formed draft blocks, and
 * what is left of the Split markup in the advice around them.
 *
 * The grammar is the template's, as the released reader of it applies it
 * (fansly-chat src/shared/coach-draft.ts): a line-anchored opener, the body
 * lines, a line-anchored closer. An opener met before the closer abandons the
 * block it interrupts, a block that never closes is advice, an empty block is
 * dropped, and a block over the size limit stays in the advice with its
 * markers. The reader also leaves a third block in the advice; here it stays
 * a draft, and its count is what fails the check. */
function readCoachAnswer(text: string): { drafts: string[]; brokenDrafts: number; strayMarkers: number } {
  const drafts: string[] = [];
  let emptyBlocks = 0;
  let open: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (COACH_DRAFT_OPEN.test(line)) {
      open = [];
    } else if (open !== null && COACH_FENCE_CLOSE.test(line)) {
      const body = open.join('\n');
      if (body.trim() === '') {
        emptyBlocks += 1;
      } else if (Array.from(body).length <= COACH_DRAFT_CHARS_MAX) {
        drafts.push(body);
      }
      open = null;
    } else {
      open?.push(line);
    }
  }
  const fencesOpened = text.match(COACH_DRAFT_FENCE_ATTEMPT)?.length ?? 0;
  return {
    drafts,
    // Every fence the model opened is a draft, an empty block, or broken.
    brokenDrafts: fencesOpened - drafts.length - emptyBlocks,
    // A marker never spans a line, so the ones inside the drafts subtract cleanly.
    strayMarkers: countOf(text, NEXT_MARKER) - drafts.reduce((sum, body) => sum + countOf(body, NEXT_MARKER), 0),
  };
}

/** The Coach twin of SplitOutputStructure (chat-extension H-10b): a Coach
 * answer is advice with draft blocks in it, and Split asks for [NEXT] parts
 * inside each block. Counts only, never text. */
export type CoachSplitOutputStructure = {
  /** Draft blocks the prompt asked for: exactly two on a preset turn; null on
   * a question turn, where the coach decides (none, one or two). */
  draftsRequested: number | null;
  /** Insertable [NEXT] parts of each well-formed draft block, in order: closed,
   * not empty, within the size limit. These are the blocks a client lifts out
   * of the answer. 0 is a block with text in it and no insertable part. */
  partsPerDraft: number[];
  /** Draft fences the model opened that are not such a block: an opener that
   * is not the template's line (indented, ```Draft, four backticks), a block
   * that never closes (the answer ran out of tokens, the closer is glued to
   * the text, another opener interrupts it), a block over the size limit. A
   * client leaves each of them in the advice. */
  brokenDrafts: number;
  /** [NEXT] markers outside the blocks of partsPerDraft: in the advice or in a
   * broken draft. A client shows them to the chatter as text. */
  strayMarkers: number;
  /** The requested number of draft blocks (no more than the template allows
   * when the coach decides), each with two or three parts, and nothing of a
   * draft left in the advice: no broken draft, no stray marker. So an empty
   * partsPerDraft with ok=true on a question turn is an answer with no draft
   * fence and no marker anywhere in it: as far as the markup can tell, one
   * that proposes no message. */
  ok: boolean;
};

export function describeCoachSplitOutput(
  completionText: string,
  draftsRequested: number | null,
): CoachSplitOutputStructure {
  // Reasoning blocks go first, as in describeSplitOutput: a fence or a marker
  // the model wrote while thinking is not a draft or a part.
  const { drafts, brokenDrafts, strayMarkers } = readCoachAnswer(stripThinkBlocks(completionText));
  const partsPerDraft = drafts.map((body) => normalizeReplyParts(body).length);
  const countOk = draftsRequested === null
    ? partsPerDraft.length <= COACH_DRAFT_BLOCKS_MAX
    : partsPerDraft.length === draftsRequested;
  return {
    draftsRequested,
    partsPerDraft,
    brokenDrafts,
    strayMarkers,
    ok:
      countOk
      && partsPerDraft.every((parts) => parts >= SPLIT_PARTS_MIN && parts <= SPLIT_PARTS_MAX)
      && brokenDrafts === 0
      && strayMarkers === 0,
  };
}
