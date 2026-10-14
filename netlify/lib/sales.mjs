import { SALES_ROWS, SALES_META } from "./sales-data.mjs";

/**
 * Sales from data/sales.csv, shaped like the Analytics and Search series so the
 * front end can slice, compare and chart it with the same helpers.
 *
 * Each day becomes one flat row with a total plus per-channel fields
 * (`rev_web`, `ord_call`, …). Flat numeric keys are what the existing densify
 * and sum helpers already understand, so the date range and the
 * period-over-period / year-over-year bases work here for free.
 */
export function collectSales({ start, end }) {
  const channels = SALES_META.channels ?? [];

  const byDate = new Map();
  for (const row of SALES_ROWS) {
    if (row.date < start || row.date > end) continue;
    let day = byDate.get(row.date);
    if (!day) {
      day = { date: row.date, revenue: 0, orders: 0 };
      for (const c of channels) {
        day[`rev_${c.id}`] = 0;
        day[`ord_${c.id}`] = 0;
      }
      byDate.set(row.date, day);
    }
    day.revenue += row.revenue;
    day.orders += row.orders;
    day[`rev_${row.channel}`] = (day[`rev_${row.channel}`] ?? 0) + row.revenue;
    day[`ord_${row.channel}`] = (day[`ord_${row.channel}`] ?? 0) + row.orders;
  }

  const daily = [...byDate.values()]
    .map((d) => ({ ...d, revenue: Number(d.revenue.toFixed(2)) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    present: Boolean(SALES_META.present && SALES_ROWS.length),
    channels,
    daily,
    // What the file actually covers, so a range reaching past it can say so
    // rather than drawing the shortfall as a collapse to zero.
    coverage: { start: SALES_META.firstDate ?? null, end: SALES_META.lastDate ?? null },
    hasOrders: SALES_ROWS.some((r) => r.orders > 0),
    warnings: SALES_META.warnings ?? [],
    builtAt: SALES_META.builtAt ?? null,
  };
}
