#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/varzunov/amocrm-readonly-mcp.git"
INSTALL_DIR="${AMO_INSTALL_DIR:-${HOME}/amocrm-readonly-mcp}"
AMO_BASE_URL="${AMO_BASE_URL:-https://mozhemevent.amocrm.ru}"

say() {
  printf '\n%s\n' "$*"
}

need_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    printf ''
  elif command -v sudo >/dev/null 2>&1; then
    printf 'sudo'
  else
    say "Нужны права администратора, но команда sudo не найдена."
    exit 1
  fi
}

install_dependencies() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v docker >/dev/null 2>&1 || missing+=(docker.io)

  if ((${#missing[@]} == 0)) && docker compose version >/dev/null 2>&1; then
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    say "Автоустановка рассчитана на Ubuntu/Debian. Установите Git, Docker и Docker Compose, затем запустите установщик снова."
    exit 1
  fi

  local admin
  admin="$(need_sudo)"
  say "Устанавливаю недостающие системные пакеты…"
  ${admin:+$admin }apt-get update
  ${admin:+$admin }apt-get install -y git docker.io docker-compose-v2
  ${admin:+$admin }systemctl enable --now docker
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    local admin
    admin="$(need_sudo)"
    ${admin:+$admin }docker "$@"
  fi
}

install_dependencies

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  say "Обновляю существующую установку…"
  git -C "${INSTALL_DIR}" pull --ff-only
elif [[ -e "${INSTALL_DIR}" ]]; then
  say "Каталог ${INSTALL_DIR} уже существует и не является Git-репозиторием. Переместите его или задайте другой AMO_INSTALL_DIR."
  exit 1
else
  say "Скачиваю коннектор…"
  git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
fi

printf '\nВставьте долгосрочный токен amoCRM (ввод скрыт): ' >/dev/tty
IFS= read -r -s AMO_LONG_LIVED_TOKEN </dev/tty
printf '\n' >/dev/tty

if [[ ${#AMO_LONG_LIVED_TOKEN} -lt 20 ]]; then
  say "Токен выглядит слишком коротким. Ничего не запущено."
  unset AMO_LONG_LIVED_TOKEN
  exit 1
fi

umask 077
{
  printf 'AMO_BASE_URL=%s\n' "${AMO_BASE_URL}"
  printf 'AMO_LONG_LIVED_TOKEN=%s\n' "${AMO_LONG_LIVED_TOKEN}"
  printf 'AMO_TOKEN_FILE=/data/amocrm-tokens.json\n'
  printf 'HOST=0.0.0.0\n'
  printf 'PORT=3000\n'
} >"${INSTALL_DIR}/.env"
unset AMO_LONG_LIVED_TOKEN
chmod 600 "${INSTALL_DIR}/.env"

say "Собираю и запускаю коннектор…"
(
  cd "${INSTALL_DIR}"
  docker_cmd compose up -d --build
)

say "Проверяю запуск…"
for _ in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:3000/health; then
    printf '\n'
    say "Готово. Коннектор запущен: http://127.0.0.1:3000/mcp"
    exit 0
  fi
  sleep 2
done

say "Контейнер запущен, но проверка здоровья не прошла. Последние строки журнала:"
(
  cd "${INSTALL_DIR}"
  docker_cmd compose logs --tail=50 connector
)
exit 1
