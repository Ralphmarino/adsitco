/**
 * Turns data/sales.csv into a module the functions can import.
 *
 * Reading the CSV at build time rather than at request time keeps it out of
 * public/ — where anything is served to the open internet and would bypass the
 * report's password gate — and avoids depending on a function's working
 * directory to find a bundled file. The generated module is a build artifact,
 * not source.
 *
 * Run: node scripts/build-sales.mjs   (the Netlify build command runs it)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "data/sales.csv");
const OUT = resolve(ROOT, "netlify/lib/sales-data.mjs");

/* CSV parsing ------------------------------------------------------------- */

/**
 * A real CSV reader rather than split(","): sales exports routinely carry
 * quoted fields with commas inside them ("Smith, John"), doubled quotes, CRLF
 * line endings and a UTF-8 BOM, and every one of those silently corrupts a
 * naive split.
 */
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
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");

/** Find a column by any of several accepted spellings. */
function columnIndex(header, aliases) {
  const normalised = header.map(norm);
  for (const alias of aliases) {
    const i = normalised.indexOf(norm(alias));
    if (i !== -1) return i;
  }
  return -1;
}

const DATE_ALIASES = ["date", "order date", "orderdate", "day", "transaction date"];
const CHANNEL_ALIASES = ["channel", "source", "sales channel", "order source", "type"];
const ORDER_ALIASES = ["orders", "order count", "ordercount", "transactions", "count", "qty", "quantity"];
const REVENUE_ALIASES = ["revenue", "sales", "amount", "total", "net sales", "gross sales", "sales total"];

/**
 * Money as exported by accounting tools: "$3,820.50", "1 234,00", "(45.00)" for
 * a negative. Anything unreadable returns NaN so the caller can warn rather
 * than quietly count it as zero.
 */
export function parseMoney(value) {
  let text = String(value ?? "").trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "").replace(/[^0-9.,-]/g, "");
  // A comma used as the decimal separator: "1234,56" with no dot present.
  if (/,\d{1,2}$/.test(text) && !text.includes(".")) text = text.replace(",", ".");
  text = text.replace(/,/g, "");
  const n = Number(text);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}

/** ISO first, then US M/D/YYYY, which is what most US exports produce. */
export function parseDate(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const slash = /^(\d{1,2})[/](\d{1,2})[/](\d{2,4})$/.exec(text);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

const CHANNEL_MAP = [
  [["web", "website", "online", "ecommerce", "shop", "site", "webstore"], "web", "Web"],
  [["call", "phone", "callcenter", "telephone", "inbound", "callin"], "call", "Call"],
  [["ebay", "ebaystore", "ebaysales"], "ebay", "eBay"],
];

/** Map an exported channel label onto one of the report's channels. */
export function normaliseChannel(value) {
  const key = norm(value);
  if (!key) return null;
  for (const [aliases, id, label] of CHANNEL_MAP) {
    if (aliases.includes(key)) return { id, label };
  }
  // An unrecognised channel is kept rather than dropped — losing revenue
  // silently is worse than showing a channel nobody planned for.
  const label = String(value).trim();
  return { id: key, label };
}

/* Build ------------------------------------------------------------------- */

function build() {
  const warnings = [];

  if (!existsSync(SOURCE)) {
    return {
      rows: [],
      meta: {
        present: false,
        rowCount: 0,
        channels: [],
        warnings: ["No data/sales.csv in the repository — the Sales tab is empty until one is added."],
      },
    };
  }

  const table = parseCsv(readFileSync(SOURCE, "utf8"));
  if (table.length < 2) {
    return { rows: [], meta: { present: true, rowCount: 0, channels: [], warnings: ["data/sales.csv has a header but no rows."] } };
  }

  const header = table[0];
  const dateCol = columnIndex(header, DATE_ALIASES);
  const channelCol = columnIndex(header, CHANNEL_ALIASES);
  const orderCol = columnIndex(header, ORDER_ALIASES);
  const revenueCol = columnIndex(header, REVENUE_ALIASES);

  if (dateCol === -1) {
    return {
      rows: [],
      meta: {
        present: true,
        rowCount: 0,
        channels: [],
        warnings: [
          `data/sales.csv has no recognisable date column. Found: ${header.join(", ")}. Rename one to "date".`,
        ],
      },
    };
  }
  if (revenueCol === -1) {
    return {
      rows: [],
      meta: {
        present: true,
        rowCount: 0,
        channels: [],
        warnings: [
          `data/sales.csv has no recognisable revenue column. Found: ${header.join(", ")}. Rename one to "revenue".`,
        ],
      },
    };
  }

  const rows = [];
  const channels = new Map();
  let badDates = 0;
  let badMoney = 0;

  for (let i = 1; i < table.length; i++) {
    const raw = table[i];
    const date = parseDate(raw[dateCol]);
    if (!date) {
      badDates++;
      continue;
    }
    const revenue = parseMoney(raw[revenueCol]);
    if (!Number.isFinite(revenue)) {
      badMoney++;
      continue;
    }
    const channel = channelCol === -1 ? { id: "web", label: "Web" } : normaliseChannel(raw[channelCol]);
    if (!channel) continue;
    const orders = orderCol === -1 ? 0 : Math.round(parseMoney(raw[orderCol]) || 0);

    channels.set(channel.id, channel.label);
    rows.push({ date, channel: channel.id, orders, revenue: Number(revenue.toFixed(2)) });
  }

  if (channelCol === -1) {
    warnings.push('data/sales.csv has no channel column, so every row is counted as "Web".');
  }
  if (orderCol === -1) {
    warnings.push("data/sales.csv has no orders column, so order counts and average order value are unavailable.");
  }
  if (badDates) warnings.push(`${badDates} row(s) skipped: unreadable date.`);
  if (badMoney) warnings.push(`${badMoney} row(s) skipped: unreadable revenue.`);

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel));

  return {
    rows,
    meta: {
      present: true,
      rowCount: rows.length,
      channels: [...channels].map(([id, label]) => ({ id, label })),
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
  `// Generated by scripts/build-sales.mjs from data/sales.csv — do not edit.\n` +
    `export const SALES_ROWS = ${JSON.stringify(rows)};\n` +
    `export const SALES_META = ${JSON.stringify({ ...meta, builtAt: new Date().toISOString() })};\n`,
);

console.log(
  `sales: ${meta.rowCount} row(s)` +
    (meta.firstDate ? ` ${meta.firstDate} → ${meta.lastDate}` : "") +
    (meta.channels.length ? ` · channels: ${meta.channels.map((c) => c.label).join(", ")}` : "") +
    (meta.warnings.length ? `\n  ${meta.warnings.join("\n  ")}` : ""),
);
