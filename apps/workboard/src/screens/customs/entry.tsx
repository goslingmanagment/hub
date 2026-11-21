import { Navigate, useParams } from "react-router";
import { ErrorState, Skeleton } from "@agency_hub_core/ui";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useCustomBoard } from "./data";
import { CustomsFactsScreen } from "./facts";
import { CustomOrderScreen, CustomsBoardScreen } from "./index";

/**
 * «Кастомы» by the live switch `customsFacts` (customs facts spec C9), which the board's answer carries (`factsOn`): on,
 * the facts screen; off, the column board and the order's page as they were, until the release removes them.
 */

function Waiting({ title, retry, failed, retrying }: { title: string; retry: () => void; failed: boolean; retrying: boolean }) {
  return (
    <>
      <ScreenHeader title={title} />
      <div className="wb-content">
        {failed ? <ErrorState onRetry={retry} retrying={retrying}>Заказы не загрузились: Hub не ответил.</ErrorState> : <Skeleton height={480} />}
      </div>
    </>
  );
}

export function CustomsEntry() {
  const board = useCustomBoard(null);
  if (!board.data) return <Waiting title="Кастомы" retry={() => void board.refetch()} failed={board.isError} retrying={board.isFetching} />;
  return board.data.factsOn ? <CustomsFactsScreen /> : <CustomsBoardScreen />;
}

/** `/customs/K-123`: with the facts screen, the screen with that order's panel open (old links keep working). */
export function CustomOrderEntry() {
  const { code = "" } = useParams();
  const board = useCustomBoard(null);
  if (!board.data) return <Waiting title={code} retry={() => void board.refetch()} failed={board.isError} retrying={board.isFetching} />;
  if (!board.data.factsOn) return <CustomOrderScreen />;
  return <Navigate to={{ pathname: "/customs", search: `?order=${encodeURIComponent(code)}` }} replace />;
}
