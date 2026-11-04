import { Link, useNavigate } from "react-router";
import type { AssignedPage } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useAdminVerifyPage } from "@/api/queries";
import { RowMenu, type RowMenuItem } from "@/components/ui/RowMenu";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { buildPageCollectionRoute, buildPageRoute, buildPageSectionRoute } from "@/lib/navigation";
import { platformName } from "@/lib/platformUrls";
import { errorCode, errorStatus, toastError } from "../settingsFeedback.js";
import type { PageCollection } from "./pageCollection.js";

export interface PageWorker {
  userId: number;
  username: string;
  invited: boolean;
}

const SHOWN_WORKERS = 3;

/** «Кто работает»: up to three chatters with the page, the rest as «ещё N». */
function Workers({ workers }: { workers: readonly PageWorker[] | null }) {
  if (workers === null) return <span className="muted">—</span>;
  if (workers.length === 0) return <span className="muted">—</span>;
  const shown = workers.slice(0, SHOWN_WORKERS);
  const rest = workers.length - shown.length;
  return (
    <span className="settings-workers">
      {shown.map((worker, index) => (
        <span key={worker.userId}>
          <Link to={`/team/people/${worker.userId}`} className={`settings-link ${worker.invited ? "text-text-secondary" : ""}`}>
            {worker.username}
          </Link>
          {worker.invited && <span className="text-text-secondary"> (приглашён)</span>}
          {index < shown.length - 1 || rest > 0 ? ", " : ""}
        </span>
      ))}
      {rest > 0 && <Link to="/team/people" className="settings-link text-text-secondary">ещё {rest}</Link>}
    </span>
  );
}

/**
 * One page of a model's card. The target of every action is this row's page:
 * the path's `pageLabel` comes from the row, never from the page filter.
 */
export function PageRow({
  page,
  collection,
  workers,
  editDisabled,
  highlighted,
  onEdit,
  onDelete,
}: {
  page: AssignedPage;
  collection: PageCollection;
  workers: readonly PageWorker[] | null;
  editDisabled: boolean;
  highlighted: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const verifyPage = useAdminVerifyPage(page.label);
  const navigate = useNavigate();
  const handle = page.username ?? page.displayName;

  async function handleVerify() {
    try {
      const result = await verifyPage.mutateAsync();
      if (result.verified) {
        if (result.syncUnblocked === false) {
          toast.warning(`${page.label}: вход подтверждён, но сбор всё ещё остановлен. Подробности в «Сборе данных страницы».`);
        } else {
          toast.success(`${page.label}: вход подтверждён${result.username ? `, @${result.username}` : ""}`);
        }
      } else {
        toastError(`${page.label}: вход не подтверждён`);
      }
    } catch (error) {
      const code = errorCode(error);
      if (errorStatus(error) === 409 && code === "fansly_sync_work_queued") toastError(`${page.label}: проверка ещё в очереди. Посмотрите «Сбор данных страницы» через минуту.`);
      else if (errorStatus(error) === 409 && code === "fansly_page_switching") toastError(`${page.label} сейчас переключается, проверка не запущена.`);
      else if (errorStatus(error) === 409 && code === "legacy_sync_retired") toastError(`${page.label} не читается новым сбором, проверка не запущена.`);
      else toastError("Проверка не удалась");
    }
  }

  const loginRoute = buildPageSectionRoute(page.label, "browser-login");
  const collectionRoute = buildPageCollectionRoute(page.label);
  const menu: RowMenuItem[] = [];
  if (page.platform === "fansly") {
    if (collection.action !== "login") menu.push({ label: "Войти в Fansly", onSelect: () => navigate(loginRoute) });
    menu.push({ label: verifyPage.isPending ? "Проверяем…" : "Проверить вход", onSelect: () => void handleVerify(), disabled: verifyPage.isPending });
  }
  if (page.platform !== "telegram" && collection.action !== "collection") {
    menu.push({ label: "Сбор данных страницы", onSelect: () => navigate(collectionRoute) });
  }
  menu.push({
    label: "Изменить",
    onSelect: onEdit,
    disabled: editDisabled,
    hint: editDisabled ? "Список моделей не загрузился" : undefined,
  });
  menu.push({ label: "Отключить страницу", onSelect: onDelete, danger: true });

  return (
    <tr id={`page-${page.label}`} className={highlighted ? "settings-row-flash" : undefined}>
      <td>
        <Link to={buildPageRoute(page.label)} className="settings-link font-medium">{page.label}</Link>
        <div className="settings-second">{handle ? `@${handle} · ` : ""}{platformName(page.platform)}</div>
      </td>
      <td className="status-col">
        {collection.word === null ? (
          <Skeleton width={96} />
        ) : (
          <>
            <StatusBadge status={collection.word} />
            {collection.detail && <div className="settings-second" title={collection.detailTitle}>{collection.detail}</div>}
          </>
        )}
      </td>
      <td><Workers workers={workers} /></td>
      <td>
        <div className="settings-actions">
          {collection.action === "login" && <Link to={loginRoute} className="btn btn-sm">Войти в Fansly</Link>}
          {collection.action === "collection" && <Link to={collectionRoute} className="btn btn-sm">Сбор данных страницы</Link>}
          <RowMenu label={`Действия со страницей ${page.label}`} items={menu} />
        </div>
      </td>
    </tr>
  );
}
