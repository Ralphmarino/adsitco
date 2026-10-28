/**
 * The sitemap, and dates scraped from a post's own HTML.
 *
 * Both are now fallbacks. The WordPress REST API (wp-api.mjs) carries the same
 * dates and more of them per request, so these exist for the cases where it
 * does not answer: a disabled REST route, or a generated sitemap that is the
 * only thing the host will serve.
 *
 * A single hardcoded sitemap path was a bad bet. `/post-sitemap.xml` is a Yoast
 * convention; WordPress core publishes `/wp-sitemap.xml`, and the first deploy
 * got a 403 on the one path it knew. So the candidates are tried in order,
 * robots.txt is read for anything it declares, and the report says which
 * address answered and what each of the others said.
 */

import { fetchText, SiteFetchError, describeFailure } from "./site-fetch.mjs";

const SITE_ORIGIN = (process.env.BLOG_SITE_ORIGIN || "https://www.adsitco.com").replace(/\/+$/, "");

// Yoast first, then WordPress core, then the generic names.
const CANDIDATE_PATHS = [
  "/post-sitemap.xml",
  "/wp-sitemap-posts-post-1.xml",
  "/sitemap_index.xml",
  "/wp-sitemap.xml",
  "/sitemap.xml",
];

const SITEMAP_URL = process.env.BLOG_SITEMAP_URL || `${SITE_ORIGIN}${CANDIDATE_PATHS[0]}`;

const stripCdata = (s) =>
  String(s ?? "")
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .trim();

function toISODate(value) {
  const text = stripCdata(value);
  if (!text) return null;
  // Sitemaps use W3C datetime; a plain date is also valid. A bare local
  // datetime is read as UTC rather than as the function's timezone.
  const parsed = Date.parse(
    /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text,
  );
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return iso ? iso[1] : null;
}

/** Sitemap addresses robots.txt declares, which beats guessing at paths. */
async function sitemapsFromRobots() {
  try {
    const { text } = await fetchText(`${SITE_ORIGIN}/robots.txt`, { accept: "text/plain,*/*" });
    return [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  } catch {
    return [];
  }
}

function parseEntries(xml) {
  const entries = [];
  for (const block of xml.matchAll(/<url[\s>][\s\S]*?<\/url>/gi)) {
    const body = block[0];
    const loc = /<loc[^>]*>([\s\S]*?)<\/loc>/i.exec(body)?.[1];
    if (!loc) continue;
    const lastmod =
      /<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i.exec(body)?.[1] ??
      // WordPress core writes the date in a news/image extension on some
      // installs; Yoast omits lastmod entirely when it has nothing to say.
      /<\w*:?modified[^>]*>([\s\S]*?)<\/\w*:?modified>/i.exec(body)?.[1];
    entries.push({ url: stripCdata(loc), lastmod: toISODate(lastmod) });
  }
  return entries;
}

/**
 * Every <url> in one sitemap, as { url, lastmod }. A sitemap index is followed
 * one level down, and a sitemap index of post sitemaps is preferred over the
 * whole-site one: on a site with ~38,000 generated URLs, reading every child
 * would pull megabytes to find a hundred posts.
 */
async function readSitemap(url, { depth = 0 } = {}) {
  const { text: xml } = await fetchText(url, { accept: "application/xml,text/xml,*/*;q=0.8" });

  if (/<sitemapindex[\s>]/i.test(xml) && depth < 2) {
    const children = [...xml.matchAll(/<sitemap[\s>][\s\S]*?<\/sitemap>/gi)]
      .map((m) => /<loc[^>]*>([\s\S]*?)<\/loc>/i.exec(m[0])?.[1])
      .filter(Boolean)
      .map(stripCdata);
    // Post sitemaps only, where the index names them. Falls back to all
    // children when the naming gives nothing away.
    const posts = children.filter((c) => /post|blog/i.test(c));
    const entries = [];
    for (const child of (posts.length ? posts : children).slice(0, 10)) {
      try {
        entries.push(...(await readSitemap(child, { depth: depth + 1 })));
      } catch {
        // One unreadable child should not lose the rest.
      }
    }
    return entries;
  }

  return parseEntries(xml);
}

/**
 * The sitemap, from whichever address answers.
 *
 * `BLOG_SITEMAP_URL` is honoured alone when set — an explicit address is an
 * instruction, not a hint. Otherwise robots.txt is consulted and the usual
 * paths are tried in turn. Returns the entries alongside every attempt, so a
 * total failure can say what each address returned instead of one 403.
 */
export async function fetchSitemap() {
  const explicit = process.env.BLOG_SITEMAP_URL;
  const candidates = explicit
    ? [explicit]
    : [...new Set([...(await sitemapsFromRobots()), ...CANDIDATE_PATHS.map((p) => `${SITE_ORIGIN}${p}`)])];

  const attempts = [];
  for (const url of candidates) {
    try {
      const entries = await readSitemap(url);
      attempts.push({ url, ok: true, entries: entries.length });
      if (entries.length) return { entries, url, attempts };
      // An empty but readable sitemap is not an error; keep looking in case
      // another address has the posts.
    } catch (err) {
      attempts.push({ url, ok: false, ...describeFailure(err) });
    }
  }

  const readable = attempts.find((a) => a.ok);
  if (readable) return { entries: [], url: readable.url, attempts };

  // Report the first refusal as it was, rather than rebuilding its message
  // from a status that is already inside it — "403 403 Forbidden" is nobody's
  // idea of a diagnostic.
  const first = attempts[0];
  const err = new SiteFetchError(first?.url ?? SITE_ORIGIN, null, first?.error ?? "no sitemap found");
  err.status = first?.status ?? null;
  err.attempts_detail = attempts;
  throw err;
}

const PUBLISHED_PATTERNS = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /"datePublished"\s*:\s*"([^"]+)"/i,
  /<time[^>]+class=["'][^"']*\bpublished\b[^"']*["'][^>]+datetime=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["'][^>]*class=["'][^"']*\bpublished\b/i,
];

