import { checkViewerAuth, checkRefreshAuth, json } from "../lib/auth.mjs";
import { collectBlogTracker } from "../lib/blog.mjs";
import { readSnapshot, writeSnapshot, ageInMinutes } from "../lib/store.mjs";

// The sitemap changes when a post is published or edited, so a day-old view is
// current enough; the nightly job keeps it warm.
const STALE_AFTER_MINUTES = 12 * 60;
const CACHE_KEY = "blog-tracker";

export default async (req) => {
  if (!checkViewerAuth(req).ok) {
    return json({ error: "unauthorized", message: "Report password required." }, 401);
  }

  const url = new URL(req.url);
  const forceRequested = url.searchParams.get("force") === "1";
  const force = forceRequested && checkRefreshAuth(req);
  if (forceRequested && !force) {
    return json({ error: "forbidden", message: "Valid x-refresh-token required to force a refresh." }, 403);
  }

  const cached = await readSnapshot(CACHE_KEY, "all");
  if (!force && cached && ageInMinutes(cached) <= STALE_AFTER_MINUTES) {
    return json({ ...cached, cache: "hit" });
  }

  try {
    // A read-path refresh backfills fewer publication dates than the nightly
    // job: someone opening the tab should not wait on dozens of page fetches.
    const data = await collectBlogTracker({ backfillLimit: force ? 25 : 8 });
    if (data.rows.length) await writeSnapshot(CACHE_KEY, data, "all");
    return json({ ...data, cache: force ? "forced" : "miss" });
  } catch (err) {
    if (cached) {
      return json({
        ...cached,
        cache: "stale",
        warnings: [...(cached.warnings ?? []), `Refresh failed, showing cached data: ${err.message}`],
      });
    }
    return json({ error: "collection_failed", message: err.message }, 502);
  }
};

export const config = { path: "/api/blog" };
