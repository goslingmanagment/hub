import { Chip } from "@agency_hub_core/ui";

/**
 * A page («mia-1») in a row or a header: a quiet 28 px chip. `selected` when it
 * is the filter in force. The platform is plain words on hover, no brand colours.
 */
export function PageChip({ label, platform, selected = false }: { label: string; platform?: string; selected?: boolean }) {
  const word = platform === "fansly" ? "Fansly" : platform === "onlyfans" ? "OnlyFans" : platform === "telegram" ? "Telegram" : undefined;
  return <Chip selected={selected} {...(word ? { title: `${label} · ${word}` } : {})}>{label}</Chip>;
}

/** Several pages in a row: chips with a little gap, wrapping when there is no room. */
export function PageChips({ labels, max = 4 }: { labels: readonly string[]; max?: number }) {
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span style={{ display: "inline-flex", flexWrap: "nowrap", gap: 4, verticalAlign: "middle", maxWidth: "100%" }}>
      {shown.map((label) => <PageChip key={label} label={label} />)}
      {rest > 0 && <Chip title={labels.slice(max).join(", ")}>+{rest}</Chip>}
    </span>
  );
}
