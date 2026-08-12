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
export async function collectSnapshot({ days = 28 } = {}) {
  const history = historyDays();
  const ga4Window = buildWindow(days, GA4_LAG_DAYS);
  const gscWindow = buildWindow(days, GSC_LAG_DAYS);

  // Twice the history so the longest supported window still has a full
  // preceding window to compare against.
  const ga4HistoryStart = shiftDays(ga4Window.end, -(history * 2 - 1));
  const gscHistoryStart = shiftDays(gscWindow.end, -(history * 2 - 1));

  const warnings = [];
  const guard = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err.message}`);
      return fallback;
    }
  };

  const [ga4Daily, ga4Breakdowns, gscDaily, gscBreakdowns] = await Promise.all([
    guard("GA4 daily", () => fetchGa4Daily({ startDate: ga4HistoryStart, endDate: ga4Window.end }), []),
    guard("GA4 breakdowns", () => collectGa4Breakdowns(ga4Window), {
      channels: [],
      sources: [],
      countries: [],
      devices: [],
      pages: [],
      keyEventMetric: null,
    }),
    guard("Search Console daily", () => fetchGscDaily({ startDate: gscHistoryStart, endDate: gscWindow.end }), []),
    guard("Search Console breakdowns", () => collectGscBreakdowns(gscWindow), {
      queries: [],
      pages: [],
      countries: [],
      devices: [],
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    siteLabel: process.env.SITE_LABEL || process.env.GSC_SITE_URL || "site",
    historyDays: history,
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
