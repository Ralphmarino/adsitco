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
| `GA4_PROPERTY_ID` | `315374799` — adsitco.com's numeric property ID (Admin → Property Settings). **Not** the `G-XXXX` measurement ID |
| `GSC_SITE_URL` | Exactly as shown in Search Console: `sc-domain:adsitco.com` or `https://www.adsitco.com/` |
| `REPORT_PASSWORD` | Shared password for viewing the report |
| `REFRESH_TOKEN` | Separate secret that authorises `?force=1` |

Mark `GOOGLE_PRIVATE_KEY`, `REPORT_PASSWORD` and `REFRESH_TOKEN` as **secret** in
Netlify. Every environment variable here is read at request time inside a
function — the build only converts the data files in `data/` into modules and
reads no `process.env` — so making them write-only and runtime-only costs this
project nothing.

Leave `GOOGLE_CLIENT_EMAIL` readable. It identifies the service account rather
than authenticating it, and seeing it in the UI tells you which account is
wired up.

A secret value cannot be read back afterwards, only overwritten. That is what
`/api/health` compensates for: it reports the key's length and whether its
BEGIN/END lines are present without ever echoing the value.

### 4. Deploy

Connect the repo in Netlify and deploy. Build settings come from `netlify.toml`
(publish `public/`, functions in `netlify/functions`), so the defaults are
already correct.

**Environment variables only reach the functions at build time.** If you add or
change one after a deploy, trigger a new deploy — otherwise the running
functions keep the old values and nothing appears to change.

### 5. Check it with `/api/health`

Open `https://<your-site>.netlify.app/api/health`. It checks each variable and
then actually calls both Google APIs, naming the first thing that is wrong:

```json
{
  "ready": false,
  "summary": "1 item to fix — work top to bottom.",
  "nextStep": "Start with: Search Console access — User does not have sufficient permission…",
  "warnings": ["REFRESH_TOKEN: Not set — ?force=1 refreshes are disabled."]
}
```

`"ready": true` means both APIs answered and the report will load. The endpoint
reports whether a value is present and correctly shaped — it never echoes a
secret back. It is behind the same password as the report, so it is open only
while `REPORT_PASSWORD` is still unset, which is what makes it usable during
first-time setup.

First load of the report pulls live data and takes a few seconds; every load
after that is served from cache.

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

**Filters** — country, device and channel, applied by Google's APIs rather than
after the fact, so a filtered view recomputes every number: totals, trends and
tables alike. Each combination is cached separately, so the second visit to a
given view is instant. The query and landing-page tables also have a text search
that filters the loaded rows with no round trip.

**The report opens filtered to the United States.** Change the default with
`REPORT_DEFAULT_COUNTRY` (an ISO alpha-3 code, or `all` for worldwide); viewers
can switch country freely regardless. The nightly job pre-warms whatever the
default is, so the view people actually open is the one that stays warm.

The two APIs disagree on how to name a country — GA4 reports display names and
alpha-2 `countryId`, Search Console uses alpha-3 — so `netlify/lib/countries.mjs`
maps between them and the filter reaches both sources. It covers the ~88 markets
a site realistically sees rather than all ~250 ISO entries; an unmapped country
is left out of the list on purpose, since including it would filter one source
and silently not the other.

Channels are **tick boxes**, not a single choice. "Only Organic Search" and
"everything except Direct" are the same question asked twice — which channels do
you want — so one control answers both. The selection goes to GA4 as an
`inListFilter`, narrowing the data at the source. Unticking everything falls
back to everything, since a report of nothing helps no one and would otherwise
be indistinguishable from "all".

One honest limitation, stated in the UI rather than hidden: **Search Console has
no channel dimension**, so a channel selection narrows the Analytics panels only.
When one is active, the filter bar says the search panels ignore it. Country and
device filtering apply to both sources.

**Date range** — 7 / 28 / 90 day presets, or **Custom** for any start and end
you type. Custom ranges are capped at 365 days, because the daily history has to
reach a year further back for year-over-year and a 365-day window already pulls
~730 rows against the API's 1000-row page.

