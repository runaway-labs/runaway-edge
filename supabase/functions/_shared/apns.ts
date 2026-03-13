// Native APNs push notification sender
// Uses ES256 JWT auth with a .p8 key — no Firebase dependency.
//
// Required Supabase secrets:
//   APNS_KEY_P8      — full contents of your AuthKey_XXXXXXXXXX.p8 file
//   APNS_KEY_ID      — 10-character key ID (from Apple Developer portal)
//   APNS_TEAM_ID     — 10-character Team ID (top-right of developer.apple.com)
//   APNS_BUNDLE_ID   — app bundle ID, e.g. com.jackrudelic.runawayios
//   APNS_PRODUCTION  — "true" for App Store/TestFlight, "false" (default) for sandbox/dev

export interface PushPayload {
  title: string;
  body: string;
  /** String key/value pairs sent in the notification data envelope */
  data?: Record<string, string>;
  /** Increment the app badge. Defaults to 1. Pass 0 to clear. */
  badge?: number;
  /** Set true for silent background notifications (no alert shown) */
  silent?: boolean;
}

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function importP8Key(p8: string): Promise<CryptoKey> {
  const pem = p8
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function makeJwt(keyId: string, teamId: string, key: CryptoKey): Promise<string> {
  const header = b64url({ alg: "ES256", kid: keyId });
  const payload = b64url({ iss: teamId, iat: Math.floor(Date.now() / 1000) });
  const unsigned = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${unsigned}.${sigB64}`;
}

export async function sendPush(deviceToken: string, push: PushPayload): Promise<void> {
  const p8 = Deno.env.get("APNS_KEY_P8");
  const keyId = Deno.env.get("APNS_KEY_ID");
  const teamId = Deno.env.get("APNS_TEAM_ID");
  const bundleId = Deno.env.get("APNS_BUNDLE_ID");

  if (!p8 || !keyId || !teamId || !bundleId) {
    throw new Error("Missing APNs secrets: APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, or APNS_BUNDLE_ID");
  }

  const isProduction = Deno.env.get("APNS_PRODUCTION") === "true";
  const host = isProduction
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

  const key = await importP8Key(p8);
  const jwt = await makeJwt(keyId, teamId, key);

  const aps: Record<string, unknown> = {
    sound: "default",
    badge: push.badge ?? 1,
    "content-available": 1,
  };

  if (!push.silent) {
    aps.alert = { title: push.title, body: push.body };
  }

  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": push.silent ? "background" : "alert",
      "apns-priority": push.silent ? "5" : "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps, ...push.data }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`APNs error ${res.status}: ${JSON.stringify(err)}`);
  }
}
