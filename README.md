# adsitco.com — GA4 + Search Console report

A self-hosted replacement for a Looker Studio (Data Studio) report. A Netlify
site serves a static dashboard; a scheduled Netlify function pulls fresh numbers
from the Google Analytics Data API and the Search Console API once a day and
caches them, so page loads never wait on Google.

---

## How the data keeps flowing

This is the part that matters, so it comes first.

```
                    ┌──────────────────────────────────────────┐
                    │  Google                                  │
                    │   • GA4 Data API                         │
                    │   • Search Console API                   │
                    └───────────────┬──────────────────────────┘
                                    │  service-account JWT → access token
                                    │  (no human login, never expires)
                    ┌───────────────▼──────────────────────────┐
   cron, 06:15 UTC  │  netlify/functions/refresh.mjs           │
   every day  ─────▶│  pulls 7 / 28 / 90-day snapshots         │
                    └───────────────┬──────────────────────────┘
                                    │  writes JSON
                    ┌───────────────▼──────────────────────────┐
                    │  Netlify Blobs (cache)                   │
                    └───────────────┬──────────────────────────┘
                                    │  reads
                    ┌───────────────▼──────────────────────────┐
   browser  ───────▶│  /api/report  →  public/index.html       │
                    └──────────────────────────────────────────┘
```

Three things keep it current, and each one covers the others' failures:

1. **The daily cron.** `refresh.mjs` declares `schedule: "15 6 * * *"`. Netlify
   reads that at deploy time and runs the function every morning — nothing to
   configure in the UI, and it keeps running whether or not anyone visits.
2. **Lazy refresh on read.** If a snapshot is older than 12 hours when someone
   opens the report — cron skipped, a window nobody had viewed yet, a failed run
   — `/api/report` fetches fresh data on that request and caches the result.
3. **Stale-on-error fallback.** If Google is unreachable, the last good snapshot
   is served with a warning banner instead of an error page. A single source
   failing (say Search Console) still renders every panel that did load.

The credential is a **service account**, not your Google login. It has no
password, no MFA prompt and no expiry, so the pipeline does not break when you
change your own password. That is the usual reason a homegrown dashboard goes
dark, and it is designed out here.

**To change the schedule**, edit the cron in the `config` export at the bottom of
`netlify/functions/refresh.mjs` and redeploy. **To force a refresh right now:**

```bash
curl -H "x-report-password: $REPORT_PASSWORD" \
     -H "x-refresh-token: $REFRESH_TOKEN" \
     "https://<your-site>.netlify.app/api/report?days=28&force=1"
```

---

## Does this have to go through GitHub?

No — but it should, and you already have the repo.

Netlify can take a site three ways: a drag-and-dropped folder, the `netlify`
CLI, or a connected Git repository. **Scheduled functions only survive as part
of a real deploy**, and the Git route is the one that redeploys on every commit,
keeps deploy previews, and lets you roll back. Drag-and-drop means re-uploading
by hand every time you change a metric.

So: push this repo to GitHub, connect it once in Netlify, and from then on
editing a file and committing is the whole deployment process.

---

## Setup

### 1. Create the Google service account

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or
   pick) a project.
2. Enable both APIs: **Google Analytics Data API** and **Google Search Console
   API**.
3. **IAM & Admin → Service Accounts → Create service account.** No roles are
   needed at the project level — access is granted per product below.
4. On the new account: **Keys → Add key → Create new key → JSON**. Download it.

The JSON file has the two values you need: `client_email` and `private_key`.

### 2. Grant that account access to your data

Both of these use the service account's email address
(`something@your-project.iam.gserviceaccount.com`):

- **GA4** — Admin → Property access management → add the email with the
  **Viewer** role.
- **Search Console** — Settings → Users and permissions → add the email with
  **Full** or **Restricted** access.

Search Console can take a few minutes to honour a new user.

### 3. Set environment variables in Netlify

Site configuration → Environment variables. See `.env.example` for the full list
with notes; the required ones are:

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_EMAIL` | `client_email` from the JSON key |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON key, `\n` escapes intact |
| `GA4_PROPERTY_ID` | Numeric property ID (Admin → Property Settings) — **not** the `G-XXXX` measurement ID |
| `GSC_SITE_URL` | Exactly as shown in Search Console: `sc-domain:adsitco.com` or `https://www.adsitco.com/` |
| `REPORT_PASSWORD` | Shared password for viewing the report |
| `REFRESH_TOKEN` | Separate secret that authorises `?force=1` |

### 4. Deploy

Connect the repo in Netlify and deploy. Build settings come from `netlify.toml`
(publish `public/`, functions in `netlify/functions`), so the defaults are
already correct.

First load pulls live data and may take a few seconds; every load after that is
served from cache.

---

## Local development

```bash
npm install
cp .env.example .env      # fill in real values
npx netlify dev
```

`netlify dev` serves `public/` and runs the functions with `.env` loaded. Netlify
Blobs is unavailable outside a deploy context, so locally the cache falls back to
process memory — it works, it just resets when you restart.

---

## What's in the report

**Google Analytics** — sessions (the headline number), active users, new users,
page views, engagement rate, engaged time per user, key events. Sessions and
users over time; sessions by channel; top pages, sources, countries, devices.

**Revenue** — revenue, orders, average order value and revenue per session, plus
revenue over time and a revenue column on the channel, source and page tables.
These use GA4's `totalRevenue`, which covers purchase, subscription and ad
revenue, so it reports sales on an ecommerce property without going blank on one
that books money another way. Set `REPORT_CURRENCY` to match the property.
**The revenue panels hide themselves** when the property reports no revenue —
a row of `$0` tiles in a client presentation reads as a broken report.

