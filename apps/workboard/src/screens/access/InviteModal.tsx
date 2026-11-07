import { useState } from "react";
import { Button, Checkbox, Disclosure, Field, Modal, Notice, Segmented, Spinner, TextInput, platformWord } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, daysToHours, findByLogin, isValidUsername } from "@agency_hub_core/ui/teamAccess";
import { pagesByModel, useAccessPages, useAccessUsers, type AdminUser, type useCreateInvite } from "./data";
import type { RevealedLink } from "./LinkReveal";

/**
 * Inviting a person is ONE call (`adminCreateInvite`, the console's
 * InviteModal.tsx:73-100): the account, its pages and the one-time link are
 * made together or not at all. The same body, checks and words; the pages are
 * grouped by model with «вся модель» and all in view (no inner scroll), the
 * role and the link's lifetime folded under «Дополнительно».
 *
 * The mutation is the screen's, not this window's: TanStack drops a callback
 * whose observer is gone, and that would lose the only copy of the link.
 */

export function InviteModal({ create, onClose, onCreated, onOpenExisting }: {
  create: ReturnType<typeof useCreateInvite>;
  onClose: () => void;
  onCreated: (link: RevealedLink) => void;
  onOpenExisting: (userId: number) => void;
}) {
  const pages = useAccessPages();
  const users = useAccessUsers();
  const [username, setUsername] = useState("");
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const [role, setRole] = useState<"chatter" | "team_lead">("chatter");
  const [days, setDays] = useState(INVITE_DEFAULT_DAYS);
  const [submissionFailed, setSubmissionFailed] = useState(false);

  const trimmed = username.trim();
  const nameLooksWrong = trimmed.length > 0 && !isValidUsername(trimmed);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= INVITE_MAX_DAYS;
  const existing = findByLogin(users.data ?? [], trimmed);
  const canSubmit = trimmed.length > 0
    && !nameLooksWrong
    && daysValid
    && !pages.isError
    && Boolean(users.data)
    && !users.isError
    && !existing
    && pageLabels.every((label) => pages.data?.some((page) => page.label === label))
    && !create.isPending;
  const models = pagesByModel(pages.data ?? []);
  const pending = create.isPending;
  // Something typed is not thrown away by Escape or a click beside the window: only its buttons close it.
  const dirty = trimmed !== "" || pageLabels.length > 0 || role !== "chatter" || days !== INVITE_DEFAULT_DAYS;

  const toggle = (label: string, on: boolean) => setPageLabels((current) => (on ? [...new Set([...current, label])] : current.filter((item) => item !== label)));
  const toggleModel = (labels: string[], on: boolean) => setPageLabels((current) => (on ? [...new Set([...current, ...labels])] : current.filter((item) => !labels.includes(item))));

  function submit() {
    if (!canSubmit) return;
    setSubmissionFailed(false);
    create.mutate({ username: trimmed, role, pageLabels, expiresInHours: daysToHours(days) }, {
      onSuccess: (result) => onCreated({
        userId: result.user.id,
        username: result.user.username,
        kind: result.link.kind,
        secret: result.link.token,
        expiresAt: result.link.expiresAt,
      }),
      onError: () => {
        // Another tab may have taken this login after our read: a fresh list resolves it.
        setSubmissionFailed(true);
        void users.refetch();
      },
    });
  }

  const close = () => {
    if (!pending) onClose();
  };

  return (
    <Modal
      title="Пригласить в команду"
      onClose={close}
      size="wide"
      explicitCloseOnly={dirty || pending}
      actions={(
        <>
          {pageLabels.length > 0 && !existing && <span className="access-invite__picked">{pageLabels.length} {ruPlural(pageLabels.length, "страница", "страницы", "страниц")}</span>}
          <Button disabled={pending} onClick={close}>Отмена</Button>
          {!existing && (
            <Button variant="primary" disabled={!canSubmit} loading={pending} onClick={submit}>
              {pending ? "Создаём…" : "Создать приглашение"}
            </Button>
          )}
        </>
      )}
    >
      <form
        className="access-invite"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Логин"
          hint="С этим логином человек будет входить в расширение и в приложение. Пароль он придумает сам, открыв ссылку."
          error={nameLooksWrong ? "Логин может состоять из латинских букв, цифр, точки, дефиса и подчёркивания и должен начинаться с буквы или цифры." : undefined}
        >
          {(control) => (
            <TextInput
              {...control}
              data-autofocus
              value={username}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              placeholder="например, grisha"
              onChange={(event) => {
                setUsername(event.target.value);
                setSubmissionFailed(false);
              }}
            />
          )}
        </Field>

        {existing && <ExistingMember user={existing} disabled={pending} onOpen={() => { if (!pending) onOpenExisting(existing.id); }} />}
        {(!users.data || users.isError) && (
          <p role="status" className="access-hint access-invite__check">
            {users.isError ? "Не удалось проверить, свободен ли логин." : <><Spinner /> Проверяем список сотрудников…</>}
            {users.isError && <Button size="sm" disabled={users.isFetching} onClick={() => void users.refetch()}>Повторить</Button>}
          </p>
        )}
        {submissionFailed && !existing && (
          <Notice tone="danger" role="alert">Не удалось создать приглашение. Проверьте соединение и попробуйте ещё раз.</Notice>
        )}

        {!existing && (
          <fieldset disabled={pending} className="access-invite__pages">
            <legend className="ui-field__label">Страницы</legend>
            {pages.isLoading && !pages.data && <p className="access-hint">Загружаем страницы…</p>}
            {pages.isError && (
              <Notice tone="warning" role="alert" action={<Button size="sm" disabled={pages.isFetching} onClick={() => void pages.refetch()}>Повторить</Button>}>
                Список страниц не загрузился. Выбор сохранён — обновите его перед отправкой.
              </Notice>
            )}
            {pages.data && pages.data.length === 0 && <p className="access-hint">Страниц пока нет — их можно назначить позже.</p>}
            <div className="access-invite__models">
              {models.map((model) => {
                const labels = model.pages.map((page) => page.label);
                const picked = labels.filter((label) => pageLabels.includes(label)).length;
                return (
                  <div key={model.modelSlug} className="access-invite__group">
                    {model.pages.length > 1 ? (
                      <Checkbox
                        className="access-invite__model"
                        label={<span className="access-words">{model.modelName}<span className="access-hint">вся модель · {labels.length} {ruPlural(labels.length, "страница", "страницы", "страниц")}</span></span>}
                        checked={picked === labels.length}
                        indeterminate={picked > 0}
                        disabled={pending}
                        onChange={(on) => toggleModel(labels, on)}
                      />
                    ) : <div className="access-invite__model access-invite__model--single">{model.modelName}</div>}
                    <div className="access-invite__list">
                      {model.pages.map((page) => (
                        <Checkbox
                          key={page.id}
                          className="access-invite__page"
                          label={<span className="access-words">{page.label}<span className="access-hint">{platformWord(page.platform) ?? page.platform}</span></span>}
                          checked={pageLabels.includes(page.label)}
                          disabled={pending}
                          onChange={(on) => toggle(page.label, on)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        {!existing && (
          <Disclosure summary="Дополнительно: роль и срок ссылки" hint={role === "team_lead" || days !== INVITE_DEFAULT_DAYS ? `${role === "team_lead" ? "тимлид" : "чаттер"}, ${days} ${ruPlural(days, "день", "дня", "дней")}` : undefined}>
            <div className="access-invite__more">
              <div className="ui-field">
                <span className="ui-field__label">Роль</span>
                <Segmented
                  label="Роль"
                  value={role}
                  onChange={setRole}
                  options={[{ value: "chatter", label: "Чаттер" }, { value: "team_lead", label: "Тимлид" }]}
                />
              </div>
              <Field label="Срок ссылки, дней" error={daysValid ? undefined : `От 1 до ${INVITE_MAX_DAYS} дней.`}>
                {(control) => (
                  <TextInput {...control} type="number" min={1} max={INVITE_MAX_DAYS} value={days} disabled={pending} onChange={(event) => setDays(Number(event.target.value))} className="access-invite__days" />
                )}
              </Field>
            </div>
          </Disclosure>
        )}
      </form>
    </Modal>
  );
}

/** The login is taken: whose, and the one way on (the console's ExistingMemberNotice, InviteModal.tsx:262-280). */
function ExistingMember({ user, onOpen, disabled }: { user: AdminUser; onOpen: () => void; disabled: boolean }) {
  return (
    <Notice
      tone="warning"
      role="status"
      title={`Логин «${user.username}» уже занят`}
      action={<Button size="sm" disabled={disabled} onClick={onOpen}>{user.disabledAt ? "Перейти к восстановлению" : "Открыть сотрудника"}</Button>}
    >
      {user.disabledAt
        ? "У этого сотрудника отключён доступ, логин и история сохранены — если возвращается тот же человек, восстановите доступ. Чтобы создать новый аккаунт с этим логином, сначала удалите прежний в его карточке."
        : user.registrationState === "invited"
          ? "Сотрудник уже приглашён, но ещё не задал пароль. Откройте его карточку, чтобы создать новую ссылку."
          : "Этот сотрудник уже в команде. Откройте его карточку, чтобы проверить доступ или помочь со входом."}
    </Notice>
  );
}
