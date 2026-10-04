import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { buildSettingsRoute, type SyncSettingsTab } from "@/lib/navigation";

// What the page details of the two sync tabs share: the way back, the page's
// name, and the pointer shown when a page is opened on the tab of the other
// engine (the section links carry `?page=` across, and so do old bookmarks).

export function SyncBackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-xs text-text-muted hover:text-text-secondary transition-colors mb-3"
    >
      &larr; {label}
    </button>
  );
}

export function SyncPageTitle({ page }: { page: SyncBlocksPage }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-bold text-text-primary">{page.pageLabel}</span>
      <PlatformBadge platform={page.platform} />
      {page.username && <span className="text-xs text-text-muted">@{page.username}</span>}
      {page.displayName && page.displayName !== page.username && (
        <span className="text-xs text-text-muted">{page.displayName}</span>
      )}
    </div>
  );
}

const OTHER_TAB_COPY: Record<SyncSettingsTab, { title: (pageLabel: string) => string; text: string; link: string }> = {
  engine: {
    title: (pageLabel) => `Страницу ${pageLabel} читает Fansly Sync Engine`,
    text: "Её состояние, очередь, заявки на историю и кнопки — на вкладке «Синк».",
    link: "Открыть в «Синк»",
  },
  sync: {
    title: (pageLabel) => `Страницу ${pageLabel} Fansly Sync Engine не читает`,
    text: "Её блоки и кнопки — на вкладке «Синхронизация».",
    link: "Открыть в «Синхронизация»",
  },
};

/** The page belongs to the other sync tab: say where it is and link there. */
export function SyncPageOnOtherTab({ pageLabel, tab }: { pageLabel: string; tab: SyncSettingsTab }) {
  const copy = OTHER_TAB_COPY[tab];
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <p className="text-sm font-semibold text-text-primary">{copy.title(pageLabel)}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{copy.text}</p>
      <Link
        to={buildSettingsRoute(tab, pageLabel)}
        className="mt-2 inline-block text-xs font-semibold text-accent hover:underline"
      >
        {copy.link} &rarr;
      </Link>
    </div>
  );
}
