import { useState } from "react";

import type { ContentCommentsResponse, CreatorStatsContentResponse } from "@agency_hub_core/contracts";
import { Pagination } from "@/components/shared/Pagination";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDay } from "@/lib/format";

import { StatsCard, StatsEmpty } from "./StatsCard.js";
import { fanslyPostUrl } from "./media-words.js";

const PAGE_SIZE = 20;
const CAPTION_LIMIT = 70;

function cut(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > CAPTION_LIMIT ? `${clean.slice(0, CAPTION_LIMIT).trimEnd()}…` : clean;
}

/**
 * «Комментарии к постам» over the screen's days. The post is named by its text,
 * never by its number; the order is the server's: posts with new comments first.
 */
export function CommentsPanel({ comments, media, pageLabel, periodText }: {
  comments: {
    data: ContentCommentsResponse | undefined;
    isError: boolean;
    isPlaceholderData: boolean;
    refetch: () => unknown;
  };
  /** The window's media: a caption to fall back on. */
  media: CreatorStatsContentResponse["media"];
  pageLabel: string;
  periodText: string;
}) {
  const [offset, setOffset] = useState(0);
  const data = comments.data;
  const replies = data?.coverage.filter((row) => row.plane === "post_replies") ?? [];
  const inProgress = replies.some((row) => row.status === "in_progress");
  const neverRead = data !== undefined && (replies.length === 0 || replies.every((row) => row.status === "not_started"));
  const description = inProgress
    ? "Сколько комментариев у постов за период. Сбор комментариев ещё идёт: за часть периода их может не быть."
    : "Сколько комментариев у постов за период, сначала посты с новыми.";
  const posts = data?.perPost ?? [];
  const page = posts.slice(offset, offset + PAGE_SIZE);
  const captionOf = (postRef: string, caption: string | null) =>
    caption?.trim() ? cut(caption) : media.find((row) => row.postId === postRef && row.caption?.trim())?.caption ?? null;

  return (
    <StatsCard
      id="stats-comments"
      title="Комментарии к постам"
      description={description}
      footer={posts.length > PAGE_SIZE ? <Pagination offset={offset} limit={PAGE_SIZE} total={posts.length} onPageChange={setOffset} /> : undefined}
    >
      {data === undefined ? (
        comments.isError ? <NoAnswerPanel retry={() => comments.refetch()} /> : (
          <div className="card-body"><Skeleton width="70%" /><div className="mt-3"><Skeleton width="55%" /></div><div className="mt-3"><Skeleton width="62%" /></div></div>
        )
      ) : neverRead && posts.length === 0 ? (
        <StatsEmpty>Комментарии для {pageLabel} ещё не собирались. Это не ноль.</StatsEmpty>
      ) : posts.length === 0 ? (
        <StatsEmpty>На {pageLabel} за {periodText} комментариев не собрано.</StatsEmpty>
      ) : (
        <div className={`table-wrap${comments.isPlaceholderData ? " is-refreshing" : ""}`}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Пост</th>
                <th scope="col" className="num">Комментарии</th>
                <th scope="col" className="num">Пропали</th>
                <th scope="col">Полнота</th>
              </tr>
            </thead>
            <tbody>
              {page.map((post) => {
                const caption = captionOf(post.postRef, post.caption);
                return (
                  <tr key={post.postRef}>
                    <td className="stats-media-cell">
                      <div className="stats-media-title">{caption ? cut(caption) : "Пост без подписи"}</div>
                      <div className="stats-media-line">
                        {post.publishedAt ? `вышел ${formatDay(post.publishedAt)} · ` : ""}
                        <a className="link" href={fanslyPostUrl(post.postRef)} target="_blank" rel="noreferrer">Открыть на Fansly</a>
                      </div>
                    </td>
                    <td className="num">{formatCount(post.commentCount)}</td>
                    <td className="num">{formatCount(post.missingCount)}</td>
                    <td>
                      {post.possiblyTruncatedCount > 0
                        ? <StatusBadge tone="attention">{`Возможно, не все (${formatCount(post.possiblyTruncatedCount)})`}</StatusBadge>
                        : <span className="muted">собрано</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
  );
}
