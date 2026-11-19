import { useMutation } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// The invitation page (/join, public); the account page is Workboard's. Everything
// goes through the generated SDK, like every other domain module (dashboard-sdk-ban).
//
// The invitation secret only ever travels in the POST body: it is passed in as
// an argument, never stored in a query key, never appended to a URL.

export function useInspectAccountLink() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { token: string }) =>
      kernel.authInspectAccountLink({ body: input }),
  });
}

export function useRedeemAccountLink() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { token: string; password: string }) =>
      kernel.authRedeemAccountLink({ body: input }),
  });
}
