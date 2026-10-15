import { useState } from "react";
import { UserPlus } from "lucide-react";
import type { AdminUser } from "@agency_hub_core/contracts";

import { useAdminUsers, useCreateAccountLink, useCreateInvite } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { ModalShell } from "@/components/shared/ModalShell";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { InviteModal } from "./InviteModal.js";
import { LinkRevealModal, type RevealedLink } from "./LinkRevealModal.js";
import { UserDetailModal } from "./UserDetailModal.js";
import {
  findTeamMember,
  formatRelativeRu,
  PLATFORM_LABEL,
  ROLE_LABEL,
  sortTeamByActivity,
  TEAM_STATUS_LABEL,
  teamStatus,
  type TeamStatus,
} from "./teamView.js";

/**
 * Decision 350 — the Team tab: who is in the team, how they are doing and how
 * to bring someone in or cut them off.
 *
 * It replaces the console that invented passwords for people and handed out
 * copy-pasted credentials. Nothing here talks about the machinery under a
 * sign-in: the owner deals in logins, links, devices and pages, which is
 * exactly what the person on the other end of Telegram deals in too.
 *
 * Both link-minting mutations live HERE rather than in the modals that trigger
 * them: their result carries the only copy of a fresh link, and TanStack drops
 * a per-call callback when the observer that issued it unmounts. The flip side
 * of holding them here is that the raw link would sit in the mutation cache
 * after the reveal dialog closed, so closing it resets both mutations.
 */

type ModalState =
  | null
  | { type: "invite" }
  | { type: "detail"; userId: number }
  | { type: "reveal"; link: RevealedLink; returnTo: number | null };

const STATUS_DOT_CLASS: Readonly<Record<TeamStatus, string>> = {
  invited: "status-dot-warn",
  active: "status-dot-ok",
  disabled: "",
};

