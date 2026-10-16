import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import type { AccountLinkItem, AdminUser, DeviceTokenItem } from "@agency_hub_core/contracts";

import {
  useAdminAssignPage,
  useAdminDeactivateUser,
  useAdminDeleteUser,
  useAuthMe,
  useAdminPages,
  useAdminReactivateUser,
  useAdminUnassignPage,
  useRevokeAllDevices,
  useRevokeDevice,
  useRevokeLink,
  useTerminateAccess,
  useUserDevices,
  useUserLinks,
  type useCreateAccountLink,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { ModalShell } from "@/components/shared/ModalShell";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime } from "@/lib/format";
import { PageAssignmentsEditor } from "../PageAssignmentsEditor.js";
import type { RevealedLink } from "./LinkRevealModal.js";
import {
  deviceRevokedReasonLabel,
  formatRelativeRu,
  LINK_KIND_LABEL,
  linkStateLabel,
  REVOCATION_LABEL,
  restoreTeamMemberMessage,
  ROLE_LABEL,
  splitDevices,
  TEAM_PAGE_LABELS,
  TEAM_STATUS_LABEL,
  teamStatus,
  type TeamStatus,
} from "./teamView.js";

/**
 * Decision 350 — one person's card: their devices, their links, their pages.
 *
 * The three revocations are named for what they actually do (§4.4, Р6). The
 * old console offered a single "revoke" that left dashboard sessions and keys
 * alive while calling itself "signed out everywhere"; here each button says
 * exactly how far it reaches, so the owner firing someone can pick the one
 * that matches the situation. The everyday cut-off — «Отключить доступ» — sits
 * in the card's footer; the wider revocations and the deletion are grouped
 * at the bottom, apart from the everyday sections.
 *
 * The link-creating mutation is owned by the TAB and passed in: it carries the
 * only copy of a fresh link in its result, and a mutation owned by a modal
 * loses that handoff if the modal closes mid-flight.
 */

type Confirmation = "revokeAllDevices" | "terminateAccess" | "deactivate" | "reactivate" | "deleteAccount";

const LINK_RESETTABLE_ROLES: ReadonlySet<string> = new Set(["chatter", "team_lead"]);

/**
 * The kernel refuses to terminate an owner's access or to deactivate an owner
 * (`adminTerminateAllAccess` and `deactivateUser` both answer 400): the owner
 * must not be able to lock themselves out of the only console. Offering the
 * buttons anyway would put an English server error in front of a Russian
 * screen, so they are not rendered for an owner at all — the same treatment
 * the password link already gets through LINK_RESETTABLE_ROLES.
 */
function ownerIsProtected(user: AdminUser): boolean {
  return user.role === "owner";
}

const STATUS_BADGE: Readonly<Record<TeamStatus, string>> = {
  invited: "badge badge-warning",
  active: "badge badge-success",
  disabled: "badge",
};

