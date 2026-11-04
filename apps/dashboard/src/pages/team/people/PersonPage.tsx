import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import type { AccountLinkItem, AdminUser, DeviceTokenItem } from "@agency_hub_core/contracts";

import {
  useAdminAssignPage,
  useAdminDeactivateUser,
  useAdminDeleteUser,
  useAdminPages,
  useAdminReactivateUser,
  useAdminUnassignPage,
  useAdminUsers,
  useAuthMe,
  useRevokeAllDevices,
  useRevokeDevice,
  useRevokeLink,
  useTerminateAccess,
  useUserDevices,
  useUserLinks,
  type useCreateAccountLink,
} from "@/api/queries";
import { useAdminAiChatterLimits } from "@/api/adminAiSpend";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatAiUsd, formatDateTime, formatMomentAgo } from "@/lib/format";
import { STAFF_STATUS } from "@/lib/statusWords";
import { PageAssignmentsEditor } from "./PageAssignmentsEditor.js";
import type { RevealedLink } from "./LinkRevealModal.js";
import { usePeople } from "./PeopleLayout.js";
import {
  deviceRevokedReasonLabel,
  findTeamMember,
  formatRelativeRu,
  LINK_KIND_LABEL,
  linkStateLabel,
  REVOCATION_LABEL,
  restoreTeamMemberMessage,
  ROLE_LABEL,
  splitDevices,
  TEAM_PAGE_LABELS,
  teamStatus,
} from "./teamView.js";

/**
 * One person's card, a page of its own: their pages, links, devices, the AI
 * limit for reading, and the ways to end their access. The person is the path's
 * and nothing else. The five ways to cut access stay five: each is its own
 * request, named for how far it reaches (§4.4, Р6); the everyday one,
 * «Отключить доступ», stands first, the wider ones folded under it.
 *
 * The link-creating mutation is the people's layout's and comes in: it carries
 * the only copy of a fresh link in its result.
 */

type Confirmation = "revokeAllDevices" | "terminateAccess" | "deactivate" | "reactivate" | "deleteAccount";

const LINK_RESETTABLE_ROLES: ReadonlySet<string> = new Set(["chatter", "team_lead"]);
const WORKS: ReadonlySet<string> = new Set(["chatter", "team_lead"]);

/**
 * The kernel refuses to terminate an owner's access or to deactivate an owner
 * (`adminTerminateAllAccess` and `deactivateUser` both answer 400): the owner
 * must not be able to lock themselves out of the only console. The buttons are
 * not rendered for an owner at all.
 */
function ownerIsProtected(user: AdminUser): boolean {
  return user.role === "owner";
}

function Lines() {
  return (
    <div className="ac-lines" aria-hidden="true">
      <Skeleton width="60%" />
      <Skeleton width="45%" />
    </div>
  );
}

