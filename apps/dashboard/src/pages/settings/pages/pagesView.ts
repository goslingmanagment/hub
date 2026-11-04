import type { AdminUser, AssignedPage, ModelListItem } from "@agency_hub_core/contracts";
import { ruPlural } from "@/lib/plural";
import type { PageWorker } from "./PageRow.js";

/** A platform's name, plain text (design-language.md §2.7). */
export const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  fansly: "Fansly",
  onlyfans: "OnlyFans",
  telegram: "Telegram",
};

export function pagesCount(count: number): string {
  return count === 0 ? "Страниц нет" : `${count} ${ruPlural(count, "страница", "страницы", "страниц")}`;
}

export interface ModelGroup {
  /** Null: pages of a model the catalog no longer lists. */
  model: ModelListItem | null;
  slug: string;
  name: string;
  pages: AssignedPage[];
}

/** Models in their order; pages of a model the catalog no longer lists come last. */
export function modelGroups(models: readonly ModelListItem[], pages: readonly AssignedPage[]): ModelGroup[] {
  const groups: ModelGroup[] = models.map((model) => ({
    model,
    slug: model.slug,
    name: model.name,
    pages: pages.filter((page) => page.modelSlug === model.slug),
  }));
  for (const page of pages) {
    if (groups.some((group) => group.slug === page.modelSlug)) continue;
    groups.push({ model: null, slug: page.modelSlug, name: page.modelName, pages: pages.filter((candidate) => candidate.modelSlug === page.modelSlug) });
  }
  return groups;
}

/**
 * «Кто работает»: chatters with access to the page, not disabled nor deleted. Team
 * leads see all their pages, so they are left out. Null: the list did not come.
 */
export function workersByPage(users: readonly AdminUser[] | undefined): ((label: string) => PageWorker[]) | null {
  if (!users) return null;
  return (label) => users
    .filter((user) => user.role === "chatter" && !user.disabledAt && !user.deletedAt && user.assignedPages.some((page) => page.label === label))
    .map((user) => ({ userId: user.id, username: user.username, invited: user.registrationState === "invited" }));
}
