import {
  BLOG_SEED,
  BLOG_EXCLUSIONS,
  BLOG_MANUAL_DATES,
  BLOG_AUDIT,
  BLOG_GAPS,
  BLOG_BACKLINKS,
  BLOG_KEYWORDS,
  BLOG_CONFIG,
  BLOG_SEED_META,
} from "./blog-seed.mjs";
import { exclusionFor } from "./blog-rules.mjs";
import {
  healthFor,
  refreshDue,
  conformanceFor,
  freshness,
  daysSince,
  HEALTH_LABEL,
  HEALTH_ORDER,
} from "./blog-health.mjs";
import {
  fetchSitemap,
  scrapePostDates,
  SITEMAP_URL,
  SITE_ORIGIN,
  CANDIDATE_PATHS,
} from "./sitemap.mjs";
import { fetchPostDates, fetchRecentPosts, fetchPostContent, WP_API_ROOT } from "./wp-api.mjs";
import { describeFailure } from "./site-fetch.mjs";
import { collectDifferential, collectHealthPerformance } from "./differential.mjs";
import { readSnapshot, writeSnapshot } from "./store.mjs";

const STATE_KEY = "blog-state";

/**
 * Shape version of a cached /api/blog payload.
 *
 * Netlify Blobs outlive a deploy, and the read path serves anything under 12
 * hours old — so new UI reading an old snapshot renders a half-populated tab
 * where every field added since looks like a zero. That is exactly what the
 * audit columns did on their first deploy: "Due a refresh 0", "Audited 0/108",
 * an empty health chart, all from a snapshot collected before those fields
 * existed.
 *
 * Bump this whenever a field is added to the returned payload. A cached
 * snapshot that does not match is treated as a miss and recollected, so a
 * deploy that changes the shape fixes itself on the next page load instead of
 * waiting out the TTL or needing a manual force.
 */
export const BLOG_SCHEMA = 3;

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
 * Where to start, within the refresh queue.
 *
 * This orders work; it is not a verdict. The audit spec is explicit that
 * verdicts come from the audit process and that a prioritisation total is
 * never presented as one, so the tier is labelled as refresh priority in the
 * UI and sits in its own column from `verdict`.
 *
 * The question it answers is not "which post is oldest" but "where is the
 * most traffic at risk": the clicks a post still earns, weighted up by how
 * long since it was touched and by how fast it is losing ground. A stale post
 * nobody reads scores low; a high-traffic post sliding for a year scores high.
 *
 * Health and the refresh-due flag feed in because they know things the raw
 * numbers do not — striking-distance posts are the cheapest wins on the site,
 * and a post the spec's own rule says is due outranks one that merely looks
 * old.
 */
