/**
 * Filter shapes shared between the collector and the API layers.
 *
 * This lives apart from collect.mjs so the GA4 layer can read a filter without
 * importing the collector that imports it — the cycle resolved, but only
 * because nothing called across it at module load, which is a fragile thing to
 * rely on.
 */

/**
 * A channel selection is either "only this one" or "everything but this one",
 * encoded as a plain string so it survives a URL and a cache key unchanged:
 * "Direct" includes, "!Direct" excludes.
 */
export function parseChannelFilter(channel) {
  const raw = String(channel ?? "").trim();
  if (!raw) return null;
  const exclude = raw.startsWith("!");
  const value = (exclude ? raw.slice(1) : raw).trim();
  return value ? { exclude, value } : null;
}
