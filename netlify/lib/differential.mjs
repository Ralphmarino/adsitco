import { googleFetch, requireEnv } from "./google-auth.mjs";
import { shiftDays, daysAgo } from "./dates.mjs";

const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

// Search Console caps a single response at 25,000 rows. A site with a long
// tail can exceed that; the response says so rather than quietly truncating.
const ROW_LIMIT = 25000;

function endpoint() {
  const site = requireEnv("GSC_SITE_URL");
  return `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
}

async function query(body) {
  const json = await googleFetch(endpoint(), { scopes: SCOPES, body });
  return json.rows ?? [];
}

/** Every page in a window, keyed by URL. */
async function pagesIn({ start, end }) {
  const rows = await query({
    startDate: start,
    endDate: end,
    dimensions: ["page"],
    rowLimit: ROW_LIMIT,
  });
  const map = new Map();
  for (const row of rows) {
    map.set(row.keys[0], {
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    });
  }
  return { map, truncated: rows.length >= ROW_LIMIT };
}

/** Site totals, queried without a dimension so they are exact. */
async function totalsIn({ start, end }) {
  const rows = await query({ startDate: start, endDate: end, rowLimit: 1 });
  const row = rows[0];
  return {
    clicks: row?.clicks || 0,
    impressions: row?.impressions || 0,
    ctr: row?.ctr || 0,
    position: row?.position || 0,
  };
}

/**
 * The three windows the audit spec's health rules need: the latest 90 days,
 * the 90 before that, and the same 90 days a year earlier.
 *
 * The year-ago window is the part that earns its request. Clicks down 40% on
 * the previous quarter is ambiguous on a site selling convertible parts — it
 * could be decay or it could be October. Down 40% on the previous quarter AND
 * on the same quarter last year is decay.
 */
export function healthWindows({ days = 90, lagDays = 3 } = {}) {
  const end = daysAgo(lagDays);
  const start = shiftDays(end, -(days - 1));
  const priorEnd = shiftDays(start, -1);
  const priorStart = shiftDays(priorEnd, -(days - 1));
  const yearShift = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };

  const label = (a, b) => {
    const fmt = (iso) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
    return `${fmt(a)} – ${fmt(b)}`;
  };

  return {
    days,
    current: { start, end, label: label(start, end) },
    prior: { start: priorStart, end: priorEnd, label: label(priorStart, priorEnd) },
    lastYear: { start: yearShift(start), end: yearShift(end), label: label(yearShift(start), yearShift(end)) },
  };
}

/**
 * Per-URL clicks, impressions, CTR and position across those three windows.
 * Three page-level queries, whatever the number of posts.
 */
export async function collectHealthPerformance({ days = 90 } = {}) {
  const windows = healthWindows({ days });
  const [current, prior, lastYear] = await Promise.all([
    pagesIn(windows.current),
    pagesIn(windows.prior),
    pagesIn(windows.lastYear),
  ]);

  return {
    windows,
    current: current.map,
    prior: prior.map,
    lastYear: lastYear.map,
    truncated: current.truncated || prior.truncated || lastYear.truncated,
  };
}

/* Month windows ----------------------------------------------------------- */

const monthStart = (y, m) => `${y}-${String(m).padStart(2, "0")}-01`;
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/**
 * The last month Search Console has finished reporting. It runs about three
 * days behind, so a month only counts once its final day is inside that lag.
 */
function latestCompleteMonth(lagDays = 3) {
  const cutoff = daysAgo(lagDays);
  let [y, m] = cutoff.slice(0, 7).split("-").map(Number);
  if (cutoff < monthEnd(y, m)) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return { year: y, month: m };
}

function monthsBack({ year, month }, n) {
  const d = new Date(Date.UTC(year, month - 1 - n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function differentialWindows(span = 6) {
  const latest = latestCompleteMonth();
  const recentStart = monthsBack(latest, span - 1);
  const priorEnd = monthsBack(latest, span);
  const priorStart = monthsBack(latest, span * 2 - 1);
  const previousMonth = monthsBack(latest, 1);

  const label = (a, b) => {
    const fmt = (p) =>
      new Date(Date.UTC(p.year, p.month - 1, 1)).toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
    return a.year === b.year && a.month === b.month ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
  };

  return {
    span,
    recent: {
      start: monthStart(recentStart.year, recentStart.month),
      end: monthEnd(latest.year, latest.month),
      label: label(recentStart, latest),
    },
    prior: {
      start: monthStart(priorStart.year, priorStart.month),
      end: monthEnd(priorEnd.year, priorEnd.month),
      label: label(priorStart, priorEnd),
    },
    thisMonth: {
      start: monthStart(latest.year, latest.month),
      end: monthEnd(latest.year, latest.month),
      label: label(latest, latest),
    },
    lastMonth: {
      start: monthStart(previousMonth.year, previousMonth.month),
      end: monthEnd(previousMonth.year, previousMonth.month),
      label: label(previousMonth, previousMonth),
    },
  };
}

/* Assembly ---------------------------------------------------------------- */

const delta = (now, before) => ({
  clicks: now.clicks - before.clicks,
  impressions: now.impressions - before.impressions,
  // Position improves as it falls, so the sign is flipped: a positive figure
  // always means "better" in this column.
  position: before.position && now.position ? before.position - now.position : 0,
  ctr: now.ctr - before.ctr,
});

const EMPTY = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

function buildRows(recent, prior, thisMonth, lastMonth) {
  const urls = new Set([...recent.keys(), ...prior.keys(), ...thisMonth.keys(), ...lastMonth.keys()]);
  const rows = [];
  for (const url of urls) {
    const a = recent.get(url) ?? EMPTY;
    const b = prior.get(url) ?? EMPTY;
    const m = thisMonth.get(url) ?? EMPTY;
    const n = lastMonth.get(url) ?? EMPTY;
    rows.push({
      url,
      period: { recent: a, prior: b, delta: delta(a, b) },
      month: { recent: m, prior: n, delta: delta(m, n) },
    });
  }
  return rows;
}

/**
 * Per-URL movement over two comparisons: the last N months against the N
 * before, and the latest complete month against the one before it.
 *
 * Six months against six needs no monthly breakdown — two page-level queries
 * cover it — so the whole thing is six requests rather than one per month.
 * Site totals come from their own dimensionless queries so they are exact
 * rather than a sum of page rows.
 */
export async function collectDifferential({ span = 6, limit = 1000 } = {}) {
  const windows = differentialWindows(span);

  const [recent, prior, thisMonth, lastMonth, recentTotals, priorTotals, thisMonthTotals, lastMonthTotals] =
    await Promise.all([
      pagesIn(windows.recent),
      pagesIn(windows.prior),
      pagesIn(windows.thisMonth),
      pagesIn(windows.lastMonth),
      totalsIn(windows.recent),
      totalsIn(windows.prior),
      totalsIn(windows.thisMonth),
      totalsIn(windows.lastMonth),
    ]);

  const all = buildRows(recent.map, prior.map, thisMonth.map, lastMonth.map);

  // Tens of thousands of URLs is a spreadsheet, not a table anyone reads. The
  // page carries whichever ones actually moved on either comparison; the CSV
  // export carries every one.
  const byPeriod = [...all].sort((x, y) => Math.abs(y.period.delta.clicks) - Math.abs(x.period.delta.clicks));
  const byMonth = [...all].sort((x, y) => Math.abs(y.month.delta.clicks) - Math.abs(x.month.delta.clicks));
  const keep = new Set([...byPeriod.slice(0, limit), ...byMonth.slice(0, limit)]);

  return {
    generatedAt: new Date().toISOString(),
    windows,
    totals: {
      period: { recent: recentTotals, prior: priorTotals, delta: delta(recentTotals, priorTotals) },
      month: { recent: thisMonthTotals, prior: lastMonthTotals, delta: delta(thisMonthTotals, lastMonthTotals) },
    },
    urlCount: all.length,
    shown: keep.size,
    truncated: recent.truncated || prior.truncated || thisMonth.truncated || lastMonth.truncated,
    rows: [...keep],
  };
}

/** The complete set as CSV — every URL, not just the ones the page shows. */
export async function differentialCsv({ span = 6 } = {}) {
  const windows = differentialWindows(span);
  const [recent, prior, thisMonth, lastMonth] = await Promise.all([
    pagesIn(windows.recent),
    pagesIn(windows.prior),
    pagesIn(windows.thisMonth),
    pagesIn(windows.lastMonth),
  ]);

  const rows = buildRows(recent.map, prior.map, thisMonth.map, lastMonth.map).sort(
    (x, y) => y.period.recent.clicks - x.period.recent.clicks,
  );

  const header = [
    "URL",
    `${windows.recent.label} Clicks`,
    `${windows.prior.label} Clicks`,
    `${windows.recent.label} Impressions`,
    `${windows.prior.label} Impressions`,
    `${windows.recent.label} CTR`,
    `${windows.prior.label} CTR`,
    `${windows.recent.label} Position`,
    `${windows.prior.label} Position`,
    "Clicks Differential",
    "Impressions Differential",
    "Position Differential",
    `${windows.thisMonth.label} Clicks`,
    `${windows.lastMonth.label} Clicks`,
    "Month Clicks Differential",
  ];

  const escape = (v) => {
    const text = String(v ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const pct = (v) => `${(v * 100).toFixed(2)}%`;

  const lines = [header.map(escape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.url,
        r.period.recent.clicks,
        r.period.prior.clicks,
        r.period.recent.impressions,
        r.period.prior.impressions,
        pct(r.period.recent.ctr),
        pct(r.period.prior.ctr),
        r.period.recent.position.toFixed(2),
        r.period.prior.position.toFixed(2),
        r.period.delta.clicks,
        r.period.delta.impressions,
        r.period.delta.position.toFixed(2),
        r.month.recent.clicks,
        r.month.prior.clicks,
        r.month.delta.clicks,
      ]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\n");
}
