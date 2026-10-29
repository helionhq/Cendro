#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# A failed update leaves this hold in place so the one-minute timer does not
# retry (and flap) a release that needs human attention. Clear it to resume.
if [ -e /run/cendro-update-hold ]; then
  exit 0
fi

# The timer can fire again while a pull is still running; only one at a time.
exec 9>/run/cendro-update.lock
flock -n 9 || exit 0

# Remember the running image so a failed start can be rolled back. On the first
# boot there is no container yet, so this is empty.
previous_image="$(docker inspect --format '{{.Image}}' cendro-web 2>/dev/null || true)"

docker compose pull --quiet web

if ! docker compose up -d --wait --wait-timeout 180 --remove-orphans web; then
  echo "cendro update failed: the new web image did not become healthy" >&2
  # Create the hold before restoring so a failed restore cannot leave the timer
  # retrying the same bad release every minute.
  touch /run/cendro-update-hold

  if [ -n "$previous_image" ]; then
    echo "rolling back to the previous image ($previous_image)" >&2
    docker tag "$previous_image" cendro-web:rollback
    WEB_IMAGE=cendro-web:rollback docker compose up -d --wait --wait-timeout 180 web || \
      echo "rollback failed: the previous image did not become healthy either" >&2
  else
    echo "no previous image to roll back to (first start)" >&2
  fi

  exit 1
fi
