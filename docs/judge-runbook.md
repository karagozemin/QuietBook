# QuietBook judge runbook

QuietBook is an unaudited Stellar Testnet prototype. The reviewer flow does not require a wallet, Testnet funds, or access to confidential values.

## Start

```sh
pnpm install
pnpm judge
```

Open `http://127.0.0.1:5173`. The indexer starts at `http://127.0.0.1:8787`, syncs before listening, and then refreshes every 30 seconds. If the indexer or public RPC is temporarily unavailable, the UI labels the fallback and retains the recorded evidence run.

## Review flow

1. Confirm the top bar reports `Indexer + RPC verified` or `Live RPC verified`.
2. Select `Replay verified run` and watch the bounded eight-step flow, including the policy denial.
3. Inspect the participant table: identities and outcomes are public; bid values remain sealed.
4. Switch between Public, Issuer, Investor, and Auditor. The Auditor view shows event linkage, signed-export integrity, and recipient-disclosure status without rendering decrypted values.
5. Open Evidence for claim-by-claim Testnet receipts, then Contracts for the pinned deployment registry.
6. Optionally connect Freighter from Issuer or Investor view. The app accepts Stellar Testnet only and resolves the connected account against the archived round; the judge flow itself remains wallet-free.

The final settlement receipt is transaction `3a47b09ea1def84f1bef4bb71a00fab2080cfb5e5697a84d86c549a97f89246d`.

## Expected limitations

- Testnet only, unaudited, and unsuitable for real assets or value.
- The product screen uses a completed fixed `N=3` evidence round; it does not pretend that archived actions are writable.
- Decrypted auditor values, disclosure recipient secrets, witnesses, and confidential openings remain in ignored local `.quietbook/` files.
- The operator learns bid openings in this MVP to produce the Max-Bid proof.
- The indexer requires Node.js 22.13 or newer because it uses the built-in SQLite module.
