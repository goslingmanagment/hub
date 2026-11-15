import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { LearnPageMeta } from "@agency_hub_core/contracts";
import { EmptyState, ErrorState, Markdown, Skeleton, Switch, toast } from "@agency_hub_core/ui";
import { formatDay } from "@agency_hub_core/ui/format";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { learnPagesQuery } from "@/shared/learn";
import { kernel } from "@/shared/hub";
import "./learn.css";

/**
 * «Обучение» (products plan §2.3): the pages an agent publishes from /OS for the chat team (a chatter's job description,
 * the SOPs) through the agent-reports door, section `learn`. Anyone reads the ones the owner approved; the owner sees
 * every page and approves each («Показывать команде»). Nothing is written here but the owner's approval: the agent
 * publishes, Hub keeps.
 */

function PageRow({ page, canApprove }: { page: LearnPageMeta; canApprove: boolean }) {
  const queryClient = useQueryClient();
  const approve = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (approved: boolean) => kernel.learnPageApprove({ params: { slug: page.slug }, body: { approved } }),
    onSuccess: (_answer, approved) => {
      toast.success(approved ? "Команда видит эту страницу" : "Страница скрыта от команды");
      void queryClient.invalidateQueries({ queryKey: ["learn"] });
    },
    onError: () => toast.error("Не получилось. Попробуйте ещё раз"),
  });
  return (
    <li className="learn-row">
      <Link to={`/learn/${page.slug}`} className="learn-row__title">{page.title}</Link>
      <span className="learn-row__meta">
        обновлено {formatDay(page.publishedAt)}{page.version > 1 ? `, версия ${page.version}` : ""}
        {canApprove && !page.approved ? " · команда пока не видит" : ""}
      </span>
      {canApprove && (
        <Switch
          checked={page.approved}
          pending={approve.isPending}
          onChange={(value) => approve.mutate(value)}
          label="Показывать команде"
          className="learn-row__switch"
        />
      )}
    </li>
  );
}

export function LearnScreen() {
  const { narrow, accountRole } = useMe();
  const read = useQuery(learnPagesQuery());
  const pages = read.data?.pages ?? [];
  const canApprove = read.data?.canApprove ?? false;
  let body;
  if (read.isPending) {
    body = <div className="learn-list" aria-busy>{[0, 1, 2].map((key) => <Skeleton key={key} width="60%" />)}</div>;
  } else if (read.isError) {
    body = <ErrorState onRetry={() => void read.refetch()} retrying={read.isFetching} />;
  } else if (pages.length === 0) {
    body = canApprove ? (
      <EmptyState title="Страниц для обучения пока нет">
        Их публикует агент из базы знаний: инструкция чаттера, правила работы. Когда опубликует, они появятся здесь, и вы
        решите, какие показывать команде.
      </EmptyState>
    ) : (
      <EmptyState title="Обучения пока нет">
        Здесь появятся инструкции и правила работы, когда владелец их одобрит.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {canApprove && <p className="learn-lead">Команда видит только страницы с включённым «Показывать команде».</p>}
        {/* The owner in a session opened from the extension reads; approving needs the password. */}
        {narrow && accountRole === "owner" && <PasswordWayIn text="Чтобы показывать страницы команде, войдите на сайте с паролем." />}
        <ul className="learn-list">{pages.map((page) => <PageRow key={page.slug} page={page} canApprove={canApprove} />)}</ul>
      </>
    );
  }
  return (
    <>
      <ScreenHeader title="Обучение" updatedAt={read.dataUpdatedAt} onRefresh={() => void read.refetch()} refreshing={read.isFetching} stale={read.isRefetchError} />
      <div className="wb-content">{body}</div>
    </>
  );
}

export function LearnPageScreen() {
  const { slug = "" } = useParams();
  const read = useQuery({
    queryKey: ["learn", "page", slug],
    queryFn: () => kernel.learnPage({ params: { slug } }),
    meta: { suppressGlobalError: true },
    retry: false,
  });
  const page = read.data?.page ?? null;
  return (
    <>
      <ScreenHeader title={page?.title ?? "Обучение"} back={{ to: "/learn", label: "Обучение" }} />
      <div className="wb-content">
        {read.isPending && <div className="learn-list" aria-busy><Skeleton width="70%" /><Skeleton width="90%" /><Skeleton width="80%" /></div>}
        {read.isError && (
          <EmptyState title="Такой страницы нет">Её убрали или ещё не показали команде.</EmptyState>
        )}
        {page && (
          <article className="learn-page wb-readable">
            <p className="learn-row__meta">
              обновлено {formatDay(page.publishedAt)}{page.version > 1 ? `, версия ${page.version}` : ""}
              {read.data?.canApprove && !page.approved ? " · команда пока не видит" : ""}
            </p>
            <Markdown source={page.body} headingLevel={2} />
          </article>
        )}
      </div>
    </>
  );
}
