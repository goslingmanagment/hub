export type ShardPlan = { total: number; shards: number[]; warning: string };
export const DEFAULT_SHARD_TOTAL: number;
export const MAX_PC_SHARD_TOTAL: number;
export function planShards(env: Readonly<Record<string, string | undefined>>): ShardPlan;
export function shardOutputs(plan: ShardPlan): string;