**Search Console** — clicks, impressions, average CTR, average position. Each
plotted over time, plus top queries and top landing pages.

**Filters** — device and channel, applied by Google's APIs rather than after the
fact, so a filtered view recomputes every number: totals, trends and tables
alike. Each filter combination is cached separately, so the second visit to a
given view is instant. The query and landing-page tables also have a text search
that filters the loaded rows with no round trip.

One honest limitation, stated in the UI rather than hidden: **Search Console has
no channel dimension**, so a channel selection narrows the Analytics panels only.
When one is active, the filter bar says the search panels ignore it. Device
filtering applies to both sources.

Every stat compares against the immediately preceding period of the same length.
Every chart has a **Table** toggle, and the page follows your system light/dark
setting with a manual override.

### Two things worth knowing about the numbers

- **The two sources cover slightly different dates.** GA4 is complete through
  yesterday; Search Console runs about three days behind. Rather than truncating
  GA4 to match, each source is anchored to its own last complete day, and both
  ranges are printed in the header.
- **The date toggle refetches.** Switching 7/28/90 changes the tiles and charts
  instantly (they are recomputed from one stored daily series) and refetches the
  dimension tables, which are windowed server-side. Each window is cached
  separately and pre-warmed by the nightly job.

Rates are rebuilt from their components rather than averaged — engagement rate
sums engaged sessions and sessions before dividing, and average position is
weighted by impressions — so a 90-day figure is not a misleading average of
90 daily averages.

---

## Demo mode

`/?demo=1` renders the report from `public/sample-data.json` so the layout can be
reviewed before the Google credentials are in place. A loud banner marks it, and
the filter controls are disabled because filters execute server-side.

**A live-data failure never falls back to this.** It shows the error and an
explicit link instead — modelled numbers must never appear under the same
headings mid-presentation.

Provenance, split precisely:

| Real | Modelled |
| --- | --- |
| Query strings, their ranking positions and search volumes | Impressions, clicks, CTR |
| Page URLs and their relative traffic weights | Sessions, users, page views, engagement |
| — | Revenue, orders, channel mix, geography, device split |

The real half comes from **Ahrefs Site Explorer** for adsitco.com (1,088 organic
keywords, ~4,249 monthly organic visits). Impressions are derived from search
volume, clicks from a position-based click-through curve, and sessions are
anchored so organic lands near the Ahrefs estimate — which keeps the panels
reconciling with each other instead of contradicting themselves.

Nothing in it comes from Google Analytics or Search Console. Those require the
service account; once it is configured the report reads them live and this file
is no longer used. Regenerate with `node scripts/make-sample-data.mjs`.

## Branding

The report carries adsitco's chrome: the thin orange rule over a charcoal
masthead, the logo, and the orange keyline on section headings — the same
structure as adsitco.com. The masthead stays charcoal in both themes, because
the supplied logo is a white mark and needs a dark ground either way.

| Token | Value | Where it came from |
| --- | --- | --- |
| `--brand-orange` | `#ff5a3b` | Sampled from the dot in the logo file |
| `--brand-orange-deep` | `#d9411f` | Darker step for button fills — carries white text at 4.44:1 |
| `--brand-green` | `#76b82a` | The site's CTA green |
| `--brand-charcoal` | `#3a423f` | Masthead — white text at 10.34:1 |

### Why the charts are not orange-and-green

The obvious move is to plot series in the site's two accents. **Orange `#ff5a3b`
against green `#76b82a` measures a deuteranopia ΔE of 1.5** — to a red-green
colourblind reader, roughly 1 in 12 men, they are the same colour. Any two-series
chart drawn in them is unreadable.

So the brand orange leads as series 1, and series 2 is blue rather than the brand
green. That keeps adsitco's primary colour on the most important line while
staying legible to everyone. The green survives as an accent — positive deltas
use a brand-tinted green (`#4a7318`, 5.45:1 as text) rather than the CTA green,
which is far too light to read as text.

Dark mode uses `#f0603c` for series 1: the brand orange is too light for the dark
lightness band, so it is stepped down rather than reused unchanged.

Every palette here was checked with the validator in the `dataviz` skill rather
than judged by eye. If you change a colour, re-run it:

```
node scripts/validate_palette.js "#ff5a3b,#2a78d6,#1baf7a" --mode light
```

## Layout

```
netlify/functions/report.mjs    /api/report — auth, cache, stale-while-error
netlify/functions/refresh.mjs   scheduled daily pull
netlify/lib/google-auth.mjs     service-account JWT → access token
netlify/lib/ga4.mjs             Analytics Data API queries
netlify/lib/gsc.mjs             Search Console API queries
netlify/lib/collect.mjs         one snapshot, both sources, partial-failure tolerant
netlify/lib/store.mjs           Netlify Blobs cache
public/                         the dashboard (no third-party scripts)
```

The front end loads no external script, font or stylesheet — nothing outside
Netlify ever sees your analytics.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `403 User does not have sufficient permissions` | Service account not added to the GA4 property or the Search Console property |
| `Missing required environment variable` | Variable not set in Netlify, or set on the wrong deploy context |
| `GOOGLE_PRIVATE_KEY could not be used to sign` | Key truncated on paste — it must include the `BEGIN`/`END` lines |
| Search Console panels empty, Analytics fine | `GSC_SITE_URL` does not exactly match the property in Search Console (`sc-domain:` vs `https://`) |
| Report loads but every number is zero | Wrong `GA4_PROPERTY_ID` — check it is the numeric ID, not `G-XXXX` |

Scheduled-run output is under **Netlify → Logs → Functions → refresh**; each run
logs a JSON line with per-window row counts and any warnings.
