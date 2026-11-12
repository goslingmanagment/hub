import { placeFace, type PlaceFace } from "@agency_hub_core/ui/place";
import { useMe } from "./useMe.js";

/**
 * Which place this session is in (packages/ui/src/place.ts): the owner's — the
 * owner or a team lead on the console's name, one frame with the console — or
 * the team's — a chatter, a session from the extension, anyone on the team's
 * name: Workboard's own short menu.
 */
export function useFace(): PlaceFace {
  const { role, narrow } = useMe();
  return placeFace({ role, narrow, origin: window.location.origin });
}
