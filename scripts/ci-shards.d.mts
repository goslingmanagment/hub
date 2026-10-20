export type ShardPlan = { total: number; shards: number[]; warning: string };
export const DEFAULT_SHARD_TOTAL: number;
export const MAX_SHARD_TOTAL: number;
export const TARGET_SHARD_SECONDS: number;
export function neededShards(weights: unknown): number;
export function planShards(env: Readonly<Record<string, string | undefined>>, weights?: unknown): ShardPlan;
export function shardOutputs(plan: ShardPlan): string;
