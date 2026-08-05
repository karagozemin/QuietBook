#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="$ROOT_DIR/.upstream"
TOOLS_DIR="$ROOT_DIR/.tools"
OZ_DIR="$UPSTREAM_DIR/stellar-contracts"
DEMO_DIR="$UPSTREAM_DIR/stellar-confidential-token-demo"
OZ_REV="98090b3e59785454f55b3617992c2f84250c7173"
DEMO_REV="9500ed774b13b08b5fe99370b60de3479edb492b"
NARGO_VERSION="1.0.0-beta.9"

clone_at_revision() {
  local url="$1"
  local revision="$2"
  local destination="$3"

  if [[ ! -d "$destination/.git" ]]; then
    git clone --filter=blob:none --no-checkout "$url" "$destination"
  fi
  git -C "$destination" fetch --depth 1 origin "$revision"
  git -C "$destination" checkout --detach "$revision"
  test "$(git -C "$destination" rev-parse HEAD)" = "$revision"
}

clone_at_revision \
  "https://github.com/OpenZeppelin/stellar-contracts.git" \
  "$OZ_REV" \
  "$OZ_DIR"
clone_at_revision \
  "https://github.com/brozorec/stellar-confidential-token-demo.git" \
  "$DEMO_REV" \
  "$DEMO_DIR"

mkdir -p "$TOOLS_DIR/noir"
NARGO_BIN="$TOOLS_DIR/noir/nargo"
if [[ ! -x "$NARGO_BIN" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) archive="nargo-aarch64-apple-darwin.tar.gz" ;;
    Darwin-x86_64) archive="nargo-x86_64-apple-darwin.tar.gz" ;;
    Linux-aarch64) archive="nargo-aarch64-unknown-linux-gnu.tar.gz" ;;
    Linux-x86_64) archive="nargo-x86_64-unknown-linux-gnu.tar.gz" ;;
    *) echo "Unsupported platform for pinned nargo binary" >&2; exit 1 ;;
  esac
  curl -sSfL \
    "https://github.com/noir-lang/noir/releases/download/v${NARGO_VERSION}/${archive}" \
    -o "$TOOLS_DIR/noir/nargo.tar.gz"
  tar -xzf "$TOOLS_DIR/noir/nargo.tar.gz" -C "$TOOLS_DIR/noir"
fi

"$NARGO_BIN" --version
(
  cd "$OZ_DIR/packages/tokens/src/confidential/circuits"
  "$NARGO_BIN" compile --package circuit_set_spender
  "$NARGO_BIN" compile --package circuit_spender_transfer
  "$NARGO_BIN" compile --package circuit_revoke_spender
)

mkdir -p "$ROOT_DIR/packages/sdk/circuits"
cp "$OZ_DIR/packages/tokens/src/confidential/circuits/target/circuit_set_spender.json" \
  "$ROOT_DIR/packages/sdk/circuits/set_spender.json"
cp "$OZ_DIR/packages/tokens/src/confidential/circuits/target/circuit_spender_transfer.json" \
  "$ROOT_DIR/packages/sdk/circuits/spender_transfer.json"
cp "$OZ_DIR/packages/tokens/src/confidential/circuits/target/circuit_revoke_spender.json" \
  "$ROOT_DIR/packages/sdk/circuits/revoke_spender.json"

echo "Pinned upstream sources and spender circuit artifacts are ready."

