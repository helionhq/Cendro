#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# The timer can fire again while a pull is still running; only one at a time.
exec 9>/run/cendro-update.lock
flock -n 9 || exit 0

docker compose pull --quiet web
docker compose up -d --remove-orphans web
