import { demoError, queryNumber, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { demoPage, type DemoPage } from "../world.ts";
import { ofPageById } from "./publish-of-common.ts";
import {
  exportInventory,
  exportRows,
  findExportJob,
  findIntent,
  ofLinks,
  ofapiExportJobs,
  ofapiIntents,
  ofapiMarketing,
  ofapiMedia,
  profileVisitors,
} from "./publish-of-ofapi.ts";
import { demoPublications, publicationQueues, publicationSettings } from "./publish-of-publications.ts";

/** Demo answers of this area's screens (see demo/core.ts): «Публикации» and
 *  OnlyFans through the vendor (links, Smart Links, media, exports, actions). */

/** The OnlyFans page of `?pageId=`, or the 404 a page without a vendor account answers. */
function mappedPage(request: DemoRequest): DemoPage | DemoReply {
  return ofPageById(queryNumber(request, "pageId", 0)) ?? demoError(404, "Not Found", "Mapped page not found");
}

function isPage(value: DemoPage | DemoReply): value is DemoPage {
  return "label" in value;
}

export const publishOfHandlers: DemoHandlers = {
  adminPublicationList: (request) => {
    const pageLabel = queryString(request, "pageLabel");
    if (pageLabel !== undefined && demoPage(pageLabel) === undefined) {
      return demoError(404, "Not Found", `Page ${pageLabel} not found`);
    }
    const status = queryString(request, "status");
    const from = queryString(request, "from");
    const to = queryString(request, "to");
    const limit = Math.min(1000, Math.max(1, queryNumber(request, "limit", 500)));
    const fromMs = from === undefined ? null : Date.parse(from);
    const toMs = to === undefined ? null : Date.parse(to);
    const publications = demoPublications(request.now)
      .map((item) => item.publication)
      .filter((item) => pageLabel === undefined || item.pageLabel === pageLabel)
      .filter((item) => status === undefined || item.status === status)
      .filter((item) => fromMs === null || Date.parse(item.publishAt) >= fromMs)
      .filter((item) => toMs === null || Date.parse(item.publishAt) < toMs)
      .slice(0, limit);
    return { publications };
  },

  adminPublicationGet: (request) => {
    const id = Number(request.params.id);
    const found = demoPublications(request.now).find((item) => item.publication.id === id);
    if (!found) return demoError(404, "Not Found", "publication_not_found");
    return { ...found.publication, events: found.events, revision: found.revision };
  },

  adminPublicationSettingsList: (request) => publicationSettings(request.now),

  // Two writes answer in the demo, so the reports of the screen can be seen;
  // nothing is saved and every other write still answers 403.
  adminPublicationApprove: (request) => {
    const body = request.body as { items?: Array<{ id: number; version: number }> } | null;
    const all = demoPublications(request.now).map((item) => item.publication);
    const results = (body?.items ?? []).map((item, index) => {
      const publication = all.find((candidate) => candidate.id === item.id) ?? null;
      // The first one was changed while the window was open: the hub refuses it.
      if (index === 0 && (body?.items?.length ?? 0) > 1) {
        return { id: item.id, outcome: "refused" as const, reason: "version_conflict", publication };
      }
      if (publication === null) return { id: item.id, outcome: "refused" as const, reason: "not_found", publication: null };
      return { id: item.id, outcome: "approved" as const, reason: null, publication: { ...publication, status: "approved" as const, version: publication.version + 1 } };
    });
    return { results };
  },

  adminPublicationWithdrawPage: (request) => {
    const body = request.body as { pageLabel?: string } | null;
    const scheduled = demoPublications(request.now).map((item) => item.publication)
      .filter((item) => item.pageLabel === body?.pageLabel && item.status === "scheduled" && item.kind !== "story");
    const outcomes = [
      { outcome: "accepted", reason: "schedule_read_then_cancel" },
      { outcome: "refused", reason: "too_close_to_publish_time" },
      { outcome: "withdrawn", reason: null },
      { outcome: "unknown", reason: "withdraw_unconfirmed_read_failed" },
      { outcome: "rejected", reason: "fansly_http_400" },
      { outcome: "not_sent", reason: null },
    ] as const;
    return {
      results: scheduled.map((publication, index) => {
        const answer = outcomes[index % outcomes.length]!;
        return { id: publication.id, outcome: answer.outcome, reason: answer.reason, publication };
      }),
    };
  },

  adminPublicationQueueList: (request) =>
    publicationQueues(request.now, demoPublications(request.now).map((item) => item.publication)),

  ofLinksGet: (request) => {
    const raw = queryString(request, "pageId");
    if (raw === undefined) return ofLinks(request.now, undefined);
    const page = ofPageById(Number(raw));
    if (!page) return demoError(404, "Not Found", "OnlyFans page not found");
    return ofLinks(request.now, page.id);
  },

  ofapiMarketingGet: (request) => ofapiMarketing(request.now),

  ofapiMediaGet: (request) => {
    const page = mappedPage(request);
    if (!isPage(page)) return page;
    const offset = Math.max(0, queryNumber(request, "offset", 0));
    const limit = Math.min(100, Math.max(1, queryNumber(request, "limit", 50)));
    return ofapiMedia(request.now, page, offset, limit);
  },

  ofapiTypedExportList: (request) => {
    const page = mappedPage(request);
    if (!isPage(page)) return page;
    return { jobs: ofapiExportJobs(request.now, page) };
  },

  ofapiTypedExportRows: (request) => {
    const found = findExportJob(request.now, request.params.jobId ?? "");
    if (!found) return demoError(404, "Not Found", "Export job not found");
    const offset = Math.max(0, queryNumber(request, "offset", 0));
    const limit = Math.min(100, Math.max(1, queryNumber(request, "limit", 100)));
    return {
      pageId: found.page.id,
      profile: found.job.profile,
      coverage: "item_presence" as const,
      rows: exportRows(request.now, found.page, found.job, offset, limit),
    };
  },

  ofapiProfileVisitorsGet: (request) => {
    const page = mappedPage(request);
    if (!isPage(page)) return page;
    const from = queryString(request, "from") ?? "";
    const to = queryString(request, "to") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return demoError(400, "Bad Request", "from and to must be ISO dates, from ≤ to");
    }
    const source = queryString(request, "source") === "rest" ? "rest" : "export";
    return profileVisitors(request.now, page, from, to, source);
  },

  ofapiExportInventoryGet: (request) => exportInventory(request.now),

  ofapiActionList: (request) => {
    const page = mappedPage(request);
    if (!isPage(page)) return page;
    return { intents: ofapiIntents(request.now, page) };
  },

  ofapiActionGet: (request) => findIntent(request.now, request.params.id ?? "") ?? demoError(404, "Not Found", "Action not found"),
};
