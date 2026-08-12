import { getStore } from "@netlify/blobs";

const STORE_NAME = "adsitco-report";

// Blobs is unavailable outside a Netlify context (plain `node` runs, some local
// setups). Falling back to process memory keeps the functions usable there —
// it just loses the cache when the process exits.
const memory = new Map();

function blobStore() {
  try {
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch {
    return null;
  }
}

const keyFor = (days) => `snapshot-${days}d.json`;

export async function readSnapshot(days) {
  const key = keyFor(days);
  const store = blobStore();
  if (store) {
    try {
      const value = await store.get(key, { type: "json" });
      if (value) return value;
    } catch {
      // Fall through to memory: a read failure should not break the report
      // when a fresh collect can still serve it.
    }
  }
  return memory.get(key) ?? null;
}

export async function writeSnapshot(days, snapshot) {
  const key = keyFor(days);
  memory.set(key, snapshot);
  const store = blobStore();
  if (!store) return false;
  try {
    await store.setJSON(key, snapshot);
    return true;
  } catch {
    return false;
  }
}

export function ageInMinutes(snapshot) {
  if (!snapshot?.generatedAt) return Infinity;
  const ms = Date.now() - new Date(snapshot.generatedAt).getTime();
  return Number.isFinite(ms) ? ms / 60_000 : Infinity;
}
