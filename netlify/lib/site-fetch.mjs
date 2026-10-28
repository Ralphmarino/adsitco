/**
 * The one place that talks to adsitco.com.
 *
 * Everything the blog tracker knows about dates comes from the live site, so
 * when the site refuses the request the whole tab goes blank — which is
 * exactly what happened on the first deploy: a WAF answered 403 to a request
 * carrying a bot-shaped user agent, and the tracker reported "no dates"
 * without being able to say why.
 *
 * Two things follow from that:
 *
 *   1. Requests are shaped like an ordinary browser's. This is the site's own
 *      report reading the site's own pages, and a default client user agent is
 *      what every HTTP library sends; the previous one was unusual enough to
 *      trip a filter. `BLOG_FETCH_USER_AGENT` overrides it, which is the knob
 *      to reach for if the host allowlists a specific string.
 *   2. Failures carry their status code and are reported, not swallowed. A 403
 *      is a different problem from a 404 and needs a different fix, so the
 *      distinction survives all the way to the UI.
 */

const DEFAULT_TIMEOUT_MS = 15000;

// A current desktop Chrome string. Overridable because the correct value is
// whatever the site's host is willing to answer.
const DEFAULT_USER_AGENT =
  process.env.BLOG_FETCH_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Tried once if the first attempt is refused. Some filters block on a missing
// or unfamiliar UA and let a plain identified client through, so the fallback
// is honest rather than another impersonation.
const FALLBACK_USER_AGENT =
  process.env.BLOG_FETCH_USER_AGENT_FALLBACK || "adsitco-report/1.0 (+https://adsitco.netlify.app)";

const RETRYABLE = new Set([403, 406, 408, 429, 500, 502, 503, 504]);

export class SiteFetchError extends Error {
  constructor(url, status, statusText, { attempts = 1 } = {}) {
    const detail = status ? `${status} ${statusText || ""}`.trim() : statusText || "request failed";
    super(detail);
    this.name = "SiteFetchError";
    this.url = url;
    this.status = status ?? null;
    this.attempts = attempts;
  }

  /** Plain-language cause, so the UI does not have to interpret status codes. */
  get hint() {
    if (this.status === 403)
      return "The site refused the request. A firewall or bot filter is blocking it — allow the Netlify function's requests, or set BLOG_FETCH_USER_AGENT to a string the host permits.";
    if (this.status === 404) return "Not found at this address.";
    if (this.status === 429) return "Rate limited by the site.";
    if (this.status && this.status >= 500) return "The site returned a server error.";
    return "Could not reach the site.";
  }
}

/**
 * GET a URL as text. Retries once, with a different user agent, on the
 * statuses a bot filter actually returns — one retry, because the point is to
 * get past a filter, not to batter a site that means it.
 */
export async function fetchText(url, { timeout = DEFAULT_TIMEOUT_MS, accept } = {}) {
  let last = null;

  for (const [index, agent] of [DEFAULT_USER_AGENT, FALLBACK_USER_AGENT].entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": agent,
          accept: accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
        },
      });
      if (res.ok) return { text: await res.text(), status: res.status, headers: res.headers };
      last = new SiteFetchError(url, res.status, res.statusText, { attempts: index + 1 });
      if (!RETRYABLE.has(res.status)) throw last;
    } catch (err) {
      if (err instanceof SiteFetchError) {
        if (!RETRYABLE.has(err.status)) throw err;
        last = err;
      } else {
        last = new SiteFetchError(url, null, err.name === "AbortError" ? "timed out" : err.message, {
          attempts: index + 1,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw last;
}

/** As above, parsed as JSON. */
export async function fetchJson(url, options = {}) {
  const res = await fetchText(url, { accept: "application/json, */*;q=0.8", ...options });
  try {
    return { data: JSON.parse(res.text), headers: res.headers };
  } catch {
    // An HTML error page served with a 200 is a real thing, and parsing it as
    // JSON throws something unhelpful about token '<'.
    throw new SiteFetchError(url, res.status, "response was not JSON");
  }
}

/** What a failed attempt looks like in a diagnostic report. */
export function describeFailure(err) {
  if (err instanceof SiteFetchError) {
    return { status: err.status, error: err.message, hint: err.hint, attempts: err.attempts };
  }
  return { status: null, error: err.message, hint: "Unexpected error.", attempts: 1 };
}

export { DEFAULT_USER_AGENT, FALLBACK_USER_AGENT };
