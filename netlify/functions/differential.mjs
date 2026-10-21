import { checkViewerAuth, checkRefreshAuth, json } from "../lib/auth.mjs";
import { collectDifferential, differentialCsv } from "../lib/differential.mjs";
import { readSnapshot, writeSnapshot, ageInMinutes } from "../lib/store.mjs";

// The underlying months only change once a month, so this is cached hard. The
// nightly job refreshes it; a reader past this age refreshes it themselves.
const STALE_AFTER_MINUTES = 24 * 60;

export default async (req) => {
  if (!checkViewerAuth(req).ok) {
    return json({ error: "unauthorized", message: "Report password required." }, 401);
  }

  const url = new URL(req.url);
  const span = Math.min(Math.max(Number(url.searchParams.get("span")) || 6, 1), 12);

  // The full export is every URL, which is a file rather than a table — built
  // on demand rather than cached, since nothing renders it.
  if (url.searchParams.get("format") === "csv") {
    try {
      const csv = await differentialCsv({ span });
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="adsitco-differential-${span}mo.csv"`,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      return json({ error: "collection_failed", message: err.message }, 502);
    }
  }

  const key = `differential-${span}mo`;
  const forceRequested = url.searchParams.get("force") === "1";
  const force = forceRequested && checkRefreshAuth(req);
  if (forceRequested && !force) {
    return json({ error: "forbidden", message: "Valid x-refresh-token required to force a refresh." }, 403);
  }

  const cached = await readSnapshot(key, "all");
  if (!force && cached && ageInMinutes(cached) <= STALE_AFTER_MINUTES) {
    return json({ ...cached, cache: "hit" });
  }

  try {
    const data = await collectDifferential({ span });
    if (data.rows.length) await writeSnapshot(key, data, "all");
    return json({ ...data, cache: force ? "forced" : "miss" });
  } catch (err) {
    if (cached) {
      return json({
        ...cached,
        cache: "stale",
        warnings: [`Refresh failed, showing cached data: ${err.message}`],
      });
    }
    return json({ error: "collection_failed", message: err.message }, 502);
  }
};

export const config = { path: "/api/differential" };
