import { useState, type MouseEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { formatRelativeTime } from "@/lib/format";
import type { WorkboardPresenceVm } from "@/pages/workboard/viewModel";

interface PresencePanelProps {
  updatedAt: string | null;
  loading: boolean;
  unavailable: boolean;
  activeNow: WorkboardPresenceVm[];
  activeNowTotal: number;
  recentlyActive: WorkboardPresenceVm[];
  recentlyActiveTotal: number;
}

interface PresenceBucketProps {
  title: string;
  total: number;
  items: WorkboardPresenceVm[];
}

function PresenceRow({ item }: { item: WorkboardPresenceVm }) {
  const [copied, setCopied] = useState(false);
  const externalLinkLabel = item.fanslyExternalKind === "profile" ? "Профиль" : "Чат";
  const externalLinkTitle = item.fanslyExternalKind === "profile"
    ? "Скопировать ссылку на профиль Fansly"
    : "Скопировать ссылку на чат Fansly";

  async function handleCopyFanslyLink(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!item.fanslyExternalUrl) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Буфер обмена недоступен");
      return;
    }

    try {
      await navigator.clipboard.writeText(item.fanslyExternalUrl);
      setCopied(true);
      toast.success(item.fanslyExternalKind === "chat" ? "Ссылка на чат скопирована" : "Ссылка на профиль скопирована");
      globalThis.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Не удалось скопировать ссылку");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm font-semibold text-text-primary">{item.fanLabel}</span>
          {item.fanSubLabel && (
            <span className="truncate text-[12px] text-text-muted">{item.fanSubLabel}</span>
          )}
          {item.isSubscriber && (
            <span className="inline-flex rounded bg-fansly/15 px-1.5 py-0.5 text-[10px] font-semibold text-fansly">
              Subscriber
            </span>
          )}
        </div>
        <div className="mt-1 text-[12px] text-text-muted">
          <span className="font-medium text-text-secondary">{item.presenceLabel}</span>
          <span className="mx-1 text-border">·</span>
          <span>LTV {item.ltvLabel}</span>
          {item.lastTransactionLabel && (
            <>
              <span className="mx-1 text-border">·</span>
              <span>Spent {item.lastTransactionLabel}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.fanslyExternalUrl && (
          <button
            type="button"
            onClick={handleCopyFanslyLink}
            className="px-1.5 py-0.5 text-[10px] font-medium rounded border border-border text-text-secondary hover:bg-hover transition-colors"
            title={externalLinkTitle}
            aria-label={externalLinkTitle}
          >
            {copied ? "Скопировано!" : externalLinkLabel}
          </button>
        )}
        <Link
          to={item.profileHref}
          className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent text-white hover:bg-accent/85 transition-colors"
        >
          Профиль
        </Link>
      </div>
    </div>
  );
}

function PresenceBucket({ title, total, items }: PresenceBucketProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{title} ({total})</h3>
        {total > items.length && (
          <span className="text-[11px] text-text-muted">Showing {items.length}</span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-text-muted">
          No fans in this bucket.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <PresenceRow key={item.fanId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PresencePanel({
  updatedAt,
  loading,
  unavailable,
  activeNow,
  activeNowTotal,
  recentlyActive,
  recentlyActiveTotal,
}: PresencePanelProps) {
  return (
    <section className="mb-5 rounded-xl border border-border bg-hover/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Presence</h2>
          <p className="mt-1 text-[12px] text-text-muted">
            Inferred from Fansly follower activity.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex rounded-full bg-warning/10 px-2 py-1 font-semibold text-warning">
            Best effort
          </span>
          {updatedAt && (
            <span className="text-text-muted">Updated {formatRelativeTime(updatedAt)}</span>
          )}
        </div>
      </div>

      {unavailable ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-text-muted">
          Presence unavailable right now.
        </div>
      ) : loading && !updatedAt ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-text-muted">
          Loading inferred presence…
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <PresenceBucket title="Active now" total={activeNowTotal} items={activeNow} />
          <PresenceBucket title="Recently active" total={recentlyActiveTotal} items={recentlyActive} />
        </div>
      )}
    </section>
  );
}
