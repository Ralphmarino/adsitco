import { googleFetch, requireEnv } from "./google-auth.mjs";
import { fromCompactDate } from "./dates.mjs";

const SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];

// GA4 renamed "conversions" to "keyEvents". Which name a property answers to
// depends on how old it is, so resolve it once per cold start by trying the
// current name first and falling back.
let keyEventMetric;

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

export async function resolveKeyEventMetric() {
  if (keyEventMetric !== undefined) return keyEventMetric;
  for (const candidate of ["keyEvents", "conversions"]) {
    try {
      await runReport({
        dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
        metrics: [{ name: candidate }],
        limit: 1,
      });
      keyEventMetric = candidate;
      return keyEventMetric;
    } catch (err) {
      if (err.status !== 400) throw err;
    }
  }
  // Neither name resolved — report everything else rather than failing the run.
  keyEventMetric = null;
  return keyEventMetric;
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

const metricList = (names) => names.map((name) => ({ name }));

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
export async function fetchGa4Daily({ startDate, endDate }) {
  const keyEvent = await resolveKeyEventMetric();
  const names = [
    "sessions",
    "totalUsers",
    "newUsers",
    "screenPageViews",
    "engagedSessions",
    "userEngagementDuration",
    ...(keyEvent ? [keyEvent] : []),
  ];

  const json = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: metricList(names),
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
  }));
}

async function breakdown({ start, end, dimension, limit, keyEvent }) {
  const names = ["sessions", "totalUsers", ...(keyEvent ? [keyEvent] : [])];
  const json = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: dimension }],
    metrics: metricList(names),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
  });
  return flattenRows(json).map((row) => ({
    name: row[dimension] || "(not set)",
    sessions: row.sessions || 0,
    users: row.totalUsers || 0,
    keyEvents: keyEvent ? row[keyEvent] || 0 : 0,
  }));
}

async function topPages({ start, end, limit }) {
  const json = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: metricList(["screenPageViews", "sessions", "engagedSessions"]),
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit,
  });
  return flattenRows(json).map((row) => ({
    name: row.pagePath,
    title: row.pageTitle,
    pageViews: row.screenPageViews || 0,
    sessions: row.sessions || 0,
    engagedSessions: row.engagedSessions || 0,
  }));
}

/** Dimension tables for one window. */
export async function collectGa4Breakdowns({ start, end }) {
  const keyEvent = await resolveKeyEventMetric();
  const [channels, sources, countries, devices, pages] = await Promise.all([
    breakdown({ start, end, dimension: "sessionDefaultChannelGroup", limit: 12, keyEvent }),
    breakdown({ start, end, dimension: "sessionSourceMedium", limit: 25, keyEvent }),
    breakdown({ start, end, dimension: "country", limit: 15, keyEvent }),
    breakdown({ start, end, dimension: "deviceCategory", limit: 5, keyEvent }),
    topPages({ start, end, limit: 30 }),
  ]);
  return { channels, sources, countries, devices, pages, keyEventMetric: keyEvent };
}
