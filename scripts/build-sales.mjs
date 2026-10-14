/**
 * Turns the sales workbook in data/ into a module the functions import.
 *
 * Accepts either the .xlsx export (tabs broken out by month) or a flat
 * data/sales.csv. Reading it at build time keeps the file out of public/,
 * where it would be served to anyone with the URL and bypass the report's
 * password gate, and avoids depending on a function's working directory to
 * find a bundled file.
 *
 * Run: node scripts/build-sales.mjs   (the Netlify build command runs it)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkbook, excelSerialToISO } from "./lib/xlsx.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const OUT = resolve(ROOT, "netlify/lib/sales-data.mjs");

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/* Source discovery -------------------------------------------------------- */

function findSource() {
  if (!existsSync(DATA_DIR)) return null;
  const entries = readdirSync(DATA_DIR).filter((f) => !f.startsWith("~$") && !f.startsWith("."));

  const csv = entries.find((f) => norm(f) === "sales.csv");
  if (csv) return { kind: "csv", path: join(DATA_DIR, csv), name: csv };

  // Any workbook in data/ — the export keeps its own name, so it is found by
  // extension rather than by a name the user has to remember to match.
  const books = entries.filter((f) => /\.xlsx$/i.test(f));
  if (books.length === 1) return { kind: "xlsx", path: join(DATA_DIR, books[0]), name: books[0] };
  if (books.length > 1) {
    const preferred = books.find((f) => /^sales\.xlsx$/i.test(f)) ?? books.sort()[0];
    return { kind: "xlsx", path: join(DATA_DIR, preferred), name: preferred, ambiguous: books };
  }
  return null;
}

/* Workbook layout --------------------------------------------------------- */

// The export's columns. Phone Calls is call volume, not orders — the orders
// figure for that channel is "Phone Call Quantity Sold".
const COLUMNS = {
  date: ["date"],
  webOrders: ["web - number of orders"],
  webRevenue: ["web - gross sales amount"],
  ebayOrders: ["ebay orders"],
  ebayRevenue: ["ebay sales"],
  callOrders: ["phone call quantity sold", "phone call quantity"],
  callRevenue: ["phone call sales"],
  calls: ["phone calls"],
};

function mapHeader(headerRow) {
  const cells = headerRow.map(norm);
  const index = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    index[key] = cells.findIndex((c) => aliases.includes(c));
  }
  // One sheet in the real export has a blank A1 where "Date" belongs; the
  // dates are still in the first column.
  if (index.date === -1) index.date = 0;
  return index;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].map(norm);
    if (cells.includes("web - gross sales amount") || cells.includes("ebay sales")) return i;
  }
  return -1;
}

function toISODate(value) {
  if (typeof value === "number") return excelSerialToISO(value);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const slash = /^(\d{1,2})[/](\d{1,2})[/](\d{2,4})$/.exec(text);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y.length === 2 ? `20${y}` : y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let text = String(value ?? "").trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const n = Number(text);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i;

/**
 * Sheets are read in this order and the first one to supply a date wins.
 *
 * Over half the dates in the real workbook appear in more than one sheet — the
 * "Total" sheets restate the monthly tabs — so summing every sheet would come
 * close to doubling three years of revenue. The monthly tabs are preferred
 * because they are the ones kept up to date.
 */
function sheetPriority(name) {
  const n = norm(name);
  if (/total/.test(n)) return 2;
  if (/^report-/.test(n)) return 1;
  if (MONTHS.test(n)) return 0;
  return 1;
}

function readWorkbookRows(path) {
  const sheets = readWorkbook(readFileSync(path));
  const ordered = sheets
    .map((s, i) => ({ ...s, priority: sheetPriority(s.name), order: i }))
    .sort((a, b) => a.priority - b.priority || a.order - b.order);

  const byDate = new Map();
  const conflicts = [];
  const skippedSheets = [];
  let skippedRows = 0;

  for (const sheet of ordered) {
    const headerRow = findHeaderRow(sheet.rows);
    if (headerRow === -1) {
      if (sheet.rows.length > 1) skippedSheets.push(sheet.name);
      continue;
    }
    const col = mapHeader(sheet.rows[headerRow]);

    for (const row of sheet.rows.slice(headerRow + 1)) {
      const date = toISODate(row[col.date]);
      if (!date) {
        if (row.some((c) => c !== null && String(c).trim() !== "")) skippedRows++;
        continue;
      }
      const record = {
        date,
        web: { orders: toNumber(row[col.webOrders]), revenue: toNumber(row[col.webRevenue]) },
        ebay: { orders: toNumber(row[col.ebayOrders]), revenue: toNumber(row[col.ebayRevenue]) },
        call: {
          orders: toNumber(row[col.callOrders]),
          revenue: toNumber(row[col.callRevenue]),
          calls: toNumber(row[col.calls]),
        },
        sheet: sheet.name,
      };

      const existing = byDate.get(date);
      if (!existing) {
        byDate.set(date, record);
        continue;
      }
      // Already have this date from a higher-priority sheet. Keep it, but say
      // so if the duplicate disagrees — silently picking one of two different
      // numbers is how a report ends up quietly wrong.
      for (const channel of ["web", "ebay", "call"]) {
        if (Math.abs(existing[channel].revenue - record[channel].revenue) > 0.01) {
          conflicts.push(
            `${date} ${channel}: ${existing.sheet} says ${existing[channel].revenue.toFixed(2)}, ` +
              `${sheet.name} says ${record[channel].revenue.toFixed(2)} — kept ${existing.sheet}.`,
          );
        }
      }
    }
  }

  const rows = [];
  for (const record of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const [id, data] of [
      ["web", record.web],
      ["call", record.call],
      ["ebay", record.ebay],
    ]) {
      if (!data.orders && !data.revenue && !data.calls) continue;
      const row = { date: record.date, channel: id, orders: Math.round(data.orders), revenue: Number(data.revenue.toFixed(2)) };
      if (data.calls) row.calls = Math.round(data.calls);
      rows.push(row);
    }
  }

  const warnings = [];
  if (skippedSheets.length) {
    warnings.push(`Sheets without a recognisable header were skipped: ${skippedSheets.join(", ")}.`);
  }
  if (skippedRows) warnings.push(`${skippedRows} row(s) skipped: unreadable date.`);
  if (conflicts.length) {
    warnings.push(
      `${conflicts.length} duplicated date(s) disagreed between sheets. First few: ${conflicts.slice(0, 3).join(" ")}`,
    );
  }

  return { rows, warnings, sheetCount: ordered.length };
}

