#!/usr/bin/env bash
set -Eeuo pipefail

TUNNEL_ID="${TUNNEL_ID:-tunnel_6af6e9f4e1e88191b9e234a1e28cb526}"
PROFILE_NAME="${TUNNEL_PROFILE:-amocrm-mozhem}"
MCP_SERVER_URL="${MCP_SERVER_URL:-http://127.0.0.1:3000/mcp}"
RELEASE="${TUNNEL_CLIENT_VERSION:-v0.0.20}"

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Запустите установщик от root.\n' >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) platform="linux-amd64" ;;
  aarch64|arm64) platform="linux-arm64" ;;
  *) printf 'Неподдерживаемая архитектура: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

command -v curl >/dev/null 2>&1 || { printf 'Не найден curl.\n' >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || {
  apt-get update
  apt-get install -y unzip
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"; unset CONTROL_PLANE_API_KEY' EXIT

asset="tunnel-client-${RELEASE}-${platform}.zip"
base="https://github.com/openai/tunnel-client/releases/download/${RELEASE}"

printf '\nСкачиваю официальный tunnel-client %s…\n' "${RELEASE}"
curl -fsSL "${base}/${asset}" -o "${tmp_dir}/${asset}"
curl -fsSL "${base}/SHA256SUMS.txt" -o "${tmp_dir}/SHA256SUMS.txt"
(
  cd "${tmp_dir}"
  grep "  ${asset}$" SHA256SUMS.txt | sha256sum --check --strict -
  unzip -q "${asset}" -d unpacked
)

binary="$(find "${tmp_dir}/unpacked" -type f -name tunnel-client -print -quit)"
if [[ -z "${binary}" ]]; then
  printf 'В архиве не найден tunnel-client.\n' >&2
  exit 1
fi
install -m 0755 "${binary}" /usr/local/bin/tunnel-client
/usr/local/bin/tunnel-client --version

printf '\nВставьте Runtime API key OpenAI (ввод скрыт): ' >/dev/tty
IFS= read -r -s CONTROL_PLANE_API_KEY </dev/tty
printf '\n' >/dev/tty
if [[ ${#CONTROL_PLANE_API_KEY} -lt 20 ]]; then
  printf 'Ключ выглядит слишком коротким. Ничего не запущено.\n' >&2
  exit 1
fi

umask 077
printf 'CONTROL_PLANE_API_KEY=%s\n' "${CONTROL_PLANE_API_KEY}" >/etc/amocrm-tunnel.env
chmod 600 /etc/amocrm-tunnel.env
export CONTROL_PLANE_API_KEY

/usr/local/bin/tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile "${PROFILE_NAME}" \
  --tunnel-id "${TUNNEL_ID}" \
  --mcp-server-url "${MCP_SERVER_URL}"

/usr/local/bin/tunnel-client doctor --profile "${PROFILE_NAME}" --explain

cat >/etc/systemd/system/amocrm-tunnel.service <<EOF
[Unit]
Description=OpenAI Secure MCP Tunnel for amoCRM
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
Environment=HOME=/root
EnvironmentFile=/etc/amocrm-tunnel.env
ExecStart=/usr/local/bin/tunnel-client run --profile ${PROFILE_NAME}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now amocrm-tunnel.service
sleep 2
systemctl --no-pager --full status amocrm-tunnel.service

printf '\nГотово. Secure MCP Tunnel запущен как системная служба.\n'
