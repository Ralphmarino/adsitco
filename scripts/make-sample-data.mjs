/**
 * Generates public/sample-data.json — the dataset behind the report's demo mode.
 *
 * The numbers are invented. They are shaped to look plausible (weekday/weekend
 * rhythm, a slow upward trend, a realistic click-through and position profile)
 * so the layout can be reviewed with something lifelike in it, but they describe
 * no real website. The report labels this data as synthetic wherever it appears.
 *
 * Run: node scripts/make-sample-data.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/sample-data.json");

const HISTORY = 180;
const CURRENCY = "USD";

// A fixed seed keeps regeneration deterministic, so a rerun does not produce a
// gratuitous diff.
let seed = 20260812;
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const round = (n) => Math.max(0, Math.round(n));

function ga4Daily() {
  const rows = [];
  for (let back = HISTORY; back >= 1; back--) {
    const date = isoDaysAgo(back);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekendDip = weekday === 0 || weekday === 6 ? 0.55 : 1;
    const growth = 1 + (HISTORY - back) * 0.0022;
    const noise = 0.88 + random() * 0.24;
    const sessions = round(185 * weekendDip * growth * noise);
    const users = round(sessions * (0.78 + random() * 0.06));
    const transactions = round(sessions * (0.016 + random() * 0.012));
    rows.push({
      date,
      sessions,
      users,
      newUsers: round(users * (0.58 + random() * 0.1)),
      pageViews: round(sessions * (2.1 + random() * 0.9)),
      engagedSessions: round(sessions * (0.58 + random() * 0.12)),
      engagementSeconds: round(users * (62 + random() * 34)),
      keyEvents: round(sessions * (0.03 + random() * 0.025)),
      transactions,
      revenue: Number((transactions * (128 + random() * 92)).toFixed(2)),
    });
  }
  return rows;
}

function gscDaily() {
  const rows = [];
  for (let back = HISTORY; back >= 3; back--) {
    const date = isoDaysAgo(back);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekendDip = weekday === 0 || weekday === 6 ? 0.62 : 1;
    const growth = 1 + (HISTORY - back) * 0.0026;
    const impressions = round(5400 * weekendDip * growth * (0.9 + random() * 0.2));
    rows.push({
      date,
      clicks: round(impressions * (0.028 + random() * 0.014)),
      impressions,
      // Slow drift from ~14 toward ~9 — a believable improvement curve.
      position: Number((14.2 - (HISTORY - back) * 0.028 + random() * 1.6).toFixed(1)),
    });
  }
  return rows;
}

const ga4 = ga4Daily();
const gsc = gscDaily();

const windowDays = 28;
const inWindow = (rows, days) => rows.slice(-days);
const sum = (rows, key) => rows.reduce((t, r) => t + (r[key] || 0), 0);

const windowGa4 = inWindow(ga4, windowDays);
const windowGsc = inWindow(gsc, windowDays);
const totalSessions = sum(windowGa4, "sessions");
const totalRevenue = sum(windowGa4, "revenue");
const totalClicks = sum(windowGsc, "clicks");
const totalImpressions = sum(windowGsc, "impressions");

// Dimension tables are built as shares of the window totals so every panel
// reconciles with the headline figures instead of contradicting them.
const share = (rows, total, key) => {
  const weights = rows.map((r) => r.weight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  return rows.map((r) => ({ ...r, [key]: round((r.weight / totalWeight) * total) }));
};

const channelSplit = [
  { name: "Organic Search", weight: 44 },
  { name: "Direct", weight: 21 },
  { name: "Paid Search", weight: 13 },
  { name: "Referral", weight: 9 },
  { name: "Organic Social", weight: 7 },
  { name: "Email", weight: 4 },
  { name: "Unassigned", weight: 2 },
];

const channels = share(channelSplit, totalSessions, "sessions").map((c) => ({
  name: c.name,
  sessions: c.sessions,
  users: round(c.sessions * 0.8),
  keyEvents: round(c.sessions * 0.042),
  transactions: round(c.sessions * 0.021),
  revenue: Number((totalRevenue * (c.weight / 100)).toFixed(2)),
}));

const sourceSplit = [
  { name: "google / organic", weight: 41 },
  { name: "(direct) / (none)", weight: 21 },
  { name: "google / cpc", weight: 13 },
  { name: "bing / organic", weight: 6 },
  { name: "linkedin.com / referral", weight: 5 },
  { name: "newsletter / email", weight: 4 },
  { name: "facebook.com / referral", weight: 3 },
];

const sources = share(sourceSplit, totalSessions, "sessions").map((s) => ({
  name: s.name,
  sessions: s.sessions,
  users: round(s.sessions * 0.81),
  keyEvents: round(s.sessions * 0.04),
  transactions: round(s.sessions * 0.02),
  revenue: Number((totalRevenue * (s.weight / 100)).toFixed(2)),
}));

const countrySplit = [
  { name: "United States", weight: 58 },
  { name: "United Kingdom", weight: 12 },
  { name: "Canada", weight: 9 },
  { name: "Australia", weight: 6 },
  { name: "Germany", weight: 4 },
  { name: "Ireland", weight: 3 },
];

const countries = share(countrySplit, totalSessions, "sessions").map((c) => ({
  name: c.name,
  sessions: c.sessions,
  users: round(c.sessions * 0.8),
  keyEvents: round(c.sessions * 0.038),
  transactions: round(c.sessions * 0.019),
  revenue: Number((totalRevenue * (c.weight / 100)).toFixed(2)),
}));

const deviceSplit = [
  { name: "desktop", weight: 57 },
  { name: "mobile", weight: 39 },
  { name: "tablet", weight: 4 },
];

const devices = share(deviceSplit, totalSessions, "sessions").map((d) => ({
  name: d.name,
  sessions: d.sessions,
  users: round(d.sessions * 0.8),
  keyEvents: round(d.sessions * 0.04),
  transactions: round(d.sessions * 0.02),
  revenue: Number((totalRevenue * (d.weight / 100)).toFixed(2)),
}));

const pageSplit = [
  { name: "/", title: "Adsitco — Advertising that pays for itself", weight: 26 },
  { name: "/services", title: "Services — Adsitco", weight: 15 },
  { name: "/services/paid-search", title: "Paid search management — Adsitco", weight: 11 },
  { name: "/pricing", title: "Pricing — Adsitco", weight: 10 },
  { name: "/case-studies", title: "Case studies — Adsitco", weight: 9 },
  { name: "/blog/small-business-ppc-guide", title: "The small business PPC guide — Adsitco", weight: 8 },
  { name: "/contact", title: "Contact us — Adsitco", weight: 7 },
  { name: "/about", title: "About Adsitco", weight: 6 },
  { name: "/blog/google-ads-budget", title: "How to set a Google Ads budget — Adsitco", weight: 5 },
  { name: "/careers", title: "Careers — Adsitco", weight: 3 },
];

const totalPageViews = sum(windowGa4, "pageViews");
const pages = share(pageSplit, totalPageViews, "pageViews").map((p) => ({
  name: p.name,
  title: p.title,
  pageViews: p.pageViews,
  sessions: round(p.pageViews * 0.68),
  engagedSessions: round(p.pageViews * 0.42),
  revenue: Number((totalRevenue * (p.weight / 100)).toFixed(2)),
}));

// Queries: branded terms convert high and rank well; generic head terms carry
// impressions at a weaker position. That contrast is what makes the table
// useful to look at.
const querySplit = [
  { name: "adsitco", clickWeight: 19, imprWeight: 4, position: 1.2 },
  { name: "adsitco reviews", clickWeight: 9, imprWeight: 3, position: 1.8 },
  { name: "adsitco pricing", clickWeight: 7, imprWeight: 2, position: 2.1 },
  { name: "advertising agency near me", clickWeight: 11, imprWeight: 14, position: 6.4 },
  { name: "ppc management pricing", clickWeight: 9, imprWeight: 12, position: 7.9 },
  { name: "google ads agency", clickWeight: 8, imprWeight: 15, position: 9.6 },
  { name: "small business advertising", clickWeight: 7, imprWeight: 13, position: 11.2 },
  { name: "digital marketing consultant", clickWeight: 6, imprWeight: 11, position: 12.8 },
  { name: "how to set a google ads budget", clickWeight: 6, imprWeight: 8, position: 5.3 },
  { name: "paid search management services", clickWeight: 5, imprWeight: 7, position: 10.4 },
  { name: "best ppc agency for small business", clickWeight: 5, imprWeight: 6, position: 8.7 },
  { name: "google ads vs facebook ads", clickWeight: 4, imprWeight: 9, position: 14.1 },
  { name: "adsitco careers", clickWeight: 2, imprWeight: 1, position: 2.6 },
  { name: "advertising agency dublin", clickWeight: 2, imprWeight: 5, position: 16.3 },
];

const withSearchMetrics = (rows) => {
  const clickTotal = rows.reduce((t, r) => t + r.clickWeight, 0);
  const imprTotal = rows.reduce((t, r) => t + r.imprWeight, 0);
  return rows.map((r) => {
    const clicks = round((r.clickWeight / clickTotal) * totalClicks);
    const impressions = round((r.imprWeight / imprTotal) * totalImpressions);
    return {
      name: r.name,
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: r.position,
    };
  });
};

const queries = withSearchMetrics(querySplit);

const landingSplit = [
  { name: "https://adsitco.com/", clickWeight: 34, imprWeight: 26, position: 3.1 },
  { name: "https://adsitco.com/services/paid-search", clickWeight: 17, imprWeight: 18, position: 7.2 },
  { name: "https://adsitco.com/pricing", clickWeight: 14, imprWeight: 12, position: 5.8 },
  { name: "https://adsitco.com/blog/small-business-ppc-guide", clickWeight: 12, imprWeight: 17, position: 9.4 },
  { name: "https://adsitco.com/services", clickWeight: 9, imprWeight: 11, position: 8.1 },
  { name: "https://adsitco.com/case-studies", clickWeight: 7, imprWeight: 9, position: 11.6 },
  { name: "https://adsitco.com/blog/google-ads-budget", clickWeight: 5, imprWeight: 5, position: 6.7 },
  { name: "https://adsitco.com/contact", clickWeight: 2, imprWeight: 2, position: 4.3 },
];

const searchCountries = withSearchMetrics([
  { name: "usa", clickWeight: 57, imprWeight: 54, position: 8.4 },
  { name: "gbr", clickWeight: 14, imprWeight: 16, position: 9.9 },
  { name: "can", clickWeight: 10, imprWeight: 11, position: 10.6 },
  { name: "aus", clickWeight: 8, imprWeight: 9, position: 11.8 },
  { name: "irl", clickWeight: 6, imprWeight: 5, position: 7.2 },
  { name: "deu", clickWeight: 5, imprWeight: 5, position: 13.4 },
]);

const searchDevices = withSearchMetrics([
  { name: "DESKTOP", clickWeight: 55, imprWeight: 51, position: 8.1 },
  { name: "MOBILE", clickWeight: 41, imprWeight: 45, position: 10.7 },
  { name: "TABLET", clickWeight: 4, imprWeight: 4, position: 11.9 },
]);

const snapshot = {
  // Consumed by the front end to raise the synthetic-data banner. The report
  // refuses to present this dataset as real.
  sample: true,
  generatedAt: new Date().toISOString(),
  siteLabel: "adsitco.com",
  currency: CURRENCY,
  historyDays: 90,
  filters: { device: "", channel: "" },
  filtersAppliedToSearch: { device: true, channel: false },
  window: {
    days: windowDays,
    ga4: { start: ga4[ga4.length - windowDays].date, end: ga4[ga4.length - 1].date },
    gsc: { start: gsc[gsc.length - windowDays].date, end: gsc[gsc.length - 1].date },
  },
  ga4: {
    daily: ga4,
    channels,
    sources,
    countries,
    devices,
    pages,
    channelOptions: channelSplit.map((c) => c.name),
    keyEventMetric: "keyEvents",
    hasRevenue: true,
  },
  gsc: {
    daily: gsc,
    queries,
    pages: withSearchMetrics(landingSplit),
    countries: searchCountries,
    devices: searchDevices,
  },
  warnings: [],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 0)}\n`);

console.log(
  `Wrote ${OUT}\n` +
    `  ${ga4.length} analytics days, ${gsc.length} search days\n` +
    `  ${windowDays}-day window: ${totalSessions.toLocaleString()} sessions, ` +
    `${totalClicks.toLocaleString()} clicks, ${totalImpressions.toLocaleString()} impressions, ` +
    `${CURRENCY} ${Math.round(totalRevenue).toLocaleString()} revenue`,
);
