import { ExternalLink, KeyRound, LogOut, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Card, Checkbox, Confirm, Disclosure, EmptyState, ErrorState, Modal, Money, Notice, PageLabels, SkeletonText, TextInput, toast, platformWord } from "@agency_hub_core/ui";
import {
  LINK_KIND_LABEL,
  REVOCATION_LABEL,
  deviceRevokedReasonLabel,
  linkStateLabel,
  restoreMessage,
  splitDevices,
  teamStatus,
} from "@agency_hub_core/ui/teamAccess";
import { consoleHref } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import {
  pagesByModel,
  useAccessPages,
  useAccessUsers,
  useAiLimit,
  useCreateLink,
  useDeactivate,
  useDeleteUser,
  useReactivate,
  useRevokeAllDevices,
  useRevokeDevice,
  useRevokeLink,
  useTerminateAccess,
  useUserDevices,
  useUserLinks,
  type AdminUser,
  type DeviceItem,
  type LinkItem,
} from "./data";
import { LinkReveal, type RevealedLink } from "./LinkReveal";
import { usePageAccess } from "./pageAccess";
import { whenWords } from "./when";
import "./access.css";

/**
 * One person's access (spec §4.4 «Доступ», §4.8): pages, sign-in links,
 * devices, the AI limit for reading, switching off — today's staff card
 * (apps/dashboard/src/pages/team/people/PersonPage.tsx), adapted to the
 * person's state: a pending invite offers «Отменить приглашение», a disabled
 * person «Восстановить доступ», the owner cannot be switched off. Every write is
 * the console's request with the console's words; questions are only added —
 * removing a page, ending a device's sign-in, a password reset link, revoking a
 * link — and deleting the account (the owner's stop list) sits at the very
 * bottom, folded, behind typing the login.
 */

export interface PersonAccessProps {
  userId: number;
  variant: "page" | "drawer";
  onChanged?: () => void;
  /** After the account is deleted: leave wherever the panel was. */
  onDeleted?: () => void;
  /** The side panel beside the matrix: close it and light the person's row there, where the pages are ticked (Д-н1). */
  onEditInMatrix?: () => void;
}

type Asking =
  | { kind: "revokeAllDevices" | "terminateAccess" | "deactivate" | "cancelInvite" | "reactivate" }
  | { kind: "device"; device: DeviceItem }
  | { kind: "link"; link: LinkItem }
  | { kind: "newLink"; linkKind: "invite" | "password_reset" }
  | { kind: "delete" };

const WORKS: ReadonlySet<string> = new Set(["chatter", "team_lead"]);

