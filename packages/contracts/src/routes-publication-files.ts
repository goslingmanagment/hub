import { errorResponseSchema } from "./primitives.ts";
import { publicationPageParamsSchema } from "./publications.ts";
import {
  agentPublicationFileUploadQuerySchema,
  publicationFileIdParamsSchema,
  publicationFileListQuerySchema,
  publicationFileListResponseSchema,
  publicationFileSchema,
  publicationFileUploadQuerySchema,
  publicationFileUploadResponseSchema,
} from "./publication-files.ts";

// Files of publications (docs/plans/2026-10-23-wall-posts, plan PR 3): the
// owner uploads a photo or video for a model and reads what Hub keeps; an
// agent key with write:publication_drafts uploads one for a granted page's model. Bytes
// go in, metadata comes out; Hub reads the bytes itself when it publishes.

const owner = { kind: "owner-session" } as const;
const errors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
} as const;

export const publicationFileRouteSchemas = {
  adminPublicationFileUpload: {
    auth: owner, tags: ["admin"],
    summary: "Upload one photo or video for a model: the raw bytes are the request body (any Content-Type)."
      + " The type is read from the bytes (JPEG, PNG, GIF, WebP, MP4, MOV, WebM); the same bytes for the same"
      + " model answer the same file id",
    querystring: publicationFileUploadQuerySchema,
    response: {
      200: publicationFileUploadResponseSchema,
      ...errors,
      // the same bytes uploaded at the same moment: send again
      409: errorResponseSchema,
      // publication_file_too_large: over the per-file limit
      413: errorResponseSchema,
      // publication_file_type: not an image or video Hub publishes
      415: errorResponseSchema,
      // publication_files_full: kept files would pass the total limit
      507: errorResponseSchema,
    },
  },
  agentPublicationFileUpload: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "Upload one photo or video for a granted page's model (needs write:publication_drafts): the raw bytes"
      + " are the request body (any Content-Type). As the owner's upload: the same bytes answer the same file id",
    params: publicationPageParamsSchema,
    querystring: agentPublicationFileUploadQuerySchema,
    response: {
      200: publicationFileUploadResponseSchema,
      ...errors,
      409: errorResponseSchema,
      413: errorResponseSchema,
      415: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
      507: errorResponseSchema,
    },
  },
  adminPublicationFileList: {
    auth: owner, tags: ["admin"],
    summary: "Uploaded files of publications (metadata only), newest first, with who uses them and when Hub deletes the bytes",
    querystring: publicationFileListQuerySchema,
    response: { 200: publicationFileListResponseSchema, ...errors },
  },
  adminPublicationFileGet: {
    auth: owner, tags: ["admin"],
    summary: "One uploaded file of publications (metadata only), with its uses and retention",
    params: publicationFileIdParamsSchema,
    response: { 200: publicationFileSchema, ...errors },
  },
} as const;
