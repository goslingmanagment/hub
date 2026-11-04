import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import type { PublicationWire } from "@agency_hub_core/contracts";
import { useAdminUsers } from "@/api/adminUsers";
import { useAgentKeys } from "@/api/agentKeys";
import { usePageProfile } from "@/api/page-profile";
import { usePagePromo } from "@/api/page-promo";
import { usePublicationDetail } from "@/api/publications";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { KeyValue, type KeyValueRow } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { buildPageRoute } from "@/lib/navigation";
import { buildPostUrl } from "@/lib/platformUrls";
import { ruPlural } from "@/lib/plural";
import { approveBlock, platformPostLink, withdrawReason, type RowActions } from "./PublicationsFeed.js";
import {
  FINDING_TONES,
  KIND_LABELS,
  OTHER_FINDING,
  actorLabel,
  attachmentAccessLabel,
  authorLabel,
  deletePostBlock,
  deletionNote,
  eventReasonLabel,
  findingText,
  journalStatusLabel,
  mediaName,
  mediaOf,
  momentLabel,
  orderedFindings,
  platformName,
  priceLabel,
  replyLockLabel,
  statusWord,
  whenLabel,
  withdrawalNote,
  type Names,
  type PagePublishing,
} from "./publicationsView.js";

function useNames(): Names {
  const users = useAdminUsers();
  const keys = useAgentKeys();
  return useMemo(() => ({
    users: new Map((users.data ?? []).map((user) => [user.id, user.username])),
    agentKeys: new Map((keys.data ?? []).map((key) => [key.id, key.name])),
  }), [users.data, keys.data]);
}

/** Wall and tier names of a Fansly page, read only when the post names some. */
function useTargetNames(publication: PublicationWire | undefined) {
  const fansly = publication?.platform === "fansly";
  const wants = (refs: readonly string[] | undefined) => fansly && (refs?.length ?? 0) > 0;
  const wallsWanted = wants(publication?.wallRefs) || wants(publication?.pinWallRefs);
  const tiersWanted = wants(publication?.tierRefs);
  const profile = usePageProfile(wallsWanted ? publication?.pageLabel ?? "" : "", 1);
  const promo = usePagePromo(tiersWanted ? publication?.pageLabel ?? "" : "");
  const walls = new Map((profile.data?.current?.walls ?? []).map((wall) => [wall.wallRef, wall.name]));
  const tiers = new Map((promo.data?.tiers ?? []).map((tier) => [tier.tierRef, tier.name]));
  return { walls, tiers };
}

/** «Posts, VIP»; a name not known: «2 стены». */
function namesOr(refs: readonly string[], names: ReadonlyMap<string, string | null>, one: string, few: string, many: string): string {
  const found = refs.map((ref) => names.get(ref) ?? null);
  if (found.every((name) => name !== null)) return found.join(", ");
  return `${refs.length} ${ruPlural(refs.length, one, few, many)}`;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pub-drawer-block">
      <h3 className="pub-drawer-heading">{title}</h3>
      {children}
    </section>
  );
}

function FileList({ items }: { items: readonly { key: string; text: string }[] }) {
  return (
    <ol className="pub-files">
      {items.map((item, index) => (
        <li key={item.key}><span className="pub-files-n">{index + 1}</span>{item.text}</li>
      ))}
    </ol>
  );
}

/**
 * Everything about one publication without losing the feed (spec §2). It shows
 * the post whatever the filter hides; every action takes this post's own id and
 * version, as shown.
 */
