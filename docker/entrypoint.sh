#!/usr/bin/env bash
set -euo pipefail

CRON_FILE="/etc/supercronic/servermanage.crontab"
CRON_SCHEDULE="${CRON_SCHEDULE:-0 9 * * *}"
WEEKLY_CRON_SCHEDULE="${WEEKLY_CRON_SCHEDULE:-}"
APP_CONFIG_PATH="${APP_CONFIG_PATH:-/app/config.yaml}"
APP_DOTENV_PATH="${APP_DOTENV_PATH:-/app/.env}"
PYTHON_BIN="${PYTHON_BIN:-python}"

if [[ ! -f "${APP_CONFIG_PATH}" ]]; then
  echo "配置文件不存在: ${APP_CONFIG_PATH}" >&2
  exit 1
fi

if [[ -n "${TZ:-}" ]]; then
  if [[ -f "/usr/share/zoneinfo/${TZ}" ]]; then
    ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
    echo "${TZ}" > /etc/timezone
  else
    echo "无效的时区配置: ${TZ}" >&2
    exit 1
  fi
fi

cmd=("${PYTHON_BIN}" "-m" "servermanage.main" "--config" "${APP_CONFIG_PATH}")
if [[ -f "${APP_DOTENV_PATH}" ]]; then
  cmd+=("--dotenv" "${APP_DOTENV_PATH}")
else
  echo "未发现 dotenv 文件，继续使用当前容器环境变量: ${APP_DOTENV_PATH}" >&2
fi

printf -v command_string '%q ' "${cmd[@]}"
command_string="${command_string% }"

{
  cat <<EOF
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
${CRON_SCHEDULE} cd /app && ${command_string}
EOF

  if [[ -n "${WEEKLY_CRON_SCHEDULE}" ]]; then
    echo "${WEEKLY_CRON_SCHEDULE} cd /app && ${command_string} --weekly"
  fi
} > "${CRON_FILE}"

echo "已生成 supercronic 任务：" >&2
cat "${CRON_FILE}" >&2

exec /usr/local/bin/supercronic "${CRON_FILE}"
