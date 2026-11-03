import { useNavigate, useParams } from "react-router";
import { buildPageCollectionRoute, decodeRouteSegment } from "@/lib/navigation";

/** The page a collection screen shows in detail: `/system/collection/:pageLabel`.
 *  In the path, so a lever on that screen cannot take its target from anywhere else. */
export function useSelectedSyncPage(): {
  selectedPage: string | null;
  selectPage: (pageLabel: string) => void;
  clearPage: () => void;
} {
  const { pageLabel } = useParams<{ pageLabel?: string }>();
  const navigate = useNavigate();
  return {
    selectedPage: pageLabel === undefined ? null : decodeRouteSegment(pageLabel),
    selectPage: (label) => navigate(buildPageCollectionRoute(label)),
    clearPage: () => navigate("/system/collection"),
  };
}
