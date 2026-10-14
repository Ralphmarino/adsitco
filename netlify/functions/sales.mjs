import { checkViewerAuth, json } from "../lib/auth.mjs";
import { collectSales } from "../lib/sales.mjs";

/**
 * The whole sales history in one response.
 *
 * Sales comes from a committed workbook rather than an API, so there is no
 * quota to spend and no reason to window it server-side. Shipping every day at
 * once lets the Sales tab change month, span and comparison basis with no
 * further round trips — and keeps this out of the analytics snapshot, which is
 * cached per range and per filter combination and would otherwise carry a copy
 * of three years of sales in every one of them.
 */
export default async (req) => {
  if (!checkViewerAuth(req).ok) {
    return json({ error: "unauthorized", message: "Report password required." }, 401);
  }

  const sales = collectSales({ start: "1970-01-01", end: "2999-12-31" });

  return json(sales, 200, {
    // Local data that only changes on deploy, so a browser may hold it briefly.
    "cache-control": "private, max-age=300",
  });
};

export const config = { path: "/api/sales" };
