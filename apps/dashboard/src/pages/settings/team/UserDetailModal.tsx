import { useState } from "react";
import { toast } from "sonner";
import type { AccountLinkItem, AdminUser, DeviceTokenItem } from "@agency_hub_core/contracts";

import {
  useAdminAssignPage,
  useAdminDeactivateUser,
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
} from "./teamView.js";

/**
 * Decision 350 — one person's card: their devices, their links, their pages.
 *
 * The three revocations are named for what they actually do (§4.4, Р6). The
 * old console offered a single "revoke" that left dashboard sessions and keys
 * alive while calling itself "signed out everywhere"; here each button says
 * exactly how far it reaches, so the owner firing someone can pick the one
 * that matches the situation.
 *
 * The link-creating mutation is owned by the TAB and passed in: it carries the
 * only copy of a fresh link in its result, and a mutation owned by a modal
 * loses that handoff if the modal closes mid-flight.
 */

type Confirmation = "revokeAllDevices" | "terminateAccess" | "deactivate" | "reactivate";

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
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            <span className="rounded-full border border-border bg-hover-alt px-2 py-0.5 text-xs">
              {ROLE_LABEL[user.role]}
            </span>
            <span className="rounded-full border border-border bg-hover-alt px-2 py-0.5 text-xs">
              {TEAM_STATUS_LABEL[status]}
            </span>
            {user.lastActiveAt && (
              <span className="text-xs text-text-muted">
                последняя активность {formatRelativeRu(user.lastActiveAt)}
              </span>
            )}
          </div>

          {status === "disabled" && (
            <AccountStateSection
              user={user}
              onDeactivate={() => setConfirmation("deactivate")}
              onReactivate={() => setConfirmation("reactivate")}
            />
          )}

          {status === "invited" && (
            <p className="rounded-lg border border-border bg-hover-alt px-3 py-2 text-sm text-text-secondary">
              Человек ещё не открыл приглашение и не придумал пароль. Пока этого не
              случилось, войти он не может.
            </p>
          )}

          <DevicesSection
            username={user.username}
            disabled={status === "disabled"}
            onRevokeAll={() => setConfirmation("revokeAllDevices")}
            onTerminate={ownerIsProtected(user) ? null : () => setConfirmation("terminateAccess")}
          />

          <LinksSection
            user={user}
            createLink={createLink}
            onLinkCreated={onLinkCreated}
          />

          {status === "disabled" ? <SavedPagesSection user={user} /> : <PagesSection user={user} />}

          {!ownerIsProtected(user) && status !== "disabled" && (
            <AccountStateSection
              user={user}
              onDeactivate={() => setConfirmation("deactivate")}
              onReactivate={() => setConfirmation("reactivate")}
            />
          )}

          {ownerIsProtected(user) && (
            <p className="rounded-lg border border-border bg-hover-alt px-3 py-2.5 text-xs text-text-muted">
              Владельца нельзя деактивировать и нельзя завершить все его входы —
              иначе консоль осталась бы без хозяина. Пароль владелец меняет сам.
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
          >
            Закрыть
          </button>
        </div>
      </ModalShell>

      {confirmation && (
        <ConfirmationDialog
          kind={confirmation}
          user={user}
          onClose={() => setConfirmation(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Devices                                                            */
/* ------------------------------------------------------------------ */

function DevicesSection({
  username,
  disabled,
  onRevokeAll,
  onTerminate,
}: {
  username: string;
  disabled: boolean;
  onRevokeAll: () => void;
  /** null for an owner: the kernel refuses to terminate their access. */
  onTerminate: (() => void) | null;
}) {
  const { data: devices, isLoading, isError, error } = useUserDevices(username);
  const revokeDevice = useRevokeDevice(username);
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
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Устройства</h3>
      {isError && (
        <StaleDataNotice
          title={devices ? "Список устройств не обновился" : "Список устройств недоступен"}
          error={error}
          className="mb-2"
        />
      )}
      {isLoading && !devices && <p className="text-sm text-text-muted">Загружаем…</p>}
      {devices && active.length === 0 && (
        <p className="text-sm text-text-muted">Сейчас ни одного входа.</p>
      )}

      <div className="space-y-1.5">
        {active.map((device) => (
          <div
            key={device.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm text-text-primary">{device.label}</div>
              <div className="text-xs text-text-muted">
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
              className="shrink-0 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              {REVOCATION_LABEL.device}
            </button>
          </div>
        ))}
      </div>

      {history.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
            className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text-primary"
          >
            <span className={`inline-block transition-transform ${historyOpen ? "rotate-90" : ""}`}>{"▸"}</span>
            Завершённые входы ({history.length})
          </button>
          {historyOpen && (
            <div className="mt-1.5 space-y-1">
              {history.map((device) => (
                <div key={device.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1 text-xs text-text-muted">
                  <span>{device.label}</span>
                  <span>
                    {deviceRevokedReasonLabel(device.revokedReason)
                      ?? (device.revokedAt ? "вход завершён" : "срок истёк")}
                    {" · "}
                    {formatDateTime(device.revokedAt ?? device.expiresAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!disabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRevokeAll}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-hover"
          >
            {REVOCATION_LABEL.allDevices}
          </button>
          {onTerminate && (
            <button
              type="button"
              onClick={onTerminate}
              className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
            >
              {REVOCATION_LABEL.allAccess}
            </button>
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
  const { data: links, isLoading, isError, error } = useUserLinks(user.username);
  const revokeLink = useRevokeLink(user.username);
  const invited = teamStatus(user) === "invited";
  const canReset = LINK_RESETTABLE_ROLES.has(user.role);
  const disabled = Boolean(user.disabledAt);

  function handleCreate(kind: "invite" | "password_reset") {
    if (disabled) return;
    createLink.mutate({ kind }, {
      onSuccess: (link) => {
        onLinkCreated({
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
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Ссылки</h3>
      {isError && (
        <StaleDataNotice
          title={links ? "История ссылок не обновилась" : "История ссылок недоступна"}
          error={error}
          className="mb-2"
        />
      )}
      {isLoading && !links && <p className="text-sm text-text-muted">Загружаем…</p>}
      {links && links.length === 0 && <p className="text-sm text-text-muted">Ссылок ещё не было.</p>}

      <div className="space-y-1.5">
        {(links ?? []).map((link) => (
          <div
            key={link.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2"
          >
            <div className="min-w-0 text-sm">
              <span className="text-text-primary">{LINK_KIND_LABEL[link.kind]}</span>
              <span className="ml-2 text-xs text-text-muted">
                {linkStateLabel(link, formatDateTime)} · создана {formatDateTime(link.createdAt)}
              </span>
            </div>
            {link.state === "active" && !disabled && (
              <button
                type="button"
                disabled={revokeLink.isPending}
                onClick={() => handleRevoke(link)}
                className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-danger hover:bg-hover disabled:opacity-50"
              >
                Отозвать ссылку
              </button>
            )}
          </div>
        ))}
      </div>

      {disabled ? (
        <p className="mt-3 text-xs text-text-muted">Новые ссылки можно создать после восстановления доступа.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {invited ? (
            <button
              type="button"
              disabled={createLink.isPending}
              onClick={() => handleCreate("invite")}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-hover disabled:opacity-50"
            >
              {createLink.isPending ? "Создаём…" : "Отправить приглашение заново"}
            </button>
          ) : canReset && (
            <button
              type="button"
              disabled={createLink.isPending}
              onClick={() => handleCreate("password_reset")}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-hover disabled:opacity-50"
            >
              {createLink.isPending ? "Создаём…" : "Сбросить пароль ссылкой"}
            </button>
          )}
          <p className="text-xs text-text-muted">
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
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Сохранённые страницы</h3>
      <p className="text-xs text-text-muted">
        После восстановления доступа участник снова сможет работать с этими страницами.
      </p>
      <ul className="mt-2 space-y-1 text-sm text-text-secondary">
        {user.assignedPages.map((page) => <li key={page.id}>{page.label} · {page.modelName}</li>)}
      </ul>
      {user.assignedPages.length === 0 && <p className="mt-2 text-sm text-text-muted">Страниц пока нет.</p>}
    </div>
  );
}

function PagesSection({ user }: { user: AdminUser }) {
  const { data: allPages, isLoading, isError, refetch } = useAdminPages();
  const assignPage = useAdminAssignPage(user.username);
  const unassignPage = useAdminUnassignPage(user.username);
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
/*  Account state                                                      */
/* ------------------------------------------------------------------ */

function AccountStateSection({
  user,
  onDeactivate,
  onReactivate,
}: {
  user: AdminUser;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  if (user.disabledAt) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-hover-alt px-3 py-2.5">
        <p className="text-xs text-text-muted">
          Доступ отключён {formatDateTime(user.disabledAt)}. Логин и история сохранены.
          Восстановите доступ, если возвращается тот же человек.
        </p>
        <button
          type="button"
          onClick={onReactivate}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
        >
          Восстановить доступ
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2.5">
      <p className="text-xs text-text-muted">
        Отключение завершит все входы {user.username}. Участник перейдёт в раздел
        «Отключённые участники». Его логин и история сохранятся; доступ можно восстановить.
      </p>
      <button
        type="button"
        onClick={onDeactivate}
        className="shrink-0 rounded-lg border border-danger/25 bg-card px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
      >
        Отключить доступ
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Confirmations                                                      */
/* ------------------------------------------------------------------ */

function ConfirmationDialog({
  kind,
  user,
  onClose,
}: {
  kind: Confirmation;
  user: AdminUser;
  onClose: () => void;
}) {
  const revokeAllDevices = useRevokeAllDevices(user.username);
  const terminateAccess = useTerminateAccess(user.username);
  const deactivate = useAdminDeactivateUser(user.username);
  const reactivate = useAdminReactivateUser(user.username);

  const dialogs = {
    revokeAllDevices: {
      title: `${REVOCATION_LABEL.allDevices} — ${user.username}?`,
      message: "Расширение и приложение на всех устройствах перестанут работать и попросят "
        + "войти заново. Вход в консоль и пароль не затрагиваются.",
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
      message: "Завершаются входы на всех устройствах, вход в консоль и все действующие "
        + "ссылки. Человек остаётся в команде, пароль продолжает работать — он сможет "
        + "войти заново сам.",
      confirmLabel: "Завершить",
      isPending: terminateAccess.isPending,
      run: async () => {
        await terminateAccess.mutateAsync();
        toast.success(`Все входы ${user.username} завершены`);
      },
    },
    deactivate: {
      title: `Отключить доступ ${user.username}?`,
      message: "Все входы и ссылки перестанут работать. Участник появится в разделе "
        + "«Отключённые участники». Его логин, история, роль и страницы сохранятся. "
        + "Позже можно восстановить доступ тому же человеку; создать другого с этим логином нельзя.",
      confirmLabel: "Отключить доступ",
      isPending: deactivate.isPending,
      run: async () => {
        await deactivate.mutateAsync();
        toast.success(`Доступ ${user.username} отключён`);
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
    try {
      await dialog.run();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось выполнить действие");
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
