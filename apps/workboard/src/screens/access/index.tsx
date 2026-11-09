import { UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button, Disclosure, Drawer, EmptyState, ErrorState, Notice, Person, Section, SkeletonText, Table, type Column } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { ROLE_LABEL, teamStatus, type AccessRole } from "@agency_hub_core/ui/teamAccess";
import { PersonLink } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { InviteModal } from "./InviteModal";
import { LinkReveal, type RevealedLink } from "./LinkReveal";
import { AccessMatrix, personHint, personStatus } from "./Matrix";
import { PersonAccess } from "./PersonAccess";
import { useAccessPages, useAccessUsers, useCreateInvite, type AdminUser } from "./data";
import { usePageAccess } from "./pageAccess";
import { whenWords } from "./when";
import "./access.css";

/**
 * Доступ (spec §4.8): who is in the team and in what state, who works which
 * page (people × pages, by model), «Пригласить» — the one-call invite. A
 * person's links, devices and switching off open in a side panel
 * (`?person=`). The owner's only: Hub refuses the reads to anyone else.
 */

const ROLE_ORDER: Readonly<Record<string, number>> = { team_lead: 0, chatter: 1, owner: 2 };

function byRoleThenName(left: AdminUser, right: AdminUser): number {
  return (ROLE_ORDER[left.role] ?? 9) - (ROLE_ORDER[right.role] ?? 9) || left.username.localeCompare(right.username);
}

