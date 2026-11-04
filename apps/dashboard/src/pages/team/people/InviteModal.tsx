import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AdminUser } from "@agency_hub_core/contracts";

import { useAdminPages, useAdminUsers, type useCreateInvite } from "@/api/queries";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { Segmented } from "@/components/ui/Segmented";
import {
  daysToHours,
  findTeamMemberByLogin,
  groupPagesByPlatform,
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  isValidUsername,
} from "./teamView.js";
import type { RevealedLink } from "./LinkRevealModal.js";

/**
 * Inviting a person is ONE call (`adminCreateInvite`): the
 * account, its page assignments and the one-time link are created together or
 * not at all. The old three-call provisioning (create → set password → assign)
 * left half-made accounts behind whenever a later step failed, and made the
 * owner invent a password and dictate it over Telegram.
 *
 * The mutation is owned by the people's layout, not by this modal: TanStack drops a
 * per-call `mutate` callback when the observer that issued it unmounts, so a
 * modal-owned mutation would silently discard the only copy of the link if the
 * owner dismissed the dialog mid-flight.
 */

export function InviteModal({
  create,
  onClose,
  onCreated,
  onOpenExisting,
}: {
  create: ReturnType<typeof useCreateInvite>;
  onClose: () => void;
  onCreated: (link: RevealedLink) => void;
  onOpenExisting: (userId: number) => void;
}) {
  const { data: pages, isLoading: pagesLoading, isError: pagesError, refetch: refetchPages, isFetching: pagesFetching } = useAdminPages();
  const { data: users, isError: usersError, refetch: refetchUsers, isFetching: usersFetching } = useAdminUsers();
  const [username, setUsername] = useState("");
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const [role, setRole] = useState<"chatter" | "team_lead">("chatter");
  const [days, setDays] = useState(INVITE_DEFAULT_DAYS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submissionFailed, setSubmissionFailed] = useState(false);

  const trimmed = username.trim();
  const nameLooksWrong = trimmed.length > 0 && !isValidUsername(trimmed);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= INVITE_MAX_DAYS;
  const groups = groupPagesByPlatform(pages ?? []);
  const existing = findTeamMemberByLogin(users ?? [], trimmed);
  const canSubmit = trimmed.length > 0
    && !nameLooksWrong
    && daysValid
    && !pagesError
    && Boolean(users)
    && !usersError
    && !existing
    && pageLabels.every((label) => pages?.some((page) => page.label === label))
    && !create.isPending;

  function togglePage(label: string) {
    setPageLabels((current) => (
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
    ));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmissionFailed(false);
    create.mutate({
      username: trimmed,
      role,
      pageLabels,
      expiresInHours: daysToHours(days),
    }, {
      onSuccess: (result) => {
        onCreated({
          userId: result.user.id,
          username: result.user.username,
          kind: result.link.kind,
          secret: result.link.token,
          expiresAt: result.link.expiresAt,
        });
      },
      onError: () => {
        // Another owner tab may have created this login after our read. A
        // fresh list resolves the conflict without parsing server prose or
        // silently restoring anyone. Keep a non-conflict failure in the form.
        setSubmissionFailed(true);
        void refetchUsers();
      },
    });
  }

  // Every dismissal path (Cancel, Escape, backdrop) routes through here: while
  // the invite is being created there is nothing useful to go back to.
  const closeUnlessPending = () => {
    if (!create.isPending) {
      onClose();
    }
  };
  // Something typed is not thrown away by Escape or a click beside the window: only its buttons close it.
  const dirty = username.trim() !== "" || pageLabels.length > 0 || role !== "chatter" || days !== INVITE_DEFAULT_DAYS;

  return (
    <ModalShell title="Пригласить в команду" onClose={closeUnlessPending} closeLabel="Закрыть" explicitCloseOnly={dirty || create.isPending} size="short">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <div>
          <div className="field-label">Роль</div>
          <Segmented
            label="Роль"
            value={role}
            onChange={(value) => setRole(value)}
            options={[{ value: "chatter", label: "Чаттер" }, { value: "team_lead", label: "Тимлид" }]}
          />
        </div>
        <Field
          label="Логин"
          hint="С этим логином человек будет входить в расширение и в приложение. Пароль он придумает сам, открыв ссылку."
        >
          <input
            value={username}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            disabled={create.isPending}
            onChange={(event) => {
              setUsername(event.target.value);
              setSubmissionFailed(false);
            }}
            placeholder="например, grisha"
            className="input"
          />
        </Field>
        {nameLooksWrong && (
          <p role="alert" className="field-error -mt-3">
            Логин может состоять из латинских букв, цифр, точки, дефиса и подчёркивания
            и должен начинаться с буквы или цифры.
          </p>
        )}

        {existing && (
          <ExistingMemberNotice
            user={existing}
            disabled={create.isPending}
            onOpen={() => { if (!create.isPending) onOpenExisting(existing.id); }}
          />
        )}
        {(!users || usersError) && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-text-secondary" aria-live="polite">
            {usersError ? "Не удалось проверить, свободен ли логин." : "Проверяем список сотрудников…"}
            {usersError && (
              <button type="button" disabled={usersFetching} onClick={() => void refetchUsers()} className="btn btn-sm">
                Повторить
              </button>
            )}
          </div>
        )}
        {submissionFailed && !existing && (
          <p role="alert" className="notice notice-danger">
            Не удалось создать приглашение. Проверьте соединение и попробуйте ещё раз.
          </p>
        )}

        {!existing && (
          <fieldset disabled={create.isPending} className="space-y-6">
            <div>
              <div className="field-label">Страницы</div>
              {pagesLoading && !pages && <p className="text-sm text-text-secondary">Загружаем страницы…</p>}
              {pagesError && (
                <div role="alert" className="notice notice-warning mb-2">
                  <div className="notice-body">Список страниц не загрузился. Выбор сохранён — обновите его перед отправкой.</div>
                  <div className="notice-action">
                    <button type="button" disabled={pagesFetching} onClick={() => void refetchPages()} className="btn btn-sm">
                      Повторить
                    </button>
                  </div>
                </div>
              )}
              {pages && pages.length === 0 && (
                <p className="text-sm text-text-secondary">Страниц пока нет — их можно назначить позже.</p>
              )}
              {groups.length > 0 && (
                <div className="invite-pages">
                  {groups.map((group) => (
                    <div key={group.platform}>
                      <div className="invite-group">{group.label}</div>
                      <div>
                        {group.pages.map((page) => (
                          <label key={page.id} className="invite-page">
                            <input
                              type="checkbox"
                              checked={pageLabels.includes(page.label)}
                              onChange={() => togglePage(page.label)}
                            />
                            <span>{page.label}</span>
                            <span className="team-muted">{page.modelName}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <button
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}
                className="inline-flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary"
              >
                <ChevronRight size={14} aria-hidden className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`} />
                Дополнительно
              </button>
              {advancedOpen && (
                <div className="mt-3 max-w-[200px]">
                  <Field label="Срок ссылки, дней">
                    <input
                      type="number"
                      min={1}
                      max={INVITE_MAX_DAYS}
                      value={days}
                      onChange={(event) => setDays(Number(event.target.value))}
                      className="input"
                    />
                    {!daysValid && (
                      <span role="alert" className="field-error block">
                        От 1 до {INVITE_MAX_DAYS} дней.
                      </span>
                    )}
                  </Field>
                </div>
              )}
            </div>
          </fieldset>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={closeUnlessPending} disabled={create.isPending} className="btn">
            Отмена
          </button>
          {!existing && (
            <button type="submit" disabled={!canSubmit} className="btn btn-primary">
              {create.isPending ? "Создаём…" : "Создать приглашение"}
            </button>
          )}
        </div>
      </form>
    </ModalShell>
  );
}

export function ExistingMemberNotice({ user, onOpen, disabled = false }: { user: AdminUser; onOpen: () => void; disabled?: boolean | undefined }) {
  return (
    <div role="status" className="notice notice-warning">
      <div className="notice-body">
      <p className="font-medium">Логин «{user.username}» уже занят</p>
      <p className="mt-1">
        {user.disabledAt
          ? "У этого сотрудника отключён доступ, логин и история сохранены — если возвращается тот же человек, восстановите доступ. Чтобы создать новый аккаунт с этим логином, сначала удалите прежний в его карточке."
          : user.registrationState === "invited"
            ? "Сотрудник уже приглашён, но ещё не задал пароль. Откройте его карточку, чтобы создать новую ссылку."
            : "Этот сотрудник уже в команде. Откройте его карточку, чтобы проверить доступ или помочь со входом."}
      </p>
      <button type="button" disabled={disabled} onClick={onOpen} className="btn btn-sm mt-3">
        {user.disabledAt ? "Перейти к восстановлению" : "Открыть сотрудника"}
      </button>
      </div>
    </div>
  );
}
