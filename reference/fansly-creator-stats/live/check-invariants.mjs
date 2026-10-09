#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

// Raw captures stay outside Git. The report never contains IDs or money values.
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith("--")) {
  console.error(
    "Usage: node check-invariants.mjs NETWORK_DIR [--output REPORT.json] [--self-test]",
  );
  process.exit(2);
}
const networkDir = path.resolve(args[0]);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
if (outputIndex >= 0 && !outputPath)
  throw new Error("--output requires a path");

const DAY = 86_400_000;
const captures = new Map();
const revenueFields = [
  "transactions",
  "grossMills",
  "netMills",
  "refunds",
  "refundedGrossMills",
  "refundedNetMills",
];
const files = fs
  .readdirSync(networkDir)
  .filter((file) => file.endsWith(".json"))
  .sort();
for (const file of files) {
  const capture = JSON.parse(
    fs.readFileSync(path.join(networkDir, file), "utf8"),
  );
  if (capture.url && capture.body?.response) captures.set(file, capture);
}

function runAudit(captures) {
  const groups = [];
  const observations = [];
  const captureOf = (file) => {
    const capture = captures.get(file);
    if (!capture) throw new Error(`Missing capture: ${file}`);
    if (capture.status !== 200 || capture.body?.success !== true) {
      throw new Error(`Capture is not a successful HTTP 200 response: ${file}`);
    }
    if (!capture.body.response || typeof capture.body.response !== "object") {
      throw new Error(`Capture response is missing: ${file}`);
    }
    return capture;
  };
  const responseOf = (file) => captureOf(file).body.response;
  const sum = (rows, key) =>
    rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const iso = (number) => new Date(Number(number)).toISOString();
  const monthStart = (number) => {
    const date = new Date(Number(number));
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  };
  const addMonth = (number) => {
    const date = new Date(number);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  };
  function group(name, inputFiles, run) {
    if (!inputFiles.length) throw new Error(`Group has no inputs: ${name}`);
    if (groups.some((item) => item.name === name))
      throw new Error(`Duplicate group: ${name}`);
    for (const file of inputFiles) if (file.endsWith(".json")) captureOf(file);
    const result = {
      name,
      captures: inputFiles,
      checks: 0,
      passed: 0,
      failed: 0,
      failedChecks: [],
    };
    const check = (name, pass) => {
      result.checks += 1;
      if (pass) result.passed += 1;
      else {
        result.failed += 1;
        result.failedChecks.push(name);
      }
    };
    run(check);
    if (result.checks === 0)
      throw new Error(`Group performed no checks: ${name}`);
    groups.push(result);
  }

  function checkInternalSeries(file, name) {
    group(name, [file], (check) => {
      const summary = responseOf(file);
      const targets = [];
      for (const source of [0, 1, 4]) {
        targets.push([
          `views.source${source}`,
          summary.views?.find((row) => Number(row.source) === source),
          ["views", "watchMs", "imageViews"],
        ]);
        targets.push([
          `engagement.mediaLikes.source${source}`,
          summary.engagement?.mediaLikes?.find(
            (row) => Number(row.source) === source,
          ),
          ["likes"],
        ]);
      }
      for (const [family, keys] of [
        ["profile", ["profileVisits"]],
        ["follows", ["follows", "unfollows"]],
        ["subscriptions", ["subscriptionsNew", "subscriptionsExpired"]],
        ["revenue", ["grossMills", "netMills", "refundedNetMills"]],
        ["engagement", ["postLikes", "comments"]],
      ])
        targets.push([family, summary[family], keys]);
      for (const [location, value, keys] of targets) {
        for (const key of keys) {
          const points = value?.series?.[key];
          if (
            !Array.isArray(points) ||
            points.length === 0 ||
            !points.every(
              (point) =>
                typeof point.value === "number" && Number.isFinite(point.value),
            ) ||
            typeof value?.[key]?.value !== "number" ||
            !Number.isFinite(value[key].value)
          ) {
            throw new Error(
              `Missing or invalid required series: ${file} summary.${location}.${key}`,
            );
          }
          check(
            `summary.${location}.${key}`,
            sum(points, "value") === value[key].value,
          );
        }
      }
    });
  }

  const summary30File = "earnings-initial-23938.1434.json";
  const summary400File = "probe-summary-history-window.json";
  const viewsFile = "probe-series-views-day-history-window.json";
  const summary30 = responseOf(summary30File);
  const summary400 = responseOf(summary400File);
  checkInternalSeries(summary30File, "summary_internal_series_30_days");
  checkInternalSeries(summary400File, "summary_internal_series_400_days");

  const otherSeries = [
    [
      "profile",
      "probe-series-profile-day.json",
      ["profileVisits", "profileWatchMs"],
    ],
    ["follows", "probe-series-follows-day.json", ["follows", "unfollows"]],
    [
      "subscriptions",
      "probe-series-subscriptions-day.json",
      [
        "subscriptionsNew",
        "subscriptionsRenewed",
        "subscriptionsExpired",
        "subscriptionsCancelled",
      ],
    ],
    ["revenue", "earnings-initial-23938.1436.json", revenueFields],
  ];
  group(
    "summary_vs_standalone_series",
    [
      summary30File,
      summary400File,
      viewsFile,
      ...otherSeries.map((item) => item[1]),
    ],
    (check) => {
      const rows = responseOf(viewsFile).rows;
      for (const [windowName, summary] of [
        ["30days", summary30],
        ["400days", summary400],
      ]) {
        for (const source of summary.views) {
          const selected = rows.filter(
            (row) =>
              Number(row.source) === source.source &&
              Number(row.bucket) >= Number(summary.afterBucket) &&
              Number(row.bucket) <= Number(summary.beforeBucket),
          );
          for (const field of [
            "views",
            "impressions",
            "watchMs",
            "videoViews",
            "completedViews",
            "replays",
            "imageViews",
            "imageImpressions",
            "imageWatchMs",
          ]) {
            check(
              `${windowName}.source${source.source}.${field}`,
              sum(selected, field) === Number(source[field].value),
            );
          }
          for (const [field, approximation, previousApproximation] of [
            [
              "uniqueViewers",
              "uniquesApproximate",
              "uniquesPreviousApproximate",
            ],
            [
              "uniqueImageViewers",
              "imageUniquesApproximate",
              "imageUniquesPreviousApproximate",
            ],
          ]) {
            observations.push({
              kind: "unique_metric_grain",
              captures: [
                summary === summary30 ? summary30File : summary400File,
                viewsFile,
              ],
              windowDays:
                (Number(summary.beforeBucket) - Number(summary.afterBucket)) /
                  DAY +
                1,
              source: source.source,
              field,
              approximate: source[approximation],
              previousApproximate: source[previousApproximation],
              dailySumEqualsPeriodValue:
                sum(selected, field) === Number(source[field].value),
            });
          }
        }
      }
      for (const [family, file, fields] of otherSeries) {
        const rows = responseOf(file).rows;
        for (const field of fields) {
          check(
            `30days.${family}.${field}`,
            sum(rows, field) === Number(summary30[family][field].value),
          );
        }
      }
    },
  );

  // An old shifted window distinguishes query-span clipping from loss of old data.
  const maySummaryFile = "probe-summary-shifted-may2024.json";
  const mayDailyFile = "probe-series-revenue-shifted-may2024.json";
  const monthlyFile = "earnings-initial-23938.1437.json";
  checkInternalSeries(
    maySummaryFile,
    "summary_internal_series_shifted_may_2024",
  );
  group(
    "shifted_old_revenue_reconciliation",
    [maySummaryFile, mayDailyFile, monthlyFile],
    (check) => {
      const summary = responseOf(maySummaryFile);
      const daily = responseOf(mayDailyFile);
      const monthlyRows = responseOf(monthlyFile).rows.filter(
        (row) => monthStart(row.bucket) === monthStart(summary.afterBucket),
      );
      const query = new URL(captureOf(maySummaryFile).url).searchParams;
      check(
        "requested_old_lower_boundary_preserved",
        Number(summary.afterBucket) === Number(query.get("after")),
      );
      check(
        "requested_old_upper_boundary_preserved",
        Number(summary.beforeBucket) === Number(query.get("before")),
      );
      for (const field of revenueFields) {
        check(
          `summary_daily.${field}`,
          Number(summary.revenue[field].value) === sum(daily.rows, field),
        );
        check(
          `monthly_daily.${field}`,
          sum(monthlyRows, field) === sum(daily.rows, field),
        );
      }
    },
  );

  const hourRevenueFile = "probe-series-revenue-hour-sep17.json";
  const dayRevenueFile = "earnings-initial-23938.1436.json";
  group(
    "hourly_revenue_inclusive_day",
    [hourRevenueFile, dayRevenueFile],
    (check) => {
      const hourly = responseOf(hourRevenueFile);
      const dailyRows = responseOf(dayRevenueFile).rows.filter(
        (row) => Number(row.bucket) === Number(hourly.beforeBucket),
      );
      check("nonempty_hourly_response", hourly.rows.length > 0);
      check(
        "hour_rows_exist_after_before_midnight",
        hourly.rows.some(
          (row) => Number(row.hourBucket) > Number(hourly.beforeBucket),
        ),
      );
      check(
        "all_hours_within_inclusive_end_day",
        hourly.rows.every(
          (row) =>
            Number(row.hourBucket) >= Number(hourly.afterBucket) &&
            Number(row.hourBucket) < Number(hourly.beforeBucket) + DAY,
        ),
      );
      for (const field of revenueFields) {
        check(
          `hour_daily.${field}`,
          sum(hourly.rows, field) === sum(dailyRows, field),
        );
      }
    },
  );

  const intradayFile = "probe-series-views-hour-intraday-bounds.json";
  group("hourly_intraday_query_day_normalization", [intradayFile], (check) => {
    const response = responseOf(intradayFile);
    const query = new URL(captureOf(intradayFile).url).searchParams;
    const requestedStart = Number(query.get("after"));
    const requestedEnd = Number(query.get("before"));
    check("request_has_intraday_lower_boundary", requestedStart % DAY !== 0);
    check("request_has_intraday_upper_boundary", requestedEnd % DAY !== 0);
    check(
      "lower_boundary_floored_to_utc_day",
      Number(response.afterBucket) === Math.floor(requestedStart / DAY) * DAY,
    );
    check(
      "upper_boundary_floored_to_utc_day",
      Number(response.beforeBucket) === Math.floor(requestedEnd / DAY) * DAY,
    );
    check(
      "rows_before_requested_lower_time",
      response.rows.some((row) => Number(row.hourBucket) < requestedStart),
    );
    check(
      "rows_after_requested_upper_time",
      response.rows.some((row) => Number(row.hourBucket) > requestedEnd),
    );
    check(
      "rows_inside_normalized_utc_days",
      response.rows.every(
        (row) =>
          Number(row.hourBucket) >= Number(response.afterBucket) &&
          Number(row.hourBucket) < Number(response.beforeBucket) + DAY,
      ),
    );
  });

  const viewsMonthFile = "probe-series-views-month.json";
  group(
    "views_month_request_reports_day_response",
    [viewsMonthFile],
    (check) => {
      const response = responseOf(viewsMonthFile);
      check(
        "requested_month",
        new URL(captureOf(viewsMonthFile).url).searchParams.get(
          "granularity",
        ) === "month",
      );
      check("returned_day", response.granularity === "day");
      check("daily_bucket_field", response.bucketField === "bucket");
      check(
        "contains_non_month_start_buckets",
        response.rows.some(
          (row) => Number(row.bucket) !== monthStart(row.bucket),
        ),
      );
    },
  );

  const coercedSourceFiles = [
    "probe-media-top-source2.json",
    "probe-media-top-source3.json",
  ];
  group(
    "media_sources_two_three_coerced_to_zero",
    coercedSourceFiles,
    (check) => {
      for (const [index, file] of coercedSourceFiles.entries()) {
        check(
          `request_source_${index + 2}`,
          Number(new URL(captureOf(file).url).searchParams.get("source")) ===
            index + 2,
        );
        check(
          `returned_source_${index + 2}_is_zero`,
          Number(responseOf(file).source) === 0,
        );
      }
      const identities = coercedSourceFiles.map((file) =>
        responseOf(file).offers.map((offer) => offer.mediaOfferId),
      );
      check(
        "same_ordered_offer_identities",
        isDeepStrictEqual(identities[0], identities[1]),
      );
    },
  );

  function parseCsv(file) {
    const input = fs.readFileSync(path.join(networkDir, file), "utf8");
    const process = spawnSync(
      "python3",
      [
        "-c",
        "import csv,json,sys; json.dump(list(csv.reader(sys.stdin)),sys.stdout)",
      ],
      {
        input: input.replace(/^\uFEFF/, ""),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (process.status !== 0) throw new Error(`CSV parser failed for ${file}`);
    return JSON.parse(process.stdout);
  }

  const productLabels = {
    7001: "Tips (Legacy)",
    7101: "Tips",
    2016: "Media Sets (Legacy)",
    2010: "Media (Legacy)",
    2116: "Media Sets",
    2110: "Media",
    15001: "Subscriptions",
    18001: "Referrals",
    18002: "Referrals",
    45001: "Stream Tickets",
    45101: "Stream Tickets",
    32001: "Locked Text",
    32101: "Locked Text",
    24101: "Leaderboard Prize Money",
    6101: "Refunds",
  };
  // This intentionally matches published balanceToDollarCents(default=true),
  // balanceToDollars, and CSV .toFixed(2), including flooring negative cents.
  const csvDollars = (mills) =>
    (
      Math.round((Math.floor(Number(mills || 0) / 10) / 100) * 100) / 100
    ).toFixed(2);
  function expectedCsv(response, granularity, statements) {
    const rows = response.rows || [];
    const totals = new Map();
    const families = new Map();
    const toBucket = (value) =>
      granularity === "month" ? monthStart(value) : Number(value);
    for (const row of rows) {
      const bucket = toBucket(row.bucket);
      let total = totals.get(bucket);
      if (!total) {
        total = Object.fromEntries(revenueFields.map((field) => [field, 0]));
        totals.set(bucket, total);
      }
      for (const field of revenueFields)
        total[field] += Number(row[field] || 0);
      if (Number(row.productType) === 6101) continue;
      const family = (
        productLabels[Number(row.productType)] || "Other"
      ).replace(/ \(Legacy\)$/, "");
      if (!families.has(family))
        families.set(family, { total: 0, buckets: new Map() });
      const entry = families.get(family);
      const value = Number(row.netMills || 0);
      entry.total += value;
      entry.buckets.set(bucket, (entry.buckets.get(bucket) || 0) + value);
    }
    const familyNames = [...families.keys()].sort(
      (left, right) => families.get(right).total - families.get(left).total,
    );
    const header = [
      "Date",
      "Purchases",
      "Gross",
      "Net",
      "Refunds",
      "Refunded",
      "Earnings",
      ...familyNames,
    ];
    const output = [header];
    const start = statements
      ? Math.min(...totals.keys())
      : toBucket(response.afterBucket);
    const end = toBucket(response.beforeBucket);
    for (
      let bucket = start;
      bucket <= end;
      bucket = granularity === "month" ? addMonth(bucket) : bucket + DAY
    ) {
      const total = totals.get(bucket) || {};
      output.push([
        iso(bucket).slice(0, granularity === "month" ? 7 : 10),
        String(total.transactions || 0),
        csvDollars(total.grossMills),
        csvDollars(total.netMills),
        String(total.refunds || 0),
        csvDollars(total.refundedNetMills),
        csvDollars((total.netMills || 0) - (total.refundedNetMills || 0)),
        ...familyNames.map((name) =>
          csvDollars(families.get(name).buckets.get(bucket) || 0),
        ),
      ]);
    }
    return output;
  }
  for (const [name, csvFile, responseFile, granularity, statements] of [
    [
      "period_csv_reconciliation",
      "earnings-export.csv",
      dayRevenueFile,
      "day",
      false,
    ],
    [
      "statements_csv_reconciliation",
      "statements-export.csv",
      monthlyFile,
      "month",
      true,
    ],
  ]) {
    group(name, [csvFile, responseFile], (check) => {
      const actual = parseCsv(csvFile);
      const expected = expectedCsv(
        responseOf(responseFile),
        granularity,
        statements,
      );
      check("row_count", actual.length === expected.length);
      check("header", isDeepStrictEqual(actual[0], expected[0]));
      for (let row = 1; row < expected.length; row += 1) {
        check(
          `row_${row}_column_count`,
          actual[row]?.length === expected[row].length,
        );
        for (let column = 0; column < expected[row].length; column += 1) {
          check(
            `row_${row}_column_${column}`,
            actual[row]?.[column] === expected[row][column],
          );
        }
      }
    });
  }

  const mediaCurrentFile = "011-overview-media-detail.json";
  const mediaLifetimeFile = "014-media-lifetime.json";
  const mediaHugeFile = "probe-media-detail-history-window.json";
  group(
    "media_selected_range_and_cumulative_fields",
    [mediaCurrentFile, mediaLifetimeFile, mediaHugeFile],
    (check) => {
      const current = responseOf(mediaCurrentFile);
      const lifetime = responseOf(mediaLifetimeFile);
      const huge = responseOf(mediaHugeFile);
      if (
        !current.media.length ||
        !lifetime.media.length ||
        !huge.media.length
      ) {
        throw new Error("Required selected-media fixtures are empty");
      }
      check(
        "same_offer_across_windows",
        current.mediaOfferId === lifetime.mediaOfferId &&
          lifetime.mediaOfferId === huge.mediaOfferId,
      );
      check("same_media_count", current.media.length === lifetime.media.length);
      for (let index = 0; index < current.media.length; index += 1) {
        const media = current.media[index];
        const longer = lifetime.media.find(
          (row) => row.mediaId === media.mediaId,
        );
        check(`media_${index}_identity_present`, Boolean(longer));
        if (!longer) continue;
        check(
          `media_${index}_totals_unchanged`,
          isDeepStrictEqual(media.totals, longer.totals),
        );
        check(
          `media_${index}_retention_unchanged`,
          isDeepStrictEqual(media.retention, longer.retention),
        );
        check(
          `media_${index}_retention_sample_unchanged`,
          media.retentionSampleSize === longer.retentionSampleSize,
        );
        const restricted = longer.daily.filter(
          (row) =>
            Number(row.bucket) >= Number(current.afterBucket) &&
            Number(row.bucket) <= Number(current.beforeBucket),
        );
        check(
          `media_${index}_daily_subwindow_equal`,
          isDeepStrictEqual(media.daily, restricted),
        );
        observations.push({
          kind: "media_range_scope",
          captures: [mediaCurrentFile, mediaLifetimeFile],
          mediaIndex: index,
          currentDailyRows: media.daily.length,
          longerDailyRows: longer.daily.length,
          dailyRowsetChanged: !isDeepStrictEqual(media.daily, longer.daily),
          totalsEqual: isDeepStrictEqual(media.totals, longer.totals),
          retentionEqual: isDeepStrictEqual(media.retention, longer.retention),
          retentionPointCount: media.retention.length,
          retentionSampleEqual:
            media.retentionSampleSize === longer.retentionSampleSize,
          totalsViewsEqualLongerDailySum:
            Number(media.totals?.views) === sum(longer.daily, "views"),
        });
      }
      check(
        "huge_query_matches_clipped_400_media",
        isDeepStrictEqual(lifetime.media, huge.media),
      );
      check(
        "huge_query_matches_clipped_400_likes",
        isDeepStrictEqual(lifetime.likes, huge.likes),
      );
      check(
        "huge_query_matches_clipped_400_tag_series",
        isDeepStrictEqual(lifetime.tagSeries, huge.tagSeries),
      );
    },
  );

  for (const [name, oneFile, allFile] of [
    [
      "media_all_sources_30_days",
      mediaCurrentFile,
      "010-overview-media-detail.json",
    ],
    [
      "media_all_sources_400_days",
      mediaLifetimeFile,
      "013-media-lifetime.json",
    ],
  ]) {
    group(name, [oneFile, allFile], (check) => {
      const one = responseOf(oneFile);
      const all = responseOf(allFile);
      if (!one.media.length || !all.media.length) {
        throw new Error(
          `Required source-comparison media fixture is empty: ${name}`,
        );
      }
      check("same_offer", one.mediaOfferId === all.mediaOfferId);
      check("all_source_selector", Number(all.source) === -1);
      for (let index = 0; index < all.media.length; index += 1) {
        const media = all.media[index];
        const matching = one.media.find((row) => row.mediaId === media.mediaId);
        check(
          `media_${index}_source0_daily_matches`,
          Boolean(matching) &&
            isDeepStrictEqual(
              media.daily.filter((row) => Number(row.source) === 0),
              matching.daily,
            ),
        );
        check(`media_${index}_totals_null`, media.totals === null);
        check(`media_${index}_retention_empty`, media.retention.length === 0);
        check(`media_${index}_tags_empty`, media.tags.length === 0);
        check(`media_${index}_hours_empty`, media.hours.length === 0);
      }
    });
  }

  const firstPageFile = "probe-fan-transactions-page1.json";
  const secondPageFile = "probe-fan-transactions-page2.json";
  group(
    "fan_transaction_cursor_continuity",
    [firstPageFile, secondPageFile],
    (check) => {
      const first = responseOf(firstPageFile);
      const second = responseOf(secondPageFile);
      const firstQuery = new URL(captureOf(firstPageFile).url).searchParams;
      const secondQuery = new URL(captureOf(secondPageFile).url).searchParams;
      for (const key of ["correlationAccountId", "after", "before", "limit"]) {
        check(
          `same_request_${key}`,
          firstQuery.get(key) === secondQuery.get(key),
        );
      }
      check(
        "page2_uses_page1_next_cursor",
        secondQuery.get("cursor") === first.nextCursor,
      );
      const firstIds = new Set(first.data.map((row) => row.transactionId));
      check(
        "cross_page_no_overlap",
        second.data.every((row) => !firstIds.has(row.transactionId)),
      );
      for (const [name, response, query] of [
        ["first", first, firstQuery],
        ["second", second, secondQuery],
      ]) {
        check(`${name}_nonempty`, response.data.length > 0);
        check(
          `${name}_within_limit`,
          response.data.length <= Number(query.get("limit")),
        );
        check(
          `${name}_no_duplicate_ids`,
          new Set(response.data.map((row) => row.transactionId)).size ===
            response.data.length,
        );
        check(
          `${name}_next_cursor_is_last_id`,
          response.nextCursor === response.data.at(-1)?.transactionId,
        );
        check(
          `${name}_timestamps_descending`,
          response.data.every(
            (row, index, rows) =>
              index === 0 ||
              Number(rows[index - 1].createdAt) >= Number(row.createdAt),
          ),
        );
      }
      check(
        "second_page_older_than_first",
        Math.max(...second.data.map((row) => Number(row.createdAt))) <=
          Math.min(...first.data.map((row) => Number(row.createdAt))),
      );
      observations.push({
        kind: "cursor_page_coverage",
        captures: [firstPageFile, secondPageFile],
        combinedUniqueRows: new Set(
          [...first.data, ...second.data].map((row) => row.transactionId),
        ).size,
        firstHasMore: first.hasMore,
        secondHasMore: second.hasMore,
        exhaustionEstablished: second.hasMore === false,
      });
    },
  );

  const mediaLimitFiles = [
    "probe-media-top-timeline-limit200.json",
    "probe-media-top-timeline-limit1000.json",
  ];
  group("repeated_large_media_limits", mediaLimitFiles, (check) => {
    const first = responseOf(mediaLimitFiles[0]);
    const second = responseOf(mediaLimitFiles[1]);
    check("same_count", first.offers.length === second.offers.length);
    check(
      "same_ordered_offer_identities",
      isDeepStrictEqual(
        first.offers.map((offer) => offer.mediaOfferId),
        second.offers.map((offer) => offer.mediaOfferId),
      ),
    );
    observations.push({
      kind: "large_limit_response_sizes",
      captures: mediaLimitFiles,
      requestedLimits: mediaLimitFiles.map((file) =>
        Number(new URL(captureOf(file).url).searchParams.get("limit")),
      ),
      returnedRows: [first.offers.length, second.offers.length],
      observedSameOrderedIdentities: isDeepStrictEqual(
        first.offers.map((offer) => offer.mediaOfferId),
        second.offers.map((offer) => offer.mediaOfferId),
      ),
    });
  });

  const watchLiftFiles = [
    "probe-media-top-watchlift20.json",
    "probe-media-top-views20.json",
    "002-overview-initial.json",
  ];
  group("watch_lift_eligibility_and_ranking", watchLiftFiles, (check) => {
    const ranked = responseOf(watchLiftFiles[0]);
    const byViews = responseOf(watchLiftFiles[1]);
    const benchmark = responseOf(watchLiftFiles[2]);
    if (
      !ranked.offers.length ||
      !byViews.offers.length ||
      !benchmark.buckets.length
    ) {
      throw new Error("Required watch-lift fixtures are empty");
    }
    const score = (offer) => {
      const media =
        offer.media.find((row) => row.mediaId === offer.bestMediaId) ||
        offer.media[0];
      const bucket = benchmark.buckets.find(
        (row) =>
          media.durationMs >= (row.minMs || 0) &&
          (!row.maxMs || media.durationMs < row.maxMs),
      );
      return {
        media,
        eligible:
          media.videoViews >= 50 &&
          Boolean(bucket) &&
          bucket.mediaCount >= 3 &&
          bucket.videoViews > 0,
        lift:
          media.videoViews && bucket
            ? media.watchPctSum / media.videoViews / 100 -
              bucket.avgWatchPercent
            : null,
      };
    };
    for (const [label, response] of [
      ["watch_lift", ranked],
      ["views", byViews],
    ]) {
      for (const field of ["afterBucket", "beforeBucket", "source"]) {
        check(
          `${label}.aligned_${field}`,
          response[field] === benchmark[field],
        );
      }
    }
    const expected = byViews.offers
      .filter((offer) => score(offer).eligible)
      .sort((left, right) => score(right).lift - score(left).lift);
    check(
      "contains_eligible_subset",
      expected.length > 0 && expected.length < byViews.offers.length,
    );
    check(
      "same_eligible_set_and_formula_order",
      isDeepStrictEqual(
        ranked.offers.map((offer) => offer.mediaOfferId),
        expected.map((offer) => offer.mediaOfferId),
      ),
    );
    for (const [index, offer] of ranked.offers.entries()) {
      const matching = byViews.offers.find(
        (row) => row.mediaOfferId === offer.mediaOfferId,
      );
      check(`rank_${index + 1}_eligible`, score(offer).eligible);
      check(
        `rank_${index + 1}_media_matches_views`,
        Boolean(matching) &&
          isDeepStrictEqual(score(offer).media, score(matching).media),
      );
    }
    observations.push({
      kind: "watch_lift_recomputed_ranking",
      captures: watchLiftFiles,
      viewsOfferCount: byViews.offers.length,
      watchLiftOfferCount: ranked.offers.length,
      eligibleOfferCount: expected.length,
      excludedOfferCount: byViews.offers.length - expected.length,
      sameEligibleSetAndFormulaOrder: isDeepStrictEqual(
        ranked.offers.map((offer) => offer.mediaOfferId),
        expected.map((offer) => offer.mediaOfferId),
      ),
    });
  });

  const geoFile = "probe-geo-history-limit200.json";
  group(
    "geographic_media_reconciliation",
    [geoFile, summary400File],
    (check) => {
      const geo = responseOf(geoFile);
      const source = summary400.views.find(
        (row) => Number(row.source) === Number(geo.source),
      );
      for (const field of ["views", "imageViews", "watchMs", "videoViews"]) {
        check(
          `media_geo.${field}`,
          sum(geo.rows, field) === Number(source[field].value),
        );
      }
      observations.push({
        kind: "profile_geographic_coverage",
        captures: [geoFile, summary400File],
        profileCountryRows: geo.profileRows.length,
        geoSumEqualsAllProfileVisits:
          sum(geo.profileRows, "profileVisits") ===
          Number(summary400.profile.profileVisits.value),
        geoSumLessThanAllProfileVisits:
          sum(geo.profileRows, "profileVisits") <
          Number(summary400.profile.profileVisits.value),
      });
    },
  );

  const tagWindowFiles = [
    "probe-tags-kind1-limit200.json",
    "probe-tags-history-window.json",
  ];
  observations.push({
    kind: "tag_lift_window_availability",
    captures: tagWindowFiles,
    windows: tagWindowFiles.map((file) => {
      const response = responseOf(file);
      return {
        effectiveInclusiveDays:
          (Number(response.beforeBucket) - Number(response.afterBucket)) / DAY +
          1,
        rows: response.rows.length,
        liftAvailable: response.liftAvailable,
        rowsWithLiftField: response.rows.filter((row) =>
          Object.hasOwn(row, "liftPoints"),
        ).length,
      };
    }),
  });

  function rowHorizon(rows, field) {
    const values = rows
      .map((row) => Number(row[field]))
      .filter((value) => Number.isFinite(value) && value > 0);
    const buckets = [...new Set(values)].sort((left, right) => left - right);
    if (!buckets.length) return { rows: rows.length, timestampBuckets: 0 };
    return {
      rows: rows.length,
      timestampBuckets: buckets.length,
      firstBucket: iso(buckets[0]),
      lastBucket: iso(buckets.at(-1)),
      observedSpanDays: (buckets.at(-1) - buckets[0]) / DAY,
    };
  }
  for (const [file, capture] of captures) {
    const response = capture.body.response;
    const query = new URL(capture.url).searchParams;
    if (Number(response.afterBucket) > 0 && Number(response.beforeBucket) > 0) {
      const observation = {
        kind: "query_window_and_row_horizon",
        capture: file,
        requestedAfter: query.has("after") ? iso(query.get("after")) : null,
        requestedBefore: query.has("before") ? iso(query.get("before")) : null,
        effectiveAfter: iso(response.afterBucket),
        effectiveBefore: iso(response.beforeBucket),
        effectiveInclusiveDays:
          (Number(response.beforeBucket) - Number(response.afterBucket)) / DAY +
          1,
      };
      if (query.has("after") && query.has("before")) {
        observation.requestedInclusiveDays =
          (Number(query.get("before")) - Number(query.get("after"))) / DAY + 1;
        observation.lowerBoundaryShiftDays =
          (Number(response.afterBucket) - Number(query.get("after"))) / DAY;
        observation.upperBoundaryShiftDays =
          (Number(response.beforeBucket) - Number(query.get("before"))) / DAY;
      }
      if (query.has("source") && typeof response.source === "number") {
        observation.requestedSource = Number(query.get("source"));
        observation.effectiveSource = response.source;
      }
      if (
        query.has("granularity") &&
        typeof response.granularity === "string"
      ) {
        observation.requestedGranularity = query.get("granularity");
        observation.effectiveGranularity = response.granularity;
      }
      if (Array.isArray(response.rows)) {
        const field = response.bucketField || "bucket";
        observation.rowHorizon = rowHorizon(response.rows, field);
        if (field === "hourBucket") {
          observation.hourRowsAfterBeforeMidnight = response.rows.filter(
            (row) => Number(row.hourBucket) > Number(response.beforeBucket),
          ).length;
          observation.hourRowsBeyondInclusiveEndDay = response.rows.filter(
            (row) =>
              Number(row.hourBucket) >= Number(response.beforeBucket) + DAY,
          ).length;
        }
      }
      if (response.levels)
        observation.levelHorizon = rowHorizon(response.levels, "bucket");
      if (response.series)
        observation.tagSeriesHorizon = rowHorizon(response.series, "bucket");
      if (response.offers) observation.offerRows = response.offers.length;
      if (response.media)
        observation.media = response.media.map((media, index) => ({
          mediaIndex: index,
          daily: rowHorizon(media.daily || [], "bucket"),
          hours: rowHorizon(media.hours || [], "hourBucket"),
          totalsNull: media.totals === null,
          retentionPoints: (media.retention || []).length,
        }));
      if (response.dataSince) observation.dataSince = iso(response.dataSince);
      observations.push(observation);
    }
    if (response.data && typeof response.hasMore === "boolean") {
      observations.push({
        kind: "transaction_page_state",
        capture: file,
        rows: response.data.length,
        hasMore: response.hasMore,
        nextCursorPresent: Boolean(response.nextCursor),
      });
    }
  }

  const checks = groups.reduce((total, item) => total + item.checks, 0);
  const failed = groups.reduce((total, item) => total + item.failed, 0);
  const report = {
    formatVersion: 1,
    scope:
      "Saved-response consistency; observations do not establish retention or global endpoint maxima.",
    inputCounts: { jsonCaptures: captures.size, csvCaptures: 2 },
    summary: { groups: groups.length, checks, passed: checks - failed, failed },
    groups,
    observations,
  };
  return report;
}

const report = runAudit(captures);
if (args.includes("--self-test")) {
  const results = [];
  const rejects = (name, mutate) => {
    const modified = globalThis.structuredClone(captures);
    mutate(modified);
    let rejected;
    try {
      rejected = runAudit(modified).summary.failed > 0;
    } catch {
      rejected = true;
    }
    results.push({ name, passed: rejected });
    if (!rejected)
      throw new Error(`Negative self-test accepted invalid fixtures: ${name}`);
  };
  rejects("http_error_with_existing_response_rejected", (modified) => {
    for (const capture of modified.values()) capture.status = 503;
  });
  rejects("unsuccessful_body_with_existing_response_rejected", (modified) => {
    for (const capture of modified.values()) capture.body.success = false;
  });
  const stripSeries = (value) => {
    if (!value || typeof value !== "object") return;
    delete value.series;
    for (const child of Object.values(value))
      if (typeof child === "object") stripSeries(child);
  };
  rejects("missing_summary_series_rejected", (modified) => {
    for (const capture of modified.values()) {
      if (new URL(capture.url).pathname.endsWith("/stats/summary"))
        stripSeries(capture.body.response);
    }
  });
  rejects("empty_required_summary_series_rejected", (modified) => {
    modified.get(
      "earnings-initial-23938.1434.json",
    ).body.response.profile.series.profileVisits = [];
  });
  rejects("reversed_watch_lift_order_rejected", (modified) => {
    modified
      .get("probe-media-top-watchlift20.json")
      .body.response.offers.reverse();
  });
  report.selfTests = {
    checks: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: 0,
    results,
  };
}
const output = JSON.stringify(report, null, 2) + "\n";
if (outputPath) fs.writeFileSync(path.resolve(outputPath), output);
else process.stdout.write(output);
if (outputPath) console.log(JSON.stringify(report.summary));
process.exitCode = report.summary.failed ? 1 : 0;