export function AccessScreen() {
  const { isOwner, isLoading: meLoading } = useMe();
  const users = useAccessUsers(isOwner);
  const pages = useAccessPages(isOwner);
  const [search, setSearch] = useSearchParams();
  const createInvite = useCreateInvite();
  const [inviting, setInviting] = useState(false);
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  const access = usePageAccess();
  // «Изменить в таблице» in a person's panel (Д-н1): the panel closes, the person's row comes into view and glows.
  const [flashId, setFlashId] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);
  const editInMatrix = (id: number) => {
    openPerson(null);
    setFlashId(id);
    window.requestAnimationFrame(() => document.getElementById(`access-row-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1800);
  };

  const personId = Number(search.get("person"));
  const openPerson = (id: number | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (id === null) next.delete("person");
    else next.set("person", String(id));
    return next;
  });

  if (!meLoading && !isOwner) {
    return (
      <>
        <ScreenHeader title="Доступ" />
        <div className="wb-content">
          <EmptyState title="Доступ — только для владельца">Приглашать людей, открывать страницы и отключать доступ может только владелец.</EmptyState>
        </div>
      </>
    );
  }

  const all = (users.data ?? []).filter((user) => !user.deletedAt);
  // The owner is not one of the team the matrix gives pages to (D11): the last row, out of «в команде».
  const owners = all.filter((user) => user.role === "owner" && teamStatus(user) === "active");
  const working = all.filter((user) => user.role !== "owner" && teamStatus(user) === "active").sort(byRoleThenName);
  const invited = all.filter((user) => teamStatus(user) === "invited").sort(byRoleThenName);
  const disabled = all.filter((user) => teamStatus(user) === "disabled").sort((left, right) => (right.disabledAt ?? "").localeCompare(left.disabledAt ?? ""));
  const selected = Number.isInteger(personId) && personId > 0 ? all.find((user) => user.id === personId) ?? null : null;

  const disabledColumns: Column<AdminUser>[] = [
    { key: "who", header: "Человек", cell: (row) => <Person name={row.username} status={personStatus(row)} hint={ROLE_LABEL[row.role as AccessRole] ?? row.role} /> },
    { key: "when", header: "Доступ отключён", width: 220, nowrap: true, cell: (row) => (row.disabledAt ? whenWords(row.disabledAt) : "—") },
    { key: "pages", header: "Сохранённые страницы", cell: (row) => (row.assignedPages.length === 0 ? <span className="text-ink-3">—</span> : row.assignedPages.map((page) => page.label).join(", ")) },
  ];

  return (
    <>
      <ScreenHeader
        title="Доступ"
        actions={<Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>Пригласить</Button>}
        meta={users.data ? (
          <>
            {working.length} в команде
            {invited.length > 0 && <> · {invited.length} {ruPlural(invited.length, "ждёт", "ждут", "ждут")} регистрации</>}
            {disabled.length > 0 && <> · {disabled.length} {ruPlural(disabled.length, "отключён", "отключены", "отключены")}</>}
          </>
        ) : <span />}
        updatedAt={users.dataUpdatedAt}
        onRefresh={() => {
          void users.refetch();
          void pages.refetch();
        }}
        refreshing={users.isFetching}
      />
      <div className="wb-content">
        {users.isError && users.data && <Notice tone="warning" role="alert" action={<Button size="sm" onClick={() => void users.refetch()}>Повторить</Button>}>Список людей не обновился: показан прежний.</Notice>}
        {!users.data || !pages.data ? (
          users.isError || pages.isError
            ? <ErrorState onRetry={() => { void users.refetch(); void pages.refetch(); }} retrying={users.isFetching || pages.isFetching} />
            : <div className="access-skeleton"><SkeletonText lines={8} /></div>
        ) : working.length + invited.length === 0 ? (
          <EmptyState title="В команде пока никого" action={<Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>Пригласить</Button>}>
            Пригласите первого человека: он получит ссылку и сам придумает пароль.
          </EmptyState>
        ) : (
          <Section
            title="Кто на каких страницах"
            description="Отметка открывает страницу сразу, снять — после вопроса."
          >
            <AccessMatrix
              groups={[
                { key: "working", title: "В команде", users: working },
                { key: "invited", title: "Ждут регистрации", users: invited },
              ]}
              owners={owners}
              pages={pages.data}
              access={access}
              selectedId={selected?.id ?? null}
              flashId={flashId}
              onOpenPerson={(id) => openPerson(id)}
            />
          </Section>
        )}

        {disabled.length > 0 && (
          <Disclosure size="md" summary="Отключённые" hint={String(disabled.length)} className="access-fold">
            <p className="access-text">Логины и история сохранены. Восстановить доступ можно в панели человека.</p>
            <Table
              label="Отключённые"
              skeletonLines={2}
              columns={disabledColumns}
              rows={disabled}
              rowKey={(row) => String(row.id)}
              onRowClick={(row) => openPerson(row.id)}
              selectedKey={selected ? String(selected.id) : null}
              rowQuiet={() => true}
            />
          </Disclosure>
        )}

        <Disclosure summary="Как это работает">
          <p>
            Страница в таблице — это то, что человек видит в расширении: её чаты и фанов. Имя открывает панель человека: ссылки,
            устройства, отключение. Отметка открывает страницу сразу, а промах можно
            отменить в сообщении внизу экрана; снять страницу или всю модель можно только после вопроса. «Вся» открывает или снимает все
            страницы модели по одной; если Hub откажет, остановимся и скажем, что успели. Владелец видит все страницы и без отметок.
          </p>
          <p>
            Пригласить — один шаг: Hub создаёт аккаунт, открывает выбранные страницы и даёт ссылку, по которой человек сам придумает пароль.
            Ссылку показываем один раз, вместе с готовым сообщением для Telegram.
          </p>
        </Disclosure>
      </div>

      {selected && (
        <Drawer
          open
          onClose={() => openPerson(null)}
          // The focus lands on the panel itself: a stray Space must not tick a page.
          initialFocus="box"
          title={<PersonLink userId={selected.id} name={selected.username} status={personStatus(selected)} tab="access" backLabel="Доступ" />}
          subtitle={personHint(selected)}
        >
          <PersonAccess userId={selected.id} variant="drawer" onDeleted={() => openPerson(null)} {...(selected.role !== "owner" && !selected.disabledAt ? { onEditInMatrix: () => editInMatrix(selected.id) } : {})} />
        </Drawer>
      )}

      {inviting && (
        <InviteModal
          create={createInvite}
          onClose={() => setInviting(false)}
          onCreated={(link) => {
            setInviting(false);
            setRevealed(link);
          }}
          onOpenExisting={(id) => {
            setInviting(false);
            openPerson(id);
          }}
        />
      )}
      {revealed && (
        <LinkReveal
          link={revealed}
          onClose={() => {
            // The secret leaves memory with the window.
            createInvite.reset();
            setRevealed(null);
          }}
        />
      )}
      {access.dialog}
    </>
  );
}
