import { useMemo, useState } from "react";
import type { AdminPersonCreateBody } from "@agency_hub_core/contracts";
import { PERSON_CODE_PATTERN } from "@agency_hub_core/contracts";
import { Button, Disclosure, Field, Modal, Notice, Segmented, Spinner, TextInput } from "@agency_hub_core/ui";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, daysToHours, findByLogin, isValidUsername } from "@agency_hub_core/ui/teamAccess";
import { useAccessPages, useAccessUsers } from "@/screens/access/data";
import type { RevealedLink } from "@/screens/access/LinkReveal";
import { EMPTY_SLOT, SlotFields, WorkingPagesPicker, fixMills, shareBasisPoints, slotBody, slotEmpty, slotProblem, type SlotDraft } from "./forms.js";
import { refusal, type CreatedPerson, type RegistryPerson, type useCreatePerson } from "./registry.js";
import { codeFromName } from "./words.js";

/**
 * «Пригласить» (the owner's): a person of the registry in ONE call
 * (`adminPersonCreate`) — the record, the working pages in order, the slot
 * from a day, the pay terms if given, and for a chatter or a team lead the
 * login with its invite link, all or nothing. The link is shown once, with the
 * ready message, by the same window as «Доступ → Пригласить» had
 * (access/LinkReveal.tsx). The login may open the working pages; more pages
 * are opened later on the card («Доступ и входы»).
 *
 * The mutation is the screen's, not this window's: TanStack drops a callback
 * whose observer is gone, and that would lose the only copy of the link.
 */

type InviteRole = "chatter" | "team_lead" | "content_manager" | "contractor";

const ROLE_OPTIONS: readonly { value: InviteRole; label: string }[] = [
  { value: "chatter", label: "Чаттер" },
  { value: "team_lead", label: "Тимлид" },
  { value: "content_manager", label: "Контент-менеджер" },
  { value: "contractor", label: "Подрядчик" },
];

/** Only who works in the chats signs in to Hub (the extension, Workboard). */
function signsIn(role: InviteRole): role is "chatter" | "team_lead" {
  return role === "chatter" || role === "team_lead";
}

const HANDLE = /^@?[A-Za-z0-9_]{3,64}$/;

