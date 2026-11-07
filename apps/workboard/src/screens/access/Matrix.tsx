import { Check, Minus, Plus } from "lucide-react";
import { Person, Spinner, Tooltip, platformWord, type PersonStatus } from "@agency_hub_core/ui";
import { ROLE_LABEL, teamStatus, type AccessRole } from "@agency_hub_core/ui/teamAccess";
import { pagesByModel, type AdminPage, type AdminUser } from "./data";
import type { PageAccess } from "./pageAccess";
import { whenWords } from "./when";

/**
 * Кто на каких страницах: people × pages in one place, the pages under their
 * models with «вся модель» where a model has more than one page. A cell opens
 * a page at once or asks before removing it (pageAccess.tsx); a person's name
 * opens their panel (links, devices, switching off). The owner sees every
 * page whatever is ticked (Hub gives the owner no page filter), so the owner's
 * row is the last one, without cells: «видит все страницы» (D11).
 */

export function personStatus(user: AdminUser): PersonStatus {
  const status = teamStatus(user);
  return status === "disabled" ? "disabled" : status === "invited" ? "invited" : "away";
}

/**
 * «Чаттер · в расширении 3 мин назад», «Тимлид · в расширение не входил»,
 * «Чаттер · в расширении 26 окт.». Hub's `lastActiveAt` is the last use of the
 * person's sign-in on a device (the extension, the app) — a fact of access,
 * said as one: not «был», which «Люди» keep for shifts (С7).
 */
export function personHint(user: AdminUser): string {
  const role = ROLE_LABEL[user.role as AccessRole] ?? user.role;
  if (user.disabledAt) return `${role} · отключён ${whenWords(user.disabledAt)}`;
  if (user.registrationState === "invited") return `${role} · ждёт регистрации`;
  return `${role} · ${user.lastActiveAt ? `в расширении ${whenWords(user.lastActiveAt)}` : "в расширение не входил"}`;
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
  const glows = model.pages.some((page) => access.recent(user.id, page.label));
  const words = all ? `открыта вся модель ${model.modelName}. Снять все страницы` : `${model.modelName}: открыто ${count} из ${model.pages.length}. Открыть всю модель`;
  return (
    <td className="access-cell-wrap access-cell-wrap--model access-group-start">
      <button
        type="button"
        role="checkbox"
        aria-checked={some ? "mixed" : all}
        aria-label={`${user.username}: ${words}`}
        className="access-cell access-cell--model"
        data-state={all ? "on" : some ? "some" : "off"}
        data-glow={glows || undefined}
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
        className="access-cell"
        data-state={has ? "on" : "off"}
        data-glow={access.recent(user.id, page.label) || undefined}
        disabled={busy}
        onClick={() => access.toggle(user, page, has)}
      >
        {busy ? <Spinner /> : has ? <Check size={16} strokeWidth={2.25} aria-hidden /> : <Plus size={14} strokeWidth={2} aria-hidden className="access-cell__plus" />}
      </button>
    </td>
  );
}

export function AccessMatrix({ groups, owners, pages, access, selectedId, flashId = null, onOpenPerson }: {
  /** People in groups by their state: «В команде», «Ждут регистрации». */
  groups: ReadonlyArray<{ key: string; title: string; users: readonly AdminUser[] }>;
  /** The owner: the last row, no cells — sees every page. */
  owners: readonly AdminUser[];
  pages: readonly AdminPage[];
  access: PageAccess;
  selectedId: number | null;
  /** A row to light for a moment: the person whose panel sent the owner here («Изменить в таблице», Д-н1). */
  flashId?: number | null;
  onOpenPerson: (userId: number) => void;
}) {
  const models = pagesByModel(pages);
  const columns = models.reduce((sum, model) => sum + model.pages.length + (model.pages.length > 1 ? 1 : 0), 0);
  const shown = groups.filter((group) => group.users.length > 0);
  const titled = shown.length + (owners.length > 0 ? 1 : 0) > 1;
  const personCell = (user: AdminUser) => (
    <th scope="row" className="access-matrix__person">
      <button type="button" className="access-person" onClick={() => onOpenPerson(user.id)} aria-label={`${user.username}: ссылки, устройства, отключение`}>
        <Person name={user.username} status={personStatus(user)} hint={personHint(user)} />
      </button>
    </th>
  );
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
        {shown.map((group) => (
          <tbody key={group.key}>
            {titled && (
              <tr className="access-matrix__group">
                <th scope="rowgroup" colSpan={columns + 1}>{group.title} <span className="access-matrix__group-count">{group.users.length}</span></th>
              </tr>
            )}
            {group.users.map((user) => {
              const assigned = new Set(user.assignedPages.map((page) => page.label));
              return (
                <tr
                  key={user.id}
                  id={`access-row-${user.id}`}
                  className="access-matrix__row"
                  aria-selected={selectedId === user.id}
                  data-selected={selectedId === user.id || undefined}
                  data-flash={flashId === user.id || undefined}
                >
                  {personCell(user)}
                  {models.map((model) => (
                    <ModelRow key={model.modelSlug} user={user} model={model} assigned={assigned} access={access} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        ))}
        {owners.length > 0 && (
          <tbody>
            {titled && (
              <tr className="access-matrix__group">
                <th scope="rowgroup" colSpan={columns + 1}>Владелец</th>
              </tr>
            )}
            {owners.map((user) => (
              <tr key={user.id} className="access-matrix__row access-matrix__row--owner" aria-selected={selectedId === user.id} data-selected={selectedId === user.id || undefined}>
                {personCell(user)}
                <td colSpan={columns} className="access-matrix__all access-group-start">
                  Видит все страницы — назначать их владельцу не нужно
                </td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function ModelHeads({ pages }: { pages: readonly AdminPage[] }) {
  return (
    <>
      {pages.length > 1 && (
        <th scope="col" className="access-matrix__page access-matrix__page--all access-group-start">
          <Tooltip content="Вся модель: открыть или снять все её страницы разом"><span className="access-matrix__head-word">вся</span></Tooltip>
        </th>
      )}
      {pages.map((page, index) => (
        <th key={page.label} scope="col" className={`access-matrix__page${index === 0 && pages.length === 1 ? " access-group-start" : ""}`}>
          <Tooltip content={`${page.label} · ${platformWord(page.platform) ?? page.platform}`}><span className="access-matrix__head-word">{page.label}</span></Tooltip>
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
