import { checkViewerAuth, checkRefreshAuth, json } from "../lib/auth.mjs";
import { collectBlogTracker, diagnoseBlogSources, blogCsv } from "../lib/blog.mjs";
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

  // Diagnostics first: it reads nothing from the cache and changes no state,
  // so it answers even when collection is failing outright. That is the whole
  // point of it — "no dates" needed to become a specific address and a status
  // code without a redeploy.
  if (url.searchParams.get("diagnose") === "1") {
    try {
      return json(await diagnoseBlogSources());
    } catch (err) {
      return json({ error: "diagnose_failed", message: err.message }, 502);
    }
  }

  const forceRequested = url.searchParams.get("force") === "1";
  const force = forceRequested && checkRefreshAuth(req);
  if (forceRequested && !force) {
    return json({ error: "forbidden", message: "Valid x-refresh-token required to force a refresh." }, 403);
  }

  const wantsCsv = url.searchParams.get("format") === "csv";
  const asCsv = (data) =>
    new Response(blogCsv(data.rows ?? []), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="adsitco-blog-tracker-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });

  const cached = await readSnapshot(CACHE_KEY, "all");
  if (!force && cached && ageInMinutes(cached) <= STALE_AFTER_MINUTES) {
    return wantsCsv ? asCsv(cached) : json({ ...cached, cache: "hit" });
  }

  try {
    // The WordPress API covers every tracked post in three requests, so the
    // per-post scrape is now a fallback for the handful it does not know. A
    // read still does fewer than the nightly job: someone opening the tab
    // should not wait on dozens of page fetches.
    const data = await collectBlogTracker({ scrapeLimit: force ? 25 : 8 });
    if (data.rows.length) await writeSnapshot(CACHE_KEY, data, "all");
    return wantsCsv ? asCsv(data) : json({ ...data, cache: force ? "forced" : "miss" });
  } catch (err) {
    if (cached) {
      if (wantsCsv) return asCsv(cached);
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