**Comparison** — every figure compares against one of:

| Basis | Window |
| --- | --- |
| Previous period | The equally long stretch immediately before the current one |
| Previous year | The same calendar dates a year earlier |
| No comparison | Deltas and comparison lines hidden |

Both bases are computed from daily rows already in the snapshot, so **switching
basis re-renders instantly with no API call**. Only changing the date range
refetches, because the dimension tables are windowed server-side.

Each comparison window is defined by its start plus the current window's length,
never by a shifted end date — so it is exactly as many days as the current
period even across a leap year, and the two series stay aligned on the charts.
Note that year-over-year lands on different weekdays; on a site with a strong
weekday rhythm, compare like-for-like weeks before drawing conclusions from a
short window.

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

## Sales tab

The report has four tabs: **Search & analytics** (GA4 + Search Console),
**Sales** (this one, which reads the workbook in `data/`), **Differential** and
**Blog tracker**.

### Where the file goes

`data/` in the repository root — **not `public/`**. Anything under `public/` is
served to anyone with the URL and would bypass the password gate; sales figures
belong behind the same gate as everything else. A build step reads the file and
generates a module the functions import, so the file itself is never served.

### The workbook

The live source is the `.xlsx` export, tabs broken out by month
(`data/[Final]Ebay & Phone Sales Report - Adsitco.xlsx`). The build reads **every
sheet** and takes its dates from the `Date` column rather than the tab name, so
inconsistent naming — `Oct (26)`, `December(25)`, a bare `September` meaning
2023 — does not matter.

Columns it reads, as the export names them:

| Column | Used as |
| --- | --- |
| `Date` | the day |
| `Web - Number of orders` / `Web - Gross sales amount` | Web orders and revenue |
| `eBay Orders` / `eBay Sales` | eBay orders and revenue |
| `Phone Call Quantity Sold` / `Phone Call Sales` | Call orders and revenue |
| `Phone Calls` | inbound call volume — shown separately, since it is calls received, not orders |

**Over half the dates appear in more than one sheet**: the `2024 Total` and
`2025 Total` sheets restate the monthly tabs. Summing every sheet would come
close to doubling three years of revenue, so each date is taken once, preferring
the monthly tabs. Where a duplicate disagrees, the build prints a warning rather
than silently picking one — quietly choosing between two different numbers is
how a report ends up wrong without anyone noticing.

Also skipped, deliberately: the `report-last_month-*` sheets, which are web-only
exports with a different schema whose months are already covered in full by the
monthly tabs, and the `2026 Total` / `2025 Total` footer rows at the bottom of
each tab, which would double-count.

To add a month: add the tab, commit the workbook, push. Run
`node scripts/build-sales.mjs` locally first — it prints the row count, date
range, channels, total revenue and any warnings.

Reading `.xlsx` needs no dependency; `scripts/lib/xlsx.mjs` is a small ZIP and
XML reader covering exactly what this file uses.

### CSV instead

A flat `data/sales.csv` is also accepted and takes precedence if present:

```csv
date,channel,orders,revenue
2026-09-01,web,18,4820.50
2026-09-01,call,7,3140.00
2026-09-01,ebay,4,610.25
```

`data/sales.example.csv` is a copy to start from. Column names, `M/D/YYYY`
dates, `"$4,820.50"`, parenthesised negatives, CRLF and a BOM are all handled.

### What it shows

**The Sales tab works in months, not days.** The workbook is kept a month per
tab, a sales review is asked a month at a time, and the analytics tab's rolling
28-day window straddles month boundaries — which is how the default view ended
up mixing a complete September with an empty half of October. So this tab has
its own control: a first and last month, with quick picks for the last month,
three months, twelve months and year to date. It opens on the **last twelve
complete months**.

The day-range control and the country, device and channel filters are hidden
here rather than left inert: neither reaches this data.

The comparison control is shared. On this tab "previous period" means the same
number of months immediately before, and "previous year" the same months a year
earlier.

Total sales leads, then orders, average order value, inbound phone calls, the
share of those calls that became an order, the monthly average, and revenue per
channel. Then:

