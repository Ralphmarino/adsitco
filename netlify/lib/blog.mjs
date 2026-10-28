import { BLOG_SEED, BLOG_EXCLUSIONS, BLOG_MANUAL_DATES, BLOG_SEED_META } from "./blog-seed.mjs";
import { exclusionFor } from "./blog-rules.mjs";
import {
  fetchSitemap,
  scrapePostDates,
  SITEMAP_URL,
  SITE_ORIGIN,
  CANDIDATE_PATHS,
} from "./sitemap.mjs";
import { fetchPostDates, fetchRecentPosts, WP_API_ROOT } from "./wp-api.mjs";
import { describeFailure } from "./site-fetch.mjs";
import { collectDifferential } from "./differential.mjs";
import { readSnapshot, writeSnapshot } from "./store.mjs";

const STATE_KEY = "blog-state";

const canonical = (url) => String(url ?? "").trim().replace(/\/+$/, "").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

function daysBetween(fromIso, toIso = today()) {
  if (!fromIso) return null;
  const ms = new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

/**
 * Stored per-URL history. This is what makes the tracker self-maintaining:
 * the live site says what a post's modified date is now, and this says what it
 * was yesterday, so a change becomes an observed event with a date rather than
 * a number that silently moves.
 */
async function readState() {
  return (await readSnapshot(STATE_KEY, "all")) ?? { urls: {}, firstRun: today() };
}

/**
 * Freshness bands. A post is not "stale" at a fixed age — the point is to
 * sort attention, so the bands are wide and the exact day count is shown
 * alongside rather than hidden behind a label.
 */
function freshness(days) {
  if (days === null) return { band: "unknown", label: "Unknown" };
  if (days <= 180) return { band: "fresh", label: "Fresh" };
  if (days <= 365) return { band: "aging", label: "Aging" };
  if (days <= 730) return { band: "stale", label: "Stale" };
  return { band: "very-stale", label: "Very stale" };
}

/**
 * What to refresh next.
 *
 * The question is not "which post is oldest" — it is "where is the most
 * traffic at risk". So the score is the clicks a post still earns, weighted up
 * by how long since it was touched and by how fast it is losing ground. A
 * stale post nobody reads scores low; a high-traffic post sliding for a year
 * scores high.
 */
function priorityFor({ clicks, clicksDelta, days }) {
  const traffic = Math.max(clicks, 0);
  if (!traffic) return { score: 0, tier: "low", reasons: ["No search clicks to protect"] };

  const ageWeight = days === null ? 1 : Math.min(1 + days / 365, 3);
  const declinePct = clicks - clicksDelta > 0 ? -clicksDelta / (clicks - clicksDelta) : 0;
  const declineWeight = 1 + Math.max(0, Math.min(declinePct, 1)) * 2;
  const score = traffic * ageWeight * declineWeight;

  const reasons = [];
  if (declinePct >= 0.1) reasons.push(`Clicks down ${Math.round(declinePct * 100)}%`);
  if (days !== null && days > 365) reasons.push(`Not updated in ${Math.round(days / 30)} months`);
  if (!reasons.length) reasons.push("Holding steady");

  const tier =
    (declinePct >= 0.1 || (days !== null && days > 365)) && traffic >= 25
      ? "high"
      : declinePct >= 0.1 || (days !== null && days > 540)
        ? "medium"
        : "low";

  return { score: Math.round(score), tier, reasons };
}

/**
 * Where each date came from, best first.
 *
 * Precedence is by how much the source actually knows, not by convenience:
 *
 *   manual   data/blog-dates.csv — entered deliberately, never overruled
 *   wp       the WordPress REST API — authoritative, both dates, cheap
 *   sitemap  <lastmod> — a modified date only, and only if the plugin wrote one
 *   html     scraped from the post's own page — both dates, one request each
 *   stored   what a previous run resolved, so a bad day loses nothing
 *
 * `stored` last is what keeps the tab populated when the site is unreachable,
 * and why a 403 degrades the report instead of emptying it.
 */
const SOURCE_RANK = { manual: 5, wp: 4, sitemap: 3, html: 2, stored: 1 };

function pick(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate?.value) continue;
    if (!best || SOURCE_RANK[candidate.source] > SOURCE_RANK[best.source]) best = candidate;
  }
  return best ?? { value: null, source: null };
}

/**
 * Ask the live site what it knows, from every source, and report what each one
 * said.
 *
 * Nothing here throws. A blocked site is a condition the report describes, not
 * an error that takes the tab down — the first deploy's 403 surfaced as "no
 * dates" with no way to tell a firewall from an empty sitemap, and that is the
 * thing being fixed.
 */
