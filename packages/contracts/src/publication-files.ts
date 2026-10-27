import { z } from "zod";

import { intId } from "./primitives.ts";
import { publicationStatusSchema } from "./publications.ts";

// Files of publications (docs/plans/2026-10-23-wall-posts, spec §7, plan PR 3):
// a new photo or video the owner uploads for a post. Hub keeps the bytes on the
// server's disk while any publication that uses the file is not finished, and
// 7 days after the last one finished; a file no publication used goes 7 days
// after its upload. Only metadata travels here.

/** An agent's upload (write:publication_drafts): the file is the page's model's; only its name is asked. */
export const agentPublicationFileUploadQuerySchema = z.strictObject({
  /** The file's own name, for people and as the upload's name on the platform; Hub never trusts it for the type. */
  name: z.string().max(255).optional(),
});

/** Who names the file's model: its slug, its id, or a page (the page's model). Exactly one. */
export const publicationFileUploadQuerySchema = z.object({
  modelSlug: z.string().min(1).max(100).optional(),
  modelId: z.coerce.number().int().positive().optional(),
  pageLabel: z.string().min(1).max(100).optional(),
  /** The file's own name, for people; Hub never trusts it for the type. */
  name: z.string().max(255).optional(),
}).refine(
  (value) => [value.modelSlug, value.modelId, value.pageLabel].filter((item) => item !== undefined).length === 1,
  { message: "name the model by exactly one of modelSlug, modelId or pageLabel" },
);

export const publicationFileUseSchema = z.object({
  publicationId: intId,
  pageLabel: z.string(),
  status: publicationStatusSchema,
  publishAt: z.string(),
  statusChangedAt: z.string(),
});

export const publicationFileSchema = z.object({
  id: intId,
  modelId: intId,
  modelSlug: z.string(),
  sha256: z.string(),
  byteSize: z.number().int().nullable(),
  /** Sniffed from the bytes (one of PUBLICATION_FILE_MIME_TYPES), never taken from the name or the request. */
  mimeType: z.string().nullable(),
  originalName: z.string().nullable(),
  createdByUserId: z.number().int().nullable(),
  createdAt: z.string(),
  /** When the bytes last landed: the upload, or a new upload of the same bytes. */
  storedAt: z.string(),
  /** False once retention deleted the bytes; uploading the same bytes again brings them back. */
  stored: z.boolean(),
  bytesDeletedAt: z.string().nullable(),
  /** When retention deletes the bytes; null while a publication that is not finished uses the file. */
  retainUntil: z.string().nullable(),
  /** The publications that name the file, as media or as a paid post's preview. */
  uses: z.array(publicationFileUseSchema),
});
export type PublicationFileWire = z.infer<typeof publicationFileSchema>;

export const publicationFileUploadResponseSchema = z.object({
  file: publicationFileSchema,
  /** False when the model already had these bytes: the same file id answers. */
  created: z.boolean(),
});

export const publicationFileListQuerySchema = z.object({
  modelSlug: z.string().min(1).max(100).optional(),
  /** Also the files whose bytes retention deleted. */
  includeDeleted: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export const publicationFileListResponseSchema = z.object({
  files: z.array(publicationFileSchema),
  /** Bytes of every kept file, and the two limits they live under (decimal units). */
  storedTotalBytes: z.number().int(),
  fileMaxBytes: z.number().int(),
  totalMaxBytes: z.number().int(),
});

export const publicationFileIdParamsSchema = z.object({ fileId: z.coerce.number().int().positive() });
