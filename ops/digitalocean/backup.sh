#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="${QUIETBOOK_BACKUP_DIR:-/var/backups/quietbook}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$BACKUP_ROOT/$STAMP"
ARCHIVE="$BACKUP_ROOT/quietbook-$STAMP.tar.gz"
VOLUME_PATH="$(docker volume inspect quietbook-data --format '{{ .Mountpoint }}')"

test "$(id -u)" -eq 0 || { echo "Run backup.sh as root" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
test -d "$VOLUME_PATH" || { echo "quietbook-data volume is unavailable" >&2; exit 1; }

install -d -m 700 "$WORK_DIR"
sqlite3 "$VOLUME_PATH/indexer.sqlite" ".backup '$WORK_DIR/indexer.sqlite'"
if [[ -f "$VOLUME_PATH/live-sandbox-private.json" ]]; then
  install -m 600 "$VOLUME_PATH/live-sandbox-private.json" "$WORK_DIR/live-sandbox-private.json"
fi
tar -C "$WORK_DIR" -czf "$ARCHIVE" .
chmod 600 "$ARCHIVE"
rm -r "$WORK_DIR"
find "$BACKUP_ROOT" -type f -name 'quietbook-*.tar.gz' -mtime +7 -delete
echo "$ARCHIVE"
