#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите версию 20 или новее: https://nodejs.org"
  exit 1
fi
exec node server/index.js --open
