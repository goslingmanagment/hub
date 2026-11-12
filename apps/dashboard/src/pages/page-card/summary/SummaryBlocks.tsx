import { Link } from "react-router";
import type { Platform } from "@agency_hub_core/shared";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatUpdated } from "@/lib/format";
import { buildPageCollectionRoute, buildPageSectionRoute } from "@/lib/navigation";
import type { PageCollection } from "../usePageCollection.js";

/**
 * What is left of the page's card «Сводка» (it left on 12.11: the page is a
 * filter, and its blocks have their places elsewhere): «Вход и сбор», which
 * «Аккаунт на Fansly» shows at its top.
 */
export interface SummaryPage {
  id: number;
  label: string;
  platform: Platform;
  followerCount: { value: number | null; available: boolean } | null | undefined;
  lastLightSyncAt: string | null;
}

/** «Вход и сбор»: the word, why, and the owner's way to fix it. */
export function CollectionBlock({ page, collection, owner, compact = false }: { page: SummaryPage; collection: PageCollection; owner: boolean; compact?: boolean }) {
  if (page.platform === "telegram" || collection.hidden) return null;
  const word = collection.word;
  const fresh = collection.kind === "working" && page.lastLightSyncAt ? formatUpdated(page.lastLightSyncAt) : null;
  return (
    <section className={`card ${compact ? "summary-collection-compact" : ""}`} aria-labelledby="summary-collection-title">
      <div className="card-header"><h2 id="summary-collection-title" className="card-title">Вход и сбор</h2></div>
      <div className="card-body summary-collection">
        <div className="summary-collection-word">
          {word === null ? <Skeleton width={96} /> : <StatusBadge status={word} />}
          {collection.reason && collection.kind !== "working" && <span className="summary-row-note">{collection.reason}</span>}
          {fresh && <span className="summary-row-note">{fresh}</span>}
        </div>
        {owner && (
          <div className="summary-collection-actions">
            {page.platform === "fansly" && <Link className="btn btn-sm" to={buildPageSectionRoute(page.label, "browser-login")}>Войти в Fansly</Link>}
            {page.platform === "onlyfans" && <Link className="link" to="/system/onlyfans-api">OnlyFans API</Link>}
            <Link className="link" to={buildPageCollectionRoute(page.label)}>Сбор данных страницы</Link>
          </div>
        )}
      </div>
    </section>
  );
}
