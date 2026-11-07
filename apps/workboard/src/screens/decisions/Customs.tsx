import { Badge, Disclosure, Money, Section, Table, TimeMsk, type Column } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { sumMills } from "@agency_hub_core/shared";
import { PersonLink } from "@/shared/links";
import { FanCell } from "./FanCell";
import { CUSTOM_OVERDUE_DAYS, CUSTOMS_LIMIT, type Custom, type FanRefOnPage, type KnownFan } from "./data";

/**
 * Кастомы: paid by the fan and not delivered, the oldest payment first, with
 * the sum that waits. Read-only (as the console's TeamCustomsPage.tsx): a
 * chatter marks «отдали» in the fan's card in the extension. The ones still
 * waiting for the fan's payment are folded under: there the fan waits, not the
 * team.
 */

const DAY_MS = 86_400_000;

function daysSince(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / DAY_MS);
}

function daysWord(days: number): string {
  return days < 1 ? "сегодня" : `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

/** The sum of the known prices; null when none is known. */
function totalOf(customs: readonly Custom[]): bigint | null {
  const prices = customs.map((custom) => custom.priceMills).filter((price): price is number => price !== null);
  return prices.length === 0 ? null : sumMills(prices);
}

export interface CustomsProps {
  paid: readonly Custom[];
  ordered: readonly Custom[];
  other: readonly Custom[];
  capped: boolean;
  serverNow: string;
  platformOf: (pageLabel: string) => string | undefined;
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined;
  /** A login to its id (the owner's people list); null — plain text. */
  userIdOf: (username: string) => number | null;
}

function useColumns({ serverNow, platformOf, fanOf, userIdOf }: Pick<CustomsProps, "serverNow" | "platformOf" | "fanOf" | "userIdOf">) {
  const now = Date.parse(serverNow);
  const fanCell = (row: Custom) => <FanCell fan={fanOf(row)} fanRef={row.fanRef} pageLabel={row.pageLabel} platform={platformOf(row.pageLabel)} />;
  const whoCell = (row: Custom) => {
    const id = userIdOf(row.createdBy);
    const hint = <>записал <TimeMsk at={row.createdAt} show="date" /></>;
    return id === null
      ? <span>{row.createdBy}<span className="decisions-sub">{hint}</span></span>
      : <PersonLink userId={id} name={row.createdBy} hint={hint} backLabel="Решения" />;
  };
  return (since: "paid" | "created"): Column<Custom>[] => [
    { key: "fan", header: "Фан", cell: fanCell, width: 240 },
    { key: "what", header: "Что заказано", cell: (row) => <span className="decisions-text">{row.description}</span> },
    { key: "price", header: "Цена", numeric: true, width: 120, cell: (row) => <Money mills={row.priceMills} strong={since === "paid"} />, sortValue: (row) => row.priceMills },
    {
      key: "wait",
      header: since === "paid" ? "Оплачен" : "Записан",
      width: 190,
      nowrap: true,
      sortValue: (row) => (since === "paid" ? row.paidAt : row.createdAt) ?? row.createdAt,
      sortFirst: "asc",
      cell: (row) => {
        const at = since === "paid" && row.paidAt ? row.paidAt : row.createdAt;
        const days = daysSince(at, now);
        const overdue = since === "paid" ? days - CUSTOM_OVERDUE_DAYS : 0;
        return (
          <span>
            {days < 1 ? "сегодня" : `${daysWord(days)} назад`}
            {overdue > 0 && <span className="decisions-sub"><Badge tone="warning" bare>Просрочен на {daysWord(overdue)}</Badge></span>}
          </span>
        );
      },
    },
    { key: "who", header: "Чаттер", width: 200, cell: whoCell },
  ];
}

/** The section of paid customs (the screen shows it only when there are some), with the rest folded under it. */
export function CustomsSection(props: CustomsProps) {
  const { paid, capped } = props;
  const columns = useColumns(props);
  return (
    <Section
      id="customs"
      title={<>Кастомы: оплачены, не отданы <span className="decisions-count">{paid.length}</span></>}
      description={<>Фаны заплатили <Money mills={totalOf(paid)} strong /> и ждут. Отдали — чаттер отмечает в карточке фана в расширении; как модель снимает, по-прежнему в Telegram.</>}
    >
      <Table label="Кастомы: оплачены, не отданы" columns={columns("paid")} rows={paid} rowKey={(row) => String(row.id)} />
      <CustomsFolds {...props} />
      {capped && <p className="decisions-note">Показаны первые {CUSTOMS_LIMIT}.</p>}
    </Section>
  );
}

/** The customs that wait for the fan (and states Workboard does not know): folded, out of the count. */
export function CustomsFolds(props: CustomsProps) {
  const { ordered, other } = props;
  const columns = useColumns(props);
  const orderedTotal = totalOf(ordered);
  return (
    <>
      {ordered.length > 0 && (
        <Disclosure
          size="md"
          className="decisions-fold"
          summary="Кастомы ждут оплаты фана"
          hint={<>{ordered.length}{orderedTotal !== null && <> · <Money mills={orderedTotal} /></>}</>}
        >
          <p className="decisions-note">Считается от записи: здесь ждут фана, а не команду. В счётчик «Решений» не входят.</p>
          <Table label="Кастомы: ждут оплаты" columns={columns("created")} rows={ordered} rowKey={(row) => String(row.id)} />
        </Disclosure>
      )}
      {other.length > 0 && (
        <Disclosure size="md" className="decisions-fold" summary="Кастомы в другом состоянии" hint={String(other.length)}>
          <p className="decisions-note">Состояние, которого Workboard не знает: показано как есть ({[...new Set(other.map((row) => row.state))].join(", ")}).</p>
          <Table label="Кастомы в другом состоянии" columns={columns("created")} rows={other} rowKey={(row) => String(row.id)} />
        </Disclosure>
      )}
    </>
  );
}
