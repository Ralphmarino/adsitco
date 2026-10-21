import { timeSeriesChart, columnChart, barChart, divergingBarChart, renderTable, labelCell } from "/charts.js";

const SUPPORTED_WINDOWS = [7, 28, 90];
const PASSWORD_KEY = "adsitco-report-password";

/** The Sales tab's own selection; the analytics range does not apply to it. */
const salesState = { from: null, to: null, data: null, loading: null };

/** The Differential tab: GSC movement per URL, on its own endpoint. */
const diffState = { mode: "period", search: "", sort: "delta", dir: "desc", data: null, loading: null };

const state = {
  days: 28,
  // null for a preset window; {start, end} for a custom one.
  custom: null,
  // "period" | "year" | "none"
  comparison: "period",
  demo: new URLSearchParams(location.search).get("demo") === "1",
  // country is null until the first response: the server owns the default, and
  // the page adopts whatever it reports rather than duplicating that decision.
  filters: { device: "", channels: [], country: null },
  // Captured from the first unfiltered load so the dropdown still lists every
  // channel after one of them narrows the response.
  channelOptions: [],
  search: { queries: "", landing: "" },
  snapshot: null,
  password: sessionStorage.getItem(PASSWORD_KEY) || "",
};

/* Formatting --------------------------------------------------------------- */

const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function compact(value) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return int.format(Math.round(value));
}

const fmt = {
  count: { compact, full: (v) => int.format(Math.round(v)), axis: compact },
  decimal: {
    compact: (v) => (Number.isFinite(v) ? v.toFixed(1) : "—"),
    full: (v) => (Number.isFinite(v) ? v.toFixed(1) : "—"),
    axis: (v) => (Number.isFinite(v) ? v.toFixed(1) : "—"),
  },
};

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function currencyFormatters(code = "USD") {
  const whole = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    maximumFractionDigits: 0,
  });
  const precise = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  });
  // Axis and end labels compact to K/M so neighbouring ticks cannot collide.
  const symbol = whole.formatToParts(0).find((part) => part.type === "currency")?.value ?? "";
  const short = (value) => {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 10_000) return `${sign}${symbol}${(abs / 1000).toFixed(1)}K`;
    return whole.format(value);
  };
  return {
    money: (v) => (Number.isFinite(v) ? whole.format(v) : "—"),
    exact: (v) => (Number.isFinite(v) ? precise.format(v) : "—"),
    chart: { compact: short, full: (v) => precise.format(v), axis: short },
  };
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m 00s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function prettyDate(iso) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function rangeLabel(range) {
  return range ? `${prettyDate(range.start)} – ${prettyDate(range.end)}` : "";
}

/* Date + window maths ------------------------------------------------------ */

