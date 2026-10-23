import type { Readable } from "node:stream";

import { routeSchemas } from "@agency_hub_core/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { auditCtx } from "../../api/request-auth.ts";
import { recordAudit } from "../../services/auth.ts";
import {
  getPublicationFileWire,
  listPublicationFilesWire,
  uploadPublicationFile,
  type PublicationFileModelSelector,
} from "../../services/publication-files.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** The owner's upload of a file of publications in the audit log. */
export const PUBLICATION_FILE_UPLOAD_AUDIT_EVENT = "admin.publication_file_upload";

/**
 * Files of publications (docs/plans/2026-10-23-wall-posts, plan PR 3): the
 * owner uploads a photo or video for a model and reads what Hub keeps
 * (metadata only). The upload's body is the raw file, streamed to disk as it
 * arrives — never parsed and never buffered — so its route lives in its own
 * plugin scope whose only body parser hands the request stream through. The
 * size limit is enforced while it streams (services/publication-files.ts),
 * not by Fastify's bodyLimit.
 */
export async function registerPublicationFileRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  await server.register(async (plugin) => {
    const instance = plugin.withTypeProvider<ZodTypeProvider>();
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });

    instance.post("/api/v1/admin/publications/files", { schema: routeSchemas.adminPublicationFileUpload }, async (request, reply) => {
      const principal = await requirePrincipal(request);
      const { modelSlug, modelId, pageLabel, name } = request.query;
      const model: PublicationFileModelSelector = modelSlug !== undefined
        ? { slug: modelSlug }
        : modelId !== undefined ? { id: modelId } : { pageLabel: pageLabel ?? "" };
      const declared = Number(request.headers["content-length"]);
      try {
        const result = await uploadPublicationFile(appContext, {
          body: request.body as Readable,
          declaredLength: Number.isSafeInteger(declared) && declared >= 0 ? declared : null,
          model,
          originalName: name ?? null,
          userId: principal.user.id,
        });
        await recordAudit({ db: appContext.db }, {
          ...auditCtx(principal),
          eventType: PUBLICATION_FILE_UPLOAD_AUDIT_EVENT,
          metadata: {
            fileId: result.file.id,
            modelSlug: result.file.modelSlug,
            sha256: result.file.sha256,
            byteSize: result.file.byteSize,
            mimeType: result.file.mimeType,
            created: result.created,
          },
        });
        return result;
      } catch (error) {
        // A refusal can come before the body was read: close the connection
        // rather than read the rest of a file nobody keeps.
        reply.header("connection", "close");
        throw error;
      }
    });
  });

  server.get("/api/v1/admin/publications/files", { schema: routeSchemas.adminPublicationFileList }, async (request) => {
    await requirePrincipal(request);
    return listPublicationFilesWire(appContext, request.query);
  });

  server.get("/api/v1/admin/publications/files/:fileId", { schema: routeSchemas.adminPublicationFileGet }, async (request) => {
    await requirePrincipal(request);
    return getPublicationFileWire(appContext.db, request.params.fileId);
  });
}
