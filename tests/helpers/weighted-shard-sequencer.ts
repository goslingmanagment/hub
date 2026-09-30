import { readFileSync } from "node:fs";
import path from "node:path";

import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

import { SHARD_WEIGHTS_PATH, orderShardFiles, parseShardWeights, planWeightedShards } from "../../scripts/ci-shard-plan.mjs";

/** A spec's key in the weights file: its repo-relative path with forward slashes. */
export function shardKey(root: string, moduleId: string): string {
  return path.relative(root, moduleId).split(path.sep).join("/");
}

/**
 * `--shard=k/N` by measured duration instead of file count; see
 * scripts/ci-shard-plan.mjs. Vitest calls shard() only when --shard is given;
 * sort() then starts that shard's files heaviest first. Without --shard both
 * leave the run to BaseSequencer, so an unsharded run is exactly what it was.
 */
export class WeightedShardSequencer extends BaseSequencer {
  /**
   * A sharded run starts its files heaviest first, equal weights in path
   * order, instead of BaseSequencer's largest-file-first: a slow but small
   * file no longer starts last and runs alone. The files are shard()'s.
   */
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return super.sort(files);
    const weights = parseShardWeights(readFileSync(path.resolve(root, SHARD_WEIGHTS_PATH), "utf8"));
    return orderShardFiles(files, weights, spec => shardKey(root, spec.moduleId));
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weightsPath = path.resolve(root, SHARD_WEIGHTS_PATH);
    const weights = parseShardWeights(readFileSync(weightsPath, "utf8"));
    const plan = planWeightedShards(files.map(spec => shardKey(root, spec.moduleId)), weights, shard.count);
    const mine = new Set(plan.shards[shard.index - 1]);
    const selected = files.filter(spec => mine.has(shardKey(root, spec.moduleId)));
    // Shard 1's predicted load includes the API run it starts after this one.
    const predicted = (plan.seconds[shard.index - 1] ?? 0) - (shard.index === 1 ? weights.firstShardExtraSeconds : 0);
    const unweighted = plan.unweighted.length === 0 ? "" : `; ${plan.unweighted.length} without a recorded weight (median used)`;
    this.ctx.logger.log(
      `Weighted shard ${shard.index}/${shard.count}: ${selected.length} of ${files.length} files, ` +
      `~${Math.round(predicted)}s of file work predicted${unweighted} (${SHARD_WEIGHTS_PATH})`,
    );
    return selected;
  }
}
