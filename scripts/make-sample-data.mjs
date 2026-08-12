/**
 * Generates public/sample-data.json — the dataset behind the report's demo mode.
 *
 * Provenance matters here, so it is stated exactly:
 *
 *   REAL     the query strings, their ranking positions, their search volumes,
 *            and the page URLs. Pulled from Ahrefs Site Explorer for
 *            adsitco.com on 2026-08-12 (1,088 organic keywords, ~4,249 monthly
 *            organic visits). These are genuinely adsitco's terms and pages.
 *
 *   MODELLED every count. Impressions are derived from search volume, clicks
 *            from a position-based click-through curve, and sessions are
 *            anchored so organic traffic lands near the Ahrefs estimate.
 *            Revenue, orders, channel mix and geography are invented outright —
 *            no external source knows them.
 *
 * Nothing here comes from Google Analytics or Search Console. Those need the
 * service account, and once it is configured the report reads them live and
 * this file stops being used.
 *
 * Run: node scripts/make-sample-data.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/sample-data.json");

const HISTORY = 180;
const CURRENCY = "USD";
const WINDOW_DAYS = 28;

// Ahrefs' estimate of monthly organic visits, used to anchor the traffic scale.
const AHREFS_MONTHLY_ORGANIC = 4249;
// Organic's share of total sessions for a parts retailer with brand demand.
const ORGANIC_SHARE = 0.52;

let seed = 20260812;
const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const round = (n) => Math.max(0, Math.round(n));
const money = (n) => Number(n.toFixed(2));

/** Real: keyword, position and volume from Ahrefs. */
const REAL_KEYWORDS = [
  ["mercedes parts", 7, 7600],
  ["mercedes benz parts", 5, 4700],
  ["mercedes parts online", 4, 2700],
  ["mercedes benz parts online", 11, 1700],
  ["mercedes benz vin decoder", 8, 1600],
  ["mercedes-benz parts", 12, 1100],
  ["are mercedes expensive to maintain", 1, 1000],
  ["rebuilt transmission cost", 1, 1000],
  ["how much to rebuild a transmission", 1, 800],
  ["cracked cylinder head", 5, 700],
  ["mercedes-benz auto parts", 7, 700],
  ["mercedes parts catalog", 10, 700],
  ["classic classification to register a car", 1, 600],
  ["cracked head", 1, 600],
  ["mercedes auto parts", 5, 500],
  ["mercedes parts catalog online", 9, 500],
  ["mercedes genuine parts", 8, 450],
  ["vin decoder mercedes", 8, 400],
  ["mercedes bolt pattern", 1, 350],
  ["mercedes engine parts", 3, 300],
  ["parts for mercedes benz", 5, 300],
  ["mercedes lug pattern", 1, 300],
  ["mercedes aftermarket parts", 5, 250],
  ["genuine mercedes benz parts", 6, 250],
  ["best place to buy mercedes parts online", 1, 200],
  ["mercedes part numbers", 2, 200],
  ["aftermarket mercedes parts", 3, 150],
  ["mercedes benz parts for sale", 3, 150],
  ["mercedes replica wheels", 3, 100],
  ["adsit", 1, 70],
];

/** Real: URL and Ahrefs traffic estimate, which sets each page's weight. */
const REAL_PAGES = [
  ["https://www.adsitco.com/", 2136],
  ["https://www.adsitco.com/blog/used-transmission-or-rebuild-a-transmission/", 374],
  ["https://www.adsitco.com/blog/vintage-vs-classic-vs-antique-car-registration/", 147],
  ["https://www.adsitco.com/blog/signs-of-cracked-cylinder-head-mercedes/", 144],
  ["https://www.adsitco.com/blog/mercedes-vin-numbers/", 123],
  ["https://www.adsitco.com/blog/are-mercedes-affordable-to-maintain-cost-tips/", 55],
  ["https://www.adsitco.com/mercedes-benz-parts/engine-and-engine-parts/mercedes-engines/", 50],
  ["https://www.adsitco.com/mercedes-benz-parts/rims/", 48],
  ["https://www.adsitco.com/blog/mercedes-wheel-offset-backspacing-tire-size-guide/", 47],
  ["https://www.adsitco.com/blog/mercedes-benz-reliability/", 47],
  ["https://www.adsitco.com/mercedes-parts/rebuilt-engine-113-amg/", 46],
  ["https://www.adsitco.com/blog/mercedes-engine-parts-guide/", 44],
  ["https://www.adsitco.com/blog/mercedes-wheel-guide-compatibility-upgrades-selection/", 39],
  ["https://www.adsitco.com/blog/understanding-mercedes-benz-part-numbers/", 38],
];

