#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$OPS_DIR/.env.production"
TAG="${1:?Usage: ./rollback.sh <previous-image-tag>}"

test -f "$ENV_FILE" || { echo "Missing $ENV_FILE" >&2; exit 1; }
cd "$OPS_DIR"
export QUIETBOOK_IMAGE_TAG="$TAG"
docker image inspect "quietbook-indexer:$TAG" >/dev/null
docker compose --env-file "$ENV_FILE" up -d --no-build indexer caddy
docker compose --env-file "$ENV_FILE" ps