export function InvitePerson({ people, create, onClose, onCreated, onAdded }: {
  people: readonly RegistryPerson[];
  create: ReturnType<typeof useCreatePerson>;
  onClose: () => void;
  /** A login was invited: show its link once. */
  onCreated: (link: RevealedLink, created: CreatedPerson) => void;
  /** A person without a login was added. */
  onAdded: (created: CreatedPerson) => void;
}) {
  const pages = useAccessPages();
  const users = useAccessUsers();
  const [name, setName] = useState("");
  const [codeTyped, setCodeTyped] = useState<string | null>(null);
  const [role, setRole] = useState<InviteRole>("chatter");
  const [handle, setHandle] = useState("");
  const [working, setWorking] = useState<string[]>([]);
  const [slot, setSlot] = useState<SlotDraft>(EMPTY_SLOT);
  const [from, setFrom] = useState(moscowToday());
  const [terms, setTerms] = useState<Record<string, { share: string; fix: string }>>({});
  const [loginTyped, setLoginTyped] = useState<string | null>(null);
  const [days, setDays] = useState(INVITE_DEFAULT_DAYS);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const code = codeTyped ?? codeFromName(name);
  const login = loginTyped ?? code;
  const withLogin = signsIn(role);
  const pending = create.isPending;

  const models = useMemo(() => {
    const seen = new Map<string, string>();
    for (const page of pages.data ?? []) if (working.includes(page.label) && !seen.has(page.modelSlug)) seen.set(page.modelSlug, page.modelName);
    return [...seen].map(([slug, modelName]) => ({ slug, modelName }));
  }, [pages.data, working]);

  const codeTaken = people.find((person) => person.code === code) ?? null;
  const loginTaken = withLogin ? findByLogin(users.data ?? [], login.trim()) : null;
  const errors = {
    name: name.trim() === "" ? "Напишите имя." : null,
    code: !PERSON_CODE_PATTERN.test(code) ? "Код: строчные латинские буквы, цифры и дефис." : codeTaken ? `Код занят: ${codeTaken.displayName}.` : null,
    handle: handle.trim() !== "" && !HANDLE.test(handle.trim()) ? "Ник Telegram: латиница, цифры и _, от 3 знаков." : null,
    slot: slotEmpty(slot) ? null : slotProblem(slot),
    from: !slotEmpty(slot) && !/^\d{4}-\d{2}-\d{2}$/.test(from) ? "Укажите день, с которого действует график." : null,
    login: !withLogin ? null : !isValidUsername(login.trim()) ? "Логин: латинские буквы, цифры, точка, дефис и подчёркивание." : loginTaken ? `Логин «${loginTaken.username}» уже занят.` : null,
    days: withLogin && !(Number.isInteger(days) && days >= 1 && days <= INVITE_MAX_DAYS) ? `Срок ссылки от 1 до ${INVITE_MAX_DAYS} дней.` : null,
    terms: models.some((model) => {
      const term = terms[model.slug];
      return term !== undefined && term.share.trim() !== "" && (shareBasisPoints(term.share) === null || fixMills(term.fix) === null);
    }) ? "Доля: от 0 до 100 %, фикс: сумма в долларах." : null,
  };
  const ready = Object.values(errors).every((error) => error === null) && Boolean(pages.data) && (!withLogin || Boolean(users.data)) && !pending;
  const dirty = name.trim() !== "" || working.length > 0 || !slotEmpty(slot) || handle !== "";

  function submit() {
    setTried(true);
    if (!ready) return;
    setProblem(null);
    const payTerms = models.flatMap((model) => {
      const term = terms[model.slug];
      const share = term ? shareBasisPoints(term.share) : null;
      if (!term || share === null) return [];
      return [{ modelSlug: model.slug, validFrom: from, shareBasisPoints: share, fixPerShiftMills: fixMills(term.fix) ?? 0 }];
    });
    const body: AdminPersonCreateBody = {
      code,
      displayName: name.trim(),
      role,
      state: withLogin ? "invited" : "set_up",
      ...(handle.trim() ? { telegram: { handle: handle.trim().replace(/^@/, "") } } : {}),
      workingPageLabels: working,
      ...(slotEmpty(slot) ? {} : { schedule: { from, slot: slotBody(slot) } }),
      ...(payTerms.length > 0 ? { payTerms } : {}),
      ...(withLogin ? { invite: { username: login.trim(), role: role === "team_lead" ? "team_lead" as const : "chatter" as const, pageLabels: working, expiresInHours: daysToHours(days) } } : {}),
    };
    create.mutate(body, {
      onSuccess: (created) => {
        if (created.invite) {
          onCreated({
            userId: created.invite.userId, username: created.invite.username, kind: "invite", secret: created.invite.link.token,
            expiresAt: created.invite.link.expiresAt, name: created.person.displayName,
          }, created);
        } else {
          onAdded(created);
        }
      },
      onError: (error) => {
        const { status, reason, message } = refusal(error);
        if (reason === "code_taken") setProblem("Этот код уже у другого человека: выберите другой.");
        else if (reason === "telegram_taken" || reason === "tag_taken") setProblem("Этот Telegram уже у другого человека.");
        else if (status === 400 && /already exists/i.test(message)) setProblem("Этот логин уже занят: выберите другой.");
        else if (status === 404) setProblem("Страница или модель не нашлась в Hub: обновите экран и выберите снова.");
        else setProblem("Не удалось: Hub вернул ошибку. Ничего не создано, попробуйте ещё раз.");
        void users.refetch();
      },
    });
  }

  const close = () => {
    if (!pending) onClose();
  };
  const show = (error: string | null) => (tried ? error ?? undefined : undefined);

  return (
    <Modal
      title="Пригласить в команду"
      onClose={close}
      size="wide"
      explicitCloseOnly={dirty || pending}
      actions={(
        <>
          {working.length > 0 && <span className="access-invite__picked">{working.length} {ruPlural(working.length, "страница", "страницы", "страниц")}</span>}
          <Button disabled={pending} onClick={close}>Отмена</Button>
          <Button variant="primary" disabled={tried && !ready} loading={pending} onClick={submit}>
            {pending ? "Создаём…" : withLogin ? "Создать приглашение" : "Добавить в команду"}
          </Button>
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
        <div className="registry-form__row">
          <Field label="Имя" error={show(errors.name)}>
            {(control) => <TextInput {...control} data-autofocus value={name} maxLength={200} disabled={pending} placeholder="например, Анна" onChange={(event) => setName(event.target.value)} />}
          </Field>
          <Field label="Код" hint="Как в /OS и ledger. Потом не меняется." error={show(errors.code) ?? (codeTaken ? errors.code ?? undefined : undefined)}>
            {(control) => (
              <TextInput {...control} value={code} maxLength={63} spellCheck={false} autoComplete="off" disabled={pending} placeholder="anna" onChange={(event) => setCodeTyped(event.target.value.toLowerCase())} />
            )}
          </Field>
          <Field label="Telegram" error={show(errors.handle)}>
            {(control) => <TextInput {...control} value={handle} maxLength={65} spellCheck={false} autoComplete="off" disabled={pending} placeholder="@ник" onChange={(event) => setHandle(event.target.value)} />}
          </Field>
        </div>

        <div className="ui-field">
          <span className="ui-field__label">Роль</span>
          <Segmented label="Роль" value={role} onChange={setRole} options={ROLE_OPTIONS} />
          <p className="ui-field__hint">
            {withLogin
              ? "Получит вход в расширение и Workboard: ссылку на пароль вы отправите сами."
              : "Без входа в Hub: человек в реестре, со страницами и графиком, но расширение ему не нужно."}
          </p>
        </div>

        <fieldset disabled={pending} className="access-invite__pages">
          <legend className="ui-field__label">Рабочие страницы</legend>
          <p className="ui-field__hint registry-form__lead">Первая в списке: основная. {withLogin ? "Эти же страницы откроются входу." : ""}</p>
          {pages.isError ? (
            <Notice tone="warning" role="alert" action={<Button size="sm" disabled={pages.isFetching} onClick={() => void pages.refetch()}>Повторить</Button>}>Список страниц не загрузился.</Notice>
          ) : !pages.data ? <p className="access-hint"><Spinner /> Загружаем страницы…</p> : (
            <WorkingPagesPicker pages={pages.data} value={working} onChange={setWorking} disabled={pending} />
          )}
        </fieldset>

        <div className="ui-field">
          <span className="ui-field__label">График</span>
          <SlotFields idPrefix="invite-slot" value={slot} onChange={setSlot} disabled={pending} />
          {!slotEmpty(slot) && (
            <label className="registry-slot__time registry-form__from">
              <span className="ui-field__label">С даты</span>
              <TextInput type="date" value={from} disabled={pending} onChange={(event) => setFrom(event.target.value)} />
            </label>
          )}
          {show(errors.slot ?? errors.from) ? <p className="ui-field__error" role="alert">{errors.slot ?? errors.from}</p> : <p className="ui-field__hint">Можно оставить пустым и задать позже в карточке.</p>}
        </div>

        <Disclosure summary="Условия оплаты" hint={models.length === 0 ? "сначала выберите страницы" : "по моделям рабочих страниц, можно позже"}>
          {models.length === 0 ? <p className="access-hint">Условия задаются по модели: выберите рабочие страницы.</p> : (
            <div className="registry-terms-form">
              {models.map((model) => {
                const term = terms[model.slug] ?? { share: "", fix: "" };
                const set = (next: Partial<typeof term>) => setTerms((current) => ({ ...current, [model.slug]: { ...term, ...next } }));
                return (
                  <div key={model.slug} className="registry-terms-form__row">
                    <span className="registry-terms-form__model">{model.modelName}</span>
                    <label className="registry-slot__time">
                      <span className="ui-field__label">Доля, %</span>
                      <TextInput inputMode="decimal" value={term.share} disabled={pending} placeholder="25" onChange={(event) => set({ share: event.target.value })} />
                    </label>
                    <label className="registry-slot__time">
                      <span className="ui-field__label">Фикс за день со сменой, $</span>
                      <TextInput inputMode="decimal" value={term.fix} disabled={pending} placeholder="0" onChange={(event) => set({ fix: event.target.value })} />
                    </label>
                  </div>
                );
              })}
              <label className="registry-slot__time">
                <span className="ui-field__label">С даты</span>
                <TextInput type="date" value={from} disabled={pending} onChange={(event) => setFrom(event.target.value)} />
              </label>
              {show(errors.terms) && <p className="ui-field__error" role="alert">{errors.terms}</p>}
              <p className="access-hint">Видит только владелец. Пустая доля: условий по модели нет.</p>
            </div>
          )}
        </Disclosure>

        {withLogin && (
          <Disclosure summary="Дополнительно: логин и срок ссылки" hint={`${login || "логин"}, ${days} ${ruPlural(days, "день", "дня", "дней")}`}>
            <div className="access-invite__more">
              <Field label="Логин" hint="С ним человек входит в расширение и в Workboard. Пароль он придумает сам, открыв ссылку." error={show(errors.login) ?? (loginTaken ? errors.login ?? undefined : undefined)}>
                {(control) => <TextInput {...control} value={login} maxLength={100} spellCheck={false} autoComplete="off" disabled={pending} onChange={(event) => setLoginTyped(event.target.value)} />}
              </Field>
              <Field label="Срок ссылки, дней" error={show(errors.days)}>
                {(control) => <TextInput {...control} type="number" min={1} max={INVITE_MAX_DAYS} value={days} disabled={pending} onChange={(event) => setDays(Number(event.target.value))} className="access-invite__days" />}
              </Field>
            </div>
          </Disclosure>
        )}

        {problem && <Notice tone="danger" role="alert">{problem}</Notice>}
      </form>
    </Modal>
  );
}
