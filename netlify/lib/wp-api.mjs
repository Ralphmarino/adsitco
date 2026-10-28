/**
 * Dates straight from WordPress.
 *
 * The sitemap was the wrong primary source. It carries `lastmod` and nothing
 * else, it depends on the SEO plugin writing one, and reading it told us
 * nothing about publication dates — which is why the first version needed a
 * per-post HTML fetch and a backfill queue that would have taken a week of
 * nightly runs to fill in.
 *
 * WordPress's own REST API carries `date` and `modified` for every post and
 * will return a hundred of them in one request. Better still, it takes a list
 * of slugs, so the tracker asks for exactly the posts it tracks: ~110 posts in
 * three requests, both dates, no queue, nothing to backfill.
 *
 * The endpoint is public on a default install. Where it has been disabled the
 * request 404s and the caller falls back to the sitemap and HTML.
 */

import { fetchJson, SiteFetchError } from "./site-fetch.mjs";
import { blogSlug } from "./blog-rules.mjs";

const API_ROOT = process.env.BLOG_WP_API_ROOT || "https://www.adsitco.com/wp-json/wp/v2";

// Slugs per request. WordPress caps `per_page` at 100; 40 keeps the query
// string comfortably short even with long slugs.
const SLUG_CHUNK = 40;

// `id` is the audit spec's join key across every source, so it comes back on
// every request even though nothing here looks a post up by it.
const FIELDS = "id,link,slug,date,modified,status,title,categories,tags,featured_media";

// Rendered content, for the conformance checks. Asked for separately because
// it is two orders of magnitude more bytes than the dates and is only needed
// by the nightly job.
const CONTENT_FIELDS = "id,link,slug,content";

const isoDay = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
};

const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

function normalise(post) {
  return {
    id: post.id ?? null,
    url: post.link ?? null,
    slug: post.slug ?? null,
    published: isoDay(post.date),
    modified: isoDay(post.modified),
    title: decodeEntities(post.title?.rendered ?? ""),
    status: post.status ?? null,
    // Term IDs, not names. Resolving them would be two more requests for
    // something the audit records carry as text anyway; they are here so a
    // category or tag the audit has not reached is still visible as an id.
    categoryIds: Array.isArray(post.categories) ? post.categories : [],
    tagIds: Array.isArray(post.tags) ? post.tags : [],
    featuredMedia: post.featured_media || null,
  };
}

/**
 * Published and modified dates for a specific set of post URLs.
 *
 * Returns what it found plus which slugs came back empty, so "the API does
 * not know this post" is distinguishable from "the API could not be reached".
 */
export async function fetchPostDates(urls) {
  const wanted = new Map();
  for (const url of urls) {
    const slug = blogSlug(url);
    if (slug) wanted.set(slug, url);
  }
  if (!wanted.size) return { posts: [], missing: [], requests: 0 };

  const posts = [];
  const seen = new Set();
  let requests = 0;

  for (const slugs of chunk([...wanted.keys()], SLUG_CHUNK)) {
    const query = slugs.map((s) => `slug[]=${encodeURIComponent(s)}`).join("&");
    const { data } = await fetchJson(`${API_ROOT}/posts?${query}&per_page=100&_fields=${FIELDS}`);
    requests += 1;
    if (!Array.isArray(data)) throw new SiteFetchError(API_ROOT, null, "unexpected API response");
    for (const post of data) {
      const row = normalise(post);
      if (row.slug) seen.add(row.slug);
      posts.push(row);
    }
  }

  return {
    posts,
    missing: [...wanted.entries()].filter(([slug]) => !seen.has(slug)).map(([, url]) => url),
    requests,
  };
}

/**
 * The most recently published posts, newest first — the discovery half. This
 * is what notices a post written since the curated list was drawn up, and it
 * works whether or not the sitemap is readable.
 */
export async function fetchRecentPosts({ limit = 100 } = {}) {
  const { data } = await fetchJson(
    `${API_ROOT}/posts?per_page=${Math.min(limit, 100)}&orderby=date&order=desc&_fields=${FIELDS}`,
  );
  if (!Array.isArray(data)) throw new SiteFetchError(API_ROOT, null, "unexpected API response");
  return data.map(normalise);
}

/**
 * Rendered post content, for the format-conformance checks.
 *
 * Separate from `fetchPostDates` and asked for in smaller batches because the
 * payload is the whole article: a hundred posts is several megabytes, so this
 * runs on the nightly job and not on a page load. A chunk that fails is
 * skipped rather than failing the run — conformance on 90 posts is worth more
 * than an error on all of them.
 */
export async function fetchPostContent(urls, { chunkSize = 10 } = {}) {
  const wanted = new Map();
  for (const url of urls) {
    const slug = blogSlug(url);
    if (slug) wanted.set(slug, url);
  }

  const content = new Map();
  const failed = [];
  let requests = 0;

  for (const slugs of chunk([...wanted.keys()], chunkSize)) {
    const query = slugs.map((s) => `slug[]=${encodeURIComponent(s)}`).join("&");
    try {
      const { data } = await fetchJson(
        `${API_ROOT}/posts?${query}&per_page=100&_fields=${CONTENT_FIELDS}`,
      );
      requests += 1;
      for (const post of Array.isArray(data) ? data : []) {
        if (post.link) content.set(post.link, post.content?.rendered ?? "");
      }
    } catch (err) {
      failed.push({ slugs: slugs.length, error: err.message });
    }
  }

  return { content, failed, requests, wanted: wanted.size };
}

export { API_ROOT as WP_API_ROOT };
