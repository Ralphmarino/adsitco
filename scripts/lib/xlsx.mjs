/**
 * A minimal .xlsx reader: enough to pull cell values out of every sheet, and
 * nothing more.
 *
 * An xlsx is a ZIP of XML parts. Node ships inflate but no ZIP reader, so this
 * walks the central directory itself. The alternative was adding a spreadsheet
 * dependency to a repo that currently has exactly one, for a build step that
 * reads a single trusted file.
 *
 * Deliberately not supported: styles, formulas (the cached value is used),
 * merged cells, and number-format detection. Dates are handled by the caller,
 * which knows which column holds them.
 */

import { inflateRawSync } from "node:zlib";

/* ZIP --------------------------------------------------------------------- */

function findEndOfCentralDirectory(buf) {
  // The EOCD sits at the end, after a comment of up to 64KB.
  const minOffset = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Not a ZIP file: no end-of-central-directory record.");
}

/** Every entry in the archive, decompressed, keyed by path. */
export function readZip(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra fields at its own lengths,
    // which can differ from the central directory's.
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    // Any other compression method is skipped rather than guessed at.

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/* XML --------------------------------------------------------------------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** "BC" -> 54. Column letters to a zero-based index. */
function columnIndexFromRef(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  // Each <si> may hold several <t> runs (rich text); they concatenate.
  for (const [, body] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const [, run] of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += run;
    strings.push(unescapeXml(text));
  }
  return strings;
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  for (const match of xml.matchAll(/<row[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = match[1];
    const cells = [];
    if (body) {
      for (const cell of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const inner = cell[2] ?? "";
        const ref = /r="([A-Z]+)/.exec(attrs)?.[1];
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const index = ref ? columnIndexFromRef(ref) : cells.length;

        let value = null;
        if (type === "inlineStr") {
          let text = "";
          for (const [, run] of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += run;
          value = unescapeXml(text);
        } else {
          const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (raw !== undefined) {
            if (type === "s") value = sharedStrings[Number(raw)] ?? null;
            else if (type === "str" || type === "e") value = unescapeXml(raw);
            else if (type === "b") value = raw === "1";
            else {
              const n = Number(raw);
              value = Number.isFinite(n) ? n : unescapeXml(raw);
            }
          }
        }
        while (cells.length < index) cells.push(null);
        cells[index] = value;
      }
    }
    rows.push(cells);
  }
  return rows;
}

/* Workbook ---------------------------------------------------------------- */

/**
 * Sheets in workbook order, each `{ name, rows }` with rows as arrays of
 * primitive cell values.
 */
export function readWorkbook(buf) {
  const files = readZip(buf);
  const text = (name) => (files.has(name) ? files.get(name).toString("utf8") : null);

  const sharedStrings = parseSharedStrings(text("xl/sharedStrings.xml"));

  // workbook.xml gives each sheet a relationship id; the rels file maps that to
  // the part holding its data. Sheet order in the file is not sheetN.xml order.
  const rels = new Map();
  const relsXml = text("xl/_rels/workbook.xml.rels") ?? "";
  for (const [, id, target] of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }

  const workbookXml = text("xl/workbook.xml") ?? "";
  const sheets = [];
  for (const [, attrs] of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1];
    const target = rid ? rels.get(rid) : null;
    const part = target ? `xl/${target}` : null;
    const xml = part ? text(part) : null;
    if (!xml) continue;
    sheets.push({ name, rows: parseSheetXml(xml, sharedStrings) });
  }
  return sheets;
}

/**
 * Excel stores a date as days since 1899-12-30 — the offset absorbs the
 * fictional 1900 leap day Excel keeps for Lotus compatibility.
 */
export function excelSerialToISO(serial) {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
