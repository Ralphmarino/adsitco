import { checkViewerAuth, json } from "../lib/auth.mjs";
import { getAccessToken } from "../lib/google-auth.mjs";

/**
 * Setup diagnostics for /api/health.
 *
 * Configuring this report means getting seven environment variables and two
 * Google permission grants right at once. When something is wrong the report
 * itself can only say "collection failed", which does not tell you which piece
 * to fix. This checks each one in order and names the first that breaks.
 *
 * It never echoes a secret back — only whether a value is present and whether
 * it is the right shape.
 */

const GA4_SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];
const GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

function checkEnvironment() {
  const checks = [];
  // "required" blocks the report from working at all; "advisory" is a choice
  // worth flagging but not a failure. Mixing the two would report a working
  // setup as broken.
  const add = (name, ok, detail, level = "required") => checks.push({ name, ok, detail, level });

  const email = process.env.GOOGLE_CLIENT_EMAIL?.trim();
  add(
    "GOOGLE_CLIENT_EMAIL",
    Boolean(email && email.includes("@") && email.endsWith(".iam.gserviceaccount.com")),
    !email
      ? "Not set."
      : email.endsWith(".iam.gserviceaccount.com")
        ? `Set (${email}).`
        : "Set, but this is not a service-account address — it should end in .iam.gserviceaccount.com.",
  );

  const key = process.env.GOOGLE_PRIVATE_KEY?.trim() ?? "";
  const hasHeader = key.includes("BEGIN PRIVATE KEY");
  const hasFooter = key.includes("END PRIVATE KEY");
  const hasBreaks = key.includes("\n") || key.includes("\\n");
  add(
    "GOOGLE_PRIVATE_KEY",
    hasHeader && hasFooter && hasBreaks,
    !key
      ? "Not set."
      : !hasHeader || !hasFooter
        ? "Set, but the BEGIN/END PRIVATE KEY lines are missing — the value was truncated on paste."
        : !hasBreaks
          ? "Set, but it contains no line breaks. Paste the key with its \\n escapes intact."
          : `Set (${key.length} characters).`,
  );

  const property = process.env.GA4_PROPERTY_ID?.trim() ?? "";
  add(
    "GA4_PROPERTY_ID",
    /^\d+$/.test(property),
    !property
      ? "Not set."
      : /^G-/i.test(property)
        ? "This is the measurement ID. Use the numeric property ID from Admin → Property Settings."
        : /^\d+$/.test(property)
          ? `Set (${property}).`
          : "Should be digits only.",
  );

  const site = process.env.GSC_SITE_URL?.trim() ?? "";
  const validSite = site.startsWith("sc-domain:") || /^https?:\/\//.test(site);
  add(
    "GSC_SITE_URL",
    validSite,
    !site
      ? "Not set."
      : validSite
        ? `Set (${site}).`
        : "Must be either sc-domain:example.com or a full https:// URL, exactly as Search Console shows it.",
  );

  add(
    "REPORT_PASSWORD",
    Boolean(process.env.REPORT_PASSWORD),
    process.env.REPORT_PASSWORD
      ? "Set — the report is password protected."
      : "Not set. The report is PUBLIC to anyone with the URL.",
    "advisory",
  );

  add(
    "REFRESH_TOKEN",
    Boolean(process.env.REFRESH_TOKEN),
    process.env.REFRESH_TOKEN ? "Set." : "Not set — ?force=1 refreshes are disabled.",
    "advisory",
  );

  add(
    "REPORT_CURRENCY",
    true,
    `Using ${process.env.REPORT_CURRENCY || "USD"} (default USD).`,
    "advisory",
  );

  return checks;
}

async function probeGoogleAuth() {
  try {
    await getAccessToken(GA4_SCOPES);
    return { name: "Google authentication", ok: true, detail: "Service account signed in successfully." };
  } catch (err) {
    return {
      name: "Google authentication",
      ok: false,
      detail: `${err.message} — check the private key, and that both APIs are enabled in Google Cloud.`,
    };
  }
}

async function probeGa4() {
  const property = process.env.GA4_PROPERTY_ID?.replace(/\D/g, "");
  if (!property) return { name: "Analytics access", ok: false, detail: "Skipped — GA4_PROPERTY_ID is not usable." };
  try {
    const token = await getAccessToken(GA4_SCOPES);
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
          metrics: [{ name: "sessions" }],
        }),
      },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body?.error?.message || res.statusText;
      return {
        name: "Analytics access",
        ok: false,
        detail:
          res.status === 403
            ? `${message} — add the service account as a Viewer on the GA4 property.`
            : message,
      };
    }
    const sessions = body?.rows?.[0]?.metricValues?.[0]?.value ?? "0";
    return { name: "Analytics access", ok: true, detail: `Reachable — ${sessions} sessions in the last 7 days.` };
  } catch (err) {
    return { name: "Analytics access", ok: false, detail: err.message };
  }
}

async function probeGsc() {
  const site = process.env.GSC_SITE_URL?.trim();
  if (!site) return { name: "Search Console access", ok: false, detail: "Skipped — GSC_SITE_URL is not set." };
  try {
    const token = await getAccessToken(GSC_SCOPES);
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ startDate: "2020-01-01", endDate: "2020-01-02", rowLimit: 1 }),
      },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body?.error?.message || res.statusText;
      return {
        name: "Search Console access",
        ok: false,
        detail:
          res.status === 403
            ? `${message} — add the service account under Settings → Users and permissions.`
            : res.status === 404
              ? `${message} — GSC_SITE_URL does not match a property on this account. sc-domain:adsitco.com and https://www.adsitco.com/ are different properties.`
              : message,
      };
    }
    return { name: "Search Console access", ok: true, detail: "Reachable." };
  } catch (err) {
    return { name: "Search Console access", ok: false, detail: err.message };
  }
}

export default async (req) => {
  // Same gate as the report. While REPORT_PASSWORD is unset this is open, which
  // is what makes it usable during first-time setup.
  if (!checkViewerAuth(req).ok) {
    return json({ error: "unauthorized", message: "Report password required." }, 401);
  }

  const environment = checkEnvironment();
  const blocked = environment.some((c) => !c.ok && c.name.startsWith("GOOGLE"));

  // Probing Google with a key we already know is malformed just produces a
  // confusing second error, so stop at the first real blocker.
  const probes = blocked
    ? [{ name: "Google connection", ok: false, detail: "Skipped — fix the credential variables above first." }]
    : [await probeGoogleAuth()].concat(
        await Promise.all([probeGa4(), probeGsc()]),
      );

  const blockers = [...environment.filter((c) => c.level === "required"), ...probes].filter((c) => !c.ok);
  const advisories = environment.filter((c) => c.level === "advisory" && !c.ok);
  const ready = probes.every((p) => p.ok);

  return json(
    {
      ready,
      summary: ready
        ? "Everything is connected. Open / to view the report."
        : `${blockers.length} item${blockers.length === 1 ? "" : "s"} to fix — work top to bottom.`,
      nextStep: blockers[0] ? `Start with: ${blockers[0].name} — ${blockers[0].detail}` : null,
      warnings: advisories.map((a) => `${a.name}: ${a.detail}`),
      environment,
      probes,
    },
    ready ? 200 : 503,
  );
};

export const config = { path: "/api/health" };
