# QuietBook judge runbook

QuietBook is an unaudited Stellar Testnet prototype. The reviewer flow does not require a wallet, Testnet funds, or access to confidential values.

## Start

```sh
pnpm install
pnpm judge
```

Open the local URL printed by Vite (`http://127.0.0.1:5173` by default). The indexer starts at `http://127.0.0.1:8787`, syncs before listening, and then refreshes every 30 seconds. If the indexer or public RPC is temporarily unavailable, the UI labels the fallback and retains the recorded evidence run.

## Review flow

1. On the landing screen, confirm the live Testnet ledger indicator resolves and select `Run Testnet story`.
2. Continue through the private-book, winner-proof, and atomic-settlement intro, then select `Enter verified run`.
3. Select `Verify completed round`, watch the compact eight-step receipt verification including the policy denial, and open the evidence index when it completes.
4. Return to Overview and switch between Public, Issuer, Investor, and Auditor perspectives. Public values stay sealed; role-specific integrity state remains visible.
5. Open `Audit & disclosure` to compare public and authorized-auditor visibility and verify the recipient-bound disclosure.
6. Optionally connect Freighter. `My access` performs a live policy read for the connected Testnet account; accounts outside the fixture are correctly reported as unauthorized.
7. The `Issuances` lifecycle fixture exposes an optional real `close_round` Testnet transaction. It requires a Freighter signature and can succeed only once while the fixture remains open.

The wallet-free story verifies previously confirmed Testnet transactions; it never presents a replayed receipt as a newly submitted transaction.

The final settlement receipt is transaction `3a47b09ea1def84f1bef4bb71a00fab2080cfb5e5697a84d86c549a97f89246d`.

## Expected limitations

- Testnet only, unaudited, and unsuitable for real assets or value.
- The product screen uses a completed fixed `N=3` evidence round; it does not pretend that archived actions are writable.
- Decrypted auditor values, disclosure recipient secrets, witnesses, and confidential openings remain in ignored local `.quietbook/` files.
- The operator learns bid openings in this MVP to produce the Max-Bid proof.
- The indexer requires Node.js 22.13 or newer because it uses the built-in SQLite module.
