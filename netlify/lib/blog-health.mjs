/**
 * Health status, refresh-due, and format conformance.
 *
 * These are the audit spec's rules, not mine, and they are deliberately kept
 * apart from the collection code so the rules can be read against the spec
 * without the plumbing in the way. Every threshold comes from
 * data/blog-config.json — the spec's guardrail is that thresholds live in
 * config and never in code, because the starting values are placeholders to be
 * tuned after a couple of months of data.
 *
 * One line in the spec drives much of what follows: WordPress `modified`
 * changes on any save, so it cannot be trusted as the date of the last real
 * content revision. So there are two dates here. `modified` is automatic and
 * says when the post was last touched at all; `lastSubstantiveUpdate` is
 * entered by hand in the audit records and is the one the refresh rules use.
 */

import { BLOG_CONFIG } from "./blog-seed.mjs";

const cfg = BLOG_CONFIG;

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

export function daysSince(iso, to = today()) {
  if (!iso) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${iso}T00:00:00Z`)) / DAY);
}

/**
 * Freshness bands behind the days-since-update column.
 *
 * Kept from the first version because they do a job the health status does
 * not: health answers "is this post working", freshness answers "when did
 * anyone last touch it". A post can be strong and four years old.
 */
export function freshness(days) {
  const f = cfg.freshness;
  if (days === null) return { band: "unknown", label: "Unknown" };
  if (days <= f.freshDays) return { band: "fresh", label: "Fresh" };
  if (days <= f.agingDays) return { band: "aging", label: "Aging" };
  if (days <= f.staleDays) return { band: "stale", label: "Stale" };
  return { band: "very-stale", label: "Very stale" };
}

export const HEALTH_ORDER = [
  "declining",
  "striking-distance",
  "strong",
  "stable",
  "weak",
  "new",
  "removed",
  "unknown",
];

export const HEALTH_LABEL = {
  new: "New",
  removed: "Removed",
  declining: "Declining",
  "striking-distance": "Striking distance",
  strong: "Strong",
  stable: "Stable",
  weak: "Weak",
  unknown: "No data",
};

const pctDrop = (now, before) => (before > 0 ? ((before - now) / before) * 100 : 0);

/**
 * Health status, first match wins, exactly in the spec's order.
 *
 * `current`, `prior` and `lastYear` are the latest 90 days, the 90 before
 * that, and the same 90 days a year earlier. Comparing against last year as
 * well as the prior period is what keeps a seasonal dip — convertible season,
 * winter projects — from reading as decay.
 */
export function healthFor({ current, prior, lastYear, published, lastSubstantiveUpdate, audit }) {
  const h = cfg.health;
  const reasons = [];

  // The spec puts `removed` second, but a post whose removal has been executed
  // is no longer a post; checking it first avoids calling it "new" because the
  // 301 went in last week.
  if (audit?.verdict === "REMOVE" && ["executed", "closed"].includes(audit?.audit_status ?? "")) {
    return { status: "removed", reasons: ["REMOVE executed"], detail: audit.redirect_to ?? null };
  }
  if (audit?.verdict === "MERGE" && audit?.absorbed) {
    return { status: "removed", reasons: ["Absorbed by a MERGE"], detail: audit.redirect_to ?? null };
  }

  const sinceTouched = daysSince(lastSubstantiveUpdate ?? published);
  if (sinceTouched !== null && sinceTouched < h.newWithinDays) {
    return {
      status: "new",
      reasons: [
        lastSubstantiveUpdate
          ? `Substantively updated ${sinceTouched} days ago`
          : `Published ${sinceTouched} days ago`,
      ],
    };
  }

  // No Search Console rows at all is not "weak", which is a judgement about
  // performance. It is the absence of the data the judgement needs.
  if (!current) return { status: "unknown", reasons: ["No Search Console data"] };

  const dropVsPrior = pctDrop(current.clicks, prior?.clicks ?? 0);
  const dropVsYear = pctDrop(current.clicks, lastYear?.clicks ?? 0);
  if (
    prior?.clicks > 0 &&
    lastYear?.clicks > 0 &&
    dropVsPrior > h.decliningDropPct &&
    dropVsYear > h.decliningDropPct
  ) {
    return {
      status: "declining",
      reasons: [
        `Clicks down ${Math.round(dropVsPrior)}% vs the previous 90 days`,
        `and ${Math.round(dropVsYear)}% vs last year`,
      ],
    };
  }

  const sd = h.strikingDistance;
  if (
    current.position >= sd.minPosition &&
    current.position <= sd.maxPosition &&
    current.impressions >= sd.minImpressions
  ) {
    reasons.push(`Position ${current.position.toFixed(1)} on ${Math.round(current.impressions).toLocaleString()} impressions`);
    return { status: "striking-distance", reasons };
  }

  if (current.position > 0 && current.position <= h.strong.maxPosition && current.clicks >= h.strong.minClicks) {
    return { status: "strong", reasons: [`Position ${current.position.toFixed(1)}, ${Math.round(current.clicks)} clicks`] };
  }

  if (current.impressions >= h.stable.minImpressions) {
    return { status: "stable", reasons: [`${Math.round(current.impressions).toLocaleString()} impressions`] };
  }

  return { status: "weak", reasons: [`Under ${h.stable.minImpressions} impressions`] };
}

/**
 * Whether a post is due a refresh: the last substantive update is older than
 * the configured window AND the post is worth the effort.
 *
 * The health condition is the point. A post nobody finds does not become
 * worth rewriting by getting older, and the refresh queue should not fill up
 * with pages that have nothing to protect.
 */
export function refreshDue({ lastSubstantiveUpdate, modified, health }) {
  const r = cfg.refreshDue;
  if (!r.healthStatuses.includes(health)) {
    return { due: false, reason: `Health is ${HEALTH_LABEL[health] ?? health}`, basis: null };
  }

  // The spec's rule is on the substantive date. Falling back to `modified`
  // where no substantive date has been recorded keeps the queue usable before
  // the audit has run, but the row says which date it used, because `modified`
  // moves on a typo fix and would hide a post that has not really been touched
  // in three years.
  const basis = lastSubstantiveUpdate ? "substantive" : modified ? "modified" : null;
  const days = daysSince(lastSubstantiveUpdate ?? modified);
  if (days === null) return { due: false, reason: "No update date on record", basis: null };

  const threshold = r.staleAfterMonths * 30.44;
  if (days <= threshold) {
    return { due: false, reason: `Updated ${Math.round(days / 30.44)} months ago`, basis };
  }

  return {
    due: true,
    reason: `${Math.round(days / 30.44)} months since the last ${basis === "substantive" ? "substantive update" : "save"}, and health is ${HEALTH_LABEL[health] ?? health}`,
    basis,
  };
}

/* Conformance ------------------------------------------------------------- */

const headings = (html) =>
  [...String(html ?? "").matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) =>
    m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
  );

/**
 * Conformance to the current Content Guide form, read off the rendered post.
 *
 * Headings are matched case-insensitively on the text, not on an exact string:
 * "Relevant Chassis" and "Relevant chassis &amp; years" are the same section,
 * and failing a post on its capitalisation would make the column noise.
 */
export function conformanceFor(html, { allUrls = [], selfUrl = "" } = {}) {
  if (!html) return null;
  const c = cfg.conformance;
  const found = headings(html);
  const lower = found.map((h) => h.toLowerCase());

  const missing = c.requiredHeadings.filter(
    (needle) => !lower.some((h) => h.includes(needle.toLowerCase())),
  );
  const faqPattern = new RegExp(c.faqHeadingPattern, "i");

  // Internal links, split by whether they point at something that sells.
  const hrefs = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]);
  let internal = 0;
  let money = 0;
  const linksTo = new Set();
  for (const href of hrefs) {
    let path = null;
    try {
      const u = new URL(href, "https://www.adsitco.com");
      if (!/(^|\.)adsitco\.com$/i.test(u.hostname)) continue;
      path = u.pathname;
      linksTo.add(`${u.origin}${u.pathname}`.replace(/\/+$/, "").toLowerCase());
    } catch {
      continue;
    }
    internal += 1;
    if (c.moneyPathPatterns.some((p) => path.includes(p))) money += 1;
  }

  return {
    formatConforms: missing.length === 0,
    missingHeadings: missing,
    hasFaqs: found.some((h) => faqPattern.test(h)),
    headingCount: found.length,
    internalLinksOut: internal,
    moneyLinksOut: money,
    // Resolved by the caller once every post's links are known.
    linksTo: [...linksTo].filter((u) => u !== selfUrl && allUrls.includes(u)),
  };
}

export { cfg as BLOG_THRESHOLDS };
