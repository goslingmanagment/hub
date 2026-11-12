import { useState } from "react";
import { requestOfapiVaultListsWalk, useOfapiVaultLists } from "@/api/ofapiMedia";
import { Notice } from "@/components/ui/Notice";
import { formatAgo, formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

const albumsWord = (count: number) => `${count} ${ruPlural(count, "альбом", "альбома", "альбомов")}`;

/**
 * «Альбомы» of an OnlyFans page: its custom vault lists as Hub last walked
 * them. «Обновить альбомы» asks for a walk of the lists only (at most 12
 * requests); the minutely job answers it, the card says «обновляется» meanwhile.
 */
export function OfapiVaultListsCard({ pageId, owner, writeOff }: { pageId: number; owner: boolean; writeOff: string | null }) {
  const saved = useOfapiVaultLists(pageId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = saved.data;
  const albums = data?.lists.filter((list) => list.type === "custom") ?? [];
  const present = albums.filter((album) => album.missingSince === null);
  const missing = albums.length - present.length;
  const walk = data?.walk;
  const refreshing = walk?.requestedAt != null;
  const failedLast = walk?.failedAt != null && (walk.completedAt === null || walk.failedAt > walk.completedAt);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await requestOfapiVaultListsWalk(pageId);
      await saved.refetch();
    } catch {
      setError("Не получилось. Hub вернул ошибку.");
    } finally {
      setBusy(false);
    }
  }

  const caption = !data
    ? saved.isError ? "Недоступны" : "Загружаем…"
    : refreshing ? "Обновляется…"
      : walk?.completedAt ? `${albumsWord(present.length)} · ${formatAgo(walk.completedAt)}`
        : failedLast ? "Не обновились" : "Ещё не обновлялись";
  const captionHint = [
    walk?.completedAt ? `Полный обход: ${formatDateTime(walk.completedAt)}, ${walk.completedRequests ?? "?"} запр.` : null,
    failedLast && walk?.failedAt ? `Последний обход не дошёл до конца (${formatDateTime(walk.failedAt)}): ${walk.failure ?? "причина неизвестна"}. Пропавшими ничего не отмечено.` : null,
    missing > 0 ? `Пропали с OnlyFans: ${missing}.` : null,
  ].filter(Boolean).join("\n");

  return (
    <section className="card" aria-labelledby="vault-lists-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="vault-lists-title" className="card-title">Альбомы</h2>
          <p className="card-description" title={captionHint || undefined}>
            {caption}
            {failedLast && !refreshing && walk?.completedAt ? <span className="badge badge-warning ml-2">не до конца</span> : null}
          </p>
        </div>
        {owner && (
          <button
            type="button"
            className="btn btn-sm"
            title={writeOff ?? "Только списки альбомов: до 12 запросов, до 12 кредитов"}
            disabled={writeOff !== null || busy || refreshing || !pageId}
            onClick={() => void refresh()}
          >
            {refreshing ? "Обновляется…" : "Обновить альбомы"}
          </button>
        )}
      </div>
      {error && <div className="px-6 pt-4"><Notice tone="danger" role="alert">{error}</Notice></div>}
      <div className="max-h-96 overflow-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Альбом</th>
              <th className="text-right">Файлов</th>
            </tr>
          </thead>
          <tbody>
            {data && albums.length === 0 && (
              <tr><td colSpan={2} className="muted">{walk?.completedAt ? "Альбомов нет" : "Нажмите «Обновить альбомы»"}</td></tr>
            )}
            {albums.map((album) => (
              <tr key={album.listRef} className={album.missingSince ? "opacity-60" : undefined}>
                <td title={`ID ${album.listRef} · видели ${formatDateTime(album.lastSeenAt)}`}>
                  <span className="text-text-primary">{album.name || "Без названия"}</span>
                  {album.missingSince && (
                    <span className="badge ml-2" title={`Нет в полном обходе с ${formatDateTime(album.missingSince)}`}>пропал</span>
                  )}
                </td>
                <td className="text-right tabular-nums">{album.mediaCount ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