async function gatherLiveDates(urls, { scrapeLimit = 8 } = {}) {
  const sources = [];
  const wp = new Map();
  const sitemap = new Map();
  let discovered = [];
  let sitemapEntries = [];
  let sitemapReadable = false;

  // --- WordPress REST API: both dates, ~40 posts per request ---------------
  try {
    const { posts, missing, requests } = await fetchPostDates(urls);
    for (const post of posts) {
      if (post.url) wp.set(canonical(post.url), post);
    }
    sources.push({
      id: "wp",
      label: "WordPress API",
      url: `${WP_API_ROOT}/posts`,
      ok: true,
      requests,
      resolved: posts.length,
      unknown: missing.length,
    });
  } catch (err) {
    sources.push({ id: "wp", label: "WordPress API", url: `${WP_API_ROOT}/posts`, ok: false, ...describeFailure(err) });
  }

  // Discovery: posts written since the curated list was drawn up. Cheap, and
  // it works even when the sitemap does not.
  if (wp.size) {
    try {
      const recent = await fetchRecentPosts({ limit: 100 });
      discovered = recent.filter((p) => p.url);
      for (const post of discovered) wp.set(canonical(post.url), post);
    } catch {
      // Discovery is a bonus; the curated list still tracks.
    }
  }

  // --- Sitemap: modified dates, and a second discovery route --------------
  try {
    const result = await fetchSitemap();
    sitemapEntries = result.entries;
    sitemapReadable = true;
    for (const entry of result.entries) sitemap.set(canonical(entry.url), entry);
    sources.push({
      id: "sitemap",
      label: "Sitemap",
      url: result.url,
      ok: true,
      resolved: result.entries.filter((e) => e.lastmod).length,
      entries: result.entries.length,
      attempts: result.attempts,
    });
  } catch (err) {
    sources.push({
      id: "sitemap",
      label: "Sitemap",
      url: SITEMAP_URL,
      ok: false,
      ...describeFailure(err),
      attempts: err.attempts_detail ?? null,
    });
  }

  // --- HTML scrape: only what nothing else covered ------------------------
  const uncovered = urls.filter((url) => {
    const key = canonical(url);
    const fromWp = wp.get(key);
    if (fromWp?.published && fromWp?.modified) return false;
    return !(fromWp?.published || sitemap.get(key)?.lastmod);
  });

  let scrape = { found: {}, failed: [], attempted: 0, resolved: 0, remaining: uncovered.length };
  if (uncovered.length && scrapeLimit > 0) {
    scrape = await scrapePostDates(uncovered, { limit: scrapeLimit });
    sources.push({
      id: "html",
      label: "Post pages",
      url: `${SITE_ORIGIN}/blog/…`,
      ok: scrape.failed.length < scrape.attempted || scrape.attempted === 0,
      attempted: scrape.attempted,
      resolved: scrape.resolved,
      failedCount: scrape.failed.length,
      remaining: scrape.remaining,
      ...(scrape.failed.length ? { status: scrape.failed[0].status, error: scrape.failed[0].error, hint: scrape.failed[0].hint } : {}),
    });
  }

  const html = new Map();
  for (const [url, dates] of Object.entries(scrape.found)) html.set(canonical(url), dates);

  return { wp, sitemap, html, discovered, sitemapEntries, sitemapReadable, scrape, sources };
}

/**
 * The tracker: every post worth watching, with when it was published, when it
 * last changed, how long ago that was, and how its search performance is
 * trending.
 *
 * Sources are merged rather than chosen between — the curated CSV names the
 * posts and supplies titles, the live site supplies the moving dates and finds
 * posts the CSV never had, stored history turns a changing date into a dated
 * event, and Search Console supplies the trend.
 */