- **Revenue over time** — monthly columns for a span of three months or more,
  daily lines for one or two. A quarter read day by day is noise; a single month
  read month by month is a single column.
- **Each channel over time** — one small chart per channel on the same
  granularity. Call revenue runs an order of magnitude above Web and eBay, so on
  a shared axis the two smaller channels flatten into the baseline.
- **Revenue by channel** with each one's share.

Only complete months are selectable. A month still in progress would read as a
slump rather than as a month that has not finished, and the tab says when the
workbook stops.

### How it loads

Sales comes from `/api/sales`, separate from the analytics report and fetched
once the first time the tab is opened. It is local data with no API quota, so
the whole history ships at once and every change of month, span or comparison
after that is instant — no round trip. Keeping it out of the analytics snapshot
also keeps three years of sales from being copied into every cached range and
filter combination.

## Differential tab

Per-URL movement in Search Console, on two comparisons:

- **Last 6 months vs the previous 6** — the default, matching the Diff. Analysis
  sheet this replaces.
- **Month over month** — the latest complete month against the one before.

Site-wide totals come from their own dimensionless queries so they are exact
rather than a sum of page rows. Six months against six needs no monthly
breakdown, so the whole thing is six Search Console queries rather than one per
month, cached for a day and warmed by the nightly job.

**Biggest movers** is a diverging chart: gains right of the axis, losses left. A
gain and a loss of the same size are opposite outcomes, so the side of the axis
carries the direction, the colour reinforces it, and the label spells out the
sign. Every delta in the table is signed for the same reason — red and green
alone do not survive a colourblind reader or a printout.

The table is sortable on every column and filterable by URL. It lists the URLs
that moved most on either comparison; **the site has ~38,000 URLs**, which is a
spreadsheet rather than a table anyone reads, so *Download all URLs (CSV)* exports
every one in the same shape as the original sheet.

Position deltas are signed so that **positive always means better** — a page
moving from 8.5 to 5.1 reads as `+3.4`, not `−3.4`.

Two things this does not have, deliberately: **AI/generative impressions**,
because the original export took them from the Search Console UI and I could not
verify the API exposes them — tell me the dimension and they go in; and the
country, device and channel filters, which apply to the Analytics tab only.
Differential figures are site-wide, matching the reference sheet.

## Blog tracker tab

Every SEO post on the blog, with when it was published, when it last changed,
how it is performing, what the audit decided, whether it conforms to the
current post format, and what to refresh next.

This tab implements `spec-blog-tracker.md` and `spec-blog-audit-criteria.md`
inside the existing report rather than as the separate Python + GitHub Actions
repo those specs sketch. The specs' data model, computed fields and guardrails
are followed as written; the hosting, scheduling and access decisions left open
in the tracker spec's section 13 are already answered here — Netlify, a nightly
scheduled function, and the report's own password gate.

### Where every field comes from

```
WordPress REST API ──┐  id, slug, title, published, modified, categories, tags
  /wp-json/wp/v2     │  (+ rendered content, nightly, for conformance)
                     │
post-sitemap.xml ────┤   lastmod per URL — fallback
the posts' own HTML ─┤   both dates — last-resort fallback
                     │
data/blog-dates.csv ─┤   dates entered by hand — outranks all of the above
audit/audit-records ─┤   verdicts, voice, cluster, last_substantive_update
data/manual/*.csv ───┤   backlinks, tracked keywords (quarterly exports)
                     ├──▶ netlify/lib/blog.mjs ──▶ blog-state (Netlify Blobs)
Search Console ──────┘    merge + compute              per-URL history
  6mo vs 6mo, and 90d vs prior 90d vs the same 90d last year
```

### Keeping the dates current, automatically

A tracker whose "last updated" column is itself out of date is worse than no
tracker, so this part runs without anyone maintaining it.

1. **WordPress is the source of truth.** `/wp-json/wp/v2/posts` returns `date`
   and `modified` and takes a list of slugs, so the tracker asks for exactly
   the posts it tracks: ~110 posts in three requests, both dates. Override the
   endpoint with `BLOG_WP_API_ROOT`.
