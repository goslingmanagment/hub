import type { ShardWeights } from "./ci-shard-plan.mjs";

export type ParsedJobLog = { files: { file: string; seconds: number }[]; apiSeconds: number | null };
export function parseJobLog(text: string): ParsedJobLog;
export function buildShardWeights(jobs: readonly ParsedJobLog[], previous: ShardWeights | undefined, exists: (file: string) => boolean): ShardWeights;
export function formatShardWeights(weights: ShardWeights): string;
