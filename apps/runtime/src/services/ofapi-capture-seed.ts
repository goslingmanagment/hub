import { createHash, randomUUID } from "node:crypto";

import type {
  OfapiCaptureSeedBody,
  OfapiCaptureSeedResponse,
} from "@agency_hub_core/contracts";
import {
  createOrGetOfapiCaptureJob,
  findActiveOfapiCaptureJobBySlot,
  findCompletedOfapiCaptureJobByTarget,
  findPageById,
  findVisiblePageDmConversationByPlatformConversationId,
  getOfapiMessageCoverageServingState,
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  hashOfapiCaptureValue,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

export const OFAPI_OWNER_SEED_LIMITS = {
  maxTargets: 20,
  maxPagesPerJob: 3,
  maxCallsPerJob: 3,
  maxCreditsPerJob: 3,
  maxItemsPerJob: 300,
} as const;

interface ResolvedSeedTarget {
  pageId: number;
  ofapiAccountId: string;
  chatId: string;
  frozenHeadId: string;
  anchorMessageId: string;
  activeSlotKey: string;
  target: Record<string, unknown>;
  targetHash: string;
  jobId: string;
  alreadyCovered: boolean;
}

function deterministicSeedJobId(activeSlotKey: string, targetHash: string) {
  const bytes = createHash("sha256")
    .update(`ofapi-owner-seed-v1:${activeSlotKey}:${targetHash}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertExplicitTargets(targets: OfapiCaptureSeedBody["targets"]) {
  if (targets.length < 1 || targets.length > OFAPI_OWNER_SEED_LIMITS.maxTargets) {
    throw new BadRequestError(
      `OFAPI capture seed requires 1-${OFAPI_OWNER_SEED_LIMITS.maxTargets} explicit targets`,
    );
  }
  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.pageId}:${target.chatId}`;
    if (seen.has(key)) {
      throw new BadRequestError(`Duplicate OFAPI capture target ${key}`);
    }
    seen.add(key);
  }
}

async function resolveSeedTarget(
  app: AppContext,
  target: OfapiCaptureSeedBody["targets"][number],
): Promise<ResolvedSeedTarget> {
  const stored = await findPageById(app.db, target.pageId);
  if (!stored || stored.page.platform !== "onlyfans") {
    throw new NotFoundError(`Active OnlyFans page ${target.pageId} was not found`);
  }
  const ofapiAccountId = stored.page.ofapiAccountId;
  if (!ofapiAccountId) {
    throw new ConflictError(`OnlyFans page ${target.pageId} has no OFAPI account mapping`);
  }
  const conversation = await findVisiblePageDmConversationByPlatformConversationId(app.db, {
    platformAccountId: target.pageId,
    platformConversationId: target.chatId,
  });
  if (!conversation) {
    throw new NotFoundError(`Visible chat ${target.chatId} was not found on page ${target.pageId}`);
  }
  const frozenHeadId = conversation.lastMessageId;
  if (!frozenHeadId) {
    throw new ConflictError(`Chat ${target.chatId} on page ${target.pageId} has no frozen head`);
  }
  const coverage = await getOfapiMessageCoverageServingState(app.db, {
    pageId: target.pageId,
    chatId: target.chatId,
  });
  if (
    !coverage ||
    coverage.revokedAt !== null ||
    coverage.classification !== "continuous_history" ||
    coverage.proofPolicyVersion !== OFAPI_CAPTURE_PROOF_POLICY_VERSION ||
    coverage.frozenHeadId !== target.anchorMessageId
  ) {
    throw new ConflictError(
      `Anchor ${target.anchorMessageId} is not current verified continuous coverage for `
      + `page ${target.pageId} chat ${target.chatId}`,
    );
  }
  const activeSlotKey = `page:${target.pageId}:chat:${target.chatId}`;
  const frozenTarget = {
    chatId: target.chatId,
    frozenHeadId,
    anchorMessageId: target.anchorMessageId,
    limit: 100,
    reason: "owner_manual",
  };
  const targetHash = hashOfapiCaptureValue(frozenTarget);
  return {
    pageId: target.pageId,
    ofapiAccountId,
    chatId: target.chatId,
    frozenHeadId,
    anchorMessageId: target.anchorMessageId,
    activeSlotKey,
    target: frozenTarget,
    targetHash,
    jobId: deterministicSeedJobId(activeSlotKey, targetHash),
    alreadyCovered: frozenHeadId === coverage.frozenHeadId,
  };
}

export async function seedOwnerOfapiCaptureJobs(
  app: AppContext,
  input: OfapiCaptureSeedBody & { actorUserId: number },
): Promise<OfapiCaptureSeedResponse> {
  assertExplicitTargets(input.targets);
  const dryRun = input.dryRun !== false;
  const resolved: ResolvedSeedTarget[] = [];
  for (const target of input.targets) {
    resolved.push(await resolveSeedTarget(app, target));
  }

  const seedId = randomUUID();
  const manifest = {
    version: "ofapi-owner-explicit-seed-v1",
    seedId,
    actorUserId: input.actorUserId,
    targetCount: resolved.length,
    targetSlotKeys: resolved.map((target) => target.activeSlotKey),
    limits: OFAPI_OWNER_SEED_LIMITS,
  };
  const results: OfapiCaptureSeedResponse["results"] = [];

  for (const target of resolved) {
    if (target.alreadyCovered) {
      results.push({
        pageId: target.pageId,
        chatId: target.chatId,
        frozenHeadId: target.frozenHeadId,
        anchorMessageId: target.anchorMessageId,
        status: "already_covered",
        jobId: null,
        state: null,
        reasonCode: null,
      });
      continue;
    }

    const completed = await findCompletedOfapiCaptureJobByTarget(app.db, {
      activeSlotKey: target.activeSlotKey,
      targetHash: target.targetHash,
      kind: "chat_paginate",
      goal: "connect_to_anchor",
    });
    if (completed) {
      results.push({
        pageId: target.pageId,
        chatId: target.chatId,
        frozenHeadId: target.frozenHeadId,
        anchorMessageId: target.anchorMessageId,
        status: "already_captured",
        jobId: completed.id,
        state: completed.state,
        reasonCode: completed.reasonCode,
      });
      continue;
    }

    if (dryRun) {
      const active = await findActiveOfapiCaptureJobBySlot(app.db, target.activeSlotKey);
      if (active && active.targetHash !== target.targetHash) {
        throw new ConflictError(
          `Active job ${active.id} has a different frozen target for `
            + `page ${target.pageId} chat ${target.chatId}`,
        );
      }
      results.push({
        pageId: target.pageId,
        chatId: target.chatId,
        frozenHeadId: target.frozenHeadId,
        anchorMessageId: target.anchorMessageId,
        status: active ? "would_coalesce" : "would_create",
        jobId: active?.id ?? null,
        state: active?.state ?? null,
        reasonCode: active?.reasonCode ?? null,
      });
      continue;
    }

    const seeded = await createOrGetOfapiCaptureJob(app.db, {
      id: target.jobId,
      pageId: target.pageId,
      ofapiAccountId: target.ofapiAccountId,
      kind: "chat_paginate",
      goal: "connect_to_anchor",
      activeSlotKey: target.activeSlotKey,
      target: target.target,
      manifest,
      budgetScope: "bulk",
      originPrincipalId: input.actorUserId,
      createdBy: "owner",
      priority: 0,
      maxCalls: OFAPI_OWNER_SEED_LIMITS.maxCallsPerJob,
      maxCredits: OFAPI_OWNER_SEED_LIMITS.maxCreditsPerJob,
      maxPages: OFAPI_OWNER_SEED_LIMITS.maxPagesPerJob,
      maxItems: OFAPI_OWNER_SEED_LIMITS.maxItemsPerJob,
    });
    if (seeded.job.targetHash !== target.targetHash) {
      throw new ConflictError(
        `Active job ${seeded.job.id} has a different frozen target for `
          + `page ${target.pageId} chat ${target.chatId}`,
      );
    }
    results.push({
      pageId: target.pageId,
      chatId: target.chatId,
      frozenHeadId: target.frozenHeadId,
      anchorMessageId: target.anchorMessageId,
      status: seeded.created
        ? "created"
        : seeded.job.state === "complete" ? "already_captured" : "coalesced",
      jobId: seeded.job.id,
      state: seeded.job.state,
      reasonCode: seeded.job.reasonCode,
    });
  }

  return {
    dryRun,
    seedId,
    limits: OFAPI_OWNER_SEED_LIMITS,
    created: results.filter((result) =>
      result.status === "created" || result.status === "would_create"
    ).length,
    coalesced: results.filter((result) =>
      result.status === "coalesced" || result.status === "would_coalesce"
    ).length,
    skipped: results.filter((result) =>
      result.status === "already_covered" || result.status === "already_captured"
    ).length,
    results,
  };
}
