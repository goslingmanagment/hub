import { Link } from "react-router";
import { useAdminOfapiWebhookStatus } from "@/api/queries";
import { buildPageSectionRoute } from "@/lib/navigation";
import type { OfapiStatus } from "@/lib/statusWords";

interface Place {
  what: string;
  /** «Откуда сейчас» while the API is off. */
  now: string;
  where: { label: string; to: string } | "promo";
}

const PLACES: readonly Place[] = [
  { what: "Доход и операции страниц OnlyFans", now: "Лента ChatSpace", where: { label: "Операции", to: "/money/transactions" } },
  { what: "Переписка, подписки замеченных фанов, траты фанов", now: "Лента ChatSpace", where: { label: "Фаны", to: "/fans" } },
  { what: "Смены, продажи, споры, кастомы, проверка отправок", now: "Расширение и лента", where: { label: "Команда", to: "/team/shifts" } },
  { what: "Число платных и бесплатных подписок страницы", now: "По 1 ноября", where: { label: "Подписчики", to: "/fans/subscribers" } },
  { what: "Кредиты, баланс, журнал операций", now: "По 1 ноября", where: { label: "Расходы → OnlyFans API", to: "/money/costs/onlyfans-api" } },
  { what: "Ссылки OnlyFans", now: "По 1 ноября", where: "promo" },
  { what: "Медиатека OnlyFans", now: "По 1 ноября", where: { label: "Медиа", to: "/system/onlyfans-api/media" } },
  { what: "Выгрузки, посетители профиля", now: "По 1 ноября", where: { label: "Выгрузки", to: "/system/onlyfans-api/exports" } },
  { what: "Сохранённые ответы, события, словарь", now: "По 1 ноября", where: { label: "События и ключ", to: "/system/onlyfans-api/tools" } },
  { what: "Что и как часто собирал Hub", now: "Настройки сохранены", where: { label: "Правила сбора", to: "/system/onlyfans-api/collection" } },
  { what: "Действия с аккаунтом", now: "Не выполняются", where: { label: "Действия с аккаунтом", to: "/system/onlyfans-api/actions" } },
  { what: "Расписание OnlyFans", now: "Скрыто", where: { label: "Публикации", to: "/publications" } },
  { what: "Состояние сбора страниц", now: "Серое «Выключено с 1 ноября»", where: { label: "Сбор данных", to: "/system/collection" } },
  { what: "Старые сбои OnlyFans API", now: "Серая группа", where: { label: "Сбои", to: "/system/failures" } },
  { what: "Заявки OnlyFans на историю", now: "«Одобрить» отключено", where: { label: "Заявки на историю", to: "/system/history-requests" } },
];

/** «Где что лежит»: a fixed table, not a read (design/screens/system.md §8, block 2). */
export function WhereItLives({ ofapi }: { ofapi: OfapiStatus }) {
  const webhook = useAdminOfapiWebhookStatus();
  const promoPages = (webhook.data?.pages ?? []).map((page) => page.label);
  const showNow = ofapi !== "on";
  return (
    <section className="card" aria-labelledby="where-heading">
      <div className="card-header">
        <h2 id="where-heading" className="card-title">Где что лежит</h2>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Что</th>
              {showNow && <th>Откуда сейчас</th>}
              <th>Где смотреть</th>
            </tr>
          </thead>
          <tbody>
            {PLACES.map((place) => (
              <tr key={place.what}>
                <td>{place.what}</td>
                {showNow && <td className="muted">{place.now}</td>}
                <td>
                  {place.where === "promo" ? (
                    promoPages.length === 0
                      ? <span className="text-text-secondary">Продвижение страницы</span>
                      : (
                        <span className="sys-inline-links">
                          {promoPages.map((label) => (
                            <Link key={label} className="link" to={buildPageSectionRoute(label, "promo")}>Продвижение {label}</Link>
                          ))}
                        </span>
                      )
                  ) : (
                    <Link className="link" to={place.where.to}>{place.where.label}</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
