import { useState } from "react";
import type { AdminUser } from "@agency_hub_core/contracts";

import { useAdminPages, useAdminUsers, type useCreateInvite } from "@/api/queries";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import {
  daysToHours,
  findTeamMemberByLogin,
  groupPagesByPlatform,
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  isValidUsername,
  PLATFORM_DOT_CLASS,
} from "./teamView.js";
import type { RevealedLink } from "./LinkRevealModal.js";

/**
 * Decision 350 — inviting a person is ONE call (`adminCreateInvite`): the
 * account, its page assignments and the one-time link are created together or
 * not at all. The old three-call provisioning (create → set password → assign)
 * left half-made accounts behind whenever a later step failed, and made the
 * owner invent a password and dictate it over Telegram.
 *
 * The mutation is owned by the tab, not by this modal: TanStack drops a
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
  onOpenExisting: (username: string) => void;
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

  return (
    <ModalShell title="Пригласить в команду" onClose={closeUnlessPending} closeLabel="Закрыть">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Логин">
          <input
            value={username}
            maxLength={100}
            autoComplete="off"
            disabled={create.isPending}
            onChange={(event) => {
              setUsername(event.target.value);
              setSubmissionFailed(false);
            }}
            placeholder="например, grisha"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <p className="mt-1 text-xs text-text-muted">
            С этим логином человек будет входить в расширение и в приложение.
            Пароль он придумает сам, открыв ссылку.
          </p>
          {nameLooksWrong && (
            <p role="alert" className="mt-1 text-xs text-danger">
              Логин может состоять из латинских букв, цифр, точки, дефиса и подчёркивания
              и должен начинаться с буквы или цифры.
            </p>
          )}
        </Field>

        {existing && (
          <ExistingMemberNotice
            user={existing}
            disabled={create.isPending}
            onOpen={() => { if (!create.isPending) onOpenExisting(existing.username); }}
          />
        )}
        {(!users || usersError) && (
          <div role="alert" className="text-sm text-text-secondary">
            {usersError ? "Не удалось проверить, свободен ли логин." : "Проверяем список участников…"}
            {usersError && (
              <button type="button" disabled={usersFetching} onClick={() => void refetchUsers()} className="ml-2 underline disabled:opacity-50">
                Повторить
              </button>
            )}
          </div>
        )}
        {submissionFailed && !existing && (
          <p role="alert" className="text-sm text-danger">
            Не удалось создать приглашение. Проверьте соединение и попробуйте ещё раз.
          </p>
        )}

        {!existing && (
          <fieldset disabled={create.isPending} className="space-y-4">
            <div>
              <div className="mb-1 text-sm text-text-secondary">Страницы</div>
              {pagesLoading && !pages && <p className="text-sm text-text-muted">Загружаем страницы…</p>}
              {pagesError && (
                <div role="alert" className="mb-2 text-sm text-danger">
                  Список страниц не загрузился. Выбор сохранён — обновите его перед отправкой.
                  <button
                    type="button"
                    disabled={pagesFetching}
                    onClick={() => void refetchPages()}
                    className="ml-2 underline disabled:opacity-50"
                  >
                    Повторить
                  </button>
                </div>
              )}
              {pages && pages.length === 0 && (
                <p className="text-sm text-text-muted">Страниц пока нет — их можно назначить позже.</p>
              )}
              <div className="max-h-48 space-y-3 overflow-y-auto">
                {groups.map((group) => (
                  <div key={group.platform}>
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-text-muted">
                      <span className={`h-1.5 w-1.5 rounded-full ${PLATFORM_DOT_CLASS[group.platform]}`} />
                      {group.label}
                    </div>
                    <div className="space-y-1">
                      {group.pages.map((page) => (
                        <label key={page.id} className="flex items-center gap-2 text-sm text-text-primary">
                          <input
                            type="checkbox"
                            checked={pageLabels.includes(page.label)}
                            onChange={() => togglePage(page.label)}
                          />
                          <span>{page.label}</span>
                          <span className="text-xs text-text-muted">{page.modelName}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-bg">
              <button
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium text-text-secondary"
              >
                <span className={`inline-block text-xs transition-transform ${advancedOpen ? "rotate-90" : ""}`}>
                  {"▸"}
                </span>
                Дополнительно
              </button>
              {advancedOpen && (
                <div className="grid gap-3 px-3 pb-3 sm:grid-cols-2">
                  <Field label="Роль">
                    <select
                      value={role}
                      onChange={(event) => setRole(event.target.value === "team_lead" ? "team_lead" : "chatter")}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                    >
                      <option value="chatter">чаттер</option>
                      <option value="team_lead">тимлид</option>
                    </select>
                  </Field>
                  <Field label="Срок ссылки, дней">
                    <input
                      type="number"
                      min={1}
                      max={INVITE_MAX_DAYS}
                      value={days}
                      onChange={(event) => setDays(Number(event.target.value))}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                    />
                    {!daysValid && (
                      <p role="alert" className="mt-1 text-xs text-danger">
                        От 1 до {INVITE_MAX_DAYS} дней.
                      </p>
                    )}
                  </Field>
                </div>
              )}
            </div>
          </fieldset>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeUnlessPending}
            disabled={create.isPending}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            Отмена
          </button>
          {!existing && (
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {create.isPending ? "Создаём…" : "Создать приглашение"}
            </button>
          )}
        </div>
      </form>
    </ModalShell>
  );
}

export function ExistingMemberNotice({ user, onOpen, disabled = false }: { user: AdminUser; onOpen: () => void; disabled?: boolean }) {
  return (
    <div role="status" className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-3 text-sm text-text-secondary">
      <p className="font-semibold text-text-primary">Логин «{user.username}» уже занят</p>
      <p>
        {user.disabledAt
          ? "У этого участника отключён доступ. Его логин и история сохранены. Если возвращается тот же человек, восстановите его доступ. Для другого человека выберите другой логин."
          : user.registrationState === "invited"
            ? "Участник уже приглашён, но ещё не задал пароль. Откройте его карточку, чтобы создать новую ссылку."
            : "Этот участник уже в команде. Откройте его карточку, чтобы проверить доступ или помочь со входом."}
      </p>
      <button type="button" disabled={disabled} onClick={onOpen} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
        {user.disabledAt ? "Перейти к восстановлению" : "Открыть участника"}
      </button>
    </div>
  );
}
