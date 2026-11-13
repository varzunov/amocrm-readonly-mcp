#!/usr/bin/env bash
set -Eeuo pipefail

: "${AMO_BASE_URL:?AMO_BASE_URL is required}"
: "${AMO_LONG_LIVED_TOKEN:?AMO_LONG_LIVED_TOKEN is required}"
: "${CONTROL_PLANE_API_KEY:?CONTROL_PLANE_API_KEY is required}"
: "${TUNNEL_ID:?TUNNEL_ID is required}"

export HOME="${HOME:-/tmp/tunnel-home}"
export HOST=127.0.0.1
export PORT=3000
export HEALTH_PORT="${HEALTH_PORT:-8000}"

mkdir -p "${HOME}/.config/tunnel-client"

node dist/src/health.js &
health_pid=$!
node dist/src/server.js &
mcp_pid=$!

cleanup() {
  kill "${health_pid}" "${mcp_pid}" "${tunnel_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in {1..30}; do
  if node -e 'fetch("http://127.0.0.1:3000/health").then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))'; then
    break
  fi
  sleep 1
done

profile_path="${HOME}/.config/tunnel-client/amocrm-mozhem.yaml"
if [[ ! -f "${profile_path}" ]]; then
  tunnel-client init \
    --sample sample_mcp_remote_no_auth \
    --profile amocrm-mozhem \
    --tunnel-id "${TUNNEL_ID}" \
    --mcp-server-url http://127.0.0.1:3000/mcp
fi

tunnel-client run --profile amocrm-mozhem &
tunnel_pid=$!

wait -n "${health_pid}" "${mcp_pid}" "${tunnel_pid}"