const MODIFIED_PATTERNS = [
  /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:modified_time["']/i,
  /"dateModified"\s*:\s*"([^"]+)"/i,
  /<time[^>]+class=["'][^"']*\b(?:updated|modified)\b[^"']*["'][^>]+datetime=["']([^"']+)["']/i,
];

const firstMatch = (html, patterns) => {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const iso = match && toISODate(match[1]);
    if (iso) return iso;
  }
  return null;
};

/** A post's publication date, or null rather than a guess. */
export const publishedDateFrom = (html) => firstMatch(html, PUBLISHED_PATTERNS);

/** A post's last-modified date, which is what the sitemap would have given. */
export const modifiedDateFrom = (html) => firstMatch(html, MODIFIED_PATTERNS);

/**
 * Both dates from a post's own page, for the posts no other source covered.
 *
 * Still capped, because this is one request per post. `remaining` counts the
 * posts actually left unresolved rather than subtracting the limit — the old
 * version reported "99 still to fetch" after eight requests that had all been
 * refused, which read as progress.
 */
export async function scrapePostDates(urls, { limit = 25 } = {}) {
  const found = {};
  const failed = [];
  const attempted = urls.slice(0, limit);

  for (const url of attempted) {
    try {
      const { text } = await fetchText(url);
      const published = publishedDateFrom(text);
      const modified = modifiedDateFrom(text);
      // Recorded either way: a post whose page carries no machine-readable
      // date should not be re-fetched every night forever.
      found[url] = { published, modified, checked: true };
    } catch (err) {
      failed.push({ url, ...describeFailure(err) });
    }
  }

  const resolved = Object.values(found).filter((d) => d.published || d.modified).length;
  return {
    found,
    failed,
    attempted: attempted.length,
    resolved,
    remaining: urls.length - attempted.length + failed.length,
  };
}

export { SITEMAP_URL, SITE_ORIGIN, CANDIDATE_PATHS };
