import { timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(req) {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Shared-password gate. With REPORT_PASSWORD unset the report is public, which
 * is only sensible for a site whose analytics you do not mind publishing.
 */
export function checkViewerAuth(req) {
  const expected = process.env.REPORT_PASSWORD;
  if (!expected) return { ok: true, public: true };

  const supplied = bearer(req) || req.headers.get("x-report-password");
  if (supplied && safeEqual(supplied, expected)) return { ok: true, public: false };
  return { ok: false, public: false };
}

/** Separate secret for forcing a data pull, so a viewer cannot burn API quota. */
export function checkRefreshAuth(req) {
  const expected = process.env.REFRESH_TOKEN;
  if (!expected) return false;
  const supplied = req.headers.get("x-refresh-token");
  return Boolean(supplied) && safeEqual(supplied, expected);
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
