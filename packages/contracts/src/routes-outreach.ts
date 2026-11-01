import {
  clientOutreachesResponseSchema,
  clientOutreachParamsSchema,
  clientOutreachSaveBodySchema,
  clientOutreachSaveResponseSchema,
  clientOutreachSchema,
  clientOutreachSendBodySchema,
  clientOutreachSendResponseSchema,
  clientOutreachTouchesResponseSchema,
} from "./outreach.ts";
import { errorResponseSchema } from "./primitives.ts";
import { clientPageParamsSchema } from "./routes-client.ts";

// «Рассылка» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md): the
// extension (a device token, capability `outreach-store-v1`) lists the page's
// outreaches, reads one, saves the changes it made and claims and reports each
// fan's send; and reads which fans an outreach, a fan queue or «Онлайн» wrote
// to in the last 3 days. Database only: nothing here asks a platform or sends
// anything. Everyone granted the page reads and works every outreach of it.

const clientErrors = {
  // 409: not_granted | client_feature_disabled | outreach_not_found | fan_not_found (a send's fan)
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema,
} as const;

export const outreachRouteSchemas = {
  clientOutreaches: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "The page's outreaches changed within 90 days, newest change first: who made it, its text, how many fans went,"
      + " may have, failed, answered within 72 hours and paid within 7 days",
    description: "Database only. A device token's, for an active page granted to the caller (else 409 `not_granted`)."
      + " Every outreach of the page, whoever made it: the page's team works them together. An outreach untouched for 90"
      + " days is deleted here.",
    params: clientPageParamsSchema,
    response: { 200: clientOutreachesResponseSchema, ...clientErrors },
  },
  clientOutreach: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "One outreach of the page with every fan: the version, the person's words and who wrote them, the send and"
      + " what came of it",
    description: "Database only. A send claimed more than 120 seconds ago and not reported answers `uncertain`; an"
      + " uncertain send whose message Hub's archive holds (the page's message to the fan with the same text, within 30"
      + " minutes of the click) is settled as sent here. 404 `outreach_not_found` for an id of no outreach of the page.",
    params: clientOutreachParamsSchema,
    response: { 200: clientOutreachSchema, ...clientErrors },
  },
  clientOutreachSave: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "Create an outreach of the page (the first save of its id, the caller its author) or change it: the text,"
      + " the window's settings, the order of its fans, fans' versions and the person's words; the last save wins each"
      + " field",
    description: "Database only. A fan's version and words stay as they are once the fan's send was claimed (`kept`). The"
      + " answer is the whole outreach after the save. 409 `outreach_not_found` for an id of another page's outreach;"
      + " a fan Hub does not know on the page is kept out of it (`kept`), the rest is taken; 400 for `settings` over 32 KiB as JSON.",
    params: clientOutreachParamsSchema,
    body: clientOutreachSaveBodySchema,
    response: { 200: clientOutreachSaveResponseSchema, ...clientErrors },
  },
  clientOutreachSend: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "A fan's send of an outreach: claim it before the platform is asked, then report it sent, failed (proven) or"
      + " uncertain; or record a send made before the outreach reached Hub",
    description: "Database only, journaled first. A claim is taken once per fan of an outreach (again only after a proven"
      + " failure) and while no other outreach's send to the fan is on its way (`taken` / `busy`, with who and when). A"
      + " claim not reported within 120 seconds is uncertain and never claimed again. Only the claim's own attempt reports"
      + " it (`not_yours`). 404 `outreach_not_found` for an id of no outreach of the page (save it first); 409"
      + " `fan_not_found` for a fan Hub does not know on the page; 400 for `media` over 32 KiB as JSON or a record's"
      + " click older than 30 days or in the future.",
    params: clientOutreachParamsSchema,
    body: clientOutreachSendBodySchema,
    response: { 200: clientOutreachSendResponseSchema, ...clientErrors },
  },
  clientOutreachTouches: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "The page's fans written to in the last 72 hours by an outreach, a fan queue or «Онлайн», the latest touch"
      + " each: when, from what and by whom",
    params: clientPageParamsSchema,
    response: { 200: clientOutreachTouchesResponseSchema, ...clientErrors },
  },
} as const;