2. **The sitemap and the posts' own pages are fallbacks.** If the REST route is
   disabled, `lastmod` still gives a modified date; failing that, each post's
   HTML is read for `article:published_time` and `article:modified_time`. That
   last one is a request per post, so a page load does at most 8 and the
   nightly job 25, cached once found.
3. **Nothing is guessed at.** Precedence is `manual > WordPress > sitemap >
   scraped > stored`, and **every date cell's tooltip names its source**, so
   "entered by hand" and "left over from an earlier run" are distinguishable
   from each other and from "not known".
4. **The nightly job diffs against stored state.** A modified date that moves
   is recorded as an **observed update** with the date it was seen, so the tab
   shows a post's edit history rather than a number that silently changes. A
   post the site knows about and the curated list does not is flagged **New**,
   and once found it stays tracked even if a later run cannot reach the site.

**Two dates, deliberately.** The spec is explicit that WordPress `modified`
moves on any save — a typo fix reads as a refresh — so it cannot stand in for
the date of the last real revision. `last_substantive_update` in
`audit/audit-records.csv` is that date, entered by hand. Where a post has one
it wins, the refresh rules use it, and the cell says **substantive**; otherwise
the cell says **last save** and the tooltip spells out why that is weaker
evidence.

### If the site refuses the request

It did on the first deploy: every request to adsitco.com came back `403`,
almost certainly a firewall or bot filter. The tab now handles that as a
condition it describes rather than an error:

- Requests are shaped like an ordinary browser's, with one retry on the
  statuses a filter returns. **`BLOG_FETCH_USER_AGENT`** overrides the string
  if the host allowlists a specific one.
- `robots.txt` is read for the sitemap address before any path is guessed at,
  then the usual paths are tried in turn — `/post-sitemap.xml` is a Yoast
  convention and WordPress core publishes `/wp-sitemap.xml`.
- **Check connection**, in the tab, names every address tried and what each
  returned — a firewall rule, a disabled REST route and a renamed sitemap are
  told apart in one look. It calls `/api/blog?diagnose=1`, which reads no
  cached state and so answers while collection is failing. There is a button
  for it because that endpoint sits behind the report password and cannot be
  opened in the address bar.
- The tab keeps the last known dates, says plainly that the site refused, and
  carries the fix. The nightly job logs a refused run as a failure rather than
  a success.
- `data/blog-dates.csv` fills dates in by hand regardless, so the column is
  never blocked on the site answering.

### Which URLs are tracked

The blog holds a few hundred written posts and several thousand generated ones.
Only the written ones are tracked. Precedence, most specific first:

1. An explicit entry in **`data/blog-exclude.txt`** is never tracked. One URL
   per line, `#` for comments — this is where to put a one-off that no pattern
   catches.
2. Anything matching a pattern in **`netlify/lib/blog-rules.mjs`** is not
   tracked: generated model lists, per-model transmission lists,
   engine-parts-for-sale stubs, per-year rim lists, year-and-model stubs and
   bare numeric stubs.
3. Everything else — the curated CSV and the sitemap — is tracked.

**Keyword matching cannot do this job.** "transmissions", "engine-parts" and
"rims" all appear in real posts (`mercedes-benz-transmissions-over-the-years`,
`mercedes-engine-parts-guide`, `how-to-clean-mercedes-rims-and-wheels`), so the
patterns anchor on the *shape* a generated URL takes — a list prefix, a
transmissions suffix, a year-and-model stem — rather than on a word appearing
anywhere. Against the exclusion list supplied for this build they catch 28 of
28 sample URLs while keeping every real post.

A pattern outranks the curated list deliberately: one generated URL
(`450-sl-rebuilt-mercedes-transmissions-sale`) is in both, and the build
**names every curated URL a pattern removed**, so a wrong call shows up in the
build log instead of a post quietly vanishing from the report.

```
$ node scripts/build-blog-tracker.mjs
108 curated post(s), 1 with a published date, 1 explicit exclusion(s),
1 removed by pattern
```

### Health status

The spec's rules, first match wins, with every threshold read from
`data/blog-config.json`:

