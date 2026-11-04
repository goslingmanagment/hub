import { useNavigate } from "react-router";
import { Link } from "react-router";
import { UserPlus } from "lucide-react";
import type { AdminUser } from "@agency_hub_core/contracts";
import { useAdminUsers } from "@/api/queries";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatMomentAgo } from "@/lib/format";
import { isPlainRowClick } from "@/lib/rowClick";
import { STAFF_STATUS } from "@/lib/statusWords";
import { usePeople } from "./PeopleLayout.js";
import { PLATFORM_LABEL, ROLE_LABEL, sortTeamByActivity, teamStatus } from "./teamView.js";

/**
 * Команда → Сотрудники: who is in the team, how to bring someone in. A row opens
 * the person's card; the disabled people stay findable, folded under the list.
 * The owner's only (hidden in the menu and refused by the route).
 */

const PAGE_CHIP_LIMIT = 5;
const WORKS = new Set(["chatter", "team_lead"]);

function PageChips({ pages }: { pages: AdminUser["assignedPages"] }) {
  if (pages.length === 0) return <span className="team-muted">—</span>;
  const visible = pages.length <= PAGE_CHIP_LIMIT ? pages : pages.slice(0, PAGE_CHIP_LIMIT - 1);
  const overflow = pages.slice(visible.length);
  return (
    <div className="team-chips">
      {visible.map((page) => (
        <span key={page.id} title={`${PLATFORM_LABEL[page.platform]}, ${page.modelName}`} className="badge">{page.label}</span>
      ))}
      {overflow.length > 0 && <span title={overflow.map((page) => page.label).join(", ")} className="badge">+{overflow.length}</span>}
    </div>
  );
}

export function PeoplePage() {
  const navigate = useNavigate();
  const { openInvite } = usePeople();
  const { data: users, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useAdminUsers();
  const invite = (
    <button type="button" onClick={openInvite} className="btn btn-primary">
      <UserPlus size={16} aria-hidden="true" /> Пригласить
    </button>
  );
  const header = (
    <PageHeader actions={invite} fresh={users ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined} />
  );

  if (!users) {
    return (
      <div className="team-screen">
        {header}
        {isLoading ? <TableSkeleton rows={6} columns={6} /> : <NoAnswerPanel retry={refetch} />}
      </div>
    );
  }

  const items = users.filter((user) => !user.deletedAt);
  const present = sortTeamByActivity(items.filter((user) => !user.disabledAt));
  const disabled = items
    .filter((user) => user.disabledAt)
    .sort((a, b) => (b.disabledAt ?? "").localeCompare(a.disabledAt ?? ""));
  const open = (event: React.MouseEvent<HTMLElement>, id: number) => {
    if (isPlainRowClick(event)) navigate(`/team/people/${id}`);
  };

  return (
    <div className="team-screen">
      {header}
      <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />
      <section className="card" aria-labelledby="people-present">
        <header className="card-header">
          <h2 id="people-present" className="card-title">В команде <span className="team-count">{formatCount(present.length)}</span></h2>
        </header>
        {present.length === 0 ? (
          <div className="empty">
            <p className="empty-title">В команде пока никого</p>
            <p className="empty-text">Пригласите первого человека: он получит ссылку и сам придумает пароль.</p>
            <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={openInvite}>Пригласить</button></div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table team-sticky-first">
              <thead>
                <tr>
                  <th scope="col">Логин</th>
                  <th scope="col">Роль</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Активность</th>
                  <th scope="col">Страницы</th>
                  <th scope="col"><span className="sr-only">Работа</span></th>
                </tr>
              </thead>
              <tbody>
                {present.map((user) => (
                  <tr key={user.id} className="team-row-link" onClick={(event) => open(event, user.id)}>
                    <td><Link to={`/team/people/${user.id}`} className="team-link font-medium">{user.username}</Link></td>
                    <td className="muted">{ROLE_LABEL[user.role]}</td>
                    <td className="status-col"><StatusBadge status={STAFF_STATUS[teamStatus(user)]} /></td>
                    <td className="muted whitespace-nowrap">{user.lastActiveAt ? formatMomentAgo(user.lastActiveAt) : "ещё не входил"}</td>
                    <td><PageChips pages={user.assignedPages} /></td>
                    <td className="text-right">{WORKS.has(user.role) && <Link to={`/team/chatters/${user.id}`} className="team-link">Работа</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {disabled.length > 0 && (
        <details className="help">
          <summary>Отключённые сотрудники ({disabled.length})</summary>
          <div className="team-fold-body">
            <p>Логины и история сохранены. Восстановить доступ можно в карточке сотрудника.</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Логин</th>
                    <th scope="col">Роль</th>
                    <th scope="col">Доступ отключён</th>
                  </tr>
                </thead>
                <tbody>
                  {disabled.map((user) => (
                    <tr key={user.id} className="team-row-link" onClick={(event) => open(event, user.id)}>
                      <td><Link to={`/team/people/${user.id}`} className="team-link">{user.username}</Link></td>
                      <td className="muted">{ROLE_LABEL[user.role]}</td>
                      <td className="muted whitespace-nowrap">{user.disabledAt ? formatMomentAgo(user.disabledAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
