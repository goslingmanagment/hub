import { ofapiMediaRouteSchemas } from "@agency_hub_core/contracts";
import {
  canAccessPage,
  requireDashboardUser,
  requireOwner,
} from "../../services/auth.ts";
import { ForbiddenError } from "../../services/errors.ts";
import {
  captureOwnerOfapiMediaSource,
  createOwnerOfapiMediaUpload,
  resumeOwnerOfapiMediaUpload,
} from "../../services/ofapi-media-sources.ts";
import {
  handoffOfapiMedia,
  readOfapiMedia,
} from "../../services/ofapi-media-catalog.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";
export function registerOfapiMediaRoutes(
  server: ApiServer,
  ctx: ApiModuleContext,
) {
  const {
    appContext: app,
    auth: { requirePrincipal },
  } = ctx;
  server.get(
    "/api/v1/admin/ofapi/media",
    { schema: ofapiMediaRouteSchemas.ofapiMediaGet },
    async (request) => {
      const principal = await requirePrincipal(request);
      requireDashboardUser(principal);
      if (!canAccessPage(principal, request.query.pageId))
        throw new ForbiddenError();
      return readOfapiMedia(app, request.query);
    },
  );
  server.post(
    "/api/v1/admin/ofapi/media/sources",
    {
      bodyLimit: 140_000_000,
      schema: ofapiMediaRouteSchemas.ofapiMediaSourceCreate,
    },
    async (request) => {
      const principal = await requirePrincipal(request);
      requireOwner(principal);
      return captureOwnerOfapiMediaSource(app, request.body, principal.user.id);
    },
  );
  server.post(
    "/api/v1/admin/ofapi/media/uploads",
    { schema: ofapiMediaRouteSchemas.ofapiMediaUploadCreate },
    async (request) => {
      const principal = await requirePrincipal(request);
      requireOwner(principal);
      return createOwnerOfapiMediaUpload(app, request.body, principal.user.id);
    },
  );
  server.post(
    "/api/v1/admin/ofapi/media/uploads/:jobId/resume",
    { schema: ofapiMediaRouteSchemas.ofapiMediaUploadResume },
    async (request) => {
      const principal = await requirePrincipal(request);
      requireOwner(principal);
      return resumeOwnerOfapiMediaUpload(
        app,
        { ...request.body, jobId: request.params.jobId },
        principal.user.id,
      );
    },
  );
  server.post(
    "/api/v1/admin/ofapi/media/handoff",
    { schema: ofapiMediaRouteSchemas.ofapiMediaHandoff },
    async (request) => {
      const principal = await requirePrincipal(request);
      requireOwner(principal);
      return handoffOfapiMedia(app, request.body, principal.user.id);
    },
  );
}
