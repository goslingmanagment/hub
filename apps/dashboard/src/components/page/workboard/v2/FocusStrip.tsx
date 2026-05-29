import { ArrowRight, Target } from "lucide-react";

import { TAB_LABELS, type WorkboardV2Tab } from "./tone";

type Count = { tab: string; secondaryStatus: string; count: number };

// Old mass is residual by definition — never the cross-book Focus recommendation.
const CANDIDATE_TABS: WorkboardV2Tab[] = ["subscribers", "spenders", "fresh_mass"];

export function FocusStrip({
  counts,
  activeTab,
  onOpen,
}: {
  counts: Count[];
  activeTab: WorkboardV2Tab;
  onOpen: (tab: WorkboardV2Tab) => void;
}) {
  const n = (tab: WorkboardV2Tab, status: string) =>
    counts.filter((c) => c.tab === tab && c.secondaryStatus === status).reduce((s, c) => s + c.count, 0);

  const scored = CANDIDATE_TABS.map((tab) => {
    const rp = n(tab, "recent_purchase");
    const nr = n(tab, "need_reply");
    const dn = n(tab, "due_now");
    return { tab, score: rp * 3 + nr * 2 + dn, rp, nr, dn };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score === 0) {
    return null; // nothing pressing → no strip (calm by default)
  }

  const parts: string[] = [];
  if (top.rp > 0) parts.push(`${top.rp} недавн. покупок`);
  if (top.nr > 0) parts.push(`${top.nr} ждут ответа`);
  if (top.dn > 0) parts.push(`${top.dn} срочных`);
  const reason = parts.slice(0, 2).join(" + ") || "есть приоритетные задачи";

  return (
    <div className="mb-3 flex items-center gap-3 rounded-card border border-accent/25 bg-accent/[0.05] px-4 py-2.5">
      <Target size={16} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold uppercase tracking-wide text-accent">
          Фокус сейчас — {TAB_LABELS[top.tab]}
        </div>
        <div className="truncate text-[13px] text-text-secondary">{reason}</div>
      </div>
      {top.tab !== activeTab && (
        <button
          type="button"
          onClick={() => onOpen(top.tab)}
          className="inline-flex shrink-0 items-center gap-1 rounded-button bg-accent px-3 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          Открыть
          <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
