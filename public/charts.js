/* Chart primitives.
 *
 * Hand-rolled SVG rather than a charting library: the report is served from a
 * Netlify function behind a password, and keeping the page free of third-party
 * script means nothing external ever sees the analytics.
 *
 * Marks follow one fixed spec — 2px lines, ~10% area washes, 8px end markers
 * carrying a 2px surface-coloured ring, hairline solid gridlines, bars capped
 * at 24px with a 4px rounded data-end. */

const SVG_NS = "http://www.w3.org/2000/svg";
const tooltipEl = document.getElementById("tooltip");

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Round a domain up to a readable tick step (1/2/5 × 10ⁿ). */
function niceTicks(max, count = 4) {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rawStep = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised > 5 ? 10 : normalised > 2 ? 5 : normalised > 1 ? 2 : 1) * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { max: top, ticks };
}

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function showTooltip(html, event) {
  tooltipEl.innerHTML = html;
  tooltipEl.hidden = false;
  const rect = tooltipEl.getBoundingClientRect();
  const pad = 14;
  let left = event.clientX + pad;
  let top = event.clientY + pad;
  if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - pad;
  tooltipEl.style.left = `${Math.max(8, left)}px`;
  tooltipEl.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

function legend(series) {
  const wrap = document.createElement("div");
  wrap.className = "chart__legend";
  for (const s of series) {
    const item = document.createElement("span");
    item.className = "chart__legend-item";
    const swatch = document.createElement("span");
    swatch.className = "chart__swatch";
    swatch.style.background = s.color;
    item.append(swatch, document.createTextNode(s.label));
    wrap.appendChild(item);
  }
  return wrap;
}

function emptyState(container, message) {
  container.replaceChildren();
  const p = document.createElement("p");
  p.className = "chart__empty";
  p.textContent = message;
  container.appendChild(p);
}

/**
 * Multi-series time series. One shared y-axis by design: a second scale would
 * let two unrelated units be compared by eye, which is always misleading.
 * Measures of different magnitude get their own chart instead.
 */
export function timeSeriesChart(container, { series, format, invertY = false }) {
  const points = series[0]?.points ?? [];
  if (points.length < 2) {
    emptyState(container, "Not enough data in this range yet.");
    return;
  }

  container.replaceChildren();
  if (series.length > 1) container.appendChild(legend(series));

  const width = Math.max(container.clientWidth || 640, 320);
  const height = 250;
  const pad = { top: 14, right: series.length > 1 ? 64 : 56, bottom: 26, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": series.map((s) => s.label).join(" and "),
  });

  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter(Number.isFinite);
  const surface = token("--surface-1");

  let scaleY;
  let ticks;
  if (invertY) {
    // Search position: 1 is best, so the axis runs downward and "up" reads as
    // improving. The domain is padded rather than zero-based — zero is not a
    // reachable position and would flatten the whole series.
    const lo = Math.max(1, Math.floor(Math.min(...values) - 1));
    const hi = Math.ceil(Math.max(...values) + 1);
    const span = Math.max(hi - lo, 1);
    scaleY = (v) => pad.top + ((v - lo) / span) * plotH;
    const step = Math.max(1, Math.round(span / 4));
    ticks = [];
    for (let v = lo; v <= hi + 0.001; v += step) ticks.push(Number(v.toFixed(2)));
  } else {
    const nice = niceTicks(Math.max(...values, 0));
    scaleY = (v) => pad.top + plotH - (v / nice.max) * plotH;
    ticks = nice.ticks;
  }

  const scaleX = (i) => pad.left + (i / (points.length - 1)) * plotW;

  for (const tick of ticks) {
    const y = scaleY(tick);
    el("line", {
      x1: pad.left,
      x2: pad.left + plotW,
      y1: y,
      y2: y,
      stroke: token("--gridline"),
      "stroke-width": 1,
    }, svg);
    const label = el("text", {
      x: pad.left - 9,
      y: y + 4,
      "text-anchor": "end",
      fill: token("--text-muted"),
      "font-size": 11,
      "font-family": "inherit",
    }, svg);
    label.textContent = format.axis(tick);
  }

  // Only a single series gets an area wash — overlapping washes muddy both.
  if (series.length === 1) {
    const s = series[0];
    const base = invertY ? pad.top + plotH : scaleY(0);
    const d = [
      `M ${scaleX(0)} ${base}`,
      ...s.points.map((p, i) => `L ${scaleX(i)} ${scaleY(p.value)}`),
      `L ${scaleX(s.points.length - 1)} ${base}`,
      "Z",
    ].join(" ");
    el("path", { d, fill: s.color, "fill-opacity": 0.1 }, svg);
  }

  for (const s of series) {
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${scaleX(i)} ${scaleY(p.value)}`).join(" ");
    el("path", {
      d,
      fill: "none",
      stroke: s.color,
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }, svg);

    const lastIndex = s.points.length - 1;
    const lx = scaleX(lastIndex);
    const ly = scaleY(s.points[lastIndex].value);
    el("circle", { cx: lx, cy: ly, r: 4, fill: s.color, stroke: surface, "stroke-width": 2 }, svg);

    // Direct end label — the endpoint only, never a number on every point.
    // A comparison series skips it: the two lines converge at the right edge
    // often enough that stacked labels would collide, and the legend and
    // tooltip already carry it.
    if (s.endLabel !== false) {
      const label = el("text", {
        x: lx + 9,
        y: ly + 4,
        fill: token("--text-secondary"),
        "font-size": 11.5,
        "font-weight": 600,
        "font-family": "inherit",
      }, svg);
      label.textContent = format.compact(s.points[lastIndex].value);
    }
  }

  el("line", {
    x1: pad.left,
    x2: pad.left + plotW,
    y1: pad.top + plotH,
    y2: pad.top + plotH,
    stroke: token("--axis"),
    "stroke-width": 1,
  }, svg);

  for (const i of [0, Math.floor((points.length - 1) / 2), points.length - 1]) {
    const label = el("text", {
      x: scaleX(i),
      y: height - 7,
      "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle",
      fill: token("--text-muted"),
      "font-size": 11,
      "font-family": "inherit",
    }, svg);
    label.textContent = shortDate(points[i].date);
  }

  // Hover layer: crosshair plus a tooltip covering every series at that date.
  const crosshair = el("line", {
    y1: pad.top,
    y2: pad.top + plotH,
    stroke: token("--axis"),
    "stroke-width": 1,
    opacity: 0,
  }, svg);
  const markers = series.map((s) =>
    el("circle", { r: 4.5, fill: s.color, stroke: surface, "stroke-width": 2, opacity: 0 }, svg),
  );

  const capture = el("rect", {
    x: pad.left,
    y: pad.top,
    width: plotW,
    height: plotH,
    fill: "transparent",
  }, svg);

  capture.addEventListener("mousemove", (event) => {
    const box = svg.getBoundingClientRect();
    const ratio = (event.clientX - box.left) * (width / box.width);
    const i = Math.min(
      points.length - 1,
      Math.max(0, Math.round(((ratio - pad.left) / plotW) * (points.length - 1))),
    );
    const x = scaleX(i);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.setAttribute("opacity", 1);
    series.forEach((s, si) => {
      markers[si].setAttribute("cx", x);
      markers[si].setAttribute("cy", scaleY(s.points[i].value));
      markers[si].setAttribute("opacity", 1);
    });

    const rows = series
      .map((s) => {
        const point = s.points[i];
        // A comparison series sits at the same index but a different date, so
        // it carries its own date rather than borrowing the header's.
        const ownDate =
          point.date && point.date !== points[i].date
            ? ` <span class="tooltip__when">${shortDate(point.date)}</span>`
            : "";
        return `<div class="tooltip__row"><span class="tooltip__key"><span class="chart__swatch" style="background:${s.color}"></span>${s.label}${ownDate}</span><span class="tooltip__value">${format.full(
          point.value,
        )}</span></div>`;
      })
      .join("");
    showTooltip(`<div class="tooltip__date">${shortDate(points[i].date)}</div>${rows}`, event);
  });

  capture.addEventListener("mouseleave", () => {
    crosshair.setAttribute("opacity", 0);
    markers.forEach((m) => m.setAttribute("opacity", 0));
    hideTooltip();
  });

  container.appendChild(svg);
}

/** Path for a bar with only its data-end rounded; it stays square at the baseline. */
function barPath(x, y, w, h, r) {
  const radius = Math.min(r, w, h / 2);
  if (radius <= 0) return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
  return [
    `M ${x} ${y}`,
    `h ${w - radius}`,
    `a ${radius} ${radius} 0 0 1 ${radius} ${radius}`,
    `v ${h - radius * 2}`,
    `a ${radius} ${radius} 0 0 1 ${-radius} ${radius}`,
    `h ${-(w - radius)}`,
    "Z",
  ].join(" ");
}

/** Horizontal bars, sorted, one colour — the category is identity, not a series. */
export function barChart(container, { rows, color, format, labelWidth = 128 }) {
  if (!rows.length) {
    emptyState(container, "No data in this range yet.");
    return;
  }

  container.replaceChildren();

  const width = Math.max(container.clientWidth || 640, 320);
  const rowHeight = 30;
  const barHeight = 20; // capped well under 24px so the band keeps some air
  const valueWidth = 62;
  const height = rows.length * rowHeight + 6;
  const plotW = Math.max(width - labelWidth - valueWidth, 60);
  const max = Math.max(...rows.map((r) => r.value), 1);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" });

  rows.forEach((row, i) => {
    const y = i * rowHeight + 3;
    const w = Math.max((row.value / max) * plotW, row.value > 0 ? 2 : 0);

    const name = el("text", {
      x: 0,
      y: y + barHeight / 2 + 4,
      fill: token("--text-secondary"),
      "font-size": 12,
      "font-family": "inherit",
    }, svg);
    name.textContent = row.name;
    // Long channel or source names get ellipsised rather than overlapping the
    // bar — a label is never allowed to be clipped by its own mark.
    if (name.getComputedTextLength && name.getComputedTextLength() > labelWidth - 10) {
      let text = row.name;
      while (text.length > 3 && name.getComputedTextLength() > labelWidth - 10) {
        text = text.slice(0, -1);
        name.textContent = `${text}…`;
      }
    }

    if (w > 0) {
      el("path", {
        d: barPath(labelWidth, y, w, barHeight, 4),
        fill: color,
      }, svg);
    }

    const value = el("text", {
      x: labelWidth + w + 8,
      y: y + barHeight / 2 + 4,
      fill: token("--text-secondary"),
      "font-size": 12,
      "font-weight": 600,
      "font-family": "inherit",
    }, svg);
    value.textContent = format.compact(row.value);

    const hit = el("rect", {
      x: 0,
      y,
      width,
      height: barHeight,
      fill: "transparent",
    }, svg);
    hit.addEventListener("mousemove", (event) => {
      showTooltip(
        `<div class="tooltip__date">${row.name}</div>` +
          (row.detail || [])
            .map(
              (d) =>
                `<div class="tooltip__row"><span class="tooltip__key">${d.label}</span><span class="tooltip__value">${d.value}</span></div>`,
            )
            .join(""),
        event,
      );
    });
    hit.addEventListener("mouseleave", hideTooltip);
  });

  container.appendChild(svg);
}

/** Table view — also the accessibility fallback for every chart. */
export function renderTable(container, { columns, rows, empty = "No data in this range yet." }) {
  container.replaceChildren();
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "chart__empty";
    p.textContent = empty;
    container.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.scope = "col";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      const rendered = col.render(row);
      if (rendered instanceof Node) td.appendChild(rendered);
      else td.textContent = rendered;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  container.appendChild(table);
}

export function labelCell(main, sub) {
  const wrap = document.createDocumentFragment();
  const primary = document.createElement("span");
  primary.className = "cell-label";
  primary.textContent = main;
  wrap.appendChild(primary);
  if (sub) {
    const secondary = document.createElement("span");
    secondary.className = "cell-sub";
    secondary.textContent = sub;
    wrap.appendChild(secondary);
  }
  return wrap;
}