export async function collectBlogTracker({ scrapeLimit = 8 } = {}) {
  const state = await readState();
  const warnings = [...(BLOG_SEED_META.warnings ?? [])];
  const now = today();

  const excluded = new Set(BLOG_EXCLUSIONS);

  // --- the tracked set, round one: everything already known ---------------
  // The curated list, plus every post a previous run found. Discovery depends
  // on the live site, so rebuilding the list from it alone would drop every
  // discovered post the moment a run was refused — the same mistake as
  // caching an empty snapshot, one layer up. Doing it before the fetch also
  // means those posts' dates are asked for, not just carried over.
  const tracked = new Map();
  for (const post of BLOG_SEED) {
    tracked.set(canonical(post.url), { ...post, source: "curated" });
  }
  for (const [key, stored] of Object.entries(state.urls ?? {})) {
    if (tracked.has(key) || excluded.has(key)) continue;
    if (!stored.url || exclusionFor(stored.url)) continue;
    tracked.set(key, {
      url: stored.url,
      title: stored.title ?? "",
      published: null,
      modified: null,
      category: "",
      source: "new",
    });
  }

  const live = await gatherLiveDates([...tracked.values()].map((p) => p.url), { scrapeLimit });

  // --- round two: posts the live site knows about and the CSV did not ------
  const filteredOut = [];
  const addDiscovered = (url, title) => {
    const key = canonical(url);
    if (tracked.has(key)) return;
    if (excluded.has(key)) return;
    const rule = exclusionFor(url);
    if (rule) {
      filteredOut.push(rule.id);
      return;
    }
    tracked.set(key, { url, title: title ?? "", published: null, modified: null, category: "", source: "new" });
  };
  for (const post of live.discovered) addDiscovered(post.url, post.title);
  for (const entry of live.sitemapEntries) addDiscovered(entry.url);

  // --- merge ---------------------------------------------------------------
  const nextState = { urls: {}, firstRun: state.firstRun ?? now, lastRun: now };

  for (const [key, post] of tracked) {
    const prior = state.urls?.[key] ?? {};
    const manual = BLOG_MANUAL_DATES[key] ?? {};
    const fromWp = live.wp.get(key);
    const fromSitemap = live.sitemap.get(key);
    const fromHtml = live.html.get(key);

    const published = pick([
      { value: manual.published ?? post.published, source: "manual" },
      { value: fromWp?.published, source: "wp" },
      { value: fromHtml?.published, source: "html" },
      { value: prior.published, source: "stored" },
    ]);

    const modified = pick([
      { value: manual.modified ?? post.modified, source: "manual" },
      { value: fromWp?.modified, source: "wp" },
      { value: fromSitemap?.lastmod, source: "sitemap" },
      { value: fromHtml?.modified, source: "html" },
      { value: prior.lastmod, source: "stored" },
    ]);

    // A modified date that moved since the last run is an update we witnessed,
    // so the date it happened is recorded rather than inferred later. Only a
    // live source counts: falling back to stored data is not a change.
    const changed =
      modified.value &&
      prior.lastmod &&
      modified.value !== prior.lastmod &&
      modified.source !== "stored";
    const observedUpdates = [...(prior.observedUpdates ?? [])];
    if (changed) observedUpdates.push({ at: now, from: prior.lastmod, to: modified.value });

    nextState.urls[key] = {
      url: post.url,
      // Stored so a discovered post keeps its title across a run that could
      // not reach the site.
      title: post.title || live.wp.get(key)?.title || "",
      lastmod: modified.value,
      modifiedSource: modified.source,
      published: published.value,
      publishedSource: published.source,
      // Scraped once and remembered, so a post whose page carries no
      // machine-readable date is not re-fetched every night forever.
      scraped: prior.scraped || Boolean(fromHtml?.checked),
      firstSeen: prior.firstSeen ?? now,
      inSitemap: Boolean(fromSitemap),
      knownToWp: Boolean(fromWp),
      observedUpdates: observedUpdates.slice(-10),
    };
  }

  // --- search performance --------------------------------------------------
  let differential = null;
  try {
    differential = await collectDifferential({ span: 6, limit: 100000 });
  } catch (err) {
    warnings.push(`Search Console performance unavailable (${err.message}).`);
  }
  const perf = new Map();
  for (const row of differential?.rows ?? []) perf.set(canonical(row.url), row);

  // --- assemble ------------------------------------------------------------
  const rows = [];
  for (const [key, post] of tracked) {
    const stored = nextState.urls[key];
    const p = perf.get(key);
    const clicks = p?.period.recent.clicks ?? 0;
    const clicksDelta = p?.period.delta.clicks ?? 0;
    const days = daysBetween(stored.lastmod);
    const priority = priorityFor({ clicks, clicksDelta, days });

    rows.push({
      url: post.url,
      title: post.title || live.wp.get(key)?.title || "",
      source: post.source,
      published: stored.published,
      publishedSource: stored.publishedSource,
      lastmod: stored.lastmod,
      modifiedSource: stored.modifiedSource,
      daysSinceUpdate: days,
      daysSincePublished: daysBetween(stored.published),
      freshness: freshness(days),
      inSitemap: stored.inSitemap,
      observedUpdates: stored.observedUpdates.length,
      lastObservedUpdate: stored.observedUpdates.at(-1)?.at ?? null,
      clicks,
      clicksPrior: p?.period.prior.clicks ?? 0,
      clicksDelta,
      impressions: p?.period.recent.impressions ?? 0,
      impressionsDelta: p?.period.delta.impressions ?? 0,
      position: p?.period.recent.position ?? 0,
      positionDelta: p?.period.delta.position ?? 0,
      hasPerformance: Boolean(p),
      priority,
    });
  }

  rows.sort((a, b) => b.priority.score - a.priority.score);
  await writeSnapshot(STATE_KEY, nextState, "all");

  const counts = {};
  for (const id of filteredOut) counts[id] = (counts[id] ?? 0) + 1;

  // --- say plainly what the site did --------------------------------------
  const working = live.sources.filter((s) => s.ok && (s.resolved ?? 0) > 0);
  const refused = live.sources.filter((s) => !s.ok);
  const blocked = !working.length && refused.length > 0;

  if (blocked) {
    const worst = refused.find((s) => s.status === 403) ?? refused[0];
    warnings.push(
      `The site answered no date source (${refused.map((s) => `${s.label}: ${s.error}`).join("; ")}). ${worst.hint} Dates shown are from the last successful run and data/blog-dates.csv.`,
    );
  } else {
    for (const source of refused) {
      warnings.push(`${source.label} unavailable (${source.error}) — dates came from ${working.map((s) => s.label).join(" and ")} instead.`);
    }
  }

  // Only a sitemap that was actually read can tell us a post has left it.
  // Reporting "108 posts no longer in the sitemap" off the back of a 403 was
  // alarming and false.
  const missingFromSitemap = live.sitemapReadable
    ? rows.filter((r) => !r.inSitemap).length
    : null;
  if (live.sitemapReadable && missingFromSitemap > 0 && live.sitemapEntries.length) {
    warnings.push(`${missingFromSitemap} tracked post(s) are no longer in the sitemap.`);
  }

  const unresolved = rows.filter((r) => !r.published).length;
  if (unresolved && !blocked) {
    warnings.push(
      `${unresolved} post(s) have no publication date yet. The nightly job keeps asking; add them to data/blog-dates.csv to fill them in by hand.`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    siteOrigin: SITE_ORIGIN,
    sources: live.sources,
    blocked,
    sitemapUrl: live.sources.find((s) => s.id === "sitemap")?.url ?? SITEMAP_URL,
    sitemapError: live.sitemapReadable ? null : live.sources.find((s) => s.id === "sitemap")?.error ?? null,
    windows: differential?.windows ?? null,
    rows,
    totals: {
      tracked: rows.length,
      curated: rows.filter((r) => r.source === "curated").length,
      new: rows.filter((r) => r.source === "new").length,
      missingFromSitemap,
      withPublished: rows.filter((r) => r.published).length,
      withModified: rows.filter((r) => r.lastmod).length,
      sitemapEntries: live.sitemapReadable ? live.sitemapEntries.length : null,
      filteredOut: filteredOut.length,
      filteredByRule: counts,
    },
    dateSources: rows.reduce((acc, r) => {
      const key = r.publishedSource ?? "none";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    scrape: {
      attempted: live.scrape.attempted,
      resolved: live.scrape.resolved,
      failed: live.scrape.failed.length,
      remaining: live.scrape.remaining,
    },
    warnings,
  };
}

/**
 * What every date source says, right now, without touching stored state.
 *
 * This exists because "no dates" was not a diagnosable report. One request to
 * `/api/blog?diagnose=1` now names each address tried and what it answered, so
 * a firewall rule, a disabled REST route and a renamed sitemap are told apart
 * in one look instead of by redeploying.
 */
export async function diagnoseBlogSources() {
  const sample = BLOG_SEED.slice(0, 3).map((p) => p.url);
  const live = await gatherLiveDates(sample, { scrapeLimit: 1 });

  return {
    checkedAt: new Date().toISOString(),
    siteOrigin: SITE_ORIGIN,
    sampleUrls: sample,
    candidateSitemaps: process.env.BLOG_SITEMAP_URL
      ? [process.env.BLOG_SITEMAP_URL]
      : CANDIDATE_PATHS.map((p) => `${SITE_ORIGIN}${p}`),
    wpApiRoot: WP_API_ROOT,
    sources: live.sources,
    resolved: {
      wp: [...live.wp.values()].map((p) => ({ url: p.url, published: p.published, modified: p.modified })),
      sitemap: [...live.sitemap.values()].slice(0, 3),
      html: Object.entries(live.scrape.found).map(([url, d]) => ({ url, ...d })),
    },
    nextStep: live.sources.every((s) => !s.ok)
      ? "Every source was refused. Allow the Netlify function's requests at the host, or set BLOG_FETCH_USER_AGENT to a string it permits."
      : "At least one source answered — the tracker can read dates.",
  };
}
