# Deployment

## Public web

Build the static application with:

```sh
pnpm install --frozen-lockfile
pnpm build:web
```

Publish `apps/web/dist/` on any static host. The public build needs no secret environment variables. Without `VITE_INDEXER_URL`, it verifies the archived round directly through Stellar Testnet RPC and falls back to committed evidence when RPC is unavailable.

To use the durable event store, set `VITE_INDEXER_URL` to the public HTTPS origin of the indexer before building. Never place auditor secrets, confidential account keys, bid openings, or disclosure recipient secrets in frontend environment variables.

## Indexer

The indexer is a long-running Node.js 22.13+ service, not a stateless serverless function. Give it a persistent writable volume and run:

```sh
QUIETBOOK_INDEXER_DB=/data/indexer.sqlite \
QUIETBOOK_INDEXER_PORT=8787 \
pnpm dev:indexer
```

It stores raw confidential event XDR only in its private SQLite database. Public API responses redact raw XDR and decoded confidential payloads. Expose `/health` for readiness and retain the database volume across deploys.

## Release checks

Run `pnpm test` from a clean checkout. This covers contracts, Noir circuits, SDK unit tests, five real UltraHonk proofs, indexer redaction, privacy scanning, the production web build, and desktop/mobile judge flows.
