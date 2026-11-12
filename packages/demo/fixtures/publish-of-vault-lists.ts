/**
 * «Медиатека OnlyFans» → «Альбомы»: the vault lists (albums) of the two
 * OnlyFans pages as Hub last walked them (0394). Invented album names; the
 * system lists (posts, messages, stories, streams) are there as OnlyFans
 * lists them, and one album went missing from the last complete walk.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { intBetween, iso, rng } from "../core.ts";
import type { DemoPage } from "../world.ts";
import { DAY_MS, HOUR_MS, demoDigits, ofStop } from "./publish-of-common.ts";

type VaultLists = KernelOperationResponse<"ofapiVaultListsGet">;
type VaultList = VaultLists["lists"][number];

const ALBUMS: Readonly<Record<string, readonly string[]>> = {
  "mia-of": [
    "Осень · пледы и свечи", "Зеркало 04", "Пляж · сентябрь", "Кухня утром", "Красное платье",
    "Спортзал · сет 2", "Дождь за окном", "Кастомы · ноябрь", "Тизеры для рассылок", "Хэллоуин",
    "Чёрное кружево", "Балкон · вечер", "Ванная · пена", "Розовый свитер", "Welcome-пак",
  ],
  "mia-vip-of": [
    "VIP · ноябрь", "VIP · октябрь", "Длинные видео", "Кастомы VIP", "Закулисье съёмки", "Бонус за продление",
  ],
};

const SYSTEM = ["posts", "messages", "stories", "streams"] as const;
const SYSTEM_NAMES: Record<(typeof SYSTEM)[number], string> = { posts: "Posts", messages: "Messages", stories: "Stories", streams: "Streams" };

export function ofapiVaultLists(now: Date, page: DemoPage): VaultLists {
  const random = rng(`ofvaultlists:${page.label}`);
  const walkedAt = new Date(ofStop(now).getTime() - 26 * HOUR_MS);
  const names = ALBUMS[page.label] ?? ALBUMS["mia-vip-of"]!;
  const list = (name: string, type: string, index: number, count: number, missing = false): VaultList => ({
    listRef: demoDigits(`ofvaultlist:${page.label}:${type}:${index}`, 8),
    name,
    type,
    mediaCount: count,
    firstSeenAt: iso(new Date(walkedAt.getTime() - intBetween(random, 3, 40) * DAY_MS)),
    lastSeenAt: iso(missing ? new Date(walkedAt.getTime() - 4 * DAY_MS) : walkedAt),
    missingSince: missing ? iso(new Date(walkedAt.getTime() - 3 * DAY_MS)) : null,
  });
  const albums = names.map((name, index) => list(name, "custom", index, intBetween(random, 4, 180)));
  const gone = list("Старый пак · лето", "custom", names.length, intBetween(random, 10, 40), true);
  const system = SYSTEM.map((type, index) => list(SYSTEM_NAMES[type], type, index, intBetween(random, 80, 1900)));
  return {
    pageId: page.id,
    lists: [...albums.sort((a, b) => a.name.localeCompare(b.name, "ru")), gone, ...system],
    walk: {
      requestedAt: null,
      completedAt: iso(walkedAt),
      completedRequests: Math.ceil((names.length + 1 + SYSTEM.length) / 30),
      failedAt: null,
      failure: null,
    },
  };
}
