import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";
import { openWordStart, rewriteWords } from "@agency_hub_core/shared";

/**
 * The answer with every whole word passed through `rewrite`, as the stream
 * goes: a delta's text goes out at once, but for a word it ends inside, held
 * back until a later delta shows where the word ends. The held tail goes out
 * before any other frame of the answer (usage, done, error) and when the
 * stream ends; reasoning passes untouched. `onRewritten` hears how many words
 * changed, once the stream is over.
 *
 * The fan's names typed plain (shared/name-spelling.ts) are its first use; a
 * rewrite only ever sees whole words, so it may lengthen or shorten them.
 */
export async function* rewriteWordsStream(
  frames: AsyncIterable<AiGatewayStreamFrame>,
  rewrite: (word: string) => string,
  onRewritten?: (count: number) => void,
): AsyncGenerator<AiGatewayStreamFrame> {
  let held = "";
  let rewritten = 0;
  const pass = (text: string): AiGatewayStreamFrame => ({
    type: "content_delta",
    text: rewriteWords(text, (word) => {
      const out = rewrite(word);
      if (out !== word) rewritten += 1;
      return out;
    }),
  });
  // The held tail, rewritten, once: what goes out before any other frame.
  const takeHeld = (): AiGatewayStreamFrame[] => {
    const tail = held;
    held = "";
    return tail === "" ? [] : [pass(tail)];
  };
  try {
    for await (const frame of frames) {
      if (frame.type === "content_delta") {
        const text = held + frame.text;
        const cut = openWordStart(text);
        held = text.slice(cut);
        if (cut > 0) yield pass(text.slice(0, cut));
      } else if (frame.type === "reasoning_delta") {
        yield frame;
      } else {
        yield* takeHeld();
        yield frame;
      }
    }
    yield* takeHeld();
  } catch (error) {
    // The answer failed mid-word: what was held is still what the model wrote.
    yield* takeHeld();
    throw error;
  } finally {
    onRewritten?.(rewritten);
  }
}
