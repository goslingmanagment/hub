import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

import { useCreatorStatsContent } from "@/api/creator-stats";
import { useContentComments } from "@/api/insights";
import { CommentsPanel } from "@/components/creator-stats/CommentsPanel";
import { MediaTable, walkIncomplete } from "@/components/creator-stats/ContentPanels";
import { MediaDrawer } from "@/components/creator-stats/MediaDrawer";
import { TopSalesPanel } from "@/components/creator-stats/TopSalesPanel";
import { expectedWindow, newestUpdate, shiftDay } from "@/components/creator-stats/creator-stats-model";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PERIOD_LABELS } from "@/lib/period";

import { HowCounted, QueryGate, StatsHeader, StatsNotices, incompleteGoesQuiet } from "./StatsScreen.js";
import { useStatsPage } from "./useStatsPage.js";

/** «Контент»: which media are watched, bought and commented. `?media=` is the open card. */
export function StatsContentPage() {
  const { pageLabel, days, periodKey, substituted } = useStatsPage();
  const [search, setSearch] = useSearchParams();
  const content = useCreatorStatsContent(pageLabel, days);
  const data = content.data;
  const window = data?.window ?? expectedWindow(days);
  // The same UTC days as the rest of the screen, not sliding hours.
  const commentsWindow = useMemo(() => ({
    from: `${window.fromDay}T00:00:00.000Z`,
    to: `${shiftDay(window.toDay, 1)}T00:00:00.000Z`,
  }), [window.fromDay, window.toDay]);
  const comments = useContentComments(pageLabel, commentsWindow);
  const updatedAt = newestUpdate(comments.data?.coverage.filter((row) => row.plane === "creator_stats_media") ?? []);
  const periodText = PERIOD_LABELS[periodKey].toLowerCase();
  const incomplete = data ? walkIncomplete(data) : null;
  const notices = { pageLabel, updatedAt, incomplete, substituted };

  const mediaId = search.get("media");
  const open = useCallback((id: string) => {
    const next = new URLSearchParams(globalThis.location.search);
    next.set("media", id);
    setSearch(next);
  }, [setSearch]);
  const close = useCallback(() => {
    const next = new URLSearchParams(globalThis.location.search);
    next.delete("media");
    setSearch(next);
  }, [setSearch]);

  return (
    <div className="stats-screen">
      <StatsHeader
        window={window}
        updatedAt={updatedAt}
        refreshing={content.isFetching || comments.isFetching}
        onRefresh={() => {
          void content.refetch();
          void comments.refetch();
        }}
        extraNote={incompleteGoesQuiet(notices) ? incomplete : null}
      />
      <StatsNotices {...notices} />
      <div className="stats-stack">
        <QueryGate
          query={content}
          pageLabel={pageLabel}
          skeleton={<div className="card"><TableSkeleton rows={8} columns={7} /></div>}
        >
          {(data) => (
            <div className="stats-stack">
              <MediaTable data={data} pageLabel={pageLabel} periodText={periodText} onOpen={open} />
              <TopSalesPanel data={data} pageLabel={pageLabel} onOpen={open} />
            </div>
          )}
        </QueryGate>
        <CommentsPanel comments={comments} media={data?.media ?? []} pageLabel={pageLabel} periodText={periodText} />
      </div>
      <HowCounted>
        <p>Строки таблицы — дневные данные Fansly по каждому медиа, сложенные за период. Hub обходит медиа сам: новые каждые 6 часов, до 30 дней ежедневно, старше реже.</p>
        <p>For You показывает только видео и только первые 90 дней после публикации, поэтому у фото и старых видео прочерк.</p>
        <p>Досмотр — средняя доля видео, которую посмотрели. До конца — доля просмотров, дошедших до конца. За всё время — итог Fansly по прочитанным источникам. Лайки — числа; кто именно лайкнул, Fansly не отдаёт.</p>
        <p>Продажи Fansly отдаёт только итогом за всё время, поэтому «Что покупают» от периода не зависит. Большинство таких медиа продано в сообщениях: поста и подписи у них нет, а просмотров часто тоже. «До комиссии, расчёт» считает Hub: после комиссии ÷ 0,8. С суммой после комиссии её не складываем.</p>
        <p>«Возможно, не все» — у поста была подозрительно полная страница ответов, а надёжного способа листать дальше у Fansly нет. «Пропали» — комментарии, которых больше нет на Fansly. Ответ только вложением тоже считается.</p>
      </HowCounted>
      {mediaId && (
        <MediaDrawer
          key={mediaId}
          mediaOfferId={mediaId}
          pageLabel={pageLabel}
          days={days}
          window={window}
          row={data?.media.find((row) => row.mediaOfferId === mediaId) ?? null}
          sold={data?.topSales.find((row) => row.mediaOfferId === mediaId) ?? null}
          onClose={close}
        />
      )}
    </div>
  );
}