| Status | Rule |
| --- | --- |
| `removed` | A `REMOVE` verdict that has been executed, or absorbed by a `MERGE` |
| `new` | Published or substantively updated inside 90 days |
| `declining` | Clicks down more than 30% vs the prior 90 days **and** vs the same 90 days last year |
| `striking-distance` | Average position 8–20 with at least 100 impressions |
| `strong` | Average position 10 or better with at least 30 clicks |
| `stable` | At least 200 impressions, none of the above |
| `weak` | Fewer than 200 impressions |
| `unknown` | No Search Console rows at all |

**Both comparisons have to agree before a post is called declining.** On a site
selling convertible parts, clicks down 40% on the previous quarter could be
decay or it could be October; down 40% on the previous quarter *and* on the same
quarter last year is decay. That year-ago window is the reason this tab runs its
own three Search Console queries rather than reusing the Differential tab's.

`unknown` exists because "no data" is not the same judgement as `weak`. A post
with no rows has not been measured; calling it weak would be inventing a
finding.

Two departures from the spec, both deliberate: `removed` is checked **before**
`new`, because a post whose 301 went in last week is not a new post; and
`unknown` is added for the no-data case.

### The flagging system

Six flags, each answering a different question:

| Flag | Question |
| --- | --- |
| **Days since update** + freshness band | How long has this sat? Fresh ≤ 6 months, Aging ≤ 1 year, Stale ≤ 2 years, Very stale beyond |
| **Health** | Is the post working? |
| **Due a refresh** | Does the spec's own rule say to rewrite it? |
| **Refresh priority** | Within the queue, where to start |
| **Vetoes** | Is there a reason a `REMOVE` cannot be finalised? |
| **New** | Did it appear since the last run? |

**Due a refresh** is the spec's rule: the last substantive update is older than
six months **and** health is `strong`, `striking-distance` or `declining`. The
health condition is the point — a post nobody finds does not become worth
rewriting by getting older, and the queue should not fill with pages that have
nothing to protect.

**Refresh priority** orders that queue; it is not a verdict, and the UI says so.
The score is the clicks a post still earns, weighted up by how long since it was
touched (up to 3×) and by how fast it is losing ground (up to 3×), with a 1.5×
lift for striking-distance posts because they are the cheapest wins on the site:

```
score = clicks × min(1 + days/365, 3) × (1 + min(declinePct, 1) × 2) × opportunity
```

