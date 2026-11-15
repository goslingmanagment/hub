import { CONTENTOPS_ORIGIN } from "@agency_hub_core/contracts";

/**
 * «Публикации» and «Статистика → Контент» are ContentOps' own screens (products package C2): Hub's two screens are gone
 * and every address of them — the owner's bookmarks, the links Hub wrote into matters before, the console's old
 * paths — and Hub's own links to them (`/contentops/<screen>`) are answered HERE, by Hub's server, before any page is
 * served (api/server.ts):
 *
 * - the person crosses through ContentOps' own sign-in by Hub (`/auth/hub/start?next=…`): signed in to Hub, no second
 *   sign-in; ContentOps opens `/hub/<screen>?model=<Hub's slug>&…` (its `HubEntryRedirect`) on the model there;
 * - the model is Hub's to know: a post's (`publication=`) or a page's (`page=`) model, for the owner of the live team;
 *   without one ContentOps opens the person's last model;
 * - the test team's owner has no ContentOps by design: the words say where the screens are and who works there;
 * - ContentOps runs on a home machine: when it does not answer Hub, the person reads that in words, not a browser's
 *   error.
 *
 * The table of old addresses (packages/ui/src/old-addresses.ts) lists them; `tests/content-screens-moved.test.ts`
 * walks every row through this.
 */

export type ContentScreen = "publications" | "stats";

export interface MovedAddress {
  screen: ContentScreen;
  /** What the old address carried, as Hub wrote it. */
  search: URLSearchParams;
}

/** Hub's paths of the two screens (and its hop): the screen they were, or null. */
export function contentScreenOf(url: string): MovedAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://hub.invalid");
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const search = new URLSearchParams(parsed.search);
  switch (path) {
    case "/contentops/publications":
    case "/content/publications":
    case "/content":
    case "/publications":
      return { screen: "publications", search };
    case "/publication-settings":
      search.set("panel", "settings");
      return { screen: "publications", search };
    case "/contentops/stats":
    case "/stats/content":
      return { screen: "stats", search };
    case "/stats": {
      // Before 12.11 the tab was a parameter: `/stats?tab=content&days=7`.
      if (search.get("tab") !== "content") return null;
      search.delete("tab");
      const days = search.get("days");
      search.delete("days");
      if (days) search.set("period", `${days}d`);
      return { screen: "stats", search };
    }
    default:
      return null;
  }
}

const STATS_DAYS = new Set(["7", "30", "90", "180", "365"]);
const WINDOWS = new Set(["next7", "next30", "last7", "last30", "all"]);
const LABEL = /^[A-Za-z0-9._-]{1,100}$/;
const STATUS = /^[a-z_]{1,40}$/;

/** The page an old address names (`page=all` is every page: none). */
export function pageOf(search: URLSearchParams): string | null {
  const page = search.get("page");
  return page && page !== "all" && LABEL.test(page) ? page : null;
}

/** The post an old address opens (`publication=`, ContentOps' `post=`). */
export function postOf(search: URLSearchParams): number | null {
  const raw = search.get("publication") ?? search.get("post");
  return raw && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

/**
 * ContentOps' address for a moved one: its sign-in by Hub, then `/hub/<screen>` with Hub's model slug and what the
 * address carried that ContentOps' screen has. A media's number is written as a JSON string: ContentOps' router reads
 * a bare number as a number, and Fansly's ids are longer than a number keeps.
 */
export function contentopsAddress(moved: MovedAddress, modelSlug: string | null, origin: string = CONTENTOPS_ORIGIN): string {
  const { screen, search } = moved;
  const next = new URLSearchParams();
  if (modelSlug) next.set("model", modelSlug.toLowerCase());
  const page = pageOf(search);
  if (page) next.set("page", page);
  if (screen === "publications") {
    const status = search.get("status");
    if (status && STATUS.test(status)) next.set("status", status);
    const window = search.get("window");
    if (window && WINDOWS.has(window)) next.set("window", window);
    if (search.get("panel") === "settings") next.set("panel", "settings");
    const post = postOf(search);
    if (post !== null) next.set("post", String(post));
  } else {
    const days = /^(\d+)d$/.exec(search.get("period") ?? "")?.[1] ?? search.get("days");
    if (days && STATS_DAYS.has(days)) next.set("days", days);
    const media = search.get("media");
    if (media && /^\d{1,30}$/.test(media)) next.set("media", JSON.stringify(media));
  }
  const query = next.toString();
  return `${origin}/auth/hub/start?${new URLSearchParams({ next: `/hub/${screen}${query ? `?${query}` : ""}` }).toString()}`;
}

/** Is ContentOps up, as Hub sees it (its `/healthz`)? Asked at most every 20 s while it answers, every 5 s while not. */
export interface ContentopsProbe {
  reachable(): Promise<boolean>;
}

export function createContentopsProbe(options: {
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
} = {}): ContentopsProbe {
  const origin = options.origin ?? CONTENTOPS_ORIGIN;
  const ask = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 2_500;
  let last: { at: number; up: boolean } | null = null;
  let pending: Promise<boolean> | null = null;
  return {
    async reachable() {
      if (last && now() - last.at < (last.up ? 20_000 : 5_000)) return last.up;
      pending ??= (async () => {
        let up: boolean;
        try {
          // Any answer from ContentOps' own server counts: a red `/healthz` (503) still serves its pages.
          const response = await ask(`${origin}/healthz`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
          up = response.status < 500 || response.status === 503;
        } catch {
          up = false;
        }
        last = { at: now(), up };
        pending = null;
        return up;
      })();
      return pending;
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A page of words instead of the screen: what happened and where to go. */
export function wordsPage(title: string, lines: readonly string[], actions: readonly { label: string; href: string }[]): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f4f0;--ink:#1d1b18;--muted:#6b665e;--line:#d9d4ca;--accent:#2f3b73}
@media (prefers-color-scheme:dark){:root{--bg:#191816;--ink:#eeeae2;--muted:#a7a196;--line:#3a3732;--accent:#9fb0ff}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:18vh auto 0;padding:0 16px}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .75rem}p{margin:0 0 .5rem;color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}
a{color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:.35rem .9rem}
</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
<nav>${actions.map((action) => `<a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`).join("")}</nav>
</main></body></html>`;
}

/** ContentOps does not answer Hub: the person reads it, with a way to try again and a way home. */
export function contentopsDownPage(retry: string): string {
  return wordsPage(
    "ContentOps сейчас недоступен",
    ["Публикации и статистика контента живут в ContentOps, а он сейчас не отвечает. Попробуйте позже."],
    [{ label: "Попробовать снова", href: retry }, { label: "На главную Hub", href: "/" }],
  );
}

/** The test team's owner has no ContentOps: where the screens are and who of the test team works there. */
export function testOwnerPage(): string {
  return wordsPage(
    "Контент теперь в ContentOps",
    [
      "Публикации и статистика контента переехали из Hub в ContentOps.",
      "У владельца тестовой команды ContentOps нет: в тестовой команде там работает контент-менеджер t-km. Войдите в ContentOps им.",
    ],
    [{ label: "На главную Hub", href: "/" }],
  );
}