function Block({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">{title}</h2>
        {aside}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** The everyday cut-off first; the wider revocations and the deletion folded under it. */
function EndAccess({ user, onAsk, deleteDisabled, canDelete }: {
  user: AdminUser;
  onAsk: (kind: Confirmation) => void;
  deleteDisabled: boolean;
  canDelete: boolean;
}) {
  const disabled = Boolean(user.disabledAt);
  if (ownerIsProtected(user)) {
    return (
      <Block title="Отключить доступ">
        <p className="team-muted">
          Владельца нельзя деактивировать и нельзя завершить все его входы — иначе консоль осталась бы без хозяина. Пароль владелец меняет сам.
        </p>
      </Block>
    );
  }
  const rows = [
    !disabled && {
      key: "revokeAll",
      text: "Расширение и приложение на всех устройствах попросят войти заново. Консоль и пароль не затрагиваются.",
      label: REVOCATION_LABEL.allDevices,
      kind: "revokeAllDevices" as const,
      danger: false,
      off: false,
    },
    !disabled && {
      key: "terminate",
      text: "Завершатся входы на всех устройствах, в консоли и все ссылки. Пароль продолжит работать.",
      label: REVOCATION_LABEL.allAccess,
      kind: "terminateAccess" as const,
      danger: false,
      off: false,
    },
    canDelete && {
      key: "delete",
      text: "Необратимо, логин освободится. История работы сохранится за прежним сотрудником.",
      label: "Удалить аккаунт",
      kind: "deleteAccount" as const,
      danger: true,
      off: deleteDisabled,
    },
  ].filter((row) => row !== false);
  return (
    <Block title="Отключить доступ">
      {!disabled && (
        <div className="person-action">
          <p>Все входы и ссылки перестанут работать. Логин, история, роль и страницы сохранятся, доступ можно будет восстановить.</p>
          <button type="button" onClick={() => onAsk("deactivate")} className="btn btn-danger-outline">Отключить доступ</button>
        </div>
      )}
      {disabled && <p className="team-muted">Доступ уже отключён. Восстановить его можно в плашке вверху.</p>}
      {rows.length > 0 && (
        <details className="help person-more">
          <summary>Другие способы завершить доступ</summary>
          <ul className="team-list team-list-flush">
            {rows.map((row) => (
              <li key={row.key} className="person-action">
                <p>{row.text}</p>
                <button
                  type="button"
                  disabled={row.off}
                  onClick={() => onAsk(row.kind)}
                  className={`btn btn-sm ${row.danger ? "btn-danger-outline" : ""}`}
                >
                  {row.label}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Block>
  );
}

function DevicesSection({ userId }: { userId: number }) {
  const { data: devices, isLoading, isError } = useUserDevices(userId);
  const revokeDevice = useRevokeDevice(userId);
  const { active, history } = splitDevices(devices ?? []);

  function handleRevoke(device: DeviceTokenItem) {
    revokeDevice.mutate(device.id, {
      onSuccess: () => toast.success(`Вход на «${device.label}» завершён`),
      onError: () => toast.error("Не удалось завершить вход: Hub вернул ошибку."),
    });
  }

  return (
    <Block title="Устройства">
      {isError && <Notice tone="warning" className="mb-3">{devices ? "Список устройств не обновился" : "Список устройств недоступен"}</Notice>}
      {isLoading && !devices && <Lines />}
      {devices && active.length === 0 && <p className="team-muted">Сейчас ни одного входа.</p>}
      {active.length > 0 && (
        <ul className="team-list team-list-flush">
          {active.map((device) => (
            <li key={device.id} className="team-list-row">
              <div className="min-w-0">
                <p>{device.label}</p>
                <p className="team-muted">
                  {device.lastUsedAt ? `вход использован ${formatRelativeRu(device.lastUsedAt)}` : "ещё ни разу не использовался"}
                  {device.lastClientVersion && ` · версия ${device.lastClientVersion}`}
                </p>
              </div>
              <button type="button" disabled={revokeDevice.isPending} onClick={() => handleRevoke(device)} className="btn btn-sm">
                {REVOCATION_LABEL.device}
              </button>
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <details className="help mt-3">
          <summary>Завершённые входы ({history.length})</summary>
          <ul className="team-list team-list-flush">
            {history.map((device) => (
              <li key={device.id} className="team-list-row team-muted">
                <span>{device.label}</span>
                <span>
                  {deviceRevokedReasonLabel(device.revokedReason) ?? (device.revokedAt ? "вход завершён" : "срок истёк")}
                  {" · "}
                  {formatDateTime(device.revokedAt ?? device.expiresAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Block>
  );
}

function LinksSection({ user, createLink, onLinkCreated }: {
  user: AdminUser;
  createLink: ReturnType<typeof useCreateAccountLink>;
  onLinkCreated: (link: RevealedLink) => void;
}) {
  const { data: links, isLoading, isError } = useUserLinks(user.id);
  const revokeLink = useRevokeLink(user.id);
  const invited = teamStatus(user) === "invited";
  const canReset = LINK_RESETTABLE_ROLES.has(user.role);
  const disabled = Boolean(user.disabledAt);

  function handleCreate(kind: "invite" | "password_reset") {
    if (disabled) return;
    createLink.mutate({ userId: user.id, kind }, {
      onSuccess: (link) => {
        onLinkCreated({
          userId: user.id,
          username: user.username,
          kind: link.kind,
          secret: link.token,
          expiresAt: link.expiresAt,
        });
      },
      onError: () => toast.error("Не удалось создать ссылку: Hub вернул ошибку."),
    });
  }

  function handleRevoke(link: AccountLinkItem) {
    revokeLink.mutate(link.id, {
      onSuccess: () => toast.success("Ссылка отозвана"),
      onError: () => toast.error("Не удалось отозвать ссылку: Hub вернул ошибку."),
    });
  }

  const button = invited
    ? { kind: "invite" as const, label: "Отправить приглашение заново" }
    : canReset ? { kind: "password_reset" as const, label: "Сбросить пароль ссылкой" } : null;

  return (
    <Block title="Ссылки">
      {isError && <Notice tone="warning" className="mb-3">{links ? "История ссылок не обновилась" : "История ссылок недоступна"}</Notice>}
      {isLoading && !links && <Lines />}
      {links && links.length === 0 && <p className="team-muted">Ссылок ещё не было.</p>}
      {(links ?? []).length > 0 && (
        <ul className="team-list team-list-flush">
          {(links ?? []).map((link) => (
            <li key={link.id} className="team-list-row">
              <div className="min-w-0">
                <p>{LINK_KIND_LABEL[link.kind]}</p>
                <p className="team-muted">{linkStateLabel(link, formatDateTime)} · создана {formatDateTime(link.createdAt)}</p>
              </div>
              {link.state === "active" && !disabled && (
                <button type="button" disabled={revokeLink.isPending} onClick={() => handleRevoke(link)} className="btn btn-sm">
                  Отозвать ссылку
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {disabled ? (
        <p className="field-hint">Новые ссылки можно создать после восстановления доступа.</p>
      ) : button && (
        <div className="person-action person-action-top">
          <p>Новая ссылка отменяет прежнюю. Когда человек задаст пароль, все прежние входы завершатся.</p>
          <button type="button" disabled={createLink.isPending} onClick={() => handleCreate(button.kind)} className="btn btn-sm">
            {createLink.isPending ? "Создаём…" : button.label}
          </button>
        </div>
      )}
    </Block>
  );
}

function SavedPages({ user }: { user: AdminUser }) {
  return (
    <Block title="Сохранённые страницы">
      <p className="team-muted">После восстановления доступа сотрудник снова сможет работать с этими страницами.</p>
      {user.assignedPages.length === 0
        ? <p className="team-muted mt-2">Страниц пока нет.</p>
        : <div className="team-chips mt-3">{user.assignedPages.map((page) => <span key={page.id} className="badge">{page.label} · {page.modelName}</span>)}</div>}
    </Block>
  );
}

function PagesSection({ user }: { user: AdminUser }) {
  const { data: allPages, isLoading, isError, refetch } = useAdminPages();
  const assignPage = useAdminAssignPage(user.id);
  const unassignPage = useAdminUnassignPage(user.id);
  const [selectedLabel, setSelectedLabel] = useState("");

  const assignedLabels = new Set(user.assignedPages.map((page) => page.label));
  const availablePages = (allPages ?? []).filter((page) => !assignedLabels.has(page.label));

  async function handleAssign() {
    if (!selectedLabel || isError || !availablePages.some((page) => page.label === selectedLabel)
      || assignPage.isPending || unassignPage.isPending) {
      return;
    }
    try {
      await assignPage.mutateAsync({ pageLabel: selectedLabel });
      toast.success(`Страница ${selectedLabel} назначена ${user.username}`);
      setSelectedLabel("");
    } catch {
      toast.error("Не удалось назначить страницу: Hub вернул ошибку.");
    }
  }

  async function handleUnassign(pageLabel: string) {
    try {
      await unassignPage.mutateAsync(pageLabel);
      toast.success(`Страница ${pageLabel} снята с ${user.username}`);
    } catch {
      toast.error("Не удалось снять страницу: Hub вернул ошибку.");
    }
  }

  return (
    <Block title="Страницы">
      <PageAssignmentsEditor
        assignedPages={user.assignedPages}
        availablePages={availablePages}
        selectedLabel={selectedLabel}
        onSelectedLabelChange={setSelectedLabel}
        onAssign={handleAssign}
        onUnassign={handleUnassign}
        assignPending={assignPage.isPending}
        unassignPending={unassignPage.isPending}
        pagesLoading={isLoading && !allPages}
        pagesError={isError}
        onRetryPages={() => void refetch()}
        labels={TEAM_PAGE_LABELS}
      />
    </Block>
  );
}

/** The person's AI limit for today, read only: its home is Настройки → ИИ → Лимиты. */
function AiLimit({ userId }: { userId: number }) {
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const limits = useAdminAiChatterLimits(today, true);
  const row = limits.data?.chatters.find((chatter) => chatter.userId === userId);
  return (
    <Block title="Лимит ИИ на день">
      {limits.isLoading && !limits.data ? <Lines /> : !limits.data ? (
        <div className="ac-retry">
          <span>Hub не ответил</span>
          <button type="button" className="btn btn-sm" onClick={() => void limits.refetch()}>Повторить</button>
        </div>
      ) : (
        <p className="person-limit">
          {!row ? "—" : row.dailyLimitMicroUsd === null
            ? <>Личного лимита нет, сегодня потрачено {formatAiUsd(row.spentMicroUsd)}</>
            : <><b>{formatAiUsd(row.dailyLimitMicroUsd)}</b>, сегодня потрачено {formatAiUsd(row.spentMicroUsd)}</>}
        </p>
      )}
      <p className="mt-3"><Link to="/settings/ai/limits" className="link">Изменить в Настройках</Link></p>
    </Block>
  );
}

/** The card's body: everything about one person. Exported for the lifecycle test. */
export function PersonCard({ user, createLink, onLinkCreated, onDeleted }: {
  user: AdminUser;
  createLink: ReturnType<typeof useCreateAccountLink>;
  onLinkCreated: (link: RevealedLink) => void;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const status = teamStatus(user);
  const { data: auth } = useAuthMe();
  const canDelete = Boolean(auth?.user) && !ownerIsProtected(user) && auth?.user.id !== user.id;
  const disabled = status === "disabled";

  return (
    <div className="team-screen">
      {disabled && user.disabledAt && (
        <Notice tone="off" action={<button type="button" onClick={() => setConfirmation("reactivate")} className="btn btn-primary btn-sm">Восстановить доступ</button>}>
          Доступ отключён {formatDateTime(user.disabledAt)}. Логин и история сохранены — восстановите доступ, если возвращается тот же человек.
        </Notice>
      )}
      {status === "invited" && (
        <Notice>Человек ещё не открыл приглашение и не придумал пароль. Пока этого не случилось, войти он не может.</Notice>
      )}

      <div className="person-grid">
        {disabled ? <SavedPages user={user} /> : <PagesSection user={user} />}
        <AiLimit userId={user.id} />
      </div>
      <LinksSection user={user} createLink={createLink} onLinkCreated={onLinkCreated} />
      <DevicesSection userId={user.id} />
      <EndAccess user={user} onAsk={setConfirmation} deleteDisabled={createLink.isPending} canDelete={canDelete} />

      {confirmation && (
        <ConfirmationDialog kind={confirmation} user={user} onClose={() => setConfirmation(null)} onDeleted={onDeleted} />
      )}
    </div>
  );
}

const FAILURE: Readonly<Record<Confirmation, string>> = {
  revokeAllDevices: "Не удалось отозвать устройства: Hub вернул ошибку.",
  terminateAccess: "Не удалось завершить входы: Hub вернул ошибку.",
  deactivate: "Не удалось отключить доступ: Hub вернул ошибку.",
  reactivate: "Не удалось восстановить доступ: Hub вернул ошибку.",
  deleteAccount: "Не удалось подтвердить удаление. Проверьте состояние сотрудника в списке.",
};

export function ConfirmationDialog({
  kind,
  user,
  onClose,
  onDeleted,
}: {
  kind: Confirmation;
  user: AdminUser;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const revokeAllDevices = useRevokeAllDevices(user.id);
  const terminateAccess = useTerminateAccess(user.id);
  const deactivate = useAdminDeactivateUser(user.id);
  const reactivate = useAdminReactivateUser(user.id);
  const deleteAccount = useAdminDeleteUser(user.id);

  const dialogs = {
    revokeAllDevices: {
      title: `${REVOCATION_LABEL.allDevices} — ${user.username}?`,
      message: "Расширение и приложение на всех устройствах перестанут работать и попросят войти заново. "
        + "Вход в консоль и пароль не затрагиваются.",
      confirmLabel: "Отозвать",
      isPending: revokeAllDevices.isPending,
      run: async () => {
        const result = await revokeAllDevices.mutateAsync();
        toast.success(result.revokedCount > 0
          ? `Устройства отозваны: ${result.revokedCount}`
          : "Отзывать было нечего");
      },
    },
    terminateAccess: {
      title: `${REVOCATION_LABEL.allAccess} — ${user.username}?`,
      message: "Завершатся входы на всех устройствах, вход в консоль и все действующие ссылки. "
        + "Человек останется в команде и сможет войти заново со своим паролем.",
      confirmLabel: "Завершить",
      isPending: terminateAccess.isPending,
      run: async () => {
        await terminateAccess.mutateAsync();
        toast.success(`Все входы ${user.username} завершены`);
      },
    },
    deactivate: {
      title: `Отключить доступ ${user.username}?`,
      message: "Все входы и ссылки перестанут работать, сотрудник перейдёт в «Отключённые сотрудники». "
        + "Логин (он останется занят), история, роль и страницы сохранятся — доступ можно будет восстановить.",
      confirmLabel: "Отключить доступ",
      isPending: deactivate.isPending,
      run: async () => {
        await deactivate.mutateAsync();
        toast.success(`Доступ ${user.username} отключён`);
      },
    },
    deleteAccount: {
      title: `Удалить аккаунт ${user.username}?`,
      message: "Все его входы, ссылки и доступ к страницам будут отозваны, аккаунт удалится без возможности восстановления. "
        + "Логин освободится — новый сотрудник с этим логином получит отдельный аккаунт, "
        + "а история работы и финансовые записи останутся за прежним сотрудником.",
      confirmLabel: "Удалить навсегда",
      isPending: deleteAccount.isPending,
      run: async () => {
        await deleteAccount.mutateAsync();
        toast.success(`Аккаунт ${user.username} удалён`);
        onDeleted();
      },
    },
    reactivate: {
      title: `Восстановить доступ ${user.username}?`,
      message: restoreTeamMemberMessage(user),
      confirmLabel: "Восстановить доступ",
      isPending: reactivate.isPending,
      run: async () => {
        await reactivate.mutateAsync();
        toast.success(`${user.username} снова в команде`);
      },
    },
  } as const;

  const dialog = dialogs[kind];

  async function handleConfirm() {
    if (dialog.isPending) return;
    try {
      await dialog.run();
      onClose();
    } catch {
      toast.error(FAILURE[kind]);
    }
  }

  return (
    <ConfirmModal
      title={dialog.title}
      message={dialog.message}
      confirmLabel={dialog.confirmLabel}
      cancelLabel="Отмена"
      closeLabel="Закрыть"
      tone={kind === "reactivate" ? "primary" : "danger"}
      isPending={dialog.isPending}
      onConfirm={handleConfirm}
      onClose={() => { if (!dialog.isPending) onClose(); }}
    />
  );
}

export function PersonPage() {
  const { userId: raw } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { createLink, onLinkCreated } = usePeople();
  const users = useAdminUsers();
  const userId = Number(raw);
  const user = users.data && Number.isInteger(userId) ? findTeamMember(users.data, userId) : null;

  if (!users.data) {
    return (
      <div className="team-screen">
        {users.isLoading ? <section className="card card-body"><Lines /></section> : <NoAnswerPanel retry={users.refetch} />}
      </div>
    );
  }
  if (!user) {
    return (
      <div className="team-screen">
        <PageHeader title="Сотрудник больше недоступен" />
        <StatusPanel
          title="Сотрудник больше недоступен"
          description="Этот аккаунт удалён или больше не доступен."
          action={<Link to="/team/people" className="btn btn-sm">К списку сотрудников</Link>}
        />
      </div>
    );
  }

  const status = STAFF_STATUS[teamStatus(user)]!;
  const line = [
    ROLE_LABEL[user.role],
    status.word,
    user.lastActiveAt ? `последняя активность ${formatMomentAgo(user.lastActiveAt)}` : "ещё не входил",
  ].join(" · ");
  return (
    <>
      <PageHeader
        title={user.username}
        description={line}
        actions={WORKS.has(user.role) ? <Link to={`/team/chatters/${user.id}`} className="btn">Работа и смены</Link> : undefined}
        fresh={{ at: users.dataUpdatedAt, onRefresh: () => void users.refetch(), refreshing: users.isFetching }}
      />
      <PersonCard
        key={user.id}
        user={user}
        createLink={createLink}
        onLinkCreated={onLinkCreated}
        onDeleted={() => navigate("/team/people", { replace: true })}
      />
    </>
  );
}
