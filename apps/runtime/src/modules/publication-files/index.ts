import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import { routeSchemas } from "@agency_hub_core/contracts";
import { getAgentKeyById } from "@agency_hub_core/db";
import type { FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { auditCtx } from "../../api/request-auth.ts";
import { recordAudit } from "../../services/auth.ts";
import { ConflictError } from "../../services/errors.ts";
import { parseByteRange, resolveOfapiUploadLink } from "../../services/ofapi-upload-links.ts";
import {
  getPublicationFileWire,
  listPublicationFilesWire,
  lookupPublicationFiles,
  uploadPublicationFile,
  type PublicationFileModelSelector,
} from "../../services/publication-files.ts";
import { AGENT_TIMEOUT_MS, beginAgentRequest, staticNotFound, withAgentTimeout, writeAgentAudit } from "../agent-read/index.ts";
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
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;

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

    // An agent's upload (write:publication_drafts): the file of a granted
    // page's model, kept and counted as the owner's — the key's owner is its
    // uploader — so a draft of the agent can name it.
    instance.post("/api/v1/agent/pages/:pageLabel/publication-files", { schema: routeSchemas.agentPublicationFileUpload }, async (request, reply) => {
      const principal = await requireAgentKeyPrincipal(request);
      const scope = await beginAgentRequest(appContext, principal, {
        operation: "agentPublicationFileUpload", requiredCapabilities: ["write:publication_drafts"],
      });
      let delivered = 0;
      try {
        const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
        if (!page) throw staticNotFound();
        const key = await getAgentKeyById(appContext.db, principal.agentKeyId);
        if (key?.createdBy == null) throw new ConflictError("this key names no owner to upload for: issue a new key");
        const declared = Number(request.headers["content-length"]);
        const result = await uploadPublicationFile(appContext, {
          body: request.body as Readable,
          declaredLength: Number.isSafeInteger(declared) && declared >= 0 ? declared : null,
          model: { pageLabel: page.pageLabel },
          originalName: request.query.name ?? null,
          userId: key.createdBy,
        });
        await writeAgentAudit(appContext.db, {
          agentKeyId: principal.agentKeyId,
          operation: "agentPublicationFileUpload",
          pageIds: [page.id],
          verbatimText: false,
          requestSummary: { fileId: result.file.id, fileSha256: result.file.sha256, byteSize: result.file.byteSize, created: result.created },
        });
        delivered = 1;
        // A file is the model's, and its other pages may be outside the grant: only the key's own pages' uses answer.
        const granted = new Set(scope.pages.map((candidate) => candidate.pageLabel));
        return { ...result, file: { ...result.file, uses: result.file.uses.filter((use) => granted.has(use.pageLabel)) } };
      } catch (error) {
        reply.header("connection", "close");
        throw error;
      } finally {
        await scope.finish(delivered);
      }
    });
  });

  // Before an upload, an agent asks which of its files the page's model holds
  // (write:publication_drafts, as the upload): a pack sent again after a break
  // sends only what is missing. The page's model's files answer and nothing
  // else, without their uses; `keep` holds them as a new upload of the same
  // bytes would, so they outlive the rest of the pack's upload.
  server.post("/api/v1/agent/pages/:pageLabel/publication-files/lookup", { schema: routeSchemas.agentPublicationFileLookup }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, {
      operation: "agentPublicationFileLookup", requiredCapabilities: ["write:publication_drafts"],
    });
    let delivered = 0;
    try {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const { files, keep } = request.body;
      const answered = await withAgentTimeout(appContext.db, AGENT_TIMEOUT_MS.short, (tx) => lookupPublicationFiles(tx, appContext.config, {
        model: { pageLabel: page.pageLabel }, files, keep,
      }), "agent_publication_file_lookup");
      const heldIds = [...new Set(answered.flatMap((entry) => (entry.file === null ? [] : [entry.file.id])))];
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPublicationFileLookup",
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: { asked: files.length, held: heldIds.length, keep },
      });
      delivered = heldIds.length;
      return { files: answered };
    } finally {
      await scope.finish(delivered);
    }
  });

  server.get("/api/v1/admin/publications/files", { schema: routeSchemas.adminPublicationFileList }, async (request) => {
    await requirePrincipal(request);
    return listPublicationFilesWire(appContext, request.query);
  });

  server.get("/api/v1/admin/publications/files/:fileId", { schema: routeSchemas.adminPublicationFileGet }, async (request) => {
    await requirePrincipal(request);
    return getPublicationFileWire(appContext.db, request.params.fileId);
  });

  // A large file of an OnlyFans vault album, downloaded by OnlyFansAPI by its
  // link (8-docs 2026-11-12-of-vault-album, plan PR 7;
  // services/ofapi-upload-links.ts). Public: the token is the key. Its request
  // line carries the token, so Hub's request log skips it (`logLevel: "warn"`,
  // as the sign-in steps do); nginx's location for it keeps no access log.
  // GET and Fastify's HEAD twin; a GET is counted with its address.
  server.get("/api/v1/public/vault-upload-files/:token", {
    schema: routeSchemas.publicVaultUploadFile,
    logLevel: "warn",
    config: { rateLimit: { max: 600, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const head = request.method === "HEAD";
    const file = await resolveOfapiUploadLink(appContext, request.params.token, {
      fetch: head ? null : { address: request.ip },
    });
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Accept-Ranges", "bytes");
    const range = parseByteRange(typeof request.headers.range === "string" ? request.headers.range : undefined, file.byteSize);
    if (range === "unsatisfiable") {
      reply.code(416).header("Content-Range", `bytes */${file.byteSize}`).type("text/plain");
      return reply.send("");
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.byteSize - 1;
    reply.type(file.mimeType);
    reply.header("Content-Length", String(end - start + 1));
    if (range !== null) {
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${file.byteSize}`);
    }
    if (head) {
      // Fastify would answer an empty HEAD with Content-Length 0: the headers go as they are.
      reply.hijack();
      reply.raw.writeHead(reply.statusCode, reply.getHeaders() as Record<string, string>);
      reply.raw.end();
      return reply;
    }
    // A binary body: the typed reply knows only the JSON shapes of the contract.
    return (reply as unknown as FastifyReply).send(createReadStream(file.path, { start, end }));
  });
}