/* CSV --------------------------------------------------------------------- */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const CHANNEL_MAP = [
  [["web", "website", "online", "ecommerce", "shop", "site", "webstore"], "web"],
  [["call", "phone", "call center", "telephone", "inbound"], "call"],
  [["ebay", "ebay store"], "ebay"],
];

function readCsvRows(path) {
  const table = parseCsv(readFileSync(path, "utf8"));
  if (table.length < 2) return { rows: [], warnings: ["The CSV has a header but no rows."] };
  const header = table[0].map(norm);
  const find = (aliases) => header.findIndex((h) => aliases.includes(h));
  const dateCol = find(["date", "order date", "day"]);
  const channelCol = find(["channel", "source", "sales channel"]);
  const orderCol = find(["orders", "order count", "transactions"]);
  const revenueCol = find(["revenue", "sales", "amount", "total", "net sales"]);
  if (dateCol === -1 || revenueCol === -1) {
    return { rows: [], warnings: [`The CSV needs a date and a revenue column. Found: ${table[0].join(", ")}.`] };
  }
  const rows = [];
  let skipped = 0;
  for (const raw of table.slice(1)) {
    const date = toISODate(raw[dateCol]);
    if (!date) { skipped++; continue; }
    const key = norm(raw[channelCol] ?? "web");
    const channel = CHANNEL_MAP.find(([aliases]) => aliases.includes(key))?.[1] ?? key.replace(/\s+/g, "") ?? "web";
    rows.push({
      date,
      channel,
      orders: orderCol === -1 ? 0 : Math.round(toNumber(raw[orderCol])),
      revenue: Number(toNumber(raw[revenueCol]).toFixed(2)),
    });
  }
  const warnings = skipped ? [`${skipped} row(s) skipped: unreadable date.`] : [];
  return { rows, warnings };
}

/* Build ------------------------------------------------------------------- */

const LABELS = { web: "Web", call: "Call", ebay: "eBay" };

function build() {
  const source = findSource();
  if (!source) {
    return {
      rows: [],
      meta: {
        present: false,
        rowCount: 0,
        channels: [],
        warnings: ["No sales workbook or CSV found in data/ — the Sales tab is empty until one is added."],
      },
    };
  }

  const { rows, warnings, sheetCount } =
    source.kind === "xlsx" ? readWorkbookRows(source.path) : readCsvRows(source.path);

  if (source.ambiguous) {
    warnings.unshift(
      `data/ holds more than one workbook (${source.ambiguous.join(", ")}). Using ${source.name}.`,
    );
  }

  const channelIds = [...new Set(rows.map((r) => r.channel))];
  const order = ["web", "call", "ebay"];
  channelIds.sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
  });

  return {
    rows,
    meta: {
      present: rows.length > 0,
      source: source.name,
      sheetCount: sheetCount ?? null,
      rowCount: rows.length,
      channels: channelIds.map((id) => ({ id, label: LABELS[id] ?? id })),
      firstDate: rows[0]?.date ?? null,
      lastDate: rows.at(-1)?.date ?? null,
      warnings,
    },
  };
}

const { rows, meta } = build();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// Generated by scripts/build-sales.mjs — do not edit.\n` +
    `export const SALES_ROWS = ${JSON.stringify(rows)};\n` +
    `export const SALES_META = ${JSON.stringify({ ...meta, builtAt: new Date().toISOString() })};\n`,
);

const totals = rows.reduce((t, r) => t + r.revenue, 0);
console.log(
  `sales: ${meta.rowCount} row(s) from ${meta.source ?? "nothing"}` +
    (meta.sheetCount ? ` (${meta.sheetCount} sheets)` : "") +
    (meta.firstDate ? `\n  ${meta.firstDate} → ${meta.lastDate}` : "") +
    (meta.channels.length ? ` · ${meta.channels.map((c) => c.label).join(", ")}` : "") +
    `\n  total revenue across all dates: ${totals.toLocaleString("en-US", { style: "currency", currency: "USD" })}` +
    (meta.warnings.length ? `\n  ${meta.warnings.join("\n  ")}` : ""),
);
