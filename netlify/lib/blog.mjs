import { BLOG_SEED, BLOG_EXCLUSIONS, BLOG_SEED_META } from "./blog-seed.mjs";
import { exclusionFor } from "./blog-rules.mjs";
import { fetchSitemap, backfillPublishedDates, SITEMAP_URL } from "./sitemap.mjs";
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
 * the sitemap says what a post's lastmod is now, and this says what it was
 * yesterday, so a change becomes an observed event with a date rather than a
 * number that silently moves.
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
 * The tracker: every post worth watching, with when it was published, when it
 * last changed, how long ago that was, and how its search performance is
 * trending.
 *
 * Sources are merged rather than chosen between — the curated CSV names the
 * posts and supplies titles, the sitemap supplies the moving dates and finds
 * posts the CSV never had, stored history turns a changing lastmod into a
 * dated event, and Search Console supplies the trend.
 */
export async function collectBlogTracker({ backfillLimit = 25 } = {}) {
  const state = await readState();
  const warnings = [...(BLOG_SEED_META.warnings ?? [])];
  const now = today();

  // --- the live list -------------------------------------------------------
  let sitemap = [];
  let sitemapError = null;
  try {
    sitemap = await fetchSitemap();
  } catch (err) {
    sitemapError = err.message;
    warnings.push(
      `Could not read the sitemap (${err.message}). Last-modified dates are from the last successful read.`,
    );
  }

  const excluded = new Set(BLOG_EXCLUSIONS);
  const filteredOut = [];
  const sitemapByUrl = new Map();
  for (const entry of sitemap) {
    const key = canonical(entry.url);
    if (excluded.has(key)) continue;
    const rule = exclusionFor(entry.url);
    if (rule) {
      filteredOut.push(rule.id);
      continue;
    }
    sitemapByUrl.set(key, entry);
  }

  // --- the tracked set -----------------------------------------------------
  const tracked = new Map();
  for (const post of BLOG_SEED) {
    tracked.set(canonical(post.url), { ...post, source: "curated" });
  }
  for (const [key, entry] of sitemapByUrl) {
    if (tracked.has(key)) continue;
    // In the sitemap, past the filters, but never curated — a post published
    // since the list was drawn up. Surfaced rather than quietly added.
    tracked.set(key, { url: entry.url, title: "", published: null, category: "", source: "new" });
  }

  // --- merge in what we knew before ---------------------------------------
  const nextState = { urls: {}, firstRun: state.firstRun ?? now, lastRun: now };
  const needPublished = [];

  for (const [key, post] of tracked) {
    const prior = state.urls?.[key] ?? {};
    const live = sitemapByUrl.get(key);
    const lastmod = live?.lastmod ?? prior.lastmod ?? null;

    // A lastmod that moved since the last run is an update we witnessed, so
    // the date it happened is recorded rather than inferred later.
    const changed = lastmod && prior.lastmod && lastmod !== prior.lastmod;
    const observedUpdates = [...(prior.observedUpdates ?? [])];
    if (changed) observedUpdates.push({ at: now, from: prior.lastmod, to: lastmod });

    const published = post.published ?? prior.published ?? null;
    if (!published && !prior.publishedChecked) needPublished.push(post.url);

    nextState.urls[key] = {
      url: post.url,
      lastmod,
      published,
      publishedChecked: prior.publishedChecked ?? false,
      firstSeen: prior.firstSeen ?? now,
      inSitemap: Boolean(live),
      observedUpdates: observedUpdates.slice(-10),
    };
  }

  // --- fill in publication dates, a few at a time -------------------------
  let backfill = { found: {}, failed: [], remaining: needPublished.length };
  if (needPublished.length && backfillLimit > 0) {
    backfill = await backfillPublishedDates(needPublished, { limit: backfillLimit });
    for (const [url, date] of Object.entries(backfill.found)) {
      const key = canonical(url);
      if (!nextState.urls[key]) continue;
      nextState.urls[key].published = date;
      // Marked checked either way: a post with no machine-readable date should
      // not be re-fetched every night forever.
      nextState.urls[key].publishedChecked = true;
    }
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
      title: post.title || "",
      source: post.source,
      published: stored.published,
      lastmod: stored.lastmod,
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

  return {
    generatedAt: new Date().toISOString(),
    sitemapUrl: SITEMAP_URL,
    sitemapError,
    windows: differential?.windows ?? null,
    rows,
    totals: {
      tracked: rows.length,
      curated: rows.filter((r) => r.source === "curated").length,
      new: rows.filter((r) => r.source === "new").length,
      missingFromSitemap: rows.filter((r) => !r.inSitemap).length,
      withPublished: rows.filter((r) => r.published).length,
      sitemapEntries: sitemap.length,
      filteredOut: filteredOut.length,
      filteredByRule: counts,
    },
    backfill: { filled: Object.keys(backfill.found).length, remaining: backfill.remaining, failed: backfill.failed.length },
    warnings,
  };
}
