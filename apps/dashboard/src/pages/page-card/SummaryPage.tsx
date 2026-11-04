import { Link, useParams } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useOfapiStatus } from "@/api/waiting";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { decodeRouteSegment } from "@/lib/navigation";
import { usePageCollection } from "./usePageCollection.js";
import { AudienceBlock, CollectionBlock, GoLinks, LastOperationsBlock, MoneyBlock, OnPageBlock, PeopleBlock, type SummaryPage as Page } from "./summary/SummaryBlocks.js";

/**
 * «Сводка» of a page's card: how the page does over the period and what on it
 * asks for a look. Reads only; every block lives on its own read (§9.3).
 */
export function SummaryPage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const { findPageByLabel } = useDashboardShell();
  const found = findPageByLabel(decodeRouteSegment(pageLabel));
  const { data: auth } = useAuthMe();
  const role = auth?.user.role === "owner" ? "owner" : "team_lead";
  if (!found) return null;
  return <Summary page={found} role={role} />;
}

function Summary({ page, role }: { page: Page & { modelName: string }; role: "owner" | "team_lead" }) {
  const owner = role === "owner";
  const ofapi = useOfapiStatus(role);
  const collection = usePageCollection(page, role);
  const { key: period, select } = useScreenPeriod();

  if (page.platform === "telegram") {
    return (
      <div className="pc-summary">
        <StatusPanel title="Hub не собирает данные Telegram" action={owner ? <Link className="btn btn-sm" to={`/settings/pages#page-${page.label}`}>Изменить страницу</Link> : undefined} />
        {owner && <PeopleBlock page={page} />}
      </div>
    );
  }

  return (
    <div className="pc-summary">
      <MoneyBlock page={page} period={period} onShowThirty={() => select("30d")} onShowWeek={() => select("7d")} />
      <div className="summary-grid-3">
        <AudienceBlock page={page} period={period} ofapi={ofapi} />
        <OnPageBlock page={page} ofapi={ofapi} />
        <CollectionBlock page={page} collection={collection} owner={owner} />
      </div>
      <div className={owner ? "summary-grid-2" : undefined}>
        <LastOperationsBlock page={page} />
        {owner && <PeopleBlock page={page} />}
      </div>
      <GoLinks page={page} owner={owner} />
    </div>
  );
}
