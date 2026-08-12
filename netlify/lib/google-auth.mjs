import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Access tokens live an hour. Cache per scope set so a single refresh run does
// one token exchange instead of one per API call.
const cache = new Map();

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// Netlify's UI stores the key as a single line with literal \n sequences.
// A pasted multi-line key works too; normalise both to real newlines.
function normalisePrivateKey(raw) {
  let key = raw.trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  return key.replace(/\\n/g, "\n");
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function exchangeJwtForToken(scopes) {
  const clientEmail = requireEnv("GOOGLE_CLIENT_EMAIL");
  const privateKey = normalisePrivateKey(requireEnv("GOOGLE_PRIVATE_KEY"));
  const scope = scopes.join(" ");
  const now = Math.floor(Date.now() / 1000);

  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(
      JSON.stringify({
        iss: clientEmail,
        scope,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join(".");

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  let signature;
  try {
    signature = signer.sign(privateKey).toString("base64url");
  } catch (err) {
    throw new Error(
      `GOOGLE_PRIVATE_KEY could not be used to sign: ${err.message}. ` +
        "Check that the whole key, including the BEGIN/END lines, was copied.",
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${
        body.error_description || body.error || "unknown error"
      }`,
    );
  }

  return {
    token: body.access_token,
    // Renew a minute early so a long refresh run never trips over expiry.
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000,
  };
}

export async function getAccessToken(scopes) {
  const key = scopes.join(" ");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const fresh = await exchangeJwtForToken(scopes);
  cache.set(key, fresh);
  return fresh.token;
}

export async function googleFetch(url, { scopes, body, method = "POST" }) {
  const token = await getAccessToken(scopes);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const message = json?.error?.message || text.slice(0, 300) || res.statusText;
    const error = new Error(`${res.status} ${message}`);
    error.status = res.status;
    error.googleMessage = message;
    throw error;
  }

  return json;
}
