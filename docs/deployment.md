# Deployment

## Public web

Build the static application with:

```sh
pnpm install --frozen-lockfile
pnpm build:web
```

Publish `apps/web/dist/` on any static host. The public build needs no secret environment variables. Without `VITE_INDEXER_URL`, it verifies the archived round directly through Stellar Testnet RPC and falls back to committed evidence when RPC is unavailable.

To use the durable event store and live multi-wallet sandbox, set `VITE_INDEXER_URL` to the public HTTPS origin of the indexer before building. Add the final Vercel origin to `QUIETBOOK_ALLOWED_ORIGINS` on the backend. Never place auditor secrets, confidential account keys, bid openings, Testnet role secrets, or disclosure recipient secrets in frontend environment variables.

## Indexer

The indexer is a long-running Node.js service, not a stateless serverless function. The production image uses Node.js 24, Stellar CLI 27, a persistent SQLite/private-vault volume, and a Caddy TLS proxy. The complete DigitalOcean provisioning, secrets, firewall, backup, restore, release, and rollback procedure is in [the DigitalOcean runbook](../ops/digitalocean/README.md).

For local development, run:

```sh
QUIETBOOK_INDEXER_DB=/data/indexer.sqlite \
QUIETBOOK_INDEXER_PORT=8787 \
pnpm dev:indexer
```

The same process exposes the Testnet sandbox coordinator used by `Live round`. It prepares round-specific controllers, maintains the private settlement witness vault under `.quietbook/`, and generates the operator's final proof. Local development binds to `127.0.0.1`. The hosted deployment keeps port `8787` private and exposes it only through Caddy HTTPS. Public reads are redacted; every mutation requires a short-lived wallet-signed session, exact wallet/role matching, an allowed origin, and route-specific rate limits. Production startup also rejects missing or mismatched Testnet role secrets.

This remains an unaudited Testnet demo custody model. Do not reuse these identities, contracts, or operational assumptions for mainnet or real assets.

It stores raw confidential event XDR only in its private SQLite database. Public API responses redact raw XDR and decoded confidential payloads. Use `/health` for liveness and sync state, `/ready` for deployment readiness, and retain the `quietbook-data` volume across deploys.

## Release checks

Run `pnpm test` from a clean checkout. This covers contracts, Noir circuits, SDK unit tests, five real UltraHonk proofs, indexer redaction, privacy scanning, the production web build, and desktop/mobile judge flows.
