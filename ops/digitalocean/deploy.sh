#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$OPS_DIR/../.." && pwd)"
ENV_FILE="$OPS_DIR/.env.production"
TAG="${1:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"

test -f "$ENV_FILE" || { echo "Missing $ENV_FILE" >&2; exit 1; }
test "$(stat -c '%a' "$ENV_FILE")" = "600" || {
  echo "$ENV_FILE must have mode 600" >&2
  exit 1
}

cd "$OPS_DIR"
export QUIETBOOK_IMAGE_TAG="$TAG"
docker compose --env-file "$ENV_FILE" build --pull indexer
docker compose --env-file "$ENV_FILE" up -d --remove-orphans
docker compose --env-file "$ENV_FILE" ps

API_DOMAIN="$(sed -n 's/^QUIETBOOK_API_DOMAIN=//p' "$ENV_FILE" | tail -1)"
if [[ -n "$API_DOMAIN" ]]; then
  for attempt in {1..24}; do
    if curl -sSf "https://$API_DOMAIN/ready" >/dev/null; then
      echo "QuietBook backend $TAG is ready at https://$API_DOMAIN"
      exit 0
    fi
    sleep 5
  done
fi

echo "Deployment started, but public readiness did not pass within 120 seconds." >&2
docker compose --env-file "$ENV_FILE" logs --tail=120 indexer caddy >&2
exit 1
