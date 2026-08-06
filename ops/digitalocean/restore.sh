#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$OPS_DIR/.env.production"
ARCHIVE="${1:?Usage: ./restore.sh /absolute/path/to/quietbook-backup.tar.gz}"
VOLUME_PATH="$(docker volume inspect quietbook-data --format '{{ .Mountpoint }}')"
RESTORE_DIR="$(mktemp -d /tmp/quietbook-restore.XXXXXX)"

test "$(id -u)" -eq 0 || { echo "Run restore.sh as root" >&2; exit 1; }
test -f "$ARCHIVE" || { echo "Backup archive not found: $ARCHIVE" >&2; exit 1; }
trap 'rm -r "$RESTORE_DIR"' EXIT
tar -xzf "$ARCHIVE" -C "$RESTORE_DIR"
test -f "$RESTORE_DIR/indexer.sqlite" || { echo "Backup has no indexer.sqlite" >&2; exit 1; }
sqlite3 "$RESTORE_DIR/indexer.sqlite" "PRAGMA integrity_check;" | grep -qx ok

cd "$OPS_DIR"
docker compose --env-file "$ENV_FILE" stop indexer
install -m 600 "$RESTORE_DIR/indexer.sqlite" "$VOLUME_PATH/indexer.sqlite"
rm -f "$VOLUME_PATH/indexer.sqlite-wal" "$VOLUME_PATH/indexer.sqlite-shm"
if [[ -f "$RESTORE_DIR/live-sandbox-private.json" ]]; then
  install -m 600 "$RESTORE_DIR/live-sandbox-private.json" "$VOLUME_PATH/live-sandbox-private.json"
else
  rm -f "$VOLUME_PATH/live-sandbox-private.json"
fi
chown -R 1000:1000 "$VOLUME_PATH"
docker compose --env-file "$ENV_FILE" start indexer
echo "Restore completed from $ARCHIVE"