Each row carries the reason in words ("Clicks down 34%", "Not updated in 19
months", "Within reach of page one") rather than only a number, so the list
hands off to a writer as a work queue.

The freshness bands are wide on purpose and the exact day count sits next to the
label: a post is not stale at a fixed age, and the band sorts attention rather
than making the call.

### The audit layer

`audit/audit-records.csv` is the audit spec's output contract, read verbatim —
`post_id`, `slug`, `batch`, `cluster`, `verdict`, `confidence`, `audit_status`,
`image_style`, `voice_issues`, `last_substantive_update` and the rest. **The
tracker reads it and never writes it**: verdicts come from the audit process,
which is a guardrail in the spec and the reason verdict sits in its own column
away from the computed priority.

Records join on slug at build time (`post_id` needs WordPress, which is a
runtime source) and the WordPress id is carried through for the runtime join.
A record matching no tracked post is reported in the build log rather than
silently dropped.

`audit/gaps.csv` takes the gap log. `data/manual/backlinks.csv` and
`data/manual/keywords.csv` take the quarterly exports that have no API — they
drive the spec's two vetoes, shown on each row so a backlink hold or a
consultant review is visible *before* anyone proposes a removal.

Both the verdict column and the verdict filter stay hidden until at least one
record exists. A column of "Not audited" and a filter with one option are
controls that do nothing.

### Format conformance

Read from the posts themselves on the nightly run, since it means fetching
every article:

- **`format_conforms`** — carries H2s containing *Relevant Chassis* and *Top
  Takeaways*. Matched case-insensitively on the heading text, so "Relevant
  Chassis and Years" counts; failing a post on its capitalisation would make
  the column noise.
- **`has_faqs`** — a heading matching the configured FAQ pattern.
- **`internal_links_out`**, split out by **money links** — links to a product or
  category path. `[VERIFY]` those path patterns in `data/blog-config.json`;
  anything unmatched counts as a plain internal link.
- **`internal_links_in`** — counted from the other posts' outbound links, so
  **orphans** (safe to cut) are distinguishable from **hubs** (not safe), which
  is the spec's cluster-role check.

The conformance panel hides itself until the nightly job has run. A row of
"0 of 0" tiles would read as every post failing.

### Thresholds

`data/blog-config.json` holds every threshold, the FAQ pattern, the money-page
paths and the required headings, so they can be tuned without a code change —
the spec's guardrail, and the starting values are its placeholders. It is JSON
rather than the spec's `config.yml` because parsing YAML would mean adding a
dependency to a project that has one; every value the spec names is there under
the same name. Built-in defaults exist only so a missing or malformed file
cannot take the tab down.

### Views and export

Six views — **Refresh priority**, **Refresh due**, **Striking distance**,
**Oldest first**, **Losing clicks**, **New posts** — plus chip filters for
health and verdict, which narrow independently because one is computed from
Search Console and the other is a human decision.

*Download all fields (CSV)* exports every field under the audit record's own
column names, so it round-trips into the spreadsheet work the audit runs on.
The download is **fetched with the report password and handed to the browser as
a blob** rather than being a plain link: a bare `<a download>` cannot send a
header, so once `REPORT_PASSWORD` was set the old Differential CSV link saved a
401 response body as a `.csv`. Both links now go through the same path.

The country, device and channel filters are hidden here: the tracker is
site-wide, matching the Differential tab.

### How it loads

`/api/blog`, cached for 12 hours and warmed by the nightly job, which is also
the run that reads post content for conformance. Everything else is computed on
the fly from one payload, so every view, filter and sort is instant.

The payload carries a **schema version**, and a cached snapshot that does not
match it is recollected rather than served. Netlify Blobs outlive a deploy, so
without this a deploy that adds a field renders the old snapshot through the
new page and every new field reads as a zero — which is exactly what the audit
columns did on their first deploy: *Due a refresh 0*, *Audited 0/108*, an empty
health chart, all from a snapshot collected before those fields existed. Bump
`BLOG_SCHEMA` in `netlify/lib/blog.mjs` when the payload shape changes and the
next page load fixes itself.

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
netlify/functions/sales.mjs     /api/sales — the workbook, read at build time
netlify/functions/differential.mjs  /api/differential — per-URL movement, + CSV
netlify/functions/blog.mjs      /api/blog — the blog tracker, + CSV, + diagnose
netlify/lib/blog.mjs            merge every source, assemble the rows
netlify/lib/blog-health.mjs     the audit spec's health, refresh and conformance rules
netlify/lib/blog-rules.mjs      which URLs are SEO posts and which are generated
netlify/lib/wp-api.mjs          WordPress REST — dates, taxonomy, content
netlify/lib/sitemap.mjs         sitemap discovery, and dates scraped from a post
netlify/lib/site-fetch.mjs      the one place that talks to adsitco.com
scripts/build-sales.mjs         data/*.xlsx → a module the functions import
scripts/build-blog-tracker.mjs  data/ + audit/ → the curated seed and thresholds
public/                         the dashboard (no third-party scripts)

data/blog-tracker-urls.csv      the curated post list
data/blog-exclude.txt           URLs never to track
data/blog-dates.csv             dates entered by hand — highest precedence
data/blog-config.json           every threshold the health rules use
data/manual/backlinks.csv       quarterly export — the backlink veto
data/manual/keywords.csv        quarterly export — the tracked-keyword veto
audit/audit-records.csv         the audit spec's output contract (read-only here)
audit/gaps.csv                  the gap log
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

`/api/health` diagnoses all of these directly — check it before reading the
table above.

Scheduled-run output is under **Netlify → Logs → Functions → refresh**; each run
logs a JSON line with per-window row counts and any warnings.
