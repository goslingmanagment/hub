import { Check, Minus, Plus } from "lucide-react";
import { Person, Spinner, type PersonStatus } from "@agency_hub_core/ui";
import { formatAgo } from "@agency_hub_core/ui/format";
import { ROLE_LABEL, teamStatus, type AccessRole } from "@agency_hub_core/ui/teamAccess";
import { pagesByModel, type AdminPage, type AdminUser } from "./data";
import type { PageAccess } from "./pageAccess";

/**
 * Кто на каких страницах: people × pages in one place, the pages under their
 * models with «вся модель» where a model has more than one page. A cell opens
 * a page at once or asks before removing it (pageAccess.tsx); a person's name
 * opens their panel (links, devices, switching off).
 */

const PLATFORM: Readonly<Record<string, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

export function personStatus(user: AdminUser): PersonStatus {
  const status = teamStatus(user);
  return status === "disabled" ? "disabled" : status === "invited" ? "invited" : "away";
}

/** «Чаттер · был 3 ч назад», «Тимлид · ещё не входил». */
export function personHint(user: AdminUser): string {
  const role = ROLE_LABEL[user.role as AccessRole] ?? user.role;
  if (user.disabledAt) return `${role} · отключён ${formatAgo(user.disabledAt)}`;
  if (user.registrationState === "invited") return `${role} · ждёт регистрации`;
  return `${role} · ${user.lastActiveAt ? `был ${formatAgo(user.lastActiveAt)}` : "ещё не входил"}`;
}

function ModelCell({ user, model, assigned, access }: {
  user: AdminUser;
  model: { modelName: string; pages: AdminPage[] };
  assigned: ReadonlySet<string>;
  access: PageAccess;
}) {
  const count = model.pages.filter((page) => assigned.has(page.label)).length;
  const all = count === model.pages.length;
  const some = count > 0 && !all;
  const busy = model.pages.some((page) => access.busy(user.id, page.label));
  const words = all ? `открыта вся модель ${model.modelName}. Снять все страницы` : `${model.modelName}: открыто ${count} из ${model.pages.length}. Открыть всю модель`;
  return (
    <td className="access-cell-wrap access-cell-wrap--model access-group-start">
      <button
        type="button"
        role="checkbox"
        aria-checked={some ? "mixed" : all}
        aria-label={`${user.username}: ${words}`}
        title={words}
        className="access-cell access-cell--model"
        data-state={all ? "on" : some ? "some" : "off"}
        disabled={busy}
        onClick={() => access.toggleModel(user, model, assigned)}
      >
        {busy ? <Spinner /> : all ? <Check size={16} strokeWidth={2.25} aria-hidden /> : some ? <Minus size={16} strokeWidth={2.25} aria-hidden /> : <Plus size={14} strokeWidth={2} aria-hidden className="access-cell__plus" />}
      </button>
    </td>
  );
}

function PageCell({ user, page, has, access, start }: { user: AdminUser; page: AdminPage; has: boolean; access: PageAccess; start: boolean }) {
  const busy = access.busy(user.id, page.label);
  const words = has ? `${page.label} открыта. Снять` : `${page.label} закрыта. Открыть`;
  return (
    <td className={start ? "access-cell-wrap access-group-start" : "access-cell-wrap"}>
      <button
        type="button"
        role="checkbox"
        aria-checked={has}
        aria-label={`${user.username}: ${words}`}
        title={words}
        className="access-cell"
        data-state={has ? "on" : "off"}
        disabled={busy}
        onClick={() => access.toggle(user, page, has)}
      >
        {busy ? <Spinner /> : has ? <Check size={16} strokeWidth={2.25} aria-hidden /> : <Plus size={14} strokeWidth={2} aria-hidden className="access-cell__plus" />}
      </button>
    </td>
  );
}

export function AccessMatrix({ groups, pages, access, selectedId, onOpenPerson }: {
  /** People in groups by their state: «Работают», «Ждут регистрации». */
  groups: ReadonlyArray<{ key: string; title: string; users: readonly AdminUser[] }>;
  pages: readonly AdminPage[];
  access: PageAccess;
  selectedId: number | null;
  onOpenPerson: (userId: number) => void;
}) {
  const models = pagesByModel(pages);
  const columns = models.reduce((sum, model) => sum + model.pages.length + (model.pages.length > 1 ? 1 : 0), 0);
  return (
    <div className="access-matrix-frame">
      <table className="access-matrix" aria-label="Кто на каких страницах">
        <thead>
          <tr>
            <th scope="col" rowSpan={2} className="access-matrix__corner">Человек</th>
            {models.map((model) => (
              <th key={model.modelSlug} scope="colgroup" colSpan={model.pages.length + (model.pages.length > 1 ? 1 : 0)} className="access-matrix__model access-group-start">
                {model.modelName}
              </th>
            ))}
          </tr>
          <tr>
            {models.map((model) => (
              <ModelHeads key={model.modelSlug} pages={model.pages} />
            ))}
          </tr>
        </thead>
        {groups.filter((group) => group.users.length > 0).map((group) => (
          <tbody key={group.key}>
            {groups.filter((one) => one.users.length > 0).length > 1 && (
              <tr className="access-matrix__group">
                <th scope="rowgroup" colSpan={columns + 1}>{group.title} <span className="access-matrix__group-count">{group.users.length}</span></th>
              </tr>
            )}
            {group.users.map((user) => {
              const assigned = new Set(user.assignedPages.map((page) => page.label));
              return (
                <tr key={user.id} className="access-matrix__row" aria-selected={selectedId === user.id} data-selected={selectedId === user.id || undefined}>
                  <th scope="row" className="access-matrix__person">
                    <button type="button" className="access-person" onClick={() => onOpenPerson(user.id)} title="Ссылки, устройства, отключение">
                      <Person name={user.username} status={personStatus(user)} hint={personHint(user)} />
                    </button>
                  </th>
                  {models.map((model) => (
                    <ModelRow key={model.modelSlug} user={user} model={model} assigned={assigned} access={access} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function ModelHeads({ pages }: { pages: readonly AdminPage[] }) {
  return (
    <>
      {pages.length > 1 && <th scope="col" className="access-matrix__page access-matrix__page--all access-group-start" title="Вся модель: открыть или снять все её страницы">вся</th>}
      {pages.map((page, index) => (
        <th key={page.label} scope="col" className={`access-matrix__page${index === 0 && pages.length === 1 ? " access-group-start" : ""}`} title={`${page.label} · ${PLATFORM[page.platform] ?? page.platform}`}>
          {page.label}
        </th>
      ))}
    </>
  );
}

function ModelRow({ user, model, assigned, access }: { user: AdminUser; model: { modelName: string; pages: AdminPage[] }; assigned: ReadonlySet<string>; access: PageAccess }) {
  return (
    <>
      {model.pages.length > 1 && <ModelCell user={user} model={model} assigned={assigned} access={access} />}
      {model.pages.map((page, index) => (
        <PageCell key={page.label} user={user} page={page} has={assigned.has(page.label)} access={access} start={index === 0 && model.pages.length === 1} />
      ))}
    </>
  );
}
