/**
 * Which blog URLs are SEO content and which are programmatic filler.
 *
 * adsitco's blog holds a few hundred written posts and several thousand
 * generated ones — per-model transmission lists, rim lists, engine-parts-sale
 * stubs. Only the written ones are worth tracking.
 *
 * Keyword matching is not enough to tell them apart: "transmissions",
 * "engine-parts" and "rims" all appear in real posts
 * (mercedes-benz-transmissions-over-the-years, mercedes-engine-parts-guide,
 * how-to-clean-mercedes-rims-and-wheels). The patterns below therefore anchor
 * on the shapes the generated URLs actually take — a list prefix, a
 * transmissions suffix, a year-and-model stem — rather than on a word
 * appearing anywhere.
 *
 * Precedence, most specific first:
 *   1. an explicit entry in data/blog-exclude.txt is never tracked
 *   2. anything matching a pattern here is not tracked
 *   3. everything else — the curated CSV and the sitemap — is tracked
 *
 * A pattern outranks the curated list on purpose: one generated URL
 * (450-sl-rebuilt-mercedes-transmissions-sale) appears in both, and the report
 * names every curated URL a pattern removed, so a wrong call is visible rather
 * than silent.
 */

export const EXCLUSION_RULES = [
  {
    id: "list-prefix",
    reason: "Generated model list",
    // The list prefix is not always at the start: "the-complete-list-of-…"
    // and "mercedes-benz-2007-full-list-rims-…" are the same family.
    test: (slug) =>
      /(^|-)(complete|full|resource|ultimate)-list-/.test(slug) ||
      /^list-/.test(slug) ||
      /(^|-)list-(rims|of|\d{4})/.test(slug),
  },
  {
    id: "transmissions-suffix",
    reason: "Per-model transmission list",
    // Ends in -transmissions, with or without a trailing qualifier such as
    // -sale. Real posts about transmissions do not end this way.
    test: (slug) => /-transmissions(-sale)?$/.test(slug),
  },
  {
    id: "engine-parts-stub",
    reason: "Engine-parts-for-sale stub",
    // Anywhere in the slug, not just at the end: the generated ones often
    // carry the model after it ("…-engine-parts-sale-sl600-roadster").
    // "mercedes-engine-parts-guide" has no -sale and is a real post.
    test: (slug) => /engine-parts(-for)?-sale/.test(slug) || /^\d{4}-.*-engine-parts$/.test(slug),
  },
  {
    id: "rim-list",
    reason: "Per-year rim list",
    // A rim list is a year or model stem ending in -rims, or a -rims- list.
    test: (slug) => /^\d{4}-.*-rims$|-rims-\d{4}-|^.*-rims-(series|mercedes)/.test(slug),
  },
  {
    id: "year-model-stub",
    reason: "Year-and-model stub",
    // 1964-mb-220sebc-coupe, 1962-220sebc-coupe, 2015-mercedes-…-suv
    test: (slug) => /^(19|20)\d{2}-(mb|mercedes|benz)?-?[a-z0-9]*\d/.test(slug) && !/-guide$|-explained$|-info$/.test(slug),
  },
  {
    id: "numeric-stub",
    reason: "Untitled numeric stub",
    // 8996-2, 9096-2 — posts that never got a slug.
    test: (slug) => /^\d+(-\d+)?$/.test(slug),
  },
];

/** The slug of a blog URL: the last path segment under /blog/. */
export function blogSlug(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const match = /\/blog\/(.+)$/.exec(path);
    return match ? match[1].split("/").pop() : null;
  } catch {
    return null;
  }
}

/** Whether a URL is a blog post at all. */
export function isBlogUrl(url) {
  return Boolean(blogSlug(url));
}

/**
 * Why a URL would be left out, or null to keep it. Returns the rule so the
 * report can show what was filtered and on what grounds rather than silently
 * shrinking the list.
 */
export function exclusionFor(url) {
  const slug = blogSlug(url);
  if (!slug) return { id: "not-a-post", reason: "Not a blog post" };
  for (const rule of EXCLUSION_RULES) {
    if (rule.test(slug)) return { id: rule.id, reason: rule.reason };
  }
  return null;
}
