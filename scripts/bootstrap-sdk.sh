#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_REPO="$ROOT_DIR/.upstream/stellar-confidential-token-demo"
SDK_REV="9500ed774b13b08b5fe99370b60de3479edb492b"

if [[ ! -d "$SDK_REPO/.git" ]]; then
  mkdir -p "$(dirname "$SDK_REPO")"
  git clone --filter=blob:none --no-checkout \
    https://github.com/brozorec/stellar-confidential-token-demo.git \
    "$SDK_REPO"
fi

git -C "$SDK_REPO" fetch --depth 1 origin "$SDK_REV"
git -C "$SDK_REPO" checkout --detach "$SDK_REV"
test "$(git -C "$SDK_REPO" rev-parse HEAD)" = "$SDK_REV"

echo "Pinned @ctd/sdk source is ready at $SDK_REV."
