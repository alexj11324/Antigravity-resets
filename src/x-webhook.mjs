const WEBHOOK_PATH = "/api/webhooks/x";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function readBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH) {
      return json({ error: "Not found" }, 404);
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
    }

    // X recommends the app's OAuth 2.0 client secret. The API Secret Key
    // remains supported for OAuth 1.0 integrations. Never use a bearer token.
    if (request.method === "GET") {
      const token = url.searchParams.get("crc_token");
      if (!token) return json({ error: "Missing crc_token" }, 400);
      const secret = env.X_OAUTH2_CLIENT_SECRET || env.X_API_KEY_SECRET;
      if (!secret) return json({ error: "Webhook signing secret unavailable" }, 503);
      const signature = await crypto.subtle.sign(
        "HMAC",
        await importKey(secret),
        encoder.encode(token),
      );
      const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
      return json({ response_token: `sha256=${base64}` });
    }

    // Prefer the OAuth 2.0 header when present; an invalid preferred signature
    // must not fall back to a legacy signature. Verify the exact raw bytes.
    const oauth2 = request.headers.get("X-Twitter-Webhooks-Signature-OAuth2");
    const signature = oauth2 ?? request.headers.get("X-Twitter-Webhooks-Signature");
    const match = signature?.match(/^sha256=([A-Za-z0-9+/]{43}=)$/);
    if (!match) return json({ error: "Invalid webhook signature" }, 401);
    const secret = oauth2 !== null ? env.X_OAUTH2_CLIENT_SECRET : env.X_API_KEY_SECRET;
    if (!secret) return json({ error: "Webhook signing secret unavailable" }, 503);
    const body = await readBody(request);
    if (body === null) return json({ error: "Webhook payload too large" }, 413);
    const signatureBytes = Uint8Array.from(atob(match[1]), (value) => value.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importKey(secret),
      signatureBytes,
      body,
    );
    if (!valid) return json({ error: "Invalid webhook signature" }, 401);

    // Do not acknowledge and discard events. Add durable processing before
    // subscribing to event delivery or changing this response to success.
    console.warn(JSON.stringify({ event: "x_webhook_processing_unconfigured" }));
    return json({ error: "Webhook event processing is not configured" }, 503, {
      "Retry-After": "60",
    });
  },
};