export function UserDetailModal({
  user,
  createLink,
  onClose,
  onLinkCreated,
}: {
  user: AdminUser;
  createLink: ReturnType<typeof useCreateAccountLink>;
  onClose: () => void;
  onLinkCreated: (link: RevealedLink) => void;
}) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const status = teamStatus(user);
  const { data: auth } = useAuthMe();
  const canDelete = Boolean(auth?.user) && !ownerIsProtected(user) && auth?.user.id !== user.id;
  const disabled = status === "disabled";

  return (
    <>
      <ModalShell
        title={user.username}
        closeLabel="Закрыть"
        onClose={() => {
          // While a confirmation is up, Escape belongs to the confirmation.
          if (!confirmation) onClose();
        }}
      >
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge">{ROLE_LABEL[user.role]}</span>
            <span className={STATUS_BADGE[status]}>{TEAM_STATUS_LABEL[status]}</span>
            {user.lastActiveAt && (
              <span className="text-xs text-text-secondary">
                последняя активность {formatRelativeRu(user.lastActiveAt)}
              </span>
            )}
          </div>

          {disabled && user.disabledAt && (
            <div className="notice flex-wrap items-center">
              <p className="min-w-0 flex-1">
                Доступ отключён {formatDateTime(user.disabledAt)}. Логин и история сохранены — восстановите
                доступ, если возвращается тот же человек.
              </p>
              <button type="button" onClick={() => setConfirmation("reactivate")} className="btn btn-primary btn-sm">
                Восстановить доступ
              </button>
            </div>
          )}

          {status === "invited" && (
            <p className="notice">
              Человек ещё не открыл приглашение и не придумал пароль. Пока этого не
              случилось, войти он не может.
            </p>
          )}

          {disabled ? <SavedPagesSection user={user} /> : <PagesSection user={user} />}

          <LinksSection
            user={user}
            createLink={createLink}
            onLinkCreated={onLinkCreated}
          />

          <DevicesSection userId={user.id} />

          <DangerZone
            onRevokeAll={disabled ? null : () => setConfirmation("revokeAllDevices")}
            onTerminate={disabled || ownerIsProtected(user) ? null : () => setConfirmation("terminateAccess")}
            onDelete={canDelete ? () => setConfirmation("deleteAccount") : null}
            deleteDisabled={createLink.isPending}
          />

          {ownerIsProtected(user) && (
            <p className="text-xs text-text-secondary">
              Владельца нельзя деактивировать и нельзя завершить все его входы —
              иначе консоль осталась бы без хозяина. Пароль владелец меняет сам.
            </p>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-border-light pt-4">
          {!ownerIsProtected(user) && !disabled ? (
            <button type="button" onClick={() => setConfirmation("deactivate")} className="btn text-danger">
              Отключить доступ
            </button>
          ) : <span />}
          <button type="button" onClick={onClose} className="btn">
            Закрыть
          </button>
        </div>
      </ModalShell>

      {confirmation && (
        <ConfirmationDialog
          kind={confirmation}
          user={user}
          onClose={() => setConfirmation(null)}
          onDeleted={onClose}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  The wider revocations and the deletion, apart from everyday work   */
/* ------------------------------------------------------------------ */

function DangerZone({
  onRevokeAll,
  onTerminate,
  onDelete,
  deleteDisabled,
}: {
  onRevokeAll: (() => void) | null;
  /** null for an owner: the kernel refuses to terminate their access. */
  onTerminate: (() => void) | null;
  onDelete: (() => void) | null;
  deleteDisabled: boolean;
}) {
  const rows = [
    onRevokeAll && {
      key: "revokeAll",
      text: "Расширение и приложение на всех устройствах попросят войти заново. Консоль и пароль не затрагиваются.",
      label: REVOCATION_LABEL.allDevices,
      onClick: onRevokeAll,
      danger: false,
      disabled: false,
    },
    onTerminate && {
      key: "terminate",
      text: "Завершатся входы на всех устройствах, в консоли и все ссылки. Пароль продолжит работать.",
      label: REVOCATION_LABEL.allAccess,
      onClick: onTerminate,
      danger: false,
      disabled: false,
    },
    onDelete && {
      key: "delete",
      text: "Необратимо, логин освободится. История работы сохранится за прежним участником.",
      label: "Удалить аккаунт",
      onClick: onDelete,
      danger: true,
      disabled: deleteDisabled,
    },
  ].filter((row) => row !== null);
  if (rows.length === 0) return null;
  // Collapsed: these are rare and wide; the everyday cut-off is the footer's
  // «Отключить доступ». The rows stay in the page, so nothing is out of reach.
  return (
    <details className="help rounded-xl border border-border">
      <summary className="flex flex-wrap px-4 py-3 text-text-primary">
        Опасная зона
        <span className="font-normal text-text-secondary">
          {rows.map((row) => row.label.toLowerCase()).join(", ")}
        </span>
      </summary>
      <ul className="divide-y divide-border-light border-t border-border-light">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <p className="min-w-[14rem] flex-1 text-sm text-text-secondary">{row.text}</p>
            <button
              type="button"
              disabled={row.disabled}
              onClick={row.onClick}
              className={`btn btn-sm ${row.danger ? "text-danger" : ""}`}
            >
              {row.label}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/*  Devices                                                            */
/* ------------------------------------------------------------------ */

function DevicesSection({ userId }: { userId: number }) {
  const { data: devices, isLoading, isError, error } = useUserDevices(userId);
  const revokeDevice = useRevokeDevice(userId);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { active, history } = splitDevices(devices ?? []);

  function handleRevoke(device: DeviceTokenItem) {
    revokeDevice.mutate(device.id, {
      onSuccess: () => toast.success(`Вход на «${device.label}» завершён`),
      onError: (mutationError) => {
        toast.error(mutationError instanceof Error ? mutationError.message : "Не удалось завершить вход");
      },
    });
  }

  return (
    <div>
      <h3 className="card-title mb-2">Устройства</h3>
      {isError && (
        <StaleDataNotice
          title={devices ? "Список устройств не обновился" : "Список устройств недоступен"}
          error={error}
          className="mb-2"
        />
      )}
      {isLoading && !devices && <p className="text-sm text-text-secondary">Загружаем…</p>}
      {devices && active.length === 0 && (
        <p className="text-sm text-text-secondary">Сейчас ни одного входа.</p>
      )}

      {active.length > 0 && (
        <ul className="divide-y divide-border-light rounded-lg border border-border">
          {active.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-text-primary">{device.label}</div>
                <div className="text-xs text-text-secondary">
                  {device.lastUsedAt
                    ? `вход использован ${formatRelativeRu(device.lastUsedAt)}`
                    : "ещё ни разу не использовался"}
                  {device.lastClientVersion && <span> · версия {device.lastClientVersion}</span>}
                </div>
              </div>
              <button
                type="button"
                disabled={revokeDevice.isPending}
                onClick={() => handleRevoke(device)}
                className="btn btn-ghost btn-sm"
              >
                {REVOCATION_LABEL.device}
              </button>
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ChevronRight size={14} aria-hidden className={`transition-transform ${historyOpen ? "rotate-90" : ""}`} />
            Завершённые входы ({history.length})
          </button>
          {historyOpen && (
            <ul className="mt-1.5 space-y-1">
              {history.map((device) => (
                <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1 text-xs text-text-secondary">
                  <span>{device.label}</span>
                  <span>
                    {deviceRevokedReasonLabel(device.revokedReason)
                      ?? (device.revokedAt ? "вход завершён" : "срок истёк")}
                    {" · "}
                    {formatDateTime(device.revokedAt ?? device.expiresAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Links                                                              */
/* ------------------------------------------------------------------ */

function LinksSection({
  user,
  createLink,
  onLinkCreated,
}: {
  user: AdminUser;
  createLink: ReturnType<typeof useCreateAccountLink>;
  onLinkCreated: (link: RevealedLink) => void;
}) {
  const { data: links, isLoading, isError, error } = useUserLinks(user.id);
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
      onError: (mutationError) => {
        toast.error(mutationError instanceof Error ? mutationError.message : "Не удалось создать ссылку");
      },
    });
  }

  function handleRevoke(link: AccountLinkItem) {
    revokeLink.mutate(link.id, {
      onSuccess: () => toast.success("Ссылка отозвана"),
      onError: (mutationError) => {
        toast.error(mutationError instanceof Error ? mutationError.message : "Не удалось отозвать ссылку");
      },
    });
  }

  return (
    <div>
      <h3 className="card-title mb-2">Ссылки</h3>
      {isError && (
        <StaleDataNotice
          title={links ? "История ссылок не обновилась" : "История ссылок недоступна"}
          error={error}
          className="mb-2"
        />
      )}
      {isLoading && !links && <p className="text-sm text-text-secondary">Загружаем…</p>}
      {links && links.length === 0 && <p className="text-sm text-text-secondary">Ссылок ещё не было.</p>}

      {(links ?? []).length > 0 && (
        <ul className="divide-y divide-border-light rounded-lg border border-border">
          {(links ?? []).map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0 text-sm">
                <span className="text-text-primary">{LINK_KIND_LABEL[link.kind]}</span>
                <span className="ml-2 text-xs text-text-secondary">
                  {linkStateLabel(link, formatDateTime)} · создана {formatDateTime(link.createdAt)}
                </span>
              </div>
              {link.state === "active" && !disabled && (
                <button
                  type="button"
                  disabled={revokeLink.isPending}
                  onClick={() => handleRevoke(link)}
                  className="btn btn-ghost btn-sm"
                >
                  Отозвать ссылку
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {disabled ? (
        <p className="field-hint">Новые ссылки можно создать после восстановления доступа.</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {invited ? (
            <button
              type="button"
              disabled={createLink.isPending}
              onClick={() => handleCreate("invite")}
              className="btn btn-sm"
            >
              {createLink.isPending ? "Создаём…" : "Отправить приглашение заново"}
            </button>
          ) : canReset && (
            <button
              type="button"
              disabled={createLink.isPending}
              onClick={() => handleCreate("password_reset")}
              className="btn btn-sm"
            >
              {createLink.isPending ? "Создаём…" : "Сбросить пароль ссылкой"}
            </button>
          )}
          <p className="field-hint">
            Новая ссылка отменяет прежнюю. Когда человек задаст пароль, все прежние
            входы завершатся.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pages                                                              */
/* ------------------------------------------------------------------ */

function SavedPagesSection({ user }: { user: AdminUser }) {
  return (
    <div>
      <h3 className="card-title mb-1">Сохранённые страницы</h3>
      <p className="text-sm text-text-secondary">
        После восстановления доступа участник снова сможет работать с этими страницами.
      </p>
      {user.assignedPages.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">Страниц пока нет.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          {user.assignedPages.map((page) => <span key={page.id} className="badge">{page.label} · {page.modelName}</span>)}
        </div>
      )}
    </div>
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось назначить страницу");
    }
  }

  async function handleUnassign(pageLabel: string) {
    try {
      await unassignPage.mutateAsync(pageLabel);
      toast.success(`Страница ${pageLabel} снята с ${user.username}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось снять страницу");
    }
  }

  return (
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
  );
}

/* ------------------------------------------------------------------ */
/*  Confirmations                                                      */
/* ------------------------------------------------------------------ */

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
      message: "Все входы и ссылки перестанут работать, участник перейдёт в «Отключённые участники». "
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
        + "Логин освободится — новый участник с этим логином получит отдельный аккаунт, "
        + "а история работы и финансовые записи останутся за прежним участником.",
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
    } catch (error) {
      toast.error(kind === "deleteAccount"
        ? "Не удалось подтвердить удаление. Проверьте состояние участника в списке."
        : error instanceof Error ? error.message : "Не удалось выполнить действие");
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
