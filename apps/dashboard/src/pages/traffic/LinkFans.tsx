import { Fan, collidingFanNames, fanNameCollides } from "@agency_hub_core/ui";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { useOfLinkFans } from "@/api/ofLinkFans";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { linkFansView } from "./linkFansView.js";

/**
 * «Фаны» of the page of one link: whom the link brought, as the last walk of
 * its lists saw them — the money first, then the newest. One line a fan; the
 * walk's date is said once, over the list.
 */
export function LinkFans({ pageId, linkKind, linkRef, pageLabel }: {
  pageId: number;
  linkKind: "tracking" | "trial";
  linkRef: string;
  pageLabel: string | null;
}) {
  const fans = useOfLinkFans({ pageId, linkKind, linkRef });
  const body = (() => {
    if (!fans.data) return fans.isError ? <NoAnswerPanel retry={fans.refetch} /> : <TableSkeleton rows={4} columns={3} />;
    const view = linkFansView(fans.data.pages, pageLabel, moscowToday());
    if (view.neverRead) return <p className="tlf-quiet">Список фанов этой ссылки ещё не читался</p>;
    const withMoney = view.lines.some((line) => line.money !== null);
    const colliding = collidingFanNames(view.lines);
    return (
      <>
        <p className="tlf-head">{view.head}</p>
        {view.lines.length > 0 && (
          <ul className={withMoney ? "tlf-list" : "tlf-list tlf-list-nomoney"}>
            {view.lines.map((line) => (
              <li key={line.key} className="tlf-line">
                <Fan
                  name={line.name}
                  username={line.username}
                  fanRef={line.fanRef}
                  showLogin={fanNameCollides(line, colliding)}
                  {...(line.href ? { href: line.href } : {})}
                  className="tlf-name"
                />
                <span className="tlf-since">
                  {line.since}
                  {line.left && <span className="tlf-left">ушёл</span>}
                </span>
                {line.money !== null && (
                  <span className={line.money.startsWith("$") ? "tlf-money" : "tlf-money tlf-money-none"}>{line.money}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {view.more && (
          <button type="button" className="btn btn-sm btn-ghost tlf-more" disabled={fans.isFetchingNextPage} onClick={() => void fans.fetchNextPage()}>
            {fans.isFetchingNextPage ? "Загружаем…" : view.more}
          </button>
        )}
      </>
    );
  })();
  return (
    <section className="tl-section" aria-label="Фаны">
      <h2 className="tl-section-title">Фаны</h2>
      {body}
    </section>
  );
}