function Block({ title, aside, children, variant }: { title: ReactNode; aside?: ReactNode; children: ReactNode; variant: "page" | "drawer" }) {
  if (variant === "page") return <Card title={title} actions={aside}><div className="access-block__body">{children}</div></Card>;
  return (
    <section className="access-block">
      <header className="access-block__head">
        <h3 className="access-block__title">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function PersonAccess({ userId, variant, onChanged, onDeleted, onEditInMatrix }: PersonAccessProps) {
  const { isOwner, user: me } = useMe();
  const users = useAccessUsers(isOwner);
  const user = users.data?.find((one) => one.id === userId && !one.deletedAt) ?? null;
  if (!isOwner) {
    return <EmptyState title="Доступ видит только владелец" compact={variant === "drawer"}>Страницы, ссылки и устройства людей меняет владелец.</EmptyState>;
  }
  if (!users.data) {
    return users.isError
      ? <ErrorState onRetry={() => void users.refetch()} retrying={users.isFetching} compact={variant === "drawer"} />
      : <div className="access-panel"><SkeletonText lines={6} /></div>;
  }
  if (!user) {
    return <EmptyState title="Сотрудник больше недоступен" compact={variant === "drawer"}>Этот аккаунт удалён или больше не доступен.</EmptyState>;
  }
  return <PersonAccessBody key={user.id} user={user} variant={variant} meId={me?.id ?? null} onChanged={onChanged} onDeleted={onDeleted} onEditInMatrix={onEditInMatrix} />;
}

function PersonAccessBody({ user, variant, meId, onChanged, onDeleted, onEditInMatrix }: {
  user: AdminUser;
  variant: "page" | "drawer";
  meId: number | null;
  onChanged: (() => void) | undefined;
  onDeleted: (() => void) | undefined;
  onEditInMatrix: (() => void) | undefined;
}) {
  const status = teamStatus(user);
  const owner = user.role === "owner";
  const canDelete = !owner && meId !== null && meId !== user.id;
  // The link-minting mutation is the panel's: the panel stays while its question and the reveal are open.
  const createLink = useCreateLink();
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const pageAccess = usePageAccess(onChanged);

  const ask = (next: Asking) => setAsking(next);

  // The state first, its one way on under the words (a side panel is too narrow for a button beside them).
  const notice = status === "disabled" && user.disabledAt ? (
    <Notice
      tone="off"
      title={`Доступ отключён ${whenWords(user.disabledAt)}`}
      actionPlacement="below"
      action={<Button variant="primary" size="sm" icon={RotateCcw} onClick={() => ask({ kind: "reactivate" })}>Восстановить доступ</Button>}
    >
      Логин и история сохранены — восстановите доступ, если возвращается тот же человек.
    </Notice>
  ) : status === "invited" ? (
    // The invite's two ways on, side by side (З3): send it again, or call it off. The link itself only says how long it lives.
    <Notice
      title="Ждёт регистрации"
      actionPlacement="below"
      action={(
        <>
          <Button size="sm" onClick={() => ask({ kind: "newLink", linkKind: "invite" })}>Отправить заново</Button>
          <Button size="sm" variant="ghost" onClick={() => ask({ kind: "cancelInvite" })}>Отменить приглашение</Button>
        </>
      )}
    >
      Человек ещё не открыл приглашение и не придумал пароль, поэтому войти не может.
    </Notice>
  ) : null;

  const pages = <PagesBlock user={user} variant={variant} pageAccess={pageAccess} onEditInMatrix={onEditInMatrix} />;
  const links = <LinksBlock user={user} variant={variant} onAsk={ask} />;
  // Nothing to show for someone who never signed in or is switched off: their devices and AI limit stay out of the way.
  const devices = status === "invited" ? null : <DevicesBlock user={user} variant={variant} onAsk={ask} />;
  const limit = status === "active" ? <AiLimitBlock userId={user.id} variant={variant} /> : null;
  const end = <EndBlock user={user} variant={variant} canDelete={canDelete} busy={createLink.isPending} onAsk={ask} />;
  // On the tab, a short «Аккаунт» (only «Удалить навсегда» left: invited, disabled) fills a column's foot instead of a
  // full-width card for one fold; the active person's «Закрыть доступ» stays across, under everything.
  const shortEnd = status !== "active" && user.role !== "owner";

  return (
    <div className={variant === "page" ? "access-panel access-panel--page" : "access-panel"}>
      {notice}
      {variant === "page" ? (
        <div className="access-panel__grid">
          <div className="access-panel__col">{pages}{limit}{shortEnd && status === "disabled" && end}</div>
          <div className="access-panel__col">{links}{devices}{shortEnd && status !== "disabled" && end}</div>
        </div>
      ) : (
        <>{pages}{links}{devices}{limit}</>
      )}
      {(variant === "drawer" || !shortEnd) && end}

      {pageAccess.dialog}
      {asking && (
        <Question
          asking={asking}
          user={user}
          createLink={createLink}
          onClose={() => setAsking(null)}
          onLink={(link) => {
            setAsking(null);
            setRevealed(link);
          }}
          onChanged={onChanged}
          onDeleted={onDeleted}
        />
      )}
      {revealed && (
        <LinkReveal
          link={revealed}
          onClose={() => {
            // The secret leaves memory with the window.
            createLink.reset();
            setRevealed(null);
          }}
        />
      )}
    </div>
  );
}

// ── pages ────────────────────────────────────────────────────────────────────

function PagesBlock({ user, variant, pageAccess, onEditInMatrix }: {
  user: AdminUser;
  variant: "page" | "drawer";
  pageAccess: ReturnType<typeof usePageAccess>;
  onEditInMatrix: (() => void) | undefined;
}) {
  const all = useAccessPages();
  const assigned = new Set(user.assignedPages.map((page) => page.label));
  const count = user.assignedPages.length;
  const title = <>Страницы <span className="access-count">{count}</span></>;
  if (user.role === "owner") {
    // Hub gives the owner no page filter: ticks would change nothing (D11).
    return (
      <Block title="Страницы" variant={variant}>
        <p className="access-text">Владелец видит все страницы — назначать их не нужно.</p>
      </Block>
    );
  }
  if (user.disabledAt) {
    return (
      <Block title="Сохранённые страницы" variant={variant}>
        <p className="access-text">После восстановления доступа сотрудник снова сможет работать с этими страницами.</p>
        {count === 0 ? <p className="access-hint">Страниц пока нет.</p> : <PageLabels labels={user.assignedPages.map((page) => page.label)} max={6} className="access-pages-line" />}
      </Block>
    );
  }
  if (variant === "drawer") {
    // Beside the matrix the person's row is already in view: one line here, the ticks stay in the matrix (Д6).
    return (
      <Block
        title={title}
        variant={variant}
        aside={onEditInMatrix ? <button type="button" className="access-link access-link--button" onClick={onEditInMatrix}>Изменить в таблице</button> : undefined}
      >
        {count === 0 ? <p className="access-text">Ни одной страницы.</p> : <PageLabels labels={user.assignedPages.map((page) => page.label)} max={6} className="access-pages-line" />}
      </Block>
    );
  }
  if (!all.data) {
    return (
      <Block title={title} variant={variant}>
        {all.isError ? <ErrorState compact title="Список страниц не пришёл" onRetry={() => void all.refetch()} retrying={all.isFetching} /> : <SkeletonText lines={4} />}
      </Block>
    );
  }
  return (
    <Block title={title} variant={variant}>
      <div className="access-pages">
        {pagesByModel(all.data).map((model) => {
          const picked = model.pages.filter((page) => assigned.has(page.label)).length;
          const busy = model.pages.some((page) => pageAccess.busy(user.id, page.label));
          return (
            <div key={model.modelSlug} className="access-pages__model">
              {model.pages.length > 1 ? (
                <Checkbox
                  className="access-pages__name"
                  label={<span className="access-words">{model.modelName}<span className="access-hint">вся модель</span></span>}
                  checked={picked === model.pages.length}
                  indeterminate={picked > 0}
                  disabled={busy}
                  onChange={() => pageAccess.toggleModel(user, model, assigned)}
                />
              ) : <span className="access-pages__name access-pages__name--single">{model.modelName}</span>}
              <div className="access-pages__list">
                {model.pages.map((page) => (
                  <Checkbox
                    key={page.label}
                    label={<span className="access-words">{page.label}<span className="access-hint">{platformWord(page.platform) ?? page.platform}</span></span>}
                    checked={assigned.has(page.label)}
                    disabled={pageAccess.busy(user.id, page.label)}
                    onChange={() => pageAccess.toggle(user, page, assigned.has(page.label))}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Block>
  );
}

// ── links ────────────────────────────────────────────────────────────────────

function LinksBlock({ user, variant, onAsk }: { user: AdminUser; variant: "page" | "drawer"; onAsk: (asking: Asking) => void }) {
  const links = useUserLinks(user.id);
  const status = teamStatus(user);
  const disabled = status === "disabled";
  const active = (links.data ?? []).filter((link) => link.state === "active");
  const history = (links.data ?? []).filter((link) => link.state !== "active");
  const reset = status === "active" && WORKS.has(user.role) ? { kind: "password_reset" as const, label: "Сбросить пароль ссылкой" } : null;
  return (
    <Block
      title="Вход по ссылке"
      variant={variant}
      aside={!disabled && reset ? <Button size="sm" icon={KeyRound} onClick={() => onAsk({ kind: "newLink", linkKind: reset.kind })}>{reset.label}</Button> : undefined}
    >
      {links.isError && <Notice tone="warning">{links.data ? "История ссылок не обновилась" : "История ссылок недоступна"}</Notice>}
      {links.isLoading && !links.data && <SkeletonText lines={2} />}
      {links.data && active.length === 0 && !disabled && (
        <p className="access-text">
          {status === "invited" ? "Действующей ссылки нет: отправьте приглашение заново." : status === "active" ? "Действующих ссылок нет. Пароль задан — человек входит сам." : "Действующих ссылок нет."}
        </p>
      )}
      {active.length > 0 && (
        <ul className="access-list">
          {active.map((link) => (
            <li key={link.id} className="access-list__row">
              <span className="access-list__main">
                {LINK_KIND_LABEL[link.kind]}
                <span className="access-hint">{linkStateLabel(link, whenWords)} · создана {whenWords(link.createdAt)}</span>
              </span>
              {/* An invite's link too, as the console had it: the link stops working, the person stays invited («Отправить заново» makes a new one). */}
              {!disabled && <Button size="sm" variant="ghost" onClick={() => onAsk({ kind: "link", link })}>Отозвать ссылку</Button>}
            </li>
          ))}
        </ul>
      )}
      {disabled && <p className="access-text">Действующих ссылок нет. Новые можно создать после восстановления доступа.</p>}
      {history.length > 0 && (
        <Disclosure summary="История ссылок" hint={String(history.length)}>
          <ul className="access-list access-list--quiet">
            {history.map((link) => (
              <li key={link.id} className="access-list__row">
                <span className="access-list__main">
                  {LINK_KIND_LABEL[link.kind]}
                  <span className="access-hint">{linkStateLabel(link, whenWords)} · создана {whenWords(link.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Block>
  );
}

// ── devices ──────────────────────────────────────────────────────────────────

function DevicesBlock({ user, variant, onAsk }: { user: AdminUser; variant: "page" | "drawer"; onAsk: (asking: Asking) => void }) {
  const devices = useUserDevices(user.id);
  const { active, history } = splitDevices(devices.data ?? []);
  return (
    <Block title={<>Устройства <span className="access-count">{active.length}</span></>} variant={variant}>
      {devices.isError && <Notice tone="warning">{devices.data ? "Список устройств не обновился" : "Список устройств недоступен"}</Notice>}
      {devices.isLoading && !devices.data && <SkeletonText lines={2} />}
      {devices.data && active.length === 0 && <p className="access-text">Сейчас ни одного входа.</p>}
      {active.length > 0 && (
        <ul className="access-list access-list--hover">
          {active.map((device) => (
            <li key={device.id} className="access-list__row">
              <span className="access-list__main">
                {device.label}
                <span className="access-hint">
                  {device.lastUsedAt ? `вход использован ${whenWords(device.lastUsedAt)}` : "ещё ни разу не использовался"}
                  {device.lastClientVersion && ` · версия ${device.lastClientVersion}`}
                </span>
              </span>
              {/* On hover and focus of its row only: no column of identical buttons (Д3). */}
              <Button className="access-on-hover" size="sm" variant="ghost" icon={LogOut} aria-label={`${REVOCATION_LABEL.device}: ${device.label}`} onClick={() => onAsk({ kind: "device", device })}>Завершить вход</Button>
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <Disclosure summary="Завершённые входы" hint={String(history.length)}>
          <ul className="access-list access-list--quiet">
            {history.map((device) => (
              <li key={device.id} className="access-list__row">
                <span className="access-list__main">
                  {device.label}
                  <span className="access-hint">
                    {deviceRevokedReasonLabel(device.revokedReason) ?? (device.revokedAt ? "вход завершён" : "срок истёк")} · {whenWords(device.revokedAt ?? device.expiresAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Block>
  );
}

// ── the AI limit, read only ──────────────────────────────────────────────────

function AiLimitBlock({ userId, variant }: { userId: number; variant: "page" | "drawer" }) {
  const limit = useAiLimit(userId);
  return (
    <Block title="Лимит ИИ на день" variant={variant} aside={<a className="access-link" href={consoleHref("/settings/ai/limits")} target="_blank" rel="noopener">Изменить в консоли <ExternalLink size={14} strokeWidth={1.75} aria-label="откроется консоль" /></a>}>
      {limit.isLoading && !limit.data ? <SkeletonText lines={1} /> : !limit.data ? (
        <ErrorState compact onRetry={() => void limit.refetch()} retrying={limit.isFetching} />
      ) : !limit.data.row ? (
        <p className="access-text">Лимита и трат ИИ сегодня нет.</p>
      ) : limit.data.row.dailyLimitMicroUsd === null ? (
        <p className="access-text">Личного лимита нет, сегодня потрачено <Money microUsd={limit.data.row.spentMicroUsd} /></p>
      ) : (
        <p className="access-text"><Money microUsd={limit.data.row.dailyLimitMicroUsd} strong /> в день, сегодня потрачено <Money microUsd={limit.data.row.spentMicroUsd} /></p>
      )}
    </Block>
  );
}

// ── switching off ────────────────────────────────────────────────────────────

function EndBlock({ user, variant, canDelete, busy, onAsk }: { user: AdminUser; variant: "page" | "drawer"; canDelete: boolean; busy: boolean; onAsk: (asking: Asking) => void }) {
  const status = teamStatus(user);
  const owner = user.role === "owner";
  const disabled = status === "disabled";
  const others = [
    status === "active" && {
      key: "revokeAll",
      text: "Расширение и приложение на всех устройствах попросят войти заново. Консоль и пароль не затрагиваются.",
      label: REVOCATION_LABEL.allDevices,
      kind: "revokeAllDevices" as const,
    },
    status === "active" && !owner && {
      key: "terminate",
      text: "Завершатся входы на всех устройствах, в консоли и все ссылки. Пароль продолжит работать.",
      label: REVOCATION_LABEL.allAccess,
      kind: "terminateAccess" as const,
    },
  ].filter((row) => row !== false);
  // An invite or a switched-off person keeps only «Удалить навсегда» here: without it, no block at all.
  if (!owner && status !== "active" && !canDelete) return null;
  return (
    <Block title={disabled || status === "invited" ? "Аккаунт" : "Закрыть доступ"} variant={variant}>
      {owner && (
        <p className="access-text">
          Владельца нельзя деактивировать и нельзя завершить все его входы — иначе консоль осталась бы без хозяина. Пароль владелец меняет сам.
        </p>
      )}
      {/* An invite is called off in its notice above (З3): here only the account itself. */}
      {!owner && status === "active" && (
        <div className="access-end">
          <p className="access-text">Все входы и ссылки перестанут работать. Логин, история, роль и страницы сохранятся, доступ можно будет восстановить.</p>
          <Button variant="danger-outline" onClick={() => onAsk({ kind: "deactivate" })}>Отключить доступ</Button>
        </div>
      )}
      {others.length > 0 && (
        <Disclosure summary="Другие способы завершить доступ">
          <ul className="access-list">
            {others.map((row) => (
              <li key={row.key} className="access-list__row">
                <span className="access-list__main access-list__main--text">{row.text}</span>
                <Button size="sm" onClick={() => onAsk({ kind: row.kind })}>{row.label}</Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {canDelete && (
        <Disclosure summary="Удалить аккаунт навсегда" className="access-delete">
          <div className="access-end">
            <p className="access-text">Необратимо, логин освободится. История работы сохранится за прежним сотрудником. Обычно достаточно отключить доступ.</p>
            <Button variant="danger-outline" size="sm" disabled={busy} onClick={() => onAsk({ kind: "delete" })}>Удалить аккаунт…</Button>
          </div>
        </Disclosure>
      )}
    </Block>
  );
}

// ── the questions ────────────────────────────────────────────────────────────

/** The console's failures, word for word (PersonPage.tsx:425-431, :174-178, :248-256). */
const FAILURE = {
  revokeAllDevices: "Не удалось отозвать устройства: Hub вернул ошибку.",
  terminateAccess: "Не удалось завершить входы: Hub вернул ошибку.",
  deactivate: "Не удалось отключить доступ: Hub вернул ошибку.",
  cancelInvite: "Не удалось отключить доступ: Hub вернул ошибку.",
  reactivate: "Не удалось восстановить доступ: Hub вернул ошибку.",
  delete: "Не удалось подтвердить удаление. Проверьте состояние сотрудника в списке.",
  device: "Не удалось завершить вход: Hub вернул ошибку.",
  link: "Не удалось отозвать ссылку: Hub вернул ошибку.",
  newLink: "Не удалось создать ссылку: Hub вернул ошибку.",
} as const;

function Question({ asking, user, createLink, onClose, onLink, onChanged, onDeleted }: {
  asking: Asking;
  user: AdminUser;
  createLink: ReturnType<typeof useCreateLink>;
  onClose: () => void;
  onLink: (link: RevealedLink) => void;
  onChanged: (() => void) | undefined;
  onDeleted: (() => void) | undefined;
}) {
  const name = user.username;
  const revokeAllDevices = useRevokeAllDevices(user.id);
  const terminateAccess = useTerminateAccess(user.id);
  const deactivate = useDeactivate(user.id);
  const reactivate = useReactivate(user.id);
  const revokeDevice = useRevokeDevice(user.id);
  const revokeLink = useRevokeLink(user.id);
  const [problem, setProblem] = useState<string | null>(null);

  if (asking.kind === "delete") {
    return <DeleteQuestion user={user} onClose={onClose} onDeleted={() => { onChanged?.(); onDeleted?.(); }} />;
  }

  const spec = (() => {
    switch (asking.kind) {
      case "revokeAllDevices":
        return {
          title: `${REVOCATION_LABEL.allDevices} — ${name}?`,
          message: "Расширение и приложение на всех устройствах перестанут работать и попросят войти заново. Вход в консоль и пароль не затрагиваются.",
          confirmLabel: "Отозвать",
          pending: revokeAllDevices.isPending,
          run: async () => {
            const result = await revokeAllDevices.mutateAsync();
            toast.success(result.revokedCount > 0 ? `Устройства отозваны: ${result.revokedCount}` : "Отзывать было нечего");
          },
        };
      case "terminateAccess":
        return {
          title: `${REVOCATION_LABEL.allAccess} — ${name}?`,
          message: "Завершатся входы на всех устройствах, вход в консоль и все действующие ссылки. Человек останется в команде и сможет войти заново со своим паролем.",
          confirmLabel: "Завершить",
          pending: terminateAccess.isPending,
          run: async () => {
            await terminateAccess.mutateAsync();
            toast.success(`Все входы ${name} завершены`);
          },
        };
      case "deactivate":
      case "cancelInvite":
        return {
          title: asking.kind === "cancelInvite" ? `Отменить приглашение ${name}?` : `Отключить доступ ${name}?`,
          message: asking.kind === "cancelInvite"
            ? "Ссылка-приглашение перестанет работать, человек перейдёт в «Отключённые». Логин (он останется занят), роль и страницы сохранятся — доступ можно будет восстановить."
            : "Все входы и ссылки перестанут работать, сотрудник перейдёт в «Отключённые». Логин (он останется занят), история, роль и страницы сохранятся — доступ можно будет восстановить.",
          confirmLabel: asking.kind === "cancelInvite" ? "Отменить приглашение" : "Отключить доступ",
          pending: deactivate.isPending,
          run: async () => {
            await deactivate.mutateAsync();
            toast.success(asking.kind === "cancelInvite" ? `Приглашение ${name} отменено` : `Доступ ${name} отключён`);
            onChanged?.();
          },
        };
      case "reactivate":
        return {
          title: `Восстановить доступ ${name}?`,
          message: restoreMessage(user),
          confirmLabel: "Восстановить доступ",
          tone: "primary" as const,
          pending: reactivate.isPending,
          run: async () => {
            await reactivate.mutateAsync();
            toast.success(`${name} снова в команде`);
            onChanged?.();
          },
        };
      case "device":
        return {
          title: `${REVOCATION_LABEL.device} — ${name}?`,
          message: `Расширение или приложение на этом устройстве у ${name} попросит войти заново. Другие устройства, консоль и пароль не затрагиваются.`,
          facts: [
            { label: "Кого", value: name },
            { label: "Устройство", value: `${asking.device.label}${asking.device.lastUsedAt ? `, вход использован ${whenWords(asking.device.lastUsedAt)}` : ""}` },
          ],
          confirmLabel: "Завершить вход",
          pending: revokeDevice.isPending,
          run: async () => {
            await revokeDevice.mutateAsync(asking.device.id);
            toast.success(`Вход на «${asking.device.label}» завершён`);
          },
        };
      case "link":
        return {
          title: `Отозвать ссылку — ${name}?`,
          message: user.registrationState === "invited"
            ? "Ссылка перестанет открываться. Пароль ещё не задан: войти человек не сможет, пока вы не создадите новое приглашение."
            : "Ссылка перестанет открываться. Пароль и входы на устройствах не затрагиваются.",
          facts: [{ label: "Ссылка", value: `${LINK_KIND_LABEL[asking.link.kind]}, ${linkStateLabel(asking.link, whenWords)}` }],
          confirmLabel: "Отозвать ссылку",
          pending: revokeLink.isPending,
          run: async () => {
            await revokeLink.mutateAsync(asking.link.id);
            toast.success("Ссылка отозвана");
          },
        };
      case "newLink":
        return {
          title: asking.linkKind === "invite" ? `Отправить приглашение ${name} заново?` : `Сбросить пароль ${name} ссылкой?`,
          message: "Новая ссылка отменяет прежнюю. Когда человек задаст пароль, все прежние входы завершатся.",
          facts: [
            { label: "Кому", value: name },
            { label: "Что дальше", value: "Hub создаст ссылку и покажет её один раз — с готовым сообщением для Telegram." },
          ],
          confirmLabel: asking.linkKind === "invite" ? "Создать приглашение" : "Создать ссылку",
          tone: "primary" as const,
          pending: createLink.isPending,
          run: async () => {
            const link = await createLink.mutateAsync({ userId: user.id, kind: asking.linkKind });
            onLink({ userId: user.id, username: name, kind: link.kind, secret: link.token, expiresAt: link.expiresAt });
          },
        };
    }
  })();

  return (
    <Confirm
      title={spec.title}
      message={spec.message}
      {...("facts" in spec ? { facts: spec.facts } : {})}
      confirmLabel={spec.confirmLabel}
      pendingLabel={asking.kind === "newLink" ? "Создаём…" : "Записываем…"}
      tone={"tone" in spec ? spec.tone : "danger"}
      error={problem ?? undefined}
      isPending={spec.pending}
      onConfirm={() => {
        if (spec.pending) return;
        setProblem(null);
        spec.run().then(() => {
          if (asking.kind !== "newLink") onClose();
        }, () => setProblem(FAILURE[asking.kind]));
      }}
      onClose={() => {
        if (!spec.pending) onClose();
      }}
    />
  );
}

/**
 * Deleting an account: the owner's stop list. The console's question and
 * words, and one more step — the login typed by hand — so a slip of the hand
 * cannot do it.
 */
function DeleteQuestion({ user, onClose, onDeleted }: { user: AdminUser; onClose: () => void; onDeleted: () => void }) {
  const remove = useDeleteUser(user.id);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const matches = typed.trim() === user.username;
  const close = () => {
    if (!remove.isPending) onClose();
  };
  return (
    <Modal
      title={`Удалить аккаунт ${user.username}?`}
      onClose={close}
      size="confirm"
      explicitCloseOnly={remove.isPending}
      actions={problem ? <Button onClick={close}>Закрыть</Button> : (
        <>
          <Button disabled={remove.isPending} onClick={close}>Отмена</Button>
          <Button
            variant="danger"
            disabled={!matches}
            loading={remove.isPending}
            onClick={() => {
              if (!matches || remove.isPending) return;
              remove.mutateAsync().then(() => {
                toast.success(`Аккаунт ${user.username} удалён`);
                onClose();
                onDeleted();
              }, () => setProblem("Не удалось подтвердить удаление. Проверьте состояние сотрудника в списке."));
            }}
          >
            {remove.isPending ? "Удаляем…" : "Удалить навсегда"}
          </Button>
        </>
      )}
    >
      <p className="ui-modal__text">
        Все его входы, ссылки и доступ к страницам будут отозваны, аккаунт удалится без возможности восстановления. Логин освободится — новый
        сотрудник с этим логином получит отдельный аккаунт, а история работы и финансовые записи останутся за прежним сотрудником.
      </p>
      <div className="ui-field">
        <label className="ui-field__label" htmlFor="access-delete-login">Чтобы подтвердить, введите логин <b>{user.username}</b></label>
        <TextInput ref={input} id="access-delete-login" value={typed} autoComplete="off" spellCheck={false} disabled={remove.isPending} onChange={(event) => setTyped(event.target.value)} />
      </div>
      {problem && <Notice tone="danger" role="alert">{problem}</Notice>}
    </Modal>
  );
}