export function TeamTab() {
  const { data: users, isLoading, isError, error, isFetching, refetch } = useAdminUsers();
  const [modal, setModal] = useState<ModalState>(null);

  const createInvite = useCreateInvite();
  const createLink = useCreateAccountLink();

  if (isLoading && !users) {
    return <div role="status" className="py-12 text-center text-sm text-text-secondary">Загружаем команду…</div>;
  }

  if (isError && !users) {
    return (
      <div role="alert">
        <StatusPanel
          title="Не удалось загрузить команду"
          description={error instanceof Error
            ? error.message
            : "Список участников недоступен. Попробуйте загрузить его снова."}
          tone="error"
          action={(
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">
              {isFetching ? "Обновляем…" : "Повторить"}
            </button>
          )}
        />
      </div>
    );
  }

  const items = (users ?? []).filter((user) => !user.deletedAt);
  const present = sortTeamByActivity(items.filter((user) => !user.disabledAt));
  const deactivated = items.filter((user) => user.disabledAt);

  function openDetail(userId: number) {
    setModal({ type: "detail", userId });
  }

  return (
    <>
      <div className="space-y-5">
        {isError && users && (
          <div className="flex flex-wrap items-center gap-2">
            <StaleDataNotice title="Показан последний загруженный список" error={error} className="flex-1" />
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">
              {isFetching ? "Обновляем…" : "Повторить"}
            </button>
          </div>
        )}

        <section className="card" aria-labelledby="team-present-title">
          <div className="card-header">
            <h3 id="team-present-title" className="card-title">
              В команде
              {present.length > 0 && <span className="ml-1.5 font-normal text-text-muted">{present.length}</span>}
            </h3>
            <button type="button" onClick={() => setModal({ type: "invite" })} className="btn btn-primary">
              <UserPlus size={16} aria-hidden /> Пригласить
            </button>
          </div>

          {present.length === 0 ? (
            <div className="empty">
              <p className="empty-title">В команде пока никого</p>
              <p className="empty-text">Пригласите первого человека: он получит ссылку и сам придумает пароль.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Логин</th>
                    <th>Роль</th>
                    <th>Статус</th>
                    <th>Активность</th>
                    <th>Страницы</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {present.map((user) => (
                    <tr key={user.id} onClick={() => openDetail(user.id)} className="cursor-pointer">
                      <td className="font-medium">
                        <span title={user.username} className="block max-w-[200px] truncate">
                          {user.username}
                        </span>
                      </td>
                      <td className="muted whitespace-nowrap">{ROLE_LABEL[user.role]}</td>
                      <td className="whitespace-nowrap">
                        <StatusCell user={user} />
                      </td>
                      <td className="muted whitespace-nowrap" title={user.lastActiveAt ?? undefined}>
                        {user.lastActiveAt ? formatRelativeRu(user.lastActiveAt) : "ещё не работал"}
                      </td>
                      <td>
                        <PageChips pages={user.assignedPages} />
                      </td>
                      <td className="text-right" onClick={(event) => event.stopPropagation()}>
                        <button type="button" onClick={() => openDetail(user.id)} className="btn btn-sm">
                          Открыть
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {deactivated.length > 0 && (
          <DeactivatedSection users={deactivated} onOpen={openDetail} />
        )}
      </div>

      {modal?.type === "invite" && (
        <InviteModal
          create={createInvite}
          onClose={() => setModal(null)}
          onCreated={(link) => setModal({ type: "reveal", link, returnTo: null })}
          onOpenExisting={openDetail}
        />
      )}

      {modal?.type === "detail" && (
        <TeamMemberDetail
          users={items}
          userId={modal.userId}
          createLink={createLink}
          onClose={() => setModal((current) => (
            current?.type === "detail" && current.userId === modal.userId ? null : current
          ))}
          onLinkCreated={(link) => setModal({ type: "reveal", link, returnTo: link.userId })}
        />
      )}

      {modal?.type === "reveal" && (
        <LinkRevealModal
          link={modal.link}
          onClose={() => {
            const returnTo = modal.returnTo;
            // Release the observed results. With gcTime: 0 the completed
            // issuance mutations are now collected without a retention delay.
            createInvite.reset();
            createLink.reset();
            setModal(returnTo !== null ? { type: "detail", userId: returnTo } : null);
          }}
        />
      )}
    </>
  );
}

/** Resolve an open card by immutable identity after every list refresh. */
export function TeamMemberDetail({ users, userId, createLink, onClose, onLinkCreated }: {
  users: readonly AdminUser[];
  userId: number;
  createLink: ReturnType<typeof useCreateAccountLink>;
  onClose: () => void;
  onLinkCreated: (link: RevealedLink) => void;
}) {
  const user = findTeamMember(users, userId);
  if (!user) {
    return (
      <ModalShell title="Участник больше недоступен" closeLabel="Закрыть" onClose={onClose}>
        <p className="text-sm text-text-secondary">
          Этот аккаунт удалён или больше не доступен. Закройте карточку и выберите участника в списке.
        </p>
      </ModalShell>
    );
  }
  return <UserDetailModal key={user.id} user={user} createLink={createLink} onClose={onClose} onLinkCreated={onLinkCreated} />;
}

function StatusCell({ user }: { user: AdminUser }) {
  const status = teamStatus(user);
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`status-dot ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
      <span className={status === "active" ? "text-text-primary" : "text-text-secondary"}>
        {TEAM_STATUS_LABEL[status]}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  PageChips — compact assignment chips; the platform is in the title */
/* ------------------------------------------------------------------ */

const PAGE_CHIP_LIMIT = 5;

function PageChips({ pages }: { pages: AdminUser["assignedPages"] }) {
  if (pages.length === 0) {
    return <span className="text-text-muted">{"—"}</span>;
  }

  const visible = pages.length <= PAGE_CHIP_LIMIT ? pages : pages.slice(0, PAGE_CHIP_LIMIT - 1);
  const overflow = pages.slice(visible.length);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((page) => (
        <span key={page.id} title={`${page.label} — ${PLATFORM_LABEL[page.platform]} / ${page.modelName}`} className="badge">
          {page.label}
        </span>
      ))}
      {overflow.length > 0 && (
        <span title={overflow.map((page) => page.label).join(", ")} className="badge">
          +{overflow.length}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deactivated (#126: tombstoned, never deleted)                      */
/* ------------------------------------------------------------------ */

/** Collapsed by default, but always in the page: the people stay findable
 *  and their cards one click away. */
function DeactivatedSection({
  users,
  onOpen,
}: {
  users: AdminUser[];
  onOpen: (userId: number) => void;
}) {
  return (
    <details className="help">
      <summary>Отключённые участники ({users.length})</summary>
      <div className="mt-3 space-y-3">
        <p>Логины и история сохранены. Восстановить доступ можно в карточке участника.</p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Логин</th>
                <th>Роль</th>
                <th>Доступ отключён</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="muted font-medium">{user.username}</td>
                  <td className="muted">{ROLE_LABEL[user.role]}</td>
                  <td className="muted whitespace-nowrap">
                    {user.disabledAt ? formatRelativeRu(user.disabledAt) : "—"}
                  </td>
                  <td className="text-right">
                    <button type="button" onClick={() => onOpen(user.id)} className="btn btn-sm">
                      Открыть
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
