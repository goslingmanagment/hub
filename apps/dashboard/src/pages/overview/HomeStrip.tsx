import { useQuery } from "@tanstack/react-query";
import type { MattersWaitingResponse, WaitingProductId } from "@agency_hub_core/contracts";
import { WAITING_PRODUCTS } from "@agency_hub_core/contracts";
import { addDays, moscowDayStart, moscowToday } from "@agency_hub_core/ui/moscow";
import { waitedFor } from "@agency_hub_core/ui/waiting/kinds";
import { useAuthMe } from "@/api/queries";
import { kernel } from "@/api/sdk";
import { useTeamShifts } from "@/api/team";
import { AppLink } from "@/components/shared/AppLink";
import { ruPlural } from "@/lib/plural";
import { contentopsScreen } from "@/lib/contentops";

/**
 * The owner's lines above the money on Главная (products plan §2.2): «Ждут вас» as three tiles, one per product (its
 * number and the matter waiting longest), and «Продукты», one line per product that leads into it. They only count
 * and lead; who is on shift lives in Workboard. Every number is a read the product's own screens make: the tiles are
 * `mattersWaiting.products` (the menu's read), the lines the matters, the shifts and the publications of today.
 */
const MINUTE = 60_000;
const TONE_DOT: Readonly<Record<"bad" | "warn", string>> = { bad: "status-dot-error", warn: "status-dot-warn" };

/** A shift's window, its end on the minute: one query key per minute, not per render. */
function lastDay(now = Date.now()): { from: string; to: string } {
  const to = Math.floor(now / MINUTE) * MINUTE;
  return { from: new Date(to - 24 * 60 * MINUTE).toISOString(), to: new Date(to).toISOString() };
}

/** What a publication of today counts as: going out or gone out (not a draft, not refused, not taken back). */
const OUT_TODAY: ReadonlySet<string> = new Set(["approved", "submitting", "scheduled", "processing", "published", "unknown"]);

function WaitingTiles() {
  const read = useQuery({
    queryKey: ["matters", "waiting", ""],
    queryFn: () => kernel.mattersWaiting({ query: {} }),
    refetchInterval: MINUTE,
    meta: { suppressGlobalError: true },
  });
  const data: MattersWaitingResponse | undefined = read.data;
  const now = data ? Date.parse(data.serverNow) : Date.now();
  return (
    <div className="home-waiting" aria-label="Ждут вас по продуктам">
      {WAITING_PRODUCTS.map((product) => {
        const part = data?.products.find((one) => one.id === product.id);
        return (
          <AppLink key={product.id} to={`/waiting#product-${product.id}`} className="home-tile card">
            <span className="home-tile-head">
              {part?.tone && <span className={`status-dot ${TONE_DOT[part.tone]}`} aria-hidden="true" />}
              <span className="home-tile-name">{product.title}</span>
            </span>
            {!data ? (
              <span className="home-tile-none">{read.isError ? "Не удалось проверить" : "Проверяем…"}</span>
            ) : !part || part.count === 0 ? (
              <span className="home-tile-none">{part && !part.checked ? "Не удалось проверить" : "Ничего не ждёт"}</span>
            ) : (
              <>
                <span className="home-tile-count">{part.checked ? part.count : `${part.count}+`}</span>
                {part.oldest && (
                  <span className="home-tile-oldest" title={part.oldest.title}>
                    <span className="home-tile-oldest-text">{part.oldest.title}</span>
                    <span className="home-tile-age">{waitedFor(part.oldest.since, now)}</span>
                  </span>
                )}
              </>
            )}
          </AppLink>
        );
      })}
    </div>
  );
}

function count(value: number, one: string, few: string, many: string): string {
  return `${value} ${ruPlural(value, one, few, many)}`;
}

function ProductLines() {
  const matters = useQuery({
    queryKey: ["matters", "list", "open"],
    queryFn: () => kernel.mattersList({ query: { state: "open", limit: 500 } }),
    refetchInterval: MINUTE,
    meta: { suppressGlobalError: true },
  });
  const shifts = useTeamShifts(lastDay());
  const today = moscowToday();
  // The publications of live pages are not the test owner's to read: the line then says the gaps alone.
  const testRealm = useAuthMe().data?.test === true;
  const publications = useQuery({
    queryKey: ["publications", "today", today],
    queryFn: () => kernel.adminPublicationList({ query: { from: moscowDayStart(today), to: moscowDayStart(addDays(today, 1)), limit: 1000 } }),
    enabled: !testRealm,
    refetchInterval: 5 * MINUTE,
    meta: { suppressGlobalError: true },
  });
  const open = (kind: string): number | null => (matters.data ? matters.data.matters.filter((matter) => matter.kind === kind).length : null);
  const known = (value: number | null, words: (value: number) => string) => (value === null ? "?" : words(value));
  const onShift = shifts.data ? shifts.data.shifts.filter((shift) => shift.ongoing).length : null;
  const notHandedIn = open("shift.report.missing");
  const outToday = publications.data ? publications.data.publications.filter((one) => OUT_TODAY.has(one.status)).length : null;
  const gaps = open("content.schedule_gap");
  const failures = open("incident.open");
  const lines: { id: WaitingProductId | "system"; name: string; to: string; external?: boolean; text: string }[] = [
    {
      id: "workboard", name: "Workboard", to: "/workboard/shifts",
      text: `на смене ${known(onShift, String)}, не сдано отчётов ${known(notHandedIn, String)}`,
    },
    {
      // What goes out today is ContentOps' «Публикации» (package C2): Hub's hop opens it there, signed in.
      id: "contentops", name: "ContentOps", to: contentopsScreen("publications"), external: true,
      text: `${testRealm ? "" : `сегодня выйдет ${known(outToday, String)}, `}${known(gaps, (value) => count(value, "дыра", "дыры", "дыр"))} на неделе`,
    },
    { id: "system", name: "Система", to: "/system/failures", text: `сбоев ${known(failures, String)}` },
  ];
  return (
    <div className="home-strip-row">
      <span className="home-strip-label">Продукты</span>
      <div className="home-strip-items">
        {lines.map((line) => (line.external ? (
          <a key={line.id} href={line.to} target="_blank" rel="noreferrer" className="home-strip-item">
            <span className="font-medium">{line.name}</span>
            <span className="text-text-secondary">{line.text}</span>
          </a>
        ) : (
          <AppLink key={line.id} to={line.to} className="home-strip-item">
            <span className="font-medium">{line.name}</span>
            <span className="text-text-secondary">{line.text}</span>
          </AppLink>
        )))}
      </div>
    </div>
  );
}

export function HomeStrip() {
  const user = useAuthMe();
  if (user.data?.user.role !== "owner") return null;
  return (
    <section className="home-strip-block" aria-label="Что ждёт вас и что в продуктах">
      <WaitingTiles />
      <section className="home-strip card" aria-label="Продукты">
        <ProductLines />
      </section>
    </section>
  );
}
