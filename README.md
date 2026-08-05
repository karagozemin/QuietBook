# QuietBook

Known investors. Private bids. Verifiable allocation.

QuietBook is a Testnet-only, unaudited prototype for confidential primary RWA issuance on Stellar. Verified investors submit round-scoped confidential spender delegations, the complete bidder set is frozen at close, and settlement is designed to combine a proven winning payment with delivery of an escrowed public RWA lot.

## Status

The repository is being built in the dependency order defined by the PRD. The local P0 integration gate now establishes:

- the authoritative round state machine;
- public RWA escrow before a round can open;
- policy-gated bidder registration;
- live, round-scoped confidential delegation checks without storing bid values;
- a unique controller contract that can register and spend as its own confidential-token identity;
- QuietBook witness builders and current XDR payloads for `set_spender` and `spender_transfer`;
- a fixed-capacity `N=3` Max-Bid circuit with reserve enforcement and deterministic tie-breaking;
- locally generated and verified Keccak-transcript UltraHonk proofs for both spender operations and Max-Bid;
- a dedicated Max-Bid verifier with an immutable verification key;
- trusted on-chain public-input construction and atomic confidential-payment/public-RWA finalization;
- rollback protection for invalid proofs, revoked delegations, invalid winners, and duplicate settlement.

The core P0 flow has also completed on Stellar Testnet: three eligible investors registered confidential bids, an unauthorized investor was rejected, the market-built statement matched the Max-Bid proof statement byte-for-byte, and confidential payment plus public RWA delivery settled atomically. The next milestone is the judge-first web app. No production or mainnet use is supported.

## Development

Prerequisites:

- Rust 1.92 or compatible stable toolchain
- Stellar CLI 27
- Node.js 20 or newer and pnpm 10.33

Fetch the pinned upstream sources and compile the spender circuit artifacts:

```sh
pnpm bootstrap
pnpm install
```

Build and test the SDK, including real local UltraHonk proofs:

```sh
pnpm build:sdk
pnpm test:sdk
pnpm test:proof
```

Run the contract tests:

```sh
cargo test --manifest-path contracts/Cargo.toml
cargo clippy --manifest-path contracts/Cargo.toml --all-targets -- -D warnings
```

Build the contracts for Wasm:

```sh
stellar contract build --manifest-path contracts/Cargo.toml
```

See [docs/implementation-order.md](docs/implementation-order.md) for the build sequence, [docs/architecture/0001-p0-integration-spike.md](docs/architecture/0001-p0-integration-spike.md) for the integration findings, and [docs/evidence/README.md](docs/evidence/README.md) for the Testnet evidence index.