export function PublicationDrawer({ id, row, todayKey, pageState, username, actions, publicationHref, onClose }: {
  id: number;
  /** The row of the list, while the full read is on its way. */
  row: PublicationWire | undefined;
  todayKey: string;
  pageState: PagePublishing | undefined;
  username: string | null;
  actions: RowActions;
  publicationHref: (id: number) => string;
  onClose: () => void;
}) {
  const detail = usePublicationDetail(id);
  const shown: PublicationWire | undefined = detail.data ?? row;
  const names = useNames();
  const targets = useTargetNames(shown);

  if (shown === undefined) {
    const notFound = (detail.error as { status?: number } | null)?.status === 404;
    return (
      <Drawer title="Публикация" onClose={onClose}>
        {detail.isLoading ? (
          <div className="pub-drawer-skeleton" aria-hidden="true">
            {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} width={`${40 + ((index * 17) % 50)}%`} />)}
          </div>
        ) : notFound ? (
          <StatusPanel title="Такой публикации нет" action={<button type="button" className="btn btn-sm" onClick={onClose}>Закрыть</button>} />
        ) : (
          <StatusPanel
            title="Hub не ответил"
            description="Публикация не пришла. Это не значит, что её нет: попробуйте ещё раз."
            action={<button type="button" className="btn btn-sm" onClick={() => void detail.refetch()}>Повторить</button>}
          />
        )}
      </Drawer>
    );
  }

  const status = statusWord(shown);
  const reason = eventReasonLabel(shown.statusReason);
  const blocking = shown.findings.filter((finding) => finding.severity === "blocking");
  const commandNote = deletionNote(shown) ?? withdrawalNote(shown);
  const beforeOut = shown.status === "draft" || shown.status === "approved";
  const revision = detail.data?.revision ?? null;

  const notice = shown.status === "draft" && blocking.length > 0
    ? <Notice tone="danger" detail={blocking.length === 1 ? "Замечание ниже не даёт утвердить пост." : "Замечания ниже не дают утвердить пост."}><b>Нельзя утвердить</b></Notice>
    : commandNote !== null
      ? <Notice tone="warning">{commandNote.charAt(0).toUpperCase() + commandNote.slice(1)}</Notice>
      : beforeOut && pageState?.notPublishing
        ? <Notice tone="off">Страница сейчас не публикует: {pageState.badge.word}</Notice>
        : null;

  const properties: KeyValueRow[] = [
    { label: "Страница", value: <Link className="link" to={buildPageRoute(shown.pageLabel)}>{shown.pageLabel}, {platformName(shown.platform)}</Link> },
    { label: "Тип", value: `${KIND_LABELS[shown.kind]}${shown.repost ? ", перезалив" : ""}` },
    { label: "Выход", value: momentLabel(shown.publishAt, todayKey) },
    { label: "На стене до", value: shown.expiresAt === null ? "без срока" : momentLabel(shown.expiresAt, todayKey) },
  ];
  if (shown.priceMills !== null) {
    properties.push({ label: shown.kind === "subscriber_post" ? "Цена для остальных" : "Цена", value: <span className="tabular-nums">{priceLabel(shown.priceMills)}</span> });
  }
  if (shown.wallRefs.length > 0) properties.push({ label: "Стены", value: namesOr(shown.wallRefs, targets.walls, "стена", "стены", "стен") });
  if (shown.tierRefs.length > 0) properties.push({ label: "Уровни подписки", value: namesOr(shown.tierRefs, targets.tiers, "уровень", "уровня", "уровней") });
  if (shown.pinWallRefs.length > 0) properties.push({ label: "Закреплён на стенах", value: namesOr(shown.pinWallRefs, targets.walls, "стена", "стены", "стен") });
  if (shown.subscribersOnly) properties.push({ label: "Покупают", value: "только подписчики" });
  if (shown.replyLock.length > 0) properties.push({ label: "Отвечать могут", value: replyLockLabel(shown.replyLock) });
  properties.push({ label: "Автор", value: `${authorLabel(shown.author, names)}, ${momentLabel(shown.createdAt, todayKey)}` });
  if (revision !== null) {
    properties.push({ label: "Утвердил", value: `${names.users.get(revision.approvedByUserId) ?? "сотрудник"}, ${momentLabel(revision.approvedAt, todayKey)}` });
  }
  if (shown.previousPublicationId !== null) {
    properties.push({ label: "Замена", value: <>Заменяет другой пост. <Link className="link" replace to={publicationHref(shown.previousPublicationId)}>Открыть прошлый пост</Link></> });
  }

  const files = mediaOf(shown.media, "media").map((item) => ({ key: `m${item.position}`, text: mediaName(item) }));
  const previews = mediaOf(shown.media, "preview").map((item) => ({ key: `p${item.position}`, text: mediaName(item) }));

  const findings = orderedFindings(shown.findings);
  const unknownFindings = findings.filter((finding) => findingText(finding, todayKey) === OTHER_FINDING);
  const stopped = actions.stoppedPages.has(shown.pageLabel);
  const deletion = deletePostBlock(shown, stopped);
  const withdrawal = withdrawReason(shown, actions);
  const link = platformPostLink(shown, username);

  const footer: ReactNode[] = [];
  const reasons: string[] = [];
  if (shown.status === "draft") {
    const block = approveBlock(shown, actions);
    if (block) reasons.push(block);
    footer.push(<button key="approve" type="button" className="btn btn-primary" disabled={actions.busy || block !== null} onClick={() => actions.onApprove(shown)}>Утвердить</button>);
  }
  if (shown.status === "unknown") {
    footer.push(<button key="resolve" type="button" className="btn btn-primary" disabled={actions.busy} onClick={() => actions.onResolve(shown)}>Проверить</button>);
  }
  if (withdrawal !== undefined) {
    if (withdrawal) reasons.push(withdrawal);
    footer.push(<button key="withdraw" type="button" className="btn btn-danger-outline" disabled={actions.busy || withdrawal !== null} onClick={() => actions.onWithdraw(shown)}>Убрать из расписания</button>);
  }
  if (deletion !== undefined) {
    if (deletion) reasons.push(deletion);
    footer.push(<button key="delete" type="button" className="btn btn-danger-outline" disabled={actions.busy || deletion !== null} onClick={() => actions.onDeletePost(shown)}>Удалить со стены</button>);
  }
  if (shown.status === "published" && link !== null) {
    footer.push(<a key="open" className="btn" href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>);
  }
  if (shown.status === "withdrawn") {
    footer.push(<button key="replace" type="button" className="btn" disabled={actions.busy} onClick={() => actions.onReplace(shown)}>Заменить</button>);
  }
  if (shown.status === "draft" || shown.status === "approved") {
    footer.push(<button key="cancel" type="button" className="btn btn-danger-outline" disabled={actions.busy} onClick={() => actions.onCancel(shown)}>Отменить публикацию</button>);
  }

  const raw: KeyValueRow[] = [
    { label: "Номер публикации", value: String(shown.id) },
    ...(shown.platformPostRef !== null ? [{ label: "Номер поста", value: shown.platformPostRef }] : []),
    ...(shown.vaultAlbumRef !== null ? [{ label: "Номер альбома", value: shown.vaultAlbumRef }] : []),
    ...(shown.wallRefs.length > 0 ? [{ label: "Стены", value: shown.wallRefs.join(", ") }] : []),
    ...(shown.pinWallRefs.length > 0 ? [{ label: "Закреплён", value: shown.pinWallRefs.join(", ") }] : []),
    ...(shown.tierRefs.length > 0 ? [{ label: "Уровни", value: shown.tierRefs.join(", ") }] : []),
    ...(shown.media.length > 0 ? [{ label: "Файлы", value: shown.media.map((item) => (item.source === "vault" ? `медиатека ${item.mediaRef ?? "?"}` : `файл ${item.fileId ?? "?"}`)).join(", ") }] : []),
    ...(shown.statusReason ? [{ label: "Причина статуса", value: shown.statusReason }] : []),
    ...(shown.withdrawal?.errorCode ? [{ label: "Код команды убрать", value: shown.withdrawal.errorCode }] : []),
    ...(shown.deletion?.errorCode ? [{ label: "Код удаления", value: shown.deletion.errorCode }] : []),
    {
      label: "Автор",
      value: shown.author.kind === "agent" ? `ключ агента ${shown.author.agentKeyId ?? "?"}` : `сотрудник ${shown.author.userId ?? "?"}`,
    },
    ...(revision !== null ? [{ label: "Утвердил", value: `сотрудник ${revision.approvedByUserId}` }] : []),
    ...(unknownFindings.length > 0 ? [{ label: "Коды замечаний", value: unknownFindings.map((finding) => finding.code).join(", ") }] : []),
  ];

  return (
    <Drawer title={`${shown.pageLabel} · ${whenLabel(shown.publishAt, todayKey)} · ${KIND_LABELS[shown.kind]}`} onClose={onClose}>
      <div className="pub-drawer">
        <p className="pub-drawer-status">
          <StatusBadge status={status} />
          {reason !== null && <span>{reason.charAt(0).toUpperCase() + reason.slice(1)}</span>}
        </p>
        {notice}
        <KeyValue rows={properties} className="pub-drawer-kv" />

        <Block title="Текст">
          {shown.text.trim() === ""
            ? <p className="pub-muted">Без текста</p>
            : <p className="pub-drawer-text">{shown.text}</p>}
        </Block>

        <Block title="Файлы">
          {files.length === 0 && previews.length === 0 && shown.extraAttachments.length === 0
            ? <p className="pub-muted">Без файлов</p>
            : (
              <div className="pub-file-groups">
                {files.length > 0 && <FileList items={files} />}
                {previews.length > 0 && (
                  <div>
                    <p className="pub-file-group">Превью</p>
                    <FileList items={previews} />
                  </div>
                )}
                {shown.extraAttachments.map((extra) => (
                  <div key={extra.attachment}>
                    <p className="pub-file-group">Вложение {extra.attachment + 1} — {attachmentAccessLabel(extra)}</p>
                    <FileList items={[
                      ...mediaOf(shown.media, "media", extra.attachment).map((item) => ({ key: `m${item.position}`, text: mediaName(item) })),
                      ...mediaOf(shown.media, "preview", extra.attachment).map((item) => ({ key: `p${item.position}`, text: `превью: ${mediaName(item)}` })),
                    ]} />
                  </div>
                ))}
              </div>
            )}
        </Block>

        {findings.length > 0 && (
          <Block title={shown.status === "draft" ? "Замечания" : "Замечания при утверждении"}>
            <ul className="pub-findings">
              {findings.map((finding, index) => {
                const postUrl = buildPostUrl(shown.platform, username, finding.postRef);
                return (
                  <li key={`${finding.code}:${finding.mediaKey ?? ""}:${index}`} className={FINDING_TONES[finding.severity]}>
                    {finding.severity === "blocking" && shown.status === "draft" && <b>Нельзя утвердить: </b>}
                    {findingText(finding, todayKey, shown.media)}
                    {finding.publicationId !== null
                      ? <> <Link className="link" replace to={publicationHref(finding.publicationId)}>Открыть публикацию</Link></>
                      : postUrl !== null ? <> <a className="link" href={postUrl} target="_blank" rel="noopener noreferrer">Открыть пост</a></> : null}
                  </li>
                );
              })}
            </ul>
          </Block>
        )}

        <Block title="Журнал статусов">
          {detail.data ? (
            <ol className="pub-journal">
              {detail.data.events.map((event, index) => (
                <li key={`${event.at}:${index}`}>
                  <span className="pub-journal-at">{momentLabel(event.at, todayKey)}</span>
                  <span className="pub-journal-what">
                    {event.fromStatus === null ? "" : `${journalStatusLabel(event.fromStatus, null)} → `}{journalStatusLabel(event.toStatus, event.reason)}
                    <span className="pub-journal-who"> · {actorLabel(event, names)}</span>
                    {eventReasonLabel(event.reason) !== null && <span className="pub-journal-why"> ({eventReasonLabel(event.reason)})</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : detail.isError ? (
            <p className="pub-muted" role="alert">
              Журнал не загрузился.{" "}
              <button type="button" className="link" onClick={() => void detail.refetch()}>Повторить</button>
            </p>
          ) : (
            <p className="pub-muted" role="status">Загружаем журнал…</p>
          )}
        </Block>

        <Disclosure label="Подробнее">
          <KeyValue rows={raw} className="pub-raw" />
        </Disclosure>

        {footer.length > 0 && (
          <div className="pub-drawer-foot">
            <div className="pub-drawer-buttons">{footer}</div>
            {reasons.length > 0 && <p className="pub-drawer-why">{reasons.join(". ")}</p>}
          </div>
        )}
      </div>
    </Drawer>
  );
}
