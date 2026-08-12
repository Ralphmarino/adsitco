// All report dates are handled as plain YYYY-MM-DD strings in UTC. Google's
// APIs speak that format, and it keeps the daily rows stable regardless of
// where the function happens to run.

export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(n, from = new Date()) {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() - n);
  return toISODate(d);
}

export function shiftDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

/**
 * A window ending `lagDays` before today, covering `days` days inclusive,
 * plus the equally long window immediately before it for period-on-period
 * comparison.
 *
 * GA4 is complete through yesterday. Search Console runs two to three days
 * behind, so each source gets its own anchor rather than a shared one that
 * would leave GSC with empty trailing days.
 */
export function buildWindow(days, lagDays) {
  const end = daysAgo(lagDays);
  const start = shiftDays(end, -(days - 1));
  const previousEnd = shiftDays(start, -1);
  const previousStart = shiftDays(previousEnd, -(days - 1));
  return { start, end, previousStart, previousEnd, days };
}

// GA4 returns dates as "20260810"; everything downstream wants "2026-08-10".
export function fromCompactDate(value) {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}
