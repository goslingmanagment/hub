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
