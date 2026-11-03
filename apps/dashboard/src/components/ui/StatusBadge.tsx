import { STATUS_TONE_CLASS, type StatusTone, type StatusWord } from "@/lib/statusWords";

/** A state in one word from lib/statusWords.ts. A state, not a button: what to do
 *  about it is a button beside it. `bare` drops the fill for a tight row. */
export function StatusBadge({ status, tone, children, bare = false, title }: {
  status?: StatusWord;
  tone?: StatusTone;
  children?: string;
  bare?: boolean;
  title?: string | undefined;
}) {
  const shownTone = status?.tone ?? tone;
  return (
    <span className={["badge", shownTone ? STATUS_TONE_CLASS[shownTone] : "", bare ? "badge-bare" : ""].filter(Boolean).join(" ")} title={title}>
      {status?.word ?? children}
    </span>
  );
}