function priorityFor({ clicks, clicksDelta, days, health, due }) {
  const traffic = Math.max(clicks, 0);

  if (health === "removed") return { score: 0, tier: "none", reasons: ["Removed"] };

  const reasons = [];
  const ageWeight = days === null ? 1 : Math.min(1 + days / 365, 3);
  const declinePct = clicks - clicksDelta > 0 ? -clicksDelta / (clicks - clicksDelta) : 0;
  const declineWeight = 1 + Math.max(0, Math.min(declinePct, 1)) * 2;
  // A post two positions off page one is worth more than its current clicks
  // suggest, which is the whole point of the status.
  const opportunityWeight = health === "striking-distance" ? 1.5 : 1;
  const score = traffic * ageWeight * declineWeight * opportunityWeight;

  if (health === "declining") reasons.push("Declining against both the prior period and last year");
  else if (declinePct >= 0.1) reasons.push(`Clicks down ${Math.round(declinePct * 100)}%`);
  if (health === "striking-distance") reasons.push("Within reach of page one");
  if (due) reasons.push("Due a refresh");
  if (days !== null && days > 365) reasons.push(`Not updated in ${Math.round(days / 30.44)} months`);
  if (!traffic) reasons.push("No search clicks to protect");
  if (!reasons.length) reasons.push("Holding steady");

  const tier = !traffic
    ? "low"
    : (due || health === "declining" || health === "striking-distance") && traffic >= 25
      ? "high"
      : due || declinePct >= 0.1 || (days !== null && days > 540)
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
export async function collectBlogTracker({ scrapeLimit = 8, includeContent = false } = {}) {
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
  // Two collections, because they answer different questions. The 6-month
  // comparison is what the Differential tab shows and what the refresh queue
  // is ranked on; the 90-day windows, including the same 90 days last year,
  // are what the audit spec's health rules need.
  let differential = null;
  let health = null;
  const [diffResult, healthResult] = await Promise.allSettled([
    collectDifferential({ span: 6, limit: 100000 }),
    collectHealthPerformance({ days: BLOG_CONFIG.health.windowDays }),
  ]);
  if (diffResult.status === "fulfilled") differential = diffResult.value;
  else warnings.push(`Search Console trend unavailable (${diffResult.reason.message}).`);
  if (healthResult.status === "fulfilled") health = healthResult.value;
  else warnings.push(`Health windows unavailable (${healthResult.reason.message}).`);

  const perf = new Map();
  for (const row of differential?.rows ?? []) perf.set(canonical(row.url), row);

  // Search Console reports whatever URL form the site serves, which may not be
  // the canonical form used as a key here, so the windows are re-keyed once
  // rather than guessed at per row.
  const rekey = (map) => {
    const out = new Map();
    for (const [url, value] of map ?? []) out.set(canonical(url), value);
    return out;
  };
  if (health) {
    health.current = rekey(health.current);
    health.prior = rekey(health.prior);
    health.lastYear = rekey(health.lastYear);
  }

  // --- format conformance --------------------------------------------------
  // Only when asked, because it is the whole article for every post. The
  // nightly job asks; a page load reuses whatever the last run worked out.
  let conformance = new Map();
  let conformanceRun = null;
  if (includeContent) {
    try {
      const fetched = await fetchPostContent([...tracked.values()].map((p) => p.url));
      const allUrls = [...tracked.keys()];
      for (const [url, html] of fetched.content) {
        const key = canonical(url);
        conformance.set(key, conformanceFor(html, { allUrls, selfUrl: key }));
      }
      // Links in are the mirror of links out, so they are counted once every
      // post's outbound links are known rather than by scanning twice.
      const inbound = new Map();
      for (const [, result] of conformance) {
        for (const target of result?.linksTo ?? []) inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
      for (const [key, result] of conformance) {
        if (result) result.internalLinksIn = inbound.get(key) ?? 0;
      }
      conformanceRun = { checked: conformance.size, wanted: fetched.wanted, failed: fetched.failed.length };
      if (fetched.failed.length) {
        warnings.push(`Content for ${fetched.failed.length} batch(es) could not be read, so their conformance is unknown.`);
      }
    } catch (err) {
      warnings.push(`Format conformance unavailable (${err.message}).`);
    }
  } else {
    // Carried over from the last run that did check, so the column does not
    // empty out between nightly runs.
    for (const [key, stored] of Object.entries(state.conformance ?? {})) conformance.set(key, stored);
  }

  // --- assemble ------------------------------------------------------------
  const rows = [];
  for (const [key, post] of tracked) {
    const stored = nextState.urls[key];
    const p = perf.get(key);
    const audit = BLOG_AUDIT[key] ?? null;
    const wp = live.wp.get(key);

    const clicks = p?.period.recent.clicks ?? 0;
    const clicksDelta = p?.period.delta.clicks ?? 0;

    // The spec is explicit that WordPress `modified` moves on any save and
    // cannot stand in for the date of the last real revision. So the age
    // column prefers the hand-recorded substantive date and says which one it
    // used, rather than quietly presenting a typo fix as a refresh.
    const substantive = audit?.last_substantive_update || null;
    const ageBasis = substantive ? "substantive" : stored.lastmod ? "modified" : null;
    const days = daysSince(substantive ?? stored.lastmod);

    const current = health?.current.get(key) ?? null;
    const priorWindow = health?.prior.get(key) ?? null;
    const lastYear = health?.lastYear.get(key) ?? null;

    const healthResultRow = healthFor({
      current,
      prior: priorWindow,
      lastYear,
      published: stored.published,
      lastSubstantiveUpdate: substantive,
      audit,
    });
    const due = refreshDue({
      lastSubstantiveUpdate: substantive,
      modified: stored.lastmod,
      health: healthResultRow.status,
    });
    const priority = priorityFor({
      clicks,
      clicksDelta,
      days,
      health: healthResultRow.status,
      due: due.due,
    });

    const conf = conformance.get(key) ?? null;
    const backlinks = BLOG_BACKLINKS[key] ?? null;
    const trackedKeywords = BLOG_KEYWORDS[key] ?? [];

    rows.push({
      url: post.url,
      postId: wp?.id ?? (audit?.post_id ? Number(audit.post_id) || audit.post_id : null),
      slug: post.url.replace(/\/+$/, "").split("/").pop(),
      title: post.title || wp?.title || "",
      source: post.source,

      // Dates, and where each came from.
      published: stored.published,
      publishedSource: stored.publishedSource,
      lastmod: stored.lastmod,
      modifiedSource: stored.modifiedSource,
      lastSubstantiveUpdate: substantive,
      ageBasis,
      daysSinceUpdate: days,
      daysSinceModified: daysSince(stored.lastmod),
      daysSincePublished: daysSince(stored.published),
      freshness: freshness(days),
      inSitemap: stored.inSitemap,
      observedUpdates: stored.observedUpdates.length,
      lastObservedUpdate: stored.observedUpdates.at(-1)?.at ?? null,

      // Performance: the 6-month comparison the queue is ranked on.
      clicks,
      clicksPrior: p?.period.prior.clicks ?? 0,
      clicksDelta,
      impressions: p?.period.recent.impressions ?? 0,
      impressionsDelta: p?.period.delta.impressions ?? 0,
      ctr: p?.period.recent.ctr ?? 0,
      position: p?.period.recent.position ?? 0,
      positionDelta: p?.period.delta.position ?? 0,
      hasPerformance: Boolean(p),

      // Health: the 90-day windows, including last year.
      health: healthResultRow.status,
      healthLabel: HEALTH_LABEL[healthResultRow.status],
      healthReasons: healthResultRow.reasons,
      window: current
        ? {
            clicks: current.clicks,
            impressions: current.impressions,
            ctr: current.ctr,
            position: current.position,
            priorClicks: priorWindow?.clicks ?? 0,
            lastYearClicks: lastYear?.clicks ?? 0,
          }
        : null,

      refreshDue: due.due,
      refreshReason: due.reason,

      // The audit record, read and never written.
      audit: audit
        ? {
            postId: audit.post_id || null,
            batch: audit.batch || null,
            cluster: audit.cluster || null,
            mainCategory: audit.main_category || null,
            secondaryCategory: audit.secondary_category || null,
            tags: (audit.tags || "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean),
            currentVoice: audit.current_voice || null,
            topicIntentVoice: audit.topic_intent_voice || null,
            voiceMatch:
              audit.current_voice && audit.topic_intent_voice
                ? audit.current_voice === audit.topic_intent_voice
                : null,
            verdict: audit.verdict || null,
            confidence: audit.confidence || null,
            primaryReason: audit.primary_reason || null,
            dimensionFlags: (audit.dimension_flags || "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean),
            actionDetail: audit.action_detail || null,
            reviewFlags: (audit.review_flags || "").split(/(?=\[)/).map((t) => t.trim()).filter(Boolean),
            status: audit.audit_status || null,
            imageStyle: audit.image_style || null,
            voiceIssues: audit.voice_issues ? Number(audit.voice_issues) || 0 : 0,
            dateReviewed: audit.date_reviewed || null,
            dateExecuted: audit.date_executed || null,
            redirectTo: audit.redirect_to || null,
            // The audit record's own conformance call, which is a human
            // reading the post. The computed one below is a heading check.
            formatConforms: audit.format_conforms ? /^y/i.test(audit.format_conforms) : null,
          }
        : null,

      conformance: conf
        ? {
            formatConforms: conf.formatConforms,
            missingHeadings: conf.missingHeadings,
            hasFaqs: conf.hasFaqs,
            internalLinksOut: conf.internalLinksOut,
            moneyLinksOut: conf.moneyLinksOut,
            internalLinksIn: conf.internalLinksIn ?? 0,
          }
        : null,

      backlinks,
      trackedKeywords,
      // The two vetoes in the criteria spec: neither is a judgement, both are
      // reasons a REMOVE cannot be finalised without a second look.
      vetoes: [
        ...(backlinks > 0 ? [{ id: "backlink-hold", label: `${backlinks} linking domain(s)` }] : []),
        ...(trackedKeywords.length
          ? [{ id: "consultant-review", label: `${trackedKeywords.length} tracked keyword(s)` }]
          : []),
      ],

      categoryIds: wp?.categoryIds ?? [],
      tagIds: wp?.tagIds ?? [],
      priority,
    });
  }

  rows.sort((a, b) => b.priority.score - a.priority.score);
  // Conformance is expensive to work out and cheap to keep, so it rides along
  // in the state blob for the runs that do not recompute it.
  nextState.conformance = Object.fromEntries(conformance);
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
    schema: BLOG_SCHEMA,
    generatedAt: new Date().toISOString(),
    siteOrigin: SITE_ORIGIN,
    sources: live.sources,
    blocked,
    sitemapUrl: live.sources.find((s) => s.id === "sitemap")?.url ?? SITEMAP_URL,
    sitemapError: live.sitemapReadable ? null : live.sources.find((s) => s.id === "sitemap")?.error ?? null,
    windows: differential?.windows ?? null,
    healthWindows: health?.windows ?? null,
    thresholds: BLOG_CONFIG,
    rows,
    gaps: BLOG_GAPS,
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

      // The audit layer. Counted separately from `tracked` because an empty
      // audit column means the audit has not reached that post, which is not
      // the same as a post with no findings.
      audited: rows.filter((r) => r.audit).length,
      withSubstantiveDate: rows.filter((r) => r.lastSubstantiveUpdate).length,
      refreshDue: rows.filter((r) => r.refreshDue).length,
      conformanceChecked: rows.filter((r) => r.conformance).length,
      formatConforms: rows.filter((r) => r.conformance?.formatConforms).length,
      hasFaqs: rows.filter((r) => r.conformance?.hasFaqs).length,
      legacyImages: rows.filter((r) => r.audit?.imageStyle === "legacy").length,
      voiceMismatch: rows.filter((r) => r.audit?.voiceMatch === false).length,
      withVetoes: rows.filter((r) => r.vetoes.length).length,
      gaps: BLOG_GAPS.length,
    },
    health: HEALTH_ORDER.reduce((acc, status) => {
      const count = rows.filter((r) => r.health === status).length;
      if (count) acc[status] = count;
      return acc;
    }, {}),
    verdicts: rows.reduce((acc, r) => {
      const key = r.audit?.verdict || "unassigned";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    auditStatuses: rows.reduce((acc, r) => {
      if (!r.audit?.status) return acc;
      acc[r.audit.status] = (acc[r.audit.status] ?? 0) + 1;
      return acc;
    }, {}),
    dateSources: rows.reduce((acc, r) => {
      const key = r.publishedSource ?? "none";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    conformanceRun,
    scrape: {
      attempted: live.scrape.attempted,
      resolved: live.scrape.resolved,
      failed: live.scrape.failed.length,
      remaining: live.scrape.remaining,
    },
    warnings,
  };
}

/* Export ------------------------------------------------------------------ */

const CSV_COLUMNS = [
  ["post_id", (r) => r.postId],
  ["slug", (r) => r.slug],
  ["url", (r) => r.url],
  ["title", (r) => r.title],
  ["published", (r) => r.published],
  ["published_source", (r) => r.publishedSource],
  ["modified", (r) => r.lastmod],
  ["modified_source", (r) => r.modifiedSource],
  ["last_substantive_update", (r) => r.lastSubstantiveUpdate],
  ["days_since_update", (r) => r.daysSinceUpdate],
  ["age_basis", (r) => r.ageBasis],
  ["freshness", (r) => r.freshness.label],
  ["health", (r) => r.health],
  ["health_reason", (r) => r.healthReasons.join("; ")],
  ["refresh_due", (r) => (r.refreshDue ? "yes" : "no")],
  ["refresh_reason", (r) => r.refreshReason],
  ["refresh_priority", (r) => r.priority.tier],
  ["priority_score", (r) => r.priority.score],
  ["clicks_6mo", (r) => r.clicks],
  ["clicks_6mo_prior", (r) => r.clicksPrior],
  ["clicks_diff", (r) => r.clicksDelta],
  ["impressions_6mo", (r) => r.impressions],
  ["impressions_diff", (r) => r.impressionsDelta],
  ["ctr_6mo", (r) => (r.ctr ? (r.ctr * 100).toFixed(2) : "")],
  ["position_6mo", (r) => (r.position ? r.position.toFixed(1) : "")],
  ["position_diff", (r) => (r.positionDelta ? r.positionDelta.toFixed(1) : "")],
  ["clicks_90d", (r) => r.window?.clicks ?? ""],
  ["clicks_90d_prior", (r) => r.window?.priorClicks ?? ""],
  ["clicks_90d_last_year", (r) => r.window?.lastYearClicks ?? ""],
  ["position_90d", (r) => (r.window?.position ? r.window.position.toFixed(1) : "")],
  ["batch", (r) => r.audit?.batch],
  ["cluster", (r) => r.audit?.cluster],
  ["main_category", (r) => r.audit?.mainCategory],
  ["secondary_category", (r) => r.audit?.secondaryCategory],
  ["tags", (r) => r.audit?.tags.join("; ")],
  ["current_voice", (r) => r.audit?.currentVoice],
  ["topic_intent_voice", (r) => r.audit?.topicIntentVoice],
  ["verdict", (r) => r.audit?.verdict],
  ["confidence", (r) => r.audit?.confidence],
  ["primary_reason", (r) => r.audit?.primaryReason],
  ["dimension_flags", (r) => r.audit?.dimensionFlags.join("; ")],
  ["action_detail", (r) => r.audit?.actionDetail],
  ["review_flags", (r) => r.audit?.reviewFlags.join(" ")],
  ["audit_status", (r) => r.audit?.status],
  ["image_style", (r) => r.audit?.imageStyle],
  ["voice_issues", (r) => r.audit?.voiceIssues],
  ["date_reviewed", (r) => r.audit?.dateReviewed],
  ["date_executed", (r) => r.audit?.dateExecuted],
  ["redirect_to", (r) => r.audit?.redirectTo],
  ["format_conforms", (r) => (r.conformance ? (r.conformance.formatConforms ? "yes" : "no") : "")],
  ["missing_headings", (r) => r.conformance?.missingHeadings.join("; ")],
  ["has_faqs", (r) => (r.conformance ? (r.conformance.hasFaqs ? "yes" : "no") : "")],
  ["internal_links_out", (r) => r.conformance?.internalLinksOut ?? ""],
  ["money_links_out", (r) => r.conformance?.moneyLinksOut ?? ""],
  ["internal_links_in", (r) => r.conformance?.internalLinksIn ?? ""],
  ["linking_domains", (r) => r.backlinks ?? ""],
  ["tracked_keywords", (r) => r.trackedKeywords.map((k) => `${k.keyword}${k.rank ? ` (#${k.rank})` : ""}`).join("; ")],
  ["vetoes", (r) => r.vetoes.map((v) => v.id).join("; ")],
  ["observed_updates", (r) => r.observedUpdates],
  ["last_observed_update", (r) => r.lastObservedUpdate],
  ["in_sitemap", (r) => (r.inSitemap ? "yes" : "no")],
  ["discovered", (r) => (r.source === "new" ? "yes" : "no")],
];

/**
 * The whole tracker as a CSV, in the audit record's own field names.
 *
 * The table on the page shows what fits; this is for the spreadsheet work the
 * audit actually runs on, and it round-trips: the columns an audit record
 * owns come back out under the names `audit-records.csv` uses.
 */
export function blogCsv(rows) {
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map(([, read]) => cell(read(row))).join(","));
  return lines.join("\n");
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
