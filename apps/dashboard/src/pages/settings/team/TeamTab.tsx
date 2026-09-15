import { useState } from "react";
import type { AdminUser } from "@agency_hub_core/contracts";

import { useAdminUsers, useCreateAccountLink, useCreateInvite } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { InviteModal } from "./InviteModal.js";
import { LinkRevealModal, type RevealedLink } from "./LinkRevealModal.js";
import { UserDetailModal } from "./UserDetailModal.js";
import {
  findTeamMember,
  formatRelativeRu,
  PLATFORM_DOT_CLASS,
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
  | { type: "detail"; username: string }
  | { type: "reveal"; link: RevealedLink; returnTo: string | null };

const STATUS_DOT_CLASS: Readonly<Record<TeamStatus, string>> = {
  invited: "bg-warning",
  active: "bg-green",
  disabled: "bg-text-muted/40",
};

const thClass =
  "whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted";
const tdClass = "px-4 py-3 text-sm";

export function TeamTab() {
  const { data: users, isLoading, isError, error, isFetching, refetch } = useAdminUsers();
  const [modal, setModal] = useState<ModalState>(null);

  const detailUsername = modal?.type === "detail" ? modal.username : "";
  const createInvite = useCreateInvite();
  const createLink = useCreateAccountLink(detailUsername);

  if (isLoading && !users) {
    return <div className="py-12 text-center text-sm text-text-muted">Загружаем команду…</div>;
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
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
            >
              {isFetching ? "Обновляем…" : "Повторить"}
            </button>
          )}
        />
      </div>
    );
  }

  const items = users ?? [];
  const present = sortTeamByActivity(items.filter((user) => !user.disabledAt));
  const deactivated = items.filter((user) => user.disabledAt);
  const detailUser = modal?.type === "detail" ? findTeamMember(items, modal.username) : null;

  function openDetail(username: string) {
    setModal({ type: "detail", username });
  }

  return (
    <>
      {isError && users && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StaleDataNotice title="Показан последний загруженный список" error={error} className="flex-1" />
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            {isFetching ? "Обновляем…" : "Повторить"}
          </button>
        </div>
      )}

      <div className="space-y-8">
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-text-primary">
              В команде
              {present.length > 0 && (
                <span className="ml-1.5 font-normal text-text-muted">{present.length}</span>
              )}
            </h2>
            <div className="flex items-center gap-4">
              <span className="hidden items-center gap-3 text-[11px] text-text-muted sm:inline-flex">
                <span className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${PLATFORM_DOT_CLASS.fansly}`} />
                  {PLATFORM_LABEL.fansly}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${PLATFORM_DOT_CLASS.onlyfans}`} />
                  {PLATFORM_LABEL.onlyfans}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setModal({ type: "invite" })}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
              >
                Пригласить
              </button>
            </div>
          </div>

          {present.length === 0 ? (
            <p className="text-sm text-text-muted">В команде пока никого. Пригласите первого человека.</p>
          ) : (
            <section className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-hover-alt">
                    {["Логин", "Роль", "Статус", "Последняя активность", "Страницы", ""].map((column, index) => (
                      <th key={column || `actions-${index}`} className={thClass}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {present.map((user) => (
                    <tr
                      key={user.id}
                      onClick={() => openDetail(user.username)}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-hover-alt"
                    >
                      <td className={`${tdClass} font-medium text-text-primary`}>
                        <span title={user.username} className="block max-w-[200px] truncate">
                          {user.username}
                        </span>
                      </td>
                      <td className={`${tdClass} whitespace-nowrap text-text-secondary`}>
                        {ROLE_LABEL[user.role]}
                      </td>
                      <td className={`${tdClass} whitespace-nowrap`}>
                        <StatusCell user={user} />
                      </td>
                      <td
                        className={`${tdClass} whitespace-nowrap text-text-muted`}
                        title={user.lastActiveAt ?? undefined}
                      >
                        {user.lastActiveAt ? formatRelativeRu(user.lastActiveAt) : "ещё не работал"}
                      </td>
                      <td className={tdClass}>
                        <PageChips pages={user.assignedPages} />
                      </td>
                      <td className={`${tdClass} text-right`} onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => openDetail(user.username)}
                          className="whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                        >
                          Открыть
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        {deactivated.length > 0 && (
          <DeactivatedSection users={deactivated} onOpen={openDetail} />
        )}
      </div>

      {modal?.type === "invite" && (
        <InviteModal
          create={createInvite}
          onClose={() => setModal(null)}
          onCreated={(link) => setModal({ type: "reveal", link, returnTo: null })}
        />
      )}

      {modal?.type === "detail" && detailUser && (
        <UserDetailModal
          user={detailUser}
          createLink={createLink}
          onClose={() => setModal(null)}
          onLinkCreated={(link) => setModal({ type: "reveal", link, returnTo: detailUser.username })}
        />
      )}

      {modal?.type === "reveal" && (
        <LinkRevealModal
          link={modal.link}
          onClose={() => {
            const returnTo = modal.returnTo;
            // The link is gone from this screen; drop it from memory too,
            // rather than leaving it in the mutation cache until gc.
            createInvite.reset();
            createLink.reset();
            setModal(returnTo ? { type: "detail", username: returnTo } : null);
          }}
        />
      )}
    </>
  );
}

function StatusCell({ user }: { user: AdminUser }) {
  const status = teamStatus(user);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT_CLASS[status]}`} />
      <span className={status === "active" ? "text-text-secondary" : "text-text-muted"}>
        {TEAM_STATUS_LABEL[status]}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  PageChips — compact assignment chips; platform reads as a dot      */
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
        <span
          key={page.id}
          title={`${page.label} — ${PLATFORM_LABEL[page.platform]} / ${page.modelName}`}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-hover-alt px-2 py-0.5 text-xs text-text-secondary"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PLATFORM_DOT_CLASS[page.platform]}`} />
          {page.label}
        </span>
      ))}
      {overflow.length > 0 && (
        <span
          title={overflow.map((page) => page.label).join(", ")}
          className="inline-flex items-center rounded-full border border-border bg-hover-alt px-2 py-0.5 text-xs text-text-muted"
        >
          +{overflow.length}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deactivated (#126: tombstoned, never deleted)                      */
/* ------------------------------------------------------------------ */

function DeactivatedSection({
  users,
  onOpen,
}: {
  users: AdminUser[];
  onOpen: (username: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="mb-3 flex items-center gap-1.5 text-sm font-bold text-text-muted transition-colors hover:text-text-primary"
      >
        <span className={`inline-block text-xs transition-transform ${open ? "rotate-90" : ""}`}>{"▸"}</span>
        Деактивированные ({users.length})
      </button>

      {open && (
        <section className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-hover-alt">
                {["Логин", "Роль", "Деактивирован", ""].map((column, index) => (
                  <th key={column || `actions-${index}`} className={thClass}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-border">
                  <td className={`${tdClass} font-medium text-text-muted`}>{user.username}</td>
                  <td className={`${tdClass} text-text-muted`}>{ROLE_LABEL[user.role]}</td>
                  <td className={`${tdClass} text-text-muted`}>
                    {user.disabledAt ? formatRelativeRu(user.disabledAt) : "—"}
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <button
                      type="button"
                      onClick={() => onOpen(user.username)}
                      className="whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                    >
                      Открыть
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
