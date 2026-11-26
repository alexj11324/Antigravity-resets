#!/usr/bin/env bash
set -euo pipefail

# Sync allowed runtime secrets from Infisical into Cloudflare Workers (or local .dev.vars).
# Supports two auth modes (matching your Notion Machine Identity guide & local CLI):
#   1) Infisical REST API v4 with Machine Identity Token Auth:
#      Set INFISICAL_TOKEN + INFISICAL_PROJECT_ID (optional INFISICAL_API_URL, default https://app.infisical.com)
#      Redirects are disabled on authenticated requests; raw secret values are never echoed.
#   2) Local infisical CLI session (`infisical login`), if INFISICAL_TOKEN is not set.
#
# Usage:
#   INFISICAL_ENV=prod bash scripts/sync-infisical-secrets.sh            # sync to Cloudflare Workers
#   INFISICAL_ENV=dev  bash scripts/sync-infisical-secrets.sh --local    # write local .dev.vars (gitignored)

MODE="cloudflare"
if [[ "${1:-}" == "--local" ]]; then
  MODE="local"
fi

INFISICAL_ENV="${INFISICAL_ENV:-$([[ "$MODE" == "local" ]] && echo "dev" || echo "prod")}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-89850d6a-f020-4936-863e-df77380dfe40}"
INFISICAL_PATH="${INFISICAL_PATH:-/antigravity-resets}"
INFISICAL_API_URL="${INFISICAL_API_URL:-https://app.infisical.com}"

TMP_JSON="$(mktemp)"
TMP_FILTERED="$(mktemp)"
cleanup() {
  rm -f "$TMP_JSON" "$TMP_FILTERED"
}
trap cleanup EXIT
chmod 600 "$TMP_JSON" "$TMP_FILTERED"

if [[ -n "${INFISICAL_TOKEN:-}" && -n "${INFISICAL_PROJECT_ID:-}" ]]; then
  # Machine Identity Token Auth over HTTPS v4 API (redirects disabled)
  python3 - "$TMP_JSON" <<'PY'
import json, os, ssl, sys, urllib.parse, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(
    NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context())
)
api_url = os.environ["INFISICAL_API_URL"].rstrip("/")
params = urllib.parse.urlencode({
    "projectId": os.environ["INFISICAL_PROJECT_ID"],
    "environment": os.environ["INFISICAL_ENV"],
    "secretPath": os.environ["INFISICAL_PATH"],
    "recursive": "true",
    "viewSecretValue": "true",
    "includeImports": "true",
})
req = urllib.request.Request(
    f"{api_url}/api/v4/secrets?{params}",
    headers={
        "Authorization": f"Bearer {os.environ['INFISICAL_TOKEN']}",
        "Accept": "application/json",
    },
)
with opener.open(req, timeout=20) as resp:
    data = json.loads(resp.read().decode("utf-8"))
entries = [
    {"key": s["secretKey"], "value": s.get("secretValue", "")}
    for s in data.get("secrets", [])
]
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(entries, f)
PY
else
  if ! command -v infisical >/dev/null 2>&1; then
    echo "Error: Provide INFISICAL_TOKEN + INFISICAL_PROJECT_ID, or install infisical CLI." >&2
    exit 1
  fi
  ARGS=(export --format=json --env="$INFISICAL_ENV" --path="$INFISICAL_PATH" --silent)
  if [[ -n "${INFISICAL_PROJECT_ID:-}" ]]; then
    ARGS+=(--projectId="$INFISICAL_PROJECT_ID")
  fi
  if ! infisical "${ARGS[@]}" </dev/null >"$TMP_JSON"; then
    echo "Error: Failed to fetch secrets from Infisical (env=$INFISICAL_ENV)." >&2
    echo "Hint: Pass INFISICAL_TOKEN + INFISICAL_PROJECT_ID (Machine Identity) or run 'infisical login'." >&2
    exit 1
  fi
fi

# Whitelist only keys relevant to Antigravity Resets Worker
node -e '
const fs = require("node:fs");
const allowed = new Set([
  "X_OAUTH2_CLIENT_SECRET",
  "X_API_KEY",
  "X_API_KEY_SECRET",
  "X_BEARER_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_API_BASE_URL",
  "DECISIONS_API_URL",
  "DECISIONS_MODEL",
  "FLASH_MODEL",
  "ARBITRATOR_MODEL",
  "ENABLE_TIER2_ARBITRATOR",
  "JOINT_JUDGE_MODE",
  "ADMIN_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ADMIN_TELEGRAM_BOT_TOKEN",
  "ADMIN_TELEGRAM_CHAT_ID",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  // Dedicated signing key for confirm/unsubscribe links. Deliberately separate
  // from X_OAUTH2_CLIENT_SECRET: reusing the webhook key here would turn the
  // subscribe endpoint into an HMAC oracle over webhook signatures.
  "EMAIL_UNSUBSCRIBE_SECRET",
  // Optional: sender address when delivering through Cloudflare Email Sending
  // instead of Resend.
  "EMAIL_FROM",
]);
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const entries = Array.isArray(raw)
  ? raw.map((item) => [item.key, item.value])
  : Object.entries(raw);
const filtered = {};
for (const [key, value] of entries) {
  if (allowed.has(key) && typeof value === "string" && value.length > 0) {
    filtered[key] = value;
  }
}
const keys = Object.keys(filtered);
if (keys.length === 0) {
  console.error("Warning: No matching Antigravity Resets secret keys found in Infisical.");
  console.error("Expected any of:", Array.from(allowed).join(", "));
  process.exit(2);
}
fs.writeFileSync(process.argv[2], JSON.stringify(filtered, null, 2), { mode: 0o600 });
console.error("Matched secret keys (" + keys.length + "):", keys.join(", "));
' "$TMP_JSON" "$TMP_FILTERED"

if [[ "$MODE" == "local" ]]; then
  node -e '
  const fs = require("node:fs");
  const target = ".dev.vars";

  const incoming = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

  // Merge, never overwrite. .dev.vars can hold variables this script does not
  // manage (local overrides, feature flags), and the previous version replaced
  // the whole file, silently deleting them.
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    existing = "";
  }

  const managed = new Map(
    Object.entries(incoming).map(([key, value]) => [key, `${key}=${JSON.stringify(value)}`]),
  );
  const written = new Set();
  const out = [];

  for (const line of existing.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match && managed.has(match[1])) {
      out.push(managed.get(match[1]));
      written.add(match[1]);
    } else {
      out.push(line);
    }
  }
  for (const [key, rendered] of managed) {
    if (!written.has(key)) out.push(rendered);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();

  // Temp file + rename so an interrupted run cannot truncate the real file,
  // then force 0600: writeFileSync mode only applies when creating.
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  ' "$TMP_FILTERED"
  echo "Merged Infisical secrets into .dev.vars (env=$INFISICAL_ENV, chmod 600, gitignored)."
else
  npx --yes wrangler secret bulk "$TMP_FILTERED"
  echo "Synced Infisical secrets (env=$INFISICAL_ENV) to Cloudflare Workers."
fi
