#!/usr/bin/env bash
# Vercel install step.
#
# The @ctd/sdk workspace package lives under .upstream/ which is gitignored and
# therefore absent from the Vercel git clone. Without it, pnpm treats @ctd/sdk
# as a phantom (version 0.0.0), the "No projects matched" filter fires, and the
# @quietbook/sdk build fails with "Cannot find module '@ctd/sdk'".
#
# This script materializes the pinned upstream demo SDK (source only; the Noir
# circuit artifacts it needs are already committed under packages/sdk/circuits),
# then runs the normal frozen-lockfile install so pnpm links the workspace.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="$ROOT_DIR/.upstream"
DEMO_DIR="$UPSTREAM_DIR/stellar-confidential-token-demo"
DEMO_URL="https://github.com/brozorec/stellar-confidential-token-demo.git"
DEMO_REV="9500ed774b13b08b5fe99370b60de3479edb492b"

if [[ ! -f "$DEMO_DIR/packages/sdk/package.json" ]]; then
  echo "[vercel-install] Fetching pinned upstream demo SDK ($DEMO_REV)"
  mkdir -p "$UPSTREAM_DIR"
  if [[ ! -d "$DEMO_DIR/.git" ]]; then
    git clone --filter=blob:none --no-checkout "$DEMO_URL" "$DEMO_DIR"
  fi
  git -C "$DEMO_DIR" fetch --depth 1 origin "$DEMO_REV"
  git -C "$DEMO_DIR" checkout --detach "$DEMO_REV"
  test "$(git -C "$DEMO_DIR" rev-parse HEAD)" = "$DEMO_REV"
else
  echo "[vercel-install] Upstream demo SDK already present"
fi

echo "[vercel-install] Running pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile
