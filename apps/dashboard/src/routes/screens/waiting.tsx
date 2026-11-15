/**
 * Group waiting: the owner's «Ждут вас» in Hub (products plan §4.4), the whole list grouped by product.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const WaitingPage = named(() => import("@/pages/waiting/WaitingPage"), "WaitingPage");

export function waitingRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="waiting" element={<WaitingPage />} />
    </Route>
  );
}
