import { buildWindow, shiftDays } from "./dates.mjs";
import { fetchGa4Daily, collectGa4Breakdowns } from "./ga4.mjs";
import { fetchGscDaily, collectGscBreakdowns } from "./gsc.mjs";

// GA4 is complete through yesterday. Search Console publishes two to three days
// behind, so each source is anchored to its own last complete day instead of a
// shared one that would leave Search Console with empty trailing days.
export const GA4_LAG_DAYS = 1;
export const GSC_LAG_DAYS = 3;

export const SUPPORTED_WINDOWS = [7, 28, 90];

export function historyDays() {
  const raw = Number(process.env.HISTORY_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 365) : 90;
  return Math.max(days, Math.max(...SUPPORTED_WINDOWS));
}

export const DEVICE_VALUES = ["desktop", "mobile", "tablet"];

/**
 * Filters are part of the cache identity, so they are normalised to a closed set
 * of values before they reach either API or the blob key. An unrecognised value
 * becomes "no filter" rather than being passed through.
 */
export function normaliseFilters(params) {
  const device = String(params?.device || "").toLowerCase();
  const channel = String(params?.channel || "").trim();
  return {
    device: DEVICE_VALUES.includes(device) ? device : "",
    // Channel names come from GA4's own list, so the only guard needed is a
    // length cap to keep the cache key bounded.
    channel: channel.length > 0 && channel.length <= 60 ? channel : "",
  };
}

export function filterSignature(filters) {
  const parts = [];
  if (filters.device) parts.push(`d:${filters.device}`);
  if (filters.channel) parts.push(`c:${filters.channel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  return parts.length ? parts.join("_") : "all";
}

export function normaliseWindow(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 28;
  // Snap to the nearest supported window so a hand-typed ?days= can't create
  // an unbounded number of cache entries.
  return SUPPORTED_WINDOWS.reduce((best, candidate) =>
    Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best,
  );
}

/**
 * Pull one complete snapshot: a long daily series from each source (which the
 * front end slices for whichever range is selected) plus dimension tables for
 * the requested window.
 *
 * A failure in one source is recorded as a warning rather than aborting — a
 * report with half its panels beats a report that will not load.
 */
export async function collectSnapshot({ days = 28, filters = {} } = {}) {
  const history = historyDays();
  const active = normaliseFilters(filters);
  const ga4Window = buildWindow(days, GA4_LAG_DAYS);
  const gscWindow = buildWindow(days, GSC_LAG_DAYS);

  // Twice the history so the longest supported window still has a full
  // preceding window to compare against.
  const ga4HistoryStart = shiftDays(ga4Window.end, -(history * 2 - 1));
  const gscHistoryStart = shiftDays(gscWindow.end, -(history * 2 - 1));

  const failures = [];
  const guard = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      failures.push({ label, message: err.message });
      return fallback;
    }
  };

  const [ga4Daily, ga4Breakdowns, gscDaily, gscBreakdowns] = await Promise.all([
    guard(
      "GA4 daily",
      () => fetchGa4Daily({ startDate: ga4HistoryStart, endDate: ga4Window.end, filters: active }),
      [],
    ),
    guard("GA4 breakdowns", () => collectGa4Breakdowns({ ...ga4Window, filters: active }), {
      channels: [],
      sources: [],
      countries: [],
      devices: [],
      pages: [],
      channelOptions: [],
      keyEventMetric: null,
      hasRevenue: false,
    }),
    guard(
      "Search Console daily",
      () => fetchGscDaily({ startDate: gscHistoryStart, endDate: gscWindow.end, filters: active }),
      [],
    ),
    guard("Search Console breakdowns", () => collectGscBreakdowns({ ...gscWindow, filters: active }), {
      queries: [],
      pages: [],
      countries: [],
      devices: [],
    }),
  ]);

  // One misconfigured variable breaks four fetches, which would otherwise print
  // the same sentence four times. Group by cause and name what each one broke.
  const warnings = [...new Set(failures.map((f) => f.message))].map((message) => {
    const affected = failures.filter((f) => f.message === message).map((f) => f.label);
    const hint = message.includes("Missing required environment variable")
      ? " Set it in Netlify → Environment variables (all scopes), then redeploy."
      : "";
    return `${message} — affects ${affected.join(", ")}.${hint}`;
  });

  return {
    generatedAt: new Date().toISOString(),
    siteLabel: process.env.SITE_LABEL || process.env.GSC_SITE_URL || "site",
    currency: process.env.REPORT_CURRENCY || "USD",
    historyDays: history,
    filters: active,
    // Search Console has no channel dimension, so a channel selection narrows
    // the analytics panels only. The report says so instead of implying the
    // search numbers were filtered too.
    filtersAppliedToSearch: { device: Boolean(active.device), channel: false },
    window: {
      days,
      ga4: { start: ga4Window.start, end: ga4Window.end },
      gsc: { start: gscWindow.start, end: gscWindow.end },
    },
    ga4: { daily: ga4Daily, ...ga4Breakdowns },
    gsc: { daily: gscDaily, ...gscBreakdowns },
    warnings,
  };
}
