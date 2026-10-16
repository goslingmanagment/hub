import type { ReactNode } from "react";
import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { buildSettingsRoute, type SyncSettingsTab } from "@/lib/navigation";

// What the two sync screens (Fansly and OnlyFans) share: the way back, the
// page's name, the one status line every page opens with, and the pointer
// shown when a page is opened on the other platform's screen (the side
// navigation carries `?page=` across, and so do old bookmarks).

export type PageStatusTone = "success" | "warning" | "danger" | "info" | "neutral";

/** A page in one line: "Работает", "На паузе", "Нужен вход", "Нет прокси",
 *  "Отстаёт"… with why, in a few words. */
export interface PageStatus {
  kind: string;
  label: string;
  tone: PageStatusTone;
  reason: string | null;
}

const BADGES: Record<PageStatusTone, string> = {
  success: "badge badge-success",
  warning: "badge badge-warning",
  danger: "badge badge-danger",
  info: "badge badge-info",
  neutral: "badge",
};

export function statusBadgeClass(tone: PageStatusTone): string {
  return BADGES[tone];
}

export function PageStatusLine({ status }: { status: PageStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" data-page-status={status.kind}>
      <span className={statusBadgeClass(status.tone)}>{status.label}</span>
      {status.reason && <span className="min-w-0 text-sm text-text-secondary">{status.reason}</span>}
    </div>
  );
}

export function SyncBackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button type="button" onClick={onBack} className="btn btn-ghost btn-sm -ml-2.5 mb-3">
      &larr; {label}
    </button>
  );
}

/** The page's name with its platform and account, and the screen's actions on the right. */
export function SyncPageTitle({ page, actions }: { page: SyncBlocksPage; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-text-primary">{page.pageLabel}</h3>
        <PlatformBadge platform={page.platform} />
        {page.username && <span className="text-sm text-text-muted">@{page.username}</span>}
        {page.displayName && page.displayName !== page.username && (
          <span className="text-sm text-text-muted">{page.displayName}</span>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const OTHER_SCREEN: Record<SyncSettingsTab, { platform: string; screen: string }> = {
  engine: { platform: "Fansly", screen: "Fansly" },
  sync: { platform: "OnlyFans", screen: "OnlyFans" },
};

/** The page is the other platform's: say where its sync is and link there. */
export function SyncPageOnOtherTab({ pageLabel, tab }: { pageLabel: string; tab: SyncSettingsTab }) {
  const copy = OTHER_SCREEN[tab];
  return (
    <div className="card card-body" data-sync-other-screen={tab}>
      <p className="text-sm font-semibold text-text-primary">{pageLabel} — страница {copy.platform}</p>
      <p className="mt-1 text-sm text-text-secondary">Её сбор данных показан в разделе «{copy.screen}».</p>
      <Link to={buildSettingsRoute(tab, pageLabel)} className="link mt-3 inline-block text-sm">
        Открыть в разделе «{copy.screen}» &rarr;
      </Link>
    </div>
  );
}
