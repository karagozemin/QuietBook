# QuietBook

Known investors. Private bids. Verifiable allocation.

QuietBook is a Testnet-only, unaudited prototype for confidential primary RWA issuance on Stellar. Verified investors submit round-scoped confidential spender delegations, the complete bidder set is frozen at close, and settlement is designed to combine a proven winning payment with delivery of an escrowed public RWA lot.

## Status

The repository is being built in the dependency order defined by the PRD. The current slice establishes:

- the authoritative round state machine;
- public RWA escrow before a round can open;
- policy-gated bidder registration;
- live, round-scoped confidential delegation checks without storing bid values;
- a unique controller contract that can register and spend as its own confidential-token identity;
- QuietBook witness builders and current XDR payloads for `set_spender` and `spender_transfer`;
- locally generated and verified Keccak-transcript UltraHonk proofs for both spender operations.

The Max-Bid circuit, dedicated verifier integration, atomic finalization, web app, and Testnet evidence are subsequent slices. No production or mainnet use is supported.

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
```

Build the contracts for Wasm:

```sh
stellar contract build --manifest-path contracts/Cargo.toml
```

See [docs/implementation-order.md](docs/implementation-order.md) for the build sequence and [docs/architecture/0001-p0-integration-spike.md](docs/architecture/0001-p0-integration-spike.md) for the initial integration findings.
