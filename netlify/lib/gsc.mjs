import { googleFetch, requireEnv } from "./google-auth.mjs";

const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

function endpoint() {
  const site = requireEnv("GSC_SITE_URL");
  return `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    site,
  )}/searchAnalytics/query`;
}

async function query(body) {
  const json = await googleFetch(endpoint(), { scopes: SCOPES, body });
  return json.rows || [];
}

function shapeRow(row, dimensionNames) {
  const out = {
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || 0,
  };
  dimensionNames.forEach((name, i) => {
    out[name] = row.keys?.[i] ?? "";
  });
  return out;
}

/**
 * Search Console's own filter syntax. Only device carries over from the report's
 * filter bar — Search Console has no notion of a GA4 channel group, so a channel
 * selection deliberately does not reach here, and the UI says so rather than
 * silently returning unfiltered search numbers under a filtered heading.
 */
function filterGroups(filters = {}) {
  const list = [];
  if (filters.device) {
    list.push({ dimension: "device", operator: "equals", expression: filters.device.toUpperCase() });
  }
  if (!list.length) return undefined;
  return [{ filters: list }];
}

async function byDimension({ startDate, endDate, dimensions, rowLimit, filters }) {
  const groups = filterGroups(filters);
  const rows = await query({
    startDate,
    endDate,
    dimensions,
    rowLimit,
    ...(groups ? { dimensionFilterGroups: groups } : {}),
  });
  return rows.map((row) => shapeRow(row, dimensions));
}

/**
 * Daily clicks/impressions/CTR/position over a long history. Everything the
 * front end shows for a selected range is derived from these rows: summing
 * clicks and impressions is exact, and Search Console's per-day position is
 * already impression-weighted, so re-weighting daily positions by daily
 * impressions reproduces the true average for any window.
 */
export async function fetchGscDaily({ startDate, endDate, filters }) {
  const rows = await byDimension({
    startDate,
    endDate,
    dimensions: ["date"],
    rowLimit: 1000,
    filters,
  });
  return rows
    .map((row) => ({
      date: row.date,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Dimension tables for one window. */
export async function collectGscBreakdowns({ start, end, filters }) {
  const base = { startDate: start, endDate: end, filters };
  const [queries, pages, countries, devices] = await Promise.all([
    byDimension({ ...base, dimensions: ["query"], rowLimit: 100 }),
    byDimension({ ...base, dimensions: ["page"], rowLimit: 50 }),
    byDimension({ ...base, dimensions: ["country"], rowLimit: 15 }),
    byDimension({ ...base, dimensions: ["device"], rowLimit: 5 }),
  ]);

  const clean = (rows, key) =>
    rows
      .map((row) => ({
        name: row[key],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      }))
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  return {
    queries: clean(queries, "query"),
    pages: clean(pages, "page"),
    countries: clean(countries, "country"),
    devices: clean(devices, "device"),
  };
}
