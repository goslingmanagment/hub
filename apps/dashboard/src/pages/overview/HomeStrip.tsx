import { Link } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useTeamShifts } from "@/api/team";
import { useWaitingCounts, type WaitingRow } from "@/api/waiting";
import { formatDuration, formatTimeOfDay } from "@/lib/format";

/**
 * The two lines above the money on Главная: what waits for the owner and who is
 * working now. They only count and lead to where the thing is done; the trends
 * below stay the screen's main content.
 */
const SHORT_LABEL: Readonly<Record<WaitingRow["id"], string>> = {
  drafts: "Посты на утверждение",
  unknown: "Исход неизвестен",
  disputes: "Споры по продажам",
  customs: "Кастомы не отданы",
  held: "Проверить отправки",
  login: "Нужен вход",
  failures: "Сбои",
  extension: "Сбои расширения",
  history: "Заявки на историю",
};

const DOT: Partial<Readonly<Record<WaitingRow["id"], string>>> = {
  unknown: "status-dot-warn",
  login: "status-dot-error",
  failures: "status-dot-error",
  extension: "status-dot-error",
};

/** A shift's window, its end on the minute: one query key per minute, not per render. */
function lastDay(now = Date.now()): { from: string; to: string } {
  const to = Math.floor(now / 60_000) * 60_000;
  return { from: new Date(to - 24 * 60 * 60_000).toISOString(), to: new Date(to).toISOString() };
}

function WaitingLine({ role }: { role: string }) {
  const { rows, loading, failed, refetchAll } = useWaitingCounts(role);
  // Nothing waits: no line at all rather than a line saying so (owner, 2026-11-04).
  if (!loading && rows.length === 0) return null;
  return (
    <div className="home-strip-row">
      <span className="home-strip-label">Ждут вас</span>
      <div className="home-strip-items">
        {loading && rows.length === 0 && <span className="text-text-muted">Проверяем…</span>}
        {rows.map((row) => (
          <Link key={row.id} to={row.to} className="home-strip-item">
            {DOT[row.id] && <span className={`status-dot ${DOT[row.id]}`} aria-hidden="true" />}
            {row.count === null ? (
              <span>{SHORT_LABEL[row.id]}: <span className="text-text-muted">не удалось проверить</span></span>
            ) : row.page !== undefined ? (
              <span>{SHORT_LABEL[row.id]}: {row.page}</span>
            ) : (
              <>
                <span>{SHORT_LABEL[row.id]}</span>
                <span className="home-count">{row.capped ? `${row.count}+` : row.count}</span>
              </>
            )}
          </Link>
        ))}
        {failed.length > 0 && <button type="button" className="link" onClick={refetchAll}>Повторить</button>}
      </div>
    </div>
  );
}

function ShiftsLine() {
  const shifts = useTeamShifts(lastDay());
  const data = shifts.data;
  const now = data ? Date.parse(data.serverNow) : Date.now();
  const ongoing = data?.shifts
    .filter((shift) => shift.ongoing)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)) ?? [];
  const last = data?.shifts.find((shift) => !shift.ongoing);

  return (
    <div className="home-strip-row">
      <Link to="/team/shifts?page=all" className="home-strip-label">На смене</Link>
      <div className="home-strip-items">
        {!data && shifts.isError && (
          <span className="text-text-muted">
            Hub не ответил. <button type="button" className="link" onClick={() => void shifts.refetch()}>Повторить</button>
          </span>
        )}
        {!data && !shifts.isError && <span className="text-text-muted">Проверяем…</span>}
        {data && ongoing.length === 0 && (
          <span className="text-text-muted">
            {last
              ? `Никого. Последняя смена: ${last.username}, закончилась в ${formatTimeOfDay(last.endedAt)}`
              : "Никого. За сутки смен не было"}
          </span>
        )}
        {ongoing.map((shift) => {
          const pages = shift.pages.filter((page) => page.messages > 0).map((page) => page.pageLabel);
          const shown = pages.length > 0 ? pages : shift.pages.slice(0, 1).map((page) => page.pageLabel);
          const minutes = Math.max(0, Math.round((now - Date.parse(shift.startedAt)) / 60_000));
          return (
            <Link key={shift.userId} to={`/team/chatters/${shift.userId}`} className="home-strip-item">
              <span className="font-medium">{shift.username}</span>
              <span className="text-text-secondary">{shown.slice(0, 2).join(", ")}{shown.length > 2 ? ` +${shown.length - 2}` : ""}</span>
              <span className="text-text-muted">{formatDuration(minutes)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function HomeStrip() {
  const user = useAuthMe();
  const role = user.data?.user.role;
  if (!role) return null;
  return (
    <section className="home-strip card" aria-label="Что ждёт вас и кто на смене">
      <WaitingLine role={role} />
      <ShiftsLine />
    </section>
  );
}
