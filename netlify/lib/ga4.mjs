import { googleFetch, requireEnv } from "./google-auth.mjs";
import { fromCompactDate } from "./dates.mjs";
import { lookupCountry } from "./countries.mjs";

const SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];

// Not every metric exists on every property: GA4 renamed "conversions" to
// "keyEvents", and revenue metrics are rejected outright on some older
// properties. Rather than let one unavailable metric fail the whole report,
// probe the optional ones once per cold start and drop whatever is missing.
let optionalMetrics;

function endpoint(propertyId) {
  return `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
}

async function runReport(body) {
  const propertyId = requireEnv("GA4_PROPERTY_ID").replace(/\D/g, "");
  if (!propertyId) {
    throw new Error("GA4_PROPERTY_ID must be the numeric property ID, e.g. 123456789");
  }
  return googleFetch(endpoint(propertyId), { scopes: SCOPES, body });
}

async function metricExists(name) {
  try {
    await runReport({
      dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
      metrics: [{ name }],
      limit: 1,
    });
    return true;
  } catch (err) {
    if (err.status === 400) return false;
    throw err;
  }
}

export async function resolveMetrics() {
  if (optionalMetrics) return optionalMetrics;

  let keyEvent = null;
  for (const candidate of ["keyEvents", "conversions"]) {
    if (await metricExists(candidate)) {
      keyEvent = candidate;
      break;
    }
  }

  // "Total revenue" is the figure GA4 itself leads with, and it covers purchase,
  // subscription and ad revenue — so it reports sales on an ecommerce property
  // without going blank on one that books revenue another way.
  const revenue = (await metricExists("totalRevenue")) ? "totalRevenue" : null;
  const transactions = (await metricExists("transactions")) ? "transactions" : null;

  optionalMetrics = { keyEvent, revenue, transactions };
  return optionalMetrics;
}

function flattenRows(json) {
  const dimensions = (json.dimensionHeaders || []).map((h) => h.name);
  const metrics = (json.metricHeaders || []).map((h) => h.name);
  return (json.rows || []).map((row) => {
    const out = {};
    dimensions.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? "";
    });
    metrics.forEach((name, i) => {
      const num = Number(row.metricValues?.[i]?.value);
      out[name] = Number.isFinite(num) ? num : 0;
    });
    return out;
  });
}

const metricList = (names) => names.filter(Boolean).map((name) => ({ name }));

/**
 * Translate the report's filter selection into a GA4 dimensionFilter. Filters
 * are applied by the API, not after the fact, so a filtered view recomputes
 * every number — totals, trends and tables alike — rather than just hiding rows.
 */
function dimensionFilter(filters = {}) {
  const expressions = [];
  if (filters.device) {
    expressions.push({
      filter: {
        fieldName: "deviceCategory",
        stringFilter: { value: filters.device, matchType: "EXACT" },
      },
    });
  }
  if (filters.channel) {
    expressions.push({
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { value: filters.channel, matchType: "EXACT" },
      },
    });
  }
  if (filters.country) {
    // countryId is the ISO alpha-2 code, so the filter does not depend on the
    // property's reporting language the way the display name would.
    const alpha2 = lookupCountry(filters.country)?.alpha2;
    if (alpha2) {
      expressions.push({
        filter: { fieldName: "countryId", stringFilter: { value: alpha2, matchType: "EXACT" } },
      });
    }
  }
  if (!expressions.length) return undefined;
  return { andGroup: { expressions } };
}

/**
 * Daily rows over a long history.
 *
 * Only additive metrics are pulled — rates are derived in the front end from
 * their components (engagement rate = engagedSessions / sessions, average
 * engagement time = userEngagementDuration / totalUsers). That is what lets any
 * date range be recomputed client-side from one stored series without
 * re-querying the API, and it keeps the derived rates exact rather than an
 * average-of-averages.
 */
export async function fetchGa4Daily({ startDate, endDate, filters }) {
  const { keyEvent, revenue, transactions } = await resolveMetrics();

  const json = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: metricList([
      "sessions",
      "totalUsers",
      "newUsers",
      "screenPageViews",
      "engagedSessions",
      "userEngagementDuration",
      keyEvent,
      revenue,
      transactions,
    ]),
    dimensionFilter: dimensionFilter(filters),
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 1000,
  });

  return flattenRows(json).map((row) => ({
    date: fromCompactDate(row.date),
    sessions: row.sessions || 0,
    users: row.totalUsers || 0,
    newUsers: row.newUsers || 0,
    pageViews: row.screenPageViews || 0,
    engagedSessions: row.engagedSessions || 0,
    engagementSeconds: row.userEngagementDuration || 0,
    keyEvents: keyEvent ? row[keyEvent] || 0 : 0,
    revenue: revenue ? row[revenue] || 0 : 0,
    transactions: transactions ? row[transactions] || 0 : 0,
  }));
}

async function breakdown({ start, end, dimension, limit, filters, metrics }) {
  const { keyEvent, revenue, transactions } = metrics;
  const json = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: dimension }],
    metrics: metricList(["sessions", "totalUsers", keyEvent, revenue, transactions]),
    dimensionFilter: dimensionFilter(filters),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
  });
  return flattenRows(json).map((row) => ({
    name: row[dimension] || "(not set)",
    sessions: row.sessions || 0,
    users: row.totalUsers || 0,
    keyEvents: keyEvent ? row[keyEvent] || 0 : 0,
    revenue: revenue ? row[revenue] || 0 : 0,
    transactions: transactions ? row[transactions] || 0 : 0,
  }));
}

async function topPages({ start, end, limit, filters, metrics }) {
  const { revenue } = metrics;
  const json = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: metricList(["screenPageViews", "sessions", "engagedSessions", revenue]),
    dimensionFilter: dimensionFilter(filters),
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit,
  });
  return flattenRows(json).map((row) => ({
    name: row.pagePath,
    title: row.pageTitle,
    pageViews: row.screenPageViews || 0,
    sessions: row.sessions || 0,
    engagedSessions: row.engagedSessions || 0,
    revenue: revenue ? row[revenue] || 0 : 0,
  }));
}

/**
 * The unfiltered channel list, used to populate the channel filter control.
 * Fetched alongside the filtered breakdowns so the dropdown still lists every
 * channel once one of them is selected.
 */
async function allChannelNames({ start, end }) {
  const json = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: metricList(["sessions"]),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 20,
  });
  return flattenRows(json)
    .map((row) => row.sessionDefaultChannelGroup)
    .filter(Boolean);
}

/** Dimension tables for one window. */
export async function collectGa4Breakdowns({ start, end, filters }) {
  const metrics = await resolveMetrics();
  const args = { start, end, filters, metrics };

  const [channels, sources, countries, devices, pages, channelOptions] = await Promise.all([
    breakdown({ ...args, dimension: "sessionDefaultChannelGroup", limit: 12 }),
    breakdown({ ...args, dimension: "sessionSourceMedium", limit: 25 }),
    breakdown({ ...args, dimension: "country", limit: 15 }),
    breakdown({ ...args, dimension: "deviceCategory", limit: 5 }),
    topPages({ ...args, limit: 30 }),
    allChannelNames({ start, end }),
  ]);

  return {
    channels,
    sources,
    countries,
    devices,
    pages,
    channelOptions,
    keyEventMetric: metrics.keyEvent,
    hasRevenue: Boolean(metrics.revenue),
  };
}
