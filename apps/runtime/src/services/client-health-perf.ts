/**
 * Percentiles of `client_health` perf histograms, read from their buckets.
 *
 * WHY THE HUB COUNTS THEM: a p95 cannot be assembled from the p95s of parts, so
 * clients send buckets and the hub merges them across reports and hours, then
 * reads percentiles off the merged buckets (the owner's view, H-11c). No client
 * needs this, so it lives in the runtime and is never vendored.
 *
 * Buckets follow CLIENT_HEALTH_PERF_METRICS: counts[0] holds values ≤ bounds[0]
 * (from 0, values are non-negative), counts[i] values in (bounds[i-1], bounds[i]],
 * and the last bucket values above the last bound, topped by the observed max.
 * Inside a bucket the values are taken as evenly spread (linear interpolation),
 * and no percentile is ever reported above the observed max.
 */

/** A group with fewer observations than this shows no percentiles. */
export const CLIENT_HEALTH_MIN_GROUP_SIZE = 20;

/** A histogram's buckets, as reported or merged (bounds may be the registry's own, readonly). */
export interface ClientHealthBuckets {
  readonly bounds: readonly number[];
  readonly counts: readonly number[];
  readonly max: number;
}

/** The q-th quantile (0…1) of a histogram; null when it holds no observation. */
export function clientHealthPercentile(buckets: ClientHealthBuckets, q: number): number | null {
  if (!(q >= 0 && q <= 1)) {
    throw new RangeError(`client_health percentile: q must be within [0, 1], got ${q}`);
  }
  const { bounds, counts, max } = buckets;
  if (counts.length !== bounds.length + 1) {
    throw new RangeError("client_health percentile: counts must have one more entry than bounds");
  }
  const total = counts.reduce((sum, bucket) => sum + bucket, 0);
  if (total === 0) {
    return null;
  }

  const rank = q * total;
  let below = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const inBucket = counts[index]!;
    if (inBucket > 0 && below + inBucket >= rank) {
      const lower = index === 0 ? 0 : bounds[index - 1]!;
      const upper = index < bounds.length ? bounds[index]! : Math.max(max, lower);
      return Math.min(lower + ((rank - below) / inBucket) * (upper - lower), max);
    }
    below += inBucket;
  }
  return max;
}

/**
 * Relative slack on `sum` checks: the client's sum is a floating-point running
 * total, the bucket-edge sums here are another; they may differ in the last bits.
 */
const SUM_SLACK = 1e-6;

/**
 * Whether a histogram's `max` and `sum` are what its buckets can hold: max in
 * the highest non-empty bucket, sum between what the bucket edges and max allow.
 * The report schema does not refuse a histogram that fails this (the client's
 * frozen schema does not check it, and one off histogram must not cost a report
 * its counters); the intake (H-11b) drops that histogram before it merges,
 * since a stray max or sum would skew the owner's percentiles and mean without
 * an error. Takes a histogram that parsed: counts = bounds + 1, increasing bounds.
 */
export function clientHealthHistogramFits(histogram: ClientHealthBuckets & { readonly sum: number }): boolean {
  const { bounds, counts, sum, max } = histogram;
  // The highest non-empty bucket.
  let top = counts.length - 1;
  while (top >= 0 && counts[top] === 0) {
    top -= 1;
  }
  if (top < 0) {
    return sum === 0 && max === 0;
  }
  // The bucket edges: (lower(i), upper(i)], the first from 0, the last up to max.
  const lower = (index: number) => (index === 0 ? 0 : bounds[index - 1]!);
  const upper = (index: number) => (index < bounds.length ? bounds[index]! : Number.POSITIVE_INFINITY);
  if ((top > 0 && !(max > lower(top))) || max > upper(top)) {
    return false;
  }
  // Every observation lies inside its bucket and never above max, and max is
  // one of them: in the highest bucket it stands in for one lower edge.
  let least = max - lower(top);
  let most = 0;
  for (let index = 0; index < counts.length; index += 1) {
    least += counts[index]! * lower(index);
    most += counts[index]! * Math.min(upper(index), max);
  }
  return sum >= least * (1 - SUM_SLACK) && sum <= most * (1 + SUM_SLACK);
}

/** p50 and p95 for one group; a group under `minGroupSize` observations is suppressed. */
export function clientHealthP50P95(
  buckets: ClientHealthBuckets,
  minGroupSize: number = CLIENT_HEALTH_MIN_GROUP_SIZE,
): { p50: number | null; p95: number | null; suppressed: boolean } {
  const total = buckets.counts.reduce((sum, bucket) => sum + bucket, 0);
  if (total < minGroupSize) {
    return { p50: null, p95: null, suppressed: true };
  }
  return {
    p50: clientHealthPercentile(buckets, 0.5),
    p95: clientHealthPercentile(buckets, 0.95),
    suppressed: false,
  };
}
