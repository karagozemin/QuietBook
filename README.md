<p align="center">
  <img src="./QuietBook.jpg" alt="QuietBook logo" width="180" />
</p>

# QuietBook

Known investors. Private bids. Verifiable allocation.

QuietBook is an end-user application for confidential primary RWA issuance on Stellar. An issuer escrows a fixed public lot, verified investors place capped confidential bids, a fixed-capacity UltraHonk proof selects the maximum valid bid, and the confidential payment plus public RWA delivery settle atomically.

This repository is an unaudited Stellar Testnet prototype. It is not suitable for production, mainnet, real securities, or real value.

## Delivered flow

- Immutable issuance rounds with public RWA escrow and policy-gated bidders.
- Round-specific controller accounts and bounded Confidential Token spender delegations.
- Fixed `N=3` Max-Bid proof with reserve, order, padding, tie-break, and payment binding.
- Atomic confidential winner payment and public RWA delivery on Testnet.
- Pre-deadline bid withdrawal and post-round losing-bid reclaim.
- Durable SQLite event indexer with a redacted public API and direct-RPC verification.
- Wallet-free judge replay plus a separate multi-wallet Testnet sandbox.
- Browser-local confidential keys and UltraHonk bid/reclaim proving with Freighter-signed transactions.
- Dynamic round receipts and proof hashes sourced from each new sandbox lifecycle.
- Current-schema auditor event decryption, direct XDR linkage, and a signed private export.
- Recipient-bound settlement disclosure with a pinned UltraHonk verification key and negative recipient/nonce/event tests.
- Automated public privacy scan and a PRD negative-test evidence matrix.

The completed Testnet run includes three eligible confidential bids, one unauthorized policy rejection, a proven winner, atomic settlement, two losing-bid reclaims, a signed audit export, and a verified designated-recipient disclosure. Public artifacts contain no bid or payment amount.

## Quick start

Prerequisites:

- Node.js 22.13 or newer and pnpm 10.33
- Rust 1.92 or compatible stable toolchain
- Stellar CLI 27

```sh
pnpm install
pnpm judge
```

Open `http://127.0.0.1:5173`. See [docs/judge-runbook.md](docs/judge-runbook.md) for the two-minute reviewer flow.

The landing page's `Explore live round` action opens the multi-wallet sandbox. One connected wallet creates and opens the issuance, up to three other Testnet wallets submit confidential bids, the issuer closes and settles after the displayed ledger deadline, and losing wallets reclaim from their own local confidential state. The operator vault is stored only under ignored `.quietbook/` state; public evidence contains receipts and proof hashes, never bid openings.

## Verification

Run the complete clean-checkout suite:

```sh
pnpm bootstrap
pnpm install --frozen-lockfile
pnpm test
```

Targeted commands:

```sh
pnpm test:contracts
pnpm test:circuits
pnpm test:sdk
pnpm test:proof
pnpm test:indexer
pnpm test:privacy
pnpm build:web
pnpm test:web
```

The Testnet auditor and disclosure reproductions use ignored local secrets and are intentionally separate from clean-checkout tests:

```sh
pnpm audit:round:testnet
pnpm disclose:settlement:testnet
```

See [docs/implementation-order.md](docs/implementation-order.md) for the dependency sequence, [docs/architecture/0001-p0-integration-spike.md](docs/architecture/0001-p0-integration-spike.md) for protocol drift findings, [docs/evidence/README.md](docs/evidence/README.md) for reviewer evidence, [docs/deployment.md](docs/deployment.md) for the hosting model, and [ops/digitalocean/README.md](ops/digitalocean/README.md) for the production backend runbook.
