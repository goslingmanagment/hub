// WP-F4 — the media-stats wire shapes, shared by the DB-backed lane suite
// (fansly-media-stats-lane.integration.test.ts) and its pure-helper unit suite
// (fansly-media-stats-helpers.test.ts), so both build exactly the same bodies.

/**
 * One `/it/moie/statsnew` body, shaped exactly as the wire is: the subject at
 * `dataset.datasetMediaOfferId`, the served bounds at `dateAfter`/`dateBefore`,
 * and every `stats[]` row carrying the SEVEN served keys and no video fields.
 */
export function statsBody(options: {
  mediaOfferRef: string;
  afterMs: number;
  beforeMs: number;
  periodMs: number;
  buckets?: number;
  /** Serve a DIFFERENT window than the one asked for — the production shape. */
  servedAfterMs?: number;
  servedBeforeMs?: number;
  tags?: Array<{ tagId: string; views: number }>;
}) {
  const buckets = options.buckets ?? 2;
  return {
    dataset: {
      period: options.periodMs,
      dateBefore: options.servedBeforeMs ?? options.beforeMs,
      dateAfter: options.servedAfterMs ?? options.afterMs,
      datapointLimit: 100,
      datapoints: Array.from({ length: buckets }, (_unused, index) => ({
        timestamp: (options.servedAfterMs ?? options.afterMs) + index * options.periodMs,
        stats: [{
          type: index % 2,
          views: 10 + index,
          previewViews: 0,
          interactionTime: 1000 * (index + 1),
          previewInteractionTime: 0,
          uniqueViewers: 5 + index,
          previewUniqueViewers: 0,
        }],
      })),
      topFypTags: options.tags ?? [],
      datasetMediaOfferId: options.mediaOfferRef,
    },
    aggregationData: { accountMedia: [], accountMediaBundles: [], tags: [] },
  };
}

/**
 * The window this route serves for ANY depth it has no data for: one datapoint,
 * one stats row, every counter zero. Journaled verbatim like anything else; it
 * is the FLOOR RULE that has to read it as empty, or the walk goes to 2006.
 */
export function allZeroBody(options: {
  mediaOfferRef: string;
  afterMs: number;
  beforeMs: number;
  periodMs: number;
}) {
  return {
    dataset: {
      period: options.periodMs,
      dateBefore: options.beforeMs,
      dateAfter: options.afterMs,
      datapointLimit: 100,
      datapoints: [{
        timestamp: options.afterMs,
        stats: [{
          type: 0,
          views: 0,
          previewViews: 0,
          interactionTime: 0,
          previewInteractionTime: 0,
          uniqueViewers: 0,
          previewUniqueViewers: 0,
        }],
      }],
      topFypTags: [],
      datasetMediaOfferId: options.mediaOfferRef,
    },
    aggregationData: { accountMedia: [], accountMediaBundles: [], tags: [] },
  };
}
