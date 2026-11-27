#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8000}"

# Запускаем Telegram-бота в фоне, если задан BOT_TOKEN
if [ -n "${BOT_TOKEN:-}" ]; then
  python3 bot/main.py &
fi

exec node --disable-warning=ExperimentalWarning server.js
