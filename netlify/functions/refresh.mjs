import {
  collectSnapshot,
  resolveRange,
  rangeSignature,
  filterSignature,
  SUPPORTED_WINDOWS,
  hasUsableData,
} from "../lib/collect.mjs";
import { writeSnapshot } from "../lib/store.mjs";

/**
 * Scheduled pull. This is what keeps the report current: it runs every morning,
 * fetches a fresh snapshot for each selectable window, and writes it to Netlify
 * Blobs so page loads never wait on Google's APIs.
 *
 * Windows are collected in sequence and each is saved as soon as it lands, so a
 * run that is cut short still leaves the earlier windows updated. Anything it
 * misses is picked up lazily by the staleness check in report.mjs.
 */
export default async () => {
  const results = [];

  for (const days of SUPPORTED_WINDOWS) {
    try {
      // Only the unfiltered views are pre-warmed. Filtered combinations are
      // collected on demand and cached from then on — pre-warming every
      // combination would multiply the API calls for views nobody may open.
      const snapshot = await collectSnapshot({ range: resolveRange({ days }) });
      // Same rule as the read path: never overwrite good cached data with an
      // empty result from a run that could not reach Google.
      const usable = hasUsableData(snapshot);
      // Key by the filters the snapshot actually carries, not a hardcoded
      // "all": collectSnapshot applies the default country, so storing it
      // unfiltered would file a US-only snapshot under the worldwide key and
      // leave the default view a permanent cache miss.
      const signature = filterSignature(snapshot.filters);
      const persisted = usable
        ? await writeSnapshot(rangeSignature(resolveRange({ days })), snapshot, signature)
        : false;
      results.push({
        days,
        ok: usable,
        persisted,
        filters: signature,
        skipped: usable ? undefined : "no data returned — cache left untouched",
        ga4Rows: snapshot.ga4.daily.length,
        gscRows: snapshot.gsc.daily.length,
        warnings: snapshot.warnings,
      });
    } catch (err) {
      results.push({ days, ok: false, error: err.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify({ event: "report_refresh", at: new Date().toISOString(), results }),
  );

  if (failed.length === SUPPORTED_WINDOWS.length) {
    // Netlify surfaces a non-2xx scheduled run as a failure, which is what we
    // want when nothing at all could be collected.
    return new Response(JSON.stringify({ ok: false, results }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "content-type": "application/json" },
  });
};

// 06:15 UTC daily — after Google has finished processing the previous day.
export const config = { schedule: "15 6 * * *" };
