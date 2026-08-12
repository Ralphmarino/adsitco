import { timeSeriesChart, barChart, renderTable, labelCell } from "/charts.js";

const SUPPORTED_WINDOWS = [7, 28, 90];
const PASSWORD_KEY = "adsitco-report-password";

const state = {
  days: 28,
  filters: { device: "", channel: "" },
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
function sliceWindow(daily, days) {
  if (!daily?.length) return { current: [], previous: [], range: null, previousRange: null };
  const end = daily[daily.length - 1].date;
  const start = shiftISO(end, -(days - 1));
  const previousEnd = shiftISO(start, -1);
  const previousStart = shiftISO(previousEnd, -(days - 1));
  const within = (row, a, b) => row.date >= a && row.date <= b;
  return {
    current: densify(daily.filter((r) => within(r, start, end)), start, end),
    previous: daily.filter((r) => within(r, previousStart, previousEnd)),
    range: { start, end },
    previousRange: { start: previousStart, end: previousEnd },
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
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    node.textContent = "no prior period";
    return node;
  }
  const change = (current - previous) / Math.abs(previous);
  const improving = lowerIsBetter ? change < 0 : change > 0;
  const flat = Math.abs(change) < 0.0005;
  node.className = flat ? "" : improving ? "delta--up" : "delta--down";
  const arrow = flat ? "→" : change > 0 ? "↑" : "↓";
  node.textContent = `${arrow} ${Math.abs(change * 100).toFixed(1)}% vs previous period`;
  node.title = `Previous period: ${format(previous)}`;
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

  const deltaEl = document.createElement("p");
  deltaEl.className = "tile__delta";
  deltaEl.appendChild(
    deltaNode(current, previous, { lowerIsBetter, format: deltaFormat || compact }),
  );

  card.append(labelEl, valueEl, deltaEl);
  return card;
}

/* Data loading ------------------------------------------------------------- */

function reportUrl(days = state.days, filters = state.filters) {
  const params = new URLSearchParams({ days: String(days) });
  if (filters.device) params.set("device", filters.device);
  if (filters.channel) params.set("channel", filters.channel);
  return `/api/report?${params}`;
}

async function loadSnapshot(days) {
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

function syncFilterUI(snapshot) {
  const noFilters = !state.filters.device && !state.filters.channel;
  const fromApi = snapshot.ga4?.channelOptions || [];
  if (fromApi.length) state.channelOptions = fromApi;
  else if (noFilters) state.channelOptions = (snapshot.ga4?.channels || []).map((c) => c.name);

  const select = document.getElementById("filter-channel");
  const options = ['<option value="">All channels</option>'].concat(
    state.channelOptions.map((name) => {
      const safe = name.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
      return `<option value="${safe}"${name === state.filters.channel ? " selected" : ""}>${safe}</option>`;
    }),
  );
  select.innerHTML = options.join("");
  document.getElementById("filter-device").value = state.filters.device;
  document.getElementById("filter-clear").hidden = noFilters;

  const status = document.getElementById("filter-status");
  if (noFilters) {
    status.textContent = "";
    return;
  }
  const applied = [
    state.filters.device && `${state.filters.device} only`,
    state.filters.channel && `${state.filters.channel} only`,
  ].filter(Boolean);
  // Say plainly which panels a filter could not reach, rather than letting an
  // unfiltered search number sit under a filtered heading.
  const caveat = state.filters.channel
    ? " · Search Console has no channel dimension, so the search panels below ignore the channel filter"
    : "";
  status.textContent = `Filtered: ${applied.join(", ")}${caveat}`;
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  syncFilterUI(snapshot);

  const ga4 = sliceWindow(snapshot.ga4?.daily, state.days);
  const gsc = sliceWindow(snapshot.gsc?.daily, state.days);
  const ga4Now = ga4Totals(ga4.current);
  const ga4Before = ga4Totals(ga4.previous);
  const gscNow = gscTotals(gsc.current);
  const gscBefore = gscTotals(gsc.previous);

  document.getElementById("site-label").textContent = `${snapshot.siteLabel} — search & analytics`;
  document.getElementById("range-meta").textContent =
    `Last ${state.days} days · analytics ${rangeLabel(ga4.range)} · search ${rangeLabel(gsc.range)}`;
  document.getElementById("ga4-range").textContent = rangeLabel(ga4.range);
  document.getElementById("gsc-range").textContent =
    `${rangeLabel(gsc.range)} · Search Console runs ~3 days behind`;

  // Hero — the one big number on the page.
  document.getElementById("hero-value").textContent = int.format(ga4Now.sessions);
  const heroDelta = document.getElementById("hero-delta");
  heroDelta.replaceChildren(deltaNode(ga4Now.sessions, ga4Before.sessions));
  document.getElementById("hero-sub").textContent =
    `${rangeLabel(ga4.range)} · previous period ${int.format(ga4Before.sessions)} sessions`;

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

  const surfaceColor = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* Charts */

  timeSeriesChart(document.getElementById("traffic-chart"), {
    series: [
      {
        label: "Sessions",
        color: surfaceColor("--series-1"),
        points: ga4.current.map((r) => ({ date: r.date, value: r.sessions })),
      },
      {
        label: "Active users",
        color: surfaceColor("--series-2"),
        points: ga4.current.map((r) => ({ date: r.date, value: r.users })),
      },
    ],
    format: fmt.count,
  });

  renderTable(document.getElementById("traffic-chart-table"), {
    columns: [
      { label: "Date", render: (r) => prettyDate(r.date) },
      { label: "Sessions", render: (r) => int.format(r.sessions) },
      { label: "Users", render: (r) => int.format(r.users) },
      { label: "Page views", render: (r) => int.format(r.pageViews) },
    ],
    rows: [...ga4.current].reverse(),
  });

  const revenuePanel = document.getElementById("revenue-panel");
  revenuePanel.hidden = !showRevenue;
  if (showRevenue) {
    timeSeriesChart(document.getElementById("revenue-chart"), {
      series: [
        {
          label: "Revenue",
          color: surfaceColor("--series-3"),
          points: ga4.current.map((r) => ({ date: r.date, value: r.revenue })),
        },
      ],
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
    series: [
      {
        label: "Clicks",
        color: surfaceColor("--series-1"),
        points: gsc.current.map((r) => ({ date: r.date, value: r.clicks })),
      },
    ],
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
    series: [
      {
        label: "Impressions",
        color: surfaceColor("--series-2"),
        points: gsc.current.map((r) => ({ date: r.date, value: r.impressions })),
      },
    ],
    format: fmt.count,
  });

  renderTable(document.getElementById("impressions-chart-table"), {
    columns: [
      { label: "Date", render: (r) => prettyDate(r.date) },
      { label: "Impressions", render: (r) => int.format(r.impressions) },
    ],
    rows: [...gsc.current].reverse(),
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
  document.getElementById("raw-link").href = `/api/report?days=${state.days}`;

  setNotice((snapshot.warnings || []).join(" · "));
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

async function refresh() {
  try {
    state.snapshot = await loadSnapshot(state.days);
    document.getElementById("gate").hidden = true;
    document.getElementById("app").hidden = false;
    render();
  } catch (err) {
    if (err.code === 401) {
      sessionStorage.removeItem(PASSWORD_KEY);
      showGate(state.password ? "That password was not accepted." : "");
      state.password = "";
      return;
    }
    document.getElementById("app").hidden = false;
    setNotice(`Could not load the report: ${err.message}`);
  }
}

document.getElementById("gate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.password = document.getElementById("gate-input").value;
  sessionStorage.setItem(PASSWORD_KEY, state.password);
  refresh();
});

for (const button of document.querySelectorAll(".segmented__btn")) {
  button.addEventListener("click", () => {
    const days = Number(button.dataset.days);
    if (!SUPPORTED_WINDOWS.includes(days) || days === state.days) return;
    state.days = days;
    for (const other of document.querySelectorAll(".segmented__btn")) {
      other.classList.toggle("is-active", other === button);
    }
    // The dimension tables are windowed server-side, so switching range refetches.
    refresh();
  });
}

for (const [id, key] of [
  ["filter-device", "device"],
  ["filter-channel", "channel"],
]) {
  document.getElementById(id).addEventListener("change", (event) => {
    state.filters[key] = event.target.value;
    // Filters are applied by Google's APIs, so a change means a refetch. The
    // result is cached per combination, making the second visit instant.
    refresh();
  });
}

document.getElementById("filter-clear").addEventListener("click", () => {
  state.filters = { device: "", channel: "" };
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