function shiftISO(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function shiftYearsISO(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetweenISO(startIso, endIso) {
  return Math.floor((new Date(`${endIso}T00:00:00Z`) - new Date(`${startIso}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The window a comparison points at.
 *
 * Period-over-period is the equally long stretch immediately before the current
 * one. Year-over-year is the same calendar dates a year earlier — which is what
 * the phrase normally means in a business report, though it does put the
 * comparison on different weekdays.
 */
function comparisonRange(range, basis) {
  if (!range || basis === "none") return null;
  const length = daysBetweenISO(range.start, range.end);
  // Both bases are defined by start + the current window's length, never by a
  // shifted end date. That keeps the comparison exactly as many days as the
  // current period even across a leap year, so the two series stay index-
  // aligned on the charts.
  if (basis === "year") {
    const start = shiftYearsISO(range.start, -1);
    return { start, end: shiftISO(start, length - 1) };
  }
  const end = shiftISO(range.start, -1);
  return { start: shiftISO(end, -(length - 1)), end };
}

const COMPARISON_LABEL = {
  period: "previous period",
  year: "previous year",
  none: "",
};

/** Fill gaps so a day with no data plots as zero rather than closing the line. */
function densify(rows, start, end) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const template = Object.fromEntries(
    Object.keys(rows[0] || {})
      .filter((k) => k !== "date")
      .map((k) => [k, 0]),
  );
  const out = [];
  for (let date = start; date <= end; date = shiftISO(date, 1)) {
    out.push(byDate.get(date) || { date, ...template });
  }
  return out;
}

/**
 * Current window plus the equally long window before it, both derived from the
 * stored daily series. Every visible number comes from these rows, so switching
 * range never needs another API call.
 */
function sliceWindow(daily, range, basis) {
  if (!daily?.length || !range?.start) {
    return { current: [], previous: [], range: range ?? null, previousRange: null };
  }
  const within = (row, a, b) => row.date >= a && row.date <= b;
  const previousRange = comparisonRange(range, basis);
  return {
    // The window comes from the snapshot rather than the last row in the
    // series, so a custom range still reads correctly when a source has no
    // data on its final days.
    current: densify(daily.filter((r) => within(r, range.start, range.end)), range.start, range.end),
    previous: previousRange
      ? densify(
          daily.filter((r) => within(r, previousRange.start, previousRange.end)),
          previousRange.start,
          previousRange.end,
        )
      : [],
    range,
    previousRange,
  };
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);

function ga4Totals(rows) {
  const sessions = sum(rows, "sessions");
  const users = sum(rows, "users");
  return {
    sessions,
    users,
    newUsers: sum(rows, "newUsers"),
    pageViews: sum(rows, "pageViews"),
    keyEvents: sum(rows, "keyEvents"),
    revenue: sum(rows, "revenue"),
    transactions: sum(rows, "transactions"),
    // Rates are rebuilt from their components, never averaged from daily rates.
    engagementRate: sessions ? sum(rows, "engagedSessions") / sessions : NaN,
    engagementPerUser: users ? sum(rows, "engagementSeconds") / users : NaN,
    get averageOrderValue() {
      return this.transactions ? this.revenue / this.transactions : NaN;
    },
    get revenuePerSession() {
      return sessions ? this.revenue / sessions : NaN;
    },
  };
}

function gscTotals(rows) {
  const clicks = sum(rows, "clicks");
  const impressions = sum(rows, "impressions");
  // Search Console's per-day position is already impression-weighted, so
  // weighting daily positions by daily impressions gives the true window average.
  const weighted = rows.reduce((total, row) => total + (row.position || 0) * (row.impressions || 0), 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : NaN,
    position: impressions ? weighted / impressions : NaN,
  };
}

/* Deltas ------------------------------------------------------------------- */

function deltaNode(current, previous, { lowerIsBetter = false, format = compact } = {}) {
  const node = document.createElement("span");
  if (state.comparison === "none") {
    node.textContent = "";
    return node;
  }
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    node.textContent =
      state.comparison === "year" ? "no data a year earlier" : "no prior period";
    return node;
  }
  const change = (current - previous) / Math.abs(previous);
  const improving = lowerIsBetter ? change < 0 : change > 0;
  const flat = Math.abs(change) < 0.0005;
  node.className = flat ? "" : improving ? "delta--up" : "delta--down";
  const arrow = flat ? "→" : change > 0 ? "↑" : "↓";
  const basis = COMPARISON_LABEL[state.comparison];
  node.textContent = `${arrow} ${Math.abs(change * 100).toFixed(1)}% vs ${basis}`;
  node.title = `${basis[0].toUpperCase()}${basis.slice(1)}: ${format(previous)}`;
  return node;
}

function tile({ label, value, current, previous, lowerIsBetter, deltaFormat }) {
  const card = document.createElement("div");
  card.className = "tile";

  const labelEl = document.createElement("p");
  labelEl.className = "tile__label";
  labelEl.textContent = label;

  const valueEl = document.createElement("p");
  valueEl.className = "tile__value";
  valueEl.textContent = value;

  card.append(labelEl, valueEl);

  // With no comparison selected there is no delta to show, and an empty line
  // would still reserve its height and leave the tiles looking unfinished.
  if (state.comparison !== "none") {
    const deltaEl = document.createElement("p");
    deltaEl.className = "tile__delta";
    deltaEl.appendChild(
      deltaNode(current, previous, { lowerIsBetter, format: deltaFormat || compact }),
    );
    card.appendChild(deltaEl);
  }

  return card;
}

/* Data loading ------------------------------------------------------------- */

function reportUrl(days = state.days, filters = state.filters) {
  const params = new URLSearchParams();
  if (state.custom) {
    params.set("start", state.custom.start);
    params.set("end", state.custom.end);
  } else {
    params.set("days", String(days));
  }
  if (filters.device) params.set("device", filters.device);
  if (filters.channels.length) params.set("channels", filters.channels.join(","));
  // null means "first load, let the server apply its default"; empty string is
  // an explicit worldwide request and has to be sent as the sentinel.
  if (filters.country === "") params.set("country", "all");
  else if (filters.country) params.set("country", filters.country);
  return `/api/report?${params}`;
}

/**
 * Demo mode. The sample file ships with fixed dates, so they are re-anchored to
 * today on load — otherwise the report would drift into showing a stale window
 * as time passes.
 *
 * Reached only by an explicit ?demo=1 (or the button on the error screen). A
 * failed live load never silently falls back to it: swapping invented numbers in
 * mid-presentation, under the same headings, is the one failure mode worse than
 * an error message.
 */
async function loadSampleSnapshot() {
  const res = await fetch("/sample-data.json");
  if (!res.ok) throw new Error("Sample data is unavailable.");
  const snapshot = await res.json();

  const reanchor = (rows, lagDays) => {
    if (!rows.length) return rows;
    const target = new Date();
    target.setUTCDate(target.getUTCDate() - lagDays);
    const shift =
      Math.round(
        (target - new Date(`${rows[rows.length - 1].date}T00:00:00Z`)) / 86_400_000,
      ) || 0;
    return rows.map((row) => ({ ...row, date: shiftISO(row.date, shift) }));
  };

  snapshot.ga4.daily = reanchor(snapshot.ga4.daily, 1);
  snapshot.gsc.daily = reanchor(snapshot.gsc.daily, 3);
  snapshot.generatedAt = new Date().toISOString();

  const lastGa4 = snapshot.ga4.daily.at(-1)?.date;
  const lastGsc = snapshot.gsc.daily.at(-1)?.date;
  snapshot.window = {
    days: state.days,
    ga4: { start: shiftISO(lastGa4, -(state.days - 1)), end: lastGa4 },
    gsc: { start: shiftISO(lastGsc, -(state.days - 1)), end: lastGsc },
  };
  return snapshot;
}

async function loadSnapshot(days) {
  if (state.demo) return loadSampleSnapshot();

  const headers = {};
  if (state.password) headers["x-report-password"] = state.password;

  const res = await fetch(reportUrl(days), { headers });
  if (res.status === 401) {
    const error = new Error("unauthorized");
    error.code = 401;
    throw error;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Request failed (${res.status})`);
  return body;
}

/* Rendering ---------------------------------------------------------------- */

function setNotice(message) {
  const notice = document.getElementById("notice");
  if (!message) {
    notice.hidden = true;
    notice.textContent = "";
    return;
  }
  notice.hidden = false;
  notice.textContent = message;
}

/** Whether any dimension filter is narrowing the analytics tab. */
function hasDimensionFilters() {
  return Boolean(state.filters.device || state.filters.channels.length || state.filters.country);
}

function syncFilterUI(snapshot) {
  // Adopt the server's country decision on first load, so the control always
  // shows what was actually queried.
  if (state.filters.country === null) {
    state.filters.country = snapshot.filters?.country ?? "";
  }

  const countrySelect = document.getElementById("filter-country");
  const countryList = snapshot.countryOptions || [];
  if (countryList.length && countrySelect.dataset.filled !== String(countryList.length)) {
    countrySelect.innerHTML = ['<option value="all">All countries</option>']
      .concat(
        countryList.map((c) => {
          const safe = c.name.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
          return `<option value="${c.value}">${safe}</option>`;
        }),
      )
      .join("");
    countrySelect.dataset.filled = String(countryList.length);
  }
  countrySelect.value = state.filters.country || "all";

  const noFilters = !hasDimensionFilters();
  const fromApi = snapshot.ga4?.channelOptions || [];
  if (fromApi.length) state.channelOptions = fromApi;
  else if (noFilters) state.channelOptions = (snapshot.ga4?.channels || []).map((c) => c.name);
  renderChannelPicker();
  document.getElementById("filter-device").value = state.filters.device;
  document.getElementById("filter-clear").hidden = noFilters || !document.getElementById("tab-sales").hidden;

  const status = document.getElementById("filter-status");

  // Filters are executed by Google's APIs, which demo mode never reaches. Rather
  // than let a selection appear to work and change nothing, the controls are
  // disabled and say why.
  if (state.demo) {
    document.getElementById("filter-channel").disabled = true;
    countrySelect.disabled = true;
    document.getElementById("filter-device").disabled = true;
    document.getElementById("filter-clear").hidden = true;
    status.textContent = "Filters need live data — they are disabled in sample mode.";
    return;
  }
  document.getElementById("filter-channel").disabled = false;
  countrySelect.disabled = false;
  document.getElementById("filter-device").disabled = false;

  if (noFilters) {
    status.textContent = "";
    return;
  }
  const countryName =
    countryList.find((c) => c.value === state.filters.country)?.name || state.filters.country;
  const picked = state.filters.channels;
  const all = state.channelOptions.length;
  const channel = !picked.length
    ? ""
    : picked.length === 1
      ? `${picked[0]} only`
      : all && picked.length === all - 1
        ? `all channels except ${state.channelOptions.find((c) => !picked.includes(c))}`
        : `${picked.length} of ${all || picked.length} channels`;
  const applied = [
    state.filters.country && countryName,
    state.filters.device && `${state.filters.device} only`,
    channel,
  ].filter(Boolean);
  // Say plainly which panels a filter could not reach, rather than letting an
  // unfiltered search number sit under a filtered heading.
  const caveat = state.filters.channel
    ? " · Search Console has no channel dimension, so the search panels below ignore the channel filter"
    : "";
  status.textContent = `Filtered: ${applied.join(", ")}${caveat}`;
}

/** Read a CSS custom property; charts take their colours from the theme. */
const surfaceColor = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* Sales tab ---------------------------------------------------------------
 *
 * Sales works in months, not the analytics tab's rolling day window. The
 * workbook is kept a month per tab, a sales review is asked a month at a time,
 * and a 28-day window straddles month boundaries — which is how the default
 * view ended up mixing a complete September with an empty half of October.
 *
 * The data arrives from /api/sales once and every month, span and comparison
 * after that is computed here, so changing any of them is instant.
 */

const monthKey = (iso) => iso.slice(0, 7);

function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

function monthLabel(key, short = false) {
  const d = new Date(`${key}-01T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    month: short ? "short" : "long",
    year: short ? "2-digit" : "numeric",
    timeZone: "UTC",
  });
}

/** Months the data actually covers, newest last, complete months only. */
function completeMonths(sales) {
  if (!sales?.coverage?.end) return [];
  const months = [...new Set(sales.daily.map((r) => monthKey(r.date)))].sort();
  return months.filter((key) => {
    const [y, m] = key.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return sales.coverage.end >= lastDay;
  });
}

function monthRange() {
  const { from, to } = salesState;
  if (!from || !to) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** The months a comparison points at: the same count, shifted. */
function comparisonMonths(range, basis) {
  if (!range || basis === "none") return null;
  const span = monthsBetween(range.from, range.to);
  if (basis === "year") return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
  return { from: addMonths(range.from, -span), to: addMonths(range.to, -span) };
}

/** Daily rows folded into one row per month, same flat keys. */
function foldToMonths(daily, channels) {
  const byMonth = new Map();
  for (const row of daily) {
    const key = monthKey(row.date);
    let month = byMonth.get(key);
    if (!month) {
      month = { key, date: `${key}-01`, revenue: 0, orders: 0, calls: 0 };
      for (const c of channels) {
        month[`rev_${c.id}`] = 0;
        month[`ord_${c.id}`] = 0;
      }
      byMonth.set(key, month);
    }
    month.revenue += row.revenue;
    month.orders += row.orders;
    month.calls += row.calls ?? 0;
    for (const c of channels) {
      month[`rev_${c.id}`] += row[`rev_${c.id}`] ?? 0;
      month[`ord_${c.id}`] += row[`ord_${c.id}`] ?? 0;
    }
  }
  return [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const inMonths = (rows, range) =>
  rows.filter((r) => monthKey(r.date) >= range.from && monthKey(r.date) <= range.to);

function renderSales() {
  const sales = salesState.data;
  const empty = document.getElementById("sales-empty");
  const panels = ["sales-tiles", "sales-trend-chart", "sales-perchannel", "sales-channel-chart", "sales-breakdown-table"];

  if (!sales?.present || !sales.daily?.length) {
    empty.hidden = false;
    empty.textContent =
      (sales?.warnings?.[0] ?? "No sales data yet.") +
      " Add the workbook to data/ in the repository and redeploy — see the README for the columns it reads.";
    for (const id of panels) document.getElementById(id)?.replaceChildren();
    document.getElementById("sales-hero-value").textContent = "—";
    document.getElementById("sales-hero-delta").replaceChildren();
    document.getElementById("sales-hero-sub").textContent = "";
    return;
  }

  const range = monthRange();
  if (!range) return;

  const basis = state.comparison;
  const channels = sales.channels || [];
  const cash = currencyFormatters(sales.currency || "USD");
  const comparison = comparisonMonths(range, basis);

  const currentDays = inMonths(sales.daily, range);
  const previousDays = comparison ? inMonths(sales.daily, comparison) : [];
  const allMonths = foldToMonths(sales.daily, channels);
  const currentMonths = allMonths.filter((m) => m.key >= range.from && m.key <= range.to);
  const previousMonths = comparison
    ? allMonths.filter((m) => m.key >= comparison.from && m.key <= comparison.to)
    : [];

  const totals = (rows) => ({
    revenue: sum(rows, "revenue"),
    orders: sum(rows, "orders"),
    calls: sum(rows, "calls"),
  });
  const now = totals(currentDays);
  const before = totals(previousDays);
  const aov = (t) => (t.orders ? t.revenue / t.orders : NaN);

  const span = monthsBetween(range.from, range.to);
  const spanLabel = span === 1 ? monthLabel(range.from) : `${monthLabel(range.from)} – ${monthLabel(range.to)}`;
  const comparisonLabel = comparison
    ? monthsBetween(comparison.from, comparison.to) === 1
      ? monthLabel(comparison.from)
      : `${monthLabel(comparison.from)} – ${monthLabel(comparison.to)}`
    : "";

  // A selection reaching past what the workbook covers would otherwise draw
  // the shortfall as a collapse to zero rather than as missing data.
  const lastComplete = completeMonths(sales).at(-1);
  const beyond = lastComplete && range.to > lastComplete;
  empty.hidden = !beyond;
  if (beyond) {
    empty.textContent =
      `${sales.source ?? "The sales file"} is complete through ${monthLabel(lastComplete)} ` +
      `(data to ${prettyDate(sales.coverage.end)}). Months after that are partial or empty.`;
  }

  document.getElementById("sales-hero-value").textContent = cash.money(now.revenue);
  document.getElementById("sales-hero-delta").replaceChildren(
    deltaNode(now.revenue, before.revenue, { format: cash.money }),
  );
  document.getElementById("sales-hero-sub").textContent =
    basis === "none"
      ? spanLabel
      : `${spanLabel} · ${COMPARISON_LABEL[basis]} ${cash.money(before.revenue)} (${comparisonLabel})`;
  document.getElementById("sales-range").textContent = spanLabel;

  // The masthead describes whichever tab is open; the analytics day range
  // means nothing here.
  if (!document.getElementById("tab-sales").hidden) {
    document.getElementById("range-meta").textContent =
      `Sales · ${spanLabel}${basis === "none" ? "" : ` · vs ${COMPARISON_LABEL[basis]} ${comparisonLabel}`}`;
  }

  const tiles = [];
  if (sales.hasOrders) {
    tiles.push(
      tile({ label: "Orders", value: compact(now.orders), current: now.orders, previous: before.orders }),
      tile({
        label: "Average order value",
        value: cash.exact(aov(now)),
        current: aov(now),
        previous: aov(before),
        deltaFormat: cash.exact,
      }),
    );
  }
  if (sales.hasCalls) {
    const rate = (t, rows) => (t.calls ? sum(rows, "ord_call") / t.calls : NaN);
    tiles.push(
      tile({ label: "Phone calls", value: compact(now.calls), current: now.calls, previous: before.calls }),
      tile({
        label: "Calls to order",
        value: percent(rate(now, currentDays)),
        current: rate(now, currentDays),
        previous: rate(before, previousDays),
        deltaFormat: percent,
      }),
    );
  }
  if (span > 1) {
    tiles.push(
      tile({
        label: "Monthly average",
        value: cash.money(now.revenue / span),
        current: now.revenue / span,
        previous: previousMonths.length ? before.revenue / previousMonths.length : NaN,
        deltaFormat: cash.money,
      }),
    );
  }
  for (const c of channels) {
    tiles.push(
      tile({
        label: `${c.label} revenue`,
        value: cash.money(sum(currentDays, `rev_${c.id}`)),
        current: sum(currentDays, `rev_${c.id}`),
        previous: sum(previousDays, `rev_${c.id}`),
        deltaFormat: cash.money,
      }),
    );
  }
  document.getElementById("sales-tiles").replaceChildren(...tiles);

  // One or two months is a shape you read day by day; a quarter or a year is
  // one you read month by month, where daily noise only hides the trend.
  const byMonth = span >= 3;
  const note = basis === "none" ? "" : ` Compared with ${comparisonLabel}.`;
  document.getElementById("sales-trend-heading").textContent = byMonth
    ? "Revenue by month"
    : "Revenue by day";
  document.getElementById("sales-trend-sub").textContent =
    `${byMonth ? "Monthly" : "Daily"} revenue, all channels combined.${note}`;

  if (byMonth) {
    const groups = currentMonths.map((m, i) => ({
      label: monthLabel(m.key),
      short: monthLabel(m.key, true),
      values: { current: m.revenue, previous: previousMonths[i]?.revenue ?? 0 },
      previousLabel: previousMonths[i] ? monthLabel(previousMonths[i].key) : null,
    }));
    const series = [{ key: "current", label: spanLabel, color: surfaceColor("--series-3") }];
    if (previousMonths.length) {
      series.push({ key: "previous", label: comparisonLabel, color: surfaceColor("--text-muted") });
    }
    columnChart(document.getElementById("sales-trend-chart"), { groups, series, format: cash.chart });

    renderTable(document.getElementById("sales-trend-chart-table"), {
      columns: [
        { label: "Month", render: (g) => g.label },
        { label: "Revenue", render: (g) => cash.money(g.values.current) },
        ...(previousMonths.length
          ? [
              { label: "Comparison", render: (g) => (g.previousLabel ? cash.money(g.values.previous) : "—") },
              {
                label: "Change",
                render: (g) =>
                  g.values.previous
                    ? `${g.values.current >= g.values.previous ? "+" : ""}${(((g.values.current - g.values.previous) / g.values.previous) * 100).toFixed(1)}%`
                    : "—",
              },
            ]
          : []),
      ],
      rows: [...groups].reverse(),
    });
  } else {
    const series = [
      {
        label: "Revenue",
        color: surfaceColor("--series-3"),
        points: currentDays.map((r) => ({ date: r.date, value: r.revenue })),
      },
    ];
    if (previousDays.length) {
      series.push({
        label: comparisonLabel,
        color: surfaceColor("--text-muted"),
        endLabel: false,
        points: previousDays.map((r) => ({ date: r.date, value: r.revenue })),
      });
    }
    timeSeriesChart(document.getElementById("sales-trend-chart"), { series, format: cash.chart });

    renderTable(document.getElementById("sales-trend-chart-table"), {
      columns: [
        { label: "Date", render: (r) => prettyDate(r.date) },
        ...channels.map((c) => ({ label: c.label, render: (r) => cash.money(r[`rev_${c.id}`] || 0) })),
        { label: "Total", render: (r) => cash.money(r.revenue) },
      ],
      rows: [...currentDays].reverse(),
    });
  }

  renderSalesPerChannel({ sales, channels, currentMonths, previousMonths, currentDays, previousDays, byMonth, cash, spanLabel, comparisonLabel });

  const byChannel = channels
    .map((c) => ({
      name: c.label,
      revenue: sum(currentDays, `rev_${c.id}`),
      orders: sum(currentDays, `ord_${c.id}`),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  barChart(document.getElementById("sales-channel-chart"), {
    rows: byChannel.map((c) => ({
      name: c.name,
      value: c.revenue,
      detail: [
        { label: "Revenue", value: cash.exact(c.revenue) },
        { label: "Orders", value: int.format(c.orders) },
        { label: "Share", value: percent(now.revenue ? c.revenue / now.revenue : NaN) },
      ],
    })),
    color: surfaceColor("--series-3"),
    format: cash.chart,
  });

  const channelColumns = [
    { label: "Channel", render: (r) => r.name },
    { label: "Revenue", render: (r) => cash.money(r.revenue) },
    ...(sales.hasOrders
      ? [
          { label: "Orders", render: (r) => int.format(r.orders) },
          { label: "AOV", render: (r) => cash.exact(r.orders ? r.revenue / r.orders : NaN) },
        ]
      : []),
    { label: "Share", render: (r) => percent(now.revenue ? r.revenue / now.revenue : NaN) },
  ];
  renderTable(document.getElementById("sales-channel-chart-table"), { columns: channelColumns, rows: byChannel });
  renderTable(document.getElementById("sales-breakdown-table"), { columns: channelColumns, rows: byChannel });
  document.getElementById("sales-breakdown-sub").textContent =
    `${spanLabel} · from ${sales.source ?? "the sales file"}. The country, device and channel filters do not apply here.`;
}

/**
 * One chart per channel rather than all of them on one axis. Call revenue runs
 * an order of magnitude above Web and eBay, and on a shared axis the two
 * smaller channels flatten into the baseline and stop being readable.
 */
function renderSalesPerChannel({ channels, currentMonths, previousMonths, currentDays, previousDays, byMonth, cash, spanLabel, comparisonLabel }) {
  const host = document.getElementById("sales-perchannel");
  document.getElementById("sales-perchannel-range").textContent = spanLabel;
  host.replaceChildren();

  for (const channel of channels) {
    const panel = document.createElement("section");
    panel.className = "panel";
    const title = document.createElement("h3");
    title.className = "panel__title";
    title.textContent = channel.label;
    const sub = document.createElement("p");
    sub.className = "panel__sub";
    sub.textContent = `${cash.money(sum(currentDays, `rev_${channel.id}`))} in this range`;
    const chart = document.createElement("div");
    chart.className = "chart";
    panel.append(title, sub, chart);
    // Appended before drawing: a chart measures its container, which has no
    // width until it is in the document.
    host.appendChild(panel);

    const key = `rev_${channel.id}`;
    if (byMonth) {
      const groups = currentMonths.map((m, i) => ({
        label: monthLabel(m.key),
        short: monthLabel(m.key, true),
        values: { current: m[key] || 0, previous: previousMonths[i]?.[key] ?? 0 },
      }));
      const series = [{ key: "current", label: spanLabel, color: surfaceColor("--series-3") }];
      if (previousMonths.length) {
        series.push({ key: "previous", label: comparisonLabel, color: surfaceColor("--text-muted") });
      }
      columnChart(chart, { groups, series, format: cash.chart });
    } else {
      const series = [
        {
          label: channel.label,
          color: surfaceColor("--series-3"),
          points: currentDays.map((r) => ({ date: r.date, value: r[key] || 0 })),
        },
      ];
      if (previousDays.length) {
        series.push({
          label: comparisonLabel,
          color: surfaceColor("--text-muted"),
          endLabel: false,
          points: previousDays.map((r) => ({ date: r.date, value: r[key] || 0 })),
        });
      }
      timeSeriesChart(chart, { series, format: cash.chart });
    }
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  syncFilterUI(snapshot);

  const basis = state.comparison;
  const ga4 = sliceWindow(snapshot.ga4?.daily, snapshot.window?.ga4, basis);
  const gsc = sliceWindow(snapshot.gsc?.daily, snapshot.window?.gsc, basis);
  const ga4Now = ga4Totals(ga4.current);
  const ga4Before = ga4Totals(ga4.previous);
  const gscNow = gscTotals(gsc.current);
  const gscBefore = gscTotals(gsc.previous);

  // The logo beside this already says who the report is for, so the heading
  // names the report rather than repeating the brand.
  document.getElementById("site-label").textContent = "Search & analytics report";
  const windowLabel =
    snapshot.window?.mode === "custom"
      ? `${snapshot.window.days} days`
      : `Last ${snapshot.window?.days ?? state.days} days`;
  const comparedTo =
    basis === "none" ? "" : ` · vs ${COMPARISON_LABEL[basis]} ${rangeLabel(ga4.previousRange)}`;
  document.getElementById("range-meta").textContent =
    `${windowLabel} · analytics ${rangeLabel(ga4.range)} · search ${rangeLabel(gsc.range)}${comparedTo}`;
  document.getElementById("ga4-range").textContent = rangeLabel(ga4.range);
  document.getElementById("gsc-range").textContent =
    `${rangeLabel(gsc.range)} · Search Console runs ~3 days behind`;

  // Hero — the one big number on the page.
  document.getElementById("hero-value").textContent = int.format(ga4Now.sessions);
  const heroDelta = document.getElementById("hero-delta");
  heroDelta.replaceChildren(deltaNode(ga4Now.sessions, ga4Before.sessions));
  document.getElementById("hero-sub").textContent =
    basis === "none"
      ? rangeLabel(ga4.range)
      : `${rangeLabel(ga4.range)} · ${COMPARISON_LABEL[basis]} ${int.format(ga4Before.sessions)} sessions (${rangeLabel(ga4.previousRange)})`;

  const keyEventLabel = snapshot.ga4?.keyEventMetric === "conversions" ? "Conversions" : "Key events";
  const cash = currencyFormatters(snapshot.currency);
  // Revenue panels appear only when the property actually books revenue —
  // a row of zeroed money tiles in a client presentation reads as a broken
  // report rather than an honest "no ecommerce here".
  const showRevenue = Boolean(snapshot.ga4?.hasRevenue) && ga4Now.revenue > 0;

  const ga4TileList = [
    tile({
      label: "Active users",
      value: compact(ga4Now.users),
      current: ga4Now.users,
      previous: ga4Before.users,
    }),
    tile({
      label: "New users",
      value: compact(ga4Now.newUsers),
      current: ga4Now.newUsers,
      previous: ga4Before.newUsers,
    }),
    tile({
      label: "Page views",
      value: compact(ga4Now.pageViews),
      current: ga4Now.pageViews,
      previous: ga4Before.pageViews,
    }),
    tile({
      label: "Engagement rate",
      value: percent(ga4Now.engagementRate),
      current: ga4Now.engagementRate,
      previous: ga4Before.engagementRate,
      deltaFormat: percent,
    }),
    tile({
      label: "Engaged time / user",
      value: duration(ga4Now.engagementPerUser),
      current: ga4Now.engagementPerUser,
      previous: ga4Before.engagementPerUser,
      deltaFormat: duration,
    }),
    tile({
      label: keyEventLabel,
      value: compact(ga4Now.keyEvents),
      current: ga4Now.keyEvents,
      previous: ga4Before.keyEvents,
    }),
  ];

  if (showRevenue) {
    ga4TileList.push(
      tile({
        label: "Revenue",
        value: cash.money(ga4Now.revenue),
        current: ga4Now.revenue,
        previous: ga4Before.revenue,
        deltaFormat: cash.money,
      }),
      tile({
        label: "Orders",
        value: compact(ga4Now.transactions),
        current: ga4Now.transactions,
        previous: ga4Before.transactions,
      }),
      tile({
        label: "Average order value",
        value: cash.exact(ga4Now.averageOrderValue),
        current: ga4Now.averageOrderValue,
        previous: ga4Before.averageOrderValue,
        deltaFormat: cash.exact,
      }),
      tile({
        label: "Revenue / session",
        value: cash.exact(ga4Now.revenuePerSession),
        current: ga4Now.revenuePerSession,
        previous: ga4Before.revenuePerSession,
        deltaFormat: cash.exact,
      }),
    );
  }

  document.getElementById("ga4-tiles").replaceChildren(...ga4TileList);

  document.getElementById("gsc-tiles").replaceChildren(
    tile({
      label: "Clicks",
      value: compact(gscNow.clicks),
      current: gscNow.clicks,
      previous: gscBefore.clicks,
    }),
    tile({
      label: "Impressions",
      value: compact(gscNow.impressions),
      current: gscNow.impressions,
      previous: gscBefore.impressions,
    }),
    tile({
      label: "Average CTR",
      value: percent(gscNow.ctr),
      current: gscNow.ctr,
      previous: gscBefore.ctr,
      deltaFormat: percent,
    }),
    tile({
      label: "Average position",
      value: Number.isFinite(gscNow.position) ? gscNow.position.toFixed(1) : "—",
      current: gscNow.position,
      previous: gscBefore.position,
      lowerIsBetter: true,
      deltaFormat: (v) => v.toFixed(1),
    }),
  );

  /* Charts */

  /**
   * One metric, plus the comparison period as a second line when a basis is
   * selected. The comparison wears the muted ink rather than a second brand
   * hue — it is the same measure at a different time, not a different measure,
   * so it should recede rather than compete.
   */
  const metricSeries = (slice, key, label, color) => {
    const series = [
      { label, color, points: slice.current.map((r) => ({ date: r.date, value: r[key] })) },
    ];
    if (slice.previous.length) {
      series.push({
        label: COMPARISON_LABEL[basis],
        color: surfaceColor("--text-muted"),
        endLabel: false,
        points: slice.previous.map((r) => ({ date: r.date, value: r[key] })),
      });
    }
    return series;
  };

  const comparisonNote = basis === "none" ? "" : ` Compared with the ${COMPARISON_LABEL[basis]}.`;
  document.getElementById("traffic-chart-sub").textContent =
    `Daily sessions across the selected range.${comparisonNote}`;
  document.getElementById("users-chart-sub").textContent =
    `Daily active users across the selected range.${comparisonNote}`;

  timeSeriesChart(document.getElementById("traffic-chart"), {
    series: metricSeries(ga4, "sessions", "Sessions", surfaceColor("--series-1")),
    format: fmt.count,
  });

  timeSeriesChart(document.getElementById("users-chart"), {
    series: metricSeries(ga4, "users", "Active users", surfaceColor("--series-2")),
    format: fmt.count,
  });

  const dailyGa4Columns = [
    { label: "Date", render: (r) => prettyDate(r.date) },
    { label: "Sessions", render: (r) => int.format(r.sessions) },
    { label: "Users", render: (r) => int.format(r.users) },
    { label: "Page views", render: (r) => int.format(r.pageViews) },
  ];
  renderTable(document.getElementById("traffic-chart-table"), {
    columns: dailyGa4Columns,
    rows: [...ga4.current].reverse(),
  });
  renderTable(document.getElementById("users-chart-table"), {
    columns: dailyGa4Columns,
    rows: [...ga4.current].reverse(),
  });

  const revenuePanel = document.getElementById("revenue-panel");
  revenuePanel.hidden = !showRevenue;
  if (showRevenue) {
    timeSeriesChart(document.getElementById("revenue-chart"), {
      series: metricSeries(ga4, "revenue", "Revenue", surfaceColor("--series-3")),
      format: cash.chart,
    });

    renderTable(document.getElementById("revenue-chart-table"), {
      columns: [
        { label: "Date", render: (r) => prettyDate(r.date) },
        { label: "Revenue", render: (r) => cash.exact(r.revenue) },
        { label: "Orders", render: (r) => int.format(r.transactions) },
      ],
      rows: [...ga4.current].reverse(),
    });
  }

  const channels = (snapshot.ga4?.channels || []).slice(0, 8);
  document.getElementById("channels-sub").textContent =
    `Dimension tables cover the ${snapshot.window?.days ?? state.days}-day window fetched from the API.`;

  barChart(document.getElementById("channels-chart"), {
    rows: channels.map((c) => ({
      name: c.name,
      value: c.sessions,
      detail: [
        { label: "Sessions", value: int.format(c.sessions) },
        { label: "Users", value: int.format(c.users) },
        { label: keyEventLabel, value: int.format(c.keyEvents) },
        ...(showRevenue ? [{ label: "Revenue", value: cash.money(c.revenue) }] : []),
      ],
    })),
    color: surfaceColor("--series-1"),
    format: fmt.count,
  });

  renderTable(document.getElementById("channels-chart-table"), {
    columns: [
      { label: "Channel", render: (r) => r.name },
      { label: "Sessions", render: (r) => int.format(r.sessions) },
      { label: "Users", render: (r) => int.format(r.users) },
      { label: keyEventLabel, render: (r) => int.format(r.keyEvents) },
      ...(showRevenue ? [{ label: "Revenue", render: (r) => cash.money(r.revenue) }] : []),
    ],
    rows: snapshot.ga4?.channels || [],
  });

  timeSeriesChart(document.getElementById("clicks-chart"), {
    series: metricSeries(gsc, "clicks", "Clicks", surfaceColor("--series-1")),
    format: fmt.count,
  });

  renderTable(document.getElementById("clicks-chart-table"), {
    columns: [
      { label: "Date", render: (r) => prettyDate(r.date) },
      { label: "Clicks", render: (r) => int.format(r.clicks) },
    ],
    rows: [...gsc.current].reverse(),
  });

  timeSeriesChart(document.getElementById("impressions-chart"), {
    series: metricSeries(gsc, "impressions", "Impressions", surfaceColor("--series-2")),
    format: fmt.count,
  });

  renderTable(document.getElementById("impressions-chart-table"), {
    columns: [
      { label: "Date", render: (r) => prettyDate(r.date) },
      { label: "Impressions", render: (r) => int.format(r.impressions) },
    ],
    rows: [...gsc.current].reverse(),
  });

  // CTR is a ratio, so it is rebuilt per day from clicks and impressions
  // rather than averaged — and days with no impressions are left out, since
  // 0/0 is not a zero click-through rate.
  const ctrDays = gsc.current.filter((r) => r.impressions > 0);
  const ctrPrev = gsc.previous.filter((r) => r.impressions > 0);
  const ctrFormat = {
    compact: (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—"),
    full: (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—"),
    axis: (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—"),
  };
  const ctrSeries = [
    {
      label: "CTR",
      color: surfaceColor("--series-2"),
      points: ctrDays.map((r) => ({ date: r.date, value: r.clicks / r.impressions })),
    },
  ];
  if (ctrPrev.length) {
    ctrSeries.push({
      label: COMPARISON_LABEL[basis],
      color: surfaceColor("--text-muted"),
      endLabel: false,
      points: ctrPrev.map((r) => ({ date: r.date, value: r.clicks / r.impressions })),
    });
  }
  document.getElementById("ctr-sub").textContent =
    `Share of impressions that became a click.${comparisonNote}`;
  timeSeriesChart(document.getElementById("ctr-chart"), { series: ctrSeries, format: ctrFormat });

  renderTable(document.getElementById("ctr-chart-table"), {
    columns: [
      { label: "Date", render: (r) => prettyDate(r.date) },
      { label: "CTR", render: (r) => percent(r.clicks / r.impressions) },
      { label: "Clicks", render: (r) => int.format(r.clicks) },
      { label: "Impressions", render: (r) => int.format(r.impressions) },
    ],
    rows: [...ctrDays].reverse(),
  });

  // Days with no impressions have no meaningful position; plotting them as 0
  // would read as "rank 0", which does not exist. They are dropped instead.
  const positionDays = gsc.current.filter((r) => r.impressions > 0 && r.position > 0);

  timeSeriesChart(document.getElementById("position-chart"), {
    series: [
      {
        label: "Average position",
        color: surfaceColor("--series-3"),
        points: positionDays.map((r) => ({ date: r.date, value: r.position })),
      },
    ],
    format: fmt.decimal,
    invertY: true,
  });

  renderTable(document.getElementById("position-chart-table"), {
    columns: [
      { label: "Date", render: (r) => prettyDate(r.date) },
      { label: "Average position", render: (r) => r.position.toFixed(1) },
      { label: "Impressions", render: (r) => int.format(r.impressions) },
    ],
    rows: [...positionDays].reverse(),
  });

  /* Tables */

  const windowNote = `Window fetched from the API: ${rangeLabel({
    start: snapshot.window?.gsc?.start,
    end: snapshot.window?.gsc?.end,
  })}`;
  const ga4WindowNote = `Window fetched from the API: ${rangeLabel({
    start: snapshot.window?.ga4?.start,
    end: snapshot.window?.ga4?.end,
  })}`;

  document.getElementById("queries-sub").textContent = windowNote;
  document.getElementById("landing-sub").textContent = windowNote;
  document.getElementById("countries-sub").textContent = windowNote;
  document.getElementById("devices-sub").textContent = windowNote;
  document.getElementById("pages-sub").textContent = ga4WindowNote;
  document.getElementById("sources-sub").textContent = ga4WindowNote;

  const searchColumns = (firstLabel) => [
    { label: firstLabel, render: (r) => r.name },
    { label: "Clicks", render: (r) => int.format(r.clicks) },
    { label: "Impr.", render: (r) => int.format(r.impressions) },
    { label: "CTR", render: (r) => percent(r.ctr) },
    { label: "Pos.", render: (r) => r.position.toFixed(1) },
  ];

  // Text search runs over the already-loaded rows, so typing filters instantly
  // without another API round trip.
  const matching = (rows, term) => {
    const needle = term.trim().toLowerCase();
    return needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  };

  renderTable(document.getElementById("queries-table"), {
    columns: searchColumns("Query"),
    rows: matching(snapshot.gsc?.queries || [], state.search.queries).slice(0, 50),
    empty: state.search.queries ? "No queries match that text." : undefined,
  });

  renderTable(document.getElementById("landing-table"), {
    columns: searchColumns("Page"),
    rows: matching(
      (snapshot.gsc?.pages || []).map((r) => ({
        ...r,
        name: r.name.replace(/^https?:\/\/[^/]+/, "") || "/",
      })),
      state.search.landing,
    ).slice(0, 30),
    empty: state.search.landing ? "No pages match that text." : undefined,
  });

  renderTable(document.getElementById("pages-table"), {
    columns: [
      { label: "Page", render: (r) => labelCell(r.name || "/", r.title) },
      { label: "Views", render: (r) => int.format(r.pageViews) },
      { label: "Sessions", render: (r) => int.format(r.sessions) },
      ...(showRevenue ? [{ label: "Revenue", render: (r) => cash.money(r.revenue) }] : []),
    ],
    rows: snapshot.ga4?.pages || [],
  });

  renderTable(document.getElementById("sources-table"), {
    columns: [
      { label: "Source / medium", render: (r) => r.name },
      { label: "Sessions", render: (r) => int.format(r.sessions) },
      { label: "Users", render: (r) => int.format(r.users) },
      ...(showRevenue ? [{ label: "Revenue", render: (r) => cash.money(r.revenue) }] : []),
    ],
    rows: snapshot.ga4?.sources || [],
  });

  renderTable(document.getElementById("countries-table"), {
    columns: [
      { label: "Country", render: (r) => r.name },
      { label: "Sessions", render: (r) => int.format(r.sessions) },
      { label: "Users", render: (r) => int.format(r.users) },
    ],
    rows: snapshot.ga4?.countries || [],
  });

  renderTable(document.getElementById("devices-table"), {
    columns: [
      { label: "Device", render: (r) => r.name },
      { label: "Sessions", render: (r) => int.format(r.sessions) },
      { label: "Users", render: (r) => int.format(r.users) },
    ],
    rows: snapshot.ga4?.devices || [],
  });

  document.getElementById("generated-at").textContent =
    `Data pulled ${new Date(snapshot.generatedAt).toLocaleString()} · refreshes daily`;
  document.getElementById("raw-link").href = reportUrl();

  const warnings = snapshot.warnings || [];
  setNotice(warnings.join(" · "));

  // Warnings mean something is misconfigured, so surface the whole checklist
  // rather than one sentence. Sample mode has no live config to check.
  if (warnings.length && !snapshot.sample) showDiagnostics({ staleWarnings: true });
  else document.getElementById("diagnostics").hidden = true;

  if (salesState.data) renderSales();
}

/* Wiring ------------------------------------------------------------------- */

function showGate(message) {
  document.getElementById("app").hidden = true;
  const gate = document.getElementById("gate");
  gate.hidden = false;
  const error = document.getElementById("gate-error");
  error.hidden = !message;
  error.textContent = message || "";
  document.getElementById("gate-input").focus();
}

/**
 * Pull /api/health and list every check on the page. Shown whenever the report
 * fails or reports warnings, so diagnosing a setup problem never requires a
 * terminal — the answer appears where the problem does.
 */
async function showDiagnostics({ staleWarnings = false } = {}) {
  const panel = document.getElementById("diagnostics");
  const list = document.getElementById("diagnostics-list");
  const title = document.getElementById("diagnostics-title");

  const item = (ok, name, detail) => {
    const li = document.createElement("li");
    li.className = "diagnostics__item";
    const mark = document.createElement("span");
    mark.className = `diagnostics__mark diagnostics__mark--${ok ? "ok" : "bad"}`;
    mark.textContent = ok ? "✓" : "✗";
    const label = document.createElement("span");
    label.className = "diagnostics__name";
    label.textContent = name;
    const text = document.createElement("span");
    text.className = "diagnostics__detail";
    text.textContent = detail;
    li.append(mark, label, text);
    return li;
  };

  try {
    const headers = {};
    if (state.password) headers["x-report-password"] = state.password;
    const res = await fetch("/api/health", { headers });
    const body = await res.json();

    const rows = [...(body.environment || []), ...(body.probes || [])].map((c) =>
      item(c.ok, c.name, c.detail),
    );

    // Health queries Google live; the figures come from a cached snapshot. Once
    // a misconfiguration is fixed the two disagree until the cache turns over,
    // and "all connected" sitting above an error and a row of zeros reads as a
    // broken report. Say which is which.
    if (body.ready && staleWarnings) {
      title.textContent = "Setup check — all connected, refreshing";
      const note = document.createElement("li");
      note.className = "diagnostics__item diagnostics__item--note";
      note.textContent =
        "Configuration is now correct. The figures below come from a cached run made before it was fixed, and refresh automatically within 15 minutes — the warning above will clear with them.";
      rows.unshift(note);
    } else {
      title.textContent = body.ready ? "Setup check — all connected" : "Setup check";
    }

    list.replaceChildren(...rows);
    panel.hidden = false;
  } catch (err) {
    list.replaceChildren(item(false, "Setup check", `Could not reach /api/health: ${err.message}`));
    panel.hidden = false;
  }
}

function offerSampleMode(message) {
  const notice = document.getElementById("notice");
  notice.hidden = false;
  notice.replaceChildren(document.createTextNode(`${message} `));
  const link = document.createElement("a");
  link.href = "?demo=1";
  link.textContent = "Preview the layout with sample data";
  link.className = "footer__link";
  notice.appendChild(link);
}

async function refresh() {
  try {
    state.snapshot = await loadSnapshot(state.days);
    document.getElementById("gate").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("sample-banner").hidden = !state.snapshot.sample;
    render();
  } catch (err) {
    if (err.code === 401) {
      sessionStorage.removeItem(PASSWORD_KEY);
      showGate(state.password ? "That password was not accepted." : "");
      state.password = "";
      return;
    }
    document.getElementById("app").hidden = false;
    offerSampleMode(`Could not load live data: ${err.message}.`);
    showDiagnostics();
  }
}

document.getElementById("gate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.password = document.getElementById("gate-input").value;
  sessionStorage.setItem(PASSWORD_KEY, state.password);
  refresh();
});

function markActiveRange(value) {
  for (const other of document.querySelectorAll(".segmented__btn")) {
    other.classList.toggle("is-active", other.dataset.days === String(value));
  }
  document.getElementById("custom-range").hidden = value !== "custom";
}

for (const button of document.querySelectorAll(".segmented__btn")) {
  button.addEventListener("click", () => {
    const value = button.dataset.days;

    if (value === "custom") {
      markActiveRange("custom");
      // Seed the inputs with the window already on screen so Apply is a nudge
      // rather than a blank form.
      const current = state.snapshot?.window?.ga4;
      const startInput = document.getElementById("range-start");
      const endInput = document.getElementById("range-end");
      if (current && !startInput.value) startInput.value = current.start;
      if (current && !endInput.value) endInput.value = current.end;
      return;
    }

    const days = Number(value);
    if (!SUPPORTED_WINDOWS.includes(days)) return;
    if (days === state.days && !state.custom) return;
    state.days = days;
    state.custom = null;
    markActiveRange(days);
    // The dimension tables are windowed server-side, so a new range refetches.
    refresh();
  });
}

document.getElementById("range-apply").addEventListener("click", () => {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  if (!start || !end) return setNotice("Pick both a start and an end date.");
  if (start > end) return setNotice("The start date must come before the end date.");
  if (daysBetweenISO(start, end) > 365) {
    return setNotice("Custom ranges are capped at 365 days so year-over-year still fits in one query.");
  }
  setNotice("");
  state.custom = { start, end };
  refresh();
});

// Both comparison bases are computed from daily rows the snapshot already
// carries, so switching basis re-renders without another API round trip.
document.getElementById("comparison").addEventListener("change", (event) => {
  state.comparison = event.target.value;
  render();
});

for (const [id, key] of [
  ["filter-device", "device"],
  ["filter-country", "country"],
]) {
  document.getElementById(id).addEventListener("change", (event) => {
    // "all" is the country control's way of saying no filter; the other two use
    // an empty option for that.
    state.filters[key] = event.target.value === "all" ? "" : event.target.value;
    // Filters are applied by Google's APIs, so a change means a refetch. The
    // result is cached per combination, making the second visit instant.
    refresh();
  });
}

document.getElementById("filter-clear").addEventListener("click", () => {
  state.filters = { device: "", channels: [], country: "" };
  refresh();
});

for (const [id, key] of [
  ["queries-search", "queries"],
  ["landing-search", "landing"],
]) {
  document.getElementById(id).addEventListener("input", (event) => {
    state.search[key] = event.target.value;
    render();
  });
}

/**
 * Sales data is fetched once, lazily, the first time the tab is opened. It is a
 * separate endpoint from the report because it is local data on a different
 * time grain, and pulling it on every analytics load would be waste.
 */
async function ensureSalesLoaded() {
  if (salesState.data || salesState.loading) return salesState.loading;
  const headers = {};
  if (state.password) headers["x-report-password"] = state.password;
  salesState.loading = fetch("/api/sales", { headers })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`sales request failed (${res.status})`))))
    .then((data) => {
      salesState.data = data;
      const months = completeMonths(data);
      if (months.length && !salesState.from) {
        // Open on the last twelve complete months: enough to read a trend,
        // and never a part-finished month that would look like a slump.
        salesState.to = months.at(-1);
        salesState.from = months.length >= 12 ? months.at(-12) : months[0];
      }
      return data;
    })
    .catch((err) => {
      salesState.data = { present: false, daily: [], channels: [], warnings: [err.message] };
      return salesState.data;
    })
    .finally(() => {
      salesState.loading = null;
    });
  return salesState.loading;
}

function syncSalesControls() {
  const from = document.getElementById("sales-from");
  const to = document.getElementById("sales-to");
  const months = completeMonths(salesState.data);
  if (months.length) {
    for (const input of [from, to]) {
      input.min = months[0];
      input.max = months.at(-1);
    }
  }
  if (salesState.from) from.value = salesState.from;
  if (salesState.to) to.value = salesState.to;
}

function applySalesMonths(from, to) {
  salesState.from = from;
  salesState.to = to;
  syncSalesControls();
  renderSales();
}

for (const id of ["sales-from", "sales-to"]) {
  document.getElementById(id).addEventListener("change", () => {
    const from = document.getElementById("sales-from").value;
    const to = document.getElementById("sales-to").value;
    if (!from || !to) return;
    applySalesMonths(from <= to ? from : to, from <= to ? to : from);
  });
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    const months = completeMonths(salesState.data);
    if (!months.length) return;
    const last = months.at(-1);
    if (chip.dataset.ytd) {
      const january = `${last.slice(0, 4)}-01`;
      applySalesMonths(january < months[0] ? months[0] : january, last);
      return;
    }
    const count = Number(chip.dataset.months);
    const first = months.length >= count ? months.at(-count) : months[0];
    applySalesMonths(first, last);
  });
}

/* Differential tab --------------------------------------------------------
 *
 * Per-URL movement in Search Console, on two comparisons: the last six months
 * against the six before, and the latest complete month against the one
 * before. Served from /api/differential, which caches it — the underlying
 * months only change monthly.
 */

async function ensureDifferentialLoaded() {
  if (diffState.data || diffState.loading) return diffState.loading;
  const status = document.getElementById("diff-status");
  status.hidden = false;
  status.textContent = "Loading Search Console history…";

  const headers = {};
  if (state.password) headers["x-report-password"] = state.password;
  diffState.loading = fetch("/api/differential", { headers })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `request failed (${res.status})`);
      return body;
    })
    .then((data) => {
      diffState.data = data;
      return data;
    })
    .catch((err) => {
      diffState.data = { error: err.message, rows: [] };
      return diffState.data;
    })
    .finally(() => {
      diffState.loading = null;
    });
  return diffState.loading;
}

const DIFF_COLUMNS = [
  { key: "url", label: "URL", align: "left" },
  { key: "clicksRecent", label: "Clicks" },
  { key: "clicksPrior", label: "Prev" },
  { key: "clicksDelta", label: "Δ Clicks", delta: true },
  { key: "imprRecent", label: "Impr." },
  { key: "imprPrior", label: "Prev" },
  { key: "imprDelta", label: "Δ Impr.", delta: true },
  { key: "ctrRecent", label: "CTR" },
  { key: "posRecent", label: "Pos." },
  { key: "posDelta", label: "Δ Pos.", delta: true },
];

function diffRowValues(row, mode) {
  const side = mode === "month" ? row.month : row.period;
  return {
    url: row.url,
    clicksRecent: side.recent.clicks,
    clicksPrior: side.prior.clicks,
    clicksDelta: side.delta.clicks,
    imprRecent: side.recent.impressions,
    imprPrior: side.prior.impressions,
    imprDelta: side.delta.impressions,
    ctrRecent: side.recent.ctr,
    posRecent: side.recent.position,
    // Already signed so that positive means "moved up the page".
    posDelta: side.delta.position,
  };
}

function deltaCell(value, format, invertColour = false) {
  const span = document.createElement("span");
  if (!value) {
    span.textContent = "—";
    return span;
  }
  const good = invertColour ? value < 0 : value > 0;
  span.className = good ? "delta-up" : "delta-down";
  // The sign is spelled out rather than left to the colour: red and green
  // alone do not survive a colourblind reader, a printout, or a screenshot.
  span.textContent = `${value > 0 ? "+" : "\u2212"}${format(value)}`;
  return span;
}

function renderDifferential() {
  const data = diffState.data;
  const status = document.getElementById("diff-status");
  if (!data) return;

  if (data.error) {
    status.hidden = false;
    status.textContent = `Could not load the differential: ${data.error}`;
    return;
  }

  const mode = diffState.mode;
  const totals = mode === "month" ? data.totals.month : data.totals.period;
  const win = mode === "month"
    ? { recent: data.windows.thisMonth, prior: data.windows.lastMonth }
    : { recent: data.windows.recent, prior: data.windows.prior };

  const notes = [];
  if (data.truncated) {
    notes.push("Search Console returned its 25,000-row maximum, so the longest tail of URLs is not included.");
  }
  if (data.cache === "stale") notes.push("Showing cached figures; the last refresh failed.");
  notes.push(`${data.urlCount.toLocaleString()} URLs in total; the table lists the ${data.shown.toLocaleString()} that moved most. The CSV has every one.`);
  status.hidden = false;
  status.textContent = notes.join(" ");

  document.getElementById("diff-range").textContent = `${win.recent.label} vs ${win.prior.label}`;

  const pctChange = (now, before) => (before ? (now - before) / before : NaN);
  document.getElementById("diff-tiles").replaceChildren(
    tile({
      label: "Clicks",
      value: compact(totals.recent.clicks),
      current: totals.recent.clicks,
      previous: totals.prior.clicks,
    }),
    tile({
      label: "Impressions",
      value: compact(totals.recent.impressions),
      current: totals.recent.impressions,
      previous: totals.prior.impressions,
    }),
    tile({
      label: "CTR",
      value: percent(totals.recent.ctr),
      current: totals.recent.ctr,
      previous: totals.prior.ctr,
      deltaFormat: percent,
    }),
    tile({
      label: "Average position",
      value: totals.recent.position ? totals.recent.position.toFixed(1) : "—",
      current: totals.recent.position,
      previous: totals.prior.position,
      lowerIsBetter: true,
      deltaFormat: (v) => v.toFixed(1),
    }),
  );

  const term = diffState.search.trim().toLowerCase();
  const rows = data.rows
    .map((r) => diffRowValues(r, mode))
    .filter((r) => !term || r.url.toLowerCase().includes(term));

  const dir = diffState.dir === "asc" ? 1 : -1;
  const sortKey = diffState.sort === "delta" ? "clicksDelta" : diffState.sort;
  rows.sort((a, b) => {
    const x = a[sortKey];
    const y = b[sortKey];
    if (typeof x === "string") return x.localeCompare(y) * dir;
    // Sorting by a delta is asking "what moved", so magnitude leads.
    if (sortKey.endsWith("Delta")) return (Math.abs(y) - Math.abs(x)) * (dir === -1 ? 1 : -1);
    return (y - x) * (dir === -1 ? 1 : -1);
  });

  document.getElementById("diff-table-sub").textContent =
    `${rows.length.toLocaleString()} URLs shown · ${win.recent.label} against ${win.prior.label}`;

  renderSortableTable(document.getElementById("diff-table"), rows);
  renderMovers(rows, win);
}

function renderSortableTable(container, rows) {
  container.replaceChildren();
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "chart__empty";
    p.textContent = "No URLs match that filter.";
    container.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of DIFF_COLUMNS) {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.scope = "col";
    th.className = "is-sortable";
    if (diffState.sort === col.key) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = diffState.dir === "asc" ? "▲" : "▼";
      th.appendChild(arrow);
    }
    th.addEventListener("click", () => {
      if (diffState.sort === col.key) diffState.dir = diffState.dir === "asc" ? "desc" : "asc";
      else {
        diffState.sort = col.key;
        diffState.dir = "desc";
      }
      renderDifferential();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  for (const row of rows.slice(0, 500)) {
    const tr = document.createElement("tr");
    for (const col of DIFF_COLUMNS) {
      const td = document.createElement("td");
      const value = row[col.key];
      if (col.key === "url") {
        td.className = "url-cell";
        const link = document.createElement("a");
        link.href = value;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = value.replace(/^https?:\/\/[^/]+/, "") || "/";
        link.title = value;
        td.appendChild(link);
      } else if (col.key === "posDelta") {
        // Position is already signed so up is better; the colour follows.
        td.appendChild(deltaCell(value, (v) => Math.abs(v).toFixed(1)));
      } else if (col.delta) {
        td.appendChild(deltaCell(value, (v) => int.format(Math.abs(v))));
      } else if (col.key === "ctrRecent") {
        td.textContent = percent(value);
      } else if (col.key === "posRecent") {
        td.textContent = value ? value.toFixed(1) : "—";
      } else {
        td.textContent = int.format(value);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  container.appendChild(table);
}

/** The ten biggest gains and ten biggest losses by clicks. */
function renderMovers(rows, win) {
  const ranked = [...rows].sort((a, b) => b.clicksDelta - a.clicksDelta);
  const gains = ranked.filter((r) => r.clicksDelta > 0).slice(0, 8);
  const losses = ranked.filter((r) => r.clicksDelta < 0).slice(-8).reverse();
  const picked = [...gains, ...losses];

  document.getElementById("diff-movers-sub").textContent =
    `Clicks gained and lost, ${win.recent.label} against ${win.prior.label}.`;

  divergingBarChart(document.getElementById("diff-movers-chart"), {
    rows: picked.map((r) => ({
      name: r.url.replace(/^https?:\/\/[^/]+/, "") || "/",
      value: r.clicksDelta,
      detail: [
        { label: win.recent.label, value: int.format(r.clicksRecent) },
        { label: win.prior.label, value: int.format(r.clicksPrior) },
        { label: "Impressions", value: int.format(r.imprRecent) },
        { label: "Position", value: r.posRecent ? r.posRecent.toFixed(1) : "—" },
      ],
    })),
    positiveColor: surfaceColor("--delta-up"),
    negativeColor: surfaceColor("--delta-down"),
    format: (v) => int.format(v),
    labelWidth: 240,
  });
}

for (const button of document.querySelectorAll("[data-diff]")) {
  button.addEventListener("click", () => {
    diffState.mode = button.dataset.diff;
    for (const other of document.querySelectorAll("[data-diff]")) {
      other.classList.toggle("is-active", other === button);
    }
    renderDifferential();
  });
}

document.getElementById("diff-search").addEventListener("input", (event) => {
  diffState.search = event.target.value;
  renderDifferential();
});

/* Channel picker ----------------------------------------------------------
 *
 * Any subset of channels can be ticked. "Only Organic Search" and "everything
 * except Direct" are the same question asked twice — which channels do you
 * want — so one control answers both, rather than a dropdown listing every
 * channel once to include and once to exclude.
 *
 * An empty selection means every channel: a report of nothing helps no one,
 * and it keeps "all" and "none ticked" from being two indistinguishable
 * states.
 */
function channelSummary() {
  const picked = state.filters.channels;
  const all = state.channelOptions.length;
  if (!picked.length || (all && picked.length === all)) return "All channels";
  if (picked.length === 1) return picked[0];
  if (all && picked.length === all - 1) {
    return `Except ${state.channelOptions.find((c) => !picked.includes(c))}`;
  }
  return `${picked.length} of ${all || picked.length} channels`;
}

function renderChannelPicker() {
  const button = document.getElementById("filter-channel");
  const list = document.getElementById("channel-list");
  button.textContent = channelSummary();

  const picked = new Set(state.filters.channels);
  list.replaceChildren(
    ...state.channelOptions.map((name) => {
      const row = document.createElement("label");
      row.className = "picker__row";
      const box = document.createElement("input");
      box.type = "checkbox";
      // No selection means everything, so every box reads as ticked.
      box.checked = picked.size === 0 || picked.has(name);
      box.addEventListener("change", () => {
        const current = new Set(
          state.filters.channels.length ? state.filters.channels : state.channelOptions,
        );
        if (box.checked) current.add(name);
        else current.delete(name);
        commitChannels([...current]);
      });
      const text = document.createElement("span");
      text.textContent = name;
      row.append(box, text);
      return row;
    }),
  );
}

function commitChannels(next) {
  const all = state.channelOptions;
  // Unticking the last box would ask for a report of nothing, so it falls back
  // to everything — the same state as all ticked.
  const chosen = next.length === 0 || next.length === all.length ? [] : next;
  const changed = chosen.join("|") !== state.filters.channels.join("|");
  state.filters.channels = chosen;
  document.getElementById("filter-channel").textContent = channelSummary();
  if (changed) refresh();
}

document.getElementById("filter-channel").addEventListener("click", () => {
  const menu = document.getElementById("channel-menu");
  const open = menu.hidden;
  menu.hidden = !open;
  document.getElementById("filter-channel").setAttribute("aria-expanded", String(open));
});

document.querySelector("[data-channel-all]").addEventListener("click", () => commitChannels([]));
document.querySelector("[data-channel-none]").addEventListener("click", () => {
  // "Clear" means start from one channel rather than none, since none is the
  // same as all and would look like the button did nothing.
  commitChannels(state.channelOptions.slice(0, 1));
  renderChannelPicker();
});

document.addEventListener("click", (event) => {
  const menu = document.getElementById("channel-menu");
  if (menu.hidden) return;
  if (event.target.closest(".picker")) return;
  menu.hidden = true;
  document.getElementById("filter-channel").setAttribute("aria-expanded", "false");
});

// Tabs. Each one keeps only the controls that reach its data: the day range
// and dimension filters belong to Analytics, months to Sales, and the
// Differential tab carries its own comparison switch.
for (const button of document.querySelectorAll(".tabs__btn")) {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    for (const other of document.querySelectorAll(".tabs__btn")) {
      const active = other === button;
      other.classList.toggle("is-active", active);
      if (active) other.setAttribute("aria-current", "page");
      else other.removeAttribute("aria-current");
    }

    document.getElementById("tab-analytics").hidden = tab !== "analytics";
    document.getElementById("tab-sales").hidden = tab !== "sales";
    document.getElementById("tab-diff").hidden = tab !== "diff";

    const analytics = tab === "analytics";
    for (const id of ["filter-country", "filter-device"]) {
      document.getElementById(id).closest(".field").hidden = !analytics;
    }
    document.getElementById("filter-channel-field").hidden = !analytics;
    document.getElementById("filter-status").hidden = !analytics;
    document.getElementById("filter-clear").hidden = !analytics || !hasDimensionFilters();
    document.getElementById("sales-months").hidden = tab !== "sales";
    document.getElementById("custom-range").hidden = !analytics || !state.custom;
    document.querySelector(".segmented").hidden = !analytics;
    // Only Analytics and Sales share the comparison basis.
    document.getElementById("comparison").closest(".field").hidden = tab === "diff";
    document.querySelector(".filterbar").hidden = tab === "diff";

    // Charts measure their container, which has no width while hidden, so
    // each tab draws after it becomes visible.
    if (tab === "sales") {
      ensureSalesLoaded().then(() => {
        syncSalesControls();
        renderSales();
      });
    } else if (tab === "diff") {
      ensureDifferentialLoaded().then(renderDifferential);
    } else {
      render();
    }
  });
}

for (const button of document.querySelectorAll("[data-table-toggle]")) {
  button.addEventListener("click", () => {
    const id = button.dataset.tableToggle;
    const chart = document.getElementById(id);
    const table = document.getElementById(`${id}-table`);
    const showTable = table.hidden;
    table.hidden = !showTable;
    chart.hidden = showTable;
    button.textContent = showTable ? "Chart" : "Table";
  });
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const isDark =
    root.dataset.theme === "dark" ||
    (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = isDark ? "light" : "dark";
  // Charts read their colours from CSS custom properties, so they redraw.
  render();
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

refresh();
