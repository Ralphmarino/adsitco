/**
 * Turns the files in data/ into a module the functions import — the curated
 * starting list of blogs worth tracking, plus any dates entered by hand.
 *
 *   blog-tracker-urls.csv  the list of posts, and their titles
 *   blog-exclude.txt       URLs never to track, whatever the patterns say
 *   blog-dates.csv         published/modified dates entered by hand
 *
 * Everything else that moves — last modified date, performance, how stale a
 * post is — comes from the live site and Search Console at runtime.
 *
 * Run: node scripts/build-blog-tracker.mjs   (the Netlify build command runs it)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exclusionFor } from "../netlify/lib/blog-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSV = resolve(ROOT, "data/blog-tracker-urls.csv");
const EXCLUDE = resolve(ROOT, "data/blog-exclude.txt");
const DATES = resolve(ROOT, "data/blog-dates.csv");
const OUT = resolve(ROOT, "netlify/lib/blog-seed.mjs");

function parseCsv(text) {
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

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const canonical = (url) => String(url ?? "").trim().replace(/\/+$/, "").toLowerCase();

function parseDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const slash = /^(\d{1,2})[/](\d{1,2})[/](\d{2,4})$/.exec(text);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y.length === 2 ? `20${y}` : y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

const warnings = [];

const explicitExclusions = existsSync(EXCLUDE)
  ? readFileSync(EXCLUDE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map(canonical)
  : [];

/**
 * Hand-entered dates, which outrank every live source.
 *
 * Comment lines are stripped before parsing so the file can explain itself —
 * the person filling it in is working in a text editor, not reading the README.
 */
const manualDates = new Map();
if (existsSync(DATES)) {
  const body = readFileSync(DATES, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const table = parseCsv(body);
  if (table.length) {
    const header = table[0].map(norm);
    const urlCol = header.findIndex((h) => ["url", "page", "address"].includes(h));
    const pubCol = header.findIndex((h) => ["published", "published date", "date"].includes(h));
    const modCol = header.findIndex((h) =>
      ["modified", "last modified", "updated", "lastmod"].includes(h),
    );
    if (urlCol === -1) {
      warnings.push("data/blog-dates.csv has no URL column — hand-entered dates ignored.");
    } else {
      for (const row of table.slice(1)) {
        const url = String(row[urlCol] ?? "").trim();
        if (!/^https?:\/\//.test(url)) continue;
        const published = pubCol === -1 ? null : parseDate(row[pubCol]);
        const modified = modCol === -1 ? null : parseDate(row[modCol]);
        if (!published && !modified) continue;
        manualDates.set(canonical(url), { published, modified });
      }
    }
  }
}

let seed = [];
let removedByPattern = [];

if (!existsSync(CSV)) {
  warnings.push("No data/blog-tracker-urls.csv — the tracker starts from the sitemap alone.");
} else {
  const table = parseCsv(readFileSync(CSV, "utf8"));
  const header = table[0].map(norm);
  const col = (...aliases) => header.findIndex((h) => aliases.includes(h));
  const urlCol = col("url", "page", "address");
  const titleCol = col("post_title", "title", "post title");
  const publishedCol = col("published date", "published", "date published", "publish date");
  const categoryCol = col("categories", "category");

  if (urlCol === -1) {
    warnings.push(`data/blog-tracker-urls.csv has no URL column. Found: ${table[0].join(", ")}.`);
  } else {
    const seen = new Set();
    for (const row of table.slice(1)) {
      const url = String(row[urlCol] ?? "").trim();
      if (!/^https?:\/\//.test(url)) continue;
      const key = canonical(url);
      if (seen.has(key)) continue;
      seen.add(key);

      if (explicitExclusions.includes(key)) continue;
      const excluded = exclusionFor(url);
      if (excluded) {
        removedByPattern.push({ url, rule: excluded.id });
        continue;
      }

      // The sheet's "Published Date" column is filled in by hand and the one
      // populated cell reads "Updated Oct 22, 2025" — a modified date under a
      // published heading. Taking it at the heading's word would have put a
      // 2025 publication date on a post written years earlier, so the prefix
      // decides which date it is.
      const dateCell = publishedCol === -1 ? "" : String(row[publishedCol] ?? "").trim();
      const isModified = /^(last\s+)?(updated|modified|refreshed)\b/i.test(dateCell);
      const parsed = parseDate(dateCell.replace(/^(last\s+)?(updated|modified|refreshed)\b[:\s]*/i, ""));

      const manual = manualDates.get(key);
      seed.push({
        url,
        title: titleCol === -1 ? "" : String(row[titleCol] ?? "").trim(),
        published: manual?.published ?? (isModified ? null : parsed),
        modified: manual?.modified ?? (isModified ? parsed : null),
        category: categoryCol === -1 ? "" : String(row[categoryCol] ?? "").trim(),
      });
    }
  }
}

if (removedByPattern.length) {
  warnings.push(
    `${removedByPattern.length} curated URL(s) matched a generated-content pattern and were left out: ` +
      removedByPattern.map((r) => `${r.url} (${r.rule})`).join(", "),
  );
}

const withPublished = seed.filter((s) => s.published).length;
const withModified = seed.filter((s) => s.modified).length;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// Generated by scripts/build-blog-tracker.mjs — do not edit.\n` +
    `export const BLOG_SEED = ${JSON.stringify(seed)};\n` +
    `export const BLOG_EXCLUSIONS = ${JSON.stringify(explicitExclusions)};\n` +
    // Keyed by canonical URL and exported whole, including rows for posts the
    // curated CSV never had: a hand-entered date should also reach a post the
    // tracker discovers from the live site.
    `export const BLOG_MANUAL_DATES = ${JSON.stringify(Object.fromEntries(manualDates))};\n` +
    `export const BLOG_SEED_META = ${JSON.stringify({
      count: seed.length,
      withPublished,
      withModified,
      manualDates: manualDates.size,
      removedByPattern,
      warnings,
      builtAt: new Date().toISOString(),
    })};\n`,
);

console.log(
  `blog tracker: ${seed.length} curated post(s)` +
    `\n  dates from data/: ${withPublished} published, ${withModified} modified` +
    ` (${manualDates.size} hand-entered in blog-dates.csv)` +
    `\n  ${explicitExclusions.length} explicit exclusion(s), ${removedByPattern.length} removed by pattern` +
    (warnings.length ? `\n  ${warnings.join("\n  ")}` : ""),
);
