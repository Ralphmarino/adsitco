import { checkViewerAuth, checkRefreshAuth, json } from "../lib/auth.mjs";
import {
  collectSnapshot,
  normaliseWindow,
  normaliseFilters,
  filterSignature,
} from "../lib/collect.mjs";
import { readSnapshot, writeSnapshot, ageInMinutes } from "../lib/store.mjs";

// The scheduled job refreshes daily. If it has not run — a paused site, a
// failed job, a window nobody has viewed yet — the first reader past this age
// pulls fresh data instead of showing a stale report.
const STALE_AFTER_MINUTES = 12 * 60;

export default async (req) => {
  const auth = checkViewerAuth(req);
  if (!auth.ok) {
    return json({ error: "unauthorized", message: "Report password required." }, 401);
  }

  const url = new URL(req.url);
  const days = normaliseWindow(url.searchParams.get("days") ?? 28);
  const filters = normaliseFilters({
    device: url.searchParams.get("device"),
    channel: url.searchParams.get("channel"),
  });
  const signature = filterSignature(filters);
  const forceRequested = url.searchParams.get("force") === "1";
  const force = forceRequested && checkRefreshAuth(req);

  if (forceRequested && !force) {
    return json({ error: "forbidden", message: "Valid x-refresh-token required to force a refresh." }, 403);
  }

  const cached = await readSnapshot(days, signature);
  const stale = !cached || ageInMinutes(cached) > STALE_AFTER_MINUTES;

  if (!force && !stale) {
    return json({ ...cached, cache: "hit" });
  }

  try {
    const snapshot = await collectSnapshot({ days, filters });
    await writeSnapshot(days, snapshot, signature);
    return json({ ...snapshot, cache: force ? "forced" : "miss" });
  } catch (err) {
    if (cached) {
      // Serving yesterday's numbers beats serving an error page.
      return json({
        ...cached,
        cache: "stale",
        warnings: [...(cached.warnings || []), `Refresh failed, showing cached data: ${err.message}`],
      });
    }
    return json({ error: "collection_failed", message: err.message }, 502);
  }
};

export const config = { path: "/api/report" };
