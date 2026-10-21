/**
 * Filter shapes shared between the collector and the API layers.
 *
 * This lives apart from collect.mjs so the GA4 layer can read a filter without
 * importing the collector that imports it.
 */

/**
 * Channels are a chosen set, not one value.
 *
 * "Only Organic Search" and "everything except Direct" are the same question
 * asked twice — which channels do you want — so the filter carries the list and
 * the UI ticks boxes. An empty list means every channel, which is also what an
 * unticked-everything state collapses to: a report of nothing helps no one.
 */
export function parseChannelFilter(value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((v) => String(v).trim())
    .filter(Boolean);
  // Deduplicated and ordered so the same selection always yields one cache key.
  return [...new Set(list)].sort((a, b) => a.localeCompare(b));
}

export function channelSignature(channels) {
  if (!channels.length) return "";
  return channels.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, "-")).join("+");
}