// Titles are derived from the slug rather than scraped — they are presentation
// filler, not a claim about the live <title>.
function titleFromUrl(url) {
  const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, "");
  if (!path) return "Mercedes-Benz Parts | Adsit Company";
  const slug = path.split("/").filter(Boolean).pop();
  const words = slug
    .split("-")
    .map((w) => (w.length <= 3 && w !== "amg" ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  return `${words[0].toUpperCase()}${words.slice(1)} | Adsit Company`;
}

// A conventional organic click-through curve by position. Applied to volume to
// turn a ranking into a plausible click count.
function ctrForPosition(position) {
  const curve = [0.281, 0.152, 0.106, 0.079, 0.061, 0.048, 0.039, 0.032, 0.027, 0.024];
  if (position <= 10) return curve[Math.round(position) - 1];
  if (position <= 20) return 0.016;
  return 0.007;
}

const queries = REAL_KEYWORDS.map(([name, position, volume]) => {
  // Monthly volume scaled to the 28-day window; ranking past page one costs
  // most of the impression share.
  const visibility = position <= 10 ? 1 : position <= 20 ? 0.55 : 0.2;
  const impressions = round(volume * (WINDOW_DAYS / 30) * visibility * (0.85 + random() * 0.3));
  const clicks = round(impressions * ctrForPosition(position));
  return {
    name,
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position,
  };
}).sort((a, b) => b.clicks - a.clicks);

const totalClicks = queries.reduce((t, q) => t + q.clicks, 0);
const totalImpressions = queries.reduce((t, q) => t + q.impressions, 0);
const blendedPosition =
  queries.reduce((t, q) => t + q.position * q.impressions, 0) / (totalImpressions || 1);

const pageTrafficTotal = REAL_PAGES.reduce((t, [, traffic]) => t + traffic, 0);

const searchPages = REAL_PAGES.map(([url, traffic]) => {
  const shareOfClicks = traffic / pageTrafficTotal;
  const clicks = round(totalClicks * shareOfClicks);
  const impressions = round(totalImpressions * shareOfClicks * (0.8 + random() * 0.5));
  return {
    name: url,
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: Number((2.4 + random() * 9).toFixed(1)),
  };
}).sort((a, b) => b.clicks - a.clicks);

/** Spread a window total across days with a weekday rhythm and mild noise. */
function distribute(total, days, weekendFactor) {
  const weights = [];
  for (let back = days; back >= 1; back--) {
    const date = isoDaysAgo(back);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6 ? weekendFactor : 1;
    weights.push({ date, weight: weekend * (0.88 + random() * 0.24) });
  }
  const sum = weights.reduce((t, w) => t + w.weight, 0);
  return weights.map((w) => ({ date: w.date, value: (w.weight / sum) * total }));
}

// The long series runs over HISTORY days, so the per-day rate from the 28-day
// window is scaled up and given a gentle upward trend across the history.
function longSeries(windowTotal, days, lagDays, weekendFactor) {
  const perDay = windowTotal / WINDOW_DAYS;
  const spread = distribute(perDay * days, days, weekendFactor);
  return spread.slice(0, spread.length - lagDays + 1).map((row, i, arr) => {
    const trend = 0.82 + (i / Math.max(arr.length - 1, 1)) * 0.36;
    return { date: row.date, value: row.value * trend };
  });
}

const gscClickSeries = longSeries(totalClicks, HISTORY, 3, 0.62);
const gscImprSeries = longSeries(totalImpressions, HISTORY, 3, 0.62);

const gscDaily = gscClickSeries.map((row, i) => ({
  date: row.date,
  clicks: round(row.value),
  impressions: round(gscImprSeries[i]?.value ?? 0),
  position: Number((blendedPosition + 1.6 - (i / gscClickSeries.length) * 2.4 + random() * 0.9).toFixed(1)),
}));

// Anchor total sessions so organic lands near the Ahrefs estimate.
const organicWindow = round(AHREFS_MONTHLY_ORGANIC * (WINDOW_DAYS / 30));
const sessionsWindow = round(organicWindow / ORGANIC_SHARE);

const sessionSeries = longSeries(sessionsWindow, HISTORY, 1, 0.55);

const ga4Daily = sessionSeries.map((row) => {
  const sessions = round(row.value);
  const users = round(sessions * (0.79 + random() * 0.05));
  // Parts retail: considered purchases, high order value, modest conversion.
  const transactions = round(sessions * (0.009 + random() * 0.007));
  return {
    date: row.date,
    sessions,
    users,
    newUsers: round(users * (0.61 + random() * 0.09)),
    pageViews: round(sessions * (3.1 + random() * 1.2)),
    engagedSessions: round(sessions * (0.55 + random() * 0.12)),
    engagementSeconds: round(users * (88 + random() * 46)),
    keyEvents: round(sessions * (0.028 + random() * 0.02)),
    transactions,
    revenue: money(transactions * (185 + random() * 190)),
  };
});

const sum = (rows, key) => rows.reduce((t, r) => t + (r[key] || 0), 0);
const windowRows = ga4Daily.slice(-WINDOW_DAYS);
const windowSessions = sum(windowRows, "sessions");
const windowRevenue = sum(windowRows, "revenue");
const windowPageViews = sum(windowRows, "pageViews");

const byWeight = (rows, total) => {
  const totalWeight = rows.reduce((t, r) => t + r.weight, 0);
  return rows.map((r) => ({ ...r, share: r.weight / totalWeight, value: (r.weight / totalWeight) * total }));
};

const dimension = (split) =>
  byWeight(split, windowSessions).map((row) => ({
    name: row.name,
    sessions: round(row.value),
    users: round(row.value * 0.8),
    keyEvents: round(row.value * 0.036),
    transactions: round(row.value * 0.012),
    revenue: money(windowRevenue * row.share),
  }));

const channels = dimension([
  { name: "Organic Search", weight: 52 },
  { name: "Direct", weight: 19 },
  { name: "Paid Search", weight: 11 },
  { name: "Referral", weight: 7 },
  { name: "Email", weight: 5 },
  { name: "Organic Social", weight: 4 },
  { name: "Unassigned", weight: 2 },
]);

const sources = dimension([
  { name: "google / organic", weight: 47 },
  { name: "(direct) / (none)", weight: 19 },
  { name: "google / cpc", weight: 11 },
  { name: "bing / organic", weight: 5 },
  { name: "duckduckgo / organic", weight: 3 },
  { name: "klaviyo / email", weight: 5 },
  { name: "benzworld.org / referral", weight: 4 },
  { name: "peachparts.com / referral", weight: 3 },
  { name: "facebook.com / referral", weight: 3 },
]);

const countries = dimension([
  { name: "United States", weight: 74 },
  { name: "Canada", weight: 9 },
  { name: "United Kingdom", weight: 5 },
  { name: "Australia", weight: 4 },
  { name: "Germany", weight: 3 },
  { name: "Mexico", weight: 3 },
  { name: "United Arab Emirates", weight: 2 },
]);

// Parts buyers skew to desktop — bigger baskets, part-number cross-checking.
const devices = dimension([
  { name: "desktop", weight: 61 },
  { name: "mobile", weight: 35 },
  { name: "tablet", weight: 4 },
]);

const pages = byWeight(
  REAL_PAGES.map(([url, traffic]) => ({ name: url.replace(/^https?:\/\/[^/]+/, "") || "/", weight: traffic, url })),
  windowPageViews,
).map((row) => ({
  name: row.name,
  title: titleFromUrl(row.url),
  pageViews: round(row.value),
  sessions: round(row.value * 0.66),
  engagedSessions: round(row.value * 0.4),
  // Category and product pages convert; blog posts mostly do not.
  revenue: money(windowRevenue * row.share * (row.name.startsWith("/blog") ? 0.12 : 1.9)),
}));

const searchByWeight = (split) => {
  const totalWeight = split.reduce((t, r) => t + r.weight, 0);
  return split.map((r) => {
    const clicks = round(totalClicks * (r.weight / totalWeight));
    const impressions = round(totalImpressions * (r.weight / totalWeight) * (0.9 + random() * 0.25));
    return {
      name: r.name,
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: r.position,
    };
  });
};

const snapshot = {
  sample: true,
  generatedAt: new Date().toISOString(),
  siteLabel: "adsitco.com",
  currency: CURRENCY,
  historyDays: 90,
  filters: { device: "", channel: "" },
  filtersAppliedToSearch: { device: true, channel: false },
  window: {
    days: WINDOW_DAYS,
    ga4: { start: ga4Daily.at(-WINDOW_DAYS).date, end: ga4Daily.at(-1).date },
    gsc: { start: gscDaily.at(-WINDOW_DAYS).date, end: gscDaily.at(-1).date },
  },
  ga4: {
    daily: ga4Daily,
    channels,
    sources,
    countries,
    devices,
    pages,
    channelOptions: channels.map((c) => c.name),
    keyEventMetric: "keyEvents",
    hasRevenue: true,
  },
  gsc: {
    daily: gscDaily,
    queries,
    pages: searchPages,
    countries: searchByWeight([
      { name: "usa", weight: 74, position: 7.9 },
      { name: "can", weight: 9, position: 9.4 },
      { name: "gbr", weight: 5, position: 11.2 },
      { name: "aus", weight: 4, position: 12.1 },
      { name: "deu", weight: 3, position: 14.6 },
      { name: "mex", weight: 3, position: 13.3 },
    ]),
    devices: searchByWeight([
      { name: "DESKTOP", weight: 58, position: 7.4 },
      { name: "MOBILE", weight: 38, position: 10.1 },
      { name: "TABLET", weight: 4, position: 11.5 },
    ]),
  },
  warnings: [],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(snapshot)}\n`);

console.log(
  `Wrote ${OUT}\n` +
    `  ${ga4Daily.length} analytics days, ${gscDaily.length} search days\n` +
    `  ${WINDOW_DAYS}-day window: ${windowSessions.toLocaleString()} sessions ` +
    `(organic target ${organicWindow.toLocaleString()}), ` +
    `${totalClicks.toLocaleString()} clicks, ${totalImpressions.toLocaleString()} impressions, ` +
    `avg position ${blendedPosition.toFixed(1)}, ` +
    `${CURRENCY} ${Math.round(windowRevenue).toLocaleString()} revenue\n` +
    `  queries and URLs: real (Ahrefs, adsitco.com) · all counts: modelled`,
);
